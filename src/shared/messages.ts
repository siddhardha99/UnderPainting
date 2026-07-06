import { z } from 'zod';

/** Clarify-before-spend answers (v0.2 item 1) — collected by a local, deterministic form; asking is free. */
export const clarificationsSchema = z
  .object({
    artifactType: z.enum(['component', 'page']).optional(),
    style: z.string().max(500).optional(),
    colors: z.string().max(500).optional(),
    variations: z.number().int().min(1).max(4).optional(),
    constraints: z.string().max(2000).optional(),
  })
  .strict();
export type Clarifications = z.infer<typeof clarificationsSchema>;

/**
 * The host↔webview message bus contract. Both sides validate every message
 * against these schemas (invariant P6). All object schemas are `.strict()`
 * so a message carrying anything beyond its declared fields — an API key,
 * for instance — fails validation instead of leaking through (P2).
 */

const frameId = z.string().min(1).max(64);

export const webviewToHostSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }).strict(),
  // 'generate' and 'refine' are the explicit user actions behind every API call (P3).
  z
    .object({
      type: z.literal('generate'),
      prompt: z.string().min(1).max(20_000),
      clarifications: clarificationsSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('refine'),
      frameId,
      instruction: z.string().min(1).max(20_000),
    })
    .strict(),
  z.object({ type: z.literal('cancel') }).strict(),
  // Frame interactions (ADR-009) — all local file operations, free (P4).
  z.object({ type: z.literal('selectFrame'), id: frameId }).strict(),
  z.object({ type: z.literal('requestFrame'), id: frameId }).strict(),
  z.object({ type: z.literal('restore'), id: frameId }).strict(),
  // A finished direct-edit session (M1 item 4): the edited document commits
  // as a new snapshot of .design/ — a local write, zero API involvement (P4).
  z
    .object({
      type: z.literal('commitEdit'),
      frameId,
      html: z.string().min(1).max(5_000_000),
      editCount: z.number().int().min(1).max(10_000),
    })
    .strict(),
  // Canvas v1 (v0.2 item 2b): drag-arrange persists to the project manifest —
  // a local pointer write, free (P4/P5).
  z
    .object({
      type: z.literal('moveFrame'),
      id: frameId,
      x: z.number().min(-1_000_000).max(1_000_000),
      y: z.number().min(-1_000_000).max(1_000_000),
    })
    .strict(),
  // Variation split (folds the clarify-variations follow-up into the board):
  // one multi-variation artifact becomes N sibling versions — local, free.
  z
    .object({
      type: z.literal('splitFrame'),
      frameId,
      variations: z
        .array(
          z.object({ label: z.string().min(1).max(64), html: z.string().min(1).max(5_000_000) }).strict(),
        )
        .min(2)
        .max(4),
    })
    .strict(),
]);
export type WebviewToHost = z.infer<typeof webviewToHostSchema>;

/**
 * What the canvas needs to render a frame card — and, since the chat history
 * is derived from the version list, one committed chat exchange — without
 * ever reading a snapshot body.
 */
export const frameMetaSchema = z
  .object({
    id: frameId,
    title: z.string(),
    subtitle: z.string(),
    /** The full prompt/instruction that produced this version (chat user bubble). */
    prompt: z.string(),
    isCurrent: z.boolean(),
    /** False when validator issues survived the correction cap (badge on the frame). */
    validated: z.boolean(),
    /** Board position from the manifest; null → the webview assigns the default grid slot (2b). */
    position: z.object({ x: z.number(), y: z.number() }).strict().nullable(),
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
  // Validator outcome for the just-committed generation (M1 item 6): issues
  // that survived the bounded correction loop are surfaced, never silent.
  z
    .object({
      type: z.literal('validation'),
      issues: z.array(z.string()).max(64),
      correctionPasses: z.number().int().min(0),
    })
    .strict(),
  // The active generation model + its catalog pricing (cached at pick time,
  // never fetched for display — P3), shown at the point of spend (P4).
  z
    .object({
      type: z.literal('modelState'),
      modelId: z.string().nullable(),
      pricing: z.string().nullable(),
    })
    .strict(),
  // Whether a workspace folder is open — without one, versions/frames/history
  // cannot persist (P5) and the canvas says so upfront.
  z.object({ type: z.literal('workspaceState'), open: z.boolean() }).strict(),
  // Design-system grounding state (M1 item 5): shown as a non-blocking hint.
  // Re-extraction is never silent (§6) — the user runs the command.
  z
    .object({
      type: z.literal('systemState'),
      tokensPresent: z.boolean(),
      tokenCount: z.number(),
      stale: z.boolean(),
    })
    .strict(),
]);
export type HostToWebview = z.infer<typeof hostToWebviewSchema>;

/**
 * Messages the artifact iframe's trusted bootstrap posts to the canvas
 * (M1 item 4). The canvas only accepts them from the selected frame's
 * contentWindow and validates every one — the iframe is still treated as
 * hostile even though only the nonce'd bootstrap can run script there (P6).
 */
export const artifactToCanvasSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('textEdit'),
      /** childNodes index path from the artifact root to the edited leaf. */
      path: z.array(z.number().int().min(0).max(10_000)).max(64),
      /** The leaf's text before editing — the splice verifies it and fails closed on mismatch. */
      before: z.string().max(100_000),
      text: z.string().max(100_000),
    })
    .strict(),
]);
export type ArtifactToCanvas = z.infer<typeof artifactToCanvasSchema>;
