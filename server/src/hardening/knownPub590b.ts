/* ---------------- Known-answer checks: IRS Pub. 590-B ----------------
   Part 3 of the hardening block (known-answer checks). Prices
   the worked required-minimum-distribution examples in IRS
   Publication 590-B (2025), "Distributions from Individual
   Retirement Arrangements (IRAs)", Chapter 1, "When Must You
   Withdraw Assets? (Required Minimum Distributions)", against
   the engine's rmdForYear. Every example below was verified
   against the IRS PDF (irs.gov/pub/irs-pdf/p590b.pdf); the
   PDF is authoritative and wins on any conflict. No example
   person's name is reproduced here; each case is cited by
   section and figures only.

   Verified worked examples with a computable dollar RMD
   (all four are pinned):
   · Pub. 590-B (2025), Ch. 1, "Figuring the Owner's Required
     Minimum Distribution", Table III Example: a 75-year-old
     owner, $100,000 prior-year-end balance, spouse sole
     beneficiary 6 years younger (gap not over 10, so Table
     III applies), divisor 24.6, printed RMD $4,065.
   · Same section, Table II Example: a 75-year-old owner,
     $100,000 balance, spouse sole beneficiary 11 years
     younger (age 64), divisor 25.3, printed RMD $3,953.
   · Pub. 590-B (2025), Ch. 1, "Miscellaneous Rules for
     Required Minimum Distributions", "More than minimum
     received", Example, 2025 leg: owner turned 73 in 2025,
     $38,400 balance at Dec 31, 2024, divisor 26.5, printed
     RMD $1,450.
   · Same Example, 2026 leg: ADJUDICATED DISAGREEMENT.
     The publication prints $1,313 ($34,800 ÷ 26.5, "(the
     applicable denominator for age 73 per Table III)").
     The owner turned 73 in December 2025, so the owner's
     age as of the birthday in 2026 is 74, and the
     publication's own rule ("your applicable denominator
     for 2026 is listed in the table next to your age as of
     your birthday in 2026") plus its own Table III
     (Appendix B: age 74 -> 25.5) require $34,800 ÷ 25.5
     = $1,364.71. The publication's arithmetic is right for
     the divisor it used; the divisor is wrong. The pin
     asserts the correct $1,364.71 at divisor 25.5, which
     the engine returns — the engine follows the rule and
     the table, not the example's stale divisor. Do not
     "fix" this pin to $1,313: that would pin a wrong
     answer to make a check pass.

   Rounding note (adjudicated in advance): the publication
   prints RMDs rounded to whole dollars ($4,065, $3,953,
   $1,450); the engine returns cents. Pins use the EXACT
   division ($4,065.04, $3,952.57, $1,449.06, $1,364.71) —
   the publication's rounded figure is cited alongside, not
   pinned. Each printed figure is within whole-dollar
   rounding of its exact division, except the 2026 leg
   above, whose gap ($51.50) far exceeds rounding and is
   the adjudicated disagreement, not a rounding artifact.

   Worked RMD material in the publication that is NOT
   pinnable through rmdForYear, and is therefore not pinned
   here (enumerated so a later reader does not mistake the
   omission for an oversight):
   · The annuity-purchase example ("Special rules where
     portion of account balance is used to purchase an
     annuity"): states the formula (RMD on $300,000 total
     less $8,000 annuity payments) but gives no owner age,
     no divisor, and no printed RMD — no computable figure.
   · The surviving-spouse Examples 1-2: date logic (no RMD
     until Dec 31, 2030, the year the decedent would have
     reached 73); no surviving spouse's age or balance is
     given, so no dollar RMD is computable.
   · The Table I (Single Life Expectancy) examples (age 57
     -> 29.8; redetermination to 27.6 for 2026): divisor-only,
     no balance and no dollar RMD, and rmdForYear does not
     price beneficiary Table I cases.
   · "More than one IRA": states the aggregation rule (a
     separate RMD per IRA, total withdrawable from any) but
     gives no worked figures — there is no numeric
     multi-account aggregation example in the publication,
     so the full set adds no aggregation case.

   Fast set = full set: every verified worked example above.
   The two sets are identical by construction — the
   publication holds no further numeric RMD example to add
   — and runFull documents that rather than inventing one.

   A pin that fails against the engine is a FINDING; this
   module never adjusts a pin to make it pass. */

import { rmdForYear } from "../taxEngine";
import type {
  HardeningCheckModule,
  HardeningCheckResult,
  HardeningTeethResult,
} from "./types";

const CENT = 0.01;
// A 1-cent difference is a failure; half a cent of float
// noise is not.
const TOL = 0.005;

// Birth years: an owner who turns 75 in 2026 was born in
// 1951 (RMD age 73); an owner who turned 73 in December
// 2025 was born in 1952 (RMD age 73).
const BORN_1951 = 1951;
const BORN_1952 = 1952;

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

// The example set: every verified Pub. 590-B worked RMD
// example with a computable dollar figure. Each case pins
// divisor, RMD to the cent, and table through rmdForYear.
function runExampleSet(corrupt?: Corrupt): {
  failures: PinFailure[];
  counts: Record<string, number>;
} {
  const failures: PinFailure[] = [];
  let pins = 0;
  let cases = 0;

  const examples: {
    caseId: string;
    balance: number;
    age: number;
    spouse: number | null;
    birth: number;
    sole: boolean;
    divisor: number;
    rmd: number;
    table: "joint" | "uniform";
  }[] = [
    // Table III Example: age 75, $100,000, spouse sole
    // beneficiary 6 years younger (age 69) — gap not over
    // 10, so Table III. Printed $4,065; exact $4,065.04.
    {
      caseId: "uniform-table age 75 balance 100000",
      balance: 100000,
      age: 75,
      spouse: 69,
      birth: BORN_1951,
      sole: true,
      divisor: 24.6,
      rmd: 4065.04,
      table: "uniform",
    },
    // Table II Example: age 75, $100,000, spouse sole
    // beneficiary 11 years younger (age 64) — Table II.
    // Printed $3,953; exact $3,952.57.
    {
      caseId: "joint-table age 75 spouse 64 balance 100000",
      balance: 100000,
      age: 75,
      spouse: 64,
      birth: BORN_1951,
      sole: true,
      divisor: 25.3,
      rmd: 3952.57,
      table: "joint",
    },
    // "More than minimum received" Example, 2025 leg:
    // turned 73 in 2025, $38,400 at Dec 31, 2024, Table
    // III divisor 26.5. Printed $1,450; exact $1,449.06.
    {
      caseId: "excess-distribution 2025 age 73 balance 38400",
      balance: 38400,
      age: 73,
      spouse: null,
      birth: BORN_1952,
      sole: false,
      divisor: 26.5,
      rmd: 1449.06,
      table: "uniform",
    },
    // Same Example, 2026 leg — ADJUDICATED: the
    // publication prints $1,313 ($34,800 ÷ 26.5, "age
    // 73"), but the owner is 74 in 2026 and Table III
    // gives 25.5 at 74. Pinned to the correct $1,364.71.
    {
      caseId: "excess-distribution 2026 age 74 balance 34800",
      balance: 34800,
      age: 74,
      spouse: null,
      birth: BORN_1952,
      sole: false,
      divisor: 25.5,
      rmd: 1364.71,
      table: "uniform",
    },
  ];

  for (const c of examples) {
    const r = rmdForYear({
      priorDec31PreTax: c.balance,
      agePrimary: c.age,
      ageSpouse: c.spouse,
      birthYearPrimary: c.birth,
      spouseSoleBeneficiary: c.sole,
    });
    cases++;
    checkEq(failures, c.caseId, "divisor", r.divisor, c.divisor, corrupt);
    pins++;
    checkEq(failures, c.caseId, "rmd", r.rmd, c.rmd, corrupt);
    pins++;
    checkEq(failures, c.caseId, "table", r.table, c.table, corrupt);
    pins++;
  }

  return {
    failures,
    counts: { pins, cases, failures: failures.length },
  };
}

function runFastSet(corrupt?: Corrupt): {
  failures: PinFailure[];
  counts: Record<string, number>;
} {
  return runExampleSet(corrupt);
}

// The full set is identical to the fast set: the
// publication holds no further numeric RMD example (the
// multi-IRA aggregation rule is stated with no figures,
// the annuity example gives no age or divisor, and the
// surviving-spouse and Table I examples give no dollar
// RMD). Nothing further to add without inventing a case.
function runFullSet(): {
  failures: PinFailure[];
  counts: Record<string, number>;
} {
  return runExampleSet();
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
      ? `Pub. 590-B (2025) worked RMD examples all pass: ${set.counts.pins} pins across ${set.counts.cases} cases (Table III $100,000 at 75, Table II $100,000 at 75/64, and both legs of the excess-distribution example). The 2026 leg is pinned to the corrected $1,364.71 (divisor 25.5 at age 74); the publication's printed $1,313 (divisor 26.5) contradicts its own rule and Table III and is documented as an adjudicated disagreement in the module comment.`
      : `${set.failures.length} Pub. 590-B pin(s) failed — see failures.`,
    failures: set.failures.slice(0, 25),
    counts: set.counts,
  };
}

function runPub590bFast(): HardeningCheckResult {
  return resultFrom(
    "known-pub590b",
    "Known-answer: IRS Pub. 590-B (2025) RMD worked examples",
    runFastSet(),
  );
}

function runPub590bFull(): HardeningCheckResult {
  return resultFrom(
    "known-pub590b",
    "Known-answer: IRS Pub. 590-B (2025) RMD worked examples",
    runFullSet(),
  );
}

function runPub590bTeeth(): HardeningTeethResult {
  // The clean fast run must pass first.
  const clean = runFastSet();
  if (clean.failures.length !== 0) {
    return {
      corruptedCaseId: "known-pub590b:clean-run-failed",
      failedCount: clean.failures.length,
      pass: false,
    };
  }
  // Corrupt one pin by 1 cent: the Table III RMD at age
  // 75 on $100,000, expected $4,065.04, corrupted to
  // $4,065.05. Exactly that one pin must fail.
  const corruptedCaseId = "uniform-table age 75 balance 100000 rmd";
  const set = runFastSet({
    caseId: "uniform-table age 75 balance 100000",
    field: "rmd",
    delta: CENT,
  });
  return {
    corruptedCaseId,
    failedCount: set.failures.length,
    pass: set.failures.length === 1,
  };
}

export const knownPub590bCheck: HardeningCheckModule = {
  id: "known-pub590b",
  name: "Known-answer: IRS Pub. 590-B (2025) RMD worked examples",
  runFast: runPub590bFast,
  runFull: runPub590bFull,
  runTeeth: runPub590bTeeth,
};
