// First-run seed guard (contract v60, F7) — the ONE emptiness
// predicate every seed path consults.
//
// Before v60 the two seed actions each checked a different,
// incomplete subset of the dataset (seedExamples looked at four
// spending tables; seedNetWorth looked only at Net Worth
// accounts), so a store holding real records in an unchecked
// table — a saved planner record in settings, a lone one-off —
// still received the sample rows beside them. The rule now: the
// dataset is seedable only when EVERY dataset table is empty,
// and the check fails closed — a table whose state is unknown
// or unreported counts as NOT empty, never as empty.
//
// The settings table carries one infrastructure row that is not
// user data: the encryption key check, which ensureKeyCheck
// creates on the first data load (before any seed runs). The
// handler-side counter therefore reports settings presence
// EXCLUDING that key; every other settings row — planner blobs,
// UI state, targets, import settings — is a real record and
// blocks seeding.

export const DATASET_TABLES = [
  "transactions",
  "yearlyExpenses",
  "yearlyExpenseVersions",
  "monthlySummaries",
  "monthlyBills",
  "monthlyBillVersions",
  "monthlyOneOffs",
  "monthlyCashOutItems",
  "nwAccounts",
  "nwSnapshots",
  "nwBalances",
  "settings",
] as const;

export type DatasetTable = (typeof DATASET_TABLES)[number];

/** Presence map: true = the table holds at least one record. */
export type DatasetPresence = Partial<Record<DatasetTable, boolean>>;

/**
 * True only when every dataset table is reported present-in-the-
 * map AND empty. A missing entry (the counter did not report the
 * table) is unknown state and fails closed: not empty.
 */
export function datasetIsEmpty(presence: DatasetPresence): boolean {
  for (const table of DATASET_TABLES) {
    if (presence[table] !== false) return false;
  }
  return true;
}

/** The tables blocking a seed, for the refusal reason. */
export function nonEmptyDatasetTables(presence: DatasetPresence): DatasetTable[] {
  return DATASET_TABLES.filter((t) => presence[t] !== false);
}
