// review8.test.ts — Review 8 S1 (per-tool priced-input reporting)
// and S2 (ordinary vs qualified dividends, Box 1a/1b).
//
// Fictional household throughout (never real figures): pretax
// $1,250,000; taxable $2,100,000; Roth $375,000; HSA $62,000;
// spending $9,500/mo; ages 54/52; retire 58; end age 95; SS
// $36,000/yr at 67 (spouse $18,000/yr at 67). Every case overrides
// only the fields its note varies.

import { describe, expect, test } from "bun:test";
import {
  pricePlaygroundYear,
  type PlaygroundYearInputs,
  type PlaygroundYearResult,
} from "../../server/src/rothOptimizer";
import {
  calculateMaxSpending,
  calculateRetirement,
  calculateSingleYearTax,
  compareRetirementAges,
  compareRothConversions,
  compareWithdrawalStrategies,
  runRetirementMonteCarlo,
} from "../src/adapter";
import { normalizeInputs, type NormalizedScenario } from "../src/normalize";
import {
  FIELD_ORDER,
  PRICED_OPTIONAL,
  pricedBy,
} from "../src/pricedInputs";
import { RetirementQuestionInputs } from "../src/schema";
import { dispatchTool } from "../src/tools";
import type { AdapterResponse } from "../src/types";
import {
  expectEnvelope,
  expectOk,
  fictionalScenario,
  normalizedScenario,
  roundDeep,
} from "./helpers";

/** Ignored-field entries on an ok envelope (empty array when none). */
function ignoredOf(result: AdapterResponse<unknown>): Array<{
  field: string;
  tool: string;
  pricedBy: string[];
  reason: string;
}> {
  return result.ignoredInputFields as Array<{
    field: string;
    tool: string;
    pricedBy: string[];
    reason: string;
  }>;
}

/** ignored entry for one field, or undefined. */
function ignoredField(
  result: AdapterResponse<unknown>,
  field: string,
): { field: string; tool: string; pricedBy: string[]; reason: string } | undefined {
  return ignoredOf(result).find((e) => e.field === field);
}

/** Dispatch a financial tool and return the ok envelope. */
function dispatchOk(
  tool: string,
  args: Record<string, unknown>,
): AdapterResponse<unknown> {
  const res = dispatchTool(tool, args);
  if (!res.ok) throw new Error(`${tool} failed: ${JSON.stringify(res.error)}`);
  return res;
}

// ---------------------------------------------------------------------------
// R8-S1: recognized-but-ignored fields are reported, results unchanged
// ---------------------------------------------------------------------------

describe("R8-S1 ignored inputs are reported and change nothing", () => {
  test("conversionAnnual to retirement_calculate: ignored, named, results unchanged to the cent", () => {
    const base = dispatchOk("retirement_calculate", fictionalScenario({}));
    const withConversion = dispatchOk(
      "retirement_calculate",
      fictionalScenario({ conversionAnnual: 20000 }),
    );
    expect(JSON.stringify(withConversion.results)).toBe(
      JSON.stringify(base.results),
    );
    const entry = ignoredField(withConversion, "conversionAnnual");
    expect(entry).toBeDefined();
    expect(entry!.tool).toBe("retirement_calculate");
    expect(entry!.pricedBy).toContain("retirement_tax_year");
    expect(entry!.reason).toContain("retirement_tax_year");
    expect(
      withConversion.warnings.some(
        (w) =>
          w.includes('"conversionAnnual"') &&
          w.includes("retirement_calculate") &&
          w.includes("retirement_tax_year"),
      ),
    ).toBe(true);
    // The base call already ignores the fictional scenario's own
    // unpriced fields (taxYear, taxableBasisPct) — the added field
    // is the only difference.
    expect(ignoredOf(withConversion).map((e) => e.field)).toContain(
      "taxYear",
    );
    expect(
      ignoredOf(withConversion).length,
    ).toBe(ignoredOf(base).length + 1);
  });

  test("taxYear to a multi-year comparison: inert, results identical, envelope taxLawYear is the march start", () => {
    const y2026 = dispatchOk(
      "retirement_roth_conversion",
      fictionalScenario({ taxYear: 2026 }),
    );
    const y2025 = dispatchOk(
      "retirement_roth_conversion",
      fictionalScenario({ taxYear: 2025 }),
    );
    expect(JSON.stringify(y2025.results)).toBe(JSON.stringify(y2026.results));
    expect(y2025.taxLawYear).toBe(2026);
    expect(y2026.taxLawYear).toBe(2026);
    expect(ignoredField(y2025, "taxYear")?.pricedBy).toContain(
      "retirement_tax_year",
    );
  });

  test("volatilityPct to a deterministic tax comparison: inert, results identical", () => {
    const base = dispatchOk(
      "retirement_compare_strategies",
      fictionalScenario({}),
    );
    const vol = dispatchOk(
      "retirement_compare_strategies",
      fictionalScenario({ volatilityPct: 50 }),
    );
    expect(JSON.stringify(vol.results)).toBe(JSON.stringify(base.results));
    const entry = ignoredField(vol, "volatilityPct");
    expect(entry).toBeDefined();
    expect(entry!.pricedBy).toContain("retirement_monte_carlo");
    expect(entry!.pricedBy).toContain("retirement_max_spending");
  });

  test(
    "mcRuns to max-spending: inert (solver runs a fixed 1,000), results identical",
    () => {
      const omitted = dispatchOk("retirement_max_spending", fictionalScenario({}));
      const ten = dispatchOk(
        "retirement_max_spending",
        fictionalScenario({ mcRuns: 10 }),
      );
      expect(JSON.stringify(ten.results)).toBe(JSON.stringify(omitted.results));
      expect((ten.results as Record<string, unknown>).runs).toBe(1000);
      const entry = ignoredField(ten, "mcRuns");
      expect(entry).toBeDefined();
      expect(entry!.pricedBy).toContain("retirement_monte_carlo");
    },
    60000,
  );

  test("stockSoldAnnual to a non-single-year tool: ignored, results unchanged", () => {
    const base = dispatchOk("retirement_calculate", fictionalScenario({}));
    const sold = dispatchOk(
      "retirement_calculate",
      fictionalScenario({ stockSoldAnnual: 20000, stockBasisAnnual: 12000 }),
    );
    expect(JSON.stringify(sold.results)).toBe(JSON.stringify(base.results));
    expect(ignoredField(sold, "stockSoldAnnual")?.pricedBy).toContain(
      "retirement_tax_year",
    );
    expect(ignoredField(sold, "stockBasisAnnual")?.pricedBy).toContain(
      "retirement_tax_year",
    );
  });

  test("omitted fields never appear as user-supplied ignored fields; essentials never appear", () => {
    // Minimal call: only the six essentials + spouseAge (mfj).
    // Every supplied field is priced by calculate, so nothing is ignored.
    const res = dispatchOk("retirement_calculate", {
      pretax: 1250000,
      taxable: 2100000,
      roth: 375000,
      hsa: 62000,
      monthlySpending: 9500,
      currentAge: 54,
      spouseAge: 52,
    });
    expect(ignoredOf(res)).toEqual([]);
    for (const essential of [
      "pretax",
      "taxable",
      "roth",
      "hsa",
      "monthlySpending",
      "currentAge",
    ]) {
      expect(ignoredOf(res).map((e) => e.field)).not.toContain(essential);
    }
  });

  test("suppliedFields records caller keys in FIELD_ORDER, regardless of caller key order", () => {
    const n = normalizeInputs({
      monthlySpending: 9500,
      currentAge: 54,
      spouseAge: 52,
      hsa: 62000,
      roth: 375000,
      taxable: 2100000,
      pretax: 1250000,
      conversionAnnual: 20000,
    });
    expect(n.ok).toBe(true);
    if (!n.ok) throw new Error("fixture failed");
    expect(n.scenario.suppliedFields).toEqual([
      "pretax",
      "taxable",
      "roth",
      "hsa",
      "monthlySpending",
      "currentAge",
      "spouseAge",
      "conversionAnnual",
    ]);
  });

  test("conditional ignore: spouse fields on a single return price nothing for this scenario", () => {
    const res = dispatchOk(
      "retirement_calculate",
      fictionalScenario({
        filingStatus: "single",
        householdSize: 1,
        // Dropping the spouse SS amounts: on single no spouse is
        // modeled, and the start-age cross-check does not apply.
        spouseSocialSecurityAnnual: 0,
        spouseSocialSecurityStartAge: undefined,
      }),
    );
    const spouseAge = ignoredField(res, "spouseAge");
    expect(spouseAge).toBeDefined();
    expect(spouseAge!.reason).toContain("no spouse is modeled");
  });

  test("conditional ignore: a WA state rate prices via the excise path, not the rate", () => {
    const res = dispatchOk(
      "retirement_tax_year",
      fictionalScenario({ state: "WA", stateRatePct: 5 }),
    );
    const rate = ignoredField(res, "stateRatePct");
    expect(rate).toBeDefined();
    expect(rate!.reason).toContain("WA");
  });

  test("unknown fields still fail strict validation, naming the property", () => {
    const res = dispatchTool(
      "retirement_calculate",
      fictionalScenario({ conversionAnual: 20000 }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("typo should not normalize");
    expect(res.error.code).toBe("invalid_input");
    expect(res.error.message).toContain("conversionAnual");
  });

  test("missing essentials return missing_input explicitly (not undefined)", () => {
    const none = dispatchTool("retirement_calculate", {});
    expect(none.ok).toBe(false);
    if (none.ok) throw new Error("empty input should not normalize");
    expect(none.error.code).toBe("missing_input");
    expect(none.error.missing).toEqual([
      "pretax",
      "taxable",
      "roth",
      "hsa",
      "monthlySpending",
      "currentAge",
    ]);
    expect(none.error.questions).toHaveLength(6);
    for (const q of none.error.questions!) {
      expect(typeof q.question).toBe("string");
      expect(q.question.length).toBeGreaterThan(0);
    }
    const one = dispatchTool(
      "retirement_calculate",
      fictionalScenario({ pretax: undefined }),
    );
    expect(one.ok).toBe(false);
    if (one.ok) throw new Error("missing pretax should not normalize");
    expect(one.error.code).toBe("missing_input");
    expect(one.error.missing).toEqual(["pretax"]);
  });
});

describe("R8-S1 positive controls: priced optionals genuinely move the answer", () => {
  test("calculate: expectedRealReturnPct moves the ending balance", () => {
    const low = expectOk(calculateRetirement(normalizedScenario({})));
    const high = expectOk(
      calculateRetirement(normalizedScenario({ expectedRealReturnPct: 8 })),
    );
    expect(high.endingBalance).not.toBe(low.endingBalance);
  });

  test("monte_carlo: expectedRealReturnPct moves the median ending balance", () => {
    const low = expectOk(runRetirementMonteCarlo(normalizedScenario({})));
    const high = expectOk(
      runRetirementMonteCarlo(
        normalizedScenario({ expectedRealReturnPct: 0 }),
      ),
    );
    expect(high.endingP50).not.toBe(low.endingP50);
  });

  test(
    "max_spending: expectedRealReturnPct moves the max spending level",
    () => {
      const low = expectOk(calculateMaxSpending(normalizedScenario({})));
      const high = expectOk(
        calculateMaxSpending(normalizedScenario({ expectedRealReturnPct: 8 })),
      );
      expect(high.maxMonthlySpending).not.toBe(low.maxMonthlySpending);
    },
    60000,
  );

  test("compare_strategies: taxableBasisPct moves the comparison", () => {
    const low = dispatchOk(
      "retirement_compare_strategies",
      fictionalScenario({}),
    );
    const high = dispatchOk(
      "retirement_compare_strategies",
      fictionalScenario({ taxableBasisPct: 100 }),
    );
    expect(JSON.stringify(high.results)).not.toBe(
      JSON.stringify(low.results),
    );
  });

  test("roth_conversion: taxableBasisPct moves the comparison", () => {
    const low = dispatchOk("retirement_roth_conversion", fictionalScenario({}));
    const high = dispatchOk(
      "retirement_roth_conversion",
      fictionalScenario({ taxableBasisPct: 100 }),
    );
    expect(JSON.stringify(high.results)).not.toBe(
      JSON.stringify(low.results),
    );
  });

  test("work_years: compareAges moves the comparison (no salary, so no earned-income leg)", () => {
    const a = expectOk(
      compareRetirementAges(
        normalizedScenario({ compareAges: [58, 60, 63] }),
      ),
    );
    const b = expectOk(
      compareRetirementAges(
        normalizedScenario({ compareAges: [58, 62, 65] }),
      ),
    );
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    expect(a.workYears).toEqual([]);
  });

  test("tax_year: interestAnnual moves the federal tax", () => {
    // Other ordinary income lifts taxable income above the standard
    // deduction, so the interest difference actually moves the tax.
    const low = dispatchOk(
      "retirement_tax_year",
      fictionalScenario({ interestAnnual: 1000, otherOrdinaryAnnual: 60000 }),
    );
    const high = dispatchOk(
      "retirement_tax_year",
      fictionalScenario({ interestAnnual: 5000, otherOrdinaryAnnual: 60000 }),
    );
    expect(
      (high.results as Record<string, unknown>).federalTax,
    ).not.toBe((low.results as Record<string, unknown>).federalTax);
  });
});

// ---------------------------------------------------------------------------
// R8-S2: ordinary = Box 1a total, qualified = Box 1b portion
// ---------------------------------------------------------------------------

/** Direct-engine oracle, built by hand from the scenario (same
 *  pattern as review6-tax-year.test.ts — independent of the
 *  adapter's own mapping). */
function directInputs(s: NormalizedScenario): PlaygroundYearInputs {
  const joint = s.filingStatus === "mfj";
  const agePrimary = s.currentAge + (s.taxYear - s.startYear);
  const ageSpouse =
    joint && s.birthYearSpouse != null ? s.taxYear - s.birthYearSpouse : null;
  const stockSold = s.singleYear.stockSold ?? 0;
  const stockBasis = stockSold > 0 ? (s.singleYear.stockBasis ?? 0) : 0;
  const ssPrimary =
    s.ssPrimaryStartAge != null && agePrimary >= s.ssPrimaryStartAge
      ? s.ssPrimaryAnnual
      : 0;
  const ssSpouse =
    joint &&
    s.ssSpouseStartAge != null &&
    ageSpouse != null &&
    ageSpouse >= s.ssSpouseStartAge
      ? s.ssSpouseAnnual
      : 0;
  return {
    taxYear: s.taxYear,
    filingStatus: s.filingStatus,
    agePrimary,
    ageSpouse,
    onMedicarePrimary: agePrimary >= 65,
    onMedicareSpouse: ageSpouse != null && ageSpouse >= 65,
    interest: s.singleYear.interest,
    ordinaryDividends: s.singleYear.ordinaryDividends,
    otherOrdinary: s.otherOrdinaryAnnual,
    taxExemptInterest: s.taxExemptInterestAnnual,
    ssPrimary,
    ssSpouse,
    conversion: s.singleYear.conversion,
    spendingDraw: s.singleYear.spendingDraw,
    cashDraw: s.singleYear.cashDraw,
    rothDraw: s.singleYear.rothDraw,
    inflationPct: s.inflationPct,
    stockSold,
    stockBasis,
    qualifiedDividends: s.singleYear.qualifiedDividends,
    pretaxBalance: s.singleYear.pretaxPriorYearEnd,
    pretaxBalanceSpouse: s.singleYear.pretaxSpousePriorYearEnd,
    rmdAlreadyReceived: s.singleYear.rmdAlreadyReceived ?? 0,
    primarySoleBeneficiaryOfSpouse:
      s.singleYear.primarySoleBeneficiaryOfSpouse,
    spouseSoleBeneficiary: joint,
    acaHouseholdSize: s.householdSize,
    acaBenchmarkAnnual:
      s.filingStatus === "single"
        ? s.acaBenchmarkSingle
        : s.householdSize >= 3
          ? (s.acaBenchmarkFamily ?? s.acaBenchmarkCouple)
          : s.acaBenchmarkCouple,
    stateRatePct: s.stateRatePct,
    residenceState: s.residenceState,
    annualSpending: s.annualSpendingCents / 100,
  };
}

/** Adapter tax-year result with direct-engine parity to the cent. */
function pricedWithParity(
  overrides: Record<string, unknown>,
): PlaygroundYearResult {
  const s = normalizedScenario(overrides);
  const res = expectOk(calculateSingleYearTax(s));
  const direct = pricePlaygroundYear(directInputs(s));
  expect(res).toEqual(roundDeep(direct));
  return res;
}

describe("R8-S2 dividend validation (Box 1a total / Box 1b portion)", () => {
  test("$10,000 ordinary / $6,000 qualified is valid", () => {
    const res = pricedWithParity({
      ordinaryDividendsAnnual: 10000,
      qualifiedDividendsAnnual: 6000,
    });
    expect(res.qualifiedDividends).toBe(6000);
  });

  test("$10,000 ordinary / $0 qualified is valid", () => {
    const res = pricedWithParity({
      ordinaryDividendsAnnual: 10000,
      qualifiedDividendsAnnual: 0,
    });
    expect(res.qualifiedDividends).toBe(0);
  });

  test("$10,000 ordinary / $10,000 qualified is valid (all qualified)", () => {
    const res = pricedWithParity({
      ordinaryDividendsAnnual: 10000,
      qualifiedDividendsAnnual: 10000,
    });
    expect(res.qualifiedDividends).toBe(10000);
  });

  test("$0 / $0 is valid", () => {
    const res = pricedWithParity({
      ordinaryDividendsAnnual: 0,
      qualifiedDividendsAnnual: 0,
    });
    expect(res.qualifiedDividends).toBe(0);
  });

  test("omitted qualified with ordinary present is valid", () => {
    const res = pricedWithParity({ ordinaryDividendsAnnual: 10000 });
    expect(res.qualifiedDividends).toBe(0);
  });

  test("$4,000 ordinary / $6,000 qualified is rejected invalid_input naming both fields", () => {
    const res = dispatchTool(
      "retirement_tax_year",
      fictionalScenario({
        ordinaryDividendsAnnual: 4000,
        qualifiedDividendsAnnual: 6000,
      }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("qualified > ordinary should be rejected");
    expect(res.error.code).toBe("invalid_input");
    expect(res.error.message).toContain("qualifiedDividendsAnnual");
    expect(res.error.message).toContain("ordinaryDividendsAnnual");
    const details = res.error.details as Array<{ field: string }>;
    expect(details.map((d) => d.field).sort()).toEqual([
      "ordinaryDividendsAnnual",
      "qualifiedDividendsAnnual",
    ]);
  });

  test("omitted ordinary with qualified > $0 is rejected (ordinary counts as $0)", () => {
    const res = dispatchTool(
      "retirement_tax_year",
      fictionalScenario({ qualifiedDividendsAnnual: 6000 }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("qualified with no ordinary should be rejected");
    expect(res.error.code).toBe("invalid_input");
  });

  test("the rejection happens on every tool, before any engine runs", () => {
    const res = dispatchTool(
      "retirement_calculate",
      fictionalScenario({
        ordinaryDividendsAnnual: 4000,
        qualifiedDividendsAnnual: 6000,
      }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("qualified > ordinary should be rejected");
    expect(res.error.code).toBe("invalid_input");
  });

  test("qualified dividends enter AGI once and the preferential stack once", () => {
    // Other ordinary income lifts taxable income above the standard
    // deduction, so the preferential rate on qualified dividends
    // actually moves the federal tax.
    const withQualified = pricedWithParity({
      ordinaryDividendsAnnual: 10000,
      qualifiedDividendsAnnual: 6000,
      otherOrdinaryAnnual: 60000,
    });
    const noneQualified = pricedWithParity({
      ordinaryDividendsAnnual: 10000,
      qualifiedDividendsAnnual: 0,
      otherOrdinaryAnnual: 60000,
    });
    // Same ordinary total in both: AGI is identical — the
    // qualified portion is a rate question, not extra income.
    expect(withQualified.agi).toBe(noneQualified.agi);
    // Preferential rate: the qualified case pays less federal tax.
    expect(withQualified.federalTax).toBeLessThan(noneQualified.federalTax);
    expect(withQualified.qualifiedDividends).toBe(6000);
    expect(noneQualified.qualifiedDividends).toBe(0);
  });

  test("NIIT parity at high MAGI: adapter and direct engine agree to the cent", () => {
    const res = pricedWithParity({
      ordinaryDividendsAnnual: 10000,
      qualifiedDividendsAnnual: 6000,
      otherOrdinaryAnnual: 300000,
    });
    expect(res.magi).toBeGreaterThan(250000);
    expect(res.niit).toBeGreaterThan(0);
  });

  test("envelope reports contract 164 on the tax-year tool", () => {
    const res = dispatchTool(
      "retirement_tax_year",
      fictionalScenario({
        ordinaryDividendsAnnual: 10000,
        qualifiedDividendsAnnual: 6000,
      }),
    );
    const env = expectEnvelope(res);
    expect(env.apiContractVersion).toBe(164);
    // The dividend fields are priced by this tool, so they are not
    // ignored — but the fictional scenario's retirementAge, endAge
    // and taxableBasisPct are (tax_year prices neither), and are
    // reported as such.
    const fields = ignoredOf(env).map((e) => e.field);
    expect(fields).toContain("retirementAge");
    expect(fields).toContain("endAge");
    expect(fields).toContain("taxableBasisPct");
    expect(fields).not.toContain("ordinaryDividendsAnnual");
    expect(fields).not.toContain("qualifiedDividendsAnnual");
  });
});

describe("R8-S1 mapping table is the single source (spot checks)", () => {
  test("pricedBy names the tools that price a field", () => {
    expect(pricedBy("conversionAnnual")).toEqual(["retirement_tax_year"]);
    expect(pricedBy("mcRuns")).toEqual(["retirement_monte_carlo"]);
    expect(pricedBy("volatilityPct")).toEqual([
      "retirement_monte_carlo",
      "retirement_max_spending",
    ]);
    expect(pricedBy("taxYear")).toEqual(["retirement_tax_year"]);
    expect(pricedBy("strategy")).toEqual([
      "retirement_calculate",
      "retirement_monte_carlo",
      "retirement_max_spending",
    ]);
  });

  test("every optional field is priced by at least one tool; every FIELD_ORDER entry is a schema key", () => {
    const zodKeys = new Set(Object.keys(RetirementQuestionInputs.shape));
    for (const field of FIELD_ORDER) {
      expect(zodKeys.has(field)).toBe(true);
    }
    const allPriced = new Set(Object.values(PRICED_OPTIONAL).flat());
    for (const field of FIELD_ORDER) {
      if (
        [
          "pretax",
          "taxable",
          "roth",
          "hsa",
          "monthlySpending",
          "currentAge",
        ].includes(field)
      ) {
        continue;
      }
      expect(allPriced.has(field)).toBe(true);
    }
  });
});
