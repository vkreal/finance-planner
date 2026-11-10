/* ---------------- Trinity benchmark known-answer pin ----------------
   Part 3 of the hardening block (known-answer checks). Wires
   the EXISTING Trinity benchmark anchor — runTrinityBenchmark()
   in retirementFixtures.ts — into the hardening registry as a
   registered check. Nothing here re-derives the published
   figures or duplicates the benchmark: the module calls the
   existing function and restates the fixture's own
   comparison (app rate within ±6 points of the published
   rate) against TRINITY_PUBLISHED — it does not read the
   result's withinTolerance flag, the comparison is
   re-derived, and it is equivalent to the fixture's.

   The pin: the 4% rule — a $1,000,000 portfolio, retire at
   65, constant real spending of $40,000/yr, 30-year horizon —
   priced through the Historical engine (runHistorical) at a
   50/50 and a 75/25 stock/bond mix, against Cooley, Hubbard
   & Walz (1998), the Trinity Study, Table 3
   (inflation-adjusted, 30-year, 4%): 50/50 = 95% success,
   75/25 = 98%. The published rates and the ±6-point
   tolerance are read from the fixture module's own
   TRINITY_PUBLISHED constant, not restated here.

   Exact equality is NOT the pass bar, by the anchor's own
   design: the published study replays 1926–1995 Ibbotson
   data with corporate bonds; this app replays 1928–2025
   data blending in the 10-year Treasury, and under the
   inclusive horizon prices 31 years (68 windows) rather
   than the study's 30 — each app rate is set against the
   published 30-year figure as an explainable-by-method
   neighbourhood check (see the anchor's comment in
   retirementFixtures.ts).

   Runtime: ~20 ms per invocation (two Historical runs
   over 68 windows each) — cheap enough for the fast run.
   Fast and full are identical: the benchmark is two mixes
   and nothing more to enumerate.

   A pin that fails against the engine is a FINDING; this
   module never adjusts a pin to make it pass. */

import {
  runTrinityBenchmark,
  TRINITY_PUBLISHED,
} from "../retirementFixtures";
import type {
  HardeningCheckModule,
  HardeningCheckResult,
  HardeningTeethResult,
} from "./types";

type PinFailure = string;

type Corrupt = { mix: string; deltaPoints: number };

function runSet(corrupt?: Corrupt): {
  failures: PinFailure[];
  counts: Record<string, number>;
  rates: { mix: string; app: number; published: number; windows: number }[];
} {
  const failures: PinFailure[] = [];
  const rates: { mix: string; app: number; published: number; windows: number }[] = [];
  const results = runTrinityBenchmark();
  for (const r of results) {
    let published = r.publishedSuccessRate;
    if (corrupt && corrupt.mix === r.mix) {
      published = published + corrupt.deltaPoints;
    }
    rates.push({ mix: r.mix, app: r.appSuccessRate, published, windows: r.windows });
    if (Math.abs(r.appSuccessRate - published) > TRINITY_PUBLISHED.tolerancePoints) {
      failures.push(
        `trinity ${r.mix}: app ${r.appSuccessRate}% vs published ${published}% (tolerance ±${TRINITY_PUBLISHED.tolerancePoints} points, ${r.windows} windows)`,
      );
    }
  }
  return {
    failures,
    counts: { mixes: results.length, windows: results[0]?.windows ?? 0, failures: failures.length },
    rates,
  };
}

function resultFrom(
  id: string,
  name: string,
  set: { failures: PinFailure[]; counts: Record<string, number>; rates: { mix: string; app: number; published: number; windows: number }[] },
): HardeningCheckResult {
  const pass = set.failures.length === 0;
  const rateText = set.rates
    .map((r) => `${r.mix} app ${r.app}% vs published ${r.published}% (${r.windows} windows)`)
    .join("; ");
  return {
    id,
    name,
    pass,
    detail: pass
      ? `Trinity benchmark (Cooley, Hubbard & Walz 1998, Table 3) all pass within ±${TRINITY_PUBLISHED.tolerancePoints} points: ${rateText}.`
      : `${set.failures.length} Trinity mix(es) outside tolerance — ${rateText}; see failures.`,
    failures: set.failures.slice(0, 25),
    counts: set.counts,
  };
}

function runTrinityFast(): HardeningCheckResult {
  return resultFrom(
    "known-trinity",
    "Known-answer Trinity benchmark: 4% rule vs Cooley, Hubbard & Walz (1998), Table 3",
    runSet(),
  );
}

function runTrinityFull(): HardeningCheckResult {
  // Identical to fast: the benchmark is two mixes and
  // there is nothing more to enumerate.
  return resultFrom(
    "known-trinity",
    "Known-answer Trinity benchmark: 4% rule vs Cooley, Hubbard & Walz (1998), Table 3",
    runSet(),
  );
}

function runTrinityTeeth(): HardeningTeethResult {
  // The clean run must pass first.
  const clean = runSet();
  if (clean.failures.length !== 0) {
    return {
      corruptedCaseId: "known-trinity:clean-run-failed",
      failedCount: clean.failures.length,
      pass: false,
    };
  }
  // Corrupt one published rate by 7 points — one past the
  // ±6-point tolerance, so exactly that mix must fail (the
  // app 50/50 rate sits below the published 95%, so +7
  // moves the published figure away from it; the 75/25
  // mix is untouched and must keep passing).
  // Only the 50/50 pin is corruption-tested: a re-introduced
  // 75/25 pin of 100 still passes tolerance (5.9 ≤ 6), so a
  // matching 75/25 corruption leg (+7 → 105, diff 10.9) would
  // be needed to cover both pins — recorded as an option for a
  // later pick, not built here.
  const corruptedCaseId = "trinity 50/50 publishedRate";
  const set = runSet({ mix: "50/50", deltaPoints: 7 });
  return {
    corruptedCaseId,
    failedCount: set.failures.length,
    pass: set.failures.length === 1 && set.failures[0]?.startsWith("trinity 50/50") === true,
  };
}

export const knownTrinityCheck: HardeningCheckModule = {
  id: "known-trinity",
  name: "Known-answer Trinity benchmark: 4% rule vs Cooley, Hubbard & Walz (1998), Table 3",
  runFast: runTrinityFast,
  runFull: runTrinityFull,
  runTeeth: runTrinityTeeth,
};
