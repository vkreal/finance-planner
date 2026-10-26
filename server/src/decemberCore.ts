import { z } from "@hatch/space-sdk";
import {
  pricePlaygroundYear,
  solvePlaygroundAcaCliffFill,
  type PlaygroundYearInputs,
} from "./rothOptimizer";
import type { FilingStatus } from "./taxEngine";

/* ---------------- December projection console ----------------
   A December year-end projection for a household managing MAGI
   against the ACA premium-credit cliff. In December the year's
   income is nearly final: the user enters year-to-date ACTUALS
   (already posted), the December stragglers as low / likely /
   high ranges, and a strays checklist, and the console answers
   ONE headline question — the maximum safe pre-tax draw for
   December, sized to land ACA MAGI at the cliff minus a safety
   buffer (default $5,000).

   NO TAX MATH IS FORKED HERE. Every figure is priced through
   the shipped single-year engine — pricePlaygroundYear, the
   exact function the Playground view and the runPlaygroundYear
   action price with — and the headline draw is solved by the
   shipped solvePlaygroundAcaCliffFill against that engine. A
   pre-tax distribution for spending is taxed identically to a
   conversion dollar-for-dollar in a single year, so the draw
   rides the engine's existing pre-tax-money-out (conversion)
   dial. This module only ASSEMBLES the year's income from the
   December pieces (actuals + a range case + stray amounts) into
   Playground dials, and reads the engine's own outputs back.

   Persistence: the console's inputs are one JSON blob in
   settings under DECEMBER_STATE_KEY, stored as form state in
   the same plaintext style as the Playground's remembered form
   (roth_ui_state_v1) — so the December session can be reopened
   and adjusted as finals post, and the blob rides the ordinary
   backup export / restore settings array with no extra cases.
   Nothing in this module reads or writes any other view's
   state, and a fresh (default) console prices nothing and
   changes no existing figure. */

export const DECEMBER_STATE_KEY = "december_projection_v1";

export type DecemberCaseKind = "low" | "likely" | "high";
export const DECEMBER_CASE_KINDS: DecemberCaseKind[] = ["low", "likely", "high"];

/* One stray-checklist item: "na" (does not apply / not present),
   "confirmed" (checked, no amount — e.g. the administrator's
   cutoff date), or "amount" (present, carrying a dollar amount
   that flows into the projection). Amount is dollars; it is
   read only when the status is "amount". */
export const decemberStray = z.object({
  status: z.enum(["na", "confirmed", "amount"]),
  amount: z.number().finite(),
});
export type DecemberStray = z.infer<typeof decemberStray>;

const strayDefault = (): DecemberStray => ({ status: "na", amount: 0 });

/* A low / likely / high range for one remaining-income line. */
export const decemberRange = z.object({
  low: z.number().finite(),
  likely: z.number().finite(),
  high: z.number().finite(),
});
export type DecemberRange = z.infer<typeof decemberRange>;
const rangeDefault = (): DecemberRange => ({ low: 0, likely: 0, high: 0 });

/* The console's saved inputs — all money in DOLLARS (the
   single-year engine's units), ages in whole years. Every field
   is required in the strict writer schema; the reader below is
   lenient field by field, so a blob written before a field
   existed (or a partial blob) reads at that field's default. */
export const decemberState = z.object({
  taxYear: z.number().int().min(2000).max(2100),
  filingStatus: z.enum(["mfj", "single", "hoh"]),
  agePrimary: z.number().int().min(0).max(120).nullable(),
  ageSpouse: z.number().int().min(0).max(120).nullable(),
  onMedicarePrimary: z.boolean(),
  onMedicareSpouse: z.boolean(),
  // Year-to-date ACTUAL income, already posted.
  ytdOtherOrdinary: z.number().finite(),
  ytdInterest: z.number().finite().min(0),
  ytdOrdinaryDividends: z.number().finite().min(0),
  ytdQualifiedDividends: z.number().finite().min(0),
  ytdTaxExemptInterest: z.number().finite().min(0),
  // Realized capital result so far — SIGNED (negative = a net
  // realized loss), like the engine's own stock gain.
  ytdCapitalGain: z.number().finite(),
  ytdSsPrimary: z.number().finite().min(0),
  ytdSsSpouse: z.number().finite().min(0),
  // Remaining expected income (December stragglers), per line.
  remCapDist: decemberRange,
  remInterest: decemberRange,
  remOrdinaryDividends: decemberRange,
  remQualifiedDividends: decemberRange,
  remOtherOrdinary: decemberRange,
  // ACA block.
  acaHouseholdSize: z.number().int().min(1).max(20).nullable(),
  acaBenchmarkAnnual: z.number().finite().min(0).nullable(),
  aptcTaken: z.number().finite().min(0),
  bufferDollars: z.number().finite().min(0),
  // Pricing context (the same dials the Playground carries).
  pretaxBalance: z.number().finite().min(0).nullable(),
  spouseSoleBeneficiary: z.boolean(),
  stateRatePct: z.number().finite().min(0).max(100),
  residenceState: z.enum(["WA", "other"]),
  itemizedMortgageInterest: z.number().finite().min(0),
  itemizedSaltPaid: z.number().finite().min(0),
  itemizedCharitable: z.number().finite().min(0),
  itemizedOther: z.number().finite().min(0),
  // Strays checklist (household-neutral wording in the view).
  strayCapDist: decemberStray,
  strayK1: decemberStray,
  strayTaxExempt: decemberStray,
  strayDependent: decemberStray,
  straySeverance: decemberStray,
  strayLossHarvest: decemberStray,
  strayCutoff: decemberStray,
  // Settled adversarial-review additions (2026-10-26): every
  // field below is read leniently like the original seven, so
  // a blob saved before they existed reads them at the inert
  // default and rides the same backup / restore settings blob.
  strayJanPaid: decemberStray,
  strayDivInt: decemberStray,
  strayPlannedSales: decemberStray,
  strayROC: decemberStray,
  strayAgiReducers: decemberStray,
  strayCoverage: decemberStray,
  strayTradeDate: decemberStray,
});
export type DecemberState = z.infer<typeof decemberState>;

export function defaultDecemberState(currentYear: number): DecemberState {
  return {
    taxYear: currentYear,
    filingStatus: "mfj",
    agePrimary: null,
    ageSpouse: null,
    onMedicarePrimary: false,
    onMedicareSpouse: false,
    ytdOtherOrdinary: 0,
    ytdInterest: 0,
    ytdOrdinaryDividends: 0,
    ytdQualifiedDividends: 0,
    ytdTaxExemptInterest: 0,
    ytdCapitalGain: 0,
    ytdSsPrimary: 0,
    ytdSsSpouse: 0,
    remCapDist: rangeDefault(),
    remInterest: rangeDefault(),
    remOrdinaryDividends: rangeDefault(),
    remQualifiedDividends: rangeDefault(),
    remOtherOrdinary: rangeDefault(),
    acaHouseholdSize: null,
    acaBenchmarkAnnual: null,
    aptcTaken: 0,
    bufferDollars: 5000,
    pretaxBalance: null,
    spouseSoleBeneficiary: true,
    stateRatePct: 0,
    residenceState: "other",
    itemizedMortgageInterest: 0,
    itemizedSaltPaid: 0,
    itemizedCharitable: 0,
    itemizedOther: 0,
    strayCapDist: strayDefault(),
    strayK1: strayDefault(),
    strayTaxExempt: strayDefault(),
    strayDependent: strayDefault(),
    straySeverance: strayDefault(),
    strayLossHarvest: strayDefault(),
    strayCutoff: strayDefault(),
    strayJanPaid: strayDefault(),
    strayDivInt: strayDefault(),
    strayPlannedSales: strayDefault(),
    strayROC: strayDefault(),
    strayAgiReducers: strayDefault(),
    strayCoverage: strayDefault(),
    strayTradeDate: strayDefault(),
  };
}

/* Lenient read, field by field, in the Roth UI-state reader's
   style: any field of the wrong type or out of range falls back
   to its default, so a partial or malformed blob can never
   break the console — it just opens closer to blank. */
export function parseDecemberState(
  raw: string | undefined,
  currentYear: number,
): DecemberState {
  const out = defaultDecemberState(currentYear);
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  const p = parsed as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const nonNeg = (key: string, set: (n: number) => void) => {
    const n = num(p[key]);
    if (n != null && n >= 0) set(n);
  };
  const signed = (key: string, set: (n: number) => void) => {
    const n = num(p[key]);
    if (n != null) set(n);
  };
  const ageOrNull = (key: string, set: (n: number | null) => void) => {
    if (p[key] === null) return; // the default is already null
    const n = num(p[key]);
    if (n != null && Number.isInteger(n) && n >= 0 && n <= 120) set(n);
  };
  const range = (key: string, set: (r: DecemberRange) => void) => {
    const v = p[key];
    if (v == null || typeof v !== "object" || Array.isArray(v)) return;
    const r = v as Record<string, unknown>;
    const low = num(r.low);
    const likely = num(r.likely);
    const high = num(r.high);
    if (low != null && likely != null && high != null) set({ low, likely, high });
  };
  const stray = (key: string, set: (s: DecemberStray) => void) => {
    const v = p[key];
    if (v == null || typeof v !== "object" || Array.isArray(v)) return;
    const s = v as Record<string, unknown>;
    if (s.status !== "na" && s.status !== "confirmed" && s.status !== "amount") return;
    const amount = num(s.amount);
    set({ status: s.status, amount: amount ?? 0 });
  };
  const ty = num(p.taxYear);
  if (ty != null && Number.isInteger(ty) && ty >= 2000 && ty <= 2100) out.taxYear = ty;
  if (p.filingStatus === "mfj" || p.filingStatus === "single" || p.filingStatus === "hoh") {
    out.filingStatus = p.filingStatus;
  }
  ageOrNull("agePrimary", (n) => (out.agePrimary = n));
  ageOrNull("ageSpouse", (n) => (out.ageSpouse = n));
  if (typeof p.onMedicarePrimary === "boolean") out.onMedicarePrimary = p.onMedicarePrimary;
  if (typeof p.onMedicareSpouse === "boolean") out.onMedicareSpouse = p.onMedicareSpouse;
  signed("ytdOtherOrdinary", (n) => (out.ytdOtherOrdinary = n));
  nonNeg("ytdInterest", (n) => (out.ytdInterest = n));
  nonNeg("ytdOrdinaryDividends", (n) => (out.ytdOrdinaryDividends = n));
  nonNeg("ytdQualifiedDividends", (n) => (out.ytdQualifiedDividends = n));
  nonNeg("ytdTaxExemptInterest", (n) => (out.ytdTaxExemptInterest = n));
  signed("ytdCapitalGain", (n) => (out.ytdCapitalGain = n));
  nonNeg("ytdSsPrimary", (n) => (out.ytdSsPrimary = n));
  nonNeg("ytdSsSpouse", (n) => (out.ytdSsSpouse = n));
  range("remCapDist", (r) => (out.remCapDist = r));
  range("remInterest", (r) => (out.remInterest = r));
  range("remOrdinaryDividends", (r) => (out.remOrdinaryDividends = r));
  range("remQualifiedDividends", (r) => (out.remQualifiedDividends = r));
  range("remOtherOrdinary", (r) => (out.remOtherOrdinary = r));
  if (p.acaHouseholdSize === null) {
    out.acaHouseholdSize = null;
  } else {
    const n = num(p.acaHouseholdSize);
    if (n != null && Number.isInteger(n) && n >= 1 && n <= 20) out.acaHouseholdSize = n;
  }
  if (p.acaBenchmarkAnnual === null) {
    out.acaBenchmarkAnnual = null;
  } else {
    nonNeg("acaBenchmarkAnnual", (n) => (out.acaBenchmarkAnnual = n));
  }
  nonNeg("aptcTaken", (n) => (out.aptcTaken = n));
  nonNeg("bufferDollars", (n) => (out.bufferDollars = n));
  if (p.pretaxBalance === null) {
    out.pretaxBalance = null;
  } else {
    nonNeg("pretaxBalance", (n) => (out.pretaxBalance = n));
  }
  if (typeof p.spouseSoleBeneficiary === "boolean") {
    out.spouseSoleBeneficiary = p.spouseSoleBeneficiary;
  }
  const sr = num(p.stateRatePct);
  if (sr != null && sr >= 0 && sr <= 100) out.stateRatePct = sr;
  if (p.residenceState === "WA" || p.residenceState === "other") {
    out.residenceState = p.residenceState;
  }
  nonNeg("itemizedMortgageInterest", (n) => (out.itemizedMortgageInterest = n));
  nonNeg("itemizedSaltPaid", (n) => (out.itemizedSaltPaid = n));
  nonNeg("itemizedCharitable", (n) => (out.itemizedCharitable = n));
  nonNeg("itemizedOther", (n) => (out.itemizedOther = n));
  stray("strayCapDist", (s) => (out.strayCapDist = s));
  stray("strayK1", (s) => (out.strayK1 = s));
  stray("strayTaxExempt", (s) => (out.strayTaxExempt = s));
  stray("strayDependent", (s) => (out.strayDependent = s));
  stray("straySeverance", (s) => (out.straySeverance = s));
  stray("strayLossHarvest", (s) => (out.strayLossHarvest = s));
  stray("strayCutoff", (s) => (out.strayCutoff = s));
  stray("strayJanPaid", (s) => (out.strayJanPaid = s));
  stray("strayDivInt", (s) => (out.strayDivInt = s));
  stray("strayPlannedSales", (s) => (out.strayPlannedSales = s));
  stray("strayROC", (s) => (out.strayROC = s));
  stray("strayAgiReducers", (s) => (out.strayAgiReducers = s));
  stray("strayCoverage", (s) => (out.strayCoverage = s));
  stray("strayTradeDate", (s) => (out.strayTradeDate = s));
  return out;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

const strayAmount = (s: DecemberStray): number =>
  s.status === "amount" ? Math.max(0, s.amount) : 0;

/* Assemble ONE case's single-year engine dials at a given
   pre-tax draw. The year's income is: year-to-date actuals +
   this case's remaining-income ranges + the stray amounts
   (which apply in every case — they are amounts the household
   has identified, on top of the ranges). The capital result
   (actuals + expected distributions + the capital-gain stray,
   plus forecast gains on planned sales and any return of
   capital that is income — over basis or reclassified — less
   any harvested loss) rides the engine's stock-sale dials:
   a net gain is sold $gain with $0 basis; a net loss is sold
   $0 with basis $loss, so the engine prices the loss (and its
   §1211(b) allowance) exactly as it prices a Playground sale.
   The settled-review additions flow the same way: a fund
   dividend declared in October–December and paid in January
   is deemed received December 31 (§852(b)(7)), so it rides
   the dividends total; money-market dividends from a cash
   sleeve and savings-bond interest ride interest; and the
   AGI reducers that actually work (deductible HSA
   contributions, pre-tax deferrals not already reflected in
   the wages above) subtract from other ordinary income — an
   assembly of the engine's existing dials, never new tax
   math. The coverage-month stray carries NO income: it
   reduces the case's final allowable credit instead (see
   computeDecemberProjection), because eligibility is monthly. */
export function decemberCaseInputs(
  state: DecemberState,
  kind: DecemberCaseKind,
  draw: number,
): PlaygroundYearInputs {
  const joint = state.filingStatus === "mfj";
  const totalGain = r2(
    state.ytdCapitalGain +
      state.remCapDist[kind] +
      strayAmount(state.strayCapDist) +
      strayAmount(state.strayPlannedSales) +
      strayAmount(state.strayROC) -
      strayAmount(state.strayLossHarvest),
  );
  const otherOrdinary = r2(
    state.ytdOtherOrdinary +
      state.remOtherOrdinary[kind] +
      strayAmount(state.strayK1) +
      strayAmount(state.straySeverance) +
      strayAmount(state.strayDependent) -
      strayAmount(state.strayAgiReducers),
  );
  return {
    taxYear: state.taxYear,
    filingStatus: state.filingStatus as FilingStatus,
    agePrimary: state.agePrimary ?? 0,
    ageSpouse: joint ? state.ageSpouse : null,
    onMedicarePrimary: state.onMedicarePrimary,
    onMedicareSpouse: joint ? state.onMedicareSpouse : false,
    interest: r2(
      state.ytdInterest + state.remInterest[kind] + strayAmount(state.strayDivInt),
    ),
    ordinaryDividends: r2(
      state.ytdOrdinaryDividends +
        state.remOrdinaryDividends[kind] +
        strayAmount(state.strayJanPaid),
    ),
    otherOrdinary,
    taxExemptInterest: r2(state.ytdTaxExemptInterest + strayAmount(state.strayTaxExempt)),
    ssPrimary: state.ytdSsPrimary,
    ssSpouse: joint ? state.ytdSsSpouse : 0,
    conversion: Math.max(0, draw),
    stockSold: totalGain > 0 ? totalGain : 0,
    stockBasis: totalGain < 0 ? -totalGain : 0,
    qualifiedDividends: r2(state.ytdQualifiedDividends + state.remQualifiedDividends[kind]),
    pretaxBalance: state.pretaxBalance,
    spouseSoleBeneficiary: state.spouseSoleBeneficiary,
    acaHouseholdSize: state.acaHouseholdSize,
    acaBenchmarkAnnual: state.acaBenchmarkAnnual,
    stateRatePct: state.stateRatePct,
    residenceState: state.residenceState,
    itemizedMortgageInterest: state.itemizedMortgageInterest,
    itemizedSaltPaid: state.itemizedSaltPaid,
    itemizedCharitable: state.itemizedCharitable,
    itemizedOther: state.itemizedOther,
    educationStudents: null,
  };
}

export type DecemberCaseResult = {
  kind: DecemberCaseKind;
  // ACA MAGI at a $0 draw — the year's non-draw income alone.
  nonDrawAcaMagi: number;
  // This case's own maximum safe draw at cliff − buffer
  // (null when the year has no hard ACA cliff to aim at).
  maxDraw: number | null;
  // The case priced AT the headline (likely-case) draw.
  magiAtHeadline: number;
  // cliff − magiAtHeadline: positive = under the cliff by that
  // much, negative = over it. Null when there is no cliff.
  distanceAtHeadline: number | null;
  overCliffAtHeadline: boolean;
  // True when even a $0 draw is over the cliff — non-draw
  // income alone ends the year above 400% FPL (eligibility is
  // lost above 400%; exactly 400% remains eligible).
  overCliffEvenAtZero: boolean;
  // The final allowable ACA credit at the headline draw: the
  // engine-priced credit less any coverage-month reduction
  // entered on the strays checklist (null when no benchmark
  // premium was entered and the case is not over the cliff —
  // over the cliff the allowable credit is $0 by law).
  creditAtHeadline: number | null;
  // Excess-APTC repayment at the headline draw, for tax years
  // after 2025: there are NO repayment caps (P.L. 119-21
  // §71305), so ANY advance credit taken above the final
  // allowable credit is repaid in full — even when MAGI lands
  // UNDER the cliff. max(0, APTC taken − final credit); the
  // over-the-cliff case is the same formula at a $0 final
  // credit, i.e. the whole APTC taken. Null when the final
  // credit is not priced (no benchmark entered, case under
  // the cliff) or the tax year is 2025 or earlier, whose
  // capped-repayment rules this console does not price.
  excessAptcRepayment: number | null;
  // The other side of the same reconciliation: when the APTC
  // taken is BELOW the final allowable credit, this further
  // credit is still due at filing. max(0, final credit − APTC
  // taken); null under the same conditions as
  // excessAptcRepayment.
  creditStillDue: number | null;
  // The headline repayment figure: excessAptcRepayment when
  // it is priced, else $0. Kept as the always-a-number field
  // the case cards lead with.
  repaymentExposure: number;
  federalTaxAtHeadline: number;
  totalTaxAtHeadline: number;
};

export type DecemberProjectionResult = {
  priced: boolean;
  reason: string | null;
  cliff: number | null;
  // cliff − buffer: the MAGI line the headline draw aims at.
  targetMagi: number | null;
  headlineDraw: number | null;
  headlineText: string;
  zeroDrawOverCliff: boolean;
  cases: DecemberCaseResult[];
  warnings: string[];
};

const UNPRICED: DecemberProjectionResult = {
  priced: false,
  reason: null,
  cliff: null,
  targetMagi: null,
  headlineDraw: null,
  headlineText: "",
  zeroDrawOverCliff: false,
  cases: [],
  warnings: [],
};

/* Price the December projection. Pure: same inputs, same
   result, no state read or written. */
export function computeDecemberProjection(
  state: DecemberState,
): DecemberProjectionResult {
  if (state.agePrimary == null || state.agePrimary <= 0) {
    return {
      ...UNPRICED,
      reason:
        "Enter the primary filer's age for the tax year — the year cannot be priced without it.",
      headlineText: "Enter an age to price the year.",
    };
  }
  const warnings: string[] = [];
  const rangeLines: [string, DecemberRange][] = [
    ["Capital-gain distributions", state.remCapDist],
    ["Interest still to come", state.remInterest],
    ["Ordinary dividends still to come", state.remOrdinaryDividends],
    ["Qualified dividends still to come", state.remQualifiedDividends],
    ["Other income still to come", state.remOtherOrdinary],
  ];
  for (const [label, r] of rangeLines) {
    if (!(r.low <= r.likely && r.likely <= r.high)) {
      warnings.push(
        `${label}: the low / likely / high amounts are out of order — the cases below price them exactly as entered.`,
      );
    }
  }
  // Zero-draw pricings first: they carry the cliff and each
  // case's non-draw MAGI.
  const zeroInputs = DECEMBER_CASE_KINDS.map((k) => decemberCaseInputs(state, k, 0));
  const zeroResults = zeroInputs.map((inp) => pricePlaygroundYear(inp));
  const likelyZero = zeroResults[1]!;
  const cliff = likelyZero.aca.cliff;
  const targetMagi = cliff == null ? null : r2(cliff - state.bufferDollars);

  // The headline: the likely case's maximum safe draw at
  // cliff − buffer, solved against the engine.
  const headlineDraw =
    cliff == null
      ? null
      : solvePlaygroundAcaCliffFill(zeroInputs[1]!, state.bufferDollars);
  const drawForPricing = headlineDraw ?? 0;

  const coverageReduction = strayAmount(state.strayCoverage);
  const cases: DecemberCaseResult[] = DECEMBER_CASE_KINDS.map((kind, i) => {
    const zero = zeroResults[i]!;
    const atHeadline = pricePlaygroundYear(
      decemberCaseInputs(state, kind, drawForPricing),
    );
    const overAtHeadline = cliff != null && atHeadline.aca.overCliff;
    // The final allowable credit: the engine's credit less
    // any coverage-month reduction (a member ineligible in a
    // month shrinks that month's credit whatever the annual
    // MAGI says). Over the cliff the allowable credit is $0
    // by law, benchmark entered or not.
    const finalCredit: number | null = overAtHeadline
      ? 0
      : atHeadline.aca.credit == null
        ? null
        : r2(Math.max(0, atHeadline.aca.credit - coverageReduction));
    // Post-2025 reconciliation (P.L. 119-21 §71305): no
    // repayment caps — every excess APTC dollar is repaid,
    // under the cliff as well as over it.
    const excessAptcRepayment: number | null =
      state.taxYear >= 2026 && finalCredit != null
        ? r2(Math.max(0, state.aptcTaken - finalCredit))
        : null;
    const creditStillDue: number | null =
      state.taxYear >= 2026 && finalCredit != null
        ? r2(Math.max(0, finalCredit - state.aptcTaken))
        : null;
    return {
      kind,
      nonDrawAcaMagi: zero.acaMagi,
      maxDraw:
        cliff == null
          ? null
          : solvePlaygroundAcaCliffFill(zeroInputs[i]!, state.bufferDollars),
      magiAtHeadline: atHeadline.acaMagi,
      distanceAtHeadline:
        cliff == null ? null : r2(cliff - atHeadline.acaMagi),
      overCliffAtHeadline: overAtHeadline,
      overCliffEvenAtZero: cliff != null && zero.aca.overCliff,
      creditAtHeadline: finalCredit,
      excessAptcRepayment,
      creditStillDue,
      repaymentExposure: excessAptcRepayment ?? 0,
      federalTaxAtHeadline: atHeadline.federalTax,
      totalTaxAtHeadline: atHeadline.totalTax,
    };
  });

  const likelyCase = cases[1]!;
  const zeroDrawOverCliff = likelyCase.overCliffEvenAtZero;

  let headlineText: string;
  if (cliff == null) {
    headlineText = !likelyZero.aca.applies
      ? "No ACA cliff applies this year — everyone in the household is on Medicare, so there is no premium credit to protect and no cliff-sized draw to compute."
      : state.taxYear < 2026
        ? "This tax year has no ACA cliff — the enhanced-credit years price no 400%-of-poverty-line cutoff, so there is no cliff-sized draw to compute."
        : "No ACA cliff to aim at — enter the ACA household size for the year to size the December draw.";
  } else if (zeroDrawOverCliff) {
    headlineText = `No December draw is safe this year: income already posted puts MAGI at ${fmt(likelyCase.nonDrawAcaMagi)}, over the ${fmt(cliff)} cliff before any draw — no draw can fix that year. The credit is lost in the likely case and the advance credit taken (${fmt(state.aptcTaken)}) is repaid.`;
  } else if (headlineDraw != null && headlineDraw <= 0) {
    headlineText = `Take no December draw: income already posted leaves no room under the cliff minus your ${fmt(state.bufferDollars)} buffer.`;
  } else {
    headlineText = `Maximum safe December draw: ${fmt(headlineDraw ?? 0)} — it lands MAGI at ${fmt(likelyCase.magiAtHeadline)}, ${fmt(Math.abs(likelyCase.distanceAtHeadline ?? 0))} under the ${fmt(cliff)} cliff in the likely case, keeping the credit.`;
  }

  if (state.aptcTaken <= 0 && cliff != null) {
    warnings.push(
      "No advance premium credit (APTC) taken was entered — with none taken there is nothing to repay, but a year ending above the cliff still loses the credit itself, and a year under it repays any advance credit taken above the final credit in full (no repayment caps after 2025).",
    );
  }
  if (state.strayCutoff.status === "na" || state.strayTradeDate.status === "na") {
    warnings.push(
      "The year-end execution clocks are not both confirmed — brokerage sales count by trade date, while a plan distribution counts in the year it is paid (actually or constructively received), not the year it is requested; get the administrator's payment date and December cutoff in writing.",
    );
  }
  return {
    priced: true,
    reason: null,
    cliff,
    targetMagi,
    headlineDraw,
    headlineText,
    zeroDrawOverCliff,
    cases,
    warnings,
  };
}

function fmt(dollars: number): string {
  const neg = dollars < 0;
  const abs = Math.abs(Math.round(dollars));
  return `${neg ? "−" : ""}$${abs.toLocaleString("en-US")}`;
}

/* ---------------- Accuracy fixtures ----------------
   Pinned cases for the December surface, in the shared fixture
   shape the accuracy self-check returns. Every expected figure
   is derived from the engine's own published law data (the
   2026-coverage cliff for a household of 2 is 400% of the 2025
   guideline $21,150 = $84,600) and the assembly rules above —
   never from a second implementation of the tax math. */
export function runDecemberFixtures(): {
  total: number;
  passed: number;
  results: { id: string; kind: string; pass: boolean; failures: string[] }[];
} {
  const results: { id: string; kind: string; pass: boolean; failures: string[] }[] = [];
  const run = (
    id: string,
    fn: (fail: (msg: string) => void) => void,
  ) => {
    const failures: string[] = [];
    try {
      fn((m) => failures.push(m));
    } catch (e) {
      failures.push(e instanceof Error ? e.message : String(e));
    }
    results.push({ id, kind: "december", pass: failures.length === 0, failures });
  };
  const near = (fail: (m: string) => void, label: string, got: number | null, want: number) => {
    if (got == null || Math.abs(got - want) > 0.02) {
      fail(`${label}: got ${got}, want ${want}`);
    }
  };
  const base = (): DecemberState => ({
    ...defaultDecemberState(2026),
    agePrimary: 60,
    ageSpouse: 58,
    acaHouseholdSize: 2,
    acaBenchmarkAnnual: 20000,
    aptcTaken: 12000,
  });

  run("dec-headline-cliff-minus-buffer", (fail) => {
    const s = base();
    s.ytdOtherOrdinary = 50000;
    const r = computeDecemberProjection(s);
    if (!r.priced) return fail("not priced");
    near(fail, "cliff", r.cliff, 84600);
    near(fail, "target", r.targetMagi, 79600);
    near(fail, "headline", r.headlineDraw, 29600);
    const likely = r.cases[1]!;
    near(fail, "likely magi at headline", likely.magiAtHeadline, 79600);
    if (likely.overCliffAtHeadline) fail("likely case should keep the credit");
    if (likely.repaymentExposure !== 0) fail("kept case should have $0 exposure");
    // The final credit at MAGI $79,600 is the $20,000
    // benchmark less 9.96% of MAGI ($7,928.16) = $12,071.84;
    // the $12,000 APTC taken sits below it, so the excess
    // repayment is $0 and $71.84 of credit is still due.
    near(fail, "final credit at headline", likely.creditAtHeadline, 12071.84);
    near(fail, "excess repayment at headline", likely.excessAptcRepayment, 0);
    near(fail, "credit still due at headline", likely.creditStillDue, 71.84);
  });

  run("dec-repayment-under-cliff-excess-aptc", (fail) => {
    // Settled review (P.L. 119-21 §71305): after 2025 there
    // are no repayment caps, so an under-cliff year whose APTC
    // taken exceeds the final allowable credit repays the
    // difference in full. Same landing as the headline
    // fixture (final credit $12,071.84) with $15,000 taken.
    const s = base();
    s.ytdOtherOrdinary = 50000;
    s.aptcTaken = 15000;
    const r = computeDecemberProjection(s);
    const likely = r.cases[1]!;
    if (likely.overCliffAtHeadline) fail("case should be under the cliff");
    near(fail, "final credit", likely.creditAtHeadline, 12071.84);
    near(fail, "excess repayment", likely.excessAptcRepayment, 2928.16);
    near(fail, "repayment exposure", likely.repaymentExposure, 2928.16);
    near(fail, "credit still due", likely.creditStillDue, 0);
  });

  run("dec-repayment-under-cliff-aptc-below-credit", (fail) => {
    // The other side: APTC taken below the final credit —
    // $0 repayment, and the shortfall is still due at filing.
    const s = base();
    s.ytdOtherOrdinary = 50000;
    s.aptcTaken = 10000;
    const r = computeDecemberProjection(s);
    const likely = r.cases[1]!;
    if (likely.overCliffAtHeadline) fail("case should be under the cliff");
    near(fail, "excess repayment", likely.excessAptcRepayment, 0);
    near(fail, "repayment exposure", likely.repaymentExposure, 0);
    near(fail, "credit still due", likely.creditStillDue, 2071.84);
  });

  run("dec-zero-draw-over-cliff", (fail) => {
    const s = base();
    s.ytdOtherOrdinary = 100000;
    const r = computeDecemberProjection(s);
    if (r.headlineDraw !== 0) fail(`headline should be 0, got ${r.headlineDraw}`);
    if (!r.zeroDrawOverCliff) fail("zeroDrawOverCliff should be true");
    const likely = r.cases[1]!;
    if (!likely.overCliffEvenAtZero) fail("likely overCliffEvenAtZero should be true");
    near(fail, "repayment", likely.repaymentExposure, 12000);
  });

  run("dec-ranges-move-the-draw", (fail) => {
    const s = base();
    s.ytdOtherOrdinary = 50000;
    s.remCapDist = { low: 0, likely: 5000, high: 10000 };
    const r = computeDecemberProjection(s);
    const [low, likely, high] = r.cases as [
      DecemberCaseResult,
      DecemberCaseResult,
      DecemberCaseResult,
    ];
    near(fail, "low non-draw MAGI", low.nonDrawAcaMagi, 50000);
    near(fail, "likely non-draw MAGI", likely.nonDrawAcaMagi, 55000);
    near(fail, "high non-draw MAGI", high.nonDrawAcaMagi, 60000);
    near(fail, "low max draw", low.maxDraw, 29600);
    near(fail, "likely max draw", likely.maxDraw, 24600);
    near(fail, "high max draw", high.maxDraw, 19600);
    // At the headline (likely) draw, the high case lands over
    // the buffer line but still under the cliff.
    near(fail, "high magi at headline", high.magiAtHeadline, 84600 - 5000 + 5000);
    if (high.overCliffAtHeadline) fail("high case at headline should still be under the cliff");
  });

  run("dec-no-cliff-on-medicare", (fail) => {
    const s = base();
    s.onMedicarePrimary = true;
    s.onMedicareSpouse = true;
    s.ytdOtherOrdinary = 50000;
    const r = computeDecemberProjection(s);
    if (r.cliff !== null) fail("cliff should be null when everyone is on Medicare");
    if (r.headlineDraw !== null) fail("headline should be null with no cliff");
  });

  run("dec-strays-flow-into-magi", (fail) => {
    const plain = base();
    plain.ytdOtherOrdinary = 40000;
    const withStray = base();
    withStray.ytdOtherOrdinary = 40000;
    withStray.strayK1 = { status: "amount", amount: 10000 };
    withStray.strayTaxExempt = { status: "amount", amount: 2000 };
    const a = computeDecemberProjection(plain).cases[1]!;
    const b = computeDecemberProjection(withStray).cases[1]!;
    near(fail, "MAGI lift from strays", b.nonDrawAcaMagi - a.nonDrawAcaMagi, 12000);
    const na = base();
    na.ytdOtherOrdinary = 40000;
    na.strayK1 = { status: "na", amount: 10000 };
    const c = computeDecemberProjection(na).cases[1]!;
    near(fail, "N/A stray is inert", c.nonDrawAcaMagi - a.nonDrawAcaMagi, 0);
  });

  run("dec-settled-strays-flow-into-magi", (fail) => {
    // The settled-review additions flow into the projection
    // like the original strays: planned-sale gains +$5,000 and
    // return-of-capital income +$1,000 ride the capital
    // result, a January-paid fund dividend +$3,000 rides
    // dividends, cash-sleeve / savings-bond income +$2,000
    // rides interest, and AGI reducers −$4,000 subtract from
    // ordinary income — a net MAGI lift of $7,000.
    const plain = base();
    plain.ytdOtherOrdinary = 40000;
    const withStrays = base();
    withStrays.ytdOtherOrdinary = 40000;
    withStrays.strayPlannedSales = { status: "amount", amount: 5000 };
    withStrays.strayROC = { status: "amount", amount: 1000 };
    withStrays.strayJanPaid = { status: "amount", amount: 3000 };
    withStrays.strayDivInt = { status: "amount", amount: 2000 };
    withStrays.strayAgiReducers = { status: "amount", amount: 4000 };
    const a = computeDecemberProjection(plain).cases[1]!;
    const b = computeDecemberProjection(withStrays).cases[1]!;
    near(fail, "MAGI lift from settled strays", b.nonDrawAcaMagi - a.nonDrawAcaMagi, 7000);
    // Coverage months: a $2,000 credit reduction for
    // ineligible months shrinks the final credit dollar for
    // dollar and raises the excess-APTC repayment by the
    // same $2,000, without moving MAGI at all.
    const withCoverage = base();
    withCoverage.ytdOtherOrdinary = 40000;
    withCoverage.strayCoverage = { status: "amount", amount: 2000 };
    const c = computeDecemberProjection(withCoverage).cases[1]!;
    near(fail, "coverage leaves MAGI alone", c.nonDrawAcaMagi - a.nonDrawAcaMagi, 0);
    near(fail, "final credit after coverage", c.creditAtHeadline, 10071.84);
    near(fail, "excess after coverage", c.excessAptcRepayment, 1928.16);
    // The new fields ride the saved blob: a stored blob
    // carrying them parses back intact, and a blob written
    // before they existed reads them at the inert default.
    const stored = parseDecemberState(
      JSON.stringify({ strayJanPaid: { status: "amount", amount: 750 } }),
      2026,
    );
    if (stored.strayJanPaid.status !== "amount" || stored.strayJanPaid.amount !== 750) {
      fail("a stored January-paid stray should parse back intact");
    }
    const legacy = parseDecemberState(JSON.stringify({ taxYear: 2026 }), 2026);
    if (legacy.strayCoverage.status !== "na" || legacy.strayTradeDate.status !== "na") {
      fail("new strays should default to N/A on a legacy blob");
    }
  });

  run("dec-buffer-moves-headline-dollar-for-dollar", (fail) => {
    const a = base();
    a.ytdOtherOrdinary = 50000;
    a.bufferDollars = 0;
    const b = base();
    b.ytdOtherOrdinary = 50000;
    b.bufferDollars = 5000;
    const ra = computeDecemberProjection(a);
    const rb = computeDecemberProjection(b);
    near(
      fail,
      "buffer delta",
      (ra.headlineDraw ?? -1) - (rb.headlineDraw ?? -1),
      5000,
    );
  });

  run("dec-default-state-is-inert", (fail) => {
    const d = defaultDecemberState(2026);
    const r = computeDecemberProjection(d);
    if (r.priced) fail("the untouched default state must not price a year");
    const parsed = parseDecemberState(undefined, 2026);
    if (parsed.bufferDollars !== 5000) fail("default buffer should be $5,000");
    if (parsed.taxYear !== 2026) fail("default tax year should be the current year");
    // The engine itself is untouched by this surface: a plain
    // Playground pricing of the same dials still prices.
    const pg = pricePlaygroundYear(decemberCaseInputs(base(), "likely", 0));
    near(fail, "engine ACA MAGI passthrough", pg.acaMagi, 0);
  });

  return {
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    results,
  };
}
