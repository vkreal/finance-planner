// Engine Review C7 architecture (§1.1) — worker entry.
//
// A thin loop: receive { jobId, kind, payload, detail }, call the
// engine function via runEngineJob (engineJobRunner.ts — the same
// function the pool's standalone in-thread fallback calls
// directly), post the result back. It imports the SAME engine
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
// Return shape: `detail: "full"` posts the entire result.
// `detail: "summary"` (Phase 2 compact cache, §2.2) posts the
// compact JointOptimizerSummary for the joint kinds — the worker
// computes the FULL result, compacts it in-worker, and posts back
// the summary, so the full result never exists on the main thread
// in the production path. Other kinds have no summary shape: a
// summary job for one fails loudly instead of silently returning
// a full result.
//
// Engine throws (e.g. RangeError on invalid Monte Carlo options)
// are caught and posted back as { name, message } — the pool
// re-creates the same error kind on the main thread, so validation
// behavior is unchanged. No stack crosses to the client, ever.
//
// Assigning onmessage is harmless when this module is imported
// in-thread (no messages ever arrive there); as a worker entry it
// is the message handler (same idiom as the C7 probe worker).
import { runEngineJob, type EngineJobMessage } from "./engineJobRunner";

(globalThis as any).onmessage = (e: { data: EngineJobMessage }) => {
  const msg = e.data;
  try {
    const result = runEngineJob(msg);
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
