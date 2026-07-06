import { defineConfig } from 'vitest/config';

/**
 * The golden-set eval harness (M1 item 10). Deterministic scoring runs on
 * every PR (`npm run evals`); the live-generation suite inside it activates
 * only with OPENROUTER_EVAL_KEY + OPENROUTER_EVAL_MODEL set (paid, opt-in).
 */
export default defineConfig({
  test: {
    include: ['evals/**/*.test.ts'],
    environment: 'node',
    testTimeout: 240_000,
  },
});
