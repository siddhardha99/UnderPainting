# Open questions

Deferred decisions per BUILD_BRIEF.md §14 — agents append context here and take the smaller path; a human resolves. Format: **Question — context — interim choice (if any).**

## Reserved for the human (brief §14)

1. **Final name confirmation (ADR-006).** Marketplace publisher + extension ID and npm availability for `underpainting` are unverified; no trademark search done. *Interim:* `publisher: "underpainting"`, `private: true` in package.json so nothing can be published accidentally. Verify before first publish.
2. **Default shipped models.** M0 hardcodes `anthropic/claude-sonnet-4.5` in `src/host/orchestrator/Orchestrator.ts` (`M0_MODEL`) purely as a dev-time placeholder. M1 item 1 replaces this with the live catalog; the shipped generation/validation defaults are a release-time human pick.
3. **Minimum VS Code engine version.** *Interim:* `^1.96.0` (stable + two prior minors comfortably satisfied). Confirm against the API surface actually used before v0.1.
4. **Tailwind v4 CSS-first extraction: in or out of v0.1.** Not yet reached (extractor is M1 item 5).
5. **Eval scoring beyond deterministic checks.** LLM-as-judge in CI costs money — whose key? Not yet reached (harness is M1 item 10). Related: brief §12's *nightly live-API contract tests* also need a funded key and a decision on where it lives; the nightly workflow is intentionally not created yet.
6. **Remote development (WSL/SSH/Dev Containers) posture.** Affects SecretStorage and webview behavior. Needs investigation-and-report, not a decision. Untouched in M0.
7. **v0.3 (images) vs v0.4 (integration agent) ordering.** Decided by alpha-user demand.

## Raised during M0

8. **How legitimate artifact `<script>`s will run post-M0.** M0 renders static artifacts: the sandbox + inherited CSP make model-injected scripts inert (by design, P6), and the renderer strips them as defense in depth. v0.1 promises "vanilla-JS behavior" in artifacts (A2: behavior yes, layout/content no). Options when we get there: (a) keep scripts stripped until v0.2, (b) iframe `csp` attribute + dedicated script channel, (c) re-inject validated scripts with the trusted nonce after the Validator passes them. Needs a security review either way; take no step before the Validator exists.
9. **`GET /api/v1/generation` polling budget.** The cost record is eventually consistent; the client polls up to 3 tries × 500ms backoff after a generation whose stream carried no usage block. If OpenRouter reliably includes streamed usage, this fallback may be dead code worth removing (PRIVACY.md shrinks by a row).
10. **Activation-time measurement.** The integration test asserts activation <1500ms on CI hardware, looser than the brief's ≤500ms budget, to avoid flaky failures on shared runners. If we want the strict budget enforced, we need a calibrated benchmark step instead of a wall-clock assert.
