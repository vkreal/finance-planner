// Local database for the packaged build: a real SQLite database
// (sql.js — SQLite compiled to WebAssembly) living in memory, with
// its image persisted into the key/value store.
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
// Persistence protocol (contract v60, F1–F3 — this replaces the
// pre-v60 in-place chunk writes, which could leave a hybrid image
// behind on a quota failure and silently re-initialized an empty
// database over damaged data):
//
//   * Images are IMMUTABLE GENERATIONS. A persist exports the whole
//     image, base64-chunks it under a fresh generation number
//     (fpkg:v1:gen:<g>:<i>), reads the chunks back and verifies the
//     SHA-256 over the exact bytes, and confirms the bytes open as
//     a SQLite database — all BEFORE committing anything.
//   * The commit is ONE small write: the active-generation pointer
//     (fpkg:v1:active = {gen, chunks, sha256}). Until that write
//     lands, the previous generation is the store's state, fully
//     intact; a failure anywhere earlier (quota, verification)
//     leaves it active and surfaces an error. The previous
//     generation's chunks are retained after the switch (cleanup
//     removes only generations older than the previous one) —
//     EXCEPT after a successful clearAllData (contract v92,
//     stored-data finding F4): that persist purges every prior
//     generation including the retained one, because the
//     retained copy is the pre-wipe image. The purge is
//     generations only; the encryption key and backup vault
//     remain, by scope limit, for a future ruling.
//   * On load, the active generation is reassembled and its hash
//     verified before use. A corrupt, incomplete, or
//     checksum-failing image is NEVER replaced with an empty
//     database while store keys exist: initLocalDb throws
//     StoreRecoveryRequiredError and writes nothing, preserving
//     every key for recovery. Only a genuinely fresh store (no
//     pointer, no legacy chunks, no meta) initializes empty.
//   * The migration count lives INSIDE the image (PRAGMA
//     user_version), so it commits atomically with the schema it
//     describes — the pre-v60 localStorage meta said "applied"
//     before the image was durable and could strand a migration
//     forever. The meta's appliedMigrations field is kept only as
//     an informational mirror; nothing reads it to decide
//     migrations. A pre-v60 store's legacy chunks are adopted on
//     first boot: loaded, re-persisted as generation 1 under this
//     protocol, and only then removed.
//   * Stale-tab protection: a tab remembers the generation it
//     loaded (or last wrote). persist() and assertCurrent()
//     re-read the pointer and refuse — StaleTabError — when it no
//     longer names that generation, so a stale tab can never
//     overwrite another tab's commit, not even via a read-only
//     action's persist. Persist is fully synchronous (localStorage
//     and the hash are synchronous), so the check-and-commit
//     cannot interleave with another tab's persist mid-write.
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as schema from "../../server/src/schema";
import { MIGRATIONS } from "packaged-migrations";
import { bytesToHex, sha256Bytes } from "../../server/src/backupMacCore";
import {
  ACTIVE_KEY,
  DB_CHUNK_KEY,
  DB_COUNT_KEY,
  GEN_CHUNK_KEY,
  META_KEY,
  type KeyValueStore,
} from "./storage";

const CHUNK_CHARS = 100_000;

/** The stored database could not be loaded and must not be
    overwritten: every key is preserved; a human (or a future
    recovery tool) decides what happens next. */
export class StoreRecoveryRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreRecoveryRequiredError";
  }
}

/** Another tab (or window) committed a newer generation since
    this tab loaded. This tab must reload before it can act. */
export class StaleTabError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleTabError";
  }
}

interface PackagedMeta {
  appliedMigrations: number;
  seeded: boolean;
  createdMs: number;
}

interface GenerationPointer {
  gen: number;
  chunks: number;
  sha256: string;
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

function imageSha256(bytes: Uint8Array): string {
  return bytesToHex(sha256Bytes(bytes));
}

function readPointer(store: KeyValueStore): GenerationPointer | null {
  const raw = store.get(ACTIVE_KEY);
  if (raw == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StoreRecoveryRequiredError(
      "The stored database pointer is unreadable. Your stored data was left untouched; recovery is required before the app can open.",
    );
  }
  const p = parsed as Partial<GenerationPointer>;
  if (
    typeof p.gen !== "number" ||
    typeof p.chunks !== "number" ||
    typeof p.sha256 !== "string"
  ) {
    throw new StoreRecoveryRequiredError(
      "The stored database pointer is incomplete. Your stored data was left untouched; recovery is required before the app can open.",
    );
  }
  return { gen: p.gen, chunks: p.chunks, sha256: p.sha256 };
}

/** Reassemble one generation's image bytes, verifying completeness
    and the recorded hash. Any failure is a recovery state. */
function loadGenerationBytes(
  store: KeyValueStore,
  pointer: GenerationPointer,
): Uint8Array {
  let b64 = "";
  for (let i = 0; i < pointer.chunks; i++) {
    const chunk = store.get(GEN_CHUNK_KEY(pointer.gen, i));
    if (chunk == null) {
      throw new StoreRecoveryRequiredError(
        `The stored database is incomplete (generation ${pointer.gen} is missing chunk ${i} of ${pointer.chunks}). Your stored data was left untouched; recovery is required before the app can open.`,
      );
    }
    b64 += chunk;
  }
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(b64);
  } catch {
    throw new StoreRecoveryRequiredError(
      "The stored database image is not valid base64. Your stored data was left untouched; recovery is required before the app can open.",
    );
  }
  if (imageSha256(bytes) !== pointer.sha256) {
    throw new StoreRecoveryRequiredError(
      "The stored database failed its integrity check (checksum mismatch). Your stored data was left untouched; recovery is required before the app can open.",
    );
  }
  return bytes;
}

/** The pre-v60 image layout: chunks written in place under
    fpkg:v1:db:<i> with a separate count key. Returns the bytes, or
    null when no legacy image exists; a partial legacy image is a
    recovery state, not an empty database. */
function loadLegacyBytes(store: KeyValueStore): Uint8Array | null {
  const countRaw = store.get(DB_COUNT_KEY);
  if (!countRaw) return null;
  const count = Number.parseInt(countRaw, 10);
  if (!Number.isFinite(count) || count <= 0) {
    throw new StoreRecoveryRequiredError(
      "The stored database (older format) has an unreadable chunk count. Your stored data was left untouched; recovery is required before the app can open.",
    );
  }
  let b64 = "";
  for (let i = 0; i < count; i++) {
    const chunk = store.get(DB_CHUNK_KEY(i));
    if (chunk == null) {
      throw new StoreRecoveryRequiredError(
        "The stored database (older format) is incomplete. Your stored data was left untouched; recovery is required before the app can open.",
      );
    }
    b64 += chunk;
  }
  try {
    return base64ToBytes(b64);
  } catch {
    throw new StoreRecoveryRequiredError(
      "The stored database (older format) is not valid base64. Your stored data was left untouched; recovery is required before the app can open.",
    );
  }
}

function removeLegacyKeys(store: KeyValueStore): void {
  const countRaw = store.get(DB_COUNT_KEY);
  const count = countRaw ? Number.parseInt(countRaw, 10) : 0;
  if (Number.isFinite(count)) {
    for (let i = 0; i < count; i++) store.remove(DB_CHUNK_KEY(i));
  }
  store.remove(DB_COUNT_KEY);
}

/** Remove every chunk of one generation (indices are contiguous;
    probing stops at the first gap). */
function removeGeneration(store: KeyValueStore, gen: number): void {
  for (let i = 0; ; i++) {
    const key = GEN_CHUNK_KEY(gen, i);
    if (store.get(key) == null) return;
    store.remove(key);
  }
}

function openImage(SQL: SqlJsStatic, bytes: Uint8Array): Database {
  try {
    const db = new SQL.Database(bytes);
    // A truncated or foreign file can construct yet fail on first
    // touch; force one real read of the schema page.
    db.exec("SELECT count(*) FROM sqlite_master");
    return db;
  } catch (err) {
    throw new StoreRecoveryRequiredError(
      `The stored database could not be opened (${err instanceof Error ? err.message : String(err)}). Your stored data was left untouched; recovery is required before the app can open.`,
    );
  }
}

function readUserVersion(db: Database): number {
  const rows = db.exec("PRAGMA user_version");
  const v = rows[0]?.values[0]?.[0];
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
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
  /** Commit the current image as a new generation (see the
      protocol above). Throws StaleTabError when another tab has
      committed since this tab loaded, and propagates store
      failures (e.g. quota) with the previous generation intact.
      `purgeAllPriorGenerations` is the wipe exception (contract
      v92, stored-data finding F4): when true, the cleanup after
      the pointer switch removes EVERY prior generation,
      including the gen - 1 fallback copy, so no pre-wipe image
      remains readable. Every other persist keeps the fallback
      exactly as before. The flag is set only by the packaged
      runtime dispatch, and only for a successful clearAllData. */
  persist(options?: { purgeAllPriorGenerations?: boolean }): void;
  /** Throw StaleTabError when the store's active generation is
      no longer the one this tab loaded or last wrote. */
  assertCurrent(): void;
  /** The generation this tab loaded or last wrote. */
  readonly generation: number;
  meta: PackagedMeta;
  saveMeta(): void;
}

export async function initLocalDb(
  store: KeyValueStore,
  wasmUrl: string,
): Promise<LocalDb> {
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const meta = readMeta(store);
  const hadMeta = store.get(META_KEY) != null;
  const pointer = readPointer(store);

  let sqlDb: Database;
  let knownGen = 0;
  let adoptedLegacy = false;
  let fresh = false;
  if (pointer) {
    const bytes = loadGenerationBytes(store, pointer);
    sqlDb = openImage(SQL, bytes);
    knownGen = pointer.gen;
  } else {
    const legacy = loadLegacyBytes(store);
    if (legacy) {
      sqlDb = openImage(SQL, legacy);
      adoptedLegacy = true;
    } else if (hadMeta || store.get(DB_COUNT_KEY) != null) {
      // The store was initialized before (a meta or a legacy
      // count survives) but no loadable image exists — damaged,
      // not fresh. Preserve everything and refuse.
      throw new StoreRecoveryRequiredError(
        "The stored database image is missing but other stored state exists. Your stored data was left untouched; recovery is required before the app can open.",
      );
    } else {
      sqlDb = new SQL.Database();
      fresh = true;
    }
  }

  // Migrations: the count of applied migrations is read from the
  // image itself (PRAGMA user_version) and advanced inside the
  // image as each migration runs, so the marker and the schema
  // change are committed together by the generation persist
  // below. The localStorage meta is never consulted here — with
  // ONE adoption exception: a pre-v60 legacy image carries
  // user_version 0 with its migrations already applied, and the
  // legacy meta is the only record of how far it got, so an
  // adopted image is stamped with the meta's count as its
  // starting user_version. From that image's first generation
  // persist onward, the in-image marker alone is authoritative.
  let appliedBefore = readUserVersion(sqlDb);
  if (adoptedLegacy && appliedBefore === 0 && meta.appliedMigrations > 0) {
    appliedBefore = Math.min(meta.appliedMigrations, MIGRATIONS.length);
    sqlDb.exec(`PRAGMA user_version = ${appliedBefore}`);
  }
  let applied = appliedBefore;
  for (let i = applied; i < MIGRATIONS.length; i++) {
    sqlDb.exec(MIGRATIONS[i]);
    applied = i + 1;
    sqlDb.exec(`PRAGMA user_version = ${applied}`);
  }
  meta.appliedMigrations = applied; // informational mirror only

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
    get generation() {
      return knownGen;
    },
    assertCurrent() {
      const current = readPointer(store);
      const currentGen = current?.gen ?? 0;
      if (currentGen !== knownGen) {
        throw new StaleTabError(
          "This tab is out of date: another tab saved newer data (generation " +
            `${currentGen}) after this tab loaded (generation ${knownGen}). ` +
            "Reload this tab to continue — nothing was overwritten.",
        );
      }
    },
    persist(options?: { purgeAllPriorGenerations?: boolean }) {
      // Stale check BEFORE writing anything: a tab may commit
      // only on top of the generation it loaded or last wrote.
      const current = readPointer(store);
      const currentGen = current?.gen ?? 0;
      if (currentGen !== knownGen) {
        throw new StaleTabError(
          "This tab is out of date: another tab saved newer data (generation " +
            `${currentGen}) after this tab loaded (generation ${knownGen}). ` +
            "Reload this tab to continue — nothing was overwritten.",
        );
      }
      const bytes = sqlDb.export();
      const gen = knownGen + 1;
      const b64 = bytesToBase64(bytes);
      const count = Math.max(1, Math.ceil(b64.length / CHUNK_CHARS));
      const sha256 = imageSha256(bytes);
      // Write the new generation's chunks. The active pointer
      // still names the previous generation, so a throw anywhere
      // here (quota) leaves the last good image fully active.
      for (let i = 0; i < count; i++) {
        store.set(
          GEN_CHUNK_KEY(gen, i),
          b64.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS),
        );
      }
      // Verify BEFORE the pointer switch: reassemble, re-hash,
      // and open the exact bytes the pointer will name.
      const verified = loadGenerationBytes(store, { gen, chunks: count, sha256 });
      const probe = openImage(SQL, verified);
      probe.close();
      // The commit: one small pointer write.
      const next: GenerationPointer = { gen, chunks: count, sha256 };
      store.set(ACTIVE_KEY, JSON.stringify(next));
      knownGen = gen;
      // Retain the previous generation (gen - 1) as the fallback
      // copy; remove anything older — EXCEPT after a successful
      // wipe (contract v92, stored-data finding F4), where the
      // retained fallback IS the pre-wipe image: the purge then
      // removes every prior generation, including gen - 1, so
      // no pre-wipe image remains readable. The just-committed
      // generation itself is never removed either way (it is
      // the store's state, and for a wipe it is the empty image),
      // and this purge touches generations only — never the
      // encryption key, the backup vault, or any other store
      // key, which a future ruling must decide separately.
      // The purge runs only after the pointer switch, so a
      // failure anywhere earlier leaves the prior generations
      // (and the fallback) intact, as for any persist.
      if (options?.purgeAllPriorGenerations) {
        for (let g = 1; g < gen; g++) removeGeneration(store, g);
      } else {
        for (let g = 1; g < gen - 1; g++) removeGeneration(store, g);
      }
    },
    saveMeta() {
      writeMeta(store, meta);
    },
  };

  if (fresh || adoptedLegacy || applied !== appliedBefore) {
    // Commit the (possibly freshly migrated or adopted) image as
    // a generation so the store always holds a loadable database
    // between sessions. Adoption removes the legacy keys only
    // after the generation is durable.
    localDb.persist();
    if (adoptedLegacy) removeLegacyKeys(store);
  }
  writeMeta(store, meta);
  return localDb;
}
