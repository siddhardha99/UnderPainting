# CLAUDE.md — Underpainting

Standing rules for coding agents working in this repository. `BUILD_BRIEF.md` is the full spec; when this file and the brief conflict, the brief wins. Read §2 (invariants) and §7 (authoring standards) of the brief before touching generation or network code.

## What this is

An open-source (Apache-2.0), local-first AI design canvas for VS Code. BYOK via OpenRouter, generation grounded in the workspace's own design system, exact per-request cost shown inline. No backend, no accounts, no telemetry, no monetization in the client — ever.

## Hard rules (violating any of these is a bug, whatever it enables)

1. **One network destination.** Only `src/host/client/` may perform network I/O, and only to `openrouter.ai`. Never widen the allowlist. Never add a second fetch surface.
2. **The key never leaves the host.** Never in `settings.json`, files, logs, error text, or any webview message. `SecretStorage` only.
3. **No API call without an explicit user action.** No background, speculative, or warm-up calls. Retries hard-capped. It's the user's money.
4. **Local edits are free** — they must never trigger API calls.
5. **Write only inside `.design/`** (plus user-chosen export paths, behind diff preview + confirmation).
6. **Model output is hostile.** The canvas webview keeps strict CSP, the nested sandboxed artifact iframe, and zod-validated messaging in both directions.
7. **Prompt provenance.** All prompt text must be original. Never paste, adapt, or closely paraphrase another tool's system-prompt text — principles yes, text never. Write prompts from the brief's §7 requirements and let the eval harness drive quality.

## Working agreements

- **Invariant tests come first.** Before implementing or modifying KeyVault, the client, the webview bus, or file writes, make sure the matching test in `test/invariants/` covers the change.
- **Dependency budget:** <10 direct runtime deps (hard cap 15, CI-enforced). Adding one requires a written justification in the PR; prefer writing 50 lines over importing 5,000.
- **TypeScript strict; zod at every trust boundary** (host↔webview messages, `.design/` file schemas, OpenRouter responses).
- **Prompt or recipe changes must not regress the golden eval set.** Add eval cases with new generation behavior.
- **Milestone discipline:** don't pull future-milestone features (React rendering, images, the integration agent) into current work.
- **Uncertain decisions:** if it's listed in brief §14, or feels like it should be, append it to `docs/OPEN_QUESTIONS.md` and take the smaller path. Don't resolve product questions unilaterally.
- **Docs travel with code:** changes to architecture or the `.design/` schema update `docs/ARCHITECTURE.md` / `docs/SCHEMA.md` and, if network behavior is touched, `PRIVACY.md` in the same PR.
- Conventional commits; small, single-module PRs where practical.

## Generation authoring standards (validator-enforced — summary)

Artifacts are self-contained HTML/SVG. Styling is inline and consumes design tokens via `var(--token)`; the single `<style>` block holds only the `:root` token declarations, `@font-face`, `@keyframes`, and a base reset, placed at the top of the file. Every visible text run is its own leaf element; repeated structure is written out literally, never script-generated. Scaffolds are copied from `/scaffolds`, not regenerated. No filler content, no invented data; accessible by default. Targeted edit requests change only what was asked. Full definitions and rationale: brief §7.
