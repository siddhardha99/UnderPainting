// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { findVariationLabels, splitVariations } from '../../src/webview/canvas/splitVariations';

const TWO_VARIATIONS = `<!doctype html>
<html><head><style>:root { --brand: #0ea5e9; }</style></head>
<body>
  <p style="color: var(--brand)">Two directions:</p>
  <section data-variation="A"><h1 style="color: var(--brand)">Electric</h1></section>
  <section data-variation="B"><h1 style="color: var(--brand)">Dreamy</h1></section>
</body></html>`;

describe('variation split (2b) — marker-based, local, free', () => {
  it('finds labels', () => {
    expect(findVariationLabels(TWO_VARIATIONS, new DOMParser())).toEqual(['A', 'B']);
  });

  it('splits into standalone documents, each keeping the shared shell', () => {
    const parts = splitVariations(TWO_VARIATIONS, new DOMParser())!;
    expect(parts.map((p) => p.label)).toEqual(['A', 'B']);
    expect(parts[0]!.html).toContain('Electric');
    expect(parts[0]!.html).not.toContain('Dreamy');
    expect(parts[1]!.html).toContain('Dreamy');
    expect(parts[1]!.html).not.toContain('Electric');
    for (const part of parts) {
      expect(part.html).toMatch(/^<!doctype html>/);
      expect(part.html).toContain('--brand: #0ea5e9;'); // shared style shell survives
      expect(part.html).toContain('Two directions:'); // non-variation content survives
    }
  });

  it('refuses unmarked, single-marked, or nested-marker artifacts', () => {
    expect(splitVariations('<body><section>plain</section></body>', new DOMParser())).toBeNull();
    expect(
      splitVariations('<body><section data-variation="A">only one</section></body>', new DOMParser()),
    ).toBeNull();
    expect(
      splitVariations(
        '<body><div data-variation="A"><div data-variation="B">nested</div></div></body>',
        new DOMParser(),
      ),
    ).toBeNull();
  });
});
