import { describe, expect, it } from 'vitest';
import {
  OpenRouterClient,
  KeyRejectedError,
  HttpError,
  TRANSIENT_RETRY_CAP,
  type FetchFn,
} from '../../src/host/client/OpenRouterClient';

const KEY = 'sk-or-v1-unit-test-key-000000';

function sseResponse(frames: string[], options: { delayMs?: number; signal?: AbortSignal } = {}): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index >= frames.length) {
        controller.close();
        return;
      }
      if (options.delayMs) {
        await new Promise((r) => setTimeout(r, options.delayMs));
      }
      controller.enqueue(encoder.encode(frames[index++]!));
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('OpenRouterClient.streamChat', () => {
  it('accumulates deltas and reads cost from the final usage frame', async () => {
    const frames = [
      'data: {"id":"gen-123","choices":[{"delta":{"content":"<!doctype html>"}}]}\n\n',
      'data: {"id":"gen-123","choices":[{"delta":{"content":"<p>hi</p>"}}]}\n\n',
      'data: {"id":"gen-123","choices":[{"delta":{}}],"usage":{"prompt_tokens":12,"completion_tokens":34,"cost":0.0417}}\n\n',
      'data: [DONE]\n\n',
    ];
    const client = new OpenRouterClient({ fetchFn: async () => sseResponse(frames) });
    const seen: string[] = [];
    const result = await client.streamChat({
      apiKey: KEY,
      model: 'test/model',
      system: 'sys',
      user: 'usr',
      signal: new AbortController().signal,
      onDelta: (acc) => seen.push(acc),
    });
    expect(result.text).toBe('<!doctype html><p>hi</p>');
    expect(result.costUsd).toBeCloseTo(0.0417);
    expect(result.promptTokens).toBe(12);
    expect(result.completionTokens).toBe(34);
    expect(result.generationId).toBe('gen-123');
    expect(seen).toEqual(['<!doctype html>', '<!doctype html><p>hi</p>']);
  });

  it('sends the request with streaming and usage accounting enabled, to the allowlisted URL only', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchFn: FetchFn = async (url, init) => {
      captured = { url: String(url), init: init! };
      return sseResponse(['data: [DONE]\n\n']);
    };
    const client = new OpenRouterClient({ fetchFn });
    await client.streamChat({
      apiKey: KEY,
      model: 'test/model',
      system: 's',
      user: 'u',
      signal: new AbortController().signal,
    });
    expect(captured!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(String(captured!.init.body));
    expect(body.stream).toBe(true);
    expect(body.usage).toEqual({ include: true });
    expect(body.messages).toHaveLength(2);
  });

  it('stops within 1 second when the signal aborts mid-stream (§9)', async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    // An endless stream that, like real fetch, errors its reader on abort.
    const fetchFn: FetchFn = async (_url, init) => {
      const signal = init!.signal!;
      const stream = new ReadableStream<Uint8Array>({
        start(streamController) {
          const timer = setInterval(() => {
            streamController.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'));
          }, 20);
          signal.addEventListener('abort', () => {
            clearInterval(timer);
            streamController.error(new DOMException('The operation was aborted.', 'AbortError'));
          });
        },
      });
      return new Response(stream, { status: 200 });
    };
    const client = new OpenRouterClient({ fetchFn });
    const started = Date.now();
    const pending = client.streamChat({
      apiKey: KEY,
      model: 'test/model',
      system: 's',
      user: 'u',
      signal: controller.signal,
      onDelta: (acc) => {
        if (acc.length >= 3) controller.abort();
      },
    });
    await expect(pending).rejects.toThrow();
    expect(controller.signal.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('maps 401 to an actionable KeyRejectedError', async () => {
    const client = new OpenRouterClient({
      fetchFn: async () => new Response('unauthorized', { status: 401 }),
    });
    await expect(
      client.streamChat({
        apiKey: KEY,
        model: 'test/model',
        system: 's',
        user: 'u',
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(KeyRejectedError);
  });
});

describe('OpenRouterClient.getCredits', () => {
  it('returns remaining credits', async () => {
    const client = new OpenRouterClient({
      fetchFn: async () =>
        new Response(JSON.stringify({ data: { total_credits: 25, total_usage: 5.5 } }), { status: 200 }),
    });
    const credits = await client.getCredits(KEY);
    expect(credits.remaining).toBeCloseTo(19.5);
  });

  it('retries transient failures at most TRANSIENT_RETRY_CAP times, then throws (P3)', async () => {
    let attempts = 0;
    const client = new OpenRouterClient({
      fetchFn: async () => {
        attempts++;
        throw new Error('ECONNRESET');
      },
    });
    await expect(client.getCredits(KEY)).rejects.toThrow('ECONNRESET');
    expect(attempts).toBe(1 + TRANSIENT_RETRY_CAP);
  });

  it('does not retry a rejected key', async () => {
    let attempts = 0;
    const client = new OpenRouterClient({
      fetchFn: async () => {
        attempts++;
        return new Response('no', { status: 401 });
      },
    });
    await expect(client.getCredits(KEY)).rejects.toBeInstanceOf(KeyRejectedError);
    expect(attempts).toBe(1);
  });

  it('does not retry client errors', async () => {
    let attempts = 0;
    const client = new OpenRouterClient({
      fetchFn: async () => {
        attempts++;
        return new Response('bad', { status: 400 });
      },
    });
    await expect(client.getCredits(KEY)).rejects.toBeInstanceOf(HttpError);
    expect(attempts).toBe(1);
  });
});

describe('OpenRouterClient.getGenerationCost', () => {
  it('reads the exact recorded cost', async () => {
    const client = new OpenRouterClient({
      fetchFn: async () =>
        new Response(
          JSON.stringify({ data: { total_cost: 0.0417, tokens_prompt: 12, tokens_completion: 34 } }),
          { status: 200 },
        ),
    });
    const cost = await client.getGenerationCost(KEY, 'gen-123');
    expect(cost.costUsd).toBeCloseTo(0.0417);
  });

  it('polls through the eventually-consistent 404 window', async () => {
    let attempts = 0;
    const client = new OpenRouterClient({
      fetchFn: async () => {
        attempts++;
        if (attempts < 2) return new Response('not yet', { status: 404 });
        return new Response(JSON.stringify({ data: { total_cost: 0.01 } }), { status: 200 });
      },
    });
    const cost = await client.getGenerationCost(KEY, 'gen-123');
    expect(cost.costUsd).toBeCloseTo(0.01);
    expect(attempts).toBe(2);
  });
});
