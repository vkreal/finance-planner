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
   the blob records. */

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
   unchecked path, named in DATA-PLAN) and still bumps. */
export type CasRevisionDecision =
  | { allowed: true; nextRevision: number }
  | { allowed: false; storedRevision: number };

export function decideCasRevision(
  storedRevision: number,
  baseRevision: number | undefined,
): CasRevisionDecision {
  if (baseRevision !== undefined && baseRevision !== storedRevision) {
    return { allowed: false, storedRevision };
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
