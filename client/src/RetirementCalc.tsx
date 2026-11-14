import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
Area,
Bar,
BarChart,
CartesianGrid,
ComposedChart,
Legend,
Line,
LineChart,
ResponsiveContainer,
Tooltip,
XAxis,
YAxis,
} from "recharts";
import { api, type ApiResponse } from "./api";
import { Explainer, ExplainerInfoTip } from "./Explainer";
import { FoldChevron } from "./FoldChevron";
import type { RothSectionId } from "./RothConversion";
import { usePersistedFold } from "./foldState";
import { usePersistedChoice } from "./persistedChoice";
import {
HISTORICAL,
HISTORICAL_SOURCE_NAME,
HISTORICAL_SOURCE_URL,
} from "./retirementData";
// The simulation engines live server-side (shared with the
// accuracy self-check) — see server/src/retirementEngines.ts.
import {
blendedExpected,
blendedVol,
buildSimInputs,
displayedMoneyDeltaCents,
displayedRateDeltaPoints,
effectiveGuardrails,
effectivePhased,
EXPECTED_RETURN_DEFAULT,
EXTRA_INCOME_DEFAULT_CENTS,
EXTRA_INCOME_START_AGE_DEFAULT,
GUARDRAILS_ADJUSTMENT_DEFAULT,
GUARDRAILS_CUT_DEFAULT,
GUARDRAILS_RAISE_DEFAULT,
MONTE_CARLO_TAB_RUNS,
MONTE_CARLO_TAB_SEED_DEFAULT,
PHASE_DECLINE_PCT_DEFAULT,
PHASE_START_AGE_DEFAULT,
RETIREMENT_AGE_DEFAULT,
STOCKS_PCT_DEFAULT,
runHistorical,
runMonteCarlo,
runNeverRunsOut,
simulate,
simulateDetailed,
solveMaxSpending,
type SimInputs,
type SpendingStrategy,
} from "@space/server/retirementEngines";

type CalcData = ApiResponse<typeof api, "getRetirementCalc">;
type Scenario = CalcData["scenarios"][number];
// The save mutation's result union (API follow-on F23) and the
// lite current record its conflict branch carries.
type RetSaveResult = Awaited<ReturnType<typeof api.saveRetirementCalc>>;
type RetLiteRecord = Extract<RetSaveResult, { ok: false }>["record"];
// The Tax Plan record's writer (build v140): the five plan
// fields live in that record, so an edit here writes through to
// it via saveRothInputs with the record's own CAS revision.
type RothSavePayload = Parameters<typeof api.saveRothInputs>[0];
// A queued Tax Plan write-through edit (build v153, audit
// M-4): ONLY the local deltas — for each of the five plan
// fields, the target value this view means to write, or null
// when the field carries no local edit (whatever the record
// holds at fire time stands for it). The whole-record payload
// is rebuilt from this at fire time; a payload snapshotted at
// queue time is exactly what let a stale write-through ride
// out under a fresh CAS base and silently revert another
// tab's save. Current age travels as the birth year the
// record stores (the server derives age from it).
type RothPlanDelta = {
  annualSpendingCents: number | null;
  birthYearPrimary: number | null;
  retirementAge: number | null;
  endAge: number | null;
  expectedReturnPct: number | null;
};
// The Tax Plan record as getRothPlanner returns it — the
// shape a whole-record save payload is built from. The
// unmount flush's guard-holding path (build v162) builds
// from a record fetched fresh at flush time, not from the
// possibly stale fetched record the view last rendered.
type RothPlannerRecord = Awaited<ReturnType<typeof api.getRothPlanner>>;
// The five plan fields' focus keys — the inputs that write
// through to the Tax Plan record. The settled-value gate holds a
// Tax Plan save while any of these is focused.
const PLAN_FIELD_KEYS = ["currentAge", "retirementAge", "endAge", "spending", "expectedPct"];

const ACCENT = "#0d9488";
const WORST_COLOR = "#dc2626";
// Historical chart series colours: the individual start-year
// lines are drawn in this grey, and the Monte Carlo fan bands
// are the accent colour at these fill opacities (the outer
// 10th–90th band lighter, the inner 25th–75th band darker).
// The chart legends below use these same values, so a swatch
// always matches the series it labels.
const HIST_LINE_COLOR = "#94a3b8";
const MC_OUTER_BAND_OPACITY = 0.14;
const MC_INNER_BAND_OPACITY = 0.3;

// Line swatch for a chart legend: a short horizontal line in
// the series' own colour and weight, matching the plotted line.
function LegendLineSwatch({
  stroke,
  strokeWidth,
}: {
  stroke: string;
  strokeWidth: number;
}) {
  return (
    <svg
      aria-hidden="true"
      width="24"
      height="8"
      viewBox="0 0 24 8"
      className="shrink-0"
    >
      <line
        x1="0"
        y1="4"
        x2="24"
        y2="4"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
    </svg>
  );
}

// Band swatch for a chart legend: a filled rectangle in the
// band's own colour and opacity, matching the shaded fan area.
function LegendBandSwatch({ opacity }: { opacity: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-3 w-6 shrink-0 rounded-[3px]"
      style={{ backgroundColor: ACCENT, opacity }}
    />
  );
}
// Professional at-risk cutoffs (same thresholds as the red-text
// treatment): Historical is at risk below 95%, Monte Carlo below 85%.
const HIST_AT_RISK_BELOW = 95;
const MC_AT_RISK_BELOW = 85;
function successAtRisk(rate: number, engine: "historical" | "montecarlo"): boolean {
  return rate < (engine === "historical" ? HIST_AT_RISK_BELOW : MC_AT_RISK_BELOW);
}
// Floating explanation bubble for an at-risk indicator. Rendered
// only while its trigger is hovered, focused, or tapped open, and
// wired to the trigger with aria-describedby so screen readers
// announce it too. Descriptive only — it states the result, the
// professional cutoff it fell below, and what that means; it never
// advises what to do.
function TipBubble({
  id,
  text,
  below,
}: {
  id: string;
  text: string;
  below?: boolean;
}) {
  return (
    <span
      id={id}
      role="tooltip"
      className={`pointer-events-none absolute left-1/2 z-50 w-60 max-w-[80vw] -translate-x-1/2 rounded-[var(--radius)] bg-[var(--text)] px-3 py-2 text-left text-xs leading-relaxed font-normal whitespace-normal text-[var(--bg)] shadow-lg ${
        below ? "top-full mt-2" : "bottom-full mb-2"
      }`}
    >
      {text}
    </span>
  );
}

const pillCls =
  "tnum inline-flex max-w-full cursor-help items-center gap-1 rounded-full bg-[var(--bad-soft)] px-2 py-1 text-xs font-semibold whitespace-nowrap text-[var(--bad)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] sm:px-2.5 sm:text-sm";

// At-risk success rate, rendered as a pill instead of plain red
// text so it cannot be skimmed past: soft red tint, red text, a
// warning sign and the words "At risk" alongside the percentage.
// Hovering, tapping, or focusing the pill opens a tooltip that
// says WHY it is flagged: the rate, the professional cutoff it
// fell below (Historical 95%, Monte Carlo 85%), and what being
// below that line means in plain terms. A result at or above its
// cutoff never renders this pill, so it never carries the tooltip.
function AtRiskPill({
  rate,
  engine,
  tip,
}: {
  rate: number;
  engine: "historical" | "montecarlo";
  tip?: string;
}) {
  const [open, setOpen] = useState(false);
  const tipId = useId();
  const cutoff = engine === "historical" ? HIST_AT_RISK_BELOW : MC_AT_RISK_BELOW;
  const text =
    tip ??
    (engine === "historical"
      ? `The money never ran out in ${rate.toFixed(1)}% of the historical start years tested — below the ${cutoff}% level financial planners generally target for historical tests. Below that line, more of those past market sequences run out of money before the end age.`
      : `The money never ran out in ${rate.toFixed(1)}% of the simulated lifetimes tested — below the ${cutoff}% level financial planners generally target for Monte Carlo tests. Below that line, more simulated lifetimes run out of money before the end age.`);
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <span
        tabIndex={0}
        aria-describedby={open ? tipId : undefined}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
        className={pillCls}
      >
        <span aria-hidden="true">⚠</span> At risk · {rate.toFixed(1)}%
      </span>
      {open && <TipBubble id={tipId} text={text} />}
    </span>
  );
}
// At-risk ending balance for the Projection tab, which has no
// success rate: its failure state is the same funding test every
// verdict in this view uses — a retired year whose spending was
// not fully funded (the Projection result's neverRunsOut /
// shortfallAge, from the engines' runNeverRunsOut), NOT an
// ending balance of $0. A shortfall year can be followed by
// later income that refills the balance to a positive ending,
// and a fully funded run can end at exactly $0 and succeed, so
// neither the ending balance nor the first $0 balance in the
// path can decide this pill. Rendered as the same soft-red pill
// as at-risk percentages, with the same kind of tooltip: it
// states the first unfunded age and the plan's end age it falls
// short of. The pill still carries the ending balance itself as
// its figure — the ending stays a displayed figure in its own
// right; only the verdict changed.
function AtRiskEndingPill({
  shortfallAge,
  endAge,
  ending,
}: {
  shortfallAge: number | null;
  endAge: number;
  ending: number;
}) {
  const [open, setOpen] = useState(false);
  const tipId = useId();
  const text =
    shortfallAge != null
      ? `At the assumed steady return, this plan's spending is not fully funded at age ${shortfallAge} — that year's spending exceeds the money on hand, before the plan's end age of ${endAge}. In the other tests, a plan that runs out of money is counted as not succeeding.`
      : `At the assumed steady return, this plan's spending is not fully funded by the end age of ${endAge}. In the other tests, a plan that runs out of money is counted as not succeeding.`;
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <span
        tabIndex={0}
        aria-describedby={open ? tipId : undefined}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
        className={pillCls}
      >
        <span aria-hidden="true">⚠</span> At risk · {fmt(ending)}
      </span>
      {open && <TipBubble id={tipId} text={text} />}
    </span>
  );
}
// Percent-of-portfolio tail disclosure: the collapse warning shown
// under a result tab's figures when that tab's final-year spending
// has faded below half of its first retired year's spending (each
// tab judged on its own statistic — the Projection value, or the
// Historical / Monte Carlo median). Percent mode can never run
// out by construction, so the success gauges stay green while
// spending shrinks toward $0; this line names the faded figure.
// Rendered in the app's warning treatment; null in every other
// case, and never for another strategy.
function PercentTailWarning({
  finalYearSpending,
  firstRetiredYearSpending,
}: {
  finalYearSpending: number | null;
  firstRetiredYearSpending: number | null;
}) {
  if (
    finalYearSpending == null ||
    firstRetiredYearSpending == null ||
    firstRetiredYearSpending <= 0 ||
    finalYearSpending >= firstRetiredYearSpending / 2
  ) {
    return null;
  }
  return (
    <p className="mt-3 rounded-[var(--radius)] border border-[var(--warn)] bg-[var(--warn-soft)] px-3 py-2 text-sm leading-relaxed">
      {`Spending fades late in life with Percent of portfolio — the plan can’t run out (each year’s withdrawal is a share of what’s left), but by the final year spending is down to ${fmt(finalYearSpending)}.`}
    </p>
  );
}
// One stable colour per comparison entry: Current inputs first,
// then Scenario 1 / 2 / 3. The same colour is used in every chart
// and on the matching card, so a line, a bar, and a card can be
// matched at a glance.
const COMPARE_COLORS = ["#0d9488", "#2563eb", "#d97706", "#9333ea"];

function fmt(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  const rem = abs % 100;
  const s = rem === 0 ? `$${dollars}` : `$${dollars}.${String(rem).padStart(2, "0")}`;
  return neg ? `−${s}` : s;
}
function fmtCompact(cents: number): string {
  const d = cents / 100;
  if (Math.abs(d) >= 1_000_000) return `$${(d / 1_000_000).toFixed(2)}M`;
  if (Math.abs(d) >= 1_000) return `$${Math.round(d / 1_000)}k`;
  return `$${Math.round(d)}`;
}
function parseMoney(s: string): number | null {
  const cleaned = s.replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}
function parseNum(s: string): number | null {
  const cleaned = s.replace(/[%\s]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
// "2026-08" → "August 2026" for provenance copy. Anything that is
// not a well-formed YYYY-MM is returned unchanged rather than
// guessed at.
function fmtMonthLabel(ym: string | null): string | null {
  if (!ym) return null;
  const [yStr = "", mStr = ""] = ym.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  if (!Number.isFinite(y) || m < 1 || m > 12) return ym;
  return `${MONTH_NAMES[m - 1]} ${y}`;
}
// Display-only formatting for the input boxes. Field state always
// holds the raw typed string; a field shows its formatted form only
// while it is NOT focused, the raw string while it is focused (so
// typing is never rewritten or the caret moved), and the formatted
// form again on blur. Blank and unparseable text are shown exactly
// as typed — formatting never coerces a value. Cents are shown
// only when the amount has them ($144,000, not $144,000.00) — the
// same input-display convention as the other views'
// fmtMoneyInput / fmtInputMoney.
function formatMoneyDisplay(s: string): string {
  const cents = parseMoney(s);
  if (cents == null) return s;
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}
// Monthly presentations of an ANNUAL money string, for the Annual
// spending field's per-month entry mode. Both are display-only:
// the annual string (and the annual cents every engine, save, and
// comparison derives from it) is never rewritten by formatting.
// The unfocused form rounds the exact annual ÷ 12 figure to cents
// for display ($160,000/yr shows as $13,333.33/mo while the
// stored annual value stays exactly 16000000 cents); the raw form
// is the same rounded figure without decoration, shown while the
// field is focused so an edit starts from what was displayed.
// Blank and unparseable text pass through exactly as typed.
function formatMonthlyDisplay(annualStr: string): string {
  const cents = parseMoney(annualStr);
  if (cents == null) return annualStr;
  return `$${(cents / 1200).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}
// Monthly raw form (build v140): the monthly figure as a plain
// number string (no $ or commas) for the focused per-month input,
// so an edit starts from what was displayed. The monthly cents
// are rounded to the cent, matching formatMonthlyDisplay above.
// A typed monthly amount turns into annual at exactly monthly ×
// 12 (monthlyToAnnual below); blank and unparseable text pass
// through exactly as typed, so the field shows what was typed.
function monthlyRaw(annualStr: string): string {
  const cents = parseMoney(annualStr);
  if (cents == null) return annualStr;
  return String(Math.round(cents / 12) / 100);
}
function monthlyToAnnual(monthlyStr: string): string {
  const cents = parseMoney(monthlyStr);
  if (cents == null) return monthlyStr;
  return String((cents * 12) / 100);
}
function formatPctDisplay(s: string): string {
  const n = parseNum(s);
  if (n == null) return s;
  return `${n}%`;
}
const inputCls =
  "w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)]";
const labelCls = "block text-sm font-medium text-[var(--text)] mb-1";
const btnPrimary =
  "rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2 text-base font-medium text-white disabled:opacity-50";

type Tab = "projection" | "historical" | "montecarlo" | "maxspending";

/* Build v177 (re-audit NICE-TO-HAVE N-3): the bound on a
   save fire path's hold polls — a fire path waiting for an
   in-flight save to settle (or, in the write-through, for
   the fetched record to catch up to the base) re-checks
   every 300 ms at most this many times (100 × 300 ms =
   30 s) before it gives up explicitly instead of polling
   forever. The same bound and give-up are applied in every
   writer that carries the hold (App.tsx, Playground.tsx,
   RothConversion.tsx). */
const SAVE_HOLD_MAX_POLLS = 100;

/* Build v196 (re-audit round 3 SHOULD-7): how long a flush
   deferred behind an in-flight save (the S-3 slots — this
   view carries two, the autosave's and the Tax Plan
   write-through's) waits for that save to settle before
   the deferred send fires anyway — the same 30 s scale as
   the hold bound above (100 × 300 ms), far beyond any
   save this app makes. A save that has not settled in
   30 s is hung (its promise neither resolves nor rejects,
   so its settle handlers — the slot's only consumer —
   never run), and without this bound the deferred edit
   sits in its slot forever: never sent, never reported.
   On expiry the slot's send fires through the retrying
   flush path exactly as it would have on a settle (see
   the slots' comments below). The same bound is applied
   in every writer that carries a deferred slot
   (RothConversion.tsx, Playground.tsx). */
const DEFERRED_FLUSH_GIVE_UP_MS = 30000;

export function RetirementCalc({
  onJumpToTaxPlan,
}: {
  onJumpToTaxPlan?: (target: {
    fieldId: string;
    section: RothSectionId;
    nonce: number;
  }) => void;
} = {}) {
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ["retirementcalc"],
    queryFn: () => api.getRetirementCalc({}),
  });
  const data: CalcData | undefined = q.data;
  // The Tax Plan record (build v133): the single source of
  // truth for the five shared plan fields — spending,
  // retirement age, current age (from the birth year it
  // stores), end age, and expected return. Same query key as
  // the Tax Plan view, so the record is shared, not fetched
  // twice.
  const rothQ = useQuery({
    queryKey: ["rothplanner"],
    queryFn: () => api.getRothPlanner({}),
  });
  // The five plan-sourced values (build v133): the Tax Plan
  // record's figures where it has them, else the same
  // fallbacks a fresh first open uses — trailing True cost
  // for spending, the birth-year current age the server
  // already derives from the Tax Plan record, 57 / 95 for the
  // ages, and the 5% expected-return default. Current age is
  // NOT read from the Tax Plan record directly (it stores a
  // birth year, not an age): getRetirementCalc's
  // defaultCurrentAge is that birth year turned into an age.
  const sourced = useMemo(() => {
    const rp = rothQ.data?.saved;
    return {
      spendingCents:
        rp?.annualSpendingCents ?? data?.defaultSpendingAnnualCents ?? 0,
      currentAge: data?.defaultCurrentAge ?? 55,
      retirementAge: rp?.retirementAge ?? RETIREMENT_AGE_DEFAULT,
      endAge: rp?.endAge ?? 95,
      expectedReturnPct: rp?.expectedReturnPct ?? EXPECTED_RETURN_DEFAULT,
    };
  }, [rothQ.data, data]);

  /* Which tab is showing. The last tab shown is remembered in
     this browser (usePersistedChoice, key "fp.retirement.tab");
     a first visit, or a missing or unknown stored value, opens
     on "projection". Display only. */
  const [tab, setTab] = usePersistedChoice<Tab>(
    "fp.retirement.tab",
    "projection",
    ["projection", "historical", "montecarlo", "maxspending"],
  );
  /* Plan-inputs form fold: the whole inputs panel collapses
     behind the chip chevron on its top row, so it can be hidden
     once set. Persisted in the generic fold store (server-backed,
     no localStorage) following the app's pattern for a fold that
     DEFAULTS TO EXPANDED — the store only carries folds left in
     their non-default state, so this stores the inverse flag: an
     entry under "retirement.inputsFolded" means the user left the
     form folded shut; no entry means expanded, its default. The
     header row — the "Plan inputs" title, its live plan-summary
     line, and the fold chevron — stays visible as the fold's
     header either way, while the action row (Reset / plan
     status / Save controls) sits inside
     the panel body and folds away with it; the results below the form
     are outside the fold and keep recalculating exactly as
     before. Display only — no field, save, or figure reads this
     flag. */
  const [inputsFolded, setInputsFolded] = usePersistedFold(
    "retirement.inputsFolded",
  );
  const inputsOpen = !inputsFolded;
  // (Build v140 — one source, multiple edit locations: every
  // value this view shows is either an editable input in place
  // or plain text, except the header summary's values, which
  // are taps back to the fields below (build v146). The
  // Calculated-with tiles are taps to where each number lives
  // — Portfolio to the field below, Spending / Ages / Expected
  // return across to the Tax Plan record — taps only, they
  // edit nothing in place.)
  const [mcSeed, setMcSeed] = useState(MONTE_CARLO_TAB_SEED_DEFAULT);
  const [init, setInit] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [selectedStartYear, setSelectedStartYear] = useState<number | null>(null);
  const [solverEngine, setSolverEngine] = useState<"historical" | "montecarlo">("historical");
  const [solverTarget, setSolverTarget] = useState("95");
  const [scenarioMsg, setScenarioMsg] = useState("");
  const [planMsg, setPlanMsg] = useState("");
  // In-memory session baseline, used only when the server has no
  // baseline to return (no saved inputs record existed when the
  // view first opened, so there was nothing to capture server-
  // side): the working inputs as they stood at that first open.
  const [memBaseline, setMemBaseline] = useState<CalcData["baseline"]>(null);
  // True for ~1.6 s after the headline results actually change, so
  // an edit's effect on the numbers below is visible instead of
  // silent. Driven by the effect after the engine memos.
  const [resultsFlash, setResultsFlash] = useState(false);
  const flashTimer = useRef<number | null>(null);
  /* Jump-and-highlight (build v146): the header-summary taps —
     mirror the Playground's jumpToPgField. The inputs panel is
     folded shut, the target fields are not rendered, so unfold it
     first, then scroll on a later frame and flash an outline +
     tint on the field for a fixed 3s. A new jump restores the
     previous field first, so a highlight can never stick. */
  const rcFlashTimer = useRef<number | null>(null);
  const rcFlashEl = useRef<HTMLElement | null>(null);
  const rcFlashPrev = useRef<{
    outline: string;
    outlineOffset: string;
    background: string;
  } | null>(null);
  const jumpToRcField = (fieldId: string) => {
    if (!inputsOpen) setInputsFolded(false);
    window.setTimeout(() => {
      const el = document.getElementById(fieldId);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      if (rcFlashEl.current != null && rcFlashPrev.current != null) {
        const old = rcFlashEl.current;
        old.style.outline = rcFlashPrev.current.outline;
        old.style.outlineOffset = rcFlashPrev.current.outlineOffset;
        old.style.background = rcFlashPrev.current.background;
      }
      if (rcFlashTimer.current != null) {
        window.clearTimeout(rcFlashTimer.current);
      }
      const prev = {
        outline: el.style.outline,
        outlineOffset: el.style.outlineOffset,
        background: el.style.background,
      };
      rcFlashPrev.current = prev;
      rcFlashEl.current = el;
      el.style.outline = "2px solid var(--accent)";
      el.style.outlineOffset = "2px";
      el.style.background =
        "color-mix(in srgb, var(--accent) 15%, transparent)";
      rcFlashTimer.current = window.setTimeout(() => {
        el.style.outline = prev.outline;
        el.style.outlineOffset = prev.outlineOffset;
        el.style.background = prev.background;
        rcFlashEl.current = null;
        rcFlashPrev.current = null;
      }, 3000);
    }, 150);
  };
  const rcTapCls =
    "underline decoration-dotted underline-offset-4 hover:text-[var(--accent)]";
  /* Calculated-with tile taps: each tile is a tap to where its
     number lives — Portfolio to this view's own Retirement
     record field (jumpToRcField above), Spending / Ages /
     Expected return to the Tax Plan record via App's cross-view
     jump (the same jumpTarget mechanism the Playground's Plan
     total tap uses). Spending is the one strategy-aware tile:
     in the percent strategy the tile shows this record's own
     percentOfPortfolio, so it taps to this view's rc-percent
     field instead of the Tax Plan's Annual spending (which is
     not an input to that strategy's calculation). Taps only —
     the tiles edit nothing. */
  const jumpToTaxPlan = (fieldId: string, section: RothSectionId) => {
    onJumpToTaxPlan?.({ fieldId, section, nonce: Date.now() });
  };
  const calcTileCls =
    "w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-alt)] px-3 py-2 text-left hover:border-[var(--accent)]";
  const calcTileValueCls =
    "tnum text-base font-semibold underline decoration-dotted underline-offset-4";
  // Standout treatment for the three key money figures (the
  // verdict's amount left, the Projection strip's ending
  // balance, and the Portfolio tile value) — one shared class
  // so all three match exactly.
  const keyFigureCls = "tnum text-xl font-bold";
  // Inline rename: which scenario is being renamed, and the draft name.
  const [renamingName, setRenamingName] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  // Scenario whose Delete is showing its confirmation; null =
  // none. Tapping Delete only opens this — the delete itself
  // runs from the confirmation's Delete button, so one stray
  // tap can't remove a saved scenario.
  const [confirmDeleteScenarioName, setConfirmDeleteScenarioName] =
    useState<string | null>(null);
  // Last known at-risk state of the Max spending tab. The settled
  // solver result drives the tab indicator directly; this is only
  // the fallback for the brief unknown windows (before the first
  // settled solve, or while the target box holds no valid number).
  const [lastMaxAtRisk, setLastMaxAtRisk] = useState(false);
  // Which engine tab's at-risk tooltip is currently open (hover,
  // focus, or a tap on its badge toggles it). Short-form version
  // of the pill tooltips: it names the result and the cutoff.
  const [tipTab, setTipTab] = useState<Tab | null>(null);
  // Which money/percent input is currently focused. Focused fields
  // show their raw string; unfocused fields show the formatted
  // display form (see formatMoneyDisplay / formatPctDisplay).
  const [focusField, setFocusField] = useState<string | null>(null);

  // Input state (strings so fields can be edited freely).
  const [portfolio, setPortfolio] = useState("");
  // Whether the Starting portfolio is following Net Worth (true)
  // or is a set value of the user's own (false). The field always
  // DISPLAYS the effective value — following shows the Net
  // Worth-following figure (the latest total minus the 529
  // bucket) — but a following portfolio saves as null so it keeps
  // following future snapshots instead of freezing today's figure
  // the moment any other input autosaves (the same pattern as the
  // Roth view's starting balances).
  const [portfolioFollowing, setPortfolioFollowing] = useState(true);
  const [spending, setSpending] = useState("");
  // Per-month draft (build v140): while the Annual spending
  // field is focused in per-month mode, the input shows the
  // monthly figure as the user types it — the stored state is
  // annual dollars, so the typed monthly string lives here
  // until blur, and each keystroke also writes the annual
  // equivalent (monthly × 12) into the spending state. Without
  // this the focused field would re-derive the monthly figure
  // from the annual state on every keystroke and rewrite what
  // was typed. Null whenever the field is not focused in
  // per-month mode.
  const [spendingMonthlyDraft, setSpendingMonthlyDraft] = useState<string | null>(null);
  // Entry unit for the Annual spending field: "year" shows and
  // edits the stored annual dollars directly (the long-standing
  // behaviour); "month" shows annual ÷ 12 and turns a typed
  // monthly amount into annual at exactly monthly × 12. The
  // stored value is annual cents everywhere, and switching units
  // never rewrites it. The unit itself is a persisted UI
  // preference (settings key "retirement_spending_unit", written
  // through setRetirementSpendingUnit, exactly like the
  // Assumptions collapse flag): local state is seeded once from
  // the getRetirementCalc response in the init effect below, a
  // flip updates local state immediately and writes the
  // preference, and with nothing ever stored the field opens
  // per month.
  const [spendingUnit, setSpendingUnit] = useState<"year" | "month">("month");
  // Assumptions group collapse flag: optimistic — the section flips
  // immediately from local state and the choice persists in the
  // background (build v132). Before the first read lands the
  // group shows collapsed, the stored default. The server action
  // never refuses (no epoch guard), so no revert is needed.
  const [assumptionsOverride, setAssumptionsOverride] = useState<boolean | null>(null);
  const assumptionsCollapsed = assumptionsOverride ?? data?.assumptionsCollapsed ?? true;
  const [currentAge, setCurrentAge] = useState("55");
  const [retirementAge, setRetirementAge] = useState(String(RETIREMENT_AGE_DEFAULT));
  const [endAge, setEndAge] = useState("95");
  const [stocksPct, setStocksPct] = useState(String(STOCKS_PCT_DEFAULT));
  const [extraIncome, setExtraIncome] = useState("");
  const [extraStartAge, setExtraStartAge] = useState(String(EXTRA_INCOME_START_AGE_DEFAULT));
  const [expectedPct, setExpectedPct] = useState(
    String(EXPECTED_RETURN_DEFAULT),
  );
  const [volPct, setVolPct] = useState(
    String(Math.round(blendedVol(STOCKS_PCT_DEFAULT) * 100) / 100),
  );
  const [strategy, setStrategy] = useState<SpendingStrategy>("constant");
  const [percentOfPortfolio, setPercentOfPortfolio] = useState("5");
  const [guardrailsCutPct, setGuardrailsCutPct] = useState(String(GUARDRAILS_CUT_DEFAULT));
  const [guardrailsRaisePct, setGuardrailsRaisePct] = useState(String(GUARDRAILS_RAISE_DEFAULT));
  const [guardrailsAdjustmentPct, setGuardrailsAdjustmentPct] = useState(String(GUARDRAILS_ADJUSTMENT_DEFAULT));
  const [phaseStartAge, setPhaseStartAge] = useState(String(PHASE_START_AGE_DEFAULT));
  const [phaseDeclinePct, setPhaseDeclinePct] = useState(String(PHASE_DECLINE_PCT_DEFAULT));
  const prevBlend = useRef<{ exp: string; vol: string }>({
    exp: String(Math.round(blendedExpected(STOCKS_PCT_DEFAULT) * 100) / 100),
    vol: String(Math.round(blendedVol(STOCKS_PCT_DEFAULT) * 100) / 100),
  });

  // The two records' last-known write revisions (API follow-on
  // F23): blob 1 (the working inputs) and blob 2 (the baseline).
  // Set from the getRetirementCalc response on load and kept in
  // step with every refetch (the refetch-sync effect below);
  // every save passes its record's revision back as the CAS
  // base and adopts the returned revision on success, and the
  // conflict path adopts both from the refusal's record.
  const inputsRevisionRef = useRef(0);
  const baselineRevisionRef = useRef(0);

  // The Tax Plan record values the five plan fields were last
  // synced to (build v153, audit M-4), in the record's own
  // terms (current age as the birth year it stores; expected
  // return at the precision the field displays, so a field
  // holding exactly what a sync put there parses back equal).
  // Set by every path that puts record values into the fields
  // — hydrate, the sourced effect's per-field sync, a landed
  // write-through — and read by the sourced effect (a field
  // whose parsed value still equals its synced value is
  // untouched and may follow the record; one that differs
  // carries a local edit and is never re-synced over) and by
  // the write-through queue (a field becomes a queued delta
  // only by differing from its synced value, so a field the
  // user never touched can never turn into a stale delta
  // just because another tab moved the record under it).
  const planSyncedRef = useRef<RothPlanDelta | null>(null);
  // Set by the write-through's conflict path: the next sourced
  // sync replaces all five fields with the stored values
  // wholesale (the deliberate drop the conflict message
  // describes), bypassing the per-field guard above.
  const planForceSyncRef = useRef(false);

  /* Hydrate the whole form from a saved inputs record — the ONE
     path shared by the init effect (first load) and the CAS
     conflict path (a refused save re-shows the latest saved
     version). `saved` may be null (no saved record): every
     field then falls back to the load defaults in `d`, exactly
     as a fresh first open does. The five plan fields — spending,
     current age, retirement age, end age, expected return —
     come from the Tax Plan record (build v133) and are NOT
     read from this view's saved copies: those copies are
     vestigial (kept in the record, ignored on load). */
  const hydrateFromSaved = (saved: CalcData["saved"], d: CalcData) => {
    const s = saved;
    const data = d;
    const stocks = s?.stocksPct ?? STOCKS_PCT_DEFAULT;
    setPortfolio(
      s?.portfolioCents != null
        ? String(s.portfolioCents / 100)
        : String(data.defaultPortfolioCents / 100),
    );
    // A saved portfolio counts as following Net Worth when it is
    // null (never set), or when it equals a figure the auto-fill
    // itself produced: the raw latest Net Worth total (what the
    // auto-fill saved before the 529 exclusion existed) or the
    // current Net Worth-following figure (total minus the 529
    // bucket). Any other saved value is the user's own set value
    // and is used exactly as saved.
    setPortfolioFollowing(
      s?.portfolioCents == null ||
        s.portfolioCents === data.nwTotalCents ||
        s.portfolioCents === data.defaultPortfolioCents,
    );
    setSpending(String(sourced.spendingCents / 100));
    // The remembered spending-field unit wins on load; the
    // server resolves "month" when nothing was ever stored.
    setSpendingUnit(data.spendingUnit);
    setCurrentAge(String(sourced.currentAge));
    setRetirementAge(String(sourced.retirementAge));
    setEndAge(String(sourced.endAge));
    setStocksPct(String(stocks));
    setExtraIncome(
      s?.extraIncomeCents != null && s.extraIncomeCents > 0
        ? String(s.extraIncomeCents / 100)
        : "",
    );
    setExtraStartAge(
      s?.extraIncomeStartAge != null
        ? String(s.extraIncomeStartAge)
        : s
          ? ""
          : String(EXTRA_INCOME_START_AGE_DEFAULT),
    );
    const exp = sourced.expectedReturnPct;
    const vol = s?.volatilityPct ?? blendedVol(stocks);
    setExpectedPct(String(Math.round(exp * 100) / 100));
    setVolPct(String(Math.round(vol * 100) / 100));
    // The five plan fields now hold exactly the record's
    // values (build v153): record them as the values the
    // fields were last synced to, so the sourced effect and
    // the write-through queue can tell an untouched field
    // from a local edit.
    planSyncedRef.current = {
      annualSpendingCents: sourced.spendingCents,
      birthYearPrimary: new Date().getFullYear() - sourced.currentAge,
      retirementAge: sourced.retirementAge,
      endAge: sourced.endAge,
      expectedReturnPct: Math.round(exp * 100) / 100,
    };
    setStrategy(s?.strategy ?? "constant");
    setPercentOfPortfolio(String(s?.percentOfPortfolio ?? 5));
    setGuardrailsCutPct(String(s?.guardrailsCutPct ?? GUARDRAILS_CUT_DEFAULT));
    setGuardrailsRaisePct(String(s?.guardrailsRaisePct ?? GUARDRAILS_RAISE_DEFAULT));
    setGuardrailsAdjustmentPct(String(s?.guardrailsAdjustmentPct ?? GUARDRAILS_ADJUSTMENT_DEFAULT));
    // A record saved before the phased strategy existed carries
    // no phased fields: the knobs open on their defaults (75 / 1),
    // exactly what the engines run for such a record.
    setPhaseStartAge(String(s?.phaseStartAge ?? PHASE_START_AGE_DEFAULT));
    setPhaseDeclinePct(String(s?.phaseDeclinePct ?? PHASE_DECLINE_PCT_DEFAULT));
    prevBlend.current = {
      exp: String(Math.round(blendedExpected(stocks) * 100) / 100),
      vol: String(Math.round(blendedVol(stocks) * 100) / 100),
    };
  };

  useEffect(() => {
    if (!data || init) return;
    hydrateFromSaved(data.saved, data);
    setInit(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, init]);

  // Keep the five plan-sourced fields on the Tax Plan record
  // (build v133): whenever the record lands or changes —
  // first load, a Tax Plan save, a refetch — the five states
  // follow it. The autosave below then persists the same
  // values into this view's record, so the record stays in
  // sync; the next refetch returns the same values, so there
  // is no loop (setting a state to its current value is a
  // no-op in React).
  //
  // Build v153 (audit M-4): the follow is PER FIELD and
  // guarded. A field is re-synced only when it is clean —
  // its parsed value still equals the value it was last
  // synced to (planSyncedRef) — and it is not the field
  // currently focused. A refetch landing mid-edit therefore
  // never clobbers in-progress typing: the field being
  // edited keeps the user's text, and a field carrying an
  // unsaved local edit keeps it too, while every untouched
  // field still follows the record, so another tab's edit
  // shows up here. Running on focusField too means a field
  // that was focused-but-unedited catches up with the
  // record once focus leaves it. The one exception is a
  // write-through conflict: the mutation sets the force
  // flag, the stored values replace the form wholesale,
  // and the conflict message says exactly that.
  useEffect(() => {
    if (!init) return;
    const force = planForceSyncRef.current;
    planForceSyncRef.current = false;
    const synced = planSyncedRef.current;
    const values = planFieldValuesRef.current();
    const recordValues: RothPlanDelta = {
      annualSpendingCents: sourced.spendingCents,
      birthYearPrimary: new Date().getFullYear() - sourced.currentAge,
      retirementAge: sourced.retirementAge,
      endAge: sourced.endAge,
      expectedReturnPct: Math.round(sourced.expectedReturnPct * 100) / 100,
    };
    const merged: RothPlanDelta = { ...(synced ?? recordValues) };
    const clean = (parsed: number | null, was: number | null | undefined) =>
      force || was === undefined || parsed === was;
    if (
      focusField !== "spending" &&
      clean(values.annualSpendingCents, synced?.annualSpendingCents)
    ) {
      setSpending(String(sourced.spendingCents / 100));
      merged.annualSpendingCents = recordValues.annualSpendingCents;
    }
    if (
      focusField !== "currentAge" &&
      clean(values.birthYearPrimary, synced?.birthYearPrimary)
    ) {
      setCurrentAge(String(sourced.currentAge));
      merged.birthYearPrimary = recordValues.birthYearPrimary;
    }
    if (
      focusField !== "retirementAge" &&
      clean(values.retirementAge, synced?.retirementAge)
    ) {
      setRetirementAge(String(sourced.retirementAge));
      merged.retirementAge = recordValues.retirementAge;
    }
    if (
      focusField !== "endAge" &&
      clean(values.endAge, synced?.endAge)
    ) {
      setEndAge(String(sourced.endAge));
      merged.endAge = recordValues.endAge;
    }
    if (
      focusField !== "expectedPct" &&
      clean(values.expectedReturnPct, synced?.expectedReturnPct)
    ) {
      setExpectedPct(String(Math.round(sourced.expectedReturnPct * 100) / 100));
      merged.expectedReturnPct = recordValues.expectedReturnPct;
    }
    planSyncedRef.current = merged;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourced, init, focusField]);

  // Keep both tracked revisions in step with every refetch (the
  // server invalidates this query after writes, ours included —
  // and this view's scenario mutations adopt state through
  // invalidation/refetch, so their bumps land here too). A stale
  // in-flight refetch can only move a base backwards into a
  // conflict on the next save, which rehydrates honestly —
  // never into a silent overwrite.
  useEffect(() => {
    if (data) {
      inputsRevisionRef.current = data.revision;
      baselineRevisionRef.current = data.baselineRevision;
    }
  }, [data]);

  // When the mix changes, follow the blended default for
  // volatility unless the user has typed their own value.
  // Expected return does NOT follow the blend (build v133):
  // it comes from the Tax Plan record, so a mix change leaves
  // it where the plan has it.
  useEffect(() => {
    if (!init) return;
    const stocks = parseNum(stocksPct);
    if (stocks == null || stocks < 0 || stocks > 100) return;
    const exp = String(Math.round(blendedExpected(stocks) * 100) / 100);
    const vol = String(Math.round(blendedVol(stocks) * 100) / 100);
    if (volPct === prevBlend.current.vol) setVolPct(vol);
    prevBlend.current = { exp, vol };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stocksPct, init]);

  /* ---------------- autosave (revision-checked, F23) ----------------
     Every save passes baseRevision = blob 1's last-known
     revision, and adopts the returned revision on EVERY
     success — without that, the view's own second autosave
     would conflict against its first. Saves are serialized
     through saveInFlightRef (the Roth view's pattern): a
     debounced save that comes due while one is in flight waits
     and re-fires, so the base it sends is the one the in-flight
     save returned, never a duplicate of the in-flight base.
     Build v163 (re-audit M-NEW-3): a FAILED save now
     surfaces a message, stays queued, and retries on the save
     timer — the M-5 pattern (build v151) applied to this
     fourth writer; see the mutation and the fire path below. */
  const saveTimer = useRef<number | null>(null);
  const pendingSave = useRef<Parameters<typeof api.saveRetirementCalc>[0] | null>(null);
  const pendingSaveOkRef = useRef<((res: RetSaveResult) => void) | null>(null);
  const saveInFlightRef = useRef(false);
  // Build v177 (re-audit NICE-TO-HAVE N-3): consecutive
  // hold polls by firePendingSave while it waits for the
  // in-flight save to settle, bounded by
  // SAVE_HOLD_MAX_POLLS — see the hold branch there.
  const saveHoldPollsRef = useRef(0);
  // Build v163 (re-audit M-NEW-3): the payload currently in
  // flight, so the unmount flush can tell "queued behind the
  // in-flight save" (a newer save — flush it) from "the
  // in-flight save itself" (already being written — the queue
  // now stays populated until a save succeeds). Mirrors the
  // Tax Plan write-through's rothSaveInFlightDeltaRef (v151).
  const saveInFlightPayloadRef = useRef<Parameters<typeof api.saveRetirementCalc>[0] | null>(null);
  // Build v168 (re-audit SHOULD S-3): a flush deferred
  // behind the in-flight save — the Tax Plan autosave's slot
  // of the same name (RothConversion.tsx). The unmount
  // cleanup, finding a save queued behind one still in
  // flight, stores its send here instead of firing it
  // concurrently under the same not-yet-advanced CAS base:
  // the server accepts exactly one of two same-base saves and
  // refuses the other, and a refused flush is lost silently
  // (its conflict path runs on an unmounted view). The
  // in-flight call's per-call handlers below consume the slot
  // as that save settles — fire on a landed save (the
  // mutation reads the NEW base) or on an error (base
  // unchanged; the queued save supersedes the failed one),
  // drop on a conflict (applyConflictRecord's deliberate drop
  // covers the deferred save too — it is the same stale
  // form's snapshot).
  const deferredFlushRef = useRef<(() => void) | null>(null);
  // Build v196 (re-audit round 3 SHOULD-7): the deferred
  // slot's GIVE-UP timer — the RothConversion slot's shape,
  // applied to both of this view's deferred slots. Before
  // v196 the slot's only consumer was the in-flight save's
  // own per-call handlers: if that save hung forever (its
  // request neither resolved nor rejected, so no handler
  // ever ran), the deferred save sat in the slot for the
  // rest of the page's life — never sent and never
  // reported, the exact stranding the N-3 hold bound
  // (build v177) closed for the mounted fire path. The
  // unmount cleanup now ARMS this timer as it stores the
  // deferred send (armDeferredFlushGiveUp below): if the
  // in-flight save has not settled within
  // DEFERRED_FLUSH_GIVE_UP_MS, the timer consumes the
  // slot itself and fires the deferred send anyway,
  // through the retrying flush send (sendCalcFlush, beside
  // buildInputsPayload below — reached through
  // sendCalcFlushRef, since the cleanup is defined before
  // it) exactly as a settle would have fired it, so the
  // edit is sent, a failure of that send re-arms the
  // flush's own 3 s retry, and a CAS conflict from sending
  // while the wedged save is still in flight resolves
  // through the mutation's normal conflict path instead
  // of stranding the edit. A settle that lands first
  // consumes the slot through takeDeferredFlush, which
  // clears this timer, so a normally-settling save fires
  // the deferred send exactly as before and the timer
  // never fires at all. The timer lives in its own ref,
  // cleared by nothing after unmount, so it outlives the
  // view like the flush retry timers.
  const deferredFlushGiveUpTimerRef = useRef<number | null>(null);
  const clearDeferredFlushGiveUp = () => {
    if (deferredFlushGiveUpTimerRef.current != null) {
      window.clearTimeout(deferredFlushGiveUpTimerRef.current);
      deferredFlushGiveUpTimerRef.current = null;
    }
  };
  // Consume the deferred slot (and disarm its give-up
  // timer): the ONE way the slot is read, so a settle and
  // the give-up can never both fire the same send.
  const takeDeferredFlush = (): (() => void) | null => {
    clearDeferredFlushGiveUp();
    const deferred = deferredFlushRef.current;
    deferredFlushRef.current = null;
    return deferred;
  };
  const armDeferredFlushGiveUp = () => {
    clearDeferredFlushGiveUp();
    deferredFlushGiveUpTimerRef.current = window.setTimeout(() => {
      deferredFlushGiveUpTimerRef.current = null;
      const deferred = deferredFlushRef.current;
      deferredFlushRef.current = null;
      if (deferred) deferred();
    }, DEFERRED_FLUSH_GIVE_UP_MS);
  };
  // The deferred send itself, held in a ref so the unmount
  // cleanup (defined before it) can store a send that
  // reaches it: sendCalcFlush, defined beside
  // buildInputsPayload below, builds the payload (a form
  // snapshot rebuilt at the fire, a command payload exactly
  // as constructed) and sends it through the ONE retrying
  // flush send for this writer (build v196 — before v196
  // the deferred send was a bare mutate call with only an
  // onSuccess, so a deferred flush whose own request failed
  // was dropped silently even when it fired on a settle).
  const sendCalcFlushRef = useRef<
    (
      queued: Parameters<typeof api.saveRetirementCalc>[0],
      queuedOnOk: ((res: RetSaveResult) => void) | null,
      queuedIsForm: boolean,
    ) => void
  >(() => {});
  // True while the queued save is the autosave's own form
  // snapshot (rebuilt fresh at every fire, retries included);
  // false for a submitSave command payload (Reset to defaults,
  // Load a scenario), which is sent — and retried — exactly as
  // constructed.
  const pendingSaveIsFormRef = useRef(false);

  /* The shared CAS conflict path — autosave, Reset to
     defaults, and Load a scenario / Back to my plan all ride
     this same save mutation, so all three inherit it: drop any
     queued save of the stale form, merge the refusal's current
     record into the query cache, re-hydrate the form from it
     through the ONE hydration path, and adopt both revisions.
     Deliberately NOT an auto-resubmit of the stale form — a
     calc save is a whole-form snapshot with no safe field-level
     re-apply. */
  const applyConflictRecord = (record: RetLiteRecord) => {
    if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
    pendingSave.current = null;
    pendingSaveOkRef.current = null;
    queryClient.setQueryData<CalcData>(["retirementcalc"], (old) =>
      old
        ? {
            ...old,
            saved: record.saved,
            scenarios: record.scenarios,
            baseline: record.baseline,
            baselineKind: record.baselineKind,
            revision: record.revision,
            baselineRevision: record.baselineRevision,
          }
        : old,
    );
    const current = queryClient.getQueryData<CalcData>(["retirementcalc"]);
    if (current) hydrateFromSaved(record.saved, current);
    inputsRevisionRef.current = record.revision;
    baselineRevisionRef.current = record.baselineRevision;
  };

  const save = useMutation({
    mutationFn: (input: Parameters<typeof api.saveRetirementCalc>[0]) =>
      api.saveRetirementCalc({
        ...input,
        baseRevision: inputsRevisionRef.current,
      }),
    onSuccess: (res) => {
      if (res.ok) {
        inputsRevisionRef.current = res.revision;
        // Build v163 (re-audit M-NEW-3), completion: a save
        // landed, so a "Could not save" note from an earlier
        // failed attempt is stale now — clear exactly that
        // note (the Tax Plan write-through does the same with
        // this shared line). Any other plan message — a
        // conflict note, a reset note — is left untouched.
        setPlanMsg((m) =>
          m === "Could not save — your entries stay on this screen." ? "" : m,
        );
        return;
      }
      // Conflict: a newer save landed first (another tab or
      // device). Replace the form with the current saved record
      // the refusal carries, adopt its revisions, and say
      // plainly what happened.
      applyConflictRecord(res.record);
      setPlanMsg(
        "These retirement inputs were changed in another tab or on another device, so the edits that were just saving here were not kept. The latest saved version is shown now.",
      );
    },
    onError: () => {
      // Build v163 (re-audit M-NEW-3): a failed save says so
      // instead of vanishing silently — the M-5 defect on this
      // fourth writer (the December console's onError sets the
      // same line). The edit stays queued (the fire path below
      // clears it only on success) and its per-call onError
      // re-arms a retry, so the edit lands once the server is
      // reachable again.
      setPlanMsg("Could not save — your entries stay on this screen.");
    },
  });
  const saveMutateRef = useRef(save.mutate);
  saveMutateRef.current = save.mutate;
  const firePendingSave = () => {
    if (!pendingSave.current) return;
    if (saveInFlightRef.current) {
      // A save is already in flight: wait for it to settle (its
      // returned revision becomes the base) and re-fire.
      // Build v177 (re-audit NICE-TO-HAVE N-3): this hold
      // is BOUNDED. Before v177 it re-armed the 300 ms
      // re-check without limit: a save whose call never
      // settles (a hung request — the mutation's promise
      // neither resolves nor rejects, so onSettled never
      // runs and the in-flight flag never clears) held the
      // queued save behind it forever, polling for the life
      // of the view. After SAVE_HOLD_MAX_POLLS consecutive
      // polls (100 × 300 ms = 30 s, far beyond any save this
      // app makes) the hold gives up explicitly: polling
      // stops, the save STAYS queued (a later edit, the blur
      // flush, or the unmount flush fires it, and if the
      // wedged save ever does settle its own per-call
      // handlers still consume the deferred slot exactly as
      // before), and the failure is surfaced with the same
      // line a failed save uses. Nothing is sent
      // concurrently — the S-3 deferral is untouched while
      // the in-flight save settles normally.
      saveHoldPollsRef.current += 1;
      if (saveHoldPollsRef.current > SAVE_HOLD_MAX_POLLS) {
        saveHoldPollsRef.current = 0;
        if (saveTimer.current != null) {
          window.clearTimeout(saveTimer.current);
          saveTimer.current = null;
        }
        setPlanMsg("Could not save — your entries stay on this screen.");
        return;
      }
      if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(firePendingSave, 300);
      return;
    }
    // Build v163 (re-audit M-NEW-3): an autosave payload is
    // rebuilt fresh at fire time from the current form — the
    // same discipline the M-3/M-4 fixes gave the write-through
    // — so a retry re-armed after a failure sends the form as
    // it now stands, never a snapshot taken before the failure.
    // A submitSave command payload (Reset to defaults, Load a
    // scenario) is NOT rebuilt: it is a deliberate command, not
    // a record snapshot, and is sent exactly as constructed.
    let payload = pendingSave.current;
    if (pendingSaveIsFormRef.current) {
      payload = buildInputsPayloadRef.current();
      pendingSave.current = payload;
    }
    const onOk = pendingSaveOkRef.current;
    // The save stays queued until it SUCCEEDS — it is not
    // dropped at the call, so a failed save (offline, gateway
    // 500) cannot vanish silently. The per-call handlers below
    // own the queue: success drops the save, error re-arms a
    // retry of it.
    saveHoldPollsRef.current = 0;
    saveInFlightRef.current = true;
    saveInFlightPayloadRef.current = payload;
    saveMutateRef.current(payload, {
      onSuccess: (res) => {
        // The save landed (or a conflict re-read the record
        // and re-showed the stored values — applyConflictRecord
        // already dropped the queue): clear the queue only if
        // it still holds this save, never a newer one queued
        // behind it.
        if (pendingSave.current === payload) {
          pendingSave.current = null;
          pendingSaveOkRef.current = null;
          pendingSaveIsFormRef.current = false;
        }
        onOk?.(res);
        // Build v168 (re-audit SHOULD S-3): consume a
        // flush the unmount cleanup deferred behind this
        // save — fire it on a landed save (the mutation-level
        // handler has adopted the new revision, so the
        // deferred send reads the new base and lands in
        // order), drop it on a conflict (applyConflictRecord
        // has replaced the form with the stored record; the
        // deferred save is that same stale form's snapshot
        // and must not ride out under the adopted base).
        // Build v196: consumed through takeDeferredFlush,
        // which also disarms the slot's give-up timer — a
        // save that settles normally leaves no timer behind.
        const deferred = takeDeferredFlush();
        if (res.ok && deferred) deferred();
      },
      onError: () => {
        // Keep the save queued and re-arm a retry on the
        // shared timer, so it lands once the server is
        // reachable again — rebuilt fresh at that fire if it
        // is the autosave's form snapshot, exactly as for a
        // first attempt. If a newer save was queued behind
        // this one, that save's own scheduling drives it and
        // no retry is armed for the superseded payload. The
        // mutation-level onError sets the visible message.
        if (pendingSave.current === payload) {
          if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
          saveTimer.current = window.setTimeout(firePendingSave, 3000);
        }
        // Build v168 (re-audit SHOULD S-3): this save
        // never landed, so the base is unchanged and a flush
        // deferred behind it at unmount fires now — the
        // queued save supersedes the failed one outright (no
        // retry of this payload was armed above: the queue no
        // longer holds it, the cleanup moved it to the
        // deferred slot).
        // Build v196: consumed through takeDeferredFlush,
        // which also disarms the slot's give-up timer.
        const deferred = takeDeferredFlush();
        if (deferred) deferred();
      },
      onSettled: () => {
        saveInFlightRef.current = false;
        saveInFlightPayloadRef.current = null;
      },
    });
  };
  const firePendingSaveRef = useRef(firePendingSave);
  firePendingSaveRef.current = firePendingSave;
  // Queue a save through the serialized path (Reset to defaults
  // and Load a scenario / Back to my plan ride it too; their
  // cache syncs travel as the onOk callback, guarded on ok so a
  // conflict never overwrites the conflict path's merge).
  // Build v163: a failed command save inherits the same
  // surface-and-retry as the autosave — it stays queued and is
  // re-sent exactly as constructed until it lands.
  const submitSave = (
    payload: Parameters<typeof api.saveRetirementCalc>[0],
    onOk?: (res: RetSaveResult) => void,
  ) => {
    pendingSave.current = payload;
    pendingSaveOkRef.current = onOk ?? null;
    pendingSaveIsFormRef.current = false;
    firePendingSaveRef.current();
  };
  // Flush a pending debounced save when leaving the screen, so an
  // edit made in the last fraction of a second is not lost. It
  // fires through the same serialized path; if a save is still
  // in flight at unmount, the queued save is DEFERRED behind it
  // (build v168, re-audit SHOULD S-3) — before v168 it fired
  // directly with the last-known base, concurrently with the
  // in-flight save: both carried the same base, the server
  // accepted exactly one and refused the other, and when the
  // refused one was this flush the newest edit was lost
  // silently (the refusal's re-show runs on an unmounted view).
  // The deferred send fires from the in-flight call's own
  // settle handlers, under the base that save leaves behind.
  useEffect(() => {
    return () => {
      if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
      // Build v163 (re-audit M-NEW-3): the queue now stays
      // populated until a save succeeds (v151's rule for the
      // write-through below), so the pending save may BE the
      // save currently in flight — that one is already being
      // written, and only a save queued behind it is flushed.
      if (
        pendingSave.current &&
        pendingSave.current !== saveInFlightPayloadRef.current
      ) {
        if (saveInFlightRef.current) {
          // Build v168: defer, don't fire concurrently.
          // Capture the queued save with its onOk and its
          // form/command kind: a form snapshot is rebuilt at
          // the deferred fire (the v163 discipline — the form
          // is frozen by the unmount, so the rebuild reads
          // the same final values the snapshot holds); a
          // command payload is sent exactly as constructed,
          // its onOk riding along as in the fire path.
          const queued = pendingSave.current;
          const queuedOnOk = pendingSaveOkRef.current;
          const queuedIsForm = pendingSaveIsFormRef.current;
          // Build v196 (re-audit round 3 SHOULD-7): the
          // deferred send now goes through the ONE retrying
          // flush send for this writer (sendCalcFlush,
          // reached through sendCalcFlushRef — its payload
          // build is the one this closure used to run, and
          // its onSuccess carries queuedOnOk exactly as the
          // bare call's did, so a deferred save that lands
          // behaves exactly as before; one that FAILS now
          // re-arms a 3 s retry of itself instead of being
          // dropped silently). Storing the send also ARMS
          // its give-up timer: if the in-flight save never
          // settles, the timer fires this same send after
          // DEFERRED_FLUSH_GIVE_UP_MS instead of leaving it
          // stranded in the slot forever (see the timer's
          // comment beside deferredFlushRef).
          deferredFlushRef.current = () =>
            sendCalcFlushRef.current(queued, queuedOnOk, queuedIsForm);
          armDeferredFlushGiveUp();
        } else {
          firePendingSaveRef.current();
        }
        pendingSave.current = null;
        pendingSaveOkRef.current = null;
        pendingSaveIsFormRef.current = false;
      }
      // The Tax Plan write-through's pending edit, flushed
      // the same way — focused or not (build v159, audit
      // SHOULD S-7): leaving the view IS the settle, the Tax
      // Plan's own v149 rule. Before v159 this flush was
      // gated on no plan field being focused, so an edit
      // whose field still held focus when the view went away
      // (a tab close or a navigation that unmounts without a
      // blur firing first) was silently dropped and the
      // record kept the old value — the normal exits were
      // covered by the blur flush, a tab close was not.
      // Flushing the QUEUED delta is safe for a half-typed
      // field: the queue only ever holds parsed values that
      // differ from the last-synced ones (a blank or
      // unparseable field carries no delta), so there is no
      // half-typed value in it to persist. The flush sends
      // directly, not through the fire path: the fire path's
      // settled-value gate would hold it for the very focus
      // this flush must ignore, and its re-check timers
      // cannot run once the view is gone.
      if (rothSaveTimer.current != null) window.clearTimeout(rothSaveTimer.current);
      // Build v151: the pending edit may BE the save
      // currently in flight (the queue now clears on success,
      // not at the call) — that one is already being written,
      // so only flush an edit queued behind it. Contract
      // v153: the queue holds only the local delta, so the
      // flush builds its payload from the freshest record
      // here, exactly like the fire path.
      //
      // Build v162 (re-audit M-NEW-2): "exactly like the
      // fire path" must include the fire path's payload/base
      // coherence guard (build v153) — a flush may NEVER
      // send a payload built from a record older than the
      // base it sends under. That guard lives in the ONE
      // flush send (sendRothFlush, beside
      // buildRothSavePayload below): guard not holding, it
      // builds from the fetched record and sends at once;
      // guard holding, it fetches the record fresh, rebuilds
      // from THAT record, adopts its revision as the base,
      // and only then sends — and if no fresh-enough record
      // can be had, the edit is dropped rather than sent
      // stale.
      //
      // Build v168 (re-audit SHOULD S-3): a queued-behind
      // edit is NOT fired while the write-through's own save
      // is still in flight — before v168 it fired here
      // concurrently, both saves reading the same
      // not-yet-advanced CAS base; the server accepted
      // exactly one, and a refused flush was lost silently
      // (its conflict handling runs on this unmounted view).
      // It is deferred instead: the in-flight call's per-call
      // handlers fire sendRothFlush the moment that save
      // settles (on a landed save the v162 guard routes the
      // deferred send through the fresh-fetch path, so its
      // payload is rebuilt from the record that save just
      // landed; on an error the base is unchanged and the
      // send proceeds exactly as an immediate flush would).
      // With nothing in flight the flush sends at once,
      // exactly as before.
      //
      // Build v188 (re-audit round 3 MUST-4): BOTH forms of
      // the flush — the immediate send and the deferred send
      // stored in deferredRothFlushRef — now reach the
      // server through the ONE retrying payload send inside
      // sendRothFlush (sendRothFlushPayload), not a bare
      // mutate call. The queue is still cleared just below
      // before the send, exactly as before, but the edit no
      // longer depends on the queue for its survival: once
      // sendRothFlush builds the payload, the retrying send
      // carries it in its closure and re-arms a 3 s retry of
      // it on error, so a flush that fails at the moment of
      // navigation is retried until it lands instead of
      // being lost silently (see that send's comment).
      if (
        pendingRothSave.current &&
        pendingRothSave.current !== rothSaveInFlightDeltaRef.current
      ) {
        const pendingFlush = pendingRothSave.current;
        pendingRothSave.current = null;
        if (rothSaveInFlightRef.current) {
          deferredRothFlushRef.current = () =>
            sendRothFlushRef.current(pendingFlush);
          // Build v196 (re-audit round 3 SHOULD-7): storing
          // the deferred send also ARMS its give-up timer —
          // if the in-flight save never settles, the timer
          // fires the deferred send through the same
          // retrying flush send after
          // DEFERRED_FLUSH_GIVE_UP_MS instead of leaving it
          // stranded in the slot forever (see the timer's
          // comment beside deferredRothFlushRef).
          armDeferredRothFlushGiveUp();
        } else {
          sendRothFlushRef.current(pendingFlush);
        }
      }
    };
  }, []);

  // The save-shaped payload for the current field values, clamped
  // to the save schema's ranges so a stray out-of-range entry
  // (stocks 750, age 999) cannot make the server reject the save.
  const buildSavePayload = (): Parameters<typeof api.saveRetirementCalc>[0] => {
    const clampAge = (s: string, max: number): number | null => {
      const n = parseNum(s);
      return n != null ? Math.min(max, Math.max(0, Math.round(n))) : null;
    };
    const stocksN = parseNum(stocksPct);
    const volN = parseNum(volPct);
    const pctN = parseNum(percentOfPortfolio);
    // Guardrails knobs: blank saves as null (the loader and the
    // engines substitute the professional default, exactly like a
    // blank Expected return / Volatility). A typed value is
    // clamped to its range, and the pair is clamped so the cut
    // trigger stays above the raise trigger — using the effective
    // (default-substituted) pair, so what is saved matches what
    // the engines run after a reload.
    const cutN = parseNum(guardrailsCutPct);
    const raiseN = parseNum(guardrailsRaisePct);
    const adjN = parseNum(guardrailsAdjustmentPct);
    const effKnobs = effectiveGuardrails(cutN, raiseN, adjN);
    // Phased knobs: blank saves as null (the loader and the
    // engines substitute the defaults, 75 / 1). A typed value is
    // clamped to its range — the start age as a whole age within
    // the end-age ceiling (a start at or beyond the end age is
    // valid: the plan simply stays flat), the decline to 0–100.
    const phaseStartN = parseNum(phaseStartAge);
    const phaseDeclineN = parseNum(phaseDeclinePct);
    return {
      portfolioCents: parseMoney(portfolio),
      spendingCents: parseMoney(spending),
      currentAge: clampAge(currentAge, 120),
      retirementAge: clampAge(retirementAge, 120),
      endAge: clampAge(endAge, 130),
      stocksPct: stocksN != null ? Math.min(100, Math.max(0, stocksN)) : null,
      // No silent floor (build v66, boundary audit F11):
      // the typed value is the saved value — a negative is
      // refused by the writer (an income field is int≥0), never
      // quietly saved and priced as $0.
      extraIncomeCents: parseMoney(extraIncome) ?? 0,
      extraIncomeStartAge: clampAge(extraStartAge, 120),
      expectedReturnPct: parseNum(expectedPct),
      volatilityPct: volN != null ? Math.max(0, volN) : null,
      strategy,
      percentOfPortfolio: pctN != null ? Math.min(100, Math.max(0, pctN)) : null,
      guardrailsCutPct: cutN != null ? effKnobs.guardrailsCutPct : null,
      guardrailsRaisePct: raiseN != null ? effKnobs.guardrailsRaisePct : null,
      guardrailsAdjustmentPct:
        adjN != null ? effKnobs.guardrailsAdjustmentPct : null,
      phaseStartAge:
        phaseStartN != null
          ? Math.min(130, Math.max(0, Math.round(phaseStartN)))
          : null,
      phaseDeclinePct:
        phaseDeclineN != null
          ? Math.min(100, Math.max(0, phaseDeclineN))
          : null,
    };
  };
  const buildSavePayloadRef = useRef(buildSavePayload);
  buildSavePayloadRef.current = buildSavePayload;

  // The payload for the working inputs: identical to the effective
  // payload EXCEPT a Net Worth-following portfolio saves as null —
  // null is what "follow Net Worth" means in the saved blob, so an
  // unrelated autosave cannot freeze today's following figure as a
  // set value. (Save-as-scenario keeps using buildSavePayload: a
  // scenario freezes the effective portfolio it was priced with.)
  const buildInputsPayload = (): Parameters<typeof api.saveRetirementCalc>[0] => {
    const eff = buildSavePayload();
    return {
      ...eff,
      portfolioCents: portfolioFollowing ? null : eff.portfolioCents,
    };
  };
  const buildInputsPayloadRef = useRef(buildInputsPayload);
  buildInputsPayloadRef.current = buildInputsPayload;

  // Build v196 (re-audit round 3 SHOULD-7): the ONE
  // retrying flush send for this view's own record — the
  // send the S-3 deferred slot (and only it: the immediate
  // unmount flush rides firePendingSave, whose own per-call
  // handlers already retry) fires its save through, whether
  // it is fired by the in-flight save's settle or by the
  // slot's give-up timer. Before v196 the deferred send was
  // a bare mutate call carrying only an onSuccess, so a
  // deferred flush whose own request failed (a network
  // error at the moment of navigation) was dropped
  // outright — the mutation-level onError set the "Could
  // not save" line on an unmounted view, where nobody could
  // see it, and nothing ever retried. This send is the
  // deferred flush's firePendingSave, mirroring the Tax
  // Plan's sendFlushWithRetry (build v187): its per-call
  // onError re-arms a 3 s retry of the SAME payload, chained
  // per failure exactly as firePendingSave's onError
  // re-arms its own retry, so the flush lands once the
  // server is reachable again. The retry timer lives in
  // its own ref, which no cleanup clears, so the retries
  // outlive the view. Each attempt goes through this same
  // send (the retry calls back through the ref, so it
  // always reaches the current closure), and the mutation
  // reads its CAS base live from inputsRevisionRef at each
  // call — a retry of a deferred flush fired on a settle
  // therefore rides the base the in-flight save adopted
  // when it landed, exactly as its first send did; a flush
  // fired by the give-up timer reads the base as it stands
  // then, and if the wedged save lands in between, the
  // server's CAS refuses the stale one and the conflict
  // path applies, rather than the edit stranding. A
  // conflict is NOT retried: it resolves through onSuccess
  // with res.ok false, where the mutation-level handler
  // has already applied the conflict path's deliberate
  // drop — the same rule the other flush sends follow.
  // The queued onOk rides every attempt, so a landed flush
  // runs its cache sync exactly as the bare call's
  // onSuccess did.
  const calcFlushRetryTimerRef = useRef<number | null>(null);
  const sendCalcFlushPayload = (
    flushPayload: Parameters<typeof api.saveRetirementCalc>[0],
    queuedOnOk: ((res: RetSaveResult) => void) | null,
  ) => {
    saveMutateRef.current(flushPayload, {
      onSuccess: (res) => {
        queuedOnOk?.(res);
      },
      onError: () => {
        if (calcFlushRetryTimerRef.current != null) {
          window.clearTimeout(calcFlushRetryTimerRef.current);
        }
        calcFlushRetryTimerRef.current = window.setTimeout(() => {
          sendCalcFlushPayloadRef.current(flushPayload, queuedOnOk);
        }, 3000);
      },
    });
  };
  const sendCalcFlushPayloadRef = useRef(sendCalcFlushPayload);
  sendCalcFlushPayloadRef.current = sendCalcFlushPayload;
  const sendCalcFlush = (
    queued: Parameters<typeof api.saveRetirementCalc>[0],
    queuedOnOk: ((res: RetSaveResult) => void) | null,
    queuedIsForm: boolean,
  ) => {
    // A form snapshot is rebuilt at the fire (the v163
    // discipline — the form is frozen by the unmount, so
    // the rebuild reads the same final values the snapshot
    // holds); a command payload is sent exactly as
    // constructed. Retries re-send the built payload, as
    // the other flush sends do.
    const p = queuedIsForm ? buildInputsPayloadRef.current() : queued;
    sendCalcFlushPayload(p, queuedOnOk);
  };
  sendCalcFlushRef.current = sendCalcFlush;

  useEffect(() => {
    if (!init) return;
    pendingSave.current = buildInputsPayloadRef.current();
    pendingSaveOkRef.current = null;
    pendingSaveIsFormRef.current = true;
    if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      firePendingSaveRef.current();
    }, 700);
    // The five plan fields write through to the Tax Plan record
    // (build v140) — queued here on the same debounce, and
    // the write-through's own settled gate holds it while a
    // plan field is focused.
    queueRothSaveRef.current();
    return () => {
      if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [init, portfolio, portfolioFollowing, spending, currentAge, retirementAge, endAge, stocksPct, extraIncome, extraStartAge, expectedPct, volPct, strategy, percentOfPortfolio, guardrailsCutPct, guardrailsRaisePct, guardrailsAdjustmentPct, phaseStartAge, phaseDeclinePct]);

  /* ---------------- Tax Plan write-through (build v140) ----------------
     One source, multiple edit locations: the five plan fields
     (spending, current age, retirement age, end age, expected
     return) live in the Tax Plan record, so an edit here writes
     through to it via saveRothInputs — the record's own writer,
     with its CAS revision. The payload is the fetched record
     itself, flattened (its inputs, execution, market-check,
     gift, and tax-return blocks, minus the execution block's
     read-only rolledOver/clearedYear), with only the five
     fields replaced by the current values. A blank or
     unparseable field keeps the record's current value instead
     of overwriting it with null, so a half-typed edit can never
     blank a stored value. The save is debounced like the
     Retirement autosave and carries the same settled-value
     gate (build v131): it never fires while a plan field is
     focused, and the blur flush below sends it once focus
     leaves a plan field. Saves are serialized through
     rothSaveInFlightRef, and a conflict re-reads the record
     (the sourced effect then re-shows the stored values) and
     says so plainly. When there is no saved Tax Plan record
     yet, there is nothing to write through to and the edit
     stays in this view's record only.

     Build v153 (audit M-4): the queue holds ONLY the
     local deltas (pendingRothSave, a RothPlanDelta) and the
     payload is rebuilt at fire time from the freshest
     fetched record, applying only those deltas — the same
     fix the Playground write-through got for M-3. Before
     this, the payload was built once at queue time from the
     record as it was then, but the mutation read its CAS
     base live at send time: another tab's save landing in
     between advanced the base while the queued payload
     still held the old field values, the server CAS
     accepted the fresh base, and the other tab's edit was
     silently reverted. Now payload and base always describe
     the same record: every field the user did not edit here
     comes from the freshest record at the moment of the
     send. A genuine race that still lands between the
     rebuild and the server's CAS check resolves exactly as
     before — conflict, record re-read, stored values
     re-shown, plain message. */
  const rothRevisionRef = useRef(0);
  // The revision of the freshest FETCHED record — the one a
  // rebuilt payload is spread from. rothRevisionRef can run
  // one save ahead of it (a save result adopts its returned
  // revision immediately; the refetch it triggers lands a
  // moment later), and the fire path holds while the two
  // disagree, so a payload is only ever sent under a base
  // that describes the same record it was built from.
  const rothFetchedRevisionRef = useRef(0);
  const rothSaveTimer = useRef<number | null>(null);
  const pendingRothSave = useRef<RothPlanDelta | null>(null);
  const rothSaveInFlightRef = useRef(false);
  // Build v177 (re-audit NICE-TO-HAVE N-3): consecutive
  // hold polls by firePendingRothSave across BOTH its hold
  // branches (waiting for the in-flight save to settle, and
  // the coherence hold below), bounded by
  // SAVE_HOLD_MAX_POLLS — see the hold branches there.
  const rothHoldPollsRef = useRef(0);
  // Build v151 (audit M-5): the edit currently in
  // flight, so the unmount flush can tell "queued behind the
  // in-flight save" (a newer edit — flush it) from "the
  // in-flight save itself" (already being written).
  const rothSaveInFlightDeltaRef = useRef<RothPlanDelta | null>(null);
  // Build v168 (re-audit SHOULD S-3): the write-through's
  // flush deferred behind its in-flight save, and the flush
  // send itself, held in refs so the unmount cleanup (defined
  // above this section) can reach them. The cleanup, finding
  // an edit queued behind a save still in flight, stores its
  // send in deferredRothFlushRef instead of firing it
  // concurrently under the same not-yet-advanced CAS base —
  // the server accepts exactly one of two same-base saves,
  // and a refused flush is lost silently on an unmounted
  // view. The in-flight call's per-call handlers below
  // consume the slot as that save settles: fire on a landed
  // save or on an error, drop on a conflict (the conflict
  // path's deliberate drop of the stale form's queued edits).
  // sendRothFlushRef carries the ONE flush send (the v162
  // guard-holding fresh-fetch path included), defined below
  // beside buildRothSavePayload, so the immediate flush and
  // the deferred flush are the same code, guard included.
  // Build v188 (re-audit round 3 MUST-4): that send's two
  // payload sends are no longer bare mutate calls — both go
  // through the ONE retrying payload send
  // (sendRothFlushPayload, beside sendRothFlush), so a
  // flush whose own request fails re-arms a retry of itself
  // instead of being dropped (see that send's comment).
  const deferredRothFlushRef = useRef<(() => void) | null>(null);
  const sendRothFlushRef = useRef<(delta: RothPlanDelta) => void>(() => {});
  // Build v196 (re-audit round 3 SHOULD-7): the deferred
  // slot's GIVE-UP timer — the RothConversion slot's shape.
  // Before v196 the slot's only consumer was the in-flight
  // write-through save's own per-call handlers: if that
  // save hung forever (its request neither resolved nor
  // rejected, so no handler ever ran), the deferred edit
  // sat in the slot for the rest of the page's life —
  // never sent and never reported, the exact stranding the
  // N-3 hold bound (build v177) closed for the mounted
  // fire path. The unmount cleanup now ARMS this timer as
  // it stores the deferred send (armDeferredRothFlushGiveUp
  // below): if the in-flight save has not settled within
  // DEFERRED_FLUSH_GIVE_UP_MS, the timer consumes the slot
  // itself and fires the deferred send anyway, through the
  // same retrying flush send (sendRothFlush) a settle
  // would have fired — so the edit is sent, its failure
  // re-arms the flush's own 3 s retry (build v188), and a
  // CAS conflict from sending while the wedged save is
  // still in flight resolves through the mutation's
  // normal conflict path instead of stranding the edit.
  // A settle that lands first consumes the slot through
  // takeDeferredRothFlush, which clears this timer, so a
  // normally-settling save fires the deferred send exactly
  // as before and the timer never fires at all. The timer
  // lives in its own ref, cleared by nothing after
  // unmount, so it outlives the view like the flush retry
  // timer.
  const deferredRothFlushGiveUpTimerRef = useRef<number | null>(null);
  const clearDeferredRothFlushGiveUp = () => {
    if (deferredRothFlushGiveUpTimerRef.current != null) {
      window.clearTimeout(deferredRothFlushGiveUpTimerRef.current);
      deferredRothFlushGiveUpTimerRef.current = null;
    }
  };
  // Consume the deferred slot (and disarm its give-up
  // timer): the ONE way the slot is read, so a settle and
  // the give-up can never both fire the same send.
  const takeDeferredRothFlush = (): (() => void) | null => {
    clearDeferredRothFlushGiveUp();
    const deferred = deferredRothFlushRef.current;
    deferredRothFlushRef.current = null;
    return deferred;
  };
  const armDeferredRothFlushGiveUp = () => {
    clearDeferredRothFlushGiveUp();
    deferredRothFlushGiveUpTimerRef.current = window.setTimeout(() => {
      deferredRothFlushGiveUpTimerRef.current = null;
      const deferred = deferredRothFlushRef.current;
      deferredRothFlushRef.current = null;
      if (deferred) deferred();
    }, DEFERRED_FLUSH_GIVE_UP_MS);
  };
  const focusFieldRef = useRef<string | null>(null);
  useEffect(() => {
    focusFieldRef.current = focusField;
  }, [focusField]);
  useEffect(() => {
    if (rothQ.data) {
      rothRevisionRef.current = rothQ.data.revision;
      rothFetchedRevisionRef.current = rothQ.data.revision;
    }
  }, [rothQ.data]);
  const rothSave = useMutation({
    mutationFn: (input: RothSavePayload) =>
      api.saveRothInputs({ ...input, baseRevision: rothRevisionRef.current }),
    onError: () => {
      // Build v151 (audit M-5): a failed write-through
      // says so instead of vanishing silently. The edit
      // stays queued (the fire path below clears it only on
      // success) and its per-call onError re-arms a retry, so
      // the edit lands once the server is reachable again.
      setPlanMsg("Could not save — your entries stay on this screen.");
    },
    onSuccess: (res) => {
      if (res.ok) {
        rothRevisionRef.current = res.revision;
        // Build v151 (audit M-5), completion: a save landed,
        // so a "Could not save" note from an earlier failed
        // attempt is stale now — clear exactly that note (the
        // Playground write-through does the same with its own
        // message line). Any other plan message — a conflict
        // note, a reset note — is left untouched: this line is
        // shared with the Retirement record's own save flows.
        setPlanMsg((m) =>
          m === "Could not save — your entries stay on this screen." ? "" : m,
        );
        // The Tax Plan view reads the same query key, so it
        // picks the new values up on its next render.
        queryClient.invalidateQueries({ queryKey: ["rothplanner"] });
        return;
      }
      // Conflict: a newer Tax Plan save landed first. Re-read
      // the record — the sourced effect re-shows the stored
      // values — and say plainly what happened. Contract
      // v153: the re-show is a force sync, since the guarded
      // sourced effect would otherwise keep the dropped
      // edits on screen (they differ from the last-synced
      // values by design).
      planForceSyncRef.current = true;
      rothRevisionRef.current = res.revision;
      queryClient.invalidateQueries({ queryKey: ["rothplanner"] });
      setPlanMsg(
        "This plan was changed in the Tax Plan (or another tab), so the edits just made here were not kept. The latest saved version is shown now.",
      );
    },
  });
  const rothSaveMutateRef = useRef(rothSave.mutate);
  rothSaveMutateRef.current = rothSave.mutate;
  const firePendingRothSave = () => {
    const pending = pendingRothSave.current;
    if (!pending) return;
    if (
      focusFieldRef.current != null &&
      PLAN_FIELD_KEYS.includes(focusFieldRef.current)
    ) {
      // Settled-value gate: a plan field is still being edited,
      // so the pending edit may still change. Hold it — the
      // blur flush below sends it once focus leaves.
      return;
    }
    if (rothSaveInFlightRef.current) {
      // Build v177 (re-audit NICE-TO-HAVE N-3): this hold
      // is BOUNDED — the counter and give-up are shared with
      // the coherence hold below (one wait, one bound).
      // Before v177 it re-armed the 300 ms
      // re-check without limit: a save whose call never
      // settles (a hung request — the mutation's promise
      // neither resolves nor rejects, so onSettled never
      // runs and the in-flight flag never clears) held the
      // queued edit behind it forever, polling for the life
      // of the view.
      rothHoldPollsRef.current += 1;
      if (rothHoldPollsRef.current > SAVE_HOLD_MAX_POLLS) {
        rothHoldPollsRef.current = 0;
        if (rothSaveTimer.current != null) {
          window.clearTimeout(rothSaveTimer.current);
          rothSaveTimer.current = null;
        }
        setPlanMsg("Could not save — your entries stay on this screen.");
        return;
      }
      if (rothSaveTimer.current != null) window.clearTimeout(rothSaveTimer.current);
      rothSaveTimer.current = window.setTimeout(firePendingRothSave, 300);
      return;
    }
    // Payload/base coherence (build v153): the mutation
    // sends rothRevisionRef as its CAS base, and that ref
    // adopts a save's returned revision the moment the save
    // lands — one refetch ahead of the fetched record the
    // payload is rebuilt from. While the two disagree, the
    // record here is older than the base, and a payload
    // built from it would carry pre-save values for fields
    // outside the delta under the newer base — the same
    // silent revert, one window narrower. Hold and re-check
    // shortly; the invalidation refetch the save triggered
    // lands and the two describe the same record again.
    // Build v177 (re-audit NICE-TO-HAVE N-3): this
    // coherence hold is BOUNDED by the same counter and
    // give-up as the in-flight hold above (they are one
    // wait: the refetch it waits for is the in-flight
    // save's own invalidation). Before v177 it too re-armed
    // without limit, so a refetch that never landed (a
    // failed invalidation the query layer gave up on) held
    // the queued edit forever. On give-up the edit STAYS
    // queued — a later edit or the blur flush fires it once
    // the record catches up, and the guard itself is
    // untouched: nothing is ever sent under a base that
    // does not describe the record it was built from.
    if (rothFetchedRevisionRef.current !== rothRevisionRef.current) {
      rothHoldPollsRef.current += 1;
      if (rothHoldPollsRef.current > SAVE_HOLD_MAX_POLLS) {
        rothHoldPollsRef.current = 0;
        if (rothSaveTimer.current != null) {
          window.clearTimeout(rothSaveTimer.current);
          rothSaveTimer.current = null;
        }
        setPlanMsg("Could not save — your entries stay on this screen.");
        return;
      }
      if (rothSaveTimer.current != null) window.clearTimeout(rothSaveTimer.current);
      rothSaveTimer.current = window.setTimeout(firePendingRothSave, 300);
      return;
    }
    // Build v153 (audit M-4): rebuild the payload NOW,
    // from the freshest record, applying only the queued
    // deltas. The record may have advanced past the revision
    // the edit was queued against (another tab's save,
    // picked up by the refetch while a field here was
    // focused) — rebuilding here carries that save's values
    // for every field this view did not edit, and the
    // mutation reads its CAS base from the same refetch, so
    // payload and base always describe the same record. A
    // payload snapshotted at queue time must never be sent
    // under a base read later: the server CAS would accept
    // it and silently revert the other tab's edits.
    const payload = buildRothSavePayloadRef.current(pending);
    if (!payload) {
      // Nothing to send: no saved record to write through
      // to, or the fresh record already holds every delta
      // value (another tab saved the same edits first — the
      // edits' goal is met, and every other field is theirs
      // to keep). The owed save is complete either way.
      pendingRothSave.current = null;
      rothHoldPollsRef.current = 0;
      return;
    }
    // Build v151 (audit M-5): the edit stays queued
    // until the save SUCCEEDS — it is not dropped at the
    // call, so a failed save (offline, gateway 500) cannot
    // vanish silently. The per-call handlers below own the
    // queue: success drops the edit, error re-arms a retry
    // of it — and every retry rebuilds its payload fresh at
    // its own fire, so a retry can never resurrect stale
    // field values either.
    rothHoldPollsRef.current = 0;
    rothSaveInFlightRef.current = true;
    rothSaveInFlightDeltaRef.current = pending;
    rothSaveMutateRef.current(payload, {
      onSuccess: (res) => {
        if (res.ok) {
          // The record now holds the payload's five plan
          // values: they become the values the fields are
          // synced to, so the refetch this save triggers
          // re-syncs the form from them instead of reading
          // the saved values back as local edits.
          planSyncedRef.current = {
            annualSpendingCents: payload.annualSpendingCents,
            birthYearPrimary: payload.birthYearPrimary,
            retirementAge: payload.retirementAge,
            endAge: payload.endAge,
            expectedReturnPct:
              Math.round(
                (payload.expectedReturnPct ?? EXPECTED_RETURN_DEFAULT) * 100,
              ) / 100,
          };
        }
        // The save landed (or a conflict re-read the record
        // and re-showed the stored values — the deliberate
        // drop): clear the queue only if it still holds this
        // edit, never a newer one queued behind it.
        if (pendingRothSave.current === pending) {
          pendingRothSave.current = null;
        }
        // Build v168 (re-audit SHOULD S-3): consume a
        // flush the unmount cleanup deferred behind this
        // save — fire it on a landed save (the mutation-level
        // handler has adopted the new revision; the deferred
        // send runs the v162 guard, which now routes it
        // through the fresh-fetch path, so its payload is
        // rebuilt from the record this save just landed),
        // drop it on a conflict (the conflict path re-read
        // the record and re-showed the stored values; the
        // deferred edit is the same stale form's and must not
        // ride out under the adopted base).
        // Build v196: consumed through takeDeferredRothFlush,
        // which also disarms the slot's give-up timer — a
        // save that settles normally leaves no timer behind.
        const deferred = takeDeferredRothFlush();
        if (res.ok && deferred) deferred();
      },
      onError: () => {
        // Keep the edit queued and re-arm a retry on the
        // shared timer, so the save lands once the server is
        // reachable again — rebuilt fresh at that fire, like
        // every send. If a plan field is focused again by
        // then, the settled-value gate holds the retry and
        // the blur flush sends it, exactly as for a first
        // attempt. The mutation-level onError sets the
        // visible message.
        if (pendingRothSave.current === pending) {
          if (rothSaveTimer.current != null) {
            window.clearTimeout(rothSaveTimer.current);
          }
          rothSaveTimer.current = window.setTimeout(firePendingRothSave, 3000);
        }
        // Build v168 (re-audit SHOULD S-3): this save
        // never landed, so the base is unchanged and a flush
        // deferred behind it at unmount fires now — its
        // payload rebuilds from the same fetched record this
        // save's payload was built from, applying only the
        // deferred delta (which may cover fields this save
        // also carried; re-sending them is the same values,
        // and fields it did not carry are the deferred
        // edit's own). No retry of this save was armed above:
        // the queue no longer holds it, the cleanup moved it
        // to the deferred slot.
        // Build v196: consumed through takeDeferredRothFlush,
        // which also disarms the slot's give-up timer.
        const deferred = takeDeferredRothFlush();
        if (deferred) deferred();
      },
      onSettled: () => {
        rothSaveInFlightRef.current = false;
        rothSaveInFlightDeltaRef.current = null;
      },
    });
  };
  const firePendingRothSaveRef = useRef(firePendingRothSave);
  firePendingRothSaveRef.current = firePendingRothSave;
  // The five plan fields as the Tax Plan record stores them,
  // from the current field states (same parsing and clamps as
  // buildSavePayload). A blank or unparseable field yields
  // null, and the caller keeps the record's value for it.
  const planFieldValues = (): {
    annualSpendingCents: number | null;
    birthYearPrimary: number | null;
    retirementAge: number | null;
    endAge: number | null;
    expectedReturnPct: number | null;
  } => {
    const clampAge = (s: string, max: number): number | null => {
      const n = parseNum(s);
      return n != null ? Math.min(max, Math.max(0, Math.round(n))) : null;
    };
    const cur = clampAge(currentAge, 120);
    return {
      annualSpendingCents: parseMoney(spending),
      // Current age is derived from the birth year the record
      // stores (server: age = this year − birth year), so an
      // edited age writes back the implied birth year.
      birthYearPrimary: cur != null ? new Date().getFullYear() - cur : null,
      retirementAge: clampAge(retirementAge, 120),
      endAge: clampAge(endAge, 130),
      expectedReturnPct: parseNum(expectedPct),
    };
  };
  const planFieldValuesRef = useRef(planFieldValues);
  planFieldValuesRef.current = planFieldValues;
  // The local edit this view owes the Tax Plan record
  // (build v153, audit M-4): for each of the five plan
  // fields, the field's parsed target value when it differs
  // from the value the field was last synced to, else null
  // (no local edit — whatever the record holds at fire time
  // stands). A blank or unparseable field parses to null and
  // so carries no delta: it can never blank a stored value,
  // exactly as before. Comparing against the last-synced
  // values, not the current record, is what keeps a field
  // the user never touched from becoming a "delta" just
  // because another tab moved the record under it. Returns
  // null when no field carries a local edit.
  const computePlanDelta = (): RothPlanDelta | null => {
    const synced = planSyncedRef.current;
    if (!synced) return null;
    const values = planFieldValuesRef.current();
    const deltaFor = (
      parsed: number | null,
      was: number | null,
    ): number | null =>
      parsed != null && parsed !== was ? parsed : null;
    const delta: RothPlanDelta = {
      annualSpendingCents: deltaFor(
        values.annualSpendingCents,
        synced.annualSpendingCents,
      ),
      birthYearPrimary: deltaFor(
        values.birthYearPrimary,
        synced.birthYearPrimary,
      ),
      retirementAge: deltaFor(values.retirementAge, synced.retirementAge),
      endAge: deltaFor(values.endAge, synced.endAge),
      expectedReturnPct: deltaFor(
        values.expectedReturnPct,
        synced.expectedReturnPct,
      ),
    };
    return delta.annualSpendingCents == null &&
      delta.birthYearPrimary == null &&
      delta.retirementAge == null &&
      delta.endAge == null &&
      delta.expectedReturnPct == null
      ? null
      : delta;
  };
  // Build the whole-record save payload for a queued delta
  // from the CURRENT fetched record (build v153, audit
  // M-4): the record itself, flattened (its inputs,
  // execution, market-check, gift, and tax-return blocks,
  // minus the execution block's read-only
  // rolledOver/clearedYear), with only the delta's fields
  // replaced by their target values — every other field,
  // the five plan fields included, is the freshest record's.
  // Returns null when there is no saved record to write
  // through to, or when the fresh record already holds the
  // delta's values on every field (nothing left to save —
  // e.g. another tab saved the same edits first).
  const buildRothSavePayload = (
    delta: RothPlanDelta,
    record?: RothPlannerRecord,
  ): RothSavePayload | null => {
    const rp = record ?? rothQ.data;
    if (!rp || !rp.saved) return null;
    const saved = rp.saved;
    const next = {
      annualSpendingCents: delta.annualSpendingCents ?? saved.annualSpendingCents,
      birthYearPrimary: delta.birthYearPrimary ?? saved.birthYearPrimary,
      retirementAge: delta.retirementAge ?? saved.retirementAge,
      endAge: delta.endAge ?? saved.endAge,
      expectedReturnPct: delta.expectedReturnPct ?? saved.expectedReturnPct,
    };
    if (
      next.annualSpendingCents === saved.annualSpendingCents &&
      next.birthYearPrimary === saved.birthYearPrimary &&
      next.retirementAge === saved.retirementAge &&
      next.endAge === saved.endAge &&
      next.expectedReturnPct === saved.expectedReturnPct
    ) {
      return null;
    }
    const { rolledOver: _rolledOver, clearedYear: _clearedYear, ...execution } = rp.execution;
    return {
      ...saved,
      ...execution,
      ...rp.mcCheck,
      ...rp.gift,
      ...rp.taxReturn,
      ...next,
    };
  };
  const buildRothSavePayloadRef = useRef(buildRothSavePayload);
  buildRothSavePayloadRef.current = buildRothSavePayload;
  // The ONE unmount-flush send for a queued write-through
  // delta (build v168: factored out of the cleanup so the
  // immediate flush and the S-3 deferred flush run identical
  // code). The M-4 coherence guard (build v162) rides
  // along unchanged:
  //   - Guard not holding (fetched revision == base): build
  //     from the fetched record and send at once.
  //   - Guard holding: fetch the record fresh, rebuild the
  //     payload from THAT record, adopt its revision as the
  //     base, and only then send. If the fresh fetch fails,
  //     or still returns a record older than the base, the
  //     pending edit is dropped rather than sent stale.
  // A deferred flush (fired when the save it queued behind
  // settles) reaches this with the guard holding after a
  // landed save — the fresh-fetch path is then the normal
  // route, and the payload it builds already contains the
  // just-landed save's values for every field outside the
  // delta.
  //
  // Build v188 (re-audit round 3 MUST-4): the ONE payload
  // send inside the flush, carrying the same retry
  // firePendingRothSave's sends carry. Before v188 both of
  // sendRothFlush's sends were bare
  // rothSaveMutateRef.current(flushPayload) calls with NO
  // per-call handlers — so a flush whose request failed (a
  // network error at the moment of navigation) was dropped
  // outright: the mutation-level onError above set the
  // "Could not save" note on an unmounted view, where
  // nobody could see it, the cleanup had already cleared
  // the delta from the queue, and nothing ever retried, so
  // the edit silently never landed — returning to the view
  // showed the old stored value with no explanation. This
  // send is the flush's firePendingRothSave: its per-call
  // onError re-arms a 3 s retry of the SAME payload,
  // chained per failure exactly as firePendingRothSave's
  // onError re-arms its own retry, so the flush lands once
  // the server is reachable again. The retry timer lives
  // in its own ref, not the shared roth save timer: the
  // cleanup clears that timer as it runs, and nothing runs
  // after unmount to clear this one, so the retries
  // outlive the view. Each attempt goes through this same
  // send (the retry calls back through the ref, so it
  // always reaches the current closure), and the mutation
  // reads its CAS base live from rothRevisionRef at each
  // call — which still describes the record the payload
  // was built from: on the guard-not-holding path the
  // fetched and base revisions were equal at the build,
  // and on the fresh-fetch path sendRothFlush adopts the
  // fresh record's revision as the base before sending,
  // so a retry rides exactly the base its first send did.
  // A conflict is NOT retried: it resolves through
  // onSuccess with res.ok false, where the mutation-level
  // handler has already applied the conflict path's
  // deliberate drop, and re-sending the stale-built
  // payload would fight the newer record the refusal just
  // re-read — the same rule firePendingRothSave's per-call
  // handlers follow. The pre-send drop paths in
  // sendRothFlush (no fresh-enough record on the
  // fresh-fetch path, or a payload the fresh record
  // already satisfies) are unchanged: those are the v162
  // guard's deliberate outcomes, reached before any send
  // exists to retry.
  const rothFlushRetryTimerRef = useRef<number | null>(null);
  const sendRothFlushPayload = (flushPayload: RothSavePayload) => {
    rothSaveMutateRef.current(flushPayload, {
      onError: () => {
        if (rothFlushRetryTimerRef.current != null) {
          window.clearTimeout(rothFlushRetryTimerRef.current);
        }
        rothFlushRetryTimerRef.current = window.setTimeout(() => {
          sendRothFlushPayloadRef.current(flushPayload);
        }, 3000);
      },
    });
  };
  const sendRothFlushPayloadRef = useRef(sendRothFlushPayload);
  sendRothFlushPayloadRef.current = sendRothFlushPayload;
  const sendRothFlush = (pendingFlush: RothPlanDelta) => {
    if (rothFetchedRevisionRef.current === rothRevisionRef.current) {
      const flushPayload = buildRothSavePayloadRef.current(pendingFlush);
      if (flushPayload) {
        sendRothFlushPayload(flushPayload);
      }
    } else {
      const baseAtFlush = rothRevisionRef.current;
      void (async () => {
        let fresh: RothPlannerRecord;
        try {
          fresh = await queryClient.fetchQuery({
            queryKey: ["rothplanner"],
            queryFn: () => api.getRothPlanner({}),
          });
        } catch {
          // No fresh record, no flush — never send the
          // stale-built payload under the fresh base.
          return;
        }
        if (!fresh.saved || fresh.revision < baseAtFlush) {
          // The record on offer is still older than the
          // base the stale payload would have ridden
          // under — dropping the edit is the only safe
          // outcome left.
          return;
        }
        const flushPayload = buildRothSavePayloadRef.current(
          pendingFlush,
          fresh,
        );
        if (!flushPayload) {
          // The fresh record already holds every delta
          // value — the edit's goal is met, and every
          // other field is the fresh record's to keep.
          return;
        }
        // Adopt the fresh record's revision as the base
        // BEFORE the send: the mutation reads its CAS
        // base live from this ref at the call, so payload
        // and base now describe the same record.
        rothRevisionRef.current = fresh.revision;
        rothFetchedRevisionRef.current = fresh.revision;
        sendRothFlushPayload(flushPayload);
      })();
    }
  };
  sendRothFlushRef.current = sendRothFlush;
  const queueRothSave = () => {
    const rp = rothQ.data;
    if (!rp || !rp.saved) return;
    const delta = computePlanDelta();
    if (!delta) {
      // No local edit is owed — the fields match what they
      // were last synced to (the edit was reverted, or the
      // record caught up with it). Clear anything queued:
      // leaving an earlier edit in place here is what let a
      // stale payload stay queued and ride out later under
      // a fresh base (build v153, audit M-4).
      pendingRothSave.current = null;
      return;
    }
    pendingRothSave.current = delta;
    firePendingRothSaveRef.current();
  };
  const queueRothSaveRef = useRef(queueRothSave);
  queueRothSaveRef.current = queueRothSave;
  // Blur flush: when focus leaves a plan field, send any held
  // Tax Plan save — the value is settled now.
  useEffect(() => {
    if (focusField == null || !PLAN_FIELD_KEYS.includes(focusField)) {
      firePendingRothSaveRef.current();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusField]);

  // Reset every Retirement-owned input to the same defaults a
  // fresh first open computes (see the init effect above):
  // portfolio is the Net Worth-following figure (the latest Net
  // Worth total respecting the current Include house & mortgage
  // toggle, minus the 529 bucket) and keeps following Net Worth
  // (it saves as null, like a fresh open), and the built-in
  // defaults for the rest (stocks 95% with its blended
  // volatility, extra income blank (none) with its start age
  // defaulting to 67, the Constant spending strategy at 5% for
  // the percent input, the professional guardrails knobs 120 /
  // 80 / 10, and the phased knobs 75 / 1). The five plan fields
  // — spending, current age, retirement age, end age, expected
  // return — are NOT reset (build v133): they come from the
  // Tax Plan record, so the reset leaves them where the plan
  // has them and saves those values through unchanged. The
  // reset values are saved immediately through the same save
  // action as any other edit, so they persist and the engines
  // re-run on them as soon as state updates. Saved scenarios
  // are NOT touched: the server merges every save with the
  // stored scenarios.
  const handleResetToDefaults = () => {
    if (!data) return;
    const defaultStocks = STOCKS_PCT_DEFAULT;
    // The plan-sourced expected return (build v133): the
    // reset keeps it where the Tax Plan has it. prevBlend
    // records it alongside the blend volatility for the reset
    // mix (95% stocks), so the blend-following effect compares
    // volatility against the right baseline afterwards.
    const exp = sourced.expectedReturnPct;
    const vol = blendedVol(defaultStocks);
    const expStr = String(Math.round(exp * 100) / 100);
    const volStr = String(Math.round(vol * 100) / 100);
    if (saveTimer.current != null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    pendingSave.current = null;
    pendingSaveOkRef.current = null;
    setPortfolio(String(data.defaultPortfolioCents / 100));
    setPortfolioFollowing(true);
    setStocksPct(String(defaultStocks));
    setExtraIncome("");
    setExtraStartAge(String(EXTRA_INCOME_START_AGE_DEFAULT));
    setVolPct(volStr);
    setStrategy("constant");
    setPercentOfPortfolio("5");
    setGuardrailsCutPct(String(GUARDRAILS_CUT_DEFAULT));
    setGuardrailsRaisePct(String(GUARDRAILS_RAISE_DEFAULT));
    setGuardrailsAdjustmentPct(String(GUARDRAILS_ADJUSTMENT_DEFAULT));
    setPhaseStartAge(String(PHASE_START_AGE_DEFAULT));
    setPhaseDeclinePct(String(PHASE_DECLINE_PCT_DEFAULT));
    prevBlend.current = { exp: expStr, vol: volStr };
    setConfirmReset(false);
    const payload: Parameters<typeof api.saveRetirementCalc>[0] = {
      // Null = follow Net Worth, so the reset portfolio is the
      // Net Worth-following figure (latest total minus the 529
      // bucket) and keeps following future snapshots.
      portfolioCents: null,
      // The five plan fields (build v133): carried through
      // at the Tax Plan record's values, not reset.
      spendingCents: sourced.spendingCents,
      currentAge: sourced.currentAge,
      retirementAge: sourced.retirementAge,
      endAge: sourced.endAge,
      stocksPct: defaultStocks,
      extraIncomeCents: EXTRA_INCOME_DEFAULT_CENTS,
      extraIncomeStartAge: EXTRA_INCOME_START_AGE_DEFAULT,
      expectedReturnPct: exp,
      volatilityPct: vol,
      strategy: "constant",
      percentOfPortfolio: 5,
      guardrailsCutPct: GUARDRAILS_CUT_DEFAULT,
      guardrailsRaisePct: GUARDRAILS_RAISE_DEFAULT,
      guardrailsAdjustmentPct: GUARDRAILS_ADJUSTMENT_DEFAULT,
      phaseStartAge: PHASE_START_AGE_DEFAULT,
      phaseDeclinePct: PHASE_DECLINE_PCT_DEFAULT,
    };
    submitSave(payload, (res) => {
      if (!res.ok) return;
      // A remount initialises from the query cache before any
      // background refetch lands, so sync the cached saved inputs
      // to the reset values: leaving and returning then shows the
      // defaults, not the values typed before the reset.
      queryClient.setQueryData<CalcData>(["retirementcalc"], (old) =>
          old
            ? {
                ...old,
                saved: {
                  portfolioCents: payload.portfolioCents,
                  spendingCents: payload.spendingCents,
                  currentAge: payload.currentAge,
                  retirementAge: payload.retirementAge,
                  endAge: payload.endAge,
                  stocksPct: payload.stocksPct,
                  extraIncomeCents: payload.extraIncomeCents,
                  extraIncomeStartAge: payload.extraIncomeStartAge,
                  expectedReturnPct: payload.expectedReturnPct,
                  volatilityPct: payload.volatilityPct,
                  strategy: payload.strategy,
                  percentOfPortfolio: payload.percentOfPortfolio,
                  guardrailsCutPct: payload.guardrailsCutPct,
                  guardrailsRaisePct: payload.guardrailsRaisePct,
                  guardrailsAdjustmentPct: payload.guardrailsAdjustmentPct,
                  phaseStartAge: payload.phaseStartAge,
                  phaseDeclinePct: payload.phaseDeclinePct,
                },
              }
            : old,
      );
    });
  };

  const inputs: SimInputs | null = useMemo(() => {
    // Blank (or unparseable) fields fall back to exactly the
    // values a save + reload produces for them, so the live
    // engines never run a different plan than the saved one:
    // a blank portfolio is saved as null and reloads as the
    // Net Worth-following figure (the latest net worth total
    // minus the 529 bucket). The five plan fields (spending,
    // ages, expected return) are sourced from the Tax Plan
    // record (build v133) and are never blank in practice;
    // the fallbacks below are the same values the sourcing
    // itself falls back to, so they agree. (The Percent
    // strategy never reads the annual spending input — its
    // field is hidden — so a cleared spending field falls back
    // to 0 there, which that strategy ignores.)
    const start = parseMoney(portfolio) ?? (data ? data.defaultPortfolioCents : null);
    const spend =
      parseMoney(spending) ??
      (strategy === "percent" ? 0 : data ? data.defaultSpendingAnnualCents : null);
    const cur = parseNum(currentAge) ?? data?.defaultCurrentAge ?? 55;
    const ret = parseNum(retirementAge) ?? cur;
    const end = parseNum(endAge) ?? 95;
    if (start == null || spend == null) {
      return null;
    }
    if (start < 0 || spend < 0) return null;
    // Ages are clamped to the same ranges the save schema enforces
    // (current/retirement/income-start 0–120, end 0–130), so the
    // results on screen are always computed from the values that
    // will actually be saved — an out-of-range entry like end age
    // 200 cannot show one plan live and silently reload as another.
    const clampAgeLive = (n: number, max: number): number =>
      Math.min(max, Math.max(0, Math.round(n)));
    const curAge = clampAgeLive(cur, 120);
    const retAge = clampAgeLive(ret, 120);
    const endAgeC = clampAgeLive(end, 130);
    if (endAgeC <= curAge) return null;
    // No silent floor (build v66, boundary audit F11): the
    // live engines price the typed value as-is, exactly what a
    // save would store — the old clamp priced $0 for a typed
    // negative without saying so (the writer now refuses a
    // negative outright).
    const extraCents = parseMoney(extraIncome) ?? 0;
    const extraStart = parseNum(extraStartAge);
    const pct = parseNum(percentOfPortfolio);
    return {
      startCents: start,
      spendingCents: spend,
      currentAge: curAge,
      retirementAge: retAge,
      endAge: endAgeC,
      extraIncomeCents: extraCents,
      // An income amount with no start age counts from retirement
      // age — leaving the age blank must not silently drop income
      // the user typed in.
      extraIncomeStartAge:
        extraStart != null
          ? clampAgeLive(extraStart, 120)
          : extraCents > 0
            ? retAge
            : null,
      strategy,
      percentOfPortfolio:
        pct != null ? Math.min(100, Math.max(0, pct)) : 5,
      // Blank knobs run on the professional defaults here too, so
      // the live engines match what a save + reload produces.
      ...effectiveGuardrails(
        parseNum(guardrailsCutPct),
        parseNum(guardrailsRaisePct),
        parseNum(guardrailsAdjustmentPct),
      ),
      // Blank phased knobs run on their defaults (75 / 1) here
      // too, for the same reason.
      ...effectivePhased(parseNum(phaseStartAge), parseNum(phaseDeclinePct)),
    };
  }, [portfolio, spending, currentAge, retirementAge, endAge, extraIncome, extraStartAge, strategy, percentOfPortfolio, guardrailsCutPct, guardrailsRaisePct, guardrailsAdjustmentPct, phaseStartAge, phaseDeclinePct, data]);

  const stocks = Math.min(100, Math.max(0, parseNum(stocksPct) ?? STOCKS_PCT_DEFAULT));
  // A blank expected-return / volatility field means the blended
  // default for the current mix — exactly what a save + reload
  // produces (the save stores null and the loader substitutes the
  // blend). Falling back to 0 here instead would run the live
  // engines on 0% while the saved plan reloads at the blend, so
  // the numbers on screen would silently not be the saved plan.
  const expected = (parseNum(expectedPct) ?? blendedExpected(stocks)) / 100;
  const vol = Math.max(0, (parseNum(volPct) ?? blendedVol(stocks)) / 100);
  // Inclusive horizon (F6, build v99): the priced years run
  // from the current age through the end age, so the count is
  // the age span plus one — the same count the engines run.
  const planYears = inputs ? inputs.endAge - inputs.currentAge + 1 : 0;

  /* ----- Engine C: projection ----- */
  const projection = useMemo(() => {
    if (!inputs) return null;
    const returns = Array.from({ length: planYears }, () => expected);
    const det = simulateDetailed(inputs, returns);
    const path = det.balances;
    const ending = path[path.length - 1] ?? 0;
    // The plan verdict's success test (2026-11-09): the
    // view's own definition of success — every retired year's
    // spending fully funded through the end age — priced by
    // the engines' runNeverRunsOut over this same steady-return
    // path, NOT by the ending balance alone. An ending of
    // exactly $0 still succeeds when that final year was fully
    // funded, and a run whose balance later climbs back above
    // $0 (surplus extra income refilling a floored balance)
    // still falls short: some year's spending went unfunded.
    // shortfallAge is that first unfunded year, found by the
    // same funding test runNeverRunsOut applies (the year's
    // net withdrawal against the balance on hand at its start,
    // det.balances[i]) — the two always agree.
    const neverRunsOut = runNeverRunsOut(inputs, returns);
    // No-retired-years state (2026-11-09, round-9 SHOULD-5):
    // when the retirement age is past the end age, the engine
    // prices zero retired years — no spending is ever tested —
    // yet runNeverRunsOut still returns success, so without a
    // separate flag the verdict would declare "Succeeds"
    // without having priced a single year. hasRetiredYears
    // marks that out: every verdict readout below (the verdict
    // block, the plan summary, the Projection tab's lasts-to
    // readout, and the at-risk indicator) routes through this
    // flag and shows the explicit "No retired years in this
    // projection" state instead of a success. The comparison
    // is strict the other way: the engine prices the end-age
    // year inclusively, so retirementAge == endAge still
    // prices one retired year and is NOT this state.
    const hasRetiredYears = inputs.retirementAge <= inputs.endAge;
    let shortfallAge: number | null = null;
    for (let i = 0; i < det.netWithdrawals.length; i++) {
      if (inputs.currentAge + i < inputs.retirementAge) continue;
      if ((det.netWithdrawals[i] ?? 0) > (path[i] ?? 0)) {
        shortfallAge = inputs.currentAge + i;
        break;
      }
    }
    // No balance-index "lasts to" age is computed here any more
    // (round-9 MUST-1): the first $0 balance in the path is not
    // a funding verdict — it reported a run-out at the age AFTER
    // the end age for a fully funded run ending at exactly $0
    // (the $0 balance sits one index past the end-age year), and
    // it missed a shortfall year whose balance was later refilled
    // by income. Every readout below that states a verdict —
    // the verdict block, the plan summary, the Projection tab's
    // lasts-to readout, and the at-risk indicator — reads
    // neverRunsOut / shortfallAge above instead — except in
    // the no-retired-years state (hasRetiredYears false), where
    // no readout states a success or a shortfall at all. The
    // ending balance stays available as its own figure (ending).
    // Tail disclosure (display-only, percent strategy): the final
    // retired year's gross spending and the first retired year's,
    // from this same path's per-year withdrawals. Null when the
    // plan has no retired year.
    let finalYearSpending: number | null = null;
    let firstRetiredYearSpending: number | null = null;
    let finalYearAge: number | null = null;
    for (let i = 0; i < det.grossWithdrawals.length; i++) {
      if (inputs.currentAge + i < inputs.retirementAge) continue;
      const g = det.grossWithdrawals[i] ?? 0;
      if (firstRetiredYearSpending == null) firstRetiredYearSpending = g;
      finalYearSpending = g;
      finalYearAge = inputs.currentAge + i;
    }
    return {
      path,
      ending,
      neverRunsOut,
      hasRetiredYears,
      shortfallAge,
      finalYearSpending,
      firstRetiredYearSpending,
      finalYearAge,
      chart: path.map((bal, i) => ({ age: inputs.currentAge + i, balance: bal / 100 })),
    };
  }, [inputs, expected, planYears]);

  /* ----- Engine A: historical ----- */
  const historical = useMemo(() => {
    if (!inputs) return null;
    return runHistorical(inputs, stocks);
  }, [inputs, stocks]);

  /* ----- Engine B: Monte Carlo ----- */
  const monteCarlo = useMemo(() => {
    if (!inputs) return null;
    return runMonteCarlo(inputs, expected, vol, mcSeed, MONTE_CARLO_TAB_RUNS);
  }, [inputs, expected, vol, mcSeed]);

  /* ----- Results-changed feedback -----
     The engines recompute synchronously on every keystroke, but
     nothing on screen used to prove it — a changed input and a
     stuck-on-defaults result looked identical. Track a signature
     of the headline numbers; when it changes after the first
     computed render, flash the results area and show the
     "Results updated" pill (rendered in the Calculated-with strip)
     for ~1.6 s after the last change. */
  const headlineSig = !inputs
    ? "invalid"
    : [
        projection?.ending ?? "",
        historical?.neverOutSuccessRate ?? "",
        historical?.medianEnding ?? "",
        monteCarlo?.neverOutSuccessRate ?? "",
        monteCarlo?.p50 ?? "",
      ].join("|");
  const prevHeadline = useRef<string | null>(null);
  useEffect(() => {
    if (!init) return;
    if (prevHeadline.current != null && prevHeadline.current !== headlineSig) {
      setResultsFlash(true);
      if (flashTimer.current != null) window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setResultsFlash(false), 1600);
    }
    prevHeadline.current = headlineSig;
  }, [headlineSig, init]);
  useEffect(() => {
    return () => {
      if (flashTimer.current != null) window.clearTimeout(flashTimer.current);
    };
  }, []);

  /* ----- Max spending solver ----- */
  // A solve re-runs the engines many times over — the guardrails
  // solve scans every $100 step up to its ceiling — so it runs on
  // a snapshot of its arguments that settles 600 ms after the last
  // edit: typing in any field (or the target box) stays responsive
  // and the answer lands on the final values. The solve runs
  // whether or not the Max spending tab is open, because the tab's
  // at-risk indicator is driven by this result: an indicator that
  // only updated after the tab was first opened (or kept a stale
  // solved result from earlier inputs) showed "healthy" for a $0
  // portfolio whose solved maximum is $0 at a 0% achieved rate.
  const [solverSnap, setSolverSnap] = useState<{
    inputs: SimInputs;
    stocks: number;
    expected: number;
    vol: number;
    engine: "historical" | "montecarlo";
    target: string;
    mcSeed: number;
  } | null>(null);
  useEffect(() => {
    if (!inputs) {
      setSolverSnap(null);
      return;
    }
    const snap = {
      inputs,
      stocks,
      expected,
      vol,
      engine: solverEngine,
      target: solverTarget,
      mcSeed,
    };
    const t = window.setTimeout(() => setSolverSnap(snap), 600);
    return () => window.clearTimeout(t);
  }, [inputs, stocks, expected, vol, solverEngine, solverTarget, mcSeed]);

  const solver = useMemo(() => {
    if (!solverSnap) return null;
    const target = parseNum(solverSnap.target);
    if (target == null) return null;
    const clamped = Math.min(100, Math.max(0, target));
    return solveMaxSpending(
      solverSnap.inputs,
      solverSnap.stocks,
      solverSnap.expected,
      solverSnap.vol,
      solverSnap.engine,
      clamped,
      solverSnap.mcSeed,
    );
  }, [solverSnap]);

  // At-risk state for the tabs and pills, from the live engine
  // results. Projection / Historical / Monte Carlo recompute on
  // every edit, so their indicators appear and disappear live; the
  // Max spending indicator follows the settled solver result for
  // the CURRENT inputs (the engine that solved it decides which
  // threshold applies). A settled solve that produces no solution
  // (for example the percent strategy at a $0 portfolio), a solved
  // maximum of $0, or a 0% achieved rate counts as at risk — never
  // as healthy: only an unknown state (no settled snapshot yet, or
  // no valid target to solve against) falls back to the last known
  // state.
  const solverEngineUsed = solverSnap?.engine ?? solverEngine;
  const solverAtRisk: boolean | null =
    solverSnap == null || parseNum(solverSnap.target) == null
      ? null
      : solver == null
        ? true
        : solver.maxSpendingCents <= 0 ||
            successAtRisk(solver.successRate, solverEngineUsed);
  useEffect(() => {
    if (solverAtRisk != null) setLastMaxAtRisk(solverAtRisk);
  }, [solverAtRisk]);
  // "Success" means the same thing everywhere in this view: the
  // money NEVER runs out (the engines' neverOutSuccessRate — every
  // year's withdrawal fully funded). The Historical and Monte
  // Carlo tabs headline that rate, and every badge, pill, tooltip,
  // delta, and comparison below is keyed off it — never the
  // ending-balance-only successRate, under which a run that sat
  // at $0 for years and was later refilled by income still counted
  // as a success. Median / worst / percentile ending balances are
  // unchanged: they still describe the same runs' endings, refill
  // and all.
  const historicalAtRisk =
    historical != null && successAtRisk(historical.neverOutSuccessRate, "historical");
  const monteCarloAtRisk =
    monteCarlo != null && successAtRisk(monteCarlo.neverOutSuccessRate, "montecarlo");
  const maxSpendingAtRisk = solverAtRisk ?? lastMaxAtRisk;
  // Projection has no success rate: it is at risk when its
  // funding test fails — some retired year's spending was not
  // fully funded (neverRunsOut false), the same failure the
  // other engines count. NOT when its ending balance is $0:
  // a fully funded run can end at exactly $0 and succeed, and
  // a shortfall run can end positive after later income refills
  // it (round-9 MUST-1). The projection recomputes on every
  // edit, so this updates live. In the no-retired-years state
  // (round-9 SHOULD-5) the projection is NOT at risk: no year's
  // spending was tested, so there is no shortfall to flag —
  // the ending balance renders as the plain figure.
  const projectionAtRisk =
    projection != null && projection.hasRetiredYears && !projection.neverRunsOut;
// Passed flags for the tab badges (2026-11-09, green ✓): the
  // mirror of the at-risk flags — a tab shows its green ✓ only
  // when it has a computed result AND passes. A null Historical /
  // Monte Carlo engine shows no badge either way (same as its
  // at-risk badge); the no-retired-years Projection likewise
  // shows neither badge. Max Spending follows the same
  // last-known-state fallback the verdict reads, so a tab badge
  // and the verdict can never disagree.
  const projectionPassed =
    projection != null && projection.hasRetiredYears && projection.neverRunsOut;
  const historicalPassed = historical != null && !historicalAtRisk;
  const monteCarloPassed = monteCarlo != null && !monteCarloAtRisk;
  const maxSpendingPassed = !maxSpendingAtRisk;

  // Verdict (2026-11-09, four-pass): "Succeeds" only when all four
  // engine tabs pass. The badge reads the four at-risk flags above
  // exactly as the tab badges do — never re-derived — so the
  // verdict and the tabs can never disagree: a steady path that
  // succeeds while a stress test fails is "At risk", not
  // "Succeeds". A null Historical/Monte Carlo engine is not at
  // risk (same as its tab badge); Max Spending follows its
  // existing last-known-state fallback.
  const verdictAtRisk =
    projection != null &&
    projection.hasRetiredYears &&
    projection.neverRunsOut &&
    (historicalAtRisk || monteCarloAtRisk || maxSpendingAtRisk);

  // Short-form at-risk explanations for the engine tabs (the pill
  // tooltips carry the full version). Null for a healthy tab — a
  // healthy tab has no badge and no risk tooltip.
  const tabTips: Record<Tab, string | null> = {
    projection:
      projectionAtRisk && projection
        ? `At risk: at the assumed return, the money runs out${projection.shortfallAge != null ? ` at age ${projection.shortfallAge}` : ""} — spending is not fully funded before the plan's end age of ${inputs?.endAge ?? "—"}.`
        : null,
    historical:
      historicalAtRisk && historical
        ? `At risk: the money never ran out in ${historical.neverOutSuccessRate.toFixed(1)}% of historical start years — below the ${HIST_AT_RISK_BELOW}% level financial planners generally target.`
        : null,
    montecarlo:
      monteCarloAtRisk && monteCarlo
        ? `At risk: the money never ran out in ${monteCarlo.neverOutSuccessRate.toFixed(1)}% of simulated lifetimes — below the ${MC_AT_RISK_BELOW}% level financial planners generally target.`
        : null,
    maxspending: !maxSpendingAtRisk
      ? null
      : solverAtRisk == null
        ? "At risk on the last solved result for these inputs."
        : solver == null
          ? "At risk: no sustainable spending could be solved for these inputs."
          : solver.maxSpendingCents <= 0
            ? "At risk: the highest sustainable spending solved for these inputs is $0."
            : `At risk: the solved plan's money never ran out in ${solver.successRate.toFixed(1)}% of runs — below the ${solverEngineUsed === "historical" ? HIST_AT_RISK_BELOW : MC_AT_RISK_BELOW}% level financial planners generally target for that test.`,
  };

  // While the Max spending tab is open the solver works from a
  // snapshot that settles 600 ms after the last edit (see above),
  // so for that window the answer on screen belongs to the previous
  // inputs. Detect it so the section can say "Updating…" and dim
  // the stale answer instead of presenting it as current.
  const solverStale =
    tab === "maxspending" &&
    solverSnap != null &&
    inputs != null &&
    (solverSnap.inputs !== inputs ||
      solverSnap.stocks !== stocks ||
      solverSnap.expected !== expected ||
      solverSnap.vol !== vol ||
      solverSnap.engine !== solverEngine ||
      solverSnap.target !== solverTarget ||
      solverSnap.mcSeed !== mcSeed);
  const solverTargetNum = parseNum(solverTarget);
  const solverTargetOutOfRange =
    solverTargetNum != null && (solverTargetNum > 100 || solverTargetNum < 0);

  /* ----- What-if deltas vs the baseline -----
     The working inputs are compared field-by-field with the
     baseline input set (the same save-shaped payload on both
     sides, so a following portfolio is null on both sides). While
     they differ, the baseline's headline figures come from the
     server re-running the engines on the baseline inputs
     (getRetirementBaselineResults) — the deltas below are the
     difference between that run and the live run above, never an
     estimate from the displayed figures alone. When the inputs
     match the baseline exactly, no delta shows anywhere. */
  useEffect(() => {
    if (init && data && data.baseline == null && memBaseline == null) {
      setMemBaseline(buildInputsPayloadRef.current());
    }
  }, [init, data, memBaseline]);
  const baselineInputs: CalcData["baseline"] = data?.baseline ?? memBaseline;
  const baselineKind: "saved" | "session" | null = data?.baseline
    ? data.baselineKind
    : memBaseline
      ? "session"
      : null;
  const baselineShort =
    baselineKind === "saved"
      ? "your saved plan"
      : "the plan as you opened it";
  const currentPayload = init ? buildInputsPayload() : null;
  const INPUT_KEYS = [
    "portfolioCents",
    "spendingCents",
    "currentAge",
    "retirementAge",
    "endAge",
    "stocksPct",
    "extraIncomeCents",
    "extraIncomeStartAge",
    "expectedReturnPct",
    "volatilityPct",
    "strategy",
    "percentOfPortfolio",
    "guardrailsCutPct",
    "guardrailsRaisePct",
    "guardrailsAdjustmentPct",
    "phaseStartAge",
    "phaseDeclinePct",
  ] as const;
  const inputsDifferFromBaseline =
    baselineInputs != null &&
    currentPayload != null &&
    INPUT_KEYS.some((k) => currentPayload[k] !== baselineInputs[k]);
  // The baseline solve is priced with the same solver settings the
  // settled current solve used, so the Max Spending delta compares
  // like with like.
  const baselineSolverEngine = solverSnap?.engine ?? solverEngine;
  const baselineSolverTarget =
    (solverSnap ? parseNum(solverSnap.target) : parseNum(solverTarget)) ?? 95;
  const baselineResultsQ = useQuery({
    queryKey: [
      "retirementbaseline",
      baselineInputs ? JSON.stringify(baselineInputs) : "none",
      mcSeed,
      baselineSolverEngine,
      baselineSolverTarget,
    ],
    queryFn: () =>
      api.getRetirementBaselineResults({
        mcSeed,
        solverEngine: baselineSolverEngine,
        solverTarget: baselineSolverTarget,
      }),
    enabled: inputsDifferFromBaseline && data?.baseline != null,
  });
  const baselineResults =
    inputsDifferFromBaseline && data?.baseline != null
      ? (baselineResultsQ.data ?? null)
      : null;
  const fmtMoneyDeltaVsBaseline = (cur: number, base: number): string => {
    const diff = Math.round(cur) - Math.round(base);
    if (diff === 0) return `Same as ${baselineShort}`;
    const amt = fmt(Math.abs(diff)).replace("−", "");
    return diff > 0
      ? `${amt} above ${baselineShort}`
      : `${amt} below ${baselineShort}`;
  };
  const fmtPtsDeltaVsBaseline = (cur: number, base: number): string => {
    // Displayed basis, like the money delta above and the
    // scenario-card sub-deltas: the difference of the two rates
    // AS PRINTED on their tiles (one decimal), via the shared
    // helper — a raw-float difference can disagree with the
    // tiles by 0.1 pts (tiles 1.7% vs 16.9% differ by −15.2,
    // while raw rates 1.66 vs 16.94 differ by −15.28 → −15.3).
    const diff = displayedRateDeltaPoints(cur, base);
    if (diff === 0) return `Same as ${baselineShort}`;
    return `${diff > 0 ? "+" : "−"}${Math.abs(diff).toFixed(1)} pts vs ${baselineShort}`;
  };
  const projDeltaText =
    baselineResults?.projectionEndingCents != null && projection
      ? fmtMoneyDeltaVsBaseline(
          projection.ending,
          baselineResults.projectionEndingCents,
        )
      : null;
  const histSuccessDeltaText =
    baselineResults?.historicalSuccessRate != null && historical
      ? fmtPtsDeltaVsBaseline(
          historical.neverOutSuccessRate,
          baselineResults.historicalSuccessRate,
        )
      : null;
  const histMedianDeltaText =
    baselineResults?.historicalMedianCents != null && historical
      ? fmtMoneyDeltaVsBaseline(
          historical.medianEnding,
          baselineResults.historicalMedianCents,
        )
      : null;
  const mcSuccessDeltaText =
    baselineResults?.monteCarloSuccessRate != null && monteCarlo
      ? fmtPtsDeltaVsBaseline(
          monteCarlo.neverOutSuccessRate,
          baselineResults.monteCarloSuccessRate,
        )
      : null;
  const maxSpendingDeltaText =
    baselineResults?.maxSpendingCents != null && solver
      ? fmtMoneyDeltaVsBaseline(
          solver.maxSpendingCents,
          baselineResults.maxSpendingCents,
        )
      : null;

  /* ----- Scenario compare stats (same engines, rendered live) ----- */
  const scenarioStats = useMemo(() => {
    if (!data) return [];
    return data.scenarios.map((sc) => {
      const built = buildSimInputs(sc, {
        portfolioCents: data.defaultPortfolioCents,
        spendingCents: data.defaultSpendingAnnualCents,
        defaultCurrentAge: data.defaultCurrentAge,
      });
      if (!built) return { scenario: sc, hist: null, mc: null, projEnding: null, built: null };
      // Projection for this scenario, run exactly as the main
      // Projection result runs for Current inputs: the same
      // simulate engine at the scenario's own expected return
      // held steady — no different parameters.
      const projYears = built.inputs.endAge - built.inputs.currentAge + 1;
      const projPath = simulate(
        built.inputs,
        Array.from({ length: projYears }, () => built.expected),
      );
      return {
        scenario: sc,
        hist: runHistorical(built.inputs, built.stocks),
        mc: runMonteCarlo(built.inputs, built.expected, built.vol, mcSeed, MONTE_CARLO_TAB_RUNS),
        projEnding: projPath[projPath.length - 1] ?? 0,
        built,
      };
    });
  }, [data, mcSeed]);

  // Scenario mutations (F23): request shapes unchanged, but
  // EVERY response now carries blob 1's revision after the
  // attempt — adopt it into the tracked base immediately
  // (success, validation failure, and race failure alike), so
  // the next autosave never conflicts against the view's own
  // scenario write. The invalidation refetch re-syncs it too.
  const saveScenario = useMutation({
    mutationFn: (input: Parameters<typeof api.saveRetirementScenario>[0]) =>
      api.saveRetirementScenario(input),
    onSuccess: (r) => {
      inputsRevisionRef.current = r.revision;
      setScenarioMsg(r.reason);
      queryClient.invalidateQueries({ queryKey: ["retirementcalc"] });
    },
    onError: (e) => setScenarioMsg(String(e)),
  });
  const deleteScenario = useMutation({
    mutationFn: (name: string) => api.deleteRetirementScenario({ name }),
    onSuccess: (r) => {
      inputsRevisionRef.current = r.revision;
      setScenarioMsg(r.reason);
      queryClient.invalidateQueries({ queryKey: ["retirementcalc"] });
    },
    onError: (e) => setScenarioMsg(String(e)),
  });
  const renameScenario = useMutation({
    mutationFn: (input: Parameters<typeof api.renameRetirementScenario>[0]) =>
      api.renameRetirementScenario(input),
    onSuccess: (r) => {
      inputsRevisionRef.current = r.revision;
      setScenarioMsg(r.reason);
      if (r.ok) setRenamingName(null);
      queryClient.invalidateQueries({ queryKey: ["retirementcalc"] });
    },
    onError: (e) => setScenarioMsg(String(e)),
  });

  // Assumptions group collapse toggle: display only, persisted
  // server-side in settings through the same mechanism as the
  // Spending sections' collapse flags (see
  // setRetirementAssumptionsCollapsed). The collapsed value is
  // read straight from the getRetirementCalc response — never
  // copied into local state — so a toggle lands as soon as the
  // query refetches and persists across sessions and devices.
  // Default (no stored value) is collapsed.
  const setAssumptionsCollapsed = useMutation({
    mutationFn: (
      input: Parameters<typeof api.setRetirementAssumptionsCollapsed>[0],
    ) => api.setRetirementAssumptionsCollapsed(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["retirementcalc"] });
    },
  });

  // Optimistic flip for the Assumptions group (build v132):
  // the section re-renders from local state at once; the mutation
  // persists the choice in the background and its refetch then
  // agrees with what is already shown.
  const handleAssumptionsCollapsedChange = (collapsed: boolean) => {
    setAssumptionsOverride(collapsed);
    setAssumptionsCollapsed.mutate({ collapsed });
  };

  // Spending-field unit toggle: display only, persisted
  // server-side in settings through the same mechanism (see
  // setRetirementSpendingUnit). A flip updates the local unit
  // immediately — the field, caption, and helper re-render in
  // the new unit without waiting on the refetch — and writes
  // only the preference: the stored annual spending value is
  // never part of this write.
  const setSpendingUnitPref = useMutation({
    // Build v121 (F3): the flip carries the epoch of the data
    // on screen.
    mutationFn: (
      input: Parameters<typeof api.setRetirementSpendingUnit>[0],
    ) => api.setRetirementSpendingUnit({ ...input, baseEpoch: data?.restoreEpoch ?? 0 }),
    onSuccess: (r) => {
      // A refused flip (a restore since the load) reverts the
      // optimistic local unit to the stored one — the stored
      // preference never moved.
      if (!r.ok) setSpendingUnit(data?.spendingUnit ?? "month");
      queryClient.invalidateQueries({ queryKey: ["retirementcalc"] });
    },
  });

  const handleSpendingUnitChange = (unit: "year" | "month") => {
    setSpendingUnit(unit);
    setSpendingUnitPref.mutate({ unit });
  };

  const handleSaveScenario = () => {
    saveScenario.mutate(buildSavePayloadRef.current());
  };

  // Load an input set into the fields: replace every
  // Retirement-owned input field with the set's values (nulls
  // fall back exactly as a fresh load would interpret them)
  // and persist immediately through the normal save action.
  // Used both by Load-a-scenario and by Back to my plan (with
  // the baseline input set), so going back writes the baseline
  // back through exactly the same path. The five plan fields
  // — spending, current age, retirement age, end age,
  // expected return — are NOT loaded from the scenario
  // (build v133): they come from the Tax Plan record, and
  // the save carries the Tax Plan's values for them, so a
  // scenario can vary only the Retirement-owned inputs — and
  // "Back to my plan" restores the baseline's Retirement-owned
  // inputs while the five plan fields stay where the Tax Plan
  // has them (identical to the baseline's when the plan has
  // not changed since the open).
  const applyPlanInputs = (sc: Omit<Scenario, "name">) => {
    if (!data) return;
    const scStocks = sc.stocksPct ?? STOCKS_PCT_DEFAULT;
    setPortfolio(
      sc.portfolioCents != null
        ? String(sc.portfolioCents / 100)
        : String(data.defaultPortfolioCents / 100),
    );
    // A scenario with no portfolio of its own follows Net Worth
    // (its compare figures already fall back to the Net
    // Worth-following figure); one with a frozen portfolio is a
    // set value, used as-is.
    setPortfolioFollowing(sc.portfolioCents == null);
    setStocksPct(String(scStocks));
    setExtraIncome(
      sc.extraIncomeCents != null && sc.extraIncomeCents > 0
        ? String(sc.extraIncomeCents / 100)
        : "",
    );
    setExtraStartAge(
      sc.extraIncomeStartAge != null ? String(sc.extraIncomeStartAge) : "",
    );
    const volS = sc.volatilityPct ?? blendedVol(scStocks);
    setVolPct(String(Math.round(volS * 100) / 100));
    setStrategy(sc.strategy ?? "constant");
    setPercentOfPortfolio(String(sc.percentOfPortfolio ?? 5));
    setGuardrailsCutPct(String(sc.guardrailsCutPct ?? GUARDRAILS_CUT_DEFAULT));
    setGuardrailsRaisePct(String(sc.guardrailsRaisePct ?? GUARDRAILS_RAISE_DEFAULT));
    setGuardrailsAdjustmentPct(String(sc.guardrailsAdjustmentPct ?? GUARDRAILS_ADJUSTMENT_DEFAULT));
    // A scenario saved before the phased strategy existed has no
    // phased fields: its knobs load as the defaults (75 / 1).
    setPhaseStartAge(String(sc.phaseStartAge ?? PHASE_START_AGE_DEFAULT));
    setPhaseDeclinePct(String(sc.phaseDeclinePct ?? PHASE_DECLINE_PCT_DEFAULT));
    prevBlend.current = {
      exp: String(Math.round(sourced.expectedReturnPct * 100) / 100),
      vol: String(Math.round(blendedVol(scStocks) * 100) / 100),
    };
    if (saveTimer.current != null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    pendingSave.current = null;
    pendingSaveOkRef.current = null;
    const payload: Parameters<typeof api.saveRetirementCalc>[0] = {
      portfolioCents: sc.portfolioCents,
      // The five plan fields (build v133): the Tax Plan
      // record's values, not the scenario's.
      spendingCents: sourced.spendingCents,
      currentAge: sourced.currentAge,
      retirementAge: sourced.retirementAge,
      endAge: sourced.endAge,
      stocksPct: sc.stocksPct,
      extraIncomeCents: sc.extraIncomeCents,
      extraIncomeStartAge: sc.extraIncomeStartAge,
      expectedReturnPct: sourced.expectedReturnPct,
      volatilityPct: sc.volatilityPct,
      strategy: sc.strategy,
      percentOfPortfolio: sc.percentOfPortfolio,
      guardrailsCutPct: sc.guardrailsCutPct,
      guardrailsRaisePct: sc.guardrailsRaisePct,
      guardrailsAdjustmentPct: sc.guardrailsAdjustmentPct,
      phaseStartAge: sc.phaseStartAge,
      phaseDeclinePct: sc.phaseDeclinePct,
    };
    submitSave(payload, (res) => {
      if (!res.ok) return;
      queryClient.setQueryData<CalcData>(["retirementcalc"], (old) =>
        old ? { ...old, saved: { ...payload } } : old,
      );
    });
  };

  const handleLoadScenario = (sc: Scenario) => {
    applyPlanInputs(sc);
    setScenarioMsg(`Loaded ${sc.name}.`);
  };

  /* ----- What-if baseline: Make this my plan / Back to my plan -----
     The baseline is the input set stored server-side (returned by
     getRetirementCalc): the explicitly saved plan after "Make this
     my plan", otherwise the saved inputs as they stood when the
     view was first opened (the server captures that session
     baseline on first open). Autosave keeps working exactly as
     before — it just no longer moves the baseline. */
  const saveBaseline = useMutation({
    mutationFn: (input: Parameters<typeof api.saveRetirementBaseline>[0]) =>
      api.saveRetirementBaseline({
        ...input,
        baseRevision: inputsRevisionRef.current,
        baseBaselineRevision: baselineRevisionRef.current,
      }),
    onSuccess: (r) => {
      if (!r.ok) {
        // Conflict: same rehydrate + notice as the inputs save.
        // On the baseline-stage variant the working inputs WERE
        // saved (only the baseline did not move), and the
        // notice says so.
        applyConflictRecord(r.record);
        setPlanMsg(
          r.stage === "baseline"
            ? "These retirement inputs were changed in another tab or on another device. Your inputs were saved, but 'Make this my plan' did not take — the baseline shown is the latest saved one."
            : "These retirement inputs were changed in another tab or on another device, so the edits that were just saving here were not kept. The latest saved version is shown now.",
        );
        return;
      }
      // Success: adopt BOTH returned revisions (the pair write
      // bumped both records), and sync the cache as before.
      inputsRevisionRef.current = r.revision;
      baselineRevisionRef.current = r.baselineRevision;
      setPlanMsg(
        "This is now your plan — the results are now compared with this plan.",
      );
      queryClient.setQueryData<CalcData>(["retirementcalc"], (old) =>
        old
          ? {
              ...old,
              saved: { ...r.baseline },
              baseline: r.baseline,
              baselineKind: "saved",
              revision: r.revision,
              baselineRevision: r.baselineRevision,
            }
          : old,
      );
      queryClient.invalidateQueries({ queryKey: ["retirementcalc"] });
    },
    onError: (e) => setPlanMsg(String(e)),
  });

  const handleSaveAsMyPlan = () => {
    if (saveTimer.current != null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    pendingSave.current = null;
    pendingSaveOkRef.current = null;
    saveBaseline.mutate(buildInputsPayloadRef.current());
  };

  const handleRestoreMyPlan = () => {
    const base = data?.baseline ?? memBaseline;
    if (!base) return;
    applyPlanInputs(base);
    setPlanMsg("Back to your plan — the inputs are your saved plan again.");
  };

  if (q.isPending) {
    return <p className="py-10 text-center text-[var(--dim)]">Loading retirement calculator…</p>;
  }
  if (q.error || !data) {
    return (
      <div className="mt-5">
        <p className="py-10 text-center text-[var(--bad)]">Something went wrong loading the retirement calculator. Try again.</p>
      </div>
    );
  }

  // Use the same clamped mix the engines use, so the note cannot
  // claim a negative bond share for an out-of-range stocks entry.
  const bondsPct = 100 - stocks;
  const flashCls = resultsFlash
    ? " outline outline-2 outline-[var(--accent)] outline-offset-2"
    : "";
  // Effective guardrails knobs for the helper copy below (blank
  // fields read as their professional defaults, clamped exactly
  // as the engines clamp them).
  const knobEff = effectiveGuardrails(
    parseNum(guardrailsCutPct),
    parseNum(guardrailsRaisePct),
    parseNum(guardrailsAdjustmentPct),
  );
  // Effective phased knobs for the helper copy below (blank
  // fields read as their defaults, clamped exactly as the
  // engines clamp them).
  const knobPhase = effectivePhased(
    parseNum(phaseStartAge),
    parseNum(phaseDeclinePct),
  );

  // Annualised dollar readout for the Percent strategy's helper
  // line: the implied first-retired-year spending is the effective
  // percent of the effective starting portfolio. Both values come
  // from the same effective inputs the engines run (blank
  // portfolio = the net-worth default, blank percent = 5%, percent
  // clamped 0–100), and the rounding matches the engine's
  // Math.round(balance × percent / 100) exactly, so at the default
  // ages (retire = current age) this figure IS the engine's first
  // retired-year withdrawal. When retirement is later the engines
  // grow the balance first, so the copy frames it as "on the
  // starting portfolio" rather than a promised first-year amount.
  // When the live inputs are invalid (inputs is null) the readout
  // still follows the raw fields' effective values, except that a
  // negative portfolio has no meaningful annualised amount.
  const percentEffStartCents =
    inputs?.startCents ?? parseMoney(portfolio) ?? data.defaultPortfolioCents;
  const percentEffPct =
    inputs?.percentOfPortfolio ??
    (() => {
      const rawPct = parseNum(percentOfPortfolio);
      return rawPct != null ? Math.min(100, Math.max(0, rawPct)) : 5;
    })();
  const percentAnnualisedCents =
    percentEffStartCents >= 0
      ? Math.round(percentEffStartCents * (percentEffPct / 100))
      : null;

  /* Starting portfolio note (rendered directly under the field
     through the shared More/Less Explainer pattern, persisted like
     the other Retirement explainers): only the one-line math stays
     always visible — while the field follows Net Worth, "Net Worth
     $X − 529 (college) $Y = $Z used" with live figures; for a
     hand-typed value, "$Z used as-is (your entry)". Everything
     else the note used to show as an always-visible block — that
     the portfolio follows Net Worth (and the house & mortgage
     toggle's effect on that total), why the 529 amount is $0 while
     the latest snapshot is unsplit or has no 529 split, that a
     typed value is used exactly as-is naming the following figure
     it replaces, and that clearing the field or resetting restores
     the following value — lives behind "More", wording kept
     substantively the same. The short line and the expanded text
     both update live with state (following vs typed, house toggle
     on/off, split vs unsplit $0) exactly as the old note did. */
  const excluded529Cents = data.bucket529Cents ?? 0;
  const propertyNote = data.includeProperty
    ? ", house & mortgage included in the Net Worth total"
    : ", property excluded from the Net Worth total";
  const followingMathShort = `Net Worth ${fmt(data.nwTotalCents)} − College / 529 ${fmt(excluded529Cents)} = ${fmt(data.defaultPortfolioCents)} used`;
  const followingMath = `${followingMathShort}${propertyNote}.`;
  const typedPortfolioCents = parseMoney(portfolio);
  const portfolioShortLine = !portfolioFollowing ? (
    <>
      {typedPortfolioCents != null
        ? `${fmt(typedPortfolioCents)} used as-is (your entry)`
        : `${portfolio} used as-is (your entry)`}
    </>
  ) : (
    <>{followingMathShort}</>
  );
  const portfolioMore = !portfolioFollowing ? (
    <>
      <p>
        The value above is used as-is — the College / 529 exclusion is not applied to
        it. It replaces the Net Worth-following figure: {followingMath}
      </p>
      <p>
        Clear the field to follow Net Worth again, or reset to defaults to
        restore the following value.
      </p>
    </>
  ) : excluded529Cents > 0 ? (
    <>
      <p>
        This field follows Net Worth: {followingMath} The College / 529 bucket is
        college money, so it stays out while this field follows Net Worth.
      </p>
      <p>
        Type your own value to use it as-is instead. Clearing the field or
        resetting to defaults restores the following value.
      </p>
    </>
  ) : (
    <>
      <p>
        This field follows Net Worth: {followingMath}{" "}
        {data.latestSnapshotHasAnySplit
          ? "The latest snapshot has no College / 529 split, so nothing is excluded yet."
          : "The College / 529 amount is $0 because the latest snapshot is not split into buckets yet."}
      </p>
      <p>
        Type your own value to use it as-is instead. Clearing the field or
        resetting to defaults restores the following value.
      </p>
    </>
  );

  /* Annual spending provenance note (rendered directly under the
     field through the Explainer pattern): the value comes from
     the Tax Plan record (build v133) — this view uses it
     as-is and never edits it. The visible line is one fixed
     sentence; everything else lives in the ⓘ tooltip: the
     trailing True cost figure (named in both the equals and
     differs detail below), the income-tax note, and — under
     the guardrails strategy — the guardrails base-spending
     note. The trailing figure and its window (start/end
     months, months averaged) come only from the server
     response — the client never recomputes True cost. The
     detail names both figures whenever they differ, so a Tax
     Plan spending set apart from the trailing figure shows
     the gap plainly. */
  const trailingSpendingCents = data.defaultSpendingAnnualCents;
  // The tracked average's monthly presentation for per-month
  // display mode: the annual figure ÷ 12, rounded to cents for
  // display (15000000 annual cents → 1250000 monthly cents).
  const trailingMonthlyCents = Math.round(trailingSpendingCents / 12);
  // A blank (or unparseable) field runs on the trailing figure —
  // exactly the fallback the engines and a save + reload apply —
  // so a blank field is in the equals state, not a third state.
  const effectiveSpendingCents =
    parseMoney(spending) ?? trailingSpendingCents;
  const spendingEqualsTrailing =
    effectiveSpendingCents === trailingSpendingCents;
  const spendingWindowStartLabel = fmtMonthLabel(
    data.defaultSpendingWindowStart,
  );
  const spendingWindowEndLabel = fmtMonthLabel(data.defaultSpendingWindowEnd);
  const spendingWindowDetail =
    spendingWindowStartLabel && spendingWindowEndLabel
      ? `${spendingWindowStartLabel} through ${spendingWindowEndLabel} (${data.defaultSpendingMonths} month${data.defaultSpendingMonths === 1 ? "" : "s"})`
      : "the trailing window";
  const spendingMonthsPhrase =
    data.defaultSpendingMonths === 1
      ? "last 1 month"
      : `last ${data.defaultSpendingMonths} months`;
  const spendingShortLine = (
    <>From the Tax Plan. Edit here — it updates the Tax Plan too.</>
  );
  const spendingTrailingDetail = spendingEqualsTrailing ? (
    <>
      <p>
        This value comes from the Tax Plan — it is the plan&rsquo;s
        annual spending, and this view uses it as-is. To change it,
        edit the value above — it writes through to the Tax Plan,
        which is where the figure lives.
      </p>
      <p>
        It matches your trailing True cost figure:{" "}
        {spendingUnit === "month"
          ? `${fmt(trailingMonthlyCents)}/mo`
          : `${fmt(trailingSpendingCents)} a year`}{" "}
        — the average month over {spendingWindowDetail}, × 12. It is the same True cost the
        dashboard averages: each month&rsquo;s spending with yearly and
        periodic bills spread evenly across the year.
      </p>
    </>
  ) : (
    <>
      <p>
        This value comes from the Tax Plan — it is the plan&rsquo;s
        annual spending, and this view uses it as-is. To change it,
        edit the value above — it writes through to the Tax Plan,
        which is where the figure lives.
      </p>
      <p>
        Your {spendingMonthsPhrase} of spending (True cost) now averages{" "}
        {spendingUnit === "month"
          ? `${fmt(trailingMonthlyCents)}/mo`
          : `${fmt(trailingSpendingCents)} a year`}{" "}
        — the average month over {spendingWindowDetail}, × 12, the same True cost the dashboard
        averages. The two figures are{" "}
        {spendingUnit === "month"
          ? `${fmt(Math.round(Math.abs(effectiveSpendingCents - trailingSpendingCents) / 12))}/mo`
          : fmt(Math.abs(effectiveSpendingCents - trailingSpendingCents))}{" "}
        apart, so the Tax Plan&rsquo;s spending was set to differ from
        the trailing figure — for example, to hold a cost the
        tracker does not.
      </p>
    </>
  );
  /* The ⓘ tooltip's full content: the trailing-average detail
     above, plus the income-tax note and — under the guardrails
     strategy — the guardrails base-spending note. These used to
     sit visibly under the field; they now live only here. */
  const spendingMore = (
    <>
      {spendingTrailingDetail}
      <p>
        Income tax isn&rsquo;t in this figure; in retirement your
        portfolio pays tax on top of spending. The Tax Plan view
        models that tax year by year.
      </p>
      {strategy === "guardrails" && (
        <p>
          Base spending for the guardrails strategy — it adjusts by
          the adjustment size below when the withdrawal rate drifts
          too far from its starting rate.
        </p>
      )}
    </>
  );

  /* Which effective inputs differ from the fresh-open defaults
     (the same values Reset to defaults restores: live portfolio,
     95% stocks with its blended volatility, extra income blank
     (none) with a start age of 67, Constant strategy at 5%).
     The five plan fields — spending, current age, retirement
     age, end age, expected return — are NOT compared here
     (build v133): they come from the Tax Plan record, so
     they ARE the plan values and never count as a diff.
     Compared on the EFFECTIVE values the engines actually use
     — clamped ages, blank return / volatility read as the
     blend — so the strip below never claims "defaults" for a
     plan the engines are not running, or "custom" for one they
     are running as defaults. Fields a strategy does not use
     are not compared (the $ spending under Percent, the %
     under the others, the income start age when there is no
     income). */
  const defaultDiffLabels: string[] = [];
  if (inputs) {
    const volPctShown = Math.round(vol * 10000) / 100;
    if (inputs.startCents !== data.defaultPortfolioCents)
      defaultDiffLabels.push("Starting portfolio");
    if (inputs.strategy !== "constant")
      defaultDiffLabels.push("Spending strategy");
    if (inputs.strategy === "percent") {
      if (inputs.percentOfPortfolio !== 5)
        defaultDiffLabels.push("% of portfolio");
    }
    if (inputs.strategy === "guardrails") {
      if (inputs.guardrailsCutPct !== GUARDRAILS_CUT_DEFAULT)
        defaultDiffLabels.push(`Guardrails cut trigger ${inputs.guardrailsCutPct}%`);
      if (inputs.guardrailsRaisePct !== GUARDRAILS_RAISE_DEFAULT)
        defaultDiffLabels.push(`Guardrails raise trigger ${inputs.guardrailsRaisePct}%`);
      if (inputs.guardrailsAdjustmentPct !== GUARDRAILS_ADJUSTMENT_DEFAULT)
        defaultDiffLabels.push(`Guardrails adjustment size ${inputs.guardrailsAdjustmentPct}%`);
    }
    if (inputs.strategy === "phased") {
      if (inputs.phaseStartAge !== PHASE_START_AGE_DEFAULT)
        defaultDiffLabels.push(`Phased step-down starts at ${inputs.phaseStartAge}`);
      if (inputs.phaseDeclinePct !== PHASE_DECLINE_PCT_DEFAULT)
        defaultDiffLabels.push(`Phased step-down ${inputs.phaseDeclinePct}%/yr`);
    }
    if (stocks !== STOCKS_PCT_DEFAULT) defaultDiffLabels.push("Stocks %");
    if (inputs.extraIncomeCents !== EXTRA_INCOME_DEFAULT_CENTS)
      defaultDiffLabels.push("Extra income");
    if (
      inputs.extraIncomeCents > 0 &&
      inputs.extraIncomeStartAge != null &&
      inputs.extraIncomeStartAge !== EXTRA_INCOME_START_AGE_DEFAULT
    )
      defaultDiffLabels.push("Extra income start age");
    if (volPctShown !== Math.round(blendedVol(STOCKS_PCT_DEFAULT) * 100) / 100)
      defaultDiffLabels.push("Volatility");
  }
  const yAxisFmt = (v: number) => fmtCompact(Math.round(v * 100));
  const tooltipMoney = (v: number) => fmt(Math.round(v * 100));

  // Worst-sequence replay state, derived from the historical runs.
  const worst3 = historical
    ? [...historical.runs].sort((a, b) => a.ending - b.ending).slice(0, 3)
    : [];
  const selectedRun =
    worst3.find((r) => r.startYear === selectedStartYear) ??
    worst3[0] ??
    null;

  const scenarioLine = (sc: Scenario): string => {
    const strat = sc.strategy ?? "constant";
    const scKnobs = effectiveGuardrails(
      sc.guardrailsCutPct,
      sc.guardrailsRaisePct,
      sc.guardrailsAdjustmentPct,
    );
    // A scenario saved before the phased strategy existed has no
    // phased fields: its line and labels resolve to the defaults
    // (75 / 1), exactly as its engines run.
    const scPhase = effectivePhased(sc.phaseStartAge, sc.phaseDeclinePct);
    const spendPart =
      strat === "percent"
        ? `${sc.percentOfPortfolio ?? 5}% of portfolio/yr`
        : strat === "guardrails"
          ? `Guardrails on ${fmt(sc.spendingCents ?? data.defaultSpendingAnnualCents)}/yr (cut ${scKnobs.guardrailsCutPct}%, raise ${scKnobs.guardrailsRaisePct}%, adjust ${scKnobs.guardrailsAdjustmentPct}%)`
          : strat === "phased"
            ? `Phased (declines later) on ${fmt(sc.spendingCents ?? data.defaultSpendingAnnualCents)}/yr, stepping down ${scPhase.phaseDeclinePct}%/yr from age ${scPhase.phaseStartAge}`
            : `${fmt(sc.spendingCents ?? data.defaultSpendingAnnualCents)}/yr`;
    return `Portfolio ${fmt(sc.portfolioCents ?? data.defaultPortfolioCents)} · Spending ${spendPart} · Retire ${sc.retirementAge ?? "—"} · End ${sc.endAge ?? "—"} · ${sc.stocksPct ?? STOCKS_PCT_DEFAULT}% stocks`;
  };

  /* ----- Scenario compare: chart-ready comparison -----
     Entries are Current inputs first, then each saved scenario.
     Every entry runs the SAME two engines, so the charts below are
     an apples-to-apples comparison: same historical start years,
     same Monte Carlo seed. Colours are stable by position and are
     shared by the lines, the bars, and the cards. */
  type CompareEntry = {
    key: string;
    name: string;
    shortName: string;
    color: string;
    isCurrent: boolean;
    scenario: Scenario | null;
    hist: typeof historical;
    mc: typeof monteCarlo;
    projEnding: number | null;
    builtInputs: SimInputs | null;
    builtStocks: number | null;
    builtExpected: number | null;
    builtVol: number | null;
  };
  const compareEntries: CompareEntry[] = [];
  if (inputs) {
    compareEntries.push({
      key: "k0",
      name: "Current inputs",
      shortName: "Current",
      color: COMPARE_COLORS[0] ?? ACCENT,
      isCurrent: true,
      scenario: null,
      hist: historical,
      mc: monteCarlo,
      projEnding: projection?.ending ?? null,
      builtInputs: inputs,
      builtStocks: stocks,
      builtExpected: expected,
      builtVol: vol,
    });
  }
  scenarioStats.forEach((s, i) => {
    compareEntries.push({
      key: `k${i + 1}`,
      name: s.scenario.name,
      // Chart axis labels stay short even for long custom names; the
      // colour key and cards always show the full name.
      shortName:
        s.scenario.name.length > 14
          ? `${s.scenario.name.slice(0, 13)}…`
          : s.scenario.name,
      color: COMPARE_COLORS[i + 1] ?? ACCENT,
      isCurrent: false,
      scenario: s.scenario,
      hist: s.hist,
      mc: s.mc,
      projEnding: s.projEnding ?? null,
      builtInputs: s.built?.inputs ?? null,
      builtStocks: s.built?.stocks ?? null,
      builtExpected: s.built?.expected ?? null,
      builtVol: s.built?.vol ?? null,
    });
  });
  const currentEntry = compareEntries.find((e) => e.isCurrent) ?? null;

  // Median-path overlay data (Historical): one row per age, one
  // column per entry. Ages differ when scenarios plan to different
  // end ages, so rows are the union of ages and missing points stay
  // absent (the line simply ends at that plan's end age).
  const comparePathChart: Record<string, number>[] = (() => {
    const byAge = new Map<number, Record<string, number>>();
    for (const e of compareEntries) {
      if (!e.hist) continue;
      for (const row of e.hist.chart) {
        const age = row.age;
        if (age == null) continue;
        const existing = byAge.get(age) ?? { age };
        if (typeof row.median === "number") existing[e.key] = row.median;
        byAge.set(age, existing);
      }
    }
    return [...byAge.values()].sort((a, b) => (a.age ?? 0) - (b.age ?? 0));
  })();
  const hasPathData = compareEntries.some((e) => e.hist != null);

  const compareSuccessChart = compareEntries.map((e) => ({
    name: e.shortName,
    Historical: e.hist ? Math.round(e.hist.neverOutSuccessRate * 10) / 10 : null,
    MonteCarlo: e.mc ? Math.round(e.mc.neverOutSuccessRate * 10) / 10 : null,
  }));
  const compareEndingChart = compareEntries.map((e) => ({
    name: e.shortName,
    Historical: e.hist ? e.hist.medianEnding / 100 : null,
    MonteCarlo: e.mc ? e.mc.p50 / 100 : null,
  }));

  // Best-in-class markers (ties share the honour).
  const bestHistSuccess = Math.max(
    ...compareEntries.map((e) => e.hist?.neverOutSuccessRate ?? -1),
  );
  const bestMcSuccess = Math.max(
    ...compareEntries.map((e) => e.mc?.neverOutSuccessRate ?? -1),
  );
  const bestHistMedian = Math.max(
    ...compareEntries.map((e) => e.hist?.medianEnding ?? -Infinity),
  );
  const bestMcMedian = Math.max(
    ...compareEntries.map((e) => e.mc?.p50 ?? -Infinity),
  );

  // Scenario-card sub-deltas: computed from the DISPLAYED figures
  // (money rounded to whole cents exactly as fmt prints the tiles,
  // rates rounded to one decimal exactly as the tiles print them),
  // via the shared helpers in retirementEngines, so each sub-delta
  // foots exactly with the two tiles it compares — a raw-float
  // difference can disagree by 1¢ / 0.1 pts in fractional cases.
  const fmtDeltaMoney = (scenarioCents: number, currentCents: number): string => {
    const diffCents = displayedMoneyDeltaCents(scenarioCents, currentCents);
    if (diffCents === 0) return "Same as Current";
    const sign = diffCents > 0 ? "+" : "−";
    return `${sign}${fmt(Math.abs(diffCents)).replace("−", "")} vs Current`;
  };
  const fmtDeltaPct = (scenarioRate: number, currentRate: number): string => {
    const diff = displayedRateDeltaPoints(scenarioRate, currentRate);
    if (diff === 0) return "Same as Current";
    return `${diff > 0 ? "+" : "−"}${Math.abs(diff).toFixed(1)} pts vs Current`;
  };

  // Plain-words differences between a scenario and Current inputs.
  // Only fields that actually differ are listed; an identical
  // scenario says so instead of repeating every number.
  const scenarioDiffs = (e: CompareEntry): string[] => {
    if (e.isCurrent || !e.builtInputs || !currentEntry?.builtInputs) return [];
    const a = e.builtInputs;
    const b = currentEntry.builtInputs;
    const diffs: string[] = [];
    if (a.startCents !== b.startCents)
      diffs.push(`Portfolio ${fmt(a.startCents)} (Current ${fmt(b.startCents)})`);
    if (a.strategy !== b.strategy) {
      const label = (s: SpendingStrategy) =>
        s === "percent"
          ? "Percent of portfolio"
          : s === "guardrails"
            ? "Guardrails"
            : s === "phased"
              ? "Phased (declines later)"
              : "Constant";
      diffs.push(`Strategy ${label(a.strategy)} (Current ${label(b.strategy)})`);
      // Spending still differs in dollars when neither side is the
      // percent strategy (whose spending field means something else).
      if (a.strategy !== "percent" && b.strategy !== "percent" && a.spendingCents !== b.spendingCents) {
        diffs.push(`Spending ${fmt(a.spendingCents)}/yr (Current ${fmt(b.spendingCents)}/yr)`);
      }
      if (a.strategy === "percent" && a.percentOfPortfolio !== b.percentOfPortfolio) {
        diffs.push(`Spends ${a.percentOfPortfolio}%/yr`);
      }
    } else if (a.strategy === "percent") {
      if (a.percentOfPortfolio !== b.percentOfPortfolio)
        diffs.push(`Spends ${a.percentOfPortfolio}%/yr (Current ${b.percentOfPortfolio}%/yr)`);
    } else if (a.spendingCents !== b.spendingCents) {
      diffs.push(`Spending ${fmt(a.spendingCents)}/yr (Current ${fmt(b.spendingCents)}/yr)`);
    }
    // Guardrails knobs are part of the snapshot: name any that
    // differ. When Current also runs Guardrails the comparison is
    // against Current's knobs; when it does not, a knob only earns
    // a chip when it departs from the professional defaults.
    if (a.strategy === "guardrails" && b.strategy === "guardrails") {
      if (a.guardrailsCutPct !== b.guardrailsCutPct)
        diffs.push(`Guardrails cut trigger ${a.guardrailsCutPct}% (Current ${b.guardrailsCutPct}%)`);
      if (a.guardrailsRaisePct !== b.guardrailsRaisePct)
        diffs.push(`Guardrails raise trigger ${a.guardrailsRaisePct}% (Current ${b.guardrailsRaisePct}%)`);
      if (a.guardrailsAdjustmentPct !== b.guardrailsAdjustmentPct)
        diffs.push(`Guardrails adjustment size ${a.guardrailsAdjustmentPct}% (Current ${b.guardrailsAdjustmentPct}%)`);
    } else if (a.strategy === "guardrails") {
      if (a.guardrailsCutPct !== GUARDRAILS_CUT_DEFAULT)
        diffs.push(`Guardrails cut trigger ${a.guardrailsCutPct}%`);
      if (a.guardrailsRaisePct !== GUARDRAILS_RAISE_DEFAULT)
        diffs.push(`Guardrails raise trigger ${a.guardrailsRaisePct}%`);
      if (a.guardrailsAdjustmentPct !== GUARDRAILS_ADJUSTMENT_DEFAULT)
        diffs.push(`Guardrails adjustment size ${a.guardrailsAdjustmentPct}%`);
    }
    // Phased knobs are part of the snapshot too, on the same
    // pattern: compared against Current's knobs when Current also
    // runs Phased, and against the defaults (75 / 1) when it does
    // not — a default knob on a phased scenario is not a
    // difference worth a chip in that case.
    if (a.strategy === "phased" && b.strategy === "phased") {
      if (a.phaseStartAge !== b.phaseStartAge)
        diffs.push(`Step-down starts at ${a.phaseStartAge} (Current ${b.phaseStartAge})`);
      if (a.phaseDeclinePct !== b.phaseDeclinePct)
        diffs.push(`Steps down ${a.phaseDeclinePct}%/yr (Current ${b.phaseDeclinePct}%/yr)`);
    } else if (a.strategy === "phased") {
      if (a.phaseStartAge !== PHASE_START_AGE_DEFAULT)
        diffs.push(`Step-down starts at ${a.phaseStartAge}`);
      if (a.phaseDeclinePct !== PHASE_DECLINE_PCT_DEFAULT)
        diffs.push(`Steps down ${a.phaseDeclinePct}%/yr`);
    }
    if (a.retirementAge !== b.retirementAge)
      diffs.push(`Retires at ${a.retirementAge} (Current ${b.retirementAge})`);
    if (a.currentAge !== b.currentAge)
      diffs.push(`Starts at age ${a.currentAge} (Current ${b.currentAge})`);
    if (a.endAge !== b.endAge)
      diffs.push(`Ends at ${a.endAge} (Current ${b.endAge})`);
    if (e.builtStocks != null && currentEntry.builtStocks != null && e.builtStocks !== currentEntry.builtStocks)
      diffs.push(`${e.builtStocks}% stocks (Current ${currentEntry.builtStocks}%)`);
    // Expected return and volatility are inputs too: a scenario
    // differing only in these changes its Monte Carlo (and
    // Projection) results, so omitting them here would label it
    // "Same inputs as Current" while its figures differ.
    if (e.builtExpected != null && currentEntry.builtExpected != null && Math.abs(e.builtExpected - currentEntry.builtExpected) > 1e-9)
      diffs.push(`Expected return ${(e.builtExpected * 100).toFixed(2)}% (Current ${(currentEntry.builtExpected * 100).toFixed(2)}%)`);
    if (e.builtVol != null && currentEntry.builtVol != null && Math.abs(e.builtVol - currentEntry.builtVol) > 1e-9)
      diffs.push(`Volatility ${(e.builtVol * 100).toFixed(2)}% (Current ${(currentEntry.builtVol * 100).toFixed(2)}%)`);
    const aInc = a.extraIncomeCents;
    const bInc = b.extraIncomeCents;
    if (aInc !== bInc || a.extraIncomeStartAge !== b.extraIncomeStartAge) {
      const incLabel = (cents: number, startAge: number | null) =>
        cents > 0 ? `${fmt(cents)}/yr from ${startAge ?? "retirement"}` : "none";
      diffs.push(`Extra income ${incLabel(aInc, a.extraIncomeStartAge)} (Current ${incLabel(bInc, b.extraIncomeStartAge)})`);
    }
    return diffs;
  };

  /* ----- Scenario card delta line vs Current inputs -----
     One compact line per scenario card, in the same style as
     the comparison-baseline deltas: the Projection ending
     balance ("$X above/below your current inputs") plus the
     Monte Carlo success delta in points. Both deltas are
     computed from the figures the cards and tiles display —
     the Projection endings (rounded to cents exactly as fmt
     displays them) and the Monte Carlo success rates as
     displayed to one decimal — so the line always foots with
     the tiles. A scenario whose inputs equal the current
     inputs gets no delta line: the card's "Same as your
     current inputs" line (rendered with the input diffs)
     says so instead. */
  const scenarioDeltaLine = (e: CompareEntry): string | null => {
    if (e.isCurrent || !e.builtInputs || !currentEntry?.builtInputs) return null;
    if (scenarioDiffs(e).length === 0) return null;
    const parts: string[] = [];
    if (e.projEnding != null && currentEntry.projEnding != null) {
      const diff = Math.round(e.projEnding) - Math.round(currentEntry.projEnding);
      if (diff === 0) {
        parts.push("Projection ending same as your current inputs");
      } else {
        parts.push(
          `Projection ending ${fmt(Math.abs(diff)).replace("−", "")} ${diff > 0 ? "above" : "below"} your current inputs`,
        );
      }
    }
    if (e.mc && currentEntry.mc) {
      const diff = displayedRateDeltaPoints(
        e.mc.neverOutSuccessRate,
        currentEntry.mc.neverOutSuccessRate,
      );
      if (diff === 0) {
        parts.push("Monte Carlo success same as your current inputs");
      } else {
        parts.push(
          `Monte Carlo success ${diff > 0 ? "+" : "−"}${Math.abs(diff).toFixed(1)} pts vs your current inputs`,
        );
      }
    }
    return parts.length > 0 ? parts.join(" · ") : null;
  };

  return (
    <div className="mt-5">
      <h2 className="display flex items-center gap-2 text-3xl font-semibold">
        Retirement calculator
        <ExplainerInfoTip
          id="retirement.intro"
          label="Retirement calculator"
          align="center"
        >
          <p>
            Everything runs in <strong className="text-[var(--text)]">today&rsquo;s (real) dollars</strong> —
            returns are inflation-adjusted, and spending and extra income stay flat in
            today&rsquo;s dollars. Each year, once retired, the plan withdraws
            spending minus extra income (any income above spending is added to
            the portfolio), then that year&rsquo;s real return applies.
            A plan succeeds if every year&rsquo;s spending is fully funded through the end age — the money never comes up short in any year. A run that lands at exactly $0 still counts as succeeding when that year&rsquo;s spending was fully funded by the money on hand: the portfolio is empty, but no year&rsquo;s spending went unfunded. A run counts as not succeeding when a year&rsquo;s spending exceeds the money on hand to fund it — even if the portfolio then sits at $0 and later income refills it, that year&rsquo;s spending was not fully funded, so the money did run out in the sense that matters here.
          </p>
        </ExplainerInfoTip>
      </h2>
      {data?.savedUnreadable && (
        <p
          role="alert"
          className="mt-3 max-w-2xl rounded-[var(--radius)] border border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-sm leading-relaxed"
        >
          <strong>Your saved record can&rsquo;t be read.</strong> A saved
          Retirement plan exists, but it can&rsquo;t be opened — so the
          figures below are the defaults, not your plan. Saving is paused
          while the record is unreadable, so nothing overwrites it.
        </p>
      )}
      {data?.baselineUnreadable && (
        <p
          role="alert"
          className="mt-3 max-w-2xl rounded-[var(--radius)] border border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-sm leading-relaxed"
        >
          <strong>Your saved baseline can&rsquo;t be read.</strong> A
          comparison baseline exists, but it can&rsquo;t be opened — the
          comparisons below treat it as missing, and saving a new baseline
          is paused while it is unreadable.
        </p>
      )}
      {/* Plan verdict (2026-11-09, "Both"): a glanceable
          verdict at the top of the view — a big "lasts until"
          headline with a verdict badge right after it
          on the same line (green "Succeeds" only when all
          four engine tabs pass, amber "At risk" when the
          steady path succeeds but a stress test fails, red
          "Falls short" when the steady path itself falls short),
          plus what's left at the end age below, so the
          verdict reads once and how comfortably the plan
          succeeds is visible in one glance. (The badge once
          stood alone as a pill line above the headline
          repeating the same words; the dedup build folded it
          in after the headline, and the badge is deliberately
          big and bright — text-base bold on a solid accent /
          warn / bad / dim fill with surface-coloured text — so it
          holds its own beside the 3xl/4xl headline.) The
          plan-summary sentence renders inside this panel as a
          small muted line under the amount-left line (it once
          stood alone above the panel); its dotted-underline
          taps are unchanged and its old outcome tail is cut —
          the headline above already states the outcome.
          Display only:
          success is the view's own definition, priced by the
          Projection result's neverRunsOut (the engines'
          runNeverRunsOut over the steady-return path — every
          year's spending fully funded through the end age,
          even a landing at exactly $0; a year whose spending
          exceeded the money on hand falls short even if later
          income refills the balance). The run-out age is the
          first unfunded year (shortfallAge), and what's left
          is the ending balance at the end age. It updates live
          with every edit, like every other result here, and
          renders nothing while the inputs are invalid (there
          is no Projection result to state truthfully). The
          badge is not the Projection result alone (2026-11-09,
          four-pass): "Succeeds" also requires the Historical,
          Monte Carlo, and Max Spending tabs to pass, read from
          their existing at-risk flags, so the verdict can never
          contradict a tab badge; the "At risk" state names the
          failing test(s) in the ⓘ after the badge, reusing
          the tabs' own at-risk explanations; the steady-return note lives in that ⓘ too. The headline, the
          amount-left line, and the Projection tab's "Money
          lasts to" stay judged by neverRunsOut/shortfallAge
          alone. One further state (2026-11-09, round-9
          SHOULD-5): when the
          retirement age is past the end age, no retired year
          was priced at all (the Projection result's
          hasRetiredYears is false), so the block shows the
          headline "No retired years in this projection" with
          a short neutral "No verdict" badge after it, with
          the ending balance still shown as
          its own figure and a note explaining why there is no
          verdict; neither the success nor the falls-short
          wording appears in that state. */}
      <section
        aria-label="Plan verdict and inputs"
        className={`mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5${flashCls}`}
      >
      {inputs && projection && (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="display text-3xl leading-tight font-semibold sm:text-4xl">
              {!projection.hasRetiredYears
                ? "No retired years in this projection"
                : projection.neverRunsOut
                  ? projection.ending > 0
                    ? `Money lasts past ${inputs.endAge}`
                    : `Money lasts to ${inputs.endAge}`
                  : projection.shortfallAge != null
                    ? `Money runs out at ${projection.shortfallAge}`
                    : `Money runs out by ${inputs.endAge}`}
            </p>
            <span className="tnum text-base leading-relaxed">
              <span aria-hidden="true" className="text-[var(--dim)]">·</span>{" "}
              <span className="whitespace-nowrap">
                <span className={`${keyFigureCls} text-[var(--accent)]`}>{fmt(projection.ending)}</span>
                {` left at ${inputs.endAge}`}
              </span>
              {projection.hasRetiredYears && projection.neverRunsOut && projection.ending <= 0 && (
                <span className="text-[var(--dim)]">
                  {" — every year's spending fully funded, with nothing to spare"}
                </span>
              )}
              {projection.hasRetiredYears && !projection.neverRunsOut && projection.shortfallAge != null && (
                <span className="text-[var(--dim)]">
                  {` — runs out ${inputs.endAge - projection.shortfallAge} ${inputs.endAge - projection.shortfallAge === 1 ? "year" : "years"} before the end age`}
                  {projection.ending > 0
                    ? " (later income refills the balance, but that year's spending was not fully funded)"
                    : ""}
                </span>
              )}
            </span>
            {!projection.hasRetiredYears ? (
              <span className="tnum inline-flex max-w-full items-center gap-1.5 rounded-full bg-[var(--dim)] px-4 py-2 text-base font-bold whitespace-nowrap text-[var(--surface)]">
                No verdict
              </span>
            ) : projection.neverRunsOut ? (
              verdictAtRisk ? (
                <span className="tnum inline-flex max-w-full items-center gap-1.5 rounded-full bg-[var(--warn)] px-4 py-2 text-base font-bold whitespace-nowrap text-[var(--surface)]">
                  <span aria-hidden="true">⚠</span>
                  At risk
                </span>
              ) : (
                <span className="tnum inline-flex max-w-full items-center gap-1.5 rounded-full bg-[var(--accent)] px-4 py-2 text-base font-bold whitespace-nowrap text-[var(--surface)]">
                  <span aria-hidden="true">✓</span>
                  Succeeds
                </span>
              )
            ) : (
              <span className="tnum inline-flex max-w-full items-center gap-1.5 rounded-full bg-[var(--bad)] px-4 py-2 text-base font-bold whitespace-nowrap text-[var(--surface)]">
                <span aria-hidden="true">✗</span>
                Falls short
              </span>
            )}
            <ExplainerInfoTip
              id="retirement.verdict"
              label="Plan verdict"
              align="center"
            >
              {verdictAtRisk &&
                [tabTips.historical, tabTips.montecarlo, tabTips.maxspending]
                  .filter((tip): tip is string => tip != null)
                  .map((tip) => (
                    <p key={tip}>{tip}</p>
                  ))}
              <p>
                {`Projection at a steady ${(expected * 100).toFixed(2)}% real return — the same figures as the Projection tab below.`}
              </p>
            </ExplainerInfoTip>
          </div>
          {!projection.hasRetiredYears && (
            <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
              The retirement age is past the end age, so no year&rsquo;s
              spending was tested. Lower the retirement age or raise the
              end age for a verdict.
            </p>
          )}
          <div className="mt-5 border-t border-[var(--border)] pt-5" />
        </>
      )}

      {/* inputs: the header row is the fold header and stays
          visible whether the form is open or hidden — it
          carries the "Plan inputs" title (with the "Results
          updated" pill briefly after an edit), the four
          tiles below it (the collapsed face — the merged
          Calculated-with content: tiles + strategy band +
          residual line), and the fold chevron. Everything
          under the tiles hides when folded, starting with
          the action row (Reset / plan status / Save controls)
          at the top of the panel body, then the autosave
          note, the baseline notes, and the fields grouped
          You / Money / Assumptions. Display only, every
          field keeps its control and behavior exactly as
          before. The verdict banner above is the card's
          always-visible top (2026-11-13 merge); the fold
          hides only the body below the tiles. */}
        <div className="flex flex-wrap items-start gap-2">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-xs font-medium tracking-wide text-[var(--dim)] uppercase">
              Plan inputs
              {resultsFlash && (
                <span className="rounded-full bg-[var(--accent)] px-2.5 py-1 text-xs font-semibold text-white">
                  Results updated
                </span>
              )}
            </h2>
          </div>
          <button
            type="button"
            aria-label={inputsOpen ? "Hide plan inputs" : "Show plan inputs"}
            aria-expanded={inputsOpen}
            aria-controls="retirement-inputs-panel"
            onClick={() => setInputsFolded(inputsOpen)}
            className="ml-auto inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] text-[var(--dim)] hover:text-[var(--accent)] focus-visible:text-[var(--accent)]"
          >
            <FoldChevron open={inputsOpen} />
          </button>
        </div>
        {/* Calculated-with content (2026-11-09, merged into
            this card from its own strip — the strip is gone):
            the results below always declare the exact
            effective inputs that produced them, whether they
            match the fresh-open defaults, and — briefly, after
            an edit changes them — that they just updated (the
            pill in the header). Tiles for the headline
            numbers, a band picturing the spending strategy's
            own mechanics from its real dials, and a residual
            line for the rest — so no fact the old strip
            carried is dropped. */}
        {inputs && (
          <div aria-label="What the results are calculated with" className="mt-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <button
                type="button"
                aria-label="Go to the Starting portfolio field"
                className={calcTileCls}
                onClick={() => jumpToRcField("rc-portfolio")}
              >
                <p className="text-xs text-[var(--dim)]">Portfolio</p>
                <p className={`${keyFigureCls} underline decoration-dotted underline-offset-4`}>
                  {fmt(inputs.startCents)}
                </p>
              </button>
              {/* The Spending tile carries two taps, so it is a
                  framed div rather than one whole-tile button:
                  the figure keeps its strategy-aware jump (the
                  percent field, or the Tax Plan's Annual
                  spending), and the subtitle — now naming the
                  strategy ("Constant strategy", etc.) — is its
                  own tap to this view's spending-strategy
                  selector (rc-strategy), styled like the other
                  tile figures. */}
              <div className={calcTileCls}>
                <button
                  type="button"
                  aria-label={
                    inputs.strategy === "percent"
                      ? "Go to the % of portfolio per year field"
                      : "Go to the Annual spending field in the Tax Plan"
                  }
                  className="block w-full text-left"
                  onClick={() =>
                    inputs.strategy === "percent"
                      ? jumpToRcField("rc-percent")
                      : jumpToTaxPlan("roth-Annual-spending", "household")
                  }
                >
                  <p className="text-xs text-[var(--dim)]">Spending</p>
                  <p className={calcTileValueCls}>
                    {inputs.strategy === "percent" ? (
                      <>
                        {inputs.percentOfPortfolio}% of portfolio/yr
                      </>
                    ) : (
                      <>
                        {fmt(inputs.spendingCents)}
                        /yr
                      </>
                    )}
                  </p>
                </button>
                <button
                  type="button"
                  aria-label={`Spending strategy: ${
                    inputs.strategy === "percent"
                      ? "Percent"
                      : inputs.strategy === "guardrails"
                        ? "Guardrails"
                        : inputs.strategy === "phased"
                          ? "Phased"
                          : "Constant"
                  } — change`}
                  className={`text-xs text-[var(--dim)] ${rcTapCls}`}
                  onClick={() => jumpToRcField("rc-strategy")}
                >
                  {inputs.strategy === "percent"
                    ? "Percent strategy"
                    : inputs.strategy === "guardrails"
                      ? "Guardrails strategy"
                      : inputs.strategy === "phased"
                        ? "Phased strategy"
                        : "Constant strategy"}
                </button>
              </div>
              <button
                type="button"
                aria-label="Go to the Your birth year field in the Tax Plan"
                className={calcTileCls}
                onClick={() => jumpToTaxPlan("roth-Your-birth-year", "household")}
              >
                <p className="text-xs text-[var(--dim)]">Ages</p>
                <p className={calcTileValueCls}>
                  {inputs.currentAge} → retire {inputs.retirementAge} → end{" "}
                  {inputs.endAge}
                </p>
              </button>
              <button
                type="button"
                aria-label="Go to the Expected return field in the Tax Plan"
                className={calcTileCls}
                onClick={() => jumpToTaxPlan("roth-Expected-return", "advanced")}
              >
                <p className="text-xs text-[var(--dim)]">Expected return</p>
                <p className={calcTileValueCls}>
                  {(expected * 100).toFixed(2)}%
                </p>
              </button>
            </div>
            {inputs.strategy === "guardrails" &&
              (() => {
                const raise = inputs.guardrailsRaisePct;
                const cut = inputs.guardrailsCutPct;
                const adj = inputs.guardrailsAdjustmentPct;
                const hi = Math.max(cut * 1.2, raise * 1.6, 100);
                const raisePos = (raise / hi) * 100;
                const cutPos = (cut / hi) * 100;
                const startPos = (100 / hi) * 100;
                return (
                  <div className="mt-3">
                    <p className="text-xs text-[var(--dim)]">
                      Guardrails corridor — each year&rsquo;s withdrawal rate against its starting rate
                    </p>
                    {/* Provenance taps (2026-11-09): each
                        number on the band taps to the field it
                        comes from — Raise to the Raise trigger,
                        Cut to the Cut trigger, the pill to the
                        Adjustment size — with the same dotted
                        underline + scroll-and-flash as the other
                        provenance taps. "start 100%" is the
                        corridor's definition baseline, not a
                        field, so it stays plain. The band's
                        description moves to an sr-only paragraph:
                        the bar itself is now decorative segments
                        plus a real button, so it no longer wears
                        role="img". */}
                    <p className="sr-only">
                      {`Guardrails corridor: spending rises by ${adj}% when the withdrawal rate falls below ${raise}% of its starting rate, and falls by ${adj}% when the rate rises above ${cut}% of its starting rate; between ${raise}% and ${cut}% spending is unchanged.`}
                    </p>
                    <div className="relative mt-1 flex h-10 w-full overflow-hidden rounded-[var(--radius)] border border-[var(--border)]">
                      <div aria-hidden="true" className="h-full bg-[var(--surface-alt)]" style={{ width: `${raisePos}%` }} />
                      <div aria-hidden="true" className="h-full bg-[var(--accent-soft)]" style={{ width: `${Math.max(0, cutPos - raisePos)}%` }} />
                      <div aria-hidden="true" className="h-full flex-1 bg-[var(--warn-soft)]" />
                      <div
                        aria-hidden="true"
                        className="absolute inset-y-0 border-l border-dashed border-[var(--dim)]"
                        style={{ left: `${startPos}%` }}
                      />
                      <button
                        type="button"
                        aria-label="Go to the Adjustment size field"
                        onClick={() => jumpToRcField("rc-guardrails-adjustment")}
                        className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap underline decoration-dotted underline-offset-4 hover:text-[var(--accent)]"
                        style={{ left: `${(raisePos + cutPos) / 2}%` }}
                      >
                        Adjust ±{adj}%
                      </button>
                    </div>
                    <div className="relative mt-1 h-4 text-[11px] whitespace-nowrap text-[var(--dim)]">
                      <button
                        type="button"
                        aria-label="Go to the Raise trigger field"
                        onClick={() => jumpToRcField("rc-guardrails-raise")}
                        className={`absolute -translate-x-1/2 ${rcTapCls}`}
                        style={{ left: `${raisePos}%` }}
                      >
                        Raise {raise}%
                      </button>
                      <span className="absolute -translate-x-1/2" style={{ left: `${startPos}%` }}>
                        start 100%
                      </span>
                      <button
                        type="button"
                        aria-label="Go to the Cut trigger field"
                        onClick={() => jumpToRcField("rc-guardrails-cut")}
                        className={`absolute -translate-x-1/2 ${rcTapCls}`}
                        style={{ left: `${cutPos}%` }}
                      >
                        Cut {cut}%
                      </button>
                    </div>
                  </div>
                );
              })()}
            <p className="tnum mt-2 text-sm">
              <button
                type="button"
                aria-label="Go to the Portfolio mix stocks percent field"
                className={rcTapCls}
                onClick={() => jumpToRcField("rc-stocks")}
              >
                {stocks}% stocks
              </button>
              {" · "}
              <button
                type="button"
                aria-label="Go to the Volatility field"
                className={rcTapCls}
                onClick={() => {
                  // The Assumptions group defaults to collapsed, so
                  // rc-vol is not in the DOM until it opens — expand
                  // it first (persisted, the same as tapping Expand),
                  // then jump with the usual scroll-and-flash.
                  if (assumptionsCollapsed) {
                    handleAssumptionsCollapsedChange(false);
                  }
                  jumpToRcField("rc-vol");
                }}
              >
                Volatility {(vol * 100).toFixed(2)}%
              </button>
              {inputs.extraIncomeCents > 0 ? (
                <>
                  {" · Extra income "}
                  {fmt(inputs.extraIncomeCents)}
                  /yr from age {inputs.extraIncomeStartAge ?? inputs.retirementAge}
                </>
              ) : (
                " · no extra income"
              )}
              {defaultDiffLabels.length > 0 && (
                <>
                  {" "}
                  <ExplainerInfoTip id="retirement.customInputs" label="Custom inputs" align="center">
                    <p>
                      {`Custom inputs — differs from the defaults in: ${defaultDiffLabels.join(", ")}.`}
                    </p>
                  </ExplainerInfoTip>
                </>
              )}
            </p>
            {defaultDiffLabels.length === 0 && (
              <p className="mt-1 text-xs text-[var(--dim)]" aria-live="polite">
                These are the defaults — the same values Reset to defaults restores.
              </p>
            )}
          </div>
        )}
        {inputsOpen && (
          <div id="retirement-inputs-panel">
        <div className="flex flex-wrap items-center gap-2">
          {!confirmReset ? (
            <button
              type="button"
              aria-label="Reset to defaults"
              className="px-1 py-2 text-xs text-[var(--dim)] underline underline-offset-2 hover:text-[var(--accent)]"
              onClick={() => setConfirmReset(true)}
            >
              Reset to defaults
            </button>
          ) : (
            <>
              <span className="text-sm text-[var(--bad)]">Reset all inputs to defaults? This discards your typed values.</span>
              <button
                type="button"
                aria-label="Reset to defaults"
                className="rounded-[var(--radius)] bg-[var(--bad)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                disabled={save.isPending}
                onClick={handleResetToDefaults}
              >
                Reset to defaults
              </button>
              <button
                type="button"
                aria-label="Cancel reset"
                className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium text-[var(--text)]"
                onClick={() => setConfirmReset(false)}
              >
                Cancel
              </button>
            </>
          )}
          {baselineInputs != null &&
          baselineKind === "saved" &&
          !inputsDifferFromBaseline ? (
            <span className="text-sm text-[var(--dim)]">
              This is your saved plan
            </span>
          ) : (
            <>
              <button
                type="button"
                aria-label="Make this my plan"
                className="rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                disabled={saveBaseline.isPending}
                onClick={handleSaveAsMyPlan}
              >
                Make this my plan
              </button>
              {inputsDifferFromBaseline && (
                <button
                  type="button"
                  aria-label="Back to my plan"
                  className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium text-[var(--text)] hover:text-[var(--accent)] disabled:opacity-50"
                  disabled={save.isPending}
                  onClick={handleRestoreMyPlan}
                >
                  Back to my plan
                </button>
              )}
            </>
          )}
          <button
            type="button"
            aria-label="Save current as scenario"
            className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium text-[var(--text)] hover:text-[var(--accent)] disabled:opacity-50"
            disabled={saveScenario.isPending || data.scenarios.length >= 3}
            onClick={handleSaveScenario}
          >
            Save current as scenario
          </button>
          {data.scenarios.length >= 3 && (
            <span className="text-xs text-[var(--dim)]">Maximum 3 scenarios saved — delete one below to save another.</span>
          )}
        </div>
        <p className="mt-3 text-xs text-[var(--dim)]" aria-live="polite">
          {save.isPending ? "Saving…" : init ? "Inputs save automatically, and the results below recalculate as you type." : ""}
          {!inputs && " Check the inputs below — the plan needs a portfolio, spending, and an end age after the current age."}
        </p>
        {baselineInputs != null && inputsDifferFromBaseline && (
          <p className="mt-1 text-xs text-[var(--dim)]">
            {baselineKind === "saved"
              ? "Compared with your saved plan"
              : "Compared with the plan as you opened it"}
            {" — "}
            {baselineKind === "saved"
              ? "the inputs differ, so each results area shows how its headline figure compares. “Back to my plan” puts your saved plan back in the fields. “Make this my plan” makes the current inputs your saved plan."
              : "the inputs differ, so each results area shows how its headline figure compares. “Back to my plan” puts the plan as you opened it back in the fields. “Make this my plan” makes the current inputs your saved plan."}
          </p>
        )}
        {baselineInputs != null &&
          !inputsDifferFromBaseline &&
          baselineKind !== "saved" && (
            <p className="mt-1 text-xs text-[var(--dim)]">
              Compared with the plan as you opened it — change any input to
              see how the results differ from it. “Make this my plan” makes
              the current inputs your saved plan.
            </p>
          )}
        {planMsg && (
          <p className="mt-1 text-xs text-[var(--dim)]" aria-live="polite">
            {planMsg}
          </p>
        )}

        <div className="mt-6 border-t border-[var(--border)] pt-4">
          <h3 className="display text-base font-semibold">You</h3>
          <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-3">
            <div>
              <label htmlFor="rc-current-age" className={labelCls}>Current age</label>
              <input id="rc-current-age" type="text" inputMode="numeric" className={inputCls} value={currentAge} onFocus={() => setFocusField("currentAge")} onBlur={() => setFocusField(null)} onChange={(e) => setCurrentAge(e.target.value)} />
              <p className="mt-1 text-xs text-[var(--dim)]">Your birth year in the Tax Plan sets this age — editing it here updates the birth year there.</p>
            </div>
            <div>
              <label htmlFor="rc-retirement-age" className={labelCls}>Retirement age</label>
              <input id="rc-retirement-age" type="text" inputMode="numeric" className={inputCls} value={retirementAge} onFocus={() => setFocusField("retirementAge")} onBlur={() => setFocusField(null)} onChange={(e) => setRetirementAge(e.target.value)} />
              <p className="mt-1 text-xs text-[var(--dim)]">Later than today? The portfolio grows with no withdrawals until then.</p>
            </div>
            <div>
              <label htmlFor="rc-end-age" className={labelCls}>End age</label>
              <input id="rc-end-age" type="text" inputMode="numeric" className={inputCls} value={endAge} onFocus={() => setFocusField("endAge")} onBlur={() => setFocusField(null)} onChange={(e) => setEndAge(e.target.value)} />
              <p className="mt-1 text-xs text-[var(--dim)]">The age the plan is tested to.</p>
            </div>
          </div>
        </div>

        <div className="mt-6 border-t border-[var(--border)] pt-4">
          <h3 className="display text-base font-semibold">Money</h3>
          <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-3">
            <div>
              <label htmlFor="rc-portfolio" className={labelCls}>Starting portfolio ($)</label>
              <input id="rc-portfolio" type="text" inputMode="decimal" className={inputCls} value={focusField === "portfolio" ? portfolio : formatMoneyDisplay(portfolio)} onFocus={() => setFocusField("portfolio")} onBlur={() => setFocusField(null)} onChange={(e) => { setPortfolio(e.target.value); setPortfolioFollowing(e.target.value.trim() === ""); }} />
              <Explainer
                id="retirement.startingPortfolio"
                label="Starting portfolio"
                className="mt-1"
                small
                summary={portfolioShortLine}
              >
                {portfolioMore}
              </Explainer>
            </div>
            {strategy === "percent" ? (
              <div>
                <label htmlFor="rc-percent" className={labelCls}>% of portfolio per year (%)</label>
                <input id="rc-percent" type="text" inputMode="decimal" className={inputCls} value={focusField === "percent" ? percentOfPortfolio : formatPctDisplay(percentOfPortfolio)} onFocus={() => setFocusField("percent")} onBlur={() => setFocusField(null)} onChange={(e) => setPercentOfPortfolio(e.target.value)} />
                <p className="mt-1 text-xs text-[var(--dim)]">
                  Each retired year, spending is this % of the balance at the start of that year.
                  {percentAnnualisedCents != null && (
                    <> &asymp; {fmt(percentAnnualisedCents)}/yr in the first retired year, on the starting portfolio &mdash; then it rises and falls with the balance.</>
                  )}
                </p>
              </div>
            ) : (
              <div className="col-span-2 lg:col-span-1">
                <div className="mb-1">
                  <span className="block text-sm font-medium text-[var(--text)]">
                    {spendingUnit === "month" ? "Spending per month ($)" : "Annual spending ($)"}
                  </span>
                </div>
                <label htmlFor="rc-spending" className="sr-only">
                  {spendingUnit === "month" ? "Spending per month" : "Annual spending"}
                </label>
                <div className="flex flex-wrap items-center gap-2">
                {/* The textbox is content-sized: its width follows
                    the displayed value's length, floored so the
                    longest yearly figure shows in full, instead of
                    stretching to fill the block. */}
                <div className="shrink-0">
                <input
                  id="rc-spending"
                  type="text"
                  inputMode="decimal"
                  className={inputCls}
                  style={{
                    // One ch per displayed character (digits and
                    // grouping commas) plus one of slack, floored
                    // at eight; the fixed part covers the horizontal
                    // padding (px-3) and the borders. No $ prefix
                    // here — the label carries it.
                    width: `calc(${Math.max((spendingUnit === "month" ? (focusField === "spending" && spendingMonthlyDraft != null ? spendingMonthlyDraft : formatMonthlyDisplay(spending)) : focusField === "spending" ? spending : formatMoneyDisplay(spending)).length + 1, 8)}ch + 1.625rem)`,
                  }}
                  value={
                    spendingUnit === "month"
                      ? focusField === "spending" && spendingMonthlyDraft != null
                        ? spendingMonthlyDraft
                        : formatMonthlyDisplay(spending)
                      : focusField === "spending"
                        ? spending
                        : formatMoneyDisplay(spending)
                  }
                  onFocus={() => {
                    if (spendingUnit === "month") {
                      setSpendingMonthlyDraft(monthlyRaw(spending));
                    }
                    setFocusField("spending");
                  }}
                  onBlur={() => {
                    setSpendingMonthlyDraft(null);
                    setFocusField(null);
                  }}
                  onChange={(e) => {
                    if (spendingUnit === "month") {
                      setSpendingMonthlyDraft(e.target.value);
                      setSpending(monthlyToAnnual(e.target.value));
                    } else {
                      setSpending(e.target.value);
                    }
                  }}
                />
                </div>
                <div
                  role="group"
                  aria-label="Spending display period"
                  className="flex shrink-0 overflow-hidden rounded-[var(--radius)] border border-[var(--border)]"
                >
                  <button
                    type="button"
                    aria-label="Show spending per year"
                    aria-pressed={spendingUnit === "year"}
                    onClick={() => handleSpendingUnitChange("year")}
                    className={`px-2 py-1 text-xs font-medium ${spendingUnit === "year" ? "bg-[var(--accent)] text-white" : "text-[var(--text)] hover:text-[var(--accent)]"}`}
                  >
                    Per year
                  </button>
                  <button
                    type="button"
                    aria-label="Show spending per month"
                    aria-pressed={spendingUnit === "month"}
                    onClick={() => handleSpendingUnitChange("month")}
                    className={`px-2 py-1 text-xs font-medium ${spendingUnit === "month" ? "bg-[var(--accent)] text-white" : "text-[var(--text)] hover:text-[var(--accent)]"}`}
                  >
                    Per month
                  </button>
                </div>
                {spendingUnit === "month" && (
                  <p className="shrink-0 whitespace-nowrap text-xs text-[var(--dim)]">
                    = {fmt(effectiveSpendingCents)}/yr
                  </p>
                )}
                </div>
                <Explainer
                  id="retirement.annualSpending"
                  label="Annual spending"
                  className="mt-1"
                  small
                  summary={spendingShortLine}
                >
                  {spendingMore}
                </Explainer>
                {strategy === "phased" && (
                  <p className="mt-1 text-xs text-[var(--dim)]">
                    Starting spending for the phased strategy — full until the step-down age below, then lower each year.
                  </p>
                )}
              </div>
            )}
            <div>
              <label htmlFor="rc-strategy" className={labelCls}>Spending strategy</label>
              <select
                id="rc-strategy"
                className={inputCls}
                value={strategy}
                onChange={(e) => setStrategy(e.target.value as SpendingStrategy)}
              >
                <option value="constant">Constant</option>
                <option value="percent">Percent of portfolio</option>
                <option value="guardrails">Guardrails</option>
                <option value="phased">Phased (declines later)</option>
              </select>
              <p className="mt-1 text-xs text-[var(--dim)]">
                {strategy === "constant" && "The same inflation-adjusted spending every retired year."}
                {strategy === "percent" && "Spending rises and falls with the portfolio — it cannot hit $0 by construction."}
                {strategy === "guardrails" && `Constant spending, cut ${knobEff.guardrailsAdjustmentPct}% after the withdrawal rate climbs past ${knobEff.guardrailsCutPct}% of its start, raised ${knobEff.guardrailsAdjustmentPct}% below ${knobEff.guardrailsRaisePct}%.`}
                {strategy === "phased" && `Full spending until age ${knobPhase.phaseStartAge}, then ${knobPhase.phaseDeclinePct}% less each year.`}
              </p>
            </div>
            {strategy === "phased" && (
              <>
                <div>
                  <label htmlFor="rc-phase-start" className={labelCls}>Step-down starts at age</label>
                  <input id="rc-phase-start" type="text" inputMode="numeric" className={inputCls} value={phaseStartAge} onChange={(e) => setPhaseStartAge(e.target.value)} placeholder="75" />
                  <p className="mt-1 text-xs text-[var(--dim)]">
                    Spending stays full through this age; the first lower year is the one after. Blank = 75.
                  </p>
                </div>
                <div>
                  <label htmlFor="rc-phase-decline" className={labelCls}>Step down by (%/yr)</label>
                  <input id="rc-phase-decline" type="text" inputMode="decimal" className={inputCls} value={focusField === "phase-decline" ? phaseDeclinePct : formatPctDisplay(phaseDeclinePct)} onFocus={() => setFocusField("phase-decline")} onBlur={() => setFocusField(null)} onChange={(e) => setPhaseDeclinePct(e.target.value)} placeholder="1" />
                  <p className="mt-1 text-xs text-[var(--dim)]">
                    Each year after the start age, spending is this % below the year before. Blank = 1%.
                  </p>
                </div>
                <div className="col-span-2 lg:col-span-3">
                  <p className="text-xs leading-relaxed text-[var(--dim)]">
                    {`Spending stays flat until age ${knobPhase.phaseStartAge}, then declines ${knobPhase.phaseDeclinePct}% a year in today's dollars — most households spend less as they age. Plans will look stronger than with Constant spending; that's the assumption at work, not a promise.`}
                  </p>
                </div>
              </>
            )}
            {strategy === "guardrails" && (
              <>
                <div>
                  <label htmlFor="rc-guardrails-cut" className={labelCls}>Cut trigger (%)</label>
                  <input id="rc-guardrails-cut" type="text" inputMode="decimal" className={inputCls} value={focusField === "guardrails-cut" ? guardrailsCutPct : formatPctDisplay(guardrailsCutPct)} onFocus={() => setFocusField("guardrails-cut")} onBlur={() => setFocusField(null)} onChange={(e) => setGuardrailsCutPct(e.target.value)} placeholder="120" />
                  <p className="mt-1 text-xs text-[var(--dim)]">
                    Adjust spending down when the current withdrawal rate exceeds this % of the starting withdrawal rate. Blank = 120%, the professional default.
                  </p>
                </div>
                <div>
                  <label htmlFor="rc-guardrails-raise" className={labelCls}>Raise trigger (%)</label>
                  <input id="rc-guardrails-raise" type="text" inputMode="decimal" className={inputCls} value={focusField === "guardrails-raise" ? guardrailsRaisePct : formatPctDisplay(guardrailsRaisePct)} onFocus={() => setFocusField("guardrails-raise")} onBlur={() => setFocusField(null)} onChange={(e) => setGuardrailsRaisePct(e.target.value)} placeholder="80" />
                  <p className="mt-1 text-xs text-[var(--dim)]">
                    Adjust spending up when the current withdrawal rate falls below this % of the starting withdrawal rate. Blank = 80%, the professional default.
                  </p>
                </div>
                <div>
                  <label htmlFor="rc-guardrails-adjustment" className={labelCls}>Adjustment size (%)</label>
                  <input id="rc-guardrails-adjustment" type="text" inputMode="decimal" className={inputCls} value={focusField === "guardrails-adjustment" ? guardrailsAdjustmentPct : formatPctDisplay(guardrailsAdjustmentPct)} onFocus={() => setFocusField("guardrails-adjustment")} onBlur={() => setFocusField(null)} onChange={(e) => setGuardrailsAdjustmentPct(e.target.value)} placeholder="10" />
                  <p className="mt-1 text-xs text-[var(--dim)]">
                    Each adjustment changes spending by this % — at most one adjustment per year. Blank = 10%, the professional default.
                  </p>
                </div>
              </>
            )}
            <div>
              <label htmlFor="rc-stocks" className={labelCls}>Portfolio mix — stocks %</label>
              <input id="rc-stocks" type="text" inputMode="decimal" className={inputCls} value={focusField === "stocks" ? stocksPct : formatPctDisplay(stocksPct)} onFocus={() => setFocusField("stocks")} onBlur={() => setFocusField(null)} onChange={(e) => setStocksPct(e.target.value)} aria-describedby="rc-mix-note" />
              <p id="rc-mix-note" className="mt-1 text-xs text-[var(--dim)]">
                Bonds make up the rest: {bondsPct}% bonds.
              </p>
            </div>
            <div>
              <label htmlFor="rc-extra-income" className={labelCls}>Extra income ($/yr, optional)</label>
              <input id="rc-extra-income" type="text" inputMode="decimal" className={inputCls} value={focusField === "extra-income" ? extraIncome : formatMoneyDisplay(extraIncome)} onFocus={() => setFocusField("extra-income")} onBlur={() => setFocusField(null)} onChange={(e) => setExtraIncome(e.target.value)} placeholder="Blank = none" />
              <p className="mt-1 text-xs text-[var(--dim)]">Social Security or a pension, in today&rsquo;s dollars. Blank = none.</p>
            </div>
            <div>
              <label htmlFor="rc-extra-start" className={labelCls}>Extra income starts at age</label>
              <input id="rc-extra-start" type="text" inputMode="numeric" className={inputCls} value={extraStartAge} onChange={(e) => setExtraStartAge(e.target.value)} placeholder="e.g. 67" />
              <p className="mt-1 text-xs text-[var(--dim)]">Defaults to 67 (Social Security). Blank = starts at your retirement age.</p>
            </div>
          </div>
        </div>

        <div className="mt-6 border-t border-[var(--border)] pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="display text-base font-semibold">Assumptions</h3>
            <button
              type="button"
              aria-label={assumptionsCollapsed ? "Expand Assumptions" : "Collapse Assumptions"}
              aria-expanded={!assumptionsCollapsed}
              aria-controls="rc-assumptions-fields"
              onClick={() => handleAssumptionsCollapsedChange(!assumptionsCollapsed)}
              className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-medium text-[var(--text)] hover:text-[var(--accent)]"
            >
              {assumptionsCollapsed ? "Expand" : "Collapse"}
            </button>
          </div>
          {!assumptionsCollapsed && (
            <div id="rc-assumptions-fields" className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-3">
              <div>
                <label htmlFor="rc-expected-return" className={labelCls}>Expected real return (%)</label>
                <input id="rc-expected-return" type="text" inputMode="decimal" className={inputCls} value={focusField === "expectedPct" ? expectedPct : formatPctDisplay(expectedPct)} onFocus={() => setFocusField("expectedPct")} onBlur={() => setFocusField(null)} onChange={(e) => setExpectedPct(e.target.value)} />
                <p className="mt-1 text-xs text-[var(--dim)]">Used by Projection &amp; Monte Carlo.</p>
              </div>
              <div>
                <label htmlFor="rc-vol" className={labelCls}>Volatility (%)</label>
                <input id="rc-vol" type="text" inputMode="decimal" className={inputCls} value={focusField === "vol" ? volPct : formatPctDisplay(volPct)} onFocus={() => setFocusField("vol")} onBlur={() => setFocusField(null)} onChange={(e) => setVolPct(e.target.value)} />
                <p className="mt-1 text-xs text-[var(--dim)]">Monte Carlo only. Blend default: stocks 18%, bonds 6%. Blank = the blend default for your mix.</p>
              </div>
            </div>
          )}
        </div>
          </div>
        )}
      </section>

      {/* tabs — Option C (underline text tabs): all four modes in one
          row, active mode bold with a teal underline, inactive modes
          quiet muted text, hairline divider under the row. Visual
          only — selected-mode state, persistence, and calculations
          are unchanged. To revert to the segmented pill, restyle
          this group container and its buttons only. */}
      <div
        role="group"
        aria-label="Calculator engine"
        className="mt-4 flex w-full flex-nowrap items-end border-b border-[var(--border)]"
      >
        {(
          [
            ["projection", "Projection", projectionAtRisk, projectionPassed],
            ["historical", "Historical", historicalAtRisk, historicalPassed],
            ["montecarlo", "Monte Carlo", monteCarloAtRisk, monteCarloPassed],
            ["maxspending", "Max Spending", maxSpendingAtRisk, maxSpendingPassed],
          ] as [Tab, string, boolean, boolean][]
        ).map(([t, label, atRisk, passed]) => {
          const selected = tab === t;
          const tip = atRisk ? tabTips[t] : null;
          const tipOpen = tip != null && tipTab === t;
          return (
          <button
            key={t}
            type="button"
            aria-label={
              atRisk
                ? `${label} engine — at risk`
                : passed
                  ? `${label} engine — passed`
                  : `${label} engine`
            }
            aria-pressed={selected}
            aria-describedby={tipOpen ? `rc-tab-tip-${t}` : undefined}
            onClick={() => setTab(t)}
            onMouseEnter={() => {
              if (tip) setTipTab(t);
            }}
            onMouseLeave={() => {
              setTipTab((cur) => (cur === t ? null : cur));
            }}
            onFocus={() => {
              if (tip) setTipTab(t);
            }}
            onBlur={() => {
              setTipTab((cur) => (cur === t ? null : cur));
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setTipTab(null);
            }}
            className={`relative inline-flex min-w-0 flex-1 items-center justify-center gap-1 px-1 py-2.5 text-[13px] whitespace-nowrap sm:flex-none sm:justify-start sm:gap-1.5 sm:px-3.5 sm:text-sm ${selected ? "font-semibold text-[var(--text)]" : "font-medium text-[var(--dim)] hover:text-[var(--accent)]"}`}
          >
            {selected && (
              <span
                aria-hidden="true"
                className="absolute right-1 -bottom-px left-1 h-[2px] bg-[var(--accent)] sm:right-2 sm:left-2"
              />
            )}
            <span
              data-at-risk-label={atRisk ? t : undefined}
              style={atRisk && !selected ? { color: "var(--bad)" } : undefined}
            >
              {label}
            </span>
            {atRisk && (
              <span
                aria-hidden="true"
                data-at-risk-warning={t}
                data-at-risk-badge={t}
                onClick={(e) => {
                  // Tapping the badge toggles its tooltip without
                  // switching tabs; tapping anywhere else on the
                  // tab still selects it as before.
                  e.stopPropagation();
                  setTipTab((cur) => (cur === t ? null : t));
                }}
                className="inline-flex h-5 w-5 shrink-0 cursor-help items-center justify-center rounded-full text-[11px] leading-none"
                style={{ backgroundColor: "#dc2626", color: "#ffffff" }}
              >
                ⚠
              </span>
            )}
            {!atRisk && passed && (
              <span
                aria-hidden="true"
                data-pass-badge={t}
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] leading-none"
                style={{ backgroundColor: "var(--accent)", color: "#ffffff" }}
              >
                ✓
              </span>
            )}
            {tipOpen && tip && (
              <TipBubble id={`rc-tab-tip-${t}`} text={tip} below />
            )}
          </button>
          );
        })}
      </div>

      {inputs && tab === "projection" && projection && (
        <section aria-label="Projection results" className={`mt-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5${flashCls}`}>
          {/* Stat strip (build v70): the same figures the
              bordered tiles used to carry — ending balance,
              assumed return, lasts-to, and the percent strategy's
              final-year spending — in ONE compact wrapping row,
              so the chart below sits higher on the page. The
              delta line and the runs-out note stay with their
              figures as quiet inline text. */}
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1.5">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <p className="text-[10.5px] font-medium tracking-[0.02em] text-[var(--dim)] uppercase">Ending balance at {inputs.endAge}</p>
              {projectionAtRisk ? (
                <AtRiskEndingPill shortfallAge={projection.shortfallAge} endAge={inputs.endAge} ending={projection.ending} />
              ) : (
                <p className={keyFigureCls}>{fmt(projection.ending)}</p>
              )}
              {projDeltaText && (
                <p className="text-xs font-medium text-[var(--dim)]">{projDeltaText}</p>
              )}
            </div>
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <p className="text-[10.5px] font-medium tracking-[0.02em] text-[var(--dim)] uppercase">Assumed real return</p>
              <p className="tnum display text-base font-semibold">
                {(expected * 100).toFixed(2)}% / yr
              </p>
            </div>
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <p className="text-[10.5px] font-medium tracking-[0.02em] text-[var(--dim)] uppercase">Money lasts to</p>
              <p className="tnum display text-base font-semibold">
                {!projection.hasRetiredYears
                  ? "—"
                  : !projection.neverRunsOut
                    ? projection.shortfallAge != null
                      ? `Age ${projection.shortfallAge}`
                      : `By age ${inputs.endAge}`
                    : projection.ending > 0
                      ? `Age ${inputs.endAge}+`
                      : `Age ${inputs.endAge}`}
              </p>
              {projection.hasRetiredYears && !projection.neverRunsOut && (
                <p className="text-xs text-[var(--dim)]">The portfolio runs out at this age at a steady {(expected * 100).toFixed(2)}% real return.</p>
              )}
            </div>
            {inputs.strategy === "percent" && projection.finalYearSpending != null && (
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <p className="text-[10.5px] font-medium tracking-[0.02em] text-[var(--dim)] uppercase">Final-year spending (age {projection.finalYearAge})</p>
                <p className="tnum display text-base font-semibold">{fmt(projection.finalYearSpending)}</p>
              </div>
            )}
          </div>
          {inputs.strategy === "percent" && (
            <PercentTailWarning
              finalYearSpending={projection.finalYearSpending}
              firstRetiredYearSpending={projection.firstRetiredYearSpending}
            />
          )}
          <ul className="sr-only">
            <li>{`Projection: ending balance ${fmt(projection.ending)} at age ${inputs.endAge}`}</li>
            {inputs.strategy === "percent" && projection.finalYearSpending != null && (
              <li>{`Projection: final-year spending ${fmt(projection.finalYearSpending)} at age ${projection.finalYearAge}`}</li>
            )}
          </ul>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5" aria-label="Projection chart legend">
            <span className="inline-flex items-center gap-1.5 text-sm font-medium">
              <LegendLineSwatch stroke={ACCENT} strokeWidth={2.2} />
              {`Projected balance — ${(expected * 100).toFixed(2)}%/yr real return`}
            </span>
          </div>
          <div className="mt-3 max-w-full overflow-x-auto">
            <div className="h-[320px] min-w-[560px]">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={projection.chart} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
                  <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="age" type="number" domain={["dataMin", "dataMax"]} tick={{ fill: "var(--dim)", fontSize: 12 }} tickLine={false} axisLine={{ stroke: "var(--border)" }} label={{ value: "Age", position: "insideBottomRight", offset: -2, fill: "var(--dim)", fontSize: 12 }} />
                  <YAxis width={76} tick={{ fill: "var(--text)", fontSize: 12 }} tickLine={false} axisLine={false} tickFormatter={yAxisFmt} />
                  <Tooltip
                    content={(tp: { active?: boolean; label?: number; payload?: { value?: number }[] }) => {
                      if (!tp.active) return null;
                      const v = tp.payload?.[0]?.value;
                      if (v == null) return null;
                      return (
                        <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm shadow-lg">
                          <p className="font-semibold">Age {tp.label}</p>
                          <p className="tnum mt-0.5">Balance {tooltipMoney(v)}</p>
                        </div>
                      );
                    }}
                  />
                  <Area type="monotone" dataKey="balance" name="Balance" stroke={ACCENT} strokeWidth={2.2} fill={ACCENT} fillOpacity={0.14} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
        </section>
      )}

      {inputs && tab === "historical" && historical && (
        <section aria-label="Historical results" className={`mt-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5${flashCls}`}>
          <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
            <div className="rounded-[var(--radius)] border border-[var(--border)] p-3.5">
              <p className="text-[10.5px] font-medium tracking-[0.02em] text-[var(--dim)] uppercase">Success rate</p>
              {successAtRisk(historical.neverOutSuccessRate, "historical") ? (
                <p className="mt-1.5"><AtRiskPill rate={historical.neverOutSuccessRate} engine="historical" /></p>
              ) : (
                <p className="tnum display mt-1.5 text-xl font-semibold">{historical.neverOutSuccessRate.toFixed(1)}%</p>
              )}
              <p className="mt-1 text-xs text-[var(--dim)]">Across {historical.count} historical start years</p>
              {histSuccessDeltaText && (
                <p className="mt-1 text-xs font-medium text-[var(--dim)]">{histSuccessDeltaText}</p>
              )}
            </div>
            <div className="rounded-[var(--radius)] border border-[var(--border)] p-3.5">
              <p className="text-[10.5px] font-medium tracking-[0.02em] text-[var(--dim)] uppercase">Median ending balance</p>
              <p className="tnum display mt-1.5 text-xl font-semibold">{fmt(historical.medianEnding)}</p>
              {histMedianDeltaText && (
                <p className="mt-1 text-xs font-medium text-[var(--dim)]">{histMedianDeltaText}</p>
              )}
            </div>
            {inputs.strategy === "percent" && historical.medianFinalYearSpending != null && (
              <div className="rounded-[var(--radius)] border border-[var(--border)] p-3.5">
                <p className="text-[10.5px] font-medium tracking-[0.02em] text-[var(--dim)] uppercase">Median final-year spending</p>
                <p className="tnum display mt-1.5 text-xl font-semibold">{fmt(historical.medianFinalYearSpending)}</p>
                <p className="mt-1 text-xs text-[var(--dim)]">Median across runs, in the final year (age {inputs.endAge})</p>
              </div>
            )}
            <div className="rounded-[var(--radius)] border border-[var(--border)] p-3.5">
              <p className="text-[10.5px] font-medium tracking-[0.02em] text-[var(--dim)] uppercase">Worst ending balance</p>
              <p className="tnum display mt-1.5 text-xl font-semibold">{fmt(historical.worstEnding)}</p>
            </div>
            <div className="rounded-[var(--radius)] border border-[var(--border)] p-3.5">
              <p className="text-[10.5px] font-medium tracking-[0.02em] text-[var(--dim)] uppercase">Worst start year</p>
              <p className="tnum display mt-1.5 text-xl font-semibold">{historical.worstStartYear}</p>
            </div>
            {inputs.strategy === "percent" && historical.lowestSpending != null && (
              <div className="rounded-[var(--radius)] border border-[var(--border)] p-3.5">
                <p className="text-[10.5px] font-medium tracking-[0.02em] text-[var(--dim)] uppercase">Lowest yearly spending</p>
                <p className="tnum display mt-1.5 text-xl font-semibold">{fmt(historical.lowestSpending)}</p>
                <p className="mt-1 text-xs text-[var(--dim)]">Smallest yearly spending in any run</p>
              </div>
            )}
            {inputs.strategy === "percent" && historical.averageSpending != null && (
              <div className="rounded-[var(--radius)] border border-[var(--border)] p-3.5">
                <p className="text-[10.5px] font-medium tracking-[0.02em] text-[var(--dim)] uppercase">Average yearly spending</p>
                <p className="tnum display mt-1.5 text-xl font-semibold">{fmt(historical.averageSpending)}</p>
                <p className="mt-1 text-xs text-[var(--dim)]">Median across runs of each run&rsquo;s average</p>
              </div>
            )}
          </div>
          {inputs.strategy === "percent" && (
            <PercentTailWarning
              finalYearSpending={historical.medianFinalYearSpending}
              firstRetiredYearSpending={historical.medianFirstRetiredYearSpending}
            />
          )}
          {inputs.strategy === "percent" && (
            <p className="mt-3 text-sm text-[var(--dim)]">
              Note: percent-of-portfolio spending cannot hit $0 by construction — each year spends a percentage of what remains, so spending shrinks as the balance falls.
            </p>
          )}
          <Explainer
            id="retirement.historical"
            label="Historical results"
            className="mt-3"
            summary="Every historical start year was replayed — a 100% success rate is not a guarantee about the future."
          >
            <p>
              Every start year with a full {planYears}-year sequence was replayed ({historical.count} start years,
              {" "}{historical.runs[0]?.startYear ?? ""}–{historical.runs[historical.runs.length - 1]?.startYear ?? ""}).
              A 100% success rate means the money never ran out in any of those past periods — it is not a guarantee about the future.
              Thin lines are individual start years; the highlighted line is the median balance at each age.
              {selectedRun && <> The red line is the selected worst sequence (starting {selectedRun.startYear}).</>}
            </p>
          </Explainer>
          <ul className="sr-only">
            <li>{`Historical: success ${historical.neverOutSuccessRate.toFixed(1)} percent over ${historical.count} start years, median ending ${fmt(historical.medianEnding)}, worst ending ${fmt(historical.worstEnding)} starting ${historical.worstStartYear}`}</li>
            {inputs.strategy === "percent" && historical.medianFinalYearSpending != null && (
              <li>{`Historical: median final-year spending ${fmt(historical.medianFinalYearSpending)}`}</li>
            )}
          </ul>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5" aria-label="Historical chart legend">
            <span className="inline-flex items-center gap-1.5 text-sm font-medium">
              <LegendLineSwatch stroke={HIST_LINE_COLOR} strokeWidth={1} />
              {`Individual start years (${historical.count} runs, ${historical.runs[0]?.startYear ?? ""}–${historical.runs[historical.runs.length - 1]?.startYear ?? ""})`}
            </span>
            <span className="inline-flex items-center gap-1.5 text-sm font-medium">
              <LegendLineSwatch stroke={ACCENT} strokeWidth={2.4} />
              Median
            </span>
            <span className="inline-flex items-center gap-1.5 text-sm font-medium">
              <LegendLineSwatch stroke={WORST_COLOR} strokeWidth={2.6} />
              {`Selected worst sequence (${selectedRun?.startYear ?? historical.worstStartYear})`}
            </span>
          </div>
          <div className="mt-3 max-w-full overflow-x-auto">
            <div className="h-[320px] min-w-[560px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={historical.chart} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
                  <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="age" type="number" domain={["dataMin", "dataMax"]} tick={{ fill: "var(--dim)", fontSize: 12 }} tickLine={false} axisLine={{ stroke: "var(--border)" }} />
                  <YAxis width={76} tick={{ fill: "var(--text)", fontSize: 12 }} tickLine={false} axisLine={false} tickFormatter={yAxisFmt} />
                  {historical.runs.map((r) => {
                    const isSelected = selectedRun != null && r.startYear === selectedRun.startYear;
                    return (
                      <Line
                        key={r.startYear}
                        type="monotone"
                        dataKey={`r${r.startYear}`}
                        stroke={isSelected ? WORST_COLOR : HIST_LINE_COLOR}
                        strokeWidth={isSelected ? 2.6 : 1}
                        strokeOpacity={isSelected ? 1 : 0.28}
                        dot={false}
                        isAnimationActive={false}
                        legendType="none"
                      />
                    );
                  })}
                  <Line type="monotone" dataKey="median" name="Median" stroke={ACCENT} strokeWidth={2.4} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Worst sequences replay */}
          <div className="mt-5">
            <h3 className="display text-base font-semibold">Worst sequences</h3>
            <p className="mt-1 text-sm text-[var(--dim)]">
              The 3 start years with the lowest ending balances. Select one to highlight its line on the chart and replay it year by year.
            </p>
            <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Worst sequences">
              {worst3.map((r) => (
                <button
                  key={r.startYear}
                  type="button"
                  aria-label={`Replay starting ${r.startYear}`}
                  aria-pressed={selectedRun != null && selectedRun.startYear === r.startYear}
                  onClick={() => setSelectedStartYear(r.startYear)}
                  className={`rounded-[var(--radius)] border px-3 py-2 text-sm font-medium ${selectedRun != null && selectedRun.startYear === r.startYear ? "border-[var(--bad)] bg-[var(--bad)] text-white" : "border-[var(--border)] bg-[var(--surface)] text-[var(--text)] hover:text-[var(--accent)]"}`}
                >
                  <span className="tnum">{r.startYear} · {fmt(r.ending)}</span>
                </button>
              ))}
            </div>
            {selectedRun && (
              <div className="mt-3 overflow-x-auto">
                <table className="tnum w-full min-w-[680px] border-collapse text-sm">
                  <caption className="sr-only">{`Year-by-year replay for the retirement starting in ${selectedRun.startYear}`}</caption>
                  <thead>
                    <tr className="border-b border-[var(--border)] text-left">
                      <th scope="col" className="py-2 pr-3 font-semibold">Calendar year</th>
                      <th scope="col" className="py-2 pr-3 font-semibold">Age</th>
                      <th scope="col" className="py-2 pr-3 text-right font-semibold">Blended real return %</th>
                      <th scope="col" className="py-2 pr-3 text-right font-semibold">Balance start</th>
                      <th scope="col" className="py-2 pr-3 text-right font-semibold">Net withdrawal</th>
                      <th scope="col" className="py-2 text-right font-semibold">Year-end balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedRun.returns.map((ret, i) => (
                      <tr key={i} className="border-b border-[var(--border)]">
                        <td className="py-1.5 pr-3">{selectedRun.startYear + i}</td>
                        <td className="py-1.5 pr-3">{inputs.currentAge + i}</td>
                        <td className="py-1.5 pr-3 text-right">{(ret * 100).toFixed(2)}%</td>
                        <td className="py-1.5 pr-3 text-right">{fmt(selectedRun.path[i] ?? 0)}</td>
                        <td className="py-1.5 pr-3 text-right">{fmt(selectedRun.netWithdrawals[i] ?? 0)}</td>
                        <td className="py-1.5 text-right">{fmt(selectedRun.path[i + 1] ?? 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <p className="mt-3 text-xs leading-relaxed text-[var(--dim)]">
            Historical data: {HISTORICAL_SOURCE_NAME}. Source:{" "}
            <a href={HISTORICAL_SOURCE_URL} target="_blank" rel="noreferrer" className="text-[var(--accent)] underline underline-offset-2">
              {HISTORICAL_SOURCE_URL}
            </a>{" "}
            (stocks &amp; bonds) and U.S. Bureau of Labor Statistics CPI-U annual averages (inflation).
            Nominal returns are converted to real returns as (1 + nominal) ÷ (1 + inflation) − 1, then blended by the mix.
            Spot checks vs. source: 2008 stocks −36.55%; 2022 stocks −18.04% and bonds −17.83%.
          </p>
        </section>
      )}

      {inputs && tab === "historical" && !historical && (
        <section aria-label="Historical results" className="mt-3 rounded-[var(--radius)] border border-dashed border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5">
          <p className="text-sm text-[var(--dim)]">
            No historical run fits this plan: the dataset covers{" "}
            {HISTORICAL[0]?.year}–{HISTORICAL[HISTORICAL.length - 1]?.year} (
            {HISTORICAL.length} years), so the longest plan it can replay in
            full is {HISTORICAL.length} years — this plan runs {planYears}{" "}
            years. Shorten the span (a later current age or an earlier end
            age) to use the historical engine; Projection and Monte Carlo
            have no such limit.
          </p>
        </section>
      )}

      {inputs && tab === "montecarlo" && monteCarlo && (
        <section aria-label="Monte Carlo results" className={`mt-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5${flashCls}`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="grid flex-1 grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
              <div className="rounded-[var(--radius)] border border-[var(--border)] p-3.5">
                <p className="text-[10.5px] font-medium tracking-[0.02em] text-[var(--dim)] uppercase">Success rate</p>
                {successAtRisk(monteCarlo.neverOutSuccessRate, "montecarlo") ? (
                  <p className="mt-1.5"><AtRiskPill rate={monteCarlo.neverOutSuccessRate} engine="montecarlo" tip={`The money never ran out in ${monteCarlo.neverOutSuccessRate.toFixed(1)}% of 1,000 simulated lifetimes — below the 85% level financial planners generally target for Monte Carlo tests. Below that line, more simulated lifetimes run out of money before the end age.`} /></p>
                ) : (
                  <p className="tnum display mt-1.5 text-xl font-semibold">{monteCarlo.neverOutSuccessRate.toFixed(1)}%</p>
                )}
                <p className="mt-1 text-xs text-[var(--dim)]">Of 1,000 runs</p>
                {mcSuccessDeltaText && (
                  <p className="mt-1 text-xs font-medium text-[var(--dim)]">{mcSuccessDeltaText}</p>
                )}
              </div>
              <div className="rounded-[var(--radius)] border border-[var(--border)] p-3.5">
                <p className="text-[10.5px] font-medium tracking-[0.02em] text-[var(--dim)] uppercase">10th percentile ending</p>
                <p className="tnum display mt-1.5 text-xl font-semibold">{fmt(monteCarlo.p10)}</p>
              </div>
              <div className="rounded-[var(--radius)] border border-[var(--border)] p-3.5">
                <p className="text-[10.5px] font-medium tracking-[0.02em] text-[var(--dim)] uppercase">Median ending (50th)</p>
                <p className="tnum display mt-1.5 text-xl font-semibold">{fmt(monteCarlo.p50)}</p>
              </div>
              <div className="rounded-[var(--radius)] border border-[var(--border)] p-3.5">
                <p className="text-[10.5px] font-medium tracking-[0.02em] text-[var(--dim)] uppercase">90th percentile ending</p>
                <p className="tnum display mt-1.5 text-xl font-semibold">{fmt(monteCarlo.p90)}</p>
              </div>
              {inputs.strategy === "percent" && monteCarlo.medianFinalYearSpending != null && (
                <div className="rounded-[var(--radius)] border border-[var(--border)] p-3.5">
                  <p className="text-[10.5px] font-medium tracking-[0.02em] text-[var(--dim)] uppercase">Median final-year spending</p>
                  <p className="tnum display mt-1.5 text-xl font-semibold">{fmt(monteCarlo.medianFinalYearSpending)}</p>
                  <p className="mt-1 text-xs text-[var(--dim)]">Median across runs, in the final year (age {inputs.endAge})</p>
                </div>
              )}
              {inputs.strategy === "percent" && monteCarlo.lowestSpending != null && (
                <div className="rounded-[var(--radius)] border border-[var(--border)] p-3.5">
                  <p className="text-[10.5px] font-medium tracking-[0.02em] text-[var(--dim)] uppercase">Lowest yearly spending</p>
                  <p className="tnum display mt-1.5 text-xl font-semibold">{fmt(monteCarlo.lowestSpending)}</p>
                  <p className="mt-1 text-xs text-[var(--dim)]">Smallest yearly spending in any run</p>
                </div>
              )}
              {inputs.strategy === "percent" && monteCarlo.averageSpending != null && (
                <div className="rounded-[var(--radius)] border border-[var(--border)] p-3.5">
                  <p className="text-[10.5px] font-medium tracking-[0.02em] text-[var(--dim)] uppercase">Average yearly spending</p>
                  <p className="tnum display mt-1.5 text-xl font-semibold">{fmt(monteCarlo.averageSpending)}</p>
                  <p className="mt-1 text-xs text-[var(--dim)]">Median across runs of each run&rsquo;s average</p>
                </div>
              )}
            </div>
            <button
              type="button"
              aria-label="Re-run Monte Carlo"
              className={btnPrimary}
              onClick={() => setMcSeed((s) => s + 1)}
            >
              Re-run
            </button>
          </div>
          {inputs.strategy === "percent" && (
            <PercentTailWarning
              finalYearSpending={monteCarlo.medianFinalYearSpending}
              firstRetiredYearSpending={monteCarlo.medianFirstRetiredYearSpending}
            />
          )}
          {inputs.strategy === "percent" && (
            <p className="mt-3 text-sm text-[var(--dim)]">
              Note: percent-of-portfolio spending cannot hit $0 by construction — each year spends a percentage of what remains, so spending shrinks as the balance falls.
            </p>
          )}
          <Explainer
            id="retirement.monteCarlo"
            label="Monte Carlo results"
            className="mt-3"
            summary={
              <>
                1,000 simulated lifetimes with random annual real returns (mean {(expected * 100).toFixed(2)}%, volatility {(vol * 100).toFixed(2)}%).
              </>
            }
          >
            <p>
              1,000 lifetimes with annual real returns drawn from a normal distribution
              (mean {(expected * 100).toFixed(2)}%, volatility {(vol * 100).toFixed(2)}%).
              The fan shows the 10–90 band, the darker 25–75 band, and the median.
            </p>
          </Explainer>
          <ul className="sr-only">
            <li>{`Monte Carlo: success ${monteCarlo.neverOutSuccessRate.toFixed(1)} percent, ending percentiles 10th ${fmt(monteCarlo.p10)}, median ${fmt(monteCarlo.p50)}, 90th ${fmt(monteCarlo.p90)}`}</li>
            {inputs.strategy === "percent" && monteCarlo.medianFinalYearSpending != null && (
              <li>{`Monte Carlo: median final-year spending ${fmt(monteCarlo.medianFinalYearSpending)}`}</li>
            )}
          </ul>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5" aria-label="Monte Carlo chart legend">
            <span className="inline-flex items-center gap-1.5 text-sm font-medium">
              <LegendLineSwatch stroke={ACCENT} strokeWidth={2.4} />
              Median (50th percentile)
            </span>
            <span className="inline-flex items-center gap-1.5 text-sm font-medium">
              <LegendBandSwatch opacity={MC_OUTER_BAND_OPACITY} />
              10th–90th percentile
            </span>
            <span className="inline-flex items-center gap-1.5 text-sm font-medium">
              <LegendBandSwatch opacity={MC_INNER_BAND_OPACITY} />
              25th–75th percentile
            </span>
          </div>
          <div className="mt-3 max-w-full overflow-x-auto">
            <div className="h-[320px] min-w-[560px]">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={monteCarlo.chart} margin={{ top: 8, right: 12, bottom: 4, left: 4 }} stackOffset="none">
                  <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="age" type="number" domain={["dataMin", "dataMax"]} tick={{ fill: "var(--dim)", fontSize: 12 }} tickLine={false} axisLine={{ stroke: "var(--border)" }} />
                  <YAxis width={76} tick={{ fill: "var(--text)", fontSize: 12 }} tickLine={false} axisLine={false} tickFormatter={yAxisFmt} />
                  <Tooltip
                    content={(tp: { active?: boolean; label?: number; payload?: { payload?: { p10: number; p90: number; median: number } }[] }) => {
                      if (!tp.active) return null;
                      const p = tp.payload?.[0]?.payload;
                      if (!p) return null;
                      return (
                        <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm shadow-lg">
                          <p className="font-semibold">Age {tp.label}</p>
                          <p className="tnum mt-0.5">Median {tooltipMoney(p.median)}</p>
                          <p className="tnum text-[var(--dim)]">10–90: {tooltipMoney(p.p10)} – {tooltipMoney(p.p90)}</p>
                        </div>
                      );
                    }}
                  />
                  <Area type="monotone" dataKey="base" stackId="fan" stroke="none" fill="transparent" isAnimationActive={false} legendType="none" />
                  <Area type="monotone" dataKey="segLow" stackId="fan" stroke="none" fill={ACCENT} fillOpacity={MC_OUTER_BAND_OPACITY} isAnimationActive={false} legendType="none" />
                  <Area type="monotone" dataKey="band75" stackId="fan" stroke="none" fill={ACCENT} fillOpacity={MC_INNER_BAND_OPACITY} isAnimationActive={false} legendType="none" />
                  <Area type="monotone" dataKey="segHigh" stackId="fan" stroke="none" fill={ACCENT} fillOpacity={MC_OUTER_BAND_OPACITY} isAnimationActive={false} legendType="none" />
                  <Line type="monotone" dataKey="median" name="Median" stroke={ACCENT} strokeWidth={2.4} dot={false} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
        </section>
      )}

      {inputs && tab === "maxspending" && (
        <section aria-label="Max Spending results" className={`mt-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5${flashCls}`}>
          <Explainer
            id="retirement.maxSpending"
            label="Max Spending"
            className="max-w-2xl"
            summary="The highest annual spending, in today&rsquo;s dollars, that still meets the target success rate — the solved figure is gross spending."
          >
            <p>
              The highest annual spending (in today&rsquo;s dollars, rounded to the nearest $100)
              that still meets the target success rate, using every other input above as-is.
              Extra income offsets the solved spending exactly as in the other engines, so the
              solved figure is gross spending.
              {inputs.strategy === "percent" && " With the percent-of-portfolio strategy there is no fixed spending to solve for, so the solver finds the highest percent instead; the dollar figure is that percent of your starting portfolio (the first year’s spending)."}
              {inputs.strategy === "guardrails" && ` With guardrails, the solved figure is the base spending the guardrail adjustments start from, using your cut trigger (${inputs.guardrailsCutPct}%), raise trigger (${inputs.guardrailsRaisePct}%), and adjustment size (${inputs.guardrailsAdjustmentPct}%).`}
              {inputs.strategy === "phased" && ` With phased, the solved figure is the starting spending — the amount before the step-down — stepping down ${inputs.phaseDeclinePct}%/yr from age ${inputs.phaseStartAge}.`}
            </p>
          </Explainer>
          <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-3">
            <div>
              <label htmlFor="rc-solver-engine" className={labelCls}>Engine</label>
              <select
                id="rc-solver-engine"
                className={inputCls}
                value={solverEngine}
                onChange={(e) => setSolverEngine(e.target.value as "historical" | "montecarlo")}
              >
                <option value="historical">Historical</option>
                <option value="montecarlo">Monte Carlo</option>
              </select>
            </div>
            <div>
              <label htmlFor="rc-solver-target" className={labelCls}>Target success %</label>
              <input
                id="rc-solver-target"
                type="text"
                inputMode="decimal"
                className={inputCls}
                value={focusField === "solver-target" ? solverTarget : formatPctDisplay(solverTarget)}
                onFocus={() => setFocusField("solver-target")}
                onBlur={() => setFocusField(null)}
                onChange={(e) => setSolverTarget(e.target.value)}
              />
              {solverTargetOutOfRange && (
                <p className="mt-1 text-xs text-[var(--dim)]">
                  A success target cannot exceed 100% — this is being solved as {Math.min(100, Math.max(0, solverTargetNum ?? 0))}%.
                </p>
              )}
            </div>
          </div>
          {solverStale && (
            <p className="mt-3 text-sm font-medium text-[var(--warn)]" aria-live="polite">
              Updating… — the answer below is from your previous inputs while the new one calculates.
            </p>
          )}
          {solver ? (
            <div className={solverStale ? "opacity-60" : undefined} aria-busy={solverStale}>
              <div className="mt-4 grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-3">
                <div className="rounded-[var(--radius)] border border-[var(--border)] p-3.5">
                  <p className="text-[10.5px] font-medium tracking-[0.02em] text-[var(--dim)] uppercase">Maximum sustainable annual spending</p>
                  <p className="tnum display mt-1.5 text-xl font-semibold">{fmt(solver.maxSpendingCents)}</p>
                  {maxSpendingDeltaText && (
                    <p className="mt-1 text-xs font-medium text-[var(--dim)]">{maxSpendingDeltaText}</p>
                  )}
                  {solver.percent != null && (
                    <p className="mt-1 text-xs text-[var(--dim)]">= {solver.percent.toFixed(2)}% of the starting portfolio per year</p>
                  )}
                  {solver.approximate && (
                    <p className="mt-1 text-xs text-[var(--dim)]">Approximate</p>
                  )}
                </div>
                <div className="rounded-[var(--radius)] border border-[var(--border)] p-3.5">
                  <p className="text-[10.5px] font-medium tracking-[0.02em] text-[var(--dim)] uppercase">Success rate at that spending</p>
                  {successAtRisk(solver.successRate, solverEngineUsed) ? (
                    <p className="mt-1.5"><AtRiskPill rate={solver.successRate} engine={solverEngineUsed} tip={solverEngineUsed === "montecarlo" ? `At the solved spending, the money never ran out in ${solver.successRate.toFixed(1)}% of 1,000 simulated lifetimes — below the 85% level financial planners generally target for Monte Carlo tests. Below that line, more simulated lifetimes run out of money before the end age.` : undefined} /></p>
                  ) : (
                    <p className="tnum display mt-1.5 text-xl font-semibold">{solver.successRate.toFixed(1)}%</p>
                  )}
                </div>
                <div className="rounded-[var(--radius)] border border-[var(--border)] p-3.5">
                  <p className="text-[10.5px] font-medium tracking-[0.02em] text-[var(--dim)] uppercase">Median ending balance</p>
                  <p className="tnum display mt-1.5 text-xl font-semibold">{fmt(solver.medianEnding)}</p>
                </div>
              </div>
              <ul className="sr-only">
                <li>{`Max Spending: ${fmt(solver.maxSpendingCents)} per year at ${solver.successRate.toFixed(1)} percent success, median ending ${fmt(solver.medianEnding)}`}</li>
              </ul>
              {solverEngine === "montecarlo" && (
                <p className="mt-3 text-sm text-[var(--dim)]">
                  Approximate: the Monte Carlo solver uses the same seed and 1,000 runs as the Monte Carlo tab, so its success rate at the solved spending matches that tab for the same inputs.
                </p>
              )}
            </div>
          ) : (
            <p className="mt-4 rounded-[var(--radius)] border border-dashed border-[var(--border)] p-4 text-sm text-[var(--dim)]">
              {inputs.retirementAge >= inputs.endAge ? (
                <>
                  No retired years to solve against: the retirement age (
                  {inputs.retirementAge}) is not before the plan&rsquo;s end
                  age ({inputs.endAge}), so no year&rsquo;s spending is ever
                  tested. Lower the retirement age or raise the end age for
                  a Max Spending answer.
                </>
              ) : parseNum(solverTarget) == null
                ? "Enter a target success % above to solve."
                : solverEngine === "historical"
                  ? "No historical run fits this plan, so there is nothing to solve against — shorten the span (a later current age or an earlier end age), or switch the solver engine to Monte Carlo."
                  : "Nothing to solve against for these inputs."}
            </p>
          )}
        </section>
      )}

      {!inputs && (
        <p className="mt-3 rounded-[var(--radius)] border border-dashed border-[var(--border)] p-4 text-sm text-[var(--dim)]">
          Enter a starting portfolio, annual spending, and ages above to see the results.
        </p>
      )}

      {/* Scenario compare */}
      <section
        aria-label="Scenario compare"
        className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5"
      >
        <h3 className="display text-lg font-semibold">Scenario compare</h3>
        <Explainer
          id="retirement.scenarioCompare"
          label="Scenario compare"
          className="mt-1 max-w-2xl"
          summary="Save versions of the plan and compare them side by side — every version runs through the same history and the same random markets."
        >
          <p>
            <strong className="text-[var(--text)]">What this is for:</strong> save different versions of the plan above — retiring later,
            spending less, a different portfolio — then see them side by side. Every version below (including
            <strong className="text-[var(--text)]"> Current inputs</strong>, whatever you have typed above right now) is run through the
            <em> same</em> history and the <em>same</em> random markets, so the only difference in the charts is the plan itself.
            Higher lines and taller bars are better: the money never ran out more often and ended larger.
          </p>
          <ol className="list-decimal space-y-0.5 pl-5">
            <li>Change the inputs above to a version you want to test.</li>
            <li>Tap <strong className="text-[var(--text)]">Save current as scenario</strong> (in the inputs box, up to 3).</li>
            <li>Compare it here against Current inputs — <strong className="text-[var(--text)]">Load</strong> puts a saved version back into the inputs so you can tweak it, and <strong className="text-[var(--text)]">Rename</strong> gives it a name that says what it tests (for example, &ldquo;Retire at 60&rdquo;).</li>
          </ol>
        </Explainer>

        {data.scenarios.length === 0 ? (
          <p className="mt-3 rounded-[var(--radius)] border border-dashed border-[var(--border)] p-4 text-sm text-[var(--dim)]">
            No scenarios saved yet — the charts appear here once you save one. Try saving your current plan first,
            then change one thing (for example, retirement age 60 instead of 57) and save that too: the two lines
            will show exactly what those extra working years buy.
          </p>
        ) : (
          <>
            {/* Legend: colour key shared by every chart and card */}
            <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5" aria-label="Comparison colour key">
              {compareEntries.map((e) => (
                <span key={e.key} className="inline-flex items-center gap-1.5 text-sm font-medium">
                  <span aria-hidden="true" className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: e.color }} />
                  {e.name}
                  {e.isCurrent && <span className="text-xs font-normal text-[var(--dim)]">(inputs above)</span>}
                </span>
              ))}
            </div>

            {/* Chart 1: median path overlay (Historical) */}
            {hasPathData ? (
              <div className="mt-4">
                <h4 className="text-sm font-semibold">How the money grows — median path (Historical)</h4>
                <p className="mt-0.5 text-sm text-[var(--dim)]">
                  For each plan, the middle (median) balance at each age across every historical start year.
                  The plan whose line stays highest is ending richest in a typical past. A line ends at that plan&rsquo;s end age.
                </p>
                <ul className="sr-only">
                  {compareEntries.map((e) => (
                    <li key={e.key}>
                      {`${e.name}: ${e.hist ? `historical median ending ${fmt(e.hist.medianEnding)}, success ${e.hist.neverOutSuccessRate.toFixed(1)} percent` : "no historical run fits this plan"}`}
                    </li>
                  ))}
                </ul>
                <div className="mt-2 max-w-full overflow-x-auto">
                  <div className="h-[300px] min-w-[560px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={comparePathChart} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
                        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="age" type="number" domain={["dataMin", "dataMax"]} tick={{ fill: "var(--dim)", fontSize: 12 }} tickLine={false} axisLine={{ stroke: "var(--border)" }} label={{ value: "Age", position: "insideBottomRight", offset: -2, fill: "var(--dim)", fontSize: 12 }} />
                        <YAxis width={76} tick={{ fill: "var(--text)", fontSize: 12 }} tickLine={false} axisLine={false} tickFormatter={yAxisFmt} />
                        <Tooltip
                          content={(tp: { active?: boolean; label?: number; payload?: { name?: string; value?: number; color?: string }[] }) => {
                            if (!tp.active || !tp.payload || tp.payload.length === 0) return null;
                            return (
                              <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm shadow-lg">
                                <p className="font-semibold">Age {tp.label}</p>
                                {tp.payload.map((p) => (
                                  <p key={p.name} className="tnum mt-0.5" style={{ color: p.color }}>
                                    {p.name}: {p.value != null ? tooltipMoney(p.value) : "—"}
                                  </p>
                                ))}
                              </div>
                            );
                          }}
                        />
                        <Legend formatter={(value: string) => <span style={{ color: "var(--text)" }}>{value}</span>} />
                        {compareEntries.map((e) => (
                          <Line
                            key={e.key}
                            type="monotone"
                            dataKey={e.key}
                            name={e.name}
                            stroke={e.color}
                            strokeWidth={e.isCurrent ? 2.6 : 2.2}
                            dot={false}
                            connectNulls={false}
                            isAnimationActive={false}
                          />
                        ))}
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>
            ) : (
              <p className="mt-4 rounded-[var(--radius)] border border-dashed border-[var(--border)] p-4 text-sm text-[var(--dim)]">
                No historical run fits any of these plans (the span is longer than the historical dataset), so the path chart is unavailable — the Monte Carlo figures on the cards below still compare them.
              </p>
            )}

            {/* Charts 2 + 3: success rates and median endings */}
            <div className="mt-5 grid gap-5 lg:grid-cols-2">
              <div>
                <h4 className="text-sm font-semibold">Did the money last? — success rate</h4>
                <p className="mt-0.5 text-sm text-[var(--dim)]">
                  Share of runs where the money never ran out. 100% is the top — a plan cannot do better.
                </p>
                <ul className="sr-only">
                  {compareEntries.map((e) => (
                    <li key={e.key}>
                      {`${e.name}: historical success ${e.hist ? `${e.hist.neverOutSuccessRate.toFixed(1)} percent` : "not available"}, Monte Carlo success ${e.mc ? `${e.mc.neverOutSuccessRate.toFixed(1)} percent` : "not available"}`}
                    </li>
                  ))}
                </ul>
                <div className="mt-2 h-[240px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={compareSuccessChart} margin={{ top: 8, right: 8, bottom: 4, left: 0 }} barCategoryGap="24%" barGap={3}>
                      <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="name" tick={{ fill: "var(--text)", fontSize: 12 }} tickLine={false} axisLine={{ stroke: "var(--border)" }} interval={0} />
                      <YAxis domain={[0, 100]} width={44} tick={{ fill: "var(--dim)", fontSize: 12 }} tickLine={false} axisLine={false} tickFormatter={(v: number) => `${v}%`} />
                      <Tooltip
                        cursor={{ fill: "var(--surface-alt)", opacity: 0.5 }}
                        content={(tp: { active?: boolean; label?: string; payload?: { name?: string; value?: unknown; color?: string }[] }) => {
                          if (!tp.active || !tp.payload) return null;
                          return (
                            <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm shadow-lg">
                              <p className="font-semibold">{tp.label}</p>
                              {tp.payload.map((p) => (
                                <p key={p.name} className="tnum mt-0.5">
                                  {p.name}: {typeof p.value === "number" ? `${p.value.toFixed(1)}%` : "No run fits"}
                                </p>
                              ))}
                            </div>
                          );
                        }}
                      />
                      <Legend formatter={(value: string) => <span style={{ color: "var(--text)" }}>{value}</span>} />
                      <Bar dataKey="Historical" name="Historical" fill="#2563eb" radius={[3, 3, 0, 0]} isAnimationActive={false} />
                      <Bar dataKey="MonteCarlo" name="Monte Carlo" fill="#d97706" radius={[3, 3, 0, 0]} isAnimationActive={false} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
              <div>
                <h4 className="text-sm font-semibold">How much was left? — median ending balance</h4>
                <p className="mt-0.5 text-sm text-[var(--dim)]">
                  The middle ending balance. Taller is richer — but check it next to success rate: a plan can end rich in good runs and still fail more often.
                </p>
                <ul className="sr-only">
                  {compareEntries.map((e) => (
                    <li key={e.key}>
                      {`${e.name}: historical median ending ${e.hist ? fmt(e.hist.medianEnding) : "not available"}, Monte Carlo median ending ${e.mc ? fmt(e.mc.p50) : "not available"}`}
                    </li>
                  ))}
                </ul>
                <div className="mt-2 h-[240px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={compareEndingChart} margin={{ top: 8, right: 8, bottom: 4, left: 0 }} barCategoryGap="24%" barGap={3}>
                      <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="name" tick={{ fill: "var(--text)", fontSize: 12 }} tickLine={false} axisLine={{ stroke: "var(--border)" }} interval={0} />
                      <YAxis width={64} tick={{ fill: "var(--dim)", fontSize: 12 }} tickLine={false} axisLine={false} tickFormatter={yAxisFmt} />
                      <Tooltip
                        cursor={{ fill: "var(--surface-alt)", opacity: 0.5 }}
                        content={(tp: { active?: boolean; label?: string; payload?: { name?: string; value?: unknown }[] }) => {
                          if (!tp.active || !tp.payload) return null;
                          return (
                            <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm shadow-lg">
                              <p className="font-semibold">{tp.label}</p>
                              {tp.payload.map((p) => (
                                <p key={p.name} className="tnum mt-0.5">
                                  {p.name}: {typeof p.value === "number" ? tooltipMoney(p.value) : "No run fits"}
                                </p>
                              ))}
                            </div>
                          );
                        }}
                      />
                      <Legend formatter={(value: string) => <span style={{ color: "var(--text)" }}>{value}</span>} />
                      <Bar dataKey="Historical" name="Historical" fill="#2563eb" radius={[3, 3, 0, 0]} isAnimationActive={false} />
                      <Bar dataKey="MonteCarlo" name="Monte Carlo" fill="#d97706" radius={[3, 3, 0, 0]} isAnimationActive={false} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            {/* Cards: one per entry, same colours, deltas vs Current */}
            <h4 className="mt-5 text-sm font-semibold">The plans in detail</h4>
            <p className="mt-0.5 text-sm text-[var(--dim)]">
              Each card lists what is <em>different</em> from Current inputs, and how its results compare. ★ marks the best in that row across all plans shown.
            </p>
            <div className="mt-3 space-y-3">
              {compareEntries.map((e) => {
                const diffs = scenarioDiffs(e);
                const deltaLine = scenarioDeltaLine(e);
                const sc = e.scenario;
                const isBestHistSuccess = e.hist != null && e.hist.neverOutSuccessRate === bestHistSuccess;
                const isBestMcSuccess = e.mc != null && e.mc.neverOutSuccessRate === bestMcSuccess;
                const isBestHistMedian = e.hist != null && e.hist.medianEnding === bestHistMedian;
                const isBestMcMedian = e.mc != null && e.mc.p50 === bestMcMedian;
                return (
                  <div
                    key={e.key}
                    className="rounded-[var(--radius)] border border-[var(--border)] p-3.5"
                    style={{ borderTopWidth: 3, borderTopColor: e.color }}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="inline-flex items-center gap-2 font-semibold">
                        <span aria-hidden="true" className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: e.color }} />
                        {e.name}
                        {e.isCurrent && <span className="text-xs font-normal text-[var(--dim)]">— what the inputs above produce right now</span>}
                      </p>
                      {!e.isCurrent && sc && (
                        <div className="flex gap-2">
                          <button
                            type="button"
                            aria-label={`Load ${sc.name}`}
                            className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm font-medium text-[var(--text)] hover:text-[var(--accent)]"
                            onClick={() => handleLoadScenario(sc)}
                          >
                            Load
                          </button>
                          <button
                            type="button"
                            aria-label={`Rename ${sc.name}`}
                            className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm font-medium text-[var(--text)] hover:text-[var(--accent)]"
                            onClick={() => {
                              setRenamingName(sc.name);
                              setRenameText(sc.name);
                            }}
                          >
                            Rename
                          </button>
                          {confirmDeleteScenarioName === sc.name ? (
                            <>
                              <span className="inline-flex items-center text-sm text-[var(--bad)]">
                                Delete {sc.name}?
                              </span>
                              <button
                                type="button"
                                aria-label={`Confirm delete ${sc.name}`}
                                className="rounded-[var(--radius)] border border-[var(--bad)] px-3 py-1.5 text-sm font-medium text-[var(--bad)] disabled:opacity-50"
                                disabled={deleteScenario.isPending}
                                onClick={() => {
                                  deleteScenario.mutate(sc.name);
                                  setConfirmDeleteScenarioName(null);
                                }}
                              >
                                Delete
                              </button>
                              <button
                                type="button"
                                aria-label={`Cancel delete ${sc.name}`}
                                className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm font-medium text-[var(--text)]"
                                onClick={() => setConfirmDeleteScenarioName(null)}
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              aria-label={`Delete ${sc.name}`}
                              className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm font-medium text-[var(--text)] hover:text-[var(--bad)] disabled:opacity-50"
                              disabled={deleteScenario.isPending}
                              onClick={() => setConfirmDeleteScenarioName(sc.name)}
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                    {!e.isCurrent && sc && renamingName === sc.name && (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <input
                          type="text"
                          aria-label={`New name for ${sc.name}`}
                          className="min-w-0 flex-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm text-[var(--text)] sm:max-w-xs"
                          value={renameText}
                          maxLength={60}
                          onChange={(ev) => setRenameText(ev.target.value)}
                        />
                        <button
                          type="button"
                          aria-label={`Save name for ${sc.name}`}
                          className="rounded-[var(--radius)] bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                          disabled={renameScenario.isPending || renameText.trim() === ""}
                          onClick={() =>
                            renameScenario.mutate({ name: sc.name, newName: renameText })
                          }
                        >
                          Save name
                        </button>
                        <button
                          type="button"
                          aria-label={`Cancel renaming ${sc.name}`}
                          className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm font-medium text-[var(--text)]"
                          onClick={() => setRenamingName(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                    {e.isCurrent ? (
                      <p className="tnum mt-1 text-sm text-[var(--dim)]">
                        {inputs
                          ? `Portfolio ${fmt(inputs.startCents)} · ${inputs.strategy === "percent" ? `Spends ${inputs.percentOfPortfolio}% of portfolio/yr` : `Spending ${fmt(inputs.spendingCents)}/yr${inputs.strategy === "guardrails" ? ` (Guardrails base: cut ${inputs.guardrailsCutPct}%, raise ${inputs.guardrailsRaisePct}%, adjust ${inputs.guardrailsAdjustmentPct}%)` : inputs.strategy === "phased" ? ` (Phased (declines later): steps down ${inputs.phaseDeclinePct}%/yr from age ${inputs.phaseStartAge})` : ""}`} · Starts at ${inputs.currentAge} · Retire ${inputs.retirementAge} · End ${inputs.endAge} · ${stocks}% stocks`
                          : "Enter valid inputs above to include Current in the comparison."}
                      </p>
                    ) : sc ? (
                      <p className="tnum mt-1 text-sm text-[var(--text)]">{scenarioLine(sc)}</p>
                    ) : null}
                    {!e.isCurrent && currentEntry && e.builtInputs && (
                      diffs.length > 0 ? (
                        <div className="mt-2 flex flex-wrap gap-1.5" aria-label={`How ${e.name} differs from Current inputs`}>
                          {diffs.map((d) => (
                            <span key={d} className="rounded-full border border-[var(--border)] bg-[var(--surface-alt)] px-2.5 py-1 text-xs font-medium">
                              {d}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <p className="mt-1 text-sm text-[var(--dim)]">Same as your current inputs — its charts overlap Current exactly.</p>
                      )
                    )}
                    {deltaLine && (
                      <p
                        className="tnum mt-2 text-xs font-medium text-[var(--dim)]"
                        aria-label={`How ${e.name} compares with your current inputs`}
                      >
                        {deltaLine}
                      </p>
                    )}
                    <div className="mt-3 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
                      <div className="rounded-[var(--radius)] border border-[var(--border)] p-3">
                        <p className="text-[10.5px] font-medium tracking-[0.02em] text-[var(--dim)] uppercase">
                          Historical success {isBestHistSuccess && <span aria-label="best in this row">★</span>}
                        </p>
                        {e.hist && successAtRisk(e.hist.neverOutSuccessRate, "historical") ? (
                          <p className="mt-1"><AtRiskPill rate={e.hist.neverOutSuccessRate} engine="historical" /></p>
                        ) : (
                          <p className="tnum display mt-1 text-lg font-semibold">{e.hist ? `${e.hist.neverOutSuccessRate.toFixed(1)}%` : "—"}</p>
                        )}
                        {!e.isCurrent && e.hist && currentEntry?.hist && (
                          <p className="mt-0.5 text-xs text-[var(--dim)]">{fmtDeltaPct(e.hist.neverOutSuccessRate, currentEntry.hist.neverOutSuccessRate)}</p>
                        )}
                        {e.hist == null && <p className="mt-0.5 text-xs text-[var(--dim)]">No historical run fits</p>}
                      </div>
                      <div className="rounded-[var(--radius)] border border-[var(--border)] p-3">
                        <p className="text-[10.5px] font-medium tracking-[0.02em] text-[var(--dim)] uppercase">
                          Historical median ending {isBestHistMedian && <span aria-label="best in this row">★</span>}
                        </p>
                        <p className="tnum display mt-1 text-lg font-semibold">{e.hist ? fmt(e.hist.medianEnding) : "—"}</p>
                        {!e.isCurrent && e.hist && currentEntry?.hist && (
                          <p className="mt-0.5 text-xs text-[var(--dim)]">{fmtDeltaMoney(e.hist.medianEnding, currentEntry.hist.medianEnding)}</p>
                        )}
                      </div>
                      <div className="rounded-[var(--radius)] border border-[var(--border)] p-3">
                        <p className="text-[10.5px] font-medium tracking-[0.02em] text-[var(--dim)] uppercase">
                          Monte Carlo success {isBestMcSuccess && <span aria-label="best in this row">★</span>}
                        </p>
                        {e.mc && successAtRisk(e.mc.neverOutSuccessRate, "montecarlo") ? (
                          <p className="mt-1"><AtRiskPill rate={e.mc.neverOutSuccessRate} engine="montecarlo" tip={`The money never ran out in ${e.mc.neverOutSuccessRate.toFixed(1)}% of 1,000 simulated lifetimes — below the 85% level financial planners generally target for Monte Carlo tests. Below that line, more simulated lifetimes run out of money before the end age.`} /></p>
                        ) : (
                          <p className="tnum display mt-1 text-lg font-semibold">{e.mc ? `${e.mc.neverOutSuccessRate.toFixed(1)}%` : "—"}</p>
                        )}
                        {!e.isCurrent && e.mc && currentEntry?.mc && (
                          <p className="mt-0.5 text-xs text-[var(--dim)]">{fmtDeltaPct(e.mc.neverOutSuccessRate, currentEntry.mc.neverOutSuccessRate)}</p>
                        )}
                      </div>
                      <div className="rounded-[var(--radius)] border border-[var(--border)] p-3">
                        <p className="text-[10.5px] font-medium tracking-[0.02em] text-[var(--dim)] uppercase">
                          Monte Carlo median ending {isBestMcMedian && <span aria-label="best in this row">★</span>}
                        </p>
                        <p className="tnum display mt-1 text-lg font-semibold">{e.mc ? fmt(e.mc.p50) : "—"}</p>
                        {!e.isCurrent && e.mc && currentEntry?.mc && (
                          <p className="mt-0.5 text-xs text-[var(--dim)]">{fmtDeltaMoney(e.mc.p50, currentEntry.mc.p50)}</p>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
        {scenarioMsg && (
          <p className="mt-2 text-sm text-[var(--dim)]" aria-live="polite">{scenarioMsg}</p>
        )}
      </section>

      <p className="mt-4 text-xs leading-relaxed text-[var(--dim)]">
        Not included: taxes, investment fees, tax-bucket-aware withdrawals, and more than one
        extra-income source. This is a planning sketch, not financial advice.
      </p>
    </div>
  );
}
