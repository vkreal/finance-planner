// Engine Review 7, E7-S1 — HSA coverage / eligibility (§2), with the
// §4 payroll-tax cases the HSA legs touch, the §5 cash-flow identity,
// and the §6 work-to-retirement handoff legs that carry HSA money.
//
// STANDARD (same as Reviews 1/5): every expected figure below is
// hand-computed in the test itself (plain arithmetic on literals),
// never a copied engine print. Statutory sources, verified for this
// review against the IRS publications (not taken from the brief):
//   - IRC §223; IRS Publication 969 (2025): an HSA needs a
//     qualifying HDHP plus no disqualifying coverage, no Medicare
//     enrollment, and not being another's dependent. "Beginning
//     with the first month you are enrolled in Medicare, your
//     contribution limit is zero." The $1,000 age-55 catch-up is
//     per HSA owner (§223(b)(3), fixed, not indexed) — a 55+
//     spouse's catch-up belongs in the spouse's own HSA, never in
//     the primary's. The family limit is the household's shared
//     limit; the last-month rule and mid-year proration are
//     month-level rules this whole-year model does not price.
//   - Rev. Proc. 2024-25 (2025): self-only $4,300, family $8,550.
//   - Rev. Proc. 2025-19 (2026): self-only $4,400, family $8,750.
//   - IRC §3101(b)(2) Additional Medicare Tax thresholds (not
//     indexed): $250,000 MFJ / $200,000 single or head of
//     household; SS wage base 2026 $184,500 (SSA release);
//     employee rates 6.2% SS / 1.45% Medicare / 0.9% additional.
//     The employer share (§3111) is never a household outlay.
//
// Sample-household values throughout (server/src/sampleHousehold.ts);
// the single-year cases use round salaries on 2026 law so the limits
// read off the Rev. Proc. figures directly. Run per-file:
//   bun test server/src/workYearsReview7Hsa.test.ts

import { describe, expect, test } from "bun:test";
import { lawForYear, type FilingStatus } from "./taxLaw";
import {
  contributionStack,
  payrollTaxBreakdown,
  priceOneWorkYear,
  rollWorkYears,
  runWorkYearsCompare,
  type HsaCoverage,
  type WorkYearJob,
} from "./workYears";
import { samplePlanInputs } from "./sampleHousehold";
import type { RothPlanInputs } from "./taxEngine";

const LAW_2026 = lawForYear(2026);

// A work-years plan for one priced year: the sample household with
// the birth year set so `age` falls in `year`, the window starting at
// that age, zero return (balances check exactly), and no Social
// Security / RMD in range (SS starts 67, RMD at 73+).
function wyPlan(age: number, year = 2026, overrides: Partial<RothPlanInputs> = {}) {
  return samplePlanInputs({
    startYear: year,
    birthYearPrimary: year - age,
    birthYearSpouse: year - age + 2,
    retirementAge: age,
    windowStartAge: age,
    expectedReturnPct: 0,
    annualSpending: 120000,
    ...overrides,
  });
}

function stack(
  age: number,
  salary: number,
  employer401k: number,
  employerHsa: number,
  filingStatus: FilingStatus,
  priorYearWages: number | null = null,
  medicareAgePrimary: number | null = null,
  hsaOpts: { coverage?: HsaCoverage | null; eligible?: boolean | null } | null = null,
) {
  return contributionStack(
    age,
    salary,
    employer401k,
    employerHsa,
    filingStatus,
    LAW_2026,
    priorYearWages,
    medicareAgePrimary,
    1,
    hsaOpts,
  );
}

// ---------------------------------------------------------------------------
// §2 — the limit prices from the HDHP coverage, not the filing status
// ---------------------------------------------------------------------------

describe("E7-S1 §2 — HSA limit from HDHP coverage", () => {
  test("single filer, explicit self-only: $4,400 + $1,000 at 55", () => {
    // Age 55, salary $100,000: deferral $24,500, catch-up $8,000
    // (50+ band), own HSA = min($5,400 − $0, $100,000 − $24,500
    // − $8,000) = $5,400. Mega = min($72,000 − $24,500,
    // $100,000 − $24,500 − $8,000 − $5,400) = $47,500.
    const s = stack(55, 100000, 0, 0, "single", null, null, {
      coverage: "self-only",
      eligible: true,
    });
    expect(s.hsaCoverage).toBe("self-only");
    expect(s.hsaEligible).toBe(true);
    expect(s.hsaLimit).toBe(5400);
    expect(s.ownHsa).toBe(5400);
    expect(s.hsaBucket).toBe(5400);
    expect(s.mega).toBe(47500);
    expect(s.assumptions).toEqual([]);
  });

  test("married, explicit self-only: the self-only limit, not the family one", () => {
    // The finding itself: MFJ + a self-only HDHP prices $5,400
    // at 55 — the old filing-status rule would have priced $9,750.
    const s = stack(55, 100000, 0, 0, "mfj", null, null, {
      coverage: "self-only",
      eligible: true,
    });
    expect(s.hsaCoverage).toBe("self-only");
    expect(s.hsaLimit).toBe(5400);
    expect(s.ownHsa).toBe(5400);
    expect(s.hsaBucket).toBe(5400);
    expect(s.assumptions).toEqual([]);
  });

  test("married, explicit family: $8,750 + $1,000 at 55", () => {
    const s = stack(55, 100000, 0, 0, "mfj", null, null, {
      coverage: "family",
      eligible: true,
    });
    expect(s.hsaCoverage).toBe("family");
    expect(s.hsaLimit).toBe(9750);
    expect(s.ownHsa).toBe(9750);
    expect(s.hsaBucket).toBe(9750);
    expect(s.assumptions).toEqual([]);
  });

  test("head of household, explicit family: the family limit", () => {
    // The case the UI explainer used to call out: a head of
    // household with family coverage legally uses $9,750 at 55.
    const s = stack(55, 100000, 0, 0, "hoh", null, null, {
      coverage: "family",
      eligible: true,
    });
    expect(s.hsaLimit).toBe(9750);
    expect(s.ownHsa).toBe(9750);
  });

  test("single filer, explicit family: the family limit", () => {
    // Coverage is about the HDHP, not the return: a single filer
    // covering dependents on a family HDHP uses the family limit.
    const s = stack(55, 100000, 0, 0, "single", null, null, {
      coverage: "family",
      eligible: true,
    });
    expect(s.hsaLimit).toBe(9750);
    expect(s.ownHsa).toBe(9750);
  });

  test("no qualifying HDHP: limit $0, no contribution of either source", () => {
    // Even a $2,000 typed employer HSA lands $0: without an HDHP
    // there is no limit for it to land under.
    const s = stack(56, 100000, 0, 2000, "mfj", null, null, {
      coverage: "none",
      eligible: true,
    });
    expect(s.hsaCoverage).toBe("none");
    expect(s.hsaEligible).toBe(false);
    expect(s.hsaLimit).toBe(0);
    expect(s.ownHsa).toBe(0);
    expect(s.employerHsa).toBe(0);
    expect(s.hsaBucket).toBe(0);
    expect(s.assumptions).toEqual([]);
  });

  test("no eligibility assumption when eligibility is denied by a stated fact", () => {
    // The "assumed eligible" fallback is recorded only when
    // eligibility was actually assumed. With no qualifying HDHP
    // coverage stated, or at/after a stated Medicare enrollment
    // age, eligibility is denied by a stated fact — naming an
    // "assumed eligible" fallback there would misstate the
    // year's reasoning.
    const noHdhp = stack(56, 100000, 0, 2000, "mfj", null, null, {
      coverage: "none",
    });
    expect(noHdhp.hsaEligible).toBe(false);
    expect(noHdhp.hsaLimit).toBe(0);
    expect(noHdhp.assumptions).toEqual([]);
    const gated = stack(66, 100000, 0, 0, "mfj", null, 65, {
      coverage: "family",
    });
    expect(gated.hsaEligible).toBe(false);
    expect(gated.hsaLimit).toBe(0);
    expect(gated.assumptions).toEqual([]);
  });

  test("zero salary: resolved coverage, eligibility, and assumptions are still reported", () => {
    // No salary prices no stack, but the HSA resolution is
    // the same as for a priced year: an explicit coverage /
    // eligibility is reported rather than the empty defaults,
    // and a fallback is named, never silent.
    const explicit = stack(56, 0, 0, 2000, "mfj", null, null, {
      coverage: "family",
      eligible: true,
    });
    expect(explicit.hsaCoverage).toBe("family");
    expect(explicit.hsaEligible).toBe(true);
    expect(explicit.hsaLimit).toBe(0);
    expect(explicit.assumptions).toEqual([]);
    const fallback = stack(56, 0, 0, 0, "mfj");
    expect(fallback.hsaCoverage).toBe("family");
    expect(fallback.hsaEligible).toBe(true);
    expect(fallback.hsaLimit).toBe(0);
    expect(fallback.assumptions.length).toBe(2);
    expect(fallback.assumptions[0]).toContain("HSA coverage not stated");
    expect(fallback.assumptions[1]).toContain("HSA eligibility not stated");
    const noHdhp = stack(56, 0, 0, 0, "mfj", null, null, {
      coverage: "none",
    });
    expect(noHdhp.hsaCoverage).toBe("none");
    expect(noHdhp.hsaEligible).toBe(false);
    expect(noHdhp.assumptions).toEqual([]);
  });

  test("explicitly ineligible: limit $0, employer money lands $0", () => {
    const s = stack(56, 100000, 0, 5000, "mfj", null, null, {
      coverage: "family",
      eligible: false,
    });
    expect(s.hsaEligible).toBe(false);
    expect(s.hsaLimit).toBe(0);
    expect(s.ownHsa).toBe(0);
    expect(s.employerHsa).toBe(0);
    expect(s.hsaBucket).toBe(0);
    expect(s.assumptions).toEqual([]);
  });

  test("age 54 vs 55: the $1,000 catch-up starts at 55, not before", () => {
    // MFJ family: 54 → $8,750; 55 → $9,750. No catch-up at 54
    // even though the 401(k) catch-up already applies at 50.
    expect(stack(54, 100000, 0, 0, "mfj", null, null, { coverage: "family", eligible: true }).hsaLimit).toBe(8750);
    expect(stack(55, 100000, 0, 0, "mfj", null, null, { coverage: "family", eligible: true }).hsaLimit).toBe(9750);
    expect(stack(54, 100000, 0, 0, "single", null, null, { coverage: "self-only", eligible: true }).hsaLimit).toBe(4400);
  });

  test("spouse's catch-up is never added to the primary's HSA", () => {
    // Both spouses 55+ on a family HDHP: the shared family limit
    // is $8,750 and the primary's own catch-up is $1,000 — $9,750
    // total in this model's single (primary's) HSA. The spouse's
    // $1,000 belongs in the spouse's own HSA, which the model does
    // not carry; granting $10,750 here would overstate the bucket.
    const plan = wyPlan(56, 2026, { birthYearSpouse: 1970 });
    const line = priceOneWorkYear(
      plan,
      { salary: 100000, employer401k: 0, employerHsa: 0, hsaCoverage: "family", hsaEligible: true },
      56,
    );
    expect(line.stack.hsaLimit).toBe(9750);
    expect(line.stack.hsaBucket).toBe(9750);
  });

  test("employer HSA above the limit: own $0, bucket capped, totals foot", () => {
    // MFJ family at 56, employer HSA $12,000 typed against the
    // $9,750 limit: own HSA $0, bucket $9,750, and the roll's
    // employer total counts only the $9,750 that lands.
    const plan = wyPlan(56);
    const roll = rollWorkYears(
      plan,
      { salary: 400000, employer401k: 0, employerHsa: 12000, hsaCoverage: "family", hsaEligible: true },
      57,
    );
    expect(roll.lines[0]?.stack.ownHsa).toBe(0);
    expect(roll.lines[0]?.stack.hsaBucket).toBe(9750);
    expect(roll.totals.employerContributions).toBe(9750);
    expect(roll.totals.hsaContributions).toBe(9750);
    expect(
      Math.round((roll.totals.employeeContributions + roll.totals.employerContributions) * 100) / 100,
    ).toBe(roll.totals.totalContributions);
  });

  test("employee + employer share one limit", () => {
    // Employer $3,000 + own $6,750 = $9,750 family limit at 56.
    const s = stack(56, 100000, 0, 3000, "mfj", null, null, {
      coverage: "family",
      eligible: true,
    });
    expect(s.ownHsa).toBe(6750);
    expect(s.employerHsa).toBe(3000);
    expect(s.hsaBucket).toBe(9750);
  });

  test("explicitly zero: a small salary leaves no room for an own HSA", () => {
    // Salary $30,000 at 56: deferral $24,500 + catch-up
    // min($8,000, $30,000 − $24,500) = $5,500 leaves $0 of
    // salary for the own HSA — $0 by arithmetic, bucket $0.
    const s = stack(56, 30000, 0, 0, "mfj", null, null, {
      coverage: "family",
      eligible: true,
    });
    expect(s.deferral).toBe(24500);
    expect(s.catchUp).toBe(5500);
    expect(s.ownHsa).toBe(0);
    expect(s.hsaBucket).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §2 — Medicare enrollment gating (eligibility turns on enrollment)
// ---------------------------------------------------------------------------

describe("E7-S1 §2 — Medicare enrollment gating", () => {
  test("enrolled before 65: ineligible from the enrollment age", () => {
    // Medicare at 63 (disability enrollment): age 62 prices the
    // family limit, age 63 prices $0.
    const at62 = stack(62, 100000, 0, 0, "mfj", null, 63, {
      coverage: "family",
      eligible: true,
    });
    expect(at62.hsaEligible).toBe(true);
    expect(at62.hsaLimit).toBe(9750);
    const at63 = stack(63, 100000, 0, 0, "mfj", null, 63, {
      coverage: "family",
      eligible: true,
    });
    expect(at63.hsaEligible).toBe(false);
    expect(at63.hsaLimit).toBe(0);
    expect(at63.hsaBucket).toBe(0);
  });

  test("enrolled at 65: ineligible at 65, eligible at 64", () => {
    expect(stack(64, 100000, 0, 0, "mfj", null, 65, { coverage: "family", eligible: true }).hsaEligible).toBe(true);
    const at65 = stack(65, 100000, 0, 1000, "mfj", null, 65, {
      coverage: "family",
      eligible: true,
    });
    expect(at65.hsaEligible).toBe(false);
    expect(at65.hsaLimit).toBe(0);
    expect(at65.employerHsa).toBe(0);
  });

  test("delayed enrollment: eligible past 65 until the enrollment age", () => {
    // Lawful delay to 70: ages 65–69 stay eligible, 70 does not.
    for (const age of [65, 66, 69]) {
      expect(
        stack(age, 100000, 0, 0, "mfj", null, 70, { coverage: "family", eligible: true }).hsaEligible,
      ).toBe(true);
    }
    expect(stack(70, 100000, 0, 0, "mfj", null, 70, { coverage: "family", eligible: true }).hsaEligible).toBe(false);
  });

  test("Medicare enrollment beats an explicit eligible=true", () => {
    // Enrollment ends eligibility whatever the flag says: the
    // flag states the coverage facts, enrollment states the
    // disqualifying fact, and the disqualifier wins.
    const s = stack(65, 100000, 0, 0, "mfj", null, 65, {
      coverage: "family",
      eligible: true,
    });
    expect(s.hsaEligible).toBe(false);
    expect(s.hsaLimit).toBe(0);
  });

  test("roll: eligibility flips by whole year at the enrollment age", () => {
    // MFJ, ages 64–65, Medicare at 65: year 64 banks $9,750,
    // year 65 banks $0; the roll names the whole-year pricing
    // as an assumption (mid-year proration is not modeled).
    const plan = wyPlan(64);
    const roll = rollWorkYears(
      plan,
      { salary: 100000, employer401k: 0, employerHsa: 0, medicareAgePrimary: 65, hsaCoverage: "family", hsaEligible: true },
      66,
    );
    expect(roll.lines[0]?.stack.hsaBucket).toBe(9750);
    expect(roll.lines[1]?.stack.hsaBucket).toBe(0);
    expect(roll.totals.hsaContributions).toBe(9750);
    expect(roll.assumptions.some((a) => a.includes("whole year"))).toBe(true);
  });

  test("roll: no whole-year note when no priced year reaches the enrollment age", () => {
    // MFJ, ages 58–59, Medicare at 70: both years bank the
    // full limit and no flip is priced, so the
    // whole-year-pricing note must not appear. Year 59 banks
    // $9,725.61, not $9,750: the $1,000 age-55 catch-up is
    // statute-fixed, so it deflates one year at 2.5%
    // ($8,750 + $975.61).
    const plan = wyPlan(58);
    const roll = rollWorkYears(
      plan,
      { salary: 100000, employer401k: 0, employerHsa: 0, medicareAgePrimary: 70, hsaCoverage: "family", hsaEligible: true },
      60,
    );
    expect(roll.lines).toHaveLength(2);
    expect(roll.lines[0]?.stack.hsaBucket).toBe(9750);
    expect(roll.lines[1]?.stack.hsaBucket).toBe(9725.61);
    expect(roll.assumptions.some((a) => a.includes("whole year"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §2 — the fallback is preserved, and flagged as an assumption
// ---------------------------------------------------------------------------

describe("E7-S1 §2 — fallback preserved and flagged", () => {
  test("no new fields: MFJ still prices the family limit — and says so", () => {
    const s = stack(56, 100000, 0, 0, "mfj");
    expect(s.hsaCoverage).toBe("family");
    expect(s.hsaLimit).toBe(9750);
    expect(s.ownHsa).toBe(9750);
    expect(s.assumptions.length).toBe(2);
    expect(s.assumptions[0]).toContain("HSA coverage not stated");
    expect(s.assumptions[1]).toContain("HSA eligibility not stated");
  });

  test("no new fields: single still prices the self-only limit — and says so", () => {
    const s = stack(56, 100000, 0, 0, "single");
    expect(s.hsaCoverage).toBe("self-only");
    expect(s.hsaLimit).toBe(5400);
    expect(s.assumptions.length).toBe(2);
  });

  test("explicit coverage alone still flags the eligibility assumption", () => {
    const s = stack(56, 100000, 0, 0, "mfj", null, null, {
      coverage: "family",
    });
    expect(s.hsaLimit).toBe(9750);
    expect(s.assumptions.length).toBe(1);
    expect(s.assumptions[0]).toContain("HSA eligibility not stated");
  });

  test("roll: assumptions deduped to one entry each across years", () => {
    const plan = wyPlan(56);
    const roll = rollWorkYears(plan, { salary: 100000, employer401k: 0, employerHsa: 0 }, 58);
    expect(roll.lines).toHaveLength(2);
    // Three distinct assumptions: the coverage fallback, the
    // eligibility fallback, and the first-year prior-wage proxy
    // (the second year threads the first year's wages, so it
    // carries no proxy assumption of its own).
    expect(roll.assumptions.length).toBe(3);
    expect(roll.assumptions[0]).toContain("HSA coverage not stated");
    expect(roll.assumptions[1]).toContain("HSA eligibility not stated");
    expect(roll.assumptions[2]).toContain("proxy for the prior calendar year's wages");
    expect(roll.lines[0]?.assumptions).toEqual(roll.assumptions);
    expect(roll.lines[1]?.assumptions).toEqual(roll.assumptions.slice(0, 2));
  });

  test("roll: fully explicit job prices with no assumptions", () => {
    const plan = wyPlan(56);
    const job: WorkYearJob = {
      salary: 100000,
      employer401k: 0,
      employerHsa: 0,
      hsaCoverage: "family",
      hsaEligible: true,
      priorYearWages: 90000,
    };
    const roll = rollWorkYears(plan, job, 58);
    expect(roll.assumptions).toEqual([]);
    expect(roll.lines[0]?.stack.hsaLimit).toBe(9750);
  });
});

// ---------------------------------------------------------------------------
// §4 — payroll tax: HSA payroll deductions, wage base, thresholds
// ---------------------------------------------------------------------------

describe("E7 §4 — payroll tax (hand-derived)", () => {
  test("own HSA reduces FICA wages; employer HSA does not", () => {
    // Salary $100,000, MFJ family at 56, employer HSA $3,000:
    // own HSA $6,750 → FICA wages $93,250. The employer's $3,000
    // never was salary, so it never enters the wage figure.
    const plan = wyPlan(56);
    const line = priceOneWorkYear(
      plan,
      { salary: 100000, employer401k: 0, employerHsa: 3000, hsaCoverage: "family", hsaEligible: true },
      56,
    );
    expect(line.stack.ownHsa).toBe(6750);
    expect(line.ficaWages).toBe(93250);
    // 6.2% × $93,250 = $5,781.50; 1.45% × $93,250 = $1,352.13
    // (1,352.125 rounds half-up); no additional tax under $250,000.
    expect(line.payrollSocialSecurity).toBe(5781.5);
    expect(line.payrollMedicare).toBe(1352.13);
    expect(line.payrollAdditionalMedicare).toBe(0);
    expect(line.fica).toBe(7133.63);
  });

  test("Social Security wage base caps at $184,500 (2026)", () => {
    // Salary $400,000, MFJ family at 56: FICA wages
    // $400,000 − $9,750 = $390,250. SS = 6.2% × $184,500 =
    // $11,439; Medicare = 1.45% × $390,250 = $5,658.63;
    // additional = 0.9% × ($390,250 − $250,000) = $1,262.25;
    // total $18,359.88 (agrees with the pinned fixture).
    const p = payrollTaxBreakdown(390250, "mfj", LAW_2026, 1);
    expect(p.socialSecurity).toBe(11439);
    expect(p.medicare).toBe(5658.63);
    expect(p.additionalMedicare).toBe(1262.25);
    expect(p.total).toBe(18359.88);
  });

  test("Additional Medicare threshold is $200,000 single / hoh, $250,000 mfj", () => {
    // FICA wages $294,600 (single, $300,000 salary less $5,400
    // self-only HSA at 57): SS $11,439 (capped), Medicare
    // 1.45% × $294,600 = $4,271.70, additional 0.9% ×
    // ($294,600 − $200,000) = $851.40; total $16,562.10.
    const single = payrollTaxBreakdown(294600, "single", LAW_2026, 1);
    expect(single.additionalMedicare).toBe(851.4);
    expect(single.total).toBe(16562.1);
    // Same wages MFJ: additional 0.9% × ($294,600 − $250,000)
    // = $401.40; total $16,112.10.
    const mfj = payrollTaxBreakdown(294600, "mfj", LAW_2026, 1);
    expect(mfj.additionalMedicare).toBe(401.4);
    expect(mfj.total).toBe(16112.1);
    // HoH prices the single threshold, not the MFJ one.
    expect(payrollTaxBreakdown(294600, "hoh", LAW_2026, 1).additionalMedicare).toBe(851.4);
  });

  test("payroll tax is the employee share only — no employer FICA charged", () => {
    // The three priced parts sum to the total (to the cent on
    // this case — no hidden employer component rides along):
    // SS $11,439 + Medicare $5,658.63 + additional $1,262.25
    // = $18,359.88, and the line's fica is that total.
    const plan = wyPlan(56);
    const line = priceOneWorkYear(plan, { salary: 400000, employer401k: 0, employerHsa: 0 }, 56);
    expect(line.payrollSocialSecurity + line.payrollMedicare + line.payrollAdditionalMedicare).toBeCloseTo(
      line.payrollTax,
      2,
    );
    expect(line.fica).toBe(line.payrollTax);
  });
});

// ---------------------------------------------------------------------------
// §5 — the annual cash-flow identity, and where each dollar lands
// ---------------------------------------------------------------------------

describe("E7 §5 — annual identity and contribution routing", () => {
  test("salary + SS + RMD − taxes − spending − own contributions = surplus", () => {
    // MFJ, ages 56–57, salary $100,000, employer 401(k) $5,000,
    // employer HSA $1,000, family HSA explicit: each line must
    // foot exactly (within a cent of rounding) from its own
    // priced components — the identity the §5 check re-derives.
    const plan = wyPlan(56);
    const roll = rollWorkYears(
      plan,
      { salary: 100000, employer401k: 5000, employerHsa: 1000, hsaCoverage: "family", hsaEligible: true },
      58,
    );
    for (const line of roll.lines) {
      const s = line.stack;
      const own = s.deferral + s.catchUp + s.mega + s.ownHsa;
      const lhs =
        line.salary + line.ssBenefits + line.rmd -
        line.federalTax - line.stateTax - line.fica -
        plan.annualSpending - own;
      expect(Math.abs(lhs - line.surplus)).toBeLessThanOrEqual(0.02);
    }
  });

  test("employer 401(k) lands in Pre-tax only; employer HSA in HSA only", () => {
    // Return 0%, no RMD/SS at 56: balances are start +
    // contributions, so each employer's money is attributable
    // exactly. Salary $100,000, employer 401(k) $5,000,
    // employer HSA $1,000, family HSA: deferral $24,500,
    // catch-up $8,000 pre-tax (wages under threshold), mega
    // = min($72,000 − $24,500 − $5,000, $100,000 − $24,500
    // − $8,000 − $8,750) = $42,500 Roth; own HSA $8,750.
    const plan = wyPlan(56);
    const roll = rollWorkYears(
      plan,
      { salary: 100000, employer401k: 5000, employerHsa: 1000, hsaCoverage: "family", hsaEligible: true },
      57,
    );
    expect(roll.totals.pretaxContributions).toBe(37500);
    expect(roll.totals.rothContributions).toBe(42500);
    expect(roll.totals.hsaContributions).toBe(9750);
    expect(roll.balances.pretaxPrimary).toBe(plan.pretaxStart + 37500);
    expect(roll.balances.roth).toBe(plan.rothStart + 42500);
    expect(roll.balances.hsa).toBe(plan.hsaStart + 9750);
    expect(roll.totals.totalContributions).toBe(37500 + 42500 + 9750);
    expect(roll.totals.employeeContributions).toBe(24500 + 8000 + 42500 + 8750);
    expect(roll.totals.employerContributions).toBe(5000 + 1000);
  });

  test("employee contributions reduce available salary cash", () => {
    // Same shape, no employer money: the surplus is salary
    // minus taxes, spending, and the employee's own stack —
    // every contributed dollar is a dollar not banked.
    const plan = wyPlan(56);
    const roll = rollWorkYears(
      plan,
      { salary: 100000, employer401k: 0, employerHsa: 0, hsaCoverage: "family", hsaEligible: true },
      57,
    );
    const line = roll.lines[0]!;
    const own = line.stack.deferral + line.stack.catchUp + line.stack.mega + line.stack.ownHsa;
    expect(own).toBe(24500 + 8000 + 47500 + 9750);
    expect(line.surplus).toBeCloseTo(
      100000 - line.federalTax - line.stateTax - line.fica - 120000 - own,
      2,
    );
  });

  test("a deficit never books a negative Taxable balance", () => {
    // Salary $10,000, spending $120,000, one year at 56:
    // the balance floors at $0 and the unfunded remainder is
    // reported as shortfall, not hidden in a negative asset.
    const plan = wyPlan(56, 2026, { taxableStart: 0 });
    const roll = rollWorkYears(
      plan,
      { salary: 10000, employer401k: 0, employerHsa: 0, hsaCoverage: "family", hsaEligible: true },
      57,
    );
    expect(roll.balances.taxable).toBe(0);
    expect(roll.lines[0]?.shortfall).toBeGreaterThan(0);
    expect(roll.totals.shortfall).toBe(roll.lines[0]!.shortfall);
  });

  test("tax-exempt interest is cash: it banks into the surplus and the rolled Taxable (P2 MUST-1)", () => {
    // Engine Review 7, P2 MUST-1: the work-year surplus
    // formerly dropped the plan's tax-exempt interest while
    // the retirement march banked it in cashIn (contract
    // v135 changed the march without a matching work-years
    // change). At 64 the sample plan collects no Social
    // Security yet, so there is no §86 feedback: $6,000 of
    // tax-exempt interest raises the surplus and the rolled
    // Taxable by exactly $6,000, with federal tax unchanged.
    // (The v102 fixture pins the same rule where §86 does
    // feed back: there the gap is +$5,650, the $6,000
    // banked less $350 of extra tax.)
    const job = { salary: 90000, employer401k: 0, employerHsa: 0 };
    const zero = priceOneWorkYear(
      wyPlan(64, 2026, { annualSpending: 0, taxExemptInterestAnnual: 0 }),
      job,
      64,
    );
    const withInterest = priceOneWorkYear(
      wyPlan(64, 2026, { annualSpending: 0, taxExemptInterestAnnual: 6000 }),
      job,
      64,
    );
    expect(withInterest.federalTax).toBe(zero.federalTax);
    expect(Math.round((withInterest.surplus - zero.surplus) * 100) / 100).toBe(6000);
    const zeroRoll = rollWorkYears(
      wyPlan(64, 2026, { annualSpending: 0, taxExemptInterestAnnual: 0 }),
      job,
      65,
    );
    const withRoll = rollWorkYears(
      wyPlan(64, 2026, { annualSpending: 0, taxExemptInterestAnnual: 6000 }),
      job,
      65,
    );
    expect(
      Math.round((withRoll.balances.taxable - zeroRoll.balances.taxable) * 100) / 100,
    ).toBe(6000);
  });
});

// ---------------------------------------------------------------------------
// §6 — work-to-retirement handoff
// ---------------------------------------------------------------------------

describe("E7 §6 — work-to-retirement handoff", () => {
  test("retiring at the current age: rolled plan is the plan, at the quit age", () => {
    const plan = wyPlan(62);
    const roll = rollWorkYears(plan, { salary: 100000, employer401k: 0, employerHsa: 0 }, 62);
    expect(roll.lines).toHaveLength(0);
    expect(roll.rolledInputs.retirementAge).toBe(62);
    expect(roll.rolledInputs.windowStartAge).toBe(62);
    expect(roll.rolledInputs.pretaxStart).toBe(plan.pretaxStart);
    expect(roll.rolledInputs.taxableStart).toBe(plan.taxableStart);
    expect(roll.rolledInputs.hsaStart).toBe(plan.hsaStart);
  });

  test("one year later and at 60 / 65 / 67: balances feed the rolled plan once", () => {
    for (const quitAge of [63, 60, 65, 67]) {
      // Start at 58 (sample window is 62; override it): the
      // roll prices 58..quitAge−1 under 2026+ law rows.
      const plan = wyPlan(58, 2026, { windowStartAge: 58, retirementAge: 58 });
      const roll = rollWorkYears(
        plan,
        { salary: 100000, employer401k: 5000, employerHsa: 1000, hsaCoverage: "family", hsaEligible: true },
        quitAge,
      );
      expect(roll.lines).toHaveLength(quitAge - 58);
      expect(roll.rolledInputs.startYear).toBe(plan.birthYearPrimary + quitAge);
      expect(roll.rolledInputs.retirementAge).toBe(quitAge);
      expect(roll.rolledInputs.windowStartAge).toBe(quitAge);
      expect(roll.rolledInputs.pretaxStart).toBe(roll.balances.pretaxPrimary);
      expect(roll.rolledInputs.pretaxSpouseStart).toBe(roll.balances.pretaxSpouse);
      expect(roll.rolledInputs.rothStart).toBe(roll.balances.roth);
      expect(roll.rolledInputs.taxableStart).toBe(roll.balances.taxable);
      expect(roll.rolledInputs.hsaStart).toBe(roll.balances.hsa);
      // Calendar alignment: each line's year is birth year + age.
      for (const line of roll.lines) {
        expect(line.calendarYear).toBe(plan.birthYearPrimary + line.age);
      }
      // IRMAA lookback: one seed record per work year, with the
      // year's own MAGI and the plan's filing status.
      expect(roll.rolledInputs.irmaaLookbackSeed).toHaveLength(roll.lines.length);
      roll.lines.forEach((line, i) => {
        const seed = roll.rolledInputs.irmaaLookbackSeed![i]!;
        expect(seed.year).toBe(line.calendarYear);
        expect(seed.magi).toBe(line.magi);
        expect(seed.filingStatus).toBe(plan.filingStatus);
      });
    }
  });

  test("RMD in a work year prices once, out of the right owner's balance", () => {
    // Primary born 1951 (age 75 in 2026; RMD age 73), spouse
    // born 1953 (age 73): both price RMDs at 75/73 on their own
    // prior-Dec-31 balances. Return 0%: pre-tax ends at start
    // − RMD + that year's contributions (primary only — the
    // spouse holds no pre-tax here beyond the plan default).
    const plan = wyPlan(75, 2026, {
      birthYearPrimary: 1951,
      birthYearSpouse: 1953,
      pretaxStart: 1000000,
      pretaxSpouseStart: 0,
      annualSpending: 120000,
    });
    const roll = rollWorkYears(
      plan,
      { salary: 100000, employer401k: 0, employerHsa: 0, hsaCoverage: "family", hsaEligible: true },
      76,
    );
    const line = roll.lines[0]!;
    expect(line.rmdPrimary).toBeGreaterThan(0);
    expect(line.rmdSpouse).toBe(0);
    expect(line.rmd).toBe(line.rmdPrimary);
    const s = line.stack;
    expect(roll.balances.pretaxPrimary).toBeCloseTo(
      1000000 - line.rmdPrimary + s.deferral + s.catchUp + s.employer401k,
      2,
    );
    // The RMD is ordinary income inside the year's tax AND cash
    // in the surplus — counted once on each side (the §5
    // identity above already pins the cash side).
    expect(line.taxableWages).toBe(
      100000 - s.deferral - (s.catchUpIsRoth ? 0 : s.catchUp) - s.ownHsa,
    );
  });

  test("Social Security collected while working deposits once", () => {
    // SS primary $48,000 from 67: the age-67 line deposits
    // $48,000 and the age-66 line deposits $0.
    const plan = wyPlan(66, 2026, { windowStartAge: 66, retirementAge: 66 });
    const roll = rollWorkYears(
      plan,
      { salary: 100000, employer401k: 0, employerHsa: 0, hsaCoverage: "family", hsaEligible: true },
      68,
    );
    expect(roll.lines[0]?.ssBenefits).toBe(0);
    expect(roll.lines[1]?.ssBenefits).toBe(48000);
  });

  test("payroll tax is folded into the compare total exactly once", () => {
    // One quit age (63, one work year at 62): the compare row's
    // totalTax is the winner's tax plus the work years' tax, and
    // all-in is the winner's net plus the same work tax — the
    // payroll part inside workTax is not added a second time.
    // SHORT HORIZON (end 66, window 62–64): the fold-in
    // identity is horizon-independent — it is arithmetic on the
    // row, not on the optimizer's search — and the full
    // sample-plan horizon prices the same code path at the
    // golden fixtures' cost, which this VM cannot afford inside
    // a per-file run under load.
    const plan = wyPlan(62, 2026, {
      windowStartAge: 62,
      retirementAge: 62,
      windowStopAge: 64,
      endAgePrimary: 66,
    });
    const rows = runWorkYearsCompare(
      plan,
      { salary: 100000, employer401k: 0, employerHsa: 0, hsaCoverage: "family", hsaEligible: true, priorYearWages: 90000 },
      [63],
    );
    const row = rows[0]!;
    expect(row.workTax).toBeCloseTo(
      row.roll.totals.federal + row.roll.totals.state + row.roll.totals.fica,
      2,
    );
    expect(row.totalTax).toBeCloseTo(row.optimizer.winner.cost.tax + row.workTax, 2);
    expect(row.allInTax).toBeCloseTo(row.optimizer.winner.cost.netCost + row.workTax, 2);
    expect(row.payrollTax).toBe(row.roll.totals.payrollTax);
    expect(row.assumptions).toEqual([]);
  }, 900_000);
});
