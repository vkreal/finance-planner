// Roth Conversion tax engine — the single implementation shared by
// the Roth Conversion view (client, via "@space/server/*") and the
// server-side accuracy fixtures (server/src/taxFixtures.ts), so the
// numbers the fixtures pin are computed by the exact code the user
// sees. Pure functions only: no React, no DOM, no server APIs.
//
// All money is in DOLLARS (the law table's units). The view stores
// its inputs in cents like the Retirement calc and converts at the
// boundary.
//
// Year loop order (per the design): RMD from the prior Dec 31
// pre-tax balance → conversion (the fill decision) → Social
// Security taxable amount by the IRC §86 provisional-income
// formula → taxable income after the standard deduction, age-65+
// add-ons and the OBBBA senior deduction → federal tax with
// long-term gains stacked on top of ordinary income → NIIT →
// IRMAA tier from MAGI (the surcharge PAID in a year is set by
// MAGI two years earlier) → ACA premium credit for marketplace
// years → balances grown at the plan's blended real return, with
// spending drawn RMD-cash first, then from the three buckets in
// the plan's draw order, and taxes + IRMAA paid from Taxable by default (protected
// to the protect-minimum) or withheld from the conversion.
//
// Today's-dollars convention: indexed law figures come from the
// newest law row and stay constant in real terms; NON-indexed
// figures (Social Security thresholds, NIIT thresholds, the top
// IRMAA tier floor through 2028, the OBBBA senior-deduction
// amount and phase-out start) deflate at the inflation input.

import {
CURRENT_LAW,
SENIOR_DEDUCTION,
SS_THRESHOLDS,
acaTableFor,
fplFor,
jointDivisor,
lawForYear,
rmdAgeForBirthYear,
uniformDivisor,
type FilingStatus,
type YearLaw,
} from "./taxLaw";

export type { FilingStatus };

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* ---------------- Social Security (IRC §86) ---------------- */

export function ssTaxableAmount(
  benefits: number,
  provisionalIncome: number,
  filingStatus: FilingStatus,
  deflationFactor: number,
): number {
  if (benefits <= 0) return 0;
  const t = SS_THRESHOLDS[filingStatus];
  const t1 = t.first * deflationFactor;
  const t2 = t.second * deflationFactor;
  if (provisionalIncome <= t1) return 0;
  if (provisionalIncome <= t2) {
    return Math.min(0.5 * benefits, 0.5 * (provisionalIncome - t1));
  }
  const base = Math.min(0.5 * benefits, 0.5 * (t2 - t1));
  return Math.min(0.85 * benefits, base + 0.85 * (provisionalIncome - t2));
}

/* ---------------- One year's federal pricing ---------------- */

export type PriceYearInput = {
  // Calendar year being priced (selects the law row for years
  // with a published row; later years price under CURRENT_LAW).
  calendarYear: number;
  filingStatus: FilingStatus;
  agePrimary: number;
  ageSpouse: number | null;
  otherOrdinary: number;
  rmd: number;
  conversion: number;
  extraPreTaxDraw: number;
  ssBenefits: number;
  taxExemptInterest: number;
  ltcg: number;
  // Taxable yield income (TAXABLE YIELDS build; both optional —
  // absent / 0 = the pre-yield pricing, bit-identical):
  // · interestIncome: taxable interest for the year. It joins
  //   the ORDINARY stack (taxed at ordinary rates, first in the
  //   stack order the plan engine settles — it is part of the
  //   fill base, so fills and draws shrink around it), counts
  //   in AGI / MAGI / ACA MAGI and in the §86 provisional
  //   income, and is NOT in the NIIT base — the existing engine
  //   tests NIIT against the gains stack only, and expanding
  //   the base to interest is a separate, parked decision.
  // · qualifiedDividends: qualified dividends for the year.
  //   They ride the GAINS stack exactly as ltcg does — the
  //   same 0% / 15% / 20% staircase stacked on ordinary income,
  //   and the same NIIT base (the engine's NIIT is min(gains
  //   stack, MAGI over the threshold)).
  interestIncome?: number;
  qualifiedDividends?: number;
  inflationPct: number;
  stateRatePct: number;
};

export type BracketLayer = {
  ratePct: number;
  // Taxable-ordinary-income span this layer covers.
  from: number;
  to: number | null; // null = the top (37%) bracket, no ceiling
  amount: number; // dollars of ordinary income taxed in this layer
  tax: number;
};

export type PriceYearResult = {
  provisionalIncome: number;
  ssTaxable: number;
  agi: number;
  magi: number;
  // "Show the math" intermediates — the engine's own breakdown
  // of the figures above, exposed for display only. Every value
  // here is computed in the same pass as the totals it feeds;
  // nothing downstream re-derives them.
  baseStandardDeduction: number;
  age65AddonTotal: number;
  count65: number;
  ordinaryTaxableIncome: number;
  gainsInTaxableIncome: number;
  bracketLayers: BracketLayer[];
  gainsAt0: number;
  gainsAt15: number;
  gainsAt20: number;
  // ACA household income (§36B): AGI + tax-exempt interest + the
  // NON-taxable portion of Social Security. Distinct from the
  // IRMAA MAGI above, which does not add back untaxed benefits.
  acaMagi: number;
  standardDeduction: number;
  seniorDeduction: number;
  deductions: number;
  taxableIncome: number;
  ordinaryTax: number;
  ltcgTax: number;
  niit: number;
  federalTax: number;
  stateTax: number;
  // Marginal ordinary bracket rate (%) on the next dollar of
  // ordinary taxable income.
  marginalBracketPct: number;
  irmaaTier: number;
};

function bracketTax(taxableOrdinary: number, law: YearLaw, fs: FilingStatus): number {
  const tops = law.brackets[fs];
  let tax = 0;
  let prev = 0;
  for (let i = 0; i < tops.length; i++) {
    const top = tops[i] ?? Infinity;
    const rate = (law.rates[i] ?? 0) / 100;
    if (taxableOrdinary <= prev) break;
    tax += (Math.min(taxableOrdinary, top) - prev) * rate;
    prev = top;
  }
  return tax;
}

function marginalRate(taxableOrdinary: number, law: YearLaw, fs: FilingStatus): number {
  const tops = law.brackets[fs];
  for (let i = 0; i < tops.length; i++) {
    if (taxableOrdinary < (tops[i] ?? Infinity)) return law.rates[i] ?? 0;
  }
  return law.rates[law.rates.length - 1] ?? 37;
}

export function deflationFactor(calendarYear: number, inflationPct: number): number {
  const years = Math.max(0, calendarYear - CURRENT_LAW.year);
  return 1 / Math.pow(1 + inflationPct / 100, years);
}

// The MAGI ceiling of IRMAA tier `tierIndex` under a law row,
// in today's dollars. Only the second-to-last tier's ceiling
// (the top tier's floor, $500k single / $750k joint) is adjusted:
// it is fixed by statute through 2028, then indexed, so in
// today's dollars it deflates only for the 2027–2028 steps.
// Tiers 0–3 are indexed figures and stay at their raw values.
// This is the single source for that deflated floor — both
// irmaaTierFor and the "just over the line" pill measure
// against it, so they can never disagree about where Tier 5
// starts.
export function irmaaTierUpTo(
  tierIndex: number,
  filingStatus: FilingStatus,
  law: YearLaw,
  calendarYear: number,
  inflationPct: number,
): number {
  const tier = law.irmaaTiers[tierIndex];
  if (!tier) return Infinity;
  let upTo = filingStatus === "mfj" ? tier.upToMfj : tier.upToSingle;
  if (tierIndex === law.irmaaTiers.length - 2 && Number.isFinite(upTo)) {
    const deflYears = Math.min(
      Math.max(0, calendarYear - CURRENT_LAW.year),
      Math.max(0, 2028 - CURRENT_LAW.year),
    );
    upTo = upTo / Math.pow(1 + inflationPct / 100, deflYears);
  }
  return upTo;
}

// IRMAA tier index (0 = no surcharge … 5 = top tier) for a MAGI,
// under a law row's tiers. HOH uses the single thresholds.
export function irmaaTierFor(
  magi: number,
  filingStatus: FilingStatus,
  law: YearLaw,
  calendarYear: number,
  inflationPct: number,
): number {
  const tiers = law.irmaaTiers;
  for (let i = 0; i < tiers.length; i++) {
    const upTo = irmaaTierUpTo(i, filingStatus, law, calendarYear, inflationPct);
    if (magi <= upTo) return i;
  }
  return tiers.length - 1;
}

// Annual IRMAA surcharge (Part B surcharge + Part D surcharge)
// for one person at a tier, under a law row.
export function irmaaAnnualPerPerson(tier: number, law: YearLaw): number {
  const t = law.irmaaTiers[tier] ?? law.irmaaTiers[0];
  if (!t) return 0;
  return r2(((t.partBTotalMonthly - law.partBStandardMonthly) + t.partDSurchargeMonthly) * 12);
}

export function priceYear(input: PriceYearInput): PriceYearResult {
  const law = lawForYear(input.calendarYear);
  const fs = input.filingStatus;
  const defl = deflationFactor(input.calendarYear, input.inflationPct);
  // Taxable yields (see PriceYearInput): dividends join the
  // gains stack; interest joins the ordinary side of AGI. With
  // both absent / 0 every sum below is the pre-yield sum, term
  // for term.
  const interestIncome = input.interestIncome ?? 0;
  const gainsStack = input.ltcg + (input.qualifiedDividends ?? 0);
  const agiExclSs =
    input.otherOrdinary + input.rmd + input.conversion + input.extraPreTaxDraw + gainsStack + interestIncome;
  const provisional = agiExclSs + input.taxExemptInterest + 0.5 * input.ssBenefits;
  const ssTaxable = ssTaxableAmount(input.ssBenefits, provisional, fs, defl);
  const agi = agiExclSs + ssTaxable;
  const magi = agi + input.taxExemptInterest;
  const acaMagi = magi + (input.ssBenefits - ssTaxable);

  const count65 =
    (input.agePrimary >= 65 ? 1 : 0) +
    (fs === "mfj" && input.ageSpouse != null && input.ageSpouse >= 65 ? 1 : 0);
  const standardDeduction =
    law.standardDeduction[fs] + law.age65Addon[fs] * count65;
  let seniorDeduction = 0;
  if (
    input.calendarYear >= SENIOR_DEDUCTION.firstYear &&
    input.calendarYear <= SENIOR_DEDUCTION.lastYear &&
    count65 > 0
  ) {
    // §224 MAGI adds back only foreign-income exclusions — NOT
    // tax-exempt interest — so the phase-out runs on AGI.
    // The §224 dollar figures are statutory (not indexed), so —
    // exactly like the §86 thresholds and the NIIT threshold
    // above — BOTH the per-person amount and the phase-out
    // start deflate into today's dollars by `defl` (1.0 in the
    // base law year and earlier, so 2025–2026 pricing is
    // unchanged). Deflating only one of the two would distort
    // the phase-out.
    const excess = Math.max(0, agi - SENIOR_DEDUCTION.phaseOutStart[fs] * defl);
    const perPerson = Math.max(
      0,
      SENIOR_DEDUCTION.amountPerPerson * defl - SENIOR_DEDUCTION.phaseOutRate * excess,
    );
    seniorDeduction = perPerson * count65;
  }
  const deductions = standardDeduction + seniorDeduction;
  const taxableIncome = Math.max(0, agi - deductions);

  const gainsInTi = Math.min(gainsStack, taxableIncome);
  const ordinaryTi = taxableIncome - gainsInTi;
  const ordinaryTax = bracketTax(ordinaryTi, law, fs);
  // Bracket stack for display: the same tops/rates walk as
  // bracketTax, recording each layer's span and tax. The layers'
  // tax sums exactly to ordinaryTax above.
  const bracketLayers: BracketLayer[] = [];
  {
    let prev = 0;
    for (let i = 0; i < law.brackets[fs].length; i++) {
      const top = law.brackets[fs][i] ?? Infinity;
      if (ordinaryTi <= prev) break;
      const amount = Math.min(ordinaryTi, top) - prev;
      const ratePct = law.rates[i] ?? 0;
      bracketLayers.push({
        ratePct,
        from: r2(prev),
        to: Number.isFinite(top) ? top : null,
        amount: r2(amount),
        tax: r2(amount * (ratePct / 100)),
      });
      prev = top;
    }
  }
  const zeroSpace = Math.max(0, law.ltcgZeroTop[fs] - ordinaryTi);
  const at0 = Math.min(gainsInTi, zeroSpace);
  const afterZero = gainsInTi - at0;
  const twentySpace = Math.max(0, law.ltcg20Floor[fs] - ordinaryTi - at0);
  const at15 = Math.min(afterZero, twentySpace);
  const at20 = afterZero - at15;
  const ltcgTax = 0.15 * at15 + 0.2 * at20;
  // §1411 MAGI is AGI plus only the foreign-income exclusions
  // (not modeled here) — unlike the IRMAA MAGI above, it does
  // NOT add back tax-exempt interest, so the NIIT threshold is
  // tested against AGI, not `magi`. The NIIT base is the gains
  // stack (realized gains + qualified dividends); interest
  // income is deliberately NOT in the base — see the
  // PriceYearInput note (a parked decision, not an oversight).
  const niit =
    (law.niitRate / 100) *
    Math.min(gainsStack, Math.max(0, agi - law.niitThreshold[fs] * defl));
  const federalTax = ordinaryTax + ltcgTax + niit;
  const stateTax = (input.stateRatePct / 100) * taxableIncome;
  return {
    provisionalIncome: r2(provisional),
    ssTaxable: r2(ssTaxable),
    agi: r2(agi),
    magi: r2(magi),
    acaMagi: r2(acaMagi),
    standardDeduction: r2(standardDeduction),
    seniorDeduction: r2(seniorDeduction),
    deductions: r2(deductions),
    taxableIncome: r2(taxableIncome),
    ordinaryTax: r2(ordinaryTax),
    ltcgTax: r2(ltcgTax),
    niit: r2(niit),
    federalTax: r2(federalTax),
    stateTax: r2(stateTax),
    marginalBracketPct: marginalRate(ordinaryTi, law, fs),
    irmaaTier: irmaaTierFor(magi, fs, law, input.calendarYear, input.inflationPct),
    baseStandardDeduction: r2(law.standardDeduction[fs]),
    age65AddonTotal: r2(law.age65Addon[fs] * count65),
    count65,
    ordinaryTaxableIncome: r2(ordinaryTi),
    gainsInTaxableIncome: r2(gainsInTi),
    bracketLayers,
    gainsAt0: r2(at0),
    gainsAt15: r2(at15),
    gainsAt20: r2(at20),
  };
}

/* ---------------- ACA premium credit ---------------- */

export type AcaCreditResult = {
  credit: number;
  pctFpl: number;
  applicablePct: number;
  fpl: number;
  cliff: number; // 400% FPL for the household size
  overCliff: boolean;
};

export function acaCreditFor(args: {
  magi: number;
  householdSize: number;
  coverageYear: number;
  benchmarkAnnual: number;
}): AcaCreditResult {
  // Coverage-year credits use the PRIOR year's poverty guidelines.
  const fpl = fplFor(args.householdSize, args.coverageYear - 1);
  const cliff = 4 * fpl;
  const pctFpl = fpl > 0 ? (args.magi / fpl) * 100 : 0;
  // The 400% FPL cliff applies from 2026 on. 2025 coverage priced
  // under the enhanced schedule (Rev. Proc. 2024-35), which has
  // NO cliff: above 400% FPL the applicable percentage stays at
  // its 8.5% cap and a credit is still priced (overCliff false).
  const hasCliff = args.coverageYear >= 2026;
  const overCliff = hasCliff && args.magi > cliff;
  if (overCliff || pctFpl < 100) {
    return { credit: 0, pctFpl: r2(pctFpl), applicablePct: 0, fpl, cliff, overCliff };
  }
  const bands = acaTableFor(args.coverageYear);
  const lows = [0, 133, 150, 200, 250, 300];
  let applicablePct = bands[bands.length - 1]?.finalPct ?? 9.96;
  for (let i = 0; i < bands.length; i++) {
    const band = bands[i];
    if (!band) continue;
    if (pctFpl <= band.upToPctFpl || i === bands.length - 1) {
      const lo = lows[i] ?? 0;
      const span = band.upToPctFpl - lo;
      const frac = span > 0 ? Math.min(1, Math.max(0, (pctFpl - lo) / span)) : 0;
      applicablePct = band.initialPct + (band.finalPct - band.initialPct) * frac;
      break;
    }
  }
  const expected = (applicablePct / 100) * args.magi;
  return {
    credit: r2(Math.max(0, args.benchmarkAnnual - expected)),
    pctFpl: r2(pctFpl),
    applicablePct: r2(applicablePct),
    fpl,
    cliff,
    overCliff: false,
  };
}

/* ---------------- RMD ---------------- */

export function rmdForYear(args: {
  priorDec31PreTax: number;
  agePrimary: number;
  ageSpouse: number | null;
  birthYearPrimary: number;
  spouseSoleBeneficiary: boolean;
}): { rmd: number; divisor: number | null; table: "joint" | "uniform" | null } {
  const rmdAge = rmdAgeForBirthYear(args.birthYearPrimary);
  if (args.agePrimary < rmdAge || args.priorDec31PreTax <= 0) {
    return { rmd: 0, divisor: null, table: null };
  }
  const useJoint =
    args.spouseSoleBeneficiary &&
    args.ageSpouse != null &&
    args.agePrimary - args.ageSpouse > 10;
  const divisor = useJoint
    ? jointDivisor(args.agePrimary, args.ageSpouse ?? args.agePrimary)
    : uniformDivisor(args.agePrimary);
  return {
    rmd: r2(args.priorDec31PreTax / divisor),
    divisor,
    table: useJoint ? "joint" : "uniform",
  };
}

// One person's own RMD on the Uniform Lifetime Table — the
// spouse's own RMD while both spouses are alive (her spouse is
// older, so the Joint Life table never applies to her), and
// the survivor's RMD on the combined inherited balance after
// a death.
export function uniformRmdFor(args: {
  priorDec31PreTax: number;
  age: number;
  birthYear: number;
}): { rmd: number; divisor: number | null } {
  const rmdAge = rmdAgeForBirthYear(args.birthYear);
  if (args.age < rmdAge || args.priorDec31PreTax <= 0) {
    return { rmd: 0, divisor: null };
  }
  const divisor = uniformDivisor(args.age);
  return { rmd: r2(args.priorDec31PreTax / divisor), divisor };
}

/* ---------------- Fill-to-target ---------------- */

export type FillCeilings = {
  bracketTopPct: number | null; // fill taxable income to the top of this bracket
  irmaaTierCap: number | null; // keep MAGI at or below this tier's ceiling
  ltcgZeroCap: boolean; // keep taxable income within the 0% gains space
  acaCliffCap: boolean; // keep MAGI at or below 400% FPL
  // Era-aware cliff cap: when true (and acaCliffCap is on), the
  // cliff cap defends the line only in years BEFORE the plan's
  // acaStepDownYear; from that year on the cap is off for the
  // year and the year prices undefended. A modifier of
  // acaCliffCap, never a ceiling in its own right — it is
  // deliberately NOT part of ceilingsActive below. Absent on a
  // ceilings object built before this field existed reads as
  // false (every construction site defaults it), so behaviour
  // with the flag off is bit-identical to before.
  acaCliffCapFamilyOnly: boolean;
  magiCap: number | null; // custom $ MAGI cap
  // ACA cliff safety buffer ($): when the cliff cap is on, the
  // targets the fill and the pre-tax draw aim at are the cliff
  // LESS this amount, so a capped year lands at cliff − buffer
  // and a late-year income surprise (a December fund
  // distribution, estimate drift) does not push ACA MAGI $1
  // over the line and forfeit the whole year's premium credit.
  // A modifier of acaCliffCap, never a ceiling in its own
  // right — deliberately NOT part of ceilingsActive below, and
  // it does nothing when the cliff cap is off. Absent / null /
  // 0 reads as no buffer (every construction site defaults
  // it), so an unbuffered plan prices bit-identically to
  // before. The credit itself is still priced by law on the
  // year's ACTUAL acaMagi against the TRUE cliff.
  acaCliffBuffer: number | null;
};

export const NO_CEILINGS: FillCeilings = {
  bracketTopPct: null,
  irmaaTierCap: null,
  ltcgZeroCap: false,
  acaCliffCap: false,
  acaCliffCapFamilyOnly: false,
  magiCap: null,
  acaCliffBuffer: null,
};

export function ceilingsActive(c: FillCeilings): boolean {
  return (
    c.bracketTopPct != null ||
    c.irmaaTierCap != null ||
    c.ltcgZeroCap ||
    c.acaCliffCap ||
    c.magiCap != null
  );
}

// The conversion (in $100 steps, per the design) that brings the
// year exactly to the TIGHTEST active ceiling without crossing
// any of them. Taxable income / MAGI / ACA MAGI are each
// non-decreasing in the conversion, so the steps that respect
// every ceiling form a prefix: the first $100 step that crosses
// a ceiling ends the fill and the previous step is the answer.
// Without a guardrail that answer is found by binary search
// over the prefix (identical result to pricing every step —
// the fixture suite pins fills to the dollar); the sequential
// scan priced up to tens of thousands of steps per simulation,
// which is what made searching six draw orders × the strategy
// set too slow to run. The guardrail variant keeps the
// sequential scan: its stop rule is defined on consecutive
// steps' tax cost and has no closed form.
//
// Optional marginal-rate guardrail (the Lifetime-Tax Optimizer's
// variant): when `guardrailTargetPct` is set, the fill also stops
// at the first $100 step whose own tax cost — the step's increase
// in federal + state tax, which for a $100 step IS the effective
// marginal rate in percent — would exceed the target rate. This
// is what pauses a fill inside the Social Security torpedo zone
// (a 40.7% step inside a 22% fill) and lets it resume once
// benefits are fully phased in and the step rate falls back to
// the bracket rate. With the guardrail unset (every pre-optimizer
// caller) the result is exactly the step scan it always was.
export function fillConversion(args: {
  base: PriceYearInput; // priced with conversion = 0
  ceilings: FillCeilings;
  maxConversion: number;
  acaCliff: number | null; // 400% FPL when the ACA cap is on and priced
  guardrailTargetPct?: number | null;
}): number {
  const { ceilings } = args;
  if (!ceilingsActive(ceilings)) return Math.max(0, Math.floor(args.maxConversion));
  const law = lawForYear(args.base.calendarYear);
  const fs = args.base.filingStatus;
  let taxableCap = Infinity;
  if (ceilings.bracketTopPct != null) {
    const idx = law.rates.indexOf(ceilings.bracketTopPct);
    if (idx >= 0) taxableCap = Math.min(taxableCap, law.brackets[fs][idx] ?? Infinity);
  }
  if (ceilings.ltcgZeroCap) {
    taxableCap = Math.min(taxableCap, law.ltcgZeroTop[fs]);
  }
  let magiCap = Infinity;
  if (ceilings.irmaaTierCap != null) {
    // The cap is the SAME top-of-tier boundary the tier
    // classifier uses — irmaaTierUpTo deflates the second-to-
    // last tier's ceiling (the top tier's floor, fixed through
    // 2028), so a Tier 4 cap binds at the deflated floor, not
    // the raw law-row ceiling.
    magiCap = Math.min(
      magiCap,
      irmaaTierUpTo(
        ceilings.irmaaTierCap,
        fs,
        law,
        args.base.calendarYear,
        args.base.inflationPct,
      ),
    );
  }
  if (ceilings.magiCap != null) magiCap = Math.min(magiCap, ceilings.magiCap);
  // The ACA cliff caps ACA household income (§36B MAGI), not the
  // IRMAA MAGI — a separate cap checked against acaMagi. The
  // safety buffer lowers the TARGET below the true cliff (the
  // caller still passes the true cliff; the credit is priced
  // on actual MAGI against it elsewhere) — floored at 0, where
  // no conversion step can respect the cap and the fill is $0.
  let acaMagiCap = Infinity;
  if (ceilings.acaCliffCap) {
    if (args.acaCliff != null) {
      acaMagiCap = Math.max(
        0,
        args.acaCliff - Math.max(0, ceilings.acaCliffBuffer ?? 0),
      );
    } else {
      // ACA is inactive this year (nobody under 65, or spouse
      // status unknown), so there is no cliff to cap at. If the
      // ACA cap is the ONLY ceiling switched on, it must not
      // silently become "no cap at all" and drain the whole
      // pre-tax balance — the fill converts $0. When other
      // ceilings are also active, they govern on their own.
      const otherCeilingsActive =
        ceilings.bracketTopPct != null ||
        ceilings.irmaaTierCap != null ||
        ceilings.ltcgZeroCap ||
        ceilings.magiCap != null;
      if (!otherCeilingsActive) return 0;
    }
  }
  const guardrailTarget = args.guardrailTargetPct ?? null;
  let prevStepTax: number | null = null;
  if (guardrailTarget != null) {
    const p0 = priceYear({ ...args.base, conversion: 0 });
    prevStepTax = p0.federalTax + p0.stateTax;
  }
  const maxSteps = Math.floor(Math.max(0, args.maxConversion) / 100);
  if (guardrailTarget == null) {
    const respectsCaps = (conv: number): boolean => {
      const p = priceYear({ ...args.base, conversion: conv });
      return (
        p.taxableIncome <= taxableCap + 0.005 &&
        p.magi <= magiCap + 0.005 &&
        p.acaMagi <= acaMagiCap + 0.005
      );
    };
    let lo = 0;
    let hi = maxSteps;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if (respectsCaps(mid * 100)) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo * 100;
  }
  let best = 0;
  for (let step = 1; step <= maxSteps; step++) {
    const conv = step * 100;
    const p = priceYear({ ...args.base, conversion: conv });
    if (guardrailTarget != null && prevStepTax != null) {
      const stepRate = p.federalTax + p.stateTax - prevStepTax;
      if (stepRate > guardrailTarget + 0.005) break;
    }
    if (p.taxableIncome > taxableCap + 0.005) break;
    if (p.magi > magiCap + 0.005) break;
    if (p.acaMagi > acaMagiCap + 0.005) break;
    best = conv;
    prevStepTax = p.federalTax + p.stateTax;
  }
  return best;
}

/* ---------------- Spending draw order ----------------
   After the year's RMD — forced out of Pre-tax first under
   every order; it is legally required and is never part of the
   choice — a year's spending deficit is drawn from the three
   buckets in the plan's draw order. The order governs SPENDING
   draws only: tax and IRMAA keep their existing sourcing
   (surplus cash first, then Taxable down to the
   protect-minimum when paying from Taxable, then withheld
   from the conversion), and the protect-minimum floor applies
   identically under every order. The default is the order the
   engine always used: Taxable → Pre-tax → Roth. */

export type DrawBucket = "taxable" | "pretax" | "roth";
export type DrawOrder = readonly [DrawBucket, DrawBucket, DrawBucket];

const DRAW_BUCKET_LABELS: Record<DrawBucket, string> = {
  taxable: "Taxable",
  pretax: "Pre-tax",
  roth: "Roth",
};

export const DRAW_ORDER_OPTIONS: { key: string; order: DrawOrder }[] = [
  { key: "taxable-pretax-roth", order: ["taxable", "pretax", "roth"] },
  { key: "taxable-roth-pretax", order: ["taxable", "roth", "pretax"] },
  { key: "pretax-taxable-roth", order: ["pretax", "taxable", "roth"] },
  { key: "pretax-roth-taxable", order: ["pretax", "roth", "taxable"] },
  { key: "roth-taxable-pretax", order: ["roth", "taxable", "pretax"] },
  { key: "roth-pretax-taxable", order: ["roth", "pretax", "taxable"] },
];

export const DEFAULT_DRAW_ORDER: DrawOrder = ["taxable", "pretax", "roth"];
export const DEFAULT_DRAW_ORDER_KEY = "taxable-pretax-roth";
export const ALL_DRAW_ORDERS: DrawOrder[] = DRAW_ORDER_OPTIONS.map((o) => o.order);

export function drawOrderKey(order: DrawOrder): string {
  return order.join("-");
}

export function drawOrderFromKey(key: string | null | undefined): DrawOrder {
  return DRAW_ORDER_OPTIONS.find((o) => o.key === key)?.order ?? DEFAULT_DRAW_ORDER;
}

export function drawOrderLabel(order: DrawOrder): string {
  return order.map((b) => DRAW_BUCKET_LABELS[b]).join(" → ");
}

// The draw order in effect for a plan year: drawOrderAfter
// once the primary's age reaches drawOrderSwitchAge, the base
// drawOrder before that — and at every age when either switch
// field is blank (the switch is inert then, bit-identical to
// the pre-switch engine). The switch year itself already uses
// the after-order.
export function effectiveDrawOrder(
  inputs: RothPlanInputs,
  agePrimary: number,
): DrawOrder {
  if (
    inputs.drawOrderSwitchAge != null &&
    inputs.drawOrderAfter != null &&
    agePrimary >= inputs.drawOrderSwitchAge
  ) {
    return inputs.drawOrderAfter;
  }
  return inputs.drawOrder;
}

/* ---------------- The plan simulation ---------------- */

// One taxable basis tier (lot): sharePct is this tier's share
// of the combined taxable pool (taxable + cash), basisPct the
// share of THIS tier that is already-taxed basis. See
// RothPlanInputs.taxableTiers for the sale-order rules.
export type TaxableTier = { sharePct: number; basisPct: number };

// The engine's per-tier ledger state: balance and basis
// dollars for one tier. `inflow` marks the synthetic tier that
// collects after-tax inflows (surplus sweeps, settlement
// credits, harvest credits) at 100% basis — new money is its
// own lot, merged into that one tier across years. `cash`
// marks the CASH tier for the spend-from-cash sleeve (see
// RothPlanInputs.spendFromCashPct): the first tier whose
// starting basis % is 100 — on a record whose tiers split the
// snapshot cash out as its own lot, that tier's balance IS
// the cash portion of the pool.
type TierLedger = { bal: number; basis: number; inflow: boolean; cash?: boolean };

// Consume `amount` of balance from a tier ledger, HIGHEST
// current basis ratio first ("highest" — ordinary sales: sell
// the least-gain shares first) or LOWEST first ("lowest" —
// the gain harvest: the gains live in the most-appreciated
// tier). The order is re-evaluated on every call; within a
// tier the sale is pro-rata (basis leaves at the tier's ratio
// in force), so a tier's ratio never changes by selling from
// it, and a sale larger than the top tier spills into the
// next tier in the same call. Returns the gains realized.
// Mutates the ledger in place; the caller owns the copies it
// passes (a settlement works on its own snapshot).
function sellFromTiers(
  tiers: TierLedger[],
  amount: number,
  order: "highest" | "lowest",
): number {
  if (amount <= 0) return 0;
  const ranked = tiers
    .map((t, i) => ({ i, ratio: t.bal > 0 ? t.basis / t.bal : null }))
    .filter((o): o is { i: number; ratio: number } => o.ratio != null)
    .sort((a, b) => (order === "highest" ? b.ratio - a.ratio : a.ratio - b.ratio));
  let remaining = amount;
  let gains = 0;
  for (const { i } of ranked) {
    if (remaining <= 0) break;
    const t = tiers[i]!;
    const take = Math.min(remaining, t.bal);
    if (take <= 0) continue;
    const ratio = t.basis / t.bal;
    gains += take * (1 - ratio);
    t.basis = Math.max(0, t.basis - take * ratio);
    t.bal -= take;
    remaining -= take;
  }
  return gains;
}

// After-tax money into Taxable lands at 100% basis: it merges
// into the ledger's inflow tier (created on first use), whose
// balance and basis rise by the same amount — the lot
// analogue of the single-pool ledger's dollar-for-dollar
// basisIn. The inflow tier then drifts like any other tier.
function buyIntoTiers(tiers: TierLedger[], amount: number): void {
  if (amount <= 0) return;
  const existing = tiers.find((t) => t.inflow);
  if (existing) {
    existing.bal += amount;
    existing.basis += amount;
  } else {
    tiers.push({ bal: amount, basis: amount, inflow: true });
  }
}

// Step a tier ledger's basis up by `amount` (the harvest's
// rebuy): the harvested gain is added to the LOWEST-ratio
// tiers first — the tiers the harvest sold from — capped at
// each tier's own unrealized gain, so no tier's basis ever
// passes its balance.
function stepUpTiers(tiers: TierLedger[], amount: number): void {
  if (amount <= 0) return;
  const ranked = tiers
    .map((t, i) => ({ i, ratio: t.bal > 0 ? t.basis / t.bal : 1 }))
    .sort((a, b) => a.ratio - b.ratio);
  let remaining = amount;
  for (const { i } of ranked) {
    if (remaining <= 0) break;
    const t = tiers[i]!;
    const room = Math.max(0, t.bal - t.basis);
    const add = Math.min(room, remaining);
    t.basis += add;
    remaining -= add;
  }
}

// Reinvested taxable yield on the tiers path: the yield cash
// is already inside the year's balance (the balance grows at
// the total return, of which the yield is a component), so NO
// tier balance moves here — unlike a real after-tax inflow
// (buyIntoTiers), which arrives with its own balance and
// raises the inflow tier's balance with it. Only the basis
// ledger rises, dollar for dollar up to the balance cap —
// the single-pool treatment: the added basis fills the tiers'
// unrealized gain, lowest basis ratio first, capped at each
// tier's own balance (the stepUpTiers mechanics), so every
// tier keeps 0 ≤ basis ≤ its own balance and the total basis
// can never pass the total balance. Any yield beyond the
// pool's whole unrealized gain adds no basis — the excess is
// capped, never a modeled capital loss.
function reinvestYieldIntoTiers(tiers: TierLedger[], amount: number): void {
  stepUpTiers(tiers, amount);
}

// Clamp a committed tier ledger to the balance it describes:
// every tier's basis within [0, its own balance], and the tier
// balances summing to the settled balance. Reconciliation only
// ever moves float dust on a correctly mirrored ledger; it
// exists so no path can commit a ledger whose balances drift
// from the settled taxable balance or whose basis passes it.
// A shortfall (tier balances under the settled balance) lands
// on the inflow tier — or the largest tier when no inflow tier
// exists yet — as balance with no basis; an excess comes off
// the tiers pro-rata, each tier's basis following its balance
// down proportionally before the per-tier basis clamp bites.
function clampTierLedgerToBalance(
  tiers: TierLedger[],
  settledBalance: number,
): void {
  const target = Math.max(0, settledBalance);
  let total = tiers.reduce((s, t) => s + Math.max(0, t.bal), 0);
  if (total > target && total > 0) {
    const scale = target / total;
    for (const t of tiers) {
      const bal = Math.max(0, t.bal) * scale;
      t.basis = t.bal > 0 ? t.basis * (bal / t.bal) : 0;
      t.bal = bal;
    }
    total = target;
  } else if (total < target) {
    const shortfall = target - total;
    const host =
      tiers.find((t) => t.inflow) ??
      tiers.reduce<TierLedger | null>(
        (best, t) => (best == null || t.bal > best.bal ? t : best),
        null,
      );
    if (host) {
      host.bal += shortfall;
      total = target;
    }
  }
  for (const t of tiers) {
    t.bal = Math.max(0, t.bal);
    t.basis = Math.min(Math.max(0, t.basis), t.bal);
  }
}

export type RothPlanInputs = {
  startYear: number;
  birthYearPrimary: number;
  birthYearSpouse: number | null;
  filingStatus: FilingStatus;
  endAgePrimary: number;
  pretaxStart: number;
  // Per-spouse pre-tax (Part 1): the spouse's own pre-tax
  // balance, priced on HER OWN RMD clock (her birth year, the
  // Uniform Lifetime Table) while both spouses are alive.
  // Conversions draw the primary's balance first, then hers.
  // Optional so every pre-existing constructor (fixtures,
  // optimizer candidates built by spreading a plan) keeps its
  // meaning: absent = $0, exactly the old single-balance plan.
  pretaxSpouseStart?: number;
  // Survivor scenario (Part 2): when enabled with a death year,
  // the plan reprices from that year — MFJ in the death year
  // itself (each spouse's own RMD still taken that year, the
  // deceased's included, exactly as if they had lived it),
  // Single from the next year, the survivor keeping the larger
  // Social Security benefit and inheriting the remaining
  // combined pre-tax balance on the survivor's own RMD clock
  // (Uniform) from that next year.
  survivorEnabled?: boolean;
  survivorWho?: "primary" | "spouse"; // who dies
  survivorDeathYear?: number | null; // calendar year of death
  rothStart: number;
  taxableStart: number;
  hsaStart: number;
  taxableBasisPct: number; // % of the taxable balance that is cost basis
  // True when the plan's basis % is BLANK (not entered): the
  // record layer maps blank to 100 (no modeled gains on draws),
  // and gain harvesting is INERT — there is no basis to step up,
  // so the harvest is $0 in every year and the plan prices
  // bit-identically to harvesting off. Absent / false = an
  // entered basis %.
  // BASIS-DRIFT: an entered % is the STARTING share only. The
  // simulation carries the taxable account's basis in DOLLARS
  // (see the basis ledger in simulateRothPlan): the dollars
  // never grow with returns, every outflow from Taxable leaves
  // pro-rata at the ratio then in force, after-tax inflows
  // raise the dollars one-for-one, and harvesting steps them
  // up — so later years price draws at the drifted ratio, not
  // the starting %. A BLANK basis keeps the pre-drift pricing
  // exactly: this flag selects that legacy code path, and
  // every figure on it is bit-identical to before.
  // Optional so every pre-existing constructor keeps its
  // meaning (an explicit pct is a modeled basis).
  taxableBasisBlank?: boolean;
  // BASIS TIERS (optional): the taxable pool split into lots,
  // each a share of the pool (taxable + cash, as the pool is
  // priced) carrying its own starting basis %. When present
  // (and the basis is not blank) the tiers REPLACE
  // taxableBasisPct as the pool's basis source: the drift
  // ledger runs per tier, every tier grows at the plan's
  // expected return, and every gain-realizing sale from
  // Taxable consumes tiers highest-basis-ratio first (the
  // ratio re-evaluated per sale; within a tier the sale is
  // pro-rata, exactly the single-pool drift rule). Inflows
  // land at 100% basis; the gain harvest sells from the
  // lowest-ratio tier and its rebuy steps that tier up.
  // Absent / null / empty = the single pool at
  // taxableBasisPct, bit-identical to before. Shares are
  // proportions: writer-validated to sum to 100, and the
  // engine normalizes defensively so a direct construction
  // whose shares sum to something else still splits the
  // whole pool.
  taxableTiers?: TaxableTier[] | null;
  // TAXABLE YIELDS (optional): the taxable pool's annual
  // dividend and interest yields, each a % of the year's
  // STARTING taxable balance (the balance the year opens with,
  // after any gift outflow). Each priced year the dividend
  // yield × the balance is qualified-dividend income on the
  // gains stack and the interest yield × the balance is
  // interest income on the ordinary stack (see priceYear);
  // both are mandatory income for the year — they sit in the
  // fill base, so conversions, capped draws, and the gain
  // harvest all shrink around them, and a year whose yield
  // alone breaches the ACA cliff honestly loses the credit.
  // The yields are COMPONENTS of expectedReturnPct, never
  // income on top of it: the balance still grows at the full
  // expected return, and the yield cash is treated as
  // reinvested — it adds to the taxable basis dollar-for-dollar
  // (the tiers ledger's inflow tier at 100% basis; the
  // single-pool drift ledger outright), clamped by the
  // ledger's standing 0 ≤ basis ≤ balance invariant when the
  // yields outrun the return (see the yields-exceed-return
  // fixture). Absent / null / 0 = no yield modeled, and the
  // plan prices bit-identically to before this build.
  taxableDividendYieldPct?: number | null;
  taxableInterestYieldPct?: number | null;
  // SPEND-FROM-CASH (optional): the % of each year's spending
  // need that is paid from the taxable pool's CASH portion
  // first — before the year's draw order runs — plus the
  // starting size of that cash sleeve, in dollars.
  // · spendFromCashPct: absent / null = blank = OFF, and the
  //   plan prices bit-identically to before this build. 0 is
  //   also off in effect (a $0 cash share every year). When
  //   set, each priced year's cash-paid share is
  //   min(pct% × the year's spending need, the year's spending
  //   deficit after cash income, the sleeve remaining, the
  //   pool balance available). Cash carries no income, no
  //   gains, and no MAGI: the share is a pool debit that
  //   realizes nothing and simply reduces the draw the year's
  //   settlement must fund — conversions and capped draws then
  //   settle against the reduced draw exactly as they settle
  //   today (the cliff settlement included, so a capped year
  //   still lands MAGI on the cliff).
  // · spendFromCashSleeveStart: the sleeve's starting dollars
  //   — the snapshot Cash bucket portion of the combined
  //   taxable pool, threaded server-side the way the snapshot
  //   balances themselves are threaded (see
  //   spendFromCashSleeveCents on the saved shape in
  //   rothOptimizer.ts); it is NOT a saved user field. Absent
  //   = $0: a compute base that passes an explicit taxable
  //   balance with no snapshot context prices with no cash
  //   sleeve, identical to blank.
  // THE SLEEVE INVARIANT (the invariant this build defines):
  // 0 ≤ sleeve ≤ the taxable pool balance at every step. In
  // the single pool the sleeve is a pure sub-ledger: it
  // never grows (growth, inflows, surplus sweeps and
  // reinvested yield never replenish it — once empty it
  // stays empty) and it only shrinks. In tiers mode the
  // sleeve IS the 100%-basis cash tier's balance, so it
  // moves exactly as that tier moves under the tiers
  // model's own rules (including the growth and inflow
  // allocations every tier receives) — the two ledgers
  // agree to the cent by construction. A cash-spending
  // debit shrinks
  // it dollar-for-dollar; ANY other pool debit (a tax sale, a
  // non-cash taxable spending draw, an unpaid-tax debit, a
  // settlement / harvest delta payment, a gift outflow)
  // shrinks it by the cash that debit took — in tiers mode,
  // the amount taken from the 100%-basis cash tier under the
  // existing highest-basis-first sale order (so the sleeve
  // and the tier ledger agree to the cent, and with tiers
  // present the sleeve IS that tier's balance — a tier list
  // with no 100%-basis tier has no cash sleeve); in the
  // single pool, which defines no sale order of its own, a
  // debit is attributed to the pool's non-cash portion
  // first, so the sleeve shrinks only by the part of a
  // debit that exceeds the non-cash remainder. Cash is
  // 100% basis: in the single pool a
  // cash-spending debit removes basis dollars dollar-for-
  // dollar (the zero-gain treatment) while the rest of the
  // year's draws keep the pool's normal pro-rata basis
  // behaviour. Tax payments are unchanged — they consume the
  // pool / tiers highest-basis-first per the existing order,
  // so they can also drain the sleeve. Yields are unchanged:
  // still charged on the year's starting taxable balance.
  spendFromCashPct?: number | null;
  spendFromCashSleeveStart?: number;
  // Flexible spending (guardrail): a year's spending need is
  // cut when the PRIOR simulated year's applied return was
  // negative (see flexSpendingNeed).
  // · flexCutPct: absent / null = blank = OFF, and the plan
  //   prices bit-identically to a plan without the fields. 0
  //   is also off in effect. When set, a triggered year's
  //   need is its base need reduced by this percent.
  // · flexFloorPct: the floor — a triggered year's need never
  //   falls below this percent of its base need. Absent /
  //   null reads as 80 inside a triggered cut; the floor
  //   alone never turns anything on.
  flexCutPct?: number | null;
  flexFloorPct?: number | null;
  annualSpending: number;
  retirementAge: number;
  expectedReturnPct: number; // real, blended — from the Retirement calc
  ssPrimaryAnnual: number;
  ssPrimaryStartAge: number | null;
  // Declared "No benefit" state for either person's Social
  // Security field (generic, symmetric). Three states per field:
  // amount entered, blank (not entered yet), and declared no
  // benefit (a finished answer). When true the engine input is
  // $0 regardless of any stored amount — declared prices EXACTLY
  // like an entered $0 on every path. Absent / false = not
  // declared, exactly the pre-existing behavior.
  ssPrimaryNoBenefit?: boolean;
  ssSpouseAnnual: number;
  ssSpouseStartAge: number | null;
  ssSpouseNoBenefit?: boolean;
  otherOrdinaryAnnual: number;
  taxExemptInterestAnnual: number;
  convertedAlreadyThisYear: number;
  windowStartAge: number;
  windowStopAge: number;
  payTaxFrom: "taxable" | "conversion";
  protectMinTaxable: number;
  // The order the buckets fund spending in, after the year's
  // forced RMD (see the draw-order section above).
  drawOrder: DrawOrder;
  // Draw-order switch: from the year the primary reaches
  // drawOrderSwitchAge, spending draws use drawOrderAfter
  // instead of drawOrder. Optional so every pre-existing
  // constructor keeps its meaning: if EITHER field is absent /
  // null the switch is inert — drawOrder applies at every age
  // and the plan prices bit-identically to before.
  drawOrderSwitchAge?: number | null;
  drawOrderAfter?: DrawOrder | null;
  spouseSoleBeneficiary: boolean;
  acaHouseholdSize: number;
  acaHouseholdSizeAfter: number;
  acaStepDownYear: number | null;
  acaBenchmarkCouple: number | null;
  acaBenchmarkSingle: number | null;
  // Family benchmark (household of 3 or more). Optional so
  // every pre-existing constructor keeps its meaning: absent /
  // null = blank = a household-3+ year falls back to the
  // benchmark that priced it before this field existed (the
  // couple figure in the both-on-the-marketplace family years),
  // bit-identical to before.
  acaBenchmarkFamily?: number | null;
  // The age the SPOUSE leaves the marketplace for Medicare.
  // Her ACA pricing runs while spouseAge < acaSpouseEndAge,
  // and her Medicare / IRMAA premium count starts at that
  // same age (the primary's own 65 is untouched). Optional so
  // every pre-existing constructor keeps its meaning: absent /
  // null = 65, which prices bit-identically to before this
  // field existed. An end age above 65 prices her as a solo
  // marketplace member in the extended years (one-spouse
  // benchmark, household size and cliff exactly as in the
  // existing solo years); below 65 her pricing stops early
  // and her premium count starts early, symmetrically.
  acaSpouseEndAge?: number | null;
  inflationPct: number;
  stateRatePct: number;
  heirRatePct: number;
  // "Preserve pre-tax" reserve: a fixed NOMINAL dollar floor
  // (it does not inflate, like protectMinTaxable) that
  // CONVERSIONS may never cross — in every simulated year the
  // conversion is capped so the post-conversion COMBINED
  // pre-tax balance (primary + spouse) stays at or above the
  // floor. RMDs and spending draws are unaffected: the reserve
  // is not a lockbox, and growth above the floor stays
  // convertible in later years. Scoring prices the ending
  // pre-tax balance in two parts (see netCostBreakdown in
  // rothOptimizer.ts): the portion up to the floor at
  // preserveExitRatePct, any excess at heirRatePct.
  // Optional so every pre-existing constructor keeps its
  // meaning: absent / 0 = no reserve, and the plan prices
  // bit-identically to before; absent exit rate = heir rate.
  preservePretax?: number;
  preserveExitRatePct?: number;
  // FAFSA-reportable assets, in dollars — a DISPLAY-LAYER input
  // only: it gates whether the "college years" watch-out is
  // emitted (see the gate in simulateRothPlan) and affects no
  // priced figure, fill, or score. Absent / null = unknown, and
  // unknown NEVER suppresses the watch-out, so every
  // pre-existing constructor keeps the legacy behavior.
  fafsaReportableAssets?: number | null;
  // The household's college window, labeled by FALL year (a
  // Sep-2027 start = fall 2027; a 4-year span = falls
  // 2027–2030). A conversion in tax year Y feeds the FAFSA for
  // academic year Y+2, so the college watch-out fires for year
  // Y only when BOTH fields are set and from ≤ Y+2 ≤ through.
  // Absent / null on either = no college window = the watch-out
  // never fires, so every pre-existing constructor keeps
  // working unchanged.
  collegeFallFromYear?: number | null;
  collegeFallThroughYear?: number | null;
  // Earliest Social Security claiming age the Roth optimizer
  // may crown as its winner (62–70). An OPTIMIZER-LAYER input
  // only: simulateRothPlan never reads it — it constrains
  // winner selection in the joint claiming-age search (see
  // runJointOptimizer in rothOptimizer.ts), never a priced
  // figure, a fill, or a score. Absent / null = no floor, and
  // the search behaves exactly as before.
  claimAgeFloor?: number | null;
  // Gift what-if seams — set ONLY by the gift comparison model
  // (server/src/giftModel.ts), never by the saved plan, a
  // scenario, or any main Plan / Optimize / Compare / Work
  // years run. Absent = no seam, and the simulation is
  // bit-identical to before.
  // · giftOutflow: a one-time removal of appreciated shares
  //   from the Taxable bucket at the start of the year the
  //   primary reaches giftOutflowAge (the first simulated year
  //   at or past that age). The amount leaves the household —
  //   it is not spending, realizes no gain, and stops growing
  //   for the parents from that year onward.
  giftOutflowAge?: number | null;
  giftOutflowAmount?: number;
  // · saleGain: a one-time long-term capital gain injected
  //   into the gains stack of the year the primary reaches
  //   saleGainAge — the counterfactual "parents sell the
  //   gifted shares themselves" pricing. It flows through
  //   priceYear like any realized gain (bracket stacking,
  //   NIIT, ACA / IRMAA MAGI), and the fill solver sees it in
  //   the year's base, so it occupies the ceilings exactly as
  //   a realized gain does.
  saleGainAge?: number | null;
  saleGainAmount?: number;
};

// FAFSA / SAI parent asset assessment: the formula converts
// parent assets into expected contribution at a top rate of
// 5.64% per year.
export const FAFSA_PARENT_ASSET_RATE = 0.0564;
// Benchmark full cost of attendance at a public university, in
// dollars. When 5.64% of a household's FAFSA-reportable assets
// alone reaches this benchmark, need-based aid cannot reach the
// household even at $0 income — the college-years watch-out is
// then arithmetically moot and is suppressed.
export const FAFSA_PUBLIC_COA_BENCHMARK = 40000;

// Effective Social Security amounts: a declared "No benefit"
// prices as $0 regardless of any stored amount.
export function effectiveSsPrimaryAnnual(inputs: RothPlanInputs): number {
  return inputs.ssPrimaryNoBenefit ? 0 : inputs.ssPrimaryAnnual;
}
export function effectiveSsSpouseAnnual(inputs: RothPlanInputs): number {
  return inputs.ssSpouseNoBenefit ? 0 : inputs.ssSpouseAnnual;
}

export type RothStrategy = {
  id: string;
  name: string;
  ceilings: FillCeilings | null; // null = Do Nothing
  // Lifetime-Tax Optimizer variants (both default off; every
  // pre-optimizer strategy runs with them unset, unchanged).
  // guardrail: within a year, stop filling at the first $100 step
  // whose effective marginal rate would exceed the strategy's own
  // bracket ceiling rate (see fillConversion). Only meaningful
  // with a bracket ceiling — the target IS that bracket's rate.
  guardrail?: boolean;
  // bunching: in ACA-active years inside the window, alternate —
  // convert on even ACA years (ignoring the ACA cliff cap, which
  // bunching candidates never carry) and convert $0 on odd ACA
  // years, preserving that year's premium credit in full. Years
  // with nobody on the marketplace fill normally.
  bunching?: boolean;
  // gainsHarvest: deliberate tax-gain harvesting in the taxable
  // account. When on, AFTER each year's draws and conversions
  // have settled, the engine sells and immediately rebuys
  // taxable holdings to realize gains up to the year's REMAINING
  // 0% long-term-capital-gains space, stepping the taxable
  // basis up by the harvested amount so those gains are never
  // taxed later. The harvest takes only leftover space — it
  // never creates space and never displaces a draw or a
  // conversion — and it respects every ceiling the strategy
  // carries (harvested gains are MAGI: the ACA cliff when the
  // cliff cap is on, the IRMAA tier cap and custom MAGI cap on
  // MAGI, the bracket / 0%-gains caps on taxable income), never
  // exceeding the taxable balance or the available unrealized
  // gain (balance − basis dollars; see the basis ledger in
  // simulateRothPlan). Absent / false = off, and the plan
  // prices bit-identically to before.
  gainsHarvest?: boolean;
};

export const ROTH_COMPARE_STRATEGIES: RothStrategy[] = [
  { id: "none", name: "Do Nothing", ceilings: null },
  {
    id: "fill12",
    name: "Fill 12%",
    ceilings: { ...NO_CEILINGS, bracketTopPct: 12 },
  },
  {
    id: "fill22",
    name: "Fill 22%",
    ceilings: { ...NO_CEILINGS, bracketTopPct: 22 },
  },
  {
    id: "fill22-irmaa1",
    name: "Fill 22% capped at IRMAA Tier 1",
    ceilings: { ...NO_CEILINGS, bracketTopPct: 22, irmaaTierCap: 1 },
  },
  {
    id: "fill-aca",
    name: "Fill capped at ACA cliff",
    ceilings: { ...NO_CEILINGS, acaCliffCap: true },
  },
];

export type RothYearWarning = {
  kind: "irmaa" | "aca" | "torpedo" | "college";
  text: string;
};

export type RothFillCap = {
  kind: "bracket" | "ltcgZero" | "irmaa" | "magi" | "acaCliff" | "preserve";
  label: string;
  cap: number;
  // The final priced figure measured against this cap (taxable
  // income for bracket / 0%-gains caps, MAGI for IRMAA / custom
  // caps, ACA MAGI for the cliff).
  actual: number;
  room: number;
  // True when the next $100 conversion step would cross this cap
  // — i.e. this cap is what stopped the fill.
  bound: boolean;
};

export type RothYearDetail = {
  // Income pieces (all engine-priced for the settled year).
  priorPretaxBalance: number; // Dec 31 balance the RMD divides
  rmdDivisor: number | null;
  rmdTable: "joint" | "uniform" | null;
  // Per-spouse RMD split (Part 1 / Part 2): each spouse's own
  // prior Dec 31 balance, divisor, table, and RMD. In a combined
  // (survivor) year the whole RMD sits on the survivor's side.
  priorPretaxPrimary: number;
  priorPretaxSpouse: number;
  rmdPrimary: number;
  rmdSpouse: number;
  rmdDivisorPrimary: number | null;
  rmdDivisorSpouse: number | null;
  rmdTablePrimary: "joint" | "uniform" | null;
  rmdTableSpouse: "joint" | "uniform" | null;
  // The filing status this year was actually priced under —
  // the plan's own status, or "single" after the death year of
  // an enabled survivor scenario.
  filingStatus: FilingStatus;
  isDeathYear: boolean;
  isSurvivorYear: boolean; // priced as the survivor alone (year > death year)
  otherOrdinary: number;
  extraPreTaxDraw: number;
  ltcg: number;
  // Taxable yield income priced this year (TAXABLE YIELDS):
  // the dividend yield × the year's starting taxable balance,
  // priced on the gains stack, and the interest yield × the
  // same balance, priced on the ordinary stack. Display lines
  // like everything in this detail — the priced totals above
  // already include them (in agi / magi / acaMagi and in the
  // tax stacks: the dividends inside gainsInTaxableIncome and
  // its 0 / 15 / 20 split, the interest inside
  // ordinaryTaxableIncome).
  dividendIncome: number;
  interestIncome: number;
  // Spend-from-cash (display only, like everything in this
  // detail): the part of the year's spending need the cash
  // sleeve paid, and the sleeve's balance at year end ($0 in
  // every year unless the plan sets spendFromCashPct; in
  // tiers mode the year-end figure is the cash tier's own
  // balance, so the two ledgers agree to the cent).
  cashSpend: number;
  cashSleeveEnd: number;
  // Flexible spending (display only, like everything in this
  // detail): the year's UNCUT spending need (annualSpending
  // from the retirement-age year on, $0 before it) and the
  // amount the guardrail cut from it this year ($0 in every
  // year flex is off or untriggered). funding.spending stays
  // the EFFECTIVE (post-cut) need; spendingBase − flexCut is
  // that same effective need.
  spendingBase: number;
  flexCut: number;
  // Gain harvesting (display only, like everything in this
  // detail): the gain the year's harvest realized into the 0%
  // space after settlement ($0 unless the strategy harvests),
  // and the taxable basis-dollars ledger at year end — after
  // the year's draws reduced it pro-rata and the harvest
  // stepped it up; basis dollars never grow.
  gainsHarvested: number;
  taxableBasisDollars: number;
  // BASIS-DRIFT surfacing (display only): the year's realized
  // gain from ORDINARY draws alone — tax payments taken from
  // Taxable plus spending draws, priced pro-rata at the basis
  // ratio in force as they left (the settlement's
  // realizedGains; excludes any injected sale gain and any
  // harvested gain, which are separate lines above / in ltcg).
  drawGains: number;
  taxExemptInterest: number;
  provisionalIncome: number;
  ssTaxable: number;
  agi: number;
  // Deductions → taxable income.
  baseStandardDeduction: number;
  age65AddonTotal: number;
  count65: number;
  standardDeduction: number;
  seniorDeduction: number;
  deductions: number;
  // Tax stack.
  ordinaryTaxableIncome: number;
  gainsInTaxableIncome: number;
  bracketLayers: BracketLayer[];
  gainsAt0: number;
  gainsAt15: number;
  gainsAt20: number;
  ordinaryTax: number;
  ltcgTax: number;
  niit: number;
  stateTax: number;
  // The fill decision.
  fill: {
    inWindow: boolean;
    windowStartAge: number;
    windowStopAge: number;
    // "converted" when the strategy converted this year;
    // otherwise the engine's reason there was no conversion.
    outcome:
      | "converted"
      | "outside-window"
      | "no-ceilings"
      | "pretax-empty"
      | "bunching-off-year"
      | "era-cliff-off"
      | "aca-inactive-only-ceiling"
      | "no-room-under-ceilings"
      | "reserve-floor"
      | "already-converted-only";
    boundLabel: string | null; // what stopped the fill, when it stopped at something
    caps: RothFillCap[];
  };
  // IRMAA both directions: what this year's MAGI sets, and what
  // set this year's payment.
  irmaa: {
    tierSet: number;
    premiumYear: number; // year + 2
    paidTier: number | null;
    paidSourceYear: number | null;
    paidSourceMagi: number | null;
    personsOnMedicare: number;
  };
  // ACA for the year (priced figures only when `priced`).
  aca: {
    active: boolean;
    priced: boolean;
    householdSize: number;
    benchmark: number | null;
    fpl: number | null;
    cliff: number | null;
    pctFpl: number | null;
    applicablePct: number | null;
    overCliff: boolean;
  };
};

/* Year-funding ledger (YEAR FUNDING build): the settled year's
   cash needs and the flows that funded them, captured from the
   settlement internals themselves (settleYear's own amounts and
   debit splits — never re-derived outside the engine). All
   figures are DOLLARS, like every figure on RothYear.
   NEEDS: spending (the year's spending need — annualSpending
   from the retirement-age year on, $0 before it), federalTax
   (the year's final federal tax PLUS any pre-59½ withholding
   penalty — the penalty is paid to the IRS as part of the
   federal withholding and has no separate need column),
   stateTax, irmaa (premiums paid this year).
   SOURCES are APPLIED amounts under one stated attribution
   waterfall, so the sources sum to the needs (the cash
   identity) by construction — with two explicit reconciling
   lines when the year's balances run out: spendShortfall
   (unfunded spending) and unpaidTax (the part of the tax
   bill no balance could pay), so sources + spendShortfall +
   unpaidTax = needs in every year:
     1. Cash income — Social Security, the RMD, other ordinary
        income, in that order — applied first (the engine's
        cashIn pool: income covers spending first, the surplus
        covers tax via taxFromCash). Income beyond the year's
        needs is saved into Taxable by the engine and is NOT a
        source here, so an applied amount never exceeds what
        that income actually paid for.
     2. Taxable yield income — interest, then dividends —
        applied next. Yield cash is reinvested in the engine's
        balance mechanics (it raises the basis ledger, never
        the balance), so its application is taken against the
        year's taxable sales, spending sales first, then tax
        sales, then the pre-tax draw, then the Roth draw: the
        taxableSold* fields below are therefore NET of the
        yield cash applied to them, while their GROSS split
        (spending vs tax) is the settlement's own — the
        spending draw the draw-order loop made, and the tax
        channel's sales (the payTaxFrom channel respecting the
        protect-minimum, plus the taxable shares of the unpaid-
        tax debits and the settlement / harvest reprice deltas).
     3. Account draws for what remains: cashSpend (the year's
        spend-from-cash share — the pool's cash sleeve paying
        part of the spending need first, at 100% basis with no
        gain realized; $0 unless the plan sets
        spendFromCashPct), pretaxDraw (the year's
        extra pre-tax spending draw plus every pre-tax amount
        applied to the tax bill — conversion withholding
        including the penalty gross-up, and pre-tax debits),
        taxableSoldForSpending / taxableSoldForTax (net, above),
        rothDraw (the Roth spending draw plus Roth debits
        applied to the tax bill).
   salarySurplus is $0 in this engine: plan pricing has no
   salary flow (work years are priced by the separate
   work-years model), so there is never salary surplus to
   apply. conversion is the year's total priced conversion —
   shown for the deep view only; a conversion is a transfer
   between buckets, not a funding source (the tax it creates
   sits inside the year's tax needs, and any amount withheld
   from it for that tax is inside pretaxDraw). harvestSold is
   the gain the year's harvest realized by selling and
   immediately rebuying — proceeds reinvested, no cash leaves,
   neither a source nor a need. */
export type RothYearFunding = {
  spending: number;
  federalTax: number;
  stateTax: number;
  irmaa: number;
  ss: number;
  rmd: number;
  otherIncome: number;
  interestYield: number;
  dividendYield: number;
  pretaxDraw: number;
  taxableSoldForSpending: number;
  taxableSoldForTax: number;
  // Spend-from-cash: the part of the year's spending need the
  // cash sleeve paid (an eleventh funding source; see the
  // RothPlanInputs note). It is NOT part of
  // taxableSoldForSpending — that field stays the gain-priced
  // Taxable sales for spending — the cash share sold nothing
  // and realized no gain.
  cashSpend: number;
  rothDraw: number;
  salarySurplus: number;
  conversion: number;
  harvestSold: number;
  // UNPAID TAX (round-5 fix 1): the part of the year's priced
  // tax bill (federal + state + penalty + IRMAA, as settled)
  // that no balance could pay — the debit chain (Taxable →
  // Pre-tax → Roth) ran out of money with a remainder still
  // owed. It is NOT a source and NOT a need: the needs above
  // carry the full assessed tax, the sources carry only what
  // was actually applied, and this line reconciles them:
  // sources + spendShortfall + unpaidTax = needs. $0 in every
  // year whose balances cover the bill. Before this field
  // existed the remainder was silently discarded and the
  // year's funding appeared complete.
  unpaidTax: number;
  // SPEND SHORTFALL (FIX 3): the year's unfunded spending —
  // the spending need left over after cash income, the tax
  // channels' prior claim on balances, the spend-from-cash
  // sleeve, and the draw-order draws, measured on the final
  // (kept) settlement: spendNeed minus everything the
  // settlement actually applied to spending. Spending only:
  // a tax bill the balances could not pay is a different
  // quantity and is NOT in this figure. $0 whenever the
  // year's spending is fully funded. It is not a source —
  // the sources above carry only amounts actually applied.
  spendShortfall: number;
};

export type RothYear = {
  year: number;
  agePrimary: number;
  ageSpouse: number | null;
  conversion: number; // total conversion income priced this year
  // Year 1 only: the part of `conversion` the user had already
  // converted before the plan ran. It is priced as income but
  // does NOT move between buckets (starting balances already
  // reflect it); conversion − conversionAlready is what moved.
  conversionAlready: number;
  rmd: number;
  ssBenefits: number;
  // Gain harvested into the 0% capital-gains space after the
  // year's draws and conversions settled (the strategy's
  // gainsHarvest toggle); $0 when the toggle is off, the basis
  // is blank, or no 0% space / unrealized gain was left.
  gainsHarvested: number;
  ssPctTaxed: number; // % of benefits taxed (0 when no benefits)
  agi: number;
  magi: number;
  acaMagi: number;
  // Final priced taxable income for the year — exposed so the
  // optimizer's ceiling-respect check (and its fixtures) can
  // verify a settled year against the bracket / 0%-gains caps it
  // was filled under, which are taxable-income caps.
  taxableIncome: number;
  // Whether ACA marketplace pricing was in scope this year (at
  // or after the retirement year, someone under 65) — the same
  // scope the bunching alternation and the ACA cliff check use.
  acaActive: boolean;
  bracketPct: number;
  federalTax: number;
  stateTax: number;
  penalty: number;
  effectiveMarginalPct: number | null; // on the conversion; null when no conversion
  irmaaTierSet: number;
  irmaaPaid: number;
  acaCreditKept: number;
  acaPriced: boolean;
  // Priced under 138% FPL: at that income, coverage routes to
  // Medicaid rather than a marketplace plan in most states — the
  // priced credit is flagged, not presented as a marketplace
  // result (flag-only; no Medicaid modeling).
  acaUnder138: boolean;
  pretaxEnd: number;
  // Per-spouse pre-tax ending balances (Part 1). Their sum is
  // pretaxEnd. From the year AFTER a death the deceased's side
  // is $0 — the combined balance sits on the survivor's side;
  // in the death year itself each side still ends on its own
  // balance (the deceased's own RMD taken, remainder intact).
  pretaxPrimaryEnd: number;
  pretaxSpouseEnd: number;
  // The filing status priced this year, and the survivor
  // markers: isDeathYear (the death year itself — still MFJ)
  // and isSurvivorYear (after it — Single, survivor alone).
  filingStatus: FilingStatus;
  isDeathYear: boolean;
  isSurvivorYear: boolean;
  rothEnd: number;
  taxableEnd: number;
  hsaEnd: number;
  fiveYearClockYear: number | null;
  warnings: RothYearWarning[];
  // "Show the math" drill-down: the engine's own intermediates
  // for this row (see RothYearDetail). Display only — no total
  // anywhere is derived from it.
  detail: RothYearDetail;
  // Year-funding ledger (see RothYearFunding): the settled
  // year's needs and funding sources, captured from the
  // settlement internals. Display only — no priced total
  // anywhere is derived from it.
  funding: RothYearFunding;
  // SPEND SHORTFALL (FIX 3): the year's unfunded spending in
  // dollars — the spending need left after cash income, the
  // tax channels' prior claim on balances, the spend-from-
  // cash sleeve, and the draw-order draws, measured on the
  // final settlement (the kept round's residual spendDeficit;
  // the same figure as funding.spendShortfall). Spending
  // only — unpaid tax is a different quantity and is not
  // included. $0 whenever the year's spending is fully
  // funded. Display only — no priced total is derived from it.
  spendShortfall: number;
  // UNPAID TAX (round-5 fix 1): the year's priced tax the
  // balances could not pay, in dollars — the remainder of the
  // settlement's debit chain (and of the harvest's own tax
  // delta chain) after Taxable, Pre-tax, and Roth were all
  // exhausted (the same figure as funding.unpaidTax). The
  // assessed tax fields above (federalTax / stateTax /
  // penalty / irmaaPaid) carry the full liability whether or
  // not it was paid; this line is the part that was NOT paid,
  // so no funding or solvency surface has to claim it was.
  // $0 in every year whose balances cover the bill. Display
  // only — no priced total is derived from it.
  unpaidTax: number;
  // SETTLEMENT CONVERGENCE surfacing (LOW-1): whether the
  // year's kept settlement was an exact fixed point of the
  // settlement iteration — the feedback pair it assumed
  // (feedback gains / pre-tax) equals the pair its own debits
  // created — and, when it was not, the kept round's residual
  // mismatch per component in integer cents (both 0 when
  // converged). A non-converged year was priced from the
  // iteration's best iterated state, not an exact fixed
  // point. Observability only — no priced figure is derived
  // from these.
  settlementConverged: boolean;
  settlementMismatchCents: { gains: number; pretax: number };
};

export type RothPlanResult = {
  years: RothYear[];
  lifetimeFederalTax: number;
  lifetimeStateTax: number;
  lifetimePenalty: number;
  lifetimeIrmaa: number;
  lifetimeAcaKept: number;
  // Lifetime UNPAID TAX (round-5 fix 1): the sum of the years'
  // unpaidTax — priced tax no balance could pay. The lifetime
  // tax totals above carry the full assessed liability; this
  // is the part of it that was never actually paid out of the
  // accounts. $0 for any plan whose balances always cover the
  // bill. Display only — no score or ranking uses it.
  lifetimeUnpaidTax: number;
  // Lifetime Social Security collected: the sum of the
  // benefits actually paid year by year (each year's
  // ssBenefits — primary + spouse while both are alive, only
  // the larger continuing benefit in survivor years), on the
  // same nominal basis as the other lifetime totals above.
  // Display only — no score or ranking uses it.
  lifetimeSsCollected: number;
  endingPretax: number;
  endingRoth: number;
  endingTaxable: number;
  endingHsa: number;
  endingAfterTaxWealth: number;
};

// Flexible spending (guardrail): the year's effective
// spending need, given the PRIOR simulated year's applied
// return. Pure — exported so the accuracy fixtures can pin it
// directly.
// · flexCutPct absent / null / ≤ 0 → OFF: return baseSpending
//   verbatim, for every other argument.
// · priorYearReturnPct null (no prior simulated year) →
//   baseSpending: the first simulated year is never cut.
// · priorYearReturnPct ≥ 0 → baseSpending: a flat or positive
//   year does not trigger (0% exactly is not a bad year).
// · priorYearReturnPct < 0 (strictly) → the year is cut: the
//   effective cut is min(flexCutPct, 100 − floor) with
//   floor = flexFloorPct ?? 80; if that cut is ≤ 0 (floor ≥
//   100) return baseSpending, else return
//   baseSpending × (1 − cut / 100) — always computed from the
//   BASE need, never from a prior year's cut need, so
//   consecutive down years produce the same single cut and
//   never a deeper one, and spending restores to full in the
//   first year after a non-negative year.
export function flexSpendingNeed(
  baseSpending: number,
  priorYearReturnPct: number | null,
  flexCutPct?: number | null,
  flexFloorPct?: number | null,
): number {
  if (flexCutPct == null || flexCutPct <= 0) return baseSpending;
  if (priorYearReturnPct == null) return baseSpending;
  if (priorYearReturnPct >= 0) return baseSpending;
  const floor = flexFloorPct ?? 80;
  const cut = Math.min(flexCutPct, 100 - floor);
  if (cut <= 0) return baseSpending;
  return baseSpending * (1 - cut / 100);
}

/* The engine's effective starting spend-from-cash sleeve, in
   dollars (R4-3, finding F7). ONE derivation, TWO callers:
   simulateRothPlan prices with it, and the compute
   effectiveInputs echoes (actions.ts) report it — so the echoed
   sleeve is the priced sleeve BY CONSTRUCTION, in every mode:
   tiers-derived, pool-capped, or $0 when spendFromCashPct is
   blank / 0. The tiers branch recomputes the cash tier's
   balance from the same share normalization the tier-state
   construction applies (max(0, sharePct) over the share total
   × taxableStart) rather than reading built tier state, so the
   echo path needs no simulation run. The drift guard is that
   the engine itself calls this helper for its own sleeve — a
   future normalization edit changes it in the one place both
   consumers use for the sleeve (the tier-state construction
   for sales is a separate consumer, pinned by its own
   fixtures). The cash tier is the FIRST tier whose clamped
   basis pct is ≥ 100 (the engine's cashTierClaimed
   discipline), and the tiers branch applies only under the
   engine's own tiersActive condition — basis not blank AND a
   non-empty tier list: with a blank basis the engine builds no
   tier state and the single-pool formula prices, so the
   helper does too. Arithmetic order matches the engine's
   original inline code exactly: share first, then
   taxableStart × share. */
export function deriveSpendFromCashSleeveStartDollars(
  inputs: RothPlanInputs,
): number {
  const pctRaw = inputs.spendFromCashPct ?? null;
  const pct = pctRaw == null ? 0 : Math.min(100, Math.max(0, pctRaw));
  if (pct <= 0) return 0;
  const tiersActive =
    inputs.taxableBasisBlank !== true &&
    Array.isArray(inputs.taxableTiers) &&
    inputs.taxableTiers.length > 0;
  if (tiersActive) {
    const rawTiers = inputs.taxableTiers as TaxableTier[];
    const shareTotal = rawTiers.reduce(
      (s, t) => s + Math.max(0, t.sharePct),
      0,
    );
    for (const t of rawTiers) {
      const basisPctClampedTier = Math.min(100, Math.max(0, t.basisPct));
      if (basisPctClampedTier >= 100) {
        const share =
          shareTotal > 0 ? Math.max(0, t.sharePct) / shareTotal : 0;
        return Math.max(0, inputs.taxableStart * share);
      }
    }
    return 0;
  }
  return Math.min(
    Math.max(0, inputs.spendFromCashSleeveStart ?? 0),
    Math.max(0, inputs.taxableStart),
  );
}

export function simulateRothPlan(
  inputs: RothPlanInputs,
  strategy: RothStrategy,
  // Optional per-year real-return series (percents), indexed by
  // year − inputs.startYear — the market-uncertainty check's
  // varied return paths. When the series has a value for a year,
  // that year's end-of-year growth uses it (factor = 1 + pct/100,
  // floored at 0 — a −100% year wipes a balance, worse is
  // impossible); when the series is absent or has no value for
  // the year, growth is exactly the constant expected-return
  // expression, so a run with no series is bit-identical to the
  // pre-series engine.
  returnSeriesPct?: readonly number[],
  // Optimizer-internal pricing passes leanDetail: the per-year
  // warning texts and the fill-cap assembly (including its extra
  // "next step" pricing) are display-only — nothing there feeds
  // any total — and the exhaustive search prices thousands of
  // candidates whose year rows are never displayed (a surfaced
  // winner is always re-priced through the full path for its
  // year table). Lean rows carry empty warnings and no fill
  // caps or bound label; every number is identical.
  opts?: {
    leanDetail?: boolean;
    // Plan-year detail seam (engine-access build): when set to a
    // calendar year, that ONE year's conversion is forced to $0 —
    // the fill is skipped and even the already-converted amount
    // prices as $0 — while every other year prices exactly as
    // usual. The with/without two-pricing behind the plan-year
    // detail action (and its fixtures) is the plain run versus
    // this run, so the decomposition is engine output, never a
    // derivation. Absent / null = no forcing, and the run is
    // bit-identical to before.
    forceZeroConversionYear?: number | null;
  },
): RothPlanResult {
  const leanDetail = opts?.leanDetail === true;
  const years: RothYear[] = [];
  // Per-spouse pre-tax balances. `pretax` in the old engine is
  // now pretaxP + pretaxS everywhere a household total is
  // needed; with the spouse's balance $0 and the survivor
  // scenario off, every figure is the old engine's, exactly.
  let pretaxP = inputs.pretaxStart;
  let pretaxS = inputs.pretaxSpouseStart ?? 0;
  // Survivor scenario state: the two balances combine on the
  // survivor's side only once the death year has PASSED (the
  // deceased's side goes to $0 and stays there). Through the
  // death year itself the balances stay separate, so the
  // deceased's own final RMD is still taken that year — from
  // their own balance, on their own clock and table, exactly
  // as if they had lived it (see the RMD step below).
  const survOn =
    inputs.survivorEnabled === true && inputs.survivorDeathYear != null;
  const survWho = inputs.survivorWho ?? "primary";
  const survDeathYear = survOn ? (inputs.survivorDeathYear as number) : null;
  let survCombined = false;
  let roth = inputs.rothStart;
  let taxable = inputs.taxableStart;
  let hsa = inputs.hsaStart;
  const magiByYear = new Map<number, number>();
  // RETURN FLOOR (round-5 fix 3): the deterministic factor is
  // floored at 0 exactly like the return-series factor below
  // (a −100% year wipes a balance; worse is impossible). Before
  // this floor, an expectedReturnPct below −100 produced a
  // NEGATIVE factor and the settlement grew balances below
  // zero with no shortfall marker — the series path already
  // floored, so the two paths disagreed on the same event.
  // The floor is a no-op for every return above −100.
  const growth = Math.max(0, 1 + inputs.expectedReturnPct / 100);
  const gainPct = Math.min(100, Math.max(0, 100 - inputs.taxableBasisPct)) / 100;
  // BASIS-DRIFT (entered basis % only): the taxable account
  // carries a basis-DOLLARS ledger alongside its balance, and
  // ordinary draws price their gains off the ledger's CURRENT
  // ratio (basis $ ÷ balance) instead of the flat starting %.
  // The ledger starts at taxableBasisPct% of the starting
  // taxable balance; it NEVER grows with returns (balance
  // growth adds nothing); every outflow from Taxable reduces
  // it pro-rata at the ratio then in force; every inflow of
  // after-tax money (the surplus sweep, a settlement credit)
  // raises it dollar-for-dollar; harvesting adds the harvested
  // gain. Invariants: 0 ≤ basis $ ≤ balance at every step, and
  // the basis share rises only via inflows or harvests — so
  // year-1 draws price exactly as the flat-% model did (the
  // starting ratio IS the entered %), and divergence emerges
  // only as growth and draws move the ratio. Gains harvesting
  // composes on this same ledger: its available unrealized
  // gain is balance − basis dollars at settlement end.
  // BLANK basis (taxableBasisBlank): drift is OFF and every
  // figure takes the pre-drift code path bit-identically —
  // draws price at the flat gainPct above (0 in practice: the
  // record layer maps blank to 100) and the ledger keeps its
  // legacy harvest-only update below.
  const driftOn = inputs.taxableBasisBlank !== true;
  const harvestOn =
    strategy.gainsHarvest === true && inputs.taxableBasisBlank !== true;
  // The spouse's marketplace / Medicare boundary age: her ACA
  // pricing runs while her age is under this age, and her
  // Medicare / IRMAA premium count starts at it. Absent / null
  // input = 65 — the pre-field boundary, bit-identical.
  const spouseAcaEndAge = inputs.acaSpouseEndAge ?? 65;
  const basisPctClamped = Math.min(100, Math.max(0, inputs.taxableBasisPct)) / 100;
  let taxableBasisDollars = basisPctClamped * inputs.taxableStart;
  // BASIS TIERS: when the plan carries tiers (and an entered
  // basis — the record layer never pairs tiers with a blank
  // basis), the single basis ledger above becomes a per-tier
  // ledger and the scalar follows as its total. Starting basis
  // dollars per tier = pool × share% × basis%; every tier then
  // drifts through the same machinery the pool used (balances
  // grow, basis dollars do not). Shares are normalized to sum
  // to the whole pool (writer data already sums to 100, so the
  // normalization is float dust there). A single tier at the
  // plan's basis % reproduces the single pool to the cent: its
  // one ratio IS the pool ratio at every step.
  const tiersActive =
    driftOn &&
    Array.isArray(inputs.taxableTiers) &&
    inputs.taxableTiers.length > 0;
  let tierState: TierLedger[] | null = null;
  if (tiersActive) {
    const rawTiers = inputs.taxableTiers as TaxableTier[];
    const shareTotal = rawTiers.reduce(
      (s, t) => s + Math.max(0, t.sharePct),
      0,
    );
    let cashTierClaimed = false;
    tierState = rawTiers.map((t) => {
      const share =
        shareTotal > 0 ? Math.max(0, t.sharePct) / shareTotal : 0;
      const bal = inputs.taxableStart * share;
      const basisPctClampedTier = Math.min(100, Math.max(0, t.basisPct));
      const basis = bal * (basisPctClampedTier / 100);
      // The cash tier (spend-from-cash): the FIRST tier at a
      // 100% basis — the lot that splits the pool's cash out.
      const cash = !cashTierClaimed && basisPctClampedTier >= 100;
      if (cash) cashTierClaimed = true;
      return { bal, basis, inflow: false, cash };
    });
    taxableBasisDollars = tierState.reduce((s, t) => s + t.basis, 0);
  }

  // SPEND-FROM-CASH sleeve state (see the RothPlanInputs note
  // and THE SLEEVE INVARIANT there): the dollars of the pool
  // that are cash, tracked as an accounting sub-ledger of the
  // pool like the basis tiers. Off (pct blank / 0) the sleeve
  // is $0 and every figure takes the pre-build path exactly.
  // With tiers the sleeve IS the cash tier's balance; in the
  // single pool it starts at the threaded sleeve size, capped
  // at the pool it describes. The starting value comes from
  // deriveSpendFromCashSleeveStartDollars — the single
  // derivation the compute effectiveInputs echoes also use
  // (R4-3, F7), so the echoed sleeve is the priced sleeve by
  // construction.
  const spendCashPctRaw = inputs.spendFromCashPct ?? null;
  const spendCashPct =
    spendCashPctRaw == null
      ? 0
      : Math.min(100, Math.max(0, spendCashPctRaw));
  const cashTierIndex =
    tierState != null ? tierState.findIndex((t) => t.cash === true) : -1;
  let sleeveDollars = deriveSpendFromCashSleeveStartDollars(inputs);

  let lifetimeFederalTax = 0;
  let lifetimeStateTax = 0;
  let lifetimePenalty = 0;
  let lifetimeIrmaa = 0;
  let lifetimeAcaKept = 0;
  let lifetimeSsCollected = 0;
  let lifetimeUnpaidTax = 0;
  // Gift what-if outflow state (see the input fields): applied
  // exactly once, in the first simulated year at or past the
  // gift age. Never set on a main run, so no main figure moves.
  let giftOutflowApplied = false;
  // Bunching alternation counter: counts ACA-active years inside
  // the conversion window, in order — even counts are conversion
  // years, odd counts are $0 years. Only advances for a bunching
  // strategy; with bunching off it is never read.
  let acaBunchCounter = 0;
  // Flexible spending: the applied return pct of the prior
  // simulated year (the series value when a series supplied
  // one, else the plan's expectedReturnPct) — the trigger the
  // next year's spending need reads. Null before the first
  // simulated year, which is therefore never cut. Updated at
  // the growth step of every simulated year, retired or not,
  // so the first retirement year's trigger reads the last
  // pre-retirement year's return.
  let priorYearReturnPct: number | null = null;

  for (
    let year = inputs.startYear;
    year - inputs.birthYearPrimary <= inputs.endAgePrimary;
    year++
  ) {
    const age = year - inputs.birthYearPrimary;
    const spouseAge =
      inputs.birthYearSpouse != null ? year - inputs.birthYearSpouse : null;
    // This year's effective spending draw order (the draw-order
    // switch: the after-order from the switch age onward; the
    // base order at every age when the switch is blank).
    const yearDrawOrder = effectiveDrawOrder(inputs, age);

    // Survivor state for the year. The death year itself still
    // files jointly, receives both benefits, and takes EACH
    // spouse's own RMD on their own balance, clock, and table —
    // exactly as if both had lived the year, so a spouse who
    // dies past their RMD age still takes their final RMD.
    // From the NEXT year the survivor prices alone as a single
    // filer, and only the balances REMAINING after the death
    // year combine on the survivor's side.
    const isDeathYear = survOn && year === survDeathYear;
    const isSurvivorYear = survOn && survDeathYear != null && year > survDeathYear;
    if (survOn && survDeathYear != null && year > survDeathYear && !survCombined) {
      if (survWho === "primary") {
        pretaxS += pretaxP;
        pretaxP = 0;
      } else {
        pretaxP += pretaxS;
        pretaxS = 0;
      }
      survCombined = true;
    }
    const effFilingStatus: FilingStatus = isSurvivorYear
      ? "single"
      : inputs.filingStatus;
    // The survivor's own age / birth year (the spouse when the
    // primary dies, the primary when the spouse dies).
    const survivorAge = survWho === "primary" ? spouseAge : age;
    const survivorBirthYear =
      survWho === "primary" ? inputs.birthYearSpouse : inputs.birthYearPrimary;
    // Ages the year's tax pricing runs on: after the death year
    // the filer IS the survivor, alone — their age drives the
    // 65+ counts and deductions, with no spouse on the return.
    const priceAgePrimary = isSurvivorYear ? (survivorAge ?? age) : age;
    const priceAgeSpouse = isSurvivorYear ? null : spouseAge;

    // 1. RMDs from the prior Dec 31 pre-tax balances — per
    // spouse, each on their own clock. The primary keeps the
    // Joint Life table while both spouses are alive (spouse
    // sole beneficiary, more than 10 years younger); the
    // spouse's own RMDs always use the Uniform table. In a
    // combined (survivor) year the whole RMD runs on the
    // survivor's clock and the Uniform table. The death year
    // is NOT combined — it takes the per-spouse branch below,
    // so the deceased's final RMD is figured exactly as if
    // they had lived the year.
    const priorP = pretaxP;
    const priorS = pretaxS;
    const priorPretaxBalance = priorP + priorS;
    let rmdP = 0;
    let rmdS = 0;
    let divisorP: number | null = null;
    let divisorS: number | null = null;
    let tableP: "joint" | "uniform" | null = null;
    let tableS: "joint" | "uniform" | null = null;
    if (survCombined) {
      const combinedPrior = survWho === "primary" ? priorS : priorP;
      const u =
        survivorAge != null && survivorBirthYear != null
          ? uniformRmdFor({
              priorDec31PreTax: combinedPrior,
              age: survivorAge,
              birthYear: survivorBirthYear,
            })
          : { rmd: 0, divisor: null };
      if (survWho === "primary") {
        rmdS = u.rmd;
        divisorS = u.divisor;
        tableS = u.divisor != null ? "uniform" : null;
      } else {
        rmdP = u.rmd;
        divisorP = u.divisor;
        tableP = u.divisor != null ? "uniform" : null;
      }
    } else {
      const rp = rmdForYear({
        priorDec31PreTax: priorP,
        agePrimary: age,
        ageSpouse: spouseAge,
        birthYearPrimary: inputs.birthYearPrimary,
        spouseSoleBeneficiary: inputs.spouseSoleBeneficiary,
      });
      rmdP = rp.rmd;
      divisorP = rp.divisor;
      tableP = rp.table;
      if (spouseAge != null && inputs.birthYearSpouse != null) {
        const rs = uniformRmdFor({
          priorDec31PreTax: priorS,
          age: spouseAge,
          birthYear: inputs.birthYearSpouse,
        });
        rmdS = rs.rmd;
        divisorS = rs.divisor;
        tableS = rs.divisor != null ? "uniform" : null;
      }
    }
    const rmd = r2(rmdP + rmdS);
    const rmdDivisor = divisorP ?? divisorS;
    const rmdTable = tableP ?? tableS;
    const pretaxPAfterRmd = Math.max(0, pretaxP - rmdP);
    const pretaxSAfterRmd = Math.max(0, pretaxS - rmdS);
    const pretaxAfterRmd = pretaxPAfterRmd + pretaxSAfterRmd;

    // Social Security received this year (per-spouse claim ages).
    // Through the death year both benefits price as entered;
    // from the next year the survivor keeps only the LARGER of
    // the two benefits, at its already-modeled claim-age amount
    // (each side counted once its own claim age is reached, the
    // deceased's side by the age they would have been).
    const ssPrimaryThisYear =
      inputs.ssPrimaryStartAge != null && age >= inputs.ssPrimaryStartAge
        ? effectiveSsPrimaryAnnual(inputs)
        : 0;
    const ssSpouseThisYear =
      inputs.ssSpouseStartAge != null &&
      spouseAge != null &&
      spouseAge >= inputs.ssSpouseStartAge
        ? effectiveSsSpouseAnnual(inputs)
        : 0;
    const ssBenefits = isSurvivorYear
      ? Math.max(ssPrimaryThisYear, ssSpouseThisYear)
      : ssPrimaryThisYear + ssSpouseThisYear;

    // ACA state for the year: ACA pricing is active only from
    // the retirement-age year onward, while anyone in the
    // household is on the marketplace (his years to 65, hers to
    // the spouse ACA end age — 65 unless the plan sets one —
    // filing jointly: household MAGI sets the credit throughout).
    // Pre-retirement years are not marketplace years, so no
    // credit, cliff cap, under-138 flag, or not-priced counting
    // applies to them — one consistent scope everywhere. After
    // a death, only the survivor counts, alone, at household
    // size 1.
    const retirementYear = inputs.birthYearPrimary + inputs.retirementAge;
    const inAcaScope = year >= retirementYear;
    const primaryOnAca = inAcaScope && age < 65 && !(isSurvivorYear && survWho === "primary");
    const spouseOnAca =
      inAcaScope && spouseAge != null && spouseAge < spouseAcaEndAge && !(isSurvivorYear && survWho === "spouse");
    const acaActive = primaryOnAca || spouseOnAca;
    const householdSize = isSurvivorYear
      ? 1
      : inputs.acaStepDownYear != null && year >= inputs.acaStepDownYear
        ? inputs.acaHouseholdSizeAfter
        : inputs.acaHouseholdSize;
    // Benchmark selection keys on WHO is on the marketplace
    // that year, not on household size alone: the FAMILY
    // benchmark applies only when BOTH spouses are on ACA in
    // a household of 3 or more and a family figure is entered;
    // a both-on-ACA year otherwise prices off the couple
    // figure. A year with only ONE spouse on ACA prices off
    // the one-spouse figure regardless of household size (a
    // spouse-only year at household size 5 is not a family
    // marketplace year). Household size still drives the FPL
    // cliff and the applicable percentage. With the family
    // field blank, every year falls back to the figure that
    // priced it before the family field existed, so a blank
    // family field leaves every priced figure bit-identical.
    const benchmark =
      primaryOnAca && spouseOnAca
        ? householdSize >= 3 && inputs.acaBenchmarkFamily != null
          ? inputs.acaBenchmarkFamily
          : inputs.acaBenchmarkCouple
        : acaActive
          ? inputs.acaBenchmarkSingle
          : null;
    const acaCliffDollars = acaActive
      ? 4 * fplFor(householdSize, year - 1)
      : null;

    // 2. Conversion — the strategy's fill decision for the year.
    // In year 1 the amount already converted this calendar year
    // is part of the year's priced conversion income: the fill
    // solves for the ADDITIONAL conversion that tops the year up
    // to the ceiling (additional = max(0, target − already)).
    // Only the additional amount moves between buckets — the
    // already-converted amount is already reflected in the
    // starting balances.
    const forceZeroConversion =
      opts?.forceZeroConversionYear != null &&
      year === opts.forceZeroConversionYear;
    const already =
      year === inputs.startYear && !forceZeroConversion
        ? Math.max(0, inputs.convertedAlreadyThisYear)
        : 0;
    const inWindow = age >= inputs.windowStartAge && age <= inputs.windowStopAge;
    // This year's effective ceilings. Identical to the strategy's
    // ceilings except for a bunching strategy in an ACA-active
    // in-window year: even ACA years convert with the ACA cliff
    // cap stripped (the big year deliberately forfeits the
    // credit), odd ACA years convert $0 (bunchZero). The user's
    // already-converted amount is still priced in a $0 year — it
    // is their conversion, not the strategy's.
    let yearCeilings = strategy.ceilings;
    let bunchZero = false;
    if (strategy.ceilings && strategy.bunching && acaActive && inWindow) {
      if (acaBunchCounter % 2 === 1) {
        bunchZero = true;
      } else {
        yearCeilings = { ...strategy.ceilings, acaCliffCap: false };
      }
      acaBunchCounter++;
    }
    // ERA-AWARE ACA CLIFF CAP (acaCliffCapFamilyOnly): when the
    // strategy carries both the cliff cap and the family-only
    // flag, the cap defends the cliff only in years BEFORE the
    // plan's household step-down year. From that year on, the
    // cliff cap is switched off for the year — no conversion
    // limiting and no pre-tax draw shrinking for the cliff — and
    // every consumer of yearCeilings below (the fill, the capped
    // draw, the ceiling-convergence re-solve, the cliff draw
    // convergence, the harvest limits, the year's cap records)
    // sees the cap as off, so the year prices undefended. The
    // ACA CREDIT is untouched: it reads householdSize (already
    // stepped down from the step-down year) and the final priced
    // ACA MAGI, never this flag. With the flag off, or with no
    // step-down year set, yearCeilings is exactly what it was
    // before this build and the year prices bit-identically.
    // Bunching composes naturally: it may already have stripped
    // the cap for its alternating year, and a bunching $0 year
    // stays $0 — post-step-down years are uncapped regardless
    // of the bunching counter. No survivor special-casing: the
    // gate keys on the step-down year only.
    let eraCliffOff = false;
    if (
      yearCeilings?.acaCliffCap === true &&
      yearCeilings.acaCliffCapFamilyOnly === true &&
      inputs.acaStepDownYear != null &&
      year >= inputs.acaStepDownYear
    ) {
      eraCliffOff = true;
      yearCeilings = { ...yearCeilings, acaCliffCap: false };
    }
    // When the cliff was the year's ONLY ceiling, switching it
    // off leaves no fill target at all. fillConversion reads an
    // all-off ceilings object as "fill without limit", which is
    // NOT what an uncapped year means for a fill strategy — the
    // strategy simply converts nothing that year, draws sized
    // by spending alone — so the fill is skipped outright.
    const eraZeroFill =
      eraCliffOff && yearCeilings != null && !ceilingsActive(yearCeilings);
    // ACA CLIFF SAFETY BUFFER: the target every cliff consumer
    // below aims at — the true cliff less the plan's buffer,
    // floored at 0. Because it derives from yearCeilings (the
    // era-adjusted ceilings), the buffer applies in exactly
    // the years the cliff cap itself applies: before the
    // step-down in a family-only plan, never after it, and
    // never when the cap is off. With the buffer unset it
    // equals acaCliffDollars, so every consumer below prices
    // bit-identically to before. NOT a pricing input: the ACA
    // credit reads the true cliff (acaCliffDollars / the
    // priced year's own acaResult) on actual MAGI, never this.
    const acaTargetDollars =
      acaCliffDollars != null
        ? Math.max(
            0,
            acaCliffDollars -
              (yearCeilings?.acaCliffCap === true
                ? Math.max(0, yearCeilings.acaCliffBuffer ?? 0)
                : 0),
          )
        : null;
    const guardrailTargetPct =
      strategy.guardrail && yearCeilings?.bracketTopPct != null
        ? yearCeilings.bracketTopPct
        : null;
    // Gift what-if outflow (gift comparison runs only): the
    // gifted shares leave the Taxable bucket at the start of
    // the gift year — before any of this year's pricing — so
    // they stop growing for the parents from the gift year
    // onward and fund none of the year's taxes or spending.
    // A gift is not a sale: no gain is realized by the outflow.
    if (
      !giftOutflowApplied &&
      inputs.giftOutflowAge != null &&
      (inputs.giftOutflowAmount ?? 0) > 0 &&
      age >= inputs.giftOutflowAge
    ) {
      // The gifted shares carry their share of the basis
      // dollars out with them (pro-rata, no gain realized —
      // the ratio itself is unchanged by the removal). With
      // basis tiers the removal is pro-rata across every tier
      // alike, so each tier's own ratio is unchanged too.
      if (driftOn && taxable > 0) {
        const removed = taxable - Math.max(0, taxable - (inputs.giftOutflowAmount ?? 0));
        if (tiersActive && tierState) {
          const frac = removed / taxable;
          for (const t of tierState) {
            t.bal -= t.bal * frac;
            t.basis = Math.max(0, t.basis - t.basis * frac);
          }
          taxableBasisDollars = tierState.reduce((s, t) => s + t.basis, 0);
        } else {
          taxableBasisDollars = Math.max(
            0,
            taxableBasisDollars - removed * (taxableBasisDollars / taxable),
          );
        }
      }
      // The gift outflow is a non-spending pool debit: the
      // sleeve shrinks by the cash the removal took (the cash
      // tier's new balance in tiers mode — the tier ledger
      // above already moved; in the single pool the debit is
      // attributed to the non-cash portion first).
      if (spendCashPct > 0 && sleeveDollars > 0) {
        if (tierState != null && cashTierIndex >= 0) {
          sleeveDollars = Math.max(0, tierState[cashTierIndex]!.bal);
        } else if (taxable > 0) {
          const removedGift =
            taxable -
            Math.max(0, taxable - (inputs.giftOutflowAmount ?? 0));
          sleeveDollars = Math.max(
            0,
            sleeveDollars -
              Math.max(0, removedGift - Math.max(0, taxable - sleeveDollars)),
          );
        }
      }
      taxable = Math.max(0, taxable - (inputs.giftOutflowAmount ?? 0));
      giftOutflowApplied = true;
    }
    // TAXABLE YIELDS: this year's dividend and interest income
    // — each yield % × the taxable balance the year opens with
    // (post-gift, when a gift outflow applies). Fixed for the
    // year before any fill or settlement runs: yield income is
    // mandatory income, priced inside every pricing of the year
    // (the fill base, every settlement, the harvest predicate,
    // the marginal reprice), so the year's discretionary income
    // shrinks around it. The yield cash itself is reinvested:
    // the settlement adds it to the basis ledger (see
    // settleYear), and the balance's growth stays the full
    // expected return — the yields are a component of that
    // return, never growth on top of it.
    const divYieldPct = Math.max(0, inputs.taxableDividendYieldPct ?? 0);
    const intYieldPct = Math.max(0, inputs.taxableInterestYieldPct ?? 0);
    const dividendIncome =
      divYieldPct > 0 ? r2((taxable * divYieldPct) / 100) : 0;
    const interestIncome =
      intYieldPct > 0 ? r2((taxable * intYieldPct) / 100) : 0;
    const yieldTotal = dividendIncome + interestIncome;
    // Gift what-if counterfactual sale gain (baseline gift
    // comparison runs only): this year's injected long-term
    // gain, added to every pricing of the year alongside the
    // gains the year's own draws realize.
    const injectedLtcg =
      inputs.saleGainAge != null && age === inputs.saleGainAge
        ? Math.max(0, inputs.saleGainAmount ?? 0)
        : 0;
    // The fill base: the year's non-conversion income, priced
    // with conversion = 0. The convergence loop below re-solves
    // against copies of this base carrying the realized gains /
    // extra pre-tax draw a settlement produced.
    const fillBase: PriceYearInput = {
      calendarYear: year,
      filingStatus: effFilingStatus,
      agePrimary: priceAgePrimary,
      ageSpouse: priceAgeSpouse,
      otherOrdinary: inputs.otherOrdinaryAnnual,
      rmd,
      conversion: 0,
      extraPreTaxDraw: 0,
      ssBenefits,
      taxExemptInterest: inputs.taxExemptInterestAnnual,
      ltcg: injectedLtcg,
      interestIncome,
      qualifiedDividends: dividendIncome,
      inflationPct: inputs.inflationPct,
      stateRatePct: inputs.stateRatePct,
    };
    // The preserve-pre-tax reserve room: how much of the
    // post-RMD combined pre-tax balance may still convert
    // without the post-conversion balance falling below the
    // floor. Infinity when no reserve is set (the pre-reserve
    // behavior, bit for bit).
    const preserveFloor = Math.max(0, inputs.preservePretax ?? 0);
    const preserveRoom =
      preserveFloor > 0 ? Math.max(0, pretaxAfterRmd - preserveFloor) : Infinity;
    let additional = 0;
    if (yearCeilings && inWindow && pretaxAfterRmd > 0 && !bunchZero && !eraZeroFill && !forceZeroConversion) {
      const target = fillConversion({
        base: fillBase,
        ceilings: yearCeilings,
        maxConversion: pretaxAfterRmd + already,
        acaCliff: acaCliffDollars,
        guardrailTargetPct,
      });
      additional = Math.max(
        0,
        Math.min(target - already, pretaxAfterRmd, preserveRoom),
      );
    }
    // Total conversion income priced this year (already + new).
    // Mutable: the convergence loop may shrink `additional` (and
    // therefore the total) until the FINAL settled year respects
    // every switched-on ceiling.
    let conversion = already + additional;

    // IRMAA paid THIS year: set by MAGI two years ago, charged per
    // person on Medicare this year, at this year's law row. After
    // a death only the survivor is charged. The spouse counts as
    // on Medicare from her ACA end age (she is on the marketplace,
    // not Medicare, before it); the primary's own start stays 65.
    // When the survivor IS the spouse (the primary died), her
    // start is that same end age; when the survivor is the
    // primary it stays 65.
    const personsOnMedicare = isSurvivorYear
      ? survivorAge != null &&
        survivorAge >= (survWho === "primary" ? spouseAcaEndAge : 65)
        ? 1
        : 0
      : (age >= 65 ? 1 : 0) +
        (spouseAge != null && spouseAge >= spouseAcaEndAge ? 1 : 0);
    let irmaaPaid = 0;
    let irmaaPaidTier: number | null = null;
    const magiTwoYearsAgo = magiByYear.get(year - 2);
    if (personsOnMedicare > 0 && magiTwoYearsAgo != null) {
      const law = lawForYear(year);
      const tier = irmaaTierFor(
        magiTwoYearsAgo,
        effFilingStatus,
        law,
        year,
        inputs.inflationPct,
      );
      irmaaPaidTier = tier;
      irmaaPaid = r2(irmaaAnnualPerPerson(tier, law) * personsOnMedicare);
    }

    // Price the year at any (gains, extra pre-tax draw,
    // conversion) combination — the settlement's workhorse.
    const priceWith = (ltcg: number, extra: number, conv: number) =>
      priceYear({
        calendarYear: year,
        filingStatus: effFilingStatus,
        agePrimary: priceAgePrimary,
        ageSpouse: priceAgeSpouse,
        otherOrdinary: inputs.otherOrdinaryAnnual,
        rmd,
        conversion: conv,
        extraPreTaxDraw: extra,
        ssBenefits,
        taxExemptInterest: inputs.taxExemptInterestAnnual,
        // The year's own realized gains plus any injected
        // counterfactual sale gain (0 on every non-gift run).
        ltcg: ltcg + injectedLtcg,
        // The year's fixed yield income rides every pricing
        // (see the yield computation above the fill base).
        interestIncome,
        qualifiedDividends: dividendIncome,
        inflationPct: inputs.inflationPct,
        stateRatePct: inputs.stateRatePct,
      });
    // The year's starting basis dollars (post-gift). The
    // settlement below is pure in its argument and re-runs
    // from the year's starting balances, so every candidate
    // settlement's drift mirror starts from this same figure.
    const basisYearStart = taxableBasisDollars;
    // Flexible spending: the year's uncut need and its
    // effective (possibly cut) need, computed ONCE before
    // settlement opens — a year-level constant every
    // candidate settlement of the year prices against, so
    // the settlement fixed-point is untouched (the flex
    // decision feeds nothing back into its own inputs).
    const spendNeedBase = age >= inputs.retirementAge ? inputs.annualSpending : 0;
    const spendNeedYear = flexSpendingNeed(spendNeedBase, priorYearReturnPct, inputs.flexCutPct, inputs.flexFloorPct);
    // Settle one candidate additional conversion from the
    // year's STARTING balances: price the year, pay its tax
    // from the chosen source, draw spending in the year's
    // effective draw order, then re-price with the realized
    // gains / extra pre-tax draw those payments and draws
    // created. Pure in `additionalArg` — the convergence loop
    // below re-runs it from the same starting balances until
    // the FINAL priced figures respect every switched-on
    // ceiling. `pretaxDrawCapArg`, when passed, additionally
    // bounds the pre-tax spending draw (the cliff-cap
    // convergence below re-settles with smaller caps when the
    // settled gains still carry the year over the cliff).
    //
    // SETTLEMENT ITERATION (FIX 1): one round of the settlement
    // (settleRound) takes the income its own TAX-CHANNEL debits
    // create as an input — `fbGainsIn` (realized gains on the
    // Taxable sales that pay tax beyond the priced channels:
    // the reprice-delta sale and the unpaid-tax debits' Taxable
    // leg) and `fbPretaxIn` (the pre-tax debits those same
    // channels take, which are ordinary distributions). Those
    // debits' income cannot be priced by the round that takes
    // them (the tax they pay is computed before they happen),
    // so settleYear below re-runs the round with the income
    // the previous round's debits created fed back into every
    // pricing, until the assumed feedback and the created
    // feedback agree to the cent — the fixed point where the
    // priced income, the tax due, and the debits taken are the
    // same year's. Round 1 assumes $0 feedback and is the
    // pre-fix settlement bit for bit; a year whose tax channels
    // create no unpriced income converges in that one round.
    const settleRound = (
      additionalArg: number,
      pretaxDrawCapArg: number | undefined,
      fbGainsIn: number,
      fbPretaxIn: number,
    ) => {
      const conv = already + additionalArg;
      // BASIS-DRIFT pricing rate for this settlement's draws:
      // the gain share of a dollar drawn from Taxable is
      // 1 − (basis $ ÷ balance) at the year's start. Pro-rata
      // outflows preserve that ratio, so one rate prices every
      // draw the settlement makes; inflows and growth move it
      // only between years. On the legacy (blank-basis) path
      // the rate is the flat gainPct, bit-identically.
      const startRatio = taxable > 0 ? basisYearStart / taxable : 0;
      const drawGainRate = driftOn ? 1 - startRatio : gainPct;
      let priced = priceWith(fbGainsIn, fbPretaxIn, conv);
      let federalTax = priced.federalTax;
      let stateTax = priced.stateTax;

      const spendNeed = spendNeedYear;
      const cashIn = rmd + ssBenefits + inputs.otherOrdinaryAnnual;
      const surplusCash = Math.max(0, cashIn - spendNeed);
      let spendDeficit = Math.max(0, spendNeed - cashIn);

      const taxDue = federalTax + stateTax + irmaaPaid;
      const taxFromCash = Math.min(taxDue, surplusCash);
      let taxRemaining = taxDue - taxFromCash;
      let fromTaxable = 0;
      let withheld = 0;
      if (taxRemaining > 0) {
        if (inputs.payTaxFrom === "taxable") {
          fromTaxable = Math.min(
            taxRemaining,
            Math.max(0, taxable - inputs.protectMinTaxable),
          );
          withheld = taxRemaining - fromTaxable;
        } else {
          withheld = taxRemaining;
        }
      }
    // Pre-59½: tax withheld from a conversion is itself an early
    // distribution — 10% penalty on the withheld amount (the piece
    // Boldin skips; it bites in this household's first window
    // years, retiring at 57). The penalty is itself part of the
    // withheld distribution, so it is grossed up: penalty =
    // 10% × (tax withheld + penalty), i.e. withheld / 9 — but
    // ONLY for the portion of the withheld amount the year's
    // conversion actually absorbs (distributes). Any overflow
    // the conversion cannot absorb is paid by debiting Taxable
    // below the floor → Pre-tax → Roth (a brokerage / account
    // payment, not an early distribution), so it carries tax
    // only, no penalty. When the grossed-up distribution would
    // exceed the conversion itself, the conversion is exhausted:
    // the whole conversion is the distribution, penalty = 10%
    // of it, the tax it pays is the other 90%, and the rest of
    // the tax due overflows penalty-free.
      let penalty = 0;
      let overflowTax = 0;
      let withheldFromConversion = withheld;
      // The early-withholding penalty runs on the conversion
      // OWNER's age: the primary's while both spouses are alive
      // (conversions draw his balance first), the survivor's
      // once the balances are combined.
      const convOwnerAge = survCombined ? (survivorAge ?? age) : age;
      if (withheld > 0 && convOwnerAge < 59.5) {
        const grossedPenalty = r2(withheld / 9);
        const grossedTotal = withheld + grossedPenalty;
        if (grossedTotal <= additionalArg + 0.005) {
          penalty = grossedPenalty;
          withheldFromConversion = grossedTotal;
        } else if (additionalArg > 0) {
          penalty = r2(additionalArg * 0.1);
          withheldFromConversion = additionalArg;
          overflowTax = r2(withheld - (additionalArg - penalty));
        } else {
          withheldFromConversion = 0;
          overflowTax = withheld;
        }
      } else {
        overflowTax = Math.max(0, withheld - additionalArg);
        withheldFromConversion = Math.min(withheld, additionalArg);
      }
      const rothIn = Math.max(0, additionalArg - withheldFromConversion);

      // The conversion leaves the per-spouse balances primary-
      // first, spouse second (the sourcing rule): while both
      // spouses are alive his RMD clock binds first, so his
      // balance converts first; once combined, the whole pool
      // already sits on the survivor's side and the same
      // primary-then-spouse debit order reaches it there.
      let pretaxBalP = pretaxPAfterRmd;
      let pretaxBalS = pretaxSAfterRmd;
      {
        const fromP = Math.min(additionalArg, Math.max(0, pretaxBalP));
        pretaxBalP -= fromP;
        pretaxBalS -= additionalArg - fromP;
      }
      let rothBal = roth + rothIn;
      let taxableBal = taxable - fromTaxable;
      // YEAR FUNDING capture (display only — no priced figure
      // reads these trackers): the settlement's own funding
      // splits, accumulated as the debits below happen. The tax
      // channels start as the settlement computed them: Taxable
      // paid `fromTaxable` toward the tax bill (the payTaxFrom
      // channel, protect-minimum respected) and the conversion
      // withholding (including any penalty gross-up) is
      // pre-tax money applied to the same bill.
      let fundTaxTaxable = fromTaxable;
      let fundTaxPretax = withheldFromConversion;
      let fundTaxRoth = 0;
      let fundSpendTaxable = 0;
      let fundSpendRoth = 0;
      // SETTLEMENT ITERATION: the income THIS round's
      // tax-channel debits create but this round's pricing
      // cannot include (it is computed before they happen) —
      // realized gains on the debits' Taxable sales and the
      // debits' pre-tax amounts. settleYear compares these
      // against the round's assumed feedback (fbGainsIn /
      // fbPretaxIn) and re-runs the round until they agree.
      let createdFbGains = 0;
      let createdFbPretax = 0;

      // BASIS-DRIFT mirror (drift runs only; every helper is a
      // no-op on the legacy path): basisBal tracks the basis
      // dollars through each movement of taxableBal below.
      // basisOut(amount) must be called with the balance still
      // undiminished — it reduces the basis pro-rata at the
      // ratio in force at that moment. basisIn(amount) raises
      // the basis dollar-for-dollar (after-tax money in).
      let basisBal = basisYearStart;
      // BASIS TIERS settlement mirror: this settlement's own
      // copy of the year-start tier ledger (the settlement is
      // pure and re-run, so each candidate works on a fresh
      // copy and only the kept settlement's copy is committed
      // below — probing settlements can never move the ledger).
      // Sales consume the copy HIGHEST basis ratio first.
      // pricedGains accumulates the gains of exactly the
      // channels the single pool prices — the tax payment from
      // Taxable and the spending draws (its taxableDrawn set);
      // the overflow debits and the reprice-delta payment
      // consume tiers by the same order rule, and the gains
      // their sales realize are NOT in pricedGains — they are
      // the round's created feedback (createdFbGains), which
      // the settlement iteration prices on the next round,
      // exactly their single-pool treatment.
      let sTiers: TierLedger[] | null = null;
      let pricedGains = 0;
      if (tiersActive && tierState) {
        sTiers = tierState.map((t) => ({ ...t }));
      }
      // SPEND-FROM-CASH settlement mirror: this settlement's
      // own copy of the year-start sleeve (the settlement is
      // pure and re-run, so each candidate works on its own
      // copy and only the kept settlement's sleeve is committed
      // below — probing settlements can never drain it).
      // sleeveDebit(amount, poolBefore) applies THE SLEEVE
      // INVARIANT's shrink for a NON-cash-spend pool debit of
      // `amount` taken while the pool stood at `poolBefore`:
      // in tiers mode it re-reads the cash tier's balance after
      // the debit's own tier sale (call it after that sale);
      // in the single pool the debit is attributed to the
      // pool's non-cash portion first, so only the part of
      // the debit beyond the non-cash remainder shrinks the
      // sleeve. A cash-spending debit does NOT go
      // through here — it shrinks the sleeve dollar-for-dollar
      // at its own step below.
      let sleeveBal = sleeveDollars;
      let cashSpendAmt = 0;
      const sleeveDebit = (amount: number, poolBefore: number) => {
        if (spendCashPct <= 0 || amount <= 0 || sleeveBal <= 0) return;
        if (sTiers && cashTierIndex >= 0) {
          sleeveBal = Math.max(0, sTiers[cashTierIndex]!.bal);
        } else {
          // Single pool: the debit is attributed to the
          // pool's non-cash portion first (the pool model
          // defines no sale order of its own), so the sleeve
          // shrinks only by the part of the debit that
          // exceeds the non-cash remainder.
          const nonCash = Math.max(0, poolBefore - sleeveBal);
          sleeveBal = Math.max(0, sleeveBal - Math.max(0, amount - nonCash));
        }
      };
      if (driftOn && fromTaxable > 0) {
        if (sTiers) {
          pricedGains += sellFromTiers(sTiers, fromTaxable, "highest");
        } else {
          basisBal = Math.max(0, basisBal - fromTaxable * startRatio);
        }
      }
      // The tax channel's Taxable sale is a pool debit like any
      // other: the sleeve shrinks by the cash it took (the sale
      // above already moved the tiers copy when tiers are on).
      if (fromTaxable > 0) sleeveDebit(fromTaxable, taxable);
      // basisOut returns the gain the sale realizes under the
      // active model — with tiers, the tier sale's own gain;
      // in the single pool, the amount at the year's starting
      // gain rate (the same rate that prices taxableDrawn, so
      // a tax-channel sale is priced exactly like a draw).
      // Priced callers ignore the return; the tax-channel
      // callers (the unpaid-tax debits, the reprice-delta
      // payment) accumulate it as created feedback.
      const basisOut = (amount: number, priced = false): number => {
        if (amount <= 0) return 0;
        // Every pool debit through here also shrinks the cash
        // sleeve (see sleeveDebit): on the legacy path that is
        // the ONLY effect (the basis mirror is drift-only, the
        // sleeve is not); on the tiers path the sleeve re-read
        // must follow the tier sale, so it runs last in each
        // branch. taxableBal is still undiminished at every
        // call site, as the basis mirror itself requires.
        if (!driftOn) {
          sleeveDebit(amount, taxableBal);
          return r2(amount * drawGainRate);
        }
        if (sTiers) {
          const g = sellFromTiers(sTiers, amount, "highest");
          if (priced) pricedGains += g;
          sleeveDebit(amount, taxableBal);
          return g;
        }
        if (taxableBal <= 0) {
          basisBal = 0;
          sleeveDebit(amount, taxableBal);
          return r2(amount * drawGainRate);
        }
        basisBal = Math.max(0, basisBal - amount * (basisBal / taxableBal));
        sleeveDebit(amount, taxableBal);
        return r2(amount * drawGainRate);
      };
      const basisIn = (amount: number) => {
        if (!driftOn || amount <= 0) return;
        if (sTiers) {
          buyIntoTiers(sTiers, amount);
          return;
        }
        basisBal += amount;
      };

      // Every dollar of priced tax must leave some balance. Tax
      // that could not be paid from surplus cash / Taxable above
      // the protect-minimum was "withheld" above; the part of it
      // the year's (additional) conversion cannot absorb is debited
      // from Taxable below the protect-minimum floor, then from
      // Pre-tax, then Roth. UNPAID TAX (round-5 fix 1): when even
      // the Roth leg runs out, a remainder is still owed — the
      // debit returns it and the settlement accumulates it as
      // unpaidTax, reported on the year (funding.unpaidTax /
      // RothYear.unpaidTax) instead of being discarded. Before
      // this fix the remainder vanished here and the year's tax
      // read as fully paid.
      let unpaidTaxAmt = 0;
      const debitUnpaid = (amount: number): number => {
        let rest = amount;
        const fromT = Math.min(rest, Math.max(0, taxableBal));
        // The Taxable leg's sale gains and the pre-tax legs'
        // amounts are income this debit creates: created
        // feedback for the settlement iteration (the Roth leg
        // creates no income).
        createdFbGains += basisOut(fromT);
        taxableBal -= fromT;
        rest -= fromT;
        fundTaxTaxable += fromT;
        const fromP = Math.min(rest, Math.max(0, pretaxBalP));
        pretaxBalP -= fromP;
        rest -= fromP;
        const fromS = Math.min(rest, Math.max(0, pretaxBalS));
        pretaxBalS -= fromS;
        rest -= fromS;
        fundTaxPretax += fromP + fromS;
        createdFbPretax += fromP + fromS;
        if (rest > 0) {
          const fromR = Math.min(rest, Math.max(0, rothBal));
          rothBal = Math.max(0, rothBal - rest);
          fundTaxRoth += fromR;
          rest -= fromR;
        }
        return Math.max(0, rest);
      };
      const unpayable = overflowTax;
      if (unpayable > 0) unpaidTaxAmt += debitUnpaid(unpayable);

      // SPEND-FROM-CASH: the cash sleeve pays its share of the
      // year's spending need FIRST — before the draw order
      // below runs — out of the pool's cash portion. The share
      // is pct% of the year's spending need, bounded by the
      // spending deficit the settlement actually has to fund
      // (cash income — RMD, Social Security, other ordinary —
      // already covers the rest of the need and is not drawn
      // from any account), by the sleeve remaining, and by the
      // pool balance on hand after the tax channel above (tax
      // payments are unchanged and keep their priority and
      // their order). The debit realizes NO gain and creates
      // NO income: in tiers mode it comes straight out of the
      // cash tier (balance and basis down together, the tier
      // being 100% basis); in the single pool the basis ledger
      // drops dollar-for-dollar (cash is 100% basis — the
      // zero-gain treatment) while pricedGains and
      // taxableDrawn, which price the REST of the year's
      // draws, never see it, so those draws keep the pool's
      // normal pro-rata basis behaviour. What it changes is
      // the deficit: the draw order funds only what remains,
      // and every re-settlement (the ceiling convergence, the
      // cliff draw-cap search) re-derives the same share from
      // the same starting sleeve, so the settlements compose.
      if (spendCashPct > 0 && spendDeficit > 0 && sleeveBal > 0) {
        const want = (spendNeed * spendCashPct) / 100;
        let take = Math.min(
          want,
          spendDeficit,
          sleeveBal,
          Math.max(0, taxableBal),
        );
        if (take > 0) {
          if (sTiers && cashTierIndex >= 0) {
            const t = sTiers[cashTierIndex]!;
            take = Math.min(take, Math.max(0, t.bal));
            t.bal -= take;
            t.basis = Math.max(0, t.basis - take);
            sleeveBal = Math.max(0, t.bal);
          } else {
            if (driftOn) basisBal = Math.max(0, basisBal - take);
            sleeveBal = Math.max(0, sleeveBal - take);
          }
          if (take > 0) {
            taxableBal -= take;
            spendDeficit -= take;
            cashSpendAmt = take;
          }
        }
      }

      // Spending draws, in the year's effective draw order
      // (the RMD cash was already counted first, above). A draw
      // from Pre-tax is extra ordinary income for the year
      // (extraDraw, which the reprice below picks up); a draw
      // from Taxable realizes gains on the total amount drawn
      // from it. A pre-tax spending draw debits the primary's
      // balance first, then the spouse's — the same sourcing
      // order as conversions.
      //
      // ACA CLIFF CAP ON PRE-TAX SPENDING DRAWS: in an
      // ACA-active year whose strategy carries the ACA cliff
      // cap, the pre-tax spending draw is ALSO bounded by the
      // cliff — not only the conversion. Within-year precedence
      // for the cliff room (ACA MAGI rises exactly $1 per $1 of
      // conversion, pre-tax draw, or realized gain — the
      // Social Security taxable amount cancels out of ACA MAGI
      // — so the room arithmetic below is exact):
      //   1. Non-draw income first: other ordinary income,
      //      the year's taxable yield income (dividends and
      //      interest — mandatory, priced inside priceWith),
      //      tax-exempt interest, Social Security, and the RMD
      //      (forced — RMDs are never capped; if they alone
      //      breach the cliff, the pre-tax spending room is 0).
      //   2. The pre-tax spending draw next: capped at the room
      //      left by (1) plus the gains realized by any draws
      //      earlier in this year's draw order; the unmet need
      //      spills to the next buckets in the order.
      //   3. The conversion last: the fill solved it against
      //      the room before draws, and the convergence loop
      //      below re-solves it against the settled draw, so
      //      the conversion keeps only the room the capped draw
      //      leaves. Conversions stay capped exactly as before.
      // Tax-payment debits (withheld overflow, the reprice
      // delta) are NOT spending draws and are never capped.
      // With the cap off, or in a year with no ACA cliff to
      // cap at, the draw is uncapped — bit-identical to before.
      const cliffCapOnDraws =
        yearCeilings?.acaCliffCap === true && acaCliffDollars != null;
      let taxableDrawn = fromTaxable;
      let extraDraw = 0;
      for (const bucket of yearDrawOrder) {
        if (spendDeficit <= 0) break;
        if (bucket === "taxable") {
          const drawT = Math.min(Math.max(0, taxableBal), spendDeficit);
          basisOut(drawT, true);
          taxableBal -= drawT;
          taxableDrawn += drawT;
          fundSpendTaxable += drawT;
          spendDeficit -= drawT;
        } else if (bucket === "pretax") {
          const balanceAvail =
            Math.max(0, pretaxBalP) + Math.max(0, pretaxBalS);
          if (cliffCapOnDraws || pretaxDrawCapArg != null) {
            let drawCap = Infinity;
            if (cliffCapOnDraws) {
              // Room left by the non-draw income (priced with
              // no conversion and no draw — precedence step 1)
              // and the gains realized so far this settlement.
              // With basis tiers the gains so far are the tier
              // sales' own accumulation (the tier ratios differ
              // per dollar, so no single rate prices them);
              // single-pool, the year's starting rate.
              const gainsSoFar =
                (sTiers
                  ? r2(pricedGains)
                  : r2(taxableDrawn * drawGainRate)) + fbGainsIn;
              const baseAcaMagi = priceWith(gainsSoFar, fbPretaxIn, 0).acaMagi;
              drawCap = Math.max(0, (acaTargetDollars as number) - baseAcaMagi);
            }
            if (pretaxDrawCapArg != null) {
              drawCap = Math.min(drawCap, pretaxDrawCapArg);
            }
            extraDraw = Math.min(balanceAvail, spendDeficit, drawCap);
          } else {
            extraDraw = Math.min(balanceAvail, spendDeficit);
          }
          const fromP = Math.min(extraDraw, Math.max(0, pretaxBalP));
          pretaxBalP -= fromP;
          pretaxBalS -= extraDraw - fromP;
          spendDeficit -= extraDraw;
        } else {
          const drawR = Math.min(Math.max(0, rothBal), spendDeficit);
          rothBal -= drawR;
          fundSpendRoth += drawR;
          spendDeficit -= drawR;
        }
      }
      // Priced gains: single-pool, the year's drawn total at
      // the starting gain rate; with tiers, the priced tier
      // sales' accumulated gains (each dollar at its own
      // tier's ratio — the lot-aware figure this build adds).
      const realizedGains = sTiers
        ? r2(pricedGains)
        : r2(taxableDrawn * drawGainRate);
      // The reprice prices the round's FULL income: the priced
      // channels' gains and spending draw, plus the assumed
      // feedback the round opened with. (In round 1 the
      // feedback is $0 and this is the pre-fix reprice.)
      const pricedGainsTotal = realizedGains + fbGainsIn;
      const pricedExtraTotal = extraDraw + fbPretaxIn;
      if (pricedGainsTotal > 0 || pricedExtraTotal > 0) {
        const repriced = priceWith(pricedGainsTotal, pricedExtraTotal, conv);
        const delta = r2(
          repriced.federalTax + repriced.stateTax - (federalTax + stateTax),
        );
        priced = repriced;
        federalTax = repriced.federalTax;
        stateTax = repriced.stateTax;
        if (delta > 0) {
          const pay = Math.min(delta, Math.max(0, taxableBal));
          // The delta payment's own sale gains are created
          // feedback, priced by the next round.
          createdFbGains += basisOut(pay);
          taxableBal -= pay;
          fundTaxTaxable += pay;
          const rest = delta - pay;
          if (rest > 0) unpaidTaxAmt += debitUnpaid(rest);
        } else if (delta < 0) {
          // A settlement credit back into Taxable is after-tax
          // money in: the drift ledger's basis rises with it.
          taxableBal += -delta;
          basisIn(-delta);
          fundTaxTaxable += delta;
        }
      }
      // Leftover surplus cash (income beyond spending + taxes) is
      // saved into Taxable — after-tax money, so on the drift
      // ledger the basis dollars rise by the same amount.
      const surplusLeft = surplusCash - taxFromCash;
      if (surplusLeft > 0) {
        taxableBal += surplusLeft;
        basisIn(surplusLeft);
      }
      // TAXABLE YIELDS, reinvested: the year's yield cash is
      // treated as reinvested distributions — it is already
      // inside the balance (the balance grows at the full
      // expected return, of which the yield is a component), so
      // no balance moves here; the basis ledger rises by the
      // yield amount, dollar for dollar UP TO the balance cap.
      // The tiers path must NOT route this through basisIn /
      // buyIntoTiers: that helper is for real after-tax inflows
      // (the surplus sweep above, settlement credits), whose
      // balance genuinely rises with the money — the yield
      // arrives with no balance of its own, so routing it there
      // minted a phantom inflow-tier balance every year, and
      // the committed tier ledger drifted above the settled
      // balance by roughly each year's yield, compounding
      // (basis past 100% of balance once the yields outran the
      // return, zeroing harvest room by bookkeeping). Instead
      // the yield's basis fills the tiers' unrealized gain
      // (reinvestYieldIntoTiers), exactly the single pool's
      // dollar-for-dollar-up-to-the-cap treatment: when the
      // yields outrun the year's total return, the basis share
      // caps at 100% rather than pricing modeled capital losses
      // on later draws. On the legacy (blank-basis) path
      // basisIn is a no-op and the commit's own update adds
      // the yield there.
      if (yieldTotal > 0) {
        if (sTiers) {
          reinvestYieldIntoTiers(sTiers, yieldTotal);
        } else {
          basisIn(yieldTotal);
        }
      }

      return {
        priced,
        federalTax,
        stateTax,
        penalty,
        // Total priced gains: the priced channels' gains plus
        // the feedback gains this round's pricing included —
        // every gain the year's priced figures recognize.
        realizedGains: r2(realizedGains + fbGainsIn),
        // SETTLEMENT ITERATION surfacing: the feedback this
        // round's pricing assumed (fbGainsIn / fbPretaxIn —
        // at the fixed point, the income the tax channels
        // actually created) and the feedback this round's
        // debits created. The year assembly adds feedbackPretax
        // wherever it re-prices the settled year; settleYear
        // drives the iteration off the created pair.
        feedbackGains: fbGainsIn,
        feedbackPretax: fbPretaxIn,
        createdFbGains: r2(createdFbGains),
        createdFbPretax: r2(createdFbPretax),
        // Total drawn from Taxable this settlement (tax paid
        // from Taxable + spending draws) — the gain-realizing
        // draws the harvest's basis ledger reduces pro-rata.
        taxableDrawn,
        // The drift ledger's basis dollars at settlement end
        // (pre-growth, pre-harvest); read only on drift runs —
        // the legacy path keeps its own ledger update below.
        // With basis tiers this is the tier ledger's total and
        // tierEnd carries the per-tier split the year commits.
        taxableBasisEnd: sTiers
          ? sTiers.reduce((s, t) => s + t.basis, 0)
          : basisBal,
        tierEnd: sTiers,
        extraDraw,
        pretaxBalP,
        pretaxBalS,
        rothBal,
        taxableBal,
        // YEAR FUNDING capture (see the trackers above): this
        // settlement's gross funding flows, before the yield
        // attribution the year assembly applies. taxFromCash is
        // the part of the tax bill the year's surplus cash
        // income paid; the fund* amounts are the account flows
        // applied to spending and to the tax bill.
        spendNeed,
        // SPEND SHORTFALL (FIX 3): the residual spending
        // deficit after this settlement's draw-order loop —
        // the part of the year's spending need the settlement
        // could not fund. $0 whenever the year funds in full.
        spendDeficit: r2(spendDeficit),
        // UNPAID TAX (round-5 fix 1): this settlement's debit
        // chains' unpayable remainder — priced tax no balance
        // could cover. $0 whenever the year's tax was fully
        // paid out of the accounts.
        unpaidTax: r2(unpaidTaxAmt),
        taxFromCash,
        fundTaxTaxable,
        fundTaxPretax,
        fundTaxRoth,
        fundSpendTaxable,
        fundSpendRoth,
        // Spend-from-cash (see the step above): this
        // settlement's cash-paid spending share and its sleeve
        // balance at settlement end — committed by the year
        // only from the KEPT settlement.
        cashSpend: cashSpendAmt,
        sleeveEnd: sleeveBal,
      };
    };

    // SETTLEMENT ITERATION driver: re-run the round with the
    // previous round's created feedback as the assumed
    // feedback until the two agree to the cent on BOTH
    // components (the fixed point). Bounded: at most
    // SETTLEMENT_MAX_ROUNDS rounds, and a repeated assumed
    // pair (a cycle — bracket-boundary jumps can in principle
    // alternate two states) stops the iteration at once. If
    // no round is an exact fixed point, the round whose
    // created feedback came CLOSEST to its assumed feedback
    // (smallest total cent mismatch) is returned — the best
    // iterated state, never a loop. Every re-settlement the
    // year performs (the ceiling convergence loop, the cliff
    // draw-cap binary search, the spend-from-cash growth
    // search) calls settleYear, so each candidate it keeps is
    // itself a fully iterated settlement and the cliff /
    // ceiling properties are checked against iterated priced
    // figures.
    // CONVERGENCE SURFACING (LOW-1): the returned settlement
    // also carries whether the kept round was an exact fixed
    // point and, when it was not, the kept round's residual
    // mismatch per component in integer cents — so a year
    // priced from a best-effort state is distinguishable from
    // an exactly settled one everywhere the settlement flows.
    // Observability only: the kept round is chosen exactly as
    // before, so no priced figure moves.
    const SETTLEMENT_MAX_ROUNDS = 100;
    const settleYear = (additionalArg: number, pretaxDrawCapArg?: number) => {
      let fbGains = 0;
      let fbPretax = 0;
      let best: ReturnType<typeof settleRound> | null = null;
      let bestMismatch = Infinity;
      let bestConverged = false;
      let bestMismatchGainsCents = 0;
      let bestMismatchPretaxCents = 0;
      const seenAssumed = new Set<string>();
      for (let round = 0; round < SETTLEMENT_MAX_ROUNDS; round++) {
        const key = `${r2(fbGains)}|${r2(fbPretax)}`;
        if (seenAssumed.has(key)) break;
        seenAssumed.add(key);
        const s = settleRound(additionalArg, pretaxDrawCapArg, fbGains, fbPretax);
        const mismatchGains = Math.abs(s.createdFbGains - fbGains);
        const mismatchPretax = Math.abs(s.createdFbPretax - fbPretax);
        const mismatch = mismatchGains + mismatchPretax;
        if (s.createdFbGains === r2(fbGains) && s.createdFbPretax === r2(fbPretax)) {
          // Exact fixed point: the assumed feedback pair IS
          // the pair this round's debits created.
          best = s;
          bestConverged = true;
          bestMismatchGainsCents = 0;
          bestMismatchPretaxCents = 0;
          break;
        }
        if (mismatch < bestMismatch) {
          bestMismatch = mismatch;
          best = s;
          bestMismatchGainsCents = Math.round(mismatchGains * 100);
          bestMismatchPretaxCents = Math.round(mismatchPretax * 100);
        }
        fbGains = s.createdFbGains;
        fbPretax = s.createdFbPretax;
      }
      // The loop always runs at least one round, so `best` is
      // always set; the fallback only satisfies the type.
      const kept = best ?? settleRound(additionalArg, pretaxDrawCapArg, 0, 0);
      return {
        ...kept,
        settlementConverged:
          best != null
            ? bestConverged
            : kept.createdFbGains === 0 && kept.createdFbPretax === 0,
        settlementMismatchCents:
          best != null
            ? { gains: bestMismatchGainsCents, pretax: bestMismatchPretaxCents }
            : {
                gains: Math.round(Math.abs(kept.createdFbGains) * 100),
                pretax: Math.round(Math.abs(kept.createdFbPretax) * 100),
              },
      };
    };

    // Whether a FINAL priced year respects every switched-on
    // ceiling — the same caps fillConversion solves against
    // (bracket top / 0% LTCG space on taxable income, IRMAA tier
    // cap / custom cap on MAGI, ACA cliff on ACA MAGI), checked
    // against the settled year's official figures.
    const respectsCeilings = (p: PriceYearResult): boolean => {
      const ceilings = yearCeilings;
      if (!ceilings) return true;
      const law = lawForYear(year);
      const fs = effFilingStatus;
      let taxableCap = Infinity;
      if (ceilings.bracketTopPct != null) {
        const idx = law.rates.indexOf(ceilings.bracketTopPct);
        if (idx >= 0) {
          taxableCap = Math.min(taxableCap, law.brackets[fs][idx] ?? Infinity);
        }
      }
      if (ceilings.ltcgZeroCap) {
        taxableCap = Math.min(taxableCap, law.ltcgZeroTop[fs]);
      }
      let magiCap = Infinity;
      if (ceilings.irmaaTierCap != null) {
        // Same deflated top-of-tier boundary as fillConversion
        // and the classifier (see irmaaTierUpTo).
        magiCap = Math.min(
          magiCap,
          irmaaTierUpTo(ceilings.irmaaTierCap, fs, law, year, inputs.inflationPct),
        );
      }
      if (ceilings.magiCap != null) magiCap = Math.min(magiCap, ceilings.magiCap);
      if (p.taxableIncome > taxableCap + 0.005) return false;
      if (p.magi > magiCap + 0.005) return false;
      if (ceilings.acaCliffCap) {
        if (acaCliffDollars != null) {
          if (p.acaMagi > (acaTargetDollars as number) + 0.005) return false;
        } else if (
          ceilings.bracketTopPct == null &&
          ceilings.irmaaTierCap == null &&
          !ceilings.ltcgZeroCap &&
          ceilings.magiCap == null &&
          conversion > 0
        ) {
          // ACA inactive and the cliff cap is the only ceiling:
          // fillConversion converts $0 in this case, so any
          // priced conversion here (the already-converted
          // top-up) is the user's own, not the strategy's — but
          // a strategy-driven additional conversion must be $0.
          if (additional > 0) return false;
        }
      }
      return true;
    };

    // 3–6 (iterated). Settle the year, and whenever the settled
    // year's draws created income that breaches a switched-on
    // ceiling, re-solve the conversion against the repriced base
    // (the realized gains and extra pre-tax draw the settlement
    // produced) and re-settle from the starting balances. At
    // most 6 settlements per year; the loop stops as soon as the
    // FINAL priced figures respect every ceiling, or the
    // conversion reaches $0 — in which case the year honestly
    // shows the breach the draws alone created. Uncapped and
    // already-compliant years settle exactly once, unchanged.
    let settled = settleYear(additional);
    if (yearCeilings && ceilingsActive(yearCeilings) && inWindow) {
      for (let pass = 1; pass < 6; pass++) {
        if (additional <= 0 || respectsCeilings(settled.priced)) break;
        const target = fillConversion({
          base: {
            ...fillBase,
            ltcg: settled.realizedGains + injectedLtcg,
            extraPreTaxDraw: settled.extraDraw + settled.feedbackPretax,
          },
          ceilings: yearCeilings,
          maxConversion: pretaxAfterRmd + already,
          acaCliff: acaCliffDollars,
          guardrailTargetPct,
        });
        let next = Math.max(
          0,
          Math.min(target - already, pretaxAfterRmd, preserveRoom),
        );
        // The repriced base prices the breaching conversion
        // exactly as settled, so the solver's answer is always
        // smaller; if rounding ever says otherwise, step down
        // one $100 fill step to guarantee progress.
        if (next >= additional) next = Math.max(0, additional - 100);
        if (next === additional) break;
        additional = next;
        conversion = already + additional;
        settled = settleYear(additional);
      }
    }
    // Cliff-cap convergence for the spending draw itself
    // (M-1 fix): when the settled year still sits over the ACA
    // cliff and the conversion has already been shrunk as far
    // as the loop above takes it (to $0 outside the window, or
    // to the leftover room inside it), the remaining breach
    // can only come from the capped draw plus the gains its
    // spill realized in later buckets — gains that settle only
    // inside a full settlement (the tax payment taken from
    // Taxable before the draws, and the spill draws the capped
    // draw displaces), so the pre-settlement cap arithmetic
    // cannot see them all. The pre-fix tightening stepped the
    // cap down by the whole excess per pass, but every $1 cut
    // removes only $(1 − gain rate) of MAGI — the spill draw
    // that replaces the cut adds its gains back — so six
    // passes converged only geometrically and still left the
    // year over the cliff, forfeiting the credit the cap
    // exists to protect. The fix solves the cap exactly, the
    // way fillConversion solves the conversion: a settlement's
    // ACA MAGI is non-decreasing in the draw cap (a $1 larger
    // draw adds $1 of ordinary income and removes at most $1
    // of spill draws priced at a gain rate in [0, 1], and the
    // Social Security phase-in can only damp the rise), so the
    // caps whose settlements respect the cliff form a prefix
    // and a binary search over integer cents finds the largest
    // of them. Bounded — at most 1 + ⌈log2(draw in cents)⌉
    // settlements — and deterministic (settleYear is pure in
    // its arguments), landing the year on the cliff to the
    // cent. When even a $0 draw settles over the cliff,
    // mandatory income (an RMD, Social Security) alone
    // breaches it and no draw cap can land the year: the year
    // then keeps the legacy stepped tightening, bit-identical
    // to before — it settles over, credit $0, and mandatory
    // income is never reduced to chase the line. Runs only
    // when the cliff cap is on and ACA is active; with the cap
    // off this block never executes and the year settles
    // exactly as before. The line this block lands on is the
    // year's effective target (acaTargetDollars — the true
    // cliff less any safety buffer), so a buffered year is
    // tightened to cliff − buffer, not to the cliff itself.
    if (
      yearCeilings?.acaCliffCap === true &&
      acaCliffDollars != null &&
      settled.extraDraw > 0 &&
      settled.priced.acaMagi > (acaTargetDollars as number) + 0.005
    ) {
      const atZeroDraw = settleYear(additional, 0);
      if (atZeroDraw.priced.acaMagi <= (acaTargetDollars as number) + 0.005) {
        // Satisfiable from the draw: binary-search the largest
        // cent-exact cap whose settlement respects the cliff.
        // Invariants: lo is feasible (its settlement is kept
        // in `best`); hi starts at the settled draw itself,
        // whose settlement is the breaching one above.
        let lo = 0;
        let hi = Math.round(settled.extraDraw * 100);
        let best = atZeroDraw;
        while (lo < hi) {
          const mid = Math.floor((lo + hi + 1) / 2);
          const candidate = settleYear(additional, mid / 100);
          if (candidate.priced.acaMagi <= (acaTargetDollars as number) + 0.005) {
            lo = mid;
            best = candidate;
          } else {
            hi = mid - 1;
          }
        }
        settled = best;
      } else {
        // Not satisfiable from the draw (mandatory income alone
        // breaches): the legacy stepped tightening, unchanged.
        let drawCap = settled.extraDraw;
        for (let pass = 0; pass < 6; pass++) {
          const excess = settled.priced.acaMagi - (acaTargetDollars as number);
          if (excess <= 0.005 || drawCap <= 0) break;
          const nextCap = Math.max(0, drawCap - excess);
          if (nextCap >= drawCap) break;
          drawCap = nextCap;
          settled = settleYear(additional, drawCap);
        }
      }
    }
    // SPEND-FROM-CASH × CLIFF COMPOSITION: in a cliff-capped
    // year the cash-paid share shrinks the pre-tax spending
    // draw below the cliff room, so the conversion is the only
    // filler left — but the convergence loop above only ever
    // SHRINKS the conversion (its re-solve prices the breaching
    // settlement's gains, which overstate the gains at the
    // final, smaller conversion), so a cash year could settle
    // materially UNDER the cliff and strand conversion room
    // the strategy means to use. With cash spending active,
    // grow the conversion back: a settlement's ACA MAGI is
    // non-decreasing in the conversion, so the conversions
    // whose settlements respect every switched-on ceiling form
    // a prefix and a binary search over integer cents finds
    // the largest of them — landing the capped year on the
    // cliff to the cent, credit intact, exactly the way the
    // draw-cap search above lands a draw-filled year. Gated on
    // spend-from-cash being active: with the field blank this
    // block never executes and every existing year settles
    // bit-identically to before.
    if (
      spendCashPct > 0 &&
      yearCeilings?.acaCliffCap === true &&
      acaCliffDollars != null &&
      inWindow &&
      !bunchZero &&
      !eraZeroFill &&
      !forceZeroConversion &&
      settled.priced.acaMagi < (acaTargetDollars as number) - 0.005
    ) {
      const maxAdditional = Math.max(
        0,
        Math.min(pretaxAfterRmd, preserveRoom),
      );
      if (additional < maxAdditional) {
        let lo = 0;
        let hi = Math.round((maxAdditional - additional) * 100);
        let bestAdd = additional;
        let best = settled;
        while (lo < hi) {
          const mid = Math.floor((lo + hi + 1) / 2);
          const candidate = settleYear(additional + mid / 100);
          if (
            candidate.priced.acaMagi <= (acaTargetDollars as number) + 0.005 &&
            respectsCeilings(candidate.priced)
          ) {
            lo = mid;
            bestAdd = additional + mid / 100;
            best = candidate;
          } else {
            hi = mid - 1;
          }
        }
        if (bestAdd > additional) {
          additional = bestAdd;
          conversion = already + additional;
          settled = best;
        }
      }
    }
    let priced = settled.priced;
    let federalTax = settled.federalTax;
    let stateTax = settled.stateTax;
    // UNPAID TAX (round-5 fix 1): the kept settlement's unpaid
    // remainder; the harvest's own tax-delta chain below adds
    // any remainder of its own. Reported on the year as
    // unpaidTax (and inside funding) — never dropped.
    let unpaidTaxYear = settled.unpaidTax;
    const penalty = settled.penalty;
    const realizedGains = settled.realizedGains;
    const extraDraw = settled.extraDraw;
    // The settled year's priced pre-tax income beyond the
    // spending draw: the pre-tax debits that paid the year's
    // tax (the settlement iteration's feedback). Every
    // re-pricing of the settled year below (the harvest, the
    // marginal reprice, the fill caps) includes it, so those
    // pricings describe the same year the settlement settled.
    const feedbackPretax = settled.feedbackPretax;
    let pretaxBalP = settled.pretaxBalP;
    let pretaxBalS = settled.pretaxBalS;
    let rothBal = settled.rothBal;
    let taxableBal = settled.taxableBal;

    // Gain harvesting (the strategy's gainsHarvest toggle):
    // AFTER the year's draws and conversions have settled,
    // sell and immediately rebuy taxable holdings to realize
    // gains into the year's REMAINING 0% capital-gains space.
    // The sale and rebuy cancel out — no balance moves — but
    // the year's priced gains (and with them MAGI and ACA
    // MAGI) rise by the harvested amount and the basis ledger
    // steps up by the same amount, so the harvested gain is
    // never taxed later. The amount is the largest that keeps
    // every harvested dollar inside the 0% band (the settled
    // year's gains at 15% / 20% must not grow), respects every
    // ceiling the strategy carries (taxable-income caps, the
    // IRMAA tier cap and custom MAGI cap on MAGI, the ACA
    // cliff on ACA MAGI when the cliff cap is on), and never
    // exceeds the available unrealized gain (balance − basis
    // dollars after this year's draws reduced the ledger
    // pro-rata). In a high-income year the
    // leftover 0% space is zero and the harvest is zero —
    // self-limiting, no separate on/off years. The search is
    // over integer cents against priceYear itself (the same
    // predicate shape fillConversion binary-searches): each
    // check is monotone in the harvested amount, because one
    // more harvested dollar can only add to MAGI / ACA MAGI /
    // taxable income and can pull more Social Security into
    // taxable income, never less. Any tax the harvest's own
    // feedback creates (a higher taxable-SS share, state tax
    // on the higher taxable income) is paid exactly like
    // settleYear's reprice delta: from Taxable, then down the
    // debit chain — and any remainder the chain cannot cover
    // is counted in the year's unpaid tax (round-5 fix 1),
    // never silently dropped.
    let gainsHarvested = 0;
    // YEAR FUNDING capture for the harvest's own reprice delta
    // (display only): the kept settlement's tax channels plus
    // these amounts are the year's gross tax funding.
    let fundHarvestTaxTaxable = 0;
    let fundHarvestTaxPretax = 0;
    let fundHarvestTaxRoth = 0;
    // Commit the year's basis ledger. On a drift run the
    // settlement's own mirror IS the ledger — it tracked every
    // outflow pro-rata and every inflow dollar-for-dollar —
    // clamped to the settled balance as a float-dust guard on
    // the 0 ≤ basis ≤ balance invariant. On the legacy
    // (blank-basis) path the ledger keeps its pre-drift
    // harvest-only update, clamped the same way: the year's
    // gain-realizing draws reduce it pro-rata at the flat
    // basis %, and with the toggle off it moves nothing that
    // is priced — it is the year's detail figure only.
    if (driftOn) {
      // With basis tiers, the kept settlement's tier copy IS
      // the ledger: commit it — clamped to the settled balance
      // as a ledger in its own right, not only through the
      // scalar below: every tier's basis within its own
      // balance and the tier balances summing to the settled
      // taxable balance, so the growth step's re-derivation of
      // the scalar from the tier sum can never resurrect a
      // basis the scalar clamp had cut. The scalar basis then
      // follows as the clamped ledger's total.
      if (tiersActive && settled.tierEnd) {
        tierState = settled.tierEnd.map((t) => ({ ...t }));
        clampTierLedgerToBalance(tierState, taxableBal);
        taxableBasisDollars = tierState.reduce((s, t) => s + t.basis, 0);
      } else {
        taxableBasisDollars = Math.min(
          Math.max(0, settled.taxableBasisEnd),
          Math.max(0, taxableBal),
        );
      }
    } else {
      // Legacy path: the pre-drift harvest-only update, plus
      // the year's reinvested yield (display-only here, like
      // the rest of this ledger — no priced figure reads it),
      // clamped to the settled balance exactly as the drift
      // path's settled basis is clamped above: when the yields
      // outrun the return the unclamped counter could carry a
      // basis above the balance it describes, and the year's
      // detail figure (endingTaxableBasis) must never do that.
      taxableBasisDollars = Math.min(
        Math.max(
          0,
          taxableBasisDollars - settled.taxableDrawn * basisPctClamped + yieldTotal,
        ),
        Math.max(0, taxableBal),
      );
    }
    // SPEND-FROM-CASH sleeve commit: the kept settlement's own
    // sleeve mirror becomes the plan's sleeve, clamped to the
    // settled balance (THE SLEEVE INVARIANT). The harvest below
    // can still shrink it (its tax payment is a pool debit like
    // any other); nothing here or there ever raises it.
    if (spendCashPct > 0) {
      sleeveDollars = Math.min(
        Math.max(0, settled.sleeveEnd),
        Math.max(0, taxableBal),
      );
    }
    if (harvestOn) {
      const availableGain = Math.max(0, taxableBal - taxableBasisDollars);
      if (availableGain > 0) {
        const lawH = lawForYear(year);
        const fsH = effFilingStatus;
        // Taxable-income limits the harvest must respect: the
        // bracket top and the 0%-gains top when the strategy
        // carries them (the 0% band predicate below enforces
        // the 0% top in all cases).
        let taxableLimit = Infinity;
        if (yearCeilings?.bracketTopPct != null) {
          const idx = lawH.rates.indexOf(yearCeilings.bracketTopPct);
          if (idx >= 0) {
            taxableLimit = Math.min(
              taxableLimit,
              lawH.brackets[fsH][idx] ?? Infinity,
            );
          }
        }
        if (yearCeilings?.ltcgZeroCap) {
          taxableLimit = Math.min(taxableLimit, lawH.ltcgZeroTop[fsH]);
        }
        // MAGI limits: the IRMAA tier cap (same deflated
        // top-of-tier boundary as everywhere else) and the
        // custom MAGI cap.
        let magiLimit = Infinity;
        if (yearCeilings?.irmaaTierCap != null) {
          magiLimit = Math.min(
            magiLimit,
            irmaaTierUpTo(
              yearCeilings.irmaaTierCap,
              fsH,
              lawH,
              year,
              inputs.inflationPct,
            ),
          );
        }
        if (yearCeilings?.magiCap != null) {
          magiLimit = Math.min(magiLimit, yearCeilings.magiCap);
        }
        const acaLimit =
          yearCeilings?.acaCliffCap === true && acaCliffDollars != null
            ? (acaTargetDollars as number)
            : Infinity;
        const settledAt15 = priced.gainsAt15;
        const settledAt20 = priced.gainsAt20;
        const harvestFits = (h: number): boolean => {
          const p = priceWith(realizedGains + h, extraDraw + feedbackPretax, conversion);
          return (
            p.gainsAt15 <= settledAt15 + 0.005 &&
            p.gainsAt20 <= settledAt20 + 0.005 &&
            p.taxableIncome <= taxableLimit + 0.005 &&
            p.magi <= magiLimit + 0.005 &&
            p.acaMagi <= acaLimit + 0.005
          );
        };
        if (harvestFits(0)) {
          let lo = 0;
          let hi = Math.floor(availableGain * 100);
          while (lo < hi) {
            const mid = Math.floor((lo + hi + 1) / 2);
            if (harvestFits(mid / 100)) {
              lo = mid;
            } else {
              hi = mid - 1;
            }
          }
          if (lo > 0) {
            gainsHarvested = lo / 100;
            const hp = priceWith(
              realizedGains + gainsHarvested,
              extraDraw + feedbackPretax,
              conversion,
            );
            const delta = r2(
              hp.federalTax + hp.stateTax - (federalTax + stateTax),
            );
            priced = hp;
            federalTax = hp.federalTax;
            stateTax = hp.stateTax;
            if (delta > 0) {
              const pay = Math.min(delta, Math.max(0, taxableBal));
              // The harvest's own tax payment out of Taxable is
              // an outflow like any other: on the drift ledger
              // (the only ledger a harvest can run on — the
              // toggle is inert on a blank basis) the basis
              // leaves pro-rata before the step-up lands. With
              // basis tiers the payment is an ordinary sale —
              // highest-ratio tier first, like every tax
              // payment — before the step-up lands.
              if (pay > 0 && taxableBal > 0) {
                if (tiersActive && tierState) {
                  sellFromTiers(tierState, pay, "highest");
                  taxableBasisDollars = tierState.reduce(
                    (s, t) => s + t.basis,
                    0,
                  );
                } else {
                  taxableBasisDollars = Math.max(
                    0,
                    taxableBasisDollars - pay * (taxableBasisDollars / taxableBal),
                  );
                }
              }
              taxableBal -= pay;
              fundHarvestTaxTaxable += pay;
              // The harvest's tax payment is a pool debit: the
              // sleeve shrinks by the cash it took (the cash
              // tier's new balance in tiers mode — the sale
              // above already moved it; in the single pool the
              // debit is attributed to the non-cash portion
              // first, measured against the pre-payment
              // balance).
              if (spendCashPct > 0 && sleeveDollars > 0 && pay > 0) {
                if (tiersActive && tierState && cashTierIndex >= 0) {
                  sleeveDollars = Math.max(0, tierState[cashTierIndex]!.bal);
                } else if (taxableBal + pay > 0) {
                  const poolBeforePay = taxableBal + pay;
                  sleeveDollars = Math.max(
                    0,
                    sleeveDollars -
                      Math.max(
                        0,
                        pay - Math.max(0, poolBeforePay - sleeveDollars),
                      ),
                  );
                }
              }
              let rest = delta - pay;
              const fromP = Math.min(rest, Math.max(0, pretaxBalP));
              pretaxBalP -= fromP;
              rest -= fromP;
              const fromS = Math.min(rest, Math.max(0, pretaxBalS));
              pretaxBalS -= fromS;
              rest -= fromS;
              fundHarvestTaxPretax += fromP + fromS;
              if (rest > 0) {
                const fromR = Math.min(rest, Math.max(0, rothBal));
                fundHarvestTaxRoth += fromR;
                rothBal = Math.max(0, rothBal - rest);
                // UNPAID TAX (round-5 fix 1): whatever even the
                // Roth leg could not cover is still owed — it
                // joins the year's unpaid tax rather than
                // vanishing at the end of this chain.
                unpaidTaxYear = r2(unpaidTaxYear + Math.max(0, rest - fromR));
              }
            } else if (delta < 0) {
              taxableBal += -delta;
              fundHarvestTaxTaxable += delta;
              // A harvest credit is after-tax money in: with
              // tiers it lands at 100% basis like any inflow.
              if (tiersActive && tierState) {
                buyIntoTiers(tierState, -delta);
                taxableBasisDollars = tierState.reduce(
                  (s, t) => s + t.basis,
                  0,
                );
              } else {
                taxableBasisDollars += -delta;
              }
            }
            // The step-up: the harvest sold from the
            // lowest-ratio tier (the gains live there) and the
            // rebuy lands at full basis on those same shares —
            // with tiers, the lowest tiers' basis rises by the
            // harvested amount, capped at each tier's own
            // unrealized gain; single-pool, the ledger rises
            // by the amount outright.
            if (tiersActive && tierState) {
              stepUpTiers(tierState, gainsHarvested);
              taxableBasisDollars = tierState.reduce(
                (s, t) => s + t.basis,
                0,
              );
            } else {
              taxableBasisDollars += gainsHarvested;
            }
            // The step-up can never carry the basis past the
            // balance it steps up within.
            taxableBasisDollars = Math.min(
              taxableBasisDollars,
              Math.max(0, taxableBal),
            );
          }
        }
      }
    }

    // The harvest's own flows (a tax payment out, a credit in)
    // leave the sleeve within the balance it describes.
    if (spendCashPct > 0) {
      sleeveDollars = Math.min(sleeveDollars, Math.max(0, taxableBal));
    }

    // ACA credit kept for the year (priced on final ACA MAGI —
    // §36B household income, which adds back the non-taxable
    // portion of Social Security; the premium itself is not part
    // of the spending input, so the credit is tracked, not added
    // to balances).
    let acaCreditKept = 0;
    let acaPriced = false;
    let acaResult: AcaCreditResult | null = null;
    if (acaActive && benchmark != null) {
      acaResult = acaCreditFor({
        magi: priced.acaMagi,
        householdSize,
        coverageYear: year,
        benchmarkAnnual: benchmark,
      });
      acaCreditKept = acaResult.credit;
      acaPriced = true;
    }
    const acaUnder138 = acaPriced && acaResult != null && acaResult.pctFpl < 138;

    // YEAR FUNDING assembly (display only — see RothYearFunding
    // for the definitions): attribute the settled year's needs
    // to its funding flows under the stated waterfall, from the
    // settlement's own captured amounts.
    const funding: RothYearFunding = ((): RothYearFunding => {
      const spendNeedY = settled.spendNeed;
      const needsY = spendNeedY + federalTax + penalty + stateTax + irmaaPaid;
      const cashInY = rmd + ssBenefits + inputs.otherOrdinaryAnnual;
      const incomeAppliedY =
        Math.min(cashInY, spendNeedY) + settled.taxFromCash;
      let incLeft = incomeAppliedY;
      const takeIncome = (gross: number): number => {
        const take = gross < 0 ? gross : Math.min(gross, Math.max(0, incLeft));
        incLeft -= take;
        return take;
      };
      const ssApplied = takeIncome(ssBenefits);
      const rmdApplied = takeIncome(rmd);
      const otherApplied = incomeAppliedY - ssApplied - rmdApplied;
      const yieldApplied = Math.min(
        Math.max(0, interestIncome + dividendIncome),
        Math.max(0, needsY - incomeAppliedY),
      );
      const interestApplied = Math.min(interestIncome, yieldApplied);
      const dividendApplied = yieldApplied - interestApplied;
      let pretaxDrawY =
        settled.extraDraw + settled.fundTaxPretax + fundHarvestTaxPretax;
      let taxableSpendY = settled.fundSpendTaxable;
      let taxableTaxY = settled.fundTaxTaxable + fundHarvestTaxTaxable;
      let rothDrawY =
        settled.fundSpendRoth + settled.fundTaxRoth + fundHarvestTaxRoth;
      // The reinvested yield cash offsets the year's taxable
      // sales first — spending sales, then tax sales — then
      // the pre-tax draw, then the Roth draw.
      let offset = yieldApplied;
      const cut = (amount: number): number => {
        if (offset <= 0 || amount <= 0) return amount;
        const c = Math.min(offset, amount);
        offset -= c;
        return amount - c;
      };
      taxableSpendY = cut(taxableSpendY);
      taxableTaxY = cut(taxableTaxY);
      pretaxDrawY = cut(pretaxDrawY);
      rothDrawY = cut(rothDrawY);
      return {
        spending: r2(spendNeedY),
        federalTax: r2(federalTax + penalty),
        stateTax: r2(stateTax),
        irmaa: r2(irmaaPaid),
        ss: r2(ssApplied),
        rmd: r2(rmdApplied),
        otherIncome: r2(otherApplied),
        interestYield: r2(interestApplied),
        dividendYield: r2(dividendApplied),
        pretaxDraw: r2(pretaxDrawY),
        taxableSoldForSpending: r2(taxableSpendY),
        taxableSoldForTax: r2(taxableTaxY),
        cashSpend: r2(settled.cashSpend),
        rothDraw: r2(rothDrawY),
        salarySurplus: 0,
        conversion: r2(conversion),
        harvestSold: r2(gainsHarvested),
        spendShortfall: r2(settled.spendDeficit),
        unpaidTax: r2(unpaidTaxYear),
      };
    })();

    // Effective marginal rate on the conversion: re-price the
    // final year at conversion + $100.
    let effectiveMarginalPct: number | null = null;
    if (conversion > 0) {
      const plus = priceWith(realizedGains, extraDraw + feedbackPretax, conversion + 100);
      effectiveMarginalPct = r2(
        plus.federalTax + plus.stateTax - (federalTax + stateTax),
      );
    }

    magiByYear.set(year, priced.magi);

    // Grow every bucket at the plan's blended real return — or,
    // when a return series is supplied, at that year's series
    // return (see the parameter note on simulateRothPlan).
    const seriesPct = returnSeriesPct?.[year - inputs.startYear];
    const yearGrowth =
      seriesPct != null ? Math.max(0, 1 + seriesPct / 100) : growth;
    // Flexible spending: record the return APPLIED for the
    // year just settled — the UNFLOORED series value when a
    // series supplied one, else the plan's expected return —
    // as the next year's trigger.
    priorYearReturnPct = seriesPct != null ? seriesPct : inputs.expectedReturnPct;
    pretaxP = Math.max(0, pretaxBalP) * yearGrowth;
    pretaxS = Math.max(0, pretaxBalS) * yearGrowth;
    const pretax = pretaxP + pretaxS;
    roth = Math.max(0, rothBal) * yearGrowth;
    taxable = Math.max(0, taxableBal) * yearGrowth;
    hsa = Math.max(0, hsa) * yearGrowth;
    // Basis dollars do NOT grow with the balance. On a drift
    // run, a negative-return year (a varied return series) can
    // shrink the balance below the basis; the basis clamps to
    // the balance there, holding the invariant (basis share
    // never rises except via inflows or harvests). With basis
    // tiers every tier's balance grows at the same rate and
    // the clamp holds per tier, so no tier's basis ever passes
    // its own balance.
    if (driftOn) {
      if (tiersActive && tierState) {
        for (const t of tierState) {
          t.bal = Math.max(0, t.bal) * yearGrowth;
          t.basis = Math.min(t.basis, t.bal);
        }
        // Reconcile the grown ledger to the grown balance, so
        // the invariant the commit established (tier balances
        // sum to the balance; every basis within its tier)
        // survives growth bit-for-bit rather than by float
        // approximation.
        clampTierLedgerToBalance(tierState, taxable);
        taxableBasisDollars = tierState.reduce((s, t) => s + t.basis, 0);
      } else {
        taxableBasisDollars = Math.min(taxableBasisDollars, taxable);
      }
    }
    // The sleeve does NOT grow with the balance (it is a fixed
    // dollar sub-ledger — the fixtures' year-1/2/partial-year
    // amounts sum to the starting sleeve exactly); growth only
    // ever clamps it to the balance it describes, and in tiers
    // mode it re-reads the cash tier's grown balance (growth
    // and the ledger clamp above already moved that tier).
    if (spendCashPct > 0) {
      sleeveDollars =
        tierState != null && cashTierIndex >= 0
          ? Math.max(0, tierState[cashTierIndex]!.bal)
          : Math.min(sleeveDollars, Math.max(0, taxable));
    }

    const warnings: RothYearWarning[] = [];
    if (!leanDetail) {
      // IRMAA cliff pill: only MAGI from age 63 onward can ever set
      // a premium (the surcharge lands at 65+, two years later), so
      // the pill never fires for younger conversion years.
      if (priced.irmaaTier > 0 && priceAgePrimary >= 63) {
        const law = lawForYear(year);
        // The floor the household just crossed is the previous
        // tier's ceiling — measured with the SAME deflated value
        // irmaaTierFor uses (only the top tier's floor deflates;
        // tiers 1–4 stay at their raw law-row values in both
        // places, via irmaaTierUpTo).
        const floor =
          priced.irmaaTier - 1 < law.irmaaTiers.length
            ? irmaaTierUpTo(
                priced.irmaaTier - 1,
                effFilingStatus,
                law,
                year,
                inputs.inflationPct,
              ) + 1
            : 0;
        const perPersonAnnual = irmaaAnnualPerPerson(priced.irmaaTier, law);
        if (priced.magi - floor <= 2500) {
          const bothOnMedicareAtPremium =
            !isSurvivorYear &&
            age + 2 >= 65 && spouseAge != null && spouseAge + 2 >= spouseAcaEndAge;
          const framing = bothOnMedicareAtPremium
            ? `≈${fmtDollars(perPersonAnnual)}/yr for each person on Medicare — ≈${fmtDollars(r2(perPersonAnnual * 2))}/yr for the household`
            : `≈${fmtDollars(perPersonAnnual)}/yr for each person on Medicare`;
          warnings.push({
            kind: "irmaa",
            text: `Just over the IRMAA Tier ${priced.irmaaTier} line — MAGI ${fmtDollars(priced.magi)} sets Tier ${priced.irmaaTier} premiums two years later (${framing}).`,
          });
        }
      }
      if (acaActive && acaPriced && acaResult) {
        if (acaResult.overCliff) {
          warnings.push({
            kind: "aca",
            text: `Over the ACA cliff — ACA MAGI ${fmtDollars(priced.acaMagi)} is past 400% FPL (${fmtDollars(acaResult.cliff)}), so the whole year's premium credit is $0 and any advance credit is repayable in full.`,
          });
        } else if (acaResult.cliff - priced.acaMagi <= 2500 && acaResult.cliff >= priced.acaMagi) {
          warnings.push({
            kind: "aca",
            text: `Close to the ACA cliff — ACA MAGI ${fmtDollars(priced.acaMagi)} vs the 400% FPL line at ${fmtDollars(acaResult.cliff)}; $1 over loses the whole year's credit.`,
          });
        }
        if (acaUnder138) {
          warnings.push({
            kind: "aca",
            text: `Priced at ${acaResult.pctFpl.toFixed(0)}% of the poverty line — under 138% FPL, at that income coverage routes to Medicaid rather than a marketplace plan in most states, so the credit shown for this year is flagged rather than a marketplace result.`,
          });
        }
      }
      if (
        effectiveMarginalPct != null &&
        effectiveMarginalPct > priced.marginalBracketPct + 0.5
      ) {
        // Blame Social Security only when benefits are actually
        // phasing into taxable income; an elevated effective rate
        // can also come from the state rate or 0%-gains
        // displacement, which get the generic wording.
        const ssPhasingIn =
          ssBenefits > 0 && priced.ssTaxable < 0.85 * ssBenefits - 0.01;
        if (ssPhasingIn) {
          warnings.push({
            kind: "torpedo",
            text: `Social Security torpedo zone — this year's conversion is really taxed at ${effectiveMarginalPct.toFixed(1)}%, not the ${priced.marginalBracketPct}% bracket rate, because each converted dollar also pulls Social Security into taxable income.`,
          });
        } else {
          warnings.push({
            kind: "torpedo",
            text: `Effective rate above the bracket rate — the next $100 of conversion in this year would be taxed at ${effectiveMarginalPct.toFixed(1)}%, not the ${priced.marginalBracketPct}% bracket rate (causes other than Social Security phase-in: this year's income straddling the top of the bracket, state tax, capital-gains displacement, or a deduction phase-out).`,
          });
        }
      }
      // College-years watch-out. Two gates, both household-
      // generic: (1) the household's own college window — a
      // conversion in tax year Y feeds the FAFSA for academic
      // year Y+2 (prior-prior year), so the warning fires only
      // when both fall-year fields are set and from ≤ Y+2 ≤
      // through; either field blank means no college window and
      // it never fires. (2) Need-based aid being arithmetically
      // reachable: the FAFSA/SAI formula assesses parent assets
      // at up to 5.64% per year, so when 5.64% of the plan's
      // reportable assets alone reaches a full public-university
      // cost of attendance ($40,000), need-based aid cannot reach
      // the household even at $0 income and the warning is
      // silently absent. Unknown assets (field absent or null)
      // never suppress.
      if (
        conversion > 0 &&
        inputs.collegeFallFromYear != null &&
        inputs.collegeFallThroughYear != null &&
        inputs.collegeFallFromYear <= year + 2 &&
        year + 2 <= inputs.collegeFallThroughYear &&
        (inputs.fafsaReportableAssets == null ||
          FAFSA_PARENT_ASSET_RATE * inputs.fafsaReportableAssets <
            FAFSA_PUBLIC_COA_BENCHMARK)
      ) {
        warnings.push({
          kind: "college",
          text: "College years: conversion income in this year counts as FAFSA income (prior-prior year) during a child's college years.",
        });
      }
    }

    lifetimeFederalTax += federalTax;
    lifetimeStateTax += stateTax;
    lifetimePenalty += penalty;
    lifetimeIrmaa += irmaaPaid;
    lifetimeAcaKept += acaCreditKept;
    lifetimeSsCollected += ssBenefits;
    lifetimeUnpaidTax += unpaidTaxYear;

    // "Show the math" detail for this row — assembled entirely
    // from this year's own engine variables and the settled
    // priced result; nothing here feeds any total.
    const fillCaps: RothFillCap[] = [];
    let fillBoundLabel: string | null = null;
    if (yearCeilings && !leanDetail) {
      const lawY = lawForYear(year);
      const fsY = effFilingStatus;
      const nextPriced =
        conversion > 0 ? priceWith(realizedGains, extraDraw + feedbackPretax, conversion + 100) : null;
      const addCap = (
        kind: RothFillCap["kind"],
        label: string,
        cap: number,
        actual: number,
        nextActual: number | null,
      ) => {
        if (!Number.isFinite(cap)) return;
        const bound =
          actual <= cap + 0.005 && nextActual != null && nextActual > cap + 0.005;
        fillCaps.push({
          kind,
          label,
          cap: r2(cap),
          actual: r2(actual),
          room: r2(cap - actual),
          bound,
        });
        if (bound && fillBoundLabel == null) fillBoundLabel = label;
      };
      if (preserveFloor > 0) {
        // The reserve is a FLOOR, not a ceiling: `actual` is
        // the post-conversion combined pre-tax balance and
        // `room` is how far that balance sits above the floor.
        // Bound when this year's conversion reached the floor —
        // the next $100 step would have crossed it. Added
        // first so its label names the fill when it binds.
        const postConversion = pretaxAfterRmd - additional;
        const bound =
          additional > 0 && postConversion - preserveFloor < 100 - 0.005;
        fillCaps.push({
          kind: "preserve",
          label: `Pre-tax reserve — ${fmtDollars(preserveFloor)} never converted`,
          cap: r2(preserveFloor),
          actual: r2(postConversion),
          room: r2(postConversion - preserveFloor),
          bound,
        });
        if (bound && fillBoundLabel == null) {
          fillBoundLabel = "Pre-tax reserve floor";
        }
      }
      if (yearCeilings.bracketTopPct != null) {
        const idx = lawY.rates.indexOf(yearCeilings.bracketTopPct);
        if (idx >= 0) {
          addCap(
            "bracket",
            `Top of the ${yearCeilings.bracketTopPct}% bracket`,
            lawY.brackets[fsY][idx] ?? Infinity,
            priced.taxableIncome,
            nextPriced?.taxableIncome ?? null,
          );
        }
      }
      if (yearCeilings.ltcgZeroCap) {
        addCap(
          "ltcgZero",
          "Top of the 0% capital-gains space",
          lawY.ltcgZeroTop[fsY],
          priced.taxableIncome,
          nextPriced?.taxableIncome ?? null,
        );
      }
      if (yearCeilings.irmaaTierCap != null) {
        addCap(
          "irmaa",
          `IRMAA Tier ${yearCeilings.irmaaTierCap} ceiling`,
          irmaaTierUpTo(yearCeilings.irmaaTierCap, fsY, lawY, year, inputs.inflationPct),
          priced.magi,
          nextPriced?.magi ?? null,
        );
      }
      if (yearCeilings.magiCap != null) {
        addCap(
          "magi",
          `MAGI cap ${fmtDollars(yearCeilings.magiCap)}`,
          yearCeilings.magiCap,
          priced.magi,
          nextPriced?.magi ?? null,
        );
      }
      if (yearCeilings.acaCliffCap && acaCliffDollars != null) {
        // The cap the year's fill actually bound against is
        // the buffered target when a safety buffer is set; the
        // label names it so the record never shows the raw
        // cliff as the binding line for a buffered year.
        const cliffBuffer = Math.max(0, yearCeilings.acaCliffBuffer ?? 0);
        addCap(
          "acaCliff",
          cliffBuffer > 0
            ? `ACA cliff (400% of the poverty line, on ACA MAGI) less the ${fmtDollars(cliffBuffer)} safety buffer`
            : "ACA cliff (400% of the poverty line, on ACA MAGI)",
          acaTargetDollars ?? acaCliffDollars,
          priced.acaMagi,
          nextPriced?.acaMagi ?? null,
        );
      }
      if (fillBoundLabel == null && additional > 0) {
        if (additional >= pretaxAfterRmd - 0.005) {
          fillBoundLabel = "Pre-tax balance exhausted";
        } else if (guardrailTargetPct != null && nextPriced != null) {
          const stepRate =
            nextPriced.federalTax + nextPriced.stateTax - (federalTax + stateTax);
          if (stepRate > guardrailTargetPct + 0.005) {
            fillBoundLabel = `Marginal-rate guardrail (${guardrailTargetPct}%)`;
          }
        }
      }
    } else if (!leanDetail && additional > 0 && additional >= pretaxAfterRmd - 0.005) {
      fillBoundLabel = "Pre-tax balance exhausted";
    }
    let fillOutcome: RothYearDetail["fill"]["outcome"];
    if (additional > 0) {
      fillOutcome = "converted";
    } else if (!inWindow) {
      fillOutcome = "outside-window";
    } else if (!strategy.ceilings) {
      fillOutcome = "no-ceilings";
    } else if (bunchZero) {
      fillOutcome = "bunching-off-year";
    } else if (eraZeroFill) {
      fillOutcome = "era-cliff-off";
    } else if (pretaxAfterRmd <= 0) {
      fillOutcome = "pretax-empty";
    } else if (already > 0) {
      fillOutcome = "already-converted-only";
    } else if (preserveFloor > 0 && preserveRoom <= 0) {
      fillOutcome = "reserve-floor";
    } else if (
      yearCeilings?.acaCliffCap &&
      acaCliffDollars == null &&
      yearCeilings.bracketTopPct == null &&
      yearCeilings.irmaaTierCap == null &&
      !yearCeilings.ltcgZeroCap &&
      yearCeilings.magiCap == null
    ) {
      fillOutcome = "aca-inactive-only-ceiling";
    } else {
      fillOutcome = "no-room-under-ceilings";
    }
    const detail: RothYearDetail = {
      priorPretaxBalance: r2(priorPretaxBalance),
      rmdDivisor,
      rmdTable,
      priorPretaxPrimary: r2(priorP),
      priorPretaxSpouse: r2(priorS),
      rmdPrimary: r2(rmdP),
      rmdSpouse: r2(rmdS),
      rmdDivisorPrimary: divisorP,
      rmdDivisorSpouse: divisorS,
      rmdTablePrimary: tableP,
      rmdTableSpouse: tableS,
      filingStatus: effFilingStatus,
      isDeathYear,
      isSurvivorYear,
      otherOrdinary: r2(inputs.otherOrdinaryAnnual),
      // The year's total priced pre-tax draw: the spending
      // draw plus the pre-tax debits that paid the tax bill
      // (settlement feedback) — the amount the priced AGI
      // actually carries, so the detail's income pieces sum
      // to AGI.
      extraPreTaxDraw: r2(extraDraw + feedbackPretax),
      // Total gains priced this year: the draws' realized gains
      // plus any injected counterfactual sale gain plus the
      // harvested gain. With the two yield lines below, the
      // detail's income pieces still sum exactly to AGI.
      ltcg: r2(realizedGains + injectedLtcg + gainsHarvested),
      dividendIncome: r2(dividendIncome),
      interestIncome: r2(interestIncome),
      cashSpend: r2(settled.cashSpend),
      cashSleeveEnd: r2(spendCashPct > 0 ? sleeveDollars : 0),
      spendingBase: r2(spendNeedBase),
      flexCut: r2(spendNeedBase - spendNeedYear),
      gainsHarvested: r2(gainsHarvested),
      taxableBasisDollars: r2(taxableBasisDollars),
      drawGains: r2(realizedGains),
      taxExemptInterest: r2(inputs.taxExemptInterestAnnual),
      provisionalIncome: priced.provisionalIncome,
      ssTaxable: priced.ssTaxable,
      agi: priced.agi,
      baseStandardDeduction: priced.baseStandardDeduction,
      age65AddonTotal: priced.age65AddonTotal,
      count65: priced.count65,
      standardDeduction: priced.standardDeduction,
      seniorDeduction: priced.seniorDeduction,
      deductions: priced.deductions,
      ordinaryTaxableIncome: priced.ordinaryTaxableIncome,
      gainsInTaxableIncome: priced.gainsInTaxableIncome,
      bracketLayers: priced.bracketLayers,
      gainsAt0: priced.gainsAt0,
      gainsAt15: priced.gainsAt15,
      gainsAt20: priced.gainsAt20,
      ordinaryTax: priced.ordinaryTax,
      ltcgTax: priced.ltcgTax,
      niit: priced.niit,
      stateTax: r2(stateTax),
      fill: {
        inWindow,
        windowStartAge: inputs.windowStartAge,
        windowStopAge: inputs.windowStopAge,
        outcome: fillOutcome,
        boundLabel: fillBoundLabel,
        caps: fillCaps,
      },
      irmaa: {
        tierSet: priced.irmaaTier,
        premiumYear: year + 2,
        paidTier: irmaaPaidTier,
        paidSourceYear: irmaaPaidTier != null ? year - 2 : null,
        paidSourceMagi:
          irmaaPaidTier != null && magiTwoYearsAgo != null ? r2(magiTwoYearsAgo) : null,
        personsOnMedicare,
      },
      aca: {
        active: acaActive,
        priced: acaPriced,
        householdSize,
        benchmark,
        fpl: acaResult ? acaResult.fpl : acaCliffDollars != null ? r2(acaCliffDollars / 4) : null,
        cliff: acaResult ? acaResult.cliff : acaCliffDollars,
        pctFpl: acaResult ? acaResult.pctFpl : null,
        applicablePct: acaResult ? acaResult.applicablePct : null,
        overCliff: acaResult ? acaResult.overCliff : false,
      },
    };

    years.push({
      year,
      agePrimary: age,
      ageSpouse: spouseAge,
      conversion: r2(conversion),
      conversionAlready: r2(already),
      gainsHarvested: r2(gainsHarvested),
      rmd: r2(rmd),
      ssBenefits: r2(ssBenefits),
      ssPctTaxed:
        ssBenefits > 0 ? r2((priced.ssTaxable / ssBenefits) * 100) : 0,
      agi: priced.agi,
      magi: priced.magi,
      acaMagi: priced.acaMagi,
      taxableIncome: priced.taxableIncome,
      acaActive,
      bracketPct: priced.marginalBracketPct,
      federalTax: r2(federalTax),
      stateTax: r2(stateTax),
      penalty: r2(penalty),
      effectiveMarginalPct,
      irmaaTierSet: priced.irmaaTier,
      irmaaPaid: r2(irmaaPaid),
      acaCreditKept: r2(acaCreditKept),
      acaPriced,
      acaUnder138,
      pretaxEnd: r2(pretax),
      pretaxPrimaryEnd: r2(pretaxP),
      pretaxSpouseEnd: r2(pretaxS),
      filingStatus: effFilingStatus,
      isDeathYear,
      isSurvivorYear,
      rothEnd: r2(roth),
      taxableEnd: r2(taxable),
      hsaEnd: r2(hsa),
      fiveYearClockYear: conversion > 0 ? year + 5 : null,
      warnings,
      detail,
      funding,
      spendShortfall: r2(settled.spendDeficit),
      unpaidTax: r2(unpaidTaxYear),
      settlementConverged: settled.settlementConverged,
      settlementMismatchCents: settled.settlementMismatchCents,
    });
  }

  const endingPretaxTotal = pretaxP + pretaxS;
  // Ending after-tax wealth values leftover pre-tax at the
  // heir rate — or, with a preserve reserve set, split: the
  // preserved portion (up to the floor) at its expected exit
  // rate, the excess at the heir rate, the same split the
  // net-cost score uses. No reserve (floor 0): the preserved
  // part is $0 and this is the old formula bit for bit.
  const endingPreserved = Math.min(
    endingPretaxTotal,
    Math.max(0, inputs.preservePretax ?? 0),
  );
  const endingAfterTaxWealth =
    endingPreserved * (1 - (inputs.preserveExitRatePct ?? inputs.heirRatePct) / 100) +
    (endingPretaxTotal - endingPreserved) * (1 - inputs.heirRatePct / 100) +
    roth +
    taxable +
    hsa;
  return {
    years,
    lifetimeFederalTax: r2(lifetimeFederalTax),
    lifetimeStateTax: r2(lifetimeStateTax),
    lifetimePenalty: r2(lifetimePenalty),
    lifetimeIrmaa: r2(lifetimeIrmaa),
    lifetimeAcaKept: r2(lifetimeAcaKept),
    lifetimeSsCollected: r2(lifetimeSsCollected),
    lifetimeUnpaidTax: r2(lifetimeUnpaidTax),
    endingPretax: r2(endingPretaxTotal),
    endingRoth: r2(roth),
    endingTaxable: r2(taxable),
    endingHsa: r2(hsa),
    endingAfterTaxWealth: r2(endingAfterTaxWealth),
  };
}

function fmtDollars(n: number): string {
  const neg = n < 0;
  const abs = Math.abs(Math.round(n));
  // Thousands grouping identical to toLocaleString("en-US") for
  // a non-negative integer, without the ICU call — this runs
  // inside every simulated year's detail assembly.
  const s = `$${groupThousands(abs)}`;
  return neg ? `−${s}` : s;
}

export function groupThousands(absInt: number): string {
  const digits = String(absInt);
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return out;
}
