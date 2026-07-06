# Baselines for inkwell-pricing

Both captured live on 2026-07-06 (model `~anthropic/claude-opus-latest`, core prompt v0) and approved at the item-5 review:

- **`m0-ungrounded.html`** — the same prompt with **no** extracted design system: the model invented an indigo palette. The "before" of the grounding comparison. Note: this run also invented the policy line "All plans include a 14-day trial…", which no prompt phrase licensed — the origin of the `inkwell-pricing-commitments` golden case.
- **`m1-grounded.html`** — the same prompt **after** `Underpainting: Extract Design System` ran against the sandbox demo theme (`--brand: #0ea5e9` etc.): defines `#0ea5e9` exactly once (in `:root`) and consumes `var(--brand…)` 18 times. The "after".
