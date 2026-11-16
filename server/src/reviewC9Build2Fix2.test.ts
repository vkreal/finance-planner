// Engine Review C9, Build 2, Fix 2 — survivor combine: a $0
// side contributes nothing to the merged Roth ledger
// (Pass 2 SHOULD-1: mergeRothOwnerLedgers poisoned a known
// ledger with a $0-balance unknown side — unconditional AND
// of `known`, no balance guard — the exact corner Build 1's
// Fix 4 already closed for eligibility).
//
// The fix, all three parts together in mergeRothOwnerLedgers
// ONLY (the rollover helper is a separate function with no
// march caller and is untouched):
//   (1) known: (x.known || x.balance <= 0) &&
//       (y.known || y.balance <= 0) — a $0 side cannot poison
//       the merge;
//   (2) a $0 side's lots are DROPPED at the merge — an unknown
//       side can hold phantom lots against a $0 balance (the
//       Fix 1 phantom: the unknown branch never consumes lots),
//       and carrying them into a now-known merged ledger would
//       price a penalty on dollars that do not exist. A guard
//       on `known` alone would be WORSE than the poison, so
//       (1) and (2) ride together. Its contributions are
//       already $0 whenever its balance is $0 (contributions
//       are consumed before lots/earnings on every reachable
//       path — verified from the source; see the merge
//       comment), so the plain contributions sum stays exact;
//   (3) a $0 side's firstYear must not pull the merged
//       5-year clock earlier (it contributed no dollars).
//
// Fixture: the C9 spec fixture on the FICTIONAL sample
// household (server/src/sampleHousehold.ts — every figure
// here is invented, none describes any real household),
// shaped exactly as the Pass 2 reviewer's march probe.
// Every penalty and earnings figure below is HAND arithmetic
// on the pinned legs: a draw consumes contributions first
// (free), then conversion lots FIFO (10% on the TAXABLE
// portion withdrawn when the owner is under 59½ and the lot
// is inside 5 years), then earnings (ordinary income, plus
// 10% when under 59½, unless qualified: owner ≥ 59½ AND the
// 5-year period from the account's first year is met).
// The 2028 conversion in the poison shapes is a fill-loop
// pin (the Build 2 P2 precedent): the fill solver re-solves
// the conversion against the repriced year once the merged
// ledger prices the $2,135 of old earnings as income, so
// the conversion lands below the pre-fix figure — and the
// penalty is still exact hand arithmetic on the pinned
// amount, decomposed leg by leg in each case's comment.

import { describe, expect, test } from "bun:test";
import {
  ROTH_COMPARE_STRATEGIES,
  simulateRothPlan,
  type DrawOrder,
  type RothPlanInputs,
} from "./taxEngine";
import { samplePlanInputs } from "./sampleHousehold";

const DO_NOTHING = ROTH_COMPARE_STRATEGIES[0]!;

// Fill 22% (the reviewer's probe strategy — the taxEngine
// strategy list's own fill22 shape, restated here because
// the probe file needs it by value).
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

// The C9 spec fixture (Build 2 header's assumptions carry
// over: primary born 1971, spouse 1973, $1.5M traditional,
// $2M taxable at 50% basis, $150K/yr spending, $48K SS at
// 67, 5% return, retirement 55).
function fixture(overrides: Partial<RothPlanInputs> = {}): RothPlanInputs {
  return samplePlanInputs({
    birthYearPrimary: 1971,
    birthYearSpouse: 1973,
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

describe("review C9 build 2 fix 2: $0 side contributes nothing to the survivor merge", () => {
  test("survivor merge with a $0 unknown side: known lot prices its penalty (primary-known direction)", () => {
    // Primary $100,000 KNOWN Roth (all contributions, lots
    // [], clock 2020); spouse $50,000 UNENTERED Roth;
    // pre-tax $1,500,000 on the primary's side; spending
    // $150,000/yr, Roth-first; Fill-22%; conversion window
    // opens 2027 (no 2026 conversion); primary dies 2027.
    // 2026: spending draws primary $100,000 + spouse $50,000
    //   exactly — BOTH Roths $0; the spouse's ledger is
    //   unknown at $0.
    // 2027: conversion $192,700 appends a fresh lot to the
    //   PRIMARY's known ledger; spending draws $150,000 of
    //   it at 10% ($15,000); the remainder is
    //   ($192,700 − $150,000) × 1.05 = $44,835 at year end
    //   (lot $42,700 + $2,135 of growth, which the ledger
    //   model accrues to earnings).
    // 2028 (survivor year, spouse 55): the combine merges
    //   primary-known ($44,835) + spouse-unknown ($0) onto
    //   the survivor's side. The $0 side contributes
    //   nothing, so the merged ledger is KNOWN and the draw
    //   consumes the old balance first (FIFO — the 2027 lot
    //   predates the 2028 conversion lot):
    //   - lot $42,700 → penalty $4,270.00;
    //   - earnings $2,135 → income $2,135.00 + penalty
    //     $213.50;
    //   - old-balance penalty $4,483.50 + income $2,135.00
    //     in total (the reviewer's determinable amounts).
    //   The draw then reaches the 2028 conversion lot
    //   ($59,456.52 — the fill-loop pin: the fill solver
    //   re-solves the conversion against the repriced year
    //   once the $2,135 of earnings prices as income, so it
    //   lands below the pre-fix $74,541.59) → penalty
    //   $5,945.65. Total penalty $10,429.15 = 10% × the
    //   whole $104,291.52 draw, income $2,135.00, flag
    //   false, clock 2032 (ledger-derived: earliest lot
    //   2027 + 5 — the merged ledger is known).
    const res = simulateRothPlan(
      fixture({
        rothStart: 150_000,
        rothIraStartSpouse: 50_000,
        rothContributionBasisPrimary: 100_000,
        rothConversionLotsPrimary: [],
        firstRothYearPrimary: 2020,
        annualSpending: 150_000,
        drawOrder: ["roth", "taxable", "pretax"] as DrawOrder,
        windowStartAge: 56,
        windowStopAge: 59,
        survivorEnabled: true,
        survivorWho: "primary" as const,
        survivorDeathYear: 2027,
      }),
      FILL22 as never,
    );
    const y26 = yearOf(res, 2026);
    const y27 = yearOf(res, 2027);
    const y28 = yearOf(res, 2028);
    // 2026: both Roths exhausted, spouse's unknown dollars drawn.
    expect(y26.conversion).toBe(0);
    expect(y26.penalty).toBe(0);
    expect(y26.rothEarningsIncome).toBe(0);
    expect(y26.rothBasisUnknown).toBe(true);
    expect(y26.rothEnd).toBe(0);
    // 2027: conversion happened, the $150,000 spending draw
    // prices 10% on the fresh known lot, remainder survives.
    expect(y27.conversion).toBe(192_700);
    expect(y27.penalty).toBe(15_000);
    expect(y27.rothBasisUnknown).toBe(false);
    expect(y27.rothEnd).toBe(44_835);
    // 2028: the survivor draws the known old balance — the
    // determinable penalty and income price, unflagged.
    expect(y28.conversion).toBe(59_456.52);
    expect(y28.funding.rothDraw).toBe(104_291.52);
    expect(y28.rothBasisUnknown).toBe(false);
    expect(y28.rothEarningsIncome).toBe(2_135);
    expect(y28.penalty).toBe(10_429.15);
    expect(y28.rothEnd).toBe(0);
    expect(y28.fiveYearClockYear).toBe(2032);
    // The old-balance component, pinned on its own: 10% ×
    // the $44,835 the merge carried over ($42,700 lot +
    // $2,135 earnings).
    expect(Math.round(y27.rothEnd * 0.1 * 100) / 100).toBe(4_483.5);
    // And the new-lot component: the rest of the penalty is
    // exactly 10% × the 2028 conversion lot.
    expect(y28.penalty - 4_483.5).toBeCloseTo(5_945.65, 2);
    expect(Math.round(y28.conversion * 0.1 * 100) / 100).toBe(5_945.65);
  });

  test("survivor merge with a $0 unknown side, mirror direction (spouse dies)", () => {
    // Same shape with the roles swapped: the SPOUSE holds
    // the $100,000 KNOWN Roth, the primary holds $50,000
    // UNENTERED; the pre-tax sits on the SPOUSE's side, so
    // the 2027 conversion lands on her known ledger; the
    // spouse dies 2027 and the primary survives. The 2028
    // figures read identically to the first direction.
    const res = simulateRothPlan(
      fixture({
        pretaxStart: 0,
        pretaxSpouseStart: 1_500_000,
        rothStart: 150_000,
        rothIraStartSpouse: 100_000,
        rothContributionBasisSpouse: 100_000,
        rothConversionLotsSpouse: [],
        firstRothYearSpouse: 2020,
        annualSpending: 150_000,
        drawOrder: ["roth", "taxable", "pretax"] as DrawOrder,
        windowStartAge: 56,
        windowStopAge: 59,
        survivorEnabled: true,
        survivorWho: "spouse" as const,
        survivorDeathYear: 2027,
      }),
      FILL22 as never,
    );
    const y26 = yearOf(res, 2026);
    const y27 = yearOf(res, 2027);
    const y28 = yearOf(res, 2028);
    expect(y26.conversion).toBe(0);
    expect(y26.penalty).toBe(0);
    expect(y26.rothEarningsIncome).toBe(0);
    expect(y26.rothBasisUnknown).toBe(true);
    expect(y26.rothEnd).toBe(0);
    expect(y27.conversion).toBe(192_700);
    expect(y27.penalty).toBe(15_000);
    expect(y27.rothBasisUnknown).toBe(false);
    expect(y27.rothEnd).toBe(44_835);
    expect(y28.conversion).toBe(59_456.52);
    expect(y28.funding.rothDraw).toBe(104_291.52);
    expect(y28.rothBasisUnknown).toBe(false);
    expect(y28.rothEarningsIncome).toBe(2_135);
    expect(y28.penalty).toBe(10_429.15);
    expect(y28.rothEnd).toBe(0);
    expect(y28.fiveYearClockYear).toBe(2032);
    expect(Math.round(y27.rothEnd * 0.1 * 100) / 100).toBe(4_483.5);
    expect(y28.penalty - 4_483.5).toBeCloseTo(5_945.65, 2);
  });

  test("a $0 side carrying a phantom lot does not price it after the merge", () => {
    // The naive guard (known only) would be WORSE than the
    // poison: the spouse's side below holds a PHANTOM lot —
    // an ENTERED nontaxable 2020 lot of $50,000 on an unknown
    // ledger (contributions unentered, so the ledger is
    // unknown), left standing against a $0 balance by the
    // 2026 over-draw (the unknown branch never consumes
    // lots). Had that lot ridden into the merged ledger, the
    // 2028 draw would have consumed it FIRST (FIFO,
    // nontaxable → no penalty) and priced only $5,429.15
    // with $0 income and clock 2025 (earliest lot 2020) —
    // hand arithmetic on the debit ordering rules. Dropped
    // at the merge, the 2028 leg reads EXACTLY like the
    // poison shape: penalty $10,429.15, income $2,135,
    // flag false, clock 2032 (earliest lot 2027 — the 2020
    // lot is gone from the merged ledger).
    const res = simulateRothPlan(
      fixture({
        rothStart: 150_000,
        rothIraStartSpouse: 50_000,
        rothContributionBasisPrimary: 100_000,
        rothConversionLotsPrimary: [],
        firstRothYearPrimary: 2020,
        rothConversionLotsSpouse: [
          { year: 2020, taxableAmount: 0, nontaxableAmount: 50_000 },
        ],
        firstRothYearSpouse: 2020,
        annualSpending: 150_000,
        drawOrder: ["roth", "taxable", "pretax"] as DrawOrder,
        windowStartAge: 56,
        windowStopAge: 59,
        survivorEnabled: true,
        survivorWho: "primary" as const,
        survivorDeathYear: 2027,
      }),
      FILL22 as never,
    );
    const y26 = yearOf(res, 2026);
    const y27 = yearOf(res, 2027);
    const y28 = yearOf(res, 2028);
    // 2026: the $50,000 unknown draw leaves the entered lot
    // standing against a $0 balance (phantom); flag set.
    expect(y26.conversion).toBe(0);
    expect(y26.penalty).toBe(0);
    expect(y26.rothBasisUnknown).toBe(true);
    expect(y26.rothEnd).toBe(0);
    // 2027: as the poison shape (conversion on the
    // primary's known ledger; the spouse untouched).
    expect(y27.conversion).toBe(192_700);
    expect(y27.penalty).toBe(15_000);
    expect(y27.rothBasisUnknown).toBe(false);
    expect(y27.rothEnd).toBe(44_835);
    // 2028: identical to the poison shape — the phantom lot
    // changed nothing (it was dropped, not priced).
    expect(y28.conversion).toBe(59_456.52);
    expect(y28.funding.rothDraw).toBe(104_291.52);
    expect(y28.rothBasisUnknown).toBe(false);
    expect(y28.rothEarningsIncome).toBe(2_135);
    expect(y28.penalty).toBe(10_429.15);
    expect(y28.rothEnd).toBe(0);
    expect(y28.fiveYearClockYear).toBe(2032);
  });

  test("a $0 side's first year does not pull the merged clock earlier", () => {
    // Primary $100,000 all-earnings (contributions $0, lots
    // [], firstYear 2027 — the 5-year period runs to 2032);
    // spouse $0 with firstYear 2020 ENTERED. Spending
    // $10,000/yr, Roth-first, Do Nothing (no conversions
    // anywhere); primary dies 2027; the spouse (born 1966,
    // 62 in 2028) survives.
    // 2026/2027: the primary (55/56) draws $10,000 of
    // earnings each year — non-qualified (age unmet, clock
    // unmet) → income $10,000 + penalty $1,000; balances
    // ($100,000 − $10,000) × 1.05 = $94,500, then
    // ($94,500 − $10,000) × 1.05 = $88,725.
    // 2028: the survivor (62) draws $10,000 of the merged
    // earnings. The merged clock derives from the surviving
    // side (firstYear 2027, period unmet until 2032), NOT
    // from the $0 side's entered 2020 — so the distribution
    // is NON-qualified and prices income $10,000 (penalty
    // $0 at 62). Had the $0 side's 2020 pulled the clock
    // earlier, the 5-year period would read met (2028 ≥
    // 2025) and the same draw would price $0 income.
    const res = simulateRothPlan(
      fixture({
        birthYearSpouse: 1966,
        rothStart: 100_000,
        rothIraStartSpouse: 0,
        rothContributionBasisPrimary: 0,
        rothConversionLotsPrimary: [],
        firstRothYearPrimary: 2027,
        firstRothYearSpouse: 2020,
        annualSpending: 10_000,
        drawOrder: ["roth", "taxable", "pretax"] as DrawOrder,
        survivorEnabled: true,
        survivorWho: "primary" as const,
        survivorDeathYear: 2027,
      }),
      DO_NOTHING,
    );
    const y26 = yearOf(res, 2026);
    const y27 = yearOf(res, 2027);
    const y28 = yearOf(res, 2028);
    const y29 = yearOf(res, 2029);
    expect(y26.penalty).toBe(1_000);
    expect(y26.rothEarningsIncome).toBe(10_000);
    expect(y26.rothBasisUnknown).toBe(false);
    expect(y26.rothEnd).toBe(94_500);
    expect(y27.penalty).toBe(1_000);
    expect(y27.rothEarningsIncome).toBe(10_000);
    expect(y27.rothBasisUnknown).toBe(false);
    expect(y27.rothEnd).toBe(88_725);
    // 2028: income prices — the merged clock is 2027's,
    // not the $0 side's 2020.
    expect(y28.penalty).toBe(0);
    expect(y28.rothEarningsIncome).toBe(10_000);
    expect(y28.rothBasisUnknown).toBe(false);
    expect(y28.rothEnd).toBe(82_661.25);
    // 2029: still unmet (2029 < 2032) — income still prices.
    expect(y29.penalty).toBe(0);
    expect(y29.rothEarningsIncome).toBe(10_000);
    expect(y29.rothBasisUnknown).toBe(false);
    expect(y29.rothEnd).toBe(76_294.31);
  });

  test("control: a nonzero side's earlier first year still governs the merged clock", () => {
    // The $0 guard must not over-correct: the spouse holds
    // $10,000 KNOWN (contributions $10,000, firstYear 2020)
    // — a NONZERO side — so the merged clock is the earlier
    // of the two first years (2020), and the 62-year-old
    // survivor's 2028 earnings draw is QUALIFIED (age met,
    // period met: 2028 ≥ 2025) → income $0. Spending
    // $30,000/yr so the draw reaches earnings past the
    // $10,000 of contributions.
    // 2026/2027: the primary (55/56) draws $30,000 of
    // earnings each year → income $30,000 + penalty $3,000;
    // rothEnd ($100,000 − $30,000) × 1.05 + $10,000 × 1.05
    // = $84,000, then ($73,500 − $30,000) × 1.05 +
    // $10,500 × 1.05 = $56,700.
    // 2028: merged balance $56,700, contributions $10,000,
    // firstYear 2020; the $30,000 draw consumes the $10,000
    // of contributions (free) and $20,000 of earnings —
    // qualified → income $0, penalty $0; rothEnd
    // ($56,700 − $30,000) × 1.05 = $28,035.
    const res = simulateRothPlan(
      fixture({
        birthYearSpouse: 1966,
        rothStart: 110_000,
        rothIraStartSpouse: 10_000,
        rothContributionBasisPrimary: 0,
        rothConversionLotsPrimary: [],
        firstRothYearPrimary: 2027,
        rothContributionBasisSpouse: 10_000,
        rothConversionLotsSpouse: [],
        firstRothYearSpouse: 2020,
        annualSpending: 30_000,
        drawOrder: ["roth", "taxable", "pretax"] as DrawOrder,
        survivorEnabled: true,
        survivorWho: "primary" as const,
        survivorDeathYear: 2027,
      }),
      DO_NOTHING,
    );
    const y26 = yearOf(res, 2026);
    const y27 = yearOf(res, 2027);
    const y28 = yearOf(res, 2028);
    expect(y26.penalty).toBe(3_000);
    expect(y26.rothEarningsIncome).toBe(30_000);
    expect(y26.rothBasisUnknown).toBe(false);
    expect(y26.rothEnd).toBe(84_000);
    expect(y27.penalty).toBe(3_000);
    expect(y27.rothEarningsIncome).toBe(30_000);
    expect(y27.rothBasisUnknown).toBe(false);
    expect(y27.rothEnd).toBe(56_700);
    expect(y28.penalty).toBe(0);
    expect(y28.rothEarningsIncome).toBe(0);
    expect(y28.rothBasisUnknown).toBe(false);
    expect(y28.rothEnd).toBe(28_035);
  });
});
