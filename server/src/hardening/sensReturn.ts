/* ---------------- Sensitivity: return-direction check ----------------
   Part 4 of the hardening block (sensitivity review). Pins the
   return direction of the Roth compare: ending after-tax wealth
   must be non-decreasing in the expected return. A higher
   expected return grows every invested balance faster, so a
   plan priced at 7% must not end poorer than the same plan
   priced at 3% — a reversal would mean the return input is
   wired backwards somewhere in the march.

   Do Nothing only: with no conversions, the return moves
   wealth directly — no conversion tax, no bracket fill, no
   cliff cap in between to bend the curve. A conversion
   strategy's wealth is NOT monotone in return in general
   (a higher return can push more income over a cliff or
   into a higher bracket), so this pin deliberately prices
   the one strategy where monotonicity is a genuine
   invariant of the engine, not an accident of the numbers.

   Probe evidence (explore2.log, fictional sample household,
   Do Nothing, endingAfterTaxWealthCents): 3% → $4,012,011.87;
   4% → $7,076,519.86; 5% → $11,635,964.62; 6% → $18,382,460.40;
   7% → $28,168,944.85. Strictly increasing, smallest step
   +$3.06M. The assertion is monotone non-decreasing, not
   strictly increasing: equality between adjacent rungs is
   allowed (a plan that runs out of money at both returns
   ends at the same floor), only a decrease fails.

   Fast prices the 5 whole-point rungs 3–7%; full adds the
   fine points 4.75% and 5.25% around the 5% base case. */

import { runRothCompare } from "../rothOptimizer";
import { sampleCompareBase } from "./sensCompareBase";
import type {
  HardeningCheckModule,
  HardeningCheckResult,
  HardeningTeethResult,
} from "./types";

type Rung = { returnPct: number; wealthCents: number };

type Corrupt = { reversed: boolean };

const FAST_RUNGS = [3, 4, 5, 6, 7];
const FULL_RUNGS = [3, 4, 4.75, 5, 5.25, 6, 7];

function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function runSet(
  rungs: number[],
  corrupt?: Corrupt,
): { failures: string[]; counts: Record<string, number>; ladder: Rung[] } {
  const failures: string[] = [];
  const ladder: Rung[] = [];
  for (const returnPct of rungs) {
    const base = { ...sampleCompareBase(), expectedReturnPct: returnPct };
    const result = runRothCompare(base, [{ name: "Do Nothing", overrides: {} }], 2026);
    if (!result.ok || result.scenarios.length === 0) {
      failures.push(
        `return ${returnPct}%: compare failed (${result.reason || "no scenarios"})`,
      );
      continue;
    }
    ladder.push({
      returnPct,
      wealthCents: result.scenarios[0]!.endingAfterTaxWealthCents,
    });
  }
  // Adjacent-rung monotonicity. Clean: each rung must end at or
  // above the rung below it. Corrupt (teeth): the comparison is
  // reversed — each rung must end at or BELOW the rung below it
  // — so a genuinely increasing ladder fails every pair.
  for (let i = 1; i < ladder.length; i++) {
    const prev = ladder[i - 1]!;
    const curr = ladder[i]!;
    const violates = corrupt?.reversed
      ? curr.wealthCents > prev.wealthCents
      : curr.wealthCents < prev.wealthCents;
    if (violates) {
      failures.push(
        corrupt?.reversed
          ? `return ${curr.returnPct}% wealth ${dollars(curr.wealthCents)} above ${prev.returnPct}% wealth ${dollars(prev.wealthCents)} (reversed check)`
          : `return ${curr.returnPct}% wealth ${dollars(curr.wealthCents)} below ${prev.returnPct}% wealth ${dollars(prev.wealthCents)}`,
      );
    }
  }
  return {
    failures,
    counts: {
      rungs: ladder.length,
      pairs: Math.max(0, ladder.length - 1),
      failures: failures.length,
    },
    ladder,
  };
}

function resultFrom(
  id: string,
  name: string,
  set: { failures: string[]; counts: Record<string, number>; ladder: Rung[] },
): HardeningCheckResult {
  const pass = set.failures.length === 0;
  const ladderText = set.ladder
    .map((r) => `${r.returnPct}% → ${dollars(r.wealthCents)}`)
    .join("; ");
  return {
    id,
    name,
    pass,
    detail: pass
      ? `Ending after-tax wealth (Do Nothing) non-decreasing in expected return across ${set.counts.rungs} rungs: ${ladderText}.`
      : `${set.failures.length} return rung(s) violated monotonicity — ${ladderText}; see failures.`,
    failures: set.failures.slice(0, 25),
    counts: set.counts,
  };
}

function runReturnFast(): HardeningCheckResult {
  return resultFrom(
    "sens-return",
    "Sensitivity: ending wealth non-decreasing in expected return",
    runSet(FAST_RUNGS),
  );
}

function runReturnFull(): HardeningCheckResult {
  // Same assertion, finer rungs around the 5% base case.
  return resultFrom(
    "sens-return",
    "Sensitivity: ending wealth non-decreasing in expected return",
    runSet(FULL_RUNGS),
  );
}

function runReturnTeeth(): HardeningTeethResult {
  // The clean run must pass first.
  const clean = runSet(FAST_RUNGS);
  if (clean.failures.length !== 0) {
    return {
      corruptedCaseId: "sens-return:clean-run-failed",
      failedCount: clean.failures.length,
      pass: false,
    };
  }
  // Teeth mechanism: no engine input is corrupted — the
  // assertion itself is reversed (each rung must end at or
  // below the rung below it) over the same increasing ladder.
  // A ladder that genuinely rises must fail every adjacent
  // pair under the reversed check, and nothing else: exactly
  // pairs = rungs − 1 failures proves the monotone assertion
  // is the thing doing the failing.
  const corruptedCaseId = "sens-return reversed-monotonicity";
  const set = runSet(FAST_RUNGS, { reversed: true });
  return {
    corruptedCaseId,
    failedCount: set.failures.length,
    pass: set.failures.length === clean.counts.pairs,
  };
}

export const sensReturnCheck: HardeningCheckModule = {
  id: "sens-return",
  name: "Sensitivity: ending wealth non-decreasing in expected return",
  runFast: runReturnFast,
  runFull: runReturnFull,
  runTeeth: runReturnTeeth,
};
