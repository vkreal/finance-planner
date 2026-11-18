// Engine Review C5 — Deep Monte Carlo Code Audit: executable tests.
//
// Phases 1–5. Every expected value below is hand-computed in the
// test itself (plain arithmetic on literals), derived from the
// INDEPENDENT reference implementation in
// retirementIndependentCheck.ts (which imports nothing from
// retirementEngines.ts), or pinned from the Phase 1 probe runs
// recorded in the C5 builder report — never copied from engine
// output after the fact. Figures are the fictional sample
// household (server/src/sampleHousehold.ts) plus small synthetic
// edge cases of the same kind the existing suites already use.
//
// What this file adds over the existing suites (it does NOT
// re-pin them):
//   - Phase 1 (the gap this review closes): C5-M1-a..i have NO
//     executable tests anywhere before this file — the core
//     validators are pinned here, on both Roth entry points,
//     including the seeded valid-output pins that prove valid
//     calls are unchanged by the fix.
//   - Phase 2: Monte Carlo-LEVEL oracles (vol 0 / -100% /
//     below -100% / exact funding boundary / multi-stream
//     schedule / late income) the sim-level suites price but
//     the MC entry point never had pinned; plus the derived
//     never-runs-out verdict (the Phase 6 C5-S1 change) checked
//     against runNeverRunsOut on every vector.
//   - Phase 3: seeds 0 / 1 / 12345 / large, first-1,000-draw
//     exact agreement, small samples 1 / 2 / 3, chart p25 / p75.
//   - Phase 4: exhaustive $100 enumeration on small controlled
//     problems for ALL FOUR strategies, solver-vs-display
//     identity, late-income ceiling, the ceiling-step-inclusive
//     pin, guardrails capped boundary.
//   - Phase 5: stats alone-vs-batch, ordering independence,
//     check/stats reproducibility, check-vs-stats same-path
//     median consistency, small-N self-consistency, zero-vol
//     identity on the sample household.
//
// Run per-file (whole-suite bun test in one process OOMs on
// this VM): bun test server/src/retirementReviewC5.test.ts
// The Roth check tests share ONE runOptimizer call on the
// sample household (lazy, cached); the stats tests use the
// small fictional base below and need no optimizer run.

import { describe, expect, test } from "bun:test";
import {
  MAX_MONTE_CARLO_RUNS,
  medianOf,
  mulberry32,
  neverRunsOutFromDetailed,
  normalRandom,
  percentile,
  runHistorical,
  runMonteCarlo,
  runNeverRunsOut,
  simulateDetailed,
  solveMaxSpending,
  validateMonteCarloReturn,
  validateMonteCarloRunCount,
  validateMonteCarloSeed,
  type SimInputs,
} from "./retirementEngines";
import {
  refFeasible,
  refMulberry32,
  refNeverOutRateAt,
  refNeverRunsOut,
  refNormalRandom,
  refRunMonteCarlo,
  refSimulateDetailed,
  type RefInputs,
} from "./retirementIndependentCheck";
import {
  MAX_ROTH_MONTE_CARLO_PATHS,
  MC_STREAM_STRIDE_YEARS,
  ROTH_MC_CHECK_SEED,
  planInputsFromSaved,
  rothMcReturnSeries,
  rothMcShockSeries,
  rothMcStream,
  runOptimizer,
  runRothMonteCarloCheck,
  runRothMonteCarloStats,
  type RothCompareBaseSaved,
  type RothCompareOverrides,
} from "./rothOptimizer";
import {
  SAMPLE_ANNUAL_SPENDING_CENTS,
  SAMPLE_END_AGE,
  SAMPLE_RETIREMENT_AGE,
  SAMPLE_SS_PRIMARY_CENTS,
  SAMPLE_SS_PRIMARY_START_AGE,
  SAMPLE_SS_SPOUSE_CENTS,
  SAMPLE_SS_SPOUSE_START_AGE,
  SAMPLE_TAXABLE_CENTS,
  samplePlanInputs,
} from "./sampleHousehold";

// --- Shared fixtures -------------------------------------------------

const STOCKS = 75;
const EXPECTED = 0.05;
const VOL = 0.18;

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
const asRef = (inputs: SimInputs): RefInputs =>
  inputs as unknown as RefInputs;

// The Phase 1 probe plan (fictional): start $1,200,000, spending
// $96,000/yr, ages 55/57/95, SS $48,000/yr from 67, constant.
function probeInputs(): SimInputs {
  return {
    startCents: 120_000_000,
    spendingCents: 9_600_000,
    currentAge: 55,
    retirementAge: 57,
    endAge: 95,
    extraIncomeCents: 4_800_000,
    extraIncomeStartAge: 67,
    strategy: "constant",
    percentOfPortfolio: 5,
    guardrailsCutPct: 120,
    guardrailsRaisePct: 80,
    guardrailsAdjustmentPct: 10,
    phaseStartAge: 75,
    phaseDeclinePct: 1,
  };
}

// Small fictional base for the Roth stats runs (the Phase 1
// probe base): born 1963/1974, $50,000 pre-tax + $25,000 taxable
// + $12,000 Roth + $3,000 HSA, $36,000/yr spending, retire 62,
// end 90, 4% expected return, SS $30,000/yr at 67.
const SMALL_BASE: RothCompareBaseSaved = {
  birthYearPrimary: 1963,
  birthYearSpouse: 1974,
  filingStatus: "mfj",
  pretaxCents: 50000000,
  pretaxSpouseCents: null,
  survivorEnabled: false,
  survivorWho: null,
  survivorDeathYear: null,
  rothCents: 12000000,
  taxableCents: 25000000,
  hsaCents: 3000000,
  taxableBasisPct: 50,
  annualSpendingCents: 3600000,
  retirementAge: 62,
  endAge: 90,
  expectedReturnPct: 4,
  ssPrimaryAnnualCents: 3000000,
  ssPrimaryStartAge: 67,
  ssPrimaryNoBenefit: false,
  ssSpouseAnnualCents: null,
  ssSpouseStartAge: null,
  ssSpouseNoBenefit: true,
  otherOrdinaryCents: null,
  taxExemptInterestCents: null,
  convertedAlreadyCents: null,
  windowStartAge: 62,
  windowStopAge: 73,
  payTaxFrom: "taxable",
  protectMinTaxableCents: null,
  preservePretaxCents: null,
  preserveExitRatePct: null,
  claimAgeFloor: null,
  drawOrder: null,
  drawOrderSwitchAge: null,
  drawOrderAfter: null,
  spouseSoleBeneficiary: true,
  acaHouseholdSize: 2,
  acaHouseholdSchedule: null,
  acaBenchmarkCoupleCents: null,
  acaBenchmarkSingleCents: null,
  acaBenchmarkFamilyCents: null,
  inflationPct: 2.5,
  stateRatePct: 0,
  heirRatePct: 22,
  ceilings: null,
  optimizerGuardrail: null,
  optimizerBunching: null,
} as RothCompareBaseSaved;

const FILL12: RothCompareOverrides = {
  ceilings: {
    bracketTopPct: 12,
    irmaaTierCap: null,
    ltcgZeroCap: false,
    acaCliffCap: false,
    acaCliffCapFamilyOnly: false,
    magiCapCents: null,
    acaCliffBufferCents: null,
  },
};

// The sample household as a saved base (cents), for the
// check-vs-stats parity test: the same household the check
// prices via samplePlanInputs(), in the shape the stats run
// builds from. Yields are threaded here (the sample return's
// 1% / 0.075% / 75% share); the embedded net ACA premium is
// derived by planInputsFromSaved, not entered.
const SAMPLE_BASE: RothCompareBaseSaved = {
  birthYearPrimary: 1968,
  birthYearSpouse: 1970,
  filingStatus: "mfj",
  pretaxCents: 150_000_000,
  pretaxSpouseCents: null,
  survivorEnabled: false,
  survivorWho: null,
  survivorDeathYear: null,
  rothCents: 40_000_000,
  taxableCents: 200_000_000,
  hsaCents: 7_500_000,
  taxableBasisPct: 60,
  annualSpendingCents: 18_000_000,
  retirementAge: 62,
  endAge: 95,
  expectedReturnPct: 5,
  ssPrimaryAnnualCents: 4_800_000,
  ssPrimaryStartAge: 67,
  ssPrimaryNoBenefit: false,
  ssSpouseAnnualCents: 3_000_000,
  ssSpouseStartAge: 67,
  ssSpouseNoBenefit: false,
  otherOrdinaryCents: null,
  taxExemptInterestCents: null,
  convertedAlreadyCents: null,
  windowStartAge: 62,
  windowStopAge: 73,
  payTaxFrom: "taxable",
  protectMinTaxableCents: 5_000_000,
  preservePretaxCents: null,
  preserveExitRatePct: null,
  claimAgeFloor: null,
  drawOrder: null,
  drawOrderSwitchAge: null,
  drawOrderAfter: null,
  spouseSoleBeneficiary: true,
  acaHouseholdSize: 4,
  acaHouseholdSchedule: null,
  acaBenchmarkCoupleCents: 2_500_000,
  acaBenchmarkSingleCents: 1_750_000,
  acaBenchmarkFamilyCents: 3_600_000,
  inflationPct: 2.5,
  stateRatePct: 0,
  heirRatePct: 24,
  ceilings: null,
  optimizerGuardrail: null,
  optimizerBunching: null,
  taxableDividendYieldPct: 1,
  taxableInterestYieldPct: 0.075,
  qualifiedDividendSharePct: 75,
} as unknown as RothCompareBaseSaved;

// One optimizer run on the sample household, shared by every
// Roth check test in this file.
let optCache: ReturnType<typeof runOptimizer> | null = null;
function getOpt(): ReturnType<typeof runOptimizer> {
  if (optCache == null) optCache = runOptimizer(samplePlanInputs());
  return optCache;
}

// The funding-failure oracle, re-derived from a detailed run
// (the same rule runNeverRunsOut implements): a retired year
// whose net withdrawal exceeds the balance on hand at its
// start fails the run — even if a later income surplus refills
// the balance. Used to pin the Phase 6 derivation: the
// never-runs-out verdict read straight off the detailed run's
// own arrays must agree with runNeverRunsOut on every vector.
function derivedNeverOut(
  det: { balances: number[]; netWithdrawals: number[] },
  inputs: SimInputs,
): boolean {
  for (let i = 0; i < det.netWithdrawals.length; i++) {
    if (inputs.currentAge + i < inputs.retirementAge) continue;
    if ((det.netWithdrawals[i] ?? 0) > (det.balances[i] ?? 0)) return false;
  }
  return true;
}

// --- Phase 1: C5-M1 validation ---------------------------------------

describe("C5-M1-a/b/c: runMonteCarlo run-count validation", () => {
  test("runCount 0 / negative / fractional / NaN / Infinity / above the cap throw RangeError", () => {
    const inputs = probeInputs();
    for (const n of [0, -5, -1, 2.5, NaN, Infinity, -Infinity, 10001, 1e9]) {
      expect(() => runMonteCarlo(inputs, 0.05, 0.15, 12345, n)).toThrowError(
        /whole number from 1 to 10000/,
      );
      expect(() => validateMonteCarloRunCount(n)).toThrowError(RangeError);
    }
  });

  test("runCount 1 and the 10000 cap are accepted; 10000 runs return a real result", () => {
    expect(() => validateMonteCarloRunCount(1)).not.toThrow();
    expect(() => validateMonteCarloRunCount(MAX_MONTE_CARLO_RUNS)).not.toThrow();
    expect(MAX_MONTE_CARLO_RUNS).toBe(10000);
    // Short horizon so the cap run is fast: 2 priced years.
    const tiny = probeInputs();
    tiny.currentAge = 60;
    tiny.retirementAge = 60;
    tiny.endAge = 61;
    const r = runMonteCarlo(tiny, 0.05, 0.15, 12345, 10000);
    expect(r).not.toBeNull();
    expect(r?.successRate).toBeGreaterThanOrEqual(0);
    expect(r?.successRate).toBeLessThanOrEqual(100);
    expect(Number.isFinite(r?.p50 ?? NaN)).toBe(true);
  });

  test("every successful result samples at least one path: runCount 1 is a 0-or-100 rate over one ending", () => {
    const inputs = probeInputs();
    const r = runMonteCarlo(inputs, 0.05, 0.15, 12345, 1);
    expect(r).not.toBeNull();
    expect(r?.successRate === 0 || r?.successRate === 100).toBe(true);
    expect(r?.neverOutSuccessRate === 0 || r?.neverOutSuccessRate === 100).toBe(true);
    expect(r?.p10).toBe(r?.p50);
    expect(r?.p50).toBe(r?.p90);
    expect(r?.chart.length).toBe(95 - 55 + 2);
    for (const row of r?.chart ?? []) {
      expect(Number.isFinite(row.median)).toBe(true);
    }
  });

  test("runCount Infinity throws before any allocation (returns synchronously, no hang)", () => {
    const inputs = probeInputs();
    expect(() => runMonteCarlo(inputs, 0.05, 0.15, 12345, Infinity)).toThrowError(
      /whole number from 1 to 10000, got Infinity/,
    );
  });
});

describe("C5-M1-d/e: runMonteCarlo seed / return / volatility validation", () => {
  test("NaN / Infinity / fractional seeds throw; integer seeds (incl. 0 and negatives) are accepted", () => {
    const inputs = probeInputs();
    for (const s of [NaN, Infinity, -Infinity, 1.5, -1.5, 0.1]) {
      expect(() => runMonteCarlo(inputs, 0.05, 0.15, s, 10)).toThrowError(
        /seed must be a finite integer/,
      );
      expect(() => validateMonteCarloSeed(s)).toThrowError(RangeError);
    }
    for (const s of [0, 1, 12345, -1, 2147483647]) {
      expect(() => validateMonteCarloSeed(s)).not.toThrow();
      const a = runMonteCarlo(inputs, 0.05, 0.15, s, 10);
      const b = runMonteCarlo(inputs, 0.05, 0.15, s, 10);
      expect(a).toEqual(b);
    }
  });

  test("non-finite expected return and non-finite / negative volatility throw; vol 0 is accepted", () => {
    const inputs = probeInputs();
    for (const e of [NaN, Infinity, -Infinity]) {
      expect(() => runMonteCarlo(inputs, e, 0.15, 12345, 10)).toThrowError(
        /expected return must be a finite number/,
      );
    }
    for (const v of [NaN, Infinity, -Infinity, -0.1, -1]) {
      expect(() => runMonteCarlo(inputs, 0.05, v, 12345, 10)).toThrowError(
        /volatility must be a finite number at or above 0/,
      );
      expect(() => validateMonteCarloReturn(0.05, v)).toThrowError(RangeError);
    }
    expect(() => validateMonteCarloReturn(0.05, 0)).not.toThrow();
    expect(() => validateMonteCarloReturn(-1, 0)).not.toThrow();
    const r = runMonteCarlo(inputs, 0.05, 0, 12345, 10);
    expect(r).not.toBeNull();
  });

  test("solveMaxSpending validates its seed even on the historical leg (a NaN seed cannot silently solve)", () => {
    expect(() =>
      solveMaxSpending(probeInputs(), 95, 0.05, 0.15, "historical", 85, NaN),
    ).toThrowError(/seed must be a finite integer/);
    expect(() =>
      solveMaxSpending(probeInputs(), 95, 0.05, 0.15, "historical", 85, 1.5),
    ).toThrowError(/seed must be a finite integer/);
  });

  test("solveMaxSpending validates expected/vol even on the historical leg (a NaN expected/vol cannot silently solve)", () => {
    // Engine Review C5, NICE-2: the Monte Carlo legs reach
    // runMonteCarlo (which validates expected/vol) but the
    // historical leg never does — the entry check fails fast
    // there too, with the same messages runMonteCarlo throws.
    expect(() =>
      solveMaxSpending(probeInputs(), 95, NaN, 0.15, "historical", 85, 12345),
    ).toThrowError(/expected return must be a finite number/);
    expect(() =>
      solveMaxSpending(probeInputs(), 95, Infinity, 0.15, "historical", 85, 12345),
    ).toThrowError(/expected return must be a finite number/);
    expect(() =>
      solveMaxSpending(probeInputs(), 95, 0.05, NaN, "historical", 85, 12345),
    ).toThrowError(/volatility must be a finite number at or above 0/);
    expect(() =>
      solveMaxSpending(probeInputs(), 95, 0.05, -0.1, "historical", 85, 12345),
    ).toThrowError(/volatility must be a finite number at or above 0/);
  });

  test("valid seeded outputs are unchanged by the fix (Phase 1 after-probe pins)", () => {
    const inputs = probeInputs();
    const ten = runMonteCarlo(inputs, 0.05, 0.15, 12345, 10);
    expect(ten?.successRate).toBe(40);
    expect(ten?.neverOutSuccessRate).toBe(40);
    expect(ten?.p50).toBe(0);
    const thousand = runMonteCarlo(inputs, 0.05, 0.15, 12345, 1000);
    expect(thousand?.successRate).toBe(40.8);
    expect(thousand?.neverOutSuccessRate).toBe(40.8);
    expect(thousand?.p10).toBe(0);
    expect(thousand?.p50).toBe(0);
    expect(thousand?.p90).toBe(471887077.6084841);
  });
});

describe("C5-M1-f/g: runRothMonteCarloCheck validation", () => {
  test("pathCount 0 / negative / fractional / NaN / Infinity / above the cap throws RangeError", () => {
    const opt = getOpt();
    const winner = { spec: opt.winner.spec, claimAges: opt.winner.claimAges };
    const dn = { spec: opt.doNothing.spec, claimAges: opt.doNothing.claimAges };
    const plan = samplePlanInputs();
    for (const n of [0, -3, -1, 2.5, NaN, Infinity, 1001, 1e9]) {
      expect(() =>
        runRothMonteCarloCheck(plan, winner, dn, {
          volatilityPct: 15, pathCount: n, seed: ROTH_MC_CHECK_SEED,
        }),
      ).toThrowError(/path count must be a whole number from 1 to 1000/);
    }
    expect(MAX_ROTH_MONTE_CARLO_PATHS).toBe(1000);
  }, 300_000);

  test("NaN / fractional seeds and NaN / negative / over-100 volatility throw; vol 0 and 100 are accepted", () => {
    const opt = getOpt();
    const winner = { spec: opt.winner.spec, claimAges: opt.winner.claimAges };
    const dn = { spec: opt.doNothing.spec, claimAges: opt.doNothing.claimAges };
    const plan = samplePlanInputs();
    for (const s of [NaN, Infinity, 1.5]) {
      expect(() =>
        runRothMonteCarloCheck(plan, winner, dn, {
          volatilityPct: 15, pathCount: 2, seed: s,
        }),
      ).toThrowError(/seed must be a finite integer/);
    }
    for (const v of [NaN, Infinity, -5, -0.1, 100.1]) {
      expect(() =>
        runRothMonteCarloCheck(plan, winner, dn, {
          volatilityPct: v, pathCount: 2, seed: ROTH_MC_CHECK_SEED,
        }),
      ).toThrowError(/volatility must be between 0 and 100 percent/);
    }
    expect(
      runRothMonteCarloCheck(plan, winner, dn, {
        volatilityPct: 0, pathCount: 2, seed: ROTH_MC_CHECK_SEED,
      }).pathsRun,
    ).toBe(2);
    expect(
      runRothMonteCarloCheck(plan, winner, dn, {
        volatilityPct: 100, pathCount: 2, seed: ROTH_MC_CHECK_SEED,
      }).pathsRun,
    ).toBe(2);
  }, 300_000);

  test("pathCount 0 is rejected consistently on BOTH Roth entry points (check throws, stats returns ok:false)", () => {
    const opt = getOpt();
    const winner = { spec: opt.winner.spec, claimAges: opt.winner.claimAges };
    const dn = { spec: opt.doNothing.spec, claimAges: opt.doNothing.claimAges };
    const plan = samplePlanInputs();
    expect(() =>
      runRothMonteCarloCheck(plan, winner, dn, {
        volatilityPct: 15, pathCount: 0, seed: ROTH_MC_CHECK_SEED,
      }),
    ).toThrowError(RangeError);
    const stats = runRothMonteCarloStats(
      SMALL_BASE,
      [{ name: "Do Nothing", overrides: {} }],
      2026,
      { volatilityPct: 15, pathCount: 0, seed: ROTH_MC_CHECK_SEED },
    );
    expect(stats.ok).toBe(false);
    expect(stats.reason).toMatch(/path count must be a whole number from 1 to 1000/);
    expect(stats.scenarios).toEqual([]);
  }, 300_000);

  test("valid seeded check output is unchanged by the fix (Phase 1 after-probe pins)", () => {
    // RE-PIN (Engine Review C9, Build 4): the median advantage
    // and winner median below are the engine's current
    // deterministic output, verified by execution on the
    // landing tree and on the Build 4 tree — NOT the values
    // C5 pinned. The C5 pins (median advantage 388,839.38,
    // winner median 473,853.51) reproduce exactly at the C5
    // landing commit, and the move happened in C9 Build 1
    // (the withholding-penalty rework): the values are already
    // the current ones at the post-Build-1 commit, and the
    // movement is winner-only — the Do Nothing median never
    // moved, and only the converting winner's path costs rose,
    // on five of the eight paths — exactly what a conversion
    // withholding change does. Build 4 does not move them:
    // a per-path probe prices all eight paths on the Build 3
    // landing tree and on the Build 4 tree byte-identically,
    // with no HSA leg engaged and no unpaid tax on any path
    // of either candidate. The Do Nothing median below is
    // the original C5 pin, unchanged.
    const opt = getOpt();
    const winner = { spec: opt.winner.spec, claimAges: opt.winner.claimAges };
    const dn = { spec: opt.doNothing.spec, claimAges: opt.doNothing.claimAges };
    const r = runRothMonteCarloCheck(samplePlanInputs(), winner, dn, {
      volatilityPct: 15, pathCount: 8, seed: ROTH_MC_CHECK_SEED,
    });
    expect(r.pathsRun).toBe(8);
    expect(r.paths.length).toBe(8);
    expect(r.wins).toBe(7);
    expect(r.winRatePct).toBe(87.5);
    // C2 re-pin (2026-11-18): the conditional integer-cents bracket
    // walk moves this seeded median advantage 388441.45 -> 388441.43
    // (-2c); winner, win count, and both median net costs unchanged.
    // C2 round 2 re-pin: the preferential staircase moves it back
    // +2c to 388441.45, its pre-walk value.
    expect(r.medianAdvantage).toBe(388441.45);
    // C2 round 2 re-pin: the preferential staircase moves the
    // winner median net cost −1c to 473965.56.
    expect(r.winnerMedianNetCost).toBe(473965.56);
    // C2 re-pin (2026-11-18): same walk move, the do-nothing median
    // net cost 944804.46 -> 944804.45 (-1c).
    // C2 round 2 re-pin: the preferential staircase moves it +3c
    // to 944804.48.
    expect(r.doNothingMedianNetCost).toBe(944804.48);
  }, 300_000);

  test("every successful check result samples at least one path (N=1)", () => {
    const opt = getOpt();
    const winner = { spec: opt.winner.spec, claimAges: opt.winner.claimAges };
    const dn = { spec: opt.doNothing.spec, claimAges: opt.doNothing.claimAges };
    const r = runRothMonteCarloCheck(samplePlanInputs(), winner, dn, {
      volatilityPct: 15, pathCount: 1, seed: ROTH_MC_CHECK_SEED,
    });
    expect(r.pathsRun).toBe(1);
    expect(r.paths.length).toBe(1);
    expect(r.wins === 0 || r.wins === 1).toBe(true);
    expect(r.winRatePct === 0 || r.winRatePct === 100).toBe(true);
    expect(r.medianAdvantage).toBe(r.paths[0]!.advantage);
  }, 300_000);
});

describe("C5-M1-h/i: runRothMonteCarloStats validation", () => {
  test("pathCount 0 / negative / fractional / NaN / above the cap returns ok:false naming the count", () => {
    for (const n of [0, -2, -1, 2.5, NaN, Infinity, 1001]) {
      const r = runRothMonteCarloStats(
        SMALL_BASE,
        [{ name: "Do Nothing", overrides: {} }],
        2026,
        { volatilityPct: 15, pathCount: n, seed: ROTH_MC_CHECK_SEED },
      );
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/path count must be a whole number from 1 to 1000/);
      expect(r.scenarios).toEqual([]);
    }
  });

  test("NaN / fractional seeds and NaN / negative / over-100 volatility return ok:false (never ok:true with NaN percentiles)", () => {
    for (const s of [NaN, Infinity, 1.5]) {
      const r = runRothMonteCarloStats(
        SMALL_BASE,
        [{ name: "Do Nothing", overrides: {} }],
        2026,
        { volatilityPct: 15, pathCount: 2, seed: s },
      );
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/seed must be a finite integer/);
    }
    for (const v of [NaN, Infinity, -5, 100.1]) {
      const r = runRothMonteCarloStats(
        SMALL_BASE,
        [{ name: "Do Nothing", overrides: {} }],
        2026,
        { volatilityPct: v, pathCount: 2, seed: ROTH_MC_CHECK_SEED },
      );
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/volatility must be between 0 and 100 percent/);
    }
  });

  test("rothMcStream validates its seed (the shared stream entry point)", () => {
    expect(() => rothMcStream(NaN)).toThrowError(/seed must be a finite integer/);
    expect(() => rothMcStream(1.5)).toThrowError(/seed must be a finite integer/);
    expect(typeof rothMcStream(ROTH_MC_CHECK_SEED)).toBe("function");
  });

  test("valid seeded stats output is unchanged by the fix (Phase 1 after-probe pins)", () => {
    const r = runRothMonteCarloStats(
      SMALL_BASE,
      [{ name: "Do Nothing", overrides: {} }],
      2026,
      { volatilityPct: 15, pathCount: 8, seed: ROTH_MC_CHECK_SEED },
    );
    expect(r.ok).toBe(true);
    expect(r.scenarios.length).toBe(1);
    const row = r.scenarios[0]!;
    expect(row.pathsRun).toBe(8);
    expect(row.neverShortfallRatePct).toBe(100);
    expect(row.endingAfterTaxWealthP10Cents).toBe(19585518);
    expect(row.endingAfterTaxWealthP50Cents).toBe(122378774);
    expect(row.endingAfterTaxWealthP90Cents).toBe(289874477);
  });

  test("every successful stats result samples at least one path (N=1)", () => {
    const r = runRothMonteCarloStats(
      SMALL_BASE,
      [{ name: "Do Nothing", overrides: {} }],
      2026,
      { volatilityPct: 15, pathCount: 1, seed: ROTH_MC_CHECK_SEED },
    );
    expect(r.ok).toBe(true);
    expect(r.scenarios[0]?.pathsRun).toBe(1);
  });
});

// --- Phase 2: independent numerical oracles (MC level) -------------

describe("C5 Phase 2: Monte Carlo-level oracles vs the independent reference", () => {
  test("zero return: every run is the flat 0% path, hand-computed to the cent", () => {
    // Start $100,000, spend $9,000/yr, retire 55, end 57, 0%:
    // 100,000 -> 91,000 -> 82,000 -> 73,000.
    const inputs = sampleInputs({
      startCents: 10_000_000,
      spendingCents: 900_000,
      currentAge: 55,
      retirementAge: 55,
      endAge: 57,
      extraIncomeCents: 0,
      extraIncomeStartAge: null,
    });
    const mc = runMonteCarlo(inputs, 0, 0, 12345, 25);
    const ref = refRunMonteCarlo(asRef(inputs), 0, 0, 12345, 25);
    expect(mc?.p50).toBe(7_300_000);
    expect(mc?.p10).toBe(7_300_000);
    expect(mc?.p90).toBe(7_300_000);
    expect(mc?.successRate).toBe(100);
    expect(mc?.neverOutSuccessRate).toBe(100);
    expect(mc?.p50).toBe(ref?.p50);
    expect(mc?.successRate).toBe(ref?.successRate);
  });

  test("positive deterministic return: flat +5% prices the hand-computed path", () => {
    // ($100,000-$10,000)x1.05 = $94,500; x1.05 = $88,725;
    // x1.05 = $82,661.25.
    const inputs = sampleInputs({
      startCents: 10_000_000,
      spendingCents: 1_000_000,
      currentAge: 55,
      retirementAge: 55,
      endAge: 57,
      extraIncomeCents: 0,
      extraIncomeStartAge: null,
    });
    const mc = runMonteCarlo(inputs, 0.05, 0, 12345, 25);
    expect(mc?.p50).toBe(8_266_125);
    expect(mc?.p10).toBe(8_266_125);
    expect(mc?.p90).toBe(8_266_125);
    expect(mc?.successRate).toBe(100);
  });

  test("-100% return zeroes the portfolio in the first year; below -100% floors at $0", () => {
    const inputs = sampleInputs({
      startCents: 10_000_000,
      spendingCents: 1_000_000,
      currentAge: 55,
      retirementAge: 57,
      endAge: 57,
      extraIncomeCents: 0,
      extraIncomeStartAge: null,
    });
    for (const expected of [-1, -1.5, -2]) {
      const mc = runMonteCarlo(inputs, expected, 0, 12345, 25);
      // The ending can be -0 (0 x a negative factor is -0, and
      // -0 < 0 is false so the floor leaves it): normalize
      // before comparing, as the -150% test does.
      expect((mc?.p50 ?? NaN) + 0).toBe(0);
      expect(mc?.successRate).toBe(0);
      expect(mc?.neverOutSuccessRate).toBe(0);
      const det = simulateDetailed(inputs, [expected, expected, expected]);
      expect(det.balances.map((v) => v + 0)).toEqual([10_000_000, 0, 0, 0]);
    }
  });

  test("exact funding boundary at the Monte Carlo level: spending == balance funds, +1 cent does not", () => {
    // $60,000 portfolio, retire now, one year, 0%: spending
    // $60,000 exactly equals the balance — funded. One cent
    // more is short, and the run fails on the spot.
    const base = sampleInputs({
      startCents: 6_000_000,
      currentAge: 60,
      retirementAge: 60,
      endAge: 60,
      extraIncomeCents: 0,
      extraIncomeStartAge: null,
    });
    const at = runMonteCarlo({ ...base, spendingCents: 6_000_000 }, 0, 0, 12345, 3);
    // The ending balance is $0, so the ending-balance rate is 0
    // — but every year's withdrawal was funded, so the
    // never-runs-out rate is 100.
    expect(at?.successRate).toBe(0);
    expect(at?.neverOutSuccessRate).toBe(100);
    expect(at?.p50).toBe(0);
    const over = runMonteCarlo({ ...base, spendingCents: 6_000_001 }, 0, 0, 12345, 3);
    expect(over?.successRate).toBe(0);
    expect(over?.neverOutSuccessRate).toBe(0);
    expect(over?.p50).toBe(0);
    expect(runNeverRunsOut({ ...base, spendingCents: 6_000_000 }, [0])).toBe(true);
    expect(runNeverRunsOut({ ...base, spendingCents: 6_000_001 }, [0])).toBe(false);
  });

  test("zero-then-refill by income: ending positive but never-runs-out is 0 (MC level)", () => {
    // Start $10,000, spend $20,000/yr, $50,000/yr income from
    // 56, ages 55-57, 0%: age 55 shorts ($20,000 > $10,000);
    // ages 56-57 refill to $30,000 then $60,000. Ending
    // positive, funding failed — the two rates must disagree.
    const inputs = sampleInputs({
      startCents: 1_000_000,
      spendingCents: 2_000_000,
      currentAge: 55,
      retirementAge: 55,
      endAge: 57,
      extraIncomeCents: 5_000_000,
      extraIncomeStartAge: 56,
    });
    const mc = runMonteCarlo(inputs, 0, 0, 12345, 25);
    expect(mc?.p50).toBe(6_000_000);
    expect(mc?.successRate).toBe(100);
    expect(mc?.neverOutSuccessRate).toBe(0);
  });

  test("multiple SS streams at the Monte Carlo level: $48,000 + $30,000 from 67, hand-computed", () => {
    // Sample SS anchors as a schedule. Start $2,000,000, spend
    // $100,000, ages 66-67, 0%: age 66 nets $100,000 ->
    // $1,900,000; age 67 nets $100,000 - $78,000 = $22,000 ->
    // $1,878,000.
    const inputs = sampleInputs({
      spendingCents: 10_000_000,
      currentAge: 66,
      retirementAge: 66,
      endAge: 67,
      extraIncomeCents: SAMPLE_SS_PRIMARY_CENTS,
      extraIncomeStartAge: SAMPLE_SS_PRIMARY_START_AGE,
      incomeSchedule: [
        { amountCents: SAMPLE_SS_PRIMARY_CENTS, startAge: SAMPLE_SS_PRIMARY_START_AGE },
        { amountCents: SAMPLE_SS_SPOUSE_CENTS, startAge: SAMPLE_SS_SPOUSE_START_AGE },
      ],
    });
    expect(SAMPLE_SS_PRIMARY_CENTS + SAMPLE_SS_SPOUSE_CENTS).toBe(7_800_000);
    const mc = runMonteCarlo(inputs, 0, 0, 12345, 25);
    expect(mc?.p50).toBe(187_800_000);
    const det = simulateDetailed(inputs, [0, 0]);
    expect(det.balances).toEqual([200_000_000, 190_000_000, 187_800_000]);
  });

  test("income starting after retirement: six hand-computed years to the cent", () => {
    // Retire 62, SS $78,000/yr from 67, spend $180,000, 0%:
    // 62-66 lose $180,000/yr ($2,050,000 -> $1,150,000), age 67
    // nets $180,000 - $78,000 = $102,000 -> $1,048,000.
    const inputs = sampleInputs({
      startCents: 205_000_000,
      spendingCents: 18_000_000,
      currentAge: 62,
      retirementAge: 62,
      endAge: 67,
      extraIncomeCents: SAMPLE_SS_PRIMARY_CENTS + SAMPLE_SS_SPOUSE_CENTS,
      extraIncomeStartAge: 67,
    });
    const mc = runMonteCarlo(inputs, 0, 0, 12345, 25);
    expect(mc?.p50).toBe(104_800_000);
    expect(mc?.neverOutSuccessRate).toBe(100);
  });

  test("all four strategies at zero volatility: MC p50 equals the flat-return detailed path", () => {
    for (const strategy of ["constant", "percent", "guardrails", "phased"] as const) {
      const inputs = sampleInputs({ strategy });
      const mc = runMonteCarlo(inputs, EXPECTED, 0, 12345, 25);
      const ref = refRunMonteCarlo(asRef(inputs), EXPECTED, 0, 12345, 25);
      const flat = refSimulateDetailed(
        asRef(inputs),
        Array.from({ length: 95 - 58 + 1 }, () => EXPECTED),
      );
      const ending = flat.balances[flat.balances.length - 1] ?? 0;
      expect(mc?.p50).toBe(ending);
      expect(mc?.p10).toBe(ending);
      expect(mc?.p90).toBe(ending);
      expect(mc?.p50).toBe(ref?.p50);
      expect(mc?.neverOutSuccessRate).toBe(ref?.neverOutSuccessRate);
    }
  });

  test("runNeverRunsOut agrees with the independent funding-failure oracle on MC-drawn vectors", () => {
    // For each strategy and seed, draw the reference stream's
    // first 20 return vectors and check BOTH the engine twin
    // and the derived-from-detailed verdict against the oracle.
    for (const strategy of ["constant", "percent", "guardrails", "phased"] as const) {
      const inputs = sampleInputs({ strategy });
      for (const seed of [0, 1, 12345]) {
        const rng = refMulberry32(seed * 7919 + 17);
        const years = 95 - 58 + 1;
        for (let v = 0; v < 20; v++) {
          const returns: number[] = [];
          for (let i = 0; i < years; i++) {
            returns.push(EXPECTED + VOL * refNormalRandom(rng));
          }
          const det = simulateDetailed(inputs, returns);
          const refDet = refSimulateDetailed(asRef(inputs), returns);
          expect(det.balances).toEqual(refDet.balances);
          expect(runNeverRunsOut(inputs, returns)).toBe(
            refNeverRunsOut(asRef(inputs), returns),
          );
          // The Phase 6 derivation: the verdict read off the
          // detailed run's own arrays is the same verdict.
          expect(derivedNeverOut(det, inputs)).toBe(
            runNeverRunsOut(inputs, returns),
          );
        }
      }
    }
  });

  test("neverRunsOutFromDetailed (production helper) agrees with runNeverRunsOut directly", () => {
    // Engine Review C5, NICE-4: the production helper itself had
    // no direct unit test — only the test's re-derived helper was
    // compared against runNeverRunsOut. Call the production helper
    // on the detailed run's own arrays and compare it against
    // runNeverRunsOut (and the re-derived helper) on three
    // hand-computed vectors, all at 0% returns.
    // Vector A — $0-mid-horizon-refill: start $30,000, spend
    // $20,000/yr, $50,000/yr income from 58, ages 55-59. Age 55
    // nets $20,000 -> $10,000; age 56 nets $20,000 against
    // $10,000 — the run fails mid-horizon; ages 57-59 refill on
    // the income to a $60,000 ending. Ending positive, verdict
    // false: the first failure settles it.
    const refill = sampleInputs({
      startCents: 3_000_000,
      spendingCents: 2_000_000,
      currentAge: 55,
      retirementAge: 55,
      endAge: 59,
      extraIncomeCents: 5_000_000,
      extraIncomeStartAge: 58,
    });
    const refillReturns = [0, 0, 0, 0, 0];
    const refillDet = simulateDetailed(refill, refillReturns);
    expect(refillDet.balances).toEqual([
      3_000_000, 1_000_000, 0, 0, 3_000_000, 6_000_000,
    ]);
    expect(refillDet.netWithdrawals).toEqual([
      2_000_000, 2_000_000, 2_000_000, -3_000_000, -3_000_000,
    ]);
    expect(runNeverRunsOut(refill, refillReturns)).toBe(false);
    expect(derivedNeverOut(refillDet, refill)).toBe(false);
    expect(neverRunsOutFromDetailed(refillDet, refill)).toBe(false);
    expect(neverRunsOutFromDetailed(refillDet, refill)).toBe(
      runNeverRunsOut(refill, refillReturns),
    );
    // Vector B — first-retired-year failure: start $10,000,
    // spend $20,000/yr, no income, ages 55-57. The very first
    // retired year shorts ($20,000 > $10,000).
    const firstYear = sampleInputs({
      startCents: 1_000_000,
      spendingCents: 2_000_000,
      currentAge: 55,
      retirementAge: 55,
      endAge: 57,
      extraIncomeCents: 0,
      extraIncomeStartAge: null,
    });
    const firstYearReturns = [0, 0, 0];
    const firstYearDet = simulateDetailed(firstYear, firstYearReturns);
    expect(firstYearDet.balances).toEqual([1_000_000, 0, 0, 0]);
    expect(firstYearDet.netWithdrawals).toEqual([
      2_000_000, 2_000_000, 2_000_000,
    ]);
    expect(runNeverRunsOut(firstYear, firstYearReturns)).toBe(false);
    expect(derivedNeverOut(firstYearDet, firstYear)).toBe(false);
    expect(neverRunsOutFromDetailed(firstYearDet, firstYear)).toBe(false);
    expect(neverRunsOutFromDetailed(firstYearDet, firstYear)).toBe(
      runNeverRunsOut(firstYear, firstYearReturns),
    );
    // Control — passing vector: start $100,000, spend $20,000/yr,
    // no income, ages 55-57. Every retired year's net is funded.
    const passing = sampleInputs({
      startCents: 10_000_000,
      spendingCents: 2_000_000,
      currentAge: 55,
      retirementAge: 55,
      endAge: 57,
      extraIncomeCents: 0,
      extraIncomeStartAge: null,
    });
    const passingReturns = [0, 0, 0];
    const passingDet = simulateDetailed(passing, passingReturns);
    expect(passingDet.balances).toEqual([
      10_000_000, 8_000_000, 6_000_000, 4_000_000,
    ]);
    expect(passingDet.netWithdrawals).toEqual([
      2_000_000, 2_000_000, 2_000_000,
    ]);
    expect(runNeverRunsOut(passing, passingReturns)).toBe(true);
    expect(derivedNeverOut(passingDet, passing)).toBe(true);
    expect(neverRunsOutFromDetailed(passingDet, passing)).toBe(true);
    expect(neverRunsOutFromDetailed(passingDet, passing)).toBe(
      runNeverRunsOut(passing, passingReturns),
    );
  });
});

// --- Phase 3: statistical verification -------------------------------

describe("C5 Phase 3: statistical verification vs the independent RNG", () => {
  test("first 1,000 uniform draws agree exactly per seed (0 / 1 / 12345 / large)", () => {
    for (const seed of [0, 1, 12345, 2147483647, 4294967295]) {
      const prod = mulberry32(seed);
      const ref = refMulberry32(seed);
      for (let i = 0; i < 1000; i++) {
        expect(prod()).toBe(ref());
      }
    }
  });

  test("first 1,000 Box-Muller normals agree exactly per seed (engine-seeded stream)", () => {
    for (const seed of [0, 1, 12345, 2147483647]) {
      const prod = mulberry32(seed * 7919 + 17);
      const ref = refMulberry32(seed * 7919 + 17);
      for (let i = 0; i < 1000; i++) {
        expect(normalRandom(prod)).toBe(refNormalRandom(ref));
      }
    }
  });

  test("golden shocks re-verified after RNG unification: the literals still reproduce exactly", () => {
    // The mc-golden-shocks fixture's externally computed
    // literals, re-checked here against the shared stream so a
    // unification drift cannot hide behind the fixture alone.
    const literals = [
      -1.7371168353769846, 1.0408662773034743, 1.0814420259706854,
      0.18027822825626721,
    ];
    const rng = rothMcStream(ROTH_MC_CHECK_SEED);
    const series1 = rothMcShockSeries(MC_STREAM_STRIDE_YEARS, rng);
    const series2 = rothMcShockSeries(MC_STREAM_STRIDE_YEARS, rng);
    const values = [series1[0], series1[1], series1[2], series1[3], series2[0]];
    const targets = [...literals, 1.2686864367358899];
    for (let i = 0; i < values.length; i++) {
      expect(Math.abs((values[i] ?? NaN) - (targets[i] ?? NaN))).toBeLessThanOrEqual(1e-9);
    }
    expect((values[0] ?? NaN).toFixed(10)).toBe("-1.7371168354");
    expect((values[4] ?? NaN).toFixed(10)).toBe("1.2686864367");
    // The Roth return series is the same shocks centered on the
    // plan's expected return: first value 5 + 15 x z0.
    const plan = samplePlanInputs();
    const series = rothMcReturnSeries(
      plan, 15, rothMcStream(ROTH_MC_CHECK_SEED),
    );
    expect(series.length).toBe(95 - 58 + 1);
    // The drawn shock equals the literal to 1e-9 (the fixture's
    // tolerance), so the centered return matches to 15e-9.
    expect(Math.abs((series[0] ?? NaN) - (5 + 15 * -1.7371168353769846))).toBeLessThanOrEqual(15e-9);
  });

  test("reproducibility: the same seed reproduces the full MC result; a different seed moves it", () => {
    const inputs = probeInputs();
    const a = runMonteCarlo(inputs, 0.05, 0.15, 12345, 200);
    const b = runMonteCarlo(inputs, 0.05, 0.15, 12345, 200);
    expect(a).toEqual(b);
    // The probe plan's median ending is $0 under either seed, so
    // a single figure cannot carry the difference — the whole
    // result must differ (the chart rows move), and the streams
    // themselves differ from the first draw.
    const c = runMonteCarlo(inputs, 0.05, 0.15, 777, 200);
    expect(c).not.toEqual(a);
    expect(mulberry32(777 * 7919 + 17)()).not.toBe(
      mulberry32(12345 * 7919 + 17)(),
    );
  });

  test("seeds 0 / 1 / 12345 / large: engine and reference MC agree exactly", () => {
    for (const seed of [0, 1, 12345, 2147483647]) {
      const inputs = sampleInputs({});
      const eng = runMonteCarlo(inputs, EXPECTED, VOL, seed, 100);
      const ref = refRunMonteCarlo(asRef(inputs), EXPECTED, VOL, seed, 100);
      expect(eng?.successRate).toBe(ref?.successRate);
      expect(eng?.neverOutSuccessRate).toBe(ref?.neverOutSuccessRate);
      expect(eng?.p10).toBe(ref?.p10);
      expect(eng?.p50).toBe(ref?.p50);
      expect(eng?.p90).toBe(ref?.p90);
    }
  });

  test("exact return vectors: runCount 1 prices the reference stream's first vector", () => {
    for (const seed of [0, 1, 12345]) {
      const inputs = sampleInputs({});
      const years = 95 - 58 + 1;
      const rng = refMulberry32(seed * 7919 + 17);
      const returns: number[] = [];
      for (let i = 0; i < years; i++) {
        returns.push(EXPECTED + VOL * refNormalRandom(rng));
      }
      const expectedEnding =
        refSimulateDetailed(asRef(inputs), returns).balances.slice(-1)[0] ?? 0;
      const mc = runMonteCarlo(inputs, EXPECTED, VOL, seed, 1);
      expect(mc?.p50).toBe(expectedEnding);
      expect(mc?.p10).toBe(expectedEnding);
      expect(mc?.p90).toBe(expectedEnding);
    }
  });

  test("percentile / median conventions on hand values, all five cut points", () => {
    const sorted = [10, 20, 30, 40];
    // percentile reads sorted[floor(p/100 x n)] clamped:
    // p10 -> 10, p25 -> 20, p50 -> 30, p75 -> 40, p90 -> 40.
    expect(percentile(sorted, 10)).toBe(10);
    expect(percentile(sorted, 25)).toBe(20);
    expect(percentile(sorted, 50)).toBe(30);
    expect(percentile(sorted, 75)).toBe(40);
    expect(percentile(sorted, 90)).toBe(40);
    expect(percentile(sorted, 100)).toBe(40);
    expect(percentile([], 50)).toBe(0);
    expect(medianOf(sorted)).toBe(25);
    expect(medianOf([10, 20, 30])).toBe(20);
    expect(medianOf([])).toBe(0);
  });

  test("chart p25 / p75 agree with the reference (extends the p10 / median / p90 pin)", () => {
    const inputs = sampleInputs({});
    const eng = runMonteCarlo(inputs, EXPECTED, VOL, 12345, 1000);
    const ref = refRunMonteCarlo(asRef(inputs), EXPECTED, VOL, 12345, 1000);
    expect(eng?.chart.length).toBe(Object.keys(ref?.chartByAge ?? {}).length);
    for (const age of [58, 62, 75, 95]) {
      const row = eng?.chart[age - 58];
      const r = ref?.chartByAge[age];
      expect(row).toBeDefined();
      if (!row || !r) continue;
      // Chart rows store dollars; the reference stores cents.
      // segLow = p25 - p10 and band75 = p75 - p25, so p25 and
      // p75 are recovered from the row's own segments — the
      // reconstruction goes through one add, so it is compared
      // to 10 decimal places rather than exact (1-ulp noise).
      expect(row.p10).toBe(r.p10 / 100);
      expect(row.p10 + row.segLow).toBeCloseTo(r.p25 / 100, 10);
      expect(row.p10 + row.segLow + row.band75).toBeCloseTo(r.p75 / 100, 10);
      expect(row.p90).toBe(r.p90 / 100);
    }
  });

  test("small samples 1 / 2 / 3: percentiles follow the convention on the sampled endings", () => {
    const inputs = sampleInputs({});
    for (const n of [1, 2, 3]) {
      const eng = runMonteCarlo(inputs, EXPECTED, VOL, 12345, n);
      const ref = refRunMonteCarlo(asRef(inputs), EXPECTED, VOL, 12345, n);
      expect(eng?.p10).toBe(ref?.p10);
      expect(eng?.p50).toBe(ref?.p50);
      expect(eng?.p90).toBe(ref?.p90);
      expect(eng?.successRate).toBe(ref?.successRate);
      expect(eng?.neverOutSuccessRate).toBe(ref?.neverOutSuccessRate);
      // Hand-check the convention on the reference endings:
      // n=1: all three are the one ending; n=2: p50 is the mean
      // of the two, p10 the smaller; n=3: p50 is the middle.
      const endings = [...(ref?.endings ?? [])].sort((a, b) => a - b);
      if (n === 1) {
        expect(eng?.p10).toBe(endings[0]);
        expect(eng?.p50).toBe(endings[0]);
        expect(eng?.p90).toBe(endings[0]);
      } else if (n === 2) {
        expect(eng?.p50).toBe(((endings[0] ?? 0) + (endings[1] ?? 0)) / 2);
        expect(eng?.p10).toBe(endings[0]);
      } else {
        expect(eng?.p50).toBe(endings[1]);
        expect(eng?.p10).toBe(endings[0]);
        expect(eng?.p90).toBe(endings[2]);
      }
    }
  });
});

// --- Phase 4: solver maximality --------------------------------------

describe("C5 Phase 4: solver maximality by exhaustive enumeration", () => {
  const STEP = 10000; // $100 in cents

  // Exhaustive $100-step enumeration on a small controlled
  // problem: every step from $0 to the proven ceiling
  // (starting balance + eventual income, for an
  // immediate-retirement plan) is tested with the independent
  // feasibility oracle, and the maximum feasible step is the
  // answer — no monotonicity assumed, for ANY strategy.
  // The ceiling bound is the proven ceiling ONLY because these
  // cases use the default cut 120 (cut >= 100, so the year-1
  // gross is the base spending or larger): with cut < 100 the
  // ceiling divides by the year-1 cut factor (1 - adj), and a
  // grid capped at the undivided ceiling would miss feasible
  // steps above it (C5 fix round 2, Pass B MUST-1). The
  // fix-round-2 test's gridMaxToCap enumerates to the search
  // cap instead — do not reuse this bound for a cut<100 case.
  function exhaustiveMax(
    inputs: SimInputs,
    engine: "historical" | "montecarlo",
    target: number,
    seed = 12345,
  ): number {
    const ceiling =
      inputs.startCents +
      (inputs.extraIncomeStartAge != null ? inputs.extraIncomeCents : 0);
    let best = 0;
    for (let k = 0; k * STEP <= ceiling; k++) {
      if (
        refFeasible(
          { ...asRef(inputs), spendingCents: k * STEP },
          STOCKS, EXPECTED, VOL, engine, target, seed,
        )
      ) {
        best = k * STEP;
      }
    }
    return best;
  }

  test("exhaustive enumeration: constant / phased / guardrails / percent on small problems", () => {
    const cases: { strategy: SimInputs["strategy"]; engine: "historical" | "montecarlo" }[] = [
      { strategy: "constant", engine: "historical" },
      { strategy: "constant", engine: "montecarlo" },
      { strategy: "phased", engine: "historical" },
      { strategy: "guardrails", engine: "historical" },
      { strategy: "guardrails", engine: "montecarlo" },
    ];
    for (const c of cases) {
      // $50,000 portfolio, retire now, 3 priced years, no
      // income: ceiling 500 steps, fast to enumerate.
      const inputs = sampleInputs({
        startCents: 5_000_000,
        spendingCents: 1_000_000,
        currentAge: 60,
        retirementAge: 60,
        endAge: 62,
        extraIncomeCents: 0,
        extraIncomeStartAge: null,
        strategy: c.strategy,
      });
      const eng = solveMaxSpending(inputs, STOCKS, EXPECTED, VOL, c.engine, 85, 12345);
      const grid = exhaustiveMax(inputs, c.engine, 85);
      expect(eng?.maxSpendingCents, `${c.strategy}/${c.engine} grid max`).toBe(grid);
      expect(eng?.solutionStatus).toBe("feasible");
      // The winner reaches the target by the independent oracle,
      // and the next $100 step does not — except guardrails,
      // where the next step may be feasible again higher up;
      // the grid max already proves no HIGHER step is feasible.
      expect(
        refFeasible(
          { ...asRef(inputs), spendingCents: eng?.maxSpendingCents ?? 0 },
          STOCKS, EXPECTED, VOL, c.engine, 85, 12345,
        ),
        `${c.strategy}/${c.engine} winner feasible`,
      ).toBe(true);
    }
    // Percent on a small problem: enumerate the percent steps.
    const pctInputs = sampleInputs({
      startCents: 5_000_000,
      spendingCents: 1_000_000,
      currentAge: 60,
      retirementAge: 60,
      endAge: 62,
      extraIncomeCents: 0,
      extraIncomeStartAge: null,
      strategy: "percent",
    });
    const pctEng = solveMaxSpending(pctInputs, STOCKS, EXPECTED, VOL, "historical", 85, 12345);
    const maxSteps = Math.floor((5_000_000 * 0.3) / STEP);
    let pctBest = 0;
    for (let k = 0; k <= maxSteps; k++) {
      const pct = (k * STEP * 100) / 5_000_000;
      if (
        refFeasible(
          { ...asRef(pctInputs), percentOfPortfolio: pct },
          STOCKS, EXPECTED, VOL, "historical", 85, 12345,
        )
      ) {
        pctBest = k;
      }
    }
    expect(pctEng?.maxSpendingCents).toBe(pctBest * STEP);
  }, 120_000);

  test("solver-vs-display identity: the winner's rate and median equal the tab engines at the solved spending", () => {
    for (const strategy of ["constant", "guardrails"] as const) {
      for (const engine of ["historical", "montecarlo"] as const) {
        const inputs = sampleInputs({ strategy });
        const solved = solveMaxSpending(inputs, STOCKS, EXPECTED, VOL, engine, engine === "historical" ? 95 : 85, 12345);
        expect(solved).not.toBeNull();
        if (!solved) continue;
        const priced = { ...inputs, spendingCents: solved.maxSpendingCents };
        if (engine === "historical") {
          const h = runHistorical(priced, STOCKS);
          expect(h).not.toBeNull();
          if (!h) continue;
          expect(solved.successRate).toBe(h.neverOutSuccessRate);
          expect(solved.medianEnding).toBe(h.medianEnding);
        } else {
          const mc = runMonteCarlo(priced, EXPECTED, VOL, 12345, 1000);
          expect(mc).not.toBeNull();
          if (!mc) continue;
          expect(solved.successRate).toBe(mc.neverOutSuccessRate);
          expect(solved.medianEnding).toBe(mc.p50);
        }
      }
    }
  }, 120_000);

  test("solver reproducibility: solving twice returns the identical result", () => {
    const a = solveMaxSpending(sampleInputs({}), STOCKS, EXPECTED, VOL, "historical", 95, 12345);
    const b = solveMaxSpending(sampleInputs({}), STOCKS, EXPECTED, VOL, "historical", 95, 12345);
    expect(a).toEqual(b);
  });

  test("late income: the solver's ceiling uses the eventual income, not the first-year income", () => {
    // Retire 57, SS $48,000/yr from 67, $50,000 portfolio, 3
    // priced years is too short for the income to matter — so
    // a 10-year span: the income starts in year 11 of the
    // horizon... use ages 57-66 (10 years), income from 67 is
    // OUTSIDE the horizon, so instead: retire 60, end 69,
    // income from 67 — the income revives a zeroed balance in
    // years 67-69, and the ceiling must count it.
    const inputs = sampleInputs({
      startCents: 5_000_000,
      spendingCents: 1_000_000,
      currentAge: 60,
      retirementAge: 60,
      endAge: 69,
      extraIncomeCents: 4_800_000,
      extraIncomeStartAge: 67,
      strategy: "guardrails",
    });
    const eng = solveMaxSpending(inputs, STOCKS, EXPECTED, VOL, "historical", 85, 12345);
    // Independent ceiling: best balance at retirement (here the
    // $50,000 starting balance — retirement is immediate) plus
    // the eventual $48,000 income = $98,000 -> 980 steps.
    // Enumerate the whole grid with the oracle.
    let gridMax = 0;
    for (let k = 0; k <= 980; k++) {
      if (
        refFeasible(
          { ...asRef(inputs), spendingCents: k * STEP },
          STOCKS, EXPECTED, VOL, "historical", 85, 12345,
        )
      ) {
        gridMax = k * STEP;
      }
    }
    expect(eng?.maxSpendingCents).toBe(gridMax);
    expect(eng?.solutionStatus).toBe("feasible");
    // The late income genuinely matters: without it the same
    // grid caps at the $50,000 balance.
    const noIncome = { ...inputs, extraIncomeCents: 0, extraIncomeStartAge: null as number | null };
    const engNoIncome = solveMaxSpending(noIncome, STOCKS, EXPECTED, VOL, "historical", 85, 12345);
    expect(engNoIncome?.maxSpendingCents).toBeLessThan(eng?.maxSpendingCents ?? 0);
  }, 120_000);

  test("ceiling step is inclusive: the spending exactly at the ceiling is fundable, $100 above it is not", () => {
    // $100,000 portfolio, $50,000/yr income from retirement,
    // one priced year: the scan ceiling is $100,000 + $50,000
    // = $150,000. At $150,000 the first-year net withdrawal
    // ($100,000) exactly equals the balance — funded, not
    // short — while $150,100 is short on the spot. Both the
    // engine twin and the independent oracle agree.
    //
    // For THESE numbers the ceiling step is infeasible with
    // two retired years (year 1 leaves $0, so year 2's net
    // withdrawal of $100,000 exceeds the $0 balance) — but
    // that is specific to this shape, not a general rule: in
    // general the ceiling step IS reachable as a solver answer
    // (see the next test), and the descending scan correctly
    // returns it when it is the maximum. The inclusive bound
    // is pinned here at the predicate the scan decides every
    // step by, and the solver's refusal of a one-retired-year
    // plan (retirementAge >= endAge returns null) is pinned
    // alongside — the scan can include the ceiling step, which
    // is exactly the Prompt 13 fix's intent.
    const base = sampleInputs({
      startCents: 10_000_000,
      spendingCents: 10_000_000,
      currentAge: 60,
      retirementAge: 60,
      endAge: 60,
      extraIncomeCents: 5_000_000,
      extraIncomeStartAge: 60,
    });
    expect(runNeverRunsOut({ ...base, spendingCents: 15_000_000 }, [0])).toBe(true);
    expect(runNeverRunsOut({ ...base, spendingCents: 15_010_000 }, [0])).toBe(false);
    expect(refNeverRunsOut(asRef({ ...base, spendingCents: 15_000_000 }), [0])).toBe(true);
    expect(refNeverRunsOut(asRef({ ...base, spendingCents: 15_010_000 }), [0])).toBe(false);
    expect(solveMaxSpending(base, STOCKS, 0, 0, "montecarlo", 85, 12345)).toBeNull();
    // And the ceiling arithmetic itself: best balance at
    // retirement ($100,000 — retirement is immediate) plus the
    // eventual $50,000 income is the $150,000 step.
    expect(10_000_000 + 5_000_000).toBe(15_000_000);
  });

  test("ceiling step is reachable: the solver returns it when it is the maximum (C5 fix round)", () => {
    // Pass A Finding 2: the ceiling step is NOT in general
    // unreachable through the solver. With a $0 portfolio the
    // ceiling step equals the eventual income, so the year-1
    // and year-2 nets are both $0 and the step survives two
    // retired years — the solver returns it, correctly, as
    // the enumerated maximum. Same for a $50 portfolio (the
    // $100-step rounding slack covers year 2). Control: the
    // $100,000 + $50,000 shape's ceiling ($150,000) stays
    // infeasible with two retired years (solver $105,200,
    // agreeing with the grid in the probe).
    for (const startCents of [0, 5_000]) {
      const inputs = sampleInputs({
        startCents,
        spendingCents: 1_000_000,
        currentAge: 60,
        retirementAge: 60,
        endAge: 61,
        extraIncomeCents: 5_000_000,
        extraIncomeStartAge: 60,
        strategy: "guardrails",
      });
      const eng = solveMaxSpending(inputs, STOCKS, 0, 0, "montecarlo", 85, 12345);
      expect(eng?.maxSpendingCents, `start ${startCents}`).toBe(5_000_000);
      expect(eng?.solutionStatus).toBe("feasible");
    }
    const control = sampleInputs({
      startCents: 10_000_000,
      spendingCents: 1_000_000,
      currentAge: 60,
      retirementAge: 60,
      endAge: 61,
      extraIncomeCents: 5_000_000,
      extraIncomeStartAge: 60,
      strategy: "guardrails",
    });
    const engControl = solveMaxSpending(control, STOCKS, 0, 0, "montecarlo", 85, 12345);
    expect(engControl?.maxSpendingCents).toBe(10_520_000);
  });

  test("guardrails cut<100: the solver returns the exhaustive maximum, not the first-year-filter cap (C5 fix round)", () => {
    // Pass A Finding 1: with guardrailsCutPct < 100 the cut
    // rail fires in year 1 (current rate == initial rate), so
    // the true year-1 gross is round(cents * (1 - adj)), not
    // the base spending — the old first-year filter assumed
    // the base spending, overstated the year-1 net, and
    // rejected every step above $100,000. Construction:
    // guardrails cut 80 / raise 70 / adj 10, start $100,000,
    // ages 60-61 (2 retired years), $500,000/yr income
    // starting in year 2 only. The true maximum is $111,100
    // (0.9 x $111,100 = $99,990 passes year 1 on the $100,000
    // balance; year 2 survives on the income) on all three
    // legs; the pre-fix solver returned $100,000.
    const base = sampleInputs({
      startCents: 10_000_000,
      spendingCents: 1_000_000,
      currentAge: 60,
      retirementAge: 60,
      endAge: 61,
      extraIncomeCents: 50_000_000,
      extraIncomeStartAge: 61,
      strategy: "guardrails",
      guardrailsCutPct: 80,
      guardrailsRaisePct: 70,
      guardrailsAdjustmentPct: 10,
    });
    const legs: {
      engine: "historical" | "montecarlo";
      expected: number;
      vol: number;
    }[] = [
      { engine: "montecarlo", expected: 0, vol: 0 },
      { engine: "montecarlo", expected: EXPECTED, vol: VOL },
      { engine: "historical", expected: EXPECTED, vol: VOL },
    ];
    // The grid below is enumerated to the old ceiling
    // ($600,000). That bound is complete for THIS construction
    // only: the income starts in year 2, so the year-1 income
    // is $0 and a step above $111,111 fails year 1 outright
    // (0.9 x cents exceeds the $100,000 balance) — the grid
    // already covers every step that could pass year 1. In
    // general a cut<100 grid must enumerate ABOVE the undivided
    // ceiling (see gridMaxToCap in the fix-round-2 test below).
    const gridMax = (
      inputs: SimInputs,
      engine: "historical" | "montecarlo",
      expected: number,
      vol: number,
    ): number => {
      const ceiling =
        inputs.startCents +
        (inputs.extraIncomeStartAge != null ? inputs.extraIncomeCents : 0);
      let best = 0;
      for (let k = 0; k * STEP <= ceiling; k++) {
        if (
          refFeasible(
            { ...asRef(inputs), spendingCents: k * STEP },
            STOCKS, expected, vol, engine, 85, 12345,
          )
        ) {
          best = k * STEP;
        }
      }
      return best;
    };
    for (const leg of legs) {
      const eng = solveMaxSpending(base, STOCKS, leg.expected, leg.vol, leg.engine, 85, 12345);
      expect(
        eng?.maxSpendingCents,
        `${leg.engine} expected=${leg.expected} vol=${leg.vol}`,
      ).toBe(11_110_000);
      expect(eng?.maxSpendingCents).toBe(
        gridMax(base, leg.engine, leg.expected, leg.vol),
      );
    }
    // Cut 99 — one point below the rail boundary — same
    // construction, same true maximum on all three legs
    // (the pre-fix solver returned $100,000 here too).
    const cut99 = { ...base, guardrailsCutPct: 99 };
    for (const leg of legs) {
      const eng = solveMaxSpending(cut99, STOCKS, leg.expected, leg.vol, leg.engine, 85, 12345);
      expect(
        eng?.maxSpendingCents,
        `cut99 ${leg.engine} expected=${leg.expected} vol=${leg.vol}`,
      ).toBe(11_110_000);
      expect(eng?.maxSpendingCents).toBe(
        gridMax(cut99, leg.engine, leg.expected, leg.vol),
      );
    }
  }, 120_000);

  test("guardrails cut<100: the scan ceiling divides by the year-1 cut factor (C5 fix round 2, Pass B MUST-1)", () => {
    // Pass B MUST-1: the scan ceiling (best balance at retirement
    // plus the eventual income) is NOT a proven upper bound when
    // guardrailsCutPct < 100. The cut rail fires in year 1, so the
    // year-1 gross is round(cents * (1 - adj)), not the base
    // spending, and a step above the old ceiling can still pass
    // year 1 and survive later years on the income. Construction:
    // guardrails cut 80 / raise 70 / adj 10, start $100,000,
    // ages 60-61 (2 retired years), $800,000/yr income from age
    // 60. The old ceiling is $100,000 + $800,000 = $900,000;
    // the pre-fix solver returned $900,000 on all three legs
    // while the true maximum is $994,100 on the vol-0 leg
    // (expected 0; $994,300 at expected 5% in the Pass B probe). The grid below
    // is enumerated to the SEARCH CAP ($1,000,000/yr) — ABOVE
    // the old ceiling — with the independent oracle, so it does
    // not assume the ceiling it is meant to check. The cap step
    // count mirrors solveMaxSpending: max(start * 2, $1,000,000)
    // in $100 steps.
    const base = sampleInputs({
      startCents: 10_000_000,
      spendingCents: 9_600_000,
      currentAge: 60,
      retirementAge: 60,
      endAge: 61,
      extraIncomeCents: 80_000_000,
      extraIncomeStartAge: 60,
      strategy: "guardrails",
      guardrailsCutPct: 80,
      guardrailsRaisePct: 70,
      guardrailsAdjustmentPct: 10,
    });
    const legs: {
      engine: "historical" | "montecarlo";
      expected: number;
      vol: number;
    }[] = [
      { engine: "montecarlo", expected: 0, vol: 0 },
      { engine: "montecarlo", expected: EXPECTED, vol: VOL },
      { engine: "historical", expected: EXPECTED, vol: VOL },
    ];
    const gridMaxToCap = (
      inputs: SimInputs,
      engine: "historical" | "montecarlo",
      expected: number,
      vol: number,
    ): number => {
      const capSteps = Math.max(
        1,
        Math.floor(
          Math.max(inputs.startCents * 2, 100_000_000) / STEP,
        ),
      );
      let best = 0;
      for (let k = 0; k <= capSteps; k++) {
        if (
          refFeasible(
            { ...asRef(inputs), spendingCents: k * STEP },
            STOCKS, expected, vol, engine, 85, 12345,
          )
        ) {
          best = k * STEP;
        }
      }
      return best;
    };
    const expectSolverIsGridMax = (
      inputs: SimInputs,
      label: string,
      pinned: Record<string, number> = {},
    ) => {
      for (const leg of legs) {
        const eng = solveMaxSpending(inputs, STOCKS, leg.expected, leg.vol, leg.engine, 85, 12345);
        const grid = gridMaxToCap(inputs, leg.engine, leg.expected, leg.vol);
        expect(
          eng?.maxSpendingCents,
          `${label} ${leg.engine} expected=${leg.expected} vol=${leg.vol}`,
        ).toBe(grid);
        const pin = pinned[`${leg.engine}-${leg.vol}`];
        if (pin !== undefined) expect(eng?.maxSpendingCents).toBe(pin);
      }
    };
    // Main repro: solver == grid max on all three legs, with
    // the pinned maxima (vol 0 $994,100; MC vol 0.18 $993,700;
    // historical $993,800 at STOCKS 75).
    expectSolverIsGridMax(base, "cut80/adj10/2yr", {
      "montecarlo-0": 99_410_000,
      "montecarlo-0.18": 99_370_000,
      "historical-0.18": 99_380_000,
    });
    for (const leg of legs) {
      const eng = solveMaxSpending(base, STOCKS, leg.expected, leg.vol, leg.engine, 85, 12345);
      expect(eng?.solutionStatus).toBe("feasible");
    }
    // Cut 99 — one point below the rail boundary — same maxima
    // on all three legs (the pre-fix solver returned $900,000
    // here too).
    expectSolverIsGridMax(
      { ...base, guardrailsCutPct: 99 },
      "cut99/adj10/2yr",
      {
        "montecarlo-0": 99_410_000,
        "montecarlo-0.18": 99_370_000,
        "historical-0.18": 99_380_000,
      },
    );
    // Three retired years: the hole persists, same vol-0
    // maximum ($994,100); the noisy legs shift by one step.
    expectSolverIsGridMax(
      { ...base, endAge: 62 },
      "cut80/adj10/3yr",
      {
        "montecarlo-0": 99_410_000,
        "montecarlo-0.18": 99_360_000,
        "historical-0.18": 99_380_000,
      },
    );
    // Adj 50 (the effective clamp maximum): the true vol-0
    // maximum ($1,068,300, pinned by the flat-vector oracle
    // below) sits ABOVE the search cap, so the solver must
    // honestly report the cap step as "capped" on all legs —
    // and the grid to the cap must agree the cap step is the
    // maximum within the search.
    const adj50 = { ...base, guardrailsAdjustmentPct: 50 };
    for (const leg of legs) {
      const eng = solveMaxSpending(adj50, STOCKS, leg.expected, leg.vol, leg.engine, 85, 12345);
      expect(
        eng?.maxSpendingCents,
        `adj50 ${leg.engine} expected=${leg.expected} vol=${leg.vol}`,
      ).toBe(100_000_000);
      expect(eng?.solutionStatus).toBe("capped");
      expect(eng?.maxSpendingCents).toBe(
        gridMaxToCap(adj50, leg.engine, leg.expected, leg.vol),
      );
    }
    // The adj-50 vol-0 true maxima above the cap, by the
    // independent oracle on the flat return vector (exact at
    // vol 0: all 1,000 runs draw the same returns). With three
    // retired years the maximum is $1,068,300 — the raise fires
    // in the later years and caps it — and with two retired
    // years it is $1,799,900. Either way the true maximum sits
    // far above the $1,000,000 search cap, so "capped" is the
    // honest status on every leg.
    const flatMax = (
      inputs: SimInputs,
      flat: number[],
      maxStep: number,
    ): number => {
      let best = 0;
      for (let k = 0; k <= maxStep; k++) {
        if (
          refNeverRunsOut(
            asRef({ ...inputs, spendingCents: k * STEP }),
            flat,
          )
        ) {
          best = k * STEP;
        }
      }
      return best;
    };
    expect(flatMax({ ...adj50, endAge: 62 }, [0.05, 0.05, 0.05], 12000)).toBe(106_830_000);
    expect(flatMax(adj50, [0.05, 0.05], 20000)).toBe(179_990_000);
    // Controls pinning the boundary: cut = 100 exactly (no cut
    // fires — the undivided ceiling is sound) and adj = 0 (the
    // cut fires but multiplies by 1, so gross == base spending)
    // both agree with the grid on all three legs.
    expectSolverIsGridMax(
      { ...base, guardrailsCutPct: 100, guardrailsRaisePct: 120 },
      "control cut100/raise120",
      {
        "montecarlo-0": 81_330_000,
        "montecarlo-0.18": 81_300_000,
        "historical-0.18": 81_310_000,
      },
    );
    expectSolverIsGridMax(
      { ...base, guardrailsAdjustmentPct: 0 },
      "control adj0",
      {
        "montecarlo-0": 85_000_000,
        "montecarlo-0.18": 84_630_000,
        "historical-0.18": 84_750_000,
      },
    );
  }, 180_000);

  test("guardrails capped boundary: a ceiling past the search cap reports capped at $1,000,000/yr", () => {
    // $100,000 portfolio, $1,200,000/yr income from 60, ages
    // 60-61: the scan ceiling ($1,300,000) exceeds the search
    // cap ($1,000,000/yr), so the cap step is the answer.
    const inputs = sampleInputs({
      startCents: 10_000_000,
      spendingCents: 10_000_000,
      currentAge: 60,
      retirementAge: 60,
      endAge: 61,
      extraIncomeCents: 120_000_000,
      extraIncomeStartAge: 60,
      strategy: "guardrails",
    });
    const eng = solveMaxSpending(inputs, STOCKS, 0, 0, "montecarlo", 85, 12345);
    expect(eng?.solutionStatus).toBe("capped");
    expect(eng?.maxSpendingCents).toBe(100_000_000);
    expect(eng?.targetAchieved).toBe(true);
  });

  test("median ending at the solved spending equals the reference median exactly", () => {
    const inputs = sampleInputs({});
    const solved = solveMaxSpending(inputs, STOCKS, EXPECTED, VOL, "historical", 95, 12345);
    expect(solved).not.toBeNull();
    if (!solved) return;
    const at = refNeverOutRateAt(
      { ...asRef(inputs), spendingCents: solved.maxSpendingCents },
      STOCKS, EXPECTED, VOL, "historical", 12345,
    );
    expect(solved.successRate).toBe(at.successRate);
    expect(at.successes).toBe(58);
  });
});

// --- Phase 5: Roth MC parity -----------------------------------------

describe("C5 Phase 5: Roth Monte Carlo parity", () => {
  test("scenario alone vs batched: a scenario's row is identical alone or batched", () => {
    const alone = runRothMonteCarloStats(
      SMALL_BASE,
      [{ name: "Do Nothing", overrides: {} }],
      2026,
      { volatilityPct: 15, pathCount: 8, seed: ROTH_MC_CHECK_SEED },
    );
    const batched = runRothMonteCarloStats(
      SMALL_BASE,
      [
        { name: "Do Nothing", overrides: {} },
        { name: "Fill 12%", overrides: FILL12 },
      ],
      2026,
      { volatilityPct: 15, pathCount: 8, seed: ROTH_MC_CHECK_SEED },
    );
    expect(batched.ok).toBe(true);
    expect(batched.scenarios.length).toBe(2);
    expect(batched.scenarios[0]).toEqual(alone.scenarios[0]);
    // The second scenario's row is the same batched alone.
    const fillAlone = runRothMonteCarloStats(
      SMALL_BASE,
      [{ name: "Fill 12%", overrides: FILL12 }],
      2026,
      { volatilityPct: 15, pathCount: 8, seed: ROTH_MC_CHECK_SEED },
    );
    expect(batched.scenarios[1]).toEqual(fillAlone.scenarios[0]);
  });

  test("ordering independence: swapping scenario order swaps the rows, values unchanged", () => {
    const ab = runRothMonteCarloStats(
      SMALL_BASE,
      [
        { name: "Do Nothing", overrides: {} },
        { name: "Fill 12%", overrides: FILL12 },
      ],
      2026,
      { volatilityPct: 15, pathCount: 8, seed: ROTH_MC_CHECK_SEED },
    );
    const ba = runRothMonteCarloStats(
      SMALL_BASE,
      [
        { name: "Fill 12%", overrides: FILL12 },
        { name: "Do Nothing", overrides: {} },
      ],
      2026,
      { volatilityPct: 15, pathCount: 8, seed: ROTH_MC_CHECK_SEED },
    );
    expect(ba.scenarios[0]).toEqual(ab.scenarios[1]);
    expect(ba.scenarios[1]).toEqual(ab.scenarios[0]);
  });

  test("seed reproducibility: the check and the stats run reproduce exactly", () => {
    const opt = getOpt();
    const winner = { spec: opt.winner.spec, claimAges: opt.winner.claimAges };
    const dn = { spec: opt.doNothing.spec, claimAges: opt.doNothing.claimAges };
    const plan = samplePlanInputs();
    const c1 = runRothMonteCarloCheck(plan, winner, dn, {
      volatilityPct: 15, pathCount: 8, seed: ROTH_MC_CHECK_SEED,
    });
    const c2 = runRothMonteCarloCheck(plan, winner, dn, {
      volatilityPct: 15, pathCount: 8, seed: ROTH_MC_CHECK_SEED,
    });
    expect(c1).toEqual(c2);
    const s1 = runRothMonteCarloStats(
      SMALL_BASE,
      [{ name: "Do Nothing", overrides: {} }],
      2026,
      { volatilityPct: 15, pathCount: 8, seed: ROTH_MC_CHECK_SEED },
    );
    const s2 = runRothMonteCarloStats(
      SMALL_BASE,
      [{ name: "Do Nothing", overrides: {} }],
      2026,
      { volatilityPct: 15, pathCount: 8, seed: ROTH_MC_CHECK_SEED },
    );
    expect(s1).toEqual(s2);
    // A different seed moves the check.
    const c3 = runRothMonteCarloCheck(plan, winner, dn, {
      volatilityPct: 15, pathCount: 8, seed: 777,
    });
    expect(c3.medianAdvantage).not.toBe(c1.medianAdvantage);
  }, 300_000);

  test("zero-volatility identity on the sample household: the check equals the deterministic optimizer costs", () => {
    const opt = getOpt();
    const winner = { spec: opt.winner.spec, claimAges: opt.winner.claimAges };
    const dn = { spec: opt.doNothing.spec, claimAges: opt.doNothing.claimAges };
    const r = runRothMonteCarloCheck(samplePlanInputs(), winner, dn, {
      volatilityPct: 0, pathCount: 8, seed: ROTH_MC_CHECK_SEED,
    });
    const detAdvantage =
      Math.round((opt.doNothing.cost.netCost - opt.winner.cost.netCost) * 100) / 100;
    const r2 = (n: number): number => Math.round(n * 100) / 100;
    expect(r.wins).toBe(detAdvantage > 0 ? 8 : 0);
    expect(r.medianAdvantage).toBe(detAdvantage);
    expect(r.winnerMedianNetCost).toBe(r2(opt.winner.cost.netCost));
    expect(r.doNothingMedianNetCost).toBe(r2(opt.doNothing.cost.netCost));
    expect(r.p10Advantage).toBe(detAdvantage);
    expect(r.p90Advantage).toBe(detAdvantage);
  }, 300_000);

  test("check-vs-stats same-path parity: with aligned inputs the Do Nothing medians agree to the cent", () => {
    // The two entry points price different input shapes BY
    // DESIGN — the check takes engine inputs as given; the
    // stats run builds from the saved record (yields from the
    // record, the embedded net ACA premium derived inside
    // planInputsFromSaved). Unaligned, the medians legitimately
    // differ: probed on the sample household at N=40, vol 15,
    // the stats DN median is $869,547.11 with no yields on the
    // base (vs the check's $944,804.46 — a $75,257.35 gap from
    // the missing yield income) and $946,388.40 with yields
    // (a $1,583.94 gap from the $13,147.20/yr embedded net ACA
    // premium the saved build carries and the check plan does
    // not). With the inputs aligned — yields on the base, the
    // derived embedded premium carried onto the check plan —
    // the same seed prices the same 40 paths, and the medians
    // agree exactly. (The two medians round through different
    // seams — dollars vs integer cents — so a 1-cent seam is
    // possible in principle; on these fixed inputs it is 0.)
    const opt = getOpt();
    const winner = { spec: opt.winner.spec, claimAges: opt.winner.claimAges };
    const dn = { spec: opt.doNothing.spec, claimAges: opt.doNothing.claimAges };
    const built = planInputsFromSaved(SAMPLE_BASE, 2026);
    expect(built).not.toBeNull();
    const plan = {
      ...samplePlanInputs(),
      acaEmbeddedNetPremium: built?.acaEmbeddedNetPremium,
    };
    const check = runRothMonteCarloCheck(plan, winner, dn, {
      volatilityPct: 15, pathCount: 40, seed: ROTH_MC_CHECK_SEED,
    });
    const stats = runRothMonteCarloStats(
      SAMPLE_BASE,
      [{ name: "Do Nothing", overrides: {} }],
      2026,
      { volatilityPct: 15, pathCount: 40, seed: ROTH_MC_CHECK_SEED },
    );
    expect(stats.ok).toBe(true);
    expect(stats.scenarios[0]?.pathsRun).toBe(40);
    expect(stats.scenarios[0]?.netCostP50Cents).toBe(
      Math.round(check.doNothingMedianNetCost * 100),
    );
  }, 300_000);

  test("small-N self-consistency: summary statistics are computed from the reported paths", () => {
    const opt = getOpt();
    const winner = { spec: opt.winner.spec, claimAges: opt.winner.claimAges };
    const dn = { spec: opt.doNothing.spec, claimAges: opt.doNothing.claimAges };
    for (const n of [1, 2, 3]) {
      const r = runRothMonteCarloCheck(samplePlanInputs(), winner, dn, {
        volatilityPct: 15, pathCount: n, seed: ROTH_MC_CHECK_SEED,
      });
      expect(r.pathsRun).toBe(n);
      expect(r.wins).toBe(r.paths.filter((p) => p.advantage > 0).length);
      expect(r.winRatePct).toBe(Math.round((r.wins / n) * 1000) / 10);
      const advs = r.paths.map((p) => p.advantage).sort((a, b) => a - b);
      expect(r.medianAdvantage).toBe(
        Math.round(medianOf(advs) * 100) / 100,
      );
      expect(r.p10Advantage).toBe(
        Math.round(percentile(advs, 10) * 100) / 100,
      );
      expect(r.p90Advantage).toBe(
        Math.round(percentile(advs, 90) * 100) / 100,
      );
    }
  }, 300_000);

  test("shortfall / unpaid-tax frequencies are internally consistent at volatility 15", () => {
    const r = runRothMonteCarloStats(
      SMALL_BASE,
      [
        { name: "Do Nothing", overrides: {} },
        { name: "Overspend", overrides: { annualSpendingCents: 40000000 } },
      ],
      2026,
      { volatilityPct: 15, pathCount: 8, seed: ROTH_MC_CHECK_SEED },
    );
    expect(r.ok).toBe(true);
    for (const row of r.scenarios) {
      expect(row.pathsRun).toBe(8);
      expect(row.neverShortfallRatePct).toBe(
        Math.round(((8 - row.pathsWithShortfall) / 8) * 1000) / 10,
      );
      expect(row.fullyFundedRatePct).toBeLessThanOrEqual(
        row.neverShortfallRatePct,
      );
      expect(row.totalShortfallP50Cents).toBeGreaterThanOrEqual(0);
      expect(row.totalShortfallP90Cents).toBeGreaterThanOrEqual(
        row.totalShortfallP50Cents,
      );
      expect(row.endingAfterTaxWealthP10Cents).toBeLessThanOrEqual(
        row.endingAfterTaxWealthP50Cents,
      );
      expect(row.endingAfterTaxWealthP50Cents).toBeLessThanOrEqual(
        row.endingAfterTaxWealthP90Cents,
      );
      expect(row.netCostP10Cents).toBeLessThanOrEqual(row.netCostP50Cents);
      expect(row.netCostP50Cents).toBeLessThanOrEqual(row.netCostP90Cents);
    }
    // The Overspend scenario shorts on every path at this size.
    const over = r.scenarios[1]!;
    expect(over.pathsWithShortfall).toBe(8);
    expect(over.neverShortfallRatePct).toBe(0);
    expect(over.fullyFundedRatePct).toBe(0);
    expect(over.totalShortfallP50Cents).toBeGreaterThan(0);
  });
});
