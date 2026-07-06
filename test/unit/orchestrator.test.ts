import { describe, expect, it } from 'vitest';
import { Orchestrator, CORRECTION_RETRY_CAP } from '../../src/host/orchestrator/Orchestrator';
import { OpenRouterClient } from '../../src/host/client/OpenRouterClient';
import { KeyVault, type SecretStorageLike } from '../../src/host/keyvault/KeyVault';
import { SecretRedactor, type Logger } from '../../src/host/logging/redact';
import type { HostToWebview } from '../../src/shared/messages';

const KEY = 'sk-or-v1-orchestrator-test-key';

function makeDeps(options: { withKey: boolean; fetchFn: typeof fetch }) {
  const backing = new Map<string, string>();
  const secrets: SecretStorageLike = {
    get: async (k) => backing.get(k),
    store: async (k, v) => void backing.set(k, v),
    delete: async (k) => void backing.delete(k),
  };
  const keyVault = new KeyVault(secrets, new SecretRedactor());
  const posted: HostToWebview[] = [];
  const logs: string[] = [];
  const logger: Logger = { info: (m) => logs.push(m), error: (m) => logs.push(`ERROR ${m}`) };
  const orchestrator = new Orchestrator({
    client: new OpenRouterClient({ fetchFn: options.fetchFn }),
    keyVault,
    logger,
    loadCorePrompt: async () => 'core prompt',
    post: (m) => posted.push(m),
  });
  const ready = options.withKey ? keyVault.setKey(KEY) : Promise.resolve();
  return { orchestrator, posted, logs, ready };
}

function sse(frames: string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        for (const f of frames) c.enqueue(enc.encode(f));
        c.close();
      },
    }),
    { status: 200 },
  );
}

describe('Orchestrator (P3: user money, explicit actions only)', () => {
  it('makes zero API calls when no key is set, and says how to fix it', async () => {
    let fetchCalls = 0;
    const { orchestrator, posted, ready } = makeDeps({
      withKey: false,
      fetchFn: async () => {
        fetchCalls++;
        return sse([]);
      },
    });
    await ready;
    await orchestrator.generate('a pricing card');
    expect(fetchCalls).toBe(0);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.type).toBe('streamError');
    expect((posted[0] as { message: string }).message).toContain('Set OpenRouter API Key');
  });

  it('streams, then reports the exact cost from OpenRouter accounting', async () => {
    const frames = [
      'data: {"id":"gen-9","choices":[{"delta":{"content":"<!doctype html><p>x</p>"}}]}\n\n',
      'data: {"id":"gen-9","choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":20,"cost":0.005}}\n\n',
      'data: [DONE]\n\n',
    ];
    const { orchestrator, posted, logs, ready } = makeDeps({
      withKey: true,
      fetchFn: async () => sse(frames),
    });
    await ready;
    await orchestrator.generate('a card');

    expect(posted[0]!.type).toBe('streamStart');
    const done = posted.find((m) => m.type === 'streamDone') as Extract<
      HostToWebview,
      { type: 'streamDone' }
    >;
    expect(done.costUsd).toBeCloseTo(0.005);
    const lastChunk = [...posted].reverse().find((m) => m.type === 'streamChunk') as Extract<
      HostToWebview,
      { type: 'streamChunk' }
    >;
    expect(lastChunk.html).toBe('<!doctype html><p>x</p>');
    expect(logs.join('\n')).toContain('$0.0050');
  });

  it('refuses to run two generations at once instead of double-spending', async () => {
    let resolveFirst: (() => void) | undefined;
    const gate = new Promise<void>((r) => (resolveFirst = r));
    let fetchCalls = 0;
    const { orchestrator, posted, ready } = makeDeps({
      withKey: true,
      fetchFn: async () => {
        fetchCalls++;
        await gate;
        return sse(['data: [DONE]\n\n']);
      },
    });
    await ready;
    const first = orchestrator.generate('one');
    await new Promise((r) => setTimeout(r, 10));
    await orchestrator.generate('two');
    expect(fetchCalls).toBe(1);
    expect(posted.some((m) => m.type === 'streamError' && m.message.includes('already running'))).toBe(true);
    resolveFirst!();
    await first;
  });

  it('reports a cancelled stream as cancelled, not as an error', async () => {
    const { orchestrator, posted, ready } = makeDeps({
      withKey: true,
      fetchFn: async (_url, init) => {
        const signal = init!.signal!;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              signal.addEventListener('abort', () =>
                c.error(new DOMException('aborted', 'AbortError')),
              );
              c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"<p>"}}]}\n\n'));
            },
          }),
          { status: 200 },
        );
      },
    });
    await ready;
    const run = orchestrator.generate('slow thing');
    await new Promise((r) => setTimeout(r, 20));
    orchestrator.cancel();
    await run;
    expect(posted.some((m) => m.type === 'streamCancelled')).toBe(true);
    expect(posted.some((m) => m.type === 'streamError')).toBe(false);
  });

  it('keeps the correction retry cap bounded (§9)', () => {
    expect(CORRECTION_RETRY_CAP).toBeLessThanOrEqual(3);
    expect(CORRECTION_RETRY_CAP).toBeGreaterThanOrEqual(0);
  });
});
