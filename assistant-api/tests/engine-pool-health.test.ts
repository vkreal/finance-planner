// Engine Review C7 architecture (§1.7, §4.3) — /health under load.
//
// Starts the real assistant-api server, dispatches a full-scope
// optimizer job through the engine pool in-process, and polls
// /health every 250 ms while the worker burns: every poll must
// answer in <1 s (the A2 measurement it replaces: 295,409 ms).
//
// The pool lives in server/src and is shared by both processes;
// the assistant-api's MCP tools still price in-thread in this
// build (dispatchTool is synchronous end-to-end — migrating the
// adapter is a follow-on), so this test proves the mechanism in
// this process: a worker burning CPU leaves the main thread's
// event loop — and /health — free.
//
// Run: bun test tests/engine-pool-health.test.ts
// (assistant-api tests run from assistant-api/; the pool import
// reaches server/src exactly as adapter.ts already does.)

import { describe, test, expect, afterAll } from "bun:test";
import { createServer } from "../src/server";
import { dispatchEngineJob, enginePool } from "../../server/src/enginePool";
import { jointInputsKey } from "../../server/src/rothOptimizer";
import { jointSmall } from "../../server/src/performanceShapes";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("assistant-api /health under worker load (C7 §1.7)", () => {
  test("every /health poll answers in <1 s while a full-scope optimizer job runs", async () => {
    const server = createServer({ port: 0, host: "127.0.0.1" });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      // Warm check: /health answers before the job starts.
      const warm = await fetch(`${base}/health`);
      expect(warm.status).toBe(200);
      expect((await warm.json() as { ok: unknown }).ok).toBe(true);

      // Full-scope optimizer job (5y 1-combo joint — the
      // heaviest shape that completes on this VM) through the
      // pool. The promise is awaited at the end; the polls run
      // while it is in flight.
      const { promise: job } = dispatchEngineJob<any>(
        "joint",
        jointInputsKey(jointSmall()),
        { inputs: jointSmall() },
        { detail: "full" },
      );
      const latencies: number[] = [];
      let done = false;
      job.then(
        () => {
          done = true;
        },
        () => {
          done = true;
        },
      );
      while (!done) {
        const t0 = Date.now();
        const res = await fetch(`${base}/health`);
        latencies.push(Date.now() - t0);
        expect(res.status).toBe(200);
        await sleep(250);
      }
      expect(latencies.length).toBeGreaterThan(0);
      const max = Math.max(...latencies);
      console.log(
        `[health-under-load] polls=${latencies.length} maxMs=${max}`,
      );
      expect(max).toBeLessThan(1000);
      const result = await job;
      expect(result.candidatesTested).toBe(3025);
    } finally {
      server.stop();
    }
  }, 300_000);
});

afterAll(() => {
  // The pool's workers keep the event loop alive otherwise.
  enginePool.shutdown();
});
