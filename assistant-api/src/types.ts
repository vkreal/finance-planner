// types.ts — shared envelope / assumption / error types for the
// stateless AI Retirement API adapter ("assistant-api").
//
// Frozen shape: field names must not change. The adapter (adapter.ts),
// the tools, and the server/CLI built by the parallel builders all
// depend on these exact names.
//
// The `questions` field on AdapterError.error is a contract addition
// ("Super easy" requirement): every missing_input error carries
// one plain-language question per missing field so the AI can ask the
// user directly.

/** Where a value in a response came from. */
export type Provenance = "user" | "assumption" | "engine_constant";

/** One resolved input, with where its value came from. */
export interface Assumption {
  field: string;
  value: unknown;
  provenance: Provenance;
  note: string;
}

/** Filing statuses the adapter accepts (subset of the engine's). */
export type FilingStatus = "mfj" | "single" | "hoh";

/** Retirement spending strategies (defined locally to avoid coupling
 *  to server/src/retirementEngines.ts). */
export type SpendingStrategy = "constant" | "guardrails" | "phased" | "percent";

/** Residence for state-tax purposes: Washington or anywhere else. */
export type ResidenceState = "WA" | "other";

/** One user-supplied input field a tool did not price (Review 8 S1).
 * `pricedBy` names the tools that do price the field (empty when the
 * field is inert for this scenario on every tool — e.g. a basis with
 * no sale); `reason` is a complete plain-language explanation,
 * including where the field is priced when it does apply. */
export interface IgnoredInputField {
  field: string;
  tool: string;
  pricedBy: string[];
  reason: string;
}

/** Successful adapter response envelope. */
export interface AdapterResponse<T> {
  ok: true;
  source: "finance-planner-engine";
  adapterVersion: string;
  apiContractVersion: number;
  taxLawYear: number;
  effectiveInputs: Record<string, unknown>;
  assumptions: Assumption[];
  results: T;
  warnings: string[];
  /** User-supplied fields this tool did not price (Review 8 S1).
   * Present on every success envelope (empty when nothing was
   * ignored). Each entry also appears as a warnings[] entry naming
   * the field, the tool, and the tool that does price it. */
  ignoredInputFields: IgnoredInputField[];
}

/** Error codes the adapter can return. */
export type AdapterErrorCode =
  | "missing_input"
  | "invalid_input"
  | "unsupported"
  | "engine_error";

/** Failed adapter response envelope.
 *
 * `questions` is present on every `missing_input` error: one entry per
 * field in `error.missing`, phrased so the AI can ask the user
 * directly. It is absent on other error codes.
 */
export interface AdapterError {
  ok: false;
  source: "finance-planner-engine";
  adapterVersion: string;
  apiContractVersion: number;
  error: {
    code: AdapterErrorCode;
    message: string;
    missing?: string[];
    details?: unknown;
    questions?: Array<{ field: string; question: string }>;
  };
}

/** Either a successful response or an error envelope. */
export type AdapterResult<T> = AdapterResponse<T> | AdapterError;

/** Adapter identifier stamped on every response. */
export const ADAPTER_VERSION = "assistant-api 0.1.0";

/**
 * API contract version this adapter reports. It tracked the repo's
 * API_CONTRACT_VERSION in server/src/actions.ts:3330 (verified in the
 * 2026-11-14 tree copy: `export const API_CONTRACT_VERSION = 163;`)
 * until Review 8: the adapter contract changed on its own in
 * 2026-11-14 (R8-S2: qualifiedDividendsAnnual > ordinaryDividendsAnnual
 * is now an invalid_input rejection instead of a silent engine
 * clamp), while the engine's pricing behaviour — what actions.ts
 * stamps — did not change, so actions.ts stays 163 and the adapter
 * reports 164. Copied as a literal on purpose — actions.ts must NOT
 * be imported here (it pulls in drizzle / @space/privileged/schema).
 * The additive ignoredInputFields metadata (R8-S1) is not a contract
 * change and did not move the version on its own. Engine Review C10
 * (2026-11-17) adds the retirement_dynamic_withdrawal tool — a new
 * MCP tool and a new entry in the capabilities guide — so the
 * adapter reports 165; actions.ts stays 163 (no engine pricing
 * behaviour changed).
 */
export const API_CONTRACT_VERSION_REPORTED = 165;

/**
 * Canonical field order (Engine Review C1: moved verbatim from
 * pricedInputs.ts so normalize.ts no longer imports it from
 * there — that import was the value half of the
 * pricedInputs <-> normalize import cycle; the other half was
 * already type-only. types.ts is the leaf every adapter module
 * may import, so the cycle is gone in both the static and the
 * runtime graph. pricedInputs re-exports this constant, so
 * existing import sites keep working unchanged.
 *
 * The declaration order in schema.ts
 * (RetirementQuestionInputs). suppliedFields is stored in this
 * order so reports are stable regardless of caller key order.
 * The drift test asserts this equals the zod shape's key order.
 */
export const FIELD_ORDER: string[] = [
  "pretax",
  "taxable",
  "roth",
  // Engine Review C9 Build 2: the primary owner's Roth
  // composition (zod declaration order — after roth, before
  // hsa, as in schema.ts).
  "rothIra",
  "rothEmployer",
  "rothContributionBasis",
  "rothConversionLots",
  "firstRothYear",
  "firstDesignatedRothYear",
  "hsa",
  "monthlySpending",
  "currentAge",
  "spouseAge",
  "retirementAge",
  "endAge",
  "filingStatus",
  "householdSize",
  "taxableBasisPct",
  "taxableDividendYieldPct",
  "taxableInterestYieldPct",
  "expectedRealReturnPct",
  "volatilityPct",
  "stocksPct",
  "strategy",
  "minimumAnnualSpending",
  "socialSecurityAnnual",
  "spouseSocialSecurityAnnual",
  "socialSecurityStartAge",
  "spouseSocialSecurityStartAge",
  "state",
  "stateRatePct",
  "acaBenchmarkCouple",
  "acaBenchmarkSingle",
  "acaBenchmarkFamily",
  "priorYearMagi",
  "healthPremiumAcaHouseholdAnnual",
  "healthPremiumAcaSingleAnnual",
  "healthPremiumMedicarePerPersonAnnual",
  "spendingIncludesHealthPremiums",
  "otherOrdinaryAnnual",
  "taxExemptInterestAnnual",
  "salaryAnnual",
  "employer401kAnnual",
  "employerHsaAnnual",
  "hsaCoverage",
  "hsaEligible",
  "medicareAgePrimary",
  "priorYearWagesAnnual",
  "taxYear",
  "interestAnnual",
  "ordinaryDividendsAnnual",
  "qualifiedDividendsAnnual",
  "conversionAnnual",
  "spendingDrawAnnual",
  "cashDrawAnnual",
  "rothDrawAnnual",
  "stockSoldAnnual",
  "stockBasisAnnual",
  "pretaxPriorYearEndAnnual",
  "pretaxSpousePriorYearEndAnnual",
  "rmdAlreadyReceivedAnnual",
  "primarySoleBeneficiaryOfSpouse",
  "firstRmdDeferralPrimary",
  "firstRmdDeferralSpouse",
  "firstRmdDeferredCarryPrimaryAnnual",
  "firstRmdDeferredCarrySpouseAnnual",
  "survivorEnabled",
  "survivorWho",
  "survivorDeathYear",
  "survivorClaimAge",
  "mcSeed",
  "mcRuns",
  "compareAges",
  "comparisonScope",
];
