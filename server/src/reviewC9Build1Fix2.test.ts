// Engine Review C9, Build 1 fix 2 — regression tests for the Pass 1b
// SHOULD (Playground sale-after-tax line). Fictional sample household
// only — every expected value is hand-computed from the 2026 MFJ law
// row (see the comments) or pinned from the reviewer's probe shape.
//
// THE SHOULD (review-pass1b-report.md): the sale-after-tax line netted
// federal + state only while the same result's netTaxBill carried the
// §72(t) penalty, so in a penalized year its leftover overstated the
// penalty-inclusive cash by exactly the penalty. Fix 2 nets the penalty
// into the line, so in a year with no refundable education credit and
// no APTC settlement adjustment its leftover agrees with
// cashLeftAfterTax. With either (Fix 3), the line still nets the total
// bill while netTaxBill is the net bill, so the leftover differs from
// proceeds − netTaxBill by exactly −educationRefundable −
// creditStillDue + excessAptcRepayment.
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

describe("C9 fix 2 — sale-after-tax line nets the penalty", () => {
  test("penalized year: leftover is penalty-inclusive ($62,160, not $77,160)", () => {
    // The reviewer's Pass 1b shape: $150,000 ineligible pre-tax draw
    // at 55 + $100,000 stock sale / $50,000 basis.
    // Hand-derivation on the 2026 MFJ law row (std deduction $32,200;
    // brackets 10% to $24,800, 12% to $100,800, 22% to $211,400;
    // LTCG 0% top $98,900):
    // - AGI $200,000 ($150,000 ordinary + $50,000 gain); taxable
    //   income $167,800; ordinary portion $117,800.
    // - Ordinary tax: 10% x $24,800 = $2,480; 12% x $76,000 =
    //   $9,120; 22% x $17,000 = $3,740; total $15,340.
    // - LTCG: the ordinary portion already exceeds the $98,900 0%
    //   top, so all $50,000 at 15% = $7,500.
    // - Federal $15,340 + $7,500 = $22,840; state $0.
    // - Penalty 10% x $150,000 = $15,000.
    // - Net bill $22,840 + $0 + $15,000 - $0 refundable = $37,840.
    // - Cash in $150,000 draw + $100,000 sale = $250,000; cash left
    //   $250,000 - $37,840 = $212,160.
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
    expect(r.stateTax).toBe(0);
    expect(r.earlyWithdrawalPenalty).toBe(15_000);
    expect(r.earlyWithdrawalEligibilityUnknown).toBe(false);
    expect(r.totalTax).toBe(22_840);
    expect(r.netTaxBill).toBe(37_840);
    expect(r.netTaxBill).toBe(
      r.totalTax + r.earlyWithdrawalPenalty - r.educationRefundable,
    );
    expect(r.cashIn).toBe(250_000);
    expect(r.cashLeftAfterTax).toBe(212_160);
    expect(r.cashLeftAfterTax).toBe(r.cashIn - r.netTaxBill);
    expect(r.saleAfterTax).not.toBeNull();
    const sat = r.saleAfterTax!;
    expect(sat.proceeds).toBe(100_000);
    // The line's "total tax" is now the penalty-inclusive bill.
    expect(sat.totalTax).toBe(37_840);
    expect(sat.totalTax).toBe(
      Math.round(r.federalTax) +
        Math.round(r.stateTax) +
        Math.round(r.earlyWithdrawalPenalty),
    );
    expect(sat.leftover).toBe(62_160);
    // The leftover agrees with cashLeftAfterTax on this shape
    // (no refundable credit, no APTC settlement — the only case
    // the agreement holds; C9 fix 3): the sale's share of the
    // year's cash after the tax the line nets.
    expect(sat.leftover).toBe(100_000 - r.netTaxBill);
    expect(sat.leftover).not.toBe(77_160); // pre-fix, penalty excluded
    expect(sat.text).toBe(
      "Sale brought in $100,000. After federal + state tax and the early-withdrawal penalty of $37,840, $62,160 of it is left.",
    );
  });

  test("zero-penalty control: the line is unchanged ($77,160)", () => {
    // Same shape, fully eligible draw — penalty $0, so the line
    // nets federal + state only, and the sentence names just
    // those two (no penalty to name). Figures identical to
    // before fix 2; the wording is the fix 3 form.
    const r = pricePlaygroundYear(
      pgBase({
        spendingDraw: 150_000,
        stockSold: 100_000,
        stockBasis: 50_000,
        pretax401kEligiblePrimary: 1_500_000,
        separationAgePrimary: 55,
      }),
    );
    expect(r.earlyWithdrawalPenalty).toBe(0);
    expect(r.netTaxBill).toBe(22_840);
    expect(r.saleAfterTax).not.toBeNull();
    const sat = r.saleAfterTax!;
    expect(sat.totalTax).toBe(22_840);
    expect(sat.leftover).toBe(77_160);
    expect(sat.leftover).toBe(100_000 - r.netTaxBill);
    expect(sat.text).toBe(
      "Sale brought in $100,000. After federal + state tax of $22,840, $77,160 of it is left.",
    );
  });

  test("penalized year, tax exceeds the proceeds: negative branch nets the penalty too", () => {
    // Same penalized draw, but only a $10,000 sale: the year's total
    // tax ($37,840) exceeds the proceeds by $27,840, and the sentence
    // must say so with the penalty-inclusive figure.
    const r = pricePlaygroundYear(
      pgBase({
        spendingDraw: 150_000,
        stockSold: 10_000,
        stockBasis: 10_000,
        pretax401kEligiblePrimary: 0,
        separationAgePrimary: 55,
      }),
    );
    expect(r.earlyWithdrawalPenalty).toBe(15_000);
    expect(r.saleAfterTax).not.toBeNull();
    const sat = r.saleAfterTax!;
    expect(sat.proceeds).toBe(10_000);
    // No gain on the $10,000 break-even sale: federal is the ordinary
    // tax alone — 10% x $24,800 + 12% x $76,000 + 22% x $17,000 =
    // $15,340 — so the bill is $15,340 + $15,000 = $30,340.
    expect(r.federalTax).toBe(15_340);
    expect(r.netTaxBill).toBe(30_340);
    expect(sat.totalTax).toBe(30_340);
    expect(sat.leftover).toBe(10_000 - 30_340);
    expect(sat.text).toBe(
      "Sale brought in $10,000. Federal + state tax and the early-withdrawal penalty come to $30,340 — $20,340 more than the sale brought in.",
    );
  });
});
