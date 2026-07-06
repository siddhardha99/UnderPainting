# ADR-002: v0.1 renders self-contained HTML/CSS/JS + SVG; React deferred to v0.2

**Status:** Accepted

## Decision

v0.1 artifacts are self-contained HTML/CSS/vanilla-JS or SVG documents. React artifacts arrive in v0.2 via `esbuild-wasm` plus a vendored runtime — never a CDN fetch.

## Rationale

Self-contained HTML streams progressively with zero toolchain, keeps the artifact sandbox airtight (no module resolution, no network), and lets the validator be a deterministic structural checker. React support requires bundling inside the webview's CSP, which is real work that must not block the alpha. Do not build the React path in M0/M1.

## Addendum (2026-07-06): artifact scripts in v0.1

Resolution of docs/OPEN_QUESTIONS.md #8 (human decision at M0 review):

- **While streaming**, the renderer keeps stripping `<script>` — a partially streamed artifact is never executable.
- **On commit** of a complete artifact that has passed the Validator, the commit path renders it in the same sandboxed iframe (opaque origin, no `allow-same-origin`) **with scripts enabled**.
- The hostile-artifact fixture must be **re-asserted against the scripts-enabled commit path** — it currently passes partly because scripts are removed rather than contained.

Scheduled inside M1 item 6 (Validator), not as a hotfix.
