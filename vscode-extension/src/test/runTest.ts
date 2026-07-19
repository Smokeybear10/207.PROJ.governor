import * as path from "path";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  const temporary = mkdtempSync(path.join(tmpdir(), "governor-editor-test-"));
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, "../../");
    const extensionTestsPath = path.resolve(__dirname, "./suite/index");
    const portProbe = createServer();
    portProbe.listen(0, "127.0.0.1");
    await once(portProbe, "listening");
    const address = portProbe.address();
    if (address === null || typeof address === "string") {
      throw new Error("Could not reserve a local test port.");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await new Promise<void>((resolve, reject) => {
      portProbe.close((error) => error ? reject(error) : resolve());
    });
    const workspace = path.join(temporary, "workspace");
    mkdirSync(path.join(workspace, ".vscode"), { recursive: true });
    writeFileSync(path.join(workspace, ".vscode", "settings.json"), JSON.stringify({
      "tokenGovernor.apiBaseUrl": baseUrl,
      "tokenGovernor.providerMode": "fake",
      "tokenGovernor.autoStartLocalServer": true,
      "workbench.startupEditor": "none"
    }));

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      extensionTestsEnv: { GOVERNOR_TEST_API_URL: baseUrl, OPENAI_API_KEY: "" },
      launchArgs: [
        workspace,
        `--user-data-dir=${path.join(temporary, "user-data")}`,
        `--extensions-dir=${path.join(temporary, "extensions")}`,
        "--disable-workspace-trust",
        "--skip-welcome",
        "--skip-release-notes",
        "--disable-updates"
      ]
    });
  } catch (error) {
    console.error("Failed to run VS Code integration tests:", error);
    process.exitCode = 1;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

void main();
