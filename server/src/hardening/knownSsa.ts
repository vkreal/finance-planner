/* ---------------- Known-answer SSA pins ----------------
   Part 3 of the hardening block (known-answer checks).
   Prices the Social Security Administration's own
   published benefit examples against the engine's
   claiming-age derivation (ssBenefitFactor /
   ssAnnualAtClaimAge in rothOptimizer.ts):

   · Age 62, worker column — SSA Benefits Planner page
     "Retirement Age and Benefit Reduction"
     (ssa.gov/benefits/retirement/planner/agereduction.html),
     chart "Full Retirement and Age 62 Benefit By Year Of
     Birth". Basis stated on the page: "an estimated
     monthly benefit of $1000 at full retirement age."
     The page prints these rows (worker columns only):
       1943-1954  FRA 66, 48 mo early  $750  25.00%
       1955       FRA 66y2m, 50 mo    $741  25.83%
       1956       FRA 66y4m, 52 mo    $733  26.67%
       1957       FRA 66y6m, 54 mo    $725  27.50%
       1958       FRA 66y8m, 56 mo    $716  28.33%
       1959       FRA 66y10m, 58 mo   $708  29.17%
       1960+      FRA 67, 60 mo       $700  30.00%
     No rows for birth years before 1943 are printed on
     that page. The FRA-months table and the integer-age
     claiming factors for born 1971 are already pinned by
     boundaryRmdClaim and are NOT re-pinned here.
   · Age 70, percent of FRA benefit — the age-reduction
     page prints NO age-70 column, so these pins are
     sourced to SSA's delayed-retirement-credit chart,
     POMS RS 00615.693 ("Estimating the Effect of Delayed
     Retirement Credits"), Age 70 row: 1943-1954: 132.0%,
     1955: 130.7%, 1956: 129.3%, 1957: 128.0%, 1958:
     126.7%, 1959: 125.3%, 1960 or later: 124.0%. The
     module pins the exact fractions behind those
     rounded prints (e.g. 1955: 130.666...%, POMS prints
     130.7% to one decimal), which agree with the POMS
     prints well inside TOL.
   · The $1,000-at-FRA illustration: at FRA 67,
     $1,000/month at full retirement is $700 at 62 and
     $1,240 at 70 — SSA's standard illustration, priced
     here through ssAnnualAtClaimAge on a $12,000/yr
     at-67 anchor: 62 -> $8,400/yr, 70 -> $14,880/yr.

   Rounding convention (adjudicated in advance): SSA
   prints monthly benefits TRUNCATED to whole dollars
   ($741, not $741.67) and states on the page that its
   "percentages are approximate due to rounding". The
   engine prices to the cent at the exact factor, so the
   factor pins are exact (TOL 0.005) while the dollar
   pins carry a $1.00 tolerance with the truncation
   convention stated here; the engine is NOT forced to
   SSA's truncation. SSA's annualized figure is the
   truncated monthly x 12 (e.g. $741 x 12 = $8,892 vs
   the engine's $8,900.00), so MONTHLY dollars are
   pinned, never SSA-annualized dollars.

   Out of scope (not pinned, by design):
   · The chart's SPOUSAL columns (e.g. a $500 spouse's
     benefit reduced to $325 at 62 for born 1960 or
     later): the engine deliberately does not model
     spousal benefits.
   · The PIA bend-point formula and its worked example
     (SSA's piaformula page: 2026 bend points $1,286 /
     $7,749, AIME $14,358 -> PIA $4,216.90): the engine
     has no AIME-to-PIA function; it takes the benefit
     as an input anchor.
   · The 20 CFR 404.410(a) monthly example ($980.50
     started 44 months early -> $751.70): the engine
     models whole-year claiming ages only, not monthly
     claiming with dime rounding.

   A pin that fails against the engine is a FINDING; this
   module never adjusts a pin to make it pass. */

import {
  ssAnnualAtClaimAge,
  ssBenefitFactor,
} from "../rothOptimizer";
import type {
  HardeningCheckModule,
  HardeningCheckResult,
  HardeningTeethResult,
} from "./types";

const TOL = 0.005;
// SSA prints monthly dollars truncated to whole dollars,
// so a dollar pin tolerates $1.00 (the largest possible
// truncation gap is under $1.00).
const DOLLAR_TOL = 1.0;

const MONTHLY_AT_FRA = 1000;
// The $1,000-at-FRA illustration, priced as an annual
// anchor at FRA 67 for a worker born 1960 or later.
const ANCHOR_ANNUAL = 12000;
const ANCHOR_AGE = 67;
const ANCHOR_BIRTH_YEAR = 1960;

type PinFailure = string;

type Corrupt = { caseId: string; field: string; delta: number };

function checkEq(
  failures: PinFailure[],
  caseId: string,
  label: string,
  actual: number | string | null,
  expected: number | string | null,
  corrupt?: Corrupt,
  tol: number = TOL,
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
      ? Math.abs(actual - exp) <= tol
      : actual === exp;
  if (!ok) {
    failures.push(`${caseId} ${label}: actual=${actual} expected=${exp}`);
  }
}

// One printed row of the SSA age-62 chart (worker
// columns) plus the same row's age-70 percent from the
// POMS delayed-retirement-credit chart. reductionPct and
// factor70 are the SSA-published values; monthly62 is
// SSA's truncated whole-dollar print.
type SsaRow = {
  birthYear: number;
  label: string;
  reductionPct: number;
  monthly62: number;
  factor70: number;
};

// The seven rows the SSA age-62 chart prints, one
// representative birth year per row (1943 stands for the
// grouped 1943-1954 row, 1960 for "1960 and later").
const CHART_ROWS: SsaRow[] = [
  { birthYear: 1943, label: "1943-1954", reductionPct: 25.0, monthly62: 750, factor70: 1.32 },
  { birthYear: 1955, label: "1955", reductionPct: 25.83, monthly62: 741, factor70: 1.3066666666666666 },
  { birthYear: 1956, label: "1956", reductionPct: 26.67, monthly62: 733, factor70: 1.2933333333333332 },
  { birthYear: 1957, label: "1957", reductionPct: 27.5, monthly62: 725, factor70: 1.28 },
  { birthYear: 1958, label: "1958", reductionPct: 28.33, monthly62: 716, factor70: 1.2666666666666666 },
  { birthYear: 1959, label: "1959", reductionPct: 29.17, monthly62: 708, factor70: 1.2533333333333334 },
  { birthYear: 1960, label: "1960+", reductionPct: 30.0, monthly62: 700, factor70: 1.24 },
];

// The chart row governing any birth year: the grouped
// 1943-1954 row, the single-year rows 1955-1959, and
// the 1960-or-later row for every later year.
function rowForBirthYear(birthYear: number): SsaRow {
  if (birthYear >= 1960) return CHART_ROWS[6]!;
  if (birthYear >= 1955) return CHART_ROWS[birthYear - 1955 + 1]!;
  return CHART_ROWS[0]!;
}

// The three pins for one chart row: the age-62 factor
// (from SSA's published reduction percent), the age-62
// monthly dollar on the $1,000-at-FRA basis (SSA's
// truncated print, $1.00 tolerance), and the age-70
// factor (POMS Age 70 row).
function checkRow(
  failures: PinFailure[],
  row: SsaRow,
  corrupt?: Corrupt,
): void {
  const caseId62 = `ssa62 born ${row.label}`;
  checkEq(
    failures,
    caseId62,
    "factor62",
    ssBenefitFactor(62, row.birthYear),
    1 - row.reductionPct / 100,
    corrupt,
  );
  checkEq(
    failures,
    caseId62,
    "monthly",
    ssBenefitFactor(62, row.birthYear) * MONTHLY_AT_FRA,
    row.monthly62,
    corrupt,
    DOLLAR_TOL,
  );
  checkEq(
    failures,
    `ssa70 born ${row.label}`,
    "factor70",
    ssBenefitFactor(70, row.birthYear),
    row.factor70,
    corrupt,
  );
}

// The fast set: every printed chart row (one
// representative birth year each) for both columns, plus
// the $1,000-at-FRA illustration priced through the
// anchor derivation at 62, 67, and 70.
function runFastSet(corrupt?: Corrupt): {
  failures: PinFailure[];
  counts: Record<string, number>;
} {
  const failures: PinFailure[] = [];
  let pins = 0;
  let cases = 0;

  for (const row of CHART_ROWS) {
    checkRow(failures, row, corrupt);
    pins += 3;
    cases++;
  }

  for (const [claimAge, annual] of [
    [62, 8400],
    [67, 12000],
    [70, 14880],
  ] as const) {
    checkEq(
      failures,
      `anchor claim ${claimAge}`,
      "annual",
      ssAnnualAtClaimAge(ANCHOR_ANNUAL, ANCHOR_AGE, claimAge, ANCHOR_BIRTH_YEAR),
      annual,
      corrupt,
    );
    pins++;
    cases++;
  }

  return {
    failures,
    counts: { pins, cases, failures: failures.length },
  };
}

// The full set: every birth year the chart rows cover —
// each year 1943-1954 individually under the grouped
// row, 1955-1959, and 1960-or-later spot years (1960,
// 1961, 1971, 2000) — for both columns, plus the anchor
// derivation for every claim age 62-70.
function runFullSet(): {
  failures: PinFailure[];
  counts: Record<string, number>;
} {
  const failures: PinFailure[] = [];
  let pins = 0;
  let cases = 0;

  const birthYears: number[] = [];
  for (let y = 1943; y <= 1954; y++) birthYears.push(y);
  for (let y = 1955; y <= 1959; y++) birthYears.push(y);
  birthYears.push(1960, 1961, 1971, 2000);
  for (const birthYear of birthYears) {
    const row = rowForBirthYear(birthYear);
    // Same published row values, priced at this year's
    // own birth year so an FRA-table drift fails loudly.
    const caseId62 = `ssa62 born ${birthYear}`;
    checkEq(
      failures,
      caseId62,
      "factor62",
      ssBenefitFactor(62, birthYear),
      1 - row.reductionPct / 100,
    );
    checkEq(
      failures,
      caseId62,
      "monthly",
      ssBenefitFactor(62, birthYear) * MONTHLY_AT_FRA,
      row.monthly62,
      undefined,
      DOLLAR_TOL,
    );
    checkEq(
      failures,
      `ssa70 born ${birthYear}`,
      "factor70",
      ssBenefitFactor(70, birthYear),
      row.factor70,
    );
    pins += 3;
    cases++;
  }

  for (const [claimAge, annual] of [
    [62, 8400],
    [63, 9000],
    [64, 9600],
    [65, 10400],
    [66, 11200],
    [67, 12000],
    [68, 12960],
    [69, 13920],
    [70, 14880],
  ] as const) {
    checkEq(
      failures,
      `anchor claim ${claimAge}`,
      "annual",
      ssAnnualAtClaimAge(ANCHOR_ANNUAL, ANCHOR_AGE, claimAge, ANCHOR_BIRTH_YEAR),
      annual,
    );
    pins++;
    cases++;
  }

  return {
    failures,
    counts: { pins, cases, failures: failures.length },
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
      ? `SSA known-answer pins all pass: ${set.counts.pins} pins across ${set.counts.cases} cases (age-62 worker factors and truncated monthly dollars from SSA's age-reduction chart, age-70 factors from SSA POMS RS 00615.693, and the $1,000-at-FRA illustration priced through the anchor derivation).`
      : `${set.failures.length} SSA known-answer pin(s) failed — see failures.`,
    failures: set.failures.slice(0, 25),
    counts: set.counts,
  };
}

function runSsaFast(): HardeningCheckResult {
  return resultFrom(
    "known-ssa",
    "Known-answer SSA: published age-62 and age-70 benefit examples vs the claiming-age derivation",
    runFastSet(),
  );
}

function runSsaFull(): HardeningCheckResult {
  return resultFrom(
    "known-ssa",
    "Known-answer SSA: published age-62 and age-70 benefit examples vs the claiming-age derivation",
    runFullSet(),
  );
}

function runSsaTeeth(): HardeningTeethResult {
  // The clean fast run must pass first.
  const clean = runFastSet();
  if (clean.failures.length !== 0) {
    return {
      corruptedCaseId: "known-ssa:clean-run-failed",
      failedCount: clean.failures.length,
      pass: false,
    };
  }
  // Corrupt one pin by $2.00: the age-62 monthly dollar
  // for born 1955, SSA $741, corrupted to $743. The
  // dollar pins carry a $1.00 tolerance (SSA truncates
  // to whole dollars), so a 1-cent corruption would NOT
  // fail; $2.00 is the smallest whole-dollar corruption
  // that must fail. Exactly that one pin must fail.
  const corruptedCaseId = "ssa62 born 1955 monthly";
  const set = runFastSet({
    caseId: "ssa62 born 1955",
    field: "monthly",
    delta: 2,
  });
  return {
    corruptedCaseId,
    failedCount: set.failures.length,
    pass: set.failures.length === 1,
  };
}

export const knownSsaCheck: HardeningCheckModule = {
  id: "known-ssa",
  name: "Known-answer SSA: published age-62 and age-70 benefit examples vs the claiming-age derivation",
  runFast: runSsaFast,
  runFull: runSsaFull,
  runTeeth: runSsaTeeth,
};
