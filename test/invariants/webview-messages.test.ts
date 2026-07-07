import { describe, expect, it } from 'vitest';
import { hostToWebviewSchema, webviewToHostSchema } from '../../src/shared/messages';
import { createHostPoster } from '../../src/host/canvas/poster';
import { SecretRedactor } from '../../src/host/logging/redact';

/**
 * Invariant P2/P6: the webview never sees the key, and both directions of
 * the bus reject anything outside the declared contract. Schemas are strict,
 * so a message smuggling extra fields (an apiKey, say) fails validation
 * instead of being forwarded.
 */

const FAKE_KEY = 'sk-or-v1-TESTSECRET-abcdef1234567890';

const validHostMessages = [
  { type: 'keyState', present: true },
  { type: 'streamStart' },
  { type: 'streamChunk', html: '<p>hi</p>' },
  { type: 'streamDone', costUsd: 0.041, promptTokens: 900, completionTokens: 1800 },
  { type: 'streamCancelled' },
  { type: 'streamError', message: 'boom' },
] as const;

describe('P6: host→webview schema is strict', () => {
  it('accepts every declared message shape', () => {
    for (const message of validHostMessages) {
      expect(hostToWebviewSchema.safeParse(message).success, message.type).toBe(true);
    }
  });

  it('rejects every declared shape once an undeclared field rides along', () => {
    for (const message of validHostMessages) {
      const smuggling = { ...message, apiKey: FAKE_KEY };
      expect(hostToWebviewSchema.safeParse(smuggling).success, message.type).toBe(false);
    }
  });

  it('rejects unknown message types outright', () => {
    expect(hostToWebviewSchema.safeParse({ type: 'sendKey', key: FAKE_KEY }).success).toBe(false);
  });
});

describe('P6: webview→host schema is strict', () => {
  it('accepts declared shapes and rejects extras and unknowns', () => {
    expect(webviewToHostSchema.safeParse({ type: 'generate', prompt: 'a card' }).success).toBe(true);
    expect(
      webviewToHostSchema.safeParse({ type: 'generate', prompt: 'a card', apiKey: FAKE_KEY }).success,
    ).toBe(false);
    expect(webviewToHostSchema.safeParse({ type: 'exfiltrate' }).success).toBe(false);
    expect(webviewToHostSchema.safeParse({ type: 'generate', prompt: '' }).success).toBe(false);
  });
});

describe('P2: the host poster is a validated, redacting choke point', () => {
  it('refuses to post anything that fails the schema', () => {
    const posted: unknown[] = [];
    const post = createHostPoster((m) => posted.push(m), new SecretRedactor());
    expect(() =>
      post({ type: 'streamStart', apiKey: FAKE_KEY } as never),
    ).toThrow();
    expect(posted).toEqual([]);
  });

  it('redacts key material from every string field before posting', () => {
    const posted: unknown[] = [];
    const redactor = new SecretRedactor();
    redactor.register(FAKE_KEY);
    const post = createHostPoster((m) => posted.push(m), redactor);
    post({ type: 'streamError', message: `upstream said: ${FAKE_KEY}` });
    expect(JSON.stringify(posted)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(posted)).toContain('[REDACTED]');
  });
});

describe('P6: runCommand is a closed enum, never arbitrary commands', () => {
  it('accepts only allowlisted Underpainting commands', () => {
    expect(
      webviewToHostSchema.safeParse({ type: 'runCommand', command: 'underpainting.setApiKey' }).success,
    ).toBe(true);
    for (const hostile of [
      'workbench.action.terminal.new',
      'workbench.action.files.save',
      'underpainting.notARealCommand',
      'vscode.open',
    ]) {
      expect(
        webviewToHostSchema.safeParse({ type: 'runCommand', command: hostile }).success,
        hostile,
      ).toBe(false);
    }
  });
});
