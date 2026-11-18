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

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((p / 100) * sorted.length)),
  );
  return sorted[idx] ?? 0;
}
export function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

// Horizon convention (engine-calendar fix F6, build v99):
// a plan's priced years are the years from the current age
// THROUGH the end age, inclusive — the end-age year is priced
// and its return is applied, so the ending balance is the
// value AFTER the end-age year. This is the Roth plan engine's
// convention (its march loops while year − birthYear <=
// endAge, applying a growth step at each loop tail), and the
// Retirement engines are aligned to it so the same span prices
// the same number of years on every surface: a plan from age
// 55 to age 95 runs 41 priced years, not 40. Every end-age-
// bound loop in this file derives its year count from this
// one helper — simulateDetailed (Projection), runNeverRunsOut
// (the solver's feasibility twin), runHistorical, runMonteCarlo,
// and solveGuardrailsScan (the Max Spending solver's scan) —
// so the surfaces cannot drift apart again. The one count
// that does NOT come from here is the guardrails scan's
// pre-retirement year count (retirement age − current age,
// capped at the horizon): those are the years BEFORE the
// first retired year, a window bound rather than an end-age
// bound — the cap only bites when retirement is at or past
// the end age, a combination solveMaxSpending refuses at
// entry, so the inclusive horizon leaves it unchanged.
export function horizonYears(currentAge: number, endAge: number): number {
  return Math.max(0, endAge - currentAge + 1);
}

// Deterministic PRNG so a Monte Carlo batch is stable until Re-run.
// Exported (Engine Review C5, C5-S2): the Roth engine's stream
// helpers are the same mulberry32 + Box–Muller pair, imported from
// here rather than replicated — one implementation, one sequence.
// The algorithm itself is unchanged: the same seed draws the same
// values as before the unification, pinned by the mc-golden-shocks
// fixture's externally computed shock literals.
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function normalRandom(rng: () => number): number {
  // Box–Muller
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// ----- Monte Carlo input validation (Engine Review C5, C5-M1) -----
// The core Monte Carlo entry points used to accept any run count,
// seed, and return/volatility a direct caller passed: a 0 or NaN
// run count returned a successful-looking result with NaN success
// rates and zero medians, a negative count read as a 0% failed
// plan, a fractional count silently ran ceil(N) runs, an infinite
// count never returned (unbounded allocation), a NaN/Infinity or
// fractional seed silently collapsed to the seed-0 stream
// (`seed >>> 0`), and NaN/Infinity/negative return or volatility
// values priced NaN balances with self-contradictory success
// rates. The API layer already constrains its own calls (fixed
// 250-path Roth counts, zod volatility 0–100, adapter mcRuns
// 10–5000 / integer seed), so these guards are defense in depth
// at the core — every direct caller gets the same explicit
// rejection, and no valid call changes behavior. The errors are
// RangeErrors: invalid Monte Carlo parameters are programmer
// errors, not a "no answer" horizon (which keeps returning null).
// The bounds: MAX_MONTE_CARLO_RUNS is 10× the 1,000-run tab
// default, so every legitimate tab/solver/adapter call (≤ 5,000)
// is untouched; the Roth path cap lives with the Roth engine
// (MAX_ROTH_MONTE_CARLO_PATHS, 4× its 250-path default).
export const MAX_MONTE_CARLO_RUNS = 10000;
export function validateMonteCarloSeed(seed: number): void {
  if (!Number.isInteger(seed)) {
    throw new RangeError(
      `Monte Carlo seed must be a finite integer, got ${seed}.`,
    );
  }
}
export function validateMonteCarloRunCount(
  runCount: number,
  maxRuns: number = MAX_MONTE_CARLO_RUNS,
): void {
  if (!Number.isInteger(runCount) || runCount < 1 || runCount > maxRuns) {
    throw new RangeError(
      `Monte Carlo run count must be a whole number from 1 to ${maxRuns}, got ${runCount}.`,
    );
  }
}
export function validateMonteCarloReturn(expected: number, vol: number): void {
  if (!Number.isFinite(expected)) {
    throw new RangeError(
      `Monte Carlo expected return must be a finite number, got ${expected}.`,
    );
  }
  if (!Number.isFinite(vol) || vol < 0) {
    throw new RangeError(
      `Monte Carlo volatility must be a finite number at or above 0, got ${vol}.`,
    );
  }
}
export function validateMonteCarloVolatilityPct(volatilityPct: number): void {
  if (
    !Number.isFinite(volatilityPct) ||
    volatilityPct < 0 ||
    volatilityPct > 100
  ) {
    throw new RangeError(
      `Monte Carlo volatility must be between 0 and 100 percent, got ${volatilityPct}.`,
    );
  }
}

export type SpendingStrategy = "constant" | "percent" | "guardrails" | "phased";

// Guardrails knobs: the professional defaults are the values the
// strategy used when they were fixed (cut above 120% of the
// starting withdrawal rate, raise below 80%, ±10% steps).
export const GUARDRAILS_CUT_DEFAULT = 120;
export const GUARDRAILS_RAISE_DEFAULT = 80;
export const GUARDRAILS_ADJUSTMENT_DEFAULT = 10;

// Guardrails rail tolerance (Prompt 13 fix, build v40): the
// documented rule is STRICT — a cut fires only when the current
// withdrawal rate is strictly above the cut rail, a raise only
// when it is strictly below the raise rail, and a rate exactly
// AT a rail fires neither. The rails are computed as
// (pct / 100) * initialRate in IEEE-754 floating point, and at
// exact mathematical equality that product can land about one
// ulp on the wrong side of the current rate — verified:
// (120 / 100) * (200000 / 1200000) = 0.19999999999999998 < 0.2
// (a spurious cut) and (80 / 100) * 0.2 = 0.16000000000000003
// > 0.16 (a spurious raise). The comparisons therefore treat a
// rate within this RELATIVE tolerance of a rail as AT the rail.
// The representation error in the rail products is at most a
// few ulps (~1e-15 relative); 1e-9 is roughly a million times
// that error, yet far smaller than any economically
// distinguishable rate difference — so every rate past a rail
// by more than the tolerance fires exactly as before, in size,
// in count (at most one adjustment per year), and in
// compounding. The same tolerance is published in describeApi's
// guardrailsSemantics convention (apiContractCore.ts).
export const GUARDRAILS_RATE_REL_TOLERANCE = 1e-9;

// The ONE guardrails comparison, shared by simulateDetailed and
// runNeverRunsOut so the simulator and the max-spending solver
// can never disagree at a rail: returns the year's spending
// level after at most one tolerance-aware rail adjustment.
function guardrailsAdjustedSpending(
  currentSpending: number,
  bal: number,
  initialRate: number,
  inputs: SimInputs,
): number {
  if (bal <= 0 || initialRate <= 0) return currentSpending;
  const curRate = currentSpending / bal;
  const adj = inputs.guardrailsAdjustmentPct / 100;
  const cutThreshold = (inputs.guardrailsCutPct / 100) * initialRate;
  const raiseThreshold = (inputs.guardrailsRaisePct / 100) * initialRate;
  if (
    curRate - cutThreshold >
    Math.abs(cutThreshold) * GUARDRAILS_RATE_REL_TOLERANCE
  ) {
    return Math.round(currentSpending * (1 - adj));
  }
  if (
    raiseThreshold - curRate >
    Math.abs(raiseThreshold) * GUARDRAILS_RATE_REL_TOLERANCE
  ) {
    return Math.round(currentSpending * (1 + adj));
  }
  return currentSpending;
}

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
// Factory default for Expected return — what a fresh start seeds
// and what Reset to defaults restores. The blended return (6.75%
// at the 95% stocks mix) proved too optimistic, so the default is
// a flat 5% (build v132). Volatility still defaults to the
// blend. A saved expected return is always used exactly as saved;
// this value only ever fills a blank / never-set field.
export const EXPECTED_RETURN_DEFAULT = 5;

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

// One future fixed income stream in the portfolio simulation
// (a Social Security benefit, a pension, any fixed annual income
// that starts in a known year). startAge is on the PRIMARY's age
// timeline — the age the primary person is in the calendar year
// the stream starts (a spouse's claiming age converted through
// the two birth years); null means the stream starts at
// retirementAge. Amounts are integer cents per year.
export type IncomeStream = {
  amountCents: number;
  startAge: number | null;
};

// The income active in a modeled year (age on the primary's
// timeline). With a schedule present, the sum of its streams
// whose start age has been reached; without one, the legacy
// single stream. THE single income rule for the simulation —
// simulateDetailed, runNeverRunsOut, and every path built on
// them read income only through here, so the deterministic,
// historical, Monte Carlo, success-only, and solver paths can
// never disagree about what a year pays.
//
// INTENTIONAL LIMITATION (Engine Review 1, E1-S2 — retained
// behavior, not a defect): income is only ever read inside a
// RETIRED year (age >= retirementAge, see simulateDetailed and
// runNeverRunsOut). A stream that starts BEFORE retirement —
// Social Security claimed while still working, say — is NOT
// accumulated into the portfolio in the pre-retirement years:
// this simulation has no pre-retirement spending model, no
// salary, and no taxes, so banking the gross benefit before
// retirement would fabricate savings by assuming the whole
// benefit was saved while the pre-retirement years' own
// spending was funded from nowhere. The same start age read
// AT retirement prices identically (the stream simply becomes
// active in the first retired year), and a stream starting
// after the end age never pays within the plan. The accurate
// path for benefits already being collected in work years is
// the Roth view's Work-years tab (server/src/workYears.ts),
// which deposits the benefit, prices §86 tax on it, and lands
// the cash surplus in Taxable at year end — use that surface
// for pre-retirement income, not this sim.
export function incomeCentsAt(inputs: SimInputs, age: number): number {
  const sched = inputs.incomeSchedule;
  if (sched && sched.length > 0) {
    let total = 0;
    for (const s of sched) {
      const start = s.startAge ?? inputs.retirementAge;
      if (age >= start) total += s.amountCents;
    }
    return total;
  }
  return inputs.extraIncomeStartAge != null &&
    age >= inputs.extraIncomeStartAge
    ? inputs.extraIncomeCents
    : 0;
}

// The income eventually active within the plan horizon — the
// amount the max-spending solver's scan ceiling adds to the best
// balance at retirement. A stream starting after the end age
// never pays within the plan and is excluded; a null startAge
// stream starts at retirement, so it counts. Without a schedule,
// the legacy rule: the single stream's amount whenever it has a
// start age.
export function eventualIncomeCents(inputs: SimInputs): number {
  const sched = inputs.incomeSchedule;
  if (sched && sched.length > 0) {
    let total = 0;
    for (const s of sched) {
      const start = s.startAge ?? inputs.retirementAge;
      if (start <= inputs.endAge) total += s.amountCents;
    }
    return total;
  }
  return inputs.extraIncomeStartAge != null ? inputs.extraIncomeCents : 0;
}

export type SimInputs = {
  startCents: number;
  spendingCents: number;
  currentAge: number;
  retirementAge: number;
  endAge: number;
  extraIncomeCents: number; // 0 = none
  extraIncomeStartAge: number | null;
  // Optional multi-stream income schedule. When present and
  // non-empty it REPLACES the legacy single extraIncome stream
  // for the simulation (see incomeCentsAt): a household with two
  // Social Security benefits, or a pension plus SS, is modeled
  // here, each stream starting at its own start age on the
  // primary's age timeline. Callers that omit it keep the exact
  // legacy behavior. The legacy fields stay populated (earliest
  // stream) so readers that do not know the schedule see the
  // same values as before.
  incomeSchedule?: IncomeStream[];
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
  // Optional minimum-annual-spending floor, in cents per year
  // (Engine Review 1, E1-S1). Null / absent = no floor, and the
  // adequacy rate below is null with it. When set, the
  // spending-adequacy rate is the share of runs in which EVERY
  // retired year's GROSS spending met or beat the floor (see
  // spendingAdequacyRate). The floor is evaluated on GROSS
  // spending — the strategy's spending level before the
  // extra-income offset — not on what was actually received or
  // on the net withdrawal. That distinction matters for the
  // constant strategy, whose gross never varies: with the floor
  // at or below the spending input its adequacy reads 100%
  // even in runs where withdrawals went unfunded, so adequacy
  // must always be read BESIDE the never-runs-out rate, never
  // instead of it.
  minimumAnnualSpendingCents?: number | null;
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
//   current balance) is compared against the user's knobs:
//   STRICTLY above guardrailsCutPct % of the initial rate spending
//   is cut by guardrailsAdjustmentPct %, STRICTLY below
//   guardrailsRaisePct % it is raised by the same % — a rate
//   exactly at a rail fires neither, with the comparisons
//   carrying the documented relative tolerance
//   GUARDRAILS_RATE_REL_TOLERANCE so IEEE-754 rounding of the
//   rail products cannot fire an adjustment at exact equality —
//   at most one adjustment per year, and the adjusted level
//   carries into following years. At the professional defaults
//   (120 / 80 / 10) this is exactly the original fixed 1.2× /
//   0.8× band with ±10% steps.
// - phased: the annual spending input scaled by the step-down
//   factor for the year (see phasedGrossCents): full spending
//   through phaseStartAge, then a decline of phaseDeclinePct %
//   a year in today's dollars, applied to the gross BEFORE the
//   extra-income offset, exactly where Constant applies the
//   spending input.
export type SimDetailed = {
  balances: number[]; // length years+1, starting at currentAge (years = the inclusive horizon, see horizonYears)
  grossWithdrawals: number[]; // per year: gross spending (0 pre-retirement)
  netWithdrawals: number[]; // per year: gross − extra income (what leaves the portfolio)
};

export function simulateDetailed(inputs: SimInputs, returns: number[]): SimDetailed {
  const years = horizonYears(inputs.currentAge, inputs.endAge);
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
      const income = incomeCentsAt(inputs, age);
      if (inputs.strategy === "percent") {
        gross = Math.round(bal * (inputs.percentOfPortfolio / 100));
      } else if (inputs.strategy === "guardrails") {
        if (initialRate == null) {
          initialRate = bal > 0 ? inputs.spendingCents / bal : 0;
          currentSpending = inputs.spendingCents;
        }
        currentSpending = guardrailsAdjustedSpending(
          currentSpending,
          bal,
          initialRate,
          inputs,
        );
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

// The never-runs-out verdict read off a detailed run (Engine
// Review C5, C5-S1): runNeverRunsOut's year loop IS
// simulateDetailed's year loop with the funding test taken
// before each withdrawal, and the two loops evolve the balance
// identically (same withdrawal, same floors, same return step)
// — so the detailed run's own arrays decide the same verdict:
// a retired year whose net withdrawal exceeds the balance on
// hand at its start fails the run. The first such year is the
// first year either loop floors the balance, so the balances
// agree at every year-start up to and including it, and the
// verdict is settled there. runMonteCarlo and runHistorical
// used to price every run twice — once detailed, once
// success-only — for the same answer; they now read it off the
// detailed run they already have (measured: the sim phase of a
// 1,000-run batch drops ~45%, probe-phase6b/c). runNeverRunsOut
// itself is unchanged and still serves the max-spending
// solver's scan, where no detailed run exists to read from.
// Pinned by retirementReviewC5.test.ts (derived verdict vs
// runNeverRunsOut on every MC-drawn vector, all strategies).
export function neverRunsOutFromDetailed(
  det: SimDetailed,
  inputs: SimInputs,
): boolean {
  for (let i = 0; i < det.netWithdrawals.length; i++) {
    if (inputs.currentAge + i < inputs.retirementAge) continue;
    if ((det.netWithdrawals[i] ?? 0) > (det.balances[i] ?? 0)) return false;
  }
  return true;
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
  const years = horizonYears(inputs.currentAge, inputs.endAge);
  let bal = inputs.startCents;
  let currentSpending = inputs.spendingCents;
  let initialRate: number | null = null;
  for (let i = 0; i < years; i++) {
    const age = inputs.currentAge + i;
    if (age >= inputs.retirementAge) {
      const income = incomeCentsAt(inputs, age);
      let gross: number;
      if (inputs.strategy === "percent") {
        gross = Math.round(bal * (inputs.percentOfPortfolio / 100));
      } else if (inputs.strategy === "guardrails") {
        if (initialRate == null) {
          initialRate = bal > 0 ? inputs.spendingCents / bal : 0;
          currentSpending = inputs.spendingCents;
        }
        currentSpending = guardrailsAdjustedSpending(
          currentSpending,
          bal,
          initialRate,
          inputs,
        );
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

// Spending-adequacy rate (Engine Review 1, E1-S1): the share of
// runs in which EVERY retired year's GROSS spending met or beat
// the minimum-annual-spending floor. Null when no floor is set
// (or the floor is 0 / negative) or when no run has a retired
// year — a plan with no retired years has no spending to judge.
// Computed from the per-run gross withdrawals the engines
// already record, so the historical and Monte Carlo runners
// share this one implementation and can never disagree about
// what "adequate" means. Read it beside neverOutSuccessRate,
// never instead of it: adequacy asks whether the strategy's
// spending LEVEL held the floor, funding asks whether each
// year's withdrawal was actually funded. A percent-strategy
// run can fund every year at 100% while its spending collapses
// far below the floor (adequacy near 0); a constant-strategy
// run can read adequacy 100% — its gross never varies — while
// its withdrawals went unfunded (neverOut below 100%). Either
// rate alone overstates the plan; the pair states it.
export function spendingAdequacyRate(
  inputs: SimInputs,
  runsGross: number[][],
): number | null {
  const floor = inputs.minimumAnnualSpendingCents;
  if (floor == null || floor <= 0) return null;
  let adequate = 0;
  let counted = 0;
  for (const gross of runsGross) {
    const retired = gross.filter(
      (_, i) => inputs.currentAge + i >= inputs.retirementAge,
    );
    if (retired.length === 0) continue;
    counted++;
    if (retired.every((g) => g >= floor)) adequate++;
  }
  if (counted === 0) return null;
  return (adequate / counted) * 100;
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
  // Spending-adequacy rate (Engine Review 1, E1-S1): the share
  // of runs in which EVERY retired year's GROSS spending met or
  // beat the minimum-annual-spending floor — null when no floor
  // is set. Funding success (neverOutSuccessRate) and adequacy
  // are different questions: a percent-strategy plan can fund
  // every year while its spending collapses below the floor,
  // and a constant-strategy plan can read adequacy 100% while
  // its withdrawals went unfunded. Read the two rates together.
  spendingAdequacySuccessRate: number | null;
  // The floor that rate is measured against, echoed so a reader
  // never has to guess which floor a rate belongs to; null
  // means no floor was set.
  minimumAnnualSpendingCents: number | null;
};

export function runHistorical(inputs: SimInputs, stocksPct: number): HistResult | null {
  const planYears = horizonYears(inputs.currentAge, inputs.endAge);
  if (planYears <= 0) return null;
  const allReturns = historicalRealReturns(stocksPct);
  const lastYear = HISTORICAL[HISTORICAL.length - 1]?.year ?? 0;
  const runs: HistRun[] = [];
  let neverOut = 0;
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
    // C5-S1: the never-runs-out verdict is read off the
    // detailed run (neverRunsOutFromDetailed), not
    // re-simulated — see the helper for the equivalence proof.
    if (neverRunsOutFromDetailed(det, inputs)) neverOut++;
  }
  if (runs.length === 0) return null;
  const endings = runs.map((r) => r.ending);
  const successes = endings.filter((e) => e > 0).length;
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
    spendingAdequacySuccessRate: spendingAdequacyRate(
      inputs,
      runs.map((r) => r.grossWithdrawals),
    ),
    minimumAnnualSpendingCents:
      inputs.minimumAnnualSpendingCents ?? null,
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
  // Spending-adequacy rate (Engine Review 1, E1-S1) — see
  // HistResult.spendingAdequacySuccessRate; null when no floor
  // is set. The floor it is measured against, echoed beside it.
  spendingAdequacySuccessRate: number | null;
  minimumAnnualSpendingCents: number | null;
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
  validateMonteCarloRunCount(runCount);
  validateMonteCarloSeed(seed);
  validateMonteCarloReturn(expected, vol);
  const planYears = horizonYears(inputs.currentAge, inputs.endAge);
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
    // C5-S1: the never-runs-out verdict is read off the
    // detailed run (neverRunsOutFromDetailed), not re-simulated.
    if (neverRunsOutFromDetailed(det, inputs)) neverOut++;
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
    spendingAdequacySuccessRate: spendingAdequacyRate(inputs, runsGross),
    minimumAnnualSpendingCents:
      inputs.minimumAnnualSpendingCents ?? null,
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
   scan walks DOWN from the ceiling and stops at the first feasible
   step — which is the maximum under non-monotonicity — and each
   step first passes a first-year feasibility filter (a step whose
   first-year net withdrawal exceeds all but fewer-than-needed
   runs' retirement balances is provably infeasible without
   simulating); both preserve the exact answer (Engine Review C5,
   Phase 6). The scan stops at a proven ceiling, and the ceiling
   depends on the cut rail: in the first retired year the current
   rate equals the initial rate, so the cut rail fires exactly
   when guardrailsCutPct < 100 and the raise rail exactly when
   guardrailsRaisePct > 100 (up to the 1e-9 relative rail
   tolerance, which only matters within a hair of a rail). When
   cut >= 100 no cut fires, so the year-1 gross is the base
   spending itself or larger (a raise only increases it), and
   that year's net withdrawal is the base spending minus at most
   the extra income — a spending strictly above the best run's
   balance at retirement plus the extra income fails every run
   in year one. When cut < 100 the cut fires in year 1 and the
   year-1 gross is round(cents * (1 - adj)), so the ceiling is
   that same balance-plus-income total DIVIDED by the year-1
   cut factor (1 - adj), with slack for the rounding and the
   step floor (Engine Review C5, fix round 2, Pass B MUST-1:
   the undivided ceiling understated the maximum on an
   income-dominated plan). With adj >= 100 the year-1 cut
   zeroes the spending, so no finite year-1 ceiling exists and
   the search cap is the only bound.
   The spending exactly AT that ceiling is different: at the
   undivided ceiling its first-year net withdrawal exactly
   equals the best run's balance, an exactly funded withdrawal
   is not short, and a plan whose later years are covered by
   the income can succeed there — so the scan INCLUDES the
   ceiling step and lets runNeverRunsOut decide it, like every
   other step (Prompt 13 fix, build v40).
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
   $48,000/yr of SS income from 67 "solved" to nearly the full income at 100%
   success, its median run refilled to a small positive ending after a
   decade at $0). The median ending still comes from the same
   runs' ending balances, refill and all — only the success count
   changed. Feasibility stays monotone in the search variable
   under this predicate (a smaller withdrawal leaves a weakly
   larger balance at every year of the same return sequence, so a
   run fundable at one spending is fundable at any lower one),
   which is what the binary searches below rely on.

   Feasibility metadata (Engine Review 2, E2-S1): every SolverResult
   also says whether the returned spending actually meets the
   requested target — targetSuccessRate (the requested target, in
   percent units), achievedSuccessRate (mirrors successRate),
   targetAchieved (achieved >= target), and solutionStatus:
   - "feasible": a positive spending meets the target.
   - "feasible_at_zero": $0/yr meets the target but no positive
     $100 step does — $0 IS the highest sustainable spending.
   - "infeasible_at_zero": even $0/yr misses the target, so the
     returned $0 is NOT a sustainable spending — no spending level
     reaches the target. Unreachable through validated inputs
     today (at $0 every run succeeds, so the $0 rate is 100%),
     reachable only by a direct call with an out-of-range target
     (>100); the distinction still belongs in the type so no
     consumer can mistake a $0 for meeting the target.
   - "capped": the returned spending is the search cap and the cap
     itself meets the target — the percent leg's 30%-of-portfolio
     cap, or the constant/phased/guardrails search cap (twice the
     starting portfolio, floored at $1,000,000/yr). A capped
     answer is the cap, not a proven maximum above it. */
export type SolverSolutionStatus =
  | "feasible"
  | "feasible_at_zero"
  | "infeasible_at_zero"
  | "capped";

export type SolverResult = {
  maxSpendingCents: number;
  successRate: number;
  medianEnding: number;
  percent: number | null; // set only for the percent strategy
  approximate: boolean;
  // Feasibility metadata — see the solver note above. Percent
  // units throughout (0–100), matching successRate and the
  // requested targetPct; targetAchieved is achieved >= target.
  targetSuccessRate: number;
  achievedSuccessRate: number;
  targetAchieved: boolean;
  solutionStatus: SolverSolutionStatus;
};

// The one constructor for SolverResult, so every return site
// carries the same feasibility metadata from the same derivation:
// achieved mirrors successRate, targetAchieved is the comparison
// against the requested target, and the status is the caller's
// classification of which branch produced the answer.
function solverResult(args: {
  maxSpendingCents: number;
  successRate: number;
  medianEnding: number;
  percent: number | null;
  approximate: boolean;
  targetPct: number;
  solutionStatus: SolverSolutionStatus;
}): SolverResult {
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
  const planYears = horizonYears(base.currentAge, base.endAge);
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
    // First-year filter (Engine Review C5, Phase 6; threshold
    // corrected in the C5 fix round): the first retired year's
    // guardrails gross is the base spending itself ONLY when
    // cut >= 100 and raise <= 100 (within the documented
    // relative tolerance). In year 1 the current rate equals
    // the initial rate — the initial rate is set from the base
    // spending over the balance at retirement — so a rail
    // fires exactly when its knob crosses 100: the cut rail
    // when guardrailsCutPct < 100, the raise rail when
    // guardrailsRaisePct > 100. The cut is checked first, so
    // with cut < 100 the year-1 gross is
    // round(cents * (1 - adj)) when the cut fires, and the base
    // spending (or the raise gross) when it does not fire —
    // tolerance edge or zero balance. The filter must therefore
    // bound the TRUE first-year net from below, so firstYearGross
    // is the SMALLEST gross any run can take: the base spending,
    // the cut gross when cut < 100, the raise gross when
    // raise > 100, whichever is least. For adj >= 0 that minimum
    // is the cut gross when cut < 100 and the base spending
    // otherwise (the raise side only ever increases the gross
    // for adj >= 0); for adj < 0 (direct call only; the app
    // clamps adj to 1..50) the raise gross is the smallest, and
    // pricing the base spending instead would overstate the
    // year-1 net and reject feasible steps. A naive
    // Math.max(0, adj) mirror-guard would still price the base
    // spending on the raise side and stay low by the raise factor —
    // at the probed adj −10 it was 10% low (solver $100,000 vs
    // grid $111,100), and the solver value scales as (1 + adj), so
    // adj −50 would be ~50% low — the
    // raise gross is the true minimum (Engine Review C5, NICE-5).
    // The earlier version
    // of this filter assumed the gross was always the base
    // spending and so overstated the net — and undercounted
    // the runs that can pass year 1 — whenever cut < 100.
    // A run whose balance at retirement is below that net
    // fails in year one, whatever later years would do. The
    // runs that can possibly succeed at this step are exactly
    // those with retBal >= firstYearNet; if fewer than the
    // needed count exist, the step is provably infeasible
    // without simulating a single run. The bound is an UPPER
    // bound on successes, never a lower one: passing the filter
    // proves nothing, so every step that passes is still
    // decided by runNeverRunsOut below.
    // Engine Review C5, NICE-5: firstYearGross is the minimum
    // over the applicable year-1 grosses (base spending, cut
    // gross when cut < 100, raise gross when raise > 100). That
    // minimum is the cut gross when cut < 100 and the base
    // spending otherwise for adj >= 0 — exactly the previous
    // formula — and the raise gross for adj < 0 when the raise
    // fires, which is the true minimum there. Identity for
    // adj >= 0.
    const firstYearGross = Math.min(
      cents,
      ...(base.guardrailsCutPct < 100
        ? [
            Math.round(
              cents * (1 - base.guardrailsAdjustmentPct / 100),
            ),
          ]
        : []),
      ...(base.guardrailsRaisePct > 100
        ? [
            Math.round(
              cents * (1 + base.guardrailsAdjustmentPct / 100),
            ),
          ]
        : []),
    );
    const firstYearNet = firstYearGross - firstYearIncome;
    if (firstYearNet > 0) {
      let lo = 0;
      let hi = sortedRetBals.length;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if ((sortedRetBals[mid] ?? 0) < firstYearNet) lo = mid + 1;
        else hi = mid;
      }
      if (sortedRetBals.length - lo < needed) return false;
    }
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
  // (The no-retired-years case never reaches this scan:
  // solveMaxSpending refuses it at entry — build v66, F6.)
  // Proven ceiling (see the solver note above): no spending
  // strictly above the ceiling can succeed — the best balance
  // at retirement plus the extra income when cut >= 100, that
  // total divided by the year-1 cut factor (1 - adj) when cut
  // < 100 and adj < 100 (the cut fires in year 1, so the gross
  // is round(cents * (1 - adj))), and the search cap when cut
  // < 100 and adj >= 100 (the year-1 cut zeroes the spending,
  // so no finite year-1 ceiling exists). When cut >= 100 and
  // raise > 100 and adj < 0 (Engine Review C5, NICE-5), the
  // total is divided by the year-1 raise factor (1 + adj)
  // instead (the raise fires in year 1, so the gross is
  // round(cents * (1 + adj)) — the undivided bound would cut
  // the scan short there, and bound the scanSteps = 0 edge);
  // the search cap when cut >= 100 and adj <= -100 (the
  // year-1 raise zeroes the spending, so no finite year-1
  // ceiling exists). The spending exactly
  // AT that ceiling can succeed — an exactly funded first-year
  // withdrawal is not short, and a plan whose later years are
  // covered by the income can succeed there — so the scan bound
  // is INCLUSIVE of the ceiling step (Prompt 13 fix, build v40;
  // the bound previously subtracted one cent and never tested
  // that step).
  // Feasibility of the endpoint, like every scanned step, is
  // decided by runNeverRunsOut. The income term is the eventual
  // income — the amount itself whenever it has a start age —
  // NOT just the income active in the first retired year: a
  // later-starting income larger than the spending revives a
  // zeroed balance, so a first-year-income ceiling would cut
  // the scan short and understate the maximum. With an income
  // schedule the eventual income is the sum of every stream
  // starting within the horizon (see eventualIncomeCents).
  // preYears is a window count, not an end-age count: the
  // years strictly before the first retired year, grown to
  // find the best balance AT retirement. The inclusive
  // horizon (F6) does not add a year here — the year at the
  // retirement age is a retired year, not a pre-retirement
  // one — and the planYears cap binds only when retirement
  // is at or past the end age, which solveMaxSpending
  // refuses before this scan runs.
  const preYears = Math.max(
    0,
    Math.min(planYears, base.retirementAge - base.currentAge),
  );
  const eventualIncome = eventualIncomeCents(base);
  // Balance at the start of the first retired year, per run —
  // the starting balance grown through the pre-retirement years
  // (no withdrawals before retirement, and no income banked
  // before retirement either — see incomeCentsAt). Collected
  // here for the ceiling (its max) and, sorted, for the
  // first-year feasibility filter in feasible() below.
  const retBals: number[] = [];
  let maxRetBal = 0;
  for (const returns of runReturns) {
    let b = base.startCents;
    for (let i = 0; i < preYears; i++) {
      b = b * (1 + (returns[i] ?? 0));
      if (b < 0) b = 0;
    }
    retBals.push(b);
    if (b > maxRetBal) maxRetBal = b;
  }
  const sortedRetBals = [...retBals].sort((a, b) => a - b);
  // Income active in the first retired year — the first age at
  // or after the retirement age inside the horizon (when the
  // retirement age is already past, the first modeled year is
  // the current age).
  const firstRetiredAge = Math.max(base.currentAge, base.retirementAge);
  const firstYearIncome = incomeCentsAt(base, firstRetiredAge);
  // Year-1 cut factor: with cut < 100 the year-1 gross is at
  // least round(cents * (1 - adj)) — when the cut fires that is
  // the gross exactly; when it does not fire (tolerance edge or
  // zero balance) the gross is the base spending or the raise
  // gross, both larger for adj >= 0 — so a step with cents
  // above (maxRetBal + eventualIncome + 0.5) / (1 - adj) has a
  // year-1 net above every run's retirement balance and is
  // provably infeasible. The +1 cent covers the Math.round
  // slack and the +1 step covers the floor. A negative adj
  // (raw direct call only; the app clamps adj to 1..50) would
  // make the factor exceed 1 and shrink the ceiling below the
  // sound undivided bound, so the factor is floored at 1 via
  // Math.max(0, adj); adj >= 100 zeroes the year-1 gross, so
  // no finite year-1 ceiling exists and the search cap is the
  // only bound.
  const cutFactor =
    1 - Math.max(0, base.guardrailsAdjustmentPct) / 100;
  // Engine Review C5, NICE-5: the raise factor, parallel to
  // cutFactor — the year-1 gross factor when the raise fires.
  // For adj >= 0 it is >= 1, so the undivided bound below is
  // already sound and nothing changes; for adj < 0 with
  // raise > 100 it is (1 + adj) < 1, and the undivided bound
  // would cut the scan short — the ceiling divides by it,
  // exactly as the cut side divides by cutFactor (including
  // the +1 cent of Math.round slack and the +1 step for the
  // floor). It also bounds the scanSteps = 0 edge: with
  // maxRetBal + eventualIncome < $100 the divided bound still
  // yields at least one step when the raise-shrunk $100 gross
  // can pass year 1. A raise factor at or below 0 (adj <= -100)
  // zeroes the year-1 gross, so no finite ceiling exists and
  // the search cap is the only bound. Identity for adj >= 0.
  const raiseFactor =
    base.guardrailsRaisePct > 100
      ? 1 + base.guardrailsAdjustmentPct / 100
      : 1;
  const scanSteps =
    base.guardrailsCutPct < 100 && cutFactor > 0
      ? Math.min(
          capSteps,
          Math.max(
            0,
            Math.floor(
              (maxRetBal + eventualIncome + 1) / (STEP * cutFactor),
            ) + 1,
          ),
        )
      : base.guardrailsCutPct < 100
        ? capSteps
        : raiseFactor > 0 && raiseFactor < 1
          ? Math.min(
              capSteps,
              Math.max(
                0,
                Math.floor(
                  (maxRetBal + eventualIncome + 1) / (STEP * raiseFactor),
                ) + 1,
              ),
            )
          : raiseFactor <= 0
            ? capSteps
            : Math.min(
                capSteps,
                Math.max(0, Math.floor((maxRetBal + eventualIncome) / STEP)),
              );
  // Descending scan (Engine Review C5, Phase 6): the scan used
  // to walk k = 1..scanSteps and keep the largest feasible step.
  // Under non-monotonicity that tests every step — including the
  // whole feasible region, where each low step scans ~needed
  // runs to confirm. Walking DOWN from the ceiling instead, the
  // FIRST feasible step found IS the maximum feasible step, so
  // the scan stops there: the steps above it are all infeasible
  // (each decided cheaply — by the first-year filter, or by
  // failing in the first retired year) and no step below it can
  // beat it. The answer is identical by construction; when no
  // step is feasible the scan tests them all and best stays 0,
  // exactly as before. Measured on the bench plan in
  // probe-phase6.ts; the best itself is recorded in
  // bench-after.log. The filter cuts the infeasible tail
  // further still — see bench-after.
  let best = 0;
  for (let k = scanSteps; k >= 1; k--) {
    if (feasible(k * STEP)) {
      best = k;
      break;
    }
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
  // Status: the scan only runs after solveMaxSpending has checked
  // the $0 rate meets the target, so a best of 0 is feasible_at_zero
  // (the winner rate confirms it); the cap binds only when the scan
  // was cut short by capSteps itself (scanSteps == capSteps) and the
  // cap step is the winner — a scan that ran to its proven ceiling
  // (scanSteps < capSteps) found the true maximum, cap or no cap.
  // The winner-rate check is defensive: the scan's feasibility and
  // evaluatePlan score by the same predicate, so they agree.
  const solutionStatus: SolverSolutionStatus =
    winner.successRate < targetPct
      ? "infeasible_at_zero"
      : best === scanSteps && scanSteps === capSteps
        ? "capped"
        : best === 0
          ? "feasible_at_zero"
          : "feasible";
  return solverResult({
    maxSpendingCents: best * STEP,
    successRate: winner.successRate,
    medianEnding: winner.medianEnding,
    percent: null,
    approximate,
    targetPct,
    solutionStatus,
  });
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
  // The seed is validated up front: the Monte Carlo legs reach
  // runMonteCarlo (which validates it) but the historical leg
  // never does, so without this a NaN seed would silently solve
  // on the historical engine.
  validateMonteCarloSeed(mcSeed);
  // Engine Review C5, NICE-2: expected/vol are validated up front
  // too, alongside the seed — the Monte Carlo legs reach
  // runMonteCarlo (which validates them) but the historical leg
  // never does, so without this a NaN expected/vol would silently
  // solve on the historical engine. Identity for valid inputs
  // (finite expected, finite vol ≥ 0).
  validateMonteCarloReturn(expected, vol);
  // No retired years (build v66, boundary audit F6): when
  // the retirement age is at or past the plan's end age, no
  // modeled year ever withdraws the solved spending, so every
  // candidate "succeeds" and the search returns its cap as if
  // it were a sustainable-spending answer. Refuse instead —
  // null here is the solver's named no-answer result (the
  // client renders it as "no sustainable spending could be
  // solved", with the ages explanation), and the save schema
  // refuses the same combination up front.
  if (base.retirementAge >= base.endAge) return null;
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
      if (e && e.successRate >= targetPct) lo = mid;
      else hi = mid;
    }
    const best = evalStep(lo);
    if (!best) return null;
    return solverResult({ maxSpendingCents: lo * STEP, successRate: best.successRate, medianEnding: best.medianEnding, percent: pctFor(lo), approximate, targetPct, solutionStatus: lo === 0 ? "feasible_at_zero" : "feasible" });
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
    return solverResult({ maxSpendingCents: 0, successRate: at0.successRate, medianEnding: at0.medianEnding, percent: null, approximate, targetPct, solutionStatus: "infeasible_at_zero" });
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
    return solverResult({ maxSpendingCents: hi * STEP, successRate: eHi.successRate, medianEnding: eHi.medianEnding, percent: null, approximate, targetPct, solutionStatus: "capped" });
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const e = evalSpend(mid * STEP);
    if (e && e.successRate >= targetPct) lo = mid;
    else hi = mid;
  }
  const best = evalSpend(lo * STEP);
  if (!best) return null;
  return solverResult({ maxSpendingCents: lo * STEP, successRate: best.successRate, medianEnding: best.medianEnding, percent: null, approximate, targetPct, solutionStatus: lo === 0 ? "feasible_at_zero" : "feasible" });
}

// Build simulation inputs from a stored input set (a saved scenario),
// applying the same clamps and fallbacks as the main inputs: ages
// clamped to the save schema's ranges, and an income amount with
// no start age counting from the retirement age. Null portfolio /
// spending fall back to the live defaults, null expected return /
// volatility to the blend, and
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
    // Optional minimum-annual-spending floor (Engine Review 1,
    // E1-S1), in cents per year. Absent / null = no floor, and
    // the adequacy rate is null with it. A negative floor is
    // not a saveable value (the writer refuses int≥0, like
    // extra income) — a negative arriving here degrades to no
    // floor rather than pricing a nonsense bound.
    minimumAnnualSpendingCents?: number | null;
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
  // No floor (build v66, boundary audit F11): the writer
  // refuses a negative extraIncomeCents (int≥0), so the value
  // priced here is the value saved — the old Math.max(0, …)
  // silently substituted $0 for a saved negative.
  const extraCents = raw.extraIncomeCents ?? 0;
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
      // Absent / null floor = no floor (null); a set floor is
      // carried in whole cents, never below $0.
      minimumAnnualSpendingCents:
        raw.minimumAnnualSpendingCents != null &&
        raw.minimumAnnualSpendingCents > 0
          ? Math.round(raw.minimumAnnualSpendingCents)
          : null,
    },
    stocks,
    expected: (raw.expectedReturnPct ?? blendedExpected(stocks)) / 100,
    vol: Math.max(0, (raw.volatilityPct ?? blendedVol(stocks)) / 100),
  };
}

