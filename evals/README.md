# Evals

The eval harness itself (runner + deterministic scorers in CI) arrives with **M1 item 10** (BUILD_BRIEF.md §11). Golden cases accumulate here beforehand as data — every case added with a milestone is scored once the harness lands, and from then on prompt-changing PRs must not regress the set (the community merge bar).

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
