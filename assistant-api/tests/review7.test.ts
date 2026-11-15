// review7.test.ts — Review 7 adapter fixes.
//
// R7-S1 (Monte Carlo probability precision): success rates are
// probabilities, never money — the adapter used to push them through
// the r2 money rounder, collapsing 84.6% and 85.4% both to 0.85 and
// 99.9% to 1.0. Rates now convert at the engine's whole-run
// precision: fraction = Math.round(rate% * runs / 100) / runs, and
// successfulRuns recovers the whole-run count behind the rate.
// R7-S2 (max-spending percent semantics): the solver's own percent
// is reported verbatim (number only for the percent strategy),
// the solved dollars carry a per-strategy meaning, the 85% target
// and seed are echoed, infeasible solves report feasible: false,
// and a percent-strategy result at the engine's 30%/yr bound is
// flagged as capped, not a true maximum.
//
// All figures are the fictional household (see helpers.ts).

import { describe, expect, test } from "bun:test";
import {
  calculateMaxSpending,
  calculateRetirement,
  centsToDollars,
  maxSpendingCappedAtPercentBound,
  maxSpendingFeasible,
  ratePercentToFraction,
  runRetirementMonteCarlo,
  spendingAmountMeaning,
  successfulRunsFromRate,
} from "../src/adapter";
import { TOOLS, dispatchTool } from "../src/tools";
import {
  GUARDRAILS_ADJUSTMENT_DEFAULT,
  GUARDRAILS_CUT_DEFAULT,
  GUARDRAILS_RAISE_DEFAULT,
  MONTE_CARLO_TAB_RUNS,
  PHASE_DECLINE_PCT_DEFAULT,
  PHASE_START_AGE_DEFAULT,
  runHistorical,
  runMonteCarlo,
  solveMaxSpending,
  type SimInputs,
  type SpendingStrategy,
} from "../../server/src/retirementEngines";
import {
  expectOk,
  normalizedScenario,
} from "./helpers";

/** Direct engine inputs for the fictional household, any strategy. */
function directSimInputs(strategy: SpendingStrategy = "constant"): SimInputs {
  const s = normalizedScenario();
  return {
    startCents: s.portfolioCents,
    spendingCents: s.annualSpendingCents,
    currentAge: s.currentAge,
    retirementAge: s.retirementAge,
    endAge: s.endAge,
    extraIncomeCents: (36000 + 18000) * 100,
    extraIncomeStartAge: 67,
    strategy,
    percentOfPortfolio: 5,
    guardrailsCutPct: GUARDRAILS_CUT_DEFAULT,
    guardrailsRaisePct: GUARDRAILS_RAISE_DEFAULT,
    guardrailsAdjustmentPct: GUARDRAILS_ADJUSTMENT_DEFAULT,
    phaseStartAge: PHASE_START_AGE_DEFAULT,
    phaseDeclinePct: PHASE_DECLINE_PCT_DEFAULT,
  };
}

/** The r2 money rounding the adapter used to apply to probabilities. */
function oldRounded(ratePercent: number): number {
  return Math.round((ratePercent / 100) * 100) / 100;
}

describe("R7-S1 exact probability conversion", () => {
  test.each([
    // [engine rate %, runs, exact fraction, whole successful runs]
    [0, 1000, 0, 0],
    [1, 1000, 0.01, 10],
    [84.6, 1000, 0.846, 846],
    [85.0, 1000, 0.85, 850],
    [85.4, 1000, 0.854, 854],
    [99.9, 1000, 0.999, 999],
    [100, 1000, 1, 1000],
    [99, 200, 0.99, 198],
    [85.96491228070175, 57, 49 / 57, 49],
  ])(
    "%s%% over %s runs converts to %s (%s successful runs)",
    (ratePercent, runs, fraction, successful) => {
      expect(ratePercentToFraction(ratePercent, runs)).toBe(fraction);
      expect(successfulRunsFromRate(ratePercent, runs)).toBe(successful);
      // The recovered count is a whole number of runs, and the
      // fraction is exactly that count over the run count.
      expect(Number.isInteger(successfulRunsFromRate(ratePercent, runs))).toBe(
        true,
      );
      expect(ratePercentToFraction(ratePercent, runs)).toBe(
        successfulRunsFromRate(ratePercent, runs) / runs,
      );
    },
  );

  test("the old r2 rounding differs exactly where the review found it", () => {
    // 84.6% and 85.4% both collapsed to 0.85; 99.9% collapsed to 1.0.
    expect(oldRounded(84.6)).toBe(0.85);
    expect(ratePercentToFraction(84.6, 1000)).toBe(0.846);
    expect(oldRounded(85.4)).toBe(0.85);
    expect(ratePercentToFraction(85.4, 1000)).toBe(0.854);
    expect(oldRounded(99.9)).toBe(1.0);
    expect(ratePercentToFraction(99.9, 1000)).toBe(0.999);
  }, 30_000);
});

describe("R7-S1 Monte Carlo adapter parity", () => {
  test("fictional household, 1,000 runs, seed 42: 97.2% reads 0.972, not 0.97", () => {
    const s = normalizedScenario({ mcRuns: 1000, mcSeed: 42 });
    const res = expectOk(runRetirementMonteCarlo(s));
    const mc = runMonteCarlo(
      directSimInputs(),
      s.expectedReturnPct / 100,
      s.volatilityPct / 100,
      s.mcSeed,
      s.mcRuns,
    );
    expect(mc).not.toBeNull();
    expect(mc!.neverOutSuccessRate).toBe(97.2);
    expect(res.successRate).toBe(
      Math.round((mc!.neverOutSuccessRate * s.mcRuns) / 100) / s.mcRuns,
    );
    expect(res.successRate).toBe(0.972);
    expect(res.successfulRuns).toBe(972);
    expect(res.runs).toBe(1000);
    expect(res.seed).toBe(42);
  }, 30_000);

  test("fictional household, 200 runs, seed 42: 99% reads 0.99 with 198 successful runs", () => {
    const s = normalizedScenario({ mcRuns: 200, mcSeed: 42 });
    const res = expectOk(runRetirementMonteCarlo(s));
    expect(res.successRate).toBe(0.99);
    expect(res.successfulRuns).toBe(198);
    expect(res.runs).toBe(200);
  }, 30_000);

  test("same seed twice is identical; the run count is reported", () => {
    const run = (seed: number) =>
      runRetirementMonteCarlo(normalizedScenario({ mcRuns: 200, mcSeed: seed }));
    const first = run(42);
    const second = run(42);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    if (!first.ok) throw new Error("expected ok");
    expect(first.results.runs).toBe(200);
    expect(first.results.seed).toBe(42);
    // A different seed is NOT assumed to give a different answer;
    // reproducibility is only claimed for the same seed.
  }, 30_000);
});

describe("R7-S1 historical adapter parity", () => {
  test("calculateRetirement reports the historical rate at whole-run precision over hist.count", () => {
    const s = normalizedScenario();
    const res = expectOk(calculateRetirement(s));
    const hist = runHistorical(directSimInputs(), s.stocksPct);
    expect(hist).not.toBeNull();
    expect(hist!.count).toBe(57);
    expect(res.historicalNeverOutRate).toBe(
      Math.round((hist!.neverOutSuccessRate * hist!.count) / 100) /
        hist!.count,
    );
    expect(res.historicalNeverOutRate).toBe(1);
    expect(res.historicalRuns).toBe(57);
    expect(res.historicalSuccessfulRuns).toBe(57);
  }, 30_000);
});

describe("R7-S2 max spending: target, feasibility, meanings", () => {
  test("constant strategy: full engine parity, target echoed, feasible, MC and historical legs labeled separately", () => {
    // mcSeed 42 pins the literals (the README transcript-3 call):
    // the default seed solves to a different maximum.
    const s = normalizedScenario({ mcSeed: 42 });
    const res = expectOk(calculateMaxSpending(s));
    const inputs = directSimInputs();
    const solved = solveMaxSpending(
      inputs,
      s.stocksPct,
      s.expectedReturnPct / 100,
      s.volatilityPct / 100,
      "montecarlo",
      85,
      s.mcSeed,
    );
    const histSolved = solveMaxSpending(
      inputs,
      s.stocksPct,
      s.expectedReturnPct / 100,
      s.volatilityPct / 100,
      "historical",
      85,
      s.mcSeed,
    );
    expect(solved).not.toBeNull();
    if (solved === null) throw new Error("solver returned null");
    expect(res.maxAnnualSpending).toBe(
      centsToDollars(solved.maxSpendingCents),
    );
    expect(res.maxAnnualSpending).toBe(172300);
    expect(res.maxMonthlySpending).toBe(
      Math.round((res.maxAnnualSpending / 12) * 100) / 100,
    );
    expect(res.successRate).toBe(
      Math.round((solved.successRate * MONTE_CARLO_TAB_RUNS) / 100) /
        MONTE_CARLO_TAB_RUNS,
    );
    expect(res.successRate).toBe(0.85);
    expect(res.successfulRuns).toBe(850);
    expect(res.runs).toBe(1000);
    expect(res.medianEnding).toBe(centsToDollars(solved.medianEnding));
    expect(res.approximate).toBe(solved.approximate);
    // R7-S2: target, strategy, seed, feasibility, percent.
    expect(res.targetSuccessRate).toBe(0.85);
    expect(res.spendingStrategy).toBe("constant");
    expect(res.seed).toBe(s.mcSeed);
    expect(res.feasible).toBe(true);
    expect(res.solvedPortfolioWithdrawalPct).toBeNull();
    expect(res.cappedAtPercentBound).toBe(false);
    expect(res.spendingAmountMeaning).toContain("Fixed annual spending");
    // Historical leg: its own dollars, run count, count — and a
    // different rate (49/57) from the Monte Carlo leg's 850/1,000.
    expect(res.historicalMaxAnnualSpending).toBe(
      histSolved === null
        ? null
        : centsToDollars(histSolved.maxSpendingCents),
    );
    expect(res.historicalMaxAnnualSpending).toBe(223400);
    expect(res.historicalRuns).toBe(57);
    expect(res.historicalSuccessfulRuns).toBe(49);
    expect(res.historicalSolvedPortfolioWithdrawalPct).toBeNull();
    expect(res.successfulRuns).not.toBe(res.historicalSuccessfulRuns);
  }, 30_000);

  test("target achievement: re-evaluating at the returned level meets 85%; $100/yr more fails it", () => {
    const s = normalizedScenario({ mcSeed: 42 });
    const res = expectOk(calculateMaxSpending(s));
    expect(res.feasible).toBe(true);
    const inputs = directSimInputs();
    const atLevel = runMonteCarlo(
      { ...inputs, spendingCents: Math.round(res.maxAnnualSpending * 100) },
      s.expectedReturnPct / 100,
      s.volatilityPct / 100,
      s.mcSeed,
      MONTE_CARLO_TAB_RUNS,
    );
    expect(atLevel).not.toBeNull();
    expect(atLevel!.neverOutSuccessRate).toBeGreaterThanOrEqual(85);
    const oneStepUp = runMonteCarlo(
      {
        ...inputs,
        spendingCents: Math.round(res.maxAnnualSpending * 100) + 10000,
      },
      s.expectedReturnPct / 100,
      s.volatilityPct / 100,
      s.mcSeed,
      MONTE_CARLO_TAB_RUNS,
    );
    expect(oneStepUp).not.toBeNull();
    expect(oneStepUp!.neverOutSuccessRate).toBeLessThan(85);
  }, 30_000);

  test("percent strategy: solver percent reported verbatim on both legs; cap flagged at 30", () => {
    const s = normalizedScenario({ strategy: "percent" });
    const res = expectOk(calculateMaxSpending(s));
    const inputs = directSimInputs("percent");
    const solved = solveMaxSpending(
      inputs,
      s.stocksPct,
      s.expectedReturnPct / 100,
      s.volatilityPct / 100,
      "montecarlo",
      85,
      s.mcSeed,
    );
    const histSolved = solveMaxSpending(
      inputs,
      s.stocksPct,
      s.expectedReturnPct / 100,
      s.volatilityPct / 100,
      "historical",
      85,
      s.mcSeed,
    );
    expect(solved).not.toBeNull();
    if (solved === null) throw new Error("solver returned null");
    // The fictional household succeeds at the engine's 30%/yr bound
    // on both legs, so both report percent 30 — a capped result.
    expect(solved.percent).toBe(30);
    expect(histSolved?.percent).toBe(30);
    expect(res.solvedPortfolioWithdrawalPct).toBe(solved.percent);
    expect(res.solvedPortfolioWithdrawalPct).toBe(30);
    expect(res.historicalSolvedPortfolioWithdrawalPct).toBe(
      histSolved?.percent ?? null,
    );
    expect(res.historicalSolvedPortfolioWithdrawalPct).toBe(30);
    expect(res.cappedAtPercentBound).toBe(true);
    expect(res.maxAnnualSpending).toBe(
      centsToDollars(solved.maxSpendingCents),
    );
    expect(res.maxAnnualSpending).toBe(1136100);
    expect(res.successRate).toBe(1);
    expect(res.successfulRuns).toBe(1000);
    expect(res.feasible).toBe(true);
    expect(res.spendingStrategy).toBe("percent");
    expect(res.spendingAmountMeaning).toContain("Initial-year-equivalent");
    expect(res.spendingAmountMeaning).toContain(
      "later years scale with the portfolio balance",
    );
  }, 30_000);

  test("phased strategy: starting-spending meaning, no percent, feasible", () => {
    const s = normalizedScenario({ strategy: "phased" });
    const res = expectOk(calculateMaxSpending(s));
    const solved = solveMaxSpending(
      directSimInputs("phased"),
      s.stocksPct,
      s.expectedReturnPct / 100,
      s.volatilityPct / 100,
      "montecarlo",
      85,
      s.mcSeed,
    );
    expect(solved).not.toBeNull();
    expect(res.maxAnnualSpending).toBe(
      centsToDollars(solved!.maxSpendingCents),
    );
    expect(res.spendingStrategy).toBe("phased");
    expect(res.spendingAmountMeaning).toContain(
      "Starting spending before the planned reductions",
    );
    expect(res.solvedPortfolioWithdrawalPct).toBeNull();
    expect(res.cappedAtPercentBound).toBe(false);
    expect(res.feasible).toBe(true);
    // Historical leg: direct-histSolved pin (pass-2 NICE-2) — the
    // historical dollars/counts match the engine's own solve.
    // (Historical values are seed-independent; the MC leg is not.)
    const histSolved = solveMaxSpending(
      directSimInputs("phased"),
      s.stocksPct,
      s.expectedReturnPct / 100,
      s.volatilityPct / 100,
      "historical",
      85,
      s.mcSeed,
    );
    expect(res.historicalMaxAnnualSpending).toBe(
      histSolved === null
        ? null
        : centsToDollars(histSolved.maxSpendingCents),
    );
    expect(res.historicalMaxAnnualSpending).toBe(226300);
    expect(res.historicalRuns).toBe(57);
    expect(res.historicalSuccessfulRuns).toBe(49);
    expect(res.historicalSolvedPortfolioWithdrawalPct).toBeNull();
    expect(res.historicalCappedAtPercentBound).toBe(false);
  }, 30_000);

  test("guardrails strategy: base-spending meaning, no percent, feasible", () => {
    const s = normalizedScenario({ strategy: "guardrails" });
    const res = expectOk(calculateMaxSpending(s));
    const solved = solveMaxSpending(
      directSimInputs("guardrails"),
      s.stocksPct,
      s.expectedReturnPct / 100,
      s.volatilityPct / 100,
      "montecarlo",
      85,
      s.mcSeed,
    );
    expect(solved).not.toBeNull();
    expect(res.maxAnnualSpending).toBe(
      centsToDollars(solved!.maxSpendingCents),
    );
    expect(res.spendingStrategy).toBe("guardrails");
    expect(res.spendingAmountMeaning).toContain("Base spending");
    expect(res.spendingAmountMeaning).toContain(
      "may rise or fall on the engine's guardrail triggers",
    );
    expect(res.solvedPortfolioWithdrawalPct).toBeNull();
    expect(res.cappedAtPercentBound).toBe(false);
    expect(res.feasible).toBe(true);
    // Historical leg: direct-histSolved pin (pass-2 NICE-2) — the
    // historical dollars/counts match the engine's own solve.
    // (Historical values are seed-independent; the MC leg is not.)
    const histSolved = solveMaxSpending(
      directSimInputs("guardrails"),
      s.stocksPct,
      s.expectedReturnPct / 100,
      s.volatilityPct / 100,
      "historical",
      85,
      s.mcSeed,
    );
    expect(res.historicalMaxAnnualSpending).toBe(
      histSolved === null
        ? null
        : centsToDollars(histSolved.maxSpendingCents),
    );
    expect(res.historicalMaxAnnualSpending).toBe(435300);
    expect(res.historicalRuns).toBe(57);
    expect(res.historicalSuccessfulRuns).toBe(49);
    expect(res.historicalSolvedPortfolioWithdrawalPct).toBeNull();
    expect(res.historicalCappedAtPercentBound).toBe(false);
  }, 120_000);

  test("spendingAmountMeaning is distinct for every strategy", () => {
    const meanings = (
      ["constant", "percent", "phased", "guardrails"] as SpendingStrategy[]
    ).map((strategy) => spendingAmountMeaning(strategy));
    expect(new Set(meanings).size).toBe(4);
    expect(meanings[0]).toContain("Fixed annual spending");
    expect(meanings[1]).toContain("Initial-year-equivalent");
    expect(meanings[2]).toContain("Starting spending before the planned reductions");
    expect(meanings[3]).toContain("Base spending");
  }, 30_000);

  test("mcRuns stays inert for max spending: runs still reports the fixed 1,000", () => {
    const res = expectOk(
      calculateMaxSpending(normalizedScenario({ mcRuns: 5000 })),
    );
    expect(res.runs).toBe(1000);
    expect(res.successRate).toBe(0.85);
    expect(res.successfulRuns).toBe(850);
  }, 120_000);
});

describe("R7-S2 cap detector (review pass 1): the bound is a step count", () => {
  /** The reviewer's MUST-1 probe: $1,000,050 portfolio, percent
   * strategy, 1 retired year at +50% real / vol 0. The portfolio
   * is split pretax 500k / taxable 500k / roth 50 so no bucket is
   * the whole portfolio; the fictional household's other fields
   * (SS at 67) never activate inside the 1-year horizon. */
  function probeScenario(portfolio: number): ReturnType<typeof normalizedScenario> {
    return normalizedScenario({
      pretax: 500000,
      taxable: 500000,
      roth: portfolio - 1_000_000,
      hsa: 0,
      currentAge: 54,
      retirementAge: 54,
      endAge: 55,
      expectedRealReturnPct: 50,
      volatilityPct: 0,
      strategy: "percent",
      mcSeed: 42,
    });
  }

  test("$1,000,050 portfolio at the bound: capped is true even though the percent reads 29.9985…, not 30", () => {
    const s = probeScenario(1_000_050);
    expect(s.portfolioCents).toBe(100_005_000);
    const raw = calculateMaxSpending(s);
    const res = expectOk(raw);
    // The solver returns its maxSteps result on both legs:
    // $300,000/yr at pctFor(3,000) = 29.99850007499625.
    expect(res.maxAnnualSpending).toBe(300000);
    expect(res.solvedPortfolioWithdrawalPct).toBe(29.99850007499625);
    expect(res.successRate).toBe(1);
    expect(res.cappedAtPercentBound).toBe(true);
    expect(res.historicalMaxAnnualSpending).toBe(300000);
    expect(res.historicalSolvedPortfolioWithdrawalPct).toBe(
      29.99850007499625,
    );
    expect(res.historicalCappedAtPercentBound).toBe(true);
    if (!raw.ok) throw new Error("expected ok");
    expect(
      raw.warnings.some((w) => w.includes("historical leg also hit")),
    ).toBe(true);
  }, 30_000);

  test("$1,000,000 control: the capped percent reads exactly 30 and capped is true", () => {
    const s = probeScenario(1_000_000);
    expect(s.portfolioCents).toBe(100_000_000);
    const res = expectOk(calculateMaxSpending(s));
    expect(res.maxAnnualSpending).toBe(300000);
    expect(res.solvedPortfolioWithdrawalPct).toBe(30);
    expect(res.cappedAtPercentBound).toBe(true);
    expect(res.historicalCappedAtPercentBound).toBe(true);
  }, 30_000);

  test("historical cap flag matches the MC flag on a percent solve, and both are false off the percent strategy", () => {
    // Fictional household, percent strategy: both legs hit the
    // bound (percent 30 on both — see the percent test above).
    const percent = expectOk(
      calculateMaxSpending(normalizedScenario({ strategy: "percent" })),
    );
    expect(percent.cappedAtPercentBound).toBe(true);
    expect(percent.historicalCappedAtPercentBound).toBe(true);
    // Constant strategy: no percent on either leg, so neither
    // leg can be at the percent bound.
    const constant = expectOk(calculateMaxSpending(normalizedScenario()));
    expect(constant.solvedPortfolioWithdrawalPct).toBeNull();
    expect(constant.historicalSolvedPortfolioWithdrawalPct).toBeNull();
    expect(constant.cappedAtPercentBound).toBe(false);
    expect(constant.historicalCappedAtPercentBound).toBe(false);
    // No public input can make the two flags diverge: a percent
    // withdrawal can never zero a balance (the engine's funding
    // test only fails when the net withdrawal exceeds the
    // balance, and a ≤30% withdrawal of the balance minus income
    // never does), so the solver's at-max step always succeeds
    // on both legs and the binary-search branch is unreachable —
    // the "interior historical solution" case is therefore
    // covered at the helper level above, where an interior
    // synthetic solve correctly reports false.
  }, 30_000);
});

describe("R7-S2 feasibility and cap helpers", () => {
  test("feasible is false only when $0 spending still misses the target", () => {
    expect(maxSpendingFeasible(0, 84.9)).toBe(false);
    expect(maxSpendingFeasible(0, 0)).toBe(false);
    expect(maxSpendingFeasible(0, 85)).toBe(true);
    expect(maxSpendingFeasible(10000, 50)).toBe(true);
  }, 30_000);

  test("capped is decided by the solved dollars against the engine's bound step count, not by the percent reading 30", () => {
    // $1,000,050 portfolio: maxSteps = floor(100,005,000 * 0.3 /
    // 10,000) = 3,000; pctFor(3,000) = 29.99850007499625, not 30 —
    // yet the solver's maxSteps result IS at the bound. The old
    // detector (percent >= 30 - 1e-9) missed exactly this case: a
    // capped percent can legitimately read 29.9985…, so the
    // percent alone never decides it.
    const startCents = 100_005_000;
    expect(
      maxSpendingCappedAtPercentBound(29.99850007499625, 3000 * 10000, startCents),
    ).toBe(true);
    // One step below the bound is an interior solution, not
    // capped — even at a percent like 29.999 that merely looks
    // close to 30.
    expect(
      maxSpendingCappedAtPercentBound(29.999, 2999 * 10000, startCents),
    ).toBe(false);
    expect(
      maxSpendingCappedAtPercentBound(29.98850057497125, 2999 * 10000, startCents),
    ).toBe(false);
    // The exact-$1,000-multiple control: the capped percent reads
    // 30 there, and the detector still agrees.
    expect(
      maxSpendingCappedAtPercentBound(30, 3000 * 10000, 100_000_000),
    ).toBe(true);
    // The at-zero-fails return (0 cents, percent 0) is not capped:
    // 0 steps is never maxSteps, which is > 0 whenever the solver
    // returns.
    expect(maxSpendingCappedAtPercentBound(0, 0, startCents)).toBe(false);
    // A non-percent solve whose dollars happen to equal the bound
    // step count is not a percent-bound cap — percent null decides
    // that, not the dollars.
    expect(
      maxSpendingCappedAtPercentBound(null, 3000 * 10000, startCents),
    ).toBe(false);
    expect(maxSpendingCappedAtPercentBound(null, 0, startCents)).toBe(false);
    // Defensive: no starting portfolio, no bound to hit.
    expect(maxSpendingCappedAtPercentBound(30, 3000 * 10000, 0)).toBe(false);
  }, 30_000);

  test("note: the at-zero-fails branch is defensive — $0 spending cannot fail the engine's never-runs-out test (a $0 net withdrawal never exceeds the balance), so no public input reaches feasible: false; the flag and warning exist for the solver's own verdict if it ever does", () => {
    // Covered at the helper level above; every adapter-level solve
    // in this file reports feasible: true.
    expect(maxSpendingFeasible(0, 100)).toBe(true);
  }, 30_000);
});

describe("R7 docs: the limitations are stated where clients read them", () => {
  test("tool descriptions disclose precision, conditionality, feasibility, and the cap", () => {
    const byName = new Map(TOOLS.map((t) => [t.name, t.description]));
    const mc = byName.get("retirement_monte_carlo") ?? "";
    expect(mc).toContain("whole-run precision");
    expect(mc).toContain("successfulRuns");
    const max = byName.get("retirement_max_spending") ?? "";
    expect(max).toContain("conditional on the seed");
    expect(max).toContain("$100 search increment");
    expect(max).toContain("portfolio-only (no-tax)");
    expect(max).toContain("feasible");
    expect(max).toContain("30%/yr");
    expect(max).toContain("spendingAmountMeaning");
  }, 30_000);

  test("describe_capabilities lists the cap limitation and the precision rule", () => {
    const res = dispatchTool("retirement_describe_capabilities", {});
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("describe failed");
    const results = res.results as { limitations: string[] };
    expect(
      results.limitations.some((l) => l.includes("whole-run precision")),
    ).toBe(true);
    expect(
      results.limitations.some((l) =>
        l.includes("no adapter-visible flag"),
      ),
    ).toBe(true);
  }, 30_000);
});
