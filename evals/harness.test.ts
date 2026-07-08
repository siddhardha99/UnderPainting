import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadCases, listArtifacts, scoreArtifact, scoreAnalyzer } from './harness';

/**
 * The golden-set merge bar (M1 item 10): reference outputs must pass their
 * case checks; baselines are scored and reported but never gate. Run via
 * `npm run evals` — wired into CI for every PR.
 */

const GOLDEN = path.resolve(__dirname, 'golden');
const cases = loadCases(GOLDEN);

describe('golden set', () => {
  it('loads all cases with prompts and checks', () => {
    expect(cases.length).toBeGreaterThanOrEqual(2);
    for (const goldenCase of cases) {
      expect(goldenCase.prompt.length).toBeGreaterThan(10);
      expect(goldenCase.checks.length).toBeGreaterThan(0);
    }
  });

  for (const goldenCase of cases) {
    describe(goldenCase.slug, () => {
      const outputs = listArtifacts(goldenCase.dir, 'outputs');
      const baselines = listArtifacts(goldenCase.dir, 'baselines');

      if (goldenCase.analyzer) {
        it('clarify-analyzer expectations hold (GATING)', () => {
          const failures = scoreAnalyzer(goldenCase.analyzer!).filter((r) => !r.pass);
          expect(failures, failures.map((f) => f.detail).join('\n')).toEqual([]);
        });
      }

      for (const artifact of outputs) {
        it(`output ${path.basename(artifact)} passes every gating check`, () => {
          const html = fs.readFileSync(artifact, 'utf8');
          const results = scoreArtifact(goldenCase, html);
          // A1 token-styling is the ONE dimension the product actively fixes
          // via the validator's correction loop (M1 item 6). Committed live
          // outputs are raw first drafts (the harness bypasses the loop), so
          // gating them on A1 would hold the model to a standard the product
          // itself corrects. A1 is advisory here; everything the product does
          // NOT auto-correct — structure, A2, A3, A6 commitments — hard-gates.
          const ADVISORY = new Set(['a1-token-styling']);
          for (const r of results.filter((x) => !x.pass && ADVISORY.has(x.checkId))) {
            console.log(`[advisory] ${goldenCase.slug}/${path.basename(artifact)} ${r.checkId} — ${r.detail}`);
          }
          const gating = results.filter((r) => !r.pass && !ADVISORY.has(r.checkId));
          expect(gating.map((f) => `${f.checkId}: ${f.detail}`).join('\n')).toBe('');
        });
      }

      it('baselines are scored and reported (informational, never gating)', () => {
        for (const artifact of baselines) {
          const html = fs.readFileSync(artifact, 'utf8');
          const results = scoreArtifact(goldenCase, html);
          for (const r of results) {
            console.log(
              `[baseline] ${goldenCase.slug}/${path.basename(artifact)} ${r.pass ? 'PASS' : 'fail'} ${r.checkId}${r.pass ? '' : ` — ${r.detail}`}`,
            );
          }
        }
        expect(true).toBe(true);
      });
    });
  }
});
