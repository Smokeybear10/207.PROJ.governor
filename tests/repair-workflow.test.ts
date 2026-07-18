import { afterEach, describe, expect, it } from "vitest";
import {
  GPT_5_NANO_STANDARD_RATE_CARD,
  ReservationLedger,
  type GovernorPolicy
} from "../server/governor/index.js";
import { ScriptedResponsesProvider } from "../server/openai/scripted-provider.js";
import {
  createRepairSandbox,
  getRepairFixture,
  runGovernedRepair,
  type RepairSandbox
} from "../server/repair/index.js";
import { brokenSumRepairScripts } from "../server/repair/demo-script.js";

const POLICY: GovernorPolicy = {
  applicationCeilingMicroUsd: 2_000_000,
  finalAnswerReserveMicroUsd: 100_000,
  finalAnswerInputTokenLimit: 5_000,
  minimumFinalOutputTokens: 100,
  maxResponses: 6,
  maxEquivalentRetries: 1,
  rateCardVersion: GPT_5_NANO_STANDARD_RATE_CARD.version
};

let activeSandbox: RepairSandbox | null = null;

afterEach(async () => {
  if (activeSandbox) {
    await activeSandbox.dispose();
    activeSandbox = null;
  }
});

describe("governed CI-repair workflow", () => {
  it("repairs the broken-sum fixture under budget governance", async () => {
    const ledger = new ReservationLedger(POLICY, GPT_5_NANO_STANDARD_RATE_CARD);
    const provider = new ScriptedResponsesProvider(brokenSumRepairScripts());
    const fixture = getRepairFixture("broken-sum");
    const sandbox = await createRepairSandbox(fixture);
    activeSandbox = sandbox;

    // The build starts broken.
    const before = await sandbox.runTests();
    expect(before.exitCode).not.toBe(0);

    const result = await runGovernedRepair({
      jobId: "repair-test",
      ledger,
      rateCard: GPT_5_NANO_STANDARD_RATE_CARD,
      provider,
      sandbox,
      fixture,
      model: GPT_5_NANO_STANDARD_RATE_CARD.model
    });

    expect(result.status).toBe("repaired");
    if (result.status === "repaired") {
      expect(result.evaluation.passed).toBe(true);
      expect(result.evaluation.exitCode).toBe(0);
      expect(result.finalText.length).toBeGreaterThan(0);
    }
    provider.assertComplete();

    // Governed spend stayed strictly inside the ceiling and was actually charged.
    const snapshot = ledger.getSnapshot();
    expect(snapshot.settledMicroUsd).toBeGreaterThan(0);
    expect(snapshot.settledMicroUsd).toBeLessThanOrEqual(
      POLICY.applicationCeilingMicroUsd
    );
    expect(snapshot.completionAccepted).toBe(true);

    // The fix is real: the patched source now passes tests.
    const after = await sandbox.runTests();
    expect(after.exitCode).toBe(0);
    expect(sandbox.editedPaths()).toContain("src/calculator.mjs");
  });

  it("stops cleanly and does not report a repair when the budget is exhausted", async () => {
    const tightPolicy: GovernorPolicy = {
      ...POLICY,
      // Reserve consumes almost the whole ceiling, leaving too little work
      // budget to admit even a minimum-length work response -> first turn denied.
      applicationCeilingMicroUsd: 1_050,
      finalAnswerReserveMicroUsd: 1_000,
      finalAnswerInputTokenLimit: 1_000,
      minimumFinalOutputTokens: 100
    };
    const ledger = new ReservationLedger(
      tightPolicy,
      GPT_5_NANO_STANDARD_RATE_CARD
    );
    const provider = new ScriptedResponsesProvider(brokenSumRepairScripts());
    const fixture = getRepairFixture("broken-sum");
    const sandbox = await createRepairSandbox(fixture);
    activeSandbox = sandbox;

    const result = await runGovernedRepair({
      jobId: "repair-budget",
      ledger,
      rateCard: GPT_5_NANO_STANDARD_RATE_CARD,
      provider,
      sandbox,
      fixture,
      model: GPT_5_NANO_STANDARD_RATE_CARD.model
    });

    expect(result.status).toBe("not_repaired");
    const snapshot = ledger.getSnapshot();
    expect(snapshot.settledMicroUsd).toBeLessThanOrEqual(
      tightPolicy.applicationCeilingMicroUsd
    );
  });
});
