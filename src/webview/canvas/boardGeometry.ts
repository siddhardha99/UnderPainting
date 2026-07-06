/**
 * Canvas v1 geometry (v0.2 item 2b): pure math for the infinite surface.
 * The surface holds frames at absolute positions; the viewport shows it
 * through `translate(pan) scale(zoom)`. Everything here is unit-tested —
 * the acceptance bar (≤ LIVE_CAP live iframes regardless of board size)
 * lives in pickLive, not in DOM code.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FrameBox extends Rect {
  id: string;
}

export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 2;
/** Hard budget for live iframes on the board (NFR-1.6 / 2b acceptance). */
export const LIVE_CAP = 3;

/** The surface-space rectangle currently visible through the viewport. */
export function visibleRect(
  panX: number,
  panY: number,
  zoom: number,
  viewportWidth: number,
  viewportHeight: number,
): Rect {
  return {
    x: -panX / zoom,
    y: -panY / zoom,
    width: viewportWidth / zoom,
    height: viewportHeight / zoom,
  };
}

/** New pan so the surface point under `anchor` (viewport coords) stays put across a zoom change. */
export function zoomAt(
  panX: number,
  panY: number,
  zoom: number,
  nextZoom: number,
  anchorX: number,
  anchorY: number,
): { panX: number; panY: number; zoom: number } {
  const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, nextZoom));
  const surfaceX = (anchorX - panX) / zoom;
  const surfaceY = (anchorY - panY) / zoom;
  return {
    panX: anchorX - surfaceX * clamped,
    panY: anchorY - surfaceY * clamped,
    zoom: clamped,
  };
}

/** Pan/zoom that centers `frame` in the viewport at a zoom fitting it with margin. */
export function fitFrame(
  frame: Rect,
  viewportWidth: number,
  viewportHeight: number,
  margin = 48,
): { panX: number; panY: number; zoom: number } {
  const zoom = Math.min(
    ZOOM_MAX,
    Math.max(
      ZOOM_MIN,
      Math.min((viewportWidth - margin * 2) / frame.width, (viewportHeight - margin * 2) / frame.height),
    ),
  );
  return {
    panX: viewportWidth / 2 - (frame.x + frame.width / 2) * zoom,
    panY: viewportHeight / 2 - (frame.y + frame.height / 2) * zoom,
    zoom,
  };
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/**
 * The live-iframe set: the selected frame first, then visible frames by
 * distance to the viewport center, hard-capped at `cap` (default LIVE_CAP).
 * Twenty frames on the board → at most three live iframes; the rest are
 * placeholders that re-render from cache/store on promotion.
 */
export function pickLive(
  frames: FrameBox[],
  selectedId: string | null,
  view: Rect,
  cap = LIVE_CAP,
): Set<string> {
  const centerX = view.x + view.width / 2;
  const centerY = view.y + view.height / 2;
  const ranked = frames
    .filter((f) => intersects(f, view))
    .map((f) => ({
      id: f.id,
      distance: Math.hypot(f.x + f.width / 2 - centerX, f.y + f.height / 2 - centerY),
    }))
    .sort((a, b) => a.distance - b.distance);

  const live = new Set<string>();
  if (selectedId && frames.some((f) => f.id === selectedId)) {
    live.add(selectedId);
  }
  for (const candidate of ranked) {
    if (live.size >= cap) break;
    live.add(candidate.id);
  }
  return live;
}

/** Default placement for version `index` when the manifest records no position: a 3-column grid. */
export function defaultPosition(index: number, frameWidth = 1280, frameHeight = 1400): { x: number; y: number } {
  const GAP_X = 96;
  const GAP_Y = 140;
  const column = index % 3;
  const row = Math.floor(index / 3);
  return { x: 48 + column * (frameWidth + GAP_X), y: 48 + row * (frameHeight + GAP_Y) };
}
