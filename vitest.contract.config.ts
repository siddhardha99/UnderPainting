import { defineConfig } from 'vitest/config';

/**
 * Contract tests run against the LIVE OpenRouter API on a nightly schedule
 * (.github/workflows/nightly-contract.yml) — never as part of the per-PR
 * suite. They require the OPENROUTER_CONTRACT_KEY environment variable and
 * skip themselves cleanly without it.
 */
export default defineConfig({
  test: {
    include: ['test/contract/**/*.test.ts'],
    environment: 'node',
    testTimeout: 90_000,
  },
});
