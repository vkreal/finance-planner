// input.test.ts — input correctness for the assistant-api adapter.
//
// Covers: dollars→cents conversion, monthly→annual spending,
// explicit zeros vs omitted balances, invalid values, missing
// ages / Social Security details, and the effectiveInputs echo
// with assumption provenance on every resolved field.
//
// All figures are the fictional household (see helpers.ts).

import { describe, expect, test } from "bun:test";
import { calculateRetirement } from "../src/adapter";
import { latestTaxLawYear, normalizeInputs } from "../src/normalize";
import { dispatchTool } from "../src/tools";
import { TAX_LAW_YEARS } from "../../server/src/taxLaw";
import {
  ESSENTIAL_KEYS,
  expectEnvelope,
  FICTIONAL,
  fictionalScenario,
  normalizedScenario,
} from "./helpers";

describe("dollars to cents", () => {
  test("portfolioCents is the sum of the four balances in cents", () => {
    const s = normalizedScenario();
    expect(s.portfolioCents).toBe(
      (1250000 + 2100000 + 375000 + 62000) * 100,
    );
    expect(s.pretaxDollars).toBe(1250000);
    expect(s.taxableDollars).toBe(2100000);
    expect(s.rothDollars).toBe(375000);
    expect(s.hsaDollars).toBe(62000);
  });

  test("annualSpendingCents = Math.round(monthly * 12 * 100)", () => {
    const s = normalizedScenario();
    expect(s.annualSpendingCents).toBe(Math.round(9500 * 12 * 100));
    expect(s.annualSpendingCents).toBe(11_400_000);
  });

  test("monthly to annual: a $9,500/mo habit is $114,000/yr in the echo", () => {
    const res = expectEnvelope(calculateRetirement(normalizedScenario()));
    expect(res.effectiveInputs.monthlySpending).toBe(9500);
    expect(res.effectiveInputs.annualSpending).toBe(114000);
    expect(res.effectiveInputs.portfolioDollars).toBe(
      1250000 + 2100000 + 375000 + 62000,
    );
  });

  test("odd cents round: $9,500.555/mo rounds to whole cents", () => {
    const s = normalizedScenario({ monthlySpending: 9500.555 });
    expect(s.annualSpendingCents).toBe(Math.round(9500.555 * 12 * 100));
    expect(Number.isInteger(s.annualSpendingCents)).toBe(true);
  });
});

describe("explicit zero vs omitted", () => {
  test("explicit zeros stay zero and normalize fine (single filer)", () => {
    const n = normalizeInputs({
      pretax: 0,
      taxable: 0,
      roth: 0,
      hsa: 0,
      monthlySpending: 9500,
      currentAge: 54,
      filingStatus: "single",
    });
    expect(n.ok).toBe(true);
    if (!n.ok) return;
    expect(n.scenario.portfolioCents).toBe(0);
    expect(n.scenario.pretaxDollars).toBe(0);
    expect(n.scenario.rothDollars).toBe(0);
  });

  test("explicit zero is distinct from omitted: omitting roth is missing_input", () => {
    const { roth: _omit, ...withoutRoth } = fictionalScenario();
    const n = normalizeInputs(withoutRoth);
    expect(n.ok).toBe(false);
    if (n.ok) return;
    expect(n.error.error.code).toBe("missing_input");
    expect(n.error.error.missing).toEqual(["roth"]);
    expect(n.error.error.questions).toEqual([
      {
        field: "roth",
        question: "How much do you have in Roth accounts?",
      },
    ]);
  });

  test("omitting one essential key names exactly that key", () => {
    for (const key of ESSENTIAL_KEYS) {
      const input = { ...fictionalScenario() };
      delete (input as Record<string, unknown>)[key];
      const n = normalizeInputs(input);
      expect(n.ok).toBe(false);
      if (n.ok) continue;
      expect(n.error.error.code).toBe("missing_input");
      expect(n.error.error.missing).toEqual([key]);
    }
  });

  test("omitting all six essential keys names all six, in schema order", () => {
    const n = normalizeInputs({});
    expect(n.ok).toBe(false);
    if (n.ok) return;
    expect(n.error.error.code).toBe("missing_input");
    expect(n.error.error.missing).toEqual([
      "pretax",
      "taxable",
      "roth",
      "hsa",
      "monthlySpending",
      "currentAge",
    ]);
    expect(n.error.error.questions).toHaveLength(6);
  });

  test("an explicit zero SS amount needs no start age", () => {
    const s = normalizedScenario({
      socialSecurityAnnual: 0,
      spouseSocialSecurityAnnual: 0,
    });
    expect(s.ssPrimaryAnnual).toBe(0);
    expect(s.ssPrimaryStartAge).toBe(null);
  });
});

describe("invalid values", () => {
  test("negative balance is invalid_input", () => {
    const n = normalizeInputs(fictionalScenario({ pretax: -1 }));
    expect(n.ok).toBe(false);
    if (n.ok) return;
    expect(n.error.error.code).toBe("invalid_input");
    expect(n.error.error.message).toContain("pretax");
  });

  test("NaN balance is invalid_input", () => {
    const n = normalizeInputs(fictionalScenario({ taxable: Number.NaN }));
    expect(n.ok).toBe(false);
    if (n.ok) return;
    expect(n.error.error.code).toBe("invalid_input");
  });

  test("string balance is invalid_input, not coerced", () => {
    const n = normalizeInputs(fictionalScenario({ roth: "375000" }));
    expect(n.ok).toBe(false);
    if (n.ok) return;
    expect(n.error.error.code).toBe("invalid_input");
    expect(n.error.error.message).toContain("roth");
  });

  test("zero monthly spending is invalid_input (must be > 0)", () => {
    const n = normalizeInputs(fictionalScenario({ monthlySpending: 0 }));
    expect(n.ok).toBe(false);
    if (n.ok) return;
    expect(n.error.error.code).toBe("invalid_input");
  });

  test("a dollar amount over $100,000,000 is rejected", () => {
    const n = normalizeInputs(fictionalScenario({ pretax: 100_000_001 }));
    expect(n.ok).toBe(false);
    if (n.ok) return;
    expect(n.error.error.code).toBe("invalid_input");
    expect(n.error.error.message).toContain("pretax");
    // $100,000,000 itself is the cap and is accepted.
    expect(normalizeInputs(fictionalScenario({ pretax: 100_000_000 })).ok).toBe(
      true,
    );
  });

  test("taxYear outside the published law years is invalid_input naming them", () => {
    // Derived from the engine table so the test stays correct when a
    // new year's tables publish: the first unpublished year fails,
    // every published year passes.
    const years = TAX_LAW_YEARS.map((law) => law.year);
    const n = normalizeInputs(
      fictionalScenario({ taxYear: latestTaxLawYear() + 1 }),
    );
    expect(n.ok).toBe(false);
    if (n.ok) return;
    expect(n.error.error.code).toBe("invalid_input");
    const details = JSON.stringify(n.error.error.details);
    for (const year of years) expect(details).toContain(String(year));
    for (const year of years) {
      expect(normalizeInputs(fictionalScenario({ taxYear: year })).ok).toBe(
        true,
      );
    }
  });

  test("retirementAge before currentAge is invalid_input", () => {
    const n = normalizeInputs(fictionalScenario({ retirementAge: 53 }));
    expect(n.ok).toBe(false);
    if (n.ok) return;
    expect(n.error.error.code).toBe("invalid_input");
    expect(n.error.error.message).toContain("retirementAge");
  });

  test("endAge at or before retirementAge is invalid_input", () => {
    const at = normalizeInputs(
      fictionalScenario({ retirementAge: 58, endAge: 58 }),
    );
    expect(at.ok).toBe(false);
    if (!at.ok) expect(at.error.error.code).toBe("invalid_input");
    const before = normalizeInputs(
      fictionalScenario({ retirementAge: 58, endAge: 50 }),
    );
    expect(before.ok).toBe(false);
    if (!before.ok) expect(before.error.error.code).toBe("invalid_input");
  });

  test("error details name fields only — no caller values leak", () => {
    const n = normalizeInputs(fictionalScenario({ pretax: -1234567 }));
    expect(n.ok).toBe(false);
    if (n.ok) return;
    expect(JSON.stringify(n.error)).not.toContain("1234567");
    expect(JSON.stringify(n.error)).not.toContain("-1234567");
  });
});

describe("unknown fields are rejected (strict input schema)", () => {
  // The schema is strict: an unrecognized field is an error naming
  // the field, never a silent strip. A misspelled field must not
  // silently drop the income it was meant to carry.

  test("an unknown financial field is rejected with invalid_input", () => {
    const n = normalizeInputs(fictionalScenario({ unknownBalance: 100000 }));
    expect(n.ok).toBe(false);
    if (n.ok) return;
    expect(n.error.error.code).toBe("invalid_input");
    expect(n.error.error.message).toContain("unknownBalance");
    expect(JSON.stringify(n.error.error.details)).toContain("unknownBalance");
  });

  test("a misspelled Social Security field is rejected, naming it", () => {
    const n = normalizeInputs(
      fictionalScenario({ socialSecurityAnual: 48000 }),
    );
    expect(n.ok).toBe(false);
    if (n.ok) return;
    expect(n.error.error.code).toBe("invalid_input");
    expect(n.error.error.message).toContain("socialSecurityAnual");
    // The correctly spelled field still lands — the loss was the
    // misspelling, not the value.
    expect(
      normalizeInputs(fictionalScenario({ socialSecurityAnnual: 48000 })).ok,
    ).toBe(true);
  });

  test("a misspelled monthly spending field is rejected, naming it", () => {
    const n = normalizeInputs(fictionalScenario({ monthlySpendin: 8000 }));
    expect(n.ok).toBe(false);
    if (n.ok) return;
    expect(n.error.error.code).toBe("invalid_input");
    expect(n.error.error.message).toContain("monthlySpendin");
  });

  test("an unknown field with value 0 is rejected, not ignored", () => {
    const n = normalizeInputs(fictionalScenario({ unknownField: 0 }));
    expect(n.ok).toBe(false);
    if (n.ok) return;
    expect(n.error.error.code).toBe("invalid_input");
    expect(n.error.error.message).toContain("unknownField");
  });

  test("unknown fields never reach an engine: dispatch returns the error, no results", () => {
    const res = dispatchTool(
      "retirement_calculate",
      fictionalScenario({ socialSecurityAnual: 48000 }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("invalid_input");
    expect("results" in res).toBe(false);
  });

  test("error messages name fields only — no caller values leak", () => {
    const n = normalizeInputs(fictionalScenario({ mysteryField: 987654 }));
    expect(n.ok).toBe(false);
    if (n.ok) return;
    expect(JSON.stringify(n.error)).not.toContain("987654");
    expect(JSON.stringify(n.error)).not.toContain("1250000");
  });

  test("all eight tools still accept the valid fictional scenario", () => {
    const valid = fictionalScenario();
    for (const tool of [
      "retirement_calculate",
      "retirement_monte_carlo",
      "retirement_max_spending",
      "retirement_compare_strategies",
      "retirement_roth_conversion",
      "retirement_work_years",
      "retirement_tax_year",
    ]) {
      expect(dispatchTool(tool, valid).ok).toBe(true);
    }
    expect(dispatchTool("retirement_describe_capabilities", {}).ok).toBe(
      true,
    );
  });
});

describe("missing ages and Social Security details", () => {
  test("mfj without spouseAge is missing_input with a question", () => {
    const { spouseAge: _omit, ...input } = fictionalScenario();
    const n = normalizeInputs(input);
    expect(n.ok).toBe(false);
    if (n.ok) return;
    expect(n.error.error.code).toBe("missing_input");
    expect(n.error.error.missing).toEqual(["spouseAge"]);
    expect(n.error.error.questions).toEqual([
      { field: "spouseAge", question: "How old is your spouse?" },
    ]);
  });

  test("single filing needs no spouseAge", () => {
    const { spouseAge: _omit, ...input } = fictionalScenario({
      filingStatus: "single",
    });
    expect(normalizeInputs(input).ok).toBe(true);
  });

  test("SS amount without a start age is missing_input with a question", () => {
    const { socialSecurityStartAge: _omit, ...input } = fictionalScenario();
    const n = normalizeInputs(input);
    expect(n.ok).toBe(false);
    if (n.ok) return;
    expect(n.error.error.code).toBe("missing_input");
    expect(n.error.error.missing).toEqual(["socialSecurityStartAge"]);
    expect(n.error.error.questions?.[0]?.field).toBe(
      "socialSecurityStartAge",
    );
    expect(n.error.error.questions?.[0]?.question).toContain(
      "Social Security",
    );
  });

  test("spouse SS amount without a spouse start age names that field", () => {
    const { spouseSocialSecurityStartAge: _omit, ...input } =
      fictionalScenario();
    const n = normalizeInputs(input);
    expect(n.ok).toBe(false);
    if (n.ok) return;
    expect(n.error.error.code).toBe("missing_input");
    expect(n.error.error.missing).toEqual(["spouseSocialSecurityStartAge"]);
  });
});

describe("effectiveInputs echo and assumption provenance", () => {
  test("the envelope echoes the caller's inputs back", () => {
    const res = expectEnvelope(calculateRetirement(normalizedScenario()));
    expect(res.effectiveInputs).toMatchObject({
      pretax: FICTIONAL.pretax,
      taxable: FICTIONAL.taxable,
      roth: FICTIONAL.roth,
      hsa: FICTIONAL.hsa,
      currentAge: 54,
      spouseAge: 52,
      retirementAge: 58,
      endAge: 95,
      filingStatus: "mfj",
      socialSecurityAnnual: 36000,
      socialSecurityStartAge: 67,
      spouseSocialSecurityAnnual: 18000,
      spouseSocialSecurityStartAge: 67,
      taxableBasisPct: 72,
      taxYear: 2026,
    });
  });

  test("every resolved field carries a provenance in user/assumption/engine_constant", () => {
    const s = normalizedScenario();
    const provenances = new Set(["user", "assumption", "engine_constant"]);
    const expectedFields = [
      "pretax",
      "taxable",
      "roth",
      "hsa",
      "monthlySpending",
      "currentAge",
      "retirementAge",
      "endAge",
      "birthYearPrimary",
      "filingStatus",
      "householdSize",
      "spouseAge",
      "birthYearSpouse",
      "stocksPct",
      "expectedRealReturnPct",
      "volatilityPct",
      "strategy",
      "socialSecurityAnnual",
      "socialSecurityStartAge",
      "spouseSocialSecurityAnnual",
      "spouseSocialSecurityStartAge",
      "taxableBasisPct",
      "taxableBasisBlank",
      "taxableDividendYieldPct",
      "taxableInterestYieldPct",
      "otherOrdinaryAnnual",
      "taxExemptInterestAnnual",
      "acaBenchmarkCouple",
      "acaBenchmarkSingle",
      "acaBenchmarkFamily",
      "state",
      "stateRatePct",
      "residenceState",
      "startYear",
      "taxYear",
      "salaryAnnual",
      "employer401kAnnual",
      "employerHsaAnnual",
      "inflationPct",
      "singleYear.interest",
      "singleYear.ordinaryDividends",
      "singleYear.qualifiedDividends",
      "singleYear.conversion",
      "singleYear.spendingDraw",
      "singleYear.cashDraw",
      "singleYear.rothDraw",
      "mcSeed",
      "mcRuns",
    ];
    const byField = new Map(s.assumptions.map((a) => [a.field, a]));
    for (const field of expectedFields) {
      const a = byField.get(field);
      expect(a, `missing assumption entry for ${field}`).toBeDefined();
      expect(provenances.has(a!.provenance)).toBe(true);
      expect(typeof a!.note).toBe("string");
      expect(a!.note.length).toBeGreaterThan(0);
    }
    // No assumption entry at all for compareAges when omitted
    // (the adapter defaults it per call instead).
    expect(byField.has("compareAges")).toBe(false);
  });

  test("provenance distinguishes caller values from defaults", () => {
    const s = normalizedScenario();
    const byField = new Map(s.assumptions.map((a) => [a.field, a]));
    expect(byField.get("pretax")?.provenance).toBe("user");
    expect(byField.get("retirementAge")?.provenance).toBe("user");
    expect(byField.get("socialSecurityAnnual")?.provenance).toBe("user");
    // Omitted: defaults, labelled as such.
    expect(byField.get("stocksPct")?.provenance).toBe("engine_constant");
    expect(byField.get("stocksPct")?.value).toBe(95);
    expect(byField.get("expectedRealReturnPct")?.provenance).toBe(
      "engine_constant",
    );
    expect(byField.get("expectedRealReturnPct")?.value).toBe(6.75);
    expect(byField.get("volatilityPct")?.provenance).toBe("engine_constant");
    expect(byField.get("volatilityPct")?.value).toBe(17.4);
    expect(byField.get("filingStatus")?.provenance).toBe("assumption");
    expect(byField.get("householdSize")?.provenance).toBe("assumption");
    expect(byField.get("householdSize")?.value).toBe(2);
    expect(byField.get("mcSeed")?.provenance).toBe("engine_constant");
    expect(byField.get("mcSeed")?.value).toBe(12345);
    expect(byField.get("mcRuns")?.provenance).toBe("engine_constant");
    expect(byField.get("mcRuns")?.value).toBe(1000);
    // Omitted endAge is the engine default 95.
    const s2 = normalizedScenario({ endAge: undefined });
    expect(
      new Map(s2.assumptions.map((a) => [a.field, a])).get("endAge")
        ?.provenance,
    ).toBe("engine_constant");
  });

  test("no-ACA-benchmark warning rides along when no benchmark is given", () => {
    const s = normalizedScenario();
    expect(s.warnings.join(" ")).toContain("No ACA benchmark provided");
    const res = expectEnvelope(calculateRetirement(s));
    expect(res.warnings.join(" ")).toContain("No ACA benchmark provided");
  });
});

describe("compareAges guards (retirement ages must be live choices)", () => {
  test("an age before currentAge is invalid_input", () => {
    const n = normalizeInputs(
      fictionalScenario({ retirementAge: 58, compareAges: [30, 35] }),
    );
    expect(n.ok).toBe(false);
    if (n.ok) throw new Error("past ages should not normalize");
    expect(n.error.error.code).toBe("invalid_input");
    expect(n.error.error.message).toContain("compareAges");
  });

  test("an age at or after endAge is invalid_input", () => {
    const n = normalizeInputs(fictionalScenario({ compareAges: [59, 95] }));
    expect(n.ok).toBe(false);
    if (n.ok) throw new Error("age >= endAge should not normalize");
    expect(n.error.error.code).toBe("invalid_input");
  });

  test("an age below retirementAge but at/after currentAge still prices", () => {
    // Transcript (4) compares 56 vs 60 with retirementAge 58.
    const s = normalizedScenario({
      retirementAge: 58,
      compareAges: [56, 60],
    });
    expect(s.compareAges).toEqual([56, 60]);
  });
});

describe("taxYear default clamps to the latest published law year", () => {
  test("no taxYear given → the current year clamped to the latest law year", () => {
    const n = normalizeInputs(fictionalScenario({ taxYear: undefined }));
    expect(n.ok).toBe(true);
    if (!n.ok) throw new Error("fixture failed");
    expect(n.scenario.taxYear).toBe(
      Math.min(new Date().getFullYear(), latestTaxLawYear()),
    );
  });
});

describe("strategy sub-parameter assumptions (pass-2 S3)", () => {
  // The sim engines price percent/guardrails/phased from fixed
  // engine defaults (5% / 120-80-10 / 75-1). Those knobs must be
  // disclosed as engine_constant assumptions, not silently applied —
  // and "constant" must record none of them.
  function knobAssumptions(strategy: string) {
    const n = normalizeInputs(fictionalScenario({ strategy }));
    expect(n.ok).toBe(true);
    if (!n.ok) throw new Error("fixture failed");
    return n.scenario.assumptions;
  }

  function knob(
    assumptions: Array<{ field: string; value: unknown; provenance: string }>,
    field: string,
  ) {
    return assumptions.find((a) => a.field === field);
  }

  test('"percent" records percentOfPortfolio 5 as an engine constant', () => {
    const a = knob(knobAssumptions("percent"), "percentOfPortfolio");
    expect(a).toMatchObject({ value: 5, provenance: "engine_constant" });
  });

  test('"guardrails" records the 120/80/10 knobs as engine constants', () => {
    const assumptions = knobAssumptions("guardrails");
    expect(knob(assumptions, "guardrailsCutPct")).toMatchObject({
      value: 120,
      provenance: "engine_constant",
    });
    expect(knob(assumptions, "guardrailsRaisePct")).toMatchObject({
      value: 80,
      provenance: "engine_constant",
    });
    expect(knob(assumptions, "guardrailsAdjustmentPct")).toMatchObject({
      value: 10,
      provenance: "engine_constant",
    });
  });

  test('"phased" records the 75/1 knobs as engine constants', () => {
    const assumptions = knobAssumptions("phased");
    expect(knob(assumptions, "phaseStartAge")).toMatchObject({
      value: 75,
      provenance: "engine_constant",
    });
    expect(knob(assumptions, "phaseDeclinePct")).toMatchObject({
      value: 1,
      provenance: "engine_constant",
    });
  });

  test('"constant" records no strategy-knob assumptions', () => {
    const fields = knobAssumptions("constant").map((a) => a.field);
    for (const knobField of [
      "percentOfPortfolio",
      "guardrailsCutPct",
      "guardrailsRaisePct",
      "guardrailsAdjustmentPct",
      "phaseStartAge",
      "phaseDeclinePct",
    ]) {
      expect(fields).not.toContain(knobField);
    }
  });
});
