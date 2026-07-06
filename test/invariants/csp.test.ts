import { describe, expect, it } from 'vitest';
import { buildCanvasHtml, buildCsp, buildArtifactSrcdoc } from '../../src/host/canvas/canvasHtml';

/**
 * Invariant P6: the canvas webview treats model output as hostile. These
 * tests pin the exact CSP and sandbox attributes the webview ships with.
 * (Behavioral inertness of a hostile artifact against the DOM sanitizer is
 * covered in test/unit/artifactDom.test.ts; CSP and the sandbox attribute
 * asserted here are the primary boundaries.)
 */

const NONCE = 'TESTNONCE123';
const CSP_SOURCE = 'https://mock-webview.vscode-resource.test';

function html(): string {
  return buildCanvasHtml({
    cspSource: CSP_SOURCE,
    nonce: NONCE,
    canvasScriptUri: `${CSP_SOURCE}/canvas.js`,
    bootstrapJs: 'console.log("bootstrap")',
  });
}

function cspDirectives(): Map<string, string> {
  const match = html().match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
  expect(match).not.toBeNull();
  const map = new Map<string, string>();
  for (const part of match![1]!.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    map.set(name!, values.join(' '));
  }
  return map;
}

describe('P6: canvas webview CSP', () => {
  it('defaults to deny: default-src none', () => {
    expect(cspDirectives().get('default-src')).toBe("'none'");
  });

  it('has no network escape: no connect-src, no frame-src, no form-action grants', () => {
    const directives = cspDirectives();
    expect(directives.has('connect-src')).toBe(false); // default-src 'none' governs
    expect(directives.has('frame-src')).toBe(false);
    expect(directives.has('form-action')).toBe(false);
  });

  it('permits scripts only via the per-panel nonce', () => {
    const script = cspDirectives().get('script-src');
    expect(script).toBe(`'nonce-${NONCE}'`);
  });

  it('never grants unsafe-eval or remote sources anywhere', () => {
    const raw = [...cspDirectives().entries()].map(([k, v]) => `${k} ${v}`).join('; ');
    expect(raw).not.toContain('unsafe-eval');
    expect(raw).not.toMatch(/https?:(?!\/\/mock-webview)/); // only the webview's own resource origin
    expect(cspDirectives().get('img-src')).toBe('data:');
    expect(cspDirectives().get('font-src')).toBe('data:');
  });

  it('buildCsp is what the page actually carries', () => {
    expect(html()).toContain(buildCsp(CSP_SOURCE, NONCE));
  });
});

describe('P6: artifact iframe isolation', () => {
  it('every iframe is sandboxed with allow-scripts only — never allow-same-origin', () => {
    const iframes = html().match(/<iframe[^>]*>/g);
    // Frames mount dynamically, but only by cloning the template iframe —
    // so pinning every static iframe tag pins them all.
    expect(iframes).not.toBeNull();
    for (const tag of iframes!) {
      expect(tag).toContain('sandbox="allow-scripts"');
      expect(tag).not.toContain('allow-same-origin');
      expect(tag).toContain('srcdoc=');
    }
  });

  it('frame iframes exist only inside the clone template', () => {
    const page = html();
    const templateBody = page.match(/<template id="frame-template">([\s\S]*?)<\/template>/);
    expect(templateBody).not.toBeNull();
    const iframesInTemplate = templateBody![1]!.match(/<iframe/g)?.length ?? 0;
    const iframesTotal = page.match(/<iframe/g)?.length ?? 0;
    expect(iframesInTemplate).toBe(1);
    expect(iframesTotal).toBe(iframesInTemplate);
  });

  it('gives the bootstrap script the nonce and closes it safely', () => {
    const srcdoc = buildArtifactSrcdoc(NONCE, 'if (a </script> b) {}');
    expect(srcdoc).toContain(`<script nonce="${NONCE}">`);
    // A literal </script> inside the bundle must not terminate the tag early.
    expect(srcdoc.match(/<\/script>/g)!.length).toBe(1);
  });

  it('loads the canvas script only with the nonce', () => {
    const scripts = html().match(/<script[^>]*>/g)!;
    for (const tag of scripts) {
      expect(tag).toContain(`nonce="${NONCE}"`);
    }
  });
});
