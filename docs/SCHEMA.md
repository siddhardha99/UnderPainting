# `.design/` schema contract

> **Status (M0):** the walking skeleton does not yet write to `.design/` — the
> write-scope guard exists (`src/host/store/writeScope.ts`) and is CI-enforced,
> but the DocumentStore, extractor output, and ledger arrive with M1. This
> document records the contract those features must implement (BUILD_BRIEF.md §6).

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

## Migration policy

- Readers accept the current `schema_version` and all prior versions; writers always write the current version.
- A version bump requires: a migration note in this file, a fixture of the old format in `test/fixtures/`, and a test proving the old format still loads.
- Files with a `schema_version` newer than the extension understands are surfaced to the user read-only, never rewritten.

## Design-system drift

`system/manifest.json` records a content hash of each source file the extractor read. On activation and before each generation the hashes are compared cheaply; if sources changed, the UI shows a non-blocking "design system may be stale — re-extract?" affordance. Re-extraction is never silent (P3: extraction that calls a model costs money; heuristic extraction is free but still explicit).
