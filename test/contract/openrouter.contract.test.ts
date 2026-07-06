import { describe, expect, it } from 'vitest';
import { OpenRouterClient, type ModelInfo } from '../../src/host/client/OpenRouterClient';

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

  it('catalog shape: /models parses and carries usable pricing', async () => {
    const models = await client.getModels(CONTRACT_KEY!);
    expect(models.length).toBeGreaterThan(10);
    for (const m of models) {
      expect(m.id.length).toBeGreaterThan(0);
    }
    // Pricing must be present and numeric for a meaningful share of the
    // catalog, or the picker's price display has silently gone blind.
    const priced = models.filter((m) => m.promptPricePerToken !== null);
    expect(priced.length).toBeGreaterThan(models.length / 2);
  });

  it('SSE framing + usage accounting on a tiny live completion', async () => {
    const models = await client.getModels(CONTRACT_KEY!);
    const model = pickCheapestChatModel(models);
    const result = await client.streamChat({
      apiKey: CONTRACT_KEY!,
      model,
      system: 'Reply with the single word: ok',
      user: 'ok?',
      maxTokens: 16,
      signal: AbortSignal.timeout(60_000),
    });
    // Framing: deltas parsed into text.
    expect(result.text.length).toBeGreaterThan(0);
    // Usage accounting fields (usage: {include: true}) — the cost display
    // and ledger depend on exactly these.
    expect(result.promptTokens).not.toBeNull();
    expect(result.completionTokens).not.toBeNull();
    expect(result.costUsd).not.toBeNull();
    expect(result.generationId).not.toBeNull();
  }, 90_000);
});

/** Cheapest completion-priced model; prefers explicitly free variants. */
function pickCheapestChatModel(models: ModelInfo[]): string {
  const free = models.find((m) => m.id.endsWith(':free'));
  if (free) return free.id;
  const priced = models
    .filter((m) => m.promptPricePerToken !== null && m.completionPricePerToken !== null)
    .sort(
      (a, b) =>
        a.promptPricePerToken! + a.completionPricePerToken! - (b.promptPricePerToken! + b.completionPricePerToken!),
    );
  if (priced.length === 0) throw new Error('catalog carried no priced models');
  return priced[0]!.id;
}
