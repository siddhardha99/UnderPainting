// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { applyArtifactHtml, resetArtifact, type ArtifactHost } from '../../src/webview/artifact/artifactDom';
import { morphChildren } from '../../src/webview/artifact/morph';

/**
 * The streaming renderer and its defense-in-depth sanitizer. The primary
 * boundaries against hostile artifacts are the iframe sandbox and CSP
 * (test/invariants/csp.test.ts); this suite proves the renderer additionally
 * never lets script-bearing markup join the live DOM at all (P6, M0 task 5:
 * "a hostile artifact fixture is inert").
 */

function makeHost(): ArtifactHost {
  document.body.innerHTML = '';
  const styleHost = document.createElement('div');
  const root = document.createElement('div');
  document.body.append(styleHost, root);
  return { styleHost, root };
}

describe('hostile artifact fixture is inert', () => {
  const hostile = fs.readFileSync(
    path.resolve(__dirname, '../fixtures/hostile-artifact.html'),
    'utf8',
  );
  let host: ArtifactHost;

  beforeEach(() => {
    host = makeHost();
    applyArtifactHtml(host, hostile, new DOMParser());
  });

  it('renders the benign content', () => {
    expect(host.root.querySelector('h1')?.textContent).toBe('Totally normal design');
  });

  it('strips every script-capable element', () => {
    for (const selector of ['script', 'iframe', 'object', 'embed', 'base', 'meta', 'link']) {
      expect(host.root.querySelectorAll(selector).length, selector).toBe(0);
      expect(host.styleHost.querySelectorAll(selector).length, selector).toBe(0);
    }
  });

  it('strips event-handler attributes and javascript: URLs', () => {
    const serialized = host.root.innerHTML;
    expect(serialized).not.toMatch(/on\w+=/i);
    expect(serialized).not.toContain('javascript:');
    expect(host.root.querySelector('a')?.hasAttribute('href')).toBe(false);
    expect(host.root.querySelector('form')?.getAttribute('action')).toBe(
      'https://evil.example/submit', // https action survives sanitize; sandbox (no allow-forms) blocks submission
    );
  });

  it('keeps the artifact style block but drops external references', () => {
    expect(host.styleHost.querySelector('style')?.textContent).toContain('--bg');
    expect(host.styleHost.querySelectorAll('link, meta').length).toBe(0);
  });
});

describe('streaming morph', () => {
  it('patches progressively without rebuilding untouched nodes', () => {
    const host = makeHost();
    const parser = new DOMParser();

    applyArtifactHtml(host, '<!doctype html><body><h1 style="color:red">Ti', parser);
    const h1Before = host.root.querySelector('h1');
    expect(h1Before?.textContent).toBe('Ti');

    applyArtifactHtml(
      host,
      '<!doctype html><body><h1 style="color:red">Title</h1><p>body text</p>',
      parser,
    );
    const h1After = host.root.querySelector('h1');
    // Identity preserved: the streamed completion patched the existing node.
    expect(h1After).toBe(h1Before);
    expect(h1After?.textContent).toBe('Title');
    expect(host.root.querySelector('p')?.textContent).toBe('body text');
  });

  it('replaces incompatible nodes and prunes removed ones', () => {
    const container = document.createElement('div');
    container.innerHTML = '<p>a</p><span>b</span><em>c</em>';
    const next = document.createElement('div');
    next.innerHTML = '<p>a</p><strong>b!</strong>';
    morphChildren(container, next);
    expect(container.innerHTML).toBe('<p>a</p><strong>b!</strong>');
  });

  it('reset clears both containers', () => {
    const host = makeHost();
    applyArtifactHtml(host, '<body><p>x</p>', new DOMParser());
    resetArtifact(host);
    expect(host.root.childNodes.length).toBe(0);
    expect(host.styleHost.childNodes.length).toBe(0);
  });
});
