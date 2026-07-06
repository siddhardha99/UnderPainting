import { z } from 'zod';

/**
 * The host↔webview message bus contract. Both sides validate every message
 * against these schemas (invariant P6). All object schemas are `.strict()`
 * so a message carrying anything beyond its declared fields — an API key,
 * for instance — fails validation instead of leaking through (P2).
 */

const frameId = z.string().min(1).max(64);

export const webviewToHostSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }).strict(),
  // A 'generate' message is the explicit user action behind every API call (P3).
  z.object({ type: z.literal('generate'), prompt: z.string().min(1).max(20_000) }).strict(),
  z.object({ type: z.literal('cancel') }).strict(),
  // Frame interactions (ADR-009) — all local file operations, free (P4).
  z.object({ type: z.literal('selectFrame'), id: frameId }).strict(),
  z.object({ type: z.literal('requestFrame'), id: frameId }).strict(),
  z.object({ type: z.literal('restore'), id: frameId }).strict(),
]);
export type WebviewToHost = z.infer<typeof webviewToHostSchema>;

/** What the canvas needs to render a frame card without reading its snapshot. */
export const frameMetaSchema = z
  .object({
    id: frameId,
    title: z.string(),
    subtitle: z.string(),
    isCurrent: z.boolean(),
  })
  .strict();
export type FrameMeta = z.infer<typeof frameMetaSchema>;

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
  // The full frame index (sent on ready and after every commit/restore).
  // justCommitted lets the webview adopt its streaming placeholder card
  // instead of re-rendering the frame it just watched stream in.
  z
    .object({
      type: z.literal('frames'),
      frames: z.array(frameMetaSchema),
      currentId: frameId.nullable(),
      justCommitted: frameId.nullable(),
    })
    .strict(),
  // Snapshot content for one frame, in response to requestFrame.
  z.object({ type: z.literal('frameContent'), id: frameId, html: z.string() }).strict(),
]);
export type HostToWebview = z.infer<typeof hostToWebviewSchema>;
