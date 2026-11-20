// Engine Review C7 architecture (§1.7, §4.3) — /health under load,
// proven through an ACTUAL MCP tool call.
//
// Starts the real assistant-api server, starts a full-scope optimizer
// job (retirement_roth_conversion, comparisonScope "full", 6y horizon —
// the smallest full optimizer) through a raw JSON-RPC tools/call POST
// to /mcp, and polls /health every 250 ms while the worker burns:
// every poll must answer in <1 s (the A2 measurement it replaces:
// 295,409 ms). The adapter prices through the engine pool in this
// build, so the MCP call's CPU runs in a worker and the main thread's
// event loop — and /health — stay free.
//
// Load note: the 6y full optimizer is ~6 s of engine CPU but the
// worker deadline is a 100 s WALL deadline, and this VM stretches
// wall ~10x under load — at load ~12 the job times out with
// ENGINE_TIMEOUT (measured), at load ~4 it completes in ~77 s. The
// test's verdict is the /health polls, not the job: a timeout still
// proves the property (the worker burned for the full 100 s while
// every poll answered), so an ENGINE_TIMEOUT result is accepted and
// logged rather than failing the test.
//
// Run: bun test tests/engine-pool-health.test.ts
// (assistant-api tests run from assistant-api/; the pool import
// reaches server/src exactly as adapter.ts already does.)

import { describe, test, expect, afterAll } from "bun:test";
import { createServer } from "../src/server";
import { dispatchTool } from "../src/tools";
import { enginePool } from "../../server/src/enginePool";
import { FICTIONAL } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("assistant-api /health under worker load (C7 §1.7)", () => {
  test("every /health poll answers in <1 s while a full-scope optimizer job runs via MCP", async () => {
    const server = createServer({ port: 0, host: "127.0.0.1" });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      // Warm check: /health answers before the job starts.
      const warm = await fetch(`${base}/health`);
      expect(warm.status).toBe(200);
      expect((await warm.json() as { ok: unknown }).ok).toBe(true);

      // Warm the worker (pays the cold module import) with a tiny
      // Monte Carlo dispatch, so the measured job's wall is compute,
      // not import.
      const warmed: any = await dispatchTool("retirement_monte_carlo", {
        ...FICTIONAL,
        mcRuns: 200,
      });
      expect(warmed.ok).toBe(true);

      // Full-scope optimizer job through the MCP path: raw JSON-RPC
      // tools/call POST, not awaited — the polls run while it is in
      // flight.
      const mcp = fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "retirement_roth_conversion",
            arguments: { ...FICTIONAL, endAge: 60, comparisonScope: "full" },
          },
        }),
      });
      let settled = false;
      mcp.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      const latencies: number[] = [];
      while (!settled) {
        const t0 = Date.now();
        const res = await fetch(`${base}/health`);
        latencies.push(Date.now() - t0);
        expect(res.status).toBe(200);
        await sleep(250);
      }
      expect(latencies.length).toBeGreaterThan(10);
      const max = Math.max(...latencies);
      console.log(`[health-under-load] polls=${latencies.length} maxMs=${max}`);
      expect(max).toBeLessThan(1000);

      const rpc: any = await (await mcp).json();
      if (rpc.error) {
        // Known load artifact (see header): the worker burned for
        // the full deadline while every /health poll answered.
        expect(rpc.error.code).toBe(-32000);
        expect(rpc.error.data?.code).toBe("ENGINE_TIMEOUT");
        console.log("[health-under-load] job timed out (load artifact); polls still prove /health");
      } else {
        const content = rpc.result?.structuredContent;
        expect(content?.ok).toBe(true);
        expect(content?.results?.comparisonScope?.evaluatedCandidates).toBe(3025);
      }
    } finally {
      server.stop();
    }
  }, 300_000);
});

afterAll(() => {
  // The pool's workers keep the event loop alive otherwise.
  enginePool.shutdown();
});
