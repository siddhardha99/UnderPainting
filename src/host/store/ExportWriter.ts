import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * The ONLY sanctioned write path outside `.design/` (P9): user-chosen export
 * targets, and only after the caller has shown a diff preview and received
 * explicit confirmation. Lives in src/host/store/ because filesystem writes
 * exist nowhere else (write-scope invariant); the extension command in
 * src/extension.ts owns the preview/confirm UI and calls this last.
 */
export class ExportWriter {
  /**
   * Write pre-confirmed files. `confirmedByUser` is a deliberate speed bump:
   * there is no code path to an unconfirmed export write.
   */
  async writeConfirmed(
    files: Array<{ absolutePath: string; content: string }>,
    confirmedByUser: true,
  ): Promise<void> {
    void confirmedByUser;
    for (const file of files) {
      await fs.mkdir(path.dirname(file.absolutePath), { recursive: true });
      await fs.writeFile(file.absolutePath, file.content, 'utf8');
    }
  }
}
