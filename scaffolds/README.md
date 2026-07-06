# Scaffolds

Versioned boilerplate shells that are **copied** into artifacts rather than regenerated — regenerating solved boilerplate spends the user's money on nothing (authoring standard A5).

- **`page.html`** — the document shell (doctype, head, meta, base reset) with `{{STYLE}}` and `{{BODY}}` slots. Fresh generations stream only a token `<style>` block + body markup; `src/host/orchestrator/scaffold.ts` assembles the full document around them, streaming-safely (an unclosed style block routes to the STYLE slot, so tokens paint first). Refinements and corrections operate on full assembled documents.
- **`browser-frame.html`** — a browser-chrome presentation wrapper (`{{URL}}`, `{{BODY}}` slots) for exports.

Each scaffold carries an `underpainting-scaffold: <name> v<N>` marker comment for provenance; bump the version when editing a scaffold — artifacts record which shell they were built with.
