import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DocumentStore, SchemaVersionError, PROJECT_SLUG } from '../../src/host/store/DocumentStore';
import { ulid } from '../../src/host/store/ulid';

let root: string;
let store: DocumentStore;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'underpainting-store-'));
  store = new DocumentStore(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function commitInput(html: string, prompt = 'a card') {
  return {
    html,
    prompt,
    model: 'test/model',
    costUsd: 0.01,
    promptTokens: 10,
    completionTokens: 20,
  };
}

describe('ulid', () => {
  it('is 26 chars of Crockford base32 and time-ordered', () => {
    const a = ulid(1_000_000_000_000);
    const b = ulid(1_000_000_000_001);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(b > a).toBe(true); // later millisecond sorts later
    expect(ulid()).not.toBe(ulid()); // randomness within the same ms
  });
});

describe('DocumentStore (P5: the workspace is the truth)', () => {
  it('commits a version as an immutable snapshot and points current at it', async () => {
    const meta = await store.commitVersion(commitInput('<p>v1</p>'));
    const listed = await store.listVersions();
    expect(listed.currentId).toBe(meta.id);
    expect(listed.versions).toHaveLength(1);
    expect(await store.readVersion(meta.id)).toBe('<p>v1</p>');
    expect(listed.versions[0]!.model).toBe('test/model');
    expect(listed.versions[0]!.costUsd).toBeCloseTo(0.01);
  });

  it('never mutates earlier snapshots on later commits', async () => {
    const first = await store.commitVersion(commitInput('<p>v1</p>'));
    const firstPath = path.join(root, '.design', 'projects', PROJECT_SLUG, 'versions', `${first.id}.html`);
    const before = await fs.stat(firstPath);
    const second = await store.commitVersion(commitInput('<p>v2</p>'));
    expect(second.id).not.toBe(first.id);
    expect(await store.readVersion(first.id)).toBe('<p>v1</p>');
    const after = await fs.stat(firstPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect((await store.listVersions()).currentId).toBe(second.id);
  });

  it('restore moves only the pointer', async () => {
    const first = await store.commitVersion(commitInput('<p>v1</p>'));
    await store.commitVersion(commitInput('<p>v2</p>'));
    await store.restore(first.id);
    const listed = await store.listVersions();
    expect(listed.currentId).toBe(first.id);
    expect(listed.versions).toHaveLength(2); // nothing deleted, nothing rewritten
    await expect(store.restore('01NOTAREALID0000000000000Z')).rejects.toThrow('Unknown version');
  });

  it('writes everything under .design/ only, with the shipped .gitignore', async () => {
    await store.commitVersion(commitInput('<p>v1</p>'));
    const entries = await fs.readdir(root);
    expect(entries).toEqual(['.design']);
    const gitignore = await fs.readFile(path.join(root, '.design', '.gitignore'), 'utf8');
    expect(gitignore).toContain('ledger.jsonl');
  });

  it('refuses to touch a manifest from a newer schema (read-only, never rewrite)', async () => {
    await store.commitVersion(commitInput('<p>v1</p>'));
    const manifestPath = path.join(root, '.design', 'projects', PROJECT_SLUG, 'artifact.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.schema_version = 2;
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    const written = await fs.readFile(manifestPath, 'utf8');
    await expect(store.commitVersion(commitInput('<p>v2</p>'))).rejects.toThrow(SchemaVersionError);
    expect(await fs.readFile(manifestPath, 'utf8')).toBe(written); // untouched
  });

  it('survives an orphan snapshot (crash between snapshot and manifest)', async () => {
    const meta = await store.commitVersion(commitInput('<p>v1</p>'));
    // Simulate the crash artifact: a snapshot with no manifest entry.
    await fs.writeFile(
      path.join(root, '.design', 'projects', PROJECT_SLUG, 'versions', 'ORPHAN.html'),
      '<p>orphan</p>',
    );
    const listed = await store.listVersions();
    expect(listed.versions.map((v) => v.id)).toEqual([meta.id]); // manifest is the index
    await expect(store.readVersion('ORPHAN')).rejects.toThrow('Unknown version');
  });
});
