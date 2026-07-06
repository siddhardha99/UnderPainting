import { z } from 'zod';
import { assertAllowedUrl } from './allowlist';
import { SseParser } from './sse';

/**
 * THE ONLY MODULE THAT FETCHES (invariant P1). Every network request in the
 * extension goes through `OpenRouterClient.request`, which asserts the
 * allowlist before dispatch. The endpoints below are the complete network
 * surface of the product; PRIVACY.md enumerates the same list (P7) and
 * test/invariants/allowlist.test.ts fails if the two drift.
 */

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export const ENDPOINTS = {
  /** POST — the generation itself. Only ever sent on an explicit user action (P3). */
  chatCompletions: `${OPENROUTER_BASE_URL}/chat/completions`,
  /** GET — key validation and remaining-credit display. */
  credits: `${OPENROUTER_BASE_URL}/credits`,
  /** GET — per-request cost lookup when the stream did not carry usage (P: exact cost, never estimated). */
  generation: `${OPENROUTER_BASE_URL}/generation`,
} as const;

/** Transient network errors retry with backoff at most this many times (§9). */
export const TRANSIENT_RETRY_CAP = 2;

export class KeyRejectedError extends Error {
  constructor() {
    super('OpenRouter rejected the API key (401).');
  }
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const creditsResponseSchema = z.object({
  data: z.object({
    total_credits: z.number(),
    total_usage: z.number(),
  }),
});

const usageSchema = z
  .object({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
    cost: z.number().optional(),
  })
  .passthrough();

const streamEventSchema = z
  .object({
    id: z.string().optional(),
    choices: z
      .array(
        z
          .object({
            delta: z
              .object({ content: z.string().nullable().optional() })
              .passthrough()
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
    usage: usageSchema.nullish(),
  })
  .passthrough();

const generationResponseSchema = z.object({
  data: z
    .object({
      total_cost: z.number().nullable().optional(),
      tokens_prompt: z.number().nullable().optional(),
      tokens_completion: z.number().nullable().optional(),
    })
    .passthrough(),
});

export interface CreditsInfo {
  totalCredits: number;
  totalUsage: number;
  remaining: number;
}

export interface StreamChatRequest {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  signal: AbortSignal;
  /** Called with the accumulated text and the newest delta as tokens arrive. */
  onDelta?: (accumulated: string, delta: string) => void;
}

export interface StreamChatResult {
  text: string;
  costUsd: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  generationId: string | null;
}

export type FetchFn = typeof globalThis.fetch;

export class OpenRouterClient {
  private readonly fetchFn: FetchFn;

  /** `fetchFn` is injectable for tests only; production uses global fetch. */
  constructor(options: { fetchFn?: FetchFn } = {}) {
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    assertAllowedUrl(url);
    return this.fetchFn(url, init);
  }

  /** Validate a key and read remaining account credits. Retries transient failures at most TRANSIENT_RETRY_CAP times. */
  async getCredits(apiKey: string, signal?: AbortSignal): Promise<CreditsInfo> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= TRANSIENT_RETRY_CAP; attempt++) {
      if (attempt > 0) {
        await delay(300 * 2 ** (attempt - 1));
      }
      try {
        const res = await this.request(ENDPOINTS.credits, {
          method: 'GET',
          headers: { authorization: `Bearer ${apiKey}` },
          signal: signal ?? null,
        });
        if (res.status === 401 || res.status === 403) {
          throw new KeyRejectedError();
        }
        if (!res.ok) {
          throw new HttpError(res.status, `OpenRouter /credits failed with status ${res.status}.`);
        }
        const body = creditsResponseSchema.parse(await res.json());
        return {
          totalCredits: body.data.total_credits,
          totalUsage: body.data.total_usage,
          remaining: body.data.total_credits - body.data.total_usage,
        };
      } catch (err) {
        // Only transient failures (network errors, 5xx) are retried; a
        // rejected key or client error is final.
        if (err instanceof KeyRejectedError) throw err;
        if (err instanceof HttpError && err.status < 500) throw err;
        lastError = err;
      }
    }
    throw lastError;
  }

  /**
   * Stream a chat completion. Aborting `signal` tears down the HTTP stream
   * immediately (§9: within 1 second) so billing for unconsumed output stops.
   * `usage: {include: true}` asks OpenRouter to append its own accounting to
   * the final chunk — the cost shown to the user is read, never estimated.
   */
  async streamChat(req: StreamChatRequest): Promise<StreamChatResult> {
    const res = await this.request(ENDPOINTS.chatCompletions, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${req.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: req.model,
        stream: true,
        usage: { include: true },
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
      }),
      signal: req.signal,
    });

    if (res.status === 401 || res.status === 403) {
      throw new KeyRejectedError();
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new HttpError(
        res.status,
        `OpenRouter request failed with status ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
      );
    }
    if (!res.body) {
      throw new Error('OpenRouter response carried no body stream.');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();

    let text = '';
    let generationId: string | null = null;
    let costUsd: number | null = null;
    let promptTokens: number | null = null;
    let completionTokens: number | null = null;

    try {
      let finished = false;
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const payload of parser.push(decoder.decode(value, { stream: true }))) {
          if (payload.trim() === '[DONE]') {
            finished = true;
            continue;
          }
          let json: unknown;
          try {
            json = JSON.parse(payload);
          } catch {
            continue; // malformed frame; skip rather than kill the stream
          }
          const event = streamEventSchema.safeParse(json);
          if (!event.success) continue;
          if (event.data.id) generationId = event.data.id;
          const delta = event.data.choices?.[0]?.delta?.content ?? '';
          if (delta) {
            text += delta;
            req.onDelta?.(text, delta);
          }
          const usage = event.data.usage;
          if (usage) {
            costUsd = usage.cost ?? costUsd;
            promptTokens = usage.prompt_tokens ?? promptTokens;
            completionTokens = usage.completion_tokens ?? completionTokens;
          }
        }
      }
    } finally {
      // On abort or error, cancel the reader so the underlying connection
      // closes and OpenRouter stops generating billable tokens.
      try {
        await reader.cancel();
      } catch {
        // reader already errored/closed — nothing to release
      }
    }

    return { text, costUsd, promptTokens, completionTokens, generationId };
  }

  /**
   * Fallback cost lookup for a completed generation when the stream carried
   * no usage record. Part of the same user-initiated generation (P3). The
   * record is eventually consistent, so poll briefly.
   */
  async getGenerationCost(
    apiKey: string,
    generationId: string,
  ): Promise<{ costUsd: number | null; promptTokens: number | null; completionTokens: number | null }> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= TRANSIENT_RETRY_CAP; attempt++) {
      if (attempt > 0) {
        await delay(500 * attempt);
      }
      try {
        const res = await this.request(
          `${ENDPOINTS.generation}?id=${encodeURIComponent(generationId)}`,
          {
            method: 'GET',
            headers: { authorization: `Bearer ${apiKey}` },
          },
        );
        if (res.status === 404) {
          lastError = new HttpError(404, 'Generation record not yet available.');
          continue;
        }
        if (!res.ok) {
          throw new HttpError(res.status, `OpenRouter /generation failed with status ${res.status}.`);
        }
        const body = generationResponseSchema.parse(await res.json());
        return {
          costUsd: body.data.total_cost ?? null,
          promptTokens: body.data.tokens_prompt ?? null,
          completionTokens: body.data.tokens_completion ?? null,
        };
      } catch (err) {
        if (err instanceof HttpError && err.status !== 404 && err.status < 500) throw err;
        lastError = err;
      }
    }
    throw lastError;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
