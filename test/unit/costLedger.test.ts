import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CostLedger } from '../../src/host/store/CostLedger';

let root: string;
let ledger: CostLedger;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'underpainting-ledger-'));
  ledger = new CostLedger(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('CostLedger (M1 item 8)', () => {
  it('appends records and sums exact spend by kind', async () => {
    await ledger.append({ kind: 'generation', model: 'a/b', costUsd: 0.05, promptTokens: 10, completionTokens: 20 });
    await ledger.append({ kind: 'correction', model: 'c/d', costUsd: 0.01, promptTokens: 5, completionTokens: 5 });
    await ledger.append({ kind: 'refinement', model: 'a/b', costUsd: null, promptTokens: null, completionTokens: null });

    const summary = await ledger.summary();
    expect(summary.records).toBe(3);
    expect(summary.totalUsd).toBeCloseTo(0.06);
    expect(summary.unpriced).toBe(1); // never estimated — unknown stays visible, not guessed
    expect(summary.byKind.generation.totalUsd).toBeCloseTo(0.05);
    expect(summary.byKind.correction.totalUsd).toBeCloseTo(0.01);
  });

  it('is append-only jsonl inside .design/ and survives a torn line', async () => {
    await ledger.append({ kind: 'generation', model: 'a/b', costUsd: 0.02, promptTokens: 1, completionTokens: 1 });
    const file = path.join(root, '.design', 'ledger.jsonl');
    await fs.appendFile(file, '{"torn'); // simulated crash mid-append
    await fs.appendFile(file, '\n');
    const again = new CostLedger(root);
    await again.append({ kind: 'generation', model: 'a/b', costUsd: 0.03, promptTokens: 1, completionTokens: 1 });
    const summary = await again.summary();
    expect(summary.records).toBe(2);
    expect(summary.totalUsd).toBeCloseTo(0.05);
  });

  it('empty workspace reads as zero, not an error', async () => {
    const summary = await ledger.summary();
    expect(summary.records).toBe(0);
    expect(summary.totalUsd).toBe(0);
  });
});
