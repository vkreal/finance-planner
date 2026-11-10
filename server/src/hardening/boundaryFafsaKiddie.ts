/* ---------------- FAFSA gate + kiddie-tax boundary pins ----------------
   Part 2 of the hardening block (boundary-case fixture pack).
   Two boundaries that turn on a single dollar:

   (a) The FAFSA college watch-out (taxEngine.ts, march
   warnings): a conversion in tax year Y feeds the FAFSA for
   academic year Y+2, so the watch-out fires only when the
   household's college window covers Y+2, the year converts,
   and need-based aid is arithmetically reachable — 5.64% of
   the plan's FAFSA-reportable assets below a $40,000 public
   cost of attendance. The asset boundary sits between
   $709,219 (5.64% = $39,999.9516 < $40,000, present) and
   $709,220 (5.64% = $40,000.008 >= $40,000, absent). Unknown
   assets (field absent or null) never suppress.

   (b) The kiddie-tax threshold (taxLaw.ts, read by
   giftModel.ts): kiddieTaxThresholdCents = 270,000 ($2,700);
   the excess over the threshold is what the Form 8615 path
   prices. The gains stack the excess is priced on is
   cgStackTax (giftModel.ts): ordinary taxable income fills
   the staircase first, then the gains price at 0% up to the
   year's zero top ($98,900 MFJ 2026), 15% to the 20% floor
   ($613,700 MFJ 2026), 20% above. The straddle pins sit on
   the zero top: with $90,000 of ordinary taxable income the
   remaining 0% space is $8,900.

   Scope note: the full computeGiftComparison pin (child tax
   and net-to-child on the golden kiddie case) stays in the
   fixture suite; this module pins the threshold constant,
   the excess boundary, and the stack the excess prices on.
   The 20%-floor cgStackTax points belong to the gains
   module, not this one.

   Every pin is hand-derived and was probe-verified against
   the engine before this module was written. A pin that
   fails against the engine is a finding, never a reason to
   loosen the pin. The march runs price the fictional sample
   household's shape only through the fixture-replicated
   base plan below — never any real household's figures. */

import {
  DEFAULT_DRAW_ORDER,
  FAFSA_PARENT_ASSET_RATE,
  FAFSA_PUBLIC_COA_BENCHMARK,
  simulateRothPlan,
} from "../taxEngine";
import type { RothPlanInputs, RothStrategy } from "../taxEngine";
import { cgStackTax } from "../giftModel";
import { TAX_LAW_2025, TAX_LAW_2026, lawForYear } from "../taxLaw";
import type {
  HardeningCheckModule,
  HardeningCheckResult,
  HardeningTeethResult,
} from "./types";

// The fixture-replicated march plan (taxFixtures.ts
// "fafsa-college-gate" basePlan): a short plan that converts
// under Fill 12% in 2026-2029 with the college window set to
// falls 2028-2031, so every converting year feeds a FAFSA
// inside the window (tax year Y -> academic year Y+2) — four
// converting years. Replicated here field for field; the
// fixture helpers are never imported.
function fafsaBasePlan(
  over: Partial<RothPlanInputs>,
): RothPlanInputs {
  return {
    startYear: 2026,
    birthYearPrimary: 1969,
    birthYearSpouse: 1980,
    filingStatus: "mfj",
    endAgePrimary: 60,
    pretaxStart: 1000000,
    rothStart: 0,
    taxableStart: 1000000,
    hsaStart: 0,
    taxableBasisPct: 100,
    annualSpending: 0,
    retirementAge: 57,
    expectedReturnPct: 0,
    ssPrimaryAnnual: 0,
    ssPrimaryStartAge: null,
    ssSpouseAnnual: 0,
    ssSpouseStartAge: null,
    otherOrdinaryAnnual: 0,
    taxExemptInterestAnnual: 0,
    convertedAlreadyThisYear: 0,
    windowStartAge: 57,
    windowStopAge: 74,
    payTaxFrom: "taxable",
    protectMinTaxable: 0,
    drawOrder: [...DEFAULT_DRAW_ORDER],
    spouseSoleBeneficiary: true,
    acaHouseholdSize: 3,
    acaHouseholdSchedule: null,
    acaBenchmarkCouple: null,
    acaBenchmarkSingle: null,
    acaBenchmarkFamily: null,
    inflationPct: 2.5,
    stateRatePct: 0,
    heirRatePct: 22,
    ...over,
  };
}

const FILL_12: RothStrategy = {
  id: "fill12",
  name: "Fill 12%",
  ceilings: {
    bracketTopPct: 12,
    irmaaTierCap: null,
    ltcgZeroCap: false,
    acaCliffCap: false,
    acaCliffCapFamilyOnly: false,
    magiCap: null,
    acaCliffBuffer: null,
  },
};

const COLLEGE_TEXT =
  "College years: conversion income in this year counts as FAFSA income (prior-prior year) during a child's college years.";

function collegeCount(res: ReturnType<typeof simulateRothPlan>): number {
  return res.years.reduce(
    (n, y) => n + y.warnings.filter((w) => w.kind === "college").length,
    0,
  );
}

function runFafsa(
  fafsaReportableAssets?: number | null,
): ReturnType<typeof simulateRothPlan> {
  return simulateRothPlan(
    fafsaBasePlan({
      collegeFallFromYear: 2028,
      collegeFallThroughYear: 2031,
      ...(fafsaReportableAssets !== undefined
        ? { fafsaReportableAssets }
        : {}),
    }),
    FILL_12,
  );
}

function stripWarnings(res: ReturnType<typeof simulateRothPlan>): string {
  return JSON.stringify({
    ...res,
    years: res.years.map((y) => ({ ...y, warnings: [] })),
  });
}

function otherWarnings(res: ReturnType<typeof simulateRothPlan>): string {
  return JSON.stringify(
    res.years.map((y) => y.warnings.filter((w) => w.kind !== "college")),
  );
}

// The kiddie excess: the gain above the law row's threshold
// in dollars, floored at $0 — the amount the Form 8615 path
// prices (giftModel.ts).
function kiddieExcess(gain: number, saleYear: number): number {
  return Math.max(0, gain - lawForYear(saleYear).kiddieTaxThresholdCents / 100);
}

function checkFafsaKiddie(
  args: { full: boolean; collegeCountOverride?: Record<string, number> },
): { failures: string[]; counts: Record<string, number> } {
  const failures: string[] = [];
  const counts: Record<string, number> = {};

  // (a) The constants themselves, and the boundary
  // arithmetic in the open.
  if (FAFSA_PARENT_ASSET_RATE !== 0.0564) {
    failures.push(
      `fafsa rate: ${FAFSA_PARENT_ASSET_RATE}, expected 0.0564`,
    );
  }
  if (FAFSA_PUBLIC_COA_BENCHMARK !== 40000) {
    failures.push(
      `fafsa benchmark: ${FAFSA_PUBLIC_COA_BENCHMARK}, expected 40000`,
    );
  }
  const assessedBelow = 0.0564 * 709219;
  const assessedAbove = 0.0564 * 709220;
  if (Math.abs(assessedBelow - 39999.9516) > 0.0001) {
    failures.push(`fafsa 709219 assessed: ${assessedBelow}, expected 39999.9516`);
  }
  if (Math.abs(assessedAbove - 40000.008) > 0.0001) {
    failures.push(`fafsa 709220 assessed: ${assessedAbove}, expected 40000.008`);
  }
  if (!(assessedBelow < 40000)) {
    failures.push(`fafsa 709219 assessed ${assessedBelow} is not below 40000`);
  }
  if (!(assessedAbove >= 40000)) {
    failures.push(`fafsa 709220 assessed ${assessedAbove} is not at or above 40000`);
  }
  counts.constantPins = 6;

  // (a) The gate, through the march. Fast: just the two
  // sides of the boundary. Full: the whole fixture set
  // plus the identical-apart-from-warnings assertions.
  const checkRun = (
    label: string,
    res: ReturnType<typeof simulateRothPlan>,
    expected: number,
  ) => {
    const got = collegeCount(res);
    const want = args.collegeCountOverride?.[label] ?? expected;
    if (got !== want) {
      failures.push(`fafsa ${label}: ${got} college warnings, expected ${want}`);
    }
  };
  const below = runFafsa(709219);
  const above = runFafsa(709220);
  counts.marchRuns = 2;
  checkRun("709219", below, 4);
  checkRun("709220", above, 0);
  if (args.full) {
    checkRun("700000", runFafsa(700000), 4);
    checkRun("absent", runFafsa(undefined), 4);
    checkRun("null", runFafsa(null), 4);
    checkRun("2700000", runFafsa(2700000), 0);
    counts.marchRuns += 4;
    // The just-below and just-above runs are identical apart
    // from the years' warnings arrays, and their non-college
    // warnings are identical.
    if (stripWarnings(below) !== stripWarnings(above)) {
      failures.push("fafsa 709219 vs 709220: runs differ apart from warnings");
    }
    if (otherWarnings(below) !== otherWarnings(above)) {
      failures.push("fafsa 709219 vs 709220: non-college warnings differ");
    }
    counts.identityPins = 2;
    // The warning text on the first converting year.
    const text =
      below.years[0]?.warnings.find((w) => w.kind === "college")?.text ?? null;
    if (text !== COLLEGE_TEXT) {
      failures.push(`fafsa college text: ${JSON.stringify(text)}`);
    }
    counts.textPins = 1;
  }

  // (b) The kiddie threshold constant and the excess boundary.
  if (TAX_LAW_2026.kiddieTaxThresholdCents !== 270000) {
    failures.push(
      `kiddie threshold 2026: ${TAX_LAW_2026.kiddieTaxThresholdCents}c, expected 270000c`,
    );
  }
  if (TAX_LAW_2025.kiddieTaxThresholdCents !== 270000) {
    failures.push(
      `kiddie threshold 2025: ${TAX_LAW_2025.kiddieTaxThresholdCents}c, expected 270000c`,
    );
  }
  if (kiddieExcess(2700, 2026) !== 0) {
    failures.push(`kiddie excess at threshold: ${kiddieExcess(2700, 2026)}, expected 0`);
  }
  if (kiddieExcess(2701, 2026) !== 1) {
    failures.push(`kiddie excess threshold+1: ${kiddieExcess(2701, 2026)}, expected 1`);
  }
  if (kiddieExcess(64700, 2026) !== 62000) {
    failures.push(`kiddie excess 64700: ${kiddieExcess(64700, 2026)}, expected 62000`);
  }
  counts.kiddiePins = 5;

  // (b) The gains stack the excess prices on (MFJ 2026, zero
  // top $98,900): with $90,000 of ordinary taxable income
  // the remaining 0% space is $8,900.
  const stackPins: { id: string; ordinaryTi: number; gains: number; tax: number }[] = [
    { id: "cg-stack-at0-full", ordinaryTi: 90000, gains: 8900, tax: 0 },
    { id: "cg-stack-at0-plus1c", ordinaryTi: 90000, gains: 8901, tax: 0.15 },
    { id: "cg-stack-straddle", ordinaryTi: 90000, gains: 77300, tax: 10260 },
  ];
  for (const pin of stackPins) {
    const got = cgStackTax(TAX_LAW_2026, "mfj", pin.ordinaryTi, pin.gains);
    counts.stackPins = (counts.stackPins ?? 0) + 1;
    if (Math.abs(got - pin.tax) > 0.001) {
      failures.push(`${pin.id}: got ${got}, expected ${pin.tax}`);
    }
  }

  return { failures, counts };
}

function runFafsaKiddieInner(full: boolean): HardeningCheckResult {
  const { failures, counts } = checkFafsaKiddie({ full });
  counts.failures = failures.length;
  const detail =
    `FAFSA college gate: the 5.64% x assets boundary sits between $709,219 ` +
    `($39,999.9516, watch-out present on all 4 converting years) and ` +
    `$709,220 ($40,000.008, absent)` +
    (full
      ? `; full run adds $700,000 / absent / null (present) and $2,700,000 (absent), ` +
        `the identical-apart-from-warnings assertion, and the exact warning text; `
      : `; the wider asset set runs in the full run only; `) +
    `kiddie threshold $2,700 with the excess boundary ($2,700 -> $0, ` +
    `$2,701 -> $1) and 3 cgStackTax straddle pins on the MFJ 2026 zero top; ` +
    `${failures.length} failures.`;
  return {
    id: "boundary-fafsa-kiddie",
    name: "FAFSA college gate and kiddie-tax threshold boundary pins",
    pass: failures.length === 0,
    detail,
    failures: failures.slice(0, 25),
    counts,
  };
}

function runFafsaKiddieTeeth(): HardeningTeethResult {
  const clean = checkFafsaKiddie({ full: true });
  if (clean.failures.length !== 0) {
    return {
      corruptedCaseId: "boundary-fafsa-kiddie:clean-run-failed",
      failedCount: clean.failures.length,
      pass: false,
    };
  }
  // Corrupt one pin by one warning: the just-below run
  // should carry 4 college warnings, not 3.
  const corrupted = checkFafsaKiddie({
    full: false,
    collegeCountOverride: { "709219": 3 },
  });
  const teeth =
    corrupted.failures.length === 1 &&
    corrupted.failures[0]?.startsWith("fafsa 709219:") === true;
  return {
    corruptedCaseId: "boundary-fafsa-kiddie:fafsa-709219-count-4-to-3",
    failedCount: corrupted.failures.length,
    pass: teeth,
  };
}

export const boundaryFafsaKiddieCheck: HardeningCheckModule = {
  id: "boundary-fafsa-kiddie",
  name: "FAFSA college gate and kiddie-tax threshold boundary pins",
  runFast: () => runFafsaKiddieInner(false),
  runFull: () => runFafsaKiddieInner(true),
  runTeeth: runFafsaKiddieTeeth,
};
