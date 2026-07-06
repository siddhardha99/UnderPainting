import type { SecretRedactor } from '../logging/redact';

/**
 * The API key lives here and only here (invariant P2): VS Code SecretStorage,
 * scoped to the extension host. It is never written to settings, workspace
 * files, logs, or webview messages. Every key that passes through is
 * registered with the SecretRedactor before anything else can touch it.
 */

const SECRET_ID = 'underpainting.openrouter.apiKey';

/** Structural subset of vscode.SecretStorage so the vault is testable without the vscode module. */
export interface SecretStorageLike {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

export class KeyVault {
  constructor(
    private readonly secrets: SecretStorageLike,
    private readonly redactor: SecretRedactor,
  ) {}

  async getKey(): Promise<string | undefined> {
    const key = await this.secrets.get(SECRET_ID);
    if (key) {
      this.redactor.register(key);
    }
    return key;
  }

  async hasKey(): Promise<boolean> {
    return (await this.getKey()) !== undefined;
  }

  /** Callers must have validated the key (or gotten explicit user consent to store unvalidated). */
  async setKey(key: string): Promise<void> {
    this.redactor.register(key);
    await this.secrets.store(SECRET_ID, key);
  }

  async deleteKey(): Promise<void> {
    // The old key stays registered with the redactor: a deleted key in a
    // stale log line is still a leaked key.
    await this.secrets.delete(SECRET_ID);
  }
}
