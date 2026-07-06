import { describe, expect, it } from 'vitest';
import { extractHtml } from '../../src/host/orchestrator/extractHtml';

describe('extractHtml', () => {
  const doc = '<!doctype html><html><body><p>hi</p></body></html>';

  it('passes clean documents through untouched', () => {
    expect(extractHtml(doc)).toBe(doc);
  });

  it('strips a surrounding markdown fence', () => {
    expect(extractHtml('```html\n' + doc + '\n```')).toBe(doc + '\n');
    expect(extractHtml('```\n' + doc + '\n```\n')).toBe(doc + '\n');
  });

  it('is safe on a partially streamed fence line', () => {
    expect(extractHtml('```ht')).toBe('');
  });

  it('drops leading prose before the document', () => {
    expect(extractHtml('Here is your design:\n\n' + doc)).toBe(doc);
  });

  it('returns empty for buffers with no markup yet', () => {
    expect(extractHtml('Sure, I will')).toBe('');
    expect(extractHtml('')).toBe('');
  });

  it('does not strip a fence that is still mid-document', () => {
    const partial = '<!doctype html><body><pre>```';
    expect(extractHtml(partial)).toBe('<!doctype html><body><pre>');
    // Known tradeoff: a trailing fence-like token inside <pre> is trimmed
    // mid-stream and restored on the next chunk once content follows it.
    const later = partial + 'code```</pre>';
    expect(extractHtml(later)).toContain('```code```');
  });
});
