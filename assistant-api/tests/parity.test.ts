// parity.test.ts — engine parity for the assistant-api adapter.
//
// Every adapter function is checked against the engine it wraps,
// called directly with the same inputs:
//   (a) calculateRetirement vs simulateDetailed + runHistorical
//   (b) Monte Carlo reproducibility, 0–1 success rate, dollar chart
//   (c) the normalize blended mirrors vs the engine's own functions
//   (d) compare rows reconcile (ending wealth, conversions)
//   (e) Roth delta conventions (scenario − baseline)
//   (f) single-year tax vs pricePlaygroundYear, built independently
//   (g) compareRetirementAges work-years leg, both salary branches
//   (h) max spending vs solveMaxSpending directly (85% target,
//       0–1 success rate, historical cross-check)
//
// NOTE on (d): the ending-wealth identity is endingWealth =
// endingPretax + endingTaxable + endingRoth + endingHsa − terminalTax
// (verified against runRothCompare directly: the raw diff is
// −terminalTax to the cent). An earlier draft of this test asserted
// endingWealth == the bare bucket sum; that fails by exactly the
// terminal tax, because ending wealth is after-tax wealth. The
// corrected identity is pinned here.
//
// All figures are the fictional household (see helpers.ts). MC runs
// stay ≤ 200 except where the spec's own default is exercised; the
// work-years leg is the one slow test (~90s for 2 ages on this VM)
// and carries its own timeout. The work-years leg with a spouse
// Social Security benefit is NOT run here — it needs substantially
// more than this VM's 6 GB (verified OOM, twice); see the README.

import { describe, expect, test } from "bun:test";
import {
  calculateMaxSpending,
  calculateRetirement,
  calculateSingleYearTax,
  centsToDollars,
  compareRetirementAges,
  compareRothConversions,
  compareWithdrawalStrategies,
  runRetirementMonteCarlo,
} from "../src/adapter";
import { blendedExpectedPct, blendedVolPct } from "../src/normalize";
import {
  GUARDRAILS_ADJUSTMENT_DEFAULT,
  GUARDRAILS_CUT_DEFAULT,
  GUARDRAILS_RAISE_DEFAULT,
  PHASE_DECLINE_PCT_DEFAULT,
  PHASE_START_AGE_DEFAULT,
  blendedExpected,
  blendedVol,
  horizonYears,
  runHistorical,
  runMonteCarlo,
  simulateDetailed,
  solveMaxSpending,
  type SimInputs,
} from "../../server/src/retirementEngines";
import {
  pricePlaygroundYear,
  type PlaygroundYearInputs,
} from "../../server/src/rothOptimizer";
import {
  expectEnvelope,
  expectOk,
  normalizedScenario,
  round2,
  roundDeep,
} from "./helpers";

/** The SimInputs the adapter builds for the fictional scenario:
 *  constant strategy, both SS streams starting at 67 so they sum. */
function directSimInputs(): SimInputs {
  const s = normalizedScenario();
  return {
    startCents: s.portfolioCents,
    spendingCents: s.annualSpendingCents,
    currentAge: s.currentAge,
    retirementAge: s.retirementAge,
    endAge: s.endAge,
    extraIncomeCents: (36000 + 18000) * 100,
    extraIncomeStartAge: 67,
    strategy: "constant",
    percentOfPortfolio: 0,
    guardrailsCutPct: GUARDRAILS_CUT_DEFAULT,
    guardrailsRaisePct: GUARDRAILS_RAISE_DEFAULT,
    guardrailsAdjustmentPct: GUARDRAILS_ADJUSTMENT_DEFAULT,
    phaseStartAge: PHASE_START_AGE_DEFAULT,
    phaseDeclinePct: PHASE_DECLINE_PCT_DEFAULT,
  };
}

describe("calculateRetirement vs the sim engines directly", () => {
  test("ending balance, yearly tables, and historical cross-check match to the cent", () => {
    const s = normalizedScenario();
    const res = expectOk(calculateRetirement(s));
    const inputs = directSimInputs();
    const returns = Array.from(
      { length: horizonYears(54, 95) },
      () => s.expectedReturnPct / 100,
    );
    const det = simulateDetailed(inputs, returns);
    const hist = runHistorical(inputs, s.stocksPct);
    expect(hist).not.toBeNull();

    const lastBalance = det.balances[det.balances.length - 1] ?? 0;
    expect(res.endingBalance).toBe(Math.round(lastBalance) / 100);
    expect(res.neverRunsOut).toBe(true);
    expect(res.yearlyBalances).toEqual(
      det.balances.map((b, i) => ({
        age: 54 + i,
        balance: Math.round(b) / 100,
      })),
    );
    expect(res.yearlyGrossWithdrawals).toEqual(
      det.grossWithdrawals.map((c, i) => ({
        age: 54 + i,
        amount: Math.round(c) / 100,
      })),
    );
    expect(res.yearlyNetWithdrawals).toEqual(
      det.netWithdrawals.map((c, i) => ({
        age: 54 + i,
        amount: Math.round(c) / 100,
      })),
    );
    expect(res.historicalNeverOutRate).toBe(
      round2(hist!.neverOutSuccessRate / 100),
    );
    expect(res.historicalMedianEnding).toBe(
      Math.round(hist!.medianEnding) / 100,
    );
  });
});

describe("Monte Carlo", () => {
  test("the reported success rate is a fraction 0–1, not a percent", () => {
    const res = expectOk(
      runRetirementMonteCarlo(normalizedScenario({ mcRuns: 200, mcSeed: 42 })),
    );
    expect(res.successRate).toBeGreaterThanOrEqual(0);
    expect(res.successRate).toBeLessThanOrEqual(1);
    expect(res.successRate).toBeCloseTo(0.99, 2);
  });

  test("same seed twice is identical; a different seed (usually) differs", () => {
    const run = (seed: number) =>
      runRetirementMonteCarlo(
        normalizedScenario({ mcRuns: 200, mcSeed: seed }),
      );
    const first = run(42);
    const second = run(42);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    const other = run(43);
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(first));
    if (other.ok && first.ok) {
      expect(
        other.results.endingP50 !== first.results.endingP50 ||
          other.results.successRate !== first.results.successRate,
      ).toBe(true);
    }
  });

  test("the MC chart is dollars, not cents", () => {
    const res = expectOk(
      runRetirementMonteCarlo(normalizedScenario({ mcRuns: 200, mcSeed: 42 })),
    );
    // Every path starts at the same portfolio, so the first chart row
    // is exactly the starting portfolio in dollars ($3,787,000).
    expect(res.chart[0]?.age).toBe(54);
    expect(res.chart[0]?.median).toBe(3787000);
    expect(res.chart[0]?.p10).toBe(3787000);
    expect(res.chart[0]?.p90).toBe(3787000);
    // A cents chart would read ~$378,700,000 here.
    for (const row of res.chart) {
      expect(row.median).toBeLessThan(3787000 * 100);
    }
    // And the direct engine agrees: its chart is already dollars.
    const inputs = directSimInputs();
    const mc = runMonteCarlo(
      inputs,
      6.75 / 100,
      17.4 / 100,
      42,
      200,
    );
    expect(mc).not.toBeNull();
    expect(round2(mc!.chart[0]!.median)).toBe(3787000);
    expect(res.endingP50).toBe(Math.round(mc!.p50) / 100);
  });
});

describe("blended mirror parity", () => {
  test.each([0, 25, 50, 95, 100])(
    "blendedExpectedPct/blendedVolPct equal the engine's at stocksPct %i",
    (stocksPct) => {
      expect(blendedExpectedPct(stocksPct)).toBe(blendedExpected(stocksPct));
      expect(blendedVolPct(stocksPct)).toBe(blendedVol(stocksPct));
    },
  );

  test("spot values: 95% stocks is 6.75% return, 17.4% vol", () => {
    expect(blendedExpectedPct(95)).toBe(6.75);
    expect(blendedVolPct(95)).toBe(17.4);
    expect(blendedExpectedPct(0)).toBe(2);
    expect(blendedVolPct(0)).toBe(6);
    expect(blendedExpectedPct(100)).toBe(7);
    expect(blendedVolPct(100)).toBe(18);
  });
});

describe("compare rows reconcile", () => {
  test("withdrawal strategies: ending wealth = buckets − terminal tax; yearly conversions sum to the baseline total", () => {
    const res = expectOk(compareWithdrawalStrategies(normalizedScenario()));
    expect(res.scenarios).toHaveLength(3);
    for (const sc of res.scenarios) {
      const buckets =
        sc.endingPretax + sc.endingTaxable + sc.endingRoth + sc.endingHsa;
      expect(Math.abs(sc.endingWealth - (buckets - sc.terminalTax))).toBeLessThanOrEqual(
        0.02,
      );
    }
    const baseline = res.scenarios.find((s) => s.name === res.baselineName)!;
    const yearlyConversions = res.yearly.reduce((a, y) => a + y.conversion, 0);
    expect(Math.abs(yearlyConversions - baseline.conversionsTotal)).toBeLessThanOrEqual(
      0.5,
    );
  });

  test("Roth conversions: same identity, and the fill strategies really convert", () => {
    const res = expectOk(compareRothConversions(normalizedScenario()));
    expect(res.scenarios.map((s) => s.name)).toEqual([
      "do-nothing",
      "fill-12%",
      "fill-22%",
      "fill-22%-irmaa-tier-1",
    ]);
    for (const sc of res.scenarios) {
      const buckets =
        sc.endingPretax + sc.endingTaxable + sc.endingRoth + sc.endingHsa;
      expect(Math.abs(sc.endingWealth - (buckets - sc.terminalTax))).toBeLessThanOrEqual(
        0.02,
      );
    }
    expect(res.scenarios[0]?.conversionsTotal).toBe(0);
    for (const sc of res.scenarios.slice(1)) {
      expect(sc.conversionsTotal).toBeGreaterThan(0);
    }
    const baseline = res.scenarios[0]!;
    const yearlyConversions = res.yearly.reduce((a, y) => a + y.conversion, 0);
    expect(Math.abs(yearlyConversions - baseline.conversionsTotal)).toBeLessThanOrEqual(
      0.5,
    );
  });

  test("Roth deltas are exactly (scenario − baseline) for wealth and net cost", () => {
    const res = expectOk(compareRothConversions(normalizedScenario()));
    const baseline = res.scenarios.find((s) => s.name === res.baselineName)!;
    expect(res.deltas).toHaveLength(3);
    for (const d of res.deltas) {
      const sc = res.scenarios.find((s) => s.name === d.name)!;
      expect(d.endingWealthDelta).toBe(
        round2(sc.endingWealth - baseline.endingWealth),
      );
      expect(d.netCostDelta).toBe(
        round2(sc.lifetimeNetCost - baseline.lifetimeNetCost),
      );
    }
    // The baseline itself never appears in deltas.
    expect(res.deltas.map((d) => d.name)).not.toContain(res.baselineName);
  });
});

describe("single-year tax vs pricePlaygroundYear, built independently", () => {
  test("every tax-aware response reports taxLawYear 2026", () => {
    const single = expectEnvelope(
      calculateSingleYearTax(
        normalizedScenario({
          taxYear: 2026,
          interestAnnual: 1000,
          ordinaryDividendsAnnual: 5000,
          qualifiedDividendsAnnual: 3000,
          conversionAnnual: 20000,
          spendingDrawAnnual: 114000,
        }),
      ),
    );
    expect(single.taxLawYear).toBe(2026);
    const roth = expectEnvelope(compareRothConversions(normalizedScenario()));
    expect(roth.taxLawYear).toBe(2026);
  });

  test("the single-year figures match a direct pricePlaygroundYear call on the same inputs", () => {
    const s = normalizedScenario({
      taxYear: 2026,
      interestAnnual: 1000,
      ordinaryDividendsAnnual: 5000,
      qualifiedDividendsAnnual: 3000,
      conversionAnnual: 20000,
      spendingDrawAnnual: 114000,
      cashDrawAnnual: 0,
      rothDrawAnnual: 0,
    });
    const res = expectOk(calculateSingleYearTax(s));
    // Built by hand from the SAME scenario fields the adapter reads —
    // this is the independence: if the adapter mis-mapped a field,
    // the two pricings would disagree.
    const direct: PlaygroundYearInputs = {
      taxYear: 2026,
      filingStatus: "mfj",
      agePrimary: s.currentAge + (s.taxYear - s.startYear),
      ageSpouse: s.birthYearSpouse === null ? null : s.taxYear - s.birthYearSpouse,
      onMedicarePrimary: false,
      onMedicareSpouse: false,
      interest: s.singleYear.interest,
      ordinaryDividends: s.singleYear.ordinaryDividends,
      otherOrdinary: s.otherOrdinaryAnnual,
      taxExemptInterest: s.taxExemptInterestAnnual,
      ssPrimary: 0, // start age 67 not reached at 54
      ssSpouse: 0,
      conversion: s.singleYear.conversion,
      spendingDraw: s.singleYear.spendingDraw,
      cashDraw: s.singleYear.cashDraw,
      rothDraw: s.singleYear.rothDraw,
      inflationPct: s.inflationPct,
      stockSold: 0,
      stockBasis: 0,
      qualifiedDividends: s.singleYear.qualifiedDividends,
      pretaxBalance: null,
      spouseSoleBeneficiary: true,
      acaHouseholdSize: s.householdSize,
      acaBenchmarkAnnual: null, // no benchmark given
      stateRatePct: s.stateRatePct,
      residenceState: s.residenceState,
      annualSpending: s.annualSpendingCents / 100,
    };
    const priced = pricePlaygroundYear(direct);
    expect(res).toEqual(roundDeep(priced));
    // Spot figures, so a passing deep-equal still reads as a check.
    expect(res.federalTax).toBe(12930);
    expect(res.totalTax).toBe(12930);
    expect(res.agi).toBe(140000);
  });

  test("the single-year result carries no settlement flags, and the compare yearly table says what it omits", () => {
    const res = expectOk(
      calculateSingleYearTax(
        normalizedScenario({
          taxYear: 2026,
          conversionAnnual: 20000,
          spendingDrawAnnual: 114000,
        }),
      ),
    );
    expect("settlementConverged" in res).toBe(false);
    expect("settlementMismatchCents" in res).toBe(false);
    expect("ceilingBreached" in res).toBe(false);

    const compared = expectEnvelope(
      compareWithdrawalStrategies(normalizedScenario()),
    );
    // The yearly rows carry tax/credit/IRMAA/conversion — never
    // spending or per-year ending balances.
    for (const row of compared.results.yearly) {
      expect("spending" in row).toBe(false);
      expect("endingBalance" in row).toBe(false);
      expect("endingWealth" in row).toBe(false);
    }
    expect(compared.warnings.join(" ")).toContain(
      "not spending or per-year ending balances",
    );
  });
});

describe("compareRetirementAges work-years leg", () => {
  test("without a salary the comparison still answers, with workYears [] and a salary warning", () => {
    const res = expectEnvelope(
      compareRetirementAges(normalizedScenario({ compareAges: [60, 62] })),
    );
    expect(res.results.scenarios.map((s) => s.retirementAge)).toEqual([
      60, 62,
    ]);
    expect(res.results.workYears).toEqual([]);
    expect(res.results.workYearsWinnerByAllInTax).toBeNull();
    expect(res.warnings.join(" ")).toMatch(/salary/i);
  });

  test(
    "with a salary (spouse SS $0) the work-years leg prices each quit age",
    () => {
      const res = expectEnvelope(
        compareRetirementAges(
          normalizedScenario({
            salaryAnnual: 120000,
            spouseSocialSecurityAnnual: 0,
            compareAges: [60, 62],
          }),
        ),
      );
      expect(res.results.workYears.map((w) => w.quitAge)).toEqual([60, 62]);
      for (const w of res.results.workYears) {
        expect(Number.isFinite(w.allInTax)).toBe(true);
        expect(w.allInTax).toBeGreaterThan(0);
        expect(Number.isFinite(w.endingAfterTax)).toBe(true);
      }
      const cheapest = res.results.workYears.reduce((a, b) =>
        a.allInTax < b.allInTax ? a : b,
      );
      expect(res.results.workYearsWinnerByAllInTax).toBe(
        `retire-${cheapest.quitAge}`,
      );
      // No salary warning when a salary was given.
      expect(res.warnings.join(" ")).not.toMatch(
        /no salary was provided/i,
      );
    },
    240_000,
  );
});

describe("calculateMaxSpending vs solveMaxSpending directly", () => {
  test("max annual/monthly, success rate (0–1 fraction), median ending, historical cross-check match", () => {
    const s = normalizedScenario();
    const res = expectOk(calculateMaxSpending(s));
    const inputs = directSimInputs();
    const expected = s.expectedReturnPct / 100;
    const vol = s.volatilityPct / 100;
    const solved = solveMaxSpending(
      inputs,
      s.stocksPct,
      expected,
      vol,
      "montecarlo",
      85,
      s.mcSeed,
    );
    const histSolved = solveMaxSpending(
      inputs,
      s.stocksPct,
      expected,
      vol,
      "historical",
      85,
      s.mcSeed,
    );
    expect(solved).not.toBeNull();
    if (solved === null) throw new Error("solver returned null");
    expect(res.maxAnnualSpending).toBe(
      centsToDollars(solved.maxSpendingCents),
    );
    expect(res.maxMonthlySpending).toBe(
      Math.round((res.maxAnnualSpending / 12) * 100) / 100,
    );
    // Success rate is a 0–1 fraction, not the engine's 0–100 percent.
    expect(res.successRate).toBe(Math.round(solved.successRate) / 100);
    expect(res.successRate).toBeGreaterThanOrEqual(0);
    expect(res.successRate).toBeLessThanOrEqual(1);
    expect(res.medianEnding).toBe(centsToDollars(solved.medianEnding));
    expect(res.approximate).toBe(solved.approximate);
    expect(res.historicalMaxAnnualSpending).toBe(
      histSolved === null
        ? null
        : centsToDollars(histSolved.maxSpendingCents),
    );
  }, 30_000);

  test("mcRuns is inert: 10 vs 5000 give identical results; runs reports the fixed 1000 (pass-3 S1)", () => {
    // solveMaxSpending takes no run count — its Monte Carlo leg always
    // runs MONTE_CARLO_TAB_RUNS (1000). The adapter must say so in the
    // response instead of echoing the caller's mcRuns as if it mattered.
    const a = expectEnvelope(
      calculateMaxSpending(normalizedScenario({ mcRuns: 10 })),
    );
    const b = expectEnvelope(
      calculateMaxSpending(normalizedScenario({ mcRuns: 5000 })),
    );
    expect(b.results.maxMonthlySpending).toBe(a.results.maxMonthlySpending);
    expect(b.results.maxAnnualSpending).toBe(a.results.maxAnnualSpending);
    expect(b.results.successRate).toBe(a.results.successRate);
    expect(b.results.medianEnding).toBe(a.results.medianEnding);
    expect(b.results.historicalMaxAnnualSpending).toBe(
      a.results.historicalMaxAnnualSpending,
    );
    expect(a.results.runs).toBe(1000);
    expect(b.results.runs).toBe(1000);
    const byField = new Map(a.assumptions.map((x) => [x.field, x]));
    expect(byField.get("mcRunsEffective")).toMatchObject({
      value: 1000,
      provenance: "engine_constant",
    });
  }, 60_000);
});

describe("priced-input inertness (pass-4 S1, pass-5 S1)", () => {
  // The guide lists only inputs each tool prices. These tests prove
  // the two pass-4 corrections live: mcRuns/mcSeed do nothing for
  // the deterministic calculate (no Monte Carlo leg at all), and
  // taxYear does nothing for the compare tools (the march starts at
  // startYear). The envelope check pins D10: a compare call with
  // taxYear 2025 still reports taxLawYear 2026 (the march's first
  // year), while the single-year tool genuinely prices the year it
  // is given. Work-years taxYear inertness is code-verified only
  // (same runCompare path as the two compares priced here); a live
  // second work-years leg was not run for it.
  test("calculate ignores mcRuns/mcSeed: varied runs/seeds give identical results", () => {
    const a = expectEnvelope(
      calculateRetirement(
        normalizedScenario({ mcRuns: 10, mcSeed: 1 }),
      ),
    );
    const b = expectEnvelope(
      calculateRetirement(
        normalizedScenario({ mcRuns: 5000, mcSeed: 999 }),
      ),
    );
    expect(JSON.stringify(a.results)).toBe(JSON.stringify(b.results));
    expect(a.taxLawYear).toBe(2026);
    expect(b.taxLawYear).toBe(2026);
  });

  test("calculate ignores volatilityPct: 5 vs 50 give identical results (pass-5 S1)", () => {
    // calculateRetirement runs only simulateDetailed + runHistorical
    // + runNeverRunsOut — none takes volatility, which only the
    // Monte Carlo legs (MC tool, max-spending solver) read.
    const a = expectEnvelope(
      calculateRetirement(normalizedScenario({ volatilityPct: 5 })),
    );
    const b = expectEnvelope(
      calculateRetirement(normalizedScenario({ volatilityPct: 50 })),
    );
    expect(JSON.stringify(a.results)).toBe(JSON.stringify(b.results));
  });

  test(
    "compare and roth-conversion ignore taxYear; the envelope reports the march's first year",
    () => {
      const c25 = expectEnvelope(
        compareWithdrawalStrategies(
          normalizedScenario({ taxYear: 2025 }),
        ),
      );
      const c26 = expectEnvelope(
        compareWithdrawalStrategies(
          normalizedScenario({ taxYear: 2026 }),
        ),
      );
      expect(JSON.stringify(c25.results)).toBe(JSON.stringify(c26.results));
      expect(c25.taxLawYear).toBe(2026);
      expect(c26.taxLawYear).toBe(2026);
      const r25 = expectEnvelope(
        compareRothConversions(normalizedScenario({ taxYear: 2025 })),
      );
      const r26 = expectEnvelope(
        compareRothConversions(normalizedScenario({ taxYear: 2026 })),
      );
      expect(JSON.stringify(r25.results)).toBe(JSON.stringify(r26.results));
      expect(r25.taxLawYear).toBe(2026);
      expect(r26.taxLawYear).toBe(2026);
    },
    60_000,
  );

  test("single-year tax genuinely prices taxYear (control for the override)", () => {
    // NOTE: expectEnvelope pins taxLawYear 2026, so the 2025 call
    // below asserts ok:true directly instead.
    const priced = (taxYear: number) => {
      const res = calculateSingleYearTax(
        normalizedScenario({
          taxYear,
          interestAnnual: 1000,
          ordinaryDividendsAnnual: 5000,
          qualifiedDividendsAnnual: 3000,
          conversionAnnual: 20000,
          spendingDrawAnnual: 114000,
        }),
      );
      if (!res.ok) throw new Error(JSON.stringify(res.error));
      return res;
    };
    const y25 = priced(2025);
    const y26 = priced(2026);
    expect(y25.taxLawYear).toBe(2025);
    expect(y26.taxLawYear).toBe(2026);
    expect(y25.results.federalTax).not.toBe(y26.results.federalTax);
  });
});
