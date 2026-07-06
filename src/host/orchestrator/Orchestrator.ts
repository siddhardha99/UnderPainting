import type { Clarifications, HostToWebview } from '../../shared/messages';
import { foldClarifications } from '../../shared/clarify';
import type { KeyVault } from '../keyvault/KeyVault';
import { HttpError, type OpenRouterClient } from '../client/OpenRouterClient';
import type { Logger } from '../logging/redact';
import { formatError } from '../logging/redact';
import { extractHtml } from './extractHtml';
import {
  isRedesignInstruction,
  refinementSurvivalRatio,
  validateArtifact,
} from '../validator/Validator';
import { assembleArtifact } from './scaffold';

/**
 * One generation at a time: prompt → stream → cost → commit. The model comes
 * from the user's per-task settings (M1 item 1) — there are no hardcoded
 * model IDs anywhere; shipped defaults remain a release-time human decision
 * (brief §14).
 *
 * Two entry points, both explicit user actions (P3): generate() for a fresh
 * design, refine() for a targeted change to an existing frame (A7 — the
 * refinement recipe demands untouched content survive character-for-
 * character; deterministic enforcement arrives with the Validator, item 6).
 */

/** Bounded correction retries (§9). Consumed by the Validator's correction loop (M1 item 6). */
export const CORRECTION_RETRY_CAP = 2;

/** Throttle for streamChunk posts to the webview; the final state is always posted. */
const CHUNK_POST_INTERVAL_MS = 30;

export interface OrchestratorDeps {
  client: OpenRouterClient;
  keyVault: KeyVault;
  logger: Logger;
  loadCorePrompt: () => Promise<string>;
  /** The refinement recipe, loaded only for refine() invocations (§8). */
  loadRefineRecipe: () => Promise<string>;
  /** The correction-pass recipe — the ENTIRE system prompt for corrections (§8: verifier in miniature). */
  loadCorrectionRecipe: () => Promise<string>;
  /**
   * The page scaffold (A5, M1 item 7): fresh generations stream only
   * tokens + body; the shell is copied around them, never regenerated.
   * Undefined falls back to full-document output (pre-scaffold behavior).
   */
  loadPageScaffold?: () => Promise<string>;
  /** The cheap/fast validation model for correction passes; undefined skips corrections. */
  getValidationModel: () => string | undefined;
  /** The grounding preamble prepended to the workspace token block (§8, M1 item 5). */
  loadGroundingPreamble: () => Promise<string>;
  /** Extracted workspace tokens (tokens.css content), or null when none exist. */
  loadGroundingTokens: () => Promise<string | null>;
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
  /** Ledger hook (M1 item 8): one record per API request, corrections separate. Fire-and-forget. */
  recordSpend?: (record: {
    kind: 'generation' | 'refinement' | 'correction';
    model: string;
    costUsd: number | null;
    promptTokens: number | null;
    completionTokens: number | null;
  }) => void;
  /** Called after a run's API activity finishes — the host refreshes status-bar credits (§9). */
  onRequestCompleted?: () => void;
  /**
   * Persist a COMPLETE generation (P5, commit-only-complete-states): called
   * strictly after the stream finishes successfully and never on cancel or
   * error. Undefined when there is no workspace to write to.
   */
  commit?: (result: {
    html: string;
    prompt: string;
    model: string;
    costUsd: number | null;
    promptTokens: number | null;
    completionTokens: number | null;
    validated: boolean;
    issues: string[];
    clarifications?: Clarifications;
  }) => Promise<void>;
}

interface RunRequest {
  /** What lands in the version metadata and the chat history. */
  prompt: string;
  system: string;
  user: string;
  /** Refinement base for the A7 diff-minimality warning. */
  refineBase?: string;
  /** Clarify-form answers, recorded in the version manifest (v0.2 item 1). */
  clarifications?: Clarifications;
  /** Wraps the streamed fragment into the scaffold shell (A5); identity for refinements. */
  assemble?: (fragment: string) => string;
  kind: 'generation' | 'refinement';
}

export class Orchestrator {
  private active: AbortController | null = null;

  constructor(private readonly deps: OrchestratorDeps) {}

  get isGenerating(): boolean {
    return this.active !== null;
  }

  /** Fresh design from a prompt, grounded in the workspace's extracted tokens when they exist. */
  async generate(userPrompt: string, clarifications?: Clarifications): Promise<void> {
    await this.run(async () => {
      const scaffold = await this.deps.loadPageScaffold?.();
      return {
        prompt: userPrompt,
        system: (await this.deps.loadCorePrompt()) + (await this.groundingSection()),
        // Clarify answers fold in deterministically (v0.2 item 1); the
        // original prompt is what the version metadata records, the answers
        // ride separately for reproducibility.
        user: foldClarifications(userPrompt, clarifications ?? {}),
        clarifications,
        assemble: scaffold ? (fragment: string) => assembleArtifact(scaffold, fragment) : undefined,
        kind: 'generation' as const,
      };
    });
  }

  /**
   * The design-system grounding block (M1 item 5): workspace tokens ride in
   * the system prompt as fenced data behind the grounding preamble. Absent
   * extraction → empty string, and the core prompt's invent-a-token-set rule
   * applies.
   */
  private async groundingSection(): Promise<string> {
    const tokens = await this.deps.loadGroundingTokens();
    if (!tokens) return '';
    const preamble = await this.deps.loadGroundingPreamble();
    return `\n\n${preamble}\n\n\`\`\`css\n${tokens}\n\`\`\``;
  }

  /** Targeted change to an existing artifact (A7). The result is a NEW version — history is never rewritten. */
  async refine(instruction: string, baseHtml: string): Promise<void> {
    await this.run(async () => {
      const [core, recipe] = await Promise.all([
        this.deps.loadCorePrompt(),
        this.deps.loadRefineRecipe(),
      ]);
      return {
        prompt: instruction,
        system: `${core}\n\n${recipe}${await this.groundingSection()}`,
        // The artifact rides in the user message as fenced DATA; the recipe
        // pins the untrusted-content framing (§8/§9 prompt-injection stance).
        user: `<<<ARTIFACT\n${baseHtml}\nARTIFACT>>>\n\nInstruction: ${instruction}`,
        refineBase: isRedesignInstruction(instruction) ? undefined : baseHtml,
        kind: 'refinement' as const,
      };
    });
  }

  private async run(buildRequest: () => Promise<RunRequest>): Promise<void> {
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

    const request = await buildRequest();
    const controller = new AbortController();
    this.active = controller;
    post({ type: 'streamStart' });

    let lastPostAt = 0;
    const toArtifact = (raw: string): string => {
      const fragment = extractHtml(raw);
      return request.assemble ? request.assemble(fragment) : fragment;
    };
    try {
      const result = await client.streamChat({
        apiKey,
        model,
        system: request.system,
        user: request.user,
        signal: controller.signal,
        onDelta: (accumulated) => {
          const now = Date.now();
          if (now - lastPostAt >= CHUNK_POST_INTERVAL_MS) {
            lastPostAt = now;
            post({ type: 'streamChunk', html: toArtifact(accumulated) });
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
      this.deps.recordSpend?.({ kind: request.kind, model, costUsd, promptTokens, completionTokens });

      let finalHtml = toArtifact(result.text);

      // ---- Validator + bounded correction loop (M1 item 6, §7/§9). Each
      // correction pass is one call on the cheap validation model with
      // minimal context, streamed to the canvas like any generation. The
      // cap is absolute; surviving issues are surfaced, never silent.
      let issues = validateArtifact(finalHtml);
      let correctionPasses = 0;
      const validationModel = this.deps.getValidationModel();
      while (issues.length > 0 && correctionPasses < CORRECTION_RETRY_CAP && validationModel) {
        if (controller.signal.aborted) break;
        correctionPasses++;
        post({ type: 'streamChunk', html: finalHtml });
        logger.info(
          `validator found ${issues.length} issue(s); correction pass ${correctionPasses}/${CORRECTION_RETRY_CAP} on ${validationModel}`,
        );
        try {
          const correction = await client.streamChat({
            apiKey,
            model: validationModel,
            system: await this.deps.loadCorrectionRecipe(),
            user:
              `<<<ARTIFACT\n${finalHtml}\nARTIFACT>>>\n\nViolations:\n` +
              issues.map((issue, i) => `${i + 1}. [${issue.rule}] ${issue.message}`).join('\n'),
            signal: controller.signal,
            onDelta: (accumulated) => {
              const now = Date.now();
              if (now - lastPostAt >= CHUNK_POST_INTERVAL_MS) {
                lastPostAt = now;
                post({ type: 'streamChunk', html: extractHtml(accumulated) });
              }
            },
          });
          costUsd = addCost(costUsd, correction.costUsd);
          this.deps.recordSpend?.({
            kind: 'correction',
            model: validationModel,
            costUsd: correction.costUsd,
            promptTokens: correction.promptTokens,
            completionTokens: correction.completionTokens,
          });
          const correctedHtml = extractHtml(correction.text);
          const correctedIssues = validateArtifact(correctedHtml);
          if (correctedHtml.length === 0 || correctedIssues.length > issues.length) {
            logger.error('correction pass made things worse; keeping the previous artifact');
            break;
          }
          finalHtml = correctedHtml;
          issues = correctedIssues;
        } catch (err) {
          if (controller.signal.aborted) throw err;
          logger.error(`correction pass failed: ${formatError(err)}`);
          break;
        }
      }

      // A7 diff-minimality warning for targeted refinements (never a
      // correction trigger — re-running the instruction costs money for the
      // same likely result; surfacing beats silently accepting).
      const warnings: string[] = [];
      if (request.refineBase) {
        const survival = refinementSurvivalRatio(request.refineBase, finalHtml);
        if (survival < 0.5) {
          warnings.push(
            `A7: this targeted refinement rewrote ${Math.round((1 - survival) * 100)}% of the document — untouched content should survive. Review before building on it.`,
          );
        }
      }

      post({ type: 'streamChunk', html: finalHtml });
      const allIssues = [...issues.map((i) => `[${i.rule}] ${i.message}`), ...warnings];
      // Commit before streamDone so the webview can adopt its streaming
      // frame when the 'frames' message (sent inside commit) arrives first.
      if (this.deps.commit) {
        try {
          await this.deps.commit({
            html: finalHtml,
            prompt: request.prompt,
            model,
            costUsd,
            promptTokens,
            completionTokens,
            validated: allIssues.length === 0,
            issues: allIssues,
            clarifications: request.clarifications,
          });
        } catch (err) {
          logger.error(`version commit failed: ${formatError(err)}`);
        }
      }
      post({ type: 'streamDone', costUsd, promptTokens, completionTokens });
      if (allIssues.length > 0 || correctionPasses > 0) {
        post({ type: 'validation', issues: allIssues, correctionPasses });
        for (const issue of allIssues) {
          logger.info(`validation: ${issue}`);
        }
        if (issues.length > 0 && !validationModel) {
          logger.info(
            'no validation model set — corrections skipped. Run "Underpainting: Select Validation Model" to enable the correction loop.',
          );
        }
      }
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
      this.deps.onRequestCompleted?.();
    }
  }

  /** Aborts the in-flight HTTP stream; billing for unconsumed output stops (§9, ≤1s). */
  cancel(): void {
    this.active?.abort();
  }
}

/** Exact-cost accounting across correction passes: sum what OpenRouter reported; unknown stays unknown-safe. */
function addCost(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + b;
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
