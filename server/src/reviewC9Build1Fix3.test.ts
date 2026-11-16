// Engine Review C9, Build 1 fix 3 — regression tests for the Pass 1c
// SHOULD (Playground sale-after-tax line vs refundable credit / APTC
// settlement). Fictional sample household only — every expected value
// is hand-derived IN THIS FILE from the 2026 MFJ law row (std
// deduction $32,200; brackets 10% to $24,800, 12% to $100,800, 22% to
// $211,400; LTCG 0% top $98,900), except the ACA final credit in the
// credit-still-due shape, which is the engine's own ACA pricing
// (FPL / applicable-percentage tables) and is pinned here from
// execution, with the divergence derived from it by the formula.
//
// THE SHOULD (review-pass1c-report.md): the sale-after-tax line nets
// the TOTAL tax bill (federal + state + penalty) while netTaxBill on
// the same result is the NET bill (total − refundable education credit
// − credit still due + excess APTC repayment), and Fix 2's sentence
// ("this year's total tax") read as the year's net filing outcome.
// Measured divergence, exact in all three shapes:
//   leftover − (proceeds − netTaxBill)
//     = −educationRefundable − creditStillDue + excessAptcRepayment
//
// FIX 3 (option (a), the reviewer's recommended minimal fix): the
// sentence names exactly what the line nets — federal + state tax,
// plus the early-withdrawal penalty when one is priced — and the
// computation comment + PlaygroundSaleAfterTax type doc qualify the
// agreement claim to the no-credit / no-settlement case. No priced
// figure moves; the line's totalTax and leftover are unchanged in
// every shape. These tests pin the divergence in the three measured
// shapes, the qualified sentence in each, and the no-credit /
// no-APTC shape where the leftover still agrees exactly.
import { describe, test, expect } from "bun:test";
import {
  pricePlaygroundYear,
  type PlaygroundYearInputs,
} from "./rothOptimizer";

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

describe("C9 fix 3 — sale-after-tax line names what it nets; credit/settlement scope pinned", () => {
  test("refundable AOTC only: divergence is exactly the credit (−$1,000)", () => {
    // $100,000 ineligible pre-tax draw at 55 + $100,000 sale /
    // $50,000 basis + one AOTC student, $10,000 expenses.
    // Hand-derivation on the 2026 MFJ law row:
    // - AGI $150,000 ($100,000 ordinary + $50,000 gain); MAGI
    //   $150,000, under the $160,000 MFJ AOTC phase-out start, so
    //   the full credit prices. Taxable income $117,800;
    //   ordinary portion $67,800.
    // - Ordinary tax: 10% x $24,800 = $2,480; 12% x $43,000 =
    //   $5,160; total $7,640.
    // - LTCG: 0% room $98,900 − $67,800 = $31,100 at 0%, the
    //   remaining $18,900 at 15% = $2,835. Tax before credits
    //   $7,640 + $2,835 = $10,475.
    // - AOTC $2,500 (100% x $2,000 + 25% x $2,000): the
    //   nonrefundable 60% ($1,500) applies against the $10,475
    //   tax → federal $8,975; the refundable 40% is $1,000.
    // - Penalty 10% x $100,000 = $10,000.
    // - Net bill $8,975 + $10,000 − $1,000 = $17,975. Line
    //   total tax $8,975 + $0 + $10,000 = $18,975 (the credit
    //   is NOT netted); leftover $100,000 − $18,975 = $81,025.
    // - Proceeds − net bill $100,000 − $17,975 = $82,025.
    //   Divergence −$1,000 = −educationRefundable.
    const r = pricePlaygroundYear(
      pgBase({
        spendingDraw: 100_000,
        stockSold: 100_000,
        stockBasis: 50_000,
        pretax401kEligiblePrimary: 0,
        separationAgePrimary: 55,
        educationStudents: [{ expenses: 10_000, aotcEligible: true }],
      }),
    );
    expect(r.federalTax).toBe(8_975);
    expect(r.stateTax).toBe(0);
    expect(r.earlyWithdrawalPenalty).toBe(10_000);
    expect(r.educationNonrefundable).toBe(1_500);
    expect(r.educationRefundable).toBe(1_000);
    expect(r.netTaxBill).toBe(17_975);
    expect(r.netTaxBill).toBe(
      r.totalTax + r.earlyWithdrawalPenalty - r.educationRefundable,
    );
    expect(r.cashLeftAfterTax).toBe(200_000 - 17_975);
    expect(r.saleAfterTax).not.toBeNull();
    const sat = r.saleAfterTax!;
    expect(sat.proceeds).toBe(100_000);
    // The line's total is federal + state + penalty ONLY — the
    // refundable credit is not in it, so the leftover is the
    // credit short of the net-bill cash.
    expect(sat.totalTax).toBe(18_975);
    expect(sat.totalTax).toBe(
      Math.round(r.federalTax) +
        Math.round(r.stateTax) +
        Math.round(r.earlyWithdrawalPenalty),
    );
    expect(sat.leftover).toBe(81_025);
    expect(sat.leftover - (100_000 - r.netTaxBill)).toBe(-1_000);
    expect(sat.leftover - (100_000 - r.netTaxBill)).toBe(
      -r.educationRefundable,
    );
    // The sentence names the three items it nets — federal +
    // state tax and the penalty — and never calls the figure
    // "this year's total tax", so it does not read as the
    // year's net filing outcome.
    expect(sat.text).toBe(
      "Sale brought in $100,000. After federal + state tax and the early-withdrawal penalty of $18,975, $81,025 of it is left.",
    );
    expect(sat.text).not.toContain("this year's total tax");
  });

  test("excess APTC repayment: divergence is −credit + repayment (+$4,000)", () => {
    // The education shape above + APTC taken $5,000, benchmark
    // and enrollment premium $26,000. MAGI $150,000 is OVER the
    // 2026 HH2 cliff ($84,600), so the final allowable credit is
    // $0: credit still due $0, and the whole $5,000 advance is
    // repaid. Net bill = total bill $18,975 − $1,000 refundable
    // credit + $5,000 repayment = $22,975. The line is
    // unchanged (total tax $18,975, leftover $81,025);
    // proceeds − net bill $100,000 − $22,975 = $77,025.
    // Divergence +$4,000 = −$1,000 credit + $5,000 repayment:
    // the line says $4,000 MORE is left than the net bill
    // implies — and the sentence says so only about the three
    // items it names.
    const r = pricePlaygroundYear(
      pgBase({
        spendingDraw: 100_000,
        stockSold: 100_000,
        stockBasis: 50_000,
        pretax401kEligiblePrimary: 0,
        separationAgePrimary: 55,
        educationStudents: [{ expenses: 10_000, aotcEligible: true }],
        acaBenchmarkAnnual: 26_000,
        acaEnrollmentPremiumAnnual: 26_000,
        aptcTaken: 5_000,
      }),
    );
    expect(r.educationRefundable).toBe(1_000);
    expect(r.federalTax).toBe(8_975);
    expect(r.earlyWithdrawalPenalty).toBe(10_000);
    expect(r.netTaxBill).toBe(22_975);
    // The repayment is the whole advance: final credit $0 over
    // the cliff, so net bill − (total bill − refundable) is
    // exactly the $5,000 taken.
    expect(
      r.netTaxBill -
        (r.totalTax + r.earlyWithdrawalPenalty - r.educationRefundable),
    ).toBe(5_000);
    expect(r.cashLeftAfterTax).toBe(200_000 - 22_975);
    expect(r.saleAfterTax).not.toBeNull();
    const sat = r.saleAfterTax!;
    expect(sat.totalTax).toBe(18_975);
    expect(sat.leftover).toBe(81_025);
    expect(sat.leftover - (100_000 - r.netTaxBill)).toBe(4_000);
    expect(sat.leftover - (100_000 - r.netTaxBill)).toBe(
      -r.educationRefundable + 5_000,
    );
    expect(sat.text).toBe(
      "Sale brought in $100,000. After federal + state tax and the early-withdrawal penalty of $18,975, $81,025 of it is left.",
    );
    expect(sat.text).not.toContain("this year's total tax");
  });

  test("APTC credit still due: divergence is −credit still due (−$19,321.53); the year is a refund", () => {
    // Lower-MAGI shape so the final credit EXCEEDS the advance:
    // $50,000 ineligible draw + $20,000 sale / $10,000 basis,
    // MAGI $60,000 (under the cliff), benchmark $26,000/yr,
    // enrollment premium $26,000, APTC taken $1,000.
    // Hand-derivation on the 2026 MFJ law row:
    // - AGI $60,000 ($50,000 ordinary + $10,000 gain); taxable
    //   income $60,000 − $32,200 = $27,800; ordinary portion
    //   $17,800 → 10% x $17,800 = $1,780. The $10,000 gain
    //   sits inside the 0% room ($98,900 − $17,800 = $81,100),
    //   so gains tax $0. Federal $1,780; state $0.
    // - Penalty 10% x $50,000 = $5,000. Total bill $6,780.
    //   Line total tax $6,780; leftover $20,000 − $6,780 =
    //   $13,220.
    // - The net bill is a $12,541.53 REFUND (execution-verified;
    //   the final credit itself is the engine's ACA pricing,
    //   not the law row): credit still due = total bill −
    //   net bill = $6,780 − (−$12,541.53) = $19,321.53, so the
    //   implied final credit is $1,000 taken + $19,321.53 =
    //   $20,321.53. Proceeds − net bill $20,000 − (−$12,541.53)
    //   = $32,541.53. Divergence $13,220 − $32,541.53 =
    //   −$19,321.53 = −credit still due.
    const r = pricePlaygroundYear(
      pgBase({
        spendingDraw: 50_000,
        stockSold: 20_000,
        stockBasis: 10_000,
        pretax401kEligiblePrimary: 0,
        separationAgePrimary: 55,
        acaBenchmarkAnnual: 26_000,
        acaEnrollmentPremiumAnnual: 26_000,
        aptcTaken: 1_000,
      }),
    );
    expect(r.federalTax).toBe(1_780);
    expect(r.stateTax).toBe(0);
    expect(r.earlyWithdrawalPenalty).toBe(5_000);
    expect(r.educationRefundable).toBe(0);
    // The year's net filing outcome is a refund, not a bill.
    expect(r.netTaxBill).toBe(-12_541.53);
    expect(r.netTaxBill).toBeLessThan(0);
    expect(r.cashLeftAfterTax).toBe(70_000 - r.netTaxBill);
    // Credit still due, derived from the settlement's own
    // terms: total bill − net bill (no edu credit, no
    // repayment in this shape).
    const creditStillDue =
      r.totalTax + r.earlyWithdrawalPenalty - r.netTaxBill;
    expect(creditStillDue).toBe(19_321.53);
    // Implied final credit: $1,000 taken + $19,321.53 due.
    expect(1_000 + creditStillDue).toBe(20_321.53);
    expect(r.saleAfterTax).not.toBeNull();
    const sat = r.saleAfterTax!;
    expect(sat.totalTax).toBe(6_780);
    expect(sat.leftover).toBe(13_220);
    expect(sat.proceeds - r.netTaxBill).toBe(32_541.53);
    expect(sat.leftover - (sat.proceeds - r.netTaxBill)).toBe(-19_321.53);
    expect(sat.leftover - (sat.proceeds - r.netTaxBill)).toBe(
      -creditStillDue,
    );
    // The qualified sentence names the three items it nets and
    // does NOT imply the $13,220 is the sale's cash after the
    // net bill — the year's net outcome is a refund, and the
    // sentence says nothing about it.
    expect(sat.text).toBe(
      "Sale brought in $20,000. After federal + state tax and the early-withdrawal penalty of $6,780, $13,220 of it is left.",
    );
    expect(sat.text).not.toContain("this year's total tax");
    expect(sat.text).not.toContain("refund");
  });

  test("no credit, no APTC: the leftover still agrees exactly ($62,160)", () => {
    // The Fix 2 shape — $150,000 ineligible draw + $100,000
    // sale / $50,000 basis, no education credit, no APTC taken:
    // federal $22,840, penalty $15,000, net bill $37,840,
    // leftover $62,160 = proceeds − netTaxBill exactly. This is
    // the case the agreement claim is qualified TO (see the
    // type doc / computation comment): with no credit and no
    // settlement, the line's total tax IS the net bill.
    const r = pricePlaygroundYear(
      pgBase({
        spendingDraw: 150_000,
        stockSold: 100_000,
        stockBasis: 50_000,
        pretax401kEligiblePrimary: 0,
        separationAgePrimary: 55,
      }),
    );
    expect(r.federalTax).toBe(22_840);
    expect(r.earlyWithdrawalPenalty).toBe(15_000);
    expect(r.educationRefundable).toBe(0);
    expect(r.netTaxBill).toBe(37_840);
    expect(r.cashLeftAfterTax).toBe(212_160);
    expect(r.saleAfterTax).not.toBeNull();
    const sat = r.saleAfterTax!;
    expect(sat.totalTax).toBe(37_840);
    expect(sat.leftover).toBe(62_160);
    expect(sat.leftover).toBe(100_000 - r.netTaxBill);
    expect(sat.text).toBe(
      "Sale brought in $100,000. After federal + state tax and the early-withdrawal penalty of $37,840, $62,160 of it is left.",
    );
    expect(sat.text).not.toContain("this year's total tax");
  });
});
