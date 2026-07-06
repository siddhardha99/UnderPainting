// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { spliceTextEdit } from '../../src/webview/canvas/spliceText';

/**
 * Direct text edits (M1 item 4, P4/A2): deterministic source splices that
 * never round-trip through the model. The path resolves over childNodes from
 * <body>; `before` must match exactly or the splice fails closed.
 */

const doc =
  '<!doctype html>\n<html><head><style>:root { --x: red; }</style></head>' +
  '<body><h1 style="color: var(--x)">Title</h1><div><p>first</p><p>second</p></div></body></html>';

describe('spliceTextEdit', () => {
  const parser = new DOMParser();

  it('replaces exactly one leaf text and preserves everything else', () => {
    // body.childNodes: [h1, div]; div.childNodes: [p, p]
    const out = spliceTextEdit(doc, [1, 1], 'second', 'renamed', parser);
    expect(out).not.toBeNull();
    expect(out!).toContain('<p>renamed</p>');
    expect(out!).toContain('<p>first</p>');
    expect(out!).toContain('color: var(--x)');
    expect(out!).toContain(':root { --x: red; }');
    expect(out!.startsWith('<!doctype html>')).toBe(true);
  });

  it('fails closed when the before-text does not match the resolved node', () => {
    expect(spliceTextEdit(doc, [1, 1], 'WRONG', 'renamed', parser)).toBeNull();
  });

  it('fails closed on unresolvable or non-element paths', () => {
    expect(spliceTextEdit(doc, [9, 9], 'x', 'y', parser)).toBeNull();
    expect(spliceTextEdit('<body>plain text</body>', [0], 'plain text', 'y', parser)).toBeNull(); // text node, not element
  });

  it('escapes edited text on serialization (markup typed by the user stays text)', () => {
    const out = spliceTextEdit(doc, [0], 'Title', '<script>alert(1)</script> & more', parser);
    expect(out).not.toBeNull();
    expect(out!).not.toContain('<script>alert(1)</script>');
    expect(out!).toContain('&lt;script&gt;');
    expect(out!).toContain('&amp; more');
  });
});
