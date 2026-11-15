// Engine Review 3 (§4 + §5) — independent federal-tax verification
// and tax-identity / cross-engine tests.
//
// STANDARD: every expected figure below is hand-derived in the
// test's own note (plain arithmetic on the published law-row
// literals from IRS Rev. Proc. 2024-40 (2025) and Rev. Proc.
// 2025-32 (2026), OBBBA §§70107 / 70120, IRC §§86 / 1411 /
// 164(b)(7) / 25A / 55, and RCW 82.87) — never a copied engine
// print. The engine is called only to PRODUCE the figure under
// test; the expectation is computed by hand beside it. All
// cases use the shared fictional sample household
// (server/src/sampleHousehold.ts) where a household is needed,
// and inflationPct 0 unless the case is about deflation (so the
// deflation factor is 1 and the published figures price exactly).
//
// Run per-file (whole-suite bun test in one process OOMs on this
// VM): bun test server/src/review3Tax.test.ts

import { describe, test, expect } from "bun:test";
import {
  priceYear,
  type PriceYearInput,
} from "./taxEngine";
import {
  TAX_LAW_2027_NOTE,
  lawProvenanceForYear,
} from "./taxLaw";
import {
  pricePlaygroundYear,
  type PlaygroundYearInputs,
} from "./rothOptimizer";
import { priceOneWorkYear } from "./workYears";
import { samplePlanInputs } from "./sampleHousehold";

// One ordinary-income year, 2026 MFJ, no Social Security, no
// gains, no itemized inputs, no state rate — everything else
// defaults to the pre-yield pricing.
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

// One single-year Playground year, 2026 MFJ, no balances (so no
// RMD prices), no ACA facts — the year prices on its dials alone.
const pgBase = (over: Partial<PlaygroundYearInputs> = {}): PlaygroundYearInputs => ({
  taxYear: 2026,
  filingStatus: "mfj",
  agePrimary: 58,
  ageSpouse: 56,
  onMedicarePrimary: false,
  onMedicareSpouse: false,
  interest: 0,
  ordinaryDividends: 0,
  qualifiedDividends: 0,
  otherOrdinary: 0,
  taxExemptInterest: 0,
  ssPrimary: 0,
  ssSpouse: 0,
  conversion: 0,
  stockSold: 0,
  stockBasis: 0,
  pretaxBalance: null,
  stateRatePct: 0,
  spouseSoleBeneficiary: true,
  acaHouseholdSize: null,
  acaBenchmarkAnnual: null,
  ...over,
});

describe("review3 law provenance (E3-S1)", () => {
  test("exact rows name themselves; rowless years name the fallback", () => {
    // 2025 and 2026 have their own published rows.
    expect(lawProvenanceForYear(2025)).toEqual({
      lawYear: 2025,
      status: "exact",
      published: true,
      isProjection: false,
      note: "Priced under the published 2025 law row.",
    });
    expect(lawProvenanceForYear(2026)).toEqual({
      lawYear: 2026,
      status: "exact",
      published: true,
      isProjection: false,
      note: "Priced under the published 2026 law row.",
    });
    // 2027 and 2030 are past the newest row: carried forward,
    // projections under the 2026 row, never published law.
    const p2027 = lawProvenanceForYear(2027);
    expect(p2027.lawYear).toBe(2026);
    expect(p2027.status).toBe("carried-forward");
    expect(p2027.published).toBe(false);
    expect(p2027.isProjection).toBe(true);
    expect(p2027.note).toContain("projection");
    const p2030 = lawProvenanceForYear(2030);
    expect(p2030.lawYear).toBe(2026);
    expect(p2030.status).toBe("carried-forward");
    expect(p2030.isProjection).toBe(true);
    // 2024 and 2000 are before the oldest row: carried
    // backward onto the earliest row, never a later year's law.
    const p2024 = lawProvenanceForYear(2024);
    expect(p2024.lawYear).toBe(2025);
    expect(p2024.status).toBe("carried-backward");
    expect(p2024.published).toBe(false);
    expect(p2024.isProjection).toBe(false);
    expect(lawProvenanceForYear(2000).lawYear).toBe(2025);
    expect(lawProvenanceForYear(2000).status).toBe("carried-backward");
  });

  test("2027 federal figures exist but no row is adopted", () => {
    // Rev. Proc. 2026-35 is published; the row stays
    // unadopted until the CMS half (Part B + IRMAA) publishes.
    expect(TAX_LAW_2027_NOTE).toContain("2026-35");
    expect(TAX_LAW_2027_NOTE).toContain("CMS");
  });

  test("a 2027 year prices on the 2026 row and says so", () => {
    // Hand check: a 2027 MFJ year with $100,000 ordinary
    // income prices the 2026 standard deduction ($32,200 —
    // NOT the published 2027 $33,200) and the 2026 brackets:
    // taxable $67,800, tax 10% × $24,800 + 12% × $43,000
    // = $2,480 + $5,160 = $7,640.
    const p = priceYear(base({ calendarYear: 2027, otherOrdinary: 100000 }));
    expect(p.lawProvenance.status).toBe("carried-forward");
    expect(p.lawProvenance.lawYear).toBe(2026);
    expect(p.lawProvenance.isProjection).toBe(true);
    expect(p.standardDeduction).toBe(32200);
    expect(p.taxableIncome).toBe(67800);
    expect(p.federalTax).toBe(7640);
  });

  test("a 2024 year prices on the earliest row, never a later law", () => {
    // Hand check: a 2024 MFJ year with $100,000 ordinary
    // income prices the 2025 standard deduction ($31,500) and
    // the 2025 brackets: taxable $68,500, tax 10% × $23,850
    // + 12% × $44,650 = $2,385 + $5,358 = $7,743.
    const p = priceYear(base({ calendarYear: 2024, otherOrdinary: 100000 }));
    expect(p.lawProvenance.status).toBe("carried-backward");
    expect(p.lawProvenance.lawYear).toBe(2025);
    expect(p.standardDeduction).toBe(31500);
    expect(p.taxableIncome).toBe(68500);
    expect(p.federalTax).toBe(7743);
  });
});

describe("review3 independent federal tax (§4)", () => {
  test("ordinary brackets: 2026 MFJ $100,000 of ordinary income", () => {
    // AGI $100,000; standard deduction $32,200 (Rev. Proc.
    // 2025-32); taxable $67,800; tax 10% × $24,800 +
    // 12% × $43,000 = $2,480 + $5,160 = $7,640.
    const p = priceYear(base({ otherOrdinary: 100000 }));
    expect(p.agi).toBe(100000);
    expect(p.standardDeduction).toBe(32200);
    expect(p.taxableIncome).toBe(67800);
    expect(p.ordinaryTax).toBe(7640);
    expect(p.federalTax).toBe(7640);
    expect(p.lawProvenance.status).toBe("exact");
  });

  test("bracket boundary: taxable income exactly at, and $1 above, the 10% top", () => {
    // $57,000 ordinary − $32,200 standard = $24,800 taxable,
    // exactly the 2026 MFJ 10% top: tax 10% × $24,800 = $2,480.
    const at = priceYear(base({ otherOrdinary: 57000 }));
    expect(at.taxableIncome).toBe(24800);
    expect(at.ordinaryTax).toBe(2480);
    // $1 more of taxable income prices at 12%: $2,480.12.
    const over = priceYear(base({ otherOrdinary: 57001 }));
    expect(over.taxableIncome).toBe(24801);
    expect(over.ordinaryTax).toBe(2480.12);
  });

  test("standard deduction: 2026 single $50,000 of ordinary income", () => {
    // Standard deduction $16,100 (Rev. Proc. 2025-32);
    // taxable $33,900; tax 10% × $12,400 + 12% × $21,500
    // = $1,240 + $2,580 = $3,820.
    const p = priceYear(base({ filingStatus: "single", ageSpouse: null, otherOrdinary: 50000 }));
    expect(p.standardDeduction).toBe(16100);
    expect(p.taxableIncome).toBe(33900);
    expect(p.ordinaryTax).toBe(3820);
    expect(p.federalTax).toBe(3820);
  });

  test("LTCG 0% band: $50,000 gain alone is untaxed", () => {
    // AGI $50,000; taxable $17,800 — all inside the 2026 MFJ
    // 0% ceiling ($98,900 of taxable income): the whole gain
    // prices at 0%, federal tax $0.
    const p = priceYear(base({ ltcg: 50000 }));
    expect(p.agi).toBe(50000);
    expect(p.taxableIncome).toBe(17800);
    expect(p.gainsAt0).toBe(17800);
    expect(p.gainsAt15).toBe(0);
    expect(p.gainsAt20).toBe(0);
    expect(p.ltcgTax).toBe(0);
    expect(p.federalTax).toBe(0);
  });

  test("LTCG stacking: $100,000 ordinary + $50,000 gain", () => {
    // AGI $150,000; taxable $117,800; ordinary taxable income
    // $67,800 (ordinary tax $7,640, as the $100,000 case).
    // 0% room left: $98,900 − $67,800 = $31,100 at 0%; the
    // remaining $18,900 at 15% = $2,835. Federal tax
    // $7,640 + $2,835 = $10,475. The 20% floor ($613,700)
    // is nowhere near, so nothing prices at 20%.
    const p = priceYear(base({ otherOrdinary: 100000, ltcg: 50000 }));
    expect(p.agi).toBe(150000);
    expect(p.taxableIncome).toBe(117800);
    expect(p.ordinaryTaxableIncome).toBe(67800);
    expect(p.gainsAt0).toBe(31100);
    expect(p.gainsAt15).toBe(18900);
    expect(p.gainsAt20).toBe(0);
    expect(p.ltcgTax).toBe(2835);
    expect(p.ordinaryTax).toBe(7640);
    expect(p.federalTax).toBe(10475);
  });

  test("20% gains rate: $1,500,000 gain alone (Washington year)", () => {
    // Federal side only here (state is the WA case below):
    // taxable $1,467,800 — the $32,200 standard deduction
    // shelters $32,200 of the gain, so only $1,467,800 of
    // gains price: at 0% $98,900, at 15% $514,800
    // ($613,700 − $98,900), at 20% the remaining $854,100.
    // LTCG tax = 15% × $514,800 + 20% × $854,100 = $77,220
    // + $170,820 = $248,040. NIIT also prices on the FULL
    // $1,500,000 of investment income (the deduction does not
    // shelter NIIT): 3.8% × min($1,500,000, $1,500,000 −
    // $250,000) = 3.8% × $1,250,000 = $47,500. AND the AMT
    // bites: AMTI is the $1,467,800 taxable income plus the
    // $32,200 standard deduction added back = $1,500,000;
    // the exemption phases out entirely (50% × $500,000
    // over the $1,000,000 start swallows the $140,200), so
    // the taxable excess is the whole $1,500,000. The
    // tentative tax keeps the preferential rates on the
    // gains ($248,040, as above) but taxes the $32,200
    // ordinary add-back at 26% — 26% × $32,200 = $8,372 —
    // for a tentative tax of $256,412 against a $248,040
    // regular tax: $8,372 of AMT owed. Federal tax
    // $248,040 + $47,500 + $8,372 = $303,912.
    const p = priceYear(base({ ltcg: 1500000, residenceState: "WA" }));
    expect(p.gainsAt0).toBe(98900);
    expect(p.gainsAt15).toBe(514800);
    expect(p.gainsAt20).toBe(854100);
    expect(p.ltcgTax).toBe(248040);
    expect(p.niit).toBe(47500);
    expect(p.amti).toBe(1500000);
    expect(p.amtExemption).toBe(0);
    expect(p.amtTentativeTax).toBe(256412);
    expect(p.amtOwed).toBe(8372);
    expect(p.federalTax).toBe(303912);
  });

  test("SALT cap 2026: $50,000 paid caps at $40,400", () => {
    // AGI $200,000 (below the $505,000 phase-down start, so
    // no phase-down): the §164(b)(7) cap is $40,400; the
    // itemized total $40,400 beats the $32,200 standard
    // deduction; taxable $159,600.
    const p = priceYear(base({ otherOrdinary: 200000, itemizedSaltPaid: 50000 }));
    expect(p.itemizedSaltAllowed).toBe(40400);
    expect(p.itemizedSaltCap).toBe(40400);
    expect(p.deductionTaken).toBe("itemized");
    expect(p.itemizedDeduction).toBe(40400);
    expect(p.taxableIncome).toBe(159600);
  });

  test("SALT phase-down 2026: $600,000 AGI caps at $11,900", () => {
    // Cap $40,400 − 30% × ($600,000 − $505,000) = $40,400 −
    // $28,500 = $11,900, above the $10,000 floor.
    const p = priceYear(base({ otherOrdinary: 600000, itemizedSaltPaid: 50000 }));
    expect(p.itemizedSaltAllowed).toBe(11900);
    expect(p.itemizedSaltCap).toBe(11900);
  });

  test("SALT dated schedule: 2027 caps at $40,804, not the 2026 row's $40,400", () => {
    // §164(b)(7) as amended enacts the amount per year: the
    // 2027 entry is $40,804, and the pricer consults the
    // schedule by calendar year — a carried-forward 2027
    // year does NOT inherit the 2026 row's $40,400.
    const p = priceYear(base({ calendarYear: 2027, otherOrdinary: 200000, itemizedSaltPaid: 50000 }));
    expect(p.lawProvenance.status).toBe("carried-forward");
    expect(p.itemizedSaltAllowed).toBe(40804);
    expect(p.itemizedSaltCap).toBe(40804);
    expect(p.taxableIncome).toBe(159196);
  });

  test("SALT reversion: 2030 caps at $10,000 flat, no phase-down", () => {
    // Taxable years beginning after 2029: the $10,000
    // limitation, permanent, with no phase-down — even at
    // $600,000 AGI the allowed amount is $10,000.
    const p = priceYear(base({ calendarYear: 2030, otherOrdinary: 600000, itemizedSaltPaid: 50000 }));
    expect(p.itemizedSaltAllowed).toBe(10000);
    expect(p.itemizedSaltCap).toBe(10000);
  });

  test("senior deduction: two 65-year-olds at $100,000 AGI", () => {
    // §151(d)(5)(C): $6,000 per person 65+, on top of the
    // standard deduction; AGI $100,000 is below the $150,000
    // MFJ phase-out start, so the full $12,000 applies.
    // Standard side: $32,200 + 2 × $1,650 age-65 add-on =
    // $35,500; deductions $35,500 + $12,000 = $47,500;
    // taxable $52,500; tax 10% × $24,800 + 12% × $27,700
    // = $2,480 + $3,324 = $5,804.
    const p = priceYear(base({ agePrimary: 65, ageSpouse: 65, otherOrdinary: 100000 }));
    expect(p.seniorDeduction).toBe(12000);
    expect(p.standardDeduction).toBe(35500);
    expect(p.deductions).toBe(47500);
    expect(p.taxableIncome).toBe(52500);
    expect(p.federalTax).toBe(5804);
  });

  test("senior deduction phases out at 6% over $150,000 MFJ", () => {
    // AGI $200,000: excess $50,000; per person $6,000 −
    // 6% × $50,000 = $3,000; two people $6,000. Deductions
    // $35,500 + $6,000 = $41,500; taxable $158,500; tax
    // 10% × $24,800 + 12% × $76,000 + 22% × $57,700
    // = $2,480 + $9,120 + $12,694 = $24,294.
    const p = priceYear(base({ agePrimary: 65, ageSpouse: 65, otherOrdinary: 200000 }));
    expect(p.seniorDeduction).toBe(6000);
    expect(p.deductions).toBe(41500);
    expect(p.taxableIncome).toBe(158500);
    expect(p.federalTax).toBe(24294);
  });

  test("senior deduction window closes after 2028", () => {
    // The OBBBA senior deduction runs 2025–2028 only: a 2029
    // year prices $0 even for two 65-year-olds. A 2028 year
    // (carried forward, inflation 0) still prices $12,000.
    const p2029 = priceYear(base({ calendarYear: 2029, agePrimary: 65, ageSpouse: 65, otherOrdinary: 100000 }));
    expect(p2029.seniorDeduction).toBe(0);
    const p2028 = priceYear(base({ calendarYear: 2028, agePrimary: 65, ageSpouse: 65, otherOrdinary: 100000 }));
    expect(p2028.lawProvenance.status).toBe("carried-forward");
    expect(p2028.seniorDeduction).toBe(12000);
  });

  test("2026 deduction trio is 2026-and-later only: the charitable floor", () => {
    // §170(b)(1)(I): an itemizer's charitable deduction is
    // reduced by 0.5% of AGI — 2026 and later only. At AGI
    // $200,000 the floor is $1,000, so $10,000 of giving
    // allows $9,000 in 2026 — and the whole $10,000 in 2025.
    const p2026 = priceYear(base({ otherOrdinary: 200000, itemizedSaltPaid: 40400, itemizedCharitable: 10000 }));
    expect(p2026.itemizedCharitableAllowed).toBe(9000);
    const p2025 = priceYear(base({ calendarYear: 2025, otherOrdinary: 200000, itemizedSaltPaid: 40000, itemizedCharitable: 10000 }));
    expect(p2025.itemizedCharitableAllowed).toBe(10000);
  });

  test("non-itemizer charitable deduction (§170(p)) below the line", () => {
    // 2026 MFJ, $1,500 of giving, standard side wins: the
    // §170(p) deduction is $1,500 (under the $2,000 MFJ
    // cap), inside deductions but NOT inside AGI. Deductions
    // $32,200 + $1,500 = $33,700; taxable $66,300; tax
    // 10% × $24,800 + 12% × $41,500 = $2,480 + $4,980
    // = $7,460; AGI stays $100,000.
    const p = priceYear(base({ otherOrdinary: 100000, itemizedCharitable: 1500 }));
    expect(p.nonItemizerCharitableDeduction).toBe(1500);
    expect(p.deductionTaken).toBe("standard");
    expect(p.agi).toBe(100000);
    expect(p.deductions).toBe(33700);
    expect(p.taxableIncome).toBe(66300);
    expect(p.federalTax).toBe(7460);
  });

  test("NIIT: 3.8% on the lesser of NII and MAGI over $250,000 MFJ", () => {
    // AGI $300,000 ($240,000 ordinary + $60,000 interest,
    // all of it net investment income). NIIT = 3.8% ×
    // min($60,000, $300,000 − $250,000) = 3.8% × $50,000
    // = $1,900. Ordinary tax on $267,800 taxable: 10% ×
    // $24,800 + 12% × $76,000 + 22% × $110,600 + 24% ×
    // $56,400 = $2,480 + $9,120 + $24,332 + $13,536
    // = $49,468. Federal tax $49,468 + $1,900 = $51,368.
    const p = priceYear(base({ otherOrdinary: 240000, interestIncome: 60000 }));
    expect(p.agi).toBe(300000);
    expect(p.ordinaryTax).toBe(49468);
    expect(p.niit).toBe(1900);
    expect(p.federalTax).toBe(51368);
    // Below the threshold there is no NIIT at all.
    const below = priceYear(base({ otherOrdinary: 140000, interestIncome: 60000 }));
    expect(below.agi).toBe(200000);
    expect(below.niit).toBe(0);
  });

  test("Social Security §86: single, $30,000 benefits, $20,000 other income", () => {
    // Provisional income $20,000 + $15,000 (half the
    // benefits) = $35,000. Single thresholds $25,000 /
    // $34,000: above the second, taxable = min(85% ×
    // $30,000, 50% × ($34,000 − $25,000) + 85% ×
    // ($35,000 − $34,000)) = min($25,500, $4,500 + $850)
    // = $5,350. AGI $25,350; ACA MAGI adds the untaxed
    // benefits back: $25,350 + $24,650 = $50,000.
    const p = priceYear(base({ filingStatus: "single", ageSpouse: null, ssBenefits: 30000, otherOrdinary: 20000 }));
    expect(p.provisionalIncome).toBe(35000);
    expect(p.ssTaxable).toBe(5350);
    expect(p.agi).toBe(25350);
    expect(p.magi).toBe(25350);
    expect(p.acaMagi).toBe(50000);
  });

  test("Social Security §86: below the first threshold, and the middle band", () => {
    // Provisional $20,000 ($5,000 other + $15,000 half
    // benefits) is below the $25,000 first threshold: $0
    // taxable.
    const none = priceYear(base({ filingStatus: "single", ageSpouse: null, ssBenefits: 30000, otherOrdinary: 5000 }));
    expect(none.ssTaxable).toBe(0);
    // Provisional $30,000 ($15,000 other + $15,000): inside
    // the band, taxable = min(50% × $30,000, 50% ×
    // ($30,000 − $25,000)) = $2,500.
    const mid = priceYear(base({ filingStatus: "single", ageSpouse: null, ssBenefits: 30000, otherOrdinary: 15000 }));
    expect(mid.ssTaxable).toBe(2500);
  });

  test("AMT position: $300,000 MFJ prices the exemption, no AMT owed", () => {
    // AMTI = taxable $267,800 + the $32,200 standard
    // deduction added back = $300,000. Exemption $140,200
    // (no phase-out — AMTI under $1,000,000). Taxable
    // excess $159,800, all under the $244,500 breakpoint:
    // tentative tax 26% × $159,800 = $41,548, below the
    // $49,468 regular tax, so $0 owed.
    const p = priceYear(base({ otherOrdinary: 300000 }));
    expect(p.amti).toBe(300000);
    expect(p.amtExemption).toBe(140200);
    expect(p.amtTentativeTax).toBe(41548);
    expect(p.amtOwed).toBe(0);
    expect(p.federalTax).toBe(49468);
  });

  test("AMT phase-out: $1,200,000 MFJ, exemption cut by the 50% rate", () => {
    // Exemption $140,200 − 50% × ($1,200,000 − $1,000,000)
    // = $40,200. Taxable excess $1,159,800; tentative tax
    // 26% × $244,500 + 28% × $915,300 = $63,570 + $256,284
    // = $319,854, below the $354,250.50 regular tax, so $0
    // owed. Regular tax on $1,167,800 taxable: $2,480 +
    // $9,120 + $24,332 + $46,116 + $34,848 + 35% × $256,250
    // + 37% × $399,100 = $206,583.50 + $147,667
    // = $354,250.50. (The OBBBA §70107 reset: 2025 phased out from
    // $1,252,700 at 25%; 2026 resets to $1,000,000 at 50% —
    // the 2025 row prices the old figures instead: at
    // $1,200,000 AMTI the 2025 exemption is untouched at
    // $137,000 — still under the $1,252,700 start — and the
    // tentative tax is 26% × $239,100 + 28% × $823,900 =
    // $62,166 + $230,692 = $292,858.)
    const p = priceYear(base({ otherOrdinary: 1200000 }));
    expect(p.amti).toBe(1200000);
    expect(p.amtExemption).toBe(40200);
    expect(p.amtTentativeTax).toBe(319854);
    expect(p.amtOwed).toBe(0);
    expect(p.federalTax).toBe(354250.5);
    const p2025 = priceYear(base({ calendarYear: 2025, otherOrdinary: 1200000 }));
    expect(p2025.amtExemption).toBe(137000);
    expect(p2025.amtTentativeTax).toBe(292858);
  });

  test("AMT 2025 phase-out rate is still 25% on the 2025 row", () => {
    // 2025 MFJ at $1,400,000 AGI: exemption $137,000 −
    // 25% × ($1,400,000 − $1,252,700) = $137,000 − $36,825
    // = $100,175. (This pins the pre-OBBBA rate beside the
    // 2026 reset above: same income, different phase-out.)
    const p = priceYear(base({ calendarYear: 2025, otherOrdinary: 1400000 }));
    expect(p.amti).toBe(1400000);
    expect(p.amtExemption).toBe(100175);
  });

  test("capital-loss allowance: $3,000 against ordinary income", () => {
    // §1211(b): the allowance subtracts in AGI — AGI
    // $50,000 − $3,000 = $47,000; taxable $14,800; tax
    // 10% × $14,800 = $1,480. The utilization base
    // (taxable income before the allowance) is $17,800.
    const p = priceYear(base({ otherOrdinary: 50000, capitalLossAllowance: 3000 }));
    expect(p.agi).toBe(47000);
    expect(p.taxableIncomeBeforeLossAllowance).toBe(17800);
    expect(p.taxableIncome).toBe(14800);
    expect(p.federalTax).toBe(1480);
  });

  test("education credits: AOTC $4,000 of expenses, one eligible student", () => {
    // §25A: tentative AOTC 100% × $2,000 + 25% × $2,000 =
    // $2,500; AGI $100,000 is under the $160,000 MFJ
    // phase-out start, so the full credit prices. Refundable
    // 40% × $2,500 = $1,000; nonrefundable $1,500 applied
    // against the $7,640 tax; federal tax $7,640 − $1,500
    // = $6,140.
    const p = priceYear(base({
      otherOrdinary: 100000,
      educationStudents: [{ expenses: 4000, aotcEligible: true }],
    }));
    expect(p.educationChoice).toBe("aotc");
    expect(p.educationAotc).toBe(2500);
    expect(p.educationRefundable).toBe(1000);
    expect(p.educationNonrefundable).toBe(1500);
    expect(p.federalTax).toBe(6140);
  });

  test("education credits: LLC $10,000 of expenses, no AOTC student", () => {
    // LLC: 20% × $10,000 = $2,000, all nonrefundable;
    // applied in full against the $7,640 tax; federal tax
    // $5,640.
    const p = priceYear(base({
      otherOrdinary: 100000,
      educationStudents: [{ expenses: 10000, aotcEligible: false }],
    }));
    expect(p.educationChoice).toBe("llc");
    expect(p.educationLlc).toBe(2000);
    expect(p.educationRefundable).toBe(0);
    expect(p.educationNonrefundable).toBe(2000);
    expect(p.federalTax).toBe(5640);
  });

  test("education credits phase out ratably $160,000–$180,000 MFJ", () => {
    // AGI $172,000 is 60% through the phase-out, so 40% of
    // the credit survives: AOTC $1,000, refundable $400,
    // nonrefundable $600. Tax on $139,800 taxable:
    // 10% × $24,800 + 12% × $76,000 + 22% × $39,000
    // = $2,480 + $9,120 + $8,580 = $20,180; federal tax
    // $20,180 − $600 = $19,580.
    const p = priceYear(base({
      otherOrdinary: 172000,
      educationStudents: [{ expenses: 4000, aotcEligible: true }],
    }));
    expect(p.educationAotc).toBe(1000);
    expect(p.educationRefundable).toBe(400);
    expect(p.educationNonrefundable).toBe(600);
    expect(p.federalTax).toBe(19580);
  });

  test("ACA MAGI vs federal AGI: tax-exempt interest counts for ACA only", () => {
    // $100,000 ordinary + $5,000 tax-exempt interest: AGI
    // $100,000 (tax-exempt interest never enters AGI), MAGI
    // $105,000, ACA MAGI $105,000.
    const p = priceYear(base({ otherOrdinary: 100000, taxExemptInterest: 5000 }));
    expect(p.agi).toBe(100000);
    expect(p.magi).toBe(105000);
    expect(p.acaMagi).toBe(105000);
  });

  test("conversions and RMDs enter ordinary income dollar for dollar", () => {
    // A $50,000 conversion alone: AGI $50,000, taxable
    // $17,800, tax 10% × $17,800 = $1,780.
    const conv = priceYear(base({ conversion: 50000 }));
    expect(conv.agi).toBe(50000);
    expect(conv.taxableIncome).toBe(17800);
    expect(conv.federalTax).toBe(1780);
    // A $50,000 RMD alone prices identically.
    const rmd = priceYear(base({ rmd: 50000 }));
    expect(rmd.agi).toBe(50000);
    expect(rmd.taxableIncome).toBe(17800);
    expect(rmd.federalTax).toBe(1780);
  });
});

describe("review3 state tax model (E3-S2)", () => {
  test("flat-rate estimate: 5% on federal taxable income, labeled an estimate", () => {
    // 5% × $67,800 = $3,390 — and the provenance says
    // plainly that it is an estimate, with the caller's
    // rate and no residence supplied.
    const p = priceYear(base({ otherOrdinary: 100000, stateRatePct: 5 }));
    expect(p.stateTax).toBe(3390);
    expect(p.stateTaxProvenance.kind).toBe("flat-rate-estimate");
    expect(p.stateTaxProvenance.ratePct).toBe(5);
    expect(p.stateTaxProvenance.residenceState).toBe(null);
    expect(p.stateTaxProvenance.note).toContain("Estimate only");
  });

  test("no rate supplied prices 0% — no default state's rate is ever assigned", () => {
    const p = priceYear(base({ otherOrdinary: 100000 }));
    expect(p.stateTax).toBe(0);
    expect(p.stateTaxProvenance.kind).toBe("flat-rate-estimate");
    expect(p.stateTaxProvenance.ratePct).toBe(0);
  });

  test("Washington excise: $400,000 of gains prices 7% above the $278,000 deduction", () => {
    // RCW 82.87: taxable WA gains $400,000 − $278,000 =
    // $122,000; 7% × $122,000 = $8,540. Qualified dividends
    // aside, the excise base is the long-term gains alone.
    const p = priceYear(base({ ltcg: 400000, residenceState: "WA" }));
    expect(p.waGains).toBe(400000);
    expect(p.waStandardDeduction).toBe(278000);
    expect(p.waTaxableGains).toBe(122000);
    expect(p.stateTax).toBe(8540);
    expect(p.stateTaxProvenance.kind).toBe("wa-excise");
    expect(p.stateTaxProvenance.ratePct).toBe(null);
  });

  test("Washington excise never stacks with the flat rate", () => {
    // The same WA year with a 5% flat rate supplied prices
    // exactly the excise — $8,540, not $8,540 plus 5% of
    // federal taxable income.
    const p = priceYear(base({ ltcg: 400000, residenceState: "WA", stateRatePct: 5 }));
    expect(p.stateTax).toBe(8540);
  });

  test("Washington surtax tier: 9.9% above $1,000,000 of taxable gains", () => {
    // Taxable WA gains $1,500,000 − $278,000 = $1,222,000;
    // 7% × $1,000,000 + 9.9% × $222,000 = $70,000 +
    // $21,978 = $91,978.
    const p = priceYear(base({ ltcg: 1500000, residenceState: "WA" }));
    expect(p.waTaxableGains).toBe(1222000);
    expect(p.stateTax).toBe(91978);
  });

  test("Washington excise: gains at or below the deduction price $0", () => {
    const p = priceYear(base({ ltcg: 200000, residenceState: "WA" }));
    expect(p.waTaxableGains).toBe(0);
    expect(p.stateTax).toBe(0);
  });
});

describe("review3 tax identity and cross-engine parity (§5)", () => {
  test("qualified dividends are counted once, on the gains stack", () => {
    // Form 1040 lines 3a/3b: $20,000 ordinary dividends, of
    // which $15,000 qualified. The $20,000 total enters AGI
    // once — $5,000 non-qualified on the ordinary stack,
    // $15,000 qualified on the gains stack — never $35,000.
    const p = pricePlaygroundYear(pgBase({ ordinaryDividends: 20000, qualifiedDividends: 15000 }));
    expect(p.ordinaryDividends).toBe(20000);
    expect(p.nonQualifiedDividends).toBe(5000);
    expect(p.qualifiedDividends).toBe(15000);
    expect(p.ltcgPriced).toBe(15000);
    expect(p.agi).toBe(20000);
    expect(p.taxableIncome).toBe(0);
    expect(p.federalTax).toBe(0);
  });

  test("single-year pricer agrees with priceYear on equivalent inputs", () => {
    // Playground dials: $1,000 interest, $20,000 ordinary
    // dividends ($15,000 qualified), $50,000 other ordinary,
    // a $20,000 stock gain, a $10,000 conversion. The
    // equivalent priceYear base splits the dividends the
    // same way (non-qualified $5,000 ordinary, qualified
    // $15,000 on the gains stack) and prices the same gain
    // and conversion. Every tax figure must agree to the cent.
    const pg = pricePlaygroundYear(pgBase({
      interest: 1000,
      ordinaryDividends: 20000,
      qualifiedDividends: 15000,
      otherOrdinary: 50000,
      stockSold: 60000,
      stockBasis: 40000,
      conversion: 10000,
    }));
    const direct = priceYear(base({
      otherOrdinary: 50000,
      interestIncome: 1000,
      ordinaryDividends: 5000,
      qualifiedDividends: 15000,
      ltcg: 20000,
      conversion: 10000,
    }));
    expect(pg.agi).toBe(direct.agi);
    expect(pg.magi).toBe(direct.magi);
    expect(pg.acaMagi).toBe(direct.acaMagi);
    expect(pg.taxableIncome).toBe(direct.taxableIncome);
    expect(pg.ordinaryTax).toBe(direct.ordinaryTax);
    expect(pg.ltcgTax).toBe(direct.ltcgTax);
    expect(pg.niit).toBe(direct.niit);
    expect(pg.federalTax).toBe(direct.federalTax);
    expect(pg.stateTax).toBe(direct.stateTax);
    expect(pg.lawProvenance).toEqual(direct.lawProvenance);
    expect(pg.stateTaxProvenance).toEqual(direct.stateTaxProvenance);
  });

  test("federal components reconcile to the federal total", () => {
    // The $100,000 ordinary + $50,000 gain case: federal tax
    // must equal ordinary tax + LTCG tax + NIIT + AMT owed,
    // term for term, and the Playground's total tax must
    // equal federal + state.
    const p = priceYear(base({ otherOrdinary: 100000, ltcg: 50000 }));
    expect(p.federalTax).toBe(p.ordinaryTax + p.ltcgTax + p.niit + p.amtOwed);
    const pg = pricePlaygroundYear(pgBase({
      otherOrdinary: 100000,
      stockSold: 50000,
      stockBasis: 0,
      stateRatePct: 5,
    }));
    expect(pg.totalTax).toBe(pg.federalTax + pg.stateTax);
  });

  test("single-year unsupported years carry provenance, not silence", () => {
    const p2030 = pricePlaygroundYear(pgBase({ taxYear: 2030, otherOrdinary: 100000 }));
    expect(p2030.lawProvenance.status).toBe("carried-forward");
    expect(p2030.lawProvenance.lawYear).toBe(2026);
    expect(p2030.lawProvenance.isProjection).toBe(true);
    const p2024 = pricePlaygroundYear(pgBase({ taxYear: 2024, otherOrdinary: 100000 }));
    expect(p2024.lawProvenance.status).toBe("carried-backward");
    expect(p2024.lawProvenance.lawYear).toBe(2025);
  });

  test("work-year lines name their law row and state-tax basis", () => {
    // Sample household: primary born 1968, so age 58 prices
    // calendar year 2026 (exact) and age 62 prices 2030
    // (carried forward on the 2026 row). The flat-rate kind
    // holds on both — the sample plan carries no residence.
    const plan = samplePlanInputs({ inflationPct: 0, stateRatePct: 0 });
    const job = { salary: 100000, employer401k: 0, employerHsa: 0 };
    const y2026 = priceOneWorkYear(plan, job, 58);
    expect(y2026.calendarYear).toBe(2026);
    expect(y2026.lawYearUsed).toBe(2026);
    expect(y2026.lawStatus).toBe("exact");
    expect(y2026.stateTaxKind).toBe("flat-rate-estimate");
    const y2030 = priceOneWorkYear(plan, job, 62);
    expect(y2030.calendarYear).toBe(2030);
    expect(y2030.lawYearUsed).toBe(2026);
    expect(y2030.lawStatus).toBe("carried-forward");
    expect(y2030.stateTaxKind).toBe("flat-rate-estimate");
  });
});

describe("review3 inflation is not applied twice (§E3-S1.6)", () => {
  test("NIIT threshold deflates once in a 2030 projection", () => {
    // 2030 at 2.5% inflation, MFJ, AGI $300,000
    // ($200,000 ordinary + $100,000 interest): the deflation
    // factor is 1 / 1.025^4, so the $250,000 NIIT threshold
    // prices at $226,487.66 and the NIIT is 3.8% ×
    // min($100,000, $300,000 − $226,487.66) = 3.8% ×
    // $73,512.34 = $2,793.47. Deflating TWICE would price
    // the threshold at $205,187.65 and the NIIT at $3,602.87
    // — the pinned figure rules that out.
    const p = priceYear(base({
      calendarYear: 2030,
      inflationPct: 2.5,
      otherOrdinary: 200000,
      interestIncome: 100000,
    }));
    expect(p.niit).toBe(2793.47);
  });

  test("Social Security thresholds deflate once in a 2030 projection", () => {
    // 2030 at 2.5%, single, $30,000 benefits, $20,000 other
    // income: thresholds $25,000 / $34,000 deflate once to
    // $22,648.77 / $30,802.32. Provisional $35,000 is above
    // the second: taxable = min(85% × $30,000, 50% ×
    // $8,153.56 + 85% × $4,197.68) = min($25,500, $4,076.78
    // + $3,568.03) = $7,644.80. Twice-deflated thresholds
    // would price $9,723.77; undeflated, $5,350.
    const p = priceYear(base({
      calendarYear: 2030,
      filingStatus: "single",
      ageSpouse: null,
      inflationPct: 2.5,
      ssBenefits: 30000,
      otherOrdinary: 20000,
    }));
    expect(p.ssTaxable).toBe(7644.8);
  });

  test("indexed figures do NOT deflate: 2030 brackets stay at 2026 values in real terms", () => {
    // A 2030 MFJ year with $100,000 ordinary income prices
    // the carried-forward 2026 standard deduction and
    // brackets exactly: taxable $67,800, tax $7,640 — the
    // same as the 2026 year itself.
    const p = priceYear(base({ calendarYear: 2030, inflationPct: 2.5, otherOrdinary: 100000 }));
    expect(p.standardDeduction).toBe(32200);
    expect(p.taxableIncome).toBe(67800);
    expect(p.federalTax).toBe(7640);
  });
});
