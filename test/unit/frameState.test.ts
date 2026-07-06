import { describe, expect, it } from 'vitest';
import {
  applyFrames,
  endPending,
  initialState,
  PENDING_ID,
  select,
  startPending,
} from '../../src/webview/canvas/frameState';
import type { FrameMeta } from '../../src/shared/messages';

function frame(id: string, isCurrent = false): FrameMeta {
  return { id, title: `t-${id}`, subtitle: `s-${id}`, prompt: `p-${id}`, isCurrent, validated: true };
}

describe('frame board state (ADR-009)', () => {
  it('a fresh board selects the current frame from the index', () => {
    const { state } = applyFrames(initialState(), [frame('a'), frame('b', true)], 'b', null);
    expect(state.selectedId).toBe('b');
    expect(state.currentId).toBe('b');
  });

  it('generation selects the pending frame; commit adopts it', () => {
    let state = applyFrames(initialState(), [frame('a', true)], 'a', null).state;
    state = startPending(state);
    expect(state.selectedId).toBe(PENDING_ID);

    const result = applyFrames(state, [frame('a'), frame('b', true)], 'b', 'b');
    expect(result.adoptPendingAs).toBe('b');
    expect(result.state.selectedId).toBe('b');
    expect(result.state.pendingId).toBeNull();
  });

  it('a frames refresh without a commit preserves the selection', () => {
    let state = applyFrames(initialState(), [frame('a', true), frame('b')], 'a', null).state;
    state = select(state, 'b');
    // e.g. a restore elsewhere re-sends the index
    const result = applyFrames(state, [frame('a'), frame('b', true)], 'b', null);
    expect(result.state.selectedId).toBe('b');
    expect(result.adoptPendingAs).toBeNull();
  });

  it('selection falls back to current when the selected frame disappears', () => {
    let state = applyFrames(initialState(), [frame('a', true), frame('b')], 'a', null).state;
    state = select(state, 'b');
    const result = applyFrames(state, [frame('a', true)], 'a', null);
    expect(result.state.selectedId).toBe('a');
  });

  it('a commit without a streaming placeholder (direct-edit save) selects the new version', () => {
    let state = applyFrames(initialState(), [frame('a', true)], 'a', null).state;
    state = select(state, 'a');
    const result = applyFrames(state, [frame('a'), frame('b', true)], 'b', 'b');
    expect(result.adoptPendingAs).toBeNull(); // nothing to adopt — no pending card
    expect(result.state.selectedId).toBe('b');
  });

  it('select ignores unknown ids', () => {
    const state = applyFrames(initialState(), [frame('a', true)], 'a', null).state;
    expect(select(state, 'nope').selectedId).toBe('a');
  });

  it('an uncommitted stream end clears pending without touching frames', () => {
    let state = applyFrames(initialState(), [frame('a', true)], 'a', null).state;
    state = startPending(state);
    state = endPending(state);
    expect(state.pendingId).toBeNull();
    expect(state.frames).toHaveLength(1);
  });
});
