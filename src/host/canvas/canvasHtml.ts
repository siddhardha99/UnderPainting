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
 * Frame board (ADR-009): versions render as titled frames in a wrapping flow
 * layout with zoom/fit controls. Everything on the board — select, zoom,
 * viewport width, restore — is local and free (P4); the one paid action is
 * the labeled Generate button.
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
      display: flex; flex-direction: column;
      font-family: var(--vscode-font-family); color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    #toolbar {
      display: flex; gap: 8px; align-items: center; padding: 8px;
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
      flex: none; flex-wrap: wrap;
    }
    #prompt {
      flex: 1; min-width: 200px; padding: 6px 8px;
      color: var(--vscode-input-foreground); background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px;
      font-family: inherit; font-size: 13px;
    }
    button {
      padding: 6px 12px; border: none; border-radius: 2px; cursor: pointer;
      font-family: inherit; font-size: 13px;
    }
    button:disabled { opacity: .5; cursor: default; }
    #generate {
      color: var(--vscode-button-foreground); background: var(--vscode-button-background);
      font-weight: 600;
    }
    #cancel, #viewport button, #zoom button {
      color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
    }
    #viewport { display: flex; gap: 2px; flex: none; }
    #viewport button, #zoom button { font-size: 12px; padding: 4px 10px; }
    #viewport button[aria-pressed="true"] {
      color: var(--vscode-button-foreground); background: var(--vscode-button-background);
    }
    #zoom { display: flex; gap: 2px; align-items: center; flex: none; }
    #zoom-level { font-size: 11px; min-width: 4ch; text-align: center; opacity: .8; }
    /* The free/paid boundary must be visually unambiguous (P4). */
    #paid-note { font-size: 11px; opacity: .75; padding: 2px 8px 6px; flex: none; }
    #status { padding: 4px 8px; font-size: 12px; min-height: 1.2em; flex: none; }
    #status.error { color: var(--vscode-errorForeground); }

    /* Frame board (ADR-009): wrapping flow, no free-form arrange in v0.1. */
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
  <div id="toolbar">
    <input id="prompt" type="text" placeholder="Describe the UI to generate…" aria-label="Design prompt">
    <button id="generate" title="Sends one request to OpenRouter using your key">Generate&nbsp;·&nbsp;paid</button>
    <button id="cancel" disabled>Cancel</button>
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
  <div id="paid-note">“Generate” makes one paid API request with your OpenRouter key. Everything else on this canvas — selecting, zooming, restoring versions — is local and free.</div>
  <div id="status" role="status"></div>
  <div id="board" role="list" aria-label="Design frames"></div>
  <template id="frame-template">
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
