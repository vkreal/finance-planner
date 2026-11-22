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
  type DynamicPolicy,
} from "./rothOptimizer";
import { NO_CEILINGS, simulateRothPlan, type DrawOrder, type FillCeilings, type RothPlanInputs } from "./taxEngine";
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
    // 2c per flow field, in integer cents — the Pass 4 note applies
    // here too: the fields are cent-rounded dollars, and a raw-float
    // `<= 0.02` fails a true 2c difference on float noise alone.
    const within2c = (a: number, b: number) => Math.abs(Math.round(a * 100) - Math.round(b * 100)) <= 2;
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

describe("C10 — core review (M-1/S-11/S-12/S-13): re-anchor state parity", () => {
  const ORDER: DrawOrder = ["taxable", "pretax", "roth"];
  const POLICY = {
    key: "fill12|stop67|taxable-pretax-roth",
    name: "Fill 12% · stop 67",
    ceilings: { ...NO_CEILINGS, bracketTopPct: 12 },
    guardrail: false,
    windowStopAge: 67,
    drawOrder: ORDER,
  };
  // 2c per flow field, in integer cents — the fields are
  // cent-rounded dollars, and a raw-float `<= 0.02` fails a
  // true 2c difference on float noise alone (same note as the
  // plain-shape parity test above).
  const within2c = (a: number, b: number) =>
    Math.abs(Math.round(a * 100) - Math.round(b * 100)) <= 2;

  // One shape: a single fill-12% policy rolled forward must
  // reproduce its own uninterrupted march on the GREEDY rows
  // (not only the floor-rescued `years`) — the M-1 class of
  // divergence hid exactly there, with the floor binding and
  // publishing fixed-march rows while greedyYears mispriced.
  // The policy/order default to the taxable-first fill-12%
  // shape; the Roth-first exhaustion and survivor shapes
  // pass their own.
  function checkShapeWith(
    overrides: Partial<RothPlanInputs>,
    policy: DynamicPolicy = POLICY,
    order: DrawOrder = ORDER,
  ) {
    const inputs = samplePlanInputs({
      endAgePrimary: 67,
      windowStopAge: 67,
      retirementAge: 62,
      ...overrides,
    });
    const march = simulateRothPlan(
      { ...inputs, windowStopAge: 67, drawOrder: [...order] },
      { id: "parity", name: "Fill 12%", ceilings: policy.ceilings, guardrail: false },
      undefined,
      { leanDetail: true },
    );
    const rolled = runDynamicOptimizer(inputs, { policies: [policy] });
    expect(rolled.ok).toBe(true);
    expect(rolled.floorBound).toBe(false);
    expect(rolled.greedyYears.length).toBe(march.years.length);
    for (let i = 0; i < march.years.length; i++) {
      const m = march.years[i]!;
      const r = rolled.greedyYears[i]!;
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
      // The gain path, pinned directly: drawGains is the
      // realized-gain figure the basis walk reads, so a
      // tier-order or sleeve gain error shows here even when
      // the balances agree — and the basis ledger itself.
      expect(within2c(r.drawGains, m.detail.drawGains)).toBe(true);
      expect(within2c(r.taxableBasisEnd, m.detail.taxableBasisDollars)).toBe(true);
    }
    // Ending balances within $0.50, lifetime net cost within
    // $0.25 — the re-anchor rounding bars for the trajectory.
    const lastR = rolled.greedyYears[rolled.greedyYears.length - 1]!;
    const lastM = march.years[march.years.length - 1]!;
    expect(Math.abs(lastR.pretaxEnd - lastM.pretaxEnd)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(lastR.rothEnd - lastM.rothEnd)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(lastR.taxableEnd - lastM.taxableEnd)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(lastR.hsaEnd - lastM.hsaEnd)).toBeLessThanOrEqual(0.5);
    expect(
      Math.abs(
        rolled.lifetimeNetCost -
          netCostBreakdown(march, inputs.heirRatePct, {
            preservePretax: inputs.preservePretax ?? 0,
            preserveExitRatePct: inputs.preserveExitRatePct ?? inputs.heirRatePct,
          }).netCost,
      ),
    ).toBeLessThanOrEqual(0.25);
    return { inputs, march, rolled };
  }

  function checkShape(overrides: Partial<RothPlanInputs>) {
    return checkShapeWith(overrides);
  }

  const ROTH_FIRST_ORDER: DrawOrder = ["roth", "taxable", "pretax"];
  const ROTH_FIRST_POLICY: DynamicPolicy = {
    key: "fill12|stop67|roth-taxable-pretax",
    name: "Fill 12% · stop 67",
    ceilings: { ...NO_CEILINGS, bracketTopPct: 12 },
    guardrail: false,
    windowStopAge: 67,
    drawOrder: ROTH_FIRST_ORDER,
  };
  // Do-nothing, pretax-first (ceilings null: no conversions) —
  // the Rule-of-55 eligible-fold shape's policy (fix round 2):
  // no conversion lot exists to confuse the eligible ledger.
  const DO_NOTHING_PF_POLICY: DynamicPolicy = {
    key: "donothing|pretax-taxable-roth",
    name: "Do nothing",
    ceilings: null,
    guardrail: false,
    windowStopAge: 67,
    drawOrder: ["pretax", "taxable", "roth"],
  };
  // Shared survivor base for the fix-round-2 asymmetric-lots
  // shapes (reviewer A2): Roth-first, entered basis per
  // owner, 5-year clock unmet in the survivor years. Short
  // horizon (end 67): every mechanism window here is
  // 2030–2032, and the r2 dust the roll-forward accumulates
  // stays within the 2c bar through 2035 (it reaches 3–5c
  // only past 2040 on the end-75 horizon — the same dust
  // class the reviewers' own probes show on passing shapes).
  const SURV_ASYM_BASE = {
    endAgePrimary: 67,
    survivorEnabled: true,
    survivorDeathYear: 2030,
    rothContributionBasisPrimary: 200000,
    rothContributionBasisSpouse: 100000,
    firstRothYearPrimary: 2028,
    firstRothYearSpouse: 2028,
  };

  test("plain control reproduces its march on greedy rows", () => {
    checkShape({});
  });

  test("tiered basis reproduces its march on greedy rows", () => {
    checkShape({
      taxableTiers: [
        { sharePct: 50, basisPct: 40 },
        { sharePct: 50, basisPct: 100 },
      ],
    });
  });

  test("loss carry-in reproduces its march on greedy rows", () => {
    checkShape({ capitalLossCarryInSt: 50000 });
  });

  test("cash sleeve reproduces its march on greedy rows", () => {
    checkShape({ spendFromCashPct: 50, spendFromCashSleeveStart: 100000 });
  });

  test("year-to-date conversion prices once, in the first year only", () => {
    const { inputs, rolled } = checkShape({ convertedAlreadyThisYear: 10000 });
    // The already-converted amount is the plan's first-year
    // conversion; no later year re-prices it. The pre-window
    // years (primary under the retirement age) convert $0 in
    // the march — pre-fix the phantom re-priced $10,000
    // there — while the window years convert NEW fill money
    // ($11,200 / $8,600 / $6,200 / $5,500 / $3,400 in the
    // march, 2030–2034), which is legitimate conversion, not
    // the phantom; checkShape's per-year parity already pins
    // rolled == march there.
    expect(within2c(rolled.greedyYears[0]!.conversion, 10000)).toBe(true);
    for (const r of rolled.greedyYears.slice(1)) {
      if (r.agePrimary < (inputs.retirementAge ?? 62)) {
        expect(within2c(r.conversion, 0)).toBe(true);
      }
    }
  });

  test("one-time gift fires once and never re-gifts", () => {
    checkShape({ giftOutflowAge: 63, giftOutflowAmount: 100000 });
  });

  test("tiered basis plus cash sleeve reproduces its march on greedy rows", () => {
    // Combined shape: the ledger's cash tier must survive the
    // re-anchor as the cash tier — a ratio test cannot
    // re-identify it after a growth year (its basis ratio
    // decays below 100% as its balance grows), so the
    // snapshot carries the flag.
    checkShape({
      taxableTiers: [
        { sharePct: 50, basisPct: 40 },
        { sharePct: 50, basisPct: 100 },
      ],
      spendFromCashPct: 50,
      spendFromCashSleeveStart: 100000,
    });
  });

  test("Roth IRA/employer split reproduces its march on greedy rows", () => {
    // MUST-C1 (fix round): the re-anchor used to rebuild
    // Roth at the plan's OPENING split every year (the grown
    // rothStart was ignored whenever rothIraStart was
    // entered), so a split plan's Roth never compounded
    // across re-anchors.
    checkShape({ rothIraStart: 300000, rothEmployerStart: 100000 });
  });

  test("Roth split with a spouse share reproduces its march on greedy rows", () => {
    checkShape({
      rothIraStart: 300000,
      rothEmployerStart: 100000,
      rothIraStartSpouse: 120000,
      rothEmployerStartSpouse: 40000,
    });
  });

  test("Roth split, employer-only control, reproduces its march on greedy rows", () => {
    // Control: with rothIraStart absent the fallback
    // (iraTotal = rothStart − employer) let the grown total
    // flow through even before the fix — this shape passed
    // pre-fix and must keep passing.
    checkShape({ rothEmployerStart: 100000 });
  });

  test("Roth split with Roth-first draws exhausts Roth on the march's schedule", () => {
    // The exhaustion shape: Roth-first, $300,000/yr spending
    // to 75 — the true march exhausts Roth in 2032, while
    // the pre-fix roll reset the pool every year and drew
    // from Roth forever (greedy $253,002.82 cheaper than
    // fixed, floor unbound). The taxable-first variant
    // leaves net cost blind to the Roth balance; this one
    // does not.
    checkShapeWith(
      {
        endAgePrimary: 75,
        annualSpending: 300000,
        rothIraStart: 300000,
        rothEmployerStart: 100000,
      },
      ROTH_FIRST_POLICY,
      ROTH_FIRST_ORDER,
    );
  });

  test("education refund deposits once, in the year after the refund", () => {
    // SHOULD-C1 (fix round): the refundable credit was
    // scored but never deposited in the next re-anchored
    // march, so the balance never received it.
    checkShape({ educationStudents: [{ year: 2026, expenses: 10000, aotcEligible: true }] });
  });

  test("education refund in a mid-roll year deposits the next year", () => {
    checkShape({ educationStudents: [{ year: 2028, expenses: 10000, aotcEligible: true }] });
  });

  test("flexible spending cuts after a negative-return year", () => {
    // SHOULD-C2 (fix round): every re-anchored march priced
    // its first year with no prior-year return (never cut),
    // while the uninterrupted march cuts every retirement
    // year once the prior year's return is negative. The
    // shape also pins the underwater-basis carry the cut
    // exposes: the −10% run carries basis above the balance
    // (109.2% in 2030), and the pct round-trip clamped it to
    // 100 at every re-anchor — the 2031 re-anchor haircut
    // $96,145.26, pricing $630.64 of extra tax. The dollars
    // carry (taxableBasisStartDollars) closes it; parity is
    // now within 1¢ per year.
    checkShape({ expectedReturnPct: -10, flexCutPct: 20, flexFloorPct: 80 });
  });

  test("sustained -10% return with tiers closes basis to the cent", () => {
    // SHOULD-A1 (fix round): the re-anchor's cent-rounded
    // taxableEnd re-based the tier ledger by up to $0.004
    // per re-anchor; the dust tipped the fully-consumed cash
    // tier's residual basis in 2033 (-$5,281.34, -$8,182.51
    // by 2035). Starting from the ledger's raw balances
    // closes it — this shape pins per-year basis parity to
    // 2c through the whole horizon.
    checkShape({
      expectedReturnPct: -10,
      taxableTiers: [
        { sharePct: 50, basisPct: 40 },
        { sharePct: 50, basisPct: 100 },
      ],
    });
  });

  test("survivor year with Roth draws reproduces its march on greedy rows", () => {
    // Survivor-year Roth-lot debit order (fix round): the
    // primary dies in 2030; survivor years price alone with
    // Roth-first draws, entered basis per owner, and a
    // 5-year clock unmet in the survivor years, so the
    // composition attribution prices. Pre-fix the first
    // survivor year diverged (the re-anchor passed the
    // march-appended conversion lots as if entered, flipping
    // an unknown ledger to known: the draw priced $58,100
    // of earnings income the true march prices $0, and the
    // conversion fill crowded to $0).
    checkShapeWith(
      {
        endAgePrimary: 75,
        survivorEnabled: true,
        survivorWho: "primary",
        survivorDeathYear: 2030,
        rothContributionBasisPrimary: 200000,
        rothContributionBasisSpouse: 100000,
        firstRothYearPrimary: 2028,
        firstRothYearSpouse: 2028,
      },
      ROTH_FIRST_POLICY,
      ROTH_FIRST_ORDER,
    );
  });

  test("survivor year, spouse dies, reproduces its march on greedy rows", () => {
    // Same shape with the fold in the other direction (the
    // primary survives).
    checkShapeWith(
      {
        endAgePrimary: 75,
        survivorEnabled: true,
        survivorWho: "spouse",
        survivorDeathYear: 2030,
        rothContributionBasisPrimary: 200000,
        rothContributionBasisSpouse: 100000,
        firstRothYearPrimary: 2028,
        firstRothYearSpouse: 2028,
      },
      ROTH_FIRST_POLICY,
      ROTH_FIRST_ORDER,
    );
  });

  test("survivor fold, dead lots entered / survivor lots unentered, reproduces its march", () => {
    // MUST-A2-1 (fix round 2, ASYM-3): the spouse holds $0
    // Roth, so the march's merge lets her unentered lots
    // escape — the merged ledger is known from the primary's
    // entered side. The old fold read the survivor's own
    // lots-entered flag alone, flipped the merged ledger
    // unknown, and priced the 2032 draw at $3,280 tax
    // against the true $42,020 (greedy $57,969.25 cheaper,
    // floor unbound). Both earlier survivor tests used lots
    // null on BOTH sides, so the fold's `known` path was
    // never exercised non-degenerately.
    checkShapeWith(
      {
        ...SURV_ASYM_BASE,
        survivorWho: "primary",
        rothConversionLotsPrimary: [],
        rothConversionLotsSpouse: null,
      },
      ROTH_FIRST_POLICY,
      ROTH_FIRST_ORDER,
    );
  });

  test("survivor fold, dead lots unentered / survivor lots entered, primary dies", () => {
    // MUST-A2-1 mirror (ASYM-1): the dead side poisons the
    // merged ledger unknown while the survivor's side is
    // entered — the old fold treated the merged ledger as
    // known (greedy $36,258.24 more expensive, floor bound).
    checkShapeWith(
      {
        ...SURV_ASYM_BASE,
        survivorWho: "primary",
        rothConversionLotsPrimary: null,
        rothConversionLotsSpouse: [],
      },
      ROTH_FIRST_POLICY,
      ROTH_FIRST_ORDER,
    );
  });

  test("survivor fold, dead lots unentered / survivor lots entered, spouse dies", () => {
    // MUST-A2-1 mirror (ASYM-2): same mechanism with the
    // sides swapped (greedy $13,886.87 cheaper, floor
    // unbound, pre-fix).
    checkShapeWith(
      {
        ...SURV_ASYM_BASE,
        survivorWho: "spouse",
        rothConversionLotsPrimary: [],
        rothConversionLotsSpouse: null,
      },
      ROTH_FIRST_POLICY,
      ROTH_FIRST_ORDER,
    );
  });

  test("survivor fold with both lots entered does not merge a $0 side's basis", () => {
    // MUST-A2-2 (fix round 2, D3): the spouse holds $0 Roth
    // but entered $100,000 of basis — the march splits it to
    // $0 against her $0 balances, while the old fold added
    // the raw $100,000 to the survivor's basis, letting a
    // $41,900 conversion lot survive the 2031 debit and
    // shelter the 2032 draw (tax $29,486 vs $42,020, greedy
    // $12,058.10 cheaper, floor unbound, pre-fix).
    checkShapeWith(
      {
        ...SURV_ASYM_BASE,
        survivorWho: "primary",
        rothConversionLotsPrimary: [],
        rothConversionLotsSpouse: [],
      },
      ROTH_FIRST_POLICY,
      ROTH_FIRST_ORDER,
    );
  });

  test("phantom conversion lot without a survivor reproduces its march", () => {
    // MUST-C2-1 (fix round 2, P2b): the state advance used
    // to debit the Roth draw BEFORE appending the year's
    // conversion lot — the opposite of the march's
    // settlement order — so a lot the true march consumed
    // in the same year's draw survived and shielded ~$102k
    // of earnings the next year (greedy $28,885.69 cheaper,
    // floor unbound, ending wealth overstated $54,611,
    // pre-fix). No survivor at all: a general advance-order
    // bug, not survivor-specific. Short horizon (end 67):
    // the first divergence is 2031, and the r2 dust stays
    // within the 2c bar through 2035 (3–5c only past 2039
    // on the end-75 horizon).
    checkShapeWith(
      {
        endAgePrimary: 67,
        annualSpending: 300000,
        rothContributionBasisPrimary: 200000,
        rothConversionLotsPrimary: [],
        firstRothYearPrimary: 2028,
      },
      ROTH_FIRST_POLICY,
      ROTH_FIRST_ORDER,
    );
  });

  test("Rule-of-55 eligible balance folds onto the survivor", () => {
    // MUST-C2-2 (fix round 2, P5c): the advance fed the
    // march's COMBINED pretax end against the survivor's
    // OWN opening balance into trackEligibleEnd, inflating
    // the death-year eligible balance by the deceased's
    // dollars (greedy $20,041.30 cheaper, floor unbound,
    // pre-fix). The fold now combines the eligible balances
    // with the pretax balances before tracking the end.
    // Do-nothing, pretax-first: no conversion lot exists to
    // confuse the eligible ledger; the shelter exhausts
    // inside the penalty window, where the inflation priced.
    checkShapeWith(
      {
        endAgePrimary: 70,
        retirementAge: 57,
        annualSpending: 300000,
        survivorEnabled: true,
        survivorWho: "primary",
        survivorDeathYear: 2027,
        pretaxStart: 750000,
        pretaxSpouseStart: 750000,
        pretax401kEligiblePrimary: 300000,
        pretax401kEligibleSpouse: 300000,
      },
      DO_NOTHING_PF_POLICY,
      ["pretax", "taxable", "roth"],
    );
  });

  test("survivor merged 5-year clock survives the fold", () => {
    // SHOULD-C2-1 (fix round 2, shape 6): the primary dies
    // in the FIRST dynamic year with an early clock (2020)
    // against the spouse's late clock (2028) — the march
    // merges to the earlier clock, but the re-anchor used
    // to spread the plan's original clocks, so after the
    // fold the survivor's late clock governed and the 2030
    // draw priced $280,000 of earnings income the true
    // march prices $0 (greedy $124,858.56 more expensive,
    // floor bound, pre-fix). Short horizon (end 67): the
    // divergence is 2030, and the r2 dust stays within the
    // 2c bar through 2035.
    checkShapeWith(
      {
        endAgePrimary: 67,
        annualSpending: 300000,
        survivorEnabled: true,
        survivorWho: "primary",
        survivorDeathYear: 2026,
        rothContributionBasisPrimary: 10000,
        rothContributionBasisSpouse: 10000,
        rothConversionLotsPrimary: [],
        rothConversionLotsSpouse: [],
        firstRothYearPrimary: 2020,
        firstRothYearSpouse: 2028,
      },
      ROTH_FIRST_POLICY,
      ROTH_FIRST_ORDER,
    );
  });

  test("per-account Roth contribution split survives an IRA-first draw", () => {
    // SHOULD-C2-2 (fix round 2, P1/shape 9): split IRA
    // $300,000 / employer $100,000 with $100,000 of basis
    // splits $75,000 / $25,000; the $300,000 Roth-first
    // draw consumes the IRA's $75,000 and its earnings,
    // leaving the employer's $25,000 standing. The old
    // re-anchor re-split the remaining TOTAL by balances,
    // resurrecting basis in the IRA (2031 tax $43,468 vs
    // the true $36,374; greedy $8,536.63 more expensive,
    // floor bound, pre-fix). Short horizon (end 67): the
    // divergence is 2031, and the r2 dust stays within the
    // 2c bar through 2035. The march detail's own split
    // pins the mechanism directly: after the 2030 draw the
    // IRA holds $0 of basis and the employer $25,000.
    const { march } = checkShapeWith(
      {
        endAgePrimary: 67,
        annualSpending: 300000,
        rothIraStart: 300000,
        rothEmployerStart: 100000,
        rothContributionBasisPrimary: 100000,
        rothConversionLotsPrimary: [],
        firstRothYearPrimary: 2028,
        firstDesignatedRothYearPrimary: 2028,
      },
      ROTH_FIRST_POLICY,
      ROTH_FIRST_ORDER,
    );
    const y2030 = march.years.find((y) => y.year === 2030)!;
    // The per-account fields are new in this round; the `as
    // any` read keeps this file compilable on the pre-fix
    // tree for the discrimination run (there the fields are
    // undefined and these assertions fail, as they should).
    const d2030 = y2030.detail as any;
    expect(within2c(d2030.rothContribIraEnd, 0)).toBe(true);
    expect(within2c(d2030.rothContribEmployerEnd, 25000)).toBe(true);
  });

  test("fresh plan with basis pct above 100 prices on the clamped basis", () => {
    // NICE-C2-1 (fix round 2, PCT120): an entered pct of
    // 120 used to ride into the first re-anchored march as
    // dollars (rolled year-1 basis $2,421,500 against the
    // fresh march's clamped $2,021,500; tax diverged from
    // 2030), because the state init never clamped like the
    // march's own opening ledger. Unreachable from saved
    // plans (the save boundary clamps pct to [0,100]);
    // defense in depth for direct engine calls.
    checkShape({ taxableBasisPct: 120 });
  });

  test("Roth split detail fields carry the IRA/employer split", () => {
    // NICE-B2 (fix round 2): the split shapes pinned only
    // the TOTAL rothEnd — a sub-balance swap with a correct
    // total would have passed. The detail fields the fix
    // publishes as the re-anchor's source of truth get
    // their own pin: year 0 is the entered $300,000 /
    // $100,000 grown one year at the sample's 5% (no Roth
    // draw or conversion before the window), and every
    // year's split foots to the row total.
    const { march } = checkShape({
      rothIraStart: 300000,
      rothEmployerStart: 100000,
    });
    const y0 = march.years[0]!;
    expect(within2c(y0.detail.rothIraEnd, 315000)).toBe(true);
    expect(within2c(y0.detail.rothEmployerEnd, 105000)).toBe(true);
    for (const m of march.years) {
      expect(within2c(m.detail.rothIraEnd + m.detail.rothEmployerEnd, m.rothEnd)).toBe(true);
    }
    const { march: marchS } = checkShape({
      rothIraStart: 300000,
      rothEmployerStart: 100000,
      rothIraStartSpouse: 120000,
      rothEmployerStartSpouse: 40000,
    });
    const y0s = marchS.years[0]!;
    expect(within2c(y0s.detail.rothIraEndSpouse, 126000)).toBe(true);
    expect(within2c(y0s.detail.rothEmployerEndSpouse, 42000)).toBe(true);
  });

  test("conversion-channel withholding is excluded from the tracked lot", () => {
    // MUST-C3-1 (fix round 3, reviewer C3): with
    // payTaxFrom "conversion" the march appends the NET
    // conversion as a lot (rothIn = additional − withheld,
    // $109,100 − $10,885.56 = $98,214.44 in 2026), but the
    // advance appended the GROSS funding.conversion — the
    // tracked lot was too big by the withheld amount, and
    // the next Roth draw reaching the lots tier shielded
    // that much earnings income (greedy $2,635.73 cheaper,
    // first divergence 2027, worst tax $3,048.19, pre-fix).
    // The detail pins the mechanism directly: the appended
    // lot is the net amount, and the year-end lot is the
    // net amount less the $60,000 the 2026 draw consumed
    // ($200,000 of contributions first, then the lot).
    // Shape note: the reviewer's $220,000 variant carries
    // the same mechanism (greedy $2,419.00 cheaper
    // pre-fix) and is verified by probe post-fix (net
    // $0.00, tax $0.00 every year); the committed shape
    // uses the reviewer's $260,000 variant because the
    // $220,000 variant's taxable-balance carry drifts 4c
    // by 2031 — the known r2-dust class, not a mechanism
    // (tax $0.00, basis 1c, net $0.00) — which would trip
    // this harness's 2c bar.
    const { march } = checkShapeWith(
      {
        endAgePrimary: 67,
        windowStartAge: 57,
        retirementAge: 57,
        rothContributionBasisPrimary: 200000,
        rothConversionLotsPrimary: [],
        firstRothYearPrimary: 2028,
        annualSpending: 260000,
        payTaxFrom: "conversion",
      },
      ROTH_FIRST_POLICY,
      ROTH_FIRST_ORDER,
    );
    const y2026 = march.years[0]!;
    expect(within2c(y2026.funding.conversion, 109100)).toBe(true);
    // The new detail fields are this round's publication;
    // the `as any` read keeps this file compilable on the
    // pre-fix tree (there the fields are undefined and
    // these assertions fail, as they should).
    const d2026 = y2026.detail as any;
    expect(within2c(d2026.rothConversionLotP, 98214.44)).toBe(true);
    expect(d2026.rothLotsEndP.length).toBe(1);
    expect(d2026.rothLotsEndP[0].year).toBe(2026);
    expect(within2c(d2026.rothLotsEndP[0].taxableAmount, 38214.44)).toBe(true);
  });

  test("already-converted amount creates no lot", () => {
    // MUST-C3-2 (fix round 3, reviewer C3): the march
    // prices the already-converted amount as year-1 income
    // but never appends a lot for it ("already reflected
    // in the starting balances"), while the advance appended
    // funding.conversion — which in year 1 includes the
    // YTD amount — as a fresh lot. The $10,000 phantom lot
    // shielded a later Roth draw (greedy $2,514.04
    // cheaper, first divergence 2031, pre-fix). The old
    // YTD test pinned conversion AMOUNTS only; this shape
    // draws Roth to the lots tier after the YTD year and
    // pins LOT COMPOSITION: the 2026 appended lot is $0
    // against a $10,000 conversion, and no lot bearing
    // year 2026 ever stands in any year's year-end lots.
    const { march } = checkShapeWith(
      {
        endAgePrimary: 67,
        convertedAlreadyThisYear: 10000,
        rothContributionBasisPrimary: 200000,
        rothConversionLotsPrimary: [],
        firstRothYearPrimary: 2028,
        annualSpending: 300000,
      },
      ROTH_FIRST_POLICY,
      ROTH_FIRST_ORDER,
    );
    const y2026 = march.years[0]!;
    expect(within2c(y2026.funding.conversion, 10000)).toBe(true);
    const d2026 = y2026.detail as any;
    expect(within2c(d2026.rothConversionLotP, 0)).toBe(true);
    for (const m of march.years) {
      const lots = (m.detail as any).rothLotsEndP as any[];
      expect(lots.filter((l) => l.year === 2026).length).toBe(0);
    }
  });

  test("conversion top-up shrink is carried in the tracked lots", () => {
    // SHOULD-C3-1 (fix round 3, reviewer C3 — isolated
    // here, not "could not isolate"): the top-up shrinks
    // the appended lot AFTER the spending draw, so no
    // append-time amount can express it. The isolation
    // shape runs taxable-first until age 60 — the opening
    // withholding is $0 there (conversion $23,500, lot
    // $23,500) while the top-up fires ($316.67 in 2026,
    // $307.79 in 2027) — then switches to Roth-first, so
    // the later draws reach the shrunk lots (greedy
    // $169.41 cheaper, first divergence 2030, pre-fix
    // with the appended-amount fix alone). The detail pins
    // the shrink directly: the year-end lots are the
    // appended amounts less the top-up, with $0 drawn.
    const { march } = checkShapeWith(
      {
        endAgePrimary: 67,
        windowStartAge: 57,
        retirementAge: 57,
        rothContributionBasisPrimary: 200000,
        rothConversionLotsPrimary: [],
        firstRothYearPrimary: 2028,
        annualSpending: 220000,
        payTaxFrom: "conversion",
        drawOrderSwitchAge: 60,
        drawOrderAfter: [...ROTH_FIRST_ORDER],
      },
      POLICY,
      ORDER,
    );
    const y2026 = march.years[0]!;
    expect(within2c(y2026.funding.conversion, 23500)).toBe(true);
    const d2026 = y2026.detail as any;
    expect(within2c(d2026.rothConversionLotP, 23500)).toBe(true);
    expect(d2026.rothLotsEndP.length).toBe(1);
    expect(within2c(d2026.rothLotsEndP[0].taxableAmount, 23183.33)).toBe(true);
    const y2027 = march.years[1]!;
    expect(within2c(y2027.funding.conversion, 21100)).toBe(true);
    const d2027 = y2027.detail as any;
    expect(within2c(d2027.rothConversionLotP, 21100)).toBe(true);
    expect(d2027.rothLotsEndP.length).toBe(2);
    expect(within2c(d2027.rothLotsEndP[0].taxableAmount, 23183.33)).toBe(true);
    expect(within2c(d2027.rothLotsEndP[1].taxableAmount, 20792.21)).toBe(true);
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
    // The floor's rows: the best fixed policy's uninterrupted
    // march, re-expressed as schedule rows. The rows read
    // each year's basis from the march's own detail (the
    // walk is gone — see dynamicRowsFromFixedMarch).
    const floorRows = dynamicRowsFromFixedMarch(bestFixed.result, bestFixed.policy, inputs);
    expect(floorRows.length).toBe(bestFixed.result.years.length);
    // The greedy trajectory the floor replaces: the Do Nothing
    // march's rows (a different, worse trajectory on the same
    // inputs), with its own worse net cost beside them.
    const doNothing = scored.find((s) => s.policy.ceilings == null)!;
    const greedyRows = dynamicRowsFromFixedMarch(doNothing.result, doNothing.policy, inputs);
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
      // NICE-C2-2 (fix round 2): the floor rows read basis
      // from the march's own detail — pin it per row, so
      // the A2 floor-rows fix is covered at row level, not
      // only by the A/B unrealized-gains pin.
      expect(r.taxableBasisEnd).toBe(m.detail.taxableBasisDollars);
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
    // 2c per flow field, in integer cents — the Pass 4 note applies
    // here too: the fields are cent-rounded dollars, and a raw-float
    // `<= 0.02` fails a true 2c difference on float noise (this
    // case's 2061 RMD/federalTax sit exactly on the bar after the
    // C2 conditional integer-cents walk moved one leg a cent).
    const within2c = (a: number, b: number) => Math.abs(Math.round(a * 100) - Math.round(b * 100)) <= 2;
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
      // (see the helper note above), not 2¢ — compared in
      // integer cents like the flow bar, for the same float reason.
      const within50c = (a: number, b: number) => Math.abs(Math.round(a * 100) - Math.round(b * 100)) <= 50;
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
    // Integer cents, like the parity helper: a raw-float <= 0.02
    // fails a true 2c gap on float noise.
    expect(Math.abs(Math.round(r2046.rmdSpouse * 100) - Math.round(m2046.detail.rmdSpouse * 100))).toBeLessThanOrEqual(2);
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
    // Integer cents, like the parity helper: a raw-float <= 0.02
    // fails a true 2c gap on float noise.
    expect(Math.abs(Math.round(r2044.rmdPrimary * 100) - Math.round(m2044.detail.rmdPrimary * 100))).toBeLessThanOrEqual(2);
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
    // Integer cents, like the parity helper: a raw-float <= 0.02
    // fails a true 2c gap on float noise.
    expect(Math.abs(Math.round(r2046.rmdSpouse * 100) - Math.round(m2046.detail.rmdSpouse * 100))).toBeLessThanOrEqual(2);
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

  test("A/B unrealized gains on the tiers shape match the march's own ending basis to the cent", () => {
    // SHOULD-A2 (fix round): the A/B arms read unrealized
    // gains from the basis WALK, which the tiered, gift, and
    // sleeve probes proved wrong (tiers -$200k) — on this
    // shape arm A overstated unrealized by $249,534.72 and
    // arm B by $399,655.88. Both arms now read each year's
    // detail.taxableBasisDollars; the true figures below are
    // the arms' own uninterrupted marches, priced directly.
    const inputs = shortInputs({
      taxableTiers: [
        { sharePct: 50, basisPct: 40 },
        { sharePct: 50, basisPct: 100 },
      ],
    });
    const rows = runDynamicAbExperiment(inputs, [100000]);
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    const trueUnrealized = (drawOrder: DrawOrder, ceilings: FillCeilings | null) => {
      const march = simulateRothPlan(
        { ...inputs, annualSpending: 100000, drawOrder: [...drawOrder] },
        { id: "ab-true", name: "arm", ceilings, guardrail: false },
        undefined,
        { leanDetail: true },
      );
      const last = march.years[march.years.length - 1]!;
      return Math.max(0, last.taxableEnd - last.detail.taxableBasisDollars);
    };
    expect(
      Math.abs(row.a.unrealizedGains - trueUnrealized(["pretax", "taxable", "roth"], null)),
    ).toBeLessThanOrEqual(0.01);
    expect(
      Math.abs(
        row.b.unrealizedGains -
          trueUnrealized(["taxable", "roth", "pretax"], { ...NO_CEILINGS, bracketTopPct: 12 }),
      ),
    ).toBeLessThanOrEqual(0.01);
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
