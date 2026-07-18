import { fileURLToPath } from "node:url";

import type { RepairFixture } from "./types.js";

/**
 * Registry of self-contained broken-repo fixtures. Each `rootDir` is an
 * absolute path resolved from this module's URL so the sandbox can copy it
 * regardless of the process working directory.
 */
export const REPAIR_FIXTURES: readonly RepairFixture[] = [
  {
    id: "broken-sum",
    rootDir: fileURLToPath(new URL("./fixtures/broken-sum", import.meta.url)),
    allowlistedPaths: ["src/calculator.mjs"],
    protectedPaths: ["test/calculator.test.mjs"],
    testCommand: ["node", "--test"],
    maxEditFiles: 1
  }
];

export function getRepairFixture(id: string): RepairFixture {
  const fixture = REPAIR_FIXTURES.find((candidate) => candidate.id === id);
  if (!fixture) {
    throw new Error(`Unknown repair fixture: ${id}`);
  }
  return fixture;
}
