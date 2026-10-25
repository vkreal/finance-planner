// Backup directory isolation (cluster B, finding F4) — the pure
// path/listing/rotation rules the privileged backup handlers
// (server/src/privileged.ts) execute against the real filesystem,
// factored out so the accuracy fixtures
// (server/src/extendedFixtures.ts) can pin them against a synthetic
// two-space layout without touching a disk.
//
// The rules, in one place:
//   * Every space writes its backups into its OWN folder,
//     <spaceDir>/backups — never a folder shared with other spaces.
//     Backup filenames stay date-based (backup-YYYY-MM-DD.mstbak);
//     the per-space folder alone removes cross-space collisions.
//   * The folder the pre-isolation code used — the workspace-level
//     spending-tracker-backups directory — is LEGACY and READ-ONLY:
//     listings union it in (so existing backups stay visible and
//     restorable), but delete / delete-all / prune never touch it.
//   * When the same filename exists in both folders, the per-space
//     copy wins: the listing shows it once, with the per-space
//     copy's size/timestamp, and reads resolve to the per-space copy.
//   * Prune keeps the newest KEEP_NEWEST backups OF THIS SPACE
//     (most recently modified first, name as tie-break) and selects
//     victims only from this space's own folder.
//
// This module is pure string/data logic: no filesystem, no clock,
// no randomness. The privileged handlers supply the real directory
// listings and perform the writes/deletes these functions plan.

export interface BackupFileEntry {
  name: string;
  sizeBytes: number;
  modifiedMs: number;
}

export const BACKUP_KEEP_NEWEST = 12;

const BACKUP_FILENAME_RE = /^backup-[A-Za-z0-9][A-Za-z0-9._-]*\.mstbak$/;

export function isBackupFilename(name: string): boolean {
  if (!BACKUP_FILENAME_RE.test(name)) return false;
  if (name.includes("..")) return false;
  if (name.includes("/") || name.includes("\\")) return false;
  return true;
}

/* ------------------------- Path rules -------------------------
   POSIX-style joins on the space directory string, matching the
   host the privileged handlers run on. A trailing slash on the
   space dir is tolerated. */

function trimTrailingSlashes(p: string): string {
  const t = p.replace(/\/+$/, "");
  return t === "" ? "/" : t;
}

function parentDir(p: string): string {
  const t = trimTrailingSlashes(p);
  const i = t.lastIndexOf("/");
  if (i < 0) return ".";
  if (i === 0) return "/";
  return t.slice(0, i);
}

/** This space's own backups folder: <spaceDir>/backups. */
export function perSpaceBackupsDir(spaceDir: string): string {
  return `${trimTrailingSlashes(spaceDir)}/backups`;
}

/**
 * The legacy shared folder's canonical location:
 * <spaceDir>/../../spending-tracker-backups (the workspace level,
 * two parents up from workspace/ts-spaces/<slug>). The privileged
 * handlers may locate an EXISTING legacy folder by walking up, but
 * it must resolve to this canonical directory — anything found
 * elsewhere on the walk is not the legacy folder.
 */
export function legacyBackupsDir(spaceDir: string): string {
  return `${parentDir(parentDir(spaceDir))}/spending-tracker-backups`;
}

/* ----------------------- Listing rules ------------------------ */

/**
 * The list a space sees: the union of its own backups and the
 * legacy folder's backups. A filename present in both appears
 * ONCE, with the per-space copy's size/timestamp (the per-space
 * copy wins). Sorted newest-name-first, the order the backup
 * list has always used.
 */
export function mergeBackupListings(
  own: BackupFileEntry[],
  legacy: BackupFileEntry[],
): BackupFileEntry[] {
  const byName = new Map<string, BackupFileEntry>();
  for (const f of legacy) if (isBackupFilename(f.name)) byName.set(f.name, f);
  for (const f of own) if (isBackupFilename(f.name)) byName.set(f.name, f);
  const out = [...byName.values()];
  out.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  return out;
}

/** A listed backup plus which folder the listing resolved it to.
 *  "own" = this space's own backups folder (deletable from here);
 *  "legacy" = the file exists ONLY in the legacy shared folder,
 *  which is read-only — it can be restored but never deleted from
 *  here. When a name exists in both folders the per-space copy
 *  wins, so its source is "own". */
export interface BackupListEntry extends BackupFileEntry {
  source: "own" | "legacy";
}

/**
 * The same union listing as mergeBackupListings, with each
 * entry's source attached, so the Backups panel can tell the
 * user up front which backups it can actually delete instead of
 * offering a Delete button that can only refuse.
 */
export function mergeBackupListingsWithSource(
  own: BackupFileEntry[],
  legacy: BackupFileEntry[],
): BackupListEntry[] {
  const byName = new Map<string, BackupListEntry>();
  for (const f of legacy)
    if (isBackupFilename(f.name)) byName.set(f.name, { ...f, source: "legacy" });
  for (const f of own)
    if (isBackupFilename(f.name)) byName.set(f.name, { ...f, source: "own" });
  const out = [...byName.values()];
  out.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  return out;
}

/**
 * Which copy a read (restore / list detail) resolves to for a
 * filename: the per-space copy when it exists, else the legacy
 * copy, else nothing. The per-space copy always wins.
 */
export function backupReadSource(
  name: string,
  own: BackupFileEntry[],
  legacy: BackupFileEntry[],
): "own" | "legacy" | null {
  if (!isBackupFilename(name)) return null;
  if (own.some((f) => f.name === name)) return "own";
  if (legacy.some((f) => f.name === name)) return "legacy";
  return null;
}

/* --------------------- Mutation planning ----------------------
   Deletes and prunes are planned against THIS SPACE'S OWN listing
   only. Legacy entries are never passed in, so no plan can name
   a legacy file. */

/**
 * Whether one named backup may be deleted by this space, and why
 * not when it may not. A legacy-only file is refused outright:
 * the legacy folder is read-only, so a backup that exists only
 * there cannot be deleted from this space.
 */
export function planDeleteBackup(
  name: string,
  own: BackupFileEntry[],
  legacy: BackupFileEntry[],
): { ok: boolean; reason: string } {
  if (!isBackupFilename(name)) {
    return {
      ok: false,
      reason:
        "Refused: only backup-*.mstbak files in the backups folder can be deleted.",
    };
  }
  if (own.some((f) => f.name === name)) return { ok: true, reason: "" };
  if (legacy.some((f) => f.name === name)) {
    return {
      ok: false,
      reason:
        "That backup is in the legacy shared backups folder, which is read-only — it can't be deleted from here.",
    };
  }
  return { ok: false, reason: "That backup is already gone." };
}

/** The names delete-all removes: every one of THIS space's own
 *  backups, and nothing from the legacy folder. */
export function planDeleteAllBackups(own: BackupFileEntry[]): string[] {
  return own.filter((f) => isBackupFilename(f.name)).map((f) => f.name);
}

/**
 * The names prune removes from THIS space's own folder so the
 * newest `keep` remain: most recently modified first, name as
 * tie-break (the rotation order the backup writer has always
 * used). Legacy files are never candidates — they are not part
 * of `own`, and the keep count is computed over own files only.
 */
export function planPruneBackups(
  own: BackupFileEntry[],
  keep: number = BACKUP_KEEP_NEWEST,
): string[] {
  const byNewest = own
    .filter((f) => isBackupFilename(f.name))
    .slice()
    .sort((a, b) => b.modifiedMs - a.modifiedMs || (a.name < b.name ? 1 : -1));
  return byNewest.slice(keep).map((f) => f.name);
}

/**
 * The filename a new backup gets inside this space's own folder:
 * backup-<date>.mstbak, falling back to a time suffix (then a
 * counter) when that name is already taken IN THIS FOLDER. Only
 * this space's own existing names are consulted — another space's
 * same-date backup can no longer force a suffix or a collision.
 */
export function chooseBackupFilename(
  ownNames: ReadonlySet<string>,
  datePart: string,
  timePart: string,
): string {
  let filename = `backup-${datePart}.mstbak`;
  if (!ownNames.has(filename)) return filename;
  filename = `backup-${datePart}-${timePart}.mstbak`;
  let n = 2;
  while (ownNames.has(filename)) {
    filename = `backup-${datePart}-${timePart}-${n}.mstbak`;
    n++;
  }
  return filename;
}
