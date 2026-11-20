// Engine Review C7 architecture (§1.2, §1.4, §4.3) — pool live
// behavior as exercised through the assistant-api adapter path.
//
// The pool itself is covered in server/src/enginePool.test.ts (fresh
// pools, direct dispatch). These tests go through dispatchTool — the
// adapter the MCP server calls — and assert the typed error surface
// (ENGINE_TIMEOUT / ENGINE_BUSY / ENGINE_CRASH, retryable, no stacks)
// plus the HTTP mapping (BUSY → 429 with Retry-After, CRASH →
// JSON-RPC -32000 with data {code, retryable}).
//
// Timeout through the adapter is exercised by the parity salary leg
// (expected ENGINE_TIMEOUT in bun form on this VM — the known load
// artifact), not by a 100 s test here.
//
// Run: bun test tests/engine-pool-adapter.test.ts

import { describe, test, expect, afterAll } from "bun:test";
import { createServer } from "../src/server";
import { dispatchTool } from "../src/tools";
import { enginePool } from "../../server/src/enginePool";
import { FICTIONAL } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForStarted(baseline: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (enginePool.poolStats().started > baseline) return;
    await sleep(50);
  }
  throw new Error("worker job never started");
}

describe("engine pool live behavior via the adapter (C7 §1.2, §1.4)", () => {
  test("dedup: two concurrent identical MC calls share one worker execution", async () => {
    const before = enginePool.poolStats();
    const args = { ...FICTIONAL, mcRuns: 5000 };
    const [a, b]: any[] = await Promise.all([
      dispatchTool("retirement_monte_carlo", args),
      dispatchTool("retirement_monte_carlo", args),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    const after = enginePool.poolStats();
    expect(after.started - before.started).toBeGreaterThanOrEqual(1);
    expect(after.deduped - before.deduped).toBeGreaterThanOrEqual(1);
  }, 300_000);

  test("queue-full: the 10th concurrent SMALL dispatch returns ENGINE_BUSY, the rest complete", async () => {
    const before = enginePool.poolStats();
    // Distinct seeds so nothing dedups; 1 runs + 8 queue + 1 busy.
    const jobs = Array.from({ length: 10 }, (_, i) =>
      dispatchTool("retirement_monte_carlo", {
        ...FICTIONAL,
        mcRuns: 1000,
        mcSeed: 1000 + i,
      }),
    );
    const results: any[] = await Promise.all(jobs);
    const busy = results.filter((r) => !r.ok && r.error?.code === "ENGINE_BUSY");
    const ok = results.filter((r) => r.ok);
    expect(busy.length).toBeGreaterThanOrEqual(1);
    expect(ok.length + busy.length).toBe(10);
    for (const r of busy) {
      expect(r.error.retryable).toBe(true);
      expect(r.error.message).not.toMatch(/at\s+\S+:\d+:\d+/);
    }
    expect(enginePool.poolStats().busy - before.busy).toBeGreaterThanOrEqual(1);
  }, 300_000);

  test("crash recovery: a worker killed mid-job yields ENGINE_CRASH and the lane respawns", async () => {
    const before = enginePool.poolStats();
    const startedBefore = before.started;
    const job = dispatchTool("retirement_monte_carlo", {
      ...FICTIONAL,
      mcRuns: 5000,
    });
    await waitForStarted(startedBefore);
    enginePool.__testTerminateLaneWorker("small");
    const res: any = await job;
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe("ENGINE_CRASH");
    expect(res.error.retryable).toBe(true);
    expect(res.error.message).not.toMatch(/at\s+\S+:\d+:\d+/);
    expect(enginePool.poolStats().crashes - before.crashes).toBeGreaterThanOrEqual(1);
    // The lane respawned: the same call serves normally now.
    const retry: any = await dispatchTool("retirement_monte_carlo", {
      ...FICTIONAL,
      mcRuns: 200,
    });
    expect(retry.ok).toBe(true);
    expect(retry.results.runs).toBe(200);
  }, 300_000);

  test("server mapping: BUSY → 429 with Retry-After, CRASH → JSON-RPC -32000", async () => {
    const server = createServer({ port: 0, host: "127.0.0.1" });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const call = (args: Record<string, unknown>, id: number) =>
        fetch(`${base}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name: "retirement_monte_carlo", arguments: args },
          }),
        });

      // BUSY: occupy the SMALL lane (1 running + 8 queued), then
      // the MCP call is the 10th dispatch.
      const background = Array.from({ length: 9 }, (_, i) =>
        dispatchTool("retirement_monte_carlo", {
          ...FICTIONAL,
          mcRuns: 5000,
          mcSeed: 2000 + i,
        }),
      );
      const busyRes = await call(
        { ...FICTIONAL, mcRuns: 5000, mcSeed: 2999 },
        1,
      );
      expect(busyRes.status).toBe(429);
      expect(busyRes.headers.get("retry-after")).toBe("5");
      const busyBody: any = await busyRes.json();
      expect(busyBody.error.code).toBe("engine_busy");
      expect(busyBody.error.retryAfterSeconds).toBe(5);
      await Promise.all(background);

      // CRASH: start an MCP call, kill the lane worker mid-job.
      const startedBefore = enginePool.poolStats().started;
      const crashCall = call(
        { ...FICTIONAL, mcRuns: 5000, mcSeed: 3000 },
        2,
      );
      await waitForStarted(startedBefore);
      enginePool.__testTerminateLaneWorker("small");
      const crashRpc: any = await (await crashCall).json();
      expect(crashRpc.error.code).toBe(-32000);
      expect(crashRpc.error.data.code).toBe("ENGINE_CRASH");
      expect(crashRpc.error.data.retryable).toBe(true);
    } finally {
      server.stop();
    }
  }, 300_000);
});

afterAll(() => {
  enginePool.shutdown();
});
