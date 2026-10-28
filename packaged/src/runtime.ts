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
import { initLocalDb, StaleTabError, type LocalDb } from "./localDb";
import { createLocalPrivileged } from "./localPrivileged";
import {
  decryptPortableBackup,
  encryptPortableBackup,
} from "./portableBackup";
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
  /** Portable encrypted backup (F5): exportbackup's payload,
      encrypted under the user's passphrase as a downloadable
      .mstbak envelope (portableBackup.ts). */
  exportPortableBackup(passphrase: string): Promise<{ filename: string; contents: string }>;
  /** Portable encrypted backup import: decrypt the envelope
      under the passphrase and run the existing validated
      restorebackup over the payload. Throws on a wrong
      passphrase or a refused restore. */
  importPortableBackup(contents: string, passphrase: string): Promise<{ ok: boolean; reason: string; authenticated: boolean }>;
  /** Session lockout (contract v63, F5): true once a NON-STALE
      persist failure has locked this session (see dispatch).
      While locked, every dispatch is refused with the
      reload-required error in sessionLockReason. */
  readonly sessionLocked: boolean;
  readonly sessionLockReason: string | null;
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

  // Session lockout state (contract v63, F5). Set when a persist
  // fails for a NON-STALE reason (quota, image verification —
  // anything thrown after the handler mutated the in-memory
  // image): the in-memory database then holds writes the durable
  // store does not, and a later successful persist would silently
  // commit them beside whatever it was actually saving. The
  // durable store itself stays generation-safe — the previous
  // generation is intact — so the fail-closed remedy mirrors the
  // store's philosophy: lock the session and require a reload,
  // which re-reads the last committed generation. The stale-tab
  // refusal is EXCLUDED: it throws before the persist writes
  // anything (and the dispatch gate refuses a stale tab before
  // any action runs), so a stale tab's session state is already
  // governed by the generation check, not this lock.
  let sessionLockReason: string | null = null;

  async function dispatch(action: string, args: unknown): Promise<DispatchResult> {
    if (sessionLockReason != null) {
      return {
        status: 500,
        body: JSON.stringify({ error: sessionLockReason }),
      };
    }
    const def = actions[action];
    if (!def || typeof def.handler !== "function") {
      return {
        status: 404,
        body: JSON.stringify({ error: `Unknown action: ${action}` }),
      };
    }
    // Stale-tab gate (contract v60, F1): a tab whose store
    // generation has moved past the one it loaded must not run
    // ANY action — a read would answer from a stale image, and
    // the persist that follows any dispatch would overwrite the
    // newer tab's commits with that image. Refuse up front with
    // a reload instruction; nothing runs, nothing is written.
    try {
      localDb.assertCurrent();
    } catch (err) {
      if (err instanceof StaleTabError) {
        return { status: 409, body: JSON.stringify({ error: err.message }) };
      }
      throw err;
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
    let result: DispatchResult;
    try {
      const value = await def.handler(ctx, parsed.data);
      const checked = def.response.safeParse(value);
      if (!checked.success) {
        result = {
          status: 500,
          body: JSON.stringify({
            error: `Action ${action} returned a response that failed validation.`,
          }),
        };
      } else {
        result = { status: 200, body: JSON.stringify({ data: checked.data }) };
      }
    } catch (err) {
      result = {
        status: 500,
        body: JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
      };
    }
    // Every statement the handler executed is already applied to the
    // in-memory database; persist the image whether the action
    // succeeded or failed partway, matching the live database's
    // durability for the statements that ran. A persist failure is
    // NEVER swallowed (contract v60, F1/F2): a stale tab's persist
    // is refused with 409 (its in-memory work is discarded by the
    // reload this forces — the durable store still holds the other
    // tab's commits), and a store failure (e.g. quota) turns a
    // would-be success into a 500, because reporting success for a
    // write that is not durable would be a silent data loss. The
    // generation protocol leaves the previous generation active
    // in both cases.
    // A NON-STALE persist failure additionally LOCKS the session
    // (contract v63, F5): the in-memory image now diverges from
    // the durable store by this action's writes, so letting the
    // session continue would let a later successful persist
    // silently commit them. Every further dispatch is refused
    // with a reload-required error until the page reloads onto
    // the last committed generation.
    try {
      localDb.persist();
    } catch (err) {
      if (err instanceof StaleTabError) {
        return { status: 409, body: JSON.stringify({ error: err.message }) };
      }
      const cause = err instanceof Error ? err.message : String(err);
      if (sessionLockReason == null) {
        sessionLockReason =
          `This tab is locked: a change could not be saved to this browser's storage (${cause}), ` +
          "so this tab will not save anything else — saving again here could mix the unsaved change into a later save. " +
          "Reload the page to continue: your previously saved data is unchanged, and reloading returns to it.";
      }
      if (result.status === 200) {
        return {
          status: 500,
          body: JSON.stringify({
            error: `The change could not be saved to this browser's storage (${cause}). The previously saved data is unchanged. This tab is now locked — reload the page to continue.`,
          }),
        };
      }
    }
    if (invalidatePending) opts.onInvalidateQueries?.();
    return result;
  }

  async function call<T = unknown>(action: string, args?: unknown): Promise<T> {
    const res = await dispatch(action, args ?? {});
    if (res.status !== 200) {
      throw new Error(`dispatch ${action} -> ${res.status}: ${res.body}`);
    }
    return (JSON.parse(res.body) as { data: T }).data;
  }

  // Portable encrypted backup workflow (contract v60, F5): the
  // payload path is the app's own — exportbackup produces the
  // payload, restorebackup validates and restores it — and
  // portableBackup.ts supplies the passphrase-keyed envelope
  // that makes the file restorable on ANY install. (The in-store
  // .mstbak vault stays as-is: its per-install RSA wrapping makes
  // it a local backup list, not a move path.)
  async function exportPortableBackup(
    passphrase: string,
  ): Promise<{ filename: string; contents: string }> {
    const payload = await call("exportbackup", {});
    const contents = await encryptPortableBackup(
      JSON.stringify(payload),
      passphrase,
    );
    const stamp = new Date().toISOString().slice(0, 10);
    return { filename: `backup-${stamp}-portable.mstbak`, contents };
  }

  async function importPortableBackup(
    contents: string,
    passphrase: string,
  ): Promise<{ ok: boolean; reason: string; authenticated: boolean }> {
    const payloadJson = await decryptPortableBackup(contents, passphrase);
    let payload: unknown;
    try {
      payload = JSON.parse(payloadJson);
    } catch {
      throw new Error("The decrypted backup is not a valid backup payload.");
    }
    const restored = await call<{
      ok: boolean;
      reason: string;
      authenticated: boolean;
    }>("restorebackup", payload);
    if (!restored.ok) {
      throw new Error(`The backup was refused: ${restored.reason}`);
    }
    return restored;
  }

  const runtime: PackagedRuntime = {
    dispatch,
    call,
    exportPortableBackup,
    importPortableBackup,
    get sessionLocked() {
      return sessionLockReason != null;
    },
    get sessionLockReason() {
      return sessionLockReason;
    },
    localDb,
    store,
  };

  // First boot on a fresh store: seed the sample data through the
  // app's own first-run seed action — ONE global emptiness check
  // over every dataset table, then both sample datasets (contract
  // v60, F7; before v60 the two seed actions were called in
  // sequence, their incomplete per-action guards never inspected).
  // The seeded flag is set only from the action's own result: when
  // the seed ran (seeded: true), or when the dataset already holds
  // real records (ok: true, seeded: false — this store is not a
  // seed candidate, and re-checking every boot would be noise).
  // A FAILED seed leaves the flag unset so a later boot retries,
  // and the failure is reported, not hidden. The flag survives
  // clearAllData, so a user who wipes their data is not re-seeded.
  if (!localDb.meta.seeded) {
    try {
      const seed = await call<{ ok: boolean; seeded: boolean; reason: string }>(
        "seedFirstRun",
        {},
      );
      if (seed.ok) {
        localDb.meta.seeded = true;
        localDb.saveMeta();
      } else {
        console.error(`Packaged first-run seed failed: ${seed.reason}`);
      }
    } catch (err) {
      console.error(
        `Packaged first-run seed failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return runtime;
}
