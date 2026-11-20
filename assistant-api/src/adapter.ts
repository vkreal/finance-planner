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
//   D11. Success rates are probabilities, not money: NEVER pass
//       one through r2. The engine reports them in percent units
//       0–100 as (whole successful runs / runs) * 100, so the
//       finest real granularity is one run (0.1% at 1,000 runs);
//       r2 collapsed 84.6% and 85.4% both to 0.85 and 99.9% to
//       1.0. The adapter converts at engine precision instead:
//       ratePercentToFraction rounds to the nearest whole run
//       (Math.round(rate * runs / 100) / runs), so the reported
//       0–1 fraction always equals a whole run count over the
//       run count, and successfulRunsFromRate recovers that
//       count. The run count is the caller's mcRuns for the
//       Monte Carlo tool, MONTE_CARLO_TAB_RUNS (1,000) for the
//       max-spending solver's Monte Carlo leg, and hist.count
//       for historical legs. Presentation rounding stays in
//       docs only — no API rounding of a probability anywhere.
//   D12. solveMaxSpending returns the solver's own percent for
//       the percent strategy (SolverResult.percent: a NUMBER,
//       pctFor(k), only for "percent"; null for constant /
//       phased / guardrails) and 0 in the at-zero-fails case —
//       the adapter reports it verbatim as
//       solvedPortfolioWithdrawalPct (plus the historical leg's
//       as historicalSolvedPortfolioWithdrawalPct) and never
//       recomputes it. The dollars a strategy solves for mean
//       different things per strategy, so every max-spending
//       result carries spendingAmountMeaning (see
//       spendingAmountMeaning) and the target as
//       targetSuccessRate 0.85. When even $0 spending fails the
//       target the result is feasible: false with a warning,
//       never a silent 0. When the percent strategy hits the
//       engine's 30%/yr bound the result is cappedAtPercentBound:
//       true — a capped result, not a true maximum — and the
//       historical leg carries the same flag as
//       historicalCappedAtPercentBound, detected the same way
//       from its own solve. The bound is the engine's step count
//       (maxSteps = floor(startCents * 0.3 / STEP), STEP = $100
//       in cents), so the capped percent equals 30 only when the
//       starting portfolio is an exact $1,000 multiple; on any
//       other portfolio it reads slightly below 30 (e.g.
//       29.9985… on $1,000,050) and the percent alone never
//       decides capped-ness — the solved dollars against the
//       bound step count do (see
//       maxSpendingCappedAtPercentBound). Constant / phased /
//       guardrails have an internal engine search cap with no
//       adapter-visible flag, so a capped result there cannot
//       be flagged and is documented as a limitation instead.

//   D13. Work-years rows ARE comparable across quit ages (Review 8,
//       correcting the old horizon warning and README limitation
//       (viii)). rollWorkYears spreads the plan into rolledInputs
//       and overrides only startYear (= birthYearPrimary + quitAge),
//       retirementAge, windowStartAge, balances, loss carryforwards
//       and the IRMAA seed — endAgePrimary is carried unchanged, so
//       every row's march prices quitAge→endAge and every row's
//       ending wealth is valued at the same terminal date
//       (birthYearPrimary + endAgePrimary). endingAfterTaxWealth
//       (taxEngine) is the four ending balances minus the terminal
//       tax on ending pre-tax, evaluated at that terminal age. The
//       roll covers window-start→quitAge, so allInTax (workTax +
//       winner netCost) covers the same full span for every row.
//       The old "different horizons" claim confused span length
//       with terminal date. The retirement-only leg's scenarios
//       likewise all end at endAge, so winnerByEndingWealth was
//       already a same-terminal-date comparison.
//   D14. The retirement-age response carries TWO scoped winner
//       sets (Review 8), not one: retirementOnly (the fixed
//       Do-Nothing-fill comparison, salary ignored) and
//       workYearsComparison (the salary-aware work-years leg).
//       They are reported under comparisonModels, which names what
//       each model prices and whether it searches claiming ages or
//       runs the joint optimizer — it is NOT the Review 4
//       comparisonScope block ("limited"/"full"), which describes
//       the candidate set of the quit-age comparison itself and
//       stays untouched. overallRecommendation comes only from
//       the salary-aware leg, and only when its two objectives
//       agree on one quit age.

import {
  GUARDRAILS_ADJUSTMENT_DEFAULT,
  GUARDRAILS_CUT_DEFAULT,
  GUARDRAILS_RAISE_DEFAULT,
  MONTE_CARLO_TAB_RUNS,
  PHASE_DECLINE_PCT_DEFAULT,
  PHASE_START_AGE_DEFAULT,
  horizonYears,
  runHistorical,
  runMonteCarloAsync,
  runNeverRunsOut,
  simulateDetailed,
  solveMaxSpendingAsync,
  type IncomeStream,
  type SimInputs,
  type SpendingStrategy,
} from "../../server/src/retirementEngines";
import {
  pricePlaygroundYear,
  runDynamicOptimizerAsync,
  runOptimizerAsync,
  runRothCompare,
  harvestGatePasses,
  DO_NOTHING_SPEC,
  type DynamicOptimizerResult,
  type OptimizerCandidateSpec,
  type PlaygroundYearInputs,
  type PlaygroundYearResult,
  type RothCompareBaseSaved,
  type RothCompareCeilingsCents,
  type RothCompareOverrides,
  type RothCompareScenarioResult,
  type ScoredCandidate,
} from "../../server/src/rothOptimizer";
import {
  DRAW_ORDER_OPTIONS,
  DEFAULT_DRAW_ORDER_KEY,
  drawOrderKey,
  drawOrderLabel,
  type DrawOrder,
  type RothPlanInputs,
  type RothYear,
  type StateTaxProvenance,
} from "../../server/src/taxEngine";
import {
  rmdAgeForBirthYear,
  TAX_LAW_YEARS,
  type LawProvenance,
} from "../../server/src/taxLaw";
import {
  runWorkYearsCompareAsync,
  type WorkYearJob,
  type WorkYearsCompareRow,
} from "../../server/src/workYears";
import {
  ENGINE_JOB_TIMEOUT_MS,
  EngineError,
} from "../../server/src/enginePool";
import {
  ADAPTER_VERSION,
  API_CONTRACT_VERSION_REPORTED,
  type AdapterError,
  type AdapterErrorCode,
  type AdapterResponse,
  type AdapterResult,
  type Assumption,
  type Provenance,
} from "./types";
import { publicEffectiveInputs, type NormalizedScenario } from "./normalize";
import {
  ignoredInputsForTool,
  ignoredInputWarning,
  type FinancialToolName,
} from "./pricedInputs";

// ---------------------------------------------------------------------------
// Money + envelope helpers
// ---------------------------------------------------------------------------

/** Engine cents -> API dollars, rounded to 2dp.
 * (Engine Review C6, C6-S2): rejects a non-finite cent amount
 * and any amount whose rounded cents are not a safe integer —
 * a silent NaN / Infinity / off-by-a-cent dollar figure must
 * never reach a caller. Every schema-valid input converts to
 * safe-integer cents, so no valid figure changes. */
export function centsToDollars(cents: number): number {
  if (!Number.isFinite(cents)) {
    throw new Error("centsToDollars: non-finite cent amount");
  }
  const rounded = Math.round(cents);
  if (!Number.isSafeInteger(rounded)) {
    throw new Error(
      "centsToDollars: amount cannot be represented exactly in integer cents",
    );
  }
  return rounded / 100;
}

/** API dollars -> engine cents.
 * (Engine Review C6, C6-S2): rejects a non-finite dollar
 * amount and any amount whose cents are not a safe integer —
 * dollarsToCents(90071992547409.93) previously returned
 * 9007199254740994, one cent above the exact 9007199254740993,
 * with no error. Every schema-valid input converts exactly,
 * so no valid figure changes. */
export function dollarsToCents(dollars: number): number {
  if (!Number.isFinite(dollars)) {
    throw new Error("dollarsToCents: non-finite dollar amount");
  }
  const cents = Math.round(dollars * 100);
  if (!Number.isSafeInteger(cents)) {
    throw new Error(
      "dollarsToCents: amount cannot be represented exactly in integer cents",
    );
  }
  return cents;
}

/** Dollar-native engine figures -> API dollars, rounded to 2dp. */
function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Engine success rate (percent units 0–100) -> API fraction 0–1,
 * at the engine's own precision (D11). The engine's rate is
 * (whole successful runs / runs) * 100, so rounding to the
 * nearest whole run recovers the engine's count exactly; r2 must
 * never be applied to a probability.
 */
export function ratePercentToFraction(
  ratePercent: number,
  runs: number,
): number {
  return Math.round((ratePercent * runs) / 100) / runs;
}

/**
 * Whole successful runs behind an engine success rate, derived
 * from the engine rate × run count (D11). This recovers the
 * engine's own whole-run count — it is not a separately counted
 * value, and it is labeled as derived in the tool docs.
 */
export function successfulRunsFromRate(
  ratePercent: number,
  runs: number,
): number {
  return Math.round((ratePercent * runs) / 100);
}

/**
 * What the solved dollars mean for a spending strategy (D12).
 * The solver's dollars are a starting / base / first-year figure
 * except for constant spending, where they are the fixed amount
 * every year — a reader who treats a percent-strategy result as
 * fixed annual spending will misread the plan.
 */
export function spendingAmountMeaning(strategy: SpendingStrategy): string {
  switch (strategy) {
    case "percent":
      return "Initial-year-equivalent spending: the dollars are the solved first-year spend at the solved percent of the starting portfolio; later years scale with the portfolio balance.";
    case "phased":
      return "Starting spending before the planned reductions: the dollars are the pre-decline amount; later years fall by the phased schedule.";
    case "guardrails":
      return "Base spending: the actual amount may rise or fall on the engine's guardrail triggers.";
    case "constant":
    default:
      return "Fixed annual spending: the same dollar amount in every retired year.";
  }
}

/**
 * Whether any spending level meets the target (D12). The solver
 * reports maxSpendingCents 0 with a below-target rate when even
 * $0 spending fails; a 0 with a rate at/above target is a plan
 * that meets the target only by spending nothing. Anything above
 * $0 passed the target by construction.
 */
export function maxSpendingFeasible(
  maxSpendingCents: number,
  successRatePercent: number,
  targetPercent = 85,
): boolean {
  return maxSpendingCents > 0 || successRatePercent >= targetPercent;
}

/**
 * The engine's max-spending search step, in cents: solveMaxSpending
 * searches in $100 steps (retirementEngines.ts: STEP = 10000).
 */
const MAX_SPENDING_STEP_CENTS = 10000;

/**
 * Whether the percent strategy hit the engine's 30%/yr bound
 * (D12). The bound is a step count, not the number 30: the engine
 * caps the percent search at maxSteps = floor(startCents * 0.3 /
 * STEP) and a capped solve returns exactly maxSteps * STEP dollars
 * with percent = pctFor(maxSteps) = maxSteps * STEP * 100 /
 * startCents. That percent equals 30 only when the starting
 * portfolio is an exact $1,000 multiple — on any other portfolio
 * a capped percent reads slightly below 30 (29.9985… on
 * $1,000,050), so the percent alone never decides it. The
 * detector compares the solved dollars against the bound step
 * count (exact integer arithmetic, no float tolerance) and
 * requires a percent-strategy result (percent !== null): a
 * constant / phased / guardrails solve whose dollars happen to
 * equal the bound step count is not a percent-bound cap. The
 * at-zero-fails return (0 cents, percent 0) is not capped — 0
 * steps is never maxSteps, which is > 0 whenever the solver
 * returns — and an interior binary-search result (fewer steps
 * than maxSteps) is not capped either.
 */
export function maxSpendingCappedAtPercentBound(
  percent: number | null,
  maxSpendingCents: number,
  startCents: number,
): boolean {
  if (percent === null || startCents <= 0) return false;
  const maxSteps = Math.floor(
    (startCents * 0.3) / MAX_SPENDING_STEP_CENTS,
  );
  return (
    maxSteps > 0 &&
    maxSpendingCents / MAX_SPENDING_STEP_CENTS === maxSteps
  );
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

/**
 * Engine failure envelope. The default is the generic
 * engine_error; the pool's typed errors pass their own code
 * plus retryable: true (see guardAsync).
 */
function engineError(
  message: string,
  code: AdapterErrorCode = "engine_error",
  retryable?: boolean,
): AdapterError {
  return {
    ok: false,
    source: "finance-planner-engine",
    adapterVersion: ADAPTER_VERSION,
    apiContractVersion: API_CONTRACT_VERSION_REPORTED,
    error: {
      code,
      message,
      ...(retryable === undefined ? {} : { retryable }),
    },
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
 * Async guard: like guard(), but awaits the body and maps a pool
 * EngineError (ENGINE_TIMEOUT / ENGINE_BUSY / ENGINE_CRASH) to
 * the typed adapter error — same code, retryable, plain-language
 * reason, no stack — instead of collapsing it into engine_error.
 * Any other throw is still the generic engine_error, exactly as
 * the sync guard maps it. The pool re-creates engine validation
 * throws (RangeError et al.) by kind, so those still land here
 * as engine_error, never as an EngineError.
 */
async function guardAsync<T>(
  fn: () => Promise<AdapterResult<T>>,
): Promise<AdapterResult<T>> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof EngineError) {
      return engineError(err.message, err.code, err.retryable);
    }
    return engineError("The engine could not price this scenario.");
  }
}

/**
 * Per-action deadline (Engine Review C7 architecture, §1.5): a
 * job's effective deadline is min(actionDeadline, dispatch +
 * 100 s). Each migrated function captures its start and passes
 * remainingMs() at each dispatch, mirroring the space worker's
 * runRothOptimizer action.
 */
function actionDeadline(): () => number {
  const startedAt = Date.now();
  return () =>
    Math.max(0, ENGINE_JOB_TIMEOUT_MS - (Date.now() - startedAt));
}

/**
 * Shared envelope builder. Never mutates the scenario: assumptions and
 * warnings are copied with adapter additions appended.
 *
 * Review 8 S1: `tool` names the tool answering, so the envelope can
 * report the caller-supplied fields this tool did not price
 * (ignoredInputFields, computed from pricedInputs.ts). Each ignored
 * entry also appears as a warnings[] entry naming the field, the
 * tool, and the tool that does price it. Required essentials are
 * never reported as ignored.
 */
function respond<T>(
  scenario: NormalizedScenario,
  results: T,
  warnings: string[] = [],
  extraAssumptions: Assumption[] = [],
  // D10: the first plan year priced; only the single-year tool
  // passes the year it actually priced (scenario.taxYear).
  taxLawYear: number | null = null,
  tool: FinancialToolName,
): AdapterResult<T> {
  const ignored = ignoredInputsForTool(tool, scenario);
  const response: AdapterResponse<T> = {
    ok: true,
    source: "finance-planner-engine",
    adapterVersion: ADAPTER_VERSION,
    apiContractVersion: API_CONTRACT_VERSION_REPORTED,
    taxLawYear: taxLawYear ?? scenario.startYear,
    effectiveInputs: publicEffectiveInputs(scenario),
    assumptions: [...scenario.assumptions, ...extraAssumptions],
    warnings: [
      ...scenario.warnings,
      ...warnings,
      ...ignored.map(ignoredInputWarning),
    ],
    ignoredInputFields: ignored,
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

/**
 * The premium warning for a tax-aware tool: none when the caller
 * supplied premiums to charge (the v208 term is wired and the
 * year's gross/net premiums ride the results); the
 * supplied-but-included case is warned by normalize (a
 * scenario-level warning, merged into every envelope), and the
 * not-modeled warning otherwise.
 */
function healthPremiumWarnings(scenario: NormalizedScenario): string[] {
  if (scenario.premiumsCharged || scenario.premiumsInSpending) return [];
  return [HEALTH_PREMIUM_WARNING];
}

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
 * The sim engine prices an income SCHEDULE (retirementEngines.ts
 * incomeSchedule): one entry per Social Security stream, each
 * starting in the calendar year its person claims. Claiming ages
 * are per-person, measured against their own birth years — the
 * spouse's claiming age is converted into the primary's age
 * timeline (the timeline the sim loop runs on) through the two
 * birth years: spouseStartOnPrimaryTimeline =
 * ssSpouseStartAge + (birthYearSpouse − birthYearPrimary). A
 * stream with no start age starts at the retirement age, the
 * same rule the single-stream path applied. No positive stream
 * is ever dropped: both benefits are priced by the
 * deterministic, historical, Monte Carlo, success-only, and
 * max-spending paths alike, because they all read the same
 * schedule through incomeCentsAt.
 *
 * The legacy single-stream fields stay populated with the
 * earliest-starting stream — exactly what the old adapter
 * modeled — so any reader that does not know the schedule sees
 * the same values as before; the schedule is what the engine
 * prices, so the two can never double-count.
 */
function simIncomeStreams(scenario: NormalizedScenario): {
  schedule: IncomeStream[];
  extraIncomeCents: number;
  extraIncomeStartAge: number | null;
} {
  const streams: IncomeStream[] = [];
  if (scenario.ssPrimaryAnnual > 0) {
    streams.push({
      amountCents: dollarsToCents(scenario.ssPrimaryAnnual),
      startAge: scenario.ssPrimaryStartAge ?? scenario.retirementAge,
    });
  }
  if (
    scenario.ssSpouseAnnual > 0 &&
    scenario.birthYearSpouse != null
  ) {
    // A missing spouse start age means "starts at retirement":
    // the retirement age is already on the primary timeline, so
    // it needs no birth-year conversion; a given claiming age is
    // the spouse's own age and is converted.
    const startAge =
      scenario.ssSpouseStartAge == null
        ? scenario.retirementAge
        : scenario.ssSpouseStartAge +
          (scenario.birthYearSpouse - scenario.birthYearPrimary);
    streams.push({
      amountCents: dollarsToCents(scenario.ssSpouseAnnual),
      startAge,
    });
  }
  if (streams.length === 0) {
    return { schedule: [], extraIncomeCents: 0, extraIncomeStartAge: null };
  }
  const earliest = [...streams].sort(
    (a, b) => (a.startAge ?? 0) - (b.startAge ?? 0),
  )[0]!;
  return {
    schedule: streams,
    extraIncomeCents: earliest.amountCents,
    extraIncomeStartAge: earliest.startAge,
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
  const income = simIncomeStreams(scenario);
  // Health premiums (Review 3 R3-S1): this portfolio-only
  // simulation prices no premiums. When the caller supplied
  // premiums to charge on top of spending, say so — otherwise
  // the call would silently drop them. (When the caller declared
  // the premiums are already inside monthlySpending, no warning:
  // the simulation funds spending verbatim, so they are in it.)
  if (scenario.premiumsCharged) {
    warnings.push(
      "Health insurance premiums were supplied but this portfolio-only simulation prices none of them — use a tax-aware tool (retirement_compare_strategies, retirement_roth_conversion, retirement_work_years or retirement_tax_year) to include them.",
    );
  }
  const inputs: SimInputs = {
    startCents: scenario.portfolioCents,
    spendingCents: scenario.annualSpendingCents,
    currentAge: scenario.currentAge,
    retirementAge: overrides?.retirementAge ?? scenario.retirementAge,
    endAge: scenario.endAge,
    extraIncomeCents: income.extraIncomeCents,
    extraIncomeStartAge: income.extraIncomeStartAge,
    incomeSchedule:
      income.schedule.length > 0 ? income.schedule : undefined,
    // Optional spending floor (Engine Review 1, E1-S1): null =
    // no floor, and the adequacy rate is null with it.
    minimumAnnualSpendingCents: scenario.minimumAnnualSpendingCents,
    strategy,
    percentOfPortfolio: strategy === "percent" ? 5 : 0,
    guardrailsCutPct: GUARDRAILS_CUT_DEFAULT,
    guardrailsRaisePct: GUARDRAILS_RAISE_DEFAULT,
    guardrailsAdjustmentPct: GUARDRAILS_ADJUSTMENT_DEFAULT,
    phaseStartAge: PHASE_START_AGE_DEFAULT,
    phaseDeclinePct: PHASE_DECLINE_PCT_DEFAULT,
  };
  // E1-S2 (intentional limitation, retained): income starting
  // before retirement is NOT accumulated in the pre-retirement
  // years — this simulation has no pre-retirement spending model,
  // so banking the gross benefit would fabricate savings. Warn
  // whenever a priced stream starts before the retirement age, so
  // the limitation is disclosed on the answer itself, not only in
  // the capability guide. Benefits already being collected in work
  // years belong to retirement_work_years, which prices them with
  // tax and lands the surplus in Taxable.
  const retirementAge = overrides?.retirementAge ?? scenario.retirementAge;
  const earlyStarts = income.schedule
    .map((s) => s.startAge ?? retirementAge)
    .filter((start) => start < retirementAge);
  if (earlyStarts.length > 0) {
    warnings.push(
      "Social Security (or other fixed income) starting before retirement is not accumulated in this simulation: the benefit counts only once retired, so pre-retirement years bank nothing from it. If the benefit is already being collected while still working, use retirement_work_years, which prices those years with tax instead.",
    );
  }
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
export function buildRothCompareBase(
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
    // Engine Review 5: the survivor scenario + first-RMD
    // deferral ride the scenario the caller entered (default:
    // scenario off, no deferral — every existing call prices
    // bit-identically). The spouse's pre-tax balance is $0 in
    // the adapter's model (one pre-tax pool), so the spouse's
    // deferral election names $0 deferred there.
    survivorEnabled: scenario.survivorEnabled,
    survivorWho: scenario.survivorWho,
    survivorDeathYear: scenario.survivorDeathYear,
    survivorClaimAge: scenario.survivorClaimAge,
    firstRmdDeferralPrimary: scenario.firstRmdDeferralPrimary,
    firstRmdDeferralSpouse: scenario.firstRmdDeferralSpouse,
    rothCents: dollarsToCents(scenario.rothDollars),
    // Engine Review C9, Build 2 (W3): the Roth split +
    // primary-owner composition ride the scenario the caller
    // entered (default: all absent — every existing call
    // prices bit-identically). The adapter models a single
    // Roth pool with no per-owner split, so the spouse's
    // composition is NOT represented: the spouse's basis,
    // lots, and clocks stay null, and any Roth draw priced
    // on the spouse's side while its composition is
    // unentered is flagged unknown on the outputs.
    rothIraCents:
      scenario.rothIraDollars == null
        ? null
        : dollarsToCents(scenario.rothIraDollars),
    rothEmployerCents:
      scenario.rothEmployerDollars == null
        ? null
        : dollarsToCents(scenario.rothEmployerDollars),
    rothContributionBasisPrimaryCents:
      scenario.rothContributionBasisDollars == null
        ? null
        : dollarsToCents(scenario.rothContributionBasisDollars),
    rothContributionBasisSpouseCents: null,
    rothConversionLotsPrimary:
      scenario.rothConversionLots == null
        ? null
        : scenario.rothConversionLots.map((l) => ({
            year: l.year,
            taxableAmountCents: dollarsToCents(l.taxableAmount),
            nontaxableAmountCents: dollarsToCents(l.nontaxableAmount),
          })),
    rothConversionLotsSpouse: null,
    firstRothYearPrimary: scenario.firstRothYear,
    firstRothYearSpouse: null,
    firstDesignatedRothYearPrimary: scenario.firstDesignatedRothYear,
    firstDesignatedRothYearSpouse: null,
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
    // IRMAA lookback seed (Engine Review 6, E6-S1): the
    // caller-supplied prior-year returns, in cents — the
    // engine grades the first premium years from these real
    // returns instead of finding no lookback at all. Null =
    // none supplied; the march prices exactly as before.
    irmaaLookbackSeedCents:
      scenario.priorYearMagi == null
        ? null
        : scenario.priorYearMagi.map((e) => ({
            year: e.taxYear,
            magiCents: dollarsToCents(e.magi),
            filingStatus: e.filingStatus,
          })),
    // Health premiums (Review 3 R3-S1): wired only when the
    // caller supplied amounts AND declared spending excludes
    // them (premiumsCharged) — the engine's v208 term then funds
    // the year's actual premium on top of spending. An explicit
    // 0 stays 0 (an entered premium), never null; when the caller
    // declared the premiums are already inside monthlySpending,
    // or supplied none, all three stay null so the term never
    // engages and no premium is charged twice.
    healthPremiumAcaHouseholdCents:
      scenario.premiumsCharged &&
      scenario.healthPremiumAcaHousehold != null
        ? dollarsToCents(scenario.healthPremiumAcaHousehold)
        : null,
    healthPremiumAcaSingleCents:
      scenario.premiumsCharged && scenario.healthPremiumAcaSingle != null
        ? dollarsToCents(scenario.healthPremiumAcaSingle)
        : null,
    healthPremiumMedicarePerPersonCents:
      scenario.premiumsCharged &&
      scenario.healthPremiumMedicarePerPerson != null
        ? dollarsToCents(scenario.healthPremiumMedicarePerPerson)
        : null,
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
export function buildRothPlanInputs(
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
    // Engine Review 5: the survivor scenario + first-RMD
    // deferral ride the scenario the caller entered (default:
    // scenario off, no deferral — every existing call prices
    // bit-identically). The spouse's pre-tax balance is $0 in
    // the adapter's model (one pre-tax pool), so the spouse's
    // deferral election names $0 deferred there.
    survivorEnabled: scenario.survivorEnabled,
    survivorWho: scenario.survivorWho,
    survivorDeathYear: scenario.survivorDeathYear,
    survivorClaimAge: scenario.survivorClaimAge,
    firstRmdDeferralPrimary:
      scenario.firstRmdDeferralPrimary ?? undefined,
    firstRmdDeferralSpouse: scenario.firstRmdDeferralSpouse ?? undefined,
    rothStart: scenario.rothDollars,
    // Engine Review C9, Build 2 (W3): the Roth split +
    // primary-owner composition, same mapping as
    // buildRothCompareBase (spouse unrepresentable — the
    // adapter models a single Roth pool).
    rothIraStart: scenario.rothIraDollars,
    rothEmployerStart: scenario.rothEmployerDollars,
    rothContributionBasisPrimary: scenario.rothContributionBasisDollars,
    rothContributionBasisSpouse: null,
    rothConversionLotsPrimary: scenario.rothConversionLots,
    rothConversionLotsSpouse: null,
    firstRothYearPrimary: scenario.firstRothYear,
    firstRothYearSpouse: null,
    firstDesignatedRothYearPrimary: scenario.firstDesignatedRothYear,
    firstDesignatedRothYearSpouse: null,
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
    // IRMAA lookback seed (Engine Review 6, E6-S1): the
    // caller-supplied prior-year returns, in dollars. The
    // work-years roll merges these UNDER its own priced
    // lines (a priced work year wins its year), so they fill
    // only the years the roll does not price.
    irmaaLookbackSeed:
      scenario.priorYearMagi == null
        ? null
        : scenario.priorYearMagi.map((e) => ({
            year: e.taxYear,
            magi: e.magi,
            filingStatus: e.filingStatus,
          })),
    // Health premiums (Review 3 R3-S1): same rule as the cents
    // base above — wired in dollars only when premiumsCharged.
    healthPremiumAcaHousehold: scenario.premiumsCharged
      ? scenario.healthPremiumAcaHousehold
      : null,
    healthPremiumAcaSingle: scenario.premiumsCharged
      ? scenario.healthPremiumAcaSingle
      : null,
    healthPremiumMedicarePerPerson: scenario.premiumsCharged
      ? scenario.healthPremiumMedicarePerPerson
      : null,
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
  /** Engine draw-order key priced under ("taxable-pretax-roth", …). */
  drawOrder: string;
  /** Engine optimizer candidate key — full-optimizer mode only. */
  candidateKey?: string;
  endingWealth: number;
  lifetimeNetCost: number;
  lifetimeTax: number;
  lifetimeFederalTax: number;
  lifetimeStateTax: number;
  acaCreditKept: number;
  irmaaTotal: number;
  // LOOKBACK + ELIGIBILITY SUMMARIES (Engine Review 6):
  // the premium years whose IRMAA surcharge is UNKNOWN
  // (someone on Medicare, no lookback entry for year − 2 —
  // the $0 in those years is not a computed $0, and
  // irmaaTotal excludes the unknown amounts) and the
  // ACA-priced years under 100% FPL (credit $0 under the
  // standard §36B income test). Both empty on a scenario
  // with complete lookbacks and no below-100% year.
  irmaaLookbackMissingYears: number[];
  acaBelow100FplYears: number[];
  // CLIFF-CAP INOPERATIVE YEARS (Engine Review C9, Build 5
  // NICEs — W5 §3/§6): the ACA years where the cliff cap
  // cannot defend the cliff because mandatory income alone
  // breaches it (see the engine march result's
  // `cliffCapInoperativeYears`). Empty on a scenario with no
  // cliff cap, or where the cap defends every ACA year.
  cliffCapInoperativeYears: number[];
  // EARLY-WITHDRAWAL UNKNOWN YEARS (Engine Review C9,
  // Build 1): the years whose pre-59½ pre-tax spending draw
  // was priced while the drawing owner's Rule-of-55
  // eligibility was unanswered — the $0 penalty in those
  // years is unknown, not computed. Empty on a scenario
  // with no pre-59½ pre-tax draw, or with eligibility
  // answered for every drawing owner.
  earlyWithdrawalUnknownYears: number[];
  // ROTH BASIS UNKNOWN YEARS (Engine Review C9,
  // Build 2 — W3): the years whose Roth spending draw was
  // priced while the drawing owner's Roth basis / clocks
  // were unentered — the $0 income and $0 penalty in
  // those years are unknown, not computed. Empty on a
  // scenario with no Roth draw, or with the composition
  // entered for every drawing owner.
  rothBasisUnknownYears: number[];
  // INTEGRITY (Engine Review C9, Build 3 — W4-GAP-1): the
  // lifetime tax this scenario's balances could not pay
  // (unpaidTax — the engine's lifetimeUnpaidTax, $0 on a
  // solvent plan), the lifetime spending its draws could
  // not fund (spendShortfall), and the E4 verdict on the
  // scenario's own priced march (integrityStatus, with
  // integrityReasons naming the disqualification when
  // invalid). All dollars. A scenario whose status is
  // "invalid" never wins a qualified crown — see
  // winnerQualified / excludedInvalidWinner on the
  // comparisonScope block.
  unpaidTax: number;
  spendShortfall: number;
  integrityStatus: "valid" | "valid-with-benign-residual" | "invalid";
  integrityReasons: string[];
  // Lifetime health premiums (Review 3 R3-S1; $0 when the v208
  // term is not entered): the GROSS premium the score identity
  // adds beside acaCreditKept, and the NET premium actually
  // funded (gross less the credits applied to it).
  lifetimeHealthPremiumGross: number;
  lifetimeHealthPremiumNet: number;
  endingPretax: number;
  endingTaxable: number;
  endingRoth: number;
  endingHsa: number;
  conversionsTotal: number;
  terminalTax: number;
  // First-RMD deferral + survivor-benefit summary (Engine
  // Review 5): the lifetime amount deferred, the lifetime
  // amount deferred from a prior year and paid, the years a
  // deferred amount was paid (the two-RMD years), and the
  // survivor-benefit modeling mode + claiming age of the
  // survivor years (null = no survivor years priced). $0 /
  // [] / null on a plan with no deferral and no survivor
  // scenario.
  rmdDeferral: {
    deferredTotal: number;
    deferredPaidTotal: number;
    twoRmdYears: number[];
    survivorSsMode: "simplified" | "enhanced" | null;
    survivorClaimAge: number | null;
  };
};

/** First-RMD deferral + survivor-benefit summary for one priced
 *  march (Engine Review 5, §7 disclosure): the lifetime amount
 *  deferred, the lifetime amount deferred from a prior year and
 *  paid, the years a deferred amount was paid (the two-RMD
 *  years), and the survivor-benefit modeling mode + claiming age
 *  of the survivor years (null = no survivor years priced).
 *  Rows arrive in dollars (callers convert cents first). */
function rmdSurvivorSummary(
  rows: Array<{
    year: number;
    rmdDeferredPrimary: number;
    rmdDeferredSpouse: number;
    rmdDeferredPaidPrimary: number;
    rmdDeferredPaidSpouse: number;
    survivorSsMode: "simplified" | "enhanced" | null;
    survivorClaimAge: number | null;
  }>,
): {
  deferredTotal: number;
  deferredPaidTotal: number;
  twoRmdYears: number[];
  survivorSsMode: "simplified" | "enhanced" | null;
  survivorClaimAge: number | null;
} {
  let deferredTotal = 0;
  let deferredPaidTotal = 0;
  const twoRmdYears: number[] = [];
  let survivorSsMode: "simplified" | "enhanced" | null = null;
  let survivorClaimAge: number | null = null;
  for (const row of rows) {
    deferredTotal += row.rmdDeferredPrimary + row.rmdDeferredSpouse;
    const paid = row.rmdDeferredPaidPrimary + row.rmdDeferredPaidSpouse;
    deferredPaidTotal += paid;
    if (paid > 0) twoRmdYears.push(row.year);
    if (row.survivorSsMode != null) {
      survivorSsMode = row.survivorSsMode;
      survivorClaimAge = row.survivorClaimAge;
    }
  }
  return {
    deferredTotal: r2(deferredTotal),
    deferredPaidTotal: r2(deferredPaidTotal),
    twoRmdYears,
    survivorSsMode,
    survivorClaimAge,
  };
}

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
    // A null saved key prices as the engine default order
    // (drawOrderFromKey), so the priced order is reported.
    drawOrder: s.saved.drawOrder ?? DEFAULT_DRAW_ORDER_KEY,
    endingWealth: centsToDollars(s.endingAfterTaxWealthCents),
    lifetimeNetCost: centsToDollars(s.netCostCents),
    lifetimeTax: centsToDollars(s.totalTaxCents),
    lifetimeFederalTax: centsToDollars(s.federalTaxCents),
    lifetimeStateTax: centsToDollars(s.stateTaxCents),
    acaCreditKept: centsToDollars(s.acaCreditCents),
    irmaaTotal: centsToDollars(s.irmaaCents),
    irmaaLookbackMissingYears: s.irmaaLookbackMissingYears,
    acaBelow100FplYears: s.acaBelow100FplYears,
    cliffCapInoperativeYears: s.cliffCapInoperativeYears,
    earlyWithdrawalUnknownYears: s.earlyWithdrawalUnknownYears,
    rothBasisUnknownYears: s.rothBasisUnknownYears,
    // (Engine Review C9, Build 3 — W4-GAP-1): the integrity
    // totals are already dollars on the engine verdict — never
    // cents-divided — while unpaidTaxCents is cents, as usual.
    unpaidTax: centsToDollars(s.unpaidTaxCents),
    spendShortfall: s.integrity.spendShortfallTotal,
    integrityStatus: s.integrity.status,
    integrityReasons: s.integrity.reasons,
    lifetimeHealthPremiumGross: centsToDollars(s.healthPremiumCents),
    lifetimeHealthPremiumNet: centsToDollars(s.healthPremiumNetCents),
    endingPretax: centsToDollars(s.endingPretaxCents),
    endingTaxable: centsToDollars(s.endingTaxableCents),
    endingRoth: centsToDollars(s.endingRothCents),
    endingHsa: centsToDollars(s.endingHsaCents),
    conversionsTotal: centsToDollars(conversionsCents),
    terminalTax: centsToDollars(s.terminalCents),
    rmdDeferral: rmdSurvivorSummary(
      s.years.map((y) => ({
        year: y.year,
        rmdDeferredPrimary: centsToDollars(y.rmdDeferredPrimaryCents),
        rmdDeferredSpouse: centsToDollars(y.rmdDeferredSpouseCents),
        rmdDeferredPaidPrimary: centsToDollars(
          y.rmdDeferredPaidPrimaryCents,
        ),
        rmdDeferredPaidSpouse: centsToDollars(
          y.rmdDeferredPaidSpouseCents,
        ),
        survivorSsMode: y.survivorSsMode,
        survivorClaimAge: y.survivorClaimAge,
      })),
    ),
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
  // LOOKBACK AVAILABILITY + ELIGIBILITY (Engine Review 6):
  // whether the year's IRMAA surcharge is KNOWN (false =
  // someone on Medicare, no lookback entry for year − 2, so
  // irmaa is $0 UNKNOWN, not a computed $0) and whether the
  // year's ACA MAGI is under 100% FPL (credit $0 under the
  // standard §36B income test).
  irmaaSurchargeKnown: boolean;
  acaBelow100Fpl: boolean;
  // EARLY-WITHDRAWAL ELIGIBILITY UNKNOWN (Engine Review C9,
  // Build 1): true exactly when this year priced a pre-59½
  // pre-tax spending draw while the drawing owner's Rule-of-55
  // eligibility was unanswered — so the $0 penalty the year
  // shows on that draw is UNKNOWN, not a computed $0.
  earlyWithdrawalEligibilityUnknown: boolean;
  // ROTH BASIS UNKNOWN (Engine Review C9, Build 2 — W3):
  // true exactly when this year priced a Roth spending
  // draw while the drawing owner's Roth basis / clocks
  // were unentered — so the $0 income and $0 penalty the
  // year shows on that draw are UNKNOWN, not computed $0s.
  rothBasisUnknown: boolean;
  // The year's health premiums (Review 3 R3-S1): GROSS premium
  // (marketplace gross + Medicare base for the year's persons
  // on Medicare) and NET premium actually funded (gross less
  // the year's priced premium credit, capped at the marketplace
  // gross). $0 in every year of a plan that does not enter the
  // v208 term.
  healthPremiumGross: number;
  healthPremiumNet: number;
  conversion: number;
  pretaxOutByChoice: number;
  // The year's total Social Security collected (Engine Review
  // 5): both benefits while both spouses live; the survivor's
  // benefit alone in survivor years. Display only.
  ssCollected: number;
  // The year's settled RMDs by owner + first-RMD deferral
  // (Engine Review 5): the amount deferred THIS year and the
  // amount deferred from a prior year PAID this year (part of
  // rmdPrimary / rmdSpouse above); the survivor-benefit
  // modeling mode + claiming age on survivor years (null
  // otherwise). $0 / null on a plan with no deferral and no
  // survivor scenario.
  rmdPrimary: number;
  rmdSpouse: number;
  rmdDeferredPrimary: number;
  rmdDeferredSpouse: number;
  rmdDeferredPaidPrimary: number;
  rmdDeferredPaidSpouse: number;
  survivorSsMode: "simplified" | "enhanced" | null;
  survivorClaimAge: number | null;
  settlementConverged: boolean;
  settlementMismatchGains: number;
  settlementMismatchPretax: number;
  settlementMismatchAcaCredit: number;
  ceilingBreached: boolean;
  // Law + state-tax provenance (Engine Review 3, P3-S1):
  // the law row this year actually priced under, and how its
  // state tax was priced — copied from the underlying year's
  // detail, so a flat-rate stateTax in this table is never
  // shown without its estimate label, and a projection year
  // is never shown as published law for that year.
  lawProvenance: LawProvenance;
  stateTaxProvenance: StateTaxProvenance;
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
    irmaaSurchargeKnown: y.irmaaSurchargeKnown,
    acaBelow100Fpl: y.acaBelow100Fpl,
    earlyWithdrawalEligibilityUnknown: y.earlyWithdrawalEligibilityUnknown,
    rothBasisUnknown: y.rothBasisUnknown,
    healthPremiumGross: centsToDollars(y.healthPremiumGrossCents),
    healthPremiumNet: centsToDollars(y.healthPremiumCents),
    conversion: centsToDollars(y.conversionCents),
    pretaxOutByChoice: centsToDollars(y.pretaxOutByChoiceCents),
    ssCollected: centsToDollars(y.ssCollectedCents),
    rmdPrimary: centsToDollars(y.rmdPrimaryCents),
    rmdSpouse: centsToDollars(y.rmdSpouseCents),
    rmdDeferredPrimary: centsToDollars(y.rmdDeferredPrimaryCents),
    rmdDeferredSpouse: centsToDollars(y.rmdDeferredSpouseCents),
    rmdDeferredPaidPrimary: centsToDollars(y.rmdDeferredPaidPrimaryCents),
    rmdDeferredPaidSpouse: centsToDollars(y.rmdDeferredPaidSpouseCents),
    survivorSsMode: y.survivorSsMode,
    survivorClaimAge: y.survivorClaimAge,
    settlementConverged: y.settlementConverged,
    settlementMismatchGains: centsToDollars(
      y.settlementMismatchCents.gains,
    ),
    settlementMismatchPretax: centsToDollars(
      y.settlementMismatchCents.pretax,
    ),
    settlementMismatchAcaCredit: centsToDollars(
      y.settlementMismatchCents.acaCredit ?? 0,
    ),
    ceilingBreached: y.ceilingBreached,
    lawProvenance: y.lawProvenance,
    stateTaxProvenance: y.stateTaxProvenance,
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
  // (Engine Review C9, Build 3 — W4-GAP-1): the engine's
  // crowning verdict — false exactly when no scenario was
  // valid, with the raw cheapest invalid named beside its
  // integrity reasons (null in the ordinary case).
  winnerQualified: boolean;
  excludedInvalidWinner: {
    name: string;
    reasons: string[];
  } | null;
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
  // (Engine Review C9, Build 3 — W4-GAP-1): the winners come
  // from the ENGINE's crowning (crownCompareWinners in
  // runRothCompare) — valid-only, with the optimizer's
  // tie-breaks — never from a raw min / max over the mapped
  // rows, which would crown an invalid candidate exactly
  // when its $0 figures look cheapest. pickWinner survives
  // below only for the work-years all-in-tax winner, which
  // has no integrity verdict to filter on.
  return {
    ok: true,
    outcome: {
      mapped,
      baseline,
      baselineRaw,
      winnerByEndingWealth: result.winnerByEndingWealth,
      winnerByNetCost: result.winnerByNetCost,
      winnerQualified: result.winnerQualified,
      excludedInvalidWinner:
        result.excludedInvalidWinner == null
          ? null
          : {
              name: result.excludedInvalidWinner.name,
              reasons: result.excludedInvalidWinner.integrity.reasons,
            },
    },
  };
}

/** The unqualified-winner warning for a compare run whose
 *  crowning found no valid candidate (Engine Review C9,
 *  Build 3 — W4-GAP-1, mirroring the optimizer UI copy in
 *  client/src/RothConversion.tsx). Empty when the winner is
 *  qualified — callers spread it into their warnings arrays. */
function unqualifiedWinnerWarning(outcome: CompareOutcome): string[] {
  return outcome.winnerQualified
    ? []
    : ["No tested candidate was fully valid — treat the winner as unqualified."];
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

/**
 * Winner semantics (Review 4: R4-S3). Every strategy comparison
 * carries this block so an AI can tell, from the response alone,
 * what was actually evaluated and what each winner means:
 *
 * - scope "limited": the fixed small comparison (3 withdrawal
 *   orders / 4 conversion fills). A limited winner is the best
 *   OF THOSE FEW — never a global optimum.
 * - scope "full": the engine's whole candidate space for that
 *   tool (all six draw orders; the Roth optimizer's full search
 *   at the entered claiming ages). Even a full search is NOT a
 *   global optimum: claiming ages are held at the entered ages
 *   (the joint claiming-age search is not run) and no Monte
 *   Carlo success check is priced. globalOptimalityClaimed is
 *   therefore false in every mode.
 *
 * Lifetime net cost is the engine's own objective (planNetCost
 * in rothOptimizer.ts): lifetime federal + state tax + pre-59½
 * penalties + IRMAA + terminal tax on ending pre-tax − ACA
 * premium credit kept − refundable education credit (+ net
 * health premium where a premium is entered; $0 here, since
 * the adapter enters none). Lowest lifetime net cost and
 * highest ending after-tax wealth are DIFFERENT objectives and
 * routinely crown different winners — the response names both,
 * and neither is "the" winner without its objective.
 * Ending after-tax wealth is ending pre-tax + taxable + Roth
 * + HSA − terminal tax.
 */
export type ComparisonScopeInfo = {
  scope: "limited" | "full";
  searchKind: "fixed-comparison" | "optimizer-search";
  evaluatedCandidates: number;
  /** Limited: every candidate evaluated. Full: the candidates
   *  returned in `scenarios` (the full set is described by
   *  candidateSetDescription instead of listed). */
  candidateNames: string[];
  candidateSetDescription: string;
  baselineName: string;
  winnerByNetCost: string | null;
  winnerByEndingWealth: string | null;
  // (Engine Review C9, Build 3 — W4-GAP-1): the crowning
  // verdict — false exactly when no candidate was valid, with
  // the raw cheapest invalid named beside its integrity
  // reasons (null in the ordinary case). The unqualified
  // warning beside it rides the response warnings array.
  winnerQualified: boolean;
  excludedInvalidWinner: {
    name: string;
    reasons: string[];
  } | null;
  globalOptimalityClaimed: false;
  netCostObjective: string;
  wealthObjective: string;
  tieBreakPolicy: string;
  excludedCandidateFamilies: string[];
  omittedCosts: string[];
};

/**
 * One scoped model inside a retirement-age comparison (Review 8,
 * D12). Distinct from ComparisonScopeInfo above: that block
 * describes the candidate set of the quit-age comparison itself
 * ("limited"/"full"); this one says what a model prices — salary,
 * work-year contributions, payroll tax — and whether it runs the
 * joint optimizer or searches claiming ages. The retirement-only
 * model prices fixed Do-Nothing-fill scenarios at the entered
 * claiming ages; the salary-aware model prices each quit age's
 * rolled plan with the joint optimizer, which searches claiming
 * ages and conversion strategies FOR THAT QUIT AGE ALONE — the
 * quit-age comparison itself runs no optimizer search across
 * conversion strategies.
 */
export type ComparisonModelInfo = {
  includesSalary: boolean;
  includesWorkYearContributions: boolean;
  includesWorkYearPayrollTaxes: boolean;
  usesFullOptimizer: boolean;
  ssClaimingAgesSearched: boolean;
  objective: string;
  description: string;
};

const NET_COST_OBJECTIVE =
  "Lowest lifetime net cost: lifetime federal + state tax + pre-59½ penalties + IRMAA + terminal tax on ending pre-tax, minus ACA premium credit kept and refundable education credit (plus gross health premium where a premium is entered; the adapter enters none, so $0).";
const WEALTH_OBJECTIVE =
  "Highest ending after-tax wealth: ending pre-tax + taxable + Roth + HSA balances, minus terminal tax on ending pre-tax.";
const OMITTED_COSTS = [
  "Health insurance premiums are not priced — only the ACA premium credit and IRMAA surcharge.",
  "This is deterministic tax-aware pricing, not a Monte Carlo retirement-success optimization: no success probability is computed here.",
  "Forced required minimum distributions come out of pre-tax first under every draw order; the order governs discretionary spending draws only.",
];

const LIMITED_TIE_BREAK =
  "Exact ties on the deciding figure keep the earliest scenario in the evaluated list order (the engine's canonical draw-order list for withdrawals; the fixed list order for the limited Roth comparison).";
const WORK_YEARS_TIE_BREAK =
  "Exact ties on the deciding figure keep the earliest quit age in the evaluated list order (the sorted compareAges order).";
const OPTIMIZER_TIE_BREAK =
  "Exact ties follow the engine's own winner ordering (compareScoredCandidates): lowest net cost, then highest ending after-tax wealth, then Do Nothing, then the plan's own draw order, then candidate key.";

function buildComparisonScope(
  opts: Omit<ComparisonScopeInfo, "globalOptimalityClaimed" | "netCostObjective" | "wealthObjective" | "omittedCosts">,
): ComparisonScopeInfo {
  return {
    ...opts,
    globalOptimalityClaimed: false,
    netCostObjective: NET_COST_OBJECTIVE,
    wealthObjective: WEALTH_OBJECTIVE,
    omittedCosts: OMITTED_COSTS,
  };
}

/** Friendly names for the engine's six canonical draw orders
 *  (DRAW_ORDER_OPTIONS in taxEngine.ts, in canonical order).
 *  The three the limited comparison already used keep their
 *  established names. */
export const DRAW_ORDER_NAMES: Record<string, string> = {
  "taxable-pretax-roth": "taxable-first",
  "taxable-roth-pretax": "taxable-roth-first",
  "pretax-taxable-roth": "pre-tax-first",
  "pretax-roth-taxable": "pre-tax-roth-first",
  "roth-taxable-pretax": "roth-first",
  "roth-pretax-taxable": "roth-pre-tax-first",
};

// ---------------------------------------------------------------------------
// Full Roth optimizer mapping (scoreAllCandidates / runOptimizer)
// ---------------------------------------------------------------------------

/**
 * Display name for one optimizer candidate: the engine's strategy
 * name, plus the variant flags the name does not carry
 * (guardrail / bunching), the conversion window, and the draw
 * order — jointly unique per candidate key, so winner fields
 * name exactly one candidate.
 */
export function optimizerCandidateDisplayName(spec: OptimizerCandidateSpec): string {
  const parts = [spec.name];
  if (spec.guardrail) parts.push("marginal-rate guardrail");
  if (spec.bunching) parts.push("ACA bunching");
  parts.push(spec.windowLabel);
  parts.push(`draw order ${drawOrderLabel(spec.drawOrder)}`);
  return parts.join(" · ");
}

/** One scored optimizer candidate mapped onto the shared compare shape. */
function mapScoredCandidate(
  s: ScoredCandidate,
  retirementAge: number,
): MappedCompareScenario {
  const conversionsTotal = s.result.years.reduce(
    (sum, y) => sum + y.conversion,
    0,
  );
  return {
    name: optimizerCandidateDisplayName(s.spec),
    strategyDescription: `Retire at ${retirementAge} · ${optimizerCandidateDisplayName(s.spec)}`,
    drawOrder: drawOrderKey(s.spec.drawOrder),
    candidateKey: s.spec.key,
    endingWealth: r2(s.result.endingAfterTaxWealth),
    lifetimeNetCost: r2(s.cost.netCost),
    lifetimeTax: r2(s.cost.tax),
    lifetimeFederalTax: r2(s.result.lifetimeFederalTax),
    lifetimeStateTax: r2(s.result.lifetimeStateTax),
    acaCreditKept: r2(s.cost.acaCredit),
    irmaaTotal: r2(s.cost.irmaa),
    irmaaLookbackMissingYears: s.result.irmaaLookbackMissingYears,
    acaBelow100FplYears: s.result.acaBelow100FplYears,
    cliffCapInoperativeYears: s.result.cliffCapInoperativeYears,
    earlyWithdrawalUnknownYears: s.result.earlyWithdrawalUnknownYears,
    rothBasisUnknownYears: s.result.rothBasisUnknownYears,
    // (Engine Review C9, Build 3 — W4-GAP-1): same four fields
    // as the compare path, off the scored candidate's own
    // assessment. A stub without an assessment (no verdict
    // exists) reads as valid with no reasons — the E6 rule
    // that a candidate with no assessment is never excluded
    // as invalid; real candidates always carry one.
    unpaidTax: r2(s.result.lifetimeUnpaidTax),
    spendShortfall: s.integrity?.spendShortfallTotal ?? 0,
    integrityStatus: s.integrity?.status ?? "valid",
    integrityReasons: s.integrity?.reasons ?? [],
    lifetimeHealthPremiumGross: r2(s.result.lifetimeHealthPremiumGross),
    lifetimeHealthPremiumNet: r2(s.result.lifetimeHealthPremiumNet),
    endingPretax: r2(s.result.endingPretax),
    endingTaxable: r2(s.result.endingTaxable),
    endingRoth: r2(s.result.endingRoth),
    endingHsa: r2(s.result.endingHsa),
    conversionsTotal: r2(conversionsTotal),
    terminalTax: r2(s.cost.terminal),
    rmdDeferral: rmdSurvivorSummary(
      s.result.years.map((y) => ({
        year: y.year,
        rmdDeferredPrimary: y.detail.rmdDeferredPrimary,
        rmdDeferredSpouse: y.detail.rmdDeferredSpouse,
        rmdDeferredPaidPrimary: y.detail.rmdDeferredPaidPrimary,
        rmdDeferredPaidSpouse: y.detail.rmdDeferredPaidSpouse,
        survivorSsMode: y.detail.survivorSsMode,
        survivorClaimAge: y.detail.survivorClaimAge,
      })),
    ),
  };
}

/** Yearly conversion amounts for one scored candidate (nonzero years only). */
function yearlyConversions(s: ScoredCandidate): Array<{
  year: number;
  agePrimary: number;
  conversion: number;
}> {
  return s.result.years
    .filter((y) => y.conversion > 0)
    .map((y) => ({
      year: y.year,
      agePrimary: y.agePrimary,
      conversion: r2(y.conversion),
    }));
}

/**
 * Down-sampled yearly table from a priced march's own RothYear rows
 * (dollars). Same columns as the compare yearly table; the
 * pre-tax-out-by-choice column follows the compare's own rule
 * (conversion + the year's pre-tax spending draw). Capped at 60 rows.
 */
function yearlyTableFromRothYears(years: RothYear[]): YearlyCompareRow[] {
  const rows = years.map((y) => ({
    year: y.year,
    agePrimary: y.agePrimary,
    ageSpouse: y.ageSpouse,
    federalTax: r2(y.federalTax),
    stateTax: r2(y.stateTax),
    penalty: r2(y.penalty),
    agi: r2(y.agi),
    taxableIncome: r2(y.taxableIncome),
    acaCredit: r2(y.acaCreditKept),
    irmaa: r2(y.irmaaPaid),
    irmaaSurchargeKnown: y.irmaaSurchargeKnown,
    acaBelow100Fpl: y.acaBelow100Fpl,
    earlyWithdrawalEligibilityUnknown: y.earlyWithdrawalEligibilityUnknown,
    rothBasisUnknown: y.rothBasisUnknown,
    healthPremiumGross: r2(y.healthPremiumGross),
    healthPremiumNet: r2(y.healthPremiumNet),
    conversion: r2(y.conversion),
    pretaxOutByChoice: r2(y.conversion + y.detail.pretaxSpendingDraw),
    ssCollected: r2(y.ssBenefits),
    rmdPrimary: r2(y.detail.rmdPrimary),
    rmdSpouse: r2(y.detail.rmdSpouse),
    rmdDeferredPrimary: r2(y.detail.rmdDeferredPrimary),
    rmdDeferredSpouse: r2(y.detail.rmdDeferredSpouse),
    rmdDeferredPaidPrimary: r2(y.detail.rmdDeferredPaidPrimary),
    rmdDeferredPaidSpouse: r2(y.detail.rmdDeferredPaidSpouse),
    survivorSsMode: y.detail.survivorSsMode,
    survivorClaimAge: y.detail.survivorClaimAge,
    settlementConverged: y.settlementConverged,
    settlementMismatchGains: centsToDollars(y.settlementMismatchCents.gains),
    settlementMismatchPretax: centsToDollars(
      y.settlementMismatchCents.pretax,
    ),
    settlementMismatchAcaCredit: centsToDollars(
      y.settlementMismatchCents.acaCredit ?? 0,
    ),
    ceilingBreached: y.ceilingBreached,
    lawProvenance: y.detail.lawProvenance,
    stateTaxProvenance: y.detail.stateTaxProvenance,
  }));
  if (rows.length <= 60) return rows;
  const stride = Math.ceil(rows.length / 60);
  const picked: YearlyCompareRow[] = [];
  for (let i = 0; i < rows.length; i += stride) picked.push(rows[i]!);
  const last = rows[rows.length - 1]!;
  if (picked[picked.length - 1] !== last) picked.push(last);
  return picked;
}

const YEARLY_TABLE_WARNING =
  "The per-year table uses the compare's own yearly rows, which carry tax, credit, IRMAA, health premiums, conversion, and settlement flags but not spending or per-year ending balances; lifetime ending balances are in each scenario's summary. Each row also names the law row it priced under (lawProvenance) and how its state tax was priced (stateTaxProvenance): a flat-rate stateTax is an estimate only — the caller-supplied rate on federal taxable income — never an exact state tax return, and a year past the newest published law row prices on that row carried forward, a projection.";

const WORK_YEARS_COMPARABILITY_NOTE =
  "Work-years rows are comparable across quit ages: every row is valued at the same terminal age (the plan end age) from the same starting balances — the roll covers the window start through the quit age and the priced plan covers the quit age through the terminal age — so ending after-tax wealth is valued at the same date for every row, and all-in tax covers the same full span (window start through the terminal age) for every row. The retirement-only winners ignore salary, employer contributions, and payroll tax; use the salary-aware winners for the work-longer decision.";

const MEDICARE_NO_ENROLLMENT_WARNING =
  "No Medicare enrollment age was provided, so no Medicare enrollment is modeled during the work years: HSA contributions (employee and employer) continue through the work years. Medicare eligibility at 65 is not enrollment — pass medicareAgePrimary to model enrollment.";

// Review 8 NICEs (P3-1): the no-enrollment disclosure when the
// salary leg prices zero HSA — the "contributions continue"
// clause is dropped because there are no contributions to
// continue; the no-enrollment disclosure itself is kept.
const MEDICARE_NO_ENROLLMENT_NO_HSA_WARNING =
  "No Medicare enrollment age was provided, so no Medicare enrollment is modeled during the work years. Medicare eligibility at 65 is not enrollment — pass medicareAgePrimary to model enrollment.";

// Engine Review 6 (E6-S1/E6-S2): warnings that keep a missing
// IRMAA lookback and a below-100%-FPL ACA year from reading
// as a verified $0. A missing lookback means the surcharge is
// UNKNOWN — the year's $0 and the scenario's lifetime IRMAA
// and net cost exclude amounts the engine could not price —
// and a below-100% year means the $0 credit is the standard
// §36B income test, not a modeled exception. Both are also
// carried as structured fields on the scenario (the
// irmaaLookbackMissingYears / acaBelow100FplYears lists) and
// on each yearly row (irmaaSurchargeKnown / acaBelow100Fpl),
// so an AI can read them without parsing this text. The
// per-year detail.aca.eligibilityNote carries the law-year
// specific note (OBBBA §71302 repeal for 2026+; the
// pre-OBBBA §36B(c)(1)(B) exception unmodeled for 2025).
// (Engine Review C9, Build 5 NICEs — W5 §3/§6): the same
// function also warns when the cliff cap is inoperative in a
// year — mandatory income alone breaches the cliff, so the
// $0 credit there is priced, not a choice to forfeit it —
// carried as the cliffCapInoperativeYears list on the
// scenario.
function irmaaAcaCompareWarnings(
  scenarios: Array<{
    name: string;
    irmaaLookbackMissingYears: number[];
    acaBelow100FplYears: number[];
    cliffCapInoperativeYears: number[];
    earlyWithdrawalUnknownYears: number[];
    rothBasisUnknownYears: number[];
  }>,
): string[] {
  const out: string[] = [];
  for (const m of scenarios) {
    if (m.irmaaLookbackMissingYears.length > 0) {
      const years = m.irmaaLookbackMissingYears.join(", ");
      const lookbacks = m.irmaaLookbackMissingYears
        .map((y) => y - 2)
        .join(", ");
      out.push(
        `IRMAA is unknown, not $0, for ${m.name} in ${years}: no MAGI is on record for the two-year lookback year(s) ${lookbacks}, so the $0 surcharge shown for those years is an unavailable computation — the scenario's lifetime IRMAA and net cost exclude the unknown amounts. Supply priorYearMagi entries for ${lookbacks} to price them.`,
      );
    }
    if (m.acaBelow100FplYears.length > 0) {
      const years = m.acaBelow100FplYears.join(", ");
      // "Is $0" stands here, not "would be $0": the compare
      // yearly rows carry acaCredit as a PRICED number (0 for
      // these years), never null — the null-credit case lives
      // only in the single-year tax tool (whose response echoes
      // the priced year verbatim with aca.credit null when no
      // benchmark was entered) and the Playground block, both
      // fixed to say "would be $0" when the credit is null.
      out.push(
        `ACA credit is $0 for ${m.name} in ${years} because household MAGI is under 100% of the federal poverty level — the standard §36B income test. No exception is modeled, and Medicaid eligibility is not modeled either, so do not read the $0 as a coverage decision.`,
      );
    }
    if (m.cliffCapInoperativeYears.length > 0) {
      const years = m.cliffCapInoperativeYears.join(", ");
      out.push(
        `ACA cliff cap is inoperative for ${m.name} in ${years}: mandatory income alone exceeds the cliff even with no conversion and no pre-tax spending draw, so the cap cannot defend the cliff and the credit is $0 in those years. The $0 credit is priced, not missing — do not read those years as a choice to forfeit the credit, and do not expect a different draw order to recover it unless the funding mix itself removes the gains (funding from Roth instead of taxable sales).`,
      );
    }
    if (m.earlyWithdrawalUnknownYears.length > 0) {
      const years = m.earlyWithdrawalUnknownYears.join(", ");
      // Qualified to the SPENDING draw (C9 Build 1 fix 1 —
      // SHOULD 1): the flag names the penalty on the pre-tax
      // spending draw only. A year on this list can ALSO price
      // a conversion-withholding penalty — priced separately,
      // on the conversion owner's age — so the sentence must
      // never read as if the year's whole penalty were $0.
      out.push(
        `Early-withdrawal penalty on the pre-tax spending draw is $0 but UNKNOWN for ${m.name} in ${years}: a pre-59½ pre-tax spending draw was priced while that owner's Rule-of-55 eligibility was not entered, so the $0 on that draw is an unanswered question, not a computed $0 — the real §72(t) penalty on the draw depends on how much of it came from an eligible employer plan. A conversion-withholding penalty in the same year, if any, is priced separately and is NOT part of this $0. Enter the eligible balance and separation age to price it.`,
      );
    }
    if (m.rothBasisUnknownYears.length > 0) {
      const years = m.rothBasisUnknownYears.join(", ");
      out.push(
        `Roth income and penalty are $0 but UNKNOWN for ${m.name} in ${years}: a Roth spending draw was priced while that owner's Roth basis / clocks were not entered, so the $0 income and $0 penalty on that draw are unanswered questions, not computed $0s — the real tax depends on how much of the draw came from contributions (free), prior conversions (10% §72(t) penalty when under 59½ and inside 5 years), and earnings (ordinary income, plus 10% when under 59½, unless the distribution is qualified). Enter the Roth contribution basis, conversion lots, and first Roth year to price it.`,
      );
    }
  }
  return out;
}
// Work-years state-tax note (Engine Review 3, P3-S1): the
// work-years rows are per-quit-age aggregates over several
// salary years, so no single law row / state-tax kind can
// describe one — each salary year carries its own
// lawYearUsed / lawStatus / stateTaxKind in the engine's
// roll, and a quit-age row spans exact and carried-forward
// years at once. The response-level note below is the label
// instead: the state tax inside workTax / totalTax /
// allInTax is the flat-rate estimate — or, for a Washington household,
// the Washington capital-gains excise where a deficit-funding Taxable
// sale prices under RCW 82.87 — never an exact state return, and salary
// years past the newest published law row price on that row carried
// forward, a projection. The retirement years' per-year provenance is
// in this response's yearly table; the salary years' per-year
// provenance is not in this response.
const WORK_YEARS_STATE_TAX_NOTE =
  "Work-years tax totals (workTax, totalTax, allInTax) include flat-rate state tax: an estimate only — the caller-supplied rate on federal taxable income — never an exact state tax return; for a Washington household the totals may instead include a Washington capital-gains excise slice (RCW 82.87) from a deficit-funding Taxable sale. Salary years past the newest published law row price on that row carried forward, a projection; see the yearly table in this response for the retirement years' per-year lawProvenance and stateTaxProvenance — the salary years' per-year provenance is not in this response.";

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
  historicalRuns: number | null;
  historicalSuccessfulRuns: number | null;
  historicalMedianEnding: number | null;
  // Spending adequacy (E1-S1): the share of historical runs in
  // which every retired year's GROSS spending met or beat the
  // minimum-annual-spending floor — null when no floor was set.
  // Read beside historicalNeverOutRate, never instead of it: a
  // high funding rate is not proof spending held the floor.
  historicalSpendingAdequacyRate: number | null;
  // The floor the adequacy rate is measured against, $/yr — null
  // when no floor was set.
  minimumAnnualSpending: number | null;
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
    if (
      scenario.minimumAnnualSpendingCents != null &&
      scenario.strategy === "constant" &&
      // E1 NICE: the warning's premise ("adequacy reads 100%") holds
      // only when the floor is at or below yearly spending; above it
      // adequacy reads 0%, not 100%, so the warning must not fire.
      scenario.minimumAnnualSpendingCents <= scenario.annualSpendingCents
    ) {
      warnings.push(
        "Spending adequacy is measured on gross spending, and constant spending never varies — so with the floor at or below yearly spending, adequacy reads 100% even in runs where withdrawals went unfunded. Read it beside the funding rate, never instead of it.",
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
        // D11: whole-run precision from the historical run count,
        // never r2 — plus the derived whole-run count behind it.
        historicalNeverOutRate:
          hist === null
            ? null
            : ratePercentToFraction(hist.neverOutSuccessRate, hist.count),
        historicalRuns: hist === null ? null : hist.count,
        historicalSuccessfulRuns:
          hist === null
            ? null
            : successfulRunsFromRate(hist.neverOutSuccessRate, hist.count),
        historicalMedianEnding:
          hist === null ? null : centsToDollars(hist.medianEnding),
        historicalSpendingAdequacyRate:
          hist === null || hist.spendingAdequacySuccessRate === null
            ? null
            : // Exact, not rounded to two decimals: r2 would collapse
              // 99.5–99.9% to 1.0 and erase the funding-vs-adequacy
              // distinction the rate exists to preserve (Engine
              // Review 1, pass 2 SHOULD-1). The engine returns the
              // exact share (adequate / counted × 100).
              hist.spendingAdequacySuccessRate / 100,
        minimumAnnualSpending:
          scenario.minimumAnnualSpendingCents == null
            ? null
            : centsToDollars(scenario.minimumAnnualSpendingCents),
      },
      warnings,
      [],
      null,
      "retirement_calculate",
    );
  });
}

// ---------------------------------------------------------------------------
// 2. Monte Carlo
// ---------------------------------------------------------------------------

export async function runRetirementMonteCarlo(
  scenario: NormalizedScenario,
): Promise<
  AdapterResult<{
    successRate: number;
    successfulRuns: number;
    endingP10: number;
    endingP50: number;
    endingP90: number;
    lowestSpending: number | null;
    averageSpending: number | null;
    medianFinalYearSpending: number | null;
    medianFirstRetiredYearSpending: number | null;
    // Spending adequacy (E1-S1): the share of runs in which every
    // retired year's GROSS spending met or beat the
    // minimum-annual-spending floor — null when no floor was set.
    // Read beside successRate, never instead of it: a high
    // funding-success rate is not proof spending held the floor.
    spendingAdequacyRate: number | null;
    // The floor the adequacy rate is measured against, $/yr — null
    // when no floor was set.
    minimumAnnualSpending: number | null;
    runs: number;
    seed: number;
    chart: Array<{ age: number; median: number; p10: number; p90: number }>;
    deterministicEndingBalance: number;
  }>
> {
  return guardAsync(async () => {
    const remainingMs = actionDeadline();
    const { inputs, warnings } = toSimInputs(scenario);
    // D1: the engine takes decimals, not percents. The Monte
    // Carlo leg runs in the worker pool (SMALL lane, §1.2), so a
    // 5,000-run call no longer blocks the request thread; the
    // deterministic cross-check beside it stays in-thread (~ms).
    const mc = await runMonteCarloAsync(
      inputs,
      scenario.expectedReturnPct / 100,
      scenario.volatilityPct / 100,
      scenario.mcSeed,
      scenario.mcRuns,
      { timeoutMs: remainingMs() },
    );
    if (mc === null) {
      return engineError(
        "Monte Carlo could not price this horizon (the plan end age is at or before the current age).",
      );
    }
    const det = simulateDetailed(inputs, flatReturns(scenario));
    const detEnding = centsToDollars(det.balances[det.balances.length - 1] ?? 0);
    // D11: whole-run precision over the caller's mcRuns, never r2.
    const successRate = ratePercentToFraction(
      mc.neverOutSuccessRate,
      scenario.mcRuns,
    );
    const successfulRuns = successfulRunsFromRate(
      mc.neverOutSuccessRate,
      scenario.mcRuns,
    );
    const detRunsOut = detEnding === 0;
    const mcMostlySucceeds = successRate >= 0.5;
    if (
      scenario.minimumAnnualSpendingCents != null &&
      scenario.strategy === "constant" &&
      // E1 NICE: the warning's premise ("adequacy reads 100%") holds
      // only when the floor is at or below yearly spending; above it
      // adequacy reads 0%, not 100%, so the warning must not fire.
      scenario.minimumAnnualSpendingCents <= scenario.annualSpendingCents
    ) {
      warnings.push(
        "Spending adequacy is measured on gross spending, and constant spending never varies — so with the floor at or below yearly spending, adequacy reads 100% even in runs where withdrawals went unfunded. Read it beside the funding rate, never instead of it.",
      );
    }
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
        successfulRuns,
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
        spendingAdequacyRate:
          mc.spendingAdequacySuccessRate === null
            ? null
            : // Exact, not rounded to two decimals: r2 would collapse
              // 99.5–99.9% to 1.0 and erase the funding-vs-adequacy
              // distinction the rate exists to preserve (Engine
              // Review 1, pass 2 SHOULD-1). The engine returns the
              // exact share (adequate / counted × 100).
              mc.spendingAdequacySuccessRate / 100,
        minimumAnnualSpending:
          scenario.minimumAnnualSpendingCents == null
            ? null
            : centsToDollars(scenario.minimumAnnualSpendingCents),
        runs: scenario.mcRuns,
        seed: scenario.mcSeed,
        chart,
        deterministicEndingBalance: detEnding,
      },
      warnings,
      [],
      null,
      "retirement_monte_carlo",
    );
  });
}

// ---------------------------------------------------------------------------
// 3. Max sustainable spending (Monte Carlo target + historical cross-check)
// ---------------------------------------------------------------------------

export async function calculateMaxSpending(
  scenario: NormalizedScenario,
): Promise<
  AdapterResult<{
    maxMonthlySpending: number;
    maxAnnualSpending: number;
    successRate: number;
    successfulRuns: number;
    medianEnding: number;
    approximate: boolean;
    runs: number;
    targetSuccessRate: number;
    spendingStrategy: string;
    spendingAmountMeaning: string;
    seed: number;
    feasible: boolean;
    solvedPortfolioWithdrawalPct: number | null;
    cappedAtPercentBound: boolean;
    historicalMaxMonthlySpending: number | null;
    historicalMaxAnnualSpending: number | null;
  // Feasibility metadata (Engine Review 2, E2-S1): rates here are
  // 0–1 fractions, like successRate above — targetSuccessRate is
  // the 85% target (0.85), achievedSuccessRate mirrors
  // successRate, targetAchieved says whether the returned
  // spending actually meets the target, and solutionStatus names
  // which case the answer is ("feasible" | "feasible_at_zero" |
  // "infeasible_at_zero" | "capped"). A maxAnnualSpending of 0
  // with solutionStatus "infeasible_at_zero" means NO spending
  // level reaches the target — $0 is not a sustainable spending
  // there; with "feasible_at_zero" $0 IS the highest sustainable
  // spending; with "capped" the figure is the solver's search cap
  // (the percent leg's 30% cap, or twice the portfolio floored at
  // $1,000,000/yr), not a proven maximum above it. The historical
  // cross-check leg carries its own status the same way.
  achievedSuccessRate: number;
  targetAchieved: boolean;
  solutionStatus: "feasible" | "feasible_at_zero" | "infeasible_at_zero" | "capped";
  historicalTargetAchieved: boolean | null;
  historicalSolutionStatus:
    | "feasible"
    | "feasible_at_zero"
    | "infeasible_at_zero"
    | "capped"
    | null;
  historicalRuns: number | null;
  historicalSuccessfulRuns: number | null;
  historicalSolvedPortfolioWithdrawalPct: number | null;
  historicalCappedAtPercentBound: boolean;
  }>
> {
  return guardAsync(async () => {
    const remainingMs = actionDeadline();
    const { inputs, warnings } = toSimInputs(scenario);
    const expected = scenario.expectedReturnPct / 100;
    const vol = scenario.volatilityPct / 100;
    // D2: the engine's target is percent units (0-100). Both
    // solver legs run in the worker pool (SMALL lane, §1.2) — the
    // Monte Carlo leg first, the historical cross-check after it
    // (its null short-circuit above is preserved: a null Monte
    // Carlo solve answers unsupported without pricing the
    // historical leg). Each leg dispatches with the action's
    // remaining budget (§1.5).
    const solved = await solveMaxSpendingAsync(
      inputs,
      scenario.stocksPct,
      expected,
      vol,
      "montecarlo",
      85,
      scenario.mcSeed,
      { timeoutMs: remainingMs() },
    );
    if (solved === null) {
      return unsupported(
        "No sustainable spending could be solved for these ages (retirement at/after the plan end age, or no retired years)",
      );
    }
    if (!solved.targetAchieved) {
      // Unreachable at the hardcoded 85% target through validated
      // inputs (at $0 every run succeeds), but the response must
      // never let a $0 read as meeting the target if it ever
      // arises: say so in words, not just in the status field.
      warnings.push(
        `No spending level reaches the 85% target — even $0/yr falls short at ${(Math.round(solved.successRate * 10) / 10).toFixed(1)}% success. The reported $0 maximum is not a sustainable spending level.`,
      );
    }
    const histSolved = await solveMaxSpendingAsync(
      inputs,
      scenario.stocksPct,
      expected,
      vol,
      "historical",
      85,
      scenario.mcSeed,
      { timeoutMs: remainingMs() },
    );
    const maxAnnual = centsToDollars(solved.maxSpendingCents);
    const histAnnual =
      histSolved === null ? null : centsToDollars(histSolved.maxSpendingCents);
    // D11: the historical leg's run count comes from the same
    // historical engine the solver scored on, so its rate converts
    // at whole-run precision too. (Null exactly when histSolved
    // is null: the solver's historical leg returns null only when
    // runHistorical does.)
    const histRuns =
      histSolved === null
        ? null
        : runHistorical(inputs, scenario.stocksPct)?.count ?? null;
    // D12: feasibility and the percent-strategy cap are the
    // solver's own verdicts, reported verbatim — never inferred.
    // The cap is detected from the solved dollars against the
    // engine's bound step count (see
    // maxSpendingCappedAtPercentBound), not from the percent
    // reading 30.
    const feasible = maxSpendingFeasible(
      solved.maxSpendingCents,
      solved.successRate,
    );
    const cappedAtPercentBound = maxSpendingCappedAtPercentBound(
      solved.percent,
      solved.maxSpendingCents,
      inputs.startCents,
    );
    // SHOULD-1: the historical leg gets the same bound flag,
    // detected the same way from its own solve. The same engine
    // function produces both legs from the same inputs, so a
    // capped historical leg is the same capped result, not a
    // true maximum either; a null historical solve has no cap
    // to report.
    const historicalCappedAtPercentBound =
      histSolved === null
        ? false
        : maxSpendingCappedAtPercentBound(
            histSolved.percent,
            histSolved.maxSpendingCents,
            inputs.startCents,
          );
    if (!feasible) {
      warnings.push(
        "No spending level meets the 85% success target — not even $0/year. The plan cannot reach 85% success at any spending under these assumptions (seed, 1,000 simulations, model assumptions).",
      );
    }
    if (cappedAtPercentBound) {
      warnings.push(
        "The percent strategy hit the engine's 30%/yr withdrawal bound: this is a capped result, not a true maximum — the solver stopped at the bound, not at a spending the plan fails above.",
      );
    }
    if (historicalCappedAtPercentBound) {
      warnings.push(
        "The percent strategy's historical leg also hit the engine's 30%/yr withdrawal bound: its maximum is a capped result, not a true maximum — the historical solver stopped at the bound, not at a spending the plan fails above.",
      );
    }
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
        // D11: whole-run precision over the solver's fixed 1,000
        // runs, never r2 — plus the derived whole-run count.
        successRate: ratePercentToFraction(
          solved.successRate,
          MONTE_CARLO_TAB_RUNS,
        ),
        successfulRuns: successfulRunsFromRate(
          solved.successRate,
          MONTE_CARLO_TAB_RUNS,
        ),
        medianEnding: centsToDollars(solved.medianEnding),
        approximate: solved.approximate,
        // D9: the solver's fixed run count, not the caller's mcRuns.
        runs: MONTE_CARLO_TAB_RUNS,
        // D2/D12: the target in the API's 0–1 units, the strategy
        // as priced, what the solved dollars mean for it, and the
        // seed the Monte Carlo leg ran on.
        targetSuccessRate: 0.85,
        spendingStrategy: inputs.strategy,
        spendingAmountMeaning: spendingAmountMeaning(inputs.strategy),
        seed: scenario.mcSeed,
        feasible,
        // D12: the solver's own percent, verbatim (a number only
        // for the percent strategy; null otherwise) — and whether
        // each leg stopped at the engine's 30%/yr bound.
        solvedPortfolioWithdrawalPct: solved.percent,
        cappedAtPercentBound,
        historicalMaxMonthlySpending:
          histAnnual === null ? null : r2(histAnnual / 12),
        historicalMaxAnnualSpending: histAnnual,
        achievedSuccessRate: r2(solved.successRate / 100),
        targetAchieved: solved.targetAchieved,
        solutionStatus: solved.solutionStatus,
        historicalTargetAchieved:
          histSolved === null ? null : histSolved.targetAchieved,
        historicalSolutionStatus:
          histSolved === null ? null : histSolved.solutionStatus,
        historicalRuns: histRuns,
        historicalSuccessfulRuns:
          histSolved === null || histRuns === null
            ? null
            : successfulRunsFromRate(histSolved.successRate, histRuns),
        historicalSolvedPortfolioWithdrawalPct:
          histSolved === null ? null : histSolved.percent,
        historicalCappedAtPercentBound,
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
      null,
      "retirement_max_spending",
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
  comparisonScope: ComparisonScopeInfo;
}> {
  return guard(() => {
    const base = buildRothCompareBase(scenario);
    // D3: the saved shape carries the draw order as a key string.
    // Forced RMDs come out of pre-tax first under every order;
    // the order governs spending draws only (taxEngine).
    // Full mode prices the engine's canonical list of all
    // supported draw orders (DRAW_ORDER_OPTIONS, taxEngine.ts);
    // limited mode keeps the three orders this tool has always
    // compared, so existing calls are unchanged.
    const full = scenario.comparisonScope === "full";
    const orders = full
      ? DRAW_ORDER_OPTIONS.map((o) => ({
          name: DRAW_ORDER_NAMES[o.key] ?? o.key,
          overrides: { drawOrder: o.key },
        }))
      : [
          { name: "taxable-first", overrides: { drawOrder: "taxable-pretax-roth" } },
          { name: "pre-tax-first", overrides: { drawOrder: "pretax-taxable-roth" } },
          { name: "roth-first", overrides: { drawOrder: "roth-taxable-pretax" } },
        ];
    const compared = runCompare(
      base,
      orders,
      scenario.startYear,
      "taxable-first",
    );
    if (!compared.ok) return compared;
    const outcome = compared.outcome;
    const scope = buildComparisonScope({
      scope: full ? "full" : "limited",
      searchKind: "fixed-comparison",
      evaluatedCandidates: outcome.mapped.length,
      candidateNames: outcome.mapped.map((m) => m.name),
      candidateSetDescription: full
        ? "All six permutations of the Taxable / Pre-tax / Roth spending-draw order (the engine's canonical DRAW_ORDER_OPTIONS), each priced as a fixed strategy with identical inputs."
        : "The three fixed withdrawal orders this tool has always compared: taxable-first, pre-tax-first, roth-first. The other three permutations are not priced in this mode — pass comparisonScope \"full\" for all six.",
      baselineName: outcome.baseline.name,
      winnerByNetCost: outcome.winnerByNetCost,
      winnerByEndingWealth: outcome.winnerByEndingWealth,
      winnerQualified: outcome.winnerQualified,
      excludedInvalidWinner: outcome.excludedInvalidWinner,
      tieBreakPolicy: LIMITED_TIE_BREAK,
      excludedCandidateFamilies: full
        ? [
            "Mid-plan draw-order switches (a second order from a switch age) — one order applies for the whole horizon in each candidate.",
          ]
        : [
            "The three uncompared draw-order permutations (taxable-roth-first, pre-tax-roth-first, roth-pre-tax-first) — pass comparisonScope \"full\" to price them.",
            "Mid-plan draw-order switches (a second order from a switch age).",
          ],
    });
    return respond(
      scenario,
      {
        baselineName: outcome.baseline.name,
        scenarios: outcome.mapped,
        winnerByEndingWealth: outcome.winnerByEndingWealth,
        winnerByNetCost: outcome.winnerByNetCost,
        deltas: deltasVsBaseline(outcome.mapped, outcome.baseline),
        yearly: yearlyTable(outcome.baselineRaw),
        comparisonScope: scope,
      },
      [
        ...healthPremiumWarnings(scenario),
        YEARLY_TABLE_WARNING,
        ...irmaaAcaCompareWarnings(outcome.mapped),
        ...unqualifiedWinnerWarning(outcome),
      ],
      taxAwareAssumptions(scenario),
      null,
      "retirement_compare_strategies",
    );
  });
}

// ---------------------------------------------------------------------------
// 5. Roth conversion compare
// ---------------------------------------------------------------------------

/** Shared results shape for retirement_roth_conversion (limited and full). */
export type RothConversionResults = {
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
  comparisonScope: ComparisonScopeInfo;
  optimizer?: {
    candidatesTested: number;
    searchKind: "optimizer-search";
    winner: {
      name: string;
      candidateKey: string;
      strategyDescription: string;
      drawOrder: string;
      windowLabel: string;
      windowStopAge: number;
      guardrail: boolean;
      bunching: boolean;
      gainsHarvest: boolean;
      claimAgePrimary: number | null;
      claimAgeSpouse: number | null;
      netCost: number;
      endingWealth: number;
      conversionsTotal: number;
      // LOOKBACK + ELIGIBILITY SUMMARIES (Engine Review 6):
      // the winner march's premium years whose IRMAA is
      // UNKNOWN and its ACA years under 100% FPL — read off
      // the winner's own priced march, never re-derived.
      irmaaLookbackMissingYears: number[];
      acaBelow100FplYears: number[];
      // CLIFF-CAP INOPERATIVE YEARS (Engine Review C9,
      // Build 5 NICEs — W5 §3/§6): the winner march's ACA
      // years where the cliff cap cannot defend the cliff
      // because mandatory income alone breaches it — read off
      // the winner's own priced march, never re-derived.
      cliffCapInoperativeYears: number[];
      // EARLY-WITHDRAWAL UNKNOWN YEARS (Engine Review C9,
      // Build 1): the winner march's years whose pre-59½
      // pre-tax spending draw was priced while the drawing
      // owner's Rule-of-55 eligibility was unanswered.
      earlyWithdrawalUnknownYears: number[];
      // ROTH BASIS UNKNOWN YEARS (Engine Review C9,
      // Build 2 — W3): the winner march's years whose Roth
      // spending draw was priced while the drawing owner's
      // Roth basis / clocks were unentered.
      rothBasisUnknownYears: number[];
      yearlyConversions: Array<{
        year: number;
        agePrimary: number;
        conversion: number;
      }>;
    };
    runnersUp: Array<{
      name: string;
      candidateKey: string;
      netCost: number;
      endingWealth: number;
      conversionsTotal: number;
    }>;
    doNothing: {
      netCost: number;
      endingWealth: number;
      // LOOKBACK + ELIGIBILITY SUMMARIES (Engine Review 6):
      // the do-nothing march's premium years whose IRMAA is
      // UNKNOWN and its ACA years under 100% FPL.
      irmaaLookbackMissingYears: number[];
      acaBelow100FplYears: number[];
      // CLIFF-CAP INOPERATIVE YEARS (Engine Review C9,
      // Build 5 NICEs — W5 §3/§6): the do-nothing march's
      // ACA years where the cliff cap cannot defend the cliff
      // because mandatory income alone breaches it.
      cliffCapInoperativeYears: number[];
      // EARLY-WITHDRAWAL UNKNOWN YEARS (Engine Review C9,
      // Build 1): the do-nothing march's years, as above.
      earlyWithdrawalUnknownYears: number[];
      // ROTH BASIS UNKNOWN YEARS (Engine Review C9,
      // Build 2 — W3): the do-nothing march's years, as above.
      rothBasisUnknownYears: number[];
    };
    candidateFamiliesEvaluated: string[];
    excludedCandidateFamilies: string[];
    // Engine Review 4 (E4-S1/E4-S2): the objective the winner
    // was crowned under, the valid / invalid split of the
    // tested candidates, whether the two objective winners
    // differ, and the ending-wealth winner when it is not the
    // cost winner. winnerQualified is false only when no
    // candidate was valid at all; excludedInvalidWinner names
    // the raw cheapest candidate when it was excluded as
    // invalid, with its integrity reasons — null in the
    // ordinary case. All sourced from the engine's own
    // runOptimizer result, never re-derived here.
    objective: string;
    validCandidatesTested: number;
    invalidCandidatesTested: number;
    winnersDiffer: boolean;
    winnerQualified: boolean;
    wealthWinner: {
      name: string;
      candidateKey: string;
      netCost: number;
      endingWealth: number;
    } | null;
    excludedInvalidWinner: {
      name: string;
      candidateKey: string;
      reasons: string[];
    } | null;
  };
};

export async function compareRothConversions(
  scenario: NormalizedScenario,
): Promise<AdapterResult<RothConversionResults>> {
  return guardAsync(async () => {
    if (scenario.comparisonScope === "full") {
      return compareRothConversionsFull(scenario);
    }
    const base = buildRothCompareBase(scenario);
    // D4: ceilings overrides use the cents shape, not NO_CEILINGS.
    // Limited mode: the four fixed conversion strategies this tool
    // has always compared. A limited winner is the best of these
    // four only — never a global optimum (see comparisonScope).
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
    const scope = buildComparisonScope({
      scope: "limited",
      searchKind: "fixed-comparison",
      evaluatedCandidates: outcome.mapped.length,
      candidateNames: outcome.mapped.map((m) => m.name),
      candidateSetDescription:
        "The four fixed conversion strategies this tool has always compared: Do Nothing, Fill 12%, Fill 22%, Fill 22% capped at IRMAA Tier 1, all priced at the entered claiming ages under the plan's draw order. No other ceiling, window, or draw order is priced in this mode — pass comparisonScope \"full\" for the engine's optimizer search.",
      baselineName: outcome.baseline.name,
      winnerByNetCost: outcome.winnerByNetCost,
      winnerByEndingWealth: outcome.winnerByEndingWealth,
      winnerQualified: outcome.winnerQualified,
      excludedInvalidWinner: outcome.excludedInvalidWinner,
      tieBreakPolicy: LIMITED_TIE_BREAK,
      excludedCandidateFamilies: [
        "Every other conversion ceiling (other bracket tops, IRMAA tiers, ACA-cliff caps, MAGI caps) — pass comparisonScope \"full\" to search them.",
        "Other conversion windows (stop at 65 / through the RMD years), other draw orders, guardrail and bunching variants, gain-harvest twins — pass comparisonScope \"full\" to search them.",
        "Joint claiming-age combinations — claiming ages are held at the entered ages in every mode.",
      ],
    });
    return respond(
      scenario,
      {
        baselineName: outcome.baseline.name,
        scenarios: outcome.mapped,
        winnerByEndingWealth: outcome.winnerByEndingWealth,
        winnerByNetCost: outcome.winnerByNetCost,
        deltas: deltasVsBaseline(outcome.mapped, outcome.baseline),
        yearly: yearlyTable(outcome.baselineRaw),
        comparisonScope: scope,
      },
      [
        ...healthPremiumWarnings(scenario),
        YEARLY_TABLE_WARNING,
        ...irmaaAcaCompareWarnings(outcome.mapped),
        ...unqualifiedWinnerWarning(outcome),
      ],
      taxAwareAssumptions(scenario),
      null,
      "retirement_roth_conversion",
    );
  });
}

/**
 * Full Roth mode: the engine's own optimizer search, reused
 * directly (runOptimizer in rothOptimizer.ts) — no recreated
 * optimization logic. The search prices every candidate the
 * engine builds (bracket / IRMAA / ACA-cliff / MAGI ceilings ×
 * conversion windows × all six draw orders × guardrail /
 * bunching variants × gain-harvest twins when the gate passes)
 * plus the Do Nothing benchmark, at the entered claiming ages,
 * and ranks by the engine's own winner ordering (lowest
 * lifetime net cost, ending wealth breaking exact cost ties).
 *
 * Never downgraded: if the optimizer throws, guard() turns it
 * into engine_error — the caller gets a failure, not a quiet
 * limited comparison.
 */
async function compareRothConversionsFull(
  scenario: NormalizedScenario,
): Promise<AdapterResult<RothConversionResults>> {
  return guardAsync(async () => {
    const remainingMs = actionDeadline();
    const planInputs = buildRothPlanInputs(scenario);
    // Full mode: the fixed-age optimizer search runs in the
    // worker pool (SMALL lane, §1.2), so a 3,025-candidate search
    // no longer blocks the request thread — the S1 headline
    // (295,602 ms wall over HTTP/MCP, /health delayed 295,409 ms)
    // was this call priced in-thread.
    const result = await runOptimizerAsync(planInputs, {
      timeoutMs: remainingMs(),
    });
    const winner = result.winner;
    const doNothing = result.doNothing;
    // Both objective winners come from the ENGINE (E4-S2):
    // winnerByNetCost is the lowest-net-cost VALID candidate and
    // winnerByEndingWealth the highest-ending-wealth VALID one —
    // the adapter no longer re-derives the wealth winner over
    // the raw scored list (an invalid candidate could win that
    // re-derivation and disagree with the engine). On every plan
    // whose cheapest candidate is valid these are the same
    // candidates the adapter used to pick.
    const wealthWinner = result.winnerByEndingWealth;
    // Returned scenarios: the benchmark, the engine winner, its
    // runners-up, and the wealth winner when it is none of those
    // — so both winner fields always name a returned scenario.
    // The full scored set is thousands of rows and is not
    // shipped; candidatesTested names its size.
    const returned: ScoredCandidate[] = [];
    const seenKeys = new Set<string>();
    for (const s of [
      doNothing,
      winner,
      ...result.runnersUp,
      ...(wealthWinner == null ? [] : [wealthWinner]),
    ]) {
      if (!seenKeys.has(s.spec.key)) {
        seenKeys.add(s.spec.key);
        returned.push(s);
      }
    }
    const mapped = returned.map((s) =>
      mapScoredCandidate(s, scenario.retirementAge),
    );
    const baseline = mapped.find(
      (m) => m.candidateKey === DO_NOTHING_SPEC.key,
    )!;
    const winnerMapped = mapped.find(
      (m) => m.candidateKey === winner.spec.key,
    )!;
    const winnerName = winnerMapped.name;
    const wealthWinnerName =
      wealthWinner == null
        ? null
        : optimizerCandidateDisplayName(wealthWinner.spec);
    const harvestGate = harvestGatePasses(planInputs);
    const excludedCandidateFamilies = [
      "Joint claiming-age combinations (runJointOptimizer) — claiming ages are held at the entered ages; delaying a claim can open cheap conversion years the fixed-age search cannot see.",
      "Monte Carlo retirement-success check — this search is deterministic tax-aware pricing only, not a success-probability optimization.",
      ...(harvestGate
        ? []
        : [
            "Gain-harvest twins — the harvest gate failed for this plan (no taxable balance above $0 with basis below 100%), so harvesting is a provable no-op here.",
          ]),
    ];
    const candidateFamiliesEvaluated = [
      "Every federal bracket top as a conversion ceiling",
      "Every IRMAA tier ceiling, and bracket × IRMAA combinations",
      "ACA-cliff caps (alone and with the 12% / 22% brackets)",
      "MAGI-cap steps ($150,000–$500,000)",
      "Conversion windows: stop at 65, stop the year before RMDs begin, keep topping up through the RMD years",
      "All six draw orders",
      "Guardrail variants (bracket ceilings) and bunching variants (non-cliff ceilings)",
      ...(harvestGate
        ? ["Gain-harvest twins of every conversion candidate"]
        : []),
      "Do Nothing as the benchmark",
    ];
    const scope = buildComparisonScope({
      scope: "full",
      searchKind: "optimizer-search",
      evaluatedCandidates: result.candidatesTested,
      candidateNames: mapped.map((m) => m.name),
      candidateSetDescription: `The engine's full optimizer search at the entered claiming ages: ${result.candidatesTested} candidates priced. ${result.searchScope.description} The response returns the benchmark, the winner, its runners-up, and the ending-wealth winner when it is none of those; candidatesTested is the full searched count. Still not a global optimum: claiming ages are fixed (see excluded families).`,
      baselineName: baseline.name,
      winnerByNetCost: winnerName,
      winnerByEndingWealth: wealthWinnerName,
      winnerQualified: result.winnerQualified,
      excludedInvalidWinner:
        result.excludedInvalidWinner == null
          ? null
          : {
              name: optimizerCandidateDisplayName(
                result.excludedInvalidWinner.candidate.spec,
              ),
              reasons: result.excludedInvalidWinner.integrity.reasons,
            },
      tieBreakPolicy: OPTIMIZER_TIE_BREAK,
      excludedCandidateFamilies,
    });
    const winnerConversions = yearlyConversions(winner);
    const winnerTotal = winner.result.years.reduce(
      (sum, y) => sum + y.conversion,
      0,
    );
    return respond(
      scenario,
      {
        baselineName: baseline.name,
        scenarios: mapped,
        winnerByEndingWealth: wealthWinnerName,
        winnerByNetCost: winnerName,
        deltas: deltasVsBaseline(mapped, baseline),
        // The baseline (Do Nothing) yearly table, as in limited
        // mode; the winner's yearly conversions are in
        // optimizer.winner.yearlyConversions.
        yearly: yearlyTableFromRothYears(doNothing.result.years),
        comparisonScope: scope,
        optimizer: {
          candidatesTested: result.candidatesTested,
          searchKind: "optimizer-search",
          winner: {
            name: winnerName,
            candidateKey: winner.spec.key,
            strategyDescription: winnerMapped.strategyDescription,
            drawOrder: drawOrderKey(winner.spec.drawOrder),
            windowLabel: winner.spec.windowLabel,
            windowStopAge: winner.spec.windowStopAge,
            guardrail: winner.spec.guardrail,
            bunching: winner.spec.bunching,
            gainsHarvest: winner.spec.gainsHarvest ?? false,
            claimAgePrimary: winner.claimAges.primaryAge,
            claimAgeSpouse: winner.claimAges.spouseAge,
            netCost: r2(winner.cost.netCost),
            endingWealth: r2(winner.result.endingAfterTaxWealth),
            conversionsTotal: r2(winnerTotal),
            irmaaLookbackMissingYears:
              winner.result.irmaaLookbackMissingYears,
            acaBelow100FplYears: winner.result.acaBelow100FplYears,
            cliffCapInoperativeYears:
              winner.result.cliffCapInoperativeYears,
            earlyWithdrawalUnknownYears:
              winner.result.earlyWithdrawalUnknownYears,
            rothBasisUnknownYears: winner.result.rothBasisUnknownYears,
            yearlyConversions: winnerConversions,
            rmdDeferral: rmdSurvivorSummary(
              winner.result.years.map((y) => ({
                year: y.year,
                rmdDeferredPrimary: y.detail.rmdDeferredPrimary,
                rmdDeferredSpouse: y.detail.rmdDeferredSpouse,
                rmdDeferredPaidPrimary: y.detail.rmdDeferredPaidPrimary,
                rmdDeferredPaidSpouse: y.detail.rmdDeferredPaidSpouse,
                survivorSsMode: y.detail.survivorSsMode,
                survivorClaimAge: y.detail.survivorClaimAge,
              })),
            ),
          },
          runnersUp: result.runnersUp.map((s) => ({
            name: optimizerCandidateDisplayName(s.spec),
            candidateKey: s.spec.key,
            netCost: r2(s.cost.netCost),
            endingWealth: r2(s.result.endingAfterTaxWealth),
            conversionsTotal: r2(
              s.result.years.reduce((sum, y) => sum + y.conversion, 0),
            ),
          })),
          doNothing: {
            netCost: r2(doNothing.cost.netCost),
            endingWealth: r2(doNothing.result.endingAfterTaxWealth),
            irmaaLookbackMissingYears:
              doNothing.result.irmaaLookbackMissingYears,
            acaBelow100FplYears: doNothing.result.acaBelow100FplYears,
            cliffCapInoperativeYears:
              doNothing.result.cliffCapInoperativeYears,
            earlyWithdrawalUnknownYears:
              doNothing.result.earlyWithdrawalUnknownYears,
            rothBasisUnknownYears:
              doNothing.result.rothBasisUnknownYears,
            rmdDeferral: rmdSurvivorSummary(
              doNothing.result.years.map((y) => ({
                year: y.year,
                rmdDeferredPrimary: y.detail.rmdDeferredPrimary,
                rmdDeferredSpouse: y.detail.rmdDeferredSpouse,
                rmdDeferredPaidPrimary: y.detail.rmdDeferredPaidPrimary,
                rmdDeferredPaidSpouse: y.detail.rmdDeferredPaidSpouse,
                survivorSsMode: y.detail.survivorSsMode,
                survivorClaimAge: y.detail.survivorClaimAge,
              })),
            ),
          },
          candidateFamiliesEvaluated,
          excludedCandidateFamilies,
          objective: result.objective,
          validCandidatesTested: result.validCandidatesTested,
          invalidCandidatesTested: result.invalidCandidatesTested,
          winnersDiffer: result.winnersDiffer,
          winnerQualified: result.winnerQualified,
          wealthWinner:
            wealthWinner == null || wealthWinner.spec.key === winner.spec.key
              ? null
              : {
                  name: optimizerCandidateDisplayName(wealthWinner.spec),
                  candidateKey: wealthWinner.spec.key,
                  netCost: r2(wealthWinner.cost.netCost),
                  endingWealth: r2(wealthWinner.result.endingAfterTaxWealth),
                },
          excludedInvalidWinner:
            result.excludedInvalidWinner == null
              ? null
              : {
                  name: optimizerCandidateDisplayName(
                    result.excludedInvalidWinner.candidate.spec,
                  ),
                  candidateKey: result.excludedInvalidWinner.candidate.spec.key,
                  reasons: result.excludedInvalidWinner.integrity.reasons,
                },
        },
      },
      [
        HEALTH_PREMIUM_WARNING,
        YEARLY_TABLE_WARNING,
        // Engine Review 6: the winner's and the do-nothing
        // march's unknown-IRMAA / below-100% years.
        ...irmaaAcaCompareWarnings([
          {
            name: winnerName,
            irmaaLookbackMissingYears:
              winner.result.irmaaLookbackMissingYears,
            acaBelow100FplYears: winner.result.acaBelow100FplYears,
            cliffCapInoperativeYears:
              winner.result.cliffCapInoperativeYears,
            earlyWithdrawalUnknownYears:
              winner.result.earlyWithdrawalUnknownYears,
            rothBasisUnknownYears:
              winner.result.rothBasisUnknownYears,
          },
          {
            name: "do-nothing",
            irmaaLookbackMissingYears:
              doNothing.result.irmaaLookbackMissingYears,
            acaBelow100FplYears: doNothing.result.acaBelow100FplYears,
            cliffCapInoperativeYears:
              doNothing.result.cliffCapInoperativeYears,
            earlyWithdrawalUnknownYears:
              doNothing.result.earlyWithdrawalUnknownYears,
            rothBasisUnknownYears:
              doNothing.result.rothBasisUnknownYears,
          },
        ]),
        "Full optimizer search: the winner is the engine's best candidate at the entered claiming ages, not a global optimum — claiming ages were not searched (see comparisonScope.excludedCandidateFamilies). A full call can take over a minute; while it runs the server answers nothing else.",
        // (Engine Review C9, Build 3 NICEs, N6): the "cheapest
        // valid candidate" sentence runs only when the crown IS
        // qualified — on an all-invalid search there is no valid
        // candidate, so claiming one beside the "No tested
        // candidate was valid" warning contradicted it.
        ...(result.excludedInvalidWinner == null
          ? []
          : [
              `The cheapest candidate the search priced (${optimizerCandidateDisplayName(result.excludedInvalidWinner.candidate.spec)}) was excluded as invalid: ${result.excludedInvalidWinner.integrity.reasons.join("; ")}.${result.winnerQualified ? " The crowned winner is the cheapest valid candidate." : ""}`,
            ]),
        ...(!result.winnerQualified
          ? [
              "No tested candidate was valid — the crowned winner carries a material unresolved discrepancy, unpaid tax, or unfunded spending. Treat its figures as unqualified.",
            ]
          : []),
      ],
      taxAwareAssumptions(scenario),
      null,
      "retirement_roth_conversion",
    );
  });
}

// ---------------------------------------------------------------------------
// 5b. Dynamic withdrawal optimizer (Engine Review C10)
// ---------------------------------------------------------------------------

/**
 * Year-by-year withdrawal optimization, priced entirely by the
 * shared engine (runDynamicOptimizer in rothOptimizer.ts): at
 * each year the up-to-114-policy fixed-fill set is priced over the
 * remaining horizon from that year's actual balances and the
 * best valid policy's first year becomes the schedule's row.
 * The response carries the annual schedule table (per-year
 * draw per bucket, conversion, tax, MAGI, ACA position, RMD,
 * balances), the lifetime totals, the terminal / step-up
 * block, and the best valid fixed policy the result is floored
 * at — so the adapter surface and the engine surface agree by
 * construction (the adapter maps the engine result, it never
 * re-prices a year). No global-optimality claim: see the
 * result's searchLimits.
 *
 * Engine Review C7 architecture, SHOULD-1: the optimizer runs
 * in the worker pool (SMALL lane) through
 * runDynamicOptimizerAsync, not synchronously on the request
 * thread — it measures 15.3 s CPU on the sample household,
 * ~7× the §1.2 ~2 s migration rule. guardAsync maps a pool
 * EngineError to the typed adapter error.
 */
export async function dynamicWithdrawal(
  scenario: NormalizedScenario,
): Promise<AdapterResult<DynamicOptimizerResult>> {
  return guardAsync(async () => {
    const remainingMs = actionDeadline();
    const planInputs = buildRothPlanInputs(scenario);
    const result = await runDynamicOptimizerAsync(planInputs, {
      timeoutMs: remainingMs(),
    });
    if (!result.ok) return engineError(result.reason ?? "The dynamic optimizer could not price this scenario.");
    return respond(
      scenario,
      result,
      [
        ...healthPremiumWarnings(scenario),
        "Dynamic schedule: each year's policy (draw order + conversion fill + window) was chosen by re-pricing the remaining horizon from that year's actual balances. The greedy choice is floored at the best valid fixed policy over the same fixed-policy set (up to 114 policies) — see floorBound and searchLimits in the results.",
      ],
      taxAwareAssumptions(scenario),
      null,
      "retirement_dynamic_withdrawal",
    );
  });
}

// ---------------------------------------------------------------------------
// 6. Retirement-age compare (tax-aware Roth compare + work-years leg)
// ---------------------------------------------------------------------------

export async function compareRetirementAges(
  scenario: NormalizedScenario,
): Promise<
  AdapterResult<{
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
    // Assumptions the roll relied on (Engine Review 7): the
    // HSA coverage/eligibility fallbacks and the first-year
    // prior-wage proxy, each named once when used. Empty when
    // every work-year input was explicit. The same strings
    // also ride the response warnings (below), so a caller
    // that reads only warnings still sees them.
    assumptions: string[];
  }>;
  workYearsWinnerByAllInTax: string | null;
  /** Salary-aware winner by highest ending after-tax wealth
   *  (work-years rows only; null without a salary). Ending
   *  after-tax wealth is the engine's endingAfterTaxWealth at the
   *  shared terminal age, so it is comparable across quit ages
   *  (D11) — unlike the old horizon warning's claim. */
  workYearsWinnerByEndingAfterTaxWealth: string | null;
  /** The retirement-only winners, explicitly scoped: they price
   *  the same starting balances at each retirement age and ignore
   *  salary, employer contributions, and payroll tax. Never an
   *  overall recommendation. */
  retirementOnly: {
    winnerByNetCost: string | null;
    winnerByEndingWealth: string | null;
  };
  /** The salary-aware winners, or null without a salary. Lowest
   *  all-in tax and highest ending after-tax wealth are different
   *  objectives and may point to different quit ages. */
  workYearsComparison: {
    winnerByAllInTax: string | null;
    winnerByEndingAfterTaxWealth: string | null;
  } | null;
  /** What each scoped model prices and whether it searches
   *  claiming ages or runs the joint optimizer (D12). This is
   *  NOT the Review 4 comparisonScope block below it, which
   *  describes the candidate set of the quit-age comparison
   *  itself. salaryAware is null without a salary. */
  comparisonModels: {
    retirementOnly: ComparisonModelInfo;
    salaryAware: ComparisonModelInfo | null;
  };
  /** Overall recommendation, or null when none is defensible: the
   *  salary-aware objectives agree on one quit age (lowest all-in
   *  tax AND highest ending after-tax wealth), that age is the
   *  recommendation; when they disagree, or when no salary was
   *  provided, there is no overall recommendation — see
   *  overallRecommendationNote. Never a retirement-only winner. */
  overallRecommendation: string | null;
  /** Why overallRecommendation is what it is (agreement, the
   *  disagreeing objectives, or the missing salary). */
  overallRecommendationNote: string;
  comparisonScope: ComparisonScopeInfo;
  }>
> {
  return guardAsync(async () => {
    const remainingMs = actionDeadline();
    // No full mode exists for the quit-age comparison: each age
    // prices one fixed strategy, and full conversion search is a
    // per-age operation (retirement_roth_conversion, full). A
    // requested full search is refused explicitly — never run as
    // a quiet limited comparison.
    if (scenario.comparisonScope === "full") {
      return unsupported(
        'retirement_work_years has no full comparison mode: each quit age prices one fixed strategy, and the full optimizer search runs per retirement age. Use retirement_roth_conversion with comparisonScope "full" for the optimizer search, or omit comparisonScope for the fixed quit-age comparison.',
      );
    }
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
      irmaaLookbackMissingYears: number[];
      acaBelow100FplYears: number[];
      // CLIFF-CAP INOPERATIVE YEARS (Engine Review C9,
      // Build 5 NICEs — W5 §3/§6): the winner march's ACA
      // years where the cliff cap cannot defend the cliff
      // because mandatory income alone breaches it (see the
      // row type in workYears.ts).
      cliffCapInoperativeYears: number[];
      // EARLY-WITHDRAWAL UNKNOWN YEARS (Engine Review C9,
      // Build 1): the winner march's years whose pre-59½
      // pre-tax spending draw was priced while the drawing
      // owner's Rule-of-55 eligibility was unanswered.
      earlyWithdrawalUnknownYears: number[];
      // ROTH BASIS UNKNOWN YEARS (Engine Review C9,
      // Build 2 — W3): the winner march's years whose Roth
      // spending draw was priced while the drawing owner's
      // Roth basis / clocks were unentered.
      rothBasisUnknownYears: number[];
      assumptions: string[];
    }> = [];
    let workYearsWinnerByAllInTax: string | null = null;
    let workYearsWinnerByEndingAfterTaxWealth: string | null = null;
    const workYearsWarnings: string[] = [];
    // Review 8 NICEs (P1-1): a $0 salary is no salary for the
    // scoped models — the salary leg, the salary-aware model,
    // the work-years comparison, and the overall recommendation
    // all need a positive salary to price. (Previously 0 took
    // the salary branch while comparisonModels claimed
    // includesSalary: true.)
    const salaryAnnual = scenario.salaryAnnual;
    const hasSalary = salaryAnnual != null && salaryAnnual !== 0;
    if (hasSalary) {
      const planInputs = buildRothPlanInputs(scenario, {
        retirementAge: firstAge,
        windowStartAge: firstAge,
      });
      // Engine Review 7: the explicit HSA inputs, the
      // Medicare enrollment age, and the prior-year wages
      // ride the job straight from the normalized scenario
      // (null = omitted — the engine falls back as documented
      // and records the fallback as an assumption on the row).
      const job: WorkYearJob = {
        salary: salaryAnnual,
        employer401k: scenario.employer401kAnnual,
        employerHsa: scenario.employerHsaAnnual,
        medicareAgePrimary: scenario.medicareAgePrimary,
        hsaCoverage: scenario.hsaCoverage,
        hsaEligible: scenario.hsaEligible,
        priorYearWages: scenario.priorYearWagesAnnual,
      };
      // The work-years leg runs in the worker pool (LARGE lane,
      // §1.2): each quit age's joint search is one worker job,
      // so a multi-minute salary leg no longer blocks the
      // request thread. The retirement-only legs above stay
      // in-thread (runRothCompare, ~1 s at the capped size).
      // Per-action deadline (§1.5, MUST-2): the ages dispatch
      // sequentially inside the compare, so it gets the
      // remaining-budget callback — not one precomputed number —
      // and each age's dispatch computes its budget fresh.
      const wyRows: WorkYearsCompareRow[] = await runWorkYearsCompareAsync(
        planInputs,
        job,
        ages,
        { remainingMs },
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
          // LOOKBACK + ELIGIBILITY SUMMARIES (Engine Review
          // 6): the winner march's premium years whose IRMAA
          // is UNKNOWN and its ACA years under 100% FPL
          // (see the row type in workYears.ts).
          irmaaLookbackMissingYears: row.irmaaLookbackMissingYears,
          acaBelow100FplYears: row.acaBelow100FplYears,
          cliffCapInoperativeYears: row.cliffCapInoperativeYears,
          // EARLY-WITHDRAWAL UNKNOWN YEARS (Engine Review
          // C9, Build 1): as above, for the winner march.
          earlyWithdrawalUnknownYears: row.earlyWithdrawalUnknownYears,
          // ROTH BASIS UNKNOWN YEARS (Engine Review C9,
          // Build 2 — W3): as above, for the winner march.
          rothBasisUnknownYears: row.rothBasisUnknownYears,
          assumptions: row.assumptions,
        })),
      );
      // The roll's assumptions ride the warnings too, once
      // each (the first row's set — every row in one call
      // prices the same job, so the distinct set is the
      // same on each; the per-row field above carries the
      // same strings for a caller that reads rows only).
      for (const a of wyRows[0]?.assumptions ?? []) {
        workYearsWarnings.push(`Work-years assumption: ${a}`);
      }
      const wyWinner = pickWinner(
        workYears,
        (a, b) => a.allInTax < b.allInTax,
      );
      workYearsWinnerByAllInTax = wyWinner
        ? `retire-${wyWinner.quitAge}`
        : null;
      // Salary-aware winner by ending after-tax wealth (D11): the
      // engine's endingAfterTaxWealth at the shared terminal age,
      // so rows are comparable — highest wins. Lowest all-in tax
      // and highest ending wealth are different objectives; neither
      // implies the other.
      const wyWealthWinner = pickWinner(
        workYears,
        (a, b) => a.endingAfterTax > b.endingAfterTax,
      );
      workYearsWinnerByEndingAfterTaxWealth = wyWealthWinner
        ? `retire-${wyWealthWinner.quitAge}`
        : null;
      workYearsWarnings.push(WORK_YEARS_COMPARABILITY_NOTE);
      if (scenario.medicareAgePrimary == null) {
        // Review 8 NICEs (P3-1): the "HSA contributions
        // continue" clause overstates when the salary leg prices
        // zero HSA — gate the full warning on positive priced
        // HSA (the rolls' hsaContributions, employee + employer).
        const pricedHsa = wyRows.reduce(
          (sum, row) => sum + row.roll.totals.hsaContributions,
          0,
        );
        workYearsWarnings.push(
          pricedHsa > 0
            ? MEDICARE_NO_ENROLLMENT_WARNING
            : MEDICARE_NO_ENROLLMENT_NO_HSA_WARNING,
        );
      }
    } else {
      workYearsWarnings.push(
        salaryAnnual === 0
          ? "Work-years detail (salary, employer 401(k)/HSA earned by working longer) is not included: salaryAnnual is $0, so there is no salary to price. Pass a positive salaryAnnual to include it. The winners above are retirement-only, not an overall recommendation."
          : "Work-years detail (salary, employer 401(k)/HSA earned by working longer) is not included: no salary was provided. Pass salaryAnnual to include it. The winners above are retirement-only, not an overall recommendation.",
      );
    }
    const withAges = outcome.mapped.map((m, i) => ({
      ...m,
      retirementAge: ages[i]!,
    }));
    // Winner semantics (Review 8, D12): the top-level winnerBy*
    // fields stay retirement-only, for backward compatibility —
    // and are now also exposed as retirementOnly, explicitly
    // scoped. The overall recommendation comes ONLY from the
    // salary-aware leg, and only when its two objectives agree on
    // one quit age. comparisonModels names what each model prices:
    // the retirement-only model prices fixed Do-Nothing-fill
    // scenarios at the ENTERED claiming ages (no claiming-age
    // search, no optimizer); the salary-aware model's per-age
    // winnerStrategy IS the joint optimizer's pick for that quit
    // age alone — the optimizer searches claiming ages and
    // conversion strategies per quit age, but the quit-age
    // comparison itself runs no optimizer search across
    // conversion strategies.
    const comparisonModels: {
      retirementOnly: ComparisonModelInfo;
      salaryAware: ComparisonModelInfo | null;
    } = {
      retirementOnly: {
        includesSalary: false,
        includesWorkYearContributions: false,
        includesWorkYearPayrollTaxes: false,
        usesFullOptimizer: false,
        ssClaimingAgesSearched: false,
        objective:
          "lowest lifetime net cost or highest ending after-tax wealth among fixed Do-Nothing-fill strategies per quit age",
        description:
          "Prices the same starting balances at each retirement age with one fixed Do-Nothing-fill strategy per age at the entered Social Security claiming ages; ignores the salary, employer 401(k)/HSA contributions, and payroll tax earned by working longer, and searches neither claiming ages nor conversion strategies.",
      },
      salaryAware:
        !hasSalary
          ? null
          : {
              includesSalary: true,
              includesWorkYearContributions: true,
              includesWorkYearPayrollTaxes: true,
              usesFullOptimizer: true,
              ssClaimingAgesSearched: true,
              objective:
                "lowest all-in tax or highest ending after-tax wealth among quit ages, each priced by the joint optimizer",
              description:
                "Rolls the extra working years forward — salary, employee payroll taxes, the employee contribution stack, employer 401(k) and HSA, spending during the working years, and investment growth — then prices each quit age's rolled plan with the joint optimizer; each row's winnerStrategy is the optimizer's pick for that quit age alone, searching claiming ages and conversion strategies per quit age (a benefit already started at plan start keeps its entered claiming age and is not searched), while the quit-age comparison itself runs no optimizer search across conversion strategies.",
            },
    };
    let overallRecommendation: string | null = null;
    let overallRecommendationNote: string;
    if (!hasSalary) {
      overallRecommendationNote =
        "No overall recommendation: the salary-aware comparison needs salaryAnnual. The retirement-only winners above price the same starting balances at each retirement age and ignore the salary, employer 401(k)/HSA contributions, and payroll tax earned by working longer, so they cannot recommend a retirement age.";
    } else if (
      workYearsWinnerByAllInTax != null &&
      workYearsWinnerByAllInTax === workYearsWinnerByEndingAfterTaxWealth
    ) {
      overallRecommendation = workYearsWinnerByAllInTax;
      overallRecommendationNote = `Both salary-aware objectives agree on ${overallRecommendation}: it has the lowest all-in tax and the highest ending after-tax wealth among the compared ages.`;
    } else {
      overallRecommendationNote =
        `No overall recommendation: the salary-aware objectives disagree — lowest all-in tax points to ${workYearsWinnerByAllInTax} while highest ending after-tax wealth points to ${workYearsWinnerByEndingAfterTaxWealth}. Lowest tax does not imply the best outcome; the choice depends on whether the caller values tax saved or wealth left more.`;
    }
    // Limited comparison: one fixed (Do-Nothing-fill) strategy per
    // quit age — the ages are the candidates, not conversion
    // strategies. The work-years leg's per-age winnerStrategy does
    // come from the engine's joint optimizer, but the quit-age
    // comparison itself stays limited: no optimizer search across
    // conversion strategies is run here.
    const scope = buildComparisonScope({
      scope: "limited",
      searchKind: "fixed-comparison",
      evaluatedCandidates: withAges.length,
      candidateNames: withAges.map((m) => m.name),
      candidateSetDescription: `One fixed Do-Nothing-fill strategy per quit age (${ages.map((a) => `retire-${a}`).join(", ")}), all priced with identical inputs. Conversion strategies are not searched across quit ages here — use retirement_roth_conversion with comparisonScope "full" for that search, at one retirement age.`,
      baselineName: outcome.baseline.name,
      winnerByNetCost: outcome.winnerByNetCost,
      winnerByEndingWealth: outcome.winnerByEndingWealth,
      winnerQualified: outcome.winnerQualified,
      excludedInvalidWinner: outcome.excludedInvalidWinner,
      tieBreakPolicy: WORK_YEARS_TIE_BREAK,
      excludedCandidateFamilies: [
        "Conversion strategies beyond the entered-plan Do-Nothing fill per quit age.",
        "Joint claiming-age search in the quit-age comparison leg (the work-years leg's per-age winnerStrategy is the engine joint optimizer's pick for that quit age alone).",
      ],
    });
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
        workYearsWinnerByEndingAfterTaxWealth,
        retirementOnly: {
          winnerByNetCost: outcome.winnerByNetCost,
          winnerByEndingWealth: outcome.winnerByEndingWealth,
        },
        workYearsComparison:
          !hasSalary
            ? null
            : {
                winnerByAllInTax: workYearsWinnerByAllInTax,
                winnerByEndingAfterTaxWealth:
                  workYearsWinnerByEndingAfterTaxWealth,
              },
        comparisonModels,
        overallRecommendation,
        overallRecommendationNote,
        comparisonScope: scope,
      },
      [
        ...healthPremiumWarnings(scenario),
        YEARLY_TABLE_WARNING,
        ...irmaaAcaCompareWarnings(outcome.mapped),
        ...unqualifiedWinnerWarning(outcome),
        // The work-years leg prices its own rolled marches,
        // so their unknown-IRMAA / below-100% years are
        // warned here too, keyed by quit age.
        ...irmaaAcaCompareWarnings(
          workYears.map((w) => ({
            name: `retire-${w.quitAge}`,
            irmaaLookbackMissingYears: w.irmaaLookbackMissingYears,
            acaBelow100FplYears: w.acaBelow100FplYears,
            cliffCapInoperativeYears: w.cliffCapInoperativeYears,
            earlyWithdrawalUnknownYears: w.earlyWithdrawalUnknownYears,
            rothBasisUnknownYears: w.rothBasisUnknownYears,
          })),
        ),
        // Only when the salary leg ran: with no salary there are
        // no work-years rows for the note to describe.
        ...(hasSalary ? [WORK_YEARS_STATE_TAX_NOTE] : []),
        ...workYearsWarnings,
      ],
      taxAwareAssumptions(scenario),
      null,
      "retirement_work_years",
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
        `The single-year price covers tax years ${TAX_LAW_YEARS.map((law) => law.year).join(", ")}; ${scenario.taxYear} is not priced. In the app's single-year action the same year prices on the newest published row carried forward, with that substitution named in lawProvenance — this tool does not price it.`,
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
    // R6-S1: a taxable share sale. The engine prices the realized
    // gain (sold − basis) on the capital-gains stack, and the
    // proceeds as cash in (cashIn counts stockSold in full — the
    // proceeds fund spending, only the gain is income). A basis
    // above the proceeds is a realized LOSS, not an error: the
    // engine prices it as a net capital loss (§1211(b) allowance
    // up to $3,000, remainder carried forward), so no basis ≤
    // proceeds rule is imposed. A basis entered with NO sale is
    // zeroed here: pricePlaygroundYear computes stockGain =
    // sold − basis, so a lone basis would invent a loss. Omitted
    // (null) and explicit $0 are different facts and warn
    // differently below.
    const sy = scenario.singleYear;
    const fmtMoney = (n: number): string =>
      `$${n.toLocaleString("en-US")}`;
    const stockSold = sy.stockSold ?? 0;
    const stockBasis = stockSold > 0 ? (sy.stockBasis ?? 0) : 0;
    const stockGain = stockSold - stockBasis;
    if (sy.stockSold == null) {
      warnings.push(
        "No taxable share sale was entered for this year, so no sale is priced — cashLeftVsSpending counts no sale proceeds and no capital gain or loss.",
      );
      if (sy.stockBasis != null && sy.stockBasis > 0) {
        warnings.push(
          "Cost basis was entered with no sale — it has no effect; a basis prices only against a sale.",
        );
      }
    } else if (stockSold === 0) {
      warnings.push(
        "An explicit $0 share sale was entered — no sale is priced, no gain or loss.",
      );
      if (sy.stockBasis != null && sy.stockBasis > 0) {
        warnings.push(
          "Cost basis was entered with no sale — it has no effect; a basis prices only against a sale.",
        );
      }
    } else {
      if (sy.stockBasis == null) {
        warnings.push(
          `No cost basis was entered for the ${fmtMoney(stockSold)} sale — basis prices at $0, so the whole proceeds price as gain. Enter stockBasisAnnual to price the actual gain.`,
        );
      } else if (stockGain < 0) {
        warnings.push(
          `The sale realizes a loss of ${fmtMoney(-stockGain)} (basis above proceeds) — the engine prices it as a net capital loss: up to $3,000 offsets ordinary income this year and the rest carries forward (lossCarryOutSt / lossCarryOutLt in the result).`,
        );
      } else if (stockGain === 0) {
        warnings.push(
          `The ${fmtMoney(stockSold)} sale realizes no gain or loss (basis equals proceeds) — the proceeds still count as cash in, with no capital-gains tax.`,
        );
      }
      warnings.push(
        `Sale proceeds of ${fmtMoney(stockSold)} count in cashIn (cashLeftVsSpending); only the ${fmtMoney(stockGain)} gain is income — proceeds and gain are different figures.`,
      );
      if (stockSold > scenario.taxableDollars) {
        warnings.push(
          `The ${fmtMoney(stockSold)} sale exceeds the typed taxable balance of ${fmtMoney(scenario.taxableDollars)} — check the sale amount; the price still counts the full proceeds.`,
        );
      }
    }
    // R6-S2: RMDs from prior-Dec-31 pre-tax balances. The balance
    // is the balance at December 31 of the year BEFORE the priced
    // tax year — never today's balance, never inferred from it.
    // Omitted (null) prices no RMD from that balance; explicit $0
    // prices a $0 RMD. The spouse's balance is the spouse's OWN
    // (the engine prices the spouse's RMD on the spouse's own
    // clock, roles swapped) and only counts on a joint return.
    const priorDec31Year = scenario.taxYear - 1;
    const primaryBalance = sy.pretaxPriorYearEnd;
    const spouseBalance = sy.pretaxSpousePriorYearEnd;
    const rmdAgePrimary = rmdAgeForBirthYear(scenario.birthYearPrimary);
    const rmdAgeSpouse =
      joint && scenario.birthYearSpouse != null
        ? rmdAgeForBirthYear(scenario.birthYearSpouse)
        : null;
    if (primaryBalance == null && spouseBalance == null) {
      warnings.push(
        "No prior-year pre-tax balance is carried in the single-year inputs, so no RMD is priced in this year.",
      );
    } else {
      if (primaryBalance != null) {
        if (primaryBalance === 0) {
          warnings.push(
            "An explicit $0 prior-Dec-31 pre-tax balance was entered for the primary — the primary's RMD is $0.",
          );
        } else {
          warnings.push(
            `The primary's RMD prices from the prior-Dec-31 (Dec 31, ${priorDec31Year}) pre-tax balance of ${fmtMoney(primaryBalance)}.`,
          );
        }
        if (agePrimary < rmdAgePrimary) {
          warnings.push(
            `The primary is ${agePrimary} in ${scenario.taxYear}, below RMD age ${rmdAgePrimary} for a ${scenario.birthYearPrimary} birth year — the primary's RMD is $0 this year.`,
          );
        }
      } else {
        warnings.push(
          "No prior-Dec-31 pre-tax balance was entered for the primary — the primary's RMD is $0; only a spouse balance was entered.",
        );
      }
      if (spouseBalance != null) {
        if (!joint) {
          warnings.push(
            "A spouse prior-Dec-31 balance was entered on a non-joint return — the engine ignores it: no spouse RMD is priced.",
          );
        } else if (spouseBalance === 0) {
          warnings.push(
            "An explicit $0 prior-Dec-31 pre-tax balance was entered for the spouse — the spouse's RMD is $0.",
          );
        } else {
          warnings.push(
            `The spouse's RMD prices from the spouse's own prior-Dec-31 (Dec 31, ${priorDec31Year}) pre-tax balance of ${fmtMoney(spouseBalance)}, on the spouse's own age clock.`,
          );
          if (
            ageSpouse != null &&
            rmdAgeSpouse != null &&
            ageSpouse < rmdAgeSpouse
          ) {
            warnings.push(
              `The spouse is ${ageSpouse} in ${scenario.taxYear}, below RMD age ${rmdAgeSpouse} for a ${scenario.birthYearSpouse} birth year — the spouse's RMD is $0 this year.`,
            );
          }
          if (sy.primarySoleBeneficiaryOfSpouse === true) {
            warnings.push(
              "The primary is the spouse's sole beneficiary (primarySoleBeneficiaryOfSpouse) — the spouse's RMD uses the Joint and Last Survivor Table when the primary is more than 10 years younger, otherwise the Uniform Lifetime Table.",
            );
          } else if (sy.primarySoleBeneficiaryOfSpouse === false) {
            warnings.push(
              "The primary is not the spouse's sole beneficiary — the spouse's RMD prices on the Uniform Lifetime Table.",
            );
          } else {
            warnings.push(
              "Whether the primary is the spouse's sole beneficiary was not established — the spouse's RMD prices on the Uniform Lifetime Table (the conservative direction).",
            );
          }
        }
      }
    }
    // rmdAlreadyReceived: the part of this year's computed RMD
    // already received AND already counted in the entered income.
    // The engine nets it out of the RMD it adds (floored at $0),
    // so a paid RMD is never counted twice — but only against a
    // computed RMD: with no balance entered there is nothing to
    // net it against.
    const rmdAlreadyReceived = sy.rmdAlreadyReceived ?? 0;
    if (rmdAlreadyReceived > 0) {
      if (primaryBalance == null && spouseBalance == null) {
        warnings.push(
          "An RMD already received was entered, but no prior-Dec-31 balance was entered — there is no computed RMD to net it against, so it has no effect on this price.",
        );
      } else {
        warnings.push(
          `${fmtMoney(rmdAlreadyReceived)} of this year's RMD was already received and already counted in the entered income — the engine nets it out of the RMD it adds (floored at $0), so it is not counted twice.`,
        );
      }
    }
    // One benchmark premium drives the ACA credit: single filer ->
    // single; household of 3+ -> family (falling back to couple);
    // otherwise couple.
    const benchmarkAnnual =
      scenario.filingStatus === "single"
        ? scenario.acaBenchmarkSingle
        : scenario.householdSize >= 3
          ? (scenario.acaBenchmarkFamily ?? scenario.acaBenchmarkCouple)
          : scenario.acaBenchmarkCouple;
    // Health premiums (Review 3 R3-S1): the single-year pricer
    // reads the ONE applicable marketplace amount in
    // healthPremiumAcaAnnual — the plan actually enrolled in for
    // the priced year — never the two tiers. Resolve it here,
    // mirroring the march's healthGrossAca tier rule
    // (taxEngine.ts): both spouses on the marketplace -> the
    // household tier; exactly one -> the single tier; nobody ->
    // none. A null applicable tier falls back to the year's
    // benchmark under the march's own benchmark rule (both on
    // ACA: family when a family figure is entered for a 3+
    // household, else couple; exactly one on ACA: single) —
    // exactly as the march does. The whole resolution is gated
    // on the term being active (premiumsCharged): with no
    // premium supplied the applicable amount is null and the
    // year prices no premium. The Medicare BASE premium is
    // passed through per person; the pricer multiplies it by
    // the persons on Medicare THIS year (the onMedicare flags),
    // and the IRMAA surcharge stays the forward block's own
    // figure, never folded into the base.
    const primaryOnAca = agePrimary < 65;
    const spouseOnAca =
      joint && ageSpouse != null && ageSpouse < 65;
    const anyOnAca = primaryOnAca || spouseOnAca;
    const bothOnAca = primaryOnAca && spouseOnAca;
    const benchmarkForPremium = bothOnAca
      ? scenario.householdSize >= 3 &&
        scenario.acaBenchmarkFamily != null
        ? scenario.acaBenchmarkFamily
        : scenario.acaBenchmarkCouple
      : anyOnAca
        ? scenario.acaBenchmarkSingle
        : null;
    const healthPremiumAcaAnnual =
      !scenario.premiumsCharged || !anyOnAca
        ? null
        : ((bothOnAca
            ? scenario.healthPremiumAcaHousehold
            : scenario.healthPremiumAcaSingle) ?? benchmarkForPremium);
    const healthPremiumMedicarePerPerson = scenario.premiumsCharged
      ? scenario.healthPremiumMedicarePerPerson
      : null;
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
      // Engine Review C9, Build 2 (W3): the scenario's own
      // Roth composition, so the single-year rothDraw prices
      // on the same facts as the plan march. Null = not
      // entered — the draw prices under the assumed-qualified
      // default with the result's rothBasisUnknown /
      // rothAssumedQualified flags saying so.
      rothBalance: scenario.singleYear.rothBalance ?? undefined,
      rothIraBalance: scenario.singleYear.rothIraBalance ?? undefined,
      rothEmployerBalance:
        scenario.singleYear.rothEmployerBalance ?? undefined,
      rothContributionBasis:
        scenario.singleYear.rothContributionBasis ?? undefined,
      rothConversionLots:
        scenario.singleYear.rothConversionLots ?? undefined,
      firstRothYear: scenario.singleYear.firstRothYear ?? undefined,
      firstDesignatedRothYear:
        scenario.singleYear.firstDesignatedRothYear ?? undefined,
      inflationPct: scenario.inflationPct,
      stockSold,
      stockBasis,
      qualifiedDividends: scenario.singleYear.qualifiedDividends,
      pretaxBalance: primaryBalance,
      pretaxBalanceSpouse: spouseBalance,
      rmdAlreadyReceived,
      // Engine Review 5, E5-S2: the deferral election + carry
      // price in the single-year pricer (the priced year is a
      // first RMD year when the owner's age is the year they
      // reach their RMD age); the response echoes the settled
      // amounts (rmdDeferred*), so a deferred year reads $0
      // RMD with the deferred amount named.
      firstRmdDeferralPrimary: sy.firstRmdDeferralPrimary ?? undefined,
      firstRmdDeferralSpouse: sy.firstRmdDeferralSpouse ?? undefined,
      firstRmdDeferredCarryPrimary:
        sy.firstRmdDeferredCarryPrimary ?? undefined,
      firstRmdDeferredCarrySpouse:
        sy.firstRmdDeferredCarrySpouse ?? undefined,
      primarySoleBeneficiaryOfSpouse: sy.primarySoleBeneficiaryOfSpouse,
      spouseSoleBeneficiary: joint,
      acaHouseholdSize: scenario.householdSize,
      acaBenchmarkAnnual: benchmarkAnnual,
      healthPremiumAcaAnnual,
      healthPremiumMedicarePerPerson,
      stateRatePct: scenario.stateRatePct,
      residenceState: scenario.residenceState,
      annualSpending: centsToDollars(scenario.annualSpendingCents),
    };
    // Same conditional premium warning as the compare tools: the
    // omitted case warns; the charged case is priced (no warning);
    // the included case is warned by normalize at the scenario level.
    warnings.push(...healthPremiumWarnings(scenario));
    const priced: PlaygroundYearResult = pricePlaygroundYear(inputs);
    // Engine Review C9, Build 2 (W3): a Roth draw priced
    // while the composition is unentered reads $0 income
    // and $0 penalty under the assumed-qualified default —
    // the result carries the flags, and the warning makes
    // the unknown visible here too instead of letting the
    // $0 pass silently.
    if (priced.rothBasisUnknown && scenario.singleYear.rothDraw > 0) {
      warnings.push(
        `Roth income and penalty are $0 but UNKNOWN for ${scenario.taxYear}: the Roth draw of ${fmtMoney(scenario.singleYear.rothDraw)} was priced while the Roth contribution basis, conversion lots, and first Roth year were not entered, so the $0 income and $0 penalty on it are unanswered questions, not computed $0s — the real tax depends on how much of the draw came from contributions (free), prior conversions (10% §72(t) penalty when under 59½ and inside 5 years), and earnings (ordinary income, plus 10% when under 59½, unless the distribution is qualified). Enter rothContributionBasis, rothConversionLots, and firstRothYear to price it.`,
      );
    }
    // Engine Review 6 (E6-S2): a priced year whose ACA MAGI
    // is under 100% FPL reads $0 credit under the standard
    // §36B income test — the aca block carries the flag and
    // the law-year eligibility note; the warning makes it
    // visible here too instead of letting the $0 pass
    // silently. (The single-year pricer has no IRMAA
    // lookback — its IRMAA block is the forward readout for
    // year + 2, always computable — so there is no unknown
    // lookback to warn about here.)
    if (priced.aca.below100Fpl) {
      // E6 NICEs fix — the response carries aca.credit NULL
      // when no benchmark premium was entered (the credit is
      // unpriced there), so the warning says "would be $0"
      // in that case and "is $0" only when a benchmark was
      // entered and the $0 was actually priced.
      warnings.push(
        `ACA credit ${priced.aca.credit == null ? "would be $0" : "is $0"} for ${scenario.taxYear} because household MAGI is under 100% of the federal poverty level — the standard §36B income test. No exception is modeled, and Medicaid eligibility is not modeled either, so do not read the $0 as a coverage decision.${priced.aca.credit == null ? " (No benchmark premium was entered, so no credit is priced here.)" : ""}`,
      );
    }
    // Post-price overlap checks (need the computed RMD, which
    // only the engine knows): the RMD is priced as income IN
    // ADDITION to the typed draws. A draw that already includes
    // the RMD would double-count it — rmdAlreadyReceivedAnnual
    // is the way to say so. The warning is conditional ("if …"),
    // because a draw beyond the RMD is a legitimate separate
    // distribution. It keys on the NET RMD actually added
    // (priced.rmd, gross minus rmdAlreadyReceived): when the
    // RMD is fully netted away there is nothing added beside
    // the draw, so no overlap warning fires, and a partially
    // netted RMD quotes only the net amount added.
    if (
      priced.rmd > 0 &&
      (scenario.singleYear.spendingDraw > 0 ||
        scenario.singleYear.conversion > 0)
    ) {
      const parts: string[] = [];
      if (scenario.singleYear.spendingDraw > 0) parts.push("spending draw");
      if (scenario.singleYear.conversion > 0) parts.push("conversion");
      warnings.push(
        `The RMD (${fmtMoney(priced.rmd)}) is priced as income in addition to the typed ${parts.join(" and ")} — if that draw already includes part of the RMD, pass the included amount as rmdAlreadyReceivedAnnual so it is not counted twice.`,
      );
    }
    // rmdGross is never negative (the engine's rmdForYear
    // returns 0 below RMD age or on a non-positive balance, and
    // balance / divisor otherwise; rmdGross is the sum of two
    // such non-negative RMDs), so no `>= 0` guard is needed here
    // — received > gross alone names the excess.
    if (rmdAlreadyReceived > priced.rmdGross) {
      warnings.push(
        `rmdAlreadyReceivedAnnual (${fmtMoney(rmdAlreadyReceived)}) exceeds the computed RMD (${fmtMoney(priced.rmdGross)}) — only ${fmtMoney(priced.rmdGross)} is netted; the excess has no effect.`,
      );
    }
    // The primarySoleBeneficiaryOfSpouse entry is emitted ONLY
    // when the caller actually gave the fact (true/false, user
    // provenance). When it is absent (null) there is no entry at
    // all — not even a "not established" assumption: an
    // assumption entry asserts something was assumed, and here
    // nothing was. The "not established" wording lives on in the
    // warning branch above, which still needs it (the spouse's
    // RMD prices Uniform either way, and the caller is told why).
    const extraAssumptions: Assumption[] = joint
      ? [
          assumption(
            "spouseSoleBeneficiary",
            true,
            "assumption",
            "The spouse is modeled as the primary's sole beneficiary, so the primary's RMD prices on the Joint and Last Survivor Table.",
          ),
          ...(sy.primarySoleBeneficiaryOfSpouse == null
            ? []
            : [
                assumption(
                  "primarySoleBeneficiaryOfSpouse",
                  sy.primarySoleBeneficiaryOfSpouse,
                  "user",
                  sy.primarySoleBeneficiaryOfSpouse === true
                    ? "The primary is the spouse's sole beneficiary, so the spouse's RMD uses the Joint and Last Survivor Table when the primary is more than 10 years younger, otherwise the Uniform Lifetime Table."
                    : "The primary is not the spouse's sole beneficiary, so the spouse's RMD prices on the Uniform Lifetime Table.",
                ),
              ]),
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
      "retirement_tax_year",
    );
  });
}
