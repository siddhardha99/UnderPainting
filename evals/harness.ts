import * as fs from 'node:fs';
import * as path from 'node:path';
import { validateArtifact } from '../src/host/validator/Validator';
import { fieldsToAsk, type ClarifyField } from '../src/shared/clarify';

/**
 * Eval harness v1 (M1 item 10): deterministic structural scoring of golden
 * cases. No API calls, no randomness — a PR either keeps the golden set
 * green or it doesn't (the community merge bar, brief §11.10/§12).
 *
 * Scored artifacts per case:
 * - `outputs/*.html` — reference outputs that MUST pass every case check (gating).
 * - `baselines/*.html` — historical references; scored and reported, never gating.
 */

export interface AnalyzerExpectation {
  prompt: string;
  groundingTokensPresent: boolean;
  mustAsk?: string[];
  mustNotAsk?: string[];
}

export interface GoldenCase {
  slug: string;
  dir: string;
  prompt: string;
  checks: Array<{ id: string; kind: string; note?: string }>;
  /** Clarify-analyzer table (v0.2 item 1) — gating, artifact-free. */
  analyzer?: AnalyzerExpectation[];
}

export interface CheckResult {
  checkId: string;
  pass: boolean;
  detail: string;
}

export function loadCases(goldenDir: string): GoldenCase[] {
  const cases: GoldenCase[] = [];
  for (const entry of fs.readdirSync(goldenDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(goldenDir, entry.name);
    const casePath = path.join(dir, 'case.json');
    if (!fs.existsSync(casePath)) continue;
    const parsed = JSON.parse(fs.readFileSync(casePath, 'utf8')) as {
      slug: string;
      checks: GoldenCase['checks'];
      analyzer?: AnalyzerExpectation[];
    };
    cases.push({
      slug: parsed.slug,
      dir,
      prompt: fs.readFileSync(path.join(dir, 'prompt.txt'), 'utf8').trim(),
      checks: parsed.checks,
      analyzer: parsed.analyzer,
    });
  }
  return cases;
}

export function listArtifacts(caseDir: string, subdir: 'outputs' | 'baselines'): string[] {
  const dir = path.join(caseDir, subdir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.html'))
    .map((f) => path.join(dir, f));
}

/**
 * Invented commitments (item-5 review decision): policy/claim language is
 * flagged unless the prompt itself licenses it — even where content
 * invention is licensed.
 */
const COMMITMENT_PATTERNS: Array<[RegExp, string]> = [
  [/\b\d+[- ]day (?:free )?trial\b/i, 'trial offer'],
  [/\bfree trial\b/i, 'trial offer'],
  [/\bno (?:credit )?card\b/i, 'no-card promise'],
  [/\bmoney[- ]back\b/i, 'money-back promise'],
  [/\bguaranteed?\b/i, 'guarantee'],
  [/\bcancel (?:anytime|at any time)\b/i, 'cancellation promise'],
  [/\brefund/i, 'refund promise'],
  [/\b(?:soc ?2|gdpr|hipaa|iso ?27001)\b/i, 'compliance claim'],
  [/\bend-to-end encrypt/i, 'security claim'],
];

export function scoreArtifact(goldenCase: GoldenCase, html: string): CheckResult[] {
  const issues = validateArtifact(html);
  const byRule = (rule: string) => issues.filter((i) => i.rule === rule);
  const results: CheckResult[] = [];

  for (const check of goldenCase.checks) {
    switch (check.id) {
      case 'a1-token-styling': {
        const found = byRule('A1');
        results.push(result(check.id, found.length === 0, found));
        break;
      }
      case 'a2-literal-repetition': {
        const found = [...byRule('A2'), ...byRule('scripts')];
        results.push(result(check.id, found.length === 0, found));
        break;
      }
      case 'a3-self-contained': {
        const found = byRule('A3');
        results.push(result(check.id, found.length === 0, found));
        break;
      }
      case 'one-highlighted-card': {
        // Deterministic proxy: the artifact names all three plans and carries
        // a recommendation marker exactly once.
        const plans = ['Free', 'Pro', 'Team'].every((p) => html.includes(p));
        const markers = html.match(/recommended|most popular/gi) ?? [];
        const pass = plans && markers.length >= 1 && markers.length <= 2;
        results.push({
          checkId: check.id,
          pass,
          detail: pass
            ? 'three plans present, one recommendation marker'
            : `plans present: ${plans}; recommendation markers: ${markers.length}`,
        });
        break;
      }
      case 'a6-no-unrequested-material': {
        // Deterministic subset: no sections beyond what the prompt licenses —
        // approximated by the absence of testimonial/trust-banner vocabulary.
        const banned = /testimonial|trusted by|as seen (?:in|on)|\b\d[\d,]* (?:users|teams|companies)\b/i.exec(html);
        results.push({
          checkId: check.id,
          pass: banned === null,
          detail: banned ? `unrequested material: "${banned[0]}"` : 'no unrequested sections detected',
        });
        break;
      }
      case 'a6-no-invented-commitments': {
        const hits = COMMITMENT_PATTERNS.filter(
          ([pattern]) => pattern.test(html) && !pattern.test(goldenCase.prompt),
        );
        results.push({
          checkId: check.id,
          pass: hits.length === 0,
          detail:
            hits.length === 0
              ? 'no unlicensed policy/claim language'
              : `invented commitments: ${hits.map(([, label]) => label).join(', ')}`,
        });
        break;
      }
      default:
        results.push({ checkId: check.id, pass: true, detail: `no deterministic scorer (kind: ${check.kind}) — skipped` });
    }
  }
  return results;
}

/** Score a clarify-analyzer table: asked fields must match the licensing expectations. */
export function scoreAnalyzer(expectations: AnalyzerExpectation[]): CheckResult[] {
  return expectations.map((expectation, index) => {
    const asked = new Set<ClarifyField>(
      fieldsToAsk(expectation.prompt, expectation.groundingTokensPresent),
    );
    const problems: string[] = [];
    for (const field of expectation.mustAsk ?? []) {
      if (!asked.has(field as ClarifyField)) problems.push(`should ask "${field}" but does not`);
    }
    for (const field of expectation.mustNotAsk ?? []) {
      if (asked.has(field as ClarifyField)) problems.push(`asks "${field}" although the prompt answers it`);
    }
    return {
      checkId: `clarify-analyzer[${index}]`,
      pass: problems.length === 0,
      detail: problems.length === 0 ? `"${expectation.prompt}" → asks: ${[...asked].join(', ')}` : `"${expectation.prompt}": ${problems.join('; ')}`,
    };
  });
}

function result(checkId: string, pass: boolean, issues: Array<{ message: string }>): CheckResult {
  return {
    checkId,
    pass,
    detail: pass ? 'clean' : issues.map((i) => i.message).join(' | '),
  };
}
