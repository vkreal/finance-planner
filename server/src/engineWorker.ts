// Engine Review C7 architecture (§1.1) — worker entry.
//
// A thin loop: receive { jobId, kind, payload, detail }, call the
// engine function, post the result back. It imports the SAME engine
// modules as the main thread — no re-implementation, no duplicated
// pricing code — so the worker changes the THREAD, not the math,
// and results are bit-identical to the in-thread path (§1.6).
//
// The worker is STATELESS: it calls the UNMEMOIZED
// computeJointOptimizer directly, never the memoized
// runJointOptimizer — a worker that populated its own
// module-level joint cache would duplicate the main-thread cache
// in full-result form and defeat the compact cache (§2). The cache
// lives on the main thread only.
//
// Return shape: `detail: "full"` posts the entire result (Phase 1:
// every job). `detail: "summary"` is the Phase 2 compact summary
// (JointOptimizerSummary) — not implemented yet; a summary job
// posted to this worker fails loudly instead of silently
// returning a full result.
//
// Engine throws (e.g. RangeError on invalid Monte Carlo options)
// are caught and posted back as { name, message } — the pool
// re-creates the same error kind on the main thread, so validation
// behavior is unchanged. No stack crosses to the client, ever.
//
// Assigning onmessage is harmless when this module is imported
// in-thread (no messages ever arrive there); as a worker entry it
// is the message handler (same idiom as the C7 probe worker).
import {
  computeJointOptimizer,
  optimizerHeirSensitivity,
  optimizerSensitivity,
  runOptimizer,
  runRothMonteCarloCheck,
  runRothMonteCarloStats,
} from "./rothOptimizer";
import { runMonteCarlo, solveMaxSpending } from "./retirementEngines";

type JobMessage = {
  jobId: number;
  kind: string;
  payload: any;
  detail?: "full" | "summary";
};

function runJob(msg: JobMessage): unknown {
  if (msg.detail === "summary") {
    // Phase 2 (compact cache) implements the summary return.
    // Fail loudly: silently returning a full result here would
    // defeat the byte budget the summary exists to enforce.
    throw new Error("engine worker: detail \"summary\" is not implemented yet (Phase 2)");
  }
  const p = msg.payload;
  switch (msg.kind) {
    case "joint":
    case "workYearsJoint":
      return computeJointOptimizer(p.inputs);
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
    default:
      throw new Error(`engine worker: unknown job kind ${JSON.stringify(msg.kind)}`);
  }
}

(globalThis as any).onmessage = (e: { data: JobMessage }) => {
  const msg = e.data;
  try {
    const result = runJob(msg);
    (globalThis as any).postMessage({ jobId: msg.jobId, ok: true, result });
  } catch (err) {
    (globalThis as any).postMessage({
      jobId: msg?.jobId,
      ok: false,
      error: {
        name: err instanceof Error ? err.name : "Error",
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
};
