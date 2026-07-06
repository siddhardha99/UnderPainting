import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertAllowedUrl, BlockedDestinationError } from '../../src/host/client/allowlist';
import { ENDPOINTS } from '../../src/host/client/OpenRouterClient';

/**
 * Invariant P1: user content leaves the machine only to openrouter.ai, via
 * the single OpenRouterClient module. Enforced twice: a unit check on the
 * allowlist function, and a static scan proving no other module can reach
 * the network at all. Invariant P7 rides along: PRIVACY.md must enumerate
 * every endpoint the client knows about.
 */

const SRC = path.resolve(__dirname, '../../src');
const CLIENT_DIR = path.join('src', 'host', 'client');

describe('P1: hostname allowlist', () => {
  it('permits the OpenRouter API', () => {
    expect(() => assertAllowedUrl('https://openrouter.ai/api/v1/chat/completions')).not.toThrow();
    for (const url of Object.values(ENDPOINTS)) {
      expect(() => assertAllowedUrl(url)).not.toThrow();
    }
  });

  it('blocks every other destination', () => {
    const blocked = [
      'https://example.com/',
      'https://api.openai.com/v1/chat',
      'https://openrouter.ai.evil.com/api', // suffix spoof
      'https://sub.openrouter.ai/api', // subdomains are not allowlisted
      'https://openrouter.ai@evil.com/', // userinfo spoof
    ];
    for (const url of blocked) {
      expect(() => assertAllowedUrl(url), url).toThrow(BlockedDestinationError);
    }
  });

  it('blocks non-https protocols even to the allowed host', () => {
    expect(() => assertAllowedUrl('http://openrouter.ai/api')).toThrow(BlockedDestinationError);
    expect(() => assertAllowedUrl('ws://openrouter.ai/api')).toThrow(BlockedDestinationError);
  });
});

describe('P1: no network surface outside src/host/client/', () => {
  const networkPatterns: Array<[string, RegExp]> = [
    ['fetch call', /\bfetch\s*\(/],
    ['XMLHttpRequest', /\bXMLHttpRequest\b/],
    ['WebSocket', /\bnew\s+WebSocket\b/],
    ['EventSource', /\bnew\s+EventSource\b/],
    ['node http(s) import', /from\s+['"](?:node:)?https?['"]|require\(\s*['"](?:node:)?https?['"]\s*\)/],
    ['node net/tls/dgram import', /from\s+['"](?:node:)?(?:net|tls|dgram)['"]/],
    ['third-party http client', /['"](?:undici|axios|node-fetch|got|ws)['"]/],
  ];

  it('finds no network primitives in any module outside the client', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(path.resolve(__dirname, '../..'), file);
      if (rel.startsWith(CLIENT_DIR)) continue;
      const text = fs.readFileSync(file, 'utf8');
      for (const [label, pattern] of networkPatterns) {
        if (pattern.test(text)) {
          offenders.push(`${rel}: ${label}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the client itself only knows openrouter.ai URLs', () => {
    for (const url of Object.values(ENDPOINTS)) {
      expect(new URL(url).hostname).toBe('openrouter.ai');
    }
  });
});

describe('P7: PRIVACY.md enumerates the full network surface', () => {
  it('mentions every endpoint the client can call', () => {
    const privacy = fs.readFileSync(path.resolve(__dirname, '../../PRIVACY.md'), 'utf8');
    for (const url of Object.values(ENDPOINTS)) {
      const endpointPath = new URL(url).pathname;
      expect(privacy, `PRIVACY.md must document ${endpointPath}`).toContain(endpointPath);
    }
  });
});

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
      yield full;
    }
  }
}
