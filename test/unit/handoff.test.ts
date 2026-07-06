import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildHandoffJson,
  buildHandoffMd,
  parseTokenPairs,
  planWrites,
  tokensUsed,
  wrapInBrowserFrame,
  type HandoffInput,
} from '../../src/host/export/handoff';

const TOKENS_CSS = ':root {\n  --brand: #0ea5e9; /* demo-theme.css */\n  --unused: 4px;\n}\n';

const input: HandoffInput = {
  projectSlug: 'main',
  artifactHtml: '<!doctype html><body><h1 style="color: var(--brand)">Hi</h1></body>',
  version: {
    id: 'V2',
    created: '2026-07-06T12:00:00.000Z',
    model: 'test/model',
    costUsd: 0.05,
    promptTokens: 10,
    completionTokens: 20,
    prompt: 'a hero',
    validated: true,
    issues: [],
  },
  history: [
    {
      id: 'V1',
      created: '2026-07-06T11:00:00.000Z',
      model: 'test/model',
      costUsd: 0.04,
      promptTokens: 9,
      completionTokens: 18,
      prompt: 'first try',
      validated: true,
      issues: [],
    },
  ],
  tokensCss: TOKENS_CSS,
  componentsMd: '| Component | File |\n|---|---|\n| Button | src/Button.tsx |',
  extensionVersion: '0.0.1',
};

describe('handoff builders (M1 item 9 — no API call anywhere)', () => {
  it('parses tokens and detects which the artifact consumes', () => {
    const pairs = parseTokenPairs(TOKENS_CSS);
    expect(pairs).toEqual([
      { name: '--brand', value: '#0ea5e9' },
      { name: '--unused', value: '4px' },
    ]);
    expect(tokensUsed(input.artifactHtml, pairs).map((t) => t.name)).toEqual(['--brand']);
  });

  it('handoff.json carries intent history, tokens, validation, and directives', () => {
    const json = JSON.parse(buildHandoffJson(input));
    expect(json.schema_version).toBe(1);
    expect(json.artifact.validated).toBe(true);
    expect(json.intent.prompt).toBe('a hero');
    expect(json.intent.history).toHaveLength(1);
    expect(json.tokens.usedByArtifact).toEqual(['--brand']);
    expect(json.integration.length).toBeGreaterThan(3);
  });

  it('HANDOFF.md includes intent, token table, inventory, and directives', () => {
    const md = buildHandoffMd(input);
    expect(md).toContain('> a hero');
    expect(md).toContain('| `--brand` | `#0ea5e9` | yes |');
    expect(md).toContain('| `--unused` | `4px` | — |');
    expect(md).toContain('component inventory');
    expect(md).toContain('Integration directives');
    expect(md).toContain('passed all authoring-standard checks');
  });

  it('surfaces surviving validation issues in the handoff, never hides them', () => {
    const flawed = {
      ...input,
      version: { ...input.version, validated: false, issues: ['[A1] raw value'] },
    };
    expect(buildHandoffMd(flawed)).toContain('unresolved authoring issues');
    expect(buildHandoffMd(flawed)).toContain('[A1] raw value');
    expect(JSON.parse(buildHandoffJson(flawed)).artifact.validated).toBe(false);
  });

  it('browser-frame wrapping escapes the artifact into srcdoc', () => {
    const frame = fs.readFileSync(path.resolve(__dirname, '../../scaffolds/browser-frame.html'), 'utf8');
    const out = wrapInBrowserFrame(frame, '<p class="x">a "quote" & <b>bold</b></p>', 'demo');
    expect(out).toContain('srcdoc="&lt;p class=&quot;x&quot;&gt;');
    expect(out).not.toContain('{{BODY}}');
    expect(out).not.toContain('{{URL}}');
  });

  it('planWrites classifies new / changed / identical (P9 diff-preview input)', async () => {
    const existing = new Map([
      ['same.html', 'AAA'],
      ['diff.html', 'OLD'],
    ]);
    const plan = await planWrites(
      [
        { relative: 'same.html', content: 'AAA' },
        { relative: 'diff.html', content: 'NEW' },
        { relative: 'fresh.html', content: 'F' },
      ],
      async (rel) => existing.get(rel) ?? null,
    );
    expect(plan.map((p) => p.status)).toEqual(['identical', 'changed', 'new']);
    expect(plan[1]!.existing).toBe('OLD');
  });
});
