/* ---------------- Independent second implementation ----------------
   Part 1 of the hardening block (Oct 16: "why not do all?" /
   "Do all of them but make it last" / "Implement it in way we
   can refactor or add new"). This module is the harness's
   ORACLE: an independent second implementation of the
   single-year tax math, written FROM THE LAW TABLES
   (server/src/taxLaw.ts) — deliberately NOT from engine
   source. It imports NOTHING from server/src/taxEngine.ts:
   not priceYear, not ssTaxableAmount, not irmaaTierFor, not
   acaCreditFor, not amtFor, not educationCreditsFor, not
   waCapitalGainsTax, not applyLossLedger — not even their
   types. Its input and result types are its own; the
   differential module (differential.ts) maps between the
   engine's PriceYearInput/PriceYearResult and these types.

   What it prices (the core single-year settlement, in
   statutory order): §86 taxable Social Security, AGI / MAGI /
   §36B ACA MAGI, the deduction greater-of (standard + age-65
   add-ons, §151(d)(5)(C) senior deduction with phase-out,
   itemized with the §164(b)(7) SALT schedule cap and
   phase-down, the 2026 trio — §170(b)(1)(I) floor, 60%
   charitable ceiling, §68 reduction, §170(p) non-itemizer
   deduction), the ordinary brackets, the 0% / 15% / 20%
   capital-gains staircase, §1411 NIIT, §25A education
   credits (both statutory allocations, better-of), §55 AMT
   (core scope), the state tax (flat rate, or the RCW 82.87
   Washington excise), and the IRMAA tier.

   Derivation sources (the law, not the engine): IRC §86,
   §63, §151(d)(5)(C), §164(b)(7) as amended by §70120 of
   Pub. L. 119-21, §170(b)(1)(G) / (b)(1)(I) / (p), §68,
   §1(h), §1411, §25A, §55, §36B (ACA credit lives in
   independentAcaCredit.ts), RCW 82.87 — as published in the
   versioned law tables of server/src/taxLaw.ts, whose header
   documents the modeling conventions this implementation
   follows: the unindexed-threshold deflation rule (statute-
   fixed figures deflate at the plan's inflation input by the
   years the priced year runs past its law row), the
   carry-forward rule (a year past the newest row prices
   under that row), and the SALT dated schedule consulted by
   calendar year. Every figure comes from the priced year's
   law row or a dated schedule entry; no figure is copied
   from an engine computation.

   Rounding discipline: intermediates stay full-precision
   floats; every returned money field is rounded to the cent
   (round-half-up, Math.round(n * 100) / 100) at exactly the
   points the settlement reports them — the same discipline
   the fixtures pin. A differential mismatch is a finding
   to adjudicate, never something to absorb silently: this
   file is the independent side, and the engine is the side
   under test. */

import type { FilingStatus, YearLaw } from "../taxLaw";
import {
  lawForYear,
  saltScheduleForYear,
  SALT_SCHEDULE_FIRST_YEAR,
  CHARITABLE_CEILING,
  DEDUCTION_2026,
  SENIOR_DEDUCTION,
  SS_THRESHOLDS,
} from "../taxLaw";

// One student's qualified education expenses for a priced
// year (IRC §25A). Same contract as the engine's input: the
// household's own mark of AOTC eligibility; this module
// prices credit math and phase-outs, never eligibility.
export type IndependentStudent = {
  expenses: number;
  aotcEligible: boolean;
};

// The single-year inputs this oracle prices. Field for
// field the same contract as the engine's single-year
// pricing: the year's income components, deduction
// components, and the two statute-fixed rates the year
// prices under. The loss ledger is NOT an input here —
// the §1211(b) allowance the year prices is passed in
// exactly as the engine receives it (capitalLossAllowance),
// and the ledger transform itself is covered by the
// invariants module, not by this pricer.
export type IndependentYearInput = {
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
  interestIncome?: number;
  ordinaryDividends?: number;
  qualifiedDividends?: number;
  capitalLossAllowance?: number;
  inflationPct: number;
  stateRatePct: number;
  residenceState?: "WA" | "other" | null;
  itemizedMortgageInterest?: number;
  itemizedSaltPaid?: number;
  itemizedCharitable?: number;
  itemizedOther?: number;
  waGainsBase?: number;
  educationStudents?: IndependentStudent[] | null;
};

export type IndependentBracketLayer = {
  ratePct: number;
  from: number;
  to: number | null;
  amount: number;
  tax: number;
};

export type IndependentYearResult = {
  provisionalIncome: number;
  ssTaxable: number;
  agi: number;
  magi: number;
  acaMagi: number;
  baseStandardDeduction: number;
  age65AddonTotal: number;
  count65: number;
  ordinaryTaxableIncome: number;
  gainsInTaxableIncome: number;
  bracketLayers: IndependentBracketLayer[];
  gainsAt0: number;
  gainsAt15: number;
  gainsAt20: number;
  standardDeduction: number;
  seniorDeduction: number;
  itemizedDeduction: number;
  itemizedSaltAllowed: number;
  itemizedSaltCap: number;
  itemizedCharitableAllowed: number;
  section68Reduction: number;
  nonItemizerCharitableDeduction: number;
  deductionTaken: "standard" | "itemized";
  deductions: number;
  taxableIncome: number;
  taxableIncomeBeforeLossAllowance: number;
  ordinaryTax: number;
  ltcgTax: number;
  niit: number;
  federalTax: number;
  stateTax: number;
  waGains: number;
  waStandardDeduction: number;
  waCharitableDeduction: number;
  waTaxableGains: number;
  educationAotc: number;
  educationLlc: number;
  educationChoice: "aotc" | "llc" | "none";
  educationNonrefundable: number;
  educationRefundable: number;
  amti: number;
  amtExemption: number;
  amtTentativeTax: number;
  amtOwed: number;
  marginalBracketPct: number;
  irmaaTier: number;
};

// Round to the cent, half-up. The same cent-quantization
// the settlement reports: every money field below is struck
// through this function, and nothing else is.
function roundCent(n: number): number {
  return Math.round(n * 100) / 100;
}

// The unindexed-threshold deflation rule (taxLaw.ts header):
// a statute-fixed figure stated in a law row's dollars
// deflates at the plan's inflation input by the number of
// years the priced year runs past its row's year — 1.0 for
// a year pricing under its own published row.
function deflateYears(
  calendarYear: number,
  lawYear: number,
  inflationPct: number,
): number {
  const years = Math.max(0, calendarYear - lawYear);
  const factor = 1 / Math.pow(1 + inflationPct / 100, years);
  if (!Number.isFinite(factor)) {
    throw new Error(
      `deflateYears: non-finite factor for inflationPct ${inflationPct} over ${years} year(s) — inflation must be greater than −100%.`,
    );
  }
  return factor;
}

// Ordinary-bracket tax: walk the year's tops at the year's
// rates, taxing each layer's slice of taxable ordinary
// income. The tops and rates come from the law row.
function ordinaryBracketTax(
  taxableOrdinary: number,
  law: YearLaw,
  fs: FilingStatus,
): number {
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

function ordinaryMarginalRate(
  taxableOrdinary: number,
  law: YearLaw,
  fs: FilingStatus,
): number {
  const tops = law.brackets[fs];
  for (let i = 0; i < tops.length; i++) {
    if (taxableOrdinary < (tops[i] ?? Infinity)) return law.rates[i] ?? 0;
  }
  return law.rates[law.rates.length - 1] ?? 37;
}

// §86 taxable Social Security: the provisional-income
// staircase. Thresholds are statute-fixed, so both deflate
// by the year's factor. Below the first threshold nothing
// is taxable; between the thresholds at most 50% of
// benefits; above the second, the 50% base plus 85% of the
// excess over the second threshold, capped at 85% of
// benefits.
function taxableSocialSecurity(
  benefits: number,
  provisional: number,
  fs: FilingStatus,
  defl: number,
): number {
  if (benefits <= 0) return 0;
  const t = SS_THRESHOLDS[fs];
  const first = t.first * defl;
  const second = t.second * defl;
  if (provisional <= first) return 0;
  if (provisional <= second) {
    return Math.min(0.5 * benefits, 0.5 * (provisional - first));
  }
  const base = Math.min(0.5 * benefits, 0.5 * (second - first));
  return Math.min(0.85 * benefits, base + 0.85 * (provisional - second));
}

// §151(d)(5)(C) senior deduction: $6,000 per person 65+
// (2025–2028 only), on top of whichever deduction side
// wins. Amount and phase-out start are statute-fixed, so
// both deflate; the phase-out runs on AGI (the statute's
// MAGI adds back only foreign-income exclusions, none
// modeled — tax-exempt interest is NOT added back).
function seniorDeductionFor(
  calendarYear: number,
  count65: number,
  agi: number,
  fs: FilingStatus,
  defl: number,
): number {
  if (
    calendarYear < SENIOR_DEDUCTION.firstYear ||
    calendarYear > SENIOR_DEDUCTION.lastYear ||
    count65 === 0
  ) {
    return 0;
  }
  const excess = Math.max(
    0,
    agi - SENIOR_DEDUCTION.phaseOutStart[fs] * defl,
  );
  const perPerson = Math.max(
    0,
    SENIOR_DEDUCTION.amountPerPerson * defl -
      SENIOR_DEDUCTION.phaseOutRate * excess,
  );
  return perPerson * count65;
}

// §164(b)(7) SALT cap as it applies to the year: the dated
// schedule entry enacted for the calendar year (2025 on),
// or the law row's figures for earlier years. The cap's
// figures are statute-fixed, so they deflate by the years
// past the schedule entry (or the row) they price under;
// the phase-down runs on AGI and floors at the entry's
// floor.
function saltCapFor(
  calendarYear: number,
  agi: number,
  law: YearLaw,
  defl: number,
  inflationPct: number,
): number {
  if (calendarYear >= SALT_SCHEDULE_FIRST_YEAR) {
    const entry = saltScheduleForYear(calendarYear);
    const entryDefl = deflateYears(
      calendarYear,
      entry.entryYear,
      inflationPct,
    );
    return Math.max(
      entry.capFloor * entryDefl,
      entry.cap * entryDefl -
        (entry.phaseOutRatePct / 100) *
          Math.max(0, agi - entry.phaseOutStart * entryDefl),
    );
  }
  return Math.max(
    law.saltCapFloor * defl,
    law.saltCap * defl -
      (law.saltPhaseOutRatePct / 100) *
        Math.max(0, agi - law.saltPhaseOutStart * defl),
  );
}

// §25A education credits: the AOTC per eligible student
// (100% of the first tier-1 expenses, the tier-2 rate on
// the next tier-2 expenses) and the LLC per return (its
// rate on up to its expense cap of the students NOT claimed
// for the AOTC), priced both statutory ways — AOTC for the
// eligible students plus LLC over the rest, and LLC over
// every student's expenses — with the allocation whose
// total benefit (refundable share plus the nonrefundable
// share the year's tax can absorb) is larger winning.
// Both credits phase out ratably over the §25A(d) range on
// AGI. The refundable share (40%) of the winning AOTC
// pays regardless of liability and is reported separately,
// never netted into the year's tax; the nonrefundable
// share applies against income tax only, never below the
// NIIT (Form 1040 ordering). Every §25A dollar figure is
// statute-fixed, so caps and the phase-out range deflate.
function educationCreditsIndependent(args: {
  students: IndependentStudent[] | null | undefined;
  filingStatus: FilingStatus;
  agi: number;
  taxBeforeCredits: number;
  law: YearLaw;
  defl: number;
}): {
  aotc: number;
  llc: number;
  choice: "aotc" | "llc" | "none";
  nonrefundableApplied: number;
  refundable: number;
} {
  const none = {
    aotc: 0,
    llc: 0,
    choice: "none" as const,
    nonrefundableApplied: 0,
    refundable: 0,
  };
  const students = (args.students ?? []).filter(
    (s) => s != null && Number.isFinite(s.expenses) && s.expenses > 0,
  );
  if (students.length === 0) return none;
  const law = args.law;
  const defl = args.defl;
  const tier1Cap = law.aotcTier1Expenses * defl;
  const tier2Cap = law.aotcTier2Expenses * defl;
  const llcCap = law.llcExpenseCap * defl;
  const phaseStart = law.eduPhaseOutStart[args.filingStatus] * defl;
  const phaseWidth = law.eduPhaseOutWidth[args.filingStatus] * defl;
  const excess = Math.max(0, args.agi - phaseStart);
  const phasedOut =
    phaseWidth > 0 ? Math.min(1, excess / phaseWidth) : excess > 0 ? 1 : 0;
  const keep = 1 - phasedOut;
  if (keep <= 0) return none;
  const aotcForStudent = (expenses: number): number => {
    const e = Math.max(0, expenses);
    const tier1 = Math.min(e, tier1Cap);
    const tier2 = Math.min(Math.max(0, e - tier1Cap), tier2Cap);
    return (
      (law.aotcTier1RatePct / 100) * tier1 +
      (law.aotcTier2RatePct / 100) * tier2
    );
  };
  const llcForExpenses = (expenses: number): number =>
    (law.llcRatePct / 100) * Math.min(Math.max(0, expenses), llcCap);
  const liability = Math.max(0, args.taxBeforeCredits);
  const priceAllocation = (aotcTentative: number, llcTentative: number) => {
    const aotc = aotcTentative * keep;
    const llc = llcTentative * keep;
    const refundable = (law.aotcRefundablePct / 100) * aotc;
    const nonrefundableTentative = aotc - refundable + llc;
    const nonrefundableApplied = Math.min(nonrefundableTentative, liability);
    return {
      aotc,
      llc,
      refundable,
      nonrefundableApplied,
      benefit: refundable + nonrefundableApplied,
    };
  };
  const eligible = students.filter((s) => s.aotcEligible);
  const others = students.filter((s) => !s.aotcEligible);
  const sumExpenses = (list: IndependentStudent[]): number =>
    list.reduce((a, s) => a + Math.max(0, s.expenses), 0);
  const allocWithAotc = priceAllocation(
    eligible.reduce((a, s) => a + aotcForStudent(s.expenses), 0),
    llcForExpenses(sumExpenses(others)),
  );
  const allocLlcOnly = priceAllocation(0, llcForExpenses(sumExpenses(students)));
  const winner =
    allocLlcOnly.benefit > allocWithAotc.benefit ? allocLlcOnly : allocWithAotc;
  if (winner.benefit <= 0) return none;
  return {
    aotc: roundCent(winner.aotc),
    llc: roundCent(winner.llc),
    choice: winner.aotc > 0 ? "aotc" : "llc",
    nonrefundableApplied: roundCent(winner.nonrefundableApplied),
    refundable: roundCent(winner.refundable),
  };
}

// §55 alternative minimum tax, core scope: AMTI starts from
// regular taxable income and adds back the deduction the
// year actually took — the SALT actually deducted in an
// itemized year, the standard deduction (base + age-65
// add-ons) in a standard year — plus the §151(d)(5)(C)
// senior deduction in both branches. The §55(d) exemption
// phases out at the row's rate above its start, never below
// $0. The tentative tax prices the non-preferential part
// of the taxable excess at 26% up to the row's breakpoint
// and 28% above it, and the preferential part (gains inside
// taxable income, capped at the excess) under the same 0% /
// 15% / 20% staircase as the regular tax, stacked on the
// regular-tax ordinary stack. AMT owed is the excess of
// the tentative tax over the year's regular income tax
// after nonrefundable credits (NIIT excluded from that
// comparison), never below $0. Every §55 figure is
// inflation-indexed and applies as published, undeflated.
function amtIndependent(args: {
  taxableIncome: number;
  deductionTaken: "standard" | "itemized";
  standardDeduction: number;
  itemizedSaltAllowed: number;
  seniorDeduction: number;
  gainsInTaxableIncome: number;
  ordinaryStack: number;
  regularTax: number;
  filingStatus: FilingStatus;
  law: YearLaw;
}): {
  amti: number;
  exemption: number;
  tentativeTax: number;
  owed: number;
} {
  const law = args.law;
  const fs = args.filingStatus;
  const addback =
    (args.deductionTaken === "standard"
      ? Math.max(0, args.standardDeduction)
      : Math.max(0, args.itemizedSaltAllowed)) +
    Math.max(0, args.seniorDeduction);
  const amti = Math.max(0, args.taxableIncome) + addback;
  const phaseOutExcess = Math.max(0, amti - law.amtPhaseOutStart[fs]);
  const exemption = Math.max(
    0,
    law.amtExemption[fs] - (law.amtPhaseOutRatePct / 100) * phaseOutExcess,
  );
  const excess = Math.max(0, amti - exemption);
  const pref = Math.min(excess, Math.max(0, args.gainsInTaxableIncome));
  const ordinaryExcess = excess - pref;
  const atLow = Math.min(ordinaryExcess, law.amtBreakpoint);
  let tentative =
    (law.amtRateLowPct / 100) * atLow +
    (law.amtRateHighPct / 100) * (ordinaryExcess - atLow);
  const zeroSpace = Math.max(0, law.ltcgZeroTop[fs] - args.ordinaryStack);
  const at0 = Math.min(pref, zeroSpace);
  const afterZero = pref - at0;
  const twentySpace = Math.max(
    0,
    law.ltcg20Floor[fs] - args.ordinaryStack - at0,
  );
  const at15 = Math.min(afterZero, twentySpace);
  const at20 = afterZero - at15;
  tentative += 0.15 * at15 + 0.2 * at20;
  const owed = Math.max(0, tentative - Math.max(0, args.regularTax));
  return {
    amti: roundCent(amti),
    exemption: roundCent(exemption),
    tentativeTax: roundCent(tentative),
    owed: roundCent(owed),
  };
}

// RCW 82.87 Washington capital-gains excise: 7% of
// Washington capital gains (the realized long-term gain
// after the standard deduction and the charitable deduction
// — donations above the threshold, capped) plus 2.9% on
// the portion of taxable gains above $1,000,000. The
// $1,000,000 surtax threshold is statute-fixed, so it alone
// deflates; the standard deduction and charitable amounts
// are indexed and stay at their row values. A negative
// gains year owes $0 and carries nothing forward.
function washingtonExciseIndependent(args: {
  ltcg: number;
  charitableDonations?: number;
  law: YearLaw;
  deflationFactor?: number;
}): {
  waGains: number;
  standardDeduction: number;
  charitableDeduction: number;
  taxableGains: number;
  tax: number;
} {
  const waGains = Math.max(0, args.ltcg);
  const donations = Math.max(0, args.charitableDonations ?? 0);
  const charitableDeduction = Math.min(
    args.law.waCharitableCap,
    Math.max(0, donations - args.law.waCharitableThreshold),
  );
  const taxableGains = Math.max(
    0,
    waGains - args.law.waStandardDeduction - charitableDeduction,
  );
  const surtaxThreshold =
    args.law.waAdditionalThreshold * (args.deflationFactor ?? 1);
  const atBase = Math.min(taxableGains, surtaxThreshold);
  const above = taxableGains - atBase;
  const tax =
    (args.law.waRatePct / 100) * atBase +
    ((args.law.waRatePct + args.law.waAdditionalRatePct) / 100) * above;
  return {
    waGains: roundCent(waGains),
    standardDeduction: roundCent(args.law.waStandardDeduction),
    charitableDeduction: roundCent(charitableDeduction),
    taxableGains: roundCent(taxableGains),
    tax: roundCent(tax),
  };
}

// The MAGI ceiling of IRMAA tier `tierIndex` under a law
// row, in today's dollars. Only the second-to-last tier's
// ceiling (the top tier's floor, $500,000 single / $750,000
// joint) adjusts: fixed by statute through 2028, then
// indexed, so in today's dollars it deflates only for the
// steps through 2028 counted from the row's own year.
// Tiers 0–3 are indexed figures and stay at their raw
// values. This is the single source for that deflated
// floor, shared by the tier classifier below.
export function irmaaTierCeilingIndependent(
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
      Math.max(0, calendarYear - law.year),
      Math.max(0, 2028 - law.year),
    );
    upTo = upTo / Math.pow(1 + inflationPct / 100, deflYears);
  }
  return upTo;
}

// IRMAA tier index (0 = no surcharge … 5 = top tier) for a
// MAGI, under a law row's tiers. Head of household uses the
// single thresholds. The second-highest tier's stored top
// is the whole dollar BELOW the top tier's statutory floor
// ($499,999 under the $500,000 single floor; $749,999
// under the $750,000 joint floor): the top tier starts AT
// the floor, so a fractional MAGI strictly between the
// stored top and the floor ($499,999.50 single,
// $749,999.50 joint) lands in THIS tier, while exactly
// $500,000 / $750,000 lands in the top tier. In deflated
// years the boundary stays the deflated stored top.
export function irmaaTierIndependent(
  magi: number,
  filingStatus: FilingStatus,
  law: YearLaw,
  calendarYear: number,
  inflationPct: number,
): number {
  const tiers = law.irmaaTiers;
  for (let i = 0; i < tiers.length; i++) {
    const upTo = irmaaTierCeilingIndependent(
      i,
      filingStatus,
      law,
      calendarYear,
      inflationPct,
    );
    if (i === tiers.length - 2 && Number.isFinite(upTo)) {
      const tier = tiers[i];
      const rawUpTo = tier
        ? filingStatus === "mfj"
          ? tier.upToMfj
          : tier.upToSingle
        : upTo;
      if (upTo === rawUpTo) {
        if (magi < rawUpTo + 1) return i;
        continue;
      }
      if (magi <= upTo) return i;
      continue;
    }
    if (magi <= upTo) return i;
  }
  return tiers.length - 1;
}

// The independent single-year pricer. Prices one year from
// the law tables only — see the module header for the
// independence contract and the derivation sources.
export function priceYearIndependent(
  input: IndependentYearInput,
): IndependentYearResult {
  const law = lawForYear(input.calendarYear);
  const fs = input.filingStatus;
  const defl = deflateYears(input.calendarYear, law.year, input.inflationPct);

  const interestIncome = input.interestIncome ?? 0;
  const ordinaryDividends = input.ordinaryDividends ?? 0;
  const capitalLossAllowance = input.capitalLossAllowance ?? 0;
  // Capital netting (§§1222 / 1211(b) / 1(h)): gains and
  // losses net against EACH OTHER only. A net capital loss
  // never reduces qualified dividends — the dividends stay
  // whole in the preferential stack, and the loss reaches
  // ordinary income only through the §1211(b) allowance
  // passed in (subtracted in agiExclSs below).
  const gainsStack = Math.max(0, input.ltcg) + (input.qualifiedDividends ?? 0);
  const agiExclSs =
    input.otherOrdinary +
    input.rmd +
    input.conversion +
    input.extraPreTaxDraw +
    gainsStack +
    interestIncome +
    ordinaryDividends -
    capitalLossAllowance;
  const provisional =
    agiExclSs + input.taxExemptInterest + 0.5 * input.ssBenefits;
  const ssTaxable = taxableSocialSecurity(
    input.ssBenefits,
    provisional,
    fs,
    defl,
  );
  // AGI is final when struck here: the §170(p)
  // non-itemizer charitable deduction is below the line
  // (§63(b)(4)) — it never reduces AGI, MAGI, or ACA MAGI.
  const agi = agiExclSs + ssTaxable;
  const magi = agi + input.taxExemptInterest;
  const acaMagi = magi + (input.ssBenefits - ssTaxable);

  const count65 =
    (input.agePrimary >= 65 ? 1 : 0) +
    (fs === "mfj" && input.ageSpouse != null && input.ageSpouse >= 65 ? 1 : 0);
  const standardDeduction =
    law.standardDeduction[fs] + law.age65Addon[fs] * count65;
  const seniorDeduction = seniorDeductionFor(
    input.calendarYear,
    count65,
    agi,
    fs,
    defl,
  );

  // Deduction greater-of (IRC §63): the standard side
  // (base + age-65+ add-ons) against the itemized total
  // (mortgage interest + SALT after its cap + charitable
  // after floor and ceiling + other, then the §68
  // reduction). The §151(d)(5)(C) senior deduction applies
  // on top of whichever side wins. The §170(p)
  // non-itemizer charitable deduction sits on the standard
  // side only, below the line.
  const saltEntered = Math.max(0, input.itemizedSaltPaid ?? 0);
  const saltCapApplied = saltCapFor(
    input.calendarYear,
    agi,
    law,
    defl,
    input.inflationPct,
  );
  const itemizedSaltAllowed = Math.min(saltEntered, saltCapApplied);
  const deductionTrioApplies = input.calendarYear >= DEDUCTION_2026.firstYear;
  const charitableEntered = Math.max(0, input.itemizedCharitable ?? 0);
  const charitableFloor = deductionTrioApplies
    ? (DEDUCTION_2026.charitableFloorRatePct / 100) * agi
    : 0;
  // §170(b)(1)(G) 60% ceiling, every law year: the floor is
  // applied to the entered input first, the ceiling then
  // caps the after-floor amount.
  const itemizedCharitableAllowed = Math.min(
    Math.max(0, charitableEntered - charitableFloor),
    (CHARITABLE_CEILING.ratePct / 100) * agi,
  );
  const itemizedBefore68 =
    Math.max(0, input.itemizedMortgageInterest ?? 0) +
    itemizedSaltAllowed +
    itemizedCharitableAllowed +
    Math.max(0, input.itemizedOther ?? 0);
  const taxableWithout68 = Math.max(
    0,
    agi - itemizedBefore68 - seniorDeduction,
  );
  let section68Reduction = 0;
  if (deductionTrioApplies && itemizedBefore68 > 0) {
    const tops = law.brackets[fs];
    const threshold37 = tops[tops.length - 2] ?? Infinity;
    const excess68 = Math.max(
      0,
      taxableWithout68 + itemizedBefore68 - threshold37,
    );
    section68Reduction =
      (DEDUCTION_2026.section68Numerator /
        DEDUCTION_2026.section68Denominator) *
      Math.min(itemizedBefore68, excess68);
  }
  const itemizedDeduction = itemizedBefore68 - section68Reduction;
  const section170pCandidate = deductionTrioApplies
    ? Math.min(
        charitableEntered,
        DEDUCTION_2026.nonItemizerCharitableCap[fs] * defl,
      )
    : 0;
  const standardEffect =
    standardDeduction + section170pCandidate + seniorDeduction;
  const itemizedEffect = itemizedDeduction + seniorDeduction;
  const deductionTaken: "standard" | "itemized" =
    itemizedEffect > standardEffect ? "itemized" : "standard";
  let nonItemizerCharitableDeduction = 0;
  let deductions: number;
  if (deductionTaken === "itemized") {
    deductions = itemizedDeduction + seniorDeduction;
  } else {
    nonItemizerCharitableDeduction = section170pCandidate;
    deductions =
      standardDeduction + section170pCandidate + seniorDeduction;
  }
  const taxableIncome = Math.max(0, agi - deductions);

  const gainsInTi = Math.min(gainsStack, taxableIncome);
  const ordinaryTi = taxableIncome - gainsInTi;
  const ordinaryTax = ordinaryBracketTax(ordinaryTi, law, fs);
  const bracketLayers: IndependentBracketLayer[] = [];
  {
    let prev = 0;
    for (let i = 0; i < law.brackets[fs].length; i++) {
      const top = law.brackets[fs][i] ?? Infinity;
      if (ordinaryTi <= prev) break;
      const amount = Math.min(ordinaryTi, top) - prev;
      const ratePct = law.rates[i] ?? 0;
      bracketLayers.push({
        ratePct,
        from: roundCent(prev),
        to: Number.isFinite(top) ? top : null,
        amount: roundCent(amount),
        tax: roundCent(amount * (ratePct / 100)),
      });
      prev = top;
    }
  }
  // The preferential staircase: the 0% space is what the
  // year's LTCG zero top leaves after the ordinary stack;
  // the 15% space runs to the 20% floor; the rest is 20%.
  const zeroSpace = Math.max(0, law.ltcgZeroTop[fs] - ordinaryTi);
  const at0 = Math.min(gainsInTi, zeroSpace);
  const afterZero = gainsInTi - at0;
  const twentySpace = Math.max(0, law.ltcg20Floor[fs] - ordinaryTi - at0);
  const at15 = Math.min(afterZero, twentySpace);
  const at20 = afterZero - at15;
  const ltcgTax = 0.15 * at15 + 0.2 * at20;

  // §1411 NIIT: the base is net investment income — gross
  // interest and dividends (qualified or not) plus net
  // gain — minus the allowable net capital loss on a loss
  // year, floored at $0; the tax is 3.8% of the lesser of
  // that base and the MAGI over the (deflated) threshold.
  // §1411 MAGI adds back only foreign-income exclusions
  // (none modeled), so the threshold is tested against AGI.
  const niitBase = Math.max(
    0,
    gainsStack +
      interestIncome +
      ordinaryDividends -
      (input.ltcg < 0 ? capitalLossAllowance : 0),
  );
  const niit =
    (law.niitRate / 100) *
    Math.min(niitBase, Math.max(0, agi - law.niitThreshold[fs] * defl));

  const education = educationCreditsIndependent({
    students: input.educationStudents,
    filingStatus: fs,
    agi,
    taxBeforeCredits: ordinaryTax + ltcgTax,
    law,
    defl,
  });
  const regularTaxAfterCredits = Math.max(
    0,
    ordinaryTax + ltcgTax - education.nonrefundableApplied,
  );

  // The AMT tentative computation keeps using the UNREDUCED
  // figures: in an itemized year it prices on the taxable
  // income determined WITHOUT regard to §68, so the §68
  // reduction moves the regular tax only, never the
  // tentative minimum tax. The preferential staircase
  // stacks on the REGULAR ordinary stack, not on the AMT
  // excess's ordinary portion.
  const taxableForAmt =
    deductionTaken === "itemized" ? taxableWithout68 : taxableIncome;
  const amt = amtIndependent({
    taxableIncome: taxableForAmt,
    deductionTaken,
    standardDeduction,
    itemizedSaltAllowed,
    seniorDeduction,
    gainsInTaxableIncome: Math.min(gainsStack, taxableForAmt),
    ordinaryStack: ordinaryTi,
    regularTax: regularTaxAfterCredits,
    filingStatus: fs,
    law,
  });
  const federalTax = regularTaxAfterCredits + niit + amt.owed;

  // State tax: a Washington-resident year prices the
  // capital-gains excise on the year's realized long-term
  // gains INSTEAD of the flat rate; any other residence
  // keeps the flat stateRatePct on federal taxable income.
  // The excise base is the ledger-adjusted base when the
  // caller supplies it, else the priced ltcg itself.
  const wa =
    input.residenceState === "WA"
      ? washingtonExciseIndependent({
          ltcg: input.waGainsBase ?? input.ltcg,
          charitableDonations: input.itemizedCharitable,
          law,
          deflationFactor: defl,
        })
      : null;
  const stateTax = wa ? wa.tax : (input.stateRatePct / 100) * taxableIncome;

  return {
    provisionalIncome: roundCent(provisional),
    ssTaxable: roundCent(ssTaxable),
    agi: roundCent(agi),
    magi: roundCent(magi),
    acaMagi: roundCent(acaMagi),
    standardDeduction: roundCent(standardDeduction),
    seniorDeduction: roundCent(seniorDeduction),
    itemizedDeduction: roundCent(itemizedDeduction),
    itemizedSaltAllowed: roundCent(itemizedSaltAllowed),
    itemizedSaltCap: roundCent(saltCapApplied),
    itemizedCharitableAllowed: roundCent(itemizedCharitableAllowed),
    section68Reduction: roundCent(section68Reduction),
    nonItemizerCharitableDeduction: roundCent(nonItemizerCharitableDeduction),
    deductionTaken,
    deductions: roundCent(deductions),
    taxableIncome: roundCent(taxableIncome),
    taxableIncomeBeforeLossAllowance: roundCent(
      Math.max(0, agi - deductions + capitalLossAllowance),
    ),
    ordinaryTax: roundCent(ordinaryTax),
    ltcgTax: roundCent(ltcgTax),
    niit: roundCent(niit),
    federalTax: roundCent(federalTax),
    stateTax: roundCent(stateTax),
    waGains: wa ? wa.waGains : 0,
    waStandardDeduction: wa ? wa.standardDeduction : 0,
    waCharitableDeduction: wa ? wa.charitableDeduction : 0,
    waTaxableGains: wa ? wa.taxableGains : 0,
    educationAotc: education.aotc,
    educationLlc: education.llc,
    educationChoice: education.choice,
    educationNonrefundable: education.nonrefundableApplied,
    educationRefundable: education.refundable,
    amti: amt.amti,
    amtExemption: amt.exemption,
    amtTentativeTax: amt.tentativeTax,
    amtOwed: amt.owed,
    marginalBracketPct: ordinaryMarginalRate(ordinaryTi, law, fs),
    irmaaTier: irmaaTierIndependent(magi, fs, law, input.calendarYear, input.inflationPct),
    baseStandardDeduction: roundCent(law.standardDeduction[fs]),
    age65AddonTotal: roundCent(law.age65Addon[fs] * count65),
    count65,
    ordinaryTaxableIncome: roundCent(ordinaryTi),
    gainsInTaxableIncome: roundCent(gainsInTi),
    bracketLayers,
    gainsAt0: roundCent(at0),
    gainsAt15: roundCent(at15),
    gainsAt20: roundCent(at20),
  };
}
