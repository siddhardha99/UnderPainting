import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { KeyVault } from './host/keyvault/KeyVault';
import { OpenRouterClient, KeyRejectedError } from './host/client/OpenRouterClient';
import { RedactingLogger, SecretRedactor, formatError, type Logger } from './host/logging/redact';
import { CanvasPanel } from './host/canvas/CanvasPanel';

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
      };
    }
    return services;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('underpainting.openCanvas', () =>
      CanvasPanel.createOrShow(context, getServices()),
    ),
    vscode.commands.registerCommand('underpainting.setApiKey', () => setApiKey(getServices())),
    vscode.commands.registerCommand('underpainting.clearApiKey', async () => {
      await getServices().keyVault.deleteKey();
      void vscode.window.showInformationMessage(
        'Underpainting: OpenRouter API key removed. The extension is now in read-only mode.',
      );
    }),
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
