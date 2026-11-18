// Engine Review C9, Build 5 — cliff-cap undershoot (W5-B1).
//
// W5-B1: a cliff-capped, taxable-first candidate year landed $6–7K
// UNDER its own cliff−buffer target whenever the v208
// health-premium term was on and both spouses were on ACA
// (fictional sample household, capped fill-aca, $5,000 buffer,
// target $127,000: 2030 ACA MAGI $120,709.15 / conversion
// $4,659.33; 2031 $120,349.36 / $2,449.98; 2032 $120,006.51 /
// $436.42). The term-off shape landed exactly on target, and
// spouse-only years landed on target even with the term on.
//
// Root cause (proven by instrumentation, not the audit's
// hypothesis): the credit fixed-point map in `settleYear` has
// TWO exact fixed points in this shape. Funding the full gross
// premium (assumed credit $0) pushes MAGI over the cliff, so
// the priced credit is $0 — the $0 state is self-consistent.
// Funding the net premium keeps MAGI under the cliff, so the
// priced credit equals the assumed credit — the credit-keeping
// state is equally self-consistent. The iteration starts at
// assumed $0, so the moment the $0-funded settlement's MAGI
// crosses the cliff (one cent of conversion: feasible at
// $4,659.33 / MAGI $120,709.15, $132,000.01 at $4,659.34) the
// loop returns the $0 state on its first pass, never
// discovering the credit-keeping state at the same conversion.
// The cliff-cap grow-back then bisects on the $0 state's
// MAGI, which jumps over the target a cent past the crossing,
// so the search keeps the shrunken fill.
//
// The fix (taxEngine.ts, `settleYear`): when the first credit
// iteration converges to the $0 state, re-run it once from
// the credit priced at the cliff itself, and keep the
// re-seeded settlement ONLY if it converges exactly to a
// credit above $0. In a genuinely over-cliff year no such
// state exists — the re-seed converges back to $0 (or not at
// all) and the year keeps the $0 settlement exactly as before.
// The re-seed never displaces an exact non-$0 fixed point
// and never displaces an exact fixed point with an
// unconverged one.
//
// The audit's §5 sentence "the pretax-first and roth-first
// orders do not hit it" is wrong for pretax-first on the
// audit's own evidence: its probeA.log shows capped
// pretax-first 2030 at MAGI $120,709, conversion $0, pre-tax
// draw $8,762 — the same under-fill, with the capped draw as
// the filler instead of the conversion (the M-1 draw-cap
// bisection calls the same `settleYear`). Roth-first truly
// does not hit it (2030 $127,000 / $97,013 on the same log).
// The fix is in the shared driver, so it covers the
// pretax-first shape too.
//
// Fixture: the FICTIONAL sample household
// (server/src/sampleHousehold.ts — every figure here is
// invented, none describes any real household). Every pinned
// figure below is the engine's own output on the stated shape,
// verified by execution before pinning — never copied from a
// plan the app actually serves.

import { describe, expect, test } from "bun:test";
import {
  NO_CEILINGS,
  acaCreditFor,
  simulateRothPlan,
  type DrawOrder,
} from "./taxEngine";
import {
  assessCandidateIntegrity,
  planNetCost,
  runRothCompare,
} from "./rothOptimizer";
import { samplePlanInputs } from "./sampleHousehold";
import {
  FILL_CLIFF_CEILINGS,
  sampleCompareBase,
} from "./hardening/sensCompareBase";

const CAPPED_FILL_ACA = {
  id: "fill-aca",
  name: "Fill capped at ACA cliff",
  ceilings: { ...NO_CEILINGS, acaCliffCap: true, acaCliffBuffer: 5000 },
} as never;
const FILL_22 = {
  id: "fill22",
  name: "Fill 22%",
  ceilings: { ...NO_CEILINGS, bracketTopPct: 22 },
} as never;
const DO_NOTHING = { id: "none", name: "Do Nothing", ceilings: null } as never;

// v208 health-premium term on, using the sample household's own
// benchmarks: household $36,000/yr, single $17,500/yr, Medicare
// base $2,902.68/yr/person.
const health = samplePlanInputs({
  healthPremiumAcaHousehold: 36000,
  healthPremiumAcaSingle: 17500,
  healthPremiumMedicarePerPerson: 2902.68,
});
const taxFirst: DrawOrder = ["taxable", "pretax", "roth"];
const pretaxFirst: DrawOrder = ["pretax", "taxable", "roth"];
const rothTaxablePretax: DrawOrder = ["roth", "taxable", "pretax"];

function acaYears(res: ReturnType<typeof simulateRothPlan>) {
  return res.years.filter((y) => y.acaActive);
}

describe("C9 Build 5 — W5-B1: capped tax-first lands on the cliff with the term on", () => {
  test("2030–2032 land exactly on the $127,000 target", () => {
    const res = simulateRothPlan(
      { ...health, drawOrder: taxFirst },
      CAPPED_FILL_ACA,
    );
    const years = acaYears(res);
    // The recovered fill: conversion $10,656.78 / $8,788.70 /
    // $7,100.63 (was $4,659.33 / $2,449.98 / $436.42) — the
    // stranded ~$19,000 of conversion is back in Roth.
    expect(years[0]!.acaMagi).toBe(127000);
    expect(years[0]!.conversion).toBe(10656.78);
    expect(years[1]!.acaMagi).toBe(127000);
    expect(years[1]!.conversion).toBe(8788.7);
    expect(years[2]!.acaMagi).toBe(127000);
    expect(years[2]!.conversion).toBe(7100.63);
    // Spouse-only years were already on target; their
    // conversions move only by the carried-balance knock-on
    // of the recovered 2030–2032 conversions.
    expect(years[3]!.acaMagi).toBe(127000);
    expect(years[3]!.conversion).toBe(4112.33);
    expect(years[4]!.acaMagi).toBe(127000);
    expect(years[4]!.conversion).toBe(2775.1);
    // The credit is LOWER than the under-filled run's
    // ($23,977.37 / $24,013.20 / $24,047.35): MAGI at the
    // target prices the smaller credit — the defect
    // overstated the credit, it did not lose it.
    for (const y of years.slice(0, 3)) {
      expect(y.acaCreditKept).toBe(23350.8);
      expect(y.healthPremiumNet).toBe(12649.2);
      // The kept settlement is the re-seeded exact fixed
      // point (5 passes from the cliff-credit seed), not
      // the 1-pass degenerate $0 return.
      expect(y.settlementConverged).toBe(true);
      expect(y.settlementPasses).toBe(5);
      expect(y.settlementStopReason).toBe("converged");
      expect(y.settlementMismatchCents.acaCredit).toBe(0);
    }
    expect(res.lifetimeAcaKept).toBe(79754);
    // Re-pinned under Engine Review C2 (2026-11-18): the integer-cents
    // walk moves this net cost 4¢.
    expect(planNetCost(res, health).netCost).toBe(1940765.74);
    // RE-PINNED (Engine Review C2, 2026-11-18): the integer-cents
    // walk moves the tax +4¢ and the wealth −5¢.
    expect(planNetCost(res, health).tax).toBe(1082521.42);
    expect(res.endingAfterTaxWealth).toBe(10924009.84);
    // The shape now carries a benign residual: year 2042 cycles
    // on a 1¢ gains tie under the integer-cents walk (the
    // settlement flip moved a non-convergence into this shape).
    const i1 = assessCandidateIntegrity(res);
    expect(i1.status).toBe("valid-with-benign-residual");
    expect(i1.nonConvergedYearList).toEqual([2042]);
    expect(i1.maxMismatchGainsCents).toBe(1);
    expect(i1.maxMismatchPretaxCents).toBe(0);
  });

  test("pretax-first: the same under-fill, filled by the capped draw", () => {
    const res = simulateRothPlan(
      { ...health, drawOrder: pretaxFirst },
      CAPPED_FILL_ACA,
    );
    const years = acaYears(res);
    // Was MAGI $120,709.15 / $120,348.26 / $120,004.78 with
    // conversion $0 and pre-tax draws $8,762.41 / $4,525.09 /
    // $529.26 — the audit's "pretax-first does not hit it"
    // is contradicted by its own probeA.log.
    for (const y of years.slice(0, 3)) {
      expect(y.acaMagi).toBe(127000);
      expect(y.conversion).toBe(0);
      expect(y.acaCreditKept).toBe(23350.8);
      expect(y.settlementConverged).toBe(true);
      expect(y.settlementMismatchCents.acaCredit).toBe(0);
    }
    expect(years[0]!.funding.pretaxDraw).toBe(20041.33);
    expect(years[1]!.funding.pretaxDraw).toBe(16511.05);
    expect(years[2]!.funding.pretaxDraw).toBe(13179.84);
    expect(res.lifetimeAcaKept).toBe(79754);
    // Re-pinned under Engine Review C2 (2026-11-18): the integer-cents
    // walk moves this net cost 1¢. Re-pinned again in C2 round 2:
    // the preferential staircase moves it −2¢.
    expect(planNetCost(res, health).netCost).toBe(1611574.01);
    // The shape now carries a benign residual: year 2047 cycles
    // on a 1¢ gains tie under the preferential staircase (the
    // round-2 settlement flip moved the non-convergence from
    // 2045 to 2047).
    const i2 = assessCandidateIntegrity(res);
    expect(i2.status).toBe("valid-with-benign-residual");
    expect(i2.nonConvergedYearList).toEqual([2047]);
    expect(i2.maxMismatchGainsCents).toBe(1);
    expect(i2.maxMismatchPretaxCents).toBe(0);
  });

  test("roth-first and the term-off shapes are bit-identical", () => {
    // Roth-first never hit the defect (no taxable-gain
    // feedback for the grow-back to fight): 2030 was already
    // $127,000 / $97,013 on the audit's base.
    const roth = simulateRothPlan(
      { ...health, drawOrder: rothTaxablePretax },
      CAPPED_FILL_ACA,
    );
    expect(acaYears(roth)[0]!.acaMagi).toBe(127000);
    expect(acaYears(roth)[0]!.conversion).toBe(97013);
    // Re-pinned under Engine Review C2 (2026-11-18): the integer-cents
    // walk moves this net cost 5¢.
    expect(planNetCost(roth, health).netCost).toBe(1772232.85);
    // Term off (no v208 term, no embedded premium): the
    // fast path runs, the driver change cannot engage.
    const plain = samplePlanInputs();
    const d2 = simulateRothPlan(
      { ...plain, drawOrder: taxFirst },
      CAPPED_FILL_ACA,
    );
    expect(acaYears(d2)[0]!.acaMagi).toBe(127000);
    expect(acaYears(d2)[0]!.conversion).toBe(16579.89);
    expect(acaYears(d2)[1]!.conversion).toBe(14737.43);
    expect(acaYears(d2)[2]!.conversion).toBe(13058.02);
    // v135 embedded-premium reconciliation only: seeded
    // from the embedded credit, it never took the $0 path.
    const creditAtCliff = acaCreditFor({
      magi: 132000,
      householdSize: 4,
      coverageYear: 2030,
      benchmarkAnnual: 36000,
      projected: true,
    }).credit;
    const d1 = simulateRothPlan(
      {
        ...samplePlanInputs({ acaEmbeddedNetPremium: 36000 - creditAtCliff }),
        drawOrder: taxFirst,
      },
      CAPPED_FILL_ACA,
    );
    expect(acaYears(d1)[0]!.acaMagi).toBe(127000);
    expect(acaYears(d1)[0]!.conversion).toBe(16813.08);
  });
});

describe("C9 Build 5 — W5-B1: the same defect in an uncapped year", () => {
  test("Do Nothing roth-first 2034 keeps the credit it is owed", () => {
    // Was MAGI $133,041.83 with credit $0 — the $0-funded
    // settlement landed a cent over the cliff while a
    // credit-keeping fixed point existed at MAGI $130,672.50.
    const res = simulateRothPlan(
      { ...health, drawOrder: rothTaxablePretax },
      DO_NOTHING,
    );
    const y34 = acaYears(res).find((y) => y.year === 2034)!;
    expect(y34.acaMagi).toBe(130672.5);
    expect(y34.acaCreditKept).toBe(4485.02);
    expect(y34.healthPremiumNet).toBe(15917.66);
    expect(y34.settlementConverged).toBe(true);
    expect(y34.settlementMismatchCents.acaCredit).toBe(0);
    expect(res.lifetimeAcaKept).toBe(37466.47);
    // Re-pinned under Engine Review C2 (2026-11-18): the integer-cents
    // walk moves this net cost 3¢. Re-pinned again in C2 round 2:
    // the preferential staircase moves it +2¢.
    expect(planNetCost(res, health).netCost).toBe(2103084.93);
    // Re-pinned again in C2 round 2: the preferential staircase
    // moves a 1¢ gains tie into this shape — year 2043 cycles
    // (4 rounds, repeated-assumption), so it now carries a
    // benign residual instead of converging cleanly.
    const i3 = assessCandidateIntegrity(res);
    expect(i3.status).toBe("valid-with-benign-residual");
    expect(i3.nonConvergedYearList).toEqual([2043]);
    expect(i3.maxMismatchGainsCents).toBe(1);
    expect(i3.maxMismatchPretaxCents).toBe(0);
  });

  test("a genuinely over-cliff year still keeps $0 credit", () => {
    // Fill 22% taxable-first converts ~$88K in 2030: no
    // credit-keeping fixed point exists, the re-seed
    // converges back to $0, and the year prices bit-identically.
    const res = simulateRothPlan(
      { ...health, drawOrder: taxFirst },
      FILL_22,
    );
    const y30 = acaYears(res).find((y) => y.year === 2030)!;
    expect(y30.acaMagi).toBe(225691.07);
    expect(y30.conversion).toBe(88400);
    expect(y30.acaCreditKept).toBe(0);
    expect(res.lifetimeAcaKept).toBe(0);
    // Re-pinned under Engine Review C2 (2026-11-18): the integer-cents
    // walk moves this net cost 4¢. Re-pinned again in C2 round 2:
    // the preferential staircase moves it −3¢.
    expect(planNetCost(res, health).netCost).toBe(1572486.02);
  });
});

describe("C9 Build 5 — 2043 MAGI jump: the primary's RMD starts at 75", () => {
  test("young-spouse C6: 2043 jumps on the RMD, not a bucket exhaustion", () => {
    const young = samplePlanInputs({
      birthYearSpouse: 1979,
      healthPremiumAcaHousehold: 36000,
      healthPremiumAcaSingle: 17500,
      healthPremiumMedicarePerPerson: 2902.68,
    });
    const res = simulateRothPlan(
      { ...young, drawOrder: taxFirst },
      CAPPED_FILL_ACA,
    );
    const y42 = res.years.find((y) => y.year === 2042)!;
    const y43 = res.years.find((y) => y.year === 2043)!;
    // Primary born 1968: SECURE 2.0 RMD age is 75, so the
    // RMD starts in 2043 — the last spouse-only ACA year.
    expect(y42.funding.rmd).toBe(0);
    expect(y43.funding.rmd).toBe(133557.36);
    expect(y42.acaMagi).toBe(157200.63);
    expect(y43.acaMagi).toBe(225119.89);
    // The RMD displaces taxable sales, so the gains fall:
    // $133,557.36 RMD − $64,655.68 gains − $68.54 interest
    // − $685.41 qualified dividends − $228.47 ordinary
    // dividends = +$67,919.26 of MAGI, to the cent.
    expect(y42.funding.taxableSoldForSpending).toBe(152402.68);
    expect(y43.funding.taxableSoldForSpending).toBe(18845.32);
    expect(y43.detail.drawGains).toBe(28940.87);
    expect(y42.detail.drawGains).toBe(93596.55);
    expect(y43.federalTax).toBe(28834.81);
  });
});

describe("C9 Build 5 NICEs — cliffCapInoperativeYears summary flag (W5 §3/§6)", () => {
  const INOPERATIVE = [2035, 2036, 2037, 2038, 2039, 2040, 2041, 2042, 2043];
  const youngHealth = samplePlanInputs({
    birthYearSpouse: 1979,
    ssSpouseStartAge: 67,
    healthPremiumAcaHousehold: 36000,
    healthPremiumAcaSingle: 17500,
    healthPremiumMedicarePerPerson: 2902.68,
  });

  test("young-spouse shape: the nine $0-credit years are listed, defended years are not", () => {
    // Audit C6: 14 ACA years, 9 at $0 credit (2035–2043) —
    // Social Security starts at 67 in 2035, and mandatory
    // income alone breaches the cliff even at $0 conversion
    // and $0 pre-tax draw. 2030–2034 land on target.
    const res = simulateRothPlan(
      { ...youngHealth, drawOrder: taxFirst },
      CAPPED_FILL_ACA,
    );
    expect(res.cliffCapInoperativeYears).toEqual(INOPERATIVE);
    const y35 = res.years.find((y) => y.year === 2035)!;
    expect(y35.acaMagi).toBe(152095.88);
    expect(y35.conversion).toBe(0);
    expect(y35.funding.pretaxDraw).toBe(0);
    expect(y35.acaCreditKept).toBe(0);
    expect(y35.ceilingBreached).toBe(true);
    const y34 = res.years.find((y) => y.year === 2034)!;
    expect(y34.acaMagi).toBe(127000);
    expect(y34.conversion).toBe(2775.1);
    expect(y34.acaCreditKept).toBe(4850.8);
  });

  test("empty when the cap defends every ACA year, and when the cap is off", () => {
    // Base shape (spouse born 1970): all five ACA years land
    // on target, so the flag is empty.
    const defended = simulateRothPlan(
      { ...health, drawOrder: taxFirst },
      CAPPED_FILL_ACA,
    );
    expect(defended.cliffCapInoperativeYears).toEqual([]);
    // Same young-spouse shape uncapped: the cap is off, so no
    // year is ever inoperative — the flag keys on the cap.
    const uncapped = simulateRothPlan(
      { ...youngHealth, drawOrder: taxFirst },
      DO_NOTHING,
    );
    expect(uncapped.cliffCapInoperativeYears).toEqual([]);
  });

  test("the flag flows through runRothCompare", () => {
    // Compare base carries no health-premium term, so this
    // leg prices term-off — the same nine years (the
    // taxable-led default draw order).
    const base = {
      ...sampleCompareBase(),
      birthYearSpouse: 1979,
      ssSpouseStartAge: 67,
    };
    const cmp = runRothCompare(
      base as never,
      [
        { name: "Do Nothing", overrides: {} },
        { name: "Fill ACA", overrides: { ceilings: FILL_CLIFF_CEILINGS } },
      ],
      2026,
    );
    expect(cmp.ok).toBe(true);
    expect(cmp.scenarios[0]!.cliffCapInoperativeYears).toEqual([]);
    expect(cmp.scenarios[1]!.cliffCapInoperativeYears).toEqual(INOPERATIVE);
  });
});

describe("C9 Build 5 NICEs — alternation fallback (re-seed scope)", () => {
  test("an alternating year keeps its credit-keeping settlement, not $0", () => {
    // Closest reachable alternating shape WITHOUT the credit
    // collapsing to $0 (term on, spending $120,000, taxable
    // $500,000, no buffer, tax-first): 2034's INNER settlement
    // iteration alternates on a 1¢ pretax residual
    // (repeated-assumption), so the year keeps its closest
    // settlement and reports unconverged — while the CREDIT
    // iteration itself converged exactly (outer stop
    // "converged", ACA residual 0¢) and the year keeps its
    // $4,352.80 credit. The re-seed rescue is what produced
    // that credit: the first run converged to the $0 state in
    // one pass and the re-seed from the credit priced at the
    // cliff converged in one pass, because the credit is flat
    // to the cent across the 1¢ MAGI step at the cliff
    // ($4,352.80 at $132,000.00 and at $131,999.99 alike).
    // No credit-iteration alternation into a $0 closest
    // settlement was reached in the batch's sweeps (see the
    // batch report), so the re-seed is not extended on
    // speculation — this test pins the fallback as it behaves.
    const res = simulateRothPlan(
      {
        ...samplePlanInputs({
          annualSpending: 120000,
          taxableStart: 500000,
          healthPremiumAcaHousehold: 36000,
          healthPremiumAcaSingle: 17500,
          healthPremiumMedicarePerPerson: 2902.68,
        }),
        drawOrder: taxFirst,
      },
      {
        id: "fill-aca",
        name: "Fill capped at ACA cliff",
        ceilings: { ...NO_CEILINGS, acaCliffCap: true, acaCliffBuffer: 0 },
      } as never,
    );
    const y34 = res.years.find((y) => y.year === 2034)!;
    expect(y34.acaMagi).toBe(131999.99);
    expect(y34.acaCreditKept).toBe(4352.8);
    expect(y34.conversion).toBe(49950.18);
    expect(y34.settlementConverged).toBe(false);
    expect(y34.settlementStopReason).toBe("converged");
    expect(y34.settlementInnerStopReason).toBe("repeated-assumption");
    expect(y34.settlementPasses).toBe(1);
    expect(y34.settlementMismatchCents).toEqual({
      gains: 0,
      pretax: 1,
      roth: 0,
      hsa: 0,
      acaCredit: 0,
    });
    // The other ACA years converge cleanly.
    for (const y of acaYears(res).filter((y) => y.year < 2034)) {
      expect(y.settlementConverged).toBe(true);
    }
  });

  test("a post-ACA year that used to alternate now converges under the integer-cents walk (Engine Review C2); no credit iteration runs", () => {
    // Young-spouse C6, 2044 (first post-ACA year): the year used to
    // alternate on the known 1¢ gains knife-edge, keeping its closest
    // settlement and reporting unconverged with stop
    // repeated-assumption; the integer-cents walk prices the tie
    // exactly, so it now converges. No credit iteration runs in a
    // non-ACA year (fast path), so the re-seed cannot engage here —
    // the fallback is the whole behavior, pinned by the kept figures.
    const res = simulateRothPlan(
      {
        ...samplePlanInputs({
          birthYearSpouse: 1979,
          ssSpouseStartAge: 67,
          healthPremiumAcaHousehold: 36000,
          healthPremiumAcaSingle: 17500,
          healthPremiumMedicarePerPerson: 2902.68,
        }),
        drawOrder: taxFirst,
      },
      CAPPED_FILL_ACA,
    );
    const y44 = res.years.find((y) => y.year === 2044)!;
    expect(y44.acaActive).toBe(false);
    // Re-pinned under Engine Review C2 (2026-11-18): the integer-cents
    // walk moves this year's MAGI 1¢.
    expect(y44.acaMagi).toBe(218164.95);
    expect(y44.conversion).toBe(0);
    expect(y44.funding.pretaxDraw).toBe(0);
    // The year used to alternate on a 1¢ gains tie and keep its
    // closest settlement; the integer-cents walk prices the tie
    // exactly, so it now converges in 5 rounds with zero
    // mismatch — and its federal tax moves 1¢ with the MAGI.
    expect(y44.settlementConverged).toBe(true);
    expect(y44.settlementStopReason).toBe("converged");
    expect(y44.settlementInnerStopReason).toBe("converged");
    expect(y44.settlementPasses).toBe(1);
    expect(y44.settlementRounds).toBe(5);
    expect(y44.settlementMismatchCents).toEqual({
      gains: 0,
      pretax: 0,
      roth: 0,
      hsa: 0,
      acaCredit: 0,
    });
    expect(y44.federalTax).toBe(27363.67);
  });
});
