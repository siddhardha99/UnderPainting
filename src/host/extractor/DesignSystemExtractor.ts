import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * DesignSystemExtractor (M1 item 5): heuristic, READ-ONLY extraction of the
 * design system already in the workspace — CSS custom properties from
 * `:root`/`html` rules, tokens from a classic `tailwind.config.*` theme, and
 * a component inventory (names, props, usage counts).
 *
 * Deliberate properties:
 * - Never executes workspace code. The Tailwind config is parsed statically
 *   with a small object-literal scanner — a `tailwind.config.js` is arbitrary
 *   JS and require()ing it would run untrusted code in the extension host.
 * - Purely heuristic and purely local (free). Model-written component notes
 *   would be an API call and therefore need explicit user action (P3) —
 *   deferred, not smuggled in.
 * - Async and cancellable; bounded by file-count and file-size caps so a 10k
 *   file workspace stays well under the 30s budget. Truncation is reported,
 *   never silent.
 * - This module only READS. Persisting the results goes through
 *   src/host/store/SystemStore.ts (the write-scope invariant).
 */

export interface TokenEntry {
  name: string; // includes the leading --
  value: string;
  source: string; // workspace-relative path
}

export interface ComponentEntry {
  name: string;
  file: string;
  props: string[];
  usages: number;
}

export interface SourceHash {
  path: string;
  hash: string; // sha256 hex of file contents
}

export interface ExtractedSystem {
  tokens: TokenEntry[];
  components: ComponentEntry[];
  sources: SourceHash[];
  stats: { filesScanned: number; durationMs: number; truncated: boolean };
}

export interface ExtractorOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  isCancelled?: () => boolean;
}

export class ExtractionCancelledError extends Error {
  constructor() {
    super('Design-system extraction cancelled.');
  }
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'vendor',
  '.design', '.vscode-test', '.next', '.nuxt', 'target', '.cache',
]);
const CSS_EXTENSIONS = new Set(['.css', '.scss', '.less', '.pcss']);
const COMPONENT_EXTENSIONS = new Set(['.tsx', '.jsx']);
const USAGE_EXTENSIONS = new Set(['.tsx', '.jsx', '.ts', '.js', '.vue', '.svelte', '.html']);
const TAILWIND_CONFIG = /^tailwind\.config\.(js|cjs|mjs|ts)$/;

const DEFAULT_MAX_FILES = 4000;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;

export async function extractDesignSystem(
  workspaceRoot: string,
  options: ExtractorOptions = {},
): Promise<ExtractedSystem> {
  const started = Date.now();
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const isCancelled = options.isCancelled ?? (() => false);

  const tokens = new Map<string, TokenEntry>();
  const components: ComponentEntry[] = [];
  const usageCounts = new Map<string, number>();
  const sources: SourceHash[] = [];
  let filesScanned = 0;
  let truncated = false;

  const files: string[] = [];
  await walk(workspaceRoot, workspaceRoot, files, maxFiles, () => {
    truncated = true;
  });

  for (const file of files) {
    if (isCancelled()) throw new ExtractionCancelledError();
    const relative = path.relative(workspaceRoot, file).split(path.sep).join('/');
    const extension = path.extname(file).toLowerCase();
    const base = path.basename(file);

    const wantsCss = CSS_EXTENSIONS.has(extension);
    const wantsTailwind = TAILWIND_CONFIG.test(base);
    const wantsComponent = COMPONENT_EXTENSIONS.has(extension) && /^[A-Z]/.test(base);
    const wantsUsage = USAGE_EXTENSIONS.has(extension);
    if (!wantsCss && !wantsTailwind && !wantsComponent && !wantsUsage) continue;

    let content: string;
    try {
      const stat = await fs.stat(file);
      if (stat.size > maxFileBytes) continue;
      content = await fs.readFile(file, 'utf8');
    } catch {
      continue; // unreadable file: skip, never fail the whole extraction
    }
    filesScanned++;

    let contributed = false;
    if (wantsCss) {
      contributed = collectCssCustomProperties(content, relative, tokens) || contributed;
    }
    if (wantsTailwind) {
      contributed = collectTailwindTokens(content, relative, tokens) || contributed;
    }
    if (wantsComponent) {
      const entry = collectComponent(content, relative);
      if (entry) {
        components.push(entry);
        contributed = true;
      }
    }
    if (wantsUsage) {
      for (const match of content.matchAll(/<([A-Z][A-Za-z0-9]*)[\s/>]/g)) {
        usageCounts.set(match[1]!, (usageCounts.get(match[1]!) ?? 0) + 1);
      }
    }
    if (contributed) {
      sources.push({ path: relative, hash: sha256(content) });
    }
  }

  for (const component of components) {
    // A component's own JSX usually references itself 0 times; counts are cross-file.
    component.usages = usageCounts.get(component.name) ?? 0;
  }
  components.sort((a, b) => b.usages - a.usages || a.name.localeCompare(b.name));

  return {
    tokens: [...tokens.values()],
    components,
    sources,
    stats: { filesScanned, durationMs: Date.now() - started, truncated },
  };
}

/** Re-hash the recorded sources; any change (or disappearance) is drift (§6). */
export async function checkDrift(workspaceRoot: string, sources: SourceHash[]): Promise<boolean> {
  for (const source of sources.slice(0, 500)) {
    try {
      const content = await fs.readFile(path.join(workspaceRoot, source.path), 'utf8');
      if (sha256(content) !== source.hash) return true;
    } catch {
      return true; // a contributing file vanished
    }
  }
  return false;
}

async function walk(
  root: string,
  dir: string,
  out: string[],
  maxFiles: number,
  onTruncate: () => void,
): Promise<void> {
  if (out.length >= maxFiles) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= maxFiles) {
      onTruncate();
      return;
    }
    if (entry.name.startsWith('.') && entry.name !== '.') {
      if (entry.isDirectory()) continue; // hidden dirs: skip
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        await walk(root, full, out, maxFiles, onTruncate);
      }
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}

function collectCssCustomProperties(
  content: string,
  source: string,
  tokens: Map<string, TokenEntry>,
): boolean {
  let contributed = false;
  // Theme-level rules only: :root / html blocks (covers plain CSS and the
  // common SCSS pattern). Tailwind v4 @theme blocks are an open question (§14).
  for (const block of content.matchAll(/(?::root|html)[^{}]*\{([^}]*)\}/g)) {
    for (const declaration of block[1]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      const name = declaration[1]!;
      if (!tokens.has(name)) {
        tokens.set(name, { name, value: declaration[2]!.trim(), source });
        contributed = true;
      }
    }
  }
  return contributed;
}

/**
 * Static Tailwind classic-config scan: finds `colors`, `spacing`, and
 * `fontFamily` object literals in the theme and lifts their string/number
 * leaves into namespaced custom properties. Heuristic by design — nothing is
 * evaluated, so computed themes contribute nothing rather than executing.
 */
function collectTailwindTokens(
  content: string,
  source: string,
  tokens: Map<string, TokenEntry>,
): boolean {
  let contributed = false;
  const sections: Array<[string, string]> = [
    ['colors', '--color'],
    ['spacing', '--spacing'],
    ['fontFamily', '--font'],
  ];
  for (const [section, prefix] of sections) {
    const literal = findObjectLiteral(content, section);
    if (!literal) continue;
    for (const [keyPath, value] of scanLiteralLeaves(literal)) {
      const suffix = keyPath.filter((k) => k.toLowerCase() !== 'default').join('-');
      const name = suffix ? `${prefix}-${suffix}` : prefix;
      if (!tokens.has(name)) {
        tokens.set(name, { name, value, source });
        contributed = true;
      }
    }
  }
  return contributed;
}

/** Returns the balanced `{...}` following `<key> :`, or null. */
function findObjectLiteral(content: string, key: string): string | null {
  const keyMatch = new RegExp(`(?:^|[\\s{,])(?:['"]?)${key}(?:['"]?)\\s*:\\s*\\{`).exec(content);
  if (!keyMatch) return null;
  const start = keyMatch.index + keyMatch[0].length - 1;
  let depth = 0;
  for (let i = start; i < content.length; i++) {
    const c = content[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return content.slice(start, i + 1);
    }
  }
  return null;
}

/** Yields [keyPath, value] for quoted-string/number leaves of a nested object literal. */
function scanLiteralLeaves(literal: string): Array<[string[], string]> {
  const results: Array<[string[], string]> = [];
  const stack: string[] = [];
  const entry =
    /(['"]?)([\w./-]+)\1\s*:\s*(?:(['"])((?:\\.|(?!\3).)*)\3|(-?[\d.]+)|(\{))|(\})/g;
  let match: RegExpExecArray | null;
  while ((match = entry.exec(literal)) !== null) {
    if (match[7]) {
      stack.pop();
      continue;
    }
    const key = match[2]!;
    if (match[6]) {
      stack.push(key);
    } else {
      const value = match[4] ?? match[5]!;
      if (value !== undefined && stack.length <= 4) {
        results.push([[...stack, key], String(value)]);
      }
    }
  }
  return results;
}

/** Heuristic component read: PascalCase file name + props from interface or destructuring. */
function collectComponent(content: string, file: string): ComponentEntry | null {
  const name = path.basename(file).replace(/\.(tsx|jsx)$/i, '');
  if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) return null;
  const props = new Set<string>();
  const propsInterface = new RegExp(`(?:interface|type)\\s+${name}Props[^{]*\\{([^}]*)\\}`).exec(content);
  if (propsInterface) {
    for (const line of propsInterface[1]!.matchAll(/^\s*(\w+)\??\s*[:(]/gm)) {
      props.add(line[1]!);
    }
  }
  const destructured = new RegExp(
    `(?:function\\s+${name}|const\\s+${name}\\s*=)[^(]*\\(\\s*\\{([^}]*)\\}`,
  ).exec(content);
  if (destructured) {
    for (const part of destructured[1]!.split(',')) {
      const prop = part.trim().split(/[=:\s]/)[0];
      if (prop && /^\w+$/.test(prop)) props.add(prop);
    }
  }
  return { name, file, props: [...props].sort(), usages: 0 };
}

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}
