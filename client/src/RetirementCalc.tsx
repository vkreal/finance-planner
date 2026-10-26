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
import { Explainer } from "./Explainer";
import { FoldChevron } from "./FoldChevron";
import { usePersistedFold } from "./foldState";
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
// success rate: its failure state is an ending balance of $0
// (the portfolio depletes at or before the end age — the same
// depletion the other engines count as failure). Rendered as the
// same soft-red pill as at-risk percentages, with the same kind
// of tooltip: it states the age the money reaches $0 and the
// plan's end age it falls short of.
function AtRiskEndingPill({
  lastsToAge,
  endAge,
}: {
  lastsToAge: number | null;
  endAge: number;
}) {
  const [open, setOpen] = useState(false);
  const tipId = useId();
  const text =
    lastsToAge != null
      ? `At the assumed steady return, this plan's portfolio reaches $0 at age ${lastsToAge} — before the plan's end age of ${endAge}. In the other tests, a plan that runs out of money is counted as not succeeding.`
      : `At the assumed steady return, this plan's portfolio ends at $0 by the end age of ${endAge} — nothing is left over. In the other tests, a plan that runs out of money is counted as not succeeding.`;
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
        <span aria-hidden="true">⚠</span> At risk · $0
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
// as typed — formatting never coerces a value.
function formatMoneyDisplay(s: string): string {
  const cents = parseMoney(s);
  if (cents == null) return s;
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
// Monthly presentations of an ANNUAL money string, for the Annual
// spending field's per-month entry mode. Both are display-only:
// the annual string (and the annual cents every engine, save, and
// comparison derives from it) is never rewritten by formatting.
// The unfocused form rounds the exact annual ÷ 12 figure to cents
// for display ($160,000.00/yr shows as $13,333.33/mo while the
// stored annual value stays exactly 16000000 cents); the raw form
// is the same rounded figure without decoration, shown while the
// field is focused so an edit starts from what was displayed.
// Blank and unparseable text pass through exactly as typed.
function formatMonthlyDisplay(annualStr: string): string {
  const cents = parseMoney(annualStr);
  if (cents == null) return annualStr;
  return `$${(cents / 1200).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
function monthlyRawFromAnnual(annualStr: string): string {
  const cents = parseMoney(annualStr);
  if (cents == null) return annualStr;
  return String(Math.round(cents / 12) / 100);
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

export function RetirementCalc() {
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ["retirementcalc"],
    queryFn: () => api.getRetirementCalc({}),
  });
  const data: CalcData | undefined = q.data;

  const [tab, setTab] = useState<Tab>("projection");
  /* Plan-inputs form fold: the whole inputs panel collapses
     behind the chip chevron on its top row, so it can be hidden
     once set. Persisted in the generic fold store (server-backed,
     no localStorage) following the app's pattern for a fold that
     DEFAULTS TO EXPANDED — the store only carries folds left in
     their non-default state, so this stores the inverse flag: an
     entry under "retirement.inputsFolded" means the user left the
     form folded shut; no entry means expanded, its default. The
     top row (Reset / plan status / Save controls) stays visible
     as the fold's header either way; the results below the form
     are outside the fold and keep recalculating exactly as
     before. Display only — no field, save, or figure reads this
     flag. */
  const [inputsFolded, setInputsFolded] = usePersistedFold(
    "retirement.inputsFolded",
  );
  const inputsOpen = !inputsFolded;
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
  // Inline rename: which scenario is being renamed, and the draft name.
  const [renamingName, setRenamingName] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
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
  // Raw monthly text while the spending field is focused in
  // per-month mode, so typing is never rewritten mid-edit; the
  // canonical annual string is updated on every keystroke.
  const [spendingMonthDraft, setSpendingMonthDraft] = useState("");
  const [currentAge, setCurrentAge] = useState("55");
  const [retirementAge, setRetirementAge] = useState(String(RETIREMENT_AGE_DEFAULT));
  const [endAge, setEndAge] = useState("95");
  const [stocksPct, setStocksPct] = useState(String(STOCKS_PCT_DEFAULT));
  const [extraIncome, setExtraIncome] = useState("");
  const [extraStartAge, setExtraStartAge] = useState(String(EXTRA_INCOME_START_AGE_DEFAULT));
  const [expectedPct, setExpectedPct] = useState(
    String(Math.round(blendedExpected(STOCKS_PCT_DEFAULT) * 100) / 100),
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

  /* Hydrate the whole form from a saved inputs record — the ONE
     path shared by the init effect (first load) and the CAS
     conflict path (a refused save re-shows the latest saved
     version). `saved` may be null (no saved record): every
     field then falls back to the load defaults in `d`, exactly
     as a fresh first open does. */
  const hydrateFromSaved = (saved: CalcData["saved"], d: CalcData) => {
    const s = saved;
    const data = d;
    const curAge = s?.currentAge ?? data.defaultCurrentAge;
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
    setSpending(
      s?.spendingCents != null
        ? String(s.spendingCents / 100)
        : String(data.defaultSpendingAnnualCents / 100),
    );
    // The remembered spending-field unit wins on load; the
    // server resolves "month" when nothing was ever stored.
    setSpendingUnit(data.spendingUnit);
    setCurrentAge(String(curAge));
    // A fresh state (no saved inputs at all) opens on the plan
    // defaults — retirement age 57, extra income blank (none),
    // extra income start age 67. A saved state is shown exactly
    // as saved: a saved blank retirement age reloads as the
    // current age, and a saved $0 / blank extra income stays
    // blank (none).
    setRetirementAge(
      String(s?.retirementAge ?? (s ? curAge : RETIREMENT_AGE_DEFAULT)),
    );
    setEndAge(String(s?.endAge ?? 95));
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
    const exp = s?.expectedReturnPct ?? blendedExpected(stocks);
    const vol = s?.volatilityPct ?? blendedVol(stocks);
    setExpectedPct(String(Math.round(exp * 100) / 100));
    setVolPct(String(Math.round(vol * 100) / 100));
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

  // When the mix changes, follow the blended defaults for expected
  // return / volatility unless the user has typed their own values.
  useEffect(() => {
    if (!init) return;
    const stocks = parseNum(stocksPct);
    if (stocks == null || stocks < 0 || stocks > 100) return;
    const exp = String(Math.round(blendedExpected(stocks) * 100) / 100);
    const vol = String(Math.round(blendedVol(stocks) * 100) / 100);
    if (expectedPct === prevBlend.current.exp) setExpectedPct(exp);
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
     save returned, never a duplicate of the in-flight base. */
  const saveTimer = useRef<number | null>(null);
  const pendingSave = useRef<Parameters<typeof api.saveRetirementCalc>[0] | null>(null);
  const pendingSaveOkRef = useRef<((res: RetSaveResult) => void) | null>(null);
  const saveInFlightRef = useRef(false);

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
  });
  const saveMutateRef = useRef(save.mutate);
  saveMutateRef.current = save.mutate;
  const firePendingSave = () => {
    if (!pendingSave.current) return;
    if (saveInFlightRef.current) {
      // A save is already in flight: wait for it to settle (its
      // returned revision becomes the base) and re-fire.
      if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(firePendingSave, 300);
      return;
    }
    const payload = pendingSave.current;
    pendingSave.current = null;
    const onOk = pendingSaveOkRef.current;
    pendingSaveOkRef.current = null;
    saveInFlightRef.current = true;
    saveMutateRef.current(payload, {
      onSuccess: (res) => {
        onOk?.(res);
      },
      onSettled: () => {
        saveInFlightRef.current = false;
      },
    });
  };
  const firePendingSaveRef = useRef(firePendingSave);
  firePendingSaveRef.current = firePendingSave;
  // Queue a save through the serialized path (Reset to defaults
  // and Load a scenario / Back to my plan ride it too; their
  // cache syncs travel as the onOk callback, guarded on ok so a
  // conflict never overwrites the conflict path's merge).
  const submitSave = (
    payload: Parameters<typeof api.saveRetirementCalc>[0],
    onOk?: (res: RetSaveResult) => void,
  ) => {
    pendingSave.current = payload;
    pendingSaveOkRef.current = onOk ?? null;
    firePendingSaveRef.current();
  };
  // Flush a pending debounced save when leaving the screen, so an
  // edit made in the last fraction of a second is not lost. It
  // fires through the same serialized path; if a save is still
  // in flight at unmount it fires directly with the last-known
  // base — a refusal then only re-bases the next mount's load,
  // never silently overwrites.
  useEffect(() => {
    return () => {
      if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
      if (pendingSave.current) {
        if (saveInFlightRef.current) {
          saveMutateRef.current(pendingSave.current);
        } else {
          firePendingSaveRef.current();
        }
        pendingSave.current = null;
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
      // Clamped to 0 exactly as the live engines clamp it, so the
      // saved value is the value the engines run (a negative
      // "income" is a typo, never a plan).
      extraIncomeCents: Math.max(0, parseMoney(extraIncome) ?? 0),
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

  useEffect(() => {
    if (!init) return;
    pendingSave.current = buildInputsPayloadRef.current();
    pendingSaveOkRef.current = null;
    if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      firePendingSaveRef.current();
    }, 700);
    return () => {
      if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [init, portfolio, portfolioFollowing, spending, currentAge, retirementAge, endAge, stocksPct, extraIncome, extraStartAge, expectedPct, volPct, strategy, percentOfPortfolio, guardrailsCutPct, guardrailsRaisePct, guardrailsAdjustmentPct, phaseStartAge, phaseDeclinePct]);

  // Reset every input to the same defaults a fresh first open
  // computes (see the init effect above): portfolio and spending
  // from the live defaults the server computed for this load —
  // portfolio is the Net Worth-following figure (the latest Net
  // Worth total respecting the current Include house & mortgage
  // toggle, minus the 529 bucket) and keeps following Net Worth
  // (it saves as null, like a fresh open), spending is the trailing True
  // cost annualised — and the built-in defaults for the rest
  // (current age from the birth year stored in the Roth inputs —
  // the server's defaultCurrentAge, retirement age 57, end age 95,
  // stocks 95% with its blended expected return / volatility,
  // extra income blank (none) with its start age defaulting to
  // 67, the Constant spending
  // strategy at 5% for the percent input, the professional
  // guardrails knobs 120 / 80 / 10, and the phased knobs 75 / 1). The reset values are saved immediately through
  // the same save action as any other edit, so they persist and the
  // engines re-run on them as soon as state updates. Saved
  // scenarios are NOT touched: the server merges every save with
  // the stored scenarios.
  const handleResetToDefaults = () => {
    if (!data) return;
    const defaultCurrentAge = data.defaultCurrentAge;
    const defaultStocks = STOCKS_PCT_DEFAULT;
    const defaultEndAge = 95;
    const exp = blendedExpected(defaultStocks);
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
    setSpending(String(data.defaultSpendingAnnualCents / 100));
    setCurrentAge(String(defaultCurrentAge));
    setRetirementAge(String(RETIREMENT_AGE_DEFAULT));
    setEndAge(String(defaultEndAge));
    setStocksPct(String(defaultStocks));
    setExtraIncome("");
    setExtraStartAge(String(EXTRA_INCOME_START_AGE_DEFAULT));
    setExpectedPct(expStr);
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
      spendingCents: data.defaultSpendingAnnualCents,
      currentAge: defaultCurrentAge,
      retirementAge: RETIREMENT_AGE_DEFAULT,
      endAge: defaultEndAge,
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
    // minus the 529 bucket); a blank spending reloads as the
    // trailing True cost default; blank ages reload as the
    // birth-year current-age default / the current age / 95. (The
    // Percent strategy never reads the annual spending input — its
    // field is hidden — so a cleared spending field falls back to
    // 0 there, which that strategy ignores.)
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
    // A negative "income" is a typo, not a plan: clamp it to 0 so
    // it cannot silently inflate withdrawals via spending − income.
    const extraCents = Math.max(0, parseMoney(extraIncome) ?? 0);
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
  const planYears = inputs ? inputs.endAge - inputs.currentAge : 0;

  /* ----- Engine C: projection ----- */
  const projection = useMemo(() => {
    if (!inputs) return null;
    const returns = Array.from({ length: planYears }, () => expected);
    const det = simulateDetailed(inputs, returns);
    const path = det.balances;
    const ending = path[path.length - 1] ?? 0;
    let lastsToAge: number | null = null;
    if (ending <= 0) {
      for (let i = 1; i < path.length; i++) {
        if ((path[i] ?? 0) <= 0) {
          lastsToAge = inputs.currentAge + i;
          break;
        }
      }
    }
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
      lastsToAge,
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
  // Projection has no success rate: it is at risk when its ending
  // balance is $0 — the portfolio depletes at or before the end
  // age, the same depletion the other engines count as failure.
  // The projection recomputes on every edit, so this updates live.
  const projectionAtRisk = projection != null && projection.ending <= 0;

  // Short-form at-risk explanations for the engine tabs (the pill
  // tooltips carry the full version). Null for a healthy tab — a
  // healthy tab has no badge and no risk tooltip.
  const tabTips: Record<Tab, string | null> = {
    projection:
      projectionAtRisk && projection
        ? `At risk: at the assumed return, the portfolio reaches $0${projection.lastsToAge != null ? ` at age ${projection.lastsToAge}` : ""} — before the plan's end age of ${inputs?.endAge ?? "—"}.`
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
      const projYears = built.inputs.endAge - built.inputs.currentAge;
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

  // Spending-field unit toggle: display only, persisted
  // server-side in settings through the same mechanism (see
  // setRetirementSpendingUnit). A flip updates the local unit
  // immediately — the field, caption, and helper re-render in
  // the new unit without waiting on the refetch — and writes
  // only the preference: the stored annual spending value is
  // never part of this write.
  const setSpendingUnitPref = useMutation({
    mutationFn: (
      input: Parameters<typeof api.setRetirementSpendingUnit>[0],
    ) => api.setRetirementSpendingUnit(input),
    onSuccess: () => {
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

  // Load an input set into the fields: replace every input field
  // with the set's values (nulls fall back exactly as a fresh load
  // would interpret them) and persist immediately through the
  // normal save action. Used both by Load-a-scenario and by
  // Back to my plan (with the baseline input set), so going back
  // writes the baseline back through exactly the same path and the
  // saved record ends up byte-identical to the baseline.
  const applyPlanInputs = (sc: Omit<Scenario, "name">) => {
    if (!data) return;
    const curAge = sc.currentAge ?? data.defaultCurrentAge;
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
    setSpending(
      sc.spendingCents != null
        ? String(sc.spendingCents / 100)
        : String(data.defaultSpendingAnnualCents / 100),
    );
    setCurrentAge(String(curAge));
    setRetirementAge(String(sc.retirementAge ?? curAge));
    setEndAge(String(sc.endAge ?? 95));
    setStocksPct(String(scStocks));
    setExtraIncome(
      sc.extraIncomeCents != null && sc.extraIncomeCents > 0
        ? String(sc.extraIncomeCents / 100)
        : "",
    );
    setExtraStartAge(
      sc.extraIncomeStartAge != null ? String(sc.extraIncomeStartAge) : "",
    );
    const exp = sc.expectedReturnPct ?? blendedExpected(scStocks);
    const volS = sc.volatilityPct ?? blendedVol(scStocks);
    setExpectedPct(String(Math.round(exp * 100) / 100));
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
      exp: String(Math.round(blendedExpected(scStocks) * 100) / 100),
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
      spendingCents: sc.spendingCents,
      currentAge: sc.currentAge,
      retirementAge: sc.retirementAge,
      endAge: sc.endAge,
      stocksPct: sc.stocksPct,
      extraIncomeCents: sc.extraIncomeCents,
      extraIncomeStartAge: sc.extraIncomeStartAge,
      expectedReturnPct: sc.expectedReturnPct,
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
     field through the same More/Less Explainer pattern as the
     Starting portfolio note): the field is a STORED number — it
     was seeded from the trailing True cost figure the server
     computes (defaultSpendingAnnualCents) but does not follow it.
     While the field's effective value equals that figure, the
     short line says where it came from; when it differs, the
     short line names the field as the user's entry and the
     current trailing figure, and the "Use $X" control under the
     note writes the trailing figure into the field through the
     normal autosave path. The trailing figure and its window
     (start/end months, months averaged) come only from the
     server response — the client never recomputes True cost.
     The More detail names both figures whenever they differ, so
     a trailing figure that has moved since the entry was set
     shows the gap plainly instead of silently drifting. */
  const trailingSpendingCents = data.defaultSpendingAnnualCents;
  // The tracked average's monthly presentation for per-month
  // entry mode: the annual figure ÷ 12, rounded to cents for
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
  const spendingShortLine = spendingEqualsTrailing ? (
    <>
      From your {spendingMonthsPhrase} of spending (True cost).{" "}
      {"Income tax isn't in this figure; in retirement your portfolio pays tax on top of spending. The Tax Plan view models that tax year by year."}
    </>
  ) : (
    <>
      Your entry · your {spendingMonthsPhrase} of spending averages{" "}
      {spendingUnit === "month"
        ? `${fmt(trailingMonthlyCents)}/mo`
        : fmt(trailingSpendingCents)}
      {". "}
      {"Income tax isn't in this figure; in retirement your portfolio pays tax on top of spending. The Tax Plan view models that tax year by year."}
    </>
  );
  const spendingMore = spendingEqualsTrailing ? (
    <>
      <p>
        This value is your trailing True cost figure:{" "}
        {spendingUnit === "month"
          ? `${fmt(trailingMonthlyCents)}/mo`
          : `${fmt(trailingSpendingCents)} a year`}{" "}
        — the average month over {spendingWindowDetail}, × 12. It is the same True cost the
        dashboard averages: each month&rsquo;s spending with yearly and
        periodic bills spread evenly across the year.
      </p>
      <p>
        This field is a stored number — it does not follow your
        spending on its own. As new months are added the trailing
        figure can move; when it no longer matches this value, this
        line will show both figures and offer the new one. Type your
        own value to use it as-is, or clear the field to use the
        trailing figure.
      </p>
    </>
  ) : (
    <>
      <p>
        Your entry is {fmt(effectiveSpendingCents)} a year. Your{" "}
        {spendingMonthsPhrase} of spending (True cost) now average{" "}
        {spendingUnit === "month"
          ? `${fmt(trailingMonthlyCents)}/mo`
          : `${fmt(trailingSpendingCents)} a year`}{" "}
        — the average month over {spendingWindowDetail}, × 12, the same True cost the dashboard
        averages. The two figures are{" "}
        {spendingUnit === "month"
          ? `${fmt(Math.round(Math.abs(effectiveSpendingCents - trailingSpendingCents) / 12))}/mo`
          : fmt(Math.abs(effectiveSpendingCents - trailingSpendingCents))}{" "}
        apart, so the trailing figure no longer matches your entry: it
        may have moved as new months were added, or the entry may have
        been typed to differ.
      </p>
      <p>
        This field does not follow your spending automatically — it
        stays at your entry until you change it. Use the &ldquo;Use{" "}
        {spendingUnit === "month"
          ? `${fmt(trailingMonthlyCents)}/mo`
          : fmt(trailingSpendingCents)}
        &rdquo; control to switch to the
        trailing figure, type your own value, or clear the field to
        use the trailing figure.
      </p>
    </>
  );
  // Write the trailing figure through the normal save path: set
  // the field exactly as if it had been typed, so the debounced
  // autosave persists it and the engines re-run on it — no
  // separate write, and the line returns to the equals state once
  // the value lands.
  const handleUseTrailingSpending = () => {
    setSpending(String(trailingSpendingCents / 100));
  };

  /* Which effective inputs differ from the fresh-open defaults
     (the same values Reset to defaults restores: live portfolio /
     trailing-spending defaults, ages birth-year-default / 57 / 95, 95% stocks with
     its blended return / volatility, extra income blank (none)
     with a start age of 67, Constant strategy at 5%). Compared on the EFFECTIVE values the engines
     actually use — clamped ages, blank return / volatility read as
     the blend — so the strip below never claims "defaults" for a
     plan the engines are not running, or "custom" for one they are
     running as defaults. Fields a strategy does not use are not
     compared (the $ spending under Percent, the % under the
     others, the income start age when there is no income). */
  const defaultDiffLabels: string[] = [];
  if (inputs) {
    const expPct = Math.round(expected * 10000) / 100;
    const volPctShown = Math.round(vol * 10000) / 100;
    if (inputs.startCents !== data.defaultPortfolioCents)
      defaultDiffLabels.push("Starting portfolio");
    if (inputs.strategy !== "constant")
      defaultDiffLabels.push("Spending strategy");
    if (inputs.strategy === "percent") {
      if (inputs.percentOfPortfolio !== 5)
        defaultDiffLabels.push("% of portfolio");
    } else if (inputs.spendingCents !== data.defaultSpendingAnnualCents) {
      defaultDiffLabels.push("Annual spending");
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
    if (inputs.currentAge !== data.defaultCurrentAge) defaultDiffLabels.push("Current age");
    if (inputs.retirementAge !== RETIREMENT_AGE_DEFAULT) defaultDiffLabels.push("Retirement age");
    if (inputs.endAge !== 95) defaultDiffLabels.push("End age");
    if (inputs.extraIncomeCents !== EXTRA_INCOME_DEFAULT_CENTS)
      defaultDiffLabels.push("Extra income");
    if (
      inputs.extraIncomeCents > 0 &&
      inputs.extraIncomeStartAge != null &&
      inputs.extraIncomeStartAge !== EXTRA_INCOME_START_AGE_DEFAULT
    )
      defaultDiffLabels.push("Extra income start age");
    if (expPct !== Math.round(blendedExpected(STOCKS_PCT_DEFAULT) * 100) / 100)
      defaultDiffLabels.push("Expected return");
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
    if (diffCents === 0) return "same as Current";
    const sign = diffCents > 0 ? "+" : "−";
    return `${sign}${fmt(Math.abs(diffCents)).replace("−", "")} vs Current`;
  };
  const fmtDeltaPct = (scenarioRate: number, currentRate: number): string => {
    const diff = displayedRateDeltaPoints(scenarioRate, currentRate);
    if (diff === 0) return "same as Current";
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

  /* ----- One-sentence plan summary -----
     A single quiet line at the top of the view that states the
     current plan and its headline outcome in plain words. It is
     display only and introduces no new math: every value is one
     the view already computes and shows — the retirement age,
     spending, effective starting portfolio and mix from the live
     effective inputs (the same ones the Calculated-with strip
     lists: a Net Worth-following portfolio already has the 529
     exclusion applied, a typed value is used as-is), the extra
     income exactly as entered (blank / $0 reads "no extra
     income"), and the outcome tail from the Projection result
     above (its ending balance and the age it reaches $0 — the
     same figures the Projection tab's "Money lasts to" tile
     shows). Because it reads the live inputs, it always
     describes the current (possibly edited) inputs, and it
     renders nothing while the inputs are invalid, when there is
     no Projection result to state truthfully. Spending names its
     strategy whenever the strategy changes what the figure
     means: Guardrails spends the entered amount as its base, and
     Percent of portfolio has no fixed dollar amount, so its
     entered figure is the percent itself. */
  const planSummary: string | null = (() => {
    if (!inputs || !projection) return null;
    const spendPart =
      inputs.strategy === "percent"
        ? `spend ${inputs.percentOfPortfolio}% of portfolio/yr (Percent of portfolio)`
        : inputs.strategy === "guardrails"
          ? `spend ${fmt(inputs.spendingCents)}/yr (Guardrails)`
          : inputs.strategy === "phased"
            ? `spend ${fmt(inputs.spendingCents)}/yr, stepping down ${inputs.phaseDeclinePct}%/yr from age ${inputs.phaseStartAge}`
            : `spend ${fmt(inputs.spendingCents)}/yr`;
    const incomePart =
      inputs.extraIncomeCents > 0
        ? `+ ${fmt(inputs.extraIncomeCents)}/yr from age ${inputs.extraIncomeStartAge ?? inputs.retirementAge}`
        : "no extra income";
    const outcomePart =
      projection.ending > 0
        ? `money lasts past age ${inputs.endAge}`
        : projection.lastsToAge != null
          ? `money runs out at age ${projection.lastsToAge}`
          : `money runs out by age ${inputs.endAge}`;
    return `Retire at ${inputs.retirementAge} · ${spendPart} · ${fmt(inputs.startCents)} portfolio at ${stocks}/${bondsPct} · ${incomePart} → ${outcomePart}.`;
  })();

  return (
    <div className="mt-5">
      <h2 className="display text-3xl font-semibold">Retirement calculator</h2>
      <Explainer
        id="retirement.intro"
        label="Retirement calculator"
        className="mt-1 max-w-2xl"
        summary={
          <>
            Everything runs in <strong className="text-[var(--text)]">today&rsquo;s (real) dollars</strong> — a plan succeeds if the money never runs out before the end age.
          </>
        }
      >
        <p>
          Everything runs in <strong className="text-[var(--text)]">today&rsquo;s (real) dollars</strong> —
          returns are inflation-adjusted, and spending and extra income stay flat in
          today&rsquo;s dollars. Each year, once retired, the plan withdraws
          spending minus extra income (any income above spending is added to
          the portfolio), then that year&rsquo;s real return applies.
          A plan succeeds if the money never runs out — every year&rsquo;s spending is fully funded through the end age. A run that sits at $0 and is later refilled by income still counts as not succeeding, because the money did run out.
        </p>
      </Explainer>

      {planSummary && (
        <p
          aria-label="Plan summary"
          className="tnum mt-2 text-sm leading-relaxed text-[var(--dim)]"
        >
          {planSummary}
        </p>
      )}

      {/* inputs: the top row (Reset / plan status / Save
          controls) is the fold header and stays visible
          whether the form is open or hidden; everything
          under it — the autosave note, the baseline notes,
          and the fields grouped You / Money / Assumptions —
          hides when folded. Display only, every field keeps
          its control and behavior exactly as before. */}
      <section
        aria-label="Retirement inputs"
        className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5"
      >
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
        {inputsOpen && (
          <div id="retirement-inputs-panel">
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
              <input id="rc-current-age" type="text" inputMode="numeric" className={inputCls} value={currentAge} onChange={(e) => setCurrentAge(e.target.value)} />
              <p className="mt-1 text-xs text-[var(--dim)]">Blank = {data.defaultCurrentAge}{data.defaultCurrentAgeFromBirthYear ? " (from your birth year)" : ""}.</p>
            </div>
            <div>
              <label htmlFor="rc-retirement-age" className={labelCls}>Retirement age</label>
              <input id="rc-retirement-age" type="text" inputMode="numeric" className={inputCls} value={retirementAge} onChange={(e) => setRetirementAge(e.target.value)} />
              <p className="mt-1 text-xs text-[var(--dim)]">Later than today? The portfolio grows with no withdrawals until then. Blank = your current age.</p>
            </div>
            <div>
              <label htmlFor="rc-end-age" className={labelCls}>End age</label>
              <input id="rc-end-age" type="text" inputMode="numeric" className={inputCls} value={endAge} onChange={(e) => setEndAge(e.target.value)} />
              <p className="mt-1 text-xs text-[var(--dim)]">The age the plan is tested to. Blank = 95.</p>
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
                <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                  <label htmlFor="rc-spending" className="block text-sm font-medium text-[var(--text)]">
                    {spendingUnit === "month" ? "Spending per month ($)" : "Annual spending ($)"}
                  </label>
                  <div
                    role="group"
                    aria-label="Spending entry period"
                    className="flex overflow-hidden rounded-[var(--radius)] border border-[var(--border)]"
                  >
                    <button
                      type="button"
                      aria-label="Enter spending per year"
                      aria-pressed={spendingUnit === "year"}
                      onClick={() => handleSpendingUnitChange("year")}
                      className={`px-2 py-1 text-xs font-medium ${spendingUnit === "year" ? "bg-[var(--accent)] text-white" : "text-[var(--text)] hover:text-[var(--accent)]"}`}
                    >
                      per year
                    </button>
                    <button
                      type="button"
                      aria-label="Enter spending per month"
                      aria-pressed={spendingUnit === "month"}
                      onClick={() => handleSpendingUnitChange("month")}
                      className={`px-2 py-1 text-xs font-medium ${spendingUnit === "month" ? "bg-[var(--accent)] text-white" : "text-[var(--text)] hover:text-[var(--accent)]"}`}
                    >
                      per month
                    </button>
                  </div>
                </div>
                <input
                  id="rc-spending"
                  type="text"
                  inputMode="decimal"
                  className={inputCls}
                  value={
                    spendingUnit === "month"
                      ? focusField === "spending"
                        ? spendingMonthDraft
                        : formatMonthlyDisplay(spending)
                      : focusField === "spending"
                        ? spending
                        : formatMoneyDisplay(spending)
                  }
                  onFocus={() => {
                    setFocusField("spending");
                    if (spendingUnit === "month") {
                      setSpendingMonthDraft(monthlyRawFromAnnual(spending));
                    }
                  }}
                  onBlur={() => setFocusField(null)}
                  onChange={(e) => {
                    if (spendingUnit === "month") {
                      const raw = e.target.value;
                      setSpendingMonthDraft(raw);
                      const cleaned = raw.replace(/[$,\s]/g, "");
                      const monthlyDollars =
                        cleaned === "" ? NaN : Number(cleaned);
                      // Cents-exact: a typed monthly amount becomes
                      // the stored annual value at exactly monthly
                      // × 12 — Math.round(monthlyDollars × 1200)
                      // cents, never rounded to a prettier annual
                      // figure. Blank / unparseable text is carried
                      // through untouched, so the blank-means-
                      // trailing fallback works exactly as in
                      // per-year mode.
                      setSpending(
                        Number.isFinite(monthlyDollars)
                          ? String(Math.round(monthlyDollars * 1200) / 100)
                          : raw,
                      );
                    } else {
                      setSpending(e.target.value);
                    }
                  }}
                />
                {spendingUnit === "month" && (
                  <p className="mt-1 text-xs text-[var(--dim)]">
                    = {fmt(effectiveSpendingCents)}/yr
                  </p>
                )}
                <Explainer
                  id="retirement.annualSpending"
                  label="Annual spending"
                  className="mt-1"
                  small
                  summary={spendingShortLine}
                >
                  {spendingMore}
                </Explainer>
                {!spendingEqualsTrailing && (
                  <button
                    type="button"
                    aria-label={
                      spendingUnit === "month"
                        ? `Use ${fmt(trailingMonthlyCents)}/mo for annual spending`
                        : `Use ${fmt(trailingSpendingCents)} for annual spending`
                    }
                    onClick={handleUseTrailingSpending}
                    className="mt-1.5 rounded-[var(--radius)] border border-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--accent)]"
                  >
                    {spendingUnit === "month"
                      ? `Use ${fmt(trailingMonthlyCents)}/mo`
                      : `Use ${fmt(trailingSpendingCents)}`}
                  </button>
                )}
                {strategy === "guardrails" && (
                  <p className="mt-1 text-xs text-[var(--dim)]">
                    Base spending for the guardrails strategy — it adjusts by the adjustment size below when the withdrawal rate drifts too far from its starting rate.
                  </p>
                )}
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
              aria-label={data.assumptionsCollapsed ? "Expand Assumptions" : "Collapse Assumptions"}
              aria-expanded={!data.assumptionsCollapsed}
              aria-controls="rc-assumptions-fields"
              disabled={setAssumptionsCollapsed.isPending}
              onClick={() => setAssumptionsCollapsed.mutate({ collapsed: !data.assumptionsCollapsed })}
              className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-medium text-[var(--text)] hover:text-[var(--accent)] disabled:opacity-50"
            >
              {data.assumptionsCollapsed ? "Expand" : "Collapse"}
            </button>
          </div>
          {!data.assumptionsCollapsed && (
            <div id="rc-assumptions-fields" className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-3">
              <div>
                <label htmlFor="rc-expected" className={labelCls}>Expected real return (%)</label>
                <input id="rc-expected" type="text" inputMode="decimal" className={inputCls} value={focusField === "expected" ? expectedPct : formatPctDisplay(expectedPct)} onFocus={() => setFocusField("expected")} onBlur={() => setFocusField(null)} onChange={(e) => setExpectedPct(e.target.value)} />
                <p className="mt-1 text-xs text-[var(--dim)]">Used by Projection &amp; Monte Carlo. Blend default: stocks 7%, bonds 2%. Blank = the blend default for your mix.</p>
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

      {/* Calculated-with strip: the results below always declare
          the exact effective inputs that produced them, whether
          they match the fresh-open defaults, and — briefly, after
          an edit changes them — that they just updated. */}
      {inputs && (
        <div
          aria-label="What the results are calculated with"
          className={`mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-3${flashCls}`}
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <p className="text-sm">
              <strong>Calculated with:</strong>
            </p>
            {resultsFlash && (
              <span className="rounded-full bg-[var(--accent)] px-2.5 py-1 text-xs font-semibold text-white">
                Results updated
              </span>
            )}
          </div>
          {/* Tiles + strategy band (2026-10-25, option B): the
              strip's old bold text line, re-presented. Every value
              below is the exact expression the line rendered —
              tiles for the headline numbers, a band picturing the
              spending strategy's own mechanics from its real
              dials, and a residual line for the rest — so no fact
              the line carried is dropped. */}
          <div className="mt-2 grid grid-cols-2 gap-2 lg:grid-cols-4">
            <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-alt)] px-3 py-2">
              <p className="text-xs text-[var(--dim)]">Portfolio</p>
              <p className="tnum text-base font-semibold">{fmt(inputs.startCents)}</p>
            </div>
            <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-alt)] px-3 py-2">
              <p className="text-xs text-[var(--dim)]">Spending</p>
              <p className="tnum text-base font-semibold">
                {inputs.strategy === "percent"
                  ? `${inputs.percentOfPortfolio}% of portfolio/yr`
                  : `${fmt(inputs.spendingCents)}/yr`}
              </p>
              <p className="text-xs text-[var(--dim)]">
                {inputs.strategy === "percent"
                  ? "Percent of portfolio"
                  : inputs.strategy === "guardrails"
                    ? "Guardrails base"
                    : inputs.strategy === "phased"
                      ? "Phased start"
                      : "Constant"}
              </p>
            </div>
            <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-alt)] px-3 py-2">
              <p className="text-xs text-[var(--dim)]">Ages</p>
              <p className="tnum text-base font-semibold">
                {inputs.currentAge} → retire {inputs.retirementAge} → end {inputs.endAge}
              </p>
            </div>
            <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-alt)] px-3 py-2">
              <p className="text-xs text-[var(--dim)]">Expected return</p>
              <p className="tnum text-base font-semibold">{(expected * 100).toFixed(2)}%</p>
            </div>
          </div>
          {inputs.strategy === "guardrails" ? (
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
                  <div
                    className="relative mt-1 flex h-10 w-full overflow-hidden rounded-[var(--radius)] border border-[var(--border)]"
                    role="img"
                    aria-label={`Guardrails corridor: spending rises by ${adj}% when the withdrawal rate falls below ${raise}% of its starting rate, and falls by ${adj}% when the rate rises above ${cut}% of its starting rate; between ${raise}% and ${cut}% spending is unchanged.`}
                  >
                    <div className="h-full bg-[var(--surface-alt)]" style={{ width: `${raisePos}%` }} />
                    <div className="h-full bg-[var(--accent-soft)]" style={{ width: `${Math.max(0, cutPos - raisePos)}%` }} />
                    <div className="h-full flex-1 bg-[var(--warn-soft)]" />
                    <div
                      aria-hidden="true"
                      className="absolute inset-y-0 border-l border-dashed border-[var(--dim)]"
                      style={{ left: `${startPos}%` }}
                    />
                    <span
                      className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap"
                      style={{ left: `${(raisePos + cutPos) / 2}%` }}
                    >
                      Adjust ±{adj}%
                    </span>
                  </div>
                  <div className="relative mt-1 h-4 text-[11px] whitespace-nowrap text-[var(--dim)]">
                    <span className="absolute -translate-x-1/2" style={{ left: `${raisePos}%` }}>
                      Raise {raise}%
                    </span>
                    <span className="absolute -translate-x-1/2" style={{ left: `${startPos}%` }}>
                      start 100%
                    </span>
                    <span className="absolute -translate-x-1/2" style={{ left: `${cutPos}%` }}>
                      Cut {cut}%
                    </span>
                  </div>
                </div>
              );
            })()
          ) : inputs.strategy === "phased" ? (
            (() => {
              const span = Math.max(1, inputs.endAge - inputs.currentAge);
              const levelAt = (age: number): number =>
                age <= inputs.phaseStartAge
                  ? 1
                  : Math.pow(1 - inputs.phaseDeclinePct / 100, age - inputs.phaseStartAge);
              const points: string[] = [];
              for (let i = 0; i <= 20; i++) {
                const age = inputs.currentAge + (span * i) / 20;
                const x = (i / 20) * 100;
                const y = 33 - levelAt(age) * 27;
                points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
              }
              const startX = Math.min(100, Math.max(0, ((inputs.phaseStartAge - inputs.currentAge) / span) * 100));
              return (
                <div className="mt-3">
                  <p className="text-xs text-[var(--dim)]">
                    Phased — spending level until age {inputs.phaseStartAge}, then steps down {inputs.phaseDeclinePct}%/yr
                  </p>
                  <div
                    className="relative mt-1 h-10 w-full overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-alt)]"
                    role="img"
                    aria-label={`Phased spending shape: level until age ${inputs.phaseStartAge}, then declining ${inputs.phaseDeclinePct}% per year, ending at ${Math.round(levelAt(inputs.endAge) * 100)}% of the starting spending at age ${inputs.endAge}.`}
                  >
                    <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-full w-full" aria-hidden="true">
                      <polyline points={points.join(" ")} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
                    </svg>
                    <div
                      aria-hidden="true"
                      className="absolute inset-y-0 border-l border-dashed border-[var(--dim)]"
                      style={{ left: `${startX}%` }}
                    />
                  </div>
                  <div className="relative mt-1 h-4 text-[11px] whitespace-nowrap text-[var(--dim)]">
                    <span className="absolute left-0">age {inputs.currentAge}</span>
                    <span className="absolute -translate-x-1/2" style={{ left: `${startX}%` }}>
                      steps down from {inputs.phaseStartAge}
                    </span>
                    <span className="absolute right-0">
                      age {inputs.endAge} · {Math.round(levelAt(inputs.endAge) * 100)}% of start
                    </span>
                  </div>
                </div>
              );
            })()
          ) : (
            <div className="mt-3">
              <p className="text-xs text-[var(--dim)]">
                {inputs.strategy === "percent"
                  ? "Percent of portfolio — spending moves with the portfolio balance"
                  : "Constant — spending stays level in today's dollars"}
              </p>
              <div
                className="relative mt-1 flex h-10 w-full items-center overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-alt)]"
                role="img"
                aria-label={
                  inputs.strategy === "percent"
                    ? `Spending shape: ${inputs.percentOfPortfolio}% of the portfolio balance each year.`
                    : "Spending shape: a level amount every year, in today's dollars."
                }
              >
                <div
                  aria-hidden="true"
                  className={`mx-3 h-[3px] w-full rounded bg-[var(--accent)]${inputs.strategy === "percent" ? " opacity-70" : ""}`}
                />
              </div>
            </div>
          )}
          <p className="tnum mt-2 text-sm">
            {stocks}% stocks · Volatility {(vol * 100).toFixed(2)}%
            {inputs.extraIncomeCents > 0 &&
              ` · Extra income ${fmt(inputs.extraIncomeCents)}/yr from age ${inputs.extraIncomeStartAge ?? inputs.retirementAge}`}
          </p>
          <p className="mt-1 text-xs text-[var(--dim)]" aria-live="polite">
            {defaultDiffLabels.length === 0
              ? "These are the defaults — the same values Reset to defaults restores."
              : `Custom inputs — differs from the defaults in: ${defaultDiffLabels.join(", ")}.`}
          </p>
        </div>
      )}

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
            ["projection", "Projection", projectionAtRisk],
            ["historical", "Historical", historicalAtRisk],
            ["montecarlo", "Monte Carlo", monteCarloAtRisk],
            ["maxspending", "Max Spending", maxSpendingAtRisk],
          ] as [Tab, string, boolean][]
        ).map(([t, label, atRisk]) => {
          const selected = tab === t;
          const tip = atRisk ? tabTips[t] : null;
          const tipOpen = tip != null && tipTab === t;
          return (
          <button
            key={t}
            type="button"
            aria-label={atRisk ? `${label} engine — at risk` : `${label} engine`}
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
            {tipOpen && tip && (
              <TipBubble id={`rc-tab-tip-${t}`} text={tip} below />
            )}
          </button>
          );
        })}
      </div>

      {inputs && tab === "projection" && projection && (
        <section aria-label="Projection results" className={`mt-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5${flashCls}`}>
          <div className={`grid grid-cols-2 gap-2.5 sm:gap-3 ${inputs.strategy === "percent" && projection.finalYearSpending != null ? "lg:grid-cols-4" : "lg:grid-cols-3"}`}>
            <div className="rounded-[var(--radius)] border border-[var(--border)] p-3.5">
              <p className="text-[10.5px] font-medium tracking-[0.02em] text-[var(--dim)] uppercase">Ending balance at {inputs.endAge}</p>
              {projectionAtRisk ? (
                <p className="mt-1.5"><AtRiskEndingPill lastsToAge={projection.lastsToAge} endAge={inputs.endAge} /></p>
              ) : (
                <p className="tnum display mt-1.5 text-xl font-semibold">{fmt(projection.ending)}</p>
              )}
              {projDeltaText && (
                <p className="mt-1 text-xs font-medium text-[var(--dim)]">{projDeltaText}</p>
              )}
            </div>
            <div className="rounded-[var(--radius)] border border-[var(--border)] p-3.5">
              <p className="text-[10.5px] font-medium tracking-[0.02em] text-[var(--dim)] uppercase">Assumed real return</p>
              <p className="tnum display mt-1.5 text-xl font-semibold">{(expected * 100).toFixed(2)}% / yr</p>
            </div>
            <div className="rounded-[var(--radius)] border border-[var(--border)] p-3.5">
              <p className="text-[10.5px] font-medium tracking-[0.02em] text-[var(--dim)] uppercase">Money lasts to</p>
              <p className="tnum display mt-1.5 text-xl font-semibold">
                {projection.lastsToAge != null ? `Age ${projection.lastsToAge}` : `Age ${inputs.endAge}+`}
              </p>
              {projection.lastsToAge != null && (
                <p className="mt-1 text-xs text-[var(--dim)]">The portfolio runs out at this age at a steady {(expected * 100).toFixed(2)}% real return.</p>
              )}
            </div>
            {inputs.strategy === "percent" && projection.finalYearSpending != null && (
              <div className="rounded-[var(--radius)] border border-[var(--border)] p-3.5">
                <p className="text-[10.5px] font-medium tracking-[0.02em] text-[var(--dim)] uppercase">Final-year spending (age {projection.finalYearAge})</p>
                <p className="tnum display mt-1.5 text-xl font-semibold">{fmt(projection.finalYearSpending)}</p>
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
                <p className="mt-1 text-xs text-[var(--dim)]">Median across runs, in the final year (age {inputs.endAge - 1})</p>
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
                  <p className="mt-1 text-xs text-[var(--dim)]">Median across runs, in the final year (age {inputs.endAge - 1})</p>
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
              {parseNum(solverTarget) == null
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
                                  {p.name}: {typeof p.value === "number" ? `${p.value.toFixed(1)}%` : "no run fits"}
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
                                  {p.name}: {typeof p.value === "number" ? tooltipMoney(p.value) : "no run fits"}
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
                          <button
                            type="button"
                            aria-label={`Delete ${sc.name}`}
                            className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm font-medium text-[var(--text)] hover:text-[var(--bad)] disabled:opacity-50"
                            disabled={deleteScenario.isPending}
                            onClick={() => deleteScenario.mutate(sc.name)}
                          >
                            Delete
                          </button>
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
