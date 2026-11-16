// Engine Review C9, Build 1 fix 1 — regression tests for the two MUSTs
// (Pass 1) and SHOULD 2 (single-year pricer). Fictional sample household
// only — every expected value is hand-computed (see the comments) or pinned
// from an independent recomputation in the probe logs.
//
// MUST 1 (taxEngine.ts top-up): the W1-B2 top-up is a distribution out of
// the conversion — it can only distribute Roth dollars that are actually
// there at the reprice point. The remainder of the reprice-delta tax stays
// on the Taxable / debitUnpaid path and lands in unpaidTax honestly.
// MUST 2 (taxEngine.ts withholding): the withheld part of a conversion is
// a distribution from the distributing plan, so §72(t)(2)(A)(v) shelters
// it up to the conversion's eligible share — penalty only on the
// ineligible remainder, grossed up on that remainder. Unanswered
// eligibility still prices the full penalty (the landing default).
import { describe, test, expect } from "bun:test";
import {
  priceYear,
  simulateRothPlan,
  type RothPlanInputs,
} from "./taxEngine";
import {
  buildRothFunding,
  pricePlaygroundYear,
  type PlaygroundYearInputs,
} from "./rothOptimizer";
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

// 2026 MFJ 22% bracket top (taxLaw.ts TAX_LAW_2026 brackets mfj[2]).
const BRACKET_22_TOP_MFJ_2026 = 211_400;

const yearOf = (res: ReturnType<typeof simulateRothPlan>, year: number) =>
  res.years.find((y) => y.year === year)!;

const SOURCES = [
  "ssCents",
  "rmdCents",
  "otherIncomeCents",
  "taxExemptCents",
  "interestYieldCents",
  "dividendYieldCents",
  "pretaxDrawCents",
  "taxableSoldForSpendingCents",
  "taxableSoldForTaxCents",
  "cashSpendCents",
  "rothDrawCents",
  "salarySurplusCents",
] as const;

function fundingResidueCents(row: Record<string, number>): number {
  const sources = SOURCES.reduce((s, k) => s + (row[k] ?? 0), 0);
  return (
    (row.totalNeedCents ?? 0) -
    sources -
    (row.spendShortfallCents ?? 0) -
    (row.unpaidTaxCents ?? 0)
  );
}

// The MUST 1 shape (reviewer's reproduction): pretax $200k / $0, Roth $0,
// taxable $50k at 50% basis, HSA $0, spending $280k/yr, retirement 55, 5%,
// SS $0, draw order pretax–taxable–roth, payTaxFrom conversion, FILL22,
// window 55–59, eligibility unanswered. The conversion's $170,631.11 Roth
// inflow is fully spent on spending, so rothBal is $0 at the reprice.
function must1Inputs(overrides: Partial<RothPlanInputs> = {}): RothPlanInputs {
  return samplePlanInputs({
    birthYearPrimary: 1971, // 55 in 2026
    birthYearSpouse: 1973, // 53 in 2026
    endAgePrimary: 95,
    pretaxStart: 200_000,
    pretaxSpouseStart: 0,
    rothStart: 0,
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

describe("C9 fix 1 — MUST 1: top-up capped at the Roth balance actually there", () => {
  test("exhausted Roth: top-up is $0, delta tax lands in unpaidTax, identity closes", () => {
    const inputs = must1Inputs();
    const res = simulateRothPlan(inputs, FILL22 as never);
    const y26 = yearOf(res, 2026);
    // Opening withholding $29,368.89 (tax $26,432 + penalty $2,936.89)
    // is the only distribution that happened: the top-up had no Roth
    // dollars to distribute, so it prices $0 penalty and $0 tax.
    // (Engine Review C9, Build 2 — W3: the year's penalty is no
    // longer the withholding penalty alone. Roth starts at $0, so
    // its ledger is KNOWN by construction and the conversion lot
    // the march appends ($170,631.11 reaching Roth) is a known lot:
    // the spending draw withdraws the whole lot the same year at
    // 55, so 10% × $170,631.11 = $17,063.11 joins the $2,936.89 —
    // $20,000.00 in all, 10% of the whole $200,000 conversion,
    // every dollar penalized exactly once. The bill is $30,182 +
    // $20,000 = $50,182, paid $29,368.89, unpaid $20,813.11.)
    expect(y26.conversion).toBe(200_000);
    expect(y26.federalTax).toBe(30_182);
    expect(y26.penalty).toBe(20000);
    expect(y26.pretaxEnd).toBe(0);
    expect(y26.rothEnd).toBe(0);
    expect(y26.taxableEnd).toBe(0);
    expect(y26.hsaEnd).toBe(0);
    // Spending shortfall unchanged ($280,000 − $220,631.11 funded).
    expect(y26.spendShortfall).toBe(59368.89);
    // The reprice-delta tax ($3,750 on the $25,000 taxable-sale gains)
    // could not be carried by the conversion and Taxable was empty, so
    // it lands in unpaidTax honestly — and so does the Roth-draw
    // penalty ($17,063.11), which no pool remains to pay: the bill is
    // $30,182 + $20,000 = $50,182, paid $29,368.89, unpaid $20,813.11.
    // (Before the fix the year reported unpaidTax $0 while recording
    // the $4,166.67 top-up as paid from nothing.)
    expect(y26.unpaidTax).toBe(20813.11);

    const f26 = buildRothFunding(inputs, FILL22 as never).find(
      (r) => r.year === 2026,
    )!;
    expect(fundingResidueCents(f26 as unknown as Record<string, number>)).toBe(0);

    // Balance identity, W2 §8 style: closing total ==
    // (opening total − funded needs) × 1.05. Funded needs are the
    // full $250,000 opening (spending $280,000 + bill $50,182 −
    // shortfall $59,368.89 − unpaid $20,813.11), so the close is $0.
    const openingTotal = 200_000 + 0 + 50_000 + 0;
    const fundedNeeds =
      (f26.totalNeedCents - f26.spendShortfallCents - f26.unpaidTaxCents) / 100;
    expect(fundedNeeds).toBe(250_000);
    const actualClose =
      y26.pretaxEnd + y26.rothEnd + y26.taxableEnd + y26.hsaEnd;
    expect(Math.abs(actualClose - (openingTotal - fundedNeeds) * 1.05)).toBeLessThanOrEqual(
      0.1,
    );
  });

  test("partial Roth: top-up capped at $1,631.11, remainder unpaid, identity closes", () => {
    // rothStart $61,000: Roth at the reprice is
    // $61,000 + $170,631.11 inflow − $230,000 spending draw = $1,631.11.
    const inputs = must1Inputs({ rothStart: 61_000 });
    const res = simulateRothPlan(inputs, FILL22 as never);
    const y26 = yearOf(res, 2026);
    // Top-up distribution capped at $1,631.11: penalty 10% × $1,631.11
    // = $163.11, tax $1,468.00 — so the year's penalty is the opening
    // $2,936.89 + $163.11 = $3,100.00, and the remaining delta tax
    // ($3,750 − $1,468 = $2,282) lands in unpaidTax.
    expect(y26.conversion).toBe(200_000);
    expect(y26.federalTax).toBe(30_182);
    expect(y26.penalty).toBe(3100);
    expect(y26.spendShortfall).toBe(0);
    expect(y26.unpaidTax).toBe(2282);

    const f26 = buildRothFunding(inputs, FILL22 as never).find(
      (r) => r.year === 2026,
    )!;
    expect(fundingResidueCents(f26 as unknown as Record<string, number>)).toBe(0);
    // Opening $311,000; funded needs $311,000 (spending $280,000 +
    // bill $33,282 − unpaid $2,282); close $0.
    const openingTotal = 200_000 + 61_000 + 50_000 + 0;
    const fundedNeeds =
      (f26.totalNeedCents - f26.spendShortfallCents - f26.unpaidTaxCents) / 100;
    expect(fundedNeeds).toBe(311_000);
    const actualClose =
      y26.pretaxEnd + y26.rothEnd + y26.taxableEnd + y26.hsaEnd;
    expect(Math.abs(actualClose - (openingTotal - fundedNeeds) * 1.05)).toBeLessThanOrEqual(
      0.1,
    );
  });
});

describe("C9 fix 1 — MUST 2: withholding penalty shelters on answered eligibility", () => {
  test("fully-eligible conversion: penalty $0; unanswered: full penalty (landing default)", () => {
    const unanswered = simulateRothPlan(
      samplePlanInputs({
        retirementAge: 55,
        windowStartAge: 55,
        windowStopAge: 59,
        payTaxFrom: "conversion",
      }),
      FILL22 as never,
    );
    const eligible = simulateRothPlan(
      samplePlanInputs({
        retirementAge: 55,
        windowStartAge: 55,
        windowStopAge: 59,
        payTaxFrom: "conversion",
        pretax401kEligiblePrimary: 1_500_000,
        separationAgePrimary: 55,
      }),
      FILL22 as never,
    );
    for (const yr of [2026, 2027]) {
      const u = yearOf(unanswered, yr);
      const e = yearOf(eligible, yr);
      // Unanswered: the landing default, pinned to the cent.
      expect(u.penalty).toBe(yr === 2026 ? 3315.78 : 3295.76);
      expect(u.earlyWithdrawalEligibilityUnknown).toBe(false);
      // Answered-eligible: the withheld distribution shelters up to
      // the conversion's eligible share — the fully-eligible
      // conversion prices $0 penalty in both years.
      expect(e.penalty).toBe(0);
      expect(e.earlyWithdrawalEligibilityUnknown).toBe(false);
    }
    // The shelter moves no other figure on this shape: the conversion
    // and federal tax are identical with and without the answer.
    expect(yearOf(eligible, 2026).conversion).toBe(
      yearOf(unanswered, 2026).conversion,
    );
    expect(yearOf(eligible, 2026).federalTax).toBe(
      yearOf(unanswered, 2026).federalTax,
    );
  });

  test("partial opening shelter: penalty grossed up on the ineligible remainder only", () => {
    // Eligible $10k on the control shape: the 2026 withheld tax is
    // $29,842, so the penalty is ($29,842 − $10,000) / 9 = $2,204.67
    // (vs $3,315.78 unanswered). In 2027 the eligible ledger is
    // exhausted — the 2026 conversion ($150,100) consumed the $10k
    // eligible-first — so the full penalty prices again.
    const res = simulateRothPlan(
      samplePlanInputs({
        retirementAge: 55,
        windowStartAge: 55,
        windowStopAge: 59,
        payTaxFrom: "conversion",
        pretax401kEligiblePrimary: 10_000,
        separationAgePrimary: 55,
      }),
      FILL22 as never,
    );
    expect(yearOf(res, 2026).penalty).toBe(2204.67);
    expect(yearOf(res, 2026).earlyWithdrawalEligibilityUnknown).toBe(false);
    expect(yearOf(res, 2027).penalty).toBe(3295.76);
  });

  test("partial top-up shelter: case-4 shape, eligible $20k primary", () => {
    // Case-4 (pretax-first, FILL22, payTaxFrom conversion): the
    // spending draw is $180,000 from pre-tax, and the conversion
    // consumes the $20,000 eligible dollars first — so the draw's
    // penalty is 10% × $180,000 = $18,000, and the withholding
    // penalty is 10% × (withheld distribution − $20,000).
    const inputs = samplePlanInputs({
      retirementAge: 55,
      windowStartAge: 55,
      windowStopAge: 59,
      drawOrder: ["pretax", "taxable", "roth"],
      payTaxFrom: "conversion",
      pretaxStart: 1_000_000,
      pretaxSpouseStart: 500_000,
      pretax401kEligiblePrimary: 20_000,
      pretax401kEligibleSpouse: 0,
      separationAgePrimary: 55,
      separationAgeSpouse: 55,
    });
    const res = simulateRothPlan(inputs, FILL22 as never);
    const y26 = yearOf(res, 2026);
    const y27 = yearOf(res, 2027);
    // 2026: the whole $34,300 conversion was withheld, so the
    // withholding penalty is 10% × ($34,300 − $20,000) = $1,430;
    // total $18,000 + $1,430 = $19,430 (vs $3,875.78 withholding
    // alone unanswered — the spending-draw penalty there is $0
    // because the eligibility was unanswered).
    expect(y26.penalty).toBe(19_430);
    expect(y26.earlyWithdrawalEligibilityUnknown).toBe(false);
    expect(y26.taxableIncome).toBeLessThanOrEqual(
      BRACKET_22_TOP_MFJ_2026 + 0.005,
    );
    // The funding row decomposes the withholding: the pre-tax tax
    // leg minus the pre-tax spending draw IS the withheld
    // distribution ($34,300), and the penalty on it is exactly
    // 10% of its ineligible remainder.
    const f26 = buildRothFunding(inputs, FILL22 as never).find(
      (r) => r.year === 2026,
    )!;
    const withheldTotal =
      f26.pretaxDrawCents / 100 - y26.detail.pretaxSpendingDraw;
    expect(withheldTotal).toBe(34_300);
    expect(0.1 * (withheldTotal - 20_000)).toBeCloseTo(1430, 2);
    // 2027: the eligible ledger is exhausted, so the withholding
    // penalty is 10% × the $31,100 conversion = $3,110, on top of
    // the $18,000 spending-draw penalty.
    expect(y27.penalty).toBe(21_110);
    expect(y27.taxableIncome).toBeLessThanOrEqual(
      BRACKET_22_TOP_MFJ_2026 + 0.005,
    );
  });

  test("separation gate: sep 54 never shelters the withholding", () => {
    // Eligible $1.5M but separated at 54 — the Rule of 55 never
    // applies, so the withholding penalty is the full unanswered
    // figure in both years.
    const res = simulateRothPlan(
      samplePlanInputs({
        retirementAge: 55,
        windowStartAge: 55,
        windowStopAge: 59,
        payTaxFrom: "conversion",
        pretax401kEligiblePrimary: 1_500_000,
        separationAgePrimary: 54,
      }),
      FILL22 as never,
    );
    expect(yearOf(res, 2026).penalty).toBe(3315.78);
    expect(yearOf(res, 2027).penalty).toBe(3295.76);
  });
});

function pgBase(overrides: Partial<PlaygroundYearInputs> = {}): PlaygroundYearInputs {
  return {
    taxYear: 2026,
    filingStatus: "mfj",
    agePrimary: 55,
    ageSpouse: 53,
    onMedicarePrimary: false,
    onMedicareSpouse: false,
    interest: 0,
    ordinaryDividends: 0,
    otherOrdinary: 0,
    taxExemptInterest: 0,
    ssPrimary: 0,
    ssSpouse: 0,
    conversion: 0,
    spendingDraw: 0,
    stockSold: 0,
    stockBasis: 0,
    qualifiedDividends: 0,
    pretaxBalance: 1_500_000,
    spouseSoleBeneficiary: false,
    acaHouseholdSize: 2,
    acaBenchmarkAnnual: null,
    stateRatePct: 0,
    ...overrides,
  };
}

describe("C9 fix 1 — SHOULD 2: single-year pricer prices the draw penalty", () => {
  test("unanswered eligibility: $0 penalty with the flag set", () => {
    const r = pricePlaygroundYear(pgBase({ spendingDraw: 150_000 }));
    expect(r.earlyWithdrawalPenalty).toBe(0);
    expect(r.earlyWithdrawalEligibilityUnknown).toBe(true);
    expect(r.totalTax).toBe(r.federalTax + r.stateTax);
    expect(r.netTaxBill).toBe(r.totalTax - r.educationRefundable);
  });

  test("answered ineligible (eligible $0): penalty prices, flag off, bill carries it", () => {
    const r = pricePlaygroundYear(
      pgBase({
        spendingDraw: 150_000,
        pretax401kEligiblePrimary: 0,
        separationAgePrimary: 55,
      }),
    );
    expect(r.earlyWithdrawalPenalty).toBe(15_000);
    expect(r.earlyWithdrawalEligibilityUnknown).toBe(false);
    // The penalty is an additional tax liability: the net bill is
    // totalTax + penalty − refundable education credit.
    expect(r.netTaxBill).toBe(r.totalTax + 15_000 - r.educationRefundable);
    expect(r.cashLeftAfterTax).toBe(r.cashIn - r.netTaxBill);
  });

  test("answered mixed (eligible $100k of a $150k draw): penalty on the $50k remainder", () => {
    const r = pricePlaygroundYear(
      pgBase({
        spendingDraw: 150_000,
        pretax401kEligiblePrimary: 100_000,
        separationAgePrimary: 55,
      }),
    );
    expect(r.earlyWithdrawalPenalty).toBe(5_000);
    expect(r.earlyWithdrawalEligibilityUnknown).toBe(false);
  });

  test("answered fully eligible: $0 penalty, flag off", () => {
    const r = pricePlaygroundYear(
      pgBase({
        spendingDraw: 150_000,
        pretax401kEligiblePrimary: 1_500_000,
        separationAgePrimary: 55,
      }),
    );
    expect(r.earlyWithdrawalPenalty).toBe(0);
    expect(r.earlyWithdrawalEligibilityUnknown).toBe(false);
  });

  test("separation gate: sep 54 and sep 57 at age 55 price the full penalty", () => {
    for (const sep of [54, 57]) {
      const r = pricePlaygroundYear(
        pgBase({
          spendingDraw: 150_000,
          pretax401kEligiblePrimary: 1_500_000,
          separationAgePrimary: sep,
        }),
      );
      expect(r.earlyWithdrawalPenalty).toBe(15_000);
      expect(r.earlyWithdrawalEligibilityUnknown).toBe(false);
    }
  });

  test("conversion carries no penalty; post-59½ draw carries none", () => {
    const conv = pricePlaygroundYear(pgBase({ conversion: 150_000 }));
    expect(conv.earlyWithdrawalPenalty).toBe(0);
    expect(conv.earlyWithdrawalEligibilityUnknown).toBe(false);
    const old = pricePlaygroundYear(
      pgBase({
        agePrimary: 60,
        ageSpouse: 58,
        spendingDraw: 150_000,
        pretax401kEligiblePrimary: 0,
        separationAgePrimary: 55,
      }),
    );
    expect(old.earlyWithdrawalPenalty).toBe(0);
    expect(old.earlyWithdrawalEligibilityUnknown).toBe(false);
  });

  test("spouse's share is tested on her own age (primary 60, spouse 58)", () => {
    // Primary balance $100k, spouse balance $1M, draw $150k: the draw
    // splits primary-first — $100k from the primary (60, no penalty)
    // and $50k from the spouse (58, eligible $0 → $5,000 penalty).
    const r = pricePlaygroundYear(
      pgBase({
        agePrimary: 60,
        ageSpouse: 58,
        pretaxBalance: 100_000,
        pretaxBalanceSpouse: 1_000_000,
        spendingDraw: 150_000,
        pretax401kEligiblePrimary: 0,
        pretax401kEligibleSpouse: 0,
        separationAgePrimary: 55,
        separationAgeSpouse: 55,
      }),
    );
    expect(r.earlyWithdrawalPenalty).toBe(5_000);
    expect(r.earlyWithdrawalEligibilityUnknown).toBe(false);
  });

  test("no balance entered: draw is unattributable — $0 with the flag set", () => {
    const r = pricePlaygroundYear(
      pgBase({ spendingDraw: 150_000, pretaxBalance: null }),
    );
    expect(r.earlyWithdrawalPenalty).toBe(0);
    expect(r.earlyWithdrawalEligibilityUnknown).toBe(true);
  });

  test("priceYear directly: penalty on the draw dial, never on the conversion dial", () => {
    const base = {
      calendarYear: 2026,
      filingStatus: "mfj" as const,
      agePrimary: 55,
      ageSpouse: 53 as number | null,
      otherOrdinary: 0,
      rmd: 0,
      conversion: 0,
      extraPreTaxDraw: 150_000,
      ssBenefits: 0,
      taxExemptInterest: 0,
      ltcg: 0,
      inflationPct: 0,
      stateRatePct: 0,
    };
    const penalized = priceYear({
      ...base,
      pretax401kEligiblePrimary: 100_000,
      pretax401kEligibleSpouse: null,
      separationAgePrimary: 55,
      separationAgeSpouse: null,
      extraPreTaxDrawPrimary: 150_000,
      extraPreTaxDrawSpouse: 0,
    });
    expect(penalized.earlyWithdrawalPenalty).toBe(5_000);
    expect(penalized.earlyWithdrawalEligibilityUnknown).toBe(false);
    // The penalty sits BESIDE the tax, never inside it.
    expect(penalized.federalTax).toBe(
      priceYear({ ...base }).federalTax,
    );
    const conversionOnly = priceYear({
      ...base,
      conversion: 150_000,
      extraPreTaxDraw: 0,
    });
    expect(conversionOnly.earlyWithdrawalPenalty).toBe(0);
    expect(conversionOnly.earlyWithdrawalEligibilityUnknown).toBe(false);
    // No eligibility facts at all: the march's priceWith shape —
    // $0 with the flag set on a pre-59½ draw, $0 / false otherwise.
    const unanswered = priceYear({ ...base });
    expect(unanswered.earlyWithdrawalPenalty).toBe(0);
    expect(unanswered.earlyWithdrawalEligibilityUnknown).toBe(true);
  });
});
