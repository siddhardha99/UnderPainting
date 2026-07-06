import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertWritablePath, WriteScopeError } from '../../src/host/store/writeScope';

/**
 * Invariants P5/P9: the extension writes only inside the workspace's
 * .design/ directory. Enforced twice: unit checks on the path guard, and a
 * static scan proving filesystem writes exist only in the store module.
 */

const ROOT = '/tmp/workspace';

describe('P5/P9: write-scope path guard', () => {
  it('permits paths inside .design/', () => {
    expect(() => assertWritablePath(ROOT, '.design/projects/x/versions/a.html')).not.toThrow();
    expect(() => assertWritablePath(ROOT, '.design/ledger.jsonl')).not.toThrow();
    expect(() => assertWritablePath(ROOT, '.design')).not.toThrow();
    expect(() => assertWritablePath(ROOT, path.join(ROOT, '.design/system/tokens.css'))).not.toThrow();
  });

  it('blocks everything outside .design/', () => {
    const blocked = [
      'src/app.ts',
      'package.json',
      '.design/../package.json', // traversal
      '.design/../../etc/passwd',
      '.designer/x.html', // sibling-prefix trap
      '.design-evil/x.html',
      '/etc/passwd', // absolute escape
      path.join(ROOT, 'settings.json'),
    ];
    for (const target of blocked) {
      expect(() => assertWritablePath(ROOT, target), target).toThrow(WriteScopeError);
    }
  });
});

describe('P5/P9: filesystem writes exist only in src/host/store/', () => {
  const writePatterns: Array<[string, RegExp]> = [
    ['fs write/append', /\bfs\w*\.(writeFile|appendFile|writeFileSync|appendFileSync|createWriteStream)\b/],
    ['fs mkdir/rm/rename', /\bfs\w*\.(mkdir|mkdirSync|rm|rmSync|rmdir|unlink|unlinkSync|rename|renameSync|cp|cpSync|copyFile)\b/],
    ['vscode workspace fs mutation', /workspace\.fs\.(writeFile|delete|createDirectory|rename|copy)\b/],
  ];

  it('finds no write primitives outside the store module', () => {
    const srcRoot = path.resolve(__dirname, '../../src');
    const offenders: string[] = [];
    for (const file of walk(srcRoot)) {
      const rel = path.relative(path.resolve(__dirname, '../..'), file);
      if (rel.startsWith(path.join('src', 'host', 'store'))) continue;
      const text = fs.readFileSync(file, 'utf8');
      for (const [label, pattern] of writePatterns) {
        if (pattern.test(text)) {
          offenders.push(`${rel}: ${label}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
      yield full;
    }
  }
}
