import * as assert from 'node:assert';
import * as vscode from 'vscode';

/**
 * Integration smoke tests run inside a real VS Code (via @vscode/test-cli).
 * M0 task 1 acceptance: the extension activates lazily and quickly, and its
 * commands exist. The canvas opens without error.
 */

suite('underpainting activation', () => {
  test('activates within the lazy-activation budget', async () => {
    const extension = vscode.extensions.getExtension('underpainting.underpainting');
    assert.ok(extension, 'extension not found — packaging/publisher id mismatch?');
    const started = Date.now();
    await extension.activate();
    const elapsed = Date.now() - started;
    // Budget is ≤500ms (brief §10.1); CI machines are slow and shared, so
    // assert a looser bound while still catching accidental heavy activation.
    assert.ok(elapsed < 1500, `activation took ${elapsed}ms`);
  });

  test('registers all commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      'underpainting.openCanvas',
      'underpainting.setApiKey',
      'underpainting.clearApiKey',
    ]) {
      assert.ok(commands.includes(id), `missing command ${id}`);
    }
  });

  test('opens the canvas panel without error', async () => {
    await vscode.commands.executeCommand('underpainting.openCanvas');
    // Re-running reveals the existing panel rather than erroring.
    await vscode.commands.executeCommand('underpainting.openCanvas');
  });
});
