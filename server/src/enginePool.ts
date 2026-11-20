// Engine Review C7 architecture (§1) — worker-thread pool for the
// heavy engine calls.
//
// One long-lived pool per process, two lanes (LARGE + SMALL, one
// worker each). Heavy engine work runs in a worker thread so the
// main thread's event loop stays free: a 21.6 s-CPU fixed-age run
// froze the loop 197,480 ms in-thread, and a full optimizer call
// over HTTP/MCP took 295,602 ms wall with /health delayed 295,409
// ms (audit-blocking.md). The pool sheds load instead of queueing
// unboundedly (per-lane FIFO cap 8 → ENGINE_BUSY), enforces a
// 100 s per-job deadline by hard termination (worker.terminate()
// + lane respawn), and deduplicates identical in-flight jobs.
//
// The worker is stateless: it calls the UNMEMOIZED engine
// functions (computeJointOptimizer et al.) and holds no cache.
// The cache lives on the main thread (rothOptimizer.ts). A
// terminated worker is never reused; its replacement starts cold,
// which is safe exactly because the worker holds no state.
//
// Transport is postMessage / structuredClone, which preserves
// numbers bit-exactly — including -0, NaN, Infinity, -Infinity
// (unlike JSON.stringify, which collapses NaN/Infinity to null).
//
// Error surface (the contract, §1.4): exactly three codes, all
// retryable, with a plain-language reason and no raw stack to the
// client. The raw stack / exit detail is logged server-side.
//   ENGINE_TIMEOUT — the job ran past its deadline and was stopped;
//     no result was produced, never a partial one.
//   ENGINE_BUSY — the lane queue was full on dispatch.
//   ENGINE_CRASH — the worker stopped unexpectedly mid-job.
// Engine validation throws (e.g. RangeError on invalid Monte Carlo
// options) are NOT engine errors: the worker posts the error's name
// + message back and the pool rethrows the same kind, so existing
// validation behavior is preserved.
//
// This module is process-agnostic: the space worker and the
// assistant-api server process each get their own pool by
// importing it (assistant-api imports server/src modules already).
// The worker file is resolved as ./engineWorker.js next to this
// file: Bun resolves the .js spelling to the .ts source when run
// unbundled, and to the built .js when run bundled (two-entry
// build: build:server-worker emits server/dist/engineWorker.js
// beside server/dist/actions.js — probe Q2).

// --- Config (single constants, §1.1/§1.3/§1.5) ---------------------
export const ENGINE_WORKER_POOL_SIZE = 2;
export const ENGINE_JOB_TIMEOUT_MS = 100_000;
export const ENGINE_QUEUE_CAP = 8;

export type EngineLane = "large" | "small";

// Job kinds (§1.2). The worker entry dispatches on kind; the pool
// does not know what a kind computes, only which lane it runs on.
export type EngineJobKind =
  | "joint"
  | "fixedAge"
  | "sensitivity"
  | "heirSensitivity"
  | "mcCheck"
  | "mcStats"
  | "workYearsJoint"
  | "retirementMc"
  | "solver"
  // SHOULD-1: the dynamic-withdrawal optimizer (15.3 s CPU on
  // the sample household — ~7× the §1.2 ~2 s migration rule),
  // SMALL lane: a fixed-horizon search, not a joint search.
  | "dynamicOptimizer";

export const ENGINE_JOB_LANE: Record<EngineJobKind, EngineLane> = {
  joint: "large",
  workYearsJoint: "large",
  fixedAge: "small",
  sensitivity: "small",
  heirSensitivity: "small",
  mcCheck: "small",
  mcStats: "small",
  retirementMc: "small",
  solver: "small",
  dynamicOptimizer: "small",
};

export type EngineErrorCode = "ENGINE_TIMEOUT" | "ENGINE_BUSY" | "ENGINE_CRASH";

const ENGINE_ERROR_REASONS: Record<EngineErrorCode, string> = {
  // The default timeout text names the pool's 100 s default
  // budget. Jobs dispatched with a shorter remaining budget get
  // a reason naming their own budget instead (NICE-2:
  // engineTimeoutReason, built from the job's allotted
  // timeoutMs at the settle site).
  ENGINE_TIMEOUT:
    "The search ran past its 100 s budget and was stopped; no result was produced. Try a narrower search (fewer claiming ages / shorter horizon) or try again.",
  ENGINE_BUSY: "The engine is busy; try again in a moment.",
  ENGINE_CRASH:
    "The engine worker stopped unexpectedly; the search was not completed.",
};

// NICE-2: the timeout reason names the budget the job actually
// got — a job dispatched 90 s into an action gets 10 s, not
// 100 s (§1.5) — so a caller is never told it "ran past its
// 100 s budget" when it only had seconds.
function formatBudgetMs(ms: number): string {
  if (ms >= 1000) {
    const s = ms / 1000;
    return `${Number.isInteger(s) ? s : s.toFixed(1)} s`;
  }
  return `${ms} ms`;
}

function engineTimeoutReason(timeoutMs: number): string {
  return `The search ran past its ${formatBudgetMs(timeoutMs)} budget and was stopped; no result was produced. Try a narrower search (fewer claiming ages / shorter horizon) or try again.`;
}

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly retryable = true as const;
  constructor(code: EngineErrorCode, reason?: string) {
    super(reason ?? ENGINE_ERROR_REASONS[code]);
    this.name = "EngineError";
    this.code = code;
  }
}

// Stable job key: sorted keys + distinct tokens for non-finite
// numbers, the same rule as jointInputsKey (rothOptimizer.ts) —
// plain JSON.stringify maps NaN, Infinity, -Infinity all to null,
// so without it a NaN job and a null job would dedup together.
// Finite values serialize exactly as JSON.stringify does.
export function stableEngineKey(value: unknown): string {
  const sortValue = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortValue);
    if (v != null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = sortValue((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  const nonFiniteReplacer = (_key: string, v: unknown): unknown => {
    if (typeof v === "number") {
      if (Number.isNaN(v)) return { __c7NonFinite__: "NaN" };
      if (v === Infinity) return { __c7NonFinite__: "Infinity" };
      if (v === -Infinity) return { __c7NonFinite__: "-Infinity" };
    }
    return v;
  };
  return JSON.stringify(sortValue(value), nonFiniteReplacer);
}

export interface EngineJobHandle<T> {
  promise: Promise<T>;
  // A waiter leaves (disconnects) without affecting the job;
  // when the LAST waiter leaves, the worker job is terminated
  // (§1.3 refcount rule). Callers that cannot disconnect simply
  // never call release — the job completes normally.
  release: () => void;
}

export interface EnginePoolStats {
  started: number;
  completed: number;
  deduped: number;
  timeouts: number;
  busy: number;
  crashes: number;
  terminated: number;
}

type WorkerMessage =
  | { jobId: number; ok: true; result: unknown }
  | {
      jobId: number;
      ok: false;
      error: { name: string; message: string };
    };

interface Job {
  id: number;
  lane: EngineLane;
  kind: EngineJobKind;
  dedupKey: string;
  payload: unknown;
  detail: "full" | "summary";
  deadline: number;
  // The budget this job was allotted at dispatch (§1.5): the
  // action's remaining budget, or the pool default. The timeout
  // reason names it (NICE-2), so a job that only got 10 s is
  // never told it ran past a 100 s budget.
  timeoutMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  // Waiters: each dispatch adds one resolve/reject pair. The job
  // settles every waiter; a waiter that releases removes its pair.
  // A deduped waiter carries its own deadline timer (NICE-3):
  // the first waiter's deadline IS the job's deadline (the job
  // timer governs it), but a later waiter may arrive with a much
  // shorter remaining budget of its own, and must not wait past
  // it for the shared job. Its timer rejects that waiter only —
  // the shared job keeps running for the others, unless it was
  // the last waiter, in which case the refcount rule terminates
  // the job as a release would.
  waiters: Array<{
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
    timer: ReturnType<typeof setTimeout> | null;
    timeoutMs: number | null;
  }>;
  started: boolean;
  settled: boolean;
}

interface LaneState {
  worker: Worker | null;
  // True once the crash path has run for the current worker, so
  // the error + close pair from one crash is handled once.
  crashHandled: boolean;
  running: Job | null;
  queue: Job[];
}

export interface EnginePoolOptions {
  // Per-lane FIFO cap (default ENGINE_QUEUE_CAP). Tests pass a
  // small cap to prove ENGINE_BUSY without pricing nine jobs.
  queueCap?: number;
  // Per-job deadline in ms (default ENGINE_JOB_TIMEOUT_MS).
  // Tests pass a short deadline to prove ENGINE_TIMEOUT fast.
  jobTimeoutMs?: number;
}

export class EnginePool {
  private nextJobId = 1;
  private lanes: Record<EngineLane, LaneState> = {
    large: { worker: null, crashHandled: false, running: null, queue: [] },
    small: { worker: null, crashHandled: false, running: null, queue: [] },
  };
  private inflight = new Map<string, Job>();
  private stats: EnginePoolStats = {
    started: 0,
    completed: 0,
    deduped: 0,
    timeouts: 0,
    busy: 0,
    crashes: 0,
    terminated: 0,
  };

  constructor(private readonly opts: EnginePoolOptions = {}) {}

  get queueCap(): number {
    return this.opts.queueCap ?? ENGINE_QUEUE_CAP;
  }

  get jobTimeoutMs(): number {
    return this.opts.jobTimeoutMs ?? ENGINE_JOB_TIMEOUT_MS;
  }

  poolStats(): EnginePoolStats {
    return { ...this.stats };
  }

  // Dispatch a job. `dedupKey` identifies identical jobs (same
  // lane + kind + key share one worker execution). `timeoutMs`
  // overrides the per-job deadline for this dispatch only — the
  // caller passes the action's remaining budget so a job's
  // effective deadline is min(actionDeadline, dispatch + 100 s)
  // (§1.5). `detail` selects the worker's return shape
  // ("summary" is the Phase 2 compact summary; Phase 1 always
  // passes "full").
  dispatch<T>(
    kind: EngineJobKind,
    dedupKey: string,
    payload: unknown,
    opts?: { timeoutMs?: number; detail?: "full" | "summary" },
  ): EngineJobHandle<T> {
    const lane = ENGINE_JOB_LANE[kind];
    const key = `${lane}:${kind}:${dedupKey}`;
    const existing = this.inflight.get(key);
    if (existing && !existing.settled) {
      this.stats.deduped++;
      // NICE-3: the deduped waiter gets its own deadline —
      // this dispatch's remaining budget, or the pool default
      // when the caller passed none — so a late caller with a
      // short budget is not held past it by the shared job.
      return this.attach(existing, opts?.timeoutMs ?? this.jobTimeoutMs);
    }
    const state = this.lanes[lane];
    if (state.queue.length >= this.queueCap) {
      this.stats.busy++;
      const err = new EngineError("ENGINE_BUSY");
      return {
        promise: Promise.reject(err),
        release: () => {},
      };
    }
    const timeoutMs = opts?.timeoutMs ?? this.jobTimeoutMs;
    const job: Job = {
      id: this.nextJobId++,
      lane,
      kind,
      dedupKey: key,
      payload,
      detail: opts?.detail ?? "full",
      deadline: Date.now() + Math.max(0, timeoutMs),
      timeoutMs,
      timer: null,
      waiters: [],
      started: false,
      settled: false,
    };
    this.inflight.set(key, job);
    // The first waiter's deadline is the job's own deadline —
    // no separate waiter timer (the job timer governs it).
    const handle = this.attach<T>(job);
    state.queue.push(job);
    job.timer = setTimeout(() => this.onDeadline(job), Math.max(0, timeoutMs));
    this.pump(lane);
    return handle;
  }

  // `waiterTimeoutMs` is set only for a deduped waiter
  // (NICE-3): its own deadline, independent of the shared
  // job's. The first waiter passes none — its deadline is the
  // job's deadline, governed by the job timer.
  private attach<T>(job: Job, waiterTimeoutMs?: number): EngineJobHandle<T> {
    let waiter!: {
      resolve: (v: unknown) => void;
      reject: (e: unknown) => void;
      timer: ReturnType<typeof setTimeout> | null;
      timeoutMs: number | null;
    };
    const promise = new Promise<T>((resolve, reject) => {
      waiter = {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer: null,
        timeoutMs: waiterTimeoutMs ?? null,
      };
    });
    // A rejected promise with no waiter yet would surface as an
    // unhandled rejection in Bun: attach a no-op catcher — the
    // caller's own await still observes the rejection.
    promise.catch(() => {});
    job.waiters.push(waiter);
    if (waiterTimeoutMs != null) {
      waiter.timer = setTimeout(() => {
        // This waiter's own deadline passed while the shared
        // job is still running: reject this waiter only. The
        // job keeps running for the other waiters; if this was
        // the last waiter, the refcount rule terminates it —
        // nobody needs it anymore.
        if (job.settled) return;
        const idx = job.waiters.indexOf(waiter);
        if (idx < 0) return;
        job.waiters.splice(idx, 1);
        waiter.timer = null;
        waiter.reject(
          new EngineError("ENGINE_TIMEOUT", engineTimeoutReason(waiterTimeoutMs)),
        );
        if (job.waiters.length === 0) {
          console.error(
            `[engine-pool] job ${job.id} (${job.kind}) terminated: last waiter left (own deadline)`,
          );
          this.terminateJob(job, null);
        }
      }, Math.max(0, waiterTimeoutMs));
    }
    let released = false;
    return {
      promise,
      release: () => {
        if (released) return;
        released = true;
        if (waiter.timer) {
          clearTimeout(waiter.timer);
          waiter.timer = null;
        }
        const idx = job.waiters.indexOf(waiter);
        if (idx >= 0) job.waiters.splice(idx, 1);
        if (job.waiters.length === 0 && !job.settled) {
          // Last waiter left: nobody needs this job. Terminate
          // it (§1.3) — no answer is owed to anyone.
          console.error(
            `[engine-pool] job ${job.id} (${job.kind}) terminated: last waiter left`,
          );
          this.terminateJob(job, null);
        }
      },
    };
  }

  private clearWaiterTimers(job: Job): void {
    for (const w of job.waiters) {
      if (w.timer) {
        clearTimeout(w.timer);
        w.timer = null;
      }
    }
  }

  private settle(job: Job, outcome: { ok: true; value: unknown } | { ok: false; error: unknown }): void {
    if (job.settled) return;
    job.settled = true;
    if (job.timer) {
      clearTimeout(job.timer);
      job.timer = null;
    }
    this.clearWaiterTimers(job);
    this.inflight.delete(job.dedupKey);
    const waiters = job.waiters.splice(0);
    for (const w of waiters) {
      if (outcome.ok) w.resolve(outcome.value);
      else w.reject(outcome.error);
    }
  }

  private pump(lane: EngineLane): void {
    const state = this.lanes[lane];
    if (state.running) return;
    // Drop queued jobs whose deadline already passed — starting
    // one would be pointless, since the caller is already gone.
    while (state.queue.length > 0) {
      const next = state.queue[0]!;
      if (Date.now() >= next.deadline) {
        state.queue.shift();
        this.stats.timeouts++;
        this.settle(next, {
          ok: false,
          error: new EngineError("ENGINE_TIMEOUT", engineTimeoutReason(next.timeoutMs)),
        });
        continue;
      }
      break;
    }
    const job = state.queue.shift();
    if (!job) return;
    const worker = this.ensureWorker(lane);
    state.running = job;
    job.started = true;
    this.stats.started++;
    try {
      worker.postMessage({
        jobId: job.id,
        kind: job.kind,
        payload: job.payload,
        detail: job.detail,
      });
    } catch (err) {
      // postMessage itself failed (unserializable payload):
      // treat as a crash of this job, keep the lane alive.
      state.running = null;
      this.settle(job, {
        ok: false,
        error: err instanceof Error ? err : new Error(String(err)),
      });
      this.pump(lane);
    }
  }

  private onDeadline(job: Job): void {
    if (job.settled) return;
    this.stats.timeouts++;
    if (this.lanes[job.lane].running === job) {
      console.error(
        `[engine-pool] job ${job.id} (${job.kind}) timed out after its deadline; terminating worker`,
      );
    } else {
      // Queued job: rejected without starting it (§1.3) — the
      // lane worker is untouched (MUST-1).
      console.error(
        `[engine-pool] job ${job.id} (${job.kind}) timed out while queued; dropping without starting it`,
      );
    }
    this.terminateJob(job, new EngineError("ENGINE_TIMEOUT", engineTimeoutReason(job.timeoutMs)));
  }

  // Hard termination (§1.4): worker.terminate() on the lane
  // worker, then spawn a fresh replacement. The terminated worker
  // is never reused. `reason` settles the job when one is owed
  // (null when the last waiter left and no answer is owed).
  //
  // MUST-1: the worker is replaced ONLY when the job is the
  // lane's RUNNING job. A queued job never started, so ending it
  // splices it out of the queue and settles it — terminating the
  // lane worker for a queued job killed the job that was
  // actually running on that lane.
  private terminateJob(job: Job, reason: unknown): void {
    const state = this.lanes[job.lane];
    const wasRunning = state.running === job;
    if (wasRunning) state.running = null;
    else {
      const idx = state.queue.indexOf(job);
      if (idx >= 0) state.queue.splice(idx, 1);
    }
    if (reason !== null) this.settle(job, { ok: false, error: reason });
    else {
      // No waiter left: settle silently so the inflight map
      // drops the job without rejecting anyone.
      job.settled = true;
      if (job.timer) {
        clearTimeout(job.timer);
        job.timer = null;
      }
      this.clearWaiterTimers(job);
      job.waiters.splice(0);
      this.inflight.delete(job.dedupKey);
    }
    if (!wasRunning) return;
    this.stats.terminated++;
    this.replaceWorker(job.lane);
    this.pump(job.lane);
  }

  private ensureWorker(lane: EngineLane): Worker {
    const state = this.lanes[lane];
    if (state.worker) return state.worker;
    const worker = new Worker(new URL("./engineWorker.js", import.meta.url));
    state.worker = worker;
    state.crashHandled = false;
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as WorkerMessage | undefined;
      if (
        msg == null ||
        typeof msg !== "object" ||
        typeof (msg as { jobId?: unknown }).jobId !== "number"
      ) {
        // A message that fails to parse (§1.4): crash the lane.
        this.onWorkerCrash(lane, new Error("engine worker posted an unparseable message"));
        return;
      }
      const running = this.lanes[lane].running;
      if (!running || running.id !== msg.jobId) {
        // Stale message (e.g. from a job terminated mid-flight):
        // ignore — nobody is waiting for it.
        return;
      }
      this.lanes[lane].running = null;
      if (msg.ok) {
        this.stats.completed++;
        this.settle(running, { ok: true, value: msg.result });
      } else {
        // Engine validation throw, re-created by kind so the
        // caller sees the same error shape as the in-thread
        // path (never an EngineError, never a stack).
        const err =
          msg.error.name === "RangeError"
            ? new RangeError(msg.error.message)
            : msg.error.name === "TypeError"
              ? new TypeError(msg.error.message)
              : new Error(msg.error.message);
        console.error(
          `[engine-pool] job ${running.id} (${running.kind}) engine error: ${msg.error.name}: ${msg.error.message}`,
        );
        this.settle(running, { ok: false, error: err });
      }
      this.pump(lane);
    };
    worker.onerror = (e: ErrorEvent) => {
      // Uncaught exception in the worker: the raw detail is
      // logged server-side and NEVER sent to the client.
      console.error(`[engine-pool] ${lane} worker error: ${e.message ?? e}`);
      this.onWorkerCrash(lane, new Error("engine worker error event"));
    };
    worker.addEventListener("close", () => {
      // Identity decides: the pool nulls state.worker BEFORE
      // terminating it (timeout / last-waiter leave), so a
      // close from a stale worker is ignored; a close from the
      // CURRENT worker is unexpected — a crash. (The test hook
      // __testTerminateLaneWorker deliberately leaves the
      // reference in place, so its close reads as a crash.)
      if (state.worker === worker) {
        this.onWorkerCrash(lane, new Error("engine worker closed unexpectedly"));
      }
    });
    return worker;
  }

  private onWorkerCrash(lane: EngineLane, cause: Error): void {
    const state = this.lanes[lane];
    if (state.crashHandled) return;
    state.crashHandled = true;
    this.stats.crashes++;
    console.error(
      `[engine-pool] ${lane} worker crashed (${cause.message}); respawning lane worker`,
    );
    const running = state.running;
    state.running = null;
    state.worker = null;
    if (running && !running.settled) {
      this.settle(running, { ok: false, error: new EngineError("ENGINE_CRASH") });
    }
    // The dead worker's close event (if it fires after this)
    // must not re-enter the crash path: the worker reference is
    // already cleared, and crashHandled stays true until the
    // replacement is created.
    this.pump(lane);
  }

  private replaceWorker(lane: EngineLane): void {
    const state = this.lanes[lane];
    const old = state.worker;
    // Null FIRST: the old worker's close (if it fires) then
    // fails the identity check in the close handler and is
    // ignored — a pool-initiated terminate is never a crash.
    state.worker = null;
    if (old) {
      try {
        old.terminate();
      } catch {
        // Already dead; nothing to terminate.
      }
    }
    // Lazily recreated on the next pump/dispatch (ensureWorker).
    // Eager creation here would pay module-load cost for a lane
    // with no queued work; pump() creates it when needed.
  }

  // Shut the pool down: terminate both lane workers and drop
  // any queued work. Test-harness use only — the production pool
  // lives for the process lifetime and is never shut down.
  // (Without this, workers keep a short-lived test process's
  // event loop alive; cf. the §3.4 exit linger.)
  shutdown(): void {
    for (const lane of ["large", "small"] as EngineLane[]) {
      const state = this.lanes[lane];
      const dropped = [
        ...(state.running ? [state.running] : []),
        ...state.queue.splice(0),
      ];
      state.running = null;
      for (const job of dropped) {
        if (job.timer) clearTimeout(job.timer);
        job.timer = null;
        this.settle(job, {
          ok: false,
          error: new Error("engine pool shut down"),
        });
      }
      this.replaceWorker(lane);
    }
  }

  // Test-only: terminate the lane worker from outside the pool,
  // as a crash would (the pool sees the close as unexpected).
  // Never called by production code.
  __testTerminateLaneWorker(lane: EngineLane): void {
    const state = this.lanes[lane];
    const w = state.worker;
    if (w) {
      try {
        w.terminate();
      } catch {
        // Already dead.
      }
    }
  }
}

// The process-wide pool (one per process, §1.1). Created lazily
// on the first heavy call by the wrappers that use it — the
// module itself spawns no worker at import time.
export const enginePool = new EnginePool();

export function dispatchEngineJob<T>(
  kind: EngineJobKind,
  dedupKey: string,
  payload: unknown,
  opts?: { timeoutMs?: number; detail?: "full" | "summary" },
): EngineJobHandle<T> {
  return enginePool.dispatch<T>(kind, dedupKey, payload, opts);
}
