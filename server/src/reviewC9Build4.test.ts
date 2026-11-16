// Engine Review C9, Build 4 — HSA in the tax-payment debit chain (W2-D1).
//
// W2-D1: the HSA was never in the tax-payment debit chain. The
// audit's forced-exhaustion march F2 (fictional sample household
// + an injected $20M LTCG at 62) left $611,944.97 of tax unpaid
// in 2030 while the HSA held $95,721.12 and kept growing to
// $478,910.80 by 2063. `debitUnpaid` had no HSA leg; the HSA
// only grew; no HSA draw existed in the draw-order loop. Build 4
// adds the HSA leg to `debitUnpaid` as the LAST RESORT — after
// surplus cash, the payTaxFrom channel, and Taxable, Pre-tax,
// and Roth are exhausted, before unpaid tax is recorded.
//
// The leg's economics (see the leg's own comments in taxEngine.ts):
// a distribution to pay tax is NOT a qualified medical expense,
// so it is ordinary income in full — priced by the settlement
// feedback channel (fbHsaIn / createdFbHsa, the fixed point,
// exactly like fbPretaxIn / fbRothIn), NOT a gross-up, because
// the income-tax rate on the distribution is bracket-dependent
// and no closed-form gross-up is exact. The IRC §223(f)(4) 20%
// additional tax before 65 IS grossed up inside the leg
// (D = rest / 0.8, exact — the rate is flat) and joins `penalty`
// for scoring; at 65+ there is no additional tax. The owner age
// for the §223(f)(4) gate is the primary's while both spouses
// are alive, the survivor's once combined — the engine carries
// a single HSA balance with no owner split anywhere, the same
// convention as convOwnerAge.
//
// Fixture: the FICTIONAL sample household
// (server/src/sampleHousehold.ts — every figure here is invented,
// none describes any real household). Every pinned figure below
// is the engine's own output on the stated shape, verified by
// execution before pinning — never copied from a plan the app
// actually serves.
//
// Funding-identity note: the march's `y.funding` fields are r2
// of unrounded settlement accumulators, so their identity can
// sit up to ~2¢ off on a year whose balances carry sub-cent
// growth dust — the W2 §8 total-system bar ($0.02–$0.03). The
// PUBLISHED funding identity is the funding row's, which
// absorbs ≤10¢ onto the largest source by design
// (buildRothFunding) and foots at exactly 0¢. The tests assert
// the row identity at exactly 0 and the y.funding identity
// within the W2 dust bar.

import { describe, expect, test } from "bun:test";
import {
  ROTH_COMPARE_STRATEGIES,
  simulateRothPlan,
} from "./taxEngine";
import {
  buildRothFunding,
  planNetCost,
  runRothCompare,
} from "./rothOptimizer";
import { samplePlanInputs } from "./sampleHousehold";
import { sampleCompareBase, FILL_12_CEILINGS } from "./hardening/sensCompareBase";

const DO_NOTHING = ROTH_COMPARE_STRATEGIES[0]!;
const FILL_12 = ROTH_COMPARE_STRATEGIES[1]!;
const r2 = (n: number) => Math.round(n * 100) / 100;

// The W2 F2 construction: the sample household + an injected
// $20M non-cash gain at 62.
function f2Inputs() {
  return samplePlanInputs({ saleGainAge: 62, saleGainAmount: 20_000_000 });
}

// The partial-HSA construction: the sample household with its
// balances cut to $10,000 pre-tax / $10,000 taxable / $10,000
// Roth, + an injected $200,000 gain at 62. The bill is small
// enough that the HSA leg only pays the reprice delta — the HSA
// is drawn on but survives.
function partialInputs() {
  return samplePlanInputs({
    pretaxStart: 10_000,
    taxableStart: 10_000,
    rothStart: 10_000,
    saleGainAge: 62,
    saleGainAmount: 200_000,
  });
}

// The 65+ construction: the same small balances, + an injected
// $20M gain at 66 (primary 66 in 2034) — the §223(f)(4) age-65
// exception applies, so the HSA leg carries no additional tax.
function age65Inputs() {
  return samplePlanInputs({
    pretaxStart: 10_000,
    taxableStart: 10_000,
    rothStart: 10_000,
    saleGainAge: 66,
    saleGainAmount: 20_000_000,
  });
}

const SOURCE_KEYS = [
  "ss", "rmd", "otherIncome", "taxExempt", "interestYield",
  "dividendYield", "pretaxDraw", "taxableSoldForSpending",
  "taxableSoldForTax", "cashSpend", "rothDraw", "hsaDraw",
  "salarySurplus",
] as const;

// The funding-row identity, in cents: sources + shortfall +
// unpaid == total need. Exact, every year — the row absorbs
// ≤10¢ of r2 dust onto the largest source by design.
function assertRowIdentity(inputs: any, strategy: any) {
  const rows = buildRothFunding(inputs, strategy);
  for (const row of rows) {
    const sources =
      row.ssCents + row.rmdCents + row.otherIncomeCents +
      row.taxExemptCents + row.interestYieldCents +
      row.dividendYieldCents + row.pretaxDrawCents +
      row.taxableSoldForSpendingCents + row.taxableSoldForTaxCents +
      row.cashSpendCents + row.rothDrawCents + row.hsaDrawCents +
      row.salarySurplusCents;
    expect(
      row.totalNeedCents - sources - row.spendShortfallCents - row.unpaidTaxCents,
    ).toBe(0);
  }
}

// The march's own funding identity (r2 fields): within the W2
// §8 rounding-dust bar, every year.
function assertMarchFundingIdentity(inputs: any, strategy: any, maxDust: number) {
  const march = simulateRothPlan(inputs, strategy);
  let max = 0;
  for (const y of march.years) {
    const f: any = y.funding;
    const needs = f.spending + f.federalTax + f.stateTax + f.irmaa + f.healthPremium;
    let sources = 0;
    for (const k of SOURCE_KEYS) sources += f[k];
    const resid = Math.abs(r2(needs - sources - f.spendShortfall - f.unpaidTax));
    max = Math.max(max, resid);
  }
  expect(max).toBeLessThanOrEqual(maxDust);
  return max;
}

// The HSA balance identity, to rounding dust: each year's end
// is the prior end less that year's HSA tax draw, grown 5%.
function assertHsaBalanceIdentity(inputs: any, strategy: any) {
  const march = simulateRothPlan(inputs, strategy);
  let prev = inputs.hsaStart ?? 75_000;
  // The march's first year is 2026; the year-start HSA is the
  // plan's hsaStart grown by the year's growth inside the
  // settlement, so the identity is checked year-over-year from
  // the first reported end.
  let max = 0;
  for (const y of march.years) {
    const f: any = y.funding;
    const expected = r2((prev - f.hsaDraw) * 1.05);
    max = Math.max(max, Math.abs(r2(y.hsaEnd - expected)));
    prev = y.hsaEnd;
  }
  expect(max).toBeLessThanOrEqual(0.01);
  return max;
}

describe("C9 Build 4 — W2-D1: HSA debited for tax in forced exhaustion (F2)", () => {
  test("2030: the whole HSA pays the bill, net of its own tax", () => {
    const inputs = f2Inputs();
    const res = simulateRothPlan(inputs, DO_NOTHING);
    const y30 = res.years.find((y) => y.year === 2030)!;
    const y29 = res.years.find((y) => y.year === 2029)!;
    // 2029 is untouched by the leg (the bill lands in 2030).
    expect(y29.hsaEnd).toBe(91162.97);
    expect(y29.funding.hsaDraw).toBe(0);
    // 2030: the leg distributes the entire HSA — every other
    // bucket is already empty by then.
    expect(y30.funding.hsaDraw).toBe(91162.97);
    expect(y30.funding.hsaDraw).toBe(y29.hsaEnd);
    expect(y30.hsaEnd).toBe(0);
    expect(y30.detail.hsaTaxDebit).toBe(91162.97);
    // The §223(f)(4) additional tax is exactly 20% of the
    // distribution at 62 — and the whole penalty is exactly
    // that (no other penalty fires in 2030).
    expect(y30.penalty).toBe(18232.59);
    expect(r2(0.2 * y30.funding.hsaDraw)).toBe(18232.59);
    expect(planNetCost(res, inputs).penalty).toBe(18232.59);
    // The federal bill is HIGHER than before the leg by the
    // income tax on the distribution ($33,730.30) — the
    // distribution is ordinary income, priced, not free.
    expect(y30.federalTax).toBe(5386149.65);
    // Unpaid tax falls by the bill portion the HSA covered:
    // $91,162.97 − $18,232.59 = $72,930.38 of bill, less the
    // $33,730.30 of income tax the distribution itself created
    // = $39,200.07 less unpaid than the pre-leg $611,944.97.
    expect(y30.unpaidTax).toBe(572744.9);
    expect(res.lifetimeUnpaidTax).toBe(572744.9);
    expect(res.endingAfterTaxWealth).toBe(-572744.9);
    expect(res.endingHsa).toBe(0);
    // The settlement converged with the HSA feedback closed.
    expect(y30.settlementConverged).toBe(true);
    expect(y30.settlementMismatchCents.hsa).toBe(0);
    expect(y30.settlementMismatchCents.gains).toBe(0);
    expect(y30.settlementMismatchCents.pretax).toBe(0);
    expect(y30.settlementMismatchCents.roth).toBe(0);
    // The funding row mirrors the draw and the detail.
    const row30 = buildRothFunding(inputs, DO_NOTHING).find((r) => r.year === 2030)!;
    expect(row30.hsaDrawCents).toBe(9116297);
    expect(row30.hsaTaxDebitCents).toBe(9116297);
    expect(row30.unpaidTaxCents).toBe(57274490);
    expect(row30.settlementConverged).toBe(true);
    expect(row30.settlementMismatchCents.hsa).toBe(0);
  });

  test("funding + balance identities close in F2", () => {
    const inputs = f2Inputs();
    assertRowIdentity(inputs, DO_NOTHING);
    // Measured max y.funding residual $0.01 — the scored
    // penalty is 20% of the distribution rounded to cents
    // while the distribution itself carries sub-cent growth
    // dust (W2 §8 dust, not a leak).
    expect(assertMarchFundingIdentity(inputs, DO_NOTHING, 0.03)).toBeLessThanOrEqual(0.01);
    expect(assertHsaBalanceIdentity(inputs, DO_NOTHING)).toBeLessThanOrEqual(0.01);
  });
});

describe("C9 Build 4 — W2-D1: partial HSA leg ($200K gain, $10K balances)", () => {
  test("the HSA pays the reprice delta only, and survives", () => {
    const inputs = partialInputs();
    const res = simulateRothPlan(inputs, DO_NOTHING);
    const y30 = res.years.find((y) => y.year === 2030)!;
    // The overflow is covered by Taxable alone; the reprice
    // delta ($1,823.26 of tax on the pre-tax draws' ordinary
    // income, displacing 0%-band gains) lands after the
    // spending draws have drained Pre-tax and Roth, so only
    // the HSA leg can pay it — and it covers it in full.
    expect(y30.unpaidTax).toBe(0);
    expect(y30.funding.hsaDraw).toBe(2279.07);
    expect(y30.detail.hsaTaxDebit).toBe(2279.07);
    expect(y30.hsaEnd).toBe(93328.09);
    expect(y30.hsaEnd).toBeGreaterThan(0);
    // The penalty is the §223(f)(4) 20% on the distribution.
    // It pins $455.82, 1¢ above 20% of the ROUNDED draw
    // ($455.81): the unrounded distribution is $2,279.075
    // (the $1,823.26 delta / 0.8), which rounds DOWN to
    // $2,279.07 as a draw while 20% of it rounds UP to
    // $455.82 as a penalty — a float-boundary artifact on
    // the same sub-cent figure, verified numerically, not a
    // logic error. The relation holds to the cent.
    expect(y30.penalty).toBe(455.82);
    expect(Math.abs(y30.penalty - 0.2 * y30.funding.hsaDraw)).toBeLessThanOrEqual(0.01);
    expect(y30.settlementConverged).toBe(true);
    expect(y30.settlementMismatchCents.hsa).toBe(0);
    const row30 = buildRothFunding(inputs, DO_NOTHING).find((r) => r.year === 2030)!;
    expect(row30.hsaDrawCents).toBe(227907);
    expect(row30.hsaTaxDebitCents).toBe(227907);
    expect(row30.unpaidTaxCents).toBe(0);
  });

  test("funding + balance identities close in the partial shape", () => {
    const inputs = partialInputs();
    assertRowIdentity(inputs, DO_NOTHING);
    // Measured max y.funding residual $0.02 (W2 §8 dust).
    expect(assertMarchFundingIdentity(inputs, DO_NOTHING, 0.03)).toBeLessThanOrEqual(0.02);
    expect(assertHsaBalanceIdentity(inputs, DO_NOTHING)).toBeLessThanOrEqual(0.01);
  });
});

describe("C9 Build 4 — W2-D1: no additional tax at 65+ ($20M gain at 66)", () => {
  test("the HSA leg pays the bill with zero §223(f)(4) tax", () => {
    const inputs = age65Inputs();
    const res = simulateRothPlan(inputs, DO_NOTHING);
    const y34 = res.years.find((y) => y.year === 2034)!;
    const y33 = res.years.find((y) => y.year === 2033)!;
    // Primary is 66 in 2034 — the age-65 exception applies.
    expect(y34.agePrimary).toBe(66);
    expect(y34.funding.hsaDraw).toBe(110809.16);
    expect(y34.funding.hsaDraw).toBe(y33.hsaEnd);
    expect(y34.hsaEnd).toBe(0);
    expect(y34.penalty).toBe(0);
    expect(y34.settlementConverged).toBe(true);
    expect(y34.settlementMismatchCents.hsa).toBe(0);
    // The HSA barely dents a $20M-gain bill against $10K
    // balances — most of it stays unpaid, honestly.
    expect(y34.unpaidTax).toBeGreaterThan(0);
    const row34 = buildRothFunding(inputs, DO_NOTHING).find((r) => r.year === 2034)!;
    expect(row34.hsaDrawCents).toBe(11080916);
    expect(row34.hsaTaxDebitCents).toBe(11080916);
  });
});

describe("C9 Build 4 — W2-D1: solvent plans never touch the HSA", () => {
  test("Do Nothing and Fill 12%: hsaDraw $0 every year, pins bit-identical", () => {
    for (const strategy of [DO_NOTHING, FILL_12]) {
      const inputs = samplePlanInputs();
      const res = simulateRothPlan(inputs, strategy);
      expect(res.lifetimeUnpaidTax).toBe(0);
      for (const y of res.years) {
        expect(y.funding.hsaDraw).toBe(0);
        expect(y.detail.hsaTaxDebit).toBe(0);
      }
      // The HSA only grows, untouched, for the whole march.
      expect(res.endingHsa).toBeGreaterThan(0);
      const rows = buildRothFunding(inputs, strategy);
      expect(rows.length).toBe(38);
      for (const row of rows) {
        expect(row.hsaDrawCents).toBe(0);
        expect(row.hsaTaxDebitCents).toBe(0);
      }
      assertRowIdentity(inputs, strategy);
      expect(assertMarchFundingIdentity(inputs, strategy, 0.03)).toBe(0);
      expect(assertHsaBalanceIdentity(inputs, strategy)).toBeLessThanOrEqual(0.01);
    }
    // The solvent pins are the gate's own — the leg must not
    // move a cent on a plan with no unpaid tax.
    const res = simulateRothPlan(samplePlanInputs(), DO_NOTHING);
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
