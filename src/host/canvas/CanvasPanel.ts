import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { webviewToHostSchema } from '../../shared/messages';
import { Orchestrator } from '../orchestrator/Orchestrator';
import type { OpenRouterClient } from '../client/OpenRouterClient';
import type { KeyVault } from '../keyvault/KeyVault';
import type { Logger, SecretRedactor } from '../logging/redact';
import { createHostPoster } from './poster';
import { buildCanvasHtml } from './canvasHtml';
import { DESIGN_DIR } from '../store/writeScope';

export interface CanvasDeps {
  client: OpenRouterClient;
  keyVault: KeyVault;
  logger: Logger;
  redactor: SecretRedactor;
  loadCorePrompt: () => Promise<string>;
  getGenerationModel: () => string | undefined;
  onModelUnavailable: (modelId: string) => void;
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

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    deps: CanvasDeps,
  ) {
    const post = createHostPoster((m) => void this.panel.webview.postMessage(m), deps.redactor);
    this.orchestrator = new Orchestrator({
      client: deps.client,
      keyVault: deps.keyVault,
      logger: deps.logger,
      loadCorePrompt: deps.loadCorePrompt,
      getGenerationModel: deps.getGenerationModel,
      onModelUnavailable: deps.onModelUnavailable,
      post,
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
            void deps.keyVault.hasKey().then((present) => post({ type: 'keyState', present }));
            break;
          case 'generate':
            // Explicit user action → the only path to an API call (P3).
            void this.orchestrator.generate(message.prompt);
            break;
          case 'cancel':
            this.orchestrator.cancel();
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
}
