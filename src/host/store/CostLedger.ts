import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { assertWritablePath, DESIGN_DIR } from './writeScope';

/**
 * CostLedger (M1 item 8, §6/§9): append-only spend records in
 * `.design/ledger.jsonl`. Personal data — the shipped `.design/.gitignore`
 * excludes it. Every record is OpenRouter's own accounting, never estimated;
 * correction passes are recorded separately from the generation that
 * triggered them so the ledger explains exactly where money went.
 */

export const spendRecordSchema = z
  .object({
    schema_version: z.literal(1),
    ts: z.string(),
    kind: z.enum(['generation', 'refinement', 'correction']),
    model: z.string(),
    costUsd: z.number().nullable(),
    promptTokens: z.number().nullable(),
    completionTokens: z.number().nullable(),
  })
  .strict();
export type SpendRecord = z.infer<typeof spendRecordSchema>;

export interface LedgerSummary {
  records: number;
  totalUsd: number;
  /** Records whose cost OpenRouter did not report; totalUsd excludes them. */
  unpriced: number;
  byKind: Record<SpendRecord['kind'], { records: number; totalUsd: number }>;
}

export class CostLedger {
  private readonly ledgerRelative = path.join(DESIGN_DIR, 'ledger.jsonl');

  constructor(private readonly workspaceRoot: string) {}

  async append(record: Omit<SpendRecord, 'schema_version' | 'ts'>): Promise<void> {
    const target = assertWritablePath(this.workspaceRoot, this.ledgerRelative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const full: SpendRecord = { schema_version: 1, ts: new Date().toISOString(), ...record };
    await fs.appendFile(target, JSON.stringify(full) + '\n', 'utf8');
  }

  async summary(): Promise<LedgerSummary> {
    const empty: LedgerSummary = {
      records: 0,
      totalUsd: 0,
      unpriced: 0,
      byKind: {
        generation: { records: 0, totalUsd: 0 },
        refinement: { records: 0, totalUsd: 0 },
        correction: { records: 0, totalUsd: 0 },
      },
    };
    let raw: string;
    try {
      raw = await fs.readFile(path.join(this.workspaceRoot, this.ledgerRelative), 'utf8');
    } catch {
      return empty;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // a torn line never breaks accounting of the rest
      }
      const record = spendRecordSchema.safeParse(parsed);
      if (!record.success) continue;
      empty.records++;
      empty.byKind[record.data.kind].records++;
      if (record.data.costUsd === null) {
        empty.unpriced++;
      } else {
        empty.totalUsd += record.data.costUsd;
        empty.byKind[record.data.kind].totalUsd += record.data.costUsd;
      }
    }
    return empty;
  }
}
