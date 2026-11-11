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
   Do Nothing to the cent. That agreement is now asserted
   directly by family (e) below (round 12, R12-F1): the
   strict comparison alone cannot catch a wrong reported
   Do Nothing that still loses to the winner — ChatGPT
   round 12 demonstrated the helper's reported Do Nothing
   inflated by $1,000,000 at every heir point passing all
   26 checks.

   (e) Reported-versus-repriced Do Nothing agreement (round
   12, R12-F1): at every heir point the reported Do
   Nothing netCost (the sensitivity helper's own doNothing
   field) must EQUAL, in integer cents, the independently
   repriced Do Nothing for the same shifted inputs. The
   reported figure is not decorative: actions.ts computes
   savingVsDoNothing from it, so a wrong reported Do
   Nothing overstates conversion savings without bound
   while every other assertion still passes — the winner
   still beats the repriced figure, still attains the
   pinned minimum, and the strips stay monotone. The
   assertion is integer cents, no tolerance: on a clean
   tree the two pricings of the same candidate agree
   exactly. Teeth inflates the reported Do Nothing by
   $1,000,000 at all three heir points (the round-12
   reviewer's mutation values) and requires exactly three
   failures naming the disagreement. No additional
   optimizer searches — the F2 independent reprice
   already runs.
   (The direct two-call reprice, rather than a full
   scoreAllCandidates per point, is deliberate: the full
   search per point put the worker-run fast registry at
   ~118s against its 120s cap. The direct call prices the
   identical entry — verified to the cent — at one
   simulation instead of a full search.)

   (d) Minimality (round 11, R11-F1): at every point the
   reported winner's net cost must EQUAL the pinned
   minimum net cost for that point (EXPECTED_MIN_COSTS_CENTS
   below, exact cents, derived from the verified-correct
   engine on the sample household). This closes the
   residual limitation the round-10 F2 fix recorded:
   strict-beats-DN alone does not catch a mid-pack
   substitution — ChatGPT round 11 demonstrated a
   sensitivity helper returning scored[4] as the winner
   passing all 26 checks (return excess $12,494.53 @4%,
   $9,717.37 @5%, $0 @6% where scored[4] ties the winner;
   heir excess $9,717.37 at all three rates). The pins are
   the independent reference, as in sensCaps (F4): a
   reference taken from the same response it checks would
   absorb the substitution. Exact winner NAMES are not
   pinned — when candidates tie at the minimum (6% return,
   where several candidates share the winner's cost) any
   winner attaining the minimum passes. A legitimate engine
   change that moves a minimum must update the pins
   deliberately; never adjust a pin to make a failing check
   pass. The pins add no optimizer searches — a live
   full-search minimality check was measured at ~4s per
   point and would have put the full registry near the
   120s cap, so the pins are the design. Teeth sets the
   winner's cost to the measured scored[4] costs at all
   six points (winnerAboveMinimum) — the round-11 mutation
   values — and requires exactly ten failures: five
   naming the minimality violation (the 6% return point
   ties the minimum, so its corrupted cost equals the pin
   and correctly does not fail) and five naming the
   winner-agreement violation, because the corrupted
   reported cost is not the winner spec's repriced cost
   either — see (f).

   (f) Winner-spec agreement (round 13, R13-F1): at every
   point on BOTH strips the winner's SPEC is repriced
   independently — the same two calls scoreAllCandidates
   itself uses for a candidate (simulateRothPlan with the
   candidate's own strategy, then planNetCost), with the
   spec's window (windowStopAge), draw order, and flags
   (guardrail, bunching, gainsHarvest) honored exactly as
   the search prices them — and that repriced cost must
   EQUAL, in integer cents, BOTH the reported winner cost
   AND the pinned minimum for the point. The minimum
   assertions alone compare only the reported number: a
   helper returning a different strategy's specification
   with the minimum cost attached passes every earlier
   family. ChatGPT round 13 demonstrated exactly that —
   the winner's spec replaced with Do Nothing's spec
   (cost retained) passed all 26 checks, with the
   response then computing a saving for Do Nothing
   against itself. The reprice is one simulation per
   point on top of the strips' own searches (sub-second
   in total); a full scoreAllCandidates per point instead
   would put the worker-run fast registry near its 120s
   cap (F2 measured the same for the Do Nothing reprice).
   Do Nothing's own spec is repriced through the literal
   "none" strategy scoreAllCandidates uses for its Do
   Nothing entry, never candidateStrategy — so a swapped
   spec reprices to exactly the stored independently
   repriced Do Nothing (verified to the cent at all six
   points), which is what teeth substitutes for the
   swapped reprice. Teeth swaps the winner's spec to Do
   Nothing's at all six points and requires exactly
   twelve failures naming the disagreement — six against
   the reported cost, six against the pinned minimum.

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
   two-call reprice is the design. The winner-spec reprice
   adds one simulation per point (sub-second in total) to
   the clean run; the corrupted teeth evaluations reuse
   the clean run's stored figures, so they cost no extra
   engine calls.

   FICTIONAL SAMPLE DATA — every figure comes from
   sampleHousehold.ts; no figure here describes any actual
   person's finances. */

import {
  optimizerHeirSensitivity,
  optimizerSensitivity,
  planNetCost,
  DO_NOTHING_SPEC,
  candidateStrategy,
  type OptimizerCandidateSpec,
} from "../rothOptimizer";
import { samplePlanInputs } from "../sampleHousehold";
import { simulateRothPlan, drawOrderKey, type RothPlanInputs } from "../taxEngine";
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
  // The winner's spec, repriced independently (see
  // repriceSpec) — the reference for the winner-spec
  // agreement assertion (family (f), round 13, R13-F1).
  winnerRepricedNetCost: number;
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
  // The winner's spec, repriced independently (see
  // repriceSpec) — the reference for the winner-spec
  // agreement assertion (family (f), round 13, R13-F1).
  winnerRepricedNetCost: number;
  doNothingNetCost: number;
  // Do Nothing at this heir rate, repriced independently
  // (see repriceDoNothing) — the reference for the
  // strict winner-beats-DN assertion. On a clean tree it
  // agrees with doNothingNetCost to the cent; that
  // agreement itself is asserted by family (e) below
  // (round 12, R12-F1).
  doNothingRepricedNetCost: number;
};

type Strips = {
  returnStrip: ReturnPoint[];
  heirStrip: HeirPoint[];
};

type Corrupt = { reverseMonotone?: boolean; winnerEqualsDoNothing?: boolean; winnerAboveMinimum?: boolean; reportedDoNothingInflated?: boolean; winnerSpecSwapped?: boolean };

const RETURN_DELTAS = [-1, 0, 1];
const HEIR_RATES = [0, 22, 32];

function fmt(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/* ---- Literal minimum-cost pins (round 11, R11-F1) ------------
   The minimum net cost the engine must report for the sample
   household at each strip point, in exact cents — the
   independent reference for the minimality assertion. The
   winner's cost at a point must equal its pin; a mid-pack
   substitution (a winner that beats Do Nothing but is not
   the cheapest) fails. MUTATED_WINNER_COSTS_CENTS holds the
   measured costs of the round-11 reviewer's mutation
   (sensitivity helpers returning scored[4] as the winner)
   at the same points — teeth sets the winner's cost to
   these values and requires the minimality assertion to
   fire. Note the 6% return point: the mutated cost equals
   the minimum there (scored[4] ties the winner), so that
   point correctly does not fail under the mutation. Any
   legitimate engine change that moves a minimum must
   update these pins deliberately. */
const EXPECTED_MIN_COSTS_CENTS: {
  return: Record<number, number>;
  heir: Record<number, number>;
} = {
  return: { 4: 49359430, 5: 57632507, 6: 69966065 },
  heir: { 0: 57632507, 22: 57632507, 32: 57632507 },
};
const MUTATED_WINNER_COSTS_CENTS: {
  return: Record<number, number>;
  heir: Record<number, number>;
} = {
  return: { 4: 50608883, 5: 58604244, 6: 69966065 },
  heir: { 0: 58604244, 22: 58604244, 32: 58604244 },
};

/* The round-12 reviewer's mutation value for the reported
   Do Nothing benchmark: the helper's reported doNothing
   cost inflated by exactly $1,000,000 (100,000,000 cents)
   at every heir point. Teeth adds this offset to the
   reported figure and requires the agreement assertion
   to fire once per point. */
const REPORTED_DN_INFLATION_CENTS = 100_000_000;

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

// Price an arbitrary candidate SPEC independently of the
// sensitivity helpers: the same two calls scoreAllCandidates
// itself uses for a candidate — simulateRothPlan with the
// candidate's own strategy, then planNetCost — applied
// directly, without pricing every other candidate. The
// spec's window, draw order, and flags are honored exactly
// as the search prices them: a spec whose windowStopAge or
// draw order differs from the plan's is priced on inputs
// shifted the same way scoreAllCandidates shifts them, and
// candidateStrategy carries the spec's ceilings, guardrail,
// bunching, and gainsHarvest. planNetCost takes the
// ORIGINAL inputs (as in scoreAllCandidates), so the heir
// rate and preserve floor come from the point's own inputs.
// Do Nothing's spec is the one exception: scoreAllCandidates
// prices its Do Nothing entry with the literal "none"
// strategy, never candidateStrategy, so this function does
// the same — the repriced cost of a Do Nothing spec is then
// identical to repriceDoNothing on the same inputs (verified
// to the cent at all six points). One simulation per call;
// a full scoreAllCandidates per point instead would put the
// worker-run fast registry near its 120s cap (the same
// measurement F2 recorded for the Do Nothing reprice).
function repriceSpec(inputs: RothPlanInputs, spec: OptimizerCandidateSpec): number {
  if (spec.key === DO_NOTHING_SPEC.key) {
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
  const candidateInputs =
    spec.windowStopAge === inputs.windowStopAge &&
    drawOrderKey(spec.drawOrder) === drawOrderKey(inputs.drawOrder)
      ? inputs
      : { ...inputs, windowStopAge: spec.windowStopAge, drawOrder: spec.drawOrder };
  const result = simulateRothPlan(candidateInputs, candidateStrategy(spec), undefined, {
    leanDetail: true,
  });
  return planNetCost(result, inputs).netCost;
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
      winnerRepricedNetCost: repriceSpec(shifted, r.winner.spec),
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
      winnerRepricedNetCost: repriceSpec(shifted, r.winner.spec),
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
//   (3) Minimality (round 11, R11-F1): at every point the
//   reported winner's net cost must EQUAL the pinned
//   minimum for that point (EXPECTED_MIN_COSTS_CENTS).
//   Teeth sets the winner's cost to the measured scored[4]
//   costs at all six points (winnerAboveMinimum) — the
//   round-11 mutation values — and requires exactly ten
//   failures: five naming the minimality violation and
//   five naming the winner-agreement violation (family
//   (f) below), because a reported cost that is not the
//   winner spec's repriced cost fires that assertion too;
//   the 6% return point ties the minimum, so its
//   corrupted cost equals the pin and correctly does not
//   fail either assertion.
//   (4) Reported-versus-repriced Do Nothing agreement
//   (round 12, R12-F1; heir strip only — the return strip
//   collects no reported Do Nothing): at every heir point
//   the reported Do Nothing netCost must equal, in
//   integer cents, the independently repriced Do Nothing
//   for the same inputs. Teeth inflates the reported
//   figure by $1,000,000 at all three points
//   (reportedDoNothingInflated) and requires exactly
//   three failures naming the disagreement.
//   (5) Winner-spec agreement (round 13, R13-F1; both
//   strips): at every point the independently repriced
//   winner-spec cost (winnerRepricedNetCost, priced in
//   priceReturnStrip / priceHeirStrip via repriceSpec)
//   must equal, in integer cents, BOTH the reported
//   winner cost AND the pinned minimum for that point.
//   Teeth swaps the winner's spec to Do Nothing's at all
//   six points (winnerSpecSwapped) — the round-13
//   mutation — and requires exactly twelve failures:
//   six naming the reported-cost disagreement and six
//   naming the pinned-minimum disagreement. The swapped
//   repriced cost is the stored independently repriced Do
//   Nothing (return strip: doNothingNetCost; heir strip:
//   doNothingRepricedNetCost), which is exactly what the
//   swapped spec reprices to, because repriceSpec prices
//   a Do Nothing spec through the literal "none"
//   strategy — verified to the cent at all six points
//   before the fix was written.
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
  for (const p of ret) {
    const reportedCents =
      corrupt?.winnerAboveMinimum === true
        ? MUTATED_WINNER_COSTS_CENTS.return[p.returnPct]!
        : Math.round(p.netCost * 100);
    const expectedCents = EXPECTED_MIN_COSTS_CENTS.return[p.returnPct]!;
    if (reportedCents !== expectedCents) {
      failures.push(
        `return strip: winner netCost ${fmt(reportedCents / 100)} @${p.returnPct}% does not attain the pinned minimum ${fmt(expectedCents / 100)}`,
      );
    }
  }
  for (const p of heir) {
    const reportedCents =
      corrupt?.winnerAboveMinimum === true
        ? MUTATED_WINNER_COSTS_CENTS.heir[p.heirRatePct]!
        : Math.round(p.winnerNetCost * 100);
    const expectedCents = EXPECTED_MIN_COSTS_CENTS.heir[p.heirRatePct]!;
    if (reportedCents !== expectedCents) {
      failures.push(
        `heir strip: winner netCost ${fmt(reportedCents / 100)} @${p.heirRatePct}% does not attain the pinned minimum ${fmt(expectedCents / 100)}`,
      );
    }
  }
  // Family (f): the winner's spec, repriced independently,
  // must agree with the reported winner cost AND with the
  // pinned minimum, in integer cents, at every point. Under
  // the spec-swap corruption the repriced cost is the Do
  // Nothing cost the swapped spec reprices to (the stored
  // independently repriced Do Nothing on each strip). The
  // reported cost is read through the same winnerAboveMinimum
  // substitution as the minimality loops, so a corrupted
  // reported cost — the round-11 mutation's form — fires
  // this assertion too (leg (3) produces five minimality
  // failures and five agreement failures).
  for (const p of ret) {
    const repricedCents =
      corrupt?.winnerSpecSwapped === true
        ? Math.round(p.doNothingNetCost * 100)
        : Math.round(p.winnerRepricedNetCost * 100);
    const reportedCents =
      corrupt?.winnerAboveMinimum === true
        ? MUTATED_WINNER_COSTS_CENTS.return[p.returnPct]!
        : Math.round(p.netCost * 100);
    const expectedCents = EXPECTED_MIN_COSTS_CENTS.return[p.returnPct]!;
    if (repricedCents !== reportedCents) {
      failures.push(
        `return strip: reported winner netCost ${fmt(reportedCents / 100)} @${p.returnPct}% does not agree with independently repriced winner ${fmt(repricedCents / 100)}`,
      );
    }
    if (repricedCents !== expectedCents) {
      failures.push(
        `return strip: independently repriced winner netCost ${fmt(repricedCents / 100)} @${p.returnPct}% does not attain the pinned minimum ${fmt(expectedCents / 100)}`,
      );
    }
  }
  for (const p of heir) {
    const repricedCents =
      corrupt?.winnerSpecSwapped === true
        ? Math.round(p.doNothingRepricedNetCost * 100)
        : Math.round(p.winnerRepricedNetCost * 100);
    const reportedCents =
      corrupt?.winnerAboveMinimum === true
        ? MUTATED_WINNER_COSTS_CENTS.heir[p.heirRatePct]!
        : Math.round(p.winnerNetCost * 100);
    const expectedCents = EXPECTED_MIN_COSTS_CENTS.heir[p.heirRatePct]!;
    if (repricedCents !== reportedCents) {
      failures.push(
        `heir strip: reported winner netCost ${fmt(reportedCents / 100)} @${p.heirRatePct}% does not agree with independently repriced winner ${fmt(repricedCents / 100)}`,
      );
    }
    if (repricedCents !== expectedCents) {
      failures.push(
        `heir strip: independently repriced winner netCost ${fmt(repricedCents / 100)} @${p.heirRatePct}% does not attain the pinned minimum ${fmt(expectedCents / 100)}`,
      );
    }
  }
  for (const p of heir) {
    const reportedCents =
      corrupt?.reportedDoNothingInflated === true
        ? Math.round(p.doNothingNetCost * 100) + REPORTED_DN_INFLATION_CENTS
        : Math.round(p.doNothingNetCost * 100);
    const repricedCents = Math.round(p.doNothingRepricedNetCost * 100);
    if (reportedCents !== repricedCents) {
      failures.push(
        `heir strip: reported Do Nothing netCost ${fmt(reportedCents / 100)} @${p.heirRatePct}% does not agree with independently repriced Do Nothing ${fmt(repricedCents / 100)}`,
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
      minimumPins: strips.returnStrip.length + strips.heirStrip.length,
      doNothingAgreementPins: strips.heirStrip.length,
      winnerAgreementPins: strips.returnStrip.length + strips.heirStrip.length,
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
      ? `Sensitivity strips monotone in net cost, every winner strictly beats an independently repriced Do Nothing, every winner attains the pinned minimum net cost at its point, every reported winner net cost agrees with the independently repriced winner specification to the cent and that repriced cost attains the pinned minimum, and every reported Do Nothing agrees with its independently repriced Do Nothing to the cent. Return strip (winner netCost non-decreasing): ${returnText}. Do Nothing (independently repriced): ${returnDnText}.${heirText}`
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
  // searches for the evaluation itself. Five legs:
  //   (1) the monotonicity reversed inside the real loops,
  //   so every adjacent pair in both strips (2 return + 2
  //   heir-winner + 2 heir-Do-Nothing) must fail and
  //   nothing else must — exactly 6;
  //   (2) the heir winner's cost set to Do Nothing's cost at
  //   all three points (the equality case the strict
  //   winner-beats-DN assertion must catch), so exactly
  //   three failures naming the violation and nothing else
  //   must appear.
  //   (3) the winner's cost set to the measured scored[4]
  //   costs at all six points (the round-11 mid-pack
  //   substitution values), so exactly ten failures must
  //   appear — five naming the minimality violation and
  //   five naming the winner-agreement violation, because
  //   the corrupted reported cost is not the winner spec's
  //   repriced cost either (family (f)); the 6% return
  //   point ties the minimum and correctly fails neither.
  //   (4) the reported Do Nothing inflated by $1,000,000 at
  //   all three heir points (the round-12 reviewer's
  //   mutation), so exactly three failures naming the
  //   agreement violation must appear — and nothing else.
  //   (5) the winner's spec swapped to Do Nothing's at all
  //   six points (the round-13 reviewer's mutation), so
  //   exactly twelve failures must appear — six naming the
  //   reported-cost disagreement and six naming the
  //   pinned-minimum disagreement, and nothing else.
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
  const minAboveCaseId = "strips winner set to the mid-pack scored[4] cost (both strips)";
  const minAboveFailures = evaluateStrips(clean.strips, {
    winnerAboveMinimum: true,
  });
  const reportedDnInflatedCaseId =
    "strips reported Do Nothing inflated by $1,000,000 (all three heir points)";
  const reportedDnInflatedFailures = evaluateStrips(clean.strips, {
    reportedDoNothingInflated: true,
  });
  const winnerSpecSwappedCaseId =
    "strips winner spec swapped to Do Nothing (both strips)";
  const winnerSpecSwappedFailures = evaluateStrips(clean.strips, {
    winnerSpecSwapped: true,
  });
  return {
    corruptedCaseId: `${reversedCaseId} | ${winnerEqualsDnCaseId} | ${minAboveCaseId} | ${reportedDnInflatedCaseId} | ${winnerSpecSwappedCaseId}`,
    failedCount:
      reversedFailures.length +
      winnerEqualsDnFailures.length +
      minAboveFailures.length +
      reportedDnInflatedFailures.length +
      winnerSpecSwappedFailures.length,
    pass:
      reversedFailures.length === 6 &&
      reversedFailures.every((f) => f.includes("(reversed expectation)")) &&
      winnerEqualsDnFailures.length === 3 &&
      winnerEqualsDnFailures.every((f) =>
        f.includes("does not strictly beat independently repriced Do Nothing"),
      ) &&
      minAboveFailures.length === 10 &&
      minAboveFailures.filter(
        (f) =>
          f.includes("does not attain the pinned minimum") &&
          !f.includes("independently repriced winner"),
      ).length === 5 &&
      minAboveFailures.filter((f) =>
        f.includes("does not agree with independently repriced winner"),
      ).length === 5 &&
      reportedDnInflatedFailures.length === 3 &&
      reportedDnInflatedFailures.every((f) =>
        f.includes("does not agree with independently repriced Do Nothing"),
      ) &&
      winnerSpecSwappedFailures.length === 12 &&
      winnerSpecSwappedFailures.filter((f) =>
        f.includes("does not agree with independently repriced winner"),
      ).length === 6 &&
      winnerSpecSwappedFailures.filter(
        (f) =>
          f.includes("independently repriced winner netCost") &&
          f.includes("does not attain the pinned minimum"),
      ).length === 6,
  };
}

export const sensStripsCheck: HardeningCheckModule = {
  id: "sens-strips",
  name: "Sensitivity: optimizer return and heir-rate strips monotone in net cost",
  runFast: runSensStripsFast,
  runFull: runSensStripsFull,
  runTeeth: runSensStripsTeeth,
};
