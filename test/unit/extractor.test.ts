import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  extractDesignSystem,
  checkDrift,
  ExtractionCancelledError,
} from '../../src/host/extractor/DesignSystemExtractor';
import { SystemStore } from '../../src/host/store/SystemStore';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'underpainting-extract-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function write(relative: string, content: string): Promise<void> {
  const full = path.join(root, relative);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf8');
}

const THEME_CSS = `
:root {
  --brand: #1a2b3c;
  --spacing-unit: 8px;
}
html { --page-bg: white; }
.card { color: red; --not-theme-level: 1; }
`;

const TAILWIND_CONFIG = `
module.exports = {
  content: ['./src/**/*.tsx'],
  theme: {
    colors: {
      primary: { 500: '#3b82f6', 900: '#1e3a8a' },
      accent: '#f59e0b',
    },
    spacing: { sm: '0.5rem', lg: '2rem' },
  },
};
`;

const BUTTON_TSX = `
interface ButtonProps { label: string; onClick?: () => void; variant?: 'primary' | 'ghost'; }
export function Button({ label, onClick, variant }: ButtonProps) {
  return <button onClick={onClick}>{label}</button>;
}
`;

const APP_TSX = `
import { Button } from './Button';
export function App() {
  return <div><Button label="a" /><Button label="b" /><Card /></div>;
}
`;

describe('DesignSystemExtractor (M1 item 5 — heuristic, read-only, no code execution)', () => {
  it('extracts :root/html custom properties but not component-level ones', async () => {
    await write('src/styles/theme.css', THEME_CSS);
    const system = await extractDesignSystem(root);
    const names = system.tokens.map((t) => t.name);
    expect(names).toContain('--brand');
    expect(names).toContain('--spacing-unit');
    expect(names).toContain('--page-bg');
    expect(names).not.toContain('--not-theme-level');
    expect(system.tokens.find((t) => t.name === '--brand')!.value).toBe('#1a2b3c');
  });

  it('lifts classic Tailwind theme values into namespaced tokens without executing the config', async () => {
    await write('tailwind.config.js', TAILWIND_CONFIG);
    const system = await extractDesignSystem(root);
    const byName = new Map(system.tokens.map((t) => [t.name, t.value]));
    expect(byName.get('--color-primary-500')).toBe('#3b82f6');
    expect(byName.get('--color-accent')).toBe('#f59e0b');
    expect(byName.get('--spacing-sm')).toBe('0.5rem');
    // `content` globs are not theme values and must not leak in.
    expect([...byName.keys()].some((n) => n.includes('src'))).toBe(false);
  });

  it('inventories components with props and cross-file usage counts', async () => {
    await write('src/components/Button.tsx', BUTTON_TSX);
    await write('src/App.tsx', APP_TSX);
    const system = await extractDesignSystem(root);
    const button = system.components.find((c) => c.name === 'Button');
    expect(button).toBeDefined();
    expect(button!.props).toEqual(['label', 'onClick', 'variant']);
    expect(button!.usages).toBe(2);
  });

  it('skips node_modules and records source hashes for drift detection', async () => {
    await write('src/theme.css', THEME_CSS);
    await write('node_modules/pkg/evil.css', ':root { --evil: 1; }');
    const system = await extractDesignSystem(root);
    expect(system.tokens.some((t) => t.name === '--evil')).toBe(false);
    expect(system.sources.some((s) => s.path === 'src/theme.css')).toBe(true);

    expect(await checkDrift(root, system.sources)).toBe(false);
    await write('src/theme.css', THEME_CSS + '\n:root { --new: 1; }');
    expect(await checkDrift(root, system.sources)).toBe(true);
  });

  it('cancellation throws and truncation is reported, never silent', async () => {
    await write('a.css', THEME_CSS);
    await expect(
      extractDesignSystem(root, { isCancelled: () => true }),
    ).rejects.toBeInstanceOf(ExtractionCancelledError);

    for (let i = 0; i < 8; i++) {
      await write(`many/file${i}.css`, ':root { --x: 1; }');
    }
    const system = await extractDesignSystem(root, { maxFiles: 3 });
    expect(system.stats.truncated).toBe(true);
  });
});

describe('SystemStore persistence + grounding read-back', () => {
  it('writes tokens.css, components.md, and a manifest under .design/system/ only', async () => {
    await write('src/theme.css', THEME_CSS);
    await write('src/components/Button.tsx', BUTTON_TSX);
    const system = await extractDesignSystem(root);
    const store = new SystemStore(root);
    await store.write(system);

    const tokensCss = await store.readTokensCss();
    expect(tokensCss).toContain('--brand: #1a2b3c;');
    expect(tokensCss).toContain(':root {');

    const componentsMd = await fs.readFile(path.join(root, '.design/system/components.md'), 'utf8');
    expect(componentsMd).toContain('| Button |');

    const manifest = await store.readManifest();
    expect(manifest).not.toBeNull();
    expect(manifest!.schema_version).toBe(1);
    expect(manifest!.stats.tokenCount).toBe(system.tokens.length);
    expect(manifest!.sources.length).toBeGreaterThan(0);

    // Nothing outside .design/ was created by the store.
    const rootEntries = await fs.readdir(root);
    expect(rootEntries.sort()).toEqual(['.design', 'src'].sort());
  });

  it('readTokensCss returns null when nothing was extracted', async () => {
    expect(await new SystemStore(root).readTokensCss()).toBeNull();
    expect(await new SystemStore(root).readManifest()).toBeNull();
  });
});
