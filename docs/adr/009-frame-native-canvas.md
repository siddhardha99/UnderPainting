# ADR-009: Frame-native canvas; workspace-canvas polish deferred to post-alpha

**Status:** Accepted (human decision, 2026-07-06, M1 item-1 review)

## Decision

Every artifact version is a **frame**, from the data model up:

- **DocumentStore (M1 item 2)** models versions as frames; the webview exposes a frame selection model. Items 3 and 4 are built frame-native — "refine the *selected frame*", "edit the *selected frame*" — so any future canvas is only a container change, never a rework of chat or editing.
- **The item-2 surface:** each generation lands in a new titled frame (title shows model + cost); frames sit in a simple wrapping flow layout — no free-form arrange; zoom/fit controls; click to select. Every frame stays its own sandboxed iframe, but only the selected frame plus at most the on-screen ones keep a **live** iframe — off-screen frames drop to a lightweight placeholder and re-render from `.design/` on selection, so N frames never means N live iframes.
- **Explicitly deferred to post-alpha:** infinite pan/zoom surface, drag-arrange, minimap, frame grouping. This is a v0.2 headline candidate, decided from alpha feedback at the item-10 checkpoint (tracked in docs/OPEN_QUESTIONS.md).

## Rationale

The valuable part of a Figma-like workspace — side-by-side comparison, iterations that never overwrite each other — ships now and falls straight out of DocumentStore. The risky, low-differentiation polish (spatial canvas mechanics) waits until the ten-user test validates the thesis. Building items 3–4 frame-native makes the deferral cheap instead of a rework.
