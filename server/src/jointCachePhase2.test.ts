// Engine Review C7 architecture (§2, §4.2) — Phase 2 cache tests.
//
// The byte-budgeted LRU cache (ByteBudgetCache), the compact joint
// summary (compactJointOptimizerResult), and the two caches that use
// them (joint cache in rothOptimizer.ts, runReturnsCache in
// retirementIndependentCheck.ts).
//
// All workloads are the fictional sample household (performanceShapes)
// or small derived variants, so every test completes on the 6 GB VM.
// Run per-file: bun test server/src/jointCachePhase2.test.ts
// (whole-suite bun test in one process OOMs on this VM).

import { describe, test, expect } from "bun:test";
import {
  ByteBudgetCache,
  estimateValueBytes,
} from "./byteBudgetCache";
import {
  compactJointOptimizerResult,
  computeJointOptimizer,
  JOINT_CACHE_BUDGET_BYTES,
  jointCacheStats,
  optimizerImprovements,
  runJointOptimizer,
  type ScoredCandidate,
  type ScoredCandidateSummary,
} from "./rothOptimizer";
import {
  refFeasible,
  runReturnsCacheStats,
  RETURNS_CACHE_BUDGET_BYTES,
  type RefInputs,
} from "./retirementIndependentCheck";
import { jointSmall } from "./performanceShapes";

// --- The estimator (§2.3) --------------------------------------------

describe("estimateValueBytes (deterministic walker, conservative)", () => {
  test("counts the documented sizes exactly on a small known object", () => {
    // {a: 1, b: "xy"}: 32 (object) + 1 (key a) + 8 (number)
    // + 1 (key b) + 2 (string bytes) = 44.
    expect(estimateValueBytes({ a: 1, b: "xy" })).toBe(44);
    expect(estimateValueBytes([1, 2, 3])).toBe(32 + 8 * 3);
    expect(estimateValueBytes(true)).toBe(4);
    expect(estimateValueBytes(null)).toBe(4);
    expect(estimateValueBytes(undefined)).toBe(4);
    // Non-finite numbers are numbers: 8 B, never JSON's null.
    expect(estimateValueBytes(NaN)).toBe(8);
    expect(estimateValueBytes(Infinity)).toBe(8);
    expect(estimateValueBytes(-Infinity)).toBe(8);
    expect(estimateValueBytes({ v: NaN })).toBe(32 + 1 + 8);
    // UTF-8, not UTF-16 length: "é" is 2 bytes, not 1.
    expect(estimateValueBytes("é")).toBe(2);
  });

  test("counts a shared reference once (structuredClone shares it too)", () => {
    const shared = { n: 1 };
    // outer 32 + key x (1) + shared (32 + key n (1) + 8) + key y (1)
    // + 0 (second reach) = 75.
    expect(estimateValueBytes({ x: shared, y: shared })).toBe(75);
  });

  test("terminates on a cycle, counting it once", () => {
    const c: Record<string, unknown> = {};
    c.self = c;
    expect(estimateValueBytes(c)).toBe(32 + 4);
  });
});

// --- LRU eviction (§2.4) ----------------------------------------------

describe("ByteBudgetCache LRU eviction (clear-all is gone)", () => {
  test("evicts oldest-first, one at a time, keeping hot entries", () => {
    const cache = new ByteBudgetCache<string>(1000, "test");
    for (let i = 1; i <= 10; i++) cache.set(`k${i}`, `v${i}`, 100);
    expect(cache.stats().entries).toBe(10);
    expect(cache.stats().bytes).toBe(1000);
    // Hit k2: it becomes newest.
    expect(cache.get("k2")).toBe("v2");
    // The 11th entry evicts exactly the oldest (k1), not all of them.
    cache.set("k11", "v11", 100);
    expect(cache.stats().entries).toBe(10);
    expect(cache.stats().evictions).toBe(1);
    expect(cache.has("k1")).toBe(false);
    expect(cache.has("k2")).toBe(true);
    for (let i = 3; i <= 11; i++) expect(cache.has(`k${i}`)).toBe(true);
    expect(cache.stats().bytes).toBe(1000);
  });

  test("inserting a 51st entry evicts exactly the oldest entries, not all", () => {
    const cache = new ByteBudgetCache<string>(5000, "test");
    for (let i = 1; i <= 50; i++) cache.set(`k${i}`, `v${i}`, 100);
    expect(cache.stats().entries).toBe(50);
    cache.set("k51", "v51", 100);
    // Clear-all would leave 1 entry; LRU leaves 50 (k2..k51).
    expect(cache.stats().entries).toBe(50);
    expect(cache.stats().evictions).toBe(1);
    expect(cache.has("k1")).toBe(false);
    expect(cache.has("k2")).toBe(true);
    expect(cache.has("k51")).toBe(true);
    expect(cache.stats().bytes).toBe(5000);
  });

  test("a hit refreshes recency, so the refreshed entry survives pressure", () => {
    const cache = new ByteBudgetCache<string>(200, "test");
    cache.set("a", "a", 100);
    cache.set("b", "b", 100);
    expect(cache.get("a")).toBe("a");
    cache.set("c", "c", 100);
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("c")).toBe(true);
  });

  test("single-entry guard: a lone entry over budget is stored anyway", () => {
    const cache = new ByteBudgetCache<string>(100, "test");
    cache.set("big", "big", 500);
    expect(cache.stats().entries).toBe(1);
    expect(cache.stats().bytes).toBe(500);
    expect(cache.get("big")).toBe("big");
  });

  test("re-storing a key replaces its bytes instead of double-counting", () => {
    const cache = new ByteBudgetCache<string>(1000, "test");
    cache.set("k", "v", 100);
    cache.set("k", "v2", 300);
    expect(cache.stats().entries).toBe(1);
    expect(cache.stats().bytes).toBe(300);
  });
});

// --- The compact summary (§2.2) ---------------------------------------

describe("compactJointOptimizerResult", () => {
  test("strips tail years, keeps the named set whole, keeps all scalars", () => {
    const full = computeJointOptimizer(jointSmall());
    const summary = compactJointOptimizerResult(full);
    expect(summary.candidatesTested).toBe(full.candidatesTested);
    expect(summary.validCandidatesTested).toBe(full.validCandidatesTested);
    expect(summary.invalidCandidatesTested).toBe(full.invalidCandidatesTested);
    expect(summary.winnersDiffer).toBe(full.winnersDiffer);
    expect(summary.winnerQualified).toBe(full.winnerQualified);
    expect(summary.jointSearch).toBe(full.jointSearch);
    expect(summary.claimAgeTable).toBe(full.claimAgeTable);
    expect(summary.claimAgeFloorMet).toBe(full.claimAgeFloorMet);
    expect(summary.scored.length).toBe(full.scored.length);
    // The named set keeps full marches, identical to the full result.
    for (const named of [
      summary.winner,
      summary.doNothing,
      summary.selectedWinner,
      summary.winnerByNetCost,
      summary.winnerByEndingWealth,
      ...summary.runnersUp,
      ...summary.claimAgeTable.map((r) => r.best),
    ]) {
      expect(named.result.years.length).toBe(full.winner.result.years.length);
    }
    if (summary.excludedInvalidWinner != null) {
      expect(
        summary.excludedInvalidWinner.candidate.result.years.length,
      ).toBe(full.winner.result.years.length);
    }
    // Tail candidates: no years[], yearCount set, scalars identical.
    const namedSet = new Set<ScoredCandidate>([
      full.winner,
      full.doNothing,
      full.selectedWinner,
      full.winnerByNetCost,
      full.winnerByEndingWealth,
      ...full.runnersUp,
      ...full.claimAgeTable.map((r) => r.best),
      ...(full.excludedInvalidWinner == null
        ? []
        : [full.excludedInvalidWinner.candidate]),
    ]);
    let tail = 0;
    for (let i = 0; i < full.scored.length; i++) {
      const f = full.scored[i]!;
      const s = summary.scored[i]!;
      if (namedSet.has(f)) {
        expect(s).toBe(f);
        continue;
      }
      tail++;
      // Narrow to the summary member for the summary-only field.
      if ("years" in s.result) {
        throw new Error("tail candidate kept its years[]");
      }
      expect(s.result.yearCount).toBe(f.result.years.length);
      expect(s.result.endingAfterTaxWealth).toBe(f.result.endingAfterTaxWealth);
      expect(s.result.endingPretax).toBe(f.result.endingPretax);
      expect(s.result.lifetimeFederalTax).toBe(f.result.lifetimeFederalTax);
      expect(s.result.lifetimeSsCollected).toBe(f.result.lifetimeSsCollected);
      expect(s.spec).toBe(f.spec);
      expect(s.cost).toBe(f.cost);
      expect(s.integrity).toBe(f.integrity);
      expect(s.claimAges).toBe(f.claimAges);
    }
    expect(tail).toBeGreaterThan(0);
    // The compacted summary is far smaller by the estimator.
    expect(estimateValueBytes(summary)).toBeLessThan(
      estimateValueBytes(full) / 2,
    );
  }, 300_000);
});

// --- Summary parity: every figure the action reads (§4.2) ---------------

describe("summary parity (cached summary == full result, action-read figures)", () => {
  test("toOptScore fields, improvements, claimAgeTable, work-years winner fields", () => {
    const plan = jointSmall();
    const full = computeJointOptimizer(plan);
    const summary = runJointOptimizer(plan);
    const optScoreFields = (s: ScoredCandidate | ScoredCandidateSummary) => ({
      name: s.spec.name,
      windowStopAge: s.spec.windowStopAge,
      tax: s.cost.tax,
      penalty: s.cost.penalty,
      irmaa: s.cost.irmaa,
      acaCredit: s.cost.acaCredit,
      netCost: s.cost.netCost,
      endingWealth: s.result.endingAfterTaxWealth,
      ssCollected: s.cost.ssCollected,
      claimPrimaryAge: s.claimAges.primaryAge,
      claimSpouseAge: s.claimAges.spouseAge,
      integrityStatus: s.integrity.status,
    });
    for (const [a, b] of [
      [full.winner, summary.winner],
      [full.doNothing, summary.doNothing],
      [full.selectedWinner, summary.selectedWinner],
      [full.winnerByNetCost, summary.winnerByNetCost],
      [full.winnerByEndingWealth, summary.winnerByEndingWealth],
    ] as const) {
      expect(optScoreFields(b)).toEqual(optScoreFields(a));
    }
    expect(summary.runnersUp.map(optScoreFields)).toEqual(
      full.runnersUp.map(optScoreFields),
    );
    expect(
      summary.claimAgeTable.map((r) => ({
        primaryAge: r.primaryAge,
        best: optScoreFields(r.best),
      })),
    ).toEqual(
      full.claimAgeTable.map((r) => ({
        primaryAge: r.primaryAge,
        best: optScoreFields(r.best),
      })),
    );
    // Improvements: the same levers, same gains, from both scored lists
    // (compared as figures — the summary candidates carry no years[]).
    const savedCost = full.doNothing.cost.netCost + 1;
    const fromFull = optimizerImprovements([full.scored], savedCost);
    const fromSummary = optimizerImprovements([summary.scored], savedCost);
    const leverFigures = (r: typeof fromFull) =>
      r.improvements.map(({ candidate, gainVsSavedPlan }) => ({
        key: candidate.spec.key,
        claimPrimary: candidate.claimAges.primaryAge,
        gainVsSavedPlan,
      }));
    expect(leverFigures(fromSummary)).toEqual(leverFigures(fromFull));
    expect(fromSummary.excludedInvalidLevers).toBe(
      fromFull.excludedInvalidLevers,
    );
    // Work-years winner fields (buildWorkYearsRow reads these).
    expect(summary.winner.result.endingPretax).toBe(
      full.winner.result.endingPretax,
    );
    expect(summary.winner.result.endingRoth).toBe(full.winner.result.endingRoth);
    expect(summary.winner.result.endingTaxable).toBe(
      full.winner.result.endingTaxable,
    );
    expect(summary.winner.result.endingHsa).toBe(full.winner.result.endingHsa);
    expect(summary.winner.cost.tax).toBe(full.winner.cost.tax);
  }, 300_000);
});

// --- Joint cache: clone discipline, mutation, byte accounting -----------

describe("joint cache (byte-budgeted, clone-on-store/hit)", () => {
  test("a hit returns the same figures; poisoning a return leaves the cache intact", () => {
    const plan = jointSmall({ pretaxStart: 400000 });
    const before = jointCacheStats();
    const r1 = runJointOptimizer(plan);
    const afterCold = jointCacheStats();
    expect(afterCold.entries).toBe(before.entries + 1);
    expect(afterCold.misses).toBe(before.misses + 1);
    expect(afterCold.bytes).toBeGreaterThan(before.bytes);
    const r2 = runJointOptimizer(plan);
    const afterHit = jointCacheStats();
    expect(afterHit.hits).toBe(before.hits + 1);
    expect(afterHit.entries).toBe(afterCold.entries);
    expect(r2.selectedWinner.cost.netCost).toBe(r1.selectedWinner.cost.netCost);
    // Poison the handed-out copies (winner net + a tail scalar):
    // the stored copy is never handed out, so the next call is intact.
    r2.winner.cost.netCost = -999999;
    const tail = r2.scored.find((s) => !("years" in s.result));
    if (tail) tail.result.endingAfterTaxWealth = -999999;
    const r3 = runJointOptimizer(plan);
    expect(r3.selectedWinner.cost.netCost).toBe(r1.selectedWinner.cost.netCost);
    expect(r3.winner.cost.netCost).toBe(r1.winner.cost.netCost);
    if (tail) {
      const same = r3.scored.find(
        (s) => s.spec.key === tail.spec.key,
      )!;
      expect(same.result.endingAfterTaxWealth).toBe(
        r1.scored.find((s) => s.spec.key === tail.spec.key)!.result
          .endingAfterTaxWealth,
      );
    }
  }, 300_000);

  test("accounted bytes equal the estimator for the stored summary", () => {
    const plan = jointSmall({ pretaxStart: 410000 });
    const before = jointCacheStats();
    const summary = runJointOptimizer(plan);
    const after = jointCacheStats();
    // No eviction on a near-empty cache, so the delta is this entry.
    expect(after.bytes - before.bytes).toBe(estimateValueBytes(summary));
    expect(after.entries).toBe(before.entries + 1);
    expect(JOINT_CACHE_BUDGET_BYTES).toBe(256 * 1024 * 1024);
  }, 300_000);
});

// --- runReturnsCache (§2.3–§2.4, 64 MiB) -------------------------------

describe("runReturnsCache (byte-budgeted under 64 MiB)", () => {
  test("distinct seeds accumulate entries and bytes; the budget constant is 64 MiB", () => {
    const inputs: RefInputs = {
      startCents: 100000000,
      spendingCents: 5000000,
      currentAge: 62,
      retirementAge: 62,
      endAge: 66,
      extraIncomeCents: 0,
      extraIncomeStartAge: null,
      strategy: "constant",
      percentOfPortfolio: 0,
      guardrailsCutPct: 120,
      guardrailsRaisePct: 80,
      guardrailsAdjustmentPct: 10,
      phaseStartAge: 62,
      phaseDeclinePct: 0,
    };
    const before = runReturnsCacheStats();
    // Distinct Monte Carlo seeds build distinct cached streams.
    refFeasible(inputs, 60, 5, 12, "montecarlo", 85, 111);
    refFeasible(inputs, 60, 5, 12, "montecarlo", 85, 222);
    refFeasible(inputs, 60, 5, 12, "montecarlo", 85, 333);
    const after = runReturnsCacheStats();
    expect(after.entries).toBe(before.entries + 3);
    expect(after.bytes).toBeGreaterThan(before.bytes);
    expect(after.misses).toBe(before.misses + 3);
    // A repeat seed hits instead of storing again.
    refFeasible(inputs, 60, 5, 12, "montecarlo", 85, 111);
    const afterHit = runReturnsCacheStats();
    expect(afterHit.entries).toBe(after.entries);
    expect(afterHit.hits).toBe(after.hits + 1);
    expect(RETURNS_CACHE_BUDGET_BYTES).toBe(64 * 1024 * 1024);
  }, 300_000);
});
