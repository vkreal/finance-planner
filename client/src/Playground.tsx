import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ApiResponse } from "./api";
import { usePersistedFold } from "./foldState";
import { usePersistedChoice } from "./persistedChoice";
import { FoldChevron } from "./FoldChevron";
import { ExplainerInfoTip } from "./Explainer";
import {
ceilChipActiveCls,
ceilChipCls,
FILING_LABELS,
fmtDollars,
fmtMoneyInput,
hintCls,
InfoNote,
inputCls,
labelCls,
moneyField,
monthlyRaw,
monthlyToAnnual,
numField,
parseDollars,
parseIntField,
parseMoney,
parseNum,
pctField,
sectionCls,
SEED_BIRTH_YEAR_PRIMARY,
SEED_BIRTH_YEAR_SPOUSE,
SEED_INFLATION,
SEED_SS_PRIMARY_CENTS,
SEED_SS_START_AGE,
type FilingStatus,
type RetData,
type RothData,
} from "./rothShared";
// The tax engine and law tables live server-side (shared with the
// accuracy self-check fixtures) — see server/src/taxEngine.ts and
// server/src/taxLaw.ts. The client runs the same code the fixtures
// pin, so what is priced here is what is tested there.
import { acaHouseholdSizeForYear, irmaaTierUpTo, simulateRothPlan } from "@space/server/taxEngine";
import { impliedYieldPctsFromTaxReturn, qualifiedDividendSharePctFromTaxReturn, taxReturnPrefillDollars } from "@space/server/taxReturnCore";
import { lawForYear, TAX_LAW_YEARS } from "@space/server/taxLaw";
import { blendedExpected, STOCKS_PCT_DEFAULT } from "@space/server/retirementEngines";
import { compareStrategyFromSaved, parsePlaygroundPaste, planInputsFromSaved, PLAYGROUND_CASH_LEFT_BASIS, pricePlaygroundYear, projectPlaygroundYears, solvePlaygroundAcaCliffFill, solvePlaygroundBracketFill, type PlaygroundProjection, type PlaygroundYearInputs, type PlaygroundYearResult } from "@space/server/rothOptimizer";
import { projTemplateFromStored, projTemplateToStored } from "@space/server/projTemplateCore";

/* The Playground view — one standalone year priced from typed
   dials through the shared engine (pricePlaygroundYear in
   rothOptimizer.ts). The form's dials are REMEMBERED between
   sessions in the app's UI-state store (the playground field
   of the Roth UI-state blob — see the persistence block
   below), so the numbers being played with are still there on
   the next visit; "Reset playground" wipes them back to the
   fresh blank form. Nothing here is ever saved to the plan
   record or enters a scenario. Promoted from a Roth-view tab
   to a top-level view — same dials, same pricing, same
   readouts; "Start from my numbers" reads the Roth record
   (below) exactly as it did from inside the Roth view. */

/* Income-stacking model — the ONE computation behind the
   Playground readout's full stacking chart. Presentation
   ONLY: every amount is
   read straight off the priced result (`pg`,
   pricePlaygroundYear's own fields) and the SAME law row the
   pricing used (lawForYear for the dialed year + filing status,
   fallback row included); this computes nothing but layout —
   cumulative offsets, widths, band spans, and marker positions.
   Sourcing: Interest ← pg.interest; Ordinary dividends ←
   pg.nonQualifiedDividends (the part of the entered line 3b
   total that is not qualified — the qualified part rides the
   gains stack, so the total is counted once); Other ordinary
   income ← pg.otherOrdinary;
   Taxable Social Security ← pg.ssTaxable; RMD ← pg.rmd (only when
   pg.rmdPriced); Pre-tax money out ← pg.conversion +
   pg.spendingDraw (the two money-out dials' priced sum,
   stacked last);
   Deductions ← pg.deductions; ordinary taxable income ←
   pg.ordinaryTaxableIncome; total taxable income ←
   pg.taxableIncome; gains ← pg.ltcgPriced, split as
   pg.qualifiedDividends + max(0, pg.ltcgNet), less the
   §1211(b) capital-loss allowance (pg.capitalLossAllowance)
   as a negative segment when one priced (S-9), so the drawn
   stack foots to AGI; bracket tops/rates and
   the capital-gains thresholds ← law.brackets / law.rates /
   law.ltcgZeroTop / law.ltcg20Floor for the filing status.
   The track is the gross stack (AGI) laid over a taxable-income
   axis offset by deductions: a bracket top T sits at track
   position deductions + T, so the bar foots as gross stack −
   deductions = taxable income, and a filled bracket's conversion
   segment ends exactly on that top's dashed line. The hatched
   overlay covers the first `deductions` of the stack — the
   sheltered part. */
const STACK_HATCH_STYLE = {
  backgroundImage:
    "repeating-linear-gradient(45deg, rgba(255,255,255,0.5) 0 5px, rgba(0,0,0,0.22) 5px 10px)",
} as const;

/* Muted per-bracket colours for the stacking chart's bracket
   markers (10 / 12 / 22 / 24, in band order): each marker's
   dashed line, its top label, and its bottom-legend text all
   share the one colour in the full chart (the colour rides
   on the marker objects buildStackModel returns). The ACA
   cliff keeps
   var(--warn); the 0% gains-end line and its label keep
   their own pink (#db2777 — build v114: recoloured off
   the qualified-dividends green #65a30d the gains segments
   and legend still use, so the marker can never be read as
   a segment edge); the 20%-floor tick is
   not part of this scheme. */
const STACK_MARKER_COLORS = ["#64748b", "#6ea8d8", "#5f6caf", "#7a5c8f"] as const;

type StackSeg = {
  key: string;
  label: string;
  short?: string;
  amount: number;
  color: string;
  /* Hatched segment (S-9): the §1211(b) allowance segment —
     a negative amount drawn with the deductions hatch over
     the stack's tail, in the bar and in the legend swatch
     alike, marking income the stack does not keep. */
  hatch?: boolean;
};
type StackSegPos = StackSeg & {
  leftPct: number;
  widthPct: number;
  wide: boolean;
};

/* Bracket-top tick labels at the top ends of their guide lines
   (build v84, de-collision fix within v84): the strip
   above the bar carries one label per bracket top, each
   centred on its own dashed line. The labels are laid out
   on a single row — but at phone width two neighbouring
   tops can sit close enough that their label boxes touch
   or overlap, and the later label then paints over the
   earlier one's tail. So this strip MEASURES its real
   spans (offsetLeft is the visual centre, because each
   span is centred with translateX(-50%); offsetWidth is
   the real width, edge clamp included) and drops a label
   to a second row whenever its left edge would come
   within 2px of the previous label on the first row —
   still centred on its own line, one row lower, with the
   strip growing to hold both rows and everything below
   flowing down. Where labels do not collide, nothing
   changes: one row, same geometry as before. Measuring
   (not a character-width model) keeps the rule true
   whatever the figures or the rendered font. COLOR RULE
   (build v86): each label takes the exact colour of the
   dashed guide line it names — the marker's `color`, carried
   through the TickLabel — never a per-label hard-coded hex. */
type TickLabel = {
  rate: number;
  to: number;
  color: string;
  /* Build v114: an optional ⓘ note for one tick — the
     landing bracket's top — composed live by the caller
     from the same marker figures. Ticks without a note
     render exactly as before (aria-hidden text only). */
  note?: string;
  noteAriaLabel?: string;
};

const EMPTY_STAGGERED: ReadonlySet<number> = new Set();
const EMPTY_CHART_LABELS: ReadonlySet<string> = new Set();

function TickStrip({
  ticks,
  taxX,
}: {
  ticks: TickLabel[];
  taxX: (value: number) => number;
}) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const spanRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const [staggered, setStaggered] =
    useState<ReadonlySet<number>>(EMPTY_STAGGERED);
  /* Build v120: which noted ticks have their tooltip open —
     the open tick's span lifts to 25, above its z-20 siblings,
     while its bubble is open, so the bubble paints above the
     neighbouring tick labels instead of underneath them; it
     drops back to 20 when the bubble closes. Build v129:
     both levels sit below the z-30 sticky play strip, so the
     tick labels slide under the strip when the chart scrolls
     under it instead of painting over its text. A set, not a single
     holder, so a pinned tick stays lifted while another tick is
     hovered. The updater is identity-guarded: re-reporting the
     same open/closed value returns the same set, so no render
     follows. */
  const [openNotes, setOpenNotes] =
    useState<ReadonlySet<number>>(EMPTY_STAGGERED);
  const setNoteOpen = (rate: number, open: boolean) =>
    setOpenNotes((prev) => {
      if (prev.has(rate) === open) return prev;
      const next = new Set(prev);
      if (open) next.add(rate);
      else next.delete(rate);
      return next;
    });
  /* The positions the stagger decision is judged from, as
     one key: the effect re-measures whenever a label's
     centre moves, and the ResizeObserver re-measures
     whenever the strip's width changes. */
  const measureKey = ticks
    .map((m) => `${m.rate}:${taxX(m.to).toFixed(2)}`)
    .join("|");
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (strip == null) return;
    let cancelled = false;
    const measure = () => {
      if (cancelled) return;
      const items: Array<{ rate: number; left: number; right: number }> = [];
      ticks.forEach((m, i) => {
        const el = spanRefs.current[i];
        if (el == null) return;
        const half = el.offsetWidth / 2;
        items.push({
          rate: m.rate,
          left: el.offsetLeft - half,
          right: el.offsetLeft + half,
        });
      });
      items.sort((a, b) => a.left - b.left);
      let row1End = -Infinity;
      let row2End = -Infinity;
      const next = new Set<number>();
      for (const it of items) {
        if (it.left >= row1End + 2) {
          row1End = it.right;
        } else if (it.left >= row2End + 2) {
          next.add(it.rate);
          row2End = it.right;
        } else {
          /* Nowhere to stagger to — stay on the first row,
             no worse than the pre-fix layout. */
          row1End = Math.max(row1End, it.right);
        }
      }
      setStaggered((prev) => {
        if (
          prev.size === next.size &&
          [...next].every((rate) => prev.has(rate))
        ) {
          return prev;
        }
        return next;
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    void document.fonts.ready.then(() => {
      measure();
    });
    return () => {
      cancelled = true;
      observer.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ticks/taxX are captured through measureKey.
  }, [measureKey]);
  return (
    <>
      <div
        ref={stripRef}
        className={`relative mt-1 ${staggered.size > 0 ? "h-8" : "h-4"}`}
      >
        {ticks.map((m, i) => (
          <span
            key={m.rate}
            ref={(el) => {
              spanRefs.current[i] = el;
            }}
            className={`tnum absolute text-[11px] whitespace-nowrap ${staggered.has(m.rate) ? "top-4" : "top-0"}`}
            style={{
              left: `clamp(24px, ${taxX(m.to)}%, calc(100% - 24px))`,
              transform: "translateX(-50%)",
              color: m.color,
              /* A noted tick's bubble must paint above the
                 chart area below (the z-20 lift of the 0%
                 InfoNote pattern); the centring transform
                 traps the bubble's own z-index inside this
                 span, so the lift rides on the span itself.
                 Build v120: while the tick's own bubble
                 is open the span lifts to 25, above its
                 sibling ticks, so the bubble paints above
                 them too. Build v129: both levels sit
                 below the z-30 sticky play strip, so the
                 tick labels slide under the strip when the
                 chart scrolls under it. */
              zIndex: m.note != null ? (openNotes.has(m.rate) ? 25 : 20) : undefined,
            }}
          >
            <span aria-hidden="true">
              {m.rate}% · {fmtDollars(m.to)}
            </span>
            {m.note != null && (
              <InfoNote
                text={m.note}
                ariaLabel={m.noteAriaLabel ?? `About the ${m.rate}% bracket top`}
                align={taxX(m.to) > 60 ? "right" : "left"}
                onOpenChange={(open) => setNoteOpen(m.rate, open)}
              />
            )}
          </span>
        ))}
      </div>
      <div className="h-[10px]" aria-hidden="true" />
    </>
  );
}

function buildStackModel(
  pg: PlaygroundYearResult,
  pgYearNum: number,
  pgFiling: FilingStatus,
) {
  const law = lawForYear(pgYearNum);
  const fs = pgFiling;
  const tops = law.brackets[fs];
  const rates = law.rates;
  const ordSegs: StackSeg[] = [
    { key: "interest", label: "Interest", amount: pg.interest, color: "#3b82f6" },
    { key: "orddiv", label: "Ordinary dividends (non-qualified part)", short: "Ord dividends", amount: pg.nonQualifiedDividends, color: "#06b6d4" },
    { key: "other", label: "Other ordinary income", short: "Other income", amount: pg.otherOrdinary, color: "#f59e0b" },
    { key: "ss", label: "Taxable Social Security", short: "Taxable SS", amount: pg.ssTaxable, color: "#ef4444" },
  ];
  if (pg.rmdPriced) {
    ordSegs.push({ key: "rmd", label: "RMD", amount: pg.rmd, color: "#8b5cf6" });
  }
  ordSegs.push({ key: "conv", label: "Pre-tax money out", short: "Pre-tax out", amount: pg.conversion + pg.spendingDraw, color: "#0f766e" });
  const visibleOrdSegs = ordSegs.filter((s) => s.amount !== 0);
  const grossOrd = ordSegs.reduce((a, s) => a + s.amount, 0);
  const deductions = pg.deductions;
  const ordinaryTaxable = pg.ordinaryTaxableIncome;
  const gainsTotal = pg.ltcgPriced;
  // The §1211(b) capital-loss allowance reduces the net
  // stack (it is priced against ordinary income, after the
  // loss offsets gains), so the gross total foots to AGI.
  // The drawn segments carry the same allowance as a
  // negative segment (see gainsSegs below, S-9), so the
  // rendered stack — bar and legend alike — foots to the
  // same AGI instead of overstating it by the allowance.
  const grossTotal = grossOrd + gainsTotal - pg.capitalLossAllowance;
  const top24 = tops[3] ?? 0;
  // The taxable axis runs to the top of the highest bracket the
  // ordinary stack reaches into — the smallest bracket top at or
  // above the ordinary taxable income — so a fill into a higher
  // bracket extends the axis by construction. Only when the
  // ordinary stack passes the 24% top does the base axis fall
  // back to covering the full taxable income (gains included).
  const axisBaseMax = (() => {
    const reached = tops.find(
      (t) => t != null && pg.ordinaryTaxableIncome <= t,
    );
    return reached != null ? reached : Math.max(top24, pg.taxableIncome);
  })();
  /* Axis headroom (build v76): the drawn axis extends a
     margin past the rightmost plotted landmark, so landmarks
     that map just past the landing bracket's top — the stack
     end including gains, and the ACA cliff line's taxable-axis
     position — are drawn on the chart instead of piling up
     against (or falling off) its right edge, and the cliff /
     buffer lines are inside the drawn axis by construction.
     The rightmost landmark is the largest of the base axis
     end, the stack end including gains (taxable income), and
     the cliff line's position when the priced year carries a
     hard cliff (the same taxable-axis construction the cliff
     line itself uses: cliff − (ACA MAGI − taxable income);
     the buffer line sits left of the cliff line, so it is
     never the rightmost). The axis end is then set so that
     landmark sits at 86% of the track — the track is the axis
     offset by deductions, so the 86% is measured in track
     coordinates, not taxable coordinates — rounded up to the
     nearest $100 so the axis-end label stays a round figure.
     Only the scale's end moves: no priced figure, stack
     proportion, or marker position relative to the stack
     changes. */
  const cliffTaxablePos =
    pgYearNum >= 2026 && pg.aca.applies && pg.aca.cliff != null
      ? pg.aca.cliff - (pg.acaMagi - pg.taxableIncome)
      : null;
  const rightmostTaxable = Math.max(
    axisBaseMax,
    pg.taxableIncome,
    cliffTaxablePos ?? Number.NEGATIVE_INFINITY,
  );
  const axisTaxableMax = Math.max(
    axisBaseMax,
    Math.ceil(
      ((deductions + rightmostTaxable) / 0.86 - deductions) / 100,
    ) * 100,
  );
  const trackMax = Math.max(deductions + axisTaxableMax, grossTotal);
  const pct = (trackVal: number) =>
    trackMax > 0 ? Math.max(0, Math.min(100, (trackVal / trackMax) * 100)) : 0;
  const taxX = (taxableVal: number) => pct(deductions + taxableVal);
  const bands = [0, 1, 2, 3].map((i) => ({
    rate: rates[i] ?? 0,
    from: i === 0 ? 0 : (tops[i - 1] ?? 0),
    to: tops[i] ?? 0,
  }));
  const markers = bands.map((b, i) => ({
    ...b,
    room: b.to - ordinaryTaxable,
    // The marker's one colour (line, top label, legend text —
    // both charts) and whether its top falls inside the axis:
    // a marker beyond the base axis cap draws no line (the
    // ACA-line precedent), though its label stays, pinned at
    // the chart's right edge. Headroom (build v76) does
    // not promote a higher bracket's line: inAxis is judged
    // against the base axis end, before headroom is added.
    color: STACK_MARKER_COLORS[i] ?? "var(--dim)",
    inAxis: b.to <= axisBaseMax,
  }));
  let cum = 0;
  const ordPos: StackSegPos[] = visibleOrdSegs.map((s) => {
    const start = cum;
    cum += s.amount;
    const left = Math.min(start, cum);
    const widthPct = pct(Math.abs(s.amount));
    return { ...s, leftPct: pct(left), widthPct, wide: widthPct >= 9 };
  });
  /* The gains stack decomposed from the priced result's own
     components (S-9): the qualified dividends, the priced net
     capital gain — max(0, pg.ltcgNet), NOT the typed sale gain
     (pg.stockGain): an entering loss carryforward nets against
     the sale before the stack prices and a harvested gain adds
     to it, so the typed figure alone can overstate or
     understate the priced part — and, when a net capital loss
     priced one, the §1211(b) allowance as a NEGATIVE segment,
     so the segments sum to gainsTotal − capitalLossAllowance
     and the whole drawn stack foots to grossTotal (AGI),
     exactly as the additive rows below the chart do. Before
     S-9, a year whose sale lost money drew ONE segment
     labelled "Long-term gains (net)" for the whole ltcgPriced:
     on the settlement's loss-year example that read $15,000 of
     "gains" where there were no gains at all (the $15,000 was
     entirely qualified dividends; the sale lost $5,000), and
     no segment carried the allowance, so the rendered stack
     stood at $21,500 against an AGI of $18,500 — overstated
     by the $3,000 allowance. Each segment is gated on its own
     priced figure, so a no-loss year draws exactly the
     segments it drew before. */
  const gainsSegs: StackSeg[] = [];
  if (pg.qualifiedDividends > 0) {
    gainsSegs.push({ key: "qualdiv", label: "Qualified dividends", short: "Qual div", amount: pg.qualifiedDividends, color: "#84cc16" });
  }
  const netGainPart = Math.max(0, pg.ltcgNet);
  if (netGainPart > 0) {
    gainsSegs.push({ key: "ltgain", label: "Long-term gain", short: "LT gain", amount: netGainPart, color: "#f97316" });
  }
  if (pg.capitalLossAllowance > 0) {
    gainsSegs.push({ key: "caplossallowance", label: "Capital-loss allowance (§1211(b))", short: "Loss allowance", amount: -pg.capitalLossAllowance, color: "#8a8378", hatch: true });
  }
  let gCum = grossOrd;
  const gainsPos: StackSegPos[] = gainsSegs.map((s) => {
    const start = gCum;
    gCum += s.amount;
    // A negative segment (the §1211(b) allowance) draws over
    // the tail it removes: its left edge is the LOWER of the
    // two cumulative edges — the ordPos convention for
    // negative amounts, applied to the gains stack. Positive
    // segments are positioned exactly as before.
    const left = Math.min(start, gCum);
    const widthPct = pct(Math.abs(s.amount));
    return { ...s, leftPct: pct(Math.max(0, left)), widthPct, wide: widthPct >= 12 };
  });
  // The legend lists EVERY segment with its full name and
  // amount, so no figure depends on an in-bar label fitting:
  // in-bar labels are the short form and can truncate on narrow
  // screens or under the deductions hatch without hiding any
  // number.
  const legendSegs = [...ordPos, ...gainsPos];
  const zeroTop = law.ltcgZeroTop[fs];
  const floor20 = law.ltcg20Floor[fs];
  const show20 = gainsTotal > 0 && pg.taxableIncome >= floor20;
  return {
    bands,
    markers,
    ordPos,
    gainsPos,
    visibleOrdSegs,
    gainsSegs,
    legendSegs,
    deductions,
    ordinaryTaxable,
    gainsTotal,
    grossOrd,
    axisTaxableMax,
    zeroTop,
    floor20,
    show20,
    pct,
    taxX,
    hatchStyle: STACK_HATCH_STYLE,
  };
}

/* Cent-precision dollar formatting for the engine's own total
   tax (pg.totalTax — federal + state summed at cent precision
   by the engine, build v63 F2). The "Total tax" figures
   OUTSIDE the sale-after-tax readout print this value as-is, so
   a $0.60 federal / $0.42 state year reads $1.02 — the engine's
   total — not $2 (the sum of the separately rounded components).
   The sale-after-tax readout keeps its own deliberate
   component-first rounding (see the engine's
   saleAfterTax), untouched by this convention. */
function fmtDollarsExact(dollars: number): string {
  const neg = dollars < 0;
  const s = `$${Math.abs(dollars).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
  return neg ? `−${s}` : s;
}

/* Month / Year pills for the two spend readouts ("Cash left
   after tax" and "Left after a year's spending"): ONE shared
   persisted state (the "playground.spendPerMonth" fold-store
   flag — see the hook in the Playground component), rendered
   at both readout spots (the sticky play strip and the Tax
   for the year card), so tapping either pill group switches
   both readouts together. Display only: in Month mode each
   readout shows its annual figure divided by 12 at cent
   precision with a "/mo" suffix and its label / sub-line
   names the month; the underlying priced figures, the dials,
   and every stored figure are untouched. Mirrors the
   Spending view's per-year / per-month pill styling. */
function SpendPeriodPills({
  perMonth,
  onChange,
}: {
  perMonth: boolean;
  onChange: (perMonth: boolean) => void;
}) {
  const pillCls = (active: boolean) =>
    `px-2 py-1 text-xs font-medium ${active ? "bg-[var(--accent)] text-white" : "text-[var(--text)] hover:text-[var(--accent)]"}`;
  return (
    <div
      role="group"
      aria-label="Spend display period"
      className="flex shrink-0 overflow-hidden rounded-[var(--radius)] border border-[var(--border)]"
    >
      <button
        type="button"
        aria-label="Show spend per month"
        aria-pressed={perMonth}
        onClick={() => onChange(true)}
        className={pillCls(perMonth)}
      >
        Month
      </button>
      <button
        type="button"
        aria-label="Show spend per year"
        aria-pressed={!perMonth}
        onClick={() => onChange(false)}
        className={pillCls(!perMonth)}
      >
        Year
      </button>
    </div>
  );
}

/* Held fill target — a bracket top (its rate pct) or the ACA
   cliff chip's target. One union drives the whole Hold system:
   tapping any fill chip records its target here, and the hold
   effect re-solves for whichever target is recorded. */
type PgHeldTarget = number | "aca";

/* The remembered Playground form state, in the exact shape
   the UI-state store carries it (getRothUiState's playground
   field) — the form's dials in their own typed-string units. */
type PgSavedForm = ApiResponse<typeof api, "getRothUiState">["playground"];

/* A pending remembered-form save (build v195, re-audit
   round 3 SHOULD-6): the form snapshot the debounced save
   owes the store, the JSON it was captured from, and whether
   it is a wholesale replacement (Reset / paste / prefill —
   the pgForceWholesaleRef flag as it stood when this
   snapshot was queued). The unmount flush carries exactly
   this record, so a flush — and its retries — save the form
   exactly as the debounced save would have. */
type PgFormPendingSave = {
  snapshot: PgSavedForm;
  json: string;
  wholesale: boolean;
};

/* The Tax Plan record's writer (saveRothInputs) — the
   Spending dial's write-through (build v145) saves
   through it, the same writer the Tax Plan and Retirement
   views use. */
type RothSavePayload = Parameters<typeof api.saveRothInputs>[0];

/* A queued Tax Plan write-through edit (build v152,
   audit M-3): ONLY the local spending delta — the target
   annualSpendingCents this view means to write. The
   whole-record payload is rebuilt from it at fire time; a
   payload snapshotted at queue time is exactly what let a
   stale write-through ride out under a fresh CAS base and
   silently revert another tab's save. */
type PgRothDelta = { annualSpendingCents: number };

/* The Tax Plan record as getRothPlanner returns it — the
   shape a whole-record save payload is built from. The
   unmount flush's guard-holding path (build v169) builds
   from a record fetched fresh at flush time, not from the
   possibly stale fetched record the view last rendered. */
type RothPlannerRecord = Awaited<ReturnType<typeof api.getRothPlanner>>;

/* The projection template snapshot in the store's shape, and
   back: the two mapping functions live in the shared core
   (server/src/projTemplateCore.ts) so the accuracy fixtures
   pin the exact functions this view calls. The store carries
   the FULL engine-input field set the projection runs from
   (see playgroundProjTemplateState in rothUiStateCore.ts) —
   since P-S8 including the settlement facts, carry-ins,
   funding draws, health premiums, reinvested yield, annual
   spending, and harvest pair the first stored shape dropped
   — so the two shapes differ only in the optional-field
   spellings buildPgInputs leaves open. */

/* Build v177 (re-audit NICE-TO-HAVE N-3): the bound on a
   save fire path's hold polls — a fire path waiting for an
   in-flight save to settle re-checks every 300 ms at most
   this many times (100 × 300 ms = 30 s) before it gives up
   explicitly instead of polling forever. The same bound and
   give-up are applied in every writer that carries the hold
   (App.tsx, RetirementCalc.tsx, RothConversion.tsx). */
const SAVE_HOLD_MAX_POLLS = 100;

/* Build v196 (re-audit round 3 SHOULD-7): how long a flush
   deferred behind an in-flight save (the S-3 / S-4 slots —
   this view carries two, the Tax Plan write-through's and
   the remembered form's) waits for that save to settle
   before the deferred send fires anyway — the same 30 s
   scale as the hold bound above (100 × 300 ms), far beyond
   any save this app makes. A save that has not settled in
   30 s is hung (its promise neither resolves nor rejects,
   so its settle handlers — the slot's only consumer —
   never run), and without this bound the deferred edit
   sits in its slot forever: never sent, never reported.
   On expiry the slot's send fires through the retrying
   flush path exactly as it would have on a settle (see
   the slots' comments below). The same bound is applied
   in every writer that carries a deferred slot
   (RothConversion.tsx, RetirementCalc.tsx). */
const DEFERRED_FLUSH_GIVE_UP_MS = 30000;

export function Playground({
  onJumpToYourMoney,
}: {
  /* Cross-view jump (PLAN TOTAL VISIBILITY build): App
     switches to the Tax Plan view with a jump target for the
     Exclude from plan field in its Your money panel, so the
     Plan total tap at the top of this view lands on the
     exclusion's home field where it can be edited. Optional:
     without it the Plan total renders as plain text. */
  onJumpToYourMoney?: () => void;
} = {}) {
  const rq = useQuery({ queryKey: ["rothplanner"], queryFn: () => api.getRothPlanner({}) });
  // Remembered form state rides the Roth UI-state blob (its
  // own query key, so this view's cache entry is independent
  // of the Roth view's).
  const pgUiQ = useQuery({
    queryKey: ["playgroundui"],
    queryFn: () => api.getRothUiState({}),
  });
  const pgQueryClient = useQueryClient();
  /* Revision (CAS) tracking for this view's writes into the
     shared UI-state blob: the revision the remembered form was
     last read or successfully saved at. Saves pass it as
     baseRevision (see savePgCas in the persistence block
     below); a conflict means another writer saved first, and
     the save re-merges against the server's current blob and
     retries once at the fresh revision, so the most recent
     edits are never silently dropped. Null until the first
     read lands. */
  const pgRevisionRef = useRef<number | null>(null);
  /* Landing-label connector (build v114): the thin leader
     line from the floating landing-bracket label down to its
     dashed bracket-top guide line. The two ends live in
     different subtrees — the label row above the chart, the
     guide-line overlay inside the bar area — with a variable
     set of rows between them (the buffer label row, the tick
     strip with its measured stagger), so, following the
     TickStrip precedent, the line's height is MEASURED
     between the two elements rather than computed from the
     layout rules. Null until measured, and whenever either
     end is not rendered (no priced year, no landing marker,
     or a marker outside the axis, where no dashed line is
     drawn to connect to). */
  const stackLabelsRef = useRef<HTMLDivElement | null>(null);
  const stackChartRef = useRef<HTMLDivElement | null>(null);
  const stackLinesRef = useRef<HTMLDivElement | null>(null);
  const [landingLinkH, setLandingLinkH] = useState<number | null>(null);
  /* Build v120: which income-stack chart labels have their
     tooltip open — the open label's span lifts to 25, above its
     z-20 siblings, while its bubble is open, so the bubble
     paints above the neighbouring labels instead of underneath
     them; it drops back to 20 when the bubble closes. Contract
     v129: both levels sit below the z-30 sticky play strip, so
     the labels slide under the strip when the chart scrolls
     under it instead of painting over its text — the v82/v87
     lift had them at 31, above the strip, which is the overlap
     the user reported — while staying above the chart-area
     content (the z-10 marker, the z-1 gains track, the bars
     and tints), so each label's bubble still paints above the
     chart area below it. A set, not
     a single holder, so a pinned label stays lifted while
     another label is hovered. The updater is identity-guarded:
     re-reporting the same open/closed value returns the same
     set, so no render follows. */
  const [openChartLabels, setOpenChartLabels] =
    useState<ReadonlySet<string>>(EMPTY_CHART_LABELS);
  const setChartLabelOpen = (id: string, open: boolean) =>
    setOpenChartLabels((prev) => {
      if (prev.has(id) === open) return prev;
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  const chartLabelZ = (id: string) => (openChartLabels.has(id) ? 25 : 20);
  useLayoutEffect(() => {
    const labels = stackLabelsRef.current;
    const lines = stackLinesRef.current;
    if (labels == null || lines == null) {
      setLandingLinkH((prev) => (prev == null ? prev : null));
      return;
    }
    let cancelled = false;
    const measure = () => {
      if (cancelled) return;
      const h =
        lines.getBoundingClientRect().top -
        labels.getBoundingClientRect().bottom;
      const next = h > 0.5 ? h : null;
      setLandingLinkH((prev) => (prev === next ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(labels);
    observer.observe(lines);
    if (stackChartRef.current != null) {
      observer.observe(stackChartRef.current);
    }
    window.addEventListener("resize", measure);
    void document.fonts.ready.then(() => {
      measure();
    });
    return () => {
      cancelled = true;
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  });
  // Keep this view's cached copy in step with every save, so
  // leaving and returning within the session re-hydrates the
  // latest form, never a stale one.
  const cachePgForm = (pg: PgSavedForm, revision: number) => {
    pgQueryClient.setQueryData<ApiResponse<typeof api, "getRothUiState">>(
      ["playgroundui"],
      (old) => (old ? { ...old, playground: pg, revision } : old),
    );
  };
  const retq = useQuery({
    queryKey: ["retirementcalc"],
    queryFn: () => api.getRetirementCalc({}),
  });
  const pgPrefillSource = useMemo(
    () => pgPrefillSourceFrom(rq.data, retq.data),
    [rq.data, retq.data],
  );
  /* The return year behind the stored 1040 figures (contract
     v147): the stored year when the record names one, else the
     last filed year — a return for the current year cannot have
     been filed yet — so a record written before the year field
     existed still resolves to the return the figures came from.
     The "as filed" preset uses this one value for its name and
     for the tax year it loads into; the prefill uses it to tell
     the return year itself apart from any other year. */
  const pgTaxReturnYear =
    pgPrefillSource?.taxReturnYear ?? (new Date().getFullYear() - 1);
  /* The phrase the three income dials use for the return's
     provenance: the year when the record names it ("your 2025
     return"), else "your most recent return" with no year
     asserted — the amounts are the most recent return's by
     construction, but the year itself was never recorded. */
  const pgReturnYearPhrase =
    pgPrefillSource?.taxReturnYear != null
      ? `your ${pgPrefillSource.taxReturnYear} return`
      : "your most recent return";
  /* Rejected negative return actuals (contract v146,
     re-audit round 3 NICE-1): the stored Form 1040 lines the
     server's parse set aside as negative — a return income
     line cannot be negative, so each reads as not entered
     and its dial resolves by the ordinary provenance rules
     (the plan's priced estimate where the plan prices the
     year). The planner response reports them so the
     rejection is visible here, beside the prefill controls
     whose figures it changes, instead of the line silently
     reading blank. Empty for every ordinary record. */
  const pgRejectedReturnActuals =
    rq.data?.taxReturn.rejectedNegativeActuals ?? [];
  const pgRejectedReturnText = pgRejectedReturnActuals
    .map((r) => {
      const label =
        r.line === "interest"
          ? "taxable interest (line 2b)"
          : r.line === "qualifiedDividends"
            ? "qualified dividends (line 3a)"
            : "ordinary dividends (line 3b)";
      return `${label} was ${fmtDollars(r.cents / 100)}`;
    })
    .join("; ");
  /* Annual spending for the "enough for the year" comparison
     (build v126): the Tax Plan record's annual spending,
     falling back to the Retirement calculator's default —
     the same resolution the prefill source uses above. Null
     when neither answers, or when the resolved figure is $0
     (no spending to compare against); the comparison row
     hides then. In cents, like the record. */
  const pgAnnualSpendingCents = useMemo(() => {
    const resolved =
      rq.data?.saved?.annualSpendingCents ??
      retq.data?.defaultSpendingAnnualCents ??
      null;
    return resolved != null && resolved > 0 ? resolved : null;
  }, [rq.data, retq.data]);
  /* Spending dial (build v145) — ONE SOURCE, multiple edit
     locations: the annual spending lives in the Tax Plan
     record, and this field edits it in place here, writing
     through to it via saveRothInputs — the record's own
     writer, with its CAS revision — exactly as the Tax Plan
     and Retirement spending fields do. It is NOT a local
     Playground-only what-if dial: an edit here changes the
     saved plan's spending. The field carries the same per year
     / per month toggle as the Tax Plan's "Yearly spending"
     field (v141): per year shows and edits the stored annual
     dollars directly; per month shows annual ÷ 12 and turns a
     typed monthly amount into annual at exactly monthly × 12,
     with a reference line under the field showing the annual
     equivalent. The unit itself is a remembered display
     preference in the generic server-side fold store (the
     "playground.dialPerMonth" flag — a different flag from the
     "playground.spendPerMonth" one the spend readouts' Month /
     Year pills use): a stored entry means the user last left it
     on per month; no entry is the per-year default, so the field
     opens per year for a user who has never toggled it, and the
     last pick comes back after a reload. Display only — it
     changes no stored figure. The per-month draft keeps what
     was typed while the field is focused in per-month mode, so a
     half-typed monthly figure is never rewritten mid-edit.
     The comparison (buildPgInputs' annualSpending) reads the
     local field when it parses to a positive figure, so the
     "Left after a year's spending" row updates live as the
     figure is typed, and falls back to the record's figure
     while the field is blank or unparseable, so the row never
     vanishes mid-edit. The spending never prices into the tax
     — the engine compares it against the cash left after
     health premiums only (R3-M3; the cash left after tax
     when no premium prices) — and the Projection face keeps
     its no-spending convention: this dial lives in the
     Single-year dials group, which the Projection face
     never renders. */
  const [pgSpending, setPgSpending] = useState("");
  const [pgDialPerMonth, setPgDialPerMonth] =
    usePersistedFold("playground.dialPerMonth");
  const pgSpendingUnit: "year" | "month" = pgDialPerMonth ? "month" : "year";
  const setPgSpendingUnit = (unit: "year" | "month") =>
    setPgDialPerMonth(unit === "month");
  const [pgSpendingMonthlyDraft, setPgSpendingMonthlyDraft] = useState<string | null>(null);
  const [pgSpendingMsg, setPgSpendingMsg] = useState<string | null>(null);
  const pgSpendingFocusedRef = useRef(false);
  /* Filed return figures: the "Your filed return — for the
     estimate" editor section was removed at the user's
     request — it only showed last year's actuals and asked
     for last year's return, while the income dials themselves
     are where the current year's estimate is entered. The
     stored figures on the Tax Plan record are KEPT untouched
     (they still back the return-year view and the "as filed"
     preset internally), but there is no longer an editor for
     them in this view. The write-through below therefore
     preserves the tax-return block exactly as stored. */
  // Sourced from the Tax Plan record (falling back to the
  // Retirement calculator's default, the same resolution as
  // pgAnnualSpendingCents above): the field shows the stored
  // figure, and re-shows it whenever the record changes —
  // after this view's own save, or an edit in the Tax Plan or
  // Retirement. Never while the field is focused, so a
  // half-typed value is never clobbered by a refetch.
  const pgSpendingSourceCents =
    rq.data?.saved?.annualSpendingCents ??
    retq.data?.defaultSpendingAnnualCents ??
    null;
  useEffect(() => {
    if (pgSpendingSourceCents == null) return;
    if (pgSpendingFocusedRef.current) return;
    const next = fmtMoneyInput(pgSpendingSourceCents / 100);
    setPgSpending((prev) => (prev === next ? prev : next));
  }, [pgSpendingSourceCents]);
  // The spending the comparison prices (build v145): the
  // local field when it parses to a positive figure, else the
  // record's figure — so the row updates live while typing
  // and never vanishes on a blank or unparseable draft.
  const pgSpendingCents = useMemo(() => {
    const local = parseMoney(pgSpending);
    if (local != null && local > 0) return local;
    return pgAnnualSpendingCents;
  }, [pgSpending, pgAnnualSpendingCents]);
  /* Pasted annual spending (P-S2, parity audit): the paste
     payload carries the priced year's annual spending, and
     a successful paste-load holds it here as the loaded
     year's spending — the "enough for the year" comparison
     prices it AHEAD of the Spending dial and the record, so
     a replayed year is judged against the spending it was
     priced with, not the live record's. The hold is a
     loader-held figure, never a write-through: a paste
     sets dials only and never writes the saved plan record
     (the loaders' contract), so the record's own spending
     is untouched and the dial above keeps showing it.
     undefined = no paste figure held (the dial / record
     resolution rules, exactly as before); null = the
     pasted year was priced with NO spending (no comparison
     for the loaded year); a number = the pasted year's
     spending, in dollars. The hold clears when the user
     edits the Spending dial (their figure takes over,
     writing through as usual), when another loader loads a
     different year, on reset, and on a paste written before
     the payload carried spending (it parses with the
     figure unset — no spending carried, exactly as
     before). Since P-S5 the projection-year loader
     holds through this same slot: it sets the projected
     year's own annual spending (or clears the hold when
     the year's inputs carry none), so a loaded bar is
     judged against the spending its bar priced with.
     It is session state only: like the
     paste-loaded flag it is not part of the remembered
     form, so a reload resolves the comparison from the
     record again. */
  const [pgPastedSpending, setPgPastedSpending] = useState<
    number | null | undefined
  >(undefined);
  /* The gain-harvest facts a paste-load holds (P-S3):
     the paste payload carries the two harvest facts
     (harvestPoolAmount / harvestPoolBasisPct) — the
     December console's facts, for which the Playground
     form has no dial — so the loader holds the pasted
     pair here and buildPgInputs supplies it to the
     pricer for the loaded year, exactly as the pasted
     spending above is held. undefined = no paste facts
     held (no harvest priced, exactly as before); an
     object = the pasted year's pair, either member of
     which may be null (the pricer sizes a harvest only
     when BOTH are present, so a one-fact or null hold
     prices no harvest). The hold clears at the same
     points the pasted-spending hold clears — every
     other loader, and reset — and a paste written
     before the payload carried the facts parses with
     both unset, which holds two nulls: no harvest
     priced, exactly as before, and any earlier hold
     cleared. Since P-S5 the projection-year loader
     also holds through this same slot: it sets the
     projected year's own pair (or clears the hold when
     the year's inputs carry neither fact). It is
     session state only, like the paste-loaded flag:
     not part of the remembered form, so a reload
     prices no harvest again. */
  const [pgPastedHarvest, setPgPastedHarvest] = useState<
    { poolAmount: number | null; basisPct: number | null } | undefined
  >(undefined);
  // The spending the comparison prices, in dollars: the
  // held paste figure while one is held, else the dial /
  // record resolution (pgSpendingCents). buildPgInputs and
  // the At a glance card both read this one value, so the
  // card and the Tax-for-the-year card can never show two
  // different verdicts for a pasted year either (the S-7
  // invariant, extended to the paste hold).
  const pgResolvedSpendingDollars =
    pgPastedSpending !== undefined
      ? pgPastedSpending
      : pgSpendingCents != null
        ? pgSpendingCents / 100
        : null;
  // Monthly display when the field is not focused in
  // per-month mode: the annual figure divided by twelve,
  // rounded to the cent and grouped like the money fields.
  const pgMonthlySpendingDisplay = (): string => {
    const cents = parseMoney(pgSpending);
    if (cents == null) return pgSpending;
    return fmtMoneyInput(Math.round(cents / 12) / 100);
  };
  /* Tax Plan write-through (build v145, mirroring the
     Retirement view's v140 write-through):
     the payload is the fetched record itself, flattened (its
     inputs, execution, market-check, gift, and tax-return
     blocks, minus the execution block's read-only
     rolledOver/clearedYear), with only annualSpendingCents
     replaced by the field's current value. The tax-return
     block is carried through exactly as stored — the filed
     return editor was removed, so this save never changes
     those figures. A blank or
     unparseable field keeps the record's current value instead
     of overwriting it with null, so a half-typed edit can
     never blank a stored value, and an unchanged value saves
     nothing. The save is queued on change and fires at once
     when the field is not focused, and on blur when it is
     (the settled-value gate, build v131) — never while a
     half-typed value is in the field. Saves are serialized,
     and a conflict re-reads the record and explicitly resets
     the field from the refusal's record (build v158,
     audit S-5 — the sourced effect alone cannot be relied
     on to re-show the stored value) and says so plainly.
     When there is no saved Tax Plan record yet, there is
     nothing to write through to and the edit stays in this
     view only.
     Build v152 (audit MUST M-3): the queue holds ONLY the
     local spending delta — the target annualSpendingCents —
     never a whole-record payload, and the payload is rebuilt
     at fire time from the freshest fetched record with only
     that one field replaced. The mutation's baseRevision is
     read from the same refetch the payload is rebuilt from,
     so the two can never disagree: if another tab saved while
     this edit sat queued (say the field was still focused),
     the save carries that tab's newer values for every other
     field instead of silently reverting them under a fresh
     CAS base — the defect v145–v151 had, where the payload
     was snapshotted at queue time but the base was read live
     at send time. Save timing is unchanged: queue on change,
     fire at once when unfocused, on blur when focused, and
     the v151 failed-save retry re-fires the same queue entry,
     rebuilding fresh again when it lands.
     Build v169 (re-audit SHOULD S-4): the write-through
     also flushes on unmount — before v169 it had NO unmount
     flush at all, unlike the Tax Plan autosave and the
     Retirement writers, so an edit still queued (or held by
     the settled-value gate) when the view went away was
     lost silently and the record kept the old value. The
     flush follows the S-3 pattern the other writers landed
     in v168: with nothing in flight the queued edit sends
     at once through the ONE flush send (sendPgRothFlush,
     which runs the M-4 coherence guard below); with a save
     in flight the cleanup stores the send in a deferred
     slot instead of firing it concurrently under the same
     not-yet-advanced CAS base, and the in-flight call's own
     per-call handlers consume the slot as that save
     settles — firing it under the newly adopted base when
     the save lands, firing it as a supersede when the save
     errors, and dropping it when the save conflicts (the
     conflict path's deliberate-drop semantics — the
     deferred edit belongs to the same stale form). The
     flush send runs the M-4 coherence guard (the Retirement
     write-through's v162 rule): when the fetched record
     this view holds is older than the base the mutation
     would send under, the record is fetched fresh, the
     payload is rebuilt from THAT record, and its revision
     is adopted as the base before sending; if the fresh
     fetch fails, or still returns a record older than the
     base, the edit is dropped rather than sent stale. */
  const pgRothRevisionRef = useRef(0);
  // The revision of the freshest FETCHED record — the one a
  // rebuilt payload is spread from. pgRothRevisionRef can
  // run one save ahead of it (a save result adopts its
  // returned revision immediately; the refetch it triggers
  // lands a moment later), and the unmount flush's coherence
  // guard compares the two, so a flush payload is only ever
  // sent under a base that describes the same record it was
  // built from.
  const pgRothFetchedRevisionRef = useRef(0);
  useEffect(() => {
    if (rq.data) {
      pgRothRevisionRef.current = rq.data.revision;
      pgRothFetchedRevisionRef.current = rq.data.revision;
    }
  }, [rq.data]);
  const pgRothSaveTimer = useRef<number | null>(null);
  // The queued write-through edit: ONLY the spending value
  // this view means to write (build v152, audit M-3). The
  // whole-record payload is derived from it at fire time, so
  // nothing stale can ride along — see the block comment
  // above and buildPgRothSavePayload below.
  const pendingPgRothSave = useRef<PgRothDelta | null>(null);
  const pgRothSaveInFlightRef = useRef(false);
  // Build v177 (re-audit NICE-TO-HAVE N-3): consecutive
  // hold polls by the fire path below while it waits for
  // the in-flight save to settle, bounded by
  // SAVE_HOLD_MAX_POLLS — see the hold branch there.
  const pgRothHoldPollsRef = useRef(0);
  // Build v151 (audit M-5): the edit currently in
  // flight, so the unmount flush can tell "queued behind the
  // in-flight save" (a newer edit — flush it) from "the
  // in-flight save itself" (already being written — firing
  // it again would just duplicate the call).
  const pgRothSaveInFlightDeltaRef = useRef<PgRothDelta | null>(null);
  // Build v169 (re-audit SHOULD S-4): a flush deferred
  // behind the in-flight save, and the flush send itself,
  // held in refs so the unmount cleanup (defined below,
  // after the queue effect) can reach them. The cleanup,
  // finding an edit queued behind a save still in flight,
  // stores its send in deferredPgRothFlushRef instead of
  // firing it concurrently under the same not-yet-advanced
  // CAS base — the server accepts exactly one of two
  // same-base saves, and a refused flush is lost silently
  // on an unmounted view. The in-flight call's per-call
  // handlers in the fire path consume the slot as that save
  // settles: fire on a landed save or on an error, drop on
  // a conflict (the conflict path's deliberate drop of the
  // stale form's queued edits). sendPgRothFlushRef carries
  // the ONE flush send (the M-4 coherence guard included),
  // defined below beside buildPgRothSavePayload, so the
  // immediate flush and the deferred flush are the same
  // code, guard included.
  // Build v189 (re-audit round 3 MUST-5): that send's two
  // payload sends are no longer bare mutate calls — both go
  // through the ONE retrying payload send
  // (sendPgRothFlushPayload, beside sendPgRothFlush), so a
  // flush whose own request fails re-arms a retry of itself
  // instead of being dropped (see that send's comment).
  const deferredPgRothFlushRef = useRef<(() => void) | null>(null);
  const sendPgRothFlushRef = useRef<(pendingFlush: PgRothDelta) => void>(
    () => {},
  );
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
  // it stores the deferred send
  // (armDeferredPgRothFlushGiveUp below): if the in-flight
  // save has not settled within
  // DEFERRED_FLUSH_GIVE_UP_MS, the timer consumes the slot
  // itself and fires the deferred send anyway, through the
  // same retrying flush send (sendPgRothFlush) a settle
  // would have fired — so the edit is sent, its failure
  // re-arms the flush's own 3 s retry (build v189), and a
  // CAS conflict from sending while the wedged save is
  // still in flight resolves through the mutation's
  // normal conflict path instead of stranding the edit.
  // A settle that lands first consumes the slot through
  // takeDeferredPgRothFlush, which clears this timer, so a
  // normally-settling save fires the deferred send exactly
  // as before and the timer never fires at all. The timer
  // lives in its own ref, cleared by nothing after
  // unmount, so it outlives the view like the flush retry
  // timer.
  const deferredPgRothFlushGiveUpTimerRef = useRef<number | null>(null);
  const clearDeferredPgRothFlushGiveUp = () => {
    if (deferredPgRothFlushGiveUpTimerRef.current != null) {
      window.clearTimeout(deferredPgRothFlushGiveUpTimerRef.current);
      deferredPgRothFlushGiveUpTimerRef.current = null;
    }
  };
  // Consume the deferred slot (and disarm its give-up
  // timer): the ONE way the slot is read, so a settle and
  // the give-up can never both fire the same send.
  const takeDeferredPgRothFlush = (): (() => void) | null => {
    clearDeferredPgRothFlushGiveUp();
    const deferred = deferredPgRothFlushRef.current;
    deferredPgRothFlushRef.current = null;
    return deferred;
  };
  const armDeferredPgRothFlushGiveUp = () => {
    clearDeferredPgRothFlushGiveUp();
    deferredPgRothFlushGiveUpTimerRef.current = window.setTimeout(() => {
      deferredPgRothFlushGiveUpTimerRef.current = null;
      const deferred = deferredPgRothFlushRef.current;
      deferredPgRothFlushRef.current = null;
      if (deferred) deferred();
    }, DEFERRED_FLUSH_GIVE_UP_MS);
  };
  const pgRothSave = useMutation({
    mutationFn: (input: RothSavePayload) =>
      api.saveRothInputs({ ...input, baseRevision: pgRothRevisionRef.current }),
    onError: () => {
      // Build v151 (audit M-5): a failed write-through
      // says so instead of vanishing silently. The edit
      // stays queued (the fire path below clears it only on
      // success) and its per-call onError re-arms a retry, so
      // the edit lands once the server is reachable again.
      setPgSpendingMsg(
        "Could not save — your entries stay on this screen.",
      );
    },
    onSuccess: (res) => {
      if (res.ok) {
        // A save landed: any "Could not save" note from an
        // earlier failed attempt is stale now.
        setPgSpendingMsg(null);
        pgRothRevisionRef.current = res.revision;
        // The Tax Plan view reads the same query key, so it
        // picks the new values up on its next render — and
        // this view's own rq refetches the saved figure.
        pgQueryClient.invalidateQueries({ queryKey: ["rothplanner"] });
        return;
      }
      // Conflict: a newer Tax Plan save landed first. Seed
      // the cache with the record the refusal carries and
      // RESET the field from it explicitly — re-show the
      // stored spending — and say plainly what happened.
      // Build v158 (audit SHOULD S-5): the reset must not
      // rely on the sourced effect above. That effect bails
      // while the field is focused and re-runs only when the
      // stored spending itself changes, so when the other
      // save changed a different field (or landed while this
      // field held focus) it never re-synced, and the
      // rejected edit stayed on screen under a message
      // claiming the latest saved version was shown. This
      // mirrors the Tax Plan's conflict path
      // (rehydrateFromRecord): the refusal's own record is
      // the stored truth, applied directly, focus or not.
      pgRothRevisionRef.current = res.revision;
      // Drop any queued write-through of the stale form —
      // the conflicted edit itself (the per-call handler in
      // the fire path would drop it too) and anything queued
      // behind it — so nothing from before this reset can
      // fire later and save a value the field no longer
      // shows. The Tax Plan's conflict path drops its queued
      // autosave the same way.
      if (pgRothSaveTimer.current != null) {
        window.clearTimeout(pgRothSaveTimer.current);
        pgRothSaveTimer.current = null;
      }
      pendingPgRothSave.current = null;
      pgQueryClient.setQueryData(["rothplanner"], res.record);
      const storedSpendingCents =
        res.record.saved?.annualSpendingCents ?? null;
      if (storedSpendingCents != null) {
        setPgSpending(fmtMoneyInput(storedSpendingCents / 100));
        // A per-month draft of the rejected edit must not
        // survive either: the month display derives from
        // the reset annual value once the draft is gone.
        setPgSpendingMonthlyDraft(null);
      }
      pgQueryClient.invalidateQueries({ queryKey: ["rothplanner"] });
      // Re-audit NICE-TO-HAVE N-2: this message was guarded by
      // a pending-save flag that every save capable of
      // conflicting had already set (queuePgRothSave sets it
      // for the only field this write-through carries, and
      // nothing ever cleared it), so the guard could never
      // discriminate — the message is set unconditionally,
      // exactly as it effectively behaved.
      setPgSpendingMsg(
        "This plan was changed in the Tax Plan (or another tab), so the spending edit just made here was not kept. The latest saved version is shown now.",
      );
    },
  });
  const pgRothSaveMutateRef = useRef(pgRothSave.mutate);
  pgRothSaveMutateRef.current = pgRothSave.mutate;
  // Build the whole-record save payload for a target
  // spending value from the CURRENT fetched record
  // (build v152, audit M-3): every field comes from the
  // freshest record this view holds; only annualSpendingCents
  // is the caller's. Returns null when there is no saved
  // record to write through to, or when the fresh record
  // already holds the target value (nothing left to save —
  // e.g. another tab saved the same spending first). The
  // unmount flush's guard-holding path (build v169)
  // passes the record it fetched fresh at flush time
  // instead, so that payload is built from that record, not
  // from the possibly stale fetched record the view last
  // rendered.
  const buildPgRothSavePayload = (
    targetCents: number,
    record?: RothPlannerRecord,
  ): RothSavePayload | null => {
    const rp = record ?? rq.data;
    if (!rp || !rp.saved) return null;
    if (targetCents === rp.saved.annualSpendingCents) return null;
    const { rolledOver: _rolledOver, clearedYear: _clearedYear, ...execution } = rp.execution;
    return {
      ...rp.saved,
      ...execution,
      ...rp.mcCheck,
      ...rp.gift,
      ...rp.taxReturn,
      annualSpendingCents: targetCents,
    };
  };
  const buildPgRothSavePayloadRef = useRef(buildPgRothSavePayload);
  buildPgRothSavePayloadRef.current = buildPgRothSavePayload;
  // The ONE unmount-flush send for a queued write-through
  // edit (build v169, re-audit SHOULD S-4): the immediate
  // flush and the S-3-style deferred flush run identical
  // code. The M-4 coherence guard (the Retirement
  // write-through's build v162 rule) rides along:
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
  // edit.
  //
  // Build v189 (re-audit round 3 MUST-5): the ONE payload
  // send inside the flush, carrying the same retry
  // firePendingPgRothSave's sends carry. Before v189 both of
  // sendPgRothFlush's sends were bare
  // pgRothSaveMutateRef.current(flushPayload) calls with NO
  // per-call handlers — so a flush whose request failed (a
  // network error at the moment of navigation) was dropped
  // outright: the mutation-level onError above set the
  // "Could not save" note on an unmounted view, where
  // nobody could see it, the cleanup had already cleared
  // the delta from the queue, and nothing ever retried, so
  // the edit silently never landed — returning to the view
  // showed the old stored value with no explanation. This
  // send is the flush's firePendingPgRothSave: its per-call
  // onError re-arms a 3 s retry of the SAME payload,
  // chained per failure exactly as firePendingPgRothSave's
  // onError re-arms its own retry, so the flush lands once
  // the server is reachable again. The retry timer lives
  // in its own ref, not the shared pgRoth save timer: the
  // cleanup clears that timer as it runs, and nothing runs
  // after unmount to clear this one, so the retries
  // outlive the view. Each attempt goes through this same
  // send (the retry calls back through the ref, so it
  // always reaches the current closure), and the mutation
  // reads its CAS base live from pgRothRevisionRef at each
  // call — which still describes the record the payload
  // was built from: on the guard-not-holding path the
  // fetched and base revisions were equal at the build,
  // and on the fresh-fetch path sendPgRothFlush adopts the
  // fresh record's revision as the base before sending,
  // so a retry rides exactly the base its first send did.
  // A conflict is NOT retried: it resolves through
  // onSuccess with res.ok false, where the mutation-level
  // handler has already applied the conflict path's
  // deliberate drop, and re-sending the stale-built
  // payload would fight the newer record the refusal just
  // re-showed — the same rule firePendingPgRothSave's
  // per-call handlers follow. The pre-send drop paths in
  // sendPgRothFlush (no fresh-enough record on the
  // fresh-fetch path, or a payload the fresh record
  // already satisfies) are unchanged: those are the M-4
  // guard's deliberate outcomes, reached before any send
  // exists to retry.
  const pgRothFlushRetryTimerRef = useRef<number | null>(null);
  const sendPgRothFlushPayload = (flushPayload: RothSavePayload) => {
    pgRothSaveMutateRef.current(flushPayload, {
      onError: () => {
        if (pgRothFlushRetryTimerRef.current != null) {
          window.clearTimeout(pgRothFlushRetryTimerRef.current);
        }
        pgRothFlushRetryTimerRef.current = window.setTimeout(() => {
          sendPgRothFlushPayloadRef.current(flushPayload);
        }, 3000);
      },
    });
  };
  const sendPgRothFlushPayloadRef = useRef(sendPgRothFlushPayload);
  sendPgRothFlushPayloadRef.current = sendPgRothFlushPayload;
  const sendPgRothFlush = (pendingFlush: PgRothDelta) => {
    if (pgRothFetchedRevisionRef.current === pgRothRevisionRef.current) {
      const flushPayload = buildPgRothSavePayloadRef.current(
        pendingFlush.annualSpendingCents,
      );
      if (flushPayload) {
        sendPgRothFlushPayload(flushPayload);
      }
    } else {
      const baseAtFlush = pgRothRevisionRef.current;
      void (async () => {
        let fresh: RothPlannerRecord;
        try {
          fresh = await pgQueryClient.fetchQuery({
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
        const flushPayload = buildPgRothSavePayloadRef.current(
          pendingFlush.annualSpendingCents,
          fresh,
        );
        if (!flushPayload) {
          // The fresh record already holds the target
          // value — the edit's goal is met, and every
          // other field is the fresh record's to keep.
          return;
        }
        // Adopt the fresh record's revision as the base
        // BEFORE the send: the mutation reads its CAS
        // base live from this ref at the call, so payload
        // and base now describe the same record.
        pgRothRevisionRef.current = fresh.revision;
        pgRothFetchedRevisionRef.current = fresh.revision;
        sendPgRothFlushPayload(flushPayload);
      })();
    }
  };
  sendPgRothFlushRef.current = sendPgRothFlush;
  const firePendingPgRothSave = () => {
    const pending = pendingPgRothSave.current;
    if (!pending) return;
    if (pgSpendingFocusedRef.current) {
      // Settled-value gate: the write-through field is still
      // being edited, so the queued edit may still change.
      // Hold it — the blur flush sends it once focus leaves
      // the field.
      return;
    }
    if (pgRothSaveInFlightRef.current) {
      // Build v177 (re-audit NICE-TO-HAVE N-3): this hold
      // is BOUNDED. Before v177 it re-armed the 300 ms
      // re-check without limit: a save whose call never
      // settles (a hung request — the mutation's promise
      // neither resolves nor rejects, so onSettled never
      // runs and the in-flight flag never clears) held the
      // queued edit behind it forever, polling for the life
      // of the view. After SAVE_HOLD_MAX_POLLS consecutive
      // polls (100 × 300 ms = 30 s, far beyond any save this
      // app makes) the hold gives up explicitly: polling
      // stops, the edit STAYS queued (a later edit, the blur
      // flush, or the unmount flush fires it, and if the
      // wedged save ever does settle its own per-call
      // handlers still consume the deferred slot exactly as
      // before), and the failure is surfaced with the same
      // line a failed save uses. Nothing is sent
      // concurrently — the S-4 deferral is untouched while
      // the in-flight save settles normally.
      pgRothHoldPollsRef.current += 1;
      if (pgRothHoldPollsRef.current > SAVE_HOLD_MAX_POLLS) {
        pgRothHoldPollsRef.current = 0;
        if (pgRothSaveTimer.current != null) {
          window.clearTimeout(pgRothSaveTimer.current);
          pgRothSaveTimer.current = null;
        }
        setPgSpendingMsg(
          "Could not save — your entries stay on this screen.",
        );
        return;
      }
      if (pgRothSaveTimer.current != null) window.clearTimeout(pgRothSaveTimer.current);
      pgRothSaveTimer.current = window.setTimeout(firePendingPgRothSave, 300);
      return;
    }
    // Build v152 (audit M-3): rebuild the payload NOW,
    // from the freshest record, applying only the queued
    // spending delta. The record may have advanced past the
    // revision the edit was queued against (another tab's
    // save, picked up by the bridge refetch while this field
    // was focused) — rebuilding here carries that save's
    // values for every other field, and the mutation reads
    // its CAS base from the same refetch, so payload and
    // base always describe the same record. A payload
    // snapshotted at queue time must never be sent under a
    // base read later: the server CAS would accept it and
    // silently revert the other tab's edits.
    const payload = buildPgRothSavePayloadRef.current(pending.annualSpendingCents);
    if (!payload) {
      // Nothing to send: no saved record to write through
      // to, or the fresh record already holds this spending
      // (another tab saved the same value first — the edit's
      // goal is met, and every other field is theirs to
      // keep). The owed save is complete either way.
      pendingPgRothSave.current = null;
      pgRothHoldPollsRef.current = 0;
      return;
    }
    // Build v151 (audit M-5): the edit stays queued until
    // the save SUCCEEDS — it is not dropped at the call, so
    // a failed save (offline, gateway 500) cannot vanish
    // silently. The per-call handlers below own the queue:
    // success drops the edit, error re-arms a retry of it.
    pgRothHoldPollsRef.current = 0;
    pgRothSaveInFlightRef.current = true;
    pgRothSaveInFlightDeltaRef.current = pending;
    pgRothSaveMutateRef.current(payload, {
      onSuccess: (res) => {
        // The save landed (or a conflict re-read the record
        // and re-showed the stored values — the deliberate
        // drop): clear the queue only if it still holds this
        // edit, never a newer one queued behind it.
        if (pendingPgRothSave.current === pending) {
          pendingPgRothSave.current = null;
        }
        // Build v169 (re-audit SHOULD S-4): consume a
        // flush the unmount cleanup deferred behind this
        // save — fire it on a landed save (the mutation-level
        // handler has adopted the new revision; the deferred
        // send runs the M-4 guard, which now routes it
        // through the fresh-fetch path, so its payload is
        // rebuilt from the record this save just landed),
        // drop it on a conflict (the conflict path re-read
        // the record and re-showed the stored values; the
        // deferred edit is the same stale form's and must not
        // ride out under the adopted base).
        // Build v196: consumed through takeDeferredPgRothFlush,
        // which also disarms the slot's give-up timer — a
        // save that settles normally leaves no timer behind.
        const deferred = takeDeferredPgRothFlush();
        if (res.ok && deferred) deferred();
      },
      onError: () => {
        // Keep the edit queued and re-arm a retry on the
        // shared timer, so the save lands once the server is
        // reachable again — rebuilt fresh at that fire, like
        // every send. If the field is focused again by then,
        // the settled-value gate holds the retry and the
        // blur flush sends it, exactly as for a first
        // attempt. The mutation-level onError sets the
        // visible message.
        if (pendingPgRothSave.current === pending) {
          if (pgRothSaveTimer.current != null) {
            window.clearTimeout(pgRothSaveTimer.current);
          }
          pgRothSaveTimer.current = window.setTimeout(firePendingPgRothSave, 3000);
        }
        // Build v169 (re-audit SHOULD S-4): this save
        // never landed, so the base is unchanged and a flush
        // deferred behind it at unmount fires now — its
        // payload rebuilds from the same fetched record this
        // save's payload was built from, applying only the
        // deferred edit. No retry of this save was armed
        // above: the queue no longer holds it, the cleanup
        // moved it to the deferred slot.
        // Build v196: consumed through takeDeferredPgRothFlush,
        // which also disarms the slot's give-up timer.
        const deferred = takeDeferredPgRothFlush();
        if (deferred) deferred();
      },
      onSettled: () => {
        pgRothSaveInFlightRef.current = false;
        pgRothSaveInFlightDeltaRef.current = null;
      },
    });
  };
  const firePendingPgRothSaveRef = useRef(firePendingPgRothSave);
  firePendingPgRothSaveRef.current = firePendingPgRothSave;
  const queuePgRothSave = () => {
    // Queue ONLY the local spending delta (build v152,
    // audit M-3) — never a whole-record payload. The payload
    // is rebuilt from the fresh record when the save fires,
    // so a refetch landing between queue and fire can never
    // leave stale field values queued under a fresh base.
    const rp = rq.data;
    if (!rp || !rp.saved) return;
    const cents = parseMoney(pgSpending);
    // No delta is owed when the field is blank /
    // unparseable or back at the stored value — the edit
    // was cleared or reverted, so nothing should save.
    // Drop any earlier queued edit instead of leaving it
    // in place: the queued value must not outlive the
    // field's current value, or blur would fire the
    // superseded value and silently overwrite the revert
    // (build v161, audit M-NEW-1 — the Retirement
    // queue's rule, build v153).
    if (cents == null || cents === rp.saved.annualSpendingCents) {
      pendingPgRothSave.current = null;
      return;
    }
    pendingPgRothSave.current = { annualSpendingCents: cents };
    firePendingPgRothSaveRef.current();
  };
  const queuePgRothSaveRef = useRef(queuePgRothSave);
  queuePgRothSaveRef.current = queuePgRothSave;
  // Queue the write-through whenever a write-through field
  // changes; the fire sends it at once when no write-through
  // field is focused, and the blur flush sends it once focus
  // leaves.
  useEffect(() => {
    queuePgRothSaveRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pgSpending]);
  // Flush a queued write-through edit when leaving the
  // screen, so an edit made in the last fraction of a second
  // is not lost (build v169, re-audit SHOULD S-4 — before
  // v169 this write-through had no unmount flush at all).
  // It fires focused or not: leaving the view IS the settle,
  // the Tax Plan's own v149 rule (the Retirement
  // write-through adopted it in v159). Flushing the QUEUED
  // edit is safe for a half-typed field: the queue only ever
  // holds a parsed value that differs from the record's (a
  // blank or unparseable field queues nothing), so there is
  // no half-typed value in it to persist. The flush sends
  // directly, not through the fire path: the fire path's
  // settled-value gate would hold it for the very focus this
  // flush must ignore, and its re-check timers cannot run
  // once the view is gone.
  useEffect(() => {
    return () => {
      if (pgRothSaveTimer.current != null) {
        window.clearTimeout(pgRothSaveTimer.current);
        pgRothSaveTimer.current = null;
      }
      // Build v151: the pending edit may BE the save
      // currently in flight (the queue clears on success,
      // not at the call) — that one is already being written,
      // so only flush an edit queued behind it.
      //
      // Build v169 (re-audit SHOULD S-4): a queued-behind
      // edit is NOT fired while the write-through's own save
      // is still in flight — fired concurrently it would read
      // the same not-yet-advanced CAS base, the server would
      // accept exactly one of the two, and a refused flush
      // would be lost silently (its conflict handling runs on
      // this unmounted view) — the S-3 defect v168 fixed in
      // the other three writers. It is deferred instead: the
      // in-flight call's per-call handlers fire
      // sendPgRothFlush the moment that save settles (on a
      // landed save the M-4 guard routes the deferred send
      // through the fresh-fetch path, so its payload is
      // rebuilt from the record that save just landed; on an
      // error the base is unchanged and the send proceeds
      // exactly as an immediate flush would; on a conflict
      // the slot is dropped, the conflict path's deliberate
      // drop of the stale form's queued edits). With nothing
      // in flight the flush sends at once through the same
      // ONE send, guard included.
      //
      // Build v189 (re-audit round 3 MUST-5): BOTH forms of
      // the flush — the immediate send and the deferred send
      // stored in deferredPgRothFlushRef — now reach the
      // server through the ONE retrying payload send inside
      // sendPgRothFlush (sendPgRothFlushPayload), not a bare
      // mutate call. The queue is still cleared just below
      // before the send, exactly as before, but the edit no
      // longer depends on the queue for its survival: once
      // sendPgRothFlush builds the payload, the retrying send
      // carries it in its closure and re-arms a 3 s retry of
      // it on error, so a flush that fails at the moment of
      // navigation is retried until it lands instead of
      // being lost silently (see that send's comment).
      if (
        pendingPgRothSave.current &&
        pendingPgRothSave.current !== pgRothSaveInFlightDeltaRef.current
      ) {
        const pendingFlush = pendingPgRothSave.current;
        pendingPgRothSave.current = null;
        if (pgRothSaveInFlightRef.current) {
          deferredPgRothFlushRef.current = () =>
            sendPgRothFlushRef.current(pendingFlush);
          // Build v196 (re-audit round 3 SHOULD-7): storing
          // the deferred send also ARMS its give-up timer —
          // if the in-flight save never settles, the timer
          // fires the deferred send through the same
          // retrying flush send after
          // DEFERRED_FLUSH_GIVE_UP_MS instead of leaving it
          // stranded in the slot forever (see the timer's
          // comment beside deferredPgRothFlushRef).
          armDeferredPgRothFlushGiveUp();
        } else {
          sendPgRothFlushRef.current(pendingFlush);
        }
      }
    };
  }, []);
  const pgPrefillBlockerName = useMemo(
    () => pgPrefillBlocker(rq.data, retq.data),
    [rq.data, retq.data],
  );

  /* Playground inputs — the form's own state. The dials persist
     in the app's UI-state store (see the persistence block
     below) so the form remembers them between sessions, but
     nothing here is ever saved to the plan record or enters a
     scenario — except the Spending dial (build v145), which
     edits the Tax Plan record's annual spending in place and
     writes through to it. The playground prices ONE standalone
     year from typed dials through the shared engine
     (pricePlaygroundYear in rothOptimizer.ts) so a user can ask
     "what if I convert $X and sell $Y of stock?" without
     touching the plan. "Start from my numbers" prefills the
     dials from the saved plan; "Reset playground" clears them
     back to blanks/defaults and clears the remembered copy.
     The Medicare checkboxes default to each person's age being
     65+ (a null override = follow the age) until the user
     toggles one. pgSoleBeneficiary is not a visible dial — it
     is carried from the plan by the prefill (default on) and
     only steers the RMD's Joint Life rule.
     pgPrimarySoleBeneficiaryOfSpouse is its reciprocal twin
     (N-1): also not a visible dial — carried from the plan by
     the prefill (and by the saved-plan-year loader, a paste,
     and the remembered form) and steers only the SPOUSE's
     RMD table. Tri-state like the record: null = not
     established, so the spouse's RMD prices on the Uniform
     table — the conservative reading, and the reading every
     form remembered before N-1 reopens with. */
  const currentCalendarYear = new Date().getFullYear();
  const [pgYear, setPgYear] = useState(String(currentCalendarYear));
  const [pgFiling, setPgFiling] = useState<FilingStatus>("mfj");
  const [pgAgeP, setPgAgeP] = useState("");
  const [pgAgeS, setPgAgeS] = useState("");
  const [pgMedP, setPgMedP] = useState<boolean | null>(null);
  const [pgMedS, setPgMedS] = useState<boolean | null>(null);
  const [pgInterest, setPgInterest] = useState("");
  const [pgOrdDiv, setPgOrdDiv] = useState("");
  const [pgOther, setPgOther] = useState("");
  const [pgTaxExempt, setPgTaxExempt] = useState("");
  const [pgSsP, setPgSsP] = useState("");
  const [pgSsS, setPgSsS] = useState("");
  const [pgConversion, setPgConversion] = useState("");
  // Pre-tax draw for spending (R3-M1, engines review
  // round 3): the draw half of the pre-tax money-out
  // split. The conversion dial above is money moved to
  // Roth — ordinary income, never cash in hand. This dial
  // is money taken out TO SPEND — the same ordinary
  // income, but cash in hand, so buildPgInputs passes it
  // as the pricer's spendingDraw and it counts in the
  // year's cash in. Before R3-M1 the form had only the
  // one money-out dial and fed it to the conversion
  // alone, so a draw typed (or loaded from the saved
  // plan) priced as a conversion and the year's cash left
  // fell by the whole draw — the Playground disagreed
  // with the December console, which has always passed
  // its draw as a draw, by exactly that amount.
  const [pgSpendingDraw, setPgSpendingDraw] = useState("");
  const [pgSold, setPgSold] = useState("");
  const [pgBasis, setPgBasis] = useState("");
  const [pgQualDiv, setPgQualDiv] = useState("");
  const [pgPretax, setPgPretax] = useState("");
  /* Pre-tax balance — spouse (prior Dec 31): the spouse's
     share of the pre-tax balance, priced on the spouse's own
     RMD clock (the spouse's age and divisor), not the
     primary's. The saved-plan-year loader fills it from the
     march's priorPretaxSpouse; the Net Worth prefill fills
     it from the spouse's pre-tax start. Blank means no
     spouse balance, so no spouse RMD is priced. */
  const [pgPretaxSpouse, setPgPretaxSpouse] = useState("");
  const [pgAcaSize, setPgAcaSize] = useState("");
  const [pgBenchmark, setPgBenchmark] = useState("");
  // Health premium dials (build v208): the year's entered
  // marketplace premium and Medicare base premium per
  // person — readouts only (net premium, cash left after
  // health premiums); they never enter the year's tax.
  const [pgHealthAca, setPgHealthAca] = useState("");
  const [pgHealthMedicare, setPgHealthMedicare] = useState("");
  // IRMAA surcharge payable THIS year (internal review
  // round 3 SHOULD-2): the surcharge actually payable in
  // the priced year, in dollars for the whole household —
  // the figure on the household's Medicare premium notice,
  // or the plan march's own IRMAA for that year. Charged
  // beside the base premium in the cash left after health
  // premiums — never in the tax bill. Blank = no payable
  // IRMAA charged, exactly as before. This is NOT the
  // forward irmaa readout (the surcharge this year's MAGI
  // will cause in premiumYear): that figure is never
  // charged into this year's cash left.
  const [pgIrmaaPayable, setPgIrmaaPayable] = useState("");
  // ACA reconciliation dials (S-1, engines review round 2):
  // the advance premium credit actually taken during the
  // year and the coverage-month reduction. buildPgInputs
  // passes both (blank = $0) plus the marketplace health
  // premium dial as the enrollment premium, so the year's
  // cash left after tax is the year's FILING SETTLEMENT —
  // the same figure the December view reports for the same
  // year and facts. Before S-1 the Playground passed none
  // of the facts, so its cash left skipped the settlement
  // and disagreed with December by the whole credit.
  const [pgAptcTaken, setPgAptcTaken] = useState("");
  const [pgCoverageReduction, setPgCoverageReduction] = useState("");
  // December-only pricing dials (S-2, engines review
  // round 2): the entering capital-loss carryforward (the
  // short-term and long-term amounts and each one's
  // Washington-attributable portion), the RMD already
  // received, and the dependent MAGI for ACA. The shared
  // pricer has priced all three facts for the December
  // console since their builds (v111 / the December fix /
  // the §36B channel), but buildPgInputs never passed
  // them, so a Playground year that had them priced
  // without them: a banked loss never netted (tax and
  // MAGI overstated by the absorbed amount), a paid RMD
  // counted twice (once in the entered income, once as
  // the pricer's added RMD), and a filing dependent's
  // MAGI missing from the ACA household (a credit shown
  // that the household is not owed). Blank = none / $0,
  // exactly the December console's own readings.
  const [pgCarryInSt, setPgCarryInSt] = useState("");
  const [pgCarryInLt, setPgCarryInLt] = useState("");
  const [pgCarryInStWa, setPgCarryInStWa] = useState("");
  const [pgCarryInLtWa, setPgCarryInLtWa] = useState("");
  const [pgRmdReceived, setPgRmdReceived] = useState("");
  const [pgDependentMagi, setPgDependentMagi] = useState("");
  // Cash and Roth funding dials (S-6, engines review
  // round 2): money taken out of the cash sleeve and out
  // of the Roth accounts to fund the year's spending.
  // buildPgInputs passes both (blank = $0) and the pricer
  // counts them as spendable funding in cash in — priced
  // as their own source, never as income and never as a
  // taxable sale — so a cash- or Roth-funded year prices
  // its true verdict. Before S-6 the Playground had no
  // dial for either, so such a year showed no funding for
  // the money that actually paid its spending and read
  // short by the whole draw. The saved-plan-year loader
  // fills them from the march's funding ledger (its
  // cashSpend and rothDraw rows).
  const [pgCashDraw, setPgCashDraw] = useState("");
  const [pgRothDraw, setPgRothDraw] = useState("");
  // Reinvested-yield flag (S-3, engines review round 2):
  // set ONLY by loading a year from the saved plan (or by a
  // paste that carries it). The loaded year's interest and
  // dividends are the plan march's yield, which the march
  // reinvested — it counts $0 of funding there — while the
  // loader's sales and draws are already march-sized, so
  // buildPgInputs passes the flag and the pricer keeps the
  // yield out of cash in (it still prices as income in
  // full). Before S-3 the loaded year counted the yield as
  // cash on top of those sales and draws and repriced with
  // more cash left than the march funded, by the yield.
  // Typing in any income dial clears it (the figures are
  // then the user's own, received as cash), as do the
  // blank-year, as-filed, prefill, and reset loads.
  const [pgYieldReinvested, setPgYieldReinvested] = useState(false);
  /* ACA cliff buffer — the "Buffer below the ACA cliff"
     dial (ACA buffer guide build; build v71): how far
     under the 400%-of-FPL cliff the ACA target sits. The
     ACA cliff chip, Hold's "aca" target, and the
     cliff − buffer fill all aim at cliff − buffer, and the
     play strip's landing readout measures MAGI against
     that line. Defaults to $5,000 (the December cushion)
     and is remembered with the rest of the form like every
     other dial. It is never an input to buildPgInputs, so
     it never enters pricing — for any fixed set of dials
     the year prices exactly as before; it only steers the
     fill solves that choose the conversion amount. */
  const [pgAcaBuffer, setPgAcaBuffer] = useState("5000");
  /* Benchmark source record — remembered with the rest of the
     form, like every other playground dial: what the most
     recent "Start from my numbers" prefill loaded into the
     benchmark dial (which saved figure, and whether the couple
     figure is standing in for a blank family figure). It
     drives ONLY the source caption under the dial (see
     pgBenchmarkCaption below): it never feeds pricing, the
     fill chips, or the paste payload. Reset and a successful
     paste-load clear it; a prefill that loads no figure leaves
     it null, so no caption shows. */
  type PgBenchmarkSource =
    | { kind: "family"; value: number }
    | { kind: "couple"; value: number }
    | { kind: "couple-fallback"; value: number }
    | { kind: "single"; value: number };
  const [pgBenchmarkLoaded, setPgBenchmarkLoaded] =
    useState<PgBenchmarkSource | null>(null);
  /* Income-dial provenance (build v150) — remembered with
     the rest of the form, like the benchmark source record
     above: where each of the three income dials' current
     figures came from. "return" = the stored tax return's
     figure (year = the return's calendar year, null when the
     record never named one); "plan" = the saved plan's priced
     figure for that year (the yield-based estimate); "typed"
     = the user's own value (typed in the dial, or loaded by
     a paste). It drives ONLY each dial's source hint and the
     year-change re-derivation (see the re-derivation effect
     below): changing the Tax year re-derives a return- or
     plan-sourced dial for the new year and never overwrites
     a typed figure. It never enters pricing. Null = no
     recorded source (a form remembered before provenance
     existed, a blank dial, a reset). Provenance is EXPLICIT
     ONLY (re-audit NICE-TO-HAVE N-1): a dial's source is
     its recorded kind, never inferred from its value — a
     dial with no recorded source is not treated as
     return-sourced however its value compares to the
     stored return figure, and a typed dial whose value
     coincidentally equals that figure stays typed. */
  type PgIncomeSource =
    | { kind: "return"; year: number | null }
    | { kind: "plan"; year: number }
    | { kind: "typed" };
  type PgIncomeSources = {
    interest: PgIncomeSource | null;
    ordinaryDividends: PgIncomeSource | null;
    qualifiedDividends: PgIncomeSource | null;
  };
  const [pgIncomeSources, setPgIncomeSources] = useState<PgIncomeSources>({
    interest: null,
    ordinaryDividends: null,
    qualifiedDividends: null,
  });
  const [pgStateRate, setPgStateRate] = useState("0");
  // State of residence for this Playground year (T3 build):
  // "WA" prices Washington's capital-gains excise instead of
  // the flat rate; "other" keeps the flat rate.
  const [pgResidence, setPgResidence] = useState<"WA" | "other">("other");
  // Itemized deductions (T5 build): the year's four itemized
  // components as typed strings; blank = $0 on that component.
  const [pgItemizedMortgage, setPgItemizedMortgage] = useState("");
  const [pgItemizedSalt, setPgItemizedSalt] = useState("");
  const [pgItemizedCharitable, setPgItemizedCharitable] = useState("");
  const [pgItemizedOther, setPgItemizedOther] = useState("");
  // Education students (T6 build): this year's entered
  // students — each row's qualified expenses as a typed
  // string plus the household's AOTC-eligibility mark. No
  // rows = no students: no education credits price and the
  // year prices exactly as before. Remembered with the
  // rest of the form, like every other dial here.
  const [pgEduStudents, setPgEduStudents] = useState<
    { expenses: string; aotcEligible: boolean }[]
  >([]);
  const [pgSoleBeneficiary, setPgSoleBeneficiary] = useState(true);
  const [
    pgPrimarySoleBeneficiaryOfSpouse,
    setPgPrimarySoleBeneficiaryOfSpouse,
  ] = useState<boolean | null>(null);
  /* Hold-the-fill state — remembered with the rest of the
     form, like every other playground dial, so a held target
     is still held (and still solving) when the form reopens.
     pgHoldOn is the toggle;
     pgHeldTarget is the target of the most recently tapped
     fill chip — a bracket pct (10/12/22/24) or "aca" for the
     ACA cliff chip (null until a chip is tapped this session).
     While pgHoldOn && pgHeldTarget != null, any change to
     another dial re-solves the pre-tax money out for that
     target (see the hold effect below) so the year stays on
     the bracket top or on the ACA cliff − buffer (Hold's
     "aca" target IS cliff − buffer, build v71). The conversion
     is the solved dial first; when the typed draw ALONE
     already runs past the target, so no conversion can land
     the year on it, Hold solves the DRAW down instead (the
     total money out lands on the target with the conversion
     at $0) — pgHoldDrawSolved records that the draw is the
     dial Hold is currently solving, for the draw dial's
     "Auto" hint. Typing in the conversion dial OR the draw
     dial releases the hold (pgHoldOn off; the target is kept
     as the last-tapped target, so toggling Hold back on
     resumes it); switching Hold off also releases while
     keeping the target.
     Loading a projected year from the chart does NOT release
     it — the loaded dials re-solve against the held target,
     like any other dial change. Reset / prefill / a successful
     paste-load clear BOTH. */
  const [pgHoldOn, setPgHoldOn] = useState(false);
  const [pgHeldTarget, setPgHeldTarget] = useState<PgHeldTarget | null>(null);
  const [pgHoldDrawSolved, setPgHoldDrawSolved] = useState(false);
  /* Projection controls — remembered with the rest of the
     form, like every other playground dial. Blank override
     dials (return, claiming ages and amounts, ACA step-down,
     starting balances) fall back at projection time to the
     template dials or, where the template has no figure, to
     the saved plan's (see the projection block below), so a
     blank never silently means $0 for a figure the plan
     carries. pgProjSelectedYear is remembered with the rest
     of the form: the calendar year last loaded from the
     projection chart into the single-year view, named in the
     chart's caption — so a refresh restores the chart's
     highlight on the year actually being viewed.
     pgProjTemplate is the projection's captured template —
     the single-year dials priced into engine inputs at the
     moment the projection last (re)started (panel opened, or
     the panel's re-run button pressed). The chart runs from
     this snapshot ONLY, never from the live dials, so loading
     a projected year into the single-year view — which
     overwrites the dials — can never shrink or re-base the
     chart. It is remembered with the rest of the form (the
     store carries it as projTemplate), so the decoupling
     survives a reload too: the saved dials may sit on a
     loaded year while the saved template still starts the
     chart at its original year. */
  const [pgProjOpen, setPgProjOpen] = useState(false);
  // The Projection panel's longer methodology: the panel's
  // always-visible intro is a short lead (what the panel is,
  // plus the ACA-convention disclosure), and the mechanics
  // live in the ⓘ beside it (build v67 — the former "More"
  // expander). The projHowOpen form field is retained in the
  // remembered form state for shape compatibility and is no
  // longer toggled.
  const [pgProjHowOpen, setPgProjHowOpen] = useState(false);
  const [pgProjToAge, setPgProjToAge] = useState("95");
  // Projection from age (start-age control): blank = the
  // template's own age, exactly the walk before this dial
  // existed. Earlier starts the walk at that age; later
  // keeps the walk from the template year and shows the
  // years from that age on (see the projection block below).
  const [pgProjFromAge, setPgProjFromAge] = useState("");
  const [pgProjTaxableStart, setPgProjTaxableStart] = useState("");
  const [pgProjRothStart, setPgProjRothStart] = useState("");
  const [pgProjReturnPct, setPgProjReturnPct] = useState("");
  const [pgProjDrawMode, setPgProjDrawMode] = useState<"repeat" | "replace">("repeat");
  const [pgProjMoneyOutKind, setPgProjMoneyOutKind] = useState<"conversion" | "draw">("conversion");
  const [pgProjStopKind, setPgProjStopKind] = useState<"none" | "age" | "floor">("none");
  const [pgProjStopValue, setPgProjStopValue] = useState("");
  const [pgProjSsPClaimAge, setPgProjSsPClaimAge] = useState("");
  const [pgProjSsSClaimAge, setPgProjSsSClaimAge] = useState("");
  const [pgProjSsPAnnual, setPgProjSsPAnnual] = useState("");
  const [pgProjSsSAnnual, setPgProjSsSAnnual] = useState("");
  const [pgProjAcaSizeAfter, setPgProjAcaSizeAfter] = useState("");
  const [pgProjAcaStepYear, setPgProjAcaStepYear] = useState("");
  const [pgProjSelectedYear, setPgProjSelectedYear] = useState<number | null>(null);
  // Balances chart: the calendar year whose end-of-year balances
  // are shown as numbers below the chart (set by clicking a year
  // in the balances chart; independent of pgProjSelectedYear,
  // which loads a year into the single-year view).
  const [pgBalSelectedYear, setPgBalSelectedYear] = useState<number | null>(null);
  const [pgProjTemplate, setPgProjTemplate] =
    useState<PlaygroundYearInputs | null>(null);
  /* Fold state for the playground's five input sections —
     remembered with the rest of the form, like every other
     playground dial, so the form reopens with the same
     sections open. Folding is visual only: the pricing below
     reads the dial state above, so values typed in a folded
     section keep pricing exactly as if the section were open. */
  type PgSectionId = "year" | "income" | "conversion" | "stock" | "aca" | "spending";
  const PG_SECTIONS_OPEN: Record<PgSectionId, boolean> = {
    year: true,
    income: true,
    conversion: true,
    stock: true,
    aca: true,
    spending: true,
  };
  const [pgOpenSections, setPgOpenSections] =
    useState<Record<PgSectionId, boolean>>(PG_SECTIONS_OPEN);
  const togglePgSection = (id: PgSectionId) =>
    setPgOpenSections((p) => ({ ...p, [id]: !p[id] }));
  // One collapsible playground input section as its own card
  // panel, reusing the app's card treatment verbatim — sectionCls,
  // the same class the Roth view's sections (rothSection) and the
  // other result panels use (rounded border, surface background,
  // px-4 py-4 padding; its mt-4 is the consistent gap between
  // cards). The heading sits at the top of the card with the
  // title itself a real button carrying aria-expanded and the
  // app's shared chip chevron (FoldChevron); folding hides the whole card
  // body and the heading row stays visible inside the card,
  // folded or open. Like the Roth view's rothSection, the header
  // button also carries the section's live one-line summary
  // (the `summary` argument — derived from the section's own
  // dials at the call sites below), so a folded section still
  // shows its main settings at a glance and the line updates
  // as the dials change.
  const pgSectionCard = (
    id: PgSectionId,
    title: string,
    summary: string,
    children: ReactNode,
  ) => (
    <section className={sectionCls} aria-label={title}>
      <h3>
        <button
          type="button"
          aria-expanded={pgOpenSections[id]}
          aria-label={`${title} section`}
          className="flex w-full items-start justify-between gap-3 text-left"
          onClick={() => togglePgSection(id)}
        >
          <span>
            <span className="block text-base font-semibold">{title}</span>
            <span className="mt-0.5 block text-sm text-[var(--dim)]">
              {summary}
            </span>
          </span>
          <FoldChevron open={!!pgOpenSections[id]} className="mt-0.5" />
        </button>
      </h3>
      {pgOpenSections[id] && children}
    </section>
  );
  /* Super-group folds — this build's light grouping. The five
     single-year section cards above sit under one named group
     ("Single-year dials") and the Projection card under another
     ("Projection dials"), so the dials for the two different
     prices never read as one wall and the projection's dials
     are visibly separate from the single-year income dials.
     Both groups start OPEN, and their open/closed choices are
     remembered with the rest of the form (groupOpen), like
     pgProjHowOpen above; the individual sections inside keep
     their own remembered folds exactly as before, and nothing
     is removed or hidden by default. Grouping is visual only: the pricing
     below reads the dial state, never the group state, so a
     value typed in a folded group prices exactly as if the
     group were open, and the Hold/target behaviour is untouched. */
  const [pgGroupOpen, setPgGroupOpen] = useState({
    single: true,
    projection: true,
  });
  const togglePgGroup = (id: "single" | "projection") =>
    setPgGroupOpen((p) => ({ ...p, [id]: !p[id] }));
  // One super-group header: a real button carrying
  // aria-expanded and the app's shared chip chevron (FoldChevron), with a
  // one-line blurb naming what the group holds. The header row
  // itself is not a card — the section cards inside the group
  // keep the card treatment. The button carries pr-1 (4px of
  // right padding) so the chip's right edge lands exactly where
  // the view's other bare fold toggles put theirs: the paste
  // and known-point headers centre the same 28px chip inside a
  // 36px tap-target button, which insets the chip 4px from the
  // shared right edge — without this padding the group chip sat
  // flush with that edge, 4px to the right of theirs.
  const pgGroupHeader = (
    id: "single" | "projection",
    title: string,
    blurb: string,
  ) => (
    <h3 className="mt-6">
      <button
        type="button"
        aria-expanded={pgGroupOpen[id]}
        aria-label={`${title} group`}
        className="flex w-full items-start justify-between gap-3 pr-1 text-left"
        onClick={() => togglePgGroup(id)}
      >
        <span>
          <span className="block text-base font-semibold">{title}</span>
          <span className="mt-0.5 block text-sm text-[var(--dim)]">{blurb}</span>
        </span>
        <FoldChevron open={!!pgGroupOpen[id]} className="mt-0.5" />
      </button>
    </h3>
  );
  /* Jump-and-highlight (build v69, highlight strengthened
     build v124 round-18 F8): the provenance-tap mechanism
     modelled on Spending's scrollToSection — open the target's
     face, group, and section first, scroll on a later frame,
     then mark the field itself for ~3s with a 2px accent
     outline plus a soft accent background tint, so the landing
     is unmistakable (applied to the element directly and
     restored afterwards, so the shared field helpers do not
     change). A fixed 3s duration — not until-edit — so the
     mark always clears on its own and the rendered check can
     assert it deterministically. A new jump restores the
     previous field first, so a highlight can never stick. */
  const pgFlashTimer = useRef<number | null>(null);
  const pgFlashEl = useRef<HTMLElement | null>(null);
  const pgFlashPrev = useRef<{ outline: string; outlineOffset: string; background: string } | null>(null);
  const jumpToPgField = (fieldId: string, section: PgSectionId = "aca") => {
    setPgFace("year");
    setPgGroupOpen((p) => ({ ...p, single: true }));
    setPgOpenSections((p) => ({ ...p, [section]: true }));
    window.setTimeout(() => {
      const el = document.getElementById(fieldId);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      // A new jump restores the previous field first.
      if (pgFlashEl.current != null && pgFlashPrev.current != null) {
        const old = pgFlashEl.current;
        old.style.outline = pgFlashPrev.current.outline;
        old.style.outlineOffset = pgFlashPrev.current.outlineOffset;
        old.style.background = pgFlashPrev.current.background;
      }
      if (pgFlashTimer.current != null) {
        window.clearTimeout(pgFlashTimer.current);
      }
      const prev = {
        outline: el.style.outline,
        outlineOffset: el.style.outlineOffset,
        background: el.style.background,
      };
      pgFlashPrev.current = prev;
      pgFlashEl.current = el;
      el.style.outline = "2px solid var(--accent)";
      el.style.outlineOffset = "2px";
      el.style.background = "color-mix(in srgb, var(--accent) 15%, transparent)";
      pgFlashTimer.current = window.setTimeout(() => {
        el.style.outline = prev.outline;
        el.style.outlineOffset = prev.outlineOffset;
        el.style.background = prev.background;
        pgFlashEl.current = null;
        pgFlashPrev.current = null;
      }, 3000);
    }, 150);
  };
  // Provenance taps (build v134): only INPUT values are taps
  // — the ACA buffer figure, whose displayed value is the typed
  // buffer dial. Computed figures (tax, cash left, ACA credit,
  // MAGI, cliff, excise) are plain text: a computed result has
  // no single source field, so any target misleads, and the ⓘ
  // explains the computation instead.
  const pgTapCls =
    "underline decoration-dotted underline-offset-4 hover:text-[var(--accent)]";

  /* Two faces (two-faces redesign) — the view shows ONE tool
     at a time: the "One year" face carries the single-year
     dials, the plain-English year sentence, the sticky play
     strip (the pinned single-year answer), and the single-year
     readout; the "Projection" face carries the projection
     sentence, the projection dials, and the projection charts
     with their click-a-year readouts. The last face shown is
     remembered in this browser (usePersistedChoice, key
     "fp.playground.face"); a first visit, or a missing or
     unknown stored value, opens on "year". BOTH faces read and
     write the SAME dial state declared above, so switching
     faces loses nothing and changes no value — it only changes
     which tool is on screen. The projection still runs only
     while its panel is open (pgProjOpen, a dial like any other):
     opening the Projection face opens that panel, and returning
     to One year leaves it open, exactly as the group fold left
     it — the face switch itself writes no dial. */
  const [pgFace, setPgFace] = usePersistedChoice<"year" | "projection">(
    "fp.playground.face",
    "year",
    ["year", "projection"],
  );
  /* The "Start from a known point" preset cards' fold, in the
     generic server-side fold store (foldState.ts) like the
     Spending section folds — the choice survives reloads and
     new sessions, no localStorage. This section DEFAULTS TO
     EXPANDED, the opposite of every other fold in that store:
     the store only carries folds left in their non-default
     state (a stored entry reads true, and closing a default-
     closed fold just removes its entry), so this hook stores
     the inverse flag — an entry under
     "playground.knownPointsFolded" means the user left the
     section folded shut; no entry means expanded, its default.
     Display only: the loaders below read the dial and plan
     state, never this flag. */
  const [knownPointsFolded, setKnownPointsFolded] = usePersistedFold(
    "playground.knownPointsFolded",
  );
  const knownPointsOpen = !knownPointsFolded;
  /* The "Load inputs from a paste" fold, in the same generic
     server-side fold store: an occasional-use tool, so it
     DEFAULTS TO COLLAPSED (the store's own default — no entry
     means shut) and the stored choice survives reloads like
     every other fold. Display only: the paste parsing and the
     Load inputs button behave exactly as before, whenever the
     section is open. */
  const [pasteOpen, setPasteOpen] = usePersistedFold(
    "playground.pasteInputs",
  );
  /* Month / Year spend-display toggle (2026-11-03): ONE
     persisted flag in the same generic fold store, shared by
     BOTH spend readouts — "Cash left after tax" and "Left
     after a year's spending" — in both places they render
     (the sticky play strip and the Tax for the year card), so
     the two readouts always switch together and the last
     choice comes back after a reload. No entry (the store's
     default) is Year, the display as it has always been; an
     entry means the user last left it on Month. Display only:
     Month mode divides the priced annual figures by 12 at
     render time — nothing priced or stored ever changes. */
  const [spendPerMonth, setSpendPerMonth] = usePersistedFold(
    "playground.spendPerMonth",
  );
  // The year chosen on the "A year from my saved plan" preset
  // card (a calendar year from the saved plan's priced years);
  // null until the priced years land, then the first year is
  // preselected. Session-only — it is a picker, not a dial.
  const [pgPlanPresetYear, setPgPlanPresetYear] = useState<number | null>(null);
  // One-line confirmation under the preset cards, naming what
  // the last preset load put on the dials. Display only.
  const [pgPresetNote, setPgPresetNote] = useState<string | null>(null);
  // The balances chart container on the Projection face.
  // Refs only — no state, no pricing.
  const pgBalancesRef = useRef<HTMLDivElement | null>(null);
  /* Remembered form state — hydration + save. On load, a
     stored form (the playground field of the Roth UI-state
     blob) is applied to the dials once; from then on the form
     saves itself as the user plays (debounced, no save
     button). Hydration is one-shot (the pgInit guard), exactly
     like the Strategy Lab dials: a later refetch never
     overwrites dials being edited. Saves fire only AFTER
     hydration, so a first open can never overwrite a stored
     form with the fresh defaults — and if the state read
     fails, the form simply behaves as the old scratch form
     (nothing saves, no error surface). The plan record and
     scenarios are never written by any of this: the only
     writer is setRothUiState's playground field. */
  const [pgInit, setPgInit] = useState(false);
  // "Reset playground" confirmation — shown in place of the
  // reset link while a reset is being confirmed (the app-wide
  // reset rule: confirmation whenever a reset clears saved
  // values, and the remembered copy is a saved value now).
  const [pgConfirmReset, setPgConfirmReset] = useState(false);
  const pgSavedJsonRef = useRef<string | null>(null);
  const pgForceWholesaleRef = useRef(false);
  // Build v206 (re-audit round 4 SHOULD R4-S6): the
  // remembered-form save generation. "Reset playground"
  // bumps this counter as it lands its wholesale save, and
  // every remembered-form save carries the generation it
  // began under (captured in executePgFormSave, threaded
  // through runPgFormSaveAttempt into savePgCas). A save
  // whose generation no longer matches has been superseded
  // by the reset: it must not write again — above all its
  // CAS conflict retry must not merge its pre-reset snapshot
  // against the post-reset stored form, which (with
  // pgSavedJsonRef already moved to the reset defaults)
  // would resurrect every pre-reset dial at the next
  // revision while the screen shows the blank form. Before
  // v206 the reset had no such guard, so an in-flight save
  // whose first write the reset's save refused would do
  // exactly that on its merge-retry, and returning to the
  // view rehydrated the pre-reset values — the reset was
  // silently undone. A save that begins after the reset
  // captures the new generation and saves normally, so
  // prefill / paste-load (which queue their own save after
  // any reset) still land as the last word, and a reset
  // with nothing in flight behaves exactly as before.
  const pgFormSaveGenRef = useRef(0);
  // One-shot guard for the income re-derivation effect
  // (build v150): the "as filed" preset sets the year to
  // the return year but loads ONLY the lines the record
  // holds — a line it has not entered keeps its dial exactly
  // as it stands, by that preset's own contract. The preset
  // arms this guard when it changes the year, and the effect
  // consumes it on its next run instead of re-deriving over
  // the preset's partial load.
  const pgIncomeLoadGuardRef = useRef(false);
  // The form's JSON as of the latest render — lets an async
  // save tell whether the user has typed past the snapshot it
  // started from before applying a merged form back to the
  // dials (never over newer typing).
  const pgFormJsonRef = useRef("");
  const applyPgSavedForm = (s: PgSavedForm) => {
    setPgYear(s.year);
    setPgFiling(s.filing);
    setPgAgeP(s.agePrimary);
    setPgAgeS(s.ageSpouse);
    setPgMedP(s.medicarePrimary);
    setPgMedS(s.medicareSpouse);
    setPgInterest(s.interest);
    setPgOrdDiv(s.ordinaryDividends);
    setPgOther(s.otherOrdinary);
    setPgTaxExempt(s.taxExemptInterest);
    setPgSsP(s.ssPrimary);
    setPgSsS(s.ssSpouse);
    setPgConversion(s.conversion);
    setPgSpendingDraw(s.spendingDraw ?? "");
    setPgSold(s.stockSold);
    setPgBasis(s.stockBasis);
    setPgQualDiv(s.qualifiedDividends);
    setPgPretax(s.pretaxBalance);
    setPgPretaxSpouse(s.pretaxBalanceSpouse ?? "");
    setPgAcaSize(s.acaHouseholdSize);
    setPgBenchmark(s.acaBenchmark);
    setPgHealthAca(s.healthPremiumAca ?? "");
    setPgHealthMedicare(s.healthPremiumMedicare ?? "");
    setPgIrmaaPayable(s.irmaaPayable ?? "");
    setPgAptcTaken(s.aptcTaken ?? "");
    setPgCoverageReduction(s.acaCoverageReduction ?? "");
    setPgCarryInSt(s.capitalLossCarryInSt ?? "");
    setPgCarryInLt(s.capitalLossCarryInLt ?? "");
    setPgCarryInStWa(s.capitalLossCarryInStWa ?? "");
    setPgCarryInLtWa(s.capitalLossCarryInLtWa ?? "");
    setPgRmdReceived(s.rmdAlreadyReceived ?? "");
    setPgDependentMagi(s.dependentMagiForAca ?? "");
    setPgCashDraw(s.cashDraw ?? "");
    setPgRothDraw(s.rothDraw ?? "");
    setPgYieldReinvested(s.yieldReinvested ?? false);
    // A restored form holds no paste figure (P-S2): the
    // hold is session state, never part of the remembered
    // form, so the comparison resolves from the record.
    setPgPastedSpending(undefined);
    // The harvest hold (P-S3) is session state the same
    // way: a restored form holds no paste facts.
    setPgPastedHarvest(undefined);
    setPgAcaBuffer(s.acaBuffer);
    setPgBenchmarkLoaded(s.benchmarkSource);
    setPgIncomeSources(s.incomeSources);
    setPgStateRate(s.stateRate);
    setPgResidence(s.residenceState === "WA" ? "WA" : "other");
    setPgItemizedMortgage(s.itemizedMortgageInterest);
    setPgItemizedSalt(s.itemizedSaltPaid);
    setPgItemizedCharitable(s.itemizedCharitable);
    setPgItemizedOther(s.itemizedOther);
    setPgEduStudents(s.educationStudents);
    setPgSoleBeneficiary(s.soleBeneficiary);
    setPgPrimarySoleBeneficiaryOfSpouse(
      s.primarySoleBeneficiaryOfSpouse ?? null,
    );
    setPgHoldOn(s.holdOn);
    setPgHeldTarget(s.heldTarget);
    setPgProjOpen(s.projOpen);
    setPgProjToAge(s.projToAge);
    setPgProjFromAge(s.projFromAge);
    setPgProjTaxableStart(s.projTaxableStart);
    setPgProjRothStart(s.projRothStart);
    setPgProjReturnPct(s.projReturnPct);
    setPgProjDrawMode(s.projDrawMode);
    setPgProjMoneyOutKind(s.projMoneyOutKind);
    setPgProjStopKind(s.projStopKind);
    setPgProjStopValue(s.projStopValue);
    setPgProjSsPClaimAge(s.projSsPrimaryClaimAge);
    setPgProjSsSClaimAge(s.projSsSpouseClaimAge);
    setPgProjSsPAnnual(s.projSsPrimaryAnnual);
    setPgProjSsSAnnual(s.projSsSpouseAnnual);
    setPgProjAcaSizeAfter(s.projAcaSizeAfter);
    setPgProjAcaStepYear(s.projAcaStepYear);
    setPgProjSelectedYear(s.projSelectedYear);
    setPgProjTemplate(
      s.projTemplate != null ? projTemplateFromStored(s.projTemplate) : null,
    );
    setPgOpenSections(s.openSections);
    setPgProjHowOpen(s.projHowOpen);
    setPgGroupOpen(s.groupOpen);
  };
  useEffect(() => {
    if (!pgUiQ.data || pgInit) return;
    const s = pgUiQ.data.playground;
    applyPgSavedForm(s);
    pgSavedJsonRef.current = JSON.stringify(s);
    pgRevisionRef.current = pgUiQ.data.revision;
    setPgInit(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pgUiQ.data, pgInit]);
  // Keep the tracked revision in step with refetches (the
  // server invalidates this query after writes, ours included).
  // A stale in-flight refetch can only move it backwards into a
  // conflict on the next save, which the save's merge-and-retry
  // resolves — never into a silent overwrite.
  useEffect(() => {
    if (pgUiQ.data) pgRevisionRef.current = pgUiQ.data.revision;
  }, [pgUiQ.data]);
  // The complete form as one snapshot, in the store's shape —
  // rebuilt every render from the dial state above.
  const pgFormSnapshot: PgSavedForm = {
    year: pgYear,
    filing: pgFiling,
    agePrimary: pgAgeP,
    ageSpouse: pgAgeS,
    medicarePrimary: pgMedP,
    medicareSpouse: pgMedS,
    interest: pgInterest,
    ordinaryDividends: pgOrdDiv,
    otherOrdinary: pgOther,
    taxExemptInterest: pgTaxExempt,
    ssPrimary: pgSsP,
    ssSpouse: pgSsS,
    conversion: pgConversion,
    spendingDraw: pgSpendingDraw,
    stockSold: pgSold,
    stockBasis: pgBasis,
    qualifiedDividends: pgQualDiv,
    pretaxBalance: pgPretax,
    pretaxBalanceSpouse: pgPretaxSpouse,
    acaHouseholdSize: pgAcaSize,
    acaBenchmark: pgBenchmark,
    healthPremiumAca: pgHealthAca,
    healthPremiumMedicare: pgHealthMedicare,
    irmaaPayable: pgIrmaaPayable,
    aptcTaken: pgAptcTaken,
    acaCoverageReduction: pgCoverageReduction,
    capitalLossCarryInSt: pgCarryInSt,
    capitalLossCarryInLt: pgCarryInLt,
    capitalLossCarryInStWa: pgCarryInStWa,
    capitalLossCarryInLtWa: pgCarryInLtWa,
    rmdAlreadyReceived: pgRmdReceived,
    dependentMagiForAca: pgDependentMagi,
    cashDraw: pgCashDraw,
    rothDraw: pgRothDraw,
    yieldReinvested: pgYieldReinvested,
    acaBuffer: pgAcaBuffer,
    benchmarkSource: pgBenchmarkLoaded,
    incomeSources: pgIncomeSources,
    stateRate: pgStateRate,
    residenceState: pgResidence,
    itemizedMortgageInterest: pgItemizedMortgage,
    itemizedSaltPaid: pgItemizedSalt,
    itemizedCharitable: pgItemizedCharitable,
    itemizedOther: pgItemizedOther,
    educationStudents: pgEduStudents,
    soleBeneficiary: pgSoleBeneficiary,
    primarySoleBeneficiaryOfSpouse: pgPrimarySoleBeneficiaryOfSpouse,
    holdOn: pgHoldOn,
    heldTarget: pgHeldTarget,
    projOpen: pgProjOpen,
    projToAge: pgProjToAge,
    projFromAge: pgProjFromAge,
    projTaxableStart: pgProjTaxableStart,
    projRothStart: pgProjRothStart,
    projReturnPct: pgProjReturnPct,
    projDrawMode: pgProjDrawMode,
    projMoneyOutKind: pgProjMoneyOutKind,
    projStopKind: pgProjStopKind,
    projStopValue: pgProjStopValue,
    projSsPrimaryClaimAge: pgProjSsPClaimAge,
    projSsSpouseClaimAge: pgProjSsSClaimAge,
    projSsPrimaryAnnual: pgProjSsPAnnual,
    projSsSpouseAnnual: pgProjSsSAnnual,
    projAcaSizeAfter: pgProjAcaSizeAfter,
    projAcaStepYear: pgProjAcaStepYear,
    projSelectedYear: pgProjSelectedYear,
    projTemplate:
      pgProjTemplate != null ? projTemplateToStored(pgProjTemplate) : null,
    openSections: pgOpenSections,
    projHowOpen: pgProjHowOpen,
    groupOpen: pgGroupOpen,
  };
  const pgFormJson = JSON.stringify(pgFormSnapshot);
  pgFormJsonRef.current = pgFormJson;
  /* The three-way per-field merge the save below (and its
     conflict retry) runs: for each field, the side that moved
     away from the last-synced value wins — the local form for
     fields the user just edited here, the stored form for
     fields another writer changed. */
  const mergePgForms = (
    local: PgSavedForm,
    stored: PgSavedForm,
    lastSynced: PgSavedForm,
  ): PgSavedForm => {
    const localRecord = local as unknown as Record<string, unknown>;
    const storedRecord = stored as unknown as Record<string, unknown>;
    const lastRecord = lastSynced as unknown as Record<string, unknown>;
    const mergedRecord: Record<string, unknown> = {};
    const keys = new Set<string>([
      ...Object.keys(localRecord),
      ...Object.keys(storedRecord),
      ...Object.keys(lastRecord),
    ]);
    for (const key of keys) {
      const localVal = localRecord[key];
      const storedVal = storedRecord[key];
      const lastVal = lastRecord[key];
      mergedRecord[key] =
        JSON.stringify(localVal) !== JSON.stringify(lastVal) ? localVal : storedVal;
    }
    return mergedRecord as unknown as PgSavedForm;
  };
  /* One revision-checked (CAS) save of the remembered form,
     with a single conflict retry. `snapshot` is the form to
     store; `baseRevision` is the revision that snapshot was
     derived from; `startedJson` is the form JSON the save
     began from — a conflict-merged form is applied back to
     the dials only while the form still shows exactly that
     JSON, never over newer typing. On success the tracked
     revision and last-synced JSON move to the saved snapshot.
     On conflict (another writer's save landed first), the
     three-way merge runs again with the server's current form
     as the stored side and the merged form retries at the
     server's revision — the user's own changed fields win, so
     the most recent edits are never silently dropped. With
     `wholesale` (Reset, paste, prefill — deliberate whole-form
     replacements) the retry stores the snapshot itself. Any
     failure leaves the tracked state untouched; the next edit
     re-saves. Nothing here surfaces an error, exactly as
     before: this is remembered form state, not plan data.
     The return value reports whether the form landed (true)
     or the save failed (false) — the debounced caller ignores
     it (a later edit re-saves, as before), but the unmount
     flush (build v195) retries on false, since after unmount
     there is no later edit to re-save.
     The write is ALWAYS revision-checked — it never reaches
     setRothUiState without a baseRevision. When the tracked
     revision is still null (the first state read failed, or
     a save somehow fires before it lands), the current state
     is fetched first and its revision adopted: on the
     non-wholesale path the fetched form feeds the same
     fresh-read/merge flow the debounced save runs, so another
     writer's newer fields survive; on the wholesale path the
     snapshot replaces the form whole, checked at the fetched
     revision. If that fetch fails the write is skipped
     entirely; the next edit re-saves.
     Build v206 (R4-S6): `saveGen` is the save generation the
     caller began under (see pgFormSaveGenRef). It is checked
     on entry, after the null-base fresh read, and before the
     conflict retry: once a "Reset playground" has bumped the
     generation, a superseded save writes nothing further and
     reports false (nothing of its snapshot landed) — the
     reset's own wholesale save, begun under the new
     generation, is the last word on the stored form. */
  const savePgCas = async (
    snapshot: PgSavedForm,
    baseRevision: number | null,
    startedJson: string,
    wholesale = false,
    saveGen = pgFormSaveGenRef.current,
  ): Promise<boolean> => {
    // Build v206 (R4-S6): a save a reset has superseded
    // writes nothing — see pgFormSaveGenRef.
    const saveSuperseded = () => saveGen !== pgFormSaveGenRef.current;
    if (saveSuperseded()) return false;
    let formToSave = snapshot;
    let base = baseRevision;
    if (base == null) {
      let fresh: ApiResponse<typeof api, "getRothUiState">;
      try {
        fresh = await api.getRothUiState({});
      } catch {
        return false;
      }
      base = fresh.revision;
      pgRevisionRef.current = fresh.revision;
      // Build v206 (R4-S6): a reset landed while this save
      // was reading — do not merge (or write) its pre-reset
      // snapshot against the post-reset form.
      if (saveSuperseded()) return false;
      if (!wholesale) {
        const storedJson = JSON.stringify(fresh.playground);
        if (storedJson !== pgSavedJsonRef.current) {
          let lastSyncedSnapshot: PgSavedForm | null = null;
          try {
            lastSyncedSnapshot = pgSavedJsonRef.current
              ? (JSON.parse(pgSavedJsonRef.current) as PgSavedForm)
              : null;
          } catch {
            lastSyncedSnapshot = null;
          }
          if (lastSyncedSnapshot) {
            const mergedSnapshot = mergePgForms(
              snapshot,
              fresh.playground,
              lastSyncedSnapshot,
            );
            formToSave = mergedSnapshot;
            if (
              JSON.stringify(mergedSnapshot) !== startedJson &&
              pgFormJsonRef.current === startedJson
            ) {
              applyPgSavedForm(mergedSnapshot);
            }
          }
        }
      }
    }
    let res: ApiResponse<typeof api, "setRothUiState">;
    try {
      res = await api.setRothUiState({
        playground: formToSave,
        baseRevision: base,
      });
    } catch {
      return false;
    }
    if (res.ok) {
      pgRevisionRef.current = res.revision;
      pgSavedJsonRef.current = JSON.stringify(formToSave);
      cachePgForm(formToSave, res.revision);
      return true;
    }
    // Build v206 (R4-S6): the conflict this save just hit
    // may be the reset's own wholesale save landing first.
    // If so, the merge below would run against the reset
    // defaults with pgSavedJsonRef already moved to those
    // defaults, so every pre-reset field would "win" and
    // the retry would resurrect them over the reset. A
    // superseded save stops here instead; a conflict from
    // any other writer (generation unchanged) merges and
    // retries exactly as before.
    if (saveSuperseded()) return false;
    let lastSyncedSnapshot: PgSavedForm | null = null;
    try {
      lastSyncedSnapshot = pgSavedJsonRef.current
        ? (JSON.parse(pgSavedJsonRef.current) as PgSavedForm)
        : null;
    } catch {
      lastSyncedSnapshot = null;
    }
    const merged =
      wholesale || !lastSyncedSnapshot
        ? formToSave
        : mergePgForms(formToSave, res.state.playground, lastSyncedSnapshot);
    let retry: ApiResponse<typeof api, "setRothUiState">;
    try {
      retry = await api.setRothUiState({
        playground: merged,
        baseRevision: res.revision,
      });
    } catch {
      return false;
    }
    if (!retry.ok) return false;
    pgRevisionRef.current = retry.revision;
    pgSavedJsonRef.current = JSON.stringify(merged);
    cachePgForm(merged, retry.revision);
    if (
      JSON.stringify(merged) !== startedJson &&
      pgFormJsonRef.current === startedJson
    ) {
      applyPgSavedForm(merged);
    }
    return true;
  };
  /* Build v195 (re-audit round 3 SHOULD-6): the unmount
     flush for the remembered form, and the bookkeeping it
     and the debounced save share. Before v195 the debounced
     save below had NO unmount flush at all: its effect
     cleanup only cleared the 400 ms timer, so a dial typed
     just before the user switched views was never sent —
     the timer died with the view, nothing else held the
     edit, and returning re-hydrated the stored form, so the
     dial silently reverted to its previous value. (The
     write-through below has flushed since v169; this
     remembered-form save was the one save path in the view
     still missing one.) The bookkeeping mirrors the other
     writers' flush machinery (the Tax Plan's v149/v168/v187
     shape, the write-through's v169/v189 shape):
       - pgFormPendingRef holds the ONE pending save — the
         latest form snapshot that differs from the
         last-synced JSON, with its wholesale flag captured
         as it stood when queued. The debounced effect
         records it on every form change and clears it when
         the form is back at the synced value; a save that
         lands clears it too (executePgFormSave below), so
         at unmount it names exactly the edit still owed.
       - pgFormSavesInFlightRef counts remembered-form saves
         in flight (the debounced save is async — a fresh
         read, a merge, and the CAS write), and
         pgFormLastSettledRef records the last one's outcome,
         so the unmount cleanup can tell "queued behind an
         in-flight save" (defer the flush until that save
         settles, the S-3 rule — firing concurrently would
         race the same CAS base) from "the in-flight save
         itself" (that save IS this edit: if it landed, the
         flush is already done; if it failed, the flush is
         its retry).
       - deferredPgFormFlushRef is the deferred slot the
         in-flight save's settle consumes (in
         executePgFormSave), exactly as the other writers'
         deferred slots are consumed by their in-flight
         calls' per-call handlers.
       - The flush send (flushPgFormSave) retries on failure
         on its own timer (pgFormFlushRetryTimerRef), which
         no cleanup clears, so the retries outlive the view —
         the MUST-3 / MUST-4 / MUST-5 rule: a failed flush is
         retried until it lands, never dropped silently. */
  const pgFormPendingRef = useRef<PgFormPendingSave | null>(null);
  const pgFormSavesInFlightRef = useRef(0);
  const pgFormLastSettledRef = useRef<{
    json: string;
    ok: boolean;
  } | null>(null);
  const deferredPgFormFlushRef = useRef<(() => void) | null>(null);
  const pgFormFlushRetryTimerRef = useRef<number | null>(null);
  // Build v196 (re-audit round 3 SHOULD-7): the deferred
  // slot's GIVE-UP timer — the same shape as the
  // write-through slot's above, applied to this slot too
  // (it was added by build v195, after SHOULD-7 was filed,
  // with the same defect: its only consumer is the
  // in-flight save's settle path in executePgFormSave, so
  // a remembered-form save that hung forever — its promise
  // neither resolving nor rejecting, its finally never
  // running — would strand the deferred flush in the slot
  // for the rest of the page's life, never sent and never
  // reported). The unmount cleanup below ARMS this timer
  // as it stores the deferred send: if the in-flight count
  // has not reached zero within
  // DEFERRED_FLUSH_GIVE_UP_MS, the timer consumes the
  // slot itself and fires the deferred send anyway,
  // through the same retrying flush send (flushPgFormSave)
  // a settle would have fired — so the edit is sent, its
  // failure re-arms the flush's own 3 s retry, and its
  // save's own fresh-read / merge / CAS merge-retry
  // handles any conflict from sending while the wedged
  // save is still in flight. A settle that lands first
  // consumes the slot through takeDeferredPgFormFlush,
  // which clears this timer, so a normally-settling save
  // fires the deferred send exactly as before and the
  // timer never fires at all. The timer lives in its own
  // ref, cleared by nothing after unmount, so it outlives
  // the view like the flush retry timer.
  const deferredPgFormFlushGiveUpTimerRef = useRef<number | null>(null);
  const clearDeferredPgFormFlushGiveUp = () => {
    if (deferredPgFormFlushGiveUpTimerRef.current != null) {
      window.clearTimeout(deferredPgFormFlushGiveUpTimerRef.current);
      deferredPgFormFlushGiveUpTimerRef.current = null;
    }
  };
  // Consume the deferred slot (and disarm its give-up
  // timer): the ONE way the slot is read, so a settle and
  // the give-up can never both fire the same send.
  const takeDeferredPgFormFlush = (): (() => void) | null => {
    clearDeferredPgFormFlushGiveUp();
    const deferred = deferredPgFormFlushRef.current;
    deferredPgFormFlushRef.current = null;
    return deferred;
  };
  const armDeferredPgFormFlushGiveUp = () => {
    clearDeferredPgFormFlushGiveUp();
    deferredPgFormFlushGiveUpTimerRef.current = window.setTimeout(() => {
      deferredPgFormFlushGiveUpTimerRef.current = null;
      const deferred = deferredPgFormFlushRef.current;
      deferredPgFormFlushRef.current = null;
      if (deferred) deferred();
    }, DEFERRED_FLUSH_GIVE_UP_MS);
  };
  /* One attempt at the debounced save for a pending form —
     the exact body the 400 ms timer used to run inline: a
     wholesale pending saves whole; otherwise the stored
     form is read fresh, and when another writer has moved
     it since the last sync the three-way merge runs first
     (the user's own changed fields win), with the merged
     form applied back to the dials only while the form
     still shows exactly the JSON the save began from.
     Reports whether the form landed, for the flush's retry.
     Build v206 (R4-S6): `saveGen` is the generation the
     attempt began under, threaded into every savePgCas call
     and re-checked here after the fresh read — a reset that
     landed during the read supersedes the attempt, whose
     merge would otherwise run its pre-reset snapshot
     against the post-reset stored form. */
  const runPgFormSaveAttempt = async (
    pending: PgFormPendingSave,
    saveGen: number,
  ): Promise<boolean> => {
    const localSnapshot = pending.snapshot;
    const localJson = pending.json;
    if (pending.wholesale) {
      return savePgCas(
        localSnapshot,
        pgRevisionRef.current,
        localJson,
        true,
        saveGen,
      );
    }
    const lastSyncedJson = pgSavedJsonRef.current;
    let storedSnapshot: PgSavedForm;
    let storedJson: string;
    let storedRevision: number;
    try {
      const fresh = await api.getRothUiState({});
      storedSnapshot = fresh.playground;
      storedJson = JSON.stringify(storedSnapshot);
      storedRevision = fresh.revision;
    } catch {
      return savePgCas(
        localSnapshot,
        pgRevisionRef.current,
        localJson,
        false,
        saveGen,
      );
    }
    pgRevisionRef.current = storedRevision;
    if (saveGen !== pgFormSaveGenRef.current) return false;
    if (storedJson === lastSyncedJson) {
      return savePgCas(localSnapshot, storedRevision, localJson, false, saveGen);
    }
    let lastSyncedSnapshot: PgSavedForm | null = null;
    try {
      lastSyncedSnapshot = lastSyncedJson
        ? (JSON.parse(lastSyncedJson) as PgSavedForm)
        : null;
    } catch {
      lastSyncedSnapshot = null;
    }
    if (!lastSyncedSnapshot) {
      return savePgCas(localSnapshot, storedRevision, localJson, false, saveGen);
    }
    const mergedSnapshot = mergePgForms(
      localSnapshot,
      storedSnapshot,
      lastSyncedSnapshot,
    );
    const mergedJson = JSON.stringify(mergedSnapshot);
    const ok = await savePgCas(
      mergedSnapshot,
      storedRevision,
      localJson,
      false,
      saveGen,
    );
    if (mergedJson !== localJson && pgFormJsonRef.current === localJson) {
      applyPgSavedForm(mergedSnapshot);
    }
    return ok;
  };
  /* Run one remembered-form save attempt with the shared
     bookkeeping: consume the wholesale flag a wholesale
     pending carries (the pending record itself keeps the
     flag, so a flush retry saves wholesale exactly as the
     first attempt did), count the attempt as in flight,
     record its outcome, drop the pending record when it
     lands, and — when the last in-flight save settles —
     consume a flush the unmount cleanup deferred behind it. */
  const executePgFormSave = async (
    pending: PgFormPendingSave,
  ): Promise<boolean> => {
    if (pending.wholesale) pgForceWholesaleRef.current = false;
    // Build v206 (R4-S6): the attempt runs under the save
    // generation as it stands when the attempt begins; a
    // reset during the attempt supersedes it (see
    // pgFormSaveGenRef).
    const saveGen = pgFormSaveGenRef.current;
    pgFormSavesInFlightRef.current += 1;
    let ok = false;
    try {
      ok = await runPgFormSaveAttempt(pending, saveGen);
    } finally {
      pgFormSavesInFlightRef.current -= 1;
      pgFormLastSettledRef.current = { json: pending.json, ok };
      if (ok && pgFormPendingRef.current?.json === pending.json) {
        pgFormPendingRef.current = null;
      }
      if (pgFormSavesInFlightRef.current === 0) {
        // Build v196: consumed through
        // takeDeferredPgFormFlush, which also disarms the
        // slot's give-up timer — a save that settles
        // normally leaves no timer behind.
        const deferred = takeDeferredPgFormFlush();
        if (deferred) deferred();
      }
    }
    return ok;
  };
  const executePgFormSaveRef = useRef(executePgFormSave);
  executePgFormSaveRef.current = executePgFormSave;
  /* The ONE unmount-flush send for a pending remembered-form
     save (build v195): run the same save the debounce would
     have run, and on failure re-arm a 3 s retry of the SAME
     pending record, chained per failure exactly as the other
     flush sends re-arm theirs (builds v187–v189), so the
     edit lands once the server is reachable again instead of
     reverting silently. Each retry re-runs the full save —
     fresh read, three-way merge, CAS write with its own
     conflict retry — so a retry never rides a stale base:
     another writer's intervening save is merged against,
     never overwritten. The retry timer lives in its own
     ref, not the debounce timer (the effect cleanup clears
     that as it runs) — nothing runs after unmount to clear
     this one, so the retries outlive the view. A record
     whose JSON already matches the last-synced JSON needs
     no send at all (an in-flight save landed it while the
     flush waited). */
  const flushPgFormSave = async (pending: PgFormPendingSave): Promise<void> => {
    if (pending.json === pgSavedJsonRef.current) return;
    const ok = await executePgFormSaveRef.current(pending);
    if (ok) return;
    if (pgFormFlushRetryTimerRef.current != null) {
      window.clearTimeout(pgFormFlushRetryTimerRef.current);
    }
    pgFormFlushRetryTimerRef.current = window.setTimeout(() => {
      void flushPgFormSaveRef.current(pending);
    }, 3000);
  };
  const flushPgFormSaveRef = useRef(flushPgFormSave);
  flushPgFormSaveRef.current = flushPgFormSave;
  useEffect(() => {
    if (!pgInit) return;
    if (pgFormJson === pgSavedJsonRef.current) {
      pgForceWholesaleRef.current = false;
      pgFormPendingRef.current = null;
      return;
    }
    const localJson = pgFormJson;
    const localSnapshot = JSON.parse(localJson) as PgSavedForm;
    // Build v195: record the pending save (with the
    // wholesale flag as it stands for this snapshot) before
    // arming the debounce, so the unmount flush below can
    // send exactly this save if the view goes away first.
    const pending: PgFormPendingSave = {
      snapshot: localSnapshot,
      json: localJson,
      wholesale: pgForceWholesaleRef.current,
    };
    pgFormPendingRef.current = pending;
    const t = setTimeout(() => {
      void executePgFormSaveRef.current(pending);
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pgInit, pgFormJson]);
  // Flush a pending remembered-form save when leaving the
  // screen, so a dial typed in the last fraction of a second
  // is not lost (build v195, re-audit round 3 SHOULD-6 —
  // before v195 this save had no unmount flush at all; its
  // debounce timer was simply cleared and the edit reverted
  // on return). With nothing in flight the flush sends at
  // once through the ONE retrying flush send above. With a
  // save still in flight the flush is deferred instead —
  // the S-3 rule the other writers follow: the in-flight
  // save's settle consumes the deferred slot, and by then
  // its outcome decides — if that save WAS this pending
  // edit and it landed, the flush is already done and the
  // slot's send is skipped; in every other case (a newer
  // edit queued behind it, or that save failed) the slot
  // fires the flush, which runs the pending save fresh
  // under the now-current revision. A conflict inside the
  // flush's save is not a failure to retry blindly:
  // savePgCas already merge-retries a conflict once per
  // attempt, and each flush retry re-reads and re-merges,
  // so a further conflict resolves on the next attempt
  // against the newest stored form rather than fighting it.
  useEffect(() => {
    return () => {
      const pending = pgFormPendingRef.current;
      if (!pending) return;
      pgFormPendingRef.current = null;
      if (pending.json === pgSavedJsonRef.current) return;
      if (pgFormSavesInFlightRef.current > 0) {
        deferredPgFormFlushRef.current = () => {
          const settled = pgFormLastSettledRef.current;
          if (settled && settled.json === pending.json && settled.ok) return;
          void flushPgFormSaveRef.current(pending);
        };
        // Build v196 (re-audit round 3 SHOULD-7): storing
        // the deferred send also ARMS its give-up timer —
        // if the in-flight save never settles, the timer
        // fires the deferred send through the same retrying
        // flush send after DEFERRED_FLUSH_GIVE_UP_MS
        // instead of leaving it stranded in the slot
        // forever (see the timer's comment beside
        // deferredPgFormFlushRef). Note the slot's own
        // settled check above reads pgFormLastSettledRef
        // as it stands when the timer fires: a wedged save
        // never recorded an outcome, so the check cannot
        // mistake this pending edit for a landed one.
        armDeferredPgFormFlushGiveUp();
      } else {
        void flushPgFormSaveRef.current(pending);
      }
    };
  }, []);
  /* Playground paste loader — the paste box itself is NOT
     remembered: the box, its error line, and its loaded note
     are never persisted, never reach an action, and a reload
     clears them. The dials a successful paste sets ARE
     remembered, exactly like typed values (they persist
     through the save above). Pasting is equivalent to typing:
     the pasted payload (the canonical object the
     runPlaygroundYear action emits) is validated WHOLE by
     parsePlaygroundPaste — the shared validator in
     rothOptimizer.ts — before any dial is touched, so a
     malformed paste changes nothing, the remembered copy
     included, and shows one plain error line. On success every
     dial is set from the payload as ordinary form state. */
  const [pgPasteText, setPgPasteText] = useState("");
  const [pgPasteError, setPgPasteError] = useState<string | null>(null);
  const [pgPasteLoaded, setPgPasteLoaded] = useState(false);
  const applyPgPaste = () => {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(pgPasteText);
    } catch {
      setPgPasteError("That paste is not valid JSON — nothing was loaded.");
      setPgPasteLoaded(false);
      return;
    }
    const res = parsePlaygroundPaste(parsedJson);
    if (!res.ok) {
      setPgPasteError(res.error);
      setPgPasteLoaded(false);
      return;
    }
    const inp = res.inputs;
    pgForceWholesaleRef.current = true;
    const moneyOrBlank = (n: number | null) =>
      n == null ? "" : fmtMoneyInput(n);
    setPgOpenSections(PG_SECTIONS_OPEN);
    setPgYear(String(inp.taxYear));
    setPgFiling(inp.filingStatus);
    setPgAgeP(String(inp.agePrimary));
    setPgAgeS(inp.ageSpouse != null ? String(inp.ageSpouse) : "");
    setPgMedP(inp.onMedicarePrimary);
    setPgMedS(inp.onMedicareSpouse);
    setPgInterest(fmtMoneyInput(inp.interest));
    setPgOrdDiv(fmtMoneyInput(inp.ordinaryDividends));
    setPgOther(fmtMoneyInput(inp.otherOrdinary));
    setPgTaxExempt(fmtMoneyInput(inp.taxExemptInterest));
    setPgSsP(fmtMoneyInput(inp.ssPrimary));
    setPgSsS(fmtMoneyInput(inp.ssSpouse));
    setPgConversion(fmtMoneyInput(inp.conversion));
    // The paste payload carries the spending draw (R3-M1);
    // an older paste carries no such key and loads it
    // blank — no draw counted, exactly as before.
    setPgSpendingDraw(
      inp.spendingDraw == null ? "" : fmtMoneyInput(inp.spendingDraw),
    );
    setPgSold(fmtMoneyInput(inp.stockSold));
    setPgBasis(fmtMoneyInput(inp.stockBasis));
    setPgQualDiv(fmtMoneyInput(inp.qualifiedDividends));
    setPgPretax(moneyOrBlank(inp.pretaxBalance));
    setPgPretaxSpouse(moneyOrBlank(inp.pretaxBalanceSpouse ?? null));
    setPgAcaSize(inp.acaHouseholdSize != null ? String(inp.acaHouseholdSize) : "");
    setPgBenchmark(moneyOrBlank(inp.acaBenchmarkAnnual));
    // The paste payload carries the health premium inputs
    // (health premium build); an older paste carries neither
    // and loads both blank — no premium priced, as before.
    setPgHealthAca(moneyOrBlank(inp.healthPremiumAcaAnnual ?? null));
    setPgHealthMedicare(moneyOrBlank(inp.healthPremiumMedicarePerPerson ?? null));
    // The paste payload carries the IRMAA surcharge payable
    // this year (internal review round 3 SHOULD-2); an older
    // paste carries no such key and loads it blank — no
    // payable IRMAA charged, as before.
    setPgIrmaaPayable(moneyOrBlank(inp.irmaaPayableAnnual ?? null));
    // The paste payload carries the ACA reconciliation facts
    // (S-1); an older paste carries neither and loads both
    // blank — $0 taken, no reduction, exactly as before. The
    // payload also carries the enrollment premium itself
    // (P-M3); it has no dial of its own — it rides the
    // marketplace health premium dial set just above,
    // exactly as buildPgInputs reads it (the form's one
    // dial supplies both premium facts).
    setPgAptcTaken(moneyOrBlank(inp.aptcTaken ?? null));
    setPgCoverageReduction(moneyOrBlank(inp.acaCoverageReduction ?? null));
    // The paste payload carries the December-only pricing
    // facts (S-2); an older paste carries none of them and
    // loads them all blank — no carry-in, no RMD received,
    // no dependent, exactly as before.
    setPgCarryInSt(moneyOrBlank(inp.capitalLossCarryInSt ?? null));
    setPgCarryInLt(moneyOrBlank(inp.capitalLossCarryInLt ?? null));
    setPgCarryInStWa(moneyOrBlank(inp.capitalLossCarryInStWa ?? null));
    setPgCarryInLtWa(moneyOrBlank(inp.capitalLossCarryInLtWa ?? null));
    setPgRmdReceived(moneyOrBlank(inp.rmdAlreadyReceived ?? null));
    setPgDependentMagi(moneyOrBlank(inp.dependentMagiForAca ?? null));
    // The paste payload carries the cash and Roth funding
    // draws (S-6); an older paste carries neither and loads
    // both blank — no funding counted, exactly as before.
    setPgCashDraw(moneyOrBlank(inp.cashDraw ?? null));
    setPgRothDraw(moneyOrBlank(inp.rothDraw ?? null));
    // The paste payload carries the itemized deduction
    // components (P-M2); an older paste carries none of the
    // four and loads them all blank — no itemized amounts,
    // the standard side, exactly as before. Setting them on
    // every paste also clears any stale itemized amounts
    // the form happened to hold, so a replay never prices
    // the previous form's deductions.
    setPgItemizedMortgage(moneyOrBlank(inp.itemizedMortgageInterest ?? null));
    setPgItemizedSalt(moneyOrBlank(inp.itemizedSaltPaid ?? null));
    setPgItemizedCharitable(moneyOrBlank(inp.itemizedCharitable ?? null));
    setPgItemizedOther(moneyOrBlank(inp.itemizedOther ?? null));
    // The paste payload carries the annual spending
    // (P-S2); hold it as the loaded year's spending so the
    // "enough for the year" comparison prices the figure
    // the copied year priced with, not the live record's.
    // A paste written before the payload carried it parses
    // with the figure unset, which clears any earlier hold
    // — no spending carried, the dial / record resolution
    // rules, exactly as before. The hold never writes the
    // record: the Spending dial keeps showing the record's
    // figure, and editing that dial clears the hold.
    setPgPastedSpending(inp.annualSpending);
    // The paste payload carries the gain-harvest facts
    // (P-S3); hold the pair for the loaded year — the
    // form has no harvest dial — so the loaded year
    // prices the same harvest the pasted year priced.
    // A paste written before the payload carried them
    // parses with both unset, which holds two nulls —
    // no harvest priced, exactly as before — and
    // clears any earlier hold.
    setPgPastedHarvest({
      poolAmount: inp.harvestPoolAmount ?? null,
      basisPct: inp.harvestPoolBasisPct ?? null,
    });
    // The paste payload carries the reinvested-yield fact
    // (S-3); an older paste carries no such key and loads
    // with it off — the yield counts as cash, as before.
    setPgYieldReinvested(inp.yieldReinvested === true);
    // A paste-load is the user's own typed value, not a plan
    // prefill — clear the benchmark source record (no caption).
    setPgBenchmarkLoaded(null);
    // Same for the income dials: the pasted figures are the
    // user's own values, so their provenance is "typed" — a
    // later Tax year change never re-derives over them.
    setPgIncomeSources({
      interest: { kind: "typed" },
      ordinaryDividends: { kind: "typed" },
      qualifiedDividends: { kind: "typed" },
    });
    setPgStateRate(String(inp.stateRatePct));
    setPgSoleBeneficiary(inp.spouseSoleBeneficiary);
    // The paste payload carries the reciprocal beneficiary
    // fact (N-1); an older paste carries no such key and
    // loads with it unset — not established, so the
    // spouse's RMD prices on the Uniform table, as before.
    setPgPrimarySoleBeneficiaryOfSpouse(
      inp.primarySoleBeneficiaryOfSpouse ?? null,
    );
    // Cold-AI audit fix: the paste payload now carries the
    // state of residence and the education students, so a
    // replayed paste reprices the same state layer and the
    // same credits. An older paste carries neither — the
    // flat-rate residence and no students, exactly as before.
    setPgResidence(inp.residenceState === "WA" ? "WA" : "other");
    setPgEduStudents(
      (inp.educationStudents ?? []).map((s) => ({
        expenses: fmtMoneyInput(s.expenses),
        aotcEligible: s.aotcEligible,
      })),
    );
    // A successful paste-load releases the hold.
    setPgHoldOn(false);
    setPgHeldTarget(null);
    setPgPasteError(null);
    setPgPasteLoaded(true);
  };

  const resetPlayground = () => {
    setPgConfirmReset(false);
    setPgPasteText("");
    setPgPasteError(null);
    setPgPasteLoaded(false);
    setPgYear(String(new Date().getFullYear()));
    setPgFiling("mfj");
    setPgAgeP("");
    setPgAgeS("");
    setPgMedP(null);
    setPgMedS(null);
    setPgInterest("");
    setPgOrdDiv("");
    setPgOther("");
    setPgTaxExempt("");
    setPgSsP("");
    setPgSsS("");
    setPgConversion("");
    setPgSpendingDraw("");
    setPgSold("");
    setPgBasis("");
    setPgQualDiv("");
    setPgPretax("");
    setPgPretaxSpouse("");
    setPgAcaSize("");
    setPgBenchmark("");
    // IRMAA payable this year (internal review round 3
    // SHOULD-2): Reset clears it like every other money
    // dial — the fresh snapshot below stores it blank.
    setPgIrmaaPayable("");
    // Health-premium dials (internal review round 4
    // SHOULD-2): Reset clears them like every other
    // money dial — the fresh snapshot below stores
    // both premium fields blank.
    setPgHealthAca("");
    setPgHealthMedicare("");
    setPgAptcTaken("");
    setPgCoverageReduction("");
    setPgCarryInSt("");
    setPgCarryInLt("");
    setPgCarryInStWa("");
    setPgCarryInLtWa("");
    setPgRmdReceived("");
    setPgDependentMagi("");
    setPgCashDraw("");
    setPgRothDraw("");
    setPgYieldReinvested(false);
    setPgAcaBuffer("5000");
    setPgBenchmarkLoaded(null);
    setPgIncomeSources({
      interest: null,
      ordinaryDividends: null,
      qualifiedDividends: null,
    });
    setPgStateRate("0");
    setPgResidence("other");
    // Reset clears any held paste spending (P-S2).
    setPgPastedSpending(undefined);
    // Reset clears any held harvest facts (P-S3).
    setPgPastedHarvest(undefined);
    // Itemized-deduction dials and education students
    // (internal review round 4 SHOULD-2): Reset clears
    // them like every other priced dial — the fresh
    // snapshot below stores all five blank. Blank year
    // already cleared them; Reset was missing them.
    setPgItemizedMortgage("");
    setPgItemizedSalt("");
    setPgItemizedCharitable("");
    setPgItemizedOther("");
    setPgEduStudents([]);
    setPgSoleBeneficiary(true);
    setPgPrimarySoleBeneficiaryOfSpouse(null);
    // Reset releases the hold.
    setPgHoldOn(false);
    setPgHeldTarget(null);
    // Reset also returns the projection controls to their
    // fresh defaults (the panel closes; its overrides blank).
    setPgProjOpen(false);
    setPgProjToAge("95");
    setPgProjFromAge("");
    setPgProjTaxableStart("");
    setPgProjRothStart("");
    setPgProjReturnPct("");
    setPgProjDrawMode("repeat");
    setPgProjMoneyOutKind("conversion");
    setPgProjStopKind("none");
    setPgProjStopValue("");
    setPgProjSsPClaimAge("");
    setPgProjSsSClaimAge("");
    setPgProjSsPAnnual("");
    setPgProjSsSAnnual("");
    setPgProjAcaSizeAfter("");
    setPgProjAcaStepYear("");
    setPgProjSelectedYear(null);
    setPgProjTemplate(null);
    setPgOpenSections(PG_SECTIONS_OPEN);
    // Reset also clears the REMEMBERED copy, immediately (not
    // just via the debounced save), so a reload straight after
    // confirming still opens on the blank form. The fresh
    // snapshot mirrors the dial resets above field for field.
    const fresh: PgSavedForm = {
      year: String(new Date().getFullYear()),
      filing: "mfj",
      agePrimary: "",
      ageSpouse: "",
      medicarePrimary: null,
      medicareSpouse: null,
      interest: "",
      ordinaryDividends: "",
      otherOrdinary: "",
      taxExemptInterest: "",
      ssPrimary: "",
      ssSpouse: "",
      conversion: "",
      spendingDraw: "",
      stockSold: "",
      stockBasis: "",
      qualifiedDividends: "",
      pretaxBalance: "",
      pretaxBalanceSpouse: "",
      acaHouseholdSize: "",
      acaBenchmark: "",
      healthPremiumAca: "",
      healthPremiumMedicare: "",
      irmaaPayable: "",
      aptcTaken: "",
      acaCoverageReduction: "",
      capitalLossCarryInSt: "",
      capitalLossCarryInLt: "",
      capitalLossCarryInStWa: "",
      capitalLossCarryInLtWa: "",
      rmdAlreadyReceived: "",
      dependentMagiForAca: "",
      cashDraw: "",
      rothDraw: "",
      yieldReinvested: false,
      acaBuffer: "5000",
      benchmarkSource: null,
      incomeSources: {
        interest: null,
        ordinaryDividends: null,
        qualifiedDividends: null,
      },
      stateRate: "0",
      residenceState: "other",
      itemizedMortgageInterest: "",
      itemizedSaltPaid: "",
      itemizedCharitable: "",
      itemizedOther: "",
      educationStudents: [],
      soleBeneficiary: true,
      primarySoleBeneficiaryOfSpouse: null,
      holdOn: false,
      heldTarget: null,
      projOpen: false,
      projToAge: "95",
      projFromAge: "",
      projTaxableStart: "",
      projRothStart: "",
      projReturnPct: "",
      projDrawMode: "repeat",
      projMoneyOutKind: "conversion",
      projStopKind: "none",
      projStopValue: "",
      projSsPrimaryClaimAge: "",
      projSsSpouseClaimAge: "",
      projSsPrimaryAnnual: "",
      projSsSpouseAnnual: "",
      projAcaSizeAfter: "",
      projAcaStepYear: "",
      projSelectedYear: null,
      projTemplate: null,
      openSections: PG_SECTIONS_OPEN,
      projHowOpen: false,
      groupOpen: { single: true, projection: true },
    };
    pgForceWholesaleRef.current = false;
    // Build v206 (re-audit round 4 SHOULD R4-S6): supersede
    // any remembered-form save already in flight BEFORE the
    // wholesale save below lands. Bumping the save
    // generation makes the in-flight save's remaining steps
    // (its merge, its first write, and above all its CAS
    // conflict merge-retry) refuse to write, so its
    // pre-reset dials cannot land over the defaults the
    // reset is about to store; the queued pending record is
    // dropped for the same reason — the form now equals the
    // last-synced defaults, so nothing is owed, and the
    // unmount flush must never send the pre-reset snapshot
    // either. The reset's own save runs under the NEW
    // generation, so it is not superseded by its own bump.
    // With nothing in flight the bump changes nothing: the
    // wholesale save lands exactly as before.
    pgFormSaveGenRef.current += 1;
    pgFormPendingRef.current = null;
    pgSavedJsonRef.current = JSON.stringify(fresh);
    void savePgCas(
      fresh,
      pgRevisionRef.current,
      JSON.stringify(fresh),
      true,
      pgFormSaveGenRef.current,
    );
  };

  // Playground result: the form's dials priced live through
  // the shared engine (pricePlaygroundYear in rothOptimizer.ts —
  // the same code the accuracy fixtures pin). No tax math lives
  // here: the client only parses the typed fields and renders
  // what the engine returns. Null until an age for the primary
  // is entered (the engine needs an age for the 65+ deduction
  // add-ons and the RMD clock).
  const pgAgePNum = parseIntField(pgAgeP);
  const pgAgeSNum = parseIntField(pgAgeS);
  const pgMedPEffective = pgMedP ?? (pgAgePNum != null && pgAgePNum >= 65);
  const pgMedSEffective = pgMedS ?? (pgAgeSNum != null && pgAgeSNum >= 65);
  // The one construction of the playground's engine inputs from
  // the typed dials — the readout's pricing and the bracket-fill
  // chips' solve both build from it, so they can never disagree
  // about what "everything else typed" means.
  const buildPgInputs = (conversion: number): PlaygroundYearInputs => {
    // Negative dial values clamp to 0 at this one construction,
    // so a typo'd minus can never price invisibly (a negative
    // state rate, for instance, used to price a negative state
    // tax while its row stayed hidden). The ONE exception is
    // "Other ordinary income", which keeps its sign — it can be
    // a genuine loss. A typed ACA household size of 0 or less
    // reads as blank (no ACA pricing), like an empty size dial.
    const clamp0 = (n: number) => Math.max(0, n);
    const money0 = (s: string) => clamp0(parseDollars(s) ?? 0);
    const money0OrNull = (s: string) => {
      const n = parseDollars(s);
      return n == null ? null : clamp0(n);
    };
    const acaSize = parseIntField(pgAcaSize);
    // The two marketplace premium tiers (ChatGPT SHOULD-1):
    // the walk resolves the applicable tier per walked year
    // from these, so the template carries both. The dial
    // holds the template year's own tier — the household
    // amount while both spouses are on the marketplace,
    // the single amount while exactly one is — so that
    // tier rides the dial and the other rides the record's
    // amount (the prefill source, when the record entered
    // one); with no record amount the other tier is null
    // and the walk falls back to the template's benchmark
    // for that tier's years while the term is active. A
    // typed dial overrides the record for its own tier,
    // exactly as the prefill does; the other tier still
    // reads the record, the only source that states it.
    const pgHealthAcaAmt = money0OrNull(pgHealthAca);
    const pgBothOnMarketplace =
      !pgMedPEffective && pgFiling === "mfj" && !pgMedSEffective;
    const pgOneOnMarketplace =
      !pgMedPEffective !== (pgFiling === "mfj" && !pgMedSEffective);
    const pgHealthAcaHouseholdAnnual = pgBothOnMarketplace
      ? pgHealthAcaAmt
      : (pgPrefillSource?.healthPremiumAcaHousehold ?? null);
    const pgHealthAcaSingleAnnual = pgOneOnMarketplace
      ? pgHealthAcaAmt
      : (pgPrefillSource?.healthPremiumAcaSingle ?? null);
    return {
      taxYear: parseIntField(pgYear) ?? new Date().getFullYear(),
      filingStatus: pgFiling,
      agePrimary: pgAgePNum ?? 0,
      ageSpouse: pgFiling === "mfj" ? pgAgeSNum : null,
      onMedicarePrimary: pgMedPEffective,
      onMedicareSpouse: pgFiling === "mfj" ? pgMedSEffective : false,
      interest: money0(pgInterest),
      ordinaryDividends: money0(pgOrdDiv),
      otherOrdinary: parseDollars(pgOther) ?? 0,
      taxExemptInterest: money0(pgTaxExempt),
      ssPrimary: money0(pgSsP),
      ssSpouse: pgFiling === "mfj" ? money0(pgSsS) : 0,
      conversion: clamp0(conversion),
      // The draw half of the money-out split (R3-M1):
      // ALWAYS supplied from its own dial, so the pricer
      // counts the draw as income AND as cash in — the
      // conversion above is income only. Before R3-M1
      // this construction supplied no draw at all, so a
      // draw priced through the form counted as no cash
      // in (the whole disagreement with December). Blank
      // reads $0 — no draw taken — which prices
      // bit-identically to before.
      spendingDraw: money0(pgSpendingDraw),
      stockSold: money0(pgSold),
      stockBasis: money0(pgBasis),
      qualifiedDividends: money0(pgQualDiv),
      pretaxBalance: money0OrNull(pgPretax),
      /* The spouse's balance rides its own RMD clock (the
         pricer prices it on the spouse's age and divisor) —
         the single combined balance it replaced priced the
         spouse's share on the primary's clock. MFJ only: a
         spouse balance typed under MFJ stays in the dial
         when the filing changes, and the pricer ignores it
         there (its spouse-RMD branch is gated on MFJ), so
         the adapter nulls it here to match. */
      pretaxBalanceSpouse:
        pgFiling === "mfj" ? money0OrNull(pgPretaxSpouse) : null,
      spouseSoleBeneficiary: pgSoleBeneficiary,
      // The reciprocal beneficiary fact (N-1): the fact the
      // prefill carried from the plan record, passed so the
      // spouse's RMD prices on the Joint table when the
      // record establishes the primary as the spouse's sole
      // beneficiary (and the primary is more than 10 years
      // younger). Null / false = not established — the
      // spouse's RMD prices on the Uniform table.
      primarySoleBeneficiaryOfSpouse: pgPrimarySoleBeneficiaryOfSpouse,
      acaHouseholdSize: acaSize != null && acaSize > 0 ? acaSize : null,
      acaBenchmarkAnnual: money0OrNull(pgBenchmark),
      // ACA reconciliation facts (S-1): ALWAYS supplied, so
      // the pricer prices the year's filing settlement and
      // this cash left agrees with the December view for the
      // same year. The advance credit taken and the
      // coverage-month reduction read blank as $0 (the
      // December console's own defaults); the enrollment
      // premium is the marketplace health premium dial above
      // — the same fact (the premium of the plan actually
      // enrolled in), blank = no cap, exactly as December
      // reads it.
      aptcTaken: money0(pgAptcTaken),
      acaCoverageReduction: money0(pgCoverageReduction),
      // December-only pricing facts (S-2): ALWAYS supplied,
      // so the Playground prices them the way the December
      // console does — the entering carryforward nets
      // against the year's gains through the shared loss
      // ledger, the RMD already received (already inside
      // the entered income above) is netted from the RMD
      // the pricer adds, and the dependent's MAGI joins
      // the ACA household MAGI only. Blank reads $0 on all
      // six — no carry-in, no RMD received, no dependent —
      // which prices bit-identically to before S-2.
      capitalLossCarryInSt: money0(pgCarryInSt),
      capitalLossCarryInLt: money0(pgCarryInLt),
      capitalLossCarryInStWa: money0(pgCarryInStWa),
      capitalLossCarryInLtWa: money0(pgCarryInLtWa),
      rmdAlreadyReceived: money0(pgRmdReceived),
      dependentMagiForAca: money0(pgDependentMagi),
      // Cash and Roth funding (S-6): ALWAYS supplied, so
      // the pricer counts the year's cash-sleeve and Roth
      // draws as spendable funding in cash in — their own
      // source, never income and never a taxable sale.
      // Blank reads $0 on both — no funding drawn — which
      // prices bit-identically to before S-6.
      cashDraw: money0(pgCashDraw),
      rothDraw: money0(pgRothDraw),
      // Reinvested yield (S-3): supplied exactly while the
      // dials hold a loaded saved-plan year (the flag the
      // loader set) — the pricer then keeps the year's
      // interest + dividends (the march's reinvested yield)
      // out of cash in, so the loaded year's cash left is
      // the cash the march funded. Every other state of the
      // form passes false and prices exactly as before.
      yieldReinvested: pgYieldReinvested,
      // Inflation (S-4): ALWAYS supplied — the saved plan's
      // own rate (the Tax Plan's inflation field, resolved
      // on the prefill source; the plan default 2.5 until a
      // plan rate loads) — so a future year deflates its
      // statute-fixed amounts exactly as the plan march
      // deflates them and the two agree on taxable Social
      // Security, tax, and NIIT. There is no Playground
      // dial for it: inflation lives in its home record.
      inflationPct: pgPrefillSource?.inflationPct ?? SEED_INFLATION,
      acaEnrollmentPremiumAnnual: money0OrNull(pgHealthAca),
      healthPremiumAcaAnnual: money0OrNull(pgHealthAca),
      // The two marketplace premium tiers (ChatGPT SHOULD-1):
      // the template year's own tier rides the dial above
      // and the other tier rides the record (see the
      // computation above the return).
      healthPremiumAcaHouseholdAnnual: pgHealthAcaHouseholdAnnual,
      healthPremiumAcaSingleAnnual: pgHealthAcaSingleAnnual,
      healthPremiumMedicarePerPerson: money0OrNull(pgHealthMedicare),
      irmaaPayableAnnual: money0OrNull(pgIrmaaPayable),
      stateRatePct: clamp0(parseNum(pgStateRate) ?? 0),
      residenceState: pgResidence,
      itemizedMortgageInterest: money0(pgItemizedMortgage),
      itemizedSaltPaid: money0(pgItemizedSalt),
      itemizedCharitable: money0(pgItemizedCharitable),
      itemizedOther: money0(pgItemizedOther),
      // Education students (T6): the typed rows in dollars —
      // a blank expenses row prices $0 and is inert, exactly
      // like a blank money dial; no rows = no credits.
      educationStudents:
        pgEduStudents.length === 0
          ? null
          : pgEduStudents.map((r) => ({
              expenses: money0(r.expenses),
              aotcEligible: r.aotcEligible,
            })),
      // Gain-harvest facts (P-S3): supplied ONLY from a
      // paste-load's hold — the form has no harvest dial
      // (the facts are the December console's), so every
      // other state of the form passes them absent and
      // prices no harvest, exactly as before. A held pair
      // sizes the loaded year's harvest exactly as the
      // pasted year sized it; a hold with either fact
      // null sizes none (the pricer's own both-facts
      // rule).
      harvestPoolAmount: pgPastedHarvest?.poolAmount,
      harvestPoolBasisPct: pgPastedHarvest?.basisPct,
      // Annual spending (build v126, "enough for the
      // year", live from the Spending dial in v145): the
      // one resolution (pgResolvedSpendingDollars) — a
      // paste-load's held figure (P-S2) while one is held,
      // else the field's figure when it parses to a
      // positive amount, else the resolved record figure —
      // or null when none resolves. The engine compares it
      // against the cash left after health premiums and
      // never prices it into the tax.
      annualSpending: pgResolvedSpendingDollars,
    };
  };
  const playgroundResult: PlaygroundYearResult | null = useMemo(() => {
    if (pgAgePNum == null || pgAgePNum <= 0) return null;
    return pricePlaygroundYear(buildPgInputs(parseDollars(pgConversion) ?? 0));
    // buildPgInputs is rebuilt every render from the same dial
    // state listed below; the memo keys on that state directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    pgYear, pgFiling, pgAgePNum, pgAgeSNum, pgMedPEffective, pgMedSEffective,
    pgInterest, pgOrdDiv, pgOther, pgTaxExempt, pgSsP, pgSsS, pgConversion, pgSpendingDraw,
    pgSold, pgBasis, pgQualDiv, pgPretax, pgPretaxSpouse, pgSoleBeneficiary, pgPrimarySoleBeneficiaryOfSpouse, pgAcaSize,
    pgBenchmark, pgHealthAca, pgHealthMedicare, pgIrmaaPayable, pgAptcTaken, pgCoverageReduction, pgCarryInSt, pgCarryInLt, pgCarryInStWa, pgCarryInLtWa, pgRmdReceived, pgDependentMagi, pgCashDraw, pgRothDraw, pgYieldReinvested, pgStateRate, pgResidence,
    pgItemizedMortgage, pgItemizedSalt, pgItemizedCharitable, pgItemizedOther, pgEduStudents,
    pgSpendingCents, pgPastedSpending, pgPastedHarvest, pgPrefillSource,
  ]);

  // Left after a year's spending — the play strip's second
  // figure, folded into the "At a glance" card (the strip
  // itself is gone): the cash left after health premiums
  // minus the same spending resolution the priced result —
  // and therefore the Tax-for-the-year card — reads
  // (pgResolvedSpendingDollars). S-7: the strip read the
  // SAME spending resolution the priced result reads, so
  // the card and the Tax-for-the-year card price the same
  // spending and their "Left after a year's spending"
  // figures agree to the cent. R3-M3: the base is the cash
  // left after health premiums (the priced
  // cashLeftAfterHealthPremium), because the spending
  // excludes health premiums. P-S2: while a paste-load
  // holds the pasted year's spending, that figure is the
  // resolution. Display arithmetic only, the same
  // comparison the Tax-for-the-year card carries, with the
  // same colour rule: red when the year falls short of
  // spending, teal when it covers it. The strip's names
  // are kept deliberately, so the fold reads against the
  // strip it replaces.
  const stripSpendingDollars = pgResolvedSpendingDollars;
  const stripLeftAfterSpending =
    playgroundResult != null && stripSpendingDollars != null
      ? playgroundResult.cashLeftAfterHealthPremium - stripSpendingDollars
      : null;

  // Zero-conversion pricing of the same dials — the hold
  // captions read their overage from it (display arithmetic
  // only, through the same pricePlaygroundYear the readout
  // uses). Null until an age is entered, like the readout.
  // NOTE: this pricing zeroes only the CONVERSION — the typed
  // draw still counts in it, so it is NOT a "no money out"
  // pricing (see pgZeroOutResult below).
  const pgZeroResult: PlaygroundYearResult | null = useMemo(() => {
    if (pgAgePNum == null || pgAgePNum <= 0) return null;
    return pricePlaygroundYear(buildPgInputs(0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    pgYear, pgFiling, pgAgePNum, pgAgeSNum, pgMedPEffective, pgMedSEffective,
    pgInterest, pgOrdDiv, pgOther, pgTaxExempt, pgSsP, pgSsS, pgSpendingDraw,
    pgSold, pgBasis, pgQualDiv, pgPretax, pgPretaxSpouse, pgSoleBeneficiary, pgPrimarySoleBeneficiaryOfSpouse, pgAcaSize,
    pgBenchmark, pgHealthAca, pgHealthMedicare, pgIrmaaPayable, pgAptcTaken, pgCoverageReduction, pgCarryInSt, pgCarryInLt, pgCarryInStWa, pgCarryInLtWa, pgRmdReceived, pgDependentMagi, pgCashDraw, pgRothDraw, pgYieldReinvested, pgStateRate, pgResidence,
    pgItemizedMortgage, pgItemizedSalt, pgItemizedCharitable, pgItemizedOther, pgEduStudents,
    pgSpendingCents, pgPastedSpending, pgPastedHarvest, pgPrefillSource,
  ]);

  // Zero-MONEY-OUT pricing of the same dials — conversion $0
  // AND draw $0. The can't-hold captions read their overage
  // from THIS pricing, so "past the target without any
  // pre-tax money out" is measured with no money out at all:
  // pgZeroResult zeroes only the conversion and still counts
  // the typed draw, which is how the stale caption came to
  // say "without any pre-tax money out" while the draw was
  // inside its MAGI. Display arithmetic only, through the
  // same pricePlaygroundYear. pgSpendingDraw is deliberately
  // NOT a memo key — the pricing overrides it to $0.
  const pgZeroOutResult: PlaygroundYearResult | null = useMemo(() => {
    if (pgAgePNum == null || pgAgePNum <= 0) return null;
    return pricePlaygroundYear({ ...buildPgInputs(0), spendingDraw: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    pgYear, pgFiling, pgAgePNum, pgAgeSNum, pgMedPEffective, pgMedSEffective,
    pgInterest, pgOrdDiv, pgOther, pgTaxExempt, pgSsP, pgSsS,
    pgSold, pgBasis, pgQualDiv, pgPretax, pgPretaxSpouse, pgSoleBeneficiary, pgPrimarySoleBeneficiaryOfSpouse, pgAcaSize,
    pgBenchmark, pgHealthAca, pgHealthMedicare, pgIrmaaPayable, pgAptcTaken, pgCoverageReduction, pgCarryInSt, pgCarryInLt, pgCarryInStWa, pgCarryInLtWa, pgRmdReceived, pgDependentMagi, pgCashDraw, pgRothDraw, pgYieldReinvested, pgStateRate, pgResidence,
    pgItemizedMortgage, pgItemizedSalt, pgItemizedCharitable, pgItemizedOther, pgEduStudents,
    pgSpendingCents, pgPastedSpending, pgPastedHarvest, pgPrefillSource,
  ]);

  // Bracket-fill chips: set the conversion dial to the exact
  // amount that fills the named bracket, solved through the
  // shared engine (solvePlaygroundBracketFill) against every
  // other dial as currently typed — income first, the RMD
  // first, §86 feedback included; gains don't shrink it. The
  // chips set the dial only — the dial then persists like any
  // typed value — and typing over the dial afterwards works as
  // before.
  // Tapping a chip ALSO records it as the held target — the
  // most recently tapped top — whether or not Hold is on, so
  // switching Hold on afterwards holds that top.
  const applyPgBracketFill = (bracketTopPct: number) => {
    if (pgAgePNum == null || pgAgePNum <= 0) return;
    setPgHeldTarget(bracketTopPct);
    const fill = solvePlaygroundBracketFill(buildPgInputs(0), bracketTopPct);
    setPgConversion(fmtMoneyInput(fill));
  };

  // ACA cliff chip: the same quick-set pattern aimed at the
  // ACA target instead of a bracket top — set the conversion
  // dial to the exact amount that lands the year's ACA MAGI
  // on cliff − buffer (the 400%-of-FPL cliff minus the typed
  // buffer; build v71 — Hold's "aca" target IS
  // cliff − buffer, so the chip and Hold share one target,
  // the landing the December console targets), solved
  // through the shared engine (solvePlaygroundAcaCliffFill)
  // against every other dial as currently typed, the stock
  // sale's gain included. Tapping it ALSO records "aca" as
  // the held target, exactly like a bracket chip, so Hold
  // re-solves to cliff − buffer. When the priced year has
  // no hard cliff the chip is disabled (see pgAcaCliffNote
  // below) and this never runs; the null guard is the
  // backstop.
  const applyPgAcaCliffFill = () => {
    if (pgAgePNum == null || pgAgePNum <= 0) return;
    const fill = solvePlaygroundAcaCliffFill(buildPgInputs(0), pgAcaBufferDollars);
    if (fill == null) return;
    setPgHeldTarget("aca");
    setPgConversion(fmtMoneyInput(fill));
  };

  /* The buffer (ACA buffer guide build; build v71): the
     typed buffer read as dollars — blank or negative reads
     as $0, like the money dials' clamp at buildPgInputs.
     It feeds the ACA solves — the cliff chip, Hold's "aca"
     re-solve, and the fill below all aim at cliff − buffer —
     and the play strip's landing readout; it is never an
     input to pricing. NOTE: this const is declared AFTER
     applyPgAcaCliffFill above, whose body reads it only
     when tapped (after render), never during render. */
  const pgAcaBufferDollars = Math.max(0, parseDollars(pgAcaBuffer) ?? 0);
  // "Fill conversion to cliff − buffer": the same solve the
  // ACA cliff chip performs (build v71) — it sets the
  // conversion dial so the year's priced ACA MAGI lands
  // exactly on cliff − buffer (verified against the engine
  // by the tax suite's playground-aca-buffer-fill fixtures).
  // When the year's other income already puts MAGI past the
  // line at $0 of conversion, the solve returns $0 — the dial
  // is set to $0, never negative, and the strip's readout
  // shows the year over the line. Unlike the cliff chip this
  // does NOT record a held target; it sits beside the buffer
  // field as the buffer's own one-tap fill.
  const applyPgAcaBufferFill = () => {
    if (pgAgePNum == null || pgAgePNum <= 0) return;
    const fill = solvePlaygroundAcaCliffFill(buildPgInputs(0), pgAcaBufferDollars);
    if (fill == null) return;
    setPgConversion(fmtMoneyInput(fill));
  };

  /* Hold-the-fill effect: while Hold is on and a target is
     set, ANY change to any other dial (every input that feeds
     buildPgInputs except the conversion itself) re-solves the
     pre-tax money out for the held target, so the year stays
     on that bracket top — or, for the ACA target, ACA MAGI
     stays on cliff − buffer (Hold's "aca" target IS
     cliff − buffer, build v71; the buffer dial is a trigger
     too, so editing the buffer while Hold is on re-solves to
     the new line) — and the
     stacking chart below re-renders from the same priced
     result, so the money-out segment's end stays glued to the
     held line. The solve runs in two phases over the SAME
     engine solvers the fill chips use (the tax pricing cannot
     tell the two money-out dials apart — it prices their sum):
     phase 1 solves the CONVERSION with the draw as typed,
     exactly as Hold always has. Phase 2 engages only when
     phase 1 cannot land the year on the target because the
     typed DRAW alone (with the conversion at $0) already runs
     past it, while the year with NO money out at all still has
     room: the draw is then solved down to the total money out
     that lands on the target (solved with the draw zeroed)
     and the conversion is held at $0 — Hold governs the total
     money out, not just the conversion. When the year's other
     income alone is already past the target there is no
     landing for any money out, so phase 2 never engages and
     the draw stands as typed (the can't-hold caption below
     says why). The solve is
     idempotent: solving an already-solved state returns the
     same values, and the effect only writes a dial when the
     solved value differs (by more than half a cent) from the
     dial's current value, so it cannot loop. Typing in the
     conversion dial or the draw dial releases the hold first
     (their onEdit), so this effect never fights a manual
     entry. */
  useEffect(() => {
    if (!pgHoldOn || pgHeldTarget == null) {
      setPgHoldDrawSolved(false);
      return;
    }
    if (pgAgePNum == null || pgAgePNum <= 0) return;
    // The held target picks the solver: a bracket pct re-solves
    // to that bracket top (unbuffered); "aca" re-solves to
    // cliff − buffer (a null cliff solve — the year no longer
    // has a hard cliff — leaves the dials exactly as they stand).
    const solveFor = (inp: PlaygroundYearInputs): number | null =>
      pgHeldTarget === "aca"
        ? solvePlaygroundAcaCliffFill(inp, pgAcaBufferDollars)
        : solvePlaygroundBracketFill(inp, pgHeldTarget);
    // Past-the-target test on a priced year, in the same
    // measure the can't-hold captions use: ACA MAGI past
    // cliff − buffer, or ordinary taxable income past the
    // bracket top.
    const pastTarget = (r: PlaygroundYearResult): boolean => {
      if (pgHeldTarget === "aca") {
        return (
          r.aca.cliff != null &&
          r.acaMagi > r.aca.cliff - pgAcaBufferDollars + 0.005
        );
      }
      const law = lawForYear(parseIntField(pgYear) ?? new Date().getFullYear());
      const idx = law.rates.indexOf(pgHeldTarget);
      if (idx < 0) return false;
      const top = law.brackets[pgFiling][idx];
      return (
        top != null &&
        Number.isFinite(top) &&
        r.ordinaryTaxableIncome > top + 0.005
      );
    };
    // On-the-target test on a priced year, in the same
    // measures: the landing sits within a dime UNDER the
    // target (a solver landing is exact to the cent in the
    // slope-1 case and within the search step where the §86
    // phase-in steepens the slope — never dollars under, as
    // a balance-capped landing is). It distinguishes "the
    // draw already sits at the value Hold solved it to" from
    // "capped short of the target" on the re-run a phase-2
    // draw write triggers.
    const onTarget = (r: PlaygroundYearResult): boolean => {
      if (pgHeldTarget === "aca") {
        if (r.aca.cliff == null) return false;
        const gap = r.aca.cliff - pgAcaBufferDollars - r.acaMagi;
        return gap >= -0.005 && gap <= 0.1;
      }
      const law = lawForYear(parseIntField(pgYear) ?? new Date().getFullYear());
      const idx = law.rates.indexOf(pgHeldTarget);
      if (idx < 0) return false;
      const top = law.brackets[pgFiling][idx];
      if (top == null || !Number.isFinite(top)) return false;
      const gap = top - r.ordinaryTaxableIncome;
      return gap >= -0.005 && gap <= 0.1;
    };
    const drawNow = Math.max(0, parseDollars(pgSpendingDraw) ?? 0);
    const fill = solveFor(buildPgInputs(0));
    if (fill == null) {
      setPgHoldDrawSolved(false);
      return;
    }
    let drawFill: number | null = null;
    let drawAlreadySolved = false;
    if (fill <= 0.005 && drawNow > 0) {
      // Phase 2 check: at the phase-1 solve (conversion $0,
      // draw as typed) the year is still past the target, but
      // with NO money out at all it is not — the overshoot is
      // the draw's, and cutting the draw lands the year
      // exactly on the target. OR the draw already sits at
      // the solved value: this run was re-triggered by the
      // phase-2 write itself (the draw dial is a trigger), the
      // year sits exactly on the target with the conversion
      // at $0, and the draw IS the dial Hold is solving — the
      // flag must stay set, not fall through to the phase-1
      // reset below.
      const atSolved = pricePlaygroundYear({
        ...buildPgInputs(0),
        conversion: fill,
      });
      const atZeroOut = pricePlaygroundYear({
        ...buildPgInputs(0),
        spendingDraw: 0,
      });
      if (!pastTarget(atZeroOut)) {
        const total = solveFor({ ...buildPgInputs(0), spendingDraw: 0 });
        if (total != null) {
          if (total < drawNow - 0.005 && pastTarget(atSolved)) {
            drawFill = total;
          } else if (
            Math.abs(total - drawNow) <= 0.005 &&
            Math.abs(parseDollars(pgConversion) ?? 0) <= 0.005 &&
            onTarget(atSolved)
          ) {
            drawAlreadySolved = true;
          }
        }
      }
    }
    if (drawFill != null) {
      // Phase 2: the draw carries the whole solved money out;
      // the conversion is held at $0.
      const convNow = parseDollars(pgConversion) ?? 0;
      if (Math.abs(convNow) > 0.005) {
        setPgConversion(fmtMoneyInput(0));
      }
      if (Math.abs(drawNow - drawFill) > 0.005) {
        setPgSpendingDraw(fmtMoneyInput(drawFill));
      }
      setPgHoldDrawSolved(true);
    } else if (drawAlreadySolved) {
      setPgHoldDrawSolved(true);
    } else {
      // Phase 1: the conversion solve, exactly as before.
      const current = parseDollars(pgConversion) ?? 0;
      if (Math.abs(current - fill) > 0.005) {
        setPgConversion(fmtMoneyInput(fill));
      }
      setPgHoldDrawSolved(false);
    }
    // buildPgInputs is rebuilt every render from the dial state
    // listed below; pgConversion is read for the idempotence
    // guard but deliberately NOT a trigger — a solver write
    // must not re-trigger the solve (the guard would stop it,
    // but there is nothing new to solve). pgSpendingDraw IS a
    // trigger: a phase-2 write re-runs the solve, which then
    // finds the draw already at the solved value and writes
    // nothing. pgAcaBuffer IS a
    // trigger (build v71): Hold's "aca" target is
    // cliff − buffer, so a buffer edit re-solves; for a
    // bracket target the extra solve is idempotent and the
    // guard above leaves the dial untouched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    pgHoldOn, pgHeldTarget, pgAcaBuffer,
    pgYear, pgFiling, pgAgePNum, pgAgeSNum, pgMedPEffective, pgMedSEffective,
    pgInterest, pgOrdDiv, pgOther, pgTaxExempt, pgSsP, pgSsS, pgSpendingDraw,
    pgSold, pgBasis, pgQualDiv, pgPretax, pgPretaxSpouse, pgSoleBeneficiary, pgPrimarySoleBeneficiaryOfSpouse, pgAcaSize,
    pgBenchmark, pgHealthAca, pgHealthMedicare, pgIrmaaPayable, pgAptcTaken, pgCoverageReduction, pgCarryInSt, pgCarryInLt, pgCarryInStWa, pgCarryInLtWa, pgRmdReceived, pgDependentMagi, pgCashDraw, pgRothDraw, pgYieldReinvested, pgStateRate, pgResidence,
    pgItemizedMortgage, pgItemizedSalt, pgItemizedCharitable, pgItemizedOther, pgEduStudents,
  ]);

  /* Capture the current dials as the projection template:
     the ONLY way the template changes. Called by the effect
     below when an open panel has no snapshot yet, and by the
     panel's re-run button — never as a side effect of viewing
     a year. Capturing clears the loaded-year selection,
     because the chart is about to re-base on the year above. */
  const captureProjTemplate = () => {
    if (pgAgePNum == null || pgAgePNum <= 0) return;
    setPgProjTemplate(buildPgInputs(parseDollars(pgConversion) ?? 0));
    setPgProjSelectedYear(null);
  };
  /* A panel restored open from the remembered form (or opened
     before any template existed) captures its first template
     from the dials as they stand — once. After that, only
     captureProjTemplate moves it. */
  useEffect(() => {
    if (!pgProjOpen || pgProjTemplate != null) return;
    if (pgAgePNum == null || pgAgePNum <= 0) return;
    setPgProjTemplate(buildPgInputs(parseDollars(pgConversion) ?? 0));
    // buildPgInputs is rebuilt every render from the dial
    // state; this capture runs once, when an open panel first
    // has a usable age and no template yet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pgProjOpen, pgProjTemplate, pgAgePNum]);
  /* Whether the single-year view above still shows the
     template year the projection runs from. After a bar is
     clicked (or the dials are edited) it does not — and that
     is fine, because the chart no longer follows the dials;
     the panel names the template and offers the re-run button
     instead. The comparison prices the dials and the snapshot
     through the same construction and compares the stored
     shapes, so a loaded projected year — whose Medicare
     dials carry the year's own override-or-follow-age
     resolution and whose ACA convention is the projection's
     own — compares on the dial fields only. The stored shape
     both sides are compared through is the FULL mapping
     (P-S8): every fact buildPgInputs supplies rides it, so
     a template restored from a pre-P-S8 stored blob — whose
     settlement facts, carry-ins, draws, premiums, spending,
     and harvest pair parse at their no-fact values — reads
     NOT current against dials carrying any of those facts,
     and the re-run button offers the recapture that makes
     the stored template whole. */
  const pgProjTemplateIsCurrent =
    pgProjTemplate == null
      ? true
      : pgAgePNum != null &&
        pgAgePNum > 0 &&
        JSON.stringify(
          projTemplateToStored(buildPgInputs(parseDollars(pgConversion) ?? 0)),
        ) === JSON.stringify(projTemplateToStored(pgProjTemplate));

  /* Projection — the CAPTURED template year, repeated from
     its primary age to the projection end age through
     projectPlaygroundYears (rothOptimizer.ts — the same
     pricing path as the single-year readout, so a projected
     year can never disagree with the view below beyond the
     one sanctioned ACA-convention difference the panel
     names). Computed only while the panel is open, and only
     from pgProjTemplate plus the panel's own override dials:
     the single-year dials are NOT inputs here, so loading a
     year into the view below (loadProjYear) — or editing the
     dials — leaves every bar standing. Blank override dials
     fall back to the template's figures or the saved plan's
     (claiming ages and amounts, the ACA step-down, the
     expected return, the starting balances), and each
     control's hint names its fallback, so a blank is never a
     silent $0 for a figure the plan carries. */
  const pgProjection: PlaygroundProjection | null = useMemo(() => {
    if (!pgProjOpen) return null;
    if (pgProjTemplate == null) return null;
    const template = pgProjTemplate;
    const templateAge = template.agePrimary;
    if (templateAge <= 0) return null;
    const src = pgPrefillSource;
    const intOr = (s: string, fb: number | null): number | null => {
      const n = parseIntField(s);
      return n != null ? n : fb;
    };
    const moneyOr = (s: string, fb: number | null): number | null => {
      const n = parseDollars(s);
      return n != null ? Math.max(0, n) : fb;
    };
    const toAgeRaw = parseIntField(pgProjToAge);
    const toAge =
      toAgeRaw != null
        ? Math.min(120, Math.max(templateAge, toAgeRaw))
        : Math.max(templateAge, 95);
    // Projection from age: blank = the template's own age.
    // A typed age is clamped to a plausible span; the engine
    // decides what it means (an earlier age starts the walk
    // there, a later one slices the shown years) — the clamp
    // here only keeps a typo from producing an absurd range.
    const fromAgeRaw = parseIntField(pgProjFromAge);
    const fromAge =
      fromAgeRaw != null ? Math.min(120, Math.max(0, fromAgeRaw)) : null;
    const templateSsP = Math.max(0, template.ssPrimary);
    const templateSsS = Math.max(0, template.ssSpouse);
    const ssPAnnual = moneyOr(
      pgProjSsPAnnual,
      templateSsP > 0
        ? templateSsP
        : src != null && !src.ssPrimaryNoBenefit
          ? src.ssPrimaryAnnual
          : templateSsP,
    );
    const ssSAnnual = moneyOr(
      pgProjSsSAnnual,
      templateSsS > 0
        ? templateSsS
        : src != null && !src.ssSpouseNoBenefit
          ? src.ssSpouseAnnual
          : templateSsS,
    );
    // Household-schedule dials (MULTI-STEP ACA HOUSEHOLD
    // SCHEDULE build): with BOTH dials blank the projection
    // runs the plan's own schedule verbatim — every step, not
    // just the first. Typing in either dial turns the pair
    // into a single-step override for the debate: the typed
    // value wins and the blank one falls back to the plan
    // schedule's FIRST step (year or size), exactly as the
    // old two-dial pair resolved against the old single step.
    const planSchedule = src?.acaHouseholdSchedule ?? null;
    const dialStepYear = intOr(pgProjAcaStepYear, null);
    const dialSizeAfter = intOr(pgProjAcaSizeAfter, null);
    const projSchedule =
      dialStepYear == null && dialSizeAfter == null
        ? planSchedule
        : (() => {
            const y = dialStepYear ?? planSchedule?.[0]?.fromYear ?? null;
            const s2 = dialSizeAfter ?? planSchedule?.[0]?.householdSize ?? null;
            return y != null && s2 != null
              ? [{ fromYear: y, householdSize: s2 }]
              : planSchedule;
          })();
    const returnRaw = parseNum(pgProjReturnPct);
    const returnPct =
      returnRaw != null
        ? Math.min(100, Math.max(-90, returnRaw))
        : (src?.expectedReturnPct ?? blendedExpected(STOCKS_PCT_DEFAULT));
    const stopAge =
      pgProjStopKind === "age" ? parseIntField(pgProjStopValue) : null;
    const stopFloor =
      pgProjStopKind === "floor"
        ? Math.max(0, parseDollars(pgProjStopValue) ?? 0)
        : null;
    return projectPlaygroundYears(template, {
      toAge,
      fromAge,
      ssPrimaryClaimAge: intOr(pgProjSsPClaimAge, src?.ssPrimaryStartAge ?? null),
      ssSpouseClaimAge: intOr(pgProjSsSClaimAge, src?.ssSpouseStartAge ?? null),
      ssPrimaryAnnual: ssPAnnual,
      ssSpouseAnnual: ssSAnnual,
      acaHouseholdSchedule: projSchedule,
      startTaxable: moneyOr(pgProjTaxableStart, src != null ? src.taxableStart : null),
      startRoth: moneyOr(pgProjRothStart, src != null ? src.rothStart : 0) ?? 0,
      returnPct,
      drawMode: pgProjDrawMode,
      moneyOutKind: pgProjMoneyOutKind,
      stopKind: pgProjStopKind,
      stopAge,
      stopFloor,
    });
    // The memo keys on the captured template and the panel's
    // own override dials ONLY — deliberately not on the
    // single-year dials, which loadProjYear overwrites.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    pgProjOpen, pgPrefillSource, pgProjTemplate,
    pgProjToAge, pgProjFromAge, pgProjTaxableStart, pgProjRothStart, pgProjReturnPct,
    pgProjDrawMode, pgProjMoneyOutKind, pgProjStopKind, pgProjStopValue,
    pgProjSsPClaimAge, pgProjSsSClaimAge, pgProjSsPAnnual, pgProjSsSAnnual,
    pgProjAcaSizeAfter, pgProjAcaStepYear,
  ]);

  /* Load one projected year into the single-year view: the
     year's own priced inputs become the dials — the FULL
     set the year was priced with (P-S5, parity audit) —
     and the readout below reprices them through the
     single-year path, so the loaded year agrees with the
     bar it came from (beyond the one sanctioned
     ACA-convention difference the panel names). Before
     P-S5 this loader set only a subset — year, ages,
     Social Security, money out, stock sale, pre-tax
     balances, household size — so every other dial kept
     whatever the form happened to hold: after the template
     was captured the user may have edited the dials
     freely (the panel's own design — the dials are NOT
     inputs to the projection), and clicking a bar then
     repriced the bar's year with the EDITED figures
     instead of its own (the settlement's worked example:
     interest edited from the template's figure to a much
     larger experiment repriced the loaded year with the
     experiment, its AGI higher than the bar's by the
     whole edit). The Medicare dials carry the year's own
     resolution of the tri-state: a projected flag that
     disagrees with the age rule is the override the walk
     carried (P-S4(d)) and loads as that explicit answer;
     a flag that agrees loads as follow-age (null), which
     is the rule the projection priced it by. Loading a
     year does NOT release the fill hold: the loaded dials
     are a change like any other, so with Hold on the hold
     effect re-solves the loaded year's pre-tax money out
     against the held target the moment it lands (a year
     that cannot hold the target gets the usual can't-hold
     caption instead). The raw amount the projection
     walked stays visible in the bar itself; Hold off
     loads a year untouched. It deliberately does NOT
     touch the projection template: the chart above keeps
     every bar and keeps running from its captured
     template, so any bar can be clicked in any order —
     earlier years included — and the way back to the
     template year is clicking its bar. */
  const loadProjYear = (calendarYear: number) => {
    const y = pgProjection?.years.find((yr) => yr.calendarYear === calendarYear);
    if (!y) return;
    const inp = y.inputs;
    pgForceWholesaleRef.current = true;
    const moneyOrBlank = (n: number | null | undefined) =>
      n == null ? "" : fmtMoneyInput(n);
    setPgOpenSections(PG_SECTIONS_OPEN);
    setPgYear(String(inp.taxYear));
    setPgFiling(inp.filingStatus);
    setPgAgeP(String(inp.agePrimary));
    setPgAgeS(inp.ageSpouse != null ? String(inp.ageSpouse) : "");
    // The year's Medicare resolution, as the tri-state
    // dials hold it (see the header above): an explicit
    // answer only where the year's flag disagrees with
    // its own age rule; follow-age otherwise.
    setPgMedP(
      inp.onMedicarePrimary !== (inp.agePrimary >= 65)
        ? inp.onMedicarePrimary
        : null,
    );
    setPgMedS(
      inp.ageSpouse != null &&
        inp.onMedicareSpouse !== (inp.ageSpouse >= 65)
        ? inp.onMedicareSpouse
        : null,
    );
    // Income dials (P-S5): the year's own interest, both
    // dividend dials, other ordinary income, and
    // tax-exempt interest — the figures the bar priced,
    // not whatever the form was left holding.
    setPgInterest(fmtMoneyInput(inp.interest));
    setPgOrdDiv(fmtMoneyInput(inp.ordinaryDividends));
    setPgQualDiv(fmtMoneyInput(inp.qualifiedDividends));
    setPgOther(fmtMoneyInput(inp.otherOrdinary));
    setPgTaxExempt(fmtMoneyInput(inp.taxExemptInterest));
    // The loaded figures are the year's own priced
    // figures, not a return or plan prefill — record the
    // income dials' provenance as "typed" (the paste
    // loader's reading), so a later Tax year change never
    // re-derives over them.
    setPgIncomeSources({
      interest: { kind: "typed" },
      ordinaryDividends: { kind: "typed" },
      qualifiedDividends: { kind: "typed" },
    });
    setPgSsP(fmtMoneyInput(inp.ssPrimary));
    setPgSsS(fmtMoneyInput(inp.ssSpouse));
    setPgConversion(fmtMoneyInput(inp.conversion));
    // The year's money out rides the dial its kind names
    // (R3-M1): a draw-mode year's amount is on the inputs'
    // spendingDraw, and loading only the conversion dial
    // dropped it whole — the loaded year then priced with
    // no draw at all (no income, no cash in).
    setPgSpendingDraw(fmtMoneyInput(inp.spendingDraw ?? 0));
    setPgSold(fmtMoneyInput(inp.stockSold));
    setPgBasis(fmtMoneyInput(inp.stockBasis));
    setPgPretax(inp.pretaxBalance == null ? "" : fmtMoneyInput(inp.pretaxBalance));
    setPgPretaxSpouse(
      inp.pretaxBalanceSpouse == null ? "" : fmtMoneyInput(inp.pretaxBalanceSpouse),
    );
    setPgAcaSize(
      inp.acaHouseholdSize != null ? String(inp.acaHouseholdSize) : "",
    );
    // ACA dials (P-S5): the year's benchmark, its health
    // premiums, and its filing-settlement facts. The
    // enrollment premium rides the marketplace health
    // premium dial, exactly as buildPgInputs reads it
    // (the form's one dial supplies both premium facts).
    setPgBenchmark(moneyOrBlank(inp.acaBenchmarkAnnual));
    setPgHealthAca(moneyOrBlank(inp.healthPremiumAcaAnnual ?? null));
    setPgHealthMedicare(
      moneyOrBlank(inp.healthPremiumMedicarePerPerson ?? null),
    );
    // Loading a walked year clears the IRMAA dial (internal
    // review round 3 SHOULD-2): the walk prices no payable
    // IRMAA — each walked year has its own — so a loaded
    // walked year must not carry the single year's amount.
    setPgIrmaaPayable(moneyOrBlank(inp.irmaaPayableAnnual ?? null));
    setPgAptcTaken(moneyOrBlank(inp.aptcTaken ?? null));
    setPgCoverageReduction(moneyOrBlank(inp.acaCoverageReduction ?? null));
    // The benchmark dial no longer holds a prefill pick —
    // clear its source record (no caption), as the paste
    // loader does.
    setPgBenchmarkLoaded(null);
    // December-only pricing dials (P-S5): the year's
    // ENTERING carryforward — for a projected year past
    // the first, the walk's chained ledger state
    // (P-S4(b)), not the template's original figure — the
    // RMD already received, and the dependent MAGI.
    setPgCarryInSt(moneyOrBlank(inp.capitalLossCarryInSt ?? null));
    setPgCarryInLt(moneyOrBlank(inp.capitalLossCarryInLt ?? null));
    setPgCarryInStWa(moneyOrBlank(inp.capitalLossCarryInStWa ?? null));
    setPgCarryInLtWa(moneyOrBlank(inp.capitalLossCarryInLtWa ?? null));
    setPgRmdReceived(moneyOrBlank(inp.rmdAlreadyReceived ?? null));
    setPgDependentMagi(moneyOrBlank(inp.dependentMagiForAca ?? null));
    // Funding draws (P-S5): the year's EFFECTIVE draws —
    // the walk's own per-year figures (P-S4(c): the
    // template's whole draws in the first year, the cash
    // draw $0 and the Roth draw capped at the tracked
    // Roth balance after that).
    setPgCashDraw(moneyOrBlank(inp.cashDraw ?? null));
    setPgRothDraw(moneyOrBlank(inp.rothDraw ?? null));
    // Reinvested yield (P-S5): the year's own flag, so a
    // loaded year counts its yield as cash exactly as
    // the bar's pricing did.
    setPgYieldReinvested(inp.yieldReinvested === true);
    // State and deduction dials (P-S5): the year's state
    // rate, residence, and all four itemized components,
    // plus its education students.
    setPgStateRate(String(inp.stateRatePct));
    setPgResidence(inp.residenceState === "WA" ? "WA" : "other");
    setPgItemizedMortgage(moneyOrBlank(inp.itemizedMortgageInterest ?? null));
    setPgItemizedSalt(moneyOrBlank(inp.itemizedSaltPaid ?? null));
    setPgItemizedCharitable(moneyOrBlank(inp.itemizedCharitable ?? null));
    setPgItemizedOther(moneyOrBlank(inp.itemizedOther ?? null));
    setPgEduStudents(
      (inp.educationStudents ?? []).map((s) => ({
        expenses: fmtMoneyInput(s.expenses),
        aotcEligible: s.aotcEligible,
      })),
    );
    // Beneficiary facts (P-S5): both directions, so the
    // loaded year's RMDs price on the same tables the
    // bar's did.
    setPgSoleBeneficiary(inp.spouseSoleBeneficiary);
    setPgPrimarySoleBeneficiaryOfSpouse(
      inp.primarySoleBeneficiaryOfSpouse ?? null,
    );
    // The year's own annual spending (P-S5, extending
    // P-S2's hold to this loader): held as the loaded
    // year's spending, so its "enough for the year"
    // comparison prices the figure the bar priced with.
    // A template restored from the remembered form
    // carries no spending figure (its stored shape omits
    // it) — the year's inputs then read undefined, which
    // clears any earlier hold and the dial / record
    // resolution rules, exactly as before. The hold never
    // writes the record.
    setPgPastedSpending(inp.annualSpending);
    // The year's gain-harvest facts (P-S5, extending
    // P-S3's hold to this loader): held as the loaded
    // year's pair — the form has no harvest dial — so
    // the loaded year prices the same harvest the bar
    // priced. A year whose inputs carry neither fact
    // clears any earlier hold: no harvest priced.
    setPgPastedHarvest(
      inp.harvestPoolAmount == null && inp.harvestPoolBasisPct == null
        ? undefined
        : {
            poolAmount: inp.harvestPoolAmount ?? null,
            basisPct: inp.harvestPoolBasisPct ?? null,
          },
    );
    setPgProjSelectedYear(calendarYear);
  };

  /* The qualified part of a priced year's dividend income
     (audit N-1): the plan prices the year's dividend total
     split by the household's return-derived qualified share
     (contract v138, S-1 — the share threaded through the
     priced inputs as taxableDividendQualifiedPct, clamped
     and rounded to the cent exactly as the engine splits
     it), so a prefill from a priced year loads the qualified
     dial at that share of the total, NOT the total itself —
     copying the total into both dials claimed 100% qualified
     and left $0 non-qualified, a pair the pair check could
     never flag. A null share (no stored return figures)
     falls back to the total, exactly as before, so a fresh
     plan is unchanged. */
  const pgPricedQualifiedDividends = (dividendIncome: number): number => {
    const pct = pgSavedPlanYears?.inputs.taxableDividendQualifiedPct ?? null;
    if (pct == null) return dividendIncome;
    const clamped = Math.min(100, Math.max(0, pct));
    return Math.round(((dividendIncome * clamped) / 100) * 100) / 100;
  };

  /* The ONE resolution of the three income dials for a tax
     year (yield-first, build v147; provenance contract
     v150): the return year itself takes the stored return
     figures (that year's actuals); any other year the saved
     plan prices takes the plan's priced interest and
     dividends for that year (the yield-based estimate — the
     priced dividend total is the ordinary dial, and the
     qualified dial takes the plan's own qualified share of
     it via pgPricedQualifiedDividends above, so the pair
     the pricer splits is the pair the dials load — the same
     figures "a year from my saved plan" loads); a
     year the plan does not price falls back to the return
     figures, carried forward as the estimate. The returned
     source is the provenance all three dials take: the
     return (with the record's named return year, or null
     when it never named one) or the priced year. A line the
     resolved source has not entered resolves null (the dial
     loads blank). Null overall when there is no prefill
     source to resolve from. Shared by the "Start from my
     numbers" prefill and the Tax-year re-derivation effect
     below, so the two can never resolve a year differently. */
  const resolvePgIncomeForYear = (
    year: number,
  ): {
    interest: number | null;
    qualifiedDividends: number | null;
    ordinaryDividends: number | null;
    source: PgIncomeSource;
  } | null => {
    if (!pgPrefillSource) return null;
    const pricedYear =
      pgSavedPlanYears?.years.find((y) => y.year === year) ?? null;
    if (year !== pgTaxReturnYear && pricedYear != null) {
      return {
        interest: pricedYear.detail.interestIncome,
        qualifiedDividends: pgPricedQualifiedDividends(
          pricedYear.detail.dividendIncome,
        ),
        ordinaryDividends: pricedYear.detail.dividendIncome,
        source: { kind: "plan", year },
      };
    }
    return {
      interest: pgPrefillSource.taxReturnInterest,
      qualifiedDividends: pgPrefillSource.taxReturnQualifiedDividends,
      ordinaryDividends: pgPrefillSource.taxReturnOrdinaryDividends,
      source: { kind: "return", year: pgPrefillSource.taxReturnYear },
    };
  };

  // "Start from my numbers": prefill the dials from the
  // saved plan (the working plan inputs, which already carry the
  // Net Worth-resolved balances). Ages derive from the plan's
  // birth years for the playground's chosen tax year; Social
  // Security is the plan's amount when the chosen year reaches
  // that person's claim age, else $0; the ACA size follows the
  // plan's step-down year; the benchmark keys on who is on the
  // marketplace that year (see the pick below). Interest and
  // the two dividend dials resolve for the CHOSEN tax year
  // through resolvePgIncomeForYear above (build v147), and
  // the resolution's source is recorded as the dials'
  // provenance (build v150), so each dial's hint can say
  // where its figure came from and a later Tax year change
  // re-derives the dials instead of stranding the figure.
  // Starting here never writes the plan, and editing the
  // dials never writes back — the prefilled dials simply
  // become the remembered form state, like typed values.
  const prefillPlayground = () => {
    if (!pgPrefillSource) return;
    pgForceWholesaleRef.current = true;
    // A prefill is a standalone starting point, not the
    // saved-plan-year loader: its income figures count as
    // cash in, so the S-3 reinvested-yield flag clears.
    setPgYieldReinvested(false);
    // A prefill likewise clears any held paste spending
    // (P-S2): the prefilled year's comparison resolves
    // from the record, like every other starting point.
    setPgPastedSpending(undefined);
    // A prefill likewise clears any held harvest facts
    // (P-S3): the prefilled year prices no harvest.
    setPgPastedHarvest(undefined);
    // Prefilling releases the hold.
    setPgHoldOn(false);
    setPgHeldTarget(null);
    // Unfold all five sections so the user sees everything it set.
    setPgOpenSections(PG_SECTIONS_OPEN);
    const taxYear = parseIntField(pgYear) ?? new Date().getFullYear();
    const ageP = taxYear - pgPrefillSource.birthYearPrimary;
    const ageS =
      pgPrefillSource.birthYearSpouse != null ? taxYear - pgPrefillSource.birthYearSpouse : null;
    setPgFiling(pgPrefillSource.filingStatus);
    setPgAgeP(String(ageP));
    setPgAgeS(ageS != null ? String(ageS) : "");
    setPgMedP(null);
    setPgMedS(null);
    setPgSsP(
      pgPrefillSource.ssPrimaryStartAge != null && ageP >= pgPrefillSource.ssPrimaryStartAge
        ? fmtMoneyInput(pgPrefillSource.ssPrimaryNoBenefit ? 0 : pgPrefillSource.ssPrimaryAnnual)
        : "0",
    );
    setPgSsS(
      ageS != null &&
        pgPrefillSource.ssSpouseStartAge != null &&
        ageS >= pgPrefillSource.ssSpouseStartAge
        ? fmtMoneyInput(pgPrefillSource.ssSpouseNoBenefit ? 0 : pgPrefillSource.ssSpouseAnnual)
        : "0",
    );
    const size = acaHouseholdSizeForYear(
      pgPrefillSource.acaHouseholdSize,
      pgPrefillSource.acaHouseholdSchedule,
      taxYear,
    );
    setPgAcaSize(String(size));
    // Benchmark pick keys on who is on the marketplace in the
    // chosen year (by the ages just derived), mirroring the
    // plan engine: both spouses under 65 → the family figure
    // at household 3+ (couple figure when no family figure is
    // entered), the couple figure at household 2; only ONE
    // spouse under 65 → the one-spouse figure, whatever the
    // household size. When neither is under 65 no marketplace
    // year is in view and the household-size pick stands. The
    // pick also records WHICH figure it loaded (the fallback
    // case distinctly) in pgBenchmarkLoaded, so the caption
    // under the dial can name the actual source; the record
    // is display-only and changes nothing priced.
    const primaryOnMarket = ageP < 65;
    const spouseOnMarket = ageS != null && ageS < 65;
    const benchPick: PgBenchmarkSource | null =
      primaryOnMarket !== spouseOnMarket
        ? pgPrefillSource.acaBenchmarkSingle != null
          ? { kind: "single", value: pgPrefillSource.acaBenchmarkSingle }
          : null
        : size >= 3
          ? pgPrefillSource.acaBenchmarkFamily != null
            ? { kind: "family", value: pgPrefillSource.acaBenchmarkFamily }
            : pgPrefillSource.acaBenchmarkCouple != null
              ? {
                  kind: "couple-fallback",
                  value: pgPrefillSource.acaBenchmarkCouple,
                }
              : null
          : size === 2
            ? pgPrefillSource.acaBenchmarkCouple != null
              ? { kind: "couple", value: pgPrefillSource.acaBenchmarkCouple }
              : null
            : pgPrefillSource.acaBenchmarkSingle != null
              ? { kind: "single", value: pgPrefillSource.acaBenchmarkSingle }
              : null;
    setPgBenchmark(benchPick != null ? fmtMoneyInput(benchPick.value) : "");
    setPgBenchmarkLoaded(benchPick);
    /* The march year for the chosen tax year, when the plan
       march prices it — the carry-ins below already read it,
       and the balances now do too. */
    const pgPrefillMarchYear =
      pgSavedPlanYears?.years.find((yr) => yr.year === taxYear) ?? null;
    /* The split balances, not their sum: the sum priced the
       spouse's share on the primary's RMD clock. Each side
       is blank when $0 (no balance, no RMD on that side).
       The balances are the chosen year's own prior-December
       balances off the march row when the march prices that
       year — the same figures the saved-year loader loads —
       so a future year's RMD reprices from the balance that
       year actually enters with. The prefill used to set the
       record's starting balances for every year, which
       priced a later year's RMD off a balance years out of
       date. For a year the march does not price, the
       record's starting balances are the only source and
       are used as they stand. */
    const pretaxP = pgPrefillMarchYear
      ? pgPrefillMarchYear.detail.priorPretaxPrimary
      : pgPrefillSource.pretaxStart;
    const pretaxS = pgPrefillMarchYear
      ? pgPrefillMarchYear.detail.priorPretaxSpouse
      : (pgPrefillSource.pretaxSpouseStart ?? 0);
    setPgPretax(pretaxP > 0 ? fmtMoneyInput(pretaxP) : "");
    setPgPretaxSpouse(pretaxS > 0 ? fmtMoneyInput(pretaxS) : "");
    setPgStateRate(String(pgPrefillSource.stateRatePct));
    setPgResidence(pgPrefillSource.residenceState === "WA" ? "WA" : "other");
    setPgItemizedMortgage(
      pgPrefillSource.itemizedMortgageInterest != null
        ? fmtMoneyInput(pgPrefillSource.itemizedMortgageInterest)
        : "",
    );
    setPgItemizedSalt(
      pgPrefillSource.itemizedSaltPaid != null
        ? fmtMoneyInput(pgPrefillSource.itemizedSaltPaid)
        : "",
    );
    setPgItemizedCharitable(
      pgPrefillSource.itemizedCharitable != null
        ? fmtMoneyInput(pgPrefillSource.itemizedCharitable)
        : "",
    );
    setPgItemizedOther(
      pgPrefillSource.itemizedOther != null
        ? fmtMoneyInput(pgPrefillSource.itemizedOther)
        : "",
    );
    /* The four record facts (P-M5, parity audit): the
       record prices other ordinary income, tax-exempt
       interest, the loss carry-ins, and the health premiums
       every year, but this prefill used to set none of their
       dials — a prefilled year priced all four at $0, so its
       AGI ran low by the other ordinary amount, its ACA MAGI
       low by that plus the tax-exempt interest, its gains
       priced gross with no §1211(b) allowance, and its cash
       left after health premiums never subtracted a premium
       the plan itself charges. (Conversion, the stock sale,
       APTC, RMD-received, dependent MAGI, and the funding
       draws stay untouched, as before: year-specific choices
       with no record source.) */
    setPgOther(
      pgPrefillSource.otherOrdinary != null
        ? fmtMoneyInput(pgPrefillSource.otherOrdinary)
        : "",
    );
    setPgTaxExempt(
      pgPrefillSource.taxExemptInterest != null
        ? fmtMoneyInput(pgPrefillSource.taxExemptInterest)
        : "",
    );
    /* Carry-ins: the chosen year's OWN entering lines when
       the plan march prices that year — the record's banked
       losses enter the plan's first year and the ledger
       chains them from there, so a later year's entering
       lines are the march's, read off its detail exactly as
       the saved-year loader reads them. For a year the
       march does not price, the record's entering lines are
       the only source and are used as they stand. Blank at
       $0, like the loader's dials. */
    const carryInSt = pgPrefillMarchYear
      ? pgPrefillMarchYear.detail.lossCarryInSt
      : pgPrefillSource.capitalLossCarryInSt;
    const carryInLt = pgPrefillMarchYear
      ? pgPrefillMarchYear.detail.lossCarryInLt
      : pgPrefillSource.capitalLossCarryInLt;
    const carryInStWa = pgPrefillMarchYear
      ? pgPrefillMarchYear.detail.lossCarryInWaSt
      : pgPrefillSource.capitalLossCarryInStWa;
    const carryInLtWa = pgPrefillMarchYear
      ? pgPrefillMarchYear.detail.lossCarryInWaLt
      : pgPrefillSource.capitalLossCarryInLtWa;
    setPgCarryInSt(
      carryInSt != null && carryInSt > 0 ? fmtMoneyInput(carryInSt) : "",
    );
    setPgCarryInLt(
      carryInLt != null && carryInLt > 0 ? fmtMoneyInput(carryInLt) : "",
    );
    setPgCarryInStWa(
      carryInStWa != null && carryInStWa > 0
        ? fmtMoneyInput(carryInStWa)
        : "",
    );
    setPgCarryInLtWa(
      carryInLtWa != null && carryInLtWa > 0
        ? fmtMoneyInput(carryInLtWa)
        : "",
    );
    /* Health premiums: the marketplace dial takes the
       record's premium by the SAME who's-on-the-marketplace
       pick the benchmark above makes — the household amount
       when both spouses are on the marketplace, the single
       amount when exactly one is. When the record prices
       the premium term (any of the three amounts entered)
       but entered nothing for the tier the pick lands on,
       the dial falls back to the loaded benchmark — the
       march's own fallback for a null tier amount. When
       neither spouse is on the marketplace, or the record
       entered no premium term at all, the dial stays blank
       and the year prices $0 of marketplace premium, as the
       march does. The Medicare dial takes the record's
       per-person amount as entered; the pricer counts it
       per person on Medicare, so it is set whatever the
       chosen year's ages are. (The saved-year loader sets
       neither health dial — the premium pin for this build
       therefore runs against the march year's own
       healthPremiumNet, not against the loader.) */
    const healthTermActive =
      pgPrefillSource.healthPremiumAcaHousehold != null ||
      pgPrefillSource.healthPremiumAcaSingle != null ||
      pgPrefillSource.healthPremiumMedicarePerPerson != null;
    const acaPremiumPick =
      primaryOnMarket && spouseOnMarket
        ? (pgPrefillSource.healthPremiumAcaHousehold ??
          (healthTermActive ? (benchPick?.value ?? null) : null))
        : primaryOnMarket !== spouseOnMarket
          ? (pgPrefillSource.healthPremiumAcaSingle ??
            (healthTermActive ? (benchPick?.value ?? null) : null))
          : null;
    setPgHealthAca(
      acaPremiumPick != null ? fmtMoneyInput(acaPremiumPick) : "",
    );
    setPgHealthMedicare(
      pgPrefillSource.healthPremiumMedicarePerPerson != null
        ? fmtMoneyInput(pgPrefillSource.healthPremiumMedicarePerPerson)
        : "",
    );
    // The IRMAA surcharge payable this year (internal review
    // round 3 SHOULD-2) is deliberately NOT prefilled: the
    // march year's IRMAA is the surcharge the march prices
    // for that year, but the dial states the surcharge
    // actually payable — the figure on the Medicare premium
    // notice — and the prefill does not presume the two
    // agree. The user enters it from the Tax Plan view's
    // funding rows, or leaves it blank. (The saved-year
    // loader likewise carries no IRMAA fact.)
    setPgIrmaaPayable("");
    // Education students (T6): the plan's entered students
    // for the chosen tax year become this year's rows — the
    // plan's other years' entries are not this year's.
    setPgEduStudents(
      (pgPrefillSource.educationStudents ?? [])
        .filter((e) => e.year === taxYear)
        .map((e) => ({
          expenses: fmtMoneyInput(e.expenses),
          aotcEligible: e.aotcEligible,
        })),
    );
    // Tax-return actuals (1040 LINES build, yield-first
    // build v147; provenance build v150): the three
    // income dials resolve for the chosen tax year through
    // resolvePgIncomeForYear — interest ← line 2b, qualified
    // dividends ← line 3a, ordinary dividends ← the line 3b
    // TOTAL (the dial takes the total; the pricer derives
    // the non-qualified part) when the source is the return;
    // the plan's priced figures when the source is the plan.
    // The resolution's source becomes the dials' recorded
    // provenance. A line the chosen source has not entered
    // leaves its dial blank.
    const pgIncome = resolvePgIncomeForYear(taxYear);
    if (pgIncome) {
      setPgInterest(
        pgIncome.interest != null ? fmtMoneyInput(pgIncome.interest) : "",
      );
      setPgQualDiv(
        pgIncome.qualifiedDividends != null
          ? fmtMoneyInput(pgIncome.qualifiedDividends)
          : "",
      );
      setPgOrdDiv(
        pgIncome.ordinaryDividends != null
          ? fmtMoneyInput(pgIncome.ordinaryDividends)
          : "",
      );
      setPgIncomeSources({
        interest: pgIncome.source,
        ordinaryDividends: pgIncome.source,
        qualifiedDividends: pgIncome.source,
      });
    }
    setPgSoleBeneficiary(pgPrefillSource.spouseSoleBeneficiary);
    // The reciprocal beneficiary fact (N-1): the prefill
    // carries it from the plan record too, so the spouse's
    // RMD prices on the Joint table when the record
    // establishes the primary as the spouse's sole
    // beneficiary. Before N-1 this load set only the first
    // fact and the spouse's RMD priced Uniform.
    setPgPrimarySoleBeneficiaryOfSpouse(
      pgPrefillSource.primarySoleBeneficiaryOfSpouse,
    );
  };

  /* -------- Known starting points (preset cards) --------
     Three cards above the dials load a recognizable starting
     point onto the dials. Loading a preset sets DIALS ONLY —
     the same setters typing uses, so the loaded values become
     the remembered form state exactly like typed values; no
     preset ever writes the saved plan record, a scenario, or
     anything else. */

  /* The saved plan priced through the shared engine — the
     SAME construction the Conversion view prices its working
     plan with (planInputsFromSaved + compareStrategyFromSaved
     + simulateRothPlan), with the starting balances resolved
     from the latest Net Worth snapshot exactly as the prefill
     source above resolves them (a saved balance wins; the
     primary pre-tax figure is the prefill's own resolved
     total). Read-only: it prices the SAVED record as it
     stands, never the dials, and writes nothing. Null until a
     pricable saved plan exists — the same gate as the
     prefill (pgPrefillSource). */
  const pgSavedPlanYears = useMemo(() => {
    const saved = rq.data?.saved;
    if (!saved || !pgPrefillSource) return null;
    // Blank-yield fallback (contract v136, audit MUST M-1):
    // the saved record's yield fields may be blank; thread the
    // implied yields from its stored tax-return actuals over
    // the prefill's resolved taxable pool, so the plan's
    // priced years — and therefore the income dials' priced-
    // year resolution below — carry the estimate, not $0. The
    // server pricing paths thread the same derivation
    // (resolveArgsBalances), so the years priced here agree
    // with the years the Plan tab prices. The prefill's pool
    // is the plan's resolved pool — Taxable + Cash, less any
    // exclusion, the pool resolvePlanBalances assembles —
    // NOT the Taxable bucket alone (re-audit SHOULD S-1: the
    // Taxable-only pool overstated both implied yields and
    // the priced yield income drifted from the plan's,
    // growing to −$1,917.66 by 2040).
    const impliedYields = impliedYieldPctsFromTaxReturn(
      rq.data?.taxReturn ?? {
        taxReturnInterestCents: null,
        taxReturnQualifiedDividendsCents: null,
        taxReturnOrdinaryDividendsCents: null,
        taxReturnYear: null,
      },
      pgPrefillSource.taxableStart,
    );
    const inputs = planInputsFromSaved(
      {
        ...saved,
        yieldFallbackDividendPct: impliedYields.dividendYieldPct,
        yieldFallbackInterestPct: impliedYields.interestYieldPct,
        // Qualified-dividend share (contract v138, audit
        // S-1): the saved record's stored return implies the
        // share of its dividend yield income that is
        // qualified (line 3a ÷ line 3b); thread it the same
        // way, so the plan years priced here split the yield
        // exactly as the server paths price them. Null when
        // no return figures imply a share (100% qualified,
        // as before).
        qualifiedDividendSharePct: qualifiedDividendSharePctFromTaxReturn(
          rq.data?.taxReturn ?? {
            taxReturnInterestCents: null,
            taxReturnQualifiedDividendsCents: null,
            taxReturnOrdinaryDividendsCents: null,
            taxReturnYear: null,
          },
        ),
      },
      new Date().getFullYear(),
    );
    if (!inputs) return null;
    const patched = {
      ...inputs,
      pretaxStart: pgPrefillSource.pretaxStart,
      pretaxSpouseStart: pgPrefillSource.pretaxSpouseStart ?? 0,
      rothStart: pgPrefillSource.rothStart,
      taxableStart: pgPrefillSource.taxableStart,
      // The spend-from-cash sleeve, threaded the way the
      // server threads it (resolveArgsBalances) and the way
      // the Tax Plan's own local inputs thread it: on the
      // snapshot-followed path, the snapshot's Cash bucket
      // LESS the exclude-from-plan amount, floored at $0 —
      // the exclusion is taken out of the cash first, so
      // excluded money can never be spent as sleeve cash
      // (R3-S3: this construction previously threaded the
      // FULL Cash bucket, so a plan whose exclusion consumed
      // the cash priced its saved years spending from cash
      // the exclusion had already removed from the pool);
      // beside an explicit taxable balance, $0.
      spendFromCashSleeveStart:
        saved.taxableCents == null
          ? Math.max(
              0,
              (rq.data?.snapshot?.cashCents ?? 0) -
                Math.max(0, saved.taxableExcludeCents ?? 0),
            ) / 100
          : 0,
    };
    const result = simulateRothPlan(
      patched,
      compareStrategyFromSaved(saved),
    );
    return { inputs: patched, years: result.years };
    // rq.data is the planner read the prefill source already
    // keys on; pgPrefillSource carries the resolved balances.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rq.data, pgPrefillSource]);
  // The preset card's year picker preselects the first priced
  // year once the years land (and re-preselects only if the
  // chosen year falls out of the list, e.g. the plan changed).
  useEffect(() => {
    if (pgSavedPlanYears == null || pgSavedPlanYears.years.length === 0) {
      return;
    }
    if (
      pgPlanPresetYear == null ||
      !pgSavedPlanYears.years.some((y) => y.year === pgPlanPresetYear)
    ) {
      setPgPlanPresetYear(pgSavedPlanYears.years[0]?.year ?? null);
    }
  }, [pgSavedPlanYears, pgPlanPresetYear]);

  /* Income-dial re-derivation (build v150): before this
     build the three income dials kept whatever figure they
     held when the Tax year changed, so a stored return figure
     (the 2025 line 3a, say) silently priced the newly chosen
     year under a hint claiming it was the return's. Now, when
     the Tax year changes — or when the plan data the
     resolution reads first lands or changes — each income
     dial whose provenance is the return or the plan is
     re-derived for the current year through
     resolvePgIncomeForYear, the prefill's own resolution: the
     return year's actuals, else the plan's priced figure for
     the year, else the return figures carried forward (the
     dial's hint flags those as carried). A typed figure is
     NEVER overwritten. Provenance is EXPLICIT ONLY
     (re-audit NICE-TO-HAVE N-1): only a dial whose RECORDED
     kind is "return" or "plan" re-derives — the recorded
     kind governs, never the dial's value, so a typed dial
     whose value coincidentally equals the stored return
     figure stays typed and is never re-derived as
     return-sourced, and a dial with no recorded provenance
     (a form remembered before v150) is left exactly as it
     stands, whatever its value. Loaders that set
     the year and the dials together (prefill, "as filed", a
     saved-plan year, a paste) record matching provenance in
     the same act, so this effect leaves their loads
     untouched: their recorded source already IS the new
     year's resolution, and their values already match it. */
  useEffect(() => {
    if (!pgInit) return;
    if (!pgPrefillSource) return;
    if (pgIncomeLoadGuardRef.current) {
      pgIncomeLoadGuardRef.current = false;
      return;
    }
    const yearNum = parseIntField(pgYear);
    if (yearNum == null) return;
    const resolved = resolvePgIncomeForYear(yearNum);
    if (!resolved) return;
    const dials: {
      key: keyof PgIncomeSources;
      value: string;
      set: (v: string) => void;
      resolvedValue: number | null;
    }[] = [
      {
        key: "interest",
        value: pgInterest,
        set: setPgInterest,
        resolvedValue: resolved.interest,
      },
      {
        key: "ordinaryDividends",
        value: pgOrdDiv,
        set: setPgOrdDiv,
        resolvedValue: resolved.ordinaryDividends,
      },
      {
        key: "qualifiedDividends",
        value: pgQualDiv,
        set: setPgQualDiv,
        resolvedValue: resolved.qualifiedDividends,
      },
    ];
    let nextSources: PgIncomeSources | null = null;
    for (const d of dials) {
      // Explicit provenance only (re-audit NICE-TO-HAVE
      // N-1): the dial's RECORDED kind governs. There is no
      // value-based inference — a dial with no recorded
      // provenance, or a recorded "typed", is never treated
      // as return-sourced, even when its value happens to
      // equal the stored return figure exactly.
      const recorded = pgIncomeSources[d.key];
      if (recorded == null || recorded.kind === "typed") continue;
      const resolvedText =
        d.resolvedValue != null ? fmtMoneyInput(d.resolvedValue) : "";
      const sourceMatches =
        JSON.stringify(recorded) === JSON.stringify(resolved.source);
      if (sourceMatches && d.value === resolvedText) {
        // Already this year's resolution; the recorded
        // provenance already says so, so nothing is written.
        continue;
      }
      if (d.value !== resolvedText) d.set(resolvedText);
      nextSources = nextSources ?? { ...pgIncomeSources };
      nextSources[d.key] = resolved.source;
    }
    if (nextSources) setPgIncomeSources(nextSources);
    // Keyed on the year and the plan data the resolution
    // reads; the dial values and provenance it reads are the
    // current render's, which is exactly the state a year
    // change or a plan-data landing presents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pgInit, pgYear, pgPrefillSource, pgSavedPlanYears]);

  /* "My <return year> return as filed" (build v147): the
     tax year becomes the RETURN year itself and the three
     income dials take the Form 1040 figures stored on the plan
     record (lines 2b / 3a / 3b — the prefill source's
     tax-return figures, the same mapping "Start from my
     numbers" uses for the return year). The preset is named
     for the year it loads — the stored return year, or the last
     filed year when the record predates the year field — never
     for the current year: a return for the current year cannot
     have been filed yet. A partial load, like typing those
     four values: every other dial stands, and a held fill
     target is untouched — the hold effect re-solves against the
     new income exactly as it does for a typed change. A line
     the record has not entered leaves its dial blank. */
  const applyPgAsFiled = () => {
    if (!pgPrefillSource) return;
    // Only lines the record actually holds are loaded — a line
    // never entered leaves its dial exactly as it stands, so
    // the card can never blank a dial by loading nothing.
    if (
      pgPrefillSource.taxReturnInterest == null &&
      pgPrefillSource.taxReturnQualifiedDividends == null &&
      pgPrefillSource.taxReturnOrdinaryDividends == null
    ) {
      return;
    }
    pgForceWholesaleRef.current = true;
    // The filed figures are cash the household actually
    // received — never the march's reinvested yield — so
    // the S-3 flag clears on this load.
    setPgYieldReinvested(false);
    // Loading the filed year also clears any held paste
    // spending (P-S2): the form no longer holds the pasted
    // year whole, so its comparison resolves from the
    // record again.
    setPgPastedSpending(undefined);
    // The filed year likewise clears any held harvest
    // facts (P-S3): it prices no harvest.
    setPgPastedHarvest(undefined);
    // A partial load (above): when the year changes, the
    // re-derivation effect would resolve the lines this
    // preset did NOT load for the return year too — blanking
    // a dial the record never entered, against this preset's
    // contract. Arm the one-shot guard so the load stands as
    // the preset made it.
    if (String(pgTaxReturnYear) !== pgYear) {
      pgIncomeLoadGuardRef.current = true;
    }
    setPgYear(String(pgTaxReturnYear));
    if (pgPrefillSource.taxReturnInterest != null) {
      setPgInterest(fmtMoneyInput(pgPrefillSource.taxReturnInterest));
    }
    if (pgPrefillSource.taxReturnQualifiedDividends != null) {
      setPgQualDiv(
        fmtMoneyInput(pgPrefillSource.taxReturnQualifiedDividends),
      );
    }
    if (pgPrefillSource.taxReturnOrdinaryDividends != null) {
      setPgOrdDiv(fmtMoneyInput(pgPrefillSource.taxReturnOrdinaryDividends));
    }
    // The loaded lines take the return's provenance at the
    // return year just dialed (build v150), so their
    // hints say so and a later year change re-derives them
    // like any return figure; a line the record has not
    // entered keeps its dial AND its provenance, untouched.
    setPgIncomeSources((prev) => ({
      interest:
        pgPrefillSource.taxReturnInterest != null
          ? { kind: "return", year: pgPrefillSource.taxReturnYear }
          : prev.interest,
      ordinaryDividends:
        pgPrefillSource.taxReturnOrdinaryDividends != null
          ? { kind: "return", year: pgPrefillSource.taxReturnYear }
          : prev.ordinaryDividends,
      qualifiedDividends:
        pgPrefillSource.taxReturnQualifiedDividends != null
          ? { kind: "return", year: pgPrefillSource.taxReturnYear }
          : prev.qualifiedDividends,
    }));
    const loadedBits: string[] = [];
    if (pgPrefillSource.taxReturnInterest != null) {
      loadedBits.push(
        `interest ${fmtDollars(pgPrefillSource.taxReturnInterest)}`,
      );
    }
    if (pgPrefillSource.taxReturnQualifiedDividends != null) {
      loadedBits.push(
        `qualified dividends ${fmtDollars(pgPrefillSource.taxReturnQualifiedDividends)}`,
      );
    }
    if (pgPrefillSource.taxReturnOrdinaryDividends != null) {
      loadedBits.push(
        `ordinary dividends ${fmtDollars(pgPrefillSource.taxReturnOrdinaryDividends)} (the total)`,
      );
    }
    setPgPresetNote(
      `Loaded your ${pgTaxReturnYear} return as filed — ${loadedBits.join(", ")}. Every other dial is as it was.`,
    );
  };

  /* "Blank year": every single-year dial zeroed (blank = $0,
     the form's own reading) and the year reset to the current
     calendar year — a clean sheet for the One year face. Like
     Reset, it releases the hold; unlike Reset it touches
     NOTHING on the Projection face — the projection dials,
     the captured template, and the selected years all stand,
     so the projection still runs from its template. */
  const applyPgBlankYear = () => {
    pgForceWholesaleRef.current = true;
    setPgYear(String(new Date().getFullYear()));
    setPgFiling("mfj");
    setPgAgeP("");
    setPgAgeS("");
    setPgMedP(null);
    setPgMedS(null);
    setPgInterest("");
    setPgOrdDiv("");
    setPgOther("");
    setPgTaxExempt("");
    setPgSsP("");
    setPgSsS("");
    setPgConversion("");
    setPgSpendingDraw("");
    setPgSold("");
    setPgBasis("");
    setPgQualDiv("");
    setPgPretax("");
    setPgPretaxSpouse("");
    setPgAcaSize("");
    setPgBenchmark("");
    // IRMAA payable this year (internal review round 3
    // SHOULD-2): a blank year zeroes it with the other
    // single-year dials.
    setPgIrmaaPayable("");
    // Health-premium dials (internal review round 4
    // SHOULD-2): a blank year zeroes them with the
    // other single-year dials.
    setPgHealthAca("");
    setPgHealthMedicare("");
    setPgAptcTaken("");
    setPgCoverageReduction("");
    setPgCarryInSt("");
    setPgCarryInLt("");
    setPgCarryInStWa("");
    setPgCarryInLtWa("");
    setPgRmdReceived("");
    setPgDependentMagi("");
    setPgCashDraw("");
    setPgRothDraw("");
    setPgYieldReinvested(false);
    setPgAcaBuffer("5000");
    setPgBenchmarkLoaded(null);
    setPgIncomeSources({
      interest: null,
      ordinaryDividends: null,
      qualifiedDividends: null,
    });
    setPgStateRate("0");
    setPgResidence("other");
    // A blank year clears any held paste spending (P-S2).
    setPgPastedSpending(undefined);
    // A blank year clears any held harvest facts (P-S3).
    setPgPastedHarvest(undefined);
    setPgItemizedMortgage("");
    setPgItemizedSalt("");
    setPgItemizedCharitable("");
    setPgItemizedOther("");
    setPgEduStudents([]);
    setPgSoleBeneficiary(true);
    setPgPrimarySoleBeneficiaryOfSpouse(null);
    setPgHoldOn(false);
    setPgHeldTarget(null);
    setPgPresetNote(
      "Blank year loaded — every single-year dial is clear. The projection still runs from its captured template.",
    );
  };

  /* "A year from my saved plan": the chosen year's PRICED
     figures from the saved plan's own simulation become the
     dials — its calendar year, filing status and ages, its
     priced interest and dividends (the plan's dividend income
     rides the gains stack, so it loads as both the total and
     the qualified part, counted once), its other income,
     tax-exempt interest, Social Security (split by each
     person's claiming age, the plan's own rule), its priced
     conversion, its prior-Dec-31 pre-tax balance (so the RMD
     reprices from it), its ACA household size and benchmark,
     and the plan's state and itemized figures — and it
     initializes the year-specific experiment facts the plan
     does not carry (RMD already received, the ACA settlement
     facts, dependent MAGI) to $0 (R3-S4). The stock-sale
     dials clear — a plan year prices its gains through its
     draws, not a separate sale. Like loading a projected year
     from the chart, this does NOT release the fill hold: the
     loaded dials are a change like any other, and the hold
     effect re-solves against the held target. It never
     touches the projection template. */
  const loadPgSavedPlanYear = (calendarYear: number) => {
    if (pgSavedPlanYears == null) return;
    const y = pgSavedPlanYears.years.find((yr) => yr.year === calendarYear);
    if (!y) return;
    const inputs = pgSavedPlanYears.inputs;
    pgForceWholesaleRef.current = true;
    setPgOpenSections(PG_SECTIONS_OPEN);
    setPgYear(String(y.year));
    setPgFiling(y.filingStatus);
    setPgAgeP(String(y.agePrimary));
    setPgAgeS(y.ageSpouse != null ? String(y.ageSpouse) : "");
    setPgMedP(null);
    setPgMedS(null);
    setPgInterest(fmtMoneyInput(y.detail.interestIncome));
    setPgOrdDiv(fmtMoneyInput(y.detail.dividendIncome));
    // Reinvested yield (S-3): the year's interest and
    // dividends are the march's yield, which the march
    // reinvested (it counts $0 of funding there) — the flag
    // keeps that yield out of cash in, so this loaded year
    // does not count it as spendable cash on top of the
    // march-sized sales and draws loaded below.
    setPgYieldReinvested(true);
    // A saved-plan year clears any held paste spending
    // (P-S2): its comparison resolves from the record —
    // the plan's own spending is the record's figure.
    setPgPastedSpending(undefined);
    // A saved-plan year likewise clears any held harvest
    // facts (P-S3): the form prices the march year as
    // loaded, and the loader supplies no harvest facts.
    setPgPastedHarvest(undefined);
    // The qualified dial takes the plan's own qualified
    // share of the priced total (audit N-1 — see
    // pgPricedQualifiedDividends), not the total itself.
    setPgQualDiv(
      fmtMoneyInput(pgPricedQualifiedDividends(y.detail.dividendIncome)),
    );
    // The loaded figures are the plan's priced figures for
    // that year — record the provenance (build v150) so
    // the dials' hints say so and a later Tax year change
    // re-derives from there.
    setPgIncomeSources({
      interest: { kind: "plan", year: y.year },
      ordinaryDividends: { kind: "plan", year: y.year },
      qualifiedDividends: { kind: "plan", year: y.year },
    });
    setPgOther(fmtMoneyInput(y.detail.otherOrdinary));
    setPgTaxExempt(fmtMoneyInput(y.detail.taxExemptInterest));
    setPgSsP(
      fmtMoneyInput(
        inputs.ssPrimaryStartAge != null &&
          y.agePrimary >= inputs.ssPrimaryStartAge
          ? inputs.ssPrimaryAnnual
          : 0,
      ),
    );
    setPgSsS(
      fmtMoneyInput(
        y.ageSpouse != null &&
          inputs.ssSpouseStartAge != null &&
          y.ageSpouse >= inputs.ssSpouseStartAge
          ? inputs.ssSpouseAnnual
          : 0,
      ),
    );
    /* The full spending funding, not just the conversion: the
       conversion alone drops the extra pre-tax draw and the
       taxable sales that funded spending and taxes, so the
       loaded year priced $0 tax on a year the march priced
       at the cliff. The two money-out parts load on their
       OWN dials (R3-M1): the conversion on the conversion
       dial and the extra pre-tax draw — the year's draw
       for spending plus the pre-tax debit that paid that
       year's tax bill — on the draw dial. Both count as
       ordinary income, but only the draw is cash in hand;
       before R3-M1 the loader summed them onto the
       conversion dial, so the loaded year counted none of
       the draw as cash in and its cash left read low by
       the whole draw. The taxable sales are the funding's
       spending + tax sales, with the basis the proceeds
       minus the draw gain the settlement priced on those
       sales. */
    setPgConversion(fmtMoneyInput(y.conversion));
    setPgSpendingDraw(fmtMoneyInput(y.detail.extraPreTaxDraw));
    const taxableSold =
      y.funding.taxableSoldForSpending + y.funding.taxableSoldForTax;
    setPgSold(taxableSold > 0 ? fmtMoneyInput(taxableSold) : "");
    setPgBasis(
      taxableSold > 0
        ? fmtMoneyInput(taxableSold - y.detail.drawGains)
        : "",
    );
    /* Loss carryforward (follow-up #4, engines review
       round 2): the year's entering banked losses are part
       of the year's priced facts — the march netted them
       against the year's gains and claimed the §1211(b)
       allowance on the remainder — but the loader never
       copied them, so a loaded year priced its gains gross
       and its ordinary income without the allowance (on the
       settlement's worked example: AGI and ACA MAGI $3,000
       high, federal tax $360 high). The dials take the
       detail's own ledger lines: the federal totals, and
       each character's Washington-attributable portion from
       the detail's Washington carry-in lines (added by this
       build — before them the row surfaced only the part
       the year's gains absorbed, so the Washington half had
       no source and a Washington year's excise priced on
       the gross gains). Blank when the year entered with
       none, like the funding dials below. */
    setPgCarryInSt(
      y.detail.lossCarryInSt > 0
        ? fmtMoneyInput(y.detail.lossCarryInSt)
        : "",
    );
    setPgCarryInLt(
      y.detail.lossCarryInLt > 0
        ? fmtMoneyInput(y.detail.lossCarryInLt)
        : "",
    );
    setPgCarryInStWa(
      y.detail.lossCarryInWaSt > 0
        ? fmtMoneyInput(y.detail.lossCarryInWaSt)
        : "",
    );
    setPgCarryInLtWa(
      y.detail.lossCarryInWaLt > 0
        ? fmtMoneyInput(y.detail.lossCarryInWaLt)
        : "",
    );
    /* Cash and Roth funding (S-6): the march's funding
       ledger also names what the year drew from the cash
       sleeve and from Roth — spendable funding the
       Playground priced at $0 before S-6, so a loaded year
       funded those ways read short by those amounts (the
       gap the S-3 settlement named). The dials take the
       ledger's own rows, so the loaded year's cash left is
       the cash the march funded. */
    setPgCashDraw(
      y.funding.cashSpend > 0 ? fmtMoneyInput(y.funding.cashSpend) : "",
    );
    setPgRothDraw(
      y.funding.rothDraw > 0 ? fmtMoneyInput(y.funding.rothDraw) : "",
    );
    /* Year-specific experiment facts (R3-S4): the RMD
       already received, the ACA settlement facts (the
       advance credit taken and the coverage-month
       reduction), and the dependent's MAGI are facts
       about a year being EXAMINED by hand, not facts the
       saved plan carries — the march priced the year's
       whole RMD (none of it "already received"), settled
       the year's credit from its own MAGI (no advance
       taken against it, no coverage reduction), and its
       ACA household MAGI is the filers' own (no
       dependent). The dials' state surviving a Tax-year
       switch is by design, but loading a saved year is a
       new-year initialization, not a switch, so all four
       dials initialize to $0 here. Before this build the
       loader left them at whatever the previous
       experiment had typed: a stale RMD-received amount
       netted cash the plan never received out of the
       loaded year's RMD and cash in alike, a stale
       advance taken settled as a repayment against a
       credit the plan never advanced, a stale reduction
       shrank the loaded year's credit, and a stale
       dependent padded its ACA MAGI. */
    setPgRmdReceived("");
    setPgAptcTaken("");
    setPgCoverageReduction("");
    setPgDependentMagi("");
    /* The split balances, not the combined one: the combined
       balance priced the spouse's share on the primary's RMD
       clock. The primary keeps the old always-set shape; the
       spouse is blank when $0 (no spouse balance, no spouse
       RMD). */
    setPgPretax(fmtMoneyInput(y.detail.priorPretaxPrimary));
    setPgPretaxSpouse(
      y.detail.priorPretaxSpouse > 0
        ? fmtMoneyInput(y.detail.priorPretaxSpouse)
        : "",
    );
    setPgAcaSize(String(y.detail.aca.householdSize));
    setPgBenchmark(
      y.detail.aca.benchmark != null
        ? fmtMoneyInput(y.detail.aca.benchmark)
        : "",
    );
    setPgBenchmarkLoaded(null);
    setPgStateRate(String(inputs.stateRatePct));
    setPgResidence(inputs.residenceState === "WA" ? "WA" : "other");
    setPgItemizedMortgage(fmtMoneyInput(inputs.itemizedMortgageInterest ?? 0));
    setPgItemizedSalt(fmtMoneyInput(inputs.itemizedSaltPaid ?? 0));
    setPgItemizedCharitable(fmtMoneyInput(inputs.itemizedCharitable ?? 0));
    setPgItemizedOther(fmtMoneyInput(inputs.itemizedOther ?? 0));
    setPgEduStudents(
      (inputs.educationStudents ?? [])
        .filter((e) => e.year === y.year)
        .map((e) => ({
          expenses: fmtMoneyInput(e.expenses),
          aotcEligible: e.aotcEligible,
        })),
    );
    setPgSoleBeneficiary(inputs.spouseSoleBeneficiary);
    // The reciprocal beneficiary fact (N-1): the plan's
    // own inputs carry it, so a loaded year prices the
    // spouse's RMD on the same table the march priced it.
    setPgPrimarySoleBeneficiaryOfSpouse(
      inputs.primarySoleBeneficiaryOfSpouse ?? null,
    );
    setPgPresetNote(
      `Loaded ${y.year} from your saved plan — interest ${fmtDollars(y.detail.interestIncome)}, dividends ${fmtDollars(y.detail.dividendIncome)}, pre-tax out ${fmtDollars(y.conversion + y.detail.extraPreTaxDraw)} (conversion ${fmtDollars(y.conversion)} on the conversion dial, plus the year's extra draw ${fmtDollars(y.detail.extraPreTaxDraw)} — its draw for spending plus the pre-tax debit that paid that year's tax bill — on the draw dial, where it counts as cash in), priced by the plan before any dial changed. The plan reinvested that year's interest and dividends, so they are priced as income but are not counted as cash in.${y.funding.cashSpend > 0 || y.funding.rothDraw > 0 ? ` The plan funded that year with ${[y.funding.cashSpend > 0 ? `${fmtDollars(y.funding.cashSpend)} from cash` : null, y.funding.rothDraw > 0 ? `${fmtDollars(y.funding.rothDraw)} from Roth` : null].filter((s) => s != null).join(" and ")} — loaded into the funding dials in Spending below, counted as cash in but never as income.` : ""}${y.detail.lossCarryInSt + y.detail.lossCarryInLt > 0 ? ` The year began with ${fmtDollars(y.detail.lossCarryInSt + y.detail.lossCarryInLt)} of banked capital losses still unused${y.detail.lossCarryInWaSt + y.detail.lossCarryInWaLt > 0 ? ` (${fmtDollars(y.detail.lossCarryInWaSt + y.detail.lossCarryInWaLt)} of it from Washington-allocated sales)` : ""} — loaded into the loss carry-in dials under Stock sale below, so the year's gains net against them and its capital-loss allowance prices the way the plan priced them.` : ""} The RMD already received, advance credit taken, coverage reduction, and dependent MAGI dials start at $0 — the plan priced the whole year fresh, with nothing already received, taken, or settled against it. Your saved plan was not changed.`,
    );
  };

  /* Hold captions — display arithmetic ONLY, from the priced
     results above (the current-dials readout and the
     zero-money-out pricing), never a second calculator. The
     can't-hold captions render only while Hold is on with a
     target set, under the fill chips row, and they are mutually
     exclusive: past-the-target requires the zero-MONEY-OUT
     pricing (conversion $0 AND draw $0 — pgZeroOutResult) to
     already exceed the target (ordinary taxable
     income past the bracket top, or ACA MAGI past the cliff),
     while balance-capped requires it to be under the target
     with the held money out sitting exactly at the balance
     cap (balance − RMD) — its shortfall measured to the same
     target (bracket top, or the ACA target — cliff − buffer —
     minus the priced ACA MAGI). A typed
     $0 balance with income under the target lands in the capped
     case (cap $0); with no balance typed, a $0 fill from
     income alone is the past-the-target case. A year past the
     target only because of the typed DRAW is NOT a can't-hold
     case anymore: Hold solves the draw down to the target
     (see the hold effect), so no caption fires for it. */
  const pgHoldActive = pgHoldOn && pgHeldTarget != null;
  /* ACA cliff availability — the SAME applicability rule the
     chip, its disabled note, the can't-hold captions, and the
     stacking chart's cliff line all follow: the priced year's
     ACA block applies with a cliff figure AND the coverage
     year carries a hard cliff (2026+; the 2025 enhanced credit
     has none, by the engine's hasCliff rule). Read off the
     priced result, never a second calculation. */
  const pgTaxYearNum = parseIntField(pgYear) ?? new Date().getFullYear();
  const pgAcaHasHardCliff =
    pgTaxYearNum >= 2026 &&
    playgroundResult != null &&
    playgroundResult.aca.applies &&
    playgroundResult.aca.cliff != null;
  /* The held ACA target in dollars: cliff − buffer
     (build v71 — Hold's "aca" target IS cliff − buffer,
     so this is the buffered target the captions name, not
     the cliff itself; a $0 buffer makes it the cliff,
     exactly as before). */
  const pgHeldCliffDollars: number | null = (() => {
    if (pgHeldTarget !== "aca") return null;
    const cliff =
      pgZeroResult?.aca.cliff ?? playgroundResult?.aca.cliff ?? null;
    return cliff == null ? null : cliff - pgAcaBufferDollars;
  })();
  /* The held ACA target named in words, with the buffer
     figured in whenever one is set — the captions below
     read "Holding at the ACA cliff − $… buffer — $…" with
     a buffer and "Holding at the ACA cliff — $…" without
     one (every figure computed from state). */
  const pgAcaTargetPhrase =
    pgAcaBufferDollars > 0
      ? `the ACA cliff − ${fmtDollars(pgAcaBufferDollars)} buffer`
      : "the ACA cliff";
  /* Why the ACA cliff chip cannot be used right now — shown
     under the fill chips whenever an age is entered (so a year
     is priced) but the priced year has no hard cliff. Null
     whenever the chip is live. */
  const pgAcaCliffNote: string | null = (() => {
    if (playgroundResult == null || pgAcaHasHardCliff) return null;
    if (pgTaxYearNum < 2026) {
      return `No ACA cliff in ${pgTaxYearNum} — the enhanced credit has no cliff.`;
    }
    if (playgroundResult.aca.everyoneOnMedicare || !playgroundResult.aca.applies) {
      return "No ACA cliff — everyone in the household is on Medicare.";
    }
    return "Enter an ACA household size in ACA & state below to use the ACA cliff fill.";
  })();
  const pgHeldTopDollars: number | null = (() => {
    if (pgHeldTarget == null || pgHeldTarget === "aca") return null;
    const law = lawForYear(parseIntField(pgYear) ?? new Date().getFullYear());
    const idx = law.rates.indexOf(pgHeldTarget);
    if (idx < 0) return null;
    const top = law.brackets[pgFiling][idx];
    return top != null && Number.isFinite(top) ? top : null;
  })();
  const pgHoldCantCaption: string | null = (() => {
    if (!pgHoldActive || pgHeldTarget == null) return null;
    if (playgroundResult == null || pgZeroResult == null || pgZeroOutResult == null) return null;
    if (pgHeldTarget === "aca") {
      // The ACA can't-hold captions mirror the bracket ones:
      // the overage comes from the zero-MONEY-OUT pricing
      // (conversion $0 and draw $0), and
      // the cap is the typed balance after the RMD, as today.
      // Both are measured against the held target —
      // cliff − buffer (build v71) — so a year already
      // past the buffer line with nothing taken out at all,
      // or capped short of
      // it, says so; with a $0 buffer the target is the
      // cliff and the captions read exactly as before. A year
      // past the line only because of the typed draw gets NO
      // caption: Hold solves the draw down to the line (see
      // the hold effect), so there is nothing it can't hold.
      if (!pgAcaHasHardCliff) return null;
      const cliff = pgZeroResult.aca.cliff;
      if (cliff == null) return null;
      const target = cliff - pgAcaBufferDollars;
      const zeroAca = pgZeroOutResult.acaMagi;
      if (zeroAca > target + 0.005) {
        return pgAcaBufferDollars > 0
          ? `Already past ${pgAcaTargetPhrase} without any pre-tax money out — the year's other income alone is ${fmtDollars(zeroAca - target)} over that line, so Hold has no money out to solve.`
          : `Already past the ACA cliff without any pre-tax money out — the year's other income alone is ${fmtDollars(zeroAca - target)} over the ACA cliff, so Hold has no money out to solve.`;
      }
      /* The combined balance caps the fill: the money out can
         come from either spouse's account, and the RMD it is
         measured against is the total. MFJ only for the
         spouse's side (a balance typed under MFJ stays in
         the dial when the filing changes). */
      const balP = parseDollars(pgPretax);
      const balS = pgFiling === "mfj" ? parseDollars(pgPretaxSpouse) : null;
      const balRaw = balP == null && balS == null ? null : (balP ?? 0) + (balS ?? 0);
      if (balRaw != null) {
        const bal = Math.max(0, balRaw);
        const cap = Math.max(0, bal - playgroundResult.rmd);
        // The money out measured against the cap is the
        // two dials' sum (R3-M1): the draw leaves the same
        // balance the conversion does.
        const conv =
          (parseDollars(pgConversion) ?? 0) +
          (parseDollars(pgSpendingDraw) ?? 0);
        const short = target - playgroundResult.acaMagi;
        if (Math.abs(conv - cap) <= 0.01 && short > 0.5) {
          return pgAcaBufferDollars > 0
            ? `Pre-tax balance caps the fill at ${fmtDollars(cap)} — ${fmtDollars(short)} short of ${pgAcaTargetPhrase}.`
            : `Pre-tax balance caps the fill at ${fmtDollars(cap)} — ${fmtDollars(short)} short of the ACA cliff.`;
        }
      }
      return null;
    }
    if (pgHeldTopDollars == null) return null;
    const top = pgHeldTopDollars;
    const zeroOrd = pgZeroOutResult.ordinaryTaxableIncome;
    if (zeroOrd > top + 0.005) {
      return `Already past the ${pgHeldTarget}% top without any pre-tax money out — the year's other income alone is ${fmtDollars(zeroOrd - top)} over, so Hold has no money out to solve.`;
    }
    /* The combined balance caps the fill (see the ACA fill
       above — the money out can come from either spouse's
       account, and the RMD is the total). MFJ only for the
       spouse's side, as above. */
    const balP = parseDollars(pgPretax);
    const balS = pgFiling === "mfj" ? parseDollars(pgPretaxSpouse) : null;
    const balRaw = balP == null && balS == null ? null : (balP ?? 0) + (balS ?? 0);
    if (balRaw != null) {
      const bal = Math.max(0, balRaw);
      const cap = Math.max(0, bal - playgroundResult.rmd);
      // Total money out against the cap, as in the ACA
      // caption above (R3-M1).
      const conv =
        (parseDollars(pgConversion) ?? 0) +
        (parseDollars(pgSpendingDraw) ?? 0);
      const short = top - playgroundResult.ordinaryTaxableIncome;
      if (Math.abs(conv - cap) <= 0.01 && short > 0.5) {
        return `Pre-tax balance caps the fill at ${fmtDollars(cap)} — ${fmtDollars(short)} short of the ${pgHeldTarget}% top.`;
      }
    }
    return null;
  })();
  /* The held-at-the-target readout: while the ACA target
     is held (and no can't-hold caption applies — the render
     shows this only when pgHoldCantCaption is null), the
     caption names the target it is holding — cliff − buffer
     while a buffer is set (build v71), the cliff itself
     at a $0 buffer — in the same place and style as the
     can't-hold captions. */
  const pgHoldCliffCaption: string | null = (() => {
    if (!pgHoldActive || pgHeldTarget !== "aca") return null;
    if (!pgAcaHasHardCliff || pgHeldCliffDollars == null) return null;
    return `Holding at ${pgAcaTargetPhrase} — ${fmtDollars(pgHeldCliffDollars)}`;
  })();

  /* Benchmark source caption — display ONLY, rendered under
     the ACA benchmark dial in the ACA & state section. While
     the dial still holds exactly the figure the prefill loaded
     (pgBenchmarkLoaded), the caption names that plan source —
     the fallback case (couple figure standing in for a blank
     family figure) distinctly. The moment the typed value
     differs from the loaded figure the caption stops claiming
     a plan source and marks the value as the user's own typed
     value; editing back to exactly the loaded figure restores
     the source caption. With no prefill on record there is no
     caption at all. The caption reads only the dial text and
     the recorded pick — it never alters pricing, the dial's
     behaviour, the fill chips, or the paste payload. */
  const PG_BENCH_SOURCE_CAPTIONS: Record<PgBenchmarkSource["kind"], string> = {
    family: "From your plan: family benchmark",
    couple: "From your plan: couple benchmark",
    "couple-fallback": "From your plan: couple benchmark (family not set)",
    single: "From your plan: one-spouse benchmark",
  };
  const pgBenchmarkCaption: string | null = (() => {
    if (pgBenchmarkLoaded == null) return null;
    const current = parseDollars(pgBenchmark);
    /* A blank dial holds no value at all, so it gets no
       caption — "Your typed value" is only true when a
       non-null typed value is actually present. */
    if (current == null) return null;
    if (Math.abs(current - pgBenchmarkLoaded.value) < 0.005) {
      return PG_BENCH_SOURCE_CAPTIONS[pgBenchmarkLoaded.kind];
    }
    return "Your typed value";
  })();

  /* Dividend-pair guard (projection solidity check,
     2026-10-21; clamp wording contract v137) — display ONLY,
     rendered under the Qualified dividends dial in the Stock
     sale section. The Ordinary dividends dial is the TOTAL
     (Form 1040 line 3b) and the Qualified dial is a subset
     of it (line 3a), so a qualified figure above the total
     is a pair that cannot occur on a real 1099-DIV. The
     engine clamps the qualified part to the total (audit
     S-8 + S-11): on such a pair the qualified part prices
     as the total, the non-qualified part prices as $0, and
     the excess isn't counted on either stack — and this
     note makes that visible at the dials instead of letting
     the excess drop out silently. It reads the two dials
     exactly as the priced inputs clamp them (negatives to
     $0), so it appears precisely when the priced pair is
     impossible, and it never alters pricing. */
  const pgDividendPairNote: string | null = (() => {
    const total = Math.max(0, parseDollars(pgOrdDiv) ?? 0);
    const qualified = Math.max(0, parseDollars(pgQualDiv) ?? 0);
    if (qualified <= total) return null;
    return `Qualified dividends (${fmtDollars(qualified)}) can't exceed the total ordinary dividends (${fmtDollars(total)}) — the qualified figure is part of that total, so it prices as ${fmtDollars(total)}, the excess isn't counted, and the non-qualified part prices as $0.`;
  })();

  /* Section-header summaries — display ONLY, derived live from
     the dials read the way buildPgInputs reads them (money
     dials clamped at $0; a typed ACA household size of 0 or
     less reads as blank), in the Roth view's section-summary
     style: one line per section naming its main settings, so a
     folded section shows what it holds and the line updates as
     the dials change. Nothing here prices anything. */
  const pgMoneySummary = (s: string): string => {
    const d = parseDollars(s);
    return d == null ? "—" : fmtDollars(Math.max(0, d));
  };
  const pgYearSummary = [
    pgYear.trim() !== "" ? pgYear.trim() : "—",
    pgFiling === "mfj"
      ? "MFJ"
      : pgFiling === "single"
        ? "Single"
        : "Head of household",
    pgFiling === "mfj"
      ? `ages ${pgAgeP.trim() !== "" ? pgAgeP.trim() : "—"}/${pgAgeS.trim() !== "" ? pgAgeS.trim() : "—"}`
      : `age ${pgAgeP.trim() !== "" ? pgAgeP.trim() : "—"}`,
  ].join(" · ");
  const pgSsSummary = ((): string => {
    const p = parseDollars(pgSsP);
    const s = pgFiling === "mfj" ? parseDollars(pgSsS) : null;
    if (p == null && s == null) return "—";
    return fmtDollars(Math.max(0, p ?? 0) + Math.max(0, s ?? 0));
  })();
  const pgIncomeSummary = `Interest ${pgMoneySummary(pgInterest)} · Dividends ${pgMoneySummary(pgOrdDiv)} (qualified ${pgMoneySummary(pgQualDiv)}) · SS ${pgSsSummary}`;
  /* Income strip + $0 warning figures — display ONLY, derived
     from the three income dials exactly as buildPgInputs reads
     them (money dials clamped at $0; blank counts as $0). The
     year's income for the $0 check is Interest + Ordinary
     dividends ONLY: Qualified dividends are part of the
     Ordinary total (Form 1040 line 3a inside line 3b), not
     additional income, so they are never added again. */
  const pgInterestDollars = Math.max(0, parseDollars(pgInterest) ?? 0);
  const pgOrdinaryDollars = Math.max(0, parseDollars(pgOrdDiv) ?? 0);
  /* Single-year group header summary — display ONLY, derived
     live from the same dials the section summaries above read:
     the tax year, the pre-tax draw for spending, the conversion,
     and the year's income (interest + the ordinary dividends
     total, per the note above — the qualified part is inside
     that total, never added again). It rides under the group's
     title in BOTH fold states as plain text with no taps, the
     same treatment as the Retirement view's "Plan inputs"
     header summary, so a folded group still shows its
     important dials and the line updates as the dials change. */
  const pgSingleGroupSummary = [
    pgYear.trim() !== "" ? pgYear.trim() : "—",
    `draw ${pgMoneySummary(pgSpendingDraw)}`,
    `conversion ${pgMoneySummary(pgConversion)}`,
    `income ${fmtDollars(pgInterestDollars + pgOrdinaryDollars)}`,
  ].join(" · ");
  const pgYearIncomeTotal = pgInterestDollars + pgOrdinaryDollars;
  const pgIncomeIsZero = pgYearIncomeTotal === 0;
  /* Income-dial source words (build v150): each dial's
     hint and ⓘ follow its RECORDED provenance and the year
     being priced — never the blanket "stored figure from
     your return" claim the dials carried before, which
     stayed on screen even when the figure was the plan's
     estimate for another year or the user's own typing. The
     Form 1040 line lives here, as a statement of where the
     figure came from — it is no longer part of any dial's
     label. `line` is the dial's 1040 line ("2b" / "3a" /
     "3b"); `planFigure` names what the plan priced
     ("interest" / "dividends"); `extra` is a structural note
     that holds whatever the source (the ordinary dial's
     counted-once note, the qualified dial's part-of-the-
     total note). */
  const pgIncomeYearNum = parseIntField(pgYear) ?? new Date().getFullYear();
  const pgReturnPhraseFor = (year: number | null): string =>
    year != null ? `your ${year} return` : "your most recent return";
  const pgIncomeHint = (
    source: PgIncomeSource | null,
    line: string,
    planFigure: string,
    extra?: string,
  ): string | undefined => {
    const parts: string[] = [];
    if (source?.kind === "return") {
      if (pgIncomeYearNum === pgTaxReturnYear) {
        parts.push(
          `From ${pgReturnPhraseFor(source.year)}, line ${line} — that year's actual.`,
        );
      } else {
        parts.push(
          `Estimate for ${pgIncomeYearNum}, carried from ${pgReturnPhraseFor(source.year)}, line ${line} — the saved plan does not price ${pgIncomeYearNum}, so that return's actual is the estimate in use; it is not a ${pgIncomeYearNum} figure.`,
        );
      }
    } else if (source?.kind === "plan") {
      parts.push(
        `Estimate for ${source.year} from your saved plan — its priced ${planFigure} for that year, from its yield fields.`,
      );
    } else if (source?.kind === "typed") {
      parts.push(
        "Your typed figure — your current estimate for this year. Changing the Tax year won't replace it.",
      );
    } else {
      parts.push(
        `Current estimate for ${pgIncomeYearNum} — type your estimate here, or it comes from your filed return (line ${line}) or your plan's yield for that year.`,
      );
    }
    if (extra) parts.push(extra);
    return parts.length > 0 ? parts.join(" ") : undefined;
  };
  const pgIncomeInfo = (
    source: PgIncomeSource | null,
    line: string,
    planFigure: string,
    base: string,
  ): string => {
    const src =
      source?.kind === "return"
        ? pgIncomeYearNum === pgTaxReturnYear
          ? ` This figure is from ${pgReturnPhraseFor(source.year)} (line ${line}) — that year's actual.`
          : ` This figure is carried from ${pgReturnPhraseFor(source.year)} (line ${line}) as the estimate for ${pgIncomeYearNum} — the saved plan does not price ${pgIncomeYearNum}, so the return's actual is the estimate in use; it is not a ${pgIncomeYearNum} actual.`
        : source?.kind === "plan"
          ? ` This figure is your saved plan's priced ${planFigure} for ${source.year} — the yield-based estimate for that year. Changing the Tax year re-derives it for the new year.`
          : source?.kind === "typed"
            ? " This is your own figure — your current estimate for this year. Changing the Tax year never replaces it."
            : " No source is recorded for this figure yet — type your current estimate for this year here, or it comes from your plan's yield for that year.";
    return (
      base +
      src +
      ` Where this estimate can come from: your most recent filed return (line ${line}), your saved plan's yield for that year, or your own typed estimate. The "My ${pgTaxReturnYear} return as filed" preset loads the return's figures into the return year itself.`
    );
  };
  /* Typing in an income dial marks its provenance "typed"
     (build v150): from then on the year-change
     re-derivation leaves the figure alone. moneyField calls
     onEdit only from its change handler — never from its
     blur reformat and never for a programmatic set — so
     loader writes keep the provenance they record. */
  const markPgIncomeTyped = (key: keyof PgIncomeSources) => {
    setPgIncomeSources((prev) =>
      prev[key]?.kind === "typed"
        ? prev
        : { ...prev, [key]: { kind: "typed" } },
    );
    // A typed income figure is the user's own, received as
    // cash — it is no longer the loaded plan year's
    // reinvested yield, so the S-3 flag clears with the
    // first income edit.
    setPgYieldReinvested(false);
  };
  /* While Hold is engaged on the ACA cliff fill target, the
     card header's subline names the hold (2026-10-25), in
     the same muted summary text — no badge or chip. Display
     only: it reads pgHoldActive / pgHeldTarget exactly as the
     hold captions do, so toggling Hold off — or typing in the
     conversion dial, which releases the hold via its onEdit —
     removes the text, and no figure changes in any state.
     The balance is the combined pre-tax balance (primary +
     spouse), like the SS summary above. */
  const pgConversionSummary = ((): string => {
    const p = parseDollars(pgPretax);
    const s = pgFiling === "mfj" ? parseDollars(pgPretaxSpouse) : null;
    const bal = p == null && s == null ? "—" : fmtDollars(Math.max(0, p ?? 0) + Math.max(0, s ?? 0));
    // The money out is the two dials' sum (R3-M1): with a
    // draw typed the summary names the split, so the header
    // never reads the conversion alone as the whole money
    // out; with no draw it reads exactly as before.
    const drawAmt = Math.max(0, parseDollars(pgSpendingDraw) ?? 0);
    const convAmt = Math.max(0, parseDollars(pgConversion) ?? 0);
    const moneyOut =
      drawAmt > 0
        ? `${fmtDollars(drawAmt + convAmt)} (draw ${fmtDollars(drawAmt)} + conversion ${fmtDollars(convAmt)})`
        : pgMoneySummary(pgConversion);
    return `Money out ${moneyOut} · balance ${bal}${pgHoldActive && pgHeldTarget === "aca" ? " · Hold the ACA cliff" : ""}`;
  })();
  const pgStockSummary = ((): string => {
    const sold = Math.max(0, parseDollars(pgSold) ?? 0);
    if (sold <= 0) return "None";
    const basis = Math.max(0, parseDollars(pgBasis) ?? 0);
    return `Sold ${fmtDollars(sold)} · basis ${fmtDollars(basis)} · gain ${fmtDollars(sold - basis)}`;
  })();
  const pgAcaSummary = ((): string => {
    const size = parseIntField(pgAcaSize);
    const rate =
      pgResidence === "WA"
        ? "capital-gains excise"
        : `${((): string => {
            const n = parseNum(pgStateRate);
            return n == null ? "0" : String(Math.max(0, n));
          })()}%`;
    return [
      `Household ${size != null && size > 0 ? String(size) : "—"}`,
      `benchmark ${pgMoneySummary(pgBenchmark)}`,
      pgResidence === "WA" ? "Washington" : "other state",
      rate,
    ].join(" · ");
  })();
  /* The Spending dial's header summary (build v145): the
     annual spending figure the "Left after a year's spending"
     comparison prices, or "—" when none resolves. */
  const pgSpendingSummary = ((): string => {
    // The resolved figure the comparison prices (P-S2: a
    // held paste figure while one is held, else the dial /
    // record resolution) — the header names what the
    // comparison will actually run against.
    const resolved = pgResolvedSpendingDollars;
    const base = resolved != null ? `${fmtDollars(resolved)} per year` : "—";
    // Cash and Roth funding (S-6): the header names the
    // funding drawn for the year beside the spending, the
    // way the stock header names a sale.
    const cash = Math.max(0, parseDollars(pgCashDraw) ?? 0);
    const roth = Math.max(0, parseDollars(pgRothDraw) ?? 0);
    const funding = [
      cash > 0 ? `cash ${fmtDollars(cash)}` : null,
      roth > 0 ? `Roth ${fmtDollars(roth)}` : null,
    ].filter((s) => s != null);
    return funding.length > 0 ? `${base} · funded by ${funding.join(" + ")}` : base;
  })();
  /* The Projection panel's header summary, same treatment:
     the template year it runs from, the projected age window
     (the from-age when one is set, otherwise the template's
     own age, through the to-age), and the draw mode. */
  const pgProjSummary = ((): string => {
    const templateYear = pgProjTemplate?.taxYear ?? parseIntField(pgYear);
    const templateAge = pgProjTemplate?.agePrimary ?? pgAgePNum;
    const fromAge = parseIntField(pgProjFromAge) ?? templateAge;
    const toAge = parseIntField(pgProjToAge) ?? 95;
    return [
      `Template ${templateYear ?? "—"}`,
      `ages ${fromAge ?? "—"}→${toAge}`,
      pgProjDrawMode === "replace"
        ? "SS and RMDs replace the draw"
        : "draw repeats as entered",
    ].join(" · ");
  })();

  /* -------- Plain-English summary line --------
     One short headline line for the Projection face at the
     top of the view, assembled live from the current dial
     values — display ONLY, at normal text size. It reads
     the projection's setup dials and, while the panel is
     open and priced, pgProjection's own ending balances:
     which template year repeats, the age span, the return,
     and the ending balances, with the note that spending and
     taxes are not taken out. (The One year line — the year's
     tax, MAGI, and bracket landing — was dropped in the
     wall-of-text build: it duplicated the Tax for the year
     and stacks-up cards below.) The full mechanics
     (income stacking, ACA/IRMAA positions, draw modes, stop
     rules, the captured-template rule) stay in the readouts
     below and the Projection panel's collapsed "More"
     explanation — they are not repeated on the face. Nothing
     here prices anything, writes anything, or touches the
     Hold/target state. */
  const pgPlainProjSentence = ((): string => {
    const toAge = parseIntField(pgProjToAge) ?? 95;
    const fromAge = parseIntField(pgProjFromAge);
    const template = pgProjTemplate;
    const baseYear = template?.taxYear ?? pgTaxYearNum;
    const baseAge = template?.agePrimary ?? pgAgePNum;
    const startAge = fromAge ?? baseAge;
    const ageSpan =
      startAge != null
        ? ` from age ${startAge} to age ${toAge}`
        : ` to age ${toAge}`;
    const returnRaw = parseNum(pgProjReturnPct);
    const returnPct =
      returnRaw != null
        ? pgProjReturnPct.trim()
        : pgPrefillSource != null
          ? String(pgPrefillSource.expectedReturnPct)
          : null;
    const rate = returnPct != null ? ` at ${returnPct}% a year` : "";
    const head = `Your ${baseYear} template year, repeated${ageSpan}${rate}`;
    if (pgProjection != null) {
      const end = pgProjection.endBalances;
      const endTotal = (end.pretax ?? 0) + (end.taxable ?? 0) + end.roth;
      return `${head} — balances end at ${fmtDollars(endTotal)}. Spending and taxes are not taken out.`;
    }
    return `${head}. Spending and taxes are not taken out.`;
  })();

  // At a glance tiles (2026-11-09 restyle): the card's four
  // headline figures as tiles in the Spending view's Quick
  // view pattern — small-caps label on top, big figure below,
  // hairline dividers, four in one row on desktop and a 2x2
  // grid on phone. Which tiles show follows the rows they
  // replace: the two flow tiles (cash left after tax, left
  // after spending) on the One year face only, the two total
  // tiles (plan total, taxable pool) on both faces, the pool
  // tile only while an exclusion is set. The divider each
  // tile carries depends on its place among the tiles
  // actually showing — the Spending cells' border-r /
  // border-b pattern recomputed for the visible count — so
  // a face or state with fewer tiles still divides cleanly,
  // four in a row or 2x2, with no stranded cell.
  const glanceShow: boolean[] = [
    pgFace === "year",
    pgFace === "year" && stripLeftAfterSpending != null,
    pgPrefillSource != null,
    pgPrefillSource != null && pgPrefillSource.taxableExclude > 0,
  ];
  const glanceCount = glanceShow.filter(Boolean).length;
  const glanceDivider = (slot: number): string => {
    const i = glanceShow.slice(0, slot).filter(Boolean).length;
    const n = glanceCount;
    const parts = ["border-[var(--border)]"];
    if (i < n - 1) parts.push(i % 2 === 0 ? "border-r" : "sm:border-r");
    if (n > 2 && i < (n % 2 === 0 ? n - 2 : n - 1))
      parts.push("border-b", "sm:border-b-0");
    return parts.join(" ");
  };
  const glanceCellCls = (slot: number) =>
    `group relative flex flex-col p-3.5 sm:p-4 ${glanceDivider(slot)}`;
  const glanceLabelCls =
    "pr-6 text-[10.5px] leading-tight font-medium tracking-[0.02em] text-[var(--dim)] uppercase";
  const glanceFigureCls =
    "display tnum mt-1.5 text-xl leading-none font-semibold whitespace-nowrap";
  const glanceSubCls =
    "tnum mt-1.5 text-xs whitespace-nowrap text-[var(--dim)]";

  return (
    <div className="mt-5">
        <h2 className="display flex items-center gap-2 text-3xl font-semibold">
          Playground
          <ExplainerInfoTip
            id="playground.intro"
            label="about the Playground"
            align="start"
          >
            <p>
              Price one year or a projection from your own numbers — your plan is never touched.
            </p>
          </ExplainerInfoTip>
        </h2>
        {/* At a glance (wall-of-text A+B build; the play
            strip folded in 2026-11-09; tiles restyle
            2026-11-09; outer panel removed 2026-11-10 at
            the user's request): the top's headline figures
            — cash left, plan total, taxable pool — with the
            header row and the tiles grid sitting unboxed
            (no outer card panel); the tiles grid keeps its
            own border. The figures replace the plan-total
            and pool loose lines. The figures sit as four tiles in the
            Spending view's Quick view pattern, superseding
            the short-lived merged cash-left row that carried
            both flow figures on one line. The cash-left tile
            reads the same priced result the play strip
            printed (pg.cashLeftAfterTax), and the Month/Year
            pills that switch it and the left-after-spending
            tile sit in the card header — the same pills
            state the strip and the Tax-for-the-year card
            shared. The strip itself is gone — folded into
            this card (its second figure is the
            left-after-spending tile, and its conditional
            health-premium / IRMAA block rides as conditional
            rows below the tiles under the same condition, so
            no figure is lost in any state). The plan-total
            tile keeps its tap to the Tax Plan's Your money
            panel; the "Edit the exclusion in Your money"
            link shrinks to an "Edit the exclusion" caption
            inside the same tap target — the total is the
            same one the Tax Plan view carries (Pre-tax both
            spouses + taxable pool after the exclusion + Roth
            + HSA; the College / 529 and Non-Taxable buckets
            are never counted). The pool tile carries just
            the figure; the "Taxable plus Cash less the
            exclusion" explainer rides the ⓘ at its
            top-right. The card renders on both faces; the
            two flow tiles, the header pills, and the premium
            rows render on the One year face only, matching
            the strip's gate, so the Projection face shows
            the two total tiles. Display only — it reads the
            resolved sources and writes nothing. */}
        <section className="mt-4" aria-label="At a glance">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-medium tracking-wide text-[var(--dim)] uppercase">
              At a glance
            </h3>
            {pgFace === "year" && (
              <SpendPeriodPills
                perMonth={spendPerMonth}
                onChange={setSpendPerMonth}
              />
            )}
          </div>
          {glanceCount > 0 && (
            <div className="mt-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
              <div className="grid grid-cols-2 sm:grid-cols-4">
                {pgFace === "year" && (
                  <div className={glanceCellCls(0)}>
                    <p className={glanceLabelCls}>Cash left after tax</p>
                    <p className={`${glanceFigureCls} text-[var(--accent)]`}>
                      {spendPerMonth
                        ? `${fmtDollarsExact((playgroundResult?.cashLeftAfterTax ?? 0) / 12)}/mo`
                        : `${fmtDollars(playgroundResult?.cashLeftAfterTax ?? 0)}/yr`}
                    </p>
                  </div>
                )}
                {pgFace === "year" && stripLeftAfterSpending != null && (
                  <div className={glanceCellCls(1)}>
                    <p className={glanceLabelCls}>
                      Left after a {spendPerMonth ? "month" : "year"}&rsquo;s spending
                    </p>
                    <p
                      className={`${glanceFigureCls} ${stripLeftAfterSpending < 0 ? "text-[var(--bad)]" : "text-[var(--accent)]"}`}
                    >
                      {spendPerMonth
                        ? `${fmtDollarsExact(stripLeftAfterSpending / 12)}/mo`
                        : `${fmtDollars(stripLeftAfterSpending)}/yr`}
                    </p>
                  </div>
                )}
                {pgPrefillSource && onJumpToYourMoney ? (
                  <button
                    type="button"
                    aria-label={`Plan total ${fmtDollarsExact(pgPrefillSource.planTotal)} excluding 529 and Non-Taxable — go to Your money in the Tax Plan to edit the exclusion`}
                    className={`${glanceCellCls(2)} text-left`}
                    onClick={onJumpToYourMoney}
                  >
                    <p className={glanceLabelCls}>Plan total</p>
                    <p
                      className={`${glanceFigureCls} text-[var(--accent)] underline decoration-dotted underline-offset-4`}
                    >
                      {fmtDollarsExact(pgPrefillSource.planTotal)}
                    </p>
                    <p className={glanceSubCls}>(excl. 529 &amp; Non-Taxable)</p>
                    <p className={`${glanceSubCls} underline underline-offset-2`}>
                      Edit the exclusion
                    </p>
                  </button>
                ) : pgPrefillSource ? (
                  <div className={glanceCellCls(2)}>
                    <p className={glanceLabelCls}>Plan total</p>
                    <p className={`${glanceFigureCls} text-[var(--accent)]`}>
                      {fmtDollarsExact(pgPrefillSource.planTotal)}
                    </p>
                    <p className={glanceSubCls}>(excl. 529 &amp; Non-Taxable)</p>
                  </div>
                ) : null}
                {pgPrefillSource && pgPrefillSource.taxableExclude > 0 && (
                  <div className={glanceCellCls(3)}>
                    <p className={glanceLabelCls}>Taxable pool after exclusion</p>
                    <p className="display tnum mt-1.5 text-xl leading-none font-bold whitespace-nowrap text-[var(--text)]">
                      {fmtDollarsExact(pgPrefillSource.taxableStart)}
                    </p>
                    <div className="absolute top-2 right-2">
                      <InfoNote
                        text={`Taxable plus Cash (${fmtDollarsExact(pgPrefillSource.taxablePoolGross)}) less the ${fmtDollarsExact(pgPrefillSource.taxableExclude)} excluded from the plan in the Tax Plan.`}
                        ariaLabel="About the taxable pool after exclusion"
                        align="right"
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
          {pgFace === "year" &&
            playgroundResult != null &&
            (playgroundResult.healthPremiumNet > 0 ||
              playgroundResult.irmaaPayableAnnual > 0) && (
              <div className="mt-3 space-y-2">
                <>
                  {playgroundResult.healthPremiumNet > 0 && (
                    <p className="tnum flex flex-wrap items-baseline gap-x-2 text-sm">
                      <span className="text-[var(--dim)]">Health premium (net)</span>
                      <span className="text-xl font-bold">
                        {fmtDollars(playgroundResult.healthPremiumNet)}
                      </span>
                    </p>
                  )}
                  {playgroundResult.irmaaPayableAnnual > 0 && (
                    <p className="tnum flex flex-wrap items-baseline gap-x-2 text-sm">
                      <span className="text-[var(--dim)]">IRMAA payable</span>
                      <span className="text-xl font-bold">
                        {fmtDollars(playgroundResult.irmaaPayableAnnual)}
                      </span>
                    </p>
                  )}
                  <p className="tnum flex flex-wrap items-baseline gap-x-2 text-sm">
                    <span className="text-[var(--dim)]">Cash left after health premiums</span>
                    <span className="text-xl font-bold text-[var(--accent)]">
                      {fmtDollars(playgroundResult.cashLeftAfterHealthPremium)}
                    </span>
                  </p>
                </>
              </div>
            )}
        </section>
        {/* Face switch — two faces, one tool at a time. Both
            faces share the one dial state, so switching loses
            nothing and changes no value; it only chooses
            which tool is on screen. Switching to Projection
            also opens the projection panel (pgProjOpen — the
            panel's own open state), which is what makes the
            projection run; switching back leaves it open. */}
        {/* Face switch (build v67): underlined text tabs in
            the Retirement view's style, left-aligned over a
            hairline — the app's one sub-navigation language —
            instead of the former filled chips. */}
        <div
          className="mt-3 flex w-full flex-nowrap items-end border-b border-[var(--border)]"
          role="group"
          aria-label="Playground face"
        >
          <button
            type="button"
            aria-label="One year face"
            aria-pressed={pgFace === "year"}
            className={`relative px-3.5 py-2.5 text-sm whitespace-nowrap ${
              pgFace === "year"
                ? "font-semibold text-[var(--text)]"
                : "font-medium text-[var(--dim)] hover:text-[var(--accent)]"
            }`}
            onClick={() => setPgFace("year")}
          >
            {pgFace === "year" && (
              <span
                aria-hidden="true"
                className="absolute right-2 -bottom-px left-2 h-[2px] bg-[var(--accent)]"
              />
            )}
            One year
          </button>
          <button
            type="button"
            aria-label="Projection face"
            aria-pressed={pgFace === "projection"}
            className={`relative px-3.5 py-2.5 text-sm whitespace-nowrap ${
              pgFace === "projection"
                ? "font-semibold text-[var(--text)]"
                : "font-medium text-[var(--dim)] hover:text-[var(--accent)]"
            }`}
            onClick={() => {
              setPgFace("projection");
              setPgProjOpen(true);
            }}
          >
            {pgFace === "projection" && (
              <span
                aria-hidden="true"
                className="absolute right-2 -bottom-px left-2 h-[2px] bg-[var(--accent)]"
              />
            )}
            Projection
          </button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            aria-label="Start from my numbers"
            className="rounded-[var(--radius)] border border-[var(--border)] px-3.5 py-1.5 text-sm font-medium hover:text-[var(--accent)] disabled:opacity-60"
            disabled={!pgPrefillSource}
            onClick={prefillPlayground}
          >
            Start from my numbers
          </button>
          {!pgConfirmReset ? (
            <button
              type="button"
              aria-label="Reset playground"
              className="text-sm text-[var(--dim)] underline underline-offset-2 hover:text-[var(--text)]"
              onClick={() => setPgConfirmReset(true)}
            >
              Reset playground
            </button>
          ) : (
            <>
              <span className="text-sm text-[var(--bad)]">
                Reset playground? This clears every dial and the copy saved
                for next time, back to a blank form.
              </span>
              <button
                type="button"
                aria-label="Reset playground"
                className="rounded-[var(--radius)] bg-[var(--bad)] px-4 py-2 text-sm font-medium text-white"
                onClick={resetPlayground}
              >
                Reset playground
              </button>
              <button
                type="button"
                aria-label="Cancel reset"
                className="rounded-[var(--radius)] border border-[var(--border)] px-4 py-2 text-sm font-medium hover:text-[var(--accent)]"
                onClick={() => setPgConfirmReset(false)}
              >
                Cancel
              </button>
            </>
          )}
          {!pgPrefillSource && (
            <span className="text-sm text-[var(--dim)]">
              {pgPrefillBlockerName != null
                ? `“Start from my numbers” needs a pricable plan — the saved plan is missing its ${pgPrefillBlockerName}.`
                : "“Start from my numbers” needs a pricable plan."}
            </span>
          )}
        </div>
        {/* Rejected negative return actuals (contract v146,
            NICE-1): shown whenever the stored return carries
            a negative line the parse set aside, so the user
            sees why that line's dial resolves as not entered
            instead of finding a silent blank. */}
        {pgRejectedReturnActuals.length > 0 && (
          <p
            role="note"
            className="mt-3 max-w-3xl rounded-[var(--radius)] border border-[var(--warn)] bg-[var(--warn-soft)] px-3 py-2 text-sm leading-relaxed"
          >
            <strong>
              A figure on your saved return isn&rsquo;t being used.
            </strong>{" "}
            {pgRejectedReturnText}. An income line on a Form 1040
            can&rsquo;t be negative, so{" "}
            {pgRejectedReturnActuals.length === 1
              ? "it counts"
              : "each counts"}{" "}
            as not entered — its dial uses the plan&rsquo;s estimate
            where the plan prices the year, and your other return
            figures are used as stored.
          </p>
        )}
        {pgFace === "year" && (
          <>
        {/* Single-year dials (build v69): the group header is
            a plain title row — no box around the group (the
            section cards inside keep their own card treatment)
            — its explainer sentence rides the title's ⓘ, and
            the live dials summary rides under the title in
            both fold states, plain text with no taps. */}
        <section className="mt-4" aria-label="Single-year dials">
          <h3>
            <button
              type="button"
              aria-expanded={pgGroupOpen.single}
              aria-label="Single-year dials group"
              className="flex w-full items-start justify-between gap-3 pr-1 text-left"
              onClick={() => togglePgGroup("single")}
            >
              <span>
                <span className="flex items-center">
                  <span className="text-base font-semibold">
                    Single-year dials
                  </span>
                  <InfoNote
                    text="One standalone year — its income, the pre-tax money out, a stock sale, and ACA & state. These dials price the single year in the readout below."
                    ariaLabel="About the single-year dials"
                  />
                </span>
                <span className="tnum mt-0.5 block text-sm text-[var(--dim)]">
                  {pgSingleGroupSummary}
                </span>
              </span>
              <FoldChevron open={!!pgGroupOpen.single} className="mt-0.5" />
            </button>
          </h3>
        {pgGroupOpen.single && (
          <>
        {pgSectionCard("year", "The year", pgYearSummary, (
          <>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div>
            <div className="mb-1 flex items-center">
              <label
                className="block text-sm font-medium text-[var(--text)]"
                htmlFor="roth-pg-year"
              >
                Tax year
              </label>
              <InfoNote
                text="The year you're pricing. Brackets, deductions, and the ACA and IRMAA lines all come from that year's tax law."
                ariaLabel="About tax year"
              />
            </div>
            <select
              id="roth-pg-year"
              aria-label="Tax year"
              className={inputCls}
              value={pgYear}
              onChange={(e) => setPgYear(e.target.value)}
            >
              {TAX_LAW_YEARS.map((l) => (
                <option key={l.year} value={String(l.year)}>
                  {l.year}
                </option>
              ))}
              {/* A year loaded from the projection chart can
                  sit past the law table — keep it selectable
                  so the dial shows the year actually priced
                  (the hint below names the law row used). */}
              {!TAX_LAW_YEARS.some((l) => String(l.year) === pgYear) &&
                pgYear.trim() !== "" && (
                  <option value={pgYear}>{pgYear}</option>
                )}
            </select>
            <p className={hintCls}>
              {(() => {
                const dialedYear =
                  parseIntField(pgYear) ?? new Date().getFullYear();
                const lawYear = lawForYear(dialedYear).year;
                if (lawYear === dialedYear) {
                  return "Priced under that year’s law row in the app’s tax tables.";
                }
                // A year past the law table prices under the
                // newest row, with that row's fixed dollar
                // lines (the Social Security thresholds, the
                // NIIT line, the IRMAA lines) shrunk for
                // inflation at the plan's rate — the same
                // treatment the plan's own year-by-year
                // pricing uses (S-4).
                const rate =
                  playgroundResult?.inflationPct ??
                  pgPrefillSource?.inflationPct ??
                  SEED_INFLATION;
                const rateText = String(Math.round(rate * 100) / 100);
                return `No ${dialedYear} law row in the app’s tax tables yet — priced under the ${lawYear} law row, with its fixed dollar lines shrunk for inflation at your plan’s ${rateText}% — the same treatment your plan’s own pricing uses.`;
              })()}
            </p>
          </div>
          <div>
            <div className="mb-1 flex items-center">
              <label
                className="block text-sm font-medium text-[var(--text)]"
                htmlFor="roth-pg-filing"
              >
                Filing status
              </label>
              <InfoNote
                text="How the return is filed — married filing jointly, single, or head of household. It sets the bracket widths, the standard deduction, and which spouse fields apply."
                ariaLabel="About filing status"
                align="right"
              />
            </div>
            <select
              id="roth-pg-filing"
              aria-label="Filing status"
              className={inputCls}
              value={pgFiling}
              onChange={(e) => setPgFiling(e.target.value as FilingStatus)}
            >
              {(Object.keys(FILING_LABELS) as FilingStatus[]).map((k) => (
                <option key={k} value={k}>
                  {FILING_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
          {numField("Your age that year", pgAgeP, setPgAgeP, {
            hint: "Ages drive the 65+ standard-deduction add-ons and the senior deduction.",
            info: "Your age in that year. Turning 65 adds extra standard deduction, and age is what the required minimum distribution (RMD) rules key off.",
          })}
          {pgFiling === "mfj" &&
            numField("Spouse age that year", pgAgeS, setPgAgeS, {
              info: "Your spouse's age in that year. A spouse who is 65 or older adds the same extra standard deduction, counted the same way yours is.",
              infoAlign: "right",
            })}
        </div>
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
          <span className="flex items-start gap-2">
            <input
              type="checkbox"
              aria-label="You are on Medicare"
              className="mt-1 h-4 w-4"
              checked={pgMedPEffective}
              onChange={(e) => setPgMedP(e.target.checked)}
            />
            <span className="text-sm">
              On Medicare — you
              <InfoNote
                text="Medicare usually starts at 65. People on Medicare get no ACA credit; instead their income sets IRMAA surcharges on Medicare premiums two years later."
                ariaLabel="About being on Medicare"
              />
              <span className="block text-xs text-[var(--dim)]">
                Follows your age (65+) until you change it. Medicare decides
                IRMAA vs ACA below.
              </span>
            </span>
          </span>
          {pgFiling === "mfj" && (
            <span className="flex items-start gap-2">
              <input
                type="checkbox"
                aria-label="Spouse is on Medicare"
                className="mt-1 h-4 w-4"
                checked={pgMedSEffective}
                onChange={(e) => setPgMedS(e.target.checked)}
              />
              <span className="text-sm">
                On Medicare — spouse
                <InfoNote
                  text="Medicare usually starts at 65. People on Medicare get no ACA credit; instead their income sets IRMAA surcharges on Medicare premiums two years later."
                  ariaLabel="About spouse being on Medicare"
                  align="right"
                />
                <span className="block text-xs text-[var(--dim)]">
                  Follows the spouse&rsquo;s age (65+) until you change it.
                </span>
              </span>
            </span>
          )}
        </div>
          </>
        ))}

        {pgSectionCard("income", "Income for the year", pgIncomeSummary, (
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {moneyField("Interest", pgInterest, setPgInterest, {
            hint: pgIncomeHint(pgIncomeSources.interest, "2b", "interest"),
            info: pgIncomeInfo(pgIncomeSources.interest, "2b", "interest", "Interest your bank and bonds pay you during the year — savings accounts, CDs, Treasury and corporate bonds. It's taxed as ordinary income."),
            onEdit: () => markPgIncomeTyped("interest"),
          })}
          {moneyField("Ordinary dividends — total", pgOrdDiv, setPgOrdDiv, {
            hint: pgIncomeHint(pgIncomeSources.ordinaryDividends, "3b", "dividends", "It includes the qualified dividends — they are counted once, not added again."),
            info: pgIncomeInfo(pgIncomeSources.ordinaryDividends, "3b", "dividends", "All the ordinary dividends for the year — the total on Form 1040 line 3b (your 1099-DIV's total ordinary dividends). That total already includes the qualified dividends on line 3a: the qualified part is priced at the lower gains rates and the rest at ordinary rates, with the total counted once."),
            infoAlign: "right",
            onEdit: () => markPgIncomeTyped("ordinaryDividends"),
          })}
          {moneyField("Other ordinary income (wages, pension)", pgOther, setPgOther, {
            info: "Everything else taxed at the regular rates — wages, pensions, rent, and withdrawals from a traditional IRA or 401(k). It stacks on the same shelf as interest and pre-tax money out.",
          })}
          {moneyField("Tax-exempt interest", pgTaxExempt, setPgTaxExempt, {
            hint: "Not taxed itself, but counts toward MAGI, ACA income, and how much Social Security is taxed.",
            info: "Interest from municipal bonds. You pay no tax on it — but it still counts toward how much of your Social Security is taxed, and toward the ACA and IRMAA income tests. Tax-free is not invisible.",
            infoAlign: "right",
          })}
          {moneyField("Your Social Security that year", pgSsP, setPgSsP, {
            hint: "The year's total benefits. Blank counts as $0.",
            info: "Your yearly Social Security check before any tax. Up to 85% of it can be taxed, depending on your other income.",
          })}
          {pgFiling === "mfj" &&
            moneyField("Spouse Social Security that year", pgSsS, setPgSsS, {
              info: "Your spouse's yearly Social Security check before any tax. Up to 85% of it can be taxed, depending on your other income.",
              infoAlign: "right",
            })}
        </div>
        ))}

        {pgSectionCard("conversion", "Pre-tax money out", pgConversionSummary, (
          <>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {moneyField("Pre-tax draw for spending", pgSpendingDraw, setPgSpendingDraw, {
            hint: pgHoldActive && pgHoldDrawSolved && pgHeldTarget != null && (pgHeldTarget !== "aca" || pgAcaHasHardCliff)
              ? pgHeldTarget === "aca"
                ? pgHeldCliffDollars != null
                  ? `Auto — Hold solved the draw down so the money out stays at ${pgAcaTargetPhrase} — ${fmtDollars(pgHeldCliffDollars)}`
                  : "Auto — Hold solved the draw down so the money out stays at the ACA cliff"
                : `Auto — Hold solved the draw down so the money out stays at the ${pgHeldTarget}% top`
              : "Money taken out of the pre-tax account to spend this year. It is taxed the same as a conversion — and, unlike one, it is cash in hand, so it counts toward the year's cash left below.",
            info: "A distribution from your traditional IRA / 401(k) taken out to spend this year. The full amount counts as ordinary income, and because the cash is in hand it also counts in the year's cash in. A conversion moves the money to your Roth instead — the same income, but no cash in hand.",
            onEdit: () => {
              // Typing in the draw dial releases the hold,
              // exactly like typing in the conversion dial —
              // the typed value stands. (Programmatic writes
              // from the hold effect call setPgSpendingDraw
              // directly and never land here.)
              if (pgHoldOn) setPgHoldOn(false);
            },
          })}
          {moneyField("Conversion to Roth", pgConversion, setPgConversion, {
            hint: pgHoldActive && pgHeldTarget != null && (pgHeldTarget !== "aca" || pgAcaHasHardCliff)
              ? pgHeldTarget === "aca"
                ? pgHeldCliffDollars != null
                  ? `Auto — holding at ${pgAcaTargetPhrase} — ${fmtDollars(pgHeldCliffDollars)}`
                  : "Auto — holding the ACA cliff"
                : `Auto — holding the ${pgHeldTarget}% top`
              : "Money moved from the pre-tax account into your Roth this year. It counts as ordinary income — but it is not cash in hand, so it never counts toward the year's cash left.",
            info: "Money converted from your traditional IRA / 401(k) into your Roth this year. The full amount counts as ordinary income, but the money lands in the Roth — it is not cash in hand, so it never counts in the year's cash in. Money you take out to spend belongs on the draw dial beside this one.",
            onEdit: () => {
              // Typing in the conversion dial releases the
              // hold — the typed value stands. (Programmatic
              // writes from the chips / hold effect call
              // setPgConversion directly and never land here;
              // moneyField calls onEdit only from its change
              // handler, not from its blur reformat.)
              if (pgHoldOn) setPgHoldOn(false);
            },
          })}
          {moneyField("Pre-tax balance — primary (prior Dec 31)", pgPretax, setPgPretax, {
            hint: "Optional. When entered, the year's RMD is priced on this balance (Joint Life when it applies) and the pre-tax money out is checked against what's left after the RMD.",
            info: "What was in your traditional IRA / 401(k) on the prior Dec 31. Entering it lets the playground price this year's required minimum distribution (RMD) and check the pre-tax money out fits. Blank = no RMD priced.",
            infoAlign: "right",
          })}
          {pgFiling === "mfj" &&
            moneyField("Pre-tax balance — spouse (prior Dec 31)", pgPretaxSpouse, setPgPretaxSpouse, {
              hint: "Optional. When entered, the spouse's RMD is priced on this balance on the spouse's own clock — not the primary's.",
              info: "What was in your spouse's traditional IRA / 401(k) on the prior Dec 31. The spouse's required minimum distribution is priced on the spouse's own age and divisor. Blank = no spouse balance, no spouse RMD.",
              infoAlign: "right",
            })}
          {moneyField("RMD already received this year", pgRmdReceived, setPgRmdReceived, {
            hint: "The part of this year's RMD already paid — and already inside the income above. Blank = $0.",
            info: "If part of this year's required minimum distribution has already been paid, it is already counted in the income you entered above (the December console's year-to-date income includes it the same way). Enter that part here and the playground subtracts it from the RMD the balances imply, so a paid RMD is never counted twice. Blank = none received yet.",
          })}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex items-center text-sm text-[var(--dim)]">
            Fill to:
            <InfoNote
              text="Sets the conversion amount for you: exactly enough, on top of any draw you've typed, to fill this tax bracket — or, with the ACA cliff chip, to land ACA household income exactly on the ACA target: the 400% poverty-line cliff minus the buffer set in ACA & state below — given everything else you've typed. The bracket tops are the ceilings of the 10%, 12%, 22% and 24% brackets."
              ariaLabel="About fill to"
            />
          </span>
          {[10, 12, 22, 24].map((pct) => (
            <button
              key={pct}
              type="button"
              aria-label={`Fill to the top of the ${pct}% bracket`}
              className="text-sm text-[var(--dim)] underline underline-offset-2 hover:text-[var(--text)] disabled:opacity-60"
              disabled={pgAgePNum == null || pgAgePNum <= 0}
              onClick={() => applyPgBracketFill(pct)}
            >
              {pct}%
            </button>
          ))}
          <button
            type="button"
            aria-label="Fill to the ACA cliff"
            className="text-sm text-[var(--dim)] underline underline-offset-2 hover:text-[var(--text)] disabled:opacity-60"
            disabled={pgAgePNum == null || pgAgePNum <= 0 || !pgAcaHasHardCliff}
            onClick={applyPgAcaCliffFill}
          >
            ACA cliff
          </button>
          <button
            type="button"
            aria-label="Hold the fill"
            aria-pressed={pgHoldOn}
            className={pgHoldOn ? ceilChipActiveCls : ceilChipCls}
            onClick={() => setPgHoldOn((v) => !v)}
          >
            Hold{pgHoldOn && pgHeldTarget != null ? (pgHeldTarget === "aca" ? " · ACA cliff" : ` · ${pgHeldTarget}%`) : ""}
          </button>
          <span className="flex items-center text-xs text-[var(--dim)]">
            Hold keeps the fill on the tapped target as other dials change.
            <InfoNote
              text={
                pgAcaBufferDollars > 0
                  ? `With Hold on, changing any other dial re-solves the pre-tax money out so the year stays on the tapped target — a bracket top or the ACA cliff − ${fmtDollars(pgAcaBufferDollars)} buffer (the buffer set in ACA & state below; editing the buffer re-solves too). The conversion is solved first; if the draw alone would still run past the target, Hold solves the draw down too, so the total money out lands on the target. Typing in the conversion or draw dial yourself, or switching Hold off, releases it.`
                  : "With Hold on, changing any other dial re-solves the pre-tax money out so the year stays on the tapped target — a bracket top or the ACA cliff (the ACA target is the cliff minus the buffer set in ACA & state below, currently $0). The conversion is solved first; if the draw alone would still run past the target, Hold solves the draw down too, so the total money out lands on the target. Typing in the conversion or draw dial yourself, or switching Hold off, releases it."
              }
              ariaLabel="About hold the fill"
            />
          </span>
        </div>
        {pgAcaCliffNote && (
          <p className="mt-1 text-sm text-[var(--dim)]" role="note">
            {pgAcaCliffNote}
          </p>
        )}
        {pgHoldOn && pgHeldTarget == null && (
          <p className="mt-1 text-sm text-[var(--dim)]" role="note">
            Tap a fill chip to hold that target.
          </p>
        )}
        {pgHoldCantCaption && (
          <p className="mt-1 text-sm text-[var(--dim)]" role="note">
            {pgHoldCantCaption}
          </p>
        )}
        {pgHoldCliffCaption && !pgHoldCantCaption && (
          <p className="mt-1 text-sm text-[var(--dim)]" role="note">
            {pgHoldCliffCaption}
          </p>
        )}
          </>
        ))}

        {pgSectionCard("stock", "Stock sale (long-term)", pgStockSummary, (
        <>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {moneyField("Stock sold", pgSold, setPgSold, {
            info: "The total sale price of the stock you sell — what you receive for it. Only the part of this above your cost basis is a gain.",
          })}
          {moneyField("Cost basis of stock sold", pgBasis, setPgBasis, {
            hint: "Gain (or loss) = amount sold − basis, priced through the gains stack with the qualified dividends.",
            info: "What you originally paid for the stock. Only the part of the sale above this is gain — the rest is your own money coming back, untaxed.",
            infoAlign: "right",
          })}
          {moneyField("Qualified dividends", pgQualDiv, setPgQualDiv, {
            hint: pgIncomeHint(pgIncomeSources.qualifiedDividends, "3a", "dividends", "Part of the ordinary dividends total above — not in addition to it."),
            info: pgIncomeInfo(pgIncomeSources.qualifiedDividends, "3a", "dividends", "Dividends that qualify for the lower tax rate — Form 1040 line 3a. This amount is part of the total ordinary dividends you entered above, not extra income on top of it: it is counted once, riding the lower 0% / 15% / 20% gains staircase instead of the ordinary rates."),
            onEdit: () => markPgIncomeTyped("qualifiedDividends"),
          })}
          {moneyField("Short-term loss carried in", pgCarryInSt, setPgCarryInSt, {
            hint: "Banked short-term capital losses from earlier years, still unused as this year begins. Blank = none.",
            info: "A capital-loss carryforward is a net capital loss from an earlier year that wasn't used up — the unused part carries into this year. Enter the short-term amount still unused as this year begins: it nets against this year's gains, then up to $3,000 of what is left offsets ordinary income, and anything still unused carries into next year. Leave blank when there is none.",
          })}
          {moneyField("Long-term loss carried in", pgCarryInLt, setPgCarryInLt, {
            hint: "Banked long-term capital losses from earlier years, still unused as this year begins. Blank = none.",
            info: "The long-term companion to the short-term carry-in above: a net long-term capital loss from an earlier year that wasn't used up. It nets against this year's gains first — a $20,000 long-term carry-in against a $30,000 gain leaves a $10,000 gain priced, not $30,000. Leave blank when there is none.",
            infoAlign: "right",
          })}
          {moneyField("Of the short-term loss, the Washington part", pgCarryInStWa, setPgCarryInStWa, {
            hint: "Only the part of the short-term loss that came from sales allocated to Washington. Blank = none.",
            info: "The Washington-allocated part of the short-term loss carried in: that part alone can reduce the Washington capital-gains tax base, and only when this year's gains actually absorb it. It is a portion of the short-term total above, never an amount on top of it.",
          })}
          {moneyField("Of the long-term loss, the Washington part", pgCarryInLtWa, setPgCarryInLtWa, {
            hint: "The Washington-allocated part of the long-term loss above. Blank = none.",
            info: "The Washington-allocated part of the long-term loss carried in: that part alone can reduce the Washington capital-gains tax base, and only when this year's gains actually absorb it. It is a portion of the long-term total above, never an amount on top of it.",
            infoAlign: "right",
          })}
        </div>
        {pgDividendPairNote && (
          <p className="mt-2 text-sm text-[var(--warn)]" role="note">
            {pgDividendPairNote}
          </p>
        )}
        </>
        ))}

        {pgSectionCard("aca", "ACA & state", pgAcaSummary, (
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {numField("ACA household size", pgAcaSize, setPgAcaSize, {
            hint: "Sets the 400% poverty-line cliff. Needed to see the ACA position.",
            info: "How many people are in your tax household for health coverage. It sets the poverty line your income is measured against — a bigger household means a higher ACA cliff.",
          })}
          <div>
            {moneyField("ACA benchmark premium / yr", pgBenchmark, setPgBenchmark, {
              hint: "Needed to price the premium credit. Blank shows the cliff position only.",
              info: "The yearly price of your area's benchmark Silver plan before any credit. The credit covers the part above a set share of your income — and vanishes entirely over the cliff.",
              infoAlign: "right",
            })}
            {pgBenchmarkCaption && (
              <p className="mt-1 text-xs text-[var(--dim)]" role="note">
                {pgBenchmarkCaption}
              </p>
            )}
          </div>
          {moneyField("Health premium — marketplace / yr", pgHealthAca, setPgHealthAca, {
            hint: "Your plan's gross premium. The readout nets the advance credit taken off it.",
            info: "The premium of the plan you are actually enrolled in this year, before the credit. It also caps the year's final credit in the filing settlement below. The strip at the top shows the premium net of the advance credit you actually took — the rest of the final credit settles in the cash left after tax — and the cash left after paying it. It never changes the year's tax — it is a cost readout, like spending.",
          })}
          {moneyField("Health premium — Medicare, per person / yr", pgHealthMedicare, setPgHealthMedicare, {
            hint: "Part B + Part D base, for each person on Medicare this year.",
            info: "The Medicare base premium per person on Medicare this year: Part B standard plus a Part D base premium. The IRMAA surcharge is NOT part of this amount — it is priced nowhere until you enter it in the IRMAA surcharge dial below; the IRMAA readout in the strip is the surcharge this year's income will cause in two years' time, not this year's surcharge.",
          })}
          {moneyField("IRMAA surcharge payable this year / yr", pgIrmaaPayable, setPgIrmaaPayable, {
            hint: "The surcharge you actually pay this year, for the whole household. Blank = $0.",
            info: "The Medicare IRMAA surcharge actually payable THIS year — the figure on your Medicare premium notice, or the plan march's own IRMAA for this year. It is charged beside the base premium in the cash left after health premiums, so the 'enough for the year' verdict counts it. It is NOT the IRMAA readout in the strip: that is the surcharge this year's income will cause in two years' time. The projection walk prices no payable IRMAA — each walked year has its own.",
          })}
          {moneyField("Advance credit (APTC) already taken / yr", pgAptcTaken, setPgAptcTaken, {
            hint: "Advance premium credit you actually received this year. Blank = $0.",
            info: "The advance premium tax credit paid toward your premiums during the year (your Form 1095-A total). The cash left after tax settles it at filing: any credit still due is added, and any advance above the final credit is repaid — the same settlement the December view runs for the same year, so the two cash-left figures agree.",
          })}
          {moneyField("Coverage-month reduction / yr", pgCoverageReduction, setPgCoverageReduction, {
            hint: "Credit lost for months someone wasn't eligible. Blank = $0.",
            info: "The credit is monthly, not annual: a month in which a household member had an affordable employer offer, or was eligible for Medicare or CHIP, shrinks that month's credit whatever the annual income says. Enter the total reduction for any ineligible months — it lowers the final credit in the year's filing settlement.",
          })}
          {moneyField("Dependent MAGI for ACA", pgDependentMagi, setPgDependentMagi, {
            hint: "A filing dependent's income — counts toward the ACA household MAGI only. Blank = $0.",
            info: "Count a dependent's income toward household MAGI only when the dependent is required to file because their income meets the filing threshold — a return filed only to recover withholding does not count. The amount counts toward the ACA household MAGI only: it can shrink the credit or push the household over the cliff, but it is never added to your own taxable income and never changes the tax itself.",
          })}
          {pgAcaHasHardCliff && (
            <div>
              {moneyField("Buffer below the ACA cliff", pgAcaBuffer, setPgAcaBuffer, {
                hint: "A safety cushion under the cliff — the ACA cliff fill and Hold aim this far under it. Never part of the pricing.",
                info: "How far below the 400% poverty-line cliff you aim ACA MAGI, to leave room for year-end income landing higher than expected. The ACA cliff chip, Hold's ACA target, and the fill below all aim at cliff − buffer — editing the buffer while Hold is on re-solves to the new line. It only helps choose the pre-tax money out amount — the tax and credit price exactly as before for whatever amount is dialed.",
              })}
              <button
                type="button"
                aria-label="Fill conversion to cliff minus buffer"
                className="mt-1 text-sm text-[var(--dim)] underline underline-offset-2 hover:text-[var(--text)] disabled:opacity-60"
                disabled={pgAgePNum == null || pgAgePNum <= 0}
                onClick={applyPgAcaBufferFill}
              >
                Fill conversion to cliff − buffer
              </button>
            </div>
          )}
          <div>
            <label
              className="block text-sm font-medium text-[var(--text)]"
              htmlFor="roth-pg-residence"
            >
              State of residence
            </label>
            <select
              id="roth-pg-residence"
              aria-label="State of residence"
              className={inputCls}
              value={pgResidence}
              onChange={(e) =>
                setPgResidence(e.target.value === "WA" ? "WA" : "other")
              }
            >
              <option value="WA">Washington — capital-gains excise</option>
              <option value="other">Other / none — flat rate</option>
            </select>
            <p className={hintCls}>
              Washington prices the state tax on this year&rsquo;s stock
              gain under its capital-gains excise instead of the flat rate.
            </p>
          </div>
          {pctField("State tax rate for this year", pgStateRate, setPgStateRate, {
            hint:
              pgResidence === "WA"
                ? "Ignored for Washington — the excise prices the state tax instead."
                : "Flat rate on taxable income, the plan's state model. 0 = none.",
            info: "Your state's flat tax rate on taxable income, as a percent. Leave it at 0 to price federal tax only.",
          })}
          {moneyField("Mortgage interest", pgItemizedMortgage, setPgItemizedMortgage, {
            hint: "Itemized deductions for this year. The year takes the greater of the itemized total and the standard deduction. Blank = $0.",
          })}
          {moneyField("State and local taxes paid", pgItemizedSalt, setPgItemizedSalt, {
            hint: "Itemized deductions: taxes PAID this year. Capped on its own at the year's SALT cap ($40,000 for 2025, $40,400 for 2026, reduced for very high incomes) before the comparison. Blank = $0.",
          })}
          {moneyField("Charitable contributions", pgItemizedCharitable, setPgItemizedCharitable, {
            hint: "Itemized deductions: this same figure is the one charitable input the Washington excise's charitable deduction also reads. Blank = $0.",
          })}
          {moneyField("Other itemized deductions", pgItemizedOther, setPgItemizedOther, {
            hint: "Itemized deductions: anything else. The four components stay separate so the SALT cap applies to that component alone. Blank = $0.",
          })}
          <div className="col-span-2 sm:col-span-3">
            <span className={labelCls}>Education expenses — for education credits</span>
            <p className={hintCls}>
              Optional: one row per student in this year — that
              student&rsquo;s qualified education expenses, and whether the
              student is eligible for the American Opportunity Credit
              (AOTC). The AOTC prices per student (up to $2,500 each, 40%
              refundable); other students&rsquo; expenses price the
              Lifetime Learning Credit (20% of up to $10,000), and the same
              student&rsquo;s expenses never count toward both. Leave
              empty for no credits.
            </p>
            {pgEduStudents.map((row, i) => (
              <div key={i} className="mt-2 flex flex-wrap items-end gap-2">
                <div className="min-w-40 flex-1">
                  {moneyField(`Student ${i + 1} qualified expenses`, row.expenses, (v) =>
                    setPgEduStudents((rows) =>
                      rows.map((r, j) => (j === i ? { ...r, expenses: v } : r)),
                    ),
                  )}
                </div>
                <div className="flex items-center gap-2 pb-2">
                  <input
                    id={`pg-edu-aotc-${i}`}
                    type="checkbox"
                    className="h-4 w-4"
                    checked={row.aotcEligible}
                    onChange={(e) =>
                      setPgEduStudents((rows) =>
                        rows.map((r, j) =>
                          j === i ? { ...r, aotcEligible: e.target.checked } : r,
                        ),
                      )
                    }
                  />
                  <label htmlFor={`pg-edu-aotc-${i}`} className="text-sm">
                    AOTC-eligible
                  </label>
                </div>
                <button
                  type="button"
                  aria-label={`Remove student ${i + 1}`}
                  className="px-2 py-2 text-base text-[var(--dim)] hover:text-[var(--bad)]"
                  onClick={() =>
                    setPgEduStudents((rows) => rows.filter((_, j) => j !== i))
                  }
                >
                  ✕
                </button>
              </div>
            ))}
            {pgEduStudents.length < 12 && (
              <button
                type="button"
                className="mt-2 px-1 py-1 text-xs text-[var(--dim)] underline underline-offset-2 hover:text-[var(--accent)]"
                onClick={() =>
                  setPgEduStudents((rows) => [
                    ...rows,
                    { expenses: "", aotcEligible: true },
                  ])
                }
              >
                Add a student
              </button>
            )}
          </div>
        </div>
        ))}

        {pgSectionCard("spending", "Spending", pgSpendingSummary, (
        <>
        <div className="mt-2 max-w-xs">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <label
              className="block text-sm font-medium text-[var(--text)]"
              htmlFor="roth-pg-spending"
            >
              {pgSpendingUnit === "month" ? "Monthly spending" : "Spending per year"}
            </label>
            <div
              role="group"
              aria-label="Spending display period"
              className="flex overflow-hidden rounded-[var(--radius)] border border-[var(--border)]"
            >
              <button
                type="button"
                aria-label="Show spending per year"
                aria-pressed={pgSpendingUnit === "year"}
                onClick={() => setPgSpendingUnit("year")}
                className={`px-2 py-1 text-xs font-medium ${pgSpendingUnit === "year" ? "bg-[var(--accent)] text-white" : "text-[var(--text)] hover:text-[var(--accent)]"}`}
              >
                Per year
              </button>
              <button
                type="button"
                aria-label="Show spending per month"
                aria-pressed={pgSpendingUnit === "month"}
                onClick={() => setPgSpendingUnit("month")}
                className={`px-2 py-1 text-xs font-medium ${pgSpendingUnit === "month" ? "bg-[var(--accent)] text-white" : "text-[var(--text)] hover:text-[var(--accent)]"}`}
              >
                Per month
              </button>
            </div>
          </div>
          <div className="relative">
            <span
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-base text-[var(--dim)]"
            >
              $
            </span>
            <input
              id="roth-pg-spending"
              aria-label={
                pgSpendingUnit === "month"
                  ? "Playground — monthly spending"
                  : "Playground — spending per year"
              }
              className={`${inputCls} pl-7`}
              inputMode="decimal"
              value={
                pgSpendingUnit === "month"
                  ? (pgSpendingMonthlyDraft ?? pgMonthlySpendingDisplay())
                  : pgSpending
              }
              onFocus={() => {
                pgSpendingFocusedRef.current = true;
                if (pgSpendingUnit === "month") {
                  setPgSpendingMonthlyDraft(monthlyRaw(pgSpending));
                }
              }}
              onBlur={() => {
                pgSpendingFocusedRef.current = false;
                if (pgSpendingUnit === "month") {
                  setPgSpendingMonthlyDraft(null);
                }
                // The annual state is canonicalized on blur,
                // exactly as the Tax Plan's spending field
                // does: the same numeric value, grouped.
                const d = parseDollars(pgSpending);
                if (d != null) setPgSpending(fmtMoneyInput(d));
                // Blur flush: the value is settled now, so
                // send any held Tax Plan write-through.
                firePendingPgRothSaveRef.current();
              }}
              onChange={(e) => {
                // An edit takes over the comparison: any
                // held paste spending (P-S2) clears, and
                // this dial's figure rules again (writing
                // through to the record as usual).
                setPgPastedSpending(undefined);
                if (pgSpendingUnit === "month") {
                  setPgSpendingMonthlyDraft(e.target.value);
                  setPgSpending(monthlyToAnnual(e.target.value));
                } else {
                  setPgSpending(e.target.value);
                }
              }}
            />
          </div>
          {pgSpendingUnit === "month" && (
            <p className="mt-1 text-xs text-[var(--dim)]">
              = ${fmtMoneyInput((parseMoney(pgSpending) ?? 0) / 100)}/yr
            </p>
          )}
          <p className="mt-1 text-xs text-[var(--dim)]">
            The Tax Plan&rsquo;s annual spending — editing here changes the saved plan, like editing it in the Tax Plan or Retirement. It only sets the &ldquo;Left after a year&rsquo;s spending&rdquo; comparison below; it never changes the tax.
          </p>
          {pgSpendingMsg != null && (
            <p className="mt-1 text-xs text-[var(--bad)]" role="note">
              {pgSpendingMsg}
            </p>
          )}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {moneyField("Cash drawn for spending", pgCashDraw, setPgCashDraw, {
            hint: "Money taken out of savings / the cash sleeve to pay this year's spending. Blank = $0.",
            info: "Cash you take out of a savings account or the plan's cash sleeve to pay for this year. It is your own money coming back — no sale, no gain, no tax — so it counts as cash in for the year's verdict without counting as income. Leave blank when the year is funded other ways.",
          })}
          {moneyField("Roth drawn for spending", pgRothDraw, setPgRothDraw, {
            hint: "Money taken out of your Roth accounts to pay this year's spending. Blank = $0.",
            info: "Money you take out of your Roth IRA or Roth 401(k) to pay for this year. Roth money was already taxed on the way in, so a draw for spending is not taxed again and is not income — it counts as cash in for the year's verdict, like the plan's own funding ledger counts it. Leave blank when the year is funded other ways.",
            infoAlign: "right",
          })}
        </div>
        </>))}

          </>
        )}
        </section>

          </>
        )}

        {pgFace === "projection" && (
          <>
        {pgGroupHeader("projection", "Projection dials", "A separate what-if — the captured template year repeated year by year. These dials drive only the projection; they never change the single-year price.")}
        {pgGroupOpen.projection && (
        <section className={sectionCls} aria-label="Projection">
          <h3>
            <button
              type="button"
              aria-expanded={pgProjOpen}
              aria-label="Projection section"
              className="flex w-full items-start justify-between gap-3 text-left"
              onClick={() => setPgProjOpen((v) => !v)}
            >
              <span>
                <span className="block text-base font-semibold">Projection — repeat {pgProjTemplate != null ? `${pgProjTemplate.taxYear} (age ${pgProjTemplate.agePrimary})` : "this year"}{pgProjFromAge.trim() !== "" ? ` from age ${pgProjFromAge.trim()}` : ""} to age {pgProjToAge.trim() === "" ? "95" : pgProjToAge}</span>
                <span className="mt-0.5 block text-sm text-[var(--dim)]">
                  {pgProjSummary}
                </span>
              </span>
              <FoldChevron open={pgProjOpen} className="mt-0.5" />
            </button>
          </h3>
          {pgProjOpen && (
            <>
              <p className="mt-2 max-w-3xl text-sm text-[var(--dim)]">
                A captured template year repeats, one bar per year,
                priced by the same engine as the single-year view.
                Projected years price the ACA cliff on the newest
                poverty-guideline row, in today&rsquo;s dollars, while
                the single-year view applies the statutory lookback to
                its named year — so a loaded year&rsquo;s cliff can
                differ from the chart&rsquo;s line.
              </p>
              <ExplainerInfoTip
                id="playground.projectionHow"
                label="how the projection works"
              >
<p>
                  The pre-tax money out repeats as entered each
                  year — or, in “replace” mode, Social Security and
                  RMDs replace part of it as they arrive — and it
                  lands in Roth when the money out is a conversion,
                  or leaves as spending when it is a draw, stopping
                  at the stop age or pre-tax floor if one is set.
                  Balances grow at the expected return after each
                  year&rsquo;s money moves, and spending and taxes
                  are not taken out of them.
                </p>
                <p>
                  Medicare switches on at 65 for each person, Social
                  Security starts at its claiming age, RMDs price off
                  the balance as it walks down, the ACA household
                  steps down in its step-down year, and ACA ends once
                  everyone is on Medicare.
                </p>
                <p>
                  Click any bar to load that year into the
                  single-year view — the chart itself runs from a
                  captured snapshot of the template year and never
                  changes when you click, so every year stays on the
                  chart and any bar can be clicked again to go back.
                </p>
                <p>
                  “Projection from age” starts the window at a
                  different age without touching the template:
                  earlier than the template age, the walk itself
                  starts there — the calendar years and your
                  spouse&rsquo;s age shift back with it, the
                  template&rsquo;s income shape repeats from that
                  age, every age-keyed switch follows each projected
                  year&rsquo;s own ages, and the starting balances
                  (the template&rsquo;s pre-tax balance and the
                  starting taxable and Roth balances below) are the
                  balances at that first projected year. Later than
                  the template age, the walk still runs from the
                  template year and the charts show the years from
                  that age on, so the first shown year&rsquo;s
                  balances are the walked ones.
                </p>
              </ExplainerInfoTip>
              {pgProjTemplate != null && (
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
                  <p role="note" className="text-[var(--dim)]">
                    Projection template: {pgProjTemplate.taxYear} (age{" "}
                    {pgProjTemplate.agePrimary})
                    {!pgProjTemplateIsCurrent &&
                      " — the single-year view above shows a different year; the chart still runs from this template."}
                  </p>
                  <button
                    type="button"
                    aria-label="Re-run projection from the year above"
                    disabled={pgProjTemplateIsCurrent || pgAgePNum == null || pgAgePNum <= 0}
                    className="px-1 py-1 text-xs text-[var(--dim)] underline underline-offset-2 hover:text-[var(--accent)] disabled:no-underline disabled:opacity-50"
                    onClick={captureProjTemplate}
                  >
                    {pgProjTemplateIsCurrent
                      ? "Already running from the year above"
                      : "Re-run projection from the year above"}
                  </button>
                </div>
              )}
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                {numField("Projection from age", pgProjFromAge, setPgProjFromAge, {
                  idLabel: "Projection from age",
                  hint:
                    pgProjTemplate != null
                      ? `Blank uses the template's own age (${pgProjTemplate.agePrimary}). Earlier starts the walk at that age, with the starting balances as that year's balances; later shows the years from that age on.`
                      : "Blank uses the template year's own age. Earlier starts the walk at that age, with the starting balances as that year's balances; later shows the years from that age on.",
                })}
                {numField("Project to age", pgProjToAge, setPgProjToAge, {
                  idLabel: "Projection to age",
                  hint: "The last age projected. 95 unless you change it.",
                })}
                {pctField("Expected return", pgProjReturnPct, setPgProjReturnPct, {
                  idLabel: "Projection expected return",
                  hint:
                    pgPrefillSource != null
                      ? `Blank uses your plan's expected return (${pgPrefillSource.expectedReturnPct}%). Balances grow at this rate after each year's money moves.`
                      : "Balances grow at this rate after each year's money moves.",
                })}
                <div>
                  <label className={labelCls} htmlFor="roth-pg-proj-draw-mode">
                    When Social Security and RMDs arrive
                  </label>
                  <select
                    id="roth-pg-proj-draw-mode"
                    aria-label="Projection draw behavior"
                    className={inputCls}
                    value={pgProjDrawMode}
                    onChange={(e) =>
                      setPgProjDrawMode(e.target.value === "replace" ? "replace" : "repeat")
                    }
                  >
                    <option value="repeat">The draw repeats as entered</option>
                    <option value="replace">Social Security and RMDs replace the draw</option>
                  </select>
                  <p className={hintCls}>
                    “Replace” shrinks the pre-tax money out by whatever
                    Social Security and RMDs arrive beyond the template
                    year&rsquo;s own, floored at $0.
                  </p>
                </div>
                <div>
                  <label className={labelCls} htmlFor="roth-pg-proj-kind">
                    Pre-tax money out is
                  </label>
                  <select
                    id="roth-pg-proj-kind"
                    aria-label="Projection money out kind"
                    className={inputCls}
                    value={pgProjMoneyOutKind}
                    onChange={(e) =>
                      setPgProjMoneyOutKind(e.target.value === "draw" ? "draw" : "conversion")
                    }
                  >
                    <option value="conversion">A conversion — it lands in Roth</option>
                    <option value="draw">A draw — it leaves as spending</option>
                  </select>
                </div>
                <div>
                  <label className={labelCls} htmlFor="roth-pg-proj-stop">
                    The money out stops
                  </label>
                  <select
                    id="roth-pg-proj-stop"
                    aria-label="Projection stop rule"
                    className={inputCls}
                    value={pgProjStopKind}
                    onChange={(e) =>
                      setPgProjStopKind(
                        e.target.value === "age"
                          ? "age"
                          : e.target.value === "floor"
                            ? "floor"
                            : "none",
                      )
                    }
                  >
                    <option value="none">Never — it repeats every year</option>
                    <option value="age">After a stop age</option>
                    <option value="floor">At a pre-tax floor</option>
                  </select>
                </div>
                {pgProjStopKind === "age" &&
                  numField("Convert through age", pgProjStopValue, setPgProjStopValue, {
                    idLabel: "Projection convert through age",
                    hint: "The last age the money out runs. $0 after it.",
                  })}
                {pgProjStopKind === "floor" &&
                  moneyField("Pre-tax floor", pgProjStopValue, setPgProjStopValue, {
                    idLabel: "Projection pre-tax floor",
                    hint: "The money out shrinks so the pre-tax balance never goes below this, and stops once it is reached.",
                  })}
                {numField("Your Social Security claiming age", pgProjSsPClaimAge, setPgProjSsPClaimAge, {
                  idLabel: "Projection your claiming age",
                  hint:
                    pgPrefillSource?.ssPrimaryStartAge != null
                      ? `Blank uses your plan's claiming age (${pgPrefillSource.ssPrimaryStartAge}).`
                      : "Blank keeps the template amount in pay every year.",
                })}
                {moneyField("Your Social Security per year", pgProjSsPAnnual, setPgProjSsPAnnual, {
                  idLabel: "Projection your Social Security per year",
                  hint: "What the benefit pays from the claiming age. Blank uses the template amount, or your plan's when the template year is before claiming.",
                })}
                {pgFiling === "mfj" &&
                  numField("Spouse Social Security claiming age", pgProjSsSClaimAge, setPgProjSsSClaimAge, {
                    idLabel: "Projection spouse claiming age",
                    hint:
                      pgPrefillSource?.ssSpouseStartAge != null
                        ? `Blank uses your plan's claiming age (${pgPrefillSource.ssSpouseStartAge}).`
                        : "Blank keeps the template amount in pay every year.",
                  })}
                {pgFiling === "mfj" &&
                  moneyField("Spouse Social Security per year", pgProjSsSAnnual, setPgProjSsSAnnual, {
                    idLabel: "Projection spouse Social Security per year",
                    hint: "What the spouse benefit pays from its claiming age. Blank follows the same rule as yours.",
                  })}
                {moneyField("Starting taxable balance", pgProjTaxableStart, setPgProjTaxableStart, {
                  idLabel: "Projection starting taxable balance",
                  hint:
                    pgPrefillSource != null
                      ? `Blank uses your plan's taxable balance (${fmtDollars(pgPrefillSource.taxableStart)}). This is the balance at the projection's first year; the stock sale draws it down from there.`
                      : "This is the balance at the projection's first year; the stock sale draws it down from there. Blank = no taxable balance tracked — the sale repeats as typed.",
                })}
                {moneyField("Starting Roth balance", pgProjRothStart, setPgProjRothStart, {
                  idLabel: "Projection starting Roth balance",
                  hint:
                    pgPrefillSource != null
                      ? `Blank uses your plan's Roth balance (${fmtDollars(pgPrefillSource.rothStart)}). This is the balance at the projection's first year.`
                      : "This is the balance at the projection's first year.",
                })}
                {numField("ACA household size after step-down", pgProjAcaSizeAfter, setPgProjAcaSizeAfter, {
                  idLabel: "Projection ACA household size after",
                  hint: "The household size from the step-down year on. Typing in either of these two fields turns them into a single-step override of your plan's household schedule.",
                })}
                {numField("ACA step-down year", pgProjAcaStepYear, setPgProjAcaStepYear, {
                  idLabel: "Projection ACA step-down year",
                  hint:
                    pgPrefillSource?.acaHouseholdSchedule != null &&
                    pgPrefillSource.acaHouseholdSchedule.length > 0
                      ? `Blank uses your plan's household schedule (first step ${pgPrefillSource.acaHouseholdSchedule[0]?.fromYear}).`
                      : "Blank = no step-down.",
                })}
              </div>
              {pgProjection == null && (
                <p className="mt-3 text-sm text-[var(--dim)]" role="note">
                  Enter your age for the template year above and the
                  projection draws here.
                </p>
              )}
              {pgProjection != null &&
                (() => {
                  const proj = pgProjection;
                  const n = proj.years.length;
                  // The §1211(b) allowance segment's hatch
                  // (P-S10): the same overlay the single-year
                  // stack and the Tax Plan chart draw their
                  // negative allowance segments with, so the
                  // segment reads as a subtraction in all
                  // three charts.
                  const allowanceHatchStyle = {
                    backgroundImage:
                      "repeating-linear-gradient(45deg, rgba(255,255,255,0.5) 0 5px, rgba(0,0,0,0.22) 5px 10px)",
                  } as const;
                  /* P-S10 (parity audit, SHOULD — settled
                     STAND): the segment list carries the
                     whole preferential stack beside the six
                     ordinary segments, decomposed from the
                     priced result exactly as the single-year
                     stack decomposes it (round-2 S-9 there,
                     P-S9 in the Tax Plan chart): qualified
                     dividends as their own segment, long-term
                     gain as max(0, r.ltcgNet) — the priced
                     NET result, not the typed sale gain (an
                     entering loss carryforward nets against
                     the sale in the walk before the stack
                     prices, and a harvested gain adds to
                     it) — tax-exempt interest, and the
                     §1211(b) capital-loss allowance as a
                     hatched NEGATIVE top segment. Before
                     P-S10 the chart drew only the six
                     ordinary segments while its line read
                     r.magi — AGI plus tax-exempt interest,
                     with AGI itself carrying the qualified
                     dividends and priced gains net of the
                     allowance — so every bar sat below its
                     own MAGI line by the whole preferential
                     stack (the settlement's worked example:
                     bars $6,500 against a $21,500 line on
                     yield income alone). With the priced
                     decomposition the segments sum to MAGI
                     exactly, as priceYear composes it: the
                     ordinary pieces plus qualified dividends
                     plus the positive net gain less the
                     allowance make AGI, and the tax-exempt
                     interest completes MAGI. The legend and
                     each bar's spoken summary derive from
                     this same list, so all three foot
                     together by construction. */
                  const segDefs = [
                    { key: "interest", label: "Interest", color: "#3b82f6", hatch: false },
                    { key: "orddiv", label: "Ordinary dividends (non-qualified part)", color: "#06b6d4", hatch: false },
                    { key: "other", label: "Other ordinary income", color: "#f59e0b", hatch: false },
                    { key: "ss", label: "Taxable Social Security", color: "#ef4444", hatch: false },
                    { key: "rmd", label: "RMD", color: "#8b5cf6", hatch: false },
                    { key: "conv", label: "Pre-tax money out", color: "#0f766e", hatch: false },
                    { key: "qualdiv", label: "Qualified dividends", color: "#84cc16", hatch: false },
                    { key: "gains", label: "Long-term gain", color: "#f97316", hatch: false },
                    { key: "taxexempt", label: "Tax-exempt interest", color: "#cbd5e1", hatch: false },
                    { key: "lossallow", label: "Capital-loss allowance (§1211(b))", color: "#64748b", hatch: true },
                  ] as const;
                  const segAmount = (
                    r: PlaygroundYearResult,
                    key: (typeof segDefs)[number]["key"],
                  ): number =>
                    key === "interest"
                      ? r.interest
                      : key === "orddiv"
                        ? r.nonQualifiedDividends
                        : key === "other"
                          ? r.otherOrdinary
                          : key === "ss"
                            ? r.ssTaxable
                            : key === "rmd"
                              ? r.rmd
                              : key === "conv"
                                ? r.conversion + r.spendingDraw
                                : key === "qualdiv"
                                  ? r.qualifiedDividends
                                  : key === "gains"
                                    ? Math.max(0, r.ltcgNet)
                                    : key === "taxexempt"
                                      ? r.taxExemptInterest
                                      : -r.capitalLossAllowance;
                  const stackTotal = (r: PlaygroundYearResult) =>
                    segDefs.reduce((a, d) => a + segAmount(r, d.key), 0);
                  // Income-chart display window (trim): the income
                  // chart draws only through ONE year past the last
                  // year with any income activity, so a run whose
                  // income ends mid-window (on the user's current
                  // template the pre-tax money runs out at 75 and
                  // every later year is $0) doesn't trail a long
                  // flat zero tail across the card — the drop to
                  // zero stays visible, then the chart stops. The
                  // walk itself is untouched: yMax, the legend, and
                  // the balances chart below all still span the
                  // full window to the to-age, and a run whose
                  // income reaches the to-age displays the full
                  // span exactly as before (no trim, no caption).
                  const yearHasIncome = (r: PlaygroundYearResult) =>
                    stackTotal(r) !== 0 || r.ltcgPriced !== 0 || r.magi !== 0;
                  let lastActiveIdx = -1;
                  proj.years.forEach((y, i) => {
                    if (yearHasIncome(y.result)) lastActiveIdx = i;
                  });
                  const dispN =
                    lastActiveIdx >= 0 && lastActiveIdx < n - 1
                      ? Math.min(n, lastActiveIdx + 2)
                      : n;
                  const dispYears = proj.years.slice(0, dispN);
                  const incomeTrimmed = dispN < n;
                  const lastActiveYear =
                    lastActiveIdx >= 0 ? proj.years[lastActiveIdx] : undefined;
                  const yMax = Math.max(
                    1,
                    ...proj.years.map((y) =>
                      Math.max(
                        stackTotal(y.result),
                        y.result.magi,
                        y.result.aca.cliff ?? 0,
                      ),
                    ),
                  );
                  const magiPoints = dispYears
                    .map(
                      (y, i) =>
                        `${i + 0.5},${100 - (y.result.magi / yMax) * 100}`,
                    )
                    .join(" ");
                  // ACA cliff line runs: consecutive years that
                  // carry a hard cliff (ACA applies, a cliff
                  // figure, coverage 2026+).
                  const cliffRuns: { x1: number; y1: number; x2: number; y2: number }[] = [];
                  dispYears.forEach((y, i) => {
                    const cliff =
                      y.calendarYear >= 2026 && y.result.aca.applies
                        ? y.result.aca.cliff
                        : null;
                    if (cliff == null) return;
                    const prev = i > 0 ? dispYears[i - 1] : undefined;
                    const prevCliff =
                      prev != null &&
                      prev.calendarYear >= 2026 &&
                      prev.result.aca.applies
                        ? prev.result.aca.cliff
                        : null;
                    if (prevCliff != null) {
                      cliffRuns.push({
                        x1: i - 0.5,
                        y1: 100 - (prevCliff / yMax) * 100,
                        x2: i + 0.5,
                        y2: 100 - (cliff / yMax) * 100,
                      });
                    } else {
                      cliffRuns.push({
                        x1: i + 0.1,
                        y1: 100 - (cliff / yMax) * 100,
                        x2: i + 0.9,
                        y2: 100 - (cliff / yMax) * 100,
                      });
                    }
                  });
                  const presentSegs = segDefs.filter((d) =>
                    proj.years.some((y) => segAmount(y.result, d.key) !== 0),
                  );
                  // Balances area chart: one point per year
                  // boundary (each year's starting balances,
                  // plus the final ending balances).
                  const balPoints = [
                    ...proj.years.map((y) => y.startBalances),
                    proj.endBalances,
                  ];
                  const balLayers = [
                    { key: "pretax", label: "Pre-tax", color: "#7c3aed", get: (b: (typeof balPoints)[number]) => b.pretax },
                    { key: "taxable", label: "Taxable", color: "#d97706", get: (b: (typeof balPoints)[number]) => b.taxable },
                    { key: "roth", label: "Roth", color: "#14705a", get: (b: (typeof balPoints)[number]) => b.roth },
                  ].filter((l) => balPoints.some((b) => l.get(b) != null));
                  const balCum = balPoints.map((b) => {
                    let cum = 0;
                    return balLayers.map((l) => {
                      const v = l.get(b) ?? 0;
                      const lo = cum;
                      cum += v;
                      return { lo, hi: cum };
                    });
                  });
                  const balTotalAt = (i: number): number => {
                    const c = balCum[i];
                    if (c == null || c.length === 0) return 0;
                    return c[c.length - 1]?.hi ?? 0;
                  };
                  const balMax = Math.max(1, ...balCum.map((c) => c[c.length - 1]?.hi ?? 0));
                  // Y axis: round the top up to a nice step so the
                  // dollar scale and gridlines land on round figures.
                  // The series itself is unchanged — only the axis
                  // ceiling moves (to the next nice value at or above
                  // the true maximum).
                  const balTickStep = (() => {
                    const rough = balMax / 5;
                    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
                    const norm = rough / mag;
                    const mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
                    return mult * mag;
                  })();
                  const balYMax = Math.max(balTickStep, Math.ceil(balMax / balTickStep) * balTickStep);
                  const balTicks: number[] = [];
                  for (let v = 0; v <= balYMax + balTickStep / 1000; v += balTickStep) {
                    balTicks.push(Math.round(v * 100) / 100);
                  }
                  const fmtBalAxis = (v: number): string => {
                    if (v === 0) return "$0";
                    if (Math.abs(v) >= 1_000_000) {
                      const m = v / 1_000_000;
                      return `$${Number.isInteger(m) ? m : m.toFixed(1)}M`;
                    }
                    if (Math.abs(v) >= 1_000) return `$${Math.round(v / 1_000)}k`;
                    return `$${Math.round(v)}`;
                  };
                  const balX = (i: number) =>
                    balPoints.length > 1 ? (i / (balPoints.length - 1)) * 100 : 50;
                  const balY = (v: number) => 100 - (v / balYMax) * 100;
                  const balFirstYear = proj.years[0]?.calendarYear ?? 0;
                  const balEndingTotal = balTotalAt(balCum.length - 1);
                  const balSelected = pgBalSelectedYear != null
                    ? proj.years.find((y) => y.calendarYear === pgBalSelectedYear) ?? null
                    : null;
                  return (
                    <>
                      <div className="mt-4" aria-label="Projected income by year chart">
                        <h4 className="text-sm font-semibold">
                          Income stack by year — ages {dispYears[0]?.agePrimary} to{" "}
                          {dispYears[dispN - 1]?.agePrimary}
                        </h4>
                        <div className="relative mt-2 h-56">
                          <div className="absolute inset-0 flex items-end gap-[2px]">
                            {dispYears.map((y) => {
                              let cum = 0;
                              const segs = segDefs
                                .map((d) => {
                                  const amount = segAmount(y.result, d.key);
                                  const start = cum;
                                  cum += amount;
                                  return { ...d, amount, start };
                                })
                                .filter((s) => s.amount !== 0);
                              const selected =
                                pgProjSelectedYear === y.calendarYear;
                              const segSummary = segs
                                .map((s) => `${s.label} ${fmtDollars(s.amount)}`)
                                .join("; ");
                              return (
                                <button
                                  key={y.calendarYear}
                                  type="button"
                                  aria-label={`Load ${y.calendarYear} (age ${y.agePrimary}) into the single-year view — MAGI ${fmtDollars(y.result.magi)}, total tax ${fmtDollars(y.result.totalTax)}${segSummary ? ` — ${segSummary}` : ""}`}
                                  aria-pressed={selected}
                                  className={`relative h-full min-w-0 flex-1 rounded-sm hover:bg-[var(--accent-soft)] ${selected ? "ring-2 ring-[var(--accent)] ring-inset" : pgProjSelectedYear != null ? "opacity-40" : ""}`}
                                  onClick={() => loadProjYear(y.calendarYear)}
                                >
                                  {segs.map((s) => (
                                    <span
                                      key={s.key}
                                      aria-hidden="true"
                                      className="absolute right-0 left-0 border-b border-[var(--bg)]"
                                      style={{
                                        bottom: `${(Math.min(s.start, s.start + s.amount) / yMax) * 100}%`,
                                        height: `${(Math.abs(s.amount) / yMax) * 100}%`,
                                        background: s.color,
                                        ...(s.hatch ? allowanceHatchStyle : {}),
                                      }}
                                    />
                                  ))}
                                </button>
                              );
                            })}
                          </div>
                          <svg
                            className="pointer-events-none absolute inset-0 h-full w-full"
                            viewBox={`0 0 ${dispN} 100`}
                            preserveAspectRatio="none"
                            aria-hidden="true"
                          >
                            {cliffRuns.map((r, i) => (
                              <line
                                key={i}
                                x1={r.x1}
                                y1={r.y1}
                                x2={r.x2}
                                y2={r.y2}
                                stroke="var(--warn)"
                                strokeWidth={1.5}
                                strokeDasharray="5 3"
                                vectorEffect="non-scaling-stroke"
                              />
                            ))}
                            <polyline
                              points={magiPoints}
                              fill="none"
                              stroke="var(--text)"
                              strokeWidth={1.5}
                              vectorEffect="non-scaling-stroke"
                            />
                          </svg>
                        </div>
                        <div className="mt-1 flex gap-[2px]" aria-hidden="true">
                          {dispYears.map((y) => {
                            const labelSelected =
                              pgProjSelectedYear === y.calendarYear;
                            return (
                              <span
                                key={y.calendarYear}
                                className={`min-w-0 flex-1 text-center whitespace-nowrap ${labelSelected ? "text-[11px] font-bold text-[var(--text)]" : "text-[10px] text-[var(--dim)]"}`}
                              >
                                {labelSelected ||
                                y.agePrimary % 5 === 0 ||
                                y.agePrimary === dispYears[0]?.agePrimary ||
                                y.agePrimary === dispYears[dispN - 1]?.agePrimary
                                  ? y.agePrimary
                                  : ""}
                              </span>
                            );
                          })}
                        </div>
                        <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--dim)]">
                          {presentSegs.map((d) => (
                            <span key={d.key} className="inline-flex items-center gap-1.5">
                              <span
                                className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                                style={{ background: d.color }}
                                aria-hidden="true"
                              />
                              {d.label}
                            </span>
                          ))}
                          <span className="inline-flex items-center gap-1.5">
                            <span
                              aria-hidden="true"
                              className="inline-block h-0 w-4 border-t-2 border-[var(--text)]"
                            />
                            MAGI
                          </span>
                          {cliffRuns.length > 0 && (
                            <span className="inline-flex items-center gap-1.5">
                              <span
                                aria-hidden="true"
                                className="inline-block h-0 w-4 border-t-2 border-dashed border-[var(--warn)]"
                              />
                              ACA cliff (plan convention)
                            </span>
                          )}
                        </p>
                        {incomeTrimmed && lastActiveYear != null && (
                          <p className="mt-1 text-xs text-[var(--dim)]" role="note">
                            No income after {lastActiveYear.calendarYear} (age{" "}
                            {lastActiveYear.agePrimary}), so this chart stops
                            one year past it. The projection still runs to{" "}
                            {proj.years[n - 1]?.calendarYear} (age{" "}
                            {proj.years[n - 1]?.agePrimary}) — the balances
                            chart below covers the full span.
                          </p>
                        )}
                        {pgProjSelectedYear != null && (
                          <p className="mt-1 text-xs text-[var(--dim)]" role="note">
                            Showing {pgProjSelectedYear} in the single-year
                            view below. Click any other bar to view that
                            year instead — the chart stays as it is.
                          </p>
                        )}
                      </div>
                      <div className="mt-5" aria-label="Projected balances chart" ref={pgBalancesRef}>
                        <h4 className="text-sm font-semibold">Balances by year</h4>
                        <p className="mt-1 text-sm text-[var(--text)]">
                          Spending and taxes are not taken out of these balances.
                        </p>
                        <p className="mt-1 text-xs text-[var(--dim)]">
                          Each balance grows at the expected return after the
                          year&rsquo;s money moves: the pre-tax balance falls
                          by its RMD and the money out, the taxable balance
                          by the stock sale, and a conversion lands in Roth
                          (a draw leaves instead). Taxes are not taken out
                          of any balance here.
                        </p>
                        <div className="mt-3 flex gap-2">
                          {/* Y axis — dollar scale */}
                          <div className="relative h-56 w-14 shrink-0" aria-hidden="true">
                            {balTicks.map((t) => (
                              <span
                                key={t}
                                className="tnum absolute right-1 text-[11px] whitespace-nowrap text-[var(--dim)]"
                                style={{ top: `${balY(t)}%`, transform: "translateY(-50%)" }}
                              >
                                {fmtBalAxis(t)}
                              </span>
                            ))}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="relative h-56">
                              {/* Horizontal gridlines */}
                              <div className="pointer-events-none absolute inset-0" aria-hidden="true">
                                {balTicks.map((t) => (
                                  <span
                                    key={t}
                                    className="absolute right-0 left-0 border-t border-[var(--border)]"
                                    style={{ top: `${balY(t)}%`, opacity: t === 0 ? 0 : 0.55 }}
                                  />
                                ))}
                              </div>
                              <svg
                                className="absolute inset-0 h-full w-full"
                                viewBox="0 0 100 100"
                                preserveAspectRatio="none"
                                role="img"
                                aria-label={`Stacked balances from ${fmtDollars(balTotalAt(0))} at age ${proj.years[0]?.agePrimary} to ${fmtDollars(balTotalAt(balCum.length - 1))} after age ${proj.years[n - 1]?.agePrimary}`}
                              >
                                {balLayers.map((l, li) => {
                                  const top = balCum
                                    .map((c, i) => `${balX(i)},${balY(c[li]?.hi ?? 0)}`)
                                    .join(" ");
                                  const bottom = balCum
                                    .map((c, i) => `${balX(i)},${balY(c[li]?.lo ?? 0)}`)
                                    .reverse()
                                    .join(" ");
                                  return (
                                    <polygon
                                      key={l.key}
                                      points={`${top} ${bottom}`}
                                      fill={l.color}
                                      fillOpacity={0.75}
                                      stroke={l.color}
                                      strokeWidth={0.4}
                                    />
                                  );
                                })}
                              </svg>
                              {/* Click a year — one column per projected year */}
                              <div className="absolute inset-0 flex">
                                {proj.years.map((y) => {
                                  const isSel = pgBalSelectedYear === y.calendarYear;
                                  const end = y.endBalances;
                                  const endTotal = (end.pretax ?? 0) + (end.taxable ?? 0) + end.roth;
                                  return (
                                    <button
                                      key={y.calendarYear}
                                      type="button"
                                      aria-label={`Show balances for ${y.calendarYear} — Pre-tax ${fmtDollars(end.pretax ?? 0)}, Taxable ${fmtDollars(end.taxable ?? 0)}, Roth ${fmtDollars(end.roth)}, total ${fmtDollars(endTotal)}`}
                                      aria-pressed={isSel}
                                      className={`h-full min-w-0 flex-1 rounded-sm hover:bg-[var(--accent-soft)] ${isSel ? "ring-2 ring-[var(--accent)] ring-inset" : ""}`}
                                      onClick={() => setPgBalSelectedYear(y.calendarYear)}
                                    />
                                  );
                                })}
                              </div>
                              {/* Ending total at the right edge of the stack */}
                              <span
                                className="tnum pointer-events-none absolute rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap text-[var(--text)]"
                                style={{ right: 4, top: `${balY(balEndingTotal)}%`, transform: "translateY(-50%)" }}
                              >
                                Total {fmtDollars(balEndingTotal)}
                              </span>
                            </div>
                            {/* X axis — year labels every 5 years */}
                            <div className="mt-1 flex" aria-hidden="true">
                              {proj.years.map((y) => {
                                const show = balFirstYear !== 0 && (y.calendarYear - balFirstYear) % 5 === 0;
                                const isSel = pgBalSelectedYear === y.calendarYear;
                                return (
                                  <span
                                    key={y.calendarYear}
                                    className={`min-w-0 flex-1 text-center whitespace-nowrap ${isSel ? "text-[11px] font-bold text-[var(--text)]" : "text-[10px] text-[var(--dim)]"}`}
                                  >
                                    {show || isSel ? y.calendarYear : ""}
                                  </span>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                        <p className="mt-1 text-xs text-[var(--dim)]">
                          Click a year in the chart to see its balances.
                        </p>
                        {balSelected != null && (
                          <div
                            className="mt-2 rounded border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
                            role="region"
                            aria-label={`Balances for ${balSelected.calendarYear}`}
                          >
                            <p className="text-xs font-semibold">
                              {balSelected.calendarYear} — end of year
                            </p>
                            <p className="tnum mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                              <span>
                                <span className="text-[var(--dim)]">Pre-tax </span>
                                <span className="font-medium">{fmtDollars(balSelected.endBalances.pretax ?? 0)}</span>
                              </span>
                              <span>
                                <span className="text-[var(--dim)]">Taxable </span>
                                <span className="font-medium">{fmtDollars(balSelected.endBalances.taxable ?? 0)}</span>
                              </span>
                              <span>
                                <span className="text-[var(--dim)]">Roth </span>
                                <span className="font-medium">{fmtDollars(balSelected.endBalances.roth)}</span>
                              </span>
                              <span>
                                <span className="text-[var(--dim)]">Total </span>
                                <span className="font-semibold">
                                  {fmtDollars((balSelected.endBalances.pretax ?? 0) + (balSelected.endBalances.taxable ?? 0) + balSelected.endBalances.roth)}
                                </span>
                              </span>
                            </p>
                          </div>
                        )}
                        <p className="tnum mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--dim)]">
                          {balLayers.map((l) => {
                            const firstBal = balPoints[0];
                            const lastBal = balPoints[balPoints.length - 1];
                            const first = firstBal != null ? l.get(firstBal) : null;
                            const last = lastBal != null ? l.get(lastBal) : null;
                            return (
                              <span key={l.key} className="inline-flex items-center gap-1.5">
                                <span
                                  className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                                  style={{ background: l.color }}
                                  aria-hidden="true"
                                />
                                {l.label}{" "}
                                <span className="font-medium text-[var(--text)]">
                                  {fmtDollars(first ?? 0)} → {fmtDollars(last ?? 0)}
                                </span>
                              </span>
                            );
                          })}
                          <span className="inline-flex items-center gap-1.5">
                            Total{" "}
                            <span className="font-medium text-[var(--text)]">
                              {fmtDollars(balTotalAt(0))} → {fmtDollars(balEndingTotal)}
                            </span>
                          </span>
                        </p>
                      </div>
                    </>
                  );
                })()}
            </>
          )}
        </section>
        )}
          </>
        )}

        {/* Plain-English summary — the Projection face's
            sentence only (see the derivation above). The One
            year sentence was dropped in the wall-of-text
            build: it duplicated the Tax for the year and
            stacks-up cards below. */}
        {pgFace === "projection" && (
          <div aria-label="Playground summary in plain English" className="mt-3 max-w-3xl">
            <p className="text-sm text-[var(--text)]">
              {pgPlainProjSentence}
            </p>
          </div>
        )}


        {/* (The income strip — the "2026 income: Interest ·
            Ordinary · Qualified" line — was dropped in the
            wall-of-text build: the dials summary already
            carries the income total, and the breakdown lives
            in the Income dial card. The $0 warning below
            stays: it is the only signal when the year's
            income is $0, and it jumps to the income dials.) */}
        {/* $0 income warning — only when the year's income
            (Interest + Ordinary dividends; Qualified is part
            of Ordinary, not added again) is $0. Tapping it
            jumps to the income dials (Interest first), using
            the same jump-and-highlight as the provenance taps. */}
        {pgIncomeIsZero && (
          <button
            type="button"
            className="mt-2 w-full rounded-[var(--radius)] border border-[var(--warn)] bg-[var(--warn-soft)] px-3 py-2 text-left text-sm font-medium text-[var(--text)] hover:opacity-90"
            onClick={() => jumpToPgField("roth-Interest", "income")}
          >
            Your income for {pgTaxYearNum} is $0 — is that right?
          </button>
        )}

        {/* The single-year readout — the One year face's
            answer, below its dials. It renders on that face
            only; the Projection face's click-a-year readout
            (the balances readout inside the projection panel)
            is that face's equivalent, and clicking a chart
            year still loads the year into these same dials —
            switching back to One year shows it priced. */}
        {pgFace === "year" && playgroundResult == null && (
          <p className="mt-4 text-sm text-[var(--dim)]" role="note">
            Enter your age for the year above and the year is priced here —
            bracket landing, ACA cliff, and IRMAA, all from the same engine as
            the plan.
          </p>
        )}
        {pgFace === "year" && playgroundResult != null &&
          (() => {
            const pg = playgroundResult;
            const pgYearNum = parseIntField(pgYear) ?? new Date().getFullYear();
            // The entered pre-tax balance as buildPgInputs prices
            // it (negatives clamped to 0) — the readout's RMD
            // subtext and balance watch-out read it from here so
            // they name the same balance the engine priced. The
            // combined balance: the pricer prices the total
            // (primary + spouse) for the RMD and the
            // conversion-exceeds-balance watch-out. MFJ only
            // for the spouse's side (a balance typed under
            // MFJ stays in the dial when the filing changes).
            const pgPretaxRaw = parseDollars(pgPretax);
            const pgPretaxSpouseRaw =
              pgFiling === "mfj" ? parseDollars(pgPretaxSpouse) : null;
            const pgPretaxBalance =
              pgPretaxRaw == null && pgPretaxSpouseRaw == null
                ? null
                : Math.max(0, (pgPretaxRaw ?? 0) + (pgPretaxSpouseRaw ?? 0));
            const pgBalanceLeftAfterRmd =
              pgPretaxBalance == null ? null : pgPretaxBalance - pg.rmd;
            const takeawayParts: string[] = [];
            if (pg.conversion + pg.spendingDraw <= 0) {
              takeawayParts.push("No pre-tax money out typed");
            } else if (pg.landingBracketPct != null) {
              // Build v114: the room-left wording is gone
              // from this headline sentence (room-left site 1)
              // — the sentence names the landing bracket only,
              // exactly as it already did when no room figure
              // was priced. The other room-left sites (the
              // income-stack heading's status text, the gains
              // stack's 0% room segment, the ACA-cliff room
              // chips) are untouched.
              takeawayParts.push(
                pg.landingExactlyFilled
                  ? `Pre-tax money out fills the ${pg.landingBracketPct}% bracket exactly`
                  : `Pre-tax money out lands in the ${pg.landingBracketPct}% bracket`,
              );
            } else {
              takeawayParts.push(
                "The pre-tax money out is fully sheltered by deductions — none of it is taxed",
              );
            }
            takeawayParts.push(`MAGI ${fmtDollars(pg.magi)}`);
            if (pg.aca.applies && pg.aca.cliff != null && pg.aca.positionDollars != null) {
              // The cliff delta is measured from ACA household
              // income, not MAGI — when the two differ (partly
              // untaxed Social Security), the clause prints the
              // ACA figure it is measured from, so the delta
              // foots from a number on this line.
              const acaPos = pg.aca.positionDollars;
              const acaDelta = pg.aca.overCliff
                ? `over the ACA cliff by ${fmtDollars(-acaPos)}`
                : `under the ACA cliff by ${fmtDollars(acaPos)}`;
              takeawayParts.push(
                pg.acaMagi !== pg.magi
                  ? `ACA household income ${fmtDollars(pg.acaMagi)} — ${acaDelta}`
                  : acaDelta,
              );
            }
            if (pg.irmaa.applies) {
              takeawayParts.push(
                `IRMAA Tier ${pg.irmaa.tier} for ${pg.irmaa.premiumYear}`,
              );
            }
            /* Landing-headline explainer (build v77): the ⓘ
               on the landing headline, in the two-finish-lines
               way the question was answered in chat — every
               figure computed here from the priced result, no
               figure written in. Which text shows is decided
               from the priced figures alone. The ACA line is
               the cliff minus the typed buffer, measured on
               the ACA household income (pg.acaMagi) — the same
               basis the play strip's buffer readout measures
               it on, so the "on the line" / "under the line"
               standing foots with the figure the copy names
               as total income; when the two MAGI figures are
               the same (no untaxed Social Security) that
               figure is the headline's MAGI. Variant A: total
               income sits on the ACA line (within half a
               dollar, the play strip's own tolerance) with
               room left in the landing bracket — the ACA
               line stopped the money first. Variant B: total
               income is under the ACA line and the bracket
               top is the nearer line (room left no more than
               the distance to the ACA line) — the bracket
               stopped it first. Every other standing renders
               no ⓘ: no hard cliff (the brief's rule); the
               money fully sheltered or no landing bracket;
               no pre-tax money out; past the ACA line; the
               money stopping short of both lines; or the
               two lines coinciding (bracket filled exactly
               on the ACA line) — in each there is no
               binding-first line for the copy to name, and
               naming one would mislead. The Income stack
               heading's ⓘ below is untouched, and the
               headline wording itself is unchanged — the ⓘ
               only rides beside it. */
            const landingExplainerText: string | null = (() => {
              if (!pgAcaHasHardCliff) return null;
              const cliff = pg.aca.cliff;
              if (cliff == null) return null;
              if (pg.conversion + pg.spendingDraw <= 0) return null;
              const room = pg.landingRoomLeft;
              if (pg.landingBracketPct == null || room == null) {
                return null;
              }
              const bufferLine = cliff - pgAcaBufferDollars;
              const diff = bufferLine - pg.acaMagi;
              const lineName =
                pgAcaBufferDollars > 0 ? "ACA line" : "ACA cliff";
              const lineDesc =
                pgAcaBufferDollars > 0
                  ? `the ACA line of ${fmtDollars(bufferLine)} (the cliff of ${fmtDollars(cliff)} minus your ${fmtDollars(pgAcaBufferDollars)} safety buffer)`
                  : `the ACA cliff of ${fmtDollars(cliff)}`;
              if (Math.abs(diff) <= 0.5 && room > 0.5) {
                // Build v114: variant A reworded — it names
                // the two lines and which comes first, and no
                // longer names the room figure (no room-left
                // content anywhere in this tooltip).
                return `Think of two finish lines, and the pre-tax money stops at whichever comes first. Your total income is ${fmtDollars(pg.acaMagi)}, right on ${lineDesc}. The ${lineName} comes first, so it is the limit here — the top of the ${pg.landingBracketPct}% bracket sits just past it, unused.`;
              }
              if (diff > 0.5 && room <= diff + 0.5) {
                return `Think of two finish lines, and the pre-tax money stops at whichever comes first. The top of the ${pg.landingBracketPct}% bracket is the nearer finish line. Your total income is ${fmtDollars(pg.acaMagi)}, still ${fmtDollars(diff)} under ${lineDesc}. So the bracket top is the limit here, not the ${lineName}.`;
              }
              return null;
            })();
            const stackRow = (
              label: ReactNode,
              value: ReactNode,
              sub?: string,
              highlightValue?: boolean,
              // The highlight color for a highlighted value:
              // the teal accent by default; a caller that
              // prices money owed passes the red owed color.
              highlightClass = "text-[var(--accent)]",
            ) => (
              <div>
                <dt className="text-[var(--dim)]">{label}</dt>
                <dd className="tnum font-medium">
                  {highlightValue ? (
                    <span className={`font-bold ${highlightClass}`}>{value}</span>
                  ) : (
                    value
                  )}
                </dd>
                {sub && <dd className="text-xs text-[var(--dim)]">{sub}</dd>}
              </div>
            );
            /* Income-stacking chart — presentation ONLY. The
               segment model (segments, positions, bands,
               markers, hatch) comes from buildStackModel above.
               Every figure is read straight off the priced
               result (`pg`, pricePlaygroundYear's own fields);
               see buildStackModel's comment for the sourcing. */
            const stackModel = buildStackModel(pg, pgYearNum, pgFiling);
            /* Bracket-by-bracket status (build v69): the
               text the chart's legend used to print under the
               bar — every bracket top with its passed-by /
               room-left standing, and the 0% gains line — now
               computed once as this one string and carried by
               the Income stack heading's ⓘ, verbatim from the
               same figures the legend printed. */
            const bracketStatusText = [
              ...stackModel.markers.map(
                (m) =>
                  `${m.rate}% top ${fmtDollars(m.to)} — ${
                    m.room > 0.5
                      ? `${fmtDollars(m.room)} left`
                      : m.room >= -0.5
                        ? "filled exactly"
                        : `passed by ${fmtDollars(-m.room)}`
                  }`,
              ),
              `0% gains end ${fmtDollars(stackModel.zeroTop)} — ${
                stackModel.zeroTop - stackModel.ordinaryTaxable > 0.5
                  ? `${fmtDollars(stackModel.zeroTop - stackModel.ordinaryTaxable)} left`
                  : stackModel.zeroTop - stackModel.ordinaryTaxable >= -0.5
                    ? "filled exactly"
                    : `passed by ${fmtDollars(stackModel.ordinaryTaxable - stackModel.zeroTop)}`
              } · only taxable-account gains and qualified dividends get the 0% rate`,
            ].join(" · ");
            const stackChart = (() => {
              const {
                bands,
                markers,
                ordPos,
                gainsPos,
                visibleOrdSegs,
                gainsSegs,
                legendSegs,
                deductions,
                ordinaryTaxable,
                gainsTotal,
                axisTaxableMax,
                zeroTop,
                floor20,
                show20,
                pct,
                taxX,
                hatchStyle,
              } = stackModel;
              /* Legend provenance taps (build v144, extended
                 v142): only the legend items that ARE a dial
                 input are taps — they jump to that input field
                 (scroll + flash, via jumpToPgField). The others
                 stay plain text, per the standing rule that
                 computed figures are never taps:
                 - Interest → the Interest dial (income section).
                 - Pre-tax money out → the Pre-tax draw for
                   spending dial (conversion section) — the
                   segment is the two money-out dials' priced
                   sum; the tap lands on the first of them.
                 - Qualified dividends → the Qualified dividends
                   dial (stock section).
                 - Ordinary dividends (non-qualified part) →
                   the Ordinary dividends total dial
                   (income section, build v142): the
                   non-qualified figure itself is computed
                   (ordinary total minus qualified, from TWO
                   inputs), so the tap goes to the parent
                   figure it belongs to — the total dial.
                 Plain text, no tap:
                 - Deductions — the standard deduction from the
                   year's law table (the standard won over the
                   itemized inputs); no input field.
                 Field ids are the moneyField ids (roth- + the
                 label with non-alphanumerics as dashes). */
              const legendTapTargets: Record<
                string,
                { fieldId: string; section: PgSectionId; ariaLabel: string }
              > = {
                interest: {
                  fieldId: "roth-Interest",
                  section: "income",
                  ariaLabel: "Go to the Interest field",
                },
                orddiv: {
                  fieldId: "roth-Ordinary-dividends-total",
                  section: "income",
                  ariaLabel: "Go to the Ordinary dividends field",
                },
                conv: {
                  fieldId: "roth-Pre-tax-draw-for-spending",
                  section: "conversion",
                  ariaLabel: "Go to the Pre-tax money out fields",
                },
                qualdiv: {
                  fieldId: "roth-Qualified-dividends",
                  section: "stock",
                  ariaLabel: "Go to the Qualified dividends field",
                },
              };
              /* ACA cliff line — presentation ONLY, derived
                 from the priced result in the chart's own
                 coordinates: the line sits at the taxable-axis
                 position cliff − (acaMagi − taxableIncome), so
                 a year priced exactly on the cliff (acaMagi =
                 cliff) draws the line exactly at the stack's
                 end (taxableIncome's position). The offset is
                 read off the priced year — NOT assumed to be
                 the deductions — because tax-exempt interest
                 and the untaxed part of Social Security move
                 the MAGI↔taxable gap. Shown only when the
                 priced year carries a hard cliff (the same
                 applicability rule as the ACA cliff chip: ACA
                 applies with a cliff figure, coverage 2026+)
                 and the derived position falls inside the
                 drawn axis; outside the axis no line is drawn
                 rather than a misleading one. */
              const acaCliffLine = (() => {
                if (pgYearNum < 2026) return null;
                if (!pg.aca.applies || pg.aca.cliff == null) return null;
                const taxablePos =
                  pg.aca.cliff - (pg.acaMagi - pg.taxableIncome);
                if (taxablePos < 0 || taxablePos > axisTaxableMax) {
                  return null;
                }
                return { xPct: taxX(taxablePos), cliff: pg.aca.cliff };
              })();
              /* Buffer line (build v69): the same
                 construction aimed at cliff − buffer — the
                 MAGI the dials actually target. Drawn only
                 when a hard cliff applies (the same rule as
                 the cliff line) and a buffer above $0 is
                 entered, and only inside the drawn axis. */
              const acaBufferLine = (() => {
                if (acaCliffLine == null) return null;
                if (!pgAcaHasHardCliff || pgAcaBufferDollars <= 0) {
                  return null;
                }
                const target = pg.aca.cliff! - pgAcaBufferDollars;
                const taxablePos =
                  target - (pg.acaMagi - pg.taxableIncome);
                if (taxablePos < 0 || taxablePos > axisTaxableMax) {
                  return null;
                }
                return { xPct: taxX(taxablePos), magi: target };
              })();
              /* Floating landmark labels (build v75): exactly
                 TWO of the pre-v69 floating labels return — the
                 LANDING bracket's top label (the first bracket
                 whose top is at or above the ordinary taxable
                 total; build v89: the bracket rate only, the
                 pre-v69 "rate · room left" tail removed — from
                 the same marker figures the heading's ⓘ
                 status string uses) and the "0% gains end" label
                 at its tick, in its pre-v69 form with its small
                 ⓘ. No labels for passed or higher brackets.
                 Collision discipline: when both labels are
                 present they sit on TWO distinct rows — gains
                 end on the upper row, the landing bracket on
                 the row below it — so their text can never
                 overlap however close their ticks sit; each
                 label stays anchored at its tick, with its
                 centre clamped inside the chart (a tick at the
                 right edge right-aligns its label) so neither
                 label can overflow the card at any width. */
              const landingIndex = markers.findIndex(
                (m) => m.room >= 0,
              );
              const landingMarker =
                landingIndex >= 0 ? (markers[landingIndex] ?? null) : null;
              /* Build v89: the landing label shows the
                 bracket rate only — the "· $X left" tail and
                 the v82 ⓘ beside it are removed at the user's
                 direction (the room figure confused more
                 than it helped); position, anchoring, font,
                 colour, and stagger behaviour are unchanged.
                 Build v114: an ⓘ returns beside the rate
                 (the landing tooltip, composed from the priced
                 figures, with no room figure in it), and a
                 thin connector line drops from the label to
                 its dashed guide line — see the label block
                 below. */
              const showGainsEndLabel = gainsTotal > 0;
              /* Axis-row stacking (build v76): whether the
                 cliff and buffer axis labels sit close enough
                 to need two rows. On narrow screens the
                 axis-end figure also needs its own row: at
                 phone width the cliff label and the axis-end
                 figure share the first row and collide (the
                 cliff label is long and its line sits near
                 the right edge, now that headroom draws it
                 on the chart), so below the small-screen
                 breakpoint the axis-end figure drops to a
                 row of its own — a third row when both
                 marker labels are present, a second row
                 when only the cliff label is — while at
                 desktop widths the rows are exactly as
                 before. The marker labels' wording and
                 positions are unchanged at every width.
                 Build v84: the bracket-top tick labels
                 no longer live below the bar at all (see
                 below), so the axis block below the bar is
                 back to exactly these pre-v83 rows — the
                 $0 / cliff / buffer labels sit on the row
                 directly under the bar, as they did before
                 the tick row existed. */
              const axisLinesClose =
                acaCliffLine != null &&
                acaBufferLine != null &&
                Math.abs(acaCliffLine.xPct - acaBufferLine.xPct) < 30;
              /* Bracket-top tick labels (build v77, anchored
                 build v79, moved to the line tops contract
                 v84): one small tick label for each bracket
                 top whose guide line is drawn — the same
                 inAxis rule the lines use, judged against
                 the pre-headroom base axis end, so a top
                 beyond the axis end renders nothing and a
                 tick never names a line that is not drawn.
                 The labels live ABOVE the bar, at the top
                 ends of their own dashed guide lines: a
                 16px strip at the top of the chart block
                 carries them, each label's centre exactly
                 on its line (the same taxX(m.to) the
                 overlay line uses, centred with
                 translateX(-50%)), with the same 24px edge
                 clamp as before (the card-edge bound the
                 tick labels themselves carry, not the
                 floating labels' chart-edge bound). Below
                 the strip a 10px spacer carries the dashed
                 lines up past the gains track, so each
                 label sits above the gains segment with
                 its line visibly running up to it — the
                 strip and spacer are flow content above
                 the bar area, and the lines, the band
                 tints, and the white-line ⓘ live in the
                 bar-area wrapper below them, starting 4px
                 above the bar's top (the same absolute
                 spot the old 26px offset put them) while
                 ticks are present, and at the bar's top
                 exactly as before when no tick is drawn.
                 COLLISION: neighbouring labels that would
                 touch at phone width are staggered by the
                 strip itself (see TickStrip) — a label
                 drops to a second row, still centred on
                 its line, and the flow layout carries the
                 bar down with it. CLEARANCE: the tick strip is a flow
                 row below the floating labels and the
                 Buffer label row above the bar, so a tick label
                 can never overlap a floating label however
                 close a bracket top sits to the landing or
                 gains-end tick — the Buffer label row stands
                 between them when a hard cliff applies, and
                 the strip's own top margin keeps 4px of
                 daylight when it does not. Within the strip
                 the tops sit a whole bracket apart. Rate
                 and top are read off the same marker
                 figures the guide lines and the heading's
                 ⓘ use — no figure is written in. */
              const axisBracketTicks = markers.filter((m) => m.inAxis);
              const hasAxisTicks = axisBracketTicks.length > 0;
              /* The bar-area overlays start 4px above the
                 bar's top while ticks are present (the
                 strip + spacer sit above the bar-area
                 wrapper, so this is the same absolute
                 spot the old 26px-from-the-chart-top
                 offset put them); 0 when no tick is
                 drawn, so a tickless chart is
                 pixel-identical to before v84. */
              const barOverlayTopPx = hasAxisTicks ? -4 : 0;
              const axisHeightCls = axisLinesClose
                ? "h-12 sm:h-8"
                : acaCliffLine != null
                  ? "h-8 sm:h-4"
                  : "h-4";
              const axisMagiRowTop = "";
              const axisBufferRowTop = axisLinesClose ? "top-4" : "";
              /* Build v115: the fallback is an explicit
                 top-0, not "": the axis-end span now rides
                 outside the axis block (see its render below),
                 so it can no longer take the block's top from
                 its static position inside it — an explicit
                 top-0 against the shared row box resolves to
                 exactly that same spot. */
              const axisEndRowTop = axisLinesClose
                ? "top-8 sm:top-0"
                : acaCliffLine != null
                  ? "top-4 sm:top-0"
                  : "top-0";
              return (
                <div className="mt-3" aria-label="Income stacking chart">
                  <p className="mt-1 text-xs text-[var(--dim)]">
                    On a taxable-income axis. The hatched start of the bar is
                    the {fmtDollars(deductions)} of deductions sheltering the
                    first dollars — the stack nets to{" "}
                    {fmtDollars(ordinaryTaxable)} of ordinary taxable income
                    {gainsTotal > 0
                      ? `, ${fmtDollars(pg.taxableIncome)} with gains on top`
                      : ""}
                    .
                  </p>
                  {(landingMarker != null || showGainsEndLabel) && (
                    <div className="relative mt-1" ref={stackLabelsRef}>
                      {showGainsEndLabel && (
                        <div className="relative h-[18px]">
                          <span
                            className="absolute inline-flex items-center whitespace-nowrap"
                            style={{
                              left: `clamp(78px, ${taxX(zeroTop)}%, calc(100% - 78px))`,
                              transform: "translateX(-50%)",
                              /* Lift this label's stacking context
                                 above the chart-area wrapper below
                                 (build v87, mirroring the v82
                                 landing-label lift): the centring
                                 transform traps the bubble's own
                                 z-index inside this span, so
                                 without a z-index here the later
                                 chart-area sibling — bars, tick
                                 labels, guide lines, tint, and
                                 the z-1 gains track — paints over
                                 the downward-opening bubble.
                                 Build v120: while this label's
                                 own bubble is open the span lifts
                                 to 25, above its sibling labels,
                                 so the bubble paints above them
                                 too. Build v129: the lift is
                                 z-20, below the z-30 sticky play
                                 strip, so the label slides under
                                 the strip when the chart scrolls
                                 under it. */
                              zIndex: chartLabelZ("zero"),
                            }}
                          >
                            <span
                              aria-hidden="true"
                              className="tnum text-[11px]"
                              style={{ color: "#db2777" }}
                            >
                              0% gains end · {fmtDollars(zeroTop)}
                            </span>
                            <InfoNote
                              text={`Long-term gains and qualified dividends in the taxable account are taxed at 0% while total taxable income stays under ${fmtDollars(zeroTop)}. Past that line they price at 15%, and at 20% once taxable income passes ${fmtDollars(floor20)}.`}
                              ariaLabel="About the 0% gains line"
                              align={taxX(zeroTop) > 60 ? "right" : "left"}
                              onOpenChange={(open) => setChartLabelOpen("zero", open)}
                            />
                          </span>
                        </div>
                      )}
                      {landingMarker != null && (
                          <div className="relative h-[18px]">
                            {/* Landing-bracket label (contract
                                v89): rate only — the "· $X left"
                                tail and the v82 ⓘ are removed;
                                the label stays aria-hidden (its
                                figure is already in the chart's
                                accessible description). Contract
                                v114: the ⓘ returns beside the
                                rate, carrying the bracket's own
                                explainer (the landing tooltip —
                                what the bracket is and the
                                ordinary taxable income sitting
                                in it, composed live; no room
                                figure, per the v114 headline
                                rule). The label's text, position,
                                anchoring, font, colour, and
                                z-index are unchanged. */}
                            <span
                              className="absolute inline-flex items-center whitespace-nowrap"
                              style={{
                                color: landingMarker.color,
                                left: `clamp(66px, ${taxX(landingMarker.to)}%, calc(100% - 66px))`,
                                transform: "translateX(-50%)",
                                /* Stacking lift (build v129):
                                   the label rides at z-20 — above
                                   the chart-area content below it
                                   but below the z-30 sticky play
                                   strip, so it slides under the
                                   strip when the chart scrolls
                                   under it instead of painting
                                   over its text (the v82 lift had
                                   it at z-31, above the strip,
                                   which is the overlap the user
                                   reported); removing the ⓘ must
                                   not move the label's paint order.
                                   Build v120: while this
                                   label's own bubble is open the
                                   span lifts to 25, above its
                                   sibling labels, so the bubble
                                   paints above them too. */
                                zIndex: chartLabelZ("landing"),
                              }}
                            >
                              <span
                                aria-hidden="true"
                                className="tnum text-[11px]"
                              >
                                {landingMarker.rate}%
                              </span>
                              <InfoNote
                                text={`Your ordinary income lands in this bracket — ${fmtDollars(ordinaryTaxable)} of ordinary taxable income sits in the ${landingMarker.rate}% bracket, the rate on your last dollars of ordinary income.`}
                                ariaLabel={`About the ${landingMarker.rate}% landing bracket`}
                                align={taxX(landingMarker.to) > 60 ? "right" : "left"}
                                onOpenChange={(open) => setChartLabelOpen("landing", open)}
                              />
                            </span>
                          </div>
                        )}
                      {/* Landing-label connector (contract
                          v114): a thin leader line in the
                          landing marker's own colour, dropped
                          from the bottom of this label block at
                          the marker's tick position down to the
                          top of its dashed guide line — the
                          height is the measured gap (see
                          landingLinkH at the component level),
                          so the line ends exactly where the
                          dashed line begins, through the buffer
                          label row and the tick strip, at any
                          width. Drawn only when the marker's
                          dashed line is drawn (inAxis). */}
                      {landingMarker != null && landingMarker.inAxis && landingLinkH != null && (
                        <div
                          aria-hidden="true"
                          className="pointer-events-none absolute"
                          style={{
                            left: `${taxX(landingMarker.to)}%`,
                            top: "100%",
                            height: landingLinkH,
                            borderLeft: `1px solid ${landingMarker.color}`,
                          }}
                        />
                      )}
                    </div>
                  )}
                  {/* Buffer label (build v85): the v79
                      bracket's label WITHOUT the brace — the
                      tinted buffer span below (see the chart
                      area) now marks the zone, so the brace
                      with its end ticks is gone. The label
                      itself stays, centred on the span at the
                      same horizontal centre the bracket label
                      used, its centre clamped inside the chart
                      so a narrow span (a small buffer) or a
                      span near an edge never overflows. It
                      lives on a row of its own below the
                      floating labels above, so it can never
                      overlap them. It renders only when both
                      lines render: a hard cliff applies and
                      the buffer is above $0 (at $0 the lines
                      coincide and there is no span — the
                      single line is identified by the axis
                      label alone); with no hard cliff nothing
                      renders, as before. The figure is composed
                      live from the typed buffer dollars —
                      never written in. The dashed lines
                      themselves and the two-row axis labels
                      below are unchanged. */}
                  {acaCliffLine != null && acaBufferLine != null && (
                    <div className="relative h-[26px]">
                      {/* Build v114: the label gains the
                          buffer ⓘ (the 0% InfoNote pattern —
                          live-composed text, align by the
                          label's position, the z-20 lift on
                          its span, which the centring
                          transform requires for the bubble to
                          paint above the chart area). The
                          label text itself stays aria-hidden
                          and centred exactly as before; only
                          the wrapper's aria-hidden comes off,
                          so the ⓘ button is reachable. */}
                      <span
                        className="absolute top-0 inline-flex items-center whitespace-nowrap"
                        style={{
                          left: `clamp(40px, ${(acaBufferLine.xPct + acaCliffLine.xPct) / 2}%, calc(100% - 40px))`,
                          transform: "translateX(-50%)",
                          /* Build v120: while this label's own
                             bubble is open the span lifts to 25,
                             above its sibling labels, so the
                             bubble paints above them too. Contract
                             v129: the lift is z-20, below the z-30
                             sticky play strip. */
                          zIndex: chartLabelZ("buffer"),
                        }}
                      >
                        <span
                          aria-hidden="true"
                          className="tnum text-[11px] font-medium"
                          style={{ color: "var(--dim)" }}
                        >
                          Buffer {fmtDollars(pgAcaBufferDollars)}
                        </span>
                        <InfoNote
                          text={`Your safety margin under the ACA cliff. The cliff is ${fmtDollars(acaCliffLine.cliff)}; the buffer stops your income ${fmtDollars(pgAcaBufferDollars)} short of it, at ${fmtDollars(acaBufferLine.magi)}, so a small surprise doesn't wipe out the whole credit.`}
                          ariaLabel="About the ACA safety buffer"
                          align={(acaBufferLine.xPct + acaCliffLine.xPct) / 2 > 60 ? "right" : "left"}
                          onOpenChange={(open) => setChartLabelOpen("buffer", open)}
                        />
                      </span>
                    </div>
                  )}
                  <div className="relative" ref={stackChartRef}>
                    {/* Buffer-span tint (build v85): the
                        region between the buffer dashed line
                        and the cliff dashed line, filled with
                        a translucent tint in the cliff line's
                        colour (var(--warn)), running the full
                        height of the chart area — from the top
                        of the tick-label strip, through the
                        bar, to the axis. It renders on exactly
                        the gate the v79 bracket used: both
                        lines render (a hard cliff applies and
                        the buffer is above $0); at a $0 buffer
                        or with no hard cliff there is no tint,
                        as there was no bracket. It is the
                        FIRST child of this wrapper and
                        absolutely positioned, so it paints
                        BEHIND everything in the chart area —
                        the tick labels, the bar segments, the
                        dashed lines, and the white-line ⓘ all
                        sit in later siblings and paint over
                        it — and it takes no space in flow, so
                        it changes no measured geometry: the
                        TickStrip stagger measurement still
                        sees the real label spans. Pointer
                        events pass straight through it, so it
                        can never swallow a tap on the ⓘ. */}
                    {acaCliffLine != null && acaBufferLine != null && (
                      <div
                        aria-hidden="true"
                        className="pointer-events-none absolute top-0 bottom-0"
                        style={{
                          left: `${acaBufferLine.xPct}%`,
                          width: `${Math.max(0, acaCliffLine.xPct - acaBufferLine.xPct)}%`,
                          background:
                            "color-mix(in srgb, var(--warn) 15%, transparent)",
                        }}
                      />
                    )}
                    {/* Bracket-top tick labels at the top ends
                        of their guide lines (build v84):
                        the strip above the bar, then the
                        10px spacer the dashed lines run up
                        through to meet the labels. Both render
                        only while a tick is drawn; the strip
                        staggers colliding labels to a second
                        row itself, and the bar-area wrapper
                        below flows down with it. */}
                    {hasAxisTicks && (
                      <TickStrip
                        ticks={axisBracketTicks.map((m) => {
                          /* Build v114: the landing bracket's
                             tick carries the bracket-top ⓘ,
                             composed live from the same marker
                             figures and the law row's rate list
                             (the rate past this top is the next
                             band's rate). Every other tick is
                             note-free, exactly as before. */
                          if (
                            landingMarker == null ||
                            m.rate !== landingMarker.rate
                          ) {
                            return m;
                          }
                          const nextRate =
                            lawForYear(pgYearNum).rates[
                              markers.findIndex((x) => x.rate === m.rate) + 1
                            ];
                          return {
                            ...m,
                            note: `The top of the ${m.rate}% bracket: ordinary taxable income up to ${fmtDollars(m.to)}.${nextRate != null ? ` Past this line, the ${nextRate}% rate starts.` : ""}`,
                            noteAriaLabel: `About the ${m.rate}% bracket top`,
                          };
                        })}
                        taxX={taxX}
                      />
                    )}
                    <div className="relative">
                    <div
                      className="absolute right-0 bottom-0 left-0"
                      style={{ top: barOverlayTopPx }}
                      aria-hidden="true"
                    >
                      {bands.map((b, i) => (
                        <div
                          key={b.rate}
                          className="absolute top-0 bottom-0"
                          style={{
                            left: `${taxX(b.from)}%`,
                            width: `${Math.max(0, taxX(b.to) - taxX(b.from))}%`,
                            background:
                              i % 2 === 0
                                ? "rgba(128,128,128,0.07)"
                                : "rgba(20,89,76,0.08)",
                          }}
                        />
                      ))}
                    </div>
                    {gainsTotal > 0 && (
                      <div className="relative h-5" role="img" aria-label={`Gains stack: ${gainsSegs.map((s) => `${s.label} ${fmtDollars(s.amount)}`).join(", ")}`}>
                        {gainsPos.map((s) => (
                          <div
                            key={s.key}
                            className="absolute top-0 flex h-5 items-center justify-center overflow-hidden"
                            style={{
                              left: `${s.leftPct}%`,
                              width: `${s.widthPct}%`,
                              background: s.color,
                              /* S-9: a hatched segment (the
                                 §1211(b) allowance) wears the
                                 deductions hatch over its base
                                 colour, marking the tail of the
                                 stack the allowance removes. */
                              ...(s.hatch ? hatchStyle : {}),
                            }}
                          >
                            {s.wide && (
                              <span className="truncate px-1 text-[11px] font-medium text-white">
                                {s.short ?? s.label} {fmtDollars(s.amount)}
                              </span>
                            )}
                          </div>
                        ))}
                        <div
                          className="absolute top-0 bottom-0 border-l-2 border-dashed"
                          style={{ left: `${taxX(zeroTop)}%`, borderColor: "#db2777" }}
                          aria-hidden="true"
                        />
                        {show20 && (
                          <div
                            className="absolute top-0 bottom-0 border-l-2 border-dashed"
                            style={{ left: `${taxX(floor20)}%`, borderColor: "#ea580c" }}
                            aria-hidden="true"
                          />
                        )}
                      </div>
                    )}
                    <div
                      className={`relative h-10 ${gainsTotal > 0 ? "mt-1" : ""}`}
                      role="img"
                      aria-label={`Ordinary income stack: ${visibleOrdSegs.map((s) => `${s.label} ${fmtDollars(s.amount)}`).join(", ")}, less deductions ${fmtDollars(deductions)}, nets to ${fmtDollars(ordinaryTaxable)} of ordinary taxable income`}
                    >
                      {ordPos.map((s) => (
                        <div
                          key={s.key}
                          className="absolute top-0 flex h-10 items-center justify-center overflow-hidden border-r border-[var(--bg)]"
                          style={{
                            left: `${s.leftPct}%`,
                            width: `${s.widthPct}%`,
                            background: s.color,
                          }}
                        >
                          {s.wide && (
                            <span className="truncate px-1 text-[11px] font-medium text-white">
                              {s.short ?? s.label} {fmtDollars(s.amount)}
                            </span>
                          )}
                        </div>
                      ))}
                      {deductions > 0 && (
                        <div
                          className="pointer-events-none absolute top-0 h-10"
                          style={{ left: 0, width: `${pct(deductions)}%`, ...hatchStyle }}
                          aria-hidden="true"
                        />
                      )}
                    </div>
                    <div
                      className="pointer-events-none absolute right-0 bottom-0 left-0"
                      style={{ top: barOverlayTopPx }}
                      aria-hidden="true"
                      ref={stackLinesRef}
                    >
                      {markers
                        .filter((m) => m.inAxis)
                        .map((m) => (
                          <div
                            key={m.rate}
                            className="absolute top-0 bottom-0 border-l border-dashed"
                            style={{ left: `${taxX(m.to)}%`, borderColor: m.color }}
                          />
                        ))}
                      <div
                        className="absolute top-0 bottom-0 border-l"
                        style={{ left: `${taxX(0)}%`, borderColor: "var(--dim)" }}
                      />
                      {zeroTop <= axisTaxableMax && (
                        <div
                          className="absolute top-0 bottom-0 border-l-2 border-dashed"
                          style={{
                            left: `${taxX(zeroTop)}%`,
                            borderColor: "#db2777",
                          }}
                        />
                      )}
                      {acaCliffLine != null && (
                        <div
                          className="absolute top-0 bottom-0 border-l-2 border-dashed"
                          style={{
                            left: `${acaCliffLine.xPct}%`,
                            borderColor: "var(--warn)",
                          }}
                        />
                      )}
                      {acaBufferLine != null && (
                        <div
                          className="absolute top-0 bottom-0 border-l border-dashed"
                          style={{
                            left: `${acaBufferLine.xPct}%`,
                            borderColor: "var(--dim)",
                          }}
                        />
                      )}
                    </div>
                    {/* White-line ⓘ (build v79, amendment): the
                        shared InfoNote ⓘ at the top of the solid
                        $0 line, where the deductions hatch ends.
                        Its copy is plain English composed live
                        from the priced deductions total — never
                        written in — and names it simply
                        "the line", with no colour claim
                        (build v88). The
                        marker sits inside the bar at the line's
                        top, clear of the floating labels and the
                        bracket row above, with its centre
                        clamped inside the chart so a $0 line at
                        an edge never overflows. It renders
                        whenever the $0 line renders — the line
                        is unconditional in this chart, so the
                        marker is too. The bubble is the plain
                        absolute one the other chart ⓘs use,
                        opening below the marker — NOT the
                        viewport-clamped variant: that variant
                        positions fixed against the viewport,
                        and a centring transform on this
                        marker's wrapper would capture fixed
                        positioning and land the bubble far
                        from the marker (verified live in the
                        rendered pass: the clamped bubble
                        never appeared near the marker). The
                        wrapper therefore centres with a
                        negative margin and carries no
                        transform at all. The plain bubble's align flips
                        near the right edge and its width is
                        capped to the viewport, so it stays on
                        screen at phone width. */}
                    <div
                      className="absolute z-10"
                      style={{
                        /* Build v84: the marker sits at the
                           top of the BAR area — below the tick
                           strip and dash spacer while ticks are
                           present, at the chart's top as before
                           when none are. The bar-area wrapper
                           starts below the strip, so 4px above
                           the bar is the same spot as the old
                           offset. */
                        top: barOverlayTopPx,
                        left: `clamp(11px, ${taxX(0)}%, calc(100% - 11px))`,
                        /* Centre on the line with a negative
                           margin, NOT a translateX transform:
                           the marker's wrapper must carry no
                           transform — with the old viewport-
                           clamped bubble, the centring
                           transform captured its fixed
                           positioning and landed it far from
                           the marker (verified live in the
                           rendered pass). Margin centring
                           keeps every transform out of the
                           marker's ancestry, and the plain
                           bubble below is verified painting.
                           The span is 22px wide (18px button +
                           the 4px ml-1), so −11px centres it
                           exactly as translateX(-50%) did. */
                        marginLeft: "-11px",
                      }}
                    >
                      <InfoNote
                        text={`Taxable income starts at the line. The ${fmtDollars(deductions)} to the left is deductions — income the tax doesn't touch. Everything to the right of the line counts, starting at $0.`}
                        ariaLabel="About the $0 taxable line"
                        align={taxX(0) > 60 ? "right" : "left"}
                      />
                    </div>
                    </div>
                  </div>
                  <div className="relative mt-1">
                  <div
                    className={`relative ${axisHeightCls}`}
                    aria-hidden="true"
                  >
                    <span
                      className={`tnum absolute ${axisMagiRowTop} text-[11px] whitespace-nowrap text-[var(--dim)]`}
                      style={{
                        left: `${taxX(0)}%`,
                        transform:
                          taxX(0) < 15 ? "translateX(-8%)" : "translateX(-50%)",
                      }}
                    >
                      $0 taxable
                    </span>
                    {acaCliffLine != null && (
                      <span
                        className={`tnum absolute ${axisMagiRowTop} text-[11px] font-medium whitespace-nowrap`}
                        style={{
                          left: `${acaCliffLine.xPct}%`,
                          color: "var(--warn)",
                          transform:
                            acaCliffLine.xPct > 85
                              ? "translateX(-92%)"
                              : acaCliffLine.xPct < 15
                                ? "translateX(-8%)"
                                : "translateX(-50%)",
                        }}
                      >
                        ACA cliff · MAGI {fmtDollars(acaCliffLine.cliff)}
                      </span>
                    )}
                    {acaBufferLine != null && (
                      <span
                        className={`tnum absolute text-[11px] whitespace-nowrap text-[var(--dim)] ${axisBufferRowTop}`}
                        style={{
                          left: `${acaBufferLine.xPct}%`,
                          transform:
                            acaBufferLine.xPct > 85
                              ? "translateX(-92%)"
                              : acaBufferLine.xPct < 15
                                ? "translateX(-8%)"
                                : "translateX(-50%)",
                        }}
                      >
                        Buffer · MAGI {fmtDollars(acaBufferLine.magi)}
                      </span>
                    )}
                    {/* Build v84: the bracket-top tick labels
                        moved to the top ends of their guide
                        lines, above the bar — nothing renders
                        for them in this below-bar block. */}
                  </div>
                  {/* Build v115: the axis-end figure — the
                      right end of the chart's scale — gains the
                      ⓘ (the 0% InfoNote pattern: live-composed
                      copy, align by the label's position, the
                      z-20 lift on its span). The label sits at
                      the axis's right end by construction, so
                      its bubble aligns right. The note's text
                      carries no figure; the figure beside it is
                      composed live from axisTaxableMax, exactly
                      as before — nothing is written in. The span
                      rides OUTSIDE the aria-hidden axis block,
                      wrapped with it in one relative row box so
                      its right anchor and row tops resolve
                      against the same box the block occupies —
                      the v114 buffer-label discipline: a button
                      inside aria-hidden is unreachable, so the
                      figure text alone carries aria-hidden and
                      the ⓘ stays reachable. Because the ⓘ is
                      inside the figure's own span, it travels
                      with the figure in both layouts: the
                      desktop axis row, and the phone-width
                      layout below 640px where axisEndRowTop
                      drops the figure to a row of its own. The
                      $0 taxable label and its ⓘ are untouched. */}
                  <span
                    className={`tnum absolute inline-flex items-center text-[11px] whitespace-nowrap text-[var(--dim)] ${axisEndRowTop}`}
                    /* Build v120: while this label's own
                       bubble is open the span lifts to 25,
                       above its sibling labels, so the bubble
                       paints above them too. Build v129:
                       the lift is z-20, below the z-30 sticky
                       play strip. */
                    style={{ right: 0, zIndex: chartLabelZ("axisEnd") }}
                  >
                    <span aria-hidden="true">
                      {fmtDollars(axisTaxableMax)}
                    </span>
                    <InfoNote
                      text="The right end of the chart's scale. The scale runs a little past the furthest line on the chart so nothing piles up at the right edge — this is where the ruler stops, not income, tax, or a bracket top."
                      ariaLabel="About the end of the chart's scale"
                      align="right"
                      onOpenChange={(open) => setChartLabelOpen("axisEnd", open)}
                    />
                  </span>
                  </div>
                  <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--dim)]">
                      {(
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm border border-[var(--dim)]"
                            style={hatchStyle}
                            aria-hidden="true"
                          />
                          Deductions{" "}
                          <span className="tnum font-medium text-[var(--text)]">
                            −{fmtDollars(deductions)}
                          </span>
                        </span>
                      )}
                      {legendSegs.map((s) => {
                        const tap = legendTapTargets[s.key];
                        const text = (
                          <>
                            {s.label}{" "}
                            <span className="tnum font-medium text-[var(--text)]">
                              {fmtDollars(s.amount)}
                            </span>
                          </>
                        );
                        return (
                          <span key={s.key} className="inline-flex items-center gap-1.5">
                            <span
                              className={`inline-block h-2.5 w-2.5 shrink-0 rounded-sm${s.hatch ? " border border-[var(--dim)]" : ""}`}
                              style={s.hatch ? hatchStyle : { background: s.color }}
                              aria-hidden="true"
                            />
                            {tap ? (
                              <button
                                type="button"
                                aria-label={tap.ariaLabel}
                                className={pgTapCls}
                                onClick={() =>
                                  jumpToPgField(tap.fieldId, tap.section)
                                }
                              >
                                {text}
                              </button>
                            ) : (
                              text
                            )}
                          </span>
                        );
                      })}
                  </p>
                  {visibleOrdSegs.length === 0 && gainsTotal <= 0 && (
                    <p className="mt-1 text-xs text-[var(--dim)]" role="note">
                      No income typed yet — the stack will draw here as you
                      type.
                    </p>
                  )}
                </div>
              );
            })();
            /* Income-stack cliff markers — presentation ONLY:
               insertions into the "How {year} stacks up" stack
               below, plus one closing room note under it. No
               figure is priced here: the ACA cliff, the ACA
               position, the IRMAA tier, the per-person monthly
               surcharge, the premium year, and the next IRMAA
               line with its room all come straight off the
               priced result (`pg` — the same fields the ACA &
               IRMAA block above prints). The one line not
               stored on the result — the IRMAA tier line the
               landed tier crossed (the floor of the landed
               tier) — is read from the SAME law row the pricing
               used, through the engine's own classifier helper
               irmaaTierUpTo(tier − 1, …) at the playground's 0%
               inflation, exactly as pricePlaygroundYear derives
               its stored nextTierLine from irmaaTierUpTo(tier, …).
               Placement: the stack's additive rows are walked
               in their printed order, accumulating TWO running
               totals — one per MAGI definition — from the SAME
               row values the block prints. Every printed row
               counts the same toward both MAGIs except Social
               Security received: IRMAA MAGI counts only the
               TAXABLE part (pg.ssTaxable) while ACA MAGI counts
               the FULL benefit (pg.ssBenefits) — that is the
               whole difference between the two totals (MAGI =
               AGI + tax-exempt interest; ACA MAGI = MAGI + the
               untaxed part of Social Security), so the two
               markers can correctly land on different rows.
               Tax-exempt interest counts toward both (it is the
               printed row between Social Security and the
               conversion). A marker is inserted immediately
               after the first row whose cumulative total for
               its own MAGI passes its line (strictly over —
               the engine's own tests: ACA overCliff is
               acaMagi > cliff, and an IRMAA tier starts once
               MAGI is over the previous tier's ceiling). The
               AGI / deduction / taxable-income rows after the
               gains row are not additive to MAGI and never
               carry a marker. The ACA cliff exists only for
               coverage 2026+ (the engine's hasCliff rule in
               acaCreditFor): in 2025 the result still carries
               the 400%-of-FPL figure, but no marker is placed
               and the closing note says so instead. */
            const stackBlock = (() => {
              type StackEntry = {
                key: string;
                node: ReactNode;
                aca: number;
                irmaa: number;
              };
              /* P-S12: the "Long-term gains priced" row's
                 sub-text decomposes the PRICED figure beside
                 it — the priced net gain part, max(0,
                 pg.ltcgNet), plus the qualified dividends —
                 the two addends of pg.ltcgPriced itself
                 (ltcgPriced = max(0, ltcgNet) +
                 qualifiedDividends in the shared pricer), so
                 the sentence adds to the row value. The typed
                 sale gain (pg.stockGain) is gross and
                 pre-ledger: an entering loss carryforward
                 nets against it and a priced harvest adds to
                 it before ltcgNet is struck, and a losing
                 sale floors at $0 in the priced part, so a
                 sub-text built from the typed figure
                 disagreed with the row value by the absorbed
                 / harvested / floored amount — the same
                 reason the S-9 stack above forbids the typed
                 figure for its gain segment. When a harvest
                 priced a gain it is named inside the net
                 figure it rides (it is already inside
                 ltcgNet, never an extra addend). */
              const pricedGainPart = Math.max(0, pg.ltcgNet);
              const gainsSubText =
                pg.harvestedGain > 0
                  ? `Net long-term gain ${fmtDollars(pricedGainPart)} (incl. harvested gain ${fmtDollars(pg.harvestedGain)}) + qualified dividends ${fmtDollars(pg.qualifiedDividends)}`
                  : `Net long-term gain ${fmtDollars(pricedGainPart)} + qualified dividends ${fmtDollars(pg.qualifiedDividends)}`;
              const additive: StackEntry[] = [
                {
                  key: "interest",
                  node: stackRow("Interest", fmtDollars(pg.interest)),
                  aca: pg.interest,
                  irmaa: pg.interest,
                },
                {
                  key: "orddiv",
                  node: stackRow(
                    "Ordinary dividends (non-qualified part)",
                    fmtDollars(pg.nonQualifiedDividends),
                    pg.qualifiedDividends > 0
                      ? `of the ${fmtDollars(pg.ordinaryDividends)} total (line 3b) — the qualified ${fmtDollars(pg.qualifiedDividends)} rides the gains stack below`
                      : undefined,
                  ),
                  aca: pg.nonQualifiedDividends,
                  irmaa: pg.nonQualifiedDividends,
                },
                {
                  key: "other",
                  node: stackRow("Other ordinary income", fmtDollars(pg.otherOrdinary)),
                  aca: pg.otherOrdinary,
                  irmaa: pg.otherOrdinary,
                },
                {
                  key: "rmd",
                  node: pg.rmdPriced
                    ? stackRow(
                        "RMD for the year",
                        fmtDollars(pg.rmd),
                        pg.rmdDivisor != null
                          ? `Balance ÷ ${pg.rmdDivisor} (${pg.rmdTable === "joint" ? "Joint Life" : "Uniform Lifetime"} table)`
                          : pgPretaxBalance === 0
                            ? "No RMD — the pre-tax balance entered is $0"
                            : "No RMD due at this age",
                      )
                    : stackRow("RMD for the year", "Not priced"),
                  aca: pg.rmd,
                  irmaa: pg.rmd,
                },
                {
                  key: "ss",
                  node: stackRow(
                    "Social Security received",
                    fmtDollars(pg.ssBenefits),
                    pg.ssBenefits > 0
                      ? `of which taxable: ${fmtDollars(pg.ssTaxable)} (${pg.ssPctTaxed}% under §86)`
                      : undefined,
                  ),
                  aca: pg.ssBenefits,
                  irmaa: pg.ssTaxable,
                },
                {
                  key: "taxexempt",
                  node: stackRow(
                    "Tax-exempt interest",
                    fmtDollars(pg.taxExemptInterest),
                    "Not in AGI; counted in MAGI",
                  ),
                  aca: pg.taxExemptInterest,
                  irmaa: pg.taxExemptInterest,
                },
                {
                  key: "conversion",
                  node: stackRow("Pre-tax money out", fmtDollars(pg.conversion + pg.spendingDraw)),
                  aca: pg.conversion + pg.spendingDraw,
                  irmaa: pg.conversion + pg.spendingDraw,
                },
                {
                  key: "gains",
                  node: stackRow(
                    "Long-term gains priced",
                    fmtDollars(pg.ltcgPriced),
                    gainsSubText,
                  ),
                  aca: pg.ltcgPriced,
                  irmaa: pg.ltcgPriced,
                },
              ];
              // The §1211(b) capital-loss allowance, when a
              // net capital loss priced one: a negative row
              // after the gains row (the loss offsets gains
              // first, then up to $3,000 of ordinary income),
              // so the additive rows foot to AGI / MAGI.
              if (pg.capitalLossAllowance > 0) {
                additive.push({
                  key: "caplossallowance",
                  node: stackRow(
                    "Capital-loss allowance (§1211(b))",
                    `−${fmtDollars(pg.capitalLossAllowance)}`,
                    "Net capital loss applied against ordinary income",
                  ),
                  aca: -pg.capitalLossAllowance,
                  irmaa: -pg.capitalLossAllowance,
                });
              }
              // 2026-11-09: four rows of the stack are
              // placeholders at $0 — Other ordinary income,
              // RMD for the year, Social Security received,
              // and Tax-exempt interest hide while they price
              // at $0 and come back when they carry a value.
              // (The RMD row's "Not priced" state is not a $0
              // line and stays.) Filtering them here, before
              // the marker walk, cannot move a cliff marker:
              // a $0 row adds 0 to both running MAGI totals,
              // so it is never the row a crossing first lands
              // on, and the after-the-last-row fallback still
              // lands after the last shown row.
              const shownAdditive = additive.filter((e) => {
                switch (e.key) {
                  case "other":
                    return pg.otherOrdinary !== 0;
                  case "rmd":
                    return !pg.rmdPriced || pg.rmd !== 0;
                  case "ss":
                    return pg.ssBenefits !== 0;
                  case "taxexempt":
                    return pg.taxExemptInterest !== 0;
                  default:
                    return true;
                }
              });
              // The ACA section applies for these markers when
              // the result carries a cliff figure — set only
              // when a household size was entered and not
              // everyone in the household is on Medicare.
              const acaApplies = pg.aca.cliff != null;
              const acaHasCliff = acaApplies && pgYearNum >= 2026;
              const acaCrossed = acaHasCliff && pg.aca.overCliff;
              const acaCliff = pg.aca.cliff ?? 0;
              // The line under the priced tier, graded under
              // the PREMIUM year's law row — the same row the
              // server grades pg.irmaa.tier under (contract
              // v97), never the priced year's row.
              const irmaaLine =
                pg.irmaa.applies && pg.irmaa.tier >= 1
                  ? irmaaTierUpTo(
                      pg.irmaa.tier - 1,
                      pgFiling,
                      lawForYear(pg.irmaa.premiumYear),
                      pg.irmaa.premiumYear,
                      0,
                    )
                  : null;
              let acaCum = 0;
              let irmaaCum = 0;
              let acaAfter = -1;
              let irmaaAfter = -1;
              shownAdditive.forEach((e, i) => {
                acaCum += e.aca;
                irmaaCum += e.irmaa;
                if (acaCrossed && acaAfter === -1 && acaCum > acaCliff) acaAfter = i;
                if (irmaaLine != null && irmaaAfter === -1 && irmaaCum > irmaaLine) irmaaAfter = i;
              });
              // A crossed line's marker always renders: if the
              // running totals never passed it mid-stack (only
              // possible on a sub-cent rounding seam), it lands
              // after the last additive row instead.
              if (acaCrossed && acaAfter === -1) acaAfter = shownAdditive.length - 1;
              if (irmaaLine != null && irmaaAfter === -1) irmaaAfter = shownAdditive.length - 1;
              const markerCls =
                "col-span-2 rounded-[var(--radius)] bg-[var(--warn-soft)] px-2.5 py-1.5 text-xs font-medium text-[var(--warn)] sm:col-span-3 sm:text-sm";
              const acaMarker = acaCrossed ? (
                <div className={markerCls} role="note">
                  <span aria-hidden="true">⚠</span>{" "}
                  {`ACA cliff crossed — ${fmtDollars(acaCliff)} (400% of FPL). Over the cliff, the premium credit is $0.`}
                </div>
              ) : null;
              const irmaaMarker =
                irmaaLine != null ? (
                  <div className={markerCls} role="note">
                    <span aria-hidden="true">⚠</span>{" "}
                    {`IRMAA Tier ${pg.irmaa.tier} line crossed — ${fmtDollars(irmaaLine)}. Surcharge $${pg.irmaa.monthlyPerPerson.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/mo per person in ${pg.irmaa.premiumYear}.`}
                  </div>
                ) : null;
              // Closing room note: one part per applicable line
              // NOT crossed (a crossed ACA cliff is the marker's
              // story, not the note's; IRMAA keeps its next-line
              // distance even when a lower line was crossed).
              const noteParts: string[] = [];
              if (acaApplies) {
                if (!acaHasCliff) {
                  noteParts.push(`No ACA cliff in ${pgYearNum}.`);
                } else if (!acaCrossed && pg.aca.positionDollars != null) {
                  noteParts.push(
                    `ACA cliff: ${fmtDollars(pg.aca.positionDollars)} of room`,
                  );
                }
              }
              if (pg.irmaa.applies && pg.irmaa.nextTierLine != null) {
                noteParts.push(
                  `Next IRMAA line (Tier ${pg.irmaa.tier + 1} at ${fmtDollars(pg.irmaa.nextTierLine)}): ${fmtDollars(pg.irmaa.roomToNextTier ?? 0)} away`,
                );
              }
              return (
                <>
                  <h3 className="text-sm font-semibold">
                    How {pgYearNum} stacks up
                  </h3>
                  <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
                    {shownAdditive.map((e, i) => (
                      <Fragment key={e.key}>
                        {e.node}
                        {acaAfter === i ? acaMarker : null}
                        {irmaaAfter === i ? irmaaMarker : null}
                      </Fragment>
                    ))}
                    {stackRow("AGI", fmtDollars(pg.agi))}
                    {stackRow(
                      "Standard deduction",
                      fmtDollars(pg.standardDeduction),
                      pg.age65AddonTotal > 0
                        ? `includes ${fmtDollars(pg.age65AddonTotal)} of 65+ add-ons (${pg.count65} ${pg.count65 === 1 ? "person" : "people"} 65+)`
                        : undefined,
                    )}
                    {pg.itemizedDeduction > 0 &&
                      stackRow(
                        "Itemized deductions",
                        fmtDollars(pg.itemizedDeduction),
                        pg.deductionTaken === "itemized"
                          ? `more than the standard deduction — used (state & local taxes allowed: ${fmtDollars(pg.itemizedSaltAllowed)})`
                          : "less than the standard deduction — standard used",
                      )}
                    {pg.section68Reduction > 0 &&
                      stackRow(
                        "§68 limitation (2026 law)",
                        fmtDollars(pg.section68Reduction),
                        "already taken off the itemized deductions above",
                      )}
                    {pg.nonItemizerCharitableDeduction > 0 &&
                      stackRow(
                        "Charitable deduction (§170(p))",
                        fmtDollars(pg.nonItemizerCharitableDeduction),
                        "already taken off AGI above — not in the deductions",
                      )}
                    {pg.seniorDeduction > 0 &&
                      stackRow("Senior deduction (65+)", fmtDollars(pg.seniorDeduction))}
                    {stackRow("Taxable income", fmtDollars(pg.taxableIncome))}
                  </dl>
                  {noteParts.length > 0 && (
                    <p className="tnum mt-2 text-xs text-[var(--dim)]" role="note">
                      {noteParts.join(" · ")}
                    </p>
                  )}
                </>
              );
            })();
            return (
              <>
              <div className="mt-4 rounded-[var(--radius)] border border-[var(--accent)] bg-[var(--bg)] px-4 py-3">
                <p className="tnum text-base font-medium">
                  {takeawayParts.join(" · ")}
                  {landingExplainerText != null && (
                    <>
                      {" "}
                      <InfoNote
                        text={landingExplainerText}
                        ariaLabel="About the bracket top and the ACA line"
                        align="right"
                        viewportClamp
                      />
                    </>
                  )}
                </p>

                <div className="mt-3">
                  <h3 className="text-sm font-semibold">
                    Income stack
                    <InfoNote
                      text={bracketStatusText}
                      ariaLabel="Bracket-by-bracket status for the income stack"
                    />
                  </h3>
                </div>

                {stackChart}

                {!pg.rmdPriced && (
                  <p className="mt-2 text-sm" role="note">
                    No pre-tax balance entered — no RMD priced, and the
                    pre-tax money out isn&rsquo;t capped.
                  </p>
                )}
                {pg.conversionExceedsBalance && (
                  <p className="mt-2 text-sm" role="note">
                    <strong>Watch out:</strong> the pre-tax money out typed is more
                    than the pre-tax balance left after the RMD (
                    {fmtDollars(pgBalanceLeftAfterRmd ?? 0)}), so it couldn&rsquo;t all come out of
                    that balance — the tax below still prices the amount typed.
                  </p>
                )}
                {pg.capitalLoss > 0 && (
                  <p className="mt-2 text-sm" role="note">
                    <strong>Net capital loss of {fmtDollars(pg.capitalLoss)}:</strong>{" "}
                    capital losses offset capital gains only — the qualified
                    dividends entered still price in full — and{" "}
                    {fmtDollars(pg.capitalLossAllowance)} of the loss offsets
                    ordinary income this year (the §1211(b) capital-loss
                    allowance, up to $3,000).
                    {pg.capitalLoss > pg.capitalLossAllowance && (
                      <>
                        {" "}The remaining{" "}
                        {fmtDollars(pg.capitalLoss - pg.capitalLossAllowance)} isn&rsquo;t
                        priced here — in real life it carries forward to later years.
                      </>
                    )}
                  </p>
                )}

              </div>

              <div className="flex flex-col gap-4">
                <section className={sectionCls} aria-label="ACA and IRMAA">
                <h3 className="text-sm font-semibold">ACA &amp; IRMAA</h3>
                {pg.aca.everyoneOnMedicare ? (
                  <p className="mt-1 text-sm">
                    No ACA — everyone in the household is on Medicare.
                  </p>
                ) : pg.aca.cliff == null ? (
                  <p className="mt-1 text-sm">
                    ACA: enter a household size above to see where this year
                    sits against the 400% poverty-line cliff.
                  </p>
                ) : (
                  <p className="mt-1 text-sm">
                    ACA cliff for a household of {pg.aca.householdSize}:{" "}
                    {fmtDollars(pg.aca.cliff)}{" "}
                    (400% of the poverty line).{" "}
                    {pg.aca.overCliff
                      ? `ACA household income is over the cliff by ${fmtDollars(-(pg.aca.positionDollars ?? 0))} — the premium credit is $0 at the cliff.`
                      : `ACA household income is under the cliff by ${fmtDollars(pg.aca.positionDollars ?? 0)}`}
                    {!pg.aca.overCliff &&
                      (pg.aca.credit != null ? (
                        <>
                          {" — estimated credit "}
                          <span className="font-bold text-[var(--accent)]">
                            {fmtDollars(pg.aca.credit)}
                          </span>
                          {" at the ACA benchmark premium entered."}
                        </>
                      ) : (
                        " — enter an ACA benchmark premium above to price the credit."
                      ))}
                    {pg.aca.pctFpl != null && pg.aca.pctFpl < 138 && (
                      <>
                        {" "}
                        Under 138% of the poverty line, coverage routes to
                        Medicaid in most states rather than a marketplace plan —
                        treat any credit as flagged, not bankable.
                      </>
                    )}
                  </p>
                )}
                {pg.gainsFlags.acaFlag != null && (
                  <p className="mt-1 text-sm font-medium" role="note">
                    {pg.gainsFlags.acaFlag.text}
                  </p>
                )}
                {pg.irmaa.applies ? (
                  <p className="mt-1 text-sm">
                    IRMAA: this year&rsquo;s MAGI sets Tier {pg.irmaa.tier} for{" "}
                    {pg.irmaa.premiumYear}.{" "}
                    {pg.irmaa.tier === 0
                      ? "Tier 0 carries no surcharge."
                      : `Surcharge ${fmtDollars(pg.irmaa.monthlyPerPerson)}/mo per person on Medicare — ${fmtDollars(pg.irmaa.annualHousehold)}/yr for the household (${pg.irmaa.personsOnMedicare} on Medicare).`}{" "}
                    {pg.irmaa.nextTierLine != null
                      ? `MAGI is ${fmtDollars(pg.irmaa.roomToNextTier ?? 0)} under the next tier line at ${fmtDollars(pg.irmaa.nextTierLine)}.`
                      : "That is the top tier — there is no higher line."}
                  </p>
                ) : (
                  !pg.aca.everyoneOnMedicare && (
                    <p className="mt-1 text-sm">
                      No IRMAA — nobody in the household is on Medicare.
                    </p>
                  )
                )}
                {pg.gainsFlags.irmaaFlag != null && (
                  <p className="mt-1 text-sm font-medium" role="note">
                    {pg.gainsFlags.irmaaFlag.text}
                  </p>
                )}
                </section>

                <section className={sectionCls} aria-label="Tax for the year">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">Tax for the year</h3>
                  {/* Month / Year pills: the same persisted
                      spendPerMonth state the sticky strip's
                      pills write — they switch ONLY the two
                      spend readouts below (Cash left after
                      tax, Left after a year's spending); every
                      other row in this card stays annual. */}
                  <SpendPeriodPills
                    perMonth={spendPerMonth}
                    onChange={setSpendPerMonth}
                  />
                </div>
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
                  {stackRow(
                    "Federal tax on ordinary income",
                    fmtDollars(pg.ordinaryTax),
                  )}
                  {stackRow(
                    "Federal tax on gains",
                    fmtDollars(pg.ltcgTax + pg.niit),
                    pg.niit > 0
                      ? `${fmtDollars(pg.ltcgTax)} gains tax + ${fmtDollars(pg.niit)} NIIT`
                      : undefined,
                  )}
                  {stackRow(
                    "Total federal tax",
                    fmtDollars(pg.federalTax),
                    undefined,
                    true,
                    // Money owed: the same red as the negative
                    // "Left after a year's spending" below.
                    "text-[var(--bad)]",
                  )}
                  {pg.educationAotc > 0 &&
                    stackRow(
                      "American Opportunity Credit",
                      fmtDollars(pg.educationAotc),
                      `${fmtDollars(pg.educationRefundable)} of it is refundable — paid even past a $0 tax bill, shown below, not inside the tax. The nonrefundable part is already inside the total federal tax.`,
                    )}
                  {pg.educationLlc > 0 &&
                    stackRow(
                      "Lifetime Learning Credit",
                      fmtDollars(pg.educationLlc),
                      "Nonrefundable — already inside the total federal tax.",
                    )}
                  {(pg.educationAotc > 0 || pg.educationLlc > 0) &&
                    stackRow(
                      "Nonrefundable education credits applied",
                      fmtDollars(pg.educationNonrefundable),
                    )}
                  {pg.educationRefundable > 0 &&
                    stackRow(
                      "Refundable education credit (AOTC)",
                      fmtDollars(pg.educationRefundable),
                      "Paid on top of the tax result — not netted into the total federal tax.",
                    )}
                  {pg.amtOwed > 0 &&
                    stackRow(
                      <>
                        Alternative minimum tax (AMT)
                        <InfoNote
                          text={`Tentative minimum tax ${fmtDollars(pg.amtTentativeTax)} on AMT income ${fmtDollars(pg.amti)} (exemption ${fmtDollars(pg.amtExemption)}) beat the regular tax — the difference is already inside the total federal tax.`}
                          ariaLabel="About the alternative minimum tax"
                        />
                      </>,
                      fmtDollars(pg.amtOwed),
                    )}
                  {pg.amtOwed === 0 && pg.amti > 0 &&
                    stackRow(
                      <>
                        Alternative minimum tax (AMT)
                        <InfoNote
                          text={`Tentative minimum tax ${fmtDollars(pg.amtTentativeTax)} on AMT income ${fmtDollars(pg.amti)} (exemption ${fmtDollars(pg.amtExemption)}) did not beat the regular tax.`}
                          ariaLabel="About the alternative minimum tax"
                        />
                      </>,
                      "$0",
                    )}
                  {/* State tax, listed ONCE (P-S13, parity
                      audit SHOULD — settled STAND): the
                      pricer's stateTax is mutually exclusive
                      by residence — for a WA resident it IS
                      the capital-gains excise (the flat rate
                      never applies), and for any other
                      residence it is the flat-rate tax. The
                      generic row therefore stands down for a
                      WA resident and the excise row below —
                      which carries the base breakdown as its
                      sub-text — is the year's one state-tax
                      row; before this fix the two rows listed
                      the identical dollars side by side and a
                      reader summing the card double-counted
                      the whole excise. */}
                  {pg.stateTax > 0 && pgResidence !== "WA" &&
                    stackRow("State tax", fmtDollars(pg.stateTax))}
                  {pgResidence === "WA" &&
                    stackRow(
                      "Washington capital-gains excise",
                      fmtDollars(pg.stateTax),
                      `${fmtDollars(pg.waGains)} of gains − ${fmtDollars(pg.waStandardDeduction)} standard deduction = ${fmtDollars(pg.waTaxableGains)} taxable`,
                    )}
                  {stackRow("MAGI", fmtDollars(pg.magi))}
                  {pg.acaMagi !== pg.magi &&
                    stackRow(
                      "ACA household income",
                      fmtDollars(pg.acaMagi),
                      "MAGI plus the untaxed part of Social Security",
                    )}
                  {/* Dial split of the pre-tax money out: the
                      year's pre-tax money out sits on TWO dials
                      in the Pre-tax money out section above —
                      the Conversion to Roth dial and the Pre-tax
                      draw for spending dial — and the two are
                      priced the same as income but opposite as
                      cash. Naming both amounts here, on the card
                      itself, is what keeps a year whose money
                      out is all conversion from reading as a
                      cash shortfall: the conversion is real
                      income (it is inside MAGI above) but it
                      lands in Roth, so the cash-left rows below
                      never count it, while a draw is cash in
                      hand and they do. Shown whenever either
                      dial is non-zero, both rows together, so
                      the empty dial reads $0 beside the filled
                      one. Figures are the priced result's own
                      echoes (pg.conversion / pg.spendingDraw);
                      no figure changes. */}
                  {(pg.conversion > 0 || pg.spendingDraw > 0) &&
                    stackRow(
                      "On the Conversion to Roth dial",
                      fmtDollars(pg.conversion),
                      "Goes to Roth — income, but not cash in hand, so it is not counted in the cash left below.",
                    )}
                  {(pg.conversion > 0 || pg.spendingDraw > 0) &&
                    stackRow(
                      "On the Pre-tax draw for spending dial",
                      fmtDollars(pg.spendingDraw),
                      "Cash in hand — counted in the cash left below.",
                    )}
                  {/* Cash left after tax (build v114, fixed
                      text + ⓘ build v116): the
                      engine-priced readout on the same pricing
                      (pg.cashIn / pg.netTaxBill /
                      pg.cashLeftAfterTax — never client
                      arithmetic): all the year's cash in minus
                      its net tax bill, before any spending. The
                      fixed subtext carries no figure; the ⓘ
                      (the 0% InfoNote pattern — live-composed
                      figures, align by the label's position)
                      names the cash in and the net tax bill as
                      priced, and carries the filing sentence
                      only when the net bill is a refund. In
                      Month mode (the shared persisted
                      spendPerMonth toggle) the value shows the
                      same figure divided by 12 with a "/mo"
                      suffix and the sub-line and ⓘ name the
                      month instead of the year; the ⓘ's
                      derivation figures stay annual, as
                      priced. */}
                  {stackRow(
                    <>
                      Cash left after tax
                      <InfoNote
                        text={`Cash in ${fmtDollars(pg.cashIn)} minus the net tax bill ${fmtDollars(pg.netTaxBill)} — ${PLAYGROUND_CASH_LEFT_BASIS} It's what's left to spend next ${spendPerMonth ? "month" : "year"}, before any spending.${pg.conversion > 0 || pg.spendingDraw > 0 ? ` Cash in counts the ${fmtDollars(pg.spendingDraw)} on the Pre-tax draw for spending dial and does not count the ${fmtDollars(pg.conversion)} on the Conversion to Roth dial — a conversion goes to Roth, not cash in hand.` : ""}${pg.cashDraw > 0 || pg.rothDraw > 0 ? ` Cash in also counts the funding dials in Spending: Cash drawn for spending ${fmtDollars(pg.cashDraw)} and Roth drawn for spending ${fmtDollars(pg.rothDraw)}.` : ""}${pg.netTaxBill < 0 ? " If the tax bill is a refund, that part arrives at filing in the spring, not in December." : ""}`}
                        ariaLabel="About the cash left after tax"
                      />
                    </>,
                    spendPerMonth
                      ? `${fmtDollarsExact(pg.cashLeftAfterTax / 12)}/mo`
                      : fmtDollars(pg.cashLeftAfterTax),
                    `Cash in minus the net tax bill — what's left to spend next ${spendPerMonth ? "month" : "year"}, before any spending.`,
                    true,
                  )}
                  {/* Left after a year's spending (contract
                      v126, "enough for the year"; R3-M3): cash
                      left after HEALTH PREMIUMS minus the
                      annual spending — the engine-priced
                      comparison (pg.cashLeftVsSpending, which
                      the engine now derives from
                      cashLeftAfterHealthPremium), positive =
                      enough for the year, negative = short.
                      The spending excludes health premiums, so
                      the premium is charged before the
                      comparison; before R3-M3 the comparison
                      ran off the cash left after tax alone and
                      overstated the verdict by the whole net
                      premium whenever one priced. The IRMAA
                      surcharge payable this year (internal
                      review round 3 SHOULD-2) is charged
                      beside the premium in the same cash left
                      after health premiums, and the ⓘ names
                      it in the derivation whenever it prices
                      — a year with a $0 net premium but a
                      payable IRMAA takes the premium-charged
                      branch too, since the comparison still
                      runs off the reduced cash left. The spending
                      is the Tax Plan record's annual spending
                      (the Retirement calculator's default when
                      the record has none), now editable in this
                      view's Spending dial (build v145, one
                      source); the row hides when no spending
                      resolves. Since P-S2 a paste-load can hold
                      the pasted year's own spending ahead of
                      that resolution — the ⓘ then names the
                      paste, not the Tax Plan, as the source —
                      so a replayed year is judged against the
                      spending it was priced with. No provenance tap: a tap to the
                      income inputs would mislead — the
                      comparison is driven by spending, not
                      income — so the ⓘ names the spending and
                      its source instead (and, when a premium
                      or a payable IRMAA prices, the
                      premium-charged derivation),
                      and carries the refund-timing sentence
                      whenever the net bill is a refund. The ⓘ
                      and the visible sub-line also name the two
                      pre-tax dials whenever either is non-zero —
                      the comparison's cash counts the Pre-tax
                      draw for spending dial and never the
                      Conversion to Roth dial — so a shortfall
                      priced off a conversion never reads as
                      missing spendable cash. In
                      Month mode (the shared persisted
                      spendPerMonth toggle) the label, value,
                      and sub-line name the month — the value
                      is the same figure divided by 12 with a
                      "/mo" suffix — while the ⓘ keeps naming
                      the annual figures it is derived from. */}
                  {pg.cashLeftVsSpending != null && pg.annualSpending != null && (
                    stackRow(
                      <>
                        Left after a {spendPerMonth ? "month" : "year"}
                        &rsquo;s spending
                        <InfoNote
                          text={(pg.healthPremiumNet > 0 || pg.irmaaPayableAnnual > 0 ? `Cash left after health premiums ${fmtDollars(pg.cashLeftAfterHealthPremium)} — cash left after tax ${fmtDollars(pg.cashLeftAfterTax)}${pg.healthPremiumNet > 0 ? ` minus the net health premium ${fmtDollars(pg.healthPremiumNet)}` : ""}${pg.irmaaPayableAnnual > 0 ? ` minus the IRMAA payable this year ${fmtDollars(pg.irmaaPayableAnnual)}` : ""} — minus annual spending ${fmtDollars(pg.annualSpending)} — ${pgPastedSpending !== undefined ? "the annual spending the loaded year was priced with" : "the annual spending from the Tax Plan"}, which excludes health premiums.${pg.netTaxBill < 0 ? " If the tax bill is a refund, that part arrives at filing in the spring, not in December." : ""}` : `Cash left after tax ${fmtDollars(pg.cashLeftAfterTax)} minus annual spending ${fmtDollars(pg.annualSpending)} — ${pgPastedSpending !== undefined ? "the annual spending the loaded year was priced with" : "the annual spending from the Tax Plan"}.${pg.netTaxBill < 0 ? " If the tax bill is a refund, that part arrives at filing in the spring, not in December." : ""}`) + (pg.conversion > 0 || pg.spendingDraw > 0 ? ` The cash this comparison runs on counts the Pre-tax draw for spending dial (${fmtDollars(pg.spendingDraw)}) and not the Conversion to Roth dial (${fmtDollars(pg.conversion)}) — a conversion goes to Roth, so it cannot pay this spending; money taken out to spend belongs on the draw dial.` : "")}
                          ariaLabel={`About the amount left after a ${spendPerMonth ? "month" : "year"}'s spending`}
                        />
                      </>,
                      <span
                        className={`font-bold ${pg.cashLeftVsSpending < 0 ? "text-[var(--bad)]" : "text-[var(--accent)]"}`}
                      >
                        {spendPerMonth
                          ? `${fmtDollarsExact(pg.cashLeftVsSpending / 12)}/mo`
                          : fmtDollars(pg.cashLeftVsSpending)}
                      </span>,
                      (pg.cashLeftVsSpending > 0
                        ? `Enough for the ${spendPerMonth ? "month" : "year"}.`
                        : pg.cashLeftVsSpending < 0
                          ? `Short of a ${spendPerMonth ? "month" : "year"}'s spending.`
                          : `Exactly enough for the ${spendPerMonth ? "month" : "year"}.`) +
                        (pg.conversion > 0
                          ? ` The ${fmtDollars(pg.conversion)} on the Conversion to Roth dial goes to Roth — it is not cash for spending.`
                          : ""),
                    )
                  )}
                </dl>
                {pg.conversion > 0 && (
                  <p className="mt-2 text-sm">
                    {pg.spendingDraw > 0 ? (
                      <>
                        The money on the Conversion to Roth dial itself costs{" "}
                        <strong className="tnum">{fmtDollars(pg.conversionFederalCost)}</strong>{" "}
                        of federal tax —{" "}
                        {((pg.conversionFederalCost / pg.conversion) * 100).toFixed(1)}%
                        of the amount on that dial
                        {pg.conversionTotalCost !== pg.conversionFederalCost
                          ? ` (${fmtDollars(pg.conversionTotalCost)} with state tax included)`
                          : ""}
                        . That&rsquo;s the year&rsquo;s tax with the Conversion to Roth dial minus
                        the same year priced at $0 on that dial — the money on the
                        Pre-tax draw for spending dial still taken.
                      </>
                    ) : (
                      <>
                        The money on the Conversion to Roth dial itself costs{" "}
                        <strong className="tnum">{fmtDollars(pg.conversionFederalCost)}</strong>{" "}
                        of federal tax —{" "}
                        {((pg.conversionFederalCost / pg.conversion) * 100).toFixed(1)}%
                        of the amount on that dial
                        {pg.conversionTotalCost !== pg.conversionFederalCost
                          ? ` (${fmtDollars(pg.conversionTotalCost)} with state tax included)`
                          : ""}
                        . That&rsquo;s the year&rsquo;s tax with the Conversion to Roth dial minus
                        the same year priced at $0 on that dial. All of this
                        year&rsquo;s pre-tax money out is on that dial — it goes to
                        Roth, not to spending, so none of it is cash in hand.
                        Money taken out to spend belongs on the Pre-tax draw
                        for spending dial, which is $0 here.
                      </>
                    )}
                  </p>
                )}
                {pg.saleAfterTax != null && (
                  <p className="mt-2 text-sm" role="note">
                    {(() => {
                      // Sale-after-tax highlight: only the final
                      // "{leftover} of it is left." segment is
                      // emphasised — bold in the accent colour; the
                      // rest of the sentence keeps its styling. The
                      // split is taken from the engine's own composed
                      // string at its final ", " (the one before the
                      // leftover figure — grouped dollar figures
                      // never contain ", "), so the displayed text
                      // stays byte-identical. The variant where the
                      // year's tax exceeds the proceeds phrases the
                      // outcome differently (no "of it is left."
                      // tail) and renders exactly as composed.
                      const sat = pg.saleAfterTax;
                      const cut =
                        sat.leftover >= 0 &&
                        sat.text.endsWith(" of it is left.")
                          ? sat.text.lastIndexOf(", ") + 2
                          : -1;
                      if (cut < 2) return sat.text;
                      return (
                        <>
                          {sat.text.slice(0, cut)}
                          <span className="font-bold text-[var(--accent)]">
                            {sat.text.slice(cut)}
                          </span>
                        </>
                      );
                    })()}
                  </p>
                )}

                </section>

                <section className={sectionCls} aria-label={`How ${pgYearNum} stacks up`}>
                  {stackBlock}
                </section>

                <section className={sectionCls} aria-label="Gains stack">
                <h3 className="text-sm font-semibold">
                  Gains stack
                  <InfoNote
                    text="Net investment income tax is priced on interest, dividends and gains — the net investment income base."
                    ariaLabel="About the gains stack and the net investment income tax"
                  />
                </h3>
                {(() => {
                  // Gains stack as a horizontal stacked bar
                  // (build v69), in the income stack's visual
                  // language: one segment per rate tier sized by
                  // the dollars taxed there, with the unused 0%
                  // room drawn first as an empty hatched segment
                  // when there is any. Every figure is the priced
                  // result's own (pg.gainsAt0 / At15 / At20 and
                  // pg.gainsZeroRoomLeft).
                  const segs = [
                    { key: "room", label: "0% gains room left", amount: pg.gainsZeroRoomLeft, color: "", empty: true },
                    { key: "at0", label: "Taxed at 0%", amount: pg.gainsAt0, color: "#65a30d", empty: false },
                    { key: "at15", label: "Taxed at 15%", amount: pg.gainsAt15, color: "#5f6caf", empty: false },
                    { key: "at20", label: "Taxed at 20%", amount: pg.gainsAt20, color: "#7a5c8f", empty: false },
                  ].filter((g) => g.amount > 0);
                  const total = segs.reduce((a, g) => a + g.amount, 0);
                  if (total <= 0) {
                    return (
                      <p className="mt-1 text-sm text-[var(--dim)]">
                        No gains priced for this year.
                      </p>
                    );
                  }
                  return (
                    <>
                      <div
                        className="mt-2 flex h-6 w-full overflow-hidden rounded-sm"
                        role="img"
                        aria-label={`Gains stack bar: ${segs.map((g) => `${g.label} ${fmtDollars(g.amount)}`).join(", ")}`}
                      >
                        {segs.map((g) => (
                          <div
                            key={g.key}
                            className="flex h-full min-w-0 items-center justify-center overflow-hidden border-r border-[var(--bg)]"
                            style={{
                              width: `${(g.amount / total) * 100}%`,
                              background: g.empty ? undefined : g.color,
                              ...(g.empty ? STACK_HATCH_STYLE : {}),
                            }}
                          >
                            {(g.amount / total) * 100 >= 14 && (
                              <span className={`truncate px-1 text-[11px] font-medium ${g.empty ? "text-[var(--text)]" : "text-white"}`}>
                                {fmtDollars(g.amount)}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                      <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--dim)]">
                        {segs.map((g) => (
                          <span key={g.key} className="inline-flex items-center gap-1.5">
                            <span
                              className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm border border-[var(--dim)]"
                              style={g.empty ? STACK_HATCH_STYLE : { background: g.color }}
                              aria-hidden="true"
                            />
                            {g.label}{" "}
                            <span className="tnum font-medium text-[var(--text)]">
                              {fmtDollars(g.amount)}
                            </span>
                          </span>
                        ))}
                      </p>
                    </>
                  );
                })()}
                <p className="tnum mt-2 text-sm">
                  Net investment income tax{" "}
                  <span className="font-medium">{fmtDollars(pg.niit)}</span>
                </p>

                </section>
              </div>
              </>
            );
          })()}

        {/* Load inputs from a paste — an occasional-use tool,
            folded by default (see pasteOpen above): the heading
            row carries the shared fold toggle at its right end,
            and the fold covers the helper line, the textarea,
            and the Load inputs button. The "Start from my
            numbers" button and "Reset playground" link above
            stay outside the fold, always visible. */}
        <section className={sectionCls} aria-label="Load inputs from a paste">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <span>
              <label
                className="block text-base font-semibold"
                htmlFor="roth-pg-paste"
              >
                Load inputs from a paste
              </label>
              <span className="mt-0.5 block text-sm text-[var(--dim)]">
                {pgPasteLoaded
                  ? "Inputs loaded from the paste"
                  : pgPasteText.trim() !== ""
                    ? "Paste entered — not loaded yet"
                    : "Nothing pasted yet"}
              </span>
            </span>
            <button
              type="button"
              aria-label={
                pasteOpen ? "Hide paste loader" : "Show paste loader"
              }
              aria-expanded={pasteOpen}
              aria-controls="playground-paste-inputs"
              onClick={() => setPasteOpen(!pasteOpen)}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] text-[var(--dim)] hover:text-[var(--accent)] focus-visible:text-[var(--accent)]"
            >
              <FoldChevron open={pasteOpen} />
            </button>
          </div>
          {pasteOpen && (
            <div id="playground-paste-inputs" className="max-w-3xl">
              <p className={hintCls}>
                Paste the inputs block from a priced answer and every dial
                below fills at once — the same as typing them.
              </p>
              <textarea
                id="roth-pg-paste"
                aria-label="Load inputs paste box"
                className={`${inputCls} mt-2 font-mono text-xs`}
                rows={3}
                value={pgPasteText}
                onChange={(e) => {
                  setPgPasteText(e.target.value);
                  setPgPasteLoaded(false);
                }}
                placeholder='{"kind":"playground-year","version":1,…}'
              />
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  aria-label="Load inputs"
                  className="rounded-[var(--radius)] border border-[var(--border)] px-3.5 py-1.5 text-sm font-medium hover:text-[var(--accent)] disabled:opacity-60"
                  disabled={pgPasteText.trim() === ""}
                  onClick={applyPgPaste}
                >
                  Load inputs
                </button>
                {pgPasteLoaded && !pgPasteError && (
                  <span className="text-sm text-[var(--dim)]" role="note">
                    Loaded — the dials below now hold the pasted inputs.
                  </span>
                )}
              </div>
              {pgPasteError && (
                <p className="mt-2 text-sm text-[var(--bad)]" role="alert">
                  {pgPasteError}
                </p>
              )}
            </div>
          )}
        </section>

        {/* Known starting points — preset cards that load the
            dials (see the loaders above). Loading a preset
            sets dials only; nothing here writes the saved
            plan record. Shown on both faces: the dials are
            shared, so a starting point is useful from either
            tool. The section folds behind the same chevron
            toggle the Spending section folds use (see
            knownPointsFolded above): expanded by default, and
            folded shut it leaves only this header row. */}
        <section className={sectionCls} aria-label="Start from a known point">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <span>
              <span className="block text-base font-semibold">
                Start from a known point
              </span>
              <span className="mt-0.5 block text-sm text-[var(--dim)]">
                {pgPresetNote ??
                  `My ${pgTaxReturnYear} return as filed · a year from my saved plan · a blank year`}
              </span>
            </span>
            <button
              type="button"
              aria-label={
                knownPointsOpen
                  ? "Hide starting points"
                  : "Show starting points"
              }
              aria-expanded={knownPointsOpen}
              aria-controls="playground-known-points"
              onClick={() => setKnownPointsFolded(knownPointsOpen)}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] text-[var(--dim)] hover:text-[var(--accent)] focus-visible:text-[var(--accent)]"
            >
              <FoldChevron open={knownPointsOpen} />
            </button>
          </div>
          {knownPointsOpen && (
            <div id="playground-known-points">
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 py-3">
              <p className="text-sm font-semibold">My {pgTaxReturnYear} return as filed</p>
              <p className="mt-1 text-xs text-[var(--dim)]">
                {pgPrefillSource?.taxReturnInterest != null ||
                pgPrefillSource?.taxReturnOrdinaryDividends != null
                  ? `The Form 1040 figures on your plan record — interest ${fmtDollars(pgPrefillSource?.taxReturnInterest ?? 0)}, qualified dividends ${fmtDollars(pgPrefillSource?.taxReturnQualifiedDividends ?? 0)}, ordinary dividends ${fmtDollars(pgPrefillSource?.taxReturnOrdinaryDividends ?? 0)} — from ${pgReturnYearPhrase}. Loads the year ${pgTaxReturnYear} and those three dials; every other dial stays as it is.`
                  : "The Form 1040 figures stored on your plan record. No figures are stored yet, so there is nothing to load."}
              </p>
              <button
                type="button"
                aria-label={`Load my ${pgTaxReturnYear} return as filed`}
                className="mt-2 rounded-[var(--radius)] border border-[var(--border)] px-3 py-1.5 text-sm font-medium hover:text-[var(--accent)] disabled:opacity-60"
                disabled={
                  !pgPrefillSource ||
                  (pgPrefillSource.taxReturnInterest == null &&
                    pgPrefillSource.taxReturnQualifiedDividends == null &&
                    pgPrefillSource.taxReturnOrdinaryDividends == null)
                }
                onClick={applyPgAsFiled}
              >
                Load
              </button>
            </div>
            <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 py-3">
              <p className="text-sm font-semibold">A year from my saved plan</p>
              <p className="mt-1 text-xs text-[var(--dim)]">
                Pick a year the saved plan prices and load that year&rsquo;s
                priced income and conversion as the dials. Your saved plan
                is not changed.
              </p>
              {pgSavedPlanYears != null &&
              pgSavedPlanYears.years.length > 0 ? (
                <>
                  <label
                    className="mt-2 block text-xs font-medium text-[var(--text)]"
                    htmlFor="pg-plan-preset-year"
                  >
                    Plan year
                  </label>
                  <select
                    id="pg-plan-preset-year"
                    aria-label="Plan year to load"
                    className={inputCls}
                    value={pgPlanPresetYear ?? ""}
                    onChange={(e) =>
                      setPgPlanPresetYear(parseIntField(e.target.value))
                    }
                  >
                    {pgSavedPlanYears.years.map((y) => (
                      <option key={y.year} value={y.year}>
                        {y.year} — age {y.agePrimary}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    aria-label="Load the chosen plan year"
                    className="mt-2 rounded-[var(--radius)] border border-[var(--border)] px-3 py-1.5 text-sm font-medium hover:text-[var(--accent)] disabled:opacity-60"
                    disabled={pgPlanPresetYear == null}
                    onClick={() => {
                      if (pgPlanPresetYear != null) {
                        loadPgSavedPlanYear(pgPlanPresetYear);
                      }
                    }}
                  >
                    Load this year
                  </button>
                </>
              ) : (
                <p className="mt-2 text-xs text-[var(--dim)]">
                  Needs a pricable saved plan.
                </p>
              )}
            </div>
            <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 py-3">
              <p className="text-sm font-semibold">Blank year</p>
              <p className="mt-1 text-xs text-[var(--dim)]">
                Every single-year dial cleared — a clean sheet. The
                projection still runs from its captured template.
              </p>
              <button
                type="button"
                aria-label="Load a blank year"
                className="mt-2 rounded-[var(--radius)] border border-[var(--border)] px-3 py-1.5 text-sm font-medium hover:text-[var(--accent)]"
                onClick={applyPgBlankYear}
              >
                Load
              </button>
            </div>
          </div>
            </div>
          )}
        </section>

    </div>
  );
}

/* "Start from my numbers" source — the fields the prefill
   reads, resolved from the Roth record (getRothPlanner) and
   the Retirement record (getRetirementCalc) EXACTLY as the
   Roth view resolves its working plan inputs on load: a saved
   value wins; a balance not saved follows the latest Net
   Worth snapshot's bucket subtotal (the primary pre-tax field
   takes the bucket remainder after the spouse's saved split,
   floored at $0); spending, retirement age, and expected
   return fall back to the Retirement record, then the seeds.
   The same pricability gates the Roth view's planInputs memo
   applies decide whether a plan exists at all (birth year in
   1930–2015, spending present and non-negative, a retirement
   age, an expected return, and an end age after the current
   age): when they fail there is no pricable plan and the
   prefill stays disabled, exactly as before. Money leaves the
   record in cents and lands in dollars — the units the plan
   inputs, and the prefill, speak. */
type PgPrefillSource = {
  birthYearPrimary: number;
  birthYearSpouse: number | null;
  filingStatus: FilingStatus;
  pretaxStart: number;
  pretaxSpouseStart: number;
  ssPrimaryAnnual: number;
  ssPrimaryStartAge: number | null;
  ssPrimaryNoBenefit: boolean;
  ssSpouseAnnual: number;
  ssSpouseStartAge: number | null;
  ssSpouseNoBenefit: boolean;
  acaHouseholdSize: number;
  acaHouseholdSchedule: { fromYear: number; householdSize: number }[] | null;
  acaBenchmarkCouple: number | null;
  acaBenchmarkSingle: number | null;
  acaBenchmarkFamily: number | null;
  stateRatePct: number;
  residenceState: "WA" | "other" | null;
  // Itemized deductions (T5): the plan's four components in
  // dollars (null = the plan has none entered).
  itemizedMortgageInterest: number | null;
  itemizedSaltPaid: number | null;
  itemizedCharitable: number | null;
  itemizedOther: number | null;
  // Other ordinary income and tax-exempt interest (P-M5,
  // parity audit): the plan's entered annual amounts in
  // dollars (null = not entered). The record prices both
  // every year (planInputsFromSaved) — other ordinary in
  // AGI, tax-exempt in ACA MAGI only — but before P-M5 the
  // prefill carried neither, so a prefilled year priced
  // both at $0.
  otherOrdinary: number | null;
  taxExemptInterest: number | null;
  // Loss carry-ins (P-M5): the plan's ENTERING banked
  // losses in dollars (null = not entered) — short-term and
  // long-term, each with its Washington-attributable
  // portion. These are the plan's FIRST year's entering
  // lines; the prefill reads a priced chosen year's own
  // entering lines from the march instead (see
  // prefillPlayground) and falls back to these only for a
  // year the march does not price.
  capitalLossCarryInSt: number | null;
  capitalLossCarryInLt: number | null;
  capitalLossCarryInStWa: number | null;
  capitalLossCarryInLtWa: number | null;
  // Health premiums (P-M5): the plan's entered annual
  // amounts in dollars (null = not entered) — the
  // marketplace premium when both spouses are on the
  // marketplace, the marketplace premium when exactly one
  // is, and the Medicare premium per person. All three
  // null = the record entered no premium term and the
  // march charges $0, so the prefill leaves both health
  // dials blank exactly as it did before P-M5.
  healthPremiumAcaHousehold: number | null;
  healthPremiumAcaSingle: number | null;
  healthPremiumMedicarePerPerson: number | null;
  // Education students (T6): the plan's entered per-student,
  // per-year expenses in dollars (null = the plan has none
  // entered); the prefill keeps only the chosen year's rows.
  educationStudents: { year: number; expenses: number; aotcEligible: boolean }[] | null;
  // Tax-return actuals (1040 LINES build): the plan record's
  // Form 1040 lines in dollars (null = that line not entered),
  // mapped by taxReturnPrefillDollars — interest ← line 2b,
  // qualified dividends ← line 3a, ordinary dividends ← the
  // line 3b TOTAL. These are the ONLY plan figures behind the
  // prefill's Interest / dividend dials: the plan itself prices
  // yields, never these amounts. The return year (contract
  // v147) is the calendar year those amounts are from (null =
  // the record predates the year field — year not recorded);
  // the prefill and the "as filed" preset resolve it to the
  // last filed year when it is null (see pgTaxReturnYear).
  taxReturnInterest: number | null;
  taxReturnQualifiedDividends: number | null;
  taxReturnOrdinaryDividends: number | null;
  taxReturnYear: number | null;
  spouseSoleBeneficiary: boolean;
  // The reciprocal beneficiary fact (N-1, engines review
  // round 2): the primary is the sole beneficiary of the
  // SPOUSE's pre-tax accounts — a SEPARATE fact from
  // spouseSoleBeneficiary above (the spouse is the
  // PRIMARY's sole beneficiary, selecting only the
  // primary's RMD table). This fact alone selects the
  // SPOUSE's RMD table. Tri-state like the saved record:
  // null = not established (the spouse's RMD prices on
  // the Uniform Lifetime Table). Before N-1 the prefill
  // carried only the first fact, so a prefilled year
  // priced the spouse's RMD on the Uniform table even
  // when the record established reciprocity — wrong
  // whenever the spouse is more than 10 years older.
  primarySoleBeneficiaryOfSpouse: boolean | null;
  // Inflation (S-4): the plan's inflation rate in percent —
  // the rate buildPgInputs prices every year with, so the
  // Playground's future years deflate their statute-fixed
  // amounts exactly as the plan march deflates them.
  // Inflation's home record is the Tax Plan, so the
  // Playground carries no dial of its own for it; a plan
  // with no rate stored resolves to the plan default.
  inflationPct: number;
  // Projection defaults (projection build): the plan's
  // resolved expected return and its starting taxable / Roth
  // balances in dollars — the projection panel's blank dials
  // fall back to these, exactly as its other defaults fall
  // back to the plan (claiming ages, step-down) above.
  expectedReturnPct: number;
  taxableStart: number;
  rothStart: number;
  // Exclude-from-plan visibility (EXCLUDE VISIBILITY build):
  // the Tax Plan record's exclusion as it applies to this
  // source, in dollars — $0 when a saved Taxable override is in
  // force (the exclusion is inert beside it) or nothing is
  // excluded — and the taxable pool BEFORE it (Taxable + Cash,
  // or the saved override itself). taxableStart above is the
  // pool AFTER the exclusion; these two let the view show the
  // resolved pool with the exclusion named beside it.
  taxableExclude: number;
  taxablePoolGross: number;
  // Plan total (PLAN TOTAL VISIBILITY build), in dollars: the
  // same total the Tax Plan view's Plan total carries — Pre-tax
  // (both spouses, as pretaxStart + pretaxSpouseStart resolve
  // them) + the taxable pool after the exclusion (taxableStart)
  // + Roth + HSA, each resolved from the saved record or the
  // snapshot exactly as the fields above resolve them. The
  // College / 529 and Non-Taxable buckets are never counted in
  // it. Display only: it prices nothing and writes nothing.
  planTotal: number;
  hsaStart: number;
};

function pgPrefillSourceFrom(
  data: RothData | undefined,
  ret: RetData | undefined,
): PgPrefillSource | null {
  if (!data || !ret) return null;
  const s = data.saved;
  const snap = data.snapshot;
  const retSaved = ret.saved;
  const seedRetAge = retSaved?.retirementAge ?? 57;
  const seedReturn =
    retSaved?.expectedReturnPct ??
    blendedExpected(retSaved?.stocksPct ?? STOCKS_PCT_DEFAULT);
  const seedSpendingCents = ret.defaultSpendingAnnualCents;
  const byP = s ? s.birthYearPrimary : SEED_BIRTH_YEAR_PRIMARY;
  const spendCents = s
    ? (s.annualSpendingCents ?? seedSpendingCents)
    : seedSpendingCents;
  const retAge = s ? (s.retirementAge ?? seedRetAge) : seedRetAge;
  const endAge = s ? (s.endAge ?? 95) : 95;
  const expRet = s ? (s.expectedReturnPct ?? seedReturn) : seedReturn;
  if (byP == null || byP < 1930 || byP > 2015) return null;
  if (spendCents < 0) return null;
  if (retAge == null || endAge == null || expRet == null) return null;
  if (endAge <= new Date().getFullYear() - byP) return null;
  const wifeSavedCents = s ? s.pretaxSpouseCents : null;
  const primaryEffectiveCents = s
    ? (s.pretaxCents ??
      (snap?.pretaxCents != null
        ? Math.max(0, snap.pretaxCents - (wifeSavedCents ?? 0))
        : null))
    : (snap?.pretaxCents ?? null);
  // The plan's resolved taxable pool, in cents — the SAME
  // resolution the plan engine's march uses (resolvePlanBalances
  // in rothOptimizer.ts; the December console's harvest pool and
  // the Tax Plan view's snapshot resolution assemble it the same
  // way): a saved Taxable override exactly as entered; while
  // following the snapshot, the Taxable bucket PLUS the Cash
  // bucket, less any exclude-from-plan amount, floored at $0;
  // $0 when neither bucket has a split. (Re-audit SHOULD S-1:
  // this read the Taxable bucket alone, so the M-1 blank-yield
  // fallback below derived its implied yields over a smaller
  // pool than the plan engine's — and the saved-plan years
  // priced from this source opened on that smaller pool — so
  // the Playground's priced yields drifted from the plan's.)
  const taxablePoolCents =
    s?.taxableCents ??
    (snap != null && (snap.taxableCents != null || snap.cashCents != null)
      ? Math.max(
          0,
          (snap.taxableCents ?? 0) +
            (snap.cashCents ?? 0) -
            Math.max(0, s?.taxableExcludeCents ?? 0),
        )
      : 0);
  // The same resolution, split for display: the pool before
  // the exclusion and the exclusion that actually applied
  // (inert — $0 — beside a saved Taxable override, exactly as
  // the engine treats it).
  const taxablePoolGrossCents =
    s?.taxableCents ??
    (snap != null && (snap.taxableCents != null || snap.cashCents != null)
      ? (snap.taxableCents ?? 0) + (snap.cashCents ?? 0)
      : 0);
  const taxableExcludeAppliedCents =
    s?.taxableCents != null ? 0 : Math.max(0, s?.taxableExcludeCents ?? 0);
  const taxReturnDollars = taxReturnPrefillDollars(data.taxReturn);
  return {
    birthYearPrimary: byP,
    birthYearSpouse: s ? s.birthYearSpouse : SEED_BIRTH_YEAR_SPOUSE,
    filingStatus: s ? (s.filingStatus ?? "mfj") : "mfj",
    pretaxStart: (primaryEffectiveCents ?? 0) / 100,
    pretaxSpouseStart: (wifeSavedCents ?? 0) / 100,
    ssPrimaryAnnual: s
      ? s.ssPrimaryNoBenefit === true
        ? 0
        : (s.ssPrimaryAnnualCents ?? 0) / 100
      : SEED_SS_PRIMARY_CENTS / 100,
    ssPrimaryStartAge: s ? s.ssPrimaryStartAge : SEED_SS_START_AGE,
    ssPrimaryNoBenefit: s ? s.ssPrimaryNoBenefit === true : false,
    ssSpouseAnnual: s
      ? s.ssSpouseNoBenefit === true
        ? 0
        : (s.ssSpouseAnnualCents ?? 0) / 100
      : 0,
    ssSpouseStartAge: s ? s.ssSpouseStartAge : null,
    ssSpouseNoBenefit: s ? s.ssSpouseNoBenefit === true : false,
    acaHouseholdSize: s ? (s.acaHouseholdSize ?? 1) : 5,
    acaHouseholdSchedule: s ? (s.acaHouseholdSchedule ?? null) : null,
    acaBenchmarkCouple:
      s?.acaBenchmarkCoupleCents == null
        ? null
        : s.acaBenchmarkCoupleCents / 100,
    acaBenchmarkSingle:
      s?.acaBenchmarkSingleCents == null
        ? null
        : s.acaBenchmarkSingleCents / 100,
    acaBenchmarkFamily:
      s?.acaBenchmarkFamilyCents == null
        ? null
        : s.acaBenchmarkFamilyCents / 100,
    stateRatePct: s ? (s.stateRatePct ?? 0) : 0,
    residenceState: s ? (s.residenceState ?? null) : null,
    itemizedMortgageInterest:
      s?.itemizedMortgageInterestCents == null
        ? null
        : s.itemizedMortgageInterestCents / 100,
    itemizedSaltPaid:
      s?.itemizedSaltPaidCents == null
        ? null
        : s.itemizedSaltPaidCents / 100,
    itemizedCharitable:
      s?.itemizedCharitableCents == null
        ? null
        : s.itemizedCharitableCents / 100,
    itemizedOther:
      s?.itemizedOtherCents == null ? null : s.itemizedOtherCents / 100,
    // The four record facts P-M5 carries (see the type
    // above): the record's own cents fields, in dollars,
    // null exactly where the record has nothing entered.
    otherOrdinary:
      s?.otherOrdinaryCents == null ? null : s.otherOrdinaryCents / 100,
    taxExemptInterest:
      s?.taxExemptInterestCents == null
        ? null
        : s.taxExemptInterestCents / 100,
    capitalLossCarryInSt:
      s?.capitalLossCarryInStCents == null
        ? null
        : s.capitalLossCarryInStCents / 100,
    capitalLossCarryInLt:
      s?.capitalLossCarryInLtCents == null
        ? null
        : s.capitalLossCarryInLtCents / 100,
    capitalLossCarryInStWa:
      s?.capitalLossCarryInStWaCents == null
        ? null
        : s.capitalLossCarryInStWaCents / 100,
    capitalLossCarryInLtWa:
      s?.capitalLossCarryInLtWaCents == null
        ? null
        : s.capitalLossCarryInLtWaCents / 100,
    healthPremiumAcaHousehold:
      s?.healthPremiumAcaHouseholdCents == null
        ? null
        : s.healthPremiumAcaHouseholdCents / 100,
    healthPremiumAcaSingle:
      s?.healthPremiumAcaSingleCents == null
        ? null
        : s.healthPremiumAcaSingleCents / 100,
    healthPremiumMedicarePerPerson:
      s?.healthPremiumMedicarePerPersonCents == null
        ? null
        : s.healthPremiumMedicarePerPersonCents / 100,
    educationStudents: s
      ? (s.educationStudents ?? null)?.map((e) => ({
          year: e.year,
          expenses: e.expensesCents / 100,
          aotcEligible: e.aotcEligible === true,
        })) ?? null
      : null,
    // The tax-return block rides the planner response beside
    // the saved inputs (it is plan-record only, never part of
    // them); the mapping to dial dollars is taxReturnCore's.
    taxReturnInterest: taxReturnDollars.interest,
    taxReturnQualifiedDividends: taxReturnDollars.qualifiedDividends,
    taxReturnOrdinaryDividends: taxReturnDollars.ordinaryDividends,
    taxReturnYear: data.taxReturn.taxReturnYear ?? null,
    spouseSoleBeneficiary: s ? (s.spouseSoleBeneficiary ?? true) : true,
    primarySoleBeneficiaryOfSpouse: s
      ? (s.primarySoleBeneficiaryOfSpouse ?? null)
      : null,
    inflationPct: s ? (s.inflationPct ?? SEED_INFLATION) : SEED_INFLATION,
    expectedReturnPct: expRet,
    taxableStart: taxablePoolCents / 100,
    rothStart: ((s ? s.rothCents : null) ?? snap?.rothCents ?? 0) / 100,
    taxableExclude: taxableExcludeAppliedCents / 100,
    taxablePoolGross: taxablePoolGrossCents / 100,
    hsaStart: ((s ? s.hsaCents : null) ?? snap?.hsaCents ?? 0) / 100,
    planTotal:
      ((primaryEffectiveCents ?? 0) +
        (wifeSavedCents ?? 0) +
        taxablePoolCents +
        ((s ? s.rothCents : null) ?? snap?.rothCents ?? 0) +
        ((s ? s.hsaCents : null) ?? snap?.hsaCents ?? 0)) /
      100,
  };
}

/* The prefill's blocker, named: mirrors pgPrefillSourceFrom's
   pricability gates in the same order and returns the plain
   name of the first input that fails, so the disabled note
   beside "Start from my numbers" can say what the saved plan
   is missing. Returns null when no specific input is at fault
   — the records are still loading, or every gate passes (the
   prefill is enabled then anyway). The resolutions below are
   pgPrefillSourceFrom's own, gate for gate: the birth year
   keeps NO fallback (a missing or out-of-range birth year
   disables the prefill), and the end age falls back to 95,
   the server's planInputsFromSaved default. */
function pgPrefillBlocker(
  data: RothData | undefined,
  ret: RetData | undefined,
): string | null {
  if (!data || !ret) return null;
  const s = data.saved;
  const retSaved = ret.saved;
  const seedRetAge = retSaved?.retirementAge ?? 57;
  const seedReturn =
    retSaved?.expectedReturnPct ??
    blendedExpected(retSaved?.stocksPct ?? STOCKS_PCT_DEFAULT);
  const seedSpendingCents = ret.defaultSpendingAnnualCents;
  const byP = s ? s.birthYearPrimary : SEED_BIRTH_YEAR_PRIMARY;
  if (byP == null || byP < 1930 || byP > 2015) return "birth year";
  const spendCents = s
    ? (s.annualSpendingCents ?? seedSpendingCents)
    : seedSpendingCents;
  if (spendCents < 0) return "annual spending";
  const retAge = s ? (s.retirementAge ?? seedRetAge) : seedRetAge;
  if (retAge == null) return "retirement age";
  const expRet = s ? (s.expectedReturnPct ?? seedReturn) : seedReturn;
  if (expRet == null) return "expected return";
  const endAge = s ? (s.endAge ?? 95) : 95;
  if (endAge == null || endAge <= new Date().getFullYear() - byP)
    return "end age";
  return null;
}
