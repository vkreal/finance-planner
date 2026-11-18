// Independent verification + solver maximality tests
// (Engine Review 2, E2-V1 / E2-S1).
//
// Every expectation here comes from HAND arithmetic (the small
// deterministic cases, worked in the test's own comments) or from
// the independent reference implementation in
// retirementIndependentCheck.ts — NEVER copied from engine output.
// The test compares that reference against the engine on pinned
// scenarios built from the fictional sample household
// (server/src/sampleHousehold.ts) plus small synthetic edge cases
// ($100 / $0 portfolios, $0–$1.1M incomes) of the same kind the
// existing fixture suite already uses for boundary pins.
//
// What is verified:
//   1. Seeded RNG / normal transform / return units — through exact
//      agreement between the reference Monte Carlo and the engine's
//      on the same seeds, plus a distribution sanity check on the
//      reference normal draws and flat-return hand cases.
//   2. Balance evolution — hand-computed balances: spending-before-
//      growth ordering, SS income offsets (primary + spouse
//      combined), depletion with no rescue from later income,
//      extreme negative returns, the inclusive end-age convention.
//   3. Aggregates — never-runs-out and ending-balance success
//      counts, median, p10/p50/p90, annual chart percentiles,
//      percent-strategy spending variability, ref vs engine exact.
//   4. Solver maximality — per strategy, the returned spending is
//      feasible by the reference oracle and the next $100 step is
//      not, unless a documented cap applies; guardrails by full
//      independent grid enumeration (no monotonicity assumed);
//      exact threshold boundaries and ties; the infeasible-at-zero
//      branch (direct call, target 101) and the reachability claim
//      that at $0 every run succeeds through validated inputs.

import { describe, expect, test } from "bun:test";
import {
  horizonYears,
  runHistorical,
  runMonteCarlo,
  runNeverRunsOut,
  simulateDetailed,
  solveMaxSpending,
  type SimInputs,
  type SolverSolutionStatus,
} from "./retirementEngines";
import {
  refFeasible,
  refMedianOf,
  refMulberry32,
  refNeverOutRateAt,
  refNeverRunsOut,
  refNormalRandom,
  refPercentile,
  refRunHistorical,
  refRunMonteCarlo,
  refSimulateDetailed,
  refSolveMaxSpending,
  type RefInputs,
} from "./retirementIndependentCheck";
import {
  SAMPLE_ANNUAL_SPENDING_CENTS,
  SAMPLE_END_AGE,
  SAMPLE_RETIREMENT_AGE,
  SAMPLE_SS_PRIMARY_CENTS,
  SAMPLE_SS_PRIMARY_START_AGE,
  SAMPLE_SS_SPOUSE_CENTS,
  SAMPLE_TAXABLE_CENTS,
} from "./sampleHousehold";

// The sample household as retirement inputs: a $2,000,000
// portfolio, $180,000/yr spending, age 58 in 2026, retiring at
// 62, end age 95, 75% stocks, 5% expected real return, 18%
// volatility, $48,000/yr Social Security from 67. One object
// serves both implementations — their input shapes are the same
// fields in the same units (cents, ages, percents).
function sampleInputs(over: Partial<SimInputs> = {}): SimInputs {
  return {
    startCents: SAMPLE_TAXABLE_CENTS,
    spendingCents: SAMPLE_ANNUAL_SPENDING_CENTS,
    currentAge: 58,
    retirementAge: SAMPLE_RETIREMENT_AGE,
    endAge: SAMPLE_END_AGE,
    extraIncomeCents: SAMPLE_SS_PRIMARY_CENTS,
    extraIncomeStartAge: SAMPLE_SS_PRIMARY_START_AGE,
    strategy: "constant",
    percentOfPortfolio: 5,
    guardrailsCutPct: 120,
    guardrailsRaisePct: 80,
    guardrailsAdjustmentPct: 10,
    phaseStartAge: 75,
    phaseDeclinePct: 1,
    ...over,
  };
}
const asRef = (inputs: SimInputs): RefInputs => inputs as unknown as RefInputs;

const STOCKS = 75;
const EXPECTED = 0.05;
const VOL = 0.18;

function expectSolverEqual(
  engine: ReturnType<typeof solveMaxSpending>,
  ref: ReturnType<typeof refSolveMaxSpending>,
  label: string,
): void {
  expect(engine, `${label}: engine solver returned null`).not.toBeNull();
  expect(ref, `${label}: reference solver returned null`).not.toBeNull();
  if (engine === null || ref === null) return;
  expect(engine.maxSpendingCents, `${label} maxSpendingCents`).toBe(
    ref.maxSpendingCents,
  );
  expect(engine.successRate, `${label} successRate`).toBe(ref.successRate);
  expect(Math.round(engine.medianEnding), `${label} medianEnding`).toBe(
    Math.round(ref.medianEnding),
  );
  expect(engine.percent, `${label} percent`).toBe(ref.percent);
  expect(engine.approximate, `${label} approximate`).toBe(ref.approximate);
  expect(engine.targetSuccessRate, `${label} targetSuccessRate`).toBe(
    ref.targetSuccessRate,
  );
  expect(engine.achievedSuccessRate, `${label} achievedSuccessRate`).toBe(
    ref.achievedSuccessRate,
  );
  expect(engine.targetAchieved, `${label} targetAchieved`).toBe(
    ref.targetAchieved,
  );
  expect(engine.solutionStatus, `${label} solutionStatus`).toBe(
    ref.solutionStatus,
  );
}

describe("reference RNG and normal transform", () => {
  test("mulberry32 is deterministic per seed, in [0,1), and differs across seeds", () => {
    const a = refMulberry32(12345);
    const b = refMulberry32(12345);
    const c = refMulberry32(777);
    const drawsA: number[] = [];
    for (let i = 0; i < 100; i++) {
      const v = a();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      drawsA.push(v);
      expect(b()).toBe(v);
    }
    expect(c()).not.toBe(drawsA[0]);
  });

  test("Box-Muller normals have ~zero mean and ~unit spread (sanity, not a success-rate substitute)", () => {
    const rng = refMulberry32(999);
    const n = 20000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const v = refNormalRandom(rng);
      sum += v;
      sumSq += v * v;
    }
    const mean = sum / n;
    const sd = Math.sqrt(sumSq / n - mean * mean);
    expect(Math.abs(mean)).toBeLessThan(0.05);
    expect(Math.abs(sd - 1)).toBeLessThan(0.05);
  });

  test("hand percentile / median values", () => {
    expect(refPercentile([], 50)).toBe(0);
    expect(refMedianOf([])).toBe(0);
    const sorted = [10, 20, 30, 40];
    // sorted[floor(p/100 * 4)] clamped: p10 -> idx 0, p25 -> 1, p50 -> 2, p90 -> 3.
    expect(refPercentile(sorted, 10)).toBe(10);
    expect(refPercentile(sorted, 25)).toBe(20);
    expect(refPercentile(sorted, 50)).toBe(30);
    expect(refPercentile(sorted, 90)).toBe(40);
    expect(refPercentile(sorted, 100)).toBe(40);
    expect(refMedianOf(sorted)).toBe(25);
    expect(refMedianOf([10, 20, 30])).toBe(20);
  });
});

describe("hand-computed balance evolution (flat returns, no RNG)", () => {
  test("spending before growth, inclusive end age: ($100,000-$10,000)x1.05 thrice", () => {
    // Start $100,000, spend $10,000/yr, retire at 55, end 57 (3
    // priced years), flat +5%: year 1 (100,000-10,000)x1.05 =
    // 94,500; year 2 (94,500-10,000)x1.05 = 88,725; year 3
    // (88,725-10,000)x1.05 = 82,661.25. The end-age year's return
    // is applied (inclusive horizon): the final balance is the
    // after-year-3 figure, and balances has 4 entries (years+1).
    const inputs = sampleInputs({
      startCents: 10_000_000,
      spendingCents: 1_000_000,
      currentAge: 55,
      retirementAge: 55,
      endAge: 57,
      extraIncomeCents: 0,
      extraIncomeStartAge: null,
    });
    const expected = [10_000_000, 9_450_000, 8_872_500, 8_266_125];
    const eng = simulateDetailed(inputs, [0.05, 0.05, 0.05]);
    const ref = refSimulateDetailed(asRef(inputs), [0.05, 0.05, 0.05]);
    expect(eng.balances).toEqual(expected);
    expect(ref.balances).toEqual(expected);
    expect(eng.balances.length).toBe(57 - 55 + 2);
    expect(horizonYears(55, 57)).toBe(3);
  });

  test("spending-before-growth ordering: one year at +10% is $99,000, not $100,000", () => {
    // ($100,000 - $10,000) x 1.10 = $99,000. Growth-first would
    // give $100,000 x 1.10 - $10,000 = $100,000 — the ordering
    // is pinned by the $1,000 difference.
    const inputs = sampleInputs({
      startCents: 10_000_000,
      spendingCents: 1_000_000,
      currentAge: 55,
      retirementAge: 55,
      endAge: 55,
      extraIncomeCents: 0,
      extraIncomeStartAge: null,
    });
    expect(simulateDetailed(inputs, [0.1]).balances).toEqual([
      10_000_000, 9_900_000,
    ]);
    expect(refSimulateDetailed(asRef(inputs), [0.1]).balances).toEqual([
      10_000_000, 9_900_000,
    ]);
  });

  test("income offset: a $25,000/yr income against $20,000/yr spending adds $5,000/yr", () => {
    // Start $45,000, spend $20,000, income $25,000 from 55, 0%
    // return, ages 55-57: net -$5,000/yr, so 45,000 -> 50,000 ->
    // 55,000 -> 60,000.
    const inputs = sampleInputs({
      startCents: 4_500_000,
      spendingCents: 2_000_000,
      currentAge: 55,
      retirementAge: 55,
      endAge: 57,
      extraIncomeCents: 2_500_000,
      extraIncomeStartAge: 55,
    });
    const expected = [4_500_000, 5_000_000, 5_500_000, 6_000_000];
    expect(simulateDetailed(inputs, [0, 0, 0]).balances).toEqual(expected);
    expect(refSimulateDetailed(asRef(inputs), [0, 0, 0]).balances).toEqual(
      expected,
    );
  });

  test("combined Social Security: primary $48,000 + spouse $30,000 = $78,000/yr from 67", () => {
    // Sample household SS anchors, combined into the one extra
    // income the engines price. Start $2,000,000, spend $100,000,
    // ages 66-67, 0% return: age 66 (no income yet) nets $100,000
    // -> $1,900,000; age 67 nets $100,000 - $78,000 = $22,000 ->
    // $1,878,000. The income starts only at its start age.
    const inputs = sampleInputs({
      spendingCents: 10_000_000,
      currentAge: 66,
      retirementAge: 66,
      endAge: 67,
      extraIncomeCents: SAMPLE_SS_PRIMARY_CENTS + SAMPLE_SS_SPOUSE_CENTS,
      extraIncomeStartAge: 67,
    });
    const expected = [200_000_000, 190_000_000, 187_800_000];
    expect(simulateDetailed(inputs, [0, 0]).balances).toEqual(expected);
    expect(refSimulateDetailed(asRef(inputs), [0, 0]).balances).toEqual(
      expected,
    );
    expect(SAMPLE_SS_PRIMARY_CENTS + SAMPLE_SS_SPOUSE_CENTS).toBe(7_800_000);
  });

  test("depletion with later refill: ending positive, still a failure", () => {
    // Start $10,000, spend $20,000/yr, $50,000/yr income from 56,
    // 0% return, ages 55-57. Age 55: the $20,000 withdrawal exceeds
    // the $10,000 balance — the run fails on the spot. Age 56:
    // net -$30,000 refills to $30,000; age 57: $60,000. The ending
    // balance is $60,000 and positive, but never-runs-out is false
    // in both implementations: no shortfall after replenishment.
    const inputs = sampleInputs({
      startCents: 1_000_000,
      spendingCents: 2_000_000,
      currentAge: 55,
      retirementAge: 55,
      endAge: 57,
      extraIncomeCents: 5_000_000,
      extraIncomeStartAge: 56,
    });
    const expected = [1_000_000, 0, 3_000_000, 6_000_000];
    expect(simulateDetailed(inputs, [0, 0, 0]).balances).toEqual(expected);
    expect(refSimulateDetailed(asRef(inputs), [0, 0, 0]).balances).toEqual(
      expected,
    );
    expect(runNeverRunsOut(inputs, [0, 0, 0])).toBe(false);
    expect(refNeverRunsOut(asRef(inputs), [0, 0, 0])).toBe(false);
  });

  test("extreme negative return (-150%) floors the balance at $0 and never revives it by returns alone", () => {
    // Start $100,000, spend $10,000, retire at 57, flat -150%
    // returns, ages 55-57. Age 55 (pre-retirement): $100,000 x
    // (1 - 1.5) = -$50,000 -> floored to $0. Age 56: $0. Age 57:
    // the $10,000 withdrawal exceeds $0 — failure — and the
    // balance stays $0.
    const inputs = sampleInputs({
      startCents: 10_000_000,
      spendingCents: 1_000_000,
      currentAge: 55,
      retirementAge: 57,
      endAge: 57,
      extraIncomeCents: 0,
      extraIncomeStartAge: null,
    });
    const expected = [10_000_000, 0, 0, 0];
    // The engine can report a negative zero here: after a -150%
    // year on a $0 balance, 0 x (1 - 1.5) is -0, and -0 < 0 is
    // false so the floor leaves it. Numerically -0 === 0, so the
    // comparison normalizes it (v + 0 turns -0 into +0).
    const norm = (xs: number[]) => xs.map((v) => v + 0);
    expect(norm(simulateDetailed(inputs, [-1.5, -1.5, -1.5]).balances)).toEqual(
      expected,
    );
    expect(
      norm(refSimulateDetailed(asRef(inputs), [-1.5, -1.5, -1.5]).balances),
    ).toEqual(expected);
    expect(runNeverRunsOut(inputs, [-1.5, -1.5, -1.5])).toBe(false);
    expect(refNeverRunsOut(asRef(inputs), [-1.5, -1.5, -1.5])).toBe(false);
  });
});

describe("reference vs engine: historical and Monte Carlo aggregates", () => {
  const strategies: SimInputs["strategy"][] = [
    "constant",
    "percent",
    "guardrails",
    "phased",
  ];
  for (const strategy of strategies) {
    test(`historical aggregates agree exactly: ${strategy} (sample household)`, () => {
      const inputs = sampleInputs({ strategy });
      const eng = runHistorical(inputs, STOCKS);
      const ref = refRunHistorical(asRef(inputs), STOCKS);
      expect(eng).not.toBeNull();
      expect(ref).not.toBeNull();
      if (!eng || !ref) return;
      expect(eng.count).toBe(ref.count);
      expect(eng.successRate).toBe(ref.successRate);
      expect(eng.neverOutSuccessRate).toBe(ref.neverOutSuccessRate);
      expect(eng.medianEnding).toBe(ref.medianEnding);
      expect(eng.worstEnding).toBe(ref.worstEnding);
      expect(eng.worstStartYear).toBe(ref.worstStartYear);
      for (const age of [62, 75, 95]) {
        expect(eng.chart[age - 58]?.median).toBe(
          (ref.chartMedianByAge[age] ?? 0) / 100,
        );
      }
      expect(eng.lowestSpending).toBe(ref.lowestSpending);
      expect(eng.averageSpending).toBe(ref.averageSpending);
      expect(eng.medianFinalYearSpending).toBe(ref.medianFinalYearSpending);
      expect(eng.medianFirstRetiredYearSpending).toBe(
        ref.medianFirstRetiredYearSpending,
      );
    });

    for (const seed of [12345, 777]) {
      test(`Monte Carlo aggregates agree exactly: ${strategy}, seed ${seed} (sample household)`, () => {
        const inputs = sampleInputs({ strategy });
        const eng = runMonteCarlo(inputs, EXPECTED, VOL, seed, 1000);
        const ref = refRunMonteCarlo(asRef(inputs), EXPECTED, VOL, seed, 1000);
        expect(eng).not.toBeNull();
        expect(ref).not.toBeNull();
        if (!eng || !ref) return;
        expect(eng.successRate).toBe(ref.successRate);
        expect(eng.neverOutSuccessRate).toBe(ref.neverOutSuccessRate);
        expect(eng.p10).toBe(ref.p10);
        expect(eng.p50).toBe(ref.p50);
        expect(eng.p90).toBe(ref.p90);
        expect(eng.chart.length).toBe(Object.keys(ref.chartByAge).length);
        for (const age of [58, 62, 75, 95]) {
          const row = eng.chart[age - 58];
          const r = ref.chartByAge[age];
          expect(row).toBeDefined();
          if (!row || !r) continue;
          expect(row.p10).toBe(r.p10 / 100);
          expect(row.median).toBe(r.p50 / 100);
          expect(row.p90).toBe(r.p90 / 100);
        }
        expect(eng.lowestSpending).toBe(ref.lowestSpending);
        expect(eng.averageSpending).toBe(ref.averageSpending);
        expect(eng.medianFinalYearSpending).toBe(
          ref.medianFinalYearSpending,
        );
        expect(eng.medianFirstRetiredYearSpending).toBe(
          ref.medianFirstRetiredYearSpending,
        );
      });
    }
  }

  test("zero volatility: every Monte Carlo run is the same path, p10 == p50 == p90", () => {
    const inputs = sampleInputs({});
    const eng = runMonteCarlo(inputs, EXPECTED, 0, 5, 1000);
    const ref = refRunMonteCarlo(asRef(inputs), EXPECTED, 0, 5, 1000);
    expect(eng).not.toBeNull();
    expect(ref).not.toBeNull();
    if (!eng || !ref) return;
    expect(eng.p10).toBe(eng.p50);
    expect(eng.p50).toBe(eng.p90);
    expect(ref.p10).toBe(ref.p50);
    expect(ref.p50).toBe(ref.p90);
    expect(eng.p50).toBe(ref.p50);
    expect(eng.successRate).toBe(ref.successRate);
    // The single shared path is the flat-return path.
    const flat = refSimulateDetailed(
      asRef(inputs),
      Array.from({ length: 95 - 58 + 1 }, () => EXPECTED),
    );
    expect(eng.p50).toBe(flat.balances[flat.balances.length - 1] ?? 0);
  });
});

describe("solver agreement and maximality", () => {
  const STEP = 10000; // $100 in cents

  function maximality(
    label: string,
    inputs: SimInputs,
    target: number,
    engine: "historical" | "montecarlo",
    seed = 12345,
  ): void {
    const eng = solveMaxSpending(inputs, STOCKS, EXPECTED, VOL, engine, target, seed);
    const ref = refSolveMaxSpending(asRef(inputs), STOCKS, EXPECTED, VOL, engine, target, seed);
    expectSolverEqual(eng, ref, label);
    if (!eng || !ref) return;
    expect(eng.solutionStatus).toBe(ref.solutionStatus);
    // Exact feasibility of the selected candidate, by the
    // independent oracle.
    const atWinner =
      inputs.strategy === "percent"
        ? refFeasible(
            { ...asRef(inputs), percentOfPortfolio: eng.percent ?? 0 },
            STOCKS, EXPECTED, VOL, engine, target, seed,
          )
        : refFeasible(
            { ...asRef(inputs), spendingCents: eng.maxSpendingCents },
            STOCKS, EXPECTED, VOL, engine, target, seed,
          );
    expect(atWinner, `${label}: returned spending must be feasible`).toBe(true);
    if (eng.solutionStatus === "capped") return; // the cap binds: no next step exists to test
    if (inputs.strategy === "percent") {
      // Percent: the next step is the next percent step.
      const maxSteps = Math.floor((inputs.startCents * 0.3) / STEP);
      const k = Math.round(((eng.percent ?? 0) * inputs.startCents) / 100 / STEP);
      expect(k).toBeLessThan(maxSteps);
      const nextPct = ((k + 1) * STEP * 100) / inputs.startCents;
      expect(
        refFeasible(
          { ...asRef(inputs), percentOfPortfolio: nextPct },
          STOCKS, EXPECTED, VOL, engine, target, seed,
        ),
        `${label}: next percent step must be infeasible`,
      ).toBe(false);
      return;
    }
    // Constant / phased / guardrails: the next $100 step is
    // infeasible (guardrails included — the scan's maximum, not a
    // binary-search boundary, so this also catches a missed
    // higher feasible step just above the returned one).
    expect(
      refFeasible(
        { ...asRef(inputs), spendingCents: eng.maxSpendingCents + STEP },
        STOCKS, EXPECTED, VOL, engine, target, seed,
      ),
      `${label}: next $100 step must be infeasible`,
    ).toBe(false);
  }

  test("constant, historical, 95% (sample household)", () => {
    maximality("hist constant 95", sampleInputs({}), 95, "historical");
  });
  test("constant, Monte Carlo, 85% (sample household)", () => {
    maximality("mc constant 85", sampleInputs({}), 85, "montecarlo");
  }, 60_000);
  test("phased, historical, 95% (sample household)", () => {
    maximality("hist phased 95", sampleInputs({ strategy: "phased" }), 95, "historical");
  });
  test("phased, Monte Carlo, 85% (sample household)", () => {
    maximality("mc phased 85", sampleInputs({ strategy: "phased" }), 85, "montecarlo");
  }, 60_000);
  test("percent, historical, 95% (sample household) — 30% cap binds", () => {
    const eng = solveMaxSpending(sampleInputs({ strategy: "percent" }), STOCKS, EXPECTED, VOL, "historical", 95);
    const ref = refSolveMaxSpending(asRef(sampleInputs({ strategy: "percent" })), STOCKS, EXPECTED, VOL, "historical", 95);
    expectSolverEqual(eng, ref, "hist percent 95");
    expect(eng?.solutionStatus).toBe("capped");
    expect(eng?.percent).toBe(30);
    // Percent semantics: the dollar figure is the percent of the
    // STARTING portfolio — the first retired year's spending.
    expect(eng?.maxSpendingCents).toBe(60_000_000);
  });
  test("percent, Monte Carlo, 85% (sample household) — 30% cap binds", () => {
    const eng = solveMaxSpending(sampleInputs({ strategy: "percent" }), STOCKS, EXPECTED, VOL, "montecarlo", 85, 12345);
    const ref = refSolveMaxSpending(asRef(sampleInputs({ strategy: "percent" })), STOCKS, EXPECTED, VOL, "montecarlo", 85, 12345);
    expectSolverEqual(eng, ref, "mc percent 85");
    expect(eng?.solutionStatus).toBe("capped");
    expect(eng?.percent).toBe(30);
  });
  test("guardrails, historical, 95% (sample household)", () => {
    maximality("hist guardrails 95", sampleInputs({ strategy: "guardrails" }), 95, "historical");
  });
  test("guardrails, Monte Carlo, 85% (sample household)", () => {
    maximality("mc guardrails 85", sampleInputs({ strategy: "guardrails" }), 85, "montecarlo");
  }, 180_000);

  test("guardrails full-grid enumeration on a bounded scenario (no monotonicity assumed)", () => {
    // Short horizon, $500,000 portfolio, Monte Carlo seed 12345,
    // 85% target: enumerate EVERY $100 step from $0 to the proven
    // ceiling with the independent oracle and take the maximum
    // feasible step. The engine's scan winner must equal it.
    const inputs = sampleInputs({
      startCents: 50_000_000,
      spendingCents: 10_000_000,
      currentAge: 60,
      retirementAge: 60,
      endAge: 65,
      extraIncomeCents: 0,
      extraIncomeStartAge: null,
      strategy: "guardrails",
    });
    const eng = solveMaxSpending(inputs, STOCKS, EXPECTED, VOL, "montecarlo", 85, 12345);
    const ref = refSolveMaxSpending(asRef(inputs), STOCKS, EXPECTED, VOL, "montecarlo", 85, 12345);
    expectSolverEqual(eng, ref, "mc guardrails bounded grid");
    expect(eng).not.toBeNull();
    if (!eng) return;
    // Independent ceiling: best balance at retirement (here the
    // starting balance — retirement is immediate) plus eventual
    // income, i.e. $500,000 -> 5,000 steps.
    let gridMax = 0;
    for (let k = 0; k <= 5000; k++) {
      if (
        refFeasible(
          { ...asRef(inputs), spendingCents: k * STEP },
          STOCKS, EXPECTED, VOL, "montecarlo", 85, 12345,
        )
      ) {
        gridMax = k;
      }
    }
    expect(eng.maxSpendingCents).toBe(gridMax * STEP);
    expect(eng.solutionStatus).toBe("feasible");
  }, 120_000);

  test("guardrails success is NOT monotone in spending (reference counts)", () => {
    // The documented $3M-portfolio shape, priced by the reference
    // on the historical engine: the success count DIPS then RISES
    // as spending grows — 52 of 58 at $246,000, 50 at $248,000,
    // 51 at $248,400 — so no binary search could find the
    // guardrails maximum, and the exhaustive scan is required.
    // The engine's historical rates at the same spendings must
    // match the reference counts exactly.
    const inputs = sampleInputs({
      startCents: 300_000_000,
      spendingCents: 10_000_000,
      currentAge: 55,
      retirementAge: 57,
      endAge: 95,
      extraIncomeCents: 0,
      extraIncomeStartAge: null,
      strategy: "guardrails",
    });
    const counts: Record<number, number> = {};
    for (const spend of [24_600_000, 24_800_000, 24_840_000]) {
      const r = refNeverOutRateAt({ ...asRef(inputs), spendingCents: spend }, STOCKS, EXPECTED, VOL, "historical", 12345);
      counts[spend] = r.successes;
      const eng = runHistorical({ ...inputs, spendingCents: spend }, STOCKS);
      expect(eng).not.toBeNull();
      expect(eng?.neverOutSuccessRate).toBe(r.successRate);
    }
    expect(counts[24_600_000]).toBe(52);
    expect(counts[24_800_000]).toBe(50);
    expect(counts[24_840_000]).toBe(51);
    expect(counts[24_800_000]!).toBeLessThan(counts[24_840_000]!);
  });

  test("guardrails $3M witness: historical 85% solver max is the full-grid max, with the corrected tie", () => {
    // The E2 non-monotonicity witness, pinned with the corrected
    // tie. The recorded "850 == needed, next step 848" does not
    // re-derive on this shape — it is the sample household's
    // Monte Carlo tie (the 850 half pinned exactly by the
    // "threshold boundary and tie" test below, the 848 next step
    // stated in that test's comment and bounded by its assertion);
    // on the witness itself the tie is 50/58, next step 49.
    // Shape: $3,000,000 portfolio, ages 55-95, retire
    // at 60, no income, guardrails, 75% stocks, 5% expected real,
    // 18% volatility. Target 85%. (Distinct from the retire-57
    // shape in the test above.)
    const inputs = sampleInputs({
      startCents: 300_000_000,
      spendingCents: 10_000_000,
      currentAge: 55,
      retirementAge: 60,
      endAge: 95,
      extraIncomeCents: 0,
      extraIncomeStartAge: null,
      strategy: "guardrails",
    });

    // 1) Solver agreement: engine and reference both return
    // $297,600, feasible.
    const eng = solveMaxSpending(inputs, STOCKS, EXPECTED, VOL, "historical", 85, 12345);
    const ref = refSolveMaxSpending(asRef(inputs), STOCKS, EXPECTED, VOL, "historical", 85, 12345);
    expectSolverEqual(eng, ref, "hist85 $3M witness");
    expect(eng?.maxSpendingCents).toBe(29_760_000);
    expect(eng?.solutionStatus).toBe("feasible");

    // 2) Full-grid enumeration to the proven $6,000,000 ceiling
    // (max(2 x $3M, $1M)): the grid max is $297,600 and no
    // feasible step hides above it.
    let gridMax = 0;
    for (let k = 0; k <= 60000; k++) {
      if (refFeasible({ ...asRef(inputs), spendingCents: k * STEP }, STOCKS, EXPECTED, VOL, "historical", 85, 12345)) {
        gridMax = k;
      }
    }
    expect(gridMax * STEP).toBe(29_760_000);

    // 3) The gap structure below the max: exactly 8 maximal
    // infeasible runs (24 infeasible $100 steps), so a binary
    // search would stop at the first gap, $290,600 — $7,000
    // below the true max.
    const infeasible: number[] = [];
    for (let k = 0; k <= 2976; k++) {
      if (!refFeasible({ ...asRef(inputs), spendingCents: k * STEP }, STOCKS, EXPECTED, VOL, "historical", 85, 12345)) {
        infeasible.push(k * STEP);
      }
    }
    expect(infeasible.length).toBe(24);
    const gaps: Array<[number, number]> = [];
    for (const c of infeasible) {
      const last = gaps[gaps.length - 1];
      if (last && c === last[1] + STEP) last[1] = c;
      else gaps.push([c, c]);
    }
    expect(gaps).toEqual([
      [29_060_000, 29_060_000],
      [29_090_000, 29_090_000],
      [29_110_000, 29_120_000],
      [29_150_000, 29_190_000],
      [29_310_000, 29_310_000],
      [29_540_000, 29_590_000],
      [29_610_000, 29_610_000],
      [29_630_000, 29_690_000],
    ]);

    // 4) The first gap: $290,600 is infeasible (49/58) and
    // $290,700 is feasible (50/58) — the step a binary search
    // would stop at.
    const lo = refNeverOutRateAt({ ...asRef(inputs), spendingCents: 29_060_000 }, STOCKS, EXPECTED, VOL, "historical", 12345);
    expect(lo.runs).toBe(58);
    expect(lo.successes).toBe(49);
    expect(lo.successRate).toBeLessThan(85);
    const hi = refNeverOutRateAt({ ...asRef(inputs), spendingCents: 29_070_000 }, STOCKS, EXPECTED, VOL, "historical", 12345);
    expect(hi.successes).toBe(50);
    expect(hi.successRate).toBeGreaterThanOrEqual(85);

    // 5) The corrected tie at the max: 58 historical runs, needed
    // = ceil(0.85 x 58 - 1e-9) = 50; the max $297,600 scores
    // exactly 50, and the next $100 step scores 49. The engine's
    // own rates agree exactly.
    const atMax = refNeverOutRateAt({ ...asRef(inputs), spendingCents: 29_760_000 }, STOCKS, EXPECTED, VOL, "historical", 12345);
    expect(atMax.runs).toBe(58);
    expect(atMax.successes).toBe(50);
    const needed = Math.ceil(0.85 * atMax.runs - 1e-9);
    expect(needed).toBe(50);
    expect(atMax.successes).toBe(needed);
    const atNext = refNeverOutRateAt({ ...asRef(inputs), spendingCents: 29_770_000 }, STOCKS, EXPECTED, VOL, "historical", 12345);
    expect(atNext.successes).toBe(49);
    const engMax = runHistorical({ ...inputs, spendingCents: 29_760_000 }, STOCKS);
    const engNext = runHistorical({ ...inputs, spendingCents: 29_770_000 }, STOCKS);
    expect(engMax?.neverOutSuccessRate).toBe(atMax.successRate);
    expect(engNext?.neverOutSuccessRate).toBe(atNext.successRate);

    // 6) The Monte Carlo leg of the same shape has its own max
    // and its own tie: $176,200 scores exactly 850/1,000, and
    // the next $100 step scores 849. (This is the real 850
    // figure on this shape — the recorded 850/848 pair belongs
    // to the sample household, pinned below.)
    const mcEng = solveMaxSpending(inputs, STOCKS, EXPECTED, VOL, "montecarlo", 85, 12345);
    const mcRef = refSolveMaxSpending(asRef(inputs), STOCKS, EXPECTED, VOL, "montecarlo", 85, 12345);
    expectSolverEqual(mcEng, mcRef, "mc85 $3M witness");
    expect(mcEng?.maxSpendingCents).toBe(17_620_000);
    expect(mcEng?.solutionStatus).toBe("feasible");
    const mcMax = refNeverOutRateAt({ ...asRef(inputs), spendingCents: 17_620_000 }, STOCKS, EXPECTED, VOL, "montecarlo", 12345);
    expect(mcMax.runs).toBe(1000);
    expect(mcMax.successes).toBe(850);
    const mcNext = refNeverOutRateAt({ ...asRef(inputs), spendingCents: 17_630_000 }, STOCKS, EXPECTED, VOL, "montecarlo", 12345);
    expect(mcNext.successes).toBe(849);
    const engMcMax = runMonteCarlo({ ...inputs, spendingCents: 17_620_000 }, EXPECTED, VOL, 12345, 1000);
    const engMcNext = runMonteCarlo({ ...inputs, spendingCents: 17_630_000 }, EXPECTED, VOL, 12345, 1000);
    expect(engMcMax?.neverOutSuccessRate).toBe(mcMax.successRate);
    expect(engMcNext?.neverOutSuccessRate).toBe(mcNext.successRate);
  }, 180_000);

  test("threshold boundary and tie: the 95% historical solve sits exactly on the needed count", () => {
    // The sample plan prices 38 years (58 to 95), so 61 historical
    // runs fit (1928-1988); 95% target: needed = ceil(0.95*61 -
    // 1e-9) = 58 successes. The solved $127,600 scores 58/61 =
    // 95.1% — exactly the needed count, the boundary tie — and
    // the next $100 step scores 57.
    const inputs = sampleInputs({});
    const at = refNeverOutRateAt({ ...asRef(inputs), spendingCents: 12_760_000 }, STOCKS, EXPECTED, VOL, "historical", 12345);
    expect(at.runs).toBe(61);
    expect(at.successes).toBe(58);
    expect(at.successRate).toBeGreaterThanOrEqual(95);
    const next = refNeverOutRateAt({ ...asRef(inputs), spendingCents: 12_770_000 }, STOCKS, EXPECTED, VOL, "historical", 12345);
    expect(next.successes).toBeLessThan(58);
    // Same tie on Monte Carlo: 1,000 runs, 85% target, needed
    // 850 — the sample plan's solved $93,800 scores exactly
    // 850/1,000, and the next $100 step scores 848.
    const mcAt = refNeverOutRateAt({ ...asRef(inputs), spendingCents: 9_380_000 }, STOCKS, EXPECTED, VOL, "montecarlo", 12345);
    expect(mcAt.runs).toBe(1000);
    expect(mcAt.successes).toBe(850);
    const mcNext = refNeverOutRateAt({ ...asRef(inputs), spendingCents: 9_390_000 }, STOCKS, EXPECTED, VOL, "montecarlo", 12345);
    expect(mcNext.successes).toBeLessThan(850);
  });

  test("feasible_at_zero: a $100 portfolio over 40 years solves to $0 that DOES meet the target", () => {
    const inputs = sampleInputs({
      startCents: 10000,
      spendingCents: 10000,
      currentAge: 55,
      retirementAge: 55,
      endAge: 95,
      extraIncomeCents: 0,
      extraIncomeStartAge: null,
    });
    maximality("hist feasible-at-zero", inputs, 85, "historical");
    const eng = solveMaxSpending(inputs, STOCKS, EXPECTED, VOL, "historical", 85);
    expect(eng?.solutionStatus).toBe("feasible_at_zero");
    expect(eng?.targetAchieved).toBe(true);
    expect(Math.round(eng?.medianEnding ?? 0)).toBe(93034);
  });

  test("capped constant: huge income, short horizon — the $1,000,000/yr search cap binds", () => {
    // $100,000 portfolio, $1,200,000/yr income from 60, ages
    // 60-61, 0% return/volatility: the search cap is
    // max(2 x $100,000, $1,000,000) = $1,000,000/yr, and the
    // income funds it with room to spare, so the cap itself is
    // the answer — not a proven maximum above it.
    const inputs = sampleInputs({
      startCents: 10_000_000,
      spendingCents: 10_000_000,
      currentAge: 60,
      retirementAge: 60,
      endAge: 61,
      extraIncomeCents: 120_000_000,
      extraIncomeStartAge: 60,
    });
    const eng = solveMaxSpending(inputs, STOCKS, 0, 0, "montecarlo", 85, 12345);
    const ref = refSolveMaxSpending(asRef(inputs), STOCKS, 0, 0, "montecarlo", 85, 12345);
    expectSolverEqual(eng, ref, "mc capped constant");
    expect(eng?.solutionStatus).toBe("capped");
    expect(eng?.maxSpendingCents).toBe(100_000_000);
    expect(eng?.targetAchieved).toBe(true);
  });

  test("target 0 solves to the cap (every spending meets a 0% target)", () => {
    const eng = solveMaxSpending(sampleInputs({}), STOCKS, EXPECTED, VOL, "historical", 0);
    expect(eng?.solutionStatus).toBe("capped");
    expect(eng?.targetAchieved).toBe(true);
  });

  test("infeasible_at_zero: direct call with target 101 — even $0 falls short", () => {
    const inputs = sampleInputs({});
    const eng = solveMaxSpending(inputs, STOCKS, EXPECTED, VOL, "historical", 101);
    const ref = refSolveMaxSpending(asRef(inputs), STOCKS, EXPECTED, VOL, "historical", 101);
    expectSolverEqual(eng, ref, "hist infeasible target 101");
    expect(eng?.maxSpendingCents).toBe(0);
    expect(eng?.solutionStatus).toBe("infeasible_at_zero");
    expect(eng?.targetAchieved).toBe(false);
    expect(eng?.targetSuccessRate).toBe(101);
    expect(eng?.achievedSuccessRate).toBe(100);
    expect(Math.round(eng?.medianEnding ?? 0)).toBe(2_047_619_886);
  });

  test("reachability: at $0 every run succeeds through validated inputs, so infeasible needs target > 100", () => {
    // The coordinator's reachability claim, verified through the
    // reference: on the sample plan and the tiny-portfolio plan,
    // the $0 never-runs-out rate is 100% on both engines — a $0
    // net withdrawal can never exceed the balance.
    for (const inputs of [
      sampleInputs({}),
      sampleInputs({
        startCents: 10000,
        currentAge: 55,
        retirementAge: 55,
        endAge: 95,
        extraIncomeCents: 0,
        extraIncomeStartAge: null,
      }),
    ]) {
      for (const engine of ["historical", "montecarlo"] as const) {
        const r = refNeverOutRateAt({ ...asRef(inputs), spendingCents: 0 }, STOCKS, EXPECTED, VOL, engine, 12345);
        expect(r.successRate, `${engine} $0 rate`).toBe(100);
      }
    }
    // And the boundary: target 100 is feasible (status never
    // infeasible), target 101 is infeasible.
    expect(
      solveMaxSpending(sampleInputs({}), STOCKS, EXPECTED, VOL, "historical", 100)
        ?.solutionStatus,
    ).not.toBe("infeasible_at_zero");
    expect(
      solveMaxSpending(sampleInputs({}), STOCKS, EXPECTED, VOL, "historical", 101)
        ?.solutionStatus,
    ).toBe("infeasible_at_zero");
  });

  test("null stays null: no retired years, and percent on a $0 portfolio", () => {
    expect(
      solveMaxSpending(
        sampleInputs({ retirementAge: 95, endAge: 95 }),
        STOCKS, EXPECTED, VOL, "historical", 85,
      ),
    ).toBeNull();
    expect(
      refSolveMaxSpending(
        asRef(sampleInputs({ retirementAge: 95, endAge: 95 })),
        STOCKS, EXPECTED, VOL, "historical", 85,
      ),
    ).toBeNull();
    expect(
      solveMaxSpending(
        sampleInputs({ startCents: 0, strategy: "percent" }),
        STOCKS, EXPECTED, VOL, "historical", 85,
      ),
    ).toBeNull();
    expect(
      refSolveMaxSpending(
        asRef(sampleInputs({ startCents: 0, strategy: "percent" })),
        STOCKS, EXPECTED, VOL, "historical", 85,
      ),
    ).toBeNull();
  });
});

describe("solution statuses across all four strategies agree with the reference", () => {
  test("every status the engine reports on the pinned scenarios matches the reference", () => {
    const cases: {
      label: string;
      inputs: SimInputs;
      engine: "historical" | "montecarlo";
      target: number;
      status: SolverSolutionStatus;
    }[] = [
      { label: "constant hist", inputs: sampleInputs({}), engine: "historical", target: 95, status: "feasible" },
      { label: "guardrails hist", inputs: sampleInputs({ strategy: "guardrails" }), engine: "historical", target: 95, status: "feasible" },
      { label: "percent hist", inputs: sampleInputs({ strategy: "percent" }), engine: "historical", target: 95, status: "capped" },
      { label: "phased hist", inputs: sampleInputs({ strategy: "phased" }), engine: "historical", target: 95, status: "feasible" },
      { label: "constant mc", inputs: sampleInputs({}), engine: "montecarlo", target: 85, status: "feasible" },
      { label: "guardrails mc", inputs: sampleInputs({ strategy: "guardrails" }), engine: "montecarlo", target: 85, status: "feasible" },
      { label: "percent mc", inputs: sampleInputs({ strategy: "percent" }), engine: "montecarlo", target: 85, status: "capped" },
      { label: "phased mc", inputs: sampleInputs({ strategy: "phased" }), engine: "montecarlo", target: 85, status: "feasible" },
    ];
    for (const c of cases) {
      const eng = solveMaxSpending(c.inputs, STOCKS, EXPECTED, VOL, c.engine, c.target, 12345);
      const ref = refSolveMaxSpending(asRef(c.inputs), STOCKS, EXPECTED, VOL, c.engine, c.target, 12345);
      expect(eng?.solutionStatus, `${c.label} engine status`).toBe(c.status);
      expect(ref?.solutionStatus, `${c.label} reference status`).toBe(c.status);
      expect(eng?.targetAchieved, `${c.label} targetAchieved`).toBe(true);
      expect(eng?.achievedSuccessRate, `${c.label} achieved mirrors successRate`).toBe(
        eng?.successRate,
      );
    }
  }, 180_000);
});
