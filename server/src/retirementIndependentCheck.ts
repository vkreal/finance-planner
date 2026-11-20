// Independent verification implementation for the Retirement
// engines (Engine Review 2, E2-V1).
//
// This file re-derives the Retirement simulation and max-spending
// results FROM THE DOCUMENTED SEMANTICS, without calling any of the
// engine's simulation or solver helpers. It imports NOTHING from
// retirementEngines.ts — not even a constant: the values it needs
// (1,000 Monte Carlo runs, the default seed 12345, the $100 solver
// step, the guardrails defaults 120/80/10 and the 1e-9 rail
// tolerance, the 30% percent cap) are restated here from the
// documented semantics, so a drift in the engine's constants would
// show up as a disagreement rather than being inherited. Its only
// import is the HISTORICAL dataset itself (data, not a helper) from
// retirementData.ts.
//
// What it reimplements, from the semantics the engine comments
// document:
//   - mulberry32 + Box-Muller normal draws, and the Monte Carlo
//     stream (seed*7919+17, planYears draws per run of
//     expected + vol * normal).
//   - Historical real returns: (1+stock)/(1+cpi)-1 blended by the
//     stocks mix, same as the dataset's nominal percents imply.
//   - The year loop: spending (net of extra income) withdrawn
//     BEFORE that year's return; balance floored at 0; a run
//     succeeds (never runs out) only if every retired year's net
//     withdrawal was fully funded when due — a later income
//     surplus refilling a zeroed balance does NOT rescue it.
//   - The inclusive horizon: endAge - currentAge + 1 priced years.
//   - Percentile sorted[floor(p/100*n)] clamped; median the middle
//     (or mean of two middles).
//   - The solver: $100 steps; binary search for constant/phased/
//     percent (monotone); exhaustive $100 scan for guardrails
//     (NOT monotone) up to the proven ceiling (best balance at
//     retirement + eventual income, inclusive of the ceiling step),
//     with the search cap (twice the starting portfolio, floored
//     at $1,000,000/yr) and the percent leg's 30% cap.
//   - The feasibility statuses (E2-S1): feasible / feasible_at_zero
//     / infeasible_at_zero / capped, derived from the same branch
//     structure the solver documents.
//
// The test file retirementIndependentCheck.test.ts compares this
// implementation against the engine on pinned scenarios (including
// the fictional sample household) and against HAND-COMPUTED
// balances for small deterministic scenarios. Expected values in
// those tests are hand arithmetic or this file's output — NEVER
// copied from engine output. If this file and the engine ever
// disagree, that disagreement is a finding, not a re-pin: one of
// the two implementations is wrong against the documented
// semantics, and the test names which figure moved.

import { HISTORICAL } from "./retirementData";
// Byte-budgeted cache (Engine Review C7 architecture, §2.3–§2.4): pure
// container + estimator, no engine helper — the independence rule above
// (no imports from retirementEngines.ts) stands.
import { ByteBudgetCache, estimateValueBytes } from "./byteBudgetCache";

export const REF_MONTE_CARLO_RUNS = 1000;
export const REF_MONTE_CARLO_SEED_DEFAULT = 12345;
export const REF_SOLVER_STEP_CENTS = 10000; // $100
export const REF_PERCENT_CAP_PCT = 30;
export const REF_GUARDRAILS_CUT_DEFAULT = 120;
export const REF_GUARDRAILS_RAISE_DEFAULT = 80;
export const REF_GUARDRAILS_ADJUSTMENT_DEFAULT = 10;
export const REF_GUARDRAILS_RATE_REL_TOLERANCE = 1e-9;

export type RefStrategy = "constant" | "percent" | "guardrails" | "phased";

export type RefInputs = {
  startCents: number;
  spendingCents: number;
  currentAge: number;
  retirementAge: number;
  endAge: number;
  extraIncomeCents: number;
  extraIncomeStartAge: number | null;
  strategy: RefStrategy;
  percentOfPortfolio: number;
  guardrailsCutPct: number;
  guardrailsRaisePct: number;
  guardrailsAdjustmentPct: number;
  phaseStartAge: number;
  phaseDeclinePct: number;
};

export function refHorizonYears(currentAge: number, endAge: number): number {
  return Math.max(0, endAge - currentAge + 1);
}

// mulberry32, reimplemented from the published algorithm: a
// 32-bit state, advanced by 0x6D2B79F5 per draw, mixed with
// integer multiplies and xorshifts, returned as [0, 1).
export function refMulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Box-Muller: two uniform draws (re-drawn while exactly 0) become
// one standard normal.
export function refNormalRandom(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

export function refPercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((p / 100) * sorted.length)),
  );
  return sorted[idx] ?? 0;
}

export function refMedianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1
    ? (s[mid] ?? 0)
    : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

// Blended real return for each historical year at a given mix:
// the year's stock and bond nominal returns deflated by CPI,
// then blended by the stocks fraction.
export function refHistoricalRealReturns(stocksPct: number): number[] {
  const sFrac = stocksPct / 100;
  return HISTORICAL.map((h) => {
    const stockReal = (1 + h.stockPct / 100) / (1 + h.cpiPct / 100) - 1;
    const bondReal = (1 + h.bondPct / 100) / (1 + h.cpiPct / 100) - 1;
    return sFrac * stockReal + (1 - sFrac) * bondReal;
  });
}

function refPhasedGrossCents(inputs: RefInputs, age: number): number {
  if (age <= inputs.phaseStartAge) return inputs.spendingCents;
  const factor = Math.pow(
    1 - inputs.phaseDeclinePct / 100,
    age - inputs.phaseStartAge,
  );
  return Math.round(inputs.spendingCents * factor);
}

// The one guardrails comparison, from the documented strict rule:
// cut only strictly above the cut rail, raise only strictly below
// the raise rail, a rate within 1e-9 relative of a rail treated as
// AT the rail (fires neither). At most one adjustment per year.
function refGuardrailsAdjustedSpending(
  currentSpending: number,
  bal: number,
  initialRate: number,
  inputs: RefInputs,
): number {
  if (bal <= 0 || initialRate <= 0) return currentSpending;
  const curRate = currentSpending / bal;
  const adj = inputs.guardrailsAdjustmentPct / 100;
  const cutThreshold = (inputs.guardrailsCutPct / 100) * initialRate;
  const raiseThreshold = (inputs.guardrailsRaisePct / 100) * initialRate;
  if (
    curRate - cutThreshold >
    Math.abs(cutThreshold) * REF_GUARDRAILS_RATE_REL_TOLERANCE
  ) {
    return Math.round(currentSpending * (1 - adj));
  }
  if (
    raiseThreshold - curRate >
    Math.abs(raiseThreshold) * REF_GUARDRAILS_RATE_REL_TOLERANCE
  ) {
    return Math.round(currentSpending * (1 + adj));
  }
  return currentSpending;
}

// Gross spending for a retired year under the inputs' strategy.
// Percent: percentOfPortfolio % of the start-of-year balance.
// Guardrails: the carried level after at most one rail adjustment
// (initial rate fixed at the first retired year).
function refGrossCents(
  inputs: RefInputs,
  age: number,
  bal: number,
  state: { currentSpending: number; initialRate: number | null },
): number {
  if (inputs.strategy === "percent") {
    return Math.round(bal * (inputs.percentOfPortfolio / 100));
  }
  if (inputs.strategy === "guardrails") {
    if (state.initialRate == null) {
      state.initialRate = bal > 0 ? inputs.spendingCents / bal : 0;
      state.currentSpending = inputs.spendingCents;
    }
    state.currentSpending = refGuardrailsAdjustedSpending(
      state.currentSpending,
      bal,
      state.initialRate,
      inputs,
    );
    return state.currentSpending;
  }
  if (inputs.strategy === "phased") {
    return refPhasedGrossCents(inputs, age);
  }
  return inputs.spendingCents;
}

function refIncomeAt(inputs: RefInputs, age: number): number {
  return inputs.extraIncomeStartAge != null &&
    age >= inputs.extraIncomeStartAge
    ? inputs.extraIncomeCents
    : 0;
}

export type RefDetailed = {
  balances: number[];
  grossWithdrawals: number[];
  netWithdrawals: number[];
};

// The year loop, from the documented semantics: each priced year,
// if retired, withdraw gross minus income (a surplus ADDS to the
// balance), floor at 0, then apply that year's return and floor
// again. Spending comes BEFORE growth.
export function refSimulateDetailed(
  inputs: RefInputs,
  returns: number[],
): RefDetailed {
  const years = refHorizonYears(inputs.currentAge, inputs.endAge);
  const balances: number[] = [inputs.startCents];
  const grossWithdrawals: number[] = [];
  const netWithdrawals: number[] = [];
  let bal = inputs.startCents;
  const state = { currentSpending: inputs.spendingCents, initialRate: null as number | null };
  for (let i = 0; i < years; i++) {
    const age = inputs.currentAge + i;
    let gross = 0;
    let net = 0;
    if (age >= inputs.retirementAge) {
      gross = refGrossCents(inputs, age, bal, state);
      net = gross - refIncomeAt(inputs, age);
      bal -= net;
      if (bal < 0) bal = 0;
    }
    grossWithdrawals.push(gross);
    netWithdrawals.push(net);
    const r = returns[i] ?? 0;
    bal = bal * (1 + r);
    if (bal < 0) bal = 0;
    balances.push(bal);
  }
  return { balances, grossWithdrawals, netWithdrawals };
}

// Success-only twin of the loop above: false the moment a retired
// year's net withdrawal exceeds the balance on hand — even if a
// later income surplus would refill the balance to positive.
export function refNeverRunsOut(inputs: RefInputs, returns: number[]): boolean {
  const years = refHorizonYears(inputs.currentAge, inputs.endAge);
  let bal = inputs.startCents;
  const state = { currentSpending: inputs.spendingCents, initialRate: null as number | null };
  for (let i = 0; i < years; i++) {
    const age = inputs.currentAge + i;
    if (age >= inputs.retirementAge) {
      const gross = refGrossCents(inputs, age, bal, state);
      const net = gross - refIncomeAt(inputs, age);
      if (net > bal) return false;
      bal -= net;
      if (bal < 0) bal = 0;
    }
    const r = returns[i] ?? 0;
    bal = bal * (1 + r);
    if (bal < 0) bal = 0;
  }
  return true;
}

// Percent-strategy spending variability, from the documented
// definitions: lowest gross retired-year spending over all runs;
// each run's average retired-year spending, then the median of
// those averages; median across runs of each run's final and first
// retired year's gross spending. Nulls for every other strategy.
export function refSpendingStats(
  inputs: RefInputs,
  runsGross: number[][],
): {
  lowestSpending: number | null;
  averageSpending: number | null;
  medianFinalYearSpending: number | null;
  medianFirstRetiredYearSpending: number | null;
} {
  if (inputs.strategy !== "percent") {
    return {
      lowestSpending: null,
      averageSpending: null,
      medianFinalYearSpending: null,
      medianFirstRetiredYearSpending: null,
    };
  }
  let lowest: number | null = null;
  const perRunAvg: number[] = [];
  const perRunFinal: number[] = [];
  const perRunFirst: number[] = [];
  for (const gross of runsGross) {
    const retired = gross.filter(
      (_, i) => inputs.currentAge + i >= inputs.retirementAge,
    );
    if (retired.length === 0) continue;
    perRunAvg.push(retired.reduce((s, v) => s + v, 0) / retired.length);
    perRunFirst.push(retired[0] ?? 0);
    perRunFinal.push(retired[retired.length - 1] ?? 0);
    for (const v of retired) lowest = lowest == null ? v : Math.min(lowest, v);
  }
  return {
    lowestSpending: lowest,
    averageSpending: perRunAvg.length > 0 ? refMedianOf(perRunAvg) : null,
    medianFinalYearSpending:
      perRunFinal.length > 0 ? refMedianOf(perRunFinal) : null,
    medianFirstRetiredYearSpending:
      perRunFirst.length > 0 ? refMedianOf(perRunFirst) : null,
  };
}

export type RefHistResult = {
  runs: { startYear: number; ending: number; returns: number[] }[];
  count: number;
  successRate: number;
  neverOutSuccessRate: number;
  medianEnding: number;
  worstEnding: number;
  worstStartYear: number;
  chartMedianByAge: Record<number, number>;
  lowestSpending: number | null;
  averageSpending: number | null;
  medianFinalYearSpending: number | null;
  medianFirstRetiredYearSpending: number | null;
};

export function refRunHistorical(
  inputs: RefInputs,
  stocksPct: number,
): RefHistResult | null {
  const planYears = refHorizonYears(inputs.currentAge, inputs.endAge);
  if (planYears <= 0) return null;
  const allReturns = refHistoricalRealReturns(stocksPct);
  const lastYear = HISTORICAL[HISTORICAL.length - 1]?.year ?? 0;
  const runs: RefHistResult["runs"] = [];
  const runsGross: number[][] = [];
  const allPaths: number[][] = [];
  for (let idx = 0; idx < HISTORICAL.length; idx++) {
    const sy = HISTORICAL[idx]?.year ?? 0;
    if (sy + planYears - 1 > lastYear) break;
    const returns = allReturns.slice(idx, idx + planYears);
    const det = refSimulateDetailed(inputs, returns);
    runs.push({
      startYear: sy,
      ending: det.balances[det.balances.length - 1] ?? 0,
      returns,
    });
    runsGross.push(det.grossWithdrawals);
    allPaths.push(det.balances);
  }
  if (runs.length === 0) return null;
  const endings = runs.map((r) => r.ending);
  const successes = endings.filter((e) => e > 0).length;
  const neverOut = runs.filter((r) =>
    refNeverRunsOut(inputs, r.returns),
  ).length;
  const worst = runs.reduce(
    (a, b) => (b.ending < a.ending ? b : a),
    runs[0] ?? { startYear: 0, ending: 0, returns: [] },
  );
  const chartMedianByAge: Record<number, number> = {};
  for (let i = 0; i <= planYears; i++) {
    const vals = allPaths.map((p) => p[i] ?? 0);
    chartMedianByAge[inputs.currentAge + i] = refMedianOf(vals);
  }
  const stats = refSpendingStats(inputs, runsGross);
  return {
    runs,
    count: runs.length,
    successRate: (successes / runs.length) * 100,
    neverOutSuccessRate: (neverOut / runs.length) * 100,
    medianEnding: refMedianOf(endings),
    worstEnding: worst.ending,
    worstStartYear: worst.startYear,
    chartMedianByAge,
    lowestSpending: stats.lowestSpending,
    averageSpending: stats.averageSpending,
    medianFinalYearSpending: stats.medianFinalYearSpending,
    medianFirstRetiredYearSpending: stats.medianFirstRetiredYearSpending,
  };
}

export type RefMcResult = {
  successRate: number;
  neverOutSuccessRate: number;
  p10: number;
  p50: number;
  p90: number;
  chartByAge: Record<
    number,
    { p10: number; p25: number; p50: number; p75: number; p90: number }
  >;
  endings: number[];
  lowestSpending: number | null;
  averageSpending: number | null;
  medianFinalYearSpending: number | null;
  medianFirstRetiredYearSpending: number | null;
};

// The Monte Carlo run, from the documented stream: one RNG seeded
// seed*7919+17, planYears normal draws per run (expected + vol *
// normal), runs in order — the same stream the tabs draw.
export function refRunMonteCarlo(
  inputs: RefInputs,
  expected: number,
  vol: number,
  seed: number,
  runCount = REF_MONTE_CARLO_RUNS,
): RefMcResult | null {
  const planYears = refHorizonYears(inputs.currentAge, inputs.endAge);
  if (planYears <= 0) return null;
  const rng = refMulberry32(seed * 7919 + 17);
  const endings: number[] = [];
  const paths: number[][] = [];
  const runsGross: number[][] = [];
  const runReturns: number[][] = [];
  let neverOut = 0;
  for (let run = 0; run < runCount; run++) {
    const returns: number[] = [];
    for (let i = 0; i < planYears; i++) {
      returns.push(expected + vol * refNormalRandom(rng));
    }
    runReturns.push(returns);
    const det = refSimulateDetailed(inputs, returns);
    paths.push(det.balances);
    runsGross.push(det.grossWithdrawals);
    endings.push(det.balances[det.balances.length - 1] ?? 0);
    if (refNeverRunsOut(inputs, returns)) neverOut++;
  }
  const sortedEndings = [...endings].sort((a, b) => a - b);
  const successes = endings.filter((e) => e > 0).length;
  const chartByAge: RefMcResult["chartByAge"] = {};
  for (let i = 0; i <= planYears; i++) {
    const vals = paths.map((p) => p[i] ?? 0).sort((a, b) => a - b);
    chartByAge[inputs.currentAge + i] = {
      p10: refPercentile(vals, 10),
      p25: refPercentile(vals, 25),
      p50: refMedianOf(vals),
      p75: refPercentile(vals, 75),
      p90: refPercentile(vals, 90),
    };
  }
  const stats = refSpendingStats(inputs, runsGross);
  return {
    successRate: (successes / runCount) * 100,
    neverOutSuccessRate: (neverOut / runCount) * 100,
    p10: refPercentile(sortedEndings, 10),
    p50: refMedianOf(endings),
    p90: refPercentile(sortedEndings, 90),
    chartByAge,
    endings,
    lowestSpending: stats.lowestSpending,
    averageSpending: stats.averageSpending,
    medianFinalYearSpending: stats.medianFinalYearSpending,
    medianFirstRetiredYearSpending: stats.medianFirstRetiredYearSpending,
  };
}

export type RefSolverStatus =
  | "feasible"
  | "feasible_at_zero"
  | "infeasible_at_zero"
  | "capped";

export type RefSolverResult = {
  maxSpendingCents: number;
  successRate: number;
  medianEnding: number;
  percent: number | null;
  approximate: boolean;
  targetSuccessRate: number;
  achievedSuccessRate: number;
  targetAchieved: boolean;
  solutionStatus: RefSolverStatus;
};

function refSolverResult(args: {
  maxSpendingCents: number;
  successRate: number;
  medianEnding: number;
  percent: number | null;
  approximate: boolean;
  targetPct: number;
  solutionStatus: RefSolverStatus;
}): RefSolverResult {
  return {
    maxSpendingCents: args.maxSpendingCents,
    successRate: args.successRate,
    medianEnding: args.medianEnding,
    percent: args.percent,
    approximate: args.approximate,
    targetSuccessRate: args.targetPct,
    achievedSuccessRate: args.successRate,
    targetAchieved: args.successRate >= args.targetPct,
    solutionStatus: args.solutionStatus,
  };
}

function refEvaluatePlan(
  inputs: RefInputs,
  stocksPct: number,
  expected: number,
  vol: number,
  engine: "historical" | "montecarlo",
  mcSeed: number,
): { successRate: number; medianEnding: number } | null {
  if (engine === "historical") {
    const h = refRunHistorical(inputs, stocksPct);
    return h
      ? { successRate: h.neverOutSuccessRate, medianEnding: h.medianEnding }
      : null;
  }
  const mc = refRunMonteCarlo(inputs, expected, vol, mcSeed, REF_MONTE_CARLO_RUNS);
  return mc ? { successRate: mc.neverOutSuccessRate, medianEnding: mc.p50 } : null;
}

// The return sequences the chosen engine prices, in run order —
// the historical start-year windows, or the seeded Monte Carlo
// stream. Built once so the guardrails scan's feasibility checks
// and the final evaluation price the same sequences. Memoized on
// the parameters the sequences depend on (engine, horizon, mix,
// expected/vol/seed): the sequences are pure functions of those,
// so caching them changes no result — it only keeps the
// maximality grid enumeration (thousands of feasibility checks)
// from re-drawing the same stream thousands of times. Callers
// only read the cached arrays. (Engine Review C7 architecture,
// §2.3–§2.4 — Phase 2 cache.) The cache was fully unbounded; it
// is now bounded by BYTES under a 64 MiB budget with oldest-first
// LRU eviction (ByteBudgetCache), the same treatment as the joint
// cache. Per-entry 0.44 MB (Monte Carlo) / 0.02 MB (historical),
// so 64 MiB holds ~145 distinct Monte Carlo return streams. Its
// no-clone read trust is KEPT — callers only read the arrays, and
// cloning would cost per hit; the bounded budget now caps the blast
// radius. Do not widen its caller set without re-checking the
// read-only trust.
export const RETURNS_CACHE_BUDGET_BYTES = 64 * 1024 * 1024;
const runReturnsCache = new ByteBudgetCache<number[][]>(
  RETURNS_CACHE_BUDGET_BYTES,
  "runReturns",
);

// Observability (§2.4): entries, accounted bytes, hits, misses,
// evictions — for tests and logs. No client-facing change.
export function runReturnsCacheStats(): {
  entries: number;
  bytes: number;
  hits: number;
  misses: number;
  evictions: number;
} {
  return runReturnsCache.stats();
}
function refRunReturns(
  base: RefInputs,
  stocksPct: number,
  expected: number,
  vol: number,
  engine: "historical" | "montecarlo",
  mcSeed: number,
): number[][] {
  const planYears = refHorizonYears(base.currentAge, base.endAge);
  const key = [engine, planYears, stocksPct, expected, vol, mcSeed].join("|");
  const cached = runReturnsCache.get(key);
  if (cached) return cached;
  let out: number[][];
  if (engine === "historical") {
    const allReturns = refHistoricalRealReturns(stocksPct);
    const lastYear = HISTORICAL[HISTORICAL.length - 1]?.year ?? 0;
    out = [];
    for (let idx = 0; idx < HISTORICAL.length; idx++) {
      const sy = HISTORICAL[idx]?.year ?? 0;
      if (sy + planYears - 1 > lastYear) break;
      out.push(allReturns.slice(idx, idx + planYears));
    }
  } else {
    const rng = refMulberry32(mcSeed * 7919 + 17);
    out = [];
    for (let run = 0; run < REF_MONTE_CARLO_RUNS; run++) {
      const returns: number[] = [];
      for (let i = 0; i < planYears; i++) {
        returns.push(expected + vol * refNormalRandom(rng));
      }
      out.push(returns);
    }
  }
  runReturnsCache.set(key, out, estimateValueBytes(out));
  return out;
}

// Guardrails solver, from the documented semantics: an exhaustive
// $100-step scan (success is NOT monotone here), up to the proven
// ceiling — the best balance at retirement plus the eventual extra
// income, inclusive of the ceiling step — or the search cap,
// whichever is smaller. A step is feasible when the never-runs-out
// success count meets the target; the count test settles as soon
// as enough successes (or too many failures) are seen.
function refSolveGuardrailsScan(
  base: RefInputs,
  stocksPct: number,
  expected: number,
  vol: number,
  engine: "historical" | "montecarlo",
  targetPct: number,
  capSteps: number,
  approximate: boolean,
  mcSeed: number,
): RefSolverResult | null {
  const STEP = REF_SOLVER_STEP_CENTS;
  const planYears = refHorizonYears(base.currentAge, base.endAge);
  if (planYears <= 0) return null;
  const runReturns = refRunReturns(base, stocksPct, expected, vol, engine, mcSeed);
  if (runReturns.length === 0) return null;
  const needed = Math.ceil((targetPct / 100) * runReturns.length - 1e-9);
  const allowedFail = runReturns.length - needed;
  const feasible = (cents: number): boolean => {
    const inp: RefInputs = { ...base, spendingCents: cents };
    let succ = 0;
    let fail = 0;
    for (const returns of runReturns) {
      if (refNeverRunsOut(inp, returns)) {
        succ++;
        if (succ >= needed) return true;
      } else {
        fail++;
        if (fail > allowedFail) return false;
      }
    }
    return succ >= needed;
  };
  const preYears = Math.max(
    0,
    Math.min(planYears, base.retirementAge - base.currentAge),
  );
  const eventualIncome =
    base.extraIncomeStartAge != null ? base.extraIncomeCents : 0;
  let maxRetBal = 0;
  for (const returns of runReturns) {
    let b = base.startCents;
    for (let i = 0; i < preYears; i++) {
      b = b * (1 + (returns[i] ?? 0));
      if (b < 0) b = 0;
    }
    if (b > maxRetBal) maxRetBal = b;
  }
  const scanSteps = Math.min(
    capSteps,
    Math.max(0, Math.floor((maxRetBal + eventualIncome) / STEP)),
  );
  let best = 0;
  for (let k = 1; k <= scanSteps; k++) {
    if (feasible(k * STEP)) best = k;
  }
  const winner = refEvaluatePlan(
    { ...base, spendingCents: best * STEP },
    stocksPct,
    expected,
    vol,
    engine,
    mcSeed,
  );
  if (!winner) return null;
  const solutionStatus: RefSolverStatus =
    winner.successRate < targetPct
      ? "infeasible_at_zero"
      : best === scanSteps && scanSteps === capSteps
        ? "capped"
        : best === 0
          ? "feasible_at_zero"
          : "feasible";
  return refSolverResult({
    maxSpendingCents: best * STEP,
    successRate: winner.successRate,
    medianEnding: winner.medianEnding,
    percent: null,
    approximate,
    targetPct,
    solutionStatus,
  });
}

// The max-spending solver, from the documented semantics: null
// when there is no retired year; percent searches the percent in
// $100-of-first-year-spending steps up to the 30% cap; constant
// and phased binary-search the starting spending up to the search
// cap; guardrails scans exhaustively. Statuses as documented at
// the top of this file.
export function refSolveMaxSpending(
  base: RefInputs,
  stocksPct: number,
  expected: number,
  vol: number,
  engine: "historical" | "montecarlo",
  targetPct: number,
  mcSeed: number = REF_MONTE_CARLO_SEED_DEFAULT,
): RefSolverResult | null {
  if (base.retirementAge >= base.endAge) return null;
  const approximate = engine === "montecarlo";
  const STEP = REF_SOLVER_STEP_CENTS;

  if (base.strategy === "percent") {
    if (base.startCents <= 0) return null;
    const maxSteps = Math.floor((base.startCents * 0.3) / STEP);
    if (maxSteps <= 0) return null;
    const pctFor = (k: number) => (k * STEP * 100) / base.startCents;
    const evalStep = (k: number) =>
      refEvaluatePlan(
        { ...base, percentOfPortfolio: pctFor(k) },
        stocksPct,
        expected,
        vol,
        engine,
        mcSeed,
      );
    const at0 = evalStep(0);
    if (!at0) return null;
    if (at0.successRate < targetPct) {
      return refSolverResult({ maxSpendingCents: 0, successRate: at0.successRate, medianEnding: at0.medianEnding, percent: 0, approximate, targetPct, solutionStatus: "infeasible_at_zero" });
    }
    const atMax = evalStep(maxSteps);
    if (atMax && atMax.successRate >= targetPct) {
      return refSolverResult({ maxSpendingCents: maxSteps * STEP, successRate: atMax.successRate, medianEnding: atMax.medianEnding, percent: pctFor(maxSteps), approximate, targetPct, solutionStatus: "capped" });
    }
    let lo = 0;
    let hi = maxSteps;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      const e = evalStep(mid);
      if (e && e.successRate >= targetPct) lo = mid;
      else hi = mid;
    }
    const best = evalStep(lo);
    if (!best) return null;
    return refSolverResult({ maxSpendingCents: lo * STEP, successRate: best.successRate, medianEnding: best.medianEnding, percent: pctFor(lo), approximate, targetPct, solutionStatus: lo === 0 ? "feasible_at_zero" : "feasible" });
  }

  const evalSpend = (cents: number) =>
    refEvaluatePlan(
      { ...base, spendingCents: cents },
      stocksPct,
      expected,
      vol,
      engine,
      mcSeed,
    );
  const at0 = evalSpend(0);
  if (!at0) return null;
  if (at0.successRate < targetPct) {
    return refSolverResult({ maxSpendingCents: 0, successRate: at0.successRate, medianEnding: at0.medianEnding, percent: null, approximate, targetPct, solutionStatus: "infeasible_at_zero" });
  }
  const capSteps = Math.max(1, Math.floor(Math.max(base.startCents * 2, 100_000_000) / STEP));
  if (base.strategy === "guardrails") {
    return refSolveGuardrailsScan(
      base,
      stocksPct,
      expected,
      vol,
      engine,
      targetPct,
      capSteps,
      approximate,
      mcSeed,
    );
  }
  let lo = 0;
  let hi = Math.min(
    capSteps,
    Math.max(1, Math.ceil(Math.max(base.spendingCents, 5_000_000) / STEP)),
  );
  let eHi = evalSpend(hi * STEP);
  while (eHi && eHi.successRate >= targetPct && hi < capSteps) {
    lo = hi;
    hi = Math.min(capSteps, hi * 2);
    eHi = evalSpend(hi * STEP);
  }
  if (eHi && eHi.successRate >= targetPct) {
    return refSolverResult({ maxSpendingCents: hi * STEP, successRate: eHi.successRate, medianEnding: eHi.medianEnding, percent: null, approximate, targetPct, solutionStatus: "capped" });
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const e = evalSpend(mid * STEP);
    if (e && e.successRate >= targetPct) lo = mid;
    else hi = mid;
  }
  const best = evalSpend(lo * STEP);
  if (!best) return null;
  return refSolverResult({ maxSpendingCents: lo * STEP, successRate: best.successRate, medianEnding: best.medianEnding, percent: null, approximate, targetPct, solutionStatus: lo === 0 ? "feasible_at_zero" : "feasible" });
}

// Feasibility of one input set, by the never-runs-out rate
// over the engine's own return sequences — the maximality tests'
// independent oracle: a level is feasible exactly when the
// never-runs-out success rate at that level meets the target.
// Callers set the search variable on the inputs themselves
// (spendingCents for constant/phased/guardrails, or
// percentOfPortfolio for percent).
export function refFeasible(
  inputs: RefInputs,
  stocksPct: number,
  expected: number,
  vol: number,
  engine: "historical" | "montecarlo",
  targetPct: number,
  mcSeed: number,
): boolean {
  const runReturns = refRunReturns(inputs, stocksPct, expected, vol, engine, mcSeed);
  if (runReturns.length === 0) return false;
  const needed = Math.ceil((targetPct / 100) * runReturns.length - 1e-9);
  let succ = 0;
  for (const returns of runReturns) {
    if (refNeverRunsOut(inputs, returns)) {
      succ++;
      if (succ >= needed) return true;
    }
  }
  return succ >= needed;
}

// Never-runs-out success rate at one input set, counted over
// the engine's own return sequences (no early exit) — the exact
// count the threshold-boundary tests assert on.
export function refNeverOutRateAt(
  inputs: RefInputs,
  stocksPct: number,
  expected: number,
  vol: number,
  engine: "historical" | "montecarlo",
  mcSeed: number,
): { successRate: number; successes: number; runs: number } {
  const runReturns = refRunReturns(inputs, stocksPct, expected, vol, engine, mcSeed);
  let succ = 0;
  for (const returns of runReturns) {
    if (refNeverRunsOut(inputs, returns)) succ++;
  }
  return {
    successRate:
      runReturns.length === 0 ? 0 : (succ / runReturns.length) * 100,
    successes: succ,
    runs: runReturns.length,
  };
}
