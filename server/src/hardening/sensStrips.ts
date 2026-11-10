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

   Runtime: ~3.4s per optimizer call on the sample household
   (probe). Fast prices the return strip only (3 searches,
   ≈10s); full prices both strips (6 searches, ≈20s).
   Teeth re-prices both strips (6 searches, ≈18s) in
   either mode, so the module costs the suite ≈28s in fast
   mode (3 + 6 searches) and ≈37s in full mode (6 + 6
   searches); the total stays well inside the 120s worker
   cap (the MaxiFi check already costs 7–15s per
   invocation). Measured warm: fast 10.1s, full 18.5s,
   teeth 18.2s.

   FICTIONAL SAMPLE DATA — every figure comes from
   sampleHousehold.ts; no figure here describes any actual
   person's finances. */

import { optimizerHeirSensitivity, optimizerSensitivity } from "../rothOptimizer";
import { samplePlanInputs } from "../sampleHousehold";
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
};

type HeirPoint = {
  heirRatePct: number;
  winnerName: string;
  winnerKey: string;
  winnerNetCost: number;
  doNothingNetCost: number;
};

type Strips = {
  returnStrip: ReturnPoint[];
  heirStrip: HeirPoint[];
};

type Corrupt = { reverseMonotone: true };

const RETURN_DELTAS = [-1, 0, 1];
const HEIR_RATES = [0, 22, 32];

function fmt(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function priceReturnStrip(): ReturnPoint[] {
  const inputs = samplePlanInputs();
  return RETURN_DELTAS.map((delta) => {
    const r = optimizerSensitivity(inputs, delta);
    return {
      returnPct: r.returnPct,
      winnerName: r.winner.spec.name,
      winnerKey: r.winner.spec.key,
      netCost: r.winner.cost.netCost,
    };
  });
}

function priceHeirStrip(): HeirPoint[] {
  const inputs = samplePlanInputs();
  return HEIR_RATES.map((rate) => {
    const r = optimizerHeirSensitivity(inputs, rate);
    return {
      heirRatePct: r.heirRatePct,
      winnerName: r.winner.spec.name,
      winnerKey: r.winner.spec.key,
      winnerNetCost: r.winner.cost.netCost,
      doNothingNetCost: r.doNothing.cost.netCost,
    };
  });
}

// The assertions, run against already-priced strips: each
// strip's net costs must be non-decreasing left to right.
// Teeth reverses the comparison inside these real loops
// (see runSensStripsTeeth) — a pair whose net cost
// genuinely rises then reads as a failure — so a deleted
// or flipped loop would fail teeth. No separate
// side-channel assertion exists here.
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
  const heirText = set.strips.heirStrip.length
    ? ` Heir strip — winner: ${set.strips.heirStrip.map((p) => `${p.heirRatePct}% ${p.winnerName} ${fmt(p.winnerNetCost)}`).join("; ")}; Do Nothing: ${set.strips.heirStrip.map((p) => `${p.heirRatePct}% ${fmt(p.doNothingNetCost)}`).join("; ")}.`
    : "";
  return {
    id,
    name,
    pass,
    detail: pass
      ? `Sensitivity strips monotone in net cost. Return strip (winner netCost non-decreasing): ${returnText}.${heirText}`
      : `${set.failures.length} strip monotonicity violation(s) — return strip: ${returnText}.${heirText} See failures.`,
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
  // the return strip alone. The corrupted comparison reuses
  // the clean run's priced strips — no extra optimizer
  // searches for the evaluation itself — with the
  // monotonicity reversed inside the real loops, so every
  // adjacent pair in both strips (2 return + 2 heir-winner
  // + 2 heir-Do-Nothing) must fail and nothing else must.
  const clean = runSet();
  if (clean.failures.length !== 0) {
    return {
      corruptedCaseId: "sens-strips:clean-run-failed",
      failedCount: clean.failures.length,
      pass: false,
    };
  }
  const corruptedCaseId = "strips monotonicity reversed (both strips)";
  const failures = evaluateStrips(clean.strips, { reverseMonotone: true });
  return {
    corruptedCaseId,
    failedCount: failures.length,
    pass:
      failures.length === 6 &&
      failures.every((f) => f.includes("(reversed expectation)")),
  };
}

export const sensStripsCheck: HardeningCheckModule = {
  id: "sens-strips",
  name: "Sensitivity: optimizer return and heir-rate strips monotone in net cost",
  runFast: runSensStripsFast,
  runFull: runSensStripsFull,
  runTeeth: runSensStripsTeeth,
};
