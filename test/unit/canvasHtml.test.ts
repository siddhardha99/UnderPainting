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
    expect(group![0]).toContain('data-width="1280"');
    // Exactly one width is active by default.
    expect(group![0].match(/aria-pressed="true"/g)!.length).toBe(1);
  });

  it('offers zoom and fit controls (local/free, P4)', () => {
    for (const id of ['zoom-in', 'zoom-out', 'zoom-fit', 'zoom-level']) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('labels the free/paid boundary unambiguously (P4)', () => {
    expect(html).toContain('Send&nbsp;·&nbsp;paid');
    expect(html).toContain('local and free');
  });

  it('shows the active model + pricing at the point of spend (item-1 follow-up)', () => {
    expect(html).toContain('id="model-note"');
  });

  it('ships the direct-edit toggle labeled as local and free (M1 item 4, P4)', () => {
    const button = html.match(/<button id="edit-text"[^>]*>/);
    expect(button).not.toBeNull();
    expect(button![0]).toContain('free');
    expect(button![0]).toContain('no API call');
  });

  it('ships the chat sidebar with the new/refine mode toggle (M1 item 3)', () => {
    for (const id of ['chat', 'chat-log', 'mode-new', 'mode-refine', 'prompt', 'generate', 'cancel']) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('ships the frame board and the frame clone template', () => {
    expect(html).toContain('id="board"');
    expect(html).toContain('<template id="frame-template"');
    expect(html.match(/<iframe/g)!.length).toBe(1); // only the template's
  });
});
