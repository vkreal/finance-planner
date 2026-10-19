// Net Worth computation core — the single implementation of the
// property/balance/bucket math, shared by the Net Worth and Year
// Summary actions and by the extended accuracy fixtures
// (server/src/extendedFixtures.ts), so the fixture suite exercises
// the exact code the views run.

// Tax buckets a single snapshot balance can be split across. A balance
// with no split counts as "Unbucketed" whole — Unbucketed is a derived
// state, never a stored split part.
export const NW_SPLIT_BUCKETS = ["HSA", "Roth", "Taxable", "Non-Taxable", "529", "Cash", "Pre-tax"] as const;
export type NwSplitBucket = (typeof NW_SPLIT_BUCKETS)[number];
export const NW_ALL_BUCKETS = [...NW_SPLIT_BUCKETS, "Unbucketed"] as const;
export type NwBucket = (typeof NW_ALL_BUCKETS)[number];

// Property kinds for Net Worth accounts. "none" = ordinary financial
// account. "asset" = property asset (house): balance adds when
// property is included. "liability" = property liability (mortgage):
// balance is entered positive and subtracts when property is
// included. Whether property counts at all is the view-level
// "nw_include_property" setting, default off ("0"/absent).
export const NW_PROPERTY_KINDS = ["none", "asset", "liability"] as const;
export type NwPropertyKind = (typeof NW_PROPERTY_KINDS)[number];

// Snapshot dates are "YYYY-MM-DD" strings, so lexicographic
// comparison is chronological comparison. A snapshot dated after
// today must never become "latest" (max date) and feed the Net
// Worth headline, Retirement's starting portfolio, or Roth — the
// add/update actions refuse it with this guard. Today follows the
// app's existing convention: the server's local calendar date,
// built from getFullYear/getMonth/getDate exactly as the client's
// todayStr() and the Retirement defaults' current-month string do.
export function todayDateString(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
export function isFutureSnapshotDate(date: string, today: string): boolean {
  return date > today;
}

export function propertyKindOf(account: { propertyKind?: string | null }): NwPropertyKind {
  return account.propertyKind === "asset" || account.propertyKind === "liability"
    ? account.propertyKind
    : "none";
}
export function isPropertyKind(kind: NwPropertyKind): boolean {
  return kind !== "none";
}

// Custodial accounts (e.g. UTMA/UGMA): money that legally belongs
// to a minor and is custodian-managed. Recorded like any other
// account — balances on snapshots — but NEVER counted in any
// total or calculation. A custodial account is never a property
// account and never carries a tax-bucket split. The flag is stored
// as an integer (1 = custodial) on the account row; anything else
// (0, null, absent — every pre-existing row) is ordinary.
export function isCustodialAccount(account: {
  custodial?: boolean | number | null;
}): boolean {
  return account.custodial === true || account.custodial === 1;
}

// The full classification of one account: its property kind plus
// its custodial flag. Every total/bucket/mover computation below
// takes a map of these, so the property AND custodial separations
// live in exactly one place.
export type NwAccountClass = { kind: NwPropertyKind; custodial: boolean };
export function accountClassOf(account: {
  propertyKind?: string | null;
  custodial?: boolean | number | null;
}): NwAccountClass {
  return {
    kind: propertyKindOf(account),
    custodial: isCustodialAccount(account),
  };
}
export function classByIdOf(
  accounts: {
    id: number;
    propertyKind?: string | null;
    custodial?: boolean | number | null;
  }[],
): Map<number, NwAccountClass> {
  return new Map(
    accounts.map((a) => [a.id, accountClassOf(a)] as [number, NwAccountClass]),
  );
}
const ORDINARY_CLASS: NwAccountClass = { kind: "none", custodial: false };
// Signed contribution of a stored balance to net worth / totals.
// Non-property and property-asset balances count as entered;
// a property liability's positive entered balance subtracts.
export function effectiveBalanceCents(kind: NwPropertyKind, balanceCents: number): number {
  return kind === "liability" ? -balanceCents : balanceCents;
}

export type CoreNwBalance = {
  accountId: number;
  balanceCents: number;
  splitHsaCents: number | null;
  splitRothCents: number | null;
  splitTaxableCents: number | null;
  splitNonTaxableCents: number | null;
  split529Cents: number | null;
  splitCashCents: number | null;
  splitPreTaxCents: number | null;
};

// The split parts of a decrypted balance row, as stored parts only
// (buckets with no entered amount are absent). Empty = unsplit.
export function splitPartsOf<B extends CoreNwBalance>(
  b: B,
): { bucket: NwSplitBucket; amountCents: number }[] {
  const parts: { bucket: NwSplitBucket; amountCents: number }[] = [];
  if (b.splitHsaCents != null) parts.push({ bucket: "HSA", amountCents: b.splitHsaCents });
  if (b.splitRothCents != null) parts.push({ bucket: "Roth", amountCents: b.splitRothCents });
  if (b.splitTaxableCents != null) parts.push({ bucket: "Taxable", amountCents: b.splitTaxableCents });
  if (b.splitNonTaxableCents != null) parts.push({ bucket: "Non-Taxable", amountCents: b.splitNonTaxableCents });
  if (b.split529Cents != null) parts.push({ bucket: "529", amountCents: b.split529Cents });
  if (b.splitCashCents != null) parts.push({ bucket: "Cash", amountCents: b.splitCashCents });
  if (b.splitPreTaxCents != null) parts.push({ bucket: "Pre-tax", amountCents: b.splitPreTaxCents });
  return parts;
}

// The one balance a row contributes to any total: when the
// row carries a split, the split is authoritative — the
// balance IS the sum of its parts, the same rule
// bucketSubtotals below applies and every writer maintains
// (nwBalanceRowValues recomputes balanceCents from the
// parts; the restore preflight normalises the same way).
// An unsplit row contributes its stored balanceCents.
// (E4 remainder: snapshotTotals previously summed the stored
// balanceCents unconditionally, so a row whose stored
// balance disagreed with its split — creatable only by a
// pre-cluster-A restore — totalled differently here than in
// the bucket subtotals: one row, two totals.)
export function effectiveRowBalanceCents(b: CoreNwBalance): number {
  const parts = splitPartsOf(b);
  return parts.length > 0
    ? parts.reduce((acc, p) => acc + p.amountCents, 0)
    : b.balanceCents;
}

// One snapshot's grand total and property net, respecting the
// property toggle: property accounts contribute nothing when it is
// off; when on, property assets add and property liabilities
// subtract. Non-property balances count as entered. The property
// net is reported whether or not the toggle is on (null when no
// property account has a balance recorded). Custodial balances are
// added NOWHERE — not to the total in either toggle state — and
// are reported separately as custodialTotalCents (null when no
// custodial account has a balance recorded), for display only.
// Every contribution is the row's effective balance
// (effectiveRowBalanceCents): a split row counts at the sum of
// its parts, so the grand total always equals the sum of the
// bucket subtotals plus any unsplit balances.
export function snapshotTotals(
  balances: CoreNwBalance[],
  classById: Map<number, NwAccountClass>,
  includeProperty: boolean,
): {
  totalCents: number;
  propertyNetCents: number | null;
  custodialTotalCents: number | null;
} {
  let totalCents = 0;
  let propertyNet = 0;
  let hasProperty = false;
  let custodialTotal = 0;
  let hasCustodial = false;
  for (const b of balances) {
    const cls = classById.get(b.accountId) ?? ORDINARY_CLASS;
    const rowBalance = effectiveRowBalanceCents(b);
    if (cls.custodial) {
      hasCustodial = true;
      custodialTotal += rowBalance;
      continue;
    }
    if (isPropertyKind(cls.kind)) {
      hasProperty = true;
      propertyNet += effectiveBalanceCents(cls.kind, rowBalance);
      if (includeProperty) {
        totalCents += effectiveBalanceCents(cls.kind, rowBalance);
      }
    } else {
      totalCents += rowBalance;
    }
  }
  return {
    totalCents,
    propertyNetCents: hasProperty ? propertyNet : null,
    custodialTotalCents: hasCustodial ? custodialTotal : null,
  };
}

// Bucket subtotals for one snapshot, on the same rule the Net Worth
// view's bucket rows use: a split balance contributes each part to
// its bucket; a balance with no split contributes its whole amount
// to Unbucketed. Property accounts are always skipped — they are
// outside the buckets in both toggle states — and custodial
// accounts are always skipped too: a custodial balance appears in
// no bucket and never as Unbucketed. A bucket with no contribution
// at all reports null (not recorded), matching the view's
// per-bucket presence rule.
export function bucketSubtotals(
  balances: CoreNwBalance[],
  classById: Map<number, NwAccountClass>,
): Record<NwBucket, number | null> {
  const out = {} as Record<NwBucket, number | null>;
  for (const bucket of NW_ALL_BUCKETS) {
    let sum = 0;
    let has = false;
    for (const b of balances) {
      const cls = classById.get(b.accountId) ?? ORDINARY_CLASS;
      if (cls.custodial) continue;
      if (isPropertyKind(cls.kind)) continue;
      const parts = splitPartsOf(b);
      if (parts.length > 0) {
        if (bucket === "Unbucketed") continue;
        const part = parts.find((p) => p.bucket === bucket);
        if (part) {
          sum += part.amountCents;
          has = true;
        }
      } else if (bucket === "Unbucketed") {
        sum += b.balanceCents;
        has = true;
      }
    }
    out[bucket] = has ? sum : null;
  }
  return out;
}

/* ---------------- Snapshot write safety (cluster C) ----------------
   The single implementation of the Net Worth snapshot write
   contract, shared by the addNwSnapshot / updateNwSnapshot /
   updateNwBalance actions (server/src/actions.ts) and the extended
   accuracy fixtures, so the fixture suite exercises the exact
   validation, row resolution, and write-plan construction the
   handlers run.

   Write safety contract:
     1. FULL preflight before any write. Every balance entry's
        accountId must reference an existing account, no accountId
        may appear twice in one payload (even when one entry would
        be skipped as unrecorded), and no bucket may appear twice
        within one entry's splits. Any failure refuses the write
        with zero writes. (Before this, a duplicate bucket was
        silently folded by the row writer — last amount wins — so
        splits [{Cash 30000},{Cash 20000}] stored $200 and the
        first $300 vanished.)
     2. The write itself is ONE atomic batch: header insert/update,
        the balance delete (update only), and one insert per stored
        balance row land together or not at all. The plan builder
        below produces that statement list; the executor models the
        batch's atomic semantics over a plain state so fixtures can
        stage a mid-plan failure and prove the prior state survives
        untouched. */

export type NwBalanceEntryLike = {
  accountId: number;
  balanceCents: number | null;
  splits?: { bucket: NwSplitBucket; amountCents: number }[] | null;
};

export type NwValidationResult =
  | { ok: true; reason: string }
  | { ok: false; reason: string };

// The first bucket that appears more than once in one entry's
// splits, or null when every bucket appears at most once.
export function findDuplicateSplitBucket(
  splits: { bucket: NwSplitBucket; amountCents: number }[] | null | undefined,
): NwSplitBucket | null {
  if (!splits) return null;
  const seen = new Set<NwSplitBucket>();
  for (const p of splits) {
    if (seen.has(p.bucket)) return p.bucket;
    seen.add(p.bucket);
  }
  return null;
}

export function validateNwBalanceSplits(
  splits: { bucket: NwSplitBucket; amountCents: number }[] | null | undefined,
  accountName?: string,
): NwValidationResult {
  const dup = findDuplicateSplitBucket(splits);
  if (dup != null) {
    return {
      ok: false,
      reason: `The ${dup} split appears more than once${accountName ? ` for account “${accountName}”` : ""} — combine the amounts into one ${dup} entry.`,
    };
  }
  return { ok: true, reason: "Splits valid." };
}

// Full-payload preflight for add/update snapshot writes. `accounts`
// is the account set the handler already loads (id + display name).
// Checks run in a fixed order — unknown accounts, then duplicated
// accountIds, then duplicated split buckets — and the first failure
// is the refusal reason.
export function validateNwSnapshotPayload(
  balances: NwBalanceEntryLike[],
  accounts: { id: number; name: string }[],
): NwValidationResult {
  const byId = new Map(accounts.map((a) => [a.id, a] as [number, { id: number; name: string }]));
  for (const b of balances) {
    if (!byId.has(b.accountId)) {
      return { ok: false, reason: "That account was not found." };
    }
  }
  const seenAccounts = new Set<number>();
  for (const b of balances) {
    if (seenAccounts.has(b.accountId)) {
      const acct = byId.get(b.accountId);
      return {
        ok: false,
        reason: `Account “${acct ? acct.name : b.accountId}” appears more than once in this snapshot — each account can be recorded only once per snapshot.`,
      };
    }
    seenAccounts.add(b.accountId);
  }
  for (const b of balances) {
    const acct = byId.get(b.accountId);
    const check = validateNwBalanceSplits(b.splits, acct?.name);
    if (!check.ok) return check;
  }
  return { ok: true, reason: "Payload valid." };
}

// Resolve one balance entry into the plain row values to store, or
// null when the account was not recorded. This is the numeric core
// of nwBalanceRowValues in actions.ts (which encrypts these values
// field by field): split entries store the sum of the parts as the
// balance and each part in its bucket column; balanceCents is
// ignored whenever splits are non-empty. Property and custodial
// balances never carry a split — noSplit forces the whole-balance
// path. Callers MUST run the preflight above first: duplicate
// buckets are refused there, never folded here.
export function nwBalanceRowPlain(
  entry: NwBalanceEntryLike,
  noSplit: boolean = false,
): CoreNwBalance | null {
  const splits = noSplit ? null : (entry.splits ?? null);
  if (splits && splits.length > 0) {
    const byBucket = new Map<NwSplitBucket, number>();
    for (const p of splits) byBucket.set(p.bucket, p.amountCents);
    const total = [...byBucket.values()].reduce((s, v) => s + v, 0);
    const part = (bucket: NwSplitBucket): number | null =>
      byBucket.get(bucket) ?? null;
    return {
      accountId: entry.accountId,
      balanceCents: total,
      splitHsaCents: part("HSA"),
      splitRothCents: part("Roth"),
      splitTaxableCents: part("Taxable"),
      splitNonTaxableCents: part("Non-Taxable"),
      split529Cents: part("529"),
      splitCashCents: part("Cash"),
      splitPreTaxCents: part("Pre-tax"),
    };
  }
  if (entry.balanceCents == null) return null;
  return {
    accountId: entry.accountId,
    balanceCents: entry.balanceCents,
    splitHsaCents: null,
    splitRothCents: null,
    splitTaxableCents: null,
    splitNonTaxableCents: null,
    split529Cents: null,
    splitCashCents: null,
    splitPreTaxCents: null,
  };
}

// Resolve a whole validated payload into the stored rows, in
// payload order: each entry's plain row via nwBalanceRowPlain with
// the property/custodial whole-balance rule; entries that resolve
// to null (unrecorded) produce no row.
export function resolveNwSnapshotRows(
  balances: NwBalanceEntryLike[],
  classById: Map<number, NwAccountClass>,
): CoreNwBalance[] {
  const rows: CoreNwBalance[] = [];
  for (const b of balances) {
    const cls = classById.get(b.accountId) ?? ORDINARY_CLASS;
    const row = nwBalanceRowPlain(
      b,
      isPropertyKind(cls.kind) || cls.custodial,
    );
    if (row) rows.push(row);
  }
  return rows;
}

/* ------------------- Write plan + atomic execution -------------------
   A snapshot write as an ordered statement list: for an update,
   the header update, then the delete of the snapshot's balances,
   then one insert per stored balance row; for an add, the header
   insert (carrying the pre-derived snapshot id) then the balance
   inserts. The handler executes this plan as ONE db.batch(...)
   call; the executor below models that batch's atomic semantics
   over a plain state object so the fixtures can stage real plan
   failures (including an injected mid-plan failure) and prove the
   prior state survives untouched — the batch either commits every
   statement or none. The plan is generic over the stored row type:
   the handler builds it with encrypted row values, the fixtures
   with plain CoreNwBalance rows. */

export type NwWriteStatement<Row> =
  | { op: "insertSnapshot"; snapshotId: number; date: string; note: string | null }
  | { op: "updateSnapshot"; snapshotId: number; date: string; note: string | null }
  | { op: "deleteBalances"; snapshotId: number }
  | { op: "insertBalance"; snapshotId: number; row: Row & { accountId: number } };

export function buildNwSnapshotWritePlan<Row extends { accountId: number }>(input: {
  mode: "add" | "update";
  snapshotId: number;
  date: string;
  note: string | null;
  rows: Row[];
}): NwWriteStatement<Row>[] {
  const plan: NwWriteStatement<Row>[] = [];
  if (input.mode === "add") {
    plan.push({
      op: "insertSnapshot",
      snapshotId: input.snapshotId,
      date: input.date,
      note: input.note,
    });
  } else {
    plan.push({
      op: "updateSnapshot",
      snapshotId: input.snapshotId,
      date: input.date,
      note: input.note,
    });
    plan.push({ op: "deleteBalances", snapshotId: input.snapshotId });
  }
  for (const row of input.rows) {
    plan.push({ op: "insertBalance", snapshotId: input.snapshotId, row });
  }
  return plan;
}

export type NwWriteSnapshotRow = { id: number; date: string; note: string | null };
export type NwWriteBalanceRow = CoreNwBalance & { snapshotId: number };
export type NwWriteState = {
  snapshots: NwWriteSnapshotRow[];
  balances: NwWriteBalanceRow[];
};

export function emptyNwWriteState(): NwWriteState {
  return { snapshots: [], balances: [] };
}

export function cloneNwWriteState(state: NwWriteState): NwWriteState {
  return JSON.parse(JSON.stringify(state)) as NwWriteState;
}

// A stable fingerprint of a write state: the same rows in the same
// order fingerprint identically, so a fixture can prove
// byte-identical preservation by string equality.
export function nwWriteStateFingerprint(state: NwWriteState): string {
  return JSON.stringify({ snapshots: state.snapshots, balances: state.balances });
}

export function executeNwWritePlanAtomically(
  prior: NwWriteState,
  plan: NwWriteStatement<CoreNwBalance>[],
  failAtStatement: number | null = null,
): { committed: boolean; state: NwWriteState; failedAt: number | null } {
  const work = cloneNwWriteState(prior);
  for (let i = 0; i < plan.length; i++) {
    const stmt = plan[i];
    if (!stmt) continue;
    if (failAtStatement != null && i === failAtStatement) {
      return { committed: false, state: prior, failedAt: i };
    }
    if (stmt.op === "insertSnapshot") {
      // nwSnapshots.id is the primary key and its date is UNIQUE:
      // either collision fails the statement (and the batch).
      if (
        work.snapshots.some((s) => s.id === stmt.snapshotId) ||
        work.snapshots.some((s) => s.date === stmt.date)
      ) {
        return { committed: false, state: prior, failedAt: i };
      }
      work.snapshots.push({ id: stmt.snapshotId, date: stmt.date, note: stmt.note });
      continue;
    }
    if (stmt.op === "updateSnapshot") {
      const target = work.snapshots.find((s) => s.id === stmt.snapshotId);
      if (!target) return { committed: false, state: prior, failedAt: i };
      if (
        work.snapshots.some((s) => s.id !== stmt.snapshotId && s.date === stmt.date)
      ) {
        return { committed: false, state: prior, failedAt: i };
      }
      target.date = stmt.date;
      target.note = stmt.note;
      continue;
    }
    if (stmt.op === "deleteBalances") {
      work.balances = work.balances.filter((b) => b.snapshotId !== stmt.snapshotId);
      continue;
    }
    // insertBalance: the snapshot must exist in the working state
    // and (snapshot, account) may be stored only once — a duplicate
    // pair would double-count the account in the snapshot total.
    if (!work.snapshots.some((s) => s.id === stmt.snapshotId)) {
      return { committed: false, state: prior, failedAt: i };
    }
    if (
      work.balances.some(
        (b) => b.snapshotId === stmt.snapshotId && b.accountId === stmt.row.accountId,
      )
    ) {
      return { committed: false, state: prior, failedAt: i };
    }
    work.balances.push({ ...stmt.row, snapshotId: stmt.snapshotId });
  }
  return { committed: true, state: work, failedAt: null };
}

// The handlers' full write flow over the plain state: preflight,
// row resolution, plan, atomic execution. Any failure leaves
// `prior` untouched and reports the same reason the handler
// returns. The handlers themselves differ only in transport (they
// encrypt the plan's rows and execute them as one db.batch, with
// the add path's snapshot id pre-derived as max(existing id) + 1).
export function attemptNwSnapshotWrite(
  prior: NwWriteState,
  input: {
    mode: "add" | "update";
    snapshotId: number;
    date: string;
    note: string | null;
    balances: NwBalanceEntryLike[];
    accounts: { id: number; name: string }[];
    classById: Map<number, NwAccountClass>;
  },
  failAtStatement: number | null = null,
): { ok: boolean; reason: string; state: NwWriteState; committed: boolean } {
  const pre = validateNwSnapshotPayload(input.balances, input.accounts);
  if (!pre.ok) return { ok: false, reason: pre.reason, state: prior, committed: false };
  const rows = resolveNwSnapshotRows(input.balances, input.classById);
  const plan = buildNwSnapshotWritePlan({
    mode: input.mode,
    snapshotId: input.snapshotId,
    date: input.date,
    note: input.note,
    rows,
  });
  const exec = executeNwWritePlanAtomically(prior, plan, failAtStatement);
  if (!exec.committed) {
    return {
      ok: false,
      reason: "Snapshot write failed partway through and was rolled back — the previous snapshot is intact. Nothing was changed.",
      state: prior,
      committed: false,
    };
  }
  return {
    ok: true,
    reason: input.mode === "add" ? "Snapshot added." : "Snapshot saved.",
    state: exec.state,
    committed: true,
  };
}

export type YearMover = {
  accountId: number;
  accountName: string;
  startCents: number | null;
  endCents: number | null;
  changeCents: number;
};

// The Year Summary's per-account movers between a year's first and
// last snapshots: every account with a balance in either snapshot,
// its signed first → last change (property accounts follow the
// toggle, exactly as the totals do), sorted by change descending.
// Custodial accounts never appear as movers. No movers when the
// year has a single snapshot.
export function yearMovers(
  accounts: { id: number; name: string }[],
  firstBalances: CoreNwBalance[],
  lastBalances: CoreNwBalance[],
  classById: Map<number, NwAccountClass>,
  includeProperty: boolean,
  sameSnapshot: boolean,
): YearMover[] {
  if (sameSnapshot) return [];
  const movers: YearMover[] = [];
  for (const a of accounts) {
    const cls = classById.get(a.id) ?? ORDINARY_CLASS;
    if (cls.custodial) continue;
    const kind = cls.kind;
    if (isPropertyKind(kind) && !includeProperty) continue;
    const fb = firstBalances.find((b) => b.accountId === a.id);
    const lb = lastBalances.find((b) => b.accountId === a.id);
    if (!fb && !lb) continue;
    const startCents = fb ? effectiveBalanceCents(kind, fb.balanceCents) : null;
    const endCents = lb ? effectiveBalanceCents(kind, lb.balanceCents) : null;
    movers.push({
      accountId: a.id,
      accountName: a.name,
      startCents,
      endCents,
      changeCents: (endCents ?? 0) - (startCents ?? 0),
    });
  }
  movers.sort((x, y) => y.changeCents - x.changeCents);
  return movers;
}
