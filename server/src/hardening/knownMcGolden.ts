/* ---------------- Monte Carlo golden-shocks known-answer pin ----------------
   Part 3 of the hardening block (known-answer checks). Wires
   the EXISTING "mc-stats-golden-shocks" case from
   TAX_FIXTURES (taxFixtures.ts) into the hardening registry
   as a registered check. Nothing here duplicates the case
   or re-derives its expected values: the module finds the
   case by id in the exported TAX_FIXTURES array, invokes
   its actual() once, and compares expected vs actual with
   the suite's own rule, verbatim (runTaxFixtures: for each
   expected field, got = actual[field] ?? null, fail when
   got !== exp — exact equality, no tolerance of its own).

   The pin: the Monte Carlo stream's first shocks are
   LITERALS computed externally — an independent replication
   of the seeded generator + Box–Muller, cross-checked
   against the external reviewer's published values, never
   derived by calling this implementation's helpers (see the
   case's note). The case draws two consecutive
   fixed-stride series and compares the first shocks of
   each against those literals at tolerance 1e-9, reporting
   the largest difference in nanounits (expected 0 — the
   shipped stream reproduces the literals exactly). The
   literals themselves live only in the case; this module
   copies none of them — its teeth corruption flips a
   character of the case's own expected string, derived
   from the case at runtime.

   Runtime: ~2 ms per invocation — cheap enough for the
   fast run. Fast and full are identical: the pin is one
   case and there is nothing more to enumerate.

   A pin that fails against the engine is a FINDING; this
   module never adjusts a pin to make it pass. */

import { TAX_FIXTURES, type TaxFixtureCase } from "../taxFixtures";
import type {
  HardeningCheckModule,
  HardeningCheckResult,
  HardeningTeethResult,
} from "./types";

const CASE_ID = "mc-stats-golden-shocks";

type PinFailure = string;

function findCase(): TaxFixtureCase | undefined {
  return TAX_FIXTURES.find((c) => c.id === CASE_ID);
}

// The suite's comparison rule, verbatim from
// runTaxFixtures: exact equality per expected field.
// `expectedOverride` lets teeth corrupt the expected side
// without touching the case; `actual` lets teeth reuse
// the clean run's priced values instead of re-pricing.
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

function runSet(corrupt?: {
  field: string;
}): {
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
  let expectedOverride: Record<string, number | string | null> | undefined;
  if (corrupt) {
    // Corrupt one expected literal by flipping the last
    // character of its 10-decimal string, derived from
    // the case's own expected value — no literal copied.
    const s = String(c.expected[corrupt.field] ?? "");
    const flipped = s.slice(0, -1) + (s.endsWith("4") ? "5" : "4");
    expectedOverride = { ...c.expected, [corrupt.field]: flipped };
  }
  const { failures, actual, fields } = evaluate(c, expectedOverride);
  const detail =
    `Monte Carlo golden shocks: allWithinTol=${actual.allWithinTol}, maxDiffNano=${actual.maxDiffNano} ` +
    `(trial 0 z0..z3 ${actual.z0s} / ${actual.z1s} / ${actual.z2s} / ${actual.z3s}, ` +
    `trial 1 first shock ${actual.t1z0s}); ${fields} expected fields compared exactly.`;
  return { failures, counts: { fields, failures: failures.length }, detail };
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
    detail: pass ? set.detail : `${set.failures.length} golden-shock field(s) failed — see failures.`,
    failures: set.failures.slice(0, 25),
    counts: set.counts,
  };
}

function runMcGoldenFast(): HardeningCheckResult {
  return resultFrom(
    "known-mc-golden",
    "Known-answer Monte Carlo golden shocks: seeded stream vs externally computed literals",
    runSet(),
  );
}

function runMcGoldenFull(): HardeningCheckResult {
  // Identical to fast: the pin is one case and there is
  // nothing more to enumerate.
  return resultFrom(
    "known-mc-golden",
    "Known-answer Monte Carlo golden shocks: seeded stream vs externally computed literals",
    runSet(),
  );
}

function runMcGoldenTeeth(): HardeningTeethResult {
  // The clean run must pass first.
  const c = findCase();
  if (!c) {
    return { corruptedCaseId: "known-mc-golden:case-missing", failedCount: 0, pass: false };
  }
  const actual = c.actual();
  const clean = evaluate(c, undefined, actual);
  if (clean.failures.length !== 0) {
    return {
      corruptedCaseId: "known-mc-golden:clean-run-failed",
      failedCount: clean.failures.length,
      pass: false,
    };
  }
  // Corrupt one expected literal (z0s, last decimal
  // flipped) and compare against the SAME priced values:
  // exactly that one field must fail, proving the exact
  // string comparison has teeth. The underlying 1e-9
  // tolerance lives inside the case's actual(); the
  // expected side is the only seam a hardening module
  // may corrupt without editing the fixture.
  const s = String(c.expected.z0s ?? "");
  const flipped = s.slice(0, -1) + (s.endsWith("4") ? "5" : "4");
  const corrupted = evaluate(c, { ...c.expected, z0s: flipped }, actual);
  return {
    corruptedCaseId: "mc-stats-golden-shocks z0s",
    failedCount: corrupted.failures.length,
    pass:
      corrupted.failures.length === 1 &&
      corrupted.failures[0]?.startsWith("z0s:") === true,
  };
}

export const knownMcGoldenCheck: HardeningCheckModule = {
  id: "known-mc-golden",
  name: "Known-answer Monte Carlo golden shocks: seeded stream vs externally computed literals",
  runFast: runMcGoldenFast,
  runFull: runMcGoldenFull,
  runTeeth: runMcGoldenTeeth,
};
