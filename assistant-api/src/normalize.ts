// normalize.ts — validation + dollars→cents conversion + defaults +
// missing-input detection for the stateless AI Retirement API adapter
// ("assistant-api").
//
// Pipeline:
//   1. Zod safeParse (schema.ts). A "required" failure on one of the
//      six essential keys maps to `missing_input` (with plain-language
//      questions); any other zod failure maps to `invalid_input`.
//      Error summaries name FIELDS ONLY — raw input values are never
//      echoed in an error, a log line, or a detail.
//   2. Cross-field missing checks (spouseAge for mfj; Social Security
//      start ages when an amount > 0 is given) → `missing_input`.
//   3. Cross-field guards (retirementAge / endAge ordering) →
//      `invalid_input`.
//   4. Resolve every default and build the NormalizedScenario.
//
// Every resolved field appends exactly one Assumption entry recording
// its provenance: "user" (caller supplied it), "assumption" (adapter
// convention), or "engine_constant" (a constant from the repo's
// engines, verified against the tree copy — see the notes). The adapter
// echoes user-supplied values in `effectiveInputs` and passes
// `assumptions` through; a field with no default applied is still
// recorded with provenance "user" so provenance never has to be
// inferred from absence.
//
// Engine facts used here (verified in the 2026-11-14 tree copy;
// CURRENT_LAW is imported — the newest published law row from taxLaw.ts,
// which has zero imports of its own — and so are the strategy-knob
// defaults from retirementEngines.ts (a pure module importing only
// its static historical-returns table); everything else is a local
// mirror):
// - server/src/retirementEngines.ts: STOCKS_PCT_DEFAULT = 95,
//   EXPECTED_RETURN_DEFAULT = 5 (flat default, NOT used here — see the
//   expected-return rule below), RETIREMENT_AGE_DEFAULT = 57,
//   MONTE_CARLO_TAB_SEED_DEFAULT = 12345, MONTE_CARLO_TAB_RUNS = 1000,
//   blendedExpected(s) = s/100*7 + (1-s/100)*2,
//   blendedVol(s) = s/100*18 + (1-s/100)*6,
//   end-age fallback `raw.endAge ?? 95`, guardrails defaults 120/80/10,
//   phased defaults 75/1.
// - server/src/taxLaw.ts: TAX_LAW_YEARS = [2025, 2026].
// - server/src/taxEngine.ts: untracked / new taxable money lands at
//   100% basis (blank-basis path — no gains on draws).

import { RetirementQuestionInputs } from "./schema.js";
import {
  GUARDRAILS_ADJUSTMENT_DEFAULT,
  GUARDRAILS_CUT_DEFAULT,
  GUARDRAILS_RAISE_DEFAULT,
  PHASE_DECLINE_PCT_DEFAULT,
  PHASE_START_AGE_DEFAULT,
} from "../../server/src/retirementEngines";
import { CURRENT_LAW } from "../../server/src/taxLaw";
import {
  ADAPTER_VERSION,
  API_CONTRACT_VERSION_REPORTED,
  type AdapterError,
  type Assumption,
  type FilingStatus,
  type Provenance,
  type ResidenceState,
  type SpendingStrategy,
} from "./types.js";

/** Frozen normalized-scenario shape: everything downstream of the
 *  adapter consumes this, in cents where the engine prices in cents
 *  and in dollars where the caller thinks in dollars. */
export interface NormalizedScenario {
  portfolioCents: number; // pretax+taxable+roth+hsa, cents (simulation pool)
  annualSpendingCents: number; // Math.round(monthlySpending*12*100)
  currentAge: number;
  retirementAge: number;
  endAge: number;
  birthYearPrimary: number;
  birthYearSpouse: number | null;
  filingStatus: "mfj" | "single" | "hoh";
  householdSize: number;
  stocksPct: number;
  expectedReturnPct: number;
  volatilityPct: number;
  strategy: "constant" | "guardrails" | "phased" | "percent";
  ssPrimaryAnnual: number;
  ssPrimaryStartAge: number | null;
  ssSpouseAnnual: number;
  ssSpouseStartAge: number | null;
  pretaxDollars: number;
  taxableDollars: number;
  rothDollars: number;
  hsaDollars: number;
  taxableBasisPct: number;
  taxableBasisBlank: boolean;
  taxableDividendYieldPct: number | null;
  taxableInterestYieldPct: number | null;
  otherOrdinaryAnnual: number;
  taxExemptInterestAnnual: number;
  acaBenchmarkCouple: number | null;
  acaBenchmarkSingle: number | null;
  acaBenchmarkFamily: number | null;
  stateRatePct: number;
  residenceState: "WA" | "other";
  stateLabel: string | null;
  taxYear: number;
  startYear: number;
  salaryAnnual: number | null;
  employer401kAnnual: number;
  employerHsaAnnual: number;
  inflationPct: number; // 0 — all figures in today's dollars (assumption, documented)
  singleYear: {
    interest: number;
    ordinaryDividends: number;
    qualifiedDividends: number;
    conversion: number;
    spendingDraw: number;
    cashDraw: number;
    rothDraw: number;
  };
  mcSeed: number;
  mcRuns: number;
  compareAges: number[];
  assumptions: Assumption[];
  warnings: string[];
}

/** Keys whose omission is a `missing_input` error, not a validation
 *  error. An explicit 0 counts as present. */
const ESSENTIAL_KEYS = [
  "pretax",
  "taxable",
  "roth",
  "hsa",
  "monthlySpending",
  "currentAge",
] as const;

/**
 * Plain-language questions for every field a `missing_input` error can
 * name, phrased so the AI can ask the user directly. Wordings are the
 * frozen contract wordings — do not rephrase.
 */
export const MISSING_INPUT_QUESTIONS: Record<string, string> = {
  pretax:
    "How much do you have in pre-tax retirement accounts, like a 401(k) or IRA?",
  taxable: "How much do you have in taxable brokerage accounts?",
  roth: "How much do you have in Roth accounts?",
  hsa: "How much do you have in your HSA?",
  monthlySpending: "How much do you spend in a typical month?",
  currentAge: "How old are you?",
  spouseAge: "How old is your spouse?",
  socialSecurityStartAge:
    "At what age do you plan to start collecting Social Security?",
  spouseSocialSecurityStartAge:
    "At what age does your spouse plan to start collecting Social Security?",
};

/** One `{ field, question }` entry per missing field, in field order. */
export function questionsForFields(
  fields: string[],
): Array<{ field: string; question: string }> {
  return fields.map((field) => ({
    field,
    question:
      MISSING_INPUT_QUESTIONS[field] ?? `Please provide ${field}.`,
  }));
}

/** Convert dollars to integer cents. Rejects non-finite input. */
export function dollarsToCents(dollars: number): number {
  if (!Number.isFinite(dollars)) {
    throw new Error("dollarsToCents: non-finite dollar amount");
  }
  return Math.round(dollars * 100);
}

/**
 * Local mirror of the engine's blendedExpected(stocksPct) in
 * server/src/retirementEngines.ts: stocks% × 7% + bonds% × 2%.
 * Kept local (not imported) so this layer has no server/ dependency;
 * the formula was verified against the tree copy and the adapter
 * re-derives it through the real engine function.
 */
export function blendedExpectedPct(stocksPct: number): number {
  return (stocksPct / 100) * 7 + (1 - stocksPct / 100) * 2;
}

/**
 * Local mirror of the engine's blendedVol(stocksPct) in
 * server/src/retirementEngines.ts: stocks% × 18% + bonds% × 6%.
 */
export function blendedVolPct(stocksPct: number): number {
  return (stocksPct / 100) * 18 + (1 - stocksPct / 100) * 6;
}

/** Latest published tax-law year, from the engine's CURRENT_LAW row. */
export function latestTaxLawYear(): number {
  return CURRENT_LAW.year;
}

function missingInputError(missing: string[]): AdapterError {
  return {
    ok: false,
    source: "finance-planner-engine",
    adapterVersion: ADAPTER_VERSION,
    apiContractVersion: API_CONTRACT_VERSION_REPORTED,
    error: {
      code: "missing_input",
      message: `Missing required input: ${missing.join(", ")}.`,
      missing,
      questions: questionsForFields(missing),
    },
  };
}

function invalidInputError(message: string, details: unknown): AdapterError {
  return {
    ok: false,
    source: "finance-planner-engine",
    adapterVersion: ADAPTER_VERSION,
    apiContractVersion: API_CONTRACT_VERSION_REPORTED,
    error: {
      code: "invalid_input",
      message,
      details,
    },
  };
}

/**
 * Validate + normalize raw caller input into a NormalizedScenario.
 *
 * Returns `{ ok: true, scenario }` on success, or `{ ok: false, error }`
 * with a `missing_input` / `invalid_input` AdapterError. No calculation
 * is performed when required input is missing.
 */
export function normalizeInputs(
  raw: unknown,
):
  | { ok: true; scenario: NormalizedScenario }
  | { ok: false; error: AdapterError } {
  // ---- Step 1: zod validation. ----
  const parsed = RetirementQuestionInputs.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues;
    // A "required" failure is zod v4's invalid_type with a message
    // ending in "received undefined" (a present-but-wrong-typed value
    // says "received string"/"received null" instead). Only the
    // six essential keys map to missing_input; everything else is
    // invalid_input.
    const missingEssential: string[] = [];
    for (const issue of issues) {
      const field = issue.path[0];
      if (
        typeof field === "string" &&
        (ESSENTIAL_KEYS as readonly string[]).includes(field) &&
        issue.code === "invalid_type" &&
        issue.message.includes("received undefined") &&
        !missingEssential.includes(field)
      ) {
        missingEssential.push(field);
      }
    }
    if (missingEssential.length > 0) {
      // Report in schema order for a stable, predictable message.
      const ordered = ESSENTIAL_KEYS.filter((k) =>
        missingEssential.includes(k),
      );
      return { ok: false, error: missingInputError(ordered) };
    }
    // Field names + messages only — never the caller's values.
    const details = issues.map((issue) => ({
      field: issue.path.length > 0 ? issue.path.join(".") : "(input)",
      message: issue.message,
    }));
    const fields = [...new Set(details.map((d) => d.field))];
    return {
      ok: false,
      error: invalidInputError(
        `Invalid input in: ${fields.join(", ")}.`,
        details,
      ),
    };
  }

  const input = parsed.data;
  const assumptions: Assumption[] = [];
  const warnings: string[] = [];
  const record = (
    field: string,
    value: unknown,
    provenance: Provenance,
    note: string,
  ): void => {
    assumptions.push({ field, value, provenance, note });
  };

  // ---- Step 2: cross-field missing checks. ----
  const filingStatus: FilingStatus = input.filingStatus ?? "mfj";
  const isMfj = filingStatus === "mfj";
  const missing: string[] = [];
  if (isMfj && input.spouseAge === undefined) missing.push("spouseAge");
  const ssPrimaryAnnual = input.socialSecurityAnnual ?? 0;
  if (ssPrimaryAnnual > 0 && input.socialSecurityStartAge === undefined) {
    missing.push("socialSecurityStartAge");
  }
  const ssSpouseAnnualRaw = input.spouseSocialSecurityAnnual ?? 0;
  if (
    isMfj &&
    ssSpouseAnnualRaw > 0 &&
    input.spouseSocialSecurityStartAge === undefined
  ) {
    missing.push("spouseSocialSecurityStartAge");
  }
  if (missing.length > 0) {
    return { ok: false, error: missingInputError(missing) };
  }

  // ---- Step 3: cross-field guards (retirement horizon must exist). ----
  const currentAge = input.currentAge;
  const retirementAge = input.retirementAge ?? currentAge;
  const endAge = input.endAge ?? 95;
  if (retirementAge < currentAge) {
    return {
      ok: false,
      error: invalidInputError(
        "retirementAge must not be before currentAge.",
        [{ field: "retirementAge", message: "must not be before currentAge" }],
      ),
    };
  }
  if (endAge <= retirementAge) {
    return {
      ok: false,
      error: invalidInputError(
        "endAge must be after retirementAge (the plan needs retired years to price).",
        [{ field: "endAge", message: "must be after retirementAge" }],
      ),
    };
  }
  if (endAge > 120) {
    return {
      ok: false,
      error: invalidInputError(
        "endAge must be 120 or less.",
        [{ field: "endAge", message: "must be 120 or less" }],
      ),
    };
  }
  // Compare ages must be live choices: at or after the current age
  // and before the end age. (The adapter also filters, but a past
  // age is an invalid input, not a silent drop.)
  for (const a of input.compareAges ?? []) {
    if (a < currentAge || a >= endAge) {
      return {
        ok: false,
        error: invalidInputError(
          `compareAges must be at or after currentAge (${currentAge}) and before endAge (${endAge}); got ${a}.`,
          [
            {
              field: "compareAges",
              message: `must be ${currentAge}–${endAge - 1}`,
            },
          ],
        ),
      };
    }
  }

  // ---- Step 4: resolve defaults and build the scenario. ----
  const startYear = new Date().getFullYear();
  // The default tax year is the current year clamped to the latest
  // published law year, so from 2027 the default never names a year
  // the tables don't cover (S3).
  const taxYear = input.taxYear ?? Math.min(startYear, latestTaxLawYear());

  // --- Balances (dollars in, cents out). ---
  const pretaxDollars = input.pretax;
  const taxableDollars = input.taxable;
  const rothDollars = input.roth;
  const hsaDollars = input.hsa;
  record("pretax", pretaxDollars, "user", "Provided by caller.");
  record("taxable", taxableDollars, "user", "Provided by caller.");
  record("roth", rothDollars, "user", "Provided by caller.");
  record("hsa", hsaDollars, "user", "Provided by caller.");
  const portfolioCents =
    dollarsToCents(pretaxDollars) +
    dollarsToCents(taxableDollars) +
    dollarsToCents(rothDollars) +
    dollarsToCents(hsaDollars);

  // --- Spending. ---
  const monthlySpending = input.monthlySpending;
  record("monthlySpending", monthlySpending, "user", "Provided by caller.");
  const annualSpendingCents = Math.round(monthlySpending * 12 * 100);

  // --- Ages. ---
  record("currentAge", currentAge, "user", "Provided by caller.");
  if (input.retirementAge === undefined) {
    record(
      "retirementAge",
      retirementAge,
      "assumption",
      "No retirement age given — retire now (retirementAge = currentAge).",
    );
  } else {
    record("retirementAge", retirementAge, "user", "Provided by caller.");
  }
  if (input.endAge === undefined) {
    record(
      "endAge",
      endAge,
      "engine_constant",
      "Engine default end age 95 (retirementEngines.ts: raw.endAge ?? 95).",
    );
  } else {
    record("endAge", endAge, "user", "Provided by caller.");
  }
  const birthYearPrimary = startYear - currentAge;
  record(
    "birthYearPrimary",
    birthYearPrimary,
    "assumption",
    "Derived as startYear − currentAge (startYear is the current calendar year).",
  );

  // --- Filing status / household. ---
  if (input.filingStatus === undefined) {
    record(
      "filingStatus",
      filingStatus,
      "assumption",
      'No filing status given — assumed "mfj".',
    );
  } else {
    record("filingStatus", filingStatus, "user", "Provided by caller.");
  }
  const householdSize =
    input.householdSize ?? (isMfj ? 2 : 1);
  if (input.householdSize === undefined) {
    record(
      "householdSize",
      householdSize,
      "assumption",
      isMfj
        ? 'No household size given — assumed 2 for "mfj".'
        : 'No household size given — assumed 1 for single/hoh.',
    );
  } else {
    record("householdSize", householdSize, "user", "Provided by caller.");
  }

  // --- Spouse age / birth year. ---
  let birthYearSpouse: number | null = null;
  if (isMfj) {
    const spouseAge = input.spouseAge as number; // required above
    record("spouseAge", spouseAge, "user", "Provided by caller.");
    birthYearSpouse = startYear - spouseAge;
    record(
      "birthYearSpouse",
      birthYearSpouse,
      "assumption",
      "Derived as startYear − spouseAge (startYear is the current calendar year).",
    );
  } else {
    if (input.spouseAge !== undefined) {
      warnings.push(
        "spouseAge is ignored for single/hoh filing status.",
      );
    }
    record(
      "spouseAge",
      null,
      "assumption",
      "No spouse modeled for single/hoh filing status.",
    );
    record(
      "birthYearSpouse",
      null,
      "assumption",
      "No spouse modeled for single/hoh filing status.",
    );
  }

  // --- Market assumptions: stocks mix, then return / volatility. ---
  const stocksPct = input.stocksPct ?? 95;
  if (input.stocksPct === undefined) {
    record(
      "stocksPct",
      stocksPct,
      "engine_constant",
      "Engine default stock mix 95% (retirementEngines.ts STOCKS_PCT_DEFAULT).",
    );
  } else {
    record("stocksPct", stocksPct, "user", "Provided by caller.");
  }
  // NOTE: an omitted expected return resolves to the engine's
  // blendedExpected(stocksPct), NOT the flat EXPECTED_RETURN_DEFAULT
  // (5%) — the blend is what the engine prices with when no return is
  // saved, and the adapter re-derives it via the real engine function.
  const expectedReturnPct =
    input.expectedRealReturnPct ?? blendedExpectedPct(stocksPct);
  if (input.expectedRealReturnPct === undefined) {
    record(
      "expectedRealReturnPct",
      expectedReturnPct,
      "engine_constant",
      "Derived from the stock mix by the engine's blendedExpected: stocks% × 7% + bonds% × 2%.",
    );
  } else {
    record(
      "expectedRealReturnPct",
      expectedReturnPct,
      "user",
      "Provided by caller — the engine's stock-mix blend derivation is bypassed.",
    );
  }
  const volatilityPct =
    input.volatilityPct ?? blendedVolPct(stocksPct);
  if (input.volatilityPct === undefined) {
    record(
      "volatilityPct",
      volatilityPct,
      "engine_constant",
      "Derived from the stock mix by the engine's blendedVol: stocks% × 18% + bonds% × 6%.",
    );
  } else {
    record(
      "volatilityPct",
      volatilityPct,
      "user",
      "Provided by caller — the engine's stock-mix blend derivation is bypassed.",
    );
  }

  // --- Strategy. ---
  const strategy: SpendingStrategy = input.strategy ?? "constant";
  if (input.strategy === undefined) {
    record(
      "strategy",
      strategy,
      "assumption",
      'No strategy given — assumed "constant" spending.',
    );
  } else {
    record("strategy", strategy, "user", "Provided by caller.");
  }

  // --- Strategy sub-parameters (engine defaults, disclosed). ---
  // toSimInputs prices these knobs from the engine's defaults, so
  // they are recorded here as engine_constant assumptions instead
  // of silently applying. Each knob applies only when its strategy
  // is the selected one; "constant" records none of them.
  if (strategy === "percent") {
    record(
      "percentOfPortfolio",
      5,
      "engine_constant",
      'The "percent" strategy spends 5% of the start-of-year balance each year (engine default, retirementEngines.ts).',
    );
  } else if (strategy === "guardrails") {
    record(
      "guardrailsCutPct",
      GUARDRAILS_CUT_DEFAULT,
      "engine_constant",
      "Guardrails cut spending 10% when the year's spending rate tops 120% of the starting rate (engine default).",
    );
    record(
      "guardrailsRaisePct",
      GUARDRAILS_RAISE_DEFAULT,
      "engine_constant",
      "Guardrails raise spending 10% when the year's spending rate falls below 80% of the starting rate (engine default).",
    );
    record(
      "guardrailsAdjustmentPct",
      GUARDRAILS_ADJUSTMENT_DEFAULT,
      "engine_constant",
      "Guardrails adjust spending by 10% per rail hit, at most one adjustment a year (engine default).",
    );
  } else if (strategy === "phased") {
    record(
      "phaseStartAge",
      PHASE_START_AGE_DEFAULT,
      "engine_constant",
      "Phased spending stays flat until age 75, then steps down each year (engine default).",
    );
    record(
      "phaseDeclinePct",
      PHASE_DECLINE_PCT_DEFAULT,
      "engine_constant",
      "Phased spending declines 1% a year after the step-down start age (engine default).",
    );
  }

  // --- Social Security. ---
  let ssPrimaryStartAge: number | null = null;
  if (input.socialSecurityAnnual === undefined) {
    record(
      "socialSecurityAnnual",
      0,
      "assumption",
      "No Social Security modeled — none provided.",
    );
  } else {
    record(
      "socialSecurityAnnual",
      ssPrimaryAnnual,
      "user",
      "Provided by caller.",
    );
  }
  if (ssPrimaryAnnual > 0) {
    ssPrimaryStartAge = input.socialSecurityStartAge as number; // required above
    record(
      "socialSecurityStartAge",
      ssPrimaryStartAge,
      "user",
      "Provided by caller.",
    );
  } else {
    record(
      "socialSecurityStartAge",
      null,
      "assumption",
      "No start age applies — no Social Security modeled.",
    );
  }
  let ssSpouseAnnual = 0;
  let ssSpouseStartAge: number | null = null;
  if (isMfj) {
    if (input.spouseSocialSecurityAnnual === undefined) {
      record(
        "spouseSocialSecurityAnnual",
        0,
        "assumption",
        "No spouse Social Security modeled — none provided.",
      );
    } else {
      ssSpouseAnnual = ssSpouseAnnualRaw;
      record(
        "spouseSocialSecurityAnnual",
        ssSpouseAnnual,
        "user",
        "Provided by caller.",
      );
    }
    if (ssSpouseAnnual > 0) {
      ssSpouseStartAge = input.spouseSocialSecurityStartAge as number; // required above
      record(
        "spouseSocialSecurityStartAge",
        ssSpouseStartAge,
        "user",
        "Provided by caller.",
      );
    } else {
      record(
        "spouseSocialSecurityStartAge",
        null,
        "assumption",
        "No start age applies — no spouse Social Security modeled.",
      );
    }
  } else {
    if (input.spouseSocialSecurityAnnual !== undefined) {
      warnings.push(
        "Spouse Social Security is ignored for single/hoh filing status.",
      );
    }
    record(
      "spouseSocialSecurityAnnual",
      0,
      "assumption",
      "No spouse Social Security modeled for single/hoh filing status.",
    );
    record(
      "spouseSocialSecurityStartAge",
      null,
      "assumption",
      "No spouse Social Security modeled for single/hoh filing status.",
    );
  }

  // --- Taxable basis. ---
  const taxableBasisBlank = input.taxableBasisPct === undefined;
  const taxableBasisPct = input.taxableBasisPct ?? 100;
  if (taxableBasisBlank) {
    record(
      "taxableBasisPct",
      100,
      "assumption",
      "No basis provided — modeled as 100% basis, no gains on draws (engine blank-basis path: untracked taxable money lands at 100% basis).",
    );
  } else {
    record("taxableBasisPct", taxableBasisPct, "user", "Provided by caller.");
  }
  record(
    "taxableBasisBlank",
    taxableBasisBlank,
    "assumption",
    taxableBasisBlank
      ? "Basis was not provided, so the 100% basis above is an assumption."
      : "Basis was provided by the caller.",
  );

  // --- Taxable yields (null = none modeled; explicit 0 is user data). ---
  if (input.taxableDividendYieldPct === undefined) {
    record(
      "taxableDividendYieldPct",
      null,
      "assumption",
      "No taxable yield modeled — dividends/interest $0.",
    );
  } else {
    record(
      "taxableDividendYieldPct",
      input.taxableDividendYieldPct,
      "user",
      "Provided by caller.",
    );
  }
  if (input.taxableInterestYieldPct === undefined) {
    record(
      "taxableInterestYieldPct",
      null,
      "assumption",
      "No taxable yield modeled — dividends/interest $0.",
    );
  } else {
    record(
      "taxableInterestYieldPct",
      input.taxableInterestYieldPct,
      "user",
      "Provided by caller.",
    );
  }

  // --- Other annual income. ---
  const otherOrdinaryAnnual = input.otherOrdinaryAnnual ?? 0;
  if (input.otherOrdinaryAnnual === undefined) {
    record(
      "otherOrdinaryAnnual",
      0,
      "assumption",
      "No amount entered — $0.",
    );
  } else {
    record(
      "otherOrdinaryAnnual",
      otherOrdinaryAnnual,
      "user",
      "Provided by caller.",
    );
  }
  const taxExemptInterestAnnual = input.taxExemptInterestAnnual ?? 0;
  if (input.taxExemptInterestAnnual === undefined) {
    record(
      "taxExemptInterestAnnual",
      0,
      "assumption",
      "No amount entered — $0.",
    );
  } else {
    record(
      "taxExemptInterestAnnual",
      taxExemptInterestAnnual,
      "user",
      "Provided by caller.",
    );
  }

  // --- ACA benchmarks. ---
  const acaBenchmarkCouple = input.acaBenchmarkCouple ?? null;
  const acaBenchmarkSingle = input.acaBenchmarkSingle ?? null;
  const acaBenchmarkFamily = input.acaBenchmarkFamily ?? null;
  for (const [field, value] of [
    ["acaBenchmarkCouple", acaBenchmarkCouple],
    ["acaBenchmarkSingle", acaBenchmarkSingle],
    ["acaBenchmarkFamily", acaBenchmarkFamily],
  ] as const) {
    if (value === null) {
      record(
        field,
        null,
        "assumption",
        "No ACA benchmark provided for this household size — no credit modeled for it.",
      );
    } else {
      record(field, value, "user", "Provided by caller.");
    }
  }
  if (
    acaBenchmarkCouple === null &&
    acaBenchmarkSingle === null &&
    acaBenchmarkFamily === null
  ) {
    warnings.push(
      "No ACA benchmark provided — ACA premium credits are not modeled (credit $0).",
    );
  }

  // --- State tax. ---
  const rawState =
    input.state === undefined ? "" : input.state.trim();
  let residenceState: ResidenceState = "other";
  let stateRatePct = 0;
  let stateLabel: string | null = null;
  if (rawState === "") {
    record(
      "state",
      null,
      "assumption",
      "No state given — no state tax modeled.",
    );
    stateRatePct = input.stateRatePct ?? 0;
    if (input.stateRatePct === undefined) {
      record(
        "stateRatePct",
        0,
        "assumption",
        "No state given — no state tax modeled.",
      );
    } else {
      record(
        "stateRatePct",
        stateRatePct,
        "user",
        "Provided by caller, but no state was given so no state tax is modeled.",
      );
    }
  } else if (
    rawState.toLowerCase() === "wa" ||
    rawState.toLowerCase() === "washington"
  ) {
    residenceState = "WA";
    stateLabel = "WA";
    record("state", "WA", "user", "Provided by caller (normalized to WA).");
    stateRatePct = input.stateRatePct ?? 0;
    if (input.stateRatePct === undefined) {
      record(
        "stateRatePct",
        0,
        "assumption",
        "WA — no income-tax rate applies; the engine prices WA via the WA excise path.",
      );
    } else {
      warnings.push(
        "A state tax rate was supplied for WA but is ignored — the engine prices WA via the WA excise path, not an income-tax rate.",
      );
      record(
        "stateRatePct",
        stateRatePct,
        "user",
        "Provided by caller, but ignored for WA — the engine prices WA via the WA excise path.",
      );
    }
  } else {
    residenceState = "other";
    stateLabel =
      rawState.length === 2 ? rawState.toUpperCase() : rawState;
    record("state", stateLabel, "user", "Provided by caller.");
    stateRatePct = input.stateRatePct ?? 0;
    if (input.stateRatePct === undefined) {
      warnings.push(
        "No state tax rate provided — state tax modeled as $0.",
      );
      record(
        "stateRatePct",
        0,
        "assumption",
        "No state rate provided — state tax modeled as $0.",
      );
    } else {
      record("stateRatePct", stateRatePct, "user", "Provided by caller.");
    }
  }
  record(
    "residenceState",
    residenceState,
    "assumption",
    residenceState === "WA"
      ? "Washington residence — WA excise path."
      : "Non-WA residence — state income-tax rate applies (if given).",
  );

  // --- Tax year / start year. ---
  record("startYear", startYear, "assumption", "Current calendar year.");
  if (input.taxYear === undefined) {
    record(
      "taxYear",
      taxYear,
      "assumption",
      startYear > latestTaxLawYear()
        ? `No tax year given — defaults to the latest published law year (${taxYear}); the current year (${startYear}) is beyond the published tables.`
        : "No tax year given — defaults to the current calendar year (startYear).",
    );
  } else {
    record("taxYear", taxYear, "user", "Provided by caller.");
  }

  // --- Work-years inputs. ---
  // salaryAnnual stays null when omitted: it is only needed by the
  // work-years tool, and the adapter's work-years function returns
  // missing_input if salary is null — it is NOT missing_input here.
  const salaryAnnual = input.salaryAnnual ?? null;
  if (input.salaryAnnual === undefined) {
    record(
      "salaryAnnual",
      null,
      "assumption",
      "Not provided — only needed by the work-years tool.",
    );
  } else {
    record("salaryAnnual", salaryAnnual, "user", "Provided by caller.");
  }
  const employer401kAnnual = input.employer401kAnnual ?? 0;
  if (input.employer401kAnnual === undefined) {
    record(
      "employer401kAnnual",
      0,
      "assumption",
      "No amount entered — $0.",
    );
  } else {
    record(
      "employer401kAnnual",
      employer401kAnnual,
      "user",
      "Provided by caller.",
    );
  }
  const employerHsaAnnual = input.employerHsaAnnual ?? 0;
  if (input.employerHsaAnnual === undefined) {
    record(
      "employerHsaAnnual",
      0,
      "assumption",
      "No amount entered — $0.",
    );
  } else {
    record(
      "employerHsaAnnual",
      employerHsaAnnual,
      "user",
      "Provided by caller.",
    );
  }

  // --- Inflation: always 0 (today's dollars). ---
  record(
    "inflationPct",
    0,
    "assumption",
    "Today's dollars; law rows deflate non-indexed figures at 0%.",
  );

  // --- Single-year tax inputs (each defaults to $0). ---
  const singleYear = {
    interest: input.interestAnnual ?? 0,
    ordinaryDividends: input.ordinaryDividendsAnnual ?? 0,
    qualifiedDividends: input.qualifiedDividendsAnnual ?? 0,
    conversion: input.conversionAnnual ?? 0,
    spendingDraw: input.spendingDrawAnnual ?? 0,
    cashDraw: input.cashDrawAnnual ?? 0,
    rothDraw: input.rothDrawAnnual ?? 0,
  };
  const singleYearInputs = [
    ["singleYear.interest", input.interestAnnual, singleYear.interest],
    [
      "singleYear.ordinaryDividends",
      input.ordinaryDividendsAnnual,
      singleYear.ordinaryDividends,
    ],
    [
      "singleYear.qualifiedDividends",
      input.qualifiedDividendsAnnual,
      singleYear.qualifiedDividends,
    ],
    ["singleYear.conversion", input.conversionAnnual, singleYear.conversion],
    [
      "singleYear.spendingDraw",
      input.spendingDrawAnnual,
      singleYear.spendingDraw,
    ],
    ["singleYear.cashDraw", input.cashDrawAnnual, singleYear.cashDraw],
    ["singleYear.rothDraw", input.rothDrawAnnual, singleYear.rothDraw],
  ] as const;
  for (const [field, rawValue, value] of singleYearInputs) {
    if (rawValue === undefined) {
      record(field, value, "assumption", "No amount entered — $0.");
    } else {
      record(field, value, "user", "Provided by caller.");
    }
  }

  // --- Monte Carlo. ---
  const mcSeed = input.mcSeed ?? 12345;
  if (input.mcSeed === undefined) {
    record(
      "mcSeed",
      mcSeed,
      "engine_constant",
      "Engine default Monte Carlo seed 12345 (MONTE_CARLO_TAB_SEED_DEFAULT).",
    );
  } else {
    record("mcSeed", mcSeed, "user", "Provided by caller.");
  }
  const mcRuns = input.mcRuns ?? 1000;
  if (input.mcRuns === undefined) {
    record(
      "mcRuns",
      mcRuns,
      "engine_constant",
      "Engine default Monte Carlo runs 1000 (MONTE_CARLO_TAB_RUNS).",
    );
  } else {
    record("mcRuns", mcRuns, "user", "Provided by caller.");
  }

  // --- Compare ages: [] here (the adapter defaults to
  // [retirementAge, retirementAge+2, retirementAge+5]); no assumption
  // entry when omitted, per spec. ---
  const compareAges = input.compareAges ?? [];
  if (input.compareAges !== undefined) {
    record("compareAges", compareAges, "user", "Provided by caller.");
  }

  const scenario: NormalizedScenario = {
    portfolioCents,
    annualSpendingCents,
    currentAge,
    retirementAge,
    endAge,
    birthYearPrimary,
    birthYearSpouse,
    filingStatus,
    householdSize,
    stocksPct,
    expectedReturnPct,
    volatilityPct,
    strategy,
    ssPrimaryAnnual,
    ssPrimaryStartAge,
    ssSpouseAnnual,
    ssSpouseStartAge,
    pretaxDollars,
    taxableDollars,
    rothDollars,
    hsaDollars,
    taxableBasisPct,
    taxableBasisBlank,
    taxableDividendYieldPct: input.taxableDividendYieldPct ?? null,
    taxableInterestYieldPct: input.taxableInterestYieldPct ?? null,
    otherOrdinaryAnnual,
    taxExemptInterestAnnual,
    acaBenchmarkCouple,
    acaBenchmarkSingle,
    acaBenchmarkFamily,
    stateRatePct,
    residenceState,
    stateLabel,
    taxYear,
    startYear,
    salaryAnnual,
    employer401kAnnual,
    employerHsaAnnual,
    inflationPct: 0,
    singleYear,
    mcSeed,
    mcRuns,
    compareAges,
    assumptions,
    warnings,
  };
  return { ok: true, scenario };
}

/**
 * User-facing view of a normalized scenario, in DOLLARS (the units the
 * caller thinks in). The adapter uses this for `effectiveInputs`.
 * Internal cent fields are not included, except through their dollar
 * equivalents (annualSpending / portfolioDollars); provenance lives in
 * `scenario.assumptions`, not here.
 */
export function publicEffectiveInputs(
  scenario: NormalizedScenario,
): Record<string, unknown> {
  const monthlySpending =
    Math.round(scenario.annualSpendingCents / 12) / 100;
  return {
    pretax: scenario.pretaxDollars,
    taxable: scenario.taxableDollars,
    roth: scenario.rothDollars,
    hsa: scenario.hsaDollars,
    portfolioDollars:
      scenario.pretaxDollars +
      scenario.taxableDollars +
      scenario.rothDollars +
      scenario.hsaDollars,
    monthlySpending,
    annualSpending: scenario.annualSpendingCents / 100,
    currentAge: scenario.currentAge,
    spouseAge:
      scenario.birthYearSpouse === null
        ? null
        : scenario.startYear - scenario.birthYearSpouse,
    retirementAge: scenario.retirementAge,
    endAge: scenario.endAge,
    birthYearPrimary: scenario.birthYearPrimary,
    birthYearSpouse: scenario.birthYearSpouse,
    filingStatus: scenario.filingStatus,
    householdSize: scenario.householdSize,
    stocksPct: scenario.stocksPct,
    expectedRealReturnPct: scenario.expectedReturnPct,
    volatilityPct: scenario.volatilityPct,
    strategy: scenario.strategy,
    socialSecurityAnnual: scenario.ssPrimaryAnnual,
    socialSecurityStartAge: scenario.ssPrimaryStartAge,
    spouseSocialSecurityAnnual: scenario.ssSpouseAnnual,
    spouseSocialSecurityStartAge: scenario.ssSpouseStartAge,
    taxableBasisPct: scenario.taxableBasisPct,
    taxableBasisBlank: scenario.taxableBasisBlank,
    taxableDividendYieldPct: scenario.taxableDividendYieldPct,
    taxableInterestYieldPct: scenario.taxableInterestYieldPct,
    otherOrdinaryAnnual: scenario.otherOrdinaryAnnual,
    taxExemptInterestAnnual: scenario.taxExemptInterestAnnual,
    acaBenchmarkCouple: scenario.acaBenchmarkCouple,
    acaBenchmarkSingle: scenario.acaBenchmarkSingle,
    acaBenchmarkFamily: scenario.acaBenchmarkFamily,
    state: scenario.stateLabel,
    residenceState: scenario.residenceState,
    stateRatePct: scenario.stateRatePct,
    taxYear: scenario.taxYear,
    startYear: scenario.startYear,
    salaryAnnual: scenario.salaryAnnual,
    employer401kAnnual: scenario.employer401kAnnual,
    employerHsaAnnual: scenario.employerHsaAnnual,
    inflationPct: scenario.inflationPct,
    singleYear: { ...scenario.singleYear },
    mcSeed: scenario.mcSeed,
    mcRuns: scenario.mcRuns,
    compareAges: [...scenario.compareAges],
  };
}
