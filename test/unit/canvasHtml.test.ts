import { describe, expect, it } from 'vitest';
import { buildCanvasHtml } from '../../src/host/canvas/canvasHtml';

const html = buildCanvasHtml({
  cspSource: 'https://mock.test',
  nonce: 'N',
  canvasScriptUri: 'https://mock.test/canvas.js',
  bootstrapJs: '/*js*/',
});

describe('canvas chrome', () => {
  it('offers the three viewport preview widths (local/free, P4)', () => {
    const group = html.match(/<div id="viewport"[\s\S]*?<\/div>/);
    expect(group).not.toBeNull();
    expect(group![0]).toContain('data-width="375"');
    expect(group![0]).toContain('data-width="768"');
    expect(group![0]).toContain('data-width=""');
    // Exactly one width is active by default.
    expect(group![0].match(/aria-pressed="true"/g)!.length).toBe(1);
  });

  it('labels the free/paid boundary unambiguously (P4)', () => {
    expect(html).toContain('Generate&nbsp;·&nbsp;paid');
    expect(html).toContain('local and free');
  });

  it('keeps a single artifact iframe inside the stage', () => {
    expect(html.match(/<iframe/g)!.length).toBe(1);
  });
});
