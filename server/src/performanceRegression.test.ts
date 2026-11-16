// Engine Review C7 (§8) — performance regression harness.
//
// Repeatable benchmarks as committed tests. Every budget below is a
// CPU-time budget (process.cpuUsage, user+sys) — NEVER wall time:
// on this shared VM wall time inflates 5–10× with sibling load
// while CPU time is stable to a few percent (audit-blocking.md:
// three runOptimizer runs 21,480 / 22,060 / 21,628 ms CPU against
// wall times 139,875 / 213,814 / 197,088 ms). Each budget cites the
// measured baseline it derives from, with a wide margin; a budget
// without a cited measurement is not acceptable.
//
// All households are the fictional sample household
// (server/src/sampleHousehold.ts) or small derived variants —
// 5-year horizons, one draw order / one claiming-age combo / one
// quit age — so every workload completes on the 6 GB VM. The
// full-size shapes do NOT complete here (audit-blocking.md: the
// 81-combo joint OOMs; a 2-age work-years call never returned),
// which is why the harness pins small shapes, not full ones.
//
// Each benchmark asserts: completion, determinism (same inputs →
// identical outputs on re-run), structural counts, and a CPU
// budget. Heap is asserted only as a loose upper bound on the
// measured delta (Bun's heapUsed is a high-water mark, so only
// the growth delta at the call is meaningful — audit-cache.md).
//
// Run per-file (whole-suite bun test in one process OOMs on
// this VM): bun test server/src/performanceRegression.test.ts

import { describe, test, expect } from "bun:test";
import {
  jointInputsKey,
  runJointOptimizer,
  runOptimizer,
  runRothCompare,
  type JointOptimizerResult,
  type OptimizerResult,
} from "./rothOptimizer";
import {
  samplePlanInputs,
  SAMPLE_ACA_BENCHMARK_COUPLE_CENTS,
  SAMPLE_ACA_BENCHMARK_FAMILY_CENTS,
  SAMPLE_ACA_BENCHMARK_SINGLE_CENTS,
  SAMPLE_ANNUAL_SPENDING_CENTS,
  SAMPLE_BIRTH_YEAR_PRIMARY,
  SAMPLE_BIRTH_YEAR_SPOUSE,
  SAMPLE_DIVIDEND_YIELD_PCT,
  SAMPLE_EXPECTED_RETURN_PCT,
  SAMPLE_FILING_STATUS,
  SAMPLE_HEIR_RATE_PCT,
  SAMPLE_HOUSEHOLD_SIZE,
  SAMPLE_HSA_CENTS,
  SAMPLE_INFLATION_PCT,
  SAMPLE_INTEREST_YIELD_PCT,
  SAMPLE_PRETAX_CENTS,
  SAMPLE_PRESERVE_PRETAX_CENTS,
  SAMPLE_PROTECT_MIN_TAXABLE_CENTS,
  SAMPLE_QUALIFIED_SHARE_PCT,
  SAMPLE_ROTH_CENTS,
  SAMPLE_SS_PRIMARY_CENTS,
  SAMPLE_SS_PRIMARY_START_AGE,
  SAMPLE_SS_SPOUSE_CENTS,
  SAMPLE_SS_SPOUSE_START_AGE,
  SAMPLE_TAXABLE_BASIS_PCT,
  SAMPLE_TAXABLE_CENTS,
} from "./sampleHousehold";
import type { RothPlanInputs } from "./taxEngine";
import {
  buildSimInputs,
  runMonteCarlo,
  solveMaxSpending,
} from "./retirementEngines";
import { runWorkYearsCompare } from "./workYears";

// --- Measurement helpers ---------------------------------------------
// CPU milliseconds (user+sys) spent inside fn, plus the heapUsed
// growth across it. Callers assert on cpuMs; heapDeltaMb is only
// ever asserted against a loose upper bound.
function measure<T>(fn: () => T): {
  out: T;
  cpuMs: number;
  heapDeltaMb: number;
} {
  const cpu0 = process.cpuUsage();
  const heap0 = process.memoryUsage().heapUsed;
  const out = fn();
  const cpu1 = process.cpuUsage(cpu0);
  return {
    out,
    cpuMs: (cpu1.user + cpu1.system) / 1000,
    heapDeltaMb: (process.memoryUsage().heapUsed - heap0) / 1048576,
  };
}

// --- Small shapes (sample household, short horizons) -----------------
// 5-year plan (ages 58→63), conversion window 62–63. One draw
// order prices 505 candidates; all six orders price 3,025 — the
// all-orders shape is deliberately NOT harnessed: it measured
// 6,595 ms CPU in one fresh process and 18,899 ms in another
// (probe B vs probe A), a ~3× spread that would flake a budget.
// The 1-order shape measured 1,453 / 1,348 ms CPU across two
// runs (probe A) and is the stable fixed-age benchmark.
const small5y = (overrides: Partial<RothPlanInputs> = {}): RothPlanInputs =>
  samplePlanInputs({
    endAgePrimary: 63,
    windowStartAge: 62,
    windowStopAge: 63,
    retirementAge: 62,
    ...overrides,
  });

// 5-year plan with both claiming ages locked (already claiming at
// the entered ages 58/56), so the joint search has exactly 1
// combo. Precedent: the A4 cache probe (cache3.ts) and the A3
// 3-year cold run (0.47 s CPU).
const jointSmall = (overrides: Record<string, unknown> = {}): RothPlanInputs =>
  samplePlanInputs({
    endAgePrimary: 63,
    windowStartAge: 62,
    windowStopAge: 63,
    retirementAge: 62,
    ssPrimaryStartAge: 58,
    ssSpouseStartAge: 56,
    ...overrides,
  }) as RothPlanInputs;

// The regression gate's compare base (same construction as
// gate-probe.ts): the sample household with the preserve reserve
// priced on the compare path.
function sampleCompareBase(): Record<string, unknown> {
  return {
    birthYearPrimary: SAMPLE_BIRTH_YEAR_PRIMARY,
    birthYearSpouse: SAMPLE_BIRTH_YEAR_SPOUSE,
    filingStatus: SAMPLE_FILING_STATUS,
    pretaxCents: SAMPLE_PRETAX_CENTS,
    pretaxSpouseCents: null,
    survivorEnabled: false,
    survivorWho: null,
    survivorDeathYear: null,
    rothCents: SAMPLE_ROTH_CENTS,
    taxableCents: SAMPLE_TAXABLE_CENTS,
    taxableExcludeCents: 0,
    hsaCents: SAMPLE_HSA_CENTS,
    taxableBasisPct: SAMPLE_TAXABLE_BASIS_PCT,
    taxableTiers: null,
    taxableDividendYieldPct: SAMPLE_DIVIDEND_YIELD_PCT,
    taxableInterestYieldPct: SAMPLE_INTEREST_YIELD_PCT,
    qualifiedDividendSharePct: SAMPLE_QUALIFIED_SHARE_PCT,
    spendFromCashPct: null,
    spendFromCashSleeveCents: null,
    flexCutPct: null,
    flexFloorPct: null,
    annualSpendingCents: SAMPLE_ANNUAL_SPENDING_CENTS,
    retirementAge: 62,
    endAge: 95,
    expectedReturnPct: SAMPLE_EXPECTED_RETURN_PCT,
    ssPrimaryAnnualCents: SAMPLE_SS_PRIMARY_CENTS,
    ssPrimaryStartAge: SAMPLE_SS_PRIMARY_START_AGE,
    ssPrimaryNoBenefit: false,
    ssSpouseAnnualCents: SAMPLE_SS_SPOUSE_CENTS,
    ssSpouseStartAge: SAMPLE_SS_SPOUSE_START_AGE,
    ssSpouseNoBenefit: false,
    otherOrdinaryCents: null,
    taxExemptInterestCents: null,
    convertedAlreadyCents: null,
    windowStartAge: 62,
    windowStopAge: 73,
    payTaxFrom: "taxable",
    protectMinTaxableCents: SAMPLE_PROTECT_MIN_TAXABLE_CENTS,
    preservePretaxCents: SAMPLE_PRESERVE_PRETAX_CENTS,
    preserveExitRatePct: 10,
    claimAgeFloor: null,
    spouseSoleBeneficiary: true,
    primarySoleBeneficiaryOfSpouse: null,
    acaHouseholdSize: SAMPLE_HOUSEHOLD_SIZE,
    acaHouseholdSchedule: null,
    collegeFallFromYear: null,
    collegeFallThroughYear: null,
    acaBenchmarkCoupleCents: SAMPLE_ACA_BENCHMARK_COUPLE_CENTS,
    acaBenchmarkSingleCents: SAMPLE_ACA_BENCHMARK_SINGLE_CENTS,
    acaBenchmarkFamilyCents: SAMPLE_ACA_BENCHMARK_FAMILY_CENTS,
    acaSpouseEndAge: null,
    inflationPct: SAMPLE_INFLATION_PCT,
    stateRatePct: 0,
    heirRatePct: SAMPLE_HEIR_RATE_PCT,
    ceilings: null,
    optimizerGuardrail: null,
    optimizerBunching: null,
    gainsHarvest: null,
    drawOrder: null,
    drawOrderAfter: null,
    drawOrderSwitchAge: null,
    yearlySalaryCents: null,
    employer401kCents: null,
    employerHsaCents: null,
    fafsaReportableAssetsCents: null,
  };
}

const ceil = (bracketTopPct: number) => ({
  bracketTopPct,
  irmaaTierCap: null,
  ltcgZeroCap: false,
  acaCliffCap: false,
  acaCliffCapFamilyOnly: false,
  magiCapCents: null,
  acaCliffBufferCents: null,
});

// Retirement small shape: the sample household's balances
// ($3,975,000 start: pre-tax + taxable + Roth + HSA), $180,000/yr
// spending, both SS streams from 67, 60% stocks, 5% expected /
// 12% vol — the corrected-input shape of audit-stress.md (P4d),
// which prices at 97.5% never-runs-out over 1,000 runs.
function sampleRetirement() {
  const built = buildSimInputs(
    {
      portfolioCents:
        SAMPLE_PRETAX_CENTS +
        SAMPLE_TAXABLE_CENTS +
        SAMPLE_ROTH_CENTS +
        SAMPLE_HSA_CENTS,
      spendingCents: SAMPLE_ANNUAL_SPENDING_CENTS,
      currentAge: 58,
      retirementAge: 62,
      endAge: 95,
      stocksPct: 60,
      extraIncomeCents: SAMPLE_SS_PRIMARY_CENTS + SAMPLE_SS_SPOUSE_CENTS,
      extraIncomeStartAge: 67,
      expectedReturnPct: 5,
      volatilityPct: 12,
      strategy: "constant",
      percentOfPortfolio: null,
      guardrailsCutPct: null,
      guardrailsRaisePct: null,
      guardrailsAdjustmentPct: null,
    },
    { portfolioCents: 0, spendingCents: 0 },
  );
  if (!built) throw new Error("sample retirement inputs refused");
  return built;
}

// Canonical digests for the determinism pins: the figures that
// identify a pricing, without serializing multi-megabyte results.
function optimizerDigest(r: OptimizerResult): string {
  return JSON.stringify({
    candidatesTested: r.candidatesTested,
    valid: r.validCandidatesTested,
    invalid: r.invalidCandidatesTested,
    winnerKey: r.selectedWinner?.spec.key,
    winnerNetCost: r.selectedWinner?.cost.netCost,
    winnerEndingWealth: r.selectedWinner?.result.endingAfterTaxWealth,
    doNothingNetCost: r.doNothing.cost.netCost,
  });
}
function jointDigest(r: JointOptimizerResult): string {
  return JSON.stringify({
    combosTested: r.jointSearch?.combosTested,
    candidatesTested: r.candidatesTested,
    winnerKey: r.selectedWinner?.spec.key,
    winnerNetCost: r.selectedWinner?.cost.netCost,
    winnerEndingWealth: r.selectedWinner?.result.endingAfterTaxWealth,
  });
}

// ---------------------------------------------------------------------------
// Joint cache key — C7 A4 collision fix
//
// A4 proved jointInputsKey collided NaN with null because
// JSON.stringify(NaN) is `null`: a cold NaN run priced netCost NaN,
// and the following null call returned in hit time with netCost NaN,
// while a fresh null run prices finite ($383,753.13 on the full-size
// plan). These tests run in file order in one process, so the
// null-first test below captures the true null result before any
// NaN entry exists, and the later tests prove each non-finite
// variant is served its own entry, never another's.
// ---------------------------------------------------------------------------
describe("joint cache key distinguishes non-finite values from null (C7 A4)", () => {
  test("finite inputs key exactly as before the fix", () => {
    // The pre-fix algorithm, reproduced inline: sorted keys +
    // plain JSON.stringify. The fix must not move any finite key,
    // or valid inputs would lose their cache hits.
    const legacyKey = (v: unknown): string => {
      const sortValue = (x: unknown): unknown => {
        if (Array.isArray(x)) return x.map(sortValue);
        if (x != null && typeof x === "object") {
          const out: Record<string, unknown> = {};
          for (const k of Object.keys(x as Record<string, unknown>).sort()) {
            out[k] = sortValue((x as Record<string, unknown>)[k]);
          }
          return out;
        }
        return x;
      };
      return JSON.stringify(sortValue(v));
    };
    const finite = jointSmall();
    expect(jointInputsKey(finite)).toBe(legacyKey(finite));
    // The same inputs built a second time key identically —
    // the key depends on values, not object identity.
    const rebuilt = jointSmall({ pretaxStart: finite.pretaxStart });
    expect(jointInputsKey(rebuilt)).toBe(jointInputsKey(finite));
  });

  test("NaN / Infinity / -Infinity / null all key differently", () => {
    const base = jointSmall();
    const keys = new Set([
      jointInputsKey(base),
      jointInputsKey(jointSmall({ pretaxStart: NaN })),
      jointInputsKey(jointSmall({ pretaxStart: Infinity })),
      jointInputsKey(jointSmall({ pretaxStart: -Infinity })),
      jointInputsKey(jointSmall({ pretaxStart: null as never })),
    ]);
    expect(keys.size).toBe(5);
    // Non-finite values in a nested position key differently too.
    expect(jointInputsKey(jointSmall({ taxableBasisPct: NaN }))).not.toBe(
      jointInputsKey(jointSmall({ taxableBasisPct: null as never })),
    );
  });

  // Captured by the null-first cold run; the NaN/null tests below
  // compare against it. Runs first so no NaN entry exists yet.
  let nullNetCost: number | undefined;
  test("null pretaxStart cold run prices finite (the true null result)", () => {
    const r = runJointOptimizer(jointSmall({ pretaxStart: null as never }));
    const net = r.selectedWinner?.cost.netCost;
    expect(typeof net).toBe("number");
    expect(Number.isFinite(net)).toBe(true);
    if (typeof net !== "number") throw new Error("expected a numeric netCost");
    nullNetCost = net;
  }, 300_000);

  test("NaN after null returns the NaN result, not the null entry", () => {
    const r = runJointOptimizer(jointSmall({ pretaxStart: NaN }));
    const net = r.selectedWinner?.cost.netCost;
    expect(typeof net).toBe("number");
    expect(Number.isNaN(net)).toBe(true);
    if (typeof net !== "number") throw new Error("expected a numeric netCost");
    if (typeof nullNetCost !== "number") throw new Error("null baseline was not captured");
    expect(net).not.toBe(nullNetCost);
  }, 300_000);

  test("null after NaN returns the finite null result (A4 reproduction)", () => {
    const r = runJointOptimizer(jointSmall({ pretaxStart: null as never }));
    if (typeof nullNetCost !== "number") throw new Error("null baseline was not captured");
    expect(r.selectedWinner?.cost.netCost).toBe(nullNetCost);
  }, 300_000);

  // NOTE — no behavioral test runs a cold Infinity joint search:
  // probe C found it pathologically slow (~260 s CPU and still
  // running, vs 2,750 ms CPU for the equivalent NaN run), an
  // engine pathology for validation territory (C6), not this
  // build. Infinity is pinned at the key level only, by the
  // distinct-keys test above: with distinct keys it can never
  // be served another input's cached result, whatever it prices
  // to on a cold run.
});

// ---------------------------------------------------------------------------
// §8 performance regression harness
// ---------------------------------------------------------------------------
describe("C7 §8 performance regression harness (CPU budgets, small shapes)", () => {
  test("fixed-age runOptimizer, 1 draw order, 5y: completes, deterministic, 505 candidates", () => {
    const first = measure(() => runOptimizer(small5y(), { searchOrders: false }));
    expect(first.out.candidatesTested).toBe(505);
    expect(first.out.selectedWinner).toBeDefined();
    expect(Number.isFinite(first.out.selectedWinner?.cost.netCost)).toBe(true);
    const second = measure(() => runOptimizer(small5y(), { searchOrders: false }));
    expect(second.out.candidatesTested).toBe(505);
    expect(optimizerDigest(second.out)).toBe(optimizerDigest(first.out));
    // Baseline: probe A measured 1,453 / 1,348 ms CPU on this
    // 5y shape; audit-blocking.md measured 4,838 ms CPU for the
    // same 1-order search on the 38y sample plan. Budget 10,000
    // ms CPU is ~7× the 5y baseline and ~2× the 38y figure.
    expect(first.cpuMs).toBeLessThanOrEqual(10_000);
    // Heap growth at the call: probe A measured +8.3 MB.
    expect(first.heapDeltaMb).toBeLessThanOrEqual(128);
  }, 300_000);

  test("joint optimizer, 1 combo, 5y: cold completes, hit is identical, counts hold", () => {
    const cold = measure(() => runJointOptimizer(jointSmall()));
    expect(cold.out.jointSearch?.combosTested).toBe(1);
    expect(cold.out.candidatesTested).toBe(3025);
    expect(Number.isFinite(cold.out.selectedWinner?.cost.netCost)).toBe(true);
    const hit = measure(() => runJointOptimizer(jointSmall()));
    expect(jointDigest(hit.out)).toBe(jointDigest(cold.out));
    expect(hit.out.jointSearch?.combosTested).toBe(1);
    // Baselines: probe A measured 3,558 ms CPU cold and 892 ms
    // CPU for the hit on this 5y shape; audit-cache.md measured
    // 470 ms CPU cold (3y, 1 combo) and 941 ms CPU for a hit
    // (5y clone). Budgets are ~5× the 5y baselines.
    expect(cold.cpuMs).toBeLessThanOrEqual(20_000);
    expect(hit.cpuMs).toBeLessThanOrEqual(5_000);
    // Heap growth at the call: probe A measured +62.8 MB cold,
    // +43.6 MB on the hit (result + stored clone on a miss;
    // cached + returned clone on a hit).
    expect(cold.heapDeltaMb).toBeLessThanOrEqual(256);
    expect(hit.heapDeltaMb).toBeLessThanOrEqual(256);
  }, 300_000);

  test("runRothCompare, 3 scenarios, 38y: completes, deterministic, 3 priced", () => {
    const run = () =>
      runRothCompare(
        sampleCompareBase() as never,
        [
          { name: "Do Nothing", overrides: {} },
          { name: "Fill 12%", overrides: { ceilings: ceil(12) } },
          { name: "Fill 22%", overrides: { ceilings: ceil(22) } },
        ] as never,
        2026,
        "Do Nothing",
      );
    const first = measure(run);
    expect(first.out.ok).toBe(true);
    if (!first.out.ok) return;
    expect(first.out.scenarios.length).toBe(3);
    const cents = first.out.scenarios.map((s) => ({
      name: s.name,
      netCostCents: s.netCostCents,
      totalTaxCents: s.totalTaxCents,
      years: s.years.length,
    }));
    for (const s of first.out.scenarios) {
      expect(Number.isFinite(s.netCostCents)).toBe(true);
      expect(s.years.length).toBe(38);
    }
    const second = measure(run);
    expect(second.out.ok).toBe(true);
    if (!second.out.ok) return;
    expect(
      second.out.scenarios.map((s) => ({
        name: s.name,
        netCostCents: s.netCostCents,
        totalTaxCents: s.totalTaxCents,
        years: s.years.length,
      })),
    ).toEqual(cents);
    // Baseline: probe A measured 16 ms CPU for 3 scenarios;
    // audit-blocking.md measured 146 ms CPU for 4 scenarios
    // (620 ms for 50). Budget 5,000 ms CPU is ~30× the
    // 4-scenario baseline.
    expect(first.cpuMs).toBeLessThanOrEqual(5_000);
    expect(first.heapDeltaMb).toBeLessThanOrEqual(128);
  }, 300_000);

  test("retirement Monte Carlo, 1,000 runs: completes, deterministic, 1,000 runs", () => {
    const built = sampleRetirement();
    const first = measure(() =>
      runMonteCarlo(built.inputs, built.expected, built.vol, 12345, 1000),
    );
    expect(first.out).not.toBeNull();
    expect(first.out?.successRate).toBe(97.5);
    expect(first.out?.neverOutSuccessRate).toBe(97.5);
    expect(Number.isFinite(first.out?.p50)).toBe(true);
    const second = measure(() =>
      runMonteCarlo(built.inputs, built.expected, built.vol, 12345, 1000),
    );
    expect(JSON.stringify(second.out)).toBe(JSON.stringify(first.out));
    // Baseline: probe A measured 49 / 24 ms CPU;
    // audit-blocking.md measured 45 ms CPU for 1,000 runs.
    // Budget 2,000 ms CPU is ~40× the baseline.
    expect(first.cpuMs).toBeLessThanOrEqual(2_000);
    expect(first.heapDeltaMb).toBeLessThanOrEqual(128);
  }, 300_000);

  test("solveMaxSpending constant/Monte Carlo 85%: completes, deterministic, feasible", () => {
    const built = sampleRetirement();
    const first = measure(() =>
      solveMaxSpending(built.inputs, built.stocks, built.expected, built.vol, "montecarlo", 85, 12345),
    );
    expect(first.out).not.toBeNull();
    expect(first.out?.solutionStatus).toBe("feasible");
    expect(first.out?.maxSpendingCents).toBe(22_710_000);
    expect(first.out?.successRate).toBe(85.1);
    const second = measure(() =>
      solveMaxSpending(built.inputs, built.stocks, built.expected, built.vol, "montecarlo", 85, 12345),
    );
    expect(JSON.stringify(second.out)).toBe(JSON.stringify(first.out));
    // Baseline: probe A measured 316 / 274 ms CPU;
    // audit-stress.md measured 202 ms CPU for this solver path
    // (the guardrails/MC path, 9,745 ms CPU, is deliberately
    // not harnessed — it is the priciest solver path and would
    // dominate the file's wall time under load).
    // Budget 5,000 ms CPU is ~15× the baseline.
    expect(first.cpuMs).toBeLessThanOrEqual(5_000);
    expect(first.heapDeltaMb).toBeLessThanOrEqual(256);
  }, 300_000);

  test("work-years, 1 quit age, small shape: completes, deterministic, 1 row", () => {
    // Small shape: 4-year horizon (ages 62→66) with both SS
    // benefits already claiming (start ages 58/56), so the
    // rolled joint search is 1 combo. The unlocked-SS variant
    // of this shape searches ~72 claiming-age combos and was
    // still running after 10+ minutes in probe B — that is the
    // precedent test's shape (workYearsReview7Hsa.test.ts §4,
    // 900 s timeout), not a harness shape.
    const plan = samplePlanInputs({
      endAgePrimary: 66,
      windowStartAge: 62,
      windowStopAge: 64,
      retirementAge: 62,
      ssPrimaryStartAge: 58,
      ssSpouseStartAge: 56,
    });
    const job = {
      salary: 100000,
      employer401k: 0,
      employerHsa: 0,
      hsaCoverage: "family" as const,
      hsaEligible: true,
      priorYearWages: 90000,
    };
    const run = () => runWorkYearsCompare(plan, job, [63]);
    const first = measure(run);
    expect(first.out.length).toBe(1);
    const row = first.out[0]!;
    expect(row.quitAge).toBe(63);
    expect(row.workYears).toBe(1);
    expect(Number.isFinite(row.allInTax)).toBe(true);
    expect(Number.isFinite(row.endingAfterTax)).toBe(true);
    const second = measure(run);
    expect(second.out.length).toBe(1);
    const secondRow = second.out[0]!;
    expect(secondRow.allInTax).toBe(row.allInTax);
    expect(secondRow.endingAfterTax).toBe(row.endingAfterTax);
    expect(secondRow.totalTax).toBe(row.totalTax);
    // Baseline: probe E measured 5,869 ms CPU cold (551 ms on
    // the repeat — the rolled joint hits the module cache) and
    // +49.3 MB heap on this SS-locked 1-age shape;
    // audit-blocking.md measured ~25,400 ms CPU per quit age on
    // the full 38y no-SS shape, and the unlocked-SS variant of
    // this small shape searches ~72 claiming-age combos (probe B:
    // still running after 10+ minutes). Budget 30,000 ms CPU is
    // ~5× the locked-shape baseline.
    expect(first.cpuMs).toBeLessThanOrEqual(30_000);
    expect(first.heapDeltaMb).toBeLessThanOrEqual(256);
  }, 300_000);
});
