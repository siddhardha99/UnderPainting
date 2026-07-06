import * as path from 'node:path';

/**
 * Write-scope guard (invariants P5/P9). All filesystem writes in the
 * extension go through this module, and this module refuses any target
 * outside the workspace's `.design/` directory. User-chosen export paths
 * (M1) will add a separate, diff-preview-and-confirm flow — they do not
 * loosen this guard.
 */

export const DESIGN_DIR = '.design';

export class WriteScopeError extends Error {}

/**
 * Resolves `target` (relative to the workspace root, or absolute) and throws
 * unless it falls inside `<workspaceRoot>/.design/`. Path traversal via `..`
 * and sibling-prefix tricks (`.design-evil/`) are rejected by resolving first
 * and comparing against the directory boundary, not the raw string.
 */
export function assertWritablePath(workspaceRoot: string, target: string): string {
  const root = path.resolve(workspaceRoot);
  const designRoot = path.join(root, DESIGN_DIR);
  const resolved = path.resolve(root, target);
  if (resolved !== designRoot && !resolved.startsWith(designRoot + path.sep)) {
    throw new WriteScopeError(
      `Write blocked: "${target}" resolves outside ${DESIGN_DIR}/. Underpainting only writes inside the workspace's ${DESIGN_DIR}/ directory.`,
    );
  }
  return resolved;
}
