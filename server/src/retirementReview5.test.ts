// Engine Review 5 (§2–§6) — RMD tables, SS retirement benefits,
// survivor-benefit law, and the first-RMD deferral.
//
// STANDARD (same as Review 1): every expected figure below is
// hand-computed in the test itself (plain arithmetic on literals),
// never a copied engine print. The statutory sources are named
// per group: IRS Pub. 590-B Tables III (Uniform) and II (Joint
// and Last Survivor) for the RMD divisors; SSA's FRA table,
// 20 CFR §404.410/§404.409/§404.338 and POMS RS 00615.320 for
// the survivor rules (the reduction schedule was checked against
// SSA's published widow(er) percentages: 71.5% at 60, 75.57% at
// 61, 79.64% at 62 for a survivor FRA of 67 — the engine's
// linear 28.5%-over-84-months spread reproduces that table
// exactly). Sample-household values throughout; the single-year
// cases use round balances ($600,000 / $400,000) on 2025–2027
// law so the RMD ages read off the birth years directly.
//
// Run per-file (whole-suite bun test in one process OOMs on this
// VM): bun test server/src/retirementReview5.test.ts

import { describe, expect, test } from "bun:test";
import {
  fullRetirementAgeMonths,
  jointDivisor,
  rmdAgeForBirthYear,
  ssAnnualAtClaimAge,
  ssBenefitFactor,
  survivorFraMonths,
  survivorReductionFactor,
  uniformDivisor,
} from "./taxLaw";
import {
  ROTH_COMPARE_STRATEGIES,
  rmdForYear,
  settleFirstRmdDeferral,
  simulateRothPlan,
  survivorBenefitAnnualEnhanced,
  type FirstRmdDeferralState,
} from "./taxEngine";
import {
  claimAgeRowSurvivorAnnual,
  pricePlaygroundYear,
  type PlaygroundYearInputs,
} from "./rothOptimizer";
import { priceOneWorkYear, rollWorkYears } from "./workYears";
import { samplePlanInputs } from "./sampleHousehold";

// ---------------------------------------------------------------------------
// §4 — RMD tables (IRS Pub. 590-B, 2022+; SECURE 2.0 §107)
// ---------------------------------------------------------------------------

describe("E5 §4 — RMD starting age (SECURE 2.0 §107)", () => {
  test("birth-year bands", () => {
    expect(rmdAgeForBirthYear(1960)).toBe(75);
    expect(rmdAgeForBirthYear(1965)).toBe(75);
    expect(rmdAgeForBirthYear(1959)).toBe(73);
    expect(rmdAgeForBirthYear(1955)).toBe(73);
    expect(rmdAgeForBirthYear(1951)).toBe(73);
    expect(rmdAgeForBirthYear(1950)).toBe(72);
    expect(rmdAgeForBirthYear(1949)).toBe(72);
    expect(rmdAgeForBirthYear(1948)).toBe(70.5);
    expect(rmdAgeForBirthYear(1940)).toBe(70.5);
  });
});

describe("E5 §4 — Uniform Lifetime Table (Pub. 590-B Table III)", () => {
  test("published divisors", () => {
    expect(uniformDivisor(72)).toBe(27.4);
    expect(uniformDivisor(73)).toBe(26.5);
    expect(uniformDivisor(74)).toBe(25.5);
    expect(uniformDivisor(75)).toBe(24.6);
    expect(uniformDivisor(76)).toBe(23.7);
    expect(uniformDivisor(77)).toBe(22.9);
    expect(uniformDivisor(78)).toBe(22.0);
    expect(uniformDivisor(79)).toBe(21.1);
    expect(uniformDivisor(80)).toBe(20.2);
    expect(uniformDivisor(85)).toBe(16.0);
    expect(uniformDivisor(90)).toBe(12.2);
    expect(uniformDivisor(95)).toBe(8.9);
    expect(uniformDivisor(100)).toBe(6.4);
    expect(uniformDivisor(110)).toBe(3.5);
    expect(uniformDivisor(120)).toBe(2.0);
  });
  test("clamps at the table edges", () => {
    expect(uniformDivisor(70)).toBe(27.4);
    expect(uniformDivisor(71)).toBe(27.4);
    expect(uniformDivisor(121)).toBe(2.0);
  });
});

describe("E5 §4 — Joint and Last Survivor Table (Pub. 590-B Table II)", () => {
  test("published spot cells (IRS worksheet examples)", () => {
    // Owner 75 / spouse 64 = 25.3 is the IRS worksheet worked
    // example; 75/54 = 33.2 and 86/75 = 15.9 are the
    // publication's other spot checks.
    expect(jointDivisor(75, 64)).toBe(25.3);
    expect(jointDivisor(75, 54)).toBe(33.2);
    expect(jointDivisor(86, 75)).toBe(15.9);
  });
  test("the table is symmetric in the two ages (inside the grid)", () => {
    // The published table covers owner ages 70–120; below 70
    // the lookup clamps to the age-70 row, which is an edge
    // treatment, not a pricing path — the RMD step only calls
    // the Joint table at or above the RMD age. Symmetry is
    // therefore asserted on in-grid pairs.
    expect(jointDivisor(80, 75)).toBe(jointDivisor(75, 80));
    expect(jointDivisor(86, 75)).toBe(jointDivisor(75, 86));
  });
  test("a younger spouse means a larger divisor", () => {
    expect(jointDivisor(75, 54)).toBeGreaterThan(jointDivisor(75, 64));
    expect(jointDivisor(75, 64)).toBeGreaterThan(jointDivisor(75, 74));
  });
});

describe("E5 §4 — rmdForYear: table selection + the >10-year rule", () => {
  test("Uniform on $600,000 at 75: $24,390.24 (the Review 6 pin)", () => {
    // 600,000 / 24.6 = 24,390.2439… → $24,390.24.
    const r = rmdForYear({
      priorDec31PreTax: 600000,
      agePrimary: 75,
      ageSpouse: 73,
      birthYearPrimary: 1951,
      spouseSoleBeneficiary: true,
    });
    expect(r.table).toBe("uniform");
    expect(r.divisor).toBe(24.6);
    expect(r.rmd).toBe(24390.24);
  });
  test("exactly 10 years younger is NOT Joint (the rule is >10)", () => {
    const r = rmdForYear({
      priorDec31PreTax: 600000,
      agePrimary: 75,
      ageSpouse: 65,
      birthYearPrimary: 1951,
      spouseSoleBeneficiary: true,
    });
    expect(r.table).toBe("uniform");
    expect(r.divisor).toBe(24.6);
    expect(r.rmd).toBe(24390.24);
  });
  test("11 years younger + sole beneficiary IS Joint: $23,715.42", () => {
    // 600,000 / 25.3 = 23,715.415… → $23,715.42.
    const r = rmdForYear({
      priorDec31PreTax: 600000,
      agePrimary: 75,
      ageSpouse: 64,
      birthYearPrimary: 1951,
      spouseSoleBeneficiary: true,
    });
    expect(r.table).toBe("joint");
    expect(r.divisor).toBe(25.3);
    expect(r.rmd).toBe(23715.42);
  });
  test("11 years younger but NOT the sole beneficiary stays Uniform", () => {
    const r = rmdForYear({
      priorDec31PreTax: 600000,
      agePrimary: 75,
      ageSpouse: 64,
      birthYearPrimary: 1951,
      spouseSoleBeneficiary: false,
    });
    expect(r.table).toBe("uniform");
    expect(r.divisor).toBe(24.6);
  });
  test("below the RMD age prices nothing", () => {
    const r = rmdForYear({
      priorDec31PreTax: 600000,
      agePrimary: 72,
      ageSpouse: 70,
      birthYearPrimary: 1951,
      spouseSoleBeneficiary: true,
    });
    expect(r.rmd).toBe(0);
    expect(r.divisor).toBeNull();
    expect(r.table).toBeNull();
  });
  test("a $0 prior-year-end balance prices a $0 RMD", () => {
    const r = rmdForYear({
      priorDec31PreTax: 0,
      agePrimary: 75,
      ageSpouse: 73,
      birthYearPrimary: 1951,
      spouseSoleBeneficiary: true,
    });
    expect(r.rmd).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §5 — SS retirement benefits (SSA FRA table; 5/9% + 5/12% early,
// 8%/yr delayed credits, cap at 70)
// ---------------------------------------------------------------------------

describe("E5 §5 — full retirement age by birth year (SSA)", () => {
  test("FRA in months", () => {
    expect(fullRetirementAgeMonths(1943)).toBe(66 * 12);
    expect(fullRetirementAgeMonths(1954)).toBe(66 * 12);
    expect(fullRetirementAgeMonths(1955)).toBe(66 * 12 + 2);
    expect(fullRetirementAgeMonths(1956)).toBe(66 * 12 + 4);
    expect(fullRetirementAgeMonths(1957)).toBe(66 * 12 + 6);
    expect(fullRetirementAgeMonths(1958)).toBe(66 * 12 + 8);
    expect(fullRetirementAgeMonths(1959)).toBe(66 * 12 + 10);
    expect(fullRetirementAgeMonths(1960)).toBe(67 * 12);
    expect(fullRetirementAgeMonths(1968)).toBe(67 * 12);
    // The 1938–1942 steps: 65 plus two months per birth year.
    expect(fullRetirementAgeMonths(1942)).toBe(65 * 12 + 10);
    expect(fullRetirementAgeMonths(1941)).toBe(65 * 12 + 8);
    expect(fullRetirementAgeMonths(1940)).toBe(65 * 12 + 6);
    expect(fullRetirementAgeMonths(1939)).toBe(65 * 12 + 4);
    expect(fullRetirementAgeMonths(1938)).toBe(65 * 12 + 2);
    expect(fullRetirementAgeMonths(1937)).toBe(65 * 12);
  });
});

describe("E5 §5 — early reductions, delayed credits, age-70 cap", () => {
  test("FRA 67 (born 1968): 62 → 70%, 70 → 124%, 71 → 124%", () => {
    expect(ssBenefitFactor(62, 1968)).toBeCloseTo(0.7, 10);
    // 63: 48 months early = 36 × 5/9% + 12 × 5/12% = 25% off.
    expect(ssBenefitFactor(63, 1968)).toBeCloseTo(0.75, 10);
    // 64: 36 months early = 36 × 5/9% = 20% off.
    expect(ssBenefitFactor(64, 1968)).toBeCloseTo(0.8, 10);
    // 65: 24 × 5/9% = 13⅓% off.
    expect(ssBenefitFactor(65, 1968)).toBeCloseTo(0.8666667, 6);
    // 66: 12 × 5/9% = 6⅔% off.
    expect(ssBenefitFactor(66, 1968)).toBeCloseTo(0.9333333, 6);
    expect(ssBenefitFactor(67, 1968)).toBe(1);
    expect(ssBenefitFactor(68, 1968)).toBeCloseTo(1.08, 10);
    expect(ssBenefitFactor(69, 1968)).toBeCloseTo(1.16, 10);
    expect(ssBenefitFactor(70, 1968)).toBeCloseTo(1.24, 10);
    expect(ssBenefitFactor(71, 1968)).toBeCloseTo(1.24, 10);
  });
  test("FRA 66 (born 1954): 62 → 75%, 70 → 132%", () => {
    expect(ssBenefitFactor(62, 1954)).toBeCloseTo(0.75, 10);
    expect(ssBenefitFactor(66, 1954)).toBe(1);
    expect(ssBenefitFactor(70, 1954)).toBeCloseTo(1.32, 10);
  });
  test("claim-age derivation from a $48,000-at-67 anchor", () => {
    // The runRothCompare derivation the engine already does:
    // 48,000 × 0.70 = $33,600 at 62; 48,000 × 1.24 = $59,520
    // at 70; unchanged at the anchor age itself.
    expect(ssAnnualAtClaimAge(48000, 67, 62, 1968)).toBe(33600);
    expect(ssAnnualAtClaimAge(48000, 67, 70, 1968)).toBe(59520);
    expect(ssAnnualAtClaimAge(48000, 67, 67, 1968)).toBe(48000);
  });
});

// ---------------------------------------------------------------------------
// §2/§5 — survivor law (20 CFR §404.409/§404.410/§404.338;
// POMS RS 00615.320)
// ---------------------------------------------------------------------------

describe("E5 §2 — survivor full retirement age (its own table)", () => {
  test("survivor FRA runs two birth years behind the retirement table", () => {
    expect(survivorFraMonths(1964)).toBe(67 * 12);
    expect(survivorFraMonths(1962)).toBe(67 * 12);
    expect(survivorFraMonths(1961)).toBe(66 * 12 + 10);
    expect(survivorFraMonths(1960)).toBe(66 * 12 + 8);
    expect(survivorFraMonths(1957)).toBe(66 * 12 + 2);
    expect(survivorFraMonths(1956)).toBe(66 * 12);
    expect(survivorFraMonths(1950)).toBe(66 * 12);
  });

  test("survivor FRA before 1945: 65, then two months a year to 1944", () => {
    // 20 CFR §404.409(b): 1912–1939 is 65 (before 1912 is
    // 62 — the NICE-5 row below); 1940 is 65 and 2 months,
    // rising two months per birth year to 65 and 10 months
    // for 1944; 1945–1956 are 66. The pre-1945 ramp was
    // missing (every year below 1957 priced at 66), which
    // understated the benefit for a survivor in this cohort
    // claiming at 61–65.
    expect(survivorFraMonths(1945)).toBe(66 * 12);
    expect(survivorFraMonths(1944)).toBe(65 * 12 + 10);
    expect(survivorFraMonths(1943)).toBe(65 * 12 + 8);
    expect(survivorFraMonths(1942)).toBe(65 * 12 + 6);
    expect(survivorFraMonths(1941)).toBe(65 * 12 + 4);
    expect(survivorFraMonths(1940)).toBe(65 * 12 + 2);
    expect(survivorFraMonths(1939)).toBe(65 * 12);
    expect(survivorFraMonths(1930)).toBe(65 * 12);
    // 20 CFR §404.409(b): before January 2, 1912 the
    // survivor FRA is 62, not 65 — the table's old fallthrough
    // priced every pre-1940 birth year at 65. 1912 prices at
    // 65 by the whole-year approximation (the statute splits
    // 1912 at January 2; a January-1-1912 birth is the
    // disclosed NICE-C case). The reduction span for a 62 FRA
    // is 24 months: at 61 the factor is
    // 1 − 0.285 × 12/24 = 0.8575.
    expect(survivorFraMonths(1912)).toBe(65 * 12);
    expect(survivorFraMonths(1911)).toBe(62 * 12);
    expect(survivorFraMonths(1900)).toBe(62 * 12);
    expect(survivorReductionFactor(61, 1911)).toBeCloseTo(0.8575, 4);
    expect(survivorReductionFactor(60, 1911)).toBeCloseTo(0.715, 10);
  });

  test("pre-1945 reduction: the shorter span prices a higher benefit", () => {
    // Born 1940, survivor FRA 65y2m (782 months): the span
    // from 60 is 62 months. At 65 (2 months early) the factor
    // is 1 − 0.285 × 2/62 = 0.99081; at 63 (26 months early)
    // it is 1 − 0.285 × 26/62 = 0.88048. At 60 both the old
    // (66 FRA) and the corrected table give the 71.5% floor.
    // Born 1944, survivor FRA 65y10m (790 months): the span is
    // 70 months; at 65 (10 months early) the factor is
    // 1 − 0.285 × 10/70 = 0.95929.
    expect(survivorReductionFactor(65, 1940)).toBeCloseTo(0.99081, 5);
    expect(survivorReductionFactor(63, 1940)).toBeCloseTo(0.88048, 5);
    expect(survivorReductionFactor(60, 1940)).toBeCloseTo(0.715, 10);
    expect(survivorReductionFactor(65, 1944)).toBeCloseTo(0.95929, 5);
  });
});

describe("E5 §2 — survivor claiming-age reduction (28.5% at 60)", () => {
  test("survivor FRA 67: the SSA-published table, exactly", () => {
    // SSA's widow(er) percentages for a survivor FRA of 67:
    // 60 → 71.50%, 61 → 75.57%, 62 → 79.64%, 63 → 83.71%,
    // 64 → 87.79%, 65 → 91.86%, 66 → 95.93%, 67 → 100%.
    expect(survivorReductionFactor(60, 1964)).toBeCloseTo(0.715, 10);
    expect(survivorReductionFactor(61, 1964)).toBeCloseTo(0.7557, 4);
    expect(survivorReductionFactor(62, 1964)).toBeCloseTo(0.7964, 4);
    expect(survivorReductionFactor(63, 1964)).toBeCloseTo(0.8371, 4);
    expect(survivorReductionFactor(64, 1964)).toBeCloseTo(0.8779, 4);
    expect(survivorReductionFactor(65, 1964)).toBeCloseTo(0.9186, 4);
    expect(survivorReductionFactor(66, 1964)).toBeCloseTo(0.9593, 4);
    expect(survivorReductionFactor(67, 1964)).toBe(1);
    // No delayed credits on a survivor benefit: 70 is 100%.
    expect(survivorReductionFactor(70, 1964)).toBe(1);
  });
  test("survivor FRA 66: the same 28.5% spread over 72 months", () => {
    expect(survivorReductionFactor(60, 1950)).toBeCloseTo(0.715, 10);
    expect(survivorReductionFactor(61, 1950)).toBeCloseTo(0.7625, 4);
    expect(survivorReductionFactor(62, 1950)).toBeCloseTo(0.81, 10);
    expect(survivorReductionFactor(63, 1950)).toBeCloseTo(0.8575, 4);
    expect(survivorReductionFactor(64, 1950)).toBeCloseTo(0.905, 10);
    expect(survivorReductionFactor(65, 1950)).toBeCloseTo(0.9525, 4);
    expect(survivorReductionFactor(66, 1950)).toBe(1);
  });
});

describe("E5 §2 — claiming-age table survivor column (enhanced mode)", () => {
  // The table's "Survivor keeps / yr" column used to show the
  // simplified max() of the two claimed benefits even when a
  // survivor scenario with an explicit claiming age was priced
  // (Pass 2: on the adapter's fictional household the table
  // showed $36,000 where the march priced $25,740). The table
  // now prices through claimAgeRowSurvivorAnnual, the exact
  // function the table builder calls. These tests pin that
  // function directly, plus the march's survivor-year benefit
  // on the same inputs. The full optimizer run itself is NOT
  // executed here: one 9-combination search took 87s and a
  // second run in the same process OOM-killed on this loaded
  // VM, so the table wiring (one call line) is verified by
  // reading, and the value it computes is verified here.
  const row = (
    primaryAge: number | null,
    spouseAge: number | null,
    primaryAnnual: number,
    spouseAnnual: number,
  ) => ({
    primaryAge,
    spouseAge,
    primaryAnnual,
    spouseAnnual,
    searchedPrimary: true,
    searchedSpouse: false,
  });
  // Sample household with the spouse's own SS zeroed, so the
  // survivor benefit always binds (own $0). Primary $48,000@67
  // (PIA $48,000, born 1968); primary dies 2043 at 75;
  // survivor (born 1970, FRA 67) claims at 60 → 71.5%.
  const enhanced = samplePlanInputs({
    ssSpouseAnnual: 0,
    ssSpouseStartAge: null,
    survivorEnabled: true,
    survivorWho: "primary",
    survivorDeathYear: 2043,
    survivorClaimAge: 60,
  });
  test("enhanced rows price the SSA survivor benefit, not the max", () => {
    // Age 67: the deceased claimed at FRA, so the base is the
    // $48,000 anchor and the cap is $48,000; 71.5% → $34,320.
    // The simplified max would show $48,000.
    expect(
      claimAgeRowSurvivorAnnual(enhanced, row(67, null, 48000, 0)),
    ).toBe(34320);
    // Age 62: the deceased claimed early ($33,600 = 70% of
    // PIA), so the base is the $48,000 PIA and the cap is
    // max($33,600, 82.5% × $48,000 = $39,600); 71.5% of the
    // PIA is $34,320, below the cap — still $34,320.
    expect(
      claimAgeRowSurvivorAnnual(enhanced, row(62, null, 33600, 0)),
    ).toBe(34320);
    // Age 70: the deceased claimed late ($59,520 = 124% of
    // PIA), so the base is the $59,520 benefit including
    // delayed credits; 71.5% → $42,556.80.
    expect(
      claimAgeRowSurvivorAnnual(enhanced, row(70, null, 59520, 0)),
    ).toBe(42556.8);
  });
  test("simplified rows still show the max when no claiming age is set", () => {
    const simplified = samplePlanInputs({
      ssSpouseAnnual: 0,
      ssSpouseStartAge: null,
      survivorEnabled: true,
      survivorWho: "primary",
      survivorDeathYear: 2043,
    });
    expect(
      claimAgeRowSurvivorAnnual(simplified, row(67, null, 48000, 0)),
    ).toBe(48000);
  });
  test("spouse-dies direction mirrors the mapping", () => {
    // Spouse (born 1968) dies 2043 at 75 with a $36,000@67
    // anchor; the primary (born 1970) claims the survivor
    // benefit at 60 → 71.5% × $36,000 = $25,740, above the
    // primary's own $18,000.
    const spouseDies = samplePlanInputs({
      birthYearPrimary: 1970,
      birthYearSpouse: 1968,
      ssPrimaryAnnual: 18000,
      ssSpouseAnnual: 36000,
      survivorEnabled: true,
      survivorWho: "spouse",
      survivorDeathYear: 2043,
      survivorClaimAge: 60,
    });
    expect(
      claimAgeRowSurvivorAnnual(spouseDies, row(67, 67, 18000, 36000)),
    ).toBe(25740);
  });
  test("incomplete scenario (no death year) falls back to the max", () => {
    const noDeathYear = samplePlanInputs({
      ssSpouseAnnual: 0,
      ssSpouseStartAge: null,
      survivorEnabled: true,
      survivorWho: "primary",
      survivorClaimAge: 60,
    });
    expect(
      claimAgeRowSurvivorAnnual(noDeathYear, row(67, null, 48000, 0)),
    ).toBe(48000);
  });
  test("the march prices the same survivor-year benefit as the table row", () => {
    // Do Nothing march, primary claims at 67: the 2044
    // survivor year (first year after the 2043 death) collects
    // $34,320 — the age-67 row's value above — in enhanced
    // mode. The death year itself (2043) still pays both
    // benefits in full ($48,000).
    const march = simulateRothPlan(
      samplePlanInputs({
        ssSpouseAnnual: 0,
        ssSpouseStartAge: null,
        ssPrimaryStartAge: 67,
        survivorEnabled: true,
        survivorWho: "primary",
        survivorDeathYear: 2043,
        survivorClaimAge: 60,
      }),
      ROTH_COMPARE_STRATEGIES[0]!,
    );
    const yearOf = (year: number) => {
      const y = march.years.find((r) => r.year === year);
      expect(y).toBeDefined();
      return y!;
    };
    expect(yearOf(2043).ssBenefits).toBe(48000);
    expect(yearOf(2044).ssBenefits).toBe(34320);
    expect(yearOf(2044).detail.survivorSsMode).toBe("enhanced");
    expect(yearOf(2045).ssBenefits).toBe(34320);
  });
  test("both at FRA: the survivor year prices 100% of the deceased's benefit", () => {
    // The deceased claimed at FRA ($48,000@67) and the
    // survivor claims at survivor FRA (67) — the enhanced
    // benefit is 100% of the $48,000 base. The death year
    // (2043) still pays both benefits in full.
    const march = simulateRothPlan(
      samplePlanInputs({
        ssSpouseAnnual: 0,
        ssSpouseStartAge: null,
        ssPrimaryStartAge: 67,
        survivorEnabled: true,
        survivorWho: "primary",
        survivorDeathYear: 2043,
        survivorClaimAge: 67,
      }),
      ROTH_COMPARE_STRATEGIES[0]!,
    );
    const yearOf = (year: number) => {
      const y = march.years.find((r) => r.year === year);
      expect(y).toBeDefined();
      return y!;
    };
    expect(yearOf(2043).ssBenefits).toBe(48000);
    expect(yearOf(2044).ssBenefits).toBe(48000);
    expect(yearOf(2044).detail.survivorSsMode).toBe("enhanced");
    expect(yearOf(2045).ssBenefits).toBe(48000);
  });
  test("spouse-dies at the march level mirrors the table row", () => {
    // Spouse (born 1968) dies 2043 at 75 with a $36,000@67
    // anchor; the primary (born 1970) claims the survivor
    // benefit at 60 → 71.5% × $36,000 = $25,740, above the
    // primary's own $18,000. The death year (2043) pays both
    // benefits in full ($18,000 + $36,000 = $54,000).
    const march = simulateRothPlan(
      samplePlanInputs({
        birthYearPrimary: 1970,
        birthYearSpouse: 1968,
        ssPrimaryAnnual: 18000,
        ssSpouseAnnual: 36000,
        ssPrimaryStartAge: 67,
        ssSpouseStartAge: 67,
        survivorEnabled: true,
        survivorWho: "spouse",
        survivorDeathYear: 2043,
        survivorClaimAge: 60,
      }),
      ROTH_COMPARE_STRATEGIES[0]!,
    );
    const yearOf = (year: number) => {
      const y = march.years.find((r) => r.year === year);
      expect(y).toBeDefined();
      return y!;
    };
    expect(yearOf(2043).ssBenefits).toBe(54000);
    expect(yearOf(2044).ssBenefits).toBe(25740);
    expect(yearOf(2044).detail.survivorSsMode).toBe("enhanced");
    expect(yearOf(2045).ssBenefits).toBe(25740);
  });
  test("an out-of-range claiming age clamps in the year detail", () => {
    // Direct-engine input only — the adapter schema bounds
    // 60–70. A 55 claims at the age-60 row ($34,320) and the
    // detail echoes 60, not 55; a 75 claims at 70 (100% of
    // the $48,000 base) and the detail echoes 70, not 75.
    const march55 = simulateRothPlan(
      samplePlanInputs({
        ssSpouseAnnual: 0,
        ssSpouseStartAge: null,
        ssPrimaryStartAge: 67,
        survivorEnabled: true,
        survivorWho: "primary",
        survivorDeathYear: 2043,
        survivorClaimAge: 55,
      }),
      ROTH_COMPARE_STRATEGIES[0]!,
    );
    const y55 = march55.years.find((r) => r.year === 2044);
    expect(y55).toBeDefined();
    expect(y55!.ssBenefits).toBe(34320);
    expect(y55!.detail.survivorClaimAge).toBe(60);
    const march75 = simulateRothPlan(
      samplePlanInputs({
        ssSpouseAnnual: 0,
        ssSpouseStartAge: null,
        ssPrimaryStartAge: 67,
        survivorEnabled: true,
        survivorWho: "primary",
        survivorDeathYear: 2043,
        survivorClaimAge: 75,
      }),
      ROTH_COMPARE_STRATEGIES[0]!,
    );
    const y75 = march75.years.find((r) => r.year === 2044);
    expect(y75).toBeDefined();
    expect(y75!.ssBenefits).toBe(48000);
    expect(y75!.detail.survivorClaimAge).toBe(70);
  });
});

describe("E5 §2 — the enhanced survivor benefit (widow(er)'s limit)", () => {
  // Shared case: PIA $12,000/yr ($1,000/mo). The deceased
  // claimed at 62 (FRA 67), so the anchor is $8,400/yr
  // (70% of PIA); the survivor was born 1964 (survivor FRA
  // 67). All amounts are annual dollars.
  const base = {
    deceasedAnchorAnnual: 8400,
    deceasedAnchorAge: 62,
    deceasedBirthYear: 1968,
    deceasedDeathAge: 70,
    survivorBirthYear: 1964,
    ownAnnualThisYear: 0,
  };
  test("widow's-limit ordering: claim at 60 → 71.5% of the PIA", () => {
    // POMS RS 00615.320 §A.3: the survivor's own reduction
    // applies FIRST to the PIA, and the limit then CAPS the
    // reduced amount at max(deceased's benefit, 82.5% PIA).
    // 12,000 × 0.715 = $8,580; the cap is max(8,400, 9,900)
    // = $9,900, which does not bind. NOT 71.5% of 82.5% of
    // the PIA ($7,081.88) — the reduction is not applied to
    // the cap a second time.
    expect(
      survivorBenefitAnnualEnhanced({
        ...base,
        survivorAge: 60,
        survivorClaimAge: 60,
      }),
    ).toBe(8580);
  });
  test("claim at 62 → $9,557.14 (reduction still below the cap)", () => {
    // 12,000 × 0.7964286 = $9,557.14 < cap $9,900.
    expect(
      survivorBenefitAnnualEnhanced({
        ...base,
        survivorAge: 62,
        survivorClaimAge: 62,
      }),
    ).toBe(9557.14);
  });
  test("claim at 63 → the cap binds at 82.5% of the PIA ($9,900)", () => {
    // 12,000 × 0.8371429 = $10,045.71, capped at $9,900.
    expect(
      survivorBenefitAnnualEnhanced({
        ...base,
        survivorAge: 63,
        survivorClaimAge: 63,
      }),
    ).toBe(9900);
  });
  test("deceased claimed at 70: the 124% benefit survives, uncut", () => {
    // Anchor $14,880/yr (124% of the $12,000 PIA); the
    // survivor at FRA is owed the whole 124% benefit, not
    // 100% of PIA (20 CFR §404.338(b)).
    expect(
      survivorBenefitAnnualEnhanced({
        deceasedAnchorAnnual: 14880,
        deceasedAnchorAge: 70,
        deceasedBirthYear: 1968,
        deceasedDeathAge: 72,
        survivorBirthYear: 1964,
        survivorAge: 67,
        survivorClaimAge: 67,
        ownAnnualThisYear: 0,
      }),
    ).toBe(14880);
  });
  test("deceased died before claiming at 68: one year of DRCs accrues", () => {
    // The deceased's ENTERED benefit is $14,880/yr at 70
    // (124% of the $12,000 PIA) — but they died at 68,
    // before that entered claiming age, so the benefit was
    // never received: the base is the PIA plus the delayed
    // credits accrued to the month of death, one whole year
    // past FRA 67 → $12,000 × 1.08 = $12,960, survivor at FRA.
    expect(
      survivorBenefitAnnualEnhanced({
        deceasedAnchorAnnual: 14880,
        deceasedAnchorAge: 70,
        deceasedBirthYear: 1968,
        deceasedDeathAge: 68,
        survivorBirthYear: 1964,
        survivorAge: 67,
        survivorClaimAge: 67,
        ownAnnualThisYear: 0,
      }),
    ).toBe(12960);
  });
  test("deceased died before FRA: the base is the bare PIA", () => {
    expect(
      survivorBenefitAnnualEnhanced({
        deceasedAnchorAnnual: 12000,
        deceasedAnchorAge: 67,
        deceasedBirthYear: 1968,
        deceasedDeathAge: 65,
        survivorBirthYear: 1964,
        survivorAge: 67,
        survivorClaimAge: 67,
        ownAnnualThisYear: 0,
      }),
    ).toBe(12000);
  });
  test("before the claiming age the survivor keeps only their own benefit", () => {
    expect(
      survivorBenefitAnnualEnhanced({
        ...base,
        survivorAge: 59,
        survivorClaimAge: 60,
        ownAnnualThisYear: 5000,
      }),
    ).toBe(5000);
    expect(
      survivorBenefitAnnualEnhanced({
        ...base,
        survivorAge: 59,
        survivorClaimAge: 60,
        ownAnnualThisYear: 0,
      }),
    ).toBe(0);
  });
  test("the survivor never receives both benefits — the larger one only", () => {
    // Own $10,000 beats the $8,580 survivor benefit; the
    // answer is $10,000, not $18,580.
    expect(
      survivorBenefitAnnualEnhanced({
        ...base,
        survivorAge: 60,
        survivorClaimAge: 60,
        ownAnnualThisYear: 10000,
      }),
    ).toBe(10000);
  });
  test("no entered benefit for the deceased → own benefit only", () => {
    expect(
      survivorBenefitAnnualEnhanced({
        ...base,
        deceasedAnchorAnnual: 0,
        survivorAge: 60,
        survivorClaimAge: 60,
        ownAnnualThisYear: 4000,
      }),
    ).toBe(4000);
  });
  test("a claiming age below 60 prices at the age-60 row", () => {
    expect(
      survivorBenefitAnnualEnhanced({
        ...base,
        survivorAge: 60,
        survivorClaimAge: 55,
      }),
    ).toBe(8580);
  });
});

// ---------------------------------------------------------------------------
// §3 — first-RMD deferral, single-year price (E5-S2)
// ---------------------------------------------------------------------------

function yearInputs(overrides: Partial<PlaygroundYearInputs> = {}): PlaygroundYearInputs {
  return {
    taxYear: 2025,
    filingStatus: "mfj",
    agePrimary: 73,
    ageSpouse: 71,
    onMedicarePrimary: true,
    onMedicareSpouse: true,
    interest: 0,
    ordinaryDividends: 0,
    otherOrdinary: 50000,
    taxExemptInterest: 0,
    ssPrimary: 0,
    ssSpouse: 0,
    conversion: 0,
    spendingDraw: 0,
    cashDraw: 0,
    rothDraw: 0,
    inflationPct: 0,
    stockSold: 0,
    stockBasis: 0,
    qualifiedDividends: 0,
    pretaxBalance: 600000,
    pretaxBalanceSpouse: 0,
    rmdAlreadyReceived: 0,
    primarySoleBeneficiaryOfSpouse: false,
    spouseSoleBeneficiary: true,
    acaHouseholdSize: 2,
    // The sample household's couple benchmark (never the
    // household's own figure — the fictional sample prices
    // off $25,000 for a couple).
    acaBenchmarkAnnual: 25000,
    stateRatePct: 0,
    residenceState: "other",
    annualSpending: 0,
    ...overrides,
  };
}

describe("E5 §3 — first-RMD deferral, single-year price", () => {
  test("first RMD year, immediate (the default): $22,641.51, nothing deferred", () => {
    // Born 1952 (age 73 in 2025), RMD age 73, Uniform 26.5:
    // 600,000 / 26.5 = 22,641.5094… → $22,641.51.
    const r = pricePlaygroundYear(yearInputs());
    expect(r.rmdPrimary).toBe(22641.51);
    expect(r.rmdDeferredPrimary).toBe(0);
    expect(r.rmdDeferredPaidPrimary).toBe(0);
    expect(r.rmd).toBe(22641.51);
    expect(r.rmdGross).toBe(22641.51);
    expect(r.rmdDivisor).toBe(26.5);
    expect(r.rmdTable).toBe("uniform");
    expect(r.agi).toBe(72641.51);
  });
  test("first RMD year, deferred: $0 priced, $22,641.51 deferred, tax falls", () => {
    const immediate = pricePlaygroundYear(yearInputs());
    const deferred = pricePlaygroundYear(
      yearInputs({ firstRmdDeferralPrimary: true }),
    );
    expect(deferred.rmdPrimary).toBe(0);
    expect(deferred.rmdDeferredPrimary).toBe(22641.51);
    expect(deferred.rmdDeferredPaidPrimary).toBe(0);
    expect(deferred.rmd).toBe(0);
    // The tax timing: the deferred RMD is NOT income in the
    // year deferred — AGI and MAGI are lower by exactly the
    // deferred amount, and the federal tax is lower.
    expect(deferred.agi).toBe(50000);
    expect(immediate.agi - deferred.agi).toBeCloseTo(22641.51, 2);
    expect(immediate.magi - deferred.magi).toBeCloseTo(22641.51, 2);
    expect(deferred.federalTax).toBeLessThan(immediate.federalTax);
  });
  test("following year with the carry: two RMDs, $46,170.92", () => {
    // Age 74 in 2026, Uniform 25.5: own RMD 600,000 / 25.5 =
    // $23,529.41, plus the $22,641.51 carry = $46,170.92.
    const r = pricePlaygroundYear(
      yearInputs({
        taxYear: 2026,
        agePrimary: 74,
        ageSpouse: 72,
        firstRmdDeferredCarryPrimary: 22641.51,
      }),
    );
    expect(r.rmdPrimary).toBe(46170.92);
    expect(r.rmdDeferredPaidPrimary).toBe(22641.51);
    expect(r.rmdDeferredPrimary).toBe(0);
    expect(r.rmdDivisor).toBe(25.5);
  });
  test("an election past the first RMD year is a no-op", () => {
    // Age 74 in 2026 — the first RMD year was 2025. The
    // election names $0 deferred and the own RMD prices whole.
    const r = pricePlaygroundYear(
      yearInputs({
        taxYear: 2026,
        agePrimary: 74,
        ageSpouse: 72,
        firstRmdDeferralPrimary: true,
      }),
    );
    expect(r.rmdPrimary).toBe(23529.41);
    expect(r.rmdDeferredPrimary).toBe(0);
  });
  test("a $0 prior-year-end balance defers nothing", () => {
    const r = pricePlaygroundYear(
      yearInputs({ pretaxBalance: 0, firstRmdDeferralPrimary: true }),
    );
    expect(r.rmdPrimary).toBe(0);
    expect(r.rmdDeferredPrimary).toBe(0);
  });
  test("spouse reaches RMD age in a different year: separate elections", () => {
    // 2027: primary 75 (born 1952 — first RMD was 2025, so
    // his election would be a no-op), spouse 73 (born 1954 —
    // HER first RMD year). Spouse balance $400,000, Uniform
    // 26.5: 400,000 / 26.5 = 15,094.3396… → $15,094.34.
    const r = pricePlaygroundYear(
      yearInputs({
        taxYear: 2027,
        agePrimary: 75,
        ageSpouse: 73,
        pretaxBalanceSpouse: 400000,
        firstRmdDeferralSpouse: true,
      }),
    );
    expect(r.rmdPrimary).toBe(24390.24);
    expect(r.rmdDeferredPrimary).toBe(0);
    expect(r.rmdSpouse).toBe(0);
    expect(r.rmdDeferredSpouse).toBe(15094.34);
    expect(r.rmdDeferredPaidSpouse).toBe(0);
  });
  test("no election at all prices bit-identically to an explicit false", () => {
    const omitted = pricePlaygroundYear(yearInputs());
    const explicit = pricePlaygroundYear(
      yearInputs({
        firstRmdDeferralPrimary: false,
        firstRmdDeferralSpouse: false,
      }),
    );
    expect(explicit).toEqual(omitted);
  });
  test("the 70.5 cohort: the first PAYABLE year is 71, not 70", () => {
    // Born 1948 (RMD age 70.5). At 70 the computed RMD is $0
    // (70 < 70.5), so there is nothing to defer; at 71 the
    // first payable RMD prices — and an election defers it,
    // exactly as the march does (the attainment year counts
    // as the first even on a $0 balance — see
    // settleFirstRmdDeferral's rmdAgeReached; a later
    // positive year cannot defer). The
    // priced years are historical (2018/2019), so only the RMD
    // fields are asserted — the tax itself prices under the
    // oldest published law row, which is outside this test.
    // 600,000 / 27.4 = 21,897.8102… → $21,897.81.
    const at70 = pricePlaygroundYear(
      yearInputs({
        taxYear: 2018,
        agePrimary: 70,
        ageSpouse: 68,
        firstRmdDeferralPrimary: true,
      }),
    );
    expect(at70.rmdPrimary).toBe(0);
    expect(at70.rmdDeferredPrimary).toBe(0);
    const immediate71 = pricePlaygroundYear(
      yearInputs({ taxYear: 2019, agePrimary: 71, ageSpouse: 69 }),
    );
    expect(immediate71.rmdPrimary).toBe(21897.81);
    expect(immediate71.rmdDivisor).toBe(27.4);
    const deferred71 = pricePlaygroundYear(
      yearInputs({
        taxYear: 2019,
        agePrimary: 71,
        ageSpouse: 69,
        firstRmdDeferralPrimary: true,
      }),
    );
    expect(deferred71.rmdPrimary).toBe(0);
    expect(deferred71.rmdDeferredPrimary).toBe(21897.81);
  });
  test("a carried-in deferral at the exact first RMD year is paid, not deferred twice", () => {
    // Born 1948 (RMD age 70.5, first payable 71): a $10,000
    // carry enters the single-year price with the election
    // on. The carry means the first RMD year already passed,
    // so the year pays its own $21,897.81 plus the carry and
    // defers nothing — before the fix it paid only the carry
    // and deferred its own RMD a second time.
    // 600,000 / 27.4 = 21,897.8102… → $21,897.81.
    const r = pricePlaygroundYear(
      yearInputs({
        taxYear: 2019,
        agePrimary: 71,
        ageSpouse: 69,
        firstRmdDeferralPrimary: true,
        firstRmdDeferredCarryPrimary: 10000,
      }),
    );
    expect(r.rmdPrimary).toBe(31897.81);
    expect(r.rmdDeferredPrimary).toBe(0);
    expect(r.rmdDeferredPaidPrimary).toBe(10000);
  });
  test("a carried-in deferral past the first RMD year is paid on top", () => {
    // Age 73 in 2021 (born 1948, past the first RMD year):
    // the own RMD is 600,000 / 26.5 = $22,641.51, plus the
    // $10,000 carry; the election is a no-op and nothing
    // defers.
    const r = pricePlaygroundYear(
      yearInputs({
        taxYear: 2021,
        agePrimary: 73,
        ageSpouse: 71,
        firstRmdDeferralPrimary: true,
        firstRmdDeferredCarryPrimary: 10000,
      }),
    );
    expect(r.rmdPrimary).toBe(32641.51);
    expect(r.rmdDeferredPrimary).toBe(0);
    expect(r.rmdDeferredPaidPrimary).toBe(10000);
  });
});

// ---------------------------------------------------------------------------
// §3 — first-RMD deferral through the work-years roll (E5-S2)
// ---------------------------------------------------------------------------

describe("E5 §3 — first-RMD deferral through the work-years roll", () => {
  // The roll prices work years from the plan's current age
  // (startYear − birth year) to the quit age. Primary born
  // 1955 (RMD age 73), spouse born 1955 too — the same age,
  // so no >10-year gap and the RMD prices on the Uniform
  // table under the sample's beneficiary facts (the spouse's
  // balance is $0, so her own RMD is $0 either way). Starting
  // pre-tax $600,000, election on for the primary only.
  const plan = samplePlanInputs({
    birthYearPrimary: 1955,
    birthYearSpouse: 1955,
    startYear: 2026,
    pretaxStart: 600000,
    firstRmdDeferralPrimary: true,
  });
  const job = { salary: 120000, employer401k: 0, employerHsa: 0 };

  test("standalone prices thread one shared state: defer at 73, pay both at 74", () => {
    // The prior balances are passed explicitly (the roll
    // would thread them as 600,000 × 1.05² and × 1.05³):
    // 661,500 / 26.5 = $24,962.26; 694,575 / 25.5 =
    // $27,238.24, plus the carry = $52,200.50.
    const state: FirstRmdDeferralState = {
      hadPrimary: false,
      hadSpouse: false,
      pendingPrimary: 0,
      pendingSpouse: 0,
    };
    const y73 = priceOneWorkYear(
      plan,
      job,
      73,
      null,
      null,
      { priorPrimary: 661500, priorSpouse: 0 },
      null,
      state,
    );
    expect(y73.rmdPrimary).toBe(0);
    expect(y73.rmdDeferredPrimary).toBe(24962.26);
    expect(y73.rmdDeferredPaidPrimary).toBe(0);
    expect(state.hadPrimary).toBe(true);
    expect(state.pendingPrimary).toBe(24962.26);
    const y74 = priceOneWorkYear(
      plan,
      job,
      74,
      null,
      null,
      { priorPrimary: 694575, priorSpouse: 0 },
      null,
      state,
    );
    expect(y74.rmdPrimary).toBe(52200.5);
    expect(y74.rmdDeferredPaidPrimary).toBe(24962.26);
    expect(y74.rmdDeferredPrimary).toBe(0);
    expect(state.pendingPrimary).toBe(0);
    expect(state.hadPrimary).toBe(true);
  });

  test("an entering deferred carry is paid in the first priced year, not dropped", () => {
    // A direct caller can pass a carry on the plan (the plan
    // type carries firstRmdDeferredCarry*, even though no
    // supported surface passes one to the roll — the adapter
    // never does). The seeding pays it in the first priced
    // year, exactly as the march pays its start-year carry-in.
    const carryPlan = samplePlanInputs({
      birthYearPrimary: 1955,
      birthYearSpouse: 1955,
      startYear: 2026,
      pretaxStart: 600000,
      firstRmdDeferralPrimary: true,
      firstRmdDeferredCarryPrimary: 10000,
    });
    // Age 74, past the first RMD year: the own RMD is
    // 694,575 / 25.5 = $27,238.24, plus the $10,000 carry.
    const y74 = priceOneWorkYear(
      carryPlan,
      job,
      74,
      null,
      null,
      { priorPrimary: 694575, priorSpouse: 0 },
      null,
      null,
    );
    expect(y74.rmdPrimary).toBe(37238.24);
    expect(y74.rmdDeferredPaidPrimary).toBe(10000);
    expect(y74.rmdDeferredPrimary).toBe(0);
  });

  test("an entering carry at the exact first RMD year is paid, not deferred twice", () => {
    // Age 73 is the first RMD year (born 1955 → 73), and the
    // election is on — but the carry means the first RMD year
    // already passed, so the year pays its own RMD plus the
    // carry and defers nothing.
    const carryPlan = samplePlanInputs({
      birthYearPrimary: 1955,
      birthYearSpouse: 1955,
      startYear: 2026,
      pretaxStart: 600000,
      firstRmdDeferralPrimary: true,
      firstRmdDeferredCarryPrimary: 10000,
    });
    // 661,500 / 26.5 = $24,962.26, plus the $10,000 carry.
    const y73 = priceOneWorkYear(
      carryPlan,
      job,
      73,
      null,
      null,
      { priorPrimary: 661500, priorSpouse: 0 },
      null,
      null,
    );
    expect(y73.rmdPrimary).toBe(34962.26);
    expect(y73.rmdDeferredPaidPrimary).toBe(10000);
    expect(y73.rmdDeferredPrimary).toBe(0);
  });

  test("a roll entered with a carry pays it in its first year", () => {
    // The roll starts at 71 (2026 − 1955), before the first
    // RMD year — but the carry is owed in the first simulated
    // year, exactly as the march pays its start-year carry-in,
    // so the 71 line pays the $10,000 and the roll hands
    // nothing on to the march.
    const carryPlan = samplePlanInputs({
      birthYearPrimary: 1955,
      birthYearSpouse: 1955,
      startYear: 2026,
      pretaxStart: 600000,
      firstRmdDeferralPrimary: true,
      firstRmdDeferredCarryPrimary: 10000,
    });
    const roll = rollWorkYears(carryPlan, job, 72);
    const line71 = roll.lines.find((l) => l.age === 71);
    expect(line71).toBeDefined();
    expect(line71!.rmdPrimary).toBe(10000);
    expect(line71!.rmdDeferredPaidPrimary).toBe(10000);
    expect(line71!.rmdDeferredPrimary).toBe(0);
    expect(roll.rolledInputs.firstRmdDeferredCarryPrimary).toBe(0);
  });

  test("a roll ending in the deferral year hands the pending amount to the march", () => {
    // Quit at 74: the last work year is the 73 deferral year.
    // The rolled inputs must carry the pending amount with
    // the already-priced flag set, so the march that follows
    // pays it in its first year and never defers it twice.
    const roll = rollWorkYears(plan, job, 74);
    const line73 = roll.lines.find((l) => l.age === 73);
    expect(line73).toBeDefined();
    expect(line73!.rmdPrimary).toBe(0);
    expect(line73!.rmdDeferredPrimary).toBeGreaterThan(0);
    expect(roll.rolledInputs.firstRmdDeferredCarryPrimary).toBe(
      line73!.rmdDeferredPrimary,
    );
    expect(roll.rolledInputs.firstRmdAlreadyPricedPrimary).toBe(true);
    expect(roll.rolledInputs.firstRmdDeferredCarrySpouse).toBe(0);
  });

  test("a roll spanning both years pays the carry in year 2 and clears it", () => {
    // Quit at 75: the 74 line pays its own RMD plus the
    // pending amount, and the rolled inputs carry nothing.
    const roll = rollWorkYears(plan, job, 75);
    const line73 = roll.lines.find((l) => l.age === 73)!;
    const line74 = roll.lines.find((l) => l.age === 74)!;
    expect(line73.rmdPrimary).toBe(0);
    expect(line73.rmdDeferredPrimary).toBeGreaterThan(0);
    expect(line74.rmdDeferredPaidPrimary).toBe(
      line73.rmdDeferredPrimary,
    );
    expect(line74.rmdDeferredPrimary).toBe(0);
    expect(line74.rmdPrimary).toBeGreaterThan(
      line73.rmdDeferredPrimary,
    );
    expect(roll.rolledInputs.firstRmdDeferredCarryPrimary).toBe(0);
    expect(roll.rolledInputs.firstRmdAlreadyPricedPrimary).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §3 — march-level spouse deferral (E5-S2; the adapter models one
// pre-tax pool, so a spouse balance can only be priced here, on the
// engine directly, with the sample household's own spouse balance)
// ---------------------------------------------------------------------------

describe("E5 §3 — march-level spouse deferral (separate pre-tax ownership)", () => {
  // Sample household, except the spouse holds her own $400,000
  // pre-tax balance. Primary born 1968 (first RMD 2043), spouse
  // born 1970 (first RMD 2045). Do Nothing (no conversions), so
  // the only pre-tax outflows are the RMDs and the spending
  // draws the draw order assigns.
  function marchWithSpouse(
    overrides: Record<string, unknown> = {},
  ) {
    const plan = samplePlanInputs({
      pretaxSpouseStart: 400000,
      ...overrides,
    });
    const result = simulateRothPlan(
      plan,
      ROTH_COMPARE_STRATEGIES[0]!,
    );
    const yearOf = (year: number) => {
      const row = result.years.find((y) => y.year === year);
      expect(row).toBeDefined();
      return row!;
    };
    return { result, yearOf };
  }

  test("spouse-only deferral: 2045 defers, 2046 pays both", () => {
    const control = marchWithSpouse();
    const deferred = marchWithSpouse({ firstRmdDeferralSpouse: true });
    const carry = control.yearOf(2045).detail.rmdSpouse;
    expect(carry).toBeGreaterThan(0);
    const d2045 = deferred.yearOf(2045);
    expect(d2045.detail.rmdSpouse).toBe(0);
    expect(d2045.detail.rmdDeferredSpouse).toBe(carry);
    expect(d2045.detail.rmdDeferredPaidSpouse).toBe(0);
    // The primary is untouched: his 2043–2045 RMDs match the
    // control exactly.
    expect(deferred.yearOf(2043).detail.rmdPrimary).toBe(
      control.yearOf(2043).detail.rmdPrimary,
    );
    expect(deferred.yearOf(2045).detail.rmdPrimary).toBe(
      control.yearOf(2045).detail.rmdPrimary,
    );
    const d2046 = deferred.yearOf(2046);
    const c2046 = control.yearOf(2046);
    expect(d2046.detail.rmdDeferredPaidSpouse).toBe(carry);
    expect(d2046.detail.rmdDeferredSpouse).toBe(0);
    // The deferred dollars stayed invested one more year at 5%,
    // so the 2046 own RMD is larger by carry × 1.05 / 23.7
    // (the Uniform divisor at 76). The ±$0.02 is the two
    // roundings to cents.
    const expected =
      c2046.detail.rmdSpouse + carry + (carry * 1.05) / 23.7;
    expect(Math.abs(d2046.detail.rmdSpouse - expected)).toBeLessThanOrEqual(
      0.02,
    );
  });

  test("both deferred in their own first RMD years", () => {
    const control = marchWithSpouse();
    const deferred = marchWithSpouse({
      firstRmdDeferralPrimary: true,
      firstRmdDeferralSpouse: true,
    });
    const carryP = control.yearOf(2043).detail.rmdPrimary;
    const carryS = control.yearOf(2045).detail.rmdSpouse;
    expect(carryP).toBeGreaterThan(0);
    expect(carryS).toBeGreaterThan(0);
    expect(deferred.yearOf(2043).detail.rmdPrimary).toBe(0);
    expect(deferred.yearOf(2043).detail.rmdDeferredPrimary).toBe(carryP);
    expect(deferred.yearOf(2044).detail.rmdDeferredPaidPrimary).toBe(
      carryP,
    );
    expect(deferred.yearOf(2045).detail.rmdSpouse).toBe(0);
    expect(deferred.yearOf(2045).detail.rmdDeferredSpouse).toBe(carryS);
    expect(deferred.yearOf(2046).detail.rmdDeferredPaidSpouse).toBe(
      carryS,
    );
  });
});

// ---------------------------------------------------------------------------
// §3 — the attainment year counts even on a $0 balance (E5-S2;
// restarted Pass 1 SHOULD-1)
// ---------------------------------------------------------------------------

describe("E5 §3 — settleFirstRmdDeferral: the attainment year counts", () => {
  test("a $0 attainment year sets had, so the next year cannot defer", () => {
    const state: FirstRmdDeferralState = {
      hadPrimary: false,
      hadSpouse: false,
      pendingPrimary: 0,
      pendingSpouse: 0,
    };
    // Attainment year, $0 computed, election on: defers $0
    // (nothing is owed) and marks the first RMD year as had.
    const y1 = settleFirstRmdDeferral(state, {
      who: "primary",
      computed: 0,
      deferElected: true,
      deathYearForPerson: false,
      carryIn: 0,
      rmdAgeReached: true,
    });
    expect(y1.pay).toBe(0);
    expect(y1.deferredThisYear).toBe(0);
    expect(state.hadPrimary).toBe(true);
    // Next year, positive computed RMD, election on: NOT the
    // first — it must be taken in its own year.
    const y2 = settleFirstRmdDeferral(state, {
      who: "primary",
      computed: 1000,
      deferElected: true,
      deathYearForPerson: false,
      carryIn: 0,
      rmdAgeReached: true,
    });
    expect(y2.pay).toBe(1000);
    expect(y2.deferredThisYear).toBe(0);
    expect(y2.deferredPaid).toBe(0);
  });
  test("before the RMD age, had stays false and the first payable year still defers", () => {
    const state: FirstRmdDeferralState = {
      hadPrimary: false,
      hadSpouse: false,
      pendingPrimary: 0,
      pendingSpouse: 0,
    };
    const y0 = settleFirstRmdDeferral(state, {
      who: "primary",
      computed: 0,
      deferElected: true,
      deathYearForPerson: false,
      carryIn: 0,
      rmdAgeReached: false,
    });
    expect(y0.pay).toBe(0);
    expect(state.hadPrimary).toBe(false);
    const y1 = settleFirstRmdDeferral(state, {
      who: "primary",
      computed: 1000,
      deferElected: true,
      deathYearForPerson: false,
      carryIn: 0,
      rmdAgeReached: true,
    });
    expect(y1.pay).toBe(0);
    expect(y1.deferredThisYear).toBe(1000);
    expect(state.pendingPrimary).toBe(1000);
  });
});

describe("E5 §3 — roll starting at the RMD age on a $0 balance", () => {
  test("the attainment year defers $0; the next year cannot defer", () => {
    // Primary born 1955, roll starts 2028 at age 73 (the
    // first RMD year) with a $0 pre-tax balance; the year's
    // 401(k) contributions land at year-end 73, after the
    // RMD is priced, so they enter the age-74 prior balance
    // ungrown. The attainment year (73) defers $0; the
    // following year must take its RMD in its own year. The
    // expected age-74 RMD is derived here from the priced
    // stack itself — the year's deferral + catch-up +
    // employer 401(k), all pre-tax money that landed at
    // year-end 73 — divided by the Uniform divisor at 74
    // (25.5), rounded to cents. The stack is priced by
    // contributionStack (a different function than the RMD
    // settle), so this cross-checks the RMD against the
    // balance it prices on rather than restating it.
    const plan = samplePlanInputs({
      birthYearPrimary: 1955,
      birthYearSpouse: 1955,
      startYear: 2028,
      pretaxStart: 0,
      firstRmdDeferralPrimary: true,
    });
    const job = { salary: 120000, employer401k: 50000, employerHsa: 0 };
    const roll = rollWorkYears(plan, job, 75);
    const line73 = roll.lines.find((l) => l.age === 73)!;
    const line74 = roll.lines.find((l) => l.age === 74)!;
    expect(line73.rmdPrimary).toBe(0);
    expect(line73.rmdDeferredPrimary).toBe(0);
    expect(line74.rmdDeferredPrimary).toBe(0);
    expect(line74.rmdDeferredPaidPrimary).toBe(0);
    expect(line74.rmdPrimary).toBeGreaterThan(0);
    const landed =
      line73.stack.deferral + line73.stack.catchUp + line73.stack.employer401k;
    expect(landed).toBeGreaterThan(0);
    expect(line74.rmdPrimary).toBe(
      Math.round((landed / 25.5) * 100) / 100,
    );
  });
});

// ---------------------------------------------------------------------------
// §3 — a deceased's carry-in is PAID in a combined survivor year
// (follow-up NICE 4N-2; pre-existing march edge, fixed here)
// ---------------------------------------------------------------------------

describe("E5 §3 — march combined-survivor year pays a deceased's carry-in", () => {
  // Sample household, except the death year is 2025 — the year
  // BEFORE the march's 2026 start year — so 2026 is already a
  // combined survivor year: the survivor holds the combined
  // $1,500,000 pre-tax balance and the deceased holds $0. A
  // $10,000 first-RMD carry belonging to the DECEASED enters at
  // startYear (degenerate input — death before plan start; the
  // roll never produces it, since the roll models no death).
  // The combined branch used to settle only the survivor's
  // side, so the deceased's carry was dropped: 2026 paid $0
  // and named $0 deferred-paid. The fix settles the
  // deceased's carry through the same helper and pays it out
  // of the combined balance in 2026.
  function marchWithDeceasedCarry(
    overrides: Record<string, unknown>,
  ) {
    const march = simulateRothPlan(
      samplePlanInputs({ ...overrides }),
      ROTH_COMPARE_STRATEGIES[0]!,
    );
    const yearOf = (year: number) => {
      const row = march.years.find((y) => y.year === year);
      expect(row).toBeDefined();
      return row!;
    };
    return { march, yearOf };
  }

  test("primary dies before plan start: his $10,000 carry is paid in 2026", () => {
    const { yearOf } = marchWithDeceasedCarry({
      survivorEnabled: true,
      survivorWho: "primary",
      survivorDeathYear: 2025,
      firstRmdDeferredCarryPrimary: 10000,
    });
    const y2026 = yearOf(2026);
    expect(y2026.detail.isSurvivorYear).toBe(true);
    // The combine put the whole balance on the survivor's side.
    expect(y2026.detail.priorPretaxPrimary).toBe(0);
    expect(y2026.detail.priorPretaxSpouse).toBe(1500000);
    // The deceased's carry is paid — and named as his.
    expect(y2026.detail.rmdDeferredPaidPrimary).toBe(10000);
    expect(y2026.detail.rmdDeferredPaidSpouse).toBe(0);
    // The survivor (born 1970, age 56) has no RMD of her own
    // yet, so the year's whole RMD is the deceased's carry,
    // paid out of the combined balance on her side.
    expect(y2026.detail.rmdSpouse).toBe(10000);
    expect(y2026.detail.rmdPrimary).toBe(0);
    // Paid exactly once: nothing deferred-paid in 2027, and
    // no RMD at all there (the survivor is still 57).
    const y2027 = yearOf(2027);
    expect(y2027.detail.rmdDeferredPaidPrimary).toBe(0);
    expect(y2027.detail.rmdSpouse).toBe(0);
    expect(y2027.detail.rmdPrimary).toBe(0);
  });

  test("spouse dies before plan start: her $10,000 carry is paid in 2026", () => {
    const { yearOf } = marchWithDeceasedCarry({
      survivorEnabled: true,
      survivorWho: "spouse",
      survivorDeathYear: 2025,
      firstRmdDeferredCarrySpouse: 10000,
    });
    const y2026 = yearOf(2026);
    expect(y2026.detail.isSurvivorYear).toBe(true);
    expect(y2026.detail.priorPretaxPrimary).toBe(1500000);
    expect(y2026.detail.priorPretaxSpouse).toBe(0);
    expect(y2026.detail.rmdDeferredPaidSpouse).toBe(10000);
    expect(y2026.detail.rmdDeferredPaidPrimary).toBe(0);
    // The survivor (born 1968, age 58) has no RMD of his own
    // yet, so the year's whole RMD is the deceased's carry.
    expect(y2026.detail.rmdPrimary).toBe(10000);
    expect(y2026.detail.rmdSpouse).toBe(0);
    const y2027 = yearOf(2027);
    expect(y2027.detail.rmdDeferredPaidSpouse).toBe(0);
    expect(y2027.detail.rmdPrimary).toBe(0);
    expect(y2027.detail.rmdSpouse).toBe(0);
  });
});
