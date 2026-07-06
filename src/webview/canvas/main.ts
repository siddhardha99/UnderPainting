import {
  hostToWebviewSchema,
  webviewToHostSchema,
  type WebviewToHost,
} from '../../shared/messages';

/**
 * Canvas chrome script. Holds no credentials — the host never sends any (P2)
 * — and performs no network I/O (P1; the webview CSP has no connect-src).
 * Both directions of the bus are zod-validated (P6).
 */

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();

const promptInput = document.getElementById('prompt') as HTMLInputElement;
const generateButton = document.getElementById('generate') as HTMLButtonElement;
const cancelButton = document.getElementById('cancel') as HTMLButtonElement;
const statusLine = document.getElementById('status') as HTMLDivElement;
const artifactFrame = document.getElementById('artifact') as HTMLIFrameElement;

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

function postToArtifact(message: { type: 'patch'; html: string } | { type: 'reset' }): void {
  // The iframe has an opaque origin (sandbox without allow-same-origin), so
  // the target origin is necessarily '*'; the payload is only artifact HTML.
  artifactFrame.contentWindow?.postMessage(message, '*');
}

window.addEventListener('message', (event: MessageEvent) => {
  // Only the extension host talks to this window; anything unparseable is dropped.
  if (event.source === artifactFrame.contentWindow) return;
  const parsed = hostToWebviewSchema.safeParse(event.data);
  if (!parsed.success) return;
  const message = parsed.data;

  switch (message.type) {
    case 'keyState':
      if (!message.present) {
        setStatus('No API key set — run “Underpainting: Set OpenRouter API Key”. The canvas stays read-only until then.');
      }
      break;
    case 'streamStart':
      setGenerating(true);
      setStatus('Generating…');
      postToArtifact({ type: 'reset' });
      break;
    case 'streamChunk':
      postToArtifact({ type: 'patch', html: message.html });
      break;
    case 'streamDone': {
      setGenerating(false);
      const cost =
        message.costUsd !== null ? `$${message.costUsd.toFixed(4)}` : 'cost unavailable';
      const tokens =
        message.promptTokens !== null && message.completionTokens !== null
          ? ` (${message.promptTokens} prompt + ${message.completionTokens} completion tokens)`
          : '';
      setStatus(`This generation: ${cost}${tokens}`);
      break;
    }
    case 'streamCancelled':
      setGenerating(false);
      setStatus('Cancelled — the stream was aborted.');
      break;
    case 'streamError':
      setGenerating(false);
      setStatus(message.message, true);
      break;
  }
});

generateButton.addEventListener('click', () => {
  const prompt = promptInput.value.trim();
  if (!prompt) {
    setStatus('Type a prompt first.');
    return;
  }
  // This click is the explicit user action behind the API call (P3).
  send({ type: 'generate', prompt });
});

cancelButton.addEventListener('click', () => send({ type: 'cancel' }));

promptInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !generateButton.disabled) {
    generateButton.click();
  }
});

send({ type: 'ready' });
