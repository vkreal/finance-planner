// isolation.test.ts — sample isolation for the assistant-api adapter.
//
// THE highest-priority requirement: the adapter must never read, import,
// or be influenced by the fictional sample household (server/src/
// sampleHousehold.ts) or by any saved record. The sample module's
// exports are `export const` primitives, so a test cannot reassign
// them — isolation is proven three ways instead:
//   (i)   structurally: no adapter or engine source file imports
//         sampleHousehold (or any storage / seeding module);
//   (ii)  behaviorally with extremes: balances of $0 and $99,000,000
//         price sanely and independently of every sample value;
//   (iii) behaviorally with repetition: A, then B, then A again is
//         bit-identical — no cross-request contamination.
//   (iv)  by mutation: the sample module's one mutable export, the
//         SAMPLE_HOUSEHOLD object, is rewritten to extreme values
//         mid-test and the adapter's outputs do not move.
// All figures are the fictional household (see helpers.ts) except the
// extremes in (ii), which are deliberately not sample values.

import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  calculateRetirement,
  compareRothConversions,
  runRetirementMonteCarlo,
} from "../src/adapter";
import { normalizeInputs } from "../src/normalize";
import * as sampleHousehold from "../../server/src/sampleHousehold";
import {
  expectOk,
  FICTIONAL,
  fictionalScenario,
  normalizedScenario,
} from "./helpers";

/** Read a source file next to this test file, as text. */
function srcText(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

/** Every module specifier a source file imports (static + dynamic). */
function importSpecifiers(source: string): string[] {
  const found: string[] = [];
  const re = /import\s+(?:[^'"]*\sfrom\s+)?['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) found.push(m[1]!);
  const dyn = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dyn.exec(source)) !== null) found.push(m[1]!);
  return found;
}

const ADAPTER_FILES = [
  "../src/adapter.ts",
  "../src/normalize.ts",
  "../src/tools.ts",
  "../src/server.ts",
  "../src/cli.ts",
  "../src/types.ts",
  "../src/schema.ts",
];

// Engine modules the adapter calls (plus their transitive helpers).
const ENGINE_FILES = [
  "../../server/src/retirementEngines.ts",
  "../../server/src/taxEngine.ts",
  "../../server/src/taxLaw.ts",
  "../../server/src/rothOptimizer.ts",
  "../../server/src/rothSeed.ts",
  "../../server/src/workYears.ts",
  "../../server/src/giftModel.ts",
  "../../server/src/retirementData.ts",
  "../../server/src/taxReturnCore.ts",
];

/** Modules that must never appear in the adapter/engine import graph. */
const FORBIDDEN_IMPORTS = [
  "sampleHousehold",
  "actions",
  "apiContractCore",
  "drizzle-orm",
  "seedFirstRun",
  "seedExamples",
  "resetRothPlanner",
  "getRothPlanner",
];

describe("structural isolation: no sample or storage import", () => {
  test.each([...ADAPTER_FILES, ...ENGINE_FILES])(
    "%s imports no sample / storage / seeding module",
    (file) => {
      const specifiers = importSpecifiers(srcText(file));
      for (const forbidden of FORBIDDEN_IMPORTS) {
        expect(
          specifiers.filter((s) => s.includes(forbidden)),
          `${file} must not import ${forbidden} (found: ${specifiers.join(", ")})`,
        ).toEqual([]);
      }
    },
  );

  test("no adapter file references localStorage or the seeding helpers at all", () => {
    const forbiddenStrings = [
      "localStorage",
      "getRothPlanner",
      "seedFirstRun",
      "seedExamples",
      "resetRothPlanner",
    ];
    for (const file of ADAPTER_FILES) {
      const text = srcText(file);
      for (const needle of forbiddenStrings) {
        expect(text, `${file} must not mention ${needle}`).not.toContain(
          needle,
        );
      }
    }
  });

  test("the adapter's engine imports are the five pure modules only", () => {
    const specifiers = importSpecifiers(srcText("../src/adapter.ts"));
    const engineImports = specifiers.filter((s) =>
      s.startsWith("../../server/src/"),
    );
    expect([...engineImports].sort()).toEqual(
      [
        "../../server/src/retirementEngines",
        "../../server/src/rothOptimizer",
        "../../server/src/taxEngine",
        "../../server/src/taxLaw",
        "../../server/src/workYears",
      ].sort(),
    );
  });
});

describe("behavioral isolation: extremes price independently", () => {
  test("a $0 household prices sanely (single filer, no SS)", () => {
    const n = normalizeInputs({
      pretax: 0,
      taxable: 0,
      roth: 0,
      hsa: 0,
      monthlySpending: 9500,
      currentAge: 54,
      filingStatus: "single",
      retirementAge: 58,
      endAge: 95,
    });
    expect(n.ok).toBe(true);
    if (!n.ok) return;
    const res = expectOk(calculateRetirement(n.scenario));
    expect(res.neverRunsOut).toBe(false);
    expect(res.endingBalance).toBe(0);
    // The echo carries the caller's zeros, not sample balances.
    expect(n.scenario.pretaxDollars).toBe(0);
    expect(n.scenario.portfolioCents).toBe(0);
  });

  test("a $99,000,000 household prices sanely at $199,000/mo spending", () => {
    const n = normalizeInputs({
      pretax: 99000000,
      taxable: 0,
      roth: 0,
      hsa: 0,
      monthlySpending: 199000,
      currentAge: 54,
      filingStatus: "single",
      retirementAge: 58,
      endAge: 95,
    });
    expect(n.ok).toBe(true);
    if (!n.ok) return;
    const res = expectOk(calculateRetirement(n.scenario));
    expect(res.neverRunsOut).toBe(true);
    expect(res.endingBalance).toBeGreaterThan(0);
    expect(Number.isFinite(res.endingBalance)).toBe(true);
  });

  test("the two extremes differ — the $0 run is not a cached sample answer", () => {
    const zero = normalizedScenario({
      pretax: 0,
      taxable: 0,
      roth: 0,
      hsa: 0,
      filingStatus: "single",
      socialSecurityAnnual: 0,
      spouseSocialSecurityAnnual: 0,
    });
    // normalizedScenario keeps the mfj spouseAge; single ignores it.
    const flat = normalizedScenario({
      pretax: 99000000,
      taxable: 0,
      roth: 0,
      hsa: 0,
      filingStatus: "single",
      monthlySpending: 199000,
      socialSecurityAnnual: 0,
      spouseSocialSecurityAnnual: 0,
    });
    const zeroRes = expectOk(calculateRetirement(zero));
    const flatRes = expectOk(calculateRetirement(flat));
    expect(zeroRes.endingBalance).not.toBe(flatRes.endingBalance);
    expect(zeroRes.neverRunsOut).toBe(false);
    expect(flatRes.neverRunsOut).toBe(true);
  });
});

describe("behavioral isolation: A, B, A is bit-identical", () => {
  /** Household B: different in every balance, age, and spending figure. */
  const householdB = {
    pretax: 800000,
    taxable: 900000,
    roth: 100000,
    hsa: 40000,
    monthlySpending: 6000,
    currentAge: 50,
    spouseAge: 48,
    retirementAge: 60,
    endAge: 93,
    socialSecurityAnnual: 21000,
    socialSecurityStartAge: 67,
    spouseSocialSecurityAnnual: 0,
    taxableBasisPct: 80,
    mcRuns: 200,
    mcSeed: 7,
  };

  test("calculate + Monte Carlo + Roth compare repeat bit-identically", () => {
    const runAll = (overrides: Record<string, unknown>) => {
      const s = normalizedScenario({ mcRuns: 200, mcSeed: 7, ...overrides });
      return {
        calc: calculateRetirement(s),
        mc: runRetirementMonteCarlo(s),
        roth: compareRothConversions(s),
      };
    };
    const a1 = runAll({});
    const b = runAll(householdB);
    const a2 = runAll({});

    // B really is a different answer (the runs are not all one constant).
    expect(JSON.stringify(a1.calc)).not.toBe(JSON.stringify(b.calc));
    expect(JSON.stringify(a1.mc)).not.toBe(JSON.stringify(b.mc));
    expect(JSON.stringify(a1.roth)).not.toBe(JSON.stringify(b.roth));

    // And A after B is bit-identical to A before B: no state leaked.
    expect(JSON.stringify(a2.calc)).toBe(JSON.stringify(a1.calc));
    expect(JSON.stringify(a2.mc)).toBe(JSON.stringify(a1.mc));
    expect(JSON.stringify(a2.roth)).toBe(JSON.stringify(a1.roth));

    // Spot-check the A answer is the fictional household's own, not
    // the sample's: ending wealth is priced from $3,787,000 of
    // balances, and the echo names them.
    if (!a1.calc.ok) throw new Error("A calculate failed");
    expect(a1.calc.effectiveInputs.pretax).toBe(FICTIONAL.pretax);
    expect(a1.calc.effectiveInputs.monthlySpending).toBe(9500);
  });
});

describe("behavioral isolation: mutating the sample module moves nothing", () => {
  test("rewriting SAMPLE_HOUSEHOLD leaves adapter outputs unchanged", () => {
    const before = calculateRetirement(normalizedScenario());
    expect(before.ok).toBe(true);
    const beforeJson = JSON.stringify(before);

    // What is mutated, exactly: the sample module's one mutable
    // export, the SAMPLE_HOUSEHOLD object (its `export const`
    // primitives cannot be reassigned, so the object is rewritten
    // in place instead). Every balance, spending, benchmark, and
    // Social Security figure is replaced with an extreme value.
    const household = sampleHousehold.SAMPLE_HOUSEHOLD as unknown as {
      balancesCents: Record<string, number>;
      annualSpendingCents: number;
      acaBenchmarksCents: Record<string, number>;
      socialSecurity: Record<string, number>;
    };
    const saved = {
      balancesCents: { ...household.balancesCents },
      annualSpendingCents: household.annualSpendingCents,
      acaBenchmarksCents: { ...household.acaBenchmarksCents },
      socialSecurity: { ...household.socialSecurity },
    };
    try {
      // Prove the mutation took effect before asserting on it.
      household.balancesCents.pretax = 1;
      household.balancesCents.taxable = 1;
      household.balancesCents.roth = 1;
      household.balancesCents.hsa = 1;
      household.annualSpendingCents = 1;
      household.acaBenchmarksCents.family = 1;
      household.socialSecurity.primaryAnnualCents = 1;
      household.socialSecurity.spouseAnnualCents = 1;
      expect(household.balancesCents.pretax).toBe(1);
      expect(household.annualSpendingCents).toBe(1);

      const during = calculateRetirement(normalizedScenario());
      expect(JSON.stringify(during)).toBe(beforeJson);
    } finally {
      household.balancesCents = saved.balancesCents;
      household.annualSpendingCents = saved.annualSpendingCents;
      household.acaBenchmarksCents = saved.acaBenchmarksCents;
      household.socialSecurity = saved.socialSecurity;
    }
    expect(household.balancesCents.pretax).toBe(saved.balancesCents.pretax);
    expect(household.annualSpendingCents).toBe(saved.annualSpendingCents);
  });
});
