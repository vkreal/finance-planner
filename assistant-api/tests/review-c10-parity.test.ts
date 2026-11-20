// review-c10-parity.test.ts — Engine Review C10 adapter parity.
//
// The retirement_dynamic_withdrawal adapter tool must agree with
// the engine's runDynamicOptimizer on the same inputs, to the
// cent: the adapter maps the engine result, it never re-prices a
// year. The fictional household is the adapter suite's own
// (helpers.ts) with endAge 70, so the roll-forward stays fast on
// this VM.
import { describe, expect, test } from "bun:test";
import { buildRothPlanInputs, dynamicWithdrawal } from "../src/adapter";
import { dispatchTool } from "../src/tools";
import { runDynamicOptimizer, type DynamicOptimizerResult } from "../../server/src/rothOptimizer";
import { expectEnvelope, expectOk, fictionalScenario, normalizedScenario } from "./helpers";

describe("C10 — adapter parity for retirement_dynamic_withdrawal", () => {
  test("adapter result equals the direct engine result to the cent", async () => {
    const scenario = normalizedScenario({ endAge: 70 });
    const viaAdapter = expectOk(await dynamicWithdrawal(scenario));
    const direct = runDynamicOptimizer(buildRothPlanInputs(scenario));
    expect(direct.ok).toBe(true);
    expect(viaAdapter.ok).toBe(true);
    expect(viaAdapter.lifetimeNetCost).toBe(direct.lifetimeNetCost);
    expect(viaAdapter.endingAfterTaxWealth).toBe(direct.endingAfterTaxWealth);
    expect(viaAdapter.endingWealth).toBe(direct.endingWealth);
    expect(viaAdapter.lifetimeRmd).toBe(direct.lifetimeRmd);
    expect(viaAdapter.conversionsTotal).toBe(direct.conversionsTotal);
    expect(viaAdapter.floorBound).toBe(direct.floorBound);
    expect(viaAdapter.years.length).toBe(direct.years.length);
    for (let i = 0; i < direct.years.length; i++) {
      const a = viaAdapter.years[i]!;
      const d = direct.years[i]!;
      expect(a).toEqual(d);
    }
  }, 300_000);

  test("dispatchTool wires the tool and reports contract 165", async () => {
    const result = await dispatchTool(
      "retirement_dynamic_withdrawal",
      fictionalScenario({ endAge: 70 }),
    );
    // dispatchTool is untyped by design (AdapterResult<unknown>),
    // so the cast names the tool this name wires to — the first
    // test above already proves the adapter result equals the
    // engine result to the cent, so the cast asserts nothing
    // the suite has not already priced.
    const results = expectOk(result) as DynamicOptimizerResult;
    expectEnvelope(result);
    expect(results.years.length).toBeGreaterThan(0);
    expect(results.valid).toBe(true);
  }, 300_000);
});
