import {
  ArrowRight,
  BadgeCheck,
  Ban,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  LayoutDashboard,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Terminal,
  TriangleAlert,
  Wrench,
  XCircle,
  type LucideIcon
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent
} from "react";
import {
  ApiError,
  createRepairRun,
  type RepairMode,
  type RepairRunResponse,
  type RepairTraceEvent
} from "./api";

type RunStatus = "idle" | "running" | "success" | "error";

const MODE_LABELS: Record<RepairMode, string> = {
  fake: "Fake (deterministic)",
  hybrid: "Hybrid",
  live: "Live"
};

const MODE_ORDER: RepairMode[] = import.meta.env.DEV
  ? ["fake", "hybrid", "live"]
  : ["fake"];

const DEFAULT_FIXTURE = "broken-sum";
const DEFAULT_MODE: RepairMode = "fake";

const spendFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 6,
  maximumFractionDigits: 6
});

const numberFormatter = new Intl.NumberFormat("en-US");

function formatSpend(microUsd: number): string {
  return spendFormatter.format(Math.max(0, microUsd) / 1_000_000);
}

function formatNumber(value: number): string {
  return numberFormatter.format(Math.max(0, value));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${formatNumber(bytes)} B`;
  }
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) {
    return error.message;
  }
  return "The governed repair run could not be completed.";
}

function traceIcon(kind: RepairTraceEvent["kind"]): LucideIcon {
  if (kind === "tool") {
    return Terminal;
  }
  if (kind === "retry") {
    return ShieldCheck;
  }
  return BrainCircuit;
}

function traceSummary(event: RepairTraceEvent): {
  headline: string;
  detail: string;
} {
  if (event.kind === "tool") {
    return {
      headline: event.name,
      detail: `rev ${event.revision || "n/a"} \u00b7 ${formatBytes(
        event.outputBytes
      )} output`
    };
  }
  if (event.kind === "retry") {
    return {
      headline: `Retry blocked \u00b7 ${event.name}`,
      detail: `state ${event.state || "unknown"} \u00b7 ${formatNumber(
        event.equivalentRetryCount
      )} equivalent retries \u00b7 not admitted`
    };
  }
  return {
    headline: `Model response \u00b7 ${event.phase}`,
    detail: `status ${event.status || "unknown"}${
      event.responseId ? ` \u00b7 ${event.responseId}` : ""
    }`
  };
}

function RepairHeader(): React.JSX.Element {
  return (
    <header className="app-header">
      <div className="header-inner">
        <div className="brand-lockup" aria-label="Governor CI-Repair">
          <span className="brand-mark" aria-hidden="true">
            <img src="/brand/governor-mark.svg" alt="" />
          </span>
          <span className="brand-name">Governor</span>
          <span className="brand-context">CI-Repair</span>
        </div>
        <div className="truth-strip">
          <span className="truth-badge">
            GOVERNOR CORE / POLICY-BOUNDED AUTONOMY
          </span>
          <a className="repair-nav-link" href="/">
            <LayoutDashboard size={16} aria-hidden="true" />
            Operations dashboard
          </a>
        </div>
      </div>
    </header>
  );
}

function ModeSelect({
  value,
  disabled,
  onChange
}: {
  value: RepairMode;
  disabled: boolean;
  onChange: (mode: RepairMode) => void;
}): React.JSX.Element {
  return (
    <label className="field">
      <span className="field-label">Execution mode</span>
      <span className="select-shell">
        <select
          name="mode"
          value={value}
          disabled={disabled || MODE_ORDER.length === 1}
          onChange={(event) => onChange(event.target.value as RepairMode)}
        >
          {MODE_ORDER.map((mode) => (
            <option key={mode} value={mode}>
              {MODE_LABELS[mode]}
            </option>
          ))}
        </select>
        <ChevronDown size={16} aria-hidden="true" />
      </span>
    </label>
  );
}

function StatusBadge({
  run
}: {
  run: RepairRunResponse;
}): React.JSX.Element {
  const repaired = run.result.status === "repaired";

  return (
    <div
      className={`repair-status repair-status--${
        repaired ? "repaired" : "failed"
      }`}
      role="status"
    >
      <span className="repair-status__icon" aria-hidden="true">
        {repaired ? <BadgeCheck size={26} /> : <XCircle size={26} />}
      </span>
      <div className="repair-status__text">
        <span className="repair-status__badge">
          {repaired ? "Repaired \u2713" : "Not repaired"}
        </span>
        <p>
          {repaired
            ? "Governor admitted a fix within policy and the sealed evaluation passed."
            : run.result.reason ??
              "The run terminated without a policy-admissible fix."}
        </p>
      </div>
      <dl className="repair-status__meta">
        <div>
          <dt>Fixture</dt>
          <dd>{run.fixtureId || "\u2014"}</dd>
        </div>
        <div>
          <dt>Mode</dt>
          <dd>{MODE_LABELS[run.mode]}</dd>
        </div>
        <div>
          <dt>Revision</dt>
          <dd>{run.result.revision || "\u2014"}</dd>
        </div>
      </dl>
    </div>
  );
}

function SpendCard({
  run
}: {
  run: RepairRunResponse;
}): React.JSX.Element {
  const settled = run.result.settledMicroUsd;

  return (
    <section className="repair-card repair-card--spend" aria-labelledby="spend-title">
      <header className="repair-card__head">
        <span className="repair-card__icon" aria-hidden="true">
          <CircleDollarSign size={18} />
        </span>
        <div>
          <p className="eyebrow">Governed spend</p>
          <h2 id="spend-title">Settled cost</h2>
        </div>
      </header>
      <div className="repair-spend">
        {settled === undefined ? (
          <p className="repair-quiet">
            No settled spend was reported for this run.
          </p>
        ) : (
          <>
            <strong>{formatSpend(settled)}</strong>
            <span>{formatNumber(settled)} micro-USD settled</span>
          </>
        )}
      </div>
      <dl className="repair-inline-meta">
        <div>
          <dt>Model</dt>
          <dd>{run.model || "\u2014"}</dd>
        </div>
        <div>
          <dt>Rate card</dt>
          <dd>{run.rateCardVersion || "\u2014"}</dd>
        </div>
        <div>
          <dt>Tool calls</dt>
          <dd>{formatNumber(run.result.toolCalls)}</dd>
        </div>
      </dl>
    </section>
  );
}

function EvaluationCard({
  run
}: {
  run: RepairRunResponse;
}): React.JSX.Element {
  const evaluation = run.result.evaluation;

  return (
    <section
      className="repair-card repair-card--eval"
      aria-labelledby="eval-title"
    >
      <header className="repair-card__head">
        <span className="repair-card__icon" aria-hidden="true">
          <ShieldCheck size={18} />
        </span>
        <div>
          <p className="eyebrow">Sealed evaluation</p>
          <h2 id="eval-title">Verification gate</h2>
        </div>
      </header>
      {evaluation === null ? (
        <p className="repair-quiet">
          No sealed evaluation was attached to this run.
        </p>
      ) : (
        <>
          <div className="repair-eval-flags">
            <span
              className={`repair-flag repair-flag--${
                evaluation.passed ? "pass" : "fail"
              }`}
            >
              {evaluation.passed ? (
                <CheckCircle2 size={15} aria-hidden="true" />
              ) : (
                <XCircle size={15} aria-hidden="true" />
              )}
              {evaluation.passed ? "Passed" : "Failed"}
            </span>
            <span
              className={`repair-flag repair-flag--${
                evaluation.targetPassed ? "pass" : "fail"
              }`}
            >
              {evaluation.targetPassed ? (
                <CheckCircle2 size={15} aria-hidden="true" />
              ) : (
                <XCircle size={15} aria-hidden="true" />
              )}
              Target
            </span>
            <span
              className={`repair-flag repair-flag--${
                evaluation.policyRespected ? "pass" : "fail"
              }`}
            >
              {evaluation.policyRespected ? (
                <CheckCircle2 size={15} aria-hidden="true" />
              ) : (
                <XCircle size={15} aria-hidden="true" />
              )}
              Policy respected
            </span>
            <span className="repair-flag repair-flag--code">
              exit {formatNumber(evaluation.exitCode)}
            </span>
          </div>
          <div className="repair-violations">
            <span className="repair-violations__label">
              Violations ({evaluation.violations.length})
            </span>
            {evaluation.violations.length === 0 ? (
              <p className="repair-quiet">No policy violations recorded.</p>
            ) : (
              <ul>
                {evaluation.violations.map((violation, index) => (
                  <li key={`${index}-${violation}`}>
                    <TriangleAlert size={13} aria-hidden="true" />
                    {violation}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function FinalTextCard({
  finalText
}: {
  finalText: string | null;
}): React.JSX.Element {
  return (
    <section
      className="repair-card repair-card--final"
      aria-labelledby="final-title"
    >
      <header className="repair-card__head">
        <span className="repair-card__icon" aria-hidden="true">
          <Wrench size={18} />
        </span>
        <div>
          <p className="eyebrow">Agent summary</p>
          <h2 id="final-title">Fix narrative</h2>
        </div>
      </header>
      {finalText === null || finalText.trim() === "" ? (
        <p className="repair-quiet">
          The agent did not return a natural-language summary for this run.
        </p>
      ) : (
        <div className="repair-final-text">{finalText}</div>
      )}
    </section>
  );
}

function TraceTimeline({
  trace
}: {
  trace: RepairTraceEvent[];
}): React.JSX.Element {
  return (
    <section
      className="repair-card repair-card--trace"
      aria-labelledby="trace-title"
    >
      <header className="repair-card__head">
        <span className="repair-card__icon" aria-hidden="true">
          <Terminal size={18} />
        </span>
        <div>
          <p className="eyebrow">Governed execution</p>
          <h2 id="trace-title">Control timeline</h2>
        </div>
        <span className="repair-trace-count">{trace.length} events</span>
      </header>
      {trace.length === 0 ? (
        <p className="repair-quiet">This run produced no trace events.</p>
      ) : (
        <ol className="repair-trace">
          {trace.map((event, index) => {
            const Icon = traceIcon(event.kind);
            const { headline, detail } = traceSummary(event);
            return (
              <li
                key={`${event.sequence}-${index}`}
                className={`repair-trace__event repair-trace__event--${event.kind}`}
              >
                <span className="repair-trace__seq" aria-hidden="true">
                  {formatNumber(event.sequence)}
                </span>
                <span className="repair-trace__icon" aria-hidden="true">
                  <Icon size={15} />
                </span>
                <div className="repair-trace__body">
                  <div className="repair-trace__meta">
                    <span className="repair-trace__kind">{event.kind}</span>
                    <strong>{headline}</strong>
                  </div>
                  <p>{detail}</p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function RepairResultView({
  run
}: {
  run: RepairRunResponse;
}): React.JSX.Element {
  return (
    <div className="repair-result">
      <StatusBadge run={run} />
      <div className="repair-grid">
        <SpendCard run={run} />
        <EvaluationCard run={run} />
      </div>
      <FinalTextCard finalText={run.result.finalText} />
      <TraceTimeline trace={run.result.trace} />
    </div>
  );
}

function RepairEmptyState(): React.JSX.Element {
  return (
    <section className="repair-empty" aria-live="polite">
      <span className="repair-empty__icon" aria-hidden="true">
        <Wrench size={24} />
      </span>
      <h2>Ready to dispatch a governed repair</h2>
      <p>
        Governor drives an autonomous build-repair loop under a hard policy
        budget, then seals the result with a verification gate. Run it to see the
        settled spend, evaluation, and full control timeline.
      </p>
    </section>
  );
}

function RepairRunningState(): React.JSX.Element {
  return (
    <section className="repair-empty" aria-live="polite">
      <span className="repair-empty__icon repair-empty__icon--loading" aria-hidden="true">
        <RefreshCw className="spin" size={24} />
      </span>
      <h2>Running governed repair</h2>
      <p>
        Admitting model and tool calls against the policy budget. The final
        answer reserve is protected until the run settles.
      </p>
    </section>
  );
}

function RepairErrorState({
  message,
  onRetry
}: {
  message: string;
  onRetry: () => void;
}): React.JSX.Element {
  return (
    <section className="repair-empty repair-empty--error" role="alert">
      <span className="repair-empty__icon repair-empty__icon--error" aria-hidden="true">
        <Ban size={24} />
      </span>
      <h2>Repair run failed</h2>
      <p>{message}</p>
      <button
        className="button button--secondary"
        type="button"
        onClick={onRetry}
      >
        <RotateCcw size={16} aria-hidden="true" />
        Try again
      </button>
    </section>
  );
}

export default function RepairPanel(): React.JSX.Element {
  const [fixtureId, setFixtureId] = useState(DEFAULT_FIXTURE);
  const [mode, setMode] = useState<RepairMode>(DEFAULT_MODE);
  const [status, setStatus] = useState<RunStatus>("idle");
  const [run, setRun] = useState<RepairRunResponse | null>(null);
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    []
  );

  const runRepair = useCallback(async (): Promise<void> => {
    abortRef.current?.abort();
    const abortController = new AbortController();
    abortRef.current = abortController;
    setStatus("running");
    setError("");

    try {
      const trimmedFixture = fixtureId.trim();
      const response = await createRepairRun(
        {
          fixtureId: trimmedFixture === "" ? DEFAULT_FIXTURE : trimmedFixture,
          mode
        },
        abortController.signal
      );
      setRun(response);
      setStatus("success");
    } catch (caught: unknown) {
      if (abortController.signal.aborted) {
        return;
      }
      setError(errorMessage(caught));
      setStatus("error");
    } finally {
      if (abortRef.current === abortController) {
        abortRef.current = null;
      }
    }
  }, [fixtureId, mode]);

  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      if (status === "running") {
        return;
      }
      void runRepair();
    },
    [runRepair, status]
  );

  const isRunning = status === "running";

  let content: React.JSX.Element;
  if (status === "running") {
    content = <RepairRunningState />;
  } else if (status === "error") {
    content = <RepairErrorState message={error} onRetry={() => void runRepair()} />;
  } else if (status === "success" && run) {
    content = <RepairResultView run={run} />;
  } else {
    content = <RepairEmptyState />;
  }

  return (
    <div className="repair-shell">
      <RepairHeader />
      <main className="repair-main">
        <section className="repair-command" aria-labelledby="repair-title">
          <div className="repair-command__context">
            <p className="eyebrow">Governed autonomous repair</p>
            <h1 id="repair-title">CI-Repair</h1>
            <p className="repair-lede">
              Trigger a policy-bounded build-repair agent. Every model and tool
              call is admitted against a budget, retries are governed, and the
              outcome is settled with a sealed evaluation.
            </p>
          </div>
          <form className="repair-controls" onSubmit={submit}>
            <label className="field field--fixture">
              <span className="field-label">Fixture</span>
              <input
                className="repair-input"
                name="fixtureId"
                type="text"
                value={fixtureId}
                placeholder={DEFAULT_FIXTURE}
                disabled={isRunning}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setFixtureId(event.target.value)}
              />
            </label>
            <ModeSelect value={mode} disabled={isRunning} onChange={setMode} />
            <button
              className="button button--primary repair-run-button"
              type="submit"
              disabled={isRunning}
              aria-label="Run governed repair"
            >
              {isRunning ? (
                <RefreshCw className="spin" size={17} aria-hidden="true" />
              ) : (
                <ArrowRight size={17} aria-hidden="true" />
              )}
              {isRunning ? "Running repair" : "Run governed repair"}
            </button>
          </form>
        </section>
        {content}
      </main>
      <footer className="app-footer repair-footer">
        <span>Governor POC</span>
        <span>Policy-bounded autonomy. Governed spend settled in micro-USD.</span>
      </footer>
    </div>
  );
}
