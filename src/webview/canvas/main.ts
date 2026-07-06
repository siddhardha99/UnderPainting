import {
  artifactToCanvasSchema,
  hostToWebviewSchema,
  webviewToHostSchema,
  type FrameMeta,
  type WebviewToHost,
} from '../../shared/messages';
import { spliceTextEdit } from './spliceText';
import { committedSrcdoc, needsScriptRender } from './commitRender';
import {
  applyFrames,
  endPending,
  initialState,
  PENDING_ID,
  select,
  startPending,
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
const ZOOM_MIN = 0.15;
const ZOOM_MAX = 1.5;
const ZOOM_STEP = 0.05;

interface FrameCard {
  id: string;
  root: HTMLDivElement;
  clip: HTMLDivElement;
  title: HTMLSpanElement;
  subtitle: HTMLSpanElement;
  badge: HTMLSpanElement;
  restoreButton: HTMLButtonElement;
  iframe: HTMLIFrameElement | null;
  iframeLoaded: boolean;
  /** Latest artifact HTML for this frame; flushed to the iframe once it loads. */
  html: string | null;
  logicalWidth: number;
  onScreen: boolean;
}

/** The in-flight (or just-finished-unsaved) exchange, drawn after committed history. */
interface EphemeralExchange {
  userText: string;
  status: 'generating' | 'error' | 'cancelled' | 'unsaved';
  detail?: string;
}

let state: BoardState = initialState();
const cards = new Map<string, FrameCard>();
let zoom = 0.4;
let mode: 'new' | 'refine' = 'new';
let ephemeral: EphemeralExchange | null = null;
/** Active direct-edit session (M1 item 4) — entirely local until Done saves one snapshot. */
let editSession: { frameId: string; dirty: boolean; editCount: number } | null = null;
const editButton = document.getElementById('edit-text') as HTMLButtonElement;

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
      cards.get(frame.id)?.root.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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

const visibility = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const card = [...cards.values()].find((c) => c.root === entry.target);
      if (!card) continue;
      card.onScreen = entry.isIntersecting;
      syncLiveness(card);
    }
  },
  { root: board, rootMargin: '128px' },
);

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
    iframe: root.querySelector('iframe'),
    iframeLoaded: false,
    html: null,
    logicalWidth: DEFAULT_LOGICAL_WIDTH,
    onScreen: false,
  };
  wireIframe(card);
  card.root.addEventListener('click', () => selectFrameById(card.id));
  card.restoreButton.addEventListener('click', (event) => {
    event.stopPropagation();
    send({ type: 'restore', id: card.id }); // local file op on the host — free (P4)
  });
  applyCardSize(card);
  board.appendChild(root);
  visibility.observe(root);
  cards.set(id, card);
  return card;
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
 * Live-iframe budget (ADR-009): live = selected or on screen. Dropping to a
 * placeholder discards the iframe; coming back clones a fresh one from the
 * template and re-requests the snapshot from the host.
 */
function syncLiveness(card: FrameCard): void {
  const shouldBeLive = card.onScreen || state.selectedId === card.id || card.id === PENDING_ID;
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
  card.clip.style.width = `${Math.round(card.logicalWidth * zoom)}px`;
  card.clip.style.height = `${Math.round(LOGICAL_HEIGHT * zoom)}px`;
  if (card.iframe) {
    card.iframe.style.width = `${card.logicalWidth}px`;
    card.iframe.style.height = `${LOGICAL_HEIGHT}px`;
    card.iframe.style.transform = `scale(${zoom})`;
  }
}

function render(): void {
  // Drop cards whose frames disappeared (restore never deletes, but stay defensive).
  for (const [id, card] of cards) {
    if (id !== PENDING_ID && !state.frames.some((f) => f.id === id)) {
      visibility.unobserve(card.root);
      card.root.remove();
      cards.delete(id);
    }
  }
  for (const frame of state.frames) {
    const card = cards.get(frame.id) ?? createCard(frame.id);
    card.title.textContent = (frame.validated ? '' : '⚠ ') + frame.title;
    card.subtitle.textContent = frame.subtitle;
    card.badge.hidden = !frame.isCurrent;
    card.restoreButton.hidden = frame.isCurrent;
  }
  for (const card of cards.values()) {
    card.root.classList.toggle('selected', state.selectedId === card.id);
    syncLiveness(card);
  }
  syncViewportButtons();
  renderChat();
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

// ------------------------------------------------------- direct text editing

editButton.addEventListener('click', () => {
  if (editSession) {
    finishEditSession();
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

// ------------------------------------------------------------------ zoom/fit

function setZoom(next: number): void {
  zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
  zoomLevel.textContent = `${Math.round(zoom * 100)}%`;
  for (const card of cards.values()) {
    applyCardSize(card);
  }
}

document.getElementById('zoom-in')!.addEventListener('click', () => setZoom(zoom + ZOOM_STEP));
document.getElementById('zoom-out')!.addEventListener('click', () => setZoom(zoom - ZOOM_STEP));
document.getElementById('zoom-fit')!.addEventListener('click', () => {
  const selected = state.selectedId ? cards.get(state.selectedId) : undefined;
  const logicalWidth = selected?.logicalWidth ?? DEFAULT_LOGICAL_WIDTH;
  setZoom((board.clientWidth - 48) / logicalWidth);
});

// ------------------------------------------------- viewport width (selected)

const viewportButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>('#viewport button'),
);
for (const button of viewportButtons) {
  button.addEventListener('click', () => {
    const card = state.selectedId ? cards.get(state.selectedId) : undefined;
    if (!card) return;
    card.logicalWidth = Number(button.dataset['width']) || DEFAULT_LOGICAL_WIDTH;
    applyCardSize(card);
    syncViewportButtons();
  });
}

function syncViewportButtons(): void {
  const card = state.selectedId ? cards.get(state.selectedId) : undefined;
  const width = card?.logicalWidth ?? DEFAULT_LOGICAL_WIDTH;
  for (const button of viewportButtons) {
    button.setAttribute('aria-pressed', String(Number(button.dataset['width']) === width));
  }
}

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
      card.root.scrollIntoView({ block: 'nearest' });
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
        visibility.unobserve(card.root);
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
  } else {
    ephemeral = { userText: prompt, status: 'generating' };
    send({ type: 'generate', prompt });
  }
  promptInput.value = '';
  renderChat();
});

cancelButton.addEventListener('click', () => send({ type: 'cancel' }));

promptInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !generateButton.disabled) {
    generateButton.click();
  }
});

setMode('new');
setZoom(zoom);
send({ type: 'ready' });
