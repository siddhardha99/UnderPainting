# Underpainting

**An open-source, local-first AI design canvas inside VS Code.** Bring your own OpenRouter key, generate UI grounded in the design system already in your repo, see the real cost of every request, and hand finished designs to your coding agent as an executable spec.

> In classical painting, the underpainting is the grounded first layer — it establishes composition and values before the final layers go on. This tool is that layer for your product's UI.

- 🔒 **Local-first.** No backend, no account, no telemetry. The workspace is the database; git is the collaboration layer. The extension talks to exactly one network destination: `openrouter.ai`. [Audit it in one minute →](PRIVACY.md)
- 🎨 **Grounded.** Generates against the design tokens and components that already exist in your workspace (arriving in v0.1).
- 💸 **Radically cost-transparent.** Every request shows its actual dollar cost, read from OpenRouter's own accounting — never estimated.
- 🆓 **Free forever.** The client is Apache-2.0 with no license gates and no feature clawbacks — ever.

## How this differs from hosted AI design tools

Three structural differences — properties of the architecture, not feature-list items:

1. **Exactly one auditable network destination.** Everything leaves your machine to `openrouter.ai` or not at all — verifiable in [PRIVACY.md](PRIVACY.md) (the complete endpoint list fits on one screen) and enforced by CI tests that fail if any other module gains network access.
2. **Bring your own key, any model.** You pay OpenRouter's price with your own key and pick from its live catalog — no markup, no bundled "credits", no model lock-in.
3. **Exact cost, from the provider's own accounting.** Every request shows the dollar amount OpenRouter actually recorded for it — read from the API, never estimated.

## Status: pre-alpha (Milestone 0 — walking skeleton)

What works today:

1. `Underpainting: Set OpenRouter API Key` — stored in VS Code Secret Storage, validated against OpenRouter, remaining credits shown.
2. `Underpainting: Open Canvas` — type a prompt, press **Generate**, and watch a self-contained HTML artifact stream progressively onto a sandboxed canvas.
3. When the stream completes, the exact cost of that request appears inline and in the *Underpainting* output channel.
4. **Cancel** aborts the HTTP stream within a second, so billing for unconsumed output stops.

The v0.1 backlog (design-system extraction, versioned documents, direct editing, validator, export/handoff, eval harness) is specified in [BUILD_BRIEF.md](BUILD_BRIEF.md).

## Development

```sh
npm install
npm run build        # bundle extension + webview scripts
npm run test:unit    # unit + invariant tests (vitest)
npm test             # + integration tests in a real VS Code
```

Press <kbd>F5</kbd> in VS Code to launch the extension development host.

The non-negotiables live in [BUILD_BRIEF.md §2](BUILD_BRIEF.md) and are enforced by the tests in [test/invariants/](test/invariants/) — start there before contributing. See [CONTRIBUTING.md](CONTRIBUTING.md) (DCO sign-off, prompt provenance policy) and [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE). The client is free forever ([ADR-005](docs/adr/005-client-free-forever.md)).
