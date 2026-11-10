/* ---------------- Sensitivity: spending direction ----------------
   Part 4 of the hardening block (sensitivity review). Pins
   the engine's spending-direction monotone: ending
   after-tax wealth is non-increasing in annual spending.
   The fictional sample household (sampleCompareBase, built
   from server/src/sampleHousehold.ts — no figure here
   describes any actual person's finances) is priced
   through runRothCompare at several annual spending levels
   and the ending wealth of adjacent rungs is compared.

   Why Do Nothing only: Do Nothing converts nothing, so
   spending moves wealth directly — every extra dollar
   spent is a dollar that never compounds, with no
   conversion, tax, or credit effect in between to mask or
   reverse the direction. A conversion strategy could in
   principle spend more yet end wealthier (a bigger
   conversion in a cheap year), so the monotone only pins
   cleanly on the no-conversion strategy.

   Probe evidence (explore2.log, sample household,
   Do Nothing, runRothCompare 2026): $165k →
   $12,954,975.68; $175k → $12,077,521.17; $179k →
   $11,724,461.73; $180k → $11,635,964.62; $181k →
   $11,547,411.11; $185k → $11,203,235.11; $190k →
   $10,758,286.73. Strictly decreasing at every step;
   the smallest step is −$88,497.11 ($179k → $180k).
   The assertion allows equality (monotone
   non-increasing, not strictly decreasing) so a flat rung
   — e.g. spending so low the plan is saturated — still
   passes; a rise is the failure.

   Fast prices the 5 rungs $165k / $175k / $180k / $185k /
   $190k. Full adds the fine points $179k / $181k, which
   bracket the base's own $180k spending and catch a
   reversal the coarse ladder could step over. */

import { runRothCompare } from "../rothOptimizer";
import type {
  HardeningCheckModule,
  HardeningCheckResult,
  HardeningTeethResult,
} from "./types";
import { sampleCompareBase } from "./sensCompareBase";

type PinFailure = string;

// Corrupt one adjacent pair's comparison: instead of
// requiring rung N+1 wealth <= rung N wealth, require
// rung N+1 wealth >= rung N wealth. With real data
// strictly decreasing, that pair must fail and no other
// pair is touched.
type Corrupt = { pairIndex: number };

const FAST_RUNGS = [165000, 175000, 180000, 185000, 190000];
const FULL_RUNGS = [165000, 175000, 179000, 180000, 181000, 185000, 190000];

const fmtDollars = (cents: number): string =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function priceRung(spendingDollars: number): number | null {
  const base = sampleCompareBase();
  const result = runRothCompare(
    base,
    [{ name: "Do Nothing", overrides: { annualSpendingCents: spendingDollars * 100 } }],
    2026,
  );
  if (!result.ok || result.scenarios.length === 0) return null;
  const scenario = result.scenarios[0];
  if (scenario === undefined) return null;
  return scenario.endingAfterTaxWealthCents;
}

function runSet(rungs: number[], corrupt?: Corrupt): {
  failures: PinFailure[];
  counts: Record<string, number>;
  ladder: { spending: number; wealthCents: number }[];
} {
  const failures: PinFailure[] = [];
  const ladder: { spending: number; wealthCents: number }[] = [];
  for (const spending of rungs) {
    const wealth = priceRung(spending);
    if (wealth === null) {
      failures.push(`spending $${spending.toLocaleString("en-US")}/yr: compare failed to price`);
      continue;
    }
    ladder.push({ spending, wealthCents: wealth });
  }
  for (let i = 0; i + 1 < ladder.length; i++) {
    const lower = ladder[i];
    const higher = ladder[i + 1];
    if (lower === undefined || higher === undefined) continue;
    const rising = higher.wealthCents > lower.wealthCents;
    const corruptedPair = corrupt !== undefined && corrupt.pairIndex === i;
    // Corrupted pair: the assertion is reversed, so a
    // genuinely falling rung reads as a failure.
    const violated = corruptedPair ? !rising : rising;
    if (violated) {
      failures.push(
        `spending $${lower.spending.toLocaleString("en-US")}/yr → $${higher.spending.toLocaleString("en-US")}/yr: ending wealth ${corruptedPair ? "did not rise" : "rose"} from ${fmtDollars(lower.wealthCents)} to ${fmtDollars(higher.wealthCents)}`,
      );
    }
  }
  return {
    failures,
    counts: { rungs: ladder.length, pairs: Math.max(0, ladder.length - 1), failures: failures.length },
    ladder,
  };
}

function resultFrom(
  id: string,
  name: string,
  set: { failures: PinFailure[]; counts: Record<string, number>; ladder: { spending: number; wealthCents: number }[] },
): HardeningCheckResult {
  const pass = set.failures.length === 0;
  const ladderText = set.ladder
    .map((r) => `$${r.spending.toLocaleString("en-US")}/yr → ${fmtDollars(r.wealthCents)}`)
    .join("; ");
  return {
    id,
    name,
    pass,
    detail: pass
      ? `Ending wealth non-increasing in annual spending (Do Nothing, sample household): ${ladderText}.`
      : `${set.failures.length} spending rung(s) broke the monotone — ${ladderText}; see failures.`,
    failures: set.failures.slice(0, 25),
    counts: set.counts,
  };
}

function runSpendingFast(): HardeningCheckResult {
  return resultFrom(
    "sens-spending",
    "Sensitivity: ending wealth non-increasing in annual spending",
    runSet(FAST_RUNGS),
  );
}

function runSpendingFull(): HardeningCheckResult {
  return resultFrom(
    "sens-spending",
    "Sensitivity: ending wealth non-increasing in annual spending",
    runSet(FULL_RUNGS),
  );
}

function runSpendingTeeth(): HardeningTeethResult {
  // The clean run must pass first.
  const clean = runSet(FAST_RUNGS);
  if (clean.failures.length !== 0) {
    return {
      corruptedCaseId: "sens-spending:clean-run-failed",
      failedCount: clean.failures.length,
      pass: false,
    };
  }
  // Reverse the comparison on the first adjacent pair
  // ($165k → $175k): the real ladder falls there, so the
  // reversed assertion must fail exactly that pair and no
  // other.
  const corruptedCaseId = "sens-spending pair $165k→$175k reversed";
  const set = runSet(FAST_RUNGS, { pairIndex: 0 });
  return {
    corruptedCaseId,
    failedCount: set.failures.length,
    pass: set.failures.length === 1 && set.failures[0]?.includes("$165,000/yr") === true,
  };
}

export const sensSpendingCheck: HardeningCheckModule = {
  id: "sens-spending",
  name: "Sensitivity: ending wealth non-increasing in annual spending",
  runFast: runSpendingFast,
  runFull: runSpendingFull,
  runTeeth: runSpendingTeeth,
};
