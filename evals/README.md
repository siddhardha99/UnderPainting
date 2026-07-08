# Evals

The eval harness (M1 item 10) scores golden cases with deterministic structural checks — **the community merge bar**: prompt-changing PRs must not regress the set.

## Running

```sh
npm run evals                # deterministic scoring — runs on every PR in CI
OPENROUTER_EVAL_KEY=sk-or-… OPENROUTER_EVAL_MODEL=<model-id> npm run evals
                             # + LIVE generation of every case (paid, opt-in):
                             # writes <case>/outputs/live-<model>.html, scores it,
                             # and runs the A7 targeted-edit minimality check
```

Scoring rules per case directory: `outputs/*.html` **must pass every case check (gating)**; `baselines/*.html` are historical references — scored, reported in the log, never gating. Committing a live run's output into `outputs/` is how new generation behavior enters the merge bar. Whose key funds live runs in shared CI is an open question (brief §14; docs/OPEN_QUESTIONS.md #5).

## Golden case format

```text
evals/golden/<slug>/
  prompt.txt        the exact user prompt
  case.json         schema_version, what the case exercises, checks to score
  baselines/        reference artifacts for before/after comparisons
```

## Scoring rules — normative clarifications

These bind the scorers (M1 item 10) **and** the Validator's correction loop (M1 item 6). Getting them wrong burns the user's retry budget correcting compliant output.

### A6 targets *unrequested* material, not requested-but-unspecified content

Resolved at M0 review (2026-07-06):

- **Flag (A6 violation):** material the user did not ask for — extra sections, decorative statistics, filler padding to occupy space, invented data dressed up as real.
- **Do not flag:** plausible content that *fulfills* a request the user left unspecified. "A short feature list" is a request for invented-but-plausible feature names; supplying them is compliance, not fabrication.

The test: point to the prompt phrase the content answers. If there is one, the content is in scope regardless of whether its specifics were dictated. If there isn't, it's A6 material.

Example from the golden set: the Inkwell pricing prompt asks for "a short feature list" per plan — "Up to 50 notes" satisfies the request and must not be flagged; an unrequested testimonial section or a "Trusted by 10,000 teams" banner would be flagged.

### Refinement (item-5 review, 2026-07-06): invented commitments are always flagged

Content invention being licensed does **not** license *commitments*. Invented **policy or claims** — trial offers, "no card required", guarantees, refund/cancellation terms, prices or discounts not in the prompt, security/compliance assertions — are flagged even inside content the prompt requested. Feature names are design material; a 14-day trial is a promise the user's business never made. Golden case: `inkwell-pricing-commitments` (from a live run that added "All plans include a 14-day trial. No card required to start.").

## Live outputs gate on what the product *ships*, not the model's first draft

The live suite (`generate.live.test.ts`) calls the model directly — it bypasses grounding and the validator's correction loop. So a committed `outputs/*.html` is a raw first draft, not what a user receives. Gating therefore splits by whether the product auto-corrects the dimension:

- **`a1-token-styling` is advisory** on live outputs (logged as `[advisory]`, never fails). A1 is exactly what the correction loop (M1 item 6) fixes in-product, so gating raw drafts on it would penalize the model for something the product cleans up. First captured: Sonnet-4.5 emitting a raw `color: white`.
- **Everything the product does NOT auto-correct hard-gates**: document structure, A2 literal repetition, A3 self-containment, the A6 invented-commitments rule, and instruction-following (one-highlighted-card). A6 is the sharp one — commitments aren't a validator rule, so an invented "Start free trial" *ships*; the fix is prompt strengthening, verified here (core prompt v2).
