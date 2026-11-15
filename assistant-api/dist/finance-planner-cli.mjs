import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";

var HISTORICAL = [
  { year: 1928, stockPct: 43.81, bondPct: 0.84, cpiPct: -1.7 },
  { year: 1929, stockPct: -8.3, bondPct: 4.2, cpiPct: 0 },
  { year: 1930, stockPct: -25.12, bondPct: 4.54, cpiPct: -2.3 },
  { year: 1931, stockPct: -43.84, bondPct: -2.56, cpiPct: -9 },
  { year: 1932, stockPct: -8.64, bondPct: 8.79, cpiPct: -9.9 },
  { year: 1933, stockPct: 49.98, bondPct: 1.86, cpiPct: -5.1 },
  { year: 1934, stockPct: -1.19, bondPct: 7.96, cpiPct: 3.1 },
  { year: 1935, stockPct: 46.74, bondPct: 4.47, cpiPct: 2.2 },
  { year: 1936, stockPct: 31.94, bondPct: 5.02, cpiPct: 1.5 },
  { year: 1937, stockPct: -35.34, bondPct: 1.38, cpiPct: 3.6 },
  { year: 1938, stockPct: 29.28, bondPct: 4.21, cpiPct: -2.1 },
  { year: 1939, stockPct: -1.1, bondPct: 4.41, cpiPct: -1.4 },
  { year: 1940, stockPct: -10.67, bondPct: 5.4, cpiPct: 0.7 },
  { year: 1941, stockPct: -12.77, bondPct: -2.02, cpiPct: 5 },
  { year: 1942, stockPct: 19.17, bondPct: 2.29, cpiPct: 10.9 },
  { year: 1943, stockPct: 25.06, bondPct: 2.49, cpiPct: 6.1 },
  { year: 1944, stockPct: 19.03, bondPct: 2.58, cpiPct: 1.7 },
  { year: 1945, stockPct: 35.82, bondPct: 3.8, cpiPct: 2.3 },
  { year: 1946, stockPct: -8.43, bondPct: 3.13, cpiPct: 8.3 },
  { year: 1947, stockPct: 5.2, bondPct: 0.92, cpiPct: 14.4 },
  { year: 1948, stockPct: 5.7, bondPct: 1.95, cpiPct: 8.1 },
  { year: 1949, stockPct: 18.3, bondPct: 4.66, cpiPct: -1.2 },
  { year: 1950, stockPct: 30.81, bondPct: 0.43, cpiPct: 1.3 },
  { year: 1951, stockPct: 23.68, bondPct: -0.3, cpiPct: 7.9 },
  { year: 1952, stockPct: 18.15, bondPct: 2.27, cpiPct: 1.9 },
  { year: 1953, stockPct: -1.21, bondPct: 4.14, cpiPct: 0.8 },
  { year: 1954, stockPct: 52.56, bondPct: 3.29, cpiPct: 0.7 },
  { year: 1955, stockPct: 32.6, bondPct: -1.34, cpiPct: -0.4 },
  { year: 1956, stockPct: 7.44, bondPct: -2.26, cpiPct: 1.5 },
  { year: 1957, stockPct: -10.46, bondPct: 6.8, cpiPct: 3.3 },
  { year: 1958, stockPct: 43.72, bondPct: -2.1, cpiPct: 2.8 },
  { year: 1959, stockPct: 12.06, bondPct: -2.65, cpiPct: 0.7 },
  { year: 1960, stockPct: 0.34, bondPct: 11.64, cpiPct: 1.7 },
  { year: 1961, stockPct: 26.64, bondPct: 2.06, cpiPct: 1 },
  { year: 1962, stockPct: -8.81, bondPct: 5.69, cpiPct: 1 },
  { year: 1963, stockPct: 22.61, bondPct: 1.68, cpiPct: 1.3 },
  { year: 1964, stockPct: 16.42, bondPct: 3.73, cpiPct: 1.3 },
  { year: 1965, stockPct: 12.4, bondPct: 0.72, cpiPct: 1.6 },
  { year: 1966, stockPct: -9.97, bondPct: 2.91, cpiPct: 2.9 },
  { year: 1967, stockPct: 23.8, bondPct: -1.58, cpiPct: 3.1 },
  { year: 1968, stockPct: 10.81, bondPct: 3.27, cpiPct: 4.2 },
  { year: 1969, stockPct: -8.24, bondPct: -5.01, cpiPct: 5.5 },
  { year: 1970, stockPct: 3.56, bondPct: 16.75, cpiPct: 5.7 },
  { year: 1971, stockPct: 14.22, bondPct: 9.79, cpiPct: 4.4 },
  { year: 1972, stockPct: 18.76, bondPct: 2.82, cpiPct: 3.2 },
  { year: 1973, stockPct: -14.31, bondPct: 3.66, cpiPct: 6.2 },
  { year: 1974, stockPct: -25.9, bondPct: 1.99, cpiPct: 11 },
  { year: 1975, stockPct: 37, bondPct: 3.61, cpiPct: 9.1 },
  { year: 1976, stockPct: 23.83, bondPct: 15.98, cpiPct: 5.8 },
  { year: 1977, stockPct: -6.98, bondPct: 1.29, cpiPct: 6.5 },
  { year: 1978, stockPct: 6.51, bondPct: -0.78, cpiPct: 7.6 },
  { year: 1979, stockPct: 18.52, bondPct: 0.67, cpiPct: 11.3 },
  { year: 1980, stockPct: 31.74, bondPct: -2.99, cpiPct: 13.5 },
  { year: 1981, stockPct: -4.7, bondPct: 8.2, cpiPct: 10.3 },
  { year: 1982, stockPct: 20.42, bondPct: 32.81, cpiPct: 6.2 },
  { year: 1983, stockPct: 22.34, bondPct: 3.2, cpiPct: 3.2 },
  { year: 1984, stockPct: 6.15, bondPct: 13.73, cpiPct: 4.3 },
  { year: 1985, stockPct: 31.24, bondPct: 25.71, cpiPct: 3.6 },
  { year: 1986, stockPct: 18.49, bondPct: 24.28, cpiPct: 1.9 },
  { year: 1987, stockPct: 5.81, bondPct: -4.96, cpiPct: 3.6 },
  { year: 1988, stockPct: 16.54, bondPct: 8.22, cpiPct: 4.1 },
  { year: 1989, stockPct: 31.48, bondPct: 17.69, cpiPct: 4.8 },
  { year: 1990, stockPct: -3.06, bondPct: 6.24, cpiPct: 5.4 },
  { year: 1991, stockPct: 30.23, bondPct: 15, cpiPct: 4.2 },
  { year: 1992, stockPct: 7.49, bondPct: 9.36, cpiPct: 3 },
  { year: 1993, stockPct: 9.97, bondPct: 14.21, cpiPct: 3 },
  { year: 1994, stockPct: 1.33, bondPct: -8.04, cpiPct: 2.6 },
  { year: 1995, stockPct: 37.2, bondPct: 23.48, cpiPct: 2.8 },
  { year: 1996, stockPct: 22.68, bondPct: 1.43, cpiPct: 3 },
  { year: 1997, stockPct: 33.1, bondPct: 9.94, cpiPct: 2.3 },
  { year: 1998, stockPct: 28.34, bondPct: 14.92, cpiPct: 1.6 },
  { year: 1999, stockPct: 20.89, bondPct: -8.25, cpiPct: 2.2 },
  { year: 2000, stockPct: -9.03, bondPct: 16.66, cpiPct: 3.4 },
  { year: 2001, stockPct: -11.85, bondPct: 5.57, cpiPct: 2.8 },
  { year: 2002, stockPct: -21.97, bondPct: 15.12, cpiPct: 1.6 },
  { year: 2003, stockPct: 28.36, bondPct: 0.38, cpiPct: 2.3 },
  { year: 2004, stockPct: 10.74, bondPct: 4.49, cpiPct: 2.7 },
  { year: 2005, stockPct: 4.83, bondPct: 2.87, cpiPct: 3.4 },
  { year: 2006, stockPct: 15.61, bondPct: 1.96, cpiPct: 3.2 },
  { year: 2007, stockPct: 5.48, bondPct: 10.21, cpiPct: 2.8 },
  { year: 2008, stockPct: -36.55, bondPct: 20.1, cpiPct: 3.8 },
  { year: 2009, stockPct: 25.94, bondPct: -11.12, cpiPct: -0.4 },
  { year: 2010, stockPct: 14.82, bondPct: 8.46, cpiPct: 1.6 },
  { year: 2011, stockPct: 2.1, bondPct: 16.04, cpiPct: 3.2 },
  { year: 2012, stockPct: 15.89, bondPct: 2.97, cpiPct: 2.1 },
  { year: 2013, stockPct: 32.15, bondPct: -9.1, cpiPct: 1.5 },
  { year: 2014, stockPct: 13.52, bondPct: 10.75, cpiPct: 1.6 },
  { year: 2015, stockPct: 1.38, bondPct: 1.28, cpiPct: 0.1 },
  { year: 2016, stockPct: 11.77, bondPct: 0.69, cpiPct: 1.3 },
  { year: 2017, stockPct: 21.61, bondPct: 2.8, cpiPct: 2.1 },
  { year: 2018, stockPct: -4.23, bondPct: -0.02, cpiPct: 2.4 },
  { year: 2019, stockPct: 31.21, bondPct: 9.64, cpiPct: 1.8 },
  { year: 2020, stockPct: 18.02, bondPct: 11.33, cpiPct: 1.2 },
  { year: 2021, stockPct: 28.47, bondPct: -4.42, cpiPct: 4.7 },
  { year: 2022, stockPct: -18.04, bondPct: -17.83, cpiPct: 8 },
  { year: 2023, stockPct: 26.06, bondPct: 3.88, cpiPct: 4.1 },
  { year: 2024, stockPct: 24.88, bondPct: -1.64, cpiPct: 2.9 },
  { year: 2025, stockPct: 17.78, bondPct: 7.8, cpiPct: 2.6 }
];

function percentile(sorted, p) {
  if (sorted.length === 0)
    return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p / 100 * sorted.length)));
  return sorted[idx] ?? 0;
}
function medianOf(values) {
  if (values.length === 0)
    return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] ?? 0 : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}
function horizonYears(currentAge, endAge) {
  return Math.max(0, endAge - currentAge + 1);
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = a + 1831565813 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function normalRandom(rng) {
  let u = 0;
  let v = 0;
  while (u === 0)
    u = rng();
  while (v === 0)
    v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
var GUARDRAILS_CUT_DEFAULT = 120;
var GUARDRAILS_RAISE_DEFAULT = 80;
var GUARDRAILS_ADJUSTMENT_DEFAULT = 10;
var GUARDRAILS_RATE_REL_TOLERANCE = 0.000000001;
function guardrailsAdjustedSpending(currentSpending, bal, initialRate, inputs) {
  if (bal <= 0 || initialRate <= 0)
    return currentSpending;
  const curRate = currentSpending / bal;
  const adj = inputs.guardrailsAdjustmentPct / 100;
  const cutThreshold = inputs.guardrailsCutPct / 100 * initialRate;
  const raiseThreshold = inputs.guardrailsRaisePct / 100 * initialRate;
  if (curRate - cutThreshold > Math.abs(cutThreshold) * GUARDRAILS_RATE_REL_TOLERANCE) {
    return Math.round(currentSpending * (1 - adj));
  }
  if (raiseThreshold - curRate > Math.abs(raiseThreshold) * GUARDRAILS_RATE_REL_TOLERANCE) {
    return Math.round(currentSpending * (1 + adj));
  }
  return currentSpending;
}
var PHASE_START_AGE_DEFAULT = 75;
var PHASE_DECLINE_PCT_DEFAULT = 1;
var STOCKS_PCT_DEFAULT = 95;
var EXPECTED_RETURN_DEFAULT = 5;
function phasedGrossCents(inputs, age) {
  if (age <= inputs.phaseStartAge)
    return inputs.spendingCents;
  const factor = Math.pow(1 - inputs.phaseDeclinePct / 100, age - inputs.phaseStartAge);
  return Math.round(inputs.spendingCents * factor);
}
function incomeCentsAt(inputs, age) {
  const sched = inputs.incomeSchedule;
  if (sched && sched.length > 0) {
    let total = 0;
    for (const s of sched) {
      const start = s.startAge ?? inputs.retirementAge;
      if (age >= start)
        total += s.amountCents;
    }
    return total;
  }
  return inputs.extraIncomeStartAge != null && age >= inputs.extraIncomeStartAge ? inputs.extraIncomeCents : 0;
}
function eventualIncomeCents(inputs) {
  const sched = inputs.incomeSchedule;
  if (sched && sched.length > 0) {
    let total = 0;
    for (const s of sched) {
      const start = s.startAge ?? inputs.retirementAge;
      if (start <= inputs.endAge)
        total += s.amountCents;
    }
    return total;
  }
  return inputs.extraIncomeStartAge != null ? inputs.extraIncomeCents : 0;
}
function simulateDetailed(inputs, returns) {
  const years = horizonYears(inputs.currentAge, inputs.endAge);
  const balances = [inputs.startCents];
  const grossWithdrawals = [];
  const netWithdrawals = [];
  let bal = inputs.startCents;
  let currentSpending = inputs.spendingCents;
  let initialRate = null;
  for (let i = 0;i < years; i++) {
    const age = inputs.currentAge + i;
    let gross = 0;
    let net = 0;
    if (age >= inputs.retirementAge) {
      const income = incomeCentsAt(inputs, age);
      if (inputs.strategy === "percent") {
        gross = Math.round(bal * (inputs.percentOfPortfolio / 100));
      } else if (inputs.strategy === "guardrails") {
        if (initialRate == null) {
          initialRate = bal > 0 ? inputs.spendingCents / bal : 0;
          currentSpending = inputs.spendingCents;
        }
        currentSpending = guardrailsAdjustedSpending(currentSpending, bal, initialRate, inputs);
        gross = currentSpending;
      } else if (inputs.strategy === "phased") {
        gross = phasedGrossCents(inputs, age);
      } else {
        gross = inputs.spendingCents;
      }
      net = gross - income;
      bal -= net;
      if (bal < 0)
        bal = 0;
    }
    grossWithdrawals.push(gross);
    netWithdrawals.push(net);
    const r = returns[i] ?? 0;
    bal = bal * (1 + r);
    if (bal < 0)
      bal = 0;
    balances.push(bal);
  }
  return { balances, grossWithdrawals, netWithdrawals };
}
function runNeverRunsOut(inputs, returns) {
  const years = horizonYears(inputs.currentAge, inputs.endAge);
  let bal = inputs.startCents;
  let currentSpending = inputs.spendingCents;
  let initialRate = null;
  for (let i = 0;i < years; i++) {
    const age = inputs.currentAge + i;
    if (age >= inputs.retirementAge) {
      const income = incomeCentsAt(inputs, age);
      let gross;
      if (inputs.strategy === "percent") {
        gross = Math.round(bal * (inputs.percentOfPortfolio / 100));
      } else if (inputs.strategy === "guardrails") {
        if (initialRate == null) {
          initialRate = bal > 0 ? inputs.spendingCents / bal : 0;
          currentSpending = inputs.spendingCents;
        }
        currentSpending = guardrailsAdjustedSpending(currentSpending, bal, initialRate, inputs);
        gross = currentSpending;
      } else if (inputs.strategy === "phased") {
        gross = phasedGrossCents(inputs, age);
      } else {
        gross = inputs.spendingCents;
      }
      const net = gross - income;
      if (net > bal)
        return false;
      bal -= net;
      if (bal < 0)
        bal = 0;
    }
    const r = returns[i] ?? 0;
    bal = bal * (1 + r);
    if (bal < 0)
      bal = 0;
  }
  return true;
}
function blendedExpected(stocksPct) {
  return stocksPct / 100 * 7 + (1 - stocksPct / 100) * 2;
}
function historicalRealReturns(stocksPct) {
  const sFrac = stocksPct / 100;
  return HISTORICAL.map((h) => {
    const stockReal = (1 + h.stockPct / 100) / (1 + h.cpiPct / 100) - 1;
    const bondReal = (1 + h.bondPct / 100) / (1 + h.cpiPct / 100) - 1;
    return sFrac * stockReal + (1 - sFrac) * bondReal;
  });
}
function spendingStats(inputs, runsGross) {
  if (inputs.strategy !== "percent") {
    return {
      lowestSpending: null,
      averageSpending: null,
      medianFinalYearSpending: null,
      medianFirstRetiredYearSpending: null
    };
  }
  let lowest = null;
  const perRunAvg = [];
  const perRunFinal = [];
  const perRunFirst = [];
  for (const gross of runsGross) {
    const retired = gross.filter((_, i) => inputs.currentAge + i >= inputs.retirementAge);
    if (retired.length === 0)
      continue;
    perRunAvg.push(retired.reduce((s, v) => s + v, 0) / retired.length);
    perRunFirst.push(retired[0] ?? 0);
    perRunFinal.push(retired[retired.length - 1] ?? 0);
    for (const v of retired)
      lowest = lowest == null ? v : Math.min(lowest, v);
  }
  return {
    lowestSpending: lowest,
    averageSpending: perRunAvg.length > 0 ? medianOf(perRunAvg) : null,
    medianFinalYearSpending: perRunFinal.length > 0 ? medianOf(perRunFinal) : null,
    medianFirstRetiredYearSpending: perRunFirst.length > 0 ? medianOf(perRunFirst) : null
  };
}
function spendingAdequacyRate(inputs, runsGross) {
  const floor = inputs.minimumAnnualSpendingCents;
  if (floor == null || floor <= 0)
    return null;
  let adequate = 0;
  let counted = 0;
  for (const gross of runsGross) {
    const retired = gross.filter((_, i) => inputs.currentAge + i >= inputs.retirementAge);
    if (retired.length === 0)
      continue;
    counted++;
    if (retired.every((g) => g >= floor))
      adequate++;
  }
  if (counted === 0)
    return null;
  return adequate / counted * 100;
}
function runHistorical(inputs, stocksPct) {
  const planYears = horizonYears(inputs.currentAge, inputs.endAge);
  if (planYears <= 0)
    return null;
  const allReturns = historicalRealReturns(stocksPct);
  const lastYear = HISTORICAL[HISTORICAL.length - 1]?.year ?? 0;
  const runs = [];
  for (let idx = 0;idx < HISTORICAL.length; idx++) {
    const sy = HISTORICAL[idx]?.year ?? 0;
    if (sy + planYears - 1 > lastYear)
      break;
    const returns = allReturns.slice(idx, idx + planYears);
    const det = simulateDetailed(inputs, returns);
    runs.push({
      startYear: sy,
      path: det.balances,
      ending: det.balances[det.balances.length - 1] ?? 0,
      returns,
      grossWithdrawals: det.grossWithdrawals,
      netWithdrawals: det.netWithdrawals
    });
  }
  if (runs.length === 0)
    return null;
  const endings = runs.map((r) => r.ending);
  const successes = endings.filter((e) => e > 0).length;
  const neverOut = runs.filter((r) => runNeverRunsOut(inputs, r.returns)).length;
  const worst = runs.reduce((a, b) => b.ending < a.ending ? b : a, runs[0] ?? { startYear: 0, path: [], ending: 0, returns: [], grossWithdrawals: [], netWithdrawals: [] });
  const chart = [];
  for (let i = 0;i <= planYears; i++) {
    const row = { age: inputs.currentAge + i };
    const vals = [];
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
    successRate: successes / runs.length * 100,
    neverOutSuccessRate: neverOut / runs.length * 100,
    medianEnding: medianOf(endings),
    worstEnding: worst.ending,
    worstStartYear: worst.startYear,
    lowestSpending: stats.lowestSpending,
    averageSpending: stats.averageSpending,
    medianFinalYearSpending: stats.medianFinalYearSpending,
    medianFirstRetiredYearSpending: stats.medianFirstRetiredYearSpending,
    spendingAdequacySuccessRate: spendingAdequacyRate(inputs, runs.map((r) => r.grossWithdrawals)),
    minimumAnnualSpendingCents: inputs.minimumAnnualSpendingCents ?? null
  };
}
var MONTE_CARLO_TAB_SEED_DEFAULT = 12345;
var MONTE_CARLO_TAB_RUNS = 1000;
function runMonteCarlo(inputs, expected, vol, seed, runCount = MONTE_CARLO_TAB_RUNS) {
  const planYears = horizonYears(inputs.currentAge, inputs.endAge);
  if (planYears <= 0)
    return null;
  const rng = mulberry32(seed * 7919 + 17);
  const endings = [];
  const paths = [];
  const runsGross = [];
  let neverOut = 0;
  for (let run = 0;run < runCount; run++) {
    const returns = [];
    for (let i = 0;i < planYears; i++) {
      returns.push(expected + vol * normalRandom(rng));
    }
    const det = simulateDetailed(inputs, returns);
    paths.push(det.balances);
    runsGross.push(det.grossWithdrawals);
    endings.push(det.balances[det.balances.length - 1] ?? 0);
    if (runNeverRunsOut(inputs, returns))
      neverOut++;
  }
  const sortedEndings = [...endings].sort((a, b) => a - b);
  const successes = endings.filter((e) => e > 0).length;
  const chart = [];
  for (let i = 0;i <= planYears; i++) {
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
      p90
    });
  }
  const stats = spendingStats(inputs, runsGross);
  return {
    successRate: successes / runCount * 100,
    neverOutSuccessRate: neverOut / runCount * 100,
    p10: percentile(sortedEndings, 10),
    p50: medianOf(endings),
    p90: percentile(sortedEndings, 90),
    chart,
    lowestSpending: stats.lowestSpending,
    averageSpending: stats.averageSpending,
    medianFinalYearSpending: stats.medianFinalYearSpending,
    medianFirstRetiredYearSpending: stats.medianFirstRetiredYearSpending,
    spendingAdequacySuccessRate: spendingAdequacyRate(inputs, runsGross),
    minimumAnnualSpendingCents: inputs.minimumAnnualSpendingCents ?? null
  };
}
function solverResult(args) {
  return {
    maxSpendingCents: args.maxSpendingCents,
    successRate: args.successRate,
    medianEnding: args.medianEnding,
    percent: args.percent,
    approximate: args.approximate,
    targetSuccessRate: args.targetPct,
    achievedSuccessRate: args.successRate,
    targetAchieved: args.successRate >= args.targetPct,
    solutionStatus: args.solutionStatus
  };
}
function evaluatePlan(inputs, stocksPct, expected, vol, engine, mcSeed) {
  if (engine === "historical") {
    const h = runHistorical(inputs, stocksPct);
    return h ? { successRate: h.neverOutSuccessRate, medianEnding: h.medianEnding } : null;
  }
  const mc = runMonteCarlo(inputs, expected, vol, mcSeed, MONTE_CARLO_TAB_RUNS);
  return mc ? { successRate: mc.neverOutSuccessRate, medianEnding: mc.p50 } : null;
}
function solveGuardrailsScan(base, stocksPct, expected, vol, engine, targetPct, capSteps, approximate, mcSeed) {
  const STEP = 1e4;
  const planYears = horizonYears(base.currentAge, base.endAge);
  if (planYears <= 0)
    return null;
  const runReturns = [];
  if (engine === "historical") {
    const allReturns = historicalRealReturns(stocksPct);
    const lastYear = HISTORICAL[HISTORICAL.length - 1]?.year ?? 0;
    for (let idx = 0;idx < HISTORICAL.length; idx++) {
      const sy = HISTORICAL[idx]?.year ?? 0;
      if (sy + planYears - 1 > lastYear)
        break;
      runReturns.push(allReturns.slice(idx, idx + planYears));
    }
  } else {
    const rng = mulberry32(mcSeed * 7919 + 17);
    for (let run = 0;run < MONTE_CARLO_TAB_RUNS; run++) {
      const returns = [];
      for (let i = 0;i < planYears; i++) {
        returns.push(expected + vol * normalRandom(rng));
      }
      runReturns.push(returns);
    }
  }
  if (runReturns.length === 0)
    return null;
  const needed = Math.ceil(targetPct / 100 * runReturns.length - 0.000000001);
  const allowedFail = runReturns.length - needed;
  const feasible = (cents) => {
    const inp = { ...base, spendingCents: cents };
    let succ = 0;
    let fail = 0;
    for (const returns of runReturns) {
      if (runNeverRunsOut(inp, returns)) {
        succ++;
        if (succ >= needed)
          return true;
      } else {
        fail++;
        if (fail > allowedFail)
          return false;
      }
    }
    return succ >= needed;
  };
  const preYears = Math.max(0, Math.min(planYears, base.retirementAge - base.currentAge));
  const eventualIncome = eventualIncomeCents(base);
  let maxRetBal = 0;
  for (const returns of runReturns) {
    let b = base.startCents;
    for (let i = 0;i < preYears; i++) {
      b = b * (1 + (returns[i] ?? 0));
      if (b < 0)
        b = 0;
    }
    if (b > maxRetBal)
      maxRetBal = b;
  }
  const scanSteps = Math.min(capSteps, Math.max(0, Math.floor((maxRetBal + eventualIncome) / STEP)));
  let best = 0;
  for (let k = 1;k <= scanSteps; k++) {
    if (feasible(k * STEP))
      best = k;
  }
  const winner = evaluatePlan({ ...base, spendingCents: best * STEP }, stocksPct, expected, vol, engine, mcSeed);
  if (!winner)
    return null;
  const solutionStatus = winner.successRate < targetPct ? "infeasible_at_zero" : best === scanSteps && scanSteps === capSteps ? "capped" : best === 0 ? "feasible_at_zero" : "feasible";
  return solverResult({
    maxSpendingCents: best * STEP,
    successRate: winner.successRate,
    medianEnding: winner.medianEnding,
    percent: null,
    approximate,
    targetPct,
    solutionStatus
  });
}
function solveMaxSpending(base, stocksPct, expected, vol, engine, targetPct, mcSeed = MONTE_CARLO_TAB_SEED_DEFAULT) {
  if (base.retirementAge >= base.endAge)
    return null;
  const approximate = engine === "montecarlo";
  const STEP = 1e4;
  if (base.strategy === "percent") {
    if (base.startCents <= 0)
      return null;
    const maxSteps = Math.floor(base.startCents * 0.3 / STEP);
    if (maxSteps <= 0)
      return null;
    const pctFor = (k) => k * STEP * 100 / base.startCents;
    const evalStep = (k) => evaluatePlan({ ...base, percentOfPortfolio: pctFor(k) }, stocksPct, expected, vol, engine, mcSeed);
    const at0 = evalStep(0);
    if (!at0)
      return null;
    if (at0.successRate < targetPct) {
      return solverResult({ maxSpendingCents: 0, successRate: at0.successRate, medianEnding: at0.medianEnding, percent: 0, approximate, targetPct, solutionStatus: "infeasible_at_zero" });
    }
    const atMax = evalStep(maxSteps);
    if (atMax && atMax.successRate >= targetPct) {
      return solverResult({ maxSpendingCents: maxSteps * STEP, successRate: atMax.successRate, medianEnding: atMax.medianEnding, percent: pctFor(maxSteps), approximate, targetPct, solutionStatus: "capped" });
    }
    let lo = 0;
    let hi = maxSteps;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      const e = evalStep(mid);
      if (e && e.successRate >= targetPct)
        lo = mid;
      else
        hi = mid;
    }
    const best = evalStep(lo);
    if (!best)
      return null;
    return solverResult({ maxSpendingCents: lo * STEP, successRate: best.successRate, medianEnding: best.medianEnding, percent: pctFor(lo), approximate, targetPct, solutionStatus: lo === 0 ? "feasible_at_zero" : "feasible" });
  }
  const evalSpend = (cents) => evaluatePlan({ ...base, spendingCents: cents }, stocksPct, expected, vol, engine, mcSeed);
  const at0 = evalSpend(0);
  if (!at0)
    return null;
  if (at0.successRate < targetPct) {
    return solverResult({ maxSpendingCents: 0, successRate: at0.successRate, medianEnding: at0.medianEnding, percent: null, approximate, targetPct, solutionStatus: "infeasible_at_zero" });
  }
  const capSteps = Math.max(1, Math.floor(Math.max(base.startCents * 2, 1e8) / STEP));
  if (base.strategy === "guardrails") {
    return solveGuardrailsScan(base, stocksPct, expected, vol, engine, targetPct, capSteps, approximate, mcSeed);
  }
  let lo = 0;
  let hi = Math.min(capSteps, Math.max(1, Math.ceil(Math.max(base.spendingCents, 5000000) / STEP)));
  let eHi = evalSpend(hi * STEP);
  while (eHi && eHi.successRate >= targetPct && hi < capSteps) {
    lo = hi;
    hi = Math.min(capSteps, hi * 2);
    eHi = evalSpend(hi * STEP);
  }
  if (eHi && eHi.successRate >= targetPct) {
    return solverResult({ maxSpendingCents: hi * STEP, successRate: eHi.successRate, medianEnding: eHi.medianEnding, percent: null, approximate, targetPct, solutionStatus: "capped" });
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const e = evalSpend(mid * STEP);
    if (e && e.successRate >= targetPct)
      lo = mid;
    else
      hi = mid;
  }
  const best = evalSpend(lo * STEP);
  if (!best)
    return null;
  return solverResult({ maxSpendingCents: lo * STEP, successRate: best.successRate, medianEnding: best.medianEnding, percent: null, approximate, targetPct, solutionStatus: lo === 0 ? "feasible_at_zero" : "feasible" });
}

var TAX_RATES = [10, 12, 22, 24, 32, 35, 37];
var TAX_LAW_2025 = {
  year: 2025,
  rates: TAX_RATES,
  brackets: {
    mfj: [23850, 96950, 206700, 394600, 501050, 751600, Infinity],
    single: [11925, 48475, 103350, 197300, 250525, 626350, Infinity],
    hoh: [17000, 64850, 103350, 197300, 250500, 626350, Infinity]
  },
  standardDeduction: { mfj: 31500, single: 15750, hoh: 23625 },
  age65Addon: { mfj: 1600, single: 2000, hoh: 2000 },
  ltcgZeroTop: { mfj: 96700, single: 48350, hoh: 64750 },
  ltcg20Floor: { mfj: 600050, single: 533400, hoh: 566700 },
  niitThreshold: { mfj: 250000, single: 200000, hoh: 200000 },
  niitRate: 3.8,
  partBStandardMonthly: 185,
  irmaaTiers: [
    { upToSingle: 106000, upToMfj: 212000, partBTotalMonthly: 185, partDSurchargeMonthly: 0 },
    { upToSingle: 133000, upToMfj: 266000, partBTotalMonthly: 259, partDSurchargeMonthly: 13.7 },
    { upToSingle: 167000, upToMfj: 334000, partBTotalMonthly: 370, partDSurchargeMonthly: 35.3 },
    { upToSingle: 200000, upToMfj: 400000, partBTotalMonthly: 480.9, partDSurchargeMonthly: 57 },
    { upToSingle: 499999, upToMfj: 749999, partBTotalMonthly: 591.9, partDSurchargeMonthly: 78.6 },
    { upToSingle: Infinity, upToMfj: Infinity, partBTotalMonthly: 628.9, partDSurchargeMonthly: 85.8 }
  ],
  qcdLimit: 108000,
  elective401kLimit: 2350000,
  catchUp50Limit: 750000,
  catchUp60to63Limit: 1125000,
  overall415cLimit: 7000000,
  hsaLimitSelf: 430000,
  hsaLimitFamily: 855000,
  hsaCatchUp55: 1e5,
  ssWageBase: 17610000,
  payrollSsRatePct: 6.2,
  payrollMedicareRatePct: 1.45,
  payrollAdditionalMedicareRatePct: 0.9,
  payrollAdditionalMedicareThreshold: { mfj: 250000, single: 200000, hoh: 200000 },
  rothCatchUpWageThreshold: 14500000,
  giftAnnualExclusionCents: 1900000,
  kiddieTaxThresholdCents: 270000,
  waStandardDeduction: 278000,
  waRatePct: 7,
  waAdditionalRatePct: 2.9,
  waAdditionalThreshold: 1e6,
  waCharitableThreshold: 278000,
  waCharitableCap: 111000,
  saltCap: 40000,
  saltCapFloor: 1e4,
  saltPhaseOutStart: 500000,
  saltPhaseOutRatePct: 30,
  aotcTier1RatePct: 100,
  aotcTier1Expenses: 2000,
  aotcTier2RatePct: 25,
  aotcTier2Expenses: 2000,
  aotcRefundablePct: 40,
  llcRatePct: 20,
  llcExpenseCap: 1e4,
  eduPhaseOutStart: { mfj: 160000, single: 80000, hoh: 80000 },
  eduPhaseOutWidth: { mfj: 20000, single: 1e4, hoh: 1e4 },
  amtExemption: { mfj: 137000, single: 88100, hoh: 88100 },
  amtPhaseOutStart: { mfj: 1252700, single: 626350, hoh: 626350 },
  amtPhaseOutRatePct: 25,
  amtBreakpoint: 239100,
  amtRateLowPct: 26,
  amtRateHighPct: 28
};
var TAX_LAW_2026 = {
  year: 2026,
  rates: TAX_RATES,
  brackets: {
    mfj: [24800, 100800, 211400, 403550, 512450, 768700, Infinity],
    single: [12400, 50400, 105700, 201775, 256225, 640600, Infinity],
    hoh: [17700, 67450, 105700, 201750, 256200, 640600, Infinity]
  },
  standardDeduction: { mfj: 32200, single: 16100, hoh: 24150 },
  age65Addon: { mfj: 1650, single: 2050, hoh: 2050 },
  ltcgZeroTop: { mfj: 98900, single: 49450, hoh: 66200 },
  ltcg20Floor: { mfj: 613700, single: 545500, hoh: 579600 },
  niitThreshold: { mfj: 250000, single: 200000, hoh: 200000 },
  niitRate: 3.8,
  partBStandardMonthly: 202.9,
  irmaaTiers: [
    { upToSingle: 109000, upToMfj: 218000, partBTotalMonthly: 202.9, partDSurchargeMonthly: 0 },
    { upToSingle: 137000, upToMfj: 274000, partBTotalMonthly: 284.1, partDSurchargeMonthly: 14.5 },
    { upToSingle: 171000, upToMfj: 342000, partBTotalMonthly: 405.8, partDSurchargeMonthly: 37.5 },
    { upToSingle: 205000, upToMfj: 410000, partBTotalMonthly: 527.5, partDSurchargeMonthly: 60.4 },
    { upToSingle: 499999, upToMfj: 749999, partBTotalMonthly: 649.2, partDSurchargeMonthly: 83.3 },
    { upToSingle: Infinity, upToMfj: Infinity, partBTotalMonthly: 689.9, partDSurchargeMonthly: 91 }
  ],
  qcdLimit: 111000,
  elective401kLimit: 2450000,
  catchUp50Limit: 800000,
  catchUp60to63Limit: 1125000,
  overall415cLimit: 7200000,
  hsaLimitSelf: 440000,
  hsaLimitFamily: 875000,
  hsaCatchUp55: 1e5,
  ssWageBase: 18450000,
  payrollSsRatePct: 6.2,
  payrollMedicareRatePct: 1.45,
  payrollAdditionalMedicareRatePct: 0.9,
  payrollAdditionalMedicareThreshold: { mfj: 250000, single: 200000, hoh: 200000 },
  rothCatchUpWageThreshold: 15000000,
  giftAnnualExclusionCents: 1900000,
  kiddieTaxThresholdCents: 270000,
  waStandardDeduction: 278000,
  waRatePct: 7,
  waAdditionalRatePct: 2.9,
  waAdditionalThreshold: 1e6,
  waCharitableThreshold: 278000,
  waCharitableCap: 111000,
  saltCap: 40400,
  saltCapFloor: 1e4,
  saltPhaseOutStart: 505000,
  saltPhaseOutRatePct: 30,
  aotcTier1RatePct: 100,
  aotcTier1Expenses: 2000,
  aotcTier2RatePct: 25,
  aotcTier2Expenses: 2000,
  aotcRefundablePct: 40,
  llcRatePct: 20,
  llcExpenseCap: 1e4,
  eduPhaseOutStart: { mfj: 160000, single: 80000, hoh: 80000 },
  eduPhaseOutWidth: { mfj: 20000, single: 1e4, hoh: 1e4 },
  amtExemption: { mfj: 140200, single: 90100, hoh: 90100 },
  amtPhaseOutStart: { mfj: 1e6, single: 500000, hoh: 500000 },
  amtPhaseOutRatePct: 50,
  amtBreakpoint: 244500,
  amtRateLowPct: 26,
  amtRateHighPct: 28
};
var TAX_LAW_YEARS = [TAX_LAW_2025, TAX_LAW_2026];
var EARLIEST_LAW = TAX_LAW_YEARS[0];
var CURRENT_LAW = TAX_LAW_YEARS[TAX_LAW_YEARS.length - 1];
function lawForYear(year) {
  for (const law of TAX_LAW_YEARS) {
    if (law.year === year)
      return law;
  }
  return year < EARLIEST_LAW.year ? EARLIEST_LAW : CURRENT_LAW;
}
var SALT_SCHEDULE_FIRST_YEAR = 2025;
var SALT_REVERSION_YEAR = 2030;
var SALT_SCHEDULE = {
  2025: { cap: 40000, capFloor: 1e4, phaseOutStart: 500000, phaseOutRatePct: 30 },
  2026: { cap: 40400, capFloor: 1e4, phaseOutStart: 505000, phaseOutRatePct: 30 },
  2027: { cap: 40804, capFloor: 1e4, phaseOutStart: 510050, phaseOutRatePct: 30 },
  2028: { cap: 41212.04, capFloor: 1e4, phaseOutStart: 515150.5, phaseOutRatePct: 30 },
  2029: { cap: 41624.16, capFloor: 1e4, phaseOutStart: 520302.01, phaseOutRatePct: 30 }
};
var SALT_POST_2029 = {
  cap: 1e4,
  capFloor: 1e4,
  phaseOutStart: Infinity,
  phaseOutRatePct: 0
};
function saltScheduleForYear(calendarYear) {
  if (calendarYear >= SALT_REVERSION_YEAR) {
    return { ...SALT_POST_2029, entryYear: SALT_REVERSION_YEAR };
  }
  const entry = SALT_SCHEDULE[calendarYear];
  if (entry)
    return { ...entry, entryYear: calendarYear };
  return {
    ...SALT_SCHEDULE[SALT_SCHEDULE_FIRST_YEAR],
    entryYear: SALT_SCHEDULE_FIRST_YEAR
  };
}
var CHARITABLE_CEILING = {
  ratePct: 60
};
var DEDUCTION_2026 = {
  firstYear: 2026,
  charitableFloorRatePct: 0.5,
  nonItemizerCharitableCap: {
    mfj: 2000,
    single: 1000,
    hoh: 1000
  },
  section68Numerator: 2,
  section68Denominator: 37
};
var SENIOR_DEDUCTION = {
  amountPerPerson: 6000,
  firstYear: 2025,
  lastYear: 2028,
  phaseOutStart: { mfj: 150000, single: 75000, hoh: 75000 },
  phaseOutRate: 0.06
};
var SS_THRESHOLDS = {
  mfj: { first: 32000, second: 44000 },
  single: { first: 25000, second: 34000 },
  hoh: { first: 25000, second: 34000 }
};
var FPL_GUIDELINES = {
  2024: { base: 15060, perAdditional: 5380 },
  2025: { base: 15650, perAdditional: 5500 },
  2026: { base: 15960, perAdditional: 5680 }
};
function fplFor(householdSize, guidelineYear) {
  const newest = FPL_GUIDELINES[Math.max(...Object.keys(FPL_GUIDELINES).map(Number))] ?? { base: 15960, perAdditional: 5680 };
  const g = FPL_GUIDELINES[guidelineYear] ?? newest;
  const size = Math.max(1, Math.round(householdSize));
  return g.base + g.perAdditional * (size - 1);
}
var ACA_TABLES = {
  2025: [
    { upToPctFpl: 133, initialPct: 0, finalPct: 0 },
    { upToPctFpl: 150, initialPct: 0, finalPct: 0 },
    { upToPctFpl: 200, initialPct: 0, finalPct: 2 },
    { upToPctFpl: 250, initialPct: 2, finalPct: 4 },
    { upToPctFpl: 300, initialPct: 4, finalPct: 6 },
    { upToPctFpl: 400, initialPct: 6, finalPct: 8.5 }
  ],
  2026: [
    { upToPctFpl: 133, initialPct: 2.1, finalPct: 2.1 },
    { upToPctFpl: 150, initialPct: 3.14, finalPct: 4.19 },
    { upToPctFpl: 200, initialPct: 4.19, finalPct: 6.6 },
    { upToPctFpl: 250, initialPct: 6.6, finalPct: 8.44 },
    { upToPctFpl: 300, initialPct: 8.44, finalPct: 9.96 },
    { upToPctFpl: 400, initialPct: 9.96, finalPct: 9.96 }
  ],
  2027: [
    { upToPctFpl: 133, initialPct: 2.15, finalPct: 2.15 },
    { upToPctFpl: 150, initialPct: 3.23, finalPct: 4.3 },
    { upToPctFpl: 200, initialPct: 4.3, finalPct: 6.78 },
    { upToPctFpl: 250, initialPct: 6.78, finalPct: 8.66 },
    { upToPctFpl: 300, initialPct: 8.66, finalPct: 10.22 },
    { upToPctFpl: 400, initialPct: 10.22, finalPct: 10.22 }
  ]
};
function acaTableFor(coverageYear, opts) {
  if (opts?.projected) {
    if (coverageYear === 2027)
      return ACA_TABLES[2027] ?? [];
    const own = coverageYear <= 2026 ? ACA_TABLES[coverageYear] : undefined;
    return own ?? ACA_TABLES[2026] ?? [];
  }
  if (coverageYear === 2027)
    return ACA_TABLES[2027] ?? [];
  return ACA_TABLES[coverageYear] ?? ACA_TABLES[2026] ?? [];
}
function rmdAgeForBirthYear(birthYear) {
  if (birthYear >= 1960)
    return 75;
  if (birthYear >= 1951)
    return 73;
  if (birthYear >= 1949)
    return 72;
  return 70.5;
}
var UNIFORM_DIVISORS = {
  72: 27.4,
  73: 26.5,
  74: 25.5,
  75: 24.6,
  76: 23.7,
  77: 22.9,
  78: 22,
  79: 21.1,
  80: 20.2,
  81: 19.4,
  82: 18.5,
  83: 17.7,
  84: 16.8,
  85: 16,
  86: 15.2,
  87: 14.4,
  88: 13.7,
  89: 12.9,
  90: 12.2,
  91: 11.5,
  92: 10.8,
  93: 10.1,
  94: 9.5,
  95: 8.9,
  96: 8.4,
  97: 7.8,
  98: 7.3,
  99: 6.8,
  100: 6.4,
  101: 6,
  102: 5.6,
  103: 5.2,
  104: 4.9,
  105: 4.6,
  106: 4.3,
  107: 4.1,
  108: 3.9,
  109: 3.7,
  110: 3.5,
  111: 3.4,
  112: 3.3,
  113: 3.1,
  114: 3,
  115: 2.9,
  116: 2.8,
  117: 2.7,
  118: 2.5,
  119: 2.3,
  120: 2
};
function uniformDivisor(age) {
  if (age <= 72)
    return UNIFORM_DIVISORS[72] ?? 27.4;
  if (age >= 120)
    return UNIFORM_DIVISORS[120] ?? 2;
  return UNIFORM_DIVISORS[age] ?? UNIFORM_DIVISORS[119] ?? 2.3;
}
var JOINT_LIFE_TABLE = {
  70: [
    65.2,
    64.2,
    63.2,
    62.2,
    61.3,
    60.3,
    59.4,
    58.4,
    57.4,
    56.5,
    55.5,
    54.6,
    53.6,
    52.7,
    51.7,
    50.8,
    49.9,
    48.9,
    48,
    47,
    46.1,
    45.2,
    44.3,
    43.3,
    42.4,
    41.5,
    40.6,
    39.7,
    38.8,
    38,
    37.1,
    36.2,
    35.4,
    34.6,
    33.8,
    33,
    32.2,
    31.4,
    30.7,
    29.9,
    29.2,
    28.5,
    27.9,
    27.2,
    26.6,
    26,
    25.4,
    24.9,
    24.3,
    23.9,
    23.4,
    22.9,
    22.5,
    22.2,
    21.8,
    21.5,
    21.2,
    20.9,
    20.6,
    20.4,
    20.2,
    20,
    19.9,
    19.7,
    19.6,
    19.5,
    19.4,
    19.3,
    19.2,
    19.2,
    19.1,
    19.1,
    19,
    19,
    19,
    18.9,
    18.9,
    18.9,
    18.9,
    18.9,
    18.9,
    18.9,
    18.8,
    18.8,
    18.8,
    18.8,
    18.8,
    18.8,
    18.8,
    18.8,
    18.8,
    18.8,
    18.8,
    18.8,
    18.8,
    18.8,
    18.8,
    18.8,
    18.8,
    18.8,
    18.8
  ],
  71: [
    65.1,
    64.2,
    63.2,
    62.2,
    61.3,
    60.3,
    59.3,
    58.4,
    57.4,
    56.5,
    55.5,
    54.6,
    53.6,
    52.7,
    51.7,
    50.8,
    49.8,
    48.9,
    47.9,
    47,
    46.1,
    45.1,
    44.2,
    43.3,
    42.4,
    41.5,
    40.6,
    39.7,
    38.8,
    37.9,
    37,
    36.1,
    35.3,
    34.5,
    33.6,
    32.8,
    32,
    31.2,
    30.5,
    29.7,
    29,
    28.3,
    27.6,
    26.9,
    26.3,
    25.7,
    25.1,
    24.5,
    24,
    23.4,
    22.9,
    22.5,
    22,
    21.6,
    21.3,
    20.9,
    20.6,
    20.3,
    20,
    19.8,
    19.6,
    19.4,
    19.2,
    19,
    18.9,
    18.8,
    18.7,
    18.6,
    18.5,
    18.4,
    18.4,
    18.3,
    18.3,
    18.2,
    18.2,
    18.2,
    18.1,
    18.1,
    18.1,
    18.1,
    18.1,
    18.1,
    18,
    18,
    18,
    18,
    18,
    18,
    18,
    18,
    18,
    18,
    18,
    18,
    18,
    18,
    18,
    18,
    18,
    18,
    18
  ],
  72: [
    65.1,
    64.2,
    63.2,
    62.2,
    61.3,
    60.3,
    59.3,
    58.4,
    57.4,
    56.5,
    55.5,
    54.5,
    53.6,
    52.6,
    51.7,
    50.8,
    49.8,
    48.9,
    47.9,
    47,
    46,
    45.1,
    44.2,
    43.2,
    42.3,
    41.4,
    40.5,
    39.6,
    38.7,
    37.8,
    36.9,
    36,
    35.2,
    34.3,
    33.5,
    32.7,
    31.9,
    31.1,
    30.3,
    29.5,
    28.8,
    28.1,
    27.4,
    26.7,
    26,
    25.4,
    24.8,
    24.2,
    23.6,
    23.1,
    22.5,
    22,
    21.6,
    21.1,
    20.7,
    20.4,
    20,
    19.7,
    19.4,
    19.2,
    18.9,
    18.7,
    18.5,
    18.3,
    18.2,
    18.1,
    17.9,
    17.8,
    17.7,
    17.7,
    17.6,
    17.5,
    17.5,
    17.4,
    17.4,
    17.4,
    17.4,
    17.3,
    17.3,
    17.3,
    17.3,
    17.3,
    17.3,
    17.3,
    17.2,
    17.2,
    17.2,
    17.2,
    17.2,
    17.2,
    17.2,
    17.2,
    17.2,
    17.2,
    17.2,
    17.2,
    17.2,
    17.2,
    17.2,
    17.2,
    17.2
  ],
  73: [
    65.1,
    64.2,
    63.2,
    62.2,
    61.2,
    60.3,
    59.3,
    58.4,
    57.4,
    56.4,
    55.5,
    54.5,
    53.6,
    52.6,
    51.7,
    50.7,
    49.8,
    48.8,
    47.9,
    46.9,
    46,
    45.1,
    44.1,
    43.2,
    42.3,
    41.4,
    40.4,
    39.5,
    38.6,
    37.7,
    36.8,
    36,
    35.1,
    34.2,
    33.4,
    32.6,
    31.7,
    30.9,
    30.1,
    29.4,
    28.6,
    27.9,
    27.2,
    26.5,
    25.8,
    25.1,
    24.5,
    23.9,
    23.3,
    22.7,
    22.2,
    21.6,
    21.1,
    20.7,
    20.3,
    19.9,
    19.5,
    19.1,
    18.8,
    18.6,
    18.3,
    18.1,
    17.9,
    17.7,
    17.5,
    17.4,
    17.2,
    17.1,
    17,
    16.9,
    16.9,
    16.8,
    16.7,
    16.7,
    16.6,
    16.6,
    16.6,
    16.6,
    16.5,
    16.5,
    16.5,
    16.5,
    16.5,
    16.5,
    16.5,
    16.5,
    16.5,
    16.5,
    16.5,
    16.4,
    16.4,
    16.4,
    16.4,
    16.4,
    16.4,
    16.4,
    16.4,
    16.4,
    16.4,
    16.4,
    16.4
  ],
  74: [
    65.1,
    64.1,
    63.2,
    62.2,
    61.2,
    60.3,
    59.3,
    58.3,
    57.4,
    56.4,
    55.5,
    54.5,
    53.6,
    52.6,
    51.7,
    50.7,
    49.8,
    48.8,
    47.9,
    46.9,
    46,
    45,
    44.1,
    43.2,
    42.2,
    41.3,
    40.4,
    39.5,
    38.6,
    37.7,
    36.8,
    35.9,
    35,
    34.1,
    33.3,
    32.4,
    31.6,
    30.8,
    30,
    29.2,
    28.4,
    27.7,
    27,
    26.2,
    25.5,
    24.9,
    24.2,
    23.6,
    23,
    22.4,
    21.8,
    21.3,
    20.7,
    20.3,
    19.8,
    19.4,
    19,
    18.6,
    18.3,
    18,
    17.7,
    17.4,
    17.2,
    17,
    16.8,
    16.7,
    16.5,
    16.4,
    16.3,
    16.2,
    16.1,
    16.1,
    16,
    15.9,
    15.9,
    15.9,
    15.8,
    15.8,
    15.8,
    15.7,
    15.7,
    15.7,
    15.7,
    15.7,
    15.7,
    15.7,
    15.7,
    15.7,
    15.7,
    15.7,
    15.7,
    15.7,
    15.7,
    15.7,
    15.7,
    15.7,
    15.6,
    15.6,
    15.6,
    15.6,
    15.6
  ],
  75: [
    65.1,
    64.1,
    63.2,
    62.2,
    61.2,
    60.3,
    59.3,
    58.3,
    57.4,
    56.4,
    55.5,
    54.5,
    53.5,
    52.6,
    51.6,
    50.7,
    49.7,
    48.8,
    47.8,
    46.9,
    45.9,
    45,
    44.1,
    43.1,
    42.2,
    41.3,
    40.3,
    39.4,
    38.5,
    37.6,
    36.7,
    35.8,
    34.9,
    34.1,
    33.2,
    32.4,
    31.5,
    30.7,
    29.9,
    29.1,
    28.3,
    27.5,
    26.8,
    26.1,
    25.3,
    24.6,
    24,
    23.3,
    22.7,
    22.1,
    21.5,
    20.9,
    20.4,
    19.9,
    19.4,
    18.9,
    18.5,
    18.1,
    17.8,
    17.4,
    17.1,
    16.9,
    16.6,
    16.4,
    16.2,
    16,
    15.9,
    15.7,
    15.6,
    15.5,
    15.4,
    15.3,
    15.3,
    15.2,
    15.2,
    15.1,
    15.1,
    15,
    15,
    15,
    15,
    15,
    14.9,
    14.9,
    14.9,
    14.9,
    14.9,
    14.9,
    14.9,
    14.9,
    14.9,
    14.9,
    14.9,
    14.9,
    14.9,
    14.9,
    14.9,
    14.9,
    14.9,
    14.8,
    14.8
  ],
  76: [
    65.1,
    64.1,
    63.2,
    62.2,
    61.2,
    60.2,
    59.3,
    58.3,
    57.4,
    56.4,
    55.4,
    54.5,
    53.5,
    52.6,
    51.6,
    50.7,
    49.7,
    48.8,
    47.8,
    46.9,
    45.9,
    45,
    44,
    43.1,
    42.2,
    41.2,
    40.3,
    39.4,
    38.5,
    37.5,
    36.6,
    35.7,
    34.9,
    34,
    33.1,
    32.3,
    31.4,
    30.6,
    29.8,
    29,
    28.2,
    27.4,
    26.6,
    25.9,
    25.2,
    24.4,
    23.7,
    23.1,
    22.4,
    21.8,
    21.2,
    20.6,
    20,
    19.5,
    19,
    18.5,
    18.1,
    17.7,
    17.3,
    16.9,
    16.6,
    16.3,
    16,
    15.8,
    15.6,
    15.4,
    15.2,
    15.1,
    14.9,
    14.8,
    14.8,
    14.6,
    14.6,
    14.5,
    14.4,
    14.4,
    14.3,
    14.3,
    14.3,
    14.3,
    14.2,
    14.2,
    14.2,
    14.2,
    14.2,
    14.2,
    14.2,
    14.2,
    14.2,
    14.2,
    14.2,
    14.2,
    14.2,
    14.2,
    14.1,
    14.1,
    14.1,
    14.1,
    14.1,
    14.1,
    14.1
  ],
  77: [
    65.1,
    64.1,
    63.1,
    62.2,
    61.2,
    60.2,
    59.3,
    58.3,
    57.3,
    56.4,
    55.4,
    54.5,
    53.5,
    52.6,
    51.6,
    50.7,
    49.7,
    48.8,
    47.8,
    46.9,
    45.9,
    45,
    44,
    43.1,
    42.1,
    41.2,
    40.3,
    39.3,
    38.4,
    37.5,
    36.6,
    35.7,
    34.8,
    33.9,
    33,
    32.2,
    31.3,
    30.5,
    29.7,
    28.8,
    28,
    27.3,
    26.5,
    25.7,
    25,
    24.3,
    23.5,
    22.9,
    22.2,
    21.5,
    20.9,
    20.3,
    19.7,
    19.1,
    18.6,
    18.1,
    17.7,
    17.2,
    16.8,
    16.4,
    16.1,
    15.8,
    15.5,
    15.2,
    15,
    14.8,
    14.6,
    14.4,
    14.3,
    14.2,
    14.1,
    14,
    13.9,
    13.8,
    13.7,
    13.7,
    13.6,
    13.6,
    13.6,
    13.5,
    13.5,
    13.5,
    13.5,
    13.5,
    13.5,
    13.4,
    13.4,
    13.4,
    13.4,
    13.4,
    13.4,
    13.4,
    13.4,
    13.4,
    13.4,
    13.4,
    13.4,
    13.4,
    13.4,
    13.4,
    13.3
  ],
  78: [
    65.1,
    64.1,
    63.1,
    62.2,
    61.2,
    60.2,
    59.3,
    58.3,
    57.3,
    56.4,
    55.4,
    54.5,
    53.5,
    52.6,
    51.6,
    50.6,
    49.7,
    48.7,
    47.8,
    46.8,
    45.9,
    44.9,
    44,
    43,
    42.1,
    41.2,
    40.2,
    39.3,
    38.4,
    37.5,
    36.5,
    35.6,
    34.7,
    33.9,
    33,
    32.1,
    31.2,
    30.4,
    29.6,
    28.7,
    27.9,
    27.1,
    26.4,
    25.6,
    24.8,
    24.1,
    23.4,
    22.7,
    22,
    21.3,
    20.6,
    20,
    19.4,
    18.8,
    18.3,
    17.8,
    17.3,
    16.8,
    16.4,
    16,
    15.6,
    15.3,
    15,
    14.7,
    14.4,
    14.2,
    14,
    13.8,
    13.7,
    13.5,
    13.4,
    13.3,
    13.2,
    13.1,
    13.1,
    13,
    12.9,
    12.9,
    12.9,
    12.8,
    12.8,
    12.8,
    12.8,
    12.8,
    12.7,
    12.7,
    12.7,
    12.7,
    12.7,
    12.7,
    12.7,
    12.7,
    12.7,
    12.7,
    12.7,
    12.7,
    12.7,
    12.7,
    12.6,
    12.6,
    12.6
  ],
  79: [
    65.1,
    64.1,
    63.1,
    62.2,
    61.2,
    60.2,
    59.3,
    58.3,
    57.3,
    56.4,
    55.4,
    54.5,
    53.5,
    52.5,
    51.6,
    50.6,
    49.7,
    48.7,
    47.8,
    46.8,
    45.9,
    44.9,
    44,
    43,
    42.1,
    41.1,
    40.2,
    39.3,
    38.3,
    37.4,
    36.5,
    35.6,
    34.7,
    33.8,
    32.9,
    32,
    31.2,
    30.3,
    29.5,
    28.7,
    27.8,
    27,
    26.2,
    25.5,
    24.7,
    23.9,
    23.2,
    22.5,
    21.8,
    21.1,
    20.4,
    19.8,
    19.2,
    18.6,
    18,
    17.4,
    16.9,
    16.4,
    16,
    15.6,
    15.2,
    14.8,
    14.5,
    14.2,
    13.9,
    13.6,
    13.4,
    13.2,
    13.1,
    12.9,
    12.8,
    12.7,
    12.6,
    12.5,
    12.4,
    12.3,
    12.3,
    12.2,
    12.2,
    12.2,
    12.1,
    12.1,
    12.1,
    12.1,
    12,
    12,
    12,
    12,
    12,
    12,
    12,
    12,
    12,
    12,
    12,
    12,
    12,
    12,
    11.9,
    11.9,
    11.9
  ],
  80: [
    65.1,
    64.1,
    63.1,
    62.1,
    61.2,
    60.2,
    59.2,
    58.3,
    57.3,
    56.4,
    55.4,
    54.4,
    53.5,
    52.5,
    51.6,
    50.6,
    49.7,
    48.7,
    47.8,
    46.8,
    45.9,
    44.9,
    43.9,
    43,
    42.1,
    41.1,
    40.2,
    39.2,
    38.3,
    37.4,
    36.5,
    35.5,
    34.6,
    33.7,
    32.9,
    32,
    31.1,
    30.3,
    29.4,
    28.6,
    27.8,
    26.9,
    26.1,
    25.3,
    24.6,
    23.8,
    23.1,
    22.3,
    21.6,
    20.9,
    20.2,
    19.6,
    18.9,
    18.3,
    17.7,
    17.1,
    16.6,
    16.1,
    15.6,
    15.2,
    14.7,
    14.4,
    14,
    13.7,
    13.4,
    13.1,
    12.9,
    12.7,
    12.5,
    12.3,
    12.2,
    12.1,
    11.9,
    11.9,
    11.8,
    11.7,
    11.6,
    11.6,
    11.5,
    11.5,
    11.5,
    11.4,
    11.4,
    11.4,
    11.4,
    11.4,
    11.4,
    11.4,
    11.4,
    11.3,
    11.3,
    11.3,
    11.3,
    11.3,
    11.3,
    11.3,
    11.3,
    11.3,
    11.3,
    11.2,
    11.2
  ],
  81: [
    65.1,
    64.1,
    63.1,
    62.1,
    61.2,
    60.2,
    59.2,
    58.3,
    57.3,
    56.4,
    55.4,
    54.4,
    53.5,
    52.5,
    51.6,
    50.6,
    49.7,
    48.7,
    47.7,
    46.8,
    45.8,
    44.9,
    43.9,
    43,
    42,
    41.1,
    40.1,
    39.2,
    38.3,
    37.3,
    36.4,
    35.5,
    34.6,
    33.7,
    32.8,
    31.9,
    31.1,
    30.2,
    29.3,
    28.5,
    27.7,
    26.9,
    26,
    25.2,
    24.5,
    23.7,
    22.9,
    22.2,
    21.5,
    20.7,
    20,
    19.4,
    18.7,
    18.1,
    17.4,
    16.9,
    16.3,
    15.8,
    15.3,
    14.8,
    14.4,
    14,
    13.6,
    13.2,
    12.9,
    12.6,
    12.4,
    12.2,
    12,
    11.8,
    11.6,
    11.5,
    11.4,
    11.3,
    11.2,
    11.1,
    11,
    11,
    10.9,
    10.9,
    10.8,
    10.8,
    10.8,
    10.7,
    10.7,
    10.7,
    10.7,
    10.7,
    10.7,
    10.7,
    10.7,
    10.7,
    10.7,
    10.7,
    10.7,
    10.7,
    10.6,
    10.6,
    10.6,
    10.6,
    10.5
  ],
  82: [
    65.1,
    64.1,
    63.1,
    62.1,
    61.2,
    60.2,
    59.2,
    58.3,
    57.3,
    56.3,
    55.4,
    54.4,
    53.5,
    52.5,
    51.6,
    50.6,
    49.7,
    48.7,
    47.7,
    46.8,
    45.8,
    44.9,
    43.9,
    43,
    42,
    41.1,
    40.1,
    39.2,
    38.3,
    37.3,
    36.4,
    35.5,
    34.6,
    33.7,
    32.8,
    31.9,
    31,
    30.1,
    29.3,
    28.4,
    27.6,
    26.8,
    26,
    25.2,
    24.4,
    23.6,
    22.8,
    22.1,
    21.3,
    20.6,
    19.9,
    19.2,
    18.5,
    17.9,
    17.2,
    16.6,
    16,
    15.5,
    15,
    14.5,
    14,
    13.6,
    13.2,
    12.8,
    12.5,
    12.2,
    11.9,
    11.7,
    11.5,
    11.3,
    11.1,
    10.9,
    10.8,
    10.7,
    10.6,
    10.5,
    10.4,
    10.4,
    10.3,
    10.2,
    10.2,
    10.2,
    10.1,
    10.1,
    10.1,
    10.1,
    10.1,
    10.1,
    10.1,
    10.1,
    10.1,
    10.1,
    10.1,
    10,
    10,
    10,
    10,
    10,
    10,
    9.9,
    9.9
  ],
  83: [
    65.1,
    64.1,
    63.1,
    62.1,
    61.2,
    60.2,
    59.2,
    58.3,
    57.3,
    56.3,
    55.4,
    54.4,
    53.5,
    52.5,
    51.6,
    50.6,
    49.6,
    48.7,
    47.7,
    46.8,
    45.8,
    44.9,
    43.9,
    43,
    42,
    41.1,
    40.1,
    39.2,
    38.2,
    37.3,
    36.4,
    35.4,
    34.5,
    33.6,
    32.7,
    31.8,
    31,
    30.1,
    29.2,
    28.4,
    27.5,
    26.7,
    25.9,
    25.1,
    24.3,
    23.5,
    22.7,
    22,
    21.2,
    20.5,
    19.7,
    19,
    18.3,
    17.7,
    17,
    16.4,
    15.8,
    15.2,
    14.7,
    14.2,
    13.7,
    13.2,
    12.8,
    12.4,
    12.1,
    11.8,
    11.5,
    11.2,
    11,
    10.8,
    10.6,
    10.4,
    10.3,
    10.1,
    10,
    9.9,
    9.9,
    9.8,
    9.7,
    9.7,
    9.6,
    9.6,
    9.6,
    9.5,
    9.5,
    9.5,
    9.5,
    9.5,
    9.5,
    9.5,
    9.5,
    9.5,
    9.5,
    9.4,
    9.4,
    9.4,
    9.4,
    9.4,
    9.3,
    9.3,
    9.3
  ],
  84: [
    65.1,
    64.1,
    63.1,
    62.1,
    61.2,
    60.2,
    59.2,
    58.3,
    57.3,
    56.3,
    55.4,
    54.4,
    53.5,
    52.5,
    51.5,
    50.6,
    49.6,
    48.7,
    47.7,
    46.8,
    45.8,
    44.9,
    43.9,
    42.9,
    42,
    41,
    40.1,
    39.2,
    38.2,
    37.3,
    36.3,
    35.4,
    34.5,
    33.6,
    32.7,
    31.8,
    30.9,
    30,
    29.2,
    28.3,
    27.5,
    26.7,
    25.8,
    25,
    24.2,
    23.4,
    22.6,
    21.9,
    21.1,
    20.4,
    19.6,
    18.9,
    18.2,
    17.5,
    16.8,
    16.2,
    15.6,
    15,
    14.4,
    13.9,
    13.4,
    12.9,
    12.5,
    12.1,
    11.7,
    11.4,
    11.1,
    10.8,
    10.5,
    10.3,
    10.1,
    9.9,
    9.8,
    9.6,
    9.5,
    9.4,
    9.3,
    9.2,
    9.2,
    9.1,
    9.1,
    9,
    9,
    9,
    8.9,
    8.9,
    8.9,
    8.9,
    8.9,
    8.9,
    8.9,
    8.9,
    8.9,
    8.9,
    8.9,
    8.8,
    8.8,
    8.8,
    8.8,
    8.7,
    8.7
  ],
  85: [
    65.1,
    64.1,
    63.1,
    62.1,
    61.2,
    60.2,
    59.2,
    58.3,
    57.3,
    56.3,
    55.4,
    54.4,
    53.5,
    52.5,
    51.5,
    50.6,
    49.6,
    48.7,
    47.7,
    46.8,
    45.8,
    44.8,
    43.9,
    42.9,
    42,
    41,
    40.1,
    39.1,
    38.2,
    37.3,
    36.3,
    35.4,
    34.5,
    33.6,
    32.7,
    31.8,
    30.9,
    30,
    29.1,
    28.3,
    27.4,
    26.6,
    25.8,
    25,
    24.1,
    23.3,
    22.6,
    21.8,
    21,
    20.3,
    19.5,
    18.8,
    18.1,
    17.4,
    16.7,
    16,
    15.4,
    14.8,
    14.2,
    13.6,
    13.1,
    12.6,
    12.2,
    11.8,
    11.4,
    11,
    10.7,
    10.4,
    10.1,
    9.9,
    9.7,
    9.5,
    9.3,
    9.2,
    9,
    8.9,
    8.8,
    8.7,
    8.7,
    8.6,
    8.5,
    8.5,
    8.5,
    8.4,
    8.4,
    8.4,
    8.4,
    8.4,
    8.4,
    8.4,
    8.3,
    8.3,
    8.3,
    8.3,
    8.3,
    8.3,
    8.3,
    8.2,
    8.2,
    8.2,
    8.1
  ],
  86: [
    65.1,
    64.1,
    63.1,
    62.1,
    61.1,
    60.2,
    59.2,
    58.2,
    57.3,
    56.3,
    55.4,
    54.4,
    53.5,
    52.5,
    51.5,
    50.6,
    49.6,
    48.7,
    47.7,
    46.7,
    45.8,
    44.8,
    43.9,
    42.9,
    42,
    41,
    40.1,
    39.1,
    38.2,
    37.2,
    36.3,
    35.4,
    34.5,
    33.5,
    32.6,
    31.7,
    30.9,
    30,
    29.1,
    28.2,
    27.4,
    26.6,
    25.7,
    24.9,
    24.1,
    23.3,
    22.5,
    21.7,
    20.9,
    20.2,
    19.4,
    18.7,
    17.9,
    17.2,
    16.5,
    15.9,
    15.2,
    14.6,
    14,
    13.4,
    12.9,
    12.4,
    11.9,
    11.5,
    11.1,
    10.7,
    10.4,
    10,
    9.8,
    9.5,
    9.3,
    9.1,
    8.9,
    8.7,
    8.6,
    8.5,
    8.4,
    8.3,
    8.2,
    8.1,
    8,
    8,
    8,
    7.9,
    7.9,
    7.9,
    7.9,
    7.9,
    7.8,
    7.8,
    7.8,
    7.8,
    7.8,
    7.8,
    7.8,
    7.8,
    7.7,
    7.7,
    7.7,
    7.6,
    7.6
  ],
  87: [
    65,
    64.1,
    63.1,
    62.1,
    61.1,
    60.2,
    59.2,
    58.2,
    57.3,
    56.3,
    55.4,
    54.4,
    53.4,
    52.5,
    51.5,
    50.6,
    49.6,
    48.7,
    47.7,
    46.7,
    45.8,
    44.8,
    43.9,
    42.9,
    42,
    41,
    40.1,
    39.1,
    38.2,
    37.2,
    36.3,
    35.4,
    34.4,
    33.5,
    32.6,
    31.7,
    30.8,
    29.9,
    29.1,
    28.2,
    27.4,
    26.5,
    25.7,
    24.9,
    24,
    23.2,
    22.4,
    21.6,
    20.9,
    20.1,
    19.3,
    18.6,
    17.8,
    17.1,
    16.4,
    15.7,
    15.1,
    14.4,
    13.8,
    13.2,
    12.7,
    12.2,
    11.7,
    11.2,
    10.8,
    10.4,
    10,
    9.7,
    9.4,
    9.1,
    8.9,
    8.7,
    8.5,
    8.3,
    8.2,
    8,
    7.9,
    7.8,
    7.7,
    7.6,
    7.6,
    7.5,
    7.5,
    7.4,
    7.4,
    7.4,
    7.4,
    7.4,
    7.4,
    7.4,
    7.4,
    7.3,
    7.3,
    7.3,
    7.3,
    7.3,
    7.3,
    7.2,
    7.2,
    7.1,
    7.1
  ],
  88: [
    65,
    64.1,
    63.1,
    62.1,
    61.1,
    60.2,
    59.2,
    58.2,
    57.3,
    56.3,
    55.4,
    54.4,
    53.4,
    52.5,
    51.5,
    50.6,
    49.6,
    48.7,
    47.7,
    46.7,
    45.8,
    44.8,
    43.9,
    42.9,
    42,
    41,
    40,
    39.1,
    38.2,
    37.2,
    36.3,
    35.3,
    34.4,
    33.5,
    32.6,
    31.7,
    30.8,
    29.9,
    29,
    28.2,
    27.3,
    26.5,
    25.6,
    24.8,
    24,
    23.2,
    22.4,
    21.6,
    20.8,
    20,
    19.2,
    18.5,
    17.7,
    17,
    16.3,
    15.6,
    14.9,
    14.3,
    13.7,
    13.1,
    12.5,
    12,
    11.5,
    11,
    10.5,
    10.1,
    9.8,
    9.4,
    9.1,
    8.8,
    8.6,
    8.3,
    8.1,
    7.9,
    7.8,
    7.6,
    7.5,
    7.4,
    7.3,
    7.2,
    7.2,
    7.1,
    7,
    7,
    7,
    6.9,
    6.9,
    6.9,
    6.9,
    6.9,
    6.9,
    6.9,
    6.9,
    6.9,
    6.9,
    6.8,
    6.8,
    6.8,
    6.7,
    6.6,
    6.6
  ],
  89: [
    65,
    64.1,
    63.1,
    62.1,
    61.1,
    60.2,
    59.2,
    58.2,
    57.3,
    56.3,
    55.4,
    54.4,
    53.4,
    52.5,
    51.5,
    50.6,
    49.6,
    48.7,
    47.7,
    46.7,
    45.8,
    44.8,
    43.9,
    42.9,
    41.9,
    41,
    40,
    39.1,
    38.1,
    37.2,
    36.3,
    35.3,
    34.4,
    33.5,
    32.6,
    31.7,
    30.8,
    29.9,
    29,
    28.2,
    27.3,
    26.4,
    25.6,
    24.8,
    24,
    23.1,
    22.3,
    21.5,
    20.7,
    20,
    19.2,
    18.4,
    17.7,
    16.9,
    16.2,
    15.5,
    14.8,
    14.2,
    13.5,
    12.9,
    12.3,
    11.8,
    11.3,
    10.8,
    10.3,
    9.9,
    9.5,
    9.1,
    8.8,
    8.5,
    8.3,
    8,
    7.8,
    7.6,
    7.4,
    7.3,
    7.1,
    7,
    6.9,
    6.8,
    6.8,
    6.7,
    6.6,
    6.6,
    6.6,
    6.5,
    6.5,
    6.5,
    6.5,
    6.5,
    6.5,
    6.5,
    6.5,
    6.4,
    6.4,
    6.4,
    6.4,
    6.3,
    6.3,
    6.2,
    6.1
  ],
  90: [
    65,
    64.1,
    63.1,
    62.1,
    61.1,
    60.2,
    59.2,
    58.2,
    57.3,
    56.3,
    55.4,
    54.4,
    53.4,
    52.5,
    51.5,
    50.6,
    49.6,
    48.6,
    47.7,
    46.7,
    45.8,
    44.8,
    43.9,
    42.9,
    41.9,
    41,
    40,
    39.1,
    38.1,
    37.2,
    36.3,
    35.3,
    34.4,
    33.5,
    32.6,
    31.7,
    30.8,
    29.9,
    29,
    28.1,
    27.3,
    26.4,
    25.6,
    24.7,
    23.9,
    23.1,
    22.3,
    21.5,
    20.7,
    19.9,
    19.1,
    18.4,
    17.6,
    16.9,
    16.1,
    15.4,
    14.8,
    14.1,
    13.4,
    12.8,
    12.2,
    11.6,
    11.1,
    10.6,
    10.1,
    9.7,
    9.3,
    8.9,
    8.6,
    8.3,
    8,
    7.7,
    7.5,
    7.3,
    7.1,
    6.9,
    6.8,
    6.7,
    6.6,
    6.5,
    6.4,
    6.3,
    6.3,
    6.2,
    6.2,
    6.1,
    6.1,
    6.1,
    6.1,
    6.1,
    6.1,
    6.1,
    6.1,
    6.1,
    6,
    6,
    6,
    5.9,
    5.8,
    5.8,
    5.7
  ],
  91: [
    65,
    64.1,
    63.1,
    62.1,
    61.1,
    60.2,
    59.2,
    58.2,
    57.3,
    56.3,
    55.3,
    54.4,
    53.4,
    52.5,
    51.5,
    50.6,
    49.6,
    48.6,
    47.7,
    46.7,
    45.8,
    44.8,
    43.9,
    42.9,
    41.9,
    41,
    40,
    39.1,
    38.1,
    37.2,
    36.2,
    35.3,
    34.4,
    33.5,
    32.5,
    31.6,
    30.7,
    29.9,
    29,
    28.1,
    27.3,
    26.4,
    25.6,
    24.7,
    23.9,
    23.1,
    22.3,
    21.5,
    20.7,
    19.9,
    19.1,
    18.3,
    17.5,
    16.8,
    16.1,
    15.3,
    14.6,
    14,
    13.3,
    12.7,
    12.1,
    11.5,
    10.9,
    10.4,
    9.9,
    9.5,
    9.1,
    8.7,
    8.3,
    8,
    7.7,
    7.5,
    7.2,
    7,
    6.8,
    6.6,
    6.5,
    6.4,
    6.2,
    6.1,
    6,
    6,
    5.9,
    5.9,
    5.8,
    5.8,
    5.8,
    5.8,
    5.7,
    5.7,
    5.7,
    5.7,
    5.7,
    5.7,
    5.7,
    5.6,
    5.6,
    5.5,
    5.5,
    5.4,
    5.3
  ],
  92: [
    65,
    64.1,
    63.1,
    62.1,
    61.1,
    60.2,
    59.2,
    58.2,
    57.3,
    56.3,
    55.3,
    54.4,
    53.4,
    52.5,
    51.5,
    50.6,
    49.6,
    48.6,
    47.7,
    46.7,
    45.8,
    44.8,
    43.8,
    42.9,
    41.9,
    41,
    40,
    39.1,
    38.1,
    37.2,
    36.2,
    35.3,
    34.4,
    33.5,
    32.5,
    31.6,
    30.7,
    29.8,
    29,
    28.1,
    27.2,
    26.4,
    25.5,
    24.7,
    23.9,
    23,
    22.2,
    21.4,
    20.6,
    19.8,
    19,
    18.3,
    17.5,
    16.7,
    16,
    15.3,
    14.6,
    13.9,
    13.2,
    12.6,
    11.9,
    11.4,
    10.8,
    10.3,
    9.8,
    9.3,
    8.9,
    8.5,
    8.1,
    7.8,
    7.5,
    7.2,
    7,
    6.7,
    6.5,
    6.4,
    6.2,
    6.1,
    5.9,
    5.8,
    5.7,
    5.6,
    5.6,
    5.5,
    5.5,
    5.4,
    5.4,
    5.4,
    5.4,
    5.4,
    5.4,
    5.4,
    5.4,
    5.3,
    5.3,
    5.3,
    5.2,
    5.2,
    5.1,
    5,
    4.9
  ],
  93: [
    65,
    64.1,
    63.1,
    62.1,
    61.1,
    60.2,
    59.2,
    58.2,
    57.3,
    56.3,
    55.3,
    54.4,
    53.4,
    52.5,
    51.5,
    50.6,
    49.6,
    48.6,
    47.7,
    46.7,
    45.8,
    44.8,
    43.8,
    42.9,
    41.9,
    41,
    40,
    39.1,
    38.1,
    37.2,
    36.2,
    35.3,
    34.4,
    33.4,
    32.5,
    31.6,
    30.7,
    29.8,
    29,
    28.1,
    27.2,
    26.4,
    25.5,
    24.7,
    23.8,
    23,
    22.2,
    21.4,
    20.6,
    19.8,
    19,
    18.2,
    17.4,
    16.7,
    15.9,
    15.2,
    14.5,
    13.8,
    13.1,
    12.5,
    11.9,
    11.3,
    10.7,
    10.1,
    9.6,
    9.2,
    8.7,
    8.3,
    7.9,
    7.6,
    7.3,
    7,
    6.7,
    6.5,
    6.3,
    6.1,
    5.9,
    5.8,
    5.7,
    5.5,
    5.4,
    5.3,
    5.3,
    5.2,
    5.2,
    5.1,
    5.1,
    5.1,
    5.1,
    5.1,
    5.1,
    5.1,
    5.1,
    5,
    5,
    5,
    4.9,
    4.9,
    4.8,
    4.7,
    4.6
  ],
  94: [
    65,
    64.1,
    63.1,
    62.1,
    61.1,
    60.2,
    59.2,
    58.2,
    57.3,
    56.3,
    55.3,
    54.4,
    53.4,
    52.5,
    51.5,
    50.6,
    49.6,
    48.6,
    47.7,
    46.7,
    45.8,
    44.8,
    43.8,
    42.9,
    41.9,
    41,
    40,
    39.1,
    38.1,
    37.2,
    36.2,
    35.3,
    34.4,
    33.4,
    32.5,
    31.6,
    30.7,
    29.8,
    28.9,
    28.1,
    27.2,
    26.3,
    25.5,
    24.7,
    23.8,
    23,
    22.2,
    21.4,
    20.6,
    19.8,
    19,
    18.2,
    17.4,
    16.6,
    15.9,
    15.2,
    14.4,
    13.7,
    13.1,
    12.4,
    11.8,
    11.2,
    10.6,
    10,
    9.5,
    9,
    8.6,
    8.2,
    7.8,
    7.4,
    7.1,
    6.8,
    6.5,
    6.3,
    6.1,
    5.9,
    5.7,
    5.5,
    5.4,
    5.3,
    5.2,
    5.1,
    5,
    4.9,
    4.9,
    4.9,
    4.8,
    4.8,
    4.8,
    4.8,
    4.8,
    4.8,
    4.8,
    4.7,
    4.7,
    4.7,
    4.6,
    4.6,
    4.5,
    4.4,
    4.3
  ],
  95: [
    65,
    64.1,
    63.1,
    62.1,
    61.1,
    60.2,
    59.2,
    58.2,
    57.3,
    56.3,
    55.3,
    54.4,
    53.4,
    52.5,
    51.5,
    50.6,
    49.6,
    48.6,
    47.7,
    46.7,
    45.8,
    44.8,
    43.8,
    42.9,
    41.9,
    41,
    40,
    39.1,
    38.1,
    37.2,
    36.2,
    35.3,
    34.4,
    33.4,
    32.5,
    31.6,
    30.7,
    29.8,
    28.9,
    28.1,
    27.2,
    26.3,
    25.5,
    24.6,
    23.8,
    23,
    22.2,
    21.4,
    20.6,
    19.7,
    18.9,
    18.2,
    17.4,
    16.6,
    15.9,
    15.1,
    14.4,
    13.7,
    13,
    12.3,
    11.7,
    11.1,
    10.5,
    9.9,
    9.4,
    8.9,
    8.5,
    8,
    7.6,
    7.3,
    6.9,
    6.6,
    6.4,
    6.1,
    5.9,
    5.7,
    5.5,
    5.3,
    5.2,
    5,
    4.9,
    4.8,
    4.7,
    4.7,
    4.6,
    4.6,
    4.6,
    4.6,
    4.5,
    4.5,
    4.5,
    4.5,
    4.5,
    4.5,
    4.4,
    4.4,
    4.4,
    4.3,
    4.2,
    4.1,
    4
  ],
  96: [
    65,
    64.1,
    63.1,
    62.1,
    61.1,
    60.2,
    59.2,
    58.2,
    57.3,
    56.3,
    55.3,
    54.4,
    53.4,
    52.5,
    51.5,
    50.6,
    49.6,
    48.6,
    47.7,
    46.7,
    45.8,
    44.8,
    43.8,
    42.9,
    41.9,
    41,
    40,
    39.1,
    38.1,
    37.2,
    36.2,
    35.3,
    34.3,
    33.4,
    32.5,
    31.6,
    30.7,
    29.8,
    28.9,
    28,
    27.2,
    26.3,
    25.5,
    24.6,
    23.8,
    23,
    22.2,
    21.3,
    20.5,
    19.7,
    18.9,
    18.1,
    17.4,
    16.6,
    15.8,
    15.1,
    14.3,
    13.6,
    12.9,
    12.3,
    11.6,
    11,
    10.4,
    9.9,
    9.3,
    8.8,
    8.4,
    7.9,
    7.5,
    7.1,
    6.8,
    6.5,
    6.2,
    5.9,
    5.7,
    5.5,
    5.3,
    5.1,
    5,
    4.8,
    4.7,
    4.6,
    4.5,
    4.5,
    4.4,
    4.4,
    4.3,
    4.3,
    4.3,
    4.3,
    4.3,
    4.3,
    4.3,
    4.2,
    4.2,
    4.2,
    4.1,
    4,
    3.9,
    3.8,
    3.7
  ],
  97: [
    65,
    64.1,
    63.1,
    62.1,
    61.1,
    60.2,
    59.2,
    58.2,
    57.3,
    56.3,
    55.3,
    54.4,
    53.4,
    52.5,
    51.5,
    50.6,
    49.6,
    48.6,
    47.7,
    46.7,
    45.8,
    44.8,
    43.8,
    42.9,
    41.9,
    41,
    40,
    39.1,
    38.1,
    37.2,
    36.2,
    35.3,
    34.3,
    33.4,
    32.5,
    31.6,
    30.7,
    29.8,
    28.9,
    28,
    27.2,
    26.3,
    25.5,
    24.6,
    23.8,
    23,
    22.1,
    21.3,
    20.5,
    19.7,
    18.9,
    18.1,
    17.3,
    16.6,
    15.8,
    15,
    14.3,
    13.6,
    12.9,
    12.2,
    11.6,
    11,
    10.4,
    9.8,
    9.2,
    8.7,
    8.3,
    7.8,
    7.4,
    7,
    6.7,
    6.4,
    6.1,
    5.8,
    5.5,
    5.3,
    5.1,
    4.9,
    4.8,
    4.6,
    4.5,
    4.4,
    4.3,
    4.2,
    4.2,
    4.1,
    4.1,
    4.1,
    4.1,
    4.1,
    4.1,
    4.1,
    4,
    4,
    4,
    4,
    3.9,
    3.8,
    3.7,
    3.6,
    3.4
  ],
  98: [
    65,
    64.1,
    63.1,
    62.1,
    61.1,
    60.2,
    59.2,
    58.2,
    57.3,
    56.3,
    55.3,
    54.4,
    53.4,
    52.5,
    51.5,
    50.6,
    49.6,
    48.6,
    47.7,
    46.7,
    45.8,
    44.8,
    43.8,
    42.9,
    41.9,
    41,
    40,
    39.1,
    38.1,
    37.2,
    36.2,
    35.3,
    34.3,
    33.4,
    32.5,
    31.6,
    30.7,
    29.8,
    28.9,
    28,
    27.2,
    26.3,
    25.5,
    24.6,
    23.8,
    22.9,
    22.1,
    21.3,
    20.5,
    19.7,
    18.9,
    18.1,
    17.3,
    16.5,
    15.8,
    15,
    14.3,
    13.6,
    12.9,
    12.2,
    11.5,
    10.9,
    10.3,
    9.7,
    9.2,
    8.7,
    8.2,
    7.7,
    7.3,
    6.9,
    6.6,
    6.2,
    5.9,
    5.7,
    5.4,
    5.2,
    5,
    4.8,
    4.6,
    4.5,
    4.3,
    4.2,
    4.1,
    4.1,
    4,
    4,
    3.9,
    3.9,
    3.9,
    3.9,
    3.9,
    3.9,
    3.8,
    3.8,
    3.8,
    3.8,
    3.7,
    3.6,
    3.5,
    3.3,
    3.2
  ],
  99: [
    65,
    64.1,
    63.1,
    62.1,
    61.1,
    60.2,
    59.2,
    58.2,
    57.3,
    56.3,
    55.3,
    54.4,
    53.4,
    52.5,
    51.5,
    50.6,
    49.6,
    48.6,
    47.7,
    46.7,
    45.8,
    44.8,
    43.8,
    42.9,
    41.9,
    41,
    40,
    39.1,
    38.1,
    37.2,
    36.2,
    35.3,
    34.3,
    33.4,
    32.5,
    31.6,
    30.7,
    29.8,
    28.9,
    28,
    27.2,
    26.3,
    25.4,
    24.6,
    23.8,
    22.9,
    22.1,
    21.3,
    20.5,
    19.7,
    18.9,
    18.1,
    17.3,
    16.5,
    15.7,
    15,
    14.3,
    13.5,
    12.8,
    12.2,
    11.5,
    10.9,
    10.2,
    9.7,
    9.1,
    8.6,
    8.1,
    7.6,
    7.2,
    6.8,
    6.5,
    6.1,
    5.8,
    5.5,
    5.3,
    5,
    4.8,
    4.6,
    4.5,
    4.3,
    4.2,
    4.1,
    4,
    3.9,
    3.8,
    3.8,
    3.8,
    3.7,
    3.7,
    3.7,
    3.7,
    3.7,
    3.7,
    3.6,
    3.6,
    3.6,
    3.5,
    3.4,
    3.3,
    3.1,
    3
  ],
  100: [
    65,
    64.1,
    63.1,
    62.1,
    61.1,
    60.2,
    59.2,
    58.2,
    57.3,
    56.3,
    55.3,
    54.4,
    53.4,
    52.5,
    51.5,
    50.6,
    49.6,
    48.6,
    47.7,
    46.7,
    45.8,
    44.8,
    43.8,
    42.9,
    41.9,
    41,
    40,
    39,
    38.1,
    37.1,
    36.2,
    35.3,
    34.3,
    33.4,
    32.5,
    31.6,
    30.7,
    29.8,
    28.9,
    28,
    27.1,
    26.3,
    25.4,
    24.6,
    23.8,
    22.9,
    22.1,
    21.3,
    20.5,
    19.7,
    18.9,
    18.1,
    17.3,
    16.5,
    15.7,
    15,
    14.2,
    13.5,
    12.8,
    12.1,
    11.5,
    10.8,
    10.2,
    9.6,
    9.1,
    8.5,
    8,
    7.6,
    7.2,
    6.8,
    6.4,
    6,
    5.7,
    5.4,
    5.2,
    4.9,
    4.7,
    4.5,
    4.3,
    4.2,
    4.1,
    3.9,
    3.8,
    3.7,
    3.7,
    3.6,
    3.6,
    3.6,
    3.6,
    3.6,
    3.5,
    3.5,
    3.5,
    3.5,
    3.5,
    3.4,
    3.3,
    3.3,
    3.1,
    2.9,
    2.8
  ],
  101: [
    65,
    64.1,
    63.1,
    62.1,
    61.1,
    60.2,
    59.2,
    58.2,
    57.3,
    56.3,
    55.3,
    54.4,
    53.4,
    52.5,
    51.5,
    50.6,
    49.6,
    48.6,
    47.7,
    46.7,
    45.8,
    44.8,
    43.8,
    42.9,
    41.9,
    41,
    40,
    39,
    38.1,
    37.1,
    36.2,
    35.3,
    34.3,
    33.4,
    32.5,
    31.6,
    30.7,
    29.8,
    28.9,
    28,
    27.1,
    26.3,
    25.4,
    24.6,
    23.8,
    22.9,
    22.1,
    21.3,
    20.5,
    19.7,
    18.9,
    18.1,
    17.3,
    16.5,
    15.7,
    15,
    14.2,
    13.5,
    12.8,
    12.1,
    11.4,
    10.8,
    10.2,
    9.6,
    9,
    8.5,
    8,
    7.5,
    7.1,
    6.7,
    6.3,
    6,
    5.6,
    5.3,
    5.1,
    4.8,
    4.6,
    4.4,
    4.2,
    4.1,
    3.9,
    3.8,
    3.7,
    3.6,
    3.5,
    3.5,
    3.5,
    3.4,
    3.4,
    3.4,
    3.4,
    3.4,
    3.4,
    3.4,
    3.3,
    3.3,
    3.2,
    3.1,
    3,
    2.8,
    2.6
  ],
  102: [
    65,
    64.1,
    63.1,
    62.1,
    61.1,
    60.2,
    59.2,
    58.2,
    57.3,
    56.3,
    55.3,
    54.4,
    53.4,
    52.5,
    51.5,
    50.6,
    49.6,
    48.6,
    47.7,
    46.7,
    45.8,
    44.8,
    43.8,
    42.9,
    41.9,
    41,
    40,
    39,
    38.1,
    37.1,
    36.2,
    35.3,
    34.3,
    33.4,
    32.5,
    31.6,
    30.7,
    29.8,
    28.9,
    28,
    27.1,
    26.3,
    25.4,
    24.6,
    23.7,
    22.9,
    22.1,
    21.3,
    20.5,
    19.7,
    18.8,
    18,
    17.3,
    16.5,
    15.7,
    14.9,
    14.2,
    13.5,
    12.8,
    12.1,
    11.4,
    10.8,
    10.1,
    9.6,
    9,
    8.5,
    8,
    7.5,
    7,
    6.6,
    6.3,
    5.9,
    5.6,
    5.3,
    5,
    4.7,
    4.5,
    4.3,
    4.1,
    4,
    3.8,
    3.7,
    3.6,
    3.5,
    3.4,
    3.4,
    3.3,
    3.3,
    3.3,
    3.3,
    3.3,
    3.3,
    3.2,
    3.2,
    3.2,
    3.2,
    3.1,
    3,
    2.8,
    2.6,
    2.5
  ],
  103: [
    65,
    64.1,
    63.1,
    62.1,
    61.1,
    60.2,
    59.2,
    58.2,
    57.3,
    56.3,
    55.3,
    54.4,
    53.4,
    52.5,
    51.5,
    50.5,
    49.6,
    48.6,
    47.7,
    46.7,
    45.8,
    44.8,
    43.8,
    42.9,
    41.9,
    41,
    40,
    39,
    38.1,
    37.1,
    36.2,
    35.3,
    34.3,
    33.4,
    32.5,
    31.6,
    30.7,
    29.8,
    28.9,
    28,
    27.1,
    26.3,
    25.4,
    24.6,
    23.7,
    22.9,
    22.1,
    21.3,
    20.5,
    19.6,
    18.8,
    18,
    17.3,
    16.5,
    15.7,
    14.9,
    14.2,
    13.5,
    12.8,
    12.1,
    11.4,
    10.7,
    10.1,
    9.5,
    9,
    8.4,
    7.9,
    7.4,
    7,
    6.6,
    6.2,
    5.9,
    5.5,
    5.2,
    4.9,
    4.7,
    4.5,
    4.2,
    4.1,
    3.9,
    3.7,
    3.6,
    3.5,
    3.4,
    3.3,
    3.3,
    3.2,
    3.2,
    3.2,
    3.2,
    3.2,
    3.2,
    3.1,
    3.1,
    3.1,
    3.1,
    3,
    2.9,
    2.7,
    2.5,
    2.3
  ],
  104: [
    65,
    64.1,
    63.1,
    62.1,
    61.1,
    60.2,
    59.2,
    58.2,
    57.3,
    56.3,
    55.3,
    54.4,
    53.4,
    52.5,
    51.5,
    50.5,
    49.6,
    48.6,
    47.7,
    46.7,
    45.8,
    44.8,
    43.8,
    42.9,
    41.9,
    41,
    40,
    39,
    38.1,
    37.1,
    36.2,
    35.3,
    34.3,
    33.4,
    32.5,
    31.6,
    30.7,
    29.8,
    28.9,
    28,
    27.1,
    26.3,
    25.4,
    24.6,
    23.7,
    22.9,
    22.1,
    21.3,
    20.5,
    19.6,
    18.8,
    18,
    17.2,
    16.5,
    15.7,
    14.9,
    14.2,
    13.5,
    12.7,
    12,
    11.4,
    10.7,
    10.1,
    9.5,
    8.9,
    8.4,
    7.9,
    7.4,
    7,
    6.6,
    6.2,
    5.8,
    5.5,
    5.2,
    4.9,
    4.6,
    4.4,
    4.2,
    4,
    3.8,
    3.7,
    3.5,
    3.4,
    3.3,
    3.3,
    3.2,
    3.2,
    3.2,
    3.1,
    3.1,
    3.1,
    3.1,
    3.1,
    3.1,
    3,
    3,
    2.9,
    2.8,
    2.6,
    2.4,
    2.2
  ],
  105: [
    65,
    64.1,
    63.1,
    62.1,
    61.1,
    60.2,
    59.2,
    58.2,
    57.3,
    56.3,
    55.3,
    54.4,
    53.4,
    52.5,
    51.5,
    50.5,
    49.6,
    48.6,
    47.7,
    46.7,
    45.7,
    44.8,
    43.8,
    42.9,
    41.9,
    41,
    40,
    39,
    38.1,
    37.1,
    36.2,
    35.3,
    34.3,
    33.4,
    32.5,
    31.6,
    30.7,
    29.8,
    28.9,
    28,
    27.1,
    26.3,
    25.4,
    24.6,
    23.7,
    22.9,
    22.1,
    21.3,
    20.5,
    19.6,
    18.8,
    18,
    17.2,
    16.5,
    15.7,
    14.9,
    14.2,
    13.4,
    12.7,
    12,
    11.4,
    10.7,
    10.1,
    9.5,
    8.9,
    8.4,
    7.9,
    7.4,
    6.9,
    6.5,
    6.1,
    5.8,
    5.4,
    5.1,
    4.9,
    4.6,
    4.4,
    4.1,
    4,
    3.8,
    3.6,
    3.5,
    3.4,
    3.3,
    3.2,
    3.1,
    3.1,
    3.1,
    3.1,
    3.1,
    3.1,
    3,
    3,
    3,
    3,
    2.9,
    2.8,
    2.7,
    2.6,
    2.4,
    2.1
  ],
  106: [
    65,
    64.1,
    63.1,
    62.1,
    61.1,
    60.2,
    59.2,
    58.2,
    57.3,
    56.3,
    55.3,
    54.4,
    53.4,
    52.5,
    51.5,
    50.5,
    49.6,
    48.6,
    47.7,
    46.7,
    45.7,
    44.8,
    43.8,
    42.9,
    41.9,
    41,
    40,
    39,
    38.1,
    37.1,
    36.2,
    35.3,
    34.3,
    33.4,
    32.5,
    31.6,
    30.7,
    29.8,
    28.9,
    28,
    27.1,
    26.3,
    25.4,
    24.6,
    23.7,
    22.9,
    22.1,
    21.3,
    20.5,
    19.6,
    18.8,
    18,
    17.2,
    16.5,
    15.7,
    14.9,
    14.2,
    13.4,
    12.7,
    12,
    11.4,
    10.7,
    10.1,
    9.5,
    8.9,
    8.4,
    7.9,
    7.4,
    6.9,
    6.5,
    6.1,
    5.8,
    5.4,
    5.1,
    4.8,
    4.6,
    4.3,
    4.1,
    3.9,
    3.8,
    3.6,
    3.5,
    3.3,
    3.2,
    3.2,
    3.1,
    3.1,
    3.1,
    3,
    3,
    3,
    3,
    3,
    3,
    2.9,
    2.9,
    2.8,
    2.7,
    2.5,
    2.3,
    2.1
  ],
  107: [
    65,
    64.1,
    63.1,
    62.1,
    61.1,
    60.2,
    59.2,
    58.2,
    57.3,
    56.3,
    55.3,
    54.4,
    53.4,
    52.5,
    51.5,
    50.5,
    49.6,
    48.6,
    47.7,
    46.7,
    45.7,
    44.8,
    43.8,
    42.9,
    41.9,
    41,
    40,
    39,
    38.1,
    37.1,
    36.2,
    35.3,
    34.3,
    33.4,
    32.5,
    31.6,
    30.7,
    29.8,
    28.9,
    28,
    27.1,
    26.3,
    25.4,
    24.6,
    23.7,
    22.9,
    22.1,
    21.3,
    20.5,
    19.6,
    18.8,
    18,
    17.2,
    16.5,
    15.7,
    14.9,
    14.2,
    13.4,
    12.7,
    12,
    11.4,
    10.7,
    10.1,
    9.5,
    8.9,
    8.4,
    7.9,
    7.4,
    6.9,
    6.5,
    6.1,
    5.8,
    5.4,
    5.1,
    4.8,
    4.6,
    4.3,
    4.1,
    3.9,
    3.7,
    3.6,
    3.4,
    3.3,
    3.2,
    3.2,
    3.1,
    3.1,
    3,
    3,
    3,
    3,
    3,
    2.9,
    2.9,
    2.9,
    2.9,
    2.8,
    2.7,
    2.5,
    2.3,
    2.1
  ],
  108: [
    65,
    64.1,
    63.1,
    62.1,
    61.1,
    60.2,
    59.2,
    58.2,
    57.3,
    56.3,
    55.3,
    54.4,
    53.4,
    52.5,
    51.5,
    50.5,
    49.6,
    48.6,
    47.7,
    46.7,
    45.7,
    44.8,
    43.8,
    42.9,
    41.9,
    41,
    40,
    39,
    38.1,
    37.1,
    36.2,
    35.3,
    34.3,
    33.4,
    32.5,
    31.6,
    30.7,
    29.8,
    28.9,
    28,
    27.1,
    26.3,
    25.4,
    24.6,
    23.7,
    22.9,
    22.1,
    21.3,
    20.5,
    19.6,
    18.8,
    18,
    17.2,
    16.5,
    15.7,
    14.9,
    14.2,
    13.4,
    12.7,
    12,
    11.4,
    10.7,
    10.1,
    9.5,
    8.9,
    8.4,
    7.8,
    7.4,
    6.9,
    6.5,
    6.1,
    5.7,
    5.4,
    5.1,
    4.8,
    4.5,
    4.3,
    4.1,
    3.9,
    3.7,
    3.6,
    3.4,
    3.3,
    3.2,
    3.1,
    3.1,
    3,
    3,
    3,
    3,
    3,
    3,
    2.9,
    2.9,
    2.9,
    2.8,
    2.8,
    2.7,
    2.5,
    2.3,
    2
  ],
  109: [
    65,
    64.1,
    63.1,
    62.1,
    61.1,
    60.2,
    59.2,
    58.2,
    57.3,
    56.3,
    55.3,
    54.4,
    53.4,
    52.5,
    51.5,
    50.5,
    49.6,
    48.6,
    47.7,
    46.7,
    45.7,
    44.8,
    43.8,
    42.9,
    41.9,
    41,
    40,
    39,
    38.1,
    37.1,
    36.2,
    35.3,
    34.3,
    33.4,
    32.5,
    31.6,
    30.7,
    29.8,
    28.9,
    28,
    27.1,
    26.3,
    25.4,
    24.6,
    23.7,
    22.9,
    22.1,
    21.3,
    20.4,
    19.6,
    18.8,
    18,
    17.2,
    16.4,
    15.7,
    14.9,
    14.2,
    13.4,
    12.7,
    12,
    11.3,
    10.7,
    10.1,
    9.5,
    8.9,
    8.4,
    7.8,
    7.4,
    6.9,
    6.5,
    6.1,
    5.7,
    5.4,
    5.1,
    4.8,
    4.5,
    4.3,
    4.1,
    3.9,
    3.7,
    3.6,
    3.4,
    3.3,
    3.2,
    3.1,
    3.1,
    3,
    3,
    3,
    3,
    3,
    3,
    2.9,
    2.9,
    2.9,
    2.8,
    2.8,
    2.6,
    2.5,
    2.3,
    2
  ],
  110: [
    65,
    64.1,
    63.1,
    62.1,
    61.1,
    60.2,
    59.2,
    58.2,
    57.3,
    56.3,
    55.3,
    54.4,
    53.4,
    52.5,
    51.5,
    50.5,
    49.6,
    48.6,
    47.7,
    46.7,
    45.7,
    44.8,
    43.8,
    42.9,
    41.9,
    41,
    40,
    39,
    38.1,
    37.1,
    36.2,
    35.3,
    34.3,
    33.4,
    32.5,
    31.6,
    30.7,
    29.8,
    28.9,
    28,
    27.1,
    26.3,
    25.4,
    24.6,
    23.7,
    22.9,
    22.1,
    21.3,
    20.4,
    19.6,
    18.8,
    18,
    17.2,
    16.4,
    15.7,
    14.9,
    14.2,
    13.4,
    12.7,
    12,
    11.3,
    10.7,
    10.1,
    9.5,
    8.9,
    8.3,
    7.8,
    7.4,
    6.9,
    6.5,
    6.1,
    5.7,
    5.4,
    5.1,
    4.8,
    4.5,
    4.3,
    4.1,
    3.9,
    3.7,
    3.5,
    3.4,
    3.3,
    3.2,
    3.1,
    3.1,
    3,
    3,
    3,
    3,
    3,
    2.9,
    2.9,
    2.9,
    2.9,
    2.8,
    2.7,
    2.6,
    2.5,
    2.2,
    2
  ],
  111: [
    65,
    64.1,
    63.1,
    62.1,
    61.1,
    60.2,
    59.2,
    58.2,
    57.3,
    56.3,
    55.3,
    54.4,
    53.4,
    52.5,
    51.5,
    50.5,
    49.6,
    48.6,
    47.7,
    46.7,
    45.7,
    44.8,
    43.8,
    42.9,
    41.9,
    41,
    40,
    39,
    38.1,
    37.1,
    36.2,
    35.3,
    34.3,
    33.4,
    32.5,
    31.6,
    30.7,
    29.8,
    28.9,
    28,
    27.1,
    26.3,
    25.4,
    24.6,
    23.7,
    22.9,
    22.1,
    21.3,
    20.4,
    19.6,
    18.8,
    18,
    17.2,
    16.4,
    15.7,
    14.9,
    14.2,
    13.4,
    12.7,
    12,
    11.3,
    10.7,
    10.1,
    9.5,
    8.9,
    8.3,
    7.8,
    7.3,
    6.9,
    6.5,
    6.1,
    5.7,
    5.4,
    5.1,
    4.8,
    4.5,
    4.3,
    4.1,
    3.9,
    3.7,
    3.5,
    3.4,
    3.3,
    3.2,
    3.1,
    3,
    3,
    3,
    3,
    3,
    2.9,
    2.9,
    2.9,
    2.9,
    2.8,
    2.8,
    2.7,
    2.6,
    2.4,
    2.2,
    2
  ],
  112: [
    65,
    64.1,
    63.1,
    62.1,
    61.1,
    60.2,
    59.2,
    58.2,
    57.3,
    56.3,
    55.3,
    54.4,
    53.4,
    52.5,
    51.5,
    50.5,
    49.6,
    48.6,
    47.7,
    46.7,
    45.7,
    44.8,
    43.8,
    42.9,
    41.9,
    41,
    40,
    39,
    38.1,
    37.1,
    36.2,
    35.3,
    34.3,
    33.4,
    32.5,
    31.6,
    30.7,
    29.8,
    28.9,
    28,
    27.1,
    26.3,
    25.4,
    24.6,
    23.7,
    22.9,
    22.1,
    21.3,
    20.4,
    19.6,
    18.8,
    18,
    17.2,
    16.4,
    15.7,
    14.9,
    14.2,
    13.4,
    12.7,
    12,
    11.3,
    10.7,
    10.1,
    9.5,
    8.9,
    8.3,
    7.8,
    7.3,
    6.9,
    6.5,
    6.1,
    5.7,
    5.4,
    5.1,
    4.8,
    4.5,
    4.3,
    4,
    3.8,
    3.7,
    3.5,
    3.4,
    3.2,
    3.1,
    3.1,
    3,
    3,
    2.9,
    2.9,
    2.9,
    2.9,
    2.9,
    2.9,
    2.9,
    2.8,
    2.8,
    2.7,
    2.6,
    2.4,
    2.2,
    2
  ],
  113: [
    65,
    64.1,
    63.1,
    62.1,
    61.1,
    60.2,
    59.2,
    58.2,
    57.3,
    56.3,
    55.3,
    54.4,
    53.4,
    52.5,
    51.5,
    50.5,
    49.6,
    48.6,
    47.7,
    46.7,
    45.7,
    44.8,
    43.8,
    42.9,
    41.9,
    41,
    40,
    39,
    38.1,
    37.1,
    36.2,
    35.3,
    34.3,
    33.4,
    32.5,
    31.6,
    30.7,
    29.8,
    28.9,
    28,
    27.1,
    26.3,
    25.4,
    24.6,
    23.7,
    22.9,
    22.1,
    21.3,
    20.4,
    19.6,
    18.8,
    18,
    17.2,
    16.4,
    15.7,
    14.9,
    14.2,
    13.4,
    12.7,
    12,
    11.3,
    10.7,
    10,
    9.4,
    8.9,
    8.3,
    7.8,
    7.3,
    6.9,
    6.4,
    6.1,
    5.7,
    5.3,
    5,
    4.7,
    4.5,
    4.2,
    4,
    3.8,
    3.6,
    3.5,
    3.4,
    3.2,
    3.1,
    3.1,
    3,
    3,
    2.9,
    2.9,
    2.9,
    2.9,
    2.9,
    2.9,
    2.8,
    2.8,
    2.8,
    2.7,
    2.6,
    2.4,
    2.2,
    1.9
  ],
  114: [
    65,
    64.1,
    63.1,
    62.1,
    61.1,
    60.2,
    59.2,
    58.2,
    57.3,
    56.3,
    55.3,
    54.4,
    53.4,
    52.5,
    51.5,
    50.5,
    49.6,
    48.6,
    47.7,
    46.7,
    45.7,
    44.8,
    43.8,
    42.9,
    41.9,
    41,
    40,
    39,
    38.1,
    37.1,
    36.2,
    35.3,
    34.3,
    33.4,
    32.5,
    31.6,
    30.7,
    29.8,
    28.9,
    28,
    27.1,
    26.3,
    25.4,
    24.6,
    23.7,
    22.9,
    22.1,
    21.3,
    20.4,
    19.6,
    18.8,
    18,
    17.2,
    16.4,
    15.7,
    14.9,
    14.1,
    13.4,
    12.7,
    12,
    11.3,
    10.7,
    10,
    9.4,
    8.9,
    8.3,
    7.8,
    7.3,
    6.9,
    6.4,
    6,
    5.7,
    5.3,
    5,
    4.7,
    4.4,
    4.2,
    4,
    3.8,
    3.6,
    3.5,
    3.3,
    3.2,
    3.1,
    3,
    3,
    2.9,
    2.9,
    2.9,
    2.9,
    2.9,
    2.8,
    2.8,
    2.8,
    2.8,
    2.7,
    2.6,
    2.5,
    2.4,
    2.1,
    1.9
  ],
  115: [
    65,
    64.1,
    63.1,
    62.1,
    61.1,
    60.2,
    59.2,
    58.2,
    57.3,
    56.3,
    55.3,
    54.4,
    53.4,
    52.5,
    51.5,
    50.5,
    49.6,
    48.6,
    47.7,
    46.7,
    45.7,
    44.8,
    43.8,
    42.9,
    41.9,
    41,
    40,
    39,
    38.1,
    37.1,
    36.2,
    35.3,
    34.3,
    33.4,
    32.5,
    31.6,
    30.7,
    29.8,
    28.9,
    28,
    27.1,
    26.3,
    25.4,
    24.6,
    23.7,
    22.9,
    22.1,
    21.3,
    20.4,
    19.6,
    18.8,
    18,
    17.2,
    16.4,
    15.7,
    14.9,
    14.1,
    13.4,
    12.7,
    12,
    11.3,
    10.7,
    10,
    9.4,
    8.8,
    8.3,
    7.8,
    7.3,
    6.8,
    6.4,
    6,
    5.6,
    5.3,
    5,
    4.7,
    4.4,
    4.2,
    4,
    3.8,
    3.6,
    3.4,
    3.3,
    3.2,
    3.1,
    3,
    2.9,
    2.9,
    2.9,
    2.8,
    2.8,
    2.8,
    2.8,
    2.8,
    2.8,
    2.7,
    2.7,
    2.6,
    2.5,
    2.3,
    2.1,
    1.8
  ],
  116: [
    65,
    64.1,
    63.1,
    62.1,
    61.1,
    60.2,
    59.2,
    58.2,
    57.3,
    56.3,
    55.3,
    54.4,
    53.4,
    52.5,
    51.5,
    50.5,
    49.6,
    48.6,
    47.7,
    46.7,
    45.7,
    44.8,
    43.8,
    42.9,
    41.9,
    41,
    40,
    39,
    38.1,
    37.1,
    36.2,
    35.3,
    34.3,
    33.4,
    32.5,
    31.6,
    30.7,
    29.8,
    28.9,
    28,
    27.1,
    26.3,
    25.4,
    24.6,
    23.7,
    22.9,
    22.1,
    21.3,
    20.4,
    19.6,
    18.8,
    18,
    17.2,
    16.4,
    15.6,
    14.9,
    14.1,
    13.4,
    12.7,
    12,
    11.3,
    10.6,
    10,
    9.4,
    8.8,
    8.3,
    7.7,
    7.3,
    6.8,
    6.4,
    6,
    5.6,
    5.2,
    4.9,
    4.6,
    4.4,
    4.1,
    3.9,
    3.7,
    3.5,
    3.3,
    3.2,
    3.1,
    3,
    2.9,
    2.8,
    2.8,
    2.8,
    2.8,
    2.8,
    2.7,
    2.7,
    2.7,
    2.7,
    2.6,
    2.6,
    2.5,
    2.4,
    2.2,
    2,
    1.8
  ],
  117: [
    65,
    64.1,
    63.1,
    62.1,
    61.1,
    60.2,
    59.2,
    58.2,
    57.3,
    56.3,
    55.3,
    54.4,
    53.4,
    52.5,
    51.5,
    50.5,
    49.6,
    48.6,
    47.7,
    46.7,
    45.7,
    44.8,
    43.8,
    42.9,
    41.9,
    41,
    40,
    39,
    38.1,
    37.1,
    36.2,
    35.3,
    34.3,
    33.4,
    32.5,
    31.6,
    30.7,
    29.8,
    28.9,
    28,
    27.1,
    26.3,
    25.4,
    24.6,
    23.7,
    22.9,
    22.1,
    21.2,
    20.4,
    19.6,
    18.8,
    18,
    17.2,
    16.4,
    15.6,
    14.9,
    14.1,
    13.4,
    12.7,
    12,
    11.3,
    10.6,
    10,
    9.4,
    8.8,
    8.2,
    7.7,
    7.2,
    6.8,
    6.3,
    5.9,
    5.5,
    5.2,
    4.9,
    4.6,
    4.3,
    4,
    3.8,
    3.6,
    3.4,
    3.3,
    3.1,
    3,
    2.9,
    2.8,
    2.7,
    2.7,
    2.7,
    2.7,
    2.6,
    2.6,
    2.6,
    2.6,
    2.6,
    2.5,
    2.5,
    2.4,
    2.3,
    2.1,
    1.9,
    1.6
  ],
  118: [
    65,
    64.1,
    63.1,
    62.1,
    61.1,
    60.2,
    59.2,
    58.2,
    57.3,
    56.3,
    55.3,
    54.4,
    53.4,
    52.5,
    51.5,
    50.5,
    49.6,
    48.6,
    47.7,
    46.7,
    45.7,
    44.8,
    43.8,
    42.9,
    41.9,
    41,
    40,
    39,
    38.1,
    37.1,
    36.2,
    35.3,
    34.3,
    33.4,
    32.5,
    31.6,
    30.7,
    29.8,
    28.9,
    28,
    27.1,
    26.3,
    25.4,
    24.5,
    23.7,
    22.9,
    22.1,
    21.2,
    20.4,
    19.6,
    18.8,
    18,
    17.2,
    16.4,
    15.6,
    14.9,
    14.1,
    13.4,
    12.6,
    11.9,
    11.3,
    10.6,
    10,
    9.3,
    8.8,
    8.2,
    7.7,
    7.2,
    6.7,
    6.3,
    5.8,
    5.5,
    5.1,
    4.8,
    4.5,
    4.2,
    3.9,
    3.7,
    3.5,
    3.3,
    3.1,
    3,
    2.8,
    2.7,
    2.6,
    2.6,
    2.5,
    2.5,
    2.5,
    2.5,
    2.5,
    2.4,
    2.4,
    2.4,
    2.4,
    2.3,
    2.2,
    2.1,
    1.9,
    1.7,
    1.4
  ],
  119: [
    65,
    64.1,
    63.1,
    62.1,
    61.1,
    60.2,
    59.2,
    58.2,
    57.3,
    56.3,
    55.3,
    54.4,
    53.4,
    52.5,
    51.5,
    50.5,
    49.6,
    48.6,
    47.7,
    46.7,
    45.7,
    44.8,
    43.8,
    42.9,
    41.9,
    41,
    40,
    39,
    38.1,
    37.1,
    36.2,
    35.3,
    34.3,
    33.4,
    32.5,
    31.6,
    30.7,
    29.8,
    28.9,
    28,
    27.1,
    26.2,
    25.4,
    24.5,
    23.7,
    22.9,
    22.1,
    21.2,
    20.4,
    19.6,
    18.8,
    18,
    17.2,
    16.4,
    15.6,
    14.8,
    14.1,
    13.4,
    12.6,
    11.9,
    11.2,
    10.6,
    9.9,
    9.3,
    8.7,
    8.2,
    7.6,
    7.1,
    6.6,
    6.2,
    5.8,
    5.4,
    5,
    4.7,
    4.4,
    4.1,
    3.8,
    3.6,
    3.3,
    3.1,
    2.9,
    2.8,
    2.6,
    2.5,
    2.4,
    2.4,
    2.3,
    2.3,
    2.3,
    2.3,
    2.2,
    2.2,
    2.2,
    2.2,
    2.1,
    2.1,
    2,
    1.9,
    1.7,
    1.3,
    1.1
  ],
  120: [
    65,
    64.1,
    63.1,
    62.1,
    61.1,
    60.2,
    59.2,
    58.2,
    57.3,
    56.3,
    55.3,
    54.4,
    53.4,
    52.5,
    51.5,
    50.5,
    49.6,
    48.6,
    47.7,
    46.7,
    45.7,
    44.8,
    43.8,
    42.9,
    41.9,
    41,
    40,
    39,
    38.1,
    37.1,
    36.2,
    35.3,
    34.3,
    33.4,
    32.5,
    31.6,
    30.6,
    29.8,
    28.9,
    28,
    27.1,
    26.2,
    25.4,
    24.5,
    23.7,
    22.9,
    22,
    21.2,
    20.4,
    19.6,
    18.8,
    18,
    17.2,
    16.4,
    15.6,
    14.8,
    14.1,
    13.3,
    12.6,
    11.9,
    11.2,
    10.5,
    9.9,
    9.3,
    8.7,
    8.1,
    7.6,
    7.1,
    6.6,
    6.1,
    5.7,
    5.3,
    4.9,
    4.6,
    4.3,
    4,
    3.7,
    3.4,
    3.2,
    3,
    2.8,
    2.6,
    2.5,
    2.3,
    2.2,
    2.1,
    2.1,
    2.1,
    2,
    2,
    2,
    2,
    2,
    1.9,
    1.9,
    1.8,
    1.8,
    1.6,
    1.4,
    1.1,
    1
  ]
};
function jointDivisor(ownerAge, spouseAge) {
  const o = Math.min(120, Math.max(70, Math.round(ownerAge)));
  const s = Math.min(120, Math.max(20, Math.round(spouseAge)));
  const row = JOINT_LIFE_TABLE[o] ?? JOINT_LIFE_TABLE[120] ?? [];
  return row[s - 20] ?? row[row.length - 1] ?? 2;
}

function r2(n) {
  return Math.round(n * 100) / 100;
}
function ssTaxableAmount(benefits, provisionalIncome, filingStatus, deflationFactor) {
  if (benefits <= 0)
    return 0;
  const t = SS_THRESHOLDS[filingStatus];
  const t1 = t.first * deflationFactor;
  const t2 = t.second * deflationFactor;
  if (provisionalIncome <= t1)
    return 0;
  if (provisionalIncome <= t2) {
    return Math.min(0.5 * benefits, 0.5 * (provisionalIncome - t1));
  }
  const base = Math.min(0.5 * benefits, 0.5 * (t2 - t1));
  return Math.min(0.85 * benefits, base + 0.85 * (provisionalIncome - t2));
}
function bracketTax(taxableOrdinary, law, fs) {
  const tops = law.brackets[fs];
  let tax = 0;
  let prev = 0;
  for (let i = 0;i < tops.length; i++) {
    const top = tops[i] ?? Infinity;
    const rate = (law.rates[i] ?? 0) / 100;
    if (taxableOrdinary <= prev)
      break;
    tax += (Math.min(taxableOrdinary, top) - prev) * rate;
    prev = top;
  }
  return tax;
}
function marginalRate(taxableOrdinary, law, fs) {
  const tops = law.brackets[fs];
  for (let i = 0;i < tops.length; i++) {
    if (taxableOrdinary < (tops[i] ?? Infinity))
      return law.rates[i] ?? 0;
  }
  return law.rates[law.rates.length - 1] ?? 37;
}
function deflationFactor(calendarYear, lawYear, inflationPct) {
  const years = Math.max(0, calendarYear - lawYear);
  const factor = 1 / Math.pow(1 + inflationPct / 100, years);
  if (!Number.isFinite(factor)) {
    throw new Error(`deflationFactor: non-finite factor for inflationPct ${inflationPct} over ${years} year(s) — inflation must be greater than −100%.`);
  }
  return factor;
}
function irmaaTierUpTo(tierIndex, filingStatus, law, calendarYear, inflationPct) {
  const tier = law.irmaaTiers[tierIndex];
  if (!tier)
    return Infinity;
  let upTo = filingStatus === "mfj" ? tier.upToMfj : tier.upToSingle;
  if (tierIndex === law.irmaaTiers.length - 2 && Number.isFinite(upTo)) {
    const deflYears = Math.min(Math.max(0, calendarYear - law.year), Math.max(0, 2028 - law.year));
    upTo = upTo / Math.pow(1 + inflationPct / 100, deflYears);
  }
  return upTo;
}
function irmaaTierFor(magi, filingStatus, law, calendarYear, inflationPct) {
  const tiers = law.irmaaTiers;
  for (let i = 0;i < tiers.length; i++) {
    const upTo = irmaaTierUpTo(i, filingStatus, law, calendarYear, inflationPct);
    if (i === tiers.length - 2 && Number.isFinite(upTo)) {
      const tier = tiers[i];
      const rawUpTo = tier ? filingStatus === "mfj" ? tier.upToMfj : tier.upToSingle : upTo;
      if (upTo === rawUpTo) {
        if (magi < rawUpTo + 1)
          return i;
        continue;
      }
      if (magi <= upTo)
        return i;
      continue;
    }
    if (magi <= upTo)
      return i;
  }
  return tiers.length - 1;
}
function irmaaAnnualPerPerson(tier, law) {
  const t = law.irmaaTiers[tier] ?? law.irmaaTiers[0];
  if (!t)
    return 0;
  return r2((t.partBTotalMonthly - law.partBStandardMonthly + t.partDSurchargeMonthly) * 12);
}
function waCapitalGainsTax(args) {
  const waGains = Math.max(0, args.ltcg);
  const donations = Math.max(0, args.charitableDonations ?? 0);
  const charitableDeduction = Math.min(args.law.waCharitableCap, Math.max(0, donations - args.law.waCharitableThreshold));
  const taxableGains = Math.max(0, waGains - args.law.waStandardDeduction - charitableDeduction);
  const surtaxThreshold = args.law.waAdditionalThreshold * (args.deflationFactor ?? 1);
  const atBase = Math.min(taxableGains, surtaxThreshold);
  const above = taxableGains - atBase;
  const tax = args.law.waRatePct / 100 * atBase + (args.law.waRatePct + args.law.waAdditionalRatePct) / 100 * above;
  return {
    waGains: r2(waGains),
    standardDeduction: r2(args.law.waStandardDeduction),
    charitableDeduction: r2(charitableDeduction),
    taxableGains: r2(taxableGains),
    tax: r2(tax)
  };
}
function capitalLossAllowanceCap(filingStatus) {
  return 3000;
}
function applyLossLedger(carryIn, ownLongTermResult, filingStatus, taxableIncomeBeforeAllowance, waIn) {
  const stIn = Math.max(0, carryIn.st);
  const ltIn = Math.max(0, carryIn.lt);
  const waStIn = Math.min(stIn, Math.max(0, waIn?.st ?? 0));
  const waLtIn = Math.min(ltIn, Math.max(0, waIn?.lt ?? 0));
  const ltNet = ownLongTermResult - ltIn;
  let remainingStLoss = stIn;
  let remainingLtLoss = 0;
  let pricedGain = 0;
  if (ltNet >= 0) {
    pricedGain = Math.max(0, ltNet - remainingStLoss);
    remainingStLoss = Math.max(0, remainingStLoss - ltNet);
  } else {
    remainingLtLoss = -ltNet;
  }
  const totalLoss = remainingStLoss + remainingLtLoss;
  const allowance = totalLoss > 0 ? Math.min(capitalLossAllowanceCap(filingStatus), totalLoss) : 0;
  const allowanceUsed = Math.min(allowance, Math.max(0, taxableIncomeBeforeAllowance));
  const stConsumedByAllowance = Math.min(allowanceUsed, remainingStLoss);
  const ltConsumedByAllowance = allowanceUsed - stConsumedByAllowance;
  const carryOut = {
    st: r2(remainingStLoss - stConsumedByAllowance),
    lt: r2(remainingLtLoss - ltConsumedByAllowance)
  };
  const absorbedByGains = r2(Math.max(0, stIn + ltIn - carryOut.st - carryOut.lt - allowanceUsed));
  const ltAbsorbedByGains = Math.max(0, ltIn - remainingLtLoss);
  const stAbsorbedByGains = Math.max(0, stIn - remainingStLoss);
  const waLtAbsorbed = ltIn > 0 ? waLtIn * ltAbsorbedByGains / ltIn : 0;
  const waStAbsorbed = stIn > 0 ? waStIn * stAbsorbedByGains / stIn : 0;
  const waStRemainder = waStIn - waStAbsorbed;
  const waLtRemainder = waLtIn - waLtAbsorbed;
  const waStUsedByAllowance = remainingStLoss > 0 ? waStRemainder * stConsumedByAllowance / remainingStLoss : 0;
  const waLtUsedByAllowance = remainingLtLoss > 0 ? waLtRemainder * ltConsumedByAllowance / remainingLtLoss : 0;
  const waCarryOut = {
    st: r2(Math.max(0, waStRemainder - waStUsedByAllowance)),
    lt: r2(Math.max(0, waLtRemainder - waLtUsedByAllowance))
  };
  return {
    netResult: r2(totalLoss > 0 ? -totalLoss : pricedGain),
    allowance: r2(allowance),
    allowanceUsed: r2(allowanceUsed),
    absorbedByGains,
    waAbsorbedByGains: r2(waStAbsorbed + waLtAbsorbed),
    carryOut,
    waCarryOut
  };
}
function educationCreditsFor(args) {
  const none = {
    aotc: 0,
    llc: 0,
    choice: "none",
    nonrefundableApplied: 0,
    refundable: 0
  };
  const students = (args.students ?? []).filter((s) => s != null && Number.isFinite(s.expenses) && s.expenses > 0);
  if (students.length === 0)
    return none;
  const law = args.law;
  const defl = args.defl;
  const tier1Cap = law.aotcTier1Expenses * defl;
  const tier2Cap = law.aotcTier2Expenses * defl;
  const llcCap = law.llcExpenseCap * defl;
  const phaseStart = law.eduPhaseOutStart[args.filingStatus] * defl;
  const phaseWidth = law.eduPhaseOutWidth[args.filingStatus] * defl;
  const excess = Math.max(0, args.agi - phaseStart);
  const phasedOut = phaseWidth > 0 ? Math.min(1, excess / phaseWidth) : excess > 0 ? 1 : 0;
  const keep = 1 - phasedOut;
  if (keep <= 0)
    return none;
  const aotcForStudent = (expenses) => {
    const e = Math.max(0, expenses);
    const tier1 = Math.min(e, tier1Cap);
    const tier2 = Math.min(Math.max(0, e - tier1Cap), tier2Cap);
    return law.aotcTier1RatePct / 100 * tier1 + law.aotcTier2RatePct / 100 * tier2;
  };
  const llcForExpenses = (expenses) => law.llcRatePct / 100 * Math.min(Math.max(0, expenses), llcCap);
  const liability = Math.max(0, args.taxBeforeCredits);
  const price = (aotcTentative, llcTentative) => {
    const aotc = aotcTentative * keep;
    const llc = llcTentative * keep;
    const refundable = law.aotcRefundablePct / 100 * aotc;
    const nonrefundableTentative = aotc - refundable + llc;
    const nonrefundableApplied = Math.min(nonrefundableTentative, liability);
    return {
      aotc,
      llc,
      refundable,
      nonrefundableApplied,
      benefit: refundable + nonrefundableApplied
    };
  };
  const eligible = students.filter((s) => s.aotcEligible);
  const others = students.filter((s) => !s.aotcEligible);
  const sum = (list) => list.reduce((a, s) => a + Math.max(0, s.expenses), 0);
  const allocA = price(eligible.reduce((a, s) => a + aotcForStudent(s.expenses), 0), llcForExpenses(sum(others)));
  const allocB = price(0, llcForExpenses(sum(students)));
  const winner = allocB.benefit > allocA.benefit ? allocB : allocA;
  if (winner.benefit <= 0)
    return none;
  return {
    aotc: r2(winner.aotc),
    llc: r2(winner.llc),
    choice: winner.aotc > 0 ? "aotc" : "llc",
    nonrefundableApplied: r2(winner.nonrefundableApplied),
    refundable: r2(winner.refundable)
  };
}
function amtFor(args) {
  const law = args.law;
  const fs = args.filingStatus;
  const addback = (args.deductionTaken === "standard" ? Math.max(0, args.standardDeduction) : Math.max(0, args.itemizedSaltAllowed)) + Math.max(0, args.seniorDeduction);
  const amti = Math.max(0, args.taxableIncome) + addback;
  const phaseOutExcess = Math.max(0, amti - law.amtPhaseOutStart[fs]);
  const exemption = Math.max(0, law.amtExemption[fs] - law.amtPhaseOutRatePct / 100 * phaseOutExcess);
  const excess = Math.max(0, amti - exemption);
  const pref = Math.min(excess, Math.max(0, args.gainsInTaxableIncome));
  const ordinaryExcess = excess - pref;
  const atLow = Math.min(ordinaryExcess, law.amtBreakpoint);
  let tentative = law.amtRateLowPct / 100 * atLow + law.amtRateHighPct / 100 * (ordinaryExcess - atLow);
  const zeroSpace = Math.max(0, law.ltcgZeroTop[fs] - args.ordinaryStack);
  const at0 = Math.min(pref, zeroSpace);
  const afterZero = pref - at0;
  const twentySpace = Math.max(0, law.ltcg20Floor[fs] - args.ordinaryStack - at0);
  const at15 = Math.min(afterZero, twentySpace);
  const at20 = afterZero - at15;
  tentative += 0.15 * at15 + 0.2 * at20;
  const owed = Math.max(0, tentative - Math.max(0, args.regularTax));
  return {
    amti: r2(amti),
    exemption: r2(exemption),
    tentativeTax: r2(tentative),
    owed: r2(owed)
  };
}
function priceYear(input) {
  const law = lawForYear(input.calendarYear);
  const fs = input.filingStatus;
  const defl = deflationFactor(input.calendarYear, law.year, input.inflationPct);
  const interestIncome = input.interestIncome ?? 0;
  const ordinaryDividends = input.ordinaryDividends ?? 0;
  const capitalLossAllowance = input.capitalLossAllowance ?? 0;
  const gainsStack = Math.max(0, input.ltcg) + (input.qualifiedDividends ?? 0);
  const agiExclSs = input.otherOrdinary + input.rmd + input.conversion + input.extraPreTaxDraw + gainsStack + interestIncome + ordinaryDividends - capitalLossAllowance;
  const provisional = agiExclSs + input.taxExemptInterest + 0.5 * input.ssBenefits;
  const ssTaxable = ssTaxableAmount(input.ssBenefits, provisional, fs, defl);
  const agi = agiExclSs + ssTaxable;
  const magi = agi + input.taxExemptInterest;
  const acaMagi = magi + (input.ssBenefits - ssTaxable);
  const count65 = (input.agePrimary >= 65 ? 1 : 0) + (fs === "mfj" && input.ageSpouse != null && input.ageSpouse >= 65 ? 1 : 0);
  const standardDeduction = law.standardDeduction[fs] + law.age65Addon[fs] * count65;
  const seniorFor = (agiForPhaseOut) => {
    if (input.calendarYear < SENIOR_DEDUCTION.firstYear || input.calendarYear > SENIOR_DEDUCTION.lastYear || count65 === 0) {
      return 0;
    }
    const excess = Math.max(0, agiForPhaseOut - SENIOR_DEDUCTION.phaseOutStart[fs] * defl);
    const perPerson = Math.max(0, SENIOR_DEDUCTION.amountPerPerson * defl - SENIOR_DEDUCTION.phaseOutRate * excess);
    return perPerson * count65;
  };
  let seniorDeduction = seniorFor(agi);
  const saltEntered = Math.max(0, input.itemizedSaltPaid ?? 0);
  let saltCapApplied;
  if (input.calendarYear >= SALT_SCHEDULE_FIRST_YEAR) {
    const salt = saltScheduleForYear(input.calendarYear);
    const saltDefl = deflationFactor(input.calendarYear, salt.entryYear, input.inflationPct);
    saltCapApplied = Math.max(salt.capFloor * saltDefl, salt.cap * saltDefl - salt.phaseOutRatePct / 100 * Math.max(0, agi - salt.phaseOutStart * saltDefl));
  } else {
    saltCapApplied = Math.max(law.saltCapFloor * defl, law.saltCap * defl - law.saltPhaseOutRatePct / 100 * Math.max(0, agi - law.saltPhaseOutStart * defl));
  }
  const itemizedSaltAllowed = Math.min(saltEntered, saltCapApplied);
  const deductionTrioApplies = input.calendarYear >= DEDUCTION_2026.firstYear;
  const charitableEntered = Math.max(0, input.itemizedCharitable ?? 0);
  const charitableFloor = deductionTrioApplies ? DEDUCTION_2026.charitableFloorRatePct / 100 * agi : 0;
  const itemizedCharitableAllowed = Math.min(Math.max(0, charitableEntered - charitableFloor), CHARITABLE_CEILING.ratePct / 100 * agi);
  const itemizedBefore68 = Math.max(0, input.itemizedMortgageInterest ?? 0) + itemizedSaltAllowed + itemizedCharitableAllowed + Math.max(0, input.itemizedOther ?? 0);
  const taxableWithout68 = Math.max(0, agi - itemizedBefore68 - seniorDeduction);
  let section68Reduction = 0;
  if (deductionTrioApplies && itemizedBefore68 > 0) {
    const tops = law.brackets[fs];
    const threshold37 = tops[tops.length - 2] ?? Infinity;
    const excess68 = Math.max(0, taxableWithout68 + itemizedBefore68 - threshold37);
    section68Reduction = DEDUCTION_2026.section68Numerator / DEDUCTION_2026.section68Denominator * Math.min(itemizedBefore68, excess68);
  }
  const itemizedDeduction = itemizedBefore68 - section68Reduction;
  const section170pCandidate = deductionTrioApplies ? Math.min(charitableEntered, DEDUCTION_2026.nonItemizerCharitableCap[fs] * defl) : 0;
  const standardEffect = standardDeduction + section170pCandidate + seniorDeduction;
  const itemizedEffect = itemizedDeduction + seniorDeduction;
  const deductionTaken = itemizedEffect > standardEffect ? "itemized" : "standard";
  let nonItemizerCharitableDeduction = 0;
  let deductions;
  if (deductionTaken === "itemized") {
    deductions = itemizedDeduction + seniorDeduction;
  } else {
    nonItemizerCharitableDeduction = section170pCandidate;
    deductions = standardDeduction + section170pCandidate + seniorDeduction;
  }
  const taxableIncome = Math.max(0, agi - deductions);
  const gainsInTi = Math.min(gainsStack, taxableIncome);
  const ordinaryTi = taxableIncome - gainsInTi;
  const ordinaryTax = bracketTax(ordinaryTi, law, fs);
  const bracketLayers = [];
  {
    let prev = 0;
    for (let i = 0;i < law.brackets[fs].length; i++) {
      const top = law.brackets[fs][i] ?? Infinity;
      if (ordinaryTi <= prev)
        break;
      const amount = Math.min(ordinaryTi, top) - prev;
      const ratePct = law.rates[i] ?? 0;
      bracketLayers.push({
        ratePct,
        from: r2(prev),
        to: Number.isFinite(top) ? top : null,
        amount: r2(amount),
        tax: r2(amount * (ratePct / 100))
      });
      prev = top;
    }
  }
  const zeroSpace = Math.max(0, law.ltcgZeroTop[fs] - ordinaryTi);
  const at0 = Math.min(gainsInTi, zeroSpace);
  const afterZero = gainsInTi - at0;
  const twentySpace = Math.max(0, law.ltcg20Floor[fs] - ordinaryTi - at0);
  const at15 = Math.min(afterZero, twentySpace);
  const at20 = afterZero - at15;
  const ltcgTax = 0.15 * at15 + 0.2 * at20;
  const niitBase = Math.max(0, gainsStack + interestIncome + ordinaryDividends - (input.ltcg < 0 ? capitalLossAllowance : 0));
  const niit = law.niitRate / 100 * Math.min(niitBase, Math.max(0, agi - law.niitThreshold[fs] * defl));
  const education = educationCreditsFor({
    students: input.educationStudents,
    filingStatus: fs,
    agi,
    taxBeforeCredits: ordinaryTax + ltcgTax,
    law,
    defl
  });
  const regularTaxAfterCredits = Math.max(0, ordinaryTax + ltcgTax - education.nonrefundableApplied);
  const taxableForAmt = deductionTaken === "itemized" ? taxableWithout68 : taxableIncome;
  const amt = amtFor({
    taxableIncome: taxableForAmt,
    deductionTaken,
    standardDeduction,
    itemizedSaltAllowed,
    seniorDeduction,
    gainsInTaxableIncome: Math.min(gainsStack, taxableForAmt),
    ordinaryStack: ordinaryTi,
    regularTax: regularTaxAfterCredits,
    filingStatus: fs,
    law
  });
  const federalTax = regularTaxAfterCredits + niit + amt.owed;
  const wa = input.residenceState === "WA" ? waCapitalGainsTax({
    ltcg: input.waGainsBase ?? input.ltcg,
    charitableDonations: input.itemizedCharitable,
    law,
    deflationFactor: defl
  }) : null;
  const stateTax = wa ? wa.tax : input.stateRatePct / 100 * taxableIncome;
  return {
    provisionalIncome: r2(provisional),
    ssTaxable: r2(ssTaxable),
    agi: r2(agi),
    magi: r2(magi),
    acaMagi: r2(acaMagi),
    standardDeduction: r2(standardDeduction),
    seniorDeduction: r2(seniorDeduction),
    itemizedDeduction: r2(itemizedDeduction),
    itemizedSaltAllowed: r2(itemizedSaltAllowed),
    itemizedSaltCap: r2(saltCapApplied),
    itemizedCharitableAllowed: r2(itemizedCharitableAllowed),
    section68Reduction: r2(section68Reduction),
    nonItemizerCharitableDeduction: r2(nonItemizerCharitableDeduction),
    deductionTaken,
    deductions: r2(deductions),
    taxableIncome: r2(taxableIncome),
    taxableIncomeBeforeLossAllowance: r2(Math.max(0, agi - deductions + capitalLossAllowance)),
    ordinaryTax: r2(ordinaryTax),
    ltcgTax: r2(ltcgTax),
    niit: r2(niit),
    federalTax: r2(federalTax),
    stateTax: r2(stateTax),
    waGains: wa ? wa.waGains : 0,
    waStandardDeduction: wa ? wa.standardDeduction : 0,
    waCharitableDeduction: wa ? wa.charitableDeduction : 0,
    waTaxableGains: wa ? wa.taxableGains : 0,
    educationAotc: education.aotc,
    educationLlc: education.llc,
    educationChoice: education.choice,
    educationNonrefundable: education.nonrefundableApplied,
    educationRefundable: education.refundable,
    amti: amt.amti,
    amtExemption: amt.exemption,
    amtTentativeTax: amt.tentativeTax,
    amtOwed: amt.owed,
    marginalBracketPct: marginalRate(ordinaryTi, law, fs),
    irmaaTier: irmaaTierFor(magi, fs, law, input.calendarYear, input.inflationPct),
    baseStandardDeduction: r2(law.standardDeduction[fs]),
    age65AddonTotal: r2(law.age65Addon[fs] * count65),
    count65,
    ordinaryTaxableIncome: r2(ordinaryTi),
    gainsInTaxableIncome: r2(gainsInTi),
    bracketLayers,
    gainsAt0: r2(at0),
    gainsAt15: r2(at15),
    gainsAt20: r2(at20)
  };
}
function acaCreditFor(args) {
  const fpl = fplFor(args.householdSize, args.coverageYear - 1);
  const cliff = 4 * fpl;
  const pctFpl = fpl > 0 ? args.magi / fpl * 100 : 0;
  const magiCents = Math.round(args.magi * 100);
  const fplCents = Math.round(fpl * 100);
  const hasCliff = args.coverageYear >= 2026;
  const overCliff = hasCliff && args.magi > cliff;
  if (overCliff || magiCents < fplCents) {
    return { credit: 0, pctFpl: r2(pctFpl), applicablePct: 0, fpl, cliff, overCliff };
  }
  const bands = acaTableFor(args.tableYear ?? args.coverageYear, {
    projected: args.projected ?? false
  });
  const lows = [0, 133, 150, 200, 250, 300];
  let applicablePct = bands[bands.length - 1]?.finalPct ?? 9.96;
  for (let i = 0;i < bands.length; i++) {
    const band = bands[i];
    if (!band)
      continue;
    if (magiCents * 100 < band.upToPctFpl * fplCents || i === bands.length - 1) {
      const lo = lows[i] ?? 0;
      const span = band.upToPctFpl - lo;
      const frac = span > 0 ? Math.min(1, Math.max(0, (pctFpl - lo) / span)) : 0;
      applicablePct = band.initialPct + (band.finalPct - band.initialPct) * frac;
      break;
    }
  }
  const expected = applicablePct / 100 * args.magi;
  return {
    credit: r2(Math.max(0, args.benchmarkAnnual - expected)),
    pctFpl: r2(pctFpl),
    applicablePct: r2(applicablePct),
    fpl,
    cliff,
    overCliff: false
  };
}
function rmdForYear(args) {
  const rmdAge = rmdAgeForBirthYear(args.birthYearPrimary);
  if (args.agePrimary < rmdAge || args.priorDec31PreTax <= 0) {
    return { rmd: 0, divisor: null, table: null };
  }
  const useJoint = args.spouseSoleBeneficiary && args.ageSpouse != null && args.agePrimary - args.ageSpouse > 10;
  const divisor = useJoint ? jointDivisor(args.agePrimary, args.ageSpouse ?? args.agePrimary) : uniformDivisor(args.agePrimary);
  return {
    rmd: r2(args.priorDec31PreTax / divisor),
    divisor,
    table: useJoint ? "joint" : "uniform"
  };
}
function uniformRmdFor(args) {
  const rmdAge = rmdAgeForBirthYear(args.birthYear);
  if (args.age < rmdAge || args.priorDec31PreTax <= 0) {
    return { rmd: 0, divisor: null };
  }
  const divisor = uniformDivisor(args.age);
  return { rmd: r2(args.priorDec31PreTax / divisor), divisor };
}
var NO_CEILINGS = {
  bracketTopPct: null,
  irmaaTierCap: null,
  ltcgZeroCap: false,
  acaCliffCap: false,
  acaCliffCapFamilyOnly: false,
  magiCap: null,
  acaCliffBuffer: null
};
function ceilingsActive(c) {
  return c.bracketTopPct != null || c.irmaaTierCap != null || c.ltcgZeroCap || c.acaCliffCap || c.magiCap != null;
}
function fillConversion(args) {
  const { ceilings } = args;
  if (!ceilingsActive(ceilings))
    return Math.max(0, Math.floor(args.maxConversion));
  const law = lawForYear(args.base.calendarYear);
  const fs = args.base.filingStatus;
  let taxableCap = Infinity;
  if (ceilings.bracketTopPct != null) {
    const idx = law.rates.indexOf(ceilings.bracketTopPct);
    if (idx >= 0)
      taxableCap = Math.min(taxableCap, law.brackets[fs][idx] ?? Infinity);
  }
  if (ceilings.ltcgZeroCap) {
    taxableCap = Math.min(taxableCap, law.ltcgZeroTop[fs]);
  }
  let magiCap = Infinity;
  if (ceilings.irmaaTierCap != null) {
    magiCap = Math.min(magiCap, irmaaTierUpTo(ceilings.irmaaTierCap, fs, law, args.base.calendarYear, args.base.inflationPct));
  }
  if (ceilings.magiCap != null)
    magiCap = Math.min(magiCap, ceilings.magiCap);
  let acaMagiCap = Infinity;
  if (ceilings.acaCliffCap) {
    if (args.acaCliff != null) {
      acaMagiCap = Math.max(0, args.acaCliff - Math.max(0, ceilings.acaCliffBuffer ?? 0));
    } else {
      const otherCeilingsActive = ceilings.bracketTopPct != null || ceilings.irmaaTierCap != null || ceilings.ltcgZeroCap || ceilings.magiCap != null;
      if (!otherCeilingsActive)
        return 0;
    }
  }
  const guardrailTarget = args.guardrailTargetPct ?? null;
  let prevStepTax = null;
  if (guardrailTarget != null) {
    const p0 = priceYear({ ...args.base, conversion: 0 });
    prevStepTax = p0.federalTax + p0.stateTax;
  }
  const maxSteps = Math.floor(Math.max(0, args.maxConversion) / 100);
  if (guardrailTarget == null) {
    const respectsCaps = (conv) => {
      const p = priceYear({ ...args.base, conversion: conv });
      return p.taxableIncome <= taxableCap + 0.005 && p.magi <= magiCap + 0.005 && p.acaMagi <= acaMagiCap + 0.005;
    };
    let lo = 0;
    let hi = maxSteps;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if (respectsCaps(mid * 100)) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo * 100;
  }
  let best = 0;
  for (let step = 1;step <= maxSteps; step++) {
    const conv = step * 100;
    const p = priceYear({ ...args.base, conversion: conv });
    if (guardrailTarget != null && prevStepTax != null) {
      const stepRate = p.federalTax + p.stateTax - prevStepTax;
      if (stepRate > guardrailTarget + 0.005)
        break;
    }
    if (p.taxableIncome > taxableCap + 0.005)
      break;
    if (p.magi > magiCap + 0.005)
      break;
    if (p.acaMagi > acaMagiCap + 0.005)
      break;
    best = conv;
    prevStepTax = p.federalTax + p.stateTax;
  }
  return best;
}
var DRAW_BUCKET_LABELS = {
  taxable: "Taxable",
  pretax: "Pre-tax",
  roth: "Roth"
};
var DRAW_ORDER_OPTIONS = [
  { key: "taxable-pretax-roth", order: ["taxable", "pretax", "roth"] },
  { key: "taxable-roth-pretax", order: ["taxable", "roth", "pretax"] },
  { key: "pretax-taxable-roth", order: ["pretax", "taxable", "roth"] },
  { key: "pretax-roth-taxable", order: ["pretax", "roth", "taxable"] },
  { key: "roth-taxable-pretax", order: ["roth", "taxable", "pretax"] },
  { key: "roth-pretax-taxable", order: ["roth", "pretax", "taxable"] }
];
var DEFAULT_DRAW_ORDER = ["taxable", "pretax", "roth"];
var DEFAULT_DRAW_ORDER_KEY = "taxable-pretax-roth";
var ALL_DRAW_ORDERS = DRAW_ORDER_OPTIONS.map((o) => o.order);
function drawOrderKey(order) {
  return order.join("-");
}
function drawOrderFromKey(key) {
  return DRAW_ORDER_OPTIONS.find((o) => o.key === key)?.order ?? DEFAULT_DRAW_ORDER;
}
function drawOrderLabel(order) {
  return order.map((b) => DRAW_BUCKET_LABELS[b]).join(" → ");
}
function effectiveDrawOrder(inputs, agePrimary) {
  if (inputs.drawOrderSwitchAge != null && inputs.drawOrderAfter != null && agePrimary >= inputs.drawOrderSwitchAge) {
    return inputs.drawOrderAfter;
  }
  return inputs.drawOrder;
}
function sellFromTiers(tiers, amount, order) {
  if (amount <= 0)
    return 0;
  const ranked = tiers.map((t, i) => ({ i, ratio: t.bal > 0 ? t.basis / t.bal : null })).filter((o) => o.ratio != null).sort((a, b) => order === "highest" ? b.ratio - a.ratio : a.ratio - b.ratio);
  let remaining = amount;
  let gains = 0;
  for (const { i } of ranked) {
    if (remaining <= 0)
      break;
    const t = tiers[i];
    const take = Math.min(remaining, t.bal);
    if (take <= 0)
      continue;
    const ratio = t.basis / t.bal;
    gains += take * (1 - ratio);
    t.basis = Math.max(0, t.basis - take * ratio);
    t.bal -= take;
    remaining -= take;
  }
  return gains;
}
function buyIntoTiers(tiers, amount) {
  if (amount <= 0)
    return;
  const existing = tiers.find((t) => t.inflow);
  if (existing) {
    existing.bal += amount;
    existing.basis += amount;
  } else {
    tiers.push({ bal: amount, basis: amount, inflow: true });
  }
}
function stepUpTiers(tiers, amount) {
  if (amount <= 0)
    return;
  const ranked = tiers.map((t, i) => ({ i, ratio: t.bal > 0 ? t.basis / t.bal : 1 })).sort((a, b) => a.ratio - b.ratio);
  let remaining = amount;
  for (const { i } of ranked) {
    if (remaining <= 0)
      break;
    const t = tiers[i];
    const room = Math.max(0, t.bal - t.basis);
    const add = Math.min(room, remaining);
    t.basis += add;
    remaining -= add;
  }
}
function reinvestYieldIntoTiers(tiers, amount) {
  if (amount <= 0 || tiers.length === 0)
    return;
  const ranked = tiers.map((t, i) => ({ i, ratio: t.bal > 0 ? t.basis / t.bal : 1 })).sort((a, b) => a.ratio - b.ratio);
  let remaining = amount;
  for (const { i } of ranked) {
    if (remaining <= 0)
      break;
    const t = tiers[i];
    const room = Math.max(0, t.bal - t.basis);
    const add = Math.min(room, remaining);
    t.basis += add;
    remaining -= add;
  }
  if (remaining > 0) {
    const host = tiers[ranked[0].i];
    host.basis += remaining;
  }
}
function clampTierLedgerToBalance(tiers, settledBalance) {
  const target = Math.max(0, settledBalance);
  let total = tiers.reduce((s, t) => s + Math.max(0, t.bal), 0);
  if (total > target && total > 0) {
    const scale = target / total;
    for (const t of tiers) {
      const bal = Math.max(0, t.bal) * scale;
      t.basis = t.bal > 0 ? t.basis * (bal / t.bal) : 0;
      t.bal = bal;
    }
    total = target;
  } else if (total < target) {
    const shortfall = target - total;
    const host = tiers.find((t) => t.inflow) ?? tiers.reduce((best, t) => best == null || t.bal > best.bal ? t : best, null);
    if (host) {
      host.bal += shortfall;
      total = target;
    }
  }
  for (const t of tiers) {
    t.bal = Math.max(0, t.bal);
    t.basis = Math.max(0, t.basis);
  }
}
function acaHouseholdSizeForYear(initialSize, schedule, year) {
  let size = initialSize;
  if (schedule) {
    for (const step of schedule) {
      if (year >= step.fromYear)
        size = step.householdSize;
    }
  }
  return size;
}
function acaFirstStepYear(schedule) {
  return schedule != null && schedule.length > 0 ? schedule[0]?.fromYear ?? null : null;
}
var ACA_SCHEDULE_MAX_STEPS = 40;
function acaStepYearOk(v) {
  return typeof v === "number" && Number.isInteger(v) && v >= 1900 && v <= 2200;
}
function acaStepSizeOk(v) {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 20;
}
function resolveAcaHouseholdSchedule(src) {
  const raw = src.acaHouseholdSchedule;
  if (Array.isArray(raw) && raw.length > 0) {
    const byYear = new Map;
    for (const entry of raw) {
      if (entry == null || typeof entry !== "object")
        continue;
      if (!acaStepYearOk(entry.fromYear) || !acaStepSizeOk(entry.householdSize))
        continue;
      byYear.set(entry.fromYear, entry.householdSize);
    }
    if (byYear.size > 0) {
      return [...byYear.entries()].sort((a, b) => a[0] - b[0]).slice(0, ACA_SCHEDULE_MAX_STEPS).map(([fromYear, householdSize]) => ({ fromYear, householdSize }));
    }
  }
  if (acaStepYearOk(src.acaStepDownYear)) {
    const size = acaStepSizeOk(src.acaHouseholdSizeAfter) ? src.acaHouseholdSizeAfter : acaStepSizeOk(src.acaHouseholdSize) ? src.acaHouseholdSize : 1;
    return [{ fromYear: src.acaStepDownYear, householdSize: size }];
  }
  return null;
}
var FAFSA_PARENT_ASSET_RATE = 0.0564;
var FAFSA_PUBLIC_COA_BENCHMARK = 40000;
function effectiveSsPrimaryAnnual(inputs) {
  return inputs.ssPrimaryNoBenefit ? 0 : inputs.ssPrimaryAnnual;
}
function effectiveSsSpouseAnnual(inputs) {
  return inputs.ssSpouseNoBenefit ? 0 : inputs.ssSpouseAnnual;
}
var ROTH_COMPARE_STRATEGIES = [
  { id: "none", name: "Do Nothing", ceilings: null },
  {
    id: "fill12",
    name: "Fill 12%",
    ceilings: { ...NO_CEILINGS, bracketTopPct: 12 }
  },
  {
    id: "fill22",
    name: "Fill 22%",
    ceilings: { ...NO_CEILINGS, bracketTopPct: 22 }
  },
  {
    id: "fill22-irmaa1",
    name: "Fill 22% capped at IRMAA Tier 1",
    ceilings: { ...NO_CEILINGS, bracketTopPct: 22, irmaaTierCap: 1 }
  },
  {
    id: "fill-aca",
    name: "Fill capped at ACA cliff",
    ceilings: { ...NO_CEILINGS, acaCliffCap: true }
  }
];
function flexSpendingNeed(baseSpending, priorYearReturnPct, flexCutPct, flexFloorPct) {
  if (flexCutPct == null || flexCutPct <= 0)
    return baseSpending;
  if (priorYearReturnPct == null)
    return baseSpending;
  if (priorYearReturnPct >= 0)
    return baseSpending;
  const floor = flexFloorPct ?? 80;
  const cut = Math.min(flexCutPct, 100 - floor);
  if (cut <= 0)
    return baseSpending;
  return baseSpending * (1 - cut / 100);
}
function deriveSpendFromCashSleeveStartDollars(inputs) {
  const pctRaw = inputs.spendFromCashPct ?? null;
  const pct = pctRaw == null ? 0 : Math.min(100, Math.max(0, pctRaw));
  if (pct <= 0)
    return 0;
  const tiersActive = inputs.taxableBasisBlank !== true && Array.isArray(inputs.taxableTiers) && inputs.taxableTiers.length > 0;
  if (tiersActive) {
    const rawTiers = inputs.taxableTiers;
    const shareTotal = rawTiers.reduce((s, t) => s + Math.max(0, t.sharePct), 0);
    for (const t of rawTiers) {
      const basisPctClampedTier = Math.min(100, Math.max(0, t.basisPct));
      if (basisPctClampedTier >= 100) {
        const share = shareTotal > 0 ? Math.max(0, t.sharePct) / shareTotal : 0;
        return Math.max(0, inputs.taxableStart * share);
      }
    }
    return 0;
  }
  return Math.min(Math.max(0, inputs.spendFromCashSleeveStart ?? 0), Math.max(0, inputs.taxableStart));
}
function acaEmbeddedNetPremiumFor(inputs) {
  const spouseAcaEndAge = inputs.acaSpouseEndAge ?? 65;
  const survOn = inputs.survivorEnabled === true && inputs.survivorDeathYear != null;
  const survWho = inputs.survivorWho ?? "primary";
  const survDeathYear = survOn ? inputs.survivorDeathYear : null;
  const retirementYear = inputs.birthYearPrimary + inputs.retirementAge;
  for (let year = inputs.startYear;year - inputs.birthYearPrimary <= inputs.endAgePrimary; year++) {
    const age = year - inputs.birthYearPrimary;
    const spouseAge = inputs.birthYearSpouse != null ? year - inputs.birthYearSpouse : null;
    const isSurvivorYear = survOn && survDeathYear != null && year > survDeathYear;
    const inAcaScope = year >= retirementYear;
    const primaryOnAca = inAcaScope && age < 65 && !(isSurvivorYear && survWho === "primary");
    const spouseOnAca = inAcaScope && spouseAge != null && spouseAge < spouseAcaEndAge && !(isSurvivorYear && survWho === "spouse");
    const acaActive = primaryOnAca || spouseOnAca;
    if (!acaActive)
      continue;
    const householdSize = isSurvivorYear ? 1 : acaHouseholdSizeForYear(inputs.acaHouseholdSize, inputs.acaHouseholdSchedule, year);
    const benchmark = primaryOnAca && spouseOnAca ? householdSize >= 3 && inputs.acaBenchmarkFamily != null ? inputs.acaBenchmarkFamily : inputs.acaBenchmarkCouple : inputs.acaBenchmarkSingle;
    if (benchmark == null)
      continue;
    const cliff = 4 * fplFor(householdSize, year - 1);
    const credit = acaCreditFor({
      magi: cliff,
      householdSize,
      coverageYear: year,
      benchmarkAnnual: benchmark,
      projected: true
    }).credit;
    return r2(Math.max(0, benchmark - credit));
  }
  return null;
}
function simulateRothPlan(inputs, strategy, returnSeriesPct, opts) {
  const leanDetail = opts?.leanDetail === true;
  const years = [];
  let pretaxP = inputs.pretaxStart;
  let pretaxS = inputs.pretaxSpouseStart ?? 0;
  const survOn = inputs.survivorEnabled === true && inputs.survivorDeathYear != null;
  const survWho = inputs.survivorWho ?? "primary";
  const survDeathYear = survOn ? inputs.survivorDeathYear : null;
  let survCombined = false;
  let roth = inputs.rothStart;
  let taxable = inputs.taxableStart;
  let hsa = inputs.hsaStart;
  const lookbackByYear = new Map;
  for (const seed of inputs.irmaaLookbackSeed ?? []) {
    lookbackByYear.set(seed.year, {
      year: seed.year,
      magi: seed.magi,
      filingStatus: seed.filingStatus
    });
  }
  const premiumEmbeddedDollars = inputs.acaEmbeddedNetPremium != null && Number.isFinite(inputs.acaEmbeddedNetPremium) ? Math.max(0, inputs.acaEmbeddedNetPremium) : null;
  const healthAcaHouseholdDollars = inputs.healthPremiumAcaHousehold != null && Number.isFinite(inputs.healthPremiumAcaHousehold) ? Math.max(0, inputs.healthPremiumAcaHousehold) : null;
  const healthAcaSingleDollars = inputs.healthPremiumAcaSingle != null && Number.isFinite(inputs.healthPremiumAcaSingle) ? Math.max(0, inputs.healthPremiumAcaSingle) : null;
  const healthMedicarePerPersonDollars = inputs.healthPremiumMedicarePerPerson != null && Number.isFinite(inputs.healthPremiumMedicarePerPerson) ? Math.max(0, inputs.healthPremiumMedicarePerPerson) : null;
  const healthActive = healthAcaHouseholdDollars != null || healthAcaSingleDollars != null || healthMedicarePerPersonDollars != null;
  const growth = Math.max(0, 1 + inputs.expectedReturnPct / 100);
  const gainPct = Math.min(100, Math.max(0, 100 - inputs.taxableBasisPct)) / 100;
  const driftOn = inputs.taxableBasisBlank !== true;
  const harvestOn = strategy.gainsHarvest === true && inputs.taxableBasisBlank !== true;
  const spouseAcaEndAge = inputs.acaSpouseEndAge ?? 65;
  const basisPctClamped = Math.min(100, Math.max(0, inputs.taxableBasisPct)) / 100;
  let taxableBasisDollars = basisPctClamped * inputs.taxableStart;
  const tiersActive = driftOn && Array.isArray(inputs.taxableTiers) && inputs.taxableTiers.length > 0;
  let tierState = null;
  if (tiersActive) {
    const rawTiers = inputs.taxableTiers;
    const shareTotal = rawTiers.reduce((s, t) => s + Math.max(0, t.sharePct), 0);
    let cashTierClaimed = false;
    tierState = rawTiers.map((t) => {
      const share = shareTotal > 0 ? Math.max(0, t.sharePct) / shareTotal : 0;
      const bal = inputs.taxableStart * share;
      const basisPctClampedTier = Math.min(100, Math.max(0, t.basisPct));
      const basis = bal * (basisPctClampedTier / 100);
      const cash = !cashTierClaimed && basisPctClampedTier >= 100;
      if (cash)
        cashTierClaimed = true;
      return { bal, basis, inflow: false, cash };
    });
    taxableBasisDollars = tierState.reduce((s, t) => s + t.basis, 0);
  }
  const spendCashPctRaw = inputs.spendFromCashPct ?? null;
  const spendCashPct = spendCashPctRaw == null ? 0 : Math.min(100, Math.max(0, spendCashPctRaw));
  const cashTierIndex = tierState != null ? tierState.findIndex((t) => t.cash === true) : -1;
  let sleeveDollars = deriveSpendFromCashSleeveStartDollars(inputs);
  let lifetimeFederalTax = 0;
  let lifetimeStateTax = 0;
  let lifetimePenalty = 0;
  let lifetimeIrmaa = 0;
  let lifetimeAcaKept = 0;
  let lifetimeEducationRefundable = 0;
  let pendingEduRefund = 0;
  let lifetimeAmt = 0;
  let lifetimeSsCollected = 0;
  let lifetimeUnpaidTax = 0;
  let lifetimeHealthPremiumGross = 0;
  let lifetimeHealthPremiumNet = 0;
  let lossCarrySt = Math.max(0, inputs.capitalLossCarryInSt ?? 0);
  let lossCarryLt = Math.max(0, inputs.capitalLossCarryInLt ?? 0);
  let lossCarryWaSt = Math.min(lossCarrySt, Math.max(0, inputs.capitalLossCarryInStWa ?? 0));
  let lossCarryWaLt = Math.min(lossCarryLt, Math.max(0, inputs.capitalLossCarryInLtWa ?? 0));
  let giftOutflowApplied = false;
  let acaBunchCounter = 0;
  let priorYearReturnPct = null;
  for (let year = inputs.startYear;year - inputs.birthYearPrimary <= inputs.endAgePrimary; year++) {
    const age = year - inputs.birthYearPrimary;
    const spouseAge = inputs.birthYearSpouse != null ? year - inputs.birthYearSpouse : null;
    const yearDrawOrder = effectiveDrawOrder(inputs, age);
    const isDeathYear = survOn && year === survDeathYear;
    const isSurvivorYear = survOn && survDeathYear != null && year > survDeathYear;
    if (survOn && survDeathYear != null && year > survDeathYear && !survCombined) {
      if (survWho === "primary") {
        pretaxS += pretaxP;
        pretaxP = 0;
      } else {
        pretaxP += pretaxS;
        pretaxS = 0;
      }
      survCombined = true;
    }
    const effFilingStatus = isSurvivorYear ? "single" : inputs.filingStatus;
    const survivorAge = survWho === "primary" ? spouseAge : age;
    const survivorBirthYear = survWho === "primary" ? inputs.birthYearSpouse : inputs.birthYearPrimary;
    const priceAgePrimary = isSurvivorYear ? survivorAge ?? age : age;
    const priceAgeSpouse = isSurvivorYear ? null : spouseAge;
    const carryInSt = lossCarrySt;
    const carryInLt = lossCarryLt;
    const carryInWaSt = lossCarryWaSt;
    const carryInWaLt = lossCarryWaLt;
    const ledgerOn = carryInSt > 0 || carryInLt > 0;
    const ledgerFields = (grossGains) => {
      if (!ledgerOn) {
        return {
          ltcg: grossGains,
          capitalLossAllowance: Math.min(capitalLossAllowanceCap(effFilingStatus), Math.max(0, -grossGains))
        };
      }
      const led = applyLossLedger({ st: carryInSt, lt: carryInLt }, grossGains, effFilingStatus, Number.POSITIVE_INFINITY, { st: carryInWaSt, lt: carryInWaLt });
      return {
        ltcg: led.netResult,
        capitalLossAllowance: led.allowance,
        waGainsBase: r2(grossGains - led.waAbsorbedByGains)
      };
    };
    const priorP = pretaxP;
    const priorS = pretaxS;
    const priorPretaxBalance = priorP + priorS;
    let rmdP = 0;
    let rmdS = 0;
    let divisorP = null;
    let divisorS = null;
    let tableP = null;
    let tableS = null;
    if (survCombined) {
      const combinedPrior = survWho === "primary" ? priorS : priorP;
      const u = survivorAge != null && survivorBirthYear != null ? uniformRmdFor({
        priorDec31PreTax: combinedPrior,
        age: survivorAge,
        birthYear: survivorBirthYear
      }) : { rmd: 0, divisor: null };
      if (survWho === "primary") {
        rmdS = u.rmd;
        divisorS = u.divisor;
        tableS = u.divisor != null ? "uniform" : null;
      } else {
        rmdP = u.rmd;
        divisorP = u.divisor;
        tableP = u.divisor != null ? "uniform" : null;
      }
    } else {
      const rp = rmdForYear({
        priorDec31PreTax: priorP,
        agePrimary: age,
        ageSpouse: spouseAge,
        birthYearPrimary: inputs.birthYearPrimary,
        spouseSoleBeneficiary: inputs.spouseSoleBeneficiary
      });
      rmdP = rp.rmd;
      divisorP = rp.divisor;
      tableP = rp.table;
      if (spouseAge != null && inputs.birthYearSpouse != null) {
        const rs = rmdForYear({
          priorDec31PreTax: priorS,
          agePrimary: spouseAge,
          ageSpouse: age,
          birthYearPrimary: inputs.birthYearSpouse,
          spouseSoleBeneficiary: inputs.primarySoleBeneficiaryOfSpouse === true
        });
        rmdS = rs.rmd;
        divisorS = rs.divisor;
        tableS = rs.table;
      }
    }
    const rmd = r2(rmdP + rmdS);
    const rmdDivisor = divisorP ?? divisorS;
    const rmdTable = tableP ?? tableS;
    const pretaxPAfterRmd = Math.max(0, pretaxP - rmdP);
    const pretaxSAfterRmd = Math.max(0, pretaxS - rmdS);
    const pretaxAfterRmd = pretaxPAfterRmd + pretaxSAfterRmd;
    const ssPrimaryThisYear = inputs.ssPrimaryStartAge != null && age >= inputs.ssPrimaryStartAge ? effectiveSsPrimaryAnnual(inputs) : 0;
    const ssSpouseThisYear = inputs.ssSpouseStartAge != null && spouseAge != null && spouseAge >= inputs.ssSpouseStartAge ? effectiveSsSpouseAnnual(inputs) : 0;
    const ssBenefits = isSurvivorYear ? Math.max(ssPrimaryThisYear, ssSpouseThisYear) : ssPrimaryThisYear + ssSpouseThisYear;
    const retirementYear = inputs.birthYearPrimary + inputs.retirementAge;
    const inAcaScope = year >= retirementYear;
    const primaryOnAca = inAcaScope && age < 65 && !(isSurvivorYear && survWho === "primary");
    const spouseOnAca = inAcaScope && spouseAge != null && spouseAge < spouseAcaEndAge && !(isSurvivorYear && survWho === "spouse");
    const acaActive = primaryOnAca || spouseOnAca;
    const householdSize = isSurvivorYear ? 1 : acaHouseholdSizeForYear(inputs.acaHouseholdSize, inputs.acaHouseholdSchedule, year);
    const benchmark = primaryOnAca && spouseOnAca ? householdSize >= 3 && inputs.acaBenchmarkFamily != null ? inputs.acaBenchmarkFamily : inputs.acaBenchmarkCouple : acaActive ? inputs.acaBenchmarkSingle : null;
    const acaCliffDollars = acaActive ? 4 * fplFor(householdSize, year - 1) : null;
    const premiumReconcile = !healthActive && premiumEmbeddedDollars != null && acaActive && benchmark != null;
    const healthGrossAca = !healthActive ? 0 : !acaActive ? 0 : primaryOnAca && spouseOnAca ? healthAcaHouseholdDollars ?? benchmark ?? 0 : healthAcaSingleDollars ?? benchmark ?? 0;
    const healthAcaThisYear = healthActive && acaActive && healthGrossAca > 0;
    const healthAcaCapThisYear = healthActive && acaActive;
    const premiumInitialCredit = premiumReconcile ? Math.min(Math.max(0, benchmark - premiumEmbeddedDollars), benchmark) : 0;
    const forceZeroConversion = opts?.forceZeroConversionYear != null && year === opts.forceZeroConversionYear;
    const already = year === inputs.startYear && !forceZeroConversion ? Math.max(0, inputs.convertedAlreadyThisYear) : 0;
    const inWindow = age >= inputs.windowStartAge && age <= inputs.windowStopAge;
    let yearCeilings = strategy.ceilings;
    let bunchZero = false;
    if (strategy.ceilings && strategy.bunching && acaActive && inWindow) {
      if (acaBunchCounter % 2 === 1) {
        bunchZero = true;
      } else {
        yearCeilings = { ...strategy.ceilings, acaCliffCap: false };
      }
      acaBunchCounter++;
    }
    let eraCliffOff = false;
    const firstStepYear = acaFirstStepYear(inputs.acaHouseholdSchedule);
    if (yearCeilings?.acaCliffCap === true && yearCeilings.acaCliffCapFamilyOnly === true && firstStepYear != null && year >= firstStepYear) {
      eraCliffOff = true;
      yearCeilings = { ...yearCeilings, acaCliffCap: false };
    }
    const eraZeroFill = eraCliffOff && yearCeilings != null && !ceilingsActive(yearCeilings);
    const acaTargetDollars = acaCliffDollars != null ? Math.max(0, acaCliffDollars - (yearCeilings?.acaCliffCap === true ? Math.max(0, yearCeilings.acaCliffBuffer ?? 0) : 0)) : null;
    const guardrailTargetPct = strategy.guardrail && yearCeilings?.bracketTopPct != null ? yearCeilings.bracketTopPct : null;
    if (pendingEduRefund > 0) {
      taxable += pendingEduRefund;
      if (driftOn) {
        if (tiersActive && tierState) {
          buyIntoTiers(tierState, pendingEduRefund);
          taxableBasisDollars = tierState.reduce((s, t) => s + t.basis, 0);
        } else {
          taxableBasisDollars += pendingEduRefund;
        }
      }
      pendingEduRefund = 0;
    }
    if (!giftOutflowApplied && inputs.giftOutflowAge != null && (inputs.giftOutflowAmount ?? 0) > 0 && age >= inputs.giftOutflowAge) {
      if (driftOn && taxable > 0) {
        const removed = taxable - Math.max(0, taxable - (inputs.giftOutflowAmount ?? 0));
        if (inputs.giftOutflowBasis != null) {
          const parcelBasis = Math.min(Math.max(inputs.giftOutflowBasis, 0), taxableBasisDollars);
          if (tiersActive && tierState) {
            const frac = removed / taxable;
            for (const t of tierState) {
              t.bal -= t.bal * frac;
            }
            let removedBasis = 0;
            for (const t of tierState) {
              const forced = Math.max(0, t.basis - t.bal);
              if (forced > 0) {
                t.basis -= forced;
                removedBasis += forced;
              }
            }
            let remaining = parcelBasis - removedBasis;
            while (remaining > 0.000000001) {
              const totalBasis = tierState.reduce((s, t) => s + t.basis, 0);
              if (totalBasis <= 0)
                break;
              let progressed = false;
              for (const t of tierState) {
                if (remaining <= 0.000000001)
                  break;
                if (t.basis <= 0)
                  continue;
                const take = Math.min(remaining * t.basis / totalBasis, t.basis);
                if (take > 0) {
                  t.basis -= take;
                  remaining -= take;
                  progressed = true;
                }
              }
              if (!progressed)
                break;
            }
            taxableBasisDollars = tierState.reduce((s, t) => s + t.basis, 0);
          } else {
            taxableBasisDollars = Math.max(0, taxableBasisDollars - parcelBasis);
          }
        } else if (tiersActive && tierState) {
          const frac = removed / taxable;
          for (const t of tierState) {
            t.bal -= t.bal * frac;
            t.basis = Math.max(0, t.basis - t.basis * frac);
          }
          taxableBasisDollars = tierState.reduce((s, t) => s + t.basis, 0);
        } else {
          taxableBasisDollars = Math.max(0, taxableBasisDollars - removed * (taxableBasisDollars / taxable));
        }
      }
      if (spendCashPct > 0 && sleeveDollars > 0) {
        if (tierState != null && cashTierIndex >= 0) {
          sleeveDollars = Math.max(0, tierState[cashTierIndex].bal);
        } else if (taxable > 0) {
          const removedGift = taxable - Math.max(0, taxable - (inputs.giftOutflowAmount ?? 0));
          sleeveDollars = Math.max(0, sleeveDollars - Math.max(0, removedGift - Math.max(0, taxable - sleeveDollars)));
        }
      }
      taxable = Math.max(0, taxable - (inputs.giftOutflowAmount ?? 0));
      giftOutflowApplied = true;
    }
    const divYieldPct = Math.max(0, inputs.taxableDividendYieldPct ?? 0);
    const intYieldPct = Math.max(0, inputs.taxableInterestYieldPct ?? 0);
    const dividendIncome = divYieldPct > 0 ? r2(taxable * divYieldPct / 100) : 0;
    const interestIncome = intYieldPct > 0 ? r2(taxable * intYieldPct / 100) : 0;
    const yieldTotal = dividendIncome + interestIncome;
    const dividendQualifiedPct = Math.min(100, Math.max(0, inputs.taxableDividendQualifiedPct ?? 100));
    const qualifiedDividendIncome = r2(dividendIncome * dividendQualifiedPct / 100);
    const nonQualifiedDividendIncome = r2(dividendIncome - qualifiedDividendIncome);
    const injectedLtcg = inputs.saleGainAge != null && age === inputs.saleGainAge ? Math.max(0, inputs.saleGainAmount ?? 0) : 0;
    if (driftOn && injectedLtcg > 0 && taxable > 0) {
      if (tiersActive && tierState) {
        stepUpTiers(tierState, injectedLtcg);
        taxableBasisDollars = tierState.reduce((s, t) => s + t.basis, 0);
      } else {
        taxableBasisDollars = Math.min(Math.max(0, taxable), taxableBasisDollars + injectedLtcg);
      }
    }
    const eduStudentsYear = (inputs.educationStudents ?? []).filter((e) => e.year === year);
    const fillBase = {
      calendarYear: year,
      filingStatus: effFilingStatus,
      agePrimary: priceAgePrimary,
      ageSpouse: priceAgeSpouse,
      otherOrdinary: inputs.otherOrdinaryAnnual,
      rmd,
      conversion: 0,
      extraPreTaxDraw: 0,
      ssBenefits,
      taxExemptInterest: inputs.taxExemptInterestAnnual,
      ...ledgerFields(injectedLtcg),
      interestIncome,
      qualifiedDividends: qualifiedDividendIncome,
      ordinaryDividends: nonQualifiedDividendIncome,
      inflationPct: inputs.inflationPct,
      stateRatePct: inputs.stateRatePct,
      residenceState: inputs.residenceState ?? null,
      itemizedMortgageInterest: inputs.itemizedMortgageInterest,
      itemizedSaltPaid: inputs.itemizedSaltPaid,
      itemizedCharitable: inputs.itemizedCharitable,
      itemizedOther: inputs.itemizedOther,
      educationStudents: eduStudentsYear
    };
    const preserveFloor = Math.max(0, inputs.preservePretax ?? 0);
    const preserveRoom = preserveFloor > 0 ? Math.max(0, pretaxAfterRmd - preserveFloor) : Infinity;
    let additional = 0;
    if (yearCeilings && inWindow && pretaxAfterRmd > 0 && !bunchZero && !eraZeroFill && !forceZeroConversion) {
      const target = fillConversion({
        base: fillBase,
        ceilings: yearCeilings,
        maxConversion: pretaxAfterRmd + already,
        acaCliff: acaCliffDollars,
        guardrailTargetPct
      });
      additional = Math.max(0, Math.min(target - already, pretaxAfterRmd, preserveRoom));
    }
    let conversion = already + additional;
    const personsOnMedicare = isSurvivorYear ? survivorAge != null && survivorAge >= (survWho === "primary" ? spouseAcaEndAge : 65) ? 1 : 0 : (age >= 65 ? 1 : 0) + (spouseAge != null && spouseAge >= spouseAcaEndAge ? 1 : 0);
    const healthMedicarePremium = healthMedicarePerPersonDollars != null ? r2(healthMedicarePerPersonDollars * personsOnMedicare) : 0;
    const healthGrossYear = r2(healthGrossAca + healthMedicarePremium);
    let irmaaPaid = 0;
    let irmaaPaidTier = null;
    const lookbackEntry = lookbackByYear.get(year - 2);
    if (personsOnMedicare > 0 && lookbackEntry != null) {
      const law = lawForYear(year);
      const tier = irmaaTierFor(lookbackEntry.magi, lookbackEntry.filingStatus, law, year, inputs.inflationPct);
      irmaaPaidTier = tier;
      irmaaPaid = r2(irmaaAnnualPerPerson(tier, law) * personsOnMedicare);
    }
    const priceWith = (ltcg, extra, conv) => priceYear({
      calendarYear: year,
      filingStatus: effFilingStatus,
      agePrimary: priceAgePrimary,
      ageSpouse: priceAgeSpouse,
      otherOrdinary: inputs.otherOrdinaryAnnual,
      rmd,
      conversion: conv,
      extraPreTaxDraw: extra,
      ssBenefits,
      taxExemptInterest: inputs.taxExemptInterestAnnual,
      ...ledgerFields(ltcg + injectedLtcg),
      interestIncome,
      qualifiedDividends: qualifiedDividendIncome,
      ordinaryDividends: nonQualifiedDividendIncome,
      inflationPct: inputs.inflationPct,
      stateRatePct: inputs.stateRatePct,
      residenceState: inputs.residenceState ?? null,
      itemizedMortgageInterest: inputs.itemizedMortgageInterest,
      itemizedSaltPaid: inputs.itemizedSaltPaid,
      itemizedCharitable: inputs.itemizedCharitable,
      itemizedOther: inputs.itemizedOther,
      educationStudents: eduStudentsYear
    });
    const basisYearStart = taxableBasisDollars;
    const spendNeedBase = age >= inputs.retirementAge ? inputs.annualSpending : 0;
    const retiredYear = age >= inputs.retirementAge;
    const spendNeedYear = flexSpendingNeed(spendNeedBase, priorYearReturnPct, inputs.flexCutPct, inputs.flexFloorPct);
    const settleRound = (additionalArg, pretaxDrawCapArg, fbGainsIn, fbPretaxIn, fbCreditIn) => {
      const conv = already + additionalArg;
      const startRatio = taxable > 0 ? basisYearStart / taxable : 0;
      const drawGainRate = driftOn ? 1 - startRatio : gainPct;
      let priced = priceWith(fbGainsIn, fbPretaxIn, conv);
      let federalTax = priced.federalTax;
      let stateTax = priced.stateTax;
      const spendNeed = premiumReconcile ? Math.max(0, r2(spendNeedYear - premiumEmbeddedDollars + Math.max(0, benchmark - fbCreditIn))) : healthActive && retiredYear ? r2(spendNeedYear + healthMedicarePremium + (healthAcaThisYear ? Math.max(0, healthGrossAca - Math.min(fbCreditIn, healthGrossAca)) : 0)) : spendNeedYear;
      const cashIn = rmd + ssBenefits + inputs.otherOrdinaryAnnual + inputs.taxExemptInterestAnnual;
      const surplusCash = Math.max(0, cashIn - spendNeed);
      let spendDeficit = Math.max(0, spendNeed - cashIn);
      const taxDue = federalTax + stateTax + irmaaPaid;
      const taxFromCash = Math.min(taxDue, surplusCash);
      let taxRemaining = taxDue - taxFromCash;
      let fromTaxable = 0;
      let withheld = 0;
      if (taxRemaining > 0) {
        if (inputs.payTaxFrom === "taxable") {
          fromTaxable = Math.min(taxRemaining, Math.max(0, taxable - inputs.protectMinTaxable));
          withheld = taxRemaining - fromTaxable;
        } else {
          withheld = taxRemaining;
        }
      }
      let penalty = 0;
      let overflowTax = 0;
      let withheldFromConversion = withheld;
      const convOwnerAge = survCombined ? survivorAge ?? age : age;
      if (withheld > 0 && convOwnerAge < 59.5) {
        const grossedPenalty = r2(withheld / 9);
        const grossedTotal = withheld + grossedPenalty;
        if (grossedTotal <= additionalArg + 0.005) {
          penalty = grossedPenalty;
          withheldFromConversion = grossedTotal;
        } else if (additionalArg > 0) {
          penalty = r2(additionalArg * 0.1);
          withheldFromConversion = additionalArg;
          overflowTax = r2(withheld - (additionalArg - penalty));
        } else {
          withheldFromConversion = 0;
          overflowTax = withheld;
        }
      } else {
        overflowTax = Math.max(0, withheld - additionalArg);
        withheldFromConversion = Math.min(withheld, additionalArg);
      }
      const rothIn = Math.max(0, additionalArg - withheldFromConversion);
      let pretaxBalP = pretaxPAfterRmd;
      let pretaxBalS = pretaxSAfterRmd;
      {
        const fromP = Math.min(additionalArg, Math.max(0, pretaxBalP));
        pretaxBalP -= fromP;
        pretaxBalS -= additionalArg - fromP;
      }
      let rothBal = roth + rothIn;
      let taxableBal = taxable - fromTaxable;
      let fundTaxTaxable = fromTaxable;
      let fundTaxPretax = withheldFromConversion;
      let fundTaxRoth = 0;
      let fundSpendTaxable = 0;
      let fundSpendRoth = 0;
      let createdFbGains = 0;
      let createdFbPretax = 0;
      let basisBal = basisYearStart;
      let sTiers = null;
      let pricedGains = 0;
      if (tiersActive && tierState) {
        sTiers = tierState.map((t) => ({ ...t }));
      }
      let sleeveBal = sleeveDollars;
      let cashSpendAmt = 0;
      const sleeveDebit = (amount, poolBefore) => {
        if (spendCashPct <= 0 || amount <= 0 || sleeveBal <= 0)
          return;
        if (sTiers && cashTierIndex >= 0) {
          sleeveBal = Math.max(0, sTiers[cashTierIndex].bal);
        } else {
          const nonCash = Math.max(0, poolBefore - sleeveBal);
          sleeveBal = Math.max(0, sleeveBal - Math.max(0, amount - nonCash));
        }
      };
      if (driftOn && fromTaxable > 0) {
        if (sTiers) {
          pricedGains += sellFromTiers(sTiers, fromTaxable, "highest");
        } else {
          basisBal = Math.max(0, basisBal - fromTaxable * startRatio);
        }
      }
      if (fromTaxable > 0)
        sleeveDebit(fromTaxable, taxable);
      const basisOut = (amount, priced = false) => {
        if (amount <= 0)
          return 0;
        if (!driftOn) {
          sleeveDebit(amount, taxableBal);
          return r2(amount * drawGainRate);
        }
        if (sTiers) {
          const g = sellFromTiers(sTiers, amount, "highest");
          if (priced)
            pricedGains += g;
          sleeveDebit(amount, taxableBal);
          return g;
        }
        if (taxableBal <= 0) {
          basisBal = 0;
          sleeveDebit(amount, taxableBal);
          return r2(amount * drawGainRate);
        }
        basisBal = Math.max(0, basisBal - amount * (basisBal / taxableBal));
        sleeveDebit(amount, taxableBal);
        return r2(amount * drawGainRate);
      };
      const basisIn = (amount) => {
        if (!driftOn || amount <= 0)
          return;
        if (sTiers) {
          buyIntoTiers(sTiers, amount);
          return;
        }
        basisBal += amount;
      };
      let unpaidTaxAmt = 0;
      const debitUnpaid = (amount) => {
        let rest = amount;
        const fromT = Math.min(rest, Math.max(0, taxableBal));
        createdFbGains += basisOut(fromT);
        taxableBal -= fromT;
        rest -= fromT;
        fundTaxTaxable += fromT;
        const fromP = Math.min(rest, Math.max(0, pretaxBalP));
        pretaxBalP -= fromP;
        rest -= fromP;
        const fromS = Math.min(rest, Math.max(0, pretaxBalS));
        pretaxBalS -= fromS;
        rest -= fromS;
        fundTaxPretax += fromP + fromS;
        createdFbPretax += fromP + fromS;
        if (rest > 0) {
          const fromR = Math.min(rest, Math.max(0, rothBal));
          rothBal = Math.max(0, rothBal - rest);
          fundTaxRoth += fromR;
          rest -= fromR;
        }
        return Math.max(0, rest);
      };
      const unpayable = overflowTax;
      if (unpayable > 0)
        unpaidTaxAmt += debitUnpaid(unpayable);
      if (spendCashPct > 0 && spendDeficit > 0 && sleeveBal > 0) {
        const want = spendNeed * spendCashPct / 100;
        let take = Math.min(want, spendDeficit, sleeveBal, Math.max(0, taxableBal));
        if (take > 0) {
          if (sTiers && cashTierIndex >= 0) {
            const t = sTiers[cashTierIndex];
            take = Math.min(take, Math.max(0, t.bal));
            t.bal -= take;
            t.basis = Math.max(0, t.basis - take);
            sleeveBal = Math.max(0, t.bal);
          } else {
            if (driftOn)
              basisBal = Math.max(0, basisBal - take);
            sleeveBal = Math.max(0, sleeveBal - take);
          }
          if (take > 0) {
            taxableBal -= take;
            spendDeficit -= take;
            cashSpendAmt = take;
          }
        }
      }
      const cliffCapOnDraws = yearCeilings?.acaCliffCap === true && acaCliffDollars != null;
      let taxableDrawn = fromTaxable;
      let extraDraw = 0;
      for (const bucket of yearDrawOrder) {
        if (spendDeficit <= 0)
          break;
        if (bucket === "taxable") {
          const drawT = Math.min(Math.max(0, taxableBal), spendDeficit);
          basisOut(drawT, true);
          taxableBal -= drawT;
          taxableDrawn += drawT;
          fundSpendTaxable += drawT;
          spendDeficit -= drawT;
        } else if (bucket === "pretax") {
          const balanceAvail = Math.max(0, pretaxBalP) + Math.max(0, pretaxBalS);
          if (cliffCapOnDraws || pretaxDrawCapArg != null) {
            let drawCap = Infinity;
            if (cliffCapOnDraws) {
              const gainsSoFar = (sTiers ? r2(pricedGains) : r2(taxableDrawn * drawGainRate)) + fbGainsIn;
              const baseAcaMagi = priceWith(gainsSoFar, fbPretaxIn, 0).acaMagi;
              drawCap = Math.max(0, acaTargetDollars - baseAcaMagi);
            }
            if (pretaxDrawCapArg != null) {
              drawCap = Math.min(drawCap, pretaxDrawCapArg);
            }
            extraDraw = Math.min(balanceAvail, spendDeficit, drawCap);
          } else {
            extraDraw = Math.min(balanceAvail, spendDeficit);
          }
          const fromP = Math.min(extraDraw, Math.max(0, pretaxBalP));
          pretaxBalP -= fromP;
          pretaxBalS -= extraDraw - fromP;
          spendDeficit -= extraDraw;
        } else {
          const drawR = Math.min(Math.max(0, rothBal), spendDeficit);
          rothBal -= drawR;
          fundSpendRoth += drawR;
          spendDeficit -= drawR;
        }
      }
      const realizedGains = sTiers ? r2(pricedGains) : r2(taxableDrawn * drawGainRate);
      const pricedGainsTotal = realizedGains + fbGainsIn;
      const pricedExtraTotal = extraDraw + fbPretaxIn;
      if (pricedGainsTotal !== 0 || pricedExtraTotal > 0) {
        const repriced = priceWith(pricedGainsTotal, pricedExtraTotal, conv);
        const delta = r2(repriced.federalTax + repriced.stateTax - (federalTax + stateTax));
        priced = repriced;
        federalTax = repriced.federalTax;
        stateTax = repriced.stateTax;
        if (delta > 0) {
          const pay = Math.min(delta, Math.max(0, taxableBal));
          createdFbGains += basisOut(pay);
          taxableBal -= pay;
          fundTaxTaxable += pay;
          const rest = delta - pay;
          if (rest > 0)
            unpaidTaxAmt += debitUnpaid(rest);
        } else if (delta < 0) {
          taxableBal += -delta;
          basisIn(-delta);
          fundTaxTaxable += delta;
        }
      }
      const surplusLeft = surplusCash - taxFromCash;
      if (surplusLeft > 0) {
        taxableBal += surplusLeft;
        basisIn(surplusLeft);
      }
      if (yieldTotal > 0) {
        if (sTiers) {
          reinvestYieldIntoTiers(sTiers, yieldTotal);
        } else {
          basisIn(yieldTotal);
        }
      }
      const createdFbCredit = (premiumReconcile || healthAcaThisYear) && benchmark != null ? acaCreditFor({
        magi: priced.acaMagi,
        householdSize,
        coverageYear: year,
        benchmarkAnnual: benchmark,
        projected: true
      }).credit : 0;
      return {
        priced,
        federalTax,
        stateTax,
        penalty,
        feedbackCredit: fbCreditIn,
        createdFbCredit: r2(createdFbCredit),
        realizedGains: r2(realizedGains + fbGainsIn),
        feedbackGains: fbGainsIn,
        feedbackPretax: fbPretaxIn,
        createdFbGains: r2(createdFbGains),
        createdFbPretax: r2(createdFbPretax),
        taxableDrawn,
        taxableBasisEnd: sTiers ? sTiers.reduce((s, t) => s + t.basis, 0) : basisBal,
        tierEnd: sTiers,
        extraDraw,
        pretaxBalP,
        pretaxBalS,
        rothBal,
        taxableBal,
        spendNeed,
        spendDeficit: r2(spendDeficit),
        unpaidTax: r2(unpaidTaxAmt),
        taxFromCash,
        fundTaxTaxable,
        fundTaxPretax,
        fundTaxRoth,
        fundSpendTaxable,
        fundSpendRoth,
        cashSpend: cashSpendAmt,
        sleeveEnd: sleeveBal
      };
    };
    const SETTLEMENT_MAX_ROUNDS = 100;
    const settleYearOnce = (additionalArg, pretaxDrawCapArg, fbCreditIn) => {
      let fbGains = 0;
      let fbPretax = 0;
      let best = null;
      let bestMismatch = Infinity;
      let bestConverged = false;
      let bestMismatchGainsCents = 0;
      let bestMismatchPretaxCents = 0;
      const seenAssumed = new Set;
      for (let round = 0;round < SETTLEMENT_MAX_ROUNDS; round++) {
        const key = `${r2(fbGains)}|${r2(fbPretax)}`;
        if (seenAssumed.has(key))
          break;
        seenAssumed.add(key);
        const s = settleRound(additionalArg, pretaxDrawCapArg, fbGains, fbPretax, fbCreditIn);
        const mismatchGains = Math.abs(s.createdFbGains - fbGains);
        const mismatchPretax = Math.abs(s.createdFbPretax - fbPretax);
        const mismatch = mismatchGains + mismatchPretax;
        if (s.createdFbGains === r2(fbGains) && s.createdFbPretax === r2(fbPretax)) {
          best = s;
          bestConverged = true;
          bestMismatchGainsCents = 0;
          bestMismatchPretaxCents = 0;
          break;
        }
        if (mismatch < bestMismatch) {
          bestMismatch = mismatch;
          best = s;
          bestMismatchGainsCents = Math.round(mismatchGains * 100);
          bestMismatchPretaxCents = Math.round(mismatchPretax * 100);
        }
        fbGains = s.createdFbGains;
        fbPretax = s.createdFbPretax;
      }
      const kept = best ?? settleRound(additionalArg, pretaxDrawCapArg, 0, 0, fbCreditIn);
      return {
        ...kept,
        settlementConverged: best != null ? bestConverged : kept.createdFbGains === 0 && kept.createdFbPretax === 0,
        settlementMismatchCents: best != null ? { gains: bestMismatchGainsCents, pretax: bestMismatchPretaxCents } : {
          gains: Math.round(Math.abs(kept.createdFbGains) * 100),
          pretax: Math.round(Math.abs(kept.createdFbPretax) * 100)
        }
      };
    };
    const settleYear = (additionalArg, pretaxDrawCapArg) => {
      if (!premiumReconcile && !healthAcaThisYear) {
        return settleYearOnce(additionalArg, pretaxDrawCapArg, 0);
      }
      let assumed = premiumReconcile ? premiumInitialCredit : 0;
      let best = null;
      let bestCreditDiff = Infinity;
      const seenCredits = new Set;
      for (let pass = 0;pass < 8; pass++) {
        if (seenCredits.has(assumed))
          break;
        seenCredits.add(assumed);
        const s = settleYearOnce(additionalArg, pretaxDrawCapArg, assumed);
        const diff = Math.abs(s.createdFbCredit - assumed);
        if (s.createdFbCredit === r2(assumed)) {
          return s;
        }
        if (diff < bestCreditDiff) {
          bestCreditDiff = diff;
          best = s;
        }
        assumed = s.createdFbCredit;
      }
      const kept = best ?? settleYearOnce(additionalArg, pretaxDrawCapArg, premiumReconcile ? premiumInitialCredit : 0);
      return { ...kept, settlementConverged: false };
    };
    const respectsCeilings = (p) => {
      const ceilings = yearCeilings;
      if (!ceilings)
        return true;
      const law = lawForYear(year);
      const fs = effFilingStatus;
      let taxableCap = Infinity;
      if (ceilings.bracketTopPct != null) {
        const idx = law.rates.indexOf(ceilings.bracketTopPct);
        if (idx >= 0) {
          taxableCap = Math.min(taxableCap, law.brackets[fs][idx] ?? Infinity);
        }
      }
      if (ceilings.ltcgZeroCap) {
        taxableCap = Math.min(taxableCap, law.ltcgZeroTop[fs]);
      }
      let magiCap = Infinity;
      if (ceilings.irmaaTierCap != null) {
        magiCap = Math.min(magiCap, irmaaTierUpTo(ceilings.irmaaTierCap, fs, law, year, inputs.inflationPct));
      }
      if (ceilings.magiCap != null)
        magiCap = Math.min(magiCap, ceilings.magiCap);
      if (p.taxableIncome > taxableCap + 0.005)
        return false;
      if (p.magi > magiCap + 0.005)
        return false;
      if (ceilings.acaCliffCap) {
        if (acaCliffDollars != null) {
          if (p.acaMagi > acaTargetDollars + 0.005)
            return false;
        } else if (ceilings.bracketTopPct == null && ceilings.irmaaTierCap == null && !ceilings.ltcgZeroCap && ceilings.magiCap == null && conversion > 0) {
          if (additional > 0)
            return false;
        }
      }
      return true;
    };
    let settled = settleYear(additional);
    if (yearCeilings && ceilingsActive(yearCeilings) && inWindow) {
      for (let pass = 1;pass < 6; pass++) {
        if (additional <= 0 || respectsCeilings(settled.priced))
          break;
        const target = fillConversion({
          base: {
            ...fillBase,
            ...ledgerFields(settled.realizedGains + injectedLtcg),
            extraPreTaxDraw: settled.extraDraw + settled.feedbackPretax
          },
          ceilings: yearCeilings,
          maxConversion: pretaxAfterRmd + already,
          acaCliff: acaCliffDollars,
          guardrailTargetPct
        });
        let next = Math.max(0, Math.min(target - already, pretaxAfterRmd, preserveRoom));
        if (next >= additional)
          next = Math.max(0, additional - 100);
        if (next === additional)
          break;
        additional = next;
        conversion = already + additional;
        settled = settleYear(additional);
      }
    }
    if (yearCeilings && ceilingsActive(yearCeilings) && inWindow && additional > 0 && !respectsCeilings(settled.priced)) {
      const atZero = settleYear(0);
      if (respectsCeilings(atZero.priced)) {
        let lo = 0;
        let hi = Math.round(additional * 100);
        let bestAdd = 0;
        let best = atZero;
        while (lo < hi) {
          const mid = Math.floor((lo + hi + 1) / 2);
          const candidate = settleYear(mid / 100);
          if (respectsCeilings(candidate.priced)) {
            lo = mid;
            bestAdd = mid / 100;
            best = candidate;
          } else {
            hi = mid - 1;
          }
        }
        additional = bestAdd;
        conversion = already + additional;
        settled = best;
      } else {
        additional = 0;
        conversion = already;
        settled = atZero;
      }
    }
    const guardrailStepOk = (candidate, candidateTotal) => {
      if (guardrailTargetPct == null)
        return true;
      if (candidateTotal <= 0)
        return true;
      const stepStart = Math.max(0, candidateTotal - 100);
      const below = priceWith(candidate.realizedGains, candidate.extraDraw + candidate.feedbackPretax, stepStart);
      const stepRate = (candidate.federalTax + candidate.stateTax - (below.federalTax + below.stateTax)) * 100 / (candidateTotal - stepStart);
      return stepRate <= guardrailTargetPct + 0.005;
    };
    if (yearCeilings?.irmaaTierCap != null && inWindow && !bunchZero && !eraZeroFill && !forceZeroConversion && respectsCeilings(settled.priced)) {
      const lawG = lawForYear(year);
      const tierTop = irmaaTierUpTo(yearCeilings.irmaaTierCap, effFilingStatus, lawG, year, inputs.inflationPct);
      const maxAdditional = Math.max(0, Math.min(pretaxAfterRmd, preserveRoom));
      const atOtherCap = (() => {
        let taxableCap = Infinity;
        if (yearCeilings.bracketTopPct != null) {
          const idx = lawG.rates.indexOf(yearCeilings.bracketTopPct);
          if (idx >= 0) {
            taxableCap = Math.min(taxableCap, lawG.brackets[effFilingStatus][idx] ?? Infinity);
          }
        }
        if (yearCeilings.ltcgZeroCap) {
          taxableCap = Math.min(taxableCap, lawG.ltcgZeroTop[effFilingStatus]);
        }
        if (Number.isFinite(taxableCap) && settled.priced.taxableIncome >= taxableCap - 0.005) {
          return true;
        }
        if (yearCeilings.magiCap != null && settled.priced.magi >= yearCeilings.magiCap - 0.005) {
          return true;
        }
        if (yearCeilings.acaCliffCap && acaTargetDollars != null && settled.priced.acaMagi >= acaTargetDollars - 0.005) {
          return true;
        }
        return false;
      })();
      if (Number.isFinite(tierTop) && settled.priced.magi < tierTop - 0.005 && additional < maxAdditional && !atOtherCap) {
        const tierOk = (p) => irmaaTierFor(p.magi, effFilingStatus, lawG, year, inputs.inflationPct) <= yearCeilings.irmaaTierCap;
        let lo = 0;
        let hi = Math.round((maxAdditional - additional) * 100);
        let bestAdd = additional;
        let best = settled;
        while (lo < hi) {
          const mid = Math.floor((lo + hi + 1) / 2);
          const candidate = settleYear(additional + mid / 100);
          if (respectsCeilings(candidate.priced) && tierOk(candidate.priced) && guardrailStepOk(candidate, already + additional + mid / 100)) {
            lo = mid;
            bestAdd = additional + mid / 100;
            best = candidate;
          } else {
            hi = mid - 1;
          }
        }
        if (bestAdd > additional) {
          additional = bestAdd;
          conversion = already + additional;
          settled = best;
        }
      }
    }
    if (yearCeilings?.acaCliffCap === true && acaCliffDollars != null && settled.extraDraw > 0 && settled.priced.acaMagi > acaTargetDollars + 0.005) {
      const atZeroDraw = settleYear(additional, 0);
      if (atZeroDraw.priced.acaMagi <= acaTargetDollars + 0.005) {
        let lo = 0;
        let hi = Math.round(settled.extraDraw * 100);
        let best = atZeroDraw;
        while (lo < hi) {
          const mid = Math.floor((lo + hi + 1) / 2);
          const candidate = settleYear(additional, mid / 100);
          if (candidate.priced.acaMagi <= acaTargetDollars + 0.005) {
            lo = mid;
            best = candidate;
          } else {
            hi = mid - 1;
          }
        }
        settled = best;
      } else {
        let drawCap = settled.extraDraw;
        for (let pass = 0;pass < 6; pass++) {
          const excess = settled.priced.acaMagi - acaTargetDollars;
          if (excess <= 0.005 || drawCap <= 0)
            break;
          const nextCap = Math.max(0, drawCap - excess);
          if (nextCap >= drawCap)
            break;
          drawCap = nextCap;
          settled = settleYear(additional, drawCap);
        }
      }
    }
    if (yearCeilings?.acaCliffCap === true && acaCliffDollars != null && inWindow && !bunchZero && !eraZeroFill && !forceZeroConversion && respectsCeilings(settled.priced) && settled.priced.acaMagi < acaTargetDollars - 0.005) {
      const maxAdditional = Math.max(0, Math.min(pretaxAfterRmd, preserveRoom));
      const atOtherCap = (() => {
        const lawC = lawForYear(year);
        let taxableCap = Infinity;
        if (yearCeilings.bracketTopPct != null) {
          const idx = lawC.rates.indexOf(yearCeilings.bracketTopPct);
          if (idx >= 0) {
            taxableCap = Math.min(taxableCap, lawC.brackets[effFilingStatus][idx] ?? Infinity);
          }
        }
        if (yearCeilings.ltcgZeroCap) {
          taxableCap = Math.min(taxableCap, lawC.ltcgZeroTop[effFilingStatus]);
        }
        if (Number.isFinite(taxableCap) && settled.priced.taxableIncome >= taxableCap - 0.005) {
          return true;
        }
        let magiCap = Infinity;
        if (yearCeilings.irmaaTierCap != null) {
          magiCap = Math.min(magiCap, irmaaTierUpTo(yearCeilings.irmaaTierCap, effFilingStatus, lawC, year, inputs.inflationPct));
        }
        if (yearCeilings.magiCap != null) {
          magiCap = Math.min(magiCap, yearCeilings.magiCap);
        }
        if (Number.isFinite(magiCap) && settled.priced.magi >= magiCap - 0.005) {
          return true;
        }
        return false;
      })();
      if (additional < maxAdditional && !atOtherCap) {
        let lo = 0;
        let hi = Math.round((maxAdditional - additional) * 100);
        let bestAdd = additional;
        let best = settled;
        while (lo < hi) {
          const mid = Math.floor((lo + hi + 1) / 2);
          const candidate = settleYear(additional + mid / 100);
          if (candidate.priced.acaMagi <= acaTargetDollars + 0.005 && respectsCeilings(candidate.priced) && guardrailStepOk(candidate, already + additional + mid / 100)) {
            lo = mid;
            bestAdd = additional + mid / 100;
            best = candidate;
          } else {
            hi = mid - 1;
          }
        }
        if (bestAdd > additional) {
          additional = bestAdd;
          conversion = already + additional;
          settled = best;
        }
      }
    }
    let priced = settled.priced;
    let federalTax = settled.federalTax;
    let stateTax = settled.stateTax;
    let unpaidTaxYear = settled.unpaidTax;
    const penalty = settled.penalty;
    const realizedGains = settled.realizedGains;
    const extraDraw = settled.extraDraw;
    const feedbackPretax = settled.feedbackPretax;
    let pretaxBalP = settled.pretaxBalP;
    let pretaxBalS = settled.pretaxBalS;
    let rothBal = settled.rothBal;
    let taxableBal = settled.taxableBal;
    let gainsHarvested = 0;
    let fundHarvestTaxTaxable = 0;
    let fundHarvestTaxPretax = 0;
    let fundHarvestTaxRoth = 0;
    if (driftOn) {
      if (tiersActive && settled.tierEnd) {
        tierState = settled.tierEnd.map((t) => ({ ...t }));
        clampTierLedgerToBalance(tierState, taxableBal);
        taxableBasisDollars = tierState.reduce((s, t) => s + t.basis, 0);
      } else {
        taxableBasisDollars = Math.max(0, settled.taxableBasisEnd);
      }
    } else {
      taxableBasisDollars = Math.max(0, taxableBasisDollars - settled.taxableDrawn * basisPctClamped + yieldTotal);
    }
    if (spendCashPct > 0) {
      sleeveDollars = Math.min(Math.max(0, settled.sleeveEnd), Math.max(0, taxableBal));
    }
    if (harvestOn) {
      const availableGain = Math.max(0, taxableBal - taxableBasisDollars);
      if (availableGain > 0) {
        const lawH = lawForYear(year);
        const fsH = effFilingStatus;
        let taxableLimit = Infinity;
        if (yearCeilings?.bracketTopPct != null) {
          const idx = lawH.rates.indexOf(yearCeilings.bracketTopPct);
          if (idx >= 0) {
            taxableLimit = Math.min(taxableLimit, lawH.brackets[fsH][idx] ?? Infinity);
          }
        }
        if (yearCeilings?.ltcgZeroCap) {
          taxableLimit = Math.min(taxableLimit, lawH.ltcgZeroTop[fsH]);
        }
        let magiLimit = Infinity;
        if (yearCeilings?.irmaaTierCap != null) {
          magiLimit = Math.min(magiLimit, irmaaTierUpTo(yearCeilings.irmaaTierCap, fsH, lawH, year, inputs.inflationPct));
        }
        if (yearCeilings?.magiCap != null) {
          magiLimit = Math.min(magiLimit, yearCeilings.magiCap);
        }
        const acaLimit = yearCeilings?.acaCliffCap === true && acaCliffDollars != null ? acaTargetDollars : Infinity;
        const settledAt15 = priced.gainsAt15;
        const settledAt20 = priced.gainsAt20;
        const harvestFits = (h) => {
          const p = priceWith(realizedGains + h, extraDraw + feedbackPretax, conversion);
          return p.gainsAt15 <= settledAt15 + 0.005 && p.gainsAt20 <= settledAt20 + 0.005 && p.taxableIncome <= taxableLimit + 0.005 && p.magi <= magiLimit + 0.005 && p.acaMagi <= acaLimit + 0.005;
        };
        if (harvestFits(0)) {
          let lo = 0;
          let hi = Math.floor(availableGain * 100);
          while (lo < hi) {
            const mid = Math.floor((lo + hi + 1) / 2);
            if (harvestFits(mid / 100)) {
              lo = mid;
            } else {
              hi = mid - 1;
            }
          }
          if (lo > 0) {
            gainsHarvested = lo / 100;
            const hp = priceWith(realizedGains + gainsHarvested, extraDraw + feedbackPretax, conversion);
            const delta = r2(hp.federalTax + hp.stateTax - (federalTax + stateTax));
            priced = hp;
            federalTax = hp.federalTax;
            stateTax = hp.stateTax;
            if (delta > 0) {
              const pay = Math.min(delta, Math.max(0, taxableBal));
              if (pay > 0 && taxableBal > 0) {
                if (tiersActive && tierState) {
                  sellFromTiers(tierState, pay, "highest");
                  taxableBasisDollars = tierState.reduce((s, t) => s + t.basis, 0);
                } else {
                  taxableBasisDollars = Math.max(0, taxableBasisDollars - pay * (taxableBasisDollars / taxableBal));
                }
              }
              taxableBal -= pay;
              fundHarvestTaxTaxable += pay;
              if (spendCashPct > 0 && sleeveDollars > 0 && pay > 0) {
                if (tiersActive && tierState && cashTierIndex >= 0) {
                  sleeveDollars = Math.max(0, tierState[cashTierIndex].bal);
                } else if (taxableBal + pay > 0) {
                  const poolBeforePay = taxableBal + pay;
                  sleeveDollars = Math.max(0, sleeveDollars - Math.max(0, pay - Math.max(0, poolBeforePay - sleeveDollars)));
                }
              }
              let rest = delta - pay;
              const fromP = Math.min(rest, Math.max(0, pretaxBalP));
              pretaxBalP -= fromP;
              rest -= fromP;
              const fromS = Math.min(rest, Math.max(0, pretaxBalS));
              pretaxBalS -= fromS;
              rest -= fromS;
              fundHarvestTaxPretax += fromP + fromS;
              if (rest > 0) {
                const fromR = Math.min(rest, Math.max(0, rothBal));
                fundHarvestTaxRoth += fromR;
                rothBal = Math.max(0, rothBal - rest);
                unpaidTaxYear = r2(unpaidTaxYear + Math.max(0, rest - fromR));
              }
            } else if (delta < 0) {
              taxableBal += -delta;
              fundHarvestTaxTaxable += delta;
              if (tiersActive && tierState) {
                buyIntoTiers(tierState, -delta);
                taxableBasisDollars = tierState.reduce((s, t) => s + t.basis, 0);
              } else {
                taxableBasisDollars += -delta;
              }
            }
            if (tiersActive && tierState) {
              stepUpTiers(tierState, gainsHarvested);
              taxableBasisDollars = tierState.reduce((s, t) => s + t.basis, 0);
            } else {
              taxableBasisDollars += gainsHarvested;
            }
            taxableBasisDollars = Math.min(taxableBasisDollars, Math.max(0, taxableBal));
          }
        }
      }
    }
    if (spendCashPct > 0) {
      sleeveDollars = Math.min(sleeveDollars, Math.max(0, taxableBal));
    }
    const grossGains = realizedGains + injectedLtcg + gainsHarvested;
    const ledFinal = ledgerOn || grossGains < 0 ? applyLossLedger({ st: carryInSt, lt: carryInLt }, grossGains, effFilingStatus, priced.taxableIncomeBeforeLossAllowance, { st: carryInWaSt, lt: carryInWaLt }) : null;
    if (ledFinal) {
      lossCarrySt = ledFinal.carryOut.st;
      lossCarryLt = ledFinal.carryOut.lt;
      lossCarryWaSt = ledFinal.waCarryOut.st;
      lossCarryWaLt = ledFinal.waCarryOut.lt;
    }
    let acaCreditKept = 0;
    let acaPriced = false;
    let acaResult = null;
    if (acaActive && benchmark != null) {
      acaResult = acaCreditFor({
        magi: priced.acaMagi,
        householdSize,
        coverageYear: year,
        benchmarkAnnual: benchmark,
        projected: true
      });
      acaCreditKept = healthAcaCapThisYear ? Math.min(acaResult.credit, healthGrossAca) : acaResult.credit;
      acaPriced = true;
    }
    const acaUnder138 = acaPriced && acaResult != null && acaResult.pctFpl < 138;
    const healthPremiumNetYear = healthActive && retiredYear ? r2(healthMedicarePremium + (healthAcaThisYear ? Math.max(0, healthGrossAca - Math.min(settled.createdFbCredit, healthGrossAca)) : 0)) : 0;
    const healthPremiumGrossYear = healthActive && retiredYear ? healthGrossYear : 0;
    const funding = (() => {
      const spendNeedY = settled.spendNeed;
      const cashInY = rmd + ssBenefits + inputs.otherOrdinaryAnnual + inputs.taxExemptInterestAnnual;
      const incomeAppliedY = Math.min(cashInY, spendNeedY) + settled.taxFromCash;
      let incLeft = incomeAppliedY;
      const takeIncome = (gross) => {
        const take = gross < 0 ? gross : Math.min(gross, Math.max(0, incLeft));
        incLeft -= take;
        return take;
      };
      const ssApplied = takeIncome(ssBenefits);
      const rmdApplied = takeIncome(rmd);
      const taxExemptApplied = takeIncome(inputs.taxExemptInterestAnnual);
      const otherApplied = incomeAppliedY - ssApplied - rmdApplied - taxExemptApplied;
      const interestApplied = 0;
      const dividendApplied = 0;
      const pretaxDrawY = settled.extraDraw + settled.fundTaxPretax + fundHarvestTaxPretax;
      const taxableSpendY = settled.fundSpendTaxable;
      const taxableTaxY = settled.fundTaxTaxable + fundHarvestTaxTaxable;
      const rothDrawY = settled.fundSpendRoth + settled.fundTaxRoth + fundHarvestTaxRoth;
      return {
        spending: r2(spendNeedY - healthPremiumNetYear),
        federalTax: r2(federalTax + penalty),
        stateTax: r2(stateTax),
        irmaa: r2(irmaaPaid),
        healthPremium: r2(healthPremiumNetYear),
        ss: r2(ssApplied),
        rmd: r2(rmdApplied),
        otherIncome: r2(otherApplied),
        taxExempt: r2(taxExemptApplied),
        interestYield: r2(interestApplied),
        dividendYield: r2(dividendApplied),
        pretaxDraw: r2(pretaxDrawY),
        taxableSoldForSpending: r2(taxableSpendY),
        taxableSoldForTax: r2(taxableTaxY),
        cashSpend: r2(settled.cashSpend),
        rothDraw: r2(rothDrawY),
        salarySurplus: 0,
        conversion: r2(conversion),
        harvestSold: r2(gainsHarvested),
        spendShortfall: r2(settled.spendDeficit),
        unpaidTax: r2(unpaidTaxYear)
      };
    })();
    let effectiveMarginalPct = null;
    if (conversion > 0) {
      const plus = priceWith(realizedGains, extraDraw + feedbackPretax, conversion + 100);
      effectiveMarginalPct = r2(plus.federalTax + plus.stateTax - (federalTax + stateTax));
    }
    lookbackByYear.set(year, {
      year,
      magi: priced.magi,
      filingStatus: effFilingStatus
    });
    const seriesPct = returnSeriesPct?.[year - inputs.startYear];
    const yearGrowth = seriesPct != null ? Math.max(0, 1 + seriesPct / 100) : growth;
    priorYearReturnPct = seriesPct != null ? seriesPct : inputs.expectedReturnPct;
    pretaxP = Math.max(0, pretaxBalP) * yearGrowth;
    pretaxS = Math.max(0, pretaxBalS) * yearGrowth;
    const pretax = pretaxP + pretaxS;
    roth = Math.max(0, rothBal) * yearGrowth;
    taxable = Math.max(0, taxableBal) * yearGrowth;
    hsa = Math.max(0, hsa) * yearGrowth;
    if (driftOn) {
      if (tiersActive && tierState) {
        for (const t of tierState) {
          t.bal = Math.max(0, t.bal) * yearGrowth;
          t.basis = Math.max(0, t.basis);
        }
        clampTierLedgerToBalance(tierState, taxable);
        taxableBasisDollars = tierState.reduce((s, t) => s + t.basis, 0);
      } else {
        taxableBasisDollars = Math.max(0, taxableBasisDollars);
      }
    }
    if (spendCashPct > 0) {
      sleeveDollars = tierState != null && cashTierIndex >= 0 ? Math.max(0, tierState[cashTierIndex].bal) : Math.min(sleeveDollars, Math.max(0, taxable));
    }
    const warnings = [];
    if (!leanDetail) {
      if (priced.irmaaTier > 0 && priceAgePrimary >= 63) {
        const law = lawForYear(year);
        const floor = priced.irmaaTier - 1 < law.irmaaTiers.length ? irmaaTierUpTo(priced.irmaaTier - 1, effFilingStatus, law, year, inputs.inflationPct) + 1 : 0;
        const perPersonAnnual = irmaaAnnualPerPerson(priced.irmaaTier, law);
        if (priced.magi - floor <= 2500) {
          const bothOnMedicareAtPremium = !isSurvivorYear && age + 2 >= 65 && spouseAge != null && spouseAge + 2 >= spouseAcaEndAge;
          const framing = bothOnMedicareAtPremium ? `≈${fmtDollars(perPersonAnnual)}/yr for each person on Medicare — ≈${fmtDollars(r2(perPersonAnnual * 2))}/yr for the household` : `≈${fmtDollars(perPersonAnnual)}/yr for each person on Medicare`;
          warnings.push({
            kind: "irmaa",
            text: `Just over the IRMAA Tier ${priced.irmaaTier} line — MAGI ${fmtDollars(priced.magi)} sets Tier ${priced.irmaaTier} premiums two years later (${framing}).`
          });
        }
      }
      if (acaActive && acaPriced && acaResult) {
        if (acaResult.overCliff) {
          warnings.push({
            kind: "aca",
            text: `Over the ACA cliff — ACA MAGI ${fmtDollars(priced.acaMagi)} is past 400% FPL (${fmtDollars(acaResult.cliff)}), so the whole year's premium credit is $0 and any advance credit is repayable in full.`
          });
        } else if (acaResult.cliff - priced.acaMagi <= 2500 && acaResult.cliff >= priced.acaMagi) {
          warnings.push({
            kind: "aca",
            text: `Close to the ACA cliff — ACA MAGI ${fmtDollars(priced.acaMagi)} vs the 400% FPL line at ${fmtDollars(acaResult.cliff)}; $1 over loses the whole year's credit.`
          });
        }
        if (acaUnder138) {
          warnings.push({
            kind: "aca",
            text: `Priced at ${acaResult.pctFpl.toFixed(0)}% of the poverty line — under 138% FPL, at that income coverage routes to Medicaid rather than a marketplace plan in most states, so the credit shown for this year is flagged rather than a marketplace result.`
          });
        }
      }
      if (effectiveMarginalPct != null && effectiveMarginalPct > priced.marginalBracketPct + 0.5) {
        const ssPhasingIn = ssBenefits > 0 && priced.ssTaxable < 0.85 * ssBenefits - 0.01;
        if (ssPhasingIn) {
          warnings.push({
            kind: "torpedo",
            text: `Social Security torpedo zone — this year's conversion is really taxed at ${effectiveMarginalPct.toFixed(1)}%, not the ${priced.marginalBracketPct}% bracket rate, because each converted dollar also pulls Social Security into taxable income.`
          });
        } else {
          warnings.push({
            kind: "torpedo",
            text: `Effective rate above the bracket rate — the next $100 of conversion in this year would be taxed at ${effectiveMarginalPct.toFixed(1)}%, not the ${priced.marginalBracketPct}% bracket rate (causes other than Social Security phase-in: this year's income straddling the top of the bracket, state tax, capital-gains displacement, or a deduction phase-out).`
          });
        }
      }
      if (conversion > 0 && inputs.collegeFallFromYear != null && inputs.collegeFallThroughYear != null && inputs.collegeFallFromYear <= year + 2 && year + 2 <= inputs.collegeFallThroughYear && (inputs.fafsaReportableAssets == null || FAFSA_PARENT_ASSET_RATE * inputs.fafsaReportableAssets < FAFSA_PUBLIC_COA_BENCHMARK)) {
        warnings.push({
          kind: "college",
          text: "College years: conversion income in this year counts as FAFSA income (prior-prior year) during a child's college years."
        });
      }
    }
    lifetimeFederalTax += federalTax;
    lifetimeStateTax += stateTax;
    lifetimePenalty += penalty;
    lifetimeIrmaa += irmaaPaid;
    lifetimeAcaKept += acaCreditKept;
    lifetimeHealthPremiumGross += healthPremiumGrossYear;
    lifetimeHealthPremiumNet += healthPremiumNetYear;
    lifetimeEducationRefundable += priced.educationRefundable;
    if (priced.educationRefundable > 0) {
      if (age >= inputs.endAgePrimary) {
        taxable += priced.educationRefundable;
      } else {
        pendingEduRefund = priced.educationRefundable;
      }
    }
    lifetimeAmt += priced.amtOwed;
    lifetimeSsCollected += ssBenefits;
    lifetimeUnpaidTax += unpaidTaxYear;
    const fillCaps = [];
    let fillBoundLabel = null;
    if (yearCeilings && !leanDetail) {
      const lawY = lawForYear(year);
      const fsY = effFilingStatus;
      const nextPriced = conversion > 0 ? priceWith(realizedGains, extraDraw + feedbackPretax, conversion + 100) : null;
      const addCap = (kind, label, cap, actual, nextActual) => {
        if (!Number.isFinite(cap))
          return;
        const bound = actual <= cap + 0.005 && nextActual != null && nextActual > cap + 0.005;
        fillCaps.push({
          kind,
          label,
          cap: r2(cap),
          actual: r2(actual),
          room: r2(cap - actual),
          bound
        });
        if (bound && fillBoundLabel == null)
          fillBoundLabel = label;
      };
      if (preserveFloor > 0) {
        const postConversion = pretaxAfterRmd - additional;
        const bound = additional > 0 && postConversion - preserveFloor < 100 - 0.005;
        fillCaps.push({
          kind: "preserve",
          label: `Pre-tax reserve — ${fmtDollars(preserveFloor)} never converted`,
          cap: r2(preserveFloor),
          actual: r2(postConversion),
          room: r2(postConversion - preserveFloor),
          bound
        });
        if (bound && fillBoundLabel == null) {
          fillBoundLabel = "Pre-tax reserve floor";
        }
      }
      if (yearCeilings.bracketTopPct != null) {
        const idx = lawY.rates.indexOf(yearCeilings.bracketTopPct);
        if (idx >= 0) {
          addCap("bracket", `Top of the ${yearCeilings.bracketTopPct}% bracket`, lawY.brackets[fsY][idx] ?? Infinity, priced.taxableIncome, nextPriced?.taxableIncome ?? null);
        }
      }
      if (yearCeilings.ltcgZeroCap) {
        addCap("ltcgZero", "Top of the 0% capital-gains space", lawY.ltcgZeroTop[fsY], priced.taxableIncome, nextPriced?.taxableIncome ?? null);
      }
      if (yearCeilings.irmaaTierCap != null) {
        addCap("irmaa", `IRMAA Tier ${yearCeilings.irmaaTierCap} ceiling`, irmaaTierUpTo(yearCeilings.irmaaTierCap, fsY, lawY, year, inputs.inflationPct), priced.magi, nextPriced?.magi ?? null);
      }
      if (yearCeilings.magiCap != null) {
        addCap("magi", `MAGI cap ${fmtDollars(yearCeilings.magiCap)}`, yearCeilings.magiCap, priced.magi, nextPriced?.magi ?? null);
      }
      if (yearCeilings.acaCliffCap && acaCliffDollars != null) {
        const cliffBuffer = Math.max(0, yearCeilings.acaCliffBuffer ?? 0);
        addCap("acaCliff", cliffBuffer > 0 ? `ACA cliff (400% of the poverty line, on ACA MAGI) less the ${fmtDollars(cliffBuffer)} safety buffer` : "ACA cliff (400% of the poverty line, on ACA MAGI)", acaTargetDollars ?? acaCliffDollars, priced.acaMagi, nextPriced?.acaMagi ?? null);
      }
      if (fillBoundLabel == null && additional > 0) {
        if (additional >= pretaxAfterRmd - 0.005) {
          fillBoundLabel = "Pre-tax balance exhausted";
        } else if (guardrailTargetPct != null && nextPriced != null) {
          const stepRate = nextPriced.federalTax + nextPriced.stateTax - (federalTax + stateTax);
          if (stepRate > guardrailTargetPct + 0.005) {
            fillBoundLabel = `Marginal-rate guardrail (${guardrailTargetPct}%)`;
          }
        }
      }
    } else if (!leanDetail && additional > 0 && additional >= pretaxAfterRmd - 0.005) {
      fillBoundLabel = "Pre-tax balance exhausted";
    }
    let fillOutcome;
    if (additional > 0) {
      fillOutcome = "converted";
    } else if (!inWindow) {
      fillOutcome = "outside-window";
    } else if (!strategy.ceilings) {
      fillOutcome = "no-ceilings";
    } else if (bunchZero) {
      fillOutcome = "bunching-off-year";
    } else if (eraZeroFill) {
      fillOutcome = "era-cliff-off";
    } else if (pretaxAfterRmd <= 0) {
      fillOutcome = "pretax-empty";
    } else if (already > 0) {
      fillOutcome = "already-converted-only";
    } else if (preserveFloor > 0 && preserveRoom <= 0) {
      fillOutcome = "reserve-floor";
    } else if (yearCeilings?.acaCliffCap && acaCliffDollars == null && yearCeilings.bracketTopPct == null && yearCeilings.irmaaTierCap == null && !yearCeilings.ltcgZeroCap && yearCeilings.magiCap == null) {
      fillOutcome = "aca-inactive-only-ceiling";
    } else {
      fillOutcome = "no-room-under-ceilings";
    }
    const detail = {
      priorPretaxBalance: r2(priorPretaxBalance),
      rmdDivisor,
      rmdTable,
      priorPretaxPrimary: r2(priorP),
      priorPretaxSpouse: r2(priorS),
      rmdPrimary: r2(rmdP),
      rmdSpouse: r2(rmdS),
      rmdDivisorPrimary: divisorP,
      rmdDivisorSpouse: divisorS,
      rmdTablePrimary: tableP,
      rmdTableSpouse: tableS,
      filingStatus: effFilingStatus,
      isDeathYear,
      isSurvivorYear,
      otherOrdinary: r2(inputs.otherOrdinaryAnnual),
      extraPreTaxDraw: r2(extraDraw + feedbackPretax),
      pretaxSpendingDraw: r2(extraDraw),
      pretaxTaxDebit: r2(feedbackPretax),
      ltcg: r2(realizedGains + injectedLtcg + gainsHarvested),
      ltcgNet: ledFinal ? ledFinal.netResult : r2(realizedGains + injectedLtcg + gainsHarvested),
      capitalLossAllowance: ledFinal ? ledFinal.allowance : Math.min(capitalLossAllowanceCap(effFilingStatus), Math.max(0, -(realizedGains + injectedLtcg + gainsHarvested))),
      dividendIncome: r2(dividendIncome),
      interestIncome: r2(interestIncome),
      qualifiedDividends: qualifiedDividendIncome,
      cashSpend: r2(settled.cashSpend),
      cashSleeveEnd: r2(spendCashPct > 0 ? sleeveDollars : 0),
      spendingBase: r2(spendNeedBase),
      flexCut: r2(spendNeedBase - spendNeedYear),
      acaPremiumEmbedded: premiumReconcile ? r2(premiumEmbeddedDollars) : 0,
      acaPremiumNet: premiumReconcile ? r2(Math.max(0, benchmark - settled.feedbackCredit)) : 0,
      acaPremiumAdjustment: premiumReconcile ? r2(Math.max(0, benchmark - settled.feedbackCredit) - premiumEmbeddedDollars) : 0,
      gainsHarvested: r2(gainsHarvested),
      taxableBasisDollars: r2(taxableBasisDollars),
      drawGains: r2(realizedGains),
      waGains: priced.waGains,
      waStandardDeduction: priced.waStandardDeduction,
      waTaxableGains: priced.waTaxableGains,
      itemizedDeduction: priced.itemizedDeduction,
      itemizedSaltAllowed: priced.itemizedSaltAllowed,
      deductionTaken: priced.deductionTaken,
      itemizedCharitableAllowed: priced.itemizedCharitableAllowed,
      section68Reduction: priced.section68Reduction,
      nonItemizerCharitableDeduction: priced.nonItemizerCharitableDeduction,
      educationAotc: priced.educationAotc,
      educationLlc: priced.educationLlc,
      educationChoice: priced.educationChoice,
      educationNonrefundable: priced.educationNonrefundable,
      educationRefundable: priced.educationRefundable,
      amti: priced.amti,
      amtExemption: priced.amtExemption,
      amtTentativeTax: priced.amtTentativeTax,
      amtOwed: priced.amtOwed,
      lossCarryInSt: r2(carryInSt),
      lossCarryInLt: r2(carryInLt),
      lossAbsorbed: ledFinal ? ledFinal.absorbedByGains : 0,
      lossWaAbsorbed: ledFinal ? ledFinal.waAbsorbedByGains : 0,
      lossAllowance: ledFinal ? ledFinal.allowance : 0,
      lossCarryOutSt: ledFinal ? ledFinal.carryOut.st : 0,
      lossCarryOutLt: ledFinal ? ledFinal.carryOut.lt : 0,
      lossCarryInWaSt: r2(carryInWaSt),
      lossCarryInWaLt: r2(carryInWaLt),
      lossCarryOutWaSt: ledFinal ? ledFinal.waCarryOut.st : 0,
      lossCarryOutWaLt: ledFinal ? ledFinal.waCarryOut.lt : 0,
      taxExemptInterest: r2(inputs.taxExemptInterestAnnual),
      provisionalIncome: priced.provisionalIncome,
      ssTaxable: priced.ssTaxable,
      agi: priced.agi,
      baseStandardDeduction: priced.baseStandardDeduction,
      age65AddonTotal: priced.age65AddonTotal,
      count65: priced.count65,
      standardDeduction: priced.standardDeduction,
      seniorDeduction: priced.seniorDeduction,
      deductions: priced.deductions,
      ordinaryTaxableIncome: priced.ordinaryTaxableIncome,
      gainsInTaxableIncome: priced.gainsInTaxableIncome,
      bracketLayers: priced.bracketLayers,
      gainsAt0: priced.gainsAt0,
      gainsAt15: priced.gainsAt15,
      gainsAt20: priced.gainsAt20,
      ordinaryTax: priced.ordinaryTax,
      ltcgTax: priced.ltcgTax,
      niit: priced.niit,
      stateTax: r2(stateTax),
      fill: {
        inWindow,
        windowStartAge: inputs.windowStartAge,
        windowStopAge: inputs.windowStopAge,
        outcome: fillOutcome,
        boundLabel: fillBoundLabel,
        caps: fillCaps
      },
      irmaa: {
        tierSet: priced.irmaaTier,
        premiumYear: year + 2,
        paidTier: irmaaPaidTier,
        paidSourceYear: irmaaPaidTier != null ? year - 2 : null,
        paidSourceMagi: irmaaPaidTier != null && lookbackEntry != null ? r2(lookbackEntry.magi) : null,
        paidSourceFilingStatus: irmaaPaidTier != null && lookbackEntry != null ? lookbackEntry.filingStatus : null,
        personsOnMedicare
      },
      aca: {
        active: acaActive,
        priced: acaPriced,
        householdSize,
        benchmark,
        fpl: acaResult ? acaResult.fpl : acaCliffDollars != null ? r2(acaCliffDollars / 4) : null,
        cliff: acaResult ? acaResult.cliff : acaCliffDollars,
        pctFpl: acaResult ? acaResult.pctFpl : null,
        applicablePct: acaResult ? acaResult.applicablePct : null,
        overCliff: acaResult ? acaResult.overCliff : false
      }
    };
    years.push({
      year,
      agePrimary: age,
      ageSpouse: spouseAge,
      conversion: r2(conversion),
      conversionAlready: r2(already),
      gainsHarvested: r2(gainsHarvested),
      rmd: r2(rmd),
      ssBenefits: r2(ssBenefits),
      ssPctTaxed: ssBenefits > 0 ? r2(priced.ssTaxable / ssBenefits * 100) : 0,
      agi: priced.agi,
      magi: priced.magi,
      acaMagi: priced.acaMagi,
      taxableIncome: priced.taxableIncome,
      acaActive,
      bracketPct: priced.marginalBracketPct,
      federalTax: r2(federalTax),
      stateTax: r2(stateTax),
      penalty: r2(penalty),
      educationRefundable: priced.educationRefundable,
      amtOwed: priced.amtOwed,
      effectiveMarginalPct,
      irmaaTierSet: priced.irmaaTier,
      irmaaPaid: r2(irmaaPaid),
      acaCreditKept: r2(acaCreditKept),
      acaPriced,
      acaUnder138,
      healthPremiumGross: r2(healthPremiumGrossYear),
      healthPremiumNet: r2(healthPremiumNetYear),
      pretaxEnd: r2(pretax),
      pretaxPrimaryEnd: r2(pretaxP),
      pretaxSpouseEnd: r2(pretaxS),
      filingStatus: effFilingStatus,
      isDeathYear,
      isSurvivorYear,
      rothEnd: r2(roth),
      taxableEnd: r2(taxable),
      hsaEnd: r2(hsa),
      fiveYearClockYear: conversion > 0 ? year + 5 : null,
      warnings,
      detail,
      funding,
      spendShortfall: r2(settled.spendDeficit),
      unpaidTax: r2(unpaidTaxYear),
      settlementConverged: settled.settlementConverged,
      settlementMismatchCents: settled.settlementMismatchCents,
      ceilingBreached: yearCeilings != null && ceilingsActive(yearCeilings) && !respectsCeilings(priced)
    });
  }
  const endingPretaxTotal = pretaxP + pretaxS;
  const endingPreserved = Math.min(endingPretaxTotal, Math.max(0, inputs.preservePretax ?? 0));
  const endingAfterTaxWealth = endingPreserved * (1 - (inputs.preserveExitRatePct ?? inputs.heirRatePct) / 100) + (endingPretaxTotal - endingPreserved) * (1 - inputs.heirRatePct / 100) + roth + taxable + hsa;
  return {
    years,
    lifetimeFederalTax: r2(lifetimeFederalTax),
    lifetimeStateTax: r2(lifetimeStateTax),
    lifetimePenalty: r2(lifetimePenalty),
    lifetimeIrmaa: r2(lifetimeIrmaa),
    lifetimeAcaKept: r2(lifetimeAcaKept),
    lifetimeEducationRefundable: r2(lifetimeEducationRefundable),
    lifetimeAmt: r2(lifetimeAmt),
    lifetimeSsCollected: r2(lifetimeSsCollected),
    lifetimeHealthPremiumGross: r2(lifetimeHealthPremiumGross),
    lifetimeHealthPremiumNet: r2(lifetimeHealthPremiumNet),
    lifetimeUnpaidTax: r2(lifetimeUnpaidTax),
    endingPretax: r2(endingPretaxTotal),
    endingRoth: r2(roth),
    endingTaxable: r2(taxable),
    endingHsa: r2(hsa),
    endingAfterTaxWealth: r2(endingAfterTaxWealth)
  };
}
function fmtDollars(n) {
  const neg = n < 0;
  const abs = Math.abs(Math.round(n));
  const s = `$${groupThousands(abs)}`;
  return neg ? `−${s}` : s;
}
function groupThousands(absInt) {
  const digits = String(absInt);
  let out = "";
  for (let i = 0;i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0)
      out += ",";
    out += digits[i];
  }
  return out;
}

function impliedYieldPctsFromTaxReturn(stored, taxablePoolDollars) {
  const pool = taxablePoolDollars;
  if (!Number.isFinite(pool) || pool <= 0) {
    return { dividendYieldPct: null, interestYieldPct: null };
  }
  const implied = (cents) => {
    if (cents == null || !Number.isFinite(cents) || cents < 0)
      return null;
    const pct = cents / 100 / pool * 100;
    return Math.round(pct * 1e4) / 1e4;
  };
  return {
    dividendYieldPct: implied(stored.taxReturnOrdinaryDividendsCents),
    interestYieldPct: implied(stored.taxReturnInterestCents)
  };
}

var DEFAULT_HEIR_RATE_PCT = 22;

function r22(n) {
  return Math.round(n * 100) / 100;
}
function fullRetirementAgeMonths(birthYear) {
  if (birthYear >= 1960)
    return 67 * 12;
  if (birthYear >= 1955)
    return 66 * 12 + (birthYear - 1954) * 2;
  if (birthYear >= 1943)
    return 66 * 12;
  if (birthYear >= 1938)
    return 65 * 12 + (birthYear - 1937) * 2;
  return 65 * 12;
}
function ssBenefitFactor(claimAge, birthYear) {
  const fraMonths = fullRetirementAgeMonths(birthYear);
  const diff = Math.round(claimAge * 12) - fraMonths;
  if (diff < 0) {
    const early = -diff;
    const reduction = Math.min(early, 36) * (5 / 9 / 100) + Math.max(0, early - 36) * (5 / 12 / 100);
    return 1 - reduction;
  }
  if (diff > 0) {
    const delayed = Math.min(diff, 70 * 12 - fraMonths);
    return 1 + Math.max(0, delayed) * (2 / 3 / 100);
  }
  return 1;
}
function ssAnnualAtClaimAge(anchorAnnual, anchorAge, claimAge, birthYear) {
  if (anchorAge == null || anchorAge === claimAge || anchorAnnual <= 0) {
    return anchorAnnual;
  }
  const anchorFactor = ssBenefitFactor(anchorAge, birthYear);
  if (anchorFactor <= 0)
    return anchorAnnual;
  const pia = anchorAnnual / anchorFactor;
  return r22(pia * ssBenefitFactor(claimAge, birthYear));
}
function enteredClaimInfo(inputs) {
  return {
    primaryAge: inputs.ssPrimaryStartAge,
    spouseAge: inputs.ssSpouseStartAge,
    primaryAnnual: effectiveSsPrimaryAnnual(inputs),
    spouseAnnual: effectiveSsSpouseAnnual(inputs),
    searchedPrimary: false,
    searchedSpouse: false
  };
}
function netCostBreakdown(result, heirRatePct, opts) {
  const tax = r22(result.lifetimeFederalTax + result.lifetimeStateTax);
  const penalty = r22(result.lifetimePenalty);
  const irmaa = r22(result.lifetimeIrmaa);
  const acaCredit = r22(result.lifetimeAcaKept);
  const healthPremium = r22(result.lifetimeHealthPremiumGross ?? 0);
  const healthPremiumNet = r22(result.lifetimeHealthPremiumNet ?? 0);
  const educationRefundable = r22(result.lifetimeEducationRefundable);
  const amt = r22(result.lifetimeAmt);
  const floor = Math.max(0, opts?.preservePretax ?? 0);
  const exitRatePct = opts?.preserveExitRatePct ?? heirRatePct;
  const preservedPretax = r22(Math.min(result.endingPretax, floor));
  const excessPretax = r22(result.endingPretax - preservedPretax);
  const terminalPreserved = r22(preservedPretax * (exitRatePct / 100));
  const terminalExcess = r22(excessPretax * (heirRatePct / 100));
  const terminal = r22(terminalPreserved + terminalExcess);
  return {
    tax,
    penalty,
    irmaa,
    acaCredit,
    healthPremium,
    healthPremiumNet,
    educationRefundable,
    amt,
    terminal,
    preservedPretax,
    terminalPreserved,
    excessPretax,
    terminalExcess,
    netCost: r22(tax + penalty + irmaa + healthPremium - acaCredit - educationRefundable + terminal),
    ssCollected: r22(result.lifetimeSsCollected)
  };
}
function planNetCost(result, inputs) {
  return netCostBreakdown(result, inputs.heirRatePct, {
    preservePretax: inputs.preservePretax ?? 0,
    preserveExitRatePct: inputs.preserveExitRatePct ?? inputs.heirRatePct
  });
}
function harvestGatePasses(inputs) {
  if (!(inputs.taxableStart > 0))
    return false;
  if (inputs.taxableBasisBlank === true)
    return false;
  if (Array.isArray(inputs.taxableTiers) && inputs.taxableTiers.length > 0) {
    return inputs.taxableTiers.some((t) => (t.sharePct ?? 0) > 0 && Math.min(100, Math.max(0, t.basisPct)) < 100);
  }
  return Math.min(100, Math.max(0, inputs.taxableBasisPct)) < 100;
}
var HARVEST_NAME_PHRASE = "gain harvesting into the 0% bracket";
function fmtDollars2(n) {
  const neg = n < 0;
  const abs = Math.abs(Math.round(n));
  let digits = String(abs);
  let grouped = "";
  while (digits.length > 3) {
    grouped = `,${digits.slice(-3)}${grouped}`;
    digits = digits.slice(0, -3);
  }
  const s = `$${digits}${grouped}`;
  return neg ? `−${s}` : s;
}
function nameForCeilings(ceilings) {
  const caps = [];
  if (ceilings.irmaaTierCap != null)
    caps.push(`IRMAA Tier ${ceilings.irmaaTierCap}`);
  if (ceilings.ltcgZeroCap)
    caps.push("the top of the 0% capital-gains space");
  if (ceilings.acaCliffCap)
    caps.push("the ACA cliff (400% of the poverty line)");
  if (ceilings.acaCliffCap && ceilings.acaCliffBuffer != null && ceilings.acaCliffBuffer > 0)
    caps.push(`a ${fmtDollars2(ceilings.acaCliffBuffer)} safety buffer under the cliff`);
  if (ceilings.magiCap != null)
    caps.push(`a ${fmtDollars2(ceilings.magiCap)} MAGI cap`);
  let head;
  if (ceilings.bracketTopPct != null) {
    head = `Fill to the top of the ${ceilings.bracketTopPct}% bracket`;
  } else if (ceilings.irmaaTierCap != null) {
    head = `Fill up to the IRMAA Tier ${ceilings.irmaaTierCap} ceiling`;
    caps.shift();
  } else if (ceilings.acaCliffCap) {
    head = "Fill up to the ACA cliff (400% of the poverty line)";
    caps.shift();
  } else if (ceilings.magiCap != null) {
    head = `Fill to a ${fmtDollars2(ceilings.magiCap)} MAGI cap`;
    caps.shift();
  } else if (ceilings.ltcgZeroCap) {
    head = "Fill up to the top of the 0% capital-gains space";
    caps.shift();
  } else {
    head = "Convert with no ceiling";
  }
  return caps.length ? `${head}, capped at ${caps.join(" and ")}` : head;
}
function windowLabelFor(kind, startAge, stopAge) {
  const base = `Convert ages ${startAge}–${stopAge}`;
  if (kind === "stop65")
    return `${base} (stop at 65)`;
  if (kind === "stopRmd")
    return `${base} (stop the year before RMDs begin)`;
  return `${base} (keep topping up through the RMD years)`;
}
function ceilingSets() {
  const sets = [];
  const push = (ceilings) => sets.push({
    ceilings,
    bracketBearing: ceilings.bracketTopPct != null,
    acaBearing: ceilings.acaCliffCap
  });
  for (const rate of CURRENT_LAW.rates) {
    push({ ...NO_CEILINGS, bracketTopPct: rate });
  }
  for (let tier = 0;tier <= 4; tier++) {
    push({ ...NO_CEILINGS, irmaaTierCap: tier });
  }
  for (const rate of [10, 12, 22, 24]) {
    for (const tier of [0, 1, 2]) {
      push({ ...NO_CEILINGS, bracketTopPct: rate, irmaaTierCap: tier });
    }
  }
  push({ ...NO_CEILINGS, acaCliffCap: true });
  push({ ...NO_CEILINGS, bracketTopPct: 12, acaCliffCap: true });
  push({ ...NO_CEILINGS, bracketTopPct: 22, acaCliffCap: true });
  for (const cap of [150000, 200000, 250000, 300000, 400000, 500000]) {
    push({ ...NO_CEILINGS, magiCap: cap });
  }
  return sets;
}
function ceilingsKey(c) {
  return [
    c.bracketTopPct ?? "-",
    c.irmaaTierCap ?? "-",
    c.ltcgZeroCap ? "g" : "-",
    c.acaCliffCap ? "a" : "-",
    c.magiCap ?? "-"
  ].join("|");
}
function buildOptimizerCandidates(inputs, orders = ALL_DRAW_ORDERS) {
  const rmdAge = Math.ceil(rmdAgeForBirthYear(inputs.birthYearPrimary));
  const stops = [
    { kind: "stop65", stop: 65 },
    { kind: "stopRmd", stop: rmdAge - 1 },
    { kind: "throughRmd", stop: inputs.endAgePrimary }
  ];
  const seenStops = new Set;
  const windows = stops.filter((w) => {
    if (w.stop < inputs.windowStartAge)
      return false;
    if (seenStops.has(w.stop))
      return false;
    seenStops.add(w.stop);
    return true;
  });
  const out = [];
  const seen = new Set;
  const harvestGate = harvestGatePasses(inputs);
  const addOne = (ceilings, window, guardrail, bunching, drawOrder, gainsHarvest) => {
    const baseKey = [
      ceilingsKey(ceilings),
      window.stop,
      guardrail ? "gr" : "-",
      bunching ? "bu" : "-",
      drawOrderKey(drawOrder)
    ].join(":");
    const key = gainsHarvest ? `${baseKey}:hv` : baseKey;
    if (seen.has(key))
      return;
    seen.add(key);
    const baseName = nameForCeilings(ceilings);
    out.push({
      key,
      name: gainsHarvest ? `${baseName} · ${HARVEST_NAME_PHRASE}` : baseName,
      ceilings,
      windowStopAge: window.stop,
      windowKind: window.kind,
      windowLabel: windowLabelFor(window.kind, inputs.windowStartAge, window.stop),
      guardrail,
      bunching,
      gainsHarvest,
      drawOrder
    });
  };
  const add = (ceilings, window, guardrail, bunching, drawOrder) => {
    addOne(ceilings, window, guardrail, bunching, drawOrder, false);
    if (harvestGate)
      addOne(ceilings, window, guardrail, bunching, drawOrder, true);
  };
  for (const set of ceilingSets()) {
    for (const window of windows) {
      for (const order of orders) {
        add(set.ceilings, window, false, false, order);
        if (set.bracketBearing)
          add(set.ceilings, window, true, false, order);
        if (!set.acaBearing)
          add(set.ceilings, window, false, true, order);
      }
    }
  }
  return out;
}
function candidateStrategy(spec) {
  return {
    id: `opt-${spec.key}`,
    name: spec.name,
    ceilings: spec.ceilings,
    guardrail: spec.guardrail,
    bunching: spec.bunching,
    gainsHarvest: spec.gainsHarvest ?? false
  };
}
var DO_NOTHING_SPEC = {
  key: "do-nothing",
  name: "Do Nothing",
  ceilings: NO_CEILINGS,
  windowStopAge: 0,
  windowKind: "stopRmd",
  windowLabel: "No conversions",
  guardrail: false,
  bunching: false,
  gainsHarvest: false,
  drawOrder: DEFAULT_DRAW_ORDER
};
function compareScoredCandidates(a, b, planOrderKey) {
  const dnRank = (s) => s.spec.key === DO_NOTHING_SPEC.key ? 0 : 1;
  const orderRank = (s) => drawOrderKey(s.spec.drawOrder) === planOrderKey ? 0 : 1;
  return a.cost.netCost - b.cost.netCost || b.result.endingAfterTaxWealth - a.result.endingAfterTaxWealth || dnRank(a) - dnRank(b) || orderRank(a) - orderRank(b) || (a.spec.key < b.spec.key ? -1 : a.spec.key > b.spec.key ? 1 : 0);
}
function compareJointCandidates(a, b) {
  const dnRank = (s) => s.spec.key === DO_NOTHING_SPEC.key ? 0 : 1;
  return a.cost.netCost - b.cost.netCost || b.result.endingAfterTaxWealth - a.result.endingAfterTaxWealth || dnRank(a) - dnRank(b) || (a.spec.key < b.spec.key ? -1 : a.spec.key > b.spec.key ? 1 : 0) || (a.claimAges.primaryAge ?? 0) - (b.claimAges.primaryAge ?? 0) || (a.claimAges.spouseAge ?? 0) - (b.claimAges.spouseAge ?? 0);
}
function scoreAllCandidates(inputs, claimAges = enteredClaimInfo(inputs), opts) {
  const orders = opts?.searchOrders === false ? [inputs.drawOrder] : ALL_DRAW_ORDERS;
  const planOrderKey = drawOrderKey(inputs.drawOrder);
  const scored = [];
  const dnResult = simulateRothPlan(inputs, {
    id: "none",
    name: "Do Nothing",
    ceilings: null
  }, undefined, { leanDetail: true });
  scored.push({
    spec: {
      ...DO_NOTHING_SPEC,
      windowStopAge: inputs.windowStopAge,
      drawOrder: inputs.drawOrder
    },
    result: dnResult,
    cost: planNetCost(dnResult, inputs),
    claimAges
  });
  for (const spec of buildOptimizerCandidates(inputs, orders)) {
    const candidateInputs = spec.windowStopAge === inputs.windowStopAge && drawOrderKey(spec.drawOrder) === planOrderKey ? inputs : { ...inputs, windowStopAge: spec.windowStopAge, drawOrder: spec.drawOrder };
    const result = simulateRothPlan(candidateInputs, candidateStrategy(spec), undefined, {
      leanDetail: true
    });
    scored.push({
      spec,
      result,
      cost: planNetCost(result, inputs),
      claimAges
    });
  }
  scored.sort((a, b) => compareScoredCandidates(a, b, planOrderKey));
  return scored;
}
function runOptimizer(inputs, opts) {
  const scored = scoreAllCandidates(inputs, enteredClaimInfo(inputs), opts);
  const doNothing = scored.find((s) => s.spec.key === DO_NOTHING_SPEC.key) ?? scored[0];
  const winner = scored[0];
  return {
    candidatesTested: scored.length,
    doNothing,
    winner,
    runnersUp: scored.slice(1, 4),
    scored
  };
}
function claimAgeFloorMetFor(floor, winner) {
  if (floor == null)
    return null;
  if (winner.spec.key === DO_NOTHING_SPEC.key)
    return true;
  const age = winner.claimAges.primaryAge;
  if (age == null)
    return true;
  return age >= floor;
}
function claimAgeCombos(inputs) {
  const effPrimary = effectiveSsPrimaryAnnual(inputs);
  const effSpouse = effectiveSsSpouseAnnual(inputs);
  const searchedPrimary = effPrimary > 0 && inputs.ssPrimaryStartAge != null;
  const searchedSpouse = effSpouse > 0 && inputs.ssSpouseStartAge != null && inputs.birthYearSpouse != null;
  const currentAgePrimary = inputs.startYear - inputs.birthYearPrimary;
  const currentAgeSpouse = inputs.birthYearSpouse != null ? inputs.startYear - inputs.birthYearSpouse : null;
  const attainable = (searched, entered, currentAge) => {
    if (!searched || entered == null)
      return { ages: [entered], locked: false };
    if (currentAge != null && entered <= currentAge) {
      return { ages: [entered], locked: true };
    }
    const floorAge = currentAge ?? 62;
    const list = [62, 63, 64, 65, 66, 67, 68, 69, 70].filter((a) => a >= floorAge);
    if (!list.includes(entered) && entered >= 62)
      list.push(entered);
    list.sort((x, y) => x - y);
    return { ages: list, locked: false };
  };
  const primaryAtt = attainable(searchedPrimary, inputs.ssPrimaryStartAge, currentAgePrimary);
  const spouseAtt = attainable(searchedSpouse, inputs.ssSpouseStartAge, currentAgeSpouse);
  const combos = [];
  for (const pAge of primaryAtt.ages) {
    for (const sAge of spouseAtt.ages) {
      const primaryAnnual = searchedPrimary && pAge != null ? ssAnnualAtClaimAge(effPrimary, inputs.ssPrimaryStartAge, pAge, inputs.birthYearPrimary) : effPrimary;
      const spouseAnnual = searchedSpouse && sAge != null && inputs.birthYearSpouse != null ? ssAnnualAtClaimAge(effSpouse, inputs.ssSpouseStartAge, sAge, inputs.birthYearSpouse) : effSpouse;
      combos.push({
        inputs: {
          ...inputs,
          ssPrimaryAnnual: primaryAnnual,
          ssPrimaryStartAge: pAge,
          ssSpouseAnnual: spouseAnnual,
          ssSpouseStartAge: sAge
        },
        claimAges: {
          primaryAge: pAge,
          spouseAge: sAge,
          primaryAnnual,
          spouseAnnual,
          searchedPrimary,
          searchedSpouse,
          lockedPrimary: primaryAtt.locked,
          lockedSpouse: spouseAtt.locked
        },
        isEntered: pAge === inputs.ssPrimaryStartAge && sAge === inputs.ssSpouseStartAge
      });
    }
  }
  return combos;
}
var SCREEN_CEILINGS = [
  { ...NO_CEILINGS, bracketTopPct: 12 },
  { ...NO_CEILINGS, bracketTopPct: 22 },
  { ...NO_CEILINGS, bracketTopPct: 24 },
  { ...NO_CEILINGS, irmaaTierCap: 0 },
  { ...NO_CEILINGS, irmaaTierCap: 1 },
  { ...NO_CEILINGS, bracketTopPct: 22, irmaaTierCap: 1 },
  { ...NO_CEILINGS, acaCliffCap: true },
  { ...NO_CEILINGS, magiCap: 250000 }
];
function screenSpecs(inputs) {
  const all = buildOptimizerCandidates(inputs, [inputs.drawOrder]).filter((s) => !s.guardrail && !s.bunching && !s.gainsHarvest);
  const windowKind = all.some((s) => s.windowKind === "stopRmd") ? "stopRmd" : all[0]?.windowKind ?? "throughRmd";
  const specs = [];
  for (const ceilings of SCREEN_CEILINGS) {
    const spec = all.find((s) => s.windowKind === windowKind && ceilingsKey(s.ceilings) === ceilingsKey(ceilings));
    if (spec)
      specs.push(spec);
  }
  return specs;
}
function computeJointOptimizer(inputs) {
  const combos = claimAgeCombos(inputs);
  const first = combos[0];
  const floor = inputs.claimAgeFloor ?? null;
  const info = {
    searchedPrimary: first?.claimAges.searchedPrimary ?? false,
    searchedSpouse: first?.claimAges.searchedSpouse ?? false,
    declaredPrimary: inputs.ssPrimaryNoBenefit === true,
    declaredSpouse: inputs.ssSpouseNoBenefit === true,
    combosTested: combos.length,
    screenStrategiesPerCombo: SCREEN_CEILINGS.length + 1,
    finalistCombos: 1,
    claimAgeFloor: floor,
    lockedPrimary: first?.claimAges.lockedPrimary === true,
    lockedSpouse: first?.claimAges.lockedSpouse === true,
    lockedPrimaryAge: first?.claimAges.lockedPrimary === true ? first.claimAges.primaryAge : null,
    lockedSpouseAge: first?.claimAges.lockedSpouse === true ? first.claimAges.spouseAge : null,
    drawOrderLabel: drawOrderLabel(inputs.drawOrder)
  };
  const distinctAges = (pick) => [...new Set(combos.map(pick).filter((a) => a != null))].sort((x, y) => x - y);
  if (info.searchedPrimary && !info.lockedPrimary) {
    info.searchedPrimaryAges = distinctAges((c) => c.claimAges.primaryAge);
  }
  if (info.searchedSpouse && !info.lockedSpouse) {
    info.searchedSpouseAges = distinctAges((c) => c.claimAges.spouseAge);
  }
  if (combos.length <= 1) {
    const res = runOptimizer(inputs);
    const met = claimAgeFloorMetFor(floor, res.winner);
    info.claimAgeFloorMet = met;
    info.winnerPrimaryAge = res.winner.claimAges.primaryAge;
    info.winnerIsDoNothing = res.winner.spec.key === DO_NOTHING_SPEC.key;
    info.claimAgeTableEmpty = true;
    return { ...res, jointSearch: info, claimAgeTable: [], claimAgeFloorMet: met };
  }
  const specs = screenSpecs(inputs);
  info.screenStrategiesPerCombo = specs.length + 1;
  const screened = combos.map((combo) => {
    const dnResult = simulateRothPlan(combo.inputs, {
      id: "none",
      name: "Do Nothing",
      ceilings: null
    }, undefined, { leanDetail: true });
    const doNothingCost = planNetCost(dnResult, inputs).netCost;
    let best = doNothingCost;
    for (const spec of specs) {
      const candidateInputs = spec.windowStopAge === combo.inputs.windowStopAge ? combo.inputs : { ...combo.inputs, windowStopAge: spec.windowStopAge };
      const result = simulateRothPlan(candidateInputs, candidateStrategy(spec), undefined, {
        leanDetail: true
      });
      const cost = planNetCost(result, inputs).netCost;
      if (cost < best)
        best = cost;
    }
    return { combo, best, doNothingCost };
  });
  const byScreen = [...screened].sort((a, b) => a.best - b.best || (a.combo.claimAges.primaryAge ?? 0) - (b.combo.claimAges.primaryAge ?? 0) || (a.combo.claimAges.spouseAge ?? 0) - (b.combo.claimAges.spouseAge ?? 0));
  const finalists = byScreen.map((s) => s.combo);
  info.finalistCombos = finalists.length;
  const scoredAll = [];
  for (const combo of finalists) {
    scoredAll.push(...scoreAllCandidates(combo.inputs, combo.claimAges, { searchOrders: false }));
  }
  scoredAll.sort(compareJointCandidates);
  const eligible = floor == null ? scoredAll : scoredAll.filter((s) => s.claimAges.primaryAge == null || s.claimAges.primaryAge >= floor);
  const winner = eligible[0] ?? scoredAll[0];
  const doNothing = scoredAll.filter((s) => s.spec.key === DO_NOTHING_SPEC.key).sort(compareJointCandidates)[0] ?? winner;
  const runnersUp = [];
  for (const s of eligible) {
    if (runnersUp.length >= 3)
      break;
    if (s.spec.key === winner.spec.key && s.claimAges.primaryAge === winner.claimAges.primaryAge && s.claimAges.spouseAge === winner.claimAges.spouseAge) {
      continue;
    }
    runnersUp.push(s);
  }
  const claimAgeTable = [];
  if (info.searchedPrimary) {
    const bestByAge = new Map;
    for (const s of scoredAll) {
      const age = s.claimAges.primaryAge;
      if (age == null || bestByAge.has(age))
        continue;
      bestByAge.set(age, s);
    }
    for (const age of [...bestByAge.keys()].sort((a, b) => a - b)) {
      const best = bestByAge.get(age);
      claimAgeTable.push({
        primaryAge: age,
        primaryAnnual: best.claimAges.primaryAnnual,
        survivorAnnual: Math.max(best.claimAges.primaryAnnual, best.claimAges.spouseAnnual),
        belowFloor: floor != null && age < floor,
        isWinner: best === winner,
        best
      });
    }
  }
  const met = claimAgeFloorMetFor(floor, winner);
  info.claimAgeFloorMet = met;
  info.winnerPrimaryAge = winner.claimAges.primaryAge;
  info.winnerIsDoNothing = winner.spec.key === DO_NOTHING_SPEC.key;
  info.claimAgeTableEmpty = claimAgeTable.length === 0;
  return {
    candidatesTested: scoredAll.length,
    doNothing,
    winner,
    runnersUp,
    scored: scoredAll,
    jointSearch: info,
    claimAgeTable,
    claimAgeFloorMet: met
  };
}
var jointOptimizerCache = new Map;
function jointInputsKey(inputs) {
  const sortValue = (v) => {
    if (Array.isArray(v))
      return v.map(sortValue);
    if (v != null && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v).sort()) {
        out[k] = sortValue(v[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sortValue(inputs));
}
function runJointOptimizer(inputs) {
  const key = jointInputsKey(inputs);
  const hit = jointOptimizerCache.get(key);
  if (hit)
    return structuredClone(hit);
  const result = computeJointOptimizer(inputs);
  if (jointOptimizerCache.size >= 50)
    jointOptimizerCache.clear();
  jointOptimizerCache.set(key, structuredClone(result));
  return result;
}
function countedSpousePretax(inp) {
  return inp.filingStatus === "mfj" ? inp.pretaxBalanceSpouse ?? null : null;
}
function pricePlaygroundYear(inp) {
  const fs = inp.filingStatus;
  const joint = fs === "mfj";
  const ageSpouse = joint ? inp.ageSpouse : null;
  const law = lawForYear(inp.taxYear);
  const inflationPct = inp.inflationPct != null && Number.isFinite(inp.inflationPct) && inp.inflationPct > -100 ? inp.inflationPct : 0;
  const ssBenefits = r22(inp.ssPrimary + (joint ? inp.ssSpouse : 0));
  const spendingDraw = Math.max(0, inp.spendingDraw ?? 0);
  const moneyOut = r22(inp.conversion + spendingDraw);
  const cashDraw = Math.max(0, inp.cashDraw ?? 0);
  const rothDraw = Math.max(0, inp.rothDraw ?? 0);
  const qualifiedDividends = r22(Math.min(Math.max(0, inp.qualifiedDividends), Math.max(0, inp.ordinaryDividends)));
  const nonQualifiedDividends = r22(Math.max(0, inp.ordinaryDividends - qualifiedDividends));
  const otherOrdinaryTotal = r22(inp.interest + nonQualifiedDividends + inp.otherOrdinary);
  const stockGain = r22(inp.stockSold - inp.stockBasis);
  const carryInSt = Math.max(0, inp.capitalLossCarryInSt ?? 0);
  const carryInLt = Math.max(0, inp.capitalLossCarryInLt ?? 0);
  const carryInStWa = Math.max(0, inp.capitalLossCarryInStWa ?? 0);
  const carryInLtWa = Math.max(0, inp.capitalLossCarryInLtWa ?? 0);
  const lossLedgerOn = carryInSt > 0 || carryInLt > 0 || stockGain < 0;
  const gainsFieldsFor = (grossGains) => {
    if (!lossLedgerOn) {
      return {
        ltcg: grossGains,
        capitalLossAllowance: Math.min(3000, Math.max(0, -grossGains))
      };
    }
    const led = applyLossLedger({ st: carryInSt, lt: carryInLt }, grossGains, fs, Number.POSITIVE_INFINITY, { st: carryInStWa, lt: carryInLtWa });
    return {
      ltcg: led.netResult,
      capitalLossAllowance: led.allowance,
      waGainsBase: r22(grossGains - led.waAbsorbedByGains)
    };
  };
  let ltcgNet = stockGain;
  let capitalLossAllowance = Math.min(3000, Math.max(0, -stockGain));
  let waGainsBase;
  {
    const f0 = gainsFieldsFor(stockGain);
    ltcgNet = f0.ltcg;
    capitalLossAllowance = f0.capitalLossAllowance;
    waGainsBase = f0.waGainsBase;
  }
  const spouseBalanceCounted = countedSpousePretax(inp);
  const hasSpouseBalance = spouseBalanceCounted != null;
  const totalPretaxBalance = inp.pretaxBalance == null && !hasSpouseBalance ? null : r22((inp.pretaxBalance ?? 0) + (spouseBalanceCounted ?? 0));
  let rmdPrimary = 0;
  let rmdSpouse = 0;
  let rmdDivisor = null;
  let rmdTable = null;
  if (inp.pretaxBalance != null || hasSpouseBalance) {
    const r = rmdForYear({
      priorDec31PreTax: inp.pretaxBalance ?? 0,
      agePrimary: inp.agePrimary,
      ageSpouse,
      birthYearPrimary: inp.taxYear - inp.agePrimary,
      spouseSoleBeneficiary: inp.spouseSoleBeneficiary
    });
    rmdPrimary = r.rmd;
    rmdDivisor = r.divisor;
    rmdTable = r.table;
  }
  if (hasSpouseBalance && joint && ageSpouse != null) {
    const rs = rmdForYear({
      priorDec31PreTax: inp.pretaxBalanceSpouse ?? 0,
      agePrimary: ageSpouse,
      ageSpouse: inp.agePrimary,
      birthYearPrimary: inp.taxYear - ageSpouse,
      spouseSoleBeneficiary: inp.primarySoleBeneficiaryOfSpouse === true
    });
    rmdSpouse = rs.rmd;
    if (rmdDivisor == null && rs.divisor != null) {
      rmdDivisor = rs.divisor;
      rmdTable = rs.table;
    }
  }
  const rmdGross = r22(rmdPrimary + rmdSpouse);
  const rmdAlreadyReceived = Math.min(rmdGross, Math.max(0, inp.rmdAlreadyReceived ?? 0));
  const rmd = r22(rmdGross - rmdAlreadyReceived);
  const dependentMagiForAca = Math.max(0, inp.dependentMagiForAca ?? 0);
  const base = {
    calendarYear: inp.taxYear,
    filingStatus: fs,
    agePrimary: inp.agePrimary,
    ageSpouse,
    otherOrdinary: inp.otherOrdinary,
    interestIncome: inp.interest,
    ordinaryDividends: nonQualifiedDividends,
    rmd,
    conversion: moneyOut,
    extraPreTaxDraw: 0,
    ssBenefits,
    taxExemptInterest: inp.taxExemptInterest,
    ltcg: ltcgNet,
    ...waGainsBase != null ? { waGainsBase } : {},
    qualifiedDividends,
    capitalLossAllowance,
    inflationPct,
    stateRatePct: inp.stateRatePct,
    residenceState: inp.residenceState ?? null,
    itemizedMortgageInterest: inp.itemizedMortgageInterest,
    itemizedSaltPaid: inp.itemizedSaltPaid,
    itemizedCharitable: inp.itemizedCharitable,
    itemizedOther: inp.itemizedOther,
    educationStudents: inp.educationStudents ?? null
  };
  let harvestedGain = 0;
  const harvestPool = inp.harvestPoolAmount ?? null;
  const harvestBasisPct = inp.harvestPoolBasisPct ?? null;
  if (harvestPool != null && harvestBasisPct != null) {
    const pool = Math.max(0, harvestPool);
    const basisPct = Math.max(0, harvestBasisPct);
    const basisDollars = basisPct / 100 * pool;
    const saleProceeds = Math.max(0, inp.stockSold);
    const saleBasis = Math.max(0, inp.stockBasis);
    const poolLeft = Math.max(0, pool - saleProceeds);
    const basisLeft = Math.max(0, basisDollars - saleBasis);
    const availableGain = Math.max(0, poolLeft - basisLeft);
    if (availableGain > 0) {
      const settled = priceYear(base);
      const settledAt15 = settled.gainsAt15;
      const settledAt20 = settled.gainsAt20;
      const harvestFits = (h) => {
        const f = gainsFieldsFor(stockGain + h);
        const p = priceYear({
          ...base,
          ltcg: f.ltcg,
          capitalLossAllowance: f.capitalLossAllowance,
          ...f.waGainsBase != null ? { waGainsBase: f.waGainsBase } : {}
        });
        return p.gainsAt15 <= settledAt15 + 0.005 && p.gainsAt20 <= settledAt20 + 0.005;
      };
      if (harvestFits(0)) {
        let lo = 0;
        let hi = Math.floor(availableGain * 100);
        while (lo < hi) {
          const mid = Math.floor((lo + hi + 1) / 2);
          if (harvestFits(mid / 100)) {
            lo = mid;
          } else {
            hi = mid - 1;
          }
        }
        if (lo > 0) {
          harvestedGain = lo / 100;
          const fH = gainsFieldsFor(stockGain + harvestedGain);
          ltcgNet = fH.ltcg;
          capitalLossAllowance = fH.capitalLossAllowance;
          waGainsBase = fH.waGainsBase;
          base.ltcg = fH.ltcg;
          base.capitalLossAllowance = fH.capitalLossAllowance;
          if (fH.waGainsBase != null) {
            base.waGainsBase = fH.waGainsBase;
          } else {
            delete base.waGainsBase;
          }
        }
      }
    }
  }
  const ltcgPriced = r22(Math.max(0, ltcgNet) + qualifiedDividends);
  const capitalLoss = Math.max(0, -ltcgNet);
  const prefTyped = r22(ltcgNet + qualifiedDividends);
  const priced = priceYear(base);
  const pricedZero = priceYear({ ...base, conversion: spendingDraw });
  let lossCarryOutSt = 0;
  let lossCarryOutLt = 0;
  let lossCarryOutStWa = 0;
  let lossCarryOutLtWa = 0;
  if (lossLedgerOn) {
    const ledFinal = applyLossLedger({ st: carryInSt, lt: carryInLt }, stockGain + harvestedGain, fs, priced.taxableIncomeBeforeLossAllowance, { st: carryInStWa, lt: carryInLtWa });
    lossCarryOutSt = ledFinal.carryOut.st;
    lossCarryOutLt = ledFinal.carryOut.lt;
    lossCarryOutStWa = ledFinal.waCarryOut.st;
    lossCarryOutLtWa = ledFinal.waCarryOut.lt;
  }
  let landingBracketPct = null;
  let landingBracketTop = null;
  let landingRoomLeft = null;
  let landingExactlyFilled = false;
  const topLayer = priced.bracketLayers[priced.bracketLayers.length - 1] ?? null;
  if (inp.conversion > 0 && topLayer != null && priced.ordinaryTaxableIncome > pricedZero.ordinaryTaxableIncome + 0.005) {
    landingBracketPct = topLayer.ratePct;
    landingBracketTop = topLayer.to;
    if (topLayer.to != null) {
      const room = topLayer.to - priced.ordinaryTaxableIncome;
      landingRoomLeft = r22(Math.max(0, room));
      landingExactlyFilled = Math.abs(room) < 0.01;
    }
  }
  const notMedicareCount = (inp.onMedicarePrimary ? 0 : 1) + (joint && !inp.onMedicareSpouse ? 1 : 0);
  const acaApplies = notMedicareCount > 0;
  const newestGuidelineYear = Math.max(...Object.keys(FPL_GUIDELINES).map(Number));
  const acaCoverageYear = inp.acaConvention === "newest" && inp.taxYear >= 2026 ? Math.max(inp.taxYear, newestGuidelineYear + 1) : inp.taxYear;
  const acaProjected = inp.acaConvention === "newest";
  let aca = {
    applies: acaApplies,
    everyoneOnMedicare: notMedicareCount === 0,
    householdSize: inp.acaHouseholdSize,
    fpl: null,
    cliff: null,
    pctFpl: null,
    overCliff: false,
    positionDollars: null,
    credit: null,
    applicablePct: null
  };
  const acaHouseholdMagi = r22(priced.acaMagi + dependentMagiForAca);
  if (acaApplies && inp.acaHouseholdSize != null) {
    const res = acaCreditFor({
      magi: acaHouseholdMagi,
      householdSize: inp.acaHouseholdSize,
      coverageYear: acaCoverageYear,
      tableYear: inp.taxYear,
      benchmarkAnnual: inp.acaBenchmarkAnnual ?? 0,
      projected: acaProjected
    });
    aca = {
      ...aca,
      fpl: res.fpl,
      cliff: res.cliff,
      pctFpl: res.pctFpl,
      overCliff: res.overCliff,
      positionDollars: r22(res.cliff - acaHouseholdMagi),
      credit: inp.acaBenchmarkAnnual != null ? res.credit : null,
      applicablePct: inp.acaBenchmarkAnnual != null ? res.applicablePct : null
    };
  }
  const premiumYear = inp.taxYear + 2;
  const premiumLaw = lawForYear(premiumYear);
  const personsOnMedicare = (inp.agePrimary + 2 >= 65 ? 1 : 0) + (joint && ageSpouse != null && ageSpouse + 2 >= 65 ? 1 : 0);
  const tier = irmaaTierFor(priced.magi, fs, premiumLaw, premiumYear, inflationPct);
  const annualPerPerson = irmaaAnnualPerPerson(tier, premiumLaw);
  const nextTierRaw = irmaaTierUpTo(tier, fs, premiumLaw, premiumYear, inflationPct);
  const irmaa = {
    applies: personsOnMedicare > 0,
    personsOnMedicare,
    tier,
    premiumYear,
    monthlyPerPerson: r22(annualPerPerson / 12),
    annualPerPerson,
    annualHousehold: r22(annualPerPerson * personsOnMedicare),
    nextTierLine: Number.isFinite(nextTierRaw) ? nextTierRaw : null,
    roomToNextTier: Number.isFinite(nextTierRaw) ? r22(Math.max(0, nextTierRaw - priced.magi)) : null
  };
  const pricedWithoutGains = priceYear({
    ...base,
    ltcg: 0,
    qualifiedDividends: 0,
    capitalLossAllowance: 0
  });
  const hasGainsTyped = stockGain !== 0 || qualifiedDividends !== 0;
  const withoutAcaHouseholdMagi = r22(pricedWithoutGains.acaMagi + dependentMagiForAca);
  let withoutAcaOverCliff = false;
  let withoutAcaPosition = null;
  let withoutAcaCredit = null;
  if (acaApplies && inp.acaHouseholdSize != null) {
    const resW = acaCreditFor({
      magi: withoutAcaHouseholdMagi,
      householdSize: inp.acaHouseholdSize,
      coverageYear: acaCoverageYear,
      tableYear: inp.taxYear,
      benchmarkAnnual: inp.acaBenchmarkAnnual ?? 0,
      projected: acaProjected
    });
    withoutAcaOverCliff = resW.overCliff;
    withoutAcaPosition = r22(resW.cliff - withoutAcaHouseholdMagi);
    withoutAcaCredit = inp.acaBenchmarkAnnual != null ? resW.credit : null;
  }
  const gainsPhrase = prefTyped < 0 ? `the ${fmtDollars2(-prefTyped)} loss` : `the ${fmtDollars2(prefTyped)} gain`;
  let acaFlag = null;
  if (hasGainsTyped && acaApplies && aca.cliff != null && aca.positionDollars != null && withoutAcaPosition != null) {
    const flipped = aca.overCliff !== withoutAcaOverCliff;
    const creditChanged = inp.acaBenchmarkAnnual != null && (aca.credit != null || withoutAcaCredit != null) && aca.credit !== withoutAcaCredit;
    if (flipped && aca.overCliff) {
      const creditClause = inp.acaBenchmarkAnnual != null && withoutAcaCredit != null ? ` and the credit would be ${fmtDollars2(withoutAcaCredit)}` : "";
      acaFlag = {
        kind: "flipped-over",
        gainsStack: prefTyped,
        typedOverCliff: aca.overCliff,
        withoutOverCliff: withoutAcaOverCliff,
        typedPositionDollars: aca.positionDollars,
        withoutPositionDollars: withoutAcaPosition,
        typedCredit: aca.credit,
        withoutCredit: withoutAcaCredit,
        withoutAcaMagi: withoutAcaHouseholdMagi,
        text: `Over the cliff by ${fmtDollars2(-aca.positionDollars)} — ${gainsPhrase} is what put you over; without it you'd be under by ${fmtDollars2(withoutAcaPosition)}${creditClause}.`
      };
    } else if (flipped && !aca.overCliff) {
      const creditClause = inp.acaBenchmarkAnnual != null && withoutAcaCredit != null ? ` and the credit would be ${fmtDollars2(withoutAcaCredit)}` : "";
      acaFlag = {
        kind: "flipped-under",
        gainsStack: prefTyped,
        typedOverCliff: aca.overCliff,
        withoutOverCliff: withoutAcaOverCliff,
        typedPositionDollars: aca.positionDollars,
        withoutPositionDollars: withoutAcaPosition,
        typedCredit: aca.credit,
        withoutCredit: withoutAcaCredit,
        withoutAcaMagi: withoutAcaHouseholdMagi,
        text: `Under the cliff by ${fmtDollars2(aca.positionDollars)} — ${gainsPhrase} is what kept you under; without it you'd be over by ${fmtDollars2(-withoutAcaPosition)}${creditClause}.`
      };
    } else if (creditChanged) {
      const verb = (aca.credit ?? 0) < (withoutAcaCredit ?? 0) ? "shrank" : "increased";
      acaFlag = {
        kind: "credit-changed",
        gainsStack: prefTyped,
        typedOverCliff: aca.overCliff,
        withoutOverCliff: withoutAcaOverCliff,
        typedPositionDollars: aca.positionDollars,
        withoutPositionDollars: withoutAcaPosition,
        typedCredit: aca.credit,
        withoutCredit: withoutAcaCredit,
        withoutAcaMagi: withoutAcaHouseholdMagi,
        text: `${gainsPhrase.charAt(0).toUpperCase()}${gainsPhrase.slice(1)} ${verb} the credit — ${fmtDollars2(aca.credit ?? 0)} with it, ${fmtDollars2(withoutAcaCredit ?? 0)} without it.`
      };
    }
  }
  let irmaaFlag = null;
  const withoutTier = irmaaTierFor(pricedWithoutGains.magi, fs, premiumLaw, premiumYear, inflationPct);
  if (hasGainsTyped && personsOnMedicare > 0 && tier !== withoutTier) {
    const lowerTier = Math.min(tier, withoutTier);
    const lineRaw = irmaaTierUpTo(lowerTier, fs, premiumLaw, premiumYear, inflationPct);
    const line = Number.isFinite(lineRaw) ? lineRaw : null;
    if (tier > withoutTier) {
      irmaaFlag = {
        kind: "tier-up",
        gainsStack: prefTyped,
        typedTier: tier,
        withoutTier,
        premiumYear: inp.taxYear + 2,
        line,
        text: line != null ? `Tier ${tier} for ${inp.taxYear + 2} — ${gainsPhrase} pushed you past the ${fmtDollars2(line)} line; without it, ${withoutTier === 0 ? "no surcharge (Tier 0)" : `Tier ${withoutTier}`}.` : `Tier ${tier} for ${inp.taxYear + 2} — ${gainsPhrase} pushed you up from Tier ${withoutTier}; without it, ${withoutTier === 0 ? "no surcharge (Tier 0)" : `Tier ${withoutTier}`}.`
      };
    } else {
      irmaaFlag = {
        kind: "tier-down",
        gainsStack: prefTyped,
        typedTier: tier,
        withoutTier,
        premiumYear: inp.taxYear + 2,
        line,
        text: line != null ? `Tier ${tier} for ${inp.taxYear + 2} — ${gainsPhrase} is what kept you under the ${fmtDollars2(line)} line; without it, Tier ${withoutTier}.` : `Tier ${tier} for ${inp.taxYear + 2} — ${gainsPhrase} is what kept you at Tier ${tier}; without it, Tier ${withoutTier}.`
      };
    }
  }
  const gainsFlags = {
    gainsStack: prefTyped,
    hasGainsTyped,
    withoutMagi: pricedWithoutGains.magi,
    withoutAcaMagi: withoutAcaHouseholdMagi,
    withoutTier,
    acaFlag,
    irmaaFlag
  };
  let saleAfterTax = null;
  if (inp.stockSold > 0) {
    const proceeds = Math.round(inp.stockSold);
    const totalTax = Math.round(priced.federalTax) + Math.round(priced.stateTax);
    const leftover = proceeds - totalTax;
    saleAfterTax = {
      proceeds,
      totalTax,
      leftover,
      text: leftover >= 0 ? `Sale brought in ${fmtDollars2(proceeds)}. After this year's total tax of ${fmtDollars2(totalTax)}, ${fmtDollars2(leftover)} of it is left.` : `Sale brought in ${fmtDollars2(proceeds)}. This year's total tax is ${fmtDollars2(totalTax)} — ${fmtDollars2(-leftover)} more than the sale brought in.`
    };
  }
  const yieldReinvested = inp.yieldReinvested === true;
  const reinvestedYield = yieldReinvested ? r22(inp.interest + inp.ordinaryDividends) : 0;
  const cashIn = r22(inp.interest + inp.ordinaryDividends - reinvestedYield + inp.otherOrdinary + inp.taxExemptInterest + ssBenefits + rmd + spendingDraw + cashDraw + rothDraw + inp.stockSold);
  const totalTaxBill = r22(priced.federalTax + priced.stateTax);
  let netTaxBill = r22(totalTaxBill - priced.educationRefundable);
  let settlementPriced = false;
  if (inp.aptcTaken != null) {
    const settlementCliff = inp.taxYear >= 2026 ? aca.cliff : null;
    const settlementOverCliff = settlementCliff != null && aca.overCliff;
    const cappedCredit = aca.credit == null ? null : inp.acaEnrollmentPremiumAnnual == null ? aca.credit : Math.min(aca.credit, inp.acaEnrollmentPremiumAnnual);
    const finalCredit = settlementOverCliff ? 0 : cappedCredit == null ? null : r22(Math.max(0, cappedCredit - (inp.acaCoverageReduction ?? 0)));
    const acaInPlay = !inp.onMedicarePrimary || inp.filingStatus === "mfj" && !inp.onMedicareSpouse;
    const effectiveFinalCredit = finalCredit != null ? finalCredit : acaInPlay ? null : 0;
    const creditStillDue = effectiveFinalCredit != null ? r22(Math.max(0, effectiveFinalCredit - inp.aptcTaken)) : null;
    const excessAptcRepayment = effectiveFinalCredit == null ? null : inp.taxYear >= 2026 ? r22(Math.max(0, inp.aptcTaken - effectiveFinalCredit)) : inp.aptcTaken <= effectiveFinalCredit ? 0 : null;
    if (excessAptcRepayment != null) {
      netTaxBill = r22(totalTaxBill - (creditStillDue ?? 0) + excessAptcRepayment - priced.educationRefundable);
      settlementPriced = true;
    }
  }
  const cashLeftAfterTax = r22(cashIn - netTaxBill);
  const healthGrossAcaPg = inp.healthPremiumAcaAnnual != null && aca.applies ? Math.max(0, inp.healthPremiumAcaAnnual) : 0;
  const healthMedicarePersonsPg = (inp.onMedicarePrimary ? 1 : 0) + (joint && inp.onMedicareSpouse ? 1 : 0);
  const healthGrossMedicarePg = inp.healthPremiumMedicarePerPerson != null ? r22(Math.max(0, inp.healthPremiumMedicarePerPerson) * healthMedicarePersonsPg) : 0;
  const healthPremiumGross = r22(healthGrossAcaPg + healthGrossMedicarePg);
  const healthCreditTowardPremium = settlementPriced ? Math.max(0, inp.aptcTaken ?? 0) : Math.min(aca.credit ?? 0, healthGrossAcaPg);
  const healthPremiumNet = r22(healthGrossMedicarePg + (healthGrossAcaPg > 0 ? Math.max(0, healthGrossAcaPg - healthCreditTowardPremium) : 0));
  const irmaaPayableAnnual = r22(Math.max(0, inp.irmaaPayableAnnual ?? 0));
  const cashLeftAfterHealthPremium = r22(cashLeftAfterTax - healthPremiumNet - irmaaPayableAnnual);
  const annualSpending = inp.annualSpending ?? null;
  const cashLeftVsSpending = annualSpending == null ? null : r22(cashLeftAfterHealthPremium - annualSpending);
  return {
    interest: inp.interest,
    ordinaryDividends: inp.ordinaryDividends,
    nonQualifiedDividends,
    otherOrdinary: inp.otherOrdinary,
    otherOrdinaryTotal,
    rmdPriced: totalPretaxBalance != null,
    rmd,
    rmdGross,
    rmdPrimary,
    rmdSpouse,
    rmdAlreadyReceived,
    dependentMagiForAca,
    rmdDivisor,
    rmdTable,
    ssBenefits,
    ssTaxable: priced.ssTaxable,
    ssPctTaxed: ssBenefits > 0 ? r22(priced.ssTaxable / ssBenefits * 100) : 0,
    taxExemptInterest: inp.taxExemptInterest,
    conversion: inp.conversion,
    stockGain,
    qualifiedDividends,
    ordinaryDividendsEntered: inp.ordinaryDividends,
    qualifiedDividendsEntered: inp.qualifiedDividends,
    qualifiedDividendsWasClamped: r22(Math.max(0, inp.qualifiedDividends)) > qualifiedDividends,
    qualifiedDividendsExcess: r22(Math.max(0, Math.max(0, inp.qualifiedDividends) - qualifiedDividends)),
    ltcgNet,
    ltcgPriced,
    capitalLoss,
    capitalLossAllowance,
    lossCarryOutSt,
    lossCarryOutLt,
    lossCarryOutStWa,
    lossCarryOutLtWa,
    harvestedGain,
    agi: priced.agi,
    magi: priced.magi,
    acaMagi: acaHouseholdMagi,
    baseStandardDeduction: priced.baseStandardDeduction,
    age65AddonTotal: priced.age65AddonTotal,
    count65: priced.count65,
    standardDeduction: priced.standardDeduction,
    seniorDeduction: priced.seniorDeduction,
    itemizedDeduction: priced.itemizedDeduction,
    itemizedSaltAllowed: priced.itemizedSaltAllowed,
    deductionTaken: priced.deductionTaken,
    itemizedCharitableAllowed: priced.itemizedCharitableAllowed,
    section68Reduction: priced.section68Reduction,
    nonItemizerCharitableDeduction: priced.nonItemizerCharitableDeduction,
    educationAotc: priced.educationAotc,
    educationLlc: priced.educationLlc,
    educationChoice: priced.educationChoice,
    educationNonrefundable: priced.educationNonrefundable,
    educationRefundable: priced.educationRefundable,
    amti: priced.amti,
    amtExemption: priced.amtExemption,
    amtTentativeTax: priced.amtTentativeTax,
    amtOwed: priced.amtOwed,
    deductions: priced.deductions,
    taxableIncome: priced.taxableIncome,
    ordinaryTaxableIncome: priced.ordinaryTaxableIncome,
    gainsInTaxableIncome: priced.gainsInTaxableIncome,
    bracketLayers: priced.bracketLayers,
    gainsAt0: priced.gainsAt0,
    gainsAt15: priced.gainsAt15,
    gainsAt20: priced.gainsAt20,
    gainsZeroRoomLeft: r22(Math.max(0, law.ltcgZeroTop[fs] - priced.ordinaryTaxableIncome - priced.gainsAt0)),
    ordinaryTax: priced.ordinaryTax,
    ltcgTax: priced.ltcgTax,
    niit: priced.niit,
    federalTax: priced.federalTax,
    stateTax: priced.stateTax,
    waGains: priced.waGains,
    waStandardDeduction: priced.waStandardDeduction,
    waTaxableGains: priced.waTaxableGains,
    totalTax: r22(priced.federalTax + priced.stateTax),
    netTaxBill,
    cashIn,
    cashLeftAfterTax,
    yieldReinvested,
    reinvestedYield,
    cashDraw,
    rothDraw,
    spendingDraw,
    inflationPct,
    healthPremiumGross,
    healthPremiumNet,
    irmaaPayableAnnual,
    cashLeftAfterHealthPremium,
    annualSpending,
    cashLeftVsSpending,
    landingBracketPct,
    landingBracketTop,
    landingRoomLeft,
    landingExactlyFilled,
    conversionFederalCost: r22(priced.federalTax - pricedZero.federalTax),
    conversionTotalCost: r22(priced.federalTax + priced.stateTax - (pricedZero.federalTax + pricedZero.stateTax)),
    conversionExceedsBalance: totalPretaxBalance != null && moneyOut > totalPretaxBalance - rmdGross + 0.005,
    aca,
    irmaa,
    gainsFlags,
    saleAfterTax
  };
}
function planInputsFromSaved(saved, startYear) {
  if (saved.birthYearPrimary == null)
    return null;
  const dollars = (cents) => cents == null ? 0 : cents / 100;
  const retirementAge = saved.retirementAge ?? 57;
  const birthYearPrimary = saved.birthYearPrimary;
  const planInputs = {
    startYear,
    birthYearPrimary,
    birthYearSpouse: saved.birthYearSpouse,
    filingStatus: saved.filingStatus ?? "mfj",
    endAgePrimary: saved.endAge ?? 95,
    pretaxStart: dollars(saved.pretaxCents),
    pretaxSpouseStart: dollars(saved.pretaxSpouseCents ?? null),
    survivorEnabled: saved.survivorEnabled ?? false,
    survivorWho: saved.survivorWho ?? "primary",
    survivorDeathYear: saved.survivorDeathYear ?? null,
    rothStart: dollars(saved.rothCents),
    taxableStart: dollars(saved.taxableCents),
    hsaStart: dollars(saved.hsaCents),
    taxableBasisPct: saved.taxableBasisPct ?? 100,
    taxableBasisBlank: saved.taxableBasisPct == null && !(saved.taxableTiers != null && saved.taxableTiers.length > 0),
    taxableTiers: saved.taxableTiers ?? null,
    taxableDividendYieldPct: saved.taxableDividendYieldPct ?? saved.yieldFallbackDividendPct ?? null,
    taxableInterestYieldPct: saved.taxableInterestYieldPct ?? saved.yieldFallbackInterestPct ?? null,
    taxableDividendQualifiedPct: saved.qualifiedDividendSharePct ?? null,
    spendFromCashPct: saved.spendFromCashPct ?? null,
    spendFromCashSleeveStart: (saved.spendFromCashSleeveCents ?? 0) / 100,
    flexCutPct: saved.flexCutPct ?? null,
    flexFloorPct: saved.flexFloorPct ?? null,
    annualSpending: dollars(saved.annualSpendingCents),
    retirementAge,
    expectedReturnPct: saved.expectedReturnPct ?? blendedExpected(saved.stocksPct ?? STOCKS_PCT_DEFAULT),
    ssPrimaryAnnual: saved.ssPrimaryNoBenefit === true ? 0 : dollars(saved.ssPrimaryAnnualCents),
    ssPrimaryStartAge: saved.ssPrimaryStartAge,
    ssPrimaryNoBenefit: saved.ssPrimaryNoBenefit === true,
    ssSpouseAnnual: saved.ssSpouseNoBenefit === true ? 0 : dollars(saved.ssSpouseAnnualCents),
    ssSpouseStartAge: saved.ssSpouseStartAge,
    ssSpouseNoBenefit: saved.ssSpouseNoBenefit === true,
    otherOrdinaryAnnual: dollars(saved.otherOrdinaryCents),
    taxExemptInterestAnnual: dollars(saved.taxExemptInterestCents),
    convertedAlreadyThisYear: dollars(saved.convertedAlreadyCents),
    windowStartAge: saved.windowStartAge ?? retirementAge,
    windowStopAge: saved.windowStopAge ?? Math.ceil(rmdAgeForBirthYear(birthYearPrimary)) - 1,
    payTaxFrom: saved.payTaxFrom ?? "taxable",
    protectMinTaxable: dollars(saved.protectMinTaxableCents),
    preservePretax: dollars(saved.preservePretaxCents ?? null),
    preserveExitRatePct: saved.preserveExitRatePct ?? saved.heirRatePct ?? DEFAULT_HEIR_RATE_PCT,
    claimAgeFloor: saved.claimAgeFloor ?? null,
    drawOrder: drawOrderFromKey(saved.drawOrder),
    drawOrderSwitchAge: saved.drawOrderSwitchAge ?? null,
    drawOrderAfter: saved.drawOrderAfter != null ? drawOrderFromKey(saved.drawOrderAfter) : null,
    spouseSoleBeneficiary: saved.spouseSoleBeneficiary ?? true,
    primarySoleBeneficiaryOfSpouse: saved.primarySoleBeneficiaryOfSpouse ?? null,
    acaHouseholdSize: saved.acaHouseholdSize ?? 1,
    acaHouseholdSchedule: resolveAcaHouseholdSchedule(saved),
    acaBenchmarkCouple: saved.acaBenchmarkCoupleCents == null ? null : saved.acaBenchmarkCoupleCents / 100,
    acaBenchmarkSingle: saved.acaBenchmarkSingleCents == null ? null : saved.acaBenchmarkSingleCents / 100,
    acaBenchmarkFamily: saved.acaBenchmarkFamilyCents == null ? null : saved.acaBenchmarkFamilyCents / 100,
    acaSpouseEndAge: saved.acaSpouseEndAge ?? null,
    healthPremiumAcaHousehold: saved.healthPremiumAcaHouseholdCents == null ? null : saved.healthPremiumAcaHouseholdCents / 100,
    healthPremiumAcaSingle: saved.healthPremiumAcaSingleCents == null ? null : saved.healthPremiumAcaSingleCents / 100,
    healthPremiumMedicarePerPerson: saved.healthPremiumMedicarePerPersonCents == null ? null : saved.healthPremiumMedicarePerPersonCents / 100,
    inflationPct: saved.inflationPct ?? 2.5,
    stateRatePct: saved.stateRatePct ?? 0,
    residenceState: saved.residenceState ?? null,
    capitalLossCarryInSt: dollars(saved.capitalLossCarryInStCents ?? null),
    capitalLossCarryInLt: dollars(saved.capitalLossCarryInLtCents ?? null),
    capitalLossCarryInStWa: dollars(saved.capitalLossCarryInStWaCents ?? null),
    capitalLossCarryInLtWa: dollars(saved.capitalLossCarryInLtWaCents ?? null),
    itemizedMortgageInterest: dollars(saved.itemizedMortgageInterestCents ?? null),
    itemizedSaltPaid: dollars(saved.itemizedSaltPaidCents ?? null),
    itemizedCharitable: dollars(saved.itemizedCharitableCents ?? null),
    itemizedOther: dollars(saved.itemizedOtherCents ?? null),
    educationStudents: saved.educationStudents == null ? null : saved.educationStudents.map((s) => ({
      year: s.year,
      expenses: s.expensesCents / 100,
      aotcEligible: s.aotcEligible === true
    })),
    heirRatePct: saved.heirRatePct ?? DEFAULT_HEIR_RATE_PCT,
    ...saved.fafsaReportableAssetsCents != null ? { fafsaReportableAssets: saved.fafsaReportableAssetsCents / 100 } : {},
    collegeFallFromYear: saved.collegeFallFromYear ?? null,
    collegeFallThroughYear: saved.collegeFallThroughYear ?? null
  };
  const embeddedNetPremium = acaEmbeddedNetPremiumFor(planInputs);
  if (embeddedNetPremium != null) {
    planInputs.acaEmbeddedNetPremium = embeddedNetPremium;
  }
  return planInputs;
}
function compareStrategyFromSaved(saved) {
  const c = saved.ceilings ?? null;
  const anyCeiling = c != null && (c.bracketTopPct != null || c.irmaaTierCap != null || c.ltcgZeroCap || c.acaCliffCap || c.magiCapCents != null);
  const ceilings = anyCeiling ? {
    bracketTopPct: c.bracketTopPct,
    irmaaTierCap: c.irmaaTierCap,
    ltcgZeroCap: c.ltcgZeroCap,
    acaCliffCap: c.acaCliffCap,
    acaCliffCapFamilyOnly: c.acaCliffCapFamilyOnly === true,
    magiCap: c.magiCapCents == null ? null : c.magiCapCents / 100,
    acaCliffBuffer: c.acaCliffBufferCents == null ? null : c.acaCliffBufferCents / 100
  } : null;
  return {
    id: "compare",
    name: ceilings ? nameForCeilings(ceilings) : "Do Nothing",
    ceilings,
    guardrail: saved.optimizerGuardrail ?? false,
    bunching: saved.optimizerBunching ?? false,
    gainsHarvest: saved.gainsHarvest ?? false
  };
}
function compareStrategyDescription(inputs, strategy) {
  const parts = [`Retire at ${inputs.retirementAge}`, strategy.name];
  if (strategy.ceilings) {
    parts.push(`Convert ages ${inputs.windowStartAge}–${inputs.windowStopAge}`);
  }
  const switchOn = inputs.drawOrderSwitchAge != null && inputs.drawOrderAfter != null;
  parts.push(switchOn ? `Draw order ${drawOrderLabel(inputs.drawOrder)}, then ${drawOrderLabel(inputs.drawOrderAfter)} from age ${inputs.drawOrderSwitchAge}` : `Draw order ${drawOrderLabel(inputs.drawOrder)}`);
  if (strategy.guardrail)
    parts.push("marginal-rate guardrail");
  if (strategy.bunching)
    parts.push("ACA bunching");
  if (strategy.ceilings?.acaCliffCap && strategy.ceilings.acaCliffCapFamilyOnly) {
    parts.push("ACA cliff cap only until the household steps down");
  }
  if (strategy.gainsHarvest)
    parts.push("gain harvesting into the 0% bracket");
  if (inputs.survivorEnabled && inputs.survivorDeathYear != null) {
    parts.push(`survivor scenario: ${inputs.survivorWho ?? "primary"} dies in ${inputs.survivorDeathYear}`);
  }
  return parts.join(" · ");
}
function buildCompareScenario(base, name, overrides, startYear, taxReturnActuals) {
  const canonicalBase = { ...base };
  canonicalBase.acaHouseholdSchedule = resolveAcaHouseholdSchedule(base);
  delete canonicalBase.acaStepDownYear;
  delete canonicalBase.acaHouseholdSizeAfter;
  const merged = { ...canonicalBase };
  for (const k of Object.keys(overrides)) {
    if (overrides[k] !== undefined) {
      merged[k] = overrides[k];
    }
  }
  if (overrides.ssPrimaryStartAge !== undefined && overrides.ssPrimaryAnnualCents === undefined && merged.ssPrimaryNoBenefit !== true && base.ssPrimaryAnnualCents != null && base.ssPrimaryStartAge != null && merged.ssPrimaryStartAge != null && merged.birthYearPrimary != null) {
    merged.ssPrimaryAnnualCents = Math.round(ssAnnualAtClaimAge(base.ssPrimaryAnnualCents / 100, base.ssPrimaryStartAge, merged.ssPrimaryStartAge, merged.birthYearPrimary) * 100);
  }
  if (overrides.ssSpouseStartAge !== undefined && overrides.ssSpouseAnnualCents === undefined && merged.ssSpouseNoBenefit !== true && base.ssSpouseAnnualCents != null && base.ssSpouseStartAge != null && merged.ssSpouseStartAge != null && merged.birthYearSpouse != null) {
    merged.ssSpouseAnnualCents = Math.round(ssAnnualAtClaimAge(base.ssSpouseAnnualCents / 100, base.ssSpouseStartAge, merged.ssSpouseStartAge, merged.birthYearSpouse) * 100);
  }
  if (overrides.taxableCents !== undefined && overrides.spendFromCashSleeveCents === undefined) {
    merged.spendFromCashSleeveCents = 0;
  }
  if (taxReturnActuals != null) {
    const poolCents = merged.taxableCents ?? null;
    const basePoolCents = base.taxableCents ?? null;
    if (poolCents != null && poolCents > 0) {
      const implied = impliedYieldPctsFromTaxReturn(taxReturnActuals, poolCents / 100);
      if ((merged.taxableDividendYieldPct ?? null) == null && overrides.yieldFallbackDividendPct === undefined && ((merged.yieldFallbackDividendPct ?? null) == null || poolCents !== basePoolCents)) {
        merged.yieldFallbackDividendPct = implied.dividendYieldPct;
      }
      if ((merged.taxableInterestYieldPct ?? null) == null && overrides.yieldFallbackInterestPct === undefined && ((merged.yieldFallbackInterestPct ?? null) == null || poolCents !== basePoolCents)) {
        merged.yieldFallbackInterestPct = implied.interestYieldPct;
      }
    }
  }
  const inputs = planInputsFromSaved(merged, startYear);
  if (!inputs)
    return null;
  const strategy = compareStrategyFromSaved(merged);
  return {
    name,
    saved: merged,
    inputs,
    strategy,
    strategyDescription: compareStrategyDescription(inputs, strategy)
  };
}
var toCents = (dollars) => Math.round(dollars * 100);
function runRothCompare(base, scenarios, startYear, baselineName, taxReturnActuals) {
  if (scenarios.length === 0) {
    return {
      ok: false,
      reason: "The compare needs at least one scenario — name a strategy to price.",
      baselineName: null,
      scenarios: []
    };
  }
  const built = [];
  for (const s of scenarios) {
    const b = buildCompareScenario(base, s.name, s.overrides, startYear, taxReturnActuals);
    if (!b) {
      return {
        ok: false,
        reason: "The compare needs a birth year before it can price a plan — enter it in the base plan and run again.",
        baselineName: null,
        scenarios: []
      };
    }
    built.push(b);
  }
  const baseline = built.find((b) => b.name === baselineName) ?? built[0];
  if (baselineName != null && baseline.name !== baselineName) {
    return {
      ok: false,
      reason: `No scenario is named "${baselineName}" — the baseline must be one of the scenarios in the run.`,
      baselineName: null,
      scenarios: []
    };
  }
  const priced = built.map((b) => {
    const result = simulateRothPlan(b.inputs, b.strategy, undefined, {
      leanDetail: true
    });
    const cost = planNetCost(result, b.inputs);
    return {
      built: b,
      netCostCents: toCents(cost.netCost),
      totalTaxCents: toCents(cost.tax),
      federalTaxCents: toCents(result.lifetimeFederalTax),
      stateTaxCents: toCents(result.lifetimeStateTax),
      years: result.years.map((y) => ({
        year: y.year,
        agePrimary: y.agePrimary,
        ageSpouse: y.ageSpouse,
        federalTaxCents: toCents(y.federalTax),
        stateTaxCents: toCents(y.stateTax),
        penaltyCents: toCents(y.penalty),
        totalIncomeCents: toCents(y.agi),
        taxableIncomeCents: toCents(y.taxableIncome),
        acaCreditCents: toCents(y.acaCreditKept),
        educationRefundableCents: toCents(y.educationRefundable),
        irmaaCents: toCents(y.irmaaPaid),
        healthPremiumCents: toCents(y.healthPremiumNet),
        healthPremiumGrossCents: toCents(y.healthPremiumGross),
        conversionCents: toCents(y.conversion),
        pretaxOutByChoiceCents: toCents(y.conversion + y.detail.pretaxSpendingDraw),
        pretaxSpendingDrawCents: toCents(y.detail.pretaxSpendingDraw),
        pretaxTaxDebitCents: toCents(y.detail.pretaxTaxDebit),
        extraPreTaxDrawCents: toCents(y.detail.extraPreTaxDraw),
        settlementConverged: y.settlementConverged,
        settlementMismatchCents: y.settlementMismatchCents,
        ceilingBreached: y.ceilingBreached
      })),
      penaltyCents: toCents(cost.penalty),
      irmaaCents: toCents(cost.irmaa),
      acaCreditCents: toCents(cost.acaCredit),
      healthPremiumCents: toCents(cost.healthPremium),
      healthPremiumNetCents: toCents(cost.healthPremiumNet),
      educationRefundableCents: toCents(cost.educationRefundable),
      amtCents: toCents(cost.amt),
      terminalCents: toCents(cost.terminal),
      ssCollectedCents: toCents(cost.ssCollected),
      unpaidTaxCents: toCents(result.lifetimeUnpaidTax),
      endingPretaxCents: toCents(result.endingPretax),
      endingRothCents: toCents(result.endingRoth),
      endingTaxableCents: toCents(result.endingTaxable),
      endingHsaCents: toCents(result.endingHsa),
      endingAfterTaxWealthCents: toCents(result.endingAfterTaxWealth)
    };
  });
  const basePriced = priced.find((p) => p.built === baseline) ?? priced[0];
  return {
    ok: true,
    reason: `Priced ${priced.length} scenario${priced.length === 1 ? "" : "s"} as fixed strategies against the baseline "${baseline.name}". Deltas are scenario − baseline, in cents: a negative net-cost delta means the scenario costs less than the baseline; a positive ACA-credit delta means it keeps more premium credit.`,
    baselineName: baseline.name,
    scenarios: priced.map((p) => ({
      name: p.built.name,
      strategyDescription: p.built.strategyDescription,
      saved: p.built.saved,
      netCostCents: p.netCostCents,
      totalTaxCents: p.totalTaxCents,
      federalTaxCents: p.federalTaxCents,
      stateTaxCents: p.stateTaxCents,
      years: p.years,
      penaltyCents: p.penaltyCents,
      irmaaCents: p.irmaaCents,
      acaCreditCents: p.acaCreditCents,
      healthPremiumCents: p.healthPremiumCents,
      healthPremiumNetCents: p.healthPremiumNetCents,
      educationRefundableCents: p.educationRefundableCents,
      amtCents: p.amtCents,
      terminalCents: p.terminalCents,
      ssCollectedCents: p.ssCollectedCents,
      unpaidTaxCents: p.unpaidTaxCents,
      endingPretaxCents: p.endingPretaxCents,
      endingRothCents: p.endingRothCents,
      endingTaxableCents: p.endingTaxableCents,
      endingHsaCents: p.endingHsaCents,
      endingAfterTaxWealthCents: p.endingAfterTaxWealthCents,
      deltaNetCostCents: p.netCostCents - basePriced.netCostCents,
      deltaAcaCreditCents: p.acaCreditCents - basePriced.acaCreditCents,
      deltaEducationRefundableCents: p.educationRefundableCents - basePriced.educationRefundableCents
    }))
  };
}

function r23(n) {
  return Math.round(n * 100) / 100;
}
function contributionStack(age, salary, employer401k, employerHsa, filingStatus, law, priorYearWages, medicareAgePrimary, defl) {
  const empty = {
    deferral: 0,
    catchUp: 0,
    catchUpIsRoth: false,
    mega: 0,
    employer401k: 0,
    ownHsa: 0,
    employerHsa: 0,
    hsaBucket: 0,
    hsaLimit: 0
  };
  if (salary <= 0)
    return empty;
  const elective = law.elective401kLimit / 100;
  const deferral = Math.min(elective, salary);
  let catchUp = 0;
  if (age >= 50) {
    const bandLimit = (age >= 60 && age <= 63 ? law.catchUp60to63Limit : law.catchUp50Limit) / 100;
    catchUp = Math.max(0, Math.min(bandLimit, salary - deferral));
  }
  const hsaLimit = (filingStatus === "mfj" ? law.hsaLimitFamily : law.hsaLimitSelf) / 100 + (age >= 55 ? law.hsaCatchUp55 / 100 * (defl ?? 1) : 0);
  const hsaEligible = !(medicareAgePrimary != null && age >= medicareAgePrimary);
  const employerHsaLanded = hsaEligible ? employerHsa : 0;
  const ownHsa = hsaEligible ? Math.max(0, Math.min(hsaLimit - employerHsa, salary - deferral - catchUp)) : 0;
  const box3ThisYear = salary - ownHsa;
  const wageBasis = priorYearWages != null ? priorYearWages : box3ThisYear;
  const catchUpIsRoth = law.year >= 2026 && wageBasis > law.rothCatchUpWageThreshold / 100;
  const additionsCap = Math.min(law.overall415cLimit / 100, salary);
  const employerLanded = Math.min(employer401k, Math.max(0, additionsCap - deferral));
  const megaRoom = Math.max(0, additionsCap - deferral - employerLanded);
  const mega = Math.max(0, Math.min(megaRoom, salary - deferral - catchUp - ownHsa));
  const hsaBucket = Math.min(hsaLimit, ownHsa + employerHsaLanded);
  return {
    deferral: r23(deferral),
    catchUp: r23(catchUp),
    catchUpIsRoth,
    mega: r23(mega),
    employer401k: r23(employerLanded),
    ownHsa: r23(ownHsa),
    employerHsa: r23(employerHsaLanded),
    hsaBucket: r23(hsaBucket),
    hsaLimit: r23(hsaLimit)
  };
}
function payrollTaxBreakdown(ficaWages, filingStatus, law, defl = 1) {
  if (ficaWages <= 0) {
    return { socialSecurity: 0, medicare: 0, additionalMedicare: 0, total: 0 };
  }
  const ss = law.payrollSsRatePct / 100 * Math.min(ficaWages, law.ssWageBase / 100);
  const medicare = law.payrollMedicareRatePct / 100 * ficaWages;
  const additional = law.payrollAdditionalMedicareRatePct / 100 * Math.max(0, ficaWages - law.payrollAdditionalMedicareThreshold[filingStatus] * defl);
  return {
    socialSecurity: r23(ss),
    medicare: r23(medicare),
    additionalMedicare: r23(additional),
    total: r23(ss + medicare + additional)
  };
}
function initTaxableLedger(plan) {
  const tiersActive = plan.taxableBasisBlank !== true && Array.isArray(plan.taxableTiers) && plan.taxableTiers.length > 0;
  if (tiersActive) {
    const rawTiers = plan.taxableTiers;
    const shareTotal = rawTiers.reduce((s, t) => s + Math.max(0, t.sharePct), 0);
    let cashTierIndex = -1;
    const tiers = rawTiers.map((t, i) => {
      const share = shareTotal > 0 ? Math.max(0, t.sharePct) / shareTotal : 0;
      const bal = plan.taxableStart * share;
      const basisPct = Math.min(100, Math.max(0, t.basisPct));
      if (cashTierIndex < 0 && basisPct >= 100)
        cashTierIndex = i;
      return { bal, basis: bal * (basisPct / 100) };
    });
    return {
      tiers,
      basis: tiers.reduce((s, t) => s + t.basis, 0),
      cashTierIndex
    };
  }
  const basisPct = Math.min(100, Math.max(0, plan.taxableBasisPct)) / 100;
  return { tiers: null, basis: basisPct * plan.taxableStart, cashTierIndex: -1 };
}
function gainOnLedgerSale(ledger, grownBalance, drawn) {
  const sold = Math.min(Math.max(0, drawn), Math.max(0, grownBalance));
  if (sold <= 0 || grownBalance <= 0)
    return 0;
  if (!ledger.tiers) {
    const basis = Math.max(0, ledger.basis);
    return sold * (1 - basis / grownBalance);
  }
  const clone = ledger.tiers.map((t) => ({ ...t }));
  return sellFromLedgerTiers(clone, sold);
}
function consumeLedgerSale(ledger, grownBalance, drawn) {
  const sold = Math.min(Math.max(0, drawn), Math.max(0, grownBalance));
  if (sold <= 0)
    return 0;
  let gain;
  if (!ledger.tiers) {
    const basis = Math.max(0, ledger.basis);
    gain = sold * (1 - basis / grownBalance);
    ledger.basis = sold >= grownBalance ? 0 : Math.max(0, ledger.basis - sold * (basis / grownBalance));
  } else {
    gain = sellFromLedgerTiers(ledger.tiers, sold);
    ledger.basis = ledger.tiers.reduce((s, t) => s + t.basis, 0);
    if (sold >= grownBalance) {
      for (const t of ledger.tiers)
        t.basis = 0;
      ledger.basis = 0;
    }
  }
  return gain;
}
function sellFromLedgerTiers(tiers, amount) {
  if (amount <= 0)
    return 0;
  const ranked = tiers.map((t, i) => ({ i, ratio: t.bal > 0 ? t.basis / t.bal : null })).filter((o) => o.ratio != null).sort((a, b) => b.ratio - a.ratio);
  let remaining = amount;
  let gains = 0;
  for (const { i } of ranked) {
    if (remaining <= 0)
      break;
    const t = tiers[i];
    const take = Math.min(remaining, t.bal);
    if (take <= 0)
      continue;
    const ratio = t.basis / t.bal;
    gains += take * (1 - ratio);
    t.basis = Math.max(0, t.basis - take * ratio);
    t.bal -= take;
    remaining -= take;
  }
  return gains;
}
function stepUpLedgerForYield(ledger, _grownBalance, yieldTotal) {
  if (yieldTotal <= 0)
    return;
  if (!ledger.tiers) {
    ledger.basis = Math.max(0, ledger.basis + yieldTotal);
    return;
  }
  const ranked = ledger.tiers.map((t, i) => ({ i, ratio: t.bal > 0 ? t.basis / t.bal : 1 })).sort((a, b) => a.ratio - b.ratio);
  let remaining = yieldTotal;
  for (const { i } of ranked) {
    if (remaining <= 0)
      break;
    const t = ledger.tiers[i];
    const room = Math.max(0, t.bal - t.basis);
    const add = Math.min(room, remaining);
    t.basis += add;
    remaining -= add;
  }
  if (remaining > 0 && ranked.length > 0) {
    ledger.tiers[ranked[0].i].basis += remaining;
  }
  ledger.basis = ledger.tiers.reduce((s, t) => s + t.basis, 0);
}
function landSurplusInLedger(ledger, grownBalance, surplus) {
  if (surplus <= 0)
    return;
  if (!ledger.tiers) {
    ledger.basis += surplus;
    return;
  }
  const tiers = ledger.tiers;
  if (ledger.cashTierIndex >= 0 && tiers[ledger.cashTierIndex]) {
    const t = tiers[ledger.cashTierIndex];
    t.bal += surplus;
    t.basis += surplus;
  } else if (grownBalance > 0) {
    let landed = 0;
    tiers.forEach((t, i) => {
      const share = i === tiers.length - 1 ? surplus - landed : surplus * Math.max(0, t.bal) / grownBalance;
      t.bal += share;
      t.basis += share;
      landed += share;
    });
  } else if (tiers[0]) {
    tiers[0].bal += surplus;
    tiers[0].basis += surplus;
  }
  ledger.basis = tiers.reduce((s, t) => s + t.basis, 0);
}
function rebuildRolledBasisFields(plan, ledger, finalBalance) {
  if (plan.taxableBasisBlank === true) {
    return { taxableBasisPct: plan.taxableBasisPct, taxableTiers: plan.taxableTiers };
  }
  if (ledger.tiers) {
    const totalBasis = ledger.tiers.reduce((s, t) => s + t.basis, 0);
    if (finalBalance <= 0) {
      return { taxableBasisPct: plan.taxableBasisPct, taxableTiers: plan.taxableTiers };
    }
    let shareSoFar = 0;
    const tiers = ledger.tiers.map((t, i) => {
      const sharePct = i === ledger.tiers.length - 1 ? 100 - shareSoFar : 100 * Math.max(0, t.bal) / finalBalance;
      shareSoFar += sharePct;
      return {
        sharePct,
        basisPct: t.bal > 0 ? 100 * t.basis / t.bal : 100
      };
    });
    return {
      taxableBasisPct: 100 * totalBasis / finalBalance,
      taxableTiers: tiers
    };
  }
  return {
    taxableBasisPct: finalBalance > 0 ? 100 * ledger.basis / finalBalance : plan.taxableBasisPct,
    taxableTiers: plan.taxableTiers
  };
}
function priceOneWorkYear(plan, job, age, priorYearWages, taxableCtx, pretaxCtx, lossCtx) {
  const calendarYear = plan.birthYearPrimary + age;
  const law = lawForYear(calendarYear);
  const defl = deflationFactor(calendarYear, law.year, plan.inflationPct);
  const stack = contributionStack(age, job.salary, job.employer401k, job.employerHsa, plan.filingStatus, law, priorYearWages, job.medicareAgePrimary ?? null, defl);
  const catchUpPreTax = stack.catchUpIsRoth ? 0 : stack.catchUp;
  const taxableWages = r23(job.salary - stack.deferral - catchUpPreTax - stack.ownHsa);
  const ageSpouse = plan.birthYearSpouse != null ? calendarYear - plan.birthYearSpouse : null;
  const priorPretaxPrimary = pretaxCtx?.priorPrimary ?? plan.pretaxStart;
  const priorPretaxSpouse = pretaxCtx?.priorSpouse ?? (plan.pretaxSpouseStart ?? 0);
  const rmdPrimaryRes = rmdForYear({
    priorDec31PreTax: priorPretaxPrimary,
    agePrimary: age,
    ageSpouse,
    birthYearPrimary: plan.birthYearPrimary,
    spouseSoleBeneficiary: plan.spouseSoleBeneficiary
  });
  const rmdSpouseRes = ageSpouse != null && plan.birthYearSpouse != null ? rmdForYear({
    priorDec31PreTax: priorPretaxSpouse,
    agePrimary: ageSpouse,
    ageSpouse: age,
    birthYearPrimary: plan.birthYearSpouse,
    spouseSoleBeneficiary: plan.primarySoleBeneficiaryOfSpouse === true
  }) : { rmd: 0, divisor: null, table: null };
  const rmdTotal = r23(rmdPrimaryRes.rmd + rmdSpouseRes.rmd);
  const openingBalance = taxableCtx?.openingBalance ?? plan.taxableStart;
  const interestIncome = r23(Math.max(0, openingBalance) * Math.max(0, plan.taxableInterestYieldPct ?? 0) / 100);
  const dividendIncome = r23(Math.max(0, openingBalance) * Math.max(0, plan.taxableDividendYieldPct ?? 0) / 100);
  const dividendQualifiedPct = Math.min(100, Math.max(0, plan.taxableDividendQualifiedPct ?? 100));
  const qualifiedDividendIncome = r23(dividendIncome * dividendQualifiedPct / 100);
  const nonQualifiedDividendIncome = r23(dividendIncome - qualifiedDividendIncome);
  const ssPrimaryThisYear = plan.ssPrimaryStartAge != null && age >= plan.ssPrimaryStartAge ? plan.ssPrimaryNoBenefit ? 0 : plan.ssPrimaryAnnual : 0;
  const ssSpouseThisYear = plan.ssSpouseStartAge != null && ageSpouse != null && ageSpouse >= plan.ssSpouseStartAge ? plan.ssSpouseNoBenefit ? 0 : plan.ssSpouseAnnual : 0;
  const ssBenefits = r23(ssPrimaryThisYear + ssSpouseThisYear);
  const lossCarryInSt = Math.max(0, lossCtx?.st ?? plan.capitalLossCarryInSt ?? 0);
  const lossCarryInLt = Math.max(0, lossCtx?.lt ?? plan.capitalLossCarryInLt ?? 0);
  const lossCarryInWaSt = Math.min(lossCarryInSt, Math.max(0, lossCtx?.waSt ?? plan.capitalLossCarryInStWa ?? 0));
  const lossCarryInWaLt = Math.min(lossCarryInLt, Math.max(0, lossCtx?.waLt ?? plan.capitalLossCarryInLtWa ?? 0));
  const lossLedgerOn = lossCarryInSt > 0 || lossCarryInLt > 0;
  const ledgerFields = (grossGains) => {
    if (!lossLedgerOn) {
      return {
        ltcg: grossGains,
        capitalLossAllowance: Math.min(capitalLossAllowanceCap(plan.filingStatus), Math.max(0, -grossGains))
      };
    }
    const led = applyLossLedger({ st: lossCarryInSt, lt: lossCarryInLt }, grossGains, plan.filingStatus, Number.POSITIVE_INFINITY, { st: lossCarryInWaSt, lt: lossCarryInWaLt });
    return {
      ltcg: led.netResult,
      capitalLossAllowance: led.allowance,
      waGainsBase: r23(grossGains - led.waAbsorbedByGains)
    };
  };
  const priceWithGain = (grossLtcg) => {
    const lf = ledgerFields(grossLtcg);
    return priceYear({
      calendarYear,
      filingStatus: plan.filingStatus,
      agePrimary: age,
      ageSpouse,
      otherOrdinary: Math.max(0, taxableWages),
      rmd: rmdTotal,
      conversion: 0,
      extraPreTaxDraw: 0,
      ssBenefits,
      taxExemptInterest: plan.taxExemptInterestAnnual,
      ltcg: lf.ltcg,
      capitalLossAllowance: lf.capitalLossAllowance,
      waGainsBase: lf.waGainsBase,
      interestIncome,
      qualifiedDividends: qualifiedDividendIncome,
      ordinaryDividends: nonQualifiedDividendIncome,
      inflationPct: plan.inflationPct,
      stateRatePct: plan.stateRatePct,
      residenceState: plan.residenceState ?? null,
      itemizedMortgageInterest: plan.itemizedMortgageInterest,
      itemizedSaltPaid: plan.itemizedSaltPaid,
      itemizedCharitable: plan.itemizedCharitable,
      itemizedOther: plan.itemizedOther,
      educationStudents: (plan.educationStudents ?? []).filter((e) => e.year === calendarYear)
    });
  };
  const ficaWages = r23(job.salary - stack.ownHsa);
  const payroll = payrollTaxBreakdown(Math.max(0, ficaWages), plan.filingStatus, law, defl);
  const fica = payroll.total;
  const ownContributions = stack.deferral + stack.catchUp + stack.mega + stack.ownHsa;
  const surplusOf = (p) => r23(job.salary - p.federalTax - p.stateTax - fica - plan.annualSpending - ownContributions + ssBenefits + rmdTotal);
  let priced = priceWithGain(0);
  let surplus = surplusOf(priced);
  let ltcg = 0;
  if (taxableCtx && surplus < 0) {
    let drawn = -surplus;
    for (let i = 0;i < 100; i++) {
      const gain = gainOnLedgerSale(taxableCtx.ledger, taxableCtx.grownBalance, drawn);
      const repriced = priceWithGain(gain);
      const s2 = surplusOf(repriced);
      const drawn2 = s2 < 0 ? -s2 : 0;
      const gainImplied = gainOnLedgerSale(taxableCtx.ledger, taxableCtx.grownBalance, drawn2);
      priced = repriced;
      surplus = s2;
      ltcg = gain;
      if (Math.abs(drawn2 - drawn) < 0.005 && Math.abs(gainImplied - gain) < 0.005) {
        break;
      }
      drawn = drawn2;
      if (drawn <= 0)
        break;
    }
  }
  const ledFinal = lossLedgerOn || ltcg < 0 ? applyLossLedger({ st: lossCarryInSt, lt: lossCarryInLt }, ltcg, plan.filingStatus, priced.taxableIncomeBeforeLossAllowance, { st: lossCarryInWaSt, lt: lossCarryInWaLt }) : null;
  return {
    age,
    calendarYear,
    salary: job.salary,
    stack,
    taxableWages,
    magi: priced.magi,
    federalTax: priced.federalTax,
    stateTax: priced.stateTax,
    ficaWages,
    fica,
    payrollTax: payroll.total,
    payrollSocialSecurity: payroll.socialSecurity,
    payrollMedicare: payroll.medicare,
    payrollAdditionalMedicare: payroll.additionalMedicare,
    interestIncome,
    dividendIncome,
    ssBenefits,
    rmd: rmdTotal,
    rmdPrimary: rmdPrimaryRes.rmd,
    rmdSpouse: rmdSpouseRes.rmd,
    rmdDivisorPrimary: rmdPrimaryRes.divisor,
    rmdDivisorSpouse: rmdSpouseRes.divisor,
    rmdTablePrimary: rmdPrimaryRes.table,
    rmdTableSpouse: rmdSpouseRes.table,
    ltcg: r23(ltcg),
    capitalLossCarryInSt: r23(lossCarryInSt),
    capitalLossCarryInLt: r23(lossCarryInLt),
    netCapitalResult: ledFinal ? ledFinal.netResult : r23(ltcg),
    capitalLossAllowance: ledFinal ? ledFinal.allowance : 0,
    capitalLossAllowanceUsed: ledFinal ? ledFinal.allowanceUsed : 0,
    capitalLossAbsorbedByGains: ledFinal ? ledFinal.absorbedByGains : 0,
    capitalLossCarryOutSt: ledFinal ? ledFinal.carryOut.st : 0,
    capitalLossCarryOutLt: ledFinal ? ledFinal.carryOut.lt : 0,
    capitalLossCarryInWaSt: r23(lossCarryInWaSt),
    capitalLossCarryInWaLt: r23(lossCarryInWaLt),
    capitalLossWaAbsorbedByGains: ledFinal ? ledFinal.waAbsorbedByGains : 0,
    capitalLossCarryOutWaSt: ledFinal ? ledFinal.waCarryOut.st : 0,
    capitalLossCarryOutWaLt: ledFinal ? ledFinal.waCarryOut.lt : 0,
    surplus,
    educationRefundable: priced.educationRefundable,
    shortfall: 0
  };
}
function rollWorkYears(plan, job, quitAge) {
  const currentAge = plan.startYear - plan.birthYearPrimary;
  const effectiveStart = Math.max(plan.windowStartAge, currentAge);
  const count = job.salary > 0 ? Math.max(0, Math.floor(quitAge) - effectiveStart) : 0;
  const startLedger = initTaxableLedger(plan);
  const startBalances = {
    pretax: r23(plan.pretaxStart + (plan.pretaxSpouseStart ?? 0)),
    pretaxPrimary: plan.pretaxStart,
    pretaxSpouse: plan.pretaxSpouseStart ?? 0,
    roth: plan.rothStart,
    taxable: plan.taxableStart,
    taxableBasis: r23(startLedger.basis),
    hsa: plan.hsaStart
  };
  if (count === 0) {
    return {
      lines: [],
      totals: {
        years: 0,
        grossSalary: 0,
        federal: 0,
        state: 0,
        fica: 0,
        payrollTax: 0,
        payrollSocialSecurity: 0,
        payrollMedicare: 0,
        payrollAdditionalMedicare: 0,
        pretaxContributions: 0,
        rothContributions: 0,
        hsaContributions: 0,
        totalContributions: 0,
        employeeContributions: 0,
        employerContributions: 0,
        surplusBanked: 0,
        shortfall: 0,
        banked: 0
      },
      balances: startBalances,
      rolledInputs: {
        ...plan,
        retirementAge: Math.floor(quitAge),
        windowStartAge: Math.floor(quitAge)
      }
    };
  }
  const growth = Math.max(0, 1 + plan.expectedReturnPct / 100);
  let pretaxPrimary = plan.pretaxStart;
  let pretaxSpouse = plan.pretaxSpouseStart ?? 0;
  let roth = plan.rothStart;
  let taxable = plan.taxableStart;
  let hsa = plan.hsaStart;
  const lines = [];
  const totals = {
    years: count,
    grossSalary: 0,
    federal: 0,
    state: 0,
    fica: 0,
    payrollTax: 0,
    payrollSocialSecurity: 0,
    payrollMedicare: 0,
    payrollAdditionalMedicare: 0,
    pretaxContributions: 0,
    rothContributions: 0,
    hsaContributions: 0,
    totalContributions: 0,
    employeeContributions: 0,
    employerContributions: 0,
    surplusBanked: 0,
    shortfall: 0,
    banked: 0
  };
  let priorYearWages = null;
  const ledger = initTaxableLedger(plan);
  let pendingEduRefund = 0;
  let eduRefundsDeposited = 0;
  let lossCarrySt = Math.max(0, plan.capitalLossCarryInSt ?? 0);
  let lossCarryLt = Math.max(0, plan.capitalLossCarryInLt ?? 0);
  let lossCarryWaSt = Math.min(lossCarrySt, Math.max(0, plan.capitalLossCarryInStWa ?? 0));
  let lossCarryWaLt = Math.min(lossCarryLt, Math.max(0, plan.capitalLossCarryInLtWa ?? 0));
  for (let i = 0;i < count; i++) {
    const age = effectiveStart + i;
    if (pendingEduRefund > 0) {
      landSurplusInLedger(ledger, taxable, pendingEduRefund);
      taxable += pendingEduRefund;
      eduRefundsDeposited += pendingEduRefund;
      pendingEduRefund = 0;
    }
    const openingTaxable = taxable;
    const yieldTotal = r23(Math.max(0, openingTaxable) * Math.max(0, plan.taxableInterestYieldPct ?? 0) / 100) + r23(Math.max(0, openingTaxable) * Math.max(0, plan.taxableDividendYieldPct ?? 0) / 100);
    const grownTaxable = openingTaxable * growth;
    if (ledger.tiers) {
      for (const t of ledger.tiers)
        t.bal *= growth;
    }
    stepUpLedgerForYield(ledger, grownTaxable, yieldTotal);
    const pricedLine = priceOneWorkYear(plan, job, age, priorYearWages, {
      openingBalance: openingTaxable,
      grownBalance: grownTaxable,
      ledger
    }, { priorPrimary: pretaxPrimary, priorSpouse: pretaxSpouse }, { st: lossCarrySt, lt: lossCarryLt, waSt: lossCarryWaSt, waLt: lossCarryWaLt });
    priorYearWages = pricedLine.ficaWages;
    lossCarrySt = pricedLine.capitalLossCarryOutSt;
    lossCarryLt = pricedLine.capitalLossCarryOutLt;
    lossCarryWaSt = pricedLine.capitalLossCarryOutWaSt;
    lossCarryWaLt = pricedLine.capitalLossCarryOutWaLt;
    pendingEduRefund = r23(pricedLine.educationRefundable);
    const s = pricedLine.stack;
    const catchUpPreTax = s.catchUpIsRoth ? 0 : s.catchUp;
    const catchUpRoth = s.catchUpIsRoth ? s.catchUp : 0;
    const pretaxIn = s.deferral + catchUpPreTax + s.employer401k;
    const rothIn = catchUpRoth + s.mega;
    pretaxPrimary = Math.max(0, pretaxPrimary - pricedLine.rmdPrimary) * growth + pretaxIn;
    pretaxSpouse = Math.max(0, pretaxSpouse - pricedLine.rmdSpouse) * growth;
    roth = roth * growth + rothIn;
    const rawTaxable = grownTaxable + pricedLine.surplus;
    const shortfall = rawTaxable < 0 ? r23(-rawTaxable) : 0;
    if (pricedLine.surplus >= 0) {
      landSurplusInLedger(ledger, grownTaxable, pricedLine.surplus);
    } else {
      consumeLedgerSale(ledger, grownTaxable, -pricedLine.surplus);
    }
    taxable = rawTaxable < 0 ? 0 : rawTaxable;
    const line = { ...pricedLine, shortfall };
    lines.push(line);
    hsa = hsa * growth + s.hsaBucket;
    totals.grossSalary += line.salary;
    totals.federal += line.federalTax;
    totals.state += line.stateTax;
    totals.fica += line.fica;
    totals.payrollTax += line.payrollTax;
    totals.payrollSocialSecurity += line.payrollSocialSecurity;
    totals.payrollMedicare += line.payrollMedicare;
    totals.payrollAdditionalMedicare += line.payrollAdditionalMedicare;
    totals.pretaxContributions += pretaxIn;
    totals.rothContributions += rothIn;
    totals.hsaContributions += s.hsaBucket;
    totals.employeeContributions += s.deferral + s.catchUp + s.mega + s.ownHsa;
    totals.employerContributions += s.employer401k + (s.hsaBucket - s.ownHsa);
    totals.surplusBanked += line.surplus + line.shortfall;
    totals.shortfall += line.shortfall;
  }
  if (pendingEduRefund > 0) {
    landSurplusInLedger(ledger, taxable, pendingEduRefund);
    taxable += pendingEduRefund;
    eduRefundsDeposited += pendingEduRefund;
    pendingEduRefund = 0;
  }
  totals.surplusBanked += eduRefundsDeposited;
  totals.grossSalary = r23(totals.grossSalary);
  totals.federal = r23(totals.federal);
  totals.state = r23(totals.state);
  totals.fica = r23(totals.fica);
  totals.payrollTax = r23(totals.payrollTax);
  totals.payrollSocialSecurity = r23(totals.payrollSocialSecurity);
  totals.payrollMedicare = r23(totals.payrollMedicare);
  totals.payrollAdditionalMedicare = r23(totals.payrollAdditionalMedicare);
  totals.pretaxContributions = r23(totals.pretaxContributions);
  totals.rothContributions = r23(totals.rothContributions);
  totals.hsaContributions = r23(totals.hsaContributions);
  totals.totalContributions = r23(totals.pretaxContributions + totals.rothContributions + totals.hsaContributions);
  totals.employeeContributions = r23(totals.employeeContributions);
  totals.employerContributions = r23(totals.employerContributions);
  totals.surplusBanked = r23(totals.surplusBanked);
  totals.shortfall = r23(totals.shortfall);
  totals.banked = r23(totals.totalContributions + totals.surplusBanked);
  const balances = {
    pretax: r23(pretaxPrimary + pretaxSpouse),
    pretaxPrimary: r23(pretaxPrimary),
    pretaxSpouse: r23(pretaxSpouse),
    roth: r23(roth),
    taxable: r23(taxable),
    taxableBasis: r23(ledger.basis),
    hsa: r23(hsa)
  };
  const basisFields = rebuildRolledBasisFields(plan, ledger, balances.taxable);
  const rolledInputs = {
    ...plan,
    capitalLossCarryInSt: r23(lossCarrySt),
    capitalLossCarryInLt: r23(lossCarryLt),
    capitalLossCarryInStWa: r23(lossCarryWaSt),
    capitalLossCarryInLtWa: r23(lossCarryWaLt),
    taxableBasisPct: basisFields.taxableBasisPct,
    taxableTiers: basisFields.taxableTiers,
    irmaaLookbackSeed: lines.map((l) => ({
      year: l.calendarYear,
      magi: l.magi,
      filingStatus: plan.filingStatus
    })),
    startYear: plan.birthYearPrimary + Math.floor(quitAge),
    retirementAge: Math.floor(quitAge),
    windowStartAge: Math.floor(quitAge),
    pretaxStart: Math.max(0, balances.pretaxPrimary),
    pretaxSpouseStart: Math.max(0, balances.pretaxSpouse),
    rothStart: Math.max(0, balances.roth),
    taxableStart: Math.max(0, balances.taxable),
    hsaStart: Math.max(0, balances.hsa),
    convertedAlreadyThisYear: 0
  };
  return { lines, totals, balances, rolledInputs };
}
function runWorkYearsCompare(plan, job, quitAges) {
  const cache = new Map;
  return quitAges.map((quitAge) => {
    const roll = rollWorkYears(plan, job, quitAge);
    const key = roll.totals.years === 0 ? `no-work:${quitAge}` : `${quitAge}:${roll.balances.pretax}:${roll.balances.roth}:${roll.balances.taxable}:${roll.balances.hsa}:${roll.rolledInputs.capitalLossCarryInSt ?? 0}:${roll.rolledInputs.capitalLossCarryInLt ?? 0}:${roll.rolledInputs.capitalLossCarryInStWa ?? 0}:${roll.rolledInputs.capitalLossCarryInLtWa ?? 0}`;
    let entry = cache.get(key);
    if (!entry) {
      entry = { roll, optimizer: runJointOptimizer(roll.rolledInputs) };
      cache.set(key, entry);
    }
    const opt = entry.optimizer;
    const workTax = r23(roll.totals.federal + roll.totals.state + roll.totals.fica);
    const claim67 = opt.claimAgeTable.find((row) => row.primaryAge === 67) ?? null;
    const endingNominal = r23(opt.winner.result.endingPretax + opt.winner.result.endingRoth + opt.winner.result.endingTaxable + opt.winner.result.endingHsa);
    return {
      quitAge,
      workYears: roll.totals.years,
      roll,
      optimizer: opt,
      workTax,
      payrollTax: roll.totals.payrollTax,
      totalTax: r23(opt.winner.cost.tax + workTax),
      shortfall: roll.totals.shortfall,
      allInTax: r23(opt.winner.cost.netCost + workTax),
      claim67AllInTax: claim67 == null ? null : r23(claim67.best.cost.netCost + workTax),
      endingNominal,
      endingAfterTax: opt.winner.result.endingAfterTaxWealth
    };
  });
}

var ADAPTER_VERSION = "assistant-api 0.1.0";
var API_CONTRACT_VERSION_REPORTED = 164;

var _a;
function $constructor(name, initializer, params) {
  function init(inst, def) {
    if (!inst._zod) {
      Object.defineProperty(inst, "_zod", {
        value: {
          def,
          constr: _,
          traits: new Set
        },
        enumerable: false
      });
    }
    if (inst._zod.traits.has(name)) {
      return;
    }
    inst._zod.traits.add(name);
    initializer(inst, def);
    const proto = _.prototype;
    const keys = Object.keys(proto);
    for (let i = 0;i < keys.length; i++) {
      const k = keys[i];
      if (!(k in inst)) {
        inst[k] = proto[k].bind(inst);
      }
    }
  }
  const Parent = params?.Parent ?? Object;

  class Definition extends Parent {
  }
  Object.defineProperty(Definition, "name", { value: name });
  function _(def) {
    var _a;
    const inst = params?.Parent ? new Definition : this;
    init(inst, def);
    (_a = inst._zod).deferred ?? (_a.deferred = []);
    for (const fn of inst._zod.deferred) {
      fn();
    }
    return inst;
  }
  Object.defineProperty(_, "init", { value: init });
  Object.defineProperty(_, Symbol.hasInstance, {
    value: (inst) => {
      if (params?.Parent && inst instanceof params.Parent)
        return true;
      return inst?._zod?.traits?.has(name);
    }
  });
  Object.defineProperty(_, "name", { value: name });
  return _;
}
var $brand = Symbol("zod_brand");

class $ZodAsyncError extends Error {
  constructor() {
    super(`Encountered Promise during synchronous parse. Use .parseAsync() instead.`);
  }
}

class $ZodEncodeError extends Error {
  constructor(name) {
    super(`Encountered unidirectional transform during encode: ${name}`);
    this.name = "ZodEncodeError";
  }
}
(_a = globalThis).__zod_globalConfig ?? (_a.__zod_globalConfig = {});
var globalConfig = globalThis.__zod_globalConfig;
function config(newConfig) {
  if (newConfig)
    Object.assign(globalConfig, newConfig);
  return globalConfig;
}
function getEnumValues(entries) {
  const numericValues = Object.values(entries).filter((v) => typeof v === "number");
  const values = Object.entries(entries).filter(([k, _]) => numericValues.indexOf(+k) === -1).map(([_, v]) => v);
  return values;
}
function jsonStringifyReplacer(_, value) {
  if (typeof value === "bigint")
    return value.toString();
  return value;
}
function cached(getter) {
  const set = false;
  return {
    get value() {
      if (!set) {
        const value = getter();
        Object.defineProperty(this, "value", { value });
        return value;
      }
      throw new Error("cached value already set");
    }
  };
}
function nullish(input) {
  return input === null || input === undefined;
}
function cleanRegex(source) {
  const start = source.startsWith("^") ? 1 : 0;
  const end = source.endsWith("$") ? source.length - 1 : source.length;
  return source.slice(start, end);
}
function floatSafeRemainder(val, step) {
  const ratio = val / step;
  const roundedRatio = Math.round(ratio);
  const tolerance = Number.EPSILON * Math.max(Math.abs(ratio), 1);
  if (Math.abs(ratio - roundedRatio) < tolerance)
    return 0;
  return ratio - roundedRatio;
}
var EVALUATING = /* @__PURE__ */ Symbol("evaluating");
function defineLazy(object, key, getter) {
  let value = undefined;
  Object.defineProperty(object, key, {
    get() {
      if (value === EVALUATING) {
        return;
      }
      if (value === undefined) {
        value = EVALUATING;
        value = getter();
      }
      return value;
    },
    set(v) {
      Object.defineProperty(object, key, {
        value: v
      });
    },
    configurable: true
  });
}
function assignProp(target, prop, value) {
  Object.defineProperty(target, prop, {
    value,
    writable: true,
    enumerable: true,
    configurable: true
  });
}
function mergeDefs(...defs) {
  const mergedDescriptors = {};
  for (const def of defs) {
    const descriptors = Object.getOwnPropertyDescriptors(def);
    Object.assign(mergedDescriptors, descriptors);
  }
  return Object.defineProperties({}, mergedDescriptors);
}
function esc(str) {
  return JSON.stringify(str);
}
function slugify(input) {
  return input.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "");
}
var captureStackTrace = "captureStackTrace" in Error ? Error.captureStackTrace : (..._args) => {};
function isObject(data) {
  return typeof data === "object" && data !== null && !Array.isArray(data);
}
var allowsEval = /* @__PURE__ */ cached(() => {
  if (globalConfig.jitless) {
    return false;
  }
  if (typeof navigator !== "undefined" && navigator?.userAgent?.includes("Cloudflare")) {
    return false;
  }
  try {
    const F = Function;
    new F("");
    return true;
  } catch (_) {
    return false;
  }
});
function isPlainObject(o) {
  if (isObject(o) === false)
    return false;
  const ctor = o.constructor;
  if (ctor === undefined)
    return true;
  if (typeof ctor !== "function")
    return true;
  const prot = ctor.prototype;
  if (isObject(prot) === false)
    return false;
  if (Object.prototype.hasOwnProperty.call(prot, "isPrototypeOf") === false) {
    return false;
  }
  return true;
}
function shallowClone(o) {
  if (isPlainObject(o))
    return { ...o };
  if (Array.isArray(o))
    return [...o];
  if (o instanceof Map)
    return new Map(o);
  if (o instanceof Set)
    return new Set(o);
  return o;
}
var propertyKeyTypes = /* @__PURE__ */ new Set(["string", "number", "symbol"]);
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function clone(inst, def, params) {
  const cl = new inst._zod.constr(def ?? inst._zod.def);
  if (!def || params?.parent)
    cl._zod.parent = inst;
  return cl;
}
function normalizeParams(_params) {
  const params = _params;
  if (!params)
    return {};
  if (typeof params === "string")
    return { error: () => params };
  if (params?.message !== undefined) {
    if (params?.error !== undefined)
      throw new Error("Cannot specify both `message` and `error` params");
    params.error = params.message;
  }
  delete params.message;
  if (typeof params.error === "string")
    return { ...params, error: () => params.error };
  return params;
}
function optionalKeys(shape) {
  return Object.keys(shape).filter((k) => {
    return shape[k]._zod.optin === "optional" && shape[k]._zod.optout === "optional";
  });
}
var NUMBER_FORMAT_RANGES = {
  safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  int32: [-2147483648, 2147483647],
  uint32: [0, 4294967295],
  float32: [-340282346638528860000000000000000000000, 340282346638528860000000000000000000000],
  float64: [-Number.MAX_VALUE, Number.MAX_VALUE]
};
function pick(schema, mask) {
  const currDef = schema._zod.def;
  const checks = currDef.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    throw new Error(".pick() cannot be used on object schemas containing refinements");
  }
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const newShape = {};
      for (const key in mask) {
        if (!(key in currDef.shape)) {
          throw new Error(`Unrecognized key: "${key}"`);
        }
        if (!mask[key])
          continue;
        newShape[key] = currDef.shape[key];
      }
      assignProp(this, "shape", newShape);
      return newShape;
    },
    checks: []
  });
  return clone(schema, def);
}
function omit(schema, mask) {
  const currDef = schema._zod.def;
  const checks = currDef.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    throw new Error(".omit() cannot be used on object schemas containing refinements");
  }
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const newShape = { ...schema._zod.def.shape };
      for (const key in mask) {
        if (!(key in currDef.shape)) {
          throw new Error(`Unrecognized key: "${key}"`);
        }
        if (!mask[key])
          continue;
        delete newShape[key];
      }
      assignProp(this, "shape", newShape);
      return newShape;
    },
    checks: []
  });
  return clone(schema, def);
}
function extend(schema, shape) {
  if (!isPlainObject(shape)) {
    throw new Error("Invalid input to extend: expected a plain object");
  }
  const checks = schema._zod.def.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    const existingShape = schema._zod.def.shape;
    for (const key in shape) {
      if (Object.getOwnPropertyDescriptor(existingShape, key) !== undefined) {
        throw new Error("Cannot overwrite keys on object schemas containing refinements. Use `.safeExtend()` instead.");
      }
    }
  }
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const _shape = { ...schema._zod.def.shape, ...shape };
      assignProp(this, "shape", _shape);
      return _shape;
    }
  });
  return clone(schema, def);
}
function safeExtend(schema, shape) {
  if (!isPlainObject(shape)) {
    throw new Error("Invalid input to safeExtend: expected a plain object");
  }
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const _shape = { ...schema._zod.def.shape, ...shape };
      assignProp(this, "shape", _shape);
      return _shape;
    }
  });
  return clone(schema, def);
}
function merge(a, b) {
  if (a._zod.def.checks?.length) {
    throw new Error(".merge() cannot be used on object schemas containing refinements. Use .safeExtend() instead.");
  }
  const def = mergeDefs(a._zod.def, {
    get shape() {
      const _shape = { ...a._zod.def.shape, ...b._zod.def.shape };
      assignProp(this, "shape", _shape);
      return _shape;
    },
    get catchall() {
      return b._zod.def.catchall;
    },
    checks: b._zod.def.checks ?? []
  });
  return clone(a, def);
}
function partial(Class, schema, mask) {
  const currDef = schema._zod.def;
  const checks = currDef.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    throw new Error(".partial() cannot be used on object schemas containing refinements");
  }
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const oldShape = schema._zod.def.shape;
      const shape = { ...oldShape };
      if (mask) {
        for (const key in mask) {
          if (!(key in oldShape)) {
            throw new Error(`Unrecognized key: "${key}"`);
          }
          if (!mask[key])
            continue;
          shape[key] = Class ? new Class({
            type: "optional",
            innerType: oldShape[key]
          }) : oldShape[key];
        }
      } else {
        for (const key in oldShape) {
          shape[key] = Class ? new Class({
            type: "optional",
            innerType: oldShape[key]
          }) : oldShape[key];
        }
      }
      assignProp(this, "shape", shape);
      return shape;
    },
    checks: []
  });
  return clone(schema, def);
}
function required(Class, schema, mask) {
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const oldShape = schema._zod.def.shape;
      const shape = { ...oldShape };
      if (mask) {
        for (const key in mask) {
          if (!(key in shape)) {
            throw new Error(`Unrecognized key: "${key}"`);
          }
          if (!mask[key])
            continue;
          shape[key] = new Class({
            type: "nonoptional",
            innerType: oldShape[key]
          });
        }
      } else {
        for (const key in oldShape) {
          shape[key] = new Class({
            type: "nonoptional",
            innerType: oldShape[key]
          });
        }
      }
      assignProp(this, "shape", shape);
      return shape;
    }
  });
  return clone(schema, def);
}
function aborted(x, startIndex = 0) {
  if (x.aborted === true)
    return true;
  for (let i = startIndex;i < x.issues.length; i++) {
    if (x.issues[i]?.continue !== true) {
      return true;
    }
  }
  return false;
}
function explicitlyAborted(x, startIndex = 0) {
  if (x.aborted === true)
    return true;
  for (let i = startIndex;i < x.issues.length; i++) {
    if (x.issues[i]?.continue === false) {
      return true;
    }
  }
  return false;
}
function prefixIssues(path, issues) {
  return issues.map((iss) => {
    var _a;
    (_a = iss).path ?? (_a.path = []);
    iss.path.unshift(path);
    return iss;
  });
}
function unwrapMessage(message) {
  return typeof message === "string" ? message : message?.message;
}
function finalizeIssue(iss, ctx, config) {
  const message = iss.message ? iss.message : unwrapMessage(iss.inst?._zod.def?.error?.(iss)) ?? unwrapMessage(ctx?.error?.(iss)) ?? unwrapMessage(config.customError?.(iss)) ?? unwrapMessage(config.localeError?.(iss)) ?? "Invalid input";
  const { inst: _inst, continue: _continue, input: _input, ...rest } = iss;
  rest.path ?? (rest.path = []);
  rest.message = message;
  if (ctx?.reportInput) {
    rest.input = _input;
  }
  return rest;
}
function getLengthableOrigin(input) {
  if (Array.isArray(input))
    return "array";
  if (typeof input === "string")
    return "string";
  return "unknown";
}
function issue(...args) {
  const [iss, input, inst] = args;
  if (typeof iss === "string") {
    return {
      message: iss,
      code: "custom",
      input,
      inst
    };
  }
  return { ...iss };
}

var initializer = (inst, def) => {
  inst.name = "$ZodError";
  Object.defineProperty(inst, "_zod", {
    value: inst._zod,
    enumerable: false
  });
  Object.defineProperty(inst, "issues", {
    value: def,
    enumerable: false
  });
  inst.message = JSON.stringify(def, jsonStringifyReplacer, 2);
  Object.defineProperty(inst, "toString", {
    value: () => inst.message,
    enumerable: false
  });
};
var $ZodError = $constructor("$ZodError", initializer);
var $ZodRealError = $constructor("$ZodError", initializer, { Parent: Error });
function flattenError(error, mapper = (issue) => issue.message) {
  const fieldErrors = {};
  const formErrors = [];
  for (const sub of error.issues) {
    if (sub.path.length > 0) {
      fieldErrors[sub.path[0]] = fieldErrors[sub.path[0]] || [];
      fieldErrors[sub.path[0]].push(mapper(sub));
    } else {
      formErrors.push(mapper(sub));
    }
  }
  return { formErrors, fieldErrors };
}
function formatError(error, mapper = (issue) => issue.message) {
  const fieldErrors = { _errors: [] };
  const processError = (error, path = []) => {
    for (const issue of error.issues) {
      if (issue.code === "invalid_union" && issue.errors.length) {
        issue.errors.map((issues) => processError({ issues }, [...path, ...issue.path]));
      } else if (issue.code === "invalid_key") {
        processError({ issues: issue.issues }, [...path, ...issue.path]);
      } else if (issue.code === "invalid_element") {
        processError({ issues: issue.issues }, [...path, ...issue.path]);
      } else {
        const fullpath = [...path, ...issue.path];
        if (fullpath.length === 0) {
          fieldErrors._errors.push(mapper(issue));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < fullpath.length) {
            const el = fullpath[i];
            const terminal = i === fullpath.length - 1;
            if (!terminal) {
              curr[el] = curr[el] || { _errors: [] };
            } else {
              curr[el] = curr[el] || { _errors: [] };
              curr[el]._errors.push(mapper(issue));
            }
            curr = curr[el];
            i++;
          }
        }
      }
    }
  };
  processError(error);
  return fieldErrors;
}

var _parse = (_Err) => (schema, value, _ctx, _params) => {
  const ctx = _ctx ? { ..._ctx, async: false } : { async: false };
  const result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise) {
    throw new $ZodAsyncError;
  }
  if (result.issues.length) {
    const e = new (_params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
    captureStackTrace(e, _params?.callee);
    throw e;
  }
  return result.value;
};
var _parseAsync = (_Err) => async (schema, value, _ctx, params) => {
  const ctx = _ctx ? { ..._ctx, async: true } : { async: true };
  let result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise)
    result = await result;
  if (result.issues.length) {
    const e = new (params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
    captureStackTrace(e, params?.callee);
    throw e;
  }
  return result.value;
};
var _safeParse = (_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, async: false } : { async: false };
  const result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise) {
    throw new $ZodAsyncError;
  }
  return result.issues.length ? {
    success: false,
    error: new (_Err ?? $ZodError)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  } : { success: true, data: result.value };
};
var safeParse = /* @__PURE__ */ _safeParse($ZodRealError);
var _safeParseAsync = (_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, async: true } : { async: true };
  let result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise)
    result = await result;
  return result.issues.length ? {
    success: false,
    error: new _Err(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  } : { success: true, data: result.value };
};
var safeParseAsync = /* @__PURE__ */ _safeParseAsync($ZodRealError);
var _encode = (_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, direction: "backward" } : { direction: "backward" };
  return _parse(_Err)(schema, value, ctx);
};
var _decode = (_Err) => (schema, value, _ctx) => {
  return _parse(_Err)(schema, value, _ctx);
};
var _encodeAsync = (_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, direction: "backward" } : { direction: "backward" };
  return _parseAsync(_Err)(schema, value, ctx);
};
var _decodeAsync = (_Err) => async (schema, value, _ctx) => {
  return _parseAsync(_Err)(schema, value, _ctx);
};
var _safeEncode = (_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, direction: "backward" } : { direction: "backward" };
  return _safeParse(_Err)(schema, value, ctx);
};
var _safeDecode = (_Err) => (schema, value, _ctx) => {
  return _safeParse(_Err)(schema, value, _ctx);
};
var _safeEncodeAsync = (_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, direction: "backward" } : { direction: "backward" };
  return _safeParseAsync(_Err)(schema, value, ctx);
};
var _safeDecodeAsync = (_Err) => async (schema, value, _ctx) => {
  return _safeParseAsync(_Err)(schema, value, _ctx);
};
var cuid = /^[cC][0-9a-z]{6,}$/;
var cuid2 = /^[0-9a-z]+$/;
var ulid = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/;
var xid = /^[0-9a-vA-V]{20}$/;
var ksuid = /^[A-Za-z0-9]{27}$/;
var nanoid = /^[a-zA-Z0-9_-]{21}$/;
var duration = /^P(?:(\d+W)|(?!.*W)(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+([.,]\d+)?S)?)?)$/;
var guid = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
var uuid = (version) => {
  if (!version)
    return /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
  return new RegExp(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-${version}[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$`);
};
var email = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
var _emoji = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
function emoji() {
  return new RegExp(_emoji, "u");
}
var ipv4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;
var cidrv4 = /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/([0-9]|[1-2][0-9]|3[0-2])$/;
var cidrv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|::|([0-9a-fA-F]{1,4})?::([0-9a-fA-F]{1,4}:?){0,6})\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64 = /^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$/;
var base64url = /^[A-Za-z0-9_-]*$/;
var httpProtocol = /^https?$/;
var e164 = /^\+[1-9]\d{6,14}$/;
var dateSource = `(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))`;
var date = /* @__PURE__ */ new RegExp(`^${dateSource}$`);
function timeSource(args) {
  const hhmm = `(?:[01]\\d|2[0-3]):[0-5]\\d`;
  const regex = typeof args.precision === "number" ? args.precision === -1 ? `${hhmm}` : args.precision === 0 ? `${hhmm}:[0-5]\\d` : `${hhmm}:[0-5]\\d\\.\\d{${args.precision}}` : `${hhmm}(?::[0-5]\\d(?:\\.\\d+)?)?`;
  return regex;
}
function time(args) {
  return new RegExp(`^${timeSource(args)}$`);
}
function datetime(args) {
  const time = timeSource({ precision: args.precision });
  const opts = ["Z"];
  if (args.local)
    opts.push("");
  if (args.offset)
    opts.push(`([+-](?:[01]\\d|2[0-3]):[0-5]\\d)`);
  const timeRegex = `${time}(?:${opts.join("|")})`;
  return new RegExp(`^${dateSource}T(?:${timeRegex})$`);
}
var string = (params) => {
  const regex = params ? `[\\s\\S]{${params?.minimum ?? 0},${params?.maximum ?? ""}}` : `[\\s\\S]*`;
  return new RegExp(`^${regex}$`);
};
var integer = /^-?\d+$/;
var number = /^-?\d+(?:\.\d+)?$/;
var boolean = /^(?:true|false)$/i;
var lowercase = /^[^A-Z]*$/;
var uppercase = /^[^a-z]*$/;

var $ZodCheck = /* @__PURE__ */ $constructor("$ZodCheck", (inst, def) => {
  var _a;
  inst._zod ?? (inst._zod = {});
  inst._zod.def = def;
  (_a = inst._zod).onattach ?? (_a.onattach = []);
});
var numericOriginMap = {
  number: "number",
  bigint: "bigint",
  object: "date"
};
var $ZodCheckLessThan = /* @__PURE__ */ $constructor("$ZodCheckLessThan", (inst, def) => {
  $ZodCheck.init(inst, def);
  const origin = numericOriginMap[typeof def.value];
  inst._zod.onattach.push((inst) => {
    const bag = inst._zod.bag;
    const curr = (def.inclusive ? bag.maximum : bag.exclusiveMaximum) ?? Number.POSITIVE_INFINITY;
    if (def.value < curr) {
      if (def.inclusive)
        bag.maximum = def.value;
      else
        bag.exclusiveMaximum = def.value;
    }
  });
  inst._zod.check = (payload) => {
    if (def.inclusive ? payload.value <= def.value : payload.value < def.value) {
      return;
    }
    payload.issues.push({
      origin,
      code: "too_big",
      maximum: typeof def.value === "object" ? def.value.getTime() : def.value,
      input: payload.value,
      inclusive: def.inclusive,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckGreaterThan = /* @__PURE__ */ $constructor("$ZodCheckGreaterThan", (inst, def) => {
  $ZodCheck.init(inst, def);
  const origin = numericOriginMap[typeof def.value];
  inst._zod.onattach.push((inst) => {
    const bag = inst._zod.bag;
    const curr = (def.inclusive ? bag.minimum : bag.exclusiveMinimum) ?? Number.NEGATIVE_INFINITY;
    if (def.value > curr) {
      if (def.inclusive)
        bag.minimum = def.value;
      else
        bag.exclusiveMinimum = def.value;
    }
  });
  inst._zod.check = (payload) => {
    if (def.inclusive ? payload.value >= def.value : payload.value > def.value) {
      return;
    }
    payload.issues.push({
      origin,
      code: "too_small",
      minimum: typeof def.value === "object" ? def.value.getTime() : def.value,
      input: payload.value,
      inclusive: def.inclusive,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckMultipleOf = /* @__PURE__ */ $constructor("$ZodCheckMultipleOf", (inst, def) => {
  $ZodCheck.init(inst, def);
  inst._zod.onattach.push((inst) => {
    var _a;
    (_a = inst._zod.bag).multipleOf ?? (_a.multipleOf = def.value);
  });
  inst._zod.check = (payload) => {
    if (typeof payload.value !== typeof def.value)
      throw new Error("Cannot mix number and bigint in multiple_of check.");
    const isMultiple = typeof payload.value === "bigint" ? payload.value % def.value === BigInt(0) : floatSafeRemainder(payload.value, def.value) === 0;
    if (isMultiple)
      return;
    payload.issues.push({
      origin: typeof payload.value,
      code: "not_multiple_of",
      divisor: def.value,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckNumberFormat = /* @__PURE__ */ $constructor("$ZodCheckNumberFormat", (inst, def) => {
  $ZodCheck.init(inst, def);
  def.format = def.format || "float64";
  const isInt = def.format?.includes("int");
  const origin = isInt ? "int" : "number";
  const [minimum, maximum] = NUMBER_FORMAT_RANGES[def.format];
  inst._zod.onattach.push((inst) => {
    const bag = inst._zod.bag;
    bag.format = def.format;
    bag.minimum = minimum;
    bag.maximum = maximum;
    if (isInt)
      bag.pattern = integer;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    if (isInt) {
      if (!Number.isInteger(input)) {
        payload.issues.push({
          expected: origin,
          format: def.format,
          code: "invalid_type",
          continue: false,
          input,
          inst
        });
        return;
      }
      if (!Number.isSafeInteger(input)) {
        if (input > 0) {
          payload.issues.push({
            input,
            code: "too_big",
            maximum: Number.MAX_SAFE_INTEGER,
            note: "Integers must be within the safe integer range.",
            inst,
            origin,
            inclusive: true,
            continue: !def.abort
          });
        } else {
          payload.issues.push({
            input,
            code: "too_small",
            minimum: Number.MIN_SAFE_INTEGER,
            note: "Integers must be within the safe integer range.",
            inst,
            origin,
            inclusive: true,
            continue: !def.abort
          });
        }
        return;
      }
    }
    if (input < minimum) {
      payload.issues.push({
        origin: "number",
        input,
        code: "too_small",
        minimum,
        inclusive: true,
        inst,
        continue: !def.abort
      });
    }
    if (input > maximum) {
      payload.issues.push({
        origin: "number",
        input,
        code: "too_big",
        maximum,
        inclusive: true,
        inst,
        continue: !def.abort
      });
    }
  };
});
var $ZodCheckMaxLength = /* @__PURE__ */ $constructor("$ZodCheckMaxLength", (inst, def) => {
  var _a;
  $ZodCheck.init(inst, def);
  (_a = inst._zod.def).when ?? (_a.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.length !== undefined;
  });
  inst._zod.onattach.push((inst) => {
    const curr = inst._zod.bag.maximum ?? Number.POSITIVE_INFINITY;
    if (def.maximum < curr)
      inst._zod.bag.maximum = def.maximum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const length = input.length;
    if (length <= def.maximum)
      return;
    const origin = getLengthableOrigin(input);
    payload.issues.push({
      origin,
      code: "too_big",
      maximum: def.maximum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckMinLength = /* @__PURE__ */ $constructor("$ZodCheckMinLength", (inst, def) => {
  var _a;
  $ZodCheck.init(inst, def);
  (_a = inst._zod.def).when ?? (_a.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.length !== undefined;
  });
  inst._zod.onattach.push((inst) => {
    const curr = inst._zod.bag.minimum ?? Number.NEGATIVE_INFINITY;
    if (def.minimum > curr)
      inst._zod.bag.minimum = def.minimum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const length = input.length;
    if (length >= def.minimum)
      return;
    const origin = getLengthableOrigin(input);
    payload.issues.push({
      origin,
      code: "too_small",
      minimum: def.minimum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckLengthEquals = /* @__PURE__ */ $constructor("$ZodCheckLengthEquals", (inst, def) => {
  var _a;
  $ZodCheck.init(inst, def);
  (_a = inst._zod.def).when ?? (_a.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.length !== undefined;
  });
  inst._zod.onattach.push((inst) => {
    const bag = inst._zod.bag;
    bag.minimum = def.length;
    bag.maximum = def.length;
    bag.length = def.length;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const length = input.length;
    if (length === def.length)
      return;
    const origin = getLengthableOrigin(input);
    const tooBig = length > def.length;
    payload.issues.push({
      origin,
      ...tooBig ? { code: "too_big", maximum: def.length } : { code: "too_small", minimum: def.length },
      inclusive: true,
      exact: true,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckStringFormat = /* @__PURE__ */ $constructor("$ZodCheckStringFormat", (inst, def) => {
  var _a, _b;
  $ZodCheck.init(inst, def);
  inst._zod.onattach.push((inst) => {
    const bag = inst._zod.bag;
    bag.format = def.format;
    if (def.pattern) {
      bag.patterns ?? (bag.patterns = new Set);
      bag.patterns.add(def.pattern);
    }
  });
  if (def.pattern)
    (_a = inst._zod).check ?? (_a.check = (payload) => {
      def.pattern.lastIndex = 0;
      if (def.pattern.test(payload.value))
        return;
      payload.issues.push({
        origin: "string",
        code: "invalid_format",
        format: def.format,
        input: payload.value,
        ...def.pattern ? { pattern: def.pattern.toString() } : {},
        inst,
        continue: !def.abort
      });
    });
  else
    (_b = inst._zod).check ?? (_b.check = () => {});
});
var $ZodCheckRegex = /* @__PURE__ */ $constructor("$ZodCheckRegex", (inst, def) => {
  $ZodCheckStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    def.pattern.lastIndex = 0;
    if (def.pattern.test(payload.value))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "regex",
      input: payload.value,
      pattern: def.pattern.toString(),
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckLowerCase = /* @__PURE__ */ $constructor("$ZodCheckLowerCase", (inst, def) => {
  def.pattern ?? (def.pattern = lowercase);
  $ZodCheckStringFormat.init(inst, def);
});
var $ZodCheckUpperCase = /* @__PURE__ */ $constructor("$ZodCheckUpperCase", (inst, def) => {
  def.pattern ?? (def.pattern = uppercase);
  $ZodCheckStringFormat.init(inst, def);
});
var $ZodCheckIncludes = /* @__PURE__ */ $constructor("$ZodCheckIncludes", (inst, def) => {
  $ZodCheck.init(inst, def);
  const escapedRegex = escapeRegex(def.includes);
  const pattern = new RegExp(typeof def.position === "number" ? `^.{${def.position}}${escapedRegex}` : escapedRegex);
  def.pattern = pattern;
  inst._zod.onattach.push((inst) => {
    const bag = inst._zod.bag;
    bag.patterns ?? (bag.patterns = new Set);
    bag.patterns.add(pattern);
  });
  inst._zod.check = (payload) => {
    if (payload.value.includes(def.includes, def.position))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "includes",
      includes: def.includes,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckStartsWith = /* @__PURE__ */ $constructor("$ZodCheckStartsWith", (inst, def) => {
  $ZodCheck.init(inst, def);
  const pattern = new RegExp(`^${escapeRegex(def.prefix)}.*`);
  def.pattern ?? (def.pattern = pattern);
  inst._zod.onattach.push((inst) => {
    const bag = inst._zod.bag;
    bag.patterns ?? (bag.patterns = new Set);
    bag.patterns.add(pattern);
  });
  inst._zod.check = (payload) => {
    if (payload.value.startsWith(def.prefix))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "starts_with",
      prefix: def.prefix,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckEndsWith = /* @__PURE__ */ $constructor("$ZodCheckEndsWith", (inst, def) => {
  $ZodCheck.init(inst, def);
  const pattern = new RegExp(`.*${escapeRegex(def.suffix)}$`);
  def.pattern ?? (def.pattern = pattern);
  inst._zod.onattach.push((inst) => {
    const bag = inst._zod.bag;
    bag.patterns ?? (bag.patterns = new Set);
    bag.patterns.add(pattern);
  });
  inst._zod.check = (payload) => {
    if (payload.value.endsWith(def.suffix))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "ends_with",
      suffix: def.suffix,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckOverwrite = /* @__PURE__ */ $constructor("$ZodCheckOverwrite", (inst, def) => {
  $ZodCheck.init(inst, def);
  inst._zod.check = (payload) => {
    payload.value = def.tx(payload.value);
  };
});

class Doc {
  constructor(args = []) {
    this.content = [];
    this.indent = 0;
    if (this)
      this.args = args;
  }
  indented(fn) {
    this.indent += 1;
    fn(this);
    this.indent -= 1;
  }
  write(arg) {
    if (typeof arg === "function") {
      arg(this, { execution: "sync" });
      arg(this, { execution: "async" });
      return;
    }
    const content = arg;
    const lines = content.split(`
`).filter((x) => x);
    const minIndent = Math.min(...lines.map((x) => x.length - x.trimStart().length));
    const dedented = lines.map((x) => x.slice(minIndent)).map((x) => " ".repeat(this.indent * 2) + x);
    for (const line of dedented) {
      this.content.push(line);
    }
  }
  compile() {
    const F = Function;
    const args = this?.args;
    const content = this?.content ?? [``];
    const lines = [...content.map((x) => `  ${x}`)];
    return new F(...args, lines.join(`
`));
  }
}

var version = {
  major: 4,
  minor: 4,
  patch: 3
};

var $ZodType = /* @__PURE__ */ $constructor("$ZodType", (inst, def) => {
  var _a;
  inst ?? (inst = {});
  inst._zod.def = def;
  inst._zod.bag = inst._zod.bag || {};
  inst._zod.version = version;
  const checks = [...inst._zod.def.checks ?? []];
  if (inst._zod.traits.has("$ZodCheck")) {
    checks.unshift(inst);
  }
  for (const ch of checks) {
    for (const fn of ch._zod.onattach) {
      fn(inst);
    }
  }
  if (checks.length === 0) {
    (_a = inst._zod).deferred ?? (_a.deferred = []);
    inst._zod.deferred?.push(() => {
      inst._zod.run = inst._zod.parse;
    });
  } else {
    const runChecks = (payload, checks, ctx) => {
      let isAborted = aborted(payload);
      let asyncResult;
      for (const ch of checks) {
        if (ch._zod.def.when) {
          if (explicitlyAborted(payload))
            continue;
          const shouldRun = ch._zod.def.when(payload);
          if (!shouldRun)
            continue;
        } else if (isAborted) {
          continue;
        }
        const currLen = payload.issues.length;
        const _ = ch._zod.check(payload);
        if (_ instanceof Promise && ctx?.async === false) {
          throw new $ZodAsyncError;
        }
        if (asyncResult || _ instanceof Promise) {
          asyncResult = (asyncResult ?? Promise.resolve()).then(async () => {
            await _;
            const nextLen = payload.issues.length;
            if (nextLen === currLen)
              return;
            if (!isAborted)
              isAborted = aborted(payload, currLen);
          });
        } else {
          const nextLen = payload.issues.length;
          if (nextLen === currLen)
            continue;
          if (!isAborted)
            isAborted = aborted(payload, currLen);
        }
      }
      if (asyncResult) {
        return asyncResult.then(() => {
          return payload;
        });
      }
      return payload;
    };
    const handleCanaryResult = (canary, payload, ctx) => {
      if (aborted(canary)) {
        canary.aborted = true;
        return canary;
      }
      const checkResult = runChecks(payload, checks, ctx);
      if (checkResult instanceof Promise) {
        if (ctx.async === false)
          throw new $ZodAsyncError;
        return checkResult.then((checkResult) => inst._zod.parse(checkResult, ctx));
      }
      return inst._zod.parse(checkResult, ctx);
    };
    inst._zod.run = (payload, ctx) => {
      if (ctx.skipChecks) {
        return inst._zod.parse(payload, ctx);
      }
      if (ctx.direction === "backward") {
        const canary = inst._zod.parse({ value: payload.value, issues: [] }, { ...ctx, skipChecks: true });
        if (canary instanceof Promise) {
          return canary.then((canary) => {
            return handleCanaryResult(canary, payload, ctx);
          });
        }
        return handleCanaryResult(canary, payload, ctx);
      }
      const result = inst._zod.parse(payload, ctx);
      if (result instanceof Promise) {
        if (ctx.async === false)
          throw new $ZodAsyncError;
        return result.then((result) => runChecks(result, checks, ctx));
      }
      return runChecks(result, checks, ctx);
    };
  }
  defineLazy(inst, "~standard", () => ({
    validate: (value) => {
      try {
        const r = safeParse(inst, value);
        return r.success ? { value: r.data } : { issues: r.error?.issues };
      } catch (_) {
        return safeParseAsync(inst, value).then((r) => r.success ? { value: r.data } : { issues: r.error?.issues });
      }
    },
    vendor: "zod",
    version: 1
  }));
});
var $ZodString = /* @__PURE__ */ $constructor("$ZodString", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = [...inst?._zod.bag?.patterns ?? []].pop() ?? string(inst._zod.bag);
  inst._zod.parse = (payload, _) => {
    if (def.coerce)
      try {
        payload.value = String(payload.value);
      } catch (_) {}
    if (typeof payload.value === "string")
      return payload;
    payload.issues.push({
      expected: "string",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
var $ZodStringFormat = /* @__PURE__ */ $constructor("$ZodStringFormat", (inst, def) => {
  $ZodCheckStringFormat.init(inst, def);
  $ZodString.init(inst, def);
});
var $ZodGUID = /* @__PURE__ */ $constructor("$ZodGUID", (inst, def) => {
  def.pattern ?? (def.pattern = guid);
  $ZodStringFormat.init(inst, def);
});
var $ZodUUID = /* @__PURE__ */ $constructor("$ZodUUID", (inst, def) => {
  if (def.version) {
    const versionMap = {
      v1: 1,
      v2: 2,
      v3: 3,
      v4: 4,
      v5: 5,
      v6: 6,
      v7: 7,
      v8: 8
    };
    const v = versionMap[def.version];
    if (v === undefined)
      throw new Error(`Invalid UUID version: "${def.version}"`);
    def.pattern ?? (def.pattern = uuid(v));
  } else
    def.pattern ?? (def.pattern = uuid());
  $ZodStringFormat.init(inst, def);
});
var $ZodEmail = /* @__PURE__ */ $constructor("$ZodEmail", (inst, def) => {
  def.pattern ?? (def.pattern = email);
  $ZodStringFormat.init(inst, def);
});
var $ZodURL = /* @__PURE__ */ $constructor("$ZodURL", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    try {
      const trimmed = payload.value.trim();
      if (!def.normalize && def.protocol?.source === httpProtocol.source) {
        if (!/^https?:\/\//i.test(trimmed)) {
          payload.issues.push({
            code: "invalid_format",
            format: "url",
            note: "Invalid URL format",
            input: payload.value,
            inst,
            continue: !def.abort
          });
          return;
        }
      }
      const url = new URL(trimmed);
      if (def.hostname) {
        def.hostname.lastIndex = 0;
        if (!def.hostname.test(url.hostname)) {
          payload.issues.push({
            code: "invalid_format",
            format: "url",
            note: "Invalid hostname",
            pattern: def.hostname.source,
            input: payload.value,
            inst,
            continue: !def.abort
          });
        }
      }
      if (def.protocol) {
        def.protocol.lastIndex = 0;
        if (!def.protocol.test(url.protocol.endsWith(":") ? url.protocol.slice(0, -1) : url.protocol)) {
          payload.issues.push({
            code: "invalid_format",
            format: "url",
            note: "Invalid protocol",
            pattern: def.protocol.source,
            input: payload.value,
            inst,
            continue: !def.abort
          });
        }
      }
      if (def.normalize) {
        payload.value = url.href;
      } else {
        payload.value = trimmed;
      }
      return;
    } catch (_) {
      payload.issues.push({
        code: "invalid_format",
        format: "url",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
var $ZodEmoji = /* @__PURE__ */ $constructor("$ZodEmoji", (inst, def) => {
  def.pattern ?? (def.pattern = emoji());
  $ZodStringFormat.init(inst, def);
});
var $ZodNanoID = /* @__PURE__ */ $constructor("$ZodNanoID", (inst, def) => {
  def.pattern ?? (def.pattern = nanoid);
  $ZodStringFormat.init(inst, def);
});
var $ZodCUID = /* @__PURE__ */ $constructor("$ZodCUID", (inst, def) => {
  def.pattern ?? (def.pattern = cuid);
  $ZodStringFormat.init(inst, def);
});
var $ZodCUID2 = /* @__PURE__ */ $constructor("$ZodCUID2", (inst, def) => {
  def.pattern ?? (def.pattern = cuid2);
  $ZodStringFormat.init(inst, def);
});
var $ZodULID = /* @__PURE__ */ $constructor("$ZodULID", (inst, def) => {
  def.pattern ?? (def.pattern = ulid);
  $ZodStringFormat.init(inst, def);
});
var $ZodXID = /* @__PURE__ */ $constructor("$ZodXID", (inst, def) => {
  def.pattern ?? (def.pattern = xid);
  $ZodStringFormat.init(inst, def);
});
var $ZodKSUID = /* @__PURE__ */ $constructor("$ZodKSUID", (inst, def) => {
  def.pattern ?? (def.pattern = ksuid);
  $ZodStringFormat.init(inst, def);
});
var $ZodISODateTime = /* @__PURE__ */ $constructor("$ZodISODateTime", (inst, def) => {
  def.pattern ?? (def.pattern = datetime(def));
  $ZodStringFormat.init(inst, def);
});
var $ZodISODate = /* @__PURE__ */ $constructor("$ZodISODate", (inst, def) => {
  def.pattern ?? (def.pattern = date);
  $ZodStringFormat.init(inst, def);
});
var $ZodISOTime = /* @__PURE__ */ $constructor("$ZodISOTime", (inst, def) => {
  def.pattern ?? (def.pattern = time(def));
  $ZodStringFormat.init(inst, def);
});
var $ZodISODuration = /* @__PURE__ */ $constructor("$ZodISODuration", (inst, def) => {
  def.pattern ?? (def.pattern = duration);
  $ZodStringFormat.init(inst, def);
});
var $ZodIPv4 = /* @__PURE__ */ $constructor("$ZodIPv4", (inst, def) => {
  def.pattern ?? (def.pattern = ipv4);
  $ZodStringFormat.init(inst, def);
  inst._zod.bag.format = `ipv4`;
});
var $ZodIPv6 = /* @__PURE__ */ $constructor("$ZodIPv6", (inst, def) => {
  def.pattern ?? (def.pattern = ipv6);
  $ZodStringFormat.init(inst, def);
  inst._zod.bag.format = `ipv6`;
  inst._zod.check = (payload) => {
    try {
      new URL(`http://[${payload.value}]`);
    } catch {
      payload.issues.push({
        code: "invalid_format",
        format: "ipv6",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
var $ZodCIDRv4 = /* @__PURE__ */ $constructor("$ZodCIDRv4", (inst, def) => {
  def.pattern ?? (def.pattern = cidrv4);
  $ZodStringFormat.init(inst, def);
});
var $ZodCIDRv6 = /* @__PURE__ */ $constructor("$ZodCIDRv6", (inst, def) => {
  def.pattern ?? (def.pattern = cidrv6);
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    const parts = payload.value.split("/");
    try {
      if (parts.length !== 2)
        throw new Error;
      const [address, prefix] = parts;
      if (!prefix)
        throw new Error;
      const prefixNum = Number(prefix);
      if (`${prefixNum}` !== prefix)
        throw new Error;
      if (prefixNum < 0 || prefixNum > 128)
        throw new Error;
      new URL(`http://[${address}]`);
    } catch {
      payload.issues.push({
        code: "invalid_format",
        format: "cidrv6",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
function isValidBase64(data) {
  if (data === "")
    return true;
  if (/\s/.test(data))
    return false;
  if (data.length % 4 !== 0)
    return false;
  try {
    atob(data);
    return true;
  } catch {
    return false;
  }
}
var $ZodBase64 = /* @__PURE__ */ $constructor("$ZodBase64", (inst, def) => {
  def.pattern ?? (def.pattern = base64);
  $ZodStringFormat.init(inst, def);
  inst._zod.bag.contentEncoding = "base64";
  inst._zod.check = (payload) => {
    if (isValidBase64(payload.value))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "base64",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
function isValidBase64URL(data) {
  if (!base64url.test(data))
    return false;
  const base64 = data.replace(/[-_]/g, (c) => c === "-" ? "+" : "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return isValidBase64(padded);
}
var $ZodBase64URL = /* @__PURE__ */ $constructor("$ZodBase64URL", (inst, def) => {
  def.pattern ?? (def.pattern = base64url);
  $ZodStringFormat.init(inst, def);
  inst._zod.bag.contentEncoding = "base64url";
  inst._zod.check = (payload) => {
    if (isValidBase64URL(payload.value))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "base64url",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodE164 = /* @__PURE__ */ $constructor("$ZodE164", (inst, def) => {
  def.pattern ?? (def.pattern = e164);
  $ZodStringFormat.init(inst, def);
});
function isValidJWT(token, algorithm = null) {
  try {
    const tokensParts = token.split(".");
    if (tokensParts.length !== 3)
      return false;
    const [header] = tokensParts;
    if (!header)
      return false;
    const parsedHeader = JSON.parse(atob(header));
    if ("typ" in parsedHeader && parsedHeader?.typ !== "JWT")
      return false;
    if (!parsedHeader.alg)
      return false;
    if (algorithm && (!("alg" in parsedHeader) || parsedHeader.alg !== algorithm))
      return false;
    return true;
  } catch {
    return false;
  }
}
var $ZodJWT = /* @__PURE__ */ $constructor("$ZodJWT", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (isValidJWT(payload.value, def.alg))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "jwt",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodNumber = /* @__PURE__ */ $constructor("$ZodNumber", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = inst._zod.bag.pattern ?? number;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = Number(payload.value);
      } catch (_) {}
    const input = payload.value;
    if (typeof input === "number" && !Number.isNaN(input) && Number.isFinite(input)) {
      return payload;
    }
    const received = typeof input === "number" ? Number.isNaN(input) ? "NaN" : !Number.isFinite(input) ? "Infinity" : undefined : undefined;
    payload.issues.push({
      expected: "number",
      code: "invalid_type",
      input,
      inst,
      ...received ? { received } : {}
    });
    return payload;
  };
});
var $ZodNumberFormat = /* @__PURE__ */ $constructor("$ZodNumberFormat", (inst, def) => {
  $ZodCheckNumberFormat.init(inst, def);
  $ZodNumber.init(inst, def);
});
var $ZodBoolean = /* @__PURE__ */ $constructor("$ZodBoolean", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = boolean;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = Boolean(payload.value);
      } catch (_) {}
    const input = payload.value;
    if (typeof input === "boolean")
      return payload;
    payload.issues.push({
      expected: "boolean",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodUnknown = /* @__PURE__ */ $constructor("$ZodUnknown", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload) => payload;
});
var $ZodNever = /* @__PURE__ */ $constructor("$ZodNever", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    payload.issues.push({
      expected: "never",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
function handleArrayResult(result, final, index) {
  if (result.issues.length) {
    final.issues.push(...prefixIssues(index, result.issues));
  }
  final.value[index] = result.value;
}
var $ZodArray = /* @__PURE__ */ $constructor("$ZodArray", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!Array.isArray(input)) {
      payload.issues.push({
        expected: "array",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    payload.value = Array(input.length);
    const proms = [];
    for (let i = 0;i < input.length; i++) {
      const item = input[i];
      const result = def.element._zod.run({
        value: item,
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        proms.push(result.then((result) => handleArrayResult(result, payload, i)));
      } else {
        handleArrayResult(result, payload, i);
      }
    }
    if (proms.length) {
      return Promise.all(proms).then(() => payload);
    }
    return payload;
  };
});
function handlePropertyResult(result, final, key, input, isOptionalIn, isOptionalOut) {
  const isPresent = key in input;
  if (result.issues.length) {
    if (isOptionalIn && isOptionalOut && !isPresent) {
      return;
    }
    final.issues.push(...prefixIssues(key, result.issues));
  }
  if (!isPresent && !isOptionalIn) {
    if (!result.issues.length) {
      final.issues.push({
        code: "invalid_type",
        expected: "nonoptional",
        input: undefined,
        path: [key]
      });
    }
    return;
  }
  if (result.value === undefined) {
    if (isPresent) {
      final.value[key] = undefined;
    }
  } else {
    final.value[key] = result.value;
  }
}
function normalizeDef(def) {
  const keys = Object.keys(def.shape);
  for (const k of keys) {
    if (!def.shape?.[k]?._zod?.traits?.has("$ZodType")) {
      throw new Error(`Invalid element at key "${k}": expected a Zod schema`);
    }
  }
  const okeys = optionalKeys(def.shape);
  return {
    ...def,
    keys,
    keySet: new Set(keys),
    numKeys: keys.length,
    optionalKeys: new Set(okeys)
  };
}
function handleCatchall(proms, input, payload, ctx, def, inst) {
  const unrecognized = [];
  const keySet = def.keySet;
  const _catchall = def.catchall._zod;
  const t = _catchall.def.type;
  const isOptionalIn = _catchall.optin === "optional";
  const isOptionalOut = _catchall.optout === "optional";
  for (const key in input) {
    if (key === "__proto__")
      continue;
    if (keySet.has(key))
      continue;
    if (t === "never") {
      unrecognized.push(key);
      continue;
    }
    const r = _catchall.run({ value: input[key], issues: [] }, ctx);
    if (r instanceof Promise) {
      proms.push(r.then((r) => handlePropertyResult(r, payload, key, input, isOptionalIn, isOptionalOut)));
    } else {
      handlePropertyResult(r, payload, key, input, isOptionalIn, isOptionalOut);
    }
  }
  if (unrecognized.length) {
    payload.issues.push({
      code: "unrecognized_keys",
      keys: unrecognized,
      input,
      inst
    });
  }
  if (!proms.length)
    return payload;
  return Promise.all(proms).then(() => {
    return payload;
  });
}
var $ZodObject = /* @__PURE__ */ $constructor("$ZodObject", (inst, def) => {
  $ZodType.init(inst, def);
  const desc = Object.getOwnPropertyDescriptor(def, "shape");
  if (!desc?.get) {
    const sh = def.shape;
    Object.defineProperty(def, "shape", {
      get: () => {
        const newSh = { ...sh };
        Object.defineProperty(def, "shape", {
          value: newSh
        });
        return newSh;
      }
    });
  }
  const _normalized = cached(() => normalizeDef(def));
  defineLazy(inst._zod, "propValues", () => {
    const shape = def.shape;
    const propValues = {};
    for (const key in shape) {
      const field = shape[key]._zod;
      if (field.values) {
        propValues[key] ?? (propValues[key] = new Set);
        for (const v of field.values)
          propValues[key].add(v);
      }
    }
    return propValues;
  });
  const isObject2 = isObject;
  const catchall = def.catchall;
  let value;
  inst._zod.parse = (payload, ctx) => {
    value ?? (value = _normalized.value);
    const input = payload.value;
    if (!isObject2(input)) {
      payload.issues.push({
        expected: "object",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    payload.value = {};
    const proms = [];
    const shape = value.shape;
    for (const key of value.keys) {
      const el = shape[key];
      const isOptionalIn = el._zod.optin === "optional";
      const isOptionalOut = el._zod.optout === "optional";
      const r = el._zod.run({ value: input[key], issues: [] }, ctx);
      if (r instanceof Promise) {
        proms.push(r.then((r) => handlePropertyResult(r, payload, key, input, isOptionalIn, isOptionalOut)));
      } else {
        handlePropertyResult(r, payload, key, input, isOptionalIn, isOptionalOut);
      }
    }
    if (!catchall) {
      return proms.length ? Promise.all(proms).then(() => payload) : payload;
    }
    return handleCatchall(proms, input, payload, ctx, _normalized.value, inst);
  };
});
var $ZodObjectJIT = /* @__PURE__ */ $constructor("$ZodObjectJIT", (inst, def) => {
  $ZodObject.init(inst, def);
  const superParse = inst._zod.parse;
  const _normalized = cached(() => normalizeDef(def));
  const generateFastpass = (shape) => {
    const doc = new Doc(["shape", "payload", "ctx"]);
    const normalized = _normalized.value;
    const parseStr = (key) => {
      const k = esc(key);
      return `shape[${k}]._zod.run({ value: input[${k}], issues: [] }, ctx)`;
    };
    doc.write(`const input = payload.value;`);
    const ids = Object.create(null);
    let counter = 0;
    for (const key of normalized.keys) {
      ids[key] = `key_${counter++}`;
    }
    doc.write(`const newResult = {};`);
    for (const key of normalized.keys) {
      const id = ids[key];
      const k = esc(key);
      const schema = shape[key];
      const isOptionalIn = schema?._zod?.optin === "optional";
      const isOptionalOut = schema?._zod?.optout === "optional";
      doc.write(`const ${id} = ${parseStr(key)};`);
      if (isOptionalIn && isOptionalOut) {
        doc.write(`
        if (${id}.issues.length) {
          if (${k} in input) {
            payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
              ...iss,
              path: iss.path ? [${k}, ...iss.path] : [${k}]
            })));
          }
        }
        
        if (${id}.value === undefined) {
          if (${k} in input) {
            newResult[${k}] = undefined;
          }
        } else {
          newResult[${k}] = ${id}.value;
        }
        
      `);
      } else if (!isOptionalIn) {
        doc.write(`
        const ${id}_present = ${k} in input;
        if (${id}.issues.length) {
          payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
            ...iss,
            path: iss.path ? [${k}, ...iss.path] : [${k}]
          })));
        }
        if (!${id}_present && !${id}.issues.length) {
          payload.issues.push({
            code: "invalid_type",
            expected: "nonoptional",
            input: undefined,
            path: [${k}]
          });
        }

        if (${id}_present) {
          if (${id}.value === undefined) {
            newResult[${k}] = undefined;
          } else {
            newResult[${k}] = ${id}.value;
          }
        }

      `);
      } else {
        doc.write(`
        if (${id}.issues.length) {
          payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
            ...iss,
            path: iss.path ? [${k}, ...iss.path] : [${k}]
          })));
        }
        
        if (${id}.value === undefined) {
          if (${k} in input) {
            newResult[${k}] = undefined;
          }
        } else {
          newResult[${k}] = ${id}.value;
        }
        
      `);
      }
    }
    doc.write(`payload.value = newResult;`);
    doc.write(`return payload;`);
    const fn = doc.compile();
    return (payload, ctx) => fn(shape, payload, ctx);
  };
  let fastpass;
  const isObject2 = isObject;
  const jit = !globalConfig.jitless;
  const allowsEval2 = allowsEval;
  const fastEnabled = jit && allowsEval2.value;
  const catchall = def.catchall;
  let value;
  inst._zod.parse = (payload, ctx) => {
    value ?? (value = _normalized.value);
    const input = payload.value;
    if (!isObject2(input)) {
      payload.issues.push({
        expected: "object",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    if (jit && fastEnabled && ctx?.async === false && ctx.jitless !== true) {
      if (!fastpass)
        fastpass = generateFastpass(def.shape);
      payload = fastpass(payload, ctx);
      if (!catchall)
        return payload;
      return handleCatchall([], input, payload, ctx, value, inst);
    }
    return superParse(payload, ctx);
  };
});
function handleUnionResults(results, final, inst, ctx) {
  for (const result of results) {
    if (result.issues.length === 0) {
      final.value = result.value;
      return final;
    }
  }
  const nonaborted = results.filter((r) => !aborted(r));
  if (nonaborted.length === 1) {
    final.value = nonaborted[0].value;
    return nonaborted[0];
  }
  final.issues.push({
    code: "invalid_union",
    input: final.value,
    inst,
    errors: results.map((result) => result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  });
  return final;
}
var $ZodUnion = /* @__PURE__ */ $constructor("$ZodUnion", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "optin", () => def.options.some((o) => o._zod.optin === "optional") ? "optional" : undefined);
  defineLazy(inst._zod, "optout", () => def.options.some((o) => o._zod.optout === "optional") ? "optional" : undefined);
  defineLazy(inst._zod, "values", () => {
    if (def.options.every((o) => o._zod.values)) {
      return new Set(def.options.flatMap((option) => Array.from(option._zod.values)));
    }
    return;
  });
  defineLazy(inst._zod, "pattern", () => {
    if (def.options.every((o) => o._zod.pattern)) {
      const patterns = def.options.map((o) => o._zod.pattern);
      return new RegExp(`^(${patterns.map((p) => cleanRegex(p.source)).join("|")})$`);
    }
    return;
  });
  const first = def.options.length === 1 ? def.options[0]._zod.run : null;
  inst._zod.parse = (payload, ctx) => {
    if (first) {
      return first(payload, ctx);
    }
    let async = false;
    const results = [];
    for (const option of def.options) {
      const result = option._zod.run({
        value: payload.value,
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        results.push(result);
        async = true;
      } else {
        if (result.issues.length === 0)
          return result;
        results.push(result);
      }
    }
    if (!async)
      return handleUnionResults(results, payload, inst, ctx);
    return Promise.all(results).then((results) => {
      return handleUnionResults(results, payload, inst, ctx);
    });
  };
});
var $ZodIntersection = /* @__PURE__ */ $constructor("$ZodIntersection", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    const left = def.left._zod.run({ value: input, issues: [] }, ctx);
    const right = def.right._zod.run({ value: input, issues: [] }, ctx);
    const async = left instanceof Promise || right instanceof Promise;
    if (async) {
      return Promise.all([left, right]).then(([left, right]) => {
        return handleIntersectionResults(payload, left, right);
      });
    }
    return handleIntersectionResults(payload, left, right);
  };
});
function mergeValues(a, b) {
  if (a === b) {
    return { valid: true, data: a };
  }
  if (a instanceof Date && b instanceof Date && +a === +b) {
    return { valid: true, data: a };
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const bKeys = Object.keys(b);
    const sharedKeys = Object.keys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return {
          valid: false,
          mergeErrorPath: [key, ...sharedValue.mergeErrorPath]
        };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return { valid: false, mergeErrorPath: [] };
    }
    const newArray = [];
    for (let index = 0;index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return {
          valid: false,
          mergeErrorPath: [index, ...sharedValue.mergeErrorPath]
        };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  }
  return { valid: false, mergeErrorPath: [] };
}
function handleIntersectionResults(result, left, right) {
  const unrecKeys = new Map;
  let unrecIssue;
  for (const iss of left.issues) {
    if (iss.code === "unrecognized_keys") {
      unrecIssue ?? (unrecIssue = iss);
      for (const k of iss.keys) {
        if (!unrecKeys.has(k))
          unrecKeys.set(k, {});
        unrecKeys.get(k).l = true;
      }
    } else {
      result.issues.push(iss);
    }
  }
  for (const iss of right.issues) {
    if (iss.code === "unrecognized_keys") {
      for (const k of iss.keys) {
        if (!unrecKeys.has(k))
          unrecKeys.set(k, {});
        unrecKeys.get(k).r = true;
      }
    } else {
      result.issues.push(iss);
    }
  }
  const bothKeys = [...unrecKeys].filter(([, f]) => f.l && f.r).map(([k]) => k);
  if (bothKeys.length && unrecIssue) {
    result.issues.push({ ...unrecIssue, keys: bothKeys });
  }
  if (aborted(result))
    return result;
  const merged = mergeValues(left.value, right.value);
  if (!merged.valid) {
    throw new Error(`Unmergable intersection. Error path: ` + `${JSON.stringify(merged.mergeErrorPath)}`);
  }
  result.value = merged.data;
  return result;
}
var $ZodEnum = /* @__PURE__ */ $constructor("$ZodEnum", (inst, def) => {
  $ZodType.init(inst, def);
  const values = getEnumValues(def.entries);
  const valuesSet = new Set(values);
  inst._zod.values = valuesSet;
  inst._zod.pattern = new RegExp(`^(${values.filter((k) => propertyKeyTypes.has(typeof k)).map((o) => typeof o === "string" ? escapeRegex(o) : o.toString()).join("|")})$`);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (valuesSet.has(input)) {
      return payload;
    }
    payload.issues.push({
      code: "invalid_value",
      values,
      input,
      inst
    });
    return payload;
  };
});
var $ZodLiteral = /* @__PURE__ */ $constructor("$ZodLiteral", (inst, def) => {
  $ZodType.init(inst, def);
  if (def.values.length === 0) {
    throw new Error("Cannot create literal schema with no valid values");
  }
  const values = new Set(def.values);
  inst._zod.values = values;
  inst._zod.pattern = new RegExp(`^(${def.values.map((o) => typeof o === "string" ? escapeRegex(o) : o ? escapeRegex(o.toString()) : String(o)).join("|")})$`);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (values.has(input)) {
      return payload;
    }
    payload.issues.push({
      code: "invalid_value",
      values: def.values,
      input,
      inst
    });
    return payload;
  };
});
var $ZodTransform = /* @__PURE__ */ $constructor("$ZodTransform", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "optional";
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      throw new $ZodEncodeError(inst.constructor.name);
    }
    const _out = def.transform(payload.value, payload);
    if (ctx.async) {
      const output = _out instanceof Promise ? _out : Promise.resolve(_out);
      return output.then((output) => {
        payload.value = output;
        payload.fallback = true;
        return payload;
      });
    }
    if (_out instanceof Promise) {
      throw new $ZodAsyncError;
    }
    payload.value = _out;
    payload.fallback = true;
    return payload;
  };
});
function handleOptionalResult(result, input) {
  if (input === undefined && (result.issues.length || result.fallback)) {
    return { issues: [], value: undefined };
  }
  return result;
}
var $ZodOptional = /* @__PURE__ */ $constructor("$ZodOptional", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "optional";
  inst._zod.optout = "optional";
  defineLazy(inst._zod, "values", () => {
    return def.innerType._zod.values ? new Set([...def.innerType._zod.values, undefined]) : undefined;
  });
  defineLazy(inst._zod, "pattern", () => {
    const pattern = def.innerType._zod.pattern;
    return pattern ? new RegExp(`^(${cleanRegex(pattern.source)})?$`) : undefined;
  });
  inst._zod.parse = (payload, ctx) => {
    if (def.innerType._zod.optin === "optional") {
      const input = payload.value;
      const result = def.innerType._zod.run(payload, ctx);
      if (result instanceof Promise)
        return result.then((r) => handleOptionalResult(r, input));
      return handleOptionalResult(result, input);
    }
    if (payload.value === undefined) {
      return payload;
    }
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodExactOptional = /* @__PURE__ */ $constructor("$ZodExactOptional", (inst, def) => {
  $ZodOptional.init(inst, def);
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  defineLazy(inst._zod, "pattern", () => def.innerType._zod.pattern);
  inst._zod.parse = (payload, ctx) => {
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodNullable = /* @__PURE__ */ $constructor("$ZodNullable", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "optin", () => def.innerType._zod.optin);
  defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
  defineLazy(inst._zod, "pattern", () => {
    const pattern = def.innerType._zod.pattern;
    return pattern ? new RegExp(`^(${cleanRegex(pattern.source)}|null)$`) : undefined;
  });
  defineLazy(inst._zod, "values", () => {
    return def.innerType._zod.values ? new Set([...def.innerType._zod.values, null]) : undefined;
  });
  inst._zod.parse = (payload, ctx) => {
    if (payload.value === null)
      return payload;
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodDefault = /* @__PURE__ */ $constructor("$ZodDefault", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "optional";
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    if (payload.value === undefined) {
      payload.value = def.defaultValue;
      return payload;
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result) => handleDefaultResult(result, def));
    }
    return handleDefaultResult(result, def);
  };
});
function handleDefaultResult(payload, def) {
  if (payload.value === undefined) {
    payload.value = def.defaultValue;
  }
  return payload;
}
var $ZodPrefault = /* @__PURE__ */ $constructor("$ZodPrefault", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "optional";
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    if (payload.value === undefined) {
      payload.value = def.defaultValue;
    }
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodNonOptional = /* @__PURE__ */ $constructor("$ZodNonOptional", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "values", () => {
    const v = def.innerType._zod.values;
    return v ? new Set([...v].filter((x) => x !== undefined)) : undefined;
  });
  inst._zod.parse = (payload, ctx) => {
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result) => handleNonOptionalResult(result, inst));
    }
    return handleNonOptionalResult(result, inst);
  };
});
function handleNonOptionalResult(payload, inst) {
  if (!payload.issues.length && payload.value === undefined) {
    payload.issues.push({
      code: "invalid_type",
      expected: "nonoptional",
      input: payload.value,
      inst
    });
  }
  return payload;
}
var $ZodCatch = /* @__PURE__ */ $constructor("$ZodCatch", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "optional";
  defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result) => {
        payload.value = result.value;
        if (result.issues.length) {
          payload.value = def.catchValue({
            ...payload,
            error: {
              issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config()))
            },
            input: payload.value
          });
          payload.issues = [];
          payload.fallback = true;
        }
        return payload;
      });
    }
    payload.value = result.value;
    if (result.issues.length) {
      payload.value = def.catchValue({
        ...payload,
        error: {
          issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config()))
        },
        input: payload.value
      });
      payload.issues = [];
      payload.fallback = true;
    }
    return payload;
  };
});
var $ZodPipe = /* @__PURE__ */ $constructor("$ZodPipe", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "values", () => def.in._zod.values);
  defineLazy(inst._zod, "optin", () => def.in._zod.optin);
  defineLazy(inst._zod, "optout", () => def.out._zod.optout);
  defineLazy(inst._zod, "propValues", () => def.in._zod.propValues);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      const right = def.out._zod.run(payload, ctx);
      if (right instanceof Promise) {
        return right.then((right) => handlePipeResult(right, def.in, ctx));
      }
      return handlePipeResult(right, def.in, ctx);
    }
    const left = def.in._zod.run(payload, ctx);
    if (left instanceof Promise) {
      return left.then((left) => handlePipeResult(left, def.out, ctx));
    }
    return handlePipeResult(left, def.out, ctx);
  };
});
function handlePipeResult(left, next, ctx) {
  if (left.issues.length) {
    left.aborted = true;
    return left;
  }
  return next._zod.run({ value: left.value, issues: left.issues, fallback: left.fallback }, ctx);
}
var $ZodReadonly = /* @__PURE__ */ $constructor("$ZodReadonly", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "propValues", () => def.innerType._zod.propValues);
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  defineLazy(inst._zod, "optin", () => def.innerType?._zod?.optin);
  defineLazy(inst._zod, "optout", () => def.innerType?._zod?.optout);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then(handleReadonlyResult);
    }
    return handleReadonlyResult(result);
  };
});
function handleReadonlyResult(payload) {
  payload.value = Object.freeze(payload.value);
  return payload;
}
var $ZodCustom = /* @__PURE__ */ $constructor("$ZodCustom", (inst, def) => {
  $ZodCheck.init(inst, def);
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _) => {
    return payload;
  };
  inst._zod.check = (payload) => {
    const input = payload.value;
    const r = def.fn(input);
    if (r instanceof Promise) {
      return r.then((r) => handleRefineResult(r, payload, input, inst));
    }
    handleRefineResult(r, payload, input, inst);
    return;
  };
});
function handleRefineResult(result, payload, input, inst) {
  if (!result) {
    const _iss = {
      code: "custom",
      input,
      inst,
      path: [...inst._zod.def.path ?? []],
      continue: !inst._zod.def.abort
    };
    if (inst._zod.def.params)
      _iss.params = inst._zod.def.params;
    payload.issues.push(issue(_iss));
  }
}
var _a2;
var $output = Symbol("ZodOutput");
var $input = Symbol("ZodInput");

class $ZodRegistry {
  constructor() {
    this._map = new WeakMap;
    this._idmap = new Map;
  }
  add(schema, ..._meta) {
    const meta = _meta[0];
    this._map.set(schema, meta);
    if (meta && typeof meta === "object" && "id" in meta) {
      this._idmap.set(meta.id, schema);
    }
    return this;
  }
  clear() {
    this._map = new WeakMap;
    this._idmap = new Map;
    return this;
  }
  remove(schema) {
    const meta = this._map.get(schema);
    if (meta && typeof meta === "object" && "id" in meta) {
      this._idmap.delete(meta.id);
    }
    this._map.delete(schema);
    return this;
  }
  get(schema) {
    const p = schema._zod.parent;
    if (p) {
      const pm = { ...this.get(p) ?? {} };
      delete pm.id;
      const f = { ...pm, ...this._map.get(schema) };
      return Object.keys(f).length ? f : undefined;
    }
    return this._map.get(schema);
  }
  has(schema) {
    return this._map.has(schema);
  }
}
function registry() {
  return new $ZodRegistry;
}
(_a2 = globalThis).__zod_globalRegistry ?? (_a2.__zod_globalRegistry = registry());
var globalRegistry = globalThis.__zod_globalRegistry;
function _string(Class, params) {
  return new Class({
    type: "string",
    ...normalizeParams(params)
  });
}
function _email(Class, params) {
  return new Class({
    type: "string",
    format: "email",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _guid(Class, params) {
  return new Class({
    type: "string",
    format: "guid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _uuid(Class, params) {
  return new Class({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _uuidv4(Class, params) {
  return new Class({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v4",
    ...normalizeParams(params)
  });
}
function _uuidv6(Class, params) {
  return new Class({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v6",
    ...normalizeParams(params)
  });
}
function _uuidv7(Class, params) {
  return new Class({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v7",
    ...normalizeParams(params)
  });
}
function _url(Class, params) {
  return new Class({
    type: "string",
    format: "url",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _emoji2(Class, params) {
  return new Class({
    type: "string",
    format: "emoji",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _nanoid(Class, params) {
  return new Class({
    type: "string",
    format: "nanoid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cuid(Class, params) {
  return new Class({
    type: "string",
    format: "cuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cuid2(Class, params) {
  return new Class({
    type: "string",
    format: "cuid2",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ulid(Class, params) {
  return new Class({
    type: "string",
    format: "ulid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _xid(Class, params) {
  return new Class({
    type: "string",
    format: "xid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ksuid(Class, params) {
  return new Class({
    type: "string",
    format: "ksuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ipv4(Class, params) {
  return new Class({
    type: "string",
    format: "ipv4",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ipv6(Class, params) {
  return new Class({
    type: "string",
    format: "ipv6",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cidrv4(Class, params) {
  return new Class({
    type: "string",
    format: "cidrv4",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cidrv6(Class, params) {
  return new Class({
    type: "string",
    format: "cidrv6",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _base64(Class, params) {
  return new Class({
    type: "string",
    format: "base64",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _base64url(Class, params) {
  return new Class({
    type: "string",
    format: "base64url",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _e164(Class, params) {
  return new Class({
    type: "string",
    format: "e164",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _jwt(Class, params) {
  return new Class({
    type: "string",
    format: "jwt",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _isoDateTime(Class, params) {
  return new Class({
    type: "string",
    format: "datetime",
    check: "string_format",
    offset: false,
    local: false,
    precision: null,
    ...normalizeParams(params)
  });
}
function _isoDate(Class, params) {
  return new Class({
    type: "string",
    format: "date",
    check: "string_format",
    ...normalizeParams(params)
  });
}
function _isoTime(Class, params) {
  return new Class({
    type: "string",
    format: "time",
    check: "string_format",
    precision: null,
    ...normalizeParams(params)
  });
}
function _isoDuration(Class, params) {
  return new Class({
    type: "string",
    format: "duration",
    check: "string_format",
    ...normalizeParams(params)
  });
}
function _number(Class, params) {
  return new Class({
    type: "number",
    checks: [],
    ...normalizeParams(params)
  });
}
function _int(Class, params) {
  return new Class({
    type: "number",
    check: "number_format",
    abort: false,
    format: "safeint",
    ...normalizeParams(params)
  });
}
function _boolean(Class, params) {
  return new Class({
    type: "boolean",
    ...normalizeParams(params)
  });
}
function _unknown(Class) {
  return new Class({
    type: "unknown"
  });
}
function _never(Class, params) {
  return new Class({
    type: "never",
    ...normalizeParams(params)
  });
}
function _lt(value, params) {
  return new $ZodCheckLessThan({
    check: "less_than",
    ...normalizeParams(params),
    value,
    inclusive: false
  });
}
function _lte(value, params) {
  return new $ZodCheckLessThan({
    check: "less_than",
    ...normalizeParams(params),
    value,
    inclusive: true
  });
}
function _gt(value, params) {
  return new $ZodCheckGreaterThan({
    check: "greater_than",
    ...normalizeParams(params),
    value,
    inclusive: false
  });
}
function _gte(value, params) {
  return new $ZodCheckGreaterThan({
    check: "greater_than",
    ...normalizeParams(params),
    value,
    inclusive: true
  });
}
function _multipleOf(value, params) {
  return new $ZodCheckMultipleOf({
    check: "multiple_of",
    ...normalizeParams(params),
    value
  });
}
function _maxLength(maximum, params) {
  const ch = new $ZodCheckMaxLength({
    check: "max_length",
    ...normalizeParams(params),
    maximum
  });
  return ch;
}
function _minLength(minimum, params) {
  return new $ZodCheckMinLength({
    check: "min_length",
    ...normalizeParams(params),
    minimum
  });
}
function _length(length, params) {
  return new $ZodCheckLengthEquals({
    check: "length_equals",
    ...normalizeParams(params),
    length
  });
}
function _regex(pattern, params) {
  return new $ZodCheckRegex({
    check: "string_format",
    format: "regex",
    ...normalizeParams(params),
    pattern
  });
}
function _lowercase(params) {
  return new $ZodCheckLowerCase({
    check: "string_format",
    format: "lowercase",
    ...normalizeParams(params)
  });
}
function _uppercase(params) {
  return new $ZodCheckUpperCase({
    check: "string_format",
    format: "uppercase",
    ...normalizeParams(params)
  });
}
function _includes(includes, params) {
  return new $ZodCheckIncludes({
    check: "string_format",
    format: "includes",
    ...normalizeParams(params),
    includes
  });
}
function _startsWith(prefix, params) {
  return new $ZodCheckStartsWith({
    check: "string_format",
    format: "starts_with",
    ...normalizeParams(params),
    prefix
  });
}
function _endsWith(suffix, params) {
  return new $ZodCheckEndsWith({
    check: "string_format",
    format: "ends_with",
    ...normalizeParams(params),
    suffix
  });
}
function _overwrite(tx) {
  return new $ZodCheckOverwrite({
    check: "overwrite",
    tx
  });
}
function _normalize(form) {
  return _overwrite((input) => input.normalize(form));
}
function _trim() {
  return _overwrite((input) => input.trim());
}
function _toLowerCase() {
  return _overwrite((input) => input.toLowerCase());
}
function _toUpperCase() {
  return _overwrite((input) => input.toUpperCase());
}
function _slugify() {
  return _overwrite((input) => slugify(input));
}
function _array(Class, element, params) {
  return new Class({
    type: "array",
    element,
    ...normalizeParams(params)
  });
}
function _refine(Class, fn, _params) {
  const schema = new Class({
    type: "custom",
    check: "custom",
    fn,
    ...normalizeParams(_params)
  });
  return schema;
}
function _superRefine(fn, params) {
  const ch = _check((payload) => {
    payload.addIssue = (issue2) => {
      if (typeof issue2 === "string") {
        payload.issues.push(issue(issue2, payload.value, ch._zod.def));
      } else {
        const _issue = issue2;
        if (_issue.fatal)
          _issue.continue = false;
        _issue.code ?? (_issue.code = "custom");
        _issue.input ?? (_issue.input = payload.value);
        _issue.inst ?? (_issue.inst = ch);
        _issue.continue ?? (_issue.continue = !ch._zod.def.abort);
        payload.issues.push(issue(_issue));
      }
    };
    return fn(payload.value, payload);
  }, params);
  return ch;
}
function _check(fn, params) {
  const ch = new $ZodCheck({
    check: "custom",
    ...normalizeParams(params)
  });
  ch._zod.check = fn;
  return ch;
}
function initializeContext(params) {
  let target = params?.target ?? "draft-2020-12";
  if (target === "draft-4")
    target = "draft-04";
  if (target === "draft-7")
    target = "draft-07";
  return {
    processors: params.processors ?? {},
    metadataRegistry: params?.metadata ?? globalRegistry,
    target,
    unrepresentable: params?.unrepresentable ?? "throw",
    override: params?.override ?? (() => {}),
    io: params?.io ?? "output",
    counter: 0,
    seen: new Map,
    cycles: params?.cycles ?? "ref",
    reused: params?.reused ?? "inline",
    external: params?.external ?? undefined
  };
}
function process2(schema, ctx, _params = { path: [], schemaPath: [] }) {
  var _a;
  const def = schema._zod.def;
  const seen = ctx.seen.get(schema);
  if (seen) {
    seen.count++;
    const isCycle = _params.schemaPath.includes(schema);
    if (isCycle) {
      seen.cycle = _params.path;
    }
    return seen.schema;
  }
  const result = { schema: {}, count: 1, cycle: undefined, path: _params.path };
  ctx.seen.set(schema, result);
  const overrideSchema = schema._zod.toJSONSchema?.();
  if (overrideSchema) {
    result.schema = overrideSchema;
  } else {
    const params = {
      ..._params,
      schemaPath: [..._params.schemaPath, schema],
      path: _params.path
    };
    if (schema._zod.processJSONSchema) {
      schema._zod.processJSONSchema(ctx, result.schema, params);
    } else {
      const _json = result.schema;
      const processor = ctx.processors[def.type];
      if (!processor) {
        throw new Error(`[toJSONSchema]: Non-representable type encountered: ${def.type}`);
      }
      processor(schema, ctx, _json, params);
    }
    const parent = schema._zod.parent;
    if (parent) {
      if (!result.ref)
        result.ref = parent;
      process2(parent, ctx, params);
      ctx.seen.get(parent).isParent = true;
    }
  }
  const meta = ctx.metadataRegistry.get(schema);
  if (meta)
    Object.assign(result.schema, meta);
  if (ctx.io === "input" && isTransforming(schema)) {
    delete result.schema.examples;
    delete result.schema.default;
  }
  if (ctx.io === "input" && "_prefault" in result.schema)
    (_a = result.schema).default ?? (_a.default = result.schema._prefault);
  delete result.schema._prefault;
  const _result = ctx.seen.get(schema);
  return _result.schema;
}
function extractDefs(ctx, schema) {
  const root = ctx.seen.get(schema);
  if (!root)
    throw new Error("Unprocessed schema. This is a bug in Zod.");
  const idToSchema = new Map;
  for (const entry of ctx.seen.entries()) {
    const id = ctx.metadataRegistry.get(entry[0])?.id;
    if (id) {
      const existing = idToSchema.get(id);
      if (existing && existing !== entry[0]) {
        throw new Error(`Duplicate schema id "${id}" detected during JSON Schema conversion. Two different schemas cannot share the same id when converted together.`);
      }
      idToSchema.set(id, entry[0]);
    }
  }
  const makeURI = (entry) => {
    const defsSegment = ctx.target === "draft-2020-12" ? "$defs" : "definitions";
    if (ctx.external) {
      const externalId = ctx.external.registry.get(entry[0])?.id;
      const uriGenerator = ctx.external.uri ?? ((id) => id);
      if (externalId) {
        return { ref: uriGenerator(externalId) };
      }
      const id = entry[1].defId ?? entry[1].schema.id ?? `schema${ctx.counter++}`;
      entry[1].defId = id;
      return { defId: id, ref: `${uriGenerator("__shared")}#/${defsSegment}/${id}` };
    }
    if (entry[1] === root) {
      return { ref: "#" };
    }
    const uriPrefix = `#`;
    const defUriPrefix = `${uriPrefix}/${defsSegment}/`;
    const defId = entry[1].schema.id ?? `__schema${ctx.counter++}`;
    return { defId, ref: defUriPrefix + defId };
  };
  const extractToDef = (entry) => {
    if (entry[1].schema.$ref) {
      return;
    }
    const seen = entry[1];
    const { ref, defId } = makeURI(entry);
    seen.def = { ...seen.schema };
    if (defId)
      seen.defId = defId;
    const schema = seen.schema;
    for (const key in schema) {
      delete schema[key];
    }
    schema.$ref = ref;
  };
  if (ctx.cycles === "throw") {
    for (const entry of ctx.seen.entries()) {
      const seen = entry[1];
      if (seen.cycle) {
        throw new Error("Cycle detected: " + `#/${seen.cycle?.join("/")}/<root>` + '\n\nSet the `cycles` parameter to `"ref"` to resolve cyclical schemas with defs.');
      }
    }
  }
  for (const entry of ctx.seen.entries()) {
    const seen = entry[1];
    if (schema === entry[0]) {
      extractToDef(entry);
      continue;
    }
    if (ctx.external) {
      const ext = ctx.external.registry.get(entry[0])?.id;
      if (schema !== entry[0] && ext) {
        extractToDef(entry);
        continue;
      }
    }
    const id = ctx.metadataRegistry.get(entry[0])?.id;
    if (id) {
      extractToDef(entry);
      continue;
    }
    if (seen.cycle) {
      extractToDef(entry);
      continue;
    }
    if (seen.count > 1) {
      if (ctx.reused === "ref") {
        extractToDef(entry);
        continue;
      }
    }
  }
}
function finalize(ctx, schema) {
  const root = ctx.seen.get(schema);
  if (!root)
    throw new Error("Unprocessed schema. This is a bug in Zod.");
  const flattenRef = (zodSchema) => {
    const seen = ctx.seen.get(zodSchema);
    if (seen.ref === null)
      return;
    const schema = seen.def ?? seen.schema;
    const _cached = { ...schema };
    const ref = seen.ref;
    seen.ref = null;
    if (ref) {
      flattenRef(ref);
      const refSeen = ctx.seen.get(ref);
      const refSchema = refSeen.schema;
      if (refSchema.$ref && (ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0")) {
        schema.allOf = schema.allOf ?? [];
        schema.allOf.push(refSchema);
      } else {
        Object.assign(schema, refSchema);
      }
      Object.assign(schema, _cached);
      const isParentRef = zodSchema._zod.parent === ref;
      if (isParentRef) {
        for (const key in schema) {
          if (key === "$ref" || key === "allOf")
            continue;
          if (!(key in _cached)) {
            delete schema[key];
          }
        }
      }
      if (refSchema.$ref && refSeen.def) {
        for (const key in schema) {
          if (key === "$ref" || key === "allOf")
            continue;
          if (key in refSeen.def && JSON.stringify(schema[key]) === JSON.stringify(refSeen.def[key])) {
            delete schema[key];
          }
        }
      }
    }
    const parent = zodSchema._zod.parent;
    if (parent && parent !== ref) {
      flattenRef(parent);
      const parentSeen = ctx.seen.get(parent);
      if (parentSeen?.schema.$ref) {
        schema.$ref = parentSeen.schema.$ref;
        if (parentSeen.def) {
          for (const key in schema) {
            if (key === "$ref" || key === "allOf")
              continue;
            if (key in parentSeen.def && JSON.stringify(schema[key]) === JSON.stringify(parentSeen.def[key])) {
              delete schema[key];
            }
          }
        }
      }
    }
    ctx.override({
      zodSchema,
      jsonSchema: schema,
      path: seen.path ?? []
    });
  };
  for (const entry of [...ctx.seen.entries()].reverse()) {
    flattenRef(entry[0]);
  }
  const result = {};
  if (ctx.target === "draft-2020-12") {
    result.$schema = "https://json-schema.org/draft/2020-12/schema";
  } else if (ctx.target === "draft-07") {
    result.$schema = "http://json-schema.org/draft-07/schema#";
  } else if (ctx.target === "draft-04") {
    result.$schema = "http://json-schema.org/draft-04/schema#";
  } else if (ctx.target === "openapi-3.0") {}
  if (ctx.external?.uri) {
    const id = ctx.external.registry.get(schema)?.id;
    if (!id)
      throw new Error("Schema is missing an `id` property");
    result.$id = ctx.external.uri(id);
  }
  Object.assign(result, root.def ?? root.schema);
  const rootMetaId = ctx.metadataRegistry.get(schema)?.id;
  if (rootMetaId !== undefined && result.id === rootMetaId)
    delete result.id;
  const defs = ctx.external?.defs ?? {};
  for (const entry of ctx.seen.entries()) {
    const seen = entry[1];
    if (seen.def && seen.defId) {
      if (seen.def.id === seen.defId)
        delete seen.def.id;
      defs[seen.defId] = seen.def;
    }
  }
  if (ctx.external) {} else {
    if (Object.keys(defs).length > 0) {
      if (ctx.target === "draft-2020-12") {
        result.$defs = defs;
      } else {
        result.definitions = defs;
      }
    }
  }
  try {
    const finalized = JSON.parse(JSON.stringify(result));
    Object.defineProperty(finalized, "~standard", {
      value: {
        ...schema["~standard"],
        jsonSchema: {
          input: createStandardJSONSchemaMethod(schema, "input", ctx.processors),
          output: createStandardJSONSchemaMethod(schema, "output", ctx.processors)
        }
      },
      enumerable: false,
      writable: false
    });
    return finalized;
  } catch (_err) {
    throw new Error("Error converting schema to JSON.");
  }
}
function isTransforming(_schema, _ctx) {
  const ctx = _ctx ?? { seen: new Set };
  if (ctx.seen.has(_schema))
    return false;
  ctx.seen.add(_schema);
  const def = _schema._zod.def;
  if (def.type === "transform")
    return true;
  if (def.type === "array")
    return isTransforming(def.element, ctx);
  if (def.type === "set")
    return isTransforming(def.valueType, ctx);
  if (def.type === "lazy")
    return isTransforming(def.getter(), ctx);
  if (def.type === "promise" || def.type === "optional" || def.type === "nonoptional" || def.type === "nullable" || def.type === "readonly" || def.type === "default" || def.type === "prefault") {
    return isTransforming(def.innerType, ctx);
  }
  if (def.type === "intersection") {
    return isTransforming(def.left, ctx) || isTransforming(def.right, ctx);
  }
  if (def.type === "record" || def.type === "map") {
    return isTransforming(def.keyType, ctx) || isTransforming(def.valueType, ctx);
  }
  if (def.type === "pipe") {
    if (_schema._zod.traits.has("$ZodCodec"))
      return true;
    return isTransforming(def.in, ctx) || isTransforming(def.out, ctx);
  }
  if (def.type === "object") {
    for (const key in def.shape) {
      if (isTransforming(def.shape[key], ctx))
        return true;
    }
    return false;
  }
  if (def.type === "union") {
    for (const option of def.options) {
      if (isTransforming(option, ctx))
        return true;
    }
    return false;
  }
  if (def.type === "tuple") {
    for (const item of def.items) {
      if (isTransforming(item, ctx))
        return true;
    }
    if (def.rest && isTransforming(def.rest, ctx))
      return true;
    return false;
  }
  return false;
}
var createToJSONSchemaMethod = (schema, processors = {}) => (params) => {
  const ctx = initializeContext({ ...params, processors });
  process2(schema, ctx);
  extractDefs(ctx, schema);
  return finalize(ctx, schema);
};
var createStandardJSONSchemaMethod = (schema, io, processors = {}) => (params) => {
  const { libraryOptions, target } = params ?? {};
  const ctx = initializeContext({ ...libraryOptions ?? {}, target, io, processors });
  process2(schema, ctx);
  extractDefs(ctx, schema);
  return finalize(ctx, schema);
};
var formatMap = {
  guid: "uuid",
  url: "uri",
  datetime: "date-time",
  json_string: "json-string",
  regex: ""
};
var stringProcessor = (schema, ctx, _json, _params) => {
  const json = _json;
  json.type = "string";
  const { minimum, maximum, format, patterns, contentEncoding } = schema._zod.bag;
  if (typeof minimum === "number")
    json.minLength = minimum;
  if (typeof maximum === "number")
    json.maxLength = maximum;
  if (format) {
    json.format = formatMap[format] ?? format;
    if (json.format === "")
      delete json.format;
    if (format === "time") {
      delete json.format;
    }
  }
  if (contentEncoding)
    json.contentEncoding = contentEncoding;
  if (patterns && patterns.size > 0) {
    const regexes = [...patterns];
    if (regexes.length === 1)
      json.pattern = regexes[0].source;
    else if (regexes.length > 1) {
      json.allOf = [
        ...regexes.map((regex) => ({
          ...ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0" ? { type: "string" } : {},
          pattern: regex.source
        }))
      ];
    }
  }
};
var numberProcessor = (schema, ctx, _json, _params) => {
  const json = _json;
  const { minimum, maximum, format, multipleOf, exclusiveMaximum, exclusiveMinimum } = schema._zod.bag;
  if (typeof format === "string" && format.includes("int"))
    json.type = "integer";
  else
    json.type = "number";
  const exMin = typeof exclusiveMinimum === "number" && exclusiveMinimum >= (minimum ?? Number.NEGATIVE_INFINITY);
  const exMax = typeof exclusiveMaximum === "number" && exclusiveMaximum <= (maximum ?? Number.POSITIVE_INFINITY);
  const legacy = ctx.target === "draft-04" || ctx.target === "openapi-3.0";
  if (exMin) {
    if (legacy) {
      json.minimum = exclusiveMinimum;
      json.exclusiveMinimum = true;
    } else {
      json.exclusiveMinimum = exclusiveMinimum;
    }
  } else if (typeof minimum === "number") {
    json.minimum = minimum;
  }
  if (exMax) {
    if (legacy) {
      json.maximum = exclusiveMaximum;
      json.exclusiveMaximum = true;
    } else {
      json.exclusiveMaximum = exclusiveMaximum;
    }
  } else if (typeof maximum === "number") {
    json.maximum = maximum;
  }
  if (typeof multipleOf === "number")
    json.multipleOf = multipleOf;
};
var booleanProcessor = (_schema, _ctx, json, _params) => {
  json.type = "boolean";
};
var neverProcessor = (_schema, _ctx, json, _params) => {
  json.not = {};
};
var unknownProcessor = (_schema, _ctx, _json, _params) => {};
var enumProcessor = (schema, _ctx, json, _params) => {
  const def = schema._zod.def;
  const values = getEnumValues(def.entries);
  if (values.every((v) => typeof v === "number"))
    json.type = "number";
  if (values.every((v) => typeof v === "string"))
    json.type = "string";
  json.enum = values;
};
var literalProcessor = (schema, ctx, json, _params) => {
  const def = schema._zod.def;
  const vals = [];
  for (const val of def.values) {
    if (val === undefined) {
      if (ctx.unrepresentable === "throw") {
        throw new Error("Literal `undefined` cannot be represented in JSON Schema");
      }
    } else if (typeof val === "bigint") {
      if (ctx.unrepresentable === "throw") {
        throw new Error("BigInt literals cannot be represented in JSON Schema");
      } else {
        vals.push(Number(val));
      }
    } else {
      vals.push(val);
    }
  }
  if (vals.length === 0) {} else if (vals.length === 1) {
    const val = vals[0];
    json.type = val === null ? "null" : typeof val;
    if (ctx.target === "draft-04" || ctx.target === "openapi-3.0") {
      json.enum = [val];
    } else {
      json.const = val;
    }
  } else {
    if (vals.every((v) => typeof v === "number"))
      json.type = "number";
    if (vals.every((v) => typeof v === "string"))
      json.type = "string";
    if (vals.every((v) => typeof v === "boolean"))
      json.type = "boolean";
    if (vals.every((v) => v === null))
      json.type = "null";
    json.enum = vals;
  }
};
var customProcessor = (_schema, ctx, _json, _params) => {
  if (ctx.unrepresentable === "throw") {
    throw new Error("Custom types cannot be represented in JSON Schema");
  }
};
var transformProcessor = (_schema, ctx, _json, _params) => {
  if (ctx.unrepresentable === "throw") {
    throw new Error("Transforms cannot be represented in JSON Schema");
  }
};
var arrayProcessor = (schema, ctx, _json, params) => {
  const json = _json;
  const def = schema._zod.def;
  const { minimum, maximum } = schema._zod.bag;
  if (typeof minimum === "number")
    json.minItems = minimum;
  if (typeof maximum === "number")
    json.maxItems = maximum;
  json.type = "array";
  json.items = process2(def.element, ctx, {
    ...params,
    path: [...params.path, "items"]
  });
};
var objectProcessor = (schema, ctx, _json, params) => {
  const json = _json;
  const def = schema._zod.def;
  json.type = "object";
  json.properties = {};
  const shape = def.shape;
  for (const key in shape) {
    json.properties[key] = process2(shape[key], ctx, {
      ...params,
      path: [...params.path, "properties", key]
    });
  }
  const allKeys = new Set(Object.keys(shape));
  const requiredKeys = new Set([...allKeys].filter((key) => {
    const v = def.shape[key]._zod;
    if (ctx.io === "input") {
      return v.optin === undefined;
    } else {
      return v.optout === undefined;
    }
  }));
  if (requiredKeys.size > 0) {
    json.required = Array.from(requiredKeys);
  }
  if (def.catchall?._zod.def.type === "never") {
    json.additionalProperties = false;
  } else if (!def.catchall) {
    if (ctx.io === "output")
      json.additionalProperties = false;
  } else if (def.catchall) {
    json.additionalProperties = process2(def.catchall, ctx, {
      ...params,
      path: [...params.path, "additionalProperties"]
    });
  }
};
var unionProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  const isExclusive = def.inclusive === false;
  const options = def.options.map((x, i) => process2(x, ctx, {
    ...params,
    path: [...params.path, isExclusive ? "oneOf" : "anyOf", i]
  }));
  if (isExclusive) {
    json.oneOf = options;
  } else {
    json.anyOf = options;
  }
};
var intersectionProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  const a = process2(def.left, ctx, {
    ...params,
    path: [...params.path, "allOf", 0]
  });
  const b = process2(def.right, ctx, {
    ...params,
    path: [...params.path, "allOf", 1]
  });
  const isSimpleIntersection = (val) => ("allOf" in val) && Object.keys(val).length === 1;
  const allOf = [
    ...isSimpleIntersection(a) ? a.allOf : [a],
    ...isSimpleIntersection(b) ? b.allOf : [b]
  ];
  json.allOf = allOf;
};
var nullableProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  const inner = process2(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  if (ctx.target === "openapi-3.0") {
    seen.ref = def.innerType;
    json.nullable = true;
  } else {
    json.anyOf = [inner, { type: "null" }];
  }
};
var nonoptionalProcessor = (schema, ctx, _json, params) => {
  const def = schema._zod.def;
  process2(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
};
var defaultProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  process2(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
  json.default = JSON.parse(JSON.stringify(def.defaultValue));
};
var prefaultProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  process2(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
  if (ctx.io === "input")
    json._prefault = JSON.parse(JSON.stringify(def.defaultValue));
};
var catchProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  process2(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
  let catchValue;
  try {
    catchValue = def.catchValue(undefined);
  } catch {
    throw new Error("Dynamic catch values are not supported in JSON Schema");
  }
  json.default = catchValue;
};
var pipeProcessor = (schema, ctx, _json, params) => {
  const def = schema._zod.def;
  const inIsTransform = def.in._zod.traits.has("$ZodTransform");
  const innerType = ctx.io === "input" ? inIsTransform ? def.out : def.in : def.out;
  process2(innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = innerType;
};
var readonlyProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  process2(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
  json.readOnly = true;
};
var optionalProcessor = (schema, ctx, _json, params) => {
  const def = schema._zod.def;
  process2(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
};
var ZodISODateTime = /* @__PURE__ */ $constructor("ZodISODateTime", (inst, def) => {
  $ZodISODateTime.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function datetime2(params) {
  return _isoDateTime(ZodISODateTime, params);
}
var ZodISODate = /* @__PURE__ */ $constructor("ZodISODate", (inst, def) => {
  $ZodISODate.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function date2(params) {
  return _isoDate(ZodISODate, params);
}
var ZodISOTime = /* @__PURE__ */ $constructor("ZodISOTime", (inst, def) => {
  $ZodISOTime.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function time2(params) {
  return _isoTime(ZodISOTime, params);
}
var ZodISODuration = /* @__PURE__ */ $constructor("ZodISODuration", (inst, def) => {
  $ZodISODuration.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function duration2(params) {
  return _isoDuration(ZodISODuration, params);
}

var initializer2 = (inst, issues) => {
  $ZodError.init(inst, issues);
  inst.name = "ZodError";
  Object.defineProperties(inst, {
    format: {
      value: (mapper) => formatError(inst, mapper)
    },
    flatten: {
      value: (mapper) => flattenError(inst, mapper)
    },
    addIssue: {
      value: (issue) => {
        inst.issues.push(issue);
        inst.message = JSON.stringify(inst.issues, jsonStringifyReplacer, 2);
      }
    },
    addIssues: {
      value: (issues) => {
        inst.issues.push(...issues);
        inst.message = JSON.stringify(inst.issues, jsonStringifyReplacer, 2);
      }
    },
    isEmpty: {
      get() {
        return inst.issues.length === 0;
      }
    }
  });
};
var ZodRealError = /* @__PURE__ */ $constructor("ZodError", initializer2, {
  Parent: Error
});

var parse3 = /* @__PURE__ */ _parse(ZodRealError);
var parseAsync2 = /* @__PURE__ */ _parseAsync(ZodRealError);
var safeParse2 = /* @__PURE__ */ _safeParse(ZodRealError);
var safeParseAsync2 = /* @__PURE__ */ _safeParseAsync(ZodRealError);
var encode = /* @__PURE__ */ _encode(ZodRealError);
var decode = /* @__PURE__ */ _decode(ZodRealError);
var encodeAsync = /* @__PURE__ */ _encodeAsync(ZodRealError);
var decodeAsync = /* @__PURE__ */ _decodeAsync(ZodRealError);
var safeEncode = /* @__PURE__ */ _safeEncode(ZodRealError);
var safeDecode = /* @__PURE__ */ _safeDecode(ZodRealError);
var safeEncodeAsync = /* @__PURE__ */ _safeEncodeAsync(ZodRealError);
var safeDecodeAsync = /* @__PURE__ */ _safeDecodeAsync(ZodRealError);

var _installedGroups = /* @__PURE__ */ new WeakMap;
function _installLazyMethods(inst, group, methods) {
  const proto = Object.getPrototypeOf(inst);
  let installed = _installedGroups.get(proto);
  if (!installed) {
    installed = new Set;
    _installedGroups.set(proto, installed);
  }
  if (installed.has(group))
    return;
  installed.add(group);
  for (const key in methods) {
    const fn = methods[key];
    Object.defineProperty(proto, key, {
      configurable: true,
      enumerable: false,
      get() {
        const bound = fn.bind(this);
        Object.defineProperty(this, key, {
          configurable: true,
          writable: true,
          enumerable: true,
          value: bound
        });
        return bound;
      },
      set(v) {
        Object.defineProperty(this, key, {
          configurable: true,
          writable: true,
          enumerable: true,
          value: v
        });
      }
    });
  }
}
var ZodType = /* @__PURE__ */ $constructor("ZodType", (inst, def) => {
  $ZodType.init(inst, def);
  Object.assign(inst["~standard"], {
    jsonSchema: {
      input: createStandardJSONSchemaMethod(inst, "input"),
      output: createStandardJSONSchemaMethod(inst, "output")
    }
  });
  inst.toJSONSchema = createToJSONSchemaMethod(inst, {});
  inst.def = def;
  inst.type = def.type;
  Object.defineProperty(inst, "_def", { value: def });
  inst.parse = (data, params) => parse3(inst, data, params, { callee: inst.parse });
  inst.safeParse = (data, params) => safeParse2(inst, data, params);
  inst.parseAsync = async (data, params) => parseAsync2(inst, data, params, { callee: inst.parseAsync });
  inst.safeParseAsync = async (data, params) => safeParseAsync2(inst, data, params);
  inst.spa = inst.safeParseAsync;
  inst.encode = (data, params) => encode(inst, data, params);
  inst.decode = (data, params) => decode(inst, data, params);
  inst.encodeAsync = async (data, params) => encodeAsync(inst, data, params);
  inst.decodeAsync = async (data, params) => decodeAsync(inst, data, params);
  inst.safeEncode = (data, params) => safeEncode(inst, data, params);
  inst.safeDecode = (data, params) => safeDecode(inst, data, params);
  inst.safeEncodeAsync = async (data, params) => safeEncodeAsync(inst, data, params);
  inst.safeDecodeAsync = async (data, params) => safeDecodeAsync(inst, data, params);
  _installLazyMethods(inst, "ZodType", {
    check(...chks) {
      const def = this.def;
      return this.clone(mergeDefs(def, {
        checks: [
          ...def.checks ?? [],
          ...chks.map((ch) => typeof ch === "function" ? { _zod: { check: ch, def: { check: "custom" }, onattach: [] } } : ch)
        ]
      }), { parent: true });
    },
    with(...chks) {
      return this.check(...chks);
    },
    clone(def, params) {
      return clone(this, def, params);
    },
    brand() {
      return this;
    },
    register(reg, meta) {
      reg.add(this, meta);
      return this;
    },
    refine(check, params) {
      return this.check(refine(check, params));
    },
    superRefine(refinement, params) {
      return this.check(superRefine(refinement, params));
    },
    overwrite(fn) {
      return this.check(_overwrite(fn));
    },
    optional() {
      return optional(this);
    },
    exactOptional() {
      return exactOptional(this);
    },
    nullable() {
      return nullable(this);
    },
    nullish() {
      return optional(nullable(this));
    },
    nonoptional(params) {
      return nonoptional(this, params);
    },
    array() {
      return array(this);
    },
    or(arg) {
      return union([this, arg]);
    },
    and(arg) {
      return intersection(this, arg);
    },
    transform(tx) {
      return pipe(this, transform(tx));
    },
    default(d) {
      return _default(this, d);
    },
    prefault(d) {
      return prefault(this, d);
    },
    catch(params) {
      return _catch(this, params);
    },
    pipe(target) {
      return pipe(this, target);
    },
    readonly() {
      return readonly(this);
    },
    describe(description) {
      const cl = this.clone();
      globalRegistry.add(cl, { description });
      return cl;
    },
    meta(...args) {
      if (args.length === 0)
        return globalRegistry.get(this);
      const cl = this.clone();
      globalRegistry.add(cl, args[0]);
      return cl;
    },
    isOptional() {
      return this.safeParse(undefined).success;
    },
    isNullable() {
      return this.safeParse(null).success;
    },
    apply(fn) {
      return fn(this);
    }
  });
  Object.defineProperty(inst, "description", {
    get() {
      return globalRegistry.get(inst)?.description;
    },
    configurable: true
  });
  return inst;
});
var _ZodString = /* @__PURE__ */ $constructor("_ZodString", (inst, def) => {
  $ZodString.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => stringProcessor(inst, ctx, json, params);
  const bag = inst._zod.bag;
  inst.format = bag.format ?? null;
  inst.minLength = bag.minimum ?? null;
  inst.maxLength = bag.maximum ?? null;
  _installLazyMethods(inst, "_ZodString", {
    regex(...args) {
      return this.check(_regex(...args));
    },
    includes(...args) {
      return this.check(_includes(...args));
    },
    startsWith(...args) {
      return this.check(_startsWith(...args));
    },
    endsWith(...args) {
      return this.check(_endsWith(...args));
    },
    min(...args) {
      return this.check(_minLength(...args));
    },
    max(...args) {
      return this.check(_maxLength(...args));
    },
    length(...args) {
      return this.check(_length(...args));
    },
    nonempty(...args) {
      return this.check(_minLength(1, ...args));
    },
    lowercase(params) {
      return this.check(_lowercase(params));
    },
    uppercase(params) {
      return this.check(_uppercase(params));
    },
    trim() {
      return this.check(_trim());
    },
    normalize(...args) {
      return this.check(_normalize(...args));
    },
    toLowerCase() {
      return this.check(_toLowerCase());
    },
    toUpperCase() {
      return this.check(_toUpperCase());
    },
    slugify() {
      return this.check(_slugify());
    }
  });
});
var ZodString = /* @__PURE__ */ $constructor("ZodString", (inst, def) => {
  $ZodString.init(inst, def);
  _ZodString.init(inst, def);
  inst.email = (params) => inst.check(_email(ZodEmail, params));
  inst.url = (params) => inst.check(_url(ZodURL, params));
  inst.jwt = (params) => inst.check(_jwt(ZodJWT, params));
  inst.emoji = (params) => inst.check(_emoji2(ZodEmoji, params));
  inst.guid = (params) => inst.check(_guid(ZodGUID, params));
  inst.uuid = (params) => inst.check(_uuid(ZodUUID, params));
  inst.uuidv4 = (params) => inst.check(_uuidv4(ZodUUID, params));
  inst.uuidv6 = (params) => inst.check(_uuidv6(ZodUUID, params));
  inst.uuidv7 = (params) => inst.check(_uuidv7(ZodUUID, params));
  inst.nanoid = (params) => inst.check(_nanoid(ZodNanoID, params));
  inst.guid = (params) => inst.check(_guid(ZodGUID, params));
  inst.cuid = (params) => inst.check(_cuid(ZodCUID, params));
  inst.cuid2 = (params) => inst.check(_cuid2(ZodCUID2, params));
  inst.ulid = (params) => inst.check(_ulid(ZodULID, params));
  inst.base64 = (params) => inst.check(_base64(ZodBase64, params));
  inst.base64url = (params) => inst.check(_base64url(ZodBase64URL, params));
  inst.xid = (params) => inst.check(_xid(ZodXID, params));
  inst.ksuid = (params) => inst.check(_ksuid(ZodKSUID, params));
  inst.ipv4 = (params) => inst.check(_ipv4(ZodIPv4, params));
  inst.ipv6 = (params) => inst.check(_ipv6(ZodIPv6, params));
  inst.cidrv4 = (params) => inst.check(_cidrv4(ZodCIDRv4, params));
  inst.cidrv6 = (params) => inst.check(_cidrv6(ZodCIDRv6, params));
  inst.e164 = (params) => inst.check(_e164(ZodE164, params));
  inst.datetime = (params) => inst.check(datetime2(params));
  inst.date = (params) => inst.check(date2(params));
  inst.time = (params) => inst.check(time2(params));
  inst.duration = (params) => inst.check(duration2(params));
});
function string2(params) {
  return _string(ZodString, params);
}
var ZodStringFormat = /* @__PURE__ */ $constructor("ZodStringFormat", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  _ZodString.init(inst, def);
});
var ZodEmail = /* @__PURE__ */ $constructor("ZodEmail", (inst, def) => {
  $ZodEmail.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodGUID = /* @__PURE__ */ $constructor("ZodGUID", (inst, def) => {
  $ZodGUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodUUID = /* @__PURE__ */ $constructor("ZodUUID", (inst, def) => {
  $ZodUUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodURL = /* @__PURE__ */ $constructor("ZodURL", (inst, def) => {
  $ZodURL.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodEmoji = /* @__PURE__ */ $constructor("ZodEmoji", (inst, def) => {
  $ZodEmoji.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodNanoID = /* @__PURE__ */ $constructor("ZodNanoID", (inst, def) => {
  $ZodNanoID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodCUID = /* @__PURE__ */ $constructor("ZodCUID", (inst, def) => {
  $ZodCUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodCUID2 = /* @__PURE__ */ $constructor("ZodCUID2", (inst, def) => {
  $ZodCUID2.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodULID = /* @__PURE__ */ $constructor("ZodULID", (inst, def) => {
  $ZodULID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodXID = /* @__PURE__ */ $constructor("ZodXID", (inst, def) => {
  $ZodXID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodKSUID = /* @__PURE__ */ $constructor("ZodKSUID", (inst, def) => {
  $ZodKSUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodIPv4 = /* @__PURE__ */ $constructor("ZodIPv4", (inst, def) => {
  $ZodIPv4.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodIPv6 = /* @__PURE__ */ $constructor("ZodIPv6", (inst, def) => {
  $ZodIPv6.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodCIDRv4 = /* @__PURE__ */ $constructor("ZodCIDRv4", (inst, def) => {
  $ZodCIDRv4.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodCIDRv6 = /* @__PURE__ */ $constructor("ZodCIDRv6", (inst, def) => {
  $ZodCIDRv6.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodBase64 = /* @__PURE__ */ $constructor("ZodBase64", (inst, def) => {
  $ZodBase64.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodBase64URL = /* @__PURE__ */ $constructor("ZodBase64URL", (inst, def) => {
  $ZodBase64URL.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodE164 = /* @__PURE__ */ $constructor("ZodE164", (inst, def) => {
  $ZodE164.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodJWT = /* @__PURE__ */ $constructor("ZodJWT", (inst, def) => {
  $ZodJWT.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodNumber = /* @__PURE__ */ $constructor("ZodNumber", (inst, def) => {
  $ZodNumber.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => numberProcessor(inst, ctx, json, params);
  _installLazyMethods(inst, "ZodNumber", {
    gt(value, params) {
      return this.check(_gt(value, params));
    },
    gte(value, params) {
      return this.check(_gte(value, params));
    },
    min(value, params) {
      return this.check(_gte(value, params));
    },
    lt(value, params) {
      return this.check(_lt(value, params));
    },
    lte(value, params) {
      return this.check(_lte(value, params));
    },
    max(value, params) {
      return this.check(_lte(value, params));
    },
    int(params) {
      return this.check(int(params));
    },
    safe(params) {
      return this.check(int(params));
    },
    positive(params) {
      return this.check(_gt(0, params));
    },
    nonnegative(params) {
      return this.check(_gte(0, params));
    },
    negative(params) {
      return this.check(_lt(0, params));
    },
    nonpositive(params) {
      return this.check(_lte(0, params));
    },
    multipleOf(value, params) {
      return this.check(_multipleOf(value, params));
    },
    step(value, params) {
      return this.check(_multipleOf(value, params));
    },
    finite() {
      return this;
    }
  });
  const bag = inst._zod.bag;
  inst.minValue = Math.max(bag.minimum ?? Number.NEGATIVE_INFINITY, bag.exclusiveMinimum ?? Number.NEGATIVE_INFINITY) ?? null;
  inst.maxValue = Math.min(bag.maximum ?? Number.POSITIVE_INFINITY, bag.exclusiveMaximum ?? Number.POSITIVE_INFINITY) ?? null;
  inst.isInt = (bag.format ?? "").includes("int") || Number.isSafeInteger(bag.multipleOf ?? 0.5);
  inst.isFinite = true;
  inst.format = bag.format ?? null;
});
function number2(params) {
  return _number(ZodNumber, params);
}
var ZodNumberFormat = /* @__PURE__ */ $constructor("ZodNumberFormat", (inst, def) => {
  $ZodNumberFormat.init(inst, def);
  ZodNumber.init(inst, def);
});
function int(params) {
  return _int(ZodNumberFormat, params);
}
var ZodBoolean = /* @__PURE__ */ $constructor("ZodBoolean", (inst, def) => {
  $ZodBoolean.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => booleanProcessor(inst, ctx, json, params);
});
function boolean2(params) {
  return _boolean(ZodBoolean, params);
}
var ZodUnknown = /* @__PURE__ */ $constructor("ZodUnknown", (inst, def) => {
  $ZodUnknown.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => unknownProcessor(inst, ctx, json, params);
});
function unknown() {
  return _unknown(ZodUnknown);
}
var ZodNever = /* @__PURE__ */ $constructor("ZodNever", (inst, def) => {
  $ZodNever.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => neverProcessor(inst, ctx, json, params);
});
function never(params) {
  return _never(ZodNever, params);
}
var ZodArray = /* @__PURE__ */ $constructor("ZodArray", (inst, def) => {
  $ZodArray.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => arrayProcessor(inst, ctx, json, params);
  inst.element = def.element;
  _installLazyMethods(inst, "ZodArray", {
    min(n, params) {
      return this.check(_minLength(n, params));
    },
    nonempty(params) {
      return this.check(_minLength(1, params));
    },
    max(n, params) {
      return this.check(_maxLength(n, params));
    },
    length(n, params) {
      return this.check(_length(n, params));
    },
    unwrap() {
      return this.element;
    }
  });
});
function array(element, params) {
  return _array(ZodArray, element, params);
}
var ZodObject = /* @__PURE__ */ $constructor("ZodObject", (inst, def) => {
  $ZodObjectJIT.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => objectProcessor(inst, ctx, json, params);
  defineLazy(inst, "shape", () => {
    return def.shape;
  });
  _installLazyMethods(inst, "ZodObject", {
    keyof() {
      return _enum(Object.keys(this._zod.def.shape));
    },
    catchall(catchall) {
      return this.clone({ ...this._zod.def, catchall });
    },
    passthrough() {
      return this.clone({ ...this._zod.def, catchall: unknown() });
    },
    loose() {
      return this.clone({ ...this._zod.def, catchall: unknown() });
    },
    strict() {
      return this.clone({ ...this._zod.def, catchall: never() });
    },
    strip() {
      return this.clone({ ...this._zod.def, catchall: undefined });
    },
    extend(incoming) {
      return extend(this, incoming);
    },
    safeExtend(incoming) {
      return safeExtend(this, incoming);
    },
    merge(other) {
      return merge(this, other);
    },
    pick(mask) {
      return pick(this, mask);
    },
    omit(mask) {
      return omit(this, mask);
    },
    partial(...args) {
      return partial(ZodOptional, this, args[0]);
    },
    required(...args) {
      return required(ZodNonOptional, this, args[0]);
    }
  });
});
function strictObject(shape, params) {
  return new ZodObject({
    type: "object",
    shape,
    catchall: never(),
    ...normalizeParams(params)
  });
}
var ZodUnion = /* @__PURE__ */ $constructor("ZodUnion", (inst, def) => {
  $ZodUnion.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => unionProcessor(inst, ctx, json, params);
  inst.options = def.options;
});
function union(options, params) {
  return new ZodUnion({
    type: "union",
    options,
    ...normalizeParams(params)
  });
}
var ZodIntersection = /* @__PURE__ */ $constructor("ZodIntersection", (inst, def) => {
  $ZodIntersection.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => intersectionProcessor(inst, ctx, json, params);
});
function intersection(left, right) {
  return new ZodIntersection({
    type: "intersection",
    left,
    right
  });
}
var ZodEnum = /* @__PURE__ */ $constructor("ZodEnum", (inst, def) => {
  $ZodEnum.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => enumProcessor(inst, ctx, json, params);
  inst.enum = def.entries;
  inst.options = Object.values(def.entries);
  const keys = new Set(Object.keys(def.entries));
  inst.extract = (values, params) => {
    const newEntries = {};
    for (const value of values) {
      if (keys.has(value)) {
        newEntries[value] = def.entries[value];
      } else
        throw new Error(`Key ${value} not found in enum`);
    }
    return new ZodEnum({
      ...def,
      checks: [],
      ...normalizeParams(params),
      entries: newEntries
    });
  };
  inst.exclude = (values, params) => {
    const newEntries = { ...def.entries };
    for (const value of values) {
      if (keys.has(value)) {
        delete newEntries[value];
      } else
        throw new Error(`Key ${value} not found in enum`);
    }
    return new ZodEnum({
      ...def,
      checks: [],
      ...normalizeParams(params),
      entries: newEntries
    });
  };
});
function _enum(values, params) {
  const entries = Array.isArray(values) ? Object.fromEntries(values.map((v) => [v, v])) : values;
  return new ZodEnum({
    type: "enum",
    entries,
    ...normalizeParams(params)
  });
}
var ZodLiteral = /* @__PURE__ */ $constructor("ZodLiteral", (inst, def) => {
  $ZodLiteral.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => literalProcessor(inst, ctx, json, params);
  inst.values = new Set(def.values);
  Object.defineProperty(inst, "value", {
    get() {
      if (def.values.length > 1) {
        throw new Error("This schema contains multiple valid literal values. Use `.values` instead.");
      }
      return def.values[0];
    }
  });
});
function literal(value, params) {
  return new ZodLiteral({
    type: "literal",
    values: Array.isArray(value) ? value : [value],
    ...normalizeParams(params)
  });
}
var ZodTransform = /* @__PURE__ */ $constructor("ZodTransform", (inst, def) => {
  $ZodTransform.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => transformProcessor(inst, ctx, json, params);
  inst._zod.parse = (payload, _ctx) => {
    if (_ctx.direction === "backward") {
      throw new $ZodEncodeError(inst.constructor.name);
    }
    payload.addIssue = (issue2) => {
      if (typeof issue2 === "string") {
        payload.issues.push(issue(issue2, payload.value, def));
      } else {
        const _issue = issue2;
        if (_issue.fatal)
          _issue.continue = false;
        _issue.code ?? (_issue.code = "custom");
        _issue.input ?? (_issue.input = payload.value);
        _issue.inst ?? (_issue.inst = inst);
        payload.issues.push(issue(_issue));
      }
    };
    const output = def.transform(payload.value, payload);
    if (output instanceof Promise) {
      return output.then((output) => {
        payload.value = output;
        payload.fallback = true;
        return payload;
      });
    }
    payload.value = output;
    payload.fallback = true;
    return payload;
  };
});
function transform(fn) {
  return new ZodTransform({
    type: "transform",
    transform: fn
  });
}
var ZodOptional = /* @__PURE__ */ $constructor("ZodOptional", (inst, def) => {
  $ZodOptional.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function optional(innerType) {
  return new ZodOptional({
    type: "optional",
    innerType
  });
}
var ZodExactOptional = /* @__PURE__ */ $constructor("ZodExactOptional", (inst, def) => {
  $ZodExactOptional.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function exactOptional(innerType) {
  return new ZodExactOptional({
    type: "optional",
    innerType
  });
}
var ZodNullable = /* @__PURE__ */ $constructor("ZodNullable", (inst, def) => {
  $ZodNullable.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => nullableProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function nullable(innerType) {
  return new ZodNullable({
    type: "nullable",
    innerType
  });
}
var ZodDefault = /* @__PURE__ */ $constructor("ZodDefault", (inst, def) => {
  $ZodDefault.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => defaultProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
  inst.removeDefault = inst.unwrap;
});
function _default(innerType, defaultValue) {
  return new ZodDefault({
    type: "default",
    innerType,
    get defaultValue() {
      return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
    }
  });
}
var ZodPrefault = /* @__PURE__ */ $constructor("ZodPrefault", (inst, def) => {
  $ZodPrefault.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => prefaultProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function prefault(innerType, defaultValue) {
  return new ZodPrefault({
    type: "prefault",
    innerType,
    get defaultValue() {
      return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
    }
  });
}
var ZodNonOptional = /* @__PURE__ */ $constructor("ZodNonOptional", (inst, def) => {
  $ZodNonOptional.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => nonoptionalProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function nonoptional(innerType, params) {
  return new ZodNonOptional({
    type: "nonoptional",
    innerType,
    ...normalizeParams(params)
  });
}
var ZodCatch = /* @__PURE__ */ $constructor("ZodCatch", (inst, def) => {
  $ZodCatch.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => catchProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
  inst.removeCatch = inst.unwrap;
});
function _catch(innerType, catchValue) {
  return new ZodCatch({
    type: "catch",
    innerType,
    catchValue: typeof catchValue === "function" ? catchValue : () => catchValue
  });
}
var ZodPipe = /* @__PURE__ */ $constructor("ZodPipe", (inst, def) => {
  $ZodPipe.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => pipeProcessor(inst, ctx, json, params);
  inst.in = def.in;
  inst.out = def.out;
});
function pipe(in_, out) {
  return new ZodPipe({
    type: "pipe",
    in: in_,
    out
  });
}
var ZodReadonly = /* @__PURE__ */ $constructor("ZodReadonly", (inst, def) => {
  $ZodReadonly.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => readonlyProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function readonly(innerType) {
  return new ZodReadonly({
    type: "readonly",
    innerType
  });
}
var ZodCustom = /* @__PURE__ */ $constructor("ZodCustom", (inst, def) => {
  $ZodCustom.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => customProcessor(inst, ctx, json, params);
});
function refine(fn, _params = {}) {
  return _refine(ZodCustom, fn, _params);
}
function superRefine(fn, params) {
  return _superRefine(fn, params);
}
var TAX_YEAR_LIST = TAX_LAW_YEARS.map((law) => law.year);
var DOLLAR_MAX = 1e8;
var dollars = number2().finite().min(0).max(DOLLAR_MAX);
var age = number2().int().finite().min(18).max(120);
var percent = (min, max) => number2().finite().min(min).max(max);
var RetirementQuestionInputs = strictObject({
  pretax: dollars,
  taxable: dollars,
  roth: dollars,
  hsa: dollars,
  monthlySpending: number2().finite().gt(0).max(200000),
  currentAge: age,
  spouseAge: age.optional(),
  retirementAge: age.optional(),
  endAge: age.optional(),
  filingStatus: _enum(["mfj", "single", "hoh"]).optional(),
  householdSize: number2().int().finite().min(1).max(20).optional(),
  taxableBasisPct: percent(0, 100).optional(),
  taxableDividendYieldPct: percent(0, 100).optional(),
  taxableInterestYieldPct: percent(0, 100).optional(),
  expectedRealReturnPct: percent(-50, 50).optional(),
  volatilityPct: percent(0, 100).optional(),
  stocksPct: percent(0, 100).optional(),
  strategy: _enum(["constant", "guardrails", "phased", "percent"]).optional(),
  minimumAnnualSpending: dollars.optional(),
  socialSecurityAnnual: dollars.optional(),
  spouseSocialSecurityAnnual: dollars.optional(),
  socialSecurityStartAge: age.optional(),
  spouseSocialSecurityStartAge: age.optional(),
  state: string2().max(100).optional(),
  stateRatePct: percent(0, 50).optional(),
  acaBenchmarkCouple: dollars.optional(),
  acaBenchmarkSingle: dollars.optional(),
  acaBenchmarkFamily: dollars.optional(),
  healthPremiumAcaHouseholdAnnual: dollars.optional(),
  healthPremiumAcaSingleAnnual: dollars.optional(),
  healthPremiumMedicarePerPersonAnnual: dollars.optional(),
  spendingIncludesHealthPremiums: boolean2().optional(),
  otherOrdinaryAnnual: dollars.optional(),
  taxExemptInterestAnnual: dollars.optional(),
  salaryAnnual: dollars.optional(),
  employer401kAnnual: dollars.optional(),
  employerHsaAnnual: dollars.optional(),
  taxYear: union(TAX_YEAR_LIST.map((year) => literal(year)), {
    error: `taxYear must be one of ${TAX_YEAR_LIST.join(", ")} (the available law years)`
  }).optional(),
  interestAnnual: dollars.optional(),
  ordinaryDividendsAnnual: dollars.optional(),
  qualifiedDividendsAnnual: dollars.optional(),
  conversionAnnual: dollars.optional(),
  spendingDrawAnnual: dollars.optional(),
  cashDrawAnnual: dollars.optional(),
  rothDrawAnnual: dollars.optional(),
  stockSoldAnnual: dollars.optional(),
  stockBasisAnnual: dollars.optional(),
  pretaxPriorYearEndAnnual: dollars.optional(),
  pretaxSpousePriorYearEndAnnual: dollars.optional(),
  rmdAlreadyReceivedAnnual: dollars.optional(),
  primarySoleBeneficiaryOfSpouse: boolean2().optional(),
  mcSeed: number2().int().finite().optional(),
  mcRuns: number2().int().finite().min(10).max(5000).optional(),
  compareAges: array(age).min(2).max(5).optional(),
  comparisonScope: _enum(["limited", "full"]).optional()
});

var REQUIRED_INPUTS_GLOBAL = [
  "pretax",
  "taxable",
  "roth",
  "hsa",
  "monthlySpending",
  "currentAge"
];
var FIELD_ORDER = [
  "pretax",
  "taxable",
  "roth",
  "hsa",
  "monthlySpending",
  "currentAge",
  "spouseAge",
  "retirementAge",
  "endAge",
  "filingStatus",
  "householdSize",
  "taxableBasisPct",
  "taxableDividendYieldPct",
  "taxableInterestYieldPct",
  "expectedRealReturnPct",
  "volatilityPct",
  "stocksPct",
  "strategy",
  "minimumAnnualSpending",
  "socialSecurityAnnual",
  "spouseSocialSecurityAnnual",
  "socialSecurityStartAge",
  "spouseSocialSecurityStartAge",
  "state",
  "stateRatePct",
  "acaBenchmarkCouple",
  "acaBenchmarkSingle",
  "acaBenchmarkFamily",
  "healthPremiumAcaHouseholdAnnual",
  "healthPremiumAcaSingleAnnual",
  "healthPremiumMedicarePerPersonAnnual",
  "spendingIncludesHealthPremiums",
  "otherOrdinaryAnnual",
  "taxExemptInterestAnnual",
  "salaryAnnual",
  "employer401kAnnual",
  "employerHsaAnnual",
  "taxYear",
  "interestAnnual",
  "ordinaryDividendsAnnual",
  "qualifiedDividendsAnnual",
  "conversionAnnual",
  "spendingDrawAnnual",
  "cashDrawAnnual",
  "rothDrawAnnual",
  "stockSoldAnnual",
  "stockBasisAnnual",
  "pretaxPriorYearEndAnnual",
  "pretaxSpousePriorYearEndAnnual",
  "rmdAlreadyReceivedAnnual",
  "primarySoleBeneficiaryOfSpouse",
  "mcSeed",
  "mcRuns",
  "compareAges",
  "comparisonScope"
];
var SIM_OPTIONAL_INPUTS = [
  "retirementAge",
  "endAge",
  "spouseAge",
  "stocksPct",
  "expectedRealReturnPct",
  "volatilityPct",
  "strategy",
  "minimumAnnualSpending",
  "socialSecurityAnnual",
  "socialSecurityStartAge",
  "spouseSocialSecurityAnnual",
  "spouseSocialSecurityStartAge"
];
var COMPARE_OPTIONAL_INPUTS = [
  "retirementAge",
  "endAge",
  "spouseAge",
  "filingStatus",
  "householdSize",
  "stocksPct",
  "expectedRealReturnPct",
  "socialSecurityAnnual",
  "socialSecurityStartAge",
  "spouseSocialSecurityAnnual",
  "spouseSocialSecurityStartAge",
  "taxableBasisPct",
  "taxableDividendYieldPct",
  "taxableInterestYieldPct",
  "otherOrdinaryAnnual",
  "taxExemptInterestAnnual",
  "acaBenchmarkCouple",
  "acaBenchmarkSingle",
  "acaBenchmarkFamily",
  "healthPremiumAcaHouseholdAnnual",
  "healthPremiumAcaSingleAnnual",
  "healthPremiumMedicarePerPersonAnnual",
  "spendingIncludesHealthPremiums",
  "stateRatePct",
  "state",
  "comparisonScope"
];
var TAX_YEAR_OPTIONAL_INPUTS = [
  "spouseAge",
  "filingStatus",
  "householdSize",
  "socialSecurityAnnual",
  "socialSecurityStartAge",
  "spouseSocialSecurityAnnual",
  "spouseSocialSecurityStartAge",
  "otherOrdinaryAnnual",
  "taxExemptInterestAnnual",
  "acaBenchmarkCouple",
  "acaBenchmarkSingle",
  "acaBenchmarkFamily",
  "healthPremiumAcaHouseholdAnnual",
  "healthPremiumAcaSingleAnnual",
  "healthPremiumMedicarePerPersonAnnual",
  "spendingIncludesHealthPremiums",
  "stateRatePct",
  "state",
  "taxYear",
  "interestAnnual",
  "ordinaryDividendsAnnual",
  "qualifiedDividendsAnnual",
  "conversionAnnual",
  "spendingDrawAnnual",
  "cashDrawAnnual",
  "rothDrawAnnual",
  "stockSoldAnnual",
  "stockBasisAnnual",
  "pretaxPriorYearEndAnnual",
  "pretaxSpousePriorYearEndAnnual",
  "rmdAlreadyReceivedAnnual",
  "primarySoleBeneficiaryOfSpouse"
];
var PRICED_OPTIONAL = {
  retirement_calculate: SIM_OPTIONAL_INPUTS.filter((f) => f !== "volatilityPct"),
  retirement_monte_carlo: [...SIM_OPTIONAL_INPUTS, "mcRuns", "mcSeed"],
  retirement_max_spending: [
    ...SIM_OPTIONAL_INPUTS.filter((f) => f !== "minimumAnnualSpending"),
    "mcSeed"
  ],
  retirement_compare_strategies: COMPARE_OPTIONAL_INPUTS,
  retirement_roth_conversion: COMPARE_OPTIONAL_INPUTS,
  retirement_work_years: [
    ...COMPARE_OPTIONAL_INPUTS,
    "salaryAnnual",
    "employer401kAnnual",
    "employerHsaAnnual",
    "compareAges"
  ],
  retirement_tax_year: TAX_YEAR_OPTIONAL_INPUTS
};
function pricedBy(field) {
  const tools = Object.keys(PRICED_OPTIONAL);
  return tools.filter((t) => PRICED_OPTIONAL[t].includes(field));
}
var FIELD_BLURBS = {
  spouseAge: "the spouse's current age",
  retirementAge: "the age work income stops",
  endAge: "the last age the projection runs through",
  filingStatus: "the federal tax filing status",
  householdSize: "the household size (drives ACA benchmarks)",
  taxableBasisPct: "the taxable account's cost-basis share",
  taxableDividendYieldPct: "the taxable account's dividend yield",
  taxableInterestYieldPct: "the taxable account's interest yield",
  expectedRealReturnPct: "the expected real portfolio return",
  volatilityPct: "the annual portfolio volatility",
  stocksPct: "the portfolio's stock allocation",
  strategy: "the spending strategy",
  minimumAnnualSpending: "the minimum annual spending floor for the spending-adequacy rate",
  socialSecurityAnnual: "the primary's annual Social Security benefit",
  spouseSocialSecurityAnnual: "the spouse's annual Social Security benefit",
  socialSecurityStartAge: "the primary's Social Security claiming age",
  spouseSocialSecurityStartAge: "the spouse's Social Security claiming age",
  state: "the state of residence",
  stateRatePct: "the flat state income-tax rate",
  acaBenchmarkCouple: "the ACA benchmark premium for a couple",
  acaBenchmarkSingle: "the ACA benchmark premium for a single filer",
  acaBenchmarkFamily: "the ACA benchmark premium for a family household",
  healthPremiumAcaHouseholdAnnual: "the marketplace health premium for a two-person household year",
  healthPremiumAcaSingleAnnual: "the marketplace health premium for a one-person year",
  healthPremiumMedicarePerPersonAnnual: "the Medicare base premium per person",
  spendingIncludesHealthPremiums: "whether monthly spending already includes health insurance premiums",
  otherOrdinaryAnnual: "other ordinary income per year",
  taxExemptInterestAnnual: "tax-exempt interest per year",
  salaryAnnual: "the annual salary while working",
  employer401kAnnual: "the annual employer 401(k) contribution",
  employerHsaAnnual: "the annual employer HSA contribution",
  taxYear: "the tax law year to price under",
  interestAnnual: "taxable interest for one tax year",
  ordinaryDividendsAnnual: "total ordinary dividends for one tax year",
  qualifiedDividendsAnnual: "the qualified portion of one year's ordinary dividends",
  conversionAnnual: "a Roth conversion amount for one tax year",
  spendingDrawAnnual: "the draw for spending for one tax year",
  cashDrawAnnual: "the draw from cash for one tax year",
  rothDrawAnnual: "the draw from Roth for one tax year",
  stockSoldAnnual: "taxable shares sold in one tax year",
  stockBasisAnnual: "the cost basis of the shares sold",
  pretaxPriorYearEndAnnual: "the primary's pre-tax balance at Dec 31 of the year before the priced year",
  pretaxSpousePriorYearEndAnnual: "the spouse's pre-tax balance at Dec 31 of the year before the priced year",
  rmdAlreadyReceivedAnnual: "the part of this year's RMD already received and already counted in the entered income",
  primarySoleBeneficiaryOfSpouse: "whether the primary is the spouse's sole beneficiary (gates the spouse's RMD table)",
  mcSeed: "the Monte Carlo random seed",
  mcRuns: "the number of Monte Carlo simulations",
  compareAges: "the retirement ages to compare",
  comparisonScope: "the comparison scope (limited or full candidate set)"
};
function conditionalReason(tool, field, s) {
  const mfj = s.filingStatus === "mfj";
  if (!mfj && (field === "spouseAge" || field === "spouseSocialSecurityAnnual" || field === "spouseSocialSecurityStartAge")) {
    return `no spouse is modeled for ${s.filingStatus} filing status, so it prices nothing for this scenario; it is priced by the tax-aware tools on a joint (mfj) return`;
  }
  if (field === "stateRatePct") {
    if (s.residenceState === "WA") {
      return "WA is priced via the WA excise path, not an income-tax rate; the rate is priced by the tax-aware tools for a non-WA state";
    }
    if (s.stateLabel == null) {
      return "no state was given, so no state tax is modeled; the rate is priced by the tax-aware tools once a non-WA state is given";
    }
  }
  if (field === "socialSecurityStartAge" && s.ssPrimaryAnnual === 0) {
    return "no primary Social Security benefit was entered, so no claiming age applies; it is priced by every tool once a benefit is entered";
  }
  if (field === "spouseSocialSecurityStartAge" && s.ssSpouseAnnual === 0) {
    return "no spouse Social Security benefit was entered, so no claiming age applies; it is priced by every tool once a benefit is entered";
  }
  if (tool === "retirement_tax_year") {
    if (field === "stockBasisAnnual" && (s.singleYear.stockSold == null || s.singleYear.stockSold === 0)) {
      return "a cost basis prices only against a sale, and no sale was entered for this year — retirement_tax_year prices it only when stockSoldAnnual is entered";
    }
    if (field === "pretaxSpousePriorYearEndAnnual" && !mfj) {
      return "a spouse RMD is priced only on a joint (mfj) return — retirement_tax_year prices it only for mfj";
    }
    if (field === "rmdAlreadyReceivedAnnual" && s.singleYear.pretaxPriorYearEnd == null && s.singleYear.pretaxSpousePriorYearEnd == null) {
      return "no prior-Dec-31 balance was entered, so there is no computed RMD to net it against — retirement_tax_year prices it only once a prior-Dec-31 balance is entered";
    }
    if (field === "primarySoleBeneficiaryOfSpouse" && (!mfj || s.singleYear.pretaxSpousePriorYearEnd == null)) {
      return "it gates only the spouse's RMD table, and no spouse RMD is priced for this year — retirement_tax_year prices it only when a spouse prior-Dec-31 balance is entered on a joint return";
    }
  }
  return null;
}
function ignoredInputsForTool(tool, scenario) {
  const priced = new Set(PRICED_OPTIONAL[tool]);
  const out = [];
  for (const field of scenario.suppliedFields) {
    if (REQUIRED_INPUTS_GLOBAL.includes(field))
      continue;
    const conditional = priced.has(field) ? conditionalReason(tool, field, scenario) : null;
    if (priced.has(field) && conditional === null)
      continue;
    const others = pricedBy(field).filter((t) => t !== tool);
    const reason = conditional ?? (others.length > 0 ? `${FIELD_BLURBS[field] ?? field}, priced by ${others.join(", ")} — use ${others[0]} for it` : `${FIELD_BLURBS[field] ?? field}; no tool prices this input`);
    out.push({ field, tool, pricedBy: others, reason });
  }
  return out;
}
function ignoredInputWarning(entry) {
  return `Ignored input "${entry.field}" has no effect on ${entry.tool}: ${entry.reason}.`;
}

var ESSENTIAL_KEYS = [
  "pretax",
  "taxable",
  "roth",
  "hsa",
  "monthlySpending",
  "currentAge"
];
var MISSING_INPUT_QUESTIONS = {
  pretax: "How much do you have in pre-tax retirement accounts, like a 401(k) or IRA?",
  taxable: "How much do you have in taxable brokerage accounts?",
  roth: "How much do you have in Roth accounts?",
  hsa: "How much do you have in your HSA?",
  monthlySpending: "How much do you spend in a typical month?",
  currentAge: "How old are you?",
  spouseAge: "How old is your spouse?",
  socialSecurityStartAge: "At what age do you plan to start collecting Social Security?",
  spouseSocialSecurityStartAge: "At what age does your spouse plan to start collecting Social Security?",
  spendingIncludesHealthPremiums: "Does your monthly spending already include health insurance premiums?"
};
function questionsForFields(fields) {
  return fields.map((field) => ({
    field,
    question: MISSING_INPUT_QUESTIONS[field] ?? `Please provide ${field}.`
  }));
}
function dollarsToCents(dollars) {
  if (!Number.isFinite(dollars)) {
    throw new Error("dollarsToCents: non-finite dollar amount");
  }
  return Math.round(dollars * 100);
}
function blendedVolPct(stocksPct) {
  return stocksPct / 100 * 18 + (1 - stocksPct / 100) * 6;
}
function latestTaxLawYear() {
  return CURRENT_LAW.year;
}
function missingInputError(missing) {
  return {
    ok: false,
    source: "finance-planner-engine",
    adapterVersion: ADAPTER_VERSION,
    apiContractVersion: API_CONTRACT_VERSION_REPORTED,
    error: {
      code: "missing_input",
      message: `Missing required input: ${missing.join(", ")}.`,
      missing,
      questions: questionsForFields(missing)
    }
  };
}
function invalidInputError(message, details) {
  return {
    ok: false,
    source: "finance-planner-engine",
    adapterVersion: ADAPTER_VERSION,
    apiContractVersion: API_CONTRACT_VERSION_REPORTED,
    error: {
      code: "invalid_input",
      message,
      details
    }
  };
}
function receivedName(value) {
  if (value === undefined)
    return "undefined";
  if (value === null)
    return "null";
  if (Array.isArray(value))
    return "array";
  if (typeof value === "number")
    return Number.isNaN(value) ? "nan" : "number";
  if (value instanceof Date)
    return "date";
  return typeof value;
}
function valueAtPath(raw, path) {
  let cur = raw;
  for (const seg of path) {
    if (cur === null || typeof cur !== "object")
      return;
    if (typeof seg === "symbol")
      return;
    cur = cur[seg];
  }
  return cur;
}
function detailMessage(issue, raw) {
  if (issue.code === "invalid_type") {
    return `Invalid input: expected ${String(issue.expected)}, received ${receivedName(valueAtPath(raw, issue.path))}`;
  }
  if (issue.code === "too_small" || issue.code === "too_big") {
    const tooSmall = issue.code === "too_small";
    const bound = tooSmall ? issue.minimum : issue.maximum;
    const op = issue.inclusive ? tooSmall ? ">=" : "<=" : tooSmall ? ">" : "<";
    const head = tooSmall ? "Too small" : "Too big";
    if (issue.origin === "number") {
      return `${head}: expected number to be ${op}${String(bound)}`;
    }
    if (issue.origin === "array") {
      return `${head}: expected array to have ${op}${String(bound)} items`;
    }
    if (issue.origin === "string") {
      return `${head}: expected string to have ${op}${String(bound)} characters`;
    }
    return issue.message;
  }
  if (issue.code === "invalid_value") {
    return `Invalid option: expected one of ${(issue.values ?? []).map((v) => JSON.stringify(v)).join("|")}`;
  }
  return issue.message;
}
function normalizeInputs(raw) {
  const parsed = RetirementQuestionInputs.safeParse(raw);
  if (!parsed.success) {
    const rawMissing = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? ESSENTIAL_KEYS.filter((k) => !(k in raw) || raw[k] === undefined) : [];
    if (rawMissing.length > 0) {
      return { ok: false, error: missingInputError(rawMissing) };
    }
    const issues = parsed.error.issues;
    const missingEssential = [];
    for (const issue of issues) {
      const field = issue.path[0];
      if (typeof field === "string" && ESSENTIAL_KEYS.includes(field) && issue.code === "invalid_type" && issue.message.includes("received undefined") && !missingEssential.includes(field)) {
        missingEssential.push(field);
      }
    }
    if (missingEssential.length > 0) {
      const ordered = ESSENTIAL_KEYS.filter((k) => missingEssential.includes(k));
      return { ok: false, error: missingInputError(ordered) };
    }
    const details = issues.flatMap((issue) => {
      if (issue.code === "unrecognized_keys") {
        return issue.keys.map((key) => ({
          field: key,
          message: `Unrecognized key: "${key}"`
        }));
      }
      return [
        {
          field: issue.path.length > 0 ? issue.path.join(".") : "(input)",
          message: detailMessage(issue, raw)
        }
      ];
    });
    const fields = [...new Set(details.map((d) => d.field))];
    return {
      ok: false,
      error: invalidInputError(`Invalid input in: ${fields.join(", ")}.`, details)
    };
  }
  const input = parsed.data;
  const assumptions = [];
  const warnings = [];
  const record = (field, value, provenance, note) => {
    assumptions.push({ field, value, provenance, note });
  };
  const filingStatus = input.filingStatus ?? "mfj";
  const isMfj = filingStatus === "mfj";
  const missing = [];
  if (isMfj && input.spouseAge === undefined)
    missing.push("spouseAge");
  const ssPrimaryAnnual = input.socialSecurityAnnual ?? 0;
  if (ssPrimaryAnnual > 0 && input.socialSecurityStartAge === undefined) {
    missing.push("socialSecurityStartAge");
  }
  const ssSpouseAnnualRaw = input.spouseSocialSecurityAnnual ?? 0;
  if (isMfj && ssSpouseAnnualRaw > 0 && input.spouseSocialSecurityStartAge === undefined) {
    missing.push("spouseSocialSecurityStartAge");
  }
  const anyPremiumGiven = input.healthPremiumAcaHouseholdAnnual !== undefined || input.healthPremiumAcaSingleAnnual !== undefined || input.healthPremiumMedicarePerPersonAnnual !== undefined;
  if (anyPremiumGiven && input.spendingIncludesHealthPremiums === undefined) {
    missing.push("spendingIncludesHealthPremiums");
  }
  if (missing.length > 0) {
    return { ok: false, error: missingInputError(missing) };
  }
  const currentAge = input.currentAge;
  const retirementAge = input.retirementAge ?? currentAge;
  const endAge = input.endAge ?? 95;
  if (retirementAge < currentAge) {
    return {
      ok: false,
      error: invalidInputError("retirementAge must not be before currentAge.", [{ field: "retirementAge", message: "must not be before currentAge" }])
    };
  }
  if (endAge <= retirementAge) {
    return {
      ok: false,
      error: invalidInputError("endAge must be after retirementAge (the plan needs retired years to price).", [{ field: "endAge", message: "must be after retirementAge" }])
    };
  }
  if (endAge > 120) {
    return {
      ok: false,
      error: invalidInputError("endAge must be 120 or less.", [{ field: "endAge", message: "must be 120 or less" }])
    };
  }
  for (const a of input.compareAges ?? []) {
    if (a < currentAge || a >= endAge) {
      return {
        ok: false,
        error: invalidInputError(`compareAges must be at or after currentAge (${currentAge}) and before endAge (${endAge}); got ${a}.`, [
          {
            field: "compareAges",
            message: `must be ${currentAge}–${endAge - 1}`
          }
        ])
      };
    }
  }
  const ordinaryDividendsAnnual = input.ordinaryDividendsAnnual ?? 0;
  const qualifiedDividendsAnnual = input.qualifiedDividendsAnnual ?? 0;
  if (qualifiedDividendsAnnual > ordinaryDividendsAnnual) {
    return {
      ok: false,
      error: invalidInputError("qualifiedDividendsAnnual must not exceed ordinaryDividendsAnnual: qualified dividends are the qualified portion (1099-DIV Box 1b) of total ordinary dividends (Box 1a).", [
        {
          field: "qualifiedDividendsAnnual",
          message: `must not exceed ordinaryDividendsAnnual (${ordinaryDividendsAnnual})`
        },
        {
          field: "ordinaryDividendsAnnual",
          message: `is the total ordinary dividends (Box 1a) and must be at least qualifiedDividendsAnnual (${qualifiedDividendsAnnual})`
        }
      ])
    };
  }
  const startYear = new Date().getFullYear();
  const taxYear = input.taxYear ?? Math.min(startYear, latestTaxLawYear());
  const pretaxDollars = input.pretax;
  const taxableDollars = input.taxable;
  const rothDollars = input.roth;
  const hsaDollars = input.hsa;
  record("pretax", pretaxDollars, "user", "Provided by caller.");
  record("taxable", taxableDollars, "user", "Provided by caller.");
  record("roth", rothDollars, "user", "Provided by caller.");
  record("hsa", hsaDollars, "user", "Provided by caller.");
  const portfolioCents = dollarsToCents(pretaxDollars) + dollarsToCents(taxableDollars) + dollarsToCents(rothDollars) + dollarsToCents(hsaDollars);
  const monthlySpending = input.monthlySpending;
  record("monthlySpending", monthlySpending, "user", "Provided by caller.");
  const annualSpendingCents = Math.round(monthlySpending * 12 * 100);
  const minimumAnnualSpendingCents = input.minimumAnnualSpending == null || input.minimumAnnualSpending === 0 ? null : Math.round(input.minimumAnnualSpending * 100);
  if (input.minimumAnnualSpending === undefined || input.minimumAnnualSpending === 0) {
    record("minimumAnnualSpending", null, "assumption", "No minimum yearly spending given — no spending-adequacy rate is reported.");
  } else {
    record("minimumAnnualSpending", input.minimumAnnualSpending, "user", "Provided by caller — the adequacy rate counts runs where every retired year's gross spending stayed at or above this floor.");
  }
  record("currentAge", currentAge, "user", "Provided by caller.");
  if (input.retirementAge === undefined) {
    record("retirementAge", retirementAge, "assumption", "No retirement age given — retire now (retirementAge = currentAge).");
  } else {
    record("retirementAge", retirementAge, "user", "Provided by caller.");
  }
  if (input.endAge === undefined) {
    record("endAge", endAge, "engine_constant", "Engine default end age 95 (retirementEngines.ts: raw.endAge ?? 95).");
  } else {
    record("endAge", endAge, "user", "Provided by caller.");
  }
  const birthYearPrimary = startYear - currentAge;
  record("birthYearPrimary", birthYearPrimary, "assumption", "Derived as startYear − currentAge (startYear is the current calendar year).");
  if (input.filingStatus === undefined) {
    record("filingStatus", filingStatus, "assumption", 'No filing status given — assumed "mfj".');
  } else {
    record("filingStatus", filingStatus, "user", "Provided by caller.");
  }
  const householdSize = input.householdSize ?? (isMfj ? 2 : 1);
  if (input.householdSize === undefined) {
    record("householdSize", householdSize, "assumption", isMfj ? 'No household size given — assumed 2 for "mfj".' : "No household size given — assumed 1 for single/hoh.");
  } else {
    record("householdSize", householdSize, "user", "Provided by caller.");
  }
  let birthYearSpouse = null;
  if (isMfj) {
    const spouseAge = input.spouseAge;
    record("spouseAge", spouseAge, "user", "Provided by caller.");
    birthYearSpouse = startYear - spouseAge;
    record("birthYearSpouse", birthYearSpouse, "assumption", "Derived as startYear − spouseAge (startYear is the current calendar year).");
  } else {
    if (input.spouseAge !== undefined) {
      warnings.push("spouseAge is ignored for single/hoh filing status.");
    }
    record("spouseAge", null, "assumption", "No spouse modeled for single/hoh filing status.");
    record("birthYearSpouse", null, "assumption", "No spouse modeled for single/hoh filing status.");
  }
  const stocksPct = input.stocksPct ?? 95;
  if (input.stocksPct === undefined) {
    record("stocksPct", stocksPct, "engine_constant", "Engine default stock mix 95% (retirementEngines.ts STOCKS_PCT_DEFAULT).");
  } else {
    record("stocksPct", stocksPct, "user", "Provided by caller.");
  }
  const expectedReturnPct = input.expectedRealReturnPct ?? EXPECTED_RETURN_DEFAULT;
  if (input.expectedRealReturnPct === undefined) {
    record("expectedRealReturnPct", expectedReturnPct, "engine_constant", "Engine factory default 5% (retirementEngines.ts EXPECTED_RETURN_DEFAULT) — the flat default that replaced the stock-mix blend in build v132.");
  } else {
    record("expectedRealReturnPct", expectedReturnPct, "user", "Provided by caller — the engine's factory default is bypassed.");
  }
  const volatilityPct = input.volatilityPct ?? blendedVolPct(stocksPct);
  if (input.volatilityPct === undefined) {
    record("volatilityPct", volatilityPct, "engine_constant", "Derived from the stock mix by the engine's blendedVol: stocks% × 18% + bonds% × 6%.");
  } else {
    record("volatilityPct", volatilityPct, "user", "Provided by caller — the engine's stock-mix blend derivation is bypassed.");
  }
  const strategy = input.strategy ?? "constant";
  if (input.strategy === undefined) {
    record("strategy", strategy, "assumption", 'No strategy given — assumed "constant" spending.');
  } else {
    record("strategy", strategy, "user", "Provided by caller.");
  }
  if (strategy === "percent") {
    record("percentOfPortfolio", 5, "engine_constant", 'The "percent" strategy spends 5% of the start-of-year balance each year (engine default, retirementEngines.ts).');
  } else if (strategy === "guardrails") {
    record("guardrailsCutPct", GUARDRAILS_CUT_DEFAULT, "engine_constant", "Guardrails cut spending 10% when the year's spending rate tops 120% of the starting rate (engine default).");
    record("guardrailsRaisePct", GUARDRAILS_RAISE_DEFAULT, "engine_constant", "Guardrails raise spending 10% when the year's spending rate falls below 80% of the starting rate (engine default).");
    record("guardrailsAdjustmentPct", GUARDRAILS_ADJUSTMENT_DEFAULT, "engine_constant", "Guardrails adjust spending by 10% per rail hit, at most one adjustment a year (engine default).");
  } else if (strategy === "phased") {
    record("phaseStartAge", PHASE_START_AGE_DEFAULT, "engine_constant", "Phased spending stays flat until age 75, then steps down each year (engine default).");
    record("phaseDeclinePct", PHASE_DECLINE_PCT_DEFAULT, "engine_constant", "Phased spending declines 1% a year after the step-down start age (engine default).");
  }
  let ssPrimaryStartAge = null;
  if (input.socialSecurityAnnual === undefined) {
    record("socialSecurityAnnual", 0, "assumption", "No Social Security modeled — none provided.");
  } else {
    record("socialSecurityAnnual", ssPrimaryAnnual, "user", "Provided by caller.");
  }
  if (ssPrimaryAnnual > 0) {
    ssPrimaryStartAge = input.socialSecurityStartAge;
    record("socialSecurityStartAge", ssPrimaryStartAge, "user", "Provided by caller.");
  } else {
    record("socialSecurityStartAge", null, "assumption", "No start age applies — no Social Security modeled.");
  }
  let ssSpouseAnnual = 0;
  let ssSpouseStartAge = null;
  if (isMfj) {
    if (input.spouseSocialSecurityAnnual === undefined) {
      record("spouseSocialSecurityAnnual", 0, "assumption", "No spouse Social Security modeled — none provided.");
    } else {
      ssSpouseAnnual = ssSpouseAnnualRaw;
      record("spouseSocialSecurityAnnual", ssSpouseAnnual, "user", "Provided by caller.");
    }
    if (ssSpouseAnnual > 0) {
      ssSpouseStartAge = input.spouseSocialSecurityStartAge;
      record("spouseSocialSecurityStartAge", ssSpouseStartAge, "user", "Provided by caller.");
    } else {
      record("spouseSocialSecurityStartAge", null, "assumption", "No start age applies — no spouse Social Security modeled.");
    }
  } else {
    if (input.spouseSocialSecurityAnnual !== undefined) {
      warnings.push("Spouse Social Security is ignored for single/hoh filing status.");
    }
    record("spouseSocialSecurityAnnual", 0, "assumption", "No spouse Social Security modeled for single/hoh filing status.");
    record("spouseSocialSecurityStartAge", null, "assumption", "No spouse Social Security modeled for single/hoh filing status.");
  }
  const taxableBasisBlank = input.taxableBasisPct === undefined;
  const taxableBasisPct = input.taxableBasisPct ?? 100;
  if (taxableBasisBlank) {
    record("taxableBasisPct", 100, "assumption", "No basis provided — modeled as 100% basis, no gains on draws (engine blank-basis path: untracked taxable money lands at 100% basis).");
  } else {
    record("taxableBasisPct", taxableBasisPct, "user", "Provided by caller.");
  }
  record("taxableBasisBlank", taxableBasisBlank, "assumption", taxableBasisBlank ? "Basis was not provided, so the 100% basis above is an assumption." : "Basis was provided by the caller.");
  if (input.taxableDividendYieldPct === undefined) {
    record("taxableDividendYieldPct", null, "assumption", "No taxable yield modeled — dividends/interest $0.");
  } else {
    record("taxableDividendYieldPct", input.taxableDividendYieldPct, "user", "Provided by caller.");
  }
  if (input.taxableInterestYieldPct === undefined) {
    record("taxableInterestYieldPct", null, "assumption", "No taxable yield modeled — dividends/interest $0.");
  } else {
    record("taxableInterestYieldPct", input.taxableInterestYieldPct, "user", "Provided by caller.");
  }
  const otherOrdinaryAnnual = input.otherOrdinaryAnnual ?? 0;
  if (input.otherOrdinaryAnnual === undefined) {
    record("otherOrdinaryAnnual", 0, "assumption", "No amount entered — $0.");
  } else {
    record("otherOrdinaryAnnual", otherOrdinaryAnnual, "user", "Provided by caller.");
  }
  const taxExemptInterestAnnual = input.taxExemptInterestAnnual ?? 0;
  if (input.taxExemptInterestAnnual === undefined) {
    record("taxExemptInterestAnnual", 0, "assumption", "No amount entered — $0.");
  } else {
    record("taxExemptInterestAnnual", taxExemptInterestAnnual, "user", "Provided by caller.");
  }
  const acaBenchmarkCouple = input.acaBenchmarkCouple ?? null;
  const acaBenchmarkSingle = input.acaBenchmarkSingle ?? null;
  const acaBenchmarkFamily = input.acaBenchmarkFamily ?? null;
  for (const [field, value] of [
    ["acaBenchmarkCouple", acaBenchmarkCouple],
    ["acaBenchmarkSingle", acaBenchmarkSingle],
    ["acaBenchmarkFamily", acaBenchmarkFamily]
  ]) {
    if (value === null) {
      record(field, null, "assumption", "No ACA benchmark provided for this household size — no credit modeled for it.");
    } else {
      record(field, value, "user", "Provided by caller.");
    }
  }
  if (acaBenchmarkCouple === null && acaBenchmarkSingle === null && acaBenchmarkFamily === null) {
    warnings.push("No ACA benchmark provided — ACA premium credits are not modeled (credit $0).");
  }
  const healthPremiumAcaHousehold = input.healthPremiumAcaHouseholdAnnual ?? null;
  const healthPremiumAcaSingle = input.healthPremiumAcaSingleAnnual ?? null;
  const healthPremiumMedicarePerPerson = input.healthPremiumMedicarePerPersonAnnual ?? null;
  const premiumsGiven = anyPremiumGiven;
  const spendingIncludesHealthPremiums = input.spendingIncludesHealthPremiums ?? null;
  const premiumsCharged = premiumsGiven && spendingIncludesHealthPremiums === false;
  for (const [field, value] of [
    ["healthPremiumAcaHouseholdAnnual", healthPremiumAcaHousehold],
    ["healthPremiumAcaSingleAnnual", healthPremiumAcaSingle],
    [
      "healthPremiumMedicarePerPersonAnnual",
      healthPremiumMedicarePerPerson
    ]
  ]) {
    if (value === null) {
      record(field, null, "assumption", field === "healthPremiumMedicarePerPersonAnnual" ? "No Medicare premium provided — no Medicare premium is modeled for this tier (a null Medicare amount has no benchmark fallback)." : premiumsCharged ? "No premium provided for this tier — with the premium term active, the engine falls back to the year's benchmark for this tier." : "No health premium provided for this tier — no premium modeled for it.");
    } else {
      record(field, value, "user", "Provided by caller.");
    }
  }
  if (spendingIncludesHealthPremiums === null) {
    record("spendingIncludesHealthPremiums", null, "assumption", "No health premium fields were given, so no spending convention applies.");
  } else {
    record("spendingIncludesHealthPremiums", spendingIncludesHealthPremiums, "user", "Provided by caller.");
  }
  const premiumsInSpending = premiumsGiven && spendingIncludesHealthPremiums === true;
  record("premiumsCharged", premiumsCharged, "assumption", premiumsCharged ? "Health premiums are funded on top of monthlySpending: the caller declared spending excludes premiums, so the engine's v208 term is wired." : premiumsInSpending ? "Health premiums are NOT charged again: the caller declared they are already inside monthlySpending, so the engine funds spending verbatim and the supplied amounts are recorded for reference only." : "No health premium is charged: no premium fields were given.");
  if (premiumsInSpending) {
    warnings.push("Monthly spending already includes health premiums, so the supplied premium amounts are recorded but not charged again — the engine funds spending verbatim. Gross/net premium breakdowns are not priced in this mode.");
  }
  const rawState = input.state === undefined ? "" : input.state.trim();
  let residenceState = "other";
  let stateRatePct = 0;
  let stateLabel = null;
  if (rawState === "") {
    record("state", null, "assumption", "No state given — no state tax modeled.");
    stateRatePct = input.stateRatePct ?? 0;
    if (input.stateRatePct === undefined) {
      record("stateRatePct", 0, "assumption", "No state given — no state tax modeled.");
    } else {
      record("stateRatePct", stateRatePct, "user", "Provided by caller, but no state was given so no state tax is modeled.");
    }
  } else if (rawState.toLowerCase() === "wa" || rawState.toLowerCase() === "washington") {
    residenceState = "WA";
    stateLabel = "WA";
    record("state", "WA", "user", "Provided by caller (normalized to WA).");
    stateRatePct = input.stateRatePct ?? 0;
    if (input.stateRatePct === undefined) {
      record("stateRatePct", 0, "assumption", "WA — no income-tax rate applies; the engine prices WA via the WA excise path.");
    } else {
      warnings.push("A state tax rate was supplied for WA but is ignored — the engine prices WA via the WA excise path, not an income-tax rate.");
      record("stateRatePct", stateRatePct, "user", "Provided by caller, but ignored for WA — the engine prices WA via the WA excise path.");
    }
  } else {
    residenceState = "other";
    stateLabel = rawState.length === 2 ? rawState.toUpperCase() : rawState;
    record("state", stateLabel, "user", "Provided by caller.");
    stateRatePct = input.stateRatePct ?? 0;
    if (input.stateRatePct === undefined) {
      warnings.push("No state tax rate provided — state tax modeled as $0.");
      record("stateRatePct", 0, "assumption", "No state rate provided — state tax modeled as $0.");
    } else {
      record("stateRatePct", stateRatePct, "user", "Provided by caller.");
    }
  }
  record("residenceState", residenceState, "assumption", residenceState === "WA" ? "Washington residence — WA excise path." : "Non-WA residence — state income-tax rate applies (if given).");
  record("startYear", startYear, "assumption", "Current calendar year.");
  if (input.taxYear === undefined) {
    record("taxYear", taxYear, "assumption", startYear > latestTaxLawYear() ? `No tax year given — defaults to the latest published law year (${taxYear}); the current year (${startYear}) is beyond the published tables.` : "No tax year given — defaults to the current calendar year (startYear).");
  } else {
    record("taxYear", taxYear, "user", "Provided by caller.");
  }
  const salaryAnnual = input.salaryAnnual ?? null;
  if (input.salaryAnnual === undefined) {
    record("salaryAnnual", null, "assumption", "Not provided — only needed by the work-years tool.");
  } else {
    record("salaryAnnual", salaryAnnual, "user", "Provided by caller.");
  }
  const employer401kAnnual = input.employer401kAnnual ?? 0;
  if (input.employer401kAnnual === undefined) {
    record("employer401kAnnual", 0, "assumption", "No amount entered — $0.");
  } else {
    record("employer401kAnnual", employer401kAnnual, "user", "Provided by caller.");
  }
  const employerHsaAnnual = input.employerHsaAnnual ?? 0;
  if (input.employerHsaAnnual === undefined) {
    record("employerHsaAnnual", 0, "assumption", "No amount entered — $0.");
  } else {
    record("employerHsaAnnual", employerHsaAnnual, "user", "Provided by caller.");
  }
  record("inflationPct", 0, "assumption", "Today's dollars; law rows deflate non-indexed figures at 0%.");
  const singleYear = {
    interest: input.interestAnnual ?? 0,
    ordinaryDividends: input.ordinaryDividendsAnnual ?? 0,
    qualifiedDividends: input.qualifiedDividendsAnnual ?? 0,
    conversion: input.conversionAnnual ?? 0,
    spendingDraw: input.spendingDrawAnnual ?? 0,
    cashDraw: input.cashDrawAnnual ?? 0,
    rothDraw: input.rothDrawAnnual ?? 0,
    stockSold: input.stockSoldAnnual ?? null,
    stockBasis: input.stockBasisAnnual ?? null,
    pretaxPriorYearEnd: input.pretaxPriorYearEndAnnual ?? null,
    pretaxSpousePriorYearEnd: input.pretaxSpousePriorYearEndAnnual ?? null,
    rmdAlreadyReceived: input.rmdAlreadyReceivedAnnual ?? null,
    primarySoleBeneficiaryOfSpouse: input.primarySoleBeneficiaryOfSpouse ?? null
  };
  const singleYearInputs = [
    ["singleYear.interest", input.interestAnnual, singleYear.interest],
    [
      "singleYear.ordinaryDividends",
      input.ordinaryDividendsAnnual,
      singleYear.ordinaryDividends
    ],
    [
      "singleYear.qualifiedDividends",
      input.qualifiedDividendsAnnual,
      singleYear.qualifiedDividends
    ],
    ["singleYear.conversion", input.conversionAnnual, singleYear.conversion],
    [
      "singleYear.spendingDraw",
      input.spendingDrawAnnual,
      singleYear.spendingDraw
    ],
    ["singleYear.cashDraw", input.cashDrawAnnual, singleYear.cashDraw],
    ["singleYear.rothDraw", input.rothDrawAnnual, singleYear.rothDraw]
  ];
  for (const [field, rawValue, value] of singleYearInputs) {
    if (rawValue === undefined) {
      record(field, value, "assumption", "No amount entered — $0.");
    } else {
      record(field, value, "user", "Provided by caller.");
    }
  }
  const singleYearNullableInputs = [
    [
      "singleYear.stockSold",
      input.stockSoldAnnual,
      singleYear.stockSold,
      "No sale entered — no taxable share sale is priced."
    ],
    [
      "singleYear.stockBasis",
      input.stockBasisAnnual,
      singleYear.stockBasis,
      "No basis entered — a sale prices with $0 basis (whole proceeds as gain) unless a basis is given."
    ],
    [
      "singleYear.pretaxPriorYearEnd",
      input.pretaxPriorYearEndAnnual,
      singleYear.pretaxPriorYearEnd,
      "No prior-Dec-31 pre-tax balance entered — no RMD is priced from the primary's balance."
    ],
    [
      "singleYear.pretaxSpousePriorYearEnd",
      input.pretaxSpousePriorYearEndAnnual,
      singleYear.pretaxSpousePriorYearEnd,
      "No prior-Dec-31 spouse pre-tax balance entered — no spouse RMD is priced."
    ],
    [
      "singleYear.rmdAlreadyReceived",
      input.rmdAlreadyReceivedAnnual,
      singleYear.rmdAlreadyReceived,
      "No RMD already received entered — $0 (the full computed RMD is added)."
    ],
    [
      "singleYear.primarySoleBeneficiaryOfSpouse",
      input.primarySoleBeneficiaryOfSpouse,
      singleYear.primarySoleBeneficiaryOfSpouse,
      "Not established whether the primary is the spouse's sole beneficiary — the spouse's RMD prices on the Uniform Lifetime Table."
    ]
  ];
  for (const [field, rawValue, value, omittedNote] of singleYearNullableInputs) {
    if (rawValue === undefined) {
      record(field, value, "assumption", omittedNote);
    } else {
      record(field, value, "user", "Provided by caller.");
    }
  }
  const mcSeed = input.mcSeed ?? 12345;
  if (input.mcSeed === undefined) {
    record("mcSeed", mcSeed, "engine_constant", "Engine default Monte Carlo seed 12345 (MONTE_CARLO_TAB_SEED_DEFAULT).");
  } else {
    record("mcSeed", mcSeed, "user", "Provided by caller.");
  }
  const mcRuns = input.mcRuns ?? 1000;
  if (input.mcRuns === undefined) {
    record("mcRuns", mcRuns, "engine_constant", "Engine default Monte Carlo runs 1000 (MONTE_CARLO_TAB_RUNS).");
  } else {
    record("mcRuns", mcRuns, "user", "Provided by caller.");
  }
  const compareAges = input.compareAges ?? [];
  if (input.compareAges !== undefined) {
    record("compareAges", compareAges, "user", "Provided by caller.");
  }
  const suppliedFields = FIELD_ORDER.filter((f) => (f in input));
  const comparisonScope = input.comparisonScope ?? "limited";
  if (input.comparisonScope === undefined) {
    record("comparisonScope", comparisonScope, "assumption", `No comparison scope given — assumed "limited": the fixed small comparison (3 withdrawal orders / 4 conversion fills). Pass "full" for the engine's whole candidate space.`);
  } else {
    record("comparisonScope", comparisonScope, "user", "Provided by caller.");
  }
  const scenario = {
    portfolioCents,
    annualSpendingCents,
    minimumAnnualSpendingCents,
    currentAge,
    retirementAge,
    endAge,
    birthYearPrimary,
    birthYearSpouse,
    filingStatus,
    householdSize,
    stocksPct,
    expectedReturnPct,
    volatilityPct,
    strategy,
    ssPrimaryAnnual,
    ssPrimaryStartAge,
    ssSpouseAnnual,
    ssSpouseStartAge,
    pretaxDollars,
    taxableDollars,
    rothDollars,
    hsaDollars,
    taxableBasisPct,
    taxableBasisBlank,
    taxableDividendYieldPct: input.taxableDividendYieldPct ?? null,
    taxableInterestYieldPct: input.taxableInterestYieldPct ?? null,
    otherOrdinaryAnnual,
    taxExemptInterestAnnual,
    acaBenchmarkCouple,
    acaBenchmarkSingle,
    acaBenchmarkFamily,
    healthPremiumAcaHousehold,
    healthPremiumAcaSingle,
    healthPremiumMedicarePerPerson,
    spendingIncludesHealthPremiums,
    premiumsCharged,
    premiumsInSpending,
    stateRatePct,
    residenceState,
    stateLabel,
    taxYear,
    startYear,
    salaryAnnual,
    employer401kAnnual,
    employerHsaAnnual,
    inflationPct: 0,
    singleYear,
    mcSeed,
    mcRuns,
    compareAges,
    suppliedFields,
    comparisonScope,
    assumptions,
    warnings
  };
  return { ok: true, scenario };
}
function publicEffectiveInputs(scenario) {
  const monthlySpending = Math.round(scenario.annualSpendingCents / 12) / 100;
  return {
    pretax: scenario.pretaxDollars,
    taxable: scenario.taxableDollars,
    roth: scenario.rothDollars,
    hsa: scenario.hsaDollars,
    portfolioDollars: scenario.pretaxDollars + scenario.taxableDollars + scenario.rothDollars + scenario.hsaDollars,
    monthlySpending,
    annualSpending: scenario.annualSpendingCents / 100,
    minimumAnnualSpending: scenario.minimumAnnualSpendingCents == null ? null : scenario.minimumAnnualSpendingCents / 100,
    currentAge: scenario.currentAge,
    spouseAge: scenario.birthYearSpouse === null ? null : scenario.startYear - scenario.birthYearSpouse,
    retirementAge: scenario.retirementAge,
    endAge: scenario.endAge,
    birthYearPrimary: scenario.birthYearPrimary,
    birthYearSpouse: scenario.birthYearSpouse,
    filingStatus: scenario.filingStatus,
    householdSize: scenario.householdSize,
    stocksPct: scenario.stocksPct,
    expectedRealReturnPct: scenario.expectedReturnPct,
    volatilityPct: scenario.volatilityPct,
    strategy: scenario.strategy,
    socialSecurityAnnual: scenario.ssPrimaryAnnual,
    socialSecurityStartAge: scenario.ssPrimaryStartAge,
    spouseSocialSecurityAnnual: scenario.ssSpouseAnnual,
    spouseSocialSecurityStartAge: scenario.ssSpouseStartAge,
    taxableBasisPct: scenario.taxableBasisPct,
    taxableBasisBlank: scenario.taxableBasisBlank,
    taxableDividendYieldPct: scenario.taxableDividendYieldPct,
    taxableInterestYieldPct: scenario.taxableInterestYieldPct,
    otherOrdinaryAnnual: scenario.otherOrdinaryAnnual,
    taxExemptInterestAnnual: scenario.taxExemptInterestAnnual,
    acaBenchmarkCouple: scenario.acaBenchmarkCouple,
    acaBenchmarkSingle: scenario.acaBenchmarkSingle,
    acaBenchmarkFamily: scenario.acaBenchmarkFamily,
    healthPremiumAcaHouseholdAnnual: scenario.healthPremiumAcaHousehold,
    healthPremiumAcaSingleAnnual: scenario.healthPremiumAcaSingle,
    healthPremiumMedicarePerPersonAnnual: scenario.healthPremiumMedicarePerPerson,
    spendingIncludesHealthPremiums: scenario.spendingIncludesHealthPremiums,
    premiumsCharged: scenario.premiumsCharged,
    premiumsInSpending: scenario.premiumsInSpending,
    state: scenario.stateLabel,
    residenceState: scenario.residenceState,
    stateRatePct: scenario.stateRatePct,
    taxYear: scenario.taxYear,
    startYear: scenario.startYear,
    salaryAnnual: scenario.salaryAnnual,
    employer401kAnnual: scenario.employer401kAnnual,
    employerHsaAnnual: scenario.employerHsaAnnual,
    inflationPct: scenario.inflationPct,
    singleYear: { ...scenario.singleYear },
    mcSeed: scenario.mcSeed,
    mcRuns: scenario.mcRuns,
    compareAges: [...scenario.compareAges],
    comparisonScope: scenario.comparisonScope
  };
}

function centsToDollars(cents) {
  return Math.round(cents) / 100;
}
function dollarsToCents2(dollars) {
  return Math.round(dollars * 100);
}
function r24(n) {
  return Math.round(n * 100) / 100;
}
function roundDeep(value) {
  if (typeof value === "number")
    return r24(value);
  if (Array.isArray(value))
    return value.map(roundDeep);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = roundDeep(v);
    }
    return out;
  }
  return value;
}
function engineError(message) {
  return {
    ok: false,
    source: "finance-planner-engine",
    adapterVersion: ADAPTER_VERSION,
    apiContractVersion: API_CONTRACT_VERSION_REPORTED,
    error: { code: "engine_error", message }
  };
}
function unsupported(message) {
  return {
    ok: false,
    source: "finance-planner-engine",
    adapterVersion: ADAPTER_VERSION,
    apiContractVersion: API_CONTRACT_VERSION_REPORTED,
    error: { code: "unsupported", message }
  };
}
function guard(fn) {
  try {
    return fn();
  } catch {
    return engineError("The engine could not price this scenario.");
  }
}
function respond(scenario, results, warnings = [], extraAssumptions = [], taxLawYear = null, tool) {
  const ignored = ignoredInputsForTool(tool, scenario);
  const response = {
    ok: true,
    source: "finance-planner-engine",
    adapterVersion: ADAPTER_VERSION,
    apiContractVersion: API_CONTRACT_VERSION_REPORTED,
    taxLawYear: taxLawYear ?? scenario.startYear,
    effectiveInputs: publicEffectiveInputs(scenario),
    assumptions: [...scenario.assumptions, ...extraAssumptions],
    warnings: [
      ...scenario.warnings,
      ...warnings,
      ...ignored.map(ignoredInputWarning)
    ],
    ignoredInputFields: ignored,
    results
  };
  return response;
}
function assumption(field, value, provenance, note) {
  return { field, value, provenance, note };
}
var HEIR_RATE_PCT = 22;
var NO_CEILINGS_CENTS = {
  bracketTopPct: null,
  irmaaTierCap: null,
  ltcgZeroCap: false,
  acaCliffCap: false,
  acaCliffCapFamilyOnly: false,
  magiCapCents: null,
  acaCliffBufferCents: null
};
var HEALTH_PREMIUM_WARNING = "Health insurance premiums are not included; only the ACA premium credit and IRMAA surcharge are priced.";
function healthPremiumWarnings(scenario) {
  if (scenario.premiumsCharged || scenario.premiumsInSpending)
    return [];
  return [HEALTH_PREMIUM_WARNING];
}
function validStrategy(raw) {
  if (raw === "constant" || raw === "percent" || raw === "guardrails" || raw === "phased") {
    return raw;
  }
  return "constant";
}
function simIncomeStreams(scenario) {
  const streams = [];
  if (scenario.ssPrimaryAnnual > 0) {
    streams.push({
      amountCents: dollarsToCents2(scenario.ssPrimaryAnnual),
      startAge: scenario.ssPrimaryStartAge ?? scenario.retirementAge
    });
  }
  if (scenario.ssSpouseAnnual > 0 && scenario.birthYearSpouse != null) {
    const startAge = scenario.ssSpouseStartAge == null ? scenario.retirementAge : scenario.ssSpouseStartAge + (scenario.birthYearSpouse - scenario.birthYearPrimary);
    streams.push({
      amountCents: dollarsToCents2(scenario.ssSpouseAnnual),
      startAge
    });
  }
  if (streams.length === 0) {
    return { schedule: [], extraIncomeCents: 0, extraIncomeStartAge: null };
  }
  const earliest = [...streams].sort((a, b) => (a.startAge ?? 0) - (b.startAge ?? 0))[0];
  return {
    schedule: streams,
    extraIncomeCents: earliest.amountCents,
    extraIncomeStartAge: earliest.startAge
  };
}
function toSimInputs(scenario, overrides) {
  const warnings = [];
  const strategy = validStrategy(scenario.strategy);
  if (strategy !== scenario.strategy) {
    warnings.push(`Unknown spending strategy "${scenario.strategy}" — priced as constant spending.`);
  }
  const income = simIncomeStreams(scenario);
  if (scenario.premiumsCharged) {
    warnings.push("Health insurance premiums were supplied but this portfolio-only simulation prices none of them — use a tax-aware tool (retirement_compare_strategies, retirement_roth_conversion, retirement_work_years or retirement_tax_year) to include them.");
  }
  const inputs = {
    startCents: scenario.portfolioCents,
    spendingCents: scenario.annualSpendingCents,
    currentAge: scenario.currentAge,
    retirementAge: overrides?.retirementAge ?? scenario.retirementAge,
    endAge: scenario.endAge,
    extraIncomeCents: income.extraIncomeCents,
    extraIncomeStartAge: income.extraIncomeStartAge,
    incomeSchedule: income.schedule.length > 0 ? income.schedule : undefined,
    minimumAnnualSpendingCents: scenario.minimumAnnualSpendingCents,
    strategy,
    percentOfPortfolio: strategy === "percent" ? 5 : 0,
    guardrailsCutPct: GUARDRAILS_CUT_DEFAULT,
    guardrailsRaisePct: GUARDRAILS_RAISE_DEFAULT,
    guardrailsAdjustmentPct: GUARDRAILS_ADJUSTMENT_DEFAULT,
    phaseStartAge: PHASE_START_AGE_DEFAULT,
    phaseDeclinePct: PHASE_DECLINE_PCT_DEFAULT
  };
  const retirementAge = overrides?.retirementAge ?? scenario.retirementAge;
  const earlyStarts = income.schedule.map((s) => s.startAge ?? retirementAge).filter((start) => start < retirementAge);
  if (earlyStarts.length > 0) {
    warnings.push("Social Security (or other fixed income) starting before retirement is not accumulated in this simulation: the benefit counts only once retired, so pre-retirement years bank nothing from it. If the benefit is already being collected while still working, use retirement_work_years, which prices those years with tax instead.");
  }
  return { inputs, warnings };
}
function flatReturns(scenario) {
  const years = horizonYears(scenario.currentAge, scenario.endAge);
  return Array.from({ length: years }, () => scenario.expectedReturnPct / 100);
}
function noBenefit(amount, startAge) {
  return amount === 0 && startAge == null;
}
function buildRothCompareBase(scenario) {
  const spouseAmount = scenario.birthYearSpouse == null ? 0 : scenario.ssSpouseAnnual;
  const spouseStartAge = scenario.birthYearSpouse == null ? null : scenario.ssSpouseStartAge;
  return {
    birthYearPrimary: scenario.birthYearPrimary,
    birthYearSpouse: scenario.birthYearSpouse,
    filingStatus: scenario.filingStatus,
    pretaxCents: dollarsToCents2(scenario.pretaxDollars),
    pretaxSpouseCents: 0,
    survivorEnabled: false,
    survivorWho: "primary",
    survivorDeathYear: null,
    rothCents: dollarsToCents2(scenario.rothDollars),
    taxableCents: dollarsToCents2(scenario.taxableDollars),
    taxableExcludeCents: null,
    hsaCents: dollarsToCents2(scenario.hsaDollars),
    taxableBasisPct: scenario.taxableBasisBlank ? null : scenario.taxableBasisPct,
    taxableTiers: null,
    taxableDividendYieldPct: scenario.taxableDividendYieldPct,
    taxableInterestYieldPct: scenario.taxableInterestYieldPct,
    yieldFallbackDividendPct: null,
    yieldFallbackInterestPct: null,
    qualifiedDividendSharePct: null,
    spendFromCashPct: null,
    flexCutPct: null,
    flexFloorPct: null,
    spendFromCashSleeveCents: null,
    annualSpendingCents: scenario.annualSpendingCents,
    retirementAge: scenario.retirementAge,
    endAge: scenario.endAge,
    expectedReturnPct: scenario.expectedReturnPct,
    stocksPct: scenario.stocksPct,
    ssPrimaryAnnualCents: dollarsToCents2(scenario.ssPrimaryAnnual),
    ssPrimaryStartAge: scenario.ssPrimaryStartAge,
    ssPrimaryNoBenefit: noBenefit(scenario.ssPrimaryAnnual, scenario.ssPrimaryStartAge),
    ssSpouseAnnualCents: dollarsToCents2(spouseAmount),
    ssSpouseStartAge: spouseStartAge,
    ssSpouseNoBenefit: noBenefit(spouseAmount, spouseStartAge),
    otherOrdinaryCents: dollarsToCents2(scenario.otherOrdinaryAnnual),
    taxExemptInterestCents: dollarsToCents2(scenario.taxExemptInterestAnnual),
    convertedAlreadyCents: 0,
    windowStartAge: scenario.retirementAge,
    windowStopAge: null,
    payTaxFrom: "taxable",
    protectMinTaxableCents: 0,
    preservePretaxCents: null,
    preserveExitRatePct: null,
    claimAgeFloor: null,
    drawOrder: "taxable-pretax-roth",
    drawOrderSwitchAge: null,
    drawOrderAfter: null,
    spouseSoleBeneficiary: scenario.filingStatus === "mfj",
    primarySoleBeneficiaryOfSpouse: null,
    acaHouseholdSize: scenario.householdSize,
    acaHouseholdSchedule: null,
    acaBenchmarkCoupleCents: scenario.acaBenchmarkCouple == null ? null : dollarsToCents2(scenario.acaBenchmarkCouple),
    acaBenchmarkSingleCents: scenario.acaBenchmarkSingle == null ? null : dollarsToCents2(scenario.acaBenchmarkSingle),
    acaBenchmarkFamilyCents: scenario.acaBenchmarkFamily == null ? null : dollarsToCents2(scenario.acaBenchmarkFamily),
    acaSpouseEndAge: null,
    healthPremiumAcaHouseholdCents: scenario.premiumsCharged && scenario.healthPremiumAcaHousehold != null ? dollarsToCents2(scenario.healthPremiumAcaHousehold) : null,
    healthPremiumAcaSingleCents: scenario.premiumsCharged && scenario.healthPremiumAcaSingle != null ? dollarsToCents2(scenario.healthPremiumAcaSingle) : null,
    healthPremiumMedicarePerPersonCents: scenario.premiumsCharged && scenario.healthPremiumMedicarePerPerson != null ? dollarsToCents2(scenario.healthPremiumMedicarePerPerson) : null,
    inflationPct: scenario.inflationPct,
    stateRatePct: scenario.stateRatePct,
    residenceState: scenario.residenceState,
    capitalLossCarryInStCents: null,
    capitalLossCarryInLtCents: null,
    capitalLossCarryInStWaCents: null,
    capitalLossCarryInLtWaCents: null,
    itemizedMortgageInterestCents: null,
    itemizedSaltPaidCents: null,
    itemizedCharitableCents: null,
    itemizedOtherCents: null,
    educationStudents: null,
    heirRatePct: HEIR_RATE_PCT,
    fafsaReportableAssetsCents: null,
    collegeFallFromYear: null,
    collegeFallThroughYear: null,
    yearlySalaryCents: scenario.salaryAnnual == null ? null : dollarsToCents2(scenario.salaryAnnual),
    employer401kCents: dollarsToCents2(scenario.employer401kAnnual),
    employerHsaCents: dollarsToCents2(scenario.employerHsaAnnual),
    ceilings: null,
    optimizerGuardrail: null,
    optimizerBunching: null,
    gainsHarvest: null
  };
}
function buildRothPlanInputs(scenario, overrides) {
  const retirementAge = overrides?.retirementAge ?? scenario.retirementAge;
  const spouseAmount = scenario.birthYearSpouse == null ? 0 : scenario.ssSpouseAnnual;
  const spouseStartAge = scenario.birthYearSpouse == null ? null : scenario.ssSpouseStartAge;
  const windowStopAge = Math.ceil(rmdAgeForBirthYear(scenario.birthYearPrimary)) - 1;
  const drawOrder = ["taxable", "pretax", "roth"];
  return {
    startYear: scenario.startYear,
    birthYearPrimary: scenario.birthYearPrimary,
    birthYearSpouse: scenario.birthYearSpouse,
    filingStatus: scenario.filingStatus,
    endAgePrimary: scenario.endAge,
    pretaxStart: scenario.pretaxDollars,
    pretaxSpouseStart: 0,
    survivorEnabled: false,
    survivorWho: "primary",
    survivorDeathYear: null,
    rothStart: scenario.rothDollars,
    taxableStart: scenario.taxableDollars,
    hsaStart: scenario.hsaDollars,
    taxableBasisPct: scenario.taxableBasisBlank ? 100 : scenario.taxableBasisPct,
    taxableBasisBlank: scenario.taxableBasisBlank,
    taxableDividendYieldPct: scenario.taxableDividendYieldPct,
    taxableInterestYieldPct: scenario.taxableInterestYieldPct,
    annualSpending: centsToDollars(scenario.annualSpendingCents),
    retirementAge,
    expectedReturnPct: scenario.expectedReturnPct,
    ssPrimaryAnnual: scenario.ssPrimaryAnnual,
    ssPrimaryStartAge: scenario.ssPrimaryStartAge,
    ssPrimaryNoBenefit: noBenefit(scenario.ssPrimaryAnnual, scenario.ssPrimaryStartAge),
    ssSpouseAnnual: spouseAmount,
    ssSpouseStartAge: spouseStartAge,
    ssSpouseNoBenefit: noBenefit(spouseAmount, spouseStartAge),
    otherOrdinaryAnnual: scenario.otherOrdinaryAnnual,
    taxExemptInterestAnnual: scenario.taxExemptInterestAnnual,
    convertedAlreadyThisYear: 0,
    windowStartAge: overrides?.windowStartAge ?? retirementAge,
    windowStopAge,
    payTaxFrom: "taxable",
    protectMinTaxable: 0,
    drawOrder,
    spouseSoleBeneficiary: scenario.filingStatus === "mfj",
    acaHouseholdSize: scenario.householdSize,
    acaHouseholdSchedule: null,
    acaBenchmarkCouple: scenario.acaBenchmarkCouple,
    acaBenchmarkSingle: scenario.acaBenchmarkSingle,
    acaBenchmarkFamily: scenario.acaBenchmarkFamily,
    healthPremiumAcaHousehold: scenario.premiumsCharged ? scenario.healthPremiumAcaHousehold : null,
    healthPremiumAcaSingle: scenario.premiumsCharged ? scenario.healthPremiumAcaSingle : null,
    healthPremiumMedicarePerPerson: scenario.premiumsCharged ? scenario.healthPremiumMedicarePerPerson : null,
    inflationPct: scenario.inflationPct,
    stateRatePct: scenario.stateRatePct,
    residenceState: scenario.residenceState,
    capitalLossCarryInSt: 0,
    capitalLossCarryInLt: 0,
    capitalLossCarryInStWa: 0,
    capitalLossCarryInLtWa: 0,
    itemizedMortgageInterest: 0,
    itemizedSaltPaid: 0,
    itemizedCharitable: 0,
    itemizedOther: 0,
    heirRatePct: HEIR_RATE_PCT,
    preservePretax: 0
  };
}
function taxAwareAssumptions(scenario) {
  const list = [
    assumption("spousePretaxDollars", 0, "assumption", "The spouse's own pre-tax balance is modeled as $0: the simple scenario carries no separate spouse pre-tax balance."),
    assumption("heirRatePct", 22, "engine_constant", "The exit rate on ending pre-tax balances (heir rate) is 22%, the engine's DEFAULT_HEIR_RATE_PCT fallback for a blank heir rate."),
    assumption("preservePretax", 0, "assumption", "No pre-tax preserve floor is modeled: the preserve amount is a guideline, not a priced floor, so conversions may draw the pre-tax balance down without a floor.")
  ];
  if (scenario.filingStatus === "mfj") {
    list.push(assumption("spouseSoleBeneficiary", true, "assumption", "The spouse is modeled as the primary's sole beneficiary, so the primary's RMD prices on the Joint and Last Survivor Table."));
  }
  return list;
}
function mapCompareScenario(s) {
  const conversionsCents = s.years.reduce((sum, y) => sum + y.conversionCents, 0);
  return {
    name: s.name,
    strategyDescription: s.strategyDescription,
    drawOrder: s.saved.drawOrder ?? DEFAULT_DRAW_ORDER_KEY,
    endingWealth: centsToDollars(s.endingAfterTaxWealthCents),
    lifetimeNetCost: centsToDollars(s.netCostCents),
    lifetimeTax: centsToDollars(s.totalTaxCents),
    lifetimeFederalTax: centsToDollars(s.federalTaxCents),
    lifetimeStateTax: centsToDollars(s.stateTaxCents),
    acaCreditKept: centsToDollars(s.acaCreditCents),
    irmaaTotal: centsToDollars(s.irmaaCents),
    lifetimeHealthPremiumGross: centsToDollars(s.healthPremiumCents),
    lifetimeHealthPremiumNet: centsToDollars(s.healthPremiumNetCents),
    endingPretax: centsToDollars(s.endingPretaxCents),
    endingTaxable: centsToDollars(s.endingTaxableCents),
    endingRoth: centsToDollars(s.endingRothCents),
    endingHsa: centsToDollars(s.endingHsaCents),
    conversionsTotal: centsToDollars(conversionsCents),
    terminalTax: centsToDollars(s.terminalCents)
  };
}
function yearlyTable(baseline) {
  const rows = baseline.years.map((y) => ({
    year: y.year,
    agePrimary: y.agePrimary,
    ageSpouse: y.ageSpouse,
    federalTax: centsToDollars(y.federalTaxCents),
    stateTax: centsToDollars(y.stateTaxCents),
    penalty: centsToDollars(y.penaltyCents),
    agi: centsToDollars(y.totalIncomeCents),
    taxableIncome: centsToDollars(y.taxableIncomeCents),
    acaCredit: centsToDollars(y.acaCreditCents),
    irmaa: centsToDollars(y.irmaaCents),
    healthPremiumGross: centsToDollars(y.healthPremiumGrossCents),
    healthPremiumNet: centsToDollars(y.healthPremiumCents),
    conversion: centsToDollars(y.conversionCents),
    pretaxOutByChoice: centsToDollars(y.pretaxOutByChoiceCents),
    settlementConverged: y.settlementConverged,
    settlementMismatchGains: centsToDollars(y.settlementMismatchCents.gains),
    settlementMismatchPretax: centsToDollars(y.settlementMismatchCents.pretax),
    ceilingBreached: y.ceilingBreached
  }));
  if (rows.length <= 60)
    return rows;
  const stride = Math.ceil(rows.length / 60);
  const picked = [];
  for (let i = 0;i < rows.length; i += stride)
    picked.push(rows[i]);
  const last = rows[rows.length - 1];
  if (picked[picked.length - 1] !== last)
    picked.push(last);
  return picked;
}
function pickWinner(items, better) {
  let best = null;
  for (const item of items) {
    if (best === null || better(item, best))
      best = item;
  }
  return best;
}
function runCompare(base, scenarios, startYear, baselineName) {
  const result = runRothCompare(base, scenarios, startYear, baselineName);
  if (!result.ok) {
    return engineError(result.reason);
  }
  const mapped = result.scenarios.map(mapCompareScenario);
  const baselineRaw = result.scenarios.find((s) => s.name === result.baselineName) ?? result.scenarios[0];
  const baseline = mapped.find((m) => m.name === result.baselineName) ?? mapped[0];
  const wealthWinner = pickWinner(mapped, (a, b) => a.endingWealth > b.endingWealth);
  const costWinner = pickWinner(mapped, (a, b) => a.lifetimeNetCost < b.lifetimeNetCost);
  return {
    ok: true,
    outcome: {
      mapped,
      baseline,
      baselineRaw,
      winnerByEndingWealth: wealthWinner ? wealthWinner.name : null,
      winnerByNetCost: costWinner ? costWinner.name : null
    }
  };
}
function deltasVsBaseline(mapped, baseline) {
  return mapped.filter((m) => m.name !== baseline.name).map((m) => ({
    name: m.name,
    endingWealthDelta: r24(m.endingWealth - baseline.endingWealth),
    netCostDelta: r24(m.lifetimeNetCost - baseline.lifetimeNetCost)
  }));
}
var NET_COST_OBJECTIVE = "Lowest lifetime net cost: lifetime federal + state tax + pre-59½ penalties + IRMAA + terminal tax on ending pre-tax, minus ACA premium credit kept and refundable education credit (plus gross health premium where a premium is entered; the adapter enters none, so $0).";
var WEALTH_OBJECTIVE = "Highest ending after-tax wealth: ending pre-tax + taxable + Roth + HSA balances, minus terminal tax on ending pre-tax.";
var OMITTED_COSTS = [
  "Health insurance premiums are not priced — only the ACA premium credit and IRMAA surcharge.",
  "This is deterministic tax-aware pricing, not a Monte Carlo retirement-success optimization: no success probability is computed here.",
  "Forced required minimum distributions come out of pre-tax first under every draw order; the order governs discretionary spending draws only."
];
var LIMITED_TIE_BREAK = "Exact ties on the deciding figure keep the earliest scenario in the evaluated list order (the engine's canonical draw-order list for withdrawals; the fixed list order for the limited Roth comparison).";
var WORK_YEARS_TIE_BREAK = "Exact ties on the deciding figure keep the earliest quit age in the evaluated list order (the sorted compareAges order).";
var OPTIMIZER_TIE_BREAK = "Exact ties follow the engine's own winner ordering (compareScoredCandidates): lowest net cost, then highest ending after-tax wealth, then Do Nothing, then the plan's own draw order, then candidate key.";
function buildComparisonScope(opts) {
  return {
    ...opts,
    globalOptimalityClaimed: false,
    netCostObjective: NET_COST_OBJECTIVE,
    wealthObjective: WEALTH_OBJECTIVE,
    omittedCosts: OMITTED_COSTS
  };
}
var DRAW_ORDER_NAMES = {
  "taxable-pretax-roth": "taxable-first",
  "taxable-roth-pretax": "taxable-roth-first",
  "pretax-taxable-roth": "pre-tax-first",
  "pretax-roth-taxable": "pre-tax-roth-first",
  "roth-taxable-pretax": "roth-first",
  "roth-pretax-taxable": "roth-pre-tax-first"
};
function optimizerCandidateDisplayName(spec) {
  const parts = [spec.name];
  if (spec.guardrail)
    parts.push("marginal-rate guardrail");
  if (spec.bunching)
    parts.push("ACA bunching");
  parts.push(spec.windowLabel);
  parts.push(`draw order ${drawOrderLabel(spec.drawOrder)}`);
  return parts.join(" · ");
}
function mapScoredCandidate(s, retirementAge) {
  const conversionsTotal = s.result.years.reduce((sum, y) => sum + y.conversion, 0);
  return {
    name: optimizerCandidateDisplayName(s.spec),
    strategyDescription: `Retire at ${retirementAge} · ${optimizerCandidateDisplayName(s.spec)}`,
    drawOrder: drawOrderKey(s.spec.drawOrder),
    candidateKey: s.spec.key,
    endingWealth: r24(s.result.endingAfterTaxWealth),
    lifetimeNetCost: r24(s.cost.netCost),
    lifetimeTax: r24(s.cost.tax),
    lifetimeFederalTax: r24(s.result.lifetimeFederalTax),
    lifetimeStateTax: r24(s.result.lifetimeStateTax),
    acaCreditKept: r24(s.cost.acaCredit),
    irmaaTotal: r24(s.cost.irmaa),
    lifetimeHealthPremiumGross: r24(s.result.lifetimeHealthPremiumGross),
    lifetimeHealthPremiumNet: r24(s.result.lifetimeHealthPremiumNet),
    endingPretax: r24(s.result.endingPretax),
    endingTaxable: r24(s.result.endingTaxable),
    endingRoth: r24(s.result.endingRoth),
    endingHsa: r24(s.result.endingHsa),
    conversionsTotal: r24(conversionsTotal),
    terminalTax: r24(s.cost.terminal)
  };
}
function yearlyConversions(s) {
  return s.result.years.filter((y) => y.conversion > 0).map((y) => ({
    year: y.year,
    agePrimary: y.agePrimary,
    conversion: r24(y.conversion)
  }));
}
function yearlyTableFromRothYears(years) {
  const rows = years.map((y) => ({
    year: y.year,
    agePrimary: y.agePrimary,
    ageSpouse: y.ageSpouse,
    federalTax: r24(y.federalTax),
    stateTax: r24(y.stateTax),
    penalty: r24(y.penalty),
    agi: r24(y.agi),
    taxableIncome: r24(y.taxableIncome),
    acaCredit: r24(y.acaCreditKept),
    irmaa: r24(y.irmaaPaid),
    healthPremiumGross: r24(y.healthPremiumGross),
    healthPremiumNet: r24(y.healthPremiumNet),
    conversion: r24(y.conversion),
    pretaxOutByChoice: r24(y.conversion + y.detail.pretaxSpendingDraw),
    settlementConverged: y.settlementConverged,
    settlementMismatchGains: centsToDollars(y.settlementMismatchCents.gains),
    settlementMismatchPretax: centsToDollars(y.settlementMismatchCents.pretax),
    ceilingBreached: y.ceilingBreached
  }));
  if (rows.length <= 60)
    return rows;
  const stride = Math.ceil(rows.length / 60);
  const picked = [];
  for (let i = 0;i < rows.length; i += stride)
    picked.push(rows[i]);
  const last = rows[rows.length - 1];
  if (picked[picked.length - 1] !== last)
    picked.push(last);
  return picked;
}
var YEARLY_TABLE_WARNING = "The per-year table uses the compare's own yearly rows, which carry tax, credit, IRMAA, health premiums, conversion, and settlement flags but not spending or per-year ending balances; lifetime ending balances are in each scenario's summary.";
var WORK_YEARS_HORIZON_WARNING = "The work-years rows price each quit age as its own plan starting at that quit age with rolled balances, so their ending balances span different horizons and are not like-for-like across quit ages; use the all-in tax and the Roth-compare scenarios for the quit-age decision.";
function calculateRetirement(scenario) {
  return guard(() => {
    const { inputs, warnings } = toSimInputs(scenario);
    const returns = flatReturns(scenario);
    const det = simulateDetailed(inputs, returns);
    const hist = runHistorical(inputs, scenario.stocksPct);
    const balances = det.balances;
    const lastBalance = balances[balances.length - 1] ?? 0;
    if (hist === null) {
      warnings.push("Historical paths are unavailable for this mix or horizon, so no historical never-out rate is reported.");
    }
    if (scenario.minimumAnnualSpendingCents != null && scenario.strategy === "constant") {
      warnings.push("Spending adequacy is measured on gross spending, and constant spending never varies — so with the floor at or below yearly spending, adequacy reads 100% even in runs where withdrawals went unfunded. Read it beside the funding rate, never instead of it.");
    }
    return respond(scenario, {
      neverRunsOut: runNeverRunsOut(inputs, returns),
      endingBalance: centsToDollars(lastBalance),
      endingAge: scenario.endAge,
      yearlyBalances: balances.map((b, i) => ({
        age: scenario.currentAge + i,
        balance: centsToDollars(b)
      })),
      yearlyGrossWithdrawals: det.grossWithdrawals.map((c, i) => ({
        age: scenario.currentAge + i,
        amount: centsToDollars(c)
      })),
      yearlyNetWithdrawals: det.netWithdrawals.map((c, i) => ({
        age: scenario.currentAge + i,
        amount: centsToDollars(c)
      })),
      strategy: inputs.strategy,
      historicalNeverOutRate: hist === null ? null : r24(hist.neverOutSuccessRate / 100),
      historicalMedianEnding: hist === null ? null : centsToDollars(hist.medianEnding),
      historicalSpendingAdequacyRate: hist === null || hist.spendingAdequacySuccessRate === null ? null : hist.spendingAdequacySuccessRate / 100,
      minimumAnnualSpending: scenario.minimumAnnualSpendingCents == null ? null : centsToDollars(scenario.minimumAnnualSpendingCents)
    }, warnings, [], null, "retirement_calculate");
  });
}
function runRetirementMonteCarlo(scenario) {
  return guard(() => {
    const { inputs, warnings } = toSimInputs(scenario);
    const mc = runMonteCarlo(inputs, scenario.expectedReturnPct / 100, scenario.volatilityPct / 100, scenario.mcSeed, scenario.mcRuns);
    if (mc === null) {
      return engineError("Monte Carlo could not price this horizon (the plan end age is at or before the current age).");
    }
    const det = simulateDetailed(inputs, flatReturns(scenario));
    const detEnding = centsToDollars(det.balances[det.balances.length - 1] ?? 0);
    const successRate = r24(mc.neverOutSuccessRate / 100);
    const detRunsOut = detEnding === 0;
    const mcMostlySucceeds = successRate >= 0.5;
    if (scenario.minimumAnnualSpendingCents != null && scenario.strategy === "constant") {
      warnings.push("Spending adequacy is measured on gross spending, and constant spending never varies — so with the floor at or below yearly spending, adequacy reads 100% even in runs where withdrawals went unfunded. Read it beside the funding rate, never instead of it.");
    }
    if (detRunsOut && mcMostlySucceeds) {
      warnings.push("Cross-check: the flat-return projection runs out, but at least half of the Monte Carlo paths do not — the flat path is one draw, not the typical outcome.");
    } else if (!detRunsOut && !mcMostlySucceeds) {
      warnings.push("Cross-check: the flat-return projection does not run out, but fewer than half of the Monte Carlo paths succeed — the flat path is more forgiving than most random paths.");
    }
    const fullChart = mc.chart.map((row) => ({
      age: row.age,
      median: r24(row.median),
      p10: r24(row.p10),
      p90: r24(row.p90)
    }));
    let chart = fullChart;
    if (fullChart.length > 41) {
      const stride = Math.ceil(fullChart.length / 41);
      const picked = [];
      for (let i = 0;i < fullChart.length; i += stride) {
        picked.push(fullChart[i]);
      }
      const last = fullChart[fullChart.length - 1];
      if (picked[picked.length - 1] !== last)
        picked.push(last);
      chart = picked;
    }
    return respond(scenario, {
      successRate,
      endingP10: centsToDollars(mc.p10),
      endingP50: centsToDollars(mc.p50),
      endingP90: centsToDollars(mc.p90),
      lowestSpending: mc.lowestSpending == null ? null : centsToDollars(mc.lowestSpending),
      averageSpending: mc.averageSpending == null ? null : centsToDollars(mc.averageSpending),
      medianFinalYearSpending: mc.medianFinalYearSpending == null ? null : centsToDollars(mc.medianFinalYearSpending),
      medianFirstRetiredYearSpending: mc.medianFirstRetiredYearSpending == null ? null : centsToDollars(mc.medianFirstRetiredYearSpending),
      spendingAdequacyRate: mc.spendingAdequacySuccessRate === null ? null : mc.spendingAdequacySuccessRate / 100,
      minimumAnnualSpending: scenario.minimumAnnualSpendingCents == null ? null : centsToDollars(scenario.minimumAnnualSpendingCents),
      runs: scenario.mcRuns,
      seed: scenario.mcSeed,
      chart,
      deterministicEndingBalance: detEnding
    }, warnings, [], null, "retirement_monte_carlo");
  });
}
function calculateMaxSpending(scenario) {
  return guard(() => {
    const { inputs, warnings } = toSimInputs(scenario);
    const expected = scenario.expectedReturnPct / 100;
    const vol = scenario.volatilityPct / 100;
    const solved = solveMaxSpending(inputs, scenario.stocksPct, expected, vol, "montecarlo", 85, scenario.mcSeed);
    if (solved === null) {
      return unsupported("No sustainable spending could be solved for these ages (retirement at/after the plan end age, or no retired years)");
    }
    if (!solved.targetAchieved) {
      warnings.push(`No spending level reaches the 85% target — even $0/yr falls short at ${(Math.round(solved.successRate * 10) / 10).toFixed(1)}% success. The reported $0 maximum is not a sustainable spending level.`);
    }
    const histSolved = solveMaxSpending(inputs, scenario.stocksPct, expected, vol, "historical", 85, scenario.mcSeed);
    const maxAnnual = centsToDollars(solved.maxSpendingCents);
    const histAnnual = histSolved === null ? null : centsToDollars(histSolved.maxSpendingCents);
    if (histAnnual !== null) {
      const relDiff = maxAnnual === 0 ? histAnnual > 0 ? Infinity : 0 : Math.abs(histAnnual - maxAnnual) / maxAnnual;
      if (relDiff > 0.2) {
        warnings.push(`Cross-check: the historical-engine maximum ($${histAnnual.toLocaleString("en-US")}/yr) differs from the Monte Carlo maximum ($${maxAnnual.toLocaleString("en-US")}/yr) by more than 20%.`);
      }
    } else {
      warnings.push("The historical engine could not solve a maximum for this mix or horizon, so no historical cross-check is reported.");
    }
    return respond(scenario, {
      maxMonthlySpending: r24(maxAnnual / 12),
      maxAnnualSpending: maxAnnual,
      successRate: r24(solved.successRate / 100),
      medianEnding: centsToDollars(solved.medianEnding),
      approximate: solved.approximate,
      runs: MONTE_CARLO_TAB_RUNS,
      historicalMaxMonthlySpending: histAnnual === null ? null : r24(histAnnual / 12),
      historicalMaxAnnualSpending: histAnnual,
      targetSuccessRate: r24(85 / 100),
      achievedSuccessRate: r24(solved.successRate / 100),
      targetAchieved: solved.targetAchieved,
      solutionStatus: solved.solutionStatus,
      historicalTargetAchieved: histSolved === null ? null : histSolved.targetAchieved,
      historicalSolutionStatus: histSolved === null ? null : histSolved.solutionStatus
    }, warnings, [
      assumption("mcRunsEffective", MONTE_CARLO_TAB_RUNS, "engine_constant", "The max-spending solver always runs the engine's fixed 1,000 Monte Carlo simulations; a supplied mcRuns is not used for this tool.")
    ], null, "retirement_max_spending");
  });
}
function compareWithdrawalStrategies(scenario) {
  return guard(() => {
    const base = buildRothCompareBase(scenario);
    const full = scenario.comparisonScope === "full";
    const orders = full ? DRAW_ORDER_OPTIONS.map((o) => ({
      name: DRAW_ORDER_NAMES[o.key] ?? o.key,
      overrides: { drawOrder: o.key }
    })) : [
      { name: "taxable-first", overrides: { drawOrder: "taxable-pretax-roth" } },
      { name: "pre-tax-first", overrides: { drawOrder: "pretax-taxable-roth" } },
      { name: "roth-first", overrides: { drawOrder: "roth-taxable-pretax" } }
    ];
    const compared = runCompare(base, orders, scenario.startYear, "taxable-first");
    if (!compared.ok)
      return compared;
    const outcome = compared.outcome;
    const scope = buildComparisonScope({
      scope: full ? "full" : "limited",
      searchKind: "fixed-comparison",
      evaluatedCandidates: outcome.mapped.length,
      candidateNames: outcome.mapped.map((m) => m.name),
      candidateSetDescription: full ? "All six permutations of the Taxable / Pre-tax / Roth spending-draw order (the engine's canonical DRAW_ORDER_OPTIONS), each priced as a fixed strategy with identical inputs." : 'The three fixed withdrawal orders this tool has always compared: taxable-first, pre-tax-first, roth-first. The other three permutations are not priced in this mode — pass comparisonScope "full" for all six.',
      baselineName: outcome.baseline.name,
      winnerByNetCost: outcome.winnerByNetCost,
      winnerByEndingWealth: outcome.winnerByEndingWealth,
      tieBreakPolicy: LIMITED_TIE_BREAK,
      excludedCandidateFamilies: full ? [
        "Mid-plan draw-order switches (a second order from a switch age) — one order applies for the whole horizon in each candidate."
      ] : [
        'The three uncompared draw-order permutations (taxable-roth-first, pre-tax-roth-first, roth-pre-tax-first) — pass comparisonScope "full" to price them.',
        "Mid-plan draw-order switches (a second order from a switch age)."
      ]
    });
    return respond(scenario, {
      baselineName: outcome.baseline.name,
      scenarios: outcome.mapped,
      winnerByEndingWealth: outcome.winnerByEndingWealth,
      winnerByNetCost: outcome.winnerByNetCost,
      deltas: deltasVsBaseline(outcome.mapped, outcome.baseline),
      yearly: yearlyTable(outcome.baselineRaw),
      comparisonScope: scope
    }, [...healthPremiumWarnings(scenario), YEARLY_TABLE_WARNING], taxAwareAssumptions(scenario), null, "retirement_compare_strategies");
  });
}
function compareRothConversions(scenario) {
  return guard(() => {
    if (scenario.comparisonScope === "full") {
      return compareRothConversionsFull(scenario);
    }
    const base = buildRothCompareBase(scenario);
    const compared = runCompare(base, [
      { name: "do-nothing", overrides: { ceilings: null } },
      {
        name: "fill-12%",
        overrides: { ceilings: { ...NO_CEILINGS_CENTS, bracketTopPct: 12 } }
      },
      {
        name: "fill-22%",
        overrides: { ceilings: { ...NO_CEILINGS_CENTS, bracketTopPct: 22 } }
      },
      {
        name: "fill-22%-irmaa-tier-1",
        overrides: {
          ceilings: { ...NO_CEILINGS_CENTS, bracketTopPct: 22, irmaaTierCap: 1 }
        }
      }
    ], scenario.startYear, "do-nothing");
    if (!compared.ok)
      return compared;
    const outcome = compared.outcome;
    const scope = buildComparisonScope({
      scope: "limited",
      searchKind: "fixed-comparison",
      evaluatedCandidates: outcome.mapped.length,
      candidateNames: outcome.mapped.map((m) => m.name),
      candidateSetDescription: `The four fixed conversion strategies this tool has always compared: Do Nothing, Fill 12%, Fill 22%, Fill 22% capped at IRMAA Tier 1, all priced at the entered claiming ages under the plan's draw order. No other ceiling, window, or draw order is priced in this mode — pass comparisonScope "full" for the engine's optimizer search.`,
      baselineName: outcome.baseline.name,
      winnerByNetCost: outcome.winnerByNetCost,
      winnerByEndingWealth: outcome.winnerByEndingWealth,
      tieBreakPolicy: LIMITED_TIE_BREAK,
      excludedCandidateFamilies: [
        'Every other conversion ceiling (other bracket tops, IRMAA tiers, ACA-cliff caps, MAGI caps) — pass comparisonScope "full" to search them.',
        'Other conversion windows (stop at 65 / through the RMD years), other draw orders, guardrail and bunching variants, gain-harvest twins — pass comparisonScope "full" to search them.',
        "Joint claiming-age combinations — claiming ages are held at the entered ages in every mode."
      ]
    });
    return respond(scenario, {
      baselineName: outcome.baseline.name,
      scenarios: outcome.mapped,
      winnerByEndingWealth: outcome.winnerByEndingWealth,
      winnerByNetCost: outcome.winnerByNetCost,
      deltas: deltasVsBaseline(outcome.mapped, outcome.baseline),
      yearly: yearlyTable(outcome.baselineRaw),
      comparisonScope: scope
    }, [...healthPremiumWarnings(scenario), YEARLY_TABLE_WARNING], taxAwareAssumptions(scenario), null, "retirement_roth_conversion");
  });
}
function compareRothConversionsFull(scenario) {
  return guard(() => {
    const planInputs = buildRothPlanInputs(scenario);
    const result = runOptimizer(planInputs);
    const winner = result.winner;
    const doNothing = result.doNothing;
    const wealthWinner = pickWinner(result.scored, (a, b) => a.result.endingAfterTaxWealth > b.result.endingAfterTaxWealth);
    const returned = [];
    const seenKeys = new Set;
    for (const s of [
      doNothing,
      winner,
      ...result.runnersUp,
      ...wealthWinner == null ? [] : [wealthWinner]
    ]) {
      if (!seenKeys.has(s.spec.key)) {
        seenKeys.add(s.spec.key);
        returned.push(s);
      }
    }
    const mapped = returned.map((s) => mapScoredCandidate(s, scenario.retirementAge));
    const baseline = mapped.find((m) => m.candidateKey === DO_NOTHING_SPEC.key);
    const winnerMapped = mapped.find((m) => m.candidateKey === winner.spec.key);
    const winnerName = winnerMapped.name;
    const wealthWinnerName = wealthWinner == null ? null : optimizerCandidateDisplayName(wealthWinner.spec);
    const harvestGate = harvestGatePasses(planInputs);
    const excludedCandidateFamilies = [
      "Joint claiming-age combinations (runJointOptimizer) — claiming ages are held at the entered ages; delaying a claim can open cheap conversion years the fixed-age search cannot see.",
      "Monte Carlo retirement-success check — this search is deterministic tax-aware pricing only, not a success-probability optimization.",
      ...harvestGate ? [] : [
        "Gain-harvest twins — the harvest gate failed for this plan (no taxable balance above $0 with basis below 100%), so harvesting is a provable no-op here."
      ]
    ];
    const candidateFamiliesEvaluated = [
      "Every federal bracket top as a conversion ceiling",
      "Every IRMAA tier ceiling, and bracket × IRMAA combinations",
      "ACA-cliff caps (alone and with the 12% / 22% brackets)",
      "MAGI-cap steps ($150,000–$500,000)",
      "Conversion windows: stop at 65, stop the year before RMDs begin, keep topping up through the RMD years",
      "All six draw orders",
      "Guardrail variants (bracket ceilings) and bunching variants (non-cliff ceilings)",
      ...harvestGate ? ["Gain-harvest twins of every conversion candidate"] : [],
      "Do Nothing as the benchmark"
    ];
    const scope = buildComparisonScope({
      scope: "full",
      searchKind: "optimizer-search",
      evaluatedCandidates: result.candidatesTested,
      candidateNames: mapped.map((m) => m.name),
      candidateSetDescription: `The engine's full optimizer search at the entered claiming ages: ${result.candidatesTested} candidates priced (bracket / IRMAA / ACA / MAGI ceilings × conversion windows × all six draw orders × guardrail / bunching variants${harvestGate ? " × gain-harvest twins" : ""}), plus the Do Nothing benchmark. The response returns the benchmark, the winner, its runners-up, and the ending-wealth winner when it is none of those; candidatesTested is the full searched count. Still not a global optimum: claiming ages are fixed (see excluded families).`,
      baselineName: baseline.name,
      winnerByNetCost: winnerName,
      winnerByEndingWealth: wealthWinnerName,
      tieBreakPolicy: OPTIMIZER_TIE_BREAK,
      excludedCandidateFamilies
    });
    const winnerConversions = yearlyConversions(winner);
    const winnerTotal = winner.result.years.reduce((sum, y) => sum + y.conversion, 0);
    return respond(scenario, {
      baselineName: baseline.name,
      scenarios: mapped,
      winnerByEndingWealth: wealthWinnerName,
      winnerByNetCost: winnerName,
      deltas: deltasVsBaseline(mapped, baseline),
      yearly: yearlyTableFromRothYears(doNothing.result.years),
      comparisonScope: scope,
      optimizer: {
        candidatesTested: result.candidatesTested,
        searchKind: "optimizer-search",
        winner: {
          name: winnerName,
          candidateKey: winner.spec.key,
          strategyDescription: winnerMapped.strategyDescription,
          drawOrder: drawOrderKey(winner.spec.drawOrder),
          windowLabel: winner.spec.windowLabel,
          windowStopAge: winner.spec.windowStopAge,
          guardrail: winner.spec.guardrail,
          bunching: winner.spec.bunching,
          gainsHarvest: winner.spec.gainsHarvest ?? false,
          claimAgePrimary: winner.claimAges.primaryAge,
          claimAgeSpouse: winner.claimAges.spouseAge,
          netCost: r24(winner.cost.netCost),
          endingWealth: r24(winner.result.endingAfterTaxWealth),
          conversionsTotal: r24(winnerTotal),
          yearlyConversions: winnerConversions
        },
        runnersUp: result.runnersUp.map((s) => ({
          name: optimizerCandidateDisplayName(s.spec),
          candidateKey: s.spec.key,
          netCost: r24(s.cost.netCost),
          endingWealth: r24(s.result.endingAfterTaxWealth),
          conversionsTotal: r24(s.result.years.reduce((sum, y) => sum + y.conversion, 0))
        })),
        doNothing: {
          netCost: r24(doNothing.cost.netCost),
          endingWealth: r24(doNothing.result.endingAfterTaxWealth)
        },
        candidateFamiliesEvaluated,
        excludedCandidateFamilies
      }
    }, [
      HEALTH_PREMIUM_WARNING,
      YEARLY_TABLE_WARNING,
      "Full optimizer search: the winner is the engine's best candidate at the entered claiming ages, not a global optimum — claiming ages were not searched (see comparisonScope.excludedCandidateFamilies). A full call can take over a minute; while it runs the server answers nothing else."
    ], taxAwareAssumptions(scenario), null, "retirement_roth_conversion");
  });
}
function compareRetirementAges(scenario) {
  return guard(() => {
    if (scenario.comparisonScope === "full") {
      return unsupported('retirement_work_years has no full comparison mode: each quit age prices one fixed strategy, and the full optimizer search runs per retirement age. Use retirement_roth_conversion with comparisonScope "full" for the optimizer search, or omit comparisonScope for the fixed quit-age comparison.');
    }
    const rawAges = scenario.compareAges.length > 0 ? scenario.compareAges : [
      scenario.retirementAge,
      scenario.retirementAge + 2,
      scenario.retirementAge + 5
    ];
    const ages = [...new Set(rawAges.map((a) => Math.round(a)))].filter((a) => Number.isFinite(a) && a < scenario.endAge).sort((a, b) => a - b);
    if (ages.length < 2) {
      return unsupported(`At least two retirement ages below the plan end age (${scenario.endAge}) are needed to compare; only ${ages.length} remain${ages.length === 1 ? ` (age ${ages[0]})` : ""}.`);
    }
    const base = buildRothCompareBase(scenario);
    const firstAge = ages[0];
    const compared = runCompare(base, ages.map((age) => ({
      name: `retire-${age}`,
      overrides: { retirementAge: age, windowStartAge: age }
    })), scenario.startYear, `retire-${firstAge}`);
    if (!compared.ok)
      return compared;
    const outcome = compared.outcome;
    const workYears = [];
    let workYearsWinnerByAllInTax = null;
    const workYearsWarnings = [];
    if (scenario.salaryAnnual != null) {
      const planInputs = buildRothPlanInputs(scenario, {
        retirementAge: firstAge,
        windowStartAge: firstAge
      });
      const job = {
        salary: scenario.salaryAnnual,
        employer401k: scenario.employer401kAnnual,
        employerHsa: scenario.employerHsaAnnual,
        medicareAgePrimary: null
      };
      const wyRows = runWorkYearsCompare(planInputs, job, ages);
      workYears.push(...wyRows.map((row) => ({
        quitAge: row.quitAge,
        workYears: row.workYears,
        workTax: r24(row.workTax),
        payrollTax: r24(row.payrollTax),
        totalTax: r24(row.totalTax),
        shortfall: r24(row.shortfall),
        allInTax: r24(row.allInTax),
        claim67AllInTax: row.claim67AllInTax == null ? null : r24(row.claim67AllInTax),
        endingNominal: r24(row.endingNominal),
        endingAfterTax: r24(row.endingAfterTax),
        winnerStrategy: row.optimizer.winner.spec.name,
        winnerClaimPrimaryAge: row.optimizer.winner.claimAges.primaryAge,
        winnerClaimSpouseAge: row.optimizer.winner.claimAges.spouseAge
      })));
      const wyWinner = pickWinner(workYears, (a, b) => a.allInTax < b.allInTax);
      workYearsWinnerByAllInTax = wyWinner ? `retire-${wyWinner.quitAge}` : null;
    } else {
      workYearsWarnings.push("Work-years detail (salary, employer 401(k)/HSA earned by working longer) is not included: no salary was provided. Pass salaryAnnual to include it.");
    }
    const withAges = outcome.mapped.map((m, i) => ({
      ...m,
      retirementAge: ages[i]
    }));
    const scope = buildComparisonScope({
      scope: "limited",
      searchKind: "fixed-comparison",
      evaluatedCandidates: withAges.length,
      candidateNames: withAges.map((m) => m.name),
      candidateSetDescription: `One fixed Do-Nothing-fill strategy per quit age (${ages.map((a) => `retire-${a}`).join(", ")}), all priced with identical inputs. Conversion strategies are not searched across quit ages here — use retirement_roth_conversion with comparisonScope "full" for that search, at one retirement age.`,
      baselineName: outcome.baseline.name,
      winnerByNetCost: outcome.winnerByNetCost,
      winnerByEndingWealth: outcome.winnerByEndingWealth,
      tieBreakPolicy: WORK_YEARS_TIE_BREAK,
      excludedCandidateFamilies: [
        "Conversion strategies beyond the entered-plan Do-Nothing fill per quit age.",
        "Joint claiming-age search in the quit-age comparison leg (the work-years leg's per-age winnerStrategy is the engine joint optimizer's pick for that quit age alone)."
      ]
    });
    return respond(scenario, {
      baselineName: outcome.baseline.name,
      scenarios: withAges,
      winnerByEndingWealth: outcome.winnerByEndingWealth,
      winnerByNetCost: outcome.winnerByNetCost,
      deltas: deltasVsBaseline(outcome.mapped, outcome.baseline),
      yearly: yearlyTable(outcome.baselineRaw),
      workYears,
      workYearsWinnerByAllInTax,
      comparisonScope: scope
    }, [
      ...healthPremiumWarnings(scenario),
      YEARLY_TABLE_WARNING,
      WORK_YEARS_HORIZON_WARNING,
      ...workYearsWarnings
    ], taxAwareAssumptions(scenario), null, "retirement_work_years");
  });
}
function calculateSingleYearTax(scenario) {
  return guard(() => {
    if (!TAX_LAW_YEARS.some((law) => law.year === scenario.taxYear)) {
      return unsupported(`The single-year price covers tax years ${TAX_LAW_YEARS.map((law) => law.year).join(", ")}; ${scenario.taxYear} is not priced.`);
    }
    const warnings = [];
    const agePrimary = scenario.currentAge + (scenario.taxYear - scenario.startYear);
    const joint = scenario.filingStatus === "mfj";
    const ageSpouse = joint && scenario.birthYearSpouse != null ? scenario.taxYear - scenario.birthYearSpouse : null;
    const ssPrimary = scenario.ssPrimaryStartAge != null && agePrimary >= scenario.ssPrimaryStartAge ? scenario.ssPrimaryAnnual : 0;
    const ssSpouse = joint && scenario.ssSpouseStartAge != null && ageSpouse != null && ageSpouse >= scenario.ssSpouseStartAge ? scenario.ssSpouseAnnual : 0;
    if (scenario.taxableDividendYieldPct != null || scenario.taxableInterestYieldPct != null) {
      warnings.push("Taxable yields are modeled in multi-year plans; this single-year price uses the typed interest/dividends only.");
    }
    const sy = scenario.singleYear;
    const fmtMoney = (n) => `$${n.toLocaleString("en-US")}`;
    const stockSold = sy.stockSold ?? 0;
    const stockBasis = stockSold > 0 ? sy.stockBasis ?? 0 : 0;
    const stockGain = stockSold - stockBasis;
    if (sy.stockSold == null) {
      warnings.push("No taxable share sale was entered for this year, so no sale is priced — cashLeftVsSpending counts no sale proceeds and no capital gain or loss.");
      if (sy.stockBasis != null && sy.stockBasis > 0) {
        warnings.push("Cost basis was entered with no sale — it has no effect; a basis prices only against a sale.");
      }
    } else if (stockSold === 0) {
      warnings.push("An explicit $0 share sale was entered — no sale is priced, no gain or loss.");
      if (sy.stockBasis != null && sy.stockBasis > 0) {
        warnings.push("Cost basis was entered with no sale — it has no effect; a basis prices only against a sale.");
      }
    } else {
      if (sy.stockBasis == null) {
        warnings.push(`No cost basis was entered for the ${fmtMoney(stockSold)} sale — basis prices at $0, so the whole proceeds price as gain. Enter stockBasisAnnual to price the actual gain.`);
      } else if (stockGain < 0) {
        warnings.push(`The sale realizes a loss of ${fmtMoney(-stockGain)} (basis above proceeds) — the engine prices it as a net capital loss: up to $3,000 offsets ordinary income this year and the rest carries forward (lossCarryOutSt / lossCarryOutLt in the result).`);
      } else if (stockGain === 0) {
        warnings.push(`The ${fmtMoney(stockSold)} sale realizes no gain or loss (basis equals proceeds) — the proceeds still count as cash in, with no capital-gains tax.`);
      }
      warnings.push(`Sale proceeds of ${fmtMoney(stockSold)} count in cashIn (cashLeftVsSpending); only the ${fmtMoney(stockGain)} gain is income — proceeds and gain are different figures.`);
      if (stockSold > scenario.taxableDollars) {
        warnings.push(`The ${fmtMoney(stockSold)} sale exceeds the typed taxable balance of ${fmtMoney(scenario.taxableDollars)} — check the sale amount; the price still counts the full proceeds.`);
      }
    }
    const priorDec31Year = scenario.taxYear - 1;
    const primaryBalance = sy.pretaxPriorYearEnd;
    const spouseBalance = sy.pretaxSpousePriorYearEnd;
    const rmdAgePrimary = rmdAgeForBirthYear(scenario.birthYearPrimary);
    const rmdAgeSpouse = joint && scenario.birthYearSpouse != null ? rmdAgeForBirthYear(scenario.birthYearSpouse) : null;
    if (primaryBalance == null && spouseBalance == null) {
      warnings.push("No prior-year pre-tax balance is carried in the single-year inputs, so no RMD is priced in this year.");
    } else {
      if (primaryBalance != null) {
        if (primaryBalance === 0) {
          warnings.push("An explicit $0 prior-Dec-31 pre-tax balance was entered for the primary — the primary's RMD is $0.");
        } else {
          warnings.push(`The primary's RMD prices from the prior-Dec-31 (Dec 31, ${priorDec31Year}) pre-tax balance of ${fmtMoney(primaryBalance)}.`);
        }
        if (agePrimary < rmdAgePrimary) {
          warnings.push(`The primary is ${agePrimary} in ${scenario.taxYear}, below RMD age ${rmdAgePrimary} for a ${scenario.birthYearPrimary} birth year — the primary's RMD is $0 this year.`);
        }
      } else {
        warnings.push("No prior-Dec-31 pre-tax balance was entered for the primary — the primary's RMD is $0; only a spouse balance was entered.");
      }
      if (spouseBalance != null) {
        if (!joint) {
          warnings.push("A spouse prior-Dec-31 balance was entered on a non-joint return — the engine ignores it: no spouse RMD is priced.");
        } else if (spouseBalance === 0) {
          warnings.push("An explicit $0 prior-Dec-31 pre-tax balance was entered for the spouse — the spouse's RMD is $0.");
        } else {
          warnings.push(`The spouse's RMD prices from the spouse's own prior-Dec-31 (Dec 31, ${priorDec31Year}) pre-tax balance of ${fmtMoney(spouseBalance)}, on the spouse's own age clock.`);
          if (ageSpouse != null && rmdAgeSpouse != null && ageSpouse < rmdAgeSpouse) {
            warnings.push(`The spouse is ${ageSpouse} in ${scenario.taxYear}, below RMD age ${rmdAgeSpouse} for a ${scenario.birthYearSpouse} birth year — the spouse's RMD is $0 this year.`);
          }
          if (sy.primarySoleBeneficiaryOfSpouse === true) {
            warnings.push("The primary is the spouse's sole beneficiary (primarySoleBeneficiaryOfSpouse) — the spouse's RMD uses the Joint and Last Survivor Table when the primary is more than 10 years younger, otherwise the Uniform Lifetime Table.");
          } else if (sy.primarySoleBeneficiaryOfSpouse === false) {
            warnings.push("The primary is not the spouse's sole beneficiary — the spouse's RMD prices on the Uniform Lifetime Table.");
          } else {
            warnings.push("Whether the primary is the spouse's sole beneficiary was not established — the spouse's RMD prices on the Uniform Lifetime Table (the conservative direction).");
          }
        }
      }
    }
    const rmdAlreadyReceived = sy.rmdAlreadyReceived ?? 0;
    if (rmdAlreadyReceived > 0) {
      if (primaryBalance == null && spouseBalance == null) {
        warnings.push("An RMD already received was entered, but no prior-Dec-31 balance was entered — there is no computed RMD to net it against, so it has no effect on this price.");
      } else {
        warnings.push(`${fmtMoney(rmdAlreadyReceived)} of this year's RMD was already received and already counted in the entered income — the engine nets it out of the RMD it adds (floored at $0), so it is not counted twice.`);
      }
    }
    const benchmarkAnnual = scenario.filingStatus === "single" ? scenario.acaBenchmarkSingle : scenario.householdSize >= 3 ? scenario.acaBenchmarkFamily ?? scenario.acaBenchmarkCouple : scenario.acaBenchmarkCouple;
    const primaryOnAca = agePrimary < 65;
    const spouseOnAca = joint && ageSpouse != null && ageSpouse < 65;
    const anyOnAca = primaryOnAca || spouseOnAca;
    const bothOnAca = primaryOnAca && spouseOnAca;
    const benchmarkForPremium = bothOnAca ? scenario.householdSize >= 3 && scenario.acaBenchmarkFamily != null ? scenario.acaBenchmarkFamily : scenario.acaBenchmarkCouple : anyOnAca ? scenario.acaBenchmarkSingle : null;
    const healthPremiumAcaAnnual = !scenario.premiumsCharged || !anyOnAca ? null : (bothOnAca ? scenario.healthPremiumAcaHousehold : scenario.healthPremiumAcaSingle) ?? benchmarkForPremium;
    const healthPremiumMedicarePerPerson = scenario.premiumsCharged ? scenario.healthPremiumMedicarePerPerson : null;
    const inputs = {
      taxYear: scenario.taxYear,
      filingStatus: scenario.filingStatus,
      agePrimary,
      ageSpouse,
      onMedicarePrimary: agePrimary >= 65,
      onMedicareSpouse: ageSpouse != null && ageSpouse >= 65,
      interest: scenario.singleYear.interest,
      ordinaryDividends: scenario.singleYear.ordinaryDividends,
      otherOrdinary: scenario.otherOrdinaryAnnual,
      taxExemptInterest: scenario.taxExemptInterestAnnual,
      ssPrimary,
      ssSpouse,
      conversion: scenario.singleYear.conversion,
      spendingDraw: scenario.singleYear.spendingDraw,
      cashDraw: scenario.singleYear.cashDraw,
      rothDraw: scenario.singleYear.rothDraw,
      inflationPct: scenario.inflationPct,
      stockSold,
      stockBasis,
      qualifiedDividends: scenario.singleYear.qualifiedDividends,
      pretaxBalance: primaryBalance,
      pretaxBalanceSpouse: spouseBalance,
      rmdAlreadyReceived,
      primarySoleBeneficiaryOfSpouse: sy.primarySoleBeneficiaryOfSpouse,
      spouseSoleBeneficiary: joint,
      acaHouseholdSize: scenario.householdSize,
      acaBenchmarkAnnual: benchmarkAnnual,
      healthPremiumAcaAnnual,
      healthPremiumMedicarePerPerson,
      stateRatePct: scenario.stateRatePct,
      residenceState: scenario.residenceState,
      annualSpending: centsToDollars(scenario.annualSpendingCents)
    };
    warnings.push(...healthPremiumWarnings(scenario));
    const priced = pricePlaygroundYear(inputs);
    if (priced.rmd > 0 && (scenario.singleYear.spendingDraw > 0 || scenario.singleYear.conversion > 0)) {
      const parts = [];
      if (scenario.singleYear.spendingDraw > 0)
        parts.push("spending draw");
      if (scenario.singleYear.conversion > 0)
        parts.push("conversion");
      warnings.push(`The RMD (${fmtMoney(priced.rmd)}) is priced as income in addition to the typed ${parts.join(" and ")} — if that draw already includes part of the RMD, pass the included amount as rmdAlreadyReceivedAnnual so it is not counted twice.`);
    }
    if (rmdAlreadyReceived > priced.rmdGross) {
      warnings.push(`rmdAlreadyReceivedAnnual (${fmtMoney(rmdAlreadyReceived)}) exceeds the computed RMD (${fmtMoney(priced.rmdGross)}) — only ${fmtMoney(priced.rmdGross)} is netted; the excess has no effect.`);
    }
    const extraAssumptions = joint ? [
      assumption("spouseSoleBeneficiary", true, "assumption", "The spouse is modeled as the primary's sole beneficiary, so the primary's RMD prices on the Joint and Last Survivor Table."),
      ...sy.primarySoleBeneficiaryOfSpouse == null ? [] : [
        assumption("primarySoleBeneficiaryOfSpouse", sy.primarySoleBeneficiaryOfSpouse, "user", sy.primarySoleBeneficiaryOfSpouse === true ? "The primary is the spouse's sole beneficiary, so the spouse's RMD uses the Joint and Last Survivor Table when the primary is more than 10 years younger, otherwise the Uniform Lifetime Table." : "The primary is not the spouse's sole beneficiary, so the spouse's RMD prices on the Uniform Lifetime Table.")
      ]
    ] : [];
    return respond(scenario, roundDeep(priced), warnings, extraAssumptions, scenario.taxYear, "retirement_tax_year");
  });
}

var MONEY = { type: "number", minimum: 0, maximum: 1e8 };
var PCT = { type: "number", minimum: 0, maximum: 100 };
var AGE = { type: "integer", minimum: 18, maximum: 120 };
var LAW_YEARS_PROSE = TAX_LAW_YEARS.map((law) => law.year).join(" or ");
var FIRST_LAW_YEAR = Math.min(...TAX_LAW_YEARS.map((law) => law.year));
var BASE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    pretax: {
      ...MONEY,
      description: "Pre-tax balance (traditional IRA / 401(k)) in dollars. Required."
    },
    taxable: {
      ...MONEY,
      description: "Taxable brokerage balance in dollars. Required."
    },
    roth: {
      ...MONEY,
      description: "Roth IRA / Roth 401(k) balance in dollars. Required."
    },
    hsa: {
      ...MONEY,
      description: "Health savings account balance in dollars. Required."
    },
    monthlySpending: {
      type: "number",
      exclusiveMinimum: 0,
      maximum: 200000,
      description: "Planned spending per month in dollars (e.g. 9500 = $9,500/mo). Required."
    },
    currentAge: {
      ...AGE,
      description: "Current age of the primary person, in whole years. Required."
    },
    retirementAge: {
      ...AGE,
      description: "Age at which work income stops. Defaults to your current age (retire now)."
    },
    endAge: {
      ...AGE,
      description: "Last age the projection runs through. Defaults to 95; must be after retirementAge and no more than 120."
    },
    spouseAge: {
      ...AGE,
      description: "Current age of the spouse, in whole years, if any."
    },
    filingStatus: {
      type: "string",
      enum: ["mfj", "single", "hoh"],
      description: "Federal tax filing status: mfj (married filing jointly), single, or hoh (head of household)."
    },
    householdSize: {
      type: "integer",
      minimum: 1,
      maximum: 20,
      description: "Number of people in the household (drives ACA benchmarks)."
    },
    stocksPct: {
      ...PCT,
      description: "Portfolio allocation to stocks, as a percent (e.g. 60 = 60%)."
    },
    expectedRealReturnPct: {
      type: "number",
      minimum: -50,
      maximum: 50,
      description: "Expected real portfolio return, as a percent per year (e.g. 5 = 5%). Defaults to the engine's flat factory default of 5% when omitted; an explicit value (including 0% and negative) is used as given."
    },
    volatilityPct: {
      ...PCT,
      description: "Annual portfolio volatility (standard deviation), as a percent."
    },
    strategy: {
      type: "string",
      enum: ["constant", "guardrails", "phased", "percent"],
      description: "Spending strategy: constant (same real spending every year), guardrails (spending cuts 10% when the year's spending rate tops 120% of the starting rate, rises 10% when it falls below 80%, at most one adjustment a year), phased (spending stays flat until age 75, then steps down 1% a year), or percent (5% of the start-of-year balance each year). Defaults to constant."
    },
    minimumAnnualSpending: {
      ...MONEY,
      description: "Optional minimum annual spending in dollars per year. Adds a spending-adequacy rate: the share of runs in which every retired year's gross spending stayed at or above that floor — reported beside the funding rate, never instead of it, because a high funding rate is not proof spending held the floor. Omit or 0 for no floor."
    },
    socialSecurityAnnual: {
      ...MONEY,
      description: "Primary person's Social Security benefit in dollars per year at socialSecurityStartAge."
    },
    socialSecurityStartAge: {
      ...AGE,
      description: "Age the primary person starts Social Security."
    },
    spouseSocialSecurityAnnual: {
      ...MONEY,
      description: "Spouse's Social Security benefit in dollars per year at spouseSocialSecurityStartAge."
    },
    spouseSocialSecurityStartAge: {
      ...AGE,
      description: "Age the spouse starts Social Security."
    },
    taxableBasisPct: {
      ...PCT,
      description: "Cost basis of the taxable account as a percent of its balance (e.g. 72 = 72% basis, so 28% is taxable gain when sold)."
    },
    taxableDividendYieldPct: {
      ...PCT,
      description: "Taxable account dividend yield, as a percent per year."
    },
    taxableInterestYieldPct: {
      ...PCT,
      description: "Taxable account interest yield, as a percent per year."
    },
    otherOrdinaryAnnual: {
      ...MONEY,
      description: "Other ordinary income per year in dollars."
    },
    taxExemptInterestAnnual: {
      ...MONEY,
      description: "Tax-exempt interest per year in dollars."
    },
    acaBenchmarkCouple: {
      ...MONEY,
      description: "ACA benchmark (second-lowest Silver) premium per year in dollars for a two-person household."
    },
    acaBenchmarkSingle: {
      ...MONEY,
      description: "ACA benchmark premium per year in dollars for a one-person household."
    },
    acaBenchmarkFamily: {
      ...MONEY,
      description: "ACA benchmark premium per year in dollars for a family household."
    },
    healthPremiumAcaHouseholdAnnual: {
      ...MONEY,
      description: "Marketplace health premium per year in dollars for a year when both spouses are on the marketplace — the plan actually enrolled in. Priced only by the tax-aware tools."
    },
    healthPremiumAcaSingleAnnual: {
      ...MONEY,
      description: "Marketplace health premium per year in dollars for a year when exactly one spouse is on the marketplace — the plan actually enrolled in. Priced only by the tax-aware tools."
    },
    healthPremiumMedicarePerPersonAnnual: {
      ...MONEY,
      description: "Medicare base premium per person on Medicare, dollars per year (Part B standard + Part D base, excluding the IRMAA surcharge, which the engine prices separately). Priced only by the tax-aware tools."
    },
    spendingIncludesHealthPremiums: {
      type: "boolean",
      description: "Whether monthlySpending already includes health insurance premiums. REQUIRED when any health premium field is given: true means the premiums are inside monthlySpending and are not charged again; false means monthlySpending excludes them and the premium is funded on top of spending."
    },
    stateRatePct: {
      type: "number",
      minimum: 0,
      maximum: 50,
      description: "Flat state income-tax rate, as a percent."
    },
    state: {
      type: "string",
      description: "State of residence: a 2-letter code (WA) or full name (Washington). Anything other than WA is priced with the flat stateRatePct (default 0)."
    },
    taxYear: {
      type: "integer",
      minimum: FIRST_LAW_YEAR,
      maximum: latestTaxLawYear(),
      description: `Tax law year to price under (one of the published law years: ${LAW_YEARS_PROSE}).`
    },
    salaryAnnual: {
      ...MONEY,
      description: "Gross salary per year in dollars while still working (used by the work-years comparison for pre-retirement years)."
    },
    employer401kAnnual: {
      ...MONEY,
      description: "Employer 401(k) contribution per year in dollars."
    },
    employerHsaAnnual: {
      ...MONEY,
      description: "Employer HSA contribution per year in dollars."
    },
    interestAnnual: {
      ...MONEY,
      description: "Taxable interest for the single-year tax calculation, in dollars."
    },
    ordinaryDividendsAnnual: {
      ...MONEY,
      description: "Total ordinary dividends for the single-year tax calculation, in dollars — the 1099-DIV Box 1a total, including the qualified portion."
    },
    qualifiedDividendsAnnual: {
      ...MONEY,
      description: "Qualified dividends for the single-year tax calculation, in dollars — the qualified portion (1099-DIV Box 1b) of total ordinary dividends. Must not exceed ordinaryDividendsAnnual; a call with qualified above ordinary is rejected as invalid input naming both fields."
    },
    conversionAnnual: {
      ...MONEY,
      description: "Roth conversion amount for the single-year tax calculation, in dollars."
    },
    spendingDrawAnnual: {
      ...MONEY,
      description: "Draw for spending for the single-year tax calculation, in dollars."
    },
    cashDrawAnnual: {
      ...MONEY,
      description: "Draw from cash for the single-year tax calculation, in dollars."
    },
    rothDrawAnnual: {
      ...MONEY,
      description: "Draw from Roth for the single-year tax calculation, in dollars."
    },
    stockSoldAnnual: {
      ...MONEY,
      description: "Taxable shares sold in the single-year tax year, in dollars of proceeds. The realized gain (proceeds minus stockBasisAnnual) prices on the capital-gains stack; the full proceeds count as cash in. A basis above the proceeds is a realized loss (up to $3,000 offsets ordinary income, the rest carries forward). Omitted means no sale is priced; explicit 0 means a $0 sale."
    },
    stockBasisAnnual: {
      ...MONEY,
      description: "Cost basis of the shares sold (stockSoldAnnual), in dollars. Only prices against a sale — a basis with no sale has no effect. Omitted with a sale means basis $0 (the whole proceeds price as gain)."
    },
    pretaxPriorYearEndAnnual: {
      ...MONEY,
      description: "Primary person's pre-tax balance at December 31 of the year BEFORE the priced tax year, in dollars. The RMD for the priced year prices from this balance and the owner's age. Omitted means no RMD is priced from the primary's balance; explicit 0 means a $0 RMD. Never today's balance — the Dec-31 date matters."
    },
    pretaxSpousePriorYearEndAnnual: {
      ...MONEY,
      description: "Spouse's own pre-tax balance at December 31 of the year BEFORE the priced tax year, in dollars. The spouse's RMD prices from this balance on the spouse's own age clock. Omitted means no spouse RMD is priced; explicit 0 means a $0 spouse RMD. Only counts on a joint (mfj) return."
    },
    rmdAlreadyReceivedAnnual: {
      ...MONEY,
      description: "Part of this year's computed RMD already received AND already counted in the entered income, in dollars. The engine nets it out of the RMD it adds (floored at $0), so a paid RMD is never counted twice. Omitted means $0."
    },
    primarySoleBeneficiaryOfSpouse: {
      type: "boolean",
      description: "Is the primary person the sole beneficiary of the spouse's pre-tax accounts? Gates ONLY the spouse's RMD table: true lets the spouse's RMD use the Joint and Last Survivor Table when the primary is more than 10 years younger, otherwise the Uniform Lifetime Table. Absent means not established — the spouse's RMD prices on the Uniform table (the conservative direction). This is a separate fact from the spouse being the primary's sole beneficiary; one never implies the other."
    },
    mcSeed: {
      type: "integer",
      description: "Random seed for the Monte Carlo run, for reproducibility."
    },
    mcRuns: {
      type: "integer",
      minimum: 10,
      maximum: 5000,
      description: "Number of Monte Carlo simulations (capped at 5000)."
    },
    compareAges: {
      type: "array",
      items: { type: "integer", minimum: 18, maximum: 120 },
      minItems: 2,
      maxItems: 5,
      description: "Retirement ages to compare (e.g. [59, 61, 64] — the retirement age plus two later ages)."
    },
    comparisonScope: {
      type: "string",
      enum: ["limited", "full"],
      description: `Which candidate set a comparison tool evaluates. "limited" (default) is the fixed small comparison: 3 withdrawal orders for retirement_compare_strategies, 4 conversion strategies for retirement_roth_conversion. "full" prices the engine's whole candidate space: all six withdrawal orders, or the full Roth optimizer search (thousands of candidates, can take over a minute — never silently downgraded to limited). retirement_work_years has no full mode: "full" there is an unsupported error.`
    }
  },
  required: ["pretax", "taxable", "roth", "hsa", "monthlySpending", "currentAge"],
  additionalProperties: false
};
var EMPTY_INPUT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false
};
function normalized(args, fn) {
  const n = normalizeInputs(args);
  if (!n.ok)
    return n.error;
  return fn(n.scenario);
}
var REQUIRED_INPUTS_GLOBAL2 = [
  "pretax",
  "taxable",
  "roth",
  "hsa",
  "monthlySpending",
  "currentAge"
];
var EXAMPLE_BASE = {
  pretax: 1250000,
  taxable: 2100000,
  roth: 375000,
  hsa: 62000,
  monthlySpending: 9500,
  currentAge: 54,
  spouseAge: 52
};
var EXAMPLE_CALCULATE = {
  ...EXAMPLE_BASE,
  retirementAge: 59,
  endAge: 95,
  socialSecurityAnnual: 36000,
  socialSecurityStartAge: 67
};
var EXAMPLE_MONTE_CARLO = {
  ...EXAMPLE_CALCULATE,
  mcRuns: 1000,
  mcSeed: 42
};
var EXAMPLE_MAX_SPENDING = {
  ...EXAMPLE_CALCULATE,
  mcSeed: 42
};
var EXAMPLE_COMPARE_STRATEGIES = EXAMPLE_CALCULATE;
var EXAMPLE_ROTH = EXAMPLE_CALCULATE;
var EXAMPLE_WORK_YEARS = {
  ...EXAMPLE_BASE,
  retirementAge: 59,
  compareAges: [59, 61, 64],
  salaryAnnual: 120000,
  employer401kAnnual: 5000,
  employerHsaAnnual: 1000
};
var EXAMPLE_TAX_YEAR = {
  ...EXAMPLE_CALCULATE,
  taxYear: 2026,
  interestAnnual: 1000,
  ordinaryDividendsAnnual: 5000,
  qualifiedDividendsAnnual: 3000,
  conversionAnnual: 20000,
  spendingDrawAnnual: 114000,
  cashDrawAnnual: 0,
  rothDrawAnnual: 0,
  stockSoldAnnual: 20000,
  stockBasisAnnual: 12000
};
var TOOLS = [
  {
    name: "retirement_calculate",
    description: `Use when the user asks whether they can retire now, or when they can afford to retire. ` + `Required: pretax, taxable, roth, hsa (account balances in dollars; 0 is fine), monthlySpending (dollars per month), currentAge (whole years). ` + `Optional: retirementAge (defaults to your current age — retire now), endAge (default 95), spouseAge, Social Security amounts and start ages (default none; both spouses' benefits are priced, each starting in its own claiming year), and portfolio assumptions expectedRealReturnPct, stocksPct and strategy (defaults from the engine). Optional minimumAnnualSpending (dollars per year) adds a spending-adequacy rate: the share of historical runs in which every retired year's gross spending stayed at or above that floor — reported beside the funding rate, never instead of it, because a high funding rate is not proof spending held the floor. Tax inputs (filing status, taxable basis, yields, ACA benchmarks, state rate) and taxYear do not change this answer — the simulation prices no tax. Health insurance premiums are not priced here either — use a tax-aware tool (retirement_compare_strategies, retirement_roth_conversion, retirement_work_years or retirement_tax_year) to include them. mcRuns, mcSeed and volatilityPct do not change it either — there is no Monte Carlo leg here; the historical cross-check is deterministic. ` + `Example call: ${JSON.stringify(EXAMPLE_CALCULATE)}. ` + `Returns: whether the money lasts (neverRunsOut), the ending balance, and a year-by-year balance table, plus the historical cross-check of the same plan.`,
    inputSchema: BASE_INPUT_SCHEMA,
    handler: (args) => normalized(args, calculateRetirement)
  },
  {
    name: "retirement_monte_carlo",
    description: `Use when the user asks how likely their retirement plan is to succeed, or wants a probability instead of a single yes/no answer. ` + `Required: the same six as retirement_calculate — pretax, taxable, roth, hsa (dollars; 0 is fine), monthlySpending (dollars per month), currentAge (whole years). ` + `Optional: retirementAge (defaults to your current age — retire now), endAge (default 95), Social Security amounts and start ages (default none; both spouses' benefits are priced, each starting in its own claiming year), portfolio assumptions such as expectedRealReturnPct, volatilityPct, stocksPct and strategy (defaults from the engine), plus mcRuns (number of simulations, up to 5000) and mcSeed (random seed; set it to reproduce the exact same run). Optional minimumAnnualSpending (dollars per year) adds a spending-adequacy rate: the share of simulations in which every retired year's gross spending stayed at or above that floor — reported beside the success rate, never instead of it, because a high funding-success rate is not proof the household can maintain its desired spending (a percent-of-portfolio plan can fund every year while its spending collapses). Tax inputs (filing status, taxable basis, yields, ACA benchmarks, state rate) and taxYear do not change this answer — the simulation prices no tax. Health insurance premiums are not priced here either — use a tax-aware tool (retirement_compare_strategies, retirement_roth_conversion, retirement_work_years or retirement_tax_year) to include them. ` + `Example call: ${JSON.stringify(EXAMPLE_MONTE_CARLO)}. ` + `Returns: the success probability — the share of simulations in which the money lasts to the end age — with the distribution of outcomes across the simulations.`,
    inputSchema: BASE_INPUT_SCHEMA,
    handler: (args) => normalized(args, runRetirementMonteCarlo)
  },
  {
    name: "retirement_max_spending",
    description: `Use when the user asks how much they can spend per month in retirement, or what the highest sustainable spending level is. ` + `Required: the same six as retirement_calculate — pretax, taxable, roth, hsa (dollars; 0 is fine), monthlySpending (dollars per month), currentAge (whole years). monthlySpending is still required: give current spending (e.g. 9500) as the starting point; the tool reports the highest sustainable level, which may differ. ` + `Optional: retirementAge (defaults to your current age — retire now), endAge (default 95), Social Security amounts and start ages (default none; both spouses' benefits are priced, each starting in its own claiming year), portfolio assumptions such as expectedRealReturnPct, volatilityPct, stocksPct and strategy (defaults from the engine), plus mcSeed for the Monte Carlo check (random seed; set it to reproduce the exact same run). The solver always runs the engine's fixed 1,000 simulations, so a supplied mcRuns is not used for this tool. A supplied minimumAnnualSpending does not change this answer — the solver scores funding success only and reports no adequacy rate. Tax inputs (filing status, taxable basis, yields, ACA benchmarks, state rate) and taxYear do not change this answer — the simulation prices no tax. Health insurance premiums are not priced here either — use a tax-aware tool (retirement_compare_strategies, retirement_roth_conversion, retirement_work_years or retirement_tax_year) to include them. ` + `Example call: ${JSON.stringify(EXAMPLE_MAX_SPENDING)}. ` + `Returns: the maximum sustainable monthly spending in dollars at 85% Monte Carlo success over 1,000 simulations, with a historical cross-check of that spending level. ` + `The response also reports the feasibility of that maximum: targetSuccessRate (0.85), achievedSuccessRate (the success rate actually achieved, 0–1), targetAchieved (whether the returned spending meets the 85% target), and solutionStatus — "feasible" (a positive spending meets the target), "feasible_at_zero" ($0/yr is the highest sustainable spending), "infeasible_at_zero" (no spending level reaches the target, even $0/yr — the reported $0 is NOT a sustainable spending), or "capped" (the figure is the solver's search cap, not a proven maximum above it; the percent strategy's 30%-of-portfolio cap always binds). Never describe a $0 maximum as meeting the target unless solutionStatus is "feasible_at_zero" and targetAchieved is true.`,
    inputSchema: BASE_INPUT_SCHEMA,
    handler: (args) => normalized(args, calculateMaxSpending)
  },
  {
    name: "retirement_compare_strategies",
    description: `Use when the user asks which account to spend from first, or how the withdrawal order changes their taxes and outcome. ` + `Required: the same six as retirement_calculate — pretax, taxable, roth, hsa (dollars; 0 is fine), monthlySpending (dollars per month), currentAge (whole years). ` + `Optional: retirementAge (defaults to your current age — retire now), endAge (default 95), Social Security amounts and start ages (default none), tax inputs (taxable basis, yields, ACA benchmarks, state rate — all optional), health premium amounts (healthPremiumAcaHouseholdAnnual, healthPremiumAcaSingleAnnual, healthPremiumMedicarePerPersonAnnual — annual dollars; supplying any of them requires spendingIncludesHealthPremiums, which states whether monthlySpending already includes the premiums), and portfolio assumptions expectedRealReturnPct and stocksPct (defaults from the engine). Spending strategy and volatility do not change this comparison — it is deterministic and tax-aware, not simulated. taxYear does not change it either — the march starts in the current year and prices each year under that year's tables. minimumAnnualSpending does not change it either — the floor is a retirement-simulation input; this comparison prices no simulation. ` + `There is no strategy input: by default the tool compares three withdrawal orders — taxable-first, pre-tax-first, roth-first — and reports each one, so do not pass a withdrawal order. Pass comparisonScope "full" to compare all six permutations of the Taxable / Pre-tax / Roth order instead (same inputs, same baseline taxable-first); the response's comparisonScope block names the evaluated set, both winners (lowest lifetime net cost and highest ending after-tax wealth — different objectives, often different winners), and the tie rule. No comparison here claims a global optimum. ` + `Example call: ${JSON.stringify(EXAMPLE_COMPARE_STRATEGIES)}. ` + `Returns: a tax-aware comparison of the withdrawal orders (three by default, six with comparisonScope "full"), with taxes, ACA credit, IRMAA, lifetime health premiums (gross and net, when premium fields are supplied) and ending wealth for each, so the user can see which order leaves the most.`,
    inputSchema: BASE_INPUT_SCHEMA,
    handler: (args) => normalized(args, compareWithdrawalStrategies)
  },
  {
    name: "retirement_roth_conversion",
    description: `Use when the user asks whether to convert pre-tax money to Roth, how much to convert, or whether conversions are worth the tax. ` + `Required: the same six as retirement_calculate — pretax, taxable, roth, hsa (dollars; 0 is fine), monthlySpending (dollars per month), currentAge (whole years). ` + `Optional: retirementAge (defaults to your current age — retire now), endAge (default 95), Social Security amounts and start ages (default none), tax inputs (taxable basis, yields, ACA benchmarks, state rate — all optional), health premium amounts (healthPremiumAcaHouseholdAnnual, healthPremiumAcaSingleAnnual, healthPremiumMedicarePerPersonAnnual — annual dollars; supplying any of them requires spendingIncludesHealthPremiums, which states whether monthlySpending already includes the premiums), and portfolio assumptions expectedRealReturnPct and stocksPct (defaults from the engine). Spending strategy and volatility do not change this comparison — it is deterministic and tax-aware, not simulated. taxYear does not change it either — the march starts in the current year and prices each year under that year's tables. minimumAnnualSpending does not change it either — the floor is a retirement-simulation input; this comparison prices no simulation. ` + `By default the tool compares four conversion strategies — Do Nothing vs Fill 12% vs Fill 22% vs Fill 22% capped at IRMAA Tier 1 — and the winner is only the best of those four, never a global optimum. Pass comparisonScope "full" to run the engine's full Roth optimizer search instead: thousands of candidates (every bracket / IRMAA / ACA-cliff / MAGI ceiling × conversion window × all six draw orders × guardrail / bunching / gain-harvest variants) at the entered claiming ages, with the Do Nothing benchmark, the winning candidate's actual conversion policy and yearly conversion amounts, and the total candidates evaluated. A full call can take over a minute and is never silently downgraded to the four-strategy comparison. Even the full search is not a global optimum — claiming ages are held at the entered ages. The response's comparisonScope block names the evaluated set, both winners (lowest lifetime net cost and highest ending after-tax wealth — different objectives, often different winners), and what was intentionally excluded. ` + `Example call: ${JSON.stringify(EXAMPLE_ROTH)}. ` + `Returns: a tax-aware comparison of conversion strategies — the four fixed fills by default, or the full optimizer search with comparisonScope "full" — with federal tax, ACA credit, IRMAA, lifetime health premiums (gross and net, when premium fields are supplied) and ending wealth for each returned candidate.`,
    inputSchema: BASE_INPUT_SCHEMA,
    handler: (args) => normalized(args, compareRothConversions)
  },
  {
    name: "retirement_work_years",
    description: `Use when the user asks whether working a few more years is worth it, or what changes if they retire later. ` + `Required: the same six as retirement_calculate — pretax, taxable, roth, hsa (dollars; 0 is fine), monthlySpending (dollars per month), currentAge (whole years). ` + `Optional: retirementAge (defaults to your current age — retire now), compareAges (a list of retirement ages to compare; default is the retirement age, plus two and plus five years), endAge (default 95), Social Security amounts and start ages (default none), tax inputs (taxable basis, yields, ACA benchmarks, state rate — all optional), health premium amounts (healthPremiumAcaHouseholdAnnual, healthPremiumAcaSingleAnnual, healthPremiumMedicarePerPersonAnnual — annual dollars; supplying any of them requires spendingIncludesHealthPremiums, which states whether monthlySpending already includes the premiums), and portfolio assumptions expectedRealReturnPct and stocksPct (defaults from the engine). Spending strategy and volatility do not change this comparison — it is deterministic and tax-aware, not simulated. taxYear does not change it either — the march starts in the current year and prices each year under that year's tables. minimumAnnualSpending does not change it either — the floor is a retirement-simulation input; this comparison prices no simulation. ` + `Pass salaryAnnual (plus employer401kAnnual and employerHsaAnnual) to price the earned-income leg: each quit age then also reports work years, payroll tax and the optimizer's best strategy and claim ages. Without a salary the earned-income leg is omitted and the response carries a warning instead. A work-years call can take a minute or more, and while it runs the server answers nothing else. comparisonScope "full" is not supported for this tool — each quit age prices one fixed strategy, and the full optimizer search runs per retirement age (see retirement_roth_conversion); passing "full" here returns an unsupported error, not a quiet limited comparison. ` + `Example call: ${JSON.stringify(EXAMPLE_WORK_YEARS)}. ` + `Returns: a tax-aware comparison of retiring at each age in compareAges, with taxes and ending wealth for each age, plus — when a salary is given — the earned-income comparison (work years, payroll tax, all-in tax) for each age.`,
    inputSchema: BASE_INPUT_SCHEMA,
    handler: (args) => normalized(args, compareRetirementAges)
  },
  {
    name: "retirement_tax_year",
    description: `Use when the user asks what their tax bill will be for one specific year, or how much a Roth conversion or a draw costs in tax that year. ` + `Required: the same six as retirement_calculate — pretax, taxable, roth, hsa (dollars; 0 is fine), monthlySpending (dollars per month), currentAge (whole years). ` + `Optional: taxYear (${LAW_YEARS_PROSE}; default ${latestTaxLawYear()}), single-year amounts for that one year (interestAnnual, ordinaryDividendsAnnual, qualifiedDividendsAnnual, conversionAnnual, spendingDrawAnnual, cashDrawAnnual, rothDrawAnnual — all in dollars), plus filingStatus, householdSize, Social Security amounts and start ages, ACA benchmarks and state rate (all optional), and health premium amounts (healthPremiumAcaHouseholdAnnual, healthPremiumAcaSingleAnnual, healthPremiumMedicarePerPersonAnnual — annual dollars; supplying any of them requires spendingIncludesHealthPremiums, which states whether monthlySpending already includes the premiums). ordinaryDividendsAnnual is the TOTAL ordinary dividends (1099-DIV Box 1a), including the qualified portion; qualifiedDividendsAnnual is the qualified portion (Box 1b) and must not exceed ordinaryDividendsAnnual — a call with qualified above ordinary is rejected as invalid input naming both fields. A taxable share sale is priced from stockSoldAnnual (proceeds) and stockBasisAnnual (basis) — the gain (or loss, when basis exceeds proceeds) rides the capital-gains stack and the proceeds count as cash in; omit both when there is no sale. An RMD is priced from pretaxPriorYearEndAnnual (the primary's pre-tax balance at Dec 31 of the year before the priced year) and, on a joint return, pretaxSpousePriorYearEndAnnual (the spouse's own Dec-31 balance); omit both when no balance is known and no RMD is priced. Use rmdAlreadyReceivedAnnual for the part of this year's RMD already received and already counted in the entered income, and primarySoleBeneficiaryOfSpouse (true/false) only if you know whether the primary is the spouse's sole beneficiary — absent, the spouse's RMD prices on the Uniform Lifetime Table. retirementAge, endAge, and portfolio assumptions (return, volatility, stocks, spending strategy) do not change this year's price. minimumAnnualSpending does not change this year's price either — the floor is a retirement-simulation input; a single tax year prices no simulation. The four balances are required by the shared input contract but only the prior-Dec-31 balances above price an RMD — the current balances never do. ` + `Example call: ${JSON.stringify(EXAMPLE_TAX_YEAR)}. ` + `Returns: the single-year federal and state tax, ACA premium credit, IRMAA price, and health premiums (gross and net, when premium fields are supplied) for that one tax year, including any priced sale gain/loss and RMD.`,
    inputSchema: BASE_INPUT_SCHEMA,
    handler: (args) => normalized(args, calculateSingleYearTax)
  },
  {
    name: "retirement_describe_capabilities",
    description: `Use when the user (or an AI client) asks what this server can do, which tools exist, what inputs each tool needs, or what the limits and assumptions are — or as a first call to discover the server before asking a retirement question. ` + `Required: none. Optional: none — it takes no inputs. ` + `Example call: {}. ` + `Returns: a machine-readable guide in results — tools (one entry per tool with name, whenToUse, required and optional inputs, an exampleCall, and a resultSummary), requiredInputsGlobal, assumptionsSummary, limitations, quickStart, and the engine block (source, adapterVersion, apiContractVersion, taxLawYear, lawYears). It performs no calculation.`,
    inputSchema: EMPTY_INPUT_SCHEMA,
    handler: () => describeCapabilities()
  }
];
var TOOL_NAMES = TOOLS.map((t) => t.name);
var TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
var CAPABILITY_ASSUMPTIONS = [
  {
    field: "taxLawYear",
    value: latestTaxLawYear(),
    provenance: "engine_constant",
    note: "Pricing uses the latest published tax-law tables; earlier years are available via taxYear."
  },
  {
    field: "stateless",
    value: true,
    provenance: "engine_constant",
    note: "Every call carries its complete scenario. Nothing is saved between calls."
  },
  {
    field: "monthlySpending",
    value: "excludes health premiums unless spendingIncludesHealthPremiums is true",
    provenance: "assumption",
    note: "When health premium fields are supplied, monthlySpending is read as living expenses excluding health insurance premiums and the premium is funded on top of spending, unless spendingIncludesHealthPremiums declares the premiums are already inside monthlySpending (then they are not charged again). When no premium field is supplied, no premium is modeled and the call carries a warning."
  }
];
var CAPABILITY_LIMITATIONS = [
  "Stateless and read-only: every call carries its complete scenario; nothing is saved.",
  `Tax law years ${FIRST_LAW_YEAR}–${latestTaxLawYear()} only. Later tables are not yet published, so later-year pricing is not available.`,
  "Health insurance premiums are priced only by the tax-aware tools (retirement_compare_strategies, retirement_roth_conversion, retirement_work_years, retirement_tax_year); the portfolio-only tools (retirement_calculate, retirement_monte_carlo, retirement_max_spending) price no premiums. A premium supplied with spendingIncludesHealthPremiums false is funded on top of monthlySpending; with the flag true it is already inside spending and is not charged again. Supplying a premium without the flag is rejected.",
  "retirement_work_years compares retirement ages with the tax-aware engine; when salaryAnnual is given it also prices the earned-income leg (work years, payroll tax, best strategy and claim ages) for each quit age, and without a salary that leg is omitted with a warning.",
  "Monte Carlo runs are capped at 5,000 simulations per call and the planning horizon ends at age 120.",
  "Funding success is not spending adequacy: the Monte Carlo and calculate success rates count runs where every year's withdrawal was funded, but under the percent, guardrails, or phased strategies yearly spending can shrink far below the household's desired level while every year still funds. Pass minimumAnnualSpending (dollars per year) to retirement_calculate or retirement_monte_carlo to also get the adequacy rate (`historicalSpendingAdequacyRate` on calculate, `spendingAdequacyRate` on monte_carlo) — the share of runs where every retired year's GROSS spending stayed at or above that floor — and read the two rates together; a high funding-success rate is not proof the household can maintain its desired spending. Adequacy is measured on gross spending, so for the constant strategy, whose gross never varies, a floor at or below yearly spending reads adequacy 100% even in runs where withdrawals went unfunded.",
  "Pre-retirement income is not accumulated: the simulation prices no pre-retirement spending, salary, or tax, so a Social Security benefit (or other fixed income) starting before retirement is not banked in the pre-retirement years — it counts only once retired. Benefits already being collected while still working belong to retirement_work_years, which prices those years with tax and lands the surplus in Taxable.",
  "The retirement simulation is tax-free and single-portfolio: it prices no income tax, no IRMAA, and no separate account buckets — the tax-aware tools (retirement_compare_strategies, retirement_roth_conversion, retirement_work_years) price tax and account order instead.",
  "A single-year price models a share sale only from typed stockSoldAnnual/stockBasisAnnual (never from taxableBasisPct, which prices no sale), and an RMD only from a typed prior-Dec-31 balance (never from today's balance). Capital-loss carryforward entering the year is not an input — the year's own realized loss still prices (up to $3,000 against ordinary income, the rest carried out in lossCarryOutSt/lossCarryOutLt), but a banked loss from an earlier year cannot be typed in.",
  'Synchronous execution: calls run to completion in-process with no hard preemption in v1; most calls return in a few seconds, but the work-years comparison can take a minute or more, and a full optimizer search (retirement_roth_conversion with comparisonScope "full") can take over a minute too. A long call stalls the whole process — and, when running as the MCP server, the server including /health — until it finishes. The full optimizer search has no explicit timeout or resource limit in v1, by design: it runs to completion, and if the optimizer throws the call fails with `engine_error` — never a fabricated or partial winner — and is never silently downgraded to the limited comparison.',
  "Limited comparisons never claim a global optimum: the default 3-order withdrawal comparison and 4-strategy Roth comparison crown the best of those few only. The full optimizer search is optimal only within the engine's searched candidate space at the entered claiming ages — it does not search claiming ages and prices no Monte Carlo success check. Every comparison response carries a comparisonScope block saying exactly what was evaluated; lowest lifetime net cost and highest ending after-tax wealth are different objectives and often crown different winners.",
  "Results are planning estimates from the Finance Planner engines, not tax advice.",
  "Standalone bundle: the same eight tools ship as a single finance-planner-cli.mjs file that runs under plain Node.js 20+ with no server, no install, and no network — see assistant-api/STANDALONE.md."
];
var TOOL_GUIDE = [
  {
    name: "retirement_calculate",
    whenToUse: "Use when the user asks whether they can retire now, or when they can afford to retire.",
    required: REQUIRED_INPUTS_GLOBAL2,
    optional: [...PRICED_OPTIONAL.retirement_calculate],
    exampleCall: EXAMPLE_CALCULATE,
    resultSummary: "Whether the money lasts (neverRunsOut), the ending balance, and a year-by-year balance table, plus the historical cross-check of the same plan — and, when minimumAnnualSpending is given, the historical spending-adequacy rate beside the funding rate."
  },
  {
    name: "retirement_monte_carlo",
    whenToUse: "Use when the user asks how likely their retirement plan is to succeed, or wants a probability instead of a single yes/no answer.",
    required: REQUIRED_INPUTS_GLOBAL2,
    optional: [...PRICED_OPTIONAL.retirement_monte_carlo],
    exampleCall: EXAMPLE_MONTE_CARLO,
    resultSummary: "The success probability — the share of simulations in which the money lasts to the end age — with the distribution of outcomes across the simulations. When minimumAnnualSpending is given, also the spending-adequacy rate: the share of simulations where every retired year's gross spending stayed at or above that floor — read beside the success rate, never instead of it."
  },
  {
    name: "retirement_max_spending",
    whenToUse: "Use when the user asks how much they can spend per month in retirement, or what the highest sustainable spending level is.",
    required: REQUIRED_INPUTS_GLOBAL2,
    optional: [...PRICED_OPTIONAL.retirement_max_spending],
    exampleCall: EXAMPLE_MAX_SPENDING,
    resultSummary: "The maximum sustainable monthly spending in dollars at 85% Monte Carlo success, with a historical cross-check of that spending level. (monthlySpending is still required as the starting point.) The solver always runs the engine's fixed 1,000 simulations — mcRuns is not used for this tool; results report runs: 1000. A supplied minimumAnnualSpending does not change this answer — the solver scores funding success only and reports no adequacy rate. The response also reports feasibility: targetSuccessRate (0.85), achievedSuccessRate, targetAchieved, and solutionStatus (feasible | feasible_at_zero | infeasible_at_zero | capped) — a $0 maximum with solutionStatus infeasible_at_zero means no spending level reaches the target."
  },
  {
    name: "retirement_compare_strategies",
    whenToUse: "Use when the user asks which account to spend from first, or how the withdrawal order changes their taxes and outcome.",
    required: REQUIRED_INPUTS_GLOBAL2,
    optional: [...PRICED_OPTIONAL.retirement_compare_strategies],
    exampleCall: EXAMPLE_COMPARE_STRATEGIES,
    resultSummary: "A tax-aware comparison of the three withdrawal orders (taxable-first, pretax-first, roth-first), with taxes, ACA credit and ending wealth for each. There is no strategy input — all three are always compared."
  },
  {
    name: "retirement_roth_conversion",
    whenToUse: "Use when the user asks whether to convert pre-tax money to Roth, how much to convert, or whether conversions are worth the tax.",
    required: REQUIRED_INPUTS_GLOBAL2,
    optional: [...PRICED_OPTIONAL.retirement_roth_conversion],
    exampleCall: EXAMPLE_ROTH,
    resultSummary: "A tax-aware comparison of four conversion strategies — Do Nothing vs Fill 12% vs Fill 22% vs Fill 22% capped at IRMAA Tier 1 — with federal tax, ACA credit, IRMAA and ending wealth for each."
  },
  {
    name: "retirement_work_years",
    whenToUse: "Use when the user asks whether working a few more years is worth it, or what changes if they retire later.",
    required: REQUIRED_INPUTS_GLOBAL2,
    optional: [...PRICED_OPTIONAL.retirement_work_years],
    exampleCall: EXAMPLE_WORK_YEARS,
    resultSummary: "A tax-aware comparison of retiring at each age in compareAges, with taxes and ending wealth for each age; when salaryAnnual is given, each age also prices the earned-income leg (work years, payroll tax, all-in tax, best strategy and claim ages)."
  },
  {
    name: "retirement_tax_year",
    whenToUse: "Use when the user asks what their tax bill will be for one specific year, or how much a Roth conversion or a draw costs in tax that year.",
    required: REQUIRED_INPUTS_GLOBAL2,
    optional: [...PRICED_OPTIONAL.retirement_tax_year],
    exampleCall: EXAMPLE_TAX_YEAR,
    resultSummary: "The single-year federal and state tax, ACA premium credit and IRMAA price for that one tax year, including any priced share sale (gain/loss, proceeds as cash in) and any priced RMD (from the prior-Dec-31 balances)."
  },
  {
    name: "retirement_describe_capabilities",
    whenToUse: "Use when the user (or an AI client) asks what this server can do, which tools exist, what inputs each tool needs, or what the limits and assumptions are — or as a first call to discover the server before asking a retirement question.",
    required: [],
    optional: [],
    exampleCall: {},
    resultSummary: "This guide: one entry per tool (whenToUse, required/optional inputs, exampleCall, resultSummary), plus requiredInputsGlobal, assumptionsSummary, limitations, quickStart and the engine block. No calculation is performed."
  }
];
var ASSUMPTIONS_SUMMARY = [
  "All money is dollars, ages are whole years, percents are numbers (5 = 5%).",
  "Every financial call carries its complete scenario; nothing is saved between calls.",
  "Missing optional fields fall back to documented defaults inside normalize: retirementAge defaults to your current age (retire now), endAge defaults to 95, Social Security defaults to none.",
  "Each tool prices only the inputs its engine reads — the guide lists the priced optionals per tool, and a field outside that list is accepted but has no effect on that tool's answer (notably mcRuns for max-spending, which always solves at the engine's fixed 1,000 runs). Such a field is reported in the response's ignoredInputFields (and as a warnings[] entry naming the field, the tool, and the tool that does price it) instead of being silently dropped.",
  "qualifiedDividendsAnnual is the qualified portion (1099-DIV Box 1b) of total ordinaryDividendsAnnual (Box 1a) and must not exceed it — a call with qualified above ordinary is rejected as invalid_input naming both fields (contract version 164).",
  `Comparison tools default to comparisonScope "limited" (3 withdrawal orders / 4 conversion strategies); pass "full" for the engine's whole candidate space. Every comparison response carries a comparisonScope block: what was evaluated, both winners (lowest lifetime net cost vs highest ending after-tax wealth), and whether any global optimum is claimed (never — even the full optimizer search holds claiming ages fixed and prices no Monte Carlo success check).`,
  "Pricing uses the latest published tax-law tables (the engine block names the year); earlier law years are available via taxYear."
];
var QUICK_START = {
  local: "Local (zero-config): run `bun src/server.ts` from the assistant-api directory — it listens on http://127.0.0.1:8080 with no token needed on localhost. Then POST a JSON-RPC request to http://127.0.0.1:8080/mcp, or call retirement_describe_capabilities first to see all tools.",
  remote: "Remote: from the repo root run `assistant-api/deploy.sh` with ASSISTANT_API_TOKEN set — it builds the Docker image and runs it on 0.0.0.0:8080. Then POST to https://<host>/mcp with header `Authorization: Bearer <token>`.",
  standalone: "Standalone (no server, no install): run `node finance-planner-cli.mjs <tool> input.json` with Node.js 20+ — a single self-contained file, no MCP connection or hosting needed. No release has been published yet — until the first release, use the committed copy at `assistant-api/dist/finance-planner-cli.mjs` (with its `.sha256` checksum) or build it with `cd assistant-api && bun run build:standalone`; see assistant-api/STANDALONE.md and assistant-api/AI_USAGE.md."
};
function describeCapabilities() {
  const envelope = {
    ok: true,
    source: "finance-planner-engine",
    adapterVersion: ADAPTER_VERSION,
    apiContractVersion: API_CONTRACT_VERSION_REPORTED,
    taxLawYear: latestTaxLawYear(),
    effectiveInputs: {},
    assumptions: CAPABILITY_ASSUMPTIONS,
    results: {
      tools: TOOL_GUIDE,
      requiredInputsGlobal: REQUIRED_INPUTS_GLOBAL2,
      assumptionsSummary: ASSUMPTIONS_SUMMARY,
      limitations: CAPABILITY_LIMITATIONS,
      quickStart: QUICK_START,
      engine: {
        source: "finance-planner-engine",
        adapterVersion: ADAPTER_VERSION,
        apiContractVersion: API_CONTRACT_VERSION_REPORTED,
        taxLawYear: latestTaxLawYear(),
        lawYears: TAX_LAW_YEARS.map((law) => law.year)
      }
    },
    warnings: [],
    ignoredInputFields: []
  };
  return envelope;
}
function dispatchTool(name, args) {
  const started = Date.now();
  const def = TOOLS_BY_NAME.get(name);
  if (!def) {
    throw new Error(`Unknown tool: ${name}`);
  }
  try {
    const result = def.handler(args);
    console.error(`[assistant-api] tool=${name} ok=${result.ok} ms=${Date.now() - started}`);
    return result;
  } catch (err) {
    console.error(`[assistant-api] tool=${name} ok=false threw ms=${Date.now() - started}`);
    throw err;
  }
}

var USAGE = `finance-planner-cli.mjs — single-file Finance Planner calculator. Needs only Node.js 20+, no server, no install, no network. Full guide: assistant-api/AI_USAGE.md and assistant-api/STANDALONE.md.

Usage:
  node finance-planner-cli.mjs --help                  Show this usage
  node finance-planner-cli.mjs --list                  List tools with one-line descriptions
  node finance-planner-cli.mjs retirement_describe_capabilities   Describe the tools (no input needed)
  node finance-planner-cli.mjs <tool> [input.json]     Call a tool with JSON from a file
  node finance-planner-cli.mjs <tool> --stdin          Call a tool with JSON from stdin

Exit codes: 0 = ok:true envelope, 2 = ok:false envelope, 1 = usage error.
Inputs over 256KB are rejected. No auth is needed; nothing is saved between calls.
`;
var MAX_INPUT_BYTES = 256 * 1024;
function usageError(message) {
  console.error(`error: ${message}

${USAGE}`);
  process.exit(1);
}
async function readStdinCapped() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_INPUT_BYTES) {
      console.error(`error: input exceeds the 256KB limit (${total} bytes read)`);
      process.exit(1);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function readFileCapped(file) {
  let size;
  try {
    size = statSync(file).size;
  } catch (err) {
    console.error(`error: could not read input: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (size > MAX_INPUT_BYTES) {
    console.error(`error: input exceeds the 256KB limit (${size} bytes)`);
    process.exit(1);
  }
  return readFile(file, "utf8");
}
function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    if (argv.length === 0) {
      console.error(USAGE);
      process.exit(1);
    }
    console.log(USAGE);
    process.exit(0);
  }
  if (argv[0] === "--list") {
    for (const t of TOOLS) {
      const firstLine = t.description.split(/(?<=\.)\s/)[0] ?? t.description;
      console.log(`${t.name}
  ${firstLine}`);
    }
    process.exit(0);
  }
  if (argv[0] === "serve") {
    usageError("the standalone bundle starts no server — run the MCP server with `bun src/server.ts` (or Docker) instead; see assistant-api/README.md");
  }
  const toolName = argv[0];
  if (!TOOLS.some((t) => t.name === toolName)) {
    usageError(`unknown tool "${toolName}". Run with --list to see the available tools.`);
  }
  const rest = argv.slice(1);
  const useStdin = rest.includes("--stdin");
  const fileArgs = rest.filter((a) => a !== "--stdin");
  if (useStdin && fileArgs.length > 0) {
    usageError("pass either a JSON file or --stdin, not both");
  }
  if (!useStdin && fileArgs.length === 0) {
    if (toolName === "retirement_describe_capabilities") {
      runTool(toolName, null, true);
      return;
    }
    usageError(`usage: node finance-planner-cli.mjs ${toolName} [input.json] | --stdin`);
  }
  if (!useStdin && fileArgs.length !== 1) {
    usageError(`usage: node finance-planner-cli.mjs ${toolName} [input.json] | --stdin`);
  }
  runTool(toolName, useStdin ? null : fileArgs[0]);
}
async function runTool(toolName, file, bareDescribe = false) {
  let args;
  if (bareDescribe) {
    args = {};
  } else {
    let raw;
    try {
      raw = file === null ? await readStdinCapped() : await readFileCapped(file);
    } catch (err) {
      console.error(`error: could not read input: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    try {
      args = JSON.parse(raw);
    } catch {
      console.error("error: input is not valid JSON");
      process.exit(1);
    }
  }
  let envelope;
  try {
    envelope = dispatchTool(toolName, args);
  } catch (err) {
    console.error(`error: tool failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  console.log(JSON.stringify(envelope, null, 2));
  process.exit(envelope.ok ? 0 : 2);
}
main();
