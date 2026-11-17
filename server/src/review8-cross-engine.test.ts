// review8-cross-engine.test.ts — Review 8, engine-level matrix
// (§5): the checks that live BELOW the adapter, on the shared
// primitives every engine prices through. The adapter-level matrix
// (assistant-api/tests/review8-cross-engine.test.ts) proves the
// adapter and the engines agree; this file proves the engines agree
// with each other — and with hand-derived values, never snapshots
// as the sole proof.
//
// All figures are the fictional sample household
// (server/src/sampleHousehold.ts) or hand-built small cases on it.
// NEVER real figures.

import { describe, expect, test } from "bun:test";
import {
  acaCreditFor,
  irmaaAnnualPerPerson,
  irmaaTierFor,
  priceYear,
  rmdForYear,
  uniformRmdFor,
  type PriceYearInput,
} from "./taxEngine";
import { lawForYear } from "./taxLaw";
import {
  claimAgeCombos,
  enteredClaimInfo,
  pricePlaygroundYear,
  type PlaygroundYearInputs,
} from "./rothOptimizer";
import {
  GUARDRAILS_ADJUSTMENT_DEFAULT,
  GUARDRAILS_CUT_DEFAULT,
  GUARDRAILS_RAISE_DEFAULT,
  PHASE_DECLINE_PCT_DEFAULT,
  PHASE_START_AGE_DEFAULT,
  runMonteCarlo,
  type SimInputs,
} from "./retirementEngines";
import { samplePlanInputs } from "./sampleHousehold";

const r2 = (n: number) => Math.round(n * 100) / 100;

describe("RMD: one shared helper, both engines (work-years + Roth march)", () => {
  test("rmdForYear and uniformRmdFor agree on the same owner", () => {
    // Primary 73, spouse 70: a 3-year gap, so the uniform table
    // applies on both paths. Hand-derived: $1,000,000 / 26.5.
    const shared = rmdForYear({
      priorDec31PreTax: 1000000,
      agePrimary: 73,
      ageSpouse: 70,
      birthYearPrimary: 1953,
      spouseSoleBeneficiary: true,
    });
    const own = uniformRmdFor({
      priorDec31PreTax: 1000000,
      age: 73,
      birthYear: 1953,
    });
    expect(shared.rmd).toBe(37735.85);
    expect(shared.divisor).toBe(26.5);
    expect(shared.table).toBe("uniform");
    expect(own.rmd).toBe(shared.rmd);
    expect(own.divisor).toBe(shared.divisor);
  });

  test("below the RMD age both paths price $0 with no divisor", () => {
    const shared = rmdForYear({
      priorDec31PreTax: 1000000,
      agePrimary: 72,
      ageSpouse: 70,
      birthYearPrimary: 1953,
      spouseSoleBeneficiary: true,
    });
    const own = uniformRmdFor({
      priorDec31PreTax: 1000000,
      age: 72,
      birthYear: 1953,
    });
    expect(shared).toEqual({ rmd: 0, divisor: null, table: null });
    expect(own).toEqual({ rmd: 0, divisor: null });
  });

  test("a spouse more than 10 years younger takes the joint table, on either path's terms", () => {
    // Primary 73, spouse 60, sole beneficiary: the Joint and Last
    // Survivor Table applies — a different divisor than the
    // uniform 26.5, and the RMD is exactly balance / divisor.
    const joint = rmdForYear({
      priorDec31PreTax: 1000000,
      agePrimary: 73,
      ageSpouse: 60,
      birthYearPrimary: 1953,
      spouseSoleBeneficiary: true,
    });
    expect(joint.table).toBe("joint");
    expect(joint.divisor).not.toBeNull();
    expect(joint.divisor).not.toBe(26.5);
    expect(joint.rmd).toBe(r2(1000000 / joint.divisor!));
    // Without the sole-beneficiary fact the same ages price the
    // uniform table instead — the table selection is the fact,
    // not the ages alone.
    const uniform = rmdForYear({
      priorDec31PreTax: 1000000,
      agePrimary: 73,
      ageSpouse: 60,
      birthYearPrimary: 1953,
      spouseSoleBeneficiary: false,
    });
    expect(uniform.table).toBe("uniform");
    expect(uniform.divisor).toBe(26.5);
    expect(uniform.rmd).toBe(37735.85);
  });

  test("the spouse's own RMD runs on the spouse's own clock", () => {
    // Roles swapped: the spouse (birth year 1956, RMD age 73)
    // at 73 prices the same uniform divisor on her own balance.
    const spouse = rmdForYear({
      priorDec31PreTax: 500000,
      agePrimary: 73,
      ageSpouse: null,
      birthYearPrimary: 1956,
      spouseSoleBeneficiary: false,
    });
    const own = uniformRmdFor({
      priorDec31PreTax: 500000,
      age: 73,
      birthYear: 1956,
    });
    expect(spouse.table).toBe("uniform");
    expect(spouse.rmd).toBe(own.rmd);
    expect(spouse.rmd).toBe(r2(500000 / 26.5));
  });
});

describe("IRMAA: tier boundaries come from the published law row", () => {
  test("tiers step exactly at the published MFJ thresholds", () => {
    const law = lawForYear(2026)!;
    const tiers = law.irmaaTiers;
    expect(tiers.length).toBeGreaterThan(1);
    // Each tier's stored MFJ top is its boundary: the row stores
    // the top tier's floor minus $1 (749999), so the top tier
    // starts AT $750,000. $1 below a tier's floor prices the tier
    // below; the floor itself prices the tier at/above it.
    const mfjTops = tiers.map((t) => t.upToMfj);
    for (let i = 1; i < mfjTops.length; i++) {
      const floor = mfjTops[i - 1]! + 1; // first MAGI of tier i
      expect(irmaaTierFor(floor - 1, "mfj", law, 2026, 0)).toBe(i - 1);
      expect(irmaaTierFor(floor, "mfj", law, 2026, 0)).toBe(i);
    }
    expect(irmaaTierFor(0, "mfj", law, 2026, 0)).toBe(0);
  });

  test("the annual surcharge rises with the tier", () => {
    const law = lawForYear(2026)!;
    const amounts = [0, 1, 2, 3, 4, 5].map((tier) =>
      irmaaAnnualPerPerson(tier, law),
    );
    for (let i = 1; i < amounts.length; i++) {
      expect(amounts[i]).toBeGreaterThan(amounts[i - 1]!);
    }
    expect(amounts[0]).toBe(0);
  });
});

describe("ACA: the credit follows the statute's shape", () => {
  test("below 100% FPL prices $0 under the simplified model; over the cliff it is $0", () => {
    // Current behavior, pinned with its limitation named: the
    // engine prices $0 below 100% FPL (simplified eligibility —
    // Engine Review 6, E6-S2, owns the statutory-exceptions
    // question; no credit is awarded below the floor and no
    // Medicaid coverage is assumed). Just above 100% FPL the
    // credit exists.
    expect(
      acaCreditFor({
        magi: 0,
        householdSize: 2,
        coverageYear: 2026,
        benchmarkAnnual: 25000,
      }).credit,
    ).toBe(0);
    expect(
      acaCreditFor({
        magi: 21151,
        householdSize: 2,
        coverageYear: 2026,
        benchmarkAnnual: 25000,
      }).credit,
    ).toBeGreaterThan(0);
    expect(
      acaCreditFor({
        magi: 1000000,
        householdSize: 2,
        coverageYear: 2026,
        benchmarkAnnual: 25000,
      }).credit,
    ).toBe(0);
  });

  test("the credit falls as MAGI rises and never exceeds the benchmark", () => {
    // All four MAGIs sit above 100% FPL ($21,150 for a household
    // of 2 in coverage year 2026), so the below-100% $0 rule
    // does not shape this leg — the credit falls as MAGI rises.
    const credits = [25000, 40000, 60000, 82000].map(
      (magi) =>
        acaCreditFor({
          magi,
          householdSize: 2,
          coverageYear: 2026,
          benchmarkAnnual: 25000,
        }).credit,
    );
    for (const c of credits) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(25000);
    }
    for (let i = 1; i < credits.length; i++) {
      expect(credits[i]).toBeLessThanOrEqual(credits[i - 1]!);
    }
    expect(credits[0]).toBeGreaterThan(credits[credits.length - 1]!);
  });
});

describe("Federal tax: the single-year pricer and the shared priceYear agree", () => {
  test("pricePlaygroundYear's federal tax is priceYear's federal tax on the same stack", () => {
    const base: PriceYearInput = {
      calendarYear: 2026,
      filingStatus: "mfj",
      agePrimary: 54,
      ageSpouse: 52,
      otherOrdinary: 0,
      rmd: 0,
      conversion: 20000,
      extraPreTaxDraw: 0,
      ssBenefits: 0,
      taxExemptInterest: 0,
      ltcg: 8000,
      interestIncome: 10000,
      ordinaryDividends: 2000,
      qualifiedDividends: 3000,
      inflationPct: 0,
      stateRatePct: 0,
    };
    const priced = priceYear(base);
    const playgroundInputs: PlaygroundYearInputs = {
      taxYear: 2026,
      filingStatus: "mfj",
      agePrimary: 54,
      ageSpouse: 52,
      onMedicarePrimary: false,
      onMedicareSpouse: false,
      interest: 10000,
      ordinaryDividends: 5000,
      otherOrdinary: 0,
      taxExemptInterest: 0,
      ssPrimary: 0,
      ssSpouse: 0,
      conversion: 20000,
      spendingDraw: 0,
      cashDraw: 0,
      rothDraw: 0,
      inflationPct: 0,
      stockSold: 20000,
      stockBasis: 12000,
      qualifiedDividends: 3000,
      pretaxBalance: null,
      pretaxBalanceSpouse: null,
      rmdAlreadyReceived: 0,
      primarySoleBeneficiaryOfSpouse: null,
      spouseSoleBeneficiary: true,
      acaHouseholdSize: 2,
      acaBenchmarkAnnual: null,
      healthPremiumAcaAnnual: null,
      healthPremiumMedicarePerPerson: null,
      stateRatePct: 0,
      residenceState: "other",
      annualSpending: 114000,
    };
    const playground = pricePlaygroundYear(playgroundInputs);
    expect(playground.federalTax).toBe(priced.federalTax);
    // PriceYearResult carries no total field — its total is the
    // federal + state identity (stateRatePct is 0 here, so the
    // state leg is $0 and the sum is the federal figure).
    expect(playground.totalTax).toBe(priced.federalTax + priced.stateTax);
    expect(playground.agi).toBe(priced.agi);
    expect(playground.magi).toBe(priced.magi);
    // Hand-derived AGI: interest $10,000 + ordinary dividends
    // $5,000 + conversion $20,000 + stock gain $8,000 ($20,000
    // sold − $12,000 basis) = $43,000.
    expect(playground.agi).toBe(43000);
  });
});

describe("Monte Carlo: the same seed is the same run, below the adapter", () => {
  const simInputs: SimInputs = {
    startCents: 378700000,
    spendingCents: 11400000,
    currentAge: 54,
    retirementAge: 58,
    endAge: 95,
    extraIncomeCents: 0,
    extraIncomeStartAge: null,
    strategy: "constant",
    percentOfPortfolio: 0,
    guardrailsCutPct: GUARDRAILS_CUT_DEFAULT,
    guardrailsRaisePct: GUARDRAILS_RAISE_DEFAULT,
    guardrailsAdjustmentPct: GUARDRAILS_ADJUSTMENT_DEFAULT,
    phaseStartAge: PHASE_START_AGE_DEFAULT,
    phaseDeclinePct: PHASE_DECLINE_PCT_DEFAULT,
  };

  test("the same seed reproduces the run exactly", () => {
    const a = runMonteCarlo(simInputs, 0.05, 0.12, 12345, 1000)!;
    const b = runMonteCarlo(simInputs, 0.05, 0.12, 12345, 1000)!;
    expect(b.neverOutSuccessRate).toBe(a.neverOutSuccessRate);
    expect(b.p10).toBe(a.p10);
    expect(b.p50).toBe(a.p50);
    expect(b.p90).toBe(a.p90);
  });

  test("a different seed is a different run", () => {
    const a = runMonteCarlo(simInputs, 0.05, 0.12, 12345, 1000)!;
    const c = runMonteCarlo(simInputs, 0.05, 0.12, 999, 1000)!;
    expect(
      c.p10 !== a.p10 || c.p50 !== a.p50 || c.p90 !== a.p90,
    ).toBe(true);
  });
});

describe("Roth candidate: the joint search covers the claiming ages", () => {
  test("claimAgeCombos spans 62–70 for a benefit not yet claimed", () => {
    const inputs = samplePlanInputs();
    const entered = enteredClaimInfo(inputs);
    const combos = claimAgeCombos(inputs);
    expect(combos.length).toBeGreaterThan(0);
    const primaryAges = [
      ...new Set(combos.map((c) => c.claimAges.primaryAge)),
    ].sort((a, b) => (a ?? 0) - (b ?? 0));
    // The sample household's primary claims at 67; the search
    // covers every claiming age from 62 to 70, including it.
    expect(primaryAges[0]).toBe(62);
    expect(primaryAges[primaryAges.length - 1]).toBe(70);
    expect(primaryAges).toContain(entered.primaryAge);
    for (const combo of combos) {
      expect(combo.claimAges.primaryAge).toBeGreaterThanOrEqual(62);
      expect(combo.claimAges.primaryAge).toBeLessThanOrEqual(70);
    }
  });
});
