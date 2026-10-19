// Retirement regression fixtures — pinned input/output cases for the
// simulation engines (server/src/retirementEngines.ts), plus the
// Trinity-style external benchmark anchor.
//
// MAINTENANCE RULE — read before touching the engines, the dataset,
// or the defaults:
//   Any future change to the engines (retirementEngines.ts), the
//   historical dataset (retirementData.ts), or the plan defaults
//   MUST re-run this suite (the runAccuracySelfCheck server action)
//   and account for every case that moves. An expected value may
//   only be changed after the new number has been verified by an
//   INDEPENDENT recomputation — a from-scratch reimplementation of
//   the affected engine run on the same inputs and data, agreeing
//   to the cent — the same standard the accuracy review loops used
//   when these expectations were first pinned (October 2026, from
//   the then-current verified implementation). Never re-pin an
//   expectation just because the live engine now prints something
//   different: a moved number is a finding until the independent
//   recomputation says which side is right.
//
// Comparisons: money outcomes are compared exactly, to the cent
// (expected values are stored pre-rounded to whole cents; the live
// result is rounded the same way). Success rates are stored to one
// decimal and compared after the same rounding. That strictness is
// deliberate — the suite exists so a one-cent drift fails loudly.

import {
buildSimInputs,
displayedMoneyDeltaCents,
displayedRateDeltaPoints,
MONTE_CARLO_TAB_RUNS,
MONTE_CARLO_TAB_SEED_DEFAULT,
runHistorical,
runMonteCarlo,
simulate,
simulateDetailed,
solveMaxSpending,
type SpendingStrategy,
} from "./retirementEngines";

// The full raw input set of one case, in exactly the shape a saved
// plan / scenario carries (buildSimInputs applies the app's clamps
// and blank-fallbacks before the engines run). Null = blank field.
export type FixtureInput = {
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
  // Phased knobs, OPTIONAL here: cases written before the phased
  // strategy existed omit them (absence resolves to the defaults
  // 75 / 1 through buildSimInputs, exactly as a pre-phased stored
  // record does); phased cases set them explicitly.
  phaseStartAge?: number | null;
  phaseDeclinePct?: number | null;
};

export type FixtureExpected = {
  endingCents?: number;
  successRate?: number;
  // The engines' never-runs-out rate (the predicate the Max
  // Spending solver scores by, and the rate the Historical and
  // Monte Carlo tabs headline): share of runs in which every
  // year's withdrawal was fully funded. Differs from successRate
  // exactly on deplete-then-refill runs, which end positive after
  // sitting at $0 — successRate counts those, this does not.
  neverOutSuccessRate?: number;
  medianEndingCents?: number;
  worstEndingCents?: number;
  worstStartYear?: number;
  runCount?: number;
  p10Cents?: number;
  p50Cents?: number;
  p90Cents?: number;
  lowestSpendingCents?: number;
  averageSpendingCents?: number;
  solvedSpendingCents?: number;
  solvedPercent?: number | null;
  // Display-delta cases only (kind "display-delta"): the sub-delta
  // computed from the displayed (rounded) figures, the same delta
  // computed from the raw float difference, and the rate delta in
  // tenths of a point — pinned separately so the case proves the
  // two bases disagree (by 1¢ / a tenth) and that the card uses
  // the displayed basis.
  moneyDeltaCents?: number;
  rawMoneyDeltaCents?: number;
  rateDeltaTenths?: number;
  rawRateDeltaTenths?: number;
  // Phased-path cases only (kind "projection"): the run's gross
  // spending at specific ages, pinned individually so the
  // step-down path itself — not just its ending balance — is
  // under test.
  grossByAgeCents?: { age: number; cents: number }[];
};

export type FixtureCase = {
  id: string;
  kind: "projection" | "historical" | "montecarlo" | "solver" | "display-delta";
  note: string;
  input: FixtureInput;
  // Display-delta cases only: the two raw figures whose DISPLAYED
  // values the scenario-card sub-delta must be the difference of
  // (scenario − Current, the cards' sign convention).
  displayDelta?: {
    scenarioMoneyCents: number;
    currentMoneyCents: number;
    scenarioRate: number;
    currentRate: number;
  };
  // Monte Carlo tab runs pin the app's seed state (default 12345).
  mcSeed?: number;
  solverEngine?: "historical" | "montecarlo";
  solverTargetPct?: number;
  expected: FixtureExpected;
};

export const RETIREMENT_FIXTURES: FixtureCase[] = [
  {
    id: "proj-constant-base",
    kind: "projection",
    note: "Constant strategy at the blended 75/25 expected return.",
    input: { portfolioCents: 200000000, spendingCents: 10000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: null, extraIncomeStartAge: null, expectedReturnPct: null, volatilityPct: null, strategy: "constant", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null },
    expected: {"endingCents":516551018},
  },
  {
    id: "proj-constant-retired-now",
    kind: "projection",
    note: "Retire immediately at 65.",
    input: { portfolioCents: 200000000, spendingCents: 10000000, currentAge: 65, retirementAge: 65, endAge: 95, stocksPct: 75, extraIncomeCents: null, extraIncomeStartAge: null, expectedReturnPct: null, volatilityPct: null, strategy: "constant", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null },
    expected: {"endingCents":269989656},
  },
  {
    id: "proj-constant-depletes",
    kind: "projection",
    note: "Spending far above what the portfolio supports: the plan runs dry (ending $0).",
    input: { portfolioCents: 200000000, spendingCents: 26000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: null, extraIncomeStartAge: null, expectedReturnPct: null, volatilityPct: null, strategy: "constant", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null },
    expected: {"endingCents":0},
  },
  {
    id: "proj-percent-5",
    kind: "projection",
    note: "Percent strategy, 5% of the balance each year.",
    input: { portfolioCents: 300000000, spendingCents: 10000000, currentAge: 60, retirementAge: 60, endAge: 95, stocksPct: 75, extraIncomeCents: null, extraIncomeStartAge: null, expectedReturnPct: null, volatilityPct: null, strategy: "percent", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null },
    expected: {"endingCents":352582378},
  },
  {
    id: "proj-percent-3-low-return",
    kind: "projection",
    note: "Percent strategy at 3% with a typed 4% expected return.",
    input: { portfolioCents: 200000000, spendingCents: 10000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: null, extraIncomeStartAge: null, expectedReturnPct: 4, volatilityPct: null, strategy: "percent", percentOfPortfolio: 3, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null },
    expected: {"endingCents":301779315},
  },
  {
    id: "proj-guardrails-defaults",
    kind: "projection",
    note: "Guardrails at the professional default knobs (120/80/10).",
    input: { portfolioCents: 200000000, spendingCents: 10000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: null, extraIncomeStartAge: null, expectedReturnPct: null, volatilityPct: null, strategy: "guardrails", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null },
    expected: {"endingCents":414103365},
  },
  {
    id: "proj-guardrails-custom-knobs",
    kind: "projection",
    note: "Guardrails with non-default knobs 135/70/12 and a typed 4.25% return.",
    input: { portfolioCents: 200000000, spendingCents: 10000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: null, extraIncomeStartAge: null, expectedReturnPct: 4.25, volatilityPct: null, strategy: "guardrails", percentOfPortfolio: 5, guardrailsCutPct: 135, guardrailsRaisePct: 70, guardrailsAdjustmentPct: 12 },
    expected: {"endingCents":131244906},
  },
  {
    id: "proj-income-midplan",
    kind: "projection",
    note: "Extra income of $50,484/yr starting at 67, mid-plan (retirement at 57).",
    input: { portfolioCents: 200000000, spendingCents: 10000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: 5048400, extraIncomeStartAge: 67, expectedReturnPct: null, volatilityPct: null, strategy: "constant", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null },
    expected: {"endingCents":867943496},
  },
  {
    id: "proj-income-surplus",
    kind: "projection",
    note: "Surplus case: extra income ($150,000/yr from 57) exceeds spending, so the surplus is invested.",
    input: { portfolioCents: 200000000, spendingCents: 10000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: 15000000, extraIncomeStartAge: 57, expectedReturnPct: null, volatilityPct: null, strategy: "constant", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null },
    expected: {"endingCents":2549331362},
  },
  {
    id: "proj-income-no-start-age",
    kind: "projection",
    note: "Extra income with no start age counts from the retirement age.",
    input: { portfolioCents: 200000000, spendingCents: 10000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: 2400000, extraIncomeStartAge: null, expectedReturnPct: null, volatilityPct: null, strategy: "constant", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null },
    expected: {"endingCents":841795873},
  },
  {
    id: "hist-constant-base",
    kind: "historical",
    note: "Constant strategy over every historical start year, 75/25 mix.",
    input: { portfolioCents: 200000000, spendingCents: 10000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: null, extraIncomeStartAge: null, expectedReturnPct: null, volatilityPct: null, strategy: "constant", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null },
    expected: {"successRate":72.9,"medianEndingCents":374102771,"worstEndingCents":0,"worstStartYear":1929,"runCount":59},
  },
  {
    id: "hist-constant-5050-30y",
    kind: "historical",
    note: "50/50 mix, retire at 65, 30-year plan.",
    input: { portfolioCents: 100000000, spendingCents: 4500000, currentAge: 65, retirementAge: 65, endAge: 95, stocksPct: 50, extraIncomeCents: null, extraIncomeStartAge: null, expectedReturnPct: null, volatilityPct: null, strategy: "constant", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null },
    expected: {"successRate":84.1,"medianEndingCents":79111200,"worstEndingCents":0,"worstStartYear":1937,"runCount":69},
  },
  {
    id: "hist-percent-45",
    kind: "historical",
    note: "Percent strategy at 4.5%, 60/40 mix, retire at 60.",
    input: { portfolioCents: 300000000, spendingCents: 10000000, currentAge: 60, retirementAge: 60, endAge: 95, stocksPct: 60, extraIncomeCents: null, extraIncomeStartAge: null, expectedReturnPct: null, volatilityPct: null, strategy: "percent", percentOfPortfolio: 4.5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null },
    expected: {"successRate":100,"medianEndingCents":338982855,"worstEndingCents":184945450,"worstStartYear":1946,"runCount":64,"lowestSpendingCents":5196484,"averageSpendingCents":14980945},
  },
  {
    id: "hist-guardrails-defaults",
    kind: "historical",
    note: "Guardrails at the professional default knobs (120/80/10).",
    input: { portfolioCents: 200000000, spendingCents: 10000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: null, extraIncomeStartAge: null, expectedReturnPct: null, volatilityPct: null, strategy: "guardrails", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null },
    expected: {"successRate":100,"medianEndingCents":345623390,"worstEndingCents":49182057,"worstStartYear":1973,"runCount":59},
  },
  {
    id: "hist-guardrails-custom-knobs",
    kind: "historical",
    note: "Guardrails with non-default knobs 135/70/12.",
    input: { portfolioCents: 200000000, spendingCents: 10000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: null, extraIncomeStartAge: null, expectedReturnPct: null, volatilityPct: null, strategy: "guardrails", percentOfPortfolio: 5, guardrailsCutPct: 135, guardrailsRaisePct: 70, guardrailsAdjustmentPct: 12 },
    expected: {"successRate":100,"medianEndingCents":352923139,"worstEndingCents":33069266,"worstStartYear":1973,"runCount":59},
  },
  {
    id: "hist-income-midplan",
    kind: "historical",
    note: "Extra income of $50,484/yr starting at 67, mid-plan.",
    input: { portfolioCents: 200000000, spendingCents: 10000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: 5048400, extraIncomeStartAge: 67, expectedReturnPct: null, volatilityPct: null, strategy: "constant", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null },
    expected: {"successRate":100,"medianEndingCents":741722003,"worstEndingCents":86423134,"worstStartYear":1969,"runCount":59},
  },
  {
    id: "hist-income-surplus",
    kind: "historical",
    note: "Surplus case: $150,000/yr income from 57 against $100,000 spending.",
    input: { portfolioCents: 200000000, spendingCents: 10000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: 15000000, extraIncomeStartAge: 57, expectedReturnPct: null, volatilityPct: null, strategy: "constant", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null },
    expected: {"successRate":100,"medianEndingCents":2475462397,"worstEndingCents":1522719600,"worstStartYear":1940,"runCount":59},
  },
  {
    id: "hist-all-stocks",
    kind: "historical",
    note: "100% stocks mix.",
    input: { portfolioCents: 200000000, spendingCents: 10000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 100, extraIncomeCents: null, extraIncomeStartAge: null, expectedReturnPct: null, volatilityPct: null, strategy: "constant", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null },
    expected: {"successRate":78,"medianEndingCents":966178964,"worstEndingCents":0,"worstStartYear":1929,"runCount":59},
  },
  {
    id: "hist-all-bonds",
    kind: "historical",
    note: "0% stocks (all bonds) mix.",
    input: { portfolioCents: 200000000, spendingCents: 10000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 0, extraIncomeCents: null, extraIncomeStartAge: null, expectedReturnPct: null, volatilityPct: null, strategy: "constant", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null },
    expected: {"successRate":13.6,"medianEndingCents":0,"worstEndingCents":0,"worstStartYear":1928,"runCount":59},
  },
  {
    id: "hist-short-plan-15y",
    kind: "historical",
    note: "Short 15-year plan (65 to 80): many more start-year windows fit.",
    input: { portfolioCents: 200000000, spendingCents: 10000000, currentAge: 65, retirementAge: 65, endAge: 80, stocksPct: 75, extraIncomeCents: null, extraIncomeStartAge: null, expectedReturnPct: null, volatilityPct: null, strategy: "constant", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null },
    expected: {"successRate":100,"medianEndingCents":227280066,"worstEndingCents":25100267,"worstStartYear":1969,"runCount":84},
  },
  {
    id: "mc-constant-base",
    kind: "montecarlo",
    note: "Monte Carlo at the app's default seed, blended return/volatility.",
    input: { portfolioCents: 200000000, spendingCents: 10000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: null, extraIncomeStartAge: null, expectedReturnPct: null, volatilityPct: null, strategy: "constant", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null },
    mcSeed: 12345,
    expected: {"successRate":61.2,"p10Cents":0,"p50Cents":145294232,"p90Cents":1778700904},
  },
  {
    id: "mc-percent-5",
    kind: "montecarlo",
    note: "Percent strategy at 5%, seed 777.",
    input: { portfolioCents: 200000000, spendingCents: 10000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: null, extraIncomeStartAge: null, expectedReturnPct: null, volatilityPct: null, strategy: "percent", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null },
    mcSeed: 777,
    expected: {"successRate":100,"p10Cents":51114180,"p50Cents":175720872,"p90Cents":536601481,"lowestSpendingCents":239290,"averageSpendingCents":10065205},
  },
  {
    id: "mc-guardrails-defaults",
    kind: "montecarlo",
    note: "Guardrails at the professional default knobs, seed 4242.",
    input: { portfolioCents: 200000000, spendingCents: 10000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: null, extraIncomeStartAge: null, expectedReturnPct: null, volatilityPct: null, strategy: "guardrails", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null },
    mcSeed: 4242,
    expected: {"successRate":99.4,"p10Cents":37937556,"p50Cents":219018292,"p90Cents":903474611},
  },
  {
    id: "mc-guardrails-custom-knobs",
    kind: "montecarlo",
    note: "Guardrails with non-default knobs 135/70/12, seed 99.",
    input: { portfolioCents: 200000000, spendingCents: 10000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: null, extraIncomeStartAge: null, expectedReturnPct: null, volatilityPct: null, strategy: "guardrails", percentOfPortfolio: 5, guardrailsCutPct: 135, guardrailsRaisePct: 70, guardrailsAdjustmentPct: 12 },
    mcSeed: 99,
    expected: {"successRate":99.1,"p10Cents":31414214,"p50Cents":206136231,"p90Cents":977788742},
  },
  {
    id: "mc-income-midplan",
    kind: "montecarlo",
    note: "Extra income of $50,484/yr starting at 67, seed 12345.",
    input: { portfolioCents: 200000000, spendingCents: 10000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: 5048400, extraIncomeStartAge: 67, expectedReturnPct: null, volatilityPct: null, strategy: "constant", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null },
    mcSeed: 12345,
    expected: {"successRate":84.6,"p10Cents":0,"p50Cents":409211666,"p90Cents":2235019371},
  },
  {
    id: "mc-income-surplus",
    kind: "montecarlo",
    note: "Surplus case: $150,000/yr income from 57, seed 31337.",
    input: { portfolioCents: 200000000, spendingCents: 10000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: 15000000, extraIncomeStartAge: 57, expectedReturnPct: null, volatilityPct: null, strategy: "constant", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null },
    mcSeed: 31337,
    expected: {"successRate":100,"p10Cents":675052546,"p50Cents":1850236008,"p90Cents":5519384174},
  },
  {
    id: "mc-high-vol-low-return",
    kind: "montecarlo",
    note: "Typed 3.5% expected return with 24% volatility, seed 2024.",
    input: { portfolioCents: 200000000, spendingCents: 10000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: null, extraIncomeStartAge: null, expectedReturnPct: 3.5, volatilityPct: 24, strategy: "constant", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null },
    mcSeed: 2024,
    expected: {"successRate":22.8,"p10Cents":0,"p50Cents":0,"p90Cents":412706115},
  },
  {
    id: "mc-zero-volatility",
    kind: "montecarlo",
    note: "Zero volatility: every simulated lifetime is the same path.",
    input: { portfolioCents: 200000000, spendingCents: 10000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: null, extraIncomeStartAge: null, expectedReturnPct: null, volatilityPct: 0, strategy: "constant", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null },
    mcSeed: 5,
    expected: {"successRate":100,"p10Cents":516551018,"p50Cents":516551018,"p90Cents":516551018},
  },
  {
    id: "solver-hist-constant-95",
    kind: "solver",
    note: "Max Spending, Historical engine, Constant strategy, 95% target.",
    input: { portfolioCents: 200000000, spendingCents: 10000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: null, extraIncomeStartAge: null, expectedReturnPct: null, volatilityPct: null, strategy: "constant", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null },
    solverEngine: "historical", solverTargetPct: 95,
    expected: {"solvedSpendingCents":8070000,"successRate":96.6,"medianEndingCents":643282884,"solvedPercent":null},
  },
  {
    id: "solver-hist-guardrails-95",
    kind: "solver",
    note: "Max Spending, Historical engine, Guardrails (default knobs), 95% target.",
    input: { portfolioCents: 200000000, spendingCents: 10000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: null, extraIncomeStartAge: null, expectedReturnPct: null, volatilityPct: null, strategy: "guardrails", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null },
    solverEngine: "historical", solverTargetPct: 95,
    expected: {"solvedSpendingCents":15380000,"successRate":96.6,"medianEndingCents":106940633,"solvedPercent":null},
  },
  {
    id: "solver-hist-percent-95",
    kind: "solver",
    note: "Max Spending, Historical engine, Percent strategy, 95% target.",
    input: { portfolioCents: 200000000, spendingCents: 10000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: null, extraIncomeStartAge: null, expectedReturnPct: null, volatilityPct: null, strategy: "percent", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null },
    solverEngine: "historical", solverTargetPct: 95,
    expected: {"solvedSpendingCents":60000000,"successRate":100,"medianEndingCents":2313,"solvedPercent":30},
  },
  {
    id: "solver-mc-constant-85",
    kind: "solver",
    note: "Max Spending, Monte Carlo engine, Constant strategy, 85% target — solved on the unified tab stream (seed 12345, 1,000 runs). Re-pinned from the old solver-only stream (seed 987654321, 500 runs), where it solved to $68,000 at 85.0%.",
    input: { portfolioCents: 200000000, spendingCents: 10000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: null, extraIncomeStartAge: null, expectedReturnPct: null, volatilityPct: null, strategy: "constant", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null },
    mcSeed: 12345,
    solverEngine: "montecarlo", solverTargetPct: 85,
    expected: {"solvedSpendingCents":6630000,"successRate":85.2,"medianEndingCents":480501564,"solvedPercent":null},
  },
  {
    id: "solver-mc-guardrails-85",
    kind: "solver",
    note: "Max Spending, Monte Carlo engine, Guardrails (default knobs), 85% target — scanned on the unified tab stream (seed 12345, 1,000 runs). Re-pinned from the old solver-only stream, where it solved to $150,300 at 85.2%.",
    input: { portfolioCents: 200000000, spendingCents: 10000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: null, extraIncomeStartAge: null, expectedReturnPct: null, volatilityPct: null, strategy: "guardrails", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null },
    mcSeed: 12345,
    solverEngine: "montecarlo", solverTargetPct: 85,
    expected: {"solvedSpendingCents":15190000,"successRate":85,"medianEndingCents":55680334,"solvedPercent":null},
  },
  {
    id: "solver-mc-percent-85",
    kind: "solver",
    note: "Max Spending, Monte Carlo engine, Percent strategy, 85% target — on the unified tab stream (seed 12345, 1,000 runs). The 30% cap still binds; only the median ending moved from the old solver-only stream's $14.70.",
    input: { portfolioCents: 200000000, spendingCents: 10000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: null, extraIncomeStartAge: null, expectedReturnPct: null, volatilityPct: null, strategy: "percent", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null },
    mcSeed: 12345,
    solverEngine: "montecarlo", solverTargetPct: 85,
    expected: {"solvedSpendingCents":60000000,"successRate":100,"medianEndingCents":1565,"solvedPercent":30},
  },
  {
    id: "solver-hist-constant-100",
    kind: "solver",
    note: "Max Spending at a 100% target — only spending that survived every start year solves.",
    input: { portfolioCents: 200000000, spendingCents: 10000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: null, extraIncomeStartAge: null, expectedReturnPct: null, volatilityPct: null, strategy: "constant", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null },
    solverEngine: "historical", solverTargetPct: 100,
    expected: {"solvedSpendingCents":7810000,"successRate":100,"medianEndingCents":666368288,"solvedPercent":null},
  },
  {
    id: "solver-hist-guardrails-custom-90",
    kind: "solver",
    note: "Max Spending, Historical, Guardrails with non-default knobs 150/60/15, 90% target.",
    input: { portfolioCents: 200000000, spendingCents: 10000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: null, extraIncomeStartAge: null, expectedReturnPct: null, volatilityPct: null, strategy: "guardrails", percentOfPortfolio: 5, guardrailsCutPct: 150, guardrailsRaisePct: 60, guardrailsAdjustmentPct: 15 },
    solverEngine: "historical", solverTargetPct: 90,
    expected: {"solvedSpendingCents":18350000,"successRate":91.5,"medianEndingCents":26901857,"solvedPercent":null},
  },
  {
    id: "solver-mc-deplete-refill-95",
    kind: "solver",
    note: "Deplete-then-refill (the reported bug): a $400 portfolio with $48,000/yr of extra income from 67. The portfolio is gone at 57, a decade before the income starts, so NO positive spending is fundable — under the old ending-balance scoring the solver claimed $47,900/yr at 100% (the median run refilled to a $1,163.16 ending). Now it solves to $0; even the first $100 step scores 1.2% on the unified tab stream under the never-runs-out rule. The $0 solve's 100% and its median ending are the untempered refill at zero spending (nothing is ever withdrawn, so nothing can fail). Expectations verified by direct recomputation on the tab stream (seed 12345, 1,000 runs) at $0 and $100; the median ending moved from the old solver-only stream's $2,940,419.67.",
    input: { portfolioCents: 40000, spendingCents: 15000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: 4800000, extraIncomeStartAge: 67, expectedReturnPct: 5.75, volatilityPct: 15, strategy: "constant", percentOfPortfolio: 5, guardrailsCutPct: 120, guardrailsRaisePct: 80, guardrailsAdjustmentPct: 10 },
    mcSeed: 12345,
    solverEngine: "montecarlo", solverTargetPct: 95,
    expected: {"solvedSpendingCents":0,"successRate":100,"medianEndingCents":277667456,"solvedPercent":null},
  },
  {
    id: "solver-hist-deplete-refill-95",
    kind: "solver",
    note: "The same deplete-then-refill case on the Historical engine: solves to $0 (the first $100 step scores 0.0% — no historical run funds even $100/yr across the ten years before the income starts). Under the old scoring it also claimed $50,500/yr at 100%.",
    input: { portfolioCents: 40000, spendingCents: 15000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: 4800000, extraIncomeStartAge: 67, expectedReturnPct: 5.75, volatilityPct: 15, strategy: "constant", percentOfPortfolio: 5, guardrailsCutPct: 120, guardrailsRaisePct: 80, guardrailsAdjustmentPct: 10 },
    solverEngine: "historical", solverTargetPct: 95,
    expected: {"solvedSpendingCents":0,"successRate":100,"medianEndingCents":354462526,"solvedPercent":null},
  },
  {
    id: "solver-mc-refill-fundable-95",
    kind: "solver",
    note: "The refill plan scaled up: a $40,000 portfolio CAN fund some spending until the $48,000/yr income starts at 67 — $3,000/yr at 95.3% on the unified tab stream under the never-runs-out rule (the next $100 step scores 94.2%). The old ending-balance scoring solved this to $50,500/yr at 100%, pure refill credit. Re-pinned from the old solver-only stream's 95.4% at the same $3,000.",
    input: { portfolioCents: 4000000, spendingCents: 15000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: 4800000, extraIncomeStartAge: 67, expectedReturnPct: 5.75, volatilityPct: 15, strategy: "constant", percentOfPortfolio: 5, guardrailsCutPct: 120, guardrailsRaisePct: 80, guardrailsAdjustmentPct: 10 },
    mcSeed: 12345,
    solverEngine: "montecarlo", solverTargetPct: 95,
    expected: {"solvedSpendingCents":300000,"successRate":95.3,"medianEndingCents":274798529,"solvedPercent":null},
  },
  {
    id: "solver-hist-refill-fundable-95",
    kind: "solver",
    note: "The $40,000 refill plan on the Historical engine: $3,300/yr at 98.3% (the next $100 step scores 94.9%). The old scoring solved it to $50,500/yr at 100%.",
    input: { portfolioCents: 4000000, spendingCents: 15000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: 4800000, extraIncomeStartAge: 67, expectedReturnPct: 5.75, volatilityPct: 15, strategy: "constant", percentOfPortfolio: 5, guardrailsCutPct: 120, guardrailsRaisePct: 80, guardrailsAdjustmentPct: 10 },
    solverEngine: "historical", solverTargetPct: 95,
    expected: {"solvedSpendingCents":330000,"successRate":98.3,"medianEndingCents":345378346,"solvedPercent":null},
  },
  {
    id: "solver-hist-guardrails-refill-95",
    kind: "solver",
    note: "Guardrails scan on a refill plan: $30,000 portfolio, $9,000 base spending, $48,000/yr income from 67. Solves to $3,400 at 96.6% under the never-runs-out rule (next step 94.9%); the old ending-balance scan solved it to $15,700 at 98.3% on refill credit.",
    input: { portfolioCents: 3000000, spendingCents: 900000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: 4800000, extraIncomeStartAge: 67, expectedReturnPct: 5.75, volatilityPct: 15, strategy: "guardrails", percentOfPortfolio: 5, guardrailsCutPct: 120, guardrailsRaisePct: 80, guardrailsAdjustmentPct: 10 },
    solverEngine: "historical", solverTargetPct: 95,
    expected: {"solvedSpendingCents":340000,"successRate":96.6,"medianEndingCents":308138937,"solvedPercent":null},
  },
  {
    id: "solver-mc-guardrails-refill-95",
    kind: "solver",
    note: "The guardrails refill plan scanned on the unified tab stream: $3,200 at 96.1% (next step 94.8%); the old ending-balance scan solved it to $15,600 at 95.2%, and the old solver-only stream's never-runs-out scan solved it to $3,300 at 95.0%.",
    input: { portfolioCents: 3000000, spendingCents: 900000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: 4800000, extraIncomeStartAge: 67, expectedReturnPct: 5.75, volatilityPct: 15, strategy: "guardrails", percentOfPortfolio: 5, guardrailsCutPct: 120, guardrailsRaisePct: 80, guardrailsAdjustmentPct: 10 },
    mcSeed: 12345,
    solverEngine: "montecarlo", solverTargetPct: 95,
    expected: {"solvedSpendingCents":320000,"successRate":96.1,"medianEndingCents":238993655,"solvedPercent":null},
  },
  {
    id: "solver-mc-unified-stream-95",
    kind: "solver",
    note: "Unified-stream regression (the reported disagreement): a $3,062,500 portfolio spending $150,000/yr, solved on the Monte Carlo TAB's stream (seed 12345, 1,000 runs). (Portfolio and spending rotated to synthetic sample figures in the pre-publication privacy scrub; the property is unchanged.) On the unified stream the solver finds $75,800 at 95.1% — and the runner's direct tab-stream run at the solved spending must reproduce that 95.1% and the median ending exactly (the next $100 step scores 94.9% on the tab stream).",
    input: { portfolioCents: 306250000, spendingCents: 15000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: null, extraIncomeStartAge: null, expectedReturnPct: null, volatilityPct: null, strategy: "constant", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null },
    mcSeed: 12345,
    solverEngine: "montecarlo", solverTargetPct: 95,
    expected: {"solvedSpendingCents":7580000,"successRate":95.1,"medianEndingCents":1015282779,"solvedPercent":null},
  },
  {
    id: "hist-deplete-refill-never-out",
    kind: "historical",
    note: "The deplete-then-refill case at the old solved spending ($47,900/yr on a $400 portfolio, $48,000/yr income from 67): every one of the 59 runs ends positive after refilling (the ending-balance successRate is 100, median ending $7,375.89, worst ending $3,298.99) — and every run spent a decade at $0 first, so the never-runs-out rate is 0. The Historical tab headlines the never-runs-out rate, so it reads 0% for this plan (it read 100% under the old ending-balance headline), while the median ending still shows the refill figure. Both rates are pinned so the divergence can never silently close from either side.",
    input: { portfolioCents: 40000, spendingCents: 4790000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: 4800000, extraIncomeStartAge: 67, expectedReturnPct: 5.75, volatilityPct: 15, strategy: "constant", percentOfPortfolio: 5, guardrailsCutPct: 120, guardrailsRaisePct: 80, guardrailsAdjustmentPct: 10 },
    expected: {"successRate":100,"neverOutSuccessRate":0,"medianEndingCents":737589,"worstEndingCents":329899,"worstStartYear":1942,"runCount":59},
  },
  {
    id: "mc-deplete-refill-never-out",
    kind: "montecarlo",
    note: "The same case on the Monte Carlo engine (tab seed 12345, 1000 runs): ending-balance success 100% with a $5,781.06 median ending — the refill signature — while the never-runs-out rate is 0%. The Monte Carlo tab headlines the never-runs-out rate, so it reads 0% for this plan (it read 100% under the old ending-balance headline), while the median ending still shows the refill figure.",
    input: { portfolioCents: 40000, spendingCents: 4790000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: 4800000, extraIncomeStartAge: 67, expectedReturnPct: 5.75, volatilityPct: 15, strategy: "constant", percentOfPortfolio: 5, guardrailsCutPct: 120, guardrailsRaisePct: 80, guardrailsAdjustmentPct: 10 },
    mcSeed: 12345,
    expected: {"successRate":100,"neverOutSuccessRate":0,"p10Cents":308924,"p50Cents":578106,"p90Cents":1108970},
  },
  {
    id: "hist-atrisk-just-above-95",
    kind: "historical",
    note: "Boundary: success lands just ABOVE the 95% Historical at-risk cutoff (66 of 69 start years).",
    input: { portfolioCents: 100000000, spendingCents: 4000000, currentAge: 65, retirementAge: 65, endAge: 95, stocksPct: 75, extraIncomeCents: null, extraIncomeStartAge: null, expectedReturnPct: null, volatilityPct: null, strategy: "constant", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null },
    expected: {"successRate":95.7,"neverOutSuccessRate":95.7,"medianEndingCents":250938950,"worstEndingCents":0,"worstStartYear":1966,"runCount":69},
  },
  {
    id: "hist-atrisk-just-below-95",
    kind: "historical",
    note: "Boundary: success lands just BELOW the 95% Historical at-risk cutoff (65 of 69 start years) — an at-risk plan.",
    input: { portfolioCents: 100000000, spendingCents: 4100000, currentAge: 65, retirementAge: 65, endAge: 95, stocksPct: 75, extraIncomeCents: null, extraIncomeStartAge: null, expectedReturnPct: null, volatilityPct: null, strategy: "constant", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null },
    expected: {"successRate":94.2,"neverOutSuccessRate":94.2,"medianEndingCents":241236524,"worstEndingCents":0,"worstStartYear":1965,"runCount":69},
  },
  {
    id: "mc-atrisk-just-above-85",
    kind: "montecarlo",
    note: "Boundary: success lands just ABOVE the 85% Monte Carlo at-risk cutoff, seed 12345.",
    input: { portfolioCents: 100000000, spendingCents: 3700000, currentAge: 65, retirementAge: 65, endAge: 95, stocksPct: 75, extraIncomeCents: null, extraIncomeStartAge: null, expectedReturnPct: null, volatilityPct: null, strategy: "constant", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null },
    mcSeed: 12345,
    expected: {"successRate":85.6,"neverOutSuccessRate":85.6,"p10Cents":0,"p50Cents":129967899,"p90Cents":545442120},
  },
  {
    id: "mc-atrisk-just-below-85",
    kind: "montecarlo",
    note: "Boundary: success lands just BELOW the 85% Monte Carlo at-risk cutoff — an at-risk plan, seed 12345.",
    input: { portfolioCents: 100000000, spendingCents: 3750000, currentAge: 65, retirementAge: 65, endAge: 95, stocksPct: 75, extraIncomeCents: null, extraIncomeStartAge: null, expectedReturnPct: null, volatilityPct: null, strategy: "constant", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null },
    mcSeed: 12345,
    expected: {"successRate":84.8,"neverOutSuccessRate":84.8,"p10Cents":0,"p50Cents":126821824,"p90Cents":540468794},
  },
  {
    id: "display-delta-fractional-cent",
    kind: "display-delta",
    note: "Scenario-card sub-delta rounding basis (fractional-cent case, hand-derived): money — the scenario figure 1000.6¢ displays as 1001¢ ($10.01) and the Current figure 500.4¢ displays as 500¢ ($5.00), so the displayed-figure difference is 1001 − 500 = 501¢ ($5.01); the raw float difference is 500.2¢, which rounds to 500¢ ($5.00) — the two bases disagree by exactly 1¢, and the card must use 501¢. Rates — 90.86% displays as 90.9% and 90.84% as 90.8%, so the displayed difference is +0.1 pts (1 tenth); the raw difference 0.02 rounds to 0 tenths (the old formatter read it as 'same'). The plan input below is inert — a display-delta case runs no engine.",
    input: { portfolioCents: 200000000, spendingCents: 10000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: null, extraIncomeStartAge: null, expectedReturnPct: null, volatilityPct: null, strategy: "constant", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null },
    displayDelta: { scenarioMoneyCents: 1000.6, currentMoneyCents: 500.4, scenarioRate: 90.86, currentRate: 90.84 },
    expected: {"moneyDeltaCents":501,"rawMoneyDeltaCents":500,"rateDeltaTenths":1,"rawRateDeltaTenths":0},
  },
  {
    id: "display-delta-baseline-rate",
    kind: "display-delta",
    note: "Baseline what-if rate delta rounding basis (the fmtPtsDeltaVsBaseline path in the Retirement view, hand-derived): the current what-if rate 1.66% displays as 1.7% and the baseline rate 16.94% displays as 16.9%, so the displayed-figure difference (current − baseline, the baseline path's argument order into displayedRateDeltaPoints) is 1.7 − 16.9 = −15.2 pts (−152 tenths); the raw float difference is −15.28, which the old raw-basis formatter printed as −15.3 pts (−153 tenths) — the two bases disagree by exactly 0.1 pts, and the baseline delta must use −15.2. The money figures are inert (equal, delta 0) — this case pins the rate path only; the plan input below is inert — a display-delta case runs no engine.",
    input: { portfolioCents: 200000000, spendingCents: 10000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: null, extraIncomeStartAge: null, expectedReturnPct: null, volatilityPct: null, strategy: "constant", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null },
    displayDelta: { scenarioMoneyCents: 0, currentMoneyCents: 0, scenarioRate: 1.66, currentRate: 16.94 },
    expected: {"moneyDeltaCents":0,"rawMoneyDeltaCents":0,"rateDeltaTenths":-152,"rawRateDeltaTenths":-153},
  },
  {
    id: "proj-phased-stepdown-path",
    kind: "projection",
    note: "Phased strategy, $100,000/yr, step-down from age 75 at 1%/yr, at the blended 75/25 expected return. Gross spending from the step-down formula (factor 1 through age 75, then 0.99^(age−75)): age 74 = $100,000, age 75 = $100,000 (the start age is still full), age 76 = $99,000 (0.99^1), age 85 = $90,438.21 (0.99^10 = 0.9043820750…). Ending balance and gross figures verified by an independent from-scratch recomputation of the formula and year loop (October 2026).",
    input: { portfolioCents: 200000000, spendingCents: 10000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: null, extraIncomeStartAge: null, expectedReturnPct: null, volatilityPct: null, strategy: "phased", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null, phaseStartAge: 75, phaseDeclinePct: 1 },
    expected: {"endingCents":544128779,"grossByAgeCents":[{"age":74,"cents":10000000},{"age":75,"cents":10000000},{"age":76,"cents":9900000},{"age":85,"cents":9043821}]},
  },
  {
    id: "proj-phased-zero-decline-equals-constant",
    kind: "projection",
    note: "Bit-identity: Phased with a 0% step-down is Constant on identical inputs — its ending must equal proj-constant-base's $5,165,510.18 to the cent (the factor is exactly 1 at every age).",
    input: { portfolioCents: 200000000, spendingCents: 10000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: null, extraIncomeStartAge: null, expectedReturnPct: null, volatilityPct: null, strategy: "phased", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null, phaseStartAge: 75, phaseDeclinePct: 0 },
    expected: {"endingCents":516551018},
  },
  {
    id: "proj-phased-start-at-end-equals-constant",
    kind: "projection",
    note: "Bit-identity: Phased with its step-down start age AT the end age (95) never declines within the plan (the last year run is age 94), even at a 5% step-down — its ending must equal proj-constant-base's $5,165,510.18 to the cent.",
    input: { portfolioCents: 200000000, spendingCents: 10000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: null, extraIncomeStartAge: null, expectedReturnPct: null, volatilityPct: null, strategy: "phased", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null, phaseStartAge: 95, phaseDeclinePct: 5 },
    expected: {"endingCents":516551018},
  },
  {
    id: "solver-hist-phased-95",
    kind: "solver",
    note: "Max Spending, Historical engine, Phased strategy (step-down from 75 at 1%/yr), 95% target: the solved figure is the maximum STARTING (pre-decline) annual spending, priced through the phased path — $81,900/yr at 96.6%, above Constant's $80,700 on the same plan because the later years spend less. Verified by a brute-force $100-step scan over the historical engine's never-runs-out rate (the next step, $82,000, scores 94.9%).",
    input: { portfolioCents: 200000000, spendingCents: 10000000, currentAge: 55, retirementAge: 57, endAge: 95, stocksPct: 75, extraIncomeCents: null, extraIncomeStartAge: null, expectedReturnPct: null, volatilityPct: null, strategy: "phased", percentOfPortfolio: 5, guardrailsCutPct: null, guardrailsRaisePct: null, guardrailsAdjustmentPct: null, phaseStartAge: 75, phaseDeclinePct: 1 },
    solverEngine: "historical", solverTargetPct: 95,
    expected: {"solvedSpendingCents":8190000,"successRate":96.6,"medianEndingCents":650861099,"solvedPercent":null},
  },
];

export type FixtureCaseResult = {
  id: string;
  kind: FixtureCase["kind"];
  pass: boolean;
  failures: string[];
};

const round1 = (n: number): number => Math.round(n * 10) / 10;

function checkCents(
  failures: string[],
  label: string,
  actual: number | null | undefined,
  expected: number | null | undefined,
): void {
  if (expected === undefined) return;
  if (actual == null || expected == null || Math.round(actual) !== expected) {
    failures.push(`${label}: expected ${expected}, got ${actual == null ? actual : Math.round(actual)}`);
  }
}

function runFixtureCase(c: FixtureCase): FixtureCaseResult {
  const failures: string[] = [];
  if (c.kind === "display-delta") {
    // No engine run: the case pins the scenario-card sub-delta
    // helpers directly — the displayed-basis delta, and the
    // raw-basis delta it must NOT be confused with.
    const d = c.displayDelta;
    if (!d) {
      return { id: c.id, kind: c.kind, pass: false, failures: ["display-delta case carries no displayDelta figures"] };
    }
    const exp = c.expected;
    const moneyDelta = displayedMoneyDeltaCents(d.scenarioMoneyCents, d.currentMoneyCents);
    if (exp.moneyDeltaCents !== undefined && moneyDelta !== exp.moneyDeltaCents) {
      failures.push(`moneyDeltaCents: expected ${exp.moneyDeltaCents}, got ${moneyDelta}`);
    }
    const rawMoneyDelta = Math.round(d.scenarioMoneyCents - d.currentMoneyCents);
    if (exp.rawMoneyDeltaCents !== undefined && rawMoneyDelta !== exp.rawMoneyDeltaCents) {
      failures.push(`rawMoneyDeltaCents: expected ${exp.rawMoneyDeltaCents}, got ${rawMoneyDelta}`);
    }
    const rateDeltaTenths = Math.round(displayedRateDeltaPoints(d.scenarioRate, d.currentRate) * 10);
    if (exp.rateDeltaTenths !== undefined && rateDeltaTenths !== exp.rateDeltaTenths) {
      failures.push(`rateDeltaTenths: expected ${exp.rateDeltaTenths}, got ${rateDeltaTenths}`);
    }
    const rawRateDeltaTenths = Math.round((d.scenarioRate - d.currentRate) * 10);
    if (exp.rawRateDeltaTenths !== undefined && rawRateDeltaTenths !== exp.rawRateDeltaTenths) {
      failures.push(`rawRateDeltaTenths: expected ${exp.rawRateDeltaTenths}, got ${rawRateDeltaTenths}`);
    }
    return { id: c.id, kind: c.kind, pass: failures.length === 0, failures };
  }
  const built = buildSimInputs(c.input, { portfolioCents: 0, spendingCents: 0 });
  if (!built) {
    return { id: c.id, kind: c.kind, pass: false, failures: ["buildSimInputs returned null for the pinned inputs"] };
  }
  const { inputs, stocks, expected, vol } = built;
  const exp = c.expected;
  if (c.kind === "projection") {
    const years = Math.max(0, inputs.endAge - inputs.currentAge);
    const returns = Array.from({ length: years }, () => expected);
    const path = simulate(inputs, returns);
    checkCents(failures, "endingCents", path[path.length - 1] ?? 0, exp.endingCents);
    if (exp.grossByAgeCents) {
      const det = simulateDetailed(inputs, returns);
      for (const g of exp.grossByAgeCents) {
        checkCents(
          failures,
          `grossAtAge${g.age}Cents`,
          det.grossWithdrawals[g.age - inputs.currentAge],
          g.cents,
        );
      }
    }
  } else if (c.kind === "historical") {
    const h = runHistorical(inputs, stocks);
    if (!h) {
      failures.push("runHistorical returned null");
    } else {
      if (exp.successRate !== undefined && round1(h.successRate) !== exp.successRate) {
        failures.push(`successRate: expected ${exp.successRate}, got ${round1(h.successRate)}`);
      }
      if (exp.neverOutSuccessRate !== undefined && round1(h.neverOutSuccessRate) !== exp.neverOutSuccessRate) {
        failures.push(`neverOutSuccessRate: expected ${exp.neverOutSuccessRate}, got ${round1(h.neverOutSuccessRate)}`);
      }
      checkCents(failures, "medianEndingCents", h.medianEnding, exp.medianEndingCents);
      checkCents(failures, "worstEndingCents", h.worstEnding, exp.worstEndingCents);
      if (exp.worstStartYear !== undefined && h.worstStartYear !== exp.worstStartYear) {
        failures.push(`worstStartYear: expected ${exp.worstStartYear}, got ${h.worstStartYear}`);
      }
      if (exp.runCount !== undefined && h.count !== exp.runCount) {
        failures.push(`runCount: expected ${exp.runCount}, got ${h.count}`);
      }
      checkCents(failures, "lowestSpendingCents", h.lowestSpending, exp.lowestSpendingCents);
      checkCents(failures, "averageSpendingCents", h.averageSpending, exp.averageSpendingCents);
    }
  } else if (c.kind === "montecarlo") {
    const mc = runMonteCarlo(inputs, expected, vol, c.mcSeed ?? 12345, 1000);
    if (!mc) {
      failures.push("runMonteCarlo returned null");
    } else {
      if (exp.successRate !== undefined && round1(mc.successRate) !== exp.successRate) {
        failures.push(`successRate: expected ${exp.successRate}, got ${round1(mc.successRate)}`);
      }
      if (exp.neverOutSuccessRate !== undefined && round1(mc.neverOutSuccessRate) !== exp.neverOutSuccessRate) {
        failures.push(`neverOutSuccessRate: expected ${exp.neverOutSuccessRate}, got ${round1(mc.neverOutSuccessRate)}`);
      }
      checkCents(failures, "p10Cents", mc.p10, exp.p10Cents);
      checkCents(failures, "p50Cents", mc.p50, exp.p50Cents);
      checkCents(failures, "p90Cents", mc.p90, exp.p90Cents);
      checkCents(failures, "lowestSpendingCents", mc.lowestSpending, exp.lowestSpendingCents);
      checkCents(failures, "averageSpendingCents", mc.averageSpending, exp.averageSpendingCents);
    }
  } else {
    const s = solveMaxSpending(
      inputs,
      stocks,
      expected,
      vol,
      c.solverEngine ?? "historical",
      c.solverTargetPct ?? 95,
      c.mcSeed ?? MONTE_CARLO_TAB_SEED_DEFAULT,
    );
    if (!s) {
      failures.push("solveMaxSpending returned null");
    } else {
      if (exp.solvedSpendingCents !== undefined && s.maxSpendingCents !== exp.solvedSpendingCents) {
        failures.push(`solvedSpendingCents: expected ${exp.solvedSpendingCents}, got ${s.maxSpendingCents}`);
      }
      if (exp.successRate !== undefined && round1(s.successRate) !== exp.successRate) {
        failures.push(`successRate: expected ${exp.successRate}, got ${round1(s.successRate)}`);
      }
      checkCents(failures, "medianEndingCents", s.medianEnding, exp.medianEndingCents);
      if (exp.solvedPercent !== undefined) {
        const actualPct = s.percent == null ? null : Math.round(s.percent * 10000) / 10000;
        if (actualPct !== exp.solvedPercent) {
          failures.push(`solvedPercent: expected ${exp.solvedPercent}, got ${actualPct}`);
        }
      }
      if ((c.solverEngine ?? "historical") === "montecarlo") {
        // Unified-stream assertion: a plan-level Monte Carlo run —
        // the tab's own call, at the case's seed and run count —
        // at the solved spending must reproduce the solver's
        // reported rate and median ending exactly. If the solver
        // ever drifts onto its own stream again, every Monte Carlo
        // solver case fails here even if its pinned values were
        // re-pinned to the wrong stream.
        const solvedInputs =
          inputs.strategy === "percent"
            ? { ...inputs, percentOfPortfolio: s.percent ?? 0 }
            : { ...inputs, spendingCents: s.maxSpendingCents };
        const tab = runMonteCarlo(
          solvedInputs,
          expected,
          vol,
          c.mcSeed ?? MONTE_CARLO_TAB_SEED_DEFAULT,
          MONTE_CARLO_TAB_RUNS,
        );
        if (!tab) {
          failures.push("tab-stream runMonteCarlo returned null at the solved spending");
        } else {
          if (round1(tab.neverOutSuccessRate) !== round1(s.successRate)) {
            failures.push(
              `solver/tab stream mismatch: solver successRate ${round1(s.successRate)}, tab neverOutSuccessRate ${round1(tab.neverOutSuccessRate)} at the solved spending`,
            );
          }
          if (Math.round(tab.p50) !== Math.round(s.medianEnding)) {
            failures.push(
              `solver/tab stream mismatch: solver medianEnding ${Math.round(s.medianEnding)}, tab p50 ${Math.round(tab.p50)} at the solved spending`,
            );
          }
        }
      }
    }
  }
  return { id: c.id, kind: c.kind, pass: failures.length === 0, failures };
}

// Execute every fixture against the live engines. Pass a different
// array only to prove the suite catches a wrong expectation (the
// maintenance scratch check); production runs use the pinned set.
export function runRetirementFixtures(
  fixtures: FixtureCase[] = RETIREMENT_FIXTURES,
): { total: number; passed: number; results: FixtureCaseResult[] } {
  const results = fixtures.map(runFixtureCase);
  return {
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    results,
  };
}

/* ----- External benchmark anchor: the Trinity-style case -----
   The canonical check against the published literature: a
   $1,000,000 portfolio, retire immediately, a 30-year horizon, and
   constant real spending of $40,000/yr (the 4% rule), run through
   the Historical engine at 50/50 and 75/25 stock/bond mixes.

   Published comparison (Cooley, Hubbard & Walz, "Retirement
   Savings: Choosing a Withdrawal Rate That Is Sustainable", AAII
   Journal, Feb 1998 — the Trinity Study), inflation-adjusted
   withdrawals, 30-year payout period, 4% initial withdrawal:
   50/50 succeeded in 95% of periods and 75/25 in 100%.
   Sources: the study's Table 3 as analysed by Wade Pfau,
   "Safe Withdrawal Rates for Retirement and the Trinity Study",
   retirementresearcher.com (the original study's 95% figure for
   the 50/50 mix, and its use of long-term high-grade CORPORATE
   bonds), and the study summary at keepthrifty.com (100% for
   portfolios of 75% stocks or more).

   Exact equality is NOT expected and is not the pass bar: the
   published study replays 1926–1995 Ibbotson data (this app
   replays 1928–2025 Damodaran/BLS data — 69 overlapping 30-year
   windows starting 1928–1996), uses corporate bonds where this
   app blends in the 10-year Treasury, and counts a success as a
   terminal value above zero, as does this engine. The anchor
   passes when each app rate lands in the published neighbourhood
   (within the tolerance below), which is what "explainable by
   window and method" means numerically. */
export const TRINITY_CASE = {
  portfolioCents: 100_000_000, // $1,000,000
  spendingCents: 4_000_000, // $40,000/yr — the 4% rule
  currentAge: 65,
  retirementAge: 65, // retire immediately
  endAge: 95, // 30-year horizon
};
export const TRINITY_PUBLISHED = {
  mix5050SuccessRate: 95,
  mix7525SuccessRate: 100,
  tolerancePoints: 6,
  citation:
    "Cooley, Hubbard & Walz (1998), the Trinity Study, Table 3 (inflation-adjusted, 30-year, 4%): 50/50 = 95%, 75/25 = 100%, on 1926–1995 Ibbotson data with corporate bonds.",
};

export type TrinityResult = {
  mix: string;
  stocksPct: number;
  appSuccessRate: number;
  windows: number;
  publishedSuccessRate: number;
  withinTolerance: boolean;
};

export function runTrinityBenchmark(): TrinityResult[] {
  const mk = (stocksPct: number) =>
    buildSimInputs(
      {
        portfolioCents: TRINITY_CASE.portfolioCents,
        spendingCents: TRINITY_CASE.spendingCents,
        currentAge: TRINITY_CASE.currentAge,
        retirementAge: TRINITY_CASE.retirementAge,
        endAge: TRINITY_CASE.endAge,
        stocksPct,
        extraIncomeCents: null,
        extraIncomeStartAge: null,
        expectedReturnPct: null,
        volatilityPct: null,
        strategy: "constant",
        percentOfPortfolio: 5,
        guardrailsCutPct: null,
        guardrailsRaisePct: null,
        guardrailsAdjustmentPct: null,
      },
      { portfolioCents: 0, spendingCents: 0 },
    );
  const out: TrinityResult[] = [];
  for (const [mix, stocksPct, published] of [
    ["50/50", 50, TRINITY_PUBLISHED.mix5050SuccessRate],
    ["75/25", 75, TRINITY_PUBLISHED.mix7525SuccessRate],
  ] as const) {
    const built = mk(stocksPct);
    const h = built ? runHistorical(built.inputs, built.stocks) : null;
    const rate = h ? round1(h.successRate) : -1;
    out.push({
      mix,
      stocksPct,
      appSuccessRate: rate,
      windows: h?.count ?? 0,
      publishedSuccessRate: published,
      withinTolerance:
        h != null && Math.abs(rate - published) <= TRINITY_PUBLISHED.tolerancePoints,
    });
  }
  return out;
}

// Teeth check: corrupt ONE expected value in ONE case by a single
// cent and confirm exactly that case — and no other — fails. Runs
// on every self-check, so the suite continuously proves it would
// catch a one-cent drift.
export function runRetirementTeethCheck(): {
  corruptedCaseId: string;
  failedCount: number;
  pass: boolean;
} {
  const corruptedCaseId = "proj-constant-base";
  const corrupted = RETIREMENT_FIXTURES.map((c) =>
    c.id === corruptedCaseId
      ? { ...c, expected: { ...c.expected, endingCents: (c.expected.endingCents ?? 0) + 1 } }
      : c,
  );
  const r = runRetirementFixtures(corrupted);
  const failed = r.results.filter((x) => !x.pass);
  return {
    corruptedCaseId,
    failedCount: failed.length,
    pass: failed.length === 1 && failed[0]?.id === corruptedCaseId,
  };
}
