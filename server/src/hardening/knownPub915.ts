/* ---------------- Known-answer: IRS Pub. 915 (2025) ----------------
   Part 3 of the hardening block (known-answer checks). Prices
   IRS Publication 915 (2025), "Social Security and Equivalent
   Railroad Retirement Benefits", Worksheet 1 ("Figuring Your
   Taxable Benefits") worked examples against the engine's
   IRC §86 computation (ssTaxableAmount / priceYear). The
   figures below were verified by the coordinator from the IRS
   PDF itself; the persons in the examples are cited only as
   "Pub. 915 (2025), Example N" with figures — no names.

   · Example 1 (single): benefits $5,980; line 3 other income
     $28,990 (pension $18,600 + wages $9,400 + taxable
     interest $990); tax-exempt $0; adjustments $0. Line 6
     $31,980; line 8 (provisional) $31,980; base $25,000;
     line 19 (taxable benefits) $2,990.
   · Example 2 (married filing jointly): benefits $5,600;
     line 3 other income $29,750; adjustments $1,000
     (deductible IRA payment). Line 6 $32,550; line 8
     (provisional) $31,550; base $32,000. Line 8 is below
     the base, so taxable benefits = $0 and the worksheet
     stops there.
   · Example 3 (married filing jointly, railroad SSEB):
     benefits $10,000; line 3 other income $40,500
     (pension $38,000 + interest $2,500 — the $200
     qualified U.S. savings bond interest is INCLUDED
     in line 3 per the worksheet's Form 8815 note: the
     note says to use Schedule B line 2 ($2,500) instead
     of Form 1040 line 2b ($2,300), so the excluded bond
     interest is added back for provisional income).
     Line 6 $45,500; line 8 (provisional) $45,500;
     line 19 (taxable benefits) $6,275.

   How each example is priced:
   · Direct: ssTaxableAmount(benefits, provisional, status, 1)
     with provisional = the worksheet's line 8 (line 6 minus
     line 7) and deflation factor 1 — the 2025 thresholds are
     the statute-fixed values, and SS_THRESHOLDS are
     un-deflated for 2025/2026.
   · End-to-end (Examples 1 and 3): priceYear with
     otherOrdinary = the line-3 amount, ssBenefits, and
     tax-exempt interest 0, everything else 0, calendar
     year 2025; its ssTaxable must equal line 19.
   · Example 2 is direct-only: priceYear has no Schedule 1
     adjustments input, so end-to-end it would compute
     provisional $32,550 and taxable $275 instead of $0 —
     the plan engine takes otherOrdinary post-adjustment by
     construction. That $275 is NOT pinned as a failure,
     and priceYear is not changed for it.

   Fast set vs full set: the fast set is the three examples
   (direct + end-to-end where applicable). The full set is
   the same three examples PLUS the worksheet's intermediate
   lines (10–19, where the worksheet reaches them) as
   hand-derived literal pins, so a mis-derived worksheet
   fails loudly. Fast and full are deliberately not
   identical: full adds the intermediate-line pins.

   Out of scope by engine design — Example 4 (married filing
   separately, lived with spouse): $8,000 earnings +
   $4,000 benefits → taxable $3,400 (85%). It is NOT
   priced here: SS_THRESHOLDS has no married-filing-
   separately entry (mfj / single / hoh only), so the
   engine has no §86 thresholds for that status at all.
   This module does not re-pin the §86 thresholds
   themselves (already covered by boundary-phase-outs) —
   it prices the publication's worked examples.

   A pin that fails against the engine is a FINDING; this
   module never adjusts a pin to make it pass. */

import { priceYear, ssTaxableAmount } from "../taxEngine";
import type {
  HardeningCheckModule,
  HardeningCheckResult,
  HardeningTeethResult,
} from "./types";

const CENT = 0.01;
// A 1-cent difference is a failure; half a cent of float
// noise is not.
const TOL = 0.005;

const CALENDAR_YEAR = 2025;

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

// One worked example, restated as literals straight from
// Pub. 915 (2025), Worksheet 1. `line11` is the span between
// the base amount and the second threshold ($9,000 single,
// $12,000 mfj). `lines` holds the intermediate worksheet
// lines the example reaches: Example 2 stops at line 10
// (line 8 below the base), so it carries only line 10 = $0
// and line 19 = $0.
type Pub915Example = {
  id: string;
  filingStatus: "single" | "mfj";
  benefits: number;
  otherOrdinary: number;
  taxExemptInterest: number;
  adjustments: number;
  line6: number;
  line8: number;
  base: number;
  line10: number;
  line11: number | null;
  line12: number | null;
  line13: number | null;
  line14: number | null;
  line15: number | null;
  line16: number | null;
  line17: number | null;
  line18: number | null;
  line19: number;
  endToEnd: boolean;
};

const EXAMPLES: Pub915Example[] = [
  {
    id: "pub915 ex1",
    filingStatus: "single",
    benefits: 5980,
    otherOrdinary: 28990,
    taxExemptInterest: 0,
    adjustments: 0,
    line6: 31980,
    line8: 31980,
    base: 25000,
    line10: 6980,
    line11: 9000,
    line12: 0,
    line13: 6980,
    line14: 3490,
    line15: 2990,
    line16: 0,
    line17: 2990,
    line18: 5083,
    line19: 2990,
    endToEnd: true,
  },
  {
    id: "pub915 ex2",
    filingStatus: "mfj",
    benefits: 5600,
    otherOrdinary: 29750,
    taxExemptInterest: 0,
    adjustments: 1000,
    line6: 32550,
    line8: 31550,
    base: 32000,
    line10: 0,
    line11: null,
    line12: null,
    line13: null,
    line14: null,
    line15: null,
    line16: null,
    line17: null,
    line18: null,
    line19: 0,
    endToEnd: false,
  },
  {
    id: "pub915 ex3",
    filingStatus: "mfj",
    benefits: 10000,
    otherOrdinary: 40500,
    taxExemptInterest: 0,
    adjustments: 0,
    line6: 45500,
    line8: 45500,
    base: 32000,
    line10: 13500,
    line11: 12000,
    line12: 1500,
    line13: 12000,
    line14: 6000,
    line15: 5000,
    line16: 1275,
    line17: 6275,
    line18: 8500,
    line19: 6275,
    endToEnd: true,
  },
];

// The fast set: the three examples — direct through
// ssTaxableAmount against the published line 19, plus
// end-to-end through priceYear where applicable.
function runFastSet(corrupt?: Corrupt): {
  failures: PinFailure[];
  counts: Record<string, number>;
} {
  const failures: PinFailure[] = [];
  let pins = 0;
  let cases = 0;

  for (const ex of EXAMPLES) {
    cases++;
    checkEq(
      failures,
      ex.id,
      "taxableDirect",
      ssTaxableAmount(ex.benefits, ex.line8, ex.filingStatus, 1),
      ex.line19,
      corrupt,
    );
    pins++;
    if (ex.endToEnd) {
      const priced = priceYear({
        calendarYear: CALENDAR_YEAR,
        filingStatus: ex.filingStatus,
        agePrimary: 67,
        ageSpouse: ex.filingStatus === "mfj" ? 67 : null,
        otherOrdinary: ex.otherOrdinary,
        rmd: 0,
        conversion: 0,
        extraPreTaxDraw: 0,
        ssBenefits: ex.benefits,
        taxExemptInterest: ex.taxExemptInterest,
        ltcg: 0,
        inflationPct: 2.5,
        stateRatePct: 0,
        residenceState: "other",
      });
      checkEq(failures, ex.id, "taxableEndToEnd", priced.ssTaxable, ex.line19, corrupt);
      pins++;
    }
  }

  return {
    failures,
    counts: { pins, cases, failures: failures.length },
  };
}

// The full set: the fast set plus the worksheet's
// intermediate lines (10–19, where the example reaches
// them) as hand-derived literal pins. Each line is
// re-derived from the published inputs and checked against
// its literal, so a mis-transcribed intermediate line — or
// a mis-derived worksheet — fails loudly.
function runFullSet(): {
  failures: PinFailure[];
  counts: Record<string, number>;
} {
  const fast = runFastSet();
  const failures: PinFailure[] = [...fast.failures];
  let pins = fast.counts.pins ?? 0;
  let cases = fast.counts.cases ?? 0;
  let lines = 0;

  for (const ex of EXAMPLES) {
    const caseId = `${ex.id} worksheet`;
    cases++;
    const line2 = 0.5 * ex.benefits;
    checkEq(failures, caseId, "line6", line2 + ex.otherOrdinary + ex.taxExemptInterest, ex.line6);
    pins++;
    lines++;
    checkEq(failures, caseId, "line8", ex.line6 - ex.adjustments, ex.line8);
    pins++;
    lines++;
    const line10 = Math.max(0, ex.line8 - ex.base);
    checkEq(failures, caseId, "line10", line10, ex.line10);
    pins++;
    lines++;
    // Example 2 stops here: line 8 below the base, so
    // taxable benefits are $0 (already pinned by the
    // direct check above).
    if (ex.line11 == null) continue;
    const line12 = Math.max(0, line10 - ex.line11);
    checkEq(failures, caseId, "line12", line12, ex.line12);
    pins++;
    lines++;
    const line13 = Math.min(line10, ex.line11);
    checkEq(failures, caseId, "line13", line13, ex.line13);
    pins++;
    lines++;
    const line14 = 0.5 * line13;
    checkEq(failures, caseId, "line14", line14, ex.line14);
    pins++;
    lines++;
    const line15 = Math.min(line2, line14);
    checkEq(failures, caseId, "line15", line15, ex.line15);
    pins++;
    lines++;
    const line16 = 0.85 * line12;
    checkEq(failures, caseId, "line16", line16, ex.line16);
    pins++;
    lines++;
    const line17 = line15 + line16;
    checkEq(failures, caseId, "line17", line17, ex.line17);
    pins++;
    lines++;
    const line18 = 0.85 * ex.benefits;
    checkEq(failures, caseId, "line18", line18, ex.line18);
    pins++;
    lines++;
    const line19 = Math.min(line17, line18);
    checkEq(failures, caseId, "line19", line19, ex.line19);
    pins++;
    lines++;
  }

  return {
    failures,
    counts: { pins, cases, lines, failures: failures.length },
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
      ? `Pub. 915 (2025) Worksheet 1 worked examples all pass: ${set.counts.pins} pins across ${set.counts.cases} cases (Examples 1–3 direct through ssTaxableAmount, Examples 1 and 3 end-to-end through priceYear; Example 2 direct-only — priceYear takes otherOrdinary post-adjustment).`
      : `${set.failures.length} Pub. 915 pin(s) failed — see failures.`,
    failures: set.failures.slice(0, 25),
    counts: set.counts,
  };
}

function runPub915Fast(): HardeningCheckResult {
  return resultFrom(
    "known-pub915",
    "Known-answer Pub. 915 (2025): Worksheet 1 worked examples vs the §86 computation",
    runFastSet(),
  );
}

function runPub915Full(): HardeningCheckResult {
  return resultFrom(
    "known-pub915",
    "Known-answer Pub. 915 (2025): Worksheet 1 worked examples vs the §86 computation",
    runFullSet(),
  );
}

function runPub915Teeth(): HardeningTeethResult {
  // The clean fast run must pass first.
  const clean = runFastSet();
  if (clean.failures.length !== 0) {
    return {
      corruptedCaseId: "known-pub915:clean-run-failed",
      failedCount: clean.failures.length,
      pass: false,
    };
  }
  // Corrupt one pin by 1 cent: Example 3's taxable
  // benefits, published $6,275, corrupted to $6,275.01.
  // Exactly that one pin must fail.
  const corruptedCaseId = "pub915 ex3 taxableDirect";
  const set = runFastSet({
    caseId: "pub915 ex3",
    field: "taxableDirect",
    delta: CENT,
  });
  return {
    corruptedCaseId,
    failedCount: set.failures.length,
    pass: set.failures.length === 1,
  };
}

export const knownPub915Check: HardeningCheckModule = {
  id: "known-pub915",
  name: "Known-answer Pub. 915 (2025): Worksheet 1 worked examples vs the §86 computation",
  runFast: runPub915Fast,
  runFull: runPub915Full,
  runTeeth: runPub915Teeth,
};
