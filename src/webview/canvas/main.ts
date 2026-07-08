import {
  artifactToCanvasSchema,
  hostToWebviewSchema,
  webviewToHostSchema,
  type FrameMeta,
  type WebviewToHost,
} from '../../shared/messages';
import { spliceTextEdit } from './spliceText';
import { committedSrcdoc, needsScriptRender } from './commitRender';
import { fieldsToAsk, normalizeAnswers } from '../../shared/clarify';
import type { Clarifications } from '../../shared/messages';
import {
  defaultPosition,
  fitFrame,
  pickLive,
  visibleRect,
  zoomAt,
  ZOOM_MAX,
  ZOOM_MIN,
} from './boardGeometry';
import { findVariationLabels, splitVariations } from './splitVariations';
import {
  applyFrames,
  endPending,
  initialState,
  PENDING_ID,
  select,
  startPending,
  stepFrame,
  type BoardState,
} from './frameState';

/**
 * Canvas chrome script. Holds no credentials — the host never sends any (P2)
 * — and performs no network I/O (P1; the webview CSP has no connect-src).
 * Both directions of the bus are zod-validated (P6).
 *
 * Layout (ADR-009): the chat sidebar drives generation and frame-native
 * refinement; the board renders versions as titled frames. Only the selected
 * frame and frames on screen keep a live iframe. All board and chat
 * interactions are local and free (P4) — the sole paid action is Send.
 */

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();

const promptInput = document.getElementById('prompt') as HTMLTextAreaElement;
const generateButton = document.getElementById('generate') as HTMLButtonElement;
const cancelButton = document.getElementById('cancel') as HTMLButtonElement;
const statusLine = document.getElementById('status') as HTMLDivElement;
const board = document.getElementById('board') as HTMLDivElement;
const frameTemplate = document.getElementById('frame-template') as HTMLTemplateElement;
const zoomLevel = document.getElementById('zoom-level') as HTMLSpanElement;
const chatPanel = document.getElementById('chat') as HTMLElement;
const chatLog = document.getElementById('chat-log') as HTMLDivElement;
const modeNewButton = document.getElementById('mode-new') as HTMLButtonElement;
const modeRefineButton = document.getElementById('mode-refine') as HTMLButtonElement;

const DEFAULT_LOGICAL_WIDTH = 1280;
const LOGICAL_HEIGHT = 1400;
const ZOOM_STEP = 0.05;

interface FrameCard {
  id: string;
  root: HTMLDivElement;
  clip: HTMLDivElement;
  title: HTMLSpanElement;
  subtitle: HTMLSpanElement;
  badge: HTMLSpanElement;
  restoreButton: HTMLButtonElement;
  splitButton: HTMLButtonElement;
  header: HTMLDivElement;
  iframe: HTMLIFrameElement | null;
  iframeLoaded: boolean;
  /** Latest artifact HTML for this frame; flushed to the iframe once it loads. */
  html: string | null;
  /** Design-time viewport (2b revision) — the frame is born at this size. */
  width: number;
  height: number;
  /** Surface-space position (2b) — from the manifest, or the default grid slot. */
  x: number;
  y: number;
}

/** The in-flight (or just-finished-unsaved) exchange, drawn after committed history. */
interface EphemeralExchange {
  userText: string;
  status: 'generating' | 'error' | 'cancelled' | 'unsaved';
  detail?: string;
}

let state: BoardState = initialState();
const cards = new Map<string, FrameCard>();
const surface = document.getElementById('surface') as HTMLDivElement;
/** Infinite-canvas view state (2b): surface transform = translate(pan) scale(zoom). */
let zoom = 0.4;
let panX = 24;
let panY = 24;
let mode: 'new' | 'refine' = 'new';
let ephemeral: EphemeralExchange | null = null;
/** Active direct-edit session (M1 item 4) — entirely local until Done saves one snapshot. */
let editSession: { frameId: string; dirty: boolean; editCount: number } | null = null;
const editButton = document.getElementById('edit-text') as HTMLButtonElement;
/** Clarify-before-spend (v0.2 item 1): the prompt awaiting the one optional round. */
let pendingClarifyPrompt: string | null = null;
let groundingTokensPresent = false;
const clarifyPanel = document.getElementById('clarify') as HTMLDivElement;
/** Present mode (v0.2 item 2a): full-screen, interactive, local & free. */
let present: { frameId: string; iframe: HTMLIFrameElement; loaded: boolean; html: string | null } | null = null;
const presentOverlay = document.getElementById('present-overlay') as HTMLDivElement;
const presentStage = document.getElementById('present-stage') as HTMLDivElement;

function send(message: WebviewToHost): void {
  vscode.postMessage(webviewToHostSchema.parse(message));
}

function setStatus(text: string, isError = false): void {
  statusLine.textContent = text;
  statusLine.className = isError ? 'error' : '';
}

function setGenerating(generating: boolean): void {
  generateButton.disabled = generating;
  cancelButton.disabled = !generating;
}

// ------------------------------------------------------------------- chat

function setMode(next: 'new' | 'refine'): void {
  mode = next;
  if (next === 'refine' && pendingClarifyPrompt) {
    closeClarifyForm(); // clarify is for new designs only
  }
  modeNewButton.setAttribute('aria-checked', String(mode === 'new'));
  modeRefineButton.setAttribute('aria-checked', String(mode === 'refine'));
  promptInput.placeholder =
    mode === 'new'
      ? 'Describe the UI to generate…'
      : 'Describe the change to the selected frame…';
}
modeNewButton.addEventListener('click', () => setMode('new'));
modeRefineButton.addEventListener('click', () => setMode('refine'));
document.getElementById('toggle-chat')!.addEventListener('click', () => {
  chatPanel.hidden = !chatPanel.hidden;
});

// Actions menu: every entry triggers an enum-allowlisted Underpainting
// command on the host — the click is the explicit user action (P3).
const actionsButton = document.getElementById('actions-button') as HTMLButtonElement;
const actionsMenu = document.getElementById('actions-menu') as HTMLDivElement;
actionsButton.addEventListener('click', (event) => {
  event.stopPropagation();
  actionsMenu.hidden = !actionsMenu.hidden;
  actionsButton.setAttribute('aria-expanded', String(!actionsMenu.hidden));
});
window.addEventListener('click', () => {
  actionsMenu.hidden = true;
  actionsButton.setAttribute('aria-expanded', 'false');
});
for (const item of actionsMenu.querySelectorAll<HTMLButtonElement>('button[data-command]')) {
  item.addEventListener('click', () => {
    send({
      type: 'runCommand',
      command: item.dataset['command'] as Extract<WebviewToHost, { type: 'runCommand' }>['command'],
    });
    actionsMenu.hidden = true;
  });
}

function chatBubble(className: string, text: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = `msg ${className}`;
  el.textContent = text;
  return el;
}

/**
 * Chat history is DERIVED from the version list (one exchange per frame), so
 * it survives webview reloads for free; only the in-flight exchange is local.
 */
function renderChat(): void {
  chatLog.replaceChildren();
  for (const frame of state.frames) {
    chatLog.appendChild(chatBubble('user', frame.prompt));
    const result = chatBubble('result', '');
    const cost = document.createElement('span');
    cost.className = 'cost';
    cost.textContent = frame.title;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = frame.subtitle + (frame.isCurrent ? ' · current' : '');
    result.append(cost, meta);
    result.addEventListener('click', () => {
      selectFrameById(frame.id);
      centerFrame(frame.id);
    });
    chatLog.appendChild(result);
  }
  if (ephemeral) {
    chatLog.appendChild(chatBubble('user', ephemeral.userText));
    switch (ephemeral.status) {
      case 'generating':
        chatLog.appendChild(chatBubble('result', 'Generating…'));
        break;
      case 'error':
        chatLog.appendChild(chatBubble('error', ephemeral.detail ?? 'Generation failed.'));
        break;
      case 'cancelled':
        chatLog.appendChild(chatBubble('error', 'Cancelled — nothing was saved.'));
        break;
      case 'unsaved':
        chatLog.appendChild(chatBubble('result', ephemeral.detail ?? 'Done (unsaved).'));
        break;
    }
  }
  chatLog.scrollTop = chatLog.scrollHeight;
}

// ---------------------------------------------------------------- frames DOM

function createCard(id: string): FrameCard {
  const root = (frameTemplate.content.cloneNode(true) as DocumentFragment)
    .firstElementChild as HTMLDivElement;
  const card: FrameCard = {
    id,
    root,
    clip: root.querySelector('.frame-clip') as HTMLDivElement,
    title: root.querySelector('.frame-title') as HTMLSpanElement,
    subtitle: root.querySelector('.frame-subtitle') as HTMLSpanElement,
    badge: root.querySelector('.current-badge') as HTMLSpanElement,
    restoreButton: root.querySelector('.restore') as HTMLButtonElement,
    splitButton: root.querySelector('.split') as HTMLButtonElement,
    header: root.querySelector('.frame-header') as HTMLDivElement,
    iframe: root.querySelector('iframe'),
    iframeLoaded: false,
    html: null,
    width: DEFAULT_LOGICAL_WIDTH,
    height: LOGICAL_HEIGHT,
    x: 0,
    y: 0,
  };
  wireIframe(card);
  card.root.addEventListener('click', () => {
    if (suppressNextClick) return;
    selectFrameById(card.id);
  });
  card.restoreButton.addEventListener('click', (event) => {
    event.stopPropagation();
    send({ type: 'restore', id: card.id }); // local file op on the host — free (P4)
  });
  card.splitButton.addEventListener('click', (event) => {
    event.stopPropagation();
    requestSplit(card);
  });
  wireFrameDrag(card);
  applyCardSize(card);
  surface.appendChild(root);
  cards.set(id, card);
  return card;
}

function placeCard(card: FrameCard, x: number, y: number): void {
  card.x = x;
  card.y = y;
  card.root.style.left = `${x}px`;
  card.root.style.top = `${y}px`;
}

function wireIframe(card: FrameCard): void {
  if (!card.iframe) return;
  card.iframeLoaded = false;
  card.iframe.addEventListener('load', () => {
    card.iframeLoaded = true;
    if (card.html !== null) {
      postToFrame(card, { type: 'patch', html: card.html });
    }
  });
}

function postToFrame(
  card: FrameCard,
  message: { type: 'patch'; html: string } | { type: 'reset' } | { type: 'editMode'; enabled: boolean },
): void {
  // Frame iframes have opaque origins (sandbox without allow-same-origin),
  // so the target origin is necessarily '*'; the payload is only artifact HTML.
  card.iframe?.contentWindow?.postMessage(message, '*');
}

function setFrameHtml(card: FrameCard, html: string): void {
  card.html = html;
  // ADR-002 commit path: only a VALIDATED, committed artifact that contains
  // scripts renders as its own document (scripts enabled, same sandbox +
  // CSP). Streaming and unvalidated content always goes through the
  // sanitizing morph renderer. Dormant in v0.1 — the validator bans scripts.
  const meta = state.frames.find((f) => f.id === card.id);
  if (card.id !== PENDING_ID && meta?.validated && needsScriptRender(html) && card.iframe) {
    const nonce = frameTemplate.dataset['nonce'] ?? '';
    card.iframe.srcdoc = committedSrcdoc(html, nonce);
    card.iframeLoaded = false; // document render replaces the bootstrap; no patch flush
    return;
  }
  if (card.iframe && card.iframeLoaded) {
    postToFrame(card, { type: 'patch', html });
  }
}

/**
 * Live-iframe budget (ADR-009/2b): pickLive ranks the selected frame first,
 * then visible frames by distance to the viewport center, hard-capped —
 * twenty frames on the board never means more than LIVE_CAP live iframes.
 */
function updateLiveness(): void {
  const view = visibleRect(panX, panY, zoom, board.clientWidth, board.clientHeight);
  const boxes = [...cards.values()].map((c) => ({
    id: c.id,
    x: c.x,
    y: c.y,
    width: c.width,
    height: c.height,
  }));
  const live = pickLive(boxes, state.selectedId, view);
  if (state.pendingId) live.add(PENDING_ID); // the streaming frame is always live
  for (const card of cards.values()) {
    syncLiveness(card, live.has(card.id));
  }
}

let livenessQueued = false;
function queueLiveness(): void {
  if (livenessQueued) return;
  livenessQueued = true;
  requestAnimationFrame(() => {
    livenessQueued = false;
    updateLiveness();
  });
}

function syncLiveness(card: FrameCard, shouldBeLive: boolean): void {
  if (shouldBeLive && !card.iframe) {
    card.clip.querySelector('.frame-placeholder')?.remove();
    const templateIframe = frameTemplate.content.querySelector('iframe') as HTMLIFrameElement;
    card.iframe = templateIframe.cloneNode(true) as HTMLIFrameElement;
    wireIframe(card);
    card.clip.appendChild(card.iframe);
    applyCardSize(card);
    if (card.html === null && card.id !== PENDING_ID) {
      send({ type: 'requestFrame', id: card.id });
    }
  } else if (!shouldBeLive && card.iframe) {
    card.iframe.remove();
    card.iframe = null;
    card.iframeLoaded = false;
    // Keep card.html: snapshots are immutable, so the cache can never go
    // stale — re-selecting renders instantly instead of a blank round trip.
    const placeholder = document.createElement('div');
    placeholder.className = 'frame-placeholder';
    placeholder.textContent = 'Renders when visible';
    card.clip.appendChild(placeholder);
  }
}

function applyCardSize(card: FrameCard): void {
  // Cards live at LOGICAL size on the surface; the surface transform does
  // all scaling (2b) — no per-iframe transforms, one composited layer.
  card.clip.style.width = `${card.width}px`;
  card.clip.style.height = `${card.height}px`;
  if (card.iframe) {
    card.iframe.style.width = `${card.width}px`;
    card.iframe.style.height = `${card.height}px`;
  }
}

function render(): void {
  // Drop cards whose frames disappeared (restore never deletes, but stay defensive).
  for (const [id, card] of cards) {
    if (id !== PENDING_ID && !state.frames.some((f) => f.id === id)) {
      card.root.remove();
      cards.delete(id);
    }
  }
  state.frames.forEach((frame, index) => {
    const card = cards.get(frame.id) ?? createCard(frame.id);
    card.title.textContent = (frame.validated ? '' : '⚠ ') + frame.title;
    card.subtitle.textContent = frame.subtitle;
    card.badge.hidden = !frame.isCurrent;
    card.restoreButton.hidden = frame.isCurrent;
    if (card.width !== frame.size.width || card.height !== frame.size.height) {
      card.width = frame.size.width;
      card.height = frame.size.height;
      applyCardSize(card);
    }
    const position = frame.position ?? defaultPosition(index, DEFAULT_LOGICAL_WIDTH, LOGICAL_HEIGHT);
    if (!dragState || dragState.card.id !== frame.id) {
      placeCard(card, position.x, position.y);
    }
    card.splitButton.hidden =
      card.html === null || findVariationLabels(card.html, sharedParser).length < 2;
  });
  const pendingCard = cards.get(PENDING_ID);
  if (pendingCard && state.pendingId) {
    const slot = defaultPosition(state.frames.length, DEFAULT_LOGICAL_WIDTH, LOGICAL_HEIGHT);
    placeCard(pendingCard, slot.x, slot.y);
  }
  for (const card of cards.values()) {
    card.root.classList.toggle('selected', state.selectedId === card.id);
  }
  updateLiveness();
  renderChat();
}

const sharedParser = new DOMParser();

/** Variation split (2b): marker-based, local, free — N new sibling versions. */
function requestSplit(card: FrameCard): void {
  if (card.html === null) return;
  const parts = splitVariations(card.html, sharedParser);
  if (!parts) {
    setStatus('This frame has no splittable data-variation sections.', true);
    return;
  }
  send({
    type: 'splitFrame',
    frameId: card.id,
    variations: parts.map((p) => ({ label: p.label, html: p.html })),
  });
  setStatus(`Splitting ${parts.length} variations into separate frames — local, free.`);
}

function adoptPending(newId: string, meta: FrameMeta | undefined): void {
  const card = cards.get(PENDING_ID);
  if (!card) return;
  cards.delete(PENDING_ID);
  card.id = newId;
  cards.set(newId, card);
  if (meta) {
    card.title.textContent = meta.title;
    card.subtitle.textContent = meta.subtitle;
  }
}

function selectFrameById(id: string): void {
  // Switching frames closes an open edit session (saving any pending edits).
  if (editSession && editSession.frameId !== id) {
    finishEditSession();
  }
  state = select(state, id);
  send({ type: 'selectFrame', id });
  render();
}

// -------------------------------------------- interaction mode (2c, local)

/**
 * Select vs Interact (2c). Select (default): clicks select frames, text is
 * directly editable. Interact: pointer events pass into the selected frame's
 * sandboxed prototype so buttons/toggles work; direct-edit is off. Purely
 * local CSS/state — free (P4). Present mode (2a) is interactive regardless.
 */
let interactionMode: 'select' | 'interact' = 'select';
const modeSelectButton = document.getElementById('mode-select') as HTMLButtonElement;
const modeInteractButton = document.getElementById('mode-interact') as HTMLButtonElement;

function setInteractionMode(next: 'select' | 'interact'): void {
  interactionMode = next;
  surface.classList.toggle('interact', next === 'interact');
  modeSelectButton.setAttribute('aria-pressed', String(next === 'select'));
  modeInteractButton.setAttribute('aria-pressed', String(next === 'interact'));
  // Direct-edit only in Select mode.
  editButton.disabled = next === 'interact';
  if (next === 'interact' && editSession) finishEditSession();
  setStatus(
    next === 'interact'
      ? 'Interact mode — click into the selected prototype; direct-edit is off. Local & free.'
      : 'Select mode — click frames to select; text is directly editable.',
  );
}
modeSelectButton.addEventListener('click', () => setInteractionMode('select'));
modeInteractButton.addEventListener('click', () => setInteractionMode('interact'));

// ------------------------------------------------------- direct text editing

editButton.addEventListener('click', () => {
  if (editSession) {
    finishEditSession();
    return;
  }
  if (interactionMode === 'interact') {
    setStatus('Switch to Select mode to edit text.', true);
    return;
  }
  const target = state.selectedId;
  const card = target ? cards.get(target) : undefined;
  if (!target || target === PENDING_ID || !state.frames.some((f) => f.id === target) || !card?.iframe) {
    setStatus('Select a saved frame first, then edit its text.', true);
    return;
  }
  editSession = { frameId: target, dirty: false, editCount: 0 };
  editButton.setAttribute('aria-pressed', 'true');
  editButton.textContent = 'Done editing';
  postToFrame(card, { type: 'editMode', enabled: true });
  setStatus('Editing text — local & free, no API calls. Click “Done editing” to save as a new version.');
});

function finishEditSession(): void {
  if (!editSession) return;
  const session = editSession;
  editSession = null;
  editButton.setAttribute('aria-pressed', 'false');
  editButton.textContent = 'Edit text';
  const card = cards.get(session.frameId);
  if (card?.iframe) {
    postToFrame(card, { type: 'editMode', enabled: false });
  }
  if (session.dirty && card?.html) {
    // One snapshot for the whole session (P5); the original version is untouched.
    send({ type: 'commitEdit', frameId: session.frameId, html: card.html, editCount: session.editCount });
    // The old card must show its unedited snapshot again.
    card.html = null;
    if (card.iframe) send({ type: 'requestFrame', id: card.id });
    setStatus('Saved your edits as a new version — free.');
  } else {
    setStatus('Edit mode off — nothing changed.');
  }
}

function handleTextEdit(card: FrameCard, edit: { path: number[]; before: string; text: string }): void {
  if (!editSession || card.html === null) return;
  const next = spliceTextEdit(card.html, edit.path, edit.before, edit.text, new DOMParser());
  if (next === null) {
    setStatus('Couldn’t map that edit back to the source — it was not recorded.', true);
    return;
  }
  card.html = next;
  editSession.dirty = true;
  editSession.editCount += 1;
  setStatus(
    `${editSession.editCount} edit${editSession.editCount === 1 ? '' : 's'} pending — local & free. Click “Done editing” to save.`,
  );
}

// -------------------------------------------- infinite canvas: pan/zoom (2b)

function applyView(): void {
  surface.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  zoomLevel.textContent = `${Math.round(zoom * 100)}%`;
  queueLiveness();
}

function setView(next: { panX: number; panY: number; zoom: number }): void {
  panX = next.panX;
  panY = next.panY;
  zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next.zoom));
  applyView();
}

/** Zoom keeping the viewport center fixed (buttons); wheel zoom anchors at the cursor. */
function zoomStep(delta: number, anchorX = board.clientWidth / 2, anchorY = board.clientHeight / 2): void {
  setView(zoomAt(panX, panY, zoom, zoom + delta, anchorX, anchorY));
}

/** Pan so `card` is centered at the current zoom. */
function centerFrame(id: string): void {
  const card = cards.get(id);
  if (!card) return;
  setView({
    panX: board.clientWidth / 2 - (card.x + card.width / 2) * zoom,
    panY: board.clientHeight / 2 - (card.y + card.height / 2) * zoom,
    zoom,
  });
}

document.getElementById('zoom-in')!.addEventListener('click', () => zoomStep(ZOOM_STEP * 2));
document.getElementById('zoom-out')!.addEventListener('click', () => zoomStep(-ZOOM_STEP * 2));
document.getElementById('zoom-100')!.addEventListener('click', () => {
  setView(zoomAt(panX, panY, zoom, 1, board.clientWidth / 2, board.clientHeight / 2));
});
document.getElementById('zoom-fit')!.addEventListener('click', () => {
  const target =
    (state.selectedId && cards.get(state.selectedId)) || [...cards.values()][0];
  if (!target) return;
  setView(
    fitFrame(
      { x: target.x, y: target.y, width: target.width, height: target.height },
      board.clientWidth,
      board.clientHeight,
    ),
  );
});

// Wheel: plain scroll pans; ctrl/cmd-scroll zooms toward the cursor. Local, free.
board.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    const bounds = board.getBoundingClientRect();
    if (event.ctrlKey || event.metaKey) {
      const factor = Math.exp(-event.deltaY * 0.0015);
      setView(
        zoomAt(panX, panY, zoom, zoom * factor, event.clientX - bounds.left, event.clientY - bounds.top),
      );
    } else {
      setView({ panX: panX - event.deltaX, panY: panY - event.deltaY, zoom });
    }
  },
  { passive: false },
);

// Space-drag pans; dragging a frame header moves the frame (persisted on drop).
let spaceHeld = false;
let panDrag: { startX: number; startY: number; panX: number; panY: number } | null = null;
let dragState: {
  card: FrameCard;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  moved: boolean;
} | null = null;
let suppressNextClick = false;

window.addEventListener('keydown', (event) => {
  if (event.code === 'Space' && !isTypingTarget(event.target)) {
    spaceHeld = true;
    board.classList.add('pan-ready');
    if (!present) event.preventDefault();
  }
});
window.addEventListener('keyup', (event) => {
  if (event.code === 'Space') {
    spaceHeld = false;
    board.classList.remove('pan-ready');
  }
});

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

board.addEventListener('mousedown', (event) => {
  if (!spaceHeld) return;
  event.preventDefault();
  panDrag = { startX: event.clientX, startY: event.clientY, panX, panY };
  board.classList.add('panning');
});

function wireFrameDrag(card: FrameCard): void {
  card.header.addEventListener('mousedown', (event) => {
    if (spaceHeld || (event.target as HTMLElement).tagName === 'BUTTON') return;
    event.preventDefault();
    dragState = {
      card,
      startX: event.clientX,
      startY: event.clientY,
      originX: card.x,
      originY: card.y,
      moved: false,
    };
  });
}

window.addEventListener('mousemove', (event) => {
  if (panDrag) {
    setView({
      panX: panDrag.panX + (event.clientX - panDrag.startX),
      panY: panDrag.panY + (event.clientY - panDrag.startY),
      zoom,
    });
    return;
  }
  if (dragState) {
    const dx = (event.clientX - dragState.startX) / zoom;
    const dy = (event.clientY - dragState.startY) / zoom;
    if (Math.abs(dx) + Math.abs(dy) > 3) dragState.moved = true;
    placeCard(dragState.card, dragState.originX + dx, dragState.originY + dy);
  }
});

window.addEventListener('mouseup', () => {
  if (panDrag) {
    panDrag = null;
    board.classList.remove('panning');
  }
  if (dragState) {
    if (dragState.moved && dragState.card.id !== PENDING_ID) {
      // Persist to the project manifest — git-diffable, free (P4/P5).
      send({
        type: 'moveFrame',
        id: dragState.card.id,
        x: Math.round(dragState.card.x),
        y: Math.round(dragState.card.y),
      });
      queueLiveness();
      suppressNextClick = true;
      setTimeout(() => (suppressNextClick = false), 0);
    }
    dragState = null;
  }
});

// ------------------------------------------------------------------- bus in

window.addEventListener('message', (event: MessageEvent) => {
  // Frame iframes may post only while an edit session is open, only from the
  // session frame's contentWindow, and only messages matching the artifact
  // schema — everything else from an iframe is dropped (P6).
  if (event.source && editSession) {
    const sessionCard = cards.get(editSession.frameId);
    if (sessionCard?.iframe && event.source === sessionCard.iframe.contentWindow) {
      const editParsed = artifactToCanvasSchema.safeParse(event.data);
      if (editParsed.success) {
        handleTextEdit(sessionCard, editParsed.data);
      }
      return;
    }
  }
  const parsed = hostToWebviewSchema.safeParse(event.data);
  if (!parsed.success) return;
  const message = parsed.data;

  switch (message.type) {
    case 'keyState':
      if (!message.present) {
        setStatus('No API key set — run “Underpainting: Set OpenRouter API Key”. The canvas stays read-only until then.');
      }
      break;
    case 'validation': {
      // Issues that survived the correction cap: surfaced, never silent (§7).
      const summary =
        message.issues.length === 0
          ? `Validator clean after ${message.correctionPasses} correction pass${message.correctionPasses === 1 ? '' : 'es'}.`
          : `⚠ ${message.issues.length} authoring issue${message.issues.length === 1 ? '' : 's'} remain${message.issues.length === 1 ? 's' : ''} after ${message.correctionPasses} correction pass${message.correctionPasses === 1 ? '' : 'es'}.`;
      setStatus(summary, message.issues.length > 0);
      if (message.issues.length > 0) {
        const bubble = chatBubble('error', `${summary}\n• ${message.issues.join('\n• ')}`);
        bubble.style.whiteSpace = 'pre-wrap';
        chatLog.appendChild(bubble);
        chatLog.scrollTop = chatLog.scrollHeight;
      }
      break;
    }
    case 'modelState': {
      const note = document.getElementById('model-note') as HTMLDivElement;
      if (!message.modelId) {
        note.textContent = 'No model selected — run “Underpainting: Select Generation Model”.';
      } else {
        note.textContent =
          `Sends to ${message.modelId}` +
          (message.pricing ? ` · ${message.pricing}` : ' · pricing unknown (reopen the model picker)');
      }
      break;
    }
    case 'workspaceState': {
      if (!message.open) {
        const note = document.getElementById('system-note') as HTMLDivElement;
        note.className = 'stale';
        note.textContent =
          '⚠ No folder is open — designs render but versions, frames, and chat history cannot be saved. Open a folder (File → Open Folder), then reopen the canvas.';
      }
      break;
    }
    case 'systemState': {
      groundingTokensPresent = message.tokensPresent;
      const note = document.getElementById('system-note') as HTMLDivElement;
      if (message.stale) {
        note.className = 'stale';
        note.textContent =
          '⚠ Design system may be stale — its source files changed. Run “Underpainting: Extract Design System” to refresh (local, free).';
      } else if (message.tokensPresent) {
        note.className = '';
        note.textContent = `Grounded in your design system: ${message.tokenCount} tokens from .design/system/.`;
      } else {
        note.className = '';
        note.textContent =
          'No design system extracted yet — run “Underpainting: Extract Design System” to ground generations in your repo’s tokens (local, free).';
      }
      break;
    }
    case 'streamStart': {
      setGenerating(true);
      setStatus('Generating…');
      state = startPending(state);
      const card = cards.get(PENDING_ID) ?? createCard(PENDING_ID);
      card.title.textContent = 'Generating…';
      card.subtitle.textContent = '';
      card.html = '';
      if (card.iframe && card.iframeLoaded) postToFrame(card, { type: 'reset' });
      render();
      centerFrame(PENDING_ID);
      break;
    }
    case 'streamChunk': {
      const card = cards.get(PENDING_ID) ?? cards.get(state.selectedId ?? '');
      if (card) setFrameHtml(card, message.html);
      break;
    }
    case 'frames': {
      const result = applyFrames(state, message.frames, message.currentId, message.justCommitted);
      state = result.state;
      if (result.adoptPendingAs) {
        adoptPending(
          result.adoptPendingAs,
          message.frames.find((f) => f.id === result.adoptPendingAs),
        );
        ephemeral = null; // the committed exchange now lives in the derived history
      }
      render();
      break;
    }
    case 'frameContent': {
      const card = cards.get(message.id);
      if (card) setFrameHtml(card, message.html);
      if (present && present.frameId === message.id) {
        setPresentHtml(message.html);
      }
      break;
    }
    case 'streamDone': {
      setGenerating(false);
      const cost =
        message.costUsd !== null ? `$${message.costUsd.toFixed(4)}` : 'cost unavailable';
      const tokens =
        message.promptTokens !== null && message.completionTokens !== null
          ? ` (${message.promptTokens} prompt + ${message.completionTokens} completion tokens)`
          : '';
      setStatus(`This generation: ${cost}${tokens}`);
      // If the pending card was not adopted, no commit happened (no workspace).
      const orphan = cards.get(PENDING_ID);
      if (orphan) {
        orphan.title.textContent = 'Unsaved';
        orphan.subtitle.textContent = 'open a folder to keep versions';
        if (ephemeral) ephemeral = { ...ephemeral, status: 'unsaved', detail: `Done — ${cost}, unsaved (open a folder to keep versions).` };
        state = endPending(state);
        renderChat();
      }
      break;
    }
    case 'streamCancelled': {
      setGenerating(false);
      setStatus('Cancelled — the stream was aborted. Nothing was saved.');
      const card = cards.get(PENDING_ID);
      if (card) {
        card.title.textContent = 'Cancelled';
        card.subtitle.textContent = 'not saved';
      }
      if (ephemeral) ephemeral = { ...ephemeral, status: 'cancelled' };
      state = endPending(state);
      renderChat();
      break;
    }
    case 'streamError': {
      setGenerating(false);
      setStatus(message.message, true);
      const card = cards.get(PENDING_ID);
      if (card && !card.html) {
        card.root.remove();
        cards.delete(PENDING_ID);
      }
      if (ephemeral) {
        ephemeral = { ...ephemeral, status: 'error', detail: message.message };
      } else {
        ephemeral = { userText: promptInput.value.trim() || '(request)', status: 'error', detail: message.message };
      }
      state = endPending(state);
      renderChat();
      break;
    }
  }
});

// ----------------------------------------------------- present mode (free)

/**
 * Present mode (v0.2 item 2a): the selected frame full-screen at natural
 * scale, interactivity on by default (the iframe receives all pointer
 * events; the sandbox still contains everything). Esc exits, ←/→ steps
 * through versions in manifest order. Entirely local and free (P4).
 */
function openPresent(frameId: string): void {
  if (editSession) finishEditSession();
  closePresent();
  const templateIframe = frameTemplate.content.querySelector('iframe') as HTMLIFrameElement;
  const iframe = templateIframe.cloneNode(true) as HTMLIFrameElement;
  present = { frameId, iframe, loaded: false, html: null };
  iframe.addEventListener('load', () => {
    if (!present || present.iframe !== iframe) return;
    present.loaded = true;
    if (present.html !== null) {
      iframe.contentWindow?.postMessage({ type: 'patch', html: present.html }, '*');
    }
  });
  presentStage.appendChild(iframe);
  presentOverlay.hidden = false;
  loadPresentContent(frameId);
  sizePresentIframe(frameId);
}

function closePresent(): void {
  if (!present) return;
  present.iframe.remove();
  present = null;
  presentOverlay.hidden = true;
}

function sizePresentIframe(frameId: string): void {
  if (!present) return;
  const size = state.frames.find((f) => f.id === frameId)?.size;
  // Present at the design's own width, centered — a mobile screen presents
  // as a phone-width column, not stretched to the window.
  present.iframe.style.width = size ? `${size.width}px` : '100%';
  present.iframe.style.maxWidth = '100%';
}

function loadPresentContent(frameId: string): void {
  if (!present) return;
  present.frameId = frameId;
  sizePresentIframe(frameId);
  const meta = state.frames.find((f) => f.id === frameId);
  const index = state.frames.findIndex((f) => f.id === frameId);
  (document.getElementById('present-title') as HTMLSpanElement).textContent = meta?.title ?? '';
  (document.getElementById('present-pos') as HTMLSpanElement).textContent =
    index >= 0 ? `version ${index + 1} of ${state.frames.length}` : '';
  const cached = cards.get(frameId)?.html ?? null;
  if (cached !== null) {
    setPresentHtml(cached);
  } else {
    present.html = null;
    send({ type: 'requestFrame', id: frameId });
  }
  // Keep board selection in sync so refine/edit target what was presented.
  state = select(state, frameId);
  send({ type: 'selectFrame', id: frameId });
}

function setPresentHtml(html: string): void {
  if (!present) return;
  const meta = state.frames.find((f) => f.id === present!.frameId);
  // Same ADR-002 gate as board frames: validated script-bearing artifacts
  // render as their own document; everything else morphs sanitized.
  if (meta?.validated && needsScriptRender(html)) {
    present.html = html;
    present.loaded = false;
    present.iframe.srcdoc = committedSrcdoc(html, frameTemplate.dataset['nonce'] ?? '');
    return;
  }
  present.html = html;
  if (present.loaded) {
    present.iframe.contentWindow?.postMessage({ type: 'patch', html }, '*');
  }
}

function stepPresent(direction: -1 | 1): void {
  if (!present) return;
  const next = stepFrame(state.frames, present.frameId, direction);
  if (next !== present.frameId) {
    present.iframe.contentWindow?.postMessage({ type: 'reset' }, '*');
    loadPresentContent(next);
  }
}

document.getElementById('present-button')!.addEventListener('click', () => {
  const target =
    state.selectedId && state.selectedId !== PENDING_ID && state.frames.some((f) => f.id === state.selectedId)
      ? state.selectedId
      : (state.currentId ?? state.frames.at(-1)?.id);
  if (!target) {
    setStatus('Nothing to present yet — generate a design first.');
    return;
  }
  openPresent(target);
});
document.getElementById('present-close')!.addEventListener('click', closePresent);
window.addEventListener('keydown', (event) => {
  if (!present) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closePresent();
    render();
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault();
    stepPresent(-1);
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    stepPresent(1);
  }
});

// ---------------------------------------------- clarify-before-spend (free)

/**
 * Show the one optional clarify round: only unanswered fields appear (the
 * A6-style licensing logic in shared/clarify.ts), the form is deterministic
 * and local (free, P3/P4), and it never appears twice for a prompt. Returns
 * false when nothing is worth asking.
 */
function openClarifyForm(prompt: string): boolean {
  const fields = fieldsToAsk(prompt, groundingTokensPresent);
  // Constraints alone isn't worth an interruption — the prompt was thorough.
  if (fields.length <= 1) return false;
  pendingClarifyPrompt = prompt;
  for (const field of clarifyPanel.querySelectorAll<HTMLElement>('.clarify-field')) {
    field.hidden = !fields.includes(field.dataset['field'] as ReturnType<typeof fieldsToAsk>[number]);
  }
  clarifyPanel.hidden = false;
  generateButton.disabled = true;
  setStatus('Optional choices below — answering is free; only Generate spends.');
  return true;
}

function closeClarifyForm(): void {
  pendingClarifyPrompt = null;
  clarifyPanel.hidden = true;
  generateButton.disabled = false;
  // Reset transient inputs so the next round starts clean.
  for (const button of clarifyPanel.querySelectorAll<HTMLButtonElement>('[aria-pressed], [aria-checked]')) {
    button.setAttribute(button.hasAttribute('aria-pressed') ? 'aria-pressed' : 'aria-checked', 'false');
  }
  for (const input of clarifyPanel.querySelectorAll<HTMLInputElement>('input')) {
    input.value = '';
  }
  (document.getElementById('clarify-variations') as HTMLSelectElement).value = '1';
}

function collectClarifyAnswers(): Clarifications | undefined {
  const target = clarifyPanel
    .querySelector<HTMLButtonElement>('[data-field="target"] button[aria-checked="true"]')
    ?.dataset['value'] as Clarifications['target'];
  const chips = [...clarifyPanel.querySelectorAll<HTMLButtonElement>('#clarify-style-chips button[aria-pressed="true"]')]
    .map((b) => b.textContent ?? '')
    .filter(Boolean);
  const styleText = (document.getElementById('clarify-style-text') as HTMLInputElement).value.trim();
  const style = [...chips, styleText].filter(Boolean).join(', ');
  return normalizeAnswers({
    target,
    style,
    colors: (document.getElementById('clarify-colors') as HTMLInputElement).value,
    variations: Number((document.getElementById('clarify-variations') as HTMLSelectElement).value),
    constraints: (document.getElementById('clarify-constraints') as HTMLInputElement).value,
  });
}

function dispatchGenerate(prompt: string, clarifications: Clarifications | undefined): void {
  ephemeral = { userText: prompt, status: 'generating' };
  send(clarifications ? { type: 'generate', prompt, clarifications } : { type: 'generate', prompt });
  promptInput.value = '';
  renderChat();
}

for (const group of clarifyPanel.querySelectorAll<HTMLElement>('[role="radiogroup"]')) {
  for (const button of group.querySelectorAll('button')) {
    button.addEventListener('click', () => {
      for (const other of group.querySelectorAll('button')) {
        other.setAttribute('aria-checked', String(other === button && other.getAttribute('aria-checked') !== 'true'));
      }
    });
  }
}
for (const chip of clarifyPanel.querySelectorAll<HTMLButtonElement>('#clarify-style-chips button')) {
  chip.setAttribute('aria-pressed', 'false');
  chip.addEventListener('click', () =>
    chip.setAttribute('aria-pressed', String(chip.getAttribute('aria-pressed') !== 'true')),
  );
}
document.getElementById('clarify-send')!.addEventListener('click', () => {
  if (!pendingClarifyPrompt) return;
  const prompt = pendingClarifyPrompt;
  const answers = collectClarifyAnswers();
  closeClarifyForm();
  dispatchGenerate(prompt, answers); // the explicit paid action (P3)
});
document.getElementById('clarify-skip')!.addEventListener('click', () => {
  if (!pendingClarifyPrompt) return;
  const prompt = pendingClarifyPrompt;
  closeClarifyForm();
  dispatchGenerate(prompt, undefined);
});

// ------------------------------------------------------------------ bus out

generateButton.addEventListener('click', () => {
  const prompt = promptInput.value.trim();
  if (!prompt) {
    setStatus('Type a prompt first.');
    return;
  }
  // Sending while editing saves the edit session first, so the refinement
  // base and the board agree on what the user is looking at.
  if (editSession) {
    finishEditSession();
  }
  // This click is the explicit user action behind the API call (P3).
  if (mode === 'refine') {
    const target = state.selectedId;
    if (!target || target === PENDING_ID || !state.frames.some((f) => f.id === target)) {
      setStatus('Select a saved frame to refine, or switch to "New design".', true);
      return;
    }
    ephemeral = { userText: prompt, status: 'generating' };
    send({ type: 'refine', frameId: target, instruction: prompt });
    promptInput.value = '';
    renderChat();
  } else {
    // One optional, free clarify round for NEW designs only (v0.2 item 1).
    if (openClarifyForm(prompt)) return;
    dispatchGenerate(prompt, undefined);
  }
});

cancelButton.addEventListener('click', () => send({ type: 'cancel' }));

promptInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !generateButton.disabled) {
    generateButton.click();
  }
});

setMode('new');
applyView();
send({ type: 'ready' });
