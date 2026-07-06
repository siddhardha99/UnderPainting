/**
 * Minimal DOM morphing for the streaming renderer: reconcile the live tree
 * against a freshly parsed snapshot of the accumulated HTML, patching in
 * place instead of reloading (§3: DOM-patch per chunk). Index-based and
 * keyless — sufficient because artifacts are written top-down and streaming
 * only ever appends or completes trailing content.
 */

export function morphChildren(target: Element, source: Element): void {
  const sourceCount = source.childNodes.length;
  for (let i = 0; i < sourceCount; i++) {
    const sourceNode = source.childNodes[i]!;
    const targetNode = target.childNodes[i];
    if (!targetNode) {
      target.appendChild(importInto(target, sourceNode));
      continue;
    }
    if (!isCompatible(targetNode, sourceNode)) {
      target.replaceChild(importInto(target, sourceNode), targetNode);
      continue;
    }
    if (sourceNode.nodeType === Node.TEXT_NODE || sourceNode.nodeType === Node.COMMENT_NODE) {
      if (targetNode.textContent !== sourceNode.textContent) {
        targetNode.textContent = sourceNode.textContent;
      }
    } else if (sourceNode.nodeType === Node.ELEMENT_NODE) {
      patchAttributes(targetNode as Element, sourceNode as Element);
      morphChildren(targetNode as Element, sourceNode as Element);
    }
  }
  while (target.childNodes.length > sourceCount) {
    target.removeChild(target.lastChild!);
  }
}

function isCompatible(a: Node, b: Node): boolean {
  if (a.nodeType !== b.nodeType) return false;
  if (a.nodeType === Node.ELEMENT_NODE) {
    return (a as Element).tagName === (b as Element).tagName;
  }
  return true;
}

function patchAttributes(target: Element, source: Element): void {
  for (const attr of Array.from(source.attributes)) {
    if (target.getAttribute(attr.name) !== attr.value) {
      target.setAttribute(attr.name, attr.value);
    }
  }
  for (const attr of Array.from(target.attributes)) {
    if (!source.hasAttribute(attr.name)) {
      target.removeAttribute(attr.name);
    }
  }
}

/** Always clone into the target document — never move nodes out of the parsed source. */
function importInto(target: Element, node: Node): Node {
  return (target.ownerDocument ?? document).importNode(node, true);
}
