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
  dynamicResultFromRows,
  dynamicRowsFromFixedMarch,
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

  test("policy set: stops deduped when windows collide (78 unique, no duplicates)", () => {
    // stops = [65, rmdStopAge, endAge] with no dedupe emitted 36
    // duplicate policies when two stops coincided (114 rows, 78
    // unique keys) — compute-only, the duplicate marches tied
    // exactly, but 36 extra marches were priced per greedy year
    // and policiesEvaluatedPerYear overstated the set. The stops
    // are now deduped: 6 + 6 fills x 2 windows x 6 orders = 78.
    for (const [rmdStop, end] of [
      [74, 74],
      [65, 95],
      [74, 65],
    ] as const) {
      const policies = dynamicPolicySet(rmdStop, end);
      expect(policies.length).toBe(78);
      expect(new Set(policies.map((p) => p.key)).size).toBe(78);
      expect(policies.filter((p) => p.ceilings == null).length).toBe(6);
    }
    // Non-colliding control: still 114.
    const control = dynamicPolicySet(74, 70);
    expect(control.length).toBe(114);
    expect(new Set(control.map((p) => p.key)).size).toBe(114);
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

describe("C10 — Pass 1 fix (M1): IRMAA lookback carried across re-anchors", () => {
  // The survivor variant is the natural nonzero-IRMAA fixture:
  // the primary dies in 2036, the survivor's single-filer years
  // on Medicare price a real surcharge on an uninterrupted
  // march ($14,424.00 lifetime on the Fill-12% march) — before
  // the fix the roll-forward reported $0 for the same years.
  const survivorInputs = () =>
    shortInputs({
      endAgePrimary: 75,
      survivorEnabled: true,
      survivorWho: "primary",
      survivorDeathYear: 2036,
    });
  const fill12TaxableFirst = {
    key: "fill12|stop95|taxable-pretax-roth",
    name: "Fill 12% · stop 95",
    ceilings: { ...NO_CEILINGS, bracketTopPct: 12 },
    guardrail: false,
    windowStopAge: 95,
    drawOrder: ["taxable", "pretax", "roth"] as DrawOrder,
  };

  test("roll-forward prices true IRMAA: single-policy survivor run matches its march", () => {
    const inputs = survivorInputs();
    const march = simulateRothPlan(
      { ...inputs, windowStopAge: 95, drawOrder: [...fill12TaxableFirst.drawOrder] },
      { id: "m1", name: "Fill 12% · stop 95", ceilings: fill12TaxableFirst.ceilings, guardrail: false },
      undefined,
      { leanDetail: true },
    );
    const marchIrmaa = march.years.reduce((s, y) => s + y.irmaaPaid, 0);
    expect(marchIrmaa).toBeGreaterThan(0);
    expect(march.irmaaLookbackMissingYears).toEqual([]);
    const rolled = runDynamicOptimizer(inputs, { policies: [fill12TaxableFirst] });
    expect(rolled.ok).toBe(true);
    expect(rolled.years.length).toBe(march.years.length);
    // The roll-forward's lifetime IRMAA is the march's, not $0.
    expect(rolled.lifetimeIrmaa).toBeGreaterThan(0);
    expect(Math.abs(rolled.lifetimeIrmaa - marchIrmaa)).toBeLessThanOrEqual(0.02);
    // Per-year IRMAA agrees with the march's priced years.
    for (let i = 0; i < march.years.length; i++) {
      expect(Math.abs(rolled.years[i]!.irmaa - march.years[i]!.irmaaPaid)).toBeLessThanOrEqual(0.02);
    }
    // No unknown year anywhere on the trajectory.
    expect(rolled.irmaaLookbackMissingYears).toEqual([]);
    expect(rolled.years.every((r) => r.irmaaSurchargeKnown)).toBe(true);
  });

  test("full-set dynamic run reports nonzero IRMAA with no unknown years", () => {
    const inputs = survivorInputs();
    const result = runDynamicOptimizer(inputs);
    expect(result.ok).toBe(true);
    expect(result.lifetimeIrmaa).toBeGreaterThan(0);
    expect(result.irmaaLookbackMissingYears).toEqual([]);
    expect(result.years.every((r) => r.irmaaSurchargeKnown)).toBe(true);
    // The floor comparison is IRMAA-complete on both sides:
    // the reported (greedy) cost and the best-fixed cost are
    // both priced with true IRMAA, so a floor binding here
    // would mean greedy genuinely lost, not that it omitted a
    // term the fixed policy priced.
    expect(result.greedyNetCost).toBeCloseTo(result.lifetimeNetCost, 2);
  }, 300_000);

  test("unknown IRMAA is surfaced, not silent: plan starting at 65 with no seed", () => {
    // Primary 65 at the plan start, no supplied prior returns:
    // the first two premium years have no lookback entry, so
    // their $0 surcharge is UNKNOWN — and the result names
    // exactly those years.
    const inputs = shortInputs({ birthYearPrimary: 1961 });
    const march = simulateRothPlan(
      { ...inputs, windowStopAge: 95, drawOrder: [...fill12TaxableFirst.drawOrder] },
      { id: "m1-unknown", name: "Fill 12% · stop 95", ceilings: fill12TaxableFirst.ceilings, guardrail: false },
      undefined,
      { leanDetail: true },
    );
    expect(march.irmaaLookbackMissingYears).toEqual([2026, 2027]);
    const rolled = runDynamicOptimizer(inputs, { policies: [fill12TaxableFirst] });
    expect(rolled.ok).toBe(true);
    expect(rolled.irmaaLookbackMissingYears).toEqual([2026, 2027]);
    expect(rolled.years.find((r) => r.year === 2026)?.irmaaSurchargeKnown).toBe(false);
    expect(rolled.years.find((r) => r.year === 2027)?.irmaaSurchargeKnown).toBe(false);
    expect(rolled.years.filter((r) => r.year > 2027).every((r) => r.irmaaSurchargeKnown)).toBe(true);
    // `valid` is the settlement / shortfall / unpaid-tax check
    // (the engine's own integrity convention — unknown IRMAA
    // never invalidated a march there either); the missing
    // list above is the signal a caller must check.
    expect(rolled.valid).toBe(true);
  });

  test("supplied prior returns seed the re-anchored marches", () => {
    // The same 65-at-start plan, but the two pre-plan returns
    // are supplied: every premium year is then KNOWN, because
    // the first two read the supplied seed and the rest read
    // the committed years carried forward.
    const inputs = shortInputs({
      birthYearPrimary: 1961,
      irmaaLookbackSeed: [
        { year: 2024, magi: 200000, filingStatus: "mfj" },
        { year: 2025, magi: 200000, filingStatus: "mfj" },
      ],
    });
    const rolled = runDynamicOptimizer(inputs, { policies: [fill12TaxableFirst] });
    expect(rolled.ok).toBe(true);
    expect(rolled.irmaaLookbackMissingYears).toEqual([]);
    expect(rolled.years.every((r) => r.irmaaSurchargeKnown)).toBe(true);
  });
});

describe("C10 — Pass 1 fix (S1): the fixed-policy floor return path", () => {
  test("floor rows built from a fixed march reproduce it, with the greedy trajectory preserved", () => {
    const inputs = shortInputs();
    const policies = dynamicPolicySet(74, 70);
    const { best, scored } = priceFixedDynamicPolicies(inputs, policies);
    expect(best).not.toBeNull();
    const bestFixed = best!;
    const basisStart = (inputs.taxableBasisPct / 100) * inputs.taxableStart;
    // The floor's rows: the best fixed policy's uninterrupted
    // march, re-expressed as schedule rows.
    const floorRows = dynamicRowsFromFixedMarch(bestFixed.result, bestFixed.policy, inputs, basisStart);
    expect(floorRows.length).toBe(bestFixed.result.years.length);
    // The greedy trajectory the floor replaces: the Do Nothing
    // march's rows (a different, worse trajectory on the same
    // inputs), with its own worse net cost beside them.
    const doNothing = scored.find((s) => s.policy.ceilings == null)!;
    const greedyRows = dynamicRowsFromFixedMarch(doNothing.result, doNothing.policy, inputs, basisStart);
    expect(doNothing.netCost).toBeGreaterThan(bestFixed.netCost + 0.1);
    const result = dynamicResultFromRows({
      rows: floorRows,
      base: inputs,
      bestFixed: {
        policyKey: bestFixed.policy.key,
        policyName: bestFixed.policy.name,
        netCost: bestFixed.netCost,
        endingWealth: bestFixed.endingWealth,
      },
      floorBound: true,
      greedyNetCost: doNothing.netCost,
      greedyEndingWealth: doNothing.endingWealth,
      greedyYears: greedyRows,
      policiesEvaluatedPerYear: policies.length,
    });
    // The floor branch executed: the returned trajectory IS the
    // fixed march, and the greedy trajectory is preserved beside it.
    expect(result.floorBound).toBe(true);
    expect(result.years.length).toBe(bestFixed.result.years.length);
    expect(result.greedyYears).toBe(greedyRows);
    expect(result.greedyNetCost).toBe(doNothing.netCost);
    expect(result.bestFixed?.policyKey).toBe(bestFixed.policy.key);
    expect(result.valid).toBe(true);
    // Every floor row reproduces its march year exactly (the
    // rows are copies of the priced years, not re-derivations).
    for (let i = 0; i < bestFixed.result.years.length; i++) {
      const m = bestFixed.result.years[i]!;
      const r = result.years[i]!;
      expect(r.year).toBe(m.year);
      expect(r.federalTax).toBe(m.federalTax);
      expect(r.conversion).toBe(m.funding.conversion);
      expect(r.magi).toBe(m.magi);
      expect(r.irmaa).toBe(m.irmaaPaid);
      expect(r.irmaaSurchargeKnown).toBe(m.irmaaSurchargeKnown);
      expect(r.acaCreditKept).toBe(m.acaCreditKept);
      expect(r.pretaxEnd).toBe(m.pretaxEnd);
      expect(r.rothEnd).toBe(m.rothEnd);
      expect(r.taxableEnd).toBe(m.taxableEnd);
    }
    // The floored lifetime net cost is the fixed policy's own
    // net cost (recomputed from the rows + the terminal term),
    // and the IRMAA-known state rides along: no unknown years
    // on this plan.
    expect(Math.abs(result.lifetimeNetCost - bestFixed.netCost)).toBeLessThanOrEqual(0.1);
    expect(result.irmaaLookbackMissingYears).toEqual([]);
    expect(result.years.every((r) => r.irmaaSurchargeKnown)).toBe(true);
  }, 300_000);
});

describe("C10 — Pass 3 fix (M1): per-person first-RMD deferral flags", () => {
  // The roll-forward carried ONE flag for BOTH spouses' first-RMD
  // deferral elections: once the first spouse's first RMD year
  // priced, the second spouse's later election was silently
  // turned off in every subsequent re-anchor, and the rolled
  // trajectory paid that RMD a year early while the
  // uninterrupted march still deferred it. The flags are now
  // per person, set from per-person signals (that person's RMD
  // paid or deferred, or that person reaching RMD age). Each
  // case below rolls a single fixed policy forward against its
  // own march on the fictional sample household at end age 95
  // (primary born 1968 -> first RMD year 2043; spouse born
  // 1970 -> first RMD year 2045), the spouse given a $500,000
  // pre-tax balance so the spouse HAS an RMD.
  const order: DrawOrder = ["taxable", "pretax", "roth"];
  const fill12TaxableFirst = {
    key: "fill12|stop95|taxable-pretax-roth",
    name: "Fill 12% · stop 95",
    ceilings: { ...NO_CEILINGS, bracketTopPct: 12 },
    guardrail: false,
    windowStopAge: 95,
    drawOrder: order,
  };
  const deferralInputs = (overrides: Partial<RothPlanInputs> = {}) =>
    samplePlanInputs({ endAgePrimary: 95, pretaxSpouseStart: 500000, ...overrides });

  // The parity bar from the shared-engine proof above (2¢ per
  // field per year, net cost within $0.25), plus the per-person
  // RMD fields the deferral moves. One bar differs by
  // necessity: the three ENDING BALANCES compound the
  // re-anchor rounding — each re-anchor restarts from
  // cent-rounded balances while the march carries
  // fractional-cent floats, and the 5% return compounds that
  // cent over a 38-year horizon (observed maxima on these
  // cases: pretaxEnd $0.07, rothEnd $0.03, taxableEnd $0.17,
  // a smooth drift with no jump at any deferral year). The
  // balance bar is therefore $0.50, and the net-cost bar
  // $0.25 (observed $0.08) — both still orders of magnitude
  // below any real trajectory divergence (the pre-fix defect
  // moved net cost $1,052+). Flows stay at 2¢.
  function assertRollForwardParity(inputs: RothPlanInputs) {
    const march = simulateRothPlan(
      { ...inputs, windowStopAge: 95, drawOrder: [...order] },
      { id: "m1p3", name: "Fill 12% · stop 95", ceilings: fill12TaxableFirst.ceilings, guardrail: false },
      undefined,
      { leanDetail: true },
    );
    const rolled = runDynamicOptimizer(inputs, { policies: [fill12TaxableFirst] });
    expect(rolled.ok).toBe(true);
    expect(rolled.floorBound).toBe(false);
    expect(rolled.years.length).toBe(march.years.length);
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
      expect(within2c(r.rmdPrimary, m.detail.rmdPrimary)).toBe(true);
      expect(within2c(r.rmdSpouse, m.detail.rmdSpouse)).toBe(true);
      expect(within2c(r.magi, m.magi)).toBe(true);
      expect(within2c(r.acaCreditKept, m.acaCreditKept)).toBe(true);
      // Ending balances: the $0.50 rounding-compounding bar
      // (see the helper note above), not 2¢.
      const within50c = (a: number, b: number) => Math.abs(a - b) <= 0.5;
      expect(within50c(r.pretaxEnd, m.pretaxEnd)).toBe(true);
      expect(within50c(r.rothEnd, m.rothEnd)).toBe(true);
      expect(within50c(r.taxableEnd, m.taxableEnd)).toBe(true);
    }
    expect(
      Math.abs(
        rolled.lifetimeNetCost -
          netCostBreakdown(march, inputs.heirRatePct, {
            preservePretax: inputs.preservePretax ?? 0,
            preserveExitRatePct: inputs.preserveExitRatePct ?? inputs.heirRatePct,
          }).netCost,
      ),
    ).toBeLessThanOrEqual(0.25);
    return { march, rolled };
  }

  test("spouse-younger deferral: the later spouse's election survives the primary's priced RMD", () => {
    const inputs = deferralInputs({ firstRmdDeferralSpouse: true });
    const { march, rolled } = assertRollForwardParity(inputs);
    // The march defers the spouse's 2045 RMD ($0, then the
    // double in 2046); the pre-fix roll-forward paid $51,360.78
    // in 2045 instead. The rolled trajectory must defer too.
    const m2045 = march.years.find((y) => y.year === 2045)!;
    const r2045 = rolled.years.find((y) => y.year === 2045)!;
    const m2046 = march.years.find((y) => y.year === 2046)!;
    const r2046 = rolled.years.find((y) => y.year === 2046)!;
    expect(m2045.detail.rmdSpouse).toBe(0);
    expect(r2045.rmdSpouse).toBe(0);
    expect(m2046.detail.rmdSpouse).toBeGreaterThan(100000);
    expect(Math.abs(r2046.rmdSpouse - m2046.detail.rmdSpouse)).toBeLessThanOrEqual(0.02);
  });

  test("both deferrals: each person's election applies in its own first RMD year", () => {
    const inputs = deferralInputs({ firstRmdDeferralPrimary: true, firstRmdDeferralSpouse: true });
    const { march, rolled } = assertRollForwardParity(inputs);
    const m2043 = march.years.find((y) => y.year === 2043)!;
    const r2043 = rolled.years.find((y) => y.year === 2043)!;
    const m2045 = march.years.find((y) => y.year === 2045)!;
    const r2045 = rolled.years.find((y) => y.year === 2045)!;
    expect(m2043.detail.rmdPrimary).toBe(0);
    expect(r2043.rmdPrimary).toBe(0);
    expect(m2045.detail.rmdSpouse).toBe(0);
    expect(r2045.rmdSpouse).toBe(0);
  });

  test("mirror (spouse older): the primary's later deferral survives the spouse's priced RMD", () => {
    // Spouse born 1966 -> first RMD year 2041, priced before
    // the primary's 2043 first RMD year; the pre-fix flag
    // dropped the primary's deferral and paid $137,611.78 in
    // 2043 instead of deferring it.
    const inputs = deferralInputs({ birthYearSpouse: 1966, firstRmdDeferralPrimary: true });
    const { march, rolled } = assertRollForwardParity(inputs);
    const m2043 = march.years.find((y) => y.year === 2043)!;
    const r2043 = rolled.years.find((y) => y.year === 2043)!;
    const m2044 = march.years.find((y) => y.year === 2044)!;
    const r2044 = rolled.years.find((y) => y.year === 2044)!;
    expect(m2043.detail.rmdPrimary).toBe(0);
    expect(r2043.rmdPrimary).toBe(0);
    expect(m2044.detail.rmdPrimary).toBeGreaterThan(200000);
    expect(Math.abs(r2044.rmdPrimary - m2044.detail.rmdPrimary)).toBeLessThanOrEqual(0.02);
  });

  test("control (primary deferral, same-person path): parity to the cent", () => {
    // The path that already worked pre-fix — pinned so the
    // per-person split cannot regress it.
    const inputs = deferralInputs({ firstRmdDeferralPrimary: true });
    const { march, rolled } = assertRollForwardParity(inputs);
    const m2043 = march.years.find((y) => y.year === 2043)!;
    const r2043 = rolled.years.find((y) => y.year === 2043)!;
    expect(m2043.detail.rmdPrimary).toBe(0);
    expect(r2043.rmdPrimary).toBe(0);
  });

  test("survivor variant: the survivor's deferral survives the deceased's priced RMD", () => {
    // The primary dies in 2044, after his 2043 RMD priced; the
    // spouse's first RMD year is 2045, now a combined survivor
    // year on her clock. The march defers the combined 2045
    // RMD ($0, then the double in 2046); the pre-fix
    // roll-forward paid $190,413.95 in 2045 instead.
    const inputs = deferralInputs({
      firstRmdDeferralSpouse: true,
      survivorEnabled: true,
      survivorWho: "primary",
      survivorDeathYear: 2044,
    });
    const { march, rolled } = assertRollForwardParity(inputs);
    const m2045 = march.years.find((y) => y.year === 2045)!;
    const r2045 = rolled.years.find((y) => y.year === 2045)!;
    const m2046 = march.years.find((y) => y.year === 2046)!;
    const r2046 = rolled.years.find((y) => y.year === 2046)!;
    expect(m2045.detail.rmdSpouse).toBe(0);
    expect(r2045.rmdSpouse).toBe(0);
    expect(m2046.detail.rmdSpouse).toBeGreaterThan(300000);
    expect(Math.abs(r2046.rmdSpouse - m2046.detail.rmdSpouse)).toBeLessThanOrEqual(0.02);
  });
});

describe("C10 — Pass 4 (N1): five extra deferral corners as regression tests", () => {
  // The five shapes the Pass 4 probe found holding parity that
  // no test covered: pending deferral at death (F), death in
  // the deferral year (G), single filer (H — the only shape
  // exercising the rmdAgeSpouse-null branch), death before the
  // first RMD year (I), and both deferrals + survivor (J).
  // Same harness as the Pass 3 describe above (single fixed
  // policy rolled forward against its own march on the
  // fictional sample household at end age 95, spouse given a
  // $500,000 pre-tax balance so the spouse HAS an RMD), same
  // bars (2c per flow field, $0.50 ending balances, $0.25 net
  // cost) — with one necessary difference in HOW the 2c bar is
  // compared. The bar is 2 CENTS per field, and the fields are
  // cent-rounded dollars; the comparison is therefore in
  // integer cents. Shape I's 2046 RMD sits exactly on the bar
  // ($423,599.12 vs $423,599.14) and the raw float difference
  // is 0.0200000000186... — a hair ABOVE 0.02 — so a raw-float
  // `<= 0.02` check would fail a true 2c difference on float
  // noise alone. The cent-domain comparison pins the bar as
  // designed; it does not loosen it (2 integer cents, no more).
  const order: DrawOrder = ["taxable", "pretax", "roth"];
  const fill12TaxableFirst = {
    key: "fill12|stop95|taxable-pretax-roth",
    name: "Fill 12% · stop 95",
    ceilings: { ...NO_CEILINGS, bracketTopPct: 12 },
    guardrail: false,
    windowStopAge: 95,
    drawOrder: order,
  };
  const deferralInputs = (overrides: Partial<RothPlanInputs> = {}) =>
    samplePlanInputs({ endAgePrimary: 95, pretaxSpouseStart: 500000, ...overrides });

  function assertRollForwardParity(inputs: RothPlanInputs) {
    const march = simulateRothPlan(
      { ...inputs, windowStopAge: 95, drawOrder: [...order] },
      { id: "m1p4", name: "Fill 12% · stop 95", ceilings: fill12TaxableFirst.ceilings, guardrail: false },
      undefined,
      { leanDetail: true },
    );
    const rolled = runDynamicOptimizer(inputs, { policies: [fill12TaxableFirst] });
    expect(rolled.ok).toBe(true);
    expect(rolled.floorBound).toBe(false);
    expect(rolled.years.length).toBe(march.years.length);
    // 2c per flow field, in integer cents (see the note above).
    const within2c = (a: number, b: number) => Math.abs(Math.round(a * 100) - Math.round(b * 100)) <= 2;
    // $0.50 ending balances, in integer cents likewise.
    const within50c = (a: number, b: number) => Math.abs(Math.round(a * 100) - Math.round(b * 100)) <= 50;
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
      expect(within2c(r.rmdPrimary, m.detail.rmdPrimary)).toBe(true);
      expect(within2c(r.rmdSpouse, m.detail.rmdSpouse)).toBe(true);
      expect(within2c(r.magi, m.magi)).toBe(true);
      expect(within2c(r.acaCreditKept, m.acaCreditKept)).toBe(true);
      expect(within50c(r.pretaxEnd, m.pretaxEnd)).toBe(true);
      expect(within50c(r.rothEnd, m.rothEnd)).toBe(true);
      expect(within50c(r.taxableEnd, m.taxableEnd)).toBe(true);
    }
    expect(
      Math.abs(
        rolled.lifetimeNetCost -
          netCostBreakdown(march, inputs.heirRatePct, {
            preservePretax: inputs.preservePretax ?? 0,
            preserveExitRatePct: inputs.preserveExitRatePct ?? inputs.heirRatePct,
          }).netCost,
      ),
    ).toBeLessThanOrEqual(0.25);
    return { march, rolled };
  }

  test("F: pending deferral at death — the deceased's pending RMD is honored in the combined year", () => {
    // The primary defers his 2043 first RMD and dies in 2044:
    // the combined 2044 year must pay the pending deferral
    // ($286,858.60 on the march), not a fresh single-year RMD.
    const inputs = deferralInputs({
      firstRmdDeferralPrimary: true,
      survivorEnabled: true,
      survivorWho: "primary",
      survivorDeathYear: 2044,
    });
    const { march, rolled } = assertRollForwardParity(inputs);
    const m2043 = march.years.find((y) => y.year === 2043)!;
    const r2043 = rolled.years.find((y) => y.year === 2043)!;
    const m2044 = march.years.find((y) => y.year === 2044)!;
    const r2044 = rolled.years.find((y) => y.year === 2044)!;
    expect(m2043.detail.rmdPrimary).toBe(0);
    expect(r2043.rmdPrimary).toBe(0);
    expect(m2044.detail.rmdPrimary).toBeGreaterThan(200000);
    expect(Math.abs(Math.round(r2044.rmdPrimary * 100) - Math.round(m2044.detail.rmdPrimary * 100))).toBeLessThanOrEqual(2);
  });

  test("G: death in the deferral year — the spouse's deferred RMD still defers", () => {
    // The spouse defers her 2045 first RMD and the primary dies
    // in that same year: the 2045 RMD is $0 on both trajectories
    // and the double lands in 2046.
    const inputs = deferralInputs({
      firstRmdDeferralSpouse: true,
      survivorEnabled: true,
      survivorWho: "primary",
      survivorDeathYear: 2045,
    });
    const { march, rolled } = assertRollForwardParity(inputs);
    const m2045 = march.years.find((y) => y.year === 2045)!;
    const r2045 = rolled.years.find((y) => y.year === 2045)!;
    const m2046 = march.years.find((y) => y.year === 2046)!;
    const r2046 = rolled.years.find((y) => y.year === 2046)!;
    expect(m2045.detail.rmdSpouse).toBe(0);
    expect(r2045.rmdSpouse).toBe(0);
    expect(m2046.detail.rmdSpouse).toBeGreaterThan(100000);
    expect(Math.abs(Math.round(r2046.rmdSpouse * 100) - Math.round(m2046.detail.rmdSpouse * 100))).toBeLessThanOrEqual(2);
  });

  test("H: single filer — the rmdAgeSpouse-null path still defers the primary's first RMD", () => {
    // No spouse at all (birthYearSpouse null, single filer, no
    // spouse pre-tax balance): the only shape exercising the
    // rmdAgeSpouse-null branch of the per-person flag fix.
    const inputs = deferralInputs({
      birthYearSpouse: null,
      filingStatus: "single",
      pretaxSpouseStart: 0,
      firstRmdDeferralPrimary: true,
    });
    const { march, rolled } = assertRollForwardParity(inputs);
    const m2043 = march.years.find((y) => y.year === 2043)!;
    const r2043 = rolled.years.find((y) => y.year === 2043)!;
    const m2044 = march.years.find((y) => y.year === 2044)!;
    const r2044 = rolled.years.find((y) => y.year === 2044)!;
    expect(m2043.detail.rmdPrimary).toBe(0);
    expect(r2043.rmdPrimary).toBe(0);
    expect(m2044.detail.rmdPrimary).toBeGreaterThan(200000);
    expect(Math.abs(Math.round(r2044.rmdPrimary * 100) - Math.round(m2044.detail.rmdPrimary * 100))).toBeLessThanOrEqual(2);
  });

  test("I: death before the first RMD year — the survivor's deferral survives the deceased's unflipped flag", () => {
    // The primary dies in 2042, before his 2043 first RMD year,
    // so the deceased's flag never flips; the spouse's 2045
    // deferral as survivor must still apply. The 2046 RMD sits
    // exactly on the 2c bar ($423,599.12 vs $423,599.14) — the
    // bar working as designed, not a defect; pinned at the bar
    // in integer cents (see the helper note above).
    const inputs = deferralInputs({
      firstRmdDeferralSpouse: true,
      survivorEnabled: true,
      survivorWho: "primary",
      survivorDeathYear: 2042,
    });
    const { march, rolled } = assertRollForwardParity(inputs);
    const m2045 = march.years.find((y) => y.year === 2045)!;
    const r2045 = rolled.years.find((y) => y.year === 2045)!;
    const m2046 = march.years.find((y) => y.year === 2046)!;
    const r2046 = rolled.years.find((y) => y.year === 2046)!;
    expect(m2045.detail.rmdSpouse).toBe(0);
    expect(r2045.rmdSpouse).toBe(0);
    expect(m2046.detail.rmdSpouse).toBeGreaterThan(400000);
    expect(Math.abs(Math.round(r2046.rmdSpouse * 100) - Math.round(m2046.detail.rmdSpouse * 100))).toBeLessThanOrEqual(2);
  });

  test("J: both deferrals + survivor — each person's election applies before the death year", () => {
    // Both deferrals elected and the primary dies in 2044: the
    // primary's 2043 deferral and the spouse's 2045 deferral
    // must both hold on the rolled trajectory.
    const inputs = deferralInputs({
      firstRmdDeferralPrimary: true,
      firstRmdDeferralSpouse: true,
      survivorEnabled: true,
      survivorWho: "primary",
      survivorDeathYear: 2044,
    });
    const { march, rolled } = assertRollForwardParity(inputs);
    const m2043 = march.years.find((y) => y.year === 2043)!;
    const r2043 = rolled.years.find((y) => y.year === 2043)!;
    const m2045 = march.years.find((y) => y.year === 2045)!;
    const r2045 = rolled.years.find((y) => y.year === 2045)!;
    expect(m2043.detail.rmdPrimary).toBe(0);
    expect(r2043.rmdPrimary).toBe(0);
    expect(m2045.detail.rmdSpouse).toBe(0);
    expect(r2045.rmdSpouse).toBe(0);
  });
});

describe("C10 — A-vs-B equal-income-budget experiment", () => {
  test("C (dynamic) is never worse than A or B on this plan; B realizes gains in year 1 at $100K", () => {
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
