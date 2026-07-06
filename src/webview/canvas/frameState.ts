import type { FrameMeta } from '../../shared/messages';

/**
 * Pure board state (ADR-009): which frames exist, which is selected, and
 * whether an ephemeral streaming frame is on the board. DOM rendering lives
 * in main.ts; every transition here is a plain function so the reconcile
 * rules — especially adopting the streaming placeholder after a commit —
 * are unit-testable without a DOM.
 */

export const PENDING_ID = '__pending__';

export interface BoardState {
  frames: FrameMeta[];
  currentId: string | null;
  selectedId: string | null;
  /** The ephemeral streaming frame's id (PENDING_ID) while a generation runs. */
  pendingId: string | null;
}

export function initialState(): BoardState {
  return { frames: [], currentId: null, selectedId: null, pendingId: null };
}

/** A generation started: put the ephemeral frame on the board and select it. */
export function startPending(state: BoardState): BoardState {
  return { ...state, pendingId: PENDING_ID, selectedId: PENDING_ID };
}

/** The stream ended without a commit (cancel/error/no workspace): keep state consistent. */
export function endPending(state: BoardState): BoardState {
  return { ...state, pendingId: null };
}

export function select(state: BoardState, id: string): BoardState {
  const exists = state.frames.some((f) => f.id === id) || id === state.pendingId;
  return exists ? { ...state, selectedId: id } : state;
}

/**
 * Present-mode stepping (v0.2 item 2a): the next version id in manifest
 * order, clamped at the ends — a slideshow through the design's history.
 */
export function stepFrame(frames: FrameMeta[], currentId: string, direction: -1 | 1): string {
  const index = frames.findIndex((f) => f.id === currentId);
  if (index === -1) return currentId;
  const next = Math.min(frames.length - 1, Math.max(0, index + direction));
  return frames[next]!.id;
}

export interface ApplyFramesResult {
  state: BoardState;
  /** Non-null when the streaming placeholder should be re-keyed to this committed id. */
  adoptPendingAs: string | null;
}

/**
 * Reconcile a host `frames` message. If this message announces the commit of
 * the generation we just streamed, the placeholder card is adopted (re-keyed)
 * rather than re-rendered — the pixels on screen are already the committed
 * content. Otherwise selection is preserved when possible, falling back to
 * the current version.
 */
export function applyFrames(
  state: BoardState,
  frames: FrameMeta[],
  currentId: string | null,
  justCommitted: string | null,
): ApplyFramesResult {
  if (justCommitted && state.pendingId) {
    return {
      state: { frames, currentId, selectedId: justCommitted, pendingId: null },
      adoptPendingAs: justCommitted,
    };
  }
  if (justCommitted) {
    // A commit without a streaming placeholder (e.g. a direct-edit save):
    // select the new version; its card renders and fetches its snapshot.
    return {
      state: { frames, currentId, selectedId: justCommitted, pendingId: state.pendingId },
      adoptPendingAs: null,
    };
  }
  let selectedId = state.selectedId;
  const stillExists =
    selectedId !== null && (frames.some((f) => f.id === selectedId) || selectedId === state.pendingId);
  if (!stillExists) {
    selectedId = currentId ?? frames.at(-1)?.id ?? state.pendingId;
  }
  return {
    state: { frames, currentId, selectedId: selectedId ?? null, pendingId: state.pendingId },
    adoptPendingAs: null,
  };
}
