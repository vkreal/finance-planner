// Engine Review C7 (§8) — shared harness shapes.
//
// The small shapes of the fictional sample household that the
// performance regression harness prices, plus the measurement
// helper and the canonical digests. Shared by
// performanceRegression.test.ts (the in-process cache-key tests)
// and performanceLegRunner.ts (the fresh-process benchmark legs),
// so the two halves of the harness can never drift apart on what
// a shape is.
//
// All households are the fictional sample household
// (server/src/sampleHousehold.ts) or small derived variants —
// 5-year horizons, one draw order / one claiming-age combo / one
// quit age — so every workload completes on the 6 GB VM. The
// full-size shapes do NOT complete here (audit-blocking.md: the
// 81-combo joint OOMs; a 2-age work-years call never returned),
// which is why the harness pins small shapes, not full ones.

import type {
  JointOptimizerResult,
  OptimizerResult,
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
import { buildSimInputs } from "./retirementEngines";

// --- Measurement helper ---------------------------------------------
// CPU milliseconds (user+sys) spent inside fn, plus the heapUsed
// growth across it. Callers assert on cpuMs; heapDeltaMb is only
// ever asserted against a loose upper bound.
//
// Runs in the leg runner's fresh child process (see
// performanceLegRunner.ts), never in the test process — see the
// SHOULD-2 note in performanceRegression.test.ts for why an
// in-process reading cannot be trusted. NO forced GC here:
// Bun.gc(true) corrupts Bun's heapUsed reading (it stays ~0.1 MB
// even after allocating a million-element array), so the fresh
// process itself is the clean baseline.
export function measure<T>(fn: () => T): {
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
export const small5y = (
  overrides: Partial<RothPlanInputs> = {},
): RothPlanInputs =>
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
export const jointSmall = (
  overrides: Record<string, unknown> = {},
): RothPlanInputs =>
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
export function sampleCompareBase(): Record<string, unknown> {
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

export const ceil = (bracketTopPct: number) => ({
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
export function sampleRetirement() {
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
export function optimizerDigest(r: OptimizerResult): string {
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

export function jointDigest(r: JointOptimizerResult): string {
  return JSON.stringify({
    combosTested: r.jointSearch?.combosTested,
    candidatesTested: r.candidatesTested,
    winnerKey: r.selectedWinner?.spec.key,
    winnerNetCost: r.selectedWinner?.cost.netCost,
    winnerEndingWealth: r.selectedWinner?.result.endingAfterTaxWealth,
  });
}
