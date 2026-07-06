/**
 * Variation split (v0.2 item 2b): a multi-variation artifact — sections
 * marked `data-variation="…"` per the clarify fold — slices into standalone
 * documents, one per variation, each keeping the full head/style shell.
 * Deterministic, marker-based only (no guessing at unmarked layouts), local
 * and free. Older artifacts without markers simply aren't splittable.
 */

export interface VariationPart {
  label: string;
  html: string;
}

export function findVariationLabels(html: string, parser: DOMParser): string[] {
  const doc = parser.parseFromString(html, 'text/html');
  return [...doc.querySelectorAll('[data-variation]')]
    .map((el) => el.getAttribute('data-variation') ?? '')
    .filter((label) => label.length > 0);
}

/** Returns null unless the artifact carries 2–4 marked variations. */
export function splitVariations(html: string, parser: DOMParser): VariationPart[] | null {
  const doc = parser.parseFromString(html, 'text/html');
  const sections = [...doc.querySelectorAll('[data-variation]')];
  if (sections.length < 2 || sections.length > 4) return null;
  // Nested markers would double-split; require siblings-ish independence.
  if (sections.some((s) => sections.some((other) => other !== s && other.contains(s)))) return null;

  const hasDoctype = /^\s*<!doctype/i.test(html);
  return sections.map((section) => {
    const clone = parser.parseFromString(html, 'text/html');
    for (const el of [...clone.querySelectorAll('[data-variation]')]) {
      if (el.getAttribute('data-variation') !== section.getAttribute('data-variation')) {
        el.remove();
      }
    }
    return {
      label: section.getAttribute('data-variation') ?? 'untitled',
      html: (hasDoctype ? '<!doctype html>\n' : '') + clone.documentElement.outerHTML,
    };
  });
}
