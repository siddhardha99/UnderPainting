import { hostToWebviewSchema, type HostToWebview } from '../../shared/messages';
import type { SecretRedactor } from '../logging/redact';

/**
 * The single choke point for host→webview traffic. Every outgoing message is
 * (a) schema-validated — strict schemas reject any field the contract does
 * not declare, so key material cannot ride along (P2/P6) — and (b) has all
 * string fields passed through the redactor as defense in depth.
 */
export function createHostPoster(
  rawPost: (message: unknown) => void,
  redactor: SecretRedactor,
): (message: HostToWebview) => void {
  return (message) => {
    const validated = hostToWebviewSchema.parse(message);
    rawPost(redactStrings(validated, redactor));
  };
}

function redactStrings<T>(value: T, redactor: SecretRedactor): T {
  if (typeof value === 'string') {
    return redactor.redact(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactStrings(v, redactor)) as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactStrings(v, redactor);
    }
    return out as T;
  }
  return value;
}
