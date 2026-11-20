// Engine Review C7 architecture (§1.1) — engine job runner.
//
// The job function the worker entry calls, factored out verbatim so
// the pool and the worker execute the IDENTICAL function: the
// worker entry (engineWorker.ts) delegates to runEngineJob, and
// the pool's standalone in-thread fallback (enginePool.ts) calls
// it directly when no worker file exists beside the bundle. The
// runner changes the CALLER, not the math — results are
// bit-identical to the in-thread path (§1.6).
//
// The worker is STATELESS: it calls the UNMEMOIZED
// computeJointOptimizer directly, never the memoized
// runJointOptimizer — a worker that populated its own
// module-level joint cache would duplicate the main-thread cache
// in full-result form and defeat the compact cache (§2). The cache
// lives on the main thread only.
//
// Return shape: `detail: "full"` returns the entire result.
// `detail: "summary"` (Phase 2 compact cache, §2.2) returns the
// compact JointOptimizerSummary for the joint kinds — the caller
// computes the FULL result, compacts it, and returns the summary,
// so the full result never exists on the main thread in the
// production path. Other kinds have no summary shape: a summary
// job for one fails loudly instead of silently returning a full
// result.
//
// Engine throws (e.g. RangeError on invalid Monte Carlo options)
// propagate as-is — the worker entry posts the error's name +
// message back and the pool re-creates the same error kind on the
// main thread; the pool's in-thread fallback settles with the
// original error. Validation behavior is unchanged either way.
// No stack crosses to the client, ever.
import {
  compactJointOptimizerResult,
  computeJointOptimizer,
  optimizerHeirSensitivity,
  optimizerSensitivity,
  runDynamicOptimizer,
  runOptimizer,
  runRothMonteCarloCheck,
  runRothMonteCarloStats,
} from "./rothOptimizer";
import { runMonteCarlo, solveMaxSpending } from "./retirementEngines";

export type EngineJobMessage = {
  jobId: number;
  kind: string;
  payload: any;
  detail?: "full" | "summary";
};

export function runEngineJob(msg: EngineJobMessage): unknown {
  if (
    msg.detail === "summary" &&
    msg.kind !== "joint" &&
    msg.kind !== "workYearsJoint"
  ) {
    // Only the joint kinds have a summary shape: silently returning
    // a full result here would defeat the byte budget the summary
    // exists to enforce. Fail loudly instead.
    throw new Error(
      `engine worker: detail "summary" is not supported for job kind ${JSON.stringify(msg.kind)}`,
    );
  }
  const p = msg.payload;
  switch (msg.kind) {
    case "joint":
    case "workYearsJoint": {
      const full = computeJointOptimizer(p.inputs);
      // Phase 2 (§2.1–§2.2): the production miss path returns the
      // compact summary; "full" is the fixture mode, which bypasses
      // the main-thread cache entirely.
      return msg.detail === "summary" ? compactJointOptimizerResult(full) : full;
    }
    case "fixedAge":
      return runOptimizer(p.inputs, { searchOrders: p.searchOrders ?? true });
    case "sensitivity":
      return optimizerSensitivity(p.inputs, p.deltaPct);
    case "heirSensitivity":
      return optimizerHeirSensitivity(p.inputs, p.heirRatePct);
    case "mcCheck":
      return runRothMonteCarloCheck(p.inputs, p.winner, p.doNothing, p.opts);
    case "mcStats":
      return runRothMonteCarloStats(p.base, p.scenarios, p.startYear, p.opts);
    case "retirementMc":
      return runMonteCarlo(p.inputs, p.expected, p.vol, p.seed, p.runCount);
    case "solver":
      return solveMaxSpending(
        p.inputs,
        p.stocksPct,
        p.expected,
        p.vol,
        p.engine,
        p.targetPct,
        p.mcSeed,
      );
    case "dynamicOptimizer":
      // SHOULD-1 (§1.2 rule: any call over ~2 s CPU on the
      // sample household moves to the pool — 15.3 s CPU here).
      // Full result (no summary shape for this kind).
      return runDynamicOptimizer(p.inputs, p.opts);
    default:
      throw new Error(`engine worker: unknown job kind ${JSON.stringify(msg.kind)}`);
  }
}
