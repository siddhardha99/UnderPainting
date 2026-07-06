import { describe, expect, it } from 'vitest';
import {
  formatPricePerMTok,
  formatModelDetail,
  suggestEquivalents,
} from '../../src/host/models/catalog';
import type { ModelInfo } from '../../src/host/client/OpenRouterClient';

function model(id: string, overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id,
    name: null,
    contextLength: null,
    promptPricePerToken: null,
    completionPricePerToken: null,
    ...overrides,
  };
}

describe('formatPricePerMTok', () => {
  it('converts per-token USD to a per-million display', () => {
    expect(formatPricePerMTok(0.000003)).toBe('$3.00/M');
    expect(formatPricePerMTok(0.000000123)).toBe('$0.123/M');
    expect(formatPricePerMTok(0.00025)).toBe('$250/M');
  });

  it('labels free and unknown pricing honestly', () => {
    expect(formatPricePerMTok(0)).toBe('free');
    expect(formatPricePerMTok(null)).toBe('price n/a');
  });
});

describe('formatModelDetail', () => {
  it('shows in/out pricing and context', () => {
    const detail = formatModelDetail(
      model('a/b', {
        promptPricePerToken: 0.000003,
        completionPricePerToken: 0.000015,
        contextLength: 200_000,
      }),
    );
    expect(detail).toBe('in $3.00/M · out $15.00/M · 200k context');
  });

  it('omits context when the catalog does not state it', () => {
    expect(formatModelDetail(model('a/b'))).toBe('in price n/a · out price n/a');
  });
});

describe('suggestEquivalents (deprecation → one-click switch, §9)', () => {
  const catalog = [
    model('anthropic/claude-sonnet-4.6'),
    model('anthropic/claude-opus-4-8'),
    model('anthropic/claude-haiku-4.5'),
    model('openai/gpt-5'),
    model('meta-llama/llama-4-scout'),
  ];

  it('ranks the same family and version-adjacent model first', () => {
    const suggested = suggestEquivalents(catalog, 'anthropic/claude-sonnet-4.5');
    expect(suggested[0]!.id).toBe('anthropic/claude-sonnet-4.6');
    // Same provider always outranks other providers.
    const providers = suggested.map((m) => m.id.split('/')[0]);
    expect(providers.slice(0, 3)).toEqual(['anthropic', 'anthropic', 'anthropic']);
  });

  it('never suggests the missing model itself', () => {
    const suggested = suggestEquivalents(
      [model('anthropic/claude-sonnet-4.5'), ...catalog],
      'anthropic/claude-sonnet-4.5',
    );
    expect(suggested.map((m) => m.id)).not.toContain('anthropic/claude-sonnet-4.5');
  });

  it('returns an empty list rather than unrelated suggestions', () => {
    expect(suggestEquivalents(catalog, 'zzz/unrelated-thing')).toEqual([]);
  });

  it('respects the limit', () => {
    expect(suggestEquivalents(catalog, 'anthropic/claude-sonnet-4.5', 2)).toHaveLength(2);
  });
});
