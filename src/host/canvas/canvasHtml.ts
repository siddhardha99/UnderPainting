/**
 * Builds the canvas webview HTML. Pure string functions — no vscode imports —
 * so the CSP invariant test (test/invariants/csp.test.ts) can exercise the
 * exact HTML the webview receives.
 *
 * Security model (invariant P6):
 * - The webview document carries a strict CSP: default-src 'none', scripts
 *   only via nonce, no connect-src, images/fonts only data:.
 * - The artifact renders inside a nested <iframe sandbox="allow-scripts">
 *   with NO allow-same-origin: the artifact document has an opaque origin and
 *   cannot touch the canvas chrome, the VS Code API, or any storage.
 * - The iframe is srcdoc-based; about:srcdoc documents inherit this same CSP,
 *   so artifact-injected scripts (which never get the nonce) cannot execute,
 *   and no network fetch of any kind is permitted inside it.
 */

export interface CanvasHtmlOptions {
  /** webview.cspSource */
  cspSource: string;
  /** Per-panel random nonce; the only way script executes in this webview. */
  nonce: string;
  /** URI of the bundled canvas script (dist/webview/canvas.js). */
  canvasScriptUri: string;
  /** Text of the bundled artifact bootstrap (dist/webview/artifactBootstrap.js), inlined into the iframe srcdoc. */
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
      flex: none;
    }
    #prompt {
      flex: 1; min-width: 0; padding: 6px 8px;
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
    #cancel {
      color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
    }
    /* The free/paid boundary must be visually unambiguous (P4): the one paid
       action on this screen is labeled with its nature, everything else is free. */
    #paid-note { font-size: 11px; opacity: .75; padding: 2px 8px 6px; flex: none; }
    #status { padding: 4px 8px; font-size: 12px; min-height: 1.2em; flex: none; }
    #status.error { color: var(--vscode-errorForeground); }
    /* Viewport preview toggle — purely local, never an API call (P4). */
    #viewport { display: flex; gap: 2px; flex: none; }
    #viewport button {
      color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
      font-size: 12px; padding: 4px 10px;
    }
    #viewport button[aria-pressed="true"] {
      color: var(--vscode-button-foreground); background: var(--vscode-button-background);
    }
    #stage { flex: 1; display: flex; justify-content: center; overflow: auto; min-height: 0; }
    #artifact { width: 100%; height: 100%; border: none; background: #ffffff; flex: none; }
  </style>
</head>
<body>
  <div id="toolbar">
    <input id="prompt" type="text" placeholder="Describe the UI to generate…" aria-label="Design prompt">
    <button id="generate" title="Sends one request to OpenRouter using your key">Generate&nbsp;·&nbsp;paid</button>
    <button id="cancel" disabled>Cancel</button>
    <div id="viewport" role="group" aria-label="Preview width — local, free">
      <button data-width="375" aria-pressed="false" title="375px preview — free, no API call">Mobile</button>
      <button data-width="768" aria-pressed="false" title="768px preview — free, no API call">Tablet</button>
      <button data-width="" aria-pressed="true" title="Full-width preview — free, no API call">Desktop</button>
    </div>
  </div>
  <div id="paid-note">“Generate” makes one paid API request with your OpenRouter key. Everything else on this canvas is local and free.</div>
  <div id="status" role="status"></div>
  <div id="stage">
    <iframe id="artifact" sandbox="allow-scripts" srcdoc="${srcdoc}" title="Generated design artifact"></iframe>
  </div>
  <script nonce="${o.nonce}" src="${o.canvasScriptUri}"></script>
</body>
</html>`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
