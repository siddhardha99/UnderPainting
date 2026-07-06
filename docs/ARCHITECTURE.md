# Architecture

Everything privileged lives in the **extension host** (Node). The **canvas webview** is a sandboxed renderer with zero credentials and zero network. Between them is a single message bus, schema-validated with zod in both directions.

```
Extension Host (Node)
├─ KeyVault             src/host/keyvault/    SecretStorage only (P2)
├─ OpenRouterClient     src/host/client/      THE ONLY MODULE THAT FETCHES (P1)
│     hostname allowlist · SSE streaming · AbortController (≤1s cancel)
│     usage/cost readers (stream usage + /generation fallback) · /models catalog
├─ Model catalog        src/host/models/      pure helpers: pricing display,
│     deprecation → suggested-equivalent ranking (never a silent switch)
├─ Orchestrator         src/host/orchestrator/ prompt → stream → validate →
│     correct (≤ CORRECTION_RETRY_CAP on the cheap validation model) → cost → commit
├─ Validator            src/host/validator/   §7 as deterministic checks (no DOM,
│     no deps): structure, A1 token-referencing + style-block contents, A2 leaf
│     rule, A3 self-containment, A4 explicit dimensions, script ban; A7
│     refinement-survival warning; surviving issues surfaced, never silent
├─ DocumentStore        src/host/store/       immutable version snapshots + manifest;
│     commits only complete states — cancelled/failed streams never touch disk
├─ DesignSystemExtractor src/host/extractor/  READ-ONLY heuristic scan: :root/html
│     custom props, static Tailwind-classic theme lift (never executes workspace
│     code), component inventory; async, cancellable, capped; drift via source hashes
├─ SystemStore          src/host/store/       persists tokens.css/components.md/manifest
├─ writeScope guard     src/host/store/       all fs writes confined to .design/ (P5/P9)
├─ SecretRedactor       src/host/logging/     every outbound string is scrubbed
└─ CanvasPanel          src/host/canvas/      webview lifecycle, validated poster

    │ postMessage — zod-validated both directions (src/shared/messages.ts); NEVER carries the key
    ▼
Canvas Webview (sandboxed)                    src/webview/canvas/
├─ strict CSP: default-src 'none', nonce-only scripts, no connect-src
├─ localResourceRoots: extension dist/webview + workspace .design/ only
└─ frame board (ADR-009)                       src/webview/canvas/frameState.ts
      every version is a titled frame (model — cost) in a wrapping flow layout;
      zoom/fit controls; click to select; one-click restore; all local + free (P4)
      each frame = nested <iframe sandbox="allow-scripts">   src/webview/artifact/
        opaque origin (no allow-same-origin) — cannot touch canvas chrome or VS Code API
        cloned from the single <template> pinned in static HTML (CSP test asserts it)
        srcdoc bootstrap receives {patch, html} messages and morphs the DOM per chunk
        defense-in-depth sanitizer strips scripts / on* attrs / javascript: URLs
      live-iframe budget: only the selected + on-screen frames keep live iframes;
      off-screen frames drop to placeholders and re-render from .design/ on return
```

## Trust boundaries

1. **KeyVault → OpenRouterClient** is the only path credentials travel. The key is registered with the `SecretRedactor` the moment it enters the host; every log line and every webview message passes through redaction.
2. **Host ↔ webview** messages are validated with strict zod schemas on both sides; a message carrying an undeclared field (e.g. a key) fails parse instead of being forwarded (`src/host/canvas/poster.ts` is the single host-side choke point).
3. **Webview ↔ artifact iframe**: the artifact document has an opaque origin and inherits the webview's CSP, so artifact-injected scripts (which never learn the per-panel nonce) cannot execute and no network request of any kind is possible inside it. The renderer additionally sanitizes markup before it joins the DOM.

## Streaming render path (M0)

`Generate` click → `generate` message → Orchestrator streams from OpenRouter → each accumulated buffer passes `extractHtml` (fence/prose stripping) → `streamChunk` posts (throttled ~30ms) → canvas forwards to the artifact iframe → bootstrap parses with `DOMParser` and **morphs** the live DOM (index-based diff, `src/webview/artifact/morph.ts`) — no full reload, stable node identity, so completed content doesn't flicker while later content streams.

Cost is read from OpenRouter's `usage` accounting on the final SSE frame (requested via `usage: {include: true}`); if absent, one follow-up `GET /api/v1/generation` reads the recorded cost (bounded: capped attempts, per-attempt timeout). It is never estimated.

## Validator + correction loop (M1 item 6)

Every completed generation is validated (`src/host/validator/Validator.ts` — pure string/tokenizer checks; the host has no DOM and the dependency budget stays at 1). Violations trigger correction passes on the **validation model** with minimal context (`prompts/correct.md` is the entire system prompt — a verifier in miniature, §8), hard-capped at `CORRECTION_RETRY_CAP`; costs from every pass are **summed** into the exact figure shown. No validation model configured → no correction spend, issues surfaced directly. Whatever survives the cap commits anyway (the user paid for it) with `validated: false` — a ⚠ badge on the frame and the issue list in chat. A7: targeted refinements get a line-survival check; a rewrite above threshold is a surfaced *warning*, never a correction trigger (same instruction → same result → wasted money). Direct edits re-validate locally (free).

**ADR-002 scripts-enabled commit path** is implemented and deliberately dormant: a *validated* committed artifact containing `<script>` renders as its own document (inline scripts nonce-injected — `src/webview/canvas/commitRender.ts`) inside the unchanged sandbox + CSP. In v0.1 the validator rejects all scripts, so nothing reaches it; the hostile fixture can never validate (tested), and streaming always uses the stripping morph renderer.

## Design-system grounding (M1 item 5)

“Extract Design System” (explicit, local, free, cancellable) scans the workspace heuristically — `:root`/`html` custom properties, a **static** lift of classic `tailwind.config.*` theme values (workspace code is never executed), and a component inventory with props and cross-file usage counts — and persists to `.design/system/` via the SystemStore. When `tokens.css` exists, generation and refinement prepend `prompts/grounding.md` + the token block (as fenced data) to the system prompt, so artifacts consume the repo's real tokens instead of inventing a palette. Drift: the manifest records source hashes; the canvas re-checks on open and per generation and shows a non-blocking “may be stale” hint — re-extraction is never silent (§6). Model-written component notes are deferred: they'd be an API call and need explicit user action (P3).

## Infinite canvas (v0.2 item 2b)

**Target sizes (2b revision, user feedback):** the artifact's viewport is a design-time property, not a preview toggle. The clarify form asks "what is it?" only when the prompt doesn't say (component 800×600 · mobile 390×844 · tablet 834×1194 · desktop 1440×1400); the resolved target folds into the generation request, is recorded with the version, and the frame is *born* at that size — a mobile design gets a phone-shaped frame, and Present shows it as a centered phone-width column. Refinements, edits, and splits inherit the source frame's size. The post-hoc Mobile/Tablet/Desktop toggle is gone.

The board is a viewport over a translated+scaled **surface**; frames sit at absolute surface positions (logical size — the surface transform does all scaling, one composited layer, no per-iframe transforms). Pan: space-drag or scroll; zoom: ctrl/cmd-scroll anchored at the cursor, plus Fit/100% controls. Drag a frame by its header to arrange; the position persists to the project manifest on drop (`versions[].position` — the manifest's only mutable per-version field; snapshots stay immutable, git-diffable, P5). The live-iframe budget is geometry-ranked (`boardGeometry.pickLive`): selected frame first, then visible frames by distance to the viewport center, hard-capped at 3 — twenty frames never means twenty live iframes (NFR-1.6, unit-tested). **Variation split**: clarify-form multi-variation artifacts carry `data-variation` section markers; Split slices them into standalone sibling versions (marker-based only — no guessing; local, free). All canvas interactions are local and free (P4).

## Present mode (v0.2 item 2a)

**Present** renders the selected frame full-screen at natural scale in its own sandboxed iframe (same template clone, same CSP/sandbox, same ADR-002 commit-path gate). Interactivity is on by default — the iframe receives all pointer events; containment is unchanged. `Esc` exits; `←`/`→` step through versions in manifest order (clamped, position shown as "version i of N"); board selection follows the presented frame so refine/edit target what was just shown. Entirely local and free (P4). This is the presentation half of the item-2 canvas work; the infinite board (2b) and interactive prototypes (2c) follow behind their own gates.

## Clarify-before-spend (v0.2 item 1)

New-design generations (never refinements) get one optional clarifying round **before** the paid call. The form is deterministic and local (`src/shared/clarify.ts`) — no model asks the questions, so asking is free by construction (P3/P4). Licensing mirrors A6: fields the prompt already answers are not asked ("deep blue" suppresses colors; an extracted/generated design system suppresses colors entirely; "3 variations" suppresses count). Always skippable in one click ("Just generate · paid"); one round maximum; if only the never-inferable constraints field remains, the form doesn't appear at all. Answers fold into the request as an authoritative addendum; the version manifest records the **original** prompt plus the structured answers separately, for reproducibility. Gated by the `clarify-form` golden case (analyzer expectations run per-PR).

## Chat + refinement (M1 item 3)

The chat sidebar drives both entry points: **New design** (core prompt) and **Refine selected** (core prompt + `prompts/refine.md`, loaded per-invocation per §8). Refinement sends the selected frame's snapshot as fenced data with one instruction; the recipe requires untouched content to survive character-for-character (A7 — deterministic enforcement arrives with the Validator, item 6). The result commits as a **new** version/frame; history is never rewritten. Chat history is *derived* from the version list (one exchange per frame: prompt → model/cost), so it survives webview reloads for free; only the in-flight exchange is local state. Per-request cost shows inline in each result bubble.

## Direct text editing (M1 item 4)

The **Edit text** toggle (labeled local/free, P4) makes the selected frame's text leaves contenteditable — A2's one-run-per-leaf structure is what makes each edit map to exactly one source location. The bootstrap posts `{textEdit, path, before, text}` up; the canvas accepts artifact-iframe messages **only** during an edit session, only from the session frame, schema-validated (P6). Each edit is spliced into the snapshot source deterministically (`spliceText.ts`) — `before` must match the resolved leaf or the edit fails closed. The whole session saves as **one new version** (model `local edit`, cost `free`); the original snapshot is untouched, and no API call can occur anywhere on this path.

## Model selection (M1 item 1)

There are **no hardcoded model IDs**. The generation and validation models are user settings (`underpainting.generationModel` / `underpainting.validationModel`), chosen from the **live catalog** (`GET /api/v1/models`) via the Select-Model commands, with per-million-token pricing displayed in the picker. The catalog is fetched only on those explicit user actions (P3). When OpenRouter rejects the configured model mid-generation (deprecated/renamed), the host fetches the catalog and offers ranked equivalents (`src/host/models/catalog.ts`) — a one-click switch the user confirms, never a silent substitution (§9). The validation model is consumed by the correction loop when the Validator lands (M1 item 6).

## Activation budget

The **design budget for activation is ≤500ms** with no work before the first command (brief §10.1): `activate()` only registers commands; the output channel, client, and prompt file are created lazily on first use. The integration test asserts `<1500ms` — that number is a **flake-tolerant regression tripwire for shared CI runners, not the spec**. Treat any activation-time regression against the 500ms design budget as a bug even while CI stays green (OPEN_QUESTIONS #10 resolution).

## Invariants → tests

| Invariant | Test |
|---|---|
| P1 single network destination | `test/invariants/allowlist.test.ts` + eslint restriction |
| P2 key never leaves the host | `test/invariants/key-redaction.test.ts`, `webview-messages.test.ts` |
| P3 no call without user action | `test/unit/orchestrator.test.ts` |
| P5/P9 writes confined to .design/ | `test/invariants/write-scope.test.ts` |
| P6 hostile model output | `test/invariants/csp.test.ts`, `test/unit/artifactDom.test.ts` |
| P7 one-minute audit | PRIVACY-drift check inside `allowlist.test.ts` |
| §4 dependency budget | `test/invariants/dep-budget.test.ts` |

M1 backlog status: items 1–10 implemented (model catalog, DocumentStore/frames, chat+refinement, direct editing, extractor+grounding, validator+corrections, scaffolds, cost ledger + status-bar credits, export/handoff, eval harness). Remaining for v0.1 release: human decisions in docs/OPEN_QUESTIONS.md and the launch-readiness items from the item-10 review.
