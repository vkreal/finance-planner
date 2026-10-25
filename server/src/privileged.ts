// Privileged host handlers — the ONLY place the at-rest encryption
// key lives. The key is a random 256-bit value generated once and
// stored in a file under <spaceDir>/.secrets/ (outside the app's
// database tables, never in client code, never logged, never returned
// by any client-facing action). Action code calls the contract below
// over the privileged transport to obtain the key for in-memory
// AES-256-GCM work in the server worker; the key itself is never
// persisted anywhere else and never leaves the server side.
import {
constants,
createCipheriv,
createHash,
publicEncrypt,
randomBytes,
} from "node:crypto";
import {
existsSync,
mkdirSync,
readFileSync,
readdirSync,
renameSync,
statSync,
unlinkSync,
writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
definePrivilegedContracts,
definePrivilegedHandlers,
z,
} from "@hatch/space-sdk";
import {
BACKUP_KEEP_NEWEST,
chooseBackupFilename,
isBackupFilename,
legacyBackupsDir,
mergeBackupListingsWithSource,
perSpaceBackupsDir,
planDeleteAllBackups,
planDeleteBackup,
planPruneBackups,
type BackupFileEntry,
type BackupListEntry,
} from "./backupCore";

export const privileged = definePrivilegedContracts({
  ensureEncryptionKey: {
    request: z.object({ spaceDir: z.string().min(1) }),
    response: z.object({ keyBase64: z.string() }),
  },
  listBackups: {
    request: z.object({ spaceDir: z.string().min(1) }),
    response: z.object({
      backups: z.array(
        z.object({
          name: z.string(),
          sizeBytes: z.number(),
          modifiedMs: z.number(),
          // Which folder the listing resolved this backup to:
          // "own" (deletable from the app) or "legacy" (exists
          // only in the read-only legacy shared folder).
          source: z.enum(["own", "legacy"]),
        }),
      ),
    }),
  },
  deleteBackup: {
    request: z.object({
      spaceDir: z.string().min(1),
      filename: z.string().min(1),
    }),
    response: z.object({
      ok: z.boolean(),
      reason: z.string(),
    }),
  },
  deleteAllBackups: {
    request: z.object({ spaceDir: z.string().min(1) }),
    response: z.object({
      ok: z.boolean(),
      reason: z.string(),
      deletedCount: z.number(),
    }),
  },
  createBackup: {
    request: z.object({
      spaceDir: z.string().min(1),
      payloadJson: z.string().min(1),
    }),
    response: z.object({
      ok: z.boolean(),
      filename: z.string().nullable(),
      reason: z.string(),
      prunedCount: z.number(),
    }),
  },
});

// --- Encrypted backup files (per-space folder + legacy union) ---
// Cluster B (finding F4): backups are written to a PER-SPACE folder,
// <spaceDir>/backups, so two spaces on the same box can never collide
// on a date-based filename, and one space's prune / delete-all can
// never touch another space's backups. The folder the pre-isolation
// code wrote to — the workspace-level spending-tracker-backups
// directory shared by every space — is LEGACY and READ-ONLY for
// these handlers: listings union it in (existing backups stay
// visible and restorable, and the backup public key still lives
// there), but no handler ever writes, deletes, or prunes a file in
// it, and existing legacy files are never moved or copied. When the
// same filename exists in both folders, the per-space copy wins.
// The decision rules live in server/src/backupCore.ts; this file
// only performs the filesystem work they plan. The ONLY files these
// handlers may ever touch match backup-*.mstbak in one of those two
// exact folders. Anything else (mst-crypt.mjs, key files, any other
// name, any path traversal) is refused.

/** This space's own backups folder — the only folder written to. */
function ownBackupsDir(spaceDir: string): string {
  return perSpaceBackupsDir(resolve(spaceDir));
}

/**
 * The legacy shared folder, located by walking up from the space
 * dir (workspace/ts-spaces/<slug> -> workspace/spending-tracker-
 * backups) exactly as the pre-isolation code did — but a candidate
 * is accepted ONLY when it equals backupCore's canonical legacy
 * location, so a stray same-named folder nearer the space is never
 * mistaken for it. Resolved even when it does not exist, so
 * listings simply see an empty legacy side.
 */
function legacyDir(spaceDir: string): string {
  const canonical = legacyBackupsDir(resolve(spaceDir));
  let dir = resolve(spaceDir);
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "spending-tracker-backups");
    if (candidate === canonical && existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return canonical;
}

function readDirBackups(dir: string): BackupFileEntry[] {
  if (!existsSync(dir)) return [];
  const out: BackupFileEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (!isBackupFilename(name)) continue;
    try {
      const st = statSync(join(dir, name));
      if (!st.isFile()) continue;
      out.push({ name, sizeBytes: st.size, modifiedMs: st.mtimeMs });
    } catch {
      // Vanished between readdir and stat — skip it.
    }
  }
  return out;
}

function ownBackupFiles(spaceDir: string): BackupFileEntry[] {
  return readDirBackups(ownBackupsDir(spaceDir));
}

function legacyBackupFiles(spaceDir: string): BackupFileEntry[] {
  return readDirBackups(legacyDir(spaceDir));
}

/**
 * The listing a space sees: its own backups unioned with the
 * legacy folder's, per-space copy winning any duplicate name
 * (backupCore.mergeBackupListingsWithSource). Each entry carries
 * its source so the client can mark legacy-only backups as
 * read-only instead of offering a Delete that must refuse.
 */
function listBackupFiles(spaceDir: string): BackupListEntry[] {
  return mergeBackupListingsWithSource(
    ownBackupFiles(spaceDir),
    legacyBackupFiles(spaceDir),
  );
}


function keyFilePath(spaceDir: string): string {
  return join(spaceDir, ".secrets", "encryption-key.v1");
}

function readExistingKey(path: string): string | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8").trim();
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length !== 32) {
    throw new Error(
      "Encryption key file is corrupt (expected a 256-bit key). Refusing to continue so encrypted data is not damaged.",
    );
  }
  return raw;
}

export const privilegedHandlers = definePrivilegedHandlers(privileged, {
  ensureEncryptionKey(args) {
    const path = keyFilePath(args.spaceDir);
    const existing = readExistingKey(path);
    if (existing) return { keyBase64: existing };
    const keyBase64 = randomBytes(32).toString("base64");
    mkdirSync(dirname(path), { recursive: true });
    try {
      // "wx": fail rather than overwrite if another invocation raced us.
      writeFileSync(path, keyBase64, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch {
      const raced = readExistingKey(path);
      if (raced) return { keyBase64: raced };
      throw new Error("Could not create the encryption key file.");
    }
    return { keyBase64 };
  },
  listBackups(args) {
    return { backups: listBackupFiles(args.spaceDir) };
  },
  deleteBackup(args) {
    // Only this space's OWN backups can be deleted. A backup that
    // exists only in the legacy shared folder is refused — that
    // folder is read-only (backupCore.planDeleteBackup).
    const plan = planDeleteBackup(
      args.filename,
      ownBackupFiles(args.spaceDir),
      legacyBackupFiles(args.spaceDir),
    );
    if (!plan.ok) return { ok: false, reason: plan.reason };
    const dir = ownBackupsDir(args.spaceDir);
    const target = resolve(join(dir, args.filename));
    // The resolved file must sit directly inside the space's own
    // backups folder.
    if (dirname(target) !== resolve(dir)) {
      return {
        ok: false,
        reason: "Refused: that file is not in the backups folder.",
      };
    }
    if (!existsSync(target)) {
      return { ok: false, reason: "That backup is already gone." };
    }
    unlinkSync(target);
    return { ok: true, reason: `Deleted ${args.filename}.` };
  },
  deleteAllBackups(args) {
    // Deletes this space's OWN backups only. Legacy files in the
    // shared folder are never named by the plan and stay in place.
    const dir = ownBackupsDir(args.spaceDir);
    const names = planDeleteAllBackups(ownBackupFiles(args.spaceDir));
    let deleted = 0;
    for (const name of names) {
      const target = resolve(join(dir, name));
      if (dirname(target) !== resolve(dir)) continue;
      if (!isBackupFilename(name)) continue;
      try {
        unlinkSync(target);
        deleted++;
      } catch {
        // Leave failures in place; the count reports what went.
      }
    }
    return {
      ok: true,
      reason:
        deleted === 0
          ? "No backups to delete."
          : `Deleted ${deleted} backup${deleted === 1 ? "" : "s"}.`,
      deletedCount: deleted,
    };
  },
  createBackup(args) {
    // Manual on-demand backup, encrypted with the EXISTING A1 scheme
    // (mst-crypt2.mjs v2): a per-backup random AES-256-GCM data key
    // wrapped with RSA-4096 OAEP (SHA-256) using ONLY the public key
    // stored in the backups folder. The private key is never read
    // here — decryption stays an offline, on-request operation.
    const fail = (reason: string) => ({
      ok: false,
      filename: null,
      reason,
      prunedCount: 0,
    });
    // The backup is written into THIS SPACE'S OWN folder. The
    // public key is read from that folder when present, else from
    // the legacy folder (where it lives today) — reading the key
    // from the legacy folder is a read only; nothing is written
    // there.
    const dir = ownBackupsDir(args.spaceDir);
    let pub: string;
    try {
      mkdirSync(dir, { recursive: true });
      pub = readFileSync(join(dir, "mst-backup-public.pem"), "utf8");
    } catch {
      try {
        pub = readFileSync(
          join(legacyDir(args.spaceDir), "mst-backup-public.pem"),
          "utf8",
        );
      } catch {
        return fail(
          "Could not read the backup public key (mst-backup-public.pem) in the backups folder. No backup was created.",
        );
      }
    }
    const plain = Buffer.from(args.payloadJson, "utf8");
    const payloadSha256 = createHash("sha256").update(plain).digest("hex");
    // Filename within the backup-*.mstbak pattern, dated in the
    // user's timezone like the weekly backups. A same-day file is
    // never overwritten: fall back to a time suffix (then a counter).
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
    // The name is chosen against THIS SPACE'S OWN folder only
    // (backupCore.chooseBackupFilename): another space's same-date
    // backup can no longer force a suffix here, and a legacy file
    // with the same date does not block the plain date name — the
    // new per-space copy simply wins the listing.
    const filename = chooseBackupFilename(
      new Set(ownBackupFiles(args.spaceDir).map((f) => f.name)),
      datePart,
      timePart,
    );
    let envelopeJson: string;
    try {
      const dataKey = randomBytes(32);
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
      const data = Buffer.concat([cipher.update(plain), cipher.final()]);
      const wrappedKey = publicEncrypt(
        {
          key: pub,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
        },
        dataKey,
      );
      envelopeJson = JSON.stringify({
        format: "mst-backup-enc",
        v: 2,
        alg: "RSA-4096-OAEP-SHA256 + AES-256-GCM",
        wrappedKey: wrappedKey.toString("base64"),
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        payloadSha256,
        data: data.toString("base64"),
      });
    } catch {
      return fail("Encryption failed. No backup was created.");
    }
    // Write to a temp file in the same folder, rename into place,
    // then read back and verify the envelope — a failure at any step
    // leaves no partial or corrupt file in the list.
    const tmpPath = join(dir, `.mst-create-${randomBytes(8).toString("hex")}.tmp`);
    const finalPath = join(dir, filename);
    try {
      writeFileSync(tmpPath, envelopeJson, { encoding: "utf8", flag: "wx" });
      renameSync(tmpPath, finalPath);
      const env = JSON.parse(readFileSync(finalPath, "utf8"));
      if (
        env.format !== "mst-backup-enc" ||
        env.v !== 2 ||
        env.payloadSha256 !== payloadSha256 ||
        typeof env.wrappedKey !== "string" ||
        typeof env.iv !== "string" ||
        typeof env.tag !== "string" ||
        typeof env.data !== "string"
      ) {
        try {
          unlinkSync(finalPath);
        } catch {
          // Best effort: never leave a bad envelope listed.
        }
        return fail(
          "The new backup failed verification and was removed. No backup was created.",
        );
      }
    } catch {
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath);
      } catch {
        // Nothing more to clean up.
      }
      return fail("Could not write the backup file. No backup was created.");
    }
    // Rotation, over THIS SPACE'S OWN backups only: keep the
    // newest 12 (backupCore.planPruneBackups — most recently
    // modified first, name as tie-break). The plan is computed
    // from the per-space listing alone, so legacy files and other
    // spaces' backups can never be pruned from here. Only files
    // matching the backup pattern are ever pruned — mst-crypt*.mjs
    // and the public key are never touched.
    let prunedCount = 0;
    for (const name of planPruneBackups(
      ownBackupFiles(args.spaceDir),
      BACKUP_KEEP_NEWEST,
    )) {
      const target = resolve(join(dir, name));
      if (dirname(target) !== resolve(dir)) continue;
      if (!isBackupFilename(name)) continue;
      try {
        unlinkSync(target);
        prunedCount++;
      } catch {
        // Leave failures in place; the count reports what went.
      }
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
});
