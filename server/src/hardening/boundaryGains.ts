/* ---------------- LTCG staircase boundary pins ----------------
   Part 2 of the hardening block (boundary-case fixture
   pack). Pins the long-term capital-gains staircase: the
   0% top, the 20% floor, the ordinary-first stack order,
   and the cgStackTax helper, in every filing status, in
   2025 and 2026.

   Why this module closes the harness's known LTCG-zero-top
   gap: the randomized generator's LTCG-zero-top proximity
   was 0 because its boundary households zeroed the gains
   stack and nearly half drew itemized deductions (which
   win over the standard deduction and pull taxable income
   below the anchor). Every construction here does the
   opposite on purpose: gains are always positive and no
   itemized input is ever set, so the standard deduction is
   taken and taxable income lands exactly on the pin. The
   run reports how many zero-top pins land exactly on the
   top (the proximity count) — the target is all of them.

   Construction (ordinary taxable income 0 unless the pin
   says otherwise): ltcg = pin + standardDeduction prices
   taxableIncome exactly at the pin, with gainsInTi =
   min(gains, taxableIncome) equal to the pin. Ordinary
   taxable income is taxableIncome − gainsInTi.
   A pin that fails against the engine is a FINDING; this
   module never adjusts a pin to make it pass.

   Expected staircase math (all probe-verified against the
   engine before this module was written):
     at the 0% top: gainsAt0 = top, gainsAt15 = 0, tax $0;
       +1¢ of gains → gainsAt15 $0.01 (tax still $0.00
       after cent rounding); +$100 → gainsAt15 $100,
       tax $15.
     at the 20% floor: gainsAt0 = zero top, gainsAt15 =
       floor − zero top, gainsAt20 = 0, tax = 15% of the
       15% band; +1¢ → gainsAt20 $0.01; +$100 → tax
       rises by $20. */

import { priceYear } from "../taxEngine";
import type { PriceYearInput } from "../taxEngine";
import type { FilingStatus } from "../taxLaw";
import { lawForYear } from "../taxLaw";
import { cgStackTax } from "../giftModel";
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
// noise is not.
const TOL = 0.005;

const STANDARD_DEDUCTION: Record<number, Record<FS, number>> = {
  2025: { mfj: 31500, single: 15750, hoh: 23625 },
  2026: { mfj: 32200, single: 16100, hoh: 24150 },
};

// The gains staircase tops per year per status: the last
// dollar taxed at 0%, and the first dollar taxed at 20%.
const LTCG_ZERO_TOP: Record<number, Record<FS, number>> = {
  2025: { mfj: 96700, single: 48350, hoh: 64750 },
  2026: { mfj: 98900, single: 49450, hoh: 66200 },
};
const LTCG_20_FLOOR: Record<number, Record<FS, number>> = {
  2025: { mfj: 600050, single: 533400, hoh: 566700 },
  2026: { mfj: 613700, single: 545500, hoh: 579600 },
};

const YEARS = [2025, 2026] as const;
const STATUSES: FS[] = ["mfj", "single", "hoh"];

function baseInput(year: number, fs: FS, over: Partial<PriceYearInput>): PriceYearInput {
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

// The staircase recomputed straight from the law table:
// how a gains stack splits across the 0% / 15% / 20%
// bands when ordinary taxable income fills the staircase
// first. This is the independent expectation cgStackTax
// and priceYear are both checked against.
function staircase(
  year: number,
  fs: FS,
  ordinaryTi: number,
  gains: number,
): { at0: number; at15: number; at20: number; tax: number } {
  const law = lawForYear(year);
  const zeroSpace = Math.max(0, law.ltcgZeroTop[fs] - ordinaryTi);
  const at0 = Math.min(gains, zeroSpace);
  const afterZero = gains - at0;
  const twentySpace = Math.max(0, law.ltcg20Floor[fs] - ordinaryTi - at0);
  const at15 = Math.min(afterZero, twentySpace);
  const at20 = afterZero - at15;
  return { at0, at15, at20, tax: 0.15 * at15 + 0.2 * at20 };
}

function roundCent(n: number): number {
  return Math.round(n * 100) / 100;
}

type Corrupt = { caseId: string; field: string; delta: number };

function expectMaybe(corrupt: Corrupt | undefined, caseId: string, field: string, value: number): number {
  return corrupt && corrupt.caseId === caseId && corrupt.field === field ? value + corrupt.delta : value;
}

// Zero-top + 20%-floor + ordinary-first stack pins for one
// (year, status). Returns pin/case counts and how many
// zero-top pins landed exactly on the top.
function pinStaircase(
  failures: PinFailure[],
  year: number,
  fs: FS,
  corrupt?: Corrupt,
): { pins: number; cases: number; zeroTopPins: number; zeroTopOnTop: number } {
  const std = STANDARD_DEDUCTION[year]![fs]!;
  const zeroTop = LTCG_ZERO_TOP[year]![fs]!;
  const floor = LTCG_20_FLOOR[year]![fs]!;
  let pins = 0;
  let cases = 0;
  let zeroTopPins = 0;
  let zeroTopOnTop = 0;

  const law = lawForYear(year);
  const caseLaw = `gains ${year} ${fs} law`;
  checkEq(failures, caseLaw, "lawLtcgZeroTop", law.ltcgZeroTop[fs], zeroTop);
  pins++;
  checkEq(failures, caseLaw, "lawLtcg20Floor", law.ltcg20Floor[fs], floor);
  pins++;
  checkEq(failures, caseLaw, "lawStandardDeduction", law.standardDeduction[fs], std);
  pins++;

  // ---- 0% top, ordinary taxable income 0 ----
  const zeroId = `gains ${year} ${fs} zero-top ${zeroTop}`;
  const at = priceYear(baseInput(year, fs, { ltcg: zeroTop + std }));
  cases++;
  zeroTopPins++;
  if (Math.abs(at.taxableIncome - zeroTop) <= TOL) zeroTopOnTop++;
  checkEq(failures, zeroId, "taxableIncome", at.taxableIncome, expectMaybe(corrupt, zeroId, "taxableIncome", zeroTop));
  pins++;
  checkEq(failures, zeroId, "gainsAt0", at.gainsAt0, expectMaybe(corrupt, zeroId, "gainsAt0", zeroTop));
  pins++;
  checkEq(failures, zeroId, "gainsAt15", at.gainsAt15, expectMaybe(corrupt, zeroId, "gainsAt15", 0));
  pins++;
  checkEq(failures, zeroId, "gainsAt20", at.gainsAt20, 0);
  pins++;
  checkEq(failures, zeroId, "ltcgTax", at.ltcgTax, 0);
  pins++;
  checkEq(failures, zeroId, "ordinaryTaxableIncome", at.ordinaryTaxableIncome, 0);
  pins++;

  const over = priceYear(baseInput(year, fs, { ltcg: zeroTop + std + CENT }));
  cases++;
  // The +1¢ pin is a straddle pin, not an on-top pin: it
  // does not count toward the zero-top proximity count.
  checkEq(failures, `${zeroId}+1c`, "gainsAt0", over.gainsAt0, zeroTop);
  pins++;
  checkEq(failures, `${zeroId}+1c`, "gainsAt15", over.gainsAt15, expectMaybe(corrupt, `${zeroId}+1c`, "gainsAt15", CENT));
  pins++;
  checkEq(failures, `${zeroId}+1c`, "ltcgTax", over.ltcgTax, 0);
  pins++;

  const under = priceYear(baseInput(year, fs, { ltcg: zeroTop + std - CENT }));
  cases++;
  checkEq(failures, `${zeroId}-1c`, "gainsAt0", under.gainsAt0, zeroTop - CENT);
  pins++;
  checkEq(failures, `${zeroId}-1c`, "gainsAt15", under.gainsAt15, 0);
  pins++;
  checkEq(failures, `${zeroId}-1c`, "ltcgTax", under.ltcgTax, 0);
  pins++;

  const plus100 = priceYear(baseInput(year, fs, { ltcg: zeroTop + std + 100 }));
  cases++;
  checkEq(failures, `${zeroId}+$100`, "gainsAt15", plus100.gainsAt15, 100);
  pins++;
  checkEq(failures, `${zeroId}+$100`, "ltcgTax", plus100.ltcgTax, 15);
  pins++;

  // ---- 20% floor, ordinary taxable income 0 ----
  const floorId = `gains ${year} ${fs} 20-floor ${floor}`;
  const floorTax = roundCent(0.15 * (floor - zeroTop));
  const fl = priceYear(baseInput(year, fs, { ltcg: floor + std }));
  cases++;
  checkEq(failures, floorId, "gainsAt0", fl.gainsAt0, zeroTop);
  pins++;
  checkEq(failures, floorId, "gainsAt15", fl.gainsAt15, floor - zeroTop);
  pins++;
  checkEq(failures, floorId, "gainsAt20", fl.gainsAt20, 0);
  pins++;
  checkEq(failures, floorId, "ltcgTax", fl.ltcgTax, floorTax);
  pins++;

  const flo = priceYear(baseInput(year, fs, { ltcg: floor + std + CENT }));
  cases++;
  checkEq(failures, `${floorId}+1c`, "gainsAt20", flo.gainsAt20, CENT);
  pins++;
  checkEq(failures, `${floorId}+1c`, "ltcgTax", flo.ltcgTax, roundCent(floorTax + 0.2 * CENT));
  pins++;

  const fl100 = priceYear(baseInput(year, fs, { ltcg: floor + std + 100 }));
  cases++;
  checkEq(failures, `${floorId}+$100`, "gainsAt20", fl100.gainsAt20, 100);
  pins++;
  checkEq(failures, `${floorId}+$100`, "ltcgTax", fl100.ltcgTax, roundCent(floorTax + 20));
  pins++;

  // ---- Ordinary-first stack ----
  // Ordinary income fills the staircase first: with
  // ordinary taxable income at (zero top − stack gains),
  // the whole gains stack still prices at 0%, and one
  // more cent of gains prices at 15%. The stack size is
  // the brief's figure where it fits, shrunk only where
  // a status's zero top is smaller than it.
  const stackGains = Math.min(48900, zeroTop - 550);
  const stackOrdinaryTi = zeroTop - stackGains;
  const stackId = `gains ${year} ${fs} stack ordTi ${stackOrdinaryTi}`;
  const st = priceYear(
    baseInput(year, fs, { otherOrdinary: stackOrdinaryTi + std, ltcg: stackGains }),
  );
  cases++;
  checkEq(failures, stackId, "ordinaryTaxableIncome", st.ordinaryTaxableIncome, stackOrdinaryTi);
  pins++;
  checkEq(failures, stackId, "gainsAt0", st.gainsAt0, stackGains);
  pins++;
  checkEq(failures, stackId, "gainsAt15", st.gainsAt15, 0);
  pins++;
  checkEq(failures, stackId, "ltcgTax", st.ltcgTax, 0);
  pins++;

  const sto = priceYear(
    baseInput(year, fs, { otherOrdinary: stackOrdinaryTi + std, ltcg: stackGains + CENT }),
  );
  cases++;
  checkEq(failures, `${stackId}+1c`, "gainsAt15", sto.gainsAt15, CENT);
  pins++;

  // ---- Differential equality on the staircase pins ----
  for (const [label, amount] of [
    ["diff zero-top", zeroTop + std],
    ["diff zero-top+1c", zeroTop + std + CENT],
    ["diff 20-floor", floor + std],
  ] as const) {
    const input = baseInput(year, fs, { ltcg: amount });
    const engine = priceYear(input);
    const second = priceYearIndependent(toIndependent(input));
    cases += 1;
    checkEq(failures, `${zeroId} ${label}`, "gainsAt0", second.gainsAt0, engine.gainsAt0);
    pins++;
    checkEq(failures, `${zeroId} ${label}`, "gainsAt15", second.gainsAt15, engine.gainsAt15);
    pins++;
    checkEq(failures, `${zeroId} ${label}`, "gainsAt20", second.gainsAt20, engine.gainsAt20);
    pins++;
    checkEq(failures, `${zeroId} ${label}`, "ltcgTax", second.ltcgTax, engine.ltcgTax);
    pins++;
  }

  return { pins, cases, zeroTopPins, zeroTopOnTop };
}

// cgStackTax direct pins: the brief's literal cases plus a
// straddle sweep that compares the helper against both
// the staircase recomputation and the engine's own
// gains-band split for the same stack.
function pinCgStackTax(
  failures: PinFailure[],
  year: number,
  fs: FS,
  sweep: boolean,
): { pins: number; cases: number } {
  const law = lawForYear(year);
  const std = STANDARD_DEDUCTION[year]![fs]!;
  let pins = 0;
  let cases = 0;

  const direct = (
    caseId: string,
    ordinaryTi: number,
    gains: number,
    expectedTax: number,
  ): void => {
    const got = cgStackTax(law, fs, ordinaryTi, gains);
    checkEq(failures, caseId, "cgStackTax", roundCent(got), expectedTax);
    pins++;
    const s = staircase(year, fs, ordinaryTi, gains);
    checkEq(failures, caseId, "cgStackTax vs staircase", roundCent(got), roundCent(s.tax));
    pins++;
  };

  if (year === 2026 && fs === "mfj") {
    direct("cgStackTax straddle (90000, 77300)", 90000, 77300, 10260);
    direct("cgStackTax at0 full (90000, 8900)", 90000, 8900, 0);
    direct("cgStackTax at0+1c (90000, 8901)", 90000, 8901, 0.15);
    direct("cgStackTax 20-floor (0, 613700)", 0, 613700, 77220);
    direct("cgStackTax 20-floor+1c (0, 613701)", 0, 613701, 77220.2);
    cases += 5;
  }

  if (!sweep) return { pins, cases };

  // Full straddle sweep: ordinary taxable income fills
  // the staircase first, so the sweep's gains points are
  // placed relative to the remaining 0% space and the
  // remaining 15% space at each ordinary level.
  const zeroTop = LTCG_ZERO_TOP[year]![fs]!;
  const floor = LTCG_20_FLOOR[year]![fs]!;
  for (const ordinaryTi of [0, 10000, 50000, 90000, zeroTop]) {
    const zeroSpace = Math.max(0, zeroTop - ordinaryTi);
    const floorSpace = Math.max(0, floor - ordinaryTi);
    const gainsPoints = [
      0,
      1000,
      Math.max(0, zeroSpace - CENT),
      zeroSpace,
      zeroSpace + CENT,
      zeroSpace + 100,
      Math.max(0, floorSpace - CENT),
      floorSpace,
      floorSpace + CENT,
      floorSpace + 100,
    ];
    for (const gains of gainsPoints) {
      const caseId = `cgStackTax sweep ${year} ${fs} ordTi ${ordinaryTi} gains ${gains}`;
      const s = staircase(year, fs, ordinaryTi, gains);
      const got = cgStackTax(law, fs, ordinaryTi, gains);
      checkEq(failures, caseId, "cgStackTax vs staircase", roundCent(got), roundCent(s.tax));
      pins++;
      // Same stack through the engine: ordinary income
      // plus gains, standard deduction taken, so the
      // engine's band split must match the staircase.
      const priced = priceYear(
        baseInput(year, fs, { otherOrdinary: ordinaryTi + std, ltcg: gains }),
      );
      cases++;
      checkEq(failures, caseId, "engine gainsAt0", priced.gainsAt0, s.at0);
      pins++;
      checkEq(failures, caseId, "engine gainsAt15", priced.gainsAt15, s.at15);
      pins++;
      checkEq(failures, caseId, "engine gainsAt20", priced.gainsAt20, s.at20);
      pins++;
      checkEq(failures, caseId, "engine ltcgTax", priced.ltcgTax, roundCent(s.tax));
      pins++;
    }
  }
  return { pins, cases };
}

// Fast: MFJ 2026 staircase + stack + cgStackTax spots.
function runFastSet(corrupt?: Corrupt): { failures: PinFailure[]; counts: Record<string, number> } {
  const failures: PinFailure[] = [];
  const s = pinStaircase(failures, 2026, "mfj", corrupt);
  const c = pinCgStackTax(failures, 2026, "mfj", false);
  return {
    failures,
    counts: {
      pins: s.pins + c.pins,
      cases: s.cases + c.cases,
      staircaseSets: 1,
      zeroTopPins: s.zeroTopPins,
      zeroTopOnTop: s.zeroTopOnTop,
      failures: failures.length,
    },
  };
}

// Full: all statuses x both years + the full straddle sweep.
function runFullSet(): { failures: PinFailure[]; counts: Record<string, number> } {
  const failures: PinFailure[] = [];
  let pins = 0;
  let cases = 0;
  let zeroTopPins = 0;
  let zeroTopOnTop = 0;
  for (const year of YEARS) {
    for (const fs of STATUSES) {
      const s = pinStaircase(failures, year, fs);
      pins += s.pins;
      cases += s.cases;
      zeroTopPins += s.zeroTopPins;
      zeroTopOnTop += s.zeroTopOnTop;
      const c = pinCgStackTax(failures, year, fs, true);
      pins += c.pins;
      cases += c.cases;
    }
  }
  return {
    failures,
    counts: {
      pins,
      cases,
      staircaseSets: 6,
      zeroTopPins,
      zeroTopOnTop,
      failures: failures.length,
    },
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
      ? `LTCG staircase pins all pass: ${set.counts.pins} pins across ${set.counts.staircaseSets} staircase sets (${set.counts.cases} priced years). Zero-top proximity ${set.counts.zeroTopOnTop}/${set.counts.zeroTopPins} — every zero-top pin lands exactly on the top, closing the generator's zero-proximity gap. Ordinary income fills the staircase first, and cgStackTax agrees with the staircase recomputation and the engine on every straddle point.`
      : `${set.failures.length} LTCG pin(s) failed — see failures.`,
    failures: set.failures.slice(0, 25),
    counts: set.counts,
  };
}

function runGainsFast(): HardeningCheckResult {
  return resultFrom(
    "boundary-gains",
    "Boundary gains: LTCG 0% top, 20% floor, ordinary-first stack, cgStackTax straddle",
    runFastSet(),
  );
}

function runGainsFull(): HardeningCheckResult {
  return resultFrom(
    "boundary-gains",
    "Boundary gains: LTCG 0% top, 20% floor, ordinary-first stack, cgStackTax straddle",
    runFullSet(),
  );
}

function runGainsTeeth(): HardeningTeethResult {
  // Corrupt one pin by 1 cent: the MFJ 2026 zero-top+1¢
  // gainsAt15, expected $0.01, corrupted to $0.02.
  // Exactly that one pin must fail.
  const corruptedCaseId = "gains 2026 mfj zero-top 98900+1c gainsAt15";
  const set = runFastSet({
    caseId: "gains 2026 mfj zero-top 98900+1c",
    field: "gainsAt15",
    delta: CENT,
  });
  return {
    corruptedCaseId,
    failedCount: set.failures.length,
    pass: set.failures.length === 1,
  };
}

export const boundaryGainsCheck: HardeningCheckModule = {
  id: "boundary-gains",
  name: "Boundary gains: LTCG 0% top, 20% floor, ordinary-first stack, cgStackTax straddle",
  runFast: runGainsFast,
  runFull: runGainsFull,
  runTeeth: runGainsTeeth,
};
