import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assembleArtifact, hasScaffoldMarker } from '../../src/host/orchestrator/scaffold';
import { validateArtifact } from '../../src/host/validator/Validator';

const scaffold = fs.readFileSync(path.resolve(__dirname, '../../scaffolds/page.html'), 'utf8');

const FRAGMENT =
  '<style>\n:root { --ink: #111827; --bg: #ffffff; }\n</style>\n' +
  '<h1 style="color: var(--ink)">Hello</h1><p style="color: var(--ink)">Body text.</p>';

describe('scaffold assembly (A5, M1 item 7)', () => {
  it('splices style innards and body into the shell', () => {
    const out = assembleArtifact(scaffold, FRAGMENT);
    expect(out).toMatch(/^<!doctype html>/);
    expect(out).toContain('--ink: #111827;');
    expect(out).toContain('scaffold base reset');
    expect(out).toContain('<h1 style="color: var(--ink)">Hello</h1>');
    expect(out).not.toContain('{{STYLE}}');
    expect(out).not.toContain('{{BODY}}');
    expect(hasScaffoldMarker(out)).toBe(true);
  });

  it('assembled output passes the validator', () => {
    expect(validateArtifact(assembleArtifact(scaffold, FRAGMENT))).toEqual([]);
  });

  it('streams safely: an unclosed style block routes to the STYLE slot (tokens paint first)', () => {
    const partial = '<style>\n:root { --ink: #111';
    const out = assembleArtifact(scaffold, partial);
    expect(out).toContain(':root { --ink: #111');
    const bodySection = out.slice(out.indexOf('<body>'));
    expect(bodySection).not.toContain('--ink'); // nothing leaked into body
  });

  it('handles fragments with no style block yet', () => {
    const out = assembleArtifact(scaffold, '');
    expect(out).toMatch(/^<!doctype html>/);
  });

  it('passes a disobedient full document through instead of nesting shells', () => {
    const full = '<!doctype html><html><head></head><body><p>x</p></body></html>';
    expect(assembleArtifact(scaffold, full)).toBe(full);
    expect((assembleArtifact(scaffold, full).match(/<!doctype/gi) ?? []).length).toBe(1);
  });
});
