/**
 * Builds the canvas webview HTML. Pure string functions — no vscode imports —
 * so the CSP invariant test (test/invariants/csp.test.ts) can exercise the
 * exact HTML the webview receives.
 *
 * Security model (invariant P6):
 * - The webview document carries a strict CSP: default-src 'none', scripts
 *   only via nonce, no connect-src, images/fonts only data:.
 * - Artifacts render inside nested <iframe sandbox="allow-scripts"> frames
 *   with NO allow-same-origin: each artifact document has an opaque origin
 *   and cannot touch the canvas chrome, the VS Code API, or any storage.
 * - Frames are cloned from the single <template id="frame-template"> below,
 *   so the iframe's sandbox/srcdoc attributes are pinned in this static HTML
 *   and asserted by the invariant test even though frames mount dynamically.
 * - The iframes are srcdoc-based; about:srcdoc documents inherit this same
 *   CSP, so artifact-injected scripts (which never get the nonce) cannot
 *   execute, and no network fetch of any kind is permitted inside them.
 *
 * Layout (ADR-009): a chat sidebar drives generation and refinement of the
 * selected frame; the board renders versions as titled frames in a wrapping
 * flow with zoom/fit controls. Everything except Send is local and free (P4).
 */

export interface CanvasHtmlOptions {
  /** webview.cspSource */
  cspSource: string;
  /** Per-panel random nonce; the only way script executes in this webview. */
  nonce: string;
  /** URI of the bundled canvas script (dist/webview/canvas.js). */
  canvasScriptUri: string;
  /** Text of the bundled artifact bootstrap (dist/webview/artifactBootstrap.js), inlined into each frame's srcdoc. */
  bootstrapJs: string;
}

export function buildCsp(cspSource: string, nonce: string): string {
  return [
    "default-src 'none'",
    `style-src ${cspSource} 'unsafe-inline'`,
    'img-src data:',
    'font-src data:',
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
}

export function buildArtifactSrcdoc(nonce: string, bootstrapJs: string): string {
  // A literal "</script>" inside the inlined bundle would terminate the tag early.
  const safeJs = bootstrapJs.replace(/<\/script/gi, '<\\/script');
  return [
    '<!doctype html>',
    '<html>',
    '<head><meta charset="utf-8"></head>',
    '<body>',
    `<script nonce="${nonce}">${safeJs}</script>`,
    '</body>',
    '</html>',
  ].join('');
}

export function buildCanvasHtml(o: CanvasHtmlOptions): string {
  const csp = buildCsp(o.cspSource, o.nonce);
  const srcdoc = escapeAttr(buildArtifactSrcdoc(o.nonce, o.bootstrapJs));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Underpainting</title>
  <style>
    :root { color-scheme: light dark; }
    html, body { height: 100%; margin: 0; }
    body {
      font-family: var(--vscode-font-family); color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    #app { display: flex; height: 100%; }
    button {
      padding: 6px 12px; border: none; border-radius: 2px; cursor: pointer;
      font-family: inherit; font-size: 13px;
    }
    button:disabled { opacity: .5; cursor: default; }

    /* ------------------------------------------------ chat sidebar */
    #chat {
      width: 300px; flex: none; display: flex; flex-direction: column;
      border-right: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
      background: var(--vscode-sideBar-background, transparent);
    }
    #chat[hidden] { display: none; }
    #chat-log { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
    .msg { font-size: 12px; line-height: 1.4; border-radius: 6px; padding: 6px 9px; max-width: 95%; }
    .msg.user {
      align-self: flex-end;
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      white-space: pre-wrap;
    }
    .msg.result {
      align-self: flex-start;
      background: var(--vscode-editorWidget-background, rgba(128,128,128,.15));
      cursor: pointer;
    }
    .msg.result .cost { font-weight: 600; }
    .msg.error { align-self: flex-start; color: var(--vscode-errorForeground); }
    .msg .meta { opacity: .65; font-size: 11px; }
    #chat-compose {
      flex: none; padding: 8px; display: flex; flex-direction: column; gap: 6px;
      border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
    }
    #mode { display: flex; gap: 2px; }
    #mode button {
      flex: 1; font-size: 11px; padding: 3px 6px;
      color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
    }
    #mode button[aria-checked="true"] {
      color: var(--vscode-button-foreground); background: var(--vscode-button-background);
    }
    #prompt {
      resize: vertical; min-height: 52px; padding: 6px 8px;
      color: var(--vscode-input-foreground); background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px;
      font-family: inherit; font-size: 13px;
    }
    .compose-row { display: flex; gap: 6px; }
    #generate {
      flex: 1; color: var(--vscode-button-foreground); background: var(--vscode-button-background);
      font-weight: 600;
    }
    #cancel {
      color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
    }
    /* The free/paid boundary must be visually unambiguous (P4). */
    #model-note { font-size: 11px; opacity: .85; font-weight: 600; }
    #paid-note { font-size: 10px; opacity: .7; }

    /* Clarify-before-spend form (v0.2 item 1) — local & free by construction. */
    #clarify { display: flex; flex-direction: column; gap: 8px; padding: 8px; border: 1px solid var(--vscode-focusBorder, #007fd4); border-radius: 4px; }
    #clarify[hidden] { display: none; }
    #clarify-title { font-size: 11px; font-weight: 600; }
    .clarify-field { display: flex; flex-direction: column; gap: 3px; }
    .clarify-field[hidden] { display: none; }
    .clarify-field label { font-size: 10px; opacity: .75; text-transform: uppercase; letter-spacing: .04em; }
    .clarify-field input, .clarify-field select {
      padding: 4px 6px; font-size: 12px; font-family: inherit;
      color: var(--vscode-input-foreground); background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px;
    }
    .chips { display: flex; flex-wrap: wrap; gap: 3px; }
    .chips button, .clarify-field [role="radiogroup"] button {
      font-size: 11px; padding: 2px 8px;
      color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
    }
    .chips button[aria-pressed="true"], .clarify-field [role="radiogroup"] button[aria-checked="true"] {
      color: var(--vscode-button-foreground); background: var(--vscode-button-background);
    }
    #clarify-send { flex: 1; color: var(--vscode-button-foreground); background: var(--vscode-button-background); font-weight: 600; }
    #clarify-skip { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }

    /* ------------------------------------------------ board side */
    #main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    #toolbar {
      display: flex; gap: 8px; align-items: center; padding: 8px; flex-wrap: wrap;
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
      flex: none;
    }
    #toolbar .spacer { flex: 1; }
    #edit-text[aria-pressed="true"] {
      color: var(--vscode-button-foreground) !important; background: var(--vscode-button-background) !important;
    }
    /* Present mode (v0.2 item 2a) — full-screen, interactive, local & free. */
    #present-overlay {
      position: fixed; inset: 0; z-index: 100; display: flex; flex-direction: column;
      background: var(--vscode-editor-background);
    }
    #present-overlay[hidden] { display: none; }
    #present-bar {
      flex: none; display: flex; gap: 10px; align-items: center; padding: 6px 10px;
      font-size: 12px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
    }
    #present-title { font-weight: 600; }
    #present-pos { opacity: .75; }
    #present-hint { opacity: .6; font-size: 11px; margin-left: auto; }
    #present-stage { flex: 1; min-height: 0; background: #ffffff; }
    #present-stage iframe { width: 100%; height: 100%; border: none; display: block; background: #ffffff; }

    #toggle-chat, #edit-text, #present-button, #viewport button, #zoom button {
      color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
      font-size: 12px; padding: 4px 10px;
    }
    #viewport { display: flex; gap: 2px; flex: none; }
    #viewport button[aria-pressed="true"] {
      color: var(--vscode-button-foreground); background: var(--vscode-button-background);
    }
    #zoom { display: flex; gap: 2px; align-items: center; flex: none; }
    #zoom-level { font-size: 11px; min-width: 4ch; text-align: center; opacity: .8; }
    #status { padding: 4px 8px; font-size: 12px; min-height: 1.2em; flex: none; }
    #status.error { color: var(--vscode-errorForeground); }
    #system-note { padding: 0 8px 4px; font-size: 11px; opacity: .75; flex: none; }
    #system-note.stale { color: var(--vscode-editorWarning-foreground, #cca700); opacity: 1; }

    #board {
      flex: 1; overflow: auto; padding: 16px;
      display: flex; flex-wrap: wrap; gap: 16px; align-content: flex-start;
    }
    #board:empty::after {
      content: 'Generated designs appear here as frames — each version side by side, nothing overwritten.';
      opacity: .6; font-size: 12px;
    }
    .frame { flex: none; display: flex; flex-direction: column; gap: 4px; }
    .frame-header {
      display: flex; gap: 6px; align-items: baseline; font-size: 11px;
      max-width: 100%; overflow: hidden; white-space: nowrap;
    }
    .frame-title { font-weight: 600; }
    .frame-subtitle { opacity: .65; overflow: hidden; text-overflow: ellipsis; }
    .current-badge {
      padding: 1px 6px; border-radius: 8px; font-size: 10px;
      background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    }
    .restore { font-size: 10px; padding: 2px 8px; }
    .frame-clip {
      position: relative; overflow: hidden; cursor: pointer;
      background: #ffffff; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
    }
    .frame.selected .frame-clip { outline: 2px solid var(--vscode-focusBorder, #007fd4); outline-offset: 1px; }
    .frame-clip iframe { border: none; background: #ffffff; transform-origin: 0 0; display: block; }
    .frame-placeholder {
      position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
      font-size: 12px; opacity: .6; background: var(--vscode-editorWidget-background, #f3f3f3);
      color: var(--vscode-foreground);
    }
  </style>
</head>
<body>
  <div id="app">
    <aside id="chat" aria-label="Design chat">
      <div id="chat-log" role="log" aria-live="polite"></div>
      <div id="chat-compose">
        <div id="mode" role="radiogroup" aria-label="Send mode">
          <button id="mode-new" role="radio" aria-checked="true" title="Generate a fresh design — one paid API call">New design</button>
          <button id="mode-refine" role="radio" aria-checked="false" title="Change only what you ask on the selected frame — one paid API call">Refine selected</button>
        </div>
        <textarea id="prompt" placeholder="Describe the UI to generate…" aria-label="Design prompt"></textarea>
        <div id="clarify" hidden>
          <div id="clarify-title">Quick choices — answering is local &amp; free; only Generate spends</div>
          <div class="clarify-field" data-field="artifactType" hidden>
            <label>What is it?</label>
            <div role="radiogroup" aria-label="Artifact type">
              <button data-value="component" role="radio" aria-checked="false">Component</button>
              <button data-value="page" role="radio" aria-checked="false">Full page</button>
            </div>
          </div>
          <div class="clarify-field" data-field="style" hidden>
            <label>Style direction</label>
            <div class="chips" id="clarify-style-chips">
              <button>minimal</button><button>bold</button><button>playful</button>
              <button>corporate</button><button>elegant</button><button>editorial</button>
            </div>
            <input id="clarify-style-text" placeholder="or describe the feel in your own words…">
          </div>
          <div class="clarify-field" data-field="colors" hidden>
            <label>Brand colors (optional)</label>
            <input id="clarify-colors" placeholder="#0ea5e9, warm neutrals, …">
          </div>
          <div class="clarify-field" data-field="variations" hidden>
            <label>Variations in one document</label>
            <select id="clarify-variations"><option value="1">1</option><option value="2">2</option><option value="3">3</option></select>
          </div>
          <div class="clarify-field" data-field="constraints">
            <label>Constraints (optional)</label>
            <input id="clarify-constraints" placeholder="anything the design must respect…">
          </div>
          <div class="compose-row">
            <button id="clarify-send" title="One paid API request, with your answers folded in">Generate with these&nbsp;·&nbsp;paid</button>
            <button id="clarify-skip" title="One paid API request, prompt as written">Just generate&nbsp;·&nbsp;paid</button>
          </div>
        </div>
        <div class="compose-row">
          <button id="generate" title="Sends one request to OpenRouter using your key">Send&nbsp;·&nbsp;paid</button>
          <button id="cancel" disabled>Cancel</button>
        </div>
        <div id="model-note" title="The model and catalog pricing Send will use"></div>
        <div id="paid-note">“Send” makes one paid API request with your OpenRouter key. Everything else — selecting, zooming, restoring — is local and free.</div>
      </div>
    </aside>
    <main id="main">
      <div id="toolbar">
        <button id="toggle-chat" title="Show or hide the chat — free">Chat</button>
        <button id="edit-text" aria-pressed="false" title="Edit text directly on the selected frame — local, free, no API call">Edit text</button>
        <button id="present-button" title="Present the selected frame full-screen (Esc exits, ←/→ steps versions) — local, free">Present</button>
        <span class="spacer"></span>
        <div id="viewport" role="group" aria-label="Preview width of the selected frame — local, free">
          <button data-width="375" aria-pressed="false" title="375px preview — free, no API call">Mobile</button>
          <button data-width="768" aria-pressed="false" title="768px preview — free, no API call">Tablet</button>
          <button data-width="1280" aria-pressed="true" title="1280px preview — free, no API call">Desktop</button>
        </div>
        <div id="zoom" role="group" aria-label="Zoom — local, free">
          <button id="zoom-out" title="Zoom out — free">−</button>
          <span id="zoom-level">40%</span>
          <button id="zoom-in" title="Zoom in — free">+</button>
          <button id="zoom-fit" title="Fit the selected frame to the board — free">Fit</button>
        </div>
      </div>
      <div id="status" role="status"></div>
      <div id="system-note" role="status"></div>
      <div id="board" role="list" aria-label="Design frames"></div>
    </main>
  </div>
  <div id="present-overlay" hidden>
    <div id="present-bar">
      <span id="present-title"></span>
      <span id="present-pos"></span>
      <span id="present-hint">←/→ versions · Esc exit · interactions stay inside the sandbox — local &amp; free</span>
      <button id="present-close" title="Exit present mode (Esc)">✕</button>
    </div>
    <div id="present-stage"></div>
  </div>
  <template id="frame-template" data-nonce="${o.nonce}">
    <div class="frame" role="listitem" tabindex="0">
      <div class="frame-header">
        <span class="frame-title"></span>
        <span class="frame-subtitle"></span>
        <span class="current-badge" hidden>current</span>
        <button class="restore" hidden title="Make this the current version — local, free">Restore</button>
      </div>
      <div class="frame-clip">
        <iframe sandbox="allow-scripts" srcdoc="${srcdoc}" title="Design artifact frame"></iframe>
      </div>
    </div>
  </template>
  <script nonce="${o.nonce}" src="${o.canvasScriptUri}"></script>
</body>
</html>`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
