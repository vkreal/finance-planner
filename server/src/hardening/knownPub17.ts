/* ---------------- IRS Publication 17 known-answer pins ----------------
   Part 3 of the hardening block (known-answer checks). Pins
   IRS Publication 17 (2025), "Your Federal Income Tax",
   Chapter 10 (Standard Deduction), worked examples against
   the engine's standard-deduction computation:

   · Example 1 (Table 10-1): married couple filing
     jointly for 2025, neither blind, neither claimable
     as a dependent, not itemizing -> standard deduction
     $31,500. Priced end-to-end through priceYear.
   · Example 3 (Table 10-2): same facts except BOTH
     spouses are 65 or older at end of 2025 -> $34,700
     ($31,500 base + 2 x $1,600 age-65 add-on). Priced
     end-to-end through priceYear.
   · The law rows themselves are pinned against the
     tables: 2025 base mfj $31,500 / single $15,750 /
     hoh $23,625 with age-65 add-ons mfj $1,600 /
     single $2,000 / hoh $2,000 (Tables 10-1/10-2), and
     the 2026 row against Rev. Proc. 2025-32 (base mfj
     $32,200 / single $16,100 / hoh $24,150; add-ons
     mfj $1,650 / single $2,050 / hoh $2,050) — verified
     against the published figures, not taken from the
     engine's constants.

   OUT OF SCOPE, recorded here rather than pinned:
   · Example 2 (one spouse blind at end of 2025 ->
     $33,100): NOT priceable. The engine has no
     blindness concept (no "blind" in taxLaw.ts,
     taxEngine.ts, or rothOptimizer.ts). The age/blind
     additional amount is a single per-condition amount
     under IRC §63(f) and the engine prices only the
     age-65 half of it. No blindness input is added.
   · Table 10-3 dependent examples (e.g. wages $150 ->
     $1,350; wages $3,800 -> $4,250, the greater of
     $1,350 or earned income plus $450, capped at the
     regular standard deduction): NOT priceable. The
     engine has no dependent-standard-deduction concept.
   · The IRS Tax Table (Pub. 17, 2025 Tax Table):
     NOT priceable by design. The engine computes
     federal tax from the formula brackets, not from
     the $50-range Tax Table. The bracket tops
     themselves are already pinned by boundary-brackets
     (recorded as covered, not re-pinned here).

   A pin that fails against the engine is a FINDING; this
   module never adjusts a pin to make it pass. */

import { priceYear, type PriceYearInput } from "../taxEngine";
import { lawForYear, type FilingStatus } from "../taxLaw";
import type {
  HardeningCheckModule,
  HardeningCheckResult,
  HardeningTeethResult,
} from "./types";

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

// The published standard-deduction rows, restated as the
// pins' expectations so a drift in the engine's law table
// fails loudly instead of silently moving the pins.
// 2025: Pub. 17 (2025), Ch. 10, Tables 10-1/10-2.
// 2026: Rev. Proc. 2025-32.
const PUBLISHED: Record<
  number,
  { base: Record<FilingStatus, number>; addon: Record<FilingStatus, number> }
> = {
  2025: {
    base: { mfj: 31500, single: 15750, hoh: 23625 },
    addon: { mfj: 1600, single: 2000, hoh: 2000 },
  },
  2026: {
    base: { mfj: 32200, single: 16100, hoh: 24150 },
    addon: { mfj: 1650, single: 2050, hoh: 2050 },
  },
};

const STATUSES: FilingStatus[] = ["mfj", "single", "hoh"];

// How many age-65 add-ons a status can carry: a joint
// return counts both spouses; single / head of household
// count only the primary filer.
function maxCount65(fs: FilingStatus): number {
  return fs === "mfj" ? 2 : 1;
}

function baseInput(
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

// Ages that produce exactly `count` age-65 filers for the
// status: primary 65+ counts once; on a joint return the
// spouse 65+ counts a second time. A 64-year-old does not
// count (count65 uses >= 65).
function agesForCount(fs: FilingStatus, count: number): {
  agePrimary: number;
  ageSpouse: number | null;
} {
  if (fs === "mfj") {
    if (count === 2) return { agePrimary: 66, ageSpouse: 67 };
    if (count === 1) return { agePrimary: 65, ageSpouse: 64 };
    return { agePrimary: 60, ageSpouse: 58 };
  }
  if (count === 1) return { agePrimary: 65, ageSpouse: null };
  return { agePrimary: 60, ageSpouse: null };
}

function lawPins(
  failures: PinFailure[],
  counts: { pins: number; cases: number },
  corrupt?: Corrupt,
): void {
  for (const year of [2025, 2026] as const) {
    for (const fs of STATUSES) {
      const law = lawForYear(year);
      const caseId = `law ${year} ${fs}`;
      counts.cases++;
      checkEq(failures, caseId, "standardDeduction", law.standardDeduction[fs], PUBLISHED[year]!.base[fs], corrupt);
      counts.pins++;
      checkEq(failures, caseId, "age65Addon", law.age65Addon[fs], PUBLISHED[year]!.addon[fs], corrupt);
      counts.pins++;
    }
  }
}

function priceYearPins(
  failures: PinFailure[],
  counts: { pins: number; cases: number },
  year: number,
  fs: FilingStatus,
  count: number,
  caseId: string,
  corrupt?: Corrupt,
): void {
  const ages = agesForCount(fs, count);
  const r = priceYear(
    baseInput(year, fs, {
      agePrimary: ages.agePrimary,
      ageSpouse: ages.ageSpouse,
    }),
  );
  const expected =
    PUBLISHED[year]!.base[fs] + PUBLISHED[year]!.addon[fs] * count;
  counts.cases++;
  checkEq(failures, caseId, "standardDeduction", r.standardDeduction, expected, corrupt);
  counts.pins++;
  checkEq(failures, caseId, "count65", r.count65, count, corrupt);
  counts.pins++;
  checkEq(failures, caseId, "age65AddonTotal", r.age65AddonTotal, PUBLISHED[year]!.addon[fs] * count, corrupt);
  counts.pins++;
  checkEq(failures, caseId, "baseStandardDeduction", r.baseStandardDeduction, PUBLISHED[year]!.base[fs], corrupt);
  counts.pins++;
}

// The fast set: the law-row pins for 2025 and 2026 plus
// Pub. 17 Examples 1 and 3 end-to-end through priceYear
// (2025, mfj, count65 0 -> $31,500; count65 2 -> $34,700).
function runFastSet(corrupt?: Corrupt): {
  failures: PinFailure[];
  counts: Record<string, number>;
} {
  const failures: PinFailure[] = [];
  const counts = { pins: 0, cases: 0 };
  lawPins(failures, counts, corrupt);
  priceYearPins(failures, counts, 2025, "mfj", 0, "pub17 ex1 mfj 2025", corrupt);
  priceYearPins(failures, counts, 2025, "mfj", 2, "pub17 ex3 mfj 2025 both 65+", corrupt);
  return {
    failures,
    counts: { ...counts, failures: failures.length },
  };
}

// The full set: the fast set plus every filing status x
// 0/1/2 age-65 add-ons through priceYear, both years,
// where the status allows the count (single / hoh max 1,
// mfj max 2) — except the two combinations the fast set
// already prices (mfj 2025 count 0 and count 2).
function runFullSet(): {
  failures: PinFailure[];
  counts: Record<string, number>;
} {
  const fast = runFastSet();
  const failures = fast.failures;
  const counts = {
    pins: fast.counts.pins ?? 0,
    cases: fast.counts.cases ?? 0,
  };
  let matrixCases = 0;
  for (const year of [2025, 2026] as const) {
    for (const fs of STATUSES) {
      for (let count = 0; count <= maxCount65(fs); count++) {
        if (year === 2025 && fs === "mfj" && (count === 0 || count === 2)) {
          continue;
        }
        priceYearPins(
          failures,
          counts,
          year,
          fs,
          count,
          `pub17 matrix ${year} ${fs} count65 ${count}`,
        );
        matrixCases++;
      }
    }
  }
  return {
    failures,
    counts: { ...counts, matrixCases, failures: failures.length },
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
      ? `Pub. 17 (2025) Ch. 10 known-answer pins all pass: ${set.counts.pins} pins across ${set.counts.cases} cases (2025 + 2026 law rows against Tables 10-1/10-2 and Rev. Proc. 2025-32, Examples 1 and 3 end-to-end through priceYear at $31,500 / $34,700).`
      : `${set.failures.length} Pub. 17 pin(s) failed — see failures.`,
    failures: set.failures.slice(0, 25),
    counts: set.counts,
  };
}

function runPub17Fast(): HardeningCheckResult {
  return resultFrom(
    "known-pub17",
    "Known-answer Pub. 17 (2025) Ch. 10: standard deduction examples and law rows",
    runFastSet(),
  );
}

function runPub17Full(): HardeningCheckResult {
  return resultFrom(
    "known-pub17",
    "Known-answer Pub. 17 (2025) Ch. 10: standard deduction examples and law rows",
    runFullSet(),
  );
}

function runPub17Teeth(): HardeningTeethResult {
  // The clean fast run must pass first.
  const clean = runFastSet();
  if (clean.failures.length !== 0) {
    return {
      corruptedCaseId: "known-pub17:clean-run-failed",
      failedCount: clean.failures.length,
      pass: false,
    };
  }
  // Corrupt one pin by 1 cent: the 2025 mfj base standard
  // deduction, published $31,500, corrupted to $31,500.01.
  // Exactly that one pin must fail.
  const corruptedCaseId = "law 2025 mfj standardDeduction";
  const set = runFastSet({
    caseId: "law 2025 mfj",
    field: "standardDeduction",
    delta: CENT,
  });
  return {
    corruptedCaseId,
    failedCount: set.failures.length,
    pass: set.failures.length === 1,
  };
}

export const knownPub17Check: HardeningCheckModule = {
  id: "known-pub17",
  name: "Known-answer Pub. 17 (2025) Ch. 10: standard deduction examples and law rows",
  runFast: runPub17Fast,
  runFull: runPub17Full,
  runTeeth: runPub17Teeth,
};
