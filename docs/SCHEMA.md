# `.design/` schema contract

> **Status (M1 item 5):** the DocumentStore (`projects/` subtree) and the
> SystemStore (`system/` subtree — tokens.css, components.md, manifest.json
> with source hashes for drift) are implemented. The ledger arrives with M1
> item 8; its contract is recorded here from BUILD_BRIEF.md §6.

Every file carries a `schema_version`. Snapshots are immutable — edits create new versions. The store commits only complete, validated states: a cancelled stream never corrupts a document. Anything a team should share is committed; anything personal (spend) is gitignored by default via a shipped `.gitignore`.

```
.design/
  system/
    manifest.json        schema_version, index, source-file hashes (drift detection)
    tokens.css           real CSS custom properties extracted from the workspace
    components.md        component inventory + usage notes
  projects/<slug>/
    artifact.json        manifest: type, schema_version, model used, current pointer
    versions/<ulid>.html immutable snapshots
  ledger.jsonl           append-only spend records (gitignored)
  .gitignore
```

## `projects/<slug>/artifact.json` (schema_version 1 — implemented)

```json
{
  "schema_version": 1,
  "type": "page",
  "current": "01JZ8...",
  "versions": [
    {
      "id": "01JZ8...",
      "created": "2026-07-06T18:12:03.412Z",
      "model": "anthropic/claude-sonnet-4.5",
      "costUsd": 0.0769,
      "promptTokens": 1086,
      "completionTokens": 2859,
      "prompt": "A pricing page for a note-taking app…"
    }
  ]
}
```

Implementation notes:

- v0.1 uses a single project slug, `main`; multi-project is a container change later.
- Version IDs are ULIDs (timestamp-prefixed, so filenames sort by creation).
- Snapshots (`versions/<ulid>.html`) are written **before** the manifest entry. A crash between the two leaves an orphan snapshot, which is harmless: **the manifest is the index** — orphans are ignored and never listed.
- Every version is a *frame* on the canvas (ADR-009); the metadata above is exactly what frame cards render, so listing frames never reads snapshot bodies.
- `costUsd`/token fields are OpenRouter's recorded accounting (`null` when unavailable), never estimates.
- `position` (`{x, y}`, optional — v0.2 item 2b) is the frame's board placement and the only per-version field that mutates after commit; snapshots themselves stay immutable. Absent → the canvas assigns a deterministic grid slot.

## Migration policy

- Readers accept the current `schema_version` and all prior versions; writers always write the current version.
- A version bump requires: a migration note in this file, a fixture of the old format in `test/fixtures/`, and a test proving the old format still loads.
- Files with a `schema_version` newer than the extension understands are surfaced to the user read-only, never rewritten.

## Design-system drift

`system/manifest.json` records a content hash of each source file the extractor read. On activation and before each generation the hashes are compared cheaply; if sources changed, the UI shows a non-blocking "design system may be stale — re-extract?" affordance. Re-extraction is never silent (P3: extraction that calls a model costs money; heuristic extraction is free but still explicit).
