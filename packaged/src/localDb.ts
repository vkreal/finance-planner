// Local database for the packaged build: a real SQLite database
// (sql.js — SQLite compiled to WebAssembly) living in memory, with its
// image persisted into the key/value store as base64 chunks.
//
// The server actions receive their database through ctx.db(), typed as
// the SDK's SpaceDb = Pick<drizzle LibSQLDatabase, "select" | "insert"
// | "update" | "delete" | "run" | "all" | "get" | "batch">. This module
// builds exactly that surface with drizzle-orm's sqlite-proxy driver
// over sql.js, so every query the actions issue runs against the same
// schema (server/src/schema.ts) and the same migrations (drizzle/*.sql,
// inlined at build time by the "packaged-migrations" virtual module)
// the live server runs.
//
// Persistence model: after every successful action dispatch the whole
// database image is re-exported and rewritten to the store (see
// dispatch.ts). The dataset this app holds is small (a household's
// bills, snapshots, and plan records), so a full-image write per action
// is simple and safe; it also makes every write atomic at the store
// level — there is no half-written state to recover from.
import initSqlJs, { type Database } from "sql.js";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as schema from "../../server/src/schema";
import { MIGRATIONS } from "packaged-migrations";
import {
  DB_CHUNK_KEY,
  DB_COUNT_KEY,
  META_KEY,
  type KeyValueStore,
} from "./storage";

const CHUNK_CHARS = 100_000;

interface PackagedMeta {
  appliedMigrations: number;
  seeded: boolean;
  createdMs: number;
}

function readMeta(store: KeyValueStore): PackagedMeta {
  const raw = store.get(META_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as PackagedMeta;
      if (typeof parsed.appliedMigrations === "number") return parsed;
    } catch {
      // fall through to a fresh meta
    }
  }
  return { appliedMigrations: 0, seeded: false, createdMs: Date.now() };
}

function writeMeta(store: KeyValueStore, meta: PackagedMeta): void {
  store.set(META_KEY, JSON.stringify(meta));
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const SLICE = 0x8000;
  for (let i = 0; i < bytes.length; i += SLICE) {
    bin += String.fromCharCode(...bytes.subarray(i, i + SLICE));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function loadImage(store: KeyValueStore): Uint8Array | null {
  const countRaw = store.get(DB_COUNT_KEY);
  if (!countRaw) return null;
  const count = Number.parseInt(countRaw, 10);
  if (!Number.isFinite(count) || count <= 0) return null;
  let b64 = "";
  for (let i = 0; i < count; i++) {
    const chunk = store.get(DB_CHUNK_KEY(i));
    if (chunk == null) return null;
    b64 += chunk;
  }
  return base64ToBytes(b64);
}

function saveImage(store: KeyValueStore, bytes: Uint8Array): void {
  const b64 = bytesToBase64(bytes);
  const count = Math.max(1, Math.ceil(b64.length / CHUNK_CHARS));
  const prevCountRaw = store.get(DB_COUNT_KEY);
  const prevCount = prevCountRaw ? Number.parseInt(prevCountRaw, 10) : 0;
  for (let i = 0; i < count; i++) {
    store.set(DB_CHUNK_KEY(i), b64.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS));
  }
  store.set(DB_COUNT_KEY, String(count));
  for (let i = count; i < prevCount; i++) store.remove(DB_CHUNK_KEY(i));
}

type ProxyMethod = "run" | "all" | "values" | "get";

function bindValue(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

export interface LocalDb {
  /** The drizzle database handed to actions through ctx.db(). */
  db: ReturnType<typeof drizzle<typeof schema>>;
  /** Export the current image into the store. */
  persist(): void;
  meta: PackagedMeta;
  saveMeta(): void;
}

export async function initLocalDb(
  store: KeyValueStore,
  wasmUrl: string,
): Promise<LocalDb> {
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const image = loadImage(store);
  const sqlDb: Database = image ? new SQL.Database(image) : new SQL.Database();

  const meta = readMeta(store);
  const migrationsBefore = meta.appliedMigrations;
  // Apply any migrations the stored image has not seen yet, in the
  // same filename order the live platform applies them. Each file's
  // "--> statement-breakpoint" lines are plain SQLite comments, so a
  // file can be executed as-is.
  for (let i = meta.appliedMigrations; i < MIGRATIONS.length; i++) {
    sqlDb.exec(MIGRATIONS[i]);
    meta.appliedMigrations = i + 1;
  }
  writeMeta(store, meta);

  function execOne(sql: string, params: unknown[], method: ProxyMethod) {
    const stmt = sqlDb.prepare(sql);
    try {
      if (params.length > 0) {
        stmt.bind(params.map(bindValue) as never);
      }
      if (method === "run") {
        while (stmt.step()) {
          // discard any rows a run statement yields (e.g. RETURNING)
        }
        return { rows: [] as unknown[] };
      }
      const rows: unknown[][] = [];
      while (stmt.step()) {
        rows.push(stmt.get() as unknown[]);
      }
      if (method === "get") {
        return { rows: rows.length > 0 ? rows[0] : undefined };
      }
      return { rows };
    } finally {
      stmt.free();
    }
  }

  const callback = async (
    sql: string,
    params: unknown[],
    method: ProxyMethod,
  ) => execOne(sql, params, method);

  const batchCallback = async (
    items: { sql: string; params: unknown[]; method: string }[],
  ) => {
    sqlDb.exec("BEGIN");
    try {
      const results = items.map((item) =>
        execOne(item.sql, item.params, item.method as ProxyMethod),
      );
      sqlDb.exec("COMMIT");
      return results;
    } catch (err) {
      try {
        sqlDb.exec("ROLLBACK");
      } catch {
        // nothing left to roll back
      }
      throw err;
    }
  };

  const db = drizzle<typeof schema>(callback, batchCallback, { schema });

  const localDb: LocalDb = {
    db,
    meta,
    persist() {
      saveImage(store, sqlDb.export());
    },
    saveMeta() {
      writeMeta(store, meta);
    },
  };
  if (image == null || meta.appliedMigrations !== migrationsBefore) {
    // Persist the (possibly freshly migrated) image immediately so the
    // store always holds a loadable database between sessions.
    localDb.persist();
  }
  return localDb;
}
