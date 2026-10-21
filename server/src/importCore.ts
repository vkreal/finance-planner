// CSV import planning core — the single source for the
// importTransactions call plan, shared by the handler
// (server/src/actions.ts) and the extended accuracy fixtures
// (server/src/extendedFixtures.ts), so the fixture suite pins the
// exact decision the handler executes (the encPrefixCore /
// nwCore core-extraction pattern).
//
// Atomicity contract (API follow-on 3, finding F12): ONE
// importTransactions call is atomic. The handler
//   1. plans the whole batch here BEFORE any write — every text
//      field of every row goes through the shared reserved-prefix
//      decision (planTextStore in encPrefixCore); one poisoned
//      row anywhere refuses the WHOLE plan with that reason and
//      zero statements;
//   2. builds every row's encrypted insert statement before any
//      write executes;
//   3. executes all statements as a single db.batch, so any
//      failure lands ZERO rows from that call.
// This write path has NO dedupe of its own, deliberately:
// duplicate protection lives in the import preview (IM-1),
// where the panel compares parsed rows against already-recorded
// transactions read back in plaintext and excludes matches
// unless the user includes them — stored amounts/descriptions
// are ciphertext, so content matching can only happen where
// plaintext exists. describeApi states this split on the
// importTransactions action.

import {
planTextStore,
type TextStorePlan,
} from "./encPrefixCore";

// The three user-text fields every imported row carries — the
// fields the reserved-prefix guard applies to.
export type ImportTextRow = {
  description: string;
  accountName: string;
  category: string;
};

// One planned insert statement: the row it inserts and the store
// decision for each of its text fields.
export type ImportStatementPlan = {
  rowIndex: number;
  description: TextStorePlan;
  accountName: TextStorePlan;
  category: TextStorePlan;
};

export type ImportBatchPlan =
  | { ok: true; statements: ImportStatementPlan[] }
  | { ok: false; reason: string; statements: [] };

// Plan one import call: EVERY row is planned before the plan is
// returned — the first field (in row order, then description /
// accountName / category order) whose decision is reject refuses
// the whole batch with that decision's reason and NO statements.
// A valid batch plans exactly one statement per row, in order.
// `verifyCiphertext` is the caller's proof a prefixed value is
// genuine ciphertext: in actions.ts it is backed by real AES
// decrypt attempts under the request key; in the fixtures it
// recognises model ciphertext.
export function planImportBatch(
  rows: ImportTextRow[],
  verifyCiphertext: (v: string) => boolean,
): ImportBatchPlan {
  const statements: ImportStatementPlan[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const description = planTextStore(r.description, verifyCiphertext);
    const accountName = planTextStore(r.accountName, verifyCiphertext);
    const category = planTextStore(r.category, verifyCiphertext);
    for (const p of [description, accountName, category]) {
      if (p.action === "reject") {
        return { ok: false, reason: p.reason, statements: [] };
      }
    }
    statements.push({ rowIndex: i, description, accountName, category });
  }
  return { ok: true, statements };
}

/* ------------------- Plain-state model executor -------------------
   The fixtures' side of the handler's write, mirroring nwCore's
   executeNwWritePlanAtomically: the plan's statements append each
   row's stored form (the three text fields' stored strings,
   JSON-encoded per row) to the stored list — and an injected
   mid-plan failure (failAtStatement) commits NOTHING, returning
   the prior list byte-identical, exactly as the handler's single
   db.batch rolls the whole call back. `storeText` maps one field
   value + its planned decision to its stored form; in the
   fixtures it produces model ciphertext / passthrough, in
   production the handler encrypts with real AES-GCM instead. */

export function executeImportPlanAtomically(
  priorStored: string[],
  plan: Extract<ImportBatchPlan, { ok: true }>,
  rows: ImportTextRow[],
  storeText: (value: string, plan: TextStorePlan) => string,
  failAtStatement: number | null = null,
): { committed: boolean; stored: string[]; failedAt: number | null } {
  const work = [...priorStored];
  for (let i = 0; i < plan.statements.length; i++) {
    if (failAtStatement != null && i === failAtStatement) {
      return { committed: false, stored: priorStored, failedAt: i };
    }
    const stmt = plan.statements[i];
    if (!stmt) continue;
    const row = rows[stmt.rowIndex];
    if (!row) continue;
    work.push(
      JSON.stringify([
        storeText(row.description, stmt.description),
        storeText(row.accountName, stmt.accountName),
        storeText(row.category, stmt.category),
      ]),
    );
  }
  return { committed: true, stored: work, failedAt: null };
}
