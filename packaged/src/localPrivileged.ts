// Local implementations of the five privileged contracts
// (packaged/src/privilegedContract.ts) — the packaged counterparts of
// server/src/privileged.ts, which is the live build's only
// node-filesystem module.
//
// Semantics mirror the live handlers, with the filesystem replaced by
// the key/value store:
//   * ensureEncryptionKey — the at-rest key is a random 256-bit value
//     generated once and kept in the store (fpkg:v1:enckey). On the
//     live app the same key lives in <spaceDir>/.secrets/ on the
//     server, never beside the data; here it necessarily sits beside
//     the data it encrypts. The enc:v1: value format is unchanged, so
//     exported backup payloads interoperate with the live app in both
//     directions (restore re-encrypts under the importing app's key).
//   * backups — the "backups folder" is a vault list in the store.
//     Files are the same .mstbak envelopes the live app writes:
//     {format:"mst-backup-enc", v:2, alg:"RSA-4096-OAEP-SHA256 +
//     AES-256-GCM", wrappedKey, iv, tag, payloadSha256, data} — a
//     per-backup AES-256-GCM data key wrapped with RSA-4096 OAEP
//     (SHA-256) under a public key. The live app wraps with a public
//     key whose private half is kept OFFLINE by the owner; the
//     packaged build generates a fresh RSA-4096 pair per install on
//     first use and keeps both halves in the store (the private half
//     is exportable from the store for offline decryption with the
//     same tooling). Filename, rotation (keep newest 12), and
//     delete rules reuse server/src/backupCore.ts verbatim. There is
//     no legacy shared folder in the packaged build, so listings are
//     this install's own backups only.
import {
  BACKUP_KEEP_NEWEST,
  chooseBackupFilename,
  mergeBackupListingsWithSource,
  planDeleteAllBackups,
  planDeleteBackup,
  planPruneBackups,
  type BackupFileEntry,
  type BackupListEntry,
} from "../../server/src/backupCore";
import {
  BACKUPS_KEY,
  ENC_KEY_KEY,
  RSA_PRIV_KEY,
  RSA_PUB_KEY,
  type KeyValueStore,
} from "./storage";

interface VaultEntry {
  name: string;
  modifiedMs: number;
  envelopeJson: string;
}

function readVault(store: KeyValueStore): VaultEntry[] {
  const raw = store.get(BACKUPS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as VaultEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeVault(store: KeyValueStore, entries: VaultEntry[]): void {
  store.set(BACKUPS_KEY, JSON.stringify(entries));
}

function ownFiles(entries: VaultEntry[]): BackupFileEntry[] {
  return entries.map((e) => ({
    name: e.name,
    sizeBytes: e.envelopeJson.length,
    modifiedMs: e.modifiedMs,
  }));
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

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The install's RSA-4096 backup wrapping keypair, generated lazily. */
async function ensureRsaKeyPair(
  store: KeyValueStore,
): Promise<{ publicKey: CryptoKey; privateKey: CryptoKey }> {
  const pubRaw = store.get(RSA_PUB_KEY);
  const privRaw = store.get(RSA_PRIV_KEY);
  if (pubRaw && privRaw) {
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      JSON.parse(pubRaw),
      { name: "RSA-OAEP", hash: "SHA-256" },
      true,
      ["encrypt"],
    );
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      JSON.parse(privRaw),
      { name: "RSA-OAEP", hash: "SHA-256" },
      true,
      ["decrypt"],
    );
    return { publicKey, privateKey };
  }
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 4096,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );
  const pubJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  store.set(RSA_PUB_KEY, JSON.stringify(pubJwk));
  store.set(RSA_PRIV_KEY, JSON.stringify(privJwk));
  return pair;
}

export interface LocalPrivilegedHandlers {
  ensureEncryptionKey(args: { spaceDir: string }): { keyBase64: string };
  listBackups(args: { spaceDir: string }): {
    backups: BackupListEntry[];
  };
  deleteBackup(args: { spaceDir: string; filename: string }): {
    ok: boolean;
    reason: string;
  };
  deleteAllBackups(args: { spaceDir: string }): {
    ok: boolean;
    reason: string;
    deletedCount: number;
  };
  createBackup(args: { spaceDir: string; payloadJson: string }): Promise<{
    ok: boolean;
    filename: string | null;
    reason: string;
    prunedCount: number;
  }>;
}

export function createLocalPrivileged(store: KeyValueStore): LocalPrivilegedHandlers {
  return {
    ensureEncryptionKey() {
      const existing = store.get(ENC_KEY_KEY);
      if (existing != null) {
        const bytes = base64ToBytes(existing.trim());
        if (bytes.length !== 32) {
          throw new Error(
            "Encryption key file is corrupt (expected a 256-bit key). Refusing to continue so encrypted data is not damaged.",
          );
        }
        return { keyBase64: existing.trim() };
      }
      const key = new Uint8Array(32);
      crypto.getRandomValues(key);
      const keyBase64 = bytesToBase64(key);
      store.set(ENC_KEY_KEY, keyBase64);
      return { keyBase64 };
    },

    listBackups() {
      // No legacy folder in the packaged build: every entry is "own".
      return {
        backups: mergeBackupListingsWithSource(ownFiles(readVault(store)), []),
      };
    },

    deleteBackup(args) {
      const entries = readVault(store);
      const plan = planDeleteBackup(args.filename, ownFiles(entries), []);
      if (!plan.ok) return { ok: false, reason: plan.reason };
      writeVault(
        store,
        entries.filter((e) => e.name !== args.filename),
      );
      return { ok: true, reason: `Deleted ${args.filename}.` };
    },

    deleteAllBackups() {
      const entries = readVault(store);
      const names = new Set(planDeleteAllBackups(ownFiles(entries)));
      const remaining = entries.filter((e) => !names.has(e.name));
      const deleted = entries.length - remaining.length;
      writeVault(store, remaining);
      return {
        ok: true,
        reason:
          deleted === 0
            ? "No backups to delete."
            : `Deleted ${deleted} backup${deleted === 1 ? "" : "s"}.`,
        deletedCount: deleted,
      };
    },

    async createBackup(args) {
      const fail = (reason: string) => ({
        ok: false,
        filename: null,
        reason,
        prunedCount: 0,
      });
      const entries = readVault(store);
      // Filename within the backup-*.mstbak pattern, dated in the
      // user's timezone like the live backups (server/src/privileged.ts
      // uses America/Los_Angeles parts).
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }).formatToParts(new Date());
      const part = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
      const datePart = `${part("year")}-${part("month")}-${part("day")}`;
      const timePart = `${part("hour")}${part("minute")}${part("second")}`;
      const filename = chooseBackupFilename(
        new Set(entries.map((e) => e.name)),
        datePart,
        timePart,
      );
      const payloadSha256 = await sha256Hex(args.payloadJson);
      let envelopeJson: string;
      try {
        const { publicKey } = await ensureRsaKeyPair(store);
        const dataKeyRaw = new Uint8Array(32);
        crypto.getRandomValues(dataKeyRaw);
        const iv = new Uint8Array(12);
        crypto.getRandomValues(iv);
        const dataKey = await crypto.subtle.importKey(
          "raw",
          dataKeyRaw as BufferSource,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt"],
        );
        const sealed = new Uint8Array(
          await crypto.subtle.encrypt(
            { name: "AES-GCM", iv: iv as BufferSource },
            dataKey,
            new TextEncoder().encode(args.payloadJson) as BufferSource,
          ),
        );
        // WebCrypto appends the 16-byte GCM tag; the envelope stores
        // it separately, exactly like the live writer.
        const data = sealed.subarray(0, sealed.length - 16);
        const tag = sealed.subarray(sealed.length - 16);
        const wrappedKey = new Uint8Array(
          await crypto.subtle.encrypt(
            { name: "RSA-OAEP" },
            publicKey,
            dataKeyRaw as BufferSource,
          ),
        );
        envelopeJson = JSON.stringify({
          format: "mst-backup-enc",
          v: 2,
          alg: "RSA-4096-OAEP-SHA256 + AES-256-GCM",
          wrappedKey: bytesToBase64(wrappedKey),
          iv: bytesToBase64(iv),
          tag: bytesToBase64(tag),
          payloadSha256,
          data: bytesToBase64(data),
        });
      } catch {
        return fail("Encryption failed. No backup was created.");
      }
      const entry: VaultEntry = {
        name: filename,
        modifiedMs: Date.now(),
        envelopeJson,
      };
      const next = [...entries, entry];
      writeVault(store, next);
      // Read back and verify the envelope, like the live writer; a
      // failure leaves no partial or corrupt backup listed.
      const stored = readVault(store).find((e) => e.name === filename);
      let verified = false;
      if (stored) {
        try {
          const env = JSON.parse(stored.envelopeJson) as Record<string, unknown>;
          verified =
            env.format === "mst-backup-enc" &&
            env.v === 2 &&
            env.payloadSha256 === payloadSha256 &&
            typeof env.wrappedKey === "string" &&
            typeof env.iv === "string" &&
            typeof env.tag === "string" &&
            typeof env.data === "string";
        } catch {
          verified = false;
        }
      }
      if (!verified) {
        writeVault(
          store,
          next.filter((e) => e.name !== filename),
        );
        return fail(
          "The new backup failed verification and was removed. No backup was created.",
        );
      }
      // Rotation over this install's own backups: keep the newest 12
      // (backupCore.planPruneBackups).
      const after = readVault(store);
      const pruneNames = new Set(planPruneBackups(ownFiles(after), BACKUP_KEEP_NEWEST));
      let prunedCount = 0;
      if (pruneNames.size > 0) {
        const kept = after.filter((e) => !pruneNames.has(e.name));
        prunedCount = after.length - kept.length;
        writeVault(store, kept);
      }
      return {
        ok: true,
        filename,
        reason:
          `Backup created: ${filename}.` +
          (prunedCount > 0
            ? ` Removed ${prunedCount} oldest backup${prunedCount === 1 ? "" : "s"} to keep the newest 12.`
            : ""),
        prunedCount,
      };
    },
  };
}
