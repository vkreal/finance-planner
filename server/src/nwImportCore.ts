/* ---------------- Net Worth balance import core (IM-3) ----------------
   The pure decisions behind the Net Worth balance-import panel,
   shared by the client panel (client/src/NetWorth.tsx, through
   the client/src/nwImportCore.ts re-export) and the accuracy
   fixtures (server/src/extendedFixtures.ts), so the fixture
   suite pins the exact functions the panel runs — the same
   core-extraction pattern as importParseCore / nwCore.

   Everything here is plain data in, plain data out: no storage,
   no encryption, no I/O. All parsing happens client-side (the
   panel reads the file in the browser, exactly like the
   Spending importer), so the packaged browser-only build runs
   this same code. The write path is unchanged: the panel feeds
   its confirmed draft to the existing addNwSnapshot action.

   Household-neutral throughout: no institution-specific parsing
   — generic columns (account label / balance / optional date)
   plus remembered, user-confirmed mappings only. */

import { hasReservedEncPrefix } from "./encPrefixCore";
import {
importHeaderFingerprint,
normalizeImportDate,
parseImportAmount,
} from "./importParseCore";
import {
ofxAccountDisplay,
ofxAccountKey,
type OfxAccount,
} from "./ofxCore";
import { NW_SPLIT_BUCKETS, type NwSplitBucket } from "./nwCore";

export { importHeaderFingerprint };
export type { NwSplitBucket };

/* ---------------- column mapping ----------------
   One column index per role; −1 means the file has no such
   column. The panel renders these as plain selects so the user
   can always override the guess or a saved profile. */
export type NwBalanceMapping = {
  label: number;
  balance: number;
  date: number;
};

/* A first row is a header when it names an account-label column
   and a money column (balance / amount / value). */
export function detectNwBalanceHeader(firstRow: string[]): boolean {
  const cells = firstRow.map((c) => c.trim().toLowerCase());
  return (
    cells.some(
      (c) =>
        c.includes("account") ||
        c.includes("label") ||
        c.includes("name"),
    ) &&
    cells.some(
      (c) =>
        c.includes("balance") || c.includes("amount") || c.includes("value"),
    )
  );
}

/* The automatic mapping guess, from a header row (any case; null
   when the file has no recognizable header — then the
   positional fallback: column 1 = label, column 2 = balance, no
   date column). The balance role prefers a column actually
   named "balance" over "amount" over "value"; the label and
   balance roles never land on the same column. */
export function guessNwBalanceMapping(
  header: string[] | null,
): NwBalanceMapping {
  if (!header) return { label: 0, balance: 1, date: -1 };
  const cells = header.map((c) => c.trim().toLowerCase());
  const col = (names: string[], fallback: number): number => {
    for (const n of names) {
      const idx = cells.findIndex((h) => h.includes(n));
      if (idx >= 0) return idx;
    }
    return fallback;
  };
  const label = col(["account", "label", "name", "description"], 0);
  let balance = col(["balance", "amount", "value"], -1);
  if (balance === label) balance = -1;
  const date = col(["date", "as of", "statement"], -1);
  return { label, balance, date: date === label || date === balance ? -1 : date };
}

/* ---------------- row parsing ---------------- */
export type NwBalanceFileRow = {
  label: string;
  balanceCents: number;
  date: string | null;
  /* IM-5: an optional stable identity used for the remembered-
     mapping lookup INSTEAD of the label. OFX rows carry one:
     their label is a masked display string (institution +
     ····last4), which is neither unique enough nor stable
     enough to key a mapping on, while the OFX account key
     (ofxCore's ofxAccountKey, built from the full account id)
     is both. CSV rows have no matchKey and match by label, as
     before. */
  matchKey?: string;
};

/* Turn the file's body rows (header already removed) into
   balance rows. A row is skipped — counted, never fatal — when
   its label is blank or over the 200-character cap, when its
   label carries the reserved enc:v1: prefix (the standing
   import guard: imported text may never smuggle the encryption
   prefix into stored data), or when its balance cell holds no
   number. A mapped date cell that is blank or unreadable leaves
   the row dateless rather than dropping the balance. */
export function parseNwBalanceRows(
  body: string[][],
  mapping: NwBalanceMapping,
): { rows: NwBalanceFileRow[]; skipped: number } {
  const rows: NwBalanceFileRow[] = [];
  let skipped = 0;
  for (const r of body) {
    const label = (mapping.label >= 0 ? (r[mapping.label] ?? "") : "").trim();
    const balanceCents =
      mapping.balance >= 0
        ? parseImportAmount(r[mapping.balance] ?? "")
        : null;
    if (
      label === "" ||
      label.length > 200 ||
      hasReservedEncPrefix(label) ||
      balanceCents == null
    ) {
      skipped++;
      continue;
    }
    const dateRaw =
      mapping.date >= 0 ? (r[mapping.date] ?? "").trim() : "";
    rows.push({
      label,
      balanceCents,
      date: dateRaw === "" ? null : normalizeImportDate(dateRaw),
    });
  }
  return { rows, skipped };
}

/* The file's statement date: the date most of its rows carry
   (ties go to the latest such date). Null when no row is dated —
   the panel then drafts the snapshot for today. */
export function nwImportStatementDate(
  rows: readonly { date: string | null }[],
): string | null {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (r.date) counts.set(r.date, (counts.get(r.date) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [d, c] of counts) {
    if (c > bestCount || (c === bestCount && best != null && d > best)) {
      best = d;
      bestCount = c;
    }
  }
  return best;
}

/* ---------------- OFX/QFX balance rows (IM-5) ----------------
   An OFX statement carries each account's official ledger
   balance with an as-of date — exactly a balance row. One row
   per account that states a ledger balance: the balance is the
   LEDGERBAL amount, the row's date is its as-of date (so the
   shared statement-date rule makes it the draft's date), the
   label is the masked display form, and the matchKey is the
   account's full identity key, so a confirmed assignment is
   remembered for the next file from that account. An account
   whose statement omits the ledger balance contributes no row
   and is counted in skippedAccounts so the panel can say so —
   its transactions are a Spending import, not a balance. */
export function balanceRowsFromOfx(
  accounts: readonly OfxAccount[],
): { rows: NwBalanceFileRow[]; skippedAccounts: number } {
  const rows: NwBalanceFileRow[] = [];
  let skippedAccounts = 0;
  for (const a of accounts) {
    if (a.ledgerBalanceCents == null) {
      skippedAccounts++;
      continue;
    }
    const label = ofxAccountDisplay(a);
    // The standing reserved-prefix guard applies to the label
    // like any imported text: an institution name carrying the
    // enc:v1: prefix falls back to the generic masked label
    // rather than smuggling the prefix into a remembered
    // mapping or a draft.
    rows.push({
      label: hasReservedEncPrefix(label)
        ? ofxAccountDisplay({
            kind: a.kind,
            institution: "",
            accountId: a.accountId,
          })
        : label,
      balanceCents: a.ledgerBalanceCents,
      date: a.ledgerDate,
      matchKey: ofxAccountKey(a),
    });
  }
  return { rows, skippedAccounts };
}

/* ---------------- account matching ----------------
   A row's target: one app account, either as a whole balance or
   as an exact amount for one tax bucket of that account (the
   sub-account mapping — a file row that names a Roth sub-account
   feeds the Roth bucket directly). */
export type NwImportRowTarget = {
  accountId: number;
  bucket: NwSplitBucket | null;
};

export type NwMatchedBalanceRow = NwBalanceFileRow & {
  target: NwImportRowTarget | null;
  matchedBy: "remembered" | "name" | null;
};

/* The remembered-mapping key for a file label: trimmed,
   whitespace-collapsed, lowercased — the same normalization the
   name match uses, so "Brokerage  Roth " and "brokerage roth"
   are one label. */
export function normalizeNwLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

/* Match each parsed row to an app account: a remembered
   sub-account mapping from an earlier import wins; otherwise an
   exact (normalized) account-name match; otherwise the row is
   unmatched and the panel asks the user to assign or skip it. A
   remembered mapping whose account no longer exists falls
   through to the name match instead of pointing nowhere. */
export function matchNwImportRows(
  rows: readonly NwBalanceFileRow[],
  accounts: readonly { id: number; name: string }[],
  labelMappings: Readonly<Record<string, NwImportRowTarget>>,
): NwMatchedBalanceRow[] {
  const ids = new Set(accounts.map((a) => a.id));
  const byName = new Map<string, number>();
  for (const a of accounts) {
    const key = normalizeNwLabel(a.name);
    if (!byName.has(key)) byName.set(key, a.id);
  }
  return rows.map((r) => {
    const remembered =
      labelMappings[normalizeNwLabel(r.matchKey ?? r.label)];
    if (remembered && ids.has(remembered.accountId)) {
      return { ...r, target: { ...remembered }, matchedBy: "remembered" as const };
    }
    const named = byName.get(normalizeNwLabel(r.label));
    if (named != null) {
      return {
        ...r,
        target: { accountId: named, bucket: null },
        matchedBy: "name" as const,
      };
    }
    return { ...r, target: null, matchedBy: null };
  });
}

/* ---------------- split carry-over ----------------
   Proportional carry-over: the account's most recent split
   shares applied to a new balance. Each part rounds to the
   nearest cent; the rounding remainder (a cent or two either
   way) lands on the largest part, so the parts always sum
   EXACTLY to the new balance — the same invariant the snapshot
   write enforces (a split defines its balance as the sum of its
   parts). Null when there is no usable prior split (no parts,
   or parts summing to zero). */
export function proportionalNwSplit(
  balanceCents: number,
  lastParts: readonly { bucket: NwSplitBucket; amountCents: number }[],
): { bucket: NwSplitBucket; amountCents: number }[] | null {
  if (lastParts.length === 0) return null;
  const lastTotal = lastParts.reduce((s, p) => s + p.amountCents, 0);
  if (lastTotal === 0) return null;
  const parts = lastParts.map((p) => ({
    bucket: p.bucket,
    amountCents: Math.round((balanceCents * p.amountCents) / lastTotal),
  }));
  const diff = balanceCents - parts.reduce((s, p) => s + p.amountCents, 0);
  if (diff !== 0) {
    let idx = -1;
    let bestAbs = -1;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p) continue;
      if (Math.abs(p.amountCents) > bestAbs) {
        bestAbs = Math.abs(p.amountCents);
        idx = i;
      }
    }
    const target = idx >= 0 ? parts[idx] : undefined;
    if (target) target.amountCents += diff;
  }
  return parts;
}

function mergeSplitParts(
  base: readonly { bucket: NwSplitBucket; amountCents: number }[],
  extra: readonly { bucket: NwSplitBucket; amountCents: number }[],
): { bucket: NwSplitBucket; amountCents: number }[] {
  const sums = new Map<NwSplitBucket, number>();
  for (const p of [...base, ...extra]) {
    sums.set(p.bucket, (sums.get(p.bucket) ?? 0) + p.amountCents);
  }
  const out: { bucket: NwSplitBucket; amountCents: number }[] = [];
  for (const bucket of NW_SPLIT_BUCKETS) {
    const v = sums.get(bucket);
    if (v != null) out.push({ bucket, amountCents: v });
  }
  return out;
}

/* ---------------- the draft snapshot ---------------- */
export type NwDraftSplitSource =
  | "exact" // bucket amounts came from the file's own bucket-mapped rows
  | "proportional" // last split's shares applied to the new balance
  | "mixed" // bucket rows from the file + whole rows spread by the last split
  | "carried" // the account was not in the file; its last split rides along
  | "none";

export type NwDraftEntry = {
  accountId: number;
  // file: the file named this account. carried: not in the file —
  // its last recorded balance rides along, labelled as carried in
  // the draft and removable there, so a partial file can never
  // silently shrink or zero an account. blank: neither — nothing
  // to propose.
  source: "file" | "carried" | "blank";
  balanceCents: number | null;
  splits: { bucket: NwSplitBucket; amountCents: number }[] | null;
  splitSource: NwDraftSplitSource;
  fileRowCount: number;
};

export type NwImportLastBalances = Readonly<
  Record<
    number,
    {
      balanceCents: number;
      splits: readonly { bucket: NwSplitBucket; amountCents: number }[];
    }
  >
>;

/* Build the draft snapshot: one entry per app account, in the
   accounts' own order. Multiple file rows matched to the same
   account SUM into that account's new balance. Splits: exact
   bucket amounts from bucket-mapped rows win over proportional
   carry-over; whole-account rows with no bucket rows get the
   proportional proposal; an account with bucket rows AND whole
   rows spreads the whole-row sum by the last split (or onto the
   largest bucket part when there is no last split). Accounts in
   noSplitIds (property and custodial accounts, which never
   carry splits) fold any bucket-mapped rows into the whole
   balance. */
export function buildNwImportDraft(args: {
  accounts: readonly { id: number; name: string }[];
  rows: readonly NwMatchedBalanceRow[];
  lastBalances: NwImportLastBalances;
  noSplitIds?: ReadonlySet<number>;
}): NwDraftEntry[] {
  const entries: NwDraftEntry[] = [];
  for (const a of args.accounts) {
    const last = args.lastBalances[a.id];
    const mine = args.rows.filter(
      (r) => r.target != null && r.target.accountId === a.id,
    );
    if (mine.length === 0) {
      if (last) {
        entries.push({
          accountId: a.id,
          source: "carried",
          balanceCents: last.balanceCents,
          splits:
            last.splits.length > 0
              ? last.splits.map((p) => ({ ...p }))
              : null,
          splitSource: last.splits.length > 0 ? "carried" : "none",
          fileRowCount: 0,
        });
      } else {
        entries.push({
          accountId: a.id,
          source: "blank",
          balanceCents: null,
          splits: null,
          splitSource: "none",
          fileRowCount: 0,
        });
      }
      continue;
    }
    const noSplit = args.noSplitIds?.has(a.id) ?? false;
    const balanceCents = mine.reduce((s, r) => s + r.balanceCents, 0);
    const bucketSums = new Map<NwSplitBucket, number>();
    let wholeSum = 0;
    let hasWhole = false;
    for (const r of mine) {
      if (!noSplit && r.target?.bucket) {
        bucketSums.set(
          r.target.bucket,
          (bucketSums.get(r.target.bucket) ?? 0) + r.balanceCents,
        );
      } else {
        wholeSum += r.balanceCents;
        hasWhole = true;
      }
    }
    let splits: NwDraftEntry["splits"] = null;
    let splitSource: NwDraftSplitSource = "none";
    if (bucketSums.size > 0) {
      let parts = mergeSplitParts(
        [...bucketSums.entries()].map(([bucket, amountCents]) => ({
          bucket,
          amountCents,
        })),
        [],
      );
      if (hasWhole && wholeSum !== 0) {
        const spread = last?.splits.length
          ? proportionalNwSplit(wholeSum, last.splits)
          : null;
        if (spread) {
          parts = mergeSplitParts(parts, spread);
        } else if (parts.length > 0) {
          // No prior split to spread by: the whole-row sum lands
          // on the largest bucket part, keeping the parts summing
          // exactly to the balance.
          let idx = 0;
          let bestAbs = -1;
          for (let i = 0; i < parts.length; i++) {
            const p = parts[i];
            if (p && Math.abs(p.amountCents) > bestAbs) {
              bestAbs = Math.abs(p.amountCents);
              idx = i;
            }
          }
          const target = parts[idx];
          if (target) target.amountCents += wholeSum;
        }
        splitSource = "mixed";
      } else {
        splitSource = "exact";
      }
      splits = parts;
    } else if (hasWhole && last && last.splits.length > 0) {
      splits = proportionalNwSplit(balanceCents, last.splits);
      splitSource = splits ? "proportional" : "none";
    }
    entries.push({
      accountId: a.id,
      source: "file",
      balanceCents,
      splits,
      splitSource,
      fileRowCount: mine.length,
    });
  }
  return entries;
}

/* The draft minus the accounts the user removed in the review —
   the save payload is built from exactly what this returns. */
export function filterNwDraftEntries<T extends { accountId: number }>(
  entries: readonly T[],
  removedIds: ReadonlySet<number>,
): T[] {
  return entries.filter((e) => !removedIds.has(e.accountId));
}

/* ---------------- remembered setup ----------------
   The balance import's remembered setup persists as ONE
   settings value (the app's existing settings storage; stored
   encrypted at rest, carried in backup/restore like the other
   saved blobs — see actions.ts): one column-mapping profile
   per header layout (keyed by the shared header fingerprint),
   plus the label → account/bucket mappings the user confirmed.
   These functions are the blob's only readers/writers, so the
   panel and the fixtures agree on its shape. */
export type NwImportProfile = {
  fingerprint: string;
  header: string[];
  mapping: NwBalanceMapping;
};

export type NwImportSettingsBlob = {
  profiles: NwImportProfile[];
  labelMappings: Record<string, NwImportRowTarget>;
};

export const EMPTY_NW_IMPORT_SETTINGS: NwImportSettingsBlob = {
  profiles: [],
  labelMappings: {},
};

/* Storage caps: setup records are small. The caps sit far above
   real use and keep a corrupt or hostile stored value from
   growing the blob without bound. */
export const NW_IMPORT_PROFILE_LIMIT = 50;
export const NW_IMPORT_LABEL_MAPPING_LIMIT = 500;
const NW_IMPORT_LABEL_CAP = 200;
const NW_IMPORT_HEADER_CELL_CAP = 200;

function cleanNwBalanceMapping(v: unknown): NwBalanceMapping | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const out = {} as Record<keyof NwBalanceMapping, number>;
  for (const role of ["label", "balance", "date"] as const) {
    const n = o[role];
    if (typeof n !== "number" || !Number.isInteger(n) || n < -1 || n > 64) {
      return null;
    }
    out[role] = n;
  }
  return out;
}

function cleanNwImportTarget(v: unknown): NwImportRowTarget | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (
    typeof o.accountId !== "number" ||
    !Number.isInteger(o.accountId) ||
    o.accountId <= 0
  ) {
    return null;
  }
  if (
    o.bucket !== null &&
    !(NW_SPLIT_BUCKETS as readonly string[]).includes(o.bucket as string)
  ) {
    return null;
  }
  return {
    accountId: o.accountId,
    bucket: o.bucket as NwSplitBucket | null,
  };
}

function cleanNwImportProfile(v: unknown): NwImportProfile | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.fingerprint !== "string" || o.fingerprint === "") return null;
  if (!Array.isArray(o.header)) return null;
  const header: string[] = [];
  for (const cell of o.header) {
    if (typeof cell !== "string") return null;
    header.push(cell.slice(0, NW_IMPORT_HEADER_CELL_CAP));
  }
  const mapping = cleanNwBalanceMapping(o.mapping);
  if (!mapping) return null;
  return { fingerprint: o.fingerprint, header, mapping };
}

/* Parse a stored settings value. Anything unreadable yields the
   empty blob rather than an error: a damaged setup record must
   never block an import. Entries that fail their own shape
   check are dropped individually. */
export function parseNwImportSettings(raw: string): NwImportSettingsBlob {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_NW_IMPORT_SETTINGS;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return EMPTY_NW_IMPORT_SETTINGS;
  }
  const o = parsed as Record<string, unknown>;
  const profiles: NwImportProfile[] = [];
  if (Array.isArray(o.profiles)) {
    for (const p of o.profiles) {
      const clean = cleanNwImportProfile(p);
      if (clean) profiles.push(clean);
      if (profiles.length >= NW_IMPORT_PROFILE_LIMIT) break;
    }
  }
  const labelMappings: Record<string, NwImportRowTarget> = {};
  if (
    typeof o.labelMappings === "object" &&
    o.labelMappings !== null &&
    !Array.isArray(o.labelMappings)
  ) {
    for (const [k, v] of Object.entries(
      o.labelMappings as Record<string, unknown>,
    )) {
      const target = cleanNwImportTarget(v);
      if (target) labelMappings[k.slice(0, NW_IMPORT_LABEL_CAP)] = target;
      if (Object.keys(labelMappings).length >= NW_IMPORT_LABEL_MAPPING_LIMIT) {
        break;
      }
    }
  }
  return { profiles, labelMappings };
}

export function serializeNwImportSettings(
  blob: NwImportSettingsBlob,
): string {
  return JSON.stringify(blob);
}

/* The saved profile for a file's header row, if one exists. */
export function findNwImportProfile(
  blob: NwImportSettingsBlob,
  headerCells: string[],
): NwImportProfile | null {
  const fp = importHeaderFingerprint(headerCells);
  return blob.profiles.find((p) => p.fingerprint === fp) ?? null;
}

/* Record (or update) the profile for a header row. Pure:
   returns the next blob; the caller persists it. Past the cap
   the oldest profile is dropped. */
export function upsertNwImportProfile(
  blob: NwImportSettingsBlob,
  headerCells: string[],
  mapping: NwBalanceMapping,
): NwImportSettingsBlob {
  const fingerprint = importHeaderFingerprint(headerCells);
  const profile: NwImportProfile = {
    fingerprint,
    header: headerCells.map((c) => c.slice(0, NW_IMPORT_HEADER_CELL_CAP)),
    mapping: { ...mapping },
  };
  const rest = blob.profiles.filter((p) => p.fingerprint !== fingerprint);
  return {
    profiles: [...rest, profile].slice(-NW_IMPORT_PROFILE_LIMIT),
    labelMappings: blob.labelMappings,
  };
}

/* Merge confirmed label mappings into the blob (newer answers
   win). Past the cap the oldest mappings are dropped. */
export function withNwLabelMappings(
  blob: NwImportSettingsBlob,
  additions: Readonly<Record<string, NwImportRowTarget>>,
): NwImportSettingsBlob {
  const entries = new Map<string, NwImportRowTarget>(
    Object.entries(blob.labelMappings),
  );
  for (const [k, v] of Object.entries(additions)) {
    const key = k.slice(0, NW_IMPORT_LABEL_CAP);
    entries.delete(key);
    entries.set(key, { ...v });
  }
  const kept = [...entries.entries()].slice(-NW_IMPORT_LABEL_MAPPING_LIMIT);
  return { profiles: blob.profiles, labelMappings: Object.fromEntries(kept) };
}
