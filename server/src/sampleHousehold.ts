/* ---------------- Shared fictional sample household ----------------
   FICTIONAL SAMPLE DATA — for tests and fixtures ONLY.

   Every figure in this module is invented: round numbers chosen so
   the arithmetic in a fixture's note can be checked by eye. This is
   NOT a real household, and no figure here describes any actual
   person's finances. NEVER replace any value in this file with a
   real household's figure, and never copy a real figure into a new
   fixture, test, comment, or doc "just to make the case realistic" —
   that is exactly how real figures leak into the public repo. Real
   households are verified through the app's own saved records, never
   through fixture data.

   PURPOSE: this module is the ONE reference household for NEW
   fixtures and tests. When a new case needs balances, spending, ACA
   benchmarks, filed-return actuals, ages, or a Social Security
   anchor, take them from here (and say so in the case's note) rather
   than inventing fresh numbers — and rather than reaching for the
   figures of any household the app actually serves.

   EXISTING FIXTURES DO NOT IMPORT THIS MODULE, and must not be
   refactored to: the tax census, extended, retirement, and December
   suites already carry fictional figures inline after the
   generalization builds, and re-pointing them here risks moving
   their pins for no benefit. This module governs new work only.

   CONSISTENCY: the values below are one household, not a grab-bag —
   the 2025 filed-return actuals imply the yields pinned at the
   bottom (ordinary dividends $20,000 over the $2,000,000 taxable
   balance = a 1.00% dividend yield; interest $1,500 over the same
   balance = a 0.075% interest yield; qualified $15,000 of $20,000
   ordinary = a 75% qualified share), and the balances, spending,
   and benchmarks are the fictional values the generalization
   builds standardized on, so a new case written against this
   household reads the same as the generalized cases already in
   the suites. */

import { DEFAULT_DRAW_ORDER, type RothPlanInputs } from "./taxEngine";
import type { FilingStatus } from "./taxLaw";
import type { RothTaxReturnStored } from "./taxReturnCore";

/* ---- People -------------------------------------------------------
   A married couple filing jointly, two kids (ACA household of 4).
   Birth years are the durable form (the engines price from them);
   the ages are what those years mean in the sample start year. */
export const SAMPLE_START_YEAR = 2026;
export const SAMPLE_BIRTH_YEAR_PRIMARY = 1968; // age 58 in 2026
export const SAMPLE_BIRTH_YEAR_SPOUSE = 1970; // age 56 in 2026
export const SAMPLE_FILING_STATUS: FilingStatus = "mfj";
export const SAMPLE_HOUSEHOLD_SIZE = 4;
export const SAMPLE_RETIREMENT_AGE = 62;
export const SAMPLE_END_AGE = 95;
export const SAMPLE_WINDOW_START_AGE = 62;
export const SAMPLE_WINDOW_STOP_AGE = 73;

/* ---- Balances (cents) ---------------------------------------------
   The bucket split a Net Worth snapshot of this household carries:
   pre-tax $1,500,000, taxable $2,000,000, Roth $400,000, HSA
   $75,000, cash $100,000, 529 $150,000, non-taxable $50,000. The
   taxable balance carries a 60% cost basis. */
export const SAMPLE_PRETAX_CENTS = 150_000_000; // $1,500,000
export const SAMPLE_TAXABLE_CENTS = 200_000_000; // $2,000,000
export const SAMPLE_ROTH_CENTS = 40_000_000; // $400,000
export const SAMPLE_HSA_CENTS = 7_500_000; // $75,000
export const SAMPLE_CASH_CENTS = 10_000_000; // $100,000
export const SAMPLE_529_CENTS = 15_000_000; // $150,000
export const SAMPLE_NON_TAXABLE_CENTS = 5_000_000; // $50,000
export const SAMPLE_TAXABLE_BASIS_PCT = 60;

/* ---- Spending -------------------------------------------------------
   $180,000 per year. */
export const SAMPLE_ANNUAL_SPENDING_CENTS = 18_000_000; // $180,000/yr

/* ---- ACA benchmark premiums (cents per year) ------------------------
   The second-lowest-cost Silver benchmarks this household's cases
   price against, by household tier: family (3+) $36,000, couple
   $25,000, single $17,500. */
export const SAMPLE_ACA_BENCHMARK_FAMILY_CENTS = 3_600_000; // $36,000/yr
export const SAMPLE_ACA_BENCHMARK_COUPLE_CENTS = 2_500_000; // $25,000/yr
export const SAMPLE_ACA_BENCHMARK_SINGLE_CENTS = 1_750_000; // $17,500/yr

/* ---- Filed-return actuals (the sample 2025 return, cents) -----------
   Form 1040 lines as the stored tax-return shape carries them:
   line 2b taxable interest $1,500; line 3b ordinary dividends
   $20,000 (the total, which INCLUDES the qualified part); line 3a
   qualified dividends $15,000 — a 75% qualified share. */
export const SAMPLE_TAX_RETURN_YEAR = 2025;
export const SAMPLE_TAX_RETURN_INTEREST_CENTS = 150_000; // $1,500
export const SAMPLE_TAX_RETURN_ORDINARY_DIVIDENDS_CENTS = 2_000_000; // $20,000
export const SAMPLE_TAX_RETURN_QUALIFIED_DIVIDENDS_CENTS = 1_500_000; // $15,000

export const SAMPLE_TAX_RETURN: RothTaxReturnStored = {
  taxReturnInterestCents: SAMPLE_TAX_RETURN_INTEREST_CENTS,
  taxReturnQualifiedDividendsCents: SAMPLE_TAX_RETURN_QUALIFIED_DIVIDENDS_CENTS,
  taxReturnOrdinaryDividendsCents: SAMPLE_TAX_RETURN_ORDINARY_DIVIDENDS_CENTS,
  taxReturnYear: SAMPLE_TAX_RETURN_YEAR,
};

/* ---- Social Security anchors (cents per year) -----------------------
   The entered yearly benefit at the entered start age — the anchor
   the engines re-price to other claiming ages. Primary $48,000/yr
   at 67; spouse $30,000/yr at 67. */
export const SAMPLE_SS_PRIMARY_CENTS = 4_800_000; // $48,000/yr
export const SAMPLE_SS_PRIMARY_START_AGE = 67;
export const SAMPLE_SS_SPOUSE_CENTS = 3_000_000; // $30,000/yr
export const SAMPLE_SS_SPOUSE_START_AGE = 67;

/* ---- Plan guardrails ------------------------------------------------
   The standing sample values a plan fixture reaches for: protect at
   least $50,000 of taxable, preserve $250,000 of pre-tax, heirs'
   rate 24%, expected real return 5%, inflation 2.5%. */
export const SAMPLE_PROTECT_MIN_TAXABLE_CENTS = 5_000_000; // $50,000
export const SAMPLE_PRESERVE_PRETAX_CENTS = 25_000_000; // $250,000
export const SAMPLE_HEIR_RATE_PCT = 24;
export const SAMPLE_EXPECTED_RETURN_PCT = 5;
export const SAMPLE_INFLATION_PCT = 2.5;

/* ---- Yields implied by the sample return over the taxable balance ---
   Derived, not chosen: each is the filed actual above divided by
   the $2,000,000 taxable balance, so a fixture that enters the
   actuals and a fixture that enters the yields describe the same
   household. If a balance or an actual above ever changes, these
   move with it — recompute, don't re-pick. */
export const SAMPLE_DIVIDEND_YIELD_PCT = 1; // $20,000 / $2,000,000
export const SAMPLE_INTEREST_YIELD_PCT = 0.075; // $1,500 / $2,000,000
export const SAMPLE_QUALIFIED_SHARE_PCT = 75; // $15,000 / $20,000

/* ---- The household as one object ------------------------------------
   The same values grouped the way a snapshot / saved record groups
   them, for a fixture that wants the whole household at once.
   Money is cents throughout, exactly as stored shapes carry it. */
export const SAMPLE_HOUSEHOLD = {
  startYear: SAMPLE_START_YEAR,
  birthYearPrimary: SAMPLE_BIRTH_YEAR_PRIMARY,
  birthYearSpouse: SAMPLE_BIRTH_YEAR_SPOUSE,
  filingStatus: SAMPLE_FILING_STATUS,
  householdSize: SAMPLE_HOUSEHOLD_SIZE,
  retirementAge: SAMPLE_RETIREMENT_AGE,
  endAge: SAMPLE_END_AGE,
  balancesCents: {
    pretax: SAMPLE_PRETAX_CENTS,
    taxable: SAMPLE_TAXABLE_CENTS,
    roth: SAMPLE_ROTH_CENTS,
    hsa: SAMPLE_HSA_CENTS,
    cash: SAMPLE_CASH_CENTS,
    college529: SAMPLE_529_CENTS,
    nonTaxable: SAMPLE_NON_TAXABLE_CENTS,
  },
  taxableBasisPct: SAMPLE_TAXABLE_BASIS_PCT,
  annualSpendingCents: SAMPLE_ANNUAL_SPENDING_CENTS,
  acaBenchmarksCents: {
    family: SAMPLE_ACA_BENCHMARK_FAMILY_CENTS,
    couple: SAMPLE_ACA_BENCHMARK_COUPLE_CENTS,
    single: SAMPLE_ACA_BENCHMARK_SINGLE_CENTS,
  },
  taxReturn: SAMPLE_TAX_RETURN,
  socialSecurity: {
    primaryAnnualCents: SAMPLE_SS_PRIMARY_CENTS,
    primaryStartAge: SAMPLE_SS_PRIMARY_START_AGE,
    spouseAnnualCents: SAMPLE_SS_SPOUSE_CENTS,
    spouseStartAge: SAMPLE_SS_SPOUSE_START_AGE,
  },
} as const;

/* ---- Engine inputs ----------------------------------------------------
   The household as a complete RothPlanInputs in the engine's own
   units (dollars, not cents): the starting point for a new plan /
   Playground fixture. A case overrides only the fields its note
   varies; every other field stays the sample household's, so the
   note can say "the sample household, except …" and mean it. */
export function samplePlanInputs(
  overrides: Partial<RothPlanInputs> = {},
): RothPlanInputs {
  const base: RothPlanInputs = {
    startYear: SAMPLE_START_YEAR,
    birthYearPrimary: SAMPLE_BIRTH_YEAR_PRIMARY,
    birthYearSpouse: SAMPLE_BIRTH_YEAR_SPOUSE,
    filingStatus: SAMPLE_FILING_STATUS,
    endAgePrimary: SAMPLE_END_AGE,
    pretaxStart: SAMPLE_PRETAX_CENTS / 100,
    rothStart: SAMPLE_ROTH_CENTS / 100,
    taxableStart: SAMPLE_TAXABLE_CENTS / 100,
    hsaStart: SAMPLE_HSA_CENTS / 100,
    taxableBasisPct: SAMPLE_TAXABLE_BASIS_PCT,
    taxableDividendYieldPct: SAMPLE_DIVIDEND_YIELD_PCT,
    taxableInterestYieldPct: SAMPLE_INTEREST_YIELD_PCT,
    taxableDividendQualifiedPct: SAMPLE_QUALIFIED_SHARE_PCT,
    annualSpending: SAMPLE_ANNUAL_SPENDING_CENTS / 100,
    retirementAge: SAMPLE_RETIREMENT_AGE,
    expectedReturnPct: SAMPLE_EXPECTED_RETURN_PCT,
    ssPrimaryAnnual: SAMPLE_SS_PRIMARY_CENTS / 100,
    ssPrimaryStartAge: SAMPLE_SS_PRIMARY_START_AGE,
    ssSpouseAnnual: SAMPLE_SS_SPOUSE_CENTS / 100,
    ssSpouseStartAge: SAMPLE_SS_SPOUSE_START_AGE,
    otherOrdinaryAnnual: 0,
    taxExemptInterestAnnual: 0,
    convertedAlreadyThisYear: 0,
    windowStartAge: SAMPLE_WINDOW_START_AGE,
    windowStopAge: SAMPLE_WINDOW_STOP_AGE,
    payTaxFrom: "taxable",
    protectMinTaxable: SAMPLE_PROTECT_MIN_TAXABLE_CENTS / 100,
    heirRatePct: SAMPLE_HEIR_RATE_PCT,
    drawOrder: [...DEFAULT_DRAW_ORDER],
    spouseSoleBeneficiary: true,
    primarySoleBeneficiaryOfSpouse: true,
    acaHouseholdSize: SAMPLE_HOUSEHOLD_SIZE,
    acaHouseholdSchedule: null,
    acaBenchmarkFamily: SAMPLE_ACA_BENCHMARK_FAMILY_CENTS / 100,
    acaBenchmarkCouple: SAMPLE_ACA_BENCHMARK_COUPLE_CENTS / 100,
    acaBenchmarkSingle: SAMPLE_ACA_BENCHMARK_SINGLE_CENTS / 100,
    inflationPct: SAMPLE_INFLATION_PCT,
    stateRatePct: 0,
  };
  return Object.assign(base, overrides);
}
