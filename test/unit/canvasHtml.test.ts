import { describe, expect, it } from 'vitest';
import { buildCanvasHtml } from '../../src/host/canvas/canvasHtml';

const html = buildCanvasHtml({
  cspSource: 'https://mock.test',
  nonce: 'N',
  canvasScriptUri: 'https://mock.test/canvas.js',
  bootstrapJs: '/*js*/',
});

describe('canvas chrome', () => {
  it('the post-hoc viewport toggle is gone — size is a design-time property (2b revision)', () => {
    expect(html).not.toContain('id="viewport"');
    expect(html).toContain('data-value="mobile"'); // target choices live in the clarify form
    expect(html).toContain('390×844');
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
    for (const field of ['target', 'style', 'colors', 'variations', 'constraints']) {
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

describe('actions menu', () => {
  it('offers every setup/tool command from the UI, labeled by cost nature', () => {
    for (const cmd of ['setApiKey', 'selectGenerationModel', 'selectValidationModel', 'extractDesignSystem', 'showCostLedger', 'exportDesign']) {
      expect(html).toContain(`data-command="underpainting.${cmd}"`);
    }
    expect(html).toContain('<div id="actions-menu" hidden');
    expect(html.match(/fetches catalog/g)!.length).toBe(2); // the two paid-ish entries are labeled
  });
});

describe('Select/Interact mode (2c)', () => {
  it('ships the mode toggle, Select active by default', () => {
    const group = html.match(/<div id="interaction"[\s\S]*?<\/div>/)![0];
    expect(group).toContain('id="mode-select"');
    expect(group).toContain('id="mode-interact"');
    expect(group.match(/aria-pressed="true"/g)!.length).toBe(1);
    expect(group).toMatch(/id="mode-select"[^>]*aria-pressed="true"/);
  });

  it('gates artifact pointer events on interact mode (Select falls through to selection)', () => {
    expect(html).toContain('#surface:not(.interact) .frame-clip iframe { pointer-events: none; }');
    expect(html).toContain('#surface.interact .frame.selected .frame-clip iframe { pointer-events: auto; }');
  });
});
