// Engine Review C7 architecture (§1, §4.3) — live-behavior tests
// for the worker pool.
//
// Every test uses its own small EnginePool instance (small queue
// caps / short deadlines where the test needs them) so no test
// depends on the process-wide singleton's state. All workloads
// are the fictional sample household (performanceShapes) or small
// derived variants — the 5-year 1-combo joint and the 1,000-run
// retirement Monte Carlo — so every test completes on the 6 GB VM.
//
// Run per-file: bun test server/src/enginePool.test.ts
// (whole-suite bun test in one process OOMs on this VM).
// The pool's workers are long-lived by design; each test's pool
// spawns workers lazily, and the process exits explicitly at the
// end of the file (the §3.4 bundled-process exit linger: a
// terminated worker can keep a short-lived process alive idle —
// the production pool is long-lived so it is moot there, but the
// test harness must not hang on it).

import { describe, test, expect, afterAll } from "bun:test";
import { EnginePool, EngineError, stableEngineKey } from "./enginePool";
import { jointInputsKey, runJointOptimizer, runOptimizer } from "./rothOptimizer";
import { runMonteCarlo } from "./retirementEngines";
import { jointSmall, sampleRetirement, small5y } from "./performanceShapes";
import { createHash } from "node:crypto";

// Every pool made here is shut down in afterAll: workers keep
// the event loop alive otherwise (§3.4).
const pools: EnginePool[] = [];
function makePool(opts?: ConstructorParameters<typeof EnginePool>[0]): EnginePool {
  const pool = new EnginePool(opts);
  pools.push(pool);
  return pool;
}
afterAll(() => {
  for (const pool of pools) pool.shutdown();
});

function stable(v: unknown): unknown {
  if (typeof v === "number") {
    if (Number.isNaN(v)) return { __nonFinite__: "NaN" };
    if (v === Infinity) return { __nonFinite__: "Infinity" };
    if (v === -Infinity) return { __nonFinite__: "-Infinity" };
    if (Object.is(v, -0)) return { __nonFinite__: "-0" };
    return v;
  }
  if (Array.isArray(v)) return v.map(stable);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = stable((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}
const digest = (v: unknown): string =>
  createHash("sha256").update(JSON.stringify(stable(v))).digest("hex");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("engine pool job keys", () => {
  test("stableEngineKey distinguishes non-finite values from null", () => {
    const base = jointSmall();
    const keys = new Set([
      stableEngineKey(base),
      stableEngineKey(jointSmall({ pretaxStart: NaN })),
      stableEngineKey(jointSmall({ pretaxStart: Infinity })),
      stableEngineKey(jointSmall({ pretaxStart: -Infinity })),
      stableEngineKey(jointSmall({ pretaxStart: null as never })),
    ]);
    expect(keys.size).toBe(5);
    // Finite values key exactly like jointInputsKey (the same
    // rule, so joint dedup keys match the cache keys).
    expect(stableEngineKey(base)).toBe(jointInputsKey(base));
  });
});

describe("engine pool parity (worker vs in-thread, §1.6)", () => {
  test("joint 1-combo 5y: worker result is digest-identical to in-thread", async () => {
    const pool = makePool();
    const inThread = runJointOptimizer(jointSmall());
    const { promise } = pool.dispatch<any>(
      "joint",
      jointInputsKey(jointSmall()),
      { inputs: jointSmall() },
      { detail: "full" },
    );
    const viaWorker = await promise;
    expect(viaWorker.candidatesTested).toBe(inThread.candidatesTested);
    expect(viaWorker.selectedWinner.cost.netCost).toBe(
      inThread.selectedWinner.cost.netCost,
    );
    expect(digest(viaWorker)).toBe(digest(inThread));
  }, 300_000);

  test("fixed-age 1-order 5y: worker result is digest-identical to in-thread", async () => {
    const pool = makePool();
    const inThread = runOptimizer(small5y(), { searchOrders: false });
    const { promise } = pool.dispatch<any>(
      "fixedAge",
      stableEngineKey({ inputs: small5y(), searchOrders: false }),
      { inputs: small5y(), searchOrders: false },
      { detail: "full" },
    );
    const viaWorker = await promise;
    expect(viaWorker.candidatesTested).toBe(inThread.candidatesTested);
    expect(viaWorker.selectedWinner.cost.netCost).toBe(
      inThread.selectedWinner.cost.netCost,
    );
    expect(digest(viaWorker)).toBe(digest(inThread));
  }, 300_000);

  test("retirement Monte Carlo 1,000 runs: worker result equals in-thread", async () => {
    const pool = makePool();
    const built = sampleRetirement();
    const inThread = runMonteCarlo(built.inputs, built.expected, built.vol, 12345, 1000);
    const { promise } = pool.dispatch<any>(
      "retirementMc",
      stableEngineKey({ inputs: built.inputs, expected: built.expected, vol: built.vol, seed: 12345, runCount: 1000 }),
      { inputs: built.inputs, expected: built.expected, vol: built.vol, seed: 12345, runCount: 1000 },
      { detail: "full" },
    );
    const viaWorker = await promise;
    expect(JSON.stringify(viaWorker)).toBe(JSON.stringify(inThread));
  }, 300_000);
});

describe("engine pool live behavior (§4.3)", () => {
  test("timeout: a job past its deadline returns ENGINE_TIMEOUT, the worker stops, the next job serves normally", async () => {
    const pool = makePool({ jobTimeoutMs: 100 });
    const { promise } = pool.dispatch<any>(
      "joint",
      jointInputsKey(jointSmall()),
      { inputs: jointSmall() },
      { detail: "full" },
    );
    let err: unknown;
    try {
      await promise;
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).code).toBe("ENGINE_TIMEOUT");
    expect((err as EngineError).retryable).toBe(true);
    expect((err as Error).message).toMatch(/100 s budget/);
    // The LARGE lane respawned: the same joint serves normally
    // now (with a full deadline — the pool's 100 ms test
    // deadline would time it out again).
    const { promise: next } = pool.dispatch<any>(
      "joint",
      jointInputsKey(jointSmall()),
      { inputs: jointSmall() },
      { timeoutMs: 100_000, detail: "full" },
    );
    const res = await next;
    expect(res.candidatesTested).toBe(3025);
    expect(pool.poolStats().timeouts).toBeGreaterThanOrEqual(1);
  }, 300_000);

  test("queue-full: dispatch past the per-lane cap returns ENGINE_BUSY, queued jobs still complete", async () => {
    const pool = makePool({ queueCap: 1 });
    const built = sampleRetirement();
    const mcPayload = {
      inputs: built.inputs,
      expected: built.expected,
      vol: built.vol,
      seed: 12345,
      runCount: 1000,
    };
    // Same lane (SMALL), distinct keys: first runs, second
    // queues, third is rejected immediately. The nonce varies
    // only the dedup key — the payload (and therefore the
    // 97.5 pin, seed 12345) is identical for all three.
    const h1 = pool.dispatch<any>("retirementMc", stableEngineKey({ ...mcPayload, nonce: 1 }), mcPayload, { detail: "full" });
    const h2 = pool.dispatch<any>("retirementMc", stableEngineKey({ ...mcPayload, nonce: 2 }), mcPayload, { detail: "full" });
    const h3 = pool.dispatch<any>("retirementMc", stableEngineKey({ ...mcPayload, nonce: 3 }), mcPayload, { detail: "full" });
    let busy: unknown;
    try {
      await h3.promise;
    } catch (e) {
      busy = e;
    }
    expect(busy).toBeInstanceOf(EngineError);
    expect((busy as EngineError).code).toBe("ENGINE_BUSY");
    expect((busy as EngineError).retryable).toBe(true);
    const [r1, r2] = await Promise.all([h1.promise, h2.promise]);
    expect(r1.successRate).toBe(97.5);
    expect(r2.successRate).toBe(97.5);
    expect(pool.poolStats().busy).toBeGreaterThanOrEqual(1);
  }, 300_000);

  test("crash recovery: a worker killed mid-job yields ENGINE_CRASH and the lane respawns", async () => {
    const pool = makePool();
    const { promise } = pool.dispatch<any>(
      "joint",
      jointInputsKey(jointSmall()),
      { inputs: jointSmall() },
      { detail: "full" },
    );
    // Wait until the job has started in the worker, then kill
    // the lane worker from outside the pool (as a crash would).
    for (let i = 0; i < 100; i++) {
      if (pool.poolStats().started >= 1) break;
      await sleep(100);
    }
    expect(pool.poolStats().started).toBeGreaterThanOrEqual(1);
    pool.__testTerminateLaneWorker("large");
    let err: unknown;
    try {
      await promise;
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).code).toBe("ENGINE_CRASH");
    expect((err as EngineError).retryable).toBe(true);
    // The lane respawned: the same job serves normally now.
    const { promise: retry } = pool.dispatch<any>(
      "joint",
      jointInputsKey(jointSmall()),
      { inputs: jointSmall() },
      { detail: "full" },
    );
    const res = await retry;
    expect(res.candidatesTested).toBe(3025);
    expect(pool.poolStats().crashes).toBeGreaterThanOrEqual(1);
  }, 300_000);

  test("dedup: two identical concurrent joint jobs run once and agree", async () => {
    const pool = makePool();
    const key = jointInputsKey(jointSmall());
    const h1 = pool.dispatch<any>("joint", key, { inputs: jointSmall() }, { detail: "full" });
    const h2 = pool.dispatch<any>("joint", key, { inputs: jointSmall() }, { detail: "full" });
    const [r1, r2] = await Promise.all([h1.promise, h2.promise]);
    expect(r1.selectedWinner.cost.netCost).toBe(r2.selectedWinner.cost.netCost);
    expect(digest(r1)).toBe(digest(r2));
    expect(pool.poolStats().started).toBe(1);
    expect(pool.poolStats().deduped).toBe(1);
  }, 300_000);

  test("dedup refcount: one waiter leaving does not stop the job; the last waiter leaving terminates it", async () => {
    const pool = makePool();
    const key = jointInputsKey(jointSmall());
    const h1 = pool.dispatch<any>("joint", key, { inputs: jointSmall() }, { detail: "full" });
    const h2 = pool.dispatch<any>("joint", key, { inputs: jointSmall() }, { detail: "full" });
    h1.release();
    // h2 still waits: the shared job completes for it.
    const r2 = await h2.promise;
    expect(r2.candidatesTested).toBe(3025);
    // A lone job whose only waiter leaves is terminated: the
    // lane records a termination and serves the next job.
    const h3 = pool.dispatch<any>(
      "joint",
      jointInputsKey(jointSmall({ pretaxStart: 1 })),
      { inputs: jointSmall({ pretaxStart: 1 }) },
      { detail: "full" },
    );
    const terminatedBefore = pool.poolStats().terminated;
    h3.release();
    await sleep(500);
    expect(pool.poolStats().terminated).toBeGreaterThan(terminatedBefore);
    const { promise: next } = pool.dispatch<any>(
      "joint",
      jointInputsKey(jointSmall()),
      { inputs: jointSmall() },
      { detail: "full" },
    );
    expect((await next).candidatesTested).toBe(3025);
  }, 300_000);
});
