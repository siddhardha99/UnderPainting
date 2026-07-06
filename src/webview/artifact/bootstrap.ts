import { applyArtifactHtml, resetArtifact, type ArtifactHost } from './artifactDom';

/**
 * Runs inside the sandboxed artifact iframe (opaque origin, inherited strict
 * CSP). It receives {type:'patch', html} messages from the canvas script and
 * morphs the accumulated HTML into the live DOM — the streaming renderer.
 *
 * Edit mode (M1 item 4): the canvas can toggle {type:'editMode'}; text-leaf
 * elements become contenteditable and each finished edit posts a
 * {type:'textEdit', path, text} message up — a purely local interaction,
 * never an API call (P4). This bootstrap is the only script that can run
 * here (nonce'd), and it holds no capabilities worth stealing.
 */

const styleHost = document.createElement('div');
styleHost.id = 'artifact-styles';
styleHost.hidden = true;
const root = document.createElement('div');
root.id = 'artifact-root';
const editStyle = document.createElement('style');
document.head.appendChild(editStyle);
document.body.appendChild(styleHost);
document.body.appendChild(root);

const host: ArtifactHost = { styleHost, root };
const parser = new DOMParser();
let editMode = false;
const originals = new WeakMap<Element, string>();

/** A2's editability structure: a leaf whose children are all text is one editable text run. */
function isTextLeaf(el: Element): boolean {
  if (el.childNodes.length === 0) return false;
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType !== Node.TEXT_NODE) return false;
  }
  return (el.textContent ?? '').trim().length > 0;
}

function markEditableLeaves(): void {
  for (const el of Array.from(root.querySelectorAll('*'))) {
    if (editMode && isTextLeaf(el)) {
      el.setAttribute('contenteditable', 'plaintext-only');
    } else {
      el.removeAttribute('contenteditable');
    }
  }
}

function setEditMode(enabled: boolean): void {
  editMode = enabled;
  editStyle.textContent = enabled
    ? '[contenteditable]:hover { outline: 1px dashed rgba(64,128,255,.8); outline-offset: 1px; }' +
      '[contenteditable]:focus { outline: 2px solid rgba(64,128,255,.9); outline-offset: 1px; }'
    : '';
  markEditableLeaves();
}

/** childNodes index path from the artifact root — resolvable on a reparse of the same HTML. */
function pathFromRoot(target: Node): number[] {
  const path: number[] = [];
  let node: Node = target;
  while (node !== root && node.parentNode) {
    path.unshift(Array.prototype.indexOf.call(node.parentNode.childNodes, node));
    node = node.parentNode;
  }
  return path;
}

root.addEventListener('focusin', (event) => {
  const el = event.target as Element;
  if (editMode && el instanceof Element && el.hasAttribute('contenteditable')) {
    originals.set(el, el.textContent ?? '');
  }
});

root.addEventListener('focusout', (event) => {
  const el = event.target as Element;
  if (!editMode || !(el instanceof Element) || !el.hasAttribute('contenteditable')) return;
  const before = originals.get(el);
  const after = el.textContent ?? '';
  if (before !== undefined && before !== after) {
    window.parent.postMessage(
      { type: 'textEdit', path: pathFromRoot(el), before, text: after },
      '*',
    );
  }
});

window.addEventListener('message', (event: MessageEvent) => {
  const data: unknown = event.data;
  if (typeof data !== 'object' || data === null) return;
  const message = data as { type?: unknown; html?: unknown; enabled?: unknown };
  if (message.type === 'reset') {
    resetArtifact(host);
    return;
  }
  if (message.type === 'patch' && typeof message.html === 'string') {
    applyArtifactHtml(host, message.html, parser);
    if (editMode) markEditableLeaves();
    return;
  }
  if (message.type === 'editMode' && typeof message.enabled === 'boolean') {
    setEditMode(message.enabled);
  }
});
