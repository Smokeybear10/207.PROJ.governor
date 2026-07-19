import * as assert from "assert";
import * as http from "http";
import { setTimeout as delay } from "node:timers/promises";
import * as vscode from "vscode";

const EXTENSION_ID = "governor.token-governor-vscode";

const EXPECTED_COMMANDS = [
  "tokenGovernor.healthCheck",
  "tokenGovernor.refresh",
  "tokenGovernor.createJob",
  "tokenGovernor.setActiveJob",
  "tokenGovernor.viewResponses",
  "tokenGovernor.exportReport",
  "tokenGovernor.openJobPanel",
  "tokenGovernor.submitSelection",
  "tokenGovernor.sendPrompt",
  "tokenGovernor.finalize",
  "tokenGovernor.runRepair",
  "tokenGovernor.repairWorkspace",
  "tokenGovernor.reviewWorkspaceRepair",
  "tokenGovernor.setOpenAiApiKey",
  "tokenGovernor.clearOpenAiApiKey"
];

async function localRequest(requestPath: string): Promise<Record<string, unknown>> {
  const baseUrl = process.env.GOVERNOR_TEST_API_URL;
  assert.ok(baseUrl, "integration tests require an isolated service URL");
  return new Promise((resolve, reject) => {
    const request = http.get(
      `${baseUrl}${requestPath}`,
      { timeout: 5_000 },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          try {
            assert.strictEqual(response.statusCode, 200);
            resolve(
              JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
                string,
                unknown
              >
            );
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    request.on("timeout", () => request.destroy(new Error("health timeout")));
    request.on("error", reject);
  });
}

const localHealth = (): Promise<Record<string, unknown>> => localRequest("/api/health");

async function chooseFirstItem(command: string): Promise<void> {
  let finished = false;
  let failure: unknown;
  const operation = vscode.commands.executeCommand(command).then(
    () => { finished = true; },
    (error: unknown) => { failure = error; finished = true; }
  );
  for (let attempt = 0; !finished && attempt < 100; attempt += 1) {
    await delay(100);
    if (!finished) await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
  }
  if (!finished) {
    await vscode.commands.executeCommand("workbench.action.closeQuickOpen");
    assert.fail(`${command} did not complete after choosing its first item`);
  }
  await operation;
  if (failure !== undefined) throw failure;
}

suite("Governor extension", () => {
  test("is present and activates", async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `extension ${EXTENSION_ID} should be installed`);

    // Activation may already have occurred; activate() is idempotent.
    if (!extension.isActive) {
      await extension.activate();
    }
    assert.ok(extension.isActive, "extension should be active after activate()");
  });

  test("registers its core commands", async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `extension ${EXTENSION_ID} should be installed`);
    if (!extension.isActive) {
      await extension.activate();
    }

    const commands = await vscode.commands.getCommands(true);
    for (const command of EXPECTED_COMMANDS) {
      assert.ok(
        commands.includes(command),
        `expected command ${command} to be registered`
      );
    }
  });

  test("contributes native view actions and integer settings", () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `extension ${EXTENSION_ID} should be installed`);

    const manifest = extension.packageJSON as {
      contributes?: {
        commands?: Array<{ command?: string; icon?: string }>;
        menus?: {
          "view/title"?: Array<{ command?: string; when?: string }>;
        };
        configuration?: {
          properties?: Record<string, { type?: string }>;
        };
      };
    };
    const commands = manifest.contributes?.commands ?? [];
    const titleActions = manifest.contributes?.menus?.["view/title"] ?? [];
    const settings = manifest.contributes?.configuration?.properties ?? {};

    assert.ok(
      commands.some(
        (command) =>
          command.command === "tokenGovernor.refresh" &&
          command.icon === "$(refresh)"
      ),
      "refresh should use the native refresh icon"
    );
    assert.deepStrictEqual(
      titleActions.map((action) => action.command),
      [
        "tokenGovernor.refresh",
        "tokenGovernor.createJob",
        "tokenGovernor.setOpenAiApiKey"
      ]
    );
    assert.ok(
      titleActions.every(
        (action) => action.when === "view == tokenGovernor.jobView"
      )
    );
    assert.strictEqual(
      settings["tokenGovernor.requestTimeoutMs"]?.type,
      "integer"
    );
    assert.strictEqual(
      settings["tokenGovernor.pollIntervalMs"]?.type,
      "integer"
    );
  });

  test("starts its packaged local Governor service", async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `extension ${EXTENSION_ID} should be installed`);
    if (!extension.isActive) {
      await extension.activate();
    }

    const health = await localHealth();
    assert.strictEqual(health.service, "token-governor");
    assert.strictEqual(health.status, "ready");
    assert.strictEqual(health.governedApi, true);
  });

  test("keeps sample repair scripted even when a paid provider mode is configured", async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `extension ${EXTENSION_ID} should be installed`);
    if (!extension.isActive) {
      await extension.activate();
    }

    const config = vscode.workspace.getConfiguration("tokenGovernor");
    const previousMode = config.get<string>("providerMode");
    const before = await localRequest("/v1/jobs");
    assert.ok(Array.isArray(before.data));
    const previousIds = new Set(before.data.map((job: { id: string }) => job.id));
    try {
      for (const mode of ["live", "hybrid"]) {
        await config.update("providerMode", mode, vscode.ConfigurationTarget.Workspace);
        await vscode.commands.executeCommand("tokenGovernor.runRepair");
      }
      const after = await localRequest("/v1/jobs");
      assert.ok(Array.isArray(after.data));
      const samples = after.data.filter((job: { id: string }) => !previousIds.has(job.id));
      assert.strictEqual(samples.length, 2, "both sample runs should complete without a provider key");
      assert.ok(samples.every((job: { status: string }) => job.status === "completed"));
      const health = await localHealth();
      assert.strictEqual(health.status, "ready");
      assert.strictEqual(health.providerConfigured, false);
    } finally {
      await config.update("providerMode", previousMode, vscode.ConfigurationTarget.Workspace);
    }
  });

  test("browses a persisted repair job and opens its receipt without another model request", async () => {
    const listing = await localRequest("/v1/jobs");
    assert.strictEqual(listing.object, "list");
    assert.ok(Array.isArray(listing.data) && listing.data.length > 0);
    const summary = listing.data[0] as { id: string };
    const before = await localRequest(`/v1/jobs/${encodeURIComponent(summary.id)}`);
    assert.strictEqual(before.status, "completed");
    assert.ok(Array.isArray(before.requests) && before.requests.length > 0);
    const latest = before.requests.at(-1) as { request_id: string };

    await chooseFirstItem("tokenGovernor.setActiveJob");
    await chooseFirstItem("tokenGovernor.viewResponses");

    const document = vscode.window.activeTextEditor?.document;
    assert.ok(document, "the saved response should open in an editor");
    assert.strictEqual(document.languageId, "markdown");
    const text = document.getText().replaceAll("\\_", "_");
    assert.ok(text.includes(summary.id));
    assert.ok(text.includes(latest.request_id));
    assert.ok(!document.getText().includes("## Prompt"), "saved receipts do not contain the original prompt");
    assert.deepStrictEqual(await localRequest(`/v1/jobs/${encodeURIComponent(summary.id)}`), before);
    assert.strictEqual((await localHealth()).providerConfigured, false);
  });

  test("exports a complete accounting snapshot from the packaged service without a key", async () => {
    const listing = await localRequest("/v1/jobs");
    assert.ok(Array.isArray(listing.data) && listing.data.length > 0);
    const { id } = listing.data[0] as { id: string };
    const jobPath = `/v1/jobs/${encodeURIComponent(id)}`;
    const before = await localRequest(jobPath);
    const report = await localRequest(`${jobPath}/report`);
    assert.strictEqual(report.object, "token_governor.report");
    assert.strictEqual(report.schema_version, 1);
    assert.strictEqual(report.content_included, false);
    assert.deepStrictEqual(report.job, before);
    assert.ok(Array.isArray(report.requests) && report.requests.length > 0);
    for (const request of report.requests as Record<string, unknown>[]) {
      assert.ok(!("output" in request));
      assert.ok(!("input" in request));
      assert.match(String(request.request_fingerprint), /^[a-f0-9]{64}$/);
    }
    assert.deepStrictEqual(await localRequest(jobPath), before);
    assert.strictEqual((await localHealth()).providerConfigured, false);
  });
});
