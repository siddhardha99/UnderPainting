# Architecture

Everything privileged lives in the **extension host** (Node). The **canvas webview** is a sandboxed renderer with zero credentials and zero network. Between them is a single message bus, schema-validated with zod in both directions.

```
Extension Host (Node)
├─ KeyVault             src/host/keyvault/    SecretStorage only (P2)
├─ OpenRouterClient     src/host/client/      THE ONLY MODULE THAT FETCHES (P1)
│     hostname allowlist · SSE streaming · AbortController (≤1s cancel)
│     usage/cost readers (stream usage + /generation fallback)
├─ Orchestrator         src/host/orchestrator/ M0: prompt → stream → cost
├─ writeScope guard     src/host/store/       all fs writes confined to .design/ (P5/P9)
├─ SecretRedactor       src/host/logging/     every outbound string is scrubbed
└─ CanvasPanel          src/host/canvas/      webview lifecycle, validated poster

    │ postMessage — zod-validated both directions (src/shared/messages.ts); NEVER carries the key
    ▼
Canvas Webview (sandboxed)                    src/webview/canvas/
├─ strict CSP: default-src 'none', nonce-only scripts, no connect-src
├─ localResourceRoots: extension dist/webview + workspace .design/ only
└─ nested artifact <iframe sandbox="allow-scripts">  src/webview/artifact/
      opaque origin (no allow-same-origin) — cannot touch canvas chrome or VS Code API
      srcdoc bootstrap receives {patch, html} messages and morphs the DOM per chunk
      defense-in-depth sanitizer strips scripts / on* attrs / javascript: URLs
```

## Trust boundaries

1. **KeyVault → OpenRouterClient** is the only path credentials travel. The key is registered with the `SecretRedactor` the moment it enters the host; every log line and every webview message passes through redaction.
2. **Host ↔ webview** messages are validated with strict zod schemas on both sides; a message carrying an undeclared field (e.g. a key) fails parse instead of being forwarded (`src/host/canvas/poster.ts` is the single host-side choke point).
3. **Webview ↔ artifact iframe**: the artifact document has an opaque origin and inherits the webview's CSP, so artifact-injected scripts (which never learn the per-panel nonce) cannot execute and no network request of any kind is possible inside it. The renderer additionally sanitizes markup before it joins the DOM.

## Streaming render path (M0)

`Generate` click → `generate` message → Orchestrator streams from OpenRouter → each accumulated buffer passes `extractHtml` (fence/prose stripping) → `streamChunk` posts (throttled ~30ms) → canvas forwards to the artifact iframe → bootstrap parses with `DOMParser` and **morphs** the live DOM (index-based diff, `src/webview/artifact/morph.ts`) — no full reload, stable node identity, so completed content doesn't flicker while later content streams.

Cost is read from OpenRouter's `usage` accounting on the final SSE frame (requested via `usage: {include: true}`); if absent, one follow-up `GET /api/v1/generation` reads the recorded cost. It is never estimated.

## Activation budget

The **design budget for activation is ≤500ms** with no work before the first command (brief §10.1): `activate()` only registers commands; the output channel, client, and prompt file are created lazily on first use. The integration test asserts `<1500ms` — that number is a **flake-tolerant regression tripwire for shared CI runners, not the spec**. Treat any activation-time regression against the 500ms design budget as a bug even while CI stays green (OPEN_QUESTIONS #10 resolution).

## Invariants → tests

| Invariant | Test |
|---|---|
| P1 single network destination | `test/invariants/allowlist.test.ts` + eslint restriction |
| P2 key never leaves the host | `test/invariants/key-redaction.test.ts`, `webview-messages.test.ts` |
| P3 no call without user action | `test/unit/orchestrator.test.ts` |
| P5/P9 writes confined to .design/ | `test/invariants/write-scope.test.ts` |
| P6 hostile model output | `test/invariants/csp.test.ts`, `test/unit/artifactDom.test.ts` |
| P7 one-minute audit | PRIVACY-drift check inside `allowlist.test.ts` |
| §4 dependency budget | `test/invariants/dep-budget.test.ts` |

Not yet built (M1+): DocumentStore, DesignSystemExtractor, Validator, CostLedger, chat panel, model catalog. See BUILD_BRIEF.md §11.
