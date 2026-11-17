// Engine Review C10 — dynamic withdrawal optimizer.
// Every case is the fictional sample household
// (server/src/sampleHousehold.ts) or a small derived variant —
// no figure here describes any real household. Short horizons
// (end age 70) so the full 114-policy dynamic run completes on
// the 6 GB VM; the reference-scenario full-horizon numbers live
// in the builder probe (probes/c10-reference.ts), not here.
// Run per-file: bun test server/src/reviewC10Dynamic.test.ts
import { describe, expect, test } from "bun:test";
import {
  buildRothFunding,
  dynamicPhaseForYear,
  dynamicPolicySet,
  dynamicTerminalTax,
  netCostBreakdown,
  priceFixedDynamicPolicies,
  pricePlaygroundYear,
  rescoreDynamicTerminal,
  runDynamicAbExperiment,
  runDynamicAcaSensitivity,
  runDynamicOptimizer,
  trackEligibleEnd,
  trackTaxableBasisEnd,
} from "./rothOptimizer";
import { NO_CEILINGS, simulateRothPlan, type DrawOrder, type RothPlanInputs } from "./taxEngine";
import { samplePlanInputs } from "./sampleHousehold";

/* The sample household, end age 70 (2026–2038, primary 58–70):
   short enough for the full dynamic set, long enough to cross
   the early / ACA / bridge / SS phases. */
function shortInputs(overrides: Partial<RothPlanInputs> = {}): RothPlanInputs {
  return samplePlanInputs({ endAgePrimary: 70, ...overrides });
}

describe("C10 — phases", () => {
  test("phase precedence: survivor > rmd > ss > bridge > early > aca", () => {
    const base = { isSurvivorYear: false, rmdAge: 75, ssStartAge: 67 };
    expect(dynamicPhaseForYear({ ...base, agePrimary: 55 })).toBe("early");
    expect(dynamicPhaseForYear({ ...base, agePrimary: 59 })).toBe("early");
    expect(dynamicPhaseForYear({ ...base, agePrimary: 60 })).toBe("aca");
    expect(dynamicPhaseForYear({ ...base, agePrimary: 64 })).toBe("aca");
    expect(dynamicPhaseForYear({ ...base, agePrimary: 65 })).toBe("bridge");
    expect(dynamicPhaseForYear({ ...base, agePrimary: 66 })).toBe("bridge");
    expect(dynamicPhaseForYear({ ...base, agePrimary: 67 })).toBe("ss");
    expect(dynamicPhaseForYear({ ...base, agePrimary: 74 })).toBe("ss");
    expect(dynamicPhaseForYear({ ...base, agePrimary: 75 })).toBe("rmd");
    expect(dynamicPhaseForYear({ ...base, agePrimary: 95 })).toBe("rmd");
    expect(dynamicPhaseForYear({ ...base, agePrimary: 60, isSurvivorYear: true })).toBe("survivor");
    expect(dynamicPhaseForYear({ ...base, agePrimary: 80, isSurvivorYear: true })).toBe("survivor");
  });

  test("policy set: 114 policies, unique keys, 6 Do Nothing", () => {
    const policies = dynamicPolicySet(74, 95);
    expect(policies.length).toBe(114);
    expect(new Set(policies.map((p) => p.key)).size).toBe(114);
    expect(policies.filter((p) => p.ceilings == null).length).toBe(6);
  });
});

describe("C10 — ledger helpers", () => {
  test("taxable basis: sales consume basis, sweep restores it", () => {
    // Start $2,000,000 / basis $1,200,000; sell $100,000 with
    // $40,000 of gains (basis consumed $60,000); end $2,100,000
    // at 5% growth, so the sweep is $100,000 and — with no
    // reinvested yield — ending basis is
    // $1,200,000 − $60,000 + $100,000 = $1,240,000.
    expect(
      trackTaxableBasisEnd({
        taxableStart: 2000000,
        basisStart: 1200000,
        taxableSold: 100000,
        drawGains: 40000,
        taxableEnd: 2100000,
        growthFactor: 1.05,
        yieldReinvested: 0,
      }),
    ).toBe(1240000);
    // The same year with $26,000 of reinvested yield: the
    // yield adds to basis without adding to the balance.
    expect(
      trackTaxableBasisEnd({
        taxableStart: 2000000,
        basisStart: 1200000,
        taxableSold: 100000,
        drawGains: 40000,
        taxableEnd: 2100000,
        growthFactor: 1.05,
        yieldReinvested: 26000,
      }),
    ).toBe(1266000);
  });

  test("eligibility: outflows consume eligible dollars first", () => {
    expect(
      trackEligibleEnd({
        eligibleStart: 1500000,
        pretaxStart: 1500000,
        pretaxEnd: 1417500,
        growthFactor: 1.05,
      }),
    ).toBe(1417500);
    expect(
      trackEligibleEnd({ eligibleStart: null, pretaxStart: 1500000, pretaxEnd: 1417500, growthFactor: 1.05 }),
    ).toBeNull();
  });

  test("terminal helper agrees with netCostBreakdown on a priced march", () => {
    const inputs = shortInputs();
    const result = simulateRothPlan(
      inputs,
      { id: "none", name: "Do Nothing", ceilings: null },
      undefined,
      { leanDetail: true },
    );
    const priced = netCostBreakdown(result, 24, { preservePretax: 250000, preserveExitRatePct: 10 });
    const helper = dynamicTerminalTax({
      endingPretax: result.endingPretax,
      heirRatePct: 24,
      preservePretax: 250000,
      preserveExitRatePct: 10,
    });
    expect(helper.terminal).toBe(priced.terminal);
    expect(helper.preservedPretax).toBe(priced.preservedPretax);
    expect(helper.excessPretax).toBe(priced.excessPretax);
  });
});

describe("C10 — roll-forward parity (shared-engine proof)", () => {
  test("single fixed policy rolled forward reproduces its single march within 2¢", () => {
    const inputs = shortInputs();
    const order: DrawOrder = ["taxable", "pretax", "roth"];
    const policy = {
      key: "fill12|stop95|taxable-pretax-roth",
      name: "Fill 12% · stop 95",
      ceilings: { ...NO_CEILINGS, bracketTopPct: 12 },
      guardrail: false,
      windowStopAge: 95,
      drawOrder: order,
    };
    const march = simulateRothPlan(
      { ...inputs, windowStopAge: 95, drawOrder: [...order] },
      { id: "parity", name: "Fill 12% · stop 95", ceilings: policy.ceilings, guardrail: false },
      undefined,
      { leanDetail: true },
    );
    const rolled = runDynamicOptimizer(inputs, { policies: [policy] });
    expect(rolled.ok).toBe(true);
    expect(rolled.floorBound).toBe(false);
    expect(rolled.years.length).toBe(march.years.length);
    // Re-anchor rounding: the march carries fractional-cent
    // float balances internally while its year rows are
    // cent-rounded, so a rolled-forward year can price a cent
    // off the uninterrupted march (the engine's own settlement
    // tolerance is 2¢ per component per year). The parity bar
    // is therefore 2¢ per field, not exact cents — and the
    // observed worst case on this plan is 1¢.
    const within2c = (a: number, b: number) => Math.abs(a - b) <= 0.02;
    for (let i = 0; i < march.years.length; i++) {
      const m = march.years[i]!;
      const r = rolled.years[i]!;
      expect(r.year).toBe(m.year);
      expect(within2c(r.federalTax, m.federalTax)).toBe(true);
      expect(within2c(r.conversion, m.funding.conversion)).toBe(true);
      expect(within2c(r.pretaxDraw, m.funding.pretaxDraw)).toBe(true);
      expect(within2c(r.taxableSoldForSpending, m.funding.taxableSoldForSpending)).toBe(true);
      expect(within2c(r.taxableSoldForTax, m.funding.taxableSoldForTax)).toBe(true);
      expect(within2c(r.rothDraw, m.funding.rothDraw)).toBe(true);
      expect(within2c(r.rmd, m.funding.rmd)).toBe(true);
      expect(within2c(r.magi, m.magi)).toBe(true);
      expect(within2c(r.acaCreditKept, m.acaCreditKept)).toBe(true);
      expect(within2c(r.pretaxEnd, m.pretaxEnd)).toBe(true);
      expect(within2c(r.rothEnd, m.rothEnd)).toBe(true);
      expect(within2c(r.taxableEnd, m.taxableEnd)).toBe(true);
    }
    // The roll-forward's ending basis is a real ledger figure:
    // non-negative and never above the ending balance by more
    // than a cent of rounding.
    const last = rolled.years[rolled.years.length - 1]!;
    expect(last.taxableBasisEnd).toBeGreaterThanOrEqual(0);
    expect(last.taxableBasisEnd).toBeLessThanOrEqual(last.taxableEnd + 0.01);
    // Net cost agrees with the single march's planNetCost to
    // within the re-anchor rounding epsilon ($0.10 — the
    // observed gap on this plan is $0.02).
    expect(Math.abs(
      rolled.lifetimeNetCost -
      netCostBreakdown(march, inputs.heirRatePct, {
        preservePretax: inputs.preservePretax ?? 0,
        preserveExitRatePct: inputs.preserveExitRatePct ?? inputs.heirRatePct,
      }).netCost,
    )).toBeLessThanOrEqual(0.1);
  });

  test("dynamic first-year row agrees with the funding ledger on the same inputs", () => {
    const inputs = shortInputs();
    const order: DrawOrder = ["taxable", "pretax", "roth"];
    const strategy = {
      id: "parity",
      name: "Fill 12%",
      ceilings: { ...NO_CEILINGS, bracketTopPct: 12 },
      guardrail: false,
    };
    const funding = buildRothFunding(
      { ...inputs, windowStopAge: 95, drawOrder: [...order] },
      strategy,
    );
    const policy = {
      key: "fill12|stop95|taxable-pretax-roth",
      name: "Fill 12% · stop 95",
      ceilings: strategy.ceilings,
      guardrail: false,
      windowStopAge: 95,
      drawOrder: order,
    };
    const rolled = runDynamicOptimizer(inputs, { policies: [policy] });
    expect(rolled.ok).toBe(true);
    const first = rolled.years[0]!;
    const f0 = funding[0]!;
    expect(first.federalTax).toBe(f0.federalTaxCents / 100);
    expect(first.conversion).toBe(f0.conversionCents / 100);
    expect(first.pretaxDraw).toBe(f0.pretaxDrawCents / 100);
    expect(first.magi).toBe(f0.magiCents / 100);
    expect(first.acaCreditKept).toBe(f0.acaCreditCents / 100);
    expect(first.rmd).toBe(f0.rmdCents / 100);
  });
});

describe("C10 — dynamic optimizer (full set, short horizon)", () => {
  test("dynamic is valid and never worse than the best fixed policy", () => {
    const inputs = shortInputs();
    const result = runDynamicOptimizer(inputs);
    expect(result.ok).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.years.length).toBe(13);
    expect(result.bestFixed).not.toBeNull();
    // Never worse than the best fixed policy beyond the
    // re-anchor rounding epsilon ($0.10).
    expect(result.lifetimeNetCost).toBeLessThanOrEqual((result.bestFixed?.netCost ?? 0) + 0.1);
    if (result.floorBound) {
      expect(result.lifetimeNetCost).toBeCloseTo(result.bestFixed?.netCost ?? 0, 2);
    } else {
      expect(result.greedyNetCost).toBeCloseTo(result.lifetimeNetCost, 2);
    }
    // Totals foot from the rows.
    expect(result.lifetimeFederalTax).toBeCloseTo(
      result.years.reduce((s, r) => s + r.federalTax, 0),
      2,
    );
    expect(result.conversionsTotal).toBeCloseTo(
      result.years.reduce((s, r) => s + r.conversion, 0),
      2,
    );
    // No RMDs before 75 on this horizon.
    expect(result.lifetimeRmd).toBe(0);
    expect(result.firstRmdYear).toBeNull();
    // Phases actually visited on ages 58–70.
    const phases = new Set(result.years.map((r) => r.phase));
    expect(phases.has("early")).toBe(true);
    expect(phases.has("aca")).toBe(true);
    expect(phases.has("bridge")).toBe(true);
    expect(phases.has("ss")).toBe(true);
  }, 300_000);

  test("survivor years phase as survivor", () => {
    const inputs = shortInputs({
      survivorEnabled: true,
      survivorWho: "primary",
      survivorDeathYear: 2036,
    });
    const result = runDynamicOptimizer(inputs);
    expect(result.ok).toBe(true);
    const after = result.years.filter((r) => r.year > 2036);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((r) => r.phase === "survivor")).toBe(true);
    expect(result.years.find((r) => r.year === 2036)?.phase).not.toBe("survivor");
  }, 300_000);
});

describe("C10 — A-vs-B equal-income-budget experiment", () => {
  test("C (dynamic) is never worse than A or B; B realizes gains in year 1 at $100K", () => {
    const inputs = shortInputs();
    const rows = runDynamicAbExperiment(inputs, [0, 50000, 100000]);
    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(Number.isFinite(row.a.netCost)).toBe(true);
      expect(Number.isFinite(row.b.netCost)).toBe(true);
      expect(Number.isFinite(row.c.netCost)).toBe(true);
      expect(row.c.netCost).toBeLessThanOrEqual(Math.min(row.a.netCost, row.b.netCost) + 0.01);
    }
    // The $100K central question, year 1, priced exactly
    // (not via a fill): A draws $100K from pre-tax for
    // spending; B converts exactly $100K to Roth while $100K
    // of spending comes from a taxable sale ($50,000 basis).
    // Same $100K of ordinary income either way; B also
    // realizes the sale's gains and consumes ACA MAGI
    // headroom, so its federal tax and ACA MAGI exceed A's.
    // (The multi-year B arm above converts by Fill 12%, not a
    // fixed $100K — its year-1 conversion is smaller, so the
    // exact-$100K comparison lives here, on the single-year
    // pricer, exactly as the baseline's §7 illustration did.)
    // Eligibility is unentered on the sample household, so the
    // pre-59½ pre-tax draw's $0 penalty is UNKNOWN here — the
    // assertions pin federal tax and MAGI only.
    const hundredKBase = {
      taxYear: 2026,
      filingStatus: "mfj" as const,
      agePrimary: 58,
      ageSpouse: 56,
      onMedicarePrimary: false,
      onMedicareSpouse: false,
      interest: 1500,
      ordinaryDividends: 20000,
      qualifiedDividends: 15000,
      otherOrdinary: 0,
      taxExemptInterest: 0,
      ssPrimary: 0,
      ssSpouse: 0,
      stockSold: 0,
      stockBasis: 0,
      pretaxBalance: 1500000,
      spouseSoleBeneficiary: true,
      acaHouseholdSize: 4,
      acaBenchmarkAnnual: 36000,
      stateRatePct: 0,
      residenceState: "WA" as const,
      inflationPct: 2.5,
    };
    const aYear1 = pricePlaygroundYear({ ...hundredKBase, conversion: 0, spendingDraw: 100000 });
    const bYear1 = pricePlaygroundYear({
      ...hundredKBase,
      conversion: 100000,
      spendingDraw: 0,
      stockSold: 100000,
      stockBasis: 50000,
    });
    expect(bYear1.federalTax).toBeGreaterThan(aYear1.federalTax);
    expect(bYear1.acaMagi).toBeGreaterThan(aYear1.acaMagi);
    expect(bYear1.conversion).toBe(100000);
    expect(aYear1.conversion).toBe(0);
  }, 300_000);
});

describe("C10 — bias audit: terminal sensitivity + ACA test", () => {
  test("terminal re-scoring is exact and the ranking can move with the heir rate", () => {
    const inputs = shortInputs();
    const { scored } = priceFixedDynamicPolicies(inputs, dynamicPolicySet(74, 70));
    expect(scored.length).toBeGreaterThan(0);
    for (const rate of [0, 22, 37]) {
      const ranked = rescoreDynamicTerminal(scored, { heirRatePct: rate });
      expect(ranked.length).toBe(scored.length);
      for (let i = 1; i < ranked.length; i++) {
        expect(ranked[i]!.netCost).toBeGreaterThanOrEqual(ranked[i - 1]!.netCost - 0.005);
      }
      // Each re-scored figure is ex-terminal cost + the
      // terminal rule at that rate, to the cent.
      const first = ranked[0]!;
      const source = scored.find((s) => s.policy.key === first.policyKey)!;
      const term = dynamicTerminalTax({ endingPretax: source.endingPretax, heirRatePct: rate });
      expect(first.netCost).toBeCloseTo(source.netCostExTerminal + term.terminal, 2);
    }
    // The 0% winner is the ex-terminal-cost winner by
    // construction; the 37% winner is named here so the
    // ranking movement is visible in the output, not asserted
    // (a move is expected on most plans, but the test pins the
    // re-scoring math, not the move).
    const w0 = rescoreDynamicTerminal(scored, { heirRatePct: 0 })[0]!.policyKey;
    const w37 = rescoreDynamicTerminal(scored, { heirRatePct: 37 })[0]!.policyKey;
    expect(typeof w0).toBe("string");
    expect(typeof w37).toBe("string");
    // A preserve floor moves at least one policy's price when
    // any policy ends with pre-tax standing.
    const anyPretax = scored.some((s) => s.endingPretax > 0);
    if (anyPretax) {
      const noFloor = rescoreDynamicTerminal(scored, { heirRatePct: 22 });
      const floor = rescoreDynamicTerminal(scored, { heirRatePct: 22, preservePretax: 250000, preserveExitRatePct: 10 });
      const moved = noFloor.some(
        (r) => Math.abs(r.netCost - (floor.find((f) => f.policyKey === r.policyKey)?.netCost ?? r.netCost)) > 0.005,
      );
      expect(moved).toBe(true);
    }
  }, 300_000);

  test("ACA test: pricing the benchmark moves credit kept (fixed-set level)", () => {
    const inputs = shortInputs();
    const rows = runDynamicAcaSensitivity(
      inputs,
      [
        { label: "no benchmark", acaBenchmarkCouple: null, acaBenchmarkSingle: null, acaBenchmarkFamily: null },
        { label: "sample benchmarks", acaBenchmarkCouple: 25000, acaBenchmarkSingle: 17500, acaBenchmarkFamily: 36000 },
      ],
      { runDynamic: false },
    );
    expect(rows.length).toBe(2);
    expect(rows[0]!.bestFixedAcaCreditKept).toBe(0);
    expect(rows[0]!.doNothingAcaCreditKept).toBe(0);
    expect(rows[1]!.bestFixedAcaCreditKept).toBeGreaterThan(0);
    expect(rows[1]!.doNothingAcaCreditKept).toBeGreaterThan(0);
  }, 300_000);
});
