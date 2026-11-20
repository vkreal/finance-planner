// review5.test.ts — Engine Review 5 (E5-S1 survivor precision,
// E5-S2 first-RMD deferral) at the march + adapter level.
//
// The law pins live in server/src/retirementReview5.test.ts;
// this file prices the same rules through runRothCompare and
// the adapter, on the fictional household (see helpers.ts:
// pretax $1,250,000; taxable $2,100,000; Roth $375,000; HSA
// $62,000; spending $9,500/mo; ages 54/52 in 2026; retire 58;
// end age 95; SS $36,000/yr at 67, spouse $18,000/yr at 67).
// Birth years read off the ages: primary 1972, spouse 1974.
// First RMD years: primary 2047 (age 75), spouse 2049.
//
// Every expected figure is hand-computed from those inputs:
// the survivor benefits from the SSA rules pinned in the
// engine file (71.5% at 60, the widow(er)'s limit), the
// deferral relationships from the march's own documented
// ordering (distributions first, growth after — so a deferred
// dollar stays invested one more year at the 5% return).
//
// Run per-file: bun test assistant-api/tests/review5.test.ts

import { describe, expect, test } from "bun:test";
import {
  buildRothCompareBase,
  calculateSingleYearTax,
  compareRothConversions,
} from "../src/adapter";
import { dispatchTool } from "../src/tools";
import { runRothCompare } from "../../server/src/rothOptimizer";
import {
  expectOk,
  fictionalScenario,
  normalizedScenario,
  round2,
} from "./helpers";

const START_YEAR = 2026;

function march(overrides: Record<string, unknown> = {}) {
  const s = normalizedScenario();
  const result = runRothCompare(
    buildRothCompareBase(s),
    [
      {
        name: "Do nothing",
        overrides: {
          ceilings: null,
          drawOrder: "taxable-first",
          ...overrides,
        },
      },
    ],
    START_YEAR,
    "Do nothing",
  );
  expect(result.ok).toBe(true);
  expect(result.scenarios).toHaveLength(1);
  return result.scenarios[0]!;
}

function yearOf(
  scenario: ReturnType<typeof march>,
  year: number,
) {
  const row = scenario.years.find((y) => y.year === year);
  expect(row).toBeDefined();
  return row!;
}

// ---------------------------------------------------------------------------
// §3 — first-RMD deferral through the march (E5-S2)
// ---------------------------------------------------------------------------

describe("E5 §3 — first-RMD deferral through the march", () => {
  test("no election vs explicit false: bit-identical years", async () => {
    const omitted = march();
    const explicit = march({ firstRmdDeferralPrimary: false });
    expect(explicit.years).toEqual(omitted.years);
    expect(explicit.netCostCents).toBe(omitted.netCostCents);
    expect(explicit.endingAfterTaxWealthCents).toBe(
      omitted.endingAfterTaxWealthCents,
    );
  });

  test("deferred year prices $0 and names the deferred amount", async () => {
    const immediate = march();
    const deferred = march({ firstRmdDeferralPrimary: true });
    const carry = yearOf(immediate, 2047).rmdPrimaryCents;
    expect(carry).toBeGreaterThan(0);
    const d2047 = yearOf(deferred, 2047);
    expect(d2047.rmdPrimaryCents).toBe(0);
    expect(d2047.rmdDeferredPrimaryCents).toBe(carry);
    expect(d2047.rmdDeferredPaidPrimaryCents).toBe(0);
    // The spouse is 73 in 2047 (first RMD 2049) — untouched.
    expect(d2047.rmdSpouseCents).toBe(0);
    expect(d2047.rmdDeferredSpouseCents).toBe(0);
  });

  test("following year pays both RMDs, deferred dollars grown one year", async () => {
    const immediate = march();
    const deferred = march({ firstRmdDeferralPrimary: true });
    const carry = yearOf(immediate, 2047).rmdPrimaryCents;
    const d2048 = yearOf(deferred, 2048);
    const i2048 = yearOf(immediate, 2048);
    // The carry is paid in full in 2048.
    expect(d2048.rmdDeferredPaidPrimaryCents).toBe(carry);
    expect(d2048.rmdDeferredPrimaryCents).toBe(0);
    // The deferred dollars stayed in the pre-tax balance through
    // 2047 and earned the 5% return (distributions first, growth
    // after — see the march's year-end growth step), so the
    // 2048 own RMD is larger by carry × 1.05 / 23.7 (the Uniform
    // divisor at 76). The ±2¢ is the two roundings to cents.
    const expected =
      i2048.rmdPrimaryCents + carry + (carry * 1.05) / 23.7;
    expect(
      Math.abs(d2048.rmdPrimaryCents - expected),
    ).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// §2 — survivor Social Security through the march (E5-S1)
// ---------------------------------------------------------------------------

describe("E5 §2 — survivor Social Security through the march", () => {
  test("death after both claim, enhanced at 60: $25,740/yr", async () => {
    // Primary dies 2043 (age 71, spouse 69). Death year: both
    // benefits in full, $36,000 + $18,000 = $54,000. Survivor
    // years: PIA $36,000 × 0.715 = $25,740 (the survivor's own
    // $18,000 is smaller, so the survivor benefit wins — never
    // the sum).
    const enhanced = march({
      survivorEnabled: true,
      survivorWho: "primary",
      survivorDeathYear: 2043,
      survivorClaimAge: 60,
    });
    expect(yearOf(enhanced, 2043).ssCollectedCents).toBe(5400000);
    expect(yearOf(enhanced, 2044).ssCollectedCents).toBe(2574000);
    expect(yearOf(enhanced, 2044).survivorSsMode).toBe("enhanced");
    expect(yearOf(enhanced, 2044).survivorClaimAge).toBe(60);
    expect(yearOf(enhanced, 2042).survivorSsMode).toBeNull();
  });

  test("same death, simplified (no claiming age): $36,000/yr", async () => {
    // No claiming age → the simplified max-of-two-benefits rule:
    // max($36,000, $18,000) = $36,000 from the year after death.
    const simplified = march({
      survivorEnabled: true,
      survivorWho: "primary",
      survivorDeathYear: 2043,
    });
    expect(yearOf(simplified, 2043).ssCollectedCents).toBe(5400000);
    expect(yearOf(simplified, 2044).ssCollectedCents).toBe(3600000);
    expect(yearOf(simplified, 2044).survivorSsMode).toBe("simplified");
    expect(yearOf(simplified, 2044).survivorClaimAge).toBeNull();
  });

  test("death before either claims: enhanced pays from 60, simplified $0 until 67", async () => {
    // Primary dies 2035 (age 63, spouse 61) — before either
    // benefit begins. Enhanced at 60: base PIA $36,000 (no
    // DRCs — died before FRA) × 0.715 = $25,740 from the year
    // after death. Simplified: max($0, $0) = $0 until 2039,
    // when the deceased WOULD have turned 67 ($36,000).
    const enhanced = march({
      survivorEnabled: true,
      survivorWho: "primary",
      survivorDeathYear: 2035,
      survivorClaimAge: 60,
    });
    expect(yearOf(enhanced, 2035).ssCollectedCents).toBe(0);
    expect(yearOf(enhanced, 2036).ssCollectedCents).toBe(2574000);
    const simplified = march({
      survivorEnabled: true,
      survivorWho: "primary",
      survivorDeathYear: 2035,
    });
    expect(yearOf(simplified, 2036).ssCollectedCents).toBe(0);
    expect(yearOf(simplified, 2039).ssCollectedCents).toBe(3600000);
  });

  test("after a death the survivor's RMD runs on the combined balance", async () => {
    // Spouse's RMD age is 75 (2049). In survivor years the
    // primary's RMD stops and the spouse's prices on the
    // combined inherited balance.
    const run = march({
      survivorEnabled: true,
      survivorWho: "primary",
      survivorDeathYear: 2043,
      survivorClaimAge: 60,
    });
    expect(yearOf(run, 2049).rmdPrimaryCents).toBe(0);
    expect(yearOf(run, 2049).rmdSpouseCents).toBeGreaterThan(0);
  });

  test("no survivor scenario vs explicit off: bit-identical years", async () => {
    const omitted = march();
    const explicit = march({ survivorEnabled: false });
    expect(explicit.years).toEqual(omitted.years);
    expect(explicit.netCostCents).toBe(omitted.netCostCents);
  });

  test("death in the first RMD year voids a new deferral (spec §3)", async () => {
    // The primary's first RMD year is 2047. Dying that year
    // with the election on takes the RMD in the death year —
    // the amount is owed, so it is not deferred — and the year
    // prices exactly as the no-election control.
    const control = march();
    const died = march({
      firstRmdDeferralPrimary: true,
      survivorEnabled: true,
      survivorWho: "primary",
      survivorDeathYear: 2047,
    });
    const c2047 = yearOf(control, 2047);
    const d2047 = yearOf(died, 2047);
    expect(d2047.rmdPrimaryCents).toBe(c2047.rmdPrimaryCents);
    expect(d2047.rmdDeferredPrimaryCents).toBe(0);
    expect(d2047.rmdDeferredPaidPrimaryCents).toBe(0);
  });

  test("defer in year 1, die in year 2: the pending amount is paid in the death year", async () => {
    // Defer the 2047 first RMD, die in 2048. The death year
    // pays its own RMD plus the full pending amount — the same
    // two-RMD total as the no-death deferred run (the death
    // year's own RMD is figured exactly as if the primary had
    // lived the year).
    const control = march();
    const deferred = march({ firstRmdDeferralPrimary: true });
    const died = march({
      firstRmdDeferralPrimary: true,
      survivorEnabled: true,
      survivorWho: "primary",
      survivorDeathYear: 2048,
    });
    const carry = yearOf(control, 2047).rmdPrimaryCents;
    const d2047 = yearOf(died, 2047);
    expect(d2047.rmdPrimaryCents).toBe(0);
    expect(d2047.rmdDeferredPrimaryCents).toBe(carry);
    const d2048 = yearOf(died, 2048);
    const def2048 = yearOf(deferred, 2048);
    expect(d2048.rmdDeferredPaidPrimaryCents).toBe(carry);
    expect(d2048.rmdPrimaryCents).toBe(def2048.rmdPrimaryCents);
    // And the survivor years after: the primary's RMD stops.
    expect(yearOf(died, 2049).rmdPrimaryCents).toBe(0);
  });

  test("a $0-balance first RMD year still counts: the combined year cannot defer", async () => {
    // Spouse born 1974, first RMD year 2049. The primary dies
    // in 2049 — in the death year the spouse's own RMD is $0
    // (her pre-tax balance is $0), but 2049 IS her first RMD
    // year, so the following combined year (2050), which
    // prices her RMD on the inherited combined balance, must
    // NOT defer it even with her election on. Before the fix
    // the $0 year never set had, so 2050 deferred the whole
    // combined RMD a year late.
    const control = march({
      survivorEnabled: true,
      survivorWho: "primary",
      survivorDeathYear: 2049,
    });
    const deferred = march({
      firstRmdDeferralSpouse: true,
      survivorEnabled: true,
      survivorWho: "primary",
      survivorDeathYear: 2049,
    });
    expect(yearOf(deferred, 2049).rmdSpouseCents).toBe(0);
    expect(yearOf(deferred, 2049).rmdDeferredSpouseCents).toBe(0);
    const c2050 = yearOf(control, 2050);
    const d2050 = yearOf(deferred, 2050);
    expect(c2050.rmdSpouseCents).toBeGreaterThan(0);
    expect(d2050.rmdSpouseCents).toBe(c2050.rmdSpouseCents);
    expect(d2050.rmdDeferredSpouseCents).toBe(0);
    expect(d2050.rmdDeferredPaidSpouseCents).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §7 — adapter surfaces the E5 fields and guards the inputs
// ---------------------------------------------------------------------------

describe("E5 §7 — adapter: single-year deferral", () => {
  test("the tax-year tool prices the deferral and echoes it", async () => {
    // Primary 73 in 2026 (born 1953), first RMD year, $600,000
    // prior-year-end balance: 600,000 / 26.5 = $22,641.51.
    // (The priced age reads off currentAge + taxYear −
    // startYear, so a 2025 price at 73 would need currentAge
    // 74 — the 2026 price keeps the ages as entered.)
    const s = normalizedScenario({
      currentAge: 73,
      spouseAge: 71,
      retirementAge: 73,
      taxYear: 2026,
      pretaxPriorYearEndAnnual: 600000,
      firstRmdDeferralPrimary: true,
    });
    const res = expectOk(calculateSingleYearTax(s));
    expect(res.rmdPrimary).toBe(0);
    expect(res.rmdDeferredPrimary).toBe(22641.51);
    expect(res.rmd).toBe(0);
  });

  test("the tax-year tool prices the two-RMD year from the carry", async () => {
    const s = normalizedScenario({
      currentAge: 74,
      spouseAge: 72,
      retirementAge: 74,
      taxYear: 2026,
      pretaxPriorYearEndAnnual: 600000,
      firstRmdDeferredCarryPrimaryAnnual: 22641.51,
    });
    const res = expectOk(calculateSingleYearTax(s));
    expect(res.rmdPrimary).toBe(46170.92);
    expect(res.rmdDeferredPaidPrimary).toBe(22641.51);
  });
});

describe("E5 §7 — adapter: survivor scenario guards + disclosures", () => {
  test("survivor enabled without a death year is missing_input", async () => {
    const result = await dispatchTool(
      "retirement_roth_conversion",
      fictionalScenario({ survivorEnabled: true }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected missing_input, got ok");
    expect(result.error.code).toBe("missing_input");
    expect(result.error.missing).toContain("survivorDeathYear");
  });

  test("a claiming age with no survivor scenario is warned, not priced", async () => {
    const s = normalizedScenario({ survivorClaimAge: 60 });
    const result = await compareRothConversions(s);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok, got an error");
    expect(
      result.warnings.some((w) => w.toLowerCase().includes("survivor")),
    ).toBe(true);
  });

  test("the roth tool's yearly table names the enhanced mode", async () => {
    const s = normalizedScenario({
      survivorEnabled: true,
      survivorWho: "primary",
      survivorDeathYear: 2043,
      survivorClaimAge: 60,
    });
    const res = expectOk(await compareRothConversions(s)) as unknown as {
      yearly: Array<{
        year: number;
        ssCollected: number;
        survivorSsMode: string | null;
        survivorClaimAge: number | null;
      }>;
      scenarios: Array<{
        name: string;
        rmdDeferral: {
          survivorSsMode: string | null;
          survivorClaimAge: number | null;
        };
      }>;
    };
    const row2044 = res.yearly.find((y) => y.year === 2044);
    expect(row2044?.survivorSsMode).toBe("enhanced");
    expect(row2044?.survivorClaimAge).toBe(60);
    // The enhanced benefit itself, through the adapter:
    // $36,000 PIA × 0.715 = $25,740 in survivor years.
    expect(row2044?.ssCollected).toBe(25740);
    const row2043 = res.yearly.find((y) => y.year === 2043);
    expect(row2043?.ssCollected).toBe(54000);
    const row2042 = res.yearly.find((y) => y.year === 2042);
    expect(row2042?.survivorSsMode).toBeNull();
    for (const sc of res.scenarios) {
      expect(sc.rmdDeferral.survivorSsMode).toBe("enhanced");
      expect(sc.rmdDeferral.survivorClaimAge).toBe(60);
    }
  });

  test("the roth tool's deferral summary names the two-RMD year", async () => {
    const s = normalizedScenario({ firstRmdDeferralPrimary: true });
    const res = expectOk(await compareRothConversions(s)) as unknown as {
      yearly: Array<{
        year: number;
        rmdDeferredPrimary: number;
        rmdDeferredPaidPrimary: number;
      }>;
      scenarios: Array<{
        name: string;
        rmdDeferral: {
          deferredTotal: number;
          deferredPaidTotal: number;
          twoRmdYears: number[];
        };
      }>;
    };
    // The baseline (Do Nothing) defers the 2047 first RMD and
    // pays it in 2048 — the summary totals agree and 2048 is a
    // two-RMD year. (Heavy converters are NOT asserted here:
    // Fill 22% converts the pre-tax balance down to ~$0 before
    // 2047, so there is almost nothing left to defer — $0.25
    // on Fill 22%, $0 on Fill 22% IRMAA Tier 1 — which is the
    // engine pricing the election on the balance that exists,
    // not a missing election.)
    const baseline = res.scenarios.find((sc) => sc.name === "do-nothing");
    expect(baseline).toBeDefined();
    expect(baseline!.rmdDeferral.deferredTotal).toBeGreaterThan(0);
    expect(baseline!.rmdDeferral.deferredPaidTotal).toBe(
      round2(baseline!.rmdDeferral.deferredTotal),
    );
    expect(baseline!.rmdDeferral.twoRmdYears).toContain(2048);
    const row2047 = res.yearly.find((y) => y.year === 2047);
    expect(row2047?.rmdDeferredPrimary).toBeGreaterThan(0);
    const row2048 = res.yearly.find((y) => y.year === 2048);
    expect(row2048?.rmdDeferredPaidPrimary).toBe(
      row2047?.rmdDeferredPrimary,
    );
  });
});
