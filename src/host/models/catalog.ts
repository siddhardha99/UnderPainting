import type { ModelInfo } from '../client/OpenRouterClient';

/**
 * Pure model-catalog helpers (no vscode, no network): pricing display for
 * the picker, and the deprecation → suggested-equivalent ranking (§9: a
 * one-click switch offered to the user, never a silent substitution).
 */

/** "$3.00/M" style display for a per-token USD price. */
export function formatPricePerMTok(perToken: number | null): string {
  if (perToken === null) return 'price n/a';
  const perM = perToken * 1_000_000;
  if (perM === 0) return 'free';
  const digits = perM >= 100 ? 0 : perM >= 1 ? 2 : 3;
  return `$${perM.toFixed(digits)}/M`;
}

/** One-line pricing + context summary shown in the model picker. */
export function formatModelDetail(model: ModelInfo): string {
  const parts = [
    `in ${formatPricePerMTok(model.promptPricePerToken)}`,
    `out ${formatPricePerMTok(model.completionPricePerToken)}`,
  ];
  if (model.contextLength !== null) {
    parts.push(`${Math.round(model.contextLength / 1000)}k context`);
  }
  return parts.join(' · ');
}

/**
 * Rank catalog models by similarity to a model that OpenRouter no longer
 * accepts: same provider weighs most, shared name words (family, tier) weigh
 * more than shared numeric version fragments — the successor in the same
 * family is a better equivalent than a different family at the same version.
 * Returns [] when nothing is plausibly related — an empty suggestion list is
 * better than a random one.
 */
export function suggestEquivalents(
  models: ModelInfo[],
  missingId: string,
  limit = 5,
): ModelInfo[] {
  const missingProvider = providerOf(missingId);
  const missingSegments = new Set(segmentsOf(missingId));

  return models
    .filter((m) => m.id !== missingId)
    .map((m) => {
      let score = 0;
      if (missingProvider && providerOf(m.id) === missingProvider) score += 3;
      for (const segment of new Set(segmentsOf(m.id))) {
        if (missingSegments.has(segment)) {
          score += /^\d+$/.test(segment) ? 1 : 2;
        }
      }
      return { model: m, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.model.id.localeCompare(b.model.id))
    .slice(0, limit)
    .map((s) => s.model);
}

function providerOf(id: string): string | null {
  const slash = id.indexOf('/');
  return slash > 0 ? id.slice(0, slash) : null;
}

function segmentsOf(id: string): string[] {
  return id
    .toLowerCase()
    .split(/[/:.\-_]+/)
    .filter((s) => s.length > 0);
}
