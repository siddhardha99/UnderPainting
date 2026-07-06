import type { HostToWebview } from '../../shared/messages';
import type { KeyVault } from '../keyvault/KeyVault';
import type { OpenRouterClient } from '../client/OpenRouterClient';
import type { Logger } from '../logging/redact';
import { formatError } from '../logging/redact';
import { extractHtml } from './extractHtml';

/**
 * M0 orchestrator: one generation at a time, prompt → stream → cost.
 * The model is hardcoded for the walking skeleton; the live model catalog
 * and per-task model settings are M1 item 1, and the shipped defaults are a
 * human decision (brief §14, docs/OPEN_QUESTIONS.md).
 */
export const M0_MODEL = 'anthropic/claude-sonnet-4.5';

/** Bounded correction retries (§9). M0 has no validator yet, but the cap is part of the contract. */
export const CORRECTION_RETRY_CAP = 2;

/** Throttle for streamChunk posts to the webview; the final state is always posted. */
const CHUNK_POST_INTERVAL_MS = 30;

export interface OrchestratorDeps {
  client: OpenRouterClient;
  keyVault: KeyVault;
  logger: Logger;
  loadCorePrompt: () => Promise<string>;
  /** Posts to the webview; the poster validates and redacts (see createHostPoster). */
  post: (message: HostToWebview) => void;
}

export class Orchestrator {
  private active: AbortController | null = null;

  constructor(private readonly deps: OrchestratorDeps) {}

  get isGenerating(): boolean {
    return this.active !== null;
  }

  /**
   * Runs one generation. Only ever called from an explicit user action —
   * the Generate button's message (P3). Never called on activation, timers,
   * or document events.
   */
  async generate(userPrompt: string): Promise<void> {
    const { client, keyVault, logger, post } = this.deps;

    if (this.active) {
      post({
        type: 'streamError',
        message: 'A generation is already running. Cancel it before starting another.',
      });
      return;
    }

    const apiKey = await keyVault.getKey();
    if (!apiKey) {
      post({
        type: 'streamError',
        message:
          'No OpenRouter API key is set. Run "Underpainting: Set OpenRouter API Key" from the command palette.',
      });
      return;
    }

    const system = await this.deps.loadCorePrompt();
    const controller = new AbortController();
    this.active = controller;
    post({ type: 'streamStart' });

    let lastPostAt = 0;
    try {
      const result = await client.streamChat({
        apiKey,
        model: M0_MODEL,
        system,
        user: userPrompt,
        signal: controller.signal,
        onDelta: (accumulated) => {
          const now = Date.now();
          if (now - lastPostAt >= CHUNK_POST_INTERVAL_MS) {
            lastPostAt = now;
            post({ type: 'streamChunk', html: extractHtml(accumulated) });
          }
        },
      });

      // Cost is read from OpenRouter's own accounting, never estimated (§9).
      let { costUsd, promptTokens, completionTokens } = result;
      if (costUsd === null && result.generationId) {
        try {
          const looked = await client.getGenerationCost(apiKey, result.generationId);
          costUsd = looked.costUsd;
          promptTokens = promptTokens ?? looked.promptTokens;
          completionTokens = completionTokens ?? looked.completionTokens;
        } catch (err) {
          logger.error(`cost lookup failed: ${formatError(err)}`);
        }
      }

      post({ type: 'streamChunk', html: extractHtml(result.text) });
      post({ type: 'streamDone', costUsd, promptTokens, completionTokens });
      logger.info(
        `this generation: ${costUsd !== null ? `$${costUsd.toFixed(4)}` : 'cost unavailable'}` +
          ` — model ${M0_MODEL}` +
          (promptTokens !== null && completionTokens !== null
            ? `, ${promptTokens} prompt + ${completionTokens} completion tokens`
            : ''),
      );
    } catch (err) {
      if (controller.signal.aborted) {
        post({ type: 'streamCancelled' });
        logger.info('generation cancelled by user; stream aborted');
      } else {
        const message = formatError(err);
        post({ type: 'streamError', message });
        logger.error(message);
      }
    } finally {
      this.active = null;
    }
  }

  /** Aborts the in-flight HTTP stream; billing for unconsumed output stops (§9, ≤1s). */
  cancel(): void {
    this.active?.abort();
  }
}
