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

  it('ships the clarify form, hidden by default, with per-field visibility hooks (v0.2 item 1)', () => {
    expect(html).toContain('<div id="clarify" hidden>');
    for (const field of ['artifactType', 'style', 'colors', 'variations', 'constraints']) {
      expect(html).toContain(`data-field="${field}"`);
    }
    expect(html).toContain('id="clarify-skip"'); // always skippable, one click
    expect(html).toContain('local &amp; free; only Generate spends'); // P4 labeling
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

describe('present mode (v0.2 item 2a)', () => {
  it('ships the overlay, hidden by default, with position + hint chrome', () => {
    expect(html).toContain('<div id="present-overlay" hidden>');
    for (const id of ['present-bar', 'present-title', 'present-pos', 'present-stage', 'present-close']) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('labels present as local and free with the keyboard affordances (P4)', () => {
    const button = html.match(/<button id="present-button"[^>]*>/)![0];
    expect(button).toContain('free');
    expect(button).toContain('Esc');
    expect(html).toContain('←/→ versions');
  });

  it('adds no iframe outside the template (the present iframe clones at runtime)', () => {
    expect(html.match(/<iframe/g)!.length).toBe(1);
  });
});

describe('infinite canvas (v0.2 item 2b)', () => {
  it('ships the viewport/surface pair and the 100% zoom control', () => {
    expect(html).toContain('<div id="surface"');
    expect(html).toContain('id="zoom-100"');
    expect(html).toContain('pan with space-drag');
  });

  it('ships the split button in the frame template, hidden by default', () => {
    const template = html.match(/<template id="frame-template"[\s\S]*?<\/template>/)![0];
    expect(template).toContain('class="split"');
    expect(template).toMatch(/class="split" hidden/);
  });
});
