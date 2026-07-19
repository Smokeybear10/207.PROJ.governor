import * as assert from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import { applyRepositoryChanges } from "../../workspaceRepairCommands";
import { snapshotRepository, type RepositoryRepairRequest } from "../../workspaceRepair";

suite("Workspace repair review", () => {
  test("applies a reviewed patch as unsaved edits and refuses stale test context", async () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(root, "a disposable workspace is required");
    const subdir = `repair-${randomUUID()}`;
    const source = `${subdir}/source.ts`;
    const test = `${subdir}/source.test.ts`;
    const before = "export const sum = (a: number, b: number) => a - b;\n";
    const after = "export const sum = (a: number, b: number) => a + b;\n";
    await mkdir(path.join(root, subdir));
    await writeFile(path.join(root, source), before);
    await writeFile(path.join(root, test), "// original test\n");
    try {
      const request: RepositoryRepairRequest = {
        requestId: randomUUID(), files: await snapshotRepository(root, [source, test]),
        editablePaths: [source], testPaths: [test], budgetUsd: "1.00"
      };
      const changes = [{ path: source, before, after }];
      await writeFile(path.join(root, test), "// changed test\n");
      await assert.rejects(applyRepositoryChanges(root, request, changes), /changed since/);
      assert.strictEqual(await readFile(path.join(root, source), "utf8"), before);
      await writeFile(path.join(root, test), "// original test\n");
      await applyRepositoryChanges(root, request, changes);
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, source)));
      assert.strictEqual(document.getText(), after);
      assert.strictEqual(document.isDirty, true);
      assert.strictEqual(await readFile(path.join(root, source), "utf8"), before, "applying does not save source automatically");
      await assert.rejects(applyRepositoryChanges(root, request, changes), /Save or revert/);
      await vscode.window.showTextDocument(document);
      await vscode.commands.executeCommand("workbench.action.files.revert");
    } finally {
      await rm(path.join(root, subdir), { recursive: true, force: true });
    }
  });

  test("rejects a protected-file patch before editing documents", async () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(root);
    const request: RepositoryRepairRequest = {
      requestId: randomUUID(), files: [{ path: "source.ts", content: "source" }, { path: "source.test.ts", content: "test" }],
      editablePaths: ["source.ts"], testPaths: ["source.test.ts"], budgetUsd: "1.00"
    };
    await assert.rejects(applyRepositoryChanges(root, request, [{ path: "source.test.ts", before: "test", after: "skipped" }]), /approved source/);
  });
});
