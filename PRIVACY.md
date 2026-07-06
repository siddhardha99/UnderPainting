# Privacy — the one-minute audit

Underpainting has **no backend, no accounts, and no telemetry**. Your prompts, code, designs, and API key never touch a server we run — we don't run any.

## Every network call the extension can make

The extension talks to exactly one host: **`openrouter.ai`**, over HTTPS, using the API key you provide. All requests go through a single module ([src/host/client/OpenRouterClient.ts](src/host/client/OpenRouterClient.ts)) with a hardcoded hostname allowlist. This is the complete list:

| Request | Endpoint | When | What it carries |
|---|---|---|---|
| Generate a design | `POST /api/v1/chat/completions` | Only when you click **Generate** | Your prompt, the core prompt, your key |
| Validate key / show credits | `GET /api/v1/credits` | Only when you set your key | Your key |
| Look up a request's exact cost | `GET /api/v1/generation` | After a generation you started, if the stream didn't include usage | Your key, the generation id |
| Browse the model catalog | `GET /api/v1/models` | Only when you open a model picker, or accept the switch dialog after OpenRouter rejects your model | Your key |

That's the whole list. There are no background, scheduled, speculative, or warm-up requests — nothing happens on activation, on startup, or on a timer. Local edits never make network calls.

## Enforcement, not promises

- A lint rule and a CI test ([test/invariants/allowlist.test.ts](test/invariants/allowlist.test.ts)) fail the build if any module outside the client performs network I/O, or if this document stops listing an endpoint the client knows.
- Your API key lives only in VS Code Secret Storage on your machine. CI tests ([test/invariants/key-redaction.test.ts](test/invariants/key-redaction.test.ts)) verify it cannot appear in logs, error messages, or webview messages.
- The canvas webview has a CSP with no network access at all; generated artifacts render in a second sandbox inside it.
- Everything Underpainting saves is a plain file in your workspace under `.design/`.

Your relationship with OpenRouter (and the model providers it routes to) is governed by [OpenRouter's privacy policy](https://openrouter.ai/privacy) — Underpainting is a client of the API you already pay for, nothing more.
