# Contributing

Thanks for helping build Underpainting. Read [BUILD_BRIEF.md](BUILD_BRIEF.md) §2 (invariants) and §7 (authoring standards) first — a change that violates an invariant is wrong regardless of what feature it enables.

## Ground rules

- **DCO, not CLA.** Sign your commits off (`git commit -s`) to certify the [Developer Certificate of Origin](https://developercertificate.org/). See [ADR-004](docs/adr/004-dco-over-cla.md).
- **Invariant tests come first.** Touching KeyVault, the client, the webview bus, or file writes? Make sure the matching test in `test/invariants/` covers your change before you write it.
- **Dependency budget:** fewer than 10 direct runtime dependencies (hard cap 15, CI-enforced). Adding one requires a one-line justification in the PR. Prefer writing 50 lines over importing 5,000.
- **Docs travel with code.** Architecture or `.design/` schema changes update `docs/ARCHITECTURE.md` / `docs/SCHEMA.md`; anything touching network behavior updates `PRIVACY.md` in the same PR.
- Conventional commits; small, single-module PRs where practical.

## Prompt provenance (ADR-008)

All prompt text in this repository must be original work. Principles learned from studying production tools are fair game (recorded per-principle in [docs/PRIOR-ART.md](docs/PRIOR-ART.md)); reproducing or closely paraphrasing another tool's prompt text is prohibited. Do not paste, adapt, or "reference while writing" any external system-prompt text. **Prompt PRs are reviewed for provenance; contributions derived from other tools' prompt text will be rejected**, whether the text appears in prompts, docs, ADRs, issues, comments, or commit messages.

## The eval merge bar

From M1 onward, `evals/` holds a golden prompt set scored by deterministic structural checks. **Prompt- or recipe-changing PRs must not regress the golden set** — that's the community merge bar, enforced in CI. New generation behavior lands with new eval cases.

## PR checklist

1. `npm run typecheck && npm run lint && npm run test:unit` green locally.
2. Invariant tests updated if you touched a trust boundary.
3. Docs updated if you touched architecture, schemas, or network behavior.
4. Commits signed off (DCO).
