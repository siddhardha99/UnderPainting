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
}

export function activate(context: vscode.ExtensionContext): void {
  let services: Services | undefined;
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
      };
    }
    return services;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('underpainting.openCanvas', () =>
      CanvasPanel.createOrShow(context, {
        ...getServices(),
        getGenerationModel: () => getConfiguredModel('generationModel'),
        onModelUnavailable: (modelId) => void offerModelSwitch(getServices(), modelId),
      }),
    ),
    vscode.commands.registerCommand('underpainting.setApiKey', () => setApiKey(getServices())),
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
  );
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
  void vscode.window.showInformationMessage(
    `Underpainting: generation model switched to ${picked.modelId}. Run Generate again.`,
  );
}

async function setApiKey(services: Services): Promise<void> {
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
