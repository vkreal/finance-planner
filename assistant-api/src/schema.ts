// schema.ts — Zod v4 input schema for the stateless AI Retirement
// API adapter ("assistant-api").
//
// Conventions (per the adapter spec):
// - All money is in DOLLARS outside the adapter; normalize.ts converts
//   to cents. All percents are plain numbers (e.g. 5 means 5%).
// - The six essential keys (pretax, taxable, roth, hsa,
//   monthlySpending, currentAge) are REQUIRED: omitting one fails
//   validation, and normalize.ts maps that failure to a `missing_input`
//   error (never a calculation on partial input). An explicit 0 counts
//   as present.
// - Every other key is OPTIONAL with NO zod default applied here.
//   Defaults are resolved in normalize.ts, which must be able to tell
//   "caller supplied it" from "omitted" in order to record provenance
//   (user vs assumption vs engine_constant). The effective defaults are
//   documented on each field; see normalize.ts for the resolution.
// - Unknown keys are STRIPPED (zod v4 default object behavior —
//   deliberately NOT .strict()).
// - NaN / Infinity are rejected by z.number() itself in zod v4, and
//   every numeric field also carries .finite() for explicitness.
// - Absurd values are rejected: any dollar amount > $100,000,000;
//   ages 18–120; percents in their stated ranges.

import { z } from "zod";
import { TAX_LAW_YEARS } from "../../server/src/taxLaw";

/** Published law years, derived from the engine table (never hardcoded). */
const TAX_YEAR_LIST = TAX_LAW_YEARS.map((law) => law.year);

/** Largest dollar amount accepted anywhere in the schema. */
export const DOLLAR_MAX = 100_000_000;

/** Any dollar amount: finite, >= 0, <= $100,000,000. */
const dollars = z.number().finite().min(0).max(DOLLAR_MAX);

/** An age: whole years, 18–120. */
const age = z.number().int().finite().min(18).max(120);

/** A percent (plain number, e.g. 5 means 5%). */
const percent = (min: number, max: number) =>
  z.number().finite().min(min).max(max);

export const RetirementQuestionInputs = z.object({
  // --- Essential: required keys (explicit 0 allowed). ---
  /** Pre-tax retirement balances (401(k), traditional IRA, …), dollars. */
  pretax: dollars,
  /** Taxable brokerage balances, dollars. */
  taxable: dollars,
  /** Roth balances, dollars. */
  roth: dollars,
  /** HSA balance, dollars. */
  hsa: dollars,
  /** Typical monthly spending, dollars. Must be > 0, <= $200,000/mo. */
  monthlySpending: z.number().finite().gt(0).max(200_000),
  /** Current age of the primary person, whole years. */
  currentAge: age,

  // --- Ages / household. ---
  /** Spouse's current age. Required when filingStatus is "mfj". */
  spouseAge: age.optional(),
  /** Age retirement starts. Default (in normalize): currentAge. */
  retirementAge: age.optional(),
  /** Last age the plan prices through. Default (in normalize): 95. */
  endAge: age.optional(),
  /** Filing status. Default (in normalize): "mfj". */
  filingStatus: z.enum(["mfj", "single", "hoh"]).optional(),
  /** People in the household, 1–20. Default (in normalize): 2 for
   *  mfj, 1 for single/hoh. */
  householdSize: z.number().int().finite().min(1).max(20).optional(),

  // --- Taxable basis / yields / market assumptions. ---
  /** Share of the taxable balance that is already-taxed basis, 0–100.
   *  Default (in normalize): 100 (blank-basis path — no gains). */
  taxableBasisPct: percent(0, 100).optional(),
  /** Annual dividend yield on the starting taxable balance, %.
   *  Default (in normalize): null (no yield modeled). */
  taxableDividendYieldPct: percent(0, 100).optional(),
  /** Annual interest yield on the starting taxable balance, %.
   *  Default (in normalize): null (no yield modeled). */
  taxableInterestYieldPct: percent(0, 100).optional(),
  /** Expected real return, %/yr, -50–50. Default (in normalize):
   *  the engine's blendedExpected(stocksPct). */
  expectedRealReturnPct: percent(-50, 50).optional(),
  /** Return volatility (std dev), %/yr, 0–100. Default (in
   *  normalize): the engine's blendedVol(stocksPct). */
  volatilityPct: percent(0, 100).optional(),
  /** Portfolio stock allocation, 0–100. Default (in normalize): 95
   *  (engine STOCKS_PCT_DEFAULT). */
  stocksPct: percent(0, 100).optional(),
  /** Spending strategy. Default (in normalize): "constant". */
  strategy: z.enum(["constant", "guardrails", "phased", "percent"]).optional(),

  // --- Social Security. ---
  /** Primary annual Social Security benefit at claiming, dollars.
   *  Default (in normalize): 0 (none modeled). */
  socialSecurityAnnual: dollars.optional(),
  /** Spouse annual Social Security benefit at claiming, dollars.
   *  Default (in normalize): 0 (none modeled). */
  spouseSocialSecurityAnnual: dollars.optional(),
  /** Primary claiming age. Required when socialSecurityAnnual > 0. */
  socialSecurityStartAge: age.optional(),
  /** Spouse claiming age. Required when spouseSocialSecurityAnnual > 0
   *  (and filingStatus is "mfj"). */
  spouseSocialSecurityStartAge: age.optional(),

  // --- State tax. ---
  /** State of residence: 2-letter code ("WA") or full name
   *  ("Washington"). Anything other than WA → residenceState "other".
   *  Default (in normalize): omitted → "other", no state tax. */
  state: z.string().max(100).optional(),
  /** State income-tax rate, %, 0–50. Only used for non-WA states;
   *  ignored for WA (engine uses the WA excise path). */
  stateRatePct: percent(0, 50).optional(),

  // --- ACA benchmarks (annual dollars). ---
  /** ACA benchmark premium, couple, $/yr. Default: null (no credit). */
  acaBenchmarkCouple: dollars.optional(),
  /** ACA benchmark premium, single, $/yr. Default: null. */
  acaBenchmarkSingle: dollars.optional(),
  /** ACA benchmark premium, family, $/yr. Default: null. */
  acaBenchmarkFamily: dollars.optional(),

  // --- Other annual income (tax engine inputs). ---
  /** Other ordinary income, $/yr. Default (in normalize): 0. */
  otherOrdinaryAnnual: dollars.optional(),
  /** Tax-exempt interest, $/yr. Default (in normalize): 0. */
  taxExemptInterestAnnual: dollars.optional(),

  // --- Work-years tool inputs. ---
  /** Annual salary while working, $/yr. Default (in normalize): null
   *  (only needed by the work-years tool). */
  salaryAnnual: dollars.optional(),
  /** Annual employer 401(k) contribution, $/yr. Default: 0. */
  employer401kAnnual: dollars.optional(),
  /** Annual employer HSA contribution, $/yr. Default: 0. */
  employerHsaAnnual: dollars.optional(),

  // --- Tax year. ---
  /** Law year to price with. Must be one of the published law years
   *  in TAX_LAW_YEARS in server/src/taxLaw.ts (2025/2026 today) — the
   *  accepted set is derived from that table, so it extends when a
   *  new year's tables publish, with no code change here. Default
   *  (in normalize): the current calendar year (startYear), clamped
   *  to the latest published year. */
  taxYear: z
    .union(
      TAX_YEAR_LIST.map((year) => z.literal(year)) as [
        z.ZodLiteral<number>,
        ...z.ZodLiteral<number>[],
      ],
      {
        error: `taxYear must be one of ${TAX_YEAR_LIST.join(", ")} (the available law years)`,
      },
    )
    .optional(),

  // --- Single-year tax inputs (dollars, default 0 each). ---
  /** Taxable interest for the single-year tax calculation. */
  interestAnnual: dollars.optional(),
  /** Ordinary (non-qualified) dividends for the single-year tax calc. */
  ordinaryDividendsAnnual: dollars.optional(),
  /** Qualified dividends for the single-year tax calculation. */
  qualifiedDividendsAnnual: dollars.optional(),
  /** Roth conversion amount for the single-year tax calculation. */
  conversionAnnual: dollars.optional(),
  /** Spending draw for the single-year tax calculation. */
  spendingDrawAnnual: dollars.optional(),
  /** Cash draw for the single-year tax calculation. */
  cashDrawAnnual: dollars.optional(),
  /** Roth draw for the single-year tax calculation. */
  rothDrawAnnual: dollars.optional(),

  // --- Monte Carlo. ---
  /** Monte Carlo seed. Default (in normalize): 12345
   *  (MONTE_CARLO_TAB_SEED_DEFAULT). */
  mcSeed: z.number().int().finite().optional(),
  /** Monte Carlo runs, 10–5000. Default (in normalize): 1000
   *  (MONTE_CARLO_TAB_RUNS). */
  mcRuns: z.number().int().finite().min(10).max(5000).optional(),

  // --- Compare-retirement-ages tool input. ---
  /** Ages to compare, 2–5 whole years. Default (in normalize): []
   *  (the adapter defaults to [retirementAge, +2, +5]). */
  compareAges: z.array(age).min(2).max(5).optional(),
});

/** Parsed (pre-default) shape of a retirement question's inputs. */
export type RetirementQuestionInput = z.infer<typeof RetirementQuestionInputs>;
