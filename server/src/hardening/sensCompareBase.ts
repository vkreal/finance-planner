/* ---------------- Sensitivity checks: shared compare base ----------
   Part 4 of the hardening block (sensitivity review). The
   fictional sample household (server/src/sampleHousehold.ts) as
   a runRothCompare base, plus the conversion-cap ceiling
   presets the sensitivity modules price against it. One shared
   construction so the return, spending, and cap-ordering
   modules price the same household and cannot drift apart —
   the shape is the gate probe's sampleBase (the regression
   gate's sample-household full plan), lifted here unchanged.

   FICTIONAL SAMPLE DATA — every figure comes from
   sampleHousehold.ts; no figure here describes any actual
   person's finances. */

import type {
  RothCompareBaseSaved,
  RothCompareCeilingsCents,
} from "../rothOptimizer";
import {
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
  SAMPLE_PRESERVE_PRETAX_CENTS,
  SAMPLE_PRETAX_CENTS,
  SAMPLE_PROTECT_MIN_TAXABLE_CENTS,
  SAMPLE_QUALIFIED_SHARE_PCT,
  SAMPLE_ROTH_CENTS,
  SAMPLE_SS_PRIMARY_CENTS,
  SAMPLE_SS_PRIMARY_START_AGE,
  SAMPLE_SS_SPOUSE_CENTS,
  SAMPLE_SS_SPOUSE_START_AGE,
  SAMPLE_TAXABLE_BASIS_PCT,
  SAMPLE_TAXABLE_CENTS,
} from "../sampleHousehold";

/* ---- The sample household as a compare base -----------------------
   Retirement at 62, end age 95, 5% expected real return,
   $180,000/yr spending, the sample SS anchors at 67, preserve
   $250,000 of pre-tax at a 10% exit rate, heir rate 24%. A
   fresh object per call — callers override fields on their own
   copy and never mutate the shared shape. */
export function sampleCompareBase(): RothCompareBaseSaved {
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

/* ---- Conversion-cap ceiling presets (cents) -----------------------
   The four fixed strategies the cap-ordering module ranks:
   Do Nothing is ceilings: null (no preset needed). Fill to
   the cliff caps MAGI at the cliff less a $5,000 buffer. */
export const FILL_12_CEILINGS: RothCompareCeilingsCents = {
  bracketTopPct: 12,
  irmaaTierCap: null,
  ltcgZeroCap: false,
  acaCliffCap: false,
  acaCliffCapFamilyOnly: false,
  magiCapCents: null,
  acaCliffBufferCents: null,
};

export const FILL_22_CEILINGS: RothCompareCeilingsCents = {
  bracketTopPct: 22,
  irmaaTierCap: null,
  ltcgZeroCap: false,
  acaCliffCap: false,
  acaCliffCapFamilyOnly: false,
  magiCapCents: null,
  acaCliffBufferCents: null,
};

export const FILL_CLIFF_CEILINGS: RothCompareCeilingsCents = {
  bracketTopPct: null,
  irmaaTierCap: null,
  ltcgZeroCap: false,
  acaCliffCap: true,
  acaCliffCapFamilyOnly: false,
  magiCapCents: null,
  acaCliffBufferCents: 500000, // $5,000 buffer under the cliff
};
