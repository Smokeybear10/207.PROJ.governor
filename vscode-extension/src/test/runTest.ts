import * as path from "path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  try {
    // Compiled layout: out/test/runTest.js -> package root is two levels up.
    const extensionDevelopmentPath = path.resolve(__dirname, "../../");
    // Compiled Mocha entry point: out/test/suite/index.js
    const extensionTestsPath = path.resolve(__dirname, "./suite/index");

    await runTests({ extensionDevelopmentPath, extensionTestsPath });
  } catch (error) {
    console.error("Failed to run VS Code integration tests:", error);
    process.exit(1);
  }
}

void main();
