import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as vscode from "vscode";
import { GovernorApiError, GovernorHttpClient, normalizeBaseUrl } from "./apiClient";
import { isValidBudgetUsd } from "./extensionState";
import { formatMicroUsd, RepairClient } from "./repairClient";
import {
  discoverRepositoryFiles,
  isRepositorySourcePath,
  isRepositoryTestPath,
  parseRepositoryRun,
  readRepositoryFile,
  RepositoryRepairClient,
  snapshotRepository,
  type RepositoryChange,
  type RepositoryRepairRequest,
  type RepositoryRun
} from "./workspaceRepair";

type SavedRepair = {
  root: string;
  baseUrl: string;
  request: RepositoryRepairRequest;
  run?: RepositoryRun;
  applied?: boolean;
};

type Dependencies = {
  context: vscode.ExtensionContext;
  configureServer(): Promise<unknown>;
  baseUrl(): string;
  timeoutMs(): number;
  output: vscode.OutputChannel;
};

const SCHEME = "governor-repair";
const STORAGE_NAME = "workspace-repair.json";

function assertTrustedWorkspace(): void {
  if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before preparing a repair.");
  if (!vscode.workspace.workspaceFolders?.length) throw new Error("Open a local project folder first.");
}

async function selectFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 1) return folders[0];
  return vscode.window.showWorkspaceFolderPick({ placeHolder: "Choose the package containing the failing test" });
}

function dirtyFiles(root: string, files: readonly string[]): string[] {
  const selected = new Set(files.map((name) => vscode.Uri.file(path.join(root, name)).toString()));
  return vscode.workspace.textDocuments.filter((doc) => doc.isDirty && selected.has(doc.uri.toString())).map((doc) => path.relative(root, doc.uri.fsPath));
}

async function assertSnapshotUnchanged(saved: SavedRepair): Promise<void> {
  const dirty = dirtyFiles(saved.root, saved.request.files.map((file) => file.path));
  if (dirty.length) throw new Error(`Save or revert these files before continuing: ${dirty.join(", ")}.`);
  for (const file of saved.request.files) {
    if (await readRepositoryFile(saved.root, file.path) !== file.content) {
      throw new Error(`${file.path} changed since this repair was prepared. Start a new repair with the current files.`);
    }
  }
}

export async function applyRepositoryChanges(
  root: string,
  request: RepositoryRepairRequest,
  changes: readonly RepositoryChange[]
): Promise<void> {
  assertTrustedWorkspace();
  const roots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
  if (!roots.includes(root)) throw new Error("Reopen the original workspace folder before applying this repair.");
  const originalFiles = new Map(request.files.map((file) => [file.path, file.content]));
  if (!changes.length || new Set(changes.map((change) => change.path)).size !== changes.length || changes.some((change) =>
    !request.editablePaths.includes(change.path) || !isRepositorySourcePath(change.path) || change.before !== originalFiles.get(change.path)
  )) throw new Error("The proposed patch does not match the approved source files.");
  const documents = await Promise.all(changes.map((change) => vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, change.path)))));
  await assertSnapshotUnchanged({ root, request, baseUrl: "" });
  const dirty = dirtyFiles(root, request.files.map((file) => file.path));
  if (dirty.length) throw new Error(`Selected files changed while preparing the patch: ${dirty.join(", ")}.`);
  const edit = new vscode.WorkspaceEdit();
  changes.forEach((change, index) => {
    const document = documents[index]!;
    if (document.isDirty || document.getText() !== change.before) throw new Error(`${change.path} changed while preparing the patch. Nothing was applied.`);
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), change.after);
  });
  if (!await vscode.workspace.applyEdit(edit)) throw new Error("The editor could not apply the changes. Your source files were not saved.");
}

export function registerWorkspaceRepairCommands(deps: Dependencies): void {
  const { context } = deps;
  const previews = new Map<string, string>();
  let busy = false;
  const storageDirectory = context.storageUri?.fsPath ?? path.join(context.globalStorageUri.fsPath, "workspace-repair");
  const storageFile = path.join(storageDirectory, STORAGE_NAME);

  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
    provideTextDocumentContent: (uri) => previews.get(uri.toString()) ?? "This repair preview is no longer available."
  }));

  const save = async (saved: SavedRepair): Promise<void> => {
    await mkdir(storageDirectory, { recursive: true, mode: 0o700 });
    const temporary = path.join(storageDirectory, `${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(saved), { mode: 0o600 });
    await rename(temporary, storageFile);
  };

  const load = async (): Promise<SavedRepair | undefined> => {
    let content: string;
    try { content = await readFile(storageFile, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const saved: unknown = JSON.parse(content);
    if (!saved || typeof saved !== "object" || !("root" in saved) || typeof saved.root !== "string" ||
        !("baseUrl" in saved) || typeof saved.baseUrl !== "string" || !("request" in saved)) throw new Error("The saved repair is invalid.");
    const request = saved.request as RepositoryRepairRequest;
    if (!request || !Array.isArray(request.files) || !Array.isArray(request.editablePaths) || !Array.isArray(request.testPaths) ||
        typeof request.requestId !== "string" || typeof request.budgetUsd !== "string" || !isValidBudgetUsd(request.budgetUsd) ||
        request.files.length > 64 || !request.files.every((file) => typeof file.path === "string" && typeof file.content === "string") ||
        !request.editablePaths.every((file) => typeof file === "string" && isRepositorySourcePath(file)) ||
        !request.testPaths.every((file) => typeof file === "string" && isRepositoryTestPath(file))) throw new Error("The saved repair snapshot is invalid.");
    const run = "run" in saved && saved.run !== undefined ? parseRepositoryRun(saved.run, request) : undefined;
    return { root: saved.root, baseUrl: normalizeBaseUrl(saved.baseUrl), request, ...(run ? { run } : {}), ...("applied" in saved && saved.applied === true ? { applied: true } : {}) };
  };

  const review = async (saved: SavedRepair): Promise<void> => {
    const run = saved.run;
    if (!run || run.status === "running") return;
    if (run.status === "failed" && !run.result) throw new Error(run.error ?? "Repository repair failed.");
    const result = run.result!;
    const verified = run.status === "completed" && result.result?.evaluation?.passed === true;
    if (run.error) deps.output.appendLine(run.error);
    const title = run.status === "failed" ? "Interrupted repair — saved changes are unverified"
      : result.status === "already_passing" ? "The selected tests already pass"
      : result.status === "baseline_failed" ? "The test setup could not run"
      : verified ? "The proposed patch passes the selected tests" : "Partial repair — tests have not passed";
    deps.output.appendLine(`${title}. Run ${saved.request.requestId}.`);
    if (result.jobId ?? run.jobId) deps.output.appendLine(`Budget ledger: ${result.jobId ?? run.jobId}. Open Governor: Browse Saved Jobs to inspect charges and held reservations.`);
    deps.output.appendLine(result.baseline.stdout);
    if (result.result) {
      deps.output.appendLine(`Spend: ${formatMicroUsd(result.result.settledMicroUsd)}. Stop: ${result.result.reason ?? result.result.status}.`);
      if (result.result.finalText) deps.output.appendLine(result.result.finalText);
    }
    if (!result.changes.length) {
      const action = await vscode.window.showInformationMessage(`${title}. No working files were changed.`, "Show Test Output");
      if (action) deps.output.show(true);
      return;
    }
    const reviewed = new Set<string>();
    while (true) {
      const choice = await vscode.window.showQuickPick([
        ...result.changes.map((change) => ({
          label: change.path,
          description: reviewed.has(change.path) ? "reviewed" : "open diff",
          file: change.path
        })),
        { label: "Apply reviewed changes", description: verified ? "Selected tests pass in isolation" : "Unverified partial changes", file: "" },
        { label: "Keep for later", description: "Reopen with Governor: Review Workspace Repair", file: "__later" }
      ], { title, placeHolder: `Review all ${result.changes.length} changed files before applying` });
      if (!choice || choice.file === "__later") return;
      if (choice.file) {
        const change = result.changes.find((entry) => entry.path === choice.file)!;
        const before = vscode.Uri.from({ scheme: SCHEME, path: `/${saved.request.requestId}/before/${change.path}` });
        const after = vscode.Uri.from({ scheme: SCHEME, path: `/${saved.request.requestId}/after/${change.path}` });
        previews.set(before.toString(), change.before);
        previews.set(after.toString(), change.after);
        await vscode.commands.executeCommand("vscode.diff", before, after, `${change.path} · Governor proposal`, { preview: true });
        reviewed.add(change.path);
        continue;
      }
      if (reviewed.size !== result.changes.length) {
        await vscode.window.showInformationMessage("Open each changed file's diff before applying the proposal.");
        continue;
      }
      const confirmation = await vscode.window.showWarningMessage(
        verified ? `Apply ${result.changes.length} reviewed source changes?` : `Apply ${result.changes.length} unverified source changes?`,
        { modal: true, detail: "Changes will open as unsaved edits. Original test and context files must still match the approved snapshot. Review and save the files yourself." },
        "Apply Changes"
      );
      if (confirmation !== "Apply Changes") continue;
      await applyRepositoryChanges(saved.root, saved.request, result.changes);
      saved.applied = true;
      await save(saved);
      await vscode.window.showInformationMessage("Repair changes are open as unsaved edits. Review and save them when ready.");
      return;
    }
  };

  const poll = async (saved: SavedRepair): Promise<void> => {
    if (saved.run?.status === "completed" || saved.run?.status === "failed") return review(saved);
    const client = new RepositoryRepairClient(new GovernorHttpClient({ baseUrl: saved.baseUrl, timeoutMs: deps.timeoutMs() }));
    await vscode.window.withProgress({
      title: "Repairing selected workspace tests — cancel stops watching; the approved run continues",
      location: vscode.ProgressLocation.Notification, cancellable: true
    }, async (_progress, token) => {
      const controller = new AbortController();
      const listener = token.onCancellationRequested(() => controller.abort());
      try {
        while (!token.isCancellationRequested) {
          let run: RepositoryRun;
          try { run = await client.get(saved.request, controller.signal); }
          catch (error) {
            if (error instanceof GovernorApiError && error.status === 404) {
              saved.run = { requestId: saved.request.requestId, status: "failed", error: "The original service has no record of this repair. No model request was retried. You may start a separate repair after checking any unresolved charges." };
              await save(saved);
            }
            throw error;
          }
          saved.run = run;
          await save(saved);
          if (run.status !== "running") return;
          await delay(1_000, undefined, { signal: controller.signal });
        }
      } catch (error) {
        if (!token.isCancellationRequested) throw error;
      } finally { listener.dispose(); }
    });
    if (saved.run?.status !== "running") await review(saved);
    else await vscode.window.showInformationMessage("The repair continues within its approved budget. Use Governor: Review Workspace Repair to reopen it.");
  };

  const run = async (): Promise<void> => {
    assertTrustedWorkspace();
    if (process.platform !== "darwin") throw new Error("Workspace repair currently requires macOS and standalone Node.js 22.8 or newer.");
    const folder = await selectFolder();
    if (!folder) return;
    if (folder.uri.scheme !== "file") throw new Error("Workspace repair requires a local folder.");
    const root = folder.uri.fsPath;
    const previous = await load();
    if (previous && (!previous.run || previous.run.status === "running")) {
      const choice = await vscode.window.showWarningMessage("A workspace repair may still be running. Review it before starting another.", "Review Saved Repair");
      if (choice) await poll(previous);
      return;
    }
    if (previous?.run?.result?.changes.length && !previous.applied) {
      const choice = await vscode.window.showWarningMessage(
        "Replace the saved workspace proposal?",
        { modal: true, detail: "The extension keeps the latest repair snapshot. Starting a new repair will replace the unapplied proposal you kept for later." },
        "Review Saved Repair", "Replace Saved Repair"
      );
      if (choice === "Review Saved Repair") { await poll(previous); return; }
      if (choice !== "Replace Saved Repair") return;
    }
    await deps.configureServer();
    const baseUrl = deps.baseUrl();
    const health = await new RepairClient({ baseUrl, timeoutMs: deps.timeoutMs() }).health();
    if (!health.providerConfigured || health.governedApi === false) throw new Error("Workspace repair needs a configured provider. Run Governor: Set OpenAI API Key first.");
    const candidates = await discoverRepositoryFiles(root);
    const tests = candidates.filter(isRepositoryTestPath);
    if (!tests.length) throw new Error("No native Node test files found. Select a package with test/*.js or *.test.ts files using node:test. npm scripts, third-party test runners, and dependency installs are not supported.");
    const testPaths = await vscode.window.showQuickPick(tests, {
      canPickMany: true, title: "Select failing node:test files",
      placeHolder: "Native Node tests only. No dependency installs, npm scripts, or network access."
    });
    if (!testPaths?.length) return;
    if (testPaths.length > 8) throw new Error("Select at most 8 test files per repair.");
    const editablePaths = await vscode.window.showQuickPick(candidates.filter(isRepositorySourcePath), {
      canPickMany: true, title: "Select source files Governor may edit", placeHolder: "Select the source and imported helpers needed by the failing tests (up to 10 files)"
    });
    if (!editablePaths?.length) return;
    if (editablePaths.length > 10) throw new Error("Select at most 10 editable source files.");
    const selected = new Set([...testPaths, ...editablePaths]);
    const contextCandidates = candidates.filter((file) => !selected.has(file));
    const contextPaths = contextCandidates.length ? await vscode.window.showQuickPick(contextCandidates.map((file) => ({ label: file, picked: file === "package.json" })), {
      canPickMany: true, title: "Select read-only context files", placeHolder: "Include package.json and imported helpers as needed. Leave empty if none are needed."
    }) : [];
    if (contextPaths === undefined) return;
    const chosenPaths = [...selected, ...contextPaths.map((item) => item.label)];
    const dirty = dirtyFiles(root, chosenPaths);
    if (dirty.length) throw new Error(`Save selected files first: ${dirty.join(", ")}.`);
    const files = await snapshotRepository(root, chosenPaths);
    const budgetUsd = await vscode.window.showInputBox({
      title: "Repair budget (USD)", value: "1.00", prompt: "Maximum total model spending for this repair. The request may stop before the test passes.",
      validateInput: (value) => isValidBudgetUsd(value) && Number(value) >= 0.05 && Number(value) <= 20 ? undefined : "Enter a USD amount from $0.05 to $20."
    });
    if (budgetUsd === undefined) return;
    const saved: SavedRepair = {
      root, baseUrl,
      request: { requestId: randomUUID(), files, editablePaths, testPaths, budgetUsd: budgetUsd.trim(), maxResponses: 16 }
    };
    const approval = await vscode.window.showWarningMessage(
      `Repair ${testPaths.length} test file${testPaths.length === 1 ? "" : "s"} with a $${budgetUsd.trim()} budget?`,
      { modal: true, detail: `The selected source, tests, and their output will be sent to your configured model provider through ${baseUrl}. Only these ${files.length} files are included:\n\n${files.map((file) => `${editablePaths.includes(file.path) ? "Edit" : "Read"}: ${file.path}`).join("\n")}\n\nTests run in an isolated copy. Working files are changed only after you review and apply the patch.` },
      "Start Repair"
    );
    if (approval !== "Start Repair") return;
    await assertSnapshotUnchanged(saved);
    await save(saved);
    const client = new RepositoryRepairClient(new GovernorHttpClient({ baseUrl, timeoutMs: deps.timeoutMs() }));
    try {
      saved.run = await client.start(saved.request);
      await save(saved);
    } catch (error) {
      deps.output.appendLine(`Repair submission ${saved.request.requestId}: ${error instanceof Error ? error.message : "unknown error"}`);
      if (error instanceof GovernorApiError && [400, 403, 404, 409, 413, 422, 503].includes(error.status)) {
        saved.run = { requestId: saved.request.requestId, status: "failed", error: error.message };
        await save(saved);
        throw error;
      }
      const choice = await vscode.window.showWarningMessage("The repair submission could not be confirmed. Its ID is saved; checking it will not start another model run.", "Check Saved Repair");
      if (choice) await poll(saved);
      return;
    }
    await poll(saved);
  };

  const wrap = (operation: () => Promise<void>): (() => Promise<void>) => async () => {
    if (busy) { await vscode.window.showInformationMessage("Finish or cancel the current repair dialog first."); return; }
    busy = true;
    try { await operation(); }
    catch (error) {
      const message = error instanceof GovernorApiError && error.status === 404
        ? "This saved run is not available on its original service. No repair was restarted and no additional model request was sent."
        : error instanceof Error ? error.message : "Workspace repair could not finish.";
      deps.output.appendLine(message);
      await vscode.window.showErrorMessage(message);
    } finally { busy = false; }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("tokenGovernor.repairWorkspace", wrap(run)),
    vscode.commands.registerCommand("tokenGovernor.reviewWorkspaceRepair", wrap(async () => {
      assertTrustedWorkspace();
      const saved = await load();
      if (!saved) { await vscode.window.showInformationMessage("No workspace repair has been saved yet."); return; }
      if (saved.baseUrl === deps.baseUrl()) await deps.configureServer();
      await poll(saved);
    }))
  );
}
