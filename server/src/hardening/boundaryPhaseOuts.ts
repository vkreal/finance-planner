/* ---------------- AMT / §25A / §86 / NIIT boundary pins ----------------
   Part 2 of the hardening block (boundary-case fixture
   pack). Pins the four phase-outs:

   · AMT (IRC §55, amtFor via priceYear and directly):
     add-back is the standard deduction in a standard
     year, the itemized SALT actually allowed in an
     itemized year, plus the senior deduction in both;
     AMTI = taxable income + add-back; the exemption is
     max(0, exemption − rate% × max(0, AMTI − phase-out
     start)); tentative tax is 26% up to the breakpoint
     and 28% above, with the gains staircase on the
     preferential part. 2026 MFJ exemption $140,200 from
     $1,000,000 at 50%; 2025 MFJ $137,000 from $1,252,700
     at 25%. At the breakpoint the tentative tax is
     pinned, NOT the amount owed — at the breakpoint the
     regular tax exceeds the tentative tax, so the amount
     owed is $0 (probe-verified).
   · Education (§25A, educationCreditsFor via priceYear
     and directly): phase-out on AGI, start MFJ $160,000
     (single and head of household: half the MFJ start),
     width MFJ $20,000 / single and head of household
     $10,000;
     keep = 1 − min(1, max(0, AGI − start) / width).
     AOTC max $2,500 per student, 40% refundable; LLC
     20% of the first $10,000 per return. Better-of
     allocations (A: AOTC for eligible students + LLC
     for the others; B: LLC for all; tie goes to A).
   · Social Security (§86, ssTaxableAmount via priceYear
     and directly): thresholds MFJ $32,000 / $44,000,
     single and head of household $25,000 / $34,000.
     Provisional income = AGI excluding Social Security
     + tax-exempt interest + 50% of benefits.
   · NIIT (§1411, via priceYear): threshold MFJ
     $250,000 / single and head of household $200,000
     (statutory, deflated in today's dollars); NIIT =
     3.8% × min(base, max(0, AGI − threshold)) with base
     = gains stack + interest + non-qualified dividends
     − allowable loss, floored at $0. The test runs on
     AGI, not MAGI: tax-exempt interest raises MAGI but
     not AGI, so it leaves NIIT at $0.

   A pin that fails against the engine is a FINDING; this
   module never adjusts a pin to make it pass. */

import {
  amtFor,
  educationCreditsFor,
  priceYear,
  ssTaxableAmount,
} from "../taxEngine";
import type { EducationStudent, PriceYearInput } from "../taxEngine";
import { TAX_LAW_2025, TAX_LAW_2026 } from "../taxLaw";
import type { FilingStatus, YearLaw } from "../taxLaw";
import type {
  HardeningCheckModule,
  HardeningCheckResult,
  HardeningTeethResult,
} from "./types";

type FS = FilingStatus;

const CENT = 0.01;
// A 1-cent difference is a failure; half a cent of float
// noise is not.
const TOL = 0.005;

type PinFailure = string;

type Corrupt = { caseId: string; field: string; delta: number };

function checkEq(
  failures: PinFailure[],
  caseId: string,
  label: string,
  actual: number | string,
  expected: number | string,
  corrupt?: Corrupt,
): void {
  let exp = expected;
  if (
    corrupt &&
    corrupt.caseId === caseId &&
    corrupt.field === label &&
    typeof exp === "number"
  ) {
    exp = exp + corrupt.delta;
  }
  const ok =
    typeof actual === "number" && typeof exp === "number"
      ? Math.abs(actual - exp) <= TOL
      : actual === exp;
  if (!ok) {
    failures.push(`${caseId} ${label}: actual=${actual} expected=${exp}`);
  }
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

function baseInput(
  year: number,
  fs: FS,
  over: Partial<PriceYearInput> = {},
): PriceYearInput {
  return {
    calendarYear: year,
    filingStatus: fs,
    agePrimary: 60,
    ageSpouse: fs === "mfj" ? 58 : null,
    otherOrdinary: 0,
    rmd: 0,
    conversion: 0,
    extraPreTaxDraw: 0,
    ssBenefits: 0,
    taxExemptInterest: 0,
    ltcg: 0,
    interestIncome: 0,
    ordinaryDividends: 0,
    qualifiedDividends: 0,
    capitalLossAllowance: 0,
    inflationPct: 2.5,
    stateRatePct: 0,
    residenceState: "other",
    ...over,
  };
}

// The fast set: every briefed pin, plus single / head of
// household spots for the AMT, education, §86, and NIIT
// phase-outs, the direct amtFor add-back and gains
// staircase, the better-of education allocation, the
// tax-exempt-interest leg of provisional income, the
// NIIT AGI-vs-MAGI distinction, and the loss allowance
// shrinking the NIIT base.
function runFastSet(corrupt?: Corrupt): {
  failures: PinFailure[];
  counts: Record<string, number>;
} {
  const failures: PinFailure[] = [];
  let pins = 0;
  let cases = 0;

  // ---------- AMT via priceYear (standard, no senior, no gains: AMTI = AGI) ----------
  const amtCases: {
    year: number;
    fs: FS;
    otherOrdinary: number;
    exemption: number;
    tentative?: number;
    owed?: number;
  }[] = [
    { year: 2026, fs: "mfj", otherOrdinary: 1000000, exemption: 140200 },
    { year: 2026, fs: "mfj", otherOrdinary: 1000001, exemption: 140199.5 },
    { year: 2026, fs: "mfj", otherOrdinary: 1000002, exemption: 140199 },
    { year: 2026, fs: "mfj", otherOrdinary: 1280400, exemption: 0 },
    { year: 2026, fs: "mfj", otherOrdinary: 1280399, exemption: 0.5 },
    { year: 2026, fs: "mfj", otherOrdinary: 384700, exemption: 140200, tentative: 63570, owed: 0 },
    { year: 2026, fs: "mfj", otherOrdinary: 384701, exemption: 140200, tentative: 63570.28 },
    { year: 2025, fs: "mfj", otherOrdinary: 376100, exemption: 137000, tentative: 62166, owed: 0 },
    { year: 2025, fs: "mfj", otherOrdinary: 376101, exemption: 137000, tentative: 62166.28 },
    { year: 2025, fs: "mfj", otherOrdinary: 1252700, exemption: 137000 },
    { year: 2025, fs: "mfj", otherOrdinary: 1252701, exemption: 136999.75 },
    { year: 2026, fs: "single", otherOrdinary: 500000, exemption: 90100 },
    { year: 2026, fs: "single", otherOrdinary: 500001, exemption: 90099.5 },
    { year: 2026, fs: "single", otherOrdinary: 680200, exemption: 0 },
    { year: 2026, fs: "single", otherOrdinary: 680199, exemption: 0.5 },
  ];
  for (const c of amtCases) {
    const p = priceYear(baseInput(c.year, c.fs, { otherOrdinary: c.otherOrdinary }));
    const caseId = `amt ${c.year} ${c.fs} otherOrdinary ${c.otherOrdinary}`;
    cases++;
    checkEq(failures, caseId, "amtExemption", p.amtExemption, c.exemption, corrupt);
    pins++;
    if (c.tentative !== undefined) {
      checkEq(failures, caseId, "amtTentativeTax", p.amtTentativeTax, c.tentative, corrupt);
      pins++;
    }
    if (c.owed !== undefined) {
      checkEq(failures, caseId, "amtOwed", p.amtOwed, c.owed, corrupt);
      pins++;
    }
  }

  // ---------- AMT via amtFor directly ----------
  const amtDirect: {
    caseId: string;
    args: Parameters<typeof amtFor>[0];
    amti: number;
    exemption: number;
    tentative: number;
    owed: number;
  }[] = [
    {
      caseId: "amtFor standard addback mfj 2026",
      args: {
        taxableIncome: 100000, deductionTaken: "standard",
        standardDeduction: 32200, itemizedSaltAllowed: 0,
        seniorDeduction: 0, gainsInTaxableIncome: 0,
        ordinaryStack: 100000, regularTax: 0,
        filingStatus: "mfj", law: TAX_LAW_2026,
      },
      amti: 132200, exemption: 140200, tentative: 0, owed: 0,
    },
    {
      caseId: "amtFor itemized SALT addback mfj 2026",
      args: {
        taxableIncome: 100000, deductionTaken: "itemized",
        standardDeduction: 32200, itemizedSaltAllowed: 40400,
        seniorDeduction: 0, gainsInTaxableIncome: 0,
        ordinaryStack: 100000, regularTax: 0,
        filingStatus: "mfj", law: TAX_LAW_2026,
      },
      amti: 140400, exemption: 140200, tentative: 52, owed: 52,
    },
    {
      caseId: "amtFor senior addback both branches mfj 2026",
      args: {
        taxableIncome: 100000, deductionTaken: "standard",
        standardDeduction: 32200, itemizedSaltAllowed: 0,
        seniorDeduction: 6000, gainsInTaxableIncome: 0,
        ordinaryStack: 100000, regularTax: 0,
        filingStatus: "mfj", law: TAX_LAW_2026,
      },
      amti: 138200, exemption: 140200, tentative: 0, owed: 0,
    },
    {
      // Preferential part: zero space is consumed by the
      // regular ordinary stack (150,000 > zero top
      // 98,900), so all $50,000 of gains price at 15%:
      // 26% x 42,000 + 15% x 50,000 = 18,420.
      caseId: "amtFor gains staircase mfj 2026",
      args: {
        taxableIncome: 200000, deductionTaken: "standard",
        standardDeduction: 32200, itemizedSaltAllowed: 0,
        seniorDeduction: 0, gainsInTaxableIncome: 50000,
        ordinaryStack: 150000, regularTax: 0,
        filingStatus: "mfj", law: TAX_LAW_2026,
      },
      amti: 232200, exemption: 140200, tentative: 18420, owed: 18420,
    },
    {
      caseId: "amtFor 2025 phase-out rate 25% mfj",
      args: {
        taxableIncome: 1221200, deductionTaken: "standard",
        standardDeduction: 31500, itemizedSaltAllowed: 0,
        seniorDeduction: 0, gainsInTaxableIncome: 0,
        ordinaryStack: 1221200, regularTax: 0,
        filingStatus: "mfj", law: TAX_LAW_2025,
      },
      // Excess $1,115,700: 26% x 239,100 + 28% x 876,600
      // = 62,166 + 245,448 = 307,614.
      amti: 1252700, exemption: 137000, tentative: 307614, owed: 307614,
    },
  ];
  for (const c of amtDirect) {
    const r = amtFor(c.args);
    cases++;
    checkEq(failures, c.caseId, "amti", r.amti, c.amti, corrupt);
    pins++;
    checkEq(failures, c.caseId, "exemption", r.exemption, c.exemption, corrupt);
    pins++;
    checkEq(failures, c.caseId, "tentativeTax", r.tentativeTax, c.tentative, corrupt);
    pins++;
    checkEq(failures, c.caseId, "owed", r.owed, c.owed, corrupt);
    pins++;
  }

  // ---------- Education via priceYear ----------
  const edu = (
    year: number,
    fs: FS,
    agi: number,
    students: EducationStudent[],
  ) =>
    priceYear(
      baseInput(year, fs, { otherOrdinary: agi, educationStudents: students }),
    );
  const aotcStudent: EducationStudent = { expenses: 4000, aotcEligible: true };
  const llcStudent: EducationStudent = { expenses: 10000, aotcEligible: false };
  const eduCases: {
    caseId: string;
    result: ReturnType<typeof priceYear>;
    aotc: number;
    llc: number;
    choice: "aotc" | "llc" | "none";
    refundable: number;
    nonrefundable: number;
  }[] = [
    {
      caseId: "edu aotc mfj 2026 AGI 160000",
      result: edu(2026, "mfj", 160000, [aotcStudent]),
      aotc: 2500, llc: 0, choice: "aotc", refundable: 1000, nonrefundable: 1500,
    },
    {
      caseId: "edu aotc mfj 2026 midpoint",
      result: edu(2026, "mfj", 170 * 1000, [aotcStudent]),
      aotc: 1250, llc: 0, choice: "aotc", refundable: 500, nonrefundable: 750,
    },
    {
      caseId: "edu aotc mfj 2026 AGI 180000",
      result: edu(2026, "mfj", 180000, [aotcStudent]),
      aotc: 0, llc: 0, choice: "none", refundable: 0, nonrefundable: 0,
    },
    {
      caseId: "edu aotc mfj 2026 AGI 159999",
      result: edu(2026, "mfj", 159999, [aotcStudent]),
      aotc: 2500, llc: 0, choice: "aotc", refundable: 1000, nonrefundable: 1500,
    },
    {
      caseId: "edu llc mfj 2026 AGI 160000",
      result: edu(2026, "mfj", 160000, [llcStudent]),
      aotc: 0, llc: 2000, choice: "llc", refundable: 0, nonrefundable: 2000,
    },
    {
      caseId: "edu llc mfj 2026 midpoint",
      result: edu(2026, "mfj", 170 * 1000, [llcStudent]),
      aotc: 0, llc: 1000, choice: "llc", refundable: 0, nonrefundable: 1000,
    },
    {
      caseId: "edu llc mfj 2026 AGI 180000",
      result: edu(2026, "mfj", 180000, [llcStudent]),
      aotc: 0, llc: 0, choice: "none", refundable: 0, nonrefundable: 0,
    },
    {
      caseId: "edu aotc single 2026 at start",
      result: edu(2026, "single", 80 * 1000, [aotcStudent]),
      aotc: 2500, llc: 0, choice: "aotc", refundable: 1000, nonrefundable: 1500,
    },
    {
      caseId: "edu aotc single 2026 midpoint",
      result: edu(2026, "single", 85 * 1000, [aotcStudent]),
      aotc: 1250, llc: 0, choice: "aotc", refundable: 500, nonrefundable: 750,
    },
    {
      caseId: "edu aotc single 2026 at end",
      result: edu(2026, "single", 90 * 1000, [aotcStudent]),
      aotc: 0, llc: 0, choice: "none", refundable: 0, nonrefundable: 0,
    },
    {
      caseId: "edu aotc hoh 2026 AGI 85000",
      result: edu(2026, "hoh", 85000, [aotcStudent]),
      aotc: 1250, llc: 0, choice: "aotc", refundable: 500, nonrefundable: 750,
    },
    {
      // Better-of: allocation A (AOTC $2,500 + LLC $2,000)
      // beats allocation B (LLC $2,000 on the combined
      // expenses, capped at $10,000).
      caseId: "edu better-of mfj 2026 AGI 160000",
      result: edu(2026, "mfj", 160000, [aotcStudent, llcStudent]),
      aotc: 2500, llc: 2000, choice: "aotc", refundable: 1000, nonrefundable: 3500,
    },
  ];
  for (const c of eduCases) {
    cases++;
    checkEq(failures, c.caseId, "educationAotc", c.result.educationAotc, c.aotc, corrupt);
    pins++;
    checkEq(failures, c.caseId, "educationLlc", c.result.educationLlc, c.llc, corrupt);
    pins++;
    checkEq(failures, c.caseId, "educationChoice", c.result.educationChoice, c.choice, corrupt);
    pins++;
    checkEq(failures, c.caseId, "educationRefundable", c.result.educationRefundable, c.refundable, corrupt);
    pins++;
    checkEq(failures, c.caseId, "educationNonrefundable", c.result.educationNonrefundable, c.nonrefundable, corrupt);
    pins++;
  }
  // Direct educationCreditsFor pin (same midpoint, priced
  // without the year pricer in the loop).
  {
    const r = educationCreditsFor({
      students: [aotcStudent],
      filingStatus: "mfj",
      agi: 170 * 1000,
      taxBeforeCredits: 100000,
      law: TAX_LAW_2026,
      defl: 1,
    });
    const caseId = "educationCreditsFor mfj 2026 midpoint";
    cases++;
    checkEq(failures, caseId, "aotc", r.aotc, 1250, corrupt);
    pins++;
    checkEq(failures, caseId, "refundable", r.refundable, 500, corrupt);
    pins++;
    checkEq(failures, caseId, "nonrefundableApplied", r.nonrefundableApplied, 750, corrupt);
    pins++;
    checkEq(failures, caseId, "choice", r.choice, "aotc", corrupt);
    pins++;
  }

  // ---------- Social Security §86 via priceYear ----------
  const ssCases: {
    caseId: string;
    result: ReturnType<typeof priceYear>;
    provisional: number;
    ssTaxable: number;
  }[] = [
    {
      caseId: "ss86 mfj SS 60000 provisional 32000",
      result: priceYear(baseInput(2026, "mfj", { otherOrdinary: 2000, ssBenefits: 60000 })),
      provisional: 32000, ssTaxable: 0,
    },
    {
      caseId: "ss86 mfj SS 60000 provisional 32001",
      result: priceYear(baseInput(2026, "mfj", { otherOrdinary: 2001, ssBenefits: 60000 })),
      provisional: 32001, ssTaxable: 0.5,
    },
    {
      caseId: "ss86 mfj SS 60000 provisional 44000",
      result: priceYear(baseInput(2026, "mfj", { otherOrdinary: 14 * 1000, ssBenefits: 60000 })),
      provisional: 44000, ssTaxable: 6000,
    },
    {
      caseId: "ss86 mfj SS 60000 provisional 44001",
      result: priceYear(baseInput(2026, "mfj", { otherOrdinary: 14 * 1000 + 1, ssBenefits: 60000 })),
      provisional: 44001, ssTaxable: 6000.85,
    },
    {
      caseId: "ss86 single SS 40000 provisional 25000",
      result: priceYear(baseInput(2026, "single", { otherOrdinary: 5000, ssBenefits: 40000 })),
      provisional: 25000, ssTaxable: 0,
    },
    {
      caseId: "ss86 single SS 40000 provisional 25001",
      result: priceYear(baseInput(2026, "single", { otherOrdinary: 5001, ssBenefits: 40000 })),
      provisional: 25001, ssTaxable: 0.5,
    },
    {
      caseId: "ss86 single SS 40000 provisional 34000",
      result: priceYear(baseInput(2026, "single", { otherOrdinary: 14 * 1000, ssBenefits: 40000 })),
      provisional: 34000, ssTaxable: 4500,
    },
    {
      caseId: "ss86 single SS 40000 provisional 34001",
      result: priceYear(baseInput(2026, "single", { otherOrdinary: 14 * 1000 + 1, ssBenefits: 40000 })),
      provisional: 34001, ssTaxable: 4500.85,
    },
    {
      // Tax-exempt interest enters provisional income:
      // $2,000 of it plus 50% of $60,000 lands exactly on
      // the $32,000 first threshold.
      caseId: "ss86 mfj tax-exempt 2000 provisional 32000",
      result: priceYear(baseInput(2026, "mfj", { taxExemptInterest: 2000, ssBenefits: 60000 })),
      provisional: 32000, ssTaxable: 0,
    },
    {
      caseId: "ss86 mfj tax-exempt 2001 provisional 32001",
      result: priceYear(baseInput(2026, "mfj", { taxExemptInterest: 2001, ssBenefits: 60000 })),
      provisional: 32001, ssTaxable: 0.5,
    },
  ];
  for (const c of ssCases) {
    cases++;
    checkEq(failures, c.caseId, "provisionalIncome", c.result.provisionalIncome, c.provisional, corrupt);
    pins++;
    checkEq(failures, c.caseId, "ssTaxable", c.result.ssTaxable, c.ssTaxable, corrupt);
    pins++;
  }
  // Direct ssTaxableAmount pins.
  for (const [benefits, provisional, fs, taxable] of [
    [60000, 32000, "mfj", 0],
    [60000, 32001, "mfj", 0.5],
    [60000, 44000, "mfj", 6000],
    [60000, 44001, "mfj", 6000.85],
    [40000, 25000, "single", 0],
    [40000, 25001, "single", 0.5],
    [40000, 34000, "single", 4500],
    [40000, 34001, "single", 4500.85],
  ] as const) {
    const caseId = `ssTaxableAmount ${fs} benefits ${benefits} provisional ${provisional}`;
    cases++;
    checkEq(
      failures,
      caseId,
      "ssTaxable",
      ssTaxableAmount(benefits, provisional, fs, 1),
      taxable,
      corrupt,
    );
    pins++;
  }

  // ---------- NIIT via priceYear ----------
  const niitCases: {
    caseId: string;
    input: Partial<PriceYearInput> & { filingStatus: FS; calendarYear: number };
    agi: number;
    magi: number;
    niit: number;
  }[] = [
    {
      caseId: "niit mfj AGI 250000",
      input: { calendarYear: 2026, filingStatus: "mfj", otherOrdinary: 200000, ltcg: 50000 },
      agi: 250000, magi: 250000, niit: 0,
    },
    {
      caseId: "niit mfj AGI 250100",
      input: { calendarYear: 2026, filingStatus: "mfj", otherOrdinary: 200100, ltcg: 50000 },
      agi: 250100, magi: 250100, niit: 3.8,
    },
    {
      caseId: "niit mfj base-capped",
      input: { calendarYear: 2026, filingStatus: "mfj", otherOrdinary: 349000, ltcg: 1000 },
      agi: 350000, magi: 350000, niit: 38,
    },
    {
      caseId: "niit mfj interest-only",
      input: { calendarYear: 2026, filingStatus: "mfj", interestIncome: 300000 },
      agi: 300000, magi: 300000, niit: 1900,
    },
    {
      caseId: "niit single AGI 200100",
      input: { calendarYear: 2026, filingStatus: "single", otherOrdinary: 150100, ltcg: 50000 },
      agi: 200100, magi: 200100, niit: 3.8,
    },
    {
      caseId: "niit hoh AGI 200100",
      input: { calendarYear: 2026, filingStatus: "hoh", otherOrdinary: 150100, ltcg: 50000 },
      agi: 200100, magi: 200100, niit: 3.8,
    },
    {
      // AGI, not MAGI: $250,000 of tax-exempt interest
      // lifts MAGI to $300,000 — over the threshold — but
      // AGI stays $50,000, so NIIT is $0.
      caseId: "niit mfj tax-exempt MAGI 300000 AGI 50000",
      input: { calendarYear: 2026, filingStatus: "mfj", ltcg: 50000, taxExemptInterest: 250000 },
      agi: 50000, magi: 300000, niit: 0,
    },
    {
      // The §1211(b) allowance nets against the NIIT base:
      // base $97,000, AGI over the threshold $47,000, so
      // NIIT is 3.8% of the smaller, $47,000.
      caseId: "niit mfj loss allowance shrinks base",
      input: {
        calendarYear: 2026, filingStatus: "mfj",
        otherOrdinary: 200000, ltcg: -5000,
        interestIncome: 100000, capitalLossAllowance: 3000,
      },
      agi: 297000, magi: 297000, niit: 1786,
    },
  ];
  for (const c of niitCases) {
    const p = priceYear(baseInput(c.input.calendarYear, c.input.filingStatus, c.input));
    cases++;
    checkEq(failures, c.caseId, "agi", p.agi, c.agi, corrupt);
    pins++;
    checkEq(failures, c.caseId, "magi", p.magi, c.magi, corrupt);
    pins++;
    checkEq(failures, c.caseId, "niit", p.niit, c.niit, corrupt);
    pins++;
  }

  return {
    failures,
    counts: { pins, cases, failures: failures.length },
  };
}

// The full set: the fast pins plus complete sweeps.
// · AMT exemption, $1 at a time across the whole
//   phase-out band, MFJ and single, 2026 and 2025
//   (amtFor direct — the phase-out formula itself).
// · Education keep fraction, $1 at a time across the
//   phase-out band, MFJ and single.
// · §86 taxable benefits, $1 at a time across both
//   thresholds, MFJ and single (ssTaxableAmount direct).
// · NIIT, $100 at a time across the threshold, MFJ.
function runFullSet(): {
  failures: PinFailure[];
  counts: Record<string, number>;
} {
  const fast = runFastSet();
  const failures = fast.failures;
  let pins = fast.counts.pins ?? 0;
  let cases = fast.counts.cases ?? 0;
  let swept = 0;

  // AMT exemption sweeps via amtFor.
  const amtSweeps: { law: YearLaw; fs: FS; start: number; rate: number; exemption: number }[] = [
    { law: TAX_LAW_2026, fs: "mfj", start: 1000000, rate: 50, exemption: 140200 },
    { law: TAX_LAW_2026, fs: "single", start: 500000, rate: 50, exemption: 90100 },
    { law: TAX_LAW_2025, fs: "mfj", start: 1252700, rate: 25, exemption: 137000 },
    { law: TAX_LAW_2025, fs: "single", start: 626350, rate: 25, exemption: 88100 },
  ];
  for (const s of amtSweeps) {
    const exhaustion = s.start + (s.exemption / s.rate) * 100;
    for (let amti = s.start - 2; amti <= exhaustion + 2; amti++) {
      const expected = Math.max(0, s.exemption - (s.rate / 100) * Math.max(0, amti - s.start));
      const r = amtFor({
        taxableIncome: amti - 32200,
        deductionTaken: "standard",
        standardDeduction: 32200,
        itemizedSaltAllowed: 0,
        seniorDeduction: 0,
        gainsInTaxableIncome: 0,
        ordinaryStack: amti - 32200,
        regularTax: 0,
        filingStatus: s.fs,
        law: s.law,
      });
      swept++;
      // Taxable income is floored at $0 inside amtFor,
      // so the constructed AMTI is exact for every
      // swept value (all are far above the standard
      // deduction).
      checkEq(
        failures,
        `amt sweep ${s.law.year} ${s.fs} amti ${amti}`,
        "exemption",
        r.exemption,
        r2(expected),
      );
      pins++;
    }
    cases++;
  }

  // Education keep-fraction sweeps via educationCreditsFor.
  // The start / width come from the law row itself here
  // (the fast pins above already pin the row's values
  // literally); the sweep checks the phase-out
  // arithmetic $1 at a time across the band.
  const eduSweeps: { law: YearLaw; fs: FS; start: number; width: number }[] = [
    { law: TAX_LAW_2026, fs: "mfj", start: TAX_LAW_2026.eduPhaseOutStart.mfj, width: TAX_LAW_2026.eduPhaseOutWidth.mfj },
    { law: TAX_LAW_2026, fs: "single", start: TAX_LAW_2026.eduPhaseOutStart.single, width: TAX_LAW_2026.eduPhaseOutWidth.single },
  ];
  const eduStudent: EducationStudent = { expenses: 4000, aotcEligible: true };
  for (const s of eduSweeps) {
    for (let agi = s.start - 10; agi <= s.start + s.width + 10; agi++) {
      const keep = 1 - Math.min(1, Math.max(0, agi - s.start) / s.width);
      const r = educationCreditsFor({
        students: [eduStudent],
        filingStatus: s.fs,
        agi,
        taxBeforeCredits: 100000,
        law: s.law,
        defl: 1,
      });
      swept++;
      checkEq(
        failures,
        `edu sweep ${s.fs} AGI ${agi}`,
        "aotc",
        r.aotc,
        r2(2500 * keep),
      );
      pins++;
      checkEq(
        failures,
        `edu sweep ${s.fs} AGI ${agi}`,
        "refundable",
        r.refundable,
        r2(1000 * keep),
      );
      pins++;
    }
    cases++;
  }

  // §86 sweeps via ssTaxableAmount.
  const ssSweeps: { fs: FS; benefits: number; t1: number; t2: number }[] = [
    { fs: "mfj", benefits: 60000, t1: 32000, t2: 44000 },
    { fs: "single", benefits: 40000, t1: 25000, t2: 34000 },
  ];
  for (const s of ssSweeps) {
    for (let prov = s.t1 - 10; prov <= s.t2 + 2010; prov++) {
      let expected: number;
      if (prov <= s.t1) expected = 0;
      else if (prov <= s.t2) expected = Math.min(0.5 * s.benefits, 0.5 * (prov - s.t1));
      else {
        const base = Math.min(0.5 * s.benefits, 0.5 * (s.t2 - s.t1));
        expected = Math.min(0.85 * s.benefits, base + 0.85 * (prov - s.t2));
      }
      swept++;
      checkEq(
        failures,
        `ss86 sweep ${s.fs} provisional ${prov}`,
        "ssTaxable",
        ssTaxableAmount(s.benefits, prov, s.fs, 1),
        r2(expected),
      );
      pins++;
    }
    cases++;
  }

  // NIIT sweep via priceYear, $100 steps across the MFJ
  // threshold with a $50,000 gains base.
  for (let other = 199900; other <= 260100; other += 100) {
    const agi = other + 50000;
    const expected = 0.038 * Math.min(50000, Math.max(0, agi - 250000));
    const p = priceYear(baseInput(2026, "mfj", { otherOrdinary: other, ltcg: 50000 }));
    swept++;
    checkEq(failures, `niit sweep mfj AGI ${agi}`, "niit", p.niit, r2(expected));
    pins++;
  }
  cases++;

  return {
    failures,
    counts: { pins, cases, swept, failures: failures.length },
  };
}

function resultFrom(
  id: string,
  name: string,
  set: { failures: PinFailure[]; counts: Record<string, number> },
): HardeningCheckResult {
  const pass = set.failures.length === 0;
  return {
    id,
    name,
    pass,
    detail: pass
      ? `AMT / §25A / §86 / NIIT boundary pins all pass: ${set.counts.pins} pins across ${set.counts.cases} cases (AMT exemption phase-out and breakpoint, education phase-out and better-of allocation, §86 thresholds, NIIT threshold and AGI-vs-MAGI distinction).`
      : `${set.failures.length} phase-out pin(s) failed — see failures.`,
    failures: set.failures.slice(0, 25),
    counts: set.counts,
  };
}

function runPhaseOutsFast(): HardeningCheckResult {
  return resultFrom(
    "boundary-phase-outs",
    "Boundary phase-outs: AMT exemption and breakpoint, §25A phase-out, §86 thresholds, NIIT threshold",
    runFastSet(),
  );
}

function runPhaseOutsFull(): HardeningCheckResult {
  return resultFrom(
    "boundary-phase-outs",
    "Boundary phase-outs: AMT exemption and breakpoint, §25A phase-out, §86 thresholds, NIIT threshold",
    runFullSet(),
  );
}

function runPhaseOutsTeeth(): HardeningTeethResult {
  // The clean fast run must pass first.
  const clean = runFastSet();
  if (clean.failures.length !== 0) {
    return {
      corruptedCaseId: "boundary-phase-outs:clean-run-failed",
      failedCount: clean.failures.length,
      pass: false,
    };
  }
  // Corrupt one pin by 1 cent: the MFJ 2026 AMT
  // breakpoint tentative tax, expected $63,570,
  // corrupted to $63,570.01. Exactly that one pin must
  // fail.
  const corruptedCaseId = "amt 2026 mfj otherOrdinary 384700 amtTentativeTax +1c";
  const set = runFastSet({
    caseId: "amt 2026 mfj otherOrdinary 384700",
    field: "amtTentativeTax",
    delta: CENT,
  });
  return {
    corruptedCaseId,
    failedCount: set.failures.length,
    pass: set.failures.length === 1,
  };
}

export const boundaryPhaseOutsCheck: HardeningCheckModule = {
  id: "boundary-phase-outs",
  name: "Boundary phase-outs: AMT exemption and breakpoint, §25A phase-out, §86 thresholds, NIIT threshold",
  runFast: runPhaseOutsFast,
  runFull: runPhaseOutsFull,
  runTeeth: runPhaseOutsTeeth,
};
