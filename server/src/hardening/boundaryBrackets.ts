/* ---------------- Bracket-top boundary pins ----------------
   Part 2 of the hardening block (boundary-case fixture
   pack). Pins the ordinary-income bracket tops: for every
   bracket top, in every filing status, in 2025 and 2026,
   the marginal rate steps AT the top (not a cent above
   it), the +$100 tax step above the top prices at the
   next bracket's rate, and the engine agrees with the
   independent second implementation to the cent at
   top ± 1 cent.

   Marginal semantics (probe-verified against the engine
   before this module was written): marginalRate uses a
   strict `<` against the bracket tops, so at taxable
   income EXACTLY equal to a top the reported marginal
   rate is ALREADY the next bracket's rate — it is the
   rate the next dollar faces. So the pins are:
     top − 1¢ → current bracket's rate
     top      → next bracket's rate
     top + 1¢ → next bracket's rate
   A pin that fails against the engine is a FINDING; this
   module never adjusts a pin to make it pass.

   Construction: ages under 65, no itemized or charitable
   inputs, so the standard deduction is taken and
   otherOrdinary = top + standardDeduction prices
   taxableIncome exactly at the top. The standard
   deductions and tops below are the published law-table
   values, restated here as the pins' expectations so a
   drift in the law table fails loudly instead of
   silently moving the pins. */

import { priceYear } from "../taxEngine";
import type { PriceYearInput } from "../taxEngine";
import type { FilingStatus } from "../taxLaw";
import { lawForYear } from "../taxLaw";
import { priceYearIndependent } from "./secondImplementation";
import type { IndependentYearInput } from "./secondImplementation";
import type {
  HardeningCheckModule,
  HardeningCheckResult,
  HardeningTeethResult,
} from "./types";

type FS = FilingStatus;

const CENT = 0.01;
// A 1-cent difference is a failure; half a cent of float
// noise is not. (All pin values below are exact in binary
// floating point to well under this.)
const TOL = 0.005;

const STANDARD_DEDUCTION: Record<number, Record<FS, number>> = {
  2025: { mfj: 31500, single: 15750, hoh: 23625 },
  2026: { mfj: 32200, single: 16100, hoh: 24150 },
};

// Bracket tops per year per status (the top of each
// bracket; the last entry is the top of the 35% bracket,
// above which the 37% rate applies).
const BRACKET_TOPS: Record<number, Record<FS, number[]>> = {
  2025: {
    mfj: [23850, 96950, 206700, 394600, 501050, 751600],
    single: [11925, 48475, 103350, 197300, 250525, 626350],
    hoh: [17000, 64850, 103350, 197300, 250500, 626350],
  },
  2026: {
    mfj: [24800, 100800, 211400, 403550, 512450, 768700],
    single: [12400, 50400, 105700, 201775, 256225, 640600],
    hoh: [17700, 67450, 105700, 201750, 256200, 640600],
  },
};

// The rate inside each bracket whose top is at the same
// index in BRACKET_TOPS, and the rate the next dollar
// faces once that top is reached.
const BRACKET_RATES = [10, 12, 22, 24, 32, 35];
const NEXT_RATES = [12, 22, 24, 32, 35, 37];

const YEARS = [2025, 2026] as const;
const STATUSES: FS[] = ["mfj", "single", "hoh"];

function baseInput(
  year: number,
  fs: FS,
  otherOrdinary: number,
): PriceYearInput {
  return {
    calendarYear: year,
    filingStatus: fs,
    agePrimary: 60,
    ageSpouse: fs === "mfj" ? 58 : null,
    otherOrdinary,
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
  };
}

function toIndependent(input: PriceYearInput): IndependentYearInput {
  return {
    calendarYear: input.calendarYear,
    filingStatus: input.filingStatus,
    agePrimary: input.agePrimary,
    ageSpouse: input.ageSpouse,
    otherOrdinary: input.otherOrdinary,
    rmd: input.rmd,
    conversion: input.conversion,
    extraPreTaxDraw: input.extraPreTaxDraw,
    ssBenefits: input.ssBenefits,
    taxExemptInterest: input.taxExemptInterest,
    ltcg: input.ltcg,
    interestIncome: 0,
    ordinaryDividends: 0,
    qualifiedDividends: 0,
    capitalLossAllowance: 0,
    inflationPct: input.inflationPct,
    stateRatePct: input.stateRatePct,
    residenceState: "other",
  };
}

type PinFailure = string;

function checkEq(
  failures: PinFailure[],
  caseId: string,
  label: string,
  actual: number,
  expected: number,
): void {
  if (Math.abs(actual - expected) > TOL) {
    failures.push(`${caseId} ${label}: actual=${actual} expected=${expected}`);
  }
}

// All pins for one (year, status, top). `corrupt` optionally
// shifts one expectation by 1 cent so the teeth check can
// prove exactly that pin fails.
function pinTop(
  failures: PinFailure[],
  year: number,
  fs: FS,
  topIndex: number,
  corrupt?: { caseId: string; field: string; delta: number },
): { pins: number; cases: number } {
  const top = BRACKET_TOPS[year]![fs]![topIndex]!;
  const std = STANDARD_DEDUCTION[year]![fs]!;
  const rate = BRACKET_RATES[topIndex]!;
  const next = NEXT_RATES[topIndex]!;
  const caseId = `bracket ${year} ${fs} top ${top}`;
  let pins = 0;
  let cases = 0;

  const expect = (field: string, value: number): number => {
    if (corrupt && corrupt.caseId === caseId && corrupt.field === field) {
      return value + corrupt.delta;
    }
    return value;
  };

  // The law row itself must carry the standard deduction
  // this construction assumes; otherwise the pins below
  // would be pricing a different taxable income.
  const lawStd = lawForYear(year).standardDeduction[fs];
  checkEq(failures, caseId, "lawStandardDeduction", lawStd, std);
  pins++;

  const at = priceYear(baseInput(year, fs, top + std));
  cases++;
  checkEq(failures, caseId, "atTop taxableIncome", at.taxableIncome, expect("taxableIncome", top));
  pins++;
  checkEq(failures, caseId, "atTop standardDeduction", at.standardDeduction, expect("standardDeduction", std));
  pins++;
  checkEq(failures, caseId, "atTop marginalBracketPct", at.marginalBracketPct, expect("marginalAtTop", next));
  pins++;

  const under = priceYear(baseInput(year, fs, top + std - CENT));
  cases++;
  checkEq(failures, caseId, "top-1c taxableIncome", under.taxableIncome, expect("taxableIncomeUnder", top - CENT));
  pins++;
  checkEq(failures, caseId, "top-1c marginalBracketPct", under.marginalBracketPct, expect("marginalUnder", rate));
  pins++;

  const over = priceYear(baseInput(year, fs, top + std + CENT));
  cases++;
  checkEq(failures, caseId, "top+1c taxableIncome", over.taxableIncome, expect("taxableIncomeOver", top + CENT));
  pins++;
  checkEq(failures, caseId, "top+1c marginalBracketPct", over.marginalBracketPct, expect("marginalOver", next));
  pins++;

  // +$100 above the top: the whole $100 sits in the next
  // bracket, so the tax step is next rate x $100.
  const plus100 = priceYear(baseInput(year, fs, top + std + 100));
  cases++;
  checkEq(
    failures,
    caseId,
    "+$100 ordinaryTax step",
    plus100.ordinaryTax - at.ordinaryTax,
    expect("taxStep100", next),
  );
  pins++;

  // Differential equality at top ± 1¢: the independent
  // pricer must agree with the engine to the cent.
  for (const [label, amount] of [
    ["diff top-1c", top + std - CENT],
    ["diff top+1c", top + std + CENT],
  ] as const) {
    const input = baseInput(year, fs, amount);
    const engine = priceYear(input);
    const second = priceYearIndependent(toIndependent(input));
    cases += 1;
    checkEq(failures, `${caseId} ${label}`, "ordinaryTax", second.ordinaryTax, engine.ordinaryTax);
    pins++;
    checkEq(failures, `${caseId} ${label}`, "taxableIncome", second.taxableIncome, engine.taxableIncome);
    pins++;
  }

  return { pins, cases };
}

// The fast set: MFJ 2026, all six tops, plus the
// first-top spot for single and head of household.
function runFastSet(corrupt?: {
  caseId: string;
  field: string;
  delta: number;
}): { failures: PinFailure[]; counts: Record<string, number> } {
  const failures: PinFailure[] = [];
  let pins = 0;
  let cases = 0;
  for (let i = 0; i < 6; i++) {
    const r = pinTop(failures, 2026, "mfj", i, corrupt);
    pins += r.pins;
    cases += r.cases;
  }
  for (const fs of ["single", "hoh"] as const) {
    const r = pinTop(failures, 2026, fs, 0, corrupt);
    pins += r.pins;
    cases += r.cases;
  }
  return {
    failures,
    counts: { pins, cases, tops: 8, failures: failures.length },
  };
}

// The full set: all three statuses, both years, all tops.
function runFullSet(): { failures: PinFailure[]; counts: Record<string, number> } {
  const failures: PinFailure[] = [];
  let pins = 0;
  let cases = 0;
  for (const year of YEARS) {
    for (const fs of STATUSES) {
      for (let i = 0; i < 6; i++) {
        const r = pinTop(failures, year, fs, i);
        pins += r.pins;
        cases += r.cases;
      }
    }
  }
  return {
    failures,
    counts: { pins, cases, tops: 36, failures: failures.length },
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
      ? `Bracket-top pins all pass: ${set.counts.pins} pins across ${set.counts.tops} tops (${set.counts.cases} priced years). Marginal rate steps at each top, the +$100 tax step prices at the next bracket's rate, and the independent pricer agrees to the cent at top ± 1¢.`
      : `${set.failures.length} bracket-top pin(s) failed — see failures.`,
    failures: set.failures.slice(0, 25),
    counts: set.counts,
  };
}

function runBracketsFast(): HardeningCheckResult {
  return resultFrom(
    "boundary-brackets",
    "Boundary brackets: marginal step, +$100 tax step, differential equality at every bracket top",
    runFastSet(),
  );
}

function runBracketsFull(): HardeningCheckResult {
  return resultFrom(
    "boundary-brackets",
    "Boundary brackets: marginal step, +$100 tax step, differential equality at every bracket top",
    runFullSet(),
  );
}

function runBracketsTeeth(): HardeningTeethResult {
  // Corrupt one pin by 1 cent: the MFJ 2026 second top's
  // +$100 tax step, expected $22.00, corrupted to $22.01.
  // Exactly that one pin must fail.
  const corruptedCaseId = "bracket 2026 mfj top 100800 +$100 ordinaryTax step";
  const set = runFastSet({
    caseId: "bracket 2026 mfj top 100800",
    field: "taxStep100",
    delta: CENT,
  });
  return {
    corruptedCaseId,
    failedCount: set.failures.length,
    pass: set.failures.length === 1,
  };
}

export const boundaryBracketsCheck: HardeningCheckModule = {
  id: "boundary-brackets",
  name: "Boundary brackets: marginal step, +$100 tax step, differential equality at every bracket top",
  runFast: runBracketsFast,
  runFull: runBracketsFull,
  runTeeth: runBracketsTeeth,
};
