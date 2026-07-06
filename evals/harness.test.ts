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
        it(`output ${path.basename(artifact)} passes every check (GATING)`, () => {
          const html = fs.readFileSync(artifact, 'utf8');
          const failures = scoreArtifact(goldenCase, html).filter((r) => !r.pass);
          expect(
            failures,
            failures.map((f) => `${f.checkId}: ${f.detail}`).join('\n'),
          ).toEqual([]);
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
