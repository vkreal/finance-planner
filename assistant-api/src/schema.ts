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
// - Unknown keys are REJECTED (z.strictObject): a misspelled or
//   unrecognized field fails validation with `invalid_input` naming
//   the key, instead of being silently stripped — so a mistyped
//   field can never silently drop intended income. This agrees
//   with the published MCP JSON Schema (additionalProperties:
//   false in tools.ts).
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

export const RetirementQuestionInputs = z.strictObject({
  // --- Essential: required keys (explicit 0 allowed). ---
  /** Pre-tax retirement balances (401(k), traditional IRA, …), dollars. */
  pretax: dollars,
  /** Taxable brokerage balances, dollars. */
  taxable: dollars,
  /** Roth balances, dollars. */
  roth: dollars,
  /** HSA balance, dollars. */
  hsa: dollars,
  /** Typical monthly spending, dollars. Must be > 0, <= $200,000/mo.
   *  Read as living expenses EXCLUDING health insurance premiums
   *  unless spendingIncludesHealthPremiums is true: when health
   *  premium fields are supplied with that flag false, the premium
   *  is funded on top of this spending; with it true the premiums
   *  are already inside this figure and are not charged again. */
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
   *  the engine's EXPECTED_RETURN_DEFAULT (5%). */
  expectedRealReturnPct: percent(-50, 50).optional(),
  /** Return volatility (std dev), %/yr, 0–100. Default (in
   *  normalize): the engine's blendedVol(stocksPct). */
  volatilityPct: percent(0, 100).optional(),
  /** Portfolio stock allocation, 0–100. Default (in normalize): 95
   *  (engine STOCKS_PCT_DEFAULT). */
  stocksPct: percent(0, 100).optional(),
  /** Spending strategy. Default (in normalize): "constant". */
  strategy: z.enum(["constant", "guardrails", "phased", "percent"]).optional(),
  /** Minimum annual spending floor for the spending-adequacy
   *  rate, $/yr (Engine Review 1, E1-S1). Optional: omitted →
   *  no floor, and the adequacy rate is null. When set, the
   *  Monte Carlo and calculate results report the adequacy rate
   *  (`spendingAdequacyRate` on monte_carlo,
   *  `historicalSpendingAdequacyRate` on calculate) — the share
   *  of runs in which EVERY retired year's GROSS spending met or
   *  beat the floor — beside the funding-success rate. The two
   *  rates answer different questions (see the adequacy text in
   *  apiContractCore.ts); a high funding rate is not proof
   *  spending held the floor. */
  minimumAnnualSpending: dollars.optional(),

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

  // --- Prior-year returns for the IRMAA two-year lookback
  // (Engine Review 6, E6-S1). ---
  /** Filed returns the two-year IRMAA lookback reads: one entry
   *  per tax year — that year's MAGI in dollars and the filing
   *  status that year's return was filed under. Optional:
   *  omitted → no supplied returns, and a premium year with no
   *  recorded lookback prices $0 of IRMAA and is flagged
   *  unknown (irmaaLookbackMissingYears on the compare result).
   *  Entries are taken exactly as supplied — never inferred from
   *  current balances or spending — and a duplicate tax year
   *  keeps the LAST entry. Priced by the march tools
   *  (compare_strategies, roth_conversion, work_years); the
   *  single-year tax tool prices IRMAA forward from the priced
   *  year and reads no lookback. */
  priorYearMagi: z
    .array(
      z.strictObject({
        taxYear: z.number().int().finite().min(1900).max(2200),
        magi: dollars,
        filingStatus: z.enum(["mfj", "single", "hoh"]),
      }),
    )
    .max(40)
    .optional(),

  // --- Health insurance premiums (annual dollars; Review 3 R3-S1).
  //  The engine's v208 premium term: when ANY of the three amounts
  //  is entered, the term is ACTIVE and annualSpending is read as
  //  spending EXCLUDING health premiums — the year's actual premium
  //  is funded on top of spending. The fields map to the engine's
  //  healthPremiumAcaHousehold / healthPremiumAcaSingle /
  //  healthPremiumMedicarePerPerson (dollars) and the compare
  //  base's cents twins. An explicit 0 is an entered premium
  //  (it activates the term and caps the retained ACA credit at
  //  that $0 premium — the engine's R3-M2 rule — so a $0 premium
  //  keeps no credit); omit all three to leave the term off.
  //  supplying any of them REQUIRES spendingIncludesHealthPremiums
  //  (see below): the caller must state the spending convention,
  //  because a premium already inside monthlySpending would be
  //  charged twice if it were also funded on top.
  /** Marketplace health premium for a two-person household year,
   *  $/yr (the plan actually enrolled in while both spouses are
   *  on the marketplace). Default: null. */
  healthPremiumAcaHouseholdAnnual: dollars.optional(),
  /** Marketplace health premium for a one-person year, $/yr (the
   *  plan actually enrolled in while exactly one spouse is on the
   *  marketplace). Default: null. */
  healthPremiumAcaSingleAnnual: dollars.optional(),
  /** Medicare BASE premium per person on Medicare, $/yr (Part B
   *  standard + Part D base, EXCLUDING the IRMAA surcharge, which
   *  the engine prices separately). Default: null. */
  healthPremiumMedicarePerPersonAnnual: dollars.optional(),
  /** Whether monthlySpending already includes health insurance
   *  premiums. REQUIRED when any health premium field is given
   *  (normalize returns missing_input without it). true = the
   *  premiums are already inside monthlySpending, so they are
   *  NOT charged again (the engine funds spending verbatim);
   *  false = monthlySpending excludes premiums and the entered
   *  amounts are funded on top of spending. */
  spendingIncludesHealthPremiums: z.boolean().optional(),

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
  /** HDHP coverage type the HSA limit prices from (Engine
   *  Review 7, E7-S1): "self-only" / "family" / "none" (no
   *  qualifying HDHP). Default (in normalize): null — the
   *  engine falls back to the filing status (family for
   *  joint filers, self-only otherwise) and records the
   *  fallback as an assumption. Only priced by
   *  retirement_work_years. */
  hsaCoverage: z.enum(["self-only", "family", "none"]).optional(),
  /** Whether the primary is an HSA-eligible individual
   *  (qualifying HDHP, no disqualifying coverage, not
   *  Medicare-enrolled). Default (in normalize): null —
   *  eligibility is assumed unless Medicare enrollment ends
   *  it, recorded as an assumption. Only priced by
   *  retirement_work_years. */
  hsaEligible: z.boolean().optional(),
  /** The primary's Medicare enrollment age, whole years
   *  (Engine Review 7; engine field since Review 5, exposed
   *  here now): in work years at or after this age no HSA
   *  contribution of either source is made. Default (in
   *  normalize): null — not enrolled during the work years.
   *  Only priced by retirement_work_years. */
  medicareAgePrimary: z.number().int().finite().min(0).max(120).optional(),
  /** Prior calendar year's §3121(a) wages (W-2 Box 3) from
   *  the plan sponsor, $/yr (Engine Review 7, E7-S2): the
   *  figure the §414(v)(7) Roth catch-up test reads for the
   *  FIRST modeled work year. Default (in normalize): null —
   *  the first year's own Box-3 wages stand in as the proxy,
   *  recorded as an assumption. Only priced by
   *  retirement_work_years. */
  priorYearWagesAnnual: dollars.optional(),

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
  // ordinaryDividendsAnnual is the TOTAL ordinary dividends
  // (1099-DIV Box 1a), including the qualified portion;
  // qualifiedDividendsAnnual is the qualified portion (Box 1b).
  // Review 8 S2: qualified must not exceed ordinary — normalize.ts
  // rejects qualified > ordinary as invalid_input naming both
  // fields (a breaking validation change; adapter contract 164),
  // instead of the engine's silent clamp. Both $0 valid; omitted
  // qualified with ordinary present valid; omitted both valid;
  // omitted ordinary counts as $0, so qualified > $0 with ordinary
  // omitted is rejected.
  /** Taxable interest for the single-year tax calculation. */
  interestAnnual: dollars.optional(),
  /** Total ordinary dividends for the single-year tax calculation
   *  (1099-DIV Box 1a), including the qualified portion. */
  ordinaryDividendsAnnual: dollars.optional(),
  /** Qualified dividends for the single-year tax calculation
   *  (1099-DIV Box 1b) — the qualified portion of
   *  ordinaryDividendsAnnual. Must not exceed it. */
  qualifiedDividendsAnnual: dollars.optional(),
  /** Roth conversion amount for the single-year tax calculation. */
  conversionAnnual: dollars.optional(),
  /** Spending draw for the single-year tax calculation. */
  spendingDrawAnnual: dollars.optional(),
  /** Cash draw for the single-year tax calculation. */
  cashDrawAnnual: dollars.optional(),
  /** Roth draw for the single-year tax calculation. */
  rothDrawAnnual: dollars.optional(),
  // --- Single-year taxable-sale inputs (R6-S1; dollars). ---
  // stockSoldAnnual / stockBasisAnnual price the year's realized
  // gain (sold − basis) through the engine's capital-gains stack.
  // A basis above the proceeds is a realized LOSS, not an error:
  // the engine prices it as a net capital loss (§1211(b) allowance
  // up to $3,000, remainder carried forward — see
  // pricePlaygroundYear in server/src/rothOptimizer.ts), so no
  // basis ≤ proceeds rule is imposed here. Omitted → no sale is
  // priced (the adapter distinguishes omitted from explicit $0).
  /** Taxable shares sold in the single-year tax year, $ proceeds. */
  stockSoldAnnual: dollars.optional(),
  /** Cost basis of the shares sold, $. Only prices against a sale. */
  stockBasisAnnual: dollars.optional(),
  // --- Single-year RMD inputs (R6-S2; dollars / boolean). ---
  // Prior-Dec-31 pre-tax balances: the balance at December 31 of
  // the year BEFORE the priced tax year (pretaxPriorYearEndAnnual
  // is the primary's own; pretaxSpousePriorYearEndAnnual the
  // spouse's own — never today's balance, never an inferred one).
  // Omitted → null → no RMD is priced from that balance; explicit
  // $0 → a $0 balance, whose RMD is $0. The engine's RMD age comes
  // from each owner's birth year (rmdAgeForBirthYear).
  /** Primary's pre-tax balance at Dec 31 of the year before the
   *  priced tax year, $. Omitted → no RMD priced from it. */
  pretaxPriorYearEndAnnual: dollars.optional(),
  /** Spouse's own pre-tax balance at Dec 31 of the year before
   *  the priced tax year, $. Omitted → no spouse RMD priced.
   *  Only counts on a joint (mfj) return. */
  pretaxSpousePriorYearEndAnnual: dollars.optional(),
  /** Part of this year's computed RMD already received AND already
   *  counted in the entered income, $. The engine nets it out of
   *  the RMD it adds (floored at $0), so a paid RMD is never
   *  counted twice. Omitted → $0. */
  rmdAlreadyReceivedAnnual: dollars.optional(),
  /** Is the primary the SOLE beneficiary of the spouse's pre-tax
   *  accounts? Gates ONLY the spouse's RMD Joint-table selection
   *  (engine: primarySoleBeneficiaryOfSpouse). Absent → not
   *  established → the spouse's RMD prices on the Uniform
   *  Lifetime Table (the conservative direction). This is a
   *  separate fact from spouseSoleBeneficiary (the spouse is the
   *  primary's sole beneficiary, which the adapter already assumes
   *  for mfj); one never implies the other. */
  primarySoleBeneficiaryOfSpouse: z.boolean().optional(),

  // --- First-RMD deferral + survivor inputs (Engine Review 5,
  // E5-S1/S2). ---
  // firstRmdDeferralPrimary / firstRmdDeferralSpouse: the
  // first-RMD deferral election, per owner — true defers a first
  // RMD year to April 1 of the following year (26 U.S.C.
  // §401(a)(9)(C)(i)(II)). Priced by the tax-year tool (the
  // priced year is a first RMD year when the owner's age is the
  // year they reach their RMD age) and by the plan tools (the
  // march and the work-years roll settle each owner's first RMD
  // through the same shared rule). An election entered past the
  // first RMD year is a no-op — the response names $0 deferred.
  // Omitted → no deferral (the immediate-payment default).
  /** Defer the primary's first RMD to April 1 of the following
   *  year. Omitted → the first RMD is paid in its own year. */
  firstRmdDeferralPrimary: z.boolean().optional(),
  /** Defer the spouse's first RMD to April 1 of the following
   *  year. Omitted → the first RMD is paid in its own year. */
  firstRmdDeferralSpouse: z.boolean().optional(),
  // firstRmdDeferredCarryPrimaryAnnual / ...SpouseAnnual: the
  // amount deferred from a prior year's election (dollars),
  // priced by the tax-year tool ON TOP of the priced year's own
  // RMD — the two-RMD year. The plan tools never take a
  // carry-in: their carry is produced by the work-years roll
  // and handed to the march internally, never entered by the
  // caller. Omitted → $0.
  /** Primary's first RMD deferred from a prior year, $ — priced
   *  on top of the priced year's own RMD (tax-year tool only). */
  firstRmdDeferredCarryPrimaryAnnual: dollars.optional(),
  /** Spouse's first RMD deferred from a prior year, $ — priced
   *  on top of the priced year's own RMD (tax-year tool only). */
  firstRmdDeferredCarrySpouseAnnual: dollars.optional(),
  // Survivor scenario (plan tools only — the single-year pricer
  // carries no survivor scenario, so these are inert there).
  // survivorEnabled turns the scenario on; survivorWho names
  // who dies; survivorDeathYear is the calendar year of death
  // (REQUIRED when enabled — normalize returns missing_input
  // without it). survivorClaimAge is the survivor's claiming
  // age for the enhanced survivor benefit (60–70, whole years):
  // the engine prices the SSA survivor rules from it — the
  // widow(er)'s limit, the claiming-age reduction from 60, the
  // delayed credits accrued to the month of death. Absent → the
  // simplified max-of-two-benefits rule. Never auto-assigned: no
  // claiming age is inferred from anything the caller entered.
  /** Turn the survivor scenario on (plan tools). Omitted → off. */
  survivorEnabled: z.boolean().optional(),
  /** Who dies in the survivor scenario. Default (in normalize):
   *  "primary". */
  survivorWho: z.enum(["primary", "spouse"]).optional(),
  /** Calendar year of death in the survivor scenario. Required
   *  when survivorEnabled is true. */
  survivorDeathYear: z.number().int().finite().min(1900).max(2100).optional(),
  /** The survivor's Social Security claiming age for the enhanced
   *  survivor benefit, 60–70. Absent → the simplified
   *  max-of-two-benefits rule. */
  survivorClaimAge: z.number().int().finite().min(60).max(70).optional(),

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

  // --- Strategy-comparison scope. ---
  /** Which candidate set a comparison tool evaluates. Default (in
   *  normalize): "limited" — the fixed small comparison the tool
   *  has always run (3 withdrawal orders / 4 conversion fills).
   *  "full" prices the engine's whole candidate space instead:
   *  all six withdrawal orders for compare_strategies, and the
   *  engine's full Roth optimizer search for roth_conversion.
   *  A full call is never silently downgraded to limited. */
  comparisonScope: z.enum(["limited", "full"]).optional(),
});

/** Parsed (pre-default) shape of a retirement question's inputs. */
export type RetirementQuestionInput = z.infer<typeof RetirementQuestionInputs>;
