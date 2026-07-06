# Security policy

Underpainting's security posture is its product: one network destination, a key that never leaves the extension host, hostile-by-default treatment of model output, and writes confined to `.design/`. Reports that break any of those are treated as **critical**.

## Reporting a vulnerability

Please report privately — do not open a public issue:

- **GitHub:** use *Security → Report a vulnerability* (private advisory) on this repository once it is hosted.
- Include reproduction steps and the invariant you believe is violated (see BUILD_BRIEF.md §2).

You should receive an acknowledgement within 72 hours. Coordinated disclosure is appreciated; we'll credit reporters in release notes unless you prefer otherwise.

## Severity guide

| Class | Examples | Severity |
|---|---|---|
| Key handling (P2) | key in logs, settings, webview messages, or any file | Critical |
| Network scope (P1) | any code path reaching a host other than `openrouter.ai` | Critical |
| Sandbox escape (P6) | generated artifact code touching the canvas chrome, VS Code API, or network | Critical |
| Write scope (P5/P9) | writes outside `.design/` without diff-preview confirmation | High |
| Spend safety (P3) | API calls without explicit user action; unbounded retries | High |

## Scope notes

The extension deliberately has no server-side components; there is nothing to report against infrastructure we run, because we run none. Vulnerabilities in OpenRouter itself belong to [OpenRouter's disclosure process](https://openrouter.ai).
