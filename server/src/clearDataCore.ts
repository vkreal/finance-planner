// Clear-all-data core — the single implementation of the
// clearAllData confirmation gate and its ordered wipe plan,
// shared by the clearAllData action (server/src/actions.ts) and
// the extended accuracy fixtures (server/src/extendedFixtures.ts),
// so the fixture suite exercises the exact gate and plan the
// action runs.
//
// Safety contract (cluster D):
//   1. The wipe happens ONLY when the caller supplies the exact
//      confirmation phrase CLEAR_ALL_CONFIRM_PHRASE. Any other
//      value — missing, empty, a near-miss, a case variant —
//      refuses with { ok: false } and ZERO deletes. The action's
//      request schema also makes the field required, so a call
//      without it never reaches the handler at all.
//   2. The wipe plan is exactly the twelve tables below, in this
//      order (children first, settings last) — the same set and
//      order the handler has always deleted, no more, no less.
//      Settings is last and is very much included: the settings
//      wipe erases the saved planner data too — the Retirement
//      calculator record and baseline, the Roth plan record, and
//      the Roth UI state — not just spending and Net Worth rows.

// The exact phrase the caller must supply to confirm the wipe.
// Case-sensitive, no trimming: "delete", "", "Delete everything",
// and "delete everything " (trailing space) all refuse.
export const CLEAR_ALL_CONFIRM_PHRASE = "delete everything";

// The gate: an exact match on the phrase, and nothing else.
export function isClearAllConfirmed(confirm: unknown): boolean {
  return confirm === CLEAR_ALL_CONFIRM_PHRASE;
}

export const CLEAR_ALL_WIPE_ORDER = [
  "transactions",
  "yearlyExpenseVersions",
  "yearlyExpenses",
  "monthlySummaries",
  "monthlyBillVersions",
  "monthlyBills",
  "monthlyOneOffs",
  "monthlyCashOutItems",
  "nwBalances",
  "nwSnapshots",
  "nwAccounts",
  "settings",
] as const;
export type ClearAllTable = (typeof CLEAR_ALL_WIPE_ORDER)[number];

export type ClearAllStatement = { op: "deleteAll"; table: ClearAllTable };

export function buildClearAllPlan(): ClearAllStatement[] {
  return CLEAR_ALL_WIPE_ORDER.map((table) => ({ op: "deleteAll" as const, table }));
}

export type ClearAllState = Record<ClearAllTable, Record<string, unknown>[]>;

export function emptyClearAllState(): ClearAllState {
  return {
    transactions: [],
    yearlyExpenseVersions: [],
    yearlyExpenses: [],
    monthlySummaries: [],
    monthlyBillVersions: [],
    monthlyBills: [],
    monthlyOneOffs: [],
    monthlyCashOutItems: [],
    nwBalances: [],
    nwSnapshots: [],
    nwAccounts: [],
    settings: [],
  };
}

export function cloneClearAllState(state: ClearAllState): ClearAllState {
  return JSON.parse(JSON.stringify(state)) as ClearAllState;
}

// A stable fingerprint of a state: the same rows in the same order
// fingerprint identically, so a fixture can prove byte-identical
// preservation by string equality.
export function clearAllStateFingerprint(state: ClearAllState): string {
  const ordered: Record<string, unknown> = {};
  for (const table of CLEAR_ALL_WIPE_ORDER) ordered[table] = state[table];
  return JSON.stringify(ordered);
}

// Executes a wipe plan over the plain state (the fixtures' side of
// the shared flow; the handler executes the same plan as one
// db.delete per statement against the real tables).
export function executeClearAllPlan(
  prior: ClearAllState,
  plan: ClearAllStatement[],
): ClearAllState {
  const work = cloneClearAllState(prior);
  for (const stmt of plan) {
    work[stmt.table] = [];
  }
  return work;
}

// The handler's full flow over the plain state: gate first, then
// the plan. A refused call returns ok:false with the prior state
// untouched — zero deletes performed. The handler itself differs
// only in transport (it runs the same gate, then executes the
// same plan against the database).
export function attemptClearAllData(
  prior: ClearAllState,
  confirm: unknown,
): { ok: boolean; state: ClearAllState } {
  if (!isClearAllConfirmed(confirm)) {
    return { ok: false, state: prior };
  }
  return { ok: true, state: executeClearAllPlan(prior, buildClearAllPlan()) };
}
