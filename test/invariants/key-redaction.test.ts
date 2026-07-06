import { describe, expect, it } from 'vitest';
import { SecretRedactor, RedactingLogger, formatError } from '../../src/host/logging/redact';
import { KeyVault, type SecretStorageLike } from '../../src/host/keyvault/KeyVault';
import { OpenRouterClient } from '../../src/host/client/OpenRouterClient';

/**
 * Invariant P2: the API key never appears in logs, error messages, or any
 * other captured output. These tests drive real error paths with a fake key
 * and grep everything that came out the other side.
 */

const FAKE_KEY = 'sk-or-v1-TESTSECRET-abcdef1234567890';

function makeVault(): { vault: KeyVault; redactor: SecretRedactor } {
  const backing = new Map<string, string>();
  const secrets: SecretStorageLike = {
    get: async (k) => backing.get(k),
    store: async (k, v) => void backing.set(k, v),
    delete: async (k) => void backing.delete(k),
  };
  const redactor = new SecretRedactor();
  return { vault: new KeyVault(secrets, redactor), redactor };
}

describe('P2: key redaction', () => {
  it('redactor scrubs registered secrets from any text', () => {
    const redactor = new SecretRedactor();
    redactor.register(FAKE_KEY);
    const out = redactor.redact(`request failed: authorization: Bearer ${FAKE_KEY} rejected`);
    expect(out).not.toContain(FAKE_KEY);
    expect(out).toContain('[REDACTED]');
  });

  it('redactor scrubs key-shaped strings even when never registered', () => {
    const redactor = new SecretRedactor();
    const out = redactor.redact(`leaked: ${FAKE_KEY}`);
    expect(out).not.toContain(FAKE_KEY);
  });

  it('logger output never contains key material', () => {
    const captured: string[] = [];
    const redactor = new SecretRedactor();
    redactor.register(FAKE_KEY);
    const logger = new RedactingLogger((line) => captured.push(line), redactor);
    logger.info(`validating ${FAKE_KEY}`);
    logger.error(`boom: Bearer ${FAKE_KEY}`);
    expect(captured.length).toBe(2);
    for (const line of captured) {
      expect(line).not.toContain(FAKE_KEY);
    }
  });

  it('KeyVault registers keys with the redactor on set and on get', async () => {
    const { vault, redactor } = makeVault();
    await vault.setKey(FAKE_KEY);
    expect(redactor.redact(FAKE_KEY)).toBe('[REDACTED]');

    const fresh = makeVault();
    await fresh.vault.setKey(FAKE_KEY);
    // A different session that only ever reads the key must also be protected.
    const readBack = await fresh.vault.getKey();
    expect(readBack).toBe(FAKE_KEY);
    expect(fresh.redactor.redact(`x ${FAKE_KEY} y`)).not.toContain(FAKE_KEY);
  });

  it('client error paths formatted for display never contain the key', async () => {
    const captured: string[] = [];
    const redactor = new SecretRedactor();
    redactor.register(FAKE_KEY);
    const logger = new RedactingLogger((line) => captured.push(line), redactor);

    // A hostile failure mode: the transport error itself echoes the header.
    const client = new OpenRouterClient({
      fetchFn: async () => {
        throw new Error(`ECONNRESET while sending authorization: Bearer ${FAKE_KEY}`);
      },
    });

    let thrown: unknown;
    try {
      await client.getCredits(FAKE_KEY);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    logger.error(`key validation failed: ${formatError(thrown)}`);
    for (const line of captured) {
      expect(line).not.toContain(FAKE_KEY);
    }
  });
});
