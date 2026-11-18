// Engine Review C7 (§8) — performance regression harness.
//
// Repeatable benchmarks as committed tests. Every budget below is a
// CPU-time budget — NEVER wall time: on this shared VM wall time
// inflates several-fold with sibling load — the NaN cold joint leg
// ran 91.9 s wall against ~2.75 s CPU (~33×) — while the leg's own
// CPU time is what the audit measured as stable across runs for the
// harnessed shapes (audit-blocking.md: three runOptimizer runs
// 21,480 / 22,060 / 21,628 ms CPU against wall times 139,875 /
// 213,814 / 197,088 ms). The qualification matters: the all-orders
// 5y shape is deliberately not harnessed because its CPU spread
// ~3× across processes (6,595 vs 18,899 ms), so "stable" holds for
// the harnessed shapes, not for every shape. The 300 s per-test
// wall timeout on the NaN leg has only ~3.3× headroom under current
// load (91.9 s observed) — worth the note, not a budget change.
// Each budget cites the measured baseline it derives from, with a
// wide margin; a budget without a cited measurement is not
// acceptable.
//
// HOW A BUDGET IS MEASURED (SHOULD-2): each benchmark leg runs in
// a FRESH child process (performanceLegRunner.ts, one leg per
// invocation), twice, and the budget asserts the MINIMUM CPU over
// the two attempts. The harness used to measure in the test
// process, where process.cpuUsage() is process-wide, so
// garbage-collection / JIT CPU from OTHER legs' retained results
// landed inside a leg's window — idle windows with zero leg work
// read tens to hundreds of milliseconds of CPU, and two full-file
// runs failed untouched budgets with ~13 s readings on legs whose
// own CPU is ~50 ms–1.5 s. A fresh process per attempt means no
// other leg's retained graph exists to be collected during the
// window; the minimum over two attempts discards a one-off burst
// in one of them. Ambient CPU only ever inflates a reading, never
// deflates it, so the minimum is the leg's own CPU — and a real
// regression inflates both attempts, so the guard still bites.
// Heap is measured in the same fresh process with NO forced GC
// (Bun.gc(true) corrupts Bun's heapUsed reading), exactly as the
// SHOULD-1 fresh-process probes did.
//
// All households are the fictional sample household
// (server/src/sampleHousehold.ts) or small derived variants —
// 5-year horizons, one draw order / one claiming-age combo / one
// quit age — so every workload completes on the 6 GB VM. The
// full-size shapes do NOT complete here (audit-blocking.md: the
// 81-combo joint OOMs; a 2-age work-years call never returned),
// which is why the harness pins small shapes, not full ones.
//
// Each benchmark asserts: completion, determinism (same inputs →
// identical outputs on re-run, here across two fresh processes),
// structural counts, and a CPU budget. Heap is asserted only as
// a loose upper bound on the measured delta (Bun's heapUsed is a
// high-water mark, so only the growth delta at the call is
// meaningful — audit-cache.md).
//
// Run per-file (whole-suite bun test in one process OOMs on
// this VM): bun test server/src/performanceRegression.test.ts
//
// No file-level wall bound: six benchmark tests at 600 s each, so
// a fully hung file would take ~56 min to fail (each test still
// fails loudly within its own 600 s). No file-level timeout is
// added — that would change test-runner behaviour beyond this note.

import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { jointInputsKey, runJointOptimizer } from "./rothOptimizer";
import { jointSmall } from "./performanceShapes";
import type { LegName, LegOutput } from "./performanceLegRunner";

// --- Fresh-process leg runs ------------------------------------------
// Runs one benchmark leg in a fresh child process
// (performanceLegRunner.ts) and returns the JSON it prints. A leg
// that fails, times out, or prints unparseable stdout fails the
// calling test with the child's stderr attached, so a broken
// runner can never silently pass a budget.
const LEG_RUNNER = join(import.meta.dir, "performanceLegRunner.ts");
// Per-child wall timeout: each test spawns twice inside a 600 s
// test timeout, so 280 s per child leaves room for both attempts.
// Work-years per-child wall headroom is the tightest in the file:
// worst observed ~193 s per child (386.99 s test wall under load)
// vs this 280 s timeout — 1.45× headroom, tighter than joint's
// 1.72× (162.7 s). A child timeout fails the test loudly (spawn
// timeout → runner error), never hangs. No timeout change.
const LEG_TIMEOUT_MS = 280_000;
// Grace period after SIGTERM before escalating to SIGKILL (NICE-1p).
const LEG_KILL_GRACE_MS = 5_000;

async function spawnLeg<L extends LegName>(
  leg: L,
): Promise<Extract<LegOutput, { leg: L }>> {
  const proc = Bun.spawn([process.execPath, LEG_RUNNER, leg], {
    stdout: "pipe",
    stderr: "pipe",
  });
  // Async spawn with SIGKILL escalation (NICE-1p): Bun.spawnSync's
  // `timeout` sends SIGTERM once and does NOT escalate, and Bun's
  // dangling-process kill is also SIGTERM-only, so a SIGTERM-ignoring
  // child would hang the whole `bun test` invocation and leak as an
  // orphan. The trigger is unreachable in this build — zero signal
  // handlers anywhere in server/src, zero spawn/exec sites in the
  // runner's import closure, every child the runner can produce dies
  // on SIGTERM — so this is defense-in-depth, not a fix for a live
  // hang: on timeout, SIGTERM first, then SIGKILL after a short
  // grace period, and the test fails loudly within its budget.
  let timedOut = false;
  const killTimer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGTERM");
    } catch {
      // Already exited; nothing to kill.
    }
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Already exited; nothing to kill.
      }
    }, LEG_KILL_GRACE_MS);
  }, LEG_TIMEOUT_MS);
  const exitCode = await proc.exited;
  clearTimeout(killTimer);
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  if (timedOut) {
    throw new Error(
      `leg runner ${leg} timed out after ${LEG_TIMEOUT_MS} ms (SIGTERM, then SIGKILL escalation): ${stderr}`,
    );
  }
  if (exitCode !== 0) {
    throw new Error(
      `leg runner ${leg} failed (exit ${exitCode}, signal ${proc.signalCode ?? "none"}): ${stderr}`,
    );
  }
  const trimmed = stdout.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(
      `leg runner ${leg} printed unparseable stdout: ${trimmed}\nstderr: ${stderr}`,
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { leg?: unknown }).leg !== leg ||
    !Array.isArray((parsed as { runs?: unknown }).runs) ||
    (parsed as { runs: unknown[] }).runs.length === 0
  ) {
    throw new Error(
      `leg runner ${leg} printed an unexpected shape: ${trimmed}\nstderr: ${stderr}`,
    );
  }
  for (const run of (parsed as { runs: Record<string, unknown>[] }).runs) {
    if (
      typeof run.cpuMs !== "number" ||
      !Number.isFinite(run.cpuMs) ||
      typeof run.heapDeltaMb !== "number" ||
      !Number.isFinite(run.heapDeltaMb)
    ) {
      throw new Error(
        `leg runner ${leg} printed a run without numeric cpuMs/heapDeltaMb: ${trimmed}`,
      );
    }
  }
  return parsed as Extract<LegOutput, { leg: L }>;
}

// The budget asserts the MINIMUM CPU over the two fresh-process
// attempts: ambient CPU only ever inflates a reading, so the
// minimum is the leg's own CPU.
function minCpu(runs: readonly { cpuMs: number }[]): number {
  return Math.min(...runs.map((r) => r.cpuMs));
}

// Log the min CPU (and heap) per leg when each test completes, so a
// passing run records its margin evidence (NICE-4c). The tests
// assert on spawnLeg's output, not on console output, so logging
// changes no assertion.
function logLegMargin(
  leg: string,
  runs: readonly { cpuMs: number; heapDeltaMb: number }[],
): void {
  console.log(
    `[perf-margin] ${leg} minCpuMs=${minCpu(runs).toFixed(1)} heapDeltaMb=[${runs.map((r) => r.heapDeltaMb.toFixed(1)).join(", ")}]`,
  );
}

// ---------------------------------------------------------------------------
// Joint cache key — C7 A4 collision fix
//
// A4 proved jointInputsKey collided NaN with null because
// JSON.stringify(NaN) is `null`: a cold NaN run priced netCost NaN,
// and the following null call returned in hit time with netCost NaN,
// while a fresh null run prices finite ($383,753.13 on the full-size
// plan). In file order the null-first test below captures the true
// null result before any NaN entry exists, and the later tests prove
// each non-finite variant is served its own entry, never another's.
// Each later test also captures its own null baseline when run in
// isolation (a cache hit is cheap in file order, a cold run alone),
// so no test depends on an earlier test having run.
// ---------------------------------------------------------------------------
describe("joint cache key distinguishes non-finite values from null (C7 A4)", () => {
  test("finite inputs key exactly as before the fix", () => {
    // The pre-fix algorithm, reproduced inline: sorted keys +
    // plain JSON.stringify. The fix must not move any finite key,
    // or valid inputs would lose their cache hits.
    const legacyKey = (v: unknown): string => {
      const sortValue = (x: unknown): unknown => {
        if (Array.isArray(x)) return x.map(sortValue);
        if (x != null && typeof x === "object") {
          const out: Record<string, unknown> = {};
          for (const k of Object.keys(x as Record<string, unknown>).sort()) {
            out[k] = sortValue((x as Record<string, unknown>)[k]);
          }
          return out;
        }
        return x;
      };
      return JSON.stringify(sortValue(v));
    };
    const finite = jointSmall();
    expect(jointInputsKey(finite)).toBe(legacyKey(finite));
    // The same inputs built a second time key identically —
    // the key depends on values, not object identity.
    const rebuilt = jointSmall({ pretaxStart: finite.pretaxStart });
    expect(jointInputsKey(rebuilt)).toBe(jointInputsKey(finite));
  });

  test("NaN / Infinity / -Infinity / null all key differently", () => {
    const base = jointSmall();
    const keys = new Set([
      jointInputsKey(base),
      jointInputsKey(jointSmall({ pretaxStart: NaN })),
      jointInputsKey(jointSmall({ pretaxStart: Infinity })),
      jointInputsKey(jointSmall({ pretaxStart: -Infinity })),
      jointInputsKey(jointSmall({ pretaxStart: null as never })),
    ]);
    expect(keys.size).toBe(5);
    // Non-finite values in a nested position key differently too.
    expect(jointInputsKey(jointSmall({ taxableBasisPct: NaN }))).not.toBe(
      jointInputsKey(jointSmall({ taxableBasisPct: null as never })),
    );
  });

  // Captured by the null-first cold run; the NaN/null tests below
  // compare against it. Runs first so no NaN entry exists yet.
  let nullNetCost: number | undefined;

  // The null baseline for the later tests: in file order it is the
  // null-first test's capture (a cache hit is cheap); run in
  // isolation it prices the null run itself, so the later tests
  // are self-sufficient and never throw "null baseline was not
  // captured" for want of an earlier test.
  function captureNullBaseline(): number {
    if (typeof nullNetCost !== "number") {
      const r = runJointOptimizer(jointSmall({ pretaxStart: null as never }));
      const net = r.selectedWinner?.cost.netCost;
      if (typeof net !== "number" || !Number.isFinite(net)) {
        throw new Error("null baseline did not price finite");
      }
      nullNetCost = net;
    }
    return nullNetCost;
  }
  test("null pretaxStart cold run prices finite (the true null result)", () => {
    const r = runJointOptimizer(jointSmall({ pretaxStart: null as never }));
    const net = r.selectedWinner?.cost.netCost;
    expect(typeof net).toBe("number");
    expect(Number.isFinite(net)).toBe(true);
    if (typeof net !== "number") throw new Error("expected a numeric netCost");
    nullNetCost = net;
  }, 300_000);

  test("NaN after null returns the NaN result, not the null entry", () => {
    const r = runJointOptimizer(jointSmall({ pretaxStart: NaN }));
    const net = r.selectedWinner?.cost.netCost;
    expect(typeof net).toBe("number");
    expect(Number.isNaN(net)).toBe(true);
    if (typeof net !== "number") throw new Error("expected a numeric netCost");
    expect(net).not.toBe(captureNullBaseline());
  }, 300_000);

  test("null after NaN returns the finite null result (A4 reproduction)", () => {
    const r = runJointOptimizer(jointSmall({ pretaxStart: null as never }));
    expect(r.selectedWinner?.cost.netCost).toBe(captureNullBaseline());
  }, 300_000);

  // NOTE — no behavioral test runs a cold Infinity joint search:
  // probe C found it pathologically slow (~260 s CPU and still
  // running, vs 2,750 ms CPU for the equivalent NaN run), an
  // engine pathology for validation territory (C6), not this
  // build. Infinity is pinned at the key level only, by the
  // distinct-keys test above: with distinct keys it can never
  // be served another input's cached result, whatever it prices
  // to on a cold run.
});

// ---------------------------------------------------------------------------
// §8 performance regression harness
//
// Each test below spawns its leg twice, each time in a fresh child
// process, and asserts the MINIMUM CPU over the two attempts
// against the unchanged budget (see the header: the fresh process
// removes other legs' retained work from the window, and the
// minimum discards a one-off ambient burst in one attempt).
// Determinism is asserted across the two fresh processes.
// ---------------------------------------------------------------------------
describe("C7 §8 performance regression harness (CPU budgets, small shapes)", () => {
  test("fixed-age runOptimizer, 1 draw order, 5y: completes, deterministic, 505 candidates", async () => {
    const a = await spawnLeg("fixedAge");
    const b = await spawnLeg("fixedAge");
    const [first, second] = [a.runs[0], b.runs[0]];
    expect(first.candidatesTested).toBe(505);
    expect(second.candidatesTested).toBe(505);
    expect(Number.isFinite(first.winnerNetCost)).toBe(true);
    expect(Number.isFinite(second.winnerNetCost)).toBe(true);
    expect(second.digest).toBe(first.digest);
    // Baseline: probe A measured 1,453 / 1,348 ms CPU on this
    // 5y shape; audit-blocking.md measured 4,838 ms CPU for the
    // same 1-order search on the 38y sample plan. Budget 10,000
    // ms CPU is ~7× the 5y baseline and ~2× the 38y figure.
    expect(minCpu([first, second])).toBeLessThanOrEqual(10_000);
    // Heap growth at the call: probe A measured +8.3 MB.
    expect(first.heapDeltaMb).toBeLessThanOrEqual(128);
    expect(second.heapDeltaMb).toBeLessThanOrEqual(128);
    logLegMargin("fixedAge", [first, second]);
  }, 600_000);

  test("joint optimizer, 1 combo, 5y: cold completes, hit is identical, counts hold", async () => {
    const a = await spawnLeg("joint");
    const b = await spawnLeg("joint");
    const [coldA, hitA] = a.runs;
    const [coldB, hitB] = b.runs;
    expect(coldA.combosTested).toBe(1);
    expect(coldA.candidatesTested).toBe(3025);
    expect(Number.isFinite(coldA.winnerNetCost)).toBe(true);
    expect(hitA.combosTested).toBe(1);
    expect(coldB.combosTested).toBe(1);
    expect(coldB.candidatesTested).toBe(3025);
    expect(hitB.combosTested).toBe(1);
    expect(hitA.digest).toBe(coldA.digest);
    expect(coldB.digest).toBe(coldA.digest);
    expect(hitB.digest).toBe(coldA.digest);
    // Baselines: probe A measured 3,558 ms CPU cold and 892 ms
    // CPU for the hit on this 5y shape; audit-cache.md measured
    // 470 ms CPU cold (3y, 1 combo) and 941 ms CPU for a hit
    // (5y clone). Budgets are ~5× the 5y baselines.
    expect(minCpu([coldA, coldB])).toBeLessThanOrEqual(20_000);
    expect(minCpu([hitA, hitB])).toBeLessThanOrEqual(5_000);
    // Heap growth at the call: probe A measured +62.8 MB cold,
    // +43.6 MB on the hit (result + stored clone on a miss;
    // cached + returned clone on a hit).
    expect(coldA.heapDeltaMb).toBeLessThanOrEqual(256);
    expect(hitA.heapDeltaMb).toBeLessThanOrEqual(256);
    expect(coldB.heapDeltaMb).toBeLessThanOrEqual(256);
    expect(hitB.heapDeltaMb).toBeLessThanOrEqual(256);
    logLegMargin("joint-cold", [coldA, coldB]);
    logLegMargin("joint-hit", [hitA, hitB]);
  }, 600_000);

  test("runRothCompare, 3 scenarios, 38y: completes, deterministic, 3 priced", async () => {
    const a = await spawnLeg("compare");
    const b = await spawnLeg("compare");
    const [first, second] = [a.runs[0], b.runs[0]];
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.scenarios.length).toBe(3);
    expect(second.scenarios.length).toBe(3);
    for (const s of first.scenarios) {
      expect(Number.isFinite(s.netCostCents)).toBe(true);
      expect(s.years).toBe(38);
    }
    expect(second.scenarios).toEqual(first.scenarios);
    // Baseline: probe A measured 16 ms CPU for 3 scenarios;
    // audit-blocking.md measured 146 ms CPU for 4 scenarios
    // (620 ms for 50). Budget 5,000 ms CPU is ~30× the
    // 4-scenario baseline.
    expect(minCpu([first, second])).toBeLessThanOrEqual(5_000);
    // Heap growth at the call: a fresh-process probe measured
    // +4.1 MB (two runs agreeing; heap-probe.ts). The 0.0 MB
    // delta in measure.log is a high-water artifact — the
    // earlier joint legs had already set the heap at 161.9 MB
    // — not a baseline, so it is not cited. Budget 128 MB
    // is ~30× the measured growth.
    expect(first.heapDeltaMb).toBeLessThanOrEqual(128);
    expect(second.heapDeltaMb).toBeLessThanOrEqual(128);
    logLegMargin("compare", [first, second]);
  }, 600_000);

  test("retirement Monte Carlo, 1,000 runs: completes, deterministic, 1,000 runs", async () => {
    const a = await spawnLeg("mc");
    const b = await spawnLeg("mc");
    const [first, second] = [a.runs[0], b.runs[0]];
    expect(first.successRate).toBe(97.5);
    expect(first.neverOutSuccessRate).toBe(97.5);
    expect(Number.isFinite(first.p50)).toBe(true);
    expect(second.successRate).toBe(97.5);
    expect(second.neverOutSuccessRate).toBe(97.5);
    expect(Number.isFinite(second.p50)).toBe(true);
    expect(second.resultJson).toBe(first.resultJson);
    // Baseline: probe A measured 49 / 24 ms CPU;
    // audit-blocking.md measured 45 ms CPU for 1,000 runs.
    // Budget 2,000 ms CPU is ~40× the baseline.
    expect(minCpu([first, second])).toBeLessThanOrEqual(2_000);
    // Heap growth at the call: a fresh-process probe measured
    // +3.8 / +3.9 MB (two runs; heap-probe.ts). The 0.0 MB
    // delta in measure.log is a high-water artifact — the
    // earlier joint legs had already set the heap at 161.9 MB
    // — not a baseline, so it is not cited. Budget 128 MB
    // is ~30× the measured growth.
    expect(first.heapDeltaMb).toBeLessThanOrEqual(128);
    expect(second.heapDeltaMb).toBeLessThanOrEqual(128);
    logLegMargin("mc", [first, second]);
  }, 600_000);

  test("solveMaxSpending constant/Monte Carlo 85%: completes, deterministic, feasible", async () => {
    const a = await spawnLeg("solver");
    const b = await spawnLeg("solver");
    const [first, second] = [a.runs[0], b.runs[0]];
    expect(first.solutionStatus).toBe("feasible");
    expect(first.maxSpendingCents).toBe(22_710_000);
    expect(first.successRate).toBe(85.1);
    expect(second.solutionStatus).toBe("feasible");
    expect(second.maxSpendingCents).toBe(22_710_000);
    expect(second.successRate).toBe(85.1);
    expect(second.resultJson).toBe(first.resultJson);
    // Baseline: probe A measured 316 / 274 ms CPU;
    // audit-stress.md measured 202 ms CPU for this solver path
    // (the guardrails/MC path, 9,745 ms CPU, is deliberately
    // not harnessed — it is the priciest solver path and would
    // dominate the file's wall time under load).
    // Budget 5,000 ms CPU is ~15× the baseline.
    expect(minCpu([first, second])).toBeLessThanOrEqual(5_000);
    // Heap growth at the call: a fresh-process probe measured
    // +5.6 / +4.6 MB on the first call (two runs; heap-probe.ts),
    // and a second call in the same fresh process adds ~6.5 MB
    // more (~12 MB cumulative). The 0.0 MB first-call delta in
    // measure.log is a high-water artifact — the earlier joint
    // legs had already set the heap at 161.9 MB — not a
    // baseline, so it is not cited. Budget 256 MB is ~45× the
    // first-call growth and ~20× the two-call cumulative.
    expect(first.heapDeltaMb).toBeLessThanOrEqual(256);
    expect(second.heapDeltaMb).toBeLessThanOrEqual(256);
    logLegMargin("solver", [first, second]);
  }, 600_000);

  test("work-years, 1 quit age, small shape: completes, deterministic, 1 row", async () => {
    const a = await spawnLeg("workYears");
    const b = await spawnLeg("workYears");
    const [first, second] = [a.runs[0], b.runs[0]];
    expect(first.rows.length).toBe(1);
    expect(second.rows.length).toBe(1);
    const row = first.rows[0]!;
    expect(row.quitAge).toBe(63);
    expect(row.workYears).toBe(1);
    // The defining property of the SS-locked 1-combo shape: the
    // rolled joint search tested exactly one claiming-age combo.
    expect(row.combosTested).toBe(1);
    expect(Number.isFinite(row.allInTax)).toBe(true);
    expect(Number.isFinite(row.endingAfterTax)).toBe(true);
    const secondRow = second.rows[0]!;
    expect(secondRow.quitAge).toBe(63);
    expect(secondRow.workYears).toBe(1);
    expect(secondRow.combosTested).toBe(1);
    expect(Number.isFinite(secondRow.allInTax)).toBe(true);
    expect(Number.isFinite(secondRow.endingAfterTax)).toBe(true);
    expect(second.rows).toEqual(first.rows);
    // Baseline: probe E measured 5,869 ms CPU cold (551 ms on
    // the repeat — the rolled joint hits the module cache) and
    // +49.3 MB heap on this SS-locked 1-age shape;
    // audit-blocking.md measured ~25,400 ms CPU per quit age on
    // the full 38y no-SS shape, and the unlocked-SS variant of
    // this small shape searches ~72 claiming-age combos (probe B:
    // still running after 10+ minutes). Budget 30,000 ms CPU is
    // ~5× the locked-shape baseline.
    expect(minCpu([first, second])).toBeLessThanOrEqual(30_000);
    expect(first.heapDeltaMb).toBeLessThanOrEqual(256);
    expect(second.heapDeltaMb).toBeLessThanOrEqual(256);
    logLegMargin("workYears", [first, second]);
  }, 600_000);
});
