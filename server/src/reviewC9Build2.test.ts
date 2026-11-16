// Engine Review C9, Build 2 — Roth ledgers + distribution ordering
// (W3-B1–B6: per-owner Roth ledgers, contributions → conversion
// lots FIFO → earnings, §72(t) on lots and non-qualified earnings,
// fiveYearClockYear from the ledger, pricePlaygroundYear ordering,
// work-years roll carry-forward).
//
// Fixture: the C9 spec fixture on the FICTIONAL sample household
// (server/src/sampleHousehold.ts — every figure here is invented, none
// describes any real household): primary 55, MFJ, $2M taxable at 50%
// basis, $1.5M traditional, $500K Roth, $150K/yr spending (including
// healthcare, excluding income taxes), $48K SS at 67, through 95.
// The Build 1 header's assumptions carry over unchanged (spouse born
// 1973, ACA household size 2, spouse SS $0, pre-tax all primary's
// except where a case varies it, expected return 5%, retirement 55,
// window 55–59). The Build 2 cases add one stated fact each:
//   - the P1 shape enters a contribution basis BELOW the balance
//     ($200,000 of $500,000), so the draw reaches earnings;
//   - the clock-split case enters the Roth IRA / designated Roth
//     split ($500,000 / $500,000 of a $1,000,000 Roth) with the
//     IRA clock met (2020) and the designated clock unmet (2027);
//   - the survivor cases enter the survivor scenario the Build 1
//     fixture leaves off (survivorEnabled, survivorWho, death year).
//
// Every penalty and every earnings figure below is HAND arithmetic,
// stated in the case's own comment — never copied from engine
// output: a draw consumes contributions first (free), then
// conversion lots FIFO (10% on the TAXABLE portion withdrawn when
// the owner is under 59½ and the lot is inside 5 years), then
// earnings (ordinary income, plus 10% when under 59½, unless the
// distribution is qualified: owner ≥ 59½ AND the 5-year period
// from the account's first year is met). Where a case's
// conversion amount is a fill-loop pin (P2), the note says so and
// the penalty is still exact hand arithmetic on the pinned amount.
// Where a year's AGI exceeds the earnings by more than the
// earnings themselves, the note names the feedback: the extra
// federal tax is paid from Taxable, the sale realizes gains, and
// the gains feed back into AGI — so the AGI differential is the
// earnings PLUS the feedback gains, never exactly the earnings.

import { describe, expect, test } from "bun:test";
import {
  ROTH_COMPARE_STRATEGIES,
  initRothAccountLedger,
  mergeRothLedgersForRollover,
  simulateRothPlan,
  type DrawOrder,
  type RothPlanInputs,
} from "./taxEngine";
import {
  buildRothFunding,
  planNetCost,
  pricePlaygroundYear,
  runRothCompare,
} from "./rothOptimizer";
import { samplePlanInputs } from "./sampleHousehold";
import { sampleCompareBase } from "./hardening/sensCompareBase";
import { rollWorkYears } from "./workYears";

const DO_NOTHING = ROTH_COMPARE_STRATEGIES[0]!;
const FILL12 = ROTH_COMPARE_STRATEGIES[1]!;

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

describe("C9 Build 2 — Roth ledgers + distribution ordering", () => {
  test("P2: conversion withdrawn the same year, Roth started at $0 — 10% on the lot", () => {
    // The audit's strongest case (W3 P2): Roth starts at $0, so
    // EVERY Roth dollar is a 2026 Fill-12% conversion dollar —
    // no contribution basis exists to hide behind. The 2026
    // conversion is $59,300.00 (a fill-loop pin: pre-fix it was
    // $62,990.74 — the penalty, paid from Taxable, sells shares
    // and realizes gains, and the gains shrink the conversion
    // headroom under the 12% top). Roth-first draws the whole
    // conversion for spending the same year, at age 58, inside
    // 5 years: 10% × $59,300.00 = $5,930.00. The row's clock
    // reads 2031 (the 2026 lot + 5) — now enforced, not displayed.
    // 2027 converts $56,500.00 and draws it at 59: 10% × $56,500.00
    // = $5,650.00, clock 2032 (the 2026 lot is fully withdrawn, so
    // the earliest OPEN lot is the 2027 one). At 60 (2028) the age
    // test stops: $0 on the identical shape. Lifetime: $5,930.00 +
    // $5,650.00 = $11,580.00. No year is unknown: the $0 opening
    // balance is known by construction, and the march's own
    // conversion lots append to that known ledger.
    const res = simulateRothPlan(
      samplePlanInputs({
        rothStart: 0,
        retirementAge: 58,
        windowStartAge: 58,
        windowStopAge: 73,
        drawOrder: ["roth", "taxable", "pretax"],
        payTaxFrom: "taxable",
      }),
      FILL12,
    );
    const y26 = yearOf(res, 2026);
    expect(y26.conversion).toBe(59_300);
    expect(y26.funding.rothDraw).toBe(59_300);
    expect(y26.penalty).toBe(5_930);
    expect(y26.fiveYearClockYear).toBe(2031);
    expect(y26.rothBasisUnknown).toBe(false);
    expect(y26.rothEarningsIncome).toBe(0);
    const y27 = yearOf(res, 2027);
    expect(y27.conversion).toBe(56_500);
    expect(y27.penalty).toBe(5_650);
    expect(y27.fiveYearClockYear).toBe(2032);
    expect(yearOf(res, 2028).penalty).toBe(0);
    expect(res.lifetimePenalty).toBe(11_580);
    expect(res.rothBasisUnknownYears).toEqual([]);
  });

  test("P1 earnings shape: contributions shelter, then earnings price income + 10%", () => {
    // Basis $200,000 of a $500,000 Roth, no prior conversions,
    // IRA clock 2020 (met 2025), Roth-first, Do Nothing.
    // 2026 (55): the $150,000 draw is all contributions — free,
    // $0 penalty, $0 earnings income. 2027 (56): Roth opens at
    // ($500,000 − $150,000) × 1.05 = $367,500; contributions left
    // $50,000 shelter the first $50,000, the next $100,000 is
    // earnings — non-qualified (56 < 59½) — so $100,000 ordinary
    // income + 10% × $100,000 = $10,000 penalty. 2028 (57): the
    // whole $150,000 draw is earnings: $150,000 income +
    // $15,000. 2029 (58): the last $82,293.75 of Roth is all
    // earnings: $82,293.75 income + 10% × $82,293.75 = $8,229.38.
    // Lifetime: $10,000 + $15,000 + $8,229.38 = $33,229.38.
    // The 2027 AGI is $132,134.72 against the all-basis control's
    // $22,575.00 — a $109,559.72 differential, NOT $100,000: the
    // $100,000 earnings is the income, and the $9,559.72 remainder
    // is the feedback — the extra federal tax is paid from Taxable,
    // the sale realizes gains, and the gains feed back into AGI.
    const res = simulateRothPlan(
      fixture({
        rothContributionBasisPrimary: 200_000,
        rothConversionLotsPrimary: [],
        firstRothYearPrimary: 2020,
        drawOrder: ["roth", "taxable", "pretax"],
      }),
      DO_NOTHING,
    );
    expect(yearOf(res, 2026).funding.rothDraw).toBe(150_000);
    expect(yearOf(res, 2026).penalty).toBe(0);
    expect(yearOf(res, 2026).rothEarningsIncome).toBe(0);
    expect(yearOf(res, 2026).agi).toBe(21_500);
    expect(yearOf(res, 2027).rothEarningsIncome).toBe(100_000);
    expect(yearOf(res, 2027).penalty).toBe(10_000);
    expect(yearOf(res, 2027).agi).toBe(132_134.72);
    expect(yearOf(res, 2028).rothEarningsIncome).toBe(150_000);
    expect(yearOf(res, 2028).penalty).toBe(15_000);
    expect(yearOf(res, 2029).funding.rothDraw).toBe(82_293.75);
    expect(yearOf(res, 2029).rothEarningsIncome).toBe(82_293.75);
    expect(yearOf(res, 2029).penalty).toBe(8_229.38);
    expect(res.lifetimePenalty).toBe(33_229.38);
    const control = simulateRothPlan(
      fixture({
        rothContributionBasisPrimary: 500_000,
        rothConversionLotsPrimary: [],
        firstRothYearPrimary: 2020,
        drawOrder: ["roth", "taxable", "pretax"],
      }),
      DO_NOTHING,
    );
    expect(yearOf(control, 2027).agi).toBe(22_575);
    expect(yearOf(res, 2027).agi - yearOf(control, 2027).agi).toBe(109_559.72);
  });

  test("P1 free at 62: the same earnings draw is qualified once 59½ and the clock are met", () => {
    // Same composition as the P1 shape, retiring at 62 instead of
    // 55 (first draw 2033, clock 2020 met since 2025). The 2033
    // $150,000 draw is all contributions; the 2034 $150,000 draw
    // reaches $100,000 of earnings — but the owner is 63 and the
    // clock is met, so the distribution is QUALIFIED: $0 income,
    // $0 penalty, and the year's AGI is identical to the all-basis
    // control's, dollar for dollar, in both years.
    const run = (basis: number) =>
      simulateRothPlan(
        fixture({
          rothContributionBasisPrimary: basis,
          rothConversionLotsPrimary: [],
          firstRothYearPrimary: 2020,
          retirementAge: 62,
          windowStartAge: 62,
          windowStopAge: 73,
          drawOrder: ["roth", "taxable", "pretax"],
        }),
        DO_NOTHING,
      );
    const res = run(200_000);
    const control = run(500_000);
    for (const year of [2033, 2034, 2035]) {
      expect(yearOf(res, year).rothEarningsIncome).toBe(0);
      expect(yearOf(res, year).penalty).toBe(0);
      expect(yearOf(res, year).agi).toBe(yearOf(control, year).agi);
    }
    expect(yearOf(res, 2034).funding.rothDraw).toBe(150_000);
  });

  test("clock split: the designated Roth clock gates its own account's earnings", () => {
    // Roth $1,000,000, IRA $500,000 / employer $500,000, basis
    // $200,000 pro-rata ($100,000 each account); IRA clock 2020
    // (met 2025), designated clock 2027 (met 2032); retire 55,
    // Roth-first. The IRA funds the 2026–2028 draws and the
    // employer contributions fund 2029–2030, so the employer's
    // earnings are first reached in 2031 — at age 60, with the
    // IRA clock met and the owner past 59½, but the DESIGNATED
    // clock unmet (2031 < 2032): the whole $150,000 draw is
    // earnings income, $0 penalty. In 2032 the designated clock
    // is met and the identical draw prices $0 income. The control
    // (designated clock 2020) prices $0 income in 2031 — the
    // clock, not the age, is the only failing test that year.
    // The earlier years pin the ordering on the IRA side: 2026
    // draws $100,000 contributions + $50,000 earnings (age 55:
    // $50,000 income + $5,000); 2029 draws the last $82,293.75
    // of IRA earnings ($82,293.75 + $8,229.38); 2030 draws
    // $32,293.75 of employer contributions + $117,706.25 of
    // employer earnings ($117,706.25 + $11,770.63 at 59).
    const base = {
      rothStart: 1_000_000,
      rothIraStart: 500_000,
      rothEmployerStart: 500_000,
      rothContributionBasisPrimary: 200_000,
      rothConversionLotsPrimary: [],
      firstRothYearPrimary: 2020,
      firstDesignatedRothYearPrimary: 2027,
      drawOrder: ["roth", "taxable", "pretax"] as DrawOrder,
    };
    const res = simulateRothPlan(fixture(base), DO_NOTHING);
    expect(yearOf(res, 2026).rothEarningsIncome).toBe(50_000);
    expect(yearOf(res, 2026).penalty).toBe(5_000);
    expect(yearOf(res, 2029).rothEarningsIncome).toBe(82_293.75);
    expect(yearOf(res, 2029).penalty).toBe(8_229.38);
    expect(yearOf(res, 2030).rothEarningsIncome).toBe(117_706.25);
    expect(yearOf(res, 2030).penalty).toBe(11_770.63);
    expect(yearOf(res, 2031).rothEarningsIncome).toBe(150_000);
    expect(yearOf(res, 2031).penalty).toBe(0);
    expect(yearOf(res, 2031).rothBasisUnknown).toBe(false);
    expect(yearOf(res, 2032).rothEarningsIncome).toBe(0);
    const control = simulateRothPlan(
      fixture({ ...base, firstDesignatedRothYearPrimary: 2020 }),
      DO_NOTHING,
    );
    expect(yearOf(control, 2031).rothEarningsIncome).toBe(0);
    expect(yearOf(control, 2031).penalty).toBe(0);
  });

  test("bit-identical control: no basis entered — $0 priced, flagged unknown", () => {
    // No new inputs at all, Roth-first: the plan prices exactly
    // as before the build ($0 penalty, $0 Roth income — the
    // landing default), and the disclosure flag says the $0 is
    // unknown, not computed, in every Roth-draw year. The Roth
    // drains $500,000 → $367,500 → $228,375 → $82,293.75 → $0
    // over 2026–2029 ($150,000 a year, the last year partial),
    // so the unknown years are exactly 2026–2029 and the 2030
    // row (no Roth draw) is unflagged.
    const res = simulateRothPlan(
      fixture({ drawOrder: ["roth", "taxable", "pretax"] }),
      DO_NOTHING,
    );
    for (const year of [2026, 2027, 2028, 2029]) {
      expect(yearOf(res, year).penalty).toBe(0);
      expect(yearOf(res, year).rothEarningsIncome).toBe(0);
      expect(yearOf(res, year).rothBasisUnknown).toBe(true);
    }
    expect(yearOf(res, 2029).funding.rothDraw).toBe(82_293.75);
    expect(yearOf(res, 2030).rothBasisUnknown).toBe(false);
    expect(yearOf(res, 2026).agi).toBe(21_500);
    expect(res.lifetimePenalty).toBe(0);
    expect(res.rothBasisUnknownYears).toEqual([2026, 2027, 2028, 2029]);
  });

  test("per-owner leg: the draw prices on the drawing owner's own ledger and age", () => {
    // Spouse holds $200,000 of the $500,000 IRA; primary holds
    // $300,000 with $100,000 basis, spouse $50,000 basis, IRA
    // clock 2020. Roth-first at 55 draws $150,000 primary-first:
    // $100,000 primary contributions (free) + $50,000 primary
    // earnings ($50,000 income + 10% × $50,000 = $5,000) — the
    // spouse's ledger is untouched. If the draw had priced on the
    // spouse's ledger first, the income would be $100,000 with
    // the unknown flag (her clock is unentered); the $50,000 +
    // $5,000 + unflagged row pins primary-first.
    const res = simulateRothPlan(
      fixture({
        rothIraStart: 500_000,
        rothIraStartSpouse: 200_000,
        rothContributionBasisPrimary: 100_000,
        rothContributionBasisSpouse: 50_000,
        rothConversionLotsPrimary: [],
        rothConversionLotsSpouse: [],
        firstRothYearPrimary: 2020,
        drawOrder: ["roth", "taxable", "pretax"],
      }),
      DO_NOTHING,
    );
    expect(yearOf(res, 2026).rothEarningsIncome).toBe(50_000);
    expect(yearOf(res, 2026).penalty).toBe(5_000);
    expect(yearOf(res, 2026).rothBasisUnknown).toBe(false);
    expect(yearOf(res, 2027).rothEarningsIncome).toBe(150_000);
    expect(yearOf(res, 2027).penalty).toBe(15_000);
  });

  test("survivor (a): the merged clock is the earlier of the two — qualified in 2031", () => {
    // Primary's IRA clock 2020 (met), spouse's 2027 (unmet until
    // 2032); Roth $1,000,000 (spouse holds $200,000 of the IRA),
    // primary basis $200,000, spouse basis $50,000; primary dies
    // 2030. The combined ledger sits on the spouse's side from
    // 2031 and the survivor's age governs. In 2031 the spouse is
    // 60 and the merged clock is min(2020, 2027) = 2020 (met), so
    // the $150,000 draw — $50,000 of merged contributions +
    // $100,000 earnings — is qualified: $0 income, $0 penalty.
    // The control (the deceased's clock also 2027, merged 2027,
    // unmet until 2032) prices the same $100,000 of earnings as
    // income in 2031. In 2032 the control's clock is met too and
    // both runs price $0. The death year itself (2030, primary
    // 59) still prices the primary alive: $150,000 earnings +
    // $15,000 penalty.
    const base = {
      rothStart: 1_000_000,
      rothIraStartSpouse: 200_000,
      rothContributionBasisPrimary: 200_000,
      rothContributionBasisSpouse: 50_000,
      rothConversionLotsPrimary: [],
      rothConversionLotsSpouse: [],
      firstRothYearPrimary: 2020,
      firstRothYearSpouse: 2027,
      birthYearSpouse: 1971, // same age as the primary: 60 in 2031
      survivorEnabled: true,
      survivorWho: "primary" as const,
      survivorDeathYear: 2030,
      drawOrder: ["roth", "taxable", "pretax"] as DrawOrder,
    };
    const res = simulateRothPlan(fixture(base), DO_NOTHING);
    expect(yearOf(res, 2030).rothEarningsIncome).toBe(150_000);
    expect(yearOf(res, 2030).penalty).toBe(15_000);
    expect(yearOf(res, 2031).rothEarningsIncome).toBe(0);
    expect(yearOf(res, 2031).penalty).toBe(0);
    expect(yearOf(res, 2031).rothBasisUnknown).toBe(false);
    expect(yearOf(res, 2032).rothEarningsIncome).toBe(0);
    const control = simulateRothPlan(
      fixture({ ...base, firstRothYearPrimary: 2027 }),
      DO_NOTHING,
    );
    expect(yearOf(control, 2031).rothEarningsIncome).toBe(100_000);
    expect(yearOf(control, 2031).penalty).toBe(0);
    expect(yearOf(control, 2032).rothEarningsIncome).toBe(0);
  });

  test("survivor (b): a conversion lot withdrawn in a survivor year still pays §72(t) — no death waiver", () => {
    // The whole $500,000 Roth is one 2026 conversion lot (no
    // contributions), IRA clock 2020; Taxable $50,000 and pre-tax
    // $50,000 (eligible, separation 55 — so the pre-tax spending
    // draw prices no penalty and the year's penalty is the Roth
    // lot's alone); primary dies 2027. 2026 draws $50,000 of the
    // lot for spending (Taxable + pre-tax cover the other
    // $100,000): 10% × $50,000 = $5,000. 2027 (death year, the
    // primary still prices alive) draws $150,000 of the lot:
    // $15,000. 2028 is a SURVIVOR year — the spouse is 55, the
    // combined ledger carries the 2026 lot at age 2 — and the
    // $150,000 lot withdrawal still prices 10% × $150,000 =
    // $15,000: under Reg §1.408A-6 Q&A-7(b) the spouse treats the
    // account as their own, so the death exception no longer
    // applies and the per-lot 5-year clock runs on. A death
    // waiver would read $0 here. The funding draw in 2026 reads
    // $56,796.25 — the $50,000 spending draw plus the $1,796.25
    // tax-bill debit and the $5,000 penalty payment, neither of
    // which is itself penalized (tax-debit legs price income,
    // never penalty — the Build 2 scope decision, same as Build
    // 1's pre-tax legs). Lifetime: $5,000 + $15,000 + $15,000 +
    // $15,000.01 = $50,000.01 (2029's cent is settlement rounding
    // on the shortfall year, when the balance could not cover
    // spending + penalty and part of the penalty went unpaid).
    const res = simulateRothPlan(
      fixture({
        taxableStart: 50_000,
        pretaxStart: 50_000,
        pretax401kEligiblePrimary: 50_000,
        separationAgePrimary: 55,
        rothStart: 500_000,
        rothContributionBasisPrimary: 0,
        rothConversionLotsPrimary: [
          { year: 2026, taxableAmount: 500_000, nontaxableAmount: 0 },
        ],
        firstRothYearPrimary: 2020,
        survivorEnabled: true,
        survivorWho: "primary" as const,
        survivorDeathYear: 2027,
        drawOrder: ["taxable", "pretax", "roth"],
      }),
      DO_NOTHING,
    );
    expect(yearOf(res, 2026).funding.rothDraw).toBe(56_796.25);
    expect(yearOf(res, 2026).penalty).toBe(5_000);
    expect(yearOf(res, 2027).penalty).toBe(15_000);
    expect(yearOf(res, 2028).penalty).toBe(15_000);
    expect(yearOf(res, 2028).rothBasisUnknown).toBe(false);
    expect(res.lifetimePenalty).toBe(50_000.01);
  });

  test("rollover clock rule: the designated Roth's own start year does not carry over", () => {
    // Reg §1.408A-6 Q&A-4 / Pub 590-B: time in a designated Roth
    // account does not count toward the Roth IRA 5-year period;
    // the merged period begins with the EARLIER of the first
    // Roth IRA contribution/conversion year or the taxable year
    // the rollover contribution is made. IRA clock 2020,
    // designated clock 2018, rollover 2026: the merged clock is
    // min(2020, 2026) = 2020 — the designated account's 2018
    // does not pull it earlier. With no IRA clock at all, the
    // merged clock is the rollover year 2026 — again, not 2018.
    // Contributions and balances add; the lots keep their years.
    const ira = initRothAccountLedger(100_000, 40_000, [], 2020);
    const employer = initRothAccountLedger(50_000, 20_000, [], 2018);
    const merged = mergeRothLedgersForRollover(ira, employer, 2026);
    expect(merged.balance).toBe(150_000);
    expect(merged.contributions).toBe(60_000);
    expect(merged.firstYear).toBe(2020);
    expect(merged.known).toBe(true);
    const noIraClock = initRothAccountLedger(100_000, 40_000, [], null);
    const merged2 = mergeRothLedgersForRollover(noIraClock, employer, 2026);
    expect(merged2.firstYear).toBe(2026);
    expect(merged2.balance).toBe(150_000);
  });

  test("work-years roll: basis carries forward with the contributions added", () => {
    // The P5 shape (W3): salary $400,000, quit 65 — three work
    // years, ages 62–64 (calendar 2030–2032), Roth contributions
    // $173,000 (catch-up Roth $11,250 + $11,250 + $8,000 to the
    // employer plan, mega-backdoor $47,500 × 3 to the IRA).
    // Entering basis $50,000 → rolled basis $50,000 + $173,000 =
    // $223,000. The split balances: IRA $612,793.75 (the $400,000
    // opening, all IRA, grown + $47,500 a year) and employer
    // $32,215.63 (catch-up Roth grown: $11,250 → $23,062.50 →
    // $32,215.63), summing to the $645,009.38 total the probe
    // pinned pre-fix. The entering lot and IRA clock ride the
    // spread unchanged; the designated clock the plan left
    // unentered is established by the roll's first catch-up Roth
    // year, 2030. With no basis entered, the rolled basis stays
    // null — unknown stays unknown — while the roll still
    // establishes both clocks from its first mega (2030) and
    // first catch-up Roth (2030) years.
    const roll = rollWorkYears(
      samplePlanInputs({
        rothContributionBasisPrimary: 50_000,
        rothConversionLotsPrimary: [
          { year: 2020, taxableAmount: 30_000, nontaxableAmount: 0 },
        ],
        firstRothYearPrimary: 2020,
      }),
      { salary: 400000, employer401k: 0, employerHsa: 0 },
      65,
    );
    expect(roll.totals.rothContributions).toBe(173_000);
    expect(roll.balances.roth).toBe(645_009.38);
    expect(roll.balances.rothIra).toBe(612_793.75);
    expect(roll.balances.rothEmployer).toBe(32_215.63);
    expect(
      roll.balances.rothIra + roll.balances.rothEmployer,
    ).toBe(roll.balances.roth);
    expect(roll.rolledInputs.rothStart).toBe(645_009.38);
    expect(roll.rolledInputs.rothIraStart).toBe(612_793.75);
    expect(roll.rolledInputs.rothEmployerStart).toBe(32_215.63);
    expect(roll.rolledInputs.rothContributionBasisPrimary).toBe(223_000);
    expect(roll.rolledInputs.rothConversionLotsPrimary).toEqual([
      { year: 2020, taxableAmount: 30_000, nontaxableAmount: 0 },
    ]);
    expect(roll.rolledInputs.firstRothYearPrimary).toBe(2020);
    expect(roll.rolledInputs.firstDesignatedRothYearPrimary).toBe(2030);
    const unknown = rollWorkYears(
      samplePlanInputs({}),
      { salary: 400000, employer401k: 0, employerHsa: 0 },
      65,
    );
    expect(unknown.rolledInputs.rothContributionBasisPrimary).toBeNull();
    expect(unknown.rolledInputs.firstRothYearPrimary).toBe(2030);
    expect(unknown.rolledInputs.firstDesignatedRothYearPrimary).toBe(2030);
  });

  test("pricePlaygroundYear: the rothDraw dial prices on the entered composition", () => {
    // The W3 P4 base: age 58, MFJ, $1,500 interest + $20,000
    // ordinary dividends ($15,000 qualified), no other income —
    // AGI $21,500 with no draw. With the composition ABSENT, a
    // $100,000 draw prices exactly as before ($0 income, $0
    // penalty) with the flags saying the $0 is unknown and
    // assumed-qualified, and the draw still counts as cash in
    // ($121,500). With contributions $40,000 of a $100,000
    // balance entered (no lots, IRA clock 2020 met — but 58 <
    // 59½, so the earnings are non-qualified): the draw is
    // $40,000 contributions + $60,000 earnings → $60,000 income
    // (AGI $81,500) + 10% × $60,000 = $6,000 penalty, inside the
    // $9,620 net bill beside the $3,620 federal tax. With the
    // whole $100,000 as one 2026 conversion lot (basis $0): the
    // draw is all lot, inside 5 years at 58 → $0 income + 10% ×
    // $100,000 = $10,000 penalty, net bill $10,000.
    const base = {
      taxYear: 2026,
      filingStatus: "mfj" as const,
      agePrimary: 58,
      ageSpouse: 56,
      onMedicarePrimary: false,
      onMedicareSpouse: false,
      interest: 1500,
      ordinaryDividends: 20000,
      qualifiedDividends: 15000,
      otherOrdinary: 0,
      taxExemptInterest: 0,
      ssPrimary: 0,
      ssSpouse: 0,
      conversion: 0,
      spendingDraw: 0,
      cashDraw: 0,
      stockSold: 0,
      stockBasis: 0,
      pretaxBalance: 0,
      spouseSoleBeneficiary: true,
      acaHouseholdSize: 4,
      acaBenchmarkAnnual: null,
      stateRatePct: 0,
    };
    const noDraw = pricePlaygroundYear({ ...base, rothDraw: 0 });
    expect(noDraw.agi).toBe(21_500);
    expect(noDraw.rothBasisUnknown).toBe(false);
    expect(noDraw.rothAssumedQualified).toBe(false);
    const absent = pricePlaygroundYear({ ...base, rothDraw: 100_000 });
    expect(absent.agi).toBe(21_500);
    expect(absent.rothEarningsIncome).toBe(0);
    expect(absent.rothPenalty).toBe(0);
    expect(absent.rothBasisUnknown).toBe(true);
    expect(absent.rothAssumedQualified).toBe(true);
    expect(absent.cashIn).toBe(121_500);
    const contrib = pricePlaygroundYear({
      ...base,
      rothDraw: 100_000,
      rothBalance: 100_000,
      rothContributionBasis: 40_000,
      rothConversionLots: [],
      firstRothYear: 2020,
    });
    expect(contrib.agi).toBe(81_500);
    expect(contrib.rothEarningsIncome).toBe(60_000);
    expect(contrib.rothPenalty).toBe(6_000);
    expect(contrib.federalTax).toBe(3_620);
    expect(contrib.netTaxBill).toBe(9_620);
    expect(contrib.rothBasisUnknown).toBe(false);
    expect(contrib.rothAssumedQualified).toBe(false);
    const lot = pricePlaygroundYear({
      ...base,
      rothDraw: 100_000,
      rothBalance: 100_000,
      rothContributionBasis: 0,
      rothConversionLots: [
        { year: 2026, taxableAmount: 100_000, nontaxableAmount: 0 },
      ],
      firstRothYear: 2026,
    });
    expect(lot.agi).toBe(21_500);
    expect(lot.rothEarningsIncome).toBe(0);
    expect(lot.rothPenalty).toBe(10_000);
    expect(lot.netTaxBill).toBe(10_000);
    expect(lot.rothBasisUnknown).toBe(false);
  });

  test("disclosure flags flow through runRothCompare and buildRothFunding", () => {
    // The compare base is the sample-household shape with the
    // fixture's ages and balances; the scenario overrides the
    // draw order to Roth-first so the Roth draws actually happen
    // in the compare march — with no composition entered anywhere,
    // every Roth-draw year is unknown. The funding rows carry the
    // same per-year flag. The compare's penalty is $0 (unknown,
    // not computed).
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
    const cmp = runRothCompare(
      base as never,
      [{ name: "Do Nothing", overrides: { drawOrder: "roth-taxable-pretax" } }],
      2026,
      null,
    );
    const s0 = cmp.scenarios[0]!;
    expect(s0.rothBasisUnknownYears).toEqual([2026, 2027, 2028, 2029]);
    expect(
      s0.years.filter((y) => y.year <= 2030).map((y) => y.rothBasisUnknown),
    ).toEqual([true, true, true, true, false]);
    expect(s0.penaltyCents).toBe(0);
    const funding = buildRothFunding(
      fixture({ drawOrder: ["roth", "taxable", "pretax"] }),
      DO_NOTHING as never,
    );
    expect(
      funding.filter((r) => r.year <= 2030).map((r) => r.rothBasisUnknown),
    ).toEqual([true, true, true, true, false]);
  });

  test("six-order rankings before vs after: ordering re-ranks Roth-first, leaves taxable-first untouched", () => {
    // All six draw orders on identical opening balances, priced
    // twice: composition unentered (the before leg — the
    // bit-identical default, $0 penalty everywhere) and
    // composition entered with $200,000 of basis (the after leg).
    // The ranking by net cost is the same in both legs; the
    // penalty raises the Roth-led orders' net cost and leaves the
    // taxable-led orders untouched (their Roth draws start only
    // after Taxable is exhausted, past 59½ — and the pre-tax-led
    // orders' Roth draws likewise start late, so only the two
    // Roth-first orders move).
    const orders: [string, DrawOrder][] = [
      ["taxable-first", ["taxable", "pretax", "roth"]],
      ["pretax-first", ["pretax", "taxable", "roth"]],
      ["roth-first", ["roth", "taxable", "pretax"]],
      ["taxable-roth-pretax", ["taxable", "roth", "pretax"]],
      ["pretax-roth-taxable", ["pretax", "roth", "taxable"]],
      ["roth-pretax-taxable", ["roth", "pretax", "taxable"]],
    ];
    const price = (comp: Partial<RothPlanInputs>) => {
      const out: Record<string, { netCost: number; penalty: number }> = {};
      for (const [name, order] of orders) {
        const inputs = fixture({ ...comp, drawOrder: order });
        const res = simulateRothPlan(inputs, DO_NOTHING as never);
        out[name] = { netCost: planNetCost(res, inputs).netCost, penalty: res.lifetimePenalty };
      }
      return out;
    };
    const before = price({});
    const after = price({
      rothContributionBasisPrimary: 200_000,
      rothConversionLotsPrimary: [],
      firstRothYearPrimary: 2020,
    });
    const rank = (leg: Record<string, { netCost: number }>) =>
      Object.entries(leg)
        .sort((a, b) => a[1].netCost - b[1].netCost)
        .map(([name]) => name);
    expect(rank(after)).toEqual(rank(before));
    expect(after["roth-first"]!.penalty).toBe(33_229.38);
    expect(after["roth-pretax-taxable"]!.penalty).toBe(33_229.38);
    expect(after["taxable-first"]!.penalty).toBe(0);
    expect(after["pretax-first"]!.penalty).toBe(0);
    expect(after["taxable-first"]!.netCost).toBe(before["taxable-first"]!.netCost);
    expect(after["pretax-first"]!.netCost).toBe(before["pretax-first"]!.netCost);
    expect(after["roth-first"]!.netCost).toBeGreaterThan(before["roth-first"]!.netCost);
  });
});
