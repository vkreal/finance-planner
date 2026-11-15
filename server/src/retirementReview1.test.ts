// Engine Review 1 (§4 invariants + E1-S1/E1-S2) — independent tests
// for the retirement simulation engines.
//
// STANDARD: every expected figure below is hand-computed in the
// test itself (plain arithmetic on literals), at zero or controlled
// returns — never a copied engine print. Where the engine's own
// per-run gross series is the input (the historical / Monte Carlo
// adequacy re-derivations), the COUNTING is re-implemented here,
// so the test verifies the engine's rate rather than restating it.
// Sample-household values (sampleHousehold.ts) throughout: the
// primary is 58, spending is $180,000/yr, the Social Security
// anchor is $48,000/yr at 67.
//
// Run per-file (whole-suite bun test in one process OOMs on this
// VM): bun test server/src/retirementReview1.test.ts

import { describe, test, expect } from "bun:test";
import {
  buildSimInputs,
  horizonYears,
  incomeCentsAt,
  phasedGrossCents,
  runHistorical,
  runMonteCarlo,
  runNeverRunsOut,
  simulate,
  simulateDetailed,
  spendingAdequacyRate,
  type SimInputs,
} from "./retirementEngines";
import {
  SAMPLE_ANNUAL_SPENDING_CENTS,
  SAMPLE_SS_PRIMARY_CENTS,
  SAMPLE_SS_PRIMARY_START_AGE,
  SAMPLE_SS_SPOUSE_CENTS,
} from "./sampleHousehold";

// --- Independent reference implementation ---------------------------
// A from-scratch reimplementation of the documented year loop, used
// only to cross-check the engine on small cases: in each retired
// year, withdraw (gross − income) FIRST and floor the balance at 0,
// then apply that year's return. Gross depends on the strategy;
// guardrails is NOT re-implemented here (its rail logic is pinned
// by hand-derived literals in the guardrails test below instead).
function referenceSim(
  inputs: SimInputs,
  returns: number[],
): { balances: number[]; gross: number[]; net: number[] } {
  const years = inputs.endAge - inputs.currentAge + 1;
  const balances: number[] = [inputs.startCents];
  const gross: number[] = [];
  const net: number[] = [];
  let bal = inputs.startCents;
  for (let i = 0; i < years; i++) {
    const age = inputs.currentAge + i;
    let g = 0;
    let n = 0;
    if (age >= inputs.retirementAge) {
      const income =
        inputs.incomeSchedule && inputs.incomeSchedule.length > 0
          ? inputs.incomeSchedule.reduce(
              (s, st) =>
                s + (age >= (st.startAge ?? inputs.retirementAge) ? st.amountCents : 0),
              0,
            )
          : inputs.extraIncomeStartAge != null &&
              age >= inputs.extraIncomeStartAge
            ? inputs.extraIncomeCents
            : 0;
      if (inputs.strategy === "percent") {
        g = Math.round(bal * (inputs.percentOfPortfolio / 100));
      } else if (inputs.strategy === "phased") {
        g =
          age <= inputs.phaseStartAge
            ? inputs.spendingCents
            : Math.round(
                inputs.spendingCents *
                  Math.pow(1 - inputs.phaseDeclinePct / 100, age - inputs.phaseStartAge),
              );
      } else {
        g = inputs.spendingCents;
      }
      n = g - income;
      bal -= n;
      if (bal < 0) bal = 0;
    }
    gross.push(g);
    net.push(n);
    bal = bal * (1 + (returns[i] ?? 0));
    if (bal < 0) bal = 0;
    balances.push(bal);
  }
  return { balances, gross, net };
}

// Funding failure derived from a detailed run, the way the engine's
// own test does it: a retired year whose net withdrawal exceeds the
// balance on hand at its start.
function referenceNeverOut(
  det: { balances: number[]; netWithdrawals: number[] },
  inputs: SimInputs,
): boolean {
  for (let i = 0; i < det.netWithdrawals.length; i++) {
    if (inputs.currentAge + i < inputs.retirementAge) continue;
    if ((det.netWithdrawals[i] ?? 0) > (det.balances[i] ?? 0)) return false;
  }
  return true;
}

// The sample household as SimInputs, with only the noted overrides.
function sampleInputs(overrides: Partial<SimInputs> = {}): SimInputs {
  return {
    startCents: 200_000_000, // sample taxable balance
    spendingCents: SAMPLE_ANNUAL_SPENDING_CENTS, // $180,000/yr
    currentAge: 58,
    retirementAge: 62,
    endAge: 95,
    extraIncomeCents: 0,
    extraIncomeStartAge: null,
    strategy: "constant",
    percentOfPortfolio: 5,
    guardrailsCutPct: 120,
    guardrailsRaisePct: 80,
    guardrailsAdjustmentPct: 10,
    phaseStartAge: 75,
    phaseDeclinePct: 1,
    ...overrides,
  };
}

describe("§4 invariants (independent, zero / controlled returns)", () => {
  test("a fully funded withdrawal does not count as a shortfall", () => {
    // $60,000 portfolio, $60,000/yr spending, retire now, 0%
    // returns, one retired year: the withdrawal exactly equals
    // the balance on hand, so it is funded — ending $0, but no
    // year went short.
    const inputs = sampleInputs({
      startCents: 6_000_000,
      spendingCents: 6_000_000,
      currentAge: 60,
      retirementAge: 60,
      endAge: 60,
    });
    expect(runNeverRunsOut(inputs, [0])).toBe(true);
    const det = simulateDetailed(inputs, [0]);
    expect(Math.round(det.balances[det.balances.length - 1] ?? -1)).toBe(0);
    expect(det.netWithdrawals).toEqual([6_000_000]);
  });

  test("a withdrawal exceeding available assets counts as a shortfall", () => {
    // $100,000 portfolio, $60,000/yr, retire at 60, 0% returns,
    // ages 60–62: year 60 funds ($40,000 left), year 61 needs
    // $60,000 against $40,000 — short — and the balance floors
    // at $0 for the rest.
    const inputs = sampleInputs({
      startCents: 10_000_000,
      spendingCents: 6_000_000,
      currentAge: 60,
      retirementAge: 60,
      endAge: 62,
    });
    const det = simulateDetailed(inputs, [0, 0, 0]);
    expect(det.balances).toEqual([
      10_000_000, 4_000_000, 0, 0,
    ]);
    expect(runNeverRunsOut(inputs, [0, 0, 0])).toBe(false);
    expect(referenceNeverOut(det, inputs)).toBe(false);
  });

  test("a later income surplus cannot erase an earlier funding failure", () => {
    // The same shortfall plan, plus $100,000/yr income from 62:
    // year 62's net withdrawal is $60,000 − $100,000 = −$40,000,
    // so the balance refills to $40,000 and the run ENDS
    // positive — yet the year-61 spending still went unfunded,
    // so the run is still a funding failure.
    const inputs = sampleInputs({
      startCents: 10_000_000,
      spendingCents: 6_000_000,
      currentAge: 60,
      retirementAge: 60,
      endAge: 62,
      extraIncomeCents: 10_000_000,
      extraIncomeStartAge: 62,
    });
    const det = simulateDetailed(inputs, [0, 0, 0]);
    expect(Math.round(det.balances[det.balances.length - 1] ?? -1)).toBe(
      4_000_000,
    );
    expect(runNeverRunsOut(inputs, [0, 0, 0])).toBe(false);
  });

  test("deterministic and success-only paths agree across returns and strategies", () => {
    const returnPaths: number[][] = [
      [0, 0, 0, 0],
      [0.1, -0.2, 0.05, 0],
      [-0.5, -0.5, 0.5, 0.25],
      [0.2, 0.2, -0.4, -0.1],
    ];
    const strategies: SimInputs["strategy"][] = [
      "constant",
      "percent",
      "guardrails",
      "phased",
    ];
    for (const strategy of strategies) {
      for (const returns of returnPaths) {
        const inputs = sampleInputs({
          startCents: 50_000_000,
          currentAge: 60,
          retirementAge: 60,
          endAge: 63,
          strategy,
          percentOfPortfolio: 8,
          extraIncomeCents: 3_000_000,
          extraIncomeStartAge: 62,
        });
        const det = simulateDetailed(inputs, returns);
        const ref = referenceSim(inputs, returns);
        // The detailed path's balances, gross, and net match
        // the independent reimplementation to the cent on every
        // year (guardrails included — the reference loop skips
        // guardrails, so compare only balances/net/gross for the
        // other three; guardrails parity is checked via the
        // funding predicate alone below).
        if (strategy !== "guardrails") {
          expect(det.balances.map((b) => Math.round(b))).toEqual(
            ref.balances.map((b) => Math.round(b)),
          );
          expect(det.grossWithdrawals).toEqual(ref.gross);
          expect(det.netWithdrawals).toEqual(ref.net);
        }
        // And the success-only twin agrees with the funding
        // predicate derived from the detailed run, on every
        // strategy — including guardrails.
        expect(runNeverRunsOut(inputs, returns)).toBe(
          referenceNeverOut(det, inputs),
        );
      }
    }
  });

  test("the inclusive end-age convention holds", () => {
    expect(horizonYears(58, 95)).toBe(38);
    expect(horizonYears(60, 60)).toBe(1);
    expect(horizonYears(60, 59)).toBe(0);
    // $100,000 at a steady 10%, no spending, ages 58–95: 38
    // priced years, so the ending is $100,000 × 1.10^38.
    const inputs = sampleInputs({
      startCents: 10_000_000,
      spendingCents: 0,
      currentAge: 58,
      retirementAge: 58,
      endAge: 95,
    });
    const path = simulate(inputs, Array.from({ length: 38 }, () => 0.1));
    expect(Math.round(path[path.length - 1] ?? -1)).toBe(
      Math.round(10_000_000 * Math.pow(1.1, 38)),
    );
  });

  test("guardrails changes are applied consistently (hand-derived)", () => {
    // The fixture's −50%-returns case, recomputed by hand here:
    // $1,000,000, $50,000/yr (5% initial rate; cut rail 6%).
    // Age 60: no adjustment (rate = initial), balance
    // (1,000,000 − 50,000) × 0.5 = $475,000. Age 61: rate
    // 10.53% > 6% → cut 10% to $45,000; balance $215,000.
    // Age 62: rate 20.93% > 6% → cut 10% again, on the
    // ADJUSTED $45,000 (not reset to $50,000) = $40,500;
    // balance $87,250. Age 63: rate 46.4% > 6% → cut to
    // $36,450; ending (87,250 − 36,450) × 0.5 = $25,400.
    const inputs = sampleInputs({
      startCents: 100_000_000,
      spendingCents: 5_000_000,
      currentAge: 60,
      retirementAge: 60,
      endAge: 63,
      strategy: "guardrails",
    });
    const det = simulateDetailed(inputs, [-0.5, -0.5, -0.5, -0.5]);
    expect(det.grossWithdrawals).toEqual([
      5_000_000, 4_500_000, 4_050_000, 3_645_000,
    ]);
    expect(Math.round(det.balances[det.balances.length - 1] ?? -1)).toBe(
      2_540_000,
    );
  });

  test("phased spending follows its configured decline schedule", () => {
    // $180,000/yr sample spending, step-down from 75 at 1%/yr:
    // full through 75, then 0.99^(age−75) — hand-computed.
    const inputs = sampleInputs({
      currentAge: 58,
      retirementAge: 62,
      endAge: 95,
      strategy: "phased",
    });
    for (const [age, factor] of [
      [74, 1],
      [75, 1],
      [76, 0.99],
      [80, Math.pow(0.99, 5)],
      [95, Math.pow(0.99, 20)],
    ] as const) {
      expect(phasedGrossCents(inputs, age)).toBe(
        Math.round(SAMPLE_ANNUAL_SPENDING_CENTS * factor),
      );
    }
    const det = simulateDetailed(
      inputs,
      Array.from({ length: 38 }, () => 0),
    );
    // Gross at 95 is the last retired year: $180,000 × 0.99^20.
    expect(det.grossWithdrawals[det.grossWithdrawals.length - 1]).toBe(
      Math.round(SAMPLE_ANNUAL_SPENDING_CENTS * Math.pow(0.99, 20)),
    );
  });

  test("percentage withdrawals respond to the correct (start-of-year) balance", () => {
    // $1,000,000, 10% of the balance, 0% returns, ages 60–62:
    // gross is 10% of the balance at the START of each year —
    // $100,000, then $90,000, then $81,000 — leaving $729,000.
    const inputs = sampleInputs({
      startCents: 100_000_000,
      spendingCents: 10_000_000,
      currentAge: 60,
      retirementAge: 60,
      endAge: 62,
      strategy: "percent",
      percentOfPortfolio: 10,
    });
    const det = simulateDetailed(inputs, [0, 0, 0]);
    expect(det.grossWithdrawals).toEqual([10_000_000, 9_000_000, 8_100_000]);
    expect(det.balances).toEqual([
      100_000_000, 90_000_000, 81_000_000, 72_900_000,
    ]);
  });

  test("multiple income streams are counted once at the correct times", () => {
    // Sample SS anchors as a two-stream schedule: primary
    // $48,000/yr at 67, spouse $30,000/yr at 70 (spouse age on
    // the primary's timeline). Spending $180,000/yr, retire at
    // 62, 0% returns, ages 58–72: net is $180,000 through 66,
    // $132,000 at 67–69, and $102,000 from 70 — each stream
    // counted once, starting in its own year.
    const inputs = sampleInputs({
      currentAge: 58,
      retirementAge: 62,
      endAge: 72,
      incomeSchedule: [
        {
          amountCents: SAMPLE_SS_PRIMARY_CENTS,
          startAge: SAMPLE_SS_PRIMARY_START_AGE,
        },
        { amountCents: SAMPLE_SS_SPOUSE_CENTS, startAge: 70 },
      ],
    });
    expect(incomeCentsAt(inputs, 66)).toBe(0);
    expect(incomeCentsAt(inputs, 67)).toBe(SAMPLE_SS_PRIMARY_CENTS);
    expect(incomeCentsAt(inputs, 70)).toBe(
      SAMPLE_SS_PRIMARY_CENTS + SAMPLE_SS_SPOUSE_CENTS,
    );
    const det = simulateDetailed(inputs, Array.from({ length: 15 }, () => 0));
    expect(det.netWithdrawals.slice(4, 15)).toEqual([
      18_000_000, 18_000_000, 18_000_000, 18_000_000, 18_000_000,
      13_200_000, 13_200_000, 13_200_000,
      10_200_000, 10_200_000, 10_200_000,
    ]);
    expect(det.grossWithdrawals.slice(4, 15)).toEqual(
      Array.from({ length: 11 }, () => 18_000_000),
    );
  });

  test("controlled positive and negative returns price the year loop", () => {
    // $100,000, $10,000/yr, retire now, returns +10%, −20%, +5%:
    // (100,000−10,000)×1.1 = $99,000; (99,000−10,000)×0.8 =
    // $71,200; (71,200−10,000)×1.05 = $64,260.
    const inputs = sampleInputs({
      startCents: 10_000_000,
      spendingCents: 1_000_000,
      currentAge: 60,
      retirementAge: 60,
      endAge: 62,
    });
    const path = simulate(inputs, [0.1, -0.2, 0.05]);
    expect(path.map((b) => Math.round(b))).toEqual([
      10_000_000, 9_900_000, 7_120_000, 6_426_000,
    ]);
  });
});

describe("E1-S1 spending adequacy", () => {
  test("adequacy is the share of runs whose every retired gross meets the floor", () => {
    // The percent case above: grosses $100,000 / $90,000 /
    // $81,000 across ages 60–62. A $90,000 floor fails the run
    // ($81,000 < $90,000 in the last year); an $81,000 floor
    // passes it (every year meets or beats it, the last exactly).
    const inputs = sampleInputs({
      startCents: 100_000_000,
      spendingCents: 10_000_000,
      currentAge: 60,
      retirementAge: 60,
      endAge: 62,
      strategy: "percent",
      percentOfPortfolio: 10,
    });
    const det = simulateDetailed(inputs, [0, 0, 0]);
    expect(
      spendingAdequacyRate(
        { ...inputs, minimumAnnualSpendingCents: 9_000_000 },
        [det.grossWithdrawals],
      ),
    ).toBe(0);
    expect(
      spendingAdequacyRate(
        { ...inputs, minimumAnnualSpendingCents: 8_100_000 },
        [det.grossWithdrawals],
      ),
    ).toBe(100);
  });

  test("no floor, or no retired years, means no adequacy rate", () => {
    const inputs = sampleInputs({
      currentAge: 58,
      retirementAge: 62,
      endAge: 95,
    });
    expect(
      spendingAdequacyRate(inputs, [[18_000_000, 18_000_000]]),
    ).toBeNull();
    expect(
      spendingAdequacyRate(
        { ...inputs, minimumAnnualSpendingCents: 0 },
        [[18_000_000]],
      ),
    ).toBeNull();
    // A plan with no retired years (retirement past the end
    // age) has no spending to judge, even with a floor set.
    const noRetired = sampleInputs({
      currentAge: 58,
      retirementAge: 96,
      endAge: 95,
      minimumAnnualSpendingCents: 15_000_000,
    });
    expect(
      spendingAdequacyRate(noRetired, [Array.from({ length: 38 }, () => 0)]),
    ).toBeNull();
  });

  test("constant gross always meets a floor at/below spending — even when unfunded", () => {
    // The documented caveat, pinned: the shortfall plan's
    // gross is $60,000 in every retired year, so a $60,000
    // floor reads adequacy 100% — while the same run's funding
    // test fails (see the shortfall test above). Adequacy on
    // gross spending alone cannot see unfunded withdrawals.
    const inputs = sampleInputs({
      startCents: 10_000_000,
      spendingCents: 6_000_000,
      currentAge: 60,
      retirementAge: 60,
      endAge: 62,
      minimumAnnualSpendingCents: 6_000_000,
    });
    const det = simulateDetailed(inputs, [0, 0, 0]);
    expect(
      spendingAdequacyRate(inputs, [det.grossWithdrawals]),
    ).toBe(100);
    expect(runNeverRunsOut(inputs, [0, 0, 0])).toBe(false);
  });

  test("historical adequacy is re-derived from the per-run gross series", () => {
    // Independent count: the test's own loop over the runs'
    // gross withdrawals, against the engine's reported rate.
    // Sample percent plan, $150,000/yr floor: the engine
    // reports 6.6% (4 of 61 runs) beside 100% funding success.
    const built = buildSimInputs(
      {
        portfolioCents: 200000000,
        spendingCents: SAMPLE_ANNUAL_SPENDING_CENTS,
        currentAge: 58,
        retirementAge: 62,
        endAge: 95,
        stocksPct: 75,
        extraIncomeCents: null,
        extraIncomeStartAge: null,
        expectedReturnPct: null,
        volatilityPct: null,
        strategy: "percent",
        percentOfPortfolio: 5,
        guardrailsCutPct: null,
        guardrailsRaisePct: null,
        guardrailsAdjustmentPct: null,
        minimumAnnualSpendingCents: 15000000,
      },
      { portfolioCents: 0, spendingCents: 0 },
    );
    expect(built).not.toBeNull();
    const h = runHistorical(built!.inputs, built!.stocks);
    expect(h).not.toBeNull();
    const floor = 15_000_000;
    let adequate = 0;
    for (const run of h!.runs) {
      const retired = run.grossWithdrawals.filter(
        (_, i) => 58 + i >= 62,
      );
      if (retired.every((g) => g >= floor)) adequate++;
    }
    expect(Math.round((adequate / h!.runs.length) * 1000) / 10).toBe(6.6);
    expect(
      Math.round((h!.spendingAdequacySuccessRate ?? -1) * 10) / 10,
    ).toBe(6.6);
    expect(Math.round(h!.neverOutSuccessRate * 10) / 10).toBe(100);
    expect(h!.minimumAnnualSpendingCents).toBe(15_000_000);
  });

  test("monte carlo adequacy is re-derived from the per-run gross series", () => {
    // The same independent count cannot see Monte Carlo's
    // per-run gross series (runMonteCarlo does not return it),
    // so this test replays the tab's seeded stream through
    // simulateDetailed itself — the same returns, the same
    // inputs — and counts adequacy on that replay, against the
    // engine's reported 4.9% (49 of 1,000 runs) beside 100%
    // funding success. The stream replay uses the engine's
    // exported seed default only as the seed value; the returns
    // themselves are drawn here by an independent Box–Muller
    // over mulberry32 — the same documented construction.
    const built = buildSimInputs(
      {
        portfolioCents: 200000000,
        spendingCents: SAMPLE_ANNUAL_SPENDING_CENTS,
        currentAge: 58,
        retirementAge: 62,
        endAge: 95,
        stocksPct: 75,
        extraIncomeCents: null,
        extraIncomeStartAge: null,
        expectedReturnPct: null,
        volatilityPct: null,
        strategy: "percent",
        percentOfPortfolio: 5,
        guardrailsCutPct: null,
        guardrailsRaisePct: null,
        guardrailsAdjustmentPct: null,
        minimumAnnualSpendingCents: 15000000,
      },
      { portfolioCents: 0, spendingCents: 0 },
    );
    expect(built).not.toBeNull();
    const mc = runMonteCarlo(
      built!.inputs,
      built!.expected,
      built!.vol,
      12345,
      1000,
    );
    expect(mc).not.toBeNull();
    // Replay the tab's stream: mulberry32(seed*7919+17) with
    // Box–Muller normals, expected/vol from the built inputs.
    let a = (12345 * 7919 + 17) >>> 0;
    const rng = () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const normal = () => {
      let u = 0;
      let v = 0;
      while (u === 0) u = rng();
      while (v === 0) v = rng();
      return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    };
    const planYears = 95 - 58 + 1;
    const floor = 15_000_000;
    let adequate = 0;
    for (let run = 0; run < 1000; run++) {
      const returns: number[] = [];
      for (let i = 0; i < planYears; i++) {
        returns.push(built!.expected + built!.vol * normal());
      }
      const det = simulateDetailed(built!.inputs, returns);
      const retired = det.grossWithdrawals.filter((_, i) => 58 + i >= 62);
      if (retired.every((g) => g >= floor)) adequate++;
    }
    expect(adequate).toBe(49);
    expect(Math.round((mc!.spendingAdequacySuccessRate ?? -1) * 10) / 10).toBe(
      4.9,
    );
    expect(Math.round(mc!.neverOutSuccessRate * 10) / 10).toBe(100);
  });
});

describe("E1-S2 pre-retirement income is not accumulated", () => {
  test("income starting before retirement adds nothing pre-retirement", () => {
    // $1,000,000 portfolio, $100,000/yr spending, retire at 62,
    // $48,000/yr (sample SS) from 60, 0% returns, ages 58–65:
    // the balance at the start of age 62 is still exactly
    // $1,000,000 — the two pre-retirement years banked nothing.
    // The four retired years each net $52,000, ending $792,000.
    const inputs = sampleInputs({
      startCents: 100_000_000,
      spendingCents: 10_000_000,
      currentAge: 58,
      retirementAge: 62,
      endAge: 65,
      extraIncomeCents: SAMPLE_SS_PRIMARY_CENTS,
      extraIncomeStartAge: 60,
    });
    const det = simulateDetailed(inputs, Array.from({ length: 8 }, () => 0));
    expect(det.balances[4]).toBe(100_000_000);
    expect(det.grossWithdrawals.slice(0, 4)).toEqual([0, 0, 0, 0]);
    expect(Math.round(det.balances[det.balances.length - 1] ?? -1)).toBe(
      79_200_000,
    );
    expect(runNeverRunsOut(inputs, Array.from({ length: 8 }, () => 0))).toBe(
      true,
    );
  });

  test("starting at retirement prices identically; starting after the end age is no income", () => {
    const base = {
      startCents: 100_000_000,
      spendingCents: 10_000_000,
      currentAge: 58,
      retirementAge: 62,
      endAge: 65,
    } as const;
    const zeros = Array.from({ length: 8 }, () => 0);
    const atRetirement = sampleInputs({
      ...base,
      extraIncomeCents: SAMPLE_SS_PRIMARY_CENTS,
      extraIncomeStartAge: 62,
    });
    const afterEnd = sampleInputs({
      ...base,
      extraIncomeCents: SAMPLE_SS_PRIMARY_CENTS,
      extraIncomeStartAge: SAMPLE_SS_PRIMARY_START_AGE,
    });
    const none = sampleInputs({ ...base });
    const endOf = (inputs: SimInputs) => {
      const d = simulateDetailed(inputs, zeros);
      return Math.round(d.balances[d.balances.length - 1] ?? -1);
    };
    // At-retirement start: $792,000, same as the
    // before-retirement start above.
    expect(endOf(atRetirement)).toBe(79_200_000);
    // After-end-age start (67 > end 65): $600,000 — the stream
    // never pays, exactly no income.
    expect(endOf(afterEnd)).toBe(60_000_000);
    expect(endOf(none)).toBe(60_000_000);
  });

  test("a multi-stream schedule starting pre-retirement also banks nothing", () => {
    const inputs = sampleInputs({
      startCents: 100_000_000,
      spendingCents: 10_000_000,
      currentAge: 58,
      retirementAge: 62,
      endAge: 65,
      incomeSchedule: [
        { amountCents: SAMPLE_SS_PRIMARY_CENTS, startAge: 60 },
        { amountCents: SAMPLE_SS_SPOUSE_CENTS, startAge: 61 },
      ],
    });
    const det = simulateDetailed(inputs, Array.from({ length: 8 }, () => 0));
    // Balance at the start of age 62 is still $1,000,000 even
    // with two pre-retirement streams; the retired years net
    // $100,000 − $78,000 = $22,000 each, ending $912,000.
    expect(det.balances[4]).toBe(100_000_000);
    expect(Math.round(det.balances[det.balances.length - 1] ?? -1)).toBe(
      91_200_000,
    );
  });
});
