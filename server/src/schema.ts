// Encryption at rest (app-level, AES-256-GCM): every user-entered
// financial value is stored as "enc:v1:<base64>" ciphertext text —
// amounts/balances (all *_cents columns below, now text) and text
// content (names, descriptions, notes, categories, paid-by/account
// labels). Encryption/decryption happens only in server/src/actions.ts
// (key held outside this database, in a privileged on-host key file);
// the plaintext types the rest of the app works with are reconstructed
// in that data layer. Structural fields (ids, months/dates,
// effective-from, frequencies, due months, booleans, foreign keys)
// stay plaintext so the server can query/sort on them.
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const yearlyExpenses = sqliteTable("yearly_expenses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  // How often the bill is charged. "yearly": expectedCents is the amount
  // per year. The periodic frequencies store expectedCents as the amount
  // PER BILL: "bimonthly" (every other month) is charged 6× a year —
  // annualised × 6, monthly set-aside per-bill ÷ 2; "quarterly" (every
  // 3 months) is charged 4× a year — annualised × 4, set-aside ÷ 3;
  // "semiannual" (every 6 months) is charged 2× a year — annualised × 2,
  // set-aside ÷ 6.
  // Existing rows default to "yearly" and behave exactly as before.
  frequency: text("frequency", {
    enum: ["yearly", "bimonthly", "quarterly", "semiannual"],
  })
    .notNull()
    .default("yearly"),
  expectedCents: text("expected_cents").notNull(),
  // Yearly: the month (1-12) the bill is due. Periodic: a first / next
  // due month (1-12) — due months repeat every 2, 3, or 6 months from it.
  dueMonth: integer("due_month"),
  paidByType: text("paid_by_type", { enum: ["checking", "card"] })
    .notNull()
    .default("checking"),
  paidByName: text("paid_by_name").notNull().default("Checking"),
  // 1 only for legacy/migrated bills (set by the 0007 migration for the
  // bills that existed before versioning): months before their earliest
  // version fall back to that earliest version so their historic numbers
  // are preserved. 0 for every bill created from now on: months before
  // its first version's effective-from contribute ZERO — adding a bill
  // that starts in a future month must not change any earlier month.
  backfillBeforeFirstVersion: integer("backfill_before_first_version")
    .notNull()
    .default(0),
  // One category label per bill (e.g. "Insurance", "Taxes", or a custom
  // name). A label on the bill itself — not versioned, and never changes
  // any amount or total.
  category: text("category").notNull().default("Uncategorized"),
  // "Keep the lights on" check: 1 when this bill is an essential,
  // must-pay bill. Independent of category (a bill can be category
  // "Insurance" AND checked). Like category it is a label on the bill
  // itself — not versioned, and never changes any amount or total; it
  // only feeds the derived keep-the-lights-on floor figure.
  keepLightsOn: integer("keep_lights_on").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const yearlyExpenseVersions = sqliteTable("yearly_expense_versions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  expenseId: integer("expense_id")
    .notNull()
    .references(() => yearlyExpenses.id),
  expectedCents: text("expected_cents").notNull(),
  frequency: text("frequency", {
    enum: ["yearly", "bimonthly", "quarterly", "semiannual"],
  })
    .notNull()
    .default("yearly"),
  // First month (YYYY-MM) this amount + frequency applies to. A month's
  // set-aside uses the latest version with effectiveFrom <= that month.
  // Months before the earliest version contribute zero, unless the bill
  // is flagged legacy/backfill (see yearlyExpenses.backfillBeforeFirstVersion),
  // in which case they fall back to the earliest version.
  effectiveFrom: text("effective_from").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const transactions = sqliteTable("transactions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Calendar date the spending was incurred (charge date for cards,
  // payment date for checking), stored as YYYY-MM-DD.
  date: text("date").notNull(),
  description: text("description").notNull(),
  // Signed cents: positive = money spent / out, negative = refund or credit.
  amountCents: text("amount_cents").notNull(),
  sourceType: text("source_type", { enum: ["checking", "card"] })
    .notNull()
    .default("checking"),
  accountName: text("account_name").notNull().default("Checking"),
  // spending = counts toward incurred spending.
  // card_payment = checking paying a card bill: cash out only, never spending.
  // transfer = moving money between own accounts / to savings: cash out only.
  kind: text("kind", { enum: ["spending", "card_payment", "transfer"] })
    .notNull()
    .default("spending"),
  // IM-5: the bank's own transaction id (OFX FITID) for rows
  // imported from an OFX/QFX file — stored encrypted like every
  // other text field, null for hand-entered and CSV-imported
  // rows. It exists so a later OFX import can recognise the exact
  // same transaction again in the preview (exact dedupe);
  // matching happens client-side in the preview, where plaintext
  // exists, exactly like the IM-1 fuzzy check. Carried in
  // backup/restore like every other transaction field.
  fitId: text("fit_id"),
  category: text("category").notNull().default("Other"),
  yearlyExpenseId: integer("yearly_expense_id").references(
    () => yearlyExpenses.id,
  ),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const monthlySummaries = sqliteTable("monthly_summaries", {
  // Month key YYYY-MM. One entered cash-out total per month. When a row
  // exists for a month, that total is the month's cash-out / spending base
  // instead of summing that month's transactions.
  month: text("month").primaryKey(),
  cashOutCents: text("cash_out_cents").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const monthlyBills = sqliteTable("monthly_bills", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  // Denormalized copy of the latest amount version, kept in sync by the
  // actions. The source of truth is monthly_bill_versions.
  amountCents: text("amount_cents").notNull(),
  paidBy: text("paid_by").notNull().default("Checking"),
  notes: text("notes"),
  // One category label per bill — not versioned, never changes totals.
  category: text("category").notNull().default("Uncategorized"),
  // "Keep the lights on" check: 1 when this bill is an essential,
  // must-pay bill. Independent of category; a label only — not
  // versioned, never changes any amount or total.
  keepLightsOn: integer("keep_lights_on").notNull().default(0),
  // Legacy per-bill collapsed flag from a previous UI — no longer read
  // or written by the app. The Monthly bills section now uses a single
  // section-level flag stored in settings ("monthly_bills_collapsed_all").
  // Column kept harmlessly; display only, never changes amounts/totals.
  collapsed: integer("collapsed").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const monthlyBillVersions = sqliteTable("monthly_bill_versions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  billId: integer("bill_id")
    .notNull()
    .references(() => monthlyBills.id),
  amountCents: text("amount_cents").notNull(),
  // First month (YYYY-MM) this amount applies to. A month's breakdown
  // uses the latest version with effectiveFrom <= that month, so editing
  // an amount from today forward never changes earlier months.
  effectiveFrom: text("effective_from").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const monthlyOneOffs = sqliteTable("monthly_one_offs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Month key YYYY-MM this one-off belongs to.
  month: text("month").notNull(),
  description: text("description").notNull(),
  // Amount in cents. This amount is ALREADY INCLUDED in that month's
  // spending / cash out — it is an explanation only and is never added
  // to any total a second time.
  amountCents: text("amount_cents").notNull(),
  note: text("note"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const monthlyCashOutItems = sqliteTable("monthly_cash_out_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Month key YYYY-MM this line item belongs to.
  month: text("month").notNull(),
  description: text("description").notNull(),
  // Amount in cents. Unlike monthly one-offs (explanation only), these
  // items ARE the month's cash out: when a month has one or more items,
  // their sum is that month's cash out everywhere it is used, taking
  // precedence over any entered lump total for the month (which stays
  // stored and is shown as a reference). Deleting all of a month's items
  // returns the month to its entered total / transactions as before.
  amountCents: text("amount_cents").notNull(),
  note: text("note"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/* ---------------- Net Worth ----------------
   Tidy records: one row per account, one row per snapshot date, and
   one balance row per (snapshot, account) that was recorded. A
   missing balance row means "not recorded" on that date — distinct
   from an explicit recorded 0. Snapshot totals are always computed
   from the balance rows, never stored. */

export const nwAccounts = sqliteTable("nw_accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  // LEGACY column from the short-lived account-level bucket tag model
  // (migration 0016). No longer read or written by the app: tax buckets
  // now live on each snapshot balance as an optional split (see
  // nwBalances split columns below). The column is kept so existing
  // rows are untouched; its values are ignored.
  bucket: text("bucket").notNull().default("Unbucketed"),
  // Property flag: "none" for ordinary financial accounts,
  // "asset" for a property asset (e.g. a house — its balance ADDS to
  // net worth when property is included), "liability" for a property
  // liability (e.g. its mortgage — its balance is entered as a
  // positive number and SUBTRACTS from net worth when property is
  // included). Property accounts are never part of a tax bucket;
  // whether they count at all is governed by the view-level
  // "nw_include_property" setting (default off).
  propertyKind: text("property_kind", {
    enum: ["none", "asset", "liability"],
  })
    .notNull()
    .default("none"),
  // Custodial flag: 1 = a custodial account (e.g. UTMA/UGMA) whose
  // money legally belongs to a minor and is custodian-managed. The
  // account is recorded like any other (balances on snapshots,
  // editable, archivable) but is NEVER counted in any total or
  // calculation — not net worth, not buckets, not Year Summary,
  // not the Retirement/Roth Net Worth-following figures. Custodial
  // accounts are never property accounts (propertyKind stays
  // "none") and never carry a tax-bucket split. Existing rows
  // default to 0 (ordinary), so no existing figure can move.
  custodial: integer("custodial").notNull().default(0),
  sortOrder: integer("sort_order").notNull().default(0),
  // 1 = archived: history is preserved and still shown in the history
  // grid, but the account leaves the entry form and current allocation.
  archived: integer("archived").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const nwSnapshots = sqliteTable("nw_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Snapshot date YYYY-MM-DD. Irregular — snapshots happen whenever
  // the user records one. Unique: one snapshot per date.
  date: text("date").notNull().unique(),
  note: text("note"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const nwBalances = sqliteTable("nw_balances", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  snapshotId: integer("snapshot_id")
    .notNull()
    .references(() => nwSnapshots.id),
  accountId: integer("account_id")
    .notNull()
    .references(() => nwAccounts.id),
  // Signed cents: balances may be negative (a debt account) and count
  // into the snapshot total as entered. When the balance is split
  // across tax buckets (the six split_* columns below), this total is
  // ALWAYS the sum of the split parts — the server recomputes it from
  // the parts on every write, so the two can never disagree.
  balanceCents: text("balance_cents").notNull(),
  // Optional per-bucket split of this snapshot balance, in encrypted
  // cents like every other amount. All six null = no split: the whole
  // balance counts as Unbucketed. When any split column is non-null,
  // the balance is split — a null column among them means $0 entered
  // for that bucket (not stored as a split part).
  splitHsaCents: text("split_hsa_cents"),
  splitRothCents: text("split_roth_cents"),
  splitTaxableCents: text("split_taxable_cents"),
  splitNonTaxableCents: text("split_non_taxable_cents"),
  split529Cents: text("split_529_cents"),
  splitCashCents: text("split_cash_cents"),
  // 7th split bucket (added for the Roth Conversion view): pre-tax
  // (Traditional IRA / 401(k)) money. Same rule as the other split
  // columns — null among a split means $0 entered for that bucket;
  // all seven null = no split (whole balance is Unbucketed).
  splitPreTaxCents: text("split_pre_tax_cents"),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
