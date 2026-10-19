import { z } from "@hatch/space-sdk";

/* ---------------- Roth plan-record revision / CAS ----------------
   The saved Roth plan record (settings key
   "roth_conversion_inputs_v1") is ONE encrypted JSON document:
   { inputs, scenarios }. API follow-on 1 (finding F3) gives it
   the same revision-checked write contract the Roth UI-state
   blob already has (server/src/rothUiStateCore.ts), with the
   revision carried as a third top-level key in the same
   document: { inputs, scenarios, revision }.

   The revision lives OUTSIDE `inputs`, so parseRothInputs —
   which builds a fixed field set from blob.inputs — never sees
   it, and it can never reach a pricing path. Parsing is
   lenient, mirroring parseRothUiState: a missing, non-integer,
   or negative revision reads as 0, so a blob written before
   revisions existed (the current production blob has no
   revision key) needs no migration and no backfill write — it
   reads as revision 0 until the first post-build save stamps
   revision 1.

   Writers pass the revision their copy of the record was read
   at (baseRevision); decideRothBlobWrite refuses the write
   when the stored revision has moved past that base (a
   concurrent save from another tab or device landed first), so
   an older in-flight save can never silently clobber newer
   values. A write with no baseRevision keeps the legacy
   unchecked behaviour (the path chat-driven / dictated writes
   take); either way, an accepted write stores revision + 1.

   The commit is atomic, not just checked — but the UI-state
   blob's SQL guard cannot be copied verbatim: that blob is
   plain JSON, so SQL can json_extract its revision, while the
   Roth blob is ciphertext (enc:v1:…) and SQL can see nothing
   inside it. The guarded commit for this blob therefore
   predicates on the one value SQL can compare: the stored raw
   value itself. The handler issues ONE UPDATE … WHERE key =
   'roth_conversion_inputs_v1' AND value = :storedRawCiphertext
   (the raw value the writer read) and branches on the
   affected-row count: 1 row = committed; 0 rows = a concurrent
   write landed first, storage is untouched by this invocation,
   and the writer is refused with the re-read current record.
   Byte-equality on the ciphertext is a sound CAS predicate
   regardless of encryptStr's IV behaviour (production uses a
   fresh random 12-byte nonce per encryption, so ANY
   intervening write — even of identical content — changes the
   stored value and trips the guard; were encryption
   deterministic, an intervening write of identical content
   would produce the identical value, the guard would pass,
   and the outcome would be the same content — no data can be
   lost either way).

   This module is the testable seam, extracted for the same
   reason rothUiStateCore.ts exists: the accuracy fixtures pin
   these exact functions — the ones the handlers run — without
   importing actions.ts.

   F23 NOTE (API follow-on F23): the two Retirement records —
   blob 1 (settings key "retirement_calc_inputs_v1", the flat
   working record { …17 fields…, scenarios }) and blob 2
   (settings key "retirement_calc_baseline_v1", { kind, inputs })
   — SHARE this seam rather than forking it. Their handlers
   import the same revision read (rothBlobRevisionValue /
   rothBlobRevisionOf / parseRothBlobRevision), the same CAS
   decision (decideRothBlobWrite), and the same guarded-commit
   mirror (rothBlobStoredRawMatches /
   commitGuardedRothBlobWrite), so the CAS rules have ONE
   implementation pinned by two suites (roth-cas +
   retirement-cas) and cannot drift between the records. The
   Retirement-specific pure decisions and composes the Roth
   record has no analogue for — the session-baseline capture's
   guard-or-skip predicate, the saveRetirementBaseline
   pair-commit decision table, the two blob composes, and the
   scenario transforms — live in the F23 section at the bottom
   of this module, and the retirement-cas fixtures pin those
   exact functions too. */

/* The lenient revision read for a single raw value: only a
   non-negative integer counts; anything else (missing, string,
   fractional, negative, null) reads as 0. */
export function rothBlobRevisionValue(v: unknown): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0;
}

/* The revision of a parsed blob document (any value: a
   non-object reads as revision 0). */
export function rothBlobRevisionOf(blob: unknown): number {
  if (blob == null || typeof blob !== "object" || Array.isArray(blob)) {
    return 0;
  }
  return rothBlobRevisionValue(
    (blob as Record<string, unknown>).revision,
  );
}

/* The lenient revision read for a stored blob's PLAIN JSON
   text (the decrypted document): an absent blob, unparseable
   text, or a malformed revision all read as 0. */
export function parseRothBlobRevision(plainJson: string | undefined): number {
  if (!plainJson) return 0;
  try {
    return rothBlobRevisionOf(JSON.parse(plainJson) as unknown);
  } catch {
    return 0;
  }
}

/* Stamp a revision onto a blob document: returns a copy whose
   top-level `revision` key carries the given value. Key order
   matches joinRothBlob's three-segment form (inputs, scenarios,
   revision): a document without a revision gains it last, and
   a document that already carries one keeps its position. */
export function withRothBlobRevision<T extends Record<string, unknown>>(
  blob: T,
  revision: number,
): T & { revision: number } {
  return { ...blob, revision };
}

/* ---------------- Write contract (CAS) ----------------
   saveRothInputs' success shape: an accepted write returns the
   revision it stored. (The full response union lives in
   actions.ts beside rothPlannerResponse, because the conflict
   branch carries the whole current planner record.) */
export const saveRothInputsOkResponse = z.object({
  ok: z.literal(true),
  revision: z.number().int().nonnegative(),
});

/* The CAS decision for one write, given the stored revision
   and the writer's base revision — semantics IDENTICAL to
   decideRothUiWrite in rothUiStateCore.ts: a writer that
   supplies no base keeps the legacy unchecked path and is
   always allowed; a supplied base must match the stored
   revision exactly; anything else (stale OR from a "future"
   revision, including a positive base against an absent row,
   which reads as revision 0) means a newer write landed first
   and this write must not clobber it. Either way an accepted
   write stores storedRevision + 1. */
export type RothBlobCasDecision =
  | { allowed: true; nextRevision: number }
  | { allowed: false; storedRevision: number };

export function decideRothBlobWrite(
  storedRevision: number,
  baseRevision: number | undefined,
): RothBlobCasDecision {
  if (baseRevision !== undefined && baseRevision !== storedRevision) {
    return { allowed: false, storedRevision };
  }
  return { allowed: true, nextRevision: storedRevision + 1 };
}

/* ---------------- Guarded commit (atomic CAS) ----------------
   decideRothBlobWrite decides against the stored value the
   writer READ. Two invocations can both read revision N before
   either commits, both decide "allowed", and — if the commit
   were an unconditional upsert — the second would silently
   overwrite the first. The handlers therefore commit a guarded
   write against an existing row with a single UPDATE whose
   WHERE clause re-checks, inside the same statement that
   writes, that the stored raw value still equals the raw value
   the writer read, and branch on the statement's
   affected-row count.

   The two functions below are that commit's testable mirror,
   the analogue of commitGuardedRothUiWrite /
   rothUiStoredRevisionMatches in rothUiStateCore.ts.
   rothBlobStoredRawMatches is the exact predicate the SQL
   guard evaluates — "the stored raw value at commit time
   equals the raw value the writer read" — and
   commitGuardedRothBlobWrite is a SINGLE-GATE mirror of it:
   its affected-rows verdict depends on that predicate alone,
   exactly as the handler's commit does (in production the SQL
   value-equality predicate is the sole commit-time gate; the
   handler's decideRothBlobWrite runs earlier, on the
   decrypted read).

   commitGuardedRothBlobWrite evaluates a guarded commit
   against the stored raw value AS IT STANDS AT COMMIT TIME
   (not a stale read snapshot): predicate false → affectedRows
   0, no raw form to persist, and the CURRENT stored revision
   (leniently parsed) carried back for the refusal; predicate
   true → the successor the caller's compose callback builds
   against that current value is what persists, affecting
   exactly 1 row. The compose callback's product is never
   consulted for the verdict — otherwise a predicate broken to
   always match would be masked by the compose step and the
   fixtures could not catch it. The mirror works on the blob's
   plain JSON text; in production the same predicate runs over
   the ciphertext, which is the only form SQL can compare (see
   the header). */
export function rothBlobStoredRawMatches(
  storedRawAtCommit: string | undefined,
  readRaw: string | undefined,
): boolean {
  return storedRawAtCommit === readRaw;
}

export type RothBlobGuardedCommitResult =
  | { affectedRows: 1; revision: number; raw: string }
  | { affectedRows: 0; revision: number };

export function commitGuardedRothBlobWrite(
  currentStoredRaw: string | undefined,
  readRaw: string | undefined,
  compose: (
    currentPlain: string | undefined,
  ) => { plain: string; revision: number },
): RothBlobGuardedCommitResult {
  // Single gate: the predicate alone decides the verdict.
  if (!rothBlobStoredRawMatches(currentStoredRaw, readRaw)) {
    return {
      affectedRows: 0,
      revision: parseRothBlobRevision(currentStoredRaw),
    };
  }
  const successor = compose(currentStoredRaw);
  return {
    affectedRows: 1,
    revision: successor.revision,
    raw: successor.plain,
  };
}

/* ---------------- Retirement records (F23) ----------------
   The Retirement-specific pure decisions and composes the
   handlers in actions.ts run, kept beside the shared CAS rules
   above so the retirement-cas fixtures pin the exact functions
   (the fixture harness cannot import actions.ts). */

/* The session-baseline capture's guard-or-skip predicate
   (getRetirementCalc's hidden writer): the capture may CREATE
   the baseline row only when no baseline row exists at commit
   time; against any existing row (either kind) it must skip —
   a read can never surface a CAS refusal, so it must never
   replace. The handler encodes the commit-time half of this
   with an insert-if-absent statement (onConflictDoNothing);
   this function pins the decision that statement's outcome
   encodes. */
export function decideRetirementCapture(
  baselineExistsAtCommit: boolean,
): "write" | "skip" {
  return baselineExistsAtCommit ? "skip" : "write";
}

/* Blob 1's compose (saveRetirementCalc /
   saveRetirementBaseline): the request's input fields, the
   scenarios array preserved from the writer's read, and the
   revision stamp EXPLICIT in the compose — the request fields
   alone would silently drop a stored revision, because unlike
   the Roth blob there is no separate inputs segment for the
   stamp to ride beside. */
export function composeRetirementInputsBlob(
  inputs: Record<string, unknown>,
  scenarios: unknown,
  revision: number,
): Record<string, unknown> {
  return { ...inputs, scenarios, revision };
}

/* Blob 2's compose (saveRetirementBaseline's successor and
   the session capture's candidate): { kind, inputs } plus the
   revision stamp. The successor is fully determined by the
   request — it never depends on the old baseline — which is
   what makes the baseline retry (re-read once, re-commit
   against the fresh raw) safely re-appliable. */
export function composeRetirementBaselineBlob(
  kind: string,
  inputs: Record<string, unknown>,
  revision: number,
): Record<string, unknown> {
  return { kind, inputs, revision };
}

/* The scenario writers' successor: the parsed stored document
   with ONLY its scenarios array replaced and the revision
   stamped stored + 1 — the stamp is assigned AFTER the spread,
   so a revision key already in the document is overwritten
   (never duplicated) and every other top-level field is
   preserved exactly. */
export function composeRetirementScenarioBlob(
  existing: Record<string, unknown>,
  scenarios: unknown,
  revision: number,
): Record<string, unknown> {
  return { ...existing, scenarios, revision };
}

/* ---------------- Scenario transforms ----------------
   The three Retirement scenario writers' transforms, exactly
   as mutateRetirementScenarios applies them: name-keyed and
   safely re-appliable against a fresh array (the retry re-runs
   the same function, validation included). A transform that
   declines to write carries its verdict against the CURRENT
   array and touches no storage. The verdict strings are the
   writers' long-standing user-facing reasons, unchanged. */
export type RetirementScenarioTransform<T> =
  | { write: true; ok: boolean; reason: string; scenarios: T[] }
  | { write: false; ok: boolean; reason: string };

/* Append the given input set as a new scenario, auto-named the
   smallest free "Scenario N" (cap 3 saved scenarios). */
export function appendRetirementScenario<T extends { name: string }>(
  scenarios: T[],
  fields: Omit<T, "name">,
): RetirementScenarioTransform<T> {
  if (scenarios.length >= 3) {
    return {
      write: false,
      ok: false,
      reason:
        "You already have 3 scenarios saved — delete one to save another.",
    };
  }
  const used = new Set(scenarios.map((s) => s.name));
  let n = 1;
  while (used.has(`Scenario ${n}`)) n += 1;
  const scenario = { name: `Scenario ${n}`, ...fields } as T;
  return {
    write: true,
    ok: true,
    reason: `Saved as ${scenario.name}.`,
    scenarios: [...scenarios, scenario],
  };
}

/* Delete the scenario with the given name. */
export function deleteRetirementScenario<T extends { name: string }>(
  scenarios: T[],
  name: string,
): RetirementScenarioTransform<T> {
  const next = scenarios.filter((s) => s.name !== name);
  if (next.length === scenarios.length) {
    return { write: false, ok: false, reason: "That scenario was not found." };
  }
  return {
    write: true,
    ok: true,
    reason: `Deleted ${name}.`,
    scenarios: next,
  };
}

/* Rename a scenario: the new name must be non-blank after
   trimming and must not collide with a DIFFERENT scenario's
   name; renaming to the same name is a successful no-write. */
export function renameRetirementScenario<T extends { name: string }>(
  scenarios: T[],
  name: string,
  newName: string,
): RetirementScenarioTransform<T> {
  const target = scenarios.find((s) => s.name === name);
  if (!target) {
    return { write: false, ok: false, reason: "That scenario was not found." };
  }
  const trimmed = newName.trim();
  if (trimmed === "") {
    return { write: false, ok: false, reason: "Give the scenario a name first." };
  }
  if (scenarios.some((s) => s.name !== name && s.name === trimmed)) {
    return {
      write: false,
      ok: false,
      reason: "Another scenario already uses that name.",
    };
  }
  if (trimmed === name) {
    return { write: false, ok: true, reason: "Name unchanged." };
  }
  return {
    write: true,
    ok: true,
    reason: `Renamed ${name} to ${trimmed}.`,
    scenarios: scenarios.map((s) =>
      s.name === name ? { ...s, name: trimmed } : s,
    ),
  };
}

/* ---------------- R4-2: CAS completeness ----------------
   Additive only (F23 shares this module): the strict revision
   state, the checked-write decision, the first-write plan, and
   the reset retry decision. Existing exports keep their
   signatures and behaviour byte-for-byte. */

/* The strict revision state of a parsed blob document:
   `present` = a `revision` key exists on a parsed object;
   `valid` = that value is a non-negative integer; `revision`
   is the lenient value (the value when valid, else 0). */
export type RothBlobRevisionState = {
  revision: number;
  present: boolean;
  valid: boolean;
};

export function rothBlobRevisionState(blob: unknown): RothBlobRevisionState {
  if (blob == null || typeof blob !== "object" || Array.isArray(blob)) {
    return { revision: 0, present: false, valid: true };
  }
  const rec = blob as Record<string, unknown>;
  if (!("revision" in rec)) {
    return { revision: 0, present: false, valid: true };
  }
  const v = rec.revision;
  const valid = typeof v === "number" && Number.isInteger(v) && v >= 0;
  return { revision: valid ? (v as number) : 0, present: true, valid };
}

export function rothBlobRevisionStateOfPlain(
  plainJson: string | undefined,
): RothBlobRevisionState {
  if (!plainJson) return { revision: 0, present: false, valid: true };
  try {
    return rothBlobRevisionState(JSON.parse(plainJson) as unknown);
  } catch {
    return { revision: 0, present: false, valid: true };
  }
}

/* The strict CAS decision: a supplied baseRevision against a
   present-but-invalid stored revision is refused; otherwise
   exactly decideRothBlobWrite(stored.revision, baseRevision). */
export function decideRothBlobWriteChecked(
  stored: RothBlobRevisionState,
  baseRevision: number | undefined,
): RothBlobCasDecision {
  if (baseRevision !== undefined && stored.present && !stored.valid) {
    return { allowed: false, storedRevision: stored.revision };
  }
  return decideRothBlobWrite(stored.revision, baseRevision);
}

/* The first-write plan for a Roth blob write. */
export type RothFirstWritePlan =
  | "legacy-upsert"
  | "insert-only"
  | "guarded-update"
  | "refused";

export function rothFirstWritePlan(
  hasStoredRow: boolean,
  baseRevision: number | undefined,
): RothFirstWritePlan {
  if (hasStoredRow) return "guarded-update";
  if (baseRevision === undefined) return "legacy-upsert";
  if (baseRevision === 0) return "insert-only";
  return "refused";
}

export const ROTH_RESET_MAX_ATTEMPTS = 5;

export function decideRothResetAfterLoss(
  lostRaces: number,
): "retry" | "refuse" {
  return lostRaces < ROTH_RESET_MAX_ATTEMPTS ? "retry" : "refuse";
}

/* ---------------- Baseline pair commit ----------------
   saveRetirementBaseline commits TWO blobs in sequence (true
   single-statement pair atomicity is not available on this
   platform, and a guarded UPDATE inside a batch that matches
   0 rows does not fail the batch, so a batch cannot abort the
   pair on a lost guard). The strongest supported contract:
   both bases are decided up front (a refusal on either writes
   NEITHER blob), blob 1 commits exactly as saveRetirementCalc
   does, blob 2 commits guarded on its stored raw, a 0-row
   baseline commit retries ONCE against the fresh raw, and a
   second 0-row reports the honest stage: "baseline" conflict —
   blob 1 is NOT rolled back (a rollback write would itself be
   an unguarded clobber).

   This table is that sequence's decision core: given the
   inputs guard outcome, the baseline guard outcome, the first
   baseline commit outcome, and the retry outcome, it names
   the response shape the handler returns. */
export type RetirementBaselinePairOutcome =
  | "success"
  | "inputs-conflict"
  | "baseline-conflict";

export function decideRetirementBaselinePair(args: {
  /* The inputs (blob 1) fast-path decision refused. */
  inputsRefused: boolean;
  /* The baseline (blob 2) fast-path decision refused (a
     supplied baseBaselineRevision that no longer matches the
     stored baseline revision, decided before ANY write). */
  baselineRefused: boolean;
  /* The first guarded baseline commit: "committed" covers the
     legacy unchecked upsert as well as a 1-row guarded commit;
     "not-run" when a fast-path refusal ended the write. */
  baselineCommit: "committed" | "zero" | "not-run";
  /* The one baseline retry against the fresh raw. */
  baselineRetry: "committed" | "zero" | "not-run";
}): RetirementBaselinePairOutcome {
  if (args.inputsRefused || args.baselineRefused) return "inputs-conflict";
  if (args.baselineCommit === "committed") return "success";
  if (args.baselineCommit === "zero" && args.baselineRetry === "committed")
    return "success";
  return "baseline-conflict";
}
