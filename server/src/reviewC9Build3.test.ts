// Engine Review C9, Build 3 — compare-path integrity (W4-GAP-1 + W2-D2).
//
// W2-D2: unpaid tax counted in net cost but never subtracted from
// ending wealth — an insolvent plan reported its balances as wealth
// while ignoring the debt. Build 3 subtracts lifetimeUnpaidTax AS
// STATED (no growth — the engine models no interest on unpaid
// tax) from endingAfterTaxWealth in simulateRothPlan.
//
// W4-GAP-1: the limited compare crowned a winner while every
// candidate was invalid, with no signal — runRothCompare never
// called assessCandidateIntegrity and the adapter crowned by raw
// min cost / max wealth. Build 3 attaches the E4 verdict to each
// compare scenario and crowns by crownCompareWinners (valid-only,
// the optimizer's tie-breaks), and the adapter uses the engine's
// crowned winners instead of raw pickWinner.
//
// Fixture: the FICTIONAL sample household
// (server/src/sampleHousehold.ts — every figure here is invented,
// none describes any real household). The depleted household is
// the W4 probe-E construction ($10,000 pre-tax / $10,000 taxable,
// $180,000/yr spending); the forced-unpaid-tax shape is the W2
// F2 construction (an injected $20M non-cash gain at 62 against
// the sample balances). Every pinned figure below is the engine's
// own output on the stated shape, verified by execution before
// pinning — never copied from a plan the app actually serves.
//
// The adapter leg lives in assistant-api/tests/review-c9-build3.test.ts
// (the server tsconfig's rootDir forbids importing the adapter
// from a server test): the verdict must be checked where an AI
// caller reads it, not only in the engine.

import { describe, expect, test } from "bun:test";
import {
  ROTH_COMPARE_STRATEGIES,
  simulateRothPlan,
} from "./taxEngine";
import {
  planNetCost,
  runRothCompare,
} from "./rothOptimizer";
import { samplePlanInputs } from "./sampleHousehold";
import { sampleCompareBase, FILL_12_CEILINGS } from "./hardening/sensCompareBase";

const DO_NOTHING = ROTH_COMPARE_STRATEGIES[0]!;
const r2 = (n: number) => Math.round(n * 100) / 100;

// The W4 probe-E construction: the sample household with its
// balances cut to $10,000 pre-tax / $10,000 taxable, no Roth, no
// HSA, no protect-minimum, no preserve reserve — $180,000/yr of
// spending against $20,000 of balances, so every order shorts.
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

describe("C9 Build 3 — W2-D2: unpaid tax nets out of ending wealth", () => {
  test("forced unpaid tax (W2 F2): wealth falls by exactly the unpaid amount", () => {
    // An injected $20M non-cash gain at 62 creates a $5,386,149.65
    // federal bill against ~$4.8M of reachable balances. The
    // debit chain empties every bucket it can reach (pre-tax,
    // taxable, Roth all $0 at the end). Build 4 (W2-D1) added
    // the HSA as the last-resort leg, so the HSA no longer
    // survives untouched: the 2030 leg distributes the whole
    // $91,162.97 HSA, of which $18,232.59 is the §223(f)(4) 20%
    // additional tax and the rest pays the bill, and the HSA
    // ends at $0. $572,744.90 of assessed tax still stays
    // unpaid. Before Build 3, ending wealth reported the
    // balances alone ($478,910.80 — the untouched HSA, the debt
    // ignored). After Build 3 it was $478,910.80 − $611,944.97
    // = −$133,034.17. After Build 4 it is $0 − $572,744.90 =
    // −$572,744.90.
    const inputs = samplePlanInputs({ saleGainAge: 62, saleGainAmount: 20_000_000 });
    const res = simulateRothPlan(inputs, DO_NOTHING);
    expect(res.lifetimeUnpaidTax).toBe(572744.9);
    expect(res.endingAfterTaxWealth).toBe(-572744.9);
    // No balance survives — the HSA was spent on the tax bill
    // in 2030 (Build 4), the other buckets were already empty.
    expect(
      res.endingPretax + res.endingRoth + res.endingTaxable + res.endingHsa,
    ).toBe(0);
    // The corrected wealth identity, in the march's own terms:
    // balances net of terminal tax, less the unpaid tax.
    const cost = planNetCost(res, inputs);
    expect(cost.terminal).toBe(0);
    expect(
      r2(
        res.endingPretax +
          res.endingRoth +
          res.endingTaxable +
          res.endingHsa -
          cost.terminal -
          res.lifetimeUnpaidTax,
      ),
    ).toBe(res.endingAfterTaxWealth);
    // The guard sees the same insolvency the wealth now shows.
    expect(res.lifetimeUnpaidTax).toBeGreaterThan(0);
  });

  test("valid plan: wealth is unchanged bit for bit (gate-pinned)", () => {
    // The sample household never owes unpaid tax, so the
    // subtraction is $0 and every figure below is the pre-fix
    // value — the regression gate's own pin, reproduced here so
    // a future change to the subtraction cannot hide behind
    // the gate's leaf counts.
    const res = simulateRothPlan(samplePlanInputs(), DO_NOTHING);
    expect(res.lifetimeUnpaidTax).toBe(0);
    expect(res.endingAfterTaxWealth).toBe(11557998.96);
    const cmp = runRothCompare(
      sampleCompareBase(),
      [
        { name: "Do Nothing", overrides: {} },
        { name: "Fill 12%", overrides: { ceilings: FILL_12_CEILINGS } },
      ],
      2026,
    );
    expect(cmp.ok).toBe(true);
    expect(cmp.scenarios[0]!.endingAfterTaxWealthCents).toBe(1163596462);
    expect(cmp.scenarios[1]!.endingAfterTaxWealthCents).toBe(1163855786);
    expect(cmp.scenarios[0]!.unpaidTaxCents).toBe(0);
    expect(cmp.scenarios[1]!.unpaidTaxCents).toBe(0);
  });
});

describe("C9 Build 3 — W4-GAP-1: the compare crowns valid winners only", () => {
  test("all invalid: the raw winner is crowned anyway, unqualified, with the reason named", () => {
    // The W4 probe-E reproduction, now with the verdict in the
    // response: all three orders short $3,970,953.88 of spending
    // (unpaid tax $0 — the shortfall is spending, not tax, and
    // the two signals stay distinct). That shortfall is
    // $77,264.00 above probe E's $3,893,689.88 — the CUMULATIVE
    // effect of the compare path charging acaEmbeddedNetPremium
    // ($13,147.20/yr), which probe E's direct march never
    // charged: $77,264.00 is 5.8768 years of that premium, not
    // a whole number of years — the premium is charged every
    // ACA-active year but only the unfunded part of each
    // year's need lands in the lifetime shortfall, so the
    // delta is not years × premium. Removing that one field
    // from the compare-path inputs reproduces probe E exactly,
    // so the figure has not drifted. Every scenario prices
    // net cost $0 / wealth $0, so the raw crown is a three-way
    // $0 tie broken by list order — taxable-first — and it is
    // crowned UNQUALIFIED, with the raw cheapest named beside
    // its unfunded-spending reason instead of silently winning.
    const cmp = runRothCompare(depletedBase(), THREE_ORDERS, 2026, "taxable-first");
    expect(cmp.ok).toBe(true);
    expect(cmp.scenarios).toHaveLength(3);
    for (const sc of cmp.scenarios) {
      expect(sc.netCostCents).toBe(0);
      expect(sc.endingAfterTaxWealthCents).toBe(0);
      expect(sc.unpaidTaxCents).toBe(0);
      expect(sc.integrity.status).toBe("invalid");
      expect(sc.integrity.reasons).toEqual([UNFUNDED_REASON]);
      expect(sc.integrity.spendShortfallTotal).toBe(3970953.88);
      expect(sc.integrity.unpaidTaxTotal).toBe(0);
    }
    expect(cmp.winnerByNetCost).toBe("taxable-first");
    expect(cmp.winnerByEndingWealth).toBe("taxable-first");
    expect(cmp.winnerQualified).toBe(false);
    expect(cmp.winnersDiffer).toBe(false);
    expect(cmp.excludedInvalidWinner?.name).toBe("taxable-first");
    expect(cmp.excludedInvalidWinner?.integrity.reasons).toEqual([UNFUNDED_REASON]);
  });

  test("mixed: the winner IS the valid one; the raw cheapest invalid is named as excluded", () => {
    // Same depleted base, but one scenario carries the full
    // sample balances ($1,500,000 pre-tax / $2,000,000 taxable)
    // and funds its spending. Its net cost ($1,669,548.21) is
    // far above the depleted scenarios' $0 — the raw cheapest
    // is an invalid $0 — so a raw crowning would pick an
    // insolvent plan. The valid-only crown picks the funded
    // scenario for BOTH objectives and names the raw cheapest
    // invalid beside its reason.
    const cmp = runRothCompare(
      depletedBase(),
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
    expect(cmp.ok).toBe(true);
    expect(cmp.winnerByNetCost).toBe("funded");
    expect(cmp.winnerByEndingWealth).toBe("funded");
    expect(cmp.winnerQualified).toBe(true);
    expect(cmp.winnersDiffer).toBe(false);
    expect(cmp.excludedInvalidWinner?.name).toBe("taxable-first");
    expect(cmp.excludedInvalidWinner?.integrity.reasons).toEqual([UNFUNDED_REASON]);
    const funded = cmp.scenarios.find((s) => s.name === "funded")!;
    expect(funded.integrity.status).toBe("valid");
    expect(funded.netCostCents).toBe(166954821);
  });

  test("all valid: qualified, nothing excluded, the two objectives may disagree", () => {
    // The sample household, three orders: every scenario valid,
    // so the crown is qualified and excluded is null. The two
    // objectives genuinely disagree here — pre-tax-first is
    // cheapest ($1,020,256.83) while taxable-first leaves the
    // most wealth ($11,635,964.62) — and the result names both
    // instead of hiding one behind the tie-break. Pre-tax-first
    // is valid-with-benign-residual (a 1¢ settlement residual
    // inside the documented tolerance), which still counts as
    // valid: only "invalid" is excluded from winning.
    const cmp = runRothCompare(sampleCompareBase(), THREE_ORDERS, 2026, "taxable-first");
    expect(cmp.ok).toBe(true);
    expect(cmp.winnerByNetCost).toBe("pre-tax-first");
    expect(cmp.winnerByEndingWealth).toBe("taxable-first");
    expect(cmp.winnerQualified).toBe(true);
    expect(cmp.winnersDiffer).toBe(true);
    expect(cmp.excludedInvalidWinner).toBeNull();
    const byName = new Map(cmp.scenarios.map((s) => [s.name, s]));
    expect(byName.get("pre-tax-first")!.integrity.status).toBe(
      "valid-with-benign-residual",
    );
    expect(byName.get("taxable-first")!.integrity.status).toBe("valid");
    expect(byName.get("roth-first")!.integrity.status).toBe("valid");
    expect(byName.get("pre-tax-first")!.netCostCents).toBe(102025683);
    expect(byName.get("taxable-first")!.endingAfterTaxWealthCents).toBe(1163596462);
  });
});

