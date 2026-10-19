// Retirement simulation engines — the single implementation shared
// by the Retirement view (client, via the "@space/server/*" path) and
// the server-side accuracy self-check (server/src/retirementFixtures.ts
// + the runAccuracySelfCheck action), so the numbers the maintenance
// check pins are computed by the exact code the user sees.
//
// Pure functions only: no React, no DOM, no server APIs. The year
// loop (simulateDetailed) and its success-only twin (runNeverRunsOut)
// must stay semantically identical — the max-spending solver's
// guardrails scan depends on it, and the solver cross-checks its scan
// winner with the full engines.
//
// MAINTENANCE RULE: any change to these engines, to the historical
// dataset (server/src/retirementData.ts), or to the plan defaults
// below must be followed by re-running the regression fixture suite
// (the runAccuracySelfCheck action). Expected outputs in the fixtures
// may only change under the independent-recomputation standard
// documented in server/src/retirementFixtures.ts.

import { HISTORICAL } from "./retirementData";

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((p / 100) * sorted.length)),
  );
  return sorted[idx] ?? 0;
}
function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

// Deterministic PRNG so a Monte Carlo batch is stable until Re-run.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normalRandom(rng: () => number): number {
  // Box–Muller
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

export type SpendingStrategy = "constant" | "percent" | "guardrails" | "phased";

// Guardrails knobs: the professional defaults are the values the
// strategy used when they were fixed (cut above 120% of the
// starting withdrawal rate, raise below 80%, ±10% steps).
export const GUARDRAILS_CUT_DEFAULT = 120;
export const GUARDRAILS_RAISE_DEFAULT = 80;
export const GUARDRAILS_ADJUSTMENT_DEFAULT = 10;

// Phased knobs: spending stays flat until the step-down start age
// (75), then declines by the step-down percent (1%) a year. These
// defaults apply whenever a stored plan / scenario predates the
// phased strategy and carries no phased fields — see
// effectivePhased.
export const PHASE_START_AGE_DEFAULT = 75;
export const PHASE_DECLINE_PCT_DEFAULT = 1;

// Plan defaults for the retirement age and extra income fields:
// retire at 57; extra income defaults to blank (none) — the
// default plan must stand on its own without Social Security
// assumed — while its start age defaults to 67 (the Social
// Security claiming age), so an amount typed in later is already
// set to begin then. These apply to a fresh state (no saved
// inputs) and to Reset to defaults; a user's already-saved inputs
// are never rewritten.
export const RETIREMENT_AGE_DEFAULT = 57;
export const EXTRA_INCOME_DEFAULT_CENTS = 0;
export const EXTRA_INCOME_START_AGE_DEFAULT = 67;
// Factory default for the Portfolio mix — stocks % field: what a
// fresh start seeds and what Reset to defaults restores. A saved
// stocks % is always used exactly as saved; this value only ever
// fills a blank / never-set field.
export const STOCKS_PCT_DEFAULT = 95;

// Effective guardrails knobs from raw (possibly null / blank)
// values: a blank knob falls back to its professional default —
// the same blank-means-default pattern as Expected return /
// Volatility falling back to the blend. Values are clamped to
// the sensible ranges (triggers 50–300%, adjustment 1–50%), and
// the cut trigger is kept strictly above the raise trigger by
// clamping: the cut is bumped to just above the raise but never
// past the 300% ceiling (a fractional raise like 299.5% bumps it
// to exactly 300, not 300.5 — a value above the ceiling would
// also be rejected by the save schema, silently un-saving every
// edit), and only when the raise is already at that ceiling is
// the raise lowered instead. Every engine, the solver, and
// scenario compare run on these effective values, live and after
// a reload alike.
export function effectiveGuardrails(
  cutPct: number | null | undefined,
  raisePct: number | null | undefined,
  adjustmentPct: number | null | undefined,
): {
  guardrailsCutPct: number;
  guardrailsRaisePct: number;
  guardrailsAdjustmentPct: number;
} {
  const clamp = (n: number, lo: number, hi: number): number =>
    Math.min(hi, Math.max(lo, n));
  let cut = clamp(cutPct ?? GUARDRAILS_CUT_DEFAULT, 50, 300);
  let raise = clamp(raisePct ?? GUARDRAILS_RAISE_DEFAULT, 50, 300);
  const adjustment = clamp(
    adjustmentPct ?? GUARDRAILS_ADJUSTMENT_DEFAULT,
    1,
    50,
  );
  if (cut <= raise) {
    cut = Math.min(300, raise + 1);
    if (cut <= raise) {
      // Only reachable when the raise is already at the 300%
      // ceiling, so the cut cannot sit above it: lower the
      // raise instead.
      raise = cut - 1;
    }
  }
  return {
    guardrailsCutPct: cut,
    guardrailsRaisePct: raise,
    guardrailsAdjustmentPct: adjustment,
  };
}

// Effective phased knobs from raw (possibly null / blank) values:
// a blank knob falls back to its default (start age 75, decline
// 1%/yr) — the same blank-means-default pattern as the guardrails
// knobs. The start age is clamped to 0–130 (the save schema's end-
// age ceiling): a start age at or beyond the plan's end age is
// NOT an error — the plan simply stays flat for its whole span,
// exactly Constant. The decline is clamped to 0–100 (0 = flat,
// also exactly Constant).
export function effectivePhased(
  startAge: number | null | undefined,
  declinePct: number | null | undefined,
): { phaseStartAge: number; phaseDeclinePct: number } {
  const clamp = (n: number, lo: number, hi: number): number =>
    Math.min(hi, Math.max(lo, n));
  return {
    phaseStartAge: clamp(
      Math.round(startAge ?? PHASE_START_AGE_DEFAULT),
      0,
      130,
    ),
    phaseDeclinePct: clamp(declinePct ?? PHASE_DECLINE_PCT_DEFAULT, 0, 100),
  };
}

// Gross spending for a retired year under the phased strategy:
// the annual spending input scaled by the step-down factor for
// the age — 1 while age ≤ phaseStartAge, then
// (1 − decline/100)^(age − phaseStartAge). Rounded to whole cents
// like the percent and guardrails paths round their gross. With
// decline 0, or a start age at/beyond every age in the plan, the
// factor is exactly 1 and this returns the spending input itself,
// bit-identical to Constant.
export function phasedGrossCents(inputs: SimInputs, age: number): number {
  if (age <= inputs.phaseStartAge) return inputs.spendingCents;
  const factor = Math.pow(
    1 - inputs.phaseDeclinePct / 100,
    age - inputs.phaseStartAge,
  );
  return Math.round(inputs.spendingCents * factor);
}

export type SimInputs = {
  startCents: number;
  spendingCents: number;
  currentAge: number;
  retirementAge: number;
  endAge: number;
  extraIncomeCents: number; // 0 = none
  extraIncomeStartAge: number | null;
  strategy: SpendingStrategy;
  percentOfPortfolio: number; // e.g. 5 = 5% of the start-of-year balance
  // Guardrails knobs, EFFECTIVE values (blank already resolved to
  // the professional defaults and clamped — see effectiveGuardrails).
  // Cut / raise triggers are percents of the starting withdrawal
  // rate; the adjustment is the % each step changes spending by.
  guardrailsCutPct: number;
  guardrailsRaisePct: number;
  guardrailsAdjustmentPct: number;
  // Phased knobs, EFFECTIVE values (blank already resolved to the
  // defaults and clamped — see effectivePhased). Spending is flat
  // through phaseStartAge, then declines phaseDeclinePct % a year.
  phaseStartAge: number;
  phaseDeclinePct: number;
};

// One simulation path, with per-year detail. Each year from
// currentAge to endAge: if retired, withdraw that year's gross
// spending minus extra income when active (when the income exceeds
// spending the surplus is added to the portfolio), then apply that
// year's real return. The balance itself floors at 0: a shortfall
// year empties it and returns alone cannot revive it (a later
// year's surplus income still adds, as it would in life).
//
// Gross spending for a retired year depends on the strategy:
// - constant: the fixed annual spending input.
// - percent: percentOfPortfolio % of the balance at the start of
//   the year (before that year's withdrawal). By construction this
//   can never take the balance below 0 in one year for any percent
//   under 100 — the balance shrinks toward 0 but does not reach it
//   through spending alone.
// - guardrails: starts at the annual spending input. The initial
//   withdrawal rate is fixed at retirement start (base spending ÷
//   the portfolio at that moment). Each retired year, before
//   withdrawing, the current withdrawal rate (current spending ÷
//   current balance) is compared against the user's knobs: above
//   guardrailsCutPct % of the initial rate spending is cut by
//   guardrailsAdjustmentPct %, below guardrailsRaisePct % it is
//   raised by the same % — at most one adjustment per year, and
//   the adjusted level carries into following years. At the
//   professional defaults (120 / 80 / 10) this is exactly the
//   original fixed 1.2× / 0.8× band with ±10% steps.
// - phased: the annual spending input scaled by the step-down
//   factor for the year (see phasedGrossCents): full spending
//   through phaseStartAge, then a decline of phaseDeclinePct %
//   a year in today's dollars, applied to the gross BEFORE the
//   extra-income offset, exactly where Constant applies the
//   spending input.
export type SimDetailed = {
  balances: number[]; // length years+1, starting at currentAge
  grossWithdrawals: number[]; // per year: gross spending (0 pre-retirement)
  netWithdrawals: number[]; // per year: gross − extra income (what leaves the portfolio)
};

export function simulateDetailed(inputs: SimInputs, returns: number[]): SimDetailed {
  const years = Math.max(0, inputs.endAge - inputs.currentAge);
  const balances: number[] = [inputs.startCents];
  const grossWithdrawals: number[] = [];
  const netWithdrawals: number[] = [];
  let bal = inputs.startCents;
  let currentSpending = inputs.spendingCents;
  let initialRate: number | null = null;
  for (let i = 0; i < years; i++) {
    const age = inputs.currentAge + i;
    let gross = 0;
    let net = 0;
    if (age >= inputs.retirementAge) {
      const income =
        inputs.extraIncomeStartAge != null && age >= inputs.extraIncomeStartAge
          ? inputs.extraIncomeCents
          : 0;
      if (inputs.strategy === "percent") {
        gross = Math.round(bal * (inputs.percentOfPortfolio / 100));
      } else if (inputs.strategy === "guardrails") {
        if (initialRate == null) {
          initialRate = bal > 0 ? inputs.spendingCents / bal : 0;
          currentSpending = inputs.spendingCents;
        }
        if (bal > 0 && initialRate > 0) {
          const curRate = currentSpending / bal;
          const adj = inputs.guardrailsAdjustmentPct / 100;
          if (curRate > (inputs.guardrailsCutPct / 100) * initialRate) {
            currentSpending = Math.round(currentSpending * (1 - adj));
          } else if (curRate < (inputs.guardrailsRaisePct / 100) * initialRate) {
            currentSpending = Math.round(currentSpending * (1 + adj));
          }
        }
        gross = currentSpending;
      } else if (inputs.strategy === "phased") {
        gross = phasedGrossCents(inputs, age);
      } else {
        gross = inputs.spendingCents;
      }
      net = gross - income;
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

// Balances-only path (the original simulate shape).
export function simulate(inputs: SimInputs, returns: number[]): number[] {
  return simulateDetailed(inputs, returns).balances;
}

// Success-only path: the exact year loop of simulateDetailed, but
// tracking nothing but the balance, and answering the never-runs-out
// question the max-spending solver scores runs by: did every retired
// year's net withdrawal get fully funded by the balance on hand when
// it came due? A year whose net withdrawal exceeds the balance fails
// the run on the spot — even if the balance would later climb back
// above zero (a shortfall year floors the balance at 0 in
// simulateDetailed, and a later year's surplus extra income adds to
// it again, so an ending-balance test alone would call such a run a
// success after it had already spent years at $0). Used by the
// solver both directly (its guardrails scan, where thousands of
// feasibility checks make the detailed path's per-year arrays too
// slow) and through the engines' neverOutSuccessRate. Must mirror
// simulateDetailed's balance evolution exactly: the solver
// cross-checks its scan winner with the full engines.
export function runNeverRunsOut(inputs: SimInputs, returns: number[]): boolean {
  const years = Math.max(0, inputs.endAge - inputs.currentAge);
  let bal = inputs.startCents;
  let currentSpending = inputs.spendingCents;
  let initialRate: number | null = null;
  for (let i = 0; i < years; i++) {
    const age = inputs.currentAge + i;
    if (age >= inputs.retirementAge) {
      const income =
        inputs.extraIncomeStartAge != null && age >= inputs.extraIncomeStartAge
          ? inputs.extraIncomeCents
          : 0;
      let gross: number;
      if (inputs.strategy === "percent") {
        gross = Math.round(bal * (inputs.percentOfPortfolio / 100));
      } else if (inputs.strategy === "guardrails") {
        if (initialRate == null) {
          initialRate = bal > 0 ? inputs.spendingCents / bal : 0;
          currentSpending = inputs.spendingCents;
        }
        if (bal > 0 && initialRate > 0) {
          const curRate = currentSpending / bal;
          const adj = inputs.guardrailsAdjustmentPct / 100;
          if (curRate > (inputs.guardrailsCutPct / 100) * initialRate) {
            currentSpending = Math.round(currentSpending * (1 - adj));
          } else if (curRate < (inputs.guardrailsRaisePct / 100) * initialRate) {
            currentSpending = Math.round(currentSpending * (1 + adj));
          }
        }
        gross = currentSpending;
      } else if (inputs.strategy === "phased") {
        gross = phasedGrossCents(inputs, age);
      } else {
        gross = inputs.spendingCents;
      }
      const net = gross - income;
      // The funding test, taken before the withdrawal: the year's
      // net withdrawal must not exceed the balance available to
      // fund it. (simulateDetailed floors the post-withdrawal
      // balance at 0, so this is exactly the years in which its
      // unfloored balance would have gone negative.)
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

/* ----- Displayed-figure deltas -----
   Every delta printed next to a displayed figure must be computed
   FROM the displayed figures, so it foots exactly with the tiles a
   reader can subtract themselves: money tiles print Math.round
   (whole cents — see fmt in the Retirement view) and success-rate
   tiles print one decimal (toFixed(1)). A delta taken from the raw
   float difference can disagree by 1¢ (or 0.1 pts) with the
   difference of the two printed figures whenever the raw values
   carry fractional cents / tenths. These helpers are the single
   implementation of that rule — used by the scenario-card
   sub-deltas (sign convention scenario − Current, as on the
   cards), the scenario-card delta line, and the what-if deltas
   vs the baseline plan (sign convention current − baseline). */
export function displayedMoneyDeltaCents(
  scenarioCents: number,
  currentCents: number,
): number {
  return Math.round(scenarioCents) - Math.round(currentCents);
}
export function displayedRateDeltaPoints(
  scenarioRate: number,
  currentRate: number,
): number {
  const shown = (r: number): number => Math.round(r * 10) / 10;
  // Re-round to one decimal so binary noise (90.9 − 90.8 =
  // 0.10000000000000568…) never leaks into the printed delta.
  return Math.round((shown(scenarioRate) - shown(currentRate)) * 10) / 10;
}

export function blendedExpected(stocksPct: number): number {
  return (stocksPct / 100) * 7 + (1 - stocksPct / 100) * 2;
}
export function blendedVol(stocksPct: number): number {
  return (stocksPct / 100) * 18 + (1 - stocksPct / 100) * 6;
}

// Blended real return for each historical year at a given mix.
function historicalRealReturns(stocksPct: number): number[] {
  const sFrac = stocksPct / 100;
  return HISTORICAL.map((h) => {
    const stockReal = (1 + h.stockPct / 100) / (1 + h.cpiPct / 100) - 1;
    const bondReal = (1 + h.bondPct / 100) / (1 + h.cpiPct / 100) - 1;
    return sFrac * stockReal + (1 - sFrac) * bondReal;
  });
}

// Spending variability stats for the percent-of-portfolio strategy:
// the lowest gross yearly spending seen in any retired year of any
// run, and the average yearly spending — each run's own average
// first, then the median of those averages across runs. Also the
// tail-disclosure figures: each run's final retired year's gross
// spending and its first retired year's gross spending, each taken
// as the median across runs (display-only; no engine result or
// success logic reads them). Every other strategy — Constant,
// Guardrails, and Phased alike — gets nulls here: the tail
// disclosure stays a Percent-only treatment.
function spendingStats(
  inputs: SimInputs,
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
    averageSpending: perRunAvg.length > 0 ? medianOf(perRunAvg) : null,
    medianFinalYearSpending:
      perRunFinal.length > 0 ? medianOf(perRunFinal) : null,
    medianFirstRetiredYearSpending:
      perRunFirst.length > 0 ? medianOf(perRunFirst) : null,
  };
}

export type HistRun = {
  startYear: number;
  path: number[];
  ending: number;
  returns: number[];
  grossWithdrawals: number[];
  netWithdrawals: number[];
};

export type HistResult = {
  runs: HistRun[];
  chart: Record<string, number>[];
  count: number;
  successRate: number;
  // Share of runs whose portfolio never ran out (runNeverRunsOut):
  // every year's withdrawal fully funded. successRate above counts
  // a run by its ending balance alone, so a run that sat at $0 for
  // years and was later refilled by surplus extra income counts
  // there but not here. The max-spending solver scores by this
  // rate, and the Historical tab headlines it too — "success"
  // means never runs out everywhere in the Retirement view.
  neverOutSuccessRate: number;
  medianEnding: number;
  worstEnding: number;
  worstStartYear: number;
  lowestSpending: number | null;
  averageSpending: number | null;
  // Display-only tail disclosure for the percent strategy (null
  // otherwise): median across runs of each run's final retired
  // year's gross spending, and of its first retired year's.
  medianFinalYearSpending: number | null;
  medianFirstRetiredYearSpending: number | null;
};

export function runHistorical(inputs: SimInputs, stocksPct: number): HistResult | null {
  const planYears = inputs.endAge - inputs.currentAge;
  if (planYears <= 0) return null;
  const allReturns = historicalRealReturns(stocksPct);
  const lastYear = HISTORICAL[HISTORICAL.length - 1]?.year ?? 0;
  const runs: HistRun[] = [];
  for (let idx = 0; idx < HISTORICAL.length; idx++) {
    const sy = HISTORICAL[idx]?.year ?? 0;
    if (sy + planYears - 1 > lastYear) break;
    const returns = allReturns.slice(idx, idx + planYears);
    const det = simulateDetailed(inputs, returns);
    runs.push({
      startYear: sy,
      path: det.balances,
      ending: det.balances[det.balances.length - 1] ?? 0,
      returns,
      grossWithdrawals: det.grossWithdrawals,
      netWithdrawals: det.netWithdrawals,
    });
  }
  if (runs.length === 0) return null;
  const endings = runs.map((r) => r.ending);
  const successes = endings.filter((e) => e > 0).length;
  const neverOut = runs.filter((r) => runNeverRunsOut(inputs, r.returns)).length;
  const worst = runs.reduce(
    (a, b) => (b.ending < a.ending ? b : a),
    runs[0] ?? { startYear: 0, path: [], ending: 0, returns: [], grossWithdrawals: [], netWithdrawals: [] },
  );
  const chart: Record<string, number>[] = [];
  for (let i = 0; i <= planYears; i++) {
    const row: Record<string, number> = { age: inputs.currentAge + i };
    const vals: number[] = [];
    for (const r of runs) {
      const v = (r.path[i] ?? 0) / 100;
      row[`r${r.startYear}`] = v;
      vals.push(r.path[i] ?? 0);
    }
    row.median = medianOf(vals) / 100;
    chart.push(row);
  }
  const stats = spendingStats(inputs, runs.map((r) => r.grossWithdrawals));
  return {
    runs,
    chart,
    count: runs.length,
    successRate: (successes / runs.length) * 100,
    neverOutSuccessRate: (neverOut / runs.length) * 100,
    medianEnding: medianOf(endings),
    worstEnding: worst.ending,
    worstStartYear: worst.startYear,
    lowestSpending: stats.lowestSpending,
    averageSpending: stats.averageSpending,
    medianFinalYearSpending: stats.medianFinalYearSpending,
    medianFirstRetiredYearSpending: stats.medianFirstRetiredYearSpending,
  };
}

export type McResult = {
  successRate: number;
  // Share of runs whose portfolio never ran out (runNeverRunsOut) —
  // see HistResult.neverOutSuccessRate. The max-spending solver
  // scores by this rate, and the Monte Carlo tab headlines it
  // too — "success" means never runs out everywhere in the
  // Retirement view.
  neverOutSuccessRate: number;
  p10: number;
  p50: number;
  p90: number;
  chart: {
    age: number;
    base: number;
    segLow: number;
    band75: number;
    segHigh: number;
    median: number;
    p10: number;
    p90: number;
  }[];
  lowestSpending: number | null;
  averageSpending: number | null;
  // Display-only tail disclosure for the percent strategy (null
  // otherwise) — see HistResult's fields of the same names.
  medianFinalYearSpending: number | null;
  medianFirstRetiredYearSpending: number | null;
};

export const MONTE_CARLO_TAB_SEED_DEFAULT = 12345;
export const MONTE_CARLO_TAB_RUNS = 1000;

export function runMonteCarlo(
  inputs: SimInputs,
  expected: number,
  vol: number,
  seed: number,
  runCount = MONTE_CARLO_TAB_RUNS,
): McResult | null {
  const planYears = inputs.endAge - inputs.currentAge;
  if (planYears <= 0) return null;
  const rng = mulberry32(seed * 7919 + 17);
  const endings: number[] = [];
  const paths: number[][] = [];
  const runsGross: number[][] = [];
  let neverOut = 0;
  for (let run = 0; run < runCount; run++) {
    const returns: number[] = [];
    for (let i = 0; i < planYears; i++) {
      returns.push(expected + vol * normalRandom(rng));
    }
    const det = simulateDetailed(inputs, returns);
    paths.push(det.balances);
    runsGross.push(det.grossWithdrawals);
    endings.push(det.balances[det.balances.length - 1] ?? 0);
    if (runNeverRunsOut(inputs, returns)) neverOut++;
  }
  const sortedEndings = [...endings].sort((a, b) => a - b);
  const successes = endings.filter((e) => e > 0).length;
  const chart: McResult["chart"] = [];
  for (let i = 0; i <= planYears; i++) {
    const vals = paths.map((p) => p[i] ?? 0).sort((a, b) => a - b);
    const p10 = percentile(vals, 10) / 100;
    const p25 = percentile(vals, 25) / 100;
    const p50 = medianOf(vals) / 100;
    const p75 = percentile(vals, 75) / 100;
    const p90 = percentile(vals, 90) / 100;
    chart.push({
      age: inputs.currentAge + i,
      base: p10,
      segLow: p25 - p10,
      band75: p75 - p25,
      segHigh: p90 - p75,
      median: p50,
      p10,
      p90,
    });
  }
  const stats = spendingStats(inputs, runsGross);
  return {
    successRate: (successes / runCount) * 100,
    neverOutSuccessRate: (neverOut / runCount) * 100,
    p10: percentile(sortedEndings, 10),
    p50: medianOf(endings),
    p90: percentile(sortedEndings, 90),
    chart,
    lowestSpending: stats.lowestSpending,
    averageSpending: stats.averageSpending,
    medianFinalYearSpending: stats.medianFinalYearSpending,
    medianFirstRetiredYearSpending: stats.medianFirstRetiredYearSpending,
  };
}

/* ----- Max spending solver -----
   Search on spending, in whole $100 steps, using the chosen engine
   with every other input as-is. The Monte Carlo solver uses the
   Monte Carlo tab's stream — the view's current seed and the tab's
   1,000 runs, generated exactly as runMonteCarlo generates them —
   so the solver's success rate at any spending is the tab's
   headline rate for that same plan at that same spending. For the percent-of-portfolio
   strategy the search variable is the percent itself, stepped in
   $100-of-first-year-spending increments (that strategy has no
   fixed annual spending to solve for).

   Constant and percent success are provably non-increasing as the
   search variable grows (a larger withdrawal leaves a weakly
   smaller balance after every year, whatever the returns), so a
   binary search finds their exact maximum. Phased is monotone
   for the same reason — its step-down factor depends only on
   the age, never on the spending, so each year's gross scales
   with the starting spending — and it shares Constant's binary
   search: its solved figure is the maximum STARTING annual
   spending (the pre-decline amount the factor scales) meeting
   the same success rule. Guardrails success is
   NOT monotone: a higher base spending also raises the initial
   withdrawal rate the guardrail bands are measured from, so a
   spending that fails can sit below a higher one that succeeds
   (measured on the historical engine: at a $3M portfolio the plan
   fails at $246,000–$248,000 yet succeeds again at
   $248,100–$248,400). A binary search there returns a boundary
   that is not the maximum, so guardrails is solved by an exhaustive
   $100-step scan instead, using success-only feasibility checks
   (runNeverRunsOut over the same return sequences the engines use,
   decided as soon as the success count is settled either way). The
   scan stops at a proven ceiling: in the first retired year the
   guardrail level is still the base spending itself (the initial
   rate equals the current rate, so no adjustment can fire), and
   that year's net withdrawal is the base spending minus at most
   the extra income, so a spending at or above the best run's
   balance at retirement plus the extra income empties every run
   in year one — and with the balance at 0 the guardrail level
   stays frozen at the base spending, so the net stays
   non-negative in every later year too and no run can revive.
   Note the ceiling must use the income amount itself, not the
   income active in the first retired year: an income that starts
   later and exceeds the spending revives a zeroed balance once it
   begins, so plans above a first-year-income ceiling can succeed.
   The reported
   success rate and median ending always come from re-running the
   full engine at the winning spending.

   Success predicate: a run counts as a success only if the
   portfolio NEVER runs out — every retired year's net withdrawal
   fully funded by the balance on hand (runNeverRunsOut; the
   engines report it as neverOutSuccessRate). The Historical
   and Monte Carlo tabs headline this same rate, so "success"
   means the same thing in the solver and in the tabs. It is
   stricter than an ending-balance test: a plan whose
   portfolio hits $0 mid-run and is later refilled by surplus
   extra income ends positive, so the old ending-balance scoring
   called it sustainable at spendings whose withdrawals could not
   actually be funded for years at a time (a $400 portfolio with
   $50,520/yr of income from 67 "solved" to $50,500/yr at 100%
   success, its median run refilled to a $1,163.16 ending after a
   decade at $0). The median ending still comes from the same
   runs' ending balances, refill and all — only the success count
   changed. Feasibility stays monotone in the search variable
   under this predicate (a smaller withdrawal leaves a weakly
   larger balance at every year of the same return sequence, so a
   run fundable at one spending is fundable at any lower one),
   which is what the binary searches below rely on. */
export type SolverResult = {
  maxSpendingCents: number;
  successRate: number;
  medianEnding: number;
  percent: number | null; // set only for the percent strategy
  approximate: boolean;
};

function evaluatePlan(
  inputs: SimInputs,
  stocksPct: number,
  expected: number,
  vol: number,
  engine: "historical" | "montecarlo",
  mcSeed: number,
): { successRate: number; medianEnding: number } | null {
  // The solver scores success by the never-runs-out rate (see the
  // solver note above); the median ending is the same runs' median
  // ending balance, exactly as the tabs compute it.
  if (engine === "historical") {
    const h = runHistorical(inputs, stocksPct);
    return h ? { successRate: h.neverOutSuccessRate, medianEnding: h.medianEnding } : null;
  }
  const mc = runMonteCarlo(
    inputs,
    expected,
    vol,
    mcSeed,
    MONTE_CARLO_TAB_RUNS,
  );
  return mc ? { successRate: mc.neverOutSuccessRate, medianEnding: mc.p50 } : null;
}

// Guardrails solver: exhaustive $100-step scan (see the note
// above — binary search is invalid for this strategy). Feasibility
// uses runNeverRunsOut over the very return sequences the chosen
// engine uses, so a step counts as feasible exactly when the full
// engine's never-runs-out success rate at that spending meets the
// target — the same predicate evaluatePlan scores the winner by.
function solveGuardrailsScan(
  base: SimInputs,
  stocksPct: number,
  expected: number,
  vol: number,
  engine: "historical" | "montecarlo",
  targetPct: number,
  capSteps: number,
  approximate: boolean,
  mcSeed: number,
): SolverResult | null {
  const STEP = 10000; // $100 in cents
  const planYears = base.endAge - base.currentAge;
  if (planYears <= 0) return null;
  const runReturns: number[][] = [];
  if (engine === "historical") {
    const allReturns = historicalRealReturns(stocksPct);
    const lastYear = HISTORICAL[HISTORICAL.length - 1]?.year ?? 0;
    for (let idx = 0; idx < HISTORICAL.length; idx++) {
      const sy = HISTORICAL[idx]?.year ?? 0;
      if (sy + planYears - 1 > lastYear) break;
      runReturns.push(allReturns.slice(idx, idx + planYears));
    }
  } else {
    // The very stream runMonteCarlo draws for the tab's seed.
    const rng = mulberry32(mcSeed * 7919 + 17);
    for (let run = 0; run < MONTE_CARLO_TAB_RUNS; run++) {
      const returns: number[] = [];
      for (let i = 0; i < planYears; i++) {
        returns.push(expected + vol * normalRandom(rng));
      }
      runReturns.push(returns);
    }
  }
  if (runReturns.length === 0) return null;
  const needed = Math.ceil((targetPct / 100) * runReturns.length - 1e-9);
  const allowedFail = runReturns.length - needed;
  const feasible = (cents: number): boolean => {
    const inp: SimInputs = { ...base, spendingCents: cents };
    let succ = 0;
    let fail = 0;
    for (const returns of runReturns) {
      if (runNeverRunsOut(inp, returns)) {
        succ++;
        if (succ >= needed) return true;
      } else {
        fail++;
        if (fail > allowedFail) return false;
      }
    }
    return succ >= needed;
  };
  // With no retired years at all, spending never leaves the
  // portfolio, so every spending has the $0-spending success rate
  // (already known to meet the target — the caller checked) and
  // the cap binds, exactly as in the binary-search path. Scanning
  // to the cap step by step would only waste the time.
  if (base.retirementAge >= base.endAge) {
    const winner = evaluatePlan(
      { ...base, spendingCents: capSteps * STEP },
      stocksPct,
      expected,
      vol,
      engine,
      mcSeed,
    );
    if (!winner) return null;
    return {
      maxSpendingCents: capSteps * STEP,
      successRate: winner.successRate,
      medianEnding: winner.medianEnding,
      percent: null,
      approximate,
    };
  }
  // Proven ceiling (see the solver note above): no spending at or
  // above the best balance at retirement plus the extra income can
  // succeed. The income term is the eventual income — the amount
  // itself whenever it has a start age — NOT just the income
  // active in the first retired year: a later-starting income
  // larger than the spending revives a zeroed balance, so a
  // first-year-income ceiling would cut the scan short and
  // understate the maximum.
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
    Math.max(0, Math.floor((maxRetBal + eventualIncome - 1) / STEP)),
  );
  let best = 0;
  for (let k = 1; k <= scanSteps; k++) {
    if (feasible(k * STEP)) best = k;
  }
  const winner = evaluatePlan(
    { ...base, spendingCents: best * STEP },
    stocksPct,
    expected,
    vol,
    engine,
    mcSeed,
  );
  if (!winner) return null;
  return {
    maxSpendingCents: best * STEP,
    successRate: winner.successRate,
    medianEnding: winner.medianEnding,
    percent: null,
    approximate,
  };
}

export function solveMaxSpending(
  base: SimInputs,
  stocksPct: number,
  expected: number,
  vol: number,
  engine: "historical" | "montecarlo",
  targetPct: number,
  mcSeed: number = MONTE_CARLO_TAB_SEED_DEFAULT,
): SolverResult | null {
  const approximate = engine === "montecarlo";
  const STEP = 10000; // $100 in cents

  if (base.strategy === "percent") {
    if (base.startCents <= 0) return null;
    const maxSteps = Math.floor((base.startCents * 0.3) / STEP); // up to 30%/yr
    if (maxSteps <= 0) return null;
    const pctFor = (k: number) => (k * STEP * 100) / base.startCents;
    const evalStep = (k: number) =>
      evaluatePlan(
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
      return { maxSpendingCents: 0, successRate: at0.successRate, medianEnding: at0.medianEnding, percent: 0, approximate };
    }
    const atMax = evalStep(maxSteps);
    if (atMax && atMax.successRate >= targetPct) {
      return { maxSpendingCents: maxSteps * STEP, successRate: atMax.successRate, medianEnding: atMax.medianEnding, percent: pctFor(maxSteps), approximate };
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
    return { maxSpendingCents: lo * STEP, successRate: best.successRate, medianEnding: best.medianEnding, percent: pctFor(lo), approximate };
  }

  // Constant, phased, and guardrails all solve for the (starting /
  // base) annual spending — for phased that is the pre-decline
  // amount, priced through the phased path itself.
  const evalSpend = (cents: number) =>
    evaluatePlan(
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
    return { maxSpendingCents: 0, successRate: at0.successRate, medianEnding: at0.medianEnding, percent: null, approximate };
  }
  const capSteps = Math.max(1, Math.floor(Math.max(base.startCents * 2, 100_000_000) / STEP));
  if (base.strategy === "guardrails") {
    return solveGuardrailsScan(
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
  let lo = 0; // feasible (in $100 steps)
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
    // Even the cap meets the target.
    return { maxSpendingCents: hi * STEP, successRate: eHi.successRate, medianEnding: eHi.medianEnding, percent: null, approximate };
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const e = evalSpend(mid * STEP);
    if (e && e.successRate >= targetPct) lo = mid;
    else hi = mid;
  }
  const best = evalSpend(lo * STEP);
  if (!best) return null;
  return { maxSpendingCents: lo * STEP, successRate: best.successRate, medianEnding: best.medianEnding, percent: null, approximate };
}

// Build simulation inputs from a stored input set (a saved scenario),
// applying the same clamps and fallbacks as the main inputs: ages
// clamped to the save schema's ranges, a negative income clamped to
// 0, and an income amount with no start age counting from the
// retirement age. Null portfolio / spending fall back to the live
// defaults, null expected return / volatility to the blend, and
// null guardrails knobs to the professional defaults (120/80/10).
// The phased knobs are OPTIONAL in the raw set: records and
// scenarios stored before the phased strategy existed do not
// carry them at all, and absence (or null) resolves to the
// defaults (start age 75, decline 1%/yr) via effectivePhased —
// stored records are never rewritten to add them.
export function buildSimInputs(
  raw: {
    portfolioCents: number | null;
    spendingCents: number | null;
    currentAge: number | null;
    retirementAge: number | null;
    endAge: number | null;
    stocksPct: number | null;
    extraIncomeCents: number | null;
    extraIncomeStartAge: number | null;
    expectedReturnPct: number | null;
    volatilityPct: number | null;
    strategy: SpendingStrategy | null;
    percentOfPortfolio: number | null;
    guardrailsCutPct: number | null;
    guardrailsRaisePct: number | null;
    guardrailsAdjustmentPct: number | null;
    phaseStartAge?: number | null;
    phaseDeclinePct?: number | null;
  },
  defaults: {
    portfolioCents: number;
    spendingCents: number;
    // Factory default for a null current age: the caller passes the
    // birth-year-derived age (current year minus the birth year
    // stored in the Roth inputs) when it has one; absent that, the
    // fixed fallback 55 applies — the same rule the Retirement
    // view's fresh start / Reset / blank fallback follows.
    defaultCurrentAge?: number;
  },
): { inputs: SimInputs; stocks: number; expected: number; vol: number } | null {
  const clampAge = (n: number, max: number): number =>
    Math.min(max, Math.max(0, Math.round(n)));
  const start = raw.portfolioCents ?? defaults.portfolioCents;
  const spend = raw.spendingCents ?? defaults.spendingCents;
  const curAge = clampAge(raw.currentAge ?? defaults.defaultCurrentAge ?? 55, 120);
  const retAge = clampAge(raw.retirementAge ?? curAge, 120);
  const endAge = clampAge(raw.endAge ?? 95, 130);
  if (start < 0 || spend < 0) return null;
  if (endAge <= curAge) return null;
  const stocks = Math.min(100, Math.max(0, raw.stocksPct ?? STOCKS_PCT_DEFAULT));
  const extraCents = Math.max(0, raw.extraIncomeCents ?? 0);
  return {
    inputs: {
      startCents: start,
      spendingCents: spend,
      currentAge: curAge,
      retirementAge: retAge,
      endAge,
      extraIncomeCents: extraCents,
      extraIncomeStartAge:
        raw.extraIncomeStartAge != null
          ? clampAge(raw.extraIncomeStartAge, 120)
          : extraCents > 0
            ? retAge
            : null,
      strategy: raw.strategy ?? "constant",
      percentOfPortfolio: Math.min(100, Math.max(0, raw.percentOfPortfolio ?? 5)),
      // Blank knobs resolve to the professional defaults and are
      // clamped (incl. cut above raise) exactly as the live inputs.
      ...effectiveGuardrails(
        raw.guardrailsCutPct,
        raw.guardrailsRaisePct,
        raw.guardrailsAdjustmentPct,
      ),
      // Absent / blank phased knobs resolve to the phased
      // defaults (75 / 1) and are clamped exactly as the live
      // inputs.
      ...effectivePhased(raw.phaseStartAge, raw.phaseDeclinePct),
    },
    stocks,
    expected: (raw.expectedReturnPct ?? blendedExpected(stocks)) / 100,
    vol: Math.max(0, (raw.volatilityPct ?? blendedVol(stocks)) / 100),
  };
}

