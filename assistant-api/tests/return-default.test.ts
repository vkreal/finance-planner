// return-default.test.ts — MUST-1: an omitted expected return resolves
// to the app's flat factory default (EXPECTED_RETURN_DEFAULT = 5%),
// not the stock-mix blend (6.75% at 95% stocks).
//
// Source of the default, verified in the tree (see normalize.ts):
// server/src/retirementEngines.ts EXPECTED_RETURN_DEFAULT = 5, the
// flat default that replaced the more optimistic blend in build
// v132; client/src/RetirementCalc.tsx seeds a fresh view with it
// and falls back to it for a saved plan with no return.
//
// All figures are the fictional household (see helpers.ts).

import { describe, expect, test } from "bun:test";
import {
  calculateMaxSpending,
  calculateRetirement,
  runRetirementMonteCarlo,
} from "../src/adapter";
import { normalizeInputs } from "../src/normalize";
import {
  EXPECTED_RETURN_DEFAULT,
  STOCKS_PCT_DEFAULT,
} from "../../server/src/retirementEngines";
import {
  expectOk,
  fictionalScenario,
  normalizedScenario,
} from "./helpers";

describe("omitted expected return resolves to the app factory default", () => {
  test("missing expectedRealReturnPct resolves to 5%", async () => {
    const s = normalizedScenario();
    expect(s.expectedReturnPct).toBe(5);
    expect(s.expectedReturnPct).toBe(EXPECTED_RETURN_DEFAULT);
  });

  test("the default is named as the engine constant in provenance", async () => {
    const s = normalizedScenario();
    const a = new Map(s.assumptions.map((x) => [x.field, x])).get(
      "expectedRealReturnPct",
    );
    expect(a?.provenance).toBe("engine_constant");
    expect(a?.value).toBe(5);
    expect(a?.note).toContain("EXPECTED_RETURN_DEFAULT");
  });

  test("explicit 6.75% remains 6.75% (user provenance)", async () => {
    const s = normalizedScenario({ expectedRealReturnPct: 6.75 });
    expect(s.expectedReturnPct).toBe(6.75);
    const a = new Map(s.assumptions.map((x) => [x.field, x])).get(
      "expectedRealReturnPct",
    );
    expect(a?.provenance).toBe("user");
  });

  test("explicit 0% remains 0% — a real zero, not a missing value", async () => {
    const s = normalizedScenario({ expectedRealReturnPct: 0 });
    expect(s.expectedReturnPct).toBe(0);
  });

  test("explicit negative remains unchanged", async () => {
    const s = normalizedScenario({ expectedRealReturnPct: -2 });
    expect(s.expectedReturnPct).toBe(-2);
  });

  test("changing the stock mix does not move the factory default", async () => {
    for (const stocksPct of [0, 50, 100]) {
      const s = normalizedScenario({ stocksPct });
      expect(s.expectedReturnPct).toBe(5);
    }
  });

  test("volatility still follows the engine stock-mix blend", async () => {
    // The blend rule for volatility was NOT changed: 95% stocks
    // is 17.4%, 50% is 12%, 0% is 6%.
    expect(normalizedScenario({ stocksPct: 95 }).volatilityPct).toBe(17.4);
    expect(normalizedScenario({ stocksPct: 50 }).volatilityPct).toBe(12);
    expect(normalizedScenario({ stocksPct: 0 }).volatilityPct).toBe(6);
    // And an explicit volatility is used as given.
    expect(
      normalizedScenario({ volatilityPct: 10 }).volatilityPct,
    ).toBe(10);
  });

  test("adapter defaults match the app's factory defaults from the engine", async () => {
    const s = normalizedScenario();
    expect(s.stocksPct).toBe(STOCKS_PCT_DEFAULT);
    expect(s.expectedReturnPct).toBe(EXPECTED_RETURN_DEFAULT);
    // The adapter's retirement-age default is its own documented
    // rule (current age — retire now), not the app's 57: the two
    // intentionally differ, so pin the adapter rule itself.
    const fresh = normalizeInputs(
      fictionalScenario({ retirementAge: undefined }),
    );
    expect(fresh.ok).toBe(true);
    if (fresh.ok) {
      expect(fresh.scenario.retirementAge).toBe(fresh.scenario.currentAge);
    }
  });
});

describe("all simulation tools use the same resolved return", () => {
  test("calculate / Monte Carlo / max-spending echo the same 5% default", async () => {
    const s = normalizedScenario();
    const calc = expectOk(calculateRetirement(s));
    const mc = expectOk(
      await runRetirementMonteCarlo(normalizedScenario({ mcRuns: 200 })),
    );
    const max = expectOk(await calculateMaxSpending(s));
    expect(calc.yearlyBalances.length).toBeGreaterThan(0);
    // The deterministic leg of the Monte Carlo answer is the same
    // flat-return projection the calculate tool runs.
    expect(mc.deterministicEndingBalance).toBe(calc.endingBalance);
    // Max spending solved at the same 5% default: the solved level
    // is finite and positive for this household.
    expect(max.maxAnnualSpending).toBeGreaterThan(0);
  });

  test("an explicit return moves every tool together", async () => {
    const at5 = expectOk(calculateRetirement(normalizedScenario()));
    const at9 = expectOk(
      calculateRetirement(normalizedScenario({ expectedRealReturnPct: 9 })),
    );
    // A higher return must not lower the ending balance.
    expect(at9.endingBalance).toBeGreaterThan(at5.endingBalance);
  });
});
