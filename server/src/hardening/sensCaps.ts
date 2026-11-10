/* ---------------- Sensitivity: conversion-cap ordering ----------
   Part 4 of the hardening block (sensitivity review). Pins the
   net-cost ORDER of the four fixed conversion-cap strategies
   — Do Nothing, Fill 12%, Fill 22%, Fill to cliff — under
   small perturbations of the sample household's plan: the
   ranking the engine reports must not be an artefact of one
   exact spending or return figure.

   What it pins: with the fictional sample household as the
   runRothCompare base (see ./sensCompareBase), the four
   strategies price to the base order Fill 22% < Fill to
   cliff < Fill 12% < Do Nothing. The assertions are (a) the
   winner (lowest net cost) is the same strategy in every
   perturbed run, and (b) for every pair of strategies whose
   BASE net-cost gap exceeds the near-tie band below, their
   relative order is identical in every perturbed run. A pair
   whose base gap is within the band may swap, but only
   within the band: a swap wider than the band is a real
   reversal and fails. At base only Do Nothing / Fill 12%
   is within it, so the allowance covers exactly that known
   near-tie and nothing else.

   Near-tie band: $5,000 (500,000 cents). The band exists
   because a pair separated by less than a rounding-scale
   planning difference is a coin flip under perturbation,
   not a stable engineering claim; a pair separated by more
   than the band is a real ordering the engine must hold.
   The allowance is bounded: a near-tie pair that swaps by
   more than the band fails (a swap that far is a signal,
   not a coin flip); a pair that holds its order may widen
   by any amount. At base the Do Nothing − Fill 12% gap is
   $2,622.22 (inside the band) while the next-smallest gap,
   Fill 12% − Fill to cliff, is $54,521.32 (outside it) —
   so the band draws the line between the one known
   near-tie and the genuinely separated pairs.

   Probe evidence (scratch/hardening-sensitivity/explore.log,
   "caps ordering"): the full ranking held in all 7 probed
   perturbations (spending ±$1,000, return ±0.25%, and the
   spend +$1,000 / return +0.25% corner); the smallest
   observed pairwise gap anywhere was $149.62 (Do Nothing
   vs Fill 12% at spend +$1,000 / return +0.25%). Base net
   costs (cents): Fill 22% 120,026,186; Fill to cliff
   157,740,467; Fill 12% 163,192,599; Do Nothing
   163,454,821. Base pairwise gaps: Do Nothing − Fill 12%
   $2,622.22; Fill 12% − Fill to cliff $54,521.32;
   Fill to cliff − Fill 22% $377,142.81.

   Runtime: each grid point prices four scenarios in one
   runRothCompare call, milliseconds per run — the 9-run
   grid is cheap. Fast and full are identical here: the
   grid is the whole enumeration and there is nothing more
   to sweep.

   A pin that fails against the engine is a FINDING; this
   module never adjusts a pin to make it pass. */

import { runRothCompare } from "../rothOptimizer";
import type {
  HardeningCheckModule,
  HardeningCheckResult,
  HardeningTeethResult,
} from "./types";
import {
  FILL_12_CEILINGS,
  FILL_22_CEILINGS,
  FILL_CLIFF_CEILINGS,
  sampleCompareBase,
} from "./sensCompareBase";

// Near-tie band: a pair whose base net-cost gap is at most
// this many cents may swap under perturbation, but only
// within the band — a swap wider than the band is a real
// reversal and fails. A pair separated by more than the
// band at base must hold its order outright; a pair that
// holds its order may widen by any amount.
const NEAR_TIE_BAND_CENTS = 500000; // $5,000

const dollars = (cents: number): string =>
  `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

/* ---- The four fixed strategies ----------------------------------
   Do Nothing is ceilings: null (no conversion ever fills).
   Fill to cliff caps MAGI at the cliff less a $5,000 buffer
   (see FILL_CLIFF_CEILINGS in sensCompareBase). */
const STRATEGIES = [
  { key: "doNothing", name: "Do Nothing", ceilings: null },
  { key: "fill12", name: "Fill 12%", ceilings: FILL_12_CEILINGS },
  { key: "fill22", name: "Fill 22%", ceilings: FILL_22_CEILINGS },
  { key: "fillCliff", name: "Fill to cliff", ceilings: FILL_CLIFF_CEILINGS },
] as const;

type StrategyKey = (typeof STRATEGIES)[number]["key"];

/* ---- The perturbation grid: 9 runs including base ---------------
   Spending ±$1,000/yr (annualSpendingCents 17,900,000 /
   18,100,000 against the $180,000/yr base), return ±0.25%
   (expectedReturnPct 4.75 / 5.25 against the 5% base), and
   the four corners. Each point spreads a fresh base so no
   run mutates the shared shape. */
const GRID = [
  { label: "base", spendDeltaCents: 0, returnDeltaPct: 0 },
  { label: "spend -$1,000", spendDeltaCents: -100000, returnDeltaPct: 0 },
  { label: "spend +$1,000", spendDeltaCents: 100000, returnDeltaPct: 0 },
  { label: "return -0.25%", spendDeltaCents: 0, returnDeltaPct: -0.25 },
  { label: "return +0.25%", spendDeltaCents: 0, returnDeltaPct: 0.25 },
  {
    label: "spend -$1,000 / return -0.25%",
    spendDeltaCents: -100000,
    returnDeltaPct: -0.25,
  },
  {
    label: "spend -$1,000 / return +0.25%",
    spendDeltaCents: -100000,
    returnDeltaPct: 0.25,
  },
  {
    label: "spend +$1,000 / return -0.25%",
    spendDeltaCents: 100000,
    returnDeltaPct: -0.25,
  },
  {
    label: "spend +$1,000 / return +0.25%",
    spendDeltaCents: 100000,
    returnDeltaPct: 0.25,
  },
] as const;

type GridRow = {
  label: string;
  costs: Record<StrategyKey, number>;
  // Winner-first ranking of strategy keys for this run.
  ranking: StrategyKey[];
};

type Corrupt = { reverseFirstPinnedPair: true };

function runSet(corrupt?: Corrupt): {
  failures: string[];
  counts: Record<string, number>;
  rows: GridRow[];
  baseRanking: StrategyKey[];
  minGapCents: number;
  minGapLabel: string;
} {
  const failures: string[] = [];
  const rows: GridRow[] = [];
  let minGapCents = Number.POSITIVE_INFINITY;
  let minGapLabel = "";

  for (const point of GRID) {
    const base = sampleCompareBase();
    // sampleCompareBase always sets both fields; the ?? 0 is
    // type-narrowing only (both are number | null on the
    // saved shape).
    base.annualSpendingCents = (base.annualSpendingCents ?? 0) + point.spendDeltaCents;
    base.expectedReturnPct = (base.expectedReturnPct ?? 0) + point.returnDeltaPct;
    const result = runRothCompare(
      base,
      STRATEGIES.map((s) => ({
        name: s.name,
        overrides: { ceilings: s.ceilings },
      })),
      2026,
    );
    if (!result.ok) {
      failures.push(
        `caps run ${point.label}: compare failed — ${result.reason}`,
      );
      continue;
    }
    const costs = {} as Record<StrategyKey, number>;
    for (const s of STRATEGIES) {
      const priced = result.scenarios.find((r) => r.name === s.name);
      if (priced == null) {
        failures.push(
          `caps run ${point.label}: scenario "${s.name}" missing from the compare result`,
        );
        continue;
      }
      costs[s.key] = priced.netCostCents;
    }
    if (Object.keys(costs).length !== STRATEGIES.length) continue;
    const ranking = [...STRATEGIES]
      .sort((a, b) => costs[a.key] - costs[b.key])
      .map((s) => s.key);
    rows.push({ label: point.label, costs, ranking });
    // Smallest pairwise gap anywhere in this run.
    for (let i = 0; i < STRATEGIES.length; i++) {
      for (let j = i + 1; j < STRATEGIES.length; j++) {
        const a = STRATEGIES[i]!.key;
        const b = STRATEGIES[j]!.key;
        const gap = Math.abs(costs[a] - costs[b]);
        if (gap < minGapCents) {
          minGapCents = gap;
          const aName = STRATEGIES[i]!.name;
          const bName = STRATEGIES[j]!.name;
          minGapLabel = `${aName} vs ${bName} at ${point.label}`;
        }
      }
    }
  }

  const baseRow = rows[0];
  if (baseRow == null) {
    return {
      failures,
      counts: { runs: rows.length, strategies: STRATEGIES.length, failures: failures.length },
      rows,
      baseRanking: [],
      minGapCents: minGapCents === Number.POSITIVE_INFINITY ? 0 : minGapCents,
      minGapLabel,
    };
  }
  const baseRanking = baseRow.ranking;
  const baseWinner = baseRanking[0]!;

  // Teeth: the first pinned pair, whose comparison is
  // reversed when corrupt is set (see runCapsTeeth). The
  // reversal happens inside the real pair-order loop below,
  // never in a side-channel assertion — so if that loop were
  // deleted or its comparison flipped, teeth would fail.
  let corruptPair: string | null = null;
  if (corrupt?.reverseFirstPinnedPair === true) {
    for (let i = 0; corruptPair === null && i < STRATEGIES.length; i++) {
      for (let j = i + 1; j < STRATEGIES.length; j++) {
        const a = STRATEGIES[i]!.key;
        const b = STRATEGIES[j]!.key;
        if (Math.abs(baseRow.costs[a] - baseRow.costs[b]) > NEAR_TIE_BAND_CENTS) {
          corruptPair = `${a}:${b}`;
          break;
        }
      }
    }
  }

  // (a) The winner is the same strategy in every run.
  // (b) For every pair whose BASE gap exceeds the near-tie
  // band, the relative order is identical in every run.
  // A pair within the band may swap, but only within the
  // band — a wider swap is a real reversal and fails, and
  // holding the order never fails however far the gap
  // widens (at base only Do Nothing / Fill 12% is within
  // the band).
  for (const row of rows) {
    if (row.ranking[0] !== baseWinner) {
      const winnerName = STRATEGIES.find((s) => s.key === row.ranking[0])!.name;
      const baseWinnerName = STRATEGIES.find((s) => s.key === baseWinner)!.name;
      failures.push(
        `caps winner ${row.label}: winner is ${winnerName}, base winner is ${baseWinnerName}`,
      );
    }
    for (let i = 0; i < STRATEGIES.length; i++) {
      for (let j = i + 1; j < STRATEGIES.length; j++) {
        const a = STRATEGIES[i]!.key;
        const b = STRATEGIES[j]!.key;
        const aName = STRATEGIES[i]!.name;
        const bName = STRATEGIES[j]!.name;
        const baseGap = Math.abs(baseRow.costs[a] - baseRow.costs[b]);
        const baseOrder = baseRow.costs[a] < baseRow.costs[b] ? -1 : 1;
        const runOrder = row.costs[a] < row.costs[b] ? -1 : 1;
        if (baseGap <= NEAR_TIE_BAND_CENTS) {
          // Near-tie: a swap is allowed, but only within
          // the band. A swap wider than the band is a real
          // reversal and fails; holding the order never
          // fails, however far the gap widens.
          if (runOrder !== baseOrder) {
            const runGap = Math.abs(row.costs[a] - row.costs[b]);
            if (runGap > NEAR_TIE_BAND_CENTS) {
              failures.push(
                `caps order ${row.label}: ${aName} (${dollars(row.costs[a])}) vs ${bName} (${dollars(row.costs[b])}) reversed the base order by ${dollars(runGap)} — beyond the $5,000 near-tie band (base gap ${dollars(baseGap)})`,
              );
            }
          }
          continue;
        }
        const isCorruptPair = corruptPair !== null && `${a}:${b}` === corruptPair;
        const orderHeld = runOrder === baseOrder;
        const violated = isCorruptPair ? orderHeld : !orderHeld;
        if (violated) {
          failures.push(
            isCorruptPair
              ? `caps order ${row.label} (reversed expectation): ${aName} vs ${bName} held the base order`
              : `caps order ${row.label}: ${aName} (${dollars(row.costs[a])}) vs ${bName} (${dollars(row.costs[b])}) reversed the base order (base gap ${dollars(baseGap)})`,
          );
        }
      }
    }
  }

  // Pairs pinned by the band: base gap above it, so their
  // order must hold in every run.
  let pairsPinned = 0;
  let nearTies = 0;
  for (let i = 0; i < STRATEGIES.length; i++) {
    for (let j = i + 1; j < STRATEGIES.length; j++) {
      const a = STRATEGIES[i]!.key;
      const b = STRATEGIES[j]!.key;
      if (Math.abs(baseRow.costs[a] - baseRow.costs[b]) > NEAR_TIE_BAND_CENTS) {
        pairsPinned++;
      } else {
        nearTies++;
      }
    }
  }

  return {
    failures,
    counts: {
      runs: rows.length,
      strategies: STRATEGIES.length,
      pairs: (STRATEGIES.length * (STRATEGIES.length - 1)) / 2,
      pairsPinned,
      nearTies,
      minGapCents: minGapCents === Number.POSITIVE_INFINITY ? 0 : minGapCents,
      failures: failures.length,
    },
    rows,
    baseRanking,
    minGapCents: minGapCents === Number.POSITIVE_INFINITY ? 0 : minGapCents,
    minGapLabel,
  };
}

function resultFrom(
  id: string,
  name: string,
  set: ReturnType<typeof runSet>,
): HardeningCheckResult {
  const pass = set.failures.length === 0;
  const rankingText = (ranking: StrategyKey[]): string =>
    ranking
      .map((k) => STRATEGIES.find((s) => s.key === k)!.name)
      .join(" < ");
  const rankingLines = set.rows
    .map((r) => `${r.label}: ${rankingText(r.ranking)}`)
    .join("; ");
  return {
    id,
    name,
    pass,
    detail: pass
      ? `Conversion-cap net-cost ordering stable under all ${set.counts.runs} perturbations (spending ±$1,000, return ±0.25%, four corners): base order ${rankingText(set.baseRanking)}; winner ${STRATEGIES.find((s) => s.key === set.baseRanking[0])!.name} in every run; ${set.counts.pairsPinned} of ${set.counts.pairs} pairs pinned above the $5,000 near-tie band (${set.counts.nearTies} near-tie allowed to swap within the band); smallest pairwise gap anywhere ${dollars(set.minGapCents)} (${set.minGapLabel}). Rankings — ${rankingLines}.`
      : `${set.failures.length} conversion-cap ordering violation(s); base order ${rankingText(set.baseRanking)}; smallest pairwise gap anywhere ${dollars(set.minGapCents)} (${set.minGapLabel}). Rankings — ${rankingLines}; see failures.`,
    failures: set.failures.slice(0, 25),
    counts: set.counts,
  };
}

const CHECK_ID = "sens-caps";
const CHECK_NAME =
  "Sensitivity: conversion-cap net-cost ordering stable under small perturbations";

function runCapsFast(): HardeningCheckResult {
  return resultFrom(CHECK_ID, CHECK_NAME, runSet());
}

function runCapsFull(): HardeningCheckResult {
  // Identical to fast: the 9-run grid is the whole
  // enumeration and there is nothing more to sweep.
  return resultFrom(CHECK_ID, CHECK_NAME, runSet());
}

function runCapsTeeth(): HardeningTeethResult {
  // The clean run must pass first.
  const clean = runSet();
  if (clean.failures.length !== 0) {
    return {
      corruptedCaseId: "sens-caps:clean-run-failed",
      failedCount: clean.failures.length,
      pass: false,
    };
  }
  // Corrupt the comparison inside the real pair-order
  // loop: the first pinned pair's expected order is
  // reversed, so every run where that pair holds its order
  // (all 9 on current data) must fail with the reversed
  // expectation, and nothing else must. The corrupted run
  // re-prices the same grid with the comparison reversed —
  // the re-price is the loop's own cost, not a side
  // channel: a deleted or flipped pair-order loop would
  // fail teeth, which the old synthetic expectation
  // (require Fill 12% to beat Fill 22%) could not detect.
  const corruptedCaseId = "caps first pinned pair order reversed";
  const set = runSet({ reverseFirstPinnedPair: true });
  return {
    corruptedCaseId,
    failedCount: set.failures.length,
    pass:
      set.failures.length === set.rows.length &&
      set.failures.every((f) => f.includes("(reversed expectation)")),
  };
}

export const sensCapsCheck: HardeningCheckModule = {
  id: CHECK_ID,
  name: CHECK_NAME,
  runFast: runCapsFast,
  runFull: runCapsFull,
  runTeeth: runCapsTeeth,
};
