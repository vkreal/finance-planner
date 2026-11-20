// tools.ts — MCP tool definitions + dispatch for the Finance Planner
// assistant API.
//
// This module consumes the FROZEN interfaces from the sibling builders and
// does not import any engine code directly:
//   ./types     — AdapterResponse / AdapterError / AdapterResult, versions
//   ./normalize — normalizeInputs(raw) -> NormalizedScenario | AdapterError
//   ./adapter   — one function per calculation; each returns its envelope
//   ./schema    — RetirementQuestionInputs (zod schema + inferred type)
// The JSON Schema in BASE_INPUT_SCHEMA is hand-written (no zod-to-json-schema
// dependency is available) to match the zod schema field-for-field: same
// field names, types, enums, ranges and required list. If the schema builder
// renames a field or tightens a range, this file's inputSchema is the place
// that must be reconciled — the tool handler itself just forwards raw args
// to normalizeInputs, so validation always follows the zod schema.
//
// Units: all money is DOLLARS; ages are integers; percents are numbers
// (5 = 5%). Example values in comments use the fictional sample household
// (pretax $1,250,000; taxable $2,100,000; Roth $375,000; HSA $62,000;
// spending $9,500/mo; basis 72%; SS $36,000 at 67; ages 54/52; retire 58-60).
//
// Logging rule: dispatch logs only the tool name, ok flag and duration.
// Input values and results are NEVER logged.

import {
  calculateMaxSpending,
  calculateRetirement,
  calculateSingleYearTax,
  compareRetirementAges,
  compareRothConversions,
  compareWithdrawalStrategies,
  dynamicWithdrawal,
  runRetirementMonteCarlo,
} from "./adapter";
import { latestTaxLawYear, normalizeInputs } from "./normalize";
import { TAX_LAW_YEARS } from "../../server/src/taxLaw";
import type { RetirementQuestionInput } from "./schema";
import {
  ADAPTER_VERSION,
  API_CONTRACT_VERSION_REPORTED,
  type AdapterResponse,
  type AdapterResult,
  type Assumption,
} from "./types";
import { PRICED_OPTIONAL } from "./pricedInputs";

// Keep the inferred input type referenced so the tool surface stays tied to
// the zod schema even though validation happens inside normalizeInputs.
export type ToolInputs = RetirementQuestionInput;

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  // Async: the heavy tools price in the worker pool (Engine
  // Review C7 architecture, §1.2), so every handler returns a
  // promise; light handlers still compute synchronously and
  // their value is awaited the same way.
  handler: (args: unknown) => AdapterResult<unknown> | Promise<AdapterResult<unknown>>;
}

// ---------------------------------------------------------------------------
// Input schema (hand-written JSON Schema; see the header note).
// Required: ["pretax", "taxable", "roth", "hsa", "monthlySpending",
// "currentAge"]. Everything else is optional and defaults inside normalize.
// ---------------------------------------------------------------------------

const MONEY = { type: "number", minimum: 0, maximum: 100_000_000 };
const PCT = { type: "number", minimum: 0, maximum: 100 };
const AGE = { type: "integer", minimum: 18, maximum: 120 };

/** Published law years, derived from the engine table (never hardcoded):
 *  prose form ("2025 or 2026" today) for tool descriptions, and the
 *  range for the advertised JSON Schema. Both extend automatically
 *  when a new year's tables publish. */
const LAW_YEARS_PROSE = TAX_LAW_YEARS.map((law) => law.year).join(" or ");
const FIRST_LAW_YEAR = Math.min(
  ...TAX_LAW_YEARS.map((law) => law.year),
);

export const BASE_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    pretax: {
      ...MONEY,
      description:
        "Pre-tax balance (traditional IRA / 401(k)) in dollars. Required.",
    },
    taxable: {
      ...MONEY,
      description: "Taxable brokerage balance in dollars. Required.",
    },
    roth: {
      ...MONEY,
      description:
        "Roth IRA / Roth 401(k) balance in dollars. Required. Optional Roth composition fields describe it for the primary owner — rothIra / rothEmployer (the IRA vs designated-Roth split), rothContributionBasis (regular-contribution basis still in Roth), rothConversionLots (prior conversions, one lot per year), firstRothYear and firstDesignatedRothYear (the 5-year clocks). Without them a Roth draw prices $0 income and $0 penalty and is flagged unknown (rothBasisUnknown).",
    },
    rothIra: {
      ...MONEY,
      description:
        "Roth IRA share of the Roth balance, in dollars. Primary owner only. Absent means the whole balance is a Roth IRA (less any entered rothEmployer share).",
    },
    rothEmployer: {
      ...MONEY,
      description:
        "Designated Roth employer-plan share of the Roth balance, in dollars. Primary owner only. Absent means $0.",
    },
    rothContributionBasis: {
      ...MONEY,
      description:
        "Regular-contribution basis still sitting in the primary owner's Roth accounts, in dollars. Contributions come out free, so an entered basis prices the first dollars of any Roth draw as $0 income and $0 penalty. Absent means not established — a Roth draw prices $0 income and $0 penalty and is flagged unknown (rothBasisUnknown). An entered 0 is a real answer (no contribution basis).",
    },
    rothConversionLots: {
      type: "array",
      maxItems: 64,
      items: {
        type: "object",
        properties: {
          year: {
            type: "integer",
            minimum: 1900,
            maximum: 2200,
            description: "Taxable year of the conversion.",
          },
          taxableAmount: {
            ...MONEY,
            description:
              "Dollars included in income on conversion (what the §72(t) 5-year penalty keys on), in dollars.",
          },
          nontaxableAmount: {
            ...MONEY,
            description:
              "Dollars of basis converted (penalty-free on withdrawal), in dollars.",
          },
        },
        required: ["year", "taxableAmount", "nontaxableAmount"],
        additionalProperties: false,
      },
      description:
        "Prior conversions still sitting in the primary owner's Roth IRA — one lot per conversion year, FIFO. A conversion lot withdrawn before 59½ and inside 5 taxable years pays the 10% §72(t) penalty on the taxable part withdrawn. An entered empty list is a real answer (no prior conversions). Absent means not established — a Roth draw prices $0 income and $0 penalty and is flagged unknown (rothBasisUnknown).",
    },
    firstRothYear: {
      type: "integer",
      minimum: 1900,
      maximum: 2200,
      description:
        "First taxable year of any Roth IRA contribution (the qualified-distribution 5-year clock), primary owner. Earnings are free only when the owner is 59½ or older AND the priced year is at least 5 years after this year. Absent means not established.",
    },
    firstDesignatedRothYear: {
      type: "integer",
      minimum: 1900,
      maximum: 2200,
      description:
        "First taxable year of designated Roth contributions to the employer plan (that plan's own 5-year clock), primary owner. Absent means not established.",
    },
    hsa: {
      ...MONEY,
      description: "Health savings account balance in dollars. Required.",
    },
    monthlySpending: {
      type: "number",
      exclusiveMinimum: 0,
      maximum: 200_000,
      description:
        "Planned spending per month in dollars (e.g. 9500 = $9,500/mo). Required.",
    },
    currentAge: {
      ...AGE,
      description: "Current age of the primary person, in whole years. Required.",
    },
    retirementAge: {
      ...AGE,
      description: "Age at which work income stops. Defaults to your current age (retire now).",
    },
    endAge: {
      ...AGE,
      description:
        "Last age the projection runs through. Defaults to 95; must be after retirementAge and no more than 120.",
    },
    spouseAge: {
      ...AGE,
      description: "Current age of the spouse, in whole years, if any.",
    },
    filingStatus: {
      type: "string",
      enum: ["mfj", "single", "hoh"],
      description:
        "Federal tax filing status: mfj (married filing jointly), single, or hoh (head of household). Married filing separately (\"mfs\") is NOT supported — the engine prices mfj, single, and head of household only, and an \"mfs\" value is rejected rather than priced as one of these.",
    },
    householdSize: {
      type: "integer",
      minimum: 1,
      maximum: 20,
      description: "Number of people in the household (drives ACA benchmarks).",
    },
    stocksPct: {
      ...PCT,
      description: "Portfolio allocation to stocks, as a percent (e.g. 60 = 60%).",
    },
    expectedRealReturnPct: {
      type: "number",
      minimum: -50,
      maximum: 50,
      description:
        "Expected real portfolio return, as a percent per year (e.g. 5 = 5%). Defaults to the engine's flat factory default of 5% when omitted; an explicit value (including 0% and negative) is used as given.",
    },
    volatilityPct: {
      ...PCT,
      description:
        "Annual portfolio volatility (standard deviation), as a percent.",
    },
    strategy: {
      type: "string",
      enum: ["constant", "guardrails", "phased", "percent"],
      description:
        "Spending strategy: constant (same real spending every year), guardrails (spending cuts 10% when the year's spending rate tops 120% of the starting rate, rises 10% when it falls below 80%, at most one adjustment a year), phased (spending stays flat until age 75, then steps down 1% a year), or percent (5% of the start-of-year balance each year). Defaults to constant.",
    },
    minimumAnnualSpending: {
      ...MONEY,
      description:
        "Optional minimum annual spending in dollars per year. Adds a spending-adequacy rate: the share of runs in which every retired year's gross spending stayed at or above that floor — reported beside the funding rate, never instead of it, because a high funding rate is not proof spending held the floor. Omit or 0 for no floor.",
    },
    socialSecurityAnnual: {
      ...MONEY,
      description:
        "Primary person's Social Security benefit in dollars per year at socialSecurityStartAge.",
    },
    socialSecurityStartAge: {
      ...AGE,
      description: "Age the primary person starts Social Security.",
    },
    spouseSocialSecurityAnnual: {
      ...MONEY,
      description:
        "Spouse's Social Security benefit in dollars per year at spouseSocialSecurityStartAge.",
    },
    spouseSocialSecurityStartAge: {
      ...AGE,
      description: "Age the spouse starts Social Security.",
    },
    taxableBasisPct: {
      ...PCT,
      description:
        "Cost basis of the taxable account as a percent of its balance (e.g. 72 = 72% basis, so 28% is taxable gain when sold).",
    },
    taxableDividendYieldPct: {
      ...PCT,
      description: "Taxable account dividend yield, as a percent per year.",
    },
    taxableInterestYieldPct: {
      ...PCT,
      description: "Taxable account interest yield, as a percent per year.",
    },
    otherOrdinaryAnnual: {
      ...MONEY,
      description: "Other ordinary income per year in dollars.",
    },
    taxExemptInterestAnnual: {
      ...MONEY,
      description: "Tax-exempt interest per year in dollars.",
    },
    acaBenchmarkCouple: {
      ...MONEY,
      description:
        "ACA benchmark (second-lowest Silver) premium per year in dollars for a two-person household.",
    },
    acaBenchmarkSingle: {
      ...MONEY,
      description:
        "ACA benchmark premium per year in dollars for a one-person household.",
    },
    acaBenchmarkFamily: {
      ...MONEY,
      description:
        "ACA benchmark premium per year in dollars for a family household.",
    },
    priorYearMagi: {
      type: "array",
      maxItems: 40,
      items: {
        type: "object",
        properties: {
          taxYear: {
            type: "integer",
            minimum: 1900,
            maximum: 2200,
            description: "The tax year the return was filed for.",
          },
          magi: {
            ...MONEY,
            description:
              "That year's modified adjusted gross income (AGI plus tax-exempt interest) in dollars.",
          },
          filingStatus: {
            type: "string",
            enum: ["mfj", "single", "hoh"],
            description:
              "The filing status that year's return was filed under.",
          },
        },
        required: ["taxYear", "magi", "filingStatus"],
        additionalProperties: false,
      },
      description:
        "Prior-year filed returns for the two-year IRMAA lookback: each entry is one tax year's MAGI and the filing status that return was filed under. A premium year's IRMAA is set by the return filed two years earlier, so these entries price the first Medicare years of a plan whose march starts near 65; without them those years price $0 of IRMAA and are flagged unknown. Entries are taken exactly as supplied — never inferred from current balances or spending. A duplicate tax year keeps the last entry. Priced by retirement_compare_strategies, retirement_roth_conversion and retirement_work_years.",
    },
    healthPremiumAcaHouseholdAnnual: {
      ...MONEY,
      description:
        "Marketplace health premium per year in dollars for a year when both spouses are on the marketplace — the plan actually enrolled in. Priced only by the tax-aware tools.",
    },
    healthPremiumAcaSingleAnnual: {
      ...MONEY,
      description:
        "Marketplace health premium per year in dollars for a year when exactly one spouse is on the marketplace — the plan actually enrolled in. Priced only by the tax-aware tools.",
    },
    healthPremiumMedicarePerPersonAnnual: {
      ...MONEY,
      description:
        "Medicare base premium per person on Medicare, dollars per year (Part B standard + Part D base, excluding the IRMAA surcharge, which the engine prices separately). Priced only by the tax-aware tools.",
    },
    spendingIncludesHealthPremiums: {
      type: "boolean",
      description:
        "Whether monthlySpending already includes health insurance premiums. REQUIRED when any health premium field is given: true means the premiums are inside monthlySpending and are not charged again; false means monthlySpending excludes them and the premium is funded on top of spending.",
    },
    stateRatePct: {
      type: "number",
      minimum: 0,
      maximum: 50,
      description: "Flat state income-tax rate, as a percent.",
    },
    state: {
      type: "string",
      description:
        "State of residence: a 2-letter code (WA) or full name (Washington). Anything other than WA is priced with the flat stateRatePct (default 0).",
    },
    taxYear: {
      type: "integer",
      minimum: FIRST_LAW_YEAR,
      maximum: latestTaxLawYear(),
      description: `Tax law year to price under (one of the published law years: ${LAW_YEARS_PROSE}).`,
    },
    salaryAnnual: {
      ...MONEY,
      description:
        "Gross salary per year in dollars while still working (used by the work-years comparison for pre-retirement years).",
    },
    employer401kAnnual: {
      ...MONEY,
      description: "Employer 401(k) contribution per year in dollars.",
    },
    employerHsaAnnual: {
      ...MONEY,
      description: "Employer HSA contribution per year in dollars.",
    },
    hsaCoverage: {
      type: "string",
      enum: ["self-only", "family", "none"],
      description:
        "HDHP coverage type the HSA limit prices from: self-only or family coverage, or none (no qualifying HDHP — no HSA contribution of either source). Omit to fall back to filing status (family for joint filers, self-only otherwise), recorded as an assumption on the priced work years. Only priced by retirement_work_years.",
    },
    hsaEligible: {
      type: "boolean",
      description:
        "Whether the primary is an HSA-eligible individual (qualifying HDHP, no disqualifying coverage, not Medicare-enrolled). False means explicitly ineligible — no HSA contribution of either source. Omit to assume eligibility unless Medicare enrollment ends it, recorded as an assumption on the priced work years. Only priced by retirement_work_years.",
    },
    medicareAgePrimary: {
      type: ["integer", "null"],
      minimum: 0,
      maximum: 120,
      description:
        "Primary person's Medicare enrollment age in whole years, or null for no modeled enrollment. When given, HSA contributions (employee and employer) stop in work years at or after that age. Omitted or null means no Medicare enrollment is modeled during the work years — eligibility at 65 is not enrollment, and this is never defaulted to 65.",
    },
    priorYearWagesAnnual: {
      ...MONEY,
      description:
        "Prior calendar year's Social Security wages (W-2 Box 3) from the plan sponsor in dollars — the figure the mandatory Roth catch-up test reads for the first modeled work year. Omit to use that year's own Box-3 wages as a proxy, recorded as an assumption on the first priced work year. Only priced by retirement_work_years.",
    },
    interestAnnual: {
      ...MONEY,
      description: "Taxable interest for the single-year tax calculation, in dollars.",
    },
    ordinaryDividendsAnnual: {
      ...MONEY,
      description:
        "Total ordinary dividends for the single-year tax calculation, in dollars — the 1099-DIV Box 1a total, including the qualified portion.",
    },
    qualifiedDividendsAnnual: {
      ...MONEY,
      description:
        "Qualified dividends for the single-year tax calculation, in dollars — the qualified portion (1099-DIV Box 1b) of total ordinary dividends. Must not exceed ordinaryDividendsAnnual; a call with qualified above ordinary is rejected as invalid input naming both fields.",
    },
    conversionAnnual: {
      ...MONEY,
      description: "Roth conversion amount for the single-year tax calculation, in dollars.",
    },
    spendingDrawAnnual: {
      ...MONEY,
      description: "Draw for spending for the single-year tax calculation, in dollars.",
    },
    cashDrawAnnual: {
      ...MONEY,
      description: "Draw from cash for the single-year tax calculation, in dollars.",
    },
    rothDrawAnnual: {
      ...MONEY,
      description: "Draw from Roth for the single-year tax calculation, in dollars.",
    },
    stockSoldAnnual: {
      ...MONEY,
      description:
        "Taxable shares sold in the single-year tax year, in dollars of proceeds. The realized gain (proceeds minus stockBasisAnnual) prices on the capital-gains stack; the full proceeds count as cash in. A basis above the proceeds is a realized loss (up to $3,000 offsets ordinary income, the rest carries forward). Omitted means no sale is priced; explicit 0 means a $0 sale.",
    },
    stockBasisAnnual: {
      ...MONEY,
      description:
        "Cost basis of the shares sold (stockSoldAnnual), in dollars. Only prices against a sale — a basis with no sale has no effect. Omitted with a sale means basis $0 (the whole proceeds price as gain).",
    },
    pretaxPriorYearEndAnnual: {
      ...MONEY,
      description:
        "Primary person's pre-tax balance at December 31 of the year BEFORE the priced tax year, in dollars. The RMD for the priced year prices from this balance and the owner's age. Omitted means no RMD is priced from the primary's balance; explicit 0 means a $0 RMD. Never today's balance — the Dec-31 date matters.",
    },
    pretaxSpousePriorYearEndAnnual: {
      ...MONEY,
      description:
        "Spouse's own pre-tax balance at December 31 of the year BEFORE the priced tax year, in dollars. The spouse's RMD prices from this balance on the spouse's own age clock. Omitted means no spouse RMD is priced; explicit 0 means a $0 spouse RMD. Only counts on a joint (mfj) return.",
    },
    rmdAlreadyReceivedAnnual: {
      ...MONEY,
      description:
        "Part of this year's computed RMD already received AND already counted in the entered income, in dollars. The engine nets it out of the RMD it adds (floored at $0), so a paid RMD is never counted twice. Omitted means $0.",
    },
    primarySoleBeneficiaryOfSpouse: {
      type: "boolean",
      description:
        "Is the primary person the sole beneficiary of the spouse's pre-tax accounts? Gates ONLY the spouse's RMD table: true lets the spouse's RMD use the Joint and Last Survivor Table when the primary is more than 10 years younger, otherwise the Uniform Lifetime Table. Absent means not established — the spouse's RMD prices on the Uniform table (the conservative direction). This is a separate fact from the spouse being the primary's sole beneficiary; one never implies the other.",
    },
    firstRmdDeferralPrimary: {
      type: "boolean",
      description:
        "Defer the primary's first RMD to April 1 of the following year (26 U.S.C. §401(a)(9)(C)(i)(II)). The first RMD year is the year the owner reaches their RMD age; an election entered past that year has no effect (the response names $0 deferred). Omitted means the first RMD is paid in its own year.",
    },
    firstRmdDeferralSpouse: {
      type: "boolean",
      description:
        "Defer the spouse's first RMD to April 1 of the following year. Same rule as firstRmdDeferralPrimary, on the spouse's own RMD-age clock. Omitted means the first RMD is paid in its own year.",
    },
    firstRmdDeferredCarryPrimaryAnnual: {
      ...MONEY,
      description:
        "Primary's first RMD deferred from a prior year, in dollars — priced on top of the priced year's own RMD (the two-RMD year). Tax-year tool only; the plan tools never take a carry-in (their carry is produced by the work-years roll). Omitted means $0.",
    },
    firstRmdDeferredCarrySpouseAnnual: {
      ...MONEY,
      description:
        "Spouse's first RMD deferred from a prior year, in dollars — priced on top of the priced year's own RMD (the two-RMD year). Tax-year tool only. Omitted means $0.",
    },
    survivorEnabled: {
      type: "boolean",
      description:
        "Turn the survivor scenario on (plan tools only): one spouse dies in survivorDeathYear and the survivor's years price under Single from the year after. Omitted means off — both spouses are modeled through the plan horizon.",
    },
    survivorWho: {
      type: "string",
      enum: ["primary", "spouse"],
      description:
        "Who dies in the survivor scenario. Default is \"primary\".",
    },
    survivorDeathYear: {
      type: "integer",
      minimum: 1900,
      maximum: 2100,
      description:
        "Calendar year of death in the survivor scenario. Required when survivorEnabled is true.",
    },
    survivorClaimAge: {
      type: "integer",
      minimum: 60,
      maximum: 70,
      description:
        "The survivor's Social Security claiming age for the enhanced survivor benefit (60–70). The engine prices the SSA survivor rules from it — the widow(er)'s limit, the claiming-age reduction from 60, the delayed credits accrued to the month of death. No claim-one-then-switch optimization: a survivor who claims the survivor benefit and later switches to their own benefit is priced as the larger of the two each year, not as the optimized switch. Absent means the simplified max-of-two-benefits rule. Never inferred: no claiming age is assigned from anything else entered.",
    },
    mcSeed: {
      type: "integer",
      description: "Random seed for the Monte Carlo run, for reproducibility.",
    },
    mcRuns: {
      type: "integer",
      minimum: 10,
      maximum: 5000,
      description: "Number of Monte Carlo simulations (capped at 5000).",
    },
    compareAges: {
      type: "array",
      items: { type: "integer", minimum: 18, maximum: 120 },
      minItems: 2,
      maxItems: 5,
      description:
        "Retirement ages to compare (e.g. [59, 61, 64] — the retirement age plus two later ages).",
    },
    comparisonScope: {
      type: "string",
      enum: ["limited", "full"],
      description:
        "Which candidate set a comparison tool evaluates. \"limited\" (default) is the fixed small comparison: 3 withdrawal orders for retirement_compare_strategies, 4 conversion strategies for retirement_roth_conversion. \"full\" prices the engine's whole candidate space: all six withdrawal orders, or the full Roth optimizer search (thousands of candidates, can take over a minute — never silently downgraded to limited). retirement_work_years has no full mode: \"full\" there is an unsupported error.",
    },
  },
  required: ["pretax", "taxable", "roth", "hsa", "monthlySpending", "currentAge"],
  additionalProperties: false,
};

const EMPTY_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Handlers. Tools 1-7 share one rule: normalize first; a normalize failure
// is returned as the AdapterError envelope (never thrown). Tool 8 bypasses
// normalize entirely — it needs no financial inputs.
// ---------------------------------------------------------------------------

async function normalized(
  args: unknown,
  fn: (
    scenario: Parameters<typeof calculateRetirement>[0],
  ) => AdapterResult<unknown> | Promise<AdapterResult<unknown>>,
): Promise<AdapterResult<unknown>> {
  const n = normalizeInputs(args);
  if (!n.ok) return n.error;
  return fn(n.scenario);
}

// ---------------------------------------------------------------------------
// Example calls shared by the tool descriptions and the capabilities guide.
// One fictional sample household throughout (never real figures): pretax
// $1,250,000; taxable $2,100,000; Roth $375,000; HSA $62,000; spending
// $9,500/mo; basis 72%; Social Security $36,000/yr at 67; ages 54/52.
// Descriptions embed these with JSON.stringify so the example in the prose
// and the example in the guide can never drift apart.
// ---------------------------------------------------------------------------

const REQUIRED_INPUTS_GLOBAL: string[] = [
  "pretax",
  "taxable",
  "roth",
  "hsa",
  "monthlySpending",
  "currentAge",
];

// Optional fields each tool actually prices. Review 8 S1: these are
// NOT hardcoded here anymore — they are read from PRICED_OPTIONAL in
// pricedInputs.ts, the single authoritative mapping (verified against
// what each tool's engine reads). The shared schema accepts every
// field for every tool, but a field only changes the answer when the
// tool's engine reads it: the simulation engines read no tax inputs
// (SimInputs carries no filing status, basis, yield, ACA, or state
// field), the tax-aware compare reads no strategy/volatility
// (RothSavedLike carries neither), and the single-year pricer reads
// neither portfolio assumptions nor retirementAge/endAge
// (PlaygroundYearInputs carries none of those). The guide lists the
// priced subset per tool so an AI never sends a value expecting an
// effect it cannot have; the tool descriptions say the same in prose.
// A field outside a tool's priced list is still accepted, but the
// response reports it in ignoredInputFields (and warnings) instead
// of silently dropping it. The drift test
// (tests/review8-drift.test.ts) fails if this guide, the JSON Schema,
// or the mapping disagree about what a tool prices.
// (Pass-3 S1: one shared list for every tool advertised inert inputs
// as if they mattered — mcRuns on max-spending, tax inputs on the
// sim-only tools, strategy/volatility on the compare/tax-year tools.)
// (E1 fix round: calculate has no Monte Carlo leg — simulateDetailed +
// runHistorical + runNeverRunsOut never read volatility — so the
// calculate guide lists SIM minus volatilityPct. MC and max-spending
// keep the full SIM list (their Monte Carlo legs price it).)
// NOTE: the per-tool sets below are the PRICED_OPTIONAL entries
// verbatim (spread into fresh arrays so the guide never mutates the
// mapping): calculate is the SIM list minus volatilityPct, monte
// carlo is SIM plus mcRuns/mcSeed, max-spending is SIM minus
// minimumAnnualSpending plus mcSeed (mcRuns is inert there — the
// solver always runs the engine's fixed 1,000 simulations; the
// floor is inert there too — the solver scores funding success
// only and reports no adequacy rate).

const EXAMPLE_BASE: Record<string, unknown> = {
  pretax: 1250000,
  taxable: 2100000,
  roth: 375000,
  hsa: 62000,
  monthlySpending: 9500,
  currentAge: 54,
  spouseAge: 52,
};

const EXAMPLE_CALCULATE: Record<string, unknown> = {
  ...EXAMPLE_BASE,
  retirementAge: 59,
  endAge: 95,
  socialSecurityAnnual: 36000,
  socialSecurityStartAge: 67,
};

const EXAMPLE_MONTE_CARLO: Record<string, unknown> = {
  ...EXAMPLE_CALCULATE,
  mcRuns: 1000,
  mcSeed: 42,
};

const EXAMPLE_MAX_SPENDING: Record<string, unknown> = {
  ...EXAMPLE_CALCULATE,
  mcSeed: 42,
};

const EXAMPLE_COMPARE_STRATEGIES: Record<string, unknown> = EXAMPLE_CALCULATE;

const EXAMPLE_ROTH: Record<string, unknown> = EXAMPLE_CALCULATE;

const EXAMPLE_WORK_YEARS: Record<string, unknown> = {
  ...EXAMPLE_BASE,
  retirementAge: 59,
  compareAges: [59, 61, 64],
  salaryAnnual: 120000,
  employer401kAnnual: 5000,
  employerHsaAnnual: 1000,
  // 65: the work years priced here (59–63) all fall before it, so
  // the enrollment stop changes no figure in this example — it
  // pins the field in the example call only.
  medicareAgePrimary: 65,
};

const EXAMPLE_TAX_YEAR: Record<string, unknown> = {
  ...EXAMPLE_CALCULATE,
  taxYear: 2026,
  interestAnnual: 1000,
  ordinaryDividendsAnnual: 5000,
  qualifiedDividendsAnnual: 3000,
  conversionAnnual: 20000,
  spendingDrawAnnual: 114000,
  cashDrawAnnual: 0,
  rothDrawAnnual: 0,
  stockSoldAnnual: 20000,
  stockBasisAnnual: 12000,
};

// Every tool description is self-describing: WHEN to call it, the inputs in
// plain language, and what it returns. An AI client should be able to pick
// the right tool from its description alone.

export const TOOLS: McpToolDef[] = [
  {
    name: "retirement_calculate",
    description:
      `Use when the user asks whether they can retire now, or when they can afford to retire. ` +
      `Required: pretax, taxable, roth, hsa (account balances in dollars; 0 is fine), monthlySpending (dollars per month), currentAge (whole years). ` +
      `Optional: retirementAge (defaults to your current age — retire now), endAge (default 95), spouseAge, Social Security amounts and start ages (default none; both spouses' benefits are priced, each starting in its own claiming year), and portfolio assumptions expectedRealReturnPct, stocksPct and strategy (defaults from the engine). Optional minimumAnnualSpending (dollars per year) adds a spending-adequacy rate: the share of historical runs in which every retired year's gross spending stayed at or above that floor — reported beside the funding rate, never instead of it, because a high funding rate is not proof spending held the floor. Tax inputs (filing status, taxable basis, yields, ACA benchmarks, state rate) and taxYear do not change this answer — the simulation prices no tax. Health insurance premiums are not priced here either — use a tax-aware tool (retirement_compare_strategies, retirement_roth_conversion, retirement_work_years or retirement_tax_year) to include them. mcRuns, mcSeed and volatilityPct do not change it either — there is no Monte Carlo leg here; the historical cross-check is deterministic. ` +
      `Example call: ${JSON.stringify(EXAMPLE_CALCULATE)}. ` +
      `Returns: whether the money lasts (neverRunsOut), the ending balance, and a year-by-year balance table, plus the historical cross-check of the same plan.`,
    inputSchema: BASE_INPUT_SCHEMA,
    handler: (args) => normalized(args, calculateRetirement),
  },
  {
    name: "retirement_monte_carlo",
    description:
      `Use when the user asks how likely their retirement plan is to succeed, or wants a probability instead of a single yes/no answer. ` +
      `Required: the same six as retirement_calculate — pretax, taxable, roth, hsa (dollars; 0 is fine), monthlySpending (dollars per month), currentAge (whole years). ` +
      `Optional: retirementAge (defaults to your current age — retire now), endAge (default 95), Social Security amounts and start ages (default none; both spouses' benefits are priced, each starting in its own claiming year), portfolio assumptions such as expectedRealReturnPct, volatilityPct, stocksPct and strategy (defaults from the engine), plus mcRuns (number of simulations, up to 5000) and mcSeed (random seed; set it to reproduce the exact same run). Optional minimumAnnualSpending (dollars per year) adds a spending-adequacy rate: the share of simulations in which every retired year's gross spending stayed at or above that floor — reported beside the success rate, never instead of it, because a high funding-success rate is not proof the household can maintain its desired spending (a percent-of-portfolio plan can fund every year while its spending collapses). Tax inputs (filing status, taxable basis, yields, ACA benchmarks, state rate) and taxYear do not change this answer — the simulation prices no tax. Health insurance premiums are not priced here either — use a tax-aware tool (retirement_compare_strategies, retirement_roth_conversion, retirement_work_years or retirement_tax_year) to include them. ` +
      `Example call: ${JSON.stringify(EXAMPLE_MONTE_CARLO)}. ` +
      `Returns: the success probability — the share of simulations in which the money lasts to the end age — with the distribution of outcomes across the simulations. successRate is a 0–1 fraction at whole-run precision: with N runs the finest step is 1/N, so 972 successes out of 1,000 read 0.972 (never a 2dp rounding — 99.9% reads 0.999, not 1.0). successfulRuns is the whole-run count behind the rate, derived from the engine rate × run count.`,
    inputSchema: BASE_INPUT_SCHEMA,
    handler: (args) => normalized(args, runRetirementMonteCarlo),
  },
  {
    name: "retirement_max_spending",
    description:
      `Use when the user asks how much they can spend per month in retirement, or what the highest sustainable spending level is. ` +
      `Required: the same six as retirement_calculate — pretax, taxable, roth, hsa (dollars; 0 is fine), monthlySpending (dollars per month), currentAge (whole years). monthlySpending is still required: give current spending (e.g. 9500) as the starting point; the tool reports the highest sustainable level, which may differ. ` +
      `Optional: retirementAge (defaults to your current age — retire now), endAge (default 95), Social Security amounts and start ages (default none; both spouses' benefits are priced, each starting in its own claiming year), portfolio assumptions such as expectedRealReturnPct, volatilityPct, stocksPct and strategy (defaults from the engine), plus mcSeed for the Monte Carlo check (random seed; set it to reproduce the exact same run). The solver always runs the engine's fixed 1,000 simulations, so a supplied mcRuns is not used for this tool. A supplied minimumAnnualSpending does not change this answer — the solver scores funding success only and reports no adequacy rate. Tax inputs (filing status, taxable basis, yields, ACA benchmarks, state rate) and taxYear do not change this answer — the simulation prices no tax. Health insurance premiums are not priced here either — use a tax-aware tool (retirement_compare_strategies, retirement_roth_conversion, retirement_work_years or retirement_tax_year) to include them. ` +
      `Example call: ${JSON.stringify(EXAMPLE_MAX_SPENDING)}. ` +
      `Returns: the maximum sustainable monthly spending in dollars at 85% Monte Carlo success over 1,000 simulations, with a historical cross-check of that spending level. The maximum is conditional on the seed, 1,000 simulations, the model assumptions, and the engine's $100 search increment — it is a portfolio-only (no-tax) simulation result, not a tax-aware answer. Results carry targetSuccessRate: 0.85, the strategy as priced (spendingStrategy), what the solved dollars mean for that strategy (spendingAmountMeaning — for percent the dollars are the initial-year-equivalent spend at solvedPortfolioWithdrawalPct, not fixed annual spending), and feasible (false when no spending level — not even $0/year — meets the 85% target, with a warning). solvedPortfolioWithdrawalPct is the solver's own percent (a number only for the percent strategy; null otherwise). cappedAtPercentBound is true when the percent strategy's Monte Carlo leg hits the engine's 30%/yr bound — a capped result, not a true maximum — and historicalCappedAtPercentBound is the same flag for the historical leg. The bound is the engine's step count (at most 30%/yr), so a capped percent reads 30 only when the portfolio is an exact $1,000 multiple; on any other portfolio it reads slightly below 30. For constant, phased and guardrails the engine's internal search cap has no adapter-visible flag, so a capped result there is not flagged — a documented limitation. successRate is a 0–1 fraction at whole-run precision (with 1,000 runs the finest step is 0.001), with successfulRuns the whole-run count behind it; the historical leg reports its own historicalRuns / historicalSuccessfulRuns / historicalSolvedPortfolioWithdrawalPct / historicalCappedAtPercentBound. ` +
      `The response also reports the feasibility of that maximum: targetSuccessRate (0.85), achievedSuccessRate (the success rate actually achieved, 0–1), targetAchieved (whether the returned spending meets the 85% target), and solutionStatus — "feasible" (a positive spending meets the target), "feasible_at_zero" ($0/yr is the highest sustainable spending), "infeasible_at_zero" (no spending level reaches the target, even $0/yr — the reported $0 is NOT a sustainable spending), or "capped" (the figure is the solver's search cap, not a proven maximum above it; the percent strategy's 30%-of-portfolio cap always binds). Never describe a $0 maximum as meeting the target unless solutionStatus is "feasible_at_zero" and targetAchieved is true.`,
    inputSchema: BASE_INPUT_SCHEMA,
    handler: (args) => normalized(args, calculateMaxSpending),
  },
  {
    name: "retirement_compare_strategies",
    description:
      `Use when the user asks which account to spend from first, or how the withdrawal order changes their taxes and outcome. ` +
      `Required: the same six as retirement_calculate — pretax, taxable, roth, hsa (dollars; 0 is fine), monthlySpending (dollars per month), currentAge (whole years). ` +
      `Optional: retirementAge (defaults to your current age — retire now), endAge (default 95), Social Security amounts and start ages (default none), tax inputs (taxable basis, yields, ACA benchmarks, state rate, and the Roth composition — rothIra / rothEmployer split, rothContributionBasis, rothConversionLots, firstRothYear, firstDesignatedRothYear — all optional; without the composition a Roth draw prices -e income and -e penalty and is flagged unknown), health premium amounts (healthPremiumAcaHouseholdAnnual, healthPremiumAcaSingleAnnual, healthPremiumMedicarePerPersonAnnual — annual dollars; supplying any of them requires spendingIncludesHealthPremiums, which states whether monthlySpending already includes the premiums), and portfolio assumptions expectedRealReturnPct and stocksPct (defaults from the engine). Spending strategy and volatility do not change this comparison — it is deterministic and tax-aware, not simulated. taxYear does not change it either — the march starts in the current year and prices each year under that year's published tables; a year past the newest published row prices under that row carried forward in today's dollars — a projection. minimumAnnualSpending does not change it either — the floor is a retirement-simulation input; this comparison prices no simulation. ` +
      `There is no strategy input: by default the tool compares three withdrawal orders — taxable-first, pre-tax-first, roth-first — and reports each one, so do not pass a withdrawal order. Pass comparisonScope "full" to compare all six permutations of the Taxable / Pre-tax / Roth order instead (same inputs, same baseline taxable-first); the response's comparisonScope block names the evaluated set, both winners (lowest lifetime net cost and highest ending after-tax wealth — different objectives, often different winners), and the tie rule. No comparison here claims a global optimum. ` +
      `Example call: ${JSON.stringify(EXAMPLE_COMPARE_STRATEGIES)}. ` +
      `Returns: a tax-aware comparison of the withdrawal orders (three by default, six with comparisonScope "full"), with taxes, ACA credit, IRMAA, lifetime health premiums (gross and net, when premium fields are supplied) and ending wealth for each, so the user can see which order leaves the most.`,
    inputSchema: BASE_INPUT_SCHEMA,
    handler: (args) => normalized(args, compareWithdrawalStrategies),
  },
  {
    name: "retirement_roth_conversion",
    description:
      `Use when the user asks whether to convert pre-tax money to Roth, how much to convert, or whether conversions are worth the tax. ` +
      `Required: the same six as retirement_calculate — pretax, taxable, roth, hsa (dollars; 0 is fine), monthlySpending (dollars per month), currentAge (whole years). ` +
      `Optional: retirementAge (defaults to your current age — retire now), endAge (default 95), Social Security amounts and start ages (default none), tax inputs (taxable basis, yields, ACA benchmarks, state rate, and the Roth composition — rothIra / rothEmployer split, rothContributionBasis, rothConversionLots, firstRothYear, firstDesignatedRothYear — all optional; without the composition a Roth draw prices -e income and -e penalty and is flagged unknown), health premium amounts (healthPremiumAcaHouseholdAnnual, healthPremiumAcaSingleAnnual, healthPremiumMedicarePerPersonAnnual — annual dollars; supplying any of them requires spendingIncludesHealthPremiums, which states whether monthlySpending already includes the premiums), and portfolio assumptions expectedRealReturnPct and stocksPct (defaults from the engine). Spending strategy and volatility do not change this comparison — it is deterministic and tax-aware, not simulated. taxYear does not change it either — the march starts in the current year and prices each year under that year's published tables; a year past the newest published row prices under that row carried forward in today's dollars — a projection. minimumAnnualSpending does not change it either — the floor is a retirement-simulation input; this comparison prices no simulation. ` +
      `By default the tool compares four conversion strategies — Do Nothing vs Fill 12% vs Fill 22% vs Fill 22% capped at IRMAA Tier 1 — and the winner is only the best of those four, never a global optimum. Pass comparisonScope "full" to run the engine's full Roth optimizer search instead: thousands of candidates (every bracket / IRMAA / ACA-cliff / MAGI ceiling × conversion window × all six draw orders × guardrail / bunching / gain-harvest variants) at the entered claiming ages, with the Do Nothing benchmark, the winning candidate's actual conversion policy and yearly conversion amounts, and the total candidates evaluated. A full call can take over a minute and is never silently downgraded to the four-strategy comparison. Even the full search is not a global optimum — claiming ages are held at the entered ages. The response's comparisonScope block names the evaluated set, both winners (lowest lifetime net cost and highest ending after-tax wealth — different objectives, often different winners), and what was intentionally excluded. ` +
      `Example call: ${JSON.stringify(EXAMPLE_ROTH)}. ` +
      `Returns: a tax-aware comparison of conversion strategies — the four fixed fills by default, or the full optimizer search with comparisonScope "full" — with federal tax, ACA credit, IRMAA, lifetime health premiums (gross and net, when premium fields are supplied) and ending wealth for each returned candidate.`,
    inputSchema: BASE_INPUT_SCHEMA,
    handler: (args) => normalized(args, compareRothConversions),
  },
  {
    name: "retirement_dynamic_withdrawal",
    description:
      `Use when the user asks for a year-by-year withdrawal plan — which account to draw from and how much to convert in each year — rather than one fixed order or one fixed conversion ceiling for the whole horizon. ` +
      `Required: the same six as retirement_calculate — pretax, taxable, roth, hsa (dollars; 0 is fine), monthlySpending (dollars per month), currentAge (whole years). ` +
      `Optional: retirementAge (defaults to your current age — retire now), endAge (default 95), Social Security amounts and start ages (default none), tax inputs (taxable basis, yields, ACA benchmarks, state rate, and the Roth composition — rothIra / rothEmployer split, rothContributionBasis, rothConversionLots, firstRothYear, firstDesignatedRothYear — all optional; without the composition a Roth draw is priced as tax-free ($0 income, $0 penalty) under an assumed-qualified default, and flagged unknown rather than computed), health premium amounts (healthPremiumAcaHouseholdAnnual, healthPremiumAcaSingleAnnual, healthPremiumMedicarePerPersonAnnual — annual dollars; supplying any of them requires spendingIncludesHealthPremiums, which states whether monthlySpending already includes the premiums), and portfolio assumptions expectedRealReturnPct and stocksPct (defaults from the engine). Spending strategy and volatility do not change this comparison — it is deterministic and tax-aware, not simulated. taxYear does not change it either — the march starts in the current year and prices each year under that year's published tables; a year past the newest published row prices under that row carried forward in today's dollars — a projection. minimumAnnualSpending does not change it either — the floor is a retirement-simulation input; this comparison prices no simulation. ` +
      `Each year the engine re-prices the remaining horizon from that year's actual balances over up to 114 fixed-fill policies (Do Nothing, Fill 12% / 22% with and without the marginal-rate guardrail, Fill 22% capped at IRMAA Tier 1, Fill capped at the ACA cliff, × windows stopping at 65 / the year before RMDs begin / the end age, × all six draw orders) and commits the best valid policy's first year — so the draw order and the conversion can change year to year as balances, ages, Social Security, RMDs, and the ACA / Medicare boundary change. The result is floored at the best valid fixed policy over the same set (floorBound says whether the floor bound, with the raw greedy figures beside it), and no global optimum is claimed — the set holds no bunching, gain-harvest, or claiming-age search, and the choice is greedy one year at a time. ` +
      `Example call: ${JSON.stringify(EXAMPLE_ROTH)}. ` +
      `Returns: the annual withdrawal schedule table (per year: phase, policy, draw per bucket, conversion, federal and state tax, penalty, IRMAA, ACA credit kept, MAGI and ACA MAGI against the cliff, RMD with the primary / spouse split, and ending balances with the taxable basis), lifetime totals (net cost, tax, penalty, IRMAA, ACA credit, RMDs, conversions), the terminal block (terminal tax on the standing pre-tax balance and the step-up in basis on the taxable balance, with wealth with and without the step-up), and the best fixed policy for comparison.`,
    inputSchema: BASE_INPUT_SCHEMA,
    handler: (args) => normalized(args, dynamicWithdrawal),
  },
  {
    name: "retirement_work_years",
    description:
      `Use when the user asks whether working a few more years is worth it, or what changes if they retire later. ` +
      `Required: the same six as retirement_calculate — pretax, taxable, roth, hsa (dollars; 0 is fine), monthlySpending (dollars per month), currentAge (whole years). ` +
      `Optional: retirementAge (defaults to your current age — retire now), compareAges (a list of retirement ages to compare; default is the retirement age, plus two and plus five years), endAge (default 95), Social Security amounts and start ages (default none), tax inputs (taxable basis, yields, ACA benchmarks, state rate, and the Roth composition — rothIra / rothEmployer split, rothContributionBasis, rothConversionLots, firstRothYear, firstDesignatedRothYear — all optional; without the composition a Roth draw prices -e income and -e penalty and is flagged unknown), health premium amounts (healthPremiumAcaHouseholdAnnual, healthPremiumAcaSingleAnnual, healthPremiumMedicarePerPersonAnnual — annual dollars; supplying any of them requires spendingIncludesHealthPremiums, which states whether monthlySpending already includes the premiums), and portfolio assumptions expectedRealReturnPct and stocksPct (defaults from the engine). Spending strategy and volatility do not change this comparison — it is deterministic and tax-aware, not simulated. taxYear does not change it either — the march starts in the current year and prices each year under that year's published tables; a year past the newest published row prices under that row carried forward in today's dollars — a projection. minimumAnnualSpending does not change it either — the floor is a retirement-simulation input; this comparison prices no simulation. ` +
      `Pass salaryAnnual (plus employer401kAnnual and employerHsaAnnual) to price the earned-income leg: each quit age then also reports work years, payroll tax and the optimizer's best strategy and claim ages. Without a salary the earned-income leg is omitted and the response carries a warning instead. Optional hsaCoverage states the HDHP coverage the HSA limit prices from (self-only / family / none); hsaEligible states HSA eligibility explicitly; medicareAgePrimary states the Medicare enrollment age that ends HSA eligibility; priorYearWagesAnnual states the prior calendar year's Social Security wages (W-2 Box 3) from the plan sponsor for the mandatory Roth catch-up test in the first modeled work year. Omitting any of them keeps the previous behavior — filing-status HSA limit, assumed eligibility, and the first year's own Box-3 wages as the catch-up proxy — and each fallback is recorded as an assumption on the priced rows and in the warnings, never silently. Pass medicareAgePrimary (whole years, or null) to model Medicare enrollment: HSA contributions (employee and employer) stop in work years at or after that age; omitted or null means no enrollment is modeled and HSA contributions continue — eligibility at 65 is not enrollment, and it is never defaulted to 65. Partial-year HSA eligibility is not modeled: a year prices the full annual limit when eligible and $0 when not. A work-years call can take a minute or more; while it runs, the server keeps answering light requests (including /health) — the call itself still occupies its lane until it returns or times out. comparisonScope "full" is not supported for this tool — each quit age prices one fixed strategy, and the full optimizer search runs per retirement age (see retirement_roth_conversion); passing "full" here returns an unsupported error, not a quiet limited comparison. ` +
      `Example call: ${JSON.stringify(EXAMPLE_WORK_YEARS)}. ` +
      `Returns: two comparisons of the same ages. The retirement-only comparison (winnerByEndingWealth / winnerByNetCost, also under retirementOnly) prices the same starting balances at each age and ignores salary, employer contributions, and payroll tax. The salary-aware comparison (workYears rows, workYearsComparison) prices the salary, employer 401(k)/HSA, payroll tax, and portfolio growth of the extra working years; every row is valued at the same terminal age, so ending after-tax wealth is comparable across quit ages. Lowest all-in tax (winnerByAllInTax) and highest ending after-tax wealth (winnerByEndingAfterTaxWealth) are different objectives and may point to different ages. overallRecommendation names a quit age only when both salary-aware objectives agree on it (and a salary was provided); otherwise it is null with overallRecommendationNote explaining why. comparisonModels says what each model prices and whether it searches claiming ages or runs the joint optimizer.`,
    inputSchema: BASE_INPUT_SCHEMA,
    handler: (args) => normalized(args, compareRetirementAges),
  },
  {
    name: "retirement_tax_year",
    description:
      `Use when the user asks what their tax bill will be for one specific year, or how much a Roth conversion or a draw costs in tax that year. ` +
      `Required: the same six as retirement_calculate — pretax, taxable, roth, hsa (dollars; 0 is fine), monthlySpending (dollars per month), currentAge (whole years). ` +
      `Optional: taxYear (${LAW_YEARS_PROSE}; default ${latestTaxLawYear()}), single-year amounts for that one year (interestAnnual, ordinaryDividendsAnnual, qualifiedDividendsAnnual, conversionAnnual, spendingDrawAnnual, cashDrawAnnual, rothDrawAnnual — all in dollars), plus filingStatus, householdSize, Social Security amounts and start ages, ACA benchmarks and state rate (all optional), and health premium amounts (healthPremiumAcaHouseholdAnnual, healthPremiumAcaSingleAnnual, healthPremiumMedicarePerPersonAnnual — annual dollars; supplying any of them requires spendingIncludesHealthPremiums, which states whether monthlySpending already includes the premiums). A rothDrawAnnual prices on the Roth composition when entered (rothIra / rothEmployer split, rothContributionBasis, rothConversionLots, firstRothYear, firstDesignatedRothYear — all optional, primary owner only): contributions come out free, prior conversions inside 5 years pay the 10% §72(t) penalty on the taxable part when under 59½, and earnings are ordinary income (plus 10% when under 59½) unless the distribution is qualified. Without the composition the draw prices as qualified — $0 income, $0 penalty — and the response flags it unknown (rothBasisUnknown, rothAssumedQualified), so never read that $0 as a computed answer. ordinaryDividendsAnnual is the TOTAL ordinary dividends (1099-DIV Box 1a), including the qualified portion; qualifiedDividendsAnnual is the qualified portion (Box 1b) and must not exceed ordinaryDividendsAnnual — a call with qualified above ordinary is rejected as invalid input naming both fields. A taxable share sale is priced from stockSoldAnnual (proceeds) and stockBasisAnnual (basis) — the gain (or loss, when basis exceeds proceeds) rides the capital-gains stack and the proceeds count as cash in; omit both when there is no sale. An RMD is priced from pretaxPriorYearEndAnnual (the primary's pre-tax balance at Dec 31 of the year before the priced year) and, on a joint return, pretaxSpousePriorYearEndAnnual (the spouse's own Dec-31 balance); omit both when no balance is known and no RMD is priced. Use rmdAlreadyReceivedAnnual for the part of this year's RMD already received and already counted in the entered income, and primarySoleBeneficiaryOfSpouse (true/false) only if you know whether the primary is the spouse's sole beneficiary — absent, the spouse's RMD prices on the Uniform Lifetime Table. A first RMD can be deferred to April 1 of the following year with firstRmdDeferralPrimary / firstRmdDeferralSpouse (true) — the priced year must be the owner's first RMD year or the election has no effect; a first RMD deferred from a prior year enters as firstRmdDeferredCarryPrimaryAnnual / firstRmdDeferredCarrySpouseAnnual and prices on top of the priced year's own RMD. The response names the deferred and deferred-paid amounts (rmdDeferredPrimary, rmdDeferredSpouse, rmdDeferredPaidPrimary, rmdDeferredPaidSpouse). retirementAge, endAge, and portfolio assumptions (return, volatility, stocks, spending strategy) do not change this year's price. minimumAnnualSpending does not change this year's price either — the floor is a retirement-simulation input; a single tax year prices no simulation. The four balances are required by the shared input contract but only the prior-Dec-31 balances above price an RMD — the current balances never do. ` +
      `Example call: ${JSON.stringify(EXAMPLE_TAX_YEAR)}. ` +
      `Returns: the single-year federal and state tax, ACA premium credit, IRMAA price, and health premiums (gross and net, when premium fields are supplied) for that one tax year, including any priced sale gain/loss and RMD.`,
    inputSchema: BASE_INPUT_SCHEMA,
    handler: (args) => normalized(args, calculateSingleYearTax),
  },
  {
    name: "retirement_describe_capabilities",
    description:
      `Use when the user (or an AI client) asks what this server can do, which tools exist, what inputs each tool needs, or what the limits and assumptions are — or as a first call to discover the server before asking a retirement question. ` +
      `Required: none. Optional: none — it takes no inputs. ` +
      `Example call: {}. ` +
      `Returns: a machine-readable guide in results — tools (one entry per tool with name, whenToUse, required and optional inputs, an exampleCall, and a resultSummary), requiredInputsGlobal, assumptionsSummary, limitations, quickStart, and the engine block (source, adapterVersion, apiContractVersion, taxLawYear, lawYears). It performs no calculation.`,
    inputSchema: EMPTY_INPUT_SCHEMA,
    handler: () => describeCapabilities(),
  },
];

export const TOOL_NAMES: string[] = TOOLS.map((t) => t.name);

const TOOLS_BY_NAME: ReadonlyMap<string, McpToolDef> = new Map(
  TOOLS.map((t) => [t.name, t] as const),
);

const CAPABILITY_ASSUMPTIONS: Assumption[] = [
  {
    field: "taxLawYear",
    value: latestTaxLawYear(),
    provenance: "engine_constant",
    note: "Pricing uses the latest published tax-law tables; earlier years are available via taxYear.",
  },
  {
    field: "stateless",
    value: true,
    provenance: "engine_constant",
    note: "Every call carries its complete scenario. Nothing is saved between calls.",
  },
  {
    field: "monthlySpending",
    value: "excludes health premiums unless spendingIncludesHealthPremiums is true",
    provenance: "assumption",
    note: "When health premium fields are supplied, monthlySpending is read as living expenses excluding health insurance premiums and the premium is funded on top of spending, unless spendingIncludesHealthPremiums declares the premiums are already inside monthlySpending (then they are not charged again). When no premium field is supplied, no premium is modeled and the call carries a warning.",
  },
];

const CAPABILITY_LIMITATIONS: string[] = [
  "Stateless and read-only: every call carries its complete scenario; nothing is saved.",
  `Tax law years ${FIRST_LAW_YEAR}–${latestTaxLawYear()} only. Later tables are not yet published, so later-year pricing is not available from the single-year tool. Multi-year plans price later years on the newest published row carried forward in today's dollars — a projection, named in each priced year's lawProvenance — and the 2027 federal figures (Rev. Proc. 2026-35) are published but no 2027 row is adopted until the CMS half (2027 Part B premium + IRMAA) publishes.`,
  "State tax in multi-year results is a flat-rate estimate, never an exact state tax return: the caller-supplied stateRatePct on federal taxable income (0% when none is supplied), named per year in stateTaxProvenance. The single-year tool returns the same provenance beside its figure; the multi-year yearly tables carry lawProvenance and stateTaxProvenance on every row, and the work-years rows — per-quit-age aggregates over several salary years — are covered by a response-level note instead, since no single law row describes an aggregate spanning exact and carried-forward years.",
  "Health insurance premiums are priced only by the tax-aware tools (retirement_compare_strategies, retirement_roth_conversion, retirement_dynamic_withdrawal, retirement_work_years, retirement_tax_year); the portfolio-only tools (retirement_calculate, retirement_monte_carlo, retirement_max_spending) price no premiums. A premium supplied with spendingIncludesHealthPremiums false is funded on top of monthlySpending; with the flag true it is already inside spending and is not charged again. Supplying a premium without the flag is rejected.",
  "retirement_work_years compares retirement ages with the tax-aware engine; when salaryAnnual is given it also prices the earned-income leg (work years, payroll tax, best strategy and claim ages) for each quit age, and without a salary that leg is omitted with a warning. medicareAgePrimary models Medicare enrollment (HSA contributions stop at or after that age); omitted or null means no enrollment is modeled. The retirement-only winners and the salary-aware winners are reported separately — lowest all-in tax and highest ending after-tax wealth are different objectives — and overallRecommendation is set only when both salary-aware objectives agree.",
  "Every work-years row is valued at the same terminal age, so ending after-tax wealth is comparable across quit ages; all-in tax covers the same full span for every row.",
  "Monte Carlo runs are capped at 5,000 simulations per call and the planning horizon ends at age 120.",
  "Funding success is not spending adequacy: the Monte Carlo and calculate success rates count runs where every year's withdrawal was funded, but under the percent, guardrails, or phased strategies yearly spending can shrink far below the household's desired level while every year still funds. Pass minimumAnnualSpending (dollars per year) to retirement_calculate or retirement_monte_carlo to also get the adequacy rate (`historicalSpendingAdequacyRate` on calculate, `spendingAdequacyRate` on monte_carlo) — the share of runs where every retired year's GROSS spending stayed at or above that floor — and read the two rates together; a high funding-success rate is not proof the household can maintain its desired spending. Adequacy is measured on gross spending, so for the constant strategy, whose gross never varies, a floor at or below yearly spending reads adequacy 100% even in runs where withdrawals went unfunded.",
  "Pre-retirement income is not accumulated: the simulation prices no pre-retirement spending, salary, or tax, so a Social Security benefit (or other fixed income) starting before retirement is not banked in the pre-retirement years — it counts only once retired. Benefits already being collected while still working belong to retirement_work_years, which prices those years with tax and lands the surplus in Taxable.",
  "The retirement simulation is tax-free and single-portfolio: it prices no income tax, no IRMAA, and no separate account buckets — the tax-aware tools (retirement_compare_strategies, retirement_roth_conversion, retirement_dynamic_withdrawal, retirement_work_years) price tax and account order instead.",
  "A single-year price models a share sale only from typed stockSoldAnnual/stockBasisAnnual (never from taxableBasisPct, which prices no sale), and an RMD only from a typed prior-Dec-31 balance (never from today's balance). Capital-loss carryforward entering the year is not an input — the year's own realized loss still prices (up to $3,000 against ordinary income, the rest carried out in lossCarryOutSt/lossCarryOutLt), but a banked loss from an earlier year cannot be typed in.",
  "Execution: the heavy calls (work-years comparison, dynamic withdrawal, full optimizer search) run in a two-worker pool, not on the request thread, so a long call does not stall the server — including /health — while it runs; most calls return in a few seconds, but the work-years comparison can take a minute or more, a dynamic withdrawal call can take a minute or more on a full horizon (it re-prices the remaining horizon at every year), and a full optimizer search (retirement_roth_conversion with comparisonScope \"full\") can take over a minute too. Each worker job has a 100 s deadline: a job past it fails with a typed timeout error (`ENGINE_TIMEOUT`, retryable) — never a fabricated or partial winner — and is never silently downgraded to the limited comparison. If the optimizer throws, the call fails with `engine_error`.",
  "Limited comparisons never claim a global optimum: the default 3-order withdrawal comparison and 4-strategy Roth comparison crown the best of those few only. The full optimizer search is optimal only within the engine's searched candidate space at the entered claiming ages — it does not search claiming ages and prices no Monte Carlo success check. Every comparison response carries a comparisonScope block saying exactly what was evaluated; lowest lifetime net cost and highest ending after-tax wealth are different objectives and often crown different winners.",
  "Success rates are 0–1 fractions at whole-run precision, never rounded to 2dp: with N runs the finest step is 1/N (931 successes out of 1,000 read 0.931, not 0.93; 99.9% reads 0.999, not 1.0). successfulRuns / historicalSuccessfulRuns are the whole-run counts behind the rates, derived from the engine rate × run count.",
  "Max spending is conditional on the seed, 1,000 simulations, the model assumptions, and the engine's $100 search increment, and is a portfolio-only (no-tax) simulation result. Only the percent strategy's cap is flaggable: cappedAtPercentBound (Monte Carlo leg) and historicalCappedAtPercentBound (historical leg) are true when the respective leg hits the engine's 30%/yr bound. For constant, phased and guardrails the engine's internal search cap has no adapter-visible flag, so a maximum that is really the cap is not flagged.",
  "Results are planning estimates from the Finance Planner engines, not tax advice.",
  "Standalone bundle: the same eight tools ship as a single finance-planner-cli.mjs file that runs under plain Node.js 20+ with no server, no install, and no network — see assistant-api/STANDALONE.md.",
];

// Machine-readable self-orientation guide for AI clients: one entry per
// tool, with the same example calls the descriptions show (same constants,
// so prose and guide can never drift apart).
interface ToolGuideEntry {
  name: string;
  whenToUse: string;
  required: string[];
  optional: string[];
  exampleCall: Record<string, unknown>;
  resultSummary: string;
}

const TOOL_GUIDE: ToolGuideEntry[] = [
  {
    name: "retirement_calculate",
    whenToUse:
      "Use when the user asks whether they can retire now, or when they can afford to retire.",
    required: REQUIRED_INPUTS_GLOBAL,
    optional: [...PRICED_OPTIONAL.retirement_calculate],
    exampleCall: EXAMPLE_CALCULATE,
    resultSummary:
      "Whether the money lasts (neverRunsOut), the ending balance, and a year-by-year balance table, plus the historical cross-check of the same plan — and, when minimumAnnualSpending is given, the historical spending-adequacy rate beside the funding rate.",
  },
  {
    name: "retirement_monte_carlo",
    whenToUse:
      "Use when the user asks how likely their retirement plan is to succeed, or wants a probability instead of a single yes/no answer.",
    required: REQUIRED_INPUTS_GLOBAL,
    optional: [...PRICED_OPTIONAL.retirement_monte_carlo],
    exampleCall: EXAMPLE_MONTE_CARLO,
    resultSummary:
      "The success probability — the share of simulations in which the money lasts to the end age — with the distribution of outcomes across the simulations. When minimumAnnualSpending is given, also the spending-adequacy rate: the share of simulations where every retired year's gross spending stayed at or above that floor — read beside the success rate, never instead of it. successRate is a 0–1 fraction at whole-run precision (finest step 1/runs), with successfulRuns the whole-run count behind it.",
  },
  {
    name: "retirement_max_spending",
    whenToUse:
      "Use when the user asks how much they can spend per month in retirement, or what the highest sustainable spending level is.",
    required: REQUIRED_INPUTS_GLOBAL,
    optional: [...PRICED_OPTIONAL.retirement_max_spending],
    exampleCall: EXAMPLE_MAX_SPENDING,
    resultSummary:
      "The maximum sustainable monthly spending in dollars at 85% Monte Carlo success, with a historical cross-check of that spending level. (monthlySpending is still required as the starting point.) The solver always runs the engine's fixed 1,000 simulations — mcRuns is not used for this tool; results report runs: 1000. A supplied minimumAnnualSpending does not change this answer — the solver scores funding success only and reports no adequacy rate. The maximum is conditional on the seed, 1,000 simulations, the model assumptions, and the engine's $100 search increment — a portfolio-only (no-tax) result. The response also reports feasibility: targetSuccessRate (0.85), achievedSuccessRate, targetAchieved, and solutionStatus (feasible | feasible_at_zero | infeasible_at_zero | capped) — a $0 maximum with solutionStatus infeasible_at_zero means no spending level reaches the target. Results carry spendingStrategy, spendingAmountMeaning, feasible, solvedPortfolioWithdrawalPct (percent strategy only), cappedAtPercentBound (Monte Carlo leg at the engine's 30%/yr bound) and historicalCappedAtPercentBound (historical leg, same bound), and the historical leg's own historicalRuns / historicalSuccessfulRuns / historicalSolvedPortfolioWithdrawalPct. For constant, phased and guardrails the engine's internal search cap has no adapter-visible flag, so a capped result there is not flagged.",
  },
  {
    name: "retirement_compare_strategies",
    whenToUse:
      "Use when the user asks which account to spend from first, or how the withdrawal order changes their taxes and outcome.",
    required: REQUIRED_INPUTS_GLOBAL,
    optional: [...PRICED_OPTIONAL.retirement_compare_strategies],
    exampleCall: EXAMPLE_COMPARE_STRATEGIES,
    resultSummary:
      "A tax-aware comparison of the three withdrawal orders (taxable-first, pretax-first, roth-first), with taxes, ACA credit and ending wealth for each. There is no strategy input — all three are always compared.",
  },
  {
    name: "retirement_roth_conversion",
    whenToUse:
      "Use when the user asks whether to convert pre-tax money to Roth, how much to convert, or whether conversions are worth the tax.",
    required: REQUIRED_INPUTS_GLOBAL,
    optional: [...PRICED_OPTIONAL.retirement_roth_conversion],
    exampleCall: EXAMPLE_ROTH,
    resultSummary:
      "A tax-aware comparison of four conversion strategies — Do Nothing vs Fill 12% vs Fill 22% vs Fill 22% capped at IRMAA Tier 1 — with federal tax, ACA credit, IRMAA and ending wealth for each.",
  },
  {
    name: "retirement_dynamic_withdrawal",
    whenToUse:
      "Use when the user asks for a year-by-year withdrawal plan — which account to draw from and how much to convert in each year — rather than one fixed order or one fixed conversion ceiling for the whole horizon.",
    required: REQUIRED_INPUTS_GLOBAL,
    optional: [...PRICED_OPTIONAL.retirement_dynamic_withdrawal],
    exampleCall: EXAMPLE_ROTH,
    resultSummary:
      "The annual withdrawal schedule table (per year: phase, policy, draw per bucket, conversion, tax, MAGI and ACA position, RMD, ending balances) with lifetime totals, the terminal / step-up block, and the best valid fixed policy for comparison. No global optimum is claimed.",
  },
  {
    name: "retirement_work_years",
    whenToUse:
      "Use when the user asks whether working a few more years is worth it, or what changes if they retire later.",
    required: REQUIRED_INPUTS_GLOBAL,
    optional: [...PRICED_OPTIONAL.retirement_work_years],
    exampleCall: EXAMPLE_WORK_YEARS,
    resultSummary:
      "Two comparisons of retiring at each age in compareAges: the retirement-only winners (same starting balances, salary ignored) and — when salaryAnnual is given — the salary-aware work-years comparison (work years, payroll tax, all-in tax, ending after-tax wealth, best strategy and claim ages), with overallRecommendation set only when both salary-aware objectives agree on one age.",
  },
  {
    name: "retirement_tax_year",
    whenToUse:
      "Use when the user asks what their tax bill will be for one specific year, or how much a Roth conversion or a draw costs in tax that year.",
    required: REQUIRED_INPUTS_GLOBAL,
    optional: [...PRICED_OPTIONAL.retirement_tax_year],
    exampleCall: EXAMPLE_TAX_YEAR,
    resultSummary:
      "The single-year federal and state tax, ACA premium credit and IRMAA price for that one tax year, including any priced share sale (gain/loss, proceeds as cash in) and any priced RMD (from the prior-Dec-31 balances).",
  },
  {
    name: "retirement_describe_capabilities",
    whenToUse:
      "Use when the user (or an AI client) asks what this server can do, which tools exist, what inputs each tool needs, or what the limits and assumptions are — or as a first call to discover the server before asking a retirement question.",
    required: [],
    optional: [],
    exampleCall: {},
    resultSummary:
      "This guide: one entry per tool (whenToUse, required/optional inputs, exampleCall, resultSummary), plus requiredInputsGlobal, assumptionsSummary, limitations, quickStart and the engine block. No calculation is performed.",
  },
];

const ASSUMPTIONS_SUMMARY: string[] = [
  "All money is dollars, ages are whole years, percents are numbers (5 = 5%).",
  "Success rates are 0–1 fractions at the engine's whole-run precision (never rounded to 2dp): with N runs the finest step is 1/N, and successfulRuns is the whole-run count behind the rate, derived from the engine rate × run count.",
  "Every financial call carries its complete scenario; nothing is saved between calls.",
  "Missing optional fields fall back to documented defaults inside normalize: retirementAge defaults to your current age (retire now), endAge defaults to 95, Social Security defaults to none.",
  "Each tool prices only the inputs its engine reads — the guide lists the priced optionals per tool, and a field outside that list is accepted but has no effect on that tool's answer (notably mcRuns for max-spending, which always solves at the engine's fixed 1,000 runs). Such a field is reported in the response's ignoredInputFields (and as a warnings[] entry naming the field, the tool, and the tool that does price it) instead of being silently dropped.",
  "qualifiedDividendsAnnual is the qualified portion (1099-DIV Box 1b) of total ordinaryDividendsAnnual (Box 1a) and must not exceed it — a call with qualified above ordinary is rejected as invalid_input naming both fields (contract version 164).",
  "Comparison tools default to comparisonScope \"limited\" (3 withdrawal orders / 4 conversion strategies); pass \"full\" for the engine's whole candidate space. Every comparison response carries a comparisonScope block: what was evaluated, both winners (lowest lifetime net cost vs highest ending after-tax wealth), and whether any global optimum is claimed (never — even the full optimizer search holds claiming ages fixed and prices no Monte Carlo success check).",
  "Pricing uses the latest published tax-law tables (the engine block names the year); earlier law years are available via taxYear.",
];

const QUICK_START: { local: string; remote: string; standalone: string } = {
  local:
    "Local (zero-config): run `bun src/server.ts` from the assistant-api directory — it listens on http://127.0.0.1:8080 with no token needed on localhost. Then POST a JSON-RPC request to http://127.0.0.1:8080/mcp, or call retirement_describe_capabilities first to see all tools.",
  remote:
    "Remote: from the repo root run `assistant-api/deploy.sh` with ASSISTANT_API_TOKEN set — it builds the Docker image and runs it on 0.0.0.0:8080. Then POST to https://<host>/mcp with header `Authorization: Bearer <token>`.",
  standalone:
    "Standalone (no server, no install): run `node finance-planner-cli.mjs <tool> input.json` with Node.js 20+ — a single self-contained file, no MCP connection or hosting needed. No release has been published yet — until the first release, use the committed copy at `assistant-api/dist/finance-planner-cli.mjs` (with its `.sha256` checksum) or build it with `cd assistant-api && bun run build:standalone`; see assistant-api/STANDALONE.md and assistant-api/AI_USAGE.md.",
};

function describeCapabilities(): AdapterResult<unknown> {
  const envelope: AdapterResponse<unknown> = {
    ok: true,
    source: "finance-planner-engine",
    adapterVersion: ADAPTER_VERSION,
    apiContractVersion: API_CONTRACT_VERSION_REPORTED,
    taxLawYear: latestTaxLawYear(),
    // No financial inputs exist for this tool, so there is no scenario to
    // echo back; the cast keeps the envelope type honest about that.
    effectiveInputs: {} as AdapterResponse<unknown>["effectiveInputs"],
    assumptions: CAPABILITY_ASSUMPTIONS,
    results: {
      tools: TOOL_GUIDE,
      requiredInputsGlobal: REQUIRED_INPUTS_GLOBAL,
      assumptionsSummary: ASSUMPTIONS_SUMMARY,
      limitations: CAPABILITY_LIMITATIONS,
      quickStart: QUICK_START,
      engine: {
        source: "finance-planner-engine",
        adapterVersion: ADAPTER_VERSION,
        apiContractVersion: API_CONTRACT_VERSION_REPORTED,
        taxLawYear: latestTaxLawYear(),
        lawYears: TAX_LAW_YEARS.map((law) => law.year),
        // Engine Review 3 (E3-S1): what "the newest row" means
        // for a year past it. Multi-year plans price later
        // years on the newest published row carried forward
        // in today's dollars — a projection, named per year
        // in lawProvenance — while this adapter's single-year
        // tool prices published years only and rejects the
        // rest. The 2027 federal figures are published (Rev.
        // Proc. 2026-35) but no 2027 row is adopted until the
        // CMS half (2027 Part B premium + IRMAA) publishes.
        lawProvenanceNote: `Published law rows ${FIRST_LAW_YEAR}–${latestTaxLawYear()}. Multi-year plans price later years on the ${latestTaxLawYear()} row carried forward in today's dollars (a projection, named per priced year in lawProvenance); the single-year tool prices published years only.`,
      },
    },
    warnings: [],
    // describe takes no financial inputs, so there is nothing a
    // caller could have supplied that went unpriced.
    ignoredInputFields: [],
  };
  return envelope;
}

// ---------------------------------------------------------------------------
// Dispatch. Unknown tool name -> throw (the server maps it to JSON-RPC
// -32602). Normalize failures and adapter envelopes are returned as-is,
// never thrown. Logs only tool name + ok + duration (never inputs/results).
// Async: the heavy tools price in the worker pool, so dispatch awaits
// the handler; a pool EngineError is already mapped to a typed
// envelope by the adapter's guardAsync — dispatch never sees one as
// a throw. The server maps the typed envelope to the JSON-RPC /
// HTTP error shape (§1.4).
// ---------------------------------------------------------------------------

export async function dispatchTool(
  name: string,
  args: unknown,
): Promise<AdapterResult<unknown>> {
  const started = Date.now();
  const def = TOOLS_BY_NAME.get(name);
  if (!def) {
    throw new Error(`Unknown tool: ${name}`);
  }
  try {
    const result = await def.handler(args);
    console.error(
      `[assistant-api] tool=${name} ok=${result.ok} ms=${Date.now() - started}`,
    );
    return result;
  } catch (err) {
    console.error(
      `[assistant-api] tool=${name} ok=false threw ms=${Date.now() - started}`,
    );
    throw err;
  }
}
