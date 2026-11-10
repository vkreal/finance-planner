/* ---------------- RMD / claiming boundary pins ----------------
   Part 2 of the hardening block (boundary-case fixture
   pack). Pins the required-minimum-distribution ages and
   tables and the Social Security claiming schedule:

   · rmdAgeForBirthYear bands: born 1948 or earlier -> 70.5,
     1949-1950 -> 72, 1951-1959 -> 73, 1960 or later -> 75.
     Every boundary birth year is pinned on both sides,
     plus spot years inside each band.
   · rmdForYear on a $1,000,000 balance: below the RMD age
     the RMD is $0 with a null divisor; the joint table
     applies only when the spouse is the sole beneficiary
     AND more than 10 years younger, so an exactly-10-year
     gap still uses the uniform table.
   · Uniform Lifetime Table divisors (IRS Pub. 590-B) and
     Joint Life and Last Survivor Table cells (Table II),
     including the IRS worked example (75, 64) = 25.3.
   · fullRetirementAgeMonths by birth year (SSA schedule)
     and ssBenefitFactor: 5/9% per month for the first 36
     early months, 5/12% beyond, 2/3% per month delayed
     to age 70. Born 1971 (FRA 67): 62 -> 0.70, 65 -> 0.87
     (rounded), 67 -> 1.0, 70 -> 1.24.
   · ssAnnualAtClaimAge on the fictional sample
     household's $48,000-at-67 anchor: 62 -> $33,600,
     65 -> $41,600, 70 -> $59,520; a missing anchor age
     or an anchor age equal to the claim age returns the
     anchor unchanged. The anchor/claim derivation is
     invoked by the engine through buildCompareScenario
     (rothOptimizer.ts), which calls ssAnnualAtClaimAge
     for each candidate claiming age — the derivation is
     directly callable, so it is pinned directly here.

   A pin that fails against the engine is a FINDING; this
   module never adjusts a pin to make it pass. */

import { rmdForYear } from "../taxEngine";
import {
  UNIFORM_DIVISORS,
  jointDivisor,
  rmdAgeForBirthYear,
  uniformDivisor,
} from "../taxLaw";
import {
  fullRetirementAgeMonths,
  ssAnnualAtClaimAge,
  ssBenefitFactor,
} from "../rothOptimizer";
import type {
  HardeningCheckModule,
  HardeningCheckResult,
  HardeningTeethResult,
} from "./types";

const CENT = 0.01;
// A 1-cent difference is a failure; half a cent of float
// noise is not.
const TOL = 0.005;

const BALANCE = 1000000;
// The fictional sample household's anchor only — never
// any real household's figure.
const ANCHOR_ANNUAL = 48000;
const ANCHOR_AGE = 67;
const ANCHOR_BIRTH_YEAR = 1971;

type PinFailure = string;

type Corrupt = { caseId: string; field: string; delta: number };

function checkEq(
  failures: PinFailure[],
  caseId: string,
  label: string,
  actual: number | string | null,
  expected: number | string | null,
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

// The SSA schedule restated as the pins' expectations, so
// a drift in the engine's table fails loudly instead of
// silently moving the pins.
function expectedFraMonths(birthYear: number): number {
  if (birthYear >= 1960) return 67 * 12;
  if (birthYear >= 1955) return 66 * 12 + (birthYear - 1954) * 2;
  if (birthYear >= 1943) return 66 * 12;
  if (birthYear >= 1938) return 65 * 12 + (birthYear - 1937) * 2;
  return 65 * 12;
}

function expectedFactor(claimAge: number, birthYear: number): number {
  const fraMonths = expectedFraMonths(birthYear);
  const diff = Math.round(claimAge * 12) - fraMonths;
  if (diff < 0) {
    const early = -diff;
    return (
      1 -
      (Math.min(early, 36) * (5 / 9 / 100) +
        Math.max(0, early - 36) * (5 / 12 / 100))
    );
  }
  if (diff > 0) {
    const delayed = Math.min(diff, 70 * 12 - fraMonths);
    return 1 + Math.max(0, delayed) * (2 / 3 / 100);
  }
  return 1;
}

function expectedRmdAge(birthYear: number): number {
  if (birthYear >= 1960) return 75;
  if (birthYear >= 1951) return 73;
  if (birthYear >= 1949) return 72;
  return 70.5;
}

// The fast set: every briefed pin — RMD-age boundaries
// and spots, the $1,000,000 RMD cases, the named uniform
// divisors and joint cells, the FRA table, the claiming
// factors for born 1971, and the anchor derivation.
function runFastSet(corrupt?: Corrupt): {
  failures: PinFailure[];
  counts: Record<string, number>;
} {
  const failures: PinFailure[] = [];
  let pins = 0;
  let cases = 0;

  // RMD-age bands: every boundary birth year on both
  // sides, plus a spot year inside each band.
  for (const [birthYear, expected] of [
    [1940, 70.5],
    [1948, 70.5],
    [1949, 72],
    [1950, 72],
    [1951, 73],
    [1955, 73],
    [1959, 73],
    [1960, 75],
    [1975, 75],
    [2000, 75],
  ] as const) {
    checkEq(
      failures,
      `rmdAge born ${birthYear}`,
      "rmdAge",
      rmdAgeForBirthYear(birthYear),
      expected,
      corrupt,
    );
    pins++;
    cases++;
  }

  // $1,000,000 RMD cases.
  const rmdCases: {
    age: number;
    spouse: number | null;
    birth: number;
    sole: boolean;
    divisor: number | null;
    rmd: number;
    table: "joint" | "uniform" | null;
  }[] = [
    { age: 75, spouse: 64, birth: 1951, sole: false, divisor: 24.6, rmd: 40650.41, table: "uniform" },
    { age: 80, spouse: 70, birth: 1951, sole: true, divisor: 20.2, rmd: 49504.95, table: "uniform" },
    { age: 80, spouse: 69, birth: 1951, sole: true, divisor: 20.9, rmd: 47846.89, table: "joint" },
    // Exactly-10-year gap without sole-beneficiary status:
    // uniform, not joint.
    { age: 80, spouse: 69, birth: 1951, sole: false, divisor: 20.2, rmd: 49504.95, table: "uniform" },
    { age: 72, spouse: null, birth: 1951, sole: false, divisor: null, rmd: 0, table: null },
    { age: 73, spouse: null, birth: 1951, sole: false, divisor: 26.5, rmd: 37735.85, table: "uniform" },
    { age: 74, spouse: null, birth: 1951, sole: false, divisor: 25.5, rmd: 39215.69, table: "uniform" },
    // Birth 1960: RMD age 75, so 74 is below and 75 is at.
    { age: 74, spouse: null, birth: 1960, sole: false, divisor: null, rmd: 0, table: null },
    { age: 75, spouse: null, birth: 1960, sole: false, divisor: 24.6, rmd: 40650.41, table: "uniform" },
  ];
  for (const c of rmdCases) {
    const caseId =
      `rmd age ${c.age}` +
      (c.spouse == null ? " single" : ` spouse ${c.spouse}`) +
      ` born ${c.birth}` +
      (c.sole ? " sole" : "");
    const r = rmdForYear({
      priorDec31PreTax: BALANCE,
      agePrimary: c.age,
      ageSpouse: c.spouse,
      birthYearPrimary: c.birth,
      spouseSoleBeneficiary: c.sole,
    });
    cases++;
    checkEq(failures, caseId, "divisor", r.divisor, c.divisor, corrupt);
    pins++;
    checkEq(failures, caseId, "rmd", r.rmd, c.rmd, corrupt);
    pins++;
    checkEq(failures, caseId, "table", r.table, c.table, corrupt);
    pins++;
  }
  // Named uniform divisors.
  for (const [age, divisor] of [
    [72, 27.4],
    [73, 26.5],
    [75, 24.6],
    [80, 20.2],
    [90, 12.2],
    [120, 2.0],
  ] as const) {
    checkEq(failures, `uniformDivisor ${age}`, "divisor", uniformDivisor(age), divisor, corrupt);
    pins++;
    cases++;
  }

  // Named joint cells.
  for (const [owner, spouse, divisor] of [
    [75, 64, 25.3],
    [75, 54, 33.2],
    [86, 75, 15.9],
    [80, 70, 20.2],
    [80, 69, 20.9],
    [85, 75, 16.0],
  ] as const) {
    checkEq(
      failures,
      `jointDivisor ${owner}/${spouse}`,
      "divisor",
      jointDivisor(owner, spouse),
      divisor,
      corrupt,
    );
    pins++;
    cases++;
  }

  // FRA months by birth year.
  for (const [birthYear, months] of [
    [1936, 780],
    [1937, 780],
    [1938, 782],
    [1942, 790],
    [1943, 792],
    [1954, 792],
    [1955, 794],
    [1959, 802],
    [1960, 804],
    [1971, 804],
  ] as const) {
    checkEq(
      failures,
      `FRA born ${birthYear}`,
      "fraMonths",
      fullRetirementAgeMonths(birthYear),
      months,
      corrupt,
    );
    pins++;
    cases++;
  }

  // Claiming factors, born 1971 (FRA 67).
  for (const [claimAge, factor] of [
    [62, 0.7],
    [63, 0.75],
    [65, 0.8666666666666667],
    [66, 0.9333333333333333],
    [67, 1],
    [68, 1.08],
    [69, 1.16],
    [70, 1.24],
    // No delayed credit past 70.
    [71, 1.24],
  ] as const) {
    checkEq(
      failures,
      `factor ${claimAge} born ${ANCHOR_BIRTH_YEAR}`,
      "factor",
      ssBenefitFactor(claimAge, ANCHOR_BIRTH_YEAR),
      factor,
      corrupt,
    );
    pins++;
    cases++;
  }

  // Anchor derivation on the fictional sample anchor.
  for (const [claimAge, annual] of [
    [62, 33600],
    [63, 36000],
    [65, 41600],
    [67, 48000],
    [70, 59520],
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
  checkEq(
    failures,
    "anchor null anchorAge",
    "annual",
    ssAnnualAtClaimAge(ANCHOR_ANNUAL, null, 62, ANCHOR_BIRTH_YEAR),
    ANCHOR_ANNUAL,
    corrupt,
  );
  pins++;
  cases++;
  checkEq(
    failures,
    "anchor anchorAge equals claimAge",
    "annual",
    ssAnnualAtClaimAge(ANCHOR_ANNUAL, ANCHOR_AGE, ANCHOR_AGE, ANCHOR_BIRTH_YEAR),
    ANCHOR_ANNUAL,
    corrupt,
  );
  pins++;
  cases++;

  return {
    failures,
    counts: { pins, cases, failures: failures.length },
  };
}

// The full set: complete enumeration. Every birth year
// 1900-2000 against the band rule; every uniform divisor
// 72-120 priced through rmdForYear; every joint pair with
// a gap over 10 (owner 71-120 — 70 can never take an
// RMD, the lowest RMD age being 70.5) priced through
// rmdForYear against jointDivisor, with the exactly-10
// gap pinned uniform; joint symmetry on the 70-120
// square; every FRA month 1930-1980; every claiming
// birth year 1937-1975; and the anchor derivation for
// every claim age 62-70.
function runFullSet(): {
  failures: PinFailure[];
  counts: Record<string, number>;
} {
  const failures: PinFailure[] = [];
  let pins = 0;
  let cases = 0;

  for (let birthYear = 1900; birthYear <= 2000; birthYear++) {
    checkEq(
      failures,
      `rmdAge born ${birthYear}`,
      "rmdAge",
      rmdAgeForBirthYear(birthYear),
      expectedRmdAge(birthYear),
    );
    pins++;
    cases++;
  }

  for (let age = 72; age <= 120; age++) {
    const divisor = UNIFORM_DIVISORS[age]!;
    // Age 72 needs a 1949 birth year (RMD age 72); 73+
    // uses 1951 (RMD age 73).
    const birth = age === 72 ? 1949 : 1951;
    const r = rmdForYear({
      priorDec31PreTax: BALANCE,
      agePrimary: age,
      ageSpouse: null,
      birthYearPrimary: birth,
      spouseSoleBeneficiary: false,
    });
    const caseId = `rmd uniform age ${age}`;
    cases++;
    checkEq(failures, caseId, "divisor", r.divisor, divisor);
    pins++;
    checkEq(failures, caseId, "rmd", r.rmd, r2(BALANCE / divisor));
    pins++;
    checkEq(failures, caseId, "table", r.table, "uniform");
    pins++;
    checkEq(failures, `uniformDivisor ${age}`, "divisor", uniformDivisor(age), divisor);
    pins++;
  }

  // Joint grid: every owner 71-120 with a spouse more
  // than 10 years younger (spouse 20 up to owner-11).
  // Owner 70 can never take an RMD: the lowest RMD age
  // is 70.5, so age 70 is always below it. Owners 71-72
  // use a 1948 birth year (RMD age 70.5); 73+ uses 1951
  // (RMD age 73). Each pair is priced through
  // rmdForYear and the divisor must equal jointDivisor
  // for the same pair.
  let jointCells = 0;
  for (let owner = 71; owner <= 120; owner++) {
    for (let spouse = 20; spouse <= owner - 11; spouse++) {
      const expected = jointDivisor(owner, spouse);
      const r = rmdForYear({
        priorDec31PreTax: BALANCE,
        agePrimary: owner,
        ageSpouse: spouse,
        birthYearPrimary: owner <= 72 ? 1948 : 1951,
        spouseSoleBeneficiary: true,
      });
      const caseId = `rmd joint ${owner}/${spouse}`;
      cases++;
      jointCells++;
      checkEq(failures, caseId, "divisor", r.divisor, expected);
      pins++;
      checkEq(failures, caseId, "rmd", r.rmd, r2(BALANCE / expected));
      pins++;
      checkEq(failures, caseId, "table", r.table, "joint");
      pins++;
    }
    // Exactly-10 gap at every owner age: uniform, not joint.
    const spouse10 = owner - 10;
    const u = rmdForYear({
      priorDec31PreTax: BALANCE,
      agePrimary: owner,
      ageSpouse: spouse10,
      birthYearPrimary: owner <= 72 ? 1948 : 1951,
      spouseSoleBeneficiary: true,
    });
    const caseId10 = `rmd gap-10 ${owner}/${spouse10}`;
    cases++;
    checkEq(failures, caseId10, "divisor", u.divisor, uniformDivisor(owner));
    pins++;
    checkEq(failures, caseId10, "table", u.table, "uniform");
    pins++;
  }

  // Joint symmetry on the 70-120 square.
  for (let a = 70; a <= 120; a++) {
    for (let b = 70; b <= 120; b++) {
      checkEq(
        failures,
        `joint symmetry ${a}/${b}`,
        "divisor",
        jointDivisor(a, b),
        jointDivisor(b, a),
      );
      pins++;
      cases++;
    }
  }

  for (let birthYear = 1930; birthYear <= 1980; birthYear++) {
    checkEq(
      failures,
      `FRA born ${birthYear}`,
      "fraMonths",
      fullRetirementAgeMonths(birthYear),
      expectedFraMonths(birthYear),
    );
    pins++;
    cases++;
  }

  for (let birthYear = 1937; birthYear <= 1975; birthYear++) {
    for (let claimAge = 62; claimAge <= 70; claimAge++) {
      checkEq(
        failures,
        `factor ${claimAge} born ${birthYear}`,
        "factor",
        ssBenefitFactor(claimAge, birthYear),
        expectedFactor(claimAge, birthYear),
      );
      pins++;
      cases++;
      checkEq(
        failures,
        `anchor claim ${claimAge} born ${birthYear}`,
        "annual",
        ssAnnualAtClaimAge(ANCHOR_ANNUAL, ANCHOR_AGE, claimAge, birthYear),
        r2((ANCHOR_ANNUAL / expectedFactor(ANCHOR_AGE, birthYear)) * expectedFactor(claimAge, birthYear)),
      );
      pins++;
    }
  }

  return {
    failures,
    counts: { pins, cases, jointCells, failures: failures.length },
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
      ? `RMD / claiming boundary pins all pass: ${set.counts.pins} pins across ${set.counts.cases} cases (RMD-age bands, $1,000,000 RMD cases, uniform and joint table cells, FRA months, claiming factors, and the $48,000-at-67 anchor derivation).`
      : `${set.failures.length} RMD / claiming pin(s) failed — see failures.`,
    failures: set.failures.slice(0, 25),
    counts: set.counts,
  };
}

function runRmdClaimFast(): HardeningCheckResult {
  return resultFrom(
    "boundary-rmd-claim",
    "Boundary RMD / claiming: RMD ages and tables, FRA months, claiming factors, anchor derivation",
    runFastSet(),
  );
}

function runRmdClaimFull(): HardeningCheckResult {
  return resultFrom(
    "boundary-rmd-claim",
    "Boundary RMD / claiming: RMD ages and tables, FRA months, claiming factors, anchor derivation",
    runFullSet(),
  );
}

function runRmdClaimTeeth(): HardeningTeethResult {
  // The clean fast run must pass first.
  const clean = runFastSet();
  if (clean.failures.length !== 0) {
    return {
      corruptedCaseId: "boundary-rmd-claim:clean-run-failed",
      failedCount: clean.failures.length,
      pass: false,
    };
  }
  // Corrupt one pin by 1 cent: the uniform-table RMD at
  // age 75 on $1,000,000, expected $40,650.41,
  // corrupted to $40,650.42. Exactly that one pin must
  // fail.
  const corruptedCaseId = "rmd age 75 spouse 64 born 1951 rmd";
  const set = runFastSet({
    caseId: "rmd age 75 spouse 64 born 1951",
    field: "rmd",
    delta: CENT,
  });
  return {
    corruptedCaseId,
    failedCount: set.failures.length,
    pass: set.failures.length === 1,
  };
}

export const boundaryRmdClaimCheck: HardeningCheckModule = {
  id: "boundary-rmd-claim",
  name: "Boundary RMD / claiming: RMD ages and tables, FRA months, claiming factors, anchor derivation",
  runFast: runRmdClaimFast,
  runFull: runRmdClaimFull,
  runTeeth: runRmdClaimTeeth,
};
