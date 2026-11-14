// schema-consistency.test.ts — the advertised JSON Schema (what an AI
// client reads from tools/list) must agree exactly with the accepting
// zod schema (what normalizeInputs validates). A client following
// tools/list must never send a field the validator silently strips.
//
// Regression: the first build advertised ssPrimaryAnnual /
// ssPrimaryStartAge / ssSpouseAnnual / ssSpouseStartAge /
// expectedReturnPct / residenceState / a nested singleYear object /
// taxYear up to 2027 — none of which the validator accepts. A client
// following that schema priced a plan with no Social Security, no
// return override, and no single-year amounts. The fix reconciled
// tools.ts to schema.ts; this file pins the reconciliation.

import { describe, expect, test } from "bun:test";
import { BASE_INPUT_SCHEMA, dispatchTool } from "../src/tools";
import { latestTaxLawYear, normalizeInputs } from "../src/normalize";
import { TAX_LAW_YEARS } from "../../server/src/taxLaw";
import { RetirementQuestionInputs } from "../src/schema";
import { ESSENTIAL_KEYS, fictionalScenario } from "./helpers";

const zodKeys = Object.keys(RetirementQuestionInputs.shape).sort();

function schemaProps(): string[] {
  const props = (BASE_INPUT_SCHEMA as Record<string, unknown>)
    .properties as Record<string, unknown>;
  return Object.keys(props).sort();
}

describe("advertised schema == accepting schema", () => {
  test("BASE_INPUT_SCHEMA property names are exactly the zod keys", () => {
    expect(schemaProps()).toEqual(zodKeys);
  });

  test("BASE_INPUT_SCHEMA required list is exactly the six essentials", () => {
    expect(BASE_INPUT_SCHEMA.required).toEqual([...ESSENTIAL_KEYS]);
  });

  test("taxYear range in the advertised schema is derived from the law table", () => {
    const props = (BASE_INPUT_SCHEMA as Record<string, unknown>)
      .properties as Record<string, Record<string, unknown>>;
    expect(props.taxYear.maximum).toBe(latestTaxLawYear());
    expect(props.taxYear.minimum).toBe(
      Math.min(...TAX_LAW_YEARS.map((law) => law.year)),
    );
  });

  test("stateRatePct maximum is 50 in the advertised schema", () => {
    const props = (BASE_INPUT_SCHEMA as Record<string, unknown>)
      .properties as Record<string, Record<string, unknown>>;
    expect(props.stateRatePct.maximum).toBe(50);
  });

  test("compareAges is 2–5 items in the advertised schema", () => {
    const props = (BASE_INPUT_SCHEMA as Record<string, unknown>)
      .properties as Record<string, Record<string, unknown>>;
    expect(props.compareAges.minItems).toBe(2);
    expect(props.compareAges.maxItems).toBe(5);
  });

  test("the old advertised names appear nowhere in the schema", () => {
    const props = schemaProps();
    for (const old of [
      "ssPrimaryAnnual",
      "ssPrimaryStartAge",
      "ssSpouseAnnual",
      "ssSpouseStartAge",
      "expectedReturnPct",
      "residenceState",
      "singleYear",
      "cash",
      "startYear",
      "inflationPct",
    ]) {
      expect(props).not.toContain(old);
    }
  });

  test("every guide entry's required/optional names are zod keys", () => {
    const guide = dispatchTool("retirement_describe_capabilities", {});
    if (!guide.ok) throw new Error(JSON.stringify(guide.error));
    const tools = (guide.results as Record<string, unknown>).tools as Array<{
      name: string;
      required: string[];
      optional: string[];
    }>;
    expect(tools).toHaveLength(8);
    for (const t of tools) {
      for (const field of [...t.required, ...t.optional]) {
        expect(zodKeys).toContain(field);
      }
    }
  });

  test("guide optional lists contain only inputs each tool prices (pass-3 S1)", () => {
    // Priced sets, pinned: the sim engines read no tax inputs, the
    // tax-aware compare reads no strategy/volatility, the single-year
    // pricer reads no portfolio assumptions or retirementAge/endAge.
    // Sorted comparison — order in the list is not part of the contract.
    const sim = [
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
    const compare = [
      ...sim.filter(
        (f) => f !== "volatilityPct" && f !== "strategy",
      ),
      "filingStatus",
      "householdSize",
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
    const taxYear = [
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
    const expected: Record<string, string[]> = {
      retirement_calculate: sim.filter((f) => f !== "volatilityPct"),
      retirement_monte_carlo: [...sim, "mcRuns", "mcSeed"],
      retirement_max_spending: [...sim, "mcSeed"],
      retirement_compare_strategies: compare,
      retirement_roth_conversion: compare,
      retirement_work_years: [
        ...compare,
        "salaryAnnual",
        "employer401kAnnual",
        "employerHsaAnnual",
        "compareAges",
      ],
      retirement_tax_year: taxYear,
      retirement_describe_capabilities: [],
    };
    const guide = dispatchTool("retirement_describe_capabilities", {});
    if (!guide.ok) throw new Error(JSON.stringify(guide.error));
    const tools = (guide.results as Record<string, unknown>).tools as Array<{
      name: string;
      optional: string[];
    }>;
    for (const t of tools) {
      expect([...t.optional].sort()).toEqual([...expected[t.name]!].sort());
    }
  });

  test("every tool's example call normalizes ok:true", () => {
    const guide = dispatchTool("retirement_describe_capabilities", {});
    if (!guide.ok) throw new Error(JSON.stringify(guide.error));
    const tools = (guide.results as Record<string, unknown>).tools as Array<{
      name: string;
      exampleCall: Record<string, unknown>;
    }>;
    for (const t of tools) {
      if (t.name === "retirement_describe_capabilities") continue;
      const n = normalizeInputs(t.exampleCall);
      expect(n.ok).toBe(true);
      if (!n.ok) throw new Error(`${t.name} example failed: ${JSON.stringify(n.error)}`);
    }
  });
});

describe("canonical names land; old names are stripped", () => {
  test("socialSecurityAnnual / expectedRealReturnPct / state land with user provenance", () => {
    const n = normalizeInputs(
      fictionalScenario({
        expectedRealReturnPct: 5,
        volatilityPct: 15,
        stocksPct: 90,
        strategy: "constant",
        state: "WA",
      }),
    );
    expect(n.ok).toBe(true);
    if (!n.ok) throw new Error("fixture failed");
    expect(n.scenario.ssPrimaryAnnual).toBe(36000);
    expect(n.scenario.ssSpouseAnnual).toBe(18000);
    expect(n.scenario.ssPrimaryStartAge).toBe(67);
    expect(n.scenario.expectedReturnPct).toBe(5);
    expect(n.scenario.strategy).toBe("constant");
    expect(n.scenario.residenceState).toBe("WA");
  });

  test("flat single-year fields land in the scenario", () => {
    const n = normalizeInputs(
      fictionalScenario({
        interestAnnual: 1000,
        ordinaryDividendsAnnual: 5000,
        qualifiedDividendsAnnual: 3000,
        conversionAnnual: 20000,
        spendingDrawAnnual: 114000,
        cashDrawAnnual: 0,
        rothDrawAnnual: 0,
      }),
    );
    expect(n.ok).toBe(true);
    if (!n.ok) throw new Error("fixture failed");
    expect(n.scenario.singleYear).toEqual({
      interest: 1000,
      ordinaryDividends: 5000,
      qualifiedDividends: 3000,
      conversion: 20000,
      spendingDraw: 114000,
      cashDraw: 0,
      rothDraw: 0,
    });
  });

  test("old advertised names are stripped, not honored", () => {
    const raw = {
      pretax: 1250000,
      taxable: 2100000,
      roth: 375000,
      hsa: 62000,
      monthlySpending: 9500,
      currentAge: 54,
      spouseAge: 52,
      retirementAge: 58,
      endAge: 95,
      taxYear: 2026,
      ssPrimaryAnnual: 36000,
      ssPrimaryStartAge: 67,
      expectedReturnPct: 9,
    };
    const n = normalizeInputs(raw);
    expect(n.ok).toBe(true);
    if (!n.ok) throw new Error("fixture failed");
    // No Social Security was modeled (the old name was dropped).
    expect(n.scenario.ssPrimaryAnnual).toBe(0);
    expect(n.scenario.ssPrimaryStartAge).toBeNull();
    // The return fell back to the blended default at 95% stocks (6.75),
    // not the 9 the caller wrote under the old name.
    expect(n.scenario.expectedReturnPct).toBe(6.75);
  });

  test("taxYear 2027 is invalid_input, not a silent clamp", () => {
    const n = normalizeInputs(fictionalScenario({ taxYear: 2027 }));
    expect(n.ok).toBe(false);
    if (n.ok) throw new Error("2027 should not normalize");
    expect(n.error.error.code).toBe("invalid_input");
  });
});

describe("describeCapabilities reports the derived law year", () => {
  test("envelope + engine block use latestTaxLawYear() and the full table", () => {
    const guide = dispatchTool("retirement_describe_capabilities", {});
    if (!guide.ok) throw new Error(JSON.stringify(guide.error));
    expect(guide.taxLawYear).toBe(latestTaxLawYear());
    const engine = (guide.results as Record<string, unknown>)
      .engine as Record<string, unknown>;
    expect(engine.taxLawYear).toBe(latestTaxLawYear());
    expect(engine.lawYears).toEqual(TAX_LAW_YEARS.map((law) => law.year));
  });
});
