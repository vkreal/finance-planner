// Backup restore core — the single implementation of the backup
// payload schema, the restore preflight, the split/balance
// normalisation, and the restore plan + atomic-execution model,
// shared by the restorebackup action (server/src/actions.ts) and
// the extended accuracy fixtures (server/src/extendedFixtures.ts),
// so the fixture suite exercises the exact validation and
// normalisation the restore runs.
//
// Restore safety contract (cluster A):
//   1. FULL preflight before any write. The whole payload is
//      schema-validated (with the legacy defaults below applied),
//      the payload's own encryption key-check is verified against
//      the current key, every enum is checked for membership, and
//      intra-payload uniqueness + referential integrity are
//      checked. Any failure refuses the restore with zero writes.
//   2. The destructive replacement is ONE atomic batch: the wipe
//      and every insert land together or not at all.
//   3. Split/balance rule (E4): a balance row whose split is
//      non-empty is normalised — balanceCents is RECOMPUTED as the
//      sum of the split parts, exactly as every normal writer does
//      (nwBalanceRowValues in actions.ts), never trusted from the
//      payload. An unsplit row keeps its payload balanceCents.

import { z } from "@hatch/space-sdk";
import { NW_PROPERTY_KINDS, splitPartsOf } from "./nwCore";
import {
parseRothBlobRevision,
withRothBlobRevision,
} from "./rothRevisionCore";

export const BACKUP_FORMAT = "monthly-spending-tracker-backup";
export const BACKUP_SCHEMA_VERSION = 1;

export const BACKUP_KEY_CHECK_SETTING = "encryption_key_check_v1";
export const BACKUP_KEY_CHECK_PLAINTEXT = "hatch-encryption-check-v1";

/* ------------------------- Payload schema -------------------------
   The exact shape exportbackup returns. Fields a current export
   always writes stay required; fields added after v1 backups were
   already in the wild carry legacy defaults, following the
   schema's existing pattern (custodial / splitPreTaxCents), so an
   older v1 backup missing them still validates and restores with
   the documented default instead of failing outright. */

export const backupYearlyExpense = z.object({
  id: z.number().int(),
  name: z.string(),
  frequency: z.string(),
  expectedCents: z.number().int(),
  dueMonth: z.number().int().nullable(),
  paidByType: z.string(),
  paidByName: z.string(),
  backfillBeforeFirstVersion: z.number().int(),
  category: z.string(),
  keepLightsOn: z.number().int(),
  createdAt: z.number(),
});
export const backupYearlyExpenseVersion = z.object({
  id: z.number().int(),
  expenseId: z.number().int(),
  expectedCents: z.number().int(),
  frequency: z.string(),
  effectiveFrom: z.string(),
  createdAt: z.number(),
});
export const backupTransaction = z.object({
  id: z.number().int(),
  date: z.string(),
  description: z.string(),
  amountCents: z.number().int(),
  sourceType: z.string(),
  accountName: z.string(),
  kind: z.string(),
  category: z.string(),
  yearlyExpenseId: z.number().int().nullable(),
  createdAt: z.number(),
});
export const backupMonthlySummary = z.object({
  month: z.string(),
  cashOutCents: z.number().int(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export const backupMonthlyBill = z.object({
  id: z.number().int(),
  name: z.string(),
  amountCents: z.number().int(),
  paidBy: z.string(),
  notes: z.string().nullable(),
  category: z.string(),
  keepLightsOn: z.number().int(),
  collapsed: z.number().int(),
  createdAt: z.number(),
});
export const backupMonthlyBillVersion = z.object({
  id: z.number().int(),
  billId: z.number().int(),
  amountCents: z.number().int(),
  effectiveFrom: z.string(),
  createdAt: z.number(),
});
export const backupMonthlyOneOff = z.object({
  id: z.number().int(),
  month: z.string(),
  description: z.string(),
  amountCents: z.number().int(),
  note: z.string().nullable(),
  createdAt: z.number(),
});
export const backupMonthlyCashOutItem = z.object({
  id: z.number().int(),
  month: z.string(),
  description: z.string(),
  amountCents: z.number().int(),
  note: z.string().nullable(),
  createdAt: z.number(),
});
export const backupNwAccount = z.object({
  id: z.number().int(),
  name: z.string(),
  bucket: z.string(),
  // The property-kind column was added after the first v1 backups:
  // older backups have no such field, so a missing value restores
  // as "none" (ordinary account) — the same treatment the DB
  // column's own default gives an old row. A PRESENT value is not
  // defaulted or coerced here: preflight validates it against the
  // property-kind enum and rejects anything else loudly.
  propertyKind: z.string().default("none"),
  // Added with the custodial account type: older backups have no
  // such field, so a missing value restores as 0 (ordinary).
  custodial: z.number().int().default(0),
  sortOrder: z.number().int(),
  archived: z.number().int(),
  createdAt: z.number(),
});
export const backupNwSnapshot = z.object({
  id: z.number().int(),
  date: z.string(),
  note: z.string().nullable(),
  createdAt: z.number(),
});
export const backupNwBalance = z.object({
  id: z.number().int(),
  snapshotId: z.number().int(),
  accountId: z.number().int(),
  balanceCents: z.number().int(),
  // The six original split columns were added after the first v1
  // backups: older backups have no such fields, so a missing value
  // restores as null (no split part) — the same default the later
  // splitPreTaxCents column below already carried.
  splitHsaCents: z.number().int().nullable().default(null),
  splitRothCents: z.number().int().nullable().default(null),
  splitTaxableCents: z.number().int().nullable().default(null),
  splitNonTaxableCents: z.number().int().nullable().default(null),
  split529Cents: z.number().int().nullable().default(null),
  splitCashCents: z.number().int().nullable().default(null),
  // Added with the Pre-tax bucket: older backups have no such
  // field, so a missing value restores as null (no split part).
  splitPreTaxCents: z.number().int().nullable().default(null),
});
export const backupSetting = z.object({
  key: z.string(),
  value: z.string(),
});

export const backupPayload = z.object({
  format: z.string(),
  schemaVersion: z.number().int(),
  exportedAt: z.string(),
  yearlyExpenses: z.array(backupYearlyExpense),
  yearlyExpenseVersions: z.array(backupYearlyExpenseVersion),
  transactions: z.array(backupTransaction),
  monthlySummaries: z.array(backupMonthlySummary),
  monthlyBills: z.array(backupMonthlyBill),
  monthlyBillVersions: z.array(backupMonthlyBillVersion),
  monthlyOneOffs: z.array(backupMonthlyOneOff),
  monthlyCashOutItems: z.array(backupMonthlyCashOutItem),
  nwAccounts: z.array(backupNwAccount),
  nwSnapshots: z.array(backupNwSnapshot),
  nwBalances: z.array(backupNwBalance),
  settings: z.array(backupSetting),
});

export type BackupPayload = z.infer<typeof backupPayload>;
export type BackupNwBalance = z.infer<typeof backupNwBalance>;

/* ------------------- Split / balance normalisation -------------------
   The E4 rule, matching every normal writer: when a balance's
   split is non-empty, the split parts ARE the balance — the stored
   balanceCents is their sum, recomputed here, so a restored row
   can never make snapshotTotals (which sums balanceCents) and
   bucketSubtotals (which treats the split as authoritative)
   disagree. When the split is empty, the payload's balanceCents
   stands as entered. */

export function backupSplitSumCents(b: BackupNwBalance): number | null {
  const parts = splitPartsOf(b);
  if (parts.length === 0) return null;
  return parts.reduce((s, p) => s + p.amountCents, 0);
}

export function normalizeBackupBalance(b: BackupNwBalance): BackupNwBalance {
  const sum = backupSplitSumCents(b);
  return sum == null ? b : { ...b, balanceCents: sum };
}

/* ---------------- Date validity (writer parity) ----------------
   The payload schema carries dates and months as plain strings;
   preflight validates them with the SAME rule the ordinary
   writers enforce (actions.ts's dateString: the YYYY-MM-DD
   shape plus a real calendar date — the transaction writer
   refuses 2026-02-31, so the restore refuses it too; a restored
   "not-a-date" used to persist and vanish from month views,
   and a restored 2026-02-31 aggregated under a February that
   never had one). The calendar helper is the ONE
   implementation: it lives here and actions.ts imports it, so
   the writer and the restore can never drift apart. Version
   effectiveFrom values are months (YYYY-MM), the granularity
   the bill/expense version writers store, so they validate as
   months, not dates. */

export function isRealCalendarDate(s: string): boolean {
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (!Number.isFinite(y) || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const BACKUP_DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const BACKUP_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isBackupCalendarDate(s: string): boolean {
  return BACKUP_DATE_RE.test(s) && isRealCalendarDate(s);
}

export function isBackupMonth(s: string): boolean {
  return BACKUP_MONTH_RE.test(s);
}

/* --------------------------- Preflight ---------------------------
   Every check the restore runs BEFORE any write. The handler
   computes `payloadKeyCheckValid` from the payload's own key-check
   setting (see payloadKeyCheckValue below): true when the payload
   carries a key-check that decrypts to the known constant under
   the current key (or carries the constant decrypted, as current
   exports do), false when it carries one that does not, and null
   when the payload carries no key-check setting at all (nothing to
   verify — the restore creates one afterwards, as before). */

export function payloadKeyCheckValue(
  payload: BackupPayload,
): string | null {
  const row = payload.settings.find((s) => s.key === BACKUP_KEY_CHECK_SETTING);
  return row ? row.value : null;
}

const YEARLY_FREQUENCIES: readonly string[] = [
  "yearly",
  "bimonthly",
  "quarterly",
  "semiannual",
];
const PAID_BY_TYPES: readonly string[] = ["checking", "card"];
const TXN_SOURCE_TYPES: readonly string[] = ["checking", "card"];
const TXN_KINDS: readonly string[] = ["spending", "card_payment", "transfer"];

export type RestorePreflightResult =
  | { ok: true; reason: string }
  | { ok: false; reason: string };

function refuse(reason: string): RestorePreflightResult {
  return { ok: false, reason: `${reason} Nothing was changed.` };
}

export function preflightRestoreBackup(
  payload: BackupPayload,
  payloadKeyCheckValid: boolean | null,
): RestorePreflightResult {
  if (
    payload.format !== BACKUP_FORMAT ||
    payload.schemaVersion !== BACKUP_SCHEMA_VERSION
  ) {
    return refuse(
      `Not a recognised backup payload (expected format "${BACKUP_FORMAT}", schemaVersion ${BACKUP_SCHEMA_VERSION}).`,
    );
  }
  // The encryption key check against the PAYLOAD, before any
  // delete: a backup made under a different key carries a key-check
  // that does not validate under this key, and restoring it would
  // strand every figure behind the wrong key.
  if (payloadKeyCheckValid === false) {
    return refuse(
      "Backup rejected: its encryption key check does not match this app's encryption key — the backup was made under a different key.",
    );
  }

  // Enum membership. The normal API validates these with z.enum and
  // the DB columns are enums; a value outside the set must refuse
  // loudly, never be silently coerced (a propertyKind of "liabilty"
  // must not restore as an ordinary asset account).
  for (const a of payload.nwAccounts) {
    if (!(NW_PROPERTY_KINDS as readonly string[]).includes(a.propertyKind)) {
      return refuse(
        `Backup rejected: Net Worth account ${a.id} ("${a.name}") has an unrecognised propertyKind "${a.propertyKind}" (expected one of: ${NW_PROPERTY_KINDS.join(", ")}).`,
      );
    }
  }
  for (const y of payload.yearlyExpenses) {
    if (!YEARLY_FREQUENCIES.includes(y.frequency)) {
      return refuse(
        `Backup rejected: yearly expense ${y.id} ("${y.name}") has an unrecognised frequency "${y.frequency}".`,
      );
    }
    if (!PAID_BY_TYPES.includes(y.paidByType)) {
      return refuse(
        `Backup rejected: yearly expense ${y.id} ("${y.name}") has an unrecognised paidByType "${y.paidByType}".`,
      );
    }
  }
  for (const v of payload.yearlyExpenseVersions) {
    if (!YEARLY_FREQUENCIES.includes(v.frequency)) {
      return refuse(
        `Backup rejected: yearly expense version ${v.id} has an unrecognised frequency "${v.frequency}".`,
      );
    }
  }
  for (const t of payload.transactions) {
    if (!TXN_SOURCE_TYPES.includes(t.sourceType)) {
      return refuse(
        `Backup rejected: transaction ${t.id} has an unrecognised sourceType "${t.sourceType}".`,
      );
    }
    if (!TXN_KINDS.includes(t.kind)) {
      return refuse(
        `Backup rejected: transaction ${t.id} has an unrecognised kind "${t.kind}".`,
      );
    }
  }

  // Date validity — the same calendar rule the ordinary writers
  // enforce (see the date-validity section above), checked here
  // where the refusal can name the row and the offending value.
  for (const t of payload.transactions) {
    if (!isBackupCalendarDate(t.date)) {
      return refuse(
        `Backup rejected: transaction ${t.id} has an invalid date "${t.date}" — not a real calendar date (YYYY-MM-DD).`,
      );
    }
  }
  for (const s of payload.nwSnapshots) {
    if (!isBackupCalendarDate(s.date)) {
      return refuse(
        `Backup rejected: Net Worth snapshot ${s.id} has an invalid date "${s.date}" — not a real calendar date (YYYY-MM-DD).`,
      );
    }
  }
  for (const v of payload.yearlyExpenseVersions) {
    if (!isBackupMonth(v.effectiveFrom)) {
      return refuse(
        `Backup rejected: yearly expense version ${v.id} has an invalid effectiveFrom "${v.effectiveFrom}" — not a real month (YYYY-MM).`,
      );
    }
  }
  for (const v of payload.monthlyBillVersions) {
    if (!isBackupMonth(v.effectiveFrom)) {
      return refuse(
        `Backup rejected: monthly bill version ${v.id} has an invalid effectiveFrom "${v.effectiveFrom}" — not a real month (YYYY-MM).`,
      );
    }
  }
  for (const s of payload.monthlySummaries) {
    if (!isBackupMonth(s.month)) {
      return refuse(
        `Backup rejected: monthly summary has an invalid month "${s.month}" — not a real month (YYYY-MM).`,
      );
    }
  }
  for (const o of payload.monthlyOneOffs) {
    if (!isBackupMonth(o.month)) {
      return refuse(
        `Backup rejected: monthly one-off ${o.id} has an invalid month "${o.month}" — not a real month (YYYY-MM).`,
      );
    }
  }
  for (const it of payload.monthlyCashOutItems) {
    if (!isBackupMonth(it.month)) {
      return refuse(
        `Backup rejected: monthly cash-out item ${it.id} has an invalid month "${it.month}" — not a real month (YYYY-MM).`,
      );
    }
  }

  // Intra-payload uniqueness: duplicate ids, duplicate snapshot
  // dates (nwSnapshots.date is UNIQUE in the DB), duplicate setting
  // keys, duplicate summary months, and duplicate (snapshot,
  // account) balance pairs must all refuse here rather than fail
  // halfway through the replacement.
  const dupId = (
    rows: { id: number }[],
    label: string,
  ): RestorePreflightResult | null => {
    const seen = new Set<number>();
    for (const r of rows) {
      if (seen.has(r.id)) {
        return refuse(`Backup rejected: duplicate ${label} id ${r.id}.`);
      }
      seen.add(r.id);
    }
    return null;
  };
  for (const [rows, label] of [
    [payload.yearlyExpenses, "yearly expense"],
    [payload.yearlyExpenseVersions, "yearly expense version"],
    [payload.transactions, "transaction"],
    [payload.monthlyBills, "monthly bill"],
    [payload.monthlyBillVersions, "monthly bill version"],
    [payload.monthlyOneOffs, "monthly one-off"],
    [payload.monthlyCashOutItems, "monthly cash-out item"],
    [payload.nwAccounts, "Net Worth account"],
    [payload.nwSnapshots, "Net Worth snapshot"],
    [payload.nwBalances, "Net Worth balance"],
  ] as const) {
    const failure = dupId(rows, label);
    if (failure) return failure;
  }
  {
    const seenDates = new Set<string>();
    for (const s of payload.nwSnapshots) {
      if (seenDates.has(s.date)) {
        return refuse(
          `Backup rejected: duplicate Net Worth snapshot date "${s.date}" (snapshot ids ${payload.nwSnapshots
            .filter((x) => x.date === s.date)
            .map((x) => x.id)
            .join(", ")}).`,
        );
      }
      seenDates.add(s.date);
    }
    const seenMonths = new Set<string>();
    for (const s of payload.monthlySummaries) {
      if (seenMonths.has(s.month)) {
        return refuse(
          `Backup rejected: duplicate monthly summary month "${s.month}".`,
        );
      }
      seenMonths.add(s.month);
    }
    const seenKeys = new Set<string>();
    for (const s of payload.settings) {
      if (seenKeys.has(s.key)) {
        return refuse(`Backup rejected: duplicate setting key "${s.key}".`);
      }
      seenKeys.add(s.key);
    }
    const seenPairs = new Set<string>();
    for (const b of payload.nwBalances) {
      const pair = `${b.snapshotId}/${b.accountId}`;
      if (seenPairs.has(pair)) {
        return refuse(
          `Backup rejected: duplicate Net Worth balance for snapshot ${b.snapshotId}, account ${b.accountId}.`,
        );
      }
      seenPairs.add(pair);
    }
  }

  // Referential integrity: every child row must point at a parent
  // the same payload carries, or the insert would fail (or orphan)
  // mid-replacement.
  const yearlyIds = new Set(payload.yearlyExpenses.map((y) => y.id));
  for (const v of payload.yearlyExpenseVersions) {
    if (!yearlyIds.has(v.expenseId)) {
      return refuse(
        `Backup rejected: yearly expense version ${v.id} refers to missing yearly expense ${v.expenseId}.`,
      );
    }
  }
  for (const t of payload.transactions) {
    if (t.yearlyExpenseId != null && !yearlyIds.has(t.yearlyExpenseId)) {
      return refuse(
        `Backup rejected: transaction ${t.id} refers to missing yearly expense ${t.yearlyExpenseId}.`,
      );
    }
  }
  const billIds = new Set(payload.monthlyBills.map((b) => b.id));
  for (const v of payload.monthlyBillVersions) {
    if (!billIds.has(v.billId)) {
      return refuse(
        `Backup rejected: monthly bill version ${v.id} refers to missing monthly bill ${v.billId}.`,
      );
    }
  }
  const snapshotIds = new Set(payload.nwSnapshots.map((s) => s.id));
  const accountIds = new Set(payload.nwAccounts.map((a) => a.id));
  for (const b of payload.nwBalances) {
    if (!snapshotIds.has(b.snapshotId)) {
      return refuse(
        `Backup rejected: Net Worth balance ${b.id} refers to missing snapshot ${b.snapshotId}.`,
      );
    }
    if (!accountIds.has(b.accountId)) {
      return refuse(
        `Backup rejected: Net Worth balance ${b.id} refers to missing account ${b.accountId}.`,
      );
    }
  }

  return { ok: true, reason: "Preflight passed." };
}

/* ----------------- Restore plan + atomic execution -----------------
   The replacement as an ordered statement list: every table wipe
   (children before parents) first, then the inserts in the order
   the handler performs them, with balances already normalised.
   The handler executes this plan as ONE db.batch(...) call; the
   executor below models that batch's atomic semantics over a
   plain state object so the fixtures can stage real plan failures
   (including an injected mid-plan failure) and prove the prior
   state survives untouched — the batch either commits every
   statement or none. */

export const RESTORE_WIPE_ORDER = [
  "nwBalances",
  "nwSnapshots",
  "nwAccounts",
  "transactions",
  "yearlyExpenseVersions",
  "monthlyBillVersions",
  "monthlyOneOffs",
  "monthlyCashOutItems",
  "monthlySummaries",
  "monthlyBills",
  "yearlyExpenses",
  "settings",
] as const;
export type RestoreTable = (typeof RESTORE_WIPE_ORDER)[number];

export type RestoreStatement =
  | { op: "deleteAll"; table: RestoreTable }
  | { op: "insert"; table: RestoreTable; row: Record<string, unknown> };

export type RestoreState = Record<RestoreTable, Record<string, unknown>[]>;

export function emptyRestoreState(): RestoreState {
  return {
    nwBalances: [],
    nwSnapshots: [],
    nwAccounts: [],
    transactions: [],
    yearlyExpenseVersions: [],
    monthlyBillVersions: [],
    monthlyOneOffs: [],
    monthlyCashOutItems: [],
    monthlySummaries: [],
    monthlyBills: [],
    yearlyExpenses: [],
    settings: [],
  };
}

export function cloneRestoreState(state: RestoreState): RestoreState {
  return JSON.parse(JSON.stringify(state)) as RestoreState;
}

// A stable fingerprint of a state: the same rows in the same order
// fingerprint identically, so a fixture can prove byte-identical
// preservation by string equality.
export function restoreStateFingerprint(state: RestoreState): string {
  const ordered: Record<string, unknown> = {};
  for (const table of RESTORE_WIPE_ORDER) ordered[table] = state[table];
  return JSON.stringify(ordered);
}

export function buildRestorePlan(payload: BackupPayload): RestoreStatement[] {
  const plan: RestoreStatement[] = [];
  for (const table of RESTORE_WIPE_ORDER) plan.push({ op: "deleteAll", table });
  const insert = (
    table: RestoreTable,
    rows: Record<string, unknown>[],
  ): void => {
    for (const row of rows) plan.push({ op: "insert", table, row });
  };
  insert("settings", payload.settings as unknown as Record<string, unknown>[]);
  insert(
    "yearlyExpenses",
    payload.yearlyExpenses as unknown as Record<string, unknown>[],
  );
  insert(
    "yearlyExpenseVersions",
    payload.yearlyExpenseVersions as unknown as Record<string, unknown>[],
  );
  insert(
    "monthlyBills",
    payload.monthlyBills as unknown as Record<string, unknown>[],
  );
  insert(
    "monthlyBillVersions",
    payload.monthlyBillVersions as unknown as Record<string, unknown>[],
  );
  insert(
    "monthlySummaries",
    payload.monthlySummaries as unknown as Record<string, unknown>[],
  );
  insert(
    "monthlyOneOffs",
    payload.monthlyOneOffs as unknown as Record<string, unknown>[],
  );
  insert(
    "monthlyCashOutItems",
    payload.monthlyCashOutItems as unknown as Record<string, unknown>[],
  );
  insert(
    "transactions",
    payload.transactions as unknown as Record<string, unknown>[],
  );
  insert(
    "nwAccounts",
    payload.nwAccounts as unknown as Record<string, unknown>[],
  );
  insert(
    "nwSnapshots",
    payload.nwSnapshots as unknown as Record<string, unknown>[],
  );
  insert(
    "nwBalances",
    payload.nwBalances.map(
      (b) => normalizeBackupBalance(b) as unknown as Record<string, unknown>,
    ),
  );
  return plan;
}

// Primary / unique keys the executor enforces while applying a
// plan, mirroring the DB constraints a real mid-batch failure
// would trip (row ids, settings.key, monthlySummaries.month, and
// nwSnapshots.date UNIQUE).
function restoreRowKey(table: RestoreTable, row: Record<string, unknown>): string | null {
  if (table === "settings") return `key:${String(row.key)}`;
  if (table === "monthlySummaries") return `month:${String(row.month)}`;
  if (typeof row.id === "number") return `id:${row.id}`;
  return null;
}

export function executeRestorePlanAtomically(
  prior: RestoreState,
  plan: RestoreStatement[],
  failAtStatement: number | null = null,
): { committed: boolean; state: RestoreState; failedAt: number | null } {
  const work = cloneRestoreState(prior);
  for (let i = 0; i < plan.length; i++) {
    const stmt = plan[i];
    if (!stmt) continue;
    if (failAtStatement != null && i === failAtStatement) {
      return { committed: false, state: prior, failedAt: i };
    }
    if (stmt.op === "deleteAll") {
      work[stmt.table] = [];
      continue;
    }
    const key = restoreRowKey(stmt.table, stmt.row);
    if (
      key != null &&
      work[stmt.table].some((r) => restoreRowKey(stmt.table, r) === key)
    ) {
      return { committed: false, state: prior, failedAt: i };
    }
    if (
      stmt.table === "nwSnapshots" &&
      work.nwSnapshots.some((r) => r.date === stmt.row.date)
    ) {
      return { committed: false, state: prior, failedAt: i };
    }
    work[stmt.table].push(stmt.row);
  }
  return { committed: true, state: work, failedAt: null };
}

/* ----------------- Roth blob restore stamp (R4-2 / F4) -----------------
   A restore is a write generation: the restored Roth blob's
   revision is stamped to max(preRestoreRevision, backupRevision)
   + 1, so a tab holding a pre-restore base is refused afterwards
   instead of saving over the restored record. */

export const RESTORE_ROTH_BLOB_KEY = "roth_conversion_inputs_v1";

export function restoredRothBlobRevision(
  preRestoreRevision: number,
  backupRevision: number,
): number {
  return Math.max(preRestoreRevision, backupRevision) + 1;
}

export function stampRestoredRothBlob(
  backupPlainJson: string,
  preRestoreRevision: number,
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(backupPlainJson) as unknown;
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return JSON.stringify(
    withRothBlobRevision(
      parsed as Record<string, unknown>,
      restoredRothBlobRevision(
        preRestoreRevision,
        parseRothBlobRevision(backupPlainJson),
      ),
    ),
  );
}

// The handler's full restore flow, over the plain state: parse +
// legacy defaults, preflight, plan, atomic execution. Any failure
// leaves `prior` untouched and reports the same reason the handler
// returns. The handler itself differs only in transport (it
// encrypts the plan's rows and executes them as one db.batch).
// The Roth blob stamp is part of the modelled flow: attemptRestore
// stamps the Roth settings row exactly as the handler does (the
// handler differs only in transport and applies the same helpers).
export function attemptRestore(
  prior: RestoreState,
  rawPayload: unknown,
  payloadKeyCheckValid: boolean | null,
  failAtStatement: number | null = null,
): { ok: boolean; reason: string; state: RestoreState; committed: boolean } {
  const parsed = backupPayload.safeParse(rawPayload);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue ? issue.path.join(".") : "";
    return {
      ok: false,
      reason: `Backup rejected: the payload does not match the backup schema${where ? ` (at ${where})` : ""}${issue ? `: ${issue.message}` : ""}. Nothing was changed.`,
      state: prior,
      committed: false,
    };
  }
  const pre = preflightRestoreBackup(parsed.data, payloadKeyCheckValid);
  if (!pre.ok) return { ok: false, reason: pre.reason, state: prior, committed: false };
  const priorRothRow = prior.settings.find((s) => s.key === RESTORE_ROTH_BLOB_KEY);
  const preRestoreRevision =
    priorRothRow && typeof priorRothRow.value === "string"
      ? parseRothBlobRevision(priorRothRow.value)
      : 0;
  const effectivePayload: BackupPayload = {
    ...parsed.data,
    settings: parsed.data.settings.map((s) => {
      if (s.key !== RESTORE_ROTH_BLOB_KEY) return s;
      const stamped = stampRestoredRothBlob(s.value, preRestoreRevision);
      return stamped != null ? { ...s, value: stamped } : s;
    }),
  };
  const plan = buildRestorePlan(effectivePayload);
  const exec = executeRestorePlanAtomically(prior, plan, failAtStatement);
  if (!exec.committed) {
    return {
      ok: false,
      reason: "Restore failed partway through and was rolled back — the previous data is intact. Nothing was changed.",
      state: prior,
      committed: false,
    };
  }
  return { ok: true, reason: "Restored.", state: exec.state, committed: true };
}
