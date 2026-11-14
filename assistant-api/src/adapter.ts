// Assistant-API adapter: engine-mapping core.
//
// Maps a NormalizedScenario (built by ./normalize) onto the Finance
// Planner's own engines and returns the AdapterResponse envelope.
// Every exported function takes a NormalizedScenario, returns an
// AdapterResult, and never throws: engine exceptions become
// { ok: false, error: { code: "engine_error", ... } } with a safe
// message (no stack, no internals).
//
// This file never reads stored records, sample data, or any
// persistence layer. Its only engine imports are the five pure
// modules listed below. Transitive imports were verified in the
// read-only tree copy:
//   - retirementEngines imports only ./retirementData (a static
//     historical-returns table, no sample household).
//   - taxEngine imports only ./taxLaw (static law tables).
//   - taxLaw has no imports.
//   - rothOptimizer imports taxEngine, taxLaw, taxReturnCore
//     (no imports of its own), giftModel (taxEngine / taxLaw /
//     rothOptimizer only), rothSeed, and retirementEngines.
//   - rothSeed's top-level statements are const declarations and
//     function declarations only: loading the module executes no
//     I/O and reads no stored data. This file never imports
//     rothSeed directly; rothOptimizer pulls DEFAULT_HEIR_RATE_PCT
//     from it, and this file cites that constant's value in a
//     comment beside the literal below.
//   - workYears imports taxEngine, taxLaw, and rothOptimizer.
//   - None of the five modules (or their transitive imports)
//     imports sampleHousehold, actions, apiContractCore, schema,
//     drizzle-orm, or any storage module.
//
// Money: the sim engines and the Roth compare work in integer
// CENTS; RothPlanInputs, PlaygroundYear*, and the work-years
// engine work in DOLLARS. centsToDollars / dollarsToCents are
// the only conversions, applied at each boundary. API results
// are dollars rounded to 2dp.
//
// VERIFIED DEVIATIONS from the build brief (each checked against
// the engine source in the tree copy; the engine wins):
//   D1. runMonteCarlo's expected/vol are DECIMALS (the client
//       divides by 100 before calling it; buildSimInputs also
//       returns decimals), not percents. This file passes
//       expectedReturnPct / 100 and volatilityPct / 100.
//   D2. solveMaxSpending's targetPct is PERCENT units 0-100
//       (the client clamps the target to 0-100; the fixtures
//       default it to 95; the engine compares it against
//       successRate, which is itself 0-100). This file passes
//       85 for an 85% target, not 0.85.
//   D3. RothSavedLike.drawOrder is a KEY STRING
//       ("taxable-pretax-roth", ...), not an array. Draw-order
//       overrides use the key strings.
//   D4. The compare's ceilings overrides are RothCompareCeilingsCents
//       (magiCapCents / acaCliffBufferCents, cents), not the
//       FillCeilings shape of taxEngine's NO_CEILINGS
//       (magiCap / acaCliffBuffer, dollars). This file defines
//       its own NO_CEILINGS_CENTS and never spreads NO_CEILINGS.
//   D5. windowStopAge has no fixed default: planInputsFromSaved
//       derives Math.ceil(rmdAgeForBirthYear(birthYearPrimary)) - 1.
//       The saved base below leaves windowStopAge null so the
//       engine derives it; buildRothPlanInputs applies the same
//       formula for the work-years plan.
//   D6. PlaygroundYearResult carries NO settlement flags
//       (no settlementConverged / settlementMismatchCents /
//       ceilingBreached). Those live on RothYear and on the
//       compare's per-year rows, so the single-year echo has
//       none to carry; the compare yearly table does carry them.
//   D7. The compare's per-year rows (RothCompareScenarioYear)
//       carry tax, ACA credit, IRMAA, conversion, and settlement
//       flags, but NOT spending or per-year ending balances, so
//       the down-sampled yearly table omits those two columns
//       and says so in a warning instead of inventing them.
//   D8. compareRetirementAges prices a work-years leg (extra
//       years worked past the earliest retirement age, via
//       runWorkYearsCompare) ONLY when a salary was provided.
//       Without one the comparison still answers from the
//       tax-aware Roth compare, with workYears [] and a warning
//       saying the work-years detail needs a salary — the tool
//       never rejects a call for a nice-to-have input. (Assembly
//       fix: the builder's draft gated the whole function on a
//       missing salary.)
//   D9. solveMaxSpending's Monte Carlo leg always runs
//       MONTE_CARLO_TAB_RUNS (1000) — the solver takes no run
//       count, so a supplied mcRuns is inert for
//       retirement_max_spending. calculateMaxSpending reports the
//       effective count as runs: 1000 plus an mcRunsEffective
//       engine_constant assumption, instead of echoing the
//       caller's mcRuns as if it had been used.
//   D10. The envelope's taxLawYear is the first plan year priced
//       (scenario.startYear) — NOT the scenario's taxYear input.
//       A multi-year tool prices each march year under that year's
//       tables starting at startYear, so echoing a caller-supplied
//       taxYear would claim a law year nothing was priced under
//       (pass-4 S1: a compare call with taxYear 2025 echoed
//       taxLawYear 2025 while the march priced from 2026). Only
//       calculateSingleYearTax overrides it, with the year it
//       actually priced (scenario.taxYear).

import {
  GUARDRAILS_ADJUSTMENT_DEFAULT,
  GUARDRAILS_CUT_DEFAULT,
  GUARDRAILS_RAISE_DEFAULT,
  MONTE_CARLO_TAB_RUNS,
  PHASE_DECLINE_PCT_DEFAULT,
  PHASE_START_AGE_DEFAULT,
  horizonYears,
  runHistorical,
  runMonteCarlo,
  runNeverRunsOut,
  simulateDetailed,
  solveMaxSpending,
  type SimInputs,
  type SpendingStrategy,
} from "../../server/src/retirementEngines";
import {
  pricePlaygroundYear,
  runRothCompare,
  type PlaygroundYearInputs,
  type PlaygroundYearResult,
  type RothCompareBaseSaved,
  type RothCompareCeilingsCents,
  type RothCompareOverrides,
  type RothCompareScenarioResult,
} from "../../server/src/rothOptimizer";
import {
  type DrawOrder,
  type RothPlanInputs,
} from "../../server/src/taxEngine";
import { rmdAgeForBirthYear, TAX_LAW_YEARS } from "../../server/src/taxLaw";
import {
  runWorkYearsCompare,
  type WorkYearJob,
  type WorkYearsCompareRow,
} from "../../server/src/workYears";
import {
  ADAPTER_VERSION,
  API_CONTRACT_VERSION_REPORTED,
  type AdapterError,
  type AdapterResponse,
  type AdapterResult,
  type Assumption,
  type Provenance,
} from "./types";
import { publicEffectiveInputs, type NormalizedScenario } from "./normalize";

// ---------------------------------------------------------------------------
// Money + envelope helpers
// ---------------------------------------------------------------------------

/** Engine cents -> API dollars, rounded to 2dp. */
export function centsToDollars(cents: number): number {
  return Math.round(cents) / 100;
}

/** API dollars -> engine cents. */
export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

/** Dollar-native engine figures -> API dollars, rounded to 2dp. */
function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Recursively round every number in an engine result to 2dp. */
function roundDeep<T>(value: T): T {
  if (typeof value === "number") return r2(value) as T;
  if (Array.isArray(value)) return value.map(roundDeep) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = roundDeep(v);
    }
    return out as T;
  }
  return value;
}

function engineError(message: string): AdapterError {
  return {
    ok: false,
    source: "finance-planner-engine",
    adapterVersion: ADAPTER_VERSION,
    apiContractVersion: API_CONTRACT_VERSION_REPORTED,
    error: { code: "engine_error", message },
  };
}

function unsupported(message: string): AdapterError {
  return {
    ok: false,
    source: "finance-planner-engine",
    adapterVersion: ADAPTER_VERSION,
    apiContractVersion: API_CONTRACT_VERSION_REPORTED,
    error: { code: "unsupported", message },
  };
}

/** Run a function body and convert any thrown exception into engine_error. */
function guard<T>(fn: () => AdapterResult<T>): AdapterResult<T> {
  try {
    return fn();
  } catch {
    return engineError("The engine could not price this scenario.");
  }
}

/**
 * Shared envelope builder. Never mutates the scenario: assumptions and
 * warnings are copied with adapter additions appended.
 */
function respond<T>(
  scenario: NormalizedScenario,
  results: T,
  warnings: string[] = [],
  extraAssumptions: Assumption[] = [],
  // D10: the first plan year priced; only the single-year tool
  // passes the year it actually priced (scenario.taxYear).
  taxLawYear: number | null = null,
): AdapterResult<T> {
  const response: AdapterResponse<T> = {
    ok: true,
    source: "finance-planner-engine",
    adapterVersion: ADAPTER_VERSION,
    apiContractVersion: API_CONTRACT_VERSION_REPORTED,
    taxLawYear: taxLawYear ?? scenario.startYear,
    effectiveInputs: publicEffectiveInputs(scenario),
    assumptions: [...scenario.assumptions, ...extraAssumptions],
    warnings: [...scenario.warnings, ...warnings],
    results,
  };
  return response;
}

function assumption(
  field: string,
  value: unknown,
  provenance: Provenance,
  note: string,
): Assumption {
  return { field, value, provenance, note };
}

// ---------------------------------------------------------------------------
// Engine constants referenced by value (see the header note on rothSeed)
// ---------------------------------------------------------------------------

/** Exit rate on ending pre-tax balances when no heir rate is entered. */
const HEIR_RATE_PCT = 22; // rothSeed DEFAULT_HEIR_RATE_PCT (engine_constant)

/** No-ceilings shape for compare overrides (D4: cents keys, not FillCeilings). */
const NO_CEILINGS_CENTS: RothCompareCeilingsCents = {
  bracketTopPct: null,
  irmaaTierCap: null,
  ltcgZeroCap: false,
  acaCliffCap: false,
  acaCliffCapFamilyOnly: false,
  magiCapCents: null,
  acaCliffBufferCents: null,
};

const HEALTH_PREMIUM_WARNING =
  "Health insurance premiums are not included; only the ACA premium credit and IRMAA surcharge are priced.";

// ---------------------------------------------------------------------------
// Scenario -> engine inputs
// ---------------------------------------------------------------------------

function validStrategy(raw: string): SpendingStrategy {
  if (
    raw === "constant" ||
    raw === "percent" ||
    raw === "guardrails" ||
    raw === "phased"
  ) {
    return raw;
  }
  return "constant";
}

/**
 * The sim engine has ONE extra-income stream (amount + start age) but a
 * household may have two Social Security streams. Rule: streams that
 * start the same year sum exactly (same timing, one amount); otherwise
 * model the earliest-starting stream and say so in a warning — the
 * second stream is still priced by the tax-aware Roth compare.
 */
function simExtraIncome(scenario: NormalizedScenario): {
  extraIncomeCents: number;
  extraIncomeStartAge: number | null;
  warning: string | null;
} {
  const streams: { amountCents: number; startAge: number | null }[] = [];
  if (scenario.ssPrimaryAnnual > 0) {
    streams.push({
      amountCents: dollarsToCents(scenario.ssPrimaryAnnual),
      startAge: scenario.ssPrimaryStartAge,
    });
  }
  if (
    scenario.ssSpouseAnnual > 0 &&
    scenario.birthYearSpouse != null
  ) {
    streams.push({
      amountCents: dollarsToCents(scenario.ssSpouseAnnual),
      startAge: scenario.ssSpouseStartAge,
    });
  }
  if (streams.length === 0) {
    return { extraIncomeCents: 0, extraIncomeStartAge: null, warning: null };
  }
  const resolveStart = (s: { startAge: number | null }): number =>
    s.startAge ?? scenario.retirementAge;
  if (streams.length === 1) {
    const only = streams[0]!;
    return {
      extraIncomeCents: only.amountCents,
      extraIncomeStartAge: resolveStart(only),
      warning: null,
    };
  }
  const a = streams[0]!;
  const b = streams[1]!;
  if (resolveStart(a) === resolveStart(b)) {
    return {
      extraIncomeCents: a.amountCents + b.amountCents,
      extraIncomeStartAge: resolveStart(a),
      warning: null,
    };
  }
  const earliest = resolveStart(a) <= resolveStart(b) ? a : b;
  return {
    extraIncomeCents: earliest.amountCents,
    extraIncomeStartAge: resolveStart(earliest),
    warning:
      "The deterministic projection models one Social Security stream (the earliest-starting); the second stream is included in the tax-aware Roth comparison, not here.",
  };
}

export function toSimInputs(
  scenario: NormalizedScenario,
  overrides?: { retirementAge?: number },
): { inputs: SimInputs; warnings: string[] } {
  const warnings: string[] = [];
  const strategy = validStrategy(scenario.strategy);
  if (strategy !== scenario.strategy) {
    warnings.push(
      `Unknown spending strategy "${scenario.strategy}" — priced as constant spending.`,
    );
  }
  const income = simExtraIncome(scenario);
  if (income.warning) warnings.push(income.warning);
  const inputs: SimInputs = {
    startCents: scenario.portfolioCents,
    spendingCents: scenario.annualSpendingCents,
    currentAge: scenario.currentAge,
    retirementAge: overrides?.retirementAge ?? scenario.retirementAge,
    endAge: scenario.endAge,
    extraIncomeCents: income.extraIncomeCents,
    extraIncomeStartAge: income.extraIncomeStartAge,
    strategy,
    percentOfPortfolio: strategy === "percent" ? 5 : 0,
    guardrailsCutPct: GUARDRAILS_CUT_DEFAULT,
    guardrailsRaisePct: GUARDRAILS_RAISE_DEFAULT,
    guardrailsAdjustmentPct: GUARDRAILS_ADJUSTMENT_DEFAULT,
    phaseStartAge: PHASE_START_AGE_DEFAULT,
    phaseDeclinePct: PHASE_DECLINE_PCT_DEFAULT,
  };
  return { inputs, warnings };
}

/** Flat real returns, one per plan year, as decimals (D1). */
function flatReturns(scenario: NormalizedScenario): number[] {
  const years = horizonYears(scenario.currentAge, scenario.endAge);
  return Array.from({ length: years }, () => scenario.expectedReturnPct / 100);
}

// ---------------------------------------------------------------------------
// Tax-aware base shapes (cents saved shape + dollars plan inputs)
// ---------------------------------------------------------------------------

function noBenefit(amount: number, startAge: number | null): boolean {
  return amount === 0 && startAge == null;
}

/**
 * The full RothCompareBaseSaved (cents) for the scenario. Fields the
 * simple schema does not carry are set to the engine's blank
 * equivalents, never invented: spouse pre-tax $0, no survivor
 * scenario, no preserve floor, no premiums, no loss carryforward,
 * no itemized deductions, no education expenses, no college
 * window, ceilings null (Do Nothing fill).
 */
function buildRothCompareBase(
  scenario: NormalizedScenario,
): RothCompareBaseSaved {
  const spouseAmount =
    scenario.birthYearSpouse == null ? 0 : scenario.ssSpouseAnnual;
  const spouseStartAge =
    scenario.birthYearSpouse == null ? null : scenario.ssSpouseStartAge;
  return {
    birthYearPrimary: scenario.birthYearPrimary,
    birthYearSpouse: scenario.birthYearSpouse,
    filingStatus: scenario.filingStatus,
    pretaxCents: dollarsToCents(scenario.pretaxDollars),
    pretaxSpouseCents: 0,
    survivorEnabled: false,
    survivorWho: "primary",
    survivorDeathYear: null,
    rothCents: dollarsToCents(scenario.rothDollars),
    taxableCents: dollarsToCents(scenario.taxableDollars),
    taxableExcludeCents: null,
    hsaCents: dollarsToCents(scenario.hsaDollars),
    taxableBasisPct: scenario.taxableBasisBlank
      ? null
      : scenario.taxableBasisPct,
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
    ssPrimaryAnnualCents: dollarsToCents(scenario.ssPrimaryAnnual),
    ssPrimaryStartAge: scenario.ssPrimaryStartAge,
    ssPrimaryNoBenefit: noBenefit(
      scenario.ssPrimaryAnnual,
      scenario.ssPrimaryStartAge,
    ),
    ssSpouseAnnualCents: dollarsToCents(spouseAmount),
    ssSpouseStartAge: spouseStartAge,
    ssSpouseNoBenefit: noBenefit(spouseAmount, spouseStartAge),
    otherOrdinaryCents: dollarsToCents(scenario.otherOrdinaryAnnual),
    taxExemptInterestCents: dollarsToCents(scenario.taxExemptInterestAnnual),
    convertedAlreadyCents: 0,
    windowStartAge: scenario.retirementAge,
    // Null so planInputsFromSaved derives the engine's own stop:
    // Math.ceil(rmdAgeForBirthYear(birthYearPrimary)) - 1 (D5).
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
    acaBenchmarkCoupleCents:
      scenario.acaBenchmarkCouple == null
        ? null
        : dollarsToCents(scenario.acaBenchmarkCouple),
    acaBenchmarkSingleCents:
      scenario.acaBenchmarkSingle == null
        ? null
        : dollarsToCents(scenario.acaBenchmarkSingle),
    acaBenchmarkFamilyCents:
      scenario.acaBenchmarkFamily == null
        ? null
        : dollarsToCents(scenario.acaBenchmarkFamily),
    acaSpouseEndAge: null,
    healthPremiumAcaHouseholdCents: null,
    healthPremiumAcaSingleCents: null,
    healthPremiumMedicarePerPersonCents: null,
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
    yearlySalaryCents:
      scenario.salaryAnnual == null
        ? null
        : dollarsToCents(scenario.salaryAnnual),
    employer401kCents: dollarsToCents(scenario.employer401kAnnual),
    employerHsaCents: dollarsToCents(scenario.employerHsaAnnual),
    ceilings: null,
    optimizerGuardrail: null,
    optimizerBunching: null,
    gainsHarvest: null,
  };
}

/**
 * RothPlanInputs (dollars) for the same scenario, mirroring
 * planInputsFromSaved's cents->dollars mapping. Used only by the
 * work-years leg of compareRetirementAges.
 */
function buildRothPlanInputs(
  scenario: NormalizedScenario,
  overrides?: { retirementAge?: number; windowStartAge?: number },
): RothPlanInputs {
  const retirementAge = overrides?.retirementAge ?? scenario.retirementAge;
  const spouseAmount =
    scenario.birthYearSpouse == null ? 0 : scenario.ssSpouseAnnual;
  const spouseStartAge =
    scenario.birthYearSpouse == null ? null : scenario.ssSpouseStartAge;
  // Same derivation the engine applies when the saved shape leaves
  // windowStopAge blank (D5).
  const windowStopAge =
    Math.ceil(rmdAgeForBirthYear(scenario.birthYearPrimary)) - 1;
  const drawOrder: DrawOrder = ["taxable", "pretax", "roth"];
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
    taxableBasisPct: scenario.taxableBasisBlank
      ? 100
      : scenario.taxableBasisPct,
    taxableBasisBlank: scenario.taxableBasisBlank,
    taxableDividendYieldPct: scenario.taxableDividendYieldPct,
    taxableInterestYieldPct: scenario.taxableInterestYieldPct,
    annualSpending: centsToDollars(scenario.annualSpendingCents),
    retirementAge,
    expectedReturnPct: scenario.expectedReturnPct,
    ssPrimaryAnnual: scenario.ssPrimaryAnnual,
    ssPrimaryStartAge: scenario.ssPrimaryStartAge,
    ssPrimaryNoBenefit: noBenefit(
      scenario.ssPrimaryAnnual,
      scenario.ssPrimaryStartAge,
    ),
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
    healthPremiumAcaHousehold: null,
    healthPremiumAcaSingle: null,
    healthPremiumMedicarePerPerson: null,
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
    preservePretax: 0,
  };
}

/** Assumptions attached (on a copy) to every tax-aware result. */
function taxAwareAssumptions(scenario: NormalizedScenario): Assumption[] {
  const list: Assumption[] = [
    assumption(
      "spousePretaxDollars",
      0,
      "assumption",
      "The spouse's own pre-tax balance is modeled as $0: the simple scenario carries no separate spouse pre-tax balance.",
    ),
    assumption(
      "heirRatePct",
      22,
      "engine_constant",
      "The exit rate on ending pre-tax balances (heir rate) is 22%, the engine's DEFAULT_HEIR_RATE_PCT fallback for a blank heir rate.",
    ),
    assumption(
      "preservePretax",
      0,
      "assumption",
      "No pre-tax preserve floor is modeled: the preserve amount is a guideline, not a priced floor, so conversions may draw the pre-tax balance down without a floor.",
    ),
  ];
  if (scenario.filingStatus === "mfj") {
    list.push(
      assumption(
        "spouseSoleBeneficiary",
        true,
        "assumption",
        "The spouse is modeled as the primary's sole beneficiary, so the primary's RMD prices on the Joint and Last Survivor Table.",
      ),
    );
  }
  return list;
}

// ---------------------------------------------------------------------------
// Compare result mapping (shared by the three compare functions)
// ---------------------------------------------------------------------------

type MappedCompareScenario = {
  name: string;
  strategyDescription: string;
  endingWealth: number;
  lifetimeNetCost: number;
  lifetimeTax: number;
  lifetimeFederalTax: number;
  lifetimeStateTax: number;
  acaCreditKept: number;
  irmaaTotal: number;
  endingPretax: number;
  endingTaxable: number;
  endingRoth: number;
  endingHsa: number;
  conversionsTotal: number;
  terminalTax: number;
};

function mapCompareScenario(
  s: RothCompareScenarioResult,
): MappedCompareScenario {
  const conversionsCents = s.years.reduce(
    (sum, y) => sum + y.conversionCents,
    0,
  );
  return {
    name: s.name,
    strategyDescription: s.strategyDescription,
    endingWealth: centsToDollars(s.endingAfterTaxWealthCents),
    lifetimeNetCost: centsToDollars(s.netCostCents),
    lifetimeTax: centsToDollars(s.totalTaxCents),
    lifetimeFederalTax: centsToDollars(s.federalTaxCents),
    lifetimeStateTax: centsToDollars(s.stateTaxCents),
    acaCreditKept: centsToDollars(s.acaCreditCents),
    irmaaTotal: centsToDollars(s.irmaaCents),
    endingPretax: centsToDollars(s.endingPretaxCents),
    endingTaxable: centsToDollars(s.endingTaxableCents),
    endingRoth: centsToDollars(s.endingRothCents),
    endingHsa: centsToDollars(s.endingHsaCents),
    conversionsTotal: centsToDollars(conversionsCents),
    terminalTax: centsToDollars(s.terminalCents),
  };
}

type YearlyCompareRow = {
  year: number;
  agePrimary: number;
  ageSpouse: number | null;
  federalTax: number;
  stateTax: number;
  penalty: number;
  agi: number;
  taxableIncome: number;
  acaCredit: number;
  irmaa: number;
  conversion: number;
  pretaxOutByChoice: number;
  settlementConverged: boolean;
  settlementMismatchGains: number;
  settlementMismatchPretax: number;
  ceilingBreached: boolean;
};

/**
 * Down-sampled yearly table for the baseline scenario, from the
 * compare result's own per-year rows (D7). The rows carry no
 * spending or per-year ending balances, so those columns do not
 * exist here; lifetime ending balances are in the scenario
 * summary. Capped at 60 rows.
 */
function yearlyTable(
  baseline: RothCompareScenarioResult,
): YearlyCompareRow[] {
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
    conversion: centsToDollars(y.conversionCents),
    pretaxOutByChoice: centsToDollars(y.pretaxOutByChoiceCents),
    settlementConverged: y.settlementConverged,
    settlementMismatchGains: centsToDollars(
      y.settlementMismatchCents.gains,
    ),
    settlementMismatchPretax: centsToDollars(
      y.settlementMismatchCents.pretax,
    ),
    ceilingBreached: y.ceilingBreached,
  }));
  if (rows.length <= 60) return rows;
  const stride = Math.ceil(rows.length / 60);
  const picked: YearlyCompareRow[] = [];
  for (let i = 0; i < rows.length; i += stride) picked.push(rows[i]!);
  const last = rows[rows.length - 1]!;
  if (picked[picked.length - 1] !== last) picked.push(last);
  return picked;
}

function pickWinner<T>(
  items: T[],
  better: (a: T, b: T) => boolean,
): T | null {
  let best: T | null = null;
  for (const item of items) {
    if (best === null || better(item, best)) best = item;
  }
  return best;
}

/**
 * Run one runRothCompare and shape the shared compare outcome.
 * A local tagged union (not AdapterResult) so narrowing works:
 * the ok:true member carries `outcome`, the ok:false member the
 * engine's refusal reason as an AdapterError.
 */
type CompareOutcome = {
  mapped: MappedCompareScenario[];
  baseline: MappedCompareScenario;
  baselineRaw: RothCompareScenarioResult;
  winnerByEndingWealth: string | null;
  winnerByNetCost: string | null;
};

function runCompare(
  base: RothCompareBaseSaved,
  scenarios: { name: string; overrides: RothCompareOverrides }[],
  startYear: number,
  baselineName: string,
): { ok: true; outcome: CompareOutcome } | AdapterError {
  const result = runRothCompare(base, scenarios, startYear, baselineName);
  if (!result.ok) {
    return engineError(result.reason);
  }
  const mapped = result.scenarios.map(mapCompareScenario);
  const baselineRaw =
    result.scenarios.find((s) => s.name === result.baselineName) ??
    result.scenarios[0]!;
  const baseline =
    mapped.find((m) => m.name === result.baselineName) ?? mapped[0]!;
  const wealthWinner = pickWinner(mapped, (a, b) => a.endingWealth > b.endingWealth);
  const costWinner = pickWinner(mapped, (a, b) => a.lifetimeNetCost < b.lifetimeNetCost);
  return {
    ok: true,
    outcome: {
      mapped,
      baseline,
      baselineRaw,
      winnerByEndingWealth: wealthWinner ? wealthWinner.name : null,
      winnerByNetCost: costWinner ? costWinner.name : null,
    },
  };
}

function deltasVsBaseline(
  mapped: MappedCompareScenario[],
  baseline: MappedCompareScenario,
): Array<{
  name: string;
  endingWealthDelta: number;
  netCostDelta: number;
}> {
  return mapped
    .filter((m) => m.name !== baseline.name)
    .map((m) => ({
      name: m.name,
      endingWealthDelta: r2(m.endingWealth - baseline.endingWealth),
      netCostDelta: r2(m.lifetimeNetCost - baseline.lifetimeNetCost),
    }));
}

const YEARLY_TABLE_WARNING =
  "The per-year table uses the compare's own yearly rows, which carry tax, credit, IRMAA, conversion, and settlement flags but not spending or per-year ending balances; lifetime ending balances are in each scenario's summary.";

const WORK_YEARS_HORIZON_WARNING =
  "The work-years rows price each quit age as its own plan starting at that quit age with rolled balances, so their ending balances span different horizons and are not like-for-like across quit ages; use the all-in tax and the Roth-compare scenarios for the quit-age decision.";

// ---------------------------------------------------------------------------
// 1. Deterministic projection
// ---------------------------------------------------------------------------

export function calculateRetirement(
  scenario: NormalizedScenario,
): AdapterResult<{
  neverRunsOut: boolean;
  endingBalance: number;
  endingAge: number;
  yearlyBalances: Array<{ age: number; balance: number }>;
  yearlyGrossWithdrawals: Array<{ age: number; amount: number }>;
  yearlyNetWithdrawals: Array<{ age: number; amount: number }>;
  strategy: string;
  historicalNeverOutRate: number | null;
  historicalMedianEnding: number | null;
}> {
  return guard(() => {
    const { inputs, warnings } = toSimInputs(scenario);
    const returns = flatReturns(scenario);
    const det = simulateDetailed(inputs, returns);
    const hist = runHistorical(inputs, scenario.stocksPct);
    const balances = det.balances;
    const lastBalance = balances[balances.length - 1] ?? 0;
    if (hist === null) {
      warnings.push(
        "Historical paths are unavailable for this mix or horizon, so no historical never-out rate is reported.",
      );
    }
    return respond(
      scenario,
      {
        neverRunsOut: runNeverRunsOut(inputs, returns),
        endingBalance: centsToDollars(lastBalance),
        endingAge: scenario.endAge,
        yearlyBalances: balances.map((b, i) => ({
          age: scenario.currentAge + i,
          balance: centsToDollars(b),
        })),
        yearlyGrossWithdrawals: det.grossWithdrawals.map((c, i) => ({
          age: scenario.currentAge + i,
          amount: centsToDollars(c),
        })),
        yearlyNetWithdrawals: det.netWithdrawals.map((c, i) => ({
          age: scenario.currentAge + i,
          amount: centsToDollars(c),
        })),
        strategy: inputs.strategy,
        historicalNeverOutRate:
          hist === null ? null : r2(hist.neverOutSuccessRate / 100),
        historicalMedianEnding:
          hist === null ? null : centsToDollars(hist.medianEnding),
      },
      warnings,
    );
  });
}

// ---------------------------------------------------------------------------
// 2. Monte Carlo
// ---------------------------------------------------------------------------

export function runRetirementMonteCarlo(
  scenario: NormalizedScenario,
): AdapterResult<{
  successRate: number;
  endingP10: number;
  endingP50: number;
  endingP90: number;
  lowestSpending: number | null;
  averageSpending: number | null;
  medianFinalYearSpending: number | null;
  medianFirstRetiredYearSpending: number | null;
  runs: number;
  seed: number;
  chart: Array<{ age: number; median: number; p10: number; p90: number }>;
  deterministicEndingBalance: number;
}> {
  return guard(() => {
    const { inputs, warnings } = toSimInputs(scenario);
    // D1: the engine takes decimals, not percents.
    const mc = runMonteCarlo(
      inputs,
      scenario.expectedReturnPct / 100,
      scenario.volatilityPct / 100,
      scenario.mcSeed,
      scenario.mcRuns,
    );
    if (mc === null) {
      return engineError(
        "Monte Carlo could not price this horizon (the plan end age is at or before the current age).",
      );
    }
    const det = simulateDetailed(inputs, flatReturns(scenario));
    const detEnding = centsToDollars(det.balances[det.balances.length - 1] ?? 0);
    const successRate = r2(mc.neverOutSuccessRate / 100);
    const detRunsOut = detEnding === 0;
    const mcMostlySucceeds = successRate >= 0.5;
    if (detRunsOut && mcMostlySucceeds) {
      warnings.push(
        "Cross-check: the flat-return projection runs out, but at least half of the Monte Carlo paths do not — the flat path is one draw, not the typical outcome.",
      );
    } else if (!detRunsOut && !mcMostlySucceeds) {
      warnings.push(
        "Cross-check: the flat-return projection does not run out, but fewer than half of the Monte Carlo paths succeed — the flat path is more forgiving than most random paths.",
      );
    }
    const fullChart = mc.chart.map((row) => ({
      age: row.age,
      median: r2(row.median),
      p10: r2(row.p10),
      p90: r2(row.p90),
    }));
    let chart = fullChart;
    if (fullChart.length > 41) {
      const stride = Math.ceil(fullChart.length / 41);
      const picked: typeof fullChart = [];
      for (let i = 0; i < fullChart.length; i += stride) {
        picked.push(fullChart[i]!);
      }
      const last = fullChart[fullChart.length - 1]!;
      if (picked[picked.length - 1] !== last) picked.push(last);
      chart = picked;
    }
    return respond(
      scenario,
      {
        successRate,
        endingP10: centsToDollars(mc.p10),
        endingP50: centsToDollars(mc.p50),
        endingP90: centsToDollars(mc.p90),
        lowestSpending:
          mc.lowestSpending == null ? null : centsToDollars(mc.lowestSpending),
        averageSpending:
          mc.averageSpending == null
            ? null
            : centsToDollars(mc.averageSpending),
        medianFinalYearSpending:
          mc.medianFinalYearSpending == null
            ? null
            : centsToDollars(mc.medianFinalYearSpending),
        medianFirstRetiredYearSpending:
          mc.medianFirstRetiredYearSpending == null
            ? null
            : centsToDollars(mc.medianFirstRetiredYearSpending),
        runs: scenario.mcRuns,
        seed: scenario.mcSeed,
        chart,
        deterministicEndingBalance: detEnding,
      },
      warnings,
    );
  });
}

// ---------------------------------------------------------------------------
// 3. Max sustainable spending (Monte Carlo target + historical cross-check)
// ---------------------------------------------------------------------------

export function calculateMaxSpending(
  scenario: NormalizedScenario,
): AdapterResult<{
  maxMonthlySpending: number;
  maxAnnualSpending: number;
  successRate: number;
  medianEnding: number;
  approximate: boolean;
  runs: number;
  historicalMaxMonthlySpending: number | null;
  historicalMaxAnnualSpending: number | null;
}> {
  return guard(() => {
    const { inputs, warnings } = toSimInputs(scenario);
    const expected = scenario.expectedReturnPct / 100;
    const vol = scenario.volatilityPct / 100;
    // D2: the engine's target is percent units (0-100).
    const solved = solveMaxSpending(
      inputs,
      scenario.stocksPct,
      expected,
      vol,
      "montecarlo",
      85,
      scenario.mcSeed,
    );
    if (solved === null) {
      return unsupported(
        "No sustainable spending could be solved for these ages (retirement at/after the plan end age, or no retired years)",
      );
    }
    const histSolved = solveMaxSpending(
      inputs,
      scenario.stocksPct,
      expected,
      vol,
      "historical",
      85,
      scenario.mcSeed,
    );
    const maxAnnual = centsToDollars(solved.maxSpendingCents);
    const histAnnual =
      histSolved === null ? null : centsToDollars(histSolved.maxSpendingCents);
    if (histAnnual !== null) {
      const relDiff =
        maxAnnual === 0 ? (histAnnual > 0 ? Infinity : 0) : Math.abs(histAnnual - maxAnnual) / maxAnnual;
      if (relDiff > 0.2) {
        warnings.push(
          `Cross-check: the historical-engine maximum ($${histAnnual.toLocaleString("en-US")}/yr) differs from the Monte Carlo maximum ($${maxAnnual.toLocaleString("en-US")}/yr) by more than 20%.`,
        );
      }
    } else {
      warnings.push(
        "The historical engine could not solve a maximum for this mix or horizon, so no historical cross-check is reported.",
      );
    }
    return respond(
      scenario,
      {
        maxMonthlySpending: r2(maxAnnual / 12),
        maxAnnualSpending: maxAnnual,
        successRate: r2(solved.successRate / 100),
        medianEnding: centsToDollars(solved.medianEnding),
        approximate: solved.approximate,
        // D9: the solver's fixed run count, not the caller's mcRuns.
        runs: MONTE_CARLO_TAB_RUNS,
        historicalMaxMonthlySpending:
          histAnnual === null ? null : r2(histAnnual / 12),
        historicalMaxAnnualSpending: histAnnual,
      },
      warnings,
      [
        assumption(
          "mcRunsEffective",
          MONTE_CARLO_TAB_RUNS,
          "engine_constant",
          "The max-spending solver always runs the engine's fixed 1,000 Monte Carlo simulations; a supplied mcRuns is not used for this tool.",
        ),
      ],
    );
  });
}

// ---------------------------------------------------------------------------
// 4. Draw-order compare (tax-aware Roth compare, no conversions)
// ---------------------------------------------------------------------------

export function compareWithdrawalStrategies(
  scenario: NormalizedScenario,
): AdapterResult<{
  baselineName: string;
  scenarios: MappedCompareScenario[];
  winnerByEndingWealth: string | null;
  winnerByNetCost: string | null;
  deltas: Array<{
    name: string;
    endingWealthDelta: number;
    netCostDelta: number;
  }>;
  yearly: YearlyCompareRow[];
}> {
  return guard(() => {
    const base = buildRothCompareBase(scenario);
    // D3: the saved shape carries the draw order as a key string.
    // Forced RMDs come out of pre-tax first under every order;
    // the order governs spending draws only (taxEngine).
    const compared = runCompare(
      base,
      [
        { name: "taxable-first", overrides: { drawOrder: "taxable-pretax-roth" } },
        { name: "pre-tax-first", overrides: { drawOrder: "pretax-taxable-roth" } },
        { name: "roth-first", overrides: { drawOrder: "roth-taxable-pretax" } },
      ],
      scenario.startYear,
      "taxable-first",
    );
    if (!compared.ok) return compared;
    const outcome = compared.outcome;
    return respond(
      scenario,
      {
        baselineName: outcome.baseline.name,
        scenarios: outcome.mapped,
        winnerByEndingWealth: outcome.winnerByEndingWealth,
        winnerByNetCost: outcome.winnerByNetCost,
        deltas: deltasVsBaseline(outcome.mapped, outcome.baseline),
        yearly: yearlyTable(outcome.baselineRaw),
      },
      [HEALTH_PREMIUM_WARNING, YEARLY_TABLE_WARNING],
      taxAwareAssumptions(scenario),
    );
  });
}

// ---------------------------------------------------------------------------
// 5. Roth conversion compare
// ---------------------------------------------------------------------------

export function compareRothConversions(
  scenario: NormalizedScenario,
): AdapterResult<{
  baselineName: string;
  scenarios: MappedCompareScenario[];
  winnerByEndingWealth: string | null;
  winnerByNetCost: string | null;
  deltas: Array<{
    name: string;
    endingWealthDelta: number;
    netCostDelta: number;
  }>;
  yearly: YearlyCompareRow[];
}> {
  return guard(() => {
    const base = buildRothCompareBase(scenario);
    // D4: ceilings overrides use the cents shape, not NO_CEILINGS.
    const compared = runCompare(
      base,
      [
        { name: "do-nothing", overrides: { ceilings: null } },
        {
          name: "fill-12%",
          overrides: { ceilings: { ...NO_CEILINGS_CENTS, bracketTopPct: 12 } },
        },
        {
          name: "fill-22%",
          overrides: { ceilings: { ...NO_CEILINGS_CENTS, bracketTopPct: 22 } },
        },
        {
          name: "fill-22%-irmaa-tier-1",
          overrides: {
            ceilings: { ...NO_CEILINGS_CENTS, bracketTopPct: 22, irmaaTierCap: 1 },
          },
        },
      ],
      scenario.startYear,
      "do-nothing",
    );
    if (!compared.ok) return compared;
    const outcome = compared.outcome;
    return respond(
      scenario,
      {
        baselineName: outcome.baseline.name,
        scenarios: outcome.mapped,
        winnerByEndingWealth: outcome.winnerByEndingWealth,
        winnerByNetCost: outcome.winnerByNetCost,
        deltas: deltasVsBaseline(outcome.mapped, outcome.baseline),
        yearly: yearlyTable(outcome.baselineRaw),
      },
      [HEALTH_PREMIUM_WARNING, YEARLY_TABLE_WARNING],
      taxAwareAssumptions(scenario),
    );
  });
}

// ---------------------------------------------------------------------------
// 6. Retirement-age compare (tax-aware Roth compare + work-years leg)
// ---------------------------------------------------------------------------

export function compareRetirementAges(
  scenario: NormalizedScenario,
): AdapterResult<{
  baselineName: string;
  scenarios: Array<MappedCompareScenario & { retirementAge: number }>;
  winnerByEndingWealth: string | null;
  winnerByNetCost: string | null;
  deltas: Array<{
    name: string;
    endingWealthDelta: number;
    netCostDelta: number;
  }>;
  yearly: YearlyCompareRow[];
  workYears: Array<{
    quitAge: number;
    workYears: number;
    workTax: number;
    payrollTax: number;
    totalTax: number;
    shortfall: number;
    allInTax: number;
    claim67AllInTax: number | null;
    endingNominal: number;
    endingAfterTax: number;
    winnerStrategy: string;
    winnerClaimPrimaryAge: number | null;
    winnerClaimSpouseAge: number | null;
  }>;
  workYearsWinnerByAllInTax: string | null;
}> {
  return guard(() => {
    const rawAges =
      scenario.compareAges.length > 0
        ? scenario.compareAges
        : [
            scenario.retirementAge,
            scenario.retirementAge + 2,
            scenario.retirementAge + 5,
          ];
    const ages = [...new Set(rawAges.map((a) => Math.round(a)))]
      .filter((a) => Number.isFinite(a) && a < scenario.endAge)
      .sort((a, b) => a - b);
    if (ages.length < 2) {
      return unsupported(
        `At least two retirement ages below the plan end age (${scenario.endAge}) are needed to compare; only ${ages.length} remain${ages.length === 1 ? ` (age ${ages[0]})` : ""}.`,
      );
    }
    const base = buildRothCompareBase(scenario);
    const firstAge = ages[0]!;
    const compared = runCompare(
      base,
      ages.map((age) => ({
        name: `retire-${age}`,
        overrides: { retirementAge: age, windowStartAge: age },
      })),
      scenario.startYear,
      `retire-${firstAge}`,
    );
    if (!compared.ok) return compared;
    const outcome = compared.outcome;
    // Work-years leg: the earliest age is the window start, so
    // each later quit age prices exactly the extra years worked
    // past it — the app work-years tab's own rule (quit ages must
    // be at or after the window-start age). Each row's rolled plan
    // is priced by the joint optimizer, which may crown different
    // claiming ages per quit age.
    // Work-years leg (conditional — see D8): it prices the salary,
    // employer 401(k), and employer HSA earned by working past the
    // earliest retirement age, so it runs only when a salary was
    // provided. Without one, the comparison still answers from the
    // tax-aware Roth compare above, and says so in a warning —
    // the tool never rejects a call for a nice-to-have input.
    const workYears: Array<{
      quitAge: number;
      workYears: number;
      workTax: number;
      payrollTax: number;
      totalTax: number;
      shortfall: number;
      allInTax: number;
      claim67AllInTax: number | null;
      endingNominal: number;
      endingAfterTax: number;
      winnerStrategy: string;
      winnerClaimPrimaryAge: number | null;
      winnerClaimSpouseAge: number | null;
    }> = [];
    let workYearsWinnerByAllInTax: string | null = null;
    const workYearsWarnings: string[] = [];
    if (scenario.salaryAnnual != null) {
      const planInputs = buildRothPlanInputs(scenario, {
        retirementAge: firstAge,
        windowStartAge: firstAge,
      });
      const job: WorkYearJob = {
        salary: scenario.salaryAnnual,
        employer401k: scenario.employer401kAnnual,
        employerHsa: scenario.employerHsaAnnual,
        medicareAgePrimary: null,
      };
      const wyRows: WorkYearsCompareRow[] = runWorkYearsCompare(
        planInputs,
        job,
        ages,
      );
      workYears.push(
        ...wyRows.map((row) => ({
          quitAge: row.quitAge,
          workYears: row.workYears,
          workTax: r2(row.workTax),
          payrollTax: r2(row.payrollTax),
          totalTax: r2(row.totalTax),
          shortfall: r2(row.shortfall),
          allInTax: r2(row.allInTax),
          claim67AllInTax:
            row.claim67AllInTax == null ? null : r2(row.claim67AllInTax),
          endingNominal: r2(row.endingNominal),
          endingAfterTax: r2(row.endingAfterTax),
          winnerStrategy: row.optimizer.winner.spec.name,
          winnerClaimPrimaryAge: row.optimizer.winner.claimAges.primaryAge,
          winnerClaimSpouseAge: row.optimizer.winner.claimAges.spouseAge,
        })),
      );
      const wyWinner = pickWinner(
        workYears,
        (a, b) => a.allInTax < b.allInTax,
      );
      workYearsWinnerByAllInTax = wyWinner
        ? `retire-${wyWinner.quitAge}`
        : null;
    } else {
      workYearsWarnings.push(
        "Work-years detail (salary, employer 401(k)/HSA earned by working longer) is not included: no salary was provided. Pass salaryAnnual to include it.",
      );
    }
    const withAges = outcome.mapped.map((m, i) => ({
      ...m,
      retirementAge: ages[i]!,
    }));
    return respond(
      scenario,
      {
        baselineName: outcome.baseline.name,
        scenarios: withAges,
        winnerByEndingWealth: outcome.winnerByEndingWealth,
        winnerByNetCost: outcome.winnerByNetCost,
        deltas: deltasVsBaseline(outcome.mapped, outcome.baseline),
        yearly: yearlyTable(outcome.baselineRaw),
        workYears,
        workYearsWinnerByAllInTax,
      },
      [
        HEALTH_PREMIUM_WARNING,
        YEARLY_TABLE_WARNING,
        WORK_YEARS_HORIZON_WARNING,
        ...workYearsWarnings,
      ],
      taxAwareAssumptions(scenario),
    );
  });
}

// ---------------------------------------------------------------------------
// 7. Single-year tax price
// ---------------------------------------------------------------------------

export function calculateSingleYearTax(
  scenario: NormalizedScenario,
): AdapterResult<PlaygroundYearResult> {
  return guard(() => {
    if (!TAX_LAW_YEARS.some((law) => law.year === scenario.taxYear)) {
      return unsupported(
        `The single-year price covers tax years ${TAX_LAW_YEARS.map((law) => law.year).join(", ")}; ${scenario.taxYear} is not priced.`,
      );
    }
    const warnings: string[] = [];
    const agePrimary =
      scenario.currentAge + (scenario.taxYear - scenario.startYear);
    const joint = scenario.filingStatus === "mfj";
    const ageSpouse =
      joint && scenario.birthYearSpouse != null
        ? scenario.taxYear - scenario.birthYearSpouse
        : null;
    // Social Security pays only once its start age is reached in
    // the priced year; a null start age means no benefit.
    const ssPrimary =
      scenario.ssPrimaryStartAge != null &&
      agePrimary >= scenario.ssPrimaryStartAge
        ? scenario.ssPrimaryAnnual
        : 0;
    const ssSpouse =
      joint &&
      scenario.ssSpouseStartAge != null &&
      ageSpouse != null &&
      ageSpouse >= scenario.ssSpouseStartAge
        ? scenario.ssSpouseAnnual
        : 0;
    // Yields are a plan-level concept: the typed interest and
    // dividends below are the single-year income. Folding the
    // yields in as well would double-count them.
    if (
      scenario.taxableDividendYieldPct != null ||
      scenario.taxableInterestYieldPct != null
    ) {
      warnings.push(
        "Taxable yields are modeled in multi-year plans; this single-year price uses the typed interest/dividends only.",
      );
    }
    // No prior-year pre-tax balance rides the single-year inputs,
    // so no RMD is priced in this year.
    warnings.push(
      "No prior-year pre-tax balance is carried in the single-year inputs, so no RMD is priced in this year.",
    );
    // Taxable sales are not an input (stockSold is fixed at 0), so
    // the year's spending can only be funded by the typed draws and
    // income — cashLeftVsSpending does not count selling shares.
    warnings.push(
      "This price does not model selling taxable shares to fund the year's spending — cashLeftVsSpending counts only the typed draws and income.",
    );
    // One benchmark premium drives the ACA credit: single filer ->
    // single; household of 3+ -> family (falling back to couple);
    // otherwise couple.
    const benchmarkAnnual =
      scenario.filingStatus === "single"
        ? scenario.acaBenchmarkSingle
        : scenario.householdSize >= 3
          ? (scenario.acaBenchmarkFamily ?? scenario.acaBenchmarkCouple)
          : scenario.acaBenchmarkCouple;
    const inputs: PlaygroundYearInputs = {
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
      stockSold: 0,
      stockBasis: 0,
      qualifiedDividends: scenario.singleYear.qualifiedDividends,
      pretaxBalance: null,
      spouseSoleBeneficiary: joint,
      acaHouseholdSize: scenario.householdSize,
      acaBenchmarkAnnual: benchmarkAnnual,
      stateRatePct: scenario.stateRatePct,
      residenceState: scenario.residenceState,
      annualSpending: centsToDollars(scenario.annualSpendingCents),
    };
    const priced: PlaygroundYearResult = pricePlaygroundYear(inputs);
    const extraAssumptions: Assumption[] = joint
      ? [
          assumption(
            "spouseSoleBeneficiary",
            true,
            "assumption",
            "The spouse is modeled as the primary's sole beneficiary, so the primary's RMD prices on the Joint and Last Survivor Table.",
          ),
        ]
      : [];
    // Echo the engine's own result verbatim (dollars, 2dp). D6:
    // this result carries no settlement flags; none are invented.
    // D10: this tool prices under scenario.taxYear, so it reports
    // that year rather than the default first plan year.
    return respond(
      scenario,
      roundDeep(priced),
      warnings,
      extraAssumptions,
      scenario.taxYear,
    );
  });
}
