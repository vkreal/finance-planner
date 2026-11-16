// review-c6-precision.test.ts — Engine Review C6, C6-S2 (safe
// integer monetary precision) and C6-V1 (spending rounding policy).
//
// C6-S2: the dollars↔cents converters reject amounts that cannot
// be represented exactly in integer cents, with explicit errors —
// non-finite input, and any result past the safe-integer range.
// Valid conversions are bit-identical to before the fix.
//
// C6-V1 (ESTABLISHED POLICY, documented — not changed): the
// canonical stored unit is ANNUAL integer cents. Monthly spending
// is a display/entry unit supported to whole-cent precision: the
// UI rounds any typed monthly figure to whole cents first
// (parseMoney) and then takes annual = monthly-cents × 12, while
// the adapter rounds ONCE at the annual level,
// annualSpendingCents = Math.round(monthly × 12 × 100). The two
// agree exactly on every monthly value the UI can express
// (whole cents); they differ only on sub-cent monthly fractions
// the UI cannot enter, where the adapter's once-rounded annual
// figure is the priced one. The retirement engine, the tax-aware
// engine, and the December projection all consume the same
// annual integer cents, so no surface prices a different annual
// spending for the same input. The monthly echo in
// effectiveInputs is the priced annual ÷ 12 rounded to the cent
// for display, and can differ from the typed monthly by the
// sub-cent remainder — it is a readout, not a re-input.
//
// All figures are the fictional household (see helpers.ts).
// Run per-file:
//   bun test assistant-api/tests/review-c6-precision.test.ts

import { describe, expect, test } from "bun:test";
import {
  centsToDollars,
  dollarsToCents,
} from "../src/adapter";
import { dollarsToCents as normalizeDollarsToCents, normalizeInputs } from "../src/normalize";
import { fictionalScenario, normalizedScenario } from "./helpers";

describe("C6-S2: dollarsToCents", () => {
  test("valid conversions are exact (both twins agree)", () => {
    const cases: Array<[number, number]> = [
      [0, 0],
      [0.004, 0],
      [0.005, 1],
      [0.01, 1],
      [19.99, 1999],
      [1000, 100000],
      [100000000, 10000000000],
    ];
    for (const [dollars, cents] of cases) {
      expect(dollarsToCents(dollars)).toBe(cents);
      expect(normalizeDollarsToCents(dollars)).toBe(cents);
    }
  });

  test("negative zero passes through as -0", () => {
    expect(Object.is(dollarsToCents(-0), -0)).toBe(true);
    expect(Object.is(normalizeDollarsToCents(-0), -0)).toBe(true);
  });

  test("non-finite input throws an explicit error (both twins)", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(() => dollarsToCents(bad)).toThrow(
        "dollarsToCents: non-finite dollar amount",
      );
      expect(() => normalizeDollarsToCents(bad)).toThrow(
        "dollarsToCents: non-finite dollar amount",
      );
    }
  });

  test("an amount past the safe-integer range throws, one cent off exact", () => {
    // $90,071,992,547,409.93 is exactly 9,007,199,254,740,993
    // cents — one past 2^53, so the double product lands on
    // ...994, one cent high. The converter refuses it instead
    // of silently mispricing by a cent.
    expect(() => dollarsToCents(90071992547409.93)).toThrow(
      "dollarsToCents: amount cannot be represented exactly in integer cents",
    );
    expect(() => normalizeDollarsToCents(90071992547409.93)).toThrow(
      "dollarsToCents: amount cannot be represented exactly in integer cents",
    );
  });

  test("the largest exactly representable cent amount converts", () => {
    // 2^53 − 1 cents = $90,071,992,547,409.91 exactly.
    expect(dollarsToCents(90071992547409.91)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });
});

describe("C6-S2: centsToDollars", () => {
  test("valid conversions are exact", () => {
    expect(centsToDollars(0)).toBe(0);
    expect(centsToDollars(1)).toBe(0.01);
    expect(centsToDollars(1999)).toBe(19.99);
    expect(centsToDollars(10000000000)).toBe(100000000);
    expect(centsToDollars(Number.MAX_SAFE_INTEGER)).toBe(
      90071992547409.91,
    );
  });

  test("negative zero passes through as -0", () => {
    expect(Object.is(centsToDollars(-0), -0)).toBe(true);
  });

  test("non-finite input throws an explicit error", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(() => centsToDollars(bad)).toThrow(
        "centsToDollars: non-finite cent amount",
      );
    }
  });

  test("a cent amount past the safe-integer range throws", () => {
    expect(() => centsToDollars(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      "centsToDollars: amount cannot be represented exactly in integer cents",
    );
    expect(() => centsToDollars(Number.MAX_SAFE_INTEGER + 2)).toThrow(
      "centsToDollars: amount cannot be represented exactly in integer cents",
    );
  });
});

describe("C6-S2: portfolio-level sums", () => {
  test("four $100M balances (the schema max each) sum safely", () => {
    const s = normalizedScenario({
      pretax: 100000000,
      taxable: 100000000,
      roth: 100000000,
      hsa: 100000000,
    });
    expect(s.portfolioCents).toBe(40000000000);
    expect(Number.isSafeInteger(s.portfolioCents)).toBe(true);
  });

  test("a balance above the $100M schema cap is rejected, not summed", () => {
    const n = normalizeInputs(fictionalScenario({ pretax: 100000001 }));
    expect(n.ok).toBe(false);
    if (!n.ok) expect(n.error.error.code).toBe("invalid_input");
  });

  test("NaN / Infinity balances are rejected by the schema", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const n = normalizeInputs(fictionalScenario({ pretax: bad }));
      expect(n.ok).toBe(false);
    }
  });

  test("aggregated balances stay safe: the fictional portfolio foots", () => {
    const s = normalizedScenario();
    expect(s.portfolioCents).toBe(
      (1250000 + 2100000 + 375000 + 62000) * 100,
    );
  });
});

describe("C6-V1: spending rounding (established policy)", () => {
  test("annual = Math.round(monthly × 12 × 100), rounded once at the annual level", () => {
    expect(normalizedScenario({ monthlySpending: 1000 }).annualSpendingCents).toBe(1200000);
    expect(normalizedScenario({ monthlySpending: 1000.01 }).annualSpendingCents).toBe(1200012);
    // A sub-cent monthly is NOT pre-rounded: $1,000.005/mo is
    // $12,000.06/yr (annual-first), not $12,000.12/yr
    // (monthly-cents-first) — see the policy note above.
    expect(normalizedScenario({ monthlySpending: 1000.005 }).annualSpendingCents).toBe(1200006);
    expect(normalizedScenario({ monthlySpending: 9500.555 }).annualSpendingCents).toBe(11400666);
  });

  test("half-cent annual boundaries round half up", () => {
    // monthly × 1200 lands exactly on a half cent of annual:
    // 1,200,000.5 annual cents → 1,200,001 (Math.round, half up).
    expect(
      normalizedScenario({ monthlySpending: 1000.0004166666667 }).annualSpendingCents,
    ).toBe(1200001);
    // 1,199,999.5 annual cents → 1,200,000.
    expect(
      normalizedScenario({ monthlySpending: 999.9995833333334 }).annualSpendingCents,
    ).toBe(1200000);
  });

  test("tiny monthly figures still annualize to whole cents", () => {
    expect(normalizedScenario({ monthlySpending: 0.005 }).annualSpendingCents).toBe(6);
    expect(normalizedScenario({ monthlySpending: 0.004 }).annualSpendingCents).toBe(5);
    expect(normalizedScenario({ monthlySpending: 0.001 }).annualSpendingCents).toBe(1);
  });

  test("whole-cent monthlies agree with the UI's monthly-cents-first rule", () => {
    // The UI rounds the typed monthly to whole cents, then ×12.
    // On every whole-cent monthly the adapter's annual-first
    // rounding gives the identical annual cents.
    for (const monthly of [9500, 1000.01, 1234.56, 0.01, 200000]) {
      const annual = normalizedScenario({ monthlySpending: monthly }).annualSpendingCents;
      expect(annual).toBe(Math.round(monthly * 100) * 12);
    }
  });

  test("zero monthly spending is rejected (spending must be > 0)", () => {
    const n = normalizeInputs(fictionalScenario({ monthlySpending: 0 }));
    expect(n.ok).toBe(false);
  });

  test("the minimum-spending floor converts through the same guard", () => {
    const s = normalizedScenario({ minimumAnnualSpending: 50000 });
    expect(s.minimumAnnualSpendingCents).toBe(5000000);
    const none = normalizedScenario({ minimumAnnualSpending: 0 });
    expect(none.minimumAnnualSpendingCents).toBe(null);
  });
});
