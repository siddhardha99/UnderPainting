import tseslint from 'typescript-eslint';

// The load-bearing part of this config is the network-surface ban (invariant P1):
// no module outside src/host/client/ may reach the network by any means.
// test/invariants/allowlist.test.ts enforces the same rule by static scan, so a
// misconfigured lint run cannot silently drop the invariant.
const NETWORK_GLOBALS = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'];
const NETWORK_MODULES = [
  'http', 'https', 'net', 'tls', 'dgram', 'dns',
  'node:http', 'node:https', 'node:net', 'node:tls', 'node:dgram', 'node:dns',
  'undici', 'axios', 'node-fetch', 'got', 'ws',
];

export default [
  { ignores: ['dist/**', 'out-test/**', 'node_modules/**', '**/*.mjs', '.vscode-test/**'] },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
    },
    rules: {
      'no-restricted-globals': ['error', ...NETWORK_GLOBALS],
      'no-restricted-imports': ['error', { paths: NETWORK_MODULES }],
    },
  },
  {
    // The single permitted fetch surface (invariant P1).
    files: ['src/host/client/**/*.ts'],
    rules: {
      'no-restricted-globals': 'off',
    },
  },
  {
    // Tests may stub network primitives to prove they are never hit.
    files: ['test/**/*.ts'],
    rules: {
      'no-restricted-globals': 'off',
    },
  },
];
