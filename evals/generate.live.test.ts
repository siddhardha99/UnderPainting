import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { OpenRouterClient } from '../src/host/client/OpenRouterClient';
import { assembleArtifact } from '../src/host/orchestrator/scaffold';
import { extractHtml } from '../src/host/orchestrator/extractHtml';
import { refinementSurvivalRatio } from '../src/host/validator/Validator';
import { loadCases, scoreArtifact } from './harness';

/**
 * LIVE golden-set generation (opt-in — costs money, never per-PR):
 *
 *   OPENROUTER_EVAL_KEY=sk-or-… OPENROUTER_EVAL_MODEL=<model-id> npm run evals
 *
 * Generates each golden case through the real pipeline (core prompt +
 * scaffold assembly), writes the artifact to <case>/outputs/live-<model>.html
 * (committed outputs become the deterministic merge bar), scores it, and
 * runs the A7 targeted-edit diff-minimality check on a live refinement.
 * Whose key funds this in shared CI is the open question in brief §14.
 */

const KEY = process.env['OPENROUTER_EVAL_KEY'];
const MODEL = process.env['OPENROUTER_EVAL_MODEL'];
const liveSuite = KEY && MODEL ? describe : describe.skip;

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

liveSuite('live golden-set generation (paid, opt-in)', () => {
  const client = new OpenRouterClient();
  const core = read('prompts/core.md');
  const scaffold = read('scaffolds/page.html');
  const cases = loadCases(path.resolve(__dirname, 'golden'));

  for (const goldenCase of cases) {
    it(
      `${goldenCase.slug}: generate, persist output, score`,
      async () => {
        const result = await client.streamChat({
          apiKey: KEY!,
          model: MODEL!,
          system: core,
          user: goldenCase.prompt,
          signal: AbortSignal.timeout(180_000),
        });
        const artifact = assembleArtifact(scaffold, extractHtml(result.text));
        const outputDir = path.join(goldenCase.dir, 'outputs');
        fs.mkdirSync(outputDir, { recursive: true });
        const file = path.join(outputDir, `live-${MODEL!.replace(/[^a-z0-9.-]+/gi, '_')}.html`);
        fs.writeFileSync(file, artifact, 'utf8');

        const failures = scoreArtifact(goldenCase, artifact).filter((r) => !r.pass);
        expect(
          failures,
          `${goldenCase.slug} (${file}):\n` + failures.map((f) => `${f.checkId}: ${f.detail}`).join('\n'),
        ).toEqual([]);
      },
      240_000,
    );
  }

  it(
    'A7 targeted-edit diff minimality on a live refinement',
    async () => {
      const pricing = cases.find((c) => c.slug === 'inkwell-pricing');
      expect(pricing).toBeDefined();
      const outputs = fs
        .readdirSync(path.join(pricing!.dir, 'outputs'))
        .filter((f) => f.endsWith('.html'));
      expect(outputs.length).toBeGreaterThan(0);
      const base = fs.readFileSync(path.join(pricing!.dir, 'outputs', outputs[0]!), 'utf8');

      const refine = read('prompts/refine.md');
      const result = await client.streamChat({
        apiKey: KEY!,
        model: MODEL!,
        system: `${core}\n\n${refine}`,
        user: `<<<ARTIFACT\n${base}\nARTIFACT>>>\n\nInstruction: Change the Pro plan price from $8/mo to $9/mo`,
        signal: AbortSignal.timeout(180_000),
      });
      const refined = extractHtml(result.text);
      const survival = refinementSurvivalRatio(base, refined);
      // The golden bar for a one-value edit: at least 85% of source lines survive.
      expect(survival, `survival ratio ${survival.toFixed(3)}`).toBeGreaterThan(0.85);
      expect(refined).toContain('$9');
    },
    240_000,
  );
});
