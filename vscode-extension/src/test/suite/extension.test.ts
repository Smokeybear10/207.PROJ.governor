import * as assert from "assert";
import * as vscode from "vscode";

const EXTENSION_ID = "governor.token-governor-vscode";

// Commands registered in src/extension.ts, plus tokenGovernor.runRepair
// which is added concurrently by another agent.
const EXPECTED_COMMANDS = [
  "tokenGovernor.healthCheck",
  "tokenGovernor.createJob",
  "tokenGovernor.setActiveJob",
  "tokenGovernor.openJobPanel",
  "tokenGovernor.submitSelection",
  "tokenGovernor.finalize",
  "tokenGovernor.runRepair"
];

suite("TokenGovernor extension", () => {
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
});
