import { describe, expect, it } from 'vitest';
import { committedSrcdoc, needsScriptRender } from '../../src/webview/canvas/commitRender';

/**
 * ADR-002 scripts-enabled commit path — dormant in v0.1 (the validator
 * rejects scripts, so no validated artifact reaches it) but the mechanism
 * is pinned by tests so v0.2 can flip the validator rule safely.
 */

describe('commit render (ADR-002)', () => {
  it('detects script-bearing artifacts', () => {
    expect(needsScriptRender('<p>x</p>')).toBe(false);
    expect(needsScriptRender('<script>1</script>')).toBe(true);
  });

  it('injects the nonce into inline scripts only', () => {
    const out = committedSrcdoc(
      '<script>a()</script><script type="module">b()</script><script src="https://evil.example/x.js"></script>',
      'N0NCE',
    );
    expect(out).toContain('<script nonce="N0NCE">a()</script>');
    expect(out).toContain('<script nonce="N0NCE" type="module">b()</script>');
    // External-src scripts never receive the nonce — CSP keeps them dead
    // even if one slipped past A3.
    expect(out).toContain('<script src="https://evil.example/x.js"></script>');
    expect(out.match(/nonce=/g)!.length).toBe(2);
  });

  it('leaves script-free artifacts untouched', () => {
    const html = '<!doctype html><body><p>hi</p></body>';
    expect(committedSrcdoc(html, 'N')).toBe(html);
  });
});
