/* ---------------- Sensitivity: ACA credit non-increasing across the cliff ----------------
   Part 4 of the hardening block (sensitivity checks). Pins the
   shape of the ACA premium credit around the 400% FPL cliff
   for coverage year 2026, two ways:

   (a) DIRECT CREDIT LADDER. acaCreditFor() is called at MAGI
   points straddling the cliff, and the credit must be
   non-increasing in MAGI: it falls about $0.10 per $1 of
   MAGI just under the cliff, is still positive AT the cliff
   (the cliff bites only strictly above it), and is exactly
   $0 at cliff+$1 and above (overCliff). The cliff itself is
   NEVER hardcoded: each household's cliff is read off the
   function's own return (r.cliff), so the check pins the
   shape, not a dollar figure.

   (b) DRAW LINK THROUGH THE DECEMBER PATH. The December
   console state (built exactly as the probe built it — the
   fictional sample household's filed-return actuals and
   pre-tax balance, family benchmark, $5,000 buffer) is
   priced with pricePlaygroundYear(decemberCaseInputs(state,
   "likely", draw)). A binary search finds the draw landing
   MAGI just under the cliff, and over the next draws the
   ACA MAGI must be non-decreasing (+$1 per +$1 draw) while
   the credit is non-increasing — the December draw moves
   the credit exactly the way the direct ladder says it
   must, through the real pricing path, not around it.

   SCOPE NOTE (adjudicated): the credit is NOT monotone in
   MAGI across the 100% FPL edge — below 100% FPL the credit
   is $0 (no credit at all under 100% FPL) and at 100% FPL
   it jumps to the full credit. The ladder therefore scopes
   to the cliff region only; the FPL edge is out of scope
   by design, not a failure.

   PROBE EVIDENCE (~/workspace/scratch/hardening-sensitivity/
   explore.log, probe run before this module was written):
   HH4 cliff $128,600, fpl $32,150; credit 23,291.04 @
   cliff−1000 → 23,201.40 @ −100 → 23,191.94 @ −5 →
   23,191.54 @ −1 → 23,191.44 @ cliff → 0 @ cliff+1 and
   above (overCliff). FPL edge: fpl−$1 → $0; fpl → $35,324.85;
   fpl+$1 → $35,324.83. Draw link: draw $0 → MAGI $21,500,
   credit $0 (below 100% FPL — the scope note above);
   draw $107,097 → MAGI $128,597, credit $23,191.74;
   +$1 draw → MAGI +$1, credit −$0.10, down to $23,191.44
   at the cliff and $0 at $107,107 (overCliff).

   Nothing here re-prices the credit or the December year:
   both sub-assertions call the existing engine functions
   and restate their own returns as monotonicity checks.
   A pin that fails against the engine is a FINDING; this
   module never adjusts a pin to make it pass. */

import { decemberCaseInputs, defaultDecemberState } from "../decemberCore";
import { pricePlaygroundYear } from "../rothOptimizer";
import {
  SAMPLE_ACA_BENCHMARK_COUPLE_CENTS,
  SAMPLE_ACA_BENCHMARK_FAMILY_CENTS,
  SAMPLE_BIRTH_YEAR_PRIMARY,
  SAMPLE_BIRTH_YEAR_SPOUSE,
  SAMPLE_HOUSEHOLD_SIZE,
  SAMPLE_PRETAX_CENTS,
  SAMPLE_TAX_RETURN_INTEREST_CENTS,
  SAMPLE_TAX_RETURN_ORDINARY_DIVIDENDS_CENTS,
  SAMPLE_TAX_RETURN_QUALIFIED_DIVIDENDS_CENTS,
} from "../sampleHousehold";
import { acaCreditFor } from "../taxEngine";
import type {
  HardeningCheckModule,
  HardeningCheckResult,
  HardeningTeethResult,
} from "./types";

const COVERAGE_YEAR = 2026;
const CHECK_ID = "sens-cliff";
const CHECK_NAME =
  "Sensitivity: ACA credit non-increasing across the cliff, $1 draw steps";

/* Cents-rounding slack: credits come back r2'd to the cent,
   and the ladder's per-dollar slope is −$0.10, so a
   one-cent rounding wobble is the largest honest noise.
   Anything larger than a cent of increase is a real
   violation. */
const EPSILON = 0.01;

type PinFailure = string;

type LadderPoint = { magi: number; credit: number; overCliff: boolean };

type Ladder = {
  householdSize: number;
  cliff: number;
  fpl: number;
  points: LadderPoint[];
};

type DrawPoint = { draw: number; magi: number; credit: number; overCliff: boolean };

type Corrupt = { reverseFirstPair: true };

/* The December console state, built exactly as the probe
   built it: the fictional sample household (ages from its
   birth years in the coverage year, household of 4, family
   benchmark, filed-return actuals as the year-to-date
   income, pre-tax balance split explicitly to the
   primary, $5,000 buffer, harvest off). Dollars throughout,
   as DecemberState carries them. */
function probeDecemberState() {
  const state = defaultDecemberState(COVERAGE_YEAR);
  state.agePrimary = COVERAGE_YEAR - SAMPLE_BIRTH_YEAR_PRIMARY;
  state.ageSpouse = COVERAGE_YEAR - SAMPLE_BIRTH_YEAR_SPOUSE;
  state.acaHouseholdSize = SAMPLE_HOUSEHOLD_SIZE;
  state.acaBenchmarkAnnual = SAMPLE_ACA_BENCHMARK_FAMILY_CENTS / 100;
  state.bufferDollars = 5000;
  state.pretaxBalance = SAMPLE_PRETAX_CENTS / 100;
  state.pretaxBalancePrimary = SAMPLE_PRETAX_CENTS / 100;
  state.pretaxBalanceSpouse = 0;
  state.pretaxSplitExplicit = true;
  state.spouseSoleBeneficiary = true;
  state.ytdInterest = SAMPLE_TAX_RETURN_INTEREST_CENTS / 100;
  state.ytdOrdinaryDividends = SAMPLE_TAX_RETURN_ORDINARY_DIVIDENDS_CENTS / 100;
  state.ytdQualifiedDividends = SAMPLE_TAX_RETURN_QUALIFIED_DIVIDENDS_CENTS / 100;
  state.ytdOtherOrdinary = 0;
  state.harvestOn = false;
  return state;
}

/* A null credit is a setup failure (no benchmark entered),
   not a priced value — return null and let the caller
   record it as a check failure. priceDraw must never throw:
   the registry runs modules with no per-module try/catch,
   so a throw here would kill all 26 checks instead of
   failing this one. */
function priceDraw(state: ReturnType<typeof probeDecemberState>, draw: number): DrawPoint | null {
  const priced = pricePlaygroundYear(decemberCaseInputs(state, "likely", draw));
  if (priced.aca.credit == null) return null;
  return {
    draw,
    magi: priced.acaMagi,
    credit: priced.aca.credit,
    overCliff: priced.aca.overCliff,
  };
}

/* One household's cliff-region ladder. The cliff comes from
   the function's own return at MAGI $0 (cliff = 4 * fpl,
   independent of MAGI), and every point is then priced
   against that cliff — no dollar figure is hardcoded. */
function creditLadder(
  householdSize: number,
  benchmarkAnnual: number,
  offsets: number[],
): Ladder {
  const anchor = acaCreditFor({
    magi: 0,
    householdSize,
    coverageYear: COVERAGE_YEAR,
    benchmarkAnnual,
  });
  const cliff = anchor.cliff;
  const points = offsets.map((offset) => {
    const r = acaCreditFor({
      magi: cliff + offset,
      householdSize,
      coverageYear: COVERAGE_YEAR,
      benchmarkAnnual,
    });
    return { magi: cliff + offset, credit: r.credit, overCliff: r.overCliff };
  });
  return { householdSize, cliff, fpl: anchor.fpl, points };
}

function checkLadder(
  ladder: Ladder,
  failures: PinFailure[],
  corrupt?: Corrupt,
): void {
  const { householdSize, cliff, points } = ladder;
  const tag = `HH${householdSize} ladder`;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    if (!prev || !cur) continue;
    // Teeth: with corrupt set, the comparison on the first
    // pair is reversed inside this real loop (see
    // runCliffTeeth) — a pair whose credit genuinely falls
    // then reads as a failure. The reversal lives in the
    // loop itself, never in a side-channel assertion: a
    // deleted or flipped monotonicity loop would fail teeth.
    const isCorruptPair = corrupt?.reverseFirstPair === true && i === 1;
    const increased = cur.credit > prev.credit + EPSILON;
    const violated = isCorruptPair ? !increased : increased;
    if (violated) {
      failures.push(
        isCorruptPair
          ? `${tag} (reversed expectation): credit did not increase $${prev.credit} @ MAGI $${prev.magi} → $${cur.credit} @ MAGI $${cur.magi} (cliff $${cliff})`
          : `${tag}: credit INCREASED $${prev.credit} @ MAGI $${prev.magi} → $${cur.credit} @ MAGI $${cur.magi} (cliff $${cliff})`,
      );
    }
  }
  for (const p of points) {
    if (p.magi > cliff && (p.credit !== 0 || !p.overCliff)) {
      failures.push(
        `${tag}: MAGI $${p.magi} is over the cliff $${cliff} but credit is $${p.credit} (overCliff ${p.overCliff}) — expected $0`,
      );
    }
    if (p.magi <= cliff && (p.credit <= 0 || p.overCliff)) {
      failures.push(
        `${tag}: MAGI $${p.magi} is at/under the cliff $${cliff} but credit is $${p.credit} (overCliff ${p.overCliff}) — expected a positive credit`,
      );
    }
  }
}

function checkDrawLink(
  drawPoints: DrawPoint[],
  cliff: number,
  failures: PinFailure[],
): void {
  for (let i = 1; i < drawPoints.length; i++) {
    const prev = drawPoints[i - 1];
    const cur = drawPoints[i];
    if (!prev || !cur) continue;
    if (cur.magi < prev.magi - EPSILON) {
      failures.push(
        `draw link: MAGI DECREASED $${prev.magi} @ draw $${prev.draw} → $${cur.magi} @ draw $${cur.draw} (cliff $${cliff})`,
      );
    }
    if (cur.credit > prev.credit + EPSILON) {
      failures.push(
        `draw link: credit INCREASED $${prev.credit} @ draw $${prev.draw} → $${cur.credit} @ draw $${cur.draw} (cliff $${cliff})`,
      );
    }
  }
}

// The shared runner: runFast/runFull share every assertion
// and differ only in how many points they price (fullMode).
function runSet(
  corrupt?: Corrupt,
  fullMode = false,
): {
  failures: PinFailure[];
  counts: Record<string, number>;
  ladders: Ladder[];
  drawPoints: DrawPoint[];
  baseDraw: number;
} {
  const failures: PinFailure[] = [];
  const ladders: Ladder[] = [];
  const offsetsFast = [-1000, -100, -5, -2, -1, 0, 1, 2, 5, 100, 1000];
  const offsetsFullWide = [-1000, -100, -5, -2, -1, 0, 1, 2, 5, 100, 1000];
  const familyBenchmark = SAMPLE_ACA_BENCHMARK_FAMILY_CENTS / 100;
  const coupleBenchmark = SAMPLE_ACA_BENCHMARK_COUPLE_CENTS / 100;

  // (a) Direct credit ladder — HH4 in both modes; the $1
  // steps from cliff−10 to cliff+10 plus the HH2 (couple
  // benchmark) and HH5 (family tier) ladders are full-only.
  const hh4Offsets = fullMode
    ? Array.from(new Set([...Array.from({ length: 21 }, (_, i) => i - 10), ...offsetsFullWide])).sort(
        (a, b) => a - b,
      )
    : offsetsFast;
  const hh4 = creditLadder(SAMPLE_HOUSEHOLD_SIZE, familyBenchmark, hh4Offsets);
  ladders.push(hh4);
  checkLadder(hh4, failures, corrupt);
  if (fullMode) {
    const hh2 = creditLadder(2, coupleBenchmark, hh4Offsets);
    ladders.push(hh2);
    checkLadder(hh2, failures);
    const hh5 = creditLadder(5, familyBenchmark, hh4Offsets);
    ladders.push(hh5);
    checkLadder(hh5, failures);
  }

  // (b) Draw link through the December path. Binary-search
  // the largest draw whose ACA MAGI lands at most $2 under
  // the HH4 cliff, then step $1 at a time over it. A null
  // credit at any draw is a setup failure: record it and
  // skip the draw link (the ladders above already stand on
  // their own) — never throw, per priceDraw's note.
  const finish = (drawPoints: DrawPoint[], baseDraw: number) => {
    const ladderPoints = ladders.reduce((n, l) => n + l.points.length, 0);
    return {
      failures,
      counts: {
        ladders: ladders.length,
        ladderPoints,
        drawsPriced: drawPoints.length,
        failures: failures.length,
      },
      ladders,
      drawPoints,
      baseDraw,
    };
  };
  const nullCredit = (draw: number) =>
    `draw link: December pricing returned a null ACA credit at draw $${draw} (no benchmark entered?) — cannot price the draw link`;
  const cliff = hh4.cliff;
  const target = cliff - 2;
  const state = probeDecemberState();
  let lo = 0;
  let hi = 300000;
  // Invariant: magi(lo) <= target < magi(hi).
  const loPoint = priceDraw(state, lo);
  if (loPoint == null) {
    failures.push(nullCredit(lo));
    return finish([], lo);
  }
  if (loPoint.magi > target) {
    failures.push(
      `draw link: even a $0 draw lands MAGI above cliff−$2 ($${target}) — the probe state cannot reach the cliff from below`,
    );
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const midPoint = priceDraw(state, mid);
    if (midPoint == null) {
      failures.push(nullCredit(mid));
      return finish([], lo);
    }
    if (midPoint.magi <= target) lo = mid;
    else hi = mid;
  }
  const baseDraw = lo;
  const base = priceDraw(state, baseDraw);
  if (base == null) {
    failures.push(nullCredit(baseDraw));
    return finish([], baseDraw);
  }
  if (base.magi !== target) {
    // The draw moves MAGI $1-for-$1, so the search must
    // land exactly on the target; anything else means the
    // link between draw and MAGI is not $1-for-$1 here.
    failures.push(
      `draw link: binary search landed MAGI $${base.magi} at draw $${baseDraw}, expected exactly $${target} (cliff $${cliff} − $2)`,
    );
  }
  if (base.overCliff) {
    failures.push(
      `draw link: base draw $${baseDraw} (MAGI $${base.magi}) is already over the cliff $${cliff}`,
    );
  }
  // The December path's own cliff must agree with the
  // direct ladder's cliff — same household, same year.
  const pricedBase = pricePlaygroundYear(
    decemberCaseInputs(state, "likely", baseDraw),
  );
  if (pricedBase.aca.cliff !== cliff) {
    failures.push(
      `draw link: December cliff $${pricedBase.aca.cliff} disagrees with direct-ladder cliff $${cliff}`,
    );
  }
  const drawOffsets = [0, 1, 2, 3, 10];
  const drawPoints: DrawPoint[] = [];
  for (const d of drawOffsets) {
    const p = priceDraw(state, baseDraw + d);
    if (p == null) {
      failures.push(nullCredit(baseDraw + d));
      return finish([], baseDraw);
    }
    drawPoints.push(p);
  }
  checkDrawLink(drawPoints, cliff, failures);

  return finish(drawPoints, baseDraw);
}

function resultFrom(
  id: string,
  name: string,
  set: {
    failures: PinFailure[];
    counts: Record<string, number>;
    ladders: Ladder[];
    drawPoints: DrawPoint[];
    baseDraw: number;
  },
): HardeningCheckResult {
  const pass = set.failures.length === 0;
  const ladderText = set.ladders
    .map(
      (l) =>
        `HH${l.householdSize} cliff $${l.cliff} (fpl $${l.fpl}): credit $${l.points[0]?.credit} @ cliff−$${l.cliff - (l.points[0]?.magi ?? l.cliff)} → $${l.points[l.points.length - 1]?.credit} @ cliff+$${(l.points[l.points.length - 1]?.magi ?? l.cliff) - l.cliff}`,
    )
    .join("; ");
  const firstDraw = set.drawPoints[0];
  const lastDraw = set.drawPoints[set.drawPoints.length - 1];
  const drawText =
    firstDraw && lastDraw
      ? `draw link from $${set.baseDraw} (MAGI $${firstDraw.magi}, credit $${firstDraw.credit}) to $${lastDraw.draw} (MAGI $${lastDraw.magi}, credit $${lastDraw.credit})`
      : "draw link not priced";
  return {
    id,
    name,
    pass,
    detail: pass
      ? `ACA credit non-increasing across the ${COVERAGE_YEAR} cliff in every ladder priced (${ladderText}); ${drawText} — MAGI non-decreasing, credit non-increasing across the cliff.`
      : `${set.failures.length} cliff-monotonicity violation(s) — ${ladderText}; ${drawText}; see failures.`,
    failures: set.failures.slice(0, 25),
    counts: set.counts,
  };
}

function runCliffFast(): HardeningCheckResult {
  return resultFrom(CHECK_ID, CHECK_NAME, runSet(undefined, false));
}

function runCliffFull(): HardeningCheckResult {
  return resultFrom(CHECK_ID, CHECK_NAME, runSet(undefined, true));
}

function runCliffTeeth(): HardeningTeethResult {
  // The clean run must pass first.
  const clean = runSet(undefined, false);
  if (clean.failures.length !== 0) {
    return {
      corruptedCaseId: "sens-cliff:clean-run-failed",
      failedCount: clean.failures.length,
      pass: false,
    };
  }
  // Corrupt the comparison inside the real monotonicity
  // loop: the first HH4 pair's expected direction is
  // reversed, so exactly that pair must fail, and every
  // real assertion — the rest of the ladder, the over-cliff
  // $0 legs, the draw link — must keep passing. A deleted
  // or flipped monotonicity loop would fail teeth, which
  // the old synthetic expectation (require the credit at
  // cliff+1 to equal the credit at the cliff) could not
  // detect.
  const corruptedCaseId = "sens-cliff: HH4 ladder first pair reversed";
  const set = runSet({ reverseFirstPair: true }, false);
  return {
    corruptedCaseId,
    failedCount: set.failures.length,
    pass:
      set.failures.length === 1 &&
      set.failures[0]?.includes("(reversed expectation)") === true,
  };
}

export const sensCliffCheck: HardeningCheckModule = {
  id: CHECK_ID,
  name: CHECK_NAME,
  runFast: runCliffFast,
  runFull: runCliffFull,
  runTeeth: runCliffTeeth,
};
