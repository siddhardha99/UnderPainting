import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { KeyVault } from './host/keyvault/KeyVault';
import {
  OpenRouterClient,
  KeyRejectedError,
  type ModelInfo,
} from './host/client/OpenRouterClient';
import { RedactingLogger, SecretRedactor, formatError, type Logger } from './host/logging/redact';
import { CanvasPanel } from './host/canvas/CanvasPanel';
import { formatModelDetail, suggestEquivalents } from './host/models/catalog';
import {
  extractDesignSystem,
  ExtractionCancelledError,
} from './host/extractor/DesignSystemExtractor';
import { SystemStore } from './host/store/SystemStore';
import { CostLedger } from './host/store/CostLedger';
import { DocumentStore, PROJECT_SLUG } from './host/store/DocumentStore';
import { ExportWriter } from './host/store/ExportWriter';
import {
  buildHandoffJson,
  buildHandoffMd,
  planWrites,
  wrapInBrowserFrame,
  type PlannedWrite,
} from './host/export/handoff';

/**
 * Activation is lazy and does no work (≤500ms budget, M0 task 1): commands
 * are registered and everything else — output channel, client, prompt file —
 * is created on first use. No I/O, no network, nothing speculative (P3).
 */

interface Services {
  keyVault: KeyVault;
  client: OpenRouterClient;
  logger: Logger;
  redactor: SecretRedactor;
  loadCorePrompt: () => Promise<string>;
  loadRefineRecipe: () => Promise<string>;
  loadGroundingPreamble: () => Promise<string>;
  loadCorrectionRecipe: () => Promise<string>;
  loadPageScaffold: () => Promise<string>;
  /** Catalog pricing captured when the user picked the model — display only, never refetched (P3). */
  getModelPricing: (modelId: string) => string | undefined;
  cacheModelPricing: (modelId: string, detail: string) => Promise<void>;
}

export function activate(context: vscode.ExtensionContext): void {
  let services: Services | undefined;
  let creditsStatusBar: vscode.StatusBarItem | undefined;

  // Status-bar credits (M1 item 8, §9): refreshed only after user-initiated
  // API activity or key changes — never on activation, never on a timer (P3).
  const refreshCredits = async (): Promise<void> => {
    const s = getServices();
    const key = await s.keyVault.getKey();
    if (!key) {
      creditsStatusBar?.hide();
      return;
    }
    try {
      const credits = await s.client.getCredits(key);
      if (!creditsStatusBar) {
        creditsStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
        creditsStatusBar.name = 'Underpainting credits';
        creditsStatusBar.command = 'underpainting.showCostLedger';
        context.subscriptions.push(creditsStatusBar);
      }
      creditsStatusBar.text = `$(paintcan) $${credits.remaining.toFixed(2)}`;
      creditsStatusBar.tooltip = `OpenRouter credits remaining: $${credits.remaining.toFixed(4)} — click for the Underpainting cost ledger`;
      creditsStatusBar.show();
    } catch (err) {
      s.logger.error(`credits refresh failed: ${formatError(err)}`);
    }
  };
  const getServices = (): Services => {
    if (!services) {
      const redactor = new SecretRedactor();
      const channel = vscode.window.createOutputChannel('Underpainting');
      context.subscriptions.push(channel);
      const logger = new RedactingLogger((line) => channel.appendLine(line), redactor);
      services = {
        redactor,
        logger,
        keyVault: new KeyVault(context.secrets, redactor),
        client: new OpenRouterClient(),
        loadCorePrompt: () =>
          fs.readFile(path.join(context.extensionUri.fsPath, 'prompts', 'core.md'), 'utf8'),
        loadRefineRecipe: () =>
          fs.readFile(path.join(context.extensionUri.fsPath, 'prompts', 'refine.md'), 'utf8'),
        loadGroundingPreamble: () =>
          fs.readFile(path.join(context.extensionUri.fsPath, 'prompts', 'grounding.md'), 'utf8'),
        loadCorrectionRecipe: () =>
          fs.readFile(path.join(context.extensionUri.fsPath, 'prompts', 'correct.md'), 'utf8'),
        loadPageScaffold: () =>
          fs.readFile(path.join(context.extensionUri.fsPath, 'scaffolds', 'page.html'), 'utf8'),
        getModelPricing: (modelId) =>
          context.globalState.get<string>(`underpainting.pricing.${modelId}`),
        cacheModelPricing: (modelId, detail) =>
          Promise.resolve(context.globalState.update(`underpainting.pricing.${modelId}`, detail)),
      };
    }
    return services;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('underpainting.openCanvas', () =>
      CanvasPanel.createOrShow(context, {
        ...getServices(),
        getGenerationModel: () => getConfiguredModel('generationModel'),
        getValidationModel: () => getConfiguredModel('validationModel'),
        getModelPricing: (modelId) => getServices().getModelPricing(modelId),
        onModelUnavailable: (modelId) => void offerModelSwitch(getServices(), modelId),
        onRequestCompleted: () => void refreshCredits(),
      }),
    ),
    vscode.commands.registerCommand('underpainting.setApiKey', () =>
      setApiKey(getServices(), refreshCredits),
    ),
    vscode.commands.registerCommand('underpainting.clearApiKey', async () => {
      await getServices().keyVault.deleteKey();
      void vscode.window.showInformationMessage(
        'Underpainting: OpenRouter API key removed. The extension is now in read-only mode.',
      );
    }),
    vscode.commands.registerCommand('underpainting.selectGenerationModel', () =>
      selectModel(getServices(), 'generationModel'),
    ),
    vscode.commands.registerCommand('underpainting.selectValidationModel', () =>
      selectModel(getServices(), 'validationModel'),
    ),
    vscode.commands.registerCommand('underpainting.extractDesignSystem', () =>
      extractSystem(getServices()),
    ),
    vscode.commands.registerCommand('underpainting.showCostLedger', () =>
      showCostLedger(getServices()),
    ),
    vscode.commands.registerCommand('underpainting.exportDesign', () =>
      exportDesign(getServices(), context),
    ),
  );
}

/**
 * Export & handoff (M1 item 9). Entirely local and free. Writes land at a
 * user-chosen path OUTSIDE .design/, so P9 applies in full: every write is
 * classified (new / changed / identical), previewable as a diff, and only
 * performed after explicit confirmation.
 */
async function exportDesign(services: Services, context: vscode.ExtensionContext): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    void vscode.window.showErrorMessage('Underpainting: open a folder with saved designs first.');
    return;
  }
  const store = new DocumentStore(workspaceRoot);
  const { versions, currentId } = await store.listVersions();
  const version = versions.find((v) => v.id === currentId);
  if (!version) {
    void vscode.window.showErrorMessage('Underpainting: no saved design versions to export yet.');
    return;
  }
  const artifactHtml = await store.readVersion(version.id);

  const kind = await vscode.window.showQuickPick(
    [
      { label: 'Standalone HTML', description: 'index.html only — renders anywhere', id: 'html' },
      { label: 'Standalone HTML in a browser frame', description: 'presentation wrapper (scaffold)', id: 'framed' },
      {
        label: 'Handoff package',
        description: 'index.html + HANDOFF.md + handoff.json — an executable spec for a coding agent',
        id: 'handoff',
      },
    ] as const,
    { title: 'Underpainting: export the current design (local, free)' },
  );
  if (!kind) return;

  const folderPick = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Export here',
    title: 'Choose the export destination folder',
  });
  const targetDir = folderPick?.[0]?.fsPath;
  if (!targetDir) return;

  const systemStore = new SystemStore(workspaceRoot);
  const extensionVersion =
    (context.extension.packageJSON as { version?: string }).version ?? '0.0.0';
  const input = {
    projectSlug: PROJECT_SLUG,
    artifactHtml,
    version,
    history: versions,
    tokensCss: await systemStore.readTokensCss(),
    componentsMd: null as string | null,
    extensionVersion,
  };
  try {
    input.componentsMd = await fs.readFile(
      path.join(workspaceRoot, '.design', 'system', 'components.md'),
      'utf8',
    );
  } catch {
    // no inventory extracted — fine
  }

  const files: Array<{ relative: string; content: string }> = [];
  if (kind.id === 'html') {
    files.push({ relative: 'index.html', content: artifactHtml });
  } else if (kind.id === 'framed') {
    const frame = await fs.readFile(
      path.join(context.extensionUri.fsPath, 'scaffolds', 'browser-frame.html'),
      'utf8',
    );
    files.push({
      relative: 'index.html',
      content: wrapInBrowserFrame(frame, artifactHtml, `${PROJECT_SLUG} — Underpainting export`),
    });
  } else {
    files.push(
      { relative: 'index.html', content: artifactHtml },
      { relative: 'HANDOFF.md', content: buildHandoffMd(input) },
      { relative: 'handoff.json', content: buildHandoffJson(input) },
    );
  }

  const plan = await planWrites(files, async (relative) => {
    try {
      return await fs.readFile(path.join(targetDir, relative), 'utf8');
    } catch {
      return null;
    }
  });
  const toWrite = plan.filter((p) => p.status !== 'identical');
  if (toWrite.length === 0) {
    void vscode.window.showInformationMessage('Underpainting: export is already up to date — nothing to write.');
    return;
  }

  // P9: diff preview + explicit confirmation before any write outside .design/.
  for (;;) {
    const summary = toWrite
      .map((p) => `${p.status === 'changed' ? 'overwrite' : 'create'} ${p.relative}`)
      .join(', ');
    const choice = await vscode.window.showWarningMessage(
      `Underpainting export to ${targetDir}: ${summary}.`,
      { modal: true },
      'Write files',
      'Preview changes',
    );
    if (choice === undefined) return;
    if (choice === 'Write files') break;
    await previewPlan(toWrite);
  }

  await new ExportWriter().writeConfirmed(
    toWrite.map((p) => ({ absolutePath: path.join(targetDir, p.relative), content: p.content })),
    true,
  );
  void vscode.window.showInformationMessage(
    `Underpainting: exported ${toWrite.length} file(s) to ${targetDir} — local, free.`,
  );
}

async function previewPlan(plan: PlannedWrite[]): Promise<void> {
  for (const file of plan) {
    const proposed = await vscode.workspace.openTextDocument({
      content: file.content,
      language: file.relative.endsWith('.json') ? 'json' : file.relative.endsWith('.md') ? 'markdown' : 'html',
    });
    if (file.status === 'changed' && file.existing !== undefined) {
      const existing = await vscode.workspace.openTextDocument({ content: file.existing });
      await vscode.commands.executeCommand(
        'vscode.diff',
        existing.uri,
        proposed.uri,
        `${file.relative}: existing ↔ export`,
      );
    } else {
      await vscode.window.showTextDocument(proposed, { preview: true });
    }
  }
}

/** Cost ledger summary (M1 item 8): local file read, free. */
async function showCostLedger(services: Services): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    void vscode.window.showInformationMessage(
      'Underpainting: no folder open — the spend ledger lives in the workspace at .design/ledger.jsonl.',
    );
    return;
  }
  const summary = await new CostLedger(workspaceRoot).summary();
  const lines = [
    `Underpainting cost ledger — ${workspaceRoot}/.design/ledger.jsonl (gitignored, personal)`,
    `  total recorded spend: $${summary.totalUsd.toFixed(4)} across ${summary.records} request(s)` +
      (summary.unpriced > 0 ? ` (${summary.unpriced} without a reported cost, excluded)` : ''),
    `  generations: ${summary.byKind.generation.records} — $${summary.byKind.generation.totalUsd.toFixed(4)}`,
    `  refinements: ${summary.byKind.refinement.records} — $${summary.byKind.refinement.totalUsd.toFixed(4)}`,
    `  corrections: ${summary.byKind.correction.records} — $${summary.byKind.correction.totalUsd.toFixed(4)}`,
  ];
  for (const line of lines) {
    services.logger.info(line);
  }
  void vscode.window.showInformationMessage(
    `Underpainting spend in this project: $${summary.totalUsd.toFixed(4)} over ${summary.records} request(s). Details in the Underpainting output channel.`,
  );
}

/**
 * Design-system extraction (M1 item 5): explicit user action, purely local,
 * free — heuristic scanning only, no model call (P3). Cancellable via the
 * progress notification.
 */
async function extractSystem(services: Services): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    void vscode.window.showErrorMessage(
      'Underpainting: open a folder first — the design system is extracted from the workspace.',
    );
    return;
  }
  try {
    const system = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Extracting design system (local, free)…',
        cancellable: true,
      },
      (_progress, token) =>
        extractDesignSystem(workspaceRoot, { isCancelled: () => token.isCancellationRequested }),
    );
    await new SystemStore(workspaceRoot).write(system);
    void vscode.window.showInformationMessage(
      `Underpainting: extracted ${system.tokens.length} design tokens and ` +
        `${system.components.length} components from ${system.stats.filesScanned} files ` +
        `in ${(system.stats.durationMs / 1000).toFixed(1)}s → .design/system/.` +
        (system.stats.truncated ? ' (Large workspace: scan was capped — results may be partial.)' : '') +
        ' New generations are now grounded in these tokens.',
    );
  } catch (err) {
    if (err instanceof ExtractionCancelledError) {
      void vscode.window.showInformationMessage('Underpainting: extraction cancelled — nothing was written.');
      return;
    }
    services.logger.error(`extraction failed: ${formatError(err)}`);
    void vscode.window.showErrorMessage(`Underpainting: extraction failed — ${formatError(err)}`);
  }
}

type ModelSetting = 'generationModel' | 'validationModel';

function getConfiguredModel(setting: ModelSetting): string | undefined {
  const value = vscode.workspace.getConfiguration('underpainting').get<string>(setting)?.trim();
  return value ? value : undefined;
}

async function updateConfiguredModel(setting: ModelSetting, modelId: string): Promise<void> {
  // Workspace-scoped when a workspace is open (the model choice is part of
  // the project and shareable via git), user-global otherwise. Model IDs
  // only — the key never goes near settings (P2).
  const target = vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  await vscode.workspace.getConfiguration('underpainting').update(setting, modelId, target);
}

/** Fetch the live catalog (explicit user action, P3) and let the user pick. */
async function selectModel(services: Services, setting: ModelSetting): Promise<void> {
  const { client, keyVault, logger } = services;
  let models: ModelInfo[];
  try {
    models = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Fetching OpenRouter model catalog…' },
      async () => client.getModels(await keyVault.getKey()),
    );
  } catch (err) {
    logger.error(`model catalog fetch failed: ${formatError(err)}`);
    void vscode.window.showErrorMessage(
      'Could not fetch the OpenRouter model catalog. Check your connection and try again.',
    );
    return;
  }

  const task = setting === 'generationModel' ? 'generation (strong)' : 'validation (fast/cheap)';
  const current = getConfiguredModel(setting);
  const picked = await vscode.window.showQuickPick(
    models
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((m) => ({
        label: m.id,
        description: (m.id === current ? '★ current · ' : '') + (m.name ?? ''),
        detail: formatModelDetail(m),
        modelId: m.id,
      })),
    {
      title: `Underpainting: model for ${task}`,
      placeHolder: `Pick the ${task} model — live catalog prices shown per million tokens`,
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );
  if (!picked) return;
  await updateConfiguredModel(setting, picked.modelId);
  await services.cacheModelPricing(picked.modelId, picked.detail);
  void vscode.window.showInformationMessage(
    `Underpainting: ${task} model set to ${picked.modelId} (${picked.detail}).`,
  );
}

/**
 * Deprecation flow (§9): the configured model was rejected mid-generation.
 * Offer a one-click switch to ranked equivalents — never substitute silently.
 */
async function offerModelSwitch(services: Services, missingId: string): Promise<void> {
  const { client, keyVault, logger } = services;
  let models: ModelInfo[];
  try {
    models = await client.getModels(await keyVault.getKey());
  } catch (err) {
    logger.error(`model catalog fetch failed during deprecation flow: ${formatError(err)}`);
    void vscode.window.showErrorMessage(
      `OpenRouter rejected the model "${missingId}" and the catalog could not be fetched for suggestions. ` +
        'Run "Underpainting: Select Generation Model" to pick a new one.',
    );
    return;
  }

  const suggestions = suggestEquivalents(models, missingId);
  if (suggestions.length === 0) {
    void vscode.window.showErrorMessage(
      `OpenRouter rejected the model "${missingId}" and no similar model was found in the catalog. ` +
        'Run "Underpainting: Select Generation Model" to pick a new one.',
    );
    return;
  }

  const picked = await vscode.window.showQuickPick(
    suggestions.map((m) => ({
      label: m.id,
      description: m.name ?? '',
      detail: formatModelDetail(m),
      modelId: m.id,
    })),
    {
      title: `Model "${missingId}" is unavailable — switch generation model to:`,
      placeHolder: 'Suggested equivalents from the live catalog (Esc to keep the current setting)',
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );
  if (!picked) return;
  await updateConfiguredModel('generationModel', picked.modelId);
  await services.cacheModelPricing(picked.modelId, picked.detail);
  void vscode.window.showInformationMessage(
    `Underpainting: generation model switched to ${picked.modelId}. Run Generate again.`,
  );
}

async function setApiKey(services: Services, onKeyValidated: () => Promise<void>): Promise<void> {
  const { keyVault, client, redactor, logger } = services;

  const entered = await vscode.window.showInputBox({
    title: 'OpenRouter API Key',
    prompt:
      'Stored only in VS Code Secret Storage on this machine. Sent only to openrouter.ai.',
    placeHolder: 'sk-or-…',
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length === 0 ? 'Enter a key.' : undefined),
  });
  if (entered === undefined) return;
  const key = entered.trim();
  // Registered before anything else can touch it (P2).
  redactor.register(key);

  try {
    const credits = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Validating key with OpenRouter…' },
      () => client.getCredits(key),
    );
    await keyVault.setKey(key);
    await onKeyValidated();
    void vscode.window.showInformationMessage(
      `Underpainting: key saved. Remaining OpenRouter credits: $${credits.remaining.toFixed(2)}.`,
    );
  } catch (err) {
    if (err instanceof KeyRejectedError) {
      // Actionable, never a raw error (M0 task 3).
      void vscode.window.showErrorMessage(
        'OpenRouter rejected that key (it may be revoked, expired, or mistyped). ' +
          'Check your keys at openrouter.ai/keys, then run "Underpainting: Set OpenRouter API Key" again. ' +
          'The key was not saved.',
      );
      return;
    }
    logger.error(`key validation failed: ${formatError(err)}`);
    const choice = await vscode.window.showWarningMessage(
      'Could not reach OpenRouter to validate the key (network problem?). Save it anyway?',
      'Save anyway',
      'Discard',
    );
    if (choice === 'Save anyway') {
      await keyVault.setKey(key);
      void vscode.window.showInformationMessage(
        'Underpainting: key saved without validation. It will be checked on first use.',
      );
    }
  }
}

export function deactivate(): void {
  // Nothing to clean up beyond context.subscriptions.
}
