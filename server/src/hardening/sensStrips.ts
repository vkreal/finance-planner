/* ---------------- Sensitivity: optimizer return and heir-rate strips ----------------
   Part 4 of the hardening block (sensitivity review). Pins the
   optimizer's own sensitivity strips — the strips the Tax Plan
   view shows when a plan's expected return or heir rate is
   varied — against a monotone-net-cost property on the
   fictional sample household (server/src/sampleHousehold.ts):
   a higher expected return cannot make the best plan cheaper,
   and a higher heir rate cannot make the best plan (or Do
   Nothing) cheaper. Both strips re-run runOptimizer at fixed
   claiming ages with the plan's draw order held
   (searchOrders: false), so each point is a fresh full
   strategy search, not a re-price of one candidate.

   The pin is NET COST ONLY, never winner names. The winner
   legitimately changes across the return strip (probe: the
   32% bracket wins at 4–5%, the 37% bracket at 6%), and the
   engine's own comment on the heir strip says the strip shows
   whether the winner depends on the rate — names are display,
   recorded in the detail string, not the assertion.

   (a) Return strip: the winner's netCost is non-decreasing
   across returnPct 4% / 5% / 6% (deltas −1 / 0 / +1 off the
   sample household's 5%). Probe: $493,594.30 @4% →
   $576,325.07 @5% → $699,660.65 @6% — strictly increasing.
   (b) Heir strip: the winner's netCost is non-decreasing
   across heir rates 0% / 22% / 32%, AND Do Nothing's
   netCost is non-decreasing across the same rates. Probe:
   winner flat $576,325.07 at all three rates — the winner
   ends pre-tax at $0, so its terminal tax is $0 at any heir
   rate (the flat line is the mechanism, not a coincidence);
   Do Nothing $1,141,250.60 → $1,624,539.68 → $1,844,216.53,
   strictly increasing (stranded pre-tax × heir rate).

   (c) Strict winner-beats-Do-Nothing (both strips, round-10
   F2): at every point the reported winner's netCost must be
   STRICTLY less than Do Nothing repriced INDEPENDENTLY —
   the same two calls scoreAllCandidates itself uses for its
   Do Nothing entry (simulateRothPlan with the "none"
   strategy, then planNetCost), applied directly to the
   same shifted inputs — never the doNothing field from
   the sensitivity helper, which comes from the same run
   whose winner is being checked. The comparison is strict
   (<), not ≤: the defect it catches is the sensitivity
   helper returning res.doNothing as the winner, in which
   case the winner IS Do Nothing, equality holds, and ≤
   would still pass. The repriced Do Nothing is a second
   pricing of the same candidate through the same code
   path, so on a clean tree it agrees with the strip's own
   Do Nothing to the cent; any disagreement between the two
   legs is itself a failure of the strict comparison only
   when the winner does not beat the repriced figure.
   (The direct two-call reprice, rather than a full
   scoreAllCandidates per point, is deliberate: the full
   search per point put the worker-run fast registry at
   ~118s against its 120s cap. The direct call prices the
   identical entry — verified to the cent — at one
   simulation instead of a full search.)

   Residual limitation (recorded, not built): strict-beats-DN
   does not catch a mid-pack substitution — a winner that
   is not Do Nothing but is not the cheapest candidate
   still beats Do Nothing. Full minimality would require
   pinning a known-good winner spec (the 32% bracket key);
   that is an option, not part of this check.

   Runtime: ~3.4s per optimizer call on the sample household
   (probe). Fast prices the return strip only (3 searches,
   ≈10s); full prices both strips (6 searches, ≈20s).
   Teeth re-prices both strips (6 searches, ≈18s) in
   either mode, so the module costs the suite ≈28s in fast
   mode (3 + 6 searches) and ≈37s in full mode (6 + 6
   searches); the total stays well inside the 120s worker
   cap (the MaxiFi check already costs 7–15s per
   invocation). Measured (fresh bun processes, after the
   F2 change): fast 13.3s, full 19.7s, teeth 18.9s. The
   independent Do Nothing reprice is one simulation per
   point (sub-second in total) — a full scoreAllCandidates
   per point instead was measured at 19.9s / 36.7s / 37.5s
   for fast / full / teeth and put the worker-run fast
   registry at ~118s against its 120s cap, so the direct
   two-call reprice is the design.

   FICTIONAL SAMPLE DATA — every figure comes from
   sampleHousehold.ts; no figure here describes any actual
   person's finances. */

import {
  optimizerHeirSensitivity,
  optimizerSensitivity,
  planNetCost,
} from "../rothOptimizer";
import { samplePlanInputs } from "../sampleHousehold";
import { simulateRothPlan, type RothPlanInputs } from "../taxEngine";
import type {
  HardeningCheckModule,
  HardeningCheckResult,
  HardeningTeethResult,
} from "./types";

type PinFailure = string;

type ReturnPoint = {
  returnPct: number;
  winnerName: string;
  winnerKey: string;
  netCost: number;
  // Do Nothing at this return point, repriced independently
  // (see repriceDoNothing) — the reference for the strict
  // winner-beats-DN assertion.
  doNothingNetCost: number;
};

type HeirPoint = {
  heirRatePct: number;
  winnerName: string;
  winnerKey: string;
  winnerNetCost: number;
  doNothingNetCost: number;
  // Do Nothing at this heir rate, repriced independently
  // (see repriceDoNothing) — the reference for the
  // strict winner-beats-DN assertion. On a clean tree it
  // agrees with doNothingNetCost to the cent.
  doNothingRepricedNetCost: number;
};

type Strips = {
  returnStrip: ReturnPoint[];
  heirStrip: HeirPoint[];
};

type Corrupt = { reverseMonotone?: boolean; winnerEqualsDoNothing?: boolean };

const RETURN_DELTAS = [-1, 0, 1];
const HEIR_RATES = [0, 22, 32];

function fmt(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Price Do Nothing INDEPENDENTLY of the sensitivity helpers:
// the same two calls scoreAllCandidates itself uses for its
// Do Nothing entry — simulateRothPlan with the "none"
// strategy plus planNetCost — applied directly, without
// pricing every other candidate. The result is identical to
// the Do Nothing entry scoreAllCandidates returns for the
// same inputs (verified: it agrees with the strip's own Do
// Nothing to the cent at every point), and the reference
// never passes through the sensitivity helper under test,
// so a helper that returned Do Nothing as its winner cannot
// corroborate itself. Pricing the full candidate list per
// point instead would put the worker-run fast registry at
// ~118s against its 120s cap; the direct call costs one
// simulation and keeps the module at its pre-F2 runtime.
// The sensitivity helpers' own doNothing field is never the
// reference — it comes from the same run whose winner is
// being checked.
function repriceDoNothing(inputs: RothPlanInputs): number {
  const dnResult = simulateRothPlan(
    inputs,
    {
      id: "none",
      name: "Do Nothing",
      ceilings: null,
    },
    undefined,
    { leanDetail: true },
  );
  return planNetCost(dnResult, inputs).netCost;
}

function priceReturnStrip(): ReturnPoint[] {
  const inputs = samplePlanInputs();
  return RETURN_DELTAS.map((delta) => {
    const r = optimizerSensitivity(inputs, delta);
    const shifted = { ...inputs, expectedReturnPct: inputs.expectedReturnPct + delta };
    return {
      returnPct: r.returnPct,
      winnerName: r.winner.spec.name,
      winnerKey: r.winner.spec.key,
      netCost: r.winner.cost.netCost,
      doNothingNetCost: repriceDoNothing(shifted),
    };
  });
}

function priceHeirStrip(): HeirPoint[] {
  const inputs = samplePlanInputs();
  return HEIR_RATES.map((rate) => {
    const r = optimizerHeirSensitivity(inputs, rate);
    const shifted = { ...inputs, heirRatePct: rate };
    return {
      heirRatePct: r.heirRatePct,
      winnerName: r.winner.spec.name,
      winnerKey: r.winner.spec.key,
      winnerNetCost: r.winner.cost.netCost,
      doNothingNetCost: r.doNothing.cost.netCost,
      doNothingRepricedNetCost: repriceDoNothing(shifted),
    };
  });
}

// The assertions, run against already-priced strips. Two
// families, both in the real loops so teeth can exercise
// them:
//   (1) Monotonicity: each strip's net costs must be
//   non-decreasing left to right. Teeth reverses the
//   comparison inside these loops (see runSensStripsTeeth)
//   — a pair whose net cost genuinely rises then reads as
//   a failure — so a deleted or flipped loop would fail
//   teeth. No separate side-channel assertion exists here.
//   (2) Strict winner-beats-Do-Nothing: at every point the
//   reported winner's net cost must be STRICTLY less than
//   Do Nothing repriced independently (doNothingNetCost on
//   the return strip, doNothingRepricedNetCost on the heir
//   strip). Strict, not ≤: a helper returning Do Nothing
//   as its winner makes the winner equal to Do Nothing,
//   and ≤ would pass. Teeth sets the heir winner's cost to
//   Do Nothing's cost at all three points
//   (winnerEqualsDoNothing) — the equality case — and
//   requires exactly three failures naming the violation.
function evaluateStrips(strips: Strips, corrupt?: Corrupt): PinFailure[] {
  const failures: PinFailure[] = [];
  const reversed = corrupt?.reverseMonotone === true;
  const ret = strips.returnStrip;
  for (let i = 1; i < ret.length; i++) {
    const prev = ret[i - 1]!;
    const cur = ret[i]!;
    const fell = cur.netCost < prev.netCost;
    const violated = reversed ? !fell : fell;
    if (violated) {
      failures.push(
        reversed
          ? `return strip (reversed expectation): winner netCost did not fall from ${fmt(prev.netCost)} @${prev.returnPct}% to ${fmt(cur.netCost)} @${cur.returnPct}%`
          : `return strip: winner netCost fell from ${fmt(prev.netCost)} @${prev.returnPct}% to ${fmt(cur.netCost)} @${cur.returnPct}%`,
      );
    }
  }
  const heir = strips.heirStrip;
  for (let i = 1; i < heir.length; i++) {
    const prev = heir[i - 1]!;
    const cur = heir[i]!;
    const winnerFell = cur.winnerNetCost < prev.winnerNetCost;
    if (reversed ? !winnerFell : winnerFell) {
      failures.push(
        reversed
          ? `heir strip (reversed expectation): winner netCost did not fall from ${fmt(prev.winnerNetCost)} @${prev.heirRatePct}% to ${fmt(cur.winnerNetCost)} @${cur.heirRatePct}%`
          : `heir strip: winner netCost fell from ${fmt(prev.winnerNetCost)} @${prev.heirRatePct}% to ${fmt(cur.winnerNetCost)} @${cur.heirRatePct}%`,
      );
    }
    const dnFell = cur.doNothingNetCost < prev.doNothingNetCost;
    if (reversed ? !dnFell : dnFell) {
      failures.push(
        reversed
          ? `heir strip (reversed expectation): Do Nothing netCost did not fall from ${fmt(prev.doNothingNetCost)} @${prev.heirRatePct}% to ${fmt(cur.doNothingNetCost)} @${cur.heirRatePct}%`
          : `heir strip: Do Nothing netCost fell from ${fmt(prev.doNothingNetCost)} @${prev.heirRatePct}% to ${fmt(cur.doNothingNetCost)} @${cur.heirRatePct}%`,
      );
    }
  }
  for (const p of ret) {
    if (!(p.netCost < p.doNothingNetCost)) {
      failures.push(
        `return strip: winner netCost ${fmt(p.netCost)} @${p.returnPct}% does not strictly beat independently repriced Do Nothing ${fmt(p.doNothingNetCost)}`,
      );
    }
  }
  for (const p of heir) {
    const winnerCost =
      corrupt?.winnerEqualsDoNothing === true ? p.doNothingNetCost : p.winnerNetCost;
    if (!(winnerCost < p.doNothingRepricedNetCost)) {
      failures.push(
        `heir strip: winner netCost ${fmt(winnerCost)} @${p.heirRatePct}% does not strictly beat independently repriced Do Nothing ${fmt(p.doNothingRepricedNetCost)}`,
      );
    }
  }
  return failures;
}

function runSet(opts?: { includeHeir?: boolean; corrupt?: Corrupt }): {
  failures: PinFailure[];
  counts: Record<string, number>;
  strips: Strips;
} {
  const strips: Strips = {
    returnStrip: priceReturnStrip(),
    heirStrip: opts?.includeHeir === false ? [] : priceHeirStrip(),
  };
  const failures = evaluateStrips(strips, opts?.corrupt);
  return {
    failures,
    counts: {
      // One optimizer search per point; the independent
      // Do Nothing reprice is a single simulation per
      // point on top (not counted as a search).
      searches: strips.returnStrip.length + strips.heirStrip.length,
      returnPoints: strips.returnStrip.length,
      heirPoints: strips.heirStrip.length,
      failures: failures.length,
    },
    strips,
  };
}

function resultFrom(
  id: string,
  name: string,
  set: { failures: PinFailure[]; counts: Record<string, number>; strips: Strips },
): HardeningCheckResult {
  const pass = set.failures.length === 0;
  const returnText = set.strips.returnStrip
    .map((p) => `${p.returnPct}% ${p.winnerName} ${fmt(p.netCost)}`)
    .join("; ");
  const returnDnText = set.strips.returnStrip
    .map((p) => `${p.returnPct}% ${fmt(p.doNothingNetCost)}`)
    .join("; ");
  const heirText = set.strips.heirStrip.length
    ? ` Heir strip — winner: ${set.strips.heirStrip.map((p) => `${p.heirRatePct}% ${p.winnerName} ${fmt(p.winnerNetCost)}`).join("; ")}; Do Nothing: ${set.strips.heirStrip.map((p) => `${p.heirRatePct}% ${fmt(p.doNothingNetCost)}`).join("; ")}; Do Nothing repriced independently: ${set.strips.heirStrip.map((p) => `${p.heirRatePct}% ${fmt(p.doNothingRepricedNetCost)}`).join("; ")}.`
    : "";
  return {
    id,
    name,
    pass,
    detail: pass
      ? `Sensitivity strips monotone in net cost, and every winner strictly beats an independently repriced Do Nothing. Return strip (winner netCost non-decreasing): ${returnText}. Do Nothing (independently repriced): ${returnDnText}.${heirText}`
      : `${set.failures.length} strip violation(s) — return strip: ${returnText}. Do Nothing (independently repriced): ${returnDnText}.${heirText} See failures.`,
    failures: set.failures.slice(0, 25),
    counts: set.counts,
  };
}

function runSensStripsFast(): HardeningCheckResult {
  // Return strip only: 3 searches.
  return resultFrom(
    "sens-strips",
    "Sensitivity: optimizer return and heir-rate strips monotone in net cost",
    runSet({ includeHeir: false }),
  );
}

function runSensStripsFull(): HardeningCheckResult {
  // Both strips: 6 searches.
  return resultFrom(
    "sens-strips",
    "Sensitivity: optimizer return and heir-rate strips monotone in net cost",
    runSet(),
  );
}

function runSensStripsTeeth(): HardeningTeethResult {
  // The clean run must pass first, with BOTH strips priced
  // — the heir strip has teeth too, so teeth cannot run on
  // the return strip alone. Both corrupted evaluations reuse
  // the clean run's priced strips — no extra optimizer
  // searches for the evaluation itself. Two legs:
  //   (1) the monotonicity reversed inside the real loops,
  //   so every adjacent pair in both strips (2 return + 2
  //   heir-winner + 2 heir-Do-Nothing) must fail and
  //   nothing else must — exactly 6;
  //   (2) the heir winner's cost set to Do Nothing's cost at
  //   all three points (the equality case the strict
  //   winner-beats-DN assertion must catch), so exactly
  //   three failures naming the violation and nothing else
  //   must appear.
  const clean = runSet();
  if (clean.failures.length !== 0) {
    return {
      corruptedCaseId: "sens-strips:clean-run-failed",
      failedCount: clean.failures.length,
      pass: false,
    };
  }
  const reversedCaseId = "strips monotonicity reversed (both strips)";
  const reversedFailures = evaluateStrips(clean.strips, { reverseMonotone: true });
  const winnerEqualsDnCaseId = "strips heir winner set to Do Nothing (all three points)";
  const winnerEqualsDnFailures = evaluateStrips(clean.strips, {
    winnerEqualsDoNothing: true,
  });
  return {
    corruptedCaseId: `${reversedCaseId} | ${winnerEqualsDnCaseId}`,
    failedCount: reversedFailures.length + winnerEqualsDnFailures.length,
    pass:
      reversedFailures.length === 6 &&
      reversedFailures.every((f) => f.includes("(reversed expectation)")) &&
      winnerEqualsDnFailures.length === 3 &&
      winnerEqualsDnFailures.every((f) =>
        f.includes("does not strictly beat independently repriced Do Nothing"),
      ),
  };
}

export const sensStripsCheck: HardeningCheckModule = {
  id: "sens-strips",
  name: "Sensitivity: optimizer return and heir-rate strips monotone in net cost",
  runFast: runSensStripsFast,
  runFull: runSensStripsFull,
  runTeeth: runSensStripsTeeth,
};
