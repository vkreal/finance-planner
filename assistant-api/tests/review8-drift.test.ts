// review8-drift.test.ts — Review 8 S1 drift check.
//
// The mapping table in pricedInputs.ts is the single source of
// truth for which fields each tool prices. Three surfaces must
// agree with it, or a caller is misled about what changes an
// answer:
//   1. the MCP JSON Schema (BASE_INPUT_SCHEMA in tools.ts) — the
//      advertised field set,
//   2. the capability guide's per-tool optional lists
//      (retirement_describe_capabilities),
//   3. the tool descriptions' "does not change this answer" prose
//      (checked coarsely: each financial tool's description must
//      carry an inert-input disclaimer naming the effect, so a
//      description that silently drops the disclaimer fails).
// These tests fail if any of the three drifts from the table.
// The table itself is pinned against the engines in
// schema-consistency.test.ts ("guide optional lists contain only
// inputs each tool prices") and in review8.test.ts (positive
// controls: priced optionals move the answer; ignored ones don't).
//
// Fictional household for dispatched calls (never real figures):
// see helpers.ts.

import { describe, expect, test } from "bun:test";
import { RetirementQuestionInputs } from "../src/schema";
import {
  FIELD_ORDER,
  FUTURE_FIELDS,
  PRICED_OPTIONAL,
  type FinancialToolName,
} from "../src/pricedInputs";
import { BASE_INPUT_SCHEMA, dispatchTool, TOOLS } from "../src/tools";
import { fictionalScenario } from "./helpers";

const FINANCIAL_TOOLS: FinancialToolName[] = [
  "retirement_calculate",
  "retirement_monte_carlo",
  "retirement_max_spending",
  "retirement_compare_strategies",
  "retirement_roth_conversion",
  "retirement_work_years",
  "retirement_tax_year",
];

/** The guide's per-tool optional lists, from describeCapabilities. */
function guideOptionals(): Record<string, string[]> {
  const guide = dispatchTool("retirement_describe_capabilities", {});
  if (!guide.ok) throw new Error(JSON.stringify(guide.error));
  const tools = (guide.results as Record<string, unknown>).tools as Array<{
    name: string;
    required: string[];
    optional: string[];
  }>;
  return Object.fromEntries(tools.map((t) => [t.name, t.optional]));
}

describe("drift: mapping table == capability guide == JSON Schema", () => {
  test("guide optional list equals PRICED_OPTIONAL for every financial tool", () => {
    const guide = guideOptionals();
    for (const tool of FINANCIAL_TOOLS) {
      expect([...guide[tool]!].sort()).toEqual(
        [...PRICED_OPTIONAL[tool]].sort(),
      );
    }
    // describe takes no inputs.
    expect(guide["retirement_describe_capabilities"]).toEqual([]);
  });

  test("JSON Schema property names are exactly the zod keys (the advertised field set)", () => {
    const zodKeys = Object.keys(RetirementQuestionInputs.shape).sort();
    const props = (BASE_INPUT_SCHEMA as Record<string, unknown>)
      .properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(zodKeys);
  });

  test("FIELD_ORDER is exactly the zod shape's key order", () => {
    expect(FIELD_ORDER).toEqual(Object.keys(RetirementQuestionInputs.shape));
  });

  test("every mapping entry is a zod key, and every optional schema field is priced by at least one tool", () => {
    const zodKeys = new Set(Object.keys(RetirementQuestionInputs.shape));
    const required = new Set(
      (BASE_INPUT_SCHEMA as Record<string, unknown>)
        .required as string[],
    );
    const allPriced = new Set(Object.values(PRICED_OPTIONAL).flat());
    for (const tool of FINANCIAL_TOOLS) {
      for (const field of PRICED_OPTIONAL[tool]) {
        expect(zodKeys.has(field)).toBe(true);
      }
    }
    for (const field of zodKeys) {
      if (required.has(field)) continue;
      expect(allPriced.has(field)).toBe(true);
    }
  });

  test("guide optional lists contain only zod keys", () => {
    const zodKeys = new Set(Object.keys(RetirementQuestionInputs.shape));
    const guide = guideOptionals();
    for (const tool of FINANCIAL_TOOLS) {
      for (const field of guide[tool]!) {
        expect(zodKeys.has(field)).toBe(true);
      }
    }
  });
});

describe("drift: tool descriptions agree with the mapping", () => {
  test("every financial tool description carries an inert-input disclaimer", () => {
    // Coarse guard: the prose must say, in words, that some inputs
    // do not change this tool's answer. A description that drops
    // the disclaimer while the mapping still reports ignored inputs
    // would mislead a prose-only client.
    const byName = new Map(TOOLS.map((t) => [t.name, t.description]));
    for (const tool of FINANCIAL_TOOLS) {
      expect(byName.get(tool)).toMatch(
        /do not change this (answer|comparison|year's price)|is not used for this tool/,
      );
    }
  });

  test("the tax-year description states the Box 1a/1b dividend rule and the rejection", () => {
    const byName = new Map(TOOLS.map((t) => [t.name, t.description]));
    const desc = byName.get("retirement_tax_year")!;
    expect(desc).toContain("1099-DIV Box 1a");
    expect(desc).toContain("Box 1b");
    expect(desc).toContain("rejected as invalid input");
  });

  test("the max-spending description states mcRuns is not used and the fixed 1,000 runs", () => {
    const byName = new Map(TOOLS.map((t) => [t.name, t.description]));
    const desc = byName.get("retirement_max_spending")!;
    expect(desc).toContain("mcRuns is not used");
    expect(desc).toContain("1,000 simulations");
  });

  test("every financial tool response carries ignoredInputFields; describe carries an empty one", () => {
    const describe = dispatchTool("retirement_describe_capabilities", {});
    if (!describe.ok) throw new Error(JSON.stringify(describe.error));
    expect(describe.ignoredInputFields).toEqual([]);
    // Cheap financial calls (the work-years example is slow and is
    // covered by the adapter-level tests instead).
    for (const [tool, args] of [
      ["retirement_calculate", fictionalScenario({})],
      ["retirement_tax_year", fictionalScenario({})],
    ] as const) {
      const res = dispatchTool(tool, args);
      if (!res.ok) throw new Error(`${tool}: ${JSON.stringify(res.error)}`);
      expect(Array.isArray(res.ignoredInputFields)).toBe(true);
    }
  });
});

describe("drift: future fields stay out until their review lands", () => {
  test("medicareAgePrimary (Review 5 reservation) is exposed by Engine Review 7", () => {
    // The Review 5 reservation retired when Engine Review 7
    // exposed the field in the schema alongside hsaCoverage,
    // hsaEligible, and priorYearWagesAnnual: it must now be a
    // schema key, in FIELD_ORDER, priced only by
    // retirement_work_years, and out of FUTURE_FIELDS — and a
    // call carrying it must normalize instead of rejecting.
    const zodKeys = new Set(Object.keys(RetirementQuestionInputs.shape));
    expect(zodKeys.has("medicareAgePrimary")).toBe(true);
    expect(FIELD_ORDER).toContain("medicareAgePrimary");
    expect(PRICED_OPTIONAL["retirement_work_years"]).toContain(
      "medicareAgePrimary",
    );
    for (const tool of FINANCIAL_TOOLS) {
      if (tool === "retirement_work_years") continue;
      expect(PRICED_OPTIONAL[tool]).not.toContain("medicareAgePrimary");
    }
    expect(FUTURE_FIELDS["medicareAgePrimary"]).toBeUndefined();
    const res = dispatchTool(
      "retirement_work_years",
      fictionalScenario({ medicareAgePrimary: 65 }),
    );
    expect(res.ok).toBe(true);
  });
});
