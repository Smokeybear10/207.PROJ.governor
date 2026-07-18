import { MemoryArtifactStore } from "../artifacts/index.js";
import {
  GPT_5_NANO_STANDARD_RATE_CARD,
  ReservationLedger,
  type GovernorPolicy
} from "../governor/index.js";
import {
  createResponsesProvider,
  resolveProviderMode,
  type ProviderMode
} from "../openai/provider-factory.js";
import { ScriptedResponsesProvider } from "../openai/scripted-provider.js";
import { brokenSumRepairScripts } from "./demo-script.js";
import { getRepairFixture } from "./fixtures.js";
import { createRepairSandbox } from "./sandbox.js";
import {
  runGovernedRepair,
  type GovernedRepairResult
} from "./workflow.js";

const DEMO_POLICY: GovernorPolicy = {
  applicationCeilingMicroUsd: 2_000_000,
  finalAnswerReserveMicroUsd: 100_000,
  finalAnswerInputTokenLimit: 5_000,
  minimumFinalOutputTokens: 100,
  maxResponses: 6,
  maxEquivalentRetries: 1,
  rateCardVersion: GPT_5_NANO_STANDARD_RATE_CARD.version
};

/** Deterministic scripted agent per fixture (used in fake/hybrid modes). */
function scriptedProviderFor(fixtureId: string): ScriptedResponsesProvider {
  switch (fixtureId) {
    case "broken-sum":
      return new ScriptedResponsesProvider(brokenSumRepairScripts());
    default:
      throw new Error(`No scripted agent is registered for fixture "${fixtureId}".`);
  }
}

export interface RepairRunOptions {
  readonly fixtureId?: string;
  readonly mode?: ProviderMode;
}

export interface RepairRunResponse {
  readonly fixtureId: string;
  readonly mode: ProviderMode;
  readonly model: string;
  readonly rateCardVersion: string;
  readonly policy: GovernorPolicy;
  readonly result: GovernedRepairResult;
}

export async function runRepairDemo(
  options: RepairRunOptions = {}
): Promise<RepairRunResponse> {
  const fixtureId = options.fixtureId ?? "broken-sum";
  const mode =
    options.mode ?? resolveProviderMode(process.env.GOVERNOR_PROVIDER_MODE);
  const fixture = getRepairFixture(fixtureId);
  const rateCard = GPT_5_NANO_STANDARD_RATE_CARD;
  const ledger = new ReservationLedger(DEMO_POLICY, rateCard);
  const scripted =
    mode === "live" ? undefined : scriptedProviderFor(fixtureId);
  const provider = createResponsesProvider({ mode, scripted });
  const sandbox = await createRepairSandbox(fixture);
  const jobId = `repair-${fixtureId}-${Date.now()}`;

  try {
    const result = await runGovernedRepair({
      jobId,
      ledger,
      rateCard,
      provider,
      sandbox,
      fixture,
      artifactStore: new MemoryArtifactStore(),
      model: rateCard.model
    });
    return {
      fixtureId,
      mode,
      model: rateCard.model,
      rateCardVersion: rateCard.version,
      policy: DEMO_POLICY,
      result
    };
  } finally {
    await sandbox.dispose();
  }
}
