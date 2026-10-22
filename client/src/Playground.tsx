import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ApiResponse } from "./api";
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
numField,
parseDollars,
parseIntField,
parseNum,
pctField,
sectionCls,
SEED_BIRTH_YEAR_PRIMARY,
SEED_BIRTH_YEAR_SPOUSE,
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
import { irmaaTierUpTo } from "@space/server/taxEngine";
import { taxReturnPrefillDollars } from "@space/server/taxReturnCore";
import { lawForYear, TAX_LAW_YEARS } from "@space/server/taxLaw";
import { blendedExpected, STOCKS_PCT_DEFAULT } from "@space/server/retirementEngines";
import { parsePlaygroundPaste, pricePlaygroundYear, projectPlaygroundYears, solvePlaygroundBracketFill, type PlaygroundProjection, type PlaygroundYearInputs, type PlaygroundYearResult } from "@space/server/rothOptimizer";

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

/* Income-stacking model — the ONE computation behind both the
   Playground readout's full stacking chart and the sticky play
   strip's mini bar, so the two can never draw different stacks
   for the same priced year. Presentation ONLY: every amount is
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
   pg.rmdPriced); Conversion ← pg.conversion (stacked last);
   Deductions ← pg.deductions; ordinary taxable income ←
   pg.ordinaryTaxableIncome; total taxable income ←
   pg.taxableIncome; gains ← pg.ltcgPriced, split as
   pg.qualifiedDividends + pg.stockGain; bracket tops/rates and
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
   share the one colour, in the full chart and in the play
   strip's mini bar alike (the colour rides on the marker
   objects buildStackModel returns). The ACA cliff keeps
   var(--warn) and the 0% gains line keeps the
   qualified-dividends green (#65a30d); the 20%-floor tick is
   not part of this scheme. */
const STACK_MARKER_COLORS = ["#64748b", "#6ea8d8", "#5f6caf", "#7a5c8f"] as const;

type StackSeg = {
  key: string;
  label: string;
  short?: string;
  amount: number;
  color: string;
};
type StackSegPos = StackSeg & {
  leftPct: number;
  widthPct: number;
  wide: boolean;
};

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
    { key: "interest", label: "Interest", amount: pg.interest, color: "#2563eb" },
    { key: "orddiv", label: "Ordinary dividends (non-qualified part)", short: "Ord dividends", amount: pg.nonQualifiedDividends, color: "#0891b2" },
    { key: "other", label: "Other ordinary income", short: "Other income", amount: pg.otherOrdinary, color: "#d97706" },
    { key: "ss", label: "Taxable Social Security", short: "Taxable SS", amount: pg.ssTaxable, color: "#dc2626" },
  ];
  if (pg.rmdPriced) {
    ordSegs.push({ key: "rmd", label: "RMD", amount: pg.rmd, color: "#7c3aed" });
  }
  ordSegs.push({ key: "conv", label: "Pre-tax money out", short: "Pre-tax out", amount: pg.conversion, color: "#14705a" });
  const visibleOrdSegs = ordSegs.filter((s) => s.amount !== 0);
  const grossOrd = ordSegs.reduce((a, s) => a + s.amount, 0);
  const deductions = pg.deductions;
  const ordinaryTaxable = pg.ordinaryTaxableIncome;
  const gainsTotal = pg.ltcgPriced;
  // The §1211(b) capital-loss allowance reduces the net
  // stack (it is priced against ordinary income, after the
  // loss offsets gains), so the gross total foots to AGI.
  const grossTotal = grossOrd + gainsTotal - pg.capitalLossAllowance;
  const top24 = tops[3] ?? 0;
  // The taxable axis runs to the top of the highest bracket the
  // ordinary stack reaches into — the smallest bracket top at or
  // above the ordinary taxable income — so a fill into a higher
  // bracket extends the axis by construction. Only when the
  // ordinary stack passes the 24% top does the axis fall back to
  // covering the full taxable income (gains included).
  const axisTaxableMax = (() => {
    const reached = tops.find(
      (t) => t != null && pg.ordinaryTaxableIncome <= t,
    );
    return reached != null ? reached : Math.max(top24, pg.taxableIncome);
  })();
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
    // a marker beyond the axis cap draws no line (the ACA-line
    // precedent), though its label stays, pinned at the chart's
    // right edge.
    color: STACK_MARKER_COLORS[i] ?? "var(--dim)",
    inAxis: b.to <= axisTaxableMax,
  }));
  let cum = 0;
  const ordPos: StackSegPos[] = visibleOrdSegs.map((s) => {
    const start = cum;
    cum += s.amount;
    const left = Math.min(start, cum);
    const widthPct = pct(Math.abs(s.amount));
    return { ...s, leftPct: pct(left), widthPct, wide: widthPct >= 9 };
  });
  const gainsSegs: StackSeg[] = [];
  if (gainsTotal > 0 && pg.stockGain >= 0) {
    if (pg.qualifiedDividends > 0) {
      gainsSegs.push({ key: "qualdiv", label: "Qualified dividends", short: "Qual div", amount: pg.qualifiedDividends, color: "#65a30d" });
    }
    if (pg.stockGain > 0) {
      gainsSegs.push({ key: "ltgain", label: "Long-term gain", short: "LT gain", amount: pg.stockGain, color: "#ea580c" });
    }
  } else if (gainsTotal > 0) {
    gainsSegs.push({ key: "ltgainnet", label: "Long-term gains (net)", short: "LT gains", amount: gainsTotal, color: "#ea580c" });
  }
  let gCum = grossOrd;
  const gainsPos: StackSegPos[] = gainsSegs.map((s) => {
    const start = gCum;
    gCum += s.amount;
    const widthPct = pct(Math.abs(s.amount));
    return { ...s, leftPct: pct(Math.max(0, start)), widthPct, wide: widthPct >= 12 };
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

/* The play strip's sale-leftover segment — derived from the
   sale and the year's total tax alone, using the
   engine-composed sale-after-tax leftover itself. Returns
   null when no sale is in play (and when nothing is priced),
   so the strip then renders exactly as before. `warn` marks
   the over-the-sale form for the strip's warn colour
   treatment. `note` is the segment's own plain-terms
   explanation for the strip's ⓘ tooltip, interpolating
   the SAME displayed figures the form itself was composed
   from (no new arithmetic). The total tax is the same sum
   of displayed components the readout's sale-after-tax line
   uses — round(federal) + round(state) — so the totals
   agree exactly. */
function pgSaleLeftoverSegment(
  pg: PlaygroundYearResult | null,
  sold: string,
): { text: string; warn: boolean; note: string } | null {
  if (pg == null) return null;
  const proceeds = Math.round(Math.max(0, parseDollars(sold) ?? 0));
  if (proceeds <= 0 || pg.saleAfterTax == null) return null;
  const totalTax = Math.round(pg.federalTax) + Math.round(pg.stateTax);
  const leftover = pg.saleAfterTax.leftover;
  if (leftover >= 0) {
    return {
      text: `${fmtDollars(leftover)} left`,
      warn: false,
      note: `What's left of the sale after this year's total tax. The sale brought in ${fmtDollars(proceeds)} and the year's total tax is ${fmtDollars(totalTax)}, so ${fmtDollars(leftover)} of the sale stays.`,
    };
  }
  return {
    text: `Tax ${fmtDollars(-leftover)} over the sale`,
    warn: true,
    note: `This year's total tax is ${fmtDollars(totalTax)} — more than the sale brought in (${fmtDollars(proceeds)}), by ${fmtDollars(-leftover)}. That much of the tax has to come from somewhere else.`,
  };
}

/* Held fill target — a bracket top (its rate pct) or the ACA
   cliff chip's target. One union drives the whole Hold system:
   tapping any fill chip records its target here, and the hold
   effect re-solves for whichever target is recorded. */
type PgHeldTarget = number | "aca";

/* ACA-cliff fill solve for the Playground's ACA cliff chip —
   presentation/client ONLY, exactly like the bracket-fill
   chips: it reprices candidate pre-tax amounts through the
   shared engine (pricePlaygroundYear — the same code the
   readout prices and the fixtures pin) and never computes tax
   itself. Returns the pre-tax money out (to the cent) that
   lands the year's ACA MAGI exactly on the 400%-of-FPL cliff
   the engine reports for the typed year + household size, or
   null when the priced year has no hard cliff to aim at (the
   ACA block does not apply — everyone on Medicare — no
   household size typed, or a coverage year before 2026, whose
   enhanced credit has no cliff by design: acaCreditFor's
   hasCliff rule). The solve iterates against the engine
   rather than subtracting displayed figures, so every MAGI
   component the engine counts is in the answer — interest,
   ordinary and qualified dividends, other ordinary income,
   tax-exempt interest, the stock sale's gain, the year's RMD,
   and Social Security at the amount the engine counts toward
   ACA MAGI as the draw rises. ACA MAGI is non-decreasing in
   the pre-tax amount, so a cent-level binary search over
   engine pricings finds the largest amount whose ACA MAGI is
   at or under the cliff — in the ordinary slope-1 case that
   amount prices ACA MAGI exactly on the cliff. Honest edges,
   mirroring solvePlaygroundBracketFill: other income alone
   already past the cliff → $0 (nothing can pull it back); a
   typed balance whose maximum drawable amount (balance −
   RMD) cannot reach the cliff → that maximum. */
function solvePlaygroundAcaCliffFill(
  inp: PlaygroundYearInputs,
): number | null {
  if (inp.taxYear < 2026) return null;
  const zero = pricePlaygroundYear({ ...inp, conversion: 0 });
  const cliff = zero.aca.cliff;
  if (!zero.aca.applies || cliff == null) return null;
  const pastCliff = (conversion: number): boolean =>
    pricePlaygroundYear({ ...inp, conversion }).acaMagi > cliff + 1e-9;
  if (zero.acaMagi >= cliff - 1e-9) return 0;
  // Cap: never set more than can actually come out of a typed
  // balance (the RMD comes out first). If even the cap does
  // not reach the cliff, the cap is the answer.
  let capCents: number | null = null;
  if (inp.pretaxBalance != null) {
    capCents = Math.max(0, Math.round((inp.pretaxBalance - zero.rmd) * 100));
    if (!pastCliff(capCents / 100)) return Math.round(capCents) / 100;
  }
  // Upper bound (cents) past the cliff: grow from the slope-1
  // estimate until the engine says it crosses.
  let hiCents = Math.max(
    100,
    Math.round((cliff - zero.acaMagi) * 100),
  );
  if (capCents != null) hiCents = Math.min(hiCents, capCents);
  while (!pastCliff(hiCents / 100)) {
    hiCents = hiCents * 2 + 100;
    if (capCents != null && hiCents >= capCents) {
      hiCents = capCents;
      break;
    }
    if (hiCents > 1_000_000_000) break; // $10M — far past any cliff
  }
  // Binary search: the largest cent amount whose ACA MAGI is
  // not past the cliff.
  let loCents = 0;
  let hi = hiCents;
  while (loCents < hi) {
    const mid = Math.floor((loCents + hi + 1) / 2);
    if (!pastCliff(mid / 100)) {
      loCents = mid;
    } else {
      hi = mid - 1;
    }
  }
  return Math.round(loCents) / 100;
}

/* The remembered Playground form state, in the exact shape
   the UI-state store carries it (getRothUiState's playground
   field) — the form's dials in their own typed-string units. */
type PgSavedForm = ApiResponse<typeof api, "getRothUiState">["playground"];

/* The projection template snapshot in the store's shape, and
   back: the store carries exactly the engine-input fields the
   projection runs from (see playgroundProjTemplateState in
   rothUiStateCore.ts), so the two shapes differ only in the
   optional-field spellings buildPgInputs leaves open. */
type PgProjTemplateStored = NonNullable<PgSavedForm["projTemplate"]>;
const projTemplateToStored = (
  inp: PlaygroundYearInputs,
): PgProjTemplateStored => ({
  taxYear: inp.taxYear,
  filingStatus: inp.filingStatus,
  agePrimary: inp.agePrimary,
  ageSpouse: inp.ageSpouse,
  onMedicarePrimary: inp.onMedicarePrimary,
  onMedicareSpouse: inp.onMedicareSpouse,
  interest: inp.interest,
  ordinaryDividends: inp.ordinaryDividends,
  otherOrdinary: inp.otherOrdinary,
  taxExemptInterest: inp.taxExemptInterest,
  ssPrimary: inp.ssPrimary,
  ssSpouse: inp.ssSpouse,
  conversion: inp.conversion,
  stockSold: inp.stockSold,
  stockBasis: inp.stockBasis,
  qualifiedDividends: inp.qualifiedDividends,
  pretaxBalance: inp.pretaxBalance,
  spouseSoleBeneficiary: inp.spouseSoleBeneficiary,
  acaHouseholdSize: inp.acaHouseholdSize,
  acaBenchmarkAnnual: inp.acaBenchmarkAnnual,
  stateRatePct: inp.stateRatePct,
  residenceState: inp.residenceState === "WA" ? "WA" : "other",
  itemizedMortgageInterest: inp.itemizedMortgageInterest ?? 0,
  itemizedSaltPaid: inp.itemizedSaltPaid ?? 0,
  itemizedCharitable: inp.itemizedCharitable ?? 0,
  itemizedOther: inp.itemizedOther ?? 0,
  educationStudents: inp.educationStudents ?? null,
});
const projTemplateFromStored = (
  s: PgProjTemplateStored,
): PlaygroundYearInputs => ({ ...s });

export function Playground() {
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
  const pgPrefillBlockerName = useMemo(
    () => pgPrefillBlocker(rq.data, retq.data),
    [rq.data, retq.data],
  );

  /* Playground inputs — the form's own state. The dials persist
     in the app's UI-state store (see the persistence block
     below) so the form remembers them between sessions, but
     nothing here is ever saved to the plan record or enters a
     scenario: the playground prices ONE standalone year from
     typed dials through the shared engine
     (pricePlaygroundYear in rothOptimizer.ts) so a user can ask
     "what if I convert $X and sell $Y of stock?" without
     touching the plan. "Start from my numbers" prefills the
     dials from the saved plan; "Reset playground" clears them
     back to blanks/defaults and clears the remembered copy.
     The Medicare checkboxes default to each person's age being
     65+ (a null override = follow the age) until the user
     toggles one. pgSoleBeneficiary is not a visible dial — it
     is carried from the plan by the prefill (default on) and
     only steers the RMD's Joint Life rule. */
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
  const [pgSold, setPgSold] = useState("");
  const [pgBasis, setPgBasis] = useState("");
  const [pgQualDiv, setPgQualDiv] = useState("");
  const [pgPretax, setPgPretax] = useState("");
  const [pgAcaSize, setPgAcaSize] = useState("");
  const [pgBenchmark, setPgBenchmark] = useState("");
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
  /* Hold-the-fill state — remembered with the rest of the
     form, like every other playground dial, so a held target
     is still held (and still solving) when the form reopens.
     pgHoldOn is the toggle;
     pgHeldTarget is the target of the most recently tapped
     fill chip — a bracket pct (10/12/22/24) or "aca" for the
     ACA cliff chip (null until a chip is tapped this session).
     While pgHoldOn && pgHeldTarget != null, any change to
     another dial re-solves the conversion for that target (see
     the hold effect below) so the year stays on the bracket top
     or on the ACA cliff. Typing in the conversion dial releases
     the hold (pgHoldOn off; the target is kept as the
     last-tapped target, so toggling Hold back on resumes it);
     switching Hold off also releases while keeping the target.
     Loading a projected year from the chart does NOT release
     it — the loaded dials re-solve against the held target,
     like any other dial change. Reset / prefill / a successful
     paste-load clear BOTH. */
  const [pgHoldOn, setPgHoldOn] = useState(false);
  const [pgHeldTarget, setPgHeldTarget] = useState<PgHeldTarget | null>(null);
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
  // The Projection panel's "More" expander for its longer
  // methodology — session-only, like the Roth view's How
  // toggles: the panel's always-visible intro is a short lead
  // (what the panel is, plus the ACA-convention disclosure),
  // and the mechanics live behind this toggle.
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
  type PgSectionId = "year" | "income" | "conversion" | "stock" | "aca";
  const PG_SECTIONS_OPEN: Record<PgSectionId, boolean> = {
    year: true,
    income: true,
    conversion: true,
    stock: true,
    aca: true,
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
  // app's ▾/▸ disclosure glyph; folding hides the whole card
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
          <span aria-hidden="true" className="mt-1 shrink-0 text-[var(--dim)]">
            {pgOpenSections[id] ? "▾" : "▸"}
          </span>
        </button>
      </h3>
      {pgOpenSections[id] && children}
    </section>
  );
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
    setPgSold(s.stockSold);
    setPgBasis(s.stockBasis);
    setPgQualDiv(s.qualifiedDividends);
    setPgPretax(s.pretaxBalance);
    setPgAcaSize(s.acaHouseholdSize);
    setPgBenchmark(s.acaBenchmark);
    setPgBenchmarkLoaded(s.benchmarkSource);
    setPgStateRate(s.stateRate);
    setPgResidence(s.residenceState === "WA" ? "WA" : "other");
    setPgItemizedMortgage(s.itemizedMortgageInterest);
    setPgItemizedSalt(s.itemizedSaltPaid);
    setPgItemizedCharitable(s.itemizedCharitable);
    setPgItemizedOther(s.itemizedOther);
    setPgEduStudents(s.educationStudents);
    setPgSoleBeneficiary(s.soleBeneficiary);
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
    stockSold: pgSold,
    stockBasis: pgBasis,
    qualifiedDividends: pgQualDiv,
    pretaxBalance: pgPretax,
    acaHouseholdSize: pgAcaSize,
    acaBenchmark: pgBenchmark,
    benchmarkSource: pgBenchmarkLoaded,
    stateRate: pgStateRate,
    residenceState: pgResidence,
    itemizedMortgageInterest: pgItemizedMortgage,
    itemizedSaltPaid: pgItemizedSalt,
    itemizedCharitable: pgItemizedCharitable,
    itemizedOther: pgItemizedOther,
    educationStudents: pgEduStudents,
    soleBeneficiary: pgSoleBeneficiary,
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
     entirely; the next edit re-saves. */
  const savePgCas = async (
    snapshot: PgSavedForm,
    baseRevision: number | null,
    startedJson: string,
    wholesale = false,
  ): Promise<void> => {
    let formToSave = snapshot;
    let base = baseRevision;
    if (base == null) {
      let fresh: ApiResponse<typeof api, "getRothUiState">;
      try {
        fresh = await api.getRothUiState({});
      } catch {
        return;
      }
      base = fresh.revision;
      pgRevisionRef.current = fresh.revision;
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
      return;
    }
    if (res.ok) {
      pgRevisionRef.current = res.revision;
      pgSavedJsonRef.current = JSON.stringify(formToSave);
      cachePgForm(formToSave, res.revision);
      return;
    }
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
      return;
    }
    if (!retry.ok) return;
    pgRevisionRef.current = retry.revision;
    pgSavedJsonRef.current = JSON.stringify(merged);
    cachePgForm(merged, retry.revision);
    if (
      JSON.stringify(merged) !== startedJson &&
      pgFormJsonRef.current === startedJson
    ) {
      applyPgSavedForm(merged);
    }
  };
  useEffect(() => {
    if (!pgInit) return;
    if (pgFormJson === pgSavedJsonRef.current) {
      pgForceWholesaleRef.current = false;
      return;
    }
    const localJson = pgFormJson;
    const localSnapshot = JSON.parse(localJson) as PgSavedForm;
    const t = setTimeout(async () => {
      if (pgForceWholesaleRef.current) {
        pgForceWholesaleRef.current = false;
        await savePgCas(localSnapshot, pgRevisionRef.current, localJson, true);
        return;
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
        await savePgCas(localSnapshot, pgRevisionRef.current, localJson);
        return;
      }
      pgRevisionRef.current = storedRevision;
      if (storedJson === lastSyncedJson) {
        await savePgCas(localSnapshot, storedRevision, localJson);
        return;
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
        await savePgCas(localSnapshot, storedRevision, localJson);
        return;
      }
      const mergedSnapshot = mergePgForms(
        localSnapshot,
        storedSnapshot,
        lastSyncedSnapshot,
      );
      const mergedJson = JSON.stringify(mergedSnapshot);
      await savePgCas(mergedSnapshot, storedRevision, localJson);
      if (mergedJson !== localJson && pgFormJsonRef.current === localJson) {
        applyPgSavedForm(mergedSnapshot);
      }
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pgInit, pgFormJson]);
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
    setPgSold(fmtMoneyInput(inp.stockSold));
    setPgBasis(fmtMoneyInput(inp.stockBasis));
    setPgQualDiv(fmtMoneyInput(inp.qualifiedDividends));
    setPgPretax(moneyOrBlank(inp.pretaxBalance));
    setPgAcaSize(inp.acaHouseholdSize != null ? String(inp.acaHouseholdSize) : "");
    setPgBenchmark(moneyOrBlank(inp.acaBenchmarkAnnual));
    // A paste-load is the user's own typed value, not a plan
    // prefill — clear the benchmark source record (no caption).
    setPgBenchmarkLoaded(null);
    setPgStateRate(String(inp.stateRatePct));
    setPgSoleBeneficiary(inp.spouseSoleBeneficiary);
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
    setPgSold("");
    setPgBasis("");
    setPgQualDiv("");
    setPgPretax("");
    setPgAcaSize("");
    setPgBenchmark("");
    setPgBenchmarkLoaded(null);
    setPgStateRate("0");
    setPgResidence("other");
    setPgSoleBeneficiary(true);
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
      stockSold: "",
      stockBasis: "",
      qualifiedDividends: "",
      pretaxBalance: "",
      acaHouseholdSize: "",
      acaBenchmark: "",
      benchmarkSource: null,
      stateRate: "0",
      residenceState: "other",
      itemizedMortgageInterest: "",
      itemizedSaltPaid: "",
      itemizedCharitable: "",
      itemizedOther: "",
      educationStudents: [],
      soleBeneficiary: true,
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
    };
    pgForceWholesaleRef.current = false;
    pgSavedJsonRef.current = JSON.stringify(fresh);
    void savePgCas(fresh, pgRevisionRef.current, JSON.stringify(fresh), true);
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
      stockSold: money0(pgSold),
      stockBasis: money0(pgBasis),
      qualifiedDividends: money0(pgQualDiv),
      pretaxBalance: money0OrNull(pgPretax),
      spouseSoleBeneficiary: pgSoleBeneficiary,
      acaHouseholdSize: acaSize != null && acaSize > 0 ? acaSize : null,
      acaBenchmarkAnnual: money0OrNull(pgBenchmark),
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
    pgInterest, pgOrdDiv, pgOther, pgTaxExempt, pgSsP, pgSsS, pgConversion,
    pgSold, pgBasis, pgQualDiv, pgPretax, pgSoleBeneficiary, pgAcaSize,
    pgBenchmark, pgStateRate, pgResidence,
    pgItemizedMortgage, pgItemizedSalt, pgItemizedCharitable, pgItemizedOther, pgEduStudents,
  ]);

  // Zero-conversion pricing of the same dials — the hold
  // captions read their overage from it (display arithmetic
  // only, through the same pricePlaygroundYear the readout
  // uses). Null until an age is entered, like the readout.
  const pgZeroResult: PlaygroundYearResult | null = useMemo(() => {
    if (pgAgePNum == null || pgAgePNum <= 0) return null;
    return pricePlaygroundYear(buildPgInputs(0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    pgYear, pgFiling, pgAgePNum, pgAgeSNum, pgMedPEffective, pgMedSEffective,
    pgInterest, pgOrdDiv, pgOther, pgTaxExempt, pgSsP, pgSsS,
    pgSold, pgBasis, pgQualDiv, pgPretax, pgSoleBeneficiary, pgAcaSize,
    pgBenchmark, pgStateRate, pgResidence,
    pgItemizedMortgage, pgItemizedSalt, pgItemizedCharitable, pgItemizedOther, pgEduStudents,
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
  // ACA cliff instead of a bracket top — set the conversion
  // dial to the exact amount that lands the year's ACA MAGI on
  // the 400%-of-FPL cliff, solved through the shared engine
  // (solvePlaygroundAcaCliffFill) against every other dial as
  // currently typed, the stock sale's gain included. Tapping
  // it ALSO records "aca" as the held target, exactly like a
  // bracket chip, so Hold re-solves to the cliff. When the
  // priced year has no hard cliff the chip is disabled (see
  // pgAcaCliffNote below) and this never runs; the null guard
  // is the backstop.
  const applyPgAcaCliffFill = () => {
    if (pgAgePNum == null || pgAgePNum <= 0) return;
    const fill = solvePlaygroundAcaCliffFill(buildPgInputs(0));
    if (fill == null) return;
    setPgHeldTarget("aca");
    setPgConversion(fmtMoneyInput(fill));
  };

  /* Hold-the-fill effect: while Hold is on and a target is
     set, ANY change to any other dial (every input that feeds
     buildPgInputs except the conversion itself) re-solves the
     conversion for the held target and updates the conversion
     dial, so the year stays on that bracket top — or, for the
     ACA cliff target, ACA MAGI stays on the cliff — and the
     stacking chart below re-renders from the same priced
     result, so the conversion segment's end stays glued to the
     held line. The solve is
     idempotent: solving an already-solved state returns the
     same value, and the effect only writes state when the
     solved value differs (by more than half a cent) from the
     dial's current value, so it cannot loop. Typing in the
     conversion dial releases the hold first (its onEdit), so
     this effect never fights a manual entry. */
  useEffect(() => {
    if (!pgHoldOn || pgHeldTarget == null) return;
    if (pgAgePNum == null || pgAgePNum <= 0) return;
    // The held target picks the solver: a bracket pct re-solves
    // to that bracket top; "aca" re-solves to the ACA cliff (a
    // null cliff solve — the year no longer has a hard cliff —
    // leaves the dial exactly as it stands).
    let fill: number | null;
    if (pgHeldTarget === "aca") {
      fill = solvePlaygroundAcaCliffFill(buildPgInputs(0));
    } else {
      fill = solvePlaygroundBracketFill(buildPgInputs(0), pgHeldTarget);
    }
    if (fill == null) return;
    const current = parseDollars(pgConversion) ?? 0;
    if (Math.abs(current - fill) > 0.005) {
      setPgConversion(fmtMoneyInput(fill));
    }
    // buildPgInputs is rebuilt every render from the dial state
    // listed below; pgConversion is read for the idempotence
    // guard but deliberately NOT a trigger — a solver write
    // must not re-trigger the solve (the guard would stop it,
    // but there is nothing new to solve).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    pgHoldOn, pgHeldTarget,
    pgYear, pgFiling, pgAgePNum, pgAgeSNum, pgMedPEffective, pgMedSEffective,
    pgInterest, pgOrdDiv, pgOther, pgTaxExempt, pgSsP, pgSsS,
    pgSold, pgBasis, pgQualDiv, pgPretax, pgSoleBeneficiary, pgAcaSize,
    pgBenchmark, pgStateRate, pgResidence,
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
     shapes, so a loaded projected year — whose Medicare flags
     follow age and whose ACA convention is the projection's
     own — compares on the dial fields only. */
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
    const stepYear = intOr(pgProjAcaStepYear, src?.acaStepDownYear ?? null);
    const sizeAfter = intOr(
      pgProjAcaSizeAfter,
      src != null ? src.acaHouseholdSizeAfter : null,
    );
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
      acaHouseholdSizeAfter: stepYear != null ? sizeAfter : null,
      acaStepDownYear: stepYear,
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
     year's own priced inputs become the dials (its calendar
     year and ages, its Social Security amounts, its effective
     pre-tax money out, its stock sale, its starting pre-tax
     balance, its household size), and the readout below
     reprices them through the single-year path — unchanged.
     The Medicare dials return to following age, which is the
     rule the projection itself priced by. Loading a year does
     NOT release the fill hold: the loaded dials are a change
     like any other, so with Hold on the hold effect re-solves
     the loaded year's pre-tax money out against the held
     target the moment it lands (a year that cannot hold the
     target gets the usual can't-hold caption instead). The
     raw amount the projection walked stays visible in the
     bar itself; Hold off loads a year untouched. It
     deliberately does NOT touch the projection template: the
     chart above keeps every bar and keeps running from its
     captured template, so any bar can be clicked in any
     order — earlier years included — and the way back to the
     template year is clicking its bar. */
  const loadProjYear = (calendarYear: number) => {
    const y = pgProjection?.years.find((yr) => yr.calendarYear === calendarYear);
    if (!y) return;
    const inp = y.inputs;
    pgForceWholesaleRef.current = true;
    setPgYear(String(inp.taxYear));
    setPgAgeP(String(inp.agePrimary));
    setPgAgeS(inp.ageSpouse != null ? String(inp.ageSpouse) : "");
    setPgMedP(null);
    setPgMedS(null);
    setPgSsP(fmtMoneyInput(inp.ssPrimary));
    setPgSsS(fmtMoneyInput(inp.ssSpouse));
    setPgConversion(fmtMoneyInput(inp.conversion));
    setPgSold(fmtMoneyInput(inp.stockSold));
    setPgBasis(fmtMoneyInput(inp.stockBasis));
    setPgPretax(inp.pretaxBalance == null ? "" : fmtMoneyInput(inp.pretaxBalance));
    setPgAcaSize(
      inp.acaHouseholdSize != null ? String(inp.acaHouseholdSize) : "",
    );
    setPgProjSelectedYear(calendarYear);
  };

  // "Start from my numbers": prefill the dials from the
  // saved plan (the working plan inputs, which already carry the
  // Net Worth-resolved balances). Ages derive from the plan's
  // birth years for the playground's chosen tax year; Social
  // Security is the plan's amount when the chosen year reaches
  // that person's claim age, else $0; the ACA size follows the
  // plan's step-down year; the benchmark keys on who is on the
  // marketplace that year (see the pick below). Interest and
  // the two dividend dials come from the plan record's
  // tax-return actuals (Form 1040 lines 2b / 3a / 3b — the only
  // figures those fields feed). Starting here
  // never writes the plan, and editing the dials never writes
  // back — the prefilled dials simply become the remembered
  // form state, like typed values.
  const prefillPlayground = () => {
    if (!pgPrefillSource) return;
    pgForceWholesaleRef.current = true;
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
    const size =
      pgPrefillSource.acaStepDownYear != null && taxYear >= pgPrefillSource.acaStepDownYear
        ? pgPrefillSource.acaHouseholdSizeAfter
        : pgPrefillSource.acaHouseholdSize;
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
    const pretaxTotal = pgPrefillSource.pretaxStart + (pgPrefillSource.pretaxSpouseStart ?? 0);
    setPgPretax(pretaxTotal > 0 ? fmtMoneyInput(pretaxTotal) : "");
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
    // Tax-return actuals (1040 LINES build): the plan record's
    // Form 1040 lines fill the three income dials — interest ←
    // line 2b, qualified dividends ← line 3a, ordinary
    // dividends ← the line 3b TOTAL (the dial takes the total;
    // the pricer derives the non-qualified part). A line the
    // plan has not entered leaves its dial blank.
    setPgInterest(
      pgPrefillSource.taxReturnInterest != null
        ? fmtMoneyInput(pgPrefillSource.taxReturnInterest)
        : "",
    );
    setPgQualDiv(
      pgPrefillSource.taxReturnQualifiedDividends != null
        ? fmtMoneyInput(pgPrefillSource.taxReturnQualifiedDividends)
        : "",
    );
    setPgOrdDiv(
      pgPrefillSource.taxReturnOrdinaryDividends != null
        ? fmtMoneyInput(pgPrefillSource.taxReturnOrdinaryDividends)
        : "",
    );
    setPgSoleBeneficiary(pgPrefillSource.spouseSoleBeneficiary);
  };

  /* Hold captions — display arithmetic ONLY, from the priced
     results above (the current-conversion readout and the
     zero-conversion pricing), never a second calculator. The
     can't-hold captions render only while Hold is on with a
     target set, under the fill chips row, and they are mutually
     exclusive: past-the-target requires the zero-conversion
     pricing to already exceed the target (ordinary taxable
     income past the bracket top, or ACA MAGI past the cliff),
     while balance-capped requires it to be under the target
     with the held conversion sitting exactly at the balance
     cap (balance − RMD) — its shortfall measured to the same
     target (bracket top, or cliff − priced ACA MAGI). A typed
     $0 balance with income under the target lands in the capped
     case (cap $0); with no balance typed, a $0 fill from
     income alone is the past-the-target case. */
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
  const pgHeldCliffDollars: number | null =
    pgHeldTarget === "aca"
      ? (pgZeroResult?.aca.cliff ?? playgroundResult?.aca.cliff ?? null)
      : null;
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
    if (playgroundResult == null || pgZeroResult == null) return null;
    if (pgHeldTarget === "aca") {
      // The cliff can't-hold captions mirror the bracket ones:
      // the overage comes from the zero-pre-tax pricing, and
      // the cap is the typed balance after the RMD, as today.
      if (!pgAcaHasHardCliff) return null;
      const cliff = pgZeroResult.aca.cliff;
      if (cliff == null) return null;
      const zeroAca = pgZeroResult.acaMagi;
      if (zeroAca > cliff + 0.005) {
        return `Already past the ACA cliff without any pre-tax money out — held at $0, still ${fmtDollars(zeroAca - cliff)} over the ACA cliff.`;
      }
      const balRaw = parseDollars(pgPretax);
      if (balRaw != null) {
        const bal = Math.max(0, balRaw);
        const cap = Math.max(0, bal - playgroundResult.rmd);
        const conv = parseDollars(pgConversion) ?? 0;
        const short = cliff - playgroundResult.acaMagi;
        if (Math.abs(conv - cap) <= 0.01 && short > 0.5) {
          return `Pre-tax balance caps the fill at ${fmtDollars(cap)} — ${fmtDollars(short)} short of the ACA cliff.`;
        }
      }
      return null;
    }
    if (pgHeldTopDollars == null) return null;
    const top = pgHeldTopDollars;
    const zeroOrd = pgZeroResult.ordinaryTaxableIncome;
    if (zeroOrd > top + 0.005) {
      return `Already past the ${pgHeldTarget}% top without any pre-tax money out — held at $0, still ${fmtDollars(zeroOrd - top)} over.`;
    }
    const balRaw = parseDollars(pgPretax);
    if (balRaw != null) {
      const bal = Math.max(0, balRaw);
      const cap = Math.max(0, bal - playgroundResult.rmd);
      const conv = parseDollars(pgConversion) ?? 0;
      const short = top - playgroundResult.ordinaryTaxableIncome;
      if (Math.abs(conv - cap) <= 0.01 && short > 0.5) {
        return `Pre-tax balance caps the fill at ${fmtDollars(cap)} — ${fmtDollars(short)} short of the ${pgHeldTarget}% top.`;
      }
    }
    return null;
  })();
  /* The held-at-the-cliff readout: while the ACA cliff target
     is held (and no can't-hold caption applies — the render
     shows this only when pgHoldCantCaption is null), the
     caption names the target it is holding, in the same place
     and style as the can't-hold captions. */
  const pgHoldCliffCaption: string | null = (() => {
    if (!pgHoldActive || pgHeldTarget !== "aca") return null;
    if (!pgAcaHasHardCliff || pgHeldCliffDollars == null) return null;
    return `Holding at the ACA cliff — ${fmtDollars(pgHeldCliffDollars)}`;
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
     2026-10-21) — display ONLY, rendered under the Qualified
     dividends dial in the Stock sale section. The Ordinary
     dividends dial is the TOTAL (Form 1040 line 3b) and the
     Qualified dial is a subset of it (line 3a), so a qualified
     figure above the total is a pair that cannot occur on a
     real 1099-DIV. The engine derives the non-qualified part
     as max(0, total − qualified) — $0 on such a pair, the
     excess not counted — and this note makes that visible at
     the dials instead of letting the excess drop out
     silently. It reads the two dials exactly as the priced
     inputs clamp them (negatives to $0), so it appears
     precisely when the priced pair is impossible, and it
     never alters pricing. */
  const pgDividendPairNote: string | null = (() => {
    const total = Math.max(0, parseDollars(pgOrdDiv) ?? 0);
    const qualified = Math.max(0, parseDollars(pgQualDiv) ?? 0);
    if (qualified <= total) return null;
    return `Qualified dividends (${fmtDollars(qualified)}) can't exceed the total ordinary dividends (${fmtDollars(total)}) — the qualified figure is part of that total, so the excess isn't counted and the non-qualified part prices as $0.`;
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
  const pgConversionSummary = `Money out ${pgMoneySummary(pgConversion)} · balance ${pgMoneySummary(pgPretax)}`;
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

  return (
    <div>
        <section className={sectionCls} aria-label="Playground">
          {/* Sticky play strip — a pure render over the SAME
              priced result (`playgroundResult`) the readout below
              renders: no new state, no storage, no actions, and
              no pricing of its own. It pins at the top of the
              Playground tab while the tab scrolls so the live
              figures stay in view next to the dials. The app has
              no sticky/fixed header of its own (the view switch
              above scrolls away; the only fixed element is the
              pointer-events-none safe-area scrim), so the strip
              pins at the window's top, offset only by the
              device's safe-area inset top — 0 on desktop. The
              mini bar renders buildStackModel, the readout
              chart's own segment computation, at a slim height:
              same segments in engine order, deductions hatch at
              the start, bracket-band shading behind, and the
              10/12/22/24 tops as tick marks from the same model;
              no legend and no in-bar labels (the full chart
              below keeps all of that). */}
          {(() => {
            const pg = playgroundResult;
            const stripYearNum =
              parseIntField(pgYear) ?? new Date().getFullYear();
            const statuses: { key: string; text: string; warn: boolean }[] = [];
            if (
              pg != null &&
              pg.aca.applies &&
              pg.aca.cliff != null &&
              pg.aca.positionDollars != null
            ) {
              // Composed from pg's ACA fields exactly as the
              // readout states them: the stack note's room line
              // and "No ACA cliff in {year}." phrasing, and the
              // takeaway's over-the-cliff figure. The engine's
              // cliff exists only for coverage 2026+ (its
              // hasCliff rule), so a 2025 year shows the note's
              // no-cliff line instead of a position.
              if (stripYearNum < 2026) {
                statuses.push({
                  key: "aca",
                  text: `No ACA cliff in ${stripYearNum}`,
                  warn: false,
                });
              } else if (pg.aca.overCliff) {
                statuses.push({
                  key: "aca",
                  text: `Over the ACA cliff by ${fmtDollars(-pg.aca.positionDollars)}`,
                  warn: true,
                });
              } else {
                statuses.push({
                  key: "aca",
                  text: `ACA cliff: ${fmtDollars(pg.aca.positionDollars)} of room`,
                  warn: false,
                });
              }
            }
            if (pg != null && pg.irmaa.applies && pg.irmaa.tier >= 1) {
              statuses.push({
                key: "irmaa",
                text: `IRMAA Tier ${pg.irmaa.tier}`,
                warn: true,
              });
            }
            const model =
              pg != null ? buildStackModel(pg, stripYearNum, pgFiling) : null;
            const saleSegment = pgSaleLeftoverSegment(pg, pgSold);
            // The MAGI figure's own ⓘ note: static copy, except
            // the ACA cliff amount in the parenthetical — the
            // priced year's own cliff (the same pg.aca.cliff the
            // ACA status above reads), present only when the ACA
            // applies to this year and a cliff actually exists
            // for the priced year. The engine carries the
            // 400%-of-FPL dollar line in every year, but the
            // cliff behaviour exists only for coverage 2026+
            // (hasCliff = coverageYear >= 2026) — the same
            // coverage-year rule the ACA status above uses for
            // its no-cliff branch — so in 2025 the parenthetical
            // is omitted entirely.
            const magiNote = `MAGI — modified adjusted gross income: every dollar of income the year counts, added up before deductions — interest, dividends, other income, any RMD, the taxable part of Social Security, the pre-tax money out, and gains — with tax-exempt interest added back (that's the 'modified' part). It's the yardstick for both cliffs: the ACA cliff${
              pg != null && stripYearNum >= 2026 && pg.aca.applies && pg.aca.cliff != null
                ? ` (this year: ${fmtDollars(pg.aca.cliff)})`
                : ""
            } and the IRMAA tiers are lines drawn on MAGI. The ACA's version also counts the part of Social Security that isn't taxed.`;
            return (
              <div
                className="sticky z-30 mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 shadow-md"
                style={{ top: "var(--twsa-safe-area-inset-top, 0px)" }}
                aria-label="Play strip — live summary of the priced year"
              >
                {model != null && pg != null ? (
                  <div
                    className="relative h-3.5 min-w-[7rem] flex-1 basis-40 overflow-hidden rounded-sm"
                    role="img"
                    aria-label={`Income stack in miniature: ${
                      model.legendSegs.length > 0
                        ? model.legendSegs
                            .map((s) => `${s.label} ${fmtDollars(s.amount)}`)
                            .join(", ")
                        : "no income typed"
                    }, less deductions ${fmtDollars(model.deductions)}`}
                  >
                    <div className="absolute inset-0" aria-hidden="true">
                      {model.bands.map((b, i) => (
                        <div
                          key={b.rate}
                          className="absolute top-0 bottom-0"
                          style={{
                            left: `${model.taxX(b.from)}%`,
                            width: `${Math.max(0, model.taxX(b.to) - model.taxX(b.from))}%`,
                            background:
                              i % 2 === 0
                                ? "rgba(128,128,128,0.07)"
                                : "rgba(20,89,76,0.08)",
                          }}
                        />
                      ))}
                    </div>
                    {model.gainsPos.map((s) => (
                      <div
                        key={s.key}
                        className="absolute top-0 h-3.5"
                        style={{
                          left: `${s.leftPct}%`,
                          width: `${s.widthPct}%`,
                          background: s.color,
                        }}
                        aria-hidden="true"
                      />
                    ))}
                    {model.ordPos.map((s) => (
                      <div
                        key={s.key}
                        className="absolute top-0 h-3.5 border-r border-[var(--bg)]"
                        style={{
                          left: `${s.leftPct}%`,
                          width: `${s.widthPct}%`,
                          background: s.color,
                        }}
                        aria-hidden="true"
                      />
                    ))}
                    {model.deductions > 0 && (
                      <div
                        className="pointer-events-none absolute top-0 h-3.5 border-r-2 border-dashed border-[var(--text)]"
                        style={{
                          left: 0,
                          width: `${model.pct(model.deductions)}%`,
                          ...model.hatchStyle,
                        }}
                        aria-hidden="true"
                      />
                    )}
                    <div
                      className="pointer-events-none absolute inset-0"
                      aria-hidden="true"
                    >
                      {model.markers
                        .filter((m) => m.inAxis)
                        .map((m) => (
                          <div
                            key={m.rate}
                            className="absolute top-0 bottom-0 border-l border-dashed"
                            style={{
                              left: `${model.taxX(m.to)}%`,
                              borderColor: m.color,
                            }}
                          />
                        ))}
                    </div>
                  </div>
                ) : (
                  <div
                    className="relative h-3.5 min-w-[7rem] flex-1 basis-40 overflow-hidden rounded-sm border border-[var(--border)]"
                    role="img"
                    aria-label="Income stack in miniature: nothing priced yet"
                  >
                    <div
                      className="absolute inset-0"
                      style={STACK_HATCH_STYLE}
                      aria-hidden="true"
                    />
                  </div>
                )}
                <p className="tnum flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
                  <span>
                    Total federal tax{" "}
                    <span className="font-bold text-[var(--accent)]">
                      {fmtDollars(pg?.federalTax ?? 0)}
                    </span>
                  </span>
                  <span aria-hidden="true" className="text-[var(--dim)]">
                    ·
                  </span>
                  <span>
                    MAGI {fmtDollars(pg?.magi ?? 0)}
                    {pg != null && (
                      <InfoNote
                        text={magiNote}
                        ariaLabel="About MAGI in the play strip"
                        viewportClamp
                      />
                    )}
                  </span>
                  {statuses.map((s) => (
                    <span key={s.key} className="contents">
                      <span aria-hidden="true" className="text-[var(--dim)]">
                        ·
                      </span>
                      <span
                        className={
                          s.warn
                            ? "font-medium text-[var(--warn)]"
                            : "text-[var(--dim)]"
                        }
                      >
                        {s.text}
                      </span>
                    </span>
                  ))}
                  {saleSegment != null && (
                    <span className="contents">
                      <span aria-hidden="true" className="text-[var(--dim)]">
                        ·
                      </span>
                      <span
                        className={
                          saleSegment.warn
                            ? "font-medium text-[var(--warn)]"
                            : undefined
                        }
                      >
                        {saleSegment.text}
                        <InfoNote
                          text={saleSegment.note}
                          ariaLabel="About the sale figure in the play strip"
                          align="right"
                          viewportClamp
                        />
                      </span>
                    </span>
                  )}
                </p>
              </div>
            );
          })()}
          <h2 className="text-base font-semibold">Playground</h2>
          <p className="mt-1 max-w-3xl text-sm text-[var(--dim)]">
            One year, your numbers: type the year&rsquo;s income, the pre-tax money taken out,
            and a stock sale, and this prices where the year lands — which bracket
            it fills, whether it stays under the ACA cliff, and what
            it does to IRMAA. It runs through the same engine as the plan, so the
            two can never disagree. The form remembers its dials between visits,
            so the numbers you were playing with are still here when you come
            back — and your plan is never touched. “Reset playground” wipes the
            form back to blank.
          </p>
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

          <div className="mt-3 max-w-3xl">
            <label
              className="block text-sm font-medium text-[var(--text)]"
              htmlFor="roth-pg-paste"
            >
              Load inputs from a paste
            </label>
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
                  return lawYear !== dialedYear
                    ? `No ${dialedYear} law row in the app’s tax tables yet — priced under the ${lawYear} law row.`
                    : "Priced under that year’s law row in the app’s tax tables.";
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
              info: "Interest your bank and bonds pay you during the year — savings accounts, CDs, Treasury and corporate bonds. It's taxed as ordinary income.",
            })}
            {moneyField("Ordinary dividends — total (line 3b)", pgOrdDiv, setPgOrdDiv, {
              hint: "Type it exactly as printed on the Form 1040 (line 3b). It includes the qualified dividends (line 3a) — they are counted once, not added again.",
              info: "All the ordinary dividends for the year — the total on Form 1040 line 3b (your 1099-DIV's total ordinary dividends). That total already includes the qualified dividends on line 3a: the qualified part is priced at the lower gains rates and the rest at ordinary rates, with the total counted once.",
              infoAlign: "right",
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
            {moneyField("Pre-tax money out (draw or conversion)", pgConversion, setPgConversion, {
              hint: pgHoldActive && pgHeldTarget != null && (pgHeldTarget !== "aca" || pgAcaHasHardCliff)
                ? pgHeldTarget === "aca"
                  ? pgHeldCliffDollars != null
                    ? `Auto — holding at the ACA cliff — ${fmtDollars(pgHeldCliffDollars)}`
                    : "Auto — holding the ACA cliff"
                  : `Auto — holding the ${pgHeldTarget}% top`
                : "The dial: type how much leaves the pre-tax account this year — drawn to spend or converted to Roth, it is taxed the same — and watch where the year lands below.",
              info: "Money that leaves your pre-tax account this year — drawn out to spend, or converted into your Roth. The full amount counts as ordinary income this year either way.",
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
            {moneyField("Pre-tax balance (prior Dec 31)", pgPretax, setPgPretax, {
              hint: "Optional. When entered, the year's RMD is priced on this balance (Joint Life when it applies) and the pre-tax money out is checked against what's left after the RMD.",
              info: "What was in your traditional IRA / 401(k) on the prior Dec 31. Entering it lets the playground price this year's required minimum distribution (RMD) and check the pre-tax money out fits. Blank = no RMD priced.",
              infoAlign: "right",
            })}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="flex items-center text-sm text-[var(--dim)]">
              Fill to:
              <InfoNote
                text="Sets the pre-tax money out amount for you: exactly enough to fill this tax bracket — or, with the ACA cliff chip, to land ACA household income exactly on the 400% poverty-line cliff — given everything else you've typed. The bracket tops are the ceilings of the 10%, 12%, 22% and 24% brackets."
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
                text="With Hold on, changing any other dial re-solves the pre-tax money out so the year stays on the tapped target — a bracket top or the ACA cliff. Typing an amount yourself, or switching Hold off, releases it."
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
            {moneyField("Qualified dividends (line 3a)", pgQualDiv, setPgQualDiv, {
              hint: "Part of the line 3b total above — not in addition to it.",
              info: "Dividends that qualify for the lower tax rate — Form 1040 line 3a, exactly as printed. This amount is part of the total ordinary dividends (line 3b) you entered above, not extra income on top of it: it is counted once, riding the lower 0% / 15% / 20% gains staircase instead of the ordinary rates.",
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
                <span aria-hidden="true" className="mt-1 shrink-0 text-[var(--dim)]">
                  {pgProjOpen ? "▾" : "▸"}
                </span>
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
                <button
                  type="button"
                  aria-label="More about how the projection works"
                  aria-expanded={pgProjHowOpen}
                  className="mt-1 px-1 py-1 text-xs text-[var(--dim)] underline underline-offset-2 hover:text-[var(--accent)]"
                  onClick={() => setPgProjHowOpen((o) => !o)}
                >
                  {pgProjHowOpen ? "Less" : "More"}
                </button>
                {pgProjHowOpen && (
                  <div className="mt-2 max-w-3xl space-y-2 text-sm text-[var(--dim)]">
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
                  </div>
                )}
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
                    hint: "The household size from the step-down year on.",
                  })}
                  {numField("ACA step-down year", pgProjAcaStepYear, setPgProjAcaStepYear, {
                    idLabel: "Projection ACA step-down year",
                    hint:
                      pgPrefillSource?.acaStepDownYear != null
                        ? `Blank uses your plan's step-down year (${pgPrefillSource.acaStepDownYear}).`
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
                    const segDefs = [
                      { key: "interest", label: "Interest", color: "#2563eb" },
                      { key: "orddiv", label: "Ordinary dividends (non-qualified part)", color: "#0891b2" },
                      { key: "other", label: "Other ordinary income", color: "#d97706" },
                      { key: "ss", label: "Taxable Social Security", color: "#dc2626" },
                      { key: "rmd", label: "RMD", color: "#7c3aed" },
                      { key: "conv", label: "Pre-tax money out", color: "#14705a" },
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
                                : r.conversion;
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
                                return (
                                  <button
                                    key={y.calendarYear}
                                    type="button"
                                    aria-label={`Load ${y.calendarYear} (age ${y.agePrimary}) into the single-year view — MAGI ${fmtDollars(y.result.magi)}, total tax ${fmtDollars(y.result.totalTax)}`}
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
                        <div className="mt-5" aria-label="Projected balances chart">
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

          {playgroundResult == null && (
            <p className="mt-4 text-sm text-[var(--dim)]" role="note">
              Enter your age for the year above and the year is priced here —
              bracket landing, ACA cliff, and IRMAA, all from the same engine as
              the plan.
            </p>
          )}
          {playgroundResult != null &&
            (() => {
              const pg = playgroundResult;
              const pgYearNum = parseIntField(pgYear) ?? new Date().getFullYear();
              // The entered pre-tax balance as buildPgInputs prices
              // it (negatives clamped to 0) — the readout's RMD
              // subtext and balance watch-out read it from here so
              // they name the same balance the engine priced.
              const pgPretaxRaw = parseDollars(pgPretax);
              const pgPretaxBalance =
                pgPretaxRaw == null ? null : Math.max(0, pgPretaxRaw);
              const pgBalanceLeftAfterRmd =
                pgPretaxBalance == null ? null : pgPretaxBalance - pg.rmd;
              const takeawayParts: string[] = [];
              if (pg.conversion <= 0) {
                takeawayParts.push("No pre-tax money out typed");
              } else if (pg.landingBracketPct != null) {
                takeawayParts.push(
                  pg.landingExactlyFilled
                    ? `Pre-tax money out fills the ${pg.landingBracketPct}% bracket exactly`
                    : pg.landingRoomLeft != null
                      ? `Pre-tax money out lands in the ${pg.landingBracketPct}% bracket with ${fmtDollars(pg.landingRoomLeft)} of room left in it`
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
              const stackRow = (
                label: string,
                value: string,
                sub?: string,
                highlightValue?: boolean,
              ) => (
                <div>
                  <dt className="text-[var(--dim)]">{label}</dt>
                  <dd className="tnum font-medium">
                    {highlightValue ? (
                      <span className="font-bold text-[var(--accent)]">{value}</span>
                    ) : (
                      value
                    )}
                  </dd>
                  {sub && <dd className="text-xs text-[var(--dim)]">{sub}</dd>}
                </div>
              );
              /* Income-stacking chart — presentation ONLY. The
                 segment model (segments, positions, bands,
                 markers, hatch) comes from buildStackModel above
                 — the same computation the sticky play strip's
                 mini bar renders from, so the two always agree.
                 Every figure is read straight off the priced
                 result (`pg`, pricePlaygroundYear's own fields);
                 see buildStackModel's comment for the sourcing. */
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
                } = buildStackModel(pg, pgYearNum, pgFiling);
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
                    <div className="relative mt-1 h-11" aria-hidden="true">
                      {markers.map((m, i) => (
                        <span
                          key={m.rate}
                          className="tnum absolute text-[11px] whitespace-nowrap"
                          style={{
                            color: m.color,
                            left: m.inAxis ? `${taxX(m.to)}%` : "100%",
                            top: i % 2 === 0 ? 0 : 18,
                            transform: !m.inAxis
                              ? "translateX(-92%)"
                              : i === 0
                                ? "translateX(-8%)"
                                : i === markers.length - 1
                                  ? "translateX(-92%)"
                                  : "translateX(-50%)",
                          }}
                        >
                          {m.rate}% ·{" "}
                          {m.room > 0.5
                            ? `${fmtDollars(m.room)} left`
                            : m.room >= -0.5
                              ? "filled"
                              : "passed"}
                        </span>
                      ))}
                    </div>
                    {gainsTotal > 0 && (
                      <div className="relative h-4">
                        <span
                          className="absolute inline-flex items-center whitespace-nowrap"
                          style={{
                            left: `${taxX(zeroTop)}%`,
                            transform:
                              taxX(zeroTop) > 85
                                ? "translateX(-92%)"
                                : taxX(zeroTop) < 15
                                  ? "translateX(-8%)"
                                  : "translateX(-50%)",
                          }}
                        >
                          <span
                            aria-hidden="true"
                            className="tnum text-[11px]"
                            style={{ color: "#65a30d" }}
                          >
                            0% gains end · {fmtDollars(zeroTop)}
                          </span>
                          <InfoNote
                            text={`Long-term gains and qualified dividends in the taxable account are taxed at 0% while total taxable income stays under ${fmtDollars(zeroTop)}. Past that line they price at 15%, and at 20% once taxable income passes ${fmtDollars(floor20)}.`}
                            ariaLabel="About the 0% gains line"
                            align={taxX(zeroTop) > 60 ? "right" : "left"}
                          />
                        </span>
                        {show20 && (
                          <span
                            aria-hidden="true"
                            className="tnum absolute text-[11px] whitespace-nowrap text-[var(--dim)]"
                            style={{
                              left: `${taxX(floor20)}%`,
                              transform: "translateX(-92%)",
                            }}
                          >
                            20% from {fmtDollars(floor20)}
                          </span>
                        )}
                      </div>
                    )}
                    <div className="relative">
                      <div className="absolute inset-0" aria-hidden="true">
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
                            style={{ left: `${taxX(zeroTop)}%`, borderColor: "#65a30d" }}
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
                            className="pointer-events-none absolute top-0 h-10 border-r-2 border-dashed border-[var(--text)]"
                            style={{ left: 0, width: `${pct(deductions)}%`, ...hatchStyle }}
                            aria-hidden="true"
                          />
                        )}
                      </div>
                      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
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
                              borderColor: "#65a30d",
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
                      </div>
                    </div>
                    <div className="relative mt-1 h-4" aria-hidden="true">
                      <span
                        className="tnum absolute text-[11px] whitespace-nowrap text-[var(--dim)]"
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
                          className="tnum absolute text-[11px] font-medium whitespace-nowrap"
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
                      <span
                        className="tnum absolute text-[11px] whitespace-nowrap text-[var(--dim)]"
                        style={{ right: 0 }}
                      >
                        {fmtDollars(axisTaxableMax)}
                      </span>
                    </div>
                    {legendSegs.length > 0 && (
                      <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--dim)]">
                        {legendSegs.map((s) => (
                          <span key={s.key} className="inline-flex items-center gap-1.5">
                            <span
                              className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                              style={{ background: s.color }}
                              aria-hidden="true"
                            />
                            {s.label}{" "}
                            <span className="tnum font-medium text-[var(--text)]">
                              {fmtDollars(s.amount)}
                            </span>
                          </span>
                        ))}
                      </p>
                    )}
                    <p className="tnum mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--dim)]">
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm border border-[var(--dim)]"
                          style={hatchStyle}
                          aria-hidden="true"
                        />
                        Deductions{" "}
                        <span className="font-medium text-[var(--text)]">
                          −{fmtDollars(deductions)}
                        </span>
                      </span>
                      {markers.map((m) => (
                        <span key={m.rate} style={{ color: m.color }}>
                          {m.rate}% top {fmtDollars(m.to)} —{" "}
                          {m.room > 0.5
                            ? `${fmtDollars(m.room)} left`
                            : m.room >= -0.5
                              ? "filled exactly"
                              : `passed by ${fmtDollars(-m.room)}`}
                        </span>
                      ))}
                      {/* The 0% gains line's caption, in the same
                          idiom as the bracket captions above: its
                          room uses their comparator — the top
                          minus the ORDINARY taxable income — so
                          "passed by"/"left" says how the ordinary
                          stack alone stands against the line,
                          before the gains stack on top is priced
                          (the Gains stack panel below carries the
                          post-gains room). It also carries the
                          plain-words scope note the user asked for. */}
                      <span style={{ color: "#65a30d" }}>
                        0% gains end {fmtDollars(zeroTop)} —{" "}
                        {zeroTop - ordinaryTaxable > 0.5
                          ? `${fmtDollars(zeroTop - ordinaryTaxable)} left`
                          : zeroTop - ordinaryTaxable >= -0.5
                            ? "filled exactly"
                            : `passed by ${fmtDollars(ordinaryTaxable - zeroTop)}`}{" "}
                        · only taxable-account gains and qualified dividends get the 0% rate
                      </span>
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
                    node: stackRow("Pre-tax money out", fmtDollars(pg.conversion)),
                    aca: pg.conversion,
                    irmaa: pg.conversion,
                  },
                  {
                    key: "gains",
                    node: stackRow(
                      "Long-term gains priced",
                      fmtDollars(pg.ltcgPriced),
                      `Sale gain ${fmtDollars(pg.stockGain)} + qualified dividends ${fmtDollars(pg.qualifiedDividends)}`,
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
                // The ACA section applies for these markers when
                // the result carries a cliff figure — set only
                // when a household size was entered and not
                // everyone in the household is on Medicare.
                const acaApplies = pg.aca.cliff != null;
                const acaHasCliff = acaApplies && pgYearNum >= 2026;
                const acaCrossed = acaHasCliff && pg.aca.overCliff;
                const acaCliff = pg.aca.cliff ?? 0;
                const irmaaLine =
                  pg.irmaa.applies && pg.irmaa.tier >= 1
                    ? irmaaTierUpTo(
                        pg.irmaa.tier - 1,
                        pgFiling,
                        lawForYear(pgYearNum),
                        pgYearNum,
                        0,
                      )
                    : null;
                let acaCum = 0;
                let irmaaCum = 0;
                let acaAfter = -1;
                let irmaaAfter = -1;
                additive.forEach((e, i) => {
                  acaCum += e.aca;
                  irmaaCum += e.irmaa;
                  if (acaCrossed && acaAfter === -1 && acaCum > acaCliff) acaAfter = i;
                  if (irmaaLine != null && irmaaAfter === -1 && irmaaCum > irmaaLine) irmaaAfter = i;
                });
                // A crossed line's marker always renders: if the
                // running totals never passed it mid-stack (only
                // possible on a sub-cent rounding seam), it lands
                // after the last additive row instead.
                if (acaCrossed && acaAfter === -1) acaAfter = additive.length - 1;
                if (irmaaLine != null && irmaaAfter === -1) irmaaAfter = additive.length - 1;
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
                      {additive.map((e, i) => (
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
                  </p>

                  <div className="mt-3">
                    <h3 className="text-sm font-semibold">Income stack</h3>
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
                      {fmtDollars(pg.aca.cliff)} (400% of the poverty line).{" "}
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
                  <h3 className="text-sm font-semibold">Tax for the year</h3>
                  <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
                    {stackRow("Federal tax on ordinary income", fmtDollars(pg.ordinaryTax))}
                    {stackRow(
                      "Federal tax on gains",
                      fmtDollars(pg.ltcgTax + pg.niit),
                      pg.niit > 0
                        ? `${fmtDollars(pg.ltcgTax)} gains tax + ${fmtDollars(pg.niit)} NIIT`
                        : undefined,
                    )}
                    {stackRow("Total federal tax", fmtDollars(pg.federalTax), undefined, true)}
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
                        "Alternative minimum tax (AMT)",
                        fmtDollars(pg.amtOwed),
                        `Tentative minimum tax ${fmtDollars(pg.amtTentativeTax)} on AMT income ${fmtDollars(pg.amti)} (exemption ${fmtDollars(pg.amtExemption)}) beat the regular tax — the difference is already inside the total federal tax.`,
                      )}
                    {pg.amtOwed === 0 && pg.amti > 0 &&
                      stackRow(
                        "Alternative minimum tax (AMT)",
                        "$0",
                        `Tentative minimum tax ${fmtDollars(pg.amtTentativeTax)} on AMT income ${fmtDollars(pg.amti)} (exemption ${fmtDollars(pg.amtExemption)}) did not beat the regular tax.`,
                      )}
                    {pg.stateTax > 0 &&
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
                  </dl>
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

                  <section className={sectionCls} aria-label="Bracket landing">
                  <h3 className="text-sm font-semibold">Bracket landing</h3>
                  {pg.conversion > 0 && pg.landingBracketPct != null ? (
                    <p className="mt-1 text-sm">
                      The last dollar of pre-tax money out lands in the{" "}
                      {pg.landingBracketPct}% bracket
                      {pg.landingBracketTop != null
                        ? ` (top ${fmtDollars(pg.landingBracketTop)})`
                        : " (the top bracket — no ceiling)"}
                      {pg.landingExactlyFilled
                        ? " — filled exactly, $0 of room left."
                        : pg.landingRoomLeft != null
                          ? ` — ${fmtDollars(pg.landingRoomLeft)} of room left in the bracket.`
                          : "."}
                    </p>
                  ) : pg.conversion > 0 ? (
                    <p className="mt-1 text-sm">
                      None of the pre-tax money out is taxed — the year&rsquo;s deductions
                      shelter all of it.
                    </p>
                  ) : (
                    <p className="mt-1 text-sm">
                      No pre-tax money out typed — type an amount above to see where it would
                      land.
                    </p>
                  )}
                  {pg.conversion > 0 && (
                    <p className="mt-1 text-sm">
                      The pre-tax money out itself costs{" "}
                      <strong className="tnum">{fmtDollars(pg.conversionFederalCost)}</strong>{" "}
                      of federal tax —{" "}
                      {((pg.conversionFederalCost / pg.conversion) * 100).toFixed(1)}%
                      of the amount taken out
                      {pg.conversionTotalCost !== pg.conversionFederalCost
                        ? ` (${fmtDollars(pg.conversionTotalCost)} with state tax included)`
                        : ""}
                      . That&rsquo;s the year&rsquo;s tax with the pre-tax money out minus
                      the same year priced at $0 of pre-tax money out.
                    </p>
                  )}
                  {pg.bracketLayers.length > 0 && (
                    <p className="mt-1 text-sm text-[var(--dim)]">
                      Ordinary income is taxed as:{" "}
                      {pg.bracketLayers
                        .map((l) => `${l.ratePct}% × ${fmtDollars(l.amount)}`)
                        .join(" + ")}
                      .
                    </p>
                  )}

                  </section>

                  <section className={sectionCls} aria-label="Gains stack">
                  <h3 className="text-sm font-semibold">Gains stack</h3>
                  <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
                    {stackRow("Taxed at 0%", fmtDollars(pg.gainsAt0))}
                    {stackRow("Taxed at 15%", fmtDollars(pg.gainsAt15))}
                    {stackRow("Taxed at 20%", fmtDollars(pg.gainsAt20))}
                    {stackRow(
                      "0% gains room left",
                      fmtDollars(pg.gainsZeroRoomLeft),
                    )}
                    {stackRow(
                      "Net investment income tax",
                      fmtDollars(pg.niit),
                      "Priced on interest, dividends and gains — the net investment income base",
                    )}
                  </dl>

                  </section>
                </div>
                </>
              );
            })()}
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
  acaHouseholdSizeAfter: number;
  acaStepDownYear: number | null;
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
  // yields, never these amounts.
  taxReturnInterest: number | null;
  taxReturnQualifiedDividends: number | null;
  taxReturnOrdinaryDividends: number | null;
  spouseSoleBeneficiary: boolean;
  // Projection defaults (projection build): the plan's
  // resolved expected return and its starting taxable / Roth
  // balances in dollars — the projection panel's blank dials
  // fall back to these, exactly as its other defaults fall
  // back to the plan (claiming ages, step-down) above.
  expectedReturnPct: number;
  taxableStart: number;
  rothStart: number;
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
    acaHouseholdSizeAfter: s
      ? (s.acaHouseholdSizeAfter ?? s.acaHouseholdSize ?? 1)
      : 2,
    acaStepDownYear: s ? s.acaStepDownYear : null,
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
    spouseSoleBeneficiary: s ? (s.spouseSoleBeneficiary ?? true) : true,
    expectedReturnPct: expRet,
    taxableStart:
      ((s ? s.taxableCents : null) ?? snap?.taxableCents ?? 0) / 100,
    rothStart: ((s ? s.rothCents : null) ?? snap?.rothCents ?? 0) / 100,
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
