import { z } from 'zod';

/**
 * The host↔webview message bus contract. Both sides validate every message
 * against these schemas (invariant P6). All object schemas are `.strict()`
 * so a message carrying anything beyond its declared fields — an API key,
 * for instance — fails validation instead of leaking through (P2).
 */

export const webviewToHostSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }).strict(),
  // A 'generate' message is the explicit user action behind every API call (P3).
  z.object({ type: z.literal('generate'), prompt: z.string().min(1).max(20_000) }).strict(),
  z.object({ type: z.literal('cancel') }).strict(),
]);
export type WebviewToHost = z.infer<typeof webviewToHostSchema>;

export const hostToWebviewSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('keyState'), present: z.boolean() }).strict(),
  z.object({ type: z.literal('streamStart') }).strict(),
  // `html` is the accumulated artifact so far; the webview patches, never reloads.
  z.object({ type: z.literal('streamChunk'), html: z.string() }).strict(),
  z
    .object({
      type: z.literal('streamDone'),
      costUsd: z.number().nullable(),
      promptTokens: z.number().nullable(),
      completionTokens: z.number().nullable(),
    })
    .strict(),
  z.object({ type: z.literal('streamCancelled') }).strict(),
  z.object({ type: z.literal('streamError'), message: z.string() }).strict(),
]);
export type HostToWebview = z.infer<typeof hostToWebviewSchema>;
