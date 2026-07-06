import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/invariants/**/*.test.ts', 'test/unit/**/*.test.ts'],
    environment: 'node',
  },
});
