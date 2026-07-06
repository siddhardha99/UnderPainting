import { describe, expect, it } from 'vitest';
import {
  defaultPosition,
  fitFrame,
  LIVE_CAP,
  pickLive,
  visibleRect,
  zoomAt,
  ZOOM_MAX,
  ZOOM_MIN,
  type FrameBox,
} from '../../src/webview/canvas/boardGeometry';

/**
 * Canvas v1 (2b) acceptance lives here: the live-iframe budget holds at any
 * board size, and pan/zoom math is exact.
 */

function grid(count: number): FrameBox[] {
  return Array.from({ length: count }, (_, i) => {
    const { x, y } = defaultPosition(i);
    return { id: `f${i}`, x, y, width: 1280, height: 1400 };
  });
}

describe('pickLive — the 2b acceptance bar', () => {
  it('20 frames on the board, everything visible → at most LIVE_CAP live iframes', () => {
    const frames = grid(20);
    // A zoomed-out viewport that sees the whole board.
    const view = { x: -1000, y: -1000, width: 20_000, height: 20_000 };
    const live = pickLive(frames, 'f7', view);
    expect(live.size).toBeLessThanOrEqual(LIVE_CAP);
    expect(live.has('f7')).toBe(true); // selected always wins a slot
  });

  it('prefers frames nearest the viewport center', () => {
    const frames = grid(9);
    const target = frames[4]!; // middle of the grid
    const view = {
      x: target.x - 200,
      y: target.y - 200,
      width: target.width + 400,
      height: target.height + 400,
    };
    const live = pickLive(frames, null, view);
    expect(live.has('f4')).toBe(true);
  });

  it('off-screen frames never go live, selected excepted', () => {
    const frames = grid(6);
    const farAway = { x: 1_000_000, y: 1_000_000, width: 500, height: 500 };
    expect(pickLive(frames, null, farAway).size).toBe(0);
    expect(pickLive(frames, 'f2', farAway).has('f2')).toBe(true);
  });
});

describe('pan/zoom math', () => {
  it('zoomAt keeps the surface point under the anchor fixed', () => {
    const before = { panX: 100, panY: 50, zoom: 0.5 };
    const anchor = { x: 400, y: 300 };
    const surfaceX = (anchor.x - before.panX) / before.zoom;
    const surfaceY = (anchor.y - before.panY) / before.zoom;
    const after = zoomAt(before.panX, before.panY, before.zoom, 1, anchor.x, anchor.y);
    expect(surfaceX * after.zoom + after.panX).toBeCloseTo(anchor.x);
    expect(surfaceY * after.zoom + after.panY).toBeCloseTo(anchor.y);
  });

  it('zoomAt clamps to the zoom range', () => {
    expect(zoomAt(0, 0, 1, 99, 0, 0).zoom).toBe(ZOOM_MAX);
    expect(zoomAt(0, 0, 1, 0.0001, 0, 0).zoom).toBe(ZOOM_MIN);
  });

  it('visibleRect inverts the surface transform', () => {
    const view = visibleRect(-500, -250, 0.5, 800, 600);
    expect(view).toEqual({ x: 1000, y: 500, width: 1600, height: 1200 });
  });

  it('fitFrame centers the frame with margin', () => {
    const frame = { x: 1000, y: 2000, width: 1280, height: 1400 };
    const { panX, panY, zoom } = fitFrame(frame, 800, 600);
    // Frame center maps to viewport center.
    expect((frame.x + frame.width / 2) * zoom + panX).toBeCloseTo(400);
    expect((frame.y + frame.height / 2) * zoom + panY).toBeCloseTo(300);
    // And it fits inside.
    expect(frame.width * zoom).toBeLessThanOrEqual(800);
    expect(frame.height * zoom).toBeLessThanOrEqual(600);
  });

  it('defaultPosition lays a 3-column grid with no overlap', () => {
    const a = defaultPosition(0);
    const b = defaultPosition(1);
    const d = defaultPosition(3);
    expect(b.x).toBeGreaterThan(a.x + 1280);
    expect(d.y).toBeGreaterThan(a.y + 1400);
    expect(d.x).toBe(a.x); // wraps to the next row
  });
});
