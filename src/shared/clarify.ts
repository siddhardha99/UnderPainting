/**
 * Clarify-before-spend (v0.2 item 1): a DETERMINISTIC, LOCAL analysis of the
 * prompt that decides which clarifying questions are worth asking before the
 * paid call. Asking is free by construction — no model is involved (P3/P4).
 *
 * Licensing logic mirrors A6: if the prompt already answers a question
 * ("make it blue" answers color), the field is not asked. One round maximum,
 * always skippable — the form is an offer, never a gate.
 */

export interface ClarifyAnswers {
  artifactType?: 'component' | 'page';
  style?: string;
  colors?: string;
  variations?: number;
  constraints?: string;
}

export type ClarifyField = keyof ClarifyAnswers;

const COMPONENT_WORDS =
  /\b(button|card|form|input|modal|dialog|dropdown|nav(?:bar)?|menu|table|list|badge|toast|tooltip|avatar|slider|toggle|tabs?|accordion|footer|header|sidebar|widget|component)\b/i;
const PAGE_WORDS =
  /\b(page|landing|dashboard|screen|site|website|homepage|portfolio|checkout|onboarding|settings page|pricing page|profile)\b/i;

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
  if (!COMPONENT_WORDS.test(prompt) && !PAGE_WORDS.test(prompt)) {
    fields.push('artifactType');
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
  if (answers.artifactType) lines.push(`Artifact type: ${answers.artifactType}`);
  if (answers.style?.trim()) lines.push(`Style direction: ${answers.style.trim()}`);
  if (answers.colors?.trim()) lines.push(`Brand colors: ${answers.colors.trim()}`);
  if (answers.variations && answers.variations > 1) {
    lines.push(
      `Variations: produce ${answers.variations} distinct labeled variations side by side in this one document`,
    );
  }
  if (answers.constraints?.trim()) lines.push(`Constraints: ${answers.constraints.trim()}`);
  if (lines.length === 0) return prompt;
  return `${prompt}\n\nClarifications from the user (authoritative):\n${lines.map((l) => `- ${l}`).join('\n')}`;
}

/** Drop empty/default answers so the manifest records only real choices. */
export function normalizeAnswers(answers: ClarifyAnswers): ClarifyAnswers | undefined {
  const out: ClarifyAnswers = {};
  if (answers.artifactType) out.artifactType = answers.artifactType;
  if (answers.style?.trim()) out.style = answers.style.trim();
  if (answers.colors?.trim()) out.colors = answers.colors.trim();
  if (answers.variations && answers.variations > 1) out.variations = answers.variations;
  if (answers.constraints?.trim()) out.constraints = answers.constraints.trim();
  return Object.keys(out).length > 0 ? out : undefined;
}
