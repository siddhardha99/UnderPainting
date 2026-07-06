import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { assertWritablePath, DESIGN_DIR } from './writeScope';
import { ulid } from './ulid';
import { clarificationsSchema, type Clarifications } from '../../shared/messages';

/**
 * DocumentStore (M1 item 2): the workspace is the truth (P5). Versions are
 * immutable snapshot files; the manifest is the only mutable file and only
 * its pointer/index change. The store commits only complete states — the
 * orchestrator calls it strictly after a stream finishes successfully, so a
 * cancelled or failed stream never touches disk.
 *
 * Every version is a *frame* (ADR-009): the metadata here is exactly what
 * the canvas needs to title and select frames without reading snapshots.
 *
 * Write path: this module lives in src/host/store/ (the only module allowed
 * filesystem writes — see test/invariants/write-scope.test.ts) and resolves
 * every target through assertWritablePath.
 */

/** v0.1 keeps a single project per workspace; multi-project is a container change later. */
export const PROJECT_SLUG = 'main';

export const versionMetaSchema = z
  .object({
    id: z.string().min(1),
    created: z.string(), // ISO 8601
    model: z.string(),
    costUsd: z.number().nullable(),
    promptTokens: z.number().nullable(),
    completionTokens: z.number().nullable(),
    prompt: z.string(),
    /** Validator outcome (M1 item 6); absent on pre-validator versions = treated as validated. */
    validated: z.boolean().optional(),
    issues: z.array(z.string()).optional(),
    /** Clarify-form answers (v0.2 item 1) — recorded for reproducibility. */
    clarifications: clarificationsSchema.optional(),
    /** Board position (v0.2 item 2b): the manifest's only per-version mutable field; snapshots stay immutable. */
    position: z.object({ x: z.number(), y: z.number() }).strict().optional(),
    /** Design-time viewport (2b revision); absent on older versions → desktop default. */
    size: z.object({ width: z.number(), height: z.number() }).strict().optional(),
  })
  .strict();
export type VersionMeta = z.infer<typeof versionMetaSchema>;

export const artifactManifestSchema = z
  .object({
    schema_version: z.literal(1),
    type: z.literal('page'),
    current: z.string().nullable(),
    versions: z.array(versionMetaSchema),
  })
  .strict();
export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;

export class SchemaVersionError extends Error {}

const EMPTY_MANIFEST: ArtifactManifest = {
  schema_version: 1,
  type: 'page',
  current: null,
  versions: [],
};

export interface CommitInput {
  html: string;
  prompt: string;
  model: string;
  costUsd: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  validated?: boolean;
  issues?: string[];
  clarifications?: Clarifications;
  size?: { width: number; height: number };
}

export class DocumentStore {
  private readonly projectDir: string;

  constructor(private readonly workspaceRoot: string) {
    this.projectDir = path.join(DESIGN_DIR, 'projects', PROJECT_SLUG);
  }

  private resolve(relative: string): string {
    return assertWritablePath(this.workspaceRoot, relative);
  }

  /** Create the .design/ skeleton and its .gitignore (spend stays personal, §6). */
  private async ensureLayout(): Promise<void> {
    await fs.mkdir(this.resolve(path.join(this.projectDir, 'versions')), { recursive: true });
    const gitignorePath = this.resolve(path.join(DESIGN_DIR, '.gitignore'));
    try {
      await fs.access(gitignorePath);
    } catch {
      await fs.writeFile(gitignorePath, 'ledger.jsonl\n', 'utf8');
    }
  }

  private manifestPath(): string {
    return this.resolve(path.join(this.projectDir, 'artifact.json'));
  }

  private versionPath(id: string): string {
    return this.resolve(path.join(this.projectDir, 'versions', `${id}.html`));
  }

  private async readManifest(): Promise<ArtifactManifest> {
    let raw: string;
    try {
      raw = await fs.readFile(this.manifestPath(), 'utf8');
    } catch {
      return EMPTY_MANIFEST;
    }
    const parsed: unknown = JSON.parse(raw);
    const result = artifactManifestSchema.safeParse(parsed);
    if (!result.success) {
      const version = (parsed as { schema_version?: unknown })?.schema_version;
      if (typeof version === 'number' && version > 1) {
        // Newer than we understand: surface read-only, never rewrite (SCHEMA.md).
        throw new SchemaVersionError(
          `.design manifest has schema_version ${version}, newer than this extension understands. ` +
            'Update Underpainting; the file was left untouched.',
        );
      }
      throw new Error(`Corrupt .design manifest: ${result.error.message}`);
    }
    return result.data;
  }

  private async writeManifest(manifest: ArtifactManifest): Promise<void> {
    await fs.writeFile(this.manifestPath(), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  }

  /**
   * Persist a completed generation as a new immutable version and point
   * `current` at it. Snapshot first, manifest second: a crash in between
   * leaves an orphan snapshot (harmless — the manifest is the index), never
   * a manifest entry without its file.
   */
  async commitVersion(input: CommitInput): Promise<VersionMeta> {
    await this.ensureLayout();
    const manifest = await this.readManifest();
    const meta: VersionMeta = {
      id: ulid(),
      created: new Date().toISOString(),
      model: input.model,
      costUsd: input.costUsd,
      promptTokens: input.promptTokens,
      completionTokens: input.completionTokens,
      prompt: input.prompt,
      validated: input.validated ?? true,
      issues: input.issues ?? [],
      ...(input.clarifications ? { clarifications: input.clarifications } : {}),
      ...(input.size ? { size: input.size } : {}),
    };
    await fs.writeFile(this.versionPath(meta.id), input.html, 'utf8');
    await this.writeManifest({
      ...manifest,
      current: meta.id,
      versions: [...manifest.versions, meta],
    });
    return meta;
  }

  async listVersions(): Promise<{ versions: VersionMeta[]; currentId: string | null }> {
    const manifest = await this.readManifest();
    return { versions: manifest.versions, currentId: manifest.current };
  }

  async readVersion(id: string): Promise<string> {
    const manifest = await this.readManifest();
    if (!manifest.versions.some((v) => v.id === id)) {
      throw new Error(`Unknown version id: ${id}`);
    }
    return fs.readFile(this.versionPath(id), 'utf8');
  }

  /** One-click restore: moves the pointer, touches nothing else. */
  async restore(id: string): Promise<void> {
    const manifest = await this.readManifest();
    if (!manifest.versions.some((v) => v.id === id)) {
      throw new Error(`Unknown version id: ${id}`);
    }
    await this.writeManifest({ ...manifest, current: id });
  }

  /** Persist a frame's board position (2b): manifest-only, git-diffable (P5); snapshots untouched. */
  async setPosition(id: string, position: { x: number; y: number }): Promise<void> {
    const manifest = await this.readManifest();
    if (!manifest.versions.some((v) => v.id === id)) {
      throw new Error(`Unknown version id: ${id}`);
    }
    await this.writeManifest({
      ...manifest,
      versions: manifest.versions.map((v) => (v.id === id ? { ...v, position } : v)),
    });
  }
}
