# ADR-007: Authoring standards (§7) as the generation format

**Status:** Accepted

## Decision

Generated artifacts follow the authoring standards A1–A7 in BUILD_BRIEF.md §7, enforced by the Validator (M1), not merely requested in prompts. The defining move is the **token-block exception**: all styling is inline (`style="…"`), except a single `<style>` block at the top of the document holding only `:root` token declarations, `@font-face`, `@keyframes`, and a base reset.

## Rationale

Three constraints compound into this format:

- **Streaming:** the token block streams first, so every subsequent element paints immediately with correct brand values; class-based styling would leave content unstyled until a stylesheet arrives.
- **Free local edits (P4):** inline styles + one-text-run-per-leaf-element + literal repetition mean any canvas click maps to exactly one source span — edits never round-trip through the model.
- **Grounding:** the token block is copied from `.design/system/tokens.css` at generation time, reconciling inline styles with design-system grounding.
