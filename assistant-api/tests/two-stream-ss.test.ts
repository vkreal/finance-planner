// two-stream-ss.test.ts — SHOULD-1: two Social Security streams at
// their own claiming years.
//
// The portfolio simulation prices an income SCHEDULE (one entry per
// stream) instead of a single extra-income stream. Claiming ages are
// per-person: the spouse's claiming age is converted into the
// primary's age timeline through the two birth years
// (spouseStart = ssSpouseStartAge + (birthYearSpouse −
// birthYearPrimary)), the same per-person rule the tax-aware engine
// uses (year − birthYear per person).
//
// Cases A–H from the spec. Engine-level cases use a small hand-
// checkable plan (start $1,000,000, spending $50,000/yr, retire
// 58, end 75, zero returns) and an INDEPENDENT cash-flow
// recomputation — not the engine under test — for every ending
// balance. Adapter-level cases use the fictional household (ages
// 54/52) with DISTINCT per-spouse offsets: primary claims 16
// years out, spouse 10 years out (never the spec example's
// 55/44 + 70/67 combo).

import { describe, expect, test } from "bun:test";
import {
  calculateMaxSpending,
  calculateRetirement,
  runRetirementMonteCarlo,
  toSimInputs,
} from "../src/adapter";
import {
  eventualIncomeCents,
  horizonYears,
  incomeCentsAt,
  runHistorical,
  runMonteCarlo,
  runNeverRunsOut,
  simulateDetailed,
  solveMaxSpending,
  type SimInputs,
} from "../../server/src/retirementEngines";
import { HISTORICAL } from "../../server/src/retirementData";
import {
  expectOk,
  normalizedScenario,
} from "./helpers";

/** Cents for a whole-dollar amount. */
const c = (dollars: number): number => dollars * 100;

/** The small hand-checkable engine plan. */
function engineInputs(overrides: Partial<SimInputs> = {}): SimInputs {
  return {
    startCents: c(1_000_000),
    spendingCents: c(50_000),
    currentAge: 54,
    retirementAge: 58,
    endAge: 75,
    extraIncomeCents: 0,
    extraIncomeStartAge: null,
    strategy: "constant",
    percentOfPortfolio: 0,
    guardrailsCutPct: 120,
    guardrailsRaisePct: 80,
    guardrailsAdjustmentPct: 10,
    phaseStartAge: 75,
    phaseDeclinePct: 1,
    ...overrides,
  };
}

const zeroReturns = (inputs: SimInputs): number[] =>
  Array.from({ length: horizonYears(inputs.currentAge, inputs.endAge) }, () => 0);

/**
 * Independent ending balance for zero returns: walk the ages,
 * subtract the year's net withdrawal (spending minus every
 * stream active that year), floor at 0. Written from the
 * documented rule, not by calling the engine.
 */
function handEnding(
  inputs: SimInputs,
  streams: { amountCents: number; startAge: number }[],
): number {
  let bal = inputs.startCents;
  for (let age = inputs.currentAge; age <= inputs.endAge; age++) {
    if (age >= inputs.retirementAge) {
      let income = 0;
      for (const s of streams) {
        if (age >= s.startAge) income += s.amountCents;
      }
      bal -= inputs.spendingCents - income;
      if (bal < 0) bal = 0;
    }
  }
  return bal;
}

/** Independent never-runs-out check for zero returns. */
function handNeverOut(
  inputs: SimInputs,
  streams: { amountCents: number; startAge: number }[],
): boolean {
  let bal = inputs.startCents;
  for (let age = inputs.currentAge; age <= inputs.endAge; age++) {
    if (age >= inputs.retirementAge) {
      let income = 0;
      for (const s of streams) {
        if (age >= s.startAge) income += s.amountCents;
      }
      const net = inputs.spendingCents - income;
      if (net > bal) return false;
      bal -= net;
      if (bal < 0) bal = 0;
    }
  }
  return true;
}

describe("Case A — primary only: exact parity with the legacy engine", () => {
  test("a one-stream schedule prices identically to the legacy single stream", () => {
    const stream = { amountCents: c(36_000), startAge: 67 };
    const viaSchedule = engineInputs({ incomeSchedule: [stream] });
    const viaLegacy = engineInputs({
      extraIncomeCents: c(36_000),
      extraIncomeStartAge: 67,
    });
    const returns = zeroReturns(viaSchedule);
    expect(simulateDetailed(viaSchedule, returns)).toEqual(
      simulateDetailed(viaLegacy, returns),
    );
    expect(runNeverRunsOut(viaSchedule, returns)).toBe(
      runNeverRunsOut(viaLegacy, returns),
    );
    const det = simulateDetailed(viaSchedule, returns);
    expect(det.balances[det.balances.length - 1]).toBe(
      handEnding(viaSchedule, [stream]),
    );
  });

  test("no schedule at all is the old behavior, unchanged", () => {
    const inputs = engineInputs({
      extraIncomeCents: c(36_000),
      extraIncomeStartAge: 67,
    });
    const det = simulateDetailed(inputs, zeroReturns(inputs));
    expect(det.balances[det.balances.length - 1]).toBe(
      handEnding(inputs, [{ amountCents: c(36_000), startAge: 67 }]),
    );
    // $1,000,000 − 18 retired years × $50,000 + 9 years × $36,000
    // (ages 67–75) = $424,000.
    expect(det.balances[det.balances.length - 1]).toBe(c(424_000));
  });
});

describe("Case B — spouse only: starts in the correct calendar year", () => {
  test("spouse stream offsets spending only from its start year", () => {
    const stream = { amountCents: c(18_000), startAge: 69 };
    const inputs = engineInputs({ incomeSchedule: [stream] });
    const det = simulateDetailed(inputs, zeroReturns(inputs));
    const netAt = (age: number): number =>
      det.netWithdrawals[age - inputs.currentAge] ?? -1;
    expect(netAt(68)).toBe(c(50_000));
    expect(netAt(69)).toBe(c(32_000));
    expect(netAt(75)).toBe(c(32_000));
    expect(det.balances[det.balances.length - 1]).toBe(
      handEnding(inputs, [stream]),
    );
    expect(det.balances[det.balances.length - 1]).toBe(c(226_000));
  });
});

describe("Case C — same calendar-year start: benefits sum", () => {
  test("two streams starting together equal their sum", () => {
    const streams = [
      { amountCents: c(36_000), startAge: 70 },
      { amountCents: c(18_000), startAge: 70 },
    ];
    const inputs = engineInputs({ incomeSchedule: streams });
    const det = simulateDetailed(inputs, zeroReturns(inputs));
    const netAt = (age: number): number =>
      det.netWithdrawals[age - inputs.currentAge] ?? -1;
    expect(netAt(69)).toBe(c(50_000));
    // From 70 the surplus ($54,000 income vs $50,000 spending)
    // ADDS $4,000/yr to the portfolio.
    expect(netAt(70)).toBe(c(-4_000));
    expect(det.balances[det.balances.length - 1]).toBe(
      handEnding(inputs, streams),
    );
    expect(det.balances[det.balances.length - 1]).toBe(c(424_000));
  });
});

describe("Case D — different starts, both orders", () => {
  test("spouse first, then primary: each stream joins when it begins", () => {
    const streams = [
      { amountCents: c(36_000), startAge: 70 },
      { amountCents: c(18_000), startAge: 69 },
    ];
    const inputs = engineInputs({ incomeSchedule: streams });
    const det = simulateDetailed(inputs, zeroReturns(inputs));
    const netAt = (age: number): number =>
      det.netWithdrawals[age - inputs.currentAge] ?? -1;
    expect(netAt(68)).toBe(c(50_000));
    expect(netAt(69)).toBe(c(32_000));
    expect(netAt(70)).toBe(c(-4_000));
    expect(det.balances[det.balances.length - 1]).toBe(
      handEnding(inputs, streams),
    );
    expect(det.balances[det.balances.length - 1]).toBe(c(442_000));
  });

  test("primary first, then spouse: same rule, reversed order", () => {
    const streams = [
      { amountCents: c(36_000), startAge: 67 },
      { amountCents: c(18_000), startAge: 69 },
    ];
    const inputs = engineInputs({ incomeSchedule: streams });
    const det = simulateDetailed(inputs, zeroReturns(inputs));
    const netAt = (age: number): number =>
      det.netWithdrawals[age - inputs.currentAge] ?? -1;
    expect(netAt(66)).toBe(c(50_000));
    expect(netAt(67)).toBe(c(14_000));
    expect(netAt(69)).toBe(c(-4_000));
    expect(det.balances[det.balances.length - 1]).toBe(
      handEnding(inputs, streams),
    );
    expect(det.balances[det.balances.length - 1]).toBe(c(550_000));
  });
});

describe("Case E — different spouse ages: per-spouse year offsets", () => {
  test("adapter converts the spouse claiming age through the birth years", () => {
    // Fictional household: primary 54 claims 70 (16 years out),
    // spouse 52 claims 62 (10 years out — spouse turns 62 in the
    // year the primary turns 64).
    const s = normalizedScenario({
      socialSecurityAnnual: 36000,
      socialSecurityStartAge: 70,
      spouseSocialSecurityAnnual: 18000,
      spouseSocialSecurityStartAge: 62,
    });
    const { inputs, warnings } = toSimInputs(s);
    expect(warnings).not.toContain(
      expect.stringContaining("second stream"),
    );
    expect(inputs.incomeSchedule).toEqual([
      { amountCents: c(36_000), startAge: 70 },
      { amountCents: c(18_000), startAge: 64 },
    ]);
    // Legacy fields keep the earliest stream (spouse, 64).
    expect(inputs.extraIncomeCents).toBe(c(18_000));
    expect(inputs.extraIncomeStartAge).toBe(64);
    const res = expectOk(calculateRetirement(s));
    const netAt = (age: number): number =>
      res.yearlyNetWithdrawals.find((w) => w.age === age)?.amount ?? -1;
    expect(netAt(63)).toBe(114_000);
    expect(netAt(64)).toBe(96_000);
    expect(netAt(69)).toBe(96_000);
    expect(netAt(70)).toBe(60_000);
  });

  test("reversed order: primary first, spouse later (primary age 72)", () => {
    const s = normalizedScenario({
      socialSecurityAnnual: 36000,
      socialSecurityStartAge: 62,
      spouseSocialSecurityAnnual: 18000,
      spouseSocialSecurityStartAge: 70,
    });
    const { inputs } = toSimInputs(s);
    expect(inputs.incomeSchedule).toEqual([
      { amountCents: c(36_000), startAge: 62 },
      { amountCents: c(18_000), startAge: 72 },
    ]);
    const res = expectOk(calculateRetirement(s));
    const netAt = (age: number): number =>
      res.yearlyNetWithdrawals.find((w) => w.age === age)?.amount ?? -1;
    expect(netAt(61)).toBe(114_000);
    expect(netAt(62)).toBe(78_000);
    expect(netAt(71)).toBe(78_000);
    expect(netAt(72)).toBe(60_000);
  });

  test("an older spouse's benefit starts before the primary's own age", () => {
    // Spouse 56 (two years OLDER than the primary 54) claims 67:
    // the benefit starts in the year the primary turns 65.
    const s = normalizedScenario({
      spouseAge: 56,
      socialSecurityAnnual: 0,
      socialSecurityStartAge: undefined,
      spouseSocialSecurityAnnual: 18000,
      spouseSocialSecurityStartAge: 67,
    });
    const { inputs } = toSimInputs(s);
    expect(inputs.incomeSchedule).toEqual([
      { amountCents: c(18_000), startAge: 65 },
    ]);
  });
});

describe("Case F — retirement boundary", () => {
  test("income starting before retirement offsets only retired years", () => {
    const stream = { amountCents: c(36_000), startAge: 55 };
    const inputs = engineInputs({ incomeSchedule: [stream] });
    const det = simulateDetailed(inputs, zeroReturns(inputs));
    const netAt = (age: number): number =>
      det.netWithdrawals[age - inputs.currentAge] ?? -1;
    expect(netAt(54)).toBe(0);
    expect(netAt(57)).toBe(0);
    expect(netAt(58)).toBe(c(14_000));
    expect(det.balances[det.balances.length - 1]).toBe(
      handEnding(inputs, [stream]),
    );
  });

  test("income starting exactly at retirement is active in the first retired year", () => {
    const stream = { amountCents: c(36_000), startAge: 58 };
    const inputs = engineInputs({ incomeSchedule: [stream] });
    const det = simulateDetailed(inputs, zeroReturns(inputs));
    expect(det.netWithdrawals[58 - inputs.currentAge]).toBe(c(14_000));
  });

  test("income starting after retirement joins mid-plan", () => {
    const stream = { amountCents: c(36_000), startAge: 65 };
    const inputs = engineInputs({ incomeSchedule: [stream] });
    const det = simulateDetailed(inputs, zeroReturns(inputs));
    expect(det.netWithdrawals[64 - inputs.currentAge]).toBe(c(50_000));
    expect(det.netWithdrawals[65 - inputs.currentAge]).toBe(c(14_000));
    expect(det.balances[det.balances.length - 1]).toBe(
      handEnding(inputs, [stream]),
    );
  });
});

describe("Case G — planning horizon", () => {
  test("income starting in the final modeled year pays only that year", () => {
    const stream = { amountCents: c(36_000), startAge: 75 };
    const inputs = engineInputs({ incomeSchedule: [stream] });
    const det = simulateDetailed(inputs, zeroReturns(inputs));
    expect(det.netWithdrawals[74 - inputs.currentAge]).toBe(c(50_000));
    expect(det.netWithdrawals[75 - inputs.currentAge]).toBe(c(14_000));
    expect(det.balances[det.balances.length - 1]).toBe(
      handEnding(inputs, [stream]),
    );
    expect(det.balances[det.balances.length - 1]).toBe(c(136_000));
  });

  test("income starting after the horizon never pays", () => {
    const stream = { amountCents: c(36_000), startAge: 76 };
    const inputs = engineInputs({ incomeSchedule: [stream] });
    const det = simulateDetailed(inputs, zeroReturns(inputs));
    const noIncome = engineInputs();
    const noIncomeDet = simulateDetailed(noIncome, zeroReturns(noIncome));
    expect(det.balances[det.balances.length - 1]).toBe(
      noIncomeDet.balances[noIncomeDet.balances.length - 1],
    );
    expect(det.balances[det.balances.length - 1]).toBe(c(100_000));
    // And the solver ceiling does not count it either.
    expect(eventualIncomeCents(inputs)).toBe(0);
  });

  test("an explicitly zero stream contributes nothing", () => {
    const stream = { amountCents: 0, startAge: 67 };
    const inputs = engineInputs({ incomeSchedule: [stream] });
    const det = simulateDetailed(inputs, zeroReturns(inputs));
    expect(det.netWithdrawals[67 - inputs.currentAge]).toBe(c(50_000));
    expect(det.balances[det.balances.length - 1]).toBe(c(100_000));
  });
});

describe("Case H — engine parity: one schedule, every path", () => {
  const streams = [
    { amountCents: c(36_000), startAge: 70 },
    { amountCents: c(18_000), startAge: 69 },
  ];
  const inputs = engineInputs({ incomeSchedule: streams });

  test("deterministic + success-only agree with the independent recomputation", () => {
    const det = simulateDetailed(inputs, zeroReturns(inputs));
    expect(det.balances[det.balances.length - 1]).toBe(
      handEnding(inputs, streams),
    );
    expect(runNeverRunsOut(inputs, zeroReturns(inputs))).toBe(
      handNeverOut(inputs, streams),
    );
    expect(runNeverRunsOut(inputs, zeroReturns(inputs))).toBe(true);
  });

  test("Monte Carlo with zero mean and zero vol equals the deterministic path", () => {
    const mc = runMonteCarlo(inputs, 0, 0, 42, 200);
    expect(mc).not.toBeNull();
    const det = simulateDetailed(inputs, zeroReturns(inputs));
    const ending = det.balances[det.balances.length - 1] ?? 0;
    expect(mc!.neverOutSuccessRate).toBe(
      runNeverRunsOut(inputs, zeroReturns(inputs)) ? 100 : 0,
    );
    expect(mc!.p50).toBe(ending);
    expect(mc!.successRate).toBe(ending > 0 ? 100 : 0);
  });

  test("historical never-out rate equals the independent window count", () => {
    // Re-enumerate the historical windows from the published
    // table (retirementData.HISTORICAL) and the engine's own
    // real-return formula, counting runNeverRunsOut per window.
    const planYears = horizonYears(inputs.currentAge, inputs.endAge);
    const sFrac = 95 / 100;
    const allReturns = HISTORICAL.map((h) => {
      const stockReal = (1 + h.stockPct / 100) / (1 + h.cpiPct / 100) - 1;
      const bondReal = (1 + h.bondPct / 100) / (1 + h.cpiPct / 100) - 1;
      return sFrac * stockReal + (1 - sFrac) * bondReal;
    });
    const lastYear = HISTORICAL[HISTORICAL.length - 1]?.year ?? 0;
    let windows = 0;
    let neverOut = 0;
    for (let idx = 0; idx < HISTORICAL.length; idx++) {
      const sy = HISTORICAL[idx]?.year ?? 0;
      if (sy + planYears - 1 > lastYear) break;
      windows++;
      if (runNeverRunsOut(inputs, allReturns.slice(idx, idx + planYears))) {
        neverOut++;
      }
    }
    const hist = runHistorical(inputs, 95);
    expect(hist).not.toBeNull();
    expect(hist!.neverOutSuccessRate).toBe((neverOut / windows) * 100);
  });

  test("max-spending solver at zero returns returns the hand-computed maximum", () => {
    // Start $100,000, retire 58, end 67 (10 retired years),
    // income $10,000/yr from 61 (7 years). Zero returns: the
    // binding constraint is the total, 10S − $70,000 ≤ $100,000,
    // so S = $17,000 exactly; the solver steps in $100s.
    const small = engineInputs({
      startCents: c(100_000),
      spendingCents: c(50_000),
      endAge: 67,
      incomeSchedule: [{ amountCents: c(10_000), startAge: 61 }],
    });
    const solved = solveMaxSpending(small, 95, 0, 0, "montecarlo", 85, 42);
    expect(solved).not.toBeNull();
    expect(solved!.maxSpendingCents).toBe(c(17_000));
    expect(solved!.successRate).toBe(100);
    // The historical leg at the same schedule is feasible too.
    const histSolved = solveMaxSpending(
      small,
      95,
      0,
      0,
      "historical",
      85,
      42,
    );
    expect(histSolved).not.toBeNull();
    expect(histSolved!.successRate).toBeGreaterThanOrEqual(85);
  });

  test("adapter tools agree: MC deterministic leg equals calculate, max spending rises with the second stream", () => {
    const two = normalizedScenario({
      socialSecurityAnnual: 36000,
      socialSecurityStartAge: 70,
      spouseSocialSecurityAnnual: 18000,
      spouseSocialSecurityStartAge: 62,
    });
    const one = normalizedScenario({
      socialSecurityAnnual: 36000,
      socialSecurityStartAge: 70,
      spouseSocialSecurityAnnual: 0,
      spouseSocialSecurityStartAge: undefined,
    });
    const calc = expectOk(calculateRetirement(two));
    const mc = expectOk(
      runRetirementMonteCarlo(
        normalizedScenario({
          socialSecurityAnnual: 36000,
          socialSecurityStartAge: 70,
          spouseSocialSecurityAnnual: 18000,
          spouseSocialSecurityStartAge: 62,
          mcRuns: 200,
        }),
      ),
    );
    expect(mc.deterministicEndingBalance).toBe(calc.endingBalance);
    const maxTwo = expectOk(calculateMaxSpending(two));
    const maxOne = expectOk(calculateMaxSpending(one));
    expect(maxTwo.maxAnnualSpending).toBeGreaterThan(
      maxOne.maxAnnualSpending,
    );
    // This test runs calculate + a 200-run Monte Carlo + two
    // max-spending solver calls (~4–6s on this VM), over Bun's
    // 5s default per-test timeout — the allowance is the fix for
    // the flake, not a change to anything asserted.
  }, 120_000);

  test("no benefit is assumed when an amount is omitted", () => {
    const s = normalizedScenario({
      socialSecurityAnnual: 0,
      socialSecurityStartAge: undefined,
      spouseSocialSecurityAnnual: 0,
      spouseSocialSecurityStartAge: undefined,
    });
    const { inputs: sim } = toSimInputs(s);
    expect(sim.incomeSchedule).toBeUndefined();
    expect(sim.extraIncomeCents).toBe(0);
    expect(sim.extraIncomeStartAge).toBeNull();
    expect(incomeCentsAt(sim, 70)).toBe(0);
  });

  test("two-stream pricing is deterministic across repeated calls", () => {
    const s = normalizedScenario({
      socialSecurityAnnual: 36000,
      socialSecurityStartAge: 70,
      spouseSocialSecurityAnnual: 18000,
      spouseSocialSecurityStartAge: 62,
    });
    const first = calculateRetirement(s);
    const second = calculateRetirement(s);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
