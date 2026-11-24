// Engine Review, core 2026-11-21, Build 5 (S-7 + S-8) — optimizer
// surfacing: the winner's unknown-IRMAA years, the winner–runner-up
// net-cost gap, and the near-tie flag, on OptimizerResult /
// JointOptimizerResult and on the runRothOptimizer action response.
// The reproduce-first probes (build5/repro-s7.ts, repro-s8.ts) are
// the pre-fix evidence: S-7 confirmed a crowned winner with
// irmaaLookbackMissingYears [2027] and no flag on the result;
// S-8 confirmed a 0¢ winner–runner-up gap (an exact tie) with no
// margin surfaced anywhere.
import { describe, expect, test } from "bun:test";
import { Actions } from "./actions";
import { jointSmall } from "./performanceShapes";
import {
  runJointOptimizer,
  runOptimizer,
  winnerNearTie,
  winnerRunnerUpGapCents,
  WINNER_NEAR_TIE_BAND_CENTS,
} from "./rothOptimizer";
import { samplePlanInputs } from "./sampleHousehold";

// A plan starting within 2 years of a Medicare start, with no
// lookback seed: primary 64 in 2026, Medicare at 65 in 2027.
// The 2027 premium year looks back to 2025 — before the plan
// starts, with no seed covering it — so its surcharge is unknown.
const NEAR_MEDICARE = samplePlanInputs({
  birthYearPrimary: 1962,
  birthYearSpouse: 1964,
});

describe("Build 5 (S-7) — the winner's unknown-IRMAA years are surfaced", () => {
  test("fixed-age: a winner with an unknown premium year carries it on the result", () => {
    const res = runOptimizer(NEAR_MEDICARE);
    expect(res.winner.result.irmaaLookbackMissingYears).toEqual([2027]);
    expect(res.irmaaLookbackMissingYears).toEqual([2027]);
    expect(res.irmaaLookbackMissingYears).toEqual(
      res.winner.result.irmaaLookbackMissingYears,
    );
    // Additive only: the flag does not change the verdict.
    expect(res.winnerQualified).toBe(true);
  }, 300_000);

  test("fixed-age: a supplied lookback seed clears the missing year", () => {
    const res = runOptimizer(
      samplePlanInputs({
        birthYearPrimary: 1962,
        birthYearSpouse: 1964,
        irmaaLookbackSeed: [
          { year: 2025, magi: 150000, filingStatus: "mfj" },
        ],
      }),
    );
    expect(res.irmaaLookbackMissingYears).toEqual([]);
    expect(res.winner.result.irmaaLookbackMissingYears).toEqual([]);
  }, 300_000);

  test("joint: the same household's joint winner carries the missing year", () => {
    // 1-combo joint search (both claiming ages locked at the
    // entered ages) over a horizon covering the Medicare start.
    const res = runJointOptimizer(
      jointSmall({
        birthYearPrimary: 1962,
        birthYearSpouse: 1964,
        endAgePrimary: 70,
        windowStartAge: 64,
        windowStopAge: 65,
        retirementAge: 64,
        ssPrimaryStartAge: 64,
        ssSpouseStartAge: 62,
      }),
    );
    expect(res.winner.result.irmaaLookbackMissingYears).toEqual([2027]);
    expect(res.irmaaLookbackMissingYears).toEqual([2027]);
  }, 300_000);
});

describe("Build 5 (S-8) — the winner–runner-up gap and near-tie flag are surfaced", () => {
  test("fixed-age: the sample household crowns an exact tie, flagged as one", () => {
    const res = runOptimizer(samplePlanInputs());
    expect(res.runnersUp.length).toBeGreaterThan(0);
    const runnerUp = res.runnersUp[0]!;
    // The gap is the recomputed difference, in integer cents.
    expect(res.winnerRunnerUpGapCents).toBe(
      Math.round((runnerUp.cost.netCost - res.winner.cost.netCost) * 100),
    );
    // The repro pinned this: winner and runner-up tie to the cent.
    expect(res.winnerRunnerUpGapCents).toBe(0);
    expect(res.winnerNearTie).toBe(true);
  }, 300_000);

  test("joint: the gap and flag are computed from the joint run's own winner and runners-up", () => {
    const res = runJointOptimizer(jointSmall());
    expect(res.runnersUp.length).toBeGreaterThan(0);
    const runnerUp = res.runnersUp[0]!;
    const gap = Math.round(
      (runnerUp.cost.netCost - res.winner.cost.netCost) * 100,
    );
    expect(res.winnerRunnerUpGapCents).toBe(gap);
    expect(res.winnerNearTie).toBe(gap <= WINNER_NEAR_TIE_BAND_CENTS);
  }, 300_000);

  test("joint, multi-combo: the same fields are assigned on the multi-combo path", () => {
    // Pass 1 NICE-1: both joint tests above route through the
    // 1-combo spread path (combos.length <= 1 returns the
    // fixed-age result), so they never execute the multi-combo
    // field assignments. Unlock the spouse's claiming age (67,
    // not yet claiming at 56) while the primary stays locked
    // (58, already claiming): the search prices 9 spouse-age
    // combinations, so the multi-combo constructor assigns the
    // fields from its own winner and runner pool (which skips
    // same-spec-key + same-claiming-age entries, unlike the
    // fixed-age pool). No Medicare years fall in this 6-year
    // horizon, so the missing list is empty — asserted as equal
    // to the winner's own list, not just empty.
    const res = runJointOptimizer(
      jointSmall({ ssSpouseStartAge: 67 }),
    );
    expect(res.jointSearch.combosTested).toBeGreaterThan(1);
    expect(res.runnersUp.length).toBeGreaterThan(0);
    const runnerUp = res.runnersUp[0]!;
    const gap = Math.round(
      (runnerUp.cost.netCost - res.winner.cost.netCost) * 100,
    );
    expect(res.winnerRunnerUpGapCents).toBe(gap);
    expect(res.winnerNearTie).toBe(gap <= WINNER_NEAR_TIE_BAND_CENTS);
    expect(res.irmaaLookbackMissingYears).toEqual(
      res.winner.result.irmaaLookbackMissingYears,
    );
    expect(res.irmaaLookbackMissingYears).toEqual([]);
  }, 300_000);

  test("band: the flag follows the $5,000 near-tie band, boundary inclusive", () => {
    // The helpers read only winner.cost.netCost and
    // runnersUp[0].cost.netCost (dollars); the rest of the
    // candidate shape is irrelevant here.
    const made = (winnerCost: number, runnerUpCost: number | null) =>
      ({
        winner: { cost: { netCost: winnerCost } },
        runnersUp:
          runnerUpCost == null ? [] : [{ cost: { netCost: runnerUpCost } }],
      }) as never;
    expect(WINNER_NEAR_TIE_BAND_CENTS).toBe(500000);
    // $6,000 gap — outside the band.
    expect(winnerRunnerUpGapCents(made(100000, 106000))).toBe(600000);
    expect(winnerNearTie(made(100000, 106000))).toBe(false);
    // $4,000 gap — inside the band.
    expect(winnerRunnerUpGapCents(made(100000, 104000))).toBe(400000);
    expect(winnerNearTie(made(100000, 104000))).toBe(true);
    // Exactly $5,000 — inside (within the band, inclusive).
    expect(winnerRunnerUpGapCents(made(100000, 105000))).toBe(500000);
    expect(winnerNearTie(made(100000, 105000))).toBe(true);
    // No runner-up — no gap, no tie.
    expect(winnerRunnerUpGapCents(made(100000, null))).toBeNull();
    expect(winnerNearTie(made(100000, null))).toBe(false);
  });
});

describe("Build 5 (S-7/S-8) — the action response carries the three fields", () => {
  test("runRothOptimizer response schema carries the surfacing fields", () => {
    const shape = Actions.runRothOptimizer.response.shape;
    expect(shape.irmaaLookbackMissingYears).toBeDefined();
    expect(shape.winnerRunnerUpGapCents).toBeDefined();
    expect(shape.winnerNearTie).toBeDefined();
    // The gap is nullable (no runner-up); the list and the flag
    // are required. The handler maps them whole from the joint
    // result (actions.ts success mapping, read at review time) —
    // this pins the schema; the engine tests above pin the values.
    expect(shape.winnerRunnerUpGapCents.isNullable()).toBe(true);
  });
});
