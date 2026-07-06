/**
 * Applies a direct text edit to artifact SOURCE (M1 item 4): reparse the
 * snapshot, resolve the same childNodes index path the bootstrap computed on
 * its live DOM, replace only that leaf's text, serialize. Deterministic and
 * local — a text edit never round-trips through the model (P4/A2).
 *
 * The live DOM was sanitized before rendering while the source here is not,
 * so a path could theoretically desync on artifacts that carried stripped
 * elements. `before` closes that hole: the resolved leaf must contain
 * exactly the text the user started editing, or the edit is dropped (null)
 * rather than applied to the wrong node. Fail closed, never guess.
 */
export function spliceTextEdit(
  html: string,
  path: readonly number[],
  before: string,
  text: string,
  parser: DOMParser,
): string | null {
  const doc = parser.parseFromString(html, 'text/html');
  let node: Node | undefined = doc.body;
  for (const index of path) {
    node = node?.childNodes[index];
    if (!node) return null;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as Element;
  if (el.textContent !== before) return null;
  el.textContent = text;
  const hasDoctype = /^\s*<!doctype/i.test(html);
  return (hasDoctype ? '<!doctype html>\n' : '') + doc.documentElement.outerHTML;
}
