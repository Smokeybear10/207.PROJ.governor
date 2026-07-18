import { defineConfig } from "vitest/config";

// Unit tests (plain Node) live in *.spec.ts and must NOT import "vscode".
// VS Code integration tests live under src/test/** and run via
// @vscode/test-electron (npm run test:vscode), not vitest.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.spec.ts"],
    passWithNoTests: true
  }
});
