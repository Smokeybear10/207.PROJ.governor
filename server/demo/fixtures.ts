import {
  type DemoArtifact,
  type DemoController,
  type DemoProvenance,
  type DemoRateCard,
  type DemoScenario,
  type EventRiskSnapshot,
  type InterventionAction,
  type QualityResult,
  type RunEventType,
  type RunStatus,
  DEMO_RATE_CARD_VERSION
} from "./types.js";
import {
  GPT_5_4_MINI_STANDARD_RATE_CARD,
  type JsonValue
} from "../governor/index.js";

export const DEMO_PROVENANCE: DemoProvenance = {
  origin: "SYNTHETIC_DETERMINISTIC_FIXTURE",
  governorCore: "GOVERNOR_CORE_ENFORCED",
  externalApiCalls: 0,
  usageSource: "SIMULATED",
  costBasis: "SIMULATED_LIST_PRICE_MICRO_USD"
};

const CORE_RATES = GPT_5_4_MINI_STANDARD_RATE_CARD.rates;

export const DEMO_RATE_CARD: DemoRateCard = {
  version: DEMO_RATE_CARD_VERSION,
  provider: GPT_5_4_MINI_STANDARD_RATE_CARD.provider as "openai",
  model: GPT_5_4_MINI_STANDARD_RATE_CARD.model as "gpt-5.4-mini",
  serviceTier:
    GPT_5_4_MINI_STANDARD_RATE_CARD.serviceTier as "standard",
  processingRegion:
    GPT_5_4_MINI_STANDARD_RATE_CARD.processingRegion as "global",
  currency: "USD",
  unit: "USD_PER_MILLION_TOKENS",
  uncachedInputUsdPerMillionTokens:
    CORE_RATES.uncachedInputMicroUsdPerMillionTokens / 1_000_000,
  cachedInputUsdPerMillionTokens:
    CORE_RATES.cachedInputMicroUsdPerMillionTokens / 1_000_000,
  outputUsdPerMillionTokens:
    CORE_RATES.outputMicroUsdPerMillionTokens / 1_000_000,
  uncachedInputMicroUsdPerMillionTokens:
    CORE_RATES.uncachedInputMicroUsdPerMillionTokens,
  cachedInputMicroUsdPerMillionTokens:
    CORE_RATES.cachedInputMicroUsdPerMillionTokens,
  outputMicroUsdPerMillionTokens:
    CORE_RATES.outputMicroUsdPerMillionTokens,
  rounding: "CEIL_EACH_AGGREGATE_CHARGE",
  source: "PINNED_STANDARD_PRICING_FOR_DEMO",
  disclosure:
    "Rates supplied for deterministic demo calculations; all usage and receipts are synthetic."
};

export const DEMO_SCENARIOS: readonly DemoScenario[] = [
  {
    id: "large-failing-log",
    title: "Large failing test log",
    summary:
      "A retry regression produces a 14.6K-token test log that would crowd out the final review.",
    spotlight: true,
    repository: "token-governor/pr-review-fixtures",
    pullRequestNumber: 1847,
    changedFiles: 7,
    changedLines: 428,
    initialContextTokens: 18_200,
    expectedOutcome: "FINDINGS",
    taskPolicy: {
      id: "routine-pr-review-v1",
      name: "Routine PR Review",
      applicationCeilingMicroUsd: 75_000,
      protectedFinalReserveMicroUsd: 25_000,
      finalAnswerInputTokenLimit: 23_800,
      minimumFinalOutputTokens: 1_440,
      maxResponses: 3,
      maxEquivalentRetries: 0,
      rateCardVersion: DEMO_RATE_CARD_VERSION
    },
    signals: [
      "One critical authorization-context regression",
      "14,600-token failing test log",
      "Unchanged test retry requested after the failure"
    ]
  },
  {
    id: "clean-small-diff",
    title: "Clean small diff",
    summary:
      "A focused validation cleanup passes tests and should produce a finding-free review.",
    spotlight: false,
    repository: "token-governor/pr-review-fixtures",
    pullRequestNumber: 1851,
    changedFiles: 2,
    changedLines: 36,
    initialContextTokens: 4_200,
    expectedOutcome: "CLEAN",
    taskPolicy: {
      id: "routine-pr-review-v1",
      name: "Routine PR Review",
      applicationCeilingMicroUsd: 35_000,
      protectedFinalReserveMicroUsd: 8_000,
      finalAnswerInputTokenLimit: 5_320,
      minimumFinalOutputTokens: 700,
      maxResponses: 2,
      maxEquivalentRetries: 1,
      rateCardVersion: DEMO_RATE_CARD_VERSION
    },
    signals: [
      "Small TypeScript-only change",
      "Passing focused test suite",
      "No seeded issue in the sealed fixture"
    ]
  },
  {
    id: "repeated-unchanged-retry",
    title: "Repeated unchanged retry",
    summary:
      "An unchanged failing command returns the same output twice and invites an unproductive third attempt.",
    spotlight: false,
    repository: "token-governor/pr-review-fixtures",
    pullRequestNumber: 1856,
    changedFiles: 4,
    changedLines: 176,
    initialContextTokens: 9_600,
    expectedOutcome: "FINDINGS",
    taskPolicy: {
      id: "routine-pr-review-v1",
      name: "Routine PR Review",
      applicationCeilingMicroUsd: 65_000,
      protectedFinalReserveMicroUsd: 21_000,
      finalAnswerInputTokenLimit: 19_000,
      minimumFinalOutputTokens: 1_300,
      maxResponses: 3,
      maxEquivalentRetries: 1,
      rateCardVersion: DEMO_RATE_CARD_VERSION
    },
    signals: [
      "One seeded retry-boundary defect",
      "Stable repository state between test commands",
      "Byte-identical failing output on the second command"
    ]
  }
];

export interface UsageSeed {
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
}

export interface MetricsSeed {
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly contextTokens: number;
}

export interface RequestSeed {
  readonly phase: "work" | "final";
  readonly exactInputTokens: number;
  readonly requestedMaxOutputTokens: number;
  readonly minimumUsefulOutputTokens: number;
}

export interface RetryAttemptSeed {
  readonly toolName: string;
  readonly arguments: JsonValue;
  readonly errorClass: string;
  readonly stateRevision: string;
}

export type ActionSeed = Omit<InterventionAction, "id">;

export interface EventSeed {
  readonly offsetMs: number;
  readonly type: RunEventType;
  readonly title: string;
  readonly detail: string;
  readonly metrics: MetricsSeed;
  readonly risk: EventRiskSnapshot;
  readonly request?: RequestSeed;
  readonly retryAttempt?: RetryAttemptSeed;
  readonly failedToolCall?: boolean;
  readonly minimumCompletionCostMicroUsd?: number;
  readonly action?: ActionSeed;
  readonly receiptUsage?: UsageSeed;
}

export interface RunBlueprint {
  readonly status: RunStatus;
  readonly quality: QualityResult;
  readonly events: readonly EventSeed[];
  readonly headline: string;
  readonly detail: string;
}

const LARGE_LOG_ARTIFACT: DemoArtifact = {
  id: "demo-artifact:large-failing-log:test-log:v1",
  kind: "REDUCED_TEST_LOG",
  mediaType: "text/plain",
  checksumSha256:
    "a06af2aa4cd978e3731dca89a69403c19ec189bfae75ea0258dea88c4dfb03d1",
  originalTokens: 14_600,
  retainedTokens: 1_960,
  retainedEvidence: [
    "Exit code 1",
    "Failing test: preserves authorization context across retry",
    "AssertionError at retry-context.test.ts:118",
    "Truncation disclosure and synthetic artifact checksum"
  ]
};

const RETRY_LOG_ARTIFACT: DemoArtifact = {
  id: "demo-artifact:repeated-unchanged-retry:test-log:v1",
  kind: "REDUCED_TEST_LOG",
  mediaType: "text/plain",
  checksumSha256:
    "bb1195fd9f4a8df33132a29c3d4fd9916509f87390f9e37419584496c444856e",
  originalTokens: 6_800,
  retainedTokens: 280,
  retainedEvidence: [
    "Exit code 1",
    "Failing test: stops after configured retry count",
    "Output checksum matches the prior observation"
  ]
};

const LARGE_PASS: QualityResult = {
  gate: "PASSED",
  score: 100,
  structuredOutputValid: true,
  seededIssuesExpected: 2,
  seededIssuesFound: 2,
  criticalIssuesExpected: 1,
  criticalIssuesFound: 1,
  criticalFalsePositives: 0,
  summary:
    "The synthetic structured review found both seeded issues, including the critical regression."
};

const LARGE_HARD_CAP_FAIL: QualityResult = {
  gate: "FAILED",
  score: 20,
  structuredOutputValid: false,
  seededIssuesExpected: 2,
  seededIssuesFound: 0,
  criticalIssuesExpected: 1,
  criticalIssuesFound: 0,
  criticalFalsePositives: 0,
  summary:
    "The run stopped before a valid final review and missed the critical seeded issue."
};

const CLEAN_PASS: QualityResult = {
  gate: "PASSED",
  score: 100,
  structuredOutputValid: true,
  seededIssuesExpected: 0,
  seededIssuesFound: 0,
  criticalIssuesExpected: 0,
  criticalIssuesFound: 0,
  criticalFalsePositives: 0,
  summary:
    "The synthetic structured review correctly returned no findings for the clean fixture."
};

const RETRY_PASS: QualityResult = {
  gate: "PASSED",
  score: 100,
  structuredOutputValid: true,
  seededIssuesExpected: 1,
  seededIssuesFound: 1,
  criticalIssuesExpected: 0,
  criticalIssuesFound: 0,
  criticalFalsePositives: 0,
  summary:
    "The synthetic structured review found the retry-boundary defect with no false positive."
};

const RETRY_HARD_CAP_FAIL: QualityResult = {
  gate: "FAILED",
  score: 40,
  structuredOutputValid: false,
  seededIssuesExpected: 1,
  seededIssuesFound: 0,
  criticalIssuesExpected: 0,
  criticalIssuesFound: 0,
  criticalFalsePositives: 0,
  summary:
    "The run spent its useful continuation capacity on repeated output and did not seal a review."
};

function metrics(
  uncachedInputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
  contextTokens: number
): MetricsSeed {
  return {
    uncachedInputTokens,
    cachedInputTokens,
    outputTokens,
    contextTokens
  };
}

function risk(
  controller: DemoController,
  band: EventRiskSnapshot["band"],
  observedDrivers: EventRiskSnapshot["observedDrivers"]
): EventRiskSnapshot {
  if (controller === "shadow") {
    return {
      band,
      engine: "GOVERNOR_CORE",
      mode: "SHADOW",
      source: "SHADOW_FORECAST",
      observedDrivers
    };
  }

  return {
    band,
    engine: "GOVERNOR_CORE",
    mode: "ENFORCED",
    source:
      controller === "static" ? "STATIC_RULES" : "DETERMINISTIC_BOUND",
    observedDrivers
  };
}

function driver(
  id: string,
  direction: "INCREASES_RISK" | "DECREASES_RISK",
  label: string,
  evidence: string
) {
  return { id, direction, label, evidence } as const;
}

const LARGE_BASELINE = [
  driver(
    "initial-policy-fit",
    "DECREASES_RISK",
    "Initial request fits",
    "The 18,200-token opening context and protected reserve fit under the 75,000 micro-USD ceiling."
  )
];

const LARGE_LOG_DRIVERS = [
  driver(
    "large-test-log",
    "INCREASES_RISK",
    "Large failing test log",
    "The local test result contains 14,600 tokens before deterministic reduction."
  ),
  driver(
    "context-growth",
    "INCREASES_RISK",
    "Context grew quickly",
    "The next context would grow from 19,600 to 34,200 tokens."
  )
];

const LARGE_AT_RISK_DRIVERS = [
  ...LARGE_LOG_DRIVERS,
  driver(
    "next-request-bound",
    "INCREASES_RISK",
    "Unreduced continuation does not fit",
    "The conservative next-request bound plus 25,000 micro-USD final reserve exceeds the policy ceiling."
  )
];

const LARGE_REDUCED_DRIVERS = [
  driver(
    "artifact-reduction",
    "DECREASES_RISK",
    "Failure evidence retained",
    "The context keeps 1,960 evidence tokens and stores the complete synthetic fixture log by checksum."
  ),
  driver(
    "completion-reserve",
    "DECREASES_RISK",
    "Completion budget remains protected",
    "The reduced next request fits while retaining the 25,000 micro-USD final reserve."
  )
];

const CLEAN_DRIVERS = [
  driver(
    "small-diff",
    "DECREASES_RISK",
    "Small stable context",
    "The fixture changes 36 lines across two files and focused tests pass."
  )
];

const RETRY_BASELINE = [
  driver(
    "retry-policy-fit",
    "DECREASES_RISK",
    "Opening request fits",
    "The initial context fits with a 21,000 micro-USD final reserve."
  )
];

const RETRY_WATCH_DRIVERS = [
  driver(
    "first-test-failure",
    "INCREASES_RISK",
    "Test command failed",
    "The retry-boundary test failed and added 6,800 tokens of local output."
  )
];

const RETRY_AT_RISK_DRIVERS = [
  driver(
    "unchanged-output",
    "INCREASES_RISK",
    "Output is unchanged",
    "The repeated command used the same arguments and returned the same fixture checksum."
  ),
  driver(
    "equivalent-retry-limit",
    "INCREASES_RISK",
    "Equivalent retry limit reached",
    "One equivalent retry has already run without a repository-state change."
  )
];

const RETRY_RECOVERY_DRIVERS = [
  driver(
    "duplicate-suppressed",
    "DECREASES_RISK",
    "Duplicate output suppressed",
    "A 280-token reference replaces the unchanged 6,800-token result."
  ),
  driver(
    "retry-rejected",
    "DECREASES_RISK",
    "Third attempt rejected",
    "The unchanged retry is rejected before another synthetic request is admitted."
  )
];

const LARGE_OPENING_REQUEST: RequestSeed = {
  phase: "work",
  exactInputTokens: 18_200,
  requestedMaxOutputTokens: 8_000,
  minimumUsefulOutputTokens: 1_100
};

const LARGE_CONTINUATION_REQUEST: RequestSeed = {
  phase: "work",
  exactInputTokens: 21_560,
  requestedMaxOutputTokens: 5_000,
  minimumUsefulOutputTokens: 1_800
};

const LARGE_FINAL_REQUEST: RequestSeed = {
  phase: "final",
  exactInputTokens: 23_800,
  requestedMaxOutputTokens: 4_000,
  minimumUsefulOutputTokens: 1_440
};

const CLEAN_OPENING_REQUEST: RequestSeed = {
  phase: "work",
  exactInputTokens: 4_200,
  requestedMaxOutputTokens: 4_000,
  minimumUsefulOutputTokens: 600
};

const CLEAN_FINAL_REQUEST: RequestSeed = {
  phase: "final",
  exactInputTokens: 5_320,
  requestedMaxOutputTokens: 2_200,
  minimumUsefulOutputTokens: 700
};

const RETRY_OPENING_REQUEST: RequestSeed = {
  phase: "work",
  exactInputTokens: 9_600,
  requestedMaxOutputTokens: 5_000,
  minimumUsefulOutputTokens: 900
};

const RETRY_CONTINUATION_REQUEST: RequestSeed = {
  phase: "work",
  exactInputTokens: 17_400,
  requestedMaxOutputTokens: 4_000,
  minimumUsefulOutputTokens: 1_200
};

const RETRY_FINAL_REQUEST: RequestSeed = {
  phase: "final",
  exactInputTokens: 19_000,
  requestedMaxOutputTokens: 2_800,
  minimumUsefulOutputTokens: 1_300
};

const LARGE_RETRY_ATTEMPT: RetryAttemptSeed = {
  toolName: "run_tests",
  arguments: { command: "npm test -- retry-context.test.ts" },
  errorClass: "AssertionError",
  stateRevision: "fixture-pr-1847-v1"
};

const RETRY_ATTEMPT: RetryAttemptSeed = {
  toolName: "run_tests",
  arguments: { command: "npm test -- retry-boundary.test.ts" },
  errorClass: "AssertionError",
  stateRevision: "fixture-pr-1856-v1"
};

function stopAction(reason: string): ActionSeed {
  return {
    kind: "STOP_BEFORE_OVERRUN",
    source: "HARD_CAP",
    execution: "APPLIED",
    summary: "Stopped before admitting an over-budget continuation.",
    reason,
    effect: {
      contextTokensRemoved: 0,
      retryPrevented: true,
      reserveProtectedMicroUsd: 0
    }
  };
}

function largeReductionAction(): ActionSeed {
  return {
    kind: "REDUCE_TEST_LOG",
    source: "STATIC_GUARDRAIL",
    execution: "APPLIED",
    summary: "Reduced the large failing log into a checksummed artifact.",
    reason:
      "The test output crossed the fixed 8,000-token reduction threshold.",
    effect: {
      contextTokensRemoved: 12_640,
      retryPrevented: false,
      reserveProtectedMicroUsd: 25_000,
      artifact: LARGE_LOG_ARTIFACT
    }
  };
}

function retryRejectionAction(reserveProtectedMicroUsd: number): ActionSeed {
  return {
    kind: "REJECT_UNCHANGED_RETRY",
    source: "STATIC_GUARDRAIL",
    execution: "APPLIED",
    summary: "Rejected an unchanged retry.",
    reason:
      "The tool arguments and repository state match the prior failed attempt.",
    effect: {
      contextTokensRemoved: 0,
      retryPrevented: true,
      reserveProtectedMicroUsd
    }
  };
}

function shadowPreserveAction(reserveProtectedMicroUsd: number): ActionSeed {
  return {
    kind: "PRESERVE_COMPLETION_BUDGET",
    source: "SHADOW_FORECAST",
    execution: "RECOMMENDED",
    summary: "Shadow forecast recommends preserving completion budget.",
    reason:
      "Observed context growth makes the unreduced continuation exceed its conservative admission bound.",
    effect: {
      contextTokensRemoved: 0,
      retryPrevented: false,
      reserveProtectedMicroUsd
    }
  };
}

function duplicateSuppressionAction(): ActionSeed {
  return {
    kind: "SUPPRESS_DUPLICATE_OUTPUT",
    source: "STATIC_GUARDRAIL",
    execution: "APPLIED",
    summary: "Replaced unchanged output with a checksummed reference.",
    reason:
      "The command, repository state, and output checksum are unchanged.",
    effect: {
      contextTokensRemoved: 6_520,
      retryPrevented: false,
      reserveProtectedMicroUsd: 21_000,
      artifact: RETRY_LOG_ARTIFACT
    }
  };
}

function largeHardCapBlueprint(): RunBlueprint {
  const controller: DemoController = "hard_cap";
  const firstReceipt: UsageSeed = {
    uncachedInputTokens: 18_200,
    cachedInputTokens: 0,
    outputTokens: 1_100
  };

  return {
    status: "POLICY_STOPPED",
    quality: LARGE_HARD_CAP_FAIL,
    headline: "Hard cap stopped before a final review.",
    detail:
      "The unreduced 14.6K-token log made the next conservative request bound incompatible with the protected reserve.",
    events: [
      {
        offsetMs: 0,
        type: "RUN_STARTED",
        title: "Synthetic review started",
        detail: "Applied the Routine PR Review policy to fixture PR #1847.",
        metrics: metrics(0, 0, 0, 18_200),
        risk: risk(controller, "SAFE", LARGE_BASELINE)
      },
      {
        offsetMs: 700,
        type: "REQUEST_ADMITTED",
        title: "Opening request admitted",
        detail:
          "Reserved a conservative synthetic maximum using the labeled demo rate card.",
        metrics: metrics(0, 0, 0, 18_200),
        risk: risk(controller, "SAFE", LARGE_BASELINE),
        request: LARGE_OPENING_REQUEST
      },
      {
        offsetMs: 2_100,
        type: "RESPONSE_SETTLED",
        title: "Opening response settled",
        detail:
          "Settled a synthetic receipt for repository inspection and a focused test command.",
        metrics: metrics(18_200, 0, 1_100, 19_600),
        risk: risk(controller, "SAFE", LARGE_BASELINE),
        receiptUsage: firstReceipt
      },
      {
        offsetMs: 3_600,
        type: "TOOL_RESULT",
        title: "Failing test produced a large log",
        detail:
          "The deterministic fixture emitted 14,600 tokens of failing test output.",
        metrics: metrics(18_200, 0, 1_100, 34_200),
        risk: risk(controller, "WATCH", LARGE_LOG_DRIVERS),
        retryAttempt: LARGE_RETRY_ATTEMPT,
        failedToolCall: true
      },
      {
        offsetMs: 4_300,
        type: "RISK_EVALUATED",
        title: "Continuation no longer fits",
        detail:
          "Without context reduction, the next conservative request and final reserve exceed the ceiling.",
        metrics: metrics(18_200, 0, 1_100, 34_200),
        risk: risk(controller, "AT_RISK", LARGE_AT_RISK_DRIVERS),
        minimumCompletionCostMicroUsd: 73_152
      },
      {
        offsetMs: 4_900,
        type: "INTERVENTION",
        title: "Hard cap stopped the run",
        detail:
          "No context optimization is available in this arm, so the request was not admitted.",
        metrics: metrics(18_200, 0, 1_100, 34_200),
        risk: risk(controller, "AT_RISK", LARGE_AT_RISK_DRIVERS),
        minimumCompletionCostMicroUsd: 73_152,
        action: stopAction(
          "The proposed continuation plus protected final request would cross the 75,000 micro-USD ceiling."
        )
      },
      {
        offsetMs: 5_400,
        type: "QUALITY_EVALUATED",
        title: "Quality gate failed",
        detail:
          "The stopped trace has no valid structured final review and is ineligible for cost comparison.",
        metrics: metrics(18_200, 0, 1_100, 34_200),
        risk: risk(controller, "AT_RISK", LARGE_AT_RISK_DRIVERS),
        minimumCompletionCostMicroUsd: 73_152
      },
      {
        offsetMs: 5_800,
        type: "RUN_STOPPED",
        title: "Run stopped within the hard ceiling",
        detail:
          "The synthetic cost stayed bounded, but the task did not meet its quality contract.",
        metrics: metrics(18_200, 0, 1_100, 34_200),
        risk: risk(controller, "AT_RISK", LARGE_AT_RISK_DRIVERS)
      }
    ]
  };
}

function largeGovernedBlueprint(controller: "static" | "shadow"): RunBlueprint {
  const firstReceipt: UsageSeed = {
    uncachedInputTokens: 18_200,
    cachedInputTokens: 0,
    outputTokens: 1_100
  };
  const secondReceipt: UsageSeed = {
    uncachedInputTokens: 6_560,
    cachedInputTokens: 15_000,
    outputTokens: 1_800
  };
  const finalReceipt: UsageSeed = {
    uncachedInputTokens: 5_800,
    cachedInputTokens: 18_000,
    outputTokens: 1_440
  };
  const events: EventSeed[] = [
    {
      offsetMs: 0,
      type: "RUN_STARTED",
      title: "Synthetic review started",
      detail: "Applied the Routine PR Review policy to fixture PR #1847.",
      metrics: metrics(0, 0, 0, 18_200),
      risk: risk(controller, "SAFE", LARGE_BASELINE)
    },
    {
      offsetMs: 700,
      type: "REQUEST_ADMITTED",
      title: "Opening request admitted",
      detail:
        "Reserved a conservative synthetic maximum using the labeled demo rate card.",
      metrics: metrics(0, 0, 0, 18_200),
      risk: risk(controller, "SAFE", LARGE_BASELINE),
      request: LARGE_OPENING_REQUEST
    },
    {
      offsetMs: 2_100,
      type: "RESPONSE_SETTLED",
      title: "Opening response settled",
      detail:
        "Settled a synthetic receipt for repository inspection and a focused test command.",
      metrics: metrics(18_200, 0, 1_100, 19_600),
      risk: risk(controller, "SAFE", LARGE_BASELINE),
      receiptUsage: firstReceipt
    },
    {
      offsetMs: 3_600,
      type: "TOOL_RESULT",
      title: "Failing test produced a large log",
      detail:
        "The deterministic fixture emitted 14,600 tokens of failing test output.",
      metrics: metrics(18_200, 0, 1_100, 34_200),
      risk: risk(controller, "WATCH", LARGE_LOG_DRIVERS),
      retryAttempt: LARGE_RETRY_ATTEMPT,
      failedToolCall: true
    }
  ];

  if (controller === "shadow") {
    events.push({
      offsetMs: 4_200,
      type: "RISK_EVALUATED",
      title: "Shadow risk moved to AT_RISK",
      detail:
        "The shadow signal records that an unreduced continuation cannot preserve the final reserve.",
      metrics: metrics(18_200, 0, 1_100, 34_200),
      risk: risk(controller, "AT_RISK", LARGE_AT_RISK_DRIVERS),
      minimumCompletionCostMicroUsd: 73_152,
      action: shadowPreserveAction(25_000)
    });
  }

  events.push(
    {
      offsetMs: 4_800,
      type: "INTERVENTION",
      title: "Large log reduced into an artifact",
      detail:
        "Kept the exit code, failing test, error location, and truncation disclosure in context.",
      metrics: metrics(18_200, 0, 1_100, 21_560),
      risk: risk(
        controller,
        controller === "shadow" ? "AT_RISK" : "WATCH",
        LARGE_REDUCED_DRIVERS
      ),
      action: largeReductionAction()
    },
    {
      offsetMs: 5_400,
      type: "RETRY_REJECTED",
      title: "Unchanged retry rejected",
      detail:
        "The same command against the same fixture state was rejected before request admission.",
      metrics: metrics(18_200, 0, 1_100, 21_560),
      risk: risk(controller, "WATCH", LARGE_REDUCED_DRIVERS),
      retryAttempt: LARGE_RETRY_ATTEMPT,
      action: retryRejectionAction(25_000)
    },
    {
      offsetMs: 6_100,
      type: "REQUEST_ADMITTED",
      title: "Reduced continuation admitted",
      detail:
        "The 21,560-token context now fits with the protected final reserve.",
      metrics: metrics(18_200, 0, 1_100, 21_560),
      risk: risk(controller, "WATCH", LARGE_REDUCED_DRIVERS),
      request: LARGE_CONTINUATION_REQUEST
    },
    {
      offsetMs: 7_600,
      type: "RESPONSE_SETTLED",
      title: "Diagnosis response settled",
      detail:
        "Settled a second synthetic receipt after reviewing the reduced failure evidence.",
      metrics: metrics(
        24_760,
        15_000,
        2_900,
        23_800
      ),
      risk: risk(controller, "WATCH", LARGE_REDUCED_DRIVERS),
      receiptUsage: secondReceipt
    },
    {
      offsetMs: 8_400,
      type: "REQUEST_ADMITTED",
      title: "Final review request admitted",
      detail:
        "Converted the protected completion reserve into a bounded final request.",
      metrics: metrics(
        24_760,
        15_000,
        2_900,
        23_800
      ),
      risk: risk(controller, "WATCH", LARGE_REDUCED_DRIVERS),
      request: LARGE_FINAL_REQUEST
    },
    {
      offsetMs: 9_900,
      type: "RESPONSE_SETTLED",
      title: "Final review settled",
      detail:
        "Settled the final synthetic receipt and sealed the structured review.",
      metrics: metrics(
        30_560,
        33_000,
        4_340,
        25_200
      ),
      risk: risk(controller, "SAFE", [
        driver(
          "review-sealed",
          "DECREASES_RISK",
          "Review sealed within policy",
          "All reservations are settled and the final synthetic cost is below the ceiling."
        )
      ]),
      receiptUsage: finalReceipt
    },
    {
      offsetMs: 10_500,
      type: "QUALITY_EVALUATED",
      title: "Quality gate passed",
      detail:
        "The sealed deterministic rubric found both seeded issues and no critical false positive.",
      metrics: metrics(
        30_560,
        33_000,
        4_340,
        25_200
      ),
      risk: risk(controller, "SAFE", [
        driver(
          "quality-pass",
          "DECREASES_RISK",
          "Quality contract met",
          "The structured fixture evaluator returned a score of 100."
        )
      ])
    },
    {
      offsetMs: 10_900,
      type: "RUN_COMPLETED",
      title: "Review completed within policy",
      detail:
        "The run completed with 30,075 micro-USD of unused synthetic capacity.",
      metrics: metrics(
        30_560,
        33_000,
        4_340,
        25_200
      ),
      risk: risk(controller, "SAFE", [
        driver(
          "policy-complete",
          "DECREASES_RISK",
          "Policy complete",
          "The review passed quality and remained below its 75,000 micro-USD ceiling."
        )
      ])
    }
  );

  return {
    status: "COMPLETED",
    quality: LARGE_PASS,
    headline: "Review completed after deterministic context controls.",
    detail:
      controller === "shadow"
        ? "The shadow signal moved SAFE to WATCH to AT_RISK; static guardrails reduced the log and rejected the retry before completion."
        : "Fixed guardrails reduced the log and rejected the unchanged retry before completion.",
    events
  };
}

function cleanBlueprint(controller: DemoController): RunBlueprint {
  const firstReceipt: UsageSeed = {
    uncachedInputTokens: 4_200,
    cachedInputTokens: 0,
    outputTokens: 600
  };
  const finalReceipt: UsageSeed = {
    uncachedInputTokens: 2_120,
    cachedInputTokens: 3_200,
    outputTokens: 700
  };
  const events: EventSeed[] = [
    {
      offsetMs: 0,
      type: "RUN_STARTED",
      title: "Synthetic review started",
      detail: "Applied the Routine PR Review policy to fixture PR #1851.",
      metrics: metrics(0, 0, 0, 4_200),
      risk: risk(controller, "SAFE", CLEAN_DRIVERS)
    },
    {
      offsetMs: 600,
      type: "REQUEST_ADMITTED",
      title: "Opening request admitted",
      detail:
        "The compact diff fits comfortably with its protected final reserve.",
      metrics: metrics(0, 0, 0, 4_200),
      risk: risk(controller, "SAFE", CLEAN_DRIVERS),
      request: CLEAN_OPENING_REQUEST
    },
    {
      offsetMs: 1_700,
      type: "RESPONSE_SETTLED",
      title: "Focused inspection settled",
      detail:
        "Settled a synthetic receipt after reading the diff and running focused tests.",
      metrics: metrics(4_200, 0, 600, 5_300),
      risk: risk(controller, "SAFE", CLEAN_DRIVERS),
      receiptUsage: firstReceipt
    },
    {
      offsetMs: 2_500,
      type: "TOOL_RESULT",
      title: "Focused tests passed",
      detail:
        "The deterministic clean fixture returned a small passing result.",
      metrics: metrics(4_200, 0, 600, 5_300),
      risk: risk(controller, "SAFE", CLEAN_DRIVERS)
    }
  ];

  if (controller === "shadow") {
    events.push({
      offsetMs: 3_000,
      type: "RISK_EVALUATED",
      title: "Shadow risk remained SAFE",
      detail:
        "No forecast recommendation is recorded because context and cost remain stable.",
      metrics: metrics(4_200, 0, 600, 5_300),
      risk: risk(controller, "SAFE", CLEAN_DRIVERS)
    });
  }

  events.push(
    {
      offsetMs: 3_500,
      type: "REQUEST_ADMITTED",
      title: "Final review request admitted",
      detail: "Converted the completion reserve into a bounded final request.",
      metrics: metrics(4_200, 0, 600, 5_320),
      risk: risk(controller, "SAFE", CLEAN_DRIVERS),
      request: CLEAN_FINAL_REQUEST
    },
    {
      offsetMs: 4_700,
      type: "RESPONSE_SETTLED",
      title: "Finding-free review settled",
      detail:
        "Settled the final synthetic receipt and sealed a structured review with no findings.",
      metrics: metrics(
        6_320,
        3_200,
        1_300,
        5_700
      ),
      risk: risk(controller, "SAFE", CLEAN_DRIVERS),
      receiptUsage: finalReceipt
    },
    {
      offsetMs: 5_200,
      type: "QUALITY_EVALUATED",
      title: "Quality gate passed",
      detail:
        "The deterministic rubric confirmed a valid review with no invented finding.",
      metrics: metrics(
        6_320,
        3_200,
        1_300,
        5_700
      ),
      risk: risk(controller, "SAFE", CLEAN_DRIVERS)
    },
    {
      offsetMs: 5_600,
      type: "RUN_COMPLETED",
      title: "Clean review completed",
      detail:
        "The run passed quality with 24,170 micro-USD of unused synthetic capacity.",
      metrics: metrics(
        6_320,
        3_200,
        1_300,
        5_700
      ),
      risk: risk(controller, "SAFE", CLEAN_DRIVERS)
    }
  );

  return {
    status: "COMPLETED",
    quality: CLEAN_PASS,
    headline: "Clean review completed without intervention.",
    detail:
      controller === "shadow"
        ? "The shadow signal remained SAFE and made no recommendation."
        : "The small stable context required no deterministic intervention.",
    events
  };
}

function retryHardCapBlueprint(): RunBlueprint {
  const controller: DemoController = "hard_cap";
  const firstReceipt: UsageSeed = {
    uncachedInputTokens: 9_600,
    cachedInputTokens: 0,
    outputTokens: 900
  };
  const secondReceipt: UsageSeed = {
    uncachedInputTokens: 9_400,
    cachedInputTokens: 8_000,
    outputTokens: 1_200
  };

  return {
    status: "POLICY_STOPPED",
    quality: RETRY_HARD_CAP_FAIL,
    headline: "Repeated output consumed the useful continuation path.",
    detail:
      "The hard-cap arm retained the duplicate log and could not admit another useful request with the final reserve.",
    events: [
      {
        offsetMs: 0,
        type: "RUN_STARTED",
        title: "Synthetic review started",
        detail: "Applied the Routine PR Review policy to fixture PR #1856.",
        metrics: metrics(0, 0, 0, 9_600),
        risk: risk(controller, "SAFE", RETRY_BASELINE)
      },
      {
        offsetMs: 600,
        type: "REQUEST_ADMITTED",
        title: "Opening request admitted",
        detail: "Reserved a bounded opening inspection.",
        metrics: metrics(0, 0, 0, 9_600),
        risk: risk(controller, "SAFE", RETRY_BASELINE),
        request: RETRY_OPENING_REQUEST
      },
      {
        offsetMs: 1_800,
        type: "RESPONSE_SETTLED",
        title: "Opening response settled",
        detail:
          "Settled a synthetic receipt after the first test command was proposed.",
        metrics: metrics(9_600, 0, 900, 10_600),
        risk: risk(controller, "SAFE", RETRY_BASELINE),
        receiptUsage: firstReceipt
      },
      {
        offsetMs: 2_800,
        type: "TOOL_RESULT",
        title: "Retry-boundary test failed",
        detail: "The deterministic fixture emitted 6,800 tokens of output.",
        metrics: metrics(9_600, 0, 900, 17_400),
        risk: risk(controller, "WATCH", RETRY_WATCH_DRIVERS),
        retryAttempt: RETRY_ATTEMPT,
        failedToolCall: true
      },
      {
        offsetMs: 3_500,
        type: "REQUEST_ADMITTED",
        title: "Equivalent retry admitted",
        detail:
          "The first equivalent retry is inside policy and is admitted without duplicate suppression.",
        metrics: metrics(9_600, 0, 900, 17_400),
        risk: risk(controller, "WATCH", RETRY_WATCH_DRIVERS),
        request: RETRY_CONTINUATION_REQUEST
      },
      {
        offsetMs: 4_800,
        type: "RESPONSE_SETTLED",
        title: "Retry response settled",
        detail:
          "Settled a second synthetic receipt before the unchanged result returned.",
        metrics: metrics(
          19_000,
          8_000,
          2_100,
          18_400
        ),
        risk: risk(controller, "WATCH", RETRY_WATCH_DRIVERS),
        receiptUsage: secondReceipt
      },
      {
        offsetMs: 5_700,
        type: "TOOL_RESULT",
        title: "Unchanged failure returned in full",
        detail:
          "The hard-cap arm retained the second byte-identical 6,800-token fixture log.",
        metrics: metrics(
          19_000,
          8_000,
          2_100,
          25_200
        ),
        risk: risk(controller, "AT_RISK", RETRY_AT_RISK_DRIVERS),
        retryAttempt: RETRY_ATTEMPT,
        failedToolCall: true
      },
      {
        offsetMs: 6_400,
        type: "INTERVENTION",
        title: "Hard cap stopped a third attempt",
        detail:
          "The unreduced continuation cannot fit with the protected final reserve.",
        metrics: metrics(
          19_000,
          8_000,
          2_100,
          25_200
        ),
        risk: risk(controller, "AT_RISK", RETRY_AT_RISK_DRIVERS),
        action: stopAction(
          "The next conservative request plus protected final request would exceed the 65,000 micro-USD ceiling."
        )
      },
      {
        offsetMs: 6_900,
        type: "QUALITY_EVALUATED",
        title: "Quality gate failed",
        detail:
          "No valid final review was sealed, so this lower-cost stopped run is not cost-comparison eligible.",
        metrics: metrics(
          19_000,
          8_000,
          2_100,
          25_200
        ),
        risk: risk(controller, "AT_RISK", RETRY_AT_RISK_DRIVERS)
      },
      {
        offsetMs: 7_300,
        type: "RUN_STOPPED",
        title: "Run stopped within the hard ceiling",
        detail:
          "The synthetic cost stayed bounded, but the seeded issue was not reported.",
        metrics: metrics(
          19_000,
          8_000,
          2_100,
          25_200
        ),
        risk: risk(controller, "AT_RISK", RETRY_AT_RISK_DRIVERS)
      }
    ]
  };
}

function retryGovernedBlueprint(
  controller: "static" | "shadow"
): RunBlueprint {
  const firstReceipt: UsageSeed = {
    uncachedInputTokens: 9_600,
    cachedInputTokens: 0,
    outputTokens: 900
  };
  const secondReceipt: UsageSeed = {
    uncachedInputTokens: 9_400,
    cachedInputTokens: 8_000,
    outputTokens: 1_200
  };
  const finalReceipt: UsageSeed = {
    uncachedInputTokens: 5_000,
    cachedInputTokens: 14_000,
    outputTokens: 1_300
  };
  const events: EventSeed[] = [
    {
      offsetMs: 0,
      type: "RUN_STARTED",
      title: "Synthetic review started",
      detail: "Applied the Routine PR Review policy to fixture PR #1856.",
      metrics: metrics(0, 0, 0, 9_600),
      risk: risk(controller, "SAFE", RETRY_BASELINE)
    },
    {
      offsetMs: 600,
      type: "REQUEST_ADMITTED",
      title: "Opening request admitted",
      detail: "Reserved a bounded opening inspection.",
      metrics: metrics(0, 0, 0, 9_600),
      risk: risk(controller, "SAFE", RETRY_BASELINE),
      request: RETRY_OPENING_REQUEST
    },
    {
      offsetMs: 1_800,
      type: "RESPONSE_SETTLED",
      title: "Opening response settled",
      detail:
        "Settled a synthetic receipt after the first test command was proposed.",
      metrics: metrics(9_600, 0, 900, 10_600),
      risk: risk(controller, "SAFE", RETRY_BASELINE),
      receiptUsage: firstReceipt
    },
    {
      offsetMs: 2_800,
      type: "TOOL_RESULT",
      title: "Retry-boundary test failed",
      detail: "The deterministic fixture emitted 6,800 tokens of output.",
      metrics: metrics(9_600, 0, 900, 17_400),
      risk: risk(controller, "WATCH", RETRY_WATCH_DRIVERS),
      retryAttempt: RETRY_ATTEMPT,
      failedToolCall: true
    },
    {
      offsetMs: 3_500,
      type: "REQUEST_ADMITTED",
      title: "Equivalent retry admitted",
      detail: "One bounded equivalent retry is allowed by the frozen policy.",
      metrics: metrics(9_600, 0, 900, 17_400),
      risk: risk(controller, "WATCH", RETRY_WATCH_DRIVERS),
      request: RETRY_CONTINUATION_REQUEST
    },
    {
      offsetMs: 4_800,
      type: "RESPONSE_SETTLED",
      title: "Retry response settled",
      detail:
        "Settled a second synthetic receipt before the unchanged result returned.",
      metrics: metrics(
        19_000,
        8_000,
        2_100,
        18_400
      ),
      risk: risk(controller, "WATCH", RETRY_WATCH_DRIVERS),
      receiptUsage: secondReceipt,
      retryAttempt: RETRY_ATTEMPT,
      failedToolCall: true
    }
  ];

  if (controller === "shadow") {
    events.push({
      offsetMs: 5_300,
      type: "RISK_EVALUATED",
      title: "Shadow risk moved to AT_RISK",
      detail:
        "The shadow signal recommends protecting the final response before another unchanged attempt.",
      metrics: metrics(
        19_000,
        8_000,
        2_100,
        18_400
      ),
      risk: risk(controller, "AT_RISK", RETRY_AT_RISK_DRIVERS),
      action: shadowPreserveAction(21_000)
    });
  }

  events.push(
    {
      offsetMs: 5_900,
      type: "INTERVENTION",
      title: "Duplicate output suppressed",
      detail:
        "Stored the full synthetic fixture log by checksum and kept a 280-token reference in context.",
      metrics: metrics(
        19_000,
        8_000,
        2_100,
        18_680
      ),
      risk: risk(
        controller,
        controller === "shadow" ? "AT_RISK" : "WATCH",
        RETRY_RECOVERY_DRIVERS
      ),
      action: duplicateSuppressionAction()
    },
    {
      offsetMs: 6_400,
      type: "RETRY_REJECTED",
      title: "Third unchanged attempt rejected",
      detail:
        "The equivalent retry limit was reached, so no additional synthetic request was admitted.",
      metrics: metrics(
        19_000,
        8_000,
        2_100,
        18_680
      ),
      risk: risk(controller, "WATCH", RETRY_RECOVERY_DRIVERS),
      retryAttempt: RETRY_ATTEMPT,
      action: retryRejectionAction(21_000)
    },
    {
      offsetMs: 7_100,
      type: "REQUEST_ADMITTED",
      title: "Final review request admitted",
      detail:
        "The checksummed reference and preserved reserve leave room for a bounded final response.",
      metrics: metrics(
        19_000,
        8_000,
        2_100,
        19_000
      ),
      risk: risk(controller, "WATCH", RETRY_RECOVERY_DRIVERS),
      request: RETRY_FINAL_REQUEST
    },
    {
      offsetMs: 8_500,
      type: "RESPONSE_SETTLED",
      title: "Final review settled",
      detail:
        "Settled the final synthetic receipt and sealed the retry-boundary finding.",
      metrics: metrics(
        24_000,
        22_000,
        3_400,
        19_400
      ),
      risk: risk(controller, "SAFE", RETRY_RECOVERY_DRIVERS),
      receiptUsage: finalReceipt
    },
    {
      offsetMs: 9_100,
      type: "QUALITY_EVALUATED",
      title: "Quality gate passed",
      detail:
        "The sealed deterministic rubric confirmed the seeded retry-boundary finding.",
      metrics: metrics(
        24_000,
        22_000,
        3_400,
        19_400
      ),
      risk: risk(controller, "SAFE", RETRY_RECOVERY_DRIVERS)
    },
    {
      offsetMs: 9_500,
      type: "RUN_COMPLETED",
      title: "Review completed within policy",
      detail:
        "The run passed quality with 30,050 micro-USD of unused synthetic capacity.",
      metrics: metrics(
        24_000,
        22_000,
        3_400,
        19_400
      ),
      risk: risk(controller, "SAFE", RETRY_RECOVERY_DRIVERS)
    }
  );

  return {
    status: "COMPLETED",
    quality: RETRY_PASS,
    headline: "Review completed after rejecting unchanged work.",
    detail:
      controller === "shadow"
        ? "The shadow signal recommended preserving completion capacity; static guardrails suppressed duplicate output and rejected the retry."
        : "Fixed guardrails suppressed duplicate output and rejected the unchanged retry.",
    events
  };
}

export function getRunBlueprint(
  scenarioId: DemoScenario["id"],
  controller: DemoController
): RunBlueprint {
  switch (scenarioId) {
    case "large-failing-log":
      return controller === "hard_cap"
        ? largeHardCapBlueprint()
        : largeGovernedBlueprint(controller);
    case "clean-small-diff":
      return cleanBlueprint(controller);
    case "repeated-unchanged-retry":
      return controller === "hard_cap"
        ? retryHardCapBlueprint()
        : retryGovernedBlueprint(controller);
  }
}
