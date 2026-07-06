import { morphChildren } from './morph';

/**
 * Applies a (possibly partial) artifact HTML string to the live iframe DOM.
 *
 * Model output is hostile (P6). The real security boundaries are the iframe
 * sandbox (opaque origin, no allow-same-origin) and the inherited webview CSP
 * (no network, scripts require a nonce the artifact never sees). On top of
 * those, this renderer sanitizes as defense in depth: script/embedding
 * elements, event-handler attributes, and javascript: URLs are stripped
 * before the markup ever joins the document. M0 artifacts are static by
 * design; how legitimate artifact scripts will run in later milestones is
 * recorded in docs/OPEN_QUESTIONS.md.
 */

const FORBIDDEN_ELEMENTS = 'script, iframe, frame, object, embed, base, meta, link';

export interface ArtifactHost {
  /** Container for <style> blocks the artifact declares in <head>. */
  styleHost: Element;
  /** Container the artifact's <body> children are morphed into. */
  root: Element;
}

export function applyArtifactHtml(host: ArtifactHost, html: string, parser: DOMParser): void {
  const doc = parser.parseFromString(html, 'text/html');
  sanitize(doc);

  // The artifact's single permitted <style> block (authoring standard A1)
  // arrives in <head>; keep it applied by morphing head styles into a hidden
  // container. <link>s were removed by sanitize — artifacts are self-contained (A3).
  const headStyles = doc.createElement('div');
  for (const el of Array.from(doc.head.children)) {
    if (el.tagName === 'STYLE') headStyles.appendChild(el);
  }
  morphChildren(host.styleHost, headStyles);
  morphChildren(host.root, doc.body);
}

export function resetArtifact(host: ArtifactHost): void {
  host.styleHost.textContent = '';
  host.root.textContent = '';
}

export function sanitize(doc: Document): void {
  for (const el of Array.from(doc.querySelectorAll(FORBIDDEN_ELEMENTS))) {
    el.remove();
  }
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
      } else if (
        (name === 'href' || name === 'src' || name === 'xlink:href' || name === 'action' || name === 'formaction') &&
        /^\s*(javascript|vbscript|data:text\/html)/i.test(attr.value)
      ) {
        el.removeAttribute(attr.name);
      }
    }
  }
}
