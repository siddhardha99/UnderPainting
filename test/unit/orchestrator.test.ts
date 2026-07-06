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
  groundingTokens?: string;
  validationModel?: string;
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
  const commits: Array<{
    html: string;
    prompt: string;
    model: string;
    clarifications?: unknown;
    size?: { width: number; height: number };
  }> = [];
  const spends: Array<{ kind: string; model: string; costUsd: number | null }> = [];
  const logger: Logger = { info: (m) => logs.push(m), error: (m) => logs.push(`ERROR ${m}`) };
  const orchestrator = new Orchestrator({
    client: new OpenRouterClient({ fetchFn: options.fetchFn }),
    keyVault,
    logger,
    loadCorePrompt: async () => 'core prompt',
    loadRefineRecipe: async () => 'refine recipe',
    loadGroundingPreamble: async () => 'grounding preamble',
    loadCorrectionRecipe: async () => 'correction recipe',
    loadGroundingTokens: async () => options.groundingTokens ?? null,
    getValidationModel: () => options.validationModel,
    getGenerationModel: () => (options.model === 'unset' ? undefined : (options.model ?? 'test/model')),
    onModelUnavailable: (id) => unavailableModels.push(id),
    post: (m) => posted.push(m),
    commit: options.withCommit
      ? async (r) =>
          void commits.push({
            html: r.html,
            prompt: r.prompt,
            model: r.model,
            ...(r.clarifications ? { clarifications: r.clarifications } : {}),
            ...(r.size ? { size: r.size } : {}),
          })
      : undefined,
    recordSpend: (r) => spends.push({ kind: r.kind, model: r.model, costUsd: r.costUsd }),
  });
  const ready = options.withKey ? keyVault.setKey(KEY) : Promise.resolve();
  return { orchestrator, posted, logs, ready, unavailableModels, commits, spends };
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

  it('folds clarify answers into the request and records them in the commit (v0.2 item 1)', async () => {
    const users: string[] = [];
    const { orchestrator, commits, ready } = makeDeps({
      withKey: true,
      withCommit: true,
      fetchFn: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        users.push(JSON.parse(String(init!.body)).messages[1].content);
        return sse(['data: {"choices":[{"delta":{"content":"<p>x</p>"}}]}\n\n', 'data: [DONE]\n\n']);
      }) as typeof fetch,
    });
    await ready;
    await orchestrator.generate('a card', { style: 'minimal', variations: 2 });
    expect(users[0]).toContain('a card');
    expect(users[0]).toContain('Clarifications from the user (authoritative):');
    expect(users[0]).toContain('Style direction: minimal');
    // The resolved target rides with the answers ("a card" → component) and
    // the commit carries the design-time viewport (2b revision).
    expect(commits[0]!.clarifications).toEqual({ style: 'minimal', variations: 2, target: 'component' });
    expect(commits[0]!.size).toEqual({ width: 800, height: 600 });
    expect(users[0]).toContain('Target: a single component on a canvas');
    expect(commits[0]!.prompt).toBe('a card'); // original prompt, not the folded one
  });

  it('grounds the system prompt in workspace tokens when they exist (M1 item 5)', async () => {
    const systems: string[] = [];
    const fetchFn = async (_url: RequestInfo | URL, init?: RequestInit) => {
      systems.push(JSON.parse(String(init!.body)).messages[0].content);
      return sse(['data: [DONE]\n\n']);
    };
    const grounded = makeDeps({
      withKey: true,
      groundingTokens: ':root { --brand: #123456; }',
      fetchFn: fetchFn as typeof fetch,
    });
    await grounded.ready;
    await grounded.orchestrator.generate('a card');
    expect(systems[0]).toContain('core prompt');
    expect(systems[0]).toContain('grounding preamble');
    expect(systems[0]).toContain('--brand: #123456;');

    const ungrounded = makeDeps({ withKey: true, fetchFn: fetchFn as typeof fetch });
    await ungrounded.ready;
    await ungrounded.orchestrator.generate('a card');
    expect(systems[1]).toBe('core prompt'); // no grounding section at all
  });

  it('refine sends core+recipe as system, artifact-as-data + instruction as user (A7/§8)', async () => {
    const requests: Array<{ system: string; user: string }> = [];
    const frames = [
      'data: {"id":"g","choices":[{"delta":{"content":"<!doctype html><p>v2</p>"}}],"usage":{"cost":0.002}}\n\n',
      'data: [DONE]\n\n',
    ];
    const { orchestrator, commits, ready } = makeDeps({
      withKey: true,
      withCommit: true,
      fetchFn: async (_url, init) => {
        const body = JSON.parse(String(init!.body));
        requests.push({ system: body.messages[0].content, user: body.messages[1].content });
        return sse(frames);
      },
    });
    await ready;
    await orchestrator.refine('make the heading blue', '<!doctype html><p>v1</p>');

    expect(requests[0]!.system).toBe('core prompt\n\nrefine recipe');
    expect(requests[0]!.user).toContain('<<<ARTIFACT\n<!doctype html><p>v1</p>\nARTIFACT>>>');
    expect(requests[0]!.user).toContain('Instruction: make the heading blue');
    // The version metadata records the instruction, not the artifact payload.
    expect(commits[0]!.prompt).toBe('make the heading blue');
    expect(commits[0]!.html).toBe('<!doctype html><p>v2</p>');
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

  it('runs the bounded correction loop on the validation model and sums exact costs (M1 item 6)', async () => {
    const INVALID = '<!doctype html><html><head><style>:root { --ink: #111; }</style></head>' +
      '<body><p style="color: #ff0000">raw</p></body></html>';
    const FIXED = INVALID.replace('color: #ff0000', 'color: var(--ink)');
    const calls: Array<{ model: string; system: string }> = [];
    const { orchestrator, posted, commits, ready, spends } = makeDeps({
      withKey: true,
      withCommit: true,
      validationModel: 'cheap/fixer',
      fetchFn: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init!.body));
        calls.push({ model: body.model, system: body.messages[0].content });
        const text = body.model === 'cheap/fixer' ? FIXED : INVALID;
        return sse([
          `data: {"id":"g${calls.length}","choices":[{"delta":{"content":${JSON.stringify(text)}}}],"usage":{"prompt_tokens":10,"completion_tokens":20,"cost":0.01}}\n\n`,
          'data: [DONE]\n\n',
        ]);
      }) as typeof fetch,
    });
    await ready;
    await orchestrator.generate('a card');

    expect(calls.map((c) => c.model)).toEqual(['test/model', 'cheap/fixer']);
    // Ledger hook: one record per request, corrections recorded separately (item 8).
    expect(spends).toEqual([
      { kind: 'generation', model: 'test/model', costUsd: 0.01 },
      { kind: 'correction', model: 'cheap/fixer', costUsd: 0.01 },
    ]);
    // Correction pass runs on its own minimal recipe, not the core prompt (§8).
    expect(calls[1]!.system).toBe('correction recipe');
    expect(commits[0]!.html).toBe(FIXED);
    const done = posted.find((m) => m.type === 'streamDone') as Extract<HostToWebview, { type: 'streamDone' }>;
    expect(done.costUsd).toBeCloseTo(0.02); // exact sum across passes
    const validation = posted.find((m) => m.type === 'validation') as Extract<HostToWebview, { type: 'validation' }>;
    expect(validation.correctionPasses).toBe(1);
    expect(validation.issues).toEqual([]);
  });

  it('caps corrections and surfaces surviving issues, never silently accepting (§7/§9)', async () => {
    const INVALID = '<!doctype html><html><head><style>:root { --ink: #111; }</style></head>' +
      '<body><p style="color: #ff0000">raw</p></body></html>';
    let calls = 0;
    const { orchestrator, posted, commits, ready } = makeDeps({
      withKey: true,
      withCommit: true,
      validationModel: 'cheap/fixer',
      fetchFn: (async () => {
        calls++;
        return sse([
          `data: {"choices":[{"delta":{"content":${JSON.stringify(INVALID)}}}],"usage":{"cost":0.01}}\n\n`,
          'data: [DONE]\n\n',
        ]);
      }) as typeof fetch,
    });
    await ready;
    await orchestrator.generate('a card');

    expect(calls).toBe(1 + CORRECTION_RETRY_CAP); // hard cap: generation + 2 corrections
    const validation = posted.find((m) => m.type === 'validation') as Extract<HostToWebview, { type: 'validation' }>;
    expect(validation.issues.length).toBeGreaterThan(0);
    expect(commits[0]).toBeDefined(); // still committed — the user paid for it
  });

  it('skips corrections entirely when no validation model is configured', async () => {
    const INVALID = '<!doctype html><html><head><style>:root { --x: 1; }</style></head>' +
      '<body><p style="color: #ff0000">raw</p></body></html>';
    let calls = 0;
    const { orchestrator, posted, ready } = makeDeps({
      withKey: true,
      withCommit: true,
      fetchFn: (async () => {
        calls++;
        return sse([
          `data: {"choices":[{"delta":{"content":${JSON.stringify(INVALID)}}}]}\n\n`,
          'data: [DONE]\n\n',
        ]);
      }) as typeof fetch,
    });
    await ready;
    await orchestrator.generate('a card');
    expect(calls).toBe(1); // no correction spend without an explicit model choice
    const validation = posted.find((m) => m.type === 'validation') as Extract<HostToWebview, { type: 'validation' }>;
    expect(validation.issues.length).toBeGreaterThan(0);
  });

  it('keeps the correction retry cap bounded (§9)', () => {
    expect(CORRECTION_RETRY_CAP).toBeLessThanOrEqual(3);
    expect(CORRECTION_RETRY_CAP).toBeGreaterThanOrEqual(0);
  });
});
