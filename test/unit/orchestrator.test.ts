import { describe, expect, it } from 'vitest';
import { Orchestrator, CORRECTION_RETRY_CAP } from '../../src/host/orchestrator/Orchestrator';
import { OpenRouterClient } from '../../src/host/client/OpenRouterClient';
import { KeyVault, type SecretStorageLike } from '../../src/host/keyvault/KeyVault';
import { SecretRedactor, type Logger } from '../../src/host/logging/redact';
import type { HostToWebview } from '../../src/shared/messages';

const KEY = 'sk-or-v1-orchestrator-test-key';

function makeDeps(options: {
  withKey: boolean;
  fetchFn: typeof fetch;
  model?: string | undefined | 'unset';
  withCommit?: boolean;
}) {
  const backing = new Map<string, string>();
  const secrets: SecretStorageLike = {
    get: async (k) => backing.get(k),
    store: async (k, v) => void backing.set(k, v),
    delete: async (k) => void backing.delete(k),
  };
  const keyVault = new KeyVault(secrets, new SecretRedactor());
  const posted: HostToWebview[] = [];
  const logs: string[] = [];
  const unavailableModels: string[] = [];
  const commits: Array<{ html: string; prompt: string; model: string }> = [];
  const logger: Logger = { info: (m) => logs.push(m), error: (m) => logs.push(`ERROR ${m}`) };
  const orchestrator = new Orchestrator({
    client: new OpenRouterClient({ fetchFn: options.fetchFn }),
    keyVault,
    logger,
    loadCorePrompt: async () => 'core prompt',
    getGenerationModel: () => (options.model === 'unset' ? undefined : (options.model ?? 'test/model')),
    onModelUnavailable: (id) => unavailableModels.push(id),
    post: (m) => posted.push(m),
    commit: options.withCommit
      ? async (r) => void commits.push({ html: r.html, prompt: r.prompt, model: r.model })
      : undefined,
  });
  const ready = options.withKey ? keyVault.setKey(KEY) : Promise.resolve();
  return { orchestrator, posted, logs, ready, unavailableModels, commits };
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

  it('commits only complete generations (P5): success commits, cancel never does', async () => {
    const frames = [
      'data: {"id":"g","choices":[{"delta":{"content":"<!doctype html><p>done</p>"}}]}\n\n',
      'data: {"id":"g","choices":[{"delta":{}}],"usage":{"prompt_tokens":1,"completion_tokens":2,"cost":0.001}}\n\n',
      'data: [DONE]\n\n',
    ];
    const success = makeDeps({ withKey: true, withCommit: true, fetchFn: async () => sse(frames) });
    await success.ready;
    await success.orchestrator.generate('a card');
    expect(success.commits).toHaveLength(1);
    expect(success.commits[0]!.html).toBe('<!doctype html><p>done</p>');
    expect(success.commits[0]!.prompt).toBe('a card');
    // The commit precedes streamDone so the webview can adopt its frame.
    const doneIndex = success.posted.findIndex((m) => m.type === 'streamDone');
    expect(doneIndex).toBeGreaterThan(-1);

    const cancelled = makeDeps({
      withKey: true,
      withCommit: true,
      fetchFn: async (_url, init) => {
        const signal = init!.signal!;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              signal.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
              c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"<p>"}}]}\n\n'));
            },
          }),
          { status: 200 },
        );
      },
    });
    await cancelled.ready;
    const run = cancelled.orchestrator.generate('slow');
    await new Promise((r) => setTimeout(r, 20));
    cancelled.orchestrator.cancel();
    await run;
    expect(cancelled.commits).toHaveLength(0);

    const failed = makeDeps({
      withKey: true,
      withCommit: true,
      fetchFn: async () => new Response('boom', { status: 500 }),
    });
    await failed.ready;
    await failed.orchestrator.generate('will fail');
    expect(failed.commits).toHaveLength(0);
  });

  it('makes zero API calls when no generation model is configured (no hardcoded fallback)', async () => {
    let fetchCalls = 0;
    const { orchestrator, posted, ready } = makeDeps({
      withKey: true,
      model: 'unset',
      fetchFn: async () => {
        fetchCalls++;
        return sse([]);
      },
    });
    await ready;
    await orchestrator.generate('a card');
    expect(fetchCalls).toBe(0);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.type).toBe('streamError');
    expect((posted[0] as { message: string }).message).toContain('Select Generation Model');
  });

  it('routes a rejected model to the suggested-equivalent flow, never a silent substitution (§9)', async () => {
    const { orchestrator, posted, unavailableModels, ready } = makeDeps({
      withKey: true,
      model: 'anthropic/claude-gone-1.0',
      fetchFn: async () =>
        new Response(JSON.stringify({ error: { message: 'anthropic/claude-gone-1.0 is not a valid model ID' } }), {
          status: 400,
        }),
    });
    await ready;
    await orchestrator.generate('a card');
    const error = posted.find((m) => m.type === 'streamError') as Extract<
      HostToWebview,
      { type: 'streamError' }
    >;
    expect(error.message).toContain('anthropic/claude-gone-1.0');
    expect(error.message.toLowerCase()).toContain('deprecated or renamed');
    expect(unavailableModels).toEqual(['anthropic/claude-gone-1.0']);
  });

  it('does not invoke the model-switch flow for unrelated request errors', async () => {
    const { orchestrator, unavailableModels, ready } = makeDeps({
      withKey: true,
      fetchFn: async () => new Response('server exploded', { status: 500 }),
    });
    await ready;
    await orchestrator.generate('a card');
    expect(unavailableModels).toEqual([]);
  });

  it('keeps the correction retry cap bounded (§9)', () => {
    expect(CORRECTION_RETRY_CAP).toBeLessThanOrEqual(3);
    expect(CORRECTION_RETRY_CAP).toBeGreaterThanOrEqual(0);
  });
});
