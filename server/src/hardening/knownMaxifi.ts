/* ---------------- MaxiFi-property known-answer pin ----------------
   Part 3 of the hardening block (known-answer checks). Wires
   the EXISTING "joint-maxifi-property" case from
   TAX_FIXTURES (taxFixtures.ts) into the hardening registry
   as a registered check. Nothing here duplicates the case
   or re-derives its expected values: the module finds the
   case by id in the exported TAX_FIXTURES array, invokes
   its actual() once, and compares expected vs actual with
   the suite's own rule, verbatim (runTaxFixtures: for each
   expected field, got = actual[field] ?? null, fail when
   got !== exp — exact equality, to the cent on the dollar
   figures).

   FINDING — NO MAXIFI-PUBLISHED DOLLAR FIGURE EXISTS IN
   THIS REPO. Grep for "MaxiFi" across server/src and
   client/src, in the pre-existing code (before this build),
   returns exactly three mentions, and none of
   them is a figure published by MaxiFi (the software) or
   any citation to a MaxiFi publication or output:
     · rothOptimizer.ts — a comment on the joint claiming
       search: "Separate optima are not joint optima (the
       MaxiFi point)".
     · taxFixtures.ts, the case's own note — the property
       statement plus its re-pin history.
     · taxFixtures.ts, a second case's note — a
       cross-reference ("per the MaxiFi pin").
   "MaxiFi" here names the APPROACH the property is
   compared against: MaxiFi optimizes claiming ages and
   Roth conversions SEPARATELY, so the best conversion
   strategy at the entered claim age and the best claiming
   age under Do Nothing are each a separate optimum. The
   case's dollar figures are engine-derived regression
   pins on the torpedo plan (born-1966 shape — the claim
   entered but not yet made, so the 62–70 space is
   searched), re-pinned as the engine changed; the case
   note records that history. This check therefore pins
   the joint-beats-separate PROPERTY as an
   external-benchmark-NAMED invariant — the joint winner
   beats both separate optima — not a published dollar
   figure. No MaxiFi figure is invented here.

   The property, as the case prices it: on the torpedo
   plan the joint search's winner (claiming at 62) nets
   less than the best conversion strategy at the entered
   claim age AND less than the best claiming age under Do
   Nothing, with the joint result's Do Nothing equal to
   the best Do Nothing found across claiming ages. The
   module reports the pin's own figures (joint net cost,
   claim age and annual benefit, fixed best, best Do
   Nothing claim, both beat-by margins) in its detail.

   RUNTIME, measured on this tree: one invocation costs
   ~6.5 s at steady state (~27 s for the first invocation
   in a fresh process). runFast and runFull each invoke
   the case once; runTeeth reuses ONE priced actual for
   both its clean and corrupted comparisons, so teeth
   costs one invocation. A full fast registry run
   therefore pays two invocations for this module. That
   is the honest cost of the pin — the accuracy
   self-check already pays it when it runs the tax
   fixtures — and the coordinator decides where it sits
   in the fast budget. Fast and full are identical: the
   pin is one case and there is nothing more to
   enumerate.

   A pin that fails against the engine is a FINDING; this
   module never adjusts a pin to make it pass. */

import { TAX_FIXTURES, type TaxFixtureCase } from "../taxFixtures";
import type {
  HardeningCheckModule,
  HardeningCheckResult,
  HardeningTeethResult,
} from "./types";

const CASE_ID = "joint-maxifi-property";

const CENT = 0.01;

type PinFailure = string;

// The suite's comparison rule, verbatim from
// runTaxFixtures: exact equality per expected field.
// `expectedOverride` lets teeth corrupt the expected side
// without touching the case; `actual` lets teeth reuse
// the clean run's priced values instead of re-pricing
// (one invocation of this case costs ~6.5 s).
function evaluate(
  c: TaxFixtureCase,
  expectedOverride?: Record<string, number | string | null>,
  actual?: Record<string, number | string | null>,
): { failures: PinFailure[]; actual: Record<string, number | string | null>; fields: number } {
  const failures: PinFailure[] = [];
  const expected = expectedOverride ?? c.expected;
  const got = actual ?? c.actual();
  for (const [field, exp] of Object.entries(expected)) {
    const value = got[field] ?? null;
    if (value !== exp) {
      failures.push(`${field}: expected ${exp}, got ${value}`);
    }
  }
  return { failures, actual: got, fields: Object.keys(expected).length };
}

function findCase(): TaxFixtureCase | undefined {
  return TAX_FIXTURES.find((c) => c.id === CASE_ID);
}

function runSet(): {
  failures: PinFailure[];
  counts: Record<string, number>;
  detail: string;
} {
  const c = findCase();
  if (!c) {
    return {
      failures: [`${CASE_ID}: case not found in TAX_FIXTURES`],
      counts: { fields: 0, failures: 1 },
      detail: `${CASE_ID}: case not found in TAX_FIXTURES.`,
    };
  }
  const { failures, actual, fields } = evaluate(c);
  const detail =
    `MaxiFi property (joint beats both separate optima): joint winner claims at ${actual.jointClaimAge} ` +
    `for $${actual.jointAnnual}/yr at net cost $${actual.jointNetCost}, beating the fixed-claim best ` +
    `($${actual.fixedBestNetCost}) by $${actual.jointBeatsFixedBy} and the best Do Nothing claim ` +
    `($${actual.bestDnClaimNetCost}) by $${actual.jointBeatsDnClaimBy}; joint Do Nothing is the best ` +
    `Do Nothing claim (${actual.jointDnIsBestDnClaim === 1 ? "yes" : "no"}); ${actual.combos} combinations tested, ` +
    `${fields} expected fields compared exactly.`;
  return { failures, counts: { fields, combos: Number(actual.combos ?? 0), failures: failures.length }, detail };
}

function resultFrom(
  id: string,
  name: string,
  set: { failures: PinFailure[]; counts: Record<string, number>; detail: string },
): HardeningCheckResult {
  const pass = set.failures.length === 0;
  return {
    id,
    name,
    pass,
    detail: pass ? set.detail : `${set.failures.length} MaxiFi-property field(s) failed — see failures.`,
    failures: set.failures.slice(0, 25),
    counts: set.counts,
  };
}

function runMaxifiFast(): HardeningCheckResult {
  return resultFrom(
    "known-maxifi",
    "Known-answer MaxiFi property: joint claiming + conversion optimum beats both separate optima",
    runSet(),
  );
}

function runMaxifiFull(): HardeningCheckResult {
  // Identical to fast: the pin is one case and there is
  // nothing more to enumerate.
  return resultFrom(
    "known-maxifi",
    "Known-answer MaxiFi property: joint claiming + conversion optimum beats both separate optima",
    runSet(),
  );
}

function runMaxifiTeeth(): HardeningTeethResult {
  // The clean run must pass first. Price the case ONCE
  // and compare both the clean and the corrupted
  // expectations against that one actual — re-pricing
  // for the corrupted leg would cost a second ~6.5 s
  // invocation for a comparison that needs none.
  const c = findCase();
  if (!c) {
    return { corruptedCaseId: "known-maxifi:case-missing", failedCount: 0, pass: false };
  }
  const actual = c.actual();
  const clean = evaluate(c, undefined, actual);
  if (clean.failures.length !== 0) {
    return {
      corruptedCaseId: "known-maxifi:clean-run-failed",
      failedCount: clean.failures.length,
      pass: false,
    };
  }
  // Corrupt one expected net cost by 1 cent: the joint
  // winner's net cost. Exactly that one field must fail.
  const corrupted = evaluate(
    c,
    { ...c.expected, jointNetCost: Number(c.expected.jointNetCost ?? 0) + CENT },
    actual,
  );
  return {
    corruptedCaseId: "joint-maxifi-property jointNetCost",
    failedCount: corrupted.failures.length,
    pass:
      corrupted.failures.length === 1 &&
      corrupted.failures[0]?.startsWith("jointNetCost:") === true,
  };
}

export const knownMaxifiCheck: HardeningCheckModule = {
  id: "known-maxifi",
  name: "Known-answer MaxiFi property: joint claiming + conversion optimum beats both separate optima",
  runFast: runMaxifiFast,
  runFull: runMaxifiFull,
  runTeeth: runMaxifiTeeth,
};
