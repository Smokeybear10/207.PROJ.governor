import {
  ArrowLeft,
  Check,
  CheckCircle2,
  Columns3,
  Download,
  LayoutDashboard,
  RotateCcw,
  X
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties
} from "react";

type DirectionCategory = "Control" | "Financial" | "Workflow" | "Technical";
type FilterCategory = "All" | DirectionCategory;
type PreviewStyle =
  | "quiet"
  | "boundary"
  | "allocation"
  | "steps"
  | "ledger"
  | "threshold"
  | "relay"
  | "terminal"
  | "blocks"
  | "minimal";
type WordmarkStyle =
  | "neutral"
  | "condensed"
  | "editorial"
  | "mono"
  | "humanist";

type BrandDirection = {
  id: string;
  number: string;
  name: string;
  category: DirectionCategory;
  attitude: string;
  asset: string;
  tagline: string;
  rationale: string;
  tradeoff: string;
  typeface: string;
  wordmark: WordmarkStyle;
  preview: PreviewStyle;
  recommended?: boolean;
  theme: {
    canvas: string;
    surface: string;
    ink: string;
    muted: string;
    accent: string;
    secondary: string;
    reserve: string;
    border: string;
  };
};

const STORAGE_KEY = "governor-brand-direction";
const FILTERS: FilterCategory[] = [
  "All",
  "Control",
  "Financial",
  "Workflow",
  "Technical"
];

const DIRECTIONS: BrandDirection[] = [
  {
    id: "aperture",
    number: "01",
    name: "Aperture G",
    category: "Control",
    attitude: "Quiet infrastructure",
    asset: "/brand/governor-aperture.svg",
    tagline: "Control before cost",
    rationale:
      "The G terminates in an admission gate, connecting the name to the product's core decision.",
    tradeoff: "Balanced and ownable; the safest master-brand direction.",
    typeface: "Neo-grotesk sans",
    wordmark: "neutral",
    preview: "quiet",
    recommended: true,
    theme: {
      canvas: "#f2f5f3",
      surface: "#ffffff",
      ink: "#14231f",
      muted: "#61706a",
      accent: "#18a875",
      secondary: "#3f6fa8",
      reserve: "#e29a24",
      border: "#d6dfdb"
    }
  },
  {
    id: "guardrails",
    number: "02",
    name: "Guardrails",
    category: "Control",
    attitude: "Explicit boundary",
    asset: "/brand/governor-guardrails.svg",
    tagline: "Stay inside policy",
    rationale:
      "A request moves through a visible policy boundary, making admission control immediately legible.",
    tradeoff: "Most literal product story; less distinctive as a standalone mark.",
    typeface: "Condensed utility sans",
    wordmark: "condensed",
    preview: "boundary",
    theme: {
      canvas: "#eef3f1",
      surface: "#fbfdfc",
      ink: "#17231f",
      muted: "#62716b",
      accent: "#0f9c6c",
      secondary: "#315f9f",
      reserve: "#d18b18",
      border: "#9fb2aa"
    }
  },
  {
    id: "reserve-ring",
    number: "03",
    name: "Reserve Ring",
    category: "Financial",
    attitude: "Measured allocation",
    asset: "/brand/governor-reserve-ring.svg",
    tagline: "Spend with a reserve",
    rationale:
      "The ring maps settled, reserved, and available budget into one continuous financial loop.",
    tradeoff: "Excellent product metaphor; can read as an analytics product.",
    typeface: "Humanist sans",
    wordmark: "humanist",
    preview: "allocation",
    theme: {
      canvas: "#eef1f6",
      surface: "#ffffff",
      ink: "#17212b",
      muted: "#66717d",
      accent: "#3f6fa8",
      secondary: "#12a476",
      reserve: "#d99a27",
      border: "#ccd5df"
    }
  },
  {
    id: "checkpoint",
    number: "04",
    name: "Checkpoint",
    category: "Workflow",
    attitude: "Progressive control",
    asset: "/brand/governor-checkpoint.svg",
    tagline: "Control every step",
    rationale:
      "A governed run advances through visible checkpoints instead of consuming budget as one opaque call.",
    tradeoff: "Strong workflow identity; less universal outside multi-step agents.",
    typeface: "Rounded humanist sans",
    wordmark: "humanist",
    preview: "steps",
    theme: {
      canvas: "#f7f2e8",
      surface: "#fffdf8",
      ink: "#22251f",
      muted: "#716e64",
      accent: "#dc941d",
      secondary: "#347864",
      reserve: "#c4653d",
      border: "#ddd5c5"
    }
  },
  {
    id: "ledger",
    number: "05",
    name: "Ledger G",
    category: "Technical",
    attitude: "Auditable system",
    asset: "/brand/governor-ledger.svg",
    tagline: "Every dollar accounted for",
    rationale:
      "Ledger lines live inside the monogram, foregrounding exact accounting and traceability.",
    tradeoff: "Credible and technical; the detail drops away at very small sizes.",
    typeface: "Editorial serif + mono",
    wordmark: "editorial",
    preview: "ledger",
    theme: {
      canvas: "#eef3ef",
      surface: "#fbfcfa",
      ink: "#16241e",
      muted: "#67746d",
      accent: "#15966c",
      secondary: "#5d6c63",
      reserve: "#ba7d22",
      border: "#cbd7d0"
    }
  },
  {
    id: "threshold",
    number: "06",
    name: "Threshold",
    category: "Financial",
    attitude: "Hard-stop clarity",
    asset: "/brand/governor-threshold.svg",
    tagline: "Know the limit before dispatch",
    rationale:
      "An immovable cap sits above rising spend, expressing the deterministic hard-stop promise.",
    tradeoff: "The clearest policy story, but narrower than the full platform.",
    typeface: "Industrial condensed sans",
    wordmark: "condensed",
    preview: "threshold",
    theme: {
      canvas: "#f7f1ef",
      surface: "#fffdfc",
      ink: "#27201e",
      muted: "#746965",
      accent: "#c84b3d",
      secondary: "#3b6f8f",
      reserve: "#dc941d",
      border: "#dfcfca"
    }
  },
  {
    id: "relay",
    number: "07",
    name: "Relay",
    category: "Workflow",
    attitude: "Adaptive routing",
    asset: "/brand/governor-relay.svg",
    tagline: "Route the next best action",
    rationale:
      "Two execution paths meet at a controlled decision node before the run continues.",
    tradeoff: "Dynamic and agent-native; deemphasizes the financial layer.",
    typeface: "Modern system sans",
    wordmark: "neutral",
    preview: "relay",
    theme: {
      canvas: "#eef5f4",
      surface: "#ffffff",
      ink: "#162323",
      muted: "#607171",
      accent: "#0eaa8d",
      secondary: "#4a66ad",
      reserve: "#db9b26",
      border: "#c8dcda"
    }
  },
  {
    id: "command",
    number: "08",
    name: "Command G",
    category: "Technical",
    attitude: "Developer control",
    asset: "/brand/governor-command.svg",
    tagline: "Policy at the point of execution",
    rationale:
      "An angular G borrows from command-line syntax and positions Governor as runtime infrastructure.",
    tradeoff: "Strong developer appeal; colder for finance and operations teams.",
    typeface: "Monospace",
    wordmark: "mono",
    preview: "terminal",
    theme: {
      canvas: "#151a20",
      surface: "#1d242c",
      ink: "#f2f5f4",
      muted: "#96a4a6",
      accent: "#66d9a8",
      secondary: "#7ca7e8",
      reserve: "#f0b44d",
      border: "#35414a"
    }
  },
  {
    id: "split-reserve",
    number: "09",
    name: "Split Reserve",
    category: "Financial",
    attitude: "Budget architecture",
    asset: "/brand/governor-split-reserve.svg",
    tagline: "Protect what must remain",
    rationale:
      "Stacked allocations make the final-answer reserve a first-class part of every budget.",
    tradeoff: "Distinctive in product UI; the mark is more abstract on its own.",
    typeface: "Precise system sans",
    wordmark: "neutral",
    preview: "blocks",
    theme: {
      canvas: "#f4f3ef",
      surface: "#fffefb",
      ink: "#202620",
      muted: "#70746d",
      accent: "#139b70",
      secondary: "#486d99",
      reserve: "#d89522",
      border: "#dcd9ce"
    }
  },
  {
    id: "open-gate",
    number: "10",
    name: "Open Gate",
    category: "Control",
    attitude: "Radical simplicity",
    asset: "/brand/governor-open-gate.svg",
    tagline: "Admit only what fits",
    rationale:
      "A single request leaves a bounded frame through one controlled opening.",
    tradeoff: "Memorable at small sizes; says less about accounting and workflow.",
    typeface: "Minimal geometric sans",
    wordmark: "neutral",
    preview: "minimal",
    theme: {
      canvas: "#f7f7f4",
      surface: "#ffffff",
      ink: "#1d2421",
      muted: "#737b77",
      accent: "#20a875",
      secondary: "#4a6f8d",
      reserve: "#db9b2d",
      border: "#d7dcd9"
    }
  }
];

function directionStyle(direction: BrandDirection): CSSProperties {
  return {
    "--direction-canvas": direction.theme.canvas,
    "--direction-surface": direction.theme.surface,
    "--direction-ink": direction.theme.ink,
    "--direction-muted": direction.theme.muted,
    "--direction-accent": direction.theme.accent,
    "--direction-secondary": direction.theme.secondary,
    "--direction-reserve": direction.theme.reserve,
    "--direction-border": direction.theme.border
  } as CSSProperties;
}

function BrandPreview({
  direction,
  compact = false
}: {
  direction: BrandDirection;
  compact?: boolean;
}): React.JSX.Element {
  return (
    <div
      className={`studio-preview studio-preview--${direction.preview}${
        compact ? " studio-preview--compact" : ""
      }`}
      style={directionStyle(direction)}
      aria-label={`${direction.name} interface preview`}
    >
      <header className="studio-preview__header">
        <div className="studio-preview__brand">
          <span className="studio-preview__mark">
            <img src={direction.asset} alt="" />
          </span>
          <strong className={`wordmark wordmark--${direction.wordmark}`}>
            Governor
          </strong>
        </div>
        <span className="studio-preview__status">
          <i aria-hidden="true" />
          ADMITTED
        </span>
      </header>

      <div className="studio-preview__body">
        <div className="studio-preview__title">
          <div>
            <span>GOVERNED RUN / PR REVIEW</span>
            <strong>Payment retry policy</strong>
          </div>
          <code>run_01J9</code>
        </div>

        <dl className="studio-preview__metrics">
          <div>
            <dt>Ceiling</dt>
            <dd>$0.075000</dd>
          </div>
          <div>
            <dt>Settled</dt>
            <dd>$0.018600</dd>
          </div>
          <div>
            <dt>Final reserve</dt>
            <dd>$0.012000</dd>
          </div>
          <div>
            <dt>Risk</dt>
            <dd className="is-safe">SAFE</dd>
          </div>
        </dl>

        <div className="studio-preview__budget" aria-hidden="true">
          <span className="is-settled" />
          <span className="is-reserved" />
          <span className="is-protected" />
          <span className="is-open" />
        </div>

        <div className="studio-preview__event">
          <span className="studio-preview__event-icon">
            <Check size={13} strokeWidth={3} />
          </span>
          <div>
            <strong>Request admitted</strong>
            <span>Exact input counted before dispatch</span>
          </div>
          <code>5,000 tok</code>
        </div>
      </div>
    </div>
  );
}

function DirectionCard({
  direction,
  chosen,
  compared,
  compareDisabled,
  onChoose,
  onToggleCompare
}: {
  direction: BrandDirection;
  chosen: boolean;
  compared: boolean;
  compareDisabled: boolean;
  onChoose: () => void;
  onToggleCompare: () => void;
}): React.JSX.Element {
  return (
    <article
      className={`direction-card${chosen ? " is-chosen" : ""}`}
      style={directionStyle(direction)}
    >
      <header className="direction-card__heading">
        <div>
          <span className="direction-card__index">
            {direction.number} / {direction.category.toUpperCase()}
          </span>
          <h2>{direction.name}</h2>
          <p>{direction.attitude}</p>
        </div>
        <label
          className={`compare-check${compared ? " is-checked" : ""}${
            compareDisabled ? " is-disabled" : ""
          }`}
        >
          <input
            type="checkbox"
            checked={compared}
            disabled={compareDisabled}
            onChange={onToggleCompare}
          />
          <span aria-hidden="true">
            {compared && <Check size={13} strokeWidth={3} />}
          </span>
          Compare
        </label>
      </header>

      <div className="direction-card__lockup">
        <span className="direction-card__mark">
          <img src={direction.asset} alt="" />
        </span>
        <div>
          <strong className={`wordmark wordmark--${direction.wordmark}`}>
            Governor
          </strong>
          <span>{direction.tagline}</span>
        </div>
      </div>

      <BrandPreview direction={direction} />

      <div className="direction-card__notes">
        <div>
          <h3>Design thesis</h3>
          <p>{direction.rationale}</p>
          <small>{direction.tradeoff}</small>
        </div>
        <div className="direction-card__system">
          <span>{direction.typeface}</span>
          <div className="direction-swatches" aria-label="Color palette">
            {[
              direction.theme.ink,
              direction.theme.accent,
              direction.theme.secondary,
              direction.theme.reserve,
              direction.theme.canvas
            ].map((color) => (
              <i
                key={color}
                style={{ backgroundColor: color }}
                title={color.toUpperCase()}
              />
            ))}
          </div>
        </div>
      </div>

      <footer className="direction-card__footer">
        {direction.recommended && (
          <span className="recommended-label">
            <CheckCircle2 size={14} />
            Recommended starting point
          </span>
        )}
        <button
          className={`studio-button ${
            chosen ? "studio-button--chosen" : "studio-button--primary"
          }`}
          type="button"
          aria-pressed={chosen}
          onClick={onChoose}
        >
          {chosen ? (
            <>
              <Check size={16} strokeWidth={3} />
              Chosen
            </>
          ) : (
            <>Choose {direction.name}</>
          )}
        </button>
      </footer>
    </article>
  );
}

function ComparisonDialog({
  directions,
  onClose,
  onChoose
}: {
  directions: BrandDirection[];
  onClose: () => void;
  onChoose: (id: string) => void;
}): React.JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return (
    <div className="compare-overlay" role="presentation" onMouseDown={onClose}>
      <section
        className="compare-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="compare-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="compare-dialog__header">
          <div>
            <span>SHORTLIST</span>
            <h2 id="compare-title">Compare in context</h2>
          </div>
          <button
            ref={closeRef}
            className="icon-button"
            type="button"
            title="Close comparison"
            aria-label="Close comparison"
            onClick={onClose}
          >
            <X size={19} />
          </button>
        </header>

        <div
          className={`compare-dialog__grid compare-dialog__grid--${directions.length}`}
        >
          {directions.map((direction) => (
            <article
              key={direction.id}
              className="compare-direction"
              style={directionStyle(direction)}
            >
              <header>
                <span>{direction.number}</span>
                <div>
                  <h3>{direction.name}</h3>
                  <p>{direction.attitude}</p>
                </div>
              </header>
              <BrandPreview direction={direction} compact />
              <p>{direction.rationale}</p>
              <button
                className="studio-button studio-button--primary"
                type="button"
                onClick={() => onChoose(direction.id)}
              >
                Choose {direction.name}
              </button>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

export default function BrandStudio(): React.JSX.Element {
  const [filter, setFilter] = useState<FilterCategory>("All");
  const [chosenId, setChosenId] = useState<string | null>(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return DIRECTIONS.some((direction) => direction.id === stored)
      ? stored
      : null;
  });
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);
  const [notice, setNotice] = useState("");

  const filteredDirections = useMemo(
    () =>
      filter === "All"
        ? DIRECTIONS
        : DIRECTIONS.filter((direction) => direction.category === filter),
    [filter]
  );
  const chosenDirection = DIRECTIONS.find(
    (direction) => direction.id === chosenId
  );
  const comparedDirections = compareIds
    .map((id) => DIRECTIONS.find((direction) => direction.id === id))
    .filter((direction): direction is BrandDirection => Boolean(direction));

  function chooseDirection(id: string): void {
    const direction = DIRECTIONS.find((candidate) => candidate.id === id);
    if (!direction) {
      return;
    }
    setChosenId(id);
    window.localStorage.setItem(STORAGE_KEY, id);
    setNotice(`${direction.name} saved as the current direction.`);
    setCompareOpen(false);
  }

  function clearChoice(): void {
    setChosenId(null);
    window.localStorage.removeItem(STORAGE_KEY);
    setNotice("Saved direction cleared.");
  }

  function toggleCompare(id: string): void {
    setCompareIds((current) => {
      if (current.includes(id)) {
        setNotice("");
        return current.filter((candidate) => candidate !== id);
      }
      if (current.length === 3) {
        setNotice("The comparison is limited to three directions.");
        return current;
      }
      setNotice("");
      return [...current, id];
    });
  }

  function downloadDecision(): void {
    if (!chosenDirection) {
      return;
    }

    const payload = {
      product: "Governor",
      selectedDirection: {
        id: chosenDirection.id,
        name: chosenDirection.name,
        category: chosenDirection.category,
        tagline: chosenDirection.tagline,
        rationale: chosenDirection.rationale,
        tradeoff: chosenDirection.tradeoff,
        typeface: chosenDirection.typeface,
        palette: chosenDirection.theme,
        asset: chosenDirection.asset
      }
    };
    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
      type: "application/json"
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `governor-${chosenDirection.id}-decision.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className={`studio-shell${chosenDirection ? " has-decision" : ""}`}>
      <header className="studio-header">
        <div className="studio-header__inner">
          <a className="studio-product" href="/" aria-label="Governor dashboard">
            <img src="/brand/governor-mark.svg" alt="" />
            <span>
              <strong>Governor</strong>
              <small>Brand studio</small>
            </span>
          </a>
          <a className="studio-dashboard-link" href="/">
            <LayoutDashboard size={16} />
            Operations dashboard
          </a>
        </div>
      </header>

      <main className="studio-main">
        <section className="studio-intro" aria-labelledby="studio-title">
          <div>
            <span className="studio-eyebrow">IDENTITY REVIEW / 10 DIRECTIONS</span>
            <h1 id="studio-title">Choose Governor&apos;s visual direction.</h1>
            <p>
              Ten identity systems, each shown against the same governed-run
              interface.
            </p>
          </div>
          <aside className="current-decision" aria-live="polite">
            <span>CURRENT DECISION</span>
            {chosenDirection ? (
              <div>
                <img src={chosenDirection.asset} alt="" />
                <p>
                  <strong>{chosenDirection.name}</strong>
                  <small>Saved in this browser</small>
                </p>
                <CheckCircle2 size={19} />
              </div>
            ) : (
              <p className="current-decision__empty">No direction chosen</p>
            )}
          </aside>
        </section>

        <section className="studio-toolbar" aria-label="Design filters">
          <div className="studio-segments" role="tablist" aria-label="Category">
            {FILTERS.map((category) => (
              <button
                key={category}
                type="button"
                role="tab"
                aria-selected={filter === category}
                className={filter === category ? "is-active" : ""}
                onClick={() => setFilter(category)}
              >
                {category}
                <span>
                  {category === "All"
                    ? DIRECTIONS.length
                    : DIRECTIONS.filter(
                        (direction) => direction.category === category
                      ).length}
                </span>
              </button>
            ))}
          </div>
          <button
            className="studio-button studio-button--secondary"
            type="button"
            disabled={compareIds.length < 2}
            onClick={() => setCompareOpen(true)}
          >
            <Columns3 size={17} />
            Compare
            {compareIds.length > 0 && <span>{compareIds.length}</span>}
          </button>
        </section>

        <p className="studio-notice" aria-live="polite">
          {notice}
        </p>

        <section className="direction-grid" aria-label="Brand directions">
          {filteredDirections.map((direction) => {
            const compared = compareIds.includes(direction.id);
            return (
              <DirectionCard
                key={direction.id}
                direction={direction}
                chosen={direction.id === chosenId}
                compared={compared}
                compareDisabled={!compared && compareIds.length === 3}
                onChoose={() => chooseDirection(direction.id)}
                onToggleCompare={() => toggleCompare(direction.id)}
              />
            );
          })}
        </section>
      </main>

      <footer className="studio-footer">
        <a href="/">
          <ArrowLeft size={15} />
          Governor operations
        </a>
        <span>Brand study v2 / July 2026</span>
      </footer>

      {chosenDirection && (
        <div className="decision-bar" aria-label="Saved brand direction">
          <div className="decision-bar__inner">
            <img src={chosenDirection.asset} alt="" />
            <p>
              <span>CHOSEN DIRECTION</span>
              <strong>{chosenDirection.name}</strong>
            </p>
            <div className="decision-bar__actions">
              <button
                className="studio-button studio-button--quiet"
                type="button"
                onClick={clearChoice}
              >
                <RotateCcw size={16} />
                Clear
              </button>
              <button
                className="studio-button studio-button--primary"
                type="button"
                onClick={downloadDecision}
              >
                <Download size={16} />
                Download decision
              </button>
            </div>
          </div>
        </div>
      )}

      {compareOpen && (
        <ComparisonDialog
          directions={comparedDirections}
          onClose={() => setCompareOpen(false)}
          onChoose={chooseDirection}
        />
      )}
    </div>
  );
}
