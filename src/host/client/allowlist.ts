/**
 * The network allowlist (invariant P1). This module and its sole consumer,
 * OpenRouterClient, are the only place in the codebase allowed to touch the
 * network — enforced by lint (eslint.config.mjs) and by static scan
 * (test/invariants/allowlist.test.ts). Never widen this list.
 */

export const ALLOWED_HOSTNAMES: ReadonlySet<string> = new Set(['openrouter.ai']);

export class BlockedDestinationError extends Error {}

/** Throws unless the URL is https and its hostname is exactly allowlisted. */
export function assertAllowedUrl(url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') {
    throw new BlockedDestinationError(
      `Blocked network request: protocol ${parsed.protocol} is not allowed (https only).`,
    );
  }
  if (!ALLOWED_HOSTNAMES.has(parsed.hostname)) {
    throw new BlockedDestinationError(
      `Blocked network request to ${parsed.hostname}: the only permitted destination is openrouter.ai.`,
    );
  }
  return parsed;
}
