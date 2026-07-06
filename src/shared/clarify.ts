/**
 * Clarify-before-spend (v0.2 item 1): a DETERMINISTIC, LOCAL analysis of the
 * prompt that decides which clarifying questions are worth asking before the
 * paid call. Asking is free by construction — no model is involved (P3/P4).
 *
 * Licensing logic mirrors A6: if the prompt already answers a question
 * ("make it blue" answers color), the field is not asked. One round maximum,
 * always skippable — the form is an offer, never a gate.
 */

import { describeTarget, detectTarget, type TargetKind } from './targetSize';

export interface ClarifyAnswers {
  /** Target viewport (2b revision): a design-time property, not a preview toggle. */
  target?: TargetKind;
  style?: string;
  colors?: string;
  variations?: number;
  constraints?: string;
}

export type ClarifyField = keyof ClarifyAnswers;

const COLOR_WORDS =
  /#[0-9a-f]{3,8}\b|\b(blue|red|green|purple|violet|pink|orange|teal|cyan|yellow|amber|indigo|sky|slate|gray|grey|black|white|monochrome|pastel|neon|dark mode|light mode|colorful)\b/i;

const STYLE_WORDS =
  /\b(minimal(?:ist)?|clean|bold|playful|corporate|professional|elegant|luxurious|brutalist|retro|vintage|modern|futuristic|hand-drawn|editorial|technical|friendly|serious|calm|energetic|glassmorphic|neumorphic|flat|skeuomorphic)\b/i;

const VARIATION_WORDS = /\b(\d+|two|three)\s+(variations?|options?|versions?|alternatives?|directions?)\b/i;

/**
 * Which fields the form should ASK — i.e. the prompt does not already answer
 * them. `groundingTokensPresent` suppresses the color question entirely: an
 * extracted/generated design system is the color answer (§7 A1).
 */
export function fieldsToAsk(prompt: string, groundingTokensPresent: boolean): ClarifyField[] {
  const fields: ClarifyField[] = [];
  if (detectTarget(prompt) === null) {
    fields.push('target');
  }
  if (!STYLE_WORDS.test(prompt)) {
    fields.push('style');
  }
  if (!groundingTokensPresent && !COLOR_WORDS.test(prompt)) {
    fields.push('colors');
  }
  if (!VARIATION_WORDS.test(prompt)) {
    fields.push('variations');
  }
  fields.push('constraints'); // never inferable; always offered, always optional
  return fields;
}

/**
 * Fold answers into the generation request as an authoritative addendum.
 * The original prompt stays untouched in the version metadata; answers are
 * recorded separately for reproducibility.
 */
export function foldClarifications(prompt: string, answers: ClarifyAnswers): string {
  const lines: string[] = [];
  if (answers.target) lines.push(`Target: ${describeTarget(answers.target)}`);
  if (answers.style?.trim()) lines.push(`Style direction: ${answers.style.trim()}`);
  if (answers.colors?.trim()) lines.push(`Brand colors: ${answers.colors.trim()}`);
  if (answers.variations && answers.variations > 1) {
    lines.push(
      `Variations: produce ${answers.variations} distinct variations side by side in this one document. ` +
        `Wrap each variation's entire markup in its own top-level <section data-variation="A"> (then "B", "C"…) ` +
        `with a visible label — the canvas can then split them into separate frames.`,
    );
  }
  if (answers.constraints?.trim()) lines.push(`Constraints: ${answers.constraints.trim()}`);
  if (lines.length === 0) return prompt;
  return `${prompt}\n\nClarifications from the user (authoritative):\n${lines.map((l) => `- ${l}`).join('\n')}`;
}

/** Drop empty/default answers so the manifest records only real choices. */
export function normalizeAnswers(answers: ClarifyAnswers): ClarifyAnswers | undefined {
  const out: ClarifyAnswers = {};
  if (answers.target) out.target = answers.target;
  if (answers.style?.trim()) out.style = answers.style.trim();
  if (answers.colors?.trim()) out.colors = answers.colors.trim();
  if (answers.variations && answers.variations > 1) out.variations = answers.variations;
  if (answers.constraints?.trim()) out.constraints = answers.constraints.trim();
  return Object.keys(out).length > 0 ? out : undefined;
}
