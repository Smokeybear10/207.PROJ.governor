import { afterEach, describe, expect, it } from "vitest";
import { GovernedJobService } from "../server/jobs/index.js";
import { ScriptedResponsesProvider } from "../server/openai/scripted-provider.js";
import {
  createRepairSandbox,
  getRepairFixture,
  runGovernedRepair,
  type RepairSandbox
} from "../server/repair/index.js";
import { brokenSumRepairScripts } from "../server/repair/demo-script.js";

let activeSandbox: RepairSandbox | null = null;

afterEach(async () => {
  if (activeSandbox) {
    await activeSandbox.dispose();
    activeSandbox = null;
  }
});

describe("governed CI-repair workflow", () => {
  it("repairs the broken-sum fixture under budget governance", async () => {
    const provider = new ScriptedResponsesProvider(brokenSumRepairScripts());
    const service = new GovernedJobService({ provider });
    const fixture = getRepairFixture("broken-sum");
    const sandbox = await createRepairSandbox(fixture);
    activeSandbox = sandbox;

    // The build starts broken.
    const before = await sandbox.runTests();
    expect(before.exitCode).not.toBe(0);

    const result = await runGovernedRepair({
      service,
      jobId: "broken-sum",
      sandbox,
      fixture,
      budgetUsd: "1.00",
      maxResponses: 6,
      finalInputTokenLimit: 4_096,
      minimumFinalOutputTokens: 100
    });

    expect(result.status).toBe("repaired");
    if (result.status === "repaired") {
      expect(result.evaluation.passed).toBe(true);
      expect(result.evaluation.exitCode).toBe(0);
      expect(result.finalText.length).toBeGreaterThan(0);
      // Governed spend was actually charged and stayed inside the ceiling.
      expect(result.settledMicroUsd).toBeGreaterThan(0);
      expect(result.settledMicroUsd).toBeLessThanOrEqual(
        result.accounting.applicationCeilingMicroUsd
      );
    }
    provider.assertComplete();

    // The fix is real: the patched source now passes tests.
    const after = await sandbox.runTests();
    expect(after.exitCode).toBe(0);
    expect(sandbox.editedPaths()).toContain("src/calculator.mjs");
  });

  it("stops cleanly and does not report a repair when the budget is exhausted", async () => {
    const provider = new ScriptedResponsesProvider(brokenSumRepairScripts());
    const service = new GovernedJobService({ provider });
    const fixture = getRepairFixture("broken-sum");
    const sandbox = await createRepairSandbox(fixture);
    activeSandbox = sandbox;

    // A tiny work budget: the final reserve consumes almost the whole ceiling,
    // leaving too little to admit even the first work response -> GOVERNOR_DENIED.
    const result = await runGovernedRepair({
      service,
      sandbox,
      fixture,
      budgetUsd: "0.0001",
      maxResponses: 6,
      finalInputTokenLimit: 100,
      minimumFinalOutputTokens: 1
    });

    expect(result.status).toBe("not_repaired");
    if (result.status === "not_repaired") {
      expect(result.reason).toBe("WORK_DENIED");
      expect(result.settledMicroUsd).toBeLessThanOrEqual(
        result.accounting.applicationCeilingMicroUsd
      );
    }
  });
});
