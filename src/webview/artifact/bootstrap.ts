import { applyArtifactHtml, resetArtifact, type ArtifactHost } from './artifactDom';

/**
 * Runs inside the sandboxed artifact iframe (opaque origin, inherited strict
 * CSP). It receives {type:'patch', html} messages from the canvas script and
 * morphs the accumulated HTML into the live DOM — the streaming renderer.
 * It never posts anything back and holds no capabilities worth stealing.
 */

const styleHost = document.createElement('div');
styleHost.id = 'artifact-styles';
styleHost.hidden = true;
const root = document.createElement('div');
root.id = 'artifact-root';
document.body.appendChild(styleHost);
document.body.appendChild(root);

const host: ArtifactHost = { styleHost, root };
const parser = new DOMParser();

window.addEventListener('message', (event: MessageEvent) => {
  const data: unknown = event.data;
  if (typeof data !== 'object' || data === null) return;
  const message = data as { type?: unknown; html?: unknown };
  if (message.type === 'reset') {
    resetArtifact(host);
    return;
  }
  if (message.type === 'patch' && typeof message.html === 'string') {
    applyArtifactHtml(host, message.html, parser);
  }
});
