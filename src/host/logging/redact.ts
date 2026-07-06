/**
 * Secret redaction (invariant P2). Every string that leaves the extension
 * host as a log line, error message, or webview message passes through a
 * SecretRedactor that has been told about every key the session has seen.
 */

const MIN_SECRET_LENGTH = 6;

export class SecretRedactor {
  private readonly secrets = new Set<string>();

  /** Register key material the moment it enters the host, before any use. */
  register(secret: string): void {
    if (secret && secret.length >= MIN_SECRET_LENGTH) {
      this.secrets.add(secret);
    }
  }

  redact(text: string): string {
    let out = text;
    for (const secret of this.secrets) {
      out = out.split(secret).join('[REDACTED]');
    }
    // Defense in depth: OpenRouter keys have a recognizable prefix; scrub
    // anything key-shaped even if it was never registered.
    out = out.replace(/sk-or-[A-Za-z0-9-_]{8,}/g, '[REDACTED]');
    return out;
  }
}

export interface Logger {
  info(message: string): void;
  error(message: string): void;
}

/** A Logger whose every line is redacted before reaching the sink. */
export class RedactingLogger implements Logger {
  constructor(
    private readonly sink: (line: string) => void,
    private readonly redactor: SecretRedactor,
  ) {}

  info(message: string): void {
    this.sink(this.redactor.redact(message));
  }

  error(message: string): void {
    this.sink(this.redactor.redact(`ERROR: ${message}`));
  }
}

/** Format an unknown thrown value into a plain message (no stacks with paths into user code, no raw objects). */
export function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
