/**
 * ADR-002 commit path (M1 item 6): a COMPLETE artifact that PASSED the
 * validator renders as its own document with scripts enabled — inside the
 * same sandbox (opaque origin, no allow-same-origin) and the same inherited
 * CSP (no network of any kind).
 *
 * Mechanics: inline <script> tags receive the per-panel CSP nonce so the
 * browser executes them; scripts with a src= never get the nonce (and A3
 * rejects external references long before this point). Streaming artifacts
 * NEVER take this path — the morph renderer keeps stripping scripts while
 * content is incomplete.
 *
 * In v0.1 this path is deliberately dormant: the validator rejects any
 * <script>, so no validated artifact contains one. The mechanism exists —
 * and is tested — so v0.2 can relax the validator rule without touching the
 * render pipeline (ADR-002).
 */

export function needsScriptRender(html: string): boolean {
  return /<script\b/i.test(html);
}

export function committedSrcdoc(html: string, nonce: string): string {
  return html.replace(/<script\b(?![^>]*\bsrc\s*=)(?=[\s>])/gi, (match) => `${match} nonce="${nonce}"`);
}
