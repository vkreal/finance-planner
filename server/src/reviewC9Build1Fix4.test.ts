// Engine Review C9, Build 1 fix 4 — regression tests for the three
// Pass 2 SHOULDs (review-pass2-report.md). Fictional sample household
// only — every expected value is hand-derived IN THIS FILE from the
// 2026 MFJ law row (std deduction $32,200; brackets 10% to $24,800,
// 12% to $100,800, 22% to $211,400; LTCG 0% top $98,900).
//
// SHOULD 1 (priceYear split contract, taxEngine.ts drawSplitSupplied
// branch): the pricer trusted the caller's per-owner split with no
// check that it sums to the draw. Over-split priced a penalty on
// money never drawn; under-split priced the unattributed remainder
// as income with no penalty and no flag; a $0/$0 split suppressed
// the unknown flag the no-split call sets. FIX: the attributed total
// is clamped to the draw, primary-first, and any unattributed
// remainder is treated as unanswered (flag set on a pre-59½ year),
// exactly as in the no-split case. The remainder itself prices no
// penalty — the landing default is $0 + flag when unknown, never a
// guessed penalty. The must-sum contract is documented on
// PriceYearInput (closing N5's doc half). The $2M-eligible row is
// the documented no-clamp caveat: priceYear has no balance input,
// so an eligible balance larger than the pool it came from shelters
// at face value here; the march and the Playground clamp at their
// own ledgers.
//
// SHOULD 2 (Playground exhausted pool, rothOptimizer.ts split
// construction): when the RMD + conversion consume the whole
// pre-tax balance, the Playground's split is 0/0 and priceYear
// priced the pre-59½ draw at $0 penalty with the flag FALSE in
// every eligibility state — while the no-balance control on the
// same draw flags true. FIX: the Playground sets the flag itself
// when the attributed split sums to less than the draw (the
// unattributed remainder is unanswered), OR-ed into the result
// beside priceYear's own remainder flag; the split is still
// passed, so the penalty on the dollars the pools COULD
// distribute stays priced — a partial draw keeps its attributed
// penalty, and only the remainder is flagged. The $0 penalty on
// the exhausted shape itself follows the documented
// distributable-dollars rule (income in full, penalty only on
// distributable dollars), so this SHOULD is disclosure-only.
//
// SHOULD 3 (survivor combine false-positive flag, taxEngine.ts
// combine block — open NICE N2, escalated): the combine nulled
// eligibility if either side was unanswered, with no zero-balance
// exception — so a $0 spouse side's null flagged the survivor's
// draws on a pool that was 100% answered-eligible dollars. FIX:
// the combined eligibility is nulled only when the unanswered
// side holds nonzero dollars; a $0 side's null counts as $0
// eligible, never as unknown. Penalty $0 either way —
// disclosure-only.
//
// Base arithmetic shared by the SHOULD 1 shapes (draw $100,000,
// MFJ 2026): taxable income $100,000 − $32,200 = $67,800;
// federal 10% × $24,800 = $2,480 + 12% × $43,000 = $5,160
// = $7,640. Base arithmetic for the SHOULD 2 shapes:
//   exhausted (conversion $100k + draw $50k): income $150,000,
//     taxable $117,800; federal $2,480 + 12% × $76,000 = $9,120
//     + 22% × $17,000 = $3,740 → $15,340.
//   no-balance control (draw $50k): income $50,000, taxable
//     $17,800; federal 10% × $17,800 = $1,780.
//   partial (conversion $70k + draw $50k, $30k distributable):
//     income $120,000, taxable $87,800; federal $2,480 +
//     12% × $63,000 = $7,560 → $10,040; penalty 10% × $30,000
//     = $3,000 on the distributable share.
import { describe, expect, test } from "bun:test";
import { priceYear, simulateRothPlan, type RothPlanInputs } from "./taxEngine";
import {
  pricePlaygroundYear,
  type PlaygroundYearInputs,
} from "./rothOptimizer";
import { samplePlanInputs } from "./sampleHousehold";

const DO_NOTHING = { id: "none", name: "Do Nothing", ceilings: null } as const;
const yearOf = (res: ReturnType<typeof simulateRothPlan>, year: number) =>
  res.years.find((y) => y.year === year)!;

// The C9 spec fixture (same as reviewC9Build1.test.ts): primary 55,
// MFJ, $2M taxable at 50% basis, $1.5M traditional, $500K Roth,
// $150K/yr spending, $48K SS at 67, through 95.
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

const pyBase = {
  calendarYear: 2026,
  filingStatus: "mfj" as const,
  agePrimary: 55,
  ageSpouse: 53 as number | null,
  otherOrdinary: 0,
  rmd: 0,
  conversion: 0,
  extraPreTaxDraw: 100_000,
  ssBenefits: 0,
  taxExemptInterest: 0,
  ltcg: 0,
  inflationPct: 0,
  stateRatePct: 0,
};

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

describe("Fix 4 SHOULD 1 — priceYear split contract (direct calls)", () => {
  test("OVER-split $120k/$0 on a $100k draw clamps to the draw: penalty $10,000, not $12,000", () => {
    // The $20,000 excess was never drawn (income is still the
    // $100k draw: taxable $67,800, federal $7,640), so no
    // penalty attaches to it.
    const r = priceYear({
      ...pyBase,
      extraPreTaxDrawPrimary: 120_000,
      extraPreTaxDrawSpouse: 0,
      pretax401kEligiblePrimary: 0,
      separationAgePrimary: 55,
    });
    expect(r.earlyWithdrawalPenalty).toBe(10_000);
    expect(r.earlyWithdrawalEligibilityUnknown).toBe(false);
    expect(r.taxableIncome).toBe(67_800);
    expect(r.federalTax).toBe(7_640);
  });

  test("UNDER-split $60k/$0: penalty $6,000 on the attributed share, flag TRUE on the $40,000 remainder", () => {
    // The $40,000 is still priced as ordinary income (taxable
    // $67,800, federal $7,640) but its owner — and therefore
    // its penalty — is unknown, so the flag is set rather than
    // silently pricing $0 on it. The remainder itself prices
    // no penalty (unknown ⇒ $0 + flag, never a guessed $4,000).
    const r = priceYear({
      ...pyBase,
      extraPreTaxDrawPrimary: 60_000,
      extraPreTaxDrawSpouse: 0,
      pretax401kEligiblePrimary: 0,
      separationAgePrimary: 55,
    });
    expect(r.earlyWithdrawalPenalty).toBe(6_000);
    expect(r.earlyWithdrawalEligibilityUnknown).toBe(true);
    expect(r.taxableIncome).toBe(67_800);
    expect(r.federalTax).toBe(7_640);
  });

  test("ZERO-split $0/$0 collapses onto the no-split case: $0 penalty, flag TRUE (unanswered and answered-0 alike)", () => {
    // Unanswered eligibility: the no-split call on identical
    // facts flags true, and the explicit 0/0 split must not
    // suppress that. Answered-0 collapses the same way: the
    // $100,000 is unattributed, so its penalty is unknown even
    // though the entered eligibility is $0 — the split, not
    // the eligibility answer, is what is missing.
    for (const elig of [null, 0]) {
      const r = priceYear({
        ...pyBase,
        extraPreTaxDrawPrimary: 0,
        extraPreTaxDrawSpouse: 0,
        pretax401kEligiblePrimary: elig,
        separationAgePrimary: 55,
      });
      expect(r.earlyWithdrawalPenalty).toBe(0);
      expect(r.earlyWithdrawalEligibilityUnknown).toBe(true);
      expect(r.taxableIncome).toBe(67_800);
    }
    // Control: no split passed at all — identical outcome.
    const ctl = priceYear({
      ...pyBase,
      pretax401kEligiblePrimary: null,
      separationAgePrimary: 55,
    });
    expect(ctl.earlyWithdrawalPenalty).toBe(0);
    expect(ctl.earlyWithdrawalEligibilityUnknown).toBe(true);
  });

  test("MIXED split $60k/$40k, primary answered / spouse unanswered: penalty $6,000, flag TRUE (unchanged)", () => {
    // The split sums to the draw, so no remainder flag arises;
    // the flag comes from the spouse's unanswered share alone.
    const r = priceYear({
      ...pyBase,
      extraPreTaxDrawPrimary: 60_000,
      extraPreTaxDrawSpouse: 40_000,
      pretax401kEligiblePrimary: 0,
      pretax401kEligibleSpouse: null,
      separationAgePrimary: 55,
      separationAgeSpouse: 55,
    });
    expect(r.earlyWithdrawalPenalty).toBe(6_000);
    expect(r.earlyWithdrawalEligibilityUnknown).toBe(true);
    expect(r.taxableIncome).toBe(67_800);
    expect(r.federalTax).toBe(7_640);
  });

  test("OVER-split on BOTH sides $70k/$70k clamps primary-first: $70k + $30k, penalty $10,000, flag false", () => {
    // Primary keeps her $70,000; the spouse is clamped to the
    // $30,000 of headroom left. Both answered-0, so the whole
    // $100,000 prices: 10% × $70,000 + 10% × $30,000.
    const r = priceYear({
      ...pyBase,
      extraPreTaxDrawPrimary: 70_000,
      extraPreTaxDrawSpouse: 70_000,
      pretax401kEligiblePrimary: 0,
      pretax401kEligibleSpouse: 0,
      separationAgePrimary: 55,
      separationAgeSpouse: 55,
    });
    expect(r.earlyWithdrawalPenalty).toBe(10_000);
    expect(r.earlyWithdrawalEligibilityUnknown).toBe(false);
    expect(r.taxableIncome).toBe(67_800);
    expect(r.federalTax).toBe(7_640);
  });

  test("UNDER-split with both owners past 59½: remainder flags nothing — no pre-59½ owner exists", () => {
    // The remainder flag is age-gated exactly like the
    // no-split flag: at 60/61 no penalty is possible on any
    // attribution of the draw, so there is nothing unknown.
    const r = priceYear({
      ...pyBase,
      agePrimary: 60,
      ageSpouse: 61,
      extraPreTaxDrawPrimary: 60_000,
      extraPreTaxDrawSpouse: 0,
      pretax401kEligiblePrimary: 0,
      separationAgePrimary: 55,
    });
    expect(r.earlyWithdrawalPenalty).toBe(0);
    expect(r.earlyWithdrawalEligibilityUnknown).toBe(false);
  });

  test("DOCUMENTED caveat: eligible $2M with no balance input shelters at face value (no clamp possible)", () => {
    // priceYear has no pre-tax balance input, so it cannot
    // clamp the shelter the way the march and the Playground
    // do. A $2M eligible answer shelters a $100k draw in full.
    // Pinned as documented behavior, not as a defect.
    const r = priceYear({
      ...pyBase,
      extraPreTaxDrawPrimary: 100_000,
      extraPreTaxDrawSpouse: 0,
      pretax401kEligiblePrimary: 2_000_000,
      separationAgePrimary: 55,
    });
    expect(r.earlyWithdrawalPenalty).toBe(0);
    expect(r.earlyWithdrawalEligibilityUnknown).toBe(false);
  });
});

describe("Fix 4 SHOULD 2 — Playground exhausted pool (pricePlaygroundYear)", () => {
  test("Exhausted pool: balance $100k, conversion $100k, draw $50k — $0 penalty, flag TRUE in all three eligibility states", () => {
    // The pools can distribute $0 of the draw, so the split is
    // 0/0 and the whole $50,000 is unattributed. The $0 penalty
    // follows the distributable-dollars rule (income $150,000
    // in full: taxable $117,800, federal $15,340), but the flag
    // must say the $0 is unknown, not computed — in every
    // eligibility state, answered-$100k included.
    for (const elig of [null, 0, 100_000]) {
      const r = pricePlaygroundYear(
        pgBase({
          pretaxBalance: 100_000,
          conversion: 100_000,
          spendingDraw: 50_000,
          pretax401kEligiblePrimary: elig,
          separationAgePrimary: 55,
        }),
      );
      expect(r.earlyWithdrawalPenalty).toBe(0);
      expect(r.earlyWithdrawalEligibilityUnknown).toBe(true);
      expect(r.taxableIncome).toBe(117_800);
      expect(r.federalTax).toBe(15_340);
    }
  });

  test("No-balance control: same $50k draw with no balance entered — $0 penalty, flag TRUE (unchanged)", () => {
    const r = pricePlaygroundYear(
      pgBase({ spendingDraw: 50_000, pretaxBalance: null }),
    );
    expect(r.earlyWithdrawalPenalty).toBe(0);
    expect(r.earlyWithdrawalEligibilityUnknown).toBe(true);
    expect(r.taxableIncome).toBe(17_800);
    expect(r.federalTax).toBe(1_780);
  });

  test("Partial pool: $30k distributable of a $50k draw keeps its $3,000 penalty AND flags the $20k remainder", () => {
    // Balance $100k, conversion $70k: $30,000 is left for the
    // draw, so the split is $30k/$0. The attributed $30,000 is
    // answered-ineligible and prices 10% × $30,000 = $3,000;
    // the unattributed $20,000 remainder flags true. Passing no
    // split instead would have dropped the $3,000 — the flag
    // is set on the Playground side precisely so the penalty
    // on distributable dollars is never lost.
    const r = pricePlaygroundYear(
      pgBase({
        pretaxBalance: 100_000,
        conversion: 70_000,
        spendingDraw: 50_000,
        pretax401kEligiblePrimary: 0,
        separationAgePrimary: 55,
      }),
    );
    expect(r.earlyWithdrawalPenalty).toBe(3_000);
    expect(r.earlyWithdrawalEligibilityUnknown).toBe(true);
    expect(r.taxableIncome).toBe(87_800);
    expect(r.federalTax).toBe(10_040);
  });
});

describe("Fix 4 SHOULD 3 — survivor combine zero-balance exception (march)", () => {
  test("Primary dies 2030; spouse $0 unanswered — the answered-eligible pool keeps its ledger, no flag in 2031–32", () => {
    // Before the death the draws shelter on the primary's
    // answered $1.5M (flag false). After combining, the $0
    // spouse side contributed no dollars, so its null
    // contributes no unknown dollars: the combined pool is
    // 100% answered-eligible and the survivor's draws shelter
    // with the flag false. Pre-fix this flagged [2031, 2032].
    const res = simulateRothPlan(
      fixture({
        survivorEnabled: true,
        survivorWho: "primary", // primary dies; spouse survives
        survivorDeathYear: 2030,
        pretax401kEligiblePrimary: 1_500_000,
        separationAgePrimary: 55,
      }),
      DO_NOTHING as never,
    );
    expect(yearOf(res, 2026).earlyWithdrawalEligibilityUnknown).toBe(false);
    expect(yearOf(res, 2030).earlyWithdrawalEligibilityUnknown).toBe(false);
    expect(yearOf(res, 2031).penalty).toBe(0);
    expect(yearOf(res, 2031).earlyWithdrawalEligibilityUnknown).toBe(false);
    expect(yearOf(res, 2032).penalty).toBe(0);
    expect(yearOf(res, 2032).earlyWithdrawalEligibilityUnknown).toBe(false);
    expect(yearOf(res, 2033).earlyWithdrawalEligibilityUnknown).toBe(false); // spouse 60
    expect(res.earlyWithdrawalUnknownYears).toEqual([]);
    expect(res.lifetimePenalty).toBe(0);
  });

  test("Mirror: spouse dies 2030; primary $0 unanswered — the answered-eligible pool keeps its ledger, no flag in 2031–33", () => {
    // Primary born 1973 (53 in 2026) survives at 57–59 in
    // 2031–33, so the flag would fire on any unknown dollar.
    // Before the death the spouse's answered $1.5M shelters her
    // draws (flag false); after combining, the primary's $0
    // unanswered side contributed nothing, so the pool stays
    // answered-eligible and his draws shelter with no flag.
    const res = simulateRothPlan(
      fixture({
        birthYearPrimary: 1973, // 53 in 2026; 57 in 2031
        birthYearSpouse: 1971, // 55 in 2026
        pretaxStart: 0,
        pretaxSpouseStart: 1_500_000,
        pretax401kEligibleSpouse: 1_500_000,
        separationAgeSpouse: 55,
        survivorEnabled: true,
        survivorWho: "spouse", // spouse dies; primary survives
        survivorDeathYear: 2030,
      }),
      DO_NOTHING as never,
    );
    expect(yearOf(res, 2026).earlyWithdrawalEligibilityUnknown).toBe(false);
    expect(yearOf(res, 2030).earlyWithdrawalEligibilityUnknown).toBe(false);
    for (const y of [2031, 2032, 2033]) {
      expect(yearOf(res, y).penalty).toBe(0);
      expect(yearOf(res, y).earlyWithdrawalEligibilityUnknown).toBe(false);
    }
    expect(res.earlyWithdrawalUnknownYears).toEqual([]);
    expect(res.lifetimePenalty).toBe(0);
  });

  test("Answered-0 control: the same $0 spouse balance, answered-0 — no flag anywhere (unchanged)", () => {
    const ctl = simulateRothPlan(
      fixture({
        survivorEnabled: true,
        survivorWho: "primary",
        survivorDeathYear: 2030,
        pretax401kEligiblePrimary: 1_500_000,
        separationAgePrimary: 55,
        pretax401kEligibleSpouse: 0,
        separationAgeSpouse: 55,
      }),
      DO_NOTHING as never,
    );
    expect(ctl.earlyWithdrawalUnknownYears).toEqual([]);
    expect(ctl.lifetimePenalty).toBe(0);
    expect(yearOf(ctl, 2031).earlyWithdrawalEligibilityUnknown).toBe(false);
    expect(yearOf(ctl, 2032).earlyWithdrawalEligibilityUnknown).toBe(false);
  });
});
