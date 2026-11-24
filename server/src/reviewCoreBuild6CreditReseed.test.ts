// Engine Review core 2026-11-21, Build 6 — S-3 credit re-seed on the
// non-converged branch.
//
// S-3: `settleYear`'s credit re-seed ran only when the first credit
// iteration converged to exactly $0; a non-converged first run
// (cliff-edge alternation) never re-seeded from the cliff credit, so
// a credit-keeping exact fixed point discoverable by that seed was
// never attempted in that branch. The fix attempts the re-seed on
// the non-converged branch too, when the kept settlement's own ACA
// residual is above $0 (the credit iteration itself did not
// converge), and keeps it ONLY if it converges exactly to a credit
// above $0.
//
// Fixture: the FICTIONAL sample household
// (server/src/sampleHousehold.ts — every figure here is invented,
// none describes any real household). Every pinned figure below is
// the engine's own output on the stated shape, verified by execution
// before pinning.
//
// PROBE NOTE (hunt-s3.ts): the hunt's first labels carried only the
// draw order's first leg, so the two roth-first orders printed the
// same label ("roth") — the 1¢-residual rows belong to roth/PRETAX/
// taxable, not roth/taxable/pretax. The hunt now labels the full
// order; the canonical logs are hunt-s3-before-labeled.log /
// hunt-s3-after-labeled.log (1,152 marches). The four rescued years
// are all 150000 / roth-pretax-taxable / DN / tax$2M / derived,
// 2032, one per household schedule (nostep + step 2033/2036/2040).

import { describe, expect, test } from "bun:test";
import { NO_CEILINGS, simulateRothPlan } from "./taxEngine";
import { samplePlanInputs } from "./sampleHousehold";

const DN = { id: "none", name: "Do Nothing", ceilings: null } as never;
const HEALTH = {
  healthPremiumAcaHousehold: 36000,
  healthPremiumAcaSingle: 17500,
  healthPremiumMedicarePerPerson: 2902.68,
} as const;
const ROTH_TAXABLE_PRETAX = ["roth", "taxable", "pretax"] as const;
const ROTH_PRETAX_TAXABLE = ["roth", "pretax", "taxable"] as const;
const TAXABLE_PRETAX_ROTH = ["taxable", "pretax", "roth"] as const;

describe("Build 6 — S-3: the non-converged branch re-seeds from the cliff credit", () => {
  test("a 1¢ iteration-limit year converges under the re-seed (rescue)", () => {
    // 150000 / roth-pretax-taxable / DN / tax$2M / derived, nostep.
    // PRE-fix the year ran 8 passes, hit the iteration limit, and
    // kept the closest settlement: credit $34,540.49, ACA residual
    // 1¢, MAGI $44,598.31. The first-run seed is $0 by construction
    // — a health-term year: the term amounts enter, so the
    // reconcile path is off and the seed is 0 — and the $0-seeded
    // walk misses the exact fixed point; the re-seed seed is THIS
    // year's cliff credit, and its walk lands the same credit as an
    // exact fixed point — 1¢ away on MAGI. Post-fix the year
    // converges in 8 passes with the identical kept credit and a
    // zero residual. The next year is untouched (no knock-on).
    const res = simulateRothPlan(
      samplePlanInputs({
        annualSpending: 150000,
        taxableStart: 2000000,
        drawOrder: [...ROTH_PRETAX_TAXABLE] as never,
        ...HEALTH,
      }),
      DN,
    );
    const y32 = res.years.find((y) => y.year === 2032)!;
    expect(y32.settlementConverged).toBe(true);
    expect(y32.settlementStopReason).toBe("converged");
    expect(y32.settlementInnerStopReason).toBe("converged");
    expect(y32.settlementPasses).toBe(8);
    expect(y32.acaCreditKept).toBe(34540.49);
    expect(y32.acaMagi).toBe(44598.3);
    expect(y32.settlementMismatchCents).toEqual({
      gains: 0,
      pretax: 0,
      roth: 0,
      hsa: 0,
      acaCredit: 0,
    });
    const y33 = res.years.find((y) => y.year === 2033)!;
    expect(y33.settlementConverged).toBe(true);
    expect(y33.acaCreditKept).toBe(0);
    expect(y33.acaMagi).toBe(214390.61);
  });

  test("the C3-S1 alternating year is unchanged (re-seed correctly declines)", () => {
    // 150000 / roth-taxable-pretax / DN / tax$2M / entered, nostep.
    // The Pass 2 seed sweep proved no seed in [0, benchmark]
    // converges here — the 2-cycle is genuine and seed-independent
    // — so the re-seed attempt runs and keeps the closest settlement
    // exactly as before: kept $0, residual 2,285,280¢.
    const res = simulateRothPlan(
      samplePlanInputs({
        annualSpending: 150000,
        taxableStart: 2000000,
        drawOrder: [...ROTH_TAXABLE_PRETAX] as never,
        acaEmbeddedNetPremium: 13147.2,
      }),
      DN,
    );
    const y32 = res.years.find((y) => y.year === 2032)!;
    expect(y32.settlementConverged).toBe(false);
    expect(y32.settlementStopReason).toBe("repeated-assumption");
    expect(y32.settlementPasses).toBe(3);
    expect(y32.acaCreditKept).toBe(0);
    expect(y32.acaMagi).toBe(28812.05);
    expect(y32.settlementMismatchCents.acaCredit).toBe(2285280);
  });

  test("a genuine 2-cycle is unchanged (re-seed correctly declines)", () => {
    // 150000 / roth-pretax-taxable / DN / tax$500k / derived, nostep.
    // The kept settlement was priced under assumed $0 (residual
    // equals the kept credit, $32,774.17) and alternates in 2
    // passes; the cliff-credit seed finds no fixed point either, so
    // the year keeps its closest settlement exactly as before.
    const res = simulateRothPlan(
      samplePlanInputs({
        annualSpending: 150000,
        taxableStart: 500000,
        drawOrder: [...ROTH_PRETAX_TAXABLE] as never,
        ...HEALTH,
      }),
      DN,
    );
    const y32 = res.years.find((y) => y.year === 2032)!;
    expect(y32.settlementConverged).toBe(false);
    expect(y32.settlementStopReason).toBe("repeated-assumption");
    expect(y32.settlementPasses).toBe(2);
    expect(y32.acaCreditKept).toBe(32774.17);
    expect(y32.acaMagi).toBe(58540.32);
    expect(y32.settlementMismatchCents.acaCredit).toBe(3277417);
  });

  test("a residual-0 year settles on the converged branch (never reaches the re-seed)", () => {
    // The 2034 inner-alternation year (C9 Build 5 pin): the INNER
    // settlement iteration alternates on a 1¢ pretax residual while
    // the CREDIT iteration converged exactly (ACA residual 0¢), so
    // the year returns via the converged branch — the C9 Build 5
    // re-seed produced its credit — and never reaches this build's
    // non-converged re-seed block. It is untouched because the
    // branch structure routes it, not because the residual > $0
    // gate holds it: with cent-quantized inputs the gate is
    // always-true on the non-converged branch, a defensive pin
    // for a sub-cent edge only.
    const res = simulateRothPlan(
      {
        ...samplePlanInputs({
          annualSpending: 120000,
          taxableStart: 500000,
          ...HEALTH,
        }),
        drawOrder: [...TAXABLE_PRETAX_ROTH] as never,
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
  });

  test("a post-step-down large-residual year is unchanged", () => {
    // 120000 / roth-taxable-pretax / DN / tax$500k / entered, step
    // 2033. The one roth-taxable-pretax row outside the C3-S1 year:
    // a post-step-down 2033 alternation the re-seed also declines.
    const res = simulateRothPlan(
      samplePlanInputs({
        annualSpending: 120000,
        taxableStart: 500000,
        drawOrder: [...ROTH_TAXABLE_PRETAX] as never,
        acaEmbeddedNetPremium: 13147.2,
        acaHouseholdSchedule: [
          { fromYear: 2026, householdSize: 4 },
          { fromYear: 2033, householdSize: 2 },
        ],
      }),
      DN,
    );
    const y33 = res.years.find((y) => y.year === 2033)!;
    expect(y33.settlementConverged).toBe(false);
    expect(y33.settlementStopReason).toBe("repeated-assumption");
    expect(y33.settlementPasses).toBe(4);
    expect(y33.acaCreditKept).toBe(17018.78);
    expect(y33.acaMagi).toBe(22915.25);
    expect(y33.settlementMismatchCents.acaCredit).toBe(1266598);
  });
});
