/* ---------------- Sensitivity: Monte Carlo seed stability ----------------
   Part 4 of the hardening block (sensitivity checks). Pins that
   the Monte Carlo tab's headline never-out rate does not depend
   on the seed: the same plan priced with different seeds must
   agree within binomial sampling noise. A seed-sensitive rate
   would mean the tab's headline is a property of one random
   stream rather than of the plan, and the max-spending solver
   (which reuses the tab's stream) would inherit the same
   arbitrariness.

   The pin: two plans built from the fictional sample household
   (server/src/sampleHousehold.ts; no figure here describes any
   actual household) — a base plan ($4,075,000 portfolio,
   $180,000/yr spending) and a tighter plan (identical except
   $240,000/yr spending, the mid-range plan where sampling
   noise is largest) — each priced with runMonteCarlo at
   expected 5% / vol 17.4% for 1,000 runs per seed, and every
   seed's neverOutSuccessRate compared against the reference
   seed 12345 (MONTE_CARLO_TAB_SEED_DEFAULT).

   UNIT NOTE — read twice: runMonteCarlo(inputs, expected, vol,
   seed, runCount) takes expected/vol as FRACTIONS: 0.05 and
   0.174. buildSimInputs divides the percent inputs by 100
   before calling it; this module passes the fractions
   directly. Passing 5 / 17.4 ruins every path — a single bad
   draw makes (1 + r) negative and the balance clamps to 0 —
   the round-1 probe proved this (0% never-out on all six
   seeds). Only neverOutSuccessRate is asserted, never
   successRate: the two coincide on both probe plans but need
   not in general (a run refilled by later surplus income can
   end positive after running out mid-run).

   Band derivation (not picked): each seed's rate is a
   binomial proportion over 1,000 runs, so its standard error
   is SE = sqrt(p_ref * (1 - p_ref) / 1000), in percentage
   points, with p_ref the reference seed's rate as a fraction.
   The pass band is 4 * max(SE, 0.5pt) — four standard errors,
   floored at 0.5pt so the band never collapses near p = 0 or
   1. At p ≈ 0.4–0.6, 4·SE ≈ 6.2 points.

   Probe evidence (scratch explore2.log, fractions 0.05 /
   0.174, 1,000 runs/seed): base plan rates 60.2–64.3%
   (ref 61.2%, max deviation 3.1pt, band ≈ 6.2pt); tighter
   plan rates 40.7–46.3% (ref 41.6%, max deviation 4.7pt,
   band ≈ 6.2pt). Both pass with 1.5+ points of margin.
   Runtime: ~15 ms per run — cheap enough for the fast run.
   Fast: seeds [12345, 999] x 2 plans. Full: seeds
   [12345, 999, 42, 7, 2026, 31337] x 2 plans.

   A pin that fails against the engine is a FINDING; this
   module never adjusts a pin to make it pass. */

import {
  MONTE_CARLO_TAB_RUNS,
  MONTE_CARLO_TAB_SEED_DEFAULT,
  runMonteCarlo,
  type SimInputs,
} from "../retirementEngines";
import type {
  HardeningCheckModule,
  HardeningCheckResult,
  HardeningTeethResult,
} from "./types";

const EXPECTED = 0.05;
const VOL = 0.174;
const REFERENCE_SEED = MONTE_CARLO_TAB_SEED_DEFAULT;
const FAST_SEEDS = [MONTE_CARLO_TAB_SEED_DEFAULT, 999];
const FULL_SEEDS = [MONTE_CARLO_TAB_SEED_DEFAULT, 999, 42, 7, 2026, 31337];
// Four standard errors of binomial sampling noise, floored
// at half a point so the band never collapses near p = 0/1.
const BAND_SIGMAS = 4;
const BAND_FLOOR_POINTS = 0.5;

// Fictional sample household: portfolio = pre-tax + taxable +
// Roth + HSA + cash = $4,075,000; spending $180,000/yr;
// ages 58 now, retire 62, horizon to 95; no extra income;
// constant strategy; guardrails/phased knobs at their
// effective defaults. The tighter plan differs only in
// spending ($240,000/yr).
const BASE_INPUTS: SimInputs = {
  startCents: 407500000,
  spendingCents: 18000000,
  currentAge: 58,
  retirementAge: 62,
  endAge: 95,
  extraIncomeCents: 0,
  extraIncomeStartAge: null,
  strategy: "constant",
  percentOfPortfolio: 0,
  guardrailsCutPct: 120,
  guardrailsRaisePct: 80,
  guardrailsAdjustmentPct: 10,
  phaseStartAge: 75,
  phaseDeclinePct: 1,
};
const TIGHT_INPUTS: SimInputs = { ...BASE_INPUTS, spendingCents: 24000000 };

const PLANS: { label: string; inputs: SimInputs }[] = [
  { label: "base $180,000/yr", inputs: BASE_INPUTS },
  { label: "tight $240,000/yr", inputs: TIGHT_INPUTS },
];

type PinFailure = string;

type Corrupt = { seed: number; expected: number };

type PlanOutcome = {
  label: string;
  refRate: number;
  bandPoints: number;
  maxDeviationPoints: number;
  rates: { seed: number; rate: number }[];
};

function bandPoints(refRatePct: number): number {
  const p = refRatePct / 100;
  const sePoints = Math.sqrt((p * (1 - p)) / MONTE_CARLO_TAB_RUNS) * 100;
  return BAND_SIGMAS * Math.max(sePoints, BAND_FLOOR_POINTS);
}

function runSet(
  seeds: number[],
  corrupt?: Corrupt,
): {
  failures: PinFailure[];
  counts: Record<string, number>;
  plans: PlanOutcome[];
} {
  const failures: PinFailure[] = [];
  const plans: PlanOutcome[] = [];
  // Counts carry the per-plan max deviation and band in
  // basis points (integer-safe) alongside the run counts.
  const counts: Record<string, number> = {
    plans: PLANS.length,
    seeds: seeds.length,
    runsPerSeed: MONTE_CARLO_TAB_RUNS,
    failures: 0,
  };
  for (const plan of PLANS) {
    const ref = runMonteCarlo(plan.inputs, EXPECTED, VOL, REFERENCE_SEED);
    if (ref === null) {
      failures.push(`${plan.label}: reference seed ${REFERENCE_SEED} returned null`);
      continue;
    }
    const band = bandPoints(ref.neverOutSuccessRate);
    const rates: { seed: number; rate: number }[] = [];
    let maxDeviation = 0;
    for (const seed of seeds) {
      const expected = corrupt && corrupt.seed === seed ? corrupt.expected : EXPECTED;
      const result = runMonteCarlo(plan.inputs, expected, VOL, seed);
      if (result === null) {
        failures.push(`${plan.label} seed ${seed}: runMonteCarlo returned null`);
        continue;
      }
      const rate = result.neverOutSuccessRate;
      rates.push({ seed, rate });
      const deviation = Math.abs(rate - ref.neverOutSuccessRate);
      if (deviation > maxDeviation) maxDeviation = deviation;
      if (deviation > band) {
        failures.push(
          `${plan.label} seed ${seed}: neverOut ${rate.toFixed(1)}% vs reference seed ${REFERENCE_SEED} ` +
            `${ref.neverOutSuccessRate.toFixed(1)}% (deviation ${deviation.toFixed(1)}pt > band ${band.toFixed(1)}pt)`,
        );
      }
    }
    plans.push({
      label: plan.label,
      refRate: ref.neverOutSuccessRate,
      bandPoints: band,
      maxDeviationPoints: maxDeviation,
      rates,
    });
    const key = plan.label.startsWith("base") ? "base" : "tight";
    counts[`${key}MaxDeviationBp`] = Math.round(maxDeviation * 100);
    counts[`${key}BandBp`] = Math.round(band * 100);
  }
  counts.failures = failures.length;
  return { failures, counts, plans };
}

function resultFrom(
  id: string,
  name: string,
  set: { failures: PinFailure[]; counts: Record<string, number>; plans: PlanOutcome[] },
): HardeningCheckResult {
  const pass = set.failures.length === 0;
  const planText = set.plans
    .map(
      (p) =>
        `${p.label}: ref ${p.refRate.toFixed(1)}% (seed ${REFERENCE_SEED}), ` +
        `max deviation ${p.maxDeviationPoints.toFixed(1)}pt vs band ${p.bandPoints.toFixed(1)}pt, ` +
        `rates ${p.rates.map((r) => `${r.seed}=${r.rate.toFixed(1)}%`).join(" ")}`,
    )
    .join("; ");
  return {
    id,
    name,
    pass,
    detail: pass
      ? `Monte Carlo never-out rate agrees across seeds within 4·SE sampling noise: ${planText}.`
      : `${set.failures.length} seed(s) outside the sampling-noise band — ${planText}; see failures.`,
    failures: set.failures.slice(0, 25),
    counts: set.counts,
  };
}

const ID = "sens-mc-seed";
const NAME =
  "Sensitivity: Monte Carlo never-out rate agrees across seeds within sampling noise";

function runMcSeedFast(): HardeningCheckResult {
  return resultFrom(ID, NAME, runSet(FAST_SEEDS));
}

function runMcSeedFull(): HardeningCheckResult {
  return resultFrom(ID, NAME, runSet(FULL_SEEDS));
}

function runMcSeedTeeth(): HardeningTeethResult {
  // The clean run must pass first.
  const clean = runSet(FULL_SEEDS);
  if (clean.failures.length !== 0) {
    return {
      corruptedCaseId: "sens-mc-seed:clean-run-failed",
      failedCount: clean.failures.length,
      pass: false,
    };
  }
  // Corrupt the EXPECTED side: re-price one seed (999) at
  // expected 0.06 instead of 0.05. A +1pt return shift over
  // the 37-year horizon moves that seed's never-out rate far
  // past the ~6.2pt band on either plan, so the corrupted
  // seed must fail — and only that seed may fail. Both plans
  // may flag seed 999 (the corruption applies to the seed,
  // not the plan); the teeth condition is therefore that
  // every failure names seed 999 and at least one exists.
  const corruptedCaseId = "seed 999 expected 0.06 (was 0.05)";
  const set = runSet(FULL_SEEDS, { seed: 999, expected: 0.06 });
  return {
    corruptedCaseId,
    failedCount: set.failures.length,
    pass:
      set.failures.length > 0 &&
      set.failures.every((f) => f.includes("seed 999")),
  };
}

export const sensMcSeedCheck: HardeningCheckModule = {
  id: ID,
  name: NAME,
  runFast: runMcSeedFast,
  runFull: runMcSeedFull,
  runTeeth: runMcSeedTeeth,
};
