import * as assert from "assert";
import * as http from "http";
import * as vscode from "vscode";

const EXTENSION_ID = "governor.token-governor-vscode";

const EXPECTED_COMMANDS = [
  "tokenGovernor.healthCheck",
  "tokenGovernor.refresh",
  "tokenGovernor.createJob",
  "tokenGovernor.setActiveJob",
  "tokenGovernor.openJobPanel",
  "tokenGovernor.submitSelection",
  "tokenGovernor.sendPrompt",
  "tokenGovernor.finalize",
  "tokenGovernor.runRepair",
  "tokenGovernor.setOpenAiApiKey",
  "tokenGovernor.clearOpenAiApiKey"
];

async function localHealth(): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      "http://127.0.0.1:8787/api/health",
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

  test("runs the deterministic repair command end to end", async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `extension ${EXTENSION_ID} should be installed`);
    if (!extension.isActive) {
      await extension.activate();
    }

    await vscode.commands.executeCommand("tokenGovernor.runRepair");

    const health = await localHealth();
    assert.strictEqual(health.status, "ready");
    assert.strictEqual(health.providerConfigured, false);
  });
});
