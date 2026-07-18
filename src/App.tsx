import {
  Activity,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  FileSearch,
  Gauge,
  GitPullRequest,
  LockKeyhole,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Terminal,
  TriangleAlert,
  XCircle,
  type LucideIcon
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent
} from "react";
import {
  ApiError,
  createDemoRun,
  getDemoCatalog,
  type BenchmarkRow,
  type Controller,
  type DemoCatalog,
  type DemoRateCard,
  type DemoTruth,
  type EventMetrics,
  type RiskBand,
  type RunEvent,
  type RunTrace,
  type ScenarioSummary,
  type TraceAction
} from "./api";

type CatalogStatus = "loading" | "ready" | "error";
type PlaybackStatus =
  | "empty"
  | "requesting"
  | "playing"
  | "complete"
  | "error";

const CONTROLLER_LABELS: Record<Controller, string> = {
  hard_cap: "Hard cap",
  static: "Static rules",
  shadow: "Static + shadow annotation"
};

const CONTROLLER_ORDER: Controller[] = ["hard_cap", "static", "shadow"];

const moneyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 6,
  maximumFractionDigits: 6
});

const numberFormatter = new Intl.NumberFormat("en-US");

function formatMoney(micros: number): string {
  return moneyFormatter.format(Math.max(0, micros) / 1_000_000);
}

function formatRate(value: number): string {
  return `$${Math.max(0, value).toFixed(6)}`;
}

function rateCardSummary(rateCard: DemoRateCard): string {
  return (
    `${rateCard.provider}/${rateCard.model} ${rateCard.serviceTier}; ` +
    `${formatRate(rateCard.uncachedInputUsdPerMillionTokens)} input, ` +
    `${formatRate(rateCard.cachedInputUsdPerMillionTokens)} cached input, ` +
    `${formatRate(rateCard.outputUsdPerMillionTokens)} output per 1M tokens`
  );
}

function formatNumber(value: number): string {
  return numberFormatter.format(Math.max(0, value));
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) {
    return `${Math.max(0, Math.round(milliseconds))} ms`;
  }

  return `${(milliseconds / 1_000).toFixed(1)} s`;
}

function formatOffset(milliseconds: number): string {
  return `+${(Math.max(0, milliseconds) / 1_000).toFixed(1)}s`;
}

function formatScore(score: number): string {
  const percentage = score <= 1 ? score * 100 : score;
  return `${Math.round(percentage)}%`;
}

function riskClass(risk: RiskBand): string {
  return risk.toLowerCase().replace("_", "-");
}

function latestEventWith(
  events: RunEvent[],
  predicate: (event: RunEvent) => boolean
): RunEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (predicate(events[index])) {
      return events[index];
    }
  }

  return undefined;
}

function eventIcon(kind: string): LucideIcon {
  const normalizedKind = kind.toLowerCase();

  if (normalizedKind.includes("model") || normalizedKind.includes("response")) {
    return BrainCircuit;
  }
  if (normalizedKind.includes("tool") || normalizedKind.includes("test")) {
    return Terminal;
  }
  if (
    normalizedKind.includes("policy") ||
    normalizedKind.includes("control") ||
    normalizedKind.includes("intervention")
  ) {
    return ShieldCheck;
  }
  if (
    normalizedKind.includes("cost") ||
    normalizedKind.includes("reserve") ||
    normalizedKind.includes("settle")
  ) {
    return CircleDollarSign;
  }
  if (normalizedKind.includes("quality")) {
    return CheckCircle2;
  }

  return Activity;
}

function actionParts(action: TraceAction | string): TraceAction {
  if (typeof action === "string") {
    return {
      label: "Controller action",
      detail: action,
      mode: "deterministic",
      execution: "APPLIED",
      source: "STATIC_GUARDRAIL"
    };
  }

  return action;
}

function AppHeader({
  playbackStatus
}: {
  playbackStatus: PlaybackStatus;
}): React.JSX.Element {
  const operationalLabel =
    playbackStatus === "requesting"
      ? "LOADING FIXTURE"
      : playbackStatus === "playing"
        ? "PLAYING TRACE"
        : playbackStatus === "complete"
          ? "TRACE COMPLETE"
          : playbackStatus === "error"
            ? "ATTENTION"
            : "READY";

  return (
    <header className="app-header">
      <div className="header-inner">
        <div className="brand-lockup" aria-label="Governor">
          <span className="brand-mark" aria-hidden="true">
            <img src="/brand/governor-mark.svg" alt="" />
          </span>
          <span className="brand-name">Governor</span>
          <span className="brand-context">Execution control</span>
        </div>
        <div className="truth-strip" aria-label="Data provenance and run state">
          <span className="truth-badge">
            GOVERNOR CORE / SCRIPTED INPUTS / 0 EXTERNAL CALLS
          </span>
          <span
            className={`operation-status operation-status--${playbackStatus}`}
            aria-live="polite"
          >
            <span className="status-dot" aria-hidden="true" />
            {operationalLabel}
          </span>
        </div>
      </div>
    </header>
  );
}

function TruthDisclosure({
  truth,
  label
}: {
  truth: DemoTruth;
  label: string;
}): React.JSX.Element {
  return (
    <div className="truth-disclosure" aria-label={label} title={truth.truthLabel}>
      <p>
        <strong>{truth.provenance.origin}</strong>
        <span>{truth.provenance.governorCore}</span>
        <span>{truth.provenance.usageSource} usage</span>
        <span>{truth.provenance.costBasis}</span>
      </p>
      <p>
        Pinned synthetic rate: {rateCardSummary(truth.rateCard)}. Not billed.
        {" "}
        {truth.rateCard.disclosure}
      </p>
    </div>
  );
}

function ControllerSelect({
  value,
  disabled,
  onChange
}: {
  value: Controller;
  disabled: boolean;
  onChange: (controller: Controller) => void;
}): React.JSX.Element {
  return (
    <label className="field">
      <span className="field-label">Controller</span>
      <span className="select-shell">
        <select
          name="controller"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value as Controller)}
        >
          {CONTROLLER_ORDER.map((controller) => (
            <option key={controller} value={controller}>
              {CONTROLLER_LABELS[controller]}
            </option>
          ))}
        </select>
        <ChevronDown size={16} aria-hidden="true" />
      </span>
    </label>
  );
}

function ScenarioSelect({
  scenarios,
  value,
  disabled,
  onChange
}: {
  scenarios: ScenarioSummary[];
  value: string;
  disabled: boolean;
  onChange: (scenarioId: string) => void;
}): React.JSX.Element {
  return (
    <label className="field field--scenario">
      <span className="field-label">Scenario</span>
      <span className="select-shell">
        <select
          name="scenario"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          {scenarios.map((scenario) => (
            <option key={scenario.id} value={scenario.id}>
              {scenario.name}
            </option>
          ))}
        </select>
        <ChevronDown size={16} aria-hidden="true" />
      </span>
    </label>
  );
}

function CommandBand({
  catalog,
  selectedScenario,
  scenarioId,
  controller,
  catalogStatus,
  playbackStatus,
  canReplay,
  onScenarioChange,
  onControllerChange,
  onRun,
  onReplay
}: {
  catalog: DemoCatalog | null;
  selectedScenario?: ScenarioSummary;
  scenarioId: string;
  controller: Controller;
  catalogStatus: CatalogStatus;
  playbackStatus: PlaybackStatus;
  canReplay: boolean;
  onScenarioChange: (scenarioId: string) => void;
  onControllerChange: (controller: Controller) => void;
  onRun: () => void;
  onReplay: () => void;
}): React.JSX.Element {
  const isBusy =
    playbackStatus === "requesting" || playbackStatus === "playing";
  const controlsDisabled = catalogStatus !== "ready" || isBusy;

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    onRun();
  }

  return (
    <section className="command-band" aria-labelledby="dashboard-title">
      <div className="command-context">
        <p className="eyebrow">Governed PR review</p>
        <h1 id="dashboard-title">Execution control</h1>
        <p className="scenario-description">
          {catalogStatus === "loading"
            ? "Loading scripted fixture scenarios..."
            : selectedScenario?.description ??
              "Catalog response contains no runnable scenario."}
        </p>
        {selectedScenario &&
          (selectedScenario.repository || selectedScenario.pullRequest) && (
            <p className="scenario-reference">
              <GitPullRequest size={14} aria-hidden="true" />
              {[selectedScenario.repository, selectedScenario.pullRequest]
                .filter(Boolean)
                .join(" / ")}
              </p>
          )}
        {catalog && (
          <TruthDisclosure truth={catalog} label="Catalog truth and rate card" />
        )}
      </div>

      <form className="command-controls" onSubmit={submit}>
        <ScenarioSelect
          scenarios={catalog?.scenarios ?? []}
          value={scenarioId}
          disabled={controlsDisabled}
          onChange={onScenarioChange}
        />
        <ControllerSelect
          value={controller}
          disabled={controlsDisabled}
          onChange={onControllerChange}
        />
        <div className="command-actions">
          <button
            className="button button--primary"
            type="submit"
            disabled={controlsDisabled || !scenarioId}
          >
            {isBusy ? (
              <RefreshCw className="spin" size={17} aria-hidden="true" />
            ) : (
              <Play size={17} fill="currentColor" aria-hidden="true" />
            )}
            {playbackStatus === "requesting"
              ? "Loading fixture"
              : playbackStatus === "playing"
                ? "Playing trace"
                : "Play scripted trace"}
          </button>
          {canReplay && (
            <button
              className="button button--secondary"
              type="button"
              onClick={onReplay}
            >
              <RotateCcw size={17} aria-hidden="true" />
              Replay scripted trace
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

function LoadingState(): React.JSX.Element {
  return (
    <section className="state-view" aria-label="Loading catalog" aria-live="polite">
      <div className="state-icon state-icon--loading" aria-hidden="true">
        <RefreshCw className="spin" size={23} />
      </div>
      <p className="state-kicker">CATALOG</p>
      <h2>Loading demo operations</h2>
      <div className="loading-rail" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </section>
  );
}

function ReadyState({
  scenario,
  controller
}: {
  scenario?: ScenarioSummary;
  controller: Controller;
}): React.JSX.Element {
  return (
    <section className="state-view state-view--ready" aria-labelledby="ready-title">
      <div className="state-icon" aria-hidden="true">
        <Gauge size={24} />
      </div>
      <p className="state-kicker">READY</p>
      <h2 id="ready-title">{scenario?.name ?? "No scenario available"}</h2>
      <div className="ready-stages" aria-label="Run staging status">
        <span>
          <CheckCircle2 size={15} aria-hidden="true" />
          Fixture-authored scenario
        </span>
        <span>
          <CheckCircle2 size={15} aria-hidden="true" />
          {CONTROLLER_LABELS[controller]}
        </span>
        <span>
          <LockKeyhole size={15} aria-hidden="true" />
          Scripted rubric outcome
        </span>
      </div>
    </section>
  );
}

function ErrorState({
  title,
  message,
  onRetry
}: {
  title: string;
  message: string;
  onRetry: () => void;
}): React.JSX.Element {
  return (
    <section className="state-view state-view--error" role="alert">
      <div className="state-icon state-icon--error" aria-hidden="true">
        <TriangleAlert size={23} />
      </div>
      <p className="state-kicker">REQUEST FAILED</p>
      <h2>{title}</h2>
      <p className="state-message">{message}</p>
      <button className="button button--secondary" type="button" onClick={onRetry}>
        <RefreshCw size={16} aria-hidden="true" />
        Retry
      </button>
    </section>
  );
}

function StartingState(): React.JSX.Element {
  return (
    <section className="state-view" aria-live="polite">
      <div className="state-icon state-icon--loading" aria-hidden="true">
        <RefreshCw className="spin" size={23} />
      </div>
      <p className="state-kicker">SCRIPTED TRACE</p>
      <h2>Loading deterministic fixture</h2>
      <div className="admission-steps" aria-hidden="true">
        <span className="is-active" />
        <span />
        <span />
        <span />
      </div>
    </section>
  );
}

function AccountingBand({
  trace,
  metrics,
  risk,
  playbackStatus,
  isReplay
}: {
  trace: RunTrace;
  metrics: EventMetrics;
  risk: RiskBand;
  playbackStatus: PlaybackStatus;
  isReplay: boolean;
}): React.JSX.Element {
  const ceiling = Math.max(1, trace.policy.ceilingMicros);
  const settled = Math.max(0, metrics.settledMicros);
  const reserved = Math.max(0, metrics.reservedMicros);
  const finalReserve = Math.max(0, metrics.finalReserveMicros);
  const available = Math.max(0, ceiling - settled - reserved - finalReserve);
  const percentage = (value: number): string =>
    `${Math.min(100, (value / ceiling) * 100)}%`;
  const statusLabel =
    playbackStatus === "playing" ? "PLAYING TRACE" : "TRACE COMPLETE";

  return (
    <section className="accounting-band" aria-labelledby="accounting-title">
      <div className="accounting-heading">
        <div>
          <p className="eyebrow">Policy &amp; accounting</p>
          <h2 id="accounting-title">{trace.scenario.name}</h2>
        </div>
        <div className="run-identity">
          <span>{isReplay ? "CORE REPLAY" : "CORE-ENFORCED FIXTURE"}</span>
          <span>{statusLabel}</span>
          <code>{trace.id}</code>
        </div>
      </div>

      <dl className="accounting-metrics">
        <div>
          <dt>Task policy</dt>
          <dd>{trace.policy.name}</dd>
        </div>
        <div>
          <dt>Application ceiling</dt>
          <dd>{formatMoney(ceiling)}</dd>
        </div>
        <div>
          <dt>Settled cost</dt>
          <dd>{formatMoney(settled)}</dd>
        </div>
        <div>
          <dt>Outstanding reserve</dt>
          <dd>{formatMoney(reserved)}</dd>
        </div>
        <div>
          <dt>Final reserve</dt>
          <dd>{formatMoney(finalReserve)}</dd>
        </div>
        <div>
          <dt>Risk band</dt>
          <dd>
            <span className={`risk-label risk-label--${riskClass(risk)}`}>
              {risk.replace("_", " ")}
            </span>
          </dd>
        </div>
      </dl>

      <figure className="budget-figure">
        <figcaption>
          <span>Budget allocation</span>
          <span>{formatMoney(available)} unallocated</span>
        </figcaption>
        <div
          className="budget-track"
          role="progressbar"
          aria-label="Committed application budget"
          aria-valuemin={0}
          aria-valuemax={ceiling}
          aria-valuenow={Math.min(ceiling, settled + reserved + finalReserve)}
        >
          <span
            className="budget-segment budget-segment--settled"
            style={{ width: percentage(settled) }}
          />
          <span
            className="budget-segment budget-segment--reserved"
            style={{ width: percentage(reserved) }}
          />
          <span
            className="budget-segment budget-segment--protected"
            style={{ width: percentage(finalReserve) }}
          />
          <span className="budget-limit" aria-hidden="true" />
        </div>
        <div className="budget-legend" aria-hidden="true">
          <span className="legend-settled">Settled</span>
          <span className="legend-reserved">Next call</span>
          <span className="legend-protected">Protected answer</span>
          <span className="legend-available">Available</span>
        </div>
      </figure>
    </section>
  );
}

function TimelineEvent({
  event,
  active
}: {
  event: RunEvent;
  active: boolean;
}): React.JSX.Element {
  const Icon = eventIcon(event.kind);
  const action = event.action ? actionParts(event.action) : null;

  return (
    <li className={`timeline-event${active ? " is-active" : ""}`}>
      <div className="event-rail" aria-hidden="true">
        <span className="event-icon">
          <Icon size={16} />
        </span>
      </div>
      <article>
        <header className="event-header">
          <div className="event-classification">
            <span>{event.phase}</span>
            <span>{event.kind}</span>
            <time>{formatOffset(event.offsetMs)}</time>
          </div>
          <span className={`risk-label risk-label--${riskClass(event.risk)}`}>
            {event.risk.replace("_", " ")}
          </span>
        </header>
        <h3>{event.title}</h3>
        <p>{event.detail}</p>
        <dl className="event-metrics">
          <div>
            <dt>Settled</dt>
            <dd>{formatMoney(event.metrics.settledMicros)}</dd>
          </div>
          <div>
            <dt>Reserved</dt>
            <dd>{formatMoney(event.metrics.reservedMicros)}</dd>
          </div>
          <div>
            <dt>Context</dt>
            <dd>{formatNumber(event.metrics.contextTokens)} tok</dd>
          </div>
          <div>
            <dt>I / O</dt>
            <dd>
              {formatNumber(event.metrics.inputTokens)} /{" "}
              {formatNumber(event.metrics.outputTokens)}
            </dd>
          </div>
          {event.requestAdmission && (
            <div className="event-metrics__admission">
              <dt>Core output cap</dt>
              <dd>
                {formatNumber(
                  event.requestAdmission.admittedMaxOutputTokens
                )}{" "}
                /{" "}
                {formatNumber(
                  event.requestAdmission.requestedMaxOutputTokens
                )}{" "}
                tok
              </dd>
            </div>
          )}
        </dl>
        {action && (
          <div className={`event-action event-action--${action.mode}`}>
            <span>{action.label}</span>
            <p>{action.detail}</p>
          </div>
        )}
      </article>
    </li>
  );
}

function TraceTimeline({
  events,
  totalEvents,
  isPlaying
}: {
  events: RunEvent[];
  totalEvents: number;
  isPlaying: boolean;
}): React.JSX.Element {
  return (
    <section className="timeline-panel" aria-labelledby="timeline-title">
      <header className="panel-heading">
        <div>
          <p className="eyebrow">Ordered trace</p>
          <h2 id="timeline-title">Execution timeline</h2>
        </div>
        <span className="event-count">
          {events.length} / {totalEvents} events
        </span>
      </header>

      <ol className="timeline-list" aria-live="polite">
        {events.map((event, index) => (
          <TimelineEvent
            key={event.id}
            event={event}
            active={isPlaying && index === events.length - 1}
          />
        ))}
        {isPlaying && (
          <li className="timeline-pending" aria-label="Waiting for next event">
            <span aria-hidden="true">
              <RefreshCw className="spin" size={14} />
            </span>
            Playing next fixture event
          </li>
        )}
      </ol>
    </section>
  );
}

function DecisionPanel({
  trace,
  visibleEvents,
  currentRisk,
  metrics
}: {
  trace: RunTrace;
  visibleEvents: RunEvent[];
  currentRisk: RiskBand;
  metrics: EventMetrics;
}): React.JSX.Element {
  const driverEvent = latestEventWith(
    visibleEvents,
    (event) => Boolean(event.drivers?.length)
  );
  const actionEvent = latestEventWith(
    visibleEvents,
    (event) => event.action !== undefined
  );
  const action = actionEvent?.action ? actionParts(actionEvent.action) : null;
  const isAtRisk = currentRisk === "AT_RISK";
  const isShadow = trace.controller === "shadow";

  return (
    <aside className="decision-panel" aria-labelledby="decision-title">
      <header className="panel-heading">
        <div>
          <p className="eyebrow">Risk &amp; decision</p>
          <h2 id="decision-title">Control checkpoint</h2>
        </div>
        <span className="mode-label">
          {isShadow
            ? "NON-ACTING SHADOW"
            : trace.controller === "static"
              ? "STATIC RULES"
              : "HARD CAP"}
        </span>
      </header>

      <div className={`risk-summary risk-summary--${riskClass(currentRisk)}`}>
        <span className="risk-icon" aria-hidden="true">
          {isAtRisk ? <TriangleAlert size={21} /> : <Gauge size={21} />}
        </span>
        <div>
          <span>Current risk</span>
          <strong>{currentRisk.replace("_", " ")}</strong>
        </div>
        <span className="context-count">
          {formatNumber(metrics.contextTokens)}
          <small>context tok</small>
        </span>
      </div>

      <section className="decision-section" aria-labelledby="drivers-title">
        <h3 id="drivers-title">
          <FileSearch size={16} aria-hidden="true" />
          Observed drivers
        </h3>
        {driverEvent?.drivers?.length ? (
          <ul className="driver-list">
            {driverEvent.drivers.map((driver) => (
              <li key={driver}>{driver}</li>
            ))}
          </ul>
        ) : (
          <p className="quiet-value">No elevated drivers recorded.</p>
        )}
      </section>

      <section className="decision-section" aria-labelledby="action-title">
        <h3 id="action-title">
          <ShieldCheck size={16} aria-hidden="true" />
          {action?.execution === "RECOMMENDED"
            ? "Shadow annotation"
            : "Applied deterministic action"}
        </h3>
        {action ? (
          <div className="decision-action">
            <span>{action.label}</span>
            <p>{action.detail}</p>
          </div>
        ) : (
          <p className="quiet-value">No control action at this checkpoint.</p>
        )}
      </section>

      {isShadow && (
        <p className="shadow-disclosure">
          Cost and quality equal static by construction. Predictive lift is
          unmeasured; shadow annotations do not act.
        </p>
      )}

      <div className="reserve-lock">
        <LockKeyhole size={16} aria-hidden="true" />
        <span>
          Final-answer reserve
          <strong>{formatMoney(metrics.finalReserveMicros)}</strong>
        </span>
      </div>
    </aside>
  );
}

function FinalReceipt({
  trace,
  isReplay
}: {
  trace: RunTrace;
  isReplay: boolean;
}): React.JSX.Element {
  const passed = trace.quality.gate === "PASS";

  return (
    <section className="receipt" aria-labelledby="receipt-title">
      <header className="receipt-heading">
        <span
          className={`receipt-icon ${passed ? "is-pass" : "is-fail"}`}
          aria-hidden="true"
        >
          {passed ? <CheckCircle2 size={24} /> : <XCircle size={24} />}
        </span>
        <div>
          <p className="eyebrow">Final receipt</p>
          <h2 id="receipt-title">{trace.summary.outcome}</h2>
        </div>
        <div className={`gate-result ${passed ? "is-pass" : "is-fail"}`}>
          <span>QUALITY GATE</span>
          <strong>{trace.quality.gate}</strong>
        </div>
      </header>

      <dl className="receipt-metrics">
        <div>
          <dt>Incurred synthetic spend</dt>
          <dd>{formatMoney(trace.summary.settledMicros)}</dd>
        </div>
        <div>
          <dt>Quality score</dt>
          <dd>{formatScore(trace.quality.score)}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{formatDuration(trace.summary.durationMs)}</dd>
        </div>
        <div>
          <dt>Input / output</dt>
          <dd>
            {formatNumber(trace.summary.inputTokens)} /{" "}
            {formatNumber(trace.summary.outputTokens)}
          </dd>
        </div>
        <div>
          <dt>Interventions</dt>
          <dd>{formatNumber(trace.summary.interventions)}</dd>
        </div>
        <div>
          <dt>Trace provenance</dt>
          <dd>
            {isReplay
              ? "GOVERNOR CORE REPLAY / 0 EXTERNAL CALLS"
              : "GOVERNOR CORE / SCRIPTED INPUTS / 0 EXTERNAL CALLS"}
          </dd>
        </div>
      </dl>
      <div className="receipt-disclosure">
        <strong>{trace.provenance.costBasis}</strong>
        <span>
          Pinned synthetic rate: {rateCardSummary(trace.rateCard)}. Not billed.
        </span>
        <span>{trace.rateCard.disclosure}</span>
      </div>
    </section>
  );
}

function ComparisonArm({
  row,
  maxCost
}: {
  row: BenchmarkRow;
  maxCost: number;
}): React.JSX.Element {
  const passed = row.qualityGate === "PASS";
  const width = `${Math.max(
    4,
    (row.totalCostMicros / Math.max(1, maxCost)) * 100
  )}%`;
  const scoreLabel =
    row.scope === "aggregate" ? "Aggregate pass rate" : "Fixture rubric score";
  const score =
    row.scope === "aggregate"
      ? row.aggregatePassRate
      : row.fixtureRubricScore;

  return (
    <article
      className={`comparison-arm ${
        row.controller === "static" ? "comparison-arm--reference" : ""
      }`}
    >
      <header>
        <div>
          <span className="arm-kicker">
            {row.controller === "shadow"
              ? "NON-ACTING SHADOW"
              : "SCRIPTED ARM"}
          </span>
          <h3>{row.label || CONTROLLER_LABELS[row.controller]}</h3>
        </div>
        <span className={`gate-pill ${passed ? "is-pass" : "is-fail"}`}>
          {passed ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
          {row.qualityGate}
        </span>
      </header>

      <div className="cost-result">
        <span>Incurred synthetic spend</span>
        <strong>{formatMoney(row.totalCostMicros)}</strong>
        <div className="comparison-cost-track" aria-hidden="true">
          <span style={{ width }} />
        </div>
        <small>
          {row.eligibleForCostComparison
            ? "Eligible for scripted cost comparison"
            : "Excluded from comparison; synthetic spend was still incurred"}
        </small>
      </div>

      <dl className="arm-metrics">
        <div>
          <dt>{scoreLabel}</dt>
          <dd>{score === null ? "N/A" : formatScore(score)}</dd>
        </div>
        <div>
          <dt>Critical misses</dt>
          <dd>{row.criticalMisses}</dd>
        </div>
        <div>
          <dt>{row.scope === "aggregate" ? "Passed runs" : "Fixture outcome"}</dt>
          <dd>
            {row.passedRuns}/{row.totalRuns}
          </dd>
        </div>
        <div>
          <dt>Policy stops</dt>
          <dd>{row.policyStops}</dd>
        </div>
        <div>
          <dt>Interventions</dt>
          <dd>{row.interventions ?? "N/A"}</dd>
        </div>
        <div>
          <dt>Cost comparison</dt>
          <dd>
            {row.eligibleForCostComparison ? "ELIGIBLE" : "EXCLUDED"}
          </dd>
        </div>
      </dl>
      {row.controller === "shadow" && (
        <p className="arm-disclosure">
          Equal to static by construction; predictive lift unmeasured.
        </p>
      )}
    </article>
  );
}

function QualityComparison({
  rows
}: {
  rows: BenchmarkRow[];
}): React.JSX.Element {
  const orderedRows = [...rows].sort(
    (left, right) =>
      CONTROLLER_ORDER.indexOf(left.controller) -
      CONTROLLER_ORDER.indexOf(right.controller)
  );
  const maxCost = Math.max(
    1,
    ...orderedRows.map((row) => row.totalCostMicros)
  );

  return (
    <section className="comparison-section" aria-labelledby="comparison-title">
      <header className="comparison-heading">
        <div>
          <p className="eyebrow">Scripted mechanism comparison</p>
          <h2 id="comparison-title">Quality-gated comparison</h2>
        </div>
        <p>
          Every arm shows incurred synthetic spend. Failed fixture outcomes are
          excluded from comparison. Static and shadow are equal by construction;
          predictive lift is unmeasured.
        </p>
      </header>
      <div className="comparison-grid">
        {orderedRows.map((row) => (
          <ComparisonArm key={row.controller} row={row} maxCost={maxCost} />
        ))}
      </div>
    </section>
  );
}

function TraceDashboard({
  trace,
  visibleCount,
  playbackStatus,
  isReplay,
  benchmark
}: {
  trace: RunTrace;
  visibleCount: number;
  playbackStatus: PlaybackStatus;
  isReplay: boolean;
  benchmark: BenchmarkRow[];
}): React.JSX.Element {
  const visibleEvents = trace.events.slice(0, visibleCount);
  const currentEvent = visibleEvents[visibleEvents.length - 1];
  const currentMetrics: EventMetrics = currentEvent?.metrics ?? {
    settledMicros: 0,
    reservedMicros: 0,
    finalReserveMicros: trace.policy.finalReserveMicros,
    inputTokens: 0,
    outputTokens: 0,
    contextTokens: 0
  };
  const currentRisk = currentEvent?.risk ?? "SAFE";
  const isComplete = playbackStatus === "complete";
  const comparison = trace.comparison.length ? trace.comparison : benchmark;

  return (
    <div className="trace-dashboard">
      <AccountingBand
        trace={trace}
        metrics={currentMetrics}
        risk={currentRisk}
        playbackStatus={playbackStatus}
        isReplay={isReplay}
      />

      <div className="execution-grid">
        <TraceTimeline
          events={visibleEvents}
          totalEvents={trace.events.length}
          isPlaying={playbackStatus === "playing"}
        />
        <DecisionPanel
          trace={trace}
          visibleEvents={visibleEvents}
          currentRisk={currentRisk}
          metrics={currentMetrics}
        />
      </div>

      {isComplete && (
        <>
          <FinalReceipt trace={trace} isReplay={isReplay} />
          <QualityComparison rows={comparison} />
        </>
      )}
    </div>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "The request could not be completed.";
}

export default function App(): React.JSX.Element {
  const [catalog, setCatalog] = useState<DemoCatalog | null>(null);
  const [catalogStatus, setCatalogStatus] =
    useState<CatalogStatus>("loading");
  const [catalogError, setCatalogError] = useState("");
  const [catalogReload, setCatalogReload] = useState(0);
  const [scenarioId, setScenarioId] = useState("");
  const [controller, setController] = useState<Controller>("static");
  const [trace, setTrace] = useState<RunTrace | null>(null);
  const [playbackStatus, setPlaybackStatus] =
    useState<PlaybackStatus>("empty");
  const [visibleCount, setVisibleCount] = useState(0);
  const [playbackVersion, setPlaybackVersion] = useState(0);
  const [isReplay, setIsReplay] = useState(false);
  const [runError, setRunError] = useState("");
  const runAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const abortController = new AbortController();
    setCatalogStatus("loading");
    setCatalogError("");

    void getDemoCatalog(abortController.signal)
      .then((response) => {
        setCatalog(response);
        setScenarioId((current) =>
          response.scenarios.some((scenario) => scenario.id === current)
            ? current
            : (response.scenarios[0]?.id ?? "")
        );
        setCatalogStatus("ready");
      })
      .catch((error: unknown) => {
        if (abortController.signal.aborted) {
          return;
        }
        setCatalog(null);
        setCatalogError(errorMessage(error));
        setCatalogStatus("error");
      });

    return () => abortController.abort();
  }, [catalogReload]);

  useEffect(
    () => () => {
      runAbortRef.current?.abort();
    },
    []
  );

  useEffect(() => {
    if (!trace || playbackStatus !== "playing") {
      return;
    }

    if (trace.events.length === 0) {
      setPlaybackStatus("complete");
      return;
    }

    const timers = trace.events.map((event, index) =>
      window.setTimeout(
        () => setVisibleCount(index + 1),
        Math.max(0, event.offsetMs)
      )
    );
    const finalOffset = Math.max(
      0,
      trace.events[trace.events.length - 1]?.offsetMs ?? 0
    );
    const completionTimer = window.setTimeout(
      () => setPlaybackStatus("complete"),
      finalOffset + 300
    );

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      window.clearTimeout(completionTimer);
    };
  }, [playbackStatus, playbackVersion, trace]);

  const selectedScenario = useMemo(
    () => catalog?.scenarios.find((scenario) => scenario.id === scenarioId),
    [catalog, scenarioId]
  );

  const runDemo = useCallback(async (): Promise<void> => {
    if (!scenarioId || catalogStatus !== "ready") {
      return;
    }

    runAbortRef.current?.abort();
    const abortController = new AbortController();
    runAbortRef.current = abortController;
    setTrace(null);
    setVisibleCount(0);
    setIsReplay(false);
    setRunError("");
    setPlaybackStatus("requesting");

    try {
      const response = await createDemoRun(
        { scenarioId, controller },
        abortController.signal
      );
      setTrace({
        ...response,
        events: [...response.events].sort(
          (left, right) => left.offsetMs - right.offsetMs
        )
      });
      setPlaybackStatus("playing");
      setPlaybackVersion((version) => version + 1);
    } catch (error: unknown) {
      if (abortController.signal.aborted) {
        return;
      }
      setRunError(errorMessage(error));
      setPlaybackStatus("error");
    } finally {
      if (runAbortRef.current === abortController) {
        runAbortRef.current = null;
      }
    }
  }, [catalogStatus, controller, scenarioId]);

  const replay = useCallback((): void => {
    if (!trace) {
      return;
    }
    setVisibleCount(0);
    setIsReplay(true);
    setPlaybackStatus("playing");
    setPlaybackVersion((version) => version + 1);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [trace]);

  let content: React.JSX.Element;

  if (catalogStatus === "loading") {
    content = <LoadingState />;
  } else if (catalogStatus === "error") {
    content = (
      <ErrorState
        title="Demo catalog unavailable"
        message={catalogError}
        onRetry={() => setCatalogReload((value) => value + 1)}
      />
    );
  } else if (playbackStatus === "requesting") {
    content = <StartingState />;
  } else if (playbackStatus === "error") {
    content = (
      <ErrorState
        title="Demo run unavailable"
        message={runError}
        onRetry={() => void runDemo()}
      />
    );
  } else if (trace) {
    content = (
      <TraceDashboard
        trace={trace}
        visibleCount={visibleCount}
        playbackStatus={playbackStatus}
        isReplay={isReplay}
        benchmark={catalog?.benchmark ?? []}
      />
    );
  } else {
    content = (
      <ReadyState scenario={selectedScenario} controller={controller} />
    );
  }

  return (
    <div className="app-shell">
      <AppHeader playbackStatus={playbackStatus} />
      <main className="dashboard-main">
        <CommandBand
          catalog={catalog}
          selectedScenario={selectedScenario}
          scenarioId={scenarioId}
          controller={controller}
          catalogStatus={catalogStatus}
          playbackStatus={playbackStatus}
          canReplay={Boolean(trace && playbackStatus === "complete")}
          onScenarioChange={setScenarioId}
          onControllerChange={setController}
          onRun={() => void runDemo()}
          onReplay={replay}
        />
        {content}
      </main>
      <footer className="app-footer">
        <span>Governor POC</span>
        <span>Pinned synthetic list-price calculations. Not billed.</span>
      </footer>
    </div>
  );
}
