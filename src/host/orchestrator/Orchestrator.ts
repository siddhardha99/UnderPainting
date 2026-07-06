import type { HostToWebview } from '../../shared/messages';
import type { KeyVault } from '../keyvault/KeyVault';
import { HttpError, type OpenRouterClient } from '../client/OpenRouterClient';
import type { Logger } from '../logging/redact';
import { formatError } from '../logging/redact';
import { extractHtml } from './extractHtml';

/**
 * One generation at a time: prompt → stream → cost. The model comes from
 * the user's per-task settings (M1 item 1) — there are no hardcoded model
 * IDs anywhere; shipped defaults remain a release-time human decision
 * (brief §14).
 */

/** Bounded correction retries (§9). M0 has no validator yet, but the cap is part of the contract. */
export const CORRECTION_RETRY_CAP = 2;

/** Throttle for streamChunk posts to the webview; the final state is always posted. */
const CHUNK_POST_INTERVAL_MS = 30;

export interface OrchestratorDeps {
  client: OpenRouterClient;
  keyVault: KeyVault;
  logger: Logger;
  loadCorePrompt: () => Promise<string>;
  /** The user's configured generation model, or undefined when none is chosen yet. */
  getGenerationModel: () => string | undefined;
  /**
   * Invoked when OpenRouter rejects the configured model (deprecated or
   * renamed) so the host can offer a suggested-equivalent switch — always a
   * user choice, never a silent substitution (§9).
   */
  onModelUnavailable?: (modelId: string) => void;
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

    const model = this.deps.getGenerationModel();
    if (!model) {
      post({
        type: 'streamError',
        message:
          'No generation model is selected. Run "Underpainting: Select Generation Model" to pick one from the live OpenRouter catalog.',
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
        model,
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
          ` — model ${model}` +
          (promptTokens !== null && completionTokens !== null
            ? `, ${promptTokens} prompt + ${completionTokens} completion tokens`
            : ''),
      );
    } catch (err) {
      if (controller.signal.aborted) {
        post({ type: 'streamCancelled' });
        logger.info('generation cancelled by user; stream aborted');
      } else if (isModelRejection(err)) {
        const message =
          `OpenRouter rejected the model "${model}" — it may be deprecated or renamed. ` +
          `(${formatError(err)})`;
        post({ type: 'streamError', message });
        logger.error(message);
        // Offer the one-click switch; the host shows suggestions, the user decides.
        this.deps.onModelUnavailable?.(model);
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

/**
 * Heuristic for "the model itself was rejected": OpenRouter answers 400/404
 * with an error body naming the model. Only ever used to *offer* a switch —
 * a false positive costs the user one dismissible dialog, nothing more.
 */
function isModelRejection(err: unknown): boolean {
  return (
    err instanceof HttpError &&
    (err.status === 400 || err.status === 404) &&
    /model/i.test(err.message)
  );
}
