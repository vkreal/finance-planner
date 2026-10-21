/* ---------------- Roth planner seed (fresh / reset defaults) ----------------
   The ONE derivation of the Roth Conversion planner's seeded
   defaults — the record a fresh open starts from, and the record
   the resetRothPlanner action restores. Both consumers build
   from THIS module so the two can never diverge:

   - the client (RothConversion.tsx) passes the result to
     applyInputs on a fresh open (no saved record), resolving the
     Retirement-derived values from its getRetirementCalc query;
   - the server (actions.ts resetRothPlanner) resolves the same
     three values from the same sources — the saved Retirement
     record (retirementInputsFromRecord) and the trailing
     True-cost default spending (computeRetirementDefaults) —
     and persists the result as the plan record.

   The three derived values are resolved by the CALLER, from the
   current Retirement record state, exactly as the fresh-open
   path has always resolved them:
     retirementAge     = retSaved?.retirementAge ?? 57
     expectedReturnPct = retSaved?.expectedReturnPct
                         ?? blendedExpected(retSaved?.stocksPct ?? 95)
     annualSpendingCents = the Retirement defaults' trailing
                           True-cost annual spending
   Everything else is a coded constant below. Balances are null:
   null is what "follow the latest Net Worth snapshot" means in
   the saved record. */

import { DEFAULT_DRAW_ORDER_KEY } from "./taxEngine";
import { rmdAgeForBirthYear } from "./taxLaw";
import { BLANK_ROTH_GIFT, type RothGiftStored } from "./giftModel";
import type { RothExecutionCents } from "./rothOptimizer";

// Seed constants (used on a fresh open, before anything is
// saved, and restored by a reset). These are generic sample
// defaults chosen for this build — not any household's real
// figures. The primary's Social Security seeds at a round
// $48,000/yr at 67; the spouse's seeds blank rather than
// invented.
export const SEED_BIRTH_YEAR_PRIMARY = 1975;
export const SEED_BIRTH_YEAR_SPOUSE = 1985;
export const SEED_SS_PRIMARY_CENTS = 4_800_000; // $48,000/yr
export const SEED_SS_START_AGE = 67;
export const SEED_PROTECT_MIN_CENTS = 5_000_000; // $50,000
export const SEED_PRESERVE_PRETAX_CENTS = 25_000_000; // $250,000 pre-tax reserve — the factory default a fresh / reset plan starts with
export const SEED_HEIR_RATE = 24;
export const SEED_INFLATION = 2.5;
export const SEED_END_AGE = 95;
export const SEED_RETIREMENT_AGE_FALLBACK = 57;
// The market-uncertainty check's volatility seed: the panel
// default a fresh plan carries (and the first autosave of a
// fresh plan persists).
export const SEED_MC_VOLATILITY_PCT = 15;

// The seeded plan inputs, in the saved record's shape
// (rothInputFields in actions.ts): every field present, money
// in integer cents, null = blank / follow-the-snapshot exactly
// as a fresh plan's first autosave writes it.
export type RothSeedInputs = {
  birthYearPrimary: number;
  birthYearSpouse: number;
  filingStatus: "mfj";
  pretaxCents: null;
  pretaxSpouseCents: null;
  survivorEnabled: boolean;
  survivorWho: "primary";
  survivorDeathYear: null;
  rothCents: null;
  taxableCents: null;
  // Exclude-from-plan seeds blank (null = no exclusion), like
  // every optional pricing input the seed does not presume.
  taxableExcludeCents: null;
  hsaCents: null;
  taxableBasisPct: null;
  taxableTiers: null;
  // Taxable yields seed blank (null = no yield modeled), like
  // every optional pricing input the seed does not presume.
  taxableDividendYieldPct: null;
  taxableInterestYieldPct: null;
  // Spend-from-cash seeds blank (null = off), like the yields.
  spendFromCashPct: null;
  // Flexible spending seeds blank (null = off / floor 80),
  // like spend-from-cash.
  flexCutPct: null;
  flexFloorPct: null;
  annualSpendingCents: number;
  retirementAge: number;
  endAge: number;
  expectedReturnPct: number;
  ssPrimaryAnnualCents: number;
  ssPrimaryStartAge: number;
  ssPrimaryNoBenefit: boolean;
  ssSpouseAnnualCents: null;
  ssSpouseStartAge: null;
  ssSpouseNoBenefit: boolean;
  otherOrdinaryCents: null;
  taxExemptInterestCents: null;
  convertedAlreadyCents: null;
  windowStartAge: number;
  windowStopAge: number;
  payTaxFrom: "taxable";
  protectMinTaxableCents: number;
  preservePretaxCents: number;
  // The factory default seeds the reserve AMOUNT; the exit rate
  // seeds blank (the engine then scores the preserved amount at
  // the heir rate) — the default never backfills a saved record.
  preserveExitRatePct: null;
  claimAgeFloor: null;
  spouseSoleBeneficiary: boolean;
  acaHouseholdSize: number;
  acaHouseholdSizeAfter: number;
  acaStepDownYear: null;
  collegeFallFromYear: null;
  collegeFallThroughYear: null;
  acaBenchmarkCoupleCents: null;
  acaBenchmarkSingleCents: null;
  acaBenchmarkFamilyCents: null;
  acaSpouseEndAge: null;
  inflationPct: number;
  stateRatePct: number;
  // State of residence (T3 build): null in the seed = no
  // rules layer chosen, so the seed prices the flat rate
  // (0% here) exactly as before this build.
  residenceState: "WA" | "other" | null;
  // Capital-loss carryforward entering the plan (T4 build):
  // null in the seed = blank = no banked loss, like every
  // optional pricing input the seed does not presume.
  capitalLossCarryInStCents: null;
  capitalLossCarryInLtCents: null;
  // Itemized deductions (T5 build): null in the seed = blank
  // = no itemized components, like every optional pricing
  // input the seed does not presume.
  itemizedMortgageInterestCents: null;
  itemizedSaltPaidCents: null;
  itemizedCharitableCents: null;
  itemizedOtherCents: null;
  // Education expenses (T6 build): null in the seed = blank
  // = no students entered, like every optional pricing
  // input the seed does not presume — the seed never
  // invents a household's students.
  educationStudents: null;
  heirRatePct: number;
  ceilings: {
    bracketTopPct: number;
    irmaaTierCap: null;
    ltcgZeroCap: boolean;
    acaCliffCap: boolean;
    acaCliffCapFamilyOnly: boolean;
    magiCapCents: null;
    acaCliffBufferCents: null;
  };
  optimizerGuardrail: null;
  optimizerBunching: null;
  gainsHarvest: null;
  drawOrder: typeof DEFAULT_DRAW_ORDER_KEY;
  drawOrderSwitchAge: null;
  drawOrderAfter: typeof DEFAULT_DRAW_ORDER_KEY;
  yearlySalaryCents: null;
  employer401kCents: null;
  employerHsaCents: null;
};

export function seedRothInputs(derived: {
  annualSpendingCents: number;
  retirementAge: number;
  expectedReturnPct: number;
}): RothSeedInputs {
  return {
    birthYearPrimary: SEED_BIRTH_YEAR_PRIMARY,
    birthYearSpouse: SEED_BIRTH_YEAR_SPOUSE,
    filingStatus: "mfj",
    pretaxCents: null,
    pretaxSpouseCents: null,
    survivorEnabled: false,
    survivorWho: "primary",
    survivorDeathYear: null,
    rothCents: null,
    taxableCents: null,
    taxableExcludeCents: null,
    hsaCents: null,
    taxableBasisPct: null,
    taxableTiers: null,
    taxableDividendYieldPct: null,
    taxableInterestYieldPct: null,
    spendFromCashPct: null,
    flexCutPct: null,
    flexFloorPct: null,
    annualSpendingCents: derived.annualSpendingCents,
    retirementAge: derived.retirementAge,
    endAge: SEED_END_AGE,
    expectedReturnPct: derived.expectedReturnPct,
    ssPrimaryAnnualCents: SEED_SS_PRIMARY_CENTS,
    ssPrimaryStartAge: SEED_SS_START_AGE,
    ssPrimaryNoBenefit: false,
    ssSpouseAnnualCents: null,
    ssSpouseStartAge: null,
    ssSpouseNoBenefit: false,
    otherOrdinaryCents: null,
    taxExemptInterestCents: null,
    convertedAlreadyCents: null,
    windowStartAge: derived.retirementAge,
    windowStopAge: rmdAgeForBirthYear(SEED_BIRTH_YEAR_PRIMARY) - 1,
    payTaxFrom: "taxable",
    protectMinTaxableCents: SEED_PROTECT_MIN_CENTS,
    preservePretaxCents: SEED_PRESERVE_PRETAX_CENTS,
    preserveExitRatePct: null,
    claimAgeFloor: null,
    spouseSoleBeneficiary: true,
    acaHouseholdSize: 2,
    acaHouseholdSizeAfter: 2,
    acaStepDownYear: null,
    collegeFallFromYear: null,
    collegeFallThroughYear: null,
    acaBenchmarkCoupleCents: null,
    acaBenchmarkSingleCents: null,
    acaBenchmarkFamilyCents: null,
    acaSpouseEndAge: null,
    inflationPct: SEED_INFLATION,
    stateRatePct: 0,
    residenceState: null,
    capitalLossCarryInStCents: null,
    capitalLossCarryInLtCents: null,
    itemizedMortgageInterestCents: null,
    itemizedSaltPaidCents: null,
    itemizedCharitableCents: null,
    itemizedOtherCents: null,
    educationStudents: null,
    heirRatePct: SEED_HEIR_RATE,
    // The seed's Fill 12% ceilings shape.
    ceilings: {
      bracketTopPct: 12,
      irmaaTierCap: null,
      ltcgZeroCap: false,
      acaCliffCap: false,
      acaCliffCapFamilyOnly: false,
      magiCapCents: null,
      acaCliffBufferCents: null,
    },
    optimizerGuardrail: null,
    optimizerBunching: null,
    gainsHarvest: null,
    drawOrder: DEFAULT_DRAW_ORDER_KEY,
    drawOrderSwitchAge: null,
    drawOrderAfter: DEFAULT_DRAW_ORDER_KEY,
    yearlySalaryCents: null,
    employer401kCents: null,
    employerHsaCents: null,
  };
}

// The seeded This-year execution block: stamped with the
// current calendar year, every amount null (null balance = use
// the plan's resolved balance; null YTD amount = nothing
// entered) — the shape a fresh plan's first autosave writes.
export function seedRothExecution(currentYear: number): RothExecutionCents {
  return {
    executionYear: currentYear,
    executionPretaxCents: null,
    executionPretaxSpouseCents: null,
    executionRothCents: null,
    executionTaxableCents: null,
    executionHsaCents: null,
    executionOtherOrdinaryCents: null,
    executionTaxExemptInterestCents: null,
    executionAlreadyConvertedCents: null,
  };
}

// The full seeded plan record: plan inputs + execution block +
// MC-check volatility + gift block, ready to persist as the
// record's inputs (the scenarios array is NOT part of this — it
// is never the seed's business).
export function seedRothRecord(
  derived: {
    annualSpendingCents: number;
    retirementAge: number;
    expectedReturnPct: number;
  },
  currentYear: number,
): {
  inputs: RothSeedInputs;
  execution: RothExecutionCents;
  mcVolatilityPct: number;
  gift: RothGiftStored;
} {
  return {
    inputs: seedRothInputs(derived),
    execution: seedRothExecution(currentYear),
    mcVolatilityPct: SEED_MC_VOLATILITY_PCT,
    gift: { ...BLANK_ROTH_GIFT },
  };
}
