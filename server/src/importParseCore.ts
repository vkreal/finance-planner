/* ---------------- CSV import parsing core ----------------
   The pure decisions behind the Spending CSV import panel,
   shared by the client panel (client/src/App.tsx, through the
   client/src/importParseCore.ts re-export) and the accuracy
   fixtures (server/src/extendedFixtures.ts), so the fixture
   suite pins the exact functions the panel runs — the same
   core-extraction pattern as importCore / nwCore.

   Everything here is plain data in, plain data out: no storage,
   no encryption, no I/O. The panel owns the file reading and
   the preview UI; the write path (importTransactions +
   importCore's atomic batch plan) is unchanged. */

import {
  isDangerousDictKey,
  safeDict,
} from "./safeDictCore";

/* ---------------- dates ----------------
   Accepted shapes: YYYY-MM-DD, M/D/YYYY, M-D-YYYY, and — new in
   the IM-2 dialect fixes — M/D/YY and M-D-YY, read as 20YY.
   A trailing " as of ..." suffix is stripped before matching:
   some exports date a row "MM/DD/YYYY as of MM/DD/YYYY", where
   the first date is the transaction date and the suffix names
   the (earlier) valuation or posting reference date.
   Only real calendar dates pass: an impossible date (13/45/2026,
   2026-02-31, 2/29/26) returns null and the row counts as
   skipped in the preview, instead of being reformatted blindly
   and rejected by the server with no hint which row was bad.

   Two generic dialect additions (part 2 of the mapping upgrade):
   - When the whole cell matches nothing, the LEADING TOKEN —
     the part before the first space or comma — is tried on its
     own, so a timestamped cell like "10-03-26, 10:00:00" reads
     as its date part.
   - A bare M/D (or M-D) with no year resolves to the most
     recent such date on or before a reference date (an ISO
     "YYYY-MM-DD" string or a Date; default today). A bare date
     more than a year old therefore lands in the wrong year —
     the preview shows the resolved date, so the reader sees it
     before confirming rather than it being fixed silently. */
export function normalizeImportDate(
  raw: string,
  referenceDate?: string | Date,
): string | null {
  const s = raw.trim().replace(/\s+as of\s+.*$/i, "");
  const whole = parseImportDateText(s, referenceDate);
  if (whole != null) return whole;
  const token = s.split(/[\s,]/)[0] ?? "";
  if (token !== "" && token !== s) return parseImportDateText(token, referenceDate);
  return null;
}

function importDateIsReal(y: number, mo: number, d: number): boolean {
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(y, mo, 0).getDate();
}

function importReferenceParts(
  referenceDate?: string | Date,
): { y: number; mo: number; d: number } {
  if (typeof referenceDate === "string") {
    const m = referenceDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
      return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
    }
  } else if (referenceDate instanceof Date && Number.isFinite(referenceDate.getTime())) {
    return {
      y: referenceDate.getFullYear(),
      mo: referenceDate.getMonth() + 1,
      d: referenceDate.getDate(),
    };
  }
  const now = new Date();
  return { y: now.getFullYear(), mo: now.getMonth() + 1, d: now.getDate() };
}

/* One date candidate (the whole cell, or its leading token)
   against every accepted shape. See normalizeImportDate. */
function parseImportDateText(
  s: string,
  referenceDate?: string | Date,
): string | null {
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const [, yyyy = "", mm = "", dd = ""] = iso;
    return importDateIsReal(Number(yyyy), Number(mm), Number(dd)) ? s : null;
  }
  const full = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (full) {
    const [, mm = "", dd = "", yyyy = ""] = full;
    if (!importDateIsReal(Number(yyyy), Number(mm), Number(dd))) return null;
    return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }
  const short = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2})$/);
  if (short) {
    const [, mm = "", dd = "", yy = ""] = short;
    const yyyy = 2000 + Number(yy);
    if (!importDateIsReal(yyyy, Number(mm), Number(dd))) return null;
    return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }
  const bare = s.match(/^(\d{1,2})[/-](\d{1,2})$/);
  if (bare) {
    const mo = Number(bare[1] ?? "");
    const d = Number(bare[2] ?? "");
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const ref = importReferenceParts(referenceDate);
    // The most recent year (searching back from the reference
    // year) in which this month/day is a real date on or before
    // the reference date. Four years back always reaches a leap
    // year, so a bare 2/29 resolves too.
    for (let y = ref.y; y >= ref.y - 4; y--) {
      if (!importDateIsReal(y, mo, d)) continue;
      if (y === ref.y && (mo > ref.mo || (mo === ref.mo && d > ref.d))) {
        continue;
      }
      return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
    return null;
  }
  return null;
}

/* ---------------- amounts ----------------
   One amount cell: $, commas and whitespace are decoration;
   parentheses or a leading minus make it negative. Returns
   signed cents, or null when the cell holds no number. */
export function parseImportAmount(raw: string): number | null {
  let s = raw.trim().replace(/[$,\s]/g, "");
  let neg = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-")) {
    neg = true;
    s = s.slice(1);
  }
  const n = Number(s);
  if (!Number.isFinite(n) || s === "") return null;
  const cents = Math.round(n * 100);
  return neg ? -cents : cents;
}

/* The debit/credit dialect (IM-2): many bank exports carry
   separate Debit and Credit columns instead of one signed
   Amount. A row's amount comes from whichever cell is
   non-empty — debit counts as money out (+), credit as money
   in (−), each taken by magnitude so a column's own sign
   decoration can't flip its meaning. When BOTH cells are
   filled the row nets to debit − credit under that same
   convention, and bothFilled is set so the preview can surface
   how many rows were combined that way. Returns null when
   neither cell holds a usable number (the row is skipped) —
   including when a non-empty cell fails to parse, so a garbled
   pair never imports as a one-sided amount. The result is in
   the file's money-out-positive terms; the panel applies the
   chosen sign convention exactly as it does for a single
   amount column. */
export function combineDebitCreditAmount(
  debitRaw: string,
  creditRaw: string,
): { cents: number; bothFilled: boolean } | null {
  const dText = debitRaw.trim();
  const cText = creditRaw.trim();
  const d = dText === "" ? null : parseImportAmount(dText);
  const c = cText === "" ? null : parseImportAmount(cText);
  if (dText !== "" && d == null) return null;
  if (cText !== "" && c == null) return null;
  if (d == null && c == null) return null;
  return {
    cents: (d != null ? Math.abs(d) : 0) - (c != null ? Math.abs(c) : 0),
    bothFilled: d != null && c != null,
  };
}

/* ---------------- header + column mapping ----------------
   A mapping is one column index per role; −1 means the file
   has no such column. The panel renders these as plain selects
   so the user can always override the guess or a saved
   profile. */
export type ImportColumnMapping = {
  date: number;
  description: number;
  amount: number;
  debit: number;
  credit: number;
  category: number;
  kind: number;
  /* Part 2 of the mapping upgrade: the trade columns. A file
     with no amount/debit/credit column at all can still carry
     its money movement as quantity × price, signed by an
     action column (buy / sell) — see deriveTradeAmountCents.
     −1 wherever the file has no such column. */
  quantity: number;
  price: number;
  action: number;
};

const EMPTY_IMPORT_MAPPING: ImportColumnMapping = {
  date: -1,
  description: -1,
  amount: -1,
  debit: -1,
  credit: -1,
  category: -1,
  kind: -1,
  quantity: -1,
  price: -1,
  action: -1,
};

/* Does one row (cells already trimmed + lowercased) name the
   columns of an importable section? It must name a date column
   and — in a DIFFERENT cell — a money column (amount, proceeds,
   debit, or credit), or, for a trades-style section with no
   money column at all, both a quantity column and a price
   column. The different-cells rule matters: a data row whose
   single description cell happens to read e.g. "amount due
   date" names no columns and must not count as a header. */
function importHeaderCellsMatch(cells: string[]): boolean {
  const dateIdx = cells.findIndex((c) => c.includes("date"));
  if (dateIdx < 0) return false;
  const moneyIdx = cells.findIndex(
    (c, j) =>
      j !== dateIdx &&
      (c.includes("amount") ||
        c.includes("proceeds") ||
        c.includes("debit") ||
        c.includes("credit")),
  );
  if (moneyIdx >= 0) return true;
  const quantityIdx = cells.findIndex(
    (c, j) =>
      j !== dateIdx &&
      (c.includes("quantity") || c.includes("qty") || c.includes("shares")),
  );
  const priceIdx = cells.findIndex(
    (c, j) => j !== dateIdx && j !== quantityIdx && c.includes("price"),
  );
  return quantityIdx >= 0 && priceIdx >= 0;
}

/* A first row is a header when it names a date column and a
   money column (amount, debit, or credit). The debit/credit
   alternatives are new: a "Date, Description, Debit, Credit,
   Balance" export has no "amount" cell, and its header used to
   go unrecognized, sending every column to the positional
   fallback. Part 2 adds "proceeds" as a money name and the
   quantity + price trades shape, both via importHeaderCellsMatch. */
export function detectImportHeader(firstRow: string[]): boolean {
  return importHeaderCellsMatch(
    firstRow.map((c) => c.trim().toLowerCase()),
  );
}

/* Find a file's header row, which is not always the first row:
   some exports carry a title line or a short preamble block
   above the column headers. Scans the first maxScanRows rows
   for the first row that looks like a header — one cell
   containing "date" and a DIFFERENT cell containing "amount",
   "debit", or "credit" — and returns its index, or −1 when no
   scanned row qualifies. The different-cells rule matters: a
   data row whose single description cell happens to read e.g.
   "amount due date" names no columns and must not count as a
   header. The scan is capped at 8 rows because preamble/title
   rows live at the top of a file; scanning deeper would risk
   mistaking an ordinary data row for the header and silently
   dropping every row above it. */
export function findImportHeaderIndex(
  rows: string[][],
  maxScanRows = 8,
): number {
  const limit = Math.min(rows.length, Math.max(0, maxScanRows));
  for (let i = 0; i < limit; i++) {
    const cells = (rows[i] ?? []).map((c) => c.trim().toLowerCase());
    if (importHeaderCellsMatch(cells)) return i;
  }
  return -1;
}

/* Every header section in a file, in file order. Some exports
   are sectioned — several statements concatenated, each with
   its own header row and its own column layout — so a single
   header + mapping cannot read them: each section's body runs
   from just after its header to just before the next header,
   under that section's own guessed mapping. Unlike
   findImportHeaderIndex (a preamble scan, capped at the top of
   the file), this scans the whole file: a later section's
   header is a real header wherever it sits. A row counts only
   under the same different-cells rule as the preamble scan, so
   ordinary data rows are not mistaken for headers. */
export function findImportSections(
  rows: string[][],
): { headerIndex: number }[] {
  const out: { headerIndex: number }[] = [];
  rows.forEach((row, i) => {
    const cells = row.map((c) => c.trim().toLowerCase());
    if (importHeaderCellsMatch(cells)) out.push({ headerIndex: i });
  });
  return out;
}

/* The mapping for a file with NO header row at all: exports
   that are bare positional columns (date, amount, a placeholder
   column or two, description — in some order the file never
   names). Candidate (date, amount, description) triples over
   the first five columns are scored by how many of the first
   50 non-blank rows read cleanly under them — the date cell
   parses as a date (a bare M/D counts), the amount cell parses
   as an amount, and the description cell holds text (non-empty
   and containing a letter, so a "*" placeholder column never
   poses as the description). The historical default (0, 1, 2)
   is tried first and only a STRICTLY better score replaces it,
   so a tie keeps the old reading. The winner must read at
   least half the sampled rows (and at least one); otherwise
   the all-(−1) mapping comes back and the panel asks for the
   columns instead of guessing. */
export function guessPositionalMapping(
  rows: string[][],
): ImportColumnMapping {
  const sample = rows
    .filter((r) => r.some((c) => c.trim() !== ""))
    .slice(0, 50);
  if (sample.length === 0) return { ...EMPTY_IMPORT_MAPPING };
  const score = (d: number, a: number, s: number): number => {
    let n = 0;
    for (const r of sample) {
      if (normalizeImportDate(r[d] ?? "") == null) continue;
      if (parseImportAmount(r[a] ?? "") == null) continue;
      const desc = (r[s] ?? "").trim();
      if (desc === "" || !/[a-z]/i.test(desc)) continue;
      n++;
    }
    return n;
  };
  let best = { date: 0, amount: 1, description: 2 };
  let bestScore = score(0, 1, 2);
  for (let d = 0; d < 5; d++) {
    for (let a = 0; a < 5; a++) {
      for (let s = 0; s < 5; s++) {
        if (a === d || s === d || s === a) continue;
        if (d === 0 && a === 1 && s === 2) continue;
        const sc = score(d, a, s);
        if (sc > bestScore) {
          bestScore = sc;
          best = { date: d, amount: a, description: s };
        }
      }
    }
  }
  if (bestScore < 1 || bestScore * 2 < sample.length) {
    return { ...EMPTY_IMPORT_MAPPING };
  }
  return {
    ...EMPTY_IMPORT_MAPPING,
    date: best.date,
    amount: best.amount,
    description: best.description,
  };
}

/* The amount for a trades-style row: one that carries quantity,
   price, and an action code but no amount/debit/credit column
   at all. The money movement is quantity × price, signed by
   the action: a code containing "sell" is money in
   (+|quantity × price|), a code containing "buy" is money out
   (−|quantity × price|) — in the file's money-out-positive
   terms the panel's sign setting then normalizes, exactly as
   for an amount column. Any other action (a dividend marker, a
   transfer code, a blank) is not a trade and returns null, as
   does an unreadable quantity or price, so the row counts as
   skipped rather than importing at a made-up amount. */
export function deriveTradeAmountCents(
  cells: string[],
  mapping: ImportColumnMapping,
): number | null {
  if (mapping.amount >= 0 || mapping.debit >= 0 || mapping.credit >= 0) {
    return null;
  }
  if (mapping.quantity < 0 || mapping.price < 0 || mapping.action < 0) {
    return null;
  }
  const qtyText = (cells[mapping.quantity] ?? "").trim().replace(/[$,\s]/g, "");
  const qty = qtyText === "" ? NaN : Number(qtyText);
  if (!Number.isFinite(qty)) return null;
  const priceCents = parseImportAmount(cells[mapping.price] ?? "");
  if (priceCents == null) return null;
  const rawCents = Math.round(qty * (priceCents / 100) * 100);
  const action = (cells[mapping.action] ?? "").trim().toLowerCase();
  if (action.includes("sell")) return Math.abs(rawCents);
  if (action.includes("buy")) return -Math.abs(rawCents);
  return null;
}

/* The automatic mapping guess, from a header row (already
   lowercased by the caller, or null when the file has no
   recognizable header — then the historical positional
   fallback: columns 1/2/3 = date/description/amount). When the
   header names an amount column, the file is read as a
   single-amount file and any debit/credit columns stay
   unmapped; with no amount column, a debit and/or credit
   column maps as the pair. */
export function guessImportMapping(
  header: string[] | null,
): ImportColumnMapping {
  if (!header) {
    return {
      date: 0,
      description: 1,
      amount: 2,
      debit: -1,
      credit: -1,
      category: -1,
      kind: -1,
      quantity: -1,
      price: -1,
      action: -1,
    };
  }
  const col = (names: string[], fallback: number): number => {
    const idx = header.findIndex((h) => names.some((n) => h.includes(n)));
    return idx >= 0 ? idx : fallback;
  };
  /* Date: a column naming the TRANSACTION date ("transaction
     date" / "trans date") wins over any other date column — a
     card export carrying both a post date and a trans date
     records its rows on the trans date, the charge date.
     Otherwise the first date-named column, as before. */
  const dateTrans = header.findIndex(
    (h) => h.includes("transaction date") || h.includes("trans date"),
  );
  const date = dateTrans >= 0 ? dateTrans : col(["date"], 0);
  /* Amount preference, staged: a column that IS the amount
     column wins first — its text equals "amount" once a
     trailing parenthetical is stripped, so "Amount ($)" beats
     any merely-containing column. Next, a "net amount" column:
     a file carrying both a principal amount and a net amount
     moves money by the net figure. Next, a "proceeds" column:
     a trades section names its money movement that way, and it
     beats a merely-containing column. Last, the first column
     whose text merely contains "amount", as before. */
  const amountExact = header.findIndex(
    (h) => h.replace(/\s*\([^)]*\)\s*$/, "").trim() === "amount",
  );
  const amountNet = header.findIndex((h) => h.includes("net amount"));
  const amountProceeds = header.findIndex((h) => h.includes("proceeds"));
  const amountAny = header.findIndex((h) => h.includes("amount"));
  const amount =
    amountExact >= 0
      ? amountExact
      : amountNet >= 0
        ? amountNet
        : amountProceeds >= 0
          ? amountProceeds
          : amountAny;
  const hasPair = amount < 0;
  /* Description: the synonyms are tried IN ORDER — the first
     synonym that names any column wins — so a real description
     column beats a symbol/instrument column wherever each sits
     in the file. "memo" stays a late fallback: many exports
     carry a memo column ALONGSIDE the real description, and
     that description must keep winning; "symbol" and
     "instrument" come last of all, for trades-style files whose
     only text column names what was traded. */
  let description = -1;
  for (const name of [
    "description",
    "desc",
    "name",
    "payee",
    "memo",
    "symbol",
    "instrument",
  ]) {
    const idx = header.findIndex((h) => h.includes(name));
    if (idx >= 0) {
      description = idx;
      break;
    }
  }
  if (description < 0) description = 1;
  return {
    date,
    description,
    amount: hasPair ? -1 : amount,
    debit: hasPair ? col(["debit"], -1) : -1,
    credit: hasPair ? col(["credit"], -1) : -1,
    /* Category: the column NAMED "category" (a trailing
       parenthetical aside, the amount column's exact rule) —
       not a column whose name merely mentions it. A trades
       section's "Asset Category" classifies the asset, not the
       spending; mapping it would stamp every trade row with
       its asset class as though it were a spending category. */
    category: header.findIndex(
      (h) => h.replace(/\s*\([^)]*\)\s*$/, "").trim() === "category",
    ),
    kind: col(["kind", "type"], -1),
    /* The trade columns (part 2): quantity and price feed
       deriveTradeAmountCents when the file has no money column
       at all, and the action column signs it. "type" is NOT an
       action synonym — it stays the kind column, exactly as
       before. And "action" must stand as its own word: the
       "action" inside "transaction" names no action column (a
       "Transaction Date" or "Cash Transactions" cell is not
       one), so the match requires a word boundary before it. */
    quantity: col(["quantity", "qty", "shares"], -1),
    price: col(["price"], -1),
    action: header.findIndex(
      (h) =>
        h.includes("trans code") ||
        /(^|[^a-z])action/.test(h) ||
        h.includes("side"),
    ),
  };
  // A header that names none of amount/debit/credit leaves all
  // three unmapped; the panel then asks for a money column
  // instead of guessing positionally behind the user's back —
  // unless the trade columns are all present, in which case
  // deriveTradeAmountCents supplies the amount per row.
}

/* The profile key for a file: its header cells, normalized
   (trimmed, lowercased, runs of whitespace collapsed) so the
   same export layout matches its saved profile even if the
   file's capitalization or spacing shifts. JSON encoding keeps
   cell boundaries unambiguous. */
export function importHeaderFingerprint(headerCells: string[]): string {
  return JSON.stringify(
    headerCells.map((c) => c.trim().toLowerCase().replace(/\s+/g, " ")),
  );
}

/* ---------------- remembered settings + profiles ----------------
   IM-2: the per-import answers (template, account name, sign
   convention, keyword lists) and one column-mapping profile
   per header layout are persisted as ONE settings value (the
   app's existing settings storage; the value is stored
   encrypted at rest and travels in backup/restore like the
   other saved blobs — see actions.ts). These functions are the
   blob's only readers/writers, so the panel and the fixtures
   agree on its shape. Household-neutral throughout: a profile
   is keyed by a header layout the user actually imported,
   never by an institution name. */
export type ImportFileSettings = {
  template: "checking" | "card";
  accountName: string;
  outSign: "positive" | "negative";
  cardKeywords: string;
  transferKeywords: string;
};

export type ImportProfile = {
  fingerprint: string;
  header: string[];
  mapping: ImportColumnMapping;
  settings: ImportFileSettings;
};

/* IM-5: the remembered mapping for an OFX/QFX file's account.
   An OFX file names the account it belongs to (institution +
   account id); when the user has imported from that account
   before, the account name and template they used are refilled
   automatically. Keyed by the OFX account key (ofxCore's
   ofxAccountKey — the full account id lives ONLY in this key,
   in this encrypted settings value; screens show the masked
   display form). */
export type ImportOfxAccountMapping = {
  accountName: string;
  template: "checking" | "card";
};

export type ImportSettingsBlob = {
  lastSettings: ImportFileSettings | null;
  profiles: ImportProfile[];
  ofxAccounts: Record<string, ImportOfxAccountMapping>;
};

export const EMPTY_IMPORT_SETTINGS: ImportSettingsBlob = {
  lastSettings: null,
  profiles: [],
  ofxAccounts: {},
};

/* Storage caps: profiles are small setup records. The caps sit
   far above real use and keep a corrupt or hostile stored value
   from growing the blob without bound. */
export const IMPORT_PROFILE_LIMIT = 50;
export const IMPORT_OFX_ACCOUNT_LIMIT = 100;
const IMPORT_SETTING_TEXT_CAP = 500;
const IMPORT_HEADER_CELL_CAP = 200;
const IMPORT_OFX_KEY_CAP = 300;

function cleanImportSettings(v: unknown): ImportFileSettings | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o.template !== "checking" && o.template !== "card") return null;
  if (o.outSign !== "positive" && o.outSign !== "negative") return null;
  if (
    typeof o.accountName !== "string" ||
    typeof o.cardKeywords !== "string" ||
    typeof o.transferKeywords !== "string"
  ) {
    return null;
  }
  return {
    template: o.template,
    accountName: o.accountName.slice(0, IMPORT_SETTING_TEXT_CAP),
    outSign: o.outSign,
    cardKeywords: o.cardKeywords.slice(0, IMPORT_SETTING_TEXT_CAP),
    transferKeywords: o.transferKeywords.slice(0, IMPORT_SETTING_TEXT_CAP),
  };
}

function cleanImportMapping(v: unknown): ImportColumnMapping | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const roles = [
    "date",
    "description",
    "amount",
    "debit",
    "credit",
    "category",
    "kind",
  ] as const;
  const out = {} as Record<
    (typeof roles)[number] | "quantity" | "price" | "action",
    number
  >;
  for (const role of roles) {
    const n = o[role];
    if (typeof n !== "number" || !Number.isInteger(n) || n < -1 || n > 64) {
      return null;
    }
    out[role] = n;
  }
  /* The trade roles are newer than the stored profiles: a
     profile saved before they existed has no such keys, and it
     must still load — a missing trade role reads as −1 (no such
     column). A PRESENT but malformed value still rejects the
     mapping, exactly like the original seven. */
  for (const role of ["quantity", "price", "action"] as const) {
    const n = o[role];
    if (n === undefined) {
      out[role] = -1;
      continue;
    }
    if (typeof n !== "number" || !Number.isInteger(n) || n < -1 || n > 64) {
      return null;
    }
    out[role] = n;
  }
  return out as ImportColumnMapping;
}

function cleanImportProfile(v: unknown): ImportProfile | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.fingerprint !== "string" || o.fingerprint === "") return null;
  if (!Array.isArray(o.header)) return null;
  const header: string[] = [];
  for (const cell of o.header) {
    if (typeof cell !== "string") return null;
    header.push(cell.slice(0, IMPORT_HEADER_CELL_CAP));
  }
  const mapping = cleanImportMapping(o.mapping);
  const settings = cleanImportSettings(o.settings);
  if (!mapping || !settings) return null;
  return { fingerprint: o.fingerprint, header, mapping, settings };
}

/* Parse a stored settings value. Anything unreadable — not
   JSON, wrong shape — yields the empty blob rather than an
   error: a damaged setup record must never block an import,
   it just means the panel starts from its defaults. Entries
   that fail their own shape check are dropped individually. */
export function parseImportSettings(raw: string): ImportSettingsBlob {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_IMPORT_SETTINGS;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return EMPTY_IMPORT_SETTINGS;
  }
  const o = parsed as Record<string, unknown>;
  const lastSettings =
    o.lastSettings == null ? null : cleanImportSettings(o.lastSettings);
  const profiles: ImportProfile[] = [];
  if (Array.isArray(o.profiles)) {
    for (const p of o.profiles) {
      const clean = cleanImportProfile(p);
      if (clean) profiles.push(clean);
      if (profiles.length >= IMPORT_PROFILE_LIMIT) break;
    }
  }
  // Security round-2, finding 1 sweep: this dictionary is built
  // from restored JSON keys exactly like nwImportCore's label
  // mappings were, so it gets the same treatment — a
  // null-prototype dictionary (safeDictCore) and dangerous keys
  // ("__proto__" / "constructor" / "prototype") rejected at
  // parse time. On a plain {} a "__proto__" key would mutate the
  // object's prototype instead of becoming a visible entry.
  const ofxAccounts: Record<string, ImportOfxAccountMapping> = safeDict();
  if (
    typeof o.ofxAccounts === "object" &&
    o.ofxAccounts !== null &&
    !Array.isArray(o.ofxAccounts)
  ) {
    let kept = 0;
    for (const [k, v] of Object.entries(
      o.ofxAccounts as Record<string, unknown>,
    )) {
      const key = k.slice(0, IMPORT_OFX_KEY_CAP);
      if (isDangerousDictKey(key)) continue;
      const clean = cleanImportOfxAccountMapping(v);
      if (clean) {
        ofxAccounts[key] = clean;
        kept++;
      }
      if (kept >= IMPORT_OFX_ACCOUNT_LIMIT) break;
    }
  }
  return { lastSettings, profiles, ofxAccounts };
}

function cleanImportOfxAccountMapping(
  v: unknown,
): ImportOfxAccountMapping | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o.template !== "checking" && o.template !== "card") return null;
  if (typeof o.accountName !== "string" || o.accountName === "") return null;
  return {
    accountName: o.accountName.slice(0, IMPORT_SETTING_TEXT_CAP),
    template: o.template,
  };
}

export function serializeImportSettings(blob: ImportSettingsBlob): string {
  return JSON.stringify(blob);
}

/* The saved profile for a file's header row, if one exists. */
export function findImportProfile(
  blob: ImportSettingsBlob,
  headerCells: string[],
): ImportProfile | null {
  const fp = importHeaderFingerprint(headerCells);
  return blob.profiles.find((p) => p.fingerprint === fp) ?? null;
}

/* Record (or update) the profile for a header row and make its
   settings the last-used settings. Pure: returns the next
   blob; the caller persists it. The profile list is capped —
   past the cap the oldest profile is dropped. */
export function upsertImportProfile(
  blob: ImportSettingsBlob,
  headerCells: string[],
  mapping: ImportColumnMapping,
  settings: ImportFileSettings,
): ImportSettingsBlob {
  const fingerprint = importHeaderFingerprint(headerCells);
  const profile: ImportProfile = {
    fingerprint,
    header: headerCells.map((c) => c.slice(0, IMPORT_HEADER_CELL_CAP)),
    mapping: { ...mapping },
    settings: { ...settings },
  };
  const rest = blob.profiles.filter((p) => p.fingerprint !== fingerprint);
  const profiles = [...rest, profile].slice(-IMPORT_PROFILE_LIMIT);
  return {
    lastSettings: { ...settings },
    profiles,
    ofxAccounts: blob.ofxAccounts,
  };
}

/* Remember just the last-used settings (an import with no
   recognizable header has no profile to file them under). */
export function withLastImportSettings(
  blob: ImportSettingsBlob,
  settings: ImportFileSettings,
): ImportSettingsBlob {
  return {
    lastSettings: { ...settings },
    profiles: blob.profiles,
    ofxAccounts: blob.ofxAccounts,
  };
}

/* Record (or update) the remembered mapping for an OFX file's
   account — the account name and template the user previewed
   that file with. Pure: returns the next blob. Past the cap the
   oldest mappings are dropped. */
export function withImportOfxAccount(
  blob: ImportSettingsBlob,
  key: string,
  mapping: ImportOfxAccountMapping,
): ImportSettingsBlob {
  const entries = new Map<string, ImportOfxAccountMapping>(
    Object.entries(blob.ofxAccounts),
  );
  const cleanKey = key.slice(0, IMPORT_OFX_KEY_CAP);
  entries.delete(cleanKey);
  entries.set(cleanKey, { ...mapping });
  const kept = [...entries.entries()].slice(-IMPORT_OFX_ACCOUNT_LIMIT);
  // Rebuilt as a null-prototype dictionary with dangerous keys
  // dropped, exactly as the parser builds it (safeDictCore).
  const ofxAccounts: Record<string, ImportOfxAccountMapping> = safeDict();
  for (const [k, v] of kept) {
    if (isDangerousDictKey(k)) continue;
    ofxAccounts[k] = v;
  }
  return {
    lastSettings: blob.lastSettings,
    profiles: blob.profiles,
    ofxAccounts,
  };
}

/* ---------------- duplicate detection (IM-1) ----------------
   Matching happens in the preview, where plaintext exists: the
   server stores amounts and descriptions encrypted and cannot
   match content. Two rows are the same transaction when date,
   amount, description, kind, and account all agree (the panel
   compares against the transactions already recorded for the
   same account and months). Description and account compare
   case-insensitively, trimmed, so a re-export whose
   capitalization shifted still matches its first import. */
export type ImportDedupeRow = {
  date: string;
  amountCents: number;
  description: string;
  kind: string;
  accountName: string;
  /* IM-5: the bank's own transaction id, when the row came from
     an OFX/QFX file (null for CSV rows and OFX rows the file
     left unidentified). Not part of the fuzzy key — it drives
     the SEPARATE exact check below. */
  fitId?: string | null;
};

export function importDedupeKey(r: ImportDedupeRow): string {
  return [
    r.date,
    String(r.amountCents),
    r.description.trim().toLowerCase(),
    r.kind,
    r.accountName.trim().toLowerCase(),
  ].join("\u0000");
}

/* Flag each parsed row that looks already recorded: it matches
   a recorded transaction, or it repeats an earlier row of this
   same file (a file that lists a transaction twice imports it
   once). Returns one flag per row, in row order. */
export function flagImportDuplicates(
  rows: ImportDedupeRow[],
  existing: ImportDedupeRow[],
): boolean[] {
  const seen = new Set(existing.map(importDedupeKey));
  return rows.map((r) => {
    const k = importDedupeKey(r);
    const dup = seen.has(k);
    seen.add(k);
    return dup;
  });
}

/* ---------------- exact duplicate detection (IM-5) ----------------
   OFX/QFX rows carry the bank's own transaction id (FITID),
   which makes duplicate detection EXACT instead of heuristic:
   a row whose FITID was already recorded by an earlier OFX
   import IS that transaction again — no date/amount/description
   agreement is needed, and none can substitute. The recorded
   ids come from getImportData (transactions remember the FITID
   they were imported with). Ids compare exactly (trimmed): a
   FITID is an opaque bank identifier, so case folding or fuzzy
   matching would only invent collisions. A row with a NEW FITID
   is never flagged exact, however similar it looks — the fuzzy
   check above may still flag it as "looks already recorded",
   and the preview labels the two kinds distinctly. A FITID
   repeated inside the same file flags on its second appearance,
   like the fuzzy check's in-file rule. Rows without a FITID
   (every CSV row) are never exact duplicates.
   ACCOUNT SCOPING (round-7 fix 6.1): a FITID is unique only
   within its own account — each bank assigns ids inside one
   account's statement stream, and two accounts at the same
   bank (or two banks) can mint the same id for unrelated
   transactions. The seen-set is therefore keyed by account +
   FITID: the same FITID under a DIFFERENT account (on either
   side — recorded or in-file) never flags, while the same
   FITID twice within one account still flags on its second
   appearance. Account names compare trimmed and
   case-insensitively, exactly as the fuzzy key above treats
   them, so the recorded side and the file side agree on what
   "the same account" means; a missing account name is the
   empty account scope on both sides. */
export function flagExactFitIdDuplicates(
  rows: readonly { fitId?: string | null; accountName?: string | null }[],
  recorded: readonly { fitId?: string | null; accountName?: string | null }[],
): boolean[] {
  const keyOf = (fitId: string, accountName?: string | null): string =>
    `${(accountName ?? "").trim().toLowerCase()}\u0000${fitId}`;
  const seen = new Set<string>();
  for (const e of recorded) {
    const t = (e.fitId ?? "").trim();
    if (t !== "") seen.add(keyOf(t, e.accountName));
  }
  return rows.map((r) => {
    const f = (r.fitId ?? "").trim();
    if (f === "") return false;
    const k = keyOf(f, r.accountName);
    const dup = seen.has(k);
    seen.add(k);
    return dup;
  });
}

/* ---------------- cash-out proposal (IM-4) ----------------
   A checking export is also the record of what left the
   checking account, which is how a month is closed in this
   app: the month's cash out. The proposal groups the parsed
   rows by month and, for each month, totals the OUTFLOWS —
   every money-out row counts (spending rows and card-payment
   rows alike: paying the card is money leaving checking),
   EXCLUDING transfers (a move between the household's own
   accounts is not outflow). Money-in rows (amountCents <= 0
   after the panel's sign normalization, where money out is
   positive) are not outflows and never appear. The arithmetic
   is the export's own, shown as-is: rows the IM-1 check flagged
   as likely already recorded stay IN the proposal (marked, via
   isDuplicate) — the flag is information for the review, not a
   reason to silently change the export's total.

   Saving is NOT this module's job: the panel writes a confirmed
   proposal through the existing cash-out paths only (the
   month-total entry and the cash-out item writes), in the
   itemized form — the proposed items plus the proposed total
   kept as the month's entered-total reference, which is exactly
   the app's standing items-win precedence. */
export type CashOutProposalRow = {
  date: string;
  description: string;
  amountCents: number;
  kind: string;
};

export type CashOutProposalItem = {
  date: string;
  description: string;
  amountCents: number;
  kind: string;
  isDuplicate: boolean;
};

export type CashOutMonthProposal = {
  month: string;
  totalCents: number;
  items: CashOutProposalItem[];
};

/* One proposal per month present in the export that has at
   least one outflow row, months ascending, items in file
   order. dupFlags, when given, is index-aligned with rows (the
   IM-1 flagImportDuplicates output for the same rows). */
export function buildCashOutProposals(
  rows: CashOutProposalRow[],
  dupFlags?: boolean[] | null,
): CashOutMonthProposal[] {
  const byMonth = new Map<string, CashOutProposalItem[]>();
  rows.forEach((r, i) => {
    if (r.kind === "transfer" || r.amountCents <= 0) return;
    const month = r.date.slice(0, 7);
    const item: CashOutProposalItem = {
      date: r.date,
      description: r.description,
      amountCents: r.amountCents,
      kind: r.kind,
      isDuplicate: dupFlags?.[i] ?? false,
    };
    const list = byMonth.get(month);
    if (list) list.push(item);
    else byMonth.set(month, [item]);
  });
  return [...byMonth.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([month, items]) => ({
      month,
      totalCents: items.reduce((s, it) => s + it.amountCents, 0),
      items,
    }));
}

/* What is already recorded for a month, in the app's own
   cash-out terms: the entered month total (null when none) and
   the recorded items with their sum. */
export type RecordedCashOut = {
  enteredTotalCents: number | null;
  itemsTotalCents: number;
  itemsCount: number;
};

/* The proposal measured against what is recorded. The recorded
   figure a proposal is compared to is the month's RESOLVED cash
   out under the app's standing precedence — the items sum when
   the month has items, otherwise the entered total, otherwise
   nothing recorded (null, and the difference is null too: there
   is nothing to differ from). differenceCents is proposed −
   recorded, signed, so the panel can say "proposed is $X more /
   less than recorded" in plain terms. */
export type CashOutProposalComparison = {
  recordedResolvedCents: number | null;
  differenceCents: number | null;
};

export function compareCashOutProposal(
  proposal: CashOutMonthProposal,
  recorded: RecordedCashOut,
): CashOutProposalComparison {
  const recordedResolvedCents =
    recorded.itemsCount > 0
      ? recorded.itemsTotalCents
      : recorded.enteredTotalCents;
  return {
    recordedResolvedCents,
    differenceCents:
      recordedResolvedCents == null
        ? null
        : proposal.totalCents - recordedResolvedCents,
  };
}
