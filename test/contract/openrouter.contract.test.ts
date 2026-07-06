import { describe, expect, it } from 'vitest';
import { OpenRouterClient } from '../../src/host/client/OpenRouterClient';

/**
 * Live-API contract tests (brief §12 item 5): an API-drift tripwire, run
 * nightly, never per-PR. Uses the real OpenRouterClient so what we test is
 * exactly what ships. Requires OPENROUTER_CONTRACT_KEY (a dedicated
 * low-credit key); the whole suite skips without it.
 */

const CONTRACT_KEY = process.env['OPENROUTER_CONTRACT_KEY'];
const liveSuite = CONTRACT_KEY ? describe : describe.skip;

liveSuite('OpenRouter API contract (live, nightly)', () => {
  const client = new OpenRouterClient();

  it('credits accounting: /credits returns numeric totals', async () => {
    const credits = await client.getCredits(CONTRACT_KEY!);
    expect(Number.isFinite(credits.totalCredits)).toBe(true);
    expect(Number.isFinite(credits.totalUsage)).toBe(true);
    expect(Number.isFinite(credits.remaining)).toBe(true);
  });

  // Catalog-shape and SSE-framing/usage-field contracts are added alongside
  // the model catalog (M1 item 1), which provides getModels() so the tiny
  // test completion can pick the cheapest live model instead of hardcoding
  // a model ID.
});
