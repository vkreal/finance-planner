// Engine Review C9, Build 2, Fix 3 — the top-up residual step
// consumes ledger composition (Pass 4 SHOULD-1).
//
// THE DEFECT (Pass 4, demonstrated by execution): in
// settleRound's top-up shrink, the lot step shrank the appended
// IRA lots and reduced the ledger balance together, but when
// the lots could not cover the top-up, the residual step
// reduced `sRothLedP.ira.balance` / `sRothLedS.ira.balance` —
// touching `.balance` ONLY, never contributions or lots. The
// top-up cap is on TOTAL Roth balance while the lot step covers
// only IRA lots, so a cross-ledger residual bite is reachable
// whenever the spending draw has already consumed most of the
// new lot — and the bite left a $0 balance with standing
// contributions (a phantom basis that later sheltered draws
// and shifted the next year's conversion and the five-year
// clock).
//
// THE FIX (taxEngine.ts, all in the Roth-ledger helpers +
// settleRound): the residual step consumes composition via
// shrinkRothAccountLedgerBalance — contributions first, then
// conversion lots FIFO (taxable portion first within a lot),
// then earnings (the residual, implicit) — mirroring
// debitRothAccountLedger's order, pricing nothing (the
// top-up's penalty was already priced once by the gross-up).
// The invariant balance $0 ⟹ contributions $0 is restored on
// every balance-reducing path, not just the residual: debits
// consume contributions first AND clearEmptyRothAccountLedger
// zeroes any composition left standing when a debit exhausts
// the balance (the post-decline case, where a negative-return
// year shrank the balance below the standing basis); the
// residual shrink consumes composition first AND calls
// clearEmptyRothAccountLedger when the balance reaches $0
// (Fix 4 — the take alone cannot clear a post-decline ledger
// whose balance sits below its standing basis); year-end
// growth clears composition when a return zeroes a balance
// (−100% prices a wipeout; the schema allows −100 at the save
// boundary). The merge comment states the mechanism now — the
// old premise ("its residual step is unreachable inside one
// settleRound") was FALSE and is gone from taxEngine.ts.
//
// NOTE ON THE PROBE A FIGURES: the march's year rows do NOT
// expose ledger composition (no ledger field on the year row),
// so the invariant itself is asserted DIRECTLY at the unit
// level below, where the ledger state is observable. At the
// march level Probe A pins that the fix is composition-only:
// the S IRA is still bitten ($4,000 gone) and rothEnd stays
// $24,746.40 — the fix clears the S IRA's contributions, it
// does NOT un-bite the ledger. The reviewer's $28,946.40 is
// the counterfactual with NO bite at all (S IRA intact), which
// is not what the consumption fix produces and is therefore
// NOT asserted here; the bitten-but-correct $24,746.40 is.
// The B4 differencing test IS the march-level invariant
// proof: with the fix, the all-contributions variant produces
// the all-earnings control's figures exactly.
//
// Fixture: the C9 spec fixture on the FICTIONAL sample
// household (server/src/sampleHousehold.ts — every figure
// here is invented, none describes any real household),
// shaped exactly as the Pass 4 reviewer's probes.

import { describe, expect, test } from "bun:test";
import {
  clearEmptyRothAccountLedger,
  debitRothOwnerLedger,
  initRothAccountLedger,
  shrinkRothAccountLedgerBalance,
  simulateRothPlan,
  type DrawOrder,
  type RothAccountLedger,
  type RothOwnerLedger,
  type RothPlanInputs,
} from "./taxEngine";
import { samplePlanInputs } from "./sampleHousehold";

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

const yearOf = (res: ReturnType<typeof simulateRothPlan>, year: number) =>
  res.years.find((y) => y.year === year)!;

describe("shrinkRothAccountLedgerBalance consumes composition", () => {
  test("Probe A shape: $4,000 IRA ($3,000 contributions) shrunk $4,166.67 ends $0/$0", () => {
    const led = initRothAccountLedger(4_000, 3_000, [], 2020);
    expect(led.known).toBe(true);
    const left = shrinkRothAccountLedgerBalance(led, 4_166.67);
    expect(left).toBeCloseTo(166.67, 2);
    expect(led.balance).toBe(0);
    // THE invariant: balance $0 ⟹ contributions $0.
    expect(led.contributions).toBe(0);
    expect(led.lots).toEqual([]);
  });

  test("contributions first, then lots FIFO, then earnings (implicit)", () => {
    const led = initRothAccountLedger(
      10_000,
      2_000,
      [
        { year: 2024, taxableAmount: 5_000, nontaxableAmount: 0 },
        { year: 2025, taxableAmount: 2_000, nontaxableAmount: 0 },
      ],
      2020,
    );
    const left = shrinkRothAccountLedgerBalance(led, 9_000);
    expect(left).toBe(0);
    expect(led.balance).toBe(1_000);
    expect(led.contributions).toBe(0);
    expect(led.lots).toEqual([]);
    // The $1,000 left is the earnings residual (balance −
    // contributions − lots), untouched by the shrink.
    expect(led.balance - led.contributions).toBe(1_000);
  });

  test("within a lot the taxable portion goes first", () => {
    const led = initRothAccountLedger(
      5_000,
      0,
      [{ year: 2024, taxableAmount: 3_000, nontaxableAmount: 2_000 }],
      2020,
    );
    const left = shrinkRothAccountLedgerBalance(led, 4_000);
    expect(left).toBe(0);
    expect(led.balance).toBe(1_000);
    expect(led.contributions).toBe(0);
    expect(led.lots).toEqual([
      { year: 2024, taxable: 0, nontaxable: 1_000 },
    ]);
  });

  test("B4 shape: $2,500 all-contributions shrunk $2,500 ends $0/$0, nothing left", () => {
    const led = initRothAccountLedger(2_500, 2_500, [], 2020);
    const left = shrinkRothAccountLedgerBalance(led, 2_500);
    expect(left).toBe(0);
    expect(led.balance).toBe(0);
    expect(led.contributions).toBe(0);
    expect(led.lots).toEqual([]);
  });

  test("unknown ledger: contributions are consumed too (the dollars are gone)", () => {
    const led = initRothAccountLedger(4_000, 3_000, null, 2020);
    expect(led.known).toBe(false);
    const left = shrinkRothAccountLedgerBalance(led, 4_000);
    expect(left).toBe(0);
    expect(led.balance).toBe(0);
    expect(led.contributions).toBe(0);
  });

  test("zero / negative shrink changes nothing and returns the request", () => {
    const led = initRothAccountLedger(4_000, 3_000, [], 2020);
    expect(shrinkRothAccountLedgerBalance(led, 0)).toBe(0);
    expect(shrinkRothAccountLedgerBalance(led, -100)).toBe(0);
    expect(led.balance).toBe(4_000);
    expect(led.contributions).toBe(3_000);
  });
});

describe("clearEmptyRothAccountLedger backstop", () => {
  test("known $0 ledger: contributions AND lots cleared", () => {
    const led: RothAccountLedger = {
      balance: 0,
      contributions: 3_000,
      lots: [{ year: 2024, taxable: 1_000, nontaxable: 0 }],
      firstYear: 2020,
      known: true,
    };
    clearEmptyRothAccountLedger(led);
    expect(led.contributions).toBe(0);
    expect(led.lots).toEqual([]);
  });

  test("unknown $0 ledger: contributions cleared, lots stay (Fix 1 design)", () => {
    const led: RothAccountLedger = {
      balance: 0,
      contributions: 3_000,
      lots: [{ year: 2024, taxable: 1_000, nontaxable: 0 }],
      firstYear: 2020,
      known: false,
    };
    clearEmptyRothAccountLedger(led);
    expect(led.contributions).toBe(0);
    expect(led.lots).toEqual([
      { year: 2024, taxable: 1_000, nontaxable: 0 },
    ]);
  });

  test("positive balance: no-op", () => {
    const led: RothAccountLedger = {
      balance: 100,
      contributions: 50,
      lots: [],
      firstYear: 2020,
      known: true,
    };
    clearEmptyRothAccountLedger(led);
    expect(led.contributions).toBe(50);
    expect(led.balance).toBe(100);
  });

  test("debit backstop: post-decline full draw (balance below basis) leaves nothing standing", () => {
    // The post-decline state: a negative-return year shrank
    // the balance to $60,000 while the $90,000 basis stood
    // (basis deliberately survives declines). A $60,000 draw
    // consumes $60,000 of contributions — and the $30,000 of
    // basis left over plus the $5,000 lot must NOT survive
    // against a $0 balance: the dollars are gone.
    const owner: RothOwnerLedger = {
      ira: {
        balance: 60_000,
        contributions: 90_000,
        lots: [{ year: 2024, taxable: 5_000, nontaxable: 0 }],
        firstYear: 2020,
        known: true,
      },
      employer: {
        balance: 0,
        contributions: 0,
        lots: [],
        firstYear: null,
        known: true,
      },
    };
    const out = debitRothOwnerLedger(owner, 60_000, {
      year: 2026,
      age: 56,
    });
    expect(out.drawn).toBe(60_000);
    expect(out.income).toBe(0);
    expect(out.penalty).toBe(0);
    expect(out.unknown).toBe(false);
    expect(owner.ira.balance).toBe(0);
    expect(owner.ira.contributions).toBe(0);
    expect(owner.ira.lots).toEqual([]);
  });
});

// --- March level: Probe A (Pass 4 pass4-residual.test.ts shape) ---
// MUST1 base + P employer $100,000 (all contributions) + S IRA
// $4,000 ($3,000 contributions). The top-up fires ($4,166.67)
// with the appended lot already spent, so the residual bites
// the S IRA. Pre-fix the S IRA ended at $0 with its $3,000
// contributions standing; post-fix the bite consumes them.
// Priced figures are UNCHANGED by the fix (composition-only):
// 2026 penalty $20,416.67 (= MUST1 $20,000 + $416.67 top-up
// penalty), rothEnd $24,746.40 (bitten — the $4,000 S IRA is
// gone, grown $4,200 less than the $28,946.40 unbitten
// counterfactual).
function probeAInputs(overrides: Partial<RothPlanInputs> = {}): RothPlanInputs {
  return samplePlanInputs({
    birthYearPrimary: 1971,
    birthYearSpouse: 1973,
    endAgePrimary: 95,
    pretaxStart: 200_000,
    pretaxSpouseStart: 0,
    rothStart: 104_000,
    rothEmployerStart: 100_000,
    firstDesignatedRothYearPrimary: 2020,
    rothIraStartSpouse: 4_000,
    rothContributionBasisPrimary: 100_000,
    rothConversionLotsPrimary: [],
    firstRothYearPrimary: 2020,
    rothContributionBasisSpouse: 3_000,
    rothConversionLotsSpouse: [],
    firstRothYearSpouse: 2020,
    taxableStart: 50_000,
    taxableBasisPct: 50,
    hsaStart: 0,
    annualSpending: 280_000,
    retirementAge: 55,
    expectedReturnPct: 5,
    ssPrimaryAnnual: 0,
    ssPrimaryStartAge: 67,
    ssSpouseAnnual: 0,
    ssSpouseStartAge: 67,
    drawOrder: ["pretax", "taxable", "roth"],
    payTaxFrom: "conversion",
    windowStartAge: 55,
    windowStopAge: 59,
    ...overrides,
  });
}

describe("march Probe A: the bite is composition-only (no priced figure moves)", () => {
  test("2026: top-up penalty priced, Roth bitten exactly as before the fix", () => {
    const res = simulateRothPlan(probeAInputs(), FILL22 as never);
    const y26 = yearOf(res, 2026);
    expect(y26.conversion).toBe(200_000);
    expect(y26.federalTax).toBe(30_182);
    expect(y26.penalty).toBe(20_416.67);
    expect(y26.unpaidTax).toBe(0);
    expect(y26.spendShortfall).toBe(0);
    expect(y26.rothBasisUnknown).toBe(false);
    expect(y26.rothEarningsIncome).toBe(0);
    expect(y26.rothEnd).toBe(24_746.4);
    expect(y26.funding.rothDraw).toBe(247_063.11);
    expect(y26.funding.pretaxDraw).toBeCloseTo(33_535.56, 2);
    expect(y26.funding.taxableSoldForTax).toBe(0);
  });

  test("2027 follow-through: employer earnings price, Roth stays $0", () => {
    const res = simulateRothPlan(probeAInputs(), FILL22 as never);
    const y27 = yearOf(res, 2027);
    expect(y27.conversion).toBe(0);
    expect(y27.rothEarningsIncome).toBe(1_178.4);
    expect(y27.penalty).toBe(117.84);
    expect(y27.unpaidTax).toBe(117.84);
    expect(y27.spendShortfall).toBe(255_253.6);
    expect(y27.rothBasisUnknown).toBe(false);
    expect(y27.rothEnd).toBe(0);
  });
});

// --- March level: Probe B4 (Pass 4 pass4-residual-b.test.ts shape) ---
// P employer Roth $100,000 (all contributions, first year
// 2020) + S IRA $2,500 (first year 2020, known); taxable
// $30,000 at 50% basis sold for spending in 2026 → $15,000
// gains → delta $2,250 → top-up $2,500 exactly. The 2026 Roth
// draw ($220,000) consumes the 2026 conversion lot + part of
// the P employer leg; the top-up's lot step finds $0, so the
// residual zeroes the S IRA. In the B4 run the S IRA is all
// CONTRIBUTIONS ($2,500): pre-fix the residual touched
// `.balance` only, so the $2,500 stood as a phantom and the
// solver converted $2,500.14 more in 2027. In the control run
// the S IRA is all EARNINGS (contributions $0). With the fix
// the B4 run produces the CONTROL's figures in every year.
function b4Inputs(spouseContributions: number): RothPlanInputs {
  return samplePlanInputs({
    birthYearPrimary: 1971, birthYearSpouse: 1973, endAgePrimary: 95,
    pretaxStart: 250_000, pretaxSpouseStart: 300_000,
    rothStart: 102_500, rothEmployerStart: 100_000,
    firstDesignatedRothYearPrimary: 2020,
    rothIraStartSpouse: 2_500,
    rothContributionBasisPrimary: 100_000,
    rothConversionLotsPrimary: [],
    firstRothYearPrimary: 2020,
    rothContributionBasisSpouse: spouseContributions,
    rothConversionLotsSpouse: [],
    firstRothYearSpouse: 2020,
    taxableStart: 30_000, taxableBasisPct: 50, hsaStart: 0,
    annualSpending: 250_000, retirementAge: 55, expectedReturnPct: 5,
    ssPrimaryAnnual: 0, ssPrimaryStartAge: 67,
    ssSpouseAnnual: 0, ssSpouseStartAge: 67,
    drawOrder: ["taxable", "roth", "pretax"] as DrawOrder,
    payTaxFrom: "conversion", windowStartAge: 55, windowStopAge: 59,
  });
}

describe("march Probe B4: the phantom is gone (all-contributions == all-earnings control)", () => {
  const b4 = simulateRothPlan(b4Inputs(2_500), FILL22 as never);
  const ctl = simulateRothPlan(b4Inputs(0), FILL22 as never);

  test("2026: both runs bit-identical (bite year)", () => {
    const a = yearOf(b4, 2026), c = yearOf(ctl, 2026);
    expect(a.conversion).toBe(208_400);
    expect(a.conversion).toBe(c.conversion);
    expect(a.penalty).toBe(21_090);
    expect(a.penalty).toBe(c.penalty);
    expect(a.federalTax).toBe(c.federalTax);
    expect(a.rothEnd).toBe(55_434.53);
    expect(a.rothEnd).toBe(c.rothEnd);
    expect(a.pretaxEnd).toBe(c.pretaxEnd);
    expect((a.detail as any).drawGains).toBe(15_000);
    expect(a.rothBasisUnknown).toBe(false);
    expect(a.fiveYearClockYear).toBe(2031);
    expect(a.fiveYearClockYear).toBe(c.fiveYearClockYear);
    expect(a.funding.rothDraw).toBe(220_000);
    expect(a.funding.rothDraw).toBe(c.funding.rothDraw);
    expect(a.unpaidTax).toBe(0);
    expect(a.spendShortfall).toBe(0);
  });

  test("2027: conversion is the control's $101,988.10 (not the phantom $104,488.24)", () => {
    const a = yearOf(b4, 2027), c = yearOf(ctl, 2027);
    expect(c.conversion).toBe(101_988.1);
    expect(a.conversion).toBe(101_988.1);
    expect(a.conversion).toBe(c.conversion);
    expect(a.penalty).toBe(c.penalty);
    expect(a.federalTax).toBe(c.federalTax);
    expect(a.rothEarningsIncome).toBe(c.rothEarningsIncome);
    expect(a.funding.rothDraw).toBe(c.funding.rothDraw);
    expect(a.funding.pretaxDraw).toBe(c.funding.pretaxDraw);
    expect(a.rothEnd).toBe(0);
    expect(a.rothEnd).toBe(c.rothEnd);
    expect(a.pretaxEnd).toBe(c.pretaxEnd);
    expect(a.unpaidTax).toBe(c.unpaidTax);
    expect(a.spendShortfall).toBe(c.spendShortfall);
  });

  test("2028: priced figures identical; clock 2033 (not the phantom 2032)", () => {
    const a = yearOf(b4, 2028), c = yearOf(ctl, 2028);
    expect(a.conversion).toBe(c.conversion);
    expect(a.conversion).toBe(104_500);
    expect(a.penalty).toBe(c.penalty);
    expect(a.penalty).toBe(10_450);
    expect(a.federalTax).toBe(c.federalTax);
    expect(a.funding.rothDraw).toBe(c.funding.rothDraw);
    expect(a.rothEnd).toBe(c.rothEnd);
    expect(a.pretaxEnd).toBe(c.pretaxEnd);
    expect(a.fiveYearClockYear).toBe(2033);
    expect(c.fiveYearClockYear).toBe(2033);
  });

  test("2029-2031: priced figures identical; clock null (not the phantom 2033)", () => {
    for (const year of [2029, 2030, 2031]) {
      const a = yearOf(b4, year), c = yearOf(ctl, year);
      expect(a.conversion).toBe(0);
      expect(a.conversion).toBe(c.conversion);
      expect(a.penalty).toBe(c.penalty);
      expect(a.federalTax).toBe(c.federalTax);
      expect(a.spendShortfall).toBe(250_000);
      expect(a.spendShortfall).toBe(c.spendShortfall);
      expect(a.fiveYearClockYear).toBeNull();
      expect(c.fiveYearClockYear).toBeNull();
    }
  });
});
