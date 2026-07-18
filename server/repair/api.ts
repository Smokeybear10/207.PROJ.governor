import { MemoryArtifactStore } from "../artifacts/index.js";
import {
  GPT_5_4_MINI_STANDARD_RATE_CARD,
  type GovernorPolicy
} from "../governor/index.js";
import { GovernedJobService } from "../jobs/index.js";
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

/** Job-policy knobs for the demo repair run (priced against the pinned card). */
const DEMO_BUDGET_USD = "2.00";
const DEMO_MAX_RESPONSES = 6;
const DEMO_FINAL_INPUT_TOKEN_LIMIT = 5_000;
const DEMO_MINIMUM_FINAL_OUTPUT_TOKENS = 100;

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
  readonly signal?: AbortSignal;
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
  const scripted =
    mode === "live" ? undefined : scriptedProviderFor(fixtureId);
  const provider = createResponsesProvider({ mode, scripted });
  const service = new GovernedJobService({ provider });
  const sandbox = await createRepairSandbox(fixture);
  const jobId = `repair-${fixtureId}-${Date.now()}`;

  try {
    const result = await runGovernedRepair({
      service,
      sandbox,
      fixture,
      artifactStore: new MemoryArtifactStore(),
      jobId,
      budgetUsd: DEMO_BUDGET_USD,
      maxResponses: DEMO_MAX_RESPONSES,
      finalInputTokenLimit: DEMO_FINAL_INPUT_TOKEN_LIMIT,
      minimumFinalOutputTokens: DEMO_MINIMUM_FINAL_OUTPUT_TOKENS,
      signal: options.signal
    });
    const policy: GovernorPolicy = {
      applicationCeilingMicroUsd: result.accounting.applicationCeilingMicroUsd,
      finalAnswerReserveMicroUsd: result.accounting.finalAnswerReserveMicroUsd,
      finalAnswerInputTokenLimit: result.accounting.finalAnswerInputTokenLimit,
      minimumFinalOutputTokens: result.accounting.minimumFinalOutputTokens,
      maxResponses: result.accounting.maxResponses,
      maxEquivalentRetries: 0,
      rateCardVersion: GPT_5_4_MINI_STANDARD_RATE_CARD.version
    };
    return {
      fixtureId,
      mode,
      model: GPT_5_4_MINI_STANDARD_RATE_CARD.model,
      rateCardVersion: GPT_5_4_MINI_STANDARD_RATE_CARD.version,
      policy,
      result
    };
  } finally {
    await sandbox.dispose();
  }
}
