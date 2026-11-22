// Core engine review 2026-11-21, Build 2 (M-3 + S-14 + N-23/N-27)
// — pre-2025 Playground law.
//
// STANDARD: every expected figure below is hand-derived in the
// test's own note (plain arithmetic on the published sources —
// HHS poverty guidelines 2022 (87 FR 3315) and 2023 (88 FR 3424),
// Rev. Proc. 2023-29 §2.01 (2024 §36B table), IRC §164(b)(6)
// pre-OBBBA, and the 2025 law row) — never a copied engine
// print. The engine is called only to PRODUCE the figure under
// test; the expectation is computed by hand beside it. All cases
// use invented figures (the $12,000 benchmarks are the review
// probe's invented figures); none describes any real household.
//
// Run per-file (whole-suite bun test in one process OOMs on this
// VM): bun test server/src/reviewCoreBuild2Pre2025.test.ts

import { describe, test, expect } from "bun:test";
import { acaCreditFor, priceYear, type PriceYearInput } from "./taxEngine";
import { acaTableFor, fplFor, saltScheduleForYear } from "./taxLaw";

// One ordinary-income year, MFJ, no Social Security, no gains,
// no itemized inputs, no state rate — everything else defaults
// to the pre-yield pricing (mirrors review3Tax's base()).
const base = (over: Partial<PriceYearInput> = {}): PriceYearInput => ({
  calendarYear: 2026,
  filingStatus: "mfj",
  agePrimary: 58,
  ageSpouse: 56,
  otherOrdinary: 0,
  rmd: 0,
  conversion: 0,
  extraPreTaxDraw: 0,
  ssBenefits: 0,
  taxExemptInterest: 0,
  ltcg: 0,
  inflationPct: 0,
  stateRatePct: 0,
  ...over,
});

describe("M-3: pre-2025 coverage years price ACA on the 2025 table, never 2026 law", () => {
  test("2024 coverage, HH2, MAGI $84,000, benchmark $12,000 → credit $4,860.00", () => {
    // Hand check: 2024 coverage uses the 2023 guidelines
    // (88 FR 3424): FPL for a household of 2 = $19,720, so
    // $84,000 is 425.96% of FPL. The 2024 table is the
    // enhanced schedule (Rev. Proc. 2023-29 §2.01, identical
    // to 2025's): flat 8.5% above 400% FPL, no cliff pre-2026.
    // Expected contribution 8.5% x $84,000 = $7,140; credit
    // $12,000 - $7,140 = $4,860. (Pre-fix the engine priced
    // this on 2026 law — FPL $21,640, 9.96% — at $3,633.60.)
    const r = acaCreditFor({ magi: 84000, householdSize: 2, coverageYear: 2024, benchmarkAnnual: 12000 });
    expect(r.fpl).toBe(19720);
    expect(r.applicablePct).toBe(8.5);
    expect(r.overCliff).toBe(false);
    expect(r.credit).toBe(4860);
  });

  test("2024 coverage, HH2, MAGI $87,000, benchmark $12,000 → credit $4,605.00", () => {
    // Hand check: same FPL $19,720; $87,000 is 441.18% of
    // FPL → 8.5% flat; expected 8.5% x $87,000 = $7,395;
    // credit $12,000 - $7,395 = $4,605. (Pre-fix: $3,334.80.)
    const r = acaCreditFor({ magi: 87000, householdSize: 2, coverageYear: 2024, benchmarkAnnual: 12000 });
    expect(r.fpl).toBe(19720);
    expect(r.applicablePct).toBe(8.5);
    expect(r.overCliff).toBe(false);
    expect(r.credit).toBe(4605);
  });

  test("2023 coverage prices on the 2022 guidelines and the 2025 table", () => {
    // Hand check: 2023 coverage uses the 2022 guidelines
    // (87 FR 3315): FPL for a household of 2 = $18,310, so
    // $85,000 is 464.23% of FPL → 8.5% flat (the temporary
    // §36B(b)(3)(A)(iii) percentages apply for 2021–2025);
    // expected 8.5% x $85,000 = $7,225; credit
    // $12,000 - $7,225 = $4,775.
    const r = acaCreditFor({ magi: 85000, householdSize: 2, coverageYear: 2023, benchmarkAnnual: 12000 });
    expect(r.fpl).toBe(18310);
    expect(r.applicablePct).toBe(8.5);
    expect(r.overCliff).toBe(false);
    expect(r.credit).toBe(4775);
  });

  test("fplFor falls back directionally: oldest row before the table, newest row after it", () => {
    // 2022 row: HH2 = $13,590 + $4,720 = $18,310 (87 FR 3315).
    // 2023 row: HH2 = $14,580 + $5,140 = $19,720 (88 FR 3424).
    // 2026 row: HH2 = $15,960 + $5,680 = $21,640.
    expect(fplFor(2, 2022)).toBe(18310);
    expect(fplFor(2, 2023)).toBe(19720);
    expect(fplFor(2, 2021)).toBe(18310);
    expect(fplFor(2, 2030)).toBe(21640);
  });

  test("acaTableFor falls back to the 2025 table before 2025 and the 2026 row after 2027", () => {
    // 2025 row's last band: 300–400%, 6.0% → 8.5%.
    // 2026 row's last band: 300–400%, 9.96% → 9.96%.
    expect(acaTableFor(2024)[5]).toEqual({ upToPctFpl: 400, initialPct: 6, finalPct: 8.5 });
    expect(acaTableFor(2020)[5]).toEqual({ upToPctFpl: 400, initialPct: 6, finalPct: 8.5 });
    expect(acaTableFor(2024, { projected: true })[5]).toEqual({ upToPctFpl: 400, initialPct: 6, finalPct: 8.5 });
    expect(acaTableFor(2028)[5]).toEqual({ upToPctFpl: 400, initialPct: 9.96, finalPct: 9.96 });
  });
});

describe("S-14: pre-2025 years price the $10,000 flat SALT cap, not the 2025 $40,000 cap", () => {
  test("2024 MFJ, $200,000 ordinary, $60,000 SALT paid → federal tax $26,898", () => {
    // Hand check: the pre-OBBBA cap is $10,000 flat
    // (§164(b)(6)), so the itemized total is $10,000 — below
    // the 2025 standard deduction $31,500, so the standard
    // side wins. Taxable $200,000 - $31,500 = $168,500 on the
    // 2025 MFJ brackets (the documented oldest-row
    // convention): 10% x $23,850 = $2,385; 12% x $73,100 =
    // $8,772; 22% x $71,550 = $15,741; total $26,898.
    // (Pre-fix the $40,000 cap made itemized win and priced
    // $25,028 — bit-identical to 2025. The $1,870 SALT leg is
    // exactly the fix; the remaining $784 to true-2024-law
    // $27,682 is the 2025 brackets/deduction under the
    // documented oldest-row convention, not this fix.)
    const p = priceYear(base({ calendarYear: 2024, otherOrdinary: 200000, itemizedSaltPaid: 60000 }));
    expect(p.itemizedSaltCap).toBe(10000);
    expect(p.itemizedSaltAllowed).toBe(10000);
    expect(p.deductionTaken).toBe("standard");
    expect(p.taxableIncome).toBe(168500);
    expect(p.federalTax).toBe(26898);
  });

  test("2023 prices the same pre-2025 entry, and 2025 is unchanged", () => {
    const p23 = priceYear(base({ calendarYear: 2023, otherOrdinary: 200000, itemizedSaltPaid: 60000 }));
    expect(p23.itemizedSaltCap).toBe(10000);
    expect(p23.federalTax).toBe(26898);
    // Control: 2025 still prices the $40,000 OBBBA cap and
    // itemized wins — $25,028, exactly as before this build.
    const p25 = priceYear(base({ calendarYear: 2025, otherOrdinary: 200000, itemizedSaltPaid: 60000 }));
    expect(p25.itemizedSaltCap).toBe(40000);
    expect(p25.itemizedSaltAllowed).toBe(40000);
    expect(p25.deductionTaken).toBe("itemized");
    expect(p25.federalTax).toBe(25028);
  });

  test("saltScheduleForYear dates the pre-2025 entry at 2024", () => {
    const e24 = saltScheduleForYear(2024);
    expect(e24.cap).toBe(10000);
    expect(e24.capFloor).toBe(10000);
    expect(e24.phaseOutRatePct).toBe(0);
    expect(e24.entryYear).toBe(2024);
    const e23 = saltScheduleForYear(2023);
    expect(e23.cap).toBe(10000);
    expect(e23.entryYear).toBe(2024);
    const e25 = saltScheduleForYear(2025);
    expect(e25.cap).toBe(40000);
    expect(e25.entryYear).toBe(2025);
    const e30 = saltScheduleForYear(2030);
    expect(e30.cap).toBe(10000);
    expect(e30.entryYear).toBe(2030);
  });
});
