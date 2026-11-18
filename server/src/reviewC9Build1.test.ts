// Engine Review C9, Build 1 — Rule-of-55 eligibility + §72(t) penalty
// plumbing (W1-B1 spending-draw penalty, W1-B2 conversion-withholding
// top-up, W2-D3 compute/debit/score plumbing).
//
// Fixture: the C9 spec fixture on the FICTIONAL sample household
// (server/src/sampleHousehold.ts — every figure here is invented, none
// describes any real household): primary 55, MFJ, $2M taxable at 50%
// basis, $1.5M traditional, $500K Roth, $150K/yr spending (including
// healthcare, excluding income taxes), $48K SS at 67, through 95.
// The spec leaves several facts unspecified; what this file assumes,
// and why, is stated here once instead of invented silently:
//   - Spouse born 1973 (age 53): the sample household's own 2-year
//     age gap, kept so the fixture reads as the sample household
//     with the spec's balances.
//   - ACA household size 2 (MFJ couple): the spec names no size and
//     no kids; college is outside the portfolio, so no household
//     member is assumed for the cliff.
//   - Spouse SS $0 (unentered): the spec names only the primary's
//     $48K; no spouse benefit is invented.
//   - Pre-tax all primary's ($1.5M / $0) in scenarios 1–3 and 5:
//     the spec's "$1.5M traditional" carries no owner split; the
//     split is varied explicitly only in scenario 4.
//   - Eligibility allocation is the case's own variable, stated
//     per case — never a default split.
//   - Expected return 5%: the spec's "95% stocks" has no engine
//     input of its own — the engine prices the entered return
//     directly — so the fixture enters the sample household's 5%.
//   - Retirement age 55, window 55–59 (Do Nothing converts $0, so
//     the window binds nothing there; it binds the FILL22 cases).
//   - Spending is flat $150K/yr in the march (the engine does not
//     inflate the spending need), so every pre-59½ pre-tax spending
//     draw is $150,000 and the ineligible share prices 10% of it.
//
// Every penalty below is HAND arithmetic, stated in the case's own
// comment — never copied from engine output: a $150,000 draw prices
// $15,000 (10%), an eligible ledger grows 5%/yr with its pool and is
// consumed eligible-first, so the mixed cases' partial-year
// penalties are computed ledger-year by ledger-year in the notes.
// The W1-B2 pins are the same hand arithmetic: the top-up carries
// the conversion's share of the reprice-delta tax into withholding,
// so where the conversion channel bears the whole final federal bill
// the penalty is exactly final federal tax ÷ 9.

import { describe, expect, test } from "bun:test";
import { simulateRothPlan, type DrawOrder, type RothPlanInputs } from "./taxEngine";
import {
  buildRothFunding,
  planNetCost,
  runRothCompare,
} from "./rothOptimizer";
import { samplePlanInputs } from "./sampleHousehold";
import { sampleCompareBase } from "./hardening/sensCompareBase";

const DO_NOTHING = { id: "none", name: "Do Nothing", ceilings: null } as const;
const FILL22 = {
  id: "fill22",
  name: "Fill 22%",
  ceilings: {
    bracketTopPct: 22,
    irmaaTierCap: null,
    ltcgZeroCap: false,
    acaCliffCap: false,
    acaCliffCapFamilyOnly: false,
    magiCap: null,
    acaCliffBuffer: null,
  },
} as const;

// The C9 spec fixture (see the header note for the assumptions).
function fixture(overrides: Partial<RothPlanInputs> = {}): RothPlanInputs {
  return samplePlanInputs({
    birthYearPrimary: 1971, // 55 in 2026
    birthYearSpouse: 1973, // 53 in 2026
    endAgePrimary: 95,
    pretaxStart: 1_500_000,
    pretaxSpouseStart: 0,
    rothStart: 500_000,
    taxableStart: 2_000_000,
    taxableBasisPct: 50,
    annualSpending: 150_000,
    retirementAge: 55,
    expectedReturnPct: 5,
    ssPrimaryAnnual: 48_000,
    ssPrimaryStartAge: 67,
    ssSpouseAnnual: 0,
    ssSpouseStartAge: 67,
    drawOrder: ["pretax", "taxable", "roth"],
    payTaxFrom: "taxable",
    windowStartAge: 55,
    windowStopAge: 59,
    ...overrides,
  });
}

const yearOf = (res: ReturnType<typeof simulateRothPlan>, year: number) =>
  res.years.find((y) => y.year === year)!;

describe("C9 Build 1 — Rule-of-55 eligibility + §72(t) penalty", () => {
  test("scenario 1: age 55, sufficient Rule-of-55-eligible 401(k) — no penalty", () => {
    // The whole $1.5M is eligible and the separation (55) qualifies,
    // so every $150,000 draw shelters in full: 10% × $0 = $0.
    const res = simulateRothPlan(
      fixture({ pretax401kEligiblePrimary: 1_500_000, separationAgePrimary: 55 }),
      DO_NOTHING as never,
    );
    for (const year of [2026, 2027, 2028, 2029, 2030]) {
      const y = yearOf(res, year);
      expect(y.detail.pretaxSpendingDraw).toBe(150_000);
      expect(y.penalty).toBe(0);
      expect(y.earlyWithdrawalEligibilityUnknown).toBe(false);
    }
    expect(res.lifetimePenalty).toBe(0);
    expect(res.earlyWithdrawalUnknownYears).toEqual([]);
  });

  test("scenario 2: age 55, identical balance in ineligible IRA — correct penalty", () => {
    // Eligible 0 is a REAL answer (not "unanswered"): every $150,000
    // draw is fully ineligible at 55–59, so 10% × $150,000 = $15,000
    // a year for five years, $75,000 lifetime. At 60 (2031) the age
    // test stops and the same draw prices $0.
    const res = simulateRothPlan(
      fixture({ pretax401kEligiblePrimary: 0, separationAgePrimary: 55 }),
      DO_NOTHING as never,
    );
    for (const year of [2026, 2027, 2028, 2029, 2030]) {
      const y = yearOf(res, year);
      expect(y.detail.pretaxSpendingDraw).toBe(150_000);
      expect(y.penalty).toBe(15_000);
      expect(y.earlyWithdrawalEligibilityUnknown).toBe(false);
    }
    expect(yearOf(res, 2031).penalty).toBe(0);
    expect(res.lifetimePenalty).toBe(75_000);
    expect(res.earlyWithdrawalUnknownYears).toEqual([]);
  });

  test("unanswered eligibility: the bit-identical default — $0 penalty, flagged unknown", () => {
    // No eligibility fields at all: the plan prices exactly as
    // before the build ($0 penalty — the landing default), and the
    // disclosure flag says the $0 is unknown, not computed, in
    // every pre-59½ pre-tax draw year (2026–2030) and nowhere else.
    const res = simulateRothPlan(fixture(), DO_NOTHING as never);
    for (const year of [2026, 2027, 2028, 2029, 2030]) {
      const y = yearOf(res, year);
      expect(y.detail.pretaxSpendingDraw).toBe(150_000);
      expect(y.penalty).toBe(0);
      expect(y.earlyWithdrawalEligibilityUnknown).toBe(true);
    }
    expect(yearOf(res, 2031).earlyWithdrawalEligibilityUnknown).toBe(false);
    expect(res.lifetimePenalty).toBe(0);
    expect(res.earlyWithdrawalUnknownYears).toEqual([2026, 2027, 2028, 2029, 2030]);
  });

  test("scenario 3: mixed eligible 401(k) + IRA, eligible exhausted partway", () => {
    // Eligible $300,000, consumed eligible-first, growing 5%/yr
    // with its pool: 2026 $300,000 → draw $150,000 → $150,000 × 1.05
    // = $157,500; 2027 → draw $150,000 → $7,500 × 1.05 = $7,875;
    // 2028 the draw shelters only $7,875, so the ineligible share
    // is $142,125 and the penalty is 10% × $142,125 = $14,212.50.
    // 2029–2030 the ledger is empty: 10% × $150,000 = $15,000.
    // Lifetime: $14,212.50 + $15,000 + $15,000 = $44,212.50.
    const res = simulateRothPlan(
      fixture({ pretax401kEligiblePrimary: 300_000, separationAgePrimary: 55 }),
      DO_NOTHING as never,
    );
    expect(yearOf(res, 2026).penalty).toBe(0);
    expect(yearOf(res, 2027).penalty).toBe(0);
    expect(yearOf(res, 2028).penalty).toBe(14_212.5);
    expect(yearOf(res, 2029).penalty).toBe(15_000);
    expect(yearOf(res, 2030).penalty).toBe(15_000);
    expect(res.lifetimePenalty).toBe(44_212.5);
    expect(res.earlyWithdrawalUnknownYears).toEqual([]);
  });

  test("scenario 4: married, eligible primary + ineligible younger spouse", () => {
    // Primary $400,000, all eligible; spouse $1,050,000, none
    // eligible. Primary-first sourcing, each owner's share tested
    // on their OWN age. Primary pool: $400,000 → $250,000 → ×1.05
    // $262,500 → $112,500 → ×1.05 $118,125; so 2026–2027 draw
    // entirely from the primary ($0 penalty), 2028 draws $118,125
    // from the primary and $31,875 from the spouse (age 55), whose
    // ineligible share prices 10% × $31,875 = $3,187.50. 2029–2030
    // draw entirely from the spouse: $15,000 a year. 2031 the
    // primary is 60 but the spouse is 58, so her $150,000 draw
    // still prices $15,000 — the spouse is never tested on the
    // primary's age. Lifetime: $3,187.50 + $15,000 × 4 = $63,187.50.
    const res = simulateRothPlan(
      fixture({
        pretaxStart: 400_000,
        pretaxSpouseStart: 1_050_000,
        pretax401kEligiblePrimary: 400_000,
        pretax401kEligibleSpouse: 0,
        separationAgePrimary: 55,
        separationAgeSpouse: 55,
      }),
      DO_NOTHING as never,
    );
    expect(yearOf(res, 2026).penalty).toBe(0);
    expect(yearOf(res, 2027).penalty).toBe(0);
    expect(yearOf(res, 2028).penalty).toBe(3_187.5);
    expect(yearOf(res, 2029).penalty).toBe(15_000);
    expect(yearOf(res, 2030).penalty).toBe(15_000);
    expect(yearOf(res, 2031).penalty).toBe(15_000);
    expect(res.lifetimePenalty).toBe(63_187.5);
    expect(res.earlyWithdrawalUnknownYears).toEqual([]);
  });

  test("scenario 5: ages 59/60 transition — the penalty stops at 60", () => {
    // Same all-ineligible plan as scenario 2: the age-59 year
    // (2030) still prices 10% × $150,000 = $15,000, and the
    // age-60 year (2031) prices $0 on the identical draw — the
    // whole-year age test penalizes the whole age-59 year and
    // stops at 60 (birth years are the only age input, so there
    // is no half-year precision).
    const res = simulateRothPlan(
      fixture({ pretax401kEligiblePrimary: 0, separationAgePrimary: 55 }),
      DO_NOTHING as never,
    );
    expect(yearOf(res, 2030).agePrimary).toBe(59);
    expect(yearOf(res, 2030).penalty).toBe(15_000);
    expect(yearOf(res, 2031).agePrimary).toBe(60);
    expect(yearOf(res, 2031).penalty).toBe(0);
  });

  test("separation age gates the shelter: under 55 never, 55+ only from that age on", () => {
    // Separated at 54: the separation does not qualify under the
    // rule, so the full $1.5M "eligible" balance shelters nothing
    // — $15,000 a year at 55–59, exactly the all-ineligible case.
    const sep54 = simulateRothPlan(
      fixture({ pretax401kEligiblePrimary: 1_500_000, separationAgePrimary: 54 }),
      DO_NOTHING as never,
    );
    expect(yearOf(sep54, 2026).penalty).toBe(15_000);
    expect(sep54.lifetimePenalty).toBe(75_000);
    // Separated at 57: the 55 and 56 draws precede the separation
    // and price $15,000 each; from 57 on the balance shelters in
    // full — $30,000 lifetime.
    const sep57 = simulateRothPlan(
      fixture({ pretax401kEligiblePrimary: 1_500_000, separationAgePrimary: 57 }),
      DO_NOTHING as never,
    );
    expect(yearOf(sep57, 2026).penalty).toBe(15_000);
    expect(yearOf(sep57, 2027).penalty).toBe(15_000);
    expect(yearOf(sep57, 2028).penalty).toBe(0);
    expect(sep57.lifetimePenalty).toBe(30_000);
  });

  test("W1-B2: conversion-withholding penalty no longer vanishes when pre-tax draws fill the bracket", () => {
    // The audit's case-4 shape, exactly: sample household,
    // pretax-first draws, FILL22 in window 55–59, tax paid from
    // the conversion, 2026 (age 58). Before the fix the penalty
    // was $0 — the round's opening ordinary income ($31,000:
    // conversion + $5,000 nonqualified dividends + $1,500
    // interest) sat under the $32,200 standard deduction, so
    // opening withheld was $0 and the $32,989.36 bill arrived
    // only as a reprice delta paid from Taxable. After the fix
    // the conversion's share of the delta tax is carried into
    // withholding: the conversion bears the whole final federal
    // bill, so the penalty is final federal tax ÷ 9 —
    // $34,882 ÷ 9 = $3,875.78 — and the conversion itself is
    // $42,100 (the ceiling loop re-solves against the smaller
    // Taxable sale the top-up leaves behind, so fewer gains
    // feed back and more conversion fits under the 22% top).
    const inputs = samplePlanInputs({
      retirementAge: 55,
      windowStartAge: 55,
      windowStopAge: 59,
      drawOrder: ["pretax", "taxable", "roth"],
      payTaxFrom: "conversion",
      pretaxStart: 1_000_000,
      pretaxSpouseStart: 500_000,
    });
    const res = simulateRothPlan(inputs, FILL22 as never);
    const y26 = yearOf(res, 2026);
    expect(y26.conversion).toBe(42_100);
    expect(y26.federalTax).toBe(34_882);
    expect(y26.penalty).toBe(3_875.78);
    // The same plan with the tax paid from Taxable instead: the
    // reprice delta was never a pre-tax distribution, so no
    // top-up runs and the conversion leg prices $0 penalty.
    const taxable = simulateRothPlan(
      samplePlanInputs({
        retirementAge: 55,
        windowStartAge: 55,
        windowStopAge: 59,
        drawOrder: ["pretax", "taxable", "roth"],
        payTaxFrom: "taxable",
        pretaxStart: 1_000_000,
        pretaxSpouseStart: 500_000,
      }),
      FILL22 as never,
    );
    expect(yearOf(taxable, 2026).penalty).toBe(0);
  });

  test("W1-B2 control: the opening-withholding penalty grows by the delta's share too", () => {
    // The audit's positive control, default draw order: the
    // opening withholding already penalized before the fix
    // ($2,055.78 in 2026). After the fix the delta's share joins
    // it, so the penalty is again the final federal tax ÷ 9 to
    // within a cent of rounding: 2026 $29,842 ÷ 9 = $3,315.78;
    // 2027 $29,661.91 ÷ 9 = $3,295.77, which the engine now prices
    // exactly (the C2 integer-cents walk prices the tie at its exact
    // half-up value, so the opening and top-up gross-ups agree);
    // lifetime $6,611.55.
    const res = simulateRothPlan(
      samplePlanInputs({
        retirementAge: 55,
        windowStartAge: 55,
        windowStopAge: 59,
        payTaxFrom: "conversion",
      }),
      FILL22 as never,
    );
    expect(yearOf(res, 2026).conversion).toBe(150_100);
    expect(yearOf(res, 2026).federalTax).toBe(29_842);
    expect(yearOf(res, 2026).penalty).toBe(3_315.78);
    expect(yearOf(res, 2027).conversion).toBe(147_900);
    // C2 re-pin (2026-11-18): the conditional integer-cents bracket
    // walk prices the 2027 exact half-up tie a cent higher
    // (29_661.90 -> 29_661.91); the penalty follows the tax (see below).
    expect(yearOf(res, 2027).federalTax).toBe(29_661.91);
    // C2 re-pin: 29_661.91 / 9 = 3_295.77 — the engine now prices the
    // penalty the header comment always said it should be.
    expect(yearOf(res, 2027).penalty).toBe(3_295.77);
    // C2 re-pin: lifetime 3_315.78 + 3_295.77 = 6_611.55.
    expect(res.lifetimePenalty).toBe(6_611.55);
  });

  test("W2-D3: the spending-draw penalty is funded and scored, not just priced", () => {
    // Scenario 2's 2026: federal $21,778.38 + penalty $15,000.
    // The funding row's federal need carries both (the penalty is
    // paid from Taxable, then down the debit chain, like the
    // reprice delta), the year funds in full (no shortfall, no
    // unpaid tax), and the plan score carries the $75,000 lifetime
    // penalty in its net cost.
    const inputs = fixture({ pretax401kEligiblePrimary: 0, separationAgePrimary: 55 });
    const funding = buildRothFunding(inputs, DO_NOTHING as never);
    const f26 = funding.find((r) => r.year === 2026)!;
    expect(f26.federalTaxCents).toBe(3_677_838);
    expect(f26.spendShortfallCents).toBe(0);
    expect(f26.unpaidTaxCents).toBe(0);
    const res = simulateRothPlan(inputs, DO_NOTHING as never);
    const cost = planNetCost(res, inputs);
    expect(cost.penalty).toBe(75_000);
  });

  test("disclosure flags flow through runRothCompare and buildRothFunding", () => {
    // The compare base is the sample-household shape with the
    // fixture's ages and balances; the scenario overrides the
    // draw order to pretax-first so the pre-59½ pre-tax draws
    // actually happen in the compare march.
    const base = {
      ...sampleCompareBase,
      birthYearPrimary: 1971,
      birthYearSpouse: 1973,
      pretaxCents: 150_000_000,
      pretaxSpouseCents: 0,
      rothCents: 50_000_000,
      taxableCents: 200_000_000,
      annualSpendingCents: 15_000_000,
      retirementAge: 55,
    };
    const unanswered = runRothCompare(
      base as never,
      [{ name: "Do Nothing", overrides: { drawOrder: "pretax-taxable-roth" } }],
      2026,
      null,
    );
    const s0 = unanswered.scenarios[0]!;
    expect(s0.earlyWithdrawalUnknownYears).toEqual([2026, 2027, 2028, 2029, 2030]);
    expect(
      s0.years.filter((y) => y.year <= 2030).map((y) => y.earlyWithdrawalEligibilityUnknown),
    ).toEqual([true, true, true, true, true]);
    expect(s0.penaltyCents).toBe(0);
    const answered = runRothCompare(
      { ...base, pretax401kEligiblePrimaryCents: 0, separationAgePrimary: 55 } as never,
      [{ name: "Do Nothing", overrides: { drawOrder: "pretax-taxable-roth" } }],
      2026,
      null,
    );
    const s1 = answered.scenarios[0]!;
    expect(s1.earlyWithdrawalUnknownYears).toEqual([]);
    expect(s1.penaltyCents).toBe(7_500_000);
    const funding = buildRothFunding(fixture(), DO_NOTHING as never);
    expect(
      funding.filter((r) => r.year <= 2030).map((r) => r.earlyWithdrawalEligibilityUnknown),
    ).toEqual([true, true, true, true, true]);
  });

  test("six-order rankings before vs after: the penalty narrows pretax-first but does not flip the ranking", () => {
    // All six draw orders on identical opening balances, priced
    // twice: eligibility unanswered (the before leg — the
    // bit-identical default, $0 penalty everywhere) and
    // eligibility answered all-ineligible (the after leg). The
    // ranking by net cost is the same in both legs; the penalty
    // raises the pre-tax-led orders' net cost (pretax-first by
    // $58,671.19 — less than the $75,000 lifetime penalty, because
    // the funded penalty moves balances, ending wealth, and the
    // terminal tax with it) and leaves the taxable-led orders
    // untouched (their pre-tax draws start only after Taxable is
    // exhausted, past 59½).
    const orders: [string, DrawOrder][] = [
      ["taxable-first", ["taxable", "pretax", "roth"]],
      ["pretax-first", ["pretax", "taxable", "roth"]],
      ["roth-first", ["roth", "taxable", "pretax"]],
      ["taxable-roth-pretax", ["taxable", "roth", "pretax"]],
      ["pretax-roth-taxable", ["pretax", "roth", "taxable"]],
      ["roth-pretax-taxable", ["roth", "pretax", "taxable"]],
    ];
    const price = (elig: Partial<RothPlanInputs>) => {
      const out: Record<string, { netCost: number; penalty: number }> = {};
      for (const [name, order] of orders) {
        const inputs = fixture({ ...elig, drawOrder: order });
        const res = simulateRothPlan(inputs, DO_NOTHING as never);
        out[name] = { netCost: planNetCost(res, inputs).netCost, penalty: res.lifetimePenalty };
      }
      return out;
    };
    const before = price({});
    const after = price({ pretax401kEligiblePrimary: 0, separationAgePrimary: 55 });
    const rank = (leg: Record<string, { netCost: number }>) =>
      Object.entries(leg)
        .sort((a, b) => a[1].netCost - b[1].netCost)
        .map(([name]) => name);
    expect(rank(before)).toEqual([
      "pretax-first",
      "pretax-roth-taxable",
      "roth-pretax-taxable",
      "taxable-first",
      "taxable-roth-pretax",
      "roth-first",
    ]);
    expect(rank(after)).toEqual(rank(before));
    // C2 re-pin (2026-11-18): the conditional integer-cents bracket
    // walk moves the pretax-first net cost 545_859.34 -> 545_859.36
    // (+2c, two tie cents cascading); the ranking is unchanged.
    // C2 round 2 re-pin: the preferential staircase moves it a
    // further +4c to 545_859.40.
    expect(before["pretax-first"]!.netCost).toBe(545_859.4);
    // C2 re-pin (2026-11-18): same walk move on the after leg,
    // 604_530.53 -> 604_530.58 (+5c).
    expect(after["pretax-first"]!.netCost).toBe(604_530.58);
    expect(after["pretax-first"]!.penalty).toBe(75_000);
    // C2 re-pin (2026-11-18): same walk move, 675_272.86 -> 675_272.90 (+4c).
    // C2 round 2 re-pin: the preferential staircase moves it −1c
    // to 675_272.89.
    expect(after["pretax-roth-taxable"]!.netCost).toBe(675_272.89);
    expect(after["roth-pretax-taxable"]!.penalty).toBe(21_770.63);
    expect(after["taxable-first"]!.netCost).toBe(before["taxable-first"]!.netCost);
    // C2 round 2 re-pin: the preferential staircase moves the
    // taxable-first net cost +4c to 1_468_062.66 (both legs move
    // together — the equality above still holds).
    expect(after["taxable-first"]!.netCost).toBe(1_468_062.66);
    // C2 re-pin (2026-11-18): same walk move, 1_677_058.52 -> 1_677_058.51 (-1c).
    // C2 round 2 re-pin: the preferential staircase moves it +1c
    // back to 1_677_058.52, its pre-walk value.
    expect(after["roth-first"]!.netCost).toBe(1_677_058.52);
  });
});
