import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { webviewToHostSchema, type FrameMeta, type HostToWebview } from '../../shared/messages';
import { Orchestrator } from '../orchestrator/Orchestrator';
import type { OpenRouterClient } from '../client/OpenRouterClient';
import type { KeyVault } from '../keyvault/KeyVault';
import { formatError, type Logger, type SecretRedactor } from '../logging/redact';
import { createHostPoster } from './poster';
import { buildCanvasHtml } from './canvasHtml';
import { DESIGN_DIR } from '../store/writeScope';
import { DocumentStore, type VersionMeta } from '../store/DocumentStore';
import { SystemStore } from '../store/SystemStore';
import { CostLedger } from '../store/CostLedger';
import { checkDrift } from '../extractor/DesignSystemExtractor';
import { validateArtifact } from '../validator/Validator';

export interface CanvasDeps {
  client: OpenRouterClient;
  keyVault: KeyVault;
  logger: Logger;
  redactor: SecretRedactor;
  loadCorePrompt: () => Promise<string>;
  loadRefineRecipe: () => Promise<string>;
  loadGroundingPreamble: () => Promise<string>;
  loadCorrectionRecipe: () => Promise<string>;
  loadPageScaffold: () => Promise<string>;
  getGenerationModel: () => string | undefined;
  getValidationModel: () => string | undefined;
  /** Pricing cached when the model was picked; undefined when hand-edited into settings. */
  getModelPricing: (modelId: string) => string | undefined;
  onModelUnavailable: (modelId: string) => void;
  /** Fired when a run's API activity ends — the host refreshes status-bar credits (§9). */
  onRequestCompleted: () => void;
}

export class CanvasPanel {
  static current: CanvasPanel | undefined;

  static async createOrShow(context: vscode.ExtensionContext, deps: CanvasDeps): Promise<void> {
    if (CanvasPanel.current) {
      CanvasPanel.current.panel.reveal();
      return;
    }

    // localResourceRoots: only the extension's own webview bundle and the
    // workspace's .design/ directory are readable from the webview. The rest
    // of the workspace is not reachable (P5/P6).
    const roots = [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')];
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (workspaceRoot) {
      roots.push(vscode.Uri.joinPath(workspaceRoot, DESIGN_DIR));
    }

    const panel = vscode.window.createWebviewPanel(
      'underpainting.canvas',
      'Underpainting',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: roots,
        retainContextWhenHidden: true,
      },
    );

    const bootstrapJs = await fs.readFile(
      vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'artifactBootstrap.js').fsPath,
      'utf8',
    );
    const canvasScriptUri = panel.webview
      .asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'canvas.js'))
      .toString();

    panel.webview.html = buildCanvasHtml({
      cspSource: panel.webview.cspSource,
      nonce: crypto.randomBytes(16).toString('base64url'),
      canvasScriptUri,
      bootstrapJs,
    });

    CanvasPanel.current = new CanvasPanel(panel, deps);
  }

  private readonly orchestrator: Orchestrator;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly store: DocumentStore | null;
  /** Selection target for restore now and refine/edit in M1 items 3–4 (ADR-009). */
  private selectedFrameId: string | null = null;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    deps: CanvasDeps,
  ) {
    const post = createHostPoster((m) => void this.panel.webview.postMessage(m), deps.redactor);
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this.store = workspaceRoot ? new DocumentStore(workspaceRoot) : null;
    const systemStore = workspaceRoot ? new SystemStore(workspaceRoot) : null;
    const ledger = workspaceRoot ? new CostLedger(workspaceRoot) : null;

    // The point-of-spend disclosure (P4): which model Send will use and what
    // it costs, from pricing cached at pick time — display never fetches (P3).
    const postModelState = (): void => {
      const modelId = deps.getGenerationModel() ?? null;
      post({
        type: 'modelState',
        modelId,
        pricing: modelId ? (deps.getModelPricing(modelId) ?? null) : null,
      });
    };
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('underpainting')) postModelState();
      }),
    );

    // Cheap drift check (§6): rehash the extractor's recorded sources and
    // surface a non-blocking hint. Fire-and-forget; never blocks, never
    // re-extracts silently. Runs on canvas open and before each generation.
    const postSystemState = async (): Promise<void> => {
      if (!systemStore || !workspaceRoot) return;
      const manifest = await systemStore.readManifest();
      if (!manifest) {
        post({ type: 'systemState', tokensPresent: false, tokenCount: 0, stale: false });
        return;
      }
      const stale = await checkDrift(workspaceRoot, manifest.sources);
      post({
        type: 'systemState',
        tokensPresent: manifest.stats.tokenCount > 0,
        tokenCount: manifest.stats.tokenCount,
        stale,
      });
    };

    this.orchestrator = new Orchestrator({
      client: deps.client,
      keyVault: deps.keyVault,
      logger: deps.logger,
      loadCorePrompt: deps.loadCorePrompt,
      loadRefineRecipe: deps.loadRefineRecipe,
      loadGroundingPreamble: deps.loadGroundingPreamble,
      loadCorrectionRecipe: deps.loadCorrectionRecipe,
      loadPageScaffold: deps.loadPageScaffold,
      loadGroundingTokens: async () => (systemStore ? systemStore.readTokensCss() : null),
      getGenerationModel: deps.getGenerationModel,
      getValidationModel: deps.getValidationModel,
      onModelUnavailable: deps.onModelUnavailable,
      recordSpend: ledger
        ? (record) =>
            void ledger
              .append(record)
              .catch((err) => deps.logger.error(`ledger append failed: ${formatError(err)}`))
        : undefined,
      onRequestCompleted: deps.onRequestCompleted,
      post,
      commit: this.store
        ? async (result) => {
            const meta = await this.store!.commitVersion(result);
            await this.postFrames(post, meta.id);
          }
        : undefined,
    });

    this.panel.webview.onDidReceiveMessage(
      (raw: unknown) => {
        // Incoming traffic is untrusted until it parses (P6).
        const parsed = webviewToHostSchema.safeParse(raw);
        if (!parsed.success) {
          deps.logger.error(`dropped malformed webview message: ${parsed.error.message}`);
          return;
        }
        const message = parsed.data;
        switch (message.type) {
          case 'ready':
            post({ type: 'workspaceState', open: this.store !== null });
            postModelState();
            void deps.keyVault.hasKey().then((present) => post({ type: 'keyState', present }));
            void this.postFrames(post, null).catch((err) =>
              deps.logger.error(`frame index load failed: ${formatError(err)}`),
            );
            void postSystemState().catch((err) =>
              deps.logger.error(`system drift check failed: ${formatError(err)}`),
            );
            break;
          case 'generate':
            // Explicit user action → the only path to an API call (P3).
            void this.orchestrator.generate(message.prompt, message.clarifications);
            void postSystemState().catch(() => undefined);
            break;
          case 'refine':
            // Refinement targets the selected frame's snapshot (A7, ADR-009).
            void (async () => {
              if (!this.store) {
                post({
                  type: 'streamError',
                  message: 'Refining needs saved versions — open a folder first.',
                });
                return;
              }
              const baseHtml = await this.store.readVersion(message.frameId);
              await this.orchestrator.refine(message.instruction, baseHtml);
            })().catch((err) => {
              post({ type: 'streamError', message: formatError(err) });
              deps.logger.error(`refine failed: ${formatError(err)}`);
            });
            break;
          case 'cancel':
            this.orchestrator.cancel();
            break;
          case 'selectFrame':
            this.selectedFrameId = message.id;
            break;
          case 'requestFrame':
            void this.store
              ?.readVersion(message.id)
              .then((html) => post({ type: 'frameContent', id: message.id, html }))
              .catch((err) => deps.logger.error(`frame read failed: ${formatError(err)}`));
            break;
          case 'commitEdit':
            // Direct-edit save (M1 item 4): a local write into .design/,
            // zero API involvement — free (P4). New snapshot, old untouched.
            void (async () => {
              if (!this.store) return;
              // Re-validate the edited document (free, local) so the frame's
              // validated badge stays truthful after splices.
              const issues = validateArtifact(message.html).map((i) => `[${i.rule}] ${i.message}`);
              const meta = await this.store.commitVersion({
                html: message.html,
                prompt: `Direct text edit (${message.editCount} change${message.editCount === 1 ? '' : 's'})`,
                model: 'local edit',
                costUsd: 0,
                promptTokens: null,
                completionTokens: null,
                validated: issues.length === 0,
                issues,
              });
              await this.postFrames(post, meta.id);
            })().catch((err) => deps.logger.error(`edit commit failed: ${formatError(err)}`));
            break;
          case 'restore':
            // One-click restore: a local pointer move in .design/ — free (P4).
            void this.store
              ?.restore(message.id)
              .then(() => this.postFrames(post, null))
              .catch((err) => deps.logger.error(`restore failed: ${formatError(err)}`));
            break;
        }
      },
      undefined,
      this.disposables,
    );

    this.panel.onDidDispose(
      () => {
        this.orchestrator.cancel();
        this.disposables.forEach((d) => d.dispose());
        CanvasPanel.current = undefined;
      },
      undefined,
      this.disposables,
    );
  }

  /** Send the full frame index; `justCommitted` lets the webview adopt its streaming card. */
  private async postFrames(
    post: (m: HostToWebview) => void,
    justCommitted: string | null,
  ): Promise<void> {
    if (!this.store) return;
    const { versions, currentId } = await this.store.listVersions();
    post({
      type: 'frames',
      frames: versions.map((v) => toFrameMeta(v, currentId)),
      currentId,
      justCommitted,
    });
  }
}

function toFrameMeta(v: VersionMeta, currentId: string | null): FrameMeta {
  // A recorded zero is genuinely free (local edits, :free models) — say so.
  const cost = v.costUsd === 0 ? 'free' : v.costUsd !== null ? `$${v.costUsd.toFixed(4)}` : 'cost n/a';
  const when = new Date(v.created).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const promptExcerpt = v.prompt.length > 60 ? `${v.prompt.slice(0, 57)}…` : v.prompt;
  return {
    id: v.id,
    title: `${v.model} — ${cost}`,
    subtitle: `${when} · ${promptExcerpt}`,
    prompt: v.prompt,
    isCurrent: v.id === currentId,
    validated: v.validated ?? true,
  };
}
