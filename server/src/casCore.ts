/* ---------------- Compare-and-swap core (contract v65) ----------------
   The pure decisions behind the CAS sweep (write-idempotency audit
   group B, findings F11–F19, F22, F26): every full-record editor
   loads before it edits, so the loaded values travel with the save
   as its `base`; a save whose base no longer matches what is stored
   is REFUSED with the conflict result shape and the stored newer
   value stays intact. This module is the testable seam — the same
   reason rothRevisionCore.ts / rothUiStateCore.ts exist: the
   accuracy fixtures pin these exact functions, the ones the
   handlers run, without importing actions.ts.

   Two primitives cover every family:
   - casCanonical / casDeepEqual: a stable structural equality over
     plain JSON-shaped values (object key order irrelevant, array
     order significant, `undefined` object members treated as
     absent — a zod-parsed base and a leniently parsed stored
     record can differ in key presence for unset optional fields
     without differing in value).
   - casFieldMismatch: the first field (in the caller's order) on
     which a stored record and a loaded base disagree, or null when
     they agree on every named field. Handlers compare only the
     fields the editor actually replaces.

   And one revision decision for the Net Worth snapshot counter
   (F11/F12): a supplied base must equal the stored revision
   exactly; a missing base is the legacy unchecked path (named in
   DATA-PLAN), exactly the lenient shape decideRothBlobWrite gives
   the blob records. Contract v93 adds the restore epoch to that
   decision (F5): a supplied epoch that differs from the stored
   epoch is refused first, whatever the revision numbers say. */

export function casCanonical(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((v) => casCanonical(v)).join(",")}]`;
  }
  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const keys = Object.keys(rec)
      .filter((k) => rec[k] !== undefined)
      .sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${casCanonical(rec[k])}`)
      .join(",")}}`;
  }
  if (typeof value === "number") {
    // -0 and 0 are the same stored figure; NaN never reaches a
    // stored record through a writer, and reads as itself.
    return `n:${Object.is(value, -0) ? 0 : value}`;
  }
  return `${typeof value}:${JSON.stringify(value) ?? "undefined"}`;
}

export function casDeepEqual(a: unknown, b: unknown): boolean {
  return casCanonical(a) === casCanonical(b);
}

/* The first named field on which `stored` and `base` disagree, or
   null when they agree on all of them. A field absent from either
   side reads as undefined on that side, so a base that names a
   field the stored record lacks (or vice versa) mismatches unless
   both sides lack it. */
export function casFieldMismatch(
  stored: Record<string, unknown>,
  base: Record<string, unknown>,
  fields: readonly string[],
): string | null {
  for (const f of fields) {
    if (!casDeepEqual(stored[f], base[f])) return f;
  }
  return null;
}

/* The Net Worth snapshot revision decision (F11/F12): identical
   semantics to decideRothBlobWrite — a supplied base must match
   the stored revision exactly; anything else (stale, or from a
   "future" revision) is refused; an accepted write stores
   storedRevision + 1. A missing base is allowed (the legacy
   unchecked path, named in DATA-PLAN) and still bumps.

   Contract v93 (stored-data finding F5) adds the restore epoch:
   `storedEpoch` is the restore generation the dataset is on and
   `baseEpoch` the generation the editor observed when it loaded.
   The epoch check runs FIRST and is independent of the revision:
   a supplied epoch that differs from the stored epoch is refused
   as an epoch conflict even when the revision numbers happen to
   match — that is exactly the restored-snapshot collision (a
   restore restarts revisions, so revision equality alone cannot
   tell a pre-restore editor from a fresh one). A missing epoch
   keeps the pre-v93 revision-only behaviour (the same tolerated
   legacy leniency as a missing base); no live editor omits it. */
export type CasRevisionDecision =
  | { allowed: true; nextRevision: number }
  | {
      allowed: false;
      storedRevision: number;
      epochConflict: boolean;
    };

/* The settings key carrying the restore epoch (contract v93):
   a plain integer string — a generation counter, structural
   metadata like the snapshot revision column, not a financial
   value, so it is stored unencrypted like the revision. Absent
   (or unparseable) reads as epoch 0, the pre-restore era. */
export const NW_RESTORE_EPOCH_SETTING = "nw_restore_epoch_v1";

export function parseRestoreEpoch(value: string | undefined): number {
  if (value == null) return 0;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/* The epoch a restore stamps: always one past the epoch the
   dataset was on before the restore, whatever the backup
   carried — a carried epoch value is never trusted, so an old
   backup with no epoch information still advances the epoch,
   and a second restore advances it again. */
export function nextRestoreEpoch(storedEpoch: number): number {
  return storedEpoch + 1;
}

export function decideCasRevision(
  storedRevision: number,
  baseRevision: number | undefined,
  storedEpoch = 0,
  baseEpoch?: number,
): CasRevisionDecision {
  if (baseEpoch !== undefined && baseEpoch !== storedEpoch) {
    return { allowed: false, storedRevision, epochConflict: true };
  }
  if (baseRevision !== undefined && baseRevision !== storedRevision) {
    return { allowed: false, storedRevision, epochConflict: false };
  }
  return { allowed: true, nextRevision: storedRevision + 1 };
}

/* The December-style conflict reason the CAS families share: a
   newer copy was saved elsewhere, this edit was NOT saved over it.
   `what` names the record in the editor's own words ("transaction",
   "snapshot", "monthly bill", …). */
export function casConflictReason(what: string): string {
  return `A newer copy was saved elsewhere — this ${what} changed in another tab or on another device since you opened it, so your edit wasn't saved over it. The latest saved version is shown now; make your change again from there.`;
}

/* The restore-epoch conflict reason (contract v93, F5): the
   dataset was replaced by a backup restore after the editor
   loaded, so the edit must not save over the restored version.
   It names the restore cause, so the refusal is distinguishable
   from an ordinary newer-copy conflict. */
export function casRestoreEpochConflictReason(what: string): string {
  return `A backup was restored since you opened this ${what} — the restored version replaced what you loaded, so your edit wasn't saved over it. The latest saved version is shown now; make your change again from there.`;
}
