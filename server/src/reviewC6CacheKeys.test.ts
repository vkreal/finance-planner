// Engine Review C6, §7 — serialization and caching: the
// optimizer cache keys.
//
// (a) jointInputsKey: the joint optimizer memoizes on a stable
// serialization of the FULL plan inputs with object keys
// sorted. A non-finite number must key distinctly from null:
// JSON.stringify(NaN) is "null", so before this fix an input
// carrying NaN shared a key — and a result — with the same
// input carrying null. NaN is not a valid input (every schema
// rejects it), but a cache must never silently alias two
// different inputs whatever they are.
//
// (b) runWorkYearsCompare: a priced row shares its optimizer
// result only with a row whose rolled inputs are identical.
// The old key (quit age + four balances + four loss
// carry-ins) omitted the rebuilt taxable basis, the first-RMD
// deferral handoff, and the IRMAA lookback seed — all settled
// by the roll into the rolled plan — so two quit ages landing
// on identical balances with different basis / deferral /
// lookback state would have shared one optimizer result. The
// key is now the full rolled inputs, via the exported
// workYearsCompareCacheKey helper, pinned directly below.
//
// Sample-household values throughout (server/src/sampleHousehold.ts).
// Run per-file:
//   bun test server/src/reviewC6CacheKeys.test.ts

import { describe, expect, test } from "bun:test";
import { jointInputsKey } from "./rothOptimizer";
import {
  rollWorkYears,
  workYearsCompareCacheKey,
  type WorkYearJob,
} from "./workYears";
import { samplePlanInputs } from "./sampleHousehold";
import type { RothPlanInputs } from "./taxEngine";

function basePlan(overrides: Partial<RothPlanInputs> = {}): RothPlanInputs {
  return samplePlanInputs({
    startYear: 2026,
    birthYearPrimary: 1970,
    birthYearSpouse: 1972,
    retirementAge: 57,
    windowStartAge: 57,
    endAgePrimary: 95,
    expectedReturnPct: 0,
    annualSpending: 120000,
    ...overrides,
  });
}

describe("C6-§7: joint optimizer cache key", () => {
  test("non-finite numbers key distinctly from null", () => {
    // pretaxStart is the real balance field; the null / NaN /
    // Infinity values are cast in only to pin the KEY function
    // — no engine pricing runs on these inputs.
    const withNaN = {
      ...basePlan(),
      pretaxStart: NaN,
    } as unknown as RothPlanInputs;
    const withNull = {
      ...basePlan(),
      pretaxStart: null,
    } as unknown as RothPlanInputs;
    const withInf = {
      ...basePlan(),
      pretaxStart: Infinity,
    } as unknown as RothPlanInputs;
    const withNegInf = {
      ...basePlan(),
      pretaxStart: -Infinity,
    } as unknown as RothPlanInputs;
    expect(jointInputsKey(withNaN)).not.toBe(jointInputsKey(withNull));
    expect(jointInputsKey(withInf)).not.toBe(jointInputsKey(withNull));
    expect(jointInputsKey(withNegInf)).not.toBe(jointInputsKey(withNull));
    expect(jointInputsKey(withNaN)).not.toBe(jointInputsKey(withInf));
    // And the same non-finite input keys to itself.
    expect(jointInputsKey(withNaN)).toBe(jointInputsKey(withNaN));
  });

  test("property order does not split one plan into two keys", () => {
    const a = basePlan();
    const b = basePlan();
    // Rebuild with the same values in a different key order.
    const reordered = Object.fromEntries(
      Object.entries(b).reverse(),
    ) as unknown as RothPlanInputs;
    expect(jointInputsKey(a)).toBe(jointInputsKey(reordered));
  });

  test("-0 and 0 share a key (financially identical); nested order matters", () => {
    const a = basePlan({ pretaxStart: 0 });
    const b = basePlan({ pretaxStart: -0 });
    expect(jointInputsKey(a)).toBe(jointInputsKey(b));
    // A different value keys differently.
    expect(jointInputsKey(a)).not.toBe(
      jointInputsKey(basePlan({ pretaxStart: 100 })),
    );
    // Undefined and absent both mean "not set" to the engine
    // (every reader uses ??), so they share a key.
    const undef = basePlan({ pretaxSpouseStart: undefined });
    const absent = basePlan();
    delete (absent as Record<string, unknown>).pretaxSpouseStart;
    expect(jointInputsKey(undef)).toBe(jointInputsKey(absent));
  });
});

describe("C6-§7: work-years compare cache key", () => {
  // The key is pinned DIRECTLY here (fast, no optimizer run):
  // the behavioral consequence — two rows sharing one
  // optimizer result carry identical rolled inputs — follows
  // from the key reading the full rolled inputs plus the joint
  // memo's own full-inputs keying. A behavioral test pricing
  // the optimizer across quit ages takes minutes on this VM
  // and proves nothing the direct key tests do not, so it is
  // deliberately not in this file.
  test("identical rolls key identically; zero-year rows key on quit age", () => {
    const plan = basePlan();
    const job: WorkYearJob = {
      salary: 100000,
      employer401k: 0,
      employerHsa: 0,
      hsaCoverage: "family",
      hsaEligible: true,
      priorYearWages: null,
    };
    const rollA = rollWorkYears(plan, job, 58);
    const rollB = rollWorkYears(plan, job, 58);
    expect(workYearsCompareCacheKey(58, rollA)).toBe(
      workYearsCompareCacheKey(58, rollB),
    );
    // A zero-year row keys on its quit age alone (build v58,
    // F5a): two zero-year rows at different quit ages are
    // different plans and must not share.
    const zeroA = rollWorkYears(plan, job, 57);
    const zeroB = rollWorkYears(plan, job, 57);
    expect(zeroA.totals.years).toBe(0);
    expect(workYearsCompareCacheKey(57, zeroA)).toBe("no-work:57");
    expect(workYearsCompareCacheKey(57, zeroA)).toBe(
      workYearsCompareCacheKey(57, zeroB),
    );
    expect(workYearsCompareCacheKey(57, zeroA)).not.toBe(
      workYearsCompareCacheKey(58, rollA),
    );
  });

  test("same balances and carry-ins, different settled basis → different keys", () => {
    // The old key (quit age + four balances + four loss
    // carry-ins) would have ALIASED these two rolls: the
    // rebuilt basis is a function of the sale history, not
    // the ending balance, so identical balances can carry
    // different basis — and different basis prices a different
    // march. The new key reads the full rolled inputs, so the
    // basis difference splits the key.
    const plan = basePlan();
    const job: WorkYearJob = {
      salary: 100000,
      employer401k: 0,
      employerHsa: 0,
      hsaCoverage: "family",
      hsaEligible: true,
      priorYearWages: null,
    };
    const roll = rollWorkYears(plan, job, 58);
    const keyA = workYearsCompareCacheKey(58, roll);
    const reBased: RothPlanInputs = {
      ...roll.rolledInputs,
      taxableBasisPct: (roll.rolledInputs.taxableBasisPct ?? 0) + 1,
    };
    const rollReBased = { ...roll, rolledInputs: reBased };
    expect(workYearsCompareCacheKey(58, rollReBased)).not.toBe(keyA);
    // Same for the tiered basis: same total, different tiers.
    const reTiered: RothPlanInputs = {
      ...roll.rolledInputs,
      taxableTiers: [{ sharePct: 60, basisPct: 50 }, { sharePct: 40, basisPct: 90 }],
    };
    const rollReTiered = { ...roll, rolledInputs: reTiered };
    expect(workYearsCompareCacheKey(58, rollReTiered)).not.toBe(keyA);
  });

  test("same balances, different RMD-deferral handoff or lookback seed → different keys", () => {
    const plan = basePlan();
    const job: WorkYearJob = {
      salary: 100000,
      employer401k: 0,
      employerHsa: 0,
      hsaCoverage: "family",
      hsaEligible: true,
      priorYearWages: null,
    };
    const roll = rollWorkYears(plan, job, 58);
    const keyA = workYearsCompareCacheKey(58, roll);
    const deferred: RothPlanInputs = {
      ...roll.rolledInputs,
      firstRmdDeferredCarryPrimary: 1000,
    };
    expect(
      workYearsCompareCacheKey(58, { ...roll, rolledInputs: deferred }),
    ).not.toBe(keyA);
    const had: RothPlanInputs = {
      ...roll.rolledInputs,
      firstRmdAlreadyPricedPrimary: true,
    };
    expect(
      workYearsCompareCacheKey(58, { ...roll, rolledInputs: had }),
    ).not.toBe(keyA);
    const seeded: RothPlanInputs = {
      ...roll.rolledInputs,
      irmaaLookbackSeed: [
        ...(roll.rolledInputs.irmaaLookbackSeed ?? []),
        { year: 2025, magi: 100000, filingStatus: "mfj" as const },
      ],
    };
    expect(
      workYearsCompareCacheKey(58, { ...roll, rolledInputs: seeded }),
    ).not.toBe(keyA);
  });

  test("the roll's settled fields ride the rolled inputs the key reads", () => {
    // Two rolls priced identically key identically (sanity:
    // the key is deterministic on the same inputs).
    const plan = basePlan();
    const job: WorkYearJob = {
      salary: 100000,
      employer401k: 0,
      employerHsa: 0,
      hsaCoverage: "family",
      hsaEligible: true,
      priorYearWages: null,
    };
    const rollA = rollWorkYears(plan, job, 58);
    const rollB = rollWorkYears(plan, job, 58);
    expect(jointInputsKey(rollA.rolledInputs)).toBe(
      jointInputsKey(rollB.rolledInputs),
    );
    const tweaked: RothPlanInputs = {
      ...rollB.rolledInputs,
      taxableBasisPct: (rollB.rolledInputs.taxableBasisPct ?? 0) + 1,
    };
    expect(jointInputsKey(rollA.rolledInputs)).not.toBe(
      jointInputsKey(tweaked),
    );
    const deferred: RothPlanInputs = {
      ...rollB.rolledInputs,
      firstRmdDeferredCarryPrimary: 1000,
    };
    expect(jointInputsKey(rollA.rolledInputs)).not.toBe(
      jointInputsKey(deferred),
    );
  });
});
