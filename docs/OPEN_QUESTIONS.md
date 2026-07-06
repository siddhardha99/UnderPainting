# Open questions

Deferred decisions per BUILD_BRIEF.md §14 — agents append context here and take the smaller path; a human resolves. Format: **Question — context — interim choice (if any).**

## Reserved for the human (brief §14)

1. **Final name confirmation (ADR-006).** Marketplace publisher + extension ID and npm availability for `underpainting` are unverified; no trademark search done. *Interim:* `publisher: "underpainting"`, `private: true` in package.json so nothing can be published accidentally. Verify before first publish.
2. **Default shipped models.** M0 hardcodes `anthropic/claude-sonnet-4.5` in `src/host/orchestrator/Orchestrator.ts` (`M0_MODEL`) purely as a dev-time placeholder. M1 item 1 replaces this with the live catalog; the shipped generation/validation defaults are a release-time human pick.
3. **Minimum VS Code engine version.** *Interim:* `^1.96.0` (stable + two prior minors comfortably satisfied). Confirm against the API surface actually used before v0.1.
4. **Tailwind v4 CSS-first extraction: in or out of v0.1.** The M1-item-5 extractor covers `:root`/`html` custom properties and classic `tailwind.config.*` (static parse, no code execution). Tailwind v4 `@theme { … }` blocks are **not** parsed yet — note that v4 projects whose tokens also appear as plain `:root` variables are still captured. Adding an `@theme` block scan is small; whether it's in v0.1 remains the human's call.
5. **Eval scoring beyond deterministic checks.** LLM-as-judge in CI costs money — whose key? Not yet reached (harness is M1 item 10). *Partially resolved (2026-07-06):* the nightly contract-test workflow now exists (`.github/workflows/nightly-contract.yml`) and reads the Actions secret **`OPENROUTER_CONTRACT_KEY`** — the human adds a dedicated low-credit key; the suite skips cleanly when the secret is absent. The LLM-as-judge question for evals remains open.
6. **Remote development (WSL/SSH/Dev Containers) posture.** Affects SecretStorage and webview behavior. Needs investigation-and-report, not a decision. Untouched in M0.
7. **v0.3 (images) vs v0.4 (integration agent) ordering.** Decided by alpha-user demand.

## Raised during M1

11. **Workspace-canvas polish (deferred scope).** Infinite pan/zoom surface, free-form drag-arrange, minimap, and frame grouping are explicitly **deferred to post-alpha** by the human decision recorded in [ADR-009](adr/009-frame-native-canvas.md). They are a v0.2 headline candidate, to be decided from alpha-user feedback at the item-10 review checkpoint. What ships in v0.1: frame-native architecture (versions are frames; selection model; chat/editing target the selected frame), wrapping flow layout, zoom/fit, live-iframe budget.

## Raised during M0 — all resolved at M0 review (2026-07-06)

8. **How legitimate artifact `<script>`s will run post-M0.** ~~Open~~ **Resolved:** keep stripping scripts during streaming; on commit of a complete, *validated* artifact, render it in the sandboxed iframe (opaque origin, no `allow-same-origin`) with scripts enabled. Re-assert the hostile fixture against the scripts-enabled commit path — it currently passes partly because scripts are removed rather than contained. Scheduled inside M1 item 6 (Validator), not as a hotfix. Recorded in ADR-002 addendum.
9. **`GET /api/v1/generation` polling budget.** ~~Open~~ **Resolved:** keep the fallback — exact cost is an NFR and streamed usage isn't guaranteed on every provider route. Bounded: max 3 attempts × backoff plus a per-attempt request timeout (`GENERATION_LOOKUP_TIMEOUT_MS` in the client). The endpoint remains listed in PRIVACY.md.
10. **Activation-time measurement.** ~~Open~~ **Resolved:** keep the 1500ms CI assert as a flake-tolerant regression tripwire; 500ms stays the design budget, recorded in docs/ARCHITECTURE.md. The CI number is not the spec.
