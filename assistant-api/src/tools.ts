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

// Keep the inferred input type referenced so the tool surface stays tied to
// the zod schema even though validation happens inside normalizeInputs.
export type ToolInputs = RetirementQuestionInput;

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: unknown) => AdapterResult<unknown>;
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
      description: "Roth IRA / Roth 401(k) balance in dollars. Required.",
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
        "Federal tax filing status: mfj (married filing jointly), single, or hoh (head of household).",
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
        "Expected real portfolio return, as a percent per year (e.g. 5 = 5%).",
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
    interestAnnual: {
      ...MONEY,
      description: "Taxable interest for the single-year tax calculation, in dollars.",
    },
    ordinaryDividendsAnnual: {
      ...MONEY,
      description: "Ordinary (non-qualified) dividends for the single-year tax calculation, in dollars.",
    },
    qualifiedDividendsAnnual: {
      ...MONEY,
      description: "Qualified dividends for the single-year tax calculation, in dollars.",
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

function normalized(
  args: unknown,
  fn: (scenario: Parameters<typeof calculateRetirement>[0]) => AdapterResult<unknown>,
): AdapterResult<unknown> {
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

// Optional fields each tool actually prices. The shared schema accepts
// every field for every tool, but a field only changes the answer when
// the tool's engine reads it: the simulation engines read no tax
// inputs (SimInputs carries no filing status, basis, yield, ACA, or
// state field), the tax-aware compare reads no strategy/volatility
// (RothSavedLike carries neither), and the single-year pricer reads
// neither portfolio assumptions nor retirementAge/endAge
// (PlaygroundYearInputs carries none of those). The guide lists the
// priced subset per tool so an AI never sends a value expecting an
// effect it cannot have; the tool descriptions say the same in prose.
// (Pass-3 S1: one shared list for every tool advertised inert inputs
// as if they mattered — mcRuns on max-spending, tax inputs on the
// sim-only tools, strategy/volatility on the compare/tax-year tools.)
const SIM_OPTIONAL_INPUTS: string[] = [
  "retirementAge",
  "endAge",
  "spouseAge",
  "stocksPct",
  "expectedRealReturnPct",
  "volatilityPct",
  "strategy",
  "socialSecurityAnnual",
  "socialSecurityStartAge",
  "spouseSocialSecurityAnnual",
  "spouseSocialSecurityStartAge",
];

// Pass-5 S1: calculate has no Monte Carlo leg — simulateDetailed +
// runHistorical + runNeverRunsOut never read volatility — so the
// calculate guide lists SIM minus volatilityPct. MC and max-spending
// keep the full SIM list (their Monte Carlo legs price it).
const CALCULATE_OPTIONAL_INPUTS: string[] = SIM_OPTIONAL_INPUTS.filter(
  (f) => f !== "volatilityPct",
);

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
  "stateRatePct",
  "state",
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
];

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
      `Optional: retirementAge (defaults to your current age — retire now), endAge (default 95), spouseAge, Social Security amounts and start ages (default none), and portfolio assumptions expectedRealReturnPct, stocksPct and strategy (defaults from the engine). Tax inputs (filing status, taxable basis, yields, ACA benchmarks, state rate) and taxYear do not change this answer — the simulation prices no tax. mcRuns, mcSeed and volatilityPct do not change it either — there is no Monte Carlo leg here; the historical cross-check is deterministic. ` +
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
      `Optional: retirementAge (defaults to your current age — retire now), endAge (default 95), Social Security amounts and start ages (default none), portfolio assumptions such as expectedRealReturnPct, volatilityPct, stocksPct and strategy (defaults from the engine), plus mcRuns (number of simulations, up to 5000) and mcSeed (random seed; set it to reproduce the exact same run). Tax inputs (filing status, taxable basis, yields, ACA benchmarks, state rate) and taxYear do not change this answer — the simulation prices no tax. ` +
      `Example call: ${JSON.stringify(EXAMPLE_MONTE_CARLO)}. ` +
      `Returns: the success probability — the share of simulations in which the money lasts to the end age — with the distribution of outcomes across the simulations.`,
    inputSchema: BASE_INPUT_SCHEMA,
    handler: (args) => normalized(args, runRetirementMonteCarlo),
  },
  {
    name: "retirement_max_spending",
    description:
      `Use when the user asks how much they can spend per month in retirement, or what the highest sustainable spending level is. ` +
      `Required: the same six as retirement_calculate — pretax, taxable, roth, hsa (dollars; 0 is fine), monthlySpending (dollars per month), currentAge (whole years). monthlySpending is still required: give current spending (e.g. 9500) as the starting point; the tool reports the highest sustainable level, which may differ. ` +
      `Optional: retirementAge (defaults to your current age — retire now), endAge (default 95), Social Security amounts and start ages (default none), portfolio assumptions such as expectedRealReturnPct, volatilityPct, stocksPct and strategy (defaults from the engine), plus mcSeed for the Monte Carlo check (random seed; set it to reproduce the exact same run). The solver always runs the engine's fixed 1,000 simulations, so a supplied mcRuns is not used for this tool. Tax inputs (filing status, taxable basis, yields, ACA benchmarks, state rate) and taxYear do not change this answer — the simulation prices no tax. ` +
      `Example call: ${JSON.stringify(EXAMPLE_MAX_SPENDING)}. ` +
      `Returns: the maximum sustainable monthly spending in dollars at 85% Monte Carlo success over 1,000 simulations, with a historical cross-check of that spending level.`,
    inputSchema: BASE_INPUT_SCHEMA,
    handler: (args) => normalized(args, calculateMaxSpending),
  },
  {
    name: "retirement_compare_strategies",
    description:
      `Use when the user asks which account to spend from first, or how the withdrawal order changes their taxes and outcome. ` +
      `Required: the same six as retirement_calculate — pretax, taxable, roth, hsa (dollars; 0 is fine), monthlySpending (dollars per month), currentAge (whole years). ` +
      `Optional: retirementAge (defaults to your current age — retire now), endAge (default 95), Social Security amounts and start ages (default none), tax inputs (taxable basis, yields, ACA benchmarks, state rate — all optional), and portfolio assumptions expectedRealReturnPct and stocksPct (defaults from the engine). Spending strategy and volatility do not change this comparison — it is deterministic and tax-aware, not simulated. taxYear does not change it either — the march starts in the current year and prices each year under that year's tables. ` +
      `There is no strategy input: the tool always compares all three withdrawal orders — taxable-first (spend the taxable account first), pretax-first (spend the pre-tax account first), roth-first (spend Roth first) — and reports each one, so do not pass a withdrawal order. ` +
      `Example call: ${JSON.stringify(EXAMPLE_COMPARE_STRATEGIES)}. ` +
      `Returns: a tax-aware comparison of the three withdrawal orders, with taxes, ACA credit and ending wealth for each, so the user can see which order leaves the most.`,
    inputSchema: BASE_INPUT_SCHEMA,
    handler: (args) => normalized(args, compareWithdrawalStrategies),
  },
  {
    name: "retirement_roth_conversion",
    description:
      `Use when the user asks whether to convert pre-tax money to Roth, how much to convert, or whether conversions are worth the tax. ` +
      `Required: the same six as retirement_calculate — pretax, taxable, roth, hsa (dollars; 0 is fine), monthlySpending (dollars per month), currentAge (whole years). ` +
      `Optional: retirementAge (defaults to your current age — retire now), endAge (default 95), Social Security amounts and start ages (default none), tax inputs (taxable basis, yields, ACA benchmarks, state rate — all optional), and portfolio assumptions expectedRealReturnPct and stocksPct (defaults from the engine). Spending strategy and volatility do not change this comparison — it is deterministic and tax-aware, not simulated. taxYear does not change it either — the march starts in the current year and prices each year under that year's tables. ` +
      `Example call: ${JSON.stringify(EXAMPLE_ROTH)}. ` +
      `Returns: a tax-aware comparison of four conversion strategies — Do Nothing vs Fill 12% vs Fill 22% vs Fill 22% capped at IRMAA Tier 1 — with federal tax, ACA credit, IRMAA and ending wealth for each.`,
    inputSchema: BASE_INPUT_SCHEMA,
    handler: (args) => normalized(args, compareRothConversions),
  },
  {
    name: "retirement_work_years",
    description:
      `Use when the user asks whether working a few more years is worth it, or what changes if they retire later. ` +
      `Required: the same six as retirement_calculate — pretax, taxable, roth, hsa (dollars; 0 is fine), monthlySpending (dollars per month), currentAge (whole years). ` +
      `Optional: retirementAge (defaults to your current age — retire now), compareAges (a list of retirement ages to compare; default is the retirement age, plus two and plus five years), endAge (default 95), Social Security amounts and start ages (default none), tax inputs (taxable basis, yields, ACA benchmarks, state rate — all optional), and portfolio assumptions expectedRealReturnPct and stocksPct (defaults from the engine). Spending strategy and volatility do not change this comparison — it is deterministic and tax-aware, not simulated. taxYear does not change it either — the march starts in the current year and prices each year under that year's tables. ` +
      `Pass salaryAnnual (plus employer401kAnnual and employerHsaAnnual) to price the earned-income leg: each quit age then also reports work years, payroll tax and the optimizer's best strategy and claim ages. Without a salary the earned-income leg is omitted and the response carries a warning instead. A work-years call can take a minute or more, and while it runs the server answers nothing else. ` +
      `Example call: ${JSON.stringify(EXAMPLE_WORK_YEARS)}. ` +
      `Returns: a tax-aware comparison of retiring at each age in compareAges, with taxes and ending wealth for each age, plus — when a salary is given — the earned-income comparison (work years, payroll tax, all-in tax) for each age.`,
    inputSchema: BASE_INPUT_SCHEMA,
    handler: (args) => normalized(args, compareRetirementAges),
  },
  {
    name: "retirement_tax_year",
    description:
      `Use when the user asks what their tax bill will be for one specific year, or how much a Roth conversion or a draw costs in tax that year. ` +
      `Required: the same six as retirement_calculate — pretax, taxable, roth, hsa (dollars; 0 is fine), monthlySpending (dollars per month), currentAge (whole years). ` +
      `Optional: taxYear (${LAW_YEARS_PROSE}; default ${latestTaxLawYear()}), single-year amounts for that one year (interestAnnual, ordinaryDividendsAnnual, qualifiedDividendsAnnual, conversionAnnual, spendingDrawAnnual, cashDrawAnnual, rothDrawAnnual — all in dollars), plus filingStatus, householdSize, Social Security amounts and start ages, ACA benchmarks and state rate (all optional). retirementAge, endAge, and portfolio assumptions (return, volatility, stocks, spending strategy) do not change this year's price, and the four balances are required by the shared input contract but no prior-year balance is carried in — so no RMD is priced either. ` +
      `Example call: ${JSON.stringify(EXAMPLE_TAX_YEAR)}. ` +
      `Returns: the single-year federal and state tax, ACA premium credit and IRMAA price for that one tax year. It does not model selling taxable shares to fund the year's spending — cashLeftVsSpending counts only the typed draws and income.`,
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
];

const CAPABILITY_LIMITATIONS: string[] = [
  "Stateless and read-only: every call carries its complete scenario; nothing is saved.",
  `Tax law years ${FIRST_LAW_YEAR}–${latestTaxLawYear()} only. Later tables are not yet published, so later-year pricing is not available.`,
  "retirement_work_years compares retirement ages with the tax-aware engine; when salaryAnnual is given it also prices the earned-income leg (work years, payroll tax, best strategy and claim ages) for each quit age, and without a salary that leg is omitted with a warning.",
  "Monte Carlo runs are capped at 5,000 simulations per call and the planning horizon ends at age 120.",
  "Synchronous execution: calls run to completion in-process with no hard preemption in v1; most calls return in a few seconds, but the work-years comparison can take a minute or more. A long call stalls the whole server — including /health — until it finishes.",
  "Results are planning estimates from the Finance Planner engines, not tax advice.",
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
    optional: [...CALCULATE_OPTIONAL_INPUTS],
    exampleCall: EXAMPLE_CALCULATE,
    resultSummary:
      "Whether the money lasts (neverRunsOut), the ending balance, and a year-by-year balance table, plus the historical cross-check of the same plan.",
  },
  {
    name: "retirement_monte_carlo",
    whenToUse:
      "Use when the user asks how likely their retirement plan is to succeed, or wants a probability instead of a single yes/no answer.",
    required: REQUIRED_INPUTS_GLOBAL,
    optional: [...SIM_OPTIONAL_INPUTS, "mcRuns", "mcSeed"],
    exampleCall: EXAMPLE_MONTE_CARLO,
    resultSummary:
      "The success probability — the share of simulations in which the money lasts to the end age — with the distribution of outcomes across the simulations.",
  },
  {
    name: "retirement_max_spending",
    whenToUse:
      "Use when the user asks how much they can spend per month in retirement, or what the highest sustainable spending level is.",
    required: REQUIRED_INPUTS_GLOBAL,
    optional: [...SIM_OPTIONAL_INPUTS, "mcSeed"],
    exampleCall: EXAMPLE_MAX_SPENDING,
    resultSummary:
      "The maximum sustainable monthly spending in dollars at 85% Monte Carlo success, with a historical cross-check of that spending level. (monthlySpending is still required as the starting point.) The solver always runs the engine's fixed 1,000 simulations — mcRuns is not used for this tool; results report runs: 1000.",
  },
  {
    name: "retirement_compare_strategies",
    whenToUse:
      "Use when the user asks which account to spend from first, or how the withdrawal order changes their taxes and outcome.",
    required: REQUIRED_INPUTS_GLOBAL,
    optional: COMPARE_OPTIONAL_INPUTS,
    exampleCall: EXAMPLE_COMPARE_STRATEGIES,
    resultSummary:
      "A tax-aware comparison of the three withdrawal orders (taxable-first, pretax-first, roth-first), with taxes, ACA credit and ending wealth for each. There is no strategy input — all three are always compared.",
  },
  {
    name: "retirement_roth_conversion",
    whenToUse:
      "Use when the user asks whether to convert pre-tax money to Roth, how much to convert, or whether conversions are worth the tax.",
    required: REQUIRED_INPUTS_GLOBAL,
    optional: COMPARE_OPTIONAL_INPUTS,
    exampleCall: EXAMPLE_ROTH,
    resultSummary:
      "A tax-aware comparison of four conversion strategies — Do Nothing vs Fill 12% vs Fill 22% vs Fill 22% capped at IRMAA Tier 1 — with federal tax, ACA credit, IRMAA and ending wealth for each.",
  },
  {
    name: "retirement_work_years",
    whenToUse:
      "Use when the user asks whether working a few more years is worth it, or what changes if they retire later.",
    required: REQUIRED_INPUTS_GLOBAL,
    optional: [
      ...COMPARE_OPTIONAL_INPUTS,
      "salaryAnnual",
      "employer401kAnnual",
      "employerHsaAnnual",
      "compareAges",
    ],
    exampleCall: EXAMPLE_WORK_YEARS,
    resultSummary:
      "A tax-aware comparison of retiring at each age in compareAges, with taxes and ending wealth for each age; when salaryAnnual is given, each age also prices the earned-income leg (work years, payroll tax, all-in tax, best strategy and claim ages).",
  },
  {
    name: "retirement_tax_year",
    whenToUse:
      "Use when the user asks what their tax bill will be for one specific year, or how much a Roth conversion or a draw costs in tax that year.",
    required: REQUIRED_INPUTS_GLOBAL,
    optional: TAX_YEAR_OPTIONAL_INPUTS,
    exampleCall: EXAMPLE_TAX_YEAR,
    resultSummary:
      "The single-year federal and state tax, ACA premium credit and IRMAA price for that one tax year.",
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
  "Every financial call carries its complete scenario; nothing is saved between calls.",
  "Missing optional fields fall back to documented defaults inside normalize: retirementAge defaults to your current age (retire now), endAge defaults to 95, Social Security defaults to none.",
  "Each tool prices only the inputs its engine reads — the guide lists the priced optionals per tool, and a field outside that list is accepted but has no effect on that tool's answer (notably mcRuns for max-spending, which always solves at the engine's fixed 1,000 runs).",
  "Pricing uses the latest published tax-law tables (the engine block names the year); earlier law years are available via taxYear.",
];

const QUICK_START: { local: string; remote: string } = {
  local:
    "Local (zero-config): run `bun src/server.ts` from the assistant-api directory — it listens on http://127.0.0.1:8080 with no token needed on localhost. Then POST a JSON-RPC request to http://127.0.0.1:8080/mcp, or call retirement_describe_capabilities first to see all tools.",
  remote:
    "Remote: from the repo root run `assistant-api/deploy.sh` with ASSISTANT_API_TOKEN set — it builds the Docker image and runs it on 0.0.0.0:8080. Then POST to https://<host>/mcp with header `Authorization: Bearer <token>`.",
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
      },
    },
    warnings: [],
  };
  return envelope;
}

// ---------------------------------------------------------------------------
// Dispatch. Unknown tool name -> throw (the server maps it to JSON-RPC
// -32602). Normalize failures and adapter envelopes are returned as-is,
// never thrown. Logs only tool name + ok + duration (never inputs/results).
// ---------------------------------------------------------------------------

export function dispatchTool(name: string, args: unknown): AdapterResult<unknown> {
  const started = Date.now();
  const def = TOOLS_BY_NAME.get(name);
  if (!def) {
    throw new Error(`Unknown tool: ${name}`);
  }
  try {
    const result = def.handler(args);
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
