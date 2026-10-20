/* ---------------- CSV export / import helpers ----------------
   Shared by the Spending Slice & dice export (App.tsx), the Net
   Worth explorer export (NetWorth.tsx), and the CSV import
   panel (App.tsx), so every CSV the app writes or reads follows
   ONE rule set (security-hardening batch, round-5 findings
   S2 and S4). */

/* S2 — spreadsheet formula neutralization, applied when a cell
   is SERIALIZED for export, never to stored data or in-app
   display. A text cell whose first character — after any
   leading whitespace or control characters — is one of = + - @
   is evaluated as a formula when a spreadsheet program opens
   the file: a category named "=1+1" would display as 2, and
   worse formulas can reach external data. Prefixing an
   apostrophe makes the spreadsheet render the cell as the
   literal text (the apostrophe is the spreadsheet's own text
   marker, so the displayed value is unchanged). A cell that is
   just a plain number is data, not a formula — money columns
   format negatives as -123.45 and change columns as -12.34% —
   and stays byte-identical. */
export function csvFormulaSafeText(v: string): string {
  const lead = v.replace(/^[\s\u0000-\u001f]+/, "");
  if (lead === "") return v;
  const c = lead.charAt(0);
  if (c !== "=" && c !== "+" && c !== "-" && c !== "@") return v;
  if (/^-?\d+(\.\d+)?%?$/.test(lead)) return v;
  return `'${v}`;
}

/* S4 — the CSV import budget. A household's bank export is
   kilobytes; these limits sit far above any legitimate file
   and exist so a pathological file is refused with a plain
   message instead of being read whole into the page and parsed
   without bound. The import panel states the same limits where
   the file is chosen. */
export const CSV_IMPORT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
export const CSV_IMPORT_MAX_ROWS = 25000;
export const CSV_IMPORT_MAX_FIELD_CHARS = 10000;

/* The file-size refusal, checked BEFORE the file is read. */
export function csvImportFileError(sizeBytes: number): string | null {
  if (sizeBytes <= CSV_IMPORT_MAX_BYTES) return null;
  return `That file is ${(sizeBytes / (1024 * 1024)).toFixed(1)} MB — imports are limited to 5 MB and 25,000 rows. Export a smaller date range from your bank and try again.`;
}

export type CsvParseOutcome = { rows: string[][] } | { error: string };

/* The import parser: the same grammar the importer has always
   used (quoted fields, "" escapes, CRLF tolerated, blank rows
   dropped), with the budget enforced around the parse — an
   oversized text, an unclosed quote (which would otherwise
   swallow the rest of the file into one field in silence), a
   single oversized field, or too many rows each refuse with a
   plain, fixable message instead of a hang or a silent
   mis-parse. */
export function parseCsvChecked(text: string): CsvParseOutcome {
  if (text.length > CSV_IMPORT_MAX_BYTES) {
    return {
      error:
        "That CSV is too large — imports are limited to 5 MB and 25,000 rows. Export a smaller date range and try again.",
    };
  }
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  const src = text.replace(/\r\n/g, "\n");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i] ?? "";
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
    } else cell += ch;
    if (cell.length > CSV_IMPORT_MAX_FIELD_CHARS) {
      return {
        error:
          "That CSV has a field longer than 10,000 characters — no bank export field is that long. Check the file and try again.",
      };
    }
  }
  if (inQuotes) {
    return {
      error:
        "That CSV looks damaged — a quoted field is never closed, so the rest of the file can't be read. Re-export it and try again.",
    };
  }
  row.push(cell);
  rows.push(row);
  const kept = rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (kept.length > CSV_IMPORT_MAX_ROWS) {
    return {
      error:
        "That CSV has more than 25,000 rows — imports are limited to 5 MB and 25,000 rows. Export a smaller date range and try again.",
    };
  }
  return { rows: kept };
}
