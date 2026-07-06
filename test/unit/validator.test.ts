import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  validateArtifact,
  refinementSurvivalRatio,
  isRedesignInstruction,
} from '../../src/host/validator/Validator';

/**
 * Validator v1 (M1 item 6): §7 authoring standards as deterministic checks.
 * The golden baselines double as real-world regression inputs.
 */

const VALID = `<!doctype html>
<html lang="en">
<head>
<style>
:root { --bg: #ffffff; --ink: #111827; --accent: #0ea5e9; --space-4: 16px; }
@font-face { font-family: X; src: url(data:font/woff2;base64,AA==); }
@keyframes fade { from { opacity: 0; } to { opacity: 1; } }
* { margin: 0; box-sizing: border-box; }
body { background: var(--bg); }
</style>
</head>
<body style="background: var(--bg); padding: var(--space-4)">
  <h1 style="color: var(--ink); font-size: var(--space-4)">Title</h1>
  <p style="color: var(--ink)">One clean paragraph.</p>
  <img src="data:image/gif;base64,R0lGOD" width="40" height="40" alt="dot" style="width: 40px; height: 40px">
</body>
</html>`;

function rules(html: string): string[] {
  return validateArtifact(html).map((i) => i.rule);
}

describe('validateArtifact — clean artifacts pass', () => {
  it('accepts a compliant document', () => {
    expect(validateArtifact(VALID)).toEqual([]);
  });

  it('accepts the grounded golden baseline (real generation)', () => {
    const grounded = fs.readFileSync(
      path.resolve(__dirname, '../../evals/golden/inkwell-pricing/baselines/m1-grounded.html'),
      'utf8',
    );
    const found = rules(grounded);
    // A real model output may trip content rules; it must not trip the
    // security-relevant ones.
    expect(found).not.toContain('scripts');
    expect(found).not.toContain('A3');
  });
});

describe('validateArtifact — §7 violations are caught', () => {
  it('structure: missing doctype', () => {
    expect(rules(VALID.replace('<!doctype html>\n', ''))).toContain('structure');
  });

  it('A1: second style block', () => {
    expect(rules(VALID.replace('</body>', '<style>.x{}</style></body>'))).toContain('A1');
  });

  it('A1: class rule inside the style block', () => {
    expect(rules(VALID.replace('* { margin: 0', '.card { margin: 0'))).toContain('A1');
  });

  it('A1: raw color in an inline style', () => {
    expect(rules(VALID.replace('color: var(--ink)', 'color: #ff0000'))).toContain('A1');
    expect(rules(VALID.replace('color: var(--ink)', 'color: rgb(255, 0, 0)'))).toContain('A1');
  });

  it('A1: tolerates structural values without tokens', () => {
    const structural = VALID.replace('padding: var(--space-4)', 'padding: 0').replace(
      'font-size: var(--space-4)',
      'margin: 0 auto',
    );
    expect(rules(structural)).toEqual([]);
  });

  it('scripts: any <script> is rejected in v0.1 (ADR-002)', () => {
    expect(rules(VALID.replace('</body>', '<script>1</script></body>'))).toContain('scripts');
  });

  it('A3: external references', () => {
    expect(rules(VALID.replace('</head>', '<link rel="stylesheet" href="https://cdn.x/y.css"></head>'))).toContain('A3');
    expect(rules(VALID.replace('data:image/gif;base64,R0lGOD', 'https://evil.example/x.png'))).toContain('A3');
    expect(rules(VALID.replace('url(data:font/woff2;base64,AA==)', 'url(https://fonts.example/f.woff2)'))).toContain('A3');
  });

  it('A2: text mixed with child elements', () => {
    expect(
      rules(VALID.replace('<p style="color: var(--ink)">One clean paragraph.</p>', '<p style="color: var(--ink)">Hello <b>world</b></p>')),
    ).toContain('A2');
  });

  it('A4: image without explicit dimensions (attrs or style both count)', () => {
    const stripped = VALID.replace(' width="40" height="40"', '').replace(
      ' style="width: 40px; height: 40px"',
      '',
    );
    expect(rules(stripped)).toContain('A4');
    // Dimensions via style alone are fine.
    expect(rules(VALID.replace(' width="40" height="40"', ''))).toEqual([]);
  });

  it('the hostile fixture NEVER validates (gates the scripts-enabled commit path)', () => {
    const hostile = fs.readFileSync(path.resolve(__dirname, '../fixtures/hostile-artifact.html'), 'utf8');
    const found = rules(hostile);
    expect(found).toContain('scripts');
    expect(found).toContain('A3');
  });
});

describe('A7 refinement minimality', () => {
  const base = Array.from({ length: 20 }, (_, i) => `<p style="color: var(--ink)">line ${i}</p>`).join('\n');

  it('a targeted edit scores high survival', () => {
    const refined = base.replace('line 3', 'renamed 3');
    expect(refinementSurvivalRatio(base, refined)).toBeGreaterThan(0.9);
  });

  it('a rewrite scores low survival', () => {
    const rewrite = Array.from({ length: 20 }, (_, i) => `<div style="padding: var(--s)">new ${i}</div>`).join('\n');
    expect(refinementSurvivalRatio(base, rewrite)).toBeLessThan(0.1);
  });

  it('redesign instructions are exempt', () => {
    expect(isRedesignInstruction('Redesign this page with a dark theme')).toBe(true);
    expect(isRedesignInstruction('start over from scratch')).toBe(true);
    expect(isRedesignInstruction('make the heading blue')).toBe(false);
  });
});
