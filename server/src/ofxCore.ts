/* ---------------- OFX / QFX statement parsing core (IM-5) ----------------
   The pure parser behind OFX/QFX support in both import panels,
   shared by the client panels (client/src/App.tsx and
   client/src/NetWorth.tsx, through the client/src/ofxCore.ts
   re-export) and the accuracy fixtures
   (server/src/extendedFixtures.ts), so the fixture suite pins
   the exact functions the panels run — the same core-extraction
   pattern as importParseCore / nwImportCore.

   OFX comes in two generations: 1.x is SGML-style (leaf tags are
   never closed: "<TRNAMT>-84.20" runs straight into the next
   tag) and 2.x is XML (every tag closed, values may carry XML
   entities). One tolerant reader handles both: SGML leaves are
   normalized into closed elements first, then a forgiving stack
   parser builds the tree (a close tag pops to its match, an
   unmatched close is ignored, unclosed containers close at end
   of input). No institution-specific knowledge anywhere — the
   format is parsed generically: statement blocks (STMTRS for
   bank accounts, CCSTMTRS for cards), their account blocks, the
   STMTTRN transaction list, and the LEDGERBAL balance.

   Everything here is plain data in, plain data out: no storage,
   no encryption, no I/O. All parsing happens client-side (the
   panels read the file in the browser, exactly like the CSV
   importer), so the packaged browser-only build runs this same
   code. The standing import budget (finding S4) applies to the
   new format unchanged: an OFX file is text and counts the same
   way — 5 MB of text, 25,000 transactions, 10,000 characters in
   any one field. Dates are validated as real calendar dates by
   the shared import date rule, so an impossible DTPOSTED is
   refused (its row is skipped) rather than reformatted blindly. */

import { normalizeImportDate, parseImportAmount } from "./importParseCore";

/* The S4 import budget, same numbers as csvUtil's CSV budget —
   restated here because this core is shared with the server
   fixtures, which cannot import the client module. */
export const OFX_IMPORT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
export const OFX_IMPORT_MAX_ROWS = 25000;
export const OFX_IMPORT_MAX_FIELD_CHARS = 10000;
/* Security round-2, finding 2: the nesting-depth bound the tree
   builder enforces. Real OFX nesting is shallow (OFX → message
   set → response → statement → list → transaction → field ≈ 8);
   100 sits far above any real file and far below the call-stack
   limit the recursive walks used to hit on a ~35 KB file nested
   5,000 deep. A file nested deeper than this is refused with a
   controlled parse error, never an uncaught RangeError. */
export const OFX_MAX_DEPTH = 100;
/* The persisted FITID cap: the transactions table's imported-id
   field (and the importTransactions request) accept at most 200
   characters. A longer bank id is dropped (the row still
   imports; it just gets no exact-duplicate protection). */
const OFX_FITID_CAP = 200;

/* ---------------- shapes ---------------- */

export type OfxTransaction = {
  /* Posted date, YYYY-MM-DD, a real calendar date. */
  date: string;
  /* Signed cents exactly as the file states them: in OFX,
     TRNAMT is negative for money out, positive for money in.
     The panels convert to their money-out-positive terms. */
  amountCents: number;
  /* NAME when the file gives one, else MEMO, else a check
     number label, else the transaction type. Never empty. */
  description: string;
  name: string;
  memo: string;
  /* The raw TRNTYPE (DEBIT, CREDIT, CHECK, …), "" when absent. */
  trnType: string;
  /* The bank's own transaction id (FITID) — the exact-duplicate
     key. Null when the file gives none (or an unusable one). */
  fitId: string | null;
};

export type OfxAccount = {
  kind: "bank" | "card";
  /* Institution name from the file's FI block (its ORG), else
     the routing id (BANKID), else "". Display only. */
  institution: string;
  bankId: string;
  /* The account id exactly as the file states it (ACCTID). Used
     for the remembered-mapping key; DISPLAYS ARE MASKED (see
     ofxAccountDisplay) — the full id never reaches the screen. */
  accountId: string;
  /* ACCTTYPE (CHECKING / SAVINGS / …) for bank accounts, "" for
     cards. */
  accountType: string;
  /* The statement's official ledger balance (LEDGERBAL BALAMT)
     and its as-of date (DTASOF). Null when the file omits them. */
  ledgerBalanceCents: number | null;
  ledgerDate: string | null;
  transactions: OfxTransaction[];
};

export type OfxParseOutcome =
  | { ok: true; accounts: OfxAccount[]; skippedTxns: number }
  | { ok: false; error: string };

/* Does this text look like an OFX/QFX file (rather than a CSV)?
   The 1.x header block starts with "OFXHEADER:"; both
   generations carry an <OFX> root element early in the file.
   Only the head of the text is consulted — a CSV never matches. */
export function looksLikeOfx(text: string): boolean {
  const head = text.slice(0, 4096).toLowerCase();
  return head.includes("ofxheader") || head.includes("<ofx") || head.includes("<?ofx");
}

/* ---------------- dates ----------------
   DTPOSTED (and DTASOF) are YYYYMMDD, optionally followed by a
   time (HHMMSS, sometimes fractional) and a timezone suffix
   like "[−5:EST]" or "[0:UTC]". Only the calendar date is
   taken — the first eight digits — and it must be a REAL
   calendar date: the shared import date rule validates it, so
   20260231 is refused, never rolled into March. The timezone
   suffix never shifts the date: the posted date the bank states
   is the date the transaction belongs to. */
export function parseOfxDate(raw: string): string | null {
  const m = raw.trim().match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  return normalizeImportDate(`${m[1]}-${m[2]}-${m[3]}`);
}

/* ---------------- account identity ----------------
   The remembered-mapping key for a file account: its kind, its
   institution/routing id, and its full account id, normalized
   (institution case/space-insensitive, the account id itself
   compared exactly — it is an opaque bank identifier). The key
   is stored in the panels' remembered setup, never displayed. */
export function ofxAccountKey(a: {
  kind: string;
  institution: string;
  bankId: string;
  accountId: string;
}): string {
  const inst = (a.bankId || a.institution)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  return [a.kind, inst, a.accountId.trim()].join("|");
}

/* Mask an account id for display: only the last four characters
   ever show. An id of four or fewer characters shows nothing. */
export function maskOfxAccountId(accountId: string): string {
  const id = accountId.trim();
  if (id.length <= 4) return "····";
  return `····${id.slice(-4)}`;
}

/* The account's display label: the institution name (or a
   generic word when the file names none) plus the masked id. */
export function ofxAccountDisplay(a: {
  kind: string;
  institution: string;
  accountId: string;
}): string {
  const name =
    a.institution.trim() ||
    (a.kind === "card" ? "Card account" : "Bank account");
  if (a.accountId.trim() === "") return name;
  return `${name} ${maskOfxAccountId(a.accountId)}`;
}

/* ---------------- the tolerant tree reader ---------------- */

type OfxNode = { tag: string; text: string; children: OfxNode[] };

function decodeOfxEntities(s: string): string {
  return s.replace(
    /&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g,
    (whole, body: string) => {
      // Security round-2, finding 2: a numeric reference is
      // decoded only when it names a legal Unicode code point
      // (0 … U+10FFFF). Number.isFinite alone let &#x110000;
      // through to String.fromCodePoint, which throws a
      // RangeError; an out-of-range reference now stays literal,
      // exactly like the non-finite fallback always did.
      if (body.startsWith("#x") || body.startsWith("#X")) {
        const n = Number.parseInt(body.slice(2), 16);
        return Number.isInteger(n) && n >= 0 && n <= 0x10ffff
          ? String.fromCodePoint(n)
          : whole;
      }
      if (body.startsWith("#")) {
        const n = Number.parseInt(body.slice(1), 10);
        return Number.isInteger(n) && n >= 0 && n <= 0x10ffff
          ? String.fromCodePoint(n)
          : whole;
      }
      switch (body) {
        case "amp":
          return "&";
        case "lt":
          return "<";
        case "gt":
          return ">";
        case "quot":
          return '"';
        case "apos":
          return "'";
        default:
          return whole;
      }
    },
  );
}

/* Build the element tree. SGML leaves are normalized first: a
   tag directly followed by text with no "<" in it is a leaf,
   so it is closed where the text ends. Container tags are
   followed immediately by another tag (their "text" is just
   whitespace), so they are left alone. XML (2.x) leaves are
   already closed — normalizing one adds a second close tag,
   which the stack parser simply ignores (it pops to a match
   that is no longer on the stack). */
/* Returns the tree, or null when the input nests deeper than
   OFX_MAX_DEPTH — the caller turns that into a controlled parse
   error (security round-2, finding 2). The builder itself is
   iterative (an explicit stack), so the depth check is a simple
   stack-length test; the tree walks below are iterative too, so
   no input that passes the builder can overflow the call stack
   on the way through them. */
function parseOfxTree(text: string): OfxNode | null {
  const noPi = text
    .replace(/<\?[\s\S]*?\?>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const normalized = noPi.replace(
    /<([A-Za-z][A-Za-z0-9._-]*)>([^<]+)/g,
    (_m, tag: string, txt: string) =>
      txt.trim() === "" ? `<${tag}>${txt}` : `<${tag}>${txt}</${tag}>`,
  );
  const root: OfxNode = { tag: "", text: "", children: [] };
  const stack: OfxNode[] = [root];
  const re = /<(\/?)([A-Za-z][A-Za-z0-9._-]*)>|([^<]+)/g;
  for (const m of normalized.matchAll(re)) {
    const textPart = m[3];
    if (textPart !== undefined) {
      const top = stack[stack.length - 1];
      if (top) top.text += textPart;
      continue;
    }
    const name = (m[2] ?? "").toUpperCase();
    if (name === "") continue;
    if (m[1] === "/") {
      // Close: pop up to and including the matching open tag.
      // No match on the stack → the close is ignored.
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i]?.tag === name) {
          stack.length = i;
          break;
        }
      }
    } else {
      // stack.length is the new node's depth (the root sits at
      // depth 0 beneath it). Deeper than the bound → the file is
      // not a real bank export; refuse it whole.
      if (stack.length > OFX_MAX_DEPTH) return null;
      const node: OfxNode = { tag: name, text: "", children: [] };
      const top = stack[stack.length - 1];
      if (top) top.children.push(node);
      stack.push(node);
    }
  }
  return root;
}

function findAllOfx(node: OfxNode, tag: string, out: OfxNode[]): void {
  // Iterative pre-order walk (document order, the order the
  // recursive version produced) over an explicit stack, so the
  // walk itself can never overflow the call stack.
  const stack: OfxNode[] = [node];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) break;
    if (cur.tag === tag) out.push(cur);
    for (let i = cur.children.length - 1; i >= 0; i--) {
      const c = cur.children[i];
      if (c) stack.push(c);
    }
  }
}

function firstOfxChild(node: OfxNode, tag: string): OfxNode | null {
  return node.children.find((c) => c.tag === tag) ?? null;
}

/* A child element's value: its own text, entity-decoded and
   trimmed. "" when the element is absent. */
function ofxChildText(node: OfxNode, tag: string): string {
  const c = firstOfxChild(node, tag);
  if (!c) return "";
  return decodeOfxEntities(c.text).trim();
}

/* The largest single field in the tree (the S4 field budget).
   Iterative, like findAllOfx, so it cannot overflow the stack. */
function maxOfxFieldChars(node: OfxNode): number {
  let max = 0;
  const stack: OfxNode[] = [node];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) break;
    max = Math.max(max, cur.text.trim().length);
    for (const c of cur.children) stack.push(c);
  }
  return max;
}

/* ---------------- the statement parse ---------------- */

/* The public parse: the inner parse's known malformed-input
   paths all return controlled errors, and this wrapper is the
   last line of defence — any unexpected throw from a malformed
   file is converted into the same controlled shape, so nothing
   uncaught ever escapes into the import UI (security round-2,
   finding 2). */
export function parseOfx(text: string): OfxParseOutcome {
  try {
    return parseOfxInner(text);
  } catch {
    return {
      ok: false,
      error:
        "That file couldn't be read as an OFX or QFX statement — check the file and try again.",
    };
  }
}

function parseOfxInner(text: string): OfxParseOutcome {
  if (text.length > OFX_IMPORT_MAX_BYTES) {
    return {
      ok: false,
      error:
        "That file is too large — imports are limited to 5 MB and 25,000 rows. Export a smaller date range and try again.",
    };
  }
  if (!looksLikeOfx(text)) {
    return {
      ok: false,
      error: "That doesn't look like an OFX or QFX file.",
    };
  }
  const root = parseOfxTree(text);
  if (root == null) {
    return {
      ok: false,
      error:
        "That file's contents are nested too deeply to be a bank export — check the file and try again.",
    };
  }
  if (maxOfxFieldChars(root) > OFX_IMPORT_MAX_FIELD_CHARS) {
    return {
      ok: false,
      error:
        "That file has a field longer than 10,000 characters — no bank export field is that long. Check the file and try again.",
    };
  }
  // The institution name lives in the sign-on block's FI
  // element; it applies to every statement in the file.
  const fiNodes: OfxNode[] = [];
  findAllOfx(root, "FI", fiNodes);
  const fiOrg = fiNodes.length > 0 ? ofxChildText(fiNodes[0] as OfxNode, "ORG") : "";

  const stmtNodes: { node: OfxNode; kind: "bank" | "card" }[] = [];
  const bankStmts: OfxNode[] = [];
  findAllOfx(root, "STMTRS", bankStmts);
  for (const n of bankStmts) stmtNodes.push({ node: n, kind: "bank" });
  const cardStmts: OfxNode[] = [];
  findAllOfx(root, "CCSTMTRS", cardStmts);
  for (const n of cardStmts) stmtNodes.push({ node: n, kind: "card" });

  let txnTotal = 0;
  let skippedTxns = 0;
  const accounts: OfxAccount[] = [];
  for (const { node: stmt, kind } of stmtNodes) {
    const acctFrom =
      firstOfxChild(stmt, kind === "bank" ? "BANKACCTFROM" : "CCACCTFROM");
    const bankId = acctFrom ? ofxChildText(acctFrom, "BANKID") : "";
    const accountId = acctFrom ? ofxChildText(acctFrom, "ACCTID") : "";
    const accountType = acctFrom ? ofxChildText(acctFrom, "ACCTTYPE") : "";
    const institution = fiOrg || bankId;

    const ledger = firstOfxChild(stmt, "LEDGERBAL");
    const ledgerBalanceCents = ledger
      ? parseImportAmount(ofxChildText(ledger, "BALAMT"))
      : null;
    const ledgerDate = ledger
      ? parseOfxDate(ofxChildText(ledger, "DTASOF"))
      : null;

    const transactions: OfxTransaction[] = [];
    const trnNodes: OfxNode[] = [];
    findAllOfx(stmt, "STMTTRN", trnNodes);
    txnTotal += trnNodes.length;
    if (txnTotal > OFX_IMPORT_MAX_ROWS) {
      return {
        ok: false,
        error:
          "That file has more than 25,000 transactions — imports are limited to 5 MB and 25,000 rows. Export a smaller date range and try again.",
      };
    }
    for (const trn of trnNodes) {
      const date = parseOfxDate(ofxChildText(trn, "DTPOSTED"));
      const amountCents = parseImportAmount(ofxChildText(trn, "TRNAMT"));
      const trnType = ofxChildText(trn, "TRNTYPE");
      const name = ofxChildText(trn, "NAME");
      const memo = ofxChildText(trn, "MEMO");
      const checkNum = ofxChildText(trn, "CHECKNUM");
      const fitRaw = ofxChildText(trn, "FITID");
      const description =
        name ||
        memo ||
        (checkNum ? `Check ${checkNum}` : "") ||
        (trnType
          ? trnType.charAt(0).toUpperCase() +
            trnType.slice(1).toLowerCase()
          : "");
      // A row with no real date, no usable amount, or nothing to
      // call it is skipped — counted, never fatal — exactly like
      // an unreadable CSV row. A description over the stored
      // 200-character cap is skipped for the same reason.
      if (!date || amountCents == null || description === "" || description.length > 200) {
        skippedTxns++;
        continue;
      }
      transactions.push({
        date,
        amountCents,
        description,
        name,
        memo,
        trnType,
        fitId:
          fitRaw !== "" && fitRaw.length <= OFX_FITID_CAP ? fitRaw : null,
      });
    }
    accounts.push({
      kind,
      institution,
      bankId,
      accountId,
      accountType,
      ledgerBalanceCents,
      ledgerDate,
      transactions,
    });
  }
  return { ok: true, accounts, skippedTxns };
}
