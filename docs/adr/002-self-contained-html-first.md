# ADR-002: v0.1 renders self-contained HTML/CSS/JS + SVG; React deferred to v0.2

**Status:** Accepted

## Decision

v0.1 artifacts are self-contained HTML/CSS/vanilla-JS or SVG documents. React artifacts arrive in v0.2 via `esbuild-wasm` plus a vendored runtime — never a CDN fetch.

## Rationale

Self-contained HTML streams progressively with zero toolchain, keeps the artifact sandbox airtight (no module resolution, no network), and lets the validator be a deterministic structural checker. React support requires bundling inside the webview's CSP, which is real work that must not block the alpha. Do not build the React path in M0/M1.
