import { describe, expect, it } from 'vitest';
import { fieldsToAsk, foldClarifications, normalizeAnswers } from '../../src/shared/clarify';

/**
 * Clarify-before-spend (v0.2 item 1): deterministic, local, free. The
 * licensing rule mirrors A6 — a prompt that answers a question suppresses
 * its field. The golden clarify-form case gates the same logic in evals.
 */

describe('fieldsToAsk — ask only what the prompt leaves unanswered', () => {
  it('"make it blue" style prompts suppress the color question', () => {
    expect(fieldsToAsk('A deep blue pricing page', false)).not.toContain('colors');
    expect(fieldsToAsk('use #ff6b35 as the accent for a card', false)).not.toContain('colors');
  });

  it('an extracted/generated design system suppresses the color question entirely', () => {
    expect(fieldsToAsk('a hero for our product page', true)).not.toContain('colors');
    expect(fieldsToAsk('a hero for our product page', false)).toContain('colors');
  });

  it('artifact-type words suppress the type question', () => {
    expect(fieldsToAsk('a signup button', false)).not.toContain('artifactType');
    expect(fieldsToAsk('a landing page for Inkwell', false)).not.toContain('artifactType');
    expect(fieldsToAsk('something for our launch', false)).toContain('artifactType');
  });

  it('style adjectives and variation counts suppress their fields', () => {
    expect(fieldsToAsk('a minimalist dashboard', false)).not.toContain('style');
    expect(fieldsToAsk('3 variations of a nav bar', false)).not.toContain('variations');
  });

  it('constraints is always offered — it can never be inferred answered', () => {
    expect(fieldsToAsk('3 variations of a bold red minimalist signup button', false)).toEqual(['constraints']);
  });
});

describe('foldClarifications — answers become an authoritative addendum', () => {
  it('folds only real answers and leaves the prompt itself untouched', () => {
    const folded = foldClarifications('a card', {
      artifactType: 'component',
      style: 'minimal, calm',
      variations: 2,
    });
    expect(folded.startsWith('a card\n\nClarifications from the user (authoritative):')).toBe(true);
    expect(folded).toContain('- Artifact type: component');
    expect(folded).toContain('- Style direction: minimal, calm');
    expect(folded).toContain('2 distinct variations');
    expect(folded).toContain('data-variation="A"');
    expect(folded).not.toContain('Brand colors');
  });

  it('no answers → the prompt passes through unchanged', () => {
    expect(foldClarifications('a card', {})).toBe('a card');
    expect(foldClarifications('a card', { variations: 1, style: '  ' })).toBe('a card');
  });
});

describe('normalizeAnswers — the manifest records only real choices', () => {
  it('drops empties and defaults; returns undefined when nothing was chosen', () => {
    expect(normalizeAnswers({ style: '  ', variations: 1 })).toBeUndefined();
    expect(normalizeAnswers({ colors: ' #0ea5e9 ' })).toEqual({ colors: '#0ea5e9' });
  });
});
