// pricedInputs.ts — ONE authoritative mapping of priced inputs per tool.
//
// Review 8 SHOULD-1: before this module, which inputs each tool prices
// lived in three places that could drift — the prose in the tool
// descriptions (tools.ts), the capability guide's optional lists
// (tools.ts), and the adapter's actual engine wiring (adapter.ts /
// normalize.ts). A caller could send a field the shared schema
// accepts, see it echoed in effectiveInputs, and reasonably believe
// it changed the answer — when the tool's engine never reads it
// (conversionAnnual to retirement_calculate, taxYear to a multi-year
// compare, volatilityPct to a deterministic compare, mcRuns to
// max-spending, stockSoldAnnual to a sim tool).
//
// This module is the single source the others read from:
//   - tools.ts builds the capability guide's per-tool optional lists
//     from PRICED_OPTIONAL (and the tool descriptions' "does not
//     change this answer" prose must agree with it — see the drift
//     test in tests/review8-drift.test.ts).
//   - adapter.ts (via respond()) computes ignoredInputFields from
//     it: every user-supplied field this tool does not price is
//     reported in the envelope, with the tools that do price it.
//   - normalize.ts records suppliedFields (the caller-supplied keys,
//     in FIELD_ORDER) on the scenario so the computation above
//     can tell "caller supplied it" from "omitted".
//
// Categories, per tool:
//   - required: the six essentials (contract inputs — never reported
//     as ignored, even for a tool whose engine does not read them,
//     e.g. the four balances for retirement_tax_year, whose RMDs
//     price only from the prior-Dec-31 balances). What they are is
//     disclosed in the tax-year tool description instead.
//   - optional priced: the fields in PRICED_OPTIONAL[tool] —
//     exactly the sets the guide previously hardcoded, verified
//     against what the engines read (see the notes per list).
//   - recognized but ignored: any other supplied optional field —
//     reported, never silently accepted (and never re-routed: the
//     adapter never prices a different engine to "use" the field).
//   - unknown: rejected by the strict zod schema before any engine
//     runs (invalid_input naming the key).
//
// Conditional ignores: a field a tool normally prices can still
// have no effect for a given scenario — spouse fields on a
// single/hoh return (no spouse modeled), a WA state rate (WA
// prices via the excise path), a claiming age with no benefit
// entered, a basis with no sale, a spouse RMD input with no
// joint return or no spouse RMD priced. ignoredInputsForTool
// applies those rules from the normalized scenario, so the
// report is per-call, not just per-tool.
//
// Review 7 note: medicareAgePrimary was reserved here through
// Review 5 (engine field, adapter passed null, schema rejected
// it). Engine Review 7 exposes it in the schema alongside the
// new hsaCoverage / hsaEligible / priorYearWagesAnnual inputs,
// so the reservation is retired: the field now lives in
// FIELD_ORDER, the schema, and PRICED_OPTIONAL (priced only by
// retirement_work_years).

import type { NormalizedScenario } from "./normalize";
import type { IgnoredInputField } from "./types";

/** The eight financial tools (the capabilities tool takes no inputs). */
export type FinancialToolName =
  | "retirement_calculate"
  | "retirement_monte_carlo"
  | "retirement_max_spending"
  | "retirement_compare_strategies"
  | "retirement_roth_conversion"
  | "retirement_work_years"
  | "retirement_tax_year"
  | "retirement_dynamic_withdrawal";

/** The six essential keys, required by the shared input contract. */
export const REQUIRED_INPUTS_GLOBAL: string[] = [
  "pretax",
  "taxable",
  "roth",
  "hsa",
  "monthlySpending",
  "currentAge",
];

// FIELD_ORDER lives in ./types (Engine Review C1, cycle break):
// re-exported here so existing import sites keep working.
export { FIELD_ORDER } from "./types";

/**
 * Optional inputs each tool's engine actually prices. These are the
 * sets the guide previously hardcoded (kept identical — the drift
 * test pins them); they are verified against the engine wiring:
 *   - Sim tools (calculate / monte_carlo / max_spending): the sim
 *     engines read no tax inputs (SimInputs carries no filing
 *     status, basis, yield, ACA, or state field). calculate has
 *     no Monte Carlo leg, so it prices no volatilityPct, mcRuns,
 *     or mcSeed; monte_carlo prices all three (its MC leg reads
 *     expected/vol/seed/runs); max_spending prices volatilityPct
 *     and mcSeed (its solver reads them) but NOT mcRuns — the
 *     solver always runs the engine's fixed 1,000 simulations —
 *     and NOT minimumAnnualSpending: the solver scores funding
 *     success only and reports no adequacy rate (Engine Review 1,
 *     E1-S1), so the floor is inert there even though it is a
 *     sim input everywhere else.
 *   - Compare tools (strategies / roth / work_years): the
 *     tax-aware Roth compare reads no strategy or volatility
 *     (RothSavedLike carries neither) and no single-year or
 *     Monte Carlo input; work_years additionally prices the
 *     salary / employer / compareAges inputs for its earned-
 *     income leg.
 *   - Tax year: the single-year pricer reads neither portfolio
 *     assumptions nor retirementAge/endAge (PlaygroundYearInputs
 *     carries none of those) nor the multi-year yields and basis
 *     (the typed single-year amounts are the year's income —
 *     folding the yields in as well would double-count them).
 */
const SIM_OPTIONAL_INPUTS: string[] = [
  "retirementAge",
  "endAge",
  "spouseAge",
  "stocksPct",
  "expectedRealReturnPct",
  "volatilityPct",
  "strategy",
  "minimumAnnualSpending",
  "socialSecurityAnnual",
  "socialSecurityStartAge",
  "spouseSocialSecurityAnnual",
  "spouseSocialSecurityStartAge",
];

const COMPARE_OPTIONAL_INPUTS: string[] = [
  "retirementAge",
  "endAge",
  "spouseAge",
  "filingStatus",
  "householdSize",
  "stocksPct",
  "expectedRealReturnPct",
  "socialSecurityAnnual",
  "socialSecurityStartAge",
  "spouseSocialSecurityAnnual",
  "spouseSocialSecurityStartAge",
  "taxableBasisPct",
  "taxableDividendYieldPct",
  "taxableInterestYieldPct",
  "otherOrdinaryAnnual",
  "taxExemptInterestAnnual",
  "acaBenchmarkCouple",
  "acaBenchmarkSingle",
  "acaBenchmarkFamily",
  "priorYearMagi",
  "healthPremiumAcaHouseholdAnnual",
  "healthPremiumAcaSingleAnnual",
  "healthPremiumMedicarePerPersonAnnual",
  "spendingIncludesHealthPremiums",
  "stateRatePct",
  "state",
  "comparisonScope",
  // Engine Review 5: the first-RMD deferral election and the
  // survivor scenario price in the march (and, for the
  // deferral, in the work-years roll that feeds it). The
  // carry-in is NOT a plan-tool input — the roll produces it.
  "firstRmdDeferralPrimary",
  "firstRmdDeferralSpouse",
  "survivorEnabled",
  "survivorWho",
  "survivorDeathYear",
  "survivorClaimAge",
  // Engine Review C9, Build 2 (W3): the Roth split +
  // primary-owner composition price in the march (and, for
  // the split, in the work-years roll that feeds it). The
  // spouse's composition is NOT a plan-tool input — the
  // adapter models a single Roth pool.
  "rothIra",
  "rothEmployer",
  "rothContributionBasis",
  "rothConversionLots",
  "firstRothYear",
  "firstDesignatedRothYear",
];

const TAX_YEAR_OPTIONAL_INPUTS: string[] = [
  "spouseAge",
  "filingStatus",
  "householdSize",
  "socialSecurityAnnual",
  "socialSecurityStartAge",
  "spouseSocialSecurityAnnual",
  "spouseSocialSecurityStartAge",
  "otherOrdinaryAnnual",
  "taxExemptInterestAnnual",
  "acaBenchmarkCouple",
  "acaBenchmarkSingle",
  "acaBenchmarkFamily",
  "healthPremiumAcaHouseholdAnnual",
  "healthPremiumAcaSingleAnnual",
  "healthPremiumMedicarePerPersonAnnual",
  "spendingIncludesHealthPremiums",
  "stateRatePct",
  "state",
  "taxYear",
  "interestAnnual",
  "ordinaryDividendsAnnual",
  "qualifiedDividendsAnnual",
  "conversionAnnual",
  "spendingDrawAnnual",
  "cashDrawAnnual",
  "rothDrawAnnual",
  // Engine Review C9, Build 2 (W3): the Roth split +
  // primary-owner composition price in the single-year
  // pricer, on the rothDraw dial. The spouse's composition
  // is NOT a tax-year input — the adapter models a single
  // Roth pool.
  "rothIra",
  "rothEmployer",
  "rothContributionBasis",
  "rothConversionLots",
  "firstRothYear",
  "firstDesignatedRothYear",
  "stockSoldAnnual",
  "stockBasisAnnual",
  "pretaxPriorYearEndAnnual",
  "pretaxSpousePriorYearEndAnnual",
  "rmdAlreadyReceivedAnnual",
  "primarySoleBeneficiaryOfSpouse",
  // Engine Review 5: the deferral election + carry price in the
  // single-year pricer. The survivor scenario does not exist
  // there (no survivor inputs on the single-year pricer), so the
  // survivor fields are NOT priced by this tool.
  "firstRmdDeferralPrimary",
  "firstRmdDeferralSpouse",
  "firstRmdDeferredCarryPrimaryAnnual",
  "firstRmdDeferredCarrySpouseAnnual",
];

export const PRICED_OPTIONAL: Record<FinancialToolName, string[]> = {
  // calculate has no Monte Carlo leg — simulateDetailed +
  // runHistorical + runNeverRunsOut never read volatility.
  retirement_calculate: SIM_OPTIONAL_INPUTS.filter(
    (f) => f !== "volatilityPct",
  ),
  retirement_monte_carlo: [...SIM_OPTIONAL_INPUTS, "mcRuns", "mcSeed"],
  // max_spending prices volatilityPct and mcSeed but NOT
  // minimumAnnualSpending (solver scores funding only, E1-S1).
  retirement_max_spending: [
    ...SIM_OPTIONAL_INPUTS.filter((f) => f !== "minimumAnnualSpending"),
    "mcSeed",
  ],
  retirement_compare_strategies: COMPARE_OPTIONAL_INPUTS,
  retirement_roth_conversion: COMPARE_OPTIONAL_INPUTS,
  // Engine Review C10: the dynamic tool prices the same
  // optionals as the compare tools EXCEPT comparisonScope —
  // it has no limited/full modes (it always runs its own
  // 114-policy roll-forward), so a supplied comparisonScope
  // is reported ignored for this tool instead of silently
  // meaning nothing.
  retirement_dynamic_withdrawal: COMPARE_OPTIONAL_INPUTS.filter(
    (f) => f !== "comparisonScope",
  ),
  retirement_work_years: [
    ...COMPARE_OPTIONAL_INPUTS,
    "salaryAnnual",
    "employer401kAnnual",
    "employerHsaAnnual",
    // Engine Review 7: the explicit HSA inputs, the Medicare
    // enrollment age (engine field since Review 5, exposed in
    // the schema by Review 7), and the prior-year wage input
    // for the first modeled work year.
    "hsaCoverage",
    "hsaEligible",
    "medicareAgePrimary",
    "priorYearWagesAnnual",
    "compareAges",
  ],
  retirement_tax_year: TAX_YEAR_OPTIONAL_INPUTS,
};

/** Tools that price a field (from PRICED_OPTIONAL, in tool order). */
export function pricedBy(field: string): FinancialToolName[] {
  const tools = Object.keys(PRICED_OPTIONAL) as FinancialToolName[];
  return tools.filter((t) => PRICED_OPTIONAL[t]!.includes(field));
}

/**
 * Plain-language purpose of each optional field, used in the
 * ignored-input warning so the caller can see what the field does
 * and where it belongs. Required fields need no entry — they are
 * never reported ignored.
 */
const FIELD_BLURBS: Record<string, string> = {
  spouseAge: "the spouse's current age",
  retirementAge: "the age work income stops",
  endAge: "the last age the projection runs through",
  filingStatus: "the federal tax filing status",
  householdSize: "the household size (drives ACA benchmarks)",
  taxableBasisPct: "the taxable account's cost-basis share",
  taxableDividendYieldPct: "the taxable account's dividend yield",
  taxableInterestYieldPct: "the taxable account's interest yield",
  expectedRealReturnPct: "the expected real portfolio return",
  volatilityPct: "the annual portfolio volatility",
  stocksPct: "the portfolio's stock allocation",
  strategy: "the spending strategy",
  minimumAnnualSpending: "the minimum annual spending floor for the spending-adequacy rate",
  socialSecurityAnnual: "the primary's annual Social Security benefit",
  spouseSocialSecurityAnnual: "the spouse's annual Social Security benefit",
  socialSecurityStartAge: "the primary's Social Security claiming age",
  spouseSocialSecurityStartAge: "the spouse's Social Security claiming age",
  state: "the state of residence",
  stateRatePct: "the flat state income-tax rate",
  acaBenchmarkCouple: "the ACA benchmark premium for a couple",
  acaBenchmarkSingle: "the ACA benchmark premium for a single filer",
  acaBenchmarkFamily: "the ACA benchmark premium for a family household",
  priorYearMagi: "prior-year filed returns (MAGI + filing status) for the two-year IRMAA lookback",
  healthPremiumAcaHouseholdAnnual: "the marketplace health premium for a two-person household year",
  healthPremiumAcaSingleAnnual: "the marketplace health premium for a one-person year",
  healthPremiumMedicarePerPersonAnnual: "the Medicare base premium per person",
  spendingIncludesHealthPremiums: "whether monthly spending already includes health insurance premiums",
  otherOrdinaryAnnual: "other ordinary income per year",
  taxExemptInterestAnnual: "tax-exempt interest per year",
  salaryAnnual: "the annual salary while working",
  employer401kAnnual: "the annual employer 401(k) contribution",
  employerHsaAnnual: "the annual employer HSA contribution",
  hsaCoverage: "the HDHP coverage type the HSA limit prices from",
  hsaEligible: "whether the primary is an HSA-eligible individual",
  medicareAgePrimary:
    "the primary's Medicare enrollment age (HSA contributions stop in work years at or after that age; omitted or null means no enrollment is modeled)",
  priorYearWagesAnnual:
    "the prior calendar year's Social Security wages from the plan sponsor",
  taxYear: "the tax law year to price under",
  interestAnnual: "taxable interest for one tax year",
  ordinaryDividendsAnnual: "total ordinary dividends for one tax year",
  qualifiedDividendsAnnual: "the qualified portion of one year's ordinary dividends",
  conversionAnnual: "a Roth conversion amount for one tax year",
  spendingDrawAnnual: "the draw for spending for one tax year",
  cashDrawAnnual: "the draw from cash for one tax year",
  rothDrawAnnual: "the draw from Roth for one tax year",
  rothIra: "the Roth IRA share of the Roth balance",
  rothEmployer: "the designated Roth employer-plan share of the Roth balance",
  rothContributionBasis:
    "the primary owner's regular-contribution basis still sitting in Roth (free to withdraw at any age)",
  rothConversionLots:
    "the primary owner's prior conversions still sitting in the Roth IRA, one lot per conversion year (taxable part keys the 5-year §72(t) penalty)",
  firstRothYear:
    "the primary owner's first taxable year of any Roth IRA contribution (the qualified-distribution 5-year clock)",
  firstDesignatedRothYear:
    "the primary owner's first taxable year of designated Roth contributions to the employer plan (that plan's own 5-year clock)",
  stockSoldAnnual: "taxable shares sold in one tax year",
  stockBasisAnnual: "the cost basis of the shares sold",
  pretaxPriorYearEndAnnual: "the primary's pre-tax balance at Dec 31 of the year before the priced year",
  pretaxSpousePriorYearEndAnnual: "the spouse's pre-tax balance at Dec 31 of the year before the priced year",
  rmdAlreadyReceivedAnnual: "the part of this year's RMD already received and already counted in the entered income",
  primarySoleBeneficiaryOfSpouse: "whether the primary is the spouse's sole beneficiary (gates the spouse's RMD table)",
  firstRmdDeferralPrimary: "whether to defer the primary's first RMD to April 1 of the following year",
  firstRmdDeferralSpouse: "whether to defer the spouse's first RMD to April 1 of the following year",
  firstRmdDeferredCarryPrimaryAnnual: "the primary's first RMD deferred from a prior year (priced on top of the priced year's own RMD)",
  firstRmdDeferredCarrySpouseAnnual: "the spouse's first RMD deferred from a prior year (priced on top of the priced year's own RMD)",
  survivorEnabled: "whether the survivor scenario is on (one spouse dies in a given year)",
  survivorWho: "who dies in the survivor scenario",
  survivorDeathYear: "the calendar year of death in the survivor scenario",
  survivorClaimAge: "the survivor's Social Security claiming age for the enhanced survivor benefit (absent = the simplified max-of-two-benefits rule)",
  mcSeed: "the Monte Carlo random seed",
  mcRuns: "the number of Monte Carlo simulations",
  compareAges: "the retirement ages to compare",
  comparisonScope: "the comparison scope (limited or full candidate set)",
};

/**
 * Fields the engine already supports but the input schema does not
 * yet expose. A caller sending one today is rejected as an unknown
 * field by the strict schema — the correct behavior until the
 * schema exposes it. When the review lands, the field moves into
 * FIELD_ORDER / the schema / PRICED_OPTIONAL (priced only by the
 * tools listed here) and out of this table; the drift test fails if
 * it is in the schema while still listed here, or priced by a tool
 * without being in the schema.
 *
 * Empty today: medicareAgePrimary (the last reservation) was
 * exposed by Engine Review 7 alongside hsaCoverage, hsaEligible,
 * and priorYearWagesAnnual.
 */
export const FUTURE_FIELDS: Record<
  string,
  { pricedBy: FinancialToolName[]; note: string }
> = {};

/**
 * Conditional ignore: a field this tool normally prices that has no
 * effect for this scenario. Returns the full reason (a complete
 * sentence, including where the field is priced when it does
 * apply) or null when the field is priced for this scenario.
 * Only called for fields already in the tool's priced set.
 */
function conditionalReason(
  tool: FinancialToolName,
  field: string,
  s: NormalizedScenario,
): string | null {
  const mfj = s.filingStatus === "mfj";
  // No spouse is modeled on a single/hoh return: the spouse's
  // age and benefits price nothing on any tool for this scenario.
  if (
    !mfj &&
    (field === "spouseAge" ||
      field === "spouseSocialSecurityAnnual" ||
      field === "spouseSocialSecurityStartAge")
  ) {
    return `no spouse is modeled for ${s.filingStatus} filing status, so it prices nothing for this scenario; it is priced by the tax-aware tools on a joint (mfj) return`;
  }
  // A state rate prices only for a non-WA state that was given:
  // WA prices via the excise path, and with no state given no
  // state tax is modeled at all.
  if (field === "stateRatePct") {
    if (s.residenceState === "WA") {
      return "WA is priced via the WA excise path, not an income-tax rate; the rate is priced by the tax-aware tools for a non-WA state";
    }
    if (s.stateLabel == null) {
      return "no state was given, so no state tax is modeled; the rate is priced by the tax-aware tools once a non-WA state is given";
    }
  }
  // A claiming age with no benefit entered prices nothing: there
  // is no stream for it to start.
  if (field === "socialSecurityStartAge" && s.ssPrimaryAnnual === 0) {
    return "no primary Social Security benefit was entered, so no claiming age applies; it is priced by every tool once a benefit is entered";
  }
  if (field === "spouseSocialSecurityStartAge" && s.ssSpouseAnnual === 0) {
    return "no spouse Social Security benefit was entered, so no claiming age applies; it is priced by every tool once a benefit is entered";
  }
  // A Medicare enrollment age prices only through the work-years
  // leg, which runs only when a salary was provided: without one
  // no work year is rolled and the enrollment stop has nothing to
  // stop.
  if (
    tool === "retirement_work_years" &&
    field === "medicareAgePrimary" &&
    s.salaryAnnual == null
  ) {
    return "no salary was provided, so the work-years leg does not run and the enrollment age prices nothing for this scenario; retirement_work_years prices it once salaryAnnual is entered";
  }
  if (tool === "retirement_tax_year") {
    // A basis prices only against a sale.
    if (
      field === "stockBasisAnnual" &&
      (s.singleYear.stockSold == null || s.singleYear.stockSold === 0)
    ) {
      return "a cost basis prices only against a sale, and no sale was entered for this year — retirement_tax_year prices it only when stockSoldAnnual is entered";
    }
    // A spouse RMD prices only on a joint return.
    if (field === "pretaxSpousePriorYearEndAnnual" && !mfj) {
      return "a spouse RMD is priced only on a joint (mfj) return — retirement_tax_year prices it only for mfj";
    }
    // An already-received RMD nets only against a computed RMD.
    if (
      field === "rmdAlreadyReceivedAnnual" &&
      s.singleYear.pretaxPriorYearEnd == null &&
      s.singleYear.pretaxSpousePriorYearEnd == null
    ) {
      return "no prior-Dec-31 balance was entered, so there is no computed RMD to net it against — retirement_tax_year prices it only once a prior-Dec-31 balance is entered";
    }
    // The sole-beneficiary flag gates only the spouse's RMD table.
    if (
      field === "primarySoleBeneficiaryOfSpouse" &&
      (!mfj || s.singleYear.pretaxSpousePriorYearEnd == null)
    ) {
      return "it gates only the spouse's RMD table, and no spouse RMD is priced for this year — retirement_tax_year prices it only when a spouse prior-Dec-31 balance is entered on a joint return";
    }
  }
  return null;
}

/**
 * The user-supplied fields this tool does not price, in FIELD_ORDER.
 * Omitted fields never appear (they are not in suppliedFields);
 * required fields never appear (they are contract inputs, and
 * whether a given tool's engine reads them is disclosed in prose
 * instead — e.g. the tax-year description for the four balances).
 * Each entry names the field, this tool, the tools that do price
 * it, and the reason.
 */
export function ignoredInputsForTool(
  tool: FinancialToolName,
  scenario: NormalizedScenario,
): IgnoredInputField[] {
  const priced = new Set(PRICED_OPTIONAL[tool]);
  const out: IgnoredInputField[] = [];
  for (const field of scenario.suppliedFields) {
    if (REQUIRED_INPUTS_GLOBAL.includes(field)) continue;
    const conditional = priced.has(field)
      ? conditionalReason(tool, field, scenario)
      : null;
    if (priced.has(field) && conditional === null) continue;
    const others = pricedBy(field).filter((t) => t !== tool);
    const reason =
      conditional ??
      (others.length > 0
        ? `${FIELD_BLURBS[field] ?? field}, priced by ${others.join(", ")} — use ${others[0]} for it`
        : `${FIELD_BLURBS[field] ?? field}; no tool prices this input`);
    out.push({ field, tool, pricedBy: others, reason });
  }
  return out;
}

/** The warnings[] entry for one ignored field. */
export function ignoredInputWarning(entry: IgnoredInputField): string {
  return `Ignored input "${entry.field}" has no effect on ${entry.tool}: ${entry.reason}.`;
}
