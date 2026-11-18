// Engine Review C6, C6-S1 — HSA contribution conservation: the
// per-year stack distinguishes the employer's REQUESTED HSA from
// the ACCEPTED HSA, and every figure foots.
//
// The Oct 14 deep-review seam (F4) was fixed in the roll TOTALS
// (employerContributions counts hsaBucket − ownHsa), but the
// per-year ContributionStack.employerHsa still carried the
// REQUESTED figure uncapped: a typed $12,000 employer HSA
// against a $9,750 limit read $12,000 on the stack while the
// bucket received $9,750. This file pins the fixed invariant
//   employerHsa (accepted) + ownHsa (accepted) === hsaBucket
//   employerHsaRequested − employerHsa === amount not accepted
// at the stack and through the roll, for self-only and family
// limits, the age-55 catch-up, Medicare ineligibility, explicit
// ineligibility, zero salary, and an over-limit contribution.
//
// Statutory sources (same as Review 7): IRC §223, IRS
// Publication 969 (2025); Rev. Proc. 2025-19 (2026): self-only
// $4,400, family $8,750; the $1,000 age-55 catch-up is
// statute-fixed (§223(b)(3)). All expected figures are
// hand-computed in the test itself, never copied engine prints.
// Sample-household values throughout (server/src/sampleHousehold.ts).
// Run per-file:
//   bun test server/src/workYearsReviewC6Hsa.test.ts

import { describe, expect, test } from "bun:test";
import { lawForYear, type FilingStatus } from "./taxLaw";
import {
  contributionStack,
  rollWorkYears,
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
  medicareAgePrimary?: number | null,
  hsaOpts?: { coverage?: HsaCoverage | null; eligible?: boolean | null } | null,
) {
  return contributionStack(
    age,
    salary,
    employer401k,
    employerHsa,
    filingStatus,
    LAW_2026,
    null,
    medicareAgePrimary ?? null,
    undefined,
    hsaOpts ?? { coverage: "family", eligible: true },
  );
}

describe("C6-S1: requested vs accepted employer HSA", () => {
  test("over-limit family at 56: $12,000 requested, $9,750 accepted", () => {
    // Limit $8,750 + $1,000 catch-up = $9,750. Own HSA $0: the
    // employer's $12,000 fills the whole limit and $2,250 is not
    // accepted.
    const s = stack(56, 400000, 0, 12000, "mfj", null, {
      coverage: "family",
      eligible: true,
    });
    expect(s.hsaLimit).toBe(9750);
    expect(s.employerHsaRequested).toBe(12000);
    expect(s.employerHsa).toBe(9750);
    expect(s.ownHsa).toBe(0);
    expect(s.hsaBucket).toBe(9750);
    // The conservation identity: accepted employer + accepted
    // employee === total deposited.
    expect(s.employerHsa + s.ownHsa).toBe(s.hsaBucket);
    expect(s.employerHsaRequested - s.employerHsa).toBe(2250);
  });

  test("over-limit self-only at 40: $6,000 requested, $4,400 accepted", () => {
    const s = stack(40, 100000, 0, 6000, "single", null, {
      coverage: "self-only",
      eligible: true,
    });
    expect(s.hsaLimit).toBe(4400);
    expect(s.employerHsaRequested).toBe(6000);
    expect(s.employerHsa).toBe(4400);
    expect(s.ownHsa).toBe(0);
    expect(s.hsaBucket).toBe(4400);
    expect(s.employerHsa + s.ownHsa).toBe(s.hsaBucket);
    expect(s.employerHsaRequested - s.employerHsa).toBe(1600);
  });

  test("under-limit employer shares the limit with the employee", () => {
    // Employer $9,000 + own $750 = $9,750 family limit at 56.
    // Requested and accepted agree when the figure fits.
    const s = stack(56, 100000, 0, 9000, "mfj", null, {
      coverage: "family",
      eligible: true,
    });
    expect(s.ownHsa).toBe(750);
    expect(s.employerHsaRequested).toBe(9000);
    expect(s.employerHsa).toBe(9000);
    expect(s.hsaBucket).toBe(9750);
    expect(s.employerHsa + s.ownHsa).toBe(s.hsaBucket);
    expect(s.employerHsaRequested - s.employerHsa).toBe(0);
  });

  test("at the limit exactly: nothing is refused", () => {
    const s = stack(56, 100000, 0, 9750, "mfj", null, {
      coverage: "family",
      eligible: true,
    });
    expect(s.employerHsaRequested).toBe(9750);
    expect(s.employerHsa).toBe(9750);
    expect(s.ownHsa).toBe(0);
    expect(s.hsaBucket).toBe(9750);
  });

  test("Medicare-gated year: $5,000 requested, $0 accepted, $0 requested-on-record", () => {
    // Enrolled at 65: the limit is $0, so nothing lands — and
    // the requested figure is gated to $0 too, so the stack
    // never reports a request that could not land.
    const s = stack(66, 100000, 0, 5000, "mfj", 65, {
      coverage: "family",
      eligible: true,
    });
    expect(s.hsaEligible).toBe(false);
    expect(s.hsaLimit).toBe(0);
    expect(s.employerHsaRequested).toBe(0);
    expect(s.employerHsa).toBe(0);
    expect(s.ownHsa).toBe(0);
    expect(s.hsaBucket).toBe(0);
  });

  test("explicitly ineligible: $5,000 requested, $0 accepted", () => {
    const s = stack(40, 100000, 0, 5000, "mfj", null, {
      coverage: "family",
      eligible: false,
    });
    expect(s.hsaEligible).toBe(false);
    expect(s.employerHsaRequested).toBe(0);
    expect(s.employerHsa).toBe(0);
    expect(s.hsaBucket).toBe(0);
  });

  test("no qualifying HDHP: $2,000 requested, $0 accepted", () => {
    const s = stack(56, 100000, 0, 2000, "mfj", null, {
      coverage: "none",
      eligible: true,
    });
    expect(s.hsaEligible).toBe(false);
    expect(s.hsaLimit).toBe(0);
    expect(s.employerHsaRequested).toBe(0);
    expect(s.employerHsa).toBe(0);
    expect(s.hsaBucket).toBe(0);
  });

  test("zero salary: $12,000 requested, $0 accepted, $0 deposited", () => {
    // No salary prices no stack, but the typed request is still
    // reported (eligibility-gated) so the year distinguishes
    // "asked for $12,000, accepted $0" from "nothing asked for".
    const s = stack(56, 0, 0, 12000, "mfj", null, {
      coverage: "family",
      eligible: true,
    });
    expect(s.hsaEligible).toBe(true);
    expect(s.employerHsaRequested).toBe(12000);
    expect(s.employerHsa).toBe(0);
    expect(s.ownHsa).toBe(0);
    expect(s.hsaBucket).toBe(0);
  });

  test("zero salary and ineligible: requested is $0 too", () => {
    const s = stack(56, 0, 0, 12000, "mfj", null, {
      coverage: "family",
      eligible: false,
    });
    expect(s.employerHsaRequested).toBe(0);
    expect(s.employerHsa).toBe(0);
    expect(s.hsaBucket).toBe(0);
  });
});

describe("C6-S1: roll-level conservation", () => {
  test("one over-limit work year foots end to end", () => {
    // One priced year at 56, salary $400,000, employer HSA
    // $12,000 over the family limit. Zero return, so balances
    // check exactly (sample HSA opens at $75,000).
    const plan = wyPlan(56);
    const job: WorkYearJob = {
      salary: 400000,
      employer401k: 0,
      employerHsa: 12000,
      hsaCoverage: "family",
      hsaEligible: true,
      priorYearWages: null,
    };
    const roll = rollWorkYears(plan, job, 57);
    expect(roll.lines).toHaveLength(1);
    const line = roll.lines[0]!;
    const s = line.stack;
    // The stack's accepted figure agrees with the totals' own
    // derivation (hsaBucket − ownHsa), and the requested figure
    // is the typed $12,000.
    expect(s.employerHsaRequested).toBe(12000);
    expect(s.employerHsa).toBe(s.hsaBucket - s.ownHsa);
    expect(s.employerHsa + s.ownHsa).toBe(s.hsaBucket);
    // The year prices under its own 2026 law row, so the limit
    // is the undeflated $8,750 + $1,000 = $9,750 (the deflated
    // $9,725.61 arises only when a later year prices off the
    // carried 2026 row — E7's case, not this one).
    expect(s.hsaLimit).toBe(9750);
    expect(s.employerHsa).toBe(9750);
    // Totals foot: employer + employee === total, and the HSA
    // total is the bucket that landed.
    expect(roll.totals.hsaContributions).toBe(s.hsaBucket);
    expect(roll.totals.employerContributions).toBe(s.employerHsa);
    expect(
      roll.totals.employeeContributions + roll.totals.employerContributions,
    ).toBe(roll.totals.totalContributions);
    // The ending HSA balance is the opening $75,000 plus exactly
    // what landed — never the $12,000 requested.
    expect(roll.balances.hsa).toBe(75000 + roll.totals.hsaContributions);
    expect(roll.balances.hsa).toBe(84750);
  });
});

// Engine Review C6 NICEs — NICE-3: a direct contributionStack
// call with a NEGATIVE employer HSA. No reachable product path
// supplies one (the work-years job fields carry .min(0) at the
// shared field record), but the stack itself must not let one
// through: unclamped, a negative inflates the employee's room
// (the limit-minus-employer term grows) so ownHsa can exceed
// the limit, and the S1 identity (accepted employer + own ===
// bucket) breaks. The stack floors the contribution at 0 — a
// negative prices exactly as no employer contribution — so the
// identity holds for every input, not just validated ones.
describe("C6 NICEs — NICE-3: negative employer HSA clamps to $0", () => {
  test("negative employer HSA on a priced year: requested $0, own fills the limit", () => {
    // Family limit $8,750 at 40 (no catch-up under 55). A −$500
    // employer figure must not inflate ownHsa to $9,250 (the
    // pre-fix behaviour: limit − (−$500)) — own fills exactly
    // the $8,750 limit and the identity holds.
    const s = stack(40, 100000, 0, -500, "mfj", null, {
      coverage: "family",
      eligible: true,
    });
    expect(s.hsaLimit).toBe(8750);
    expect(s.employerHsaRequested).toBe(0);
    expect(s.employerHsa).toBe(0);
    expect(s.ownHsa).toBe(8750);
    expect(s.hsaBucket).toBe(8750);
    expect(s.employerHsa + s.ownHsa).toBe(s.hsaBucket);
  });

  test("negative employer HSA on a zero-salary year: requested $0", () => {
    const s = stack(40, 0, 0, -500, "mfj", null, {
      coverage: "family",
      eligible: true,
    });
    expect(s.employerHsaRequested).toBe(0);
    expect(s.employerHsa).toBe(0);
    expect(s.hsaBucket).toBe(0);
  });

  test("control: a positive employer HSA still prices as before", () => {
    const s = stack(40, 100000, 0, 2000, "mfj", null, {
      coverage: "family",
      eligible: true,
    });
    expect(s.employerHsaRequested).toBe(2000);
    expect(s.employerHsa).toBe(2000);
    expect(s.ownHsa).toBe(6750);
    expect(s.hsaBucket).toBe(8750);
    expect(s.employerHsa + s.ownHsa).toBe(s.hsaBucket);
  });
});
