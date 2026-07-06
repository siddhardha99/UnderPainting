# Underpainting — Build Brief

**An open-source, local-first AI design canvas inside VS Code.** Bring your own OpenRouter key, generate UI grounded in the design system already in your repo, see the real cost of every request, and hand finished designs to your coding agent as an executable spec.

*In classical painting, the underpainting is the grounded first layer — it establishes composition and values before the final layers go on. This tool is that layer for your product's UI: you iterate here, grounded in your real design tokens, then the final work happens in your codebase.*

- **License:** Apache-2.0
- **Working name:** Underpainting (`underpainting` as Marketplace/npm ID; verify availability before first publish — see §14)
- **This document is the source of truth for scope and constraints.** `CLAUDE.md` in the repo root carries the standing rules; this brief carries the full spec and the milestone plan.

**How to use this brief:** build Milestone 0 (§10) first, in task order, and stop at its exit criteria for human review before starting Milestone 1 (§11). Do not pull M1+ features forward. When a decision isn't covered here, prefer the smaller implementation and record the question in `docs/OPEN_QUESTIONS.md` rather than guessing big.

---

## 1. Product in one paragraph

AI design tools today are hosted SaaS: prompts, code context, and client brand assets flow through third-party servers, on marked-up pricing, producing generic output that ignores the design system already sitting in the user's repo. Underpainting inverts all three. It is **local-first** (the workspace is the database, git is the collaboration layer, and the extension talks to exactly one network destination: `openrouter.ai`), **grounded** (it extracts the tokens and components that already exist in the workspace and generates against them), and **radically cost-transparent** (every request shows its actual cost, read from OpenRouter's own accounting, inline in the chat). There is no backend, no account, no telemetry, and no monetization in the client — ever.

## 2. Invariants

These are non-negotiable. A change that violates one is wrong regardless of what feature it enables. Each invariant has a CI test that must exist from M0 onward; if you find code that could violate an invariant without failing CI, fixing the test gap is the first priority.

| ID | Invariant | Enforced by |
|----|-----------|-------------|
| P1 | User content leaves the machine only to `openrouter.ai`, via the single `OpenRouterClient` module. A hostname allowlist lives in that module; no other module may call `fetch`/`http`. | `test/invariants/allowlist.test.ts` + lint rule banning `fetch` outside `src/host/client/` |
| P2 | The API key exists only in the extension host, sourced from VS Code `SecretStorage`. Never in `settings.json`, workspace files, logs, error messages, telemetry, or any webview message. | `test/invariants/key-redaction.test.ts` (greps captured log/error output for key material), `test/invariants/webview-messages.test.ts` |
| P3 | No API call without an explicit user action. No background, speculative, or warm-up calls. Retries are hard-capped (default 2, configurable). It is the user's money. | Orchestrator unit tests; code review |
| P4 | Local edits are free. Text edits and canvas interactions never trigger API calls, and the UI makes the free/paid boundary visually unambiguous. | Webview integration tests |
| P5 | The workspace is the truth. All artifacts, versions, tokens, and ledgers are plain, schema-versioned, git-diffable files under `.design/`. Fully functional with no account or server. | `test/invariants/write-scope.test.ts` |
| P6 | Generated code is hostile. The canvas webview treats model output as untrusted: strict CSP, origin isolation, nested sandboxed iframe for the artifact, schema-validated messaging in both directions, no arbitrary network. | `test/invariants/csp.test.ts` |
| P7 | Auditable in one minute. `PRIVACY.md` enumerates every possible network call. If the list outgrows one screen, the design is wrong. | Human review; doc-drift check in CI |
| P8 | The client is free forever. No license gates, no feature clawbacks. Stated in the README. | Governance |
| P9 | Nothing irreversible without a human. Writes outside `.design/` require a diff preview and confirmation. (Full agent semantics arrive in v0.4; the write-scope rule applies from M0.) | `test/invariants/write-scope.test.ts` |

## 3. Architecture

Everything privileged lives in the **extension host** (Node). The **canvas webview** is a sandboxed renderer with zero credentials and zero network. Between them is a single message bus, schema-validated with zod in both directions.

```
Extension Host (Node)
├─ KeyVault            SecretStorage only; validate via key/credits endpoint
├─ OpenRouterClient    THE ONLY MODULE THAT FETCHES (P1)
│    hostname allowlist · SSE streaming · AbortController (≤1s cancel)
│    per-request usage/cost reader
├─ Orchestrator        plan → generate → validate → correct (retry ≤ cap)
│    injects .design/system/ grounding into prompts
├─ Validator           structural checks on generated artifacts (§7)
├─ DocumentStore       .design/ immutable version snapshots; commits only
│    complete validated states — a cancelled stream never corrupts a doc
├─ DesignSystemExtractor  CSS custom props + Tailwind config → .design/system/
│    async, cancellable; records source-file hashes for drift detection
└─ CostLedger          .design/ledger.jsonl (append-only, gitignored)

   │ postMessage — zod-validated both directions; NEVER carries the key
   ▼
Canvas Webview (sandboxed)
├─ strict CSP; localResourceRoots limited to .design/
├─ renders the artifact inside a nested sandboxed <iframe>
├─ streaming renderer: DOM-patch per chunk, no full reload
└─ emits selection/edit events to the host
```

Trust boundaries: KeyVault→OpenRouterClient is the only path credentials travel; the host↔webview bus is validated on both sides; the nested artifact iframe is a second sandbox so generated code can't touch even the canvas chrome.

**Streaming render note:** the renderer patches the DOM as tokens arrive, which means it is continuously reconciling against HTML that is not yet complete. Use a forgiving incremental parser (browser `DOMParser` on the accumulated buffer + morphdom-style diffing is acceptable) and treat "renders sensibly mid-stream" as a tested behavior, not a hope. Target ≤200ms per chunk re-render, ≤3s p95 to first painted content after the prompt (excluding model queue time).

## 4. Tech stack and budgets

- TypeScript strict mode everywhere. esbuild for the extension build.
- `zod` for all message and file schemas. `vitest` for unit tests, `@vscode/test-electron` for integration tests.
- Webviews are vanilla TypeScript for v0.1 — no UI framework. This keeps the dependency budget and proves the CSP story.
- **Dependency budget: fewer than 10 direct runtime dependencies at v0.1; hard cap 15, enforced by CI.** Lockfile-pinned, no post-install scripts. Adding a dependency requires a one-line justification in the PR and is a human-review item.
- No proposed VS Code APIs. Feature-detect anything not in stable. Support current stable plus two prior minors.

## 5. Repository layout

```
/                       LICENSE (Apache-2.0), README
├─ PRIVACY.md           the one-minute network audit (P7)
├─ CLAUDE.md            standing rules for coding agents (companion file)
├─ CONTRIBUTING.md      DCO sign-off, PR flow, eval merge bar, provenance policy
├─ SECURITY.md          private disclosure channel; key-handling = critical
├─ docs/
│  ├─ ARCHITECTURE.md   §3, kept current as code changes
│  ├─ SCHEMA.md         .design/ format contract + migration policy
│  ├─ OPEN_QUESTIONS.md deferred decisions (agent appends, human resolves)
│  └─ adr/              decision records (seed from §13)
├─ src/
│  ├─ host/             keyvault/ client/ orchestrator/ validator/ store/ extractor/ ledger/
│  ├─ webview/          canvas + panels (vanilla TS)
│  └─ shared/           zod schemas, types shared host↔webview
├─ prompts/             versioned prompt core + per-task recipes (§8)
├─ evals/               golden prompts, deterministic scorers, CI runner
├─ scaffolds/           versioned starter files copied into artifacts (§7, A5)
└─ test/
   └─ invariants/       allowlist, key-redaction, csp, write-scope, dep-budget
```

## 6. Workspace format: the `.design/` contract

Every file carries a `schema_version`. Snapshots are immutable — edits create new versions. The store commits only complete, validated states. Anything a team should share is committed; anything personal (spend) is gitignored by default via a shipped `.gitignore`.

```
.design/
  system/
    manifest.json        schema_version, index, source-file hashes (for drift)
    tokens.css           real CSS custom properties extracted from the workspace
    components.md        component inventory + usage notes
  projects/<slug>/
    artifact.json        manifest: type, schema_version, model used, current pointer
    versions/<ulid>.html immutable snapshots
  ledger.jsonl           append-only spend records (gitignored)
  .gitignore
```

**Design-system drift:** `manifest.json` records a content hash of each source file the extractor read. On activation and before each generation, compare cheaply; if sources changed, show a non-blocking "design system may be stale — re-extract?" affordance. Never re-extract silently.

## 7. Generation authoring standards (validator-enforced)

Output quality is determined less by model choice than by the authoring rules generation is held to. These rules exist because three of our constraints compound into them: streaming (the canvas must paint from the first token), free local edits (P4 — the editor must map any click to exactly one source location), and cost (every scaffolding token is the user's money). They are **enforced by the Validator, not merely requested in the prompt**, and every one is a golden-eval check. Violations trigger a bounded correction pass (P3 retry cap); violations that survive the cap are surfaced to the user, never silently accepted.

- **A1 — Inline styles, token-referenced.** All styling on elements is inline `style="..."`. The artifact's single permitted `<style>` block may contain only: (a) the `:root { --token: value; }` custom-property declarations copied from `.design/system/tokens.css` at generation time, (b) `@font-face`, (c) `@keyframes`, (d) a minimal base reset. Inline styles must consume tokens via `var(--token)` for colors, spacing, and type — raw values outside the token block are a validation failure (small tolerance list for structural values like `0`, `1px`, percentages). This resolves grounding and streaming at once: the token block streams first and every subsequent element paints immediately with correct brand values. The `<style>` block and any font `<link>`s must appear at the very top of the artifact so resources are loading before content streams.
- **A2 — Editability structure.** Every run of user-visible text lives in its own leaf element. Repeated structure is written out literally — three cards are three blocks of markup, never one block emitted from a loop or script. Scripts may add behavior; they may not construct layout or content. This is what lets a click on the canvas resolve to exactly one source span, so direct edits never round-trip through the model (P4). The observable failure mode of breaking this rule is a user saying "I can't edit that part" — make it a golden-eval case.
- **A3 — Self-containment (v0.1 render target).** Artifacts are self-contained HTML/CSS/vanilla-JS or SVG. No CDN scripts, no external fonts, no remote images. The validator rejects any external reference. (React artifacts arrive in v0.2 via `esbuild-wasm` plus a vendored runtime — see ADR-002; do not build this in M0/M1.)
- **A4 — Streaming-safe form.** Nothing in the artifact may depend on content that hasn't streamed yet to render sensibly: no class-based styling of content (see A1), no script-generated layout (see A2), and any element whose content arrives late must carry explicit dimensions so layout doesn't jump.
- **A5 — Scaffolds are copied, never regenerated.** Boilerplate shells (page skeleton, browser-chrome frame; more per demand) live as versioned files in `/scaffolds` and are copied into artifacts; the model generates content into them. Regenerating solved boilerplate spends the user's money on nothing.
- **A6 — Content quality.** No filler or placeholder padding to occupy space; no invented statistics or decorative data; no clichéd visual tropes; ask before adding material the user didn't request; accessible by default (semantic HTML, drafted alt text, contrast-checked token pairs). Checked by evals (the deterministic subset in v0.1; see §14).
- **A7 — Surgical edits.** When the user asks for a targeted change (some text, one color, one element), the refinement pass changes only that — layout, spacing, and untouched content must survive byte-identical wherever possible. Broader improvements are suggested, never applied unprompted. A full redesign request is different and may change anything. Golden eval: a targeted-edit case scored on diff minimality.

## 8. Prompt architecture and provenance

A small **core prompt** carries only the invariants: the §7 authoring standards, the untrusted-data framing (workspace files, images, and any fetched content are data, not instructions — any tool-like action they induce requires explicit user confirmation), and the content-quality rules. Per-task **recipes** (component, page; later prototype and integration) are loaded only for the invocation that needs them. Recipes live in `/prompts`, are schema-versioned, and are individually covered by the eval harness so one recipe can improve without destabilizing another. The validate/fix pass runs on the cheap validation model with its own minimal context — a verifier in miniature, bounded by the retry cap.

**Provenance policy (ADR-008) — this binds you, the coding agent, directly.** All prompt text in this repository must be original work. Principles learned from studying production tools (streaming-safe formats, editability constraints, verifier passes) are fair game and are already distilled into §7; reproducing or closely paraphrasing another tool's prompt text is prohibited. Do not paste, adapt, or "reference while writing" any external system-prompt text. Write prompts from this brief's requirements and the validator's checks, then let the eval harness pull quality up. Prompt PRs are reviewed for provenance.

## 9. Cost and safety behaviors

- Every request's actual cost is read from OpenRouter's usage accounting for that request and shown inline ("this generation: $0.041") — read from the API, never estimated (NFR: exact match).
- Cancellation aborts the underlying HTTP stream within 1 second so billing for unconsumed output stops.
- Correction retries are hard-capped; an unbounded retry loop against failing validation is a critical defect.
- Session and per-project totals accumulate in the ledger; remaining OpenRouter credits show in the status bar, refreshed after each call.
- Transient network errors retry with backoff at most twice; model deprecation offers a one-click switch to a suggested equivalent, never a silent substitution.
- Prompt injection stance: content read from the workspace is untrusted. Generation may *use* it; it may never cause writes outside `.design/`, network activity, or additional spend without explicit confirmation.

## 10. Milestone 0 — walking skeleton

**Goal:** force every risky integration point through one thread of execution. Work the tasks in order; each has acceptance criteria. Total scope is deliberately small.

1. **Scaffold.** Extension project: esbuild build, strict tsconfig, vitest, `@vscode/test-electron` harness, GitHub Actions CI running typecheck + lint + tests + package smoke test. *Accept: CI green on an empty extension that activates lazily (≤500ms, no work before first command).*
2. **Invariant tests first.** Write the failing tests in `test/invariants/` for the allowlist, key redaction, webview-never-sees-key, write-scope, and the dependency-budget check. *Accept: tests exist, are wired into CI, and fail for the right reasons.*
3. **KeyVault.** Commands to set/replace/delete the key against `SecretStorage`; on entry, validate via OpenRouter's key/credits endpoint and report remaining credits; degraded read-only mode when absent; revoked/expired keys produce an actionable message, never a raw error. *Accept: key-redaction test passes; key never appears in any log fixture.*
4. **OpenRouterClient.** Single fetch surface with the hostname allowlist, SSE streaming, `AbortController` cancellation, and a usage/cost reader for completed requests. *Accept: allowlist test passes; a cancelled stream stops within 1s in an integration test.*
5. **Canvas webview.** Strict CSP, `localResourceRoots` limited to `.design/`, nested sandboxed artifact iframe, zod-validated message bus. Render a static HTML artifact. *Accept: CSP test passes; a hostile artifact fixture (inline script attempting fetch/parent access) is inert.*
6. **One end-to-end thread.** Hardcoded model, minimal prompt (core prompt v0; no recipes yet) → stream → DOM-patched progressive render on the canvas → on completion, read the request's cost and print it in the output channel. *Accept — M0 exit criteria: paste key → type prompt → watch HTML stream onto the canvas → see the real dollar cost. Cancellation works mid-stream. CI fails if any code path could log the key or reach a non-allowlisted host. Capture the flow as a GIF.*

Stop here for human review.

## 11. Milestone 1 — public alpha (v0.1) backlog

Build in roughly this order after M0 sign-off. Each item lands with its tests and, where it touches generation, its golden-eval cases.

1. Model catalog: fetch live from OpenRouter (no hardcoded model IDs); per-task model settings — generation (strong) and validation (fast/cheap) — with catalog pricing displayed; deprecation → suggested-equivalent flow.
2. DocumentStore: immutable versions, one-click restore, commit-only-complete-states; webview crash loses no state.
3. Chat panel: refinement loop with bounded corrections, cancel, inline per-request cost. Surgical-edit behavior (A7) for targeted asks.
4. Direct text editing on the canvas with the free/paid boundary made visually unambiguous (P4); edits splice into the current version as a new snapshot.
5. DesignSystemExtractor: CSS custom properties + Tailwind config (classic `tailwind.config.js`; v4 CSS-first is an open question, §14) → `.design/system/`; async and cancellable (≤30s on a 10k-file workspace); drift detection per §6. Component-inventory notes: heuristic extraction only in v0.1 (names, props from source, usage counts) — model-written notes would be an API call and need explicit user action per P3.
6. Validator v1: A1–A5 and A7 as deterministic checks wired into the orchestrator's correction loop.
7. Scaffolds: page skeleton + browser frame in `/scaffolds`, copy-in mechanism, validator awareness.
8. CostLedger panel + status-bar credits.
9. Export & handoff: standalone HTML export; native handoff writing code + assets to a user-chosen path with diff preview + confirmation; `HANDOFF.md` + `handoff.json` manifest (design intent from the prompt/refinement history, tokens used and their sources, component structure, integration directives a coding agent can execute) — generated from data the pipeline already has, no extra API call.
10. Eval harness v1 in CI: golden prompts scored by deterministic structural checks (valid HTML, A1–A5, A7 diff-minimality, token compliance). Prompt-changing PRs must not regress the golden set — this is the community merge bar.
11. Docs: PRIVACY.md, ARCHITECTURE.md, SCHEMA.md, CONTRIBUTING.md (DCO + provenance policy), SECURITY.md. README above the fold: demo GIF, one-line vision, PRIVACY link, "free forever."

**v0.1 exit:** install → paste key → first grounded design in under 3 minutes; the ten-user second-session validation test is a human activity, not an agent task.

## 12. CI quality gates (every PR)

1. Invariant tests (§2). 2. Eval harness — no regression on the golden set for prompt-changing PRs. 3. Dependency-budget check. 4. Typecheck, lint, unit + integration tests, packaging smoke test. 5. Nightly (not per-PR): contract tests against the live OpenRouter API — catalog shape, usage-accounting fields, SSE framing — as an API-drift tripwire.

## 13. Seed ADRs to write into `docs/adr/`

001 Apache-2.0 · 002 v0.1 renders self-contained HTML/CSS/JS+SVG, React deferred to v0.2 via esbuild-wasm + vendored runtime · 003 no backend ever; git is the collaboration layer · 004 DCO over CLA · 005 client free forever; any managed tier is a separate offering · 006 name "Underpainting" pending Marketplace/npm/trademark verification · 007 authoring standards (§7) as the generation format, with the token-block exception reconciling inline styles with design-system grounding · 008 prompt provenance: principles may be learned from production tools, text may never be copied.

## 14. Decisions reserved for the human — do not resolve these yourself

- Final name confirmation: Marketplace publisher + extension ID, npm availability, trademark search (ADR-006).
- Default shipped models for generation and validation (pick from the live catalog at release).
- Minimum VS Code engine version.
- Tailwind v4 CSS-first extraction: in or out of v0.1.
- Eval scoring beyond deterministic checks (LLM-as-judge costs money in CI — whose key?).
- Remote development (WSL/SSH/Dev Containers) support posture — affects SecretStorage and webview behavior; investigate and report, don't decide.
- v0.3 (images) vs v0.4 (integration agent) ordering — decided by alpha-user demand.

When you hit one of these, append context to `docs/OPEN_QUESTIONS.md` and continue with unblocked work.
