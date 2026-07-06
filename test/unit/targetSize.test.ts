import { describe, expect, it } from 'vitest';
import { detectTarget, describeTarget, TARGET_SIZES } from '../../src/shared/targetSize';

describe('target sizes (2b revision) — design-time viewports', () => {
  it('detects the target from prompt vocabulary', () => {
    expect(detectTarget('design a mobile app for watching videos')).toBe('mobile');
    expect(detectTarget('an iPad reading experience')).toBe('tablet');
    expect(detectTarget('a landing page for Inkwell')).toBe('desktop');
    expect(detectTarget('a signup button')).toBe('component');
    expect(detectTarget('something for our product')).toBeNull();
  });

  it('mobile beats component when both appear ("app screen with a nav bar")', () => {
    expect(detectTarget('a mobile app screen with a nav bar')).toBe('mobile');
  });

  it('describes each target with its exact viewport', () => {
    for (const kind of ['component', 'mobile', 'tablet', 'desktop'] as const) {
      const { width, height } = TARGET_SIZES[kind];
      expect(describeTarget(kind)).toContain(`${width}×${height}`);
    }
  });
});
