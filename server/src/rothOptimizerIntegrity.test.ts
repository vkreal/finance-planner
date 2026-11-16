// Engine Review 4 (E4-S1 / E4-S2) — candidate-integrity assessment,
// distinct optimization objectives, and independent conversion
// arithmetic checks.
//
// STANDARD (as in retirementReview1.test.ts): every expected
// figure below is hand-computed in the test itself (plain
// arithmetic on literals) or pinned from a probe run whose
// derivation the test states — never a copied engine print
// without a derivation. All household figures are the shared
// fictional sample household (server/src/sampleHousehold.ts):
// pre-tax $1,500,000, taxable $2,000,000 at 60% basis, Roth
// $400,000, HSA $75,000, spending $180,000/yr, MFJ household
// of 4, birth years 1968/1970, Social Security $48,000/$30,000
// at 67, heir rate 24%, preserve $250,000 at a 10% exit rate
// (compare path only — see the terminal test's note).
//
// E4-S1 BACKGROUND (the reproduced case): the Oct 25
// single-filer engine run flagged detail rows 2048 (both
// variants) and 2063 (V1) with settlementConverged false and a
// 1-cent gains mismatch. The review probe reproduced the
// equivalent on the fictional sample household re-shaped as a
// single filer (Do Nothing: year 2049, 1¢ gains, pre-tax 0¢;
// Fill 12%/22%: the same year) and on the MFJ household (Fill
// 22%: years 2038/2049/2056 on the compare path, 2056 on the
// direct path — each 1¢ gains, pre-tax 0¢). Across the full
// 3,025-candidate optimizer search in BOTH filing statuses
// (≈9,800 non-converged year-instances) the worst mismatch was
// 1 cent, never more. VERDICT: benign rounding residual, not a
// settlement defect — the iteration compares r2-rounded
// feedback gains, and 1¢ of gains moves a year's tax by at
// most ~$0.004 (1¢ × the top 37% ordinary / 23.8% gains
// rate), which rounds to $0.00 at the cent the engine prices
// in. The tolerance was therefore SETTLEMENT_TOLERANCE_CENTS =
// 1 per component per year, derived from that reproduction,
// and anything above it was independently material.
//
// SUPERSEDED (Engine Review C3, V2-F1, 2026-11-15): the 1¢
// basis is broken by a deterministic 2¢ gains mismatch with
// converging neighbours — sample household, spend $254,500,
// taxable-first, basis 60%, fill-aca, year 2047, {gains:2,
// pretax:0}; a $2,500-step hunt found zero further ≥2¢ years.
// The tolerance is now SETTLEMENT_TOLERANCE_CENTS = 2 per
// component per year; 2¢ moves a year's tax by at most
// ~$0.008, which still rounds to $0.00 at the cent the engine
// prices in. The C3-S1 ACA-credit clause reuses the same
// tolerance for the ACA component (see the ACA-clause tests
// below).
//
// Run per-file (whole-suite bun test in one process OOMs on
// this VM): bun test server/src/rothOptimizerIntegrity.test.ts

import { describe, test, expect } from "bun:test";
import {
  assessCandidateIntegrity,
  buildRothFunding,
  candidateStrategy,
  compareScoredCandidates,
  crownOptimizerWinners,
  enteredClaimInfo,
  netCostBreakdown,
  planNetCost,
  runJointOptimizer,
  runOptimizer,
  runRothCompare,
  ssAnnualAtClaimAge,
  SETTLEMENT_TOLERANCE_CENTS,
  type CandidateIntegrity,
  type OptimizerResult,
  type ScoredCandidate,
} from "./rothOptimizer";
import {
  DEFAULT_DRAW_ORDER,
  NO_CEILINGS,
  irmaaAnnualPerPerson,
  priceYear,
  rmdForYear,
  simulateRothPlan,
  type RothPlanResult,
  type DrawOrder,
  type RothPlanInputs,
} from "./taxEngine";
import { lawForYear, fplFor } from "./taxLaw";
import {
  samplePlanInputs,
  SAMPLE_ACA_BENCHMARK_COUPLE_CENTS,
  SAMPLE_ACA_BENCHMARK_FAMILY_CENTS,
  SAMPLE_ACA_BENCHMARK_SINGLE_CENTS,
  SAMPLE_ANNUAL_SPENDING_CENTS,
  SAMPLE_BIRTH_YEAR_PRIMARY,
  SAMPLE_BIRTH_YEAR_SPOUSE,
  SAMPLE_DIVIDEND_YIELD_PCT,
  SAMPLE_EXPECTED_RETURN_PCT,
  SAMPLE_FILING_STATUS,
  SAMPLE_HEIR_RATE_PCT,
  SAMPLE_HOUSEHOLD_SIZE,
  SAMPLE_HSA_CENTS,
  SAMPLE_INFLATION_PCT,
  SAMPLE_INTEREST_YIELD_PCT,
  SAMPLE_PRESERVE_PRETAX_CENTS,
  SAMPLE_PRETAX_CENTS,
  SAMPLE_PROTECT_MIN_TAXABLE_CENTS,
  SAMPLE_QUALIFIED_SHARE_PCT,
  SAMPLE_ROTH_CENTS,
  SAMPLE_SS_PRIMARY_CENTS,
  SAMPLE_SS_PRIMARY_START_AGE,
  SAMPLE_SS_SPOUSE_CENTS,
  SAMPLE_SS_SPOUSE_START_AGE,
  SAMPLE_TAXABLE_BASIS_PCT,
  SAMPLE_TAXABLE_CENTS,
} from "./sampleHousehold";

const r2 = (n: number) => Math.round(n * 100) / 100;

// --- Synthetic-result helpers (assessor unit tests) ---------------
type FakeYear = {
  year: number;
  converged: boolean;
  gains: number;
  pretax: number;
  // Engine Review C3, C3-S1: the ACA-credit mismatch component
  // (integer cents); omitted in a FakeYear means 0.
  acaCredit?: number;
  breached: boolean;
  conversion: number;
  shortfall: number;
};

function fakeResult(years: FakeYear[], unpaidTax = 0): RothPlanResult {
  return {
    years: years.map((y) => ({
      year: y.year,
      settlementConverged: y.converged,
      settlementMismatchCents: {
        gains: y.gains,
        pretax: y.pretax,
        acaCredit: y.acaCredit ?? 0,
      },
      ceilingBreached: y.breached,
      conversion: y.conversion,
      spendShortfall: y.shortfall,
    })),
    lifetimeUnpaidTax: unpaidTax,
  } as unknown as RothPlanResult;
}

const CONVERGED_YEAR: FakeYear = {
  year: 2030,
  converged: true,
  gains: 0,
  pretax: 0,
  acaCredit: 0,
  breached: false,
  conversion: 100000,
  shortfall: 0,
};

// --- Synthetic-candidate helper (selector unit tests) -------------
function fakeScored(
  key: string,
  netCost: number,
  wealth: number,
  valid: boolean,
  order: DrawOrder = DEFAULT_DRAW_ORDER,
): ScoredCandidate {
  return {
    spec: {
      key,
      name: key,
      ceilings: NO_CEILINGS,
      windowStopAge: 74,
      windowKind: "stopRmd",
      windowLabel: "",
      guardrail: false,
      bunching: false,
      gainsHarvest: false,
      drawOrder: order,
    },
    result: { endingAfterTaxWealth: wealth } as RothPlanResult,
    cost: { netCost } as unknown as ScoredCandidate["cost"],
    integrity: {
      status: valid ? "valid" : "invalid",
      reasons: valid ? [] : ["synthetic material discrepancy"],
    } as CandidateIntegrity,
    claimAges: enteredClaimInfo(samplePlanInputs()),
  };
}

function sortScored(list: ScoredCandidate[]): ScoredCandidate[] {
  return [...list].sort((a, b) =>
    compareScoredCandidates(a, b, "taxable-pretax-roth"),
  );
}

// --- Shared engine runs (computed once, reused) -------------------
let mfjOptCache: OptimizerResult | null = null;
function mfjOptimizer(): OptimizerResult {
  if (mfjOptCache == null) mfjOptCache = runOptimizer(samplePlanInputs());
  return mfjOptCache;
}

let singleOptCache: OptimizerResult | null = null;
function singleFilerInputs(): RothPlanInputs {
  return samplePlanInputs({
    filingStatus: "single",
    birthYearSpouse: null,
    ssSpouseAnnual: 0,
    ssSpouseStartAge: null,
    acaHouseholdSize: 1,
    acaBenchmarkFamily: 17500,
    acaBenchmarkCouple: 17500,
    acaBenchmarkSingle: 17500,
  });
}
function singleOptimizer(): OptimizerResult {
  if (singleOptCache == null) singleOptCache = runOptimizer(singleFilerInputs());
  return singleOptCache;
}

const FILL12 = {
  id: "fill12",
  name: "Fill 12%",
  ceilings: {
    bracketTopPct: 12,
    irmaaTierCap: null,
    ltcgZeroCap: false,
    acaCliffCap: false,
    acaCliffCapFamilyOnly: false,
    magiCap: null,
    acaCliffBuffer: null,
  },
};
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
};
const DO_NOTHING = { id: "none", name: "Do Nothing", ceilings: null };

describe("E4-S1 — candidate-integrity assessment (assessor units)", () => {
  test("fully converged candidate is valid", () => {
    const i = assessCandidateIntegrity(
      fakeResult([CONVERGED_YEAR, { ...CONVERGED_YEAR, year: 2031 }]),
    );
    expect(i.status).toBe("valid");
    expect(i.nonConvergedYears).toBe(0);
    expect(i.maxMismatchGainsCents).toBe(0);
    expect(i.reasons).toEqual([]);
  });

  test("2-cent gains residual is valid-with-benign-residual (the tolerance)", () => {
    expect(SETTLEMENT_TOLERANCE_CENTS).toBe(2);
    const i = assessCandidateIntegrity(
      fakeResult([
        CONVERGED_YEAR,
        {
          ...CONVERGED_YEAR,
          year: 2047,
          converged: false,
          gains: 2,
          pretax: 0,
          conversion: 0,
        },
      ]),
    );
    expect(i.status).toBe("valid-with-benign-residual");
    expect(i.nonConvergedYears).toBe(1);
    expect(i.nonConvergedYearList).toEqual([2047]);
    expect(i.maxMismatchGainsCents).toBe(2);
    expect(i.maxMismatchPretaxCents).toBe(0);
    expect(i.maxMismatchAcaCreditCents).toBe(0);
    expect(i.reasons).toEqual([]);
  });

  test("1-cent gains residual is still benign under the 2-cent tolerance", () => {
    const i = assessCandidateIntegrity(
      fakeResult([
        CONVERGED_YEAR,
        {
          ...CONVERGED_YEAR,
          year: 2049,
          converged: false,
          gains: 1,
          pretax: 0,
          conversion: 0,
        },
      ]),
    );
    expect(i.status).toBe("valid-with-benign-residual");
    expect(i.nonConvergedYears).toBe(1);
    expect(i.maxMismatchGainsCents).toBe(1);
    expect(i.reasons).toEqual([]);
  });

  test("mismatch above the tolerance is independently invalid", () => {
    const gains = assessCandidateIntegrity(
      fakeResult([
        { ...CONVERGED_YEAR, converged: false, gains: 25, pretax: 0 },
      ]),
    );
    expect(gains.status).toBe("invalid");
    expect(gains.reasons.join(" ")).toMatch(/25¢/);
    expect(gains.reasons.join(" ")).toMatch(/tolerance/);
    const pretax = assessCandidateIntegrity(
      fakeResult([
        { ...CONVERGED_YEAR, converged: false, gains: 0, pretax: 3 },
      ]),
    );
    expect(pretax.status).toBe("invalid");
    expect(pretax.reasons.join(" ")).toMatch(/3¢/);
  });

  test("ACA-credit mismatch above the tolerance is independently invalid (C3-S1)", () => {
    const i = assessCandidateIntegrity(
      fakeResult([
        {
          ...CONVERGED_YEAR,
          year: 2032,
          converged: false,
          gains: 0,
          pretax: 0,
          acaCredit: 2285280,
        },
      ]),
    );
    expect(i.status).toBe("invalid");
    expect(i.maxMismatchAcaCreditCents).toBe(2285280);
    expect(i.maxMismatchGainsCents).toBe(0);
    expect(i.reasons.join(" ")).toMatch(/ACA credit/);
    expect(i.reasons.join(" ")).toMatch(/2285280¢/);
    expect(i.reasons.join(" ")).toMatch(/tolerance/);
  });

  test("ACA-credit mismatch at the tolerance is benign (C3-S1)", () => {
    const i = assessCandidateIntegrity(
      fakeResult([
        {
          ...CONVERGED_YEAR,
          year: 2032,
          converged: false,
          gains: 0,
          pretax: 0,
          acaCredit: 2,
        },
      ]),
    );
    expect(i.status).toBe("valid-with-benign-residual");
    expect(i.maxMismatchAcaCreditCents).toBe(2);
    expect(i.reasons).toEqual([]);
  });

  test("converged candidate reports zero ACA-credit mismatch", () => {
    const i = assessCandidateIntegrity(
      fakeResult([CONVERGED_YEAR, { ...CONVERGED_YEAR, year: 2031 }]),
    );
    expect(i.status).toBe("valid");
    expect(i.maxMismatchAcaCreditCents).toBe(0);
  });

  test("ceiling breached at conversion $0 is disclosed, not invalid", () => {
    const i = assessCandidateIntegrity(
      fakeResult([
        { ...CONVERGED_YEAR, breached: true, conversion: 0 },
        { ...CONVERGED_YEAR, year: 2031, breached: true, conversion: 0 },
      ]),
    );
    expect(i.status).toBe("valid");
    expect(i.ceilingBreachedYears).toBe(2);
    expect(i.ceilingBreachedAtZeroConversionYears).toBe(2);
    expect(i.reasons).toEqual([]);
  });

  test("ceiling breached with conversion above $0 is invalid (clamp contradiction)", () => {
    const i = assessCandidateIntegrity(
      fakeResult([{ ...CONVERGED_YEAR, breached: true, conversion: 50000 }]),
    );
    expect(i.status).toBe("invalid");
    expect(i.ceilingBreachedYears).toBe(1);
    expect(i.ceilingBreachedAtZeroConversionYears).toBe(0);
    expect(i.reasons.join(" ")).toMatch(/conversion above \$0/);
  });

  test("unpaid tax is invalid, and the reason names the amount", () => {
    const i = assessCandidateIntegrity(
      fakeResult([CONVERGED_YEAR], 28530.49),
    );
    expect(i.status).toBe("invalid");
    expect(i.unpaidTaxTotal).toBe(28530.49);
    expect(i.reasons.join(" ")).toMatch(/unpaid tax of \$28,530/);
  });

  test("unfunded spending is invalid, and the reason names the amount", () => {
    const i = assessCandidateIntegrity(
      fakeResult([{ ...CONVERGED_YEAR, shortfall: 120000 }]),
    );
    expect(i.status).toBe("invalid");
    expect(i.spendShortfallTotal).toBe(120000);
    expect(i.reasons.join(" ")).toMatch(/unfunded spending of \$120,000/);
  });
});

describe("E4-S1 — candidate-integrity assessment (engine cases)", () => {
  test("MFJ Do Nothing: fully converged, valid", () => {
    const res = simulateRothPlan(samplePlanInputs(), DO_NOTHING as never, undefined, {
      leanDetail: true,
    });
    const i = assessCandidateIntegrity(res);
    expect(i.status).toBe("valid");
    expect(i.nonConvergedYears).toBe(0);
    expect(i.ceilingBreachedYears).toBe(0);
    expect(i.unpaidTaxTotal).toBe(0);
    expect(i.spendShortfallTotal).toBe(0);
  });

  test("MFJ Fill 12%: 27 ceiling-breached years, all at conversion $0 — valid, not a defect", () => {
    const res = simulateRothPlan(samplePlanInputs(), FILL12 as never, undefined, {
      leanDetail: true,
    });
    const i = assessCandidateIntegrity(res);
    expect(i.status).toBe("valid");
    expect(i.nonConvergedYears).toBe(0);
    expect(i.ceilingBreachedYears).toBe(27);
    expect(i.ceilingBreachedAtZeroConversionYears).toBe(27);
    // Every breached year converts $0: the draws alone breach.
    for (const y of res.years) {
      if (y.ceilingBreached) expect(y.conversion).toBe(0);
    }
  });

  test("MFJ Fill 22% (direct): one non-converged year, 2056, 1¢ gains — benign residual", () => {
    const res = simulateRothPlan(samplePlanInputs(), FILL22 as never, undefined, {
      leanDetail: true,
    });
    const i = assessCandidateIntegrity(res);
    expect(i.status).toBe("valid-with-benign-residual");
    expect(i.nonConvergedYearList).toEqual([2056]);
    expect(i.maxMismatchGainsCents).toBe(1);
    expect(i.maxMismatchPretaxCents).toBe(0);
  });

  test("MFJ Fill 22% (compare path): non-converged years 2038/2049/2056, 1¢ gains each", () => {
    // The regression gate's compare base (same construction as
    // gate-probe.ts): the sample household with the preserve
    // reserve priced on the compare path.
    const base = {
      birthYearPrimary: SAMPLE_BIRTH_YEAR_PRIMARY,
      birthYearSpouse: SAMPLE_BIRTH_YEAR_SPOUSE,
      filingStatus: SAMPLE_FILING_STATUS,
      pretaxCents: SAMPLE_PRETAX_CENTS,
      pretaxSpouseCents: null,
      survivorEnabled: false,
      survivorWho: null,
      survivorDeathYear: null,
      rothCents: SAMPLE_ROTH_CENTS,
      taxableCents: SAMPLE_TAXABLE_CENTS,
      taxableExcludeCents: 0,
      hsaCents: SAMPLE_HSA_CENTS,
      taxableBasisPct: SAMPLE_TAXABLE_BASIS_PCT,
      taxableTiers: null,
      taxableDividendYieldPct: SAMPLE_DIVIDEND_YIELD_PCT,
      taxableInterestYieldPct: SAMPLE_INTEREST_YIELD_PCT,
      qualifiedDividendSharePct: SAMPLE_QUALIFIED_SHARE_PCT,
      spendFromCashPct: null,
      spendFromCashSleeveCents: null,
      flexCutPct: null,
      flexFloorPct: null,
      annualSpendingCents: SAMPLE_ANNUAL_SPENDING_CENTS,
      retirementAge: 62,
      endAge: 95,
      expectedReturnPct: SAMPLE_EXPECTED_RETURN_PCT,
      ssPrimaryAnnualCents: SAMPLE_SS_PRIMARY_CENTS,
      ssPrimaryStartAge: SAMPLE_SS_PRIMARY_START_AGE,
      ssPrimaryNoBenefit: false,
      ssSpouseAnnualCents: SAMPLE_SS_SPOUSE_CENTS,
      ssSpouseStartAge: SAMPLE_SS_SPOUSE_START_AGE,
      ssSpouseNoBenefit: false,
      otherOrdinaryCents: null,
      taxExemptInterestCents: null,
      convertedAlreadyCents: null,
      windowStartAge: 62,
      windowStopAge: 73,
      payTaxFrom: "taxable",
      protectMinTaxableCents: SAMPLE_PROTECT_MIN_TAXABLE_CENTS,
      preservePretaxCents: SAMPLE_PRESERVE_PRETAX_CENTS,
      preserveExitRatePct: 10,
      claimAgeFloor: null,
      spouseSoleBeneficiary: true,
      primarySoleBeneficiaryOfSpouse: null,
      acaHouseholdSize: SAMPLE_HOUSEHOLD_SIZE,
      acaHouseholdSchedule: null,
      collegeFallFromYear: null,
      collegeFallThroughYear: null,
      acaBenchmarkCoupleCents: SAMPLE_ACA_BENCHMARK_COUPLE_CENTS,
      acaBenchmarkSingleCents: SAMPLE_ACA_BENCHMARK_SINGLE_CENTS,
      acaBenchmarkFamilyCents: SAMPLE_ACA_BENCHMARK_FAMILY_CENTS,
      acaSpouseEndAge: null,
      inflationPct: SAMPLE_INFLATION_PCT,
      stateRatePct: 0,
      heirRatePct: SAMPLE_HEIR_RATE_PCT,
      ceilings: null,
      optimizerGuardrail: null,
      optimizerBunching: null,
      gainsHarvest: null,
      drawOrder: null,
      drawOrderAfter: null,
      drawOrderSwitchAge: null,
      yearlySalaryCents: null,
      employer401kCents: null,
      employerHsaCents: null,
      employer401kCents2: null,
      fafsaReportableAssetsCents: null,
    };
    const ceil12 = {
      bracketTopPct: 12,
      irmaaTierCap: null,
      ltcgZeroCap: false,
      acaCliffCap: false,
      acaCliffCapFamilyOnly: false,
      magiCapCents: null,
      acaCliffBufferCents: null,
    };
    const ceil22 = { ...ceil12, bracketTopPct: 22 };
    const cmp = runRothCompare(
      base as never,
      [
        { name: "Do Nothing", overrides: {} },
        { name: "Fill 12%", overrides: { ceilings: ceil12 } },
        { name: "Fill 22%", overrides: { ceilings: ceil22 } },
      ] as never,
      2026,
      "Do Nothing",
    );
    expect(cmp.ok).toBe(true);
    if (!cmp.ok) return;
    const asResult = (sc: (typeof cmp.scenarios)[number]) =>
      ({
        years: sc.years.map((y) => ({
          year: y.year,
          settlementConverged: y.settlementConverged,
          settlementMismatchCents: y.settlementMismatchCents,
          ceilingBreached: y.ceilingBreached,
          conversion: y.conversionCents / 100,
          spendShortfall: 0,
        })),
        lifetimeUnpaidTax: sc.unpaidTaxCents / 100,
      }) as unknown as RothPlanResult;
    const fill22 = cmp.scenarios.find((s) => s.name === "Fill 22%")!;
    const i22 = assessCandidateIntegrity(asResult(fill22));
    expect(i22.status).toBe("valid-with-benign-residual");
    expect(i22.nonConvergedYearList).toEqual([2038, 2049, 2056]);
    expect(i22.maxMismatchGainsCents).toBe(1);
    expect(i22.maxMismatchPretaxCents).toBe(0);
    const fill12 = cmp.scenarios.find((s) => s.name === "Fill 12%")!;
    const i12 = assessCandidateIntegrity(asResult(fill12));
    expect(i12.status).toBe("valid");
    expect(i12.nonConvergedYears).toBe(0);
    expect(i12.ceilingBreachedYears).toBe(27);
    expect(i12.ceilingBreachedAtZeroConversionYears).toBe(27);
  });

  test("single-filer equivalent of the Oct 25 case: Do Nothing, year 2049, 1¢ gains", () => {
    const res = simulateRothPlan(singleFilerInputs(), DO_NOTHING as never, undefined, {
      leanDetail: true,
    });
    const i = assessCandidateIntegrity(res);
    expect(i.status).toBe("valid-with-benign-residual");
    expect(i.nonConvergedYearList).toEqual([2049]);
    expect(i.maxMismatchGainsCents).toBe(1);
    expect(i.maxMismatchPretaxCents).toBe(0);
  });

  test("depleted plan: unfunded spending makes the candidate invalid", () => {
    const res = simulateRothPlan(
      samplePlanInputs({ pretaxStart: 10000, taxableStart: 10000, rothStart: 0, hsaStart: 0 }),
      FILL12 as never,
      undefined,
      { leanDetail: true },
    );
    const i = assessCandidateIntegrity(res);
    expect(i.status).toBe("invalid");
    expect(i.spendShortfallTotal).toBe(3893689.88);
    expect(i.unpaidTaxTotal).toBe(0);
    expect(i.reasons.join(" ")).toMatch(/unfunded spending of \$3,893,690/);
  });

  test("no balances at all: assessed tax stays in the objective, unpaid — invalid", () => {
    // Social Security $150,000/yr against $150,000/yr of
    // spending, retiring at 67, no balances anywhere: the
    // $28,530.49 of federal tax the benefits create has no
    // balance to pay it from.
    const inputs = samplePlanInputs({
      pretaxStart: 0,
      taxableStart: 0,
      rothStart: 0,
      hsaStart: 0,
      annualSpending: 150000,
      retirementAge: 67,
      ssPrimaryAnnual: 90000,
      ssPrimaryStartAge: 67,
      ssSpouseAnnual: 60000,
      ssSpouseStartAge: 67,
    });
    const res = simulateRothPlan(inputs, DO_NOTHING as never, undefined, {
      leanDetail: true,
    });
    expect(res.lifetimeFederalTax).toBe(28530.49);
    expect(res.lifetimeUnpaidTax).toBe(28530.49);
    const i = assessCandidateIntegrity(res);
    expect(i.status).toBe("invalid");
    expect(i.unpaidTaxTotal).toBe(28530.49);
    expect(i.spendShortfallTotal).toBe(120000);
    expect(i.reasons.join(" ")).toMatch(/unpaid tax of \$28,530/);
    // The uncollected tax does NOT disappear from the
    // objective: the net-cost tax line carries the full
    // assessed amount.
    const cost = planNetCost(res, inputs);
    expect(cost.tax).toBe(28530.49);
  });
});

describe("E4-S2 — distinct optimization objectives (selectors)", () => {
  test("one candidate dominates: both winners agree", () => {
    const crowned = crownOptimizerWinners(
      sortScored([fakeScored("a", 100, 500, true), fakeScored("b", 200, 400, true)]),
    );
    expect(crowned.winnerByNetCost.spec.key).toBe("a");
    expect(crowned.winnerByEndingWealth.spec.key).toBe("a");
    expect(crowned.selectedWinner.spec.key).toBe("a");
    expect(crowned.winnersDiffer).toBe(false);
    expect(crowned.winnerQualified).toBe(true);
    expect(crowned.excludedInvalidWinner).toBeNull();
  });

  test("cost and wealth conflict: different winners are returned", () => {
    const crowned = crownOptimizerWinners(
      sortScored([fakeScored("a", 100, 400, true), fakeScored("b", 200, 500, true)]),
    );
    expect(crowned.winnerByNetCost.spec.key).toBe("a");
    expect(crowned.winnerByEndingWealth.spec.key).toBe("b");
    expect(crowned.selectedWinner.spec.key).toBe("a");
    expect(crowned.winnersDiffer).toBe(true);
  });

  test("equal net costs use the established tie-breaker (ending wealth)", () => {
    const crowned = crownOptimizerWinners(
      sortScored([fakeScored("a", 100, 400, true), fakeScored("b", 100, 500, true)]),
    );
    expect(crowned.winnerByNetCost.spec.key).toBe("b");
    expect(crowned.winnerByEndingWealth.spec.key).toBe("b");
    expect(crowned.winnersDiffer).toBe(false);
  });

  test("cheapest candidate invalid: excluded, disclosed, best valid crowned", () => {
    const crowned = crownOptimizerWinners(
      sortScored([
        fakeScored("cheap-invalid", 50, 900, false),
        fakeScored("b", 100, 400, true),
        fakeScored("c", 200, 500, true),
      ]),
    );
    expect(crowned.winnerByNetCost.spec.key).toBe("b");
    expect(crowned.winnerByEndingWealth.spec.key).toBe("c");
    expect(crowned.selectedWinner.spec.key).toBe("b");
    expect(crowned.winnersDiffer).toBe(true);
    expect(crowned.winnerQualified).toBe(true);
    expect(crowned.excludedInvalidWinner?.candidate.spec.key).toBe("cheap-invalid");
    expect(crowned.excludedInvalidWinner?.integrity.reasons).toEqual([
      "synthetic material discrepancy",
    ]);
    expect(crowned.validCandidatesTested).toBe(2);
    expect(crowned.invalidCandidatesTested).toBe(1);
  });

  test("no valid candidate: raw winner crowned, qualified false, exclusion disclosed", () => {
    const crowned = crownOptimizerWinners(
      sortScored([fakeScored("a", 50, 900, false), fakeScored("b", 100, 400, false)]),
    );
    expect(crowned.winnerQualified).toBe(false);
    expect(crowned.selectedWinner.spec.key).toBe("a");
    expect(crowned.excludedInvalidWinner?.candidate.spec.key).toBe("a");
    expect(crowned.validCandidatesTested).toBe(0);
  });

  test("candidate ordering is deterministic on repeated sorts", () => {
    const list = [
      fakeScored("a", 100, 400, true),
      fakeScored("b", 200, 500, true),
      fakeScored("c", 100, 500, true),
    ];
    const once = sortScored(list).map((s) => s.spec.key);
    const twice = sortScored(list).map((s) => s.spec.key);
    expect(twice).toEqual(once);
    // Equal net cost sorts the higher wealth first (tie-break).
    expect(once[0]).toBe("c");
  });
});

describe("E4-S2 — distinct optimization objectives (engine runs)", () => {
  test(
    "MFJ sample household: cost winner and wealth winner differ, both named",
    () => {
      const opt = mfjOptimizer();
      expect(opt.candidatesTested).toBe(3025);
      expect(opt.validCandidatesTested).toBe(3025);
      expect(opt.invalidCandidatesTested).toBe(0);
      expect(opt.winnerQualified).toBe(true);
      expect(opt.excludedInvalidWinner).toBeNull();
      // Do Nothing is always in the candidate set.
      expect(opt.scored.some((s) => s.spec.key === "do-nothing")).toBe(true);
      expect(opt.doNothing.spec.key).toBe("do-nothing");
      // Cost-first winner: Fill to the top of the 32% bracket
      // with gain harvesting into the 0% bracket.
      // RE-PINNED (Engine Review C3, C3-V1, 2026-11-15): the
      // winner harvests, so its lifetime federal tax now
      // includes the harvest pay-sale tax the pre-fix engine
      // never priced — net cost $576,325.07 -> $577,187.22
      // (+$862.15, exactly the winner's lifetime federal-tax
      // move in the lifetime-totals test below, where the
      // per-year sum still equals the lifetime field) and
      // ending wealth $11,558,526.31 -> $11,556,221.56 (the
      // extra tax paid from Taxable plus foregone growth).
      // The winner key is unchanged; the wealth winner's
      // figures are unmoved (its harvest shape prices no
      // pay-sale gains), so only the gaps move with the
      // cost winner: wealth gap $342,611.85 -> $344,916.60,
      // net-cost gap $873,557.10 -> $872,694.95.
      expect(opt.winner.spec.key).toBe("32|-|-|-|-:74:-:-:taxable-pretax-roth:hv");
      expect(opt.winner.cost.netCost).toBe(577187.22);
      expect(opt.winner.result.endingAfterTaxWealth).toBe(11556221.56);
      expect(opt.selectedWinner.spec.key).toBe(opt.winner.spec.key);
      expect(opt.winnerByNetCost.spec.key).toBe(opt.winner.spec.key);
      // Ending-wealth winner: Fill to a $150,000 MAGI cap with
      // gain harvesting — $344,916.60 more wealth for
      // $872,694.95 more net cost. The objectives disagree,
      // and the result says so.
      expect(opt.winnerByEndingWealth.spec.key).toBe(
        "-|-|-|-|150000:74:-:-:taxable-pretax-roth:hv",
      );
      expect(opt.winnerByEndingWealth.cost.netCost).toBe(1449882.17);
      expect(opt.winnerByEndingWealth.result.endingAfterTaxWealth).toBe(11901138.16);
      expect(opt.winnersDiffer).toBe(true);
      expect(
        opt.winnerByEndingWealth.result.endingAfterTaxWealth -
          opt.winner.result.endingAfterTaxWealth,
      ).toBeCloseTo(344916.6, 2);
      // The winner's own march settled cleanly.
      expect(opt.winner.integrity.status).toBe("valid");
    },
    900_000,
  );

  test(
    "single-filer sample household: cost winner and wealth winner differ",
    () => {
      const opt = singleOptimizer();
      expect(opt.candidatesTested).toBe(3025);
      expect(opt.winner.spec.key).toBe("-|-|-|-|500000:74:-:-:taxable-pretax-roth:hv");
      expect(opt.winner.cost.netCost).toBe(840858.44);
      expect(opt.winner.result.endingAfterTaxWealth).toBe(8762798.78);
      expect(opt.winnerByEndingWealth.spec.key).toBe(
        "-|1|-|-|-:74:-:-:taxable-pretax-roth:hv",
      );
      expect(opt.winnerByEndingWealth.cost.netCost).toBe(1917613.08);
      expect(opt.winnerByEndingWealth.result.endingAfterTaxWealth).toBe(9126569.06);
      expect(opt.winnersDiffer).toBe(true);
      expect(opt.winnerQualified).toBe(true);
      expect(opt.excludedInvalidWinner).toBeNull();
    },
    900_000,
  );

  test(
    "stable winner selection on repeated identical runs",
    () => {
      const first = mfjOptimizer();
      const second = runOptimizer(samplePlanInputs());
      expect(second.winner.spec.key).toBe(first.winner.spec.key);
      expect(second.winner.cost.netCost).toBe(first.winner.cost.netCost);
      expect(second.winnerByEndingWealth.spec.key).toBe(
        first.winnerByEndingWealth.spec.key,
      );
      expect(second.candidatesTested).toBe(first.candidatesTested);
      expect(second.scored.map((s) => s.spec.key)).toEqual(
        first.scored.map((s) => s.spec.key),
      );
    },
    900_000,
  );

  test("fixed-age search scope: windows, orders, held-fixed claiming ages", () => {
    const opt = mfjOptimizer();
    expect(opt.objective).toMatch(/Lowest lifetime net cost first/);
    expect(opt.objective).toMatch(/not a mathematical global optimum/);
    // Stop ages: stop at 65 / stop the year before RMDs begin
    // (RMD age 75 for a 1968 birth year, so 74) / through the
    // RMD years to the end age 95.
    expect(opt.searchScope.windowStopAges).toEqual([65, 74, 95]);
    expect(opt.searchScope.drawOrdersSearched).toBe(true);
    expect(opt.searchScope.drawOrderLabels).toHaveLength(6);
    expect(opt.searchScope.claimingAgesSearched).toBe(false);
    expect(opt.searchScope.claimingAgeCombinations).toBe(1);
    expect(opt.searchScope.heldFixed).toEqual([
      "claiming ages (held at the entered ages: primary claims at 67, spouse claims at 67)",
    ]);
    expect(opt.searchScope.ceilingFamilies.join(" ")).toMatch(/federal bracket top/);
    expect(opt.searchScope.ceilingFamilies.join(" ")).toMatch(/IRMAA tier/);
    expect(opt.searchScope.ceilingFamilies.join(" ")).toMatch(/ACA-cliff/);
    expect(opt.searchScope.ceilingFamilies.join(" ")).toMatch(/MAGI-cap/);
    expect(opt.searchScope.description).toMatch(/Claiming ages: held at the entered ages/);
  }, 900_000);

  test(
    "held-order sensitivity scope: draw order held fixed, disclosed",
    () => {
      const opt = runOptimizer(samplePlanInputs(), { searchOrders: false });
      // One draw order: 504 conversion candidates + Do Nothing
      // = 505 — the same per-order count the six-order 3,025
      // total is built from (6 × 504 + 1).
      expect(opt.candidatesTested).toBe(505);
      expect(opt.searchScope.drawOrdersSearched).toBe(false);
      expect(opt.searchScope.drawOrderLabels).toEqual(["Taxable → Pre-tax → Roth"]);
      expect(opt.searchScope.heldFixed.join(" ")).toMatch(/draw order \(held at the plan order/);
      expect(opt.searchScope.heldFixed.join(" ")).toMatch(/claiming ages/);
    },
    300_000,
  );

  test(
    "joint search scope: claiming ages searched, draw order held fixed",
    () => {
      // Primary already receiving (claim entered at 58, the
      // current age) is LOCKED to that single age; the spouse
      // (56, claim entered at 67, not yet made) is searched
      // over 62–70: 9 combinations (1 locked primary age × 9
      // spouse ages), each at the plan's draw order.
      // searchedPrimary stays true: the primary's benefit IS
      // part of the joint search — it is locked, not absent
      // (the engine's established meaning: a benefit entered
      // is searched; locked only freezes its age — see the
      // lockedSpouse alongside searchedSpouse note fixtures).
      const inputs = samplePlanInputs({
        ssPrimaryAnnual: 48000,
        ssPrimaryStartAge: 58,
        ssSpouseAnnual: 30000,
        ssSpouseStartAge: 67,
      });
      const joint = runJointOptimizer(inputs);
      expect(joint.jointSearch.combosTested).toBe(9);
      expect(joint.jointSearch.searchedPrimary).toBe(true);
      expect(joint.jointSearch.searchedSpouse).toBe(true);
      expect(joint.jointSearch.lockedPrimary).toBe(true);
      expect(joint.searchScope.claimingAgesSearched).toBe(true);
      expect(joint.searchScope.claimingAgeCombinations).toBe(9);
      expect(joint.searchScope.drawOrdersSearched).toBe(false);
      expect(joint.searchScope.heldFixed.join(" ")).toMatch(
        /draw order \(held at the plan order/,
      );
      expect(joint.searchScope.description).toMatch(
        /Claiming ages: searched jointly/,
      );
      expect(joint.winnerQualified).toBe(true);
      expect(joint.excludedInvalidWinner).toBeNull();
      expect(joint.winnerByNetCost.spec.key).toBe(joint.selectedWinner.spec.key);
      // The wealth winner is one of the candidates actually tested.
      expect(
        joint.scored.some(
          (s) => s.spec.key === joint.winnerByEndingWealth.spec.key,
        ),
      ).toBe(true);
    },
    900_000,
  );

  test(
    "joint search with a locked claim below the floor: no eligible candidate falls back to the plain best",
    () => {
      // Primary already receiving at 58 (locked: entered age at
      // the current age) with the floor at 70, so NO candidate
      // is eligible — the documented fallback crowns the plain
      // best instead of crowning nothing, and claimAgeFloorMet
      // reports the conflict (false unless the winner is the
      // floor-exempt Do Nothing). Regression: the first E4
      // cut passed the empty eligible list straight to
      // crownOptimizerWinners, which requires a non-empty list.
      // MFJ shape on purpose: the single-filer shape yields
      // exactly 1 combination and takes the combos.length <= 1
      // early return, which never executes the fallback — with
      // 9 combinations (1 locked primary age × 9 spouse ages
      // 62–70) this test genuinely runs the empty-eligible
      // fallback (rothOptimizer.ts:1677).
      const inputs = samplePlanInputs({
        ssPrimaryAnnual: 48000,
        ssPrimaryStartAge: 58,
        ssSpouseAnnual: 30000,
        ssSpouseStartAge: 67,
        claimAgeFloor: 70,
      });
      const joint = runJointOptimizer(inputs);
      expect(joint.jointSearch.combosTested).toBe(9);
      expect(joint.jointSearch.lockedPrimary).toBe(true);
      expect(joint.jointSearch.searchedSpouse).toBe(true);
      expect(joint.winner.claimAges.primaryAge).toBe(58);
      expect(joint.claimAgeFloorMet).toBe(false);
      expect(joint.winnerQualified).toBe(true);
      expect(joint.candidatesTested).toBe(4545);
      // The early-return path clears the per-age table; a
      // non-empty table proves the fallback branch ran.
      expect(joint.claimAgeTable.length).toBeGreaterThan(0);
    },
    900_000,
  );
});

describe("Section 4 — independently verified conversion arithmetic", () => {
  test("Social Security at 70 from the $48,000-at-67 anchor: $59,520 by hand", () => {
    // Born 1968, FRA 67: delaying to 70 earns 8%/yr × 3 years
    // = 24%. $48,000 × 1.24 = $59,520.
    expect(ssAnnualAtClaimAge(48000, 67, 70, 1968)).toBe(59520);
    expect(ssAnnualAtClaimAge(48000, 67, 67, 1968)).toBe(48000);
    // Claiming at 62: 60 months early — 36 × 5/9% + 24 × 5/12%
    // = 20% + 10% = 30% reduction. $48,000 × 0.70 = $33,600.
    expect(ssAnnualAtClaimAge(48000, 67, 62, 1968)).toBe(33600);
  });

  test(
    "Social Security from both spouses: $48,000 + $30,000 once both claim",
    () => {
      // First caller of the cached mfjOptimizer() in this
      // block: without an explicit timeout it dies on Bun's
      // 5s default while the ~45–63s optimizer run is still
      // computing, but only when Section 4 runs filtered
      // (in full-file order the earlier engine tests warm the
      // cache). 900_000 matches the neighboring heavy tests.
      const opt = mfjOptimizer();
      const y2035 = opt.winner.result.years.find((y) => y.year === 2035)!;
      const y2037 = opt.winner.result.years.find((y) => y.year === 2037)!;
      // Primary turns 67 in 2035; spouse turns 67 in 2037.
      expect(y2035.ssBenefits).toBe(48000);
      expect(y2037.ssBenefits).toBe(78000);
      // Lifetime: primary 29 years (2035–2063) × $48,000 plus
      // spouse 27 years (2037–2063) × $30,000.
      expect(opt.winner.result.lifetimeSsCollected).toBe(29 * 48000 + 27 * 30000);
      expect(opt.winner.result.lifetimeSsCollected).toBe(2202000);
      const sum = r2(
        opt.winner.result.years.reduce((a, y) => a + y.ssBenefits, 0),
      );
      expect(sum).toBe(opt.winner.result.lifetimeSsCollected);
    },
    900_000,
  );

  test("terminal tax: the stated rule, hand-computed, with and without the reserve", () => {
    const opt = mfjOptimizer();
    const dn = opt.doNothing;
    // Ending pre-tax $2,196,768.54. WITHOUT a reserve the
    // direct sample shape prices the flat heir rate (the
    // samplePlanInputs shape carries no preservePretax — the
    // $250,000 reserve lives on the compare path, not on the
    // direct inputs): $2,196,768.54 × 24% = $527,224.45.
    expect(dn.result.endingPretax).toBe(2196768.54);
    expect(dn.cost.terminal).toBe(527224.45);
    expect(r2(dn.result.endingPretax * 0.24)).toBe(527224.45);
    // WITH the reserve ($250,000 at the 10% exit rate, the
    // excess at 24%): $25,000 + $1,946,768.54 × 24%.
    const withReserve = netCostBreakdown(dn.result, 24, {
      preservePretax: 250000,
      preserveExitRatePct: 10,
    });
    expect(withReserve.preservedPretax).toBe(250000);
    expect(withReserve.terminalPreserved).toBe(25000);
    expect(r2(1946768.54 * 0.24)).toBe(467224.45);
    expect(withReserve.terminalExcess).toBe(467224.45);
    expect(withReserve.terminal).toBe(492224.45);
    // The winner converted the pre-tax balance to $0, so its
    // terminal tax is $0 under either pricing.
    expect(opt.winner.result.endingPretax).toBe(0);
    expect(opt.winner.cost.terminal).toBe(0);
  });

  test("ending after-tax wealth: ending balances less terminal tax, to the cent", () => {
    const opt = mfjOptimizer();
    for (const s of [opt.winner, opt.doNothing, opt.winnerByEndingWealth]) {
      const hand = r2(
        s.result.endingPretax +
          s.result.endingRoth +
          s.result.endingTaxable +
          s.result.endingHsa -
          s.cost.terminal,
      );
      // Within $0.01: the engine sums unrounded balances and
      // rounds once, while this check rounds each component
      // first — the two roundings differ by at most a cent.
      expect(Math.abs(hand - s.result.endingAfterTaxWealth)).toBeLessThanOrEqual(0.01);
    }
    // The wealth is after-tax, never gross balances: the
    // winner's gross ending balances exceed its wealth by
    // exactly its terminal tax ($0 here — it converted
    // everything), while Do Nothing's gross exceeds its wealth
    // by its $527,224.45 terminal tax.
    const dn = opt.doNothing;
    const gross =
      dn.result.endingPretax +
      dn.result.endingRoth +
      dn.result.endingTaxable +
      dn.result.endingHsa;
    // Same rounding as the loop above: the engine sums
    // unrounded balances and rounds once, so the hand-sum of
    // rounded components can differ by a cent (here $0.01).
    // r2 the difference itself: 527224.46 − 527224.45 is
    // 0.0100000000093 in binary floats.
    expect(
      r2(Math.abs(r2(gross - dn.result.endingAfterTaxWealth) - dn.cost.terminal)),
    ).toBeLessThanOrEqual(0.01);
  });

  test("net-cost identity: components re-added by hand equal the score", () => {
    const opt = mfjOptimizer();
    for (const s of [opt.winner, opt.doNothing, opt.winnerByEndingWealth]) {
      const c = s.cost;
      expect(
        r2(
          c.tax +
            c.penalty +
            c.irmaa +
            c.healthPremium -
            c.acaCredit -
            c.educationRefundable +
            c.terminal,
        ),
      ).toBe(c.netCost);
    }
  });

  test("lifetime totals are the sums of the priced years (tax counted once)", () => {
    const opt = mfjOptimizer();
    const years = opt.winner.result.years;
    expect(r2(years.reduce((a, y) => a + y.federalTax, 0))).toBe(
      opt.winner.result.lifetimeFederalTax,
    );
    // RE-PINNED (Engine Review C3, C3-V1, 2026-11-15): the
    // winner harvests, so the per-year federal-tax sum now
    // includes the harvest pay-sale tax — $538,193.87 ->
    // $539,056.02 (+$862.15). The identity (sum equals the
    // lifetime field) still holds, per the expect above.
    expect(r2(years.reduce((a, y) => a + y.federalTax, 0))).toBe(539056.02);
    expect(r2(years.reduce((a, y) => a + y.stateTax, 0))).toBe(
      opt.winner.result.lifetimeStateTax,
    );
    expect(r2(years.reduce((a, y) => a + y.irmaaPaid, 0))).toBe(
      opt.winner.result.lifetimeIrmaa,
    );
    expect(r2(years.reduce((a, y) => a + y.acaCreditKept, 0))).toBe(
      opt.winner.result.lifetimeAcaKept,
    );
    expect(r2(years.reduce((a, y) => a + y.conversion, 0))).toBeGreaterThan(0);
  });

  test("federal tax by hand: $100,000 ordinary, MFJ 2026", () => {
    // AGI $100,000; standard deduction $32,200; taxable
    // $67,800: 10% × $24,800 = $2,480 plus 12% × $43,000 =
    // $5,160 — $7,640. No gains, no Social Security, no state.
    const p = priceYear({
      calendarYear: 2026,
      filingStatus: "mfj",
      agePrimary: 58,
      ageSpouse: 56,
      otherOrdinary: 100000,
      rmd: 0,
      conversion: 0,
      extraPreTaxDraw: 0,
      ssBenefits: 0,
      taxExemptInterest: 0,
      ltcg: 0,
      inflationPct: 2.5,
      stateRatePct: 0,
    });
    expect(p.agi).toBe(100000);
    expect(p.taxableIncome).toBe(67800);
    expect(p.federalTax).toBe(7640);
    expect(p.stateTax).toBe(0);
  });

  test("federal tax by hand: qualified dividends price in the 0% space", () => {
    // $55,000 ordinary + $20,000 qualified: AGI $75,000,
    // taxable $42,800. Ordinary part $22,800: 10% × $22,800
    // = $2,280. The $20,000 qualified sits under the 0% top
    // ($96,700), so it adds $0 of tax.
    const p = priceYear({
      calendarYear: 2026,
      filingStatus: "mfj",
      agePrimary: 58,
      ageSpouse: 56,
      otherOrdinary: 55000,
      rmd: 0,
      conversion: 0,
      extraPreTaxDraw: 0,
      ssBenefits: 0,
      taxExemptInterest: 0,
      ltcg: 0,
      qualifiedDividends: 20000,
      inflationPct: 2.5,
      stateRatePct: 0,
    });
    expect(p.agi).toBe(75000);
    expect(p.taxableIncome).toBe(42800);
    expect(p.federalTax).toBe(2280);
  });

  test("RMD by hand: $1,000,000 at 75 / spouse 64, joint table divisor 25.3", () => {
    // $1,000,000 ÷ 25.3 = $39,525.691… → $39,525.69.
    const r = rmdForYear({
      priorDec31PreTax: 1000000,
      agePrimary: 75,
      ageSpouse: 64,
      birthYearPrimary: 1969,
      spouseSoleBeneficiary: true,
    });
    expect(r.divisor).toBe(25.3);
    expect(r.table).toBe("joint");
    expect(r.rmd).toBe(39525.69);
    expect(r2(1000000 / 25.3)).toBe(39525.69);
    // Before the RMD age (75 for a 1969 birth year): no RMD.
    expect(
      rmdForYear({
        priorDec31PreTax: 1000000,
        agePrimary: 57,
        ageSpouse: 46,
        birthYearPrimary: 1969,
        spouseSoleBeneficiary: true,
      }).rmd,
    ).toBe(0);
  });

  test("IRMAA by hand: tier surcharges from the 2026 law row", () => {
    const law = lawForYear(2026);
    // Tier 1: ($284.10 − $202.90 Part B + $14.50 Part D) × 12
    // = $95.70 × 12 = $1,148.40 per person per year. Tier 2:
    // ($405.80 − $202.90 + $37.50) × 12 = $240.40 × 12.
    expect(irmaaAnnualPerPerson(0, law)).toBe(0);
    expect(irmaaAnnualPerPerson(1, law)).toBe(1148.4);
    expect(r2((284.1 - 202.9 + 14.5) * 12)).toBe(1148.4);
    expect(irmaaAnnualPerPerson(2, law)).toBe(2884.8);
    expect(r2((405.8 - 202.9 + 37.5) * 12)).toBe(2884.8);
  });

  test("ACA boundary: over the cliff, the credit is $0", () => {
    // 2026 household-of-4 poverty line $33,000; the cliff is
    // 400% = $132,000. Fill 22% pushes five ACA years over it.
    expect(fplFor(4, 2026)).toBe(33000);
    expect(fplFor(4, 2026) * 4).toBe(132000);
    const res = simulateRothPlan(samplePlanInputs(), FILL22 as never, undefined, {
      leanDetail: true,
    });
    const over = res.years.filter((y) => y.acaActive && y.acaMagi > 132000);
    expect(over.length).toBe(5);
    for (const y of over) expect(y.acaCreditKept).toBe(0);
    const y2030 = res.years.find((y) => y.year === 2030)!;
    expect(y2030.acaMagi).toBe(228616.63);
    expect(y2030.acaCreditKept).toBe(0);
  });

  test("IRMAA boundary: a Tier-1-capped candidate never converts past the tier", () => {
    const res = simulateRothPlan(
      samplePlanInputs(),
      {
        id: "t1",
        name: "Fill 22% IRMAA Tier 1",
        ceilings: {
          bracketTopPct: 22,
          irmaaTierCap: 1,
          ltcgZeroCap: false,
          acaCliffCap: false,
          acaCliffCapFamilyOnly: false,
          magiCap: null,
          acaCliffBuffer: null,
        },
      } as never,
      undefined,
      { leanDetail: true },
    );
    expect(res.years.filter((y) => y.conversion > 0 && y.ceilingBreached)).toHaveLength(0);
    expect(res.years.filter((y) => y.ceilingBreached)).toHaveLength(0);
  });

  test("RMD and conversion in the same year (through-RMD window)", () => {
    const opt = mfjOptimizer();
    const cand = opt.scored.find(
      (s) => s.spec.key === "22|1|-|-|-:95:-:-:roth-pretax-taxable:hv",
    )!;
    expect(cand.spec.windowKind).toBe("throughRmd");
    const both = cand.result.years.filter((y) => y.rmd > 0 && y.conversion > 0);
    expect(both.length).toBe(3);
    // First RMD year (primary 75, 2043): the RMD is taken and
    // the fill still converts on top of it.
    expect(both[0]!.year).toBe(2043);
    expect(both[0]!.rmd).toBe(13117.58);
    expect(both[0]!.conversion).toBe(106092.03);
  });

  test("annual funding identity foots exactly (conversions never fund needs)", () => {
    // Twelve sources + spend shortfall + unpaid tax = total
    // need, every year. The conversion is a transfer between
    // buckets, not a source: it appears in none of the twelve.
    const funding = buildRothFunding(samplePlanInputs(), FILL12);
    expect(funding).toHaveLength(38);
    for (const row of funding) {
      const sources =
        row.ssCents +
        row.rmdCents +
        row.taxExemptCents +
        row.otherIncomeCents +
        row.interestYieldCents +
        row.dividendYieldCents +
        row.cashSpendCents +
        row.pretaxDrawCents +
        row.taxableSoldForSpendingCents +
        row.taxableSoldForTaxCents +
        row.rothDrawCents +
        row.salarySurplusCents;
      expect(sources + row.spendShortfallCents + row.unpaidTaxCents).toBe(
        row.totalNeedCents,
      );
    }
    // The same identity on the winner's own strategy, whose
    // conversions are large: the transfer still funds nothing.
    const opt = mfjOptimizer();
    const winnerFunding = buildRothFunding(
      samplePlanInputs(),
      candidateStrategy(opt.winner.spec),
    );
    expect(winnerFunding).toHaveLength(38);
    expect(
      winnerFunding.reduce((a, r) => a + r.conversionCents, 0),
    ).toBeGreaterThan(0);
    for (const row of winnerFunding) {
      const sources =
        row.ssCents +
        row.rmdCents +
        row.taxExemptCents +
        row.otherIncomeCents +
        row.interestYieldCents +
        row.dividendYieldCents +
        row.cashSpendCents +
        row.pretaxDrawCents +
        row.taxableSoldForSpendingCents +
        row.taxableSoldForTaxCents +
        row.rothDrawCents +
        row.salarySurplusCents;
      expect(sources + row.spendShortfallCents + row.unpaidTaxCents).toBe(
        row.totalNeedCents,
      );
    }
  });
});

describe("Section 4 — tax funding from each available account", () => {
  test("tax paid from Taxable: sales cover the bill, no pre-tax or Roth money", () => {
    const funding = buildRothFunding(samplePlanInputs(), FILL22);
    const sum = (f: (r: (typeof funding)[number]) => number) =>
      r2(funding.reduce((a, r) => a + f(r), 0));
    expect(sum((r) => r.taxableSoldForTaxCents)).toBe(60816656);
    expect(sum((r) => r.pretaxDrawCents)).toBe(0);
    expect(sum((r) => r.rothDrawCents)).toBe(0);
  });

  test("tax withheld from the conversion: pre-tax money pays the bill", () => {
    const funding = buildRothFunding(
      samplePlanInputs({ payTaxFrom: "conversion" }),
      FILL22,
    );
    const sum = (f: (r: (typeof funding)[number]) => number) =>
      r2(funding.reduce((a, r) => a + f(r), 0));
    // The withholding is the pre-tax draw less its spending
    // and tax-debit components (both $0 here): pre-tax money
    // applied to the bill through the conversion itself.
    const withholding = sum(
      (r) => r.pretaxDrawCents - r.pretaxSpendingDrawCents - r.pretaxTaxDebitCents,
    );
    expect(sum((r) => r.pretaxSpendingDrawCents)).toBe(0);
    expect(sum((r) => r.pretaxTaxDebitCents)).toBe(0);
    expect(withholding).toBe(23728208);
    expect(withholding).toBeGreaterThan(0);
    // After the conversion window closes there is no
    // conversion left to withhold from, so the remaining
    // bills overflow to Taxable — the channel is visible in
    // both legs, not only the withholding.
    expect(sum((r) => r.taxableSoldForTaxCents)).toBe(64203229);
  });

  test("tax paid from Pre-tax: the overflow debit chain reaches pre-tax", () => {
    // Taxable $10,000 — under the $50,000 protect minimum, so
    // the Taxable channel can pay nothing and the bill
    // overflows to Pre-tax (Do Nothing converts nothing, so
    // there is no conversion withholding to absorb it either).
    const funding = buildRothFunding(
      samplePlanInputs({ taxableStart: 10000, taxableBasisPct: 100 }),
      DO_NOTHING,
    );
    const sum = (f: (r: (typeof funding)[number]) => number) =>
      r2(funding.reduce((a, r) => a + f(r), 0));
    expect(sum((r) => r.pretaxTaxDebitCents)).toBe(37814868);
    expect(sum((r) => r.taxableSoldForTaxCents)).toBe(0);
    const debitYears = funding
      .filter((r) => r.pretaxTaxDebitCents > 0)
      .map((r) => r.year);
    expect(debitYears.length).toBe(15);
    expect(debitYears[0]).toBe(2030);
    // The federal tax the debits paid is the sum of the
    // pre-tax legs plus the surplus cash income that paid
    // part of the bill first.
    expect(sum((r) => r.federalTaxCents)).toBe(39516420);
  });

  test("tax paid from Roth: the overflow chain reaches Roth when it must", () => {
    // No pre-tax, no taxable; Social Security $150,000/yr
    // against $150,000/yr of spending from age 67, Roth the
    // only balance. The benefits' taxable part creates a tax
    // bill the cash income cannot cover (it exactly funds
    // spending), so the debit chain lands on Roth.
    const inputs = samplePlanInputs({
      pretaxStart: 0,
      taxableStart: 0,
      rothStart: 400000,
      hsaStart: 0,
      annualSpending: 150000,
      retirementAge: 67,
      ssPrimaryAnnual: 90000,
      ssPrimaryStartAge: 67,
      ssSpouseAnnual: 60000,
      ssSpouseStartAge: 67,
    });
    const funding = buildRothFunding(inputs, DO_NOTHING);
    const sum = (f: (r: (typeof funding)[number]) => number) =>
      r2(funding.reduce((a, r) => a + f(r), 0));
    expect(sum((r) => r.taxableSoldForTaxCents)).toBe(0);
    expect(sum((r) => r.pretaxTaxDebitCents)).toBe(0);
    expect(sum((r) => r.federalTaxCents)).toBe(2853049);
    expect(sum((r) => r.rothDrawCents)).toBe(14853049);
    // The cross-foot: Roth's total draw is the tax it paid
    // ($28,530.49) plus the spending it funded in 2035–2036,
    // when only the primary's $90,000 benefit had started
    // against $150,000 of spending ($60,000/yr × 2).
    expect(sum((r) => r.rothDrawCents)).toBe(
      sum((r) => r.federalTaxCents) + 12000000,
    );
    // In a full-benefit year the Roth draw IS the tax bill,
    // to the cent — Roth paid that year's tax and nothing else.
    const y2037 = funding.find((r) => r.year === 2037)!;
    expect(y2037.rothDrawCents).toBe(43187);
    expect(y2037.federalTaxCents).toBe(43187);
    expect(y2037.taxableSoldForTaxCents).toBe(0);
    expect(y2037.pretaxTaxDebitCents).toBe(0);
  });
});
