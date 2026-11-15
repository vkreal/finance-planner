// Engine Review 7, E7-S2 — mandatory Roth catch-up (§414(v)(7)) (§2),
// with the §5 cash-flow identity legs the catch-up classification
// touches and the §6 handoff legs for the first modeled year.
//
// STANDARD (same as Reviews 1/5): every expected figure below is
// hand-computed in the test itself (plain arithmetic on literals),
// never a copied engine print. Statutory sources, verified for this
// review against IRS guidance (not taken from the brief):
//   - SECURE 2.0 Act §603, IRC §414(v)(7): for taxable years
//     beginning after December 31, 2025, a catch-up-eligible
//     participant (age 50+ by year-end) whose PRIOR calendar
//     year's §3121(a) FICA wages from the plan sponsor EXCEED the
//     threshold must make catch-up contributions as designated Roth.
//     The test is strictly greater-than: wages exactly at the
//     threshold stay pre-tax. The wage figure is W-2 Box 3 —
//     salary minus the payroll HSA contribution (a §125
//     deduction); pre-tax 401(k) deferrals do NOT reduce it.
//   - IRS Notice 2023-62: administrative transition period through
//     December 31, 2025 — pre-tax catch-ups were permissible
//     through 2025 regardless of wages, so the mandate's first
//     year is 2026. Final regulations (T.D. 10033, Sept 2025)
//     confirm the mandate applies for taxable years beginning
//     after December 31, 2025.
//   - IRS Notice 2025-67: the threshold is $145,000 statutory
//     base, indexed — $150,000 for 2026 (measured on 2025
//     wages). The 2025 law row carries $145,000; the 2026 row
//     carries $150,000. Years past the table carry the newest row
//     forward (the table's carry-forward rule).
//   - Only the CATCH-UP is forced Roth: the §402(g) deferral stays
//     pre-tax, the mega backdoor stays Roth as modeled, employer
//     money stays pre-tax. Catch-ups are excluded from the §415(c)
//     annual-additions cap, so they never net against the mega
//     room or the employer room.
//   - Prior wages are never inferred from account balances or
//     salary forecasts: the only feeds are the explicit job input
//     (first year) and the threaded prior year's own Box-3 wages
//     (later years).
//
// Sample-household values throughout (server/src/sampleHousehold.ts).
// Run per-file:
//   bun test server/src/workYearsReview7CatchUp.test.ts

import { describe, expect, test } from "bun:test";
import { lawForYear } from "./taxLaw";
import {
  contributionStack,
  priceOneWorkYear,
  rollWorkYears,
  type WorkYearJob,
} from "./workYears";
import { samplePlanInputs } from "./sampleHousehold";
import type { RothPlanInputs } from "./taxEngine";

const LAW_2025 = lawForYear(2025);
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

// ---------------------------------------------------------------------------
// §2 — the law-year threshold table itself
// ---------------------------------------------------------------------------

describe("E7-S2 §2 — thresholds by law year", () => {
  test("2025 row: $145,000 base; 2026 row: $150,000 (Notice 2025-67)", () => {
    expect(LAW_2025.rothCatchUpWageThreshold).toBe(14500000);
    expect(LAW_2026.rothCatchUpWageThreshold).toBe(15000000);
  });

  test("years past the table carry the newest row's $150,000 forward", () => {
    expect(lawForYear(2027).rothCatchUpWageThreshold).toBe(15000000);
    expect(lawForYear(2030).rothCatchUpWageThreshold).toBe(15000000);
  });
});

// ---------------------------------------------------------------------------
// §2 — prior-year wages below / at / above the threshold
// ---------------------------------------------------------------------------

describe("E7-S2 §2 — prior-year wage classification", () => {
  test("prior wages below the threshold: catch-up stays pre-tax", () => {
    // Age 50, salary $160,000, 2026 law, prior wages $140,000:
    // deferral $24,500, catch-up $8,000 pre-tax, own HSA $8,750
    // (MFJ family, age 50 — no 55+ catch-up yet). Taxable wages
    // = $160,000 − $24,500 − $8,000 − $8,750 = $118,750.
    const s = contributionStack(50, 160000, 0, 0, "mfj", LAW_2026, 140000);
    expect(s.catchUp).toBe(8000);
    expect(s.catchUpIsRoth).toBe(false);
    expect(s.deferral).toBe(24500);
    expect(s.ownHsa).toBe(8750);
  });

  test("prior wages exactly at the threshold: still pre-tax (strictly greater)", () => {
    // $150,000 does not EXCEED $150,000, so the mandate does not
    // bite — the boundary case the wording decides.
    const s = contributionStack(50, 160000, 0, 0, "mfj", LAW_2026, 150000);
    expect(s.catchUp).toBe(8000);
    expect(s.catchUpIsRoth).toBe(false);
  });

  test("prior wages above the threshold: catch-up is Roth", () => {
    // Prior wages $150,001: catch-up $8,000 Roth. Taxable wages
    // = $160,000 − $24,500 − $8,750 = $126,750 — the catch-up
    // stays IN taxable wages because it is Roth now.
    const s = contributionStack(50, 160000, 0, 0, "mfj", LAW_2026, 150001);
    expect(s.catchUp).toBe(8000);
    expect(s.catchUpIsRoth).toBe(true);
    expect(s.deferral).toBe(24500);
    expect(s.ownHsa).toBe(8750);
  });

  test("current year above, prior year below: pre-tax (prior year governs)", () => {
    // Salary $200,000 — this year's Box-3 wages would be
    // $200,000 − $8,750 = $191,250, far above the threshold —
    // but the test reads the PRIOR year ($140,000), so pre-tax.
    const s = contributionStack(50, 200000, 0, 0, "mfj", LAW_2026, 140000);
    expect(s.catchUpIsRoth).toBe(false);
  });

  test("current year below, prior year above: Roth (the drop does not rescue the year)", () => {
    // Salary $140,000 — this year's Box-3 wages $131,250 are
    // below the threshold — but the prior year's $160,000 force
    // this year's catch-up to Roth anyway.
    const s = contributionStack(51, 140000, 0, 0, "mfj", LAW_2026, 160000);
    expect(s.catchUp).toBe(8000);
    expect(s.catchUpIsRoth).toBe(true);
  });

  test("younger than catch-up eligibility: no catch-up at any wage", () => {
    // Age 49, prior wages $200,000: no catch-up exists to force,
    // so the mandate has nothing to classify.
    const s = contributionStack(49, 160000, 0, 0, "mfj", LAW_2026, 200000);
    expect(s.catchUp).toBe(0);
    expect(s.catchUpIsRoth).toBe(false);
  });

  test("ages 50–59: the $8,000 catch-up; 60–63: the $11,250 super catch-up; 64+: $8,000 again", () => {
    // All Roth at prior wages $200,000 (2026 law).
    expect(contributionStack(50, 160000, 0, 0, "mfj", LAW_2026, 200000).catchUp).toBe(8000);
    expect(contributionStack(59, 160000, 0, 0, "mfj", LAW_2026, 200000).catchUp).toBe(8000);
    expect(contributionStack(60, 160000, 0, 0, "mfj", LAW_2026, 200000).catchUp).toBe(11250);
    expect(contributionStack(63, 160000, 0, 0, "mfj", LAW_2026, 200000).catchUp).toBe(11250);
    expect(contributionStack(64, 160000, 0, 0, "mfj", LAW_2026, 200000).catchUp).toBe(8000);
    for (const age of [50, 60, 63, 64]) {
      expect(contributionStack(age, 160000, 0, 0, "mfj", LAW_2026, 200000).catchUpIsRoth).toBe(true);
      expect(contributionStack(age, 160000, 0, 0, "mfj", LAW_2026, 100000).catchUpIsRoth).toBe(false);
    }
  });

  test("2025: the mandate never applies, whatever the prior wages", () => {
    // Notice 2023-62's transition period: a 2025 catch-up is
    // pre-tax even at prior wages $200,000 — the mandate's
    // first year is 2026.
    const s = contributionStack(50, 160000, 0, 0, "mfj", LAW_2025, 200000);
    expect(s.catchUp).toBe(7500);
    expect(s.catchUpIsRoth).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §2 — the first modeled year: explicit wages vs the proxy
// ---------------------------------------------------------------------------

describe("E7-S2 §2 — first modeled year", () => {
  test("explicit prior wages decide the first year; later years thread", () => {
    // Salary $140,000, explicit prior wages $160,000, start
    // 2026 at 50, two years. Year 1 (2026): prior $160,000 >
    // $150,000 → catch-up Roth. Year 2 (2027, 2026 row
    // carried forward): threaded prior wages are year 1's own
    // Box-3 wages, $140,000 − $8,750 = $131,250 < $150,000 →
    // catch-up pre-tax again. The drop takes a year to bite.
    const plan = wyPlan(50, 2026, { birthYearSpouse: 1978 });
    const job: WorkYearJob = {
      salary: 140000,
      employer401k: 0,
      employerHsa: 0,
      hsaCoverage: "family",
      hsaEligible: true,
      priorYearWages: 160000,
    };
    const roll = rollWorkYears(plan, job, 52);
    expect(roll.lines).toHaveLength(2);
    expect(roll.lines[0]?.stack.catchUpIsRoth).toBe(true);
    expect(roll.lines[0]?.stack.catchUp).toBe(8000);
    expect(roll.lines[0]?.ficaWages).toBe(131250);
    expect(roll.lines[1]?.stack.catchUpIsRoth).toBe(false);
    expect(roll.lines[1]?.stack.catchUp).toBe(8000);
    // No proxy assumption anywhere: the first year had explicit
    // wages and the second threaded them.
    expect(roll.lines[0]?.assumptions.some((a) => a.includes("proxy"))).toBe(false);
    expect(roll.lines[1]?.assumptions.some((a) => a.includes("proxy"))).toBe(false);
    expect(roll.assumptions.some((a) => a.includes("proxy"))).toBe(false);
  });

  test("no explicit wages: the first year uses its own Box-3 as the proxy — and says so", () => {
    // Salary $155,000, MFJ family at 50 in 2026, no prior
    // wages: own HSA $8,750, proxy wages $146,250 ≤ $150,000
    // → catch-up pre-tax, taxable wages $155,000 − $24,500 −
    // $8,000 − $8,750 = $113,750. The proxy is named on the
    // first year's line only.
    const plan = wyPlan(50, 2026, { birthYearSpouse: 1978 });
    const line = priceOneWorkYear(plan, { salary: 155000, employer401k: 0, employerHsa: 0 }, 50);
    expect(line.stack.catchUpIsRoth).toBe(false);
    expect(line.stack.ownHsa).toBe(8750);
    expect(line.taxableWages).toBe(113750);
    expect(line.assumptions.some((a) => a.includes("proxy for the prior calendar year's wages"))).toBe(true);
    expect(line.assumptions.some((a) => a.includes("$146,250"))).toBe(true);
  });

  test("proxy above the threshold forces Roth — the proxy can change the answer", () => {
    // Salary $160,000, no prior wages: proxy Box-3 wages
    // $160,000 − $8,750 = $151,450 > $150,000 → catch-up Roth,
    // taxable wages $160,000 − $24,500 − $8,750 = $126,750.
    // The same salary WITH explicit prior wages of $140,000
    // would price pre-tax — which is why the proxy is disclosed.
    const plan = wyPlan(50, 2026, { birthYearSpouse: 1978 });
    const line = priceOneWorkYear(plan, { salary: 160000, employer401k: 0, employerHsa: 0 }, 50);
    expect(line.stack.catchUpIsRoth).toBe(true);
    expect(line.taxableWages).toBe(126750);
    expect(line.assumptions.some((a) => a.includes("proxy"))).toBe(true);
    const withExplicit = priceOneWorkYear(
      plan,
      { salary: 160000, employer401k: 0, employerHsa: 0, priorYearWages: 140000 },
      50,
      140000,
    );
    expect(withExplicit.stack.catchUpIsRoth).toBe(false);
    expect(withExplicit.taxableWages).toBe(118750);
  });

  test("proxy assumption appears only where it can change the classification", () => {
    // Age 49: no catch-up exists, so the proxy is moot — no
    // assumption is recorded. Pre-2026: the mandate never
    // applies — no assumption either.
    const plan50 = wyPlan(49, 2026, { birthYearSpouse: 1979 });
    const line49 = priceOneWorkYear(plan50, { salary: 160000, employer401k: 0, employerHsa: 0 }, 49);
    expect(line49.assumptions.some((a) => a.includes("proxy"))).toBe(false);
    const plan25 = wyPlan(50, 2025, { birthYearSpouse: 1978 });
    const line25 = priceOneWorkYear(plan25, { salary: 160000, employer401k: 0, employerHsa: 0 }, 50);
    expect(line25.stack.catchUp).toBe(7500);
    expect(line25.stack.catchUpIsRoth).toBe(false);
    expect(line25.assumptions.some((a) => a.includes("proxy"))).toBe(false);
  });

  test("existing requests without prior-year wages price exactly as before", () => {
    // The pre-change behavior IS the proxy: a two-year roll at
    // $150,001 (MFJ, 2025–2026) prices 2025 pre-tax on the year
    // gate and 2026 pre-tax on the threaded 2025 Box-3 wages
    // ($150,001 − $8,550 = $141,451 < $150,000) — the pinned
    // fixture's figures, re-derived here through the roll.
    const plan = wyPlan(50, 2025, { birthYearSpouse: 1986 });
    const roll = rollWorkYears(plan, { salary: 150001, employer401k: 0, employerHsa: 0 }, 52);
    expect(roll.lines[0]?.stack.catchUp).toBe(7500);
    expect(roll.lines[0]?.stack.catchUpIsRoth).toBe(false);
    expect(roll.lines[0]?.ficaWages).toBe(141451);
    expect(roll.lines[1]?.stack.catchUp).toBe(8000);
    expect(roll.lines[1]?.stack.catchUpIsRoth).toBe(false);
    expect(roll.lines[1]?.taxableWages).toBe(108751);
    // No proxy assumption on either year: the first year is
    // 2025, where the mandate never applies, so the proxy
    // could not change its classification; the second year
    // threads the first year's wages. Only the two HSA
    // fallbacks are recorded.
    expect(roll.lines[0]?.assumptions.some((a) => a.includes("proxy"))).toBe(false);
    expect(roll.lines[1]?.assumptions.some((a) => a.includes("proxy"))).toBe(false);
    expect(roll.assumptions.length).toBe(2);
  });

  test("prior wages are never inferred from balances or salary forecasts", () => {
    // A $5,000,000 pre-tax balance and a $100,000 salary: the
    // only wage figure the test can read is this year's Box-3
    // wages ($100,000 − $8,750 = $91,250) — far under the
    // threshold — so the catch-up stays pre-tax. A balance- or
    // forecast-derived wage would force Roth.
    const plan = wyPlan(50, 2026, { birthYearSpouse: 1978, pretaxStart: 5000000 });
    const line = priceOneWorkYear(plan, { salary: 100000, employer401k: 0, employerHsa: 0 }, 50);
    expect(line.stack.catchUpIsRoth).toBe(false);
    expect(line.ficaWages).toBe(91250);
  });
});

// ---------------------------------------------------------------------------
// §2 — only the catch-up turns Roth; everything else keeps its character
// ---------------------------------------------------------------------------

describe("E7-S2 §2 — only the catch-up turns Roth", () => {
  test("Roth catch-up with employer money: deferral pre-tax, employer pre-tax, mega Roth", () => {
    // Salary $160,000, employer 401(k) $10,000, prior wages
    // $200,000, age 50, 2026: deferral $24,500 pre-tax,
    // catch-up $8,000 Roth, employer $10,000 pre-tax. The
    // §415(c) room is min($72,000, $160,000) = $72,000; the
    // catch-up is excluded from it, so mega room is $72,000
    // − $24,500 − $10,000 = $37,500, and mega = min($37,500,
    // $160,000 − $24,500 − $8,000 − $8,750) = $37,500 Roth.
    // Pretax in $34,500; Roth in $45,500; HSA $8,750.
    const plan = wyPlan(50, 2026, { birthYearSpouse: 1978 });
    const roll = rollWorkYears(
      plan,
      { salary: 160000, employer401k: 10000, employerHsa: 0, hsaCoverage: "family", hsaEligible: true, priorYearWages: 200000 },
      51,
    );
    const line = roll.lines[0]!;
    expect(line.stack.deferral).toBe(24500);
    expect(line.stack.catchUp).toBe(8000);
    expect(line.stack.catchUpIsRoth).toBe(true);
    expect(line.stack.employer401k).toBe(10000);
    expect(line.stack.mega).toBe(37500);
    expect(roll.totals.pretaxContributions).toBe(34500);
    expect(roll.totals.rothContributions).toBe(45500);
    expect(roll.totals.hsaContributions).toBe(8750);
    // Balances (return 0%): each bucket grows by exactly its
    // own contributions — the employer money is in Pre-tax,
    // the Roth catch-up and mega in Roth, nothing crossed.
    expect(roll.balances.pretaxPrimary).toBe(plan.pretaxStart + 34500);
    expect(roll.balances.roth).toBe(plan.rothStart + 45500);
    expect(roll.balances.hsa).toBe(plan.hsaStart + 8750);
    // Taxable wages exclude the pre-tax deferral and the HSA
    // but INCLUDE the Roth catch-up: $160,000 − $24,500 −
    // $8,750 = $126,750.
    expect(line.taxableWages).toBe(126750);
  });

  test("not all 401(k) money turns Roth when the catch-up does", () => {
    // Same shape, no employer money: pre-tax in is the $24,500
    // deferral alone; Roth in is catch-up $8,000 + mega
    // $47,500 = $55,500. The deferral did not follow the
    // catch-up into Roth.
    const plan = wyPlan(50, 2026, { birthYearSpouse: 1978 });
    const roll = rollWorkYears(
      plan,
      { salary: 160000, employer401k: 0, employerHsa: 0, hsaCoverage: "family", hsaEligible: true, priorYearWages: 200000 },
      51,
    );
    expect(roll.totals.pretaxContributions).toBe(24500);
    expect(roll.totals.rothContributions).toBe(55500);
    expect(roll.totals.employeeContributions).toBe(24500 + 8000 + 47500 + 8750);
    expect(roll.totals.totalContributions).toBe(24500 + 55500 + 8750);
  });
});

// ---------------------------------------------------------------------------
// §5 — the annual identity under a Roth catch-up
// ---------------------------------------------------------------------------

describe("E7 §5 — annual identity with a Roth catch-up", () => {
  test("salary − taxes − spending − own contributions = surplus, Roth catch-up included", () => {
    // The Roth catch-up is an employee contribution out of
    // salary cash (it is after-tax money) AND stays in taxable
    // wages — both sides of the identity must hold at once.
    const plan = wyPlan(50, 2026, { birthYearSpouse: 1978 });
    const roll = rollWorkYears(
      plan,
      { salary: 160000, employer401k: 0, employerHsa: 0, hsaCoverage: "family", hsaEligible: true, priorYearWages: 200000 },
      52,
    );
    for (const line of roll.lines) {
      const s = line.stack;
      const own = s.deferral + s.catchUp + s.mega + s.ownHsa;
      const lhs =
        line.salary + line.ssBenefits + line.rmd -
        line.federalTax - line.stateTax - line.fica -
        plan.annualSpending - own;
      expect(Math.abs(lhs - line.surplus)).toBeLessThanOrEqual(0.02);
      // And the taxable-wage side: the Roth catch-up is not
      // subtracted (it is after-tax), the pre-tax deferral and
      // the HSA are.
      expect(line.taxableWages).toBeCloseTo(
        line.salary - s.deferral - (s.catchUpIsRoth ? 0 : s.catchUp) - s.ownHsa,
        2,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// §6 — first-year handoff: the explicit wages do not leak into later years
// ---------------------------------------------------------------------------

describe("E7 §6 — first-year wages stay in the first year", () => {
  test("explicit prior wages price year 1 only; year 2 threads year 1's wages", () => {
    // Salary $200,000 both years, explicit prior wages $100,000
    // (below threshold): year 1 pre-tax. Year 2 threads year
    // 1's Box-3 wages ($200,000 − $8,750 = $191,250, above
    // threshold) → Roth. The explicit figure never carries past
    // the year it was entered for.
    const plan = wyPlan(50, 2026, { birthYearSpouse: 1978 });
    const roll = rollWorkYears(
      plan,
      { salary: 200000, employer401k: 0, employerHsa: 0, hsaCoverage: "family", hsaEligible: true, priorYearWages: 100000 },
      52,
    );
    expect(roll.lines[0]?.stack.catchUpIsRoth).toBe(false);
    expect(roll.lines[1]?.stack.catchUpIsRoth).toBe(true);
    expect(roll.lines[1]?.taxableWages).toBe(200000 - 24500 - 8750);
  });

  test("zero work years: no classification happens and no assumption is recorded", () => {
    const plan = wyPlan(62);
    const roll = rollWorkYears(
      plan,
      { salary: 200000, employer401k: 0, employerHsa: 0, priorYearWages: 200000 },
      62,
    );
    expect(roll.lines).toHaveLength(0);
    expect(roll.assumptions).toEqual([]);
  });
});
