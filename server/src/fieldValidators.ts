// Shared field validators — the ONE definition of the per-field
// rules the ordinary writers enforce, imported by BOTH the writer
// input schemas (server/src/actions.ts) and the backup payload
// schema + restore preflight (server/src/restoreCore.ts), so a
// value no writer would accept can never drift into a restore
// through a second, looser copy of the rule (contract v60, F4 —
// the packaged-parity audit found dueMonth and the monthly-bill
// name enforced by the writers but not by restore preflight).
//
// Each fragment is the exact zod chain the writers used inline
// before this module existed; the writers now reference these
// names, and restoreCore's backup schemas reference the same
// names, so the two sides share the rule by construction, not by
// convention. The mutate-every-field extended fixture pins the
// parity behaviorally: every backed-up field set to a
// writer-illegal value must refuse the restore before any write.
import { z } from "@hatch/space-sdk";

/** Yearly bill due month: a calendar month or null (no due month). */
export const dueMonthField = z.number().int().min(1).max(12).nullable();

/** Bill names (yearly expenses and monthly bills): 1–120 chars. */
export const billNameField = z.string().min(1).max(120);

/** Paid-by / account labels: 1–60 chars. */
export const paidByField = z.string().min(1).max(60);

/** Bill category labels: 1–60 chars. */
export const category60Field = z.string().min(1).max(60);

/** Transaction category labels: 1–40 chars. */
export const txnCategoryField = z.string().min(1).max(40);

/** Transaction / one-off / cash-out item descriptions: 1–200 chars. */
export const descriptionField = z.string().min(1).max(200);

/** Monthly bill notes: at most 300 chars. */
export const billNotesField = z.string().max(300);

/** One-off / cash-out item notes: at most 1000 chars. */
export const longNoteField = z.string().max(1000);

/** Net Worth snapshot notes: at most 500 chars. */
export const snapshotNoteField = z.string().max(500);

/** Net Worth account names: 1–80 chars. */
export const nwAccountNameField = z.string().min(1).max(80);

/** A bank transaction id (OFX FITID) when present: 1–200 chars. */
export const fitIdField = z.string().min(1).max(200);

/** A stored 0/1 flag as carried in a backup payload (writers store
    booleans as the integers 1 and 0; nothing else is a flag). */
export const backupFlagField = z.number().int().min(0).max(1);
