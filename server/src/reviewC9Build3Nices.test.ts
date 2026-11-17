// Engine Review C9, Build 3 NICEs fix — N1 (action threading)
// and N5 (sub-$0.50 reason amounts).
//
// N1: the runRothCompare ACTION used to build its response
// explicitly and drop the engine's crowned winners and
// per-scenario integrity, so the Strategy Lab re-derived its
// badges from the raw rows and crowned an invalid cheapest row
// on a mixed run. These tests drive the action's own shaping
// function (shapeRothCompareResponse, pure) and parse its output
// against the action's real response schema — the UI data the
// Lab renders, not just the engine result. The client badge
// decision itself (labWinnerFigures) is tested in
// client/src/rothShared.test.ts.
//
// N5: fmtDollars rounded to whole dollars, so a 1¢ unpaid tax
// reasoned as "unpaid tax of $0". The assessor units below pin
// the cents rendering at the boundary; verdicts and money are
// unchanged (status still invalid, totals still exact).
//
// Fixture: the FICTIONAL sample household
// (server/src/sampleHousehold.ts — every figure here is invented,
// none describes any real household). The depleted household is
// the W4 probe-E construction ($10,000 pre-tax / $10,000 taxable,
// $180,000/yr spending). Every pinned figure below is the
// engine's own output on the stated shape, verified by execution
// before pinning — never copied from a plan the app actually
// serves.

import { describe, expect, test } from "bun:test";
import { Actions, shapeRothCompareResponse } from "./actions";
import {
  assessCandidateIntegrity,
  fmtDollars,
  runRothCompare,
} from "./rothOptimizer";
import { type RothPlanResult } from "./taxEngine";
import { sampleCompareBase } from "./hardening/sensCompareBase";

// The W4 probe-E construction, as in reviewC9Build3.test.ts:
// the sample household with its balances cut to $10,000 pre-tax
// / $10,000 taxable, no Roth, no HSA, no protect-minimum, no
// preserve reserve — $180,000/yr of spending against $20,000 of
// balances, so every order shorts.
function depletedBase() {
  const base = sampleCompareBase();
  base.pretaxCents = 1_000_000;
  base.taxableCents = 1_000_000;
  base.rothCents = 0;
  base.hsaCents = 0;
  base.protectMinTaxableCents = 0;
  base.preservePretaxCents = 0;
  return base;
}

const THREE_ORDERS = [
  { name: "taxable-first", overrides: { drawOrder: "taxable-pretax-roth" } },
  { name: "pre-tax-first", overrides: { drawOrder: "pretax-taxable-roth" } },
  { name: "roth-first", overrides: { drawOrder: "roth-taxable-pretax" } },
] as never;

const UNFUNDED_REASON =
  "unfunded spending of $3,970,954: the plan cannot fund its own spending need";

// Minimal synthetic march for the assessor units (same shape as
// rothOptimizerIntegrity.test.ts's fakeResult): one converged
// year, plus the lifetime unpaid-tax / shortfall totals under
// test.
function fakeResult(unpaidTax: number, shortfall: number): RothPlanResult {
  return {
    years: [
      {
        year: 2030,
        settlementConverged: true,
        settlementMismatchCents: { gains: 0, pretax: 0, acaCredit: 0 },
        ceilingBreached: false,
        conversion: 0,
        spendShortfall: shortfall,
      },
    ],
    lifetimeUnpaidTax: unpaidTax,
  } as unknown as RothPlanResult;
}

describe("C9 Build 3 NICEs — N1: the action threads the verdict to the Lab", () => {
  test("all invalid: the shaped action response carries the unqualified flag", () => {
    // The depleted run, through the action's own shaping and
    // parsed against the action's own response schema: the
    // LabData the badges read says qualified false, names the
    // excluded raw cheapest with its reason, and carries each
    // scenario's invalid verdict — the unqualified flag is in
    // the UI data, not just the engine.
    const base = depletedBase();
    const cmp = runRothCompare(base, THREE_ORDERS, 2026, "taxable-first");
    expect(cmp.winnerQualified).toBe(false);
    const shaped = shapeRothCompareResponse(cmp, base, 2026);
    const res = Actions.runRothCompare.response.parse(shaped);
    expect(res.ok).toBe(true);
    expect(res.winnerByNetCost).toBe("taxable-first");
    expect(res.winnerByEndingWealth).toBe("taxable-first");
    expect(res.winnerQualified).toBe(false);
    expect(res.winnersDiffer).toBe(false);
    expect(res.excludedInvalidWinner).toEqual({
      name: "taxable-first",
      reasons: [UNFUNDED_REASON],
    });
    expect(res.scenarios).toHaveLength(3);
    for (const sc of res.scenarios) {
      expect(sc.integrity.status).toBe("invalid");
      expect(sc.integrity.reasons).toEqual([UNFUNDED_REASON]);
      expect(sc.integrity.unpaidTax).toBe(0);
      expect(sc.integrity.spendShortfall).toBe(3970953.88);
    }
  });

  test("mixed: the shaped response crowns the valid winner, not the invalid $0 row", () => {
    // Same depleted base, but one scenario carries the full
    // sample balances and funds its spending. Its net cost
    // ($1,669,548.21) is far above the depleted scenarios' $0 —
    // the old Lab badges (raw min net cost) would have crowned
    // an invalid $0 row. The shaped response names the funded
    // scenario on both objectives and the invalid cheapest as
    // excluded, so the badges follow the valid winner.
    const base = depletedBase();
    const cmp = runRothCompare(
      base,
      [
        { name: "taxable-first", overrides: { drawOrder: "taxable-pretax-roth" } },
        { name: "pre-tax-first", overrides: { drawOrder: "pretax-taxable-roth" } },
        {
          name: "funded",
          overrides: {
            drawOrder: "taxable-pretax-roth",
            taxableCents: 200_000_000,
            pretaxCents: 150_000_000,
          },
        },
      ] as never,
      2026,
      "taxable-first",
    );
    const res = Actions.runRothCompare.response.parse(
      shapeRothCompareResponse(cmp, base, 2026),
    );
    expect(res.ok).toBe(true);
    expect(res.winnerByNetCost).toBe("funded");
    expect(res.winnerByEndingWealth).toBe("funded");
    expect(res.winnerQualified).toBe(true);
    expect(res.winnersDiffer).toBe(false);
    expect(res.excludedInvalidWinner).toEqual({
      name: "taxable-first",
      reasons: [UNFUNDED_REASON],
    });
    const byName = new Map(res.scenarios.map((s) => [s.name, s]));
    expect(byName.get("funded")!.integrity.status).toBe("valid");
    expect(byName.get("taxable-first")!.integrity.status).toBe("invalid");
    expect(byName.get("funded")!.netCostCents).toBe(166954821);
  });

  test("valid control: qualified, nothing excluded, winners unchanged", () => {
    // The sample household, three orders: every scenario valid,
    // so the crown is qualified, excluded is null, and the two
    // objectives disagree exactly as the engine crowns them —
    // pre-tax-first cheapest, taxable-first most wealth. The
    // badge figures on this run are the raw min/max, so the Lab
    // badges identically to before the threading.
    const base = sampleCompareBase();
    const cmp = runRothCompare(base, THREE_ORDERS, 2026, "taxable-first");
    const res = Actions.runRothCompare.response.parse(
      shapeRothCompareResponse(cmp, base, 2026),
    );
    expect(res.ok).toBe(true);
    expect(res.winnerByNetCost).toBe("pre-tax-first");
    expect(res.winnerByEndingWealth).toBe("taxable-first");
    expect(res.winnerQualified).toBe(true);
    expect(res.winnersDiffer).toBe(true);
    expect(res.excludedInvalidWinner).toBeNull();
    const byName = new Map(res.scenarios.map((s) => [s.name, s]));
    expect(byName.get("pre-tax-first")!.integrity.status).toBe(
      "valid-with-benign-residual",
    );
    expect(byName.get("taxable-first")!.integrity.status).toBe("valid");
    expect(byName.get("pre-tax-first")!.netCostCents).toBe(102025683);
    expect(byName.get("taxable-first")!.endingAfterTaxWealthCents).toBe(1163596462);
  });
});

describe("C9 Build 3 NICEs — N5: sub-$0.50 reason amounts read in cents", () => {
  test("1¢ unpaid tax reasons as $0.01, not $0", () => {
    const i = assessCandidateIntegrity(fakeResult(0.01, 0));
    expect(i.status).toBe("invalid");
    expect(i.unpaidTaxTotal).toBe(0.01);
    expect(i.reasons).toEqual([
      "unpaid tax of $0.01: assessed tax the balances could not pay",
    ]);
  });

  test("1¢ unfunded spending reasons as $0.01, not $0", () => {
    const i = assessCandidateIntegrity(fakeResult(0, 0.01));
    expect(i.status).toBe("invalid");
    expect(i.spendShortfallTotal).toBe(0.01);
    expect(i.reasons).toEqual([
      "unfunded spending of $0.01: the plan cannot fund its own spending need",
    ]);
  });

  test("whole-dollar amounts still render whole (no cents leak)", () => {
    const i = assessCandidateIntegrity(fakeResult(0, 3970953.88));
    expect(i.status).toBe("invalid");
    expect(i.reasons).toEqual([UNFUNDED_REASON]);
  });

  test("sub-half-cent amounts never render as $0.00 (direct fmtDollars)", () => {
    // Unreachable via the assessor — it r2-rounds its totals,
    // so a $0.004 unpaid tax reads $0.00 there and reasons
    // nothing — so this drives fmtDollars directly, the level
    // its other call sites (ceiling names, ACA position) read
    // it at. A nonzero amount below half a cent has no exact
    // cents rendering: it reads "<$0.01", with the U+2212
    // minus for negatives.
    expect(fmtDollars(0.004)).toBe("<$0.01");
    expect(fmtDollars(-0.004)).toBe("−<$0.01");
    expect(fmtDollars(0.01)).toBe("$0.01");
    expect(fmtDollars(0.49)).toBe("$0.49");
    // $0.50 is outside the sub-$0.50 leg: whole-dollar rounding
    // (Math.round halves up) renders $1, not $0.50.
    expect(fmtDollars(0.5)).toBe("$1");
    // Whole-dollar controls, including the zero that a nonzero
    // amount must never be confused with.
    expect(fmtDollars(0)).toBe("$0");
    expect(fmtDollars(1234)).toBe("$1,234");
    expect(fmtDollars(-2500)).toBe("−$2,500");
  });
});
