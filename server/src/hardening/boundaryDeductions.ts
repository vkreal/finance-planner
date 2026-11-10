/* ---------------- Boundary deductions ----------------
   Part 2 of the hardening block (boundary-case fixture
   pack). Pins the standard/itemized edge: the greater-of
   comparison with the tie going to standard, the §68
   limitation, the charitable floor and 60% ceiling, the
   §170(p) non-itemizer deduction, and the senior
   deduction's phase-out. Every expected value is hand-
   derived from the statute constants in taxLaw.ts, never
   from the engine's own outputs — and every pin is also
   priced by the independent implementation, which must
   agree with the hand value too, so each pin is a
   three-way agreement: statute, engine, oracle. A pin
   that fails is a finding, never a reason to loosen
   the pin.

   (a) §68: threshold = the year's second-to-last bracket
   top (the 37% threshold), read from the law row;
   excess = AGI − senior − threshold (senior is $0 in
   these pins: both filers under 65); reduction =
   (2/37) × min(itemized-before-§68, excess), $0 in
   2025 (the trio is 2026+ only).
   (b) Charitable: floor 0.5% of AGI (2026+ only),
   ceiling 60% of AGI (every year); allowed =
   min(max(0, entered − floor), 0.6 × AGI), floor
   applied first.
   (c) §170(p): standard-side only, min(entered, cap)
   with the cap $2,000 MFJ / $1,000 single or HOH,
   deflating past 2026; $0 in 2025.
   (d) Senior deduction: $6,000 per person 65+,
   2025–2028 only, phasing out 6% of AGI over
   $150,000 joint / $75,000 single or HOH; amount and
   start both deflate past the law row's year.
   (e) Tie: itemized effect exactly equal to the
   standard effect → standard, on mortgage-only ties
   and on ties built with the senior deduction and
   with §170(p) included. */

import { deflationFactor, priceYear } from "../taxEngine";
import type { PriceYearInput, PriceYearResult } from "../taxEngine";
import {
  DEDUCTION_2026,
  SENIOR_DEDUCTION,
  lawForYear,
} from "../taxLaw";
import type { FilingStatus } from "../taxLaw";
import { priceYearIndependent } from "./secondImplementation";
import type { IndependentYearInput } from "./secondImplementation";
import type {
  HardeningCheckModule,
  HardeningCheckResult,
  HardeningTeethResult,
} from "./types";

const STATUSES: FilingStatus[] = ["mfj", "single", "hoh"];

function roundCent(n: number): number {
  return Math.round(n * 100) / 100;
}

// One pin: a priced year plus the hand-derived figures
// its deduction fields must carry. `expect` may name any
// subset of the deduction fields; every named field is
// checked on the engine's result AND on the independent
// implementation's result.
type DeductionField =
  | "section68Reduction"
  | "itemizedDeduction"
  | "itemizedCharitableAllowed"
  | "nonItemizerCharitableDeduction"
  | "seniorDeduction"
  | "deductions"
  | "deductionTaken";

type Pin = {
  id: string;
  input: PriceYearInput;
  expect: Partial<Record<DeductionField, number | string>>;
};

function base(
  year: number,
  fs: FilingStatus,
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
    inflationPct: 2.5,
    stateRatePct: 0,
    residenceState: "other",
    ...over,
  };
}

// The §68 threshold for a status and year: the year's
// second-to-last bracket top, read from the law row the
// year prices under (the 2026 row carries forward for
// 2027–2029, so the threshold stays the 2026 figure).
function threshold68(year: number, fs: FilingStatus): number {
  const tops = lawForYear(year).brackets[fs];
  return tops[tops.length - 2]!;
}

function stdBase(year: number, fs: FilingStatus): number {
  return lawForYear(year).standardDeduction[fs];
}

// Hand derivation of the §68 reduction for an itemized
// total with no senior deduction (these pins price with
// both filers under 65, so the senior term is $0).
function expected68(
  year: number,
  fs: FilingStatus,
  agi: number,
  itemizedBefore: number,
): number {
  if (year < DEDUCTION_2026.firstYear) return 0;
  const excess = Math.max(0, agi - threshold68(year, fs));
  return roundCent(
    (DEDUCTION_2026.section68Numerator /
      DEDUCTION_2026.section68Denominator) *
      Math.min(itemizedBefore, excess),
  );
}

function expectedCharitable(
  year: number,
  agi: number,
  entered: number,
): number {
  const floor =
    year >= DEDUCTION_2026.firstYear
      ? (DEDUCTION_2026.charitableFloorRatePct / 100) * agi
      : 0;
  return roundCent(Math.min(Math.max(0, entered - floor), 0.6 * agi));
}

function expected170p(
  year: number,
  fs: FilingStatus,
  entered: number,
): number {
  if (year < DEDUCTION_2026.firstYear) return 0;
  const law = lawForYear(year);
  const defl = deflationFactor(year, law.year, 2.5);
  return roundCent(
    Math.min(
      entered,
      DEDUCTION_2026.nonItemizerCharitableCap[fs] * defl,
    ),
  );
}

function expectedSenior(
  year: number,
  fs: FilingStatus,
  count65: number,
  agi: number,
): number {
  if (
    year < SENIOR_DEDUCTION.firstYear ||
    year > SENIOR_DEDUCTION.lastYear ||
    count65 === 0
  ) {
    return 0;
  }
  const law = lawForYear(year);
  const defl = deflationFactor(year, law.year, 2.5);
  const excess = Math.max(
    0,
    agi - SENIOR_DEDUCTION.phaseOutStart[fs] * defl,
  );
  return roundCent(
    Math.max(
      0,
      SENIOR_DEDUCTION.amountPerPerson * defl -
        SENIOR_DEDUCTION.phaseOutRate * excess,
    ) * count65,
  );
}

// ---------- Fast pins (the brief's probe-verified pins) ----------

const FAST_PINS: Pin[] = [
  // §68, MFJ 2026, itemized $50,000 via mortgage interest.
  {
    id: "s68-mfj-2026-at-threshold",
    input: base(2026, "mfj", {
      otherOrdinary: 768700,
      itemizedMortgageInterest: 50000,
    }),
    expect: {
      section68Reduction: 0,
      itemizedDeduction: 50000,
      deductionTaken: "itemized",
    },
  },
  {
    id: "s68-mfj-2026-plus-1",
    input: base(2026, "mfj", {
      otherOrdinary: 768701,
      itemizedMortgageInterest: 50000,
    }),
    expect: { section68Reduction: 0.05 },
  },
  {
    id: "s68-mfj-2026-plus-100",
    input: base(2026, "mfj", {
      otherOrdinary: 768800,
      itemizedMortgageInterest: 50000,
    }),
    expect: { section68Reduction: 5.41 },
  },
  {
    id: "s68-mfj-2026-cap",
    input: base(2026, "mfj", {
      otherOrdinary: 818700,
      itemizedMortgageInterest: 50000,
    }),
    expect: { section68Reduction: 2702.7 },
  },
  {
    id: "s68-mfj-2026-just-under-cap",
    input: base(2026, "mfj", {
      otherOrdinary: 818699,
      itemizedMortgageInterest: 50000,
    }),
    expect: { section68Reduction: 2702.65 },
  },
  {
    id: "s68-mfj-2025-none",
    input: base(2025, "mfj", {
      otherOrdinary: 768700,
      itemizedMortgageInterest: 50000,
    }),
    expect: { section68Reduction: 0 },
  },
  // §68 spot pins for the other statuses, 2026.
  {
    id: "s68-single-2026-at-threshold",
    input: base(2026, "single", {
      otherOrdinary: 640600,
      itemizedMortgageInterest: 50000,
    }),
    expect: { section68Reduction: 0 },
  },
  {
    id: "s68-single-2026-plus-1",
    input: base(2026, "single", {
      otherOrdinary: 640601,
      itemizedMortgageInterest: 50000,
    }),
    expect: { section68Reduction: 0.05 },
  },
  {
    id: "s68-hoh-2026-cap",
    input: base(2026, "hoh", {
      otherOrdinary: 690600,
      itemizedMortgageInterest: 50000,
    }),
    expect: { section68Reduction: 2702.7 },
  },
  // Charitable floor / ceiling, AGI $100,000, MFJ.
  {
    id: "char-mfj-2026-floor-exact",
    input: base(2026, "mfj", {
      otherOrdinary: 100000,
      itemizedCharitable: 500,
    }),
    expect: {
      itemizedCharitableAllowed: 0,
      deductionTaken: "standard",
    },
  },
  {
    id: "char-mfj-2026-floor-plus-100",
    input: base(2026, "mfj", {
      otherOrdinary: 100000,
      itemizedCharitable: 600,
    }),
    expect: { itemizedCharitableAllowed: 100 },
  },
  {
    id: "char-mfj-2026-ceiling",
    input: base(2026, "mfj", {
      otherOrdinary: 100000,
      itemizedCharitable: 100000,
    }),
    expect: {
      itemizedCharitableAllowed: 60000,
      deductionTaken: "itemized",
    },
  },
  {
    id: "char-mfj-2025-no-floor",
    input: base(2025, "mfj", {
      otherOrdinary: 100000,
      itemizedCharitable: 500,
    }),
    expect: { itemizedCharitableAllowed: 500 },
  },
  {
    id: "char-mfj-2025-ceiling-applies",
    input: base(2025, "mfj", {
      otherOrdinary: 100000,
      itemizedCharitable: 100000,
    }),
    expect: { itemizedCharitableAllowed: 60000 },
  },
  // §170(p) non-itemizer charitable deduction.
  {
    id: "170p-mfj-2026",
    input: base(2026, "mfj", {
      otherOrdinary: 100000,
      itemizedCharitable: 5000,
    }),
    expect: {
      deductionTaken: "standard",
      nonItemizerCharitableDeduction: 2000,
      deductions: 34200,
    },
  },
  {
    id: "170p-single-2026",
    input: base(2026, "single", {
      otherOrdinary: 100000,
      itemizedCharitable: 5000,
    }),
    expect: {
      deductionTaken: "standard",
      nonItemizerCharitableDeduction: 1000,
      deductions: 17100,
    },
  },
  {
    id: "170p-hoh-2026",
    input: base(2026, "hoh", {
      otherOrdinary: 100000,
      itemizedCharitable: 5000,
    }),
    expect: {
      deductionTaken: "standard",
      nonItemizerCharitableDeduction: 1000,
      deductions: 25150,
    },
  },
  {
    id: "170p-mfj-2025-none",
    input: base(2025, "mfj", {
      otherOrdinary: 100000,
      itemizedCharitable: 5000,
    }),
    expect: {
      nonItemizerCharitableDeduction: 0,
      deductions: 31500,
    },
  },
  // Senior deduction phase-out, MFJ, primary 65, spouse 60.
  {
    id: "senior-mfj-2026-at-start",
    input: base(2026, "mfj", {
      agePrimary: 65,
      ageSpouse: 60,
      otherOrdinary: 150000,
    }),
    expect: { seniorDeduction: 6000, deductions: 39850 },
  },
  {
    id: "senior-mfj-2026-plus-1",
    input: base(2026, "mfj", {
      agePrimary: 65,
      ageSpouse: 60,
      otherOrdinary: 150001,
    }),
    expect: { seniorDeduction: 5999.94 },
  },
  {
    id: "senior-mfj-2026-midpoint",
    input: base(2026, "mfj", {
      agePrimary: 65,
      ageSpouse: 60,
      otherOrdinary: 200000,
    }),
    expect: { seniorDeduction: 3000 },
  },
  {
    id: "senior-mfj-2026-exhausted",
    input: base(2026, "mfj", {
      agePrimary: 65,
      ageSpouse: 60,
      otherOrdinary: 250000,
    }),
    expect: { seniorDeduction: 0 },
  },
  {
    id: "senior-mfj-2026-both-65",
    input: base(2026, "mfj", {
      agePrimary: 65,
      ageSpouse: 65,
      otherOrdinary: 150000,
    }),
    expect: { seniorDeduction: 12000 },
  },
  {
    id: "senior-mfj-2029-gone",
    input: base(2029, "mfj", {
      agePrimary: 65,
      ageSpouse: 60,
      otherOrdinary: 100000,
    }),
    expect: { seniorDeduction: 0 },
  },
  // Senior deduction, single filer 65 (phase-out start $75,000).
  {
    id: "senior-single-2026-at-start",
    input: base(2026, "single", {
      agePrimary: 65,
      otherOrdinary: 75000,
    }),
    expect: { seniorDeduction: 6000 },
  },
  {
    id: "senior-single-2026-plus-1",
    input: base(2026, "single", {
      agePrimary: 65,
      otherOrdinary: 75001,
    }),
    expect: { seniorDeduction: 5999.94 },
  },
  {
    id: "senior-single-2026-exhausted",
    input: base(2026, "single", {
      agePrimary: 65,
      otherOrdinary: 175000,
    }),
    expect: { seniorDeduction: 0 },
  },
  // Tie goes to standard: mortgage exactly the standard
  // deduction, MFJ 2026.
  {
    id: "tie-mfj-2026",
    input: base(2026, "mfj", {
      otherOrdinary: 100000,
      itemizedMortgageInterest: 32200,
    }),
    expect: { deductionTaken: "standard", deductions: 32200 },
  },
  {
    id: "tie-mfj-2026-plus-1",
    input: base(2026, "mfj", {
      otherOrdinary: 100000,
      itemizedMortgageInterest: 32201,
    }),
    expect: { deductionTaken: "itemized", deductions: 32201 },
  },
  {
    id: "tie-mfj-2026-minus-1",
    input: base(2026, "mfj", {
      otherOrdinary: 100000,
      itemizedMortgageInterest: 32199,
    }),
    expect: { deductionTaken: "standard", deductions: 32200 },
  },
  // Tie with the senior deduction on both sides: standard
  // $32,200 + $1,650 age-65 add-on, senior $6,000 at
  // AGI $100,000; mortgage $33,850 ties.
  {
    id: "tie-mfj-2026-senior",
    input: base(2026, "mfj", {
      agePrimary: 65,
      ageSpouse: 60,
      otherOrdinary: 100000,
      itemizedMortgageInterest: 33850,
    }),
    expect: { deductionTaken: "standard", deductions: 39850 },
  },
  // Tie with §170(p) on the standard side: AGI $100,000,
  // charitable $2,000 — the itemized side carries
  // $2,000 − $500 floor = $1,500, the standard side
  // carries the $2,000 §170(p) amount, so mortgage
  // $32,700 ties at $34,200.
  {
    id: "tie-mfj-2026-170p",
    input: base(2026, "mfj", {
      otherOrdinary: 100000,
      itemizedMortgageInterest: 32700,
      itemizedCharitable: 2000,
    }),
    expect: {
      deductionTaken: "standard",
      deductions: 34200,
      nonItemizerCharitableDeduction: 2000,
    },
  },
  {
    id: "tie-mfj-2026-170p-plus-1",
    input: base(2026, "mfj", {
      otherOrdinary: 100000,
      itemizedMortgageInterest: 32701,
      itemizedCharitable: 2000,
    }),
    expect: { deductionTaken: "itemized", deductions: 34201 },
  },
];

// ---------- Full sweeps ----------

function buildFullPins(): Pin[] {
  const pins: Pin[] = [];
  // (a) §68: every status, years 2025–2029, itemized
  // $50,000, AGI stepped around the year's threshold.
  for (const fs of STATUSES) {
    for (let year = 2025; year <= 2029; year++) {
      const threshold = threshold68(year, fs);
      for (const offset of [-1, 0, 1, 100, 49999, 50000, 100000]) {
        const agi = threshold + offset;
        const reduction = expected68(year, fs, agi, 50000);
        const expect: Pin["expect"] = { section68Reduction: reduction };
        if (offset === 0) {
          expect.itemizedDeduction = 50000 - reduction;
          expect.deductionTaken = "itemized";
        }
        pins.push({
          id: `s68-full-${fs}-${year}-off${offset}`,
          input: base(year, fs, {
            otherOrdinary: agi,
            itemizedMortgageInterest: 50000,
          }),
          expect,
        });
      }
    }
  }
  // (b) Charitable floor / ceiling: every status, years
  // 2025–2029, three AGIs, entered amounts crossing the
  // floor and the ceiling.
  for (const fs of STATUSES) {
    for (let year = 2025; year <= 2029; year++) {
      for (const agi of [50000, 100000, 200000]) {
        for (const entered of [
          0, 499, 500, 501, 600, 59000, 60000, 60001, 100000, 200000,
        ]) {
          pins.push({
            id: `char-full-${fs}-${year}-agi${agi}-ent${entered}`,
            input: base(year, fs, {
              otherOrdinary: agi,
              itemizedCharitable: entered,
            }),
            expect: {
              itemizedCharitableAllowed: expectedCharitable(
                year,
                agi,
                entered,
              ),
            },
          });
        }
      }
    }
  }
  // (c) §170(p): every status, years 2025–2029, entered
  // amounts crossing the per-status cap. With charitable
  // only, the itemized side never beats the standard side
  // at these amounts, so the standard side always wins
  // and the §170(p) amount is the full candidate.
  for (const fs of STATUSES) {
    for (let year = 2025; year <= 2029; year++) {
      for (const entered of [0, 500, 1000, 1999, 2000, 2001, 5000]) {
        const amount = expected170p(year, fs, entered);
        pins.push({
          id: `170p-full-${fs}-${year}-ent${entered}`,
          input: base(year, fs, {
            otherOrdinary: 100000,
            itemizedCharitable: entered,
          }),
          expect: {
            nonItemizerCharitableDeduction: amount,
            deductions: stdBase(year, fs) + amount,
          },
        });
      }
    }
  }
  // (d) Senior deduction: every status, years 2025–2029,
  // one and (MFJ only) two filers 65+, AGI stepped
  // around the phase-out start and through exhaustion.
  for (const fs of STATUSES) {
    const start = SENIOR_DEDUCTION.phaseOutStart[fs];
    const counts = fs === "mfj" ? [1, 2] : [1];
    for (let year = 2025; year <= 2029; year++) {
      for (const count65 of counts) {
        for (const offset of [-1, 0, 1, 50000, 100000, 100001]) {
          const agi = start + offset;
          pins.push({
            id: `senior-full-${fs}-${year}-n${count65}-off${offset}`,
            input: base(year, fs, {
              agePrimary: 65,
              ageSpouse:
                fs === "mfj" ? (count65 === 2 ? 65 : 60) : null,
              otherOrdinary: agi,
            }),
            expect: {
              seniorDeduction: expectedSenior(year, fs, count65, agi),
            },
          });
        }
      }
    }
  }
  // (e) Tie: every status, years 2025–2029, mortgage at
  // standard − $1, exactly standard, standard + $0.01,
  // and standard + $1.
  for (const fs of STATUSES) {
    for (let year = 2025; year <= 2029; year++) {
      const std = stdBase(year, fs);
      for (const [label, mortgage, taken] of [
        ["minus-1", std - 1, "standard"],
        ["exact", std, "standard"],
        ["plus-1c", std + 0.01, "itemized"],
        ["plus-1", std + 1, "itemized"],
      ] as const) {
        pins.push({
          id: `tie-full-${fs}-${year}-${label}`,
          input: base(year, fs, {
            otherOrdinary: 100000,
            itemizedMortgageInterest: mortgage,
          }),
          expect: {
            deductionTaken: taken,
            deductions:
              taken === "standard" ? std : roundCent(mortgage),
          },
        });
      }
    }
  }
  return pins;
}

// ---------- Pin runner ----------

function toIndependentInput(input: PriceYearInput): IndependentYearInput {
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
    interestIncome: input.interestIncome ?? 0,
    ordinaryDividends: input.ordinaryDividends ?? 0,
    qualifiedDividends: input.qualifiedDividends ?? 0,
    capitalLossAllowance: input.capitalLossAllowance ?? 0,
    inflationPct: input.inflationPct,
    stateRatePct: input.stateRatePct,
    residenceState: input.residenceState ?? "other",
    itemizedMortgageInterest: input.itemizedMortgageInterest,
    itemizedSaltPaid: input.itemizedSaltPaid,
    itemizedCharitable: input.itemizedCharitable,
    itemizedOther: input.itemizedOther,
  };
}

function fieldMatches(
  actual: number | string,
  expected: number | string,
): boolean {
  if (typeof expected === "string" || typeof actual === "string") {
    return actual === expected;
  }
  return Math.round(actual * 100) === Math.round(expected * 100);
}

function checkPins(pins: Pin[]): {
  failures: string[];
  pinsFailed: number;
  fieldsChecked: number;
  engineMismatches: number;
  independentMismatches: number;
} {
  const failures: string[] = [];
  let pinsFailed = 0;
  let fieldsChecked = 0;
  let engineMismatches = 0;
  let independentMismatches = 0;
  for (const pin of pins) {
    const engine: PriceYearResult = priceYear(pin.input);
    const mine = priceYearIndependent(toIndependentInput(pin.input));
    let pinFailed = false;
    for (const [field, expected] of Object.entries(pin.expect) as [
      DeductionField,
      number | string,
    ][]) {
      fieldsChecked += 2;
      const eActual = engine[field] as number | string;
      if (!fieldMatches(eActual, expected)) {
        engineMismatches++;
        pinFailed = true;
        failures.push(
          `${pin.id} engine ${field}: ${eActual} != hand-derived ${expected}`,
        );
      }
      const mActual = mine[field] as number | string;
      if (!fieldMatches(mActual, expected)) {
        independentMismatches++;
        pinFailed = true;
        failures.push(
          `${pin.id} independent ${field}: ${mActual} != hand-derived ${expected}`,
        );
      }
    }
    if (pinFailed) pinsFailed++;
  }
  return {
    failures: failures.slice(0, 25),
    pinsFailed,
    fieldsChecked,
    engineMismatches,
    independentMismatches,
  };
}

function runDeductionsInner(full: boolean): HardeningCheckResult {
  const pins = full ? [...FAST_PINS, ...buildFullPins()] : FAST_PINS;
  const checked = checkPins(pins);
  const pass = checked.pinsFailed === 0;
  const detail =
    `Boundary deductions over ${pins.length} pins ` +
    `(${full ? "fast pins plus the full sweeps" : "fast pins only"}): ` +
    `${checked.fieldsChecked} field checks (engine and independent ` +
    `implementation against hand-derived values), ` +
    `${checked.engineMismatches} engine mismatches, ` +
    `${checked.independentMismatches} independent mismatches, ` +
    `${checked.pinsFailed} pins failed. ` +
    `Coverage: §68 every status × 2025–2029, charitable floor/ceiling ` +
    `every status × 2025–2029 × 3 AGIs, §170(p) every status × ` +
    `2025–2029, senior phase-out every status × 2025–2029, ` +
    `tie to standard every status × 2025–2029${full ? "" : " (full sweeps run in runFull)"}.`;
  return {
    id: "boundary-deductions",
    name: "Boundary deductions: §68, charitable floor/ceiling, §170(p), senior phase-out, tie to standard",
    pass,
    detail,
    failures: checked.failures,
    counts: {
      pins: pins.length,
      fieldsChecked: checked.fieldsChecked,
      engineMismatches: checked.engineMismatches,
      independentMismatches: checked.independentMismatches,
      violations: checked.pinsFailed,
    },
  };
}

function runDeductionsFast(): HardeningCheckResult {
  return runDeductionsInner(false);
}

function runDeductionsFull(): HardeningCheckResult {
  return runDeductionsInner(true);
}

// Teeth: corrupt the §68 +$1 pin's hand value by 1 cent
// ($0.05 → $0.06). The clean run must pass first; the
// corrupted run must fail exactly that one pin.
function runDeductionsTeeth(): HardeningTeethResult {
  const clean = runDeductionsFast();
  if (!clean.pass) {
    return {
      corruptedCaseId: "boundary-deductions:clean-run-failed",
      failedCount: clean.counts.violations ?? 0,
      pass: false,
    };
  }
  const pin = FAST_PINS.find((p) => p.id === "s68-mfj-2026-plus-1")!;
  const corrupted: Pin = {
    ...pin,
    expect: { ...pin.expect, section68Reduction: 0.06 },
  };
  const checked = checkPins([corrupted]);
  const pass = checked.pinsFailed === 1;
  return {
    corruptedCaseId:
      "boundary-deductions:s68-mfj-2026-plus-1:reduction+0.01",
    failedCount: checked.pinsFailed,
    pass,
  };
}

export const boundaryDeductionsCheck: HardeningCheckModule = {
  id: "boundary-deductions",
  name: "Boundary deductions: §68, charitable floor/ceiling, §170(p), senior phase-out, tie to standard",
  runFast: runDeductionsFast,
  runFull: runDeductionsFull,
  runTeeth: runDeductionsTeeth,
};
