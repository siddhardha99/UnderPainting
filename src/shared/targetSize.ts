/**
 * Target sizes (2b revision): the artifact's viewport is a DESIGN-TIME
 * property — chosen in the clarify form or detected from the prompt, folded
 * into the generation request, and recorded in the manifest so the frame is
 * born at the right dimensions. This replaced the post-hoc
 * Mobile/Tablet/Desktop preview toggle, which re-cropped after generation
 * when the model had already designed for an unknown width.
 */

export type TargetKind = 'component' | 'mobile' | 'tablet' | 'desktop';

export interface TargetSize {
  width: number;
  height: number;
}

/** Fixed, conventional canvas sizes — predictability beats configurability in v0.2. */
export const TARGET_SIZES: Record<TargetKind, TargetSize> = {
  component: { width: 800, height: 600 },
  mobile: { width: 390, height: 844 },
  tablet: { width: 834, height: 1194 },
  desktop: { width: 1440, height: 1400 },
};

const MOBILE_WORDS = /\b(mobile|phone|ios|android|app screen|smartphone|handset)\b/i;
const TABLET_WORDS = /\b(tablet|ipad)\b/i;
const COMPONENT_WORDS =
  /\b(button|card|form|input|modal|dialog|dropdown|nav(?:bar)?|menu|table|list|badge|toast|tooltip|avatar|slider|toggle|tabs?|accordion|footer|header|sidebar|widget|component)\b/i;
const DESKTOP_WORDS =
  /\b(desktop|web ?site|web ?page|landing|dashboard|homepage|portfolio|pricing page|full page|web app)\b/i;

/** Deterministic target detection — same licensing logic as the clarify fields (A6-style). */
export function detectTarget(prompt: string): TargetKind | null {
  if (MOBILE_WORDS.test(prompt)) return 'mobile';
  if (TABLET_WORDS.test(prompt)) return 'tablet';
  if (DESKTOP_WORDS.test(prompt)) return 'desktop';
  if (COMPONENT_WORDS.test(prompt)) return 'component';
  return null;
}

/** The authoritative viewport line folded into the generation request. */
export function describeTarget(kind: TargetKind): string {
  const size = TARGET_SIZES[kind];
  const label = {
    component: 'a single component on a canvas',
    mobile: 'a mobile app screen',
    tablet: 'a tablet screen',
    desktop: 'a desktop web page',
  }[kind];
  return `${label} — design for a ${size.width}×${size.height} viewport; use the full width, no device chrome`;
}
