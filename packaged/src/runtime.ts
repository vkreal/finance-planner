// Packaged runtime: the local action dispatcher.
//
// This is the packaged counterpart of the live app's server worker. It
// imports the REAL action module (server/src/actions.ts — the same
// handlers, engine, fixtures, and zod contracts the live artifact
// runs) and dispatches calls to it with a local Ctx:
//
//   ctx.db()               -> the sql.js-backed drizzle database
//                             (packaged/src/localDb.ts)
//   ctx.executePrivileged  -> the local privileged handlers
//                             (packaged/src/localPrivileged.ts), through
//                             the SDK's real createPrivilegedExecutor,
//                             so contract request/response validation
//                             is the SDK's own code
//   ctx.invalidateQueries  -> recorded per dispatch; the browser entry
//                             turns it into a spaceQueryClient
//                             invalidation, mirroring the live host
//                             bridge signal
//   ctx.spaceDir           -> the constant "packaged-local" (only used
//                             as a label passed to the privileged
//                             contracts; no filesystem exists here)
//   ctx.agent / inference / tool / blobs -> stubs that throw if ever
//                             called (no server action in this app
//                             uses them)
//
// Wire semantics mirror the live worker's, as the client SDK and the
// API contract describe them: success -> 200 with body {data};
// request-validation failure -> 400 with the raw zod issues array as
// the body; unknown action -> 404; handler error -> 500 with
// {error: message}.
import { Actions } from "../../server/src/actions";
import { createPrivilegedExecutor } from "./spaceSdkShim";
import { initLocalDb, type LocalDb } from "./localDb";
import { createLocalPrivileged } from "./localPrivileged";
import type { KeyValueStore } from "./storage";

export const PACKAGED_SPACE_DIR = "packaged-local";

export interface DispatchResult {
  status: number;
  body: string;
}

export interface PackagedRuntime {
  dispatch(action: string, args: unknown): Promise<DispatchResult>;
  /** Convenience for the harness/probe: parsed `data`, throws on error. */
  call<T = unknown>(action: string, args?: unknown): Promise<T>;
  localDb: LocalDb;
  store: KeyValueStore;
}

interface ActionDef {
  request: { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: { issues: unknown[] } } };
  response: { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: { issues: unknown[] } } };
  handler: (ctx: unknown, args: unknown) => Promise<unknown>;
  privileged?: readonly unknown[];
}

const unavailable = (what: string) => () => {
  throw new Error(`${what} is not available in the packaged (offline) build.`);
};

export async function createRuntime(opts: {
  store: KeyValueStore;
  wasmUrl: string;
  onInvalidateQueries?: () => void;
}): Promise<PackagedRuntime> {
  const { store } = opts;
  const localDb = await initLocalDb(store, opts.wasmUrl);
  const privilegedImpls = createLocalPrivileged(store) as unknown as Record<
    string,
    (args: never) => unknown
  >;
  const actions = Actions as unknown as Record<string, ActionDef>;

  async function dispatch(action: string, args: unknown): Promise<DispatchResult> {
    const def = actions[action];
    if (!def || typeof def.handler !== "function") {
      return {
        status: 404,
        body: JSON.stringify({ error: `Unknown action: ${action}` }),
      };
    }
    const parsed = def.request.safeParse(args ?? {});
    if (!parsed.success) {
      // The live worker returns every validation issue at once, as an
      // array of issue objects in the validator's raw shape.
      return { status: 400, body: JSON.stringify(parsed.error?.issues ?? []) };
    }
    let invalidatePending = false;
    const executor = createPrivilegedExecutor(
      (def.privileged ?? []) as never,
      async (contract: { name: string }, parsedArgs: unknown) => {
        const impl = privilegedImpls[contract.name];
        if (!impl) {
          throw new Error(`No local privileged handler for ${contract.name}`);
        }
        return impl(parsedArgs as never);
      },
    );
    const ctx = {
      slug: "monthly-spending-tracker",
      invocationId: `packaged-${Date.now()}`,
      spaceDir: PACKAGED_SPACE_DIR,
      db: () => localDb.db,
      executePrivileged: executor.executePrivileged,
      invalidateQueries: () => {
        invalidatePending = true;
      },
      emit: () => {},
      agent: { infer: unavailable("ctx.agent") },
      inference: { complete: unavailable("ctx.inference") },
      tool: unavailable("ctx.tool"),
      blobs: {
        put: unavailable("ctx.blobs"),
        get: unavailable("ctx.blobs"),
        delete: unavailable("ctx.blobs"),
        list: unavailable("ctx.blobs"),
      },
    };
    try {
      const result = await def.handler(ctx, parsed.data);
      const checked = def.response.safeParse(result);
      if (!checked.success) {
        return {
          status: 500,
          body: JSON.stringify({
            error: `Action ${action} returned a response that failed validation.`,
          }),
        };
      }
      return { status: 200, body: JSON.stringify({ data: checked.data }) };
    } catch (err) {
      return {
        status: 500,
        body: JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
      };
    } finally {
      // Every statement the handler executed is already applied to the
      // in-memory database; persist the image whether the action
      // succeeded or failed partway, matching the live database's
      // durability for the statements that ran.
      localDb.persist();
      if (invalidatePending) opts.onInvalidateQueries?.();
    }
  }

  async function call<T = unknown>(action: string, args?: unknown): Promise<T> {
    const res = await dispatch(action, args ?? {});
    if (res.status !== 200) {
      throw new Error(`dispatch ${action} -> ${res.status}: ${res.body}`);
    }
    return (JSON.parse(res.body) as { data: T }).data;
  }

  const runtime: PackagedRuntime = { dispatch, call, localDb, store };

  // First boot on a fresh store: seed the sample data exactly as the
  // app's own seed actions do (the same actions the "seed" buttons in
  // Spending and Net Worth call). This runs once — the seeded flag in
  // the store meta survives clearAllData, so a user who wipes their
  // data is not re-seeded.
  if (!localDb.meta.seeded) {
    await call("seedExamples", {});
    await call("seedNetWorth", {});
    localDb.meta.seeded = true;
    localDb.saveMeta();
  }

  return runtime;
}
