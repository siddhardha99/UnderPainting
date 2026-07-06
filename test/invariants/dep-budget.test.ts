import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Dependency budget (§4): fewer than 10 direct runtime dependencies at v0.1,
 * hard cap 15. Also: no lifecycle install scripts — a post-install script is
 * an arbitrary-code surface the invariants cannot see.
 */

const pkg = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'),
) as {
  dependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};

describe('dependency budget', () => {
  const runtimeDeps = Object.keys(pkg.dependencies ?? {});

  it('stays under the v0.1 budget of 10 direct runtime dependencies', () => {
    expect(runtimeDeps.length, runtimeDeps.join(', ')).toBeLessThan(10);
  });

  it('never exceeds the hard cap of 15', () => {
    expect(runtimeDeps.length).toBeLessThanOrEqual(15);
  });

  it('declares no lifecycle install scripts', () => {
    const scripts = pkg.scripts ?? {};
    for (const banned of ['preinstall', 'install', 'postinstall', 'prepare']) {
      expect(scripts[banned], `scripts.${banned} must not exist`).toBeUndefined();
    }
  });
});
