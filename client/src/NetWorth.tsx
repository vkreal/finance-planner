import {
useEffect,
useId,
useMemo,
useRef,
useState,
type FormEvent,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
Area,
CartesianGrid,
ComposedChart,
Legend,
Line,
ReferenceLine,
ResponsiveContainer,
Tooltip,
XAxis,
YAxis,
} from "recharts";
import { api, type ApiResponse } from "./api";
import {
csvFormulaSafeText,
csvImportFileError,
parseCsvChecked,
} from "./csvUtil";
import {
EMPTY_NW_IMPORT_SETTINGS,
balanceRowsFromOfx,
buildNwImportDraft,
detectNwBalanceHeader,
filterNwDraftEntries,
findNwImportProfile,
guessNwBalanceMapping,
importHeaderFingerprint,
matchNwImportRows,
normalizeNwLabel,
nwImportStatementDate,
parseNwBalanceRows,
parseNwImportSettings,
serializeNwImportSettings,
upsertNwImportProfile,
withNwLabelMappings,
type NwBalanceMapping,
type NwDraftEntry,
type NwImportRowTarget,
type NwImportSettingsBlob,
} from "./nwImportCore";
import { looksLikeOfx, parseOfx } from "./ofxCore";
import { Explainer } from "./Explainer";
import { usePersistedFold } from "./foldState";
import { TrendBlock } from "./YearBlocks";

type NwData = ApiResponse<typeof api, "getNetWorth">;
type NwAccount = NwData["accounts"][number];
type NwSnapshot = NwData["snapshots"][number];

const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// Bright, widely-spaced hues so every stacked series (chart areas
// and the matching sparklines) reads as its own color at a glance.
const SERIES_COLORS = [
  "#2563eb", "#f59e0b", "#10b981", "#ef4444",
  "#8b5cf6", "#06b6d4", "#f97316", "#ec4899",
  "#84cc16", "#14b8a6",
];
const TOTAL_COLOR = "#0d9488";
const POS_COLOR = "#2e7d4f";
const NEG_COLOR = "#b3352b";

// Buckets a single snapshot balance can be split across, plus the
// derived "Unbucketed" bucket a balance with no split counts into.
const NW_SPLIT_BUCKETS = ["HSA", "Roth", "Taxable", "Non-Taxable", "529", "Cash", "Pre-tax"] as const;
type NwSplitBucket = (typeof NW_SPLIT_BUCKETS)[number];
const NW_BUCKETS = [...NW_SPLIT_BUCKETS, "Unbucketed"] as const;
type NwBucket = (typeof NW_BUCKETS)[number];
const BUCKET_COLORS: Record<NwBucket, string> = {
  HSA: "#14b8a6",
  Roth: "#f59e0b",
  Taxable: "#3b82f6",
  "Non-Taxable": "#a855f7",
  "529": "#ec4899",
  Cash: "#65a30d",
  "Pre-tax": "#e11d48",
  Unbucketed: "#94a3b8",
};
// Display label for a bucket key: the internal key "529" is shown
// as "College / 529" everywhere a bucket name reaches the user;
// every other bucket displays as its key.
const BUCKET_LABELS: Record<string, string> = {
  "529": "College / 529",
};
function bucketLabel(bucket: string): string {
  return BUCKET_LABELS[bucket] ?? bucket;
}
function bucketKey(bucket: string): string {
  return `bucket_${bucket.replace(/[^a-zA-Z0-9]/g, "_")}`;
}
// Plain-language meaning of each split bucket, shown in the split
// editors behind the info button next to the bucket's label (see
// BucketHelp). Wording is deliberately plain; keep it that way.
const BUCKET_DEFINITIONS: Record<NwSplitBucket, string> = {
  HSA: "Tax-free in, tax-free out for medical.",
  Roth: "Already taxed; comes out tax-free.",
  Taxable:
    "Regular investment/brokerage money. No tax break; you pay tax on dividends, interest, and gains as they happen.",
  "Non-Taxable":
    "Money that has already been taxed and won't be taxed again when used, that isn't in the Roth, HSA, or College / 529 buckets (e.g. after-tax basis).",
  "529": "Tax-free growth when used for education.",
  Cash: "Bank cash, not invested.",
  "Pre-tax":
    "Traditional IRA/401(k)-type money. Went in untaxed and grows untaxed; you pay income tax when you take it out. This is the bucket Roth conversions draw from.",
};

/* Info button + tooltip explaining one split bucket, placed beside
   the bucket's label in the split editors — never inside the label
   and never over the amount field, so revealing it can never focus
   or change an amount. Follows the app's existing tooltip pattern
   (the Quick view tiles / at-risk pills): hovering or focusing the
   button shows the tooltip, tapping or clicking pins it open,
   tapping outside or pressing Escape closes a pinned tooltip.
   `align` keeps the bubble inside the editor: fields in the left
   grid column open theirs to the right, and vice versa. */
function BucketHelp({
  bucket,
  align,
}: {
  bucket: NwSplitBucket;
  align: "left" | "right";
}) {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const rawId = useId();
  const tipId = `nw-bucket-tip-${bucketKey(bucket)}-${rawId.replace(/[^a-zA-Z0-9]/g, "")}`;
  const show = pinned || hovered;

  useEffect(() => {
    if (!pinned) return;
    const onDoc = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setPinned(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPinned(false);
    };
    document.addEventListener("pointerdown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [pinned]);

  return (
    <span
      ref={ref}
      className="relative inline-flex shrink-0"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        aria-label={`What is the ${bucketLabel(bucket)} bucket?`}
        aria-expanded={show}
        aria-controls={tipId}
        onClick={() => setPinned((p) => !p)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setPinned(false);
            setHovered(false);
          }
        }}
        className="inline-flex h-[18px] w-[18px] items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--dim)] hover:text-[var(--accent)] focus-visible:text-[var(--accent)]"
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="6.4" stroke="currentColor" strokeWidth="1.3" />
          <path
            d="M8 7.3v3.4"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <circle cx="8" cy="5.1" r="0.95" fill="currentColor" />
        </svg>
      </button>
      {show && (
        <span
          id={tipId}
          role="tooltip"
          className={`absolute top-full z-40 mt-1.5 block w-60 max-w-[calc(100vw-3rem)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-2.5 text-xs leading-relaxed font-normal whitespace-normal text-[var(--text)] shadow-lg ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          <span className="font-semibold">{bucketLabel(bucket)} — </span>
          {BUCKET_DEFINITIONS[bucket]}
        </span>
      )}
    </span>
  );
}

/* The share-rounding sentence, carried verbatim in three ⓘ
   tooltips (Share chart note, Current allocation, Accounts
   footnote) instead of printed under each of them. Kept as one
   constant so the three bubbles can never drift apart — and so
   the string itself stays byte-identical everywhere it appears. */
const SHARE_ROUNDING_NOTE =
  "Shares are rounded to 0.1% and may not sum to exactly 100%.";

/* Small ⓘ info button + tooltip carrying one short note verbatim,
   modeled exactly on BucketHelp above: hovering or focusing the
   button shows the bubble, tapping or clicking pins it open,
   tapping outside or pressing Escape closes a pinned bubble.
   `align` keeps the bubble inside its container horizontally;
   `placement` opens it above the button instead of below (used
   where the note sits at the bottom of an overflow-hidden card
   and a bubble below would be clipped). */
function InfoNote({
  text,
  ariaLabel,
  align = "left",
  placement = "below",
}: {
  text: string;
  ariaLabel: string;
  align?: "left" | "right";
  placement?: "below" | "above";
}) {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const rawId = useId();
  const tipId = `nw-info-tip-${rawId.replace(/[^a-zA-Z0-9]/g, "")}`;
  const show = pinned || hovered;

  useEffect(() => {
    if (!pinned) return;
    const onDoc = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setPinned(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPinned(false);
    };
    document.addEventListener("pointerdown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [pinned]);

  return (
    <span
      ref={ref}
      className="relative ml-1 inline-flex shrink-0 align-middle"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        aria-label={ariaLabel}
        aria-expanded={show}
        aria-controls={tipId}
        onClick={() => setPinned((p) => !p)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setPinned(false);
            setHovered(false);
          }
        }}
        className="inline-flex h-[18px] w-[18px] items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--dim)] hover:text-[var(--accent)] focus-visible:text-[var(--accent)]"
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="6.4" stroke="currentColor" strokeWidth="1.3" />
          <path
            d="M8 7.3v3.4"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <circle cx="8" cy="5.1" r="0.95" fill="currentColor" />
        </svg>
      </button>
      {show && (
        <span
          id={tipId}
          role="tooltip"
          className={`absolute z-40 block w-56 max-w-[calc(100vw-3rem)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-2.5 text-xs leading-relaxed font-normal whitespace-normal text-[var(--text)] shadow-lg ${
            placement === "above" ? "bottom-full mb-1.5" : "top-full mt-1.5"
          } ${align === "right" ? "right-0" : "left-0"}`}
        >
          {text}
        </span>
      )}
    </span>
  );
}
type NwBalance = NwSnapshot["balances"][number];
function balanceHasSplit(b: NwBalance): boolean {
  return (b.splits ?? []).length > 0;
}

// Property kinds: "asset" (house) adds, "liability" (mortgage)
// subtracts, whenever property is included. Property balances are
// never part of a tax bucket — they live outside the buckets and
// reconcile as their own line: bucket subtotals + property net =
// grand total (when the include toggle is on).
type NwPropertyKind = "none" | "asset" | "liability";
// The account-type choice offered when adding or editing an
// account: the three property kinds, or "custodial" — a custodial
// account (e.g. UTMA/UGMA) whose money belongs to a child. It is
// stored as propertyKind "none" plus the account's custodial flag,
// is recorded like any other account, and is never counted in any
// total or calculation.
type NwAccountType = NwPropertyKind | "custodial";
const CUSTODIAL_EXPLAINER =
  "For money that belongs to a child (e.g., UTMA/UGMA). Recorded here, but never counted in net worth or any calculation.";
const PROPERTY_COLOR = "#dc2626";
const CUSTODIAL_COLOR = "#0369a1";
const PROPERTY_KEY = bucketKey("Property");
function propertyKindOfAccount(
  kindById: Map<number, NwPropertyKind>,
  accountId: number,
): NwPropertyKind {
  return kindById.get(accountId) ?? "none";
}
function isPropertyKindClient(kind: NwPropertyKind): boolean {
  return kind !== "none";
}
// Signed contribution of a stored balance: a property liability's
// positive entered balance subtracts; everything else as entered.
function effectiveBalanceCentsClient(
  kind: NwPropertyKind,
  balanceCents: number,
): number {
  return kind === "liability" ? -balanceCents : balanceCents;
}
// Signed net of a snapshot's property accounts (assets − liabilities).
// Null when no property account has a balance in that snapshot.
function propertyNetForSnapshot(
  snapshot: NwSnapshot,
  kindById: Map<number, NwPropertyKind>,
): number | null {
  let sum = 0;
  let has = false;
  for (const b of snapshot.balances) {
    const kind = propertyKindOfAccount(kindById, b.accountId);
    if (!isPropertyKindClient(kind)) continue;
    sum += effectiveBalanceCentsClient(kind, b.balanceCents);
    has = true;
  }
  return has ? sum : null;
}

// Bucket totals aggregate the per-snapshot splits across accounts:
// a split balance contributes each part to its bucket; a balance with
// no split contributes its whole amount to Unbucketed. Property
// accounts are always skipped here — they are outside the buckets
// in both toggle states — and custodial accounts are always skipped
// too: a custodial balance appears in no bucket and never as
// Unbucketed.
function bucketTotalForSnapshot(
  snapshot: NwSnapshot,
  bucket: NwBucket,
  kindById: Map<number, NwPropertyKind>,
  custodialIds: Set<number>,
): number | null {
  let sum = 0;
  let has = false;
  for (const b of snapshot.balances) {
    if (custodialIds.has(b.accountId)) {
      continue;
    }
    if (isPropertyKindClient(propertyKindOfAccount(kindById, b.accountId))) {
      continue;
    }
    if (balanceHasSplit(b)) {
      if (bucket === "Unbucketed") continue;
      const part = (b.splits ?? []).find((p) => p.bucket === bucket);
      if (part) {
        sum += part.amountCents;
        has = true;
      }
    } else if (bucket === "Unbucketed") {
      sum += b.balanceCents;
      has = true;
    }
  }
  return has ? sum : null;
}

function fmt(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  const rem = abs % 100;
  const s = rem === 0 ? `$${dollars}` : `$${dollars}.${String(rem).padStart(2, "0")}`;
  return neg ? `−${s}` : s;
}

function fmtSigned(cents: number): string {
  if (cents === 0) return fmt(0);
  return cents > 0 ? `+${fmt(cents)}` : fmt(cents);
}

function fmtPct(frac: number): string {
  const pct = Math.abs(frac * 100).toFixed(2);
  if (frac > 0) return `+${pct}%`;
  if (frac < 0) return `−${pct}%`;
  return "0.00%";
}

function fmtCompact(cents: number): string {
  const d = cents / 100;
  if (Math.abs(d) >= 1_000_000) return `$${(d / 1_000_000).toFixed(2)}M`;
  if (Math.abs(d) >= 1_000) return `$${Math.round(d / 1_000)}k`;
  return `$${d}`;
}

// Whole-dollar formatting for the chart headline annotation: the
// value is already an integer number of dollars (the displayed
// figure). The signed variant always carries an explicit sign —
// "+$0" included — matching the annotation's settled wording.
function fmtWholeDollar(dollars: number): string {
  const neg = dollars < 0;
  const s = `$${Math.abs(dollars).toLocaleString("en-US")}`;
  return neg ? `−${s}` : s;
}
function fmtWholeDollarSigned(dollars: number): string {
  return dollars < 0 ? fmtWholeDollar(dollars) : `+${fmtWholeDollar(dollars)}`;
}
function fmtMonthYear(date: string): string {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  return `${MONTH_SHORT[m - 1] ?? ""} ${y}`;
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// Round a dollar amount up to a "nice" symmetric axis maximum:
// 1, 2, 2.5, 5 or 10 × a power of ten. Ticks at -M, -M/2, 0, M/2, M
// are then always regular and symmetric around zero.
function niceCeilDollars(rawDollars: number): number {
  if (!Number.isFinite(rawDollars) || rawDollars <= 0) return 100;
  const mag = Math.pow(10, Math.floor(Math.log10(rawDollars)));
  const norm = rawDollars / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return nice * mag;
}

function fmtDateLong(date: string): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${MONTH_SHORT[m - 1] ?? ""} ${d}, ${y}`;
}

function fmtDateShort(date: string): string {
  const y = date.slice(2, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${m}/${d}/${y}`;
}

function tsOf(date: string): number {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return Date.UTC(y, m - 1, d);
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseBalanceInput(raw: string): number | null | undefined {
  const s = raw.trim().replace(/[$,\s]/g, "");
  if (s === "") return null; // blank = not recorded
  const n = Number(s);
  if (!Number.isFinite(n)) return undefined; // invalid
  return Math.round(n * 100);
}

const inputCls =
  "w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)]";
const labelCls = "block text-sm font-medium text-[var(--text)] mb-1";
const btnPrimary =
  "rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2 text-base font-medium text-white disabled:opacity-50";
const btnGhost =
  "rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-medium text-[var(--text)]";

/* ---------------- derived model ---------------- */

type SeriesPoint = { date: string; ts: number; cents: number };

function buildSeries(
  snapshots: NwSnapshot[],
  accountId: number,
): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  for (const s of snapshots) {
    const b = s.balances.find((x) => x.accountId === accountId);
    if (b) out.push({ date: s.date, ts: tsOf(s.date), cents: b.balanceCents });
  }
  return out;
}

/* ---------------- sparkline ---------------- */

function Sparkline({ series, color }: { series: SeriesPoint[]; color: string }) {
  if (series.length < 2) {
    return <span className="text-xs text-[var(--dim)]">—</span>;
  }
  const w = 96;
  const h = 28;
  const pad = 2;
  const min = Math.min(...series.map((p) => p.cents));
  const max = Math.max(...series.map((p) => p.cents));
  const span = max - min || 1;
  const tMin = series[0]?.ts ?? 0;
  const tMax = series[series.length - 1]?.ts ?? 1;
  const tSpan = tMax - tMin || 1;
  const pts = series.map((p) => {
    const x = pad + ((p.ts - tMin) / tSpan) * (w - pad * 2);
    const y = h - pad - ((p.cents - min) / span) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const lastPt = pts[pts.length - 1]?.split(",") ?? ["0", "0"];
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={`Trend from ${fmt(series[0]?.cents ?? 0)} to ${fmt(series[series.length - 1]?.cents ?? 0)}`}
      className="shrink-0"
    >
      <polyline
        points={pts.join(" ")}
        fill="none"
        stroke={color}
        strokeWidth="1.8"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={lastPt[0] ?? 0} cy={lastPt[1] ?? 0} r="2.4" fill={color} />
    </svg>
  );
}

/* ---------------- snapshot editor ---------------- */

function SnapshotEditor({
  snapshot,
  accounts,
  snapshots,
  onClose,
}: {
  snapshot: NwSnapshot | null; // null = add mode
  accounts: NwAccount[];
  snapshots: NwSnapshot[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const isEdit = snapshot != null;
  // Entry form accounts: active accounts, plus (when editing) any
  // archived account that has a recorded balance in this snapshot.
  const formAccounts = useMemo(() => {
    return accounts.filter((a) => {
      if (!a.archived) return true;
      if (!snapshot) return false;
      return snapshot.balances.some((b) => b.accountId === a.id);
    });
  }, [accounts, snapshot]);

  // Per-account entry state: either one whole balance, or a split
  // across the tax buckets whose amounts ARE the balance.
  type EntryState = {
    mode: "whole" | "split";
    whole: string;
    splits: Record<NwSplitBucket, string>;
  };
  const emptyEntry = (): EntryState => ({
    mode: "whole",
    whole: "",
    splits: { HSA: "", Roth: "", Taxable: "", "Non-Taxable": "", "529": "", Cash: "", "Pre-tax": "" },
  });
  const prefill = useMemo(() => {
    const src = snapshot ?? snapshots[snapshots.length - 1] ?? null;
    const map: Record<number, EntryState> = {};
    if (src) {
      for (const b of src.balances) {
        const entry = emptyEntry();
        const acct = accounts.find((a) => a.id === b.accountId);
        // Property and custodial accounts never carry a split.
        const noSplit = acct ? acct.propertyKind !== "none" || acct.custodial : false;
        if (balanceHasSplit(b) && !noSplit) {
          entry.mode = "split";
          for (const p of b.splits ?? []) {
            entry.splits[p.bucket] = (p.amountCents / 100).toFixed(2);
          }
        } else {
          entry.whole = (b.balanceCents / 100).toFixed(2);
        }
        map[b.accountId] = entry;
      }
    }
    return map;
  }, [snapshot, snapshots, accounts]);

  const [date, setDate] = useState(snapshot?.date ?? todayStr());
  const [note, setNote] = useState(snapshot?.note ?? "");
  const [entries, setEntries] = useState<Record<number, EntryState>>(prefill);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  function entryFor(id: number): EntryState {
    return entries[id] ?? emptyEntry();
  }
  function setEntry(id: number, next: EntryState) {
    setEntries((prev) => ({ ...prev, [id]: next }));
  }
  // Live split total for display; null when any part is not a number.
  function splitTotalCents(entry: EntryState): number | null {
    let sum = 0;
    let any = false;
    for (const bucket of NW_SPLIT_BUCKETS) {
      const parsed = parseBalanceInput(entry.splits[bucket] ?? "");
      if (parsed === undefined) return null;
      if (parsed != null) {
        sum += parsed;
        any = true;
      }
    }
    return any ? sum : null;
  }

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["networth"] });

  const save = useMutation({
    mutationFn: (input: {
      date: string;
      note: string | null;
      balances: {
        accountId: number;
        balanceCents: number | null;
        splits: { bucket: NwSplitBucket; amountCents: number }[] | null;
      }[];
    }) =>
      isEdit && snapshot
        ? // Contract v65 (F11): the revision this editor loaded is
          // the CAS base — a stale whole-snapshot save is refused
          // with the conflict reason, shown below via setError.
          api.updateNwSnapshot({
            id: snapshot.id,
            ...input,
            baseRevision: snapshot.revision,
          })
        : api.addNwSnapshot(input),
    onSuccess: (r) => {
      if (!r.ok) {
        setError(r.reason);
        return;
      }
      invalidate();
      onClose();
    },
    onError: (e) => setError(String(e)),
  });

  const del = useMutation({
    mutationFn: (id: number) => api.deleteNwSnapshot({ id }),
    onSuccess: () => {
      invalidate();
      onClose();
    },
    onError: (e) => setError(String(e)),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setError("Pick a date for this snapshot.");
      return;
    }
    if (date > todayStr()) {
      setError("Snapshot date can't be in the future");
      return;
    }
    const balances: {
      accountId: number;
      balanceCents: number | null;
      splits: { bucket: NwSplitBucket; amountCents: number }[] | null;
    }[] = [];
    for (const a of formAccounts) {
      const entry = entryFor(a.id);
      if (entry.mode === "split" && a.propertyKind === "none" && !a.custodial) {
        const parts: { bucket: NwSplitBucket; amountCents: number }[] = [];
        let invalid = false;
        for (const bucket of NW_SPLIT_BUCKETS) {
          const parsed = parseBalanceInput(entry.splits[bucket] ?? "");
          if (parsed === undefined) {
            invalid = true;
            break;
          }
          if (parsed != null) parts.push({ bucket, amountCents: parsed });
        }
        if (invalid) {
          setError(`Check the split for ${a.name} — one of its bucket amounts isn't a number.`);
          return;
        }
        if (parts.length === 0) {
          balances.push({ accountId: a.id, balanceCents: null, splits: null });
        } else {
          const total = parts.reduce((s, p) => s + p.amountCents, 0);
          balances.push({ accountId: a.id, balanceCents: total, splits: parts });
        }
        continue;
      }
      const parsed = parseBalanceInput(entry.whole);
      if (parsed === undefined) {
        setError(`Check the balance for ${a.name} — it isn't a number.`);
        return;
      }
      balances.push({ accountId: a.id, balanceCents: parsed, splits: null });
    }
    save.mutate({ date, note: note.trim() ? note.trim() : null, balances });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={isEdit ? `Edit snapshot ${date}` : "Add snapshot"}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={submit}
        className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xl sm:rounded-[var(--radius)] sm:p-5"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="display text-xl font-semibold">
              {isEdit ? "Edit snapshot" : "Add snapshot"}
            </h3>
            <p className="mt-0.5 text-sm leading-relaxed text-[var(--dim)]">
              One balance per account. Leave a field blank if that account
              wasn&rsquo;t recorded on this date — blank is not the same as $0.
              An account holding more than one tax type can be split into
              buckets; the bucket amounts are its balance.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close snapshot editor"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--border)] text-lg"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="nw-date" className={labelCls}>Date</label>
            <input
              id="nw-date"
              type="date"
              required
              max={todayStr()}
              className={inputCls}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="nw-note" className={labelCls}>Note (optional)</label>
            <input
              id="nw-note"
              type="text"
              className={inputCls}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. After bonus landed"
            />
          </div>
        </div>
        <div className="mt-4 space-y-3">
          {formAccounts.map((a) => {
            const entry = entryFor(a.id);
            if (entry.mode === "split" && a.propertyKind === "none" && !a.custodial) {
              const total = splitTotalCents(entry);
              return (
                <fieldset
                  key={a.id}
                  className="rounded-[var(--radius)] border border-[var(--border)] p-3"
                >
                  <legend className="px-1 text-sm font-medium text-[var(--text)]">
                    {a.name}
                    {a.archived ? " (archived)" : ""} — split by bucket
                  </legend>
                  <div className="grid grid-cols-2 gap-2">
                    {NW_SPLIT_BUCKETS.map((bucket, i) => (
                      <div key={bucket}>
                        <div className="mb-1 flex items-center gap-1.5">
                          <label
                            htmlFor={`nw-bal-${a.id}-${bucketKey(bucket)}`}
                            className="text-sm font-medium text-[var(--text)]"
                          >
                            <span
                              aria-hidden="true"
                              className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle"
                              style={{ background: BUCKET_COLORS[bucket] }}
                            />
                            {bucketLabel(bucket)}
                          </label>
                          <BucketHelp
                            bucket={bucket}
                            align={i % 2 === 0 ? "left" : "right"}
                          />
                        </div>
                        <input
                          id={`nw-bal-${a.id}-${bucketKey(bucket)}`}
                          aria-label={`${a.name} ${bucketLabel(bucket)} amount`}
                          type="text"
                          inputMode="decimal"
                          className={inputCls}
                          value={entry.splits[bucket]}
                          onChange={(e) =>
                            setEntry(a.id, {
                              ...entry,
                              splits: { ...entry.splits, [bucket]: e.target.value },
                            })
                          }
                          placeholder="Blank = $0"
                        />
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <p className="tnum text-sm text-[var(--dim)]" aria-live="polite">
                      {total != null
                        ? `Balance total: ${fmt(total)} — the bucket amounts are the balance`
                        : entry.whole.trim() !== ""
                          ? `Was ${entry.whole} as one balance — the parts replace it`
                          : "Enter at least one bucket amount"}
                    </p>
                    <button
                      type="button"
                      aria-label={`Clear split for ${a.name} and use a single balance`}
                      className="text-sm font-medium text-[var(--accent)] underline underline-offset-2"
                      onClick={() => {
                        const t = splitTotalCents(entry);
                        setEntry(a.id, {
                          mode: "whole",
                          // Keep the split's sum as the single balance;
                          // if no parts were entered, restore the
                          // balance that was there before splitting.
                          whole: t != null ? (t / 100).toFixed(2) : entry.whole,
                          splits: { HSA: "", Roth: "", Taxable: "", "Non-Taxable": "", "529": "", Cash: "", "Pre-tax": "" },
                        });
                      }}
                    >
                      Clear split — use one balance
                    </button>
                  </div>
                </fieldset>
              );
            }
            return (
              <div key={a.id}>
                <label htmlFor={`nw-bal-${a.id}`} className={labelCls}>
                  {a.name}
                  {a.archived ? " (archived)" : ""}
                  {a.propertyKind === "asset" ? " — Property asset" : ""}
                  {a.propertyKind === "liability" ? " — Property liability" : ""}
                  {a.custodial ? " — Custodial — not counted" : ""}
                </label>
                <div className="flex items-center gap-2">
                  <input
                    id={`nw-bal-${a.id}`}
                    type="text"
                    inputMode="decimal"
                    className={inputCls}
                    value={entry.whole}
                    onChange={(e) => setEntry(a.id, { ...entry, whole: e.target.value })}
                    placeholder="Blank = not recorded"
                  />
                  {a.propertyKind === "none" && !a.custodial && (
                    <button
                      type="button"
                      aria-label={`Split ${a.name} into buckets`}
                      className="shrink-0 text-sm font-medium whitespace-nowrap text-[var(--accent)] underline underline-offset-2"
                      onClick={() => setEntry(a.id, { ...entry, mode: "split" })}
                    >
                      Split into buckets
                    </button>
                  )}
                </div>
                {a.propertyKind === "liability" && (
                  <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">
                    Enter the amount owed as a positive number — it subtracts
                    from net worth when house &amp; mortgage are included.
                  </p>
                )}
                {a.propertyKind === "asset" && (
                  <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">
                    Property asset — it adds to net worth when house &amp;
                    mortgage are included, and never counts in a tax bucket.
                  </p>
                )}
                {a.custodial && (
                  <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">
                    Custodial — not counted. {CUSTODIAL_EXPLAINER}
                  </p>
                )}
              </div>
            );
          })}
          {formAccounts.length === 0 && (
            <p className="text-sm text-[var(--dim)]">
              No active accounts yet — add an account first.
            </p>
          )}
        </div>
        {error && <p className="mt-3 text-sm text-[var(--bad)]">{error}</p>}
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <button type="submit" className={btnPrimary} disabled={save.isPending}>
            {save.isPending ? "Saving…" : isEdit ? "Save changes" : "Add snapshot"}
          </button>
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          {isEdit && snapshot && !confirmDelete && (
            <button
              type="button"
              className="ml-auto rounded-[var(--radius)] border border-[var(--bad)] px-3 py-2 text-sm font-medium text-[var(--bad)]"
              onClick={() => setConfirmDelete(true)}
            >
              Delete snapshot
            </button>
          )}
          {isEdit && snapshot && confirmDelete && (
            <span className="ml-auto flex items-center gap-2">
              <span className="text-sm text-[var(--bad)]">Delete this snapshot?</span>
              <button
                type="button"
                className="rounded-[var(--radius)] bg-[var(--bad)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                disabled={del.isPending}
                onClick={() => del.mutate(snapshot.id)}
              >
                {del.isPending ? "Deleting…" : "Yes, delete"}
              </button>
              <button
                type="button"
                className={btnGhost}
                onClick={() => setConfirmDelete(false)}
              >
                Keep it
              </button>
            </span>
          )}
        </div>
      </form>
    </div>
  );
}

/* ---------------- single-balance editor ---------------- */
/* Correct ONE account's balance in ONE snapshot — the quick fix for
   a mistyped amount (say, an $80,000 balance added by accident).
   Saving goes through updateNwBalance, which touches only this
   account in this snapshot; every other recorded balance is left
   exactly as it was. Clearing the amount and saving removes the
   account from that snapshot, as if never recorded on that date. */

function BalanceEditor({
  account,
  snapshot,
  onClose,
}: {
  account: NwAccount;
  snapshot: NwSnapshot;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const existing =
    snapshot.balances.find((b) => b.accountId === account.id) ?? null;
  // Property and custodial accounts never carry a split.
  const noSplit = account.propertyKind !== "none" || account.custodial;
  type EntryState = {
    mode: "whole" | "split";
    whole: string;
    splits: Record<NwSplitBucket, string>;
  };
  const emptySplits = (): Record<NwSplitBucket, string> => ({
    HSA: "", Roth: "", Taxable: "", "Non-Taxable": "", "529": "", Cash: "", "Pre-tax": "",
  });
  const initial = (): EntryState => {
    if (!existing) return { mode: "whole", whole: "", splits: emptySplits() };
    if (balanceHasSplit(existing) && !noSplit) {
      const splits = emptySplits();
      for (const p of existing.splits ?? []) {
        splits[p.bucket] = (p.amountCents / 100).toFixed(2);
      }
      return {
        mode: "split",
        whole: (existing.balanceCents / 100).toFixed(2),
        splits,
      };
    }
    return {
      mode: "whole",
      whole: (existing.balanceCents / 100).toFixed(2),
      splits: emptySplits(),
    };
  };
  const [entry, setEntry] = useState<EntryState>(initial);
  const [error, setError] = useState("");

  function splitTotalCents(e: EntryState): number | null {
    let sum = 0;
    let any = false;
    for (const bucket of NW_SPLIT_BUCKETS) {
      const parsed = parseBalanceInput(e.splits[bucket] ?? "");
      if (parsed === undefined) return null;
      if (parsed != null) {
        sum += parsed;
        any = true;
      }
    }
    return any ? sum : null;
  }

  const save = useMutation({
    mutationFn: (input: {
      balanceCents: number | null;
      splits: { bucket: NwSplitBucket; amountCents: number }[] | null;
    }) =>
      api.updateNwBalance({
        snapshotId: snapshot.id,
        accountId: account.id,
        // Contract v65 (F12): the snapshot revision this editor
        // loaded is the CAS base — a refusal shows via setError.
        baseRevision: snapshot.revision,
        ...input,
      }),
    onSuccess: (r) => {
      if (!r.ok) {
        setError(r.reason);
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["networth"] });
      onClose();
    },
    onError: (e) => setError(String(e)),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (entry.mode === "split" && !noSplit) {
      const parts: { bucket: NwSplitBucket; amountCents: number }[] = [];
      for (const bucket of NW_SPLIT_BUCKETS) {
        const parsed = parseBalanceInput(entry.splits[bucket] ?? "");
        if (parsed === undefined) {
          setError(`Check the ${bucketLabel(bucket)} amount — it isn't a number.`);
          return;
        }
        if (parsed != null) parts.push({ bucket, amountCents: parsed });
      }
      if (parts.length === 0) {
        save.mutate({ balanceCents: null, splits: null });
        return;
      }
      const total = parts.reduce((s, p) => s + p.amountCents, 0);
      save.mutate({ balanceCents: total, splits: parts });
      return;
    }
    const parsed = parseBalanceInput(entry.whole);
    if (parsed === undefined) {
      setError("Check the amount — it isn't a number.");
      return;
    }
    save.mutate({ balanceCents: parsed, splits: null });
  }

  const splitTotal = entry.mode === "split" ? splitTotalCents(entry) : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Edit balance for ${account.name}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={submit}
        className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xl sm:rounded-[var(--radius)] sm:p-5"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="display text-xl font-semibold">
              Edit balance — {account.name}
            </h3>
            <p className="mt-0.5 text-sm leading-relaxed text-[var(--dim)]">
              This is the amount recorded in the {fmtDateLong(snapshot.date)}{" "}
              snapshot. Saving changes only this account in that snapshot —
              every other balance stays as recorded.{" "}
              {entry.mode === "split" && !noSplit
                ? "Clear every bucket field and save to remove this account from that snapshot entirely."
                : "Clear the field and save to remove this account from that snapshot entirely."}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close balance editor"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--border)] text-lg"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <div className="mt-4">
          {entry.mode === "split" && !noSplit ? (
            <fieldset className="rounded-[var(--radius)] border border-[var(--border)] p-3">
              <legend className="px-1 text-sm font-medium text-[var(--text)]">
                Split by bucket — {fmtDateLong(snapshot.date)}
              </legend>
              <div className="grid grid-cols-2 gap-2">
                {NW_SPLIT_BUCKETS.map((bucket, i) => (
                  <div key={bucket}>
                    <div className="mb-1 flex items-center gap-1.5">
                      <label
                        htmlFor={`nw-one-bal-${bucketKey(bucket)}`}
                        className="text-sm font-medium text-[var(--text)]"
                      >
                        <span
                          aria-hidden="true"
                          className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle"
                          style={{ background: BUCKET_COLORS[bucket] }}
                        />
                        {bucketLabel(bucket)}
                      </label>
                      <BucketHelp
                        bucket={bucket}
                        align={i % 2 === 0 ? "left" : "right"}
                      />
                    </div>
                    <input
                      id={`nw-one-bal-${bucketKey(bucket)}`}
                      aria-label={`${account.name} ${bucketLabel(bucket)} amount`}
                      type="text"
                      inputMode="decimal"
                      className={inputCls}
                      value={entry.splits[bucket]}
                      onChange={(e) =>
                        setEntry({
                          ...entry,
                          splits: { ...entry.splits, [bucket]: e.target.value },
                        })
                      }
                      placeholder="Blank = $0"
                    />
                  </div>
                ))}
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <p className="tnum text-sm text-[var(--dim)]" aria-live="polite">
                  {splitTotal != null
                    ? `Balance total: ${fmt(splitTotal)} — the bucket amounts are the balance`
                    : "Clear every bucket and save to remove this account from the snapshot"}
                </p>
                <button
                  type="button"
                  aria-label={`Use a single balance for ${account.name}`}
                  className="text-sm font-medium text-[var(--accent)] underline underline-offset-2"
                  onClick={() => {
                    const t = splitTotalCents(entry);
                    setEntry({
                      mode: "whole",
                      whole: t != null ? (t / 100).toFixed(2) : entry.whole,
                      splits: emptySplits(),
                    });
                  }}
                >
                  Clear split — use one balance
                </button>
              </div>
            </fieldset>
          ) : (
            <div>
              <label htmlFor="nw-one-bal" className={labelCls}>
                Balance on {fmtDateLong(snapshot.date)}
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="nw-one-bal"
                  type="text"
                  inputMode="decimal"
                  className={inputCls}
                  value={entry.whole}
                  onChange={(e) => setEntry({ ...entry, whole: e.target.value })}
                  placeholder="Blank = remove from this snapshot"
                />
                {!noSplit && (
                  <button
                    type="button"
                    aria-label={`Split ${account.name} into buckets`}
                    className="shrink-0 text-sm font-medium whitespace-nowrap text-[var(--accent)] underline underline-offset-2"
                    onClick={() => setEntry({ ...entry, mode: "split" })}
                  >
                    Split into buckets
                  </button>
                )}
              </div>
              {account.propertyKind === "liability" && (
                <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">
                  Enter the amount owed as a positive number — it subtracts
                  from net worth when house &amp; mortgage are included.
                </p>
              )}
              {account.custodial && (
                <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">
                  Custodial — not counted. {CUSTODIAL_EXPLAINER}
                </p>
              )}
            </div>
          )}
        </div>
        {error && <p className="mt-3 text-sm text-[var(--bad)]">{error}</p>}
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <button type="submit" className={btnPrimary} disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save balance"}
          </button>
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

/* ---------------- Net Worth balance import (IM-3 + IM-5) ----------------
   Drop in a balances CSV from an institution — or an OFX/QFX
   statement file, whose ledger balances become the rows
   directly — and get a DRAFT
   snapshot: rows are matched to accounts (remembered mappings
   first, then by name), unmatched rows are assigned or skipped
   by hand, splits are proposed (exact bucket amounts from
   bucket-mapped rows, else the last split's proportions), and
   accounts missing from the file are carried at their last
   balance — labelled, and removable. Nothing saves until the
   draft is confirmed, and the save is the existing
   addNwSnapshot action. All parsing happens here in the
   browser through the shared core (server/src/nwImportCore.ts),
   so the packaged browser-only build behaves identically. */

type NwImportEntryState = {
  accountId: number;
  source: NwDraftEntry["source"];
  splitSource: NwDraftEntry["splitSource"];
  fileRowCount: number;
  removed: boolean;
  mode: "whole" | "split";
  whole: string;
  splits: Record<NwSplitBucket, string>;
};

function nwTargetKey(t: NwImportRowTarget | null): string {
  if (!t) return "skip";
  return t.bucket ? `a:${t.accountId}:b:${t.bucket}` : `a:${t.accountId}`;
}

function nwTargetFromKey(key: string): NwImportRowTarget | null {
  if (!key.startsWith("a:")) return null;
  const rest = key.slice(2);
  const sep = rest.indexOf(":b:");
  const idPart = sep >= 0 ? rest.slice(0, sep) : rest;
  const accountId = Number(idPart);
  if (!Number.isInteger(accountId) || accountId <= 0) return null;
  if (sep < 0) return { accountId, bucket: null };
  const bucket = rest.slice(sep + 3);
  return (NW_SPLIT_BUCKETS as readonly string[]).includes(bucket)
    ? { accountId, bucket: bucket as NwSplitBucket }
    : { accountId, bucket: null };
}

function NwImportPanel({
  accounts,
  snapshots,
  includeProperty,
  onSaved,
  onClose,
}: {
  accounts: NwAccount[];
  snapshots: NwSnapshot[];
  includeProperty: boolean;
  onSaved: () => void;
  onClose: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [csvText, setCsvText] = useState("");
  const [mapping, setMapping] = useState<NwBalanceMapping>(() =>
    guessNwBalanceMapping(null),
  );
  const [profileNotice, setProfileNotice] = useState("");
  const [settingsBlob, setSettingsBlob] = useState<NwImportSettingsBlob>(
    EMPTY_NW_IMPORT_SETTINGS,
  );
  const [error, setError] = useState("");
  // Per-row target overrides, keyed by parsed-row index. Absent =
  // keep the automatic match shown in the row's select.
  const [assign, setAssign] = useState<Record<number, string>>({});
  const [draft, setDraft] = useState<NwImportEntryState[] | null>(null);
  const [draftDate, setDraftDate] = useState(todayStr());
  const [savedBanner, setSavedBanner] = useState<{
    date: string;
    totalCents: number;
    prevTotalCents: number | null;
    prevDate: string | null;
  } | null>(null);
  const pendingBannerRef = useRef<typeof savedBanner>(null);

  /* Remembered setup: header-keyed column profiles plus the
     confirmed label → account/bucket mappings, in ONE settings
     value (the app's settings storage, carried in backup/restore
     like the other saved blobs). Loaded once when the panel
     opens; a profile whose header matches the loaded file
     applies its mapping automatically (see the effect below). */
  const settingsQuery = useQuery({
    queryKey: ["nwImportSettings"],
    queryFn: () => api.getNwImportSettings({}),
  });
  const settingsLoaded = settingsQuery.isSuccess;
  useEffect(() => {
    if (!settingsQuery.data) return;
    setSettingsBlob(
      settingsQuery.data.settingsJson
        ? parseNwImportSettings(settingsQuery.data.settingsJson)
        : EMPTY_NW_IMPORT_SETTINGS,
    );
  }, [settingsQuery.data]);

  const saveSetup = useMutation({
    mutationFn: (json: string) => api.saveNwImportSettings({ settingsJson: json }),
    // A failed save never blocks an import — the panel just
    // keeps working with the values on screen.
    onError: () =>
      setProfileNotice(
        "Your import setup couldn't be saved this time — the import itself is unaffected.",
      ),
  });

  /* An OFX/QFX file (IM-5), parsed once per text change: each
     account's ledger balance becomes a balance row directly —
     no column mapping, since the format names its own fields.
     Null when the loaded text is a CSV (or nothing). */
  const ofxData = useMemo(() => {
    if (csvText.trim() === "" || !looksLikeOfx(csvText)) return null;
    const res = parseOfx(csvText);
    if (!res.ok) return { error: res.error, rows: [], skippedAccounts: 0, accountCount: 0 };
    const built = balanceRowsFromOfx(res.accounts);
    return {
      error:
        built.rows.length === 0
          ? "That OFX file states no ledger balance for any account — there is no balance to draft from it. (Its transactions can be imported from the Spending view instead.)"
          : "",
      rows: built.rows,
      skippedAccounts: built.skippedAccounts,
      accountCount: res.accounts.length,
    };
  }, [csvText]);

  /* The loaded file, parsed once per text change. */
  const parsedFile = useMemo(() => {
    if (csvText.trim() === "") return null;
    if (ofxData) {
      return {
        error: ofxData.error,
        header: null as string[] | null,
        body: [] as string[][],
        columnCount: 0,
      };
    }
    const parsed = parseCsvChecked(csvText);
    if ("error" in parsed) {
      return {
        error: parsed.error,
        header: null as string[] | null,
        body: [] as string[][],
        columnCount: 0,
      };
    }
    const raw = parsed.rows;
    const first = raw[0] ?? [];
    const hasHeader = raw.length > 0 && detectNwBalanceHeader(first);
    return {
      error: "",
      header: hasHeader ? first.map((c) => c.trim()) : null,
      body: hasHeader ? raw.slice(1) : raw,
      columnCount: raw.reduce((n, r) => Math.max(n, r.length), 0),
    };
  }, [csvText]);

  /* When a file with a header arrives: a saved profile for its
     header applies its mapping and says so; otherwise start
     from the automatic guess. Any change of file clears the
     row assignments and the draft. */
  const appliedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const header = parsedFile?.header ?? null;
    const key = `${header ? importHeaderFingerprint(header) : "no-header"}|${settingsLoaded ? "loaded" : "pending"}`;
    if (appliedKeyRef.current === key) return;
    appliedKeyRef.current = key;
    setAssign({});
    setDraft(null);
    setSavedBanner(null);
    if (!header) {
      setMapping(guessNwBalanceMapping(null));
      setProfileNotice("");
      return;
    }
    const profile = findNwImportProfile(settingsBlob, header);
    if (profile) {
      setMapping(profile.mapping);
      setProfileNotice(
        "Saved setup applied — this file's columns match a layout you've imported before, so its column mapping was filled in from that profile. Change anything below and the profile updates when you build the draft.",
      );
    } else {
      setMapping(guessNwBalanceMapping(header));
      setProfileNotice("");
    }
  }, [parsedFile, settingsLoaded, settingsBlob]);

  const mappingValid = mapping.label >= 0 && mapping.balance >= 0;
  const parsedRows = useMemo(() => {
    if (ofxData) {
      return ofxData.error
        ? null
        : { rows: ofxData.rows, skipped: 0 };
    }
    if (!parsedFile || parsedFile.error || !mappingValid) return null;
    return parseNwBalanceRows(parsedFile.body, mapping);
  }, [ofxData, parsedFile, mapping, mappingValid]);

  const matchedRows = useMemo(() => {
    if (!parsedRows) return null;
    return matchNwImportRows(parsedRows.rows, accounts, settingsBlob.labelMappings);
  }, [parsedRows, accounts, settingsBlob]);

  const accountById = useMemo(
    () => new Map(accounts.map((a) => [a.id, a] as [number, NwAccount])),
    [accounts],
  );
  const noSplitIds = useMemo(
    () =>
      new Set(
        accounts
          .filter((a) => a.propertyKind !== "none" || a.custodial)
          .map((a) => a.id),
      ),
    [accounts],
  );
  const latestSnapshot = snapshots[snapshots.length - 1] ?? null;
  const lastBalances = useMemo(() => {
    const out: Record<
      number,
      { balanceCents: number; splits: { bucket: NwSplitBucket; amountCents: number }[] }
    > = {};
    if (latestSnapshot) {
      for (const b of latestSnapshot.balances) {
        out[b.accountId] = {
          balanceCents: b.balanceCents,
          splits: (b.splits ?? []).map((p) => ({
            bucket: p.bucket,
            amountCents: p.amountCents,
          })),
        };
      }
    }
    return out;
  }, [latestSnapshot]);

  function resetWork() {
    setAssign({});
    setDraft(null);
    setSavedBanner(null);
    setError("");
  }

  function finalRows() {
    if (!matchedRows) return null;
    return matchedRows.map((r, i) => {
      const key = assign[i];
      return key === undefined ? r : { ...r, target: nwTargetFromKey(key) };
    });
  }

  function buildDraft() {
    setError("");
    const rows = finalRows();
    if (!rows || rows.length === 0) {
      setError("Load a balances file first — there are no usable rows yet.");
      return;
    }
    if (rows.every((r) => r.target == null)) {
      setError(
        "Every row is set to skip — assign at least one row to an account to build a draft.",
      );
      return;
    }
    const entries = buildNwImportDraft({
      accounts,
      rows,
      lastBalances,
      noSplitIds,
    });
    setDraft(
      entries.map((entry) => {
        const splits: Record<NwSplitBucket, string> = {
          HSA: "", Roth: "", Taxable: "", "Non-Taxable": "", "529": "", Cash: "", "Pre-tax": "",
        };
        if (entry.splits) {
          for (const p of entry.splits) {
            splits[p.bucket] = (p.amountCents / 100).toFixed(2);
          }
        }
        return {
          accountId: entry.accountId,
          source: entry.source,
          splitSource: entry.splitSource,
          fileRowCount: entry.fileRowCount,
          removed: false,
          mode: entry.splits ? ("split" as const) : ("whole" as const),
          whole:
            entry.balanceCents != null
              ? (entry.balanceCents / 100).toFixed(2)
              : "",
          splits,
        };
      }),
    );
    const dated = rows.filter((r) => r.target != null);
    setDraftDate(nwImportStatementDate(dated) ?? todayStr());
    setSavedBanner(null);
    // Remember what the user just confirmed: the profile for
    // this header, and every non-skipped row's label mapping.
    const additions: Record<string, NwImportRowTarget> = {};
    for (const r of rows) {
      if (r.target) {
        additions[normalizeNwLabel(r.matchKey ?? r.label)] = r.target;
      }
    }
    let blob = settingsBlob;
    if (parsedFile?.header) {
      blob = upsertNwImportProfile(blob, parsedFile.header, mapping);
    }
    blob = withNwLabelMappings(blob, additions);
    setSettingsBlob(blob);
    saveSetup.mutate(serializeNwImportSettings(blob));
  }

  function setDraftEntry(id: number, next: NwImportEntryState) {
    setDraft((prev) =>
      prev ? prev.map((e) => (e.accountId === id ? next : e)) : prev,
    );
  }

  function draftEntryTotalCents(es: NwImportEntryState): number | null {
    const acct = accountById.get(es.accountId);
    const splittable =
      acct != null && acct.propertyKind === "none" && !acct.custodial;
    if (es.mode === "split" && splittable) {
      let sum = 0;
      let any = false;
      for (const bucket of NW_SPLIT_BUCKETS) {
        const parsed = parseBalanceInput(es.splits[bucket] ?? "");
        if (parsed === undefined) return null;
        if (parsed != null) {
          sum += parsed;
          any = true;
        }
      }
      return any ? sum : null;
    }
    const parsed = parseBalanceInput(es.whole);
    return parsed === undefined ? null : parsed;
  }

  // The draft's snapshot total under the same rules getNetWorth
  // applies: custodial balances never count; property counts
  // only while the include toggle is on (liabilities subtract).
  const draftTotalCents = useMemo(() => {
    if (!draft) return null;
    let total = 0;
    let any = false;
    for (const es of draft) {
      if (es.removed) continue;
      const acct = accountById.get(es.accountId);
      if (!acct || acct.custodial) continue;
      const cents = draftEntryTotalCents(es);
      if (cents == null) continue;
      if (acct.propertyKind !== "none") {
        if (!includeProperty) continue;
        total += effectiveBalanceCentsClient(acct.propertyKind, cents);
      } else {
        total += cents;
      }
      any = true;
    }
    return any ? total : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, accountById, includeProperty]);

  const dateTaken =
    draft != null && snapshots.some((s) => s.date === draftDate);

  const saveSnapshot = useMutation({
    mutationFn: (input: {
      date: string;
      note: string | null;
      balances: {
        accountId: number;
        balanceCents: number | null;
        splits: { bucket: NwSplitBucket; amountCents: number }[] | null;
      }[];
    }) => api.addNwSnapshot(input),
    onSuccess: (r) => {
      if (!r.ok) {
        setError(r.reason);
        return;
      }
      setSavedBanner(pendingBannerRef.current);
      setDraft(null);
      onSaved();
    },
    onError: (e) => setError(String(e)),
  });

  function submitDraft() {
    setError("");
    if (!draft) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draftDate)) {
      setError("Pick a date for this snapshot.");
      return;
    }
    if (draftDate > todayStr()) {
      setError("Snapshot date can't be in the future");
      return;
    }
    if (snapshots.some((s) => s.date === draftDate)) {
      setError(
        `A snapshot already exists for ${fmtDateLong(draftDate)} — pick a different date, or edit that snapshot instead.`,
      );
      return;
    }
    const removedIds = new Set(
      draft.filter((e) => e.removed).map((e) => e.accountId),
    );
    const kept = filterNwDraftEntries(draft, removedIds);
    const balances: {
      accountId: number;
      balanceCents: number | null;
      splits: { bucket: NwSplitBucket; amountCents: number }[] | null;
    }[] = [];
    for (const es of kept) {
      const acct = accountById.get(es.accountId);
      if (!acct) continue;
      const splittable = acct.propertyKind === "none" && !acct.custodial;
      if (es.mode === "split" && splittable) {
        const parts: { bucket: NwSplitBucket; amountCents: number }[] = [];
        let invalid = false;
        for (const bucket of NW_SPLIT_BUCKETS) {
          const parsed = parseBalanceInput(es.splits[bucket] ?? "");
          if (parsed === undefined) {
            invalid = true;
            break;
          }
          if (parsed != null) parts.push({ bucket, amountCents: parsed });
        }
        if (invalid) {
          setError(
            `Check the split for ${acct.name} — one of its bucket amounts isn't a number.`,
          );
          return;
        }
        if (parts.length === 0) {
          balances.push({ accountId: acct.id, balanceCents: null, splits: null });
        } else {
          const total = parts.reduce((s, p) => s + p.amountCents, 0);
          balances.push({ accountId: acct.id, balanceCents: total, splits: parts });
        }
        continue;
      }
      const parsed = parseBalanceInput(es.whole);
      if (parsed === undefined) {
        setError(`Check the balance for ${acct.name} — it isn't a number.`);
        return;
      }
      balances.push({ accountId: acct.id, balanceCents: parsed, splits: null });
    }
    if (balances.every((b) => b.balanceCents == null)) {
      setError(
        "Enter at least one balance — every account in the draft is blank or removed.",
      );
      return;
    }
    // The banner compares this snapshot's total with the
    // previous latest snapshot's, under the same total rules.
    let total = 0;
    for (const b of balances) {
      if (b.balanceCents == null) continue;
      const acct = accountById.get(b.accountId);
      if (!acct || acct.custodial) continue;
      if (acct.propertyKind !== "none") {
        if (!includeProperty) continue;
        total += effectiveBalanceCentsClient(acct.propertyKind, b.balanceCents);
      } else {
        total += b.balanceCents;
      }
    }
    pendingBannerRef.current = {
      date: draftDate,
      totalCents: total,
      prevTotalCents: latestSnapshot?.totalCents ?? null,
      prevDate: latestSnapshot?.date ?? null,
    };
    saveSnapshot.mutate({ date: draftDate, note: null, balances });
  }

  const mappingRoles: { role: keyof NwBalanceMapping; label: string; optional: boolean }[] = [
    { role: "label", label: "Account label", optional: false },
    { role: "balance", label: "Balance", optional: false },
    { role: "date", label: "Date", optional: true },
  ];
  const unmatchedCount = matchedRows
    ? matchedRows.filter(
        (r, i) => (assign[i] === undefined ? r.target : nwTargetFromKey(assign[i])) == null,
      ).length
    : 0;

  return (
    <div className="mt-3 space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex items-start justify-between gap-3">
        <h3 className="display text-lg font-semibold">Import account balances</h3>
        <button
          type="button"
          aria-label="Close balance import"
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--border)] text-lg"
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      <p className="text-sm leading-relaxed text-[var(--dim)]">
        Export a balances or positions CSV from your bank or brokerage —
        one row per account or sub-account, with a label column and a
        balance column (a date column is used when present) — or an
        OFX/QFX statement file, whose ledger balance and as-of date
        are read directly for each account it holds (account numbers
        are shown masked) — then pick
        the file or paste it here. Rows are matched to your accounts by
        mappings you&rsquo;ve confirmed before, then by name; anything
        unmatched waits for you to assign or skip it. The result is a{" "}
        <strong>draft snapshot</strong>: accounts the file doesn&rsquo;t
        mention are carried at their last recorded balance and marked as
        carried, never silently zeroed, and every figure — including
        each proposed bucket split — stays editable. Nothing is saved
        until you confirm the draft. Column mappings and account
        assignments you confirm are remembered for next time. Import
        limits: a file up to 5 MB and 25,000 rows.
      </p>
      <div>
        <label htmlFor="nw-imp-file" className={labelCls}>Balances file (CSV or OFX/QFX)</label>
        <input
          id="nw-imp-file"
          ref={fileRef}
          type="file"
          accept=".csv,.ofx,.qfx,text/csv,text/plain"
          className="text-sm"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) {
              // Size budget first (csvUtil, finding S4): an
              // oversized file is refused by name before it is
              // read into the page at all.
              const sizeError = csvImportFileError(f.size);
              if (sizeError) {
                setError(sizeError);
                e.target.value = "";
                return;
              }
              void f.text().then((t) => {
                setCsvText(t);
                resetWork();
              });
            }
          }}
        />
      </div>
      <div>
        <label htmlFor="nw-imp-text" className={labelCls}>…or paste CSV or OFX text</label>
        <textarea
          id="nw-imp-text"
          rows={6}
          className={`${inputCls} font-mono text-sm`}
          value={csvText}
          onChange={(e) => {
            setCsvText(e.target.value);
            resetWork();
          }}
          placeholder={"account,balance\nBrokerage,125000.50\nBank,4200"}
        />
      </div>
      {parsedFile && parsedFile.error && (
        <p className="text-sm text-[var(--warn)]">{parsedFile.error}</p>
      )}
      {ofxData && !ofxData.error && (
        <p className="text-sm text-[var(--dim)]">
          OFX statement file — {ofxData.rows.length} account
          {ofxData.rows.length === 1 ? "" : "s"} with a ledger balance
          {ofxData.accountCount > 1 ? `, of ${ofxData.accountCount} in the file` : ""}.
          Each balance below is the statement&rsquo;s own ledger balance
          as of its date; there are no columns to map.
          {ofxData.skippedAccounts > 0 &&
            ` ${ofxData.skippedAccounts} account${ofxData.skippedAccounts === 1 ? "" : "s"} in the file state${ofxData.skippedAccounts === 1 ? "s" : ""} no ledger balance and contribute${ofxData.skippedAccounts === 1 ? "s" : ""} no row.`}
        </p>
      )}
      {parsedFile && parsedFile.columnCount > 0 && !parsedFile.error && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Which column is which?</legend>
          {profileNotice && <p className="text-sm text-[var(--dim)]">{profileNotice}</p>}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {mappingRoles.map(({ role, label, optional }) => (
              <div key={role}>
                <label htmlFor={`nw-imp-col-${role}`} className={labelCls}>{label} column</label>
                <select
                  id={`nw-imp-col-${role}`}
                  className={inputCls}
                  value={mapping[role]}
                  onChange={(e) => {
                    setMapping({ ...mapping, [role]: Number(e.target.value) });
                    setDraft(null);
                    setAssign({});
                    setSavedBanner(null);
                  }}
                >
                  {optional && <option value={-1}>Not in this file</option>}
                  {Array.from({ length: parsedFile.columnCount }, (_, i) => (
                    <option key={i} value={i}>
                      {parsedFile.header?.[i] ? parsedFile.header[i] : `Column ${i + 1}`}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
          {!mappingValid && (
            <p className="text-xs text-[var(--warn)]">
              Choose which columns hold the account label and the balance.
            </p>
          )}
        </fieldset>
      )}
      {parsedRows && parsedRows.skipped > 0 && (
        <p className="text-sm text-[var(--warn)]">
          {parsedRows.skipped} row{parsedRows.skipped === 1 ? "" : "s"} skipped —
          a missing label, a label over 200 characters or carrying the
          reserved enc:v1: prefix, or a balance that isn&rsquo;t a number.
        </p>
      )}
      {matchedRows && matchedRows.length > 0 && !draft && !savedBanner && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">
            Match the file&rsquo;s rows to your accounts
          </legend>
          <p className="text-xs text-[var(--dim)]">
            Rows matched to the same account add together into that
            account&rsquo;s new balance. Assigning a row to one bucket of
            an account (for example, a Roth sub-account row) uses that
            exact amount for the bucket in the draft&rsquo;s split.
            {unmatchedCount > 0 &&
              ` ${unmatchedCount} row${unmatchedCount === 1 ? " doesn't" : "s don't"} match an account yet — assign or skip ${unmatchedCount === 1 ? "it" : "them"} below.`}
          </p>
          <ul className="space-y-2">
            {matchedRows.slice(0, 100).map((r, i) => {
              const value = assign[i] ?? nwTargetKey(r.target);
              return (
                <li
                  key={i}
                  className="flex flex-wrap items-center gap-2 rounded-[var(--radius)] border border-[var(--border)] px-3 py-2"
                >
                  <span className="min-w-40 flex-1">
                    <span className="block text-sm font-medium break-words">{r.label}</span>
                    <span className="tnum block text-xs text-[var(--dim)]">
                      {fmt(r.balanceCents)}
                      {r.date ? ` · ${fmtDateShort(r.date)}` : ""}
                      {assign[i] === undefined && r.matchedBy === "remembered"
                        ? " · remembered mapping"
                        : assign[i] === undefined && r.matchedBy === "name"
                          ? " · matched by name"
                          : assign[i] === undefined
                            ? " · not matched"
                            : ""}
                    </span>
                  </span>
                  <label className="sr-only" htmlFor={`nw-imp-assign-${i}`}>
                    Account for file row {r.label}
                  </label>
                  <select
                    id={`nw-imp-assign-${i}`}
                    className="w-full min-w-52 flex-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)] sm:w-auto"
                    value={value}
                    onChange={(e) =>
                      setAssign((prev) => ({ ...prev, [i]: e.target.value }))
                    }
                  >
                    <option value="skip">Skip this row</option>
                    {accounts.map((a) => (
                      <optgroup key={a.id} label={a.name}>
                        <option value={`a:${a.id}`}>{a.name} — whole balance</option>
                        {a.propertyKind === "none" &&
                          !a.custodial &&
                          NW_SPLIT_BUCKETS.map((b) => (
                            <option key={b} value={`a:${a.id}:b:${b}`}>
                              {a.name} — {bucketLabel(b)} bucket
                            </option>
                          ))}
                      </optgroup>
                    ))}
                  </select>
                </li>
              );
            })}
          </ul>
          {matchedRows.length > 100 && (
            <p className="text-xs text-[var(--dim)]">
              …and {matchedRows.length - 100} more rows, matched the same way.
            </p>
          )}
        </fieldset>
      )}
      {error && <p className="text-sm text-[var(--bad)]">{error}</p>}
      {!draft && !savedBanner && (
        <div className="flex gap-2">
          <button
            type="button"
            className={btnPrimary}
            disabled={!matchedRows || matchedRows.length === 0}
            onClick={buildDraft}
          >
            Build draft snapshot
          </button>
        </div>
      )}
      {savedBanner && (
        <div className="rounded-[var(--radius)] bg-[var(--surface-alt)] p-3 text-sm" role="status">
          <p>
            Saved the {fmtDateLong(savedBanner.date)} snapshot — it totals{" "}
            <strong>{fmt(savedBanner.totalCents)}</strong>
            {savedBanner.prevTotalCents != null && savedBanner.prevDate
              ? `, next to the previous snapshot (${fmtDateShort(savedBanner.prevDate)}) at ${fmt(savedBanner.prevTotalCents)} — a change of ${fmtSigned(savedBanner.totalCents - savedBanner.prevTotalCents)}.`
              : " — the first snapshot recorded."}
          </p>
          <div className="mt-2 flex gap-2">
            <button type="button" className={btnGhost} onClick={onClose}>
              Done
            </button>
            <button
              type="button"
              className={btnGhost}
              onClick={() => {
                setSavedBanner(null);
                setCsvText("");
                resetWork();
              }}
            >
              Import another file
            </button>
          </div>
        </div>
      )}
      {draft && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="nw-imp-date" className={labelCls}>Snapshot date</label>
              <input
                id="nw-imp-date"
                type="date"
                required
                max={todayStr()}
                className={inputCls}
                value={draftDate}
                onChange={(e) => setDraftDate(e.target.value)}
              />
            </div>
            <p className="text-sm text-[var(--dim)]" aria-live="polite">
              {draftTotalCents != null
                ? `Draft total: ${fmt(draftTotalCents)}${includeProperty ? "" : " (property excluded — the Include house & mortgage toggle is off)"}`
                : "Draft total: —"}
              {latestSnapshot
                ? ` · Previous snapshot (${fmtDateShort(latestSnapshot.date)}): ${fmt(latestSnapshot.totalCents)}`
                : ""}
            </p>
          </div>
          {dateTaken && (
            <p className="text-sm text-[var(--warn)]">
              A snapshot already exists for this date — saving will be
              refused. Pick a different date, or close this and edit that
              snapshot instead.
            </p>
          )}
          {draft.map((es) => {
            const acct = accountById.get(es.accountId);
            if (!acct) return null;
            const splittable = acct.propertyKind === "none" && !acct.custodial;
            const lastBal = lastBalances[es.accountId];
            const total = es.mode === "split" && splittable ? draftEntryTotalCents(es) : null;
            return (
              <div
                key={es.accountId}
                className={`rounded-[var(--radius)] border border-[var(--border)] p-3 ${es.removed ? "opacity-60" : ""}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold">{acct.name}</span>
                  {acct.propertyKind === "asset" && (
                    <span className="text-xs font-medium text-[var(--dim)]">Property asset</span>
                  )}
                  {acct.propertyKind === "liability" && (
                    <span className="text-xs font-medium text-[var(--dim)]">Property liability</span>
                  )}
                  {acct.custodial && (
                    <span className="text-xs font-medium text-[var(--dim)]">Custodial — not counted</span>
                  )}
                  {es.source === "file" && (
                    <span className="text-xs font-medium text-[var(--accent)]">
                      From file{es.fileRowCount > 1 ? ` · ${es.fileRowCount} rows summed` : ""}
                    </span>
                  )}
                  {es.source === "carried" && (
                    <span className="text-xs font-medium text-[var(--warn)]">Not in file — carried</span>
                  )}
                  {es.source === "blank" && (
                    <span className="text-xs text-[var(--dim)]">No balance in the file or earlier snapshots</span>
                  )}
                  <button
                    type="button"
                    className="ml-auto text-sm font-medium text-[var(--accent)] underline underline-offset-2"
                    aria-label={
                      es.removed
                        ? `Restore ${acct.name} in this draft snapshot`
                        : `Remove ${acct.name} from this draft snapshot`
                    }
                    onClick={() => setDraftEntry(es.accountId, { ...es, removed: !es.removed })}
                  >
                    {es.removed ? "Restore" : "Remove"}
                  </button>
                </div>
                {es.removed ? (
                  <p className="mt-1 text-sm text-[var(--dim)]">
                    Removed — this account won&rsquo;t be recorded in the
                    snapshot. Its earlier snapshots are untouched.
                  </p>
                ) : es.mode === "split" && splittable ? (
                  <>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      {NW_SPLIT_BUCKETS.map((bucket, i) => (
                        <div key={bucket}>
                          <div className="mb-1 flex items-center gap-1.5">
                            <label
                              htmlFor={`nw-imp-bal-${es.accountId}-${bucketKey(bucket)}`}
                              className="text-sm font-medium text-[var(--text)]"
                            >
                              <span
                                aria-hidden="true"
                                className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle"
                                style={{ background: BUCKET_COLORS[bucket] }}
                              />
                              {bucketLabel(bucket)}
                            </label>
                            <BucketHelp bucket={bucket} align={i % 2 === 0 ? "left" : "right"} />
                          </div>
                          <input
                            id={`nw-imp-bal-${es.accountId}-${bucketKey(bucket)}`}
                            aria-label={`${acct.name} ${bucketLabel(bucket)} amount`}
                            type="text"
                            inputMode="decimal"
                            className={inputCls}
                            value={es.splits[bucket]}
                            onChange={(e) =>
                              setDraftEntry(es.accountId, {
                                ...es,
                                splits: { ...es.splits, [bucket]: e.target.value },
                              })
                            }
                            placeholder="Blank = $0"
                          />
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                      <p className="tnum text-sm text-[var(--dim)]" aria-live="polite">
                        {total != null
                          ? `Balance total: ${fmt(total)} — the bucket amounts are the balance`
                          : "Enter at least one bucket amount, or use one balance"}
                        {es.splitSource === "exact" &&
                          " · Split from the file's bucket rows — exact amounts."}
                        {es.splitSource === "proportional" &&
                          " · Split proposed from the last snapshot's proportions."}
                        {es.splitSource === "mixed" &&
                          " · Bucket amounts from the file; whole-account rows spread by the last split's proportions."}
                        {es.splitSource === "carried" &&
                          " · Split carried from the last snapshot."}
                      </p>
                      <button
                        type="button"
                        aria-label={`Clear split for ${acct.name} and use a single balance`}
                        className="text-sm font-medium text-[var(--accent)] underline underline-offset-2"
                        onClick={() =>
                          setDraftEntry(es.accountId, {
                            ...es,
                            mode: "whole",
                            whole: total != null ? (total / 100).toFixed(2) : es.whole,
                          })
                        }
                      >
                        Clear split — use one balance
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="mt-2">
                    <label htmlFor={`nw-imp-bal-${es.accountId}`} className={labelCls}>
                      Balance
                      {lastBal && es.source !== "file"
                        ? ` — last recorded ${fmt(lastBal.balanceCents)}`
                        : ""}
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        id={`nw-imp-bal-${es.accountId}`}
                        type="text"
                        inputMode="decimal"
                        className={inputCls}
                        value={es.whole}
                        onChange={(e) =>
                          setDraftEntry(es.accountId, { ...es, whole: e.target.value })
                        }
                        placeholder="Blank = not recorded"
                      />
                      {splittable && (
                        <button
                          type="button"
                          aria-label={`Split ${acct.name} into buckets`}
                          className="shrink-0 text-sm font-medium whitespace-nowrap text-[var(--accent)] underline underline-offset-2"
                          onClick={() => setDraftEntry(es.accountId, { ...es, mode: "split" })}
                        >
                          Split into buckets
                        </button>
                      )}
                    </div>
                    {acct.propertyKind === "liability" && (
                      <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">
                        Enter the amount owed as a positive number — it
                        subtracts from net worth when house &amp; mortgage
                        are included.
                      </p>
                    )}
                    {acct.propertyKind === "asset" && (
                      <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">
                        Property asset — it adds to net worth when house &amp;
                        mortgage are included, and never counts in a tax bucket.
                      </p>
                    )}
                    {acct.custodial && (
                      <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">
                        Custodial — not counted. {CUSTODIAL_EXPLAINER}
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={btnPrimary}
              disabled={saveSnapshot.isPending}
              onClick={submitDraft}
            >
              {saveSnapshot.isPending ? "Saving…" : "Save snapshot"}
            </button>
            <button
              type="button"
              className={btnGhost}
              onClick={() => setDraft(null)}
            >
              Back to row matching
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- net worth slice & dice explorer ---------------- */

type NwExplorerGroupBy = "account" | "bucket" | "property";
type NwExplorerColumns = "snapshots" | "month-end" | "quarter-end" | "year-end";

const NW_EXPLORER_GROUP_OPTIONS: {
  value: NwExplorerGroupBy;
  label: string;
  column: string;
}[] = [
  { value: "account", label: "Account", column: "Account" },
  { value: "bucket", label: "Bucket", column: "Bucket" },
  { value: "property", label: "Property vs financial", column: "Group" },
];

const NW_EXPLORER_COLUMN_OPTIONS: {
  value: NwExplorerColumns;
  label: string;
}[] = [
  { value: "snapshots", label: "Snapshots" },
  { value: "month-end", label: "Month-end" },
  { value: "quarter-end", label: "Quarter-end" },
  { value: "year-end", label: "Year-end" },
];

function nwCsvEscape(v: string): string {
  // Formula neutralization first (csvUtil, finding S2): a
  // user-typed account name that starts with = + - @ must
  // reach the spreadsheet as literal text, never a formula.
  const safe = csvFormulaSafeText(v);
  if (/[",\n]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}

function nwCsvMoney(cents: number): string {
  return (cents / 100).toFixed(2);
}

// Period key a snapshot date falls in, for the rollup column modes.
// "snapshots" never reaches here — it uses the date itself as key.
function nwPeriodKey(date: string, mode: NwExplorerColumns): string {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  if (mode === "month-end") return date.slice(0, 7);
  if (mode === "quarter-end") return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
  return y; // year-end
}

function nwPeriodLabel(key: string, mode: NwExplorerColumns): string {
  if (mode === "month-end") {
    const mo = Number(key.slice(5, 7));
    return `${MONTH_SHORT[mo - 1] ?? ""} ${key.slice(0, 4)}`;
  }
  if (mode === "quarter-end") {
    const [y = "", q = ""] = key.split("-");
    return `${q} ${y}`;
  }
  return key; // year-end: the year itself
}

// Every period from the one containing `from` through the one
// containing `to`, inclusive. Bounded so a typed-out-of-range date
// can never spin forever; the caller caps display at 36 anyway.
function nwEnumeratePeriods(
  from: string,
  to: string,
  mode: NwExplorerColumns,
): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  if (mode === "quarter-end") m = Math.floor((m - 1) / 3) * 3 + 1;
  if (mode === "year-end") m = 1;
  const endY = Number(to.slice(0, 4));
  let endM = Number(to.slice(5, 7));
  if (mode === "quarter-end") endM = Math.floor((endM - 1) / 3) * 3 + 1;
  if (mode === "year-end") endM = 1;
  for (let guard = 0; guard < 1200; guard++) {
    if (y > endY || (y === endY && m > endM)) break;
    const probe = `${y}-${String(m).padStart(2, "0")}-01`;
    const key = nwPeriodKey(probe, mode);
    out.push({ key, label: nwPeriodLabel(key, mode) });
    if (mode === "month-end") m += 1;
    else if (mode === "quarter-end") m += 3;
    else y += 1;
    if (mode !== "year-end" && m > 12) {
      m -= 12;
      y += 1;
    }
  }
  return out;
}

function nwLastNonBlank(cells: (number | null)[]): number | null {
  for (let i = cells.length - 1; i >= 0; i--) {
    const v = cells[i];
    if (v != null) return v;
  }
  return null;
}

// $ / % change between the first and last non-blank cells. Null when
// fewer than two values exist to compare; pctFrac is null when the
// first value is $0 (no meaningful percentage).
function nwChangeOf(
  cells: (number | null)[],
): { cents: number; pctFrac: number | null } | null {
  const vals = cells.filter((v): v is number => v != null);
  if (vals.length < 2) return null;
  const first = vals[0] ?? 0;
  const last = vals[vals.length - 1] ?? 0;
  const cents = last - first;
  return { cents, pctFrac: first !== 0 ? cents / first : null };
}

function NwExplorerModal({
  snapshots,
  accounts,
  kindById,
  custodialIds,
  defaultIncludeProperty,
  onClose,
}: {
  snapshots: NwSnapshot[];
  accounts: NwAccount[];
  kindById: Map<number, NwPropertyKind>;
  custodialIds: Set<number>;
  defaultIncludeProperty: boolean;
  onClose: () => void;
}) {
  const earliestDate = snapshots[0]?.date ?? "";
  const latestDate = snapshots[snapshots.length - 1]?.date ?? "";
  const [fromDate, setFromDate] = useState(earliestDate);
  const [toDate, setToDate] = useState(latestDate);
  const [groupBy, setGroupBy] = useState<NwExplorerGroupBy>("account");
  const [columnsMode, setColumnsMode] = useState<NwExplorerColumns>("snapshots");
  // The popup's own include-property switch: seeded from the main
  // view's toggle when the popup opens, independent afterwards.
  const [includeProp, setIncludeProp] = useState(defaultIncludeProperty);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rangeInvalid =
    !/^\d{4}-\d{2}-\d{2}$/.test(fromDate) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(toDate) ||
    fromDate > toDate;

  type NwExplorerColumn = {
    key: string;
    label: string;
    snapshot: NwSnapshot | null;
  };
  type NwExplorerRow = { label: string; cells: (number | null)[] };

  const computed = useMemo(() => {
    if (rangeInvalid) return null;
    const inRange = snapshots.filter(
      (s) => s.date >= fromDate && s.date <= toDate,
    );
    let allColumns: NwExplorerColumn[];
    if (columnsMode === "snapshots") {
      allColumns = inRange.map((s) => ({
        key: s.date,
        label: fmtDateShort(s.date),
        snapshot: s,
      }));
    } else {
      allColumns = nwEnumeratePeriods(fromDate, toDate, columnsMode).map(
        (p) => {
          const inPeriod = inRange.filter(
            (s) => nwPeriodKey(s.date, columnsMode) === p.key,
          );
          return {
            key: p.key,
            label: p.label,
            snapshot: inPeriod[inPeriod.length - 1] ?? null,
          };
        },
      );
    }
    const capped = allColumns.length > 36;
    const columns = allColumns.slice(0, 36);

    const accountCells = (a: NwAccount): (number | null)[] =>
      columns.map((c) => {
        if (!c.snapshot) return null;
        const b = c.snapshot.balances.find((x) => x.accountId === a.id);
        return b ? effectiveBalanceCentsClient(a.propertyKind, b.balanceCents) : null;
      });
    const propertyCells = (): (number | null)[] =>
      columns.map((c) =>
        c.snapshot ? propertyNetForSnapshot(c.snapshot, kindById) : null,
      );

    let rows: NwExplorerRow[] = [];
    if (groupBy === "account") {
      rows = accounts
        // Custodial accounts are never part of any total or
        // calculation, so they do not appear in the explorer.
        .filter((a) => !a.custodial && (includeProp || a.propertyKind === "none"))
        .map((a) => ({
          label: a.archived ? `${a.name} (archived)` : a.name,
          cells: accountCells(a),
        }))
        .filter((r) => r.cells.some((v) => v != null));
      rows.sort(
        (x, y) =>
          (nwLastNonBlank(y.cells) ?? Number.NEGATIVE_INFINITY) -
          (nwLastNonBlank(x.cells) ?? Number.NEGATIVE_INFINITY),
      );
    } else if (groupBy === "bucket") {
      for (const bucket of NW_BUCKETS) {
        const cells = columns.map((c) =>
          c.snapshot ? bucketTotalForSnapshot(c.snapshot, bucket, kindById, custodialIds) : null,
        );
        if (cells.some((v) => v != null)) rows.push({ label: bucketLabel(bucket), cells });
      }
      if (includeProp) {
        const cells = propertyCells();
        if (cells.some((v) => v != null)) rows.push({ label: "Property", cells });
      }
    } else {
      const financialCells = columns.map((c) => {
        if (!c.snapshot) return null;
        let sum = 0;
        let has = false;
        for (const b of c.snapshot.balances) {
          if (custodialIds.has(b.accountId)) {
            continue;
          }
          if (
            isPropertyKindClient(propertyKindOfAccount(kindById, b.accountId))
          ) {
            continue;
          }
          sum += b.balanceCents;
          has = true;
        }
        return has ? sum : null;
      });
      if (financialCells.some((v) => v != null)) {
        rows.push({ label: "Financial", cells: financialCells });
      }
      if (includeProp) {
        const cells = propertyCells();
        if (cells.some((v) => v != null)) rows.push({ label: "Property", cells });
      }
    }

    // Grand total per column: the snapshot's included balances,
    // signed the same way the main view signs them — so with
    // property excluded the Oct 5, 2026 column reads exactly the
    // main view's $5,364,163.35.
    const totals: (number | null)[] = columns.map((c) => {
      if (!c.snapshot) return null;
      let sum = 0;
      let has = false;
      for (const b of c.snapshot.balances) {
        if (custodialIds.has(b.accountId)) continue;
        const kind = propertyKindOfAccount(kindById, b.accountId);
        if (!includeProp && isPropertyKindClient(kind)) continue;
        sum += effectiveBalanceCentsClient(kind, b.balanceCents);
        has = true;
      }
      return has ? sum : null;
    });

    return { columns, rows, totals, capped, totalColumns: allColumns.length, inRangeCount: inRange.length };
  }, [
    snapshots,
    accounts,
    kindById,
    custodialIds,
    fromDate,
    toDate,
    groupBy,
    columnsMode,
    includeProp,
    rangeInvalid,
  ]);

  const groupColumnLabel =
    NW_EXPLORER_GROUP_OPTIONS.find((o) => o.value === groupBy)?.column ?? "Group";

  function downloadCsv() {
    if (!computed) return;
    const lines: string[] = [];
    lines.push(
      [groupColumnLabel, ...computed.columns.map((c) => c.label), "$ change", "% change"]
        .map(nwCsvEscape)
        .join(","),
    );
    const rowLine = (label: string, cells: (number | null)[]): string => {
      const ch = nwChangeOf(cells);
      return [
        label,
        ...cells.map((v) => (v == null ? "" : nwCsvMoney(v))),
        ch ? nwCsvMoney(ch.cents) : "",
        ch && ch.pctFrac != null ? `${(ch.pctFrac * 100).toFixed(2)}%` : "",
      ]
        .map(nwCsvEscape)
        .join(",");
    };
    for (const r of computed.rows) lines.push(rowLine(r.label, r.cells));
    lines.push(rowLine("Grand total", computed.totals));
    const blob = new Blob([lines.join("\n") + "\n"], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `net-worth-explorer-${fromDate}-to-${toDate}-by-${groupBy}-${columnsMode}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function changeCells(cells: (number | null)[]) {
    const ch = nwChangeOf(cells);
    if (!ch) {
      return (
        <>
          <td className="py-2 pr-3 text-right whitespace-nowrap text-[var(--dim)]">—</td>
          <td className="py-2 text-right whitespace-nowrap text-[var(--dim)]">—</td>
        </>
      );
    }
    const tone =
      ch.cents > 0 ? POS_COLOR : ch.cents < 0 ? NEG_COLOR : undefined;
    return (
      <>
        <td className="py-2 pr-3 text-right whitespace-nowrap" style={{ color: tone }}>
          {fmtSigned(ch.cents)}
        </td>
        <td className="py-2 text-right whitespace-nowrap" style={{ color: tone }}>
          {ch.pctFrac != null ? fmtPct(ch.pctFrac) : "—"}
        </td>
      </>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Slice & dice — Net Worth"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-t-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-xl sm:rounded-[var(--radius)]">
        <div className="flex items-start justify-between gap-3 border-b border-[var(--border)] p-4 sm:p-5">
          <div>
            <h2 className="display text-xl font-semibold">Slice &amp; dice — Net Worth</h2>
            <Explainer
              id="networth.sliceDice"
              label="Slice & dice — Net Worth"
              className="mt-0.5"
              summary="Balances by snapshot over any date range — the first 36 snapshots or periods are shown; read-only: nothing here changes your data."
            >
              <p>
                Balances by snapshot over any date range, using the same figures
                as the Net Worth view. Rollup columns (month-end, quarter-end,
                year-end) show the last snapshot inside each period; a period
                with no snapshot stays blank. $ change and % change compare the
                first and last values shown. Read-only: nothing here
                changes your data.
              </p>
            </Explainer>
          </div>
          <button
            type="button"
            aria-label="Close Slice & dice — Net Worth"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--border)] text-lg text-[var(--text)]"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="border-b border-[var(--border)] p-4 sm:p-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div>
              <label htmlFor="nw-ex-from" className={labelCls}>From date</label>
              <input
                id="nw-ex-from"
                type="date"
                className={inputCls}
                min={earliestDate}
                max={latestDate}
                value={fromDate}
                onChange={(e) => {
                  if (e.target.value) setFromDate(e.target.value);
                }}
              />
            </div>
            <div>
              <label htmlFor="nw-ex-to" className={labelCls}>To date</label>
              <input
                id="nw-ex-to"
                type="date"
                className={inputCls}
                min={earliestDate}
                max={latestDate}
                value={toDate}
                onChange={(e) => {
                  if (e.target.value) setToDate(e.target.value);
                }}
              />
            </div>
            <div>
              <label htmlFor="nw-ex-groupby" className={labelCls}>Group by</label>
              <select
                id="nw-ex-groupby"
                className={inputCls}
                value={groupBy}
                onChange={(e) => setGroupBy(e.target.value as NwExplorerGroupBy)}
              >
                {NW_EXPLORER_GROUP_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="nw-ex-columns" className={labelCls}>Columns</label>
              <select
                id="nw-ex-columns"
                className={inputCls}
                value={columnsMode}
                onChange={(e) => setColumnsMode(e.target.value as NwExplorerColumns)}
              >
                {NW_EXPLORER_COLUMN_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <label
              htmlFor="nw-ex-include-property"
              className="flex cursor-pointer items-center gap-2.5 text-sm font-medium text-[var(--text)]"
            >
              <input
                id="nw-ex-include-property"
                type="checkbox"
                role="switch"
                aria-label="Include house & mortgage in Slice & dice"
                className="h-5 w-5 shrink-0 accent-[var(--accent)]"
                checked={includeProp}
                onChange={(e) => setIncludeProp(e.target.checked)}
              />
              Include house &amp; mortgage
              <span className="font-normal text-[var(--dim)]">
                (this popup only — the main view&rsquo;s switch is untouched)
              </span>
            </label>
            <button
              type="button"
              className={btnPrimary}
              disabled={!computed || computed.rows.length === 0}
              onClick={downloadCsv}
            >
              Download CSV
            </button>
          </div>
          {rangeInvalid && (
            <p className="mt-2 text-sm text-[var(--bad)]">
              From date must be on or before To date.
            </p>
          )}
          {computed?.capped && (
            <p className="mt-2 text-sm text-[var(--dim)]">
              Range has {computed.totalColumns} columns — showing the first 36 only.
            </p>
          )}
        </div>

        <div className="overflow-auto p-4 sm:p-5">
          {!rangeInvalid && computed && computed.inRangeCount === 0 && (
            <p className="rounded-[var(--radius)] border border-dashed border-[var(--border)] p-4 text-sm text-[var(--dim)]">
              No snapshots in this range.
            </p>
          )}
          {!rangeInvalid && computed && computed.inRangeCount > 0 && computed.rows.length === 0 && (
            <p className="rounded-[var(--radius)] border border-dashed border-[var(--border)] p-4 text-sm text-[var(--dim)]">
              No balances recorded in this range.
            </p>
          )}
          {!rangeInvalid && computed && computed.rows.length > 0 && (
            <div className="overflow-x-auto">
              <table
                className="tnum w-full border-collapse text-sm"
                style={{
                  minWidth: `${Math.max(560, 170 + computed.columns.length * 108 + 190)}px`,
                }}
              >
                <caption className="sr-only">
                  Net worth grouped by {groupColumnLabel}, by{" "}
                  {columnsMode === "snapshots" ? "snapshot" : columnsMode}
                </caption>
                <thead>
                  <tr className="border-b border-[var(--border)] text-left">
                    <th scope="col" className="py-2 pr-3 font-semibold">{groupColumnLabel}</th>
                    {computed.columns.map((c) => (
                      <th
                        key={c.key}
                        scope="col"
                        className="py-2 pr-3 text-right font-semibold whitespace-nowrap"
                        title={c.snapshot ? fmtDateLong(c.snapshot.date) : "No snapshot in this period"}
                      >
                        {c.label}
                      </th>
                    ))}
                    <th scope="col" className="py-2 pr-3 text-right font-semibold whitespace-nowrap">$ change</th>
                    <th scope="col" className="py-2 text-right font-semibold whitespace-nowrap">% change</th>
                  </tr>
                </thead>
                <tbody>
                  {computed.rows.map((r) => (
                    <tr key={r.label} className="border-b border-[var(--border)]">
                      <th scope="row" className="py-2 pr-3 text-left font-medium whitespace-nowrap">
                        {r.label}
                      </th>
                      {r.cells.map((v, i) => (
                        <td
                          key={i}
                          className={`py-2 pr-3 text-right whitespace-nowrap ${v == null ? "text-[var(--dim)]" : ""}`}
                        >
                          {v == null ? "—" : fmt(v)}
                        </td>
                      ))}
                      {changeCells(r.cells)}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="font-semibold">
                    <th scope="row" className="py-2 pr-3 text-left">Grand total</th>
                    {computed.totals.map((v, i) => (
                      <td
                        key={i}
                        className={`py-2 pr-3 text-right whitespace-nowrap ${v == null ? "font-normal text-[var(--dim)]" : ""}`}
                      >
                        {v == null ? "—" : fmt(v)}
                      </td>
                    ))}
                    {changeCells(computed.totals)}
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------- main view ---------------- */

type ChangePeriod = "last" | "ytd" | "all";

export function NetWorthView() {
  const queryClient = useQueryClient();
  const nw = useQuery({
    queryKey: ["networth"],
    queryFn: () => api.getNetWorth({}),
  });
  const data = nw.data;

  const [chartMode, setChartMode] = useState<"total" | "accounts" | "buckets" | "share">("accounts");
  const [growthOn, setGrowthOn] = useState(false);
  // The Growth chart's "Change since" baseline: a snapshot date
  // picked in the chart header, persisted server-side
  // (nw_growth_since via setNwGrowthSince). Initialized once
  // from the stored value when it names an existing snapshot;
  // null = no pick, and growth baselines at the first snapshot.
  const [growthSinceDate, setGrowthSinceDate] = useState<string | null>(null);
  const [growthSinceInit, setGrowthSinceInit] = useState(false);
  useEffect(() => {
    if (!data || growthSinceInit) return;
    const stored = data.growthSinceDate;
    setGrowthSinceDate(
      stored != null && data.snapshots.some((s) => s.date === stored)
        ? stored
        : null,
    );
    setGrowthSinceInit(true);
  }, [data, growthSinceInit]);
  const [highlightId, setHighlightId] = useState<number | null>(null);
  const [period, setPeriod] = useState<ChangePeriod>("last");
  const [editorSnapshot, setEditorSnapshot] = useState<NwSnapshot | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [balanceEdit, setBalanceEdit] = useState<{
    account: NwAccount;
    snapshot: NwSnapshot;
  } | null>(null);
  const [showNwExplorer, setShowNwExplorer] = useState(false);
  /* The balance-import panel's open/closed state persists in
     the generic fold store, so it comes back as left. */
  const [showNwImport, setShowNwImport] = usePersistedFold("nw.import");
  const [showAccountForm, setShowAccountForm] = useState(false);
  const [newAccountName, setNewAccountName] = useState("");
  const [newAccountType, setNewAccountType] =
    useState<NwAccountType>("none");
  const [accountError, setAccountError] = useState("");
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renameType, setRenameType] =
    useState<NwAccountType>("none");
  const [renameError, setRenameError] = useState("");
  const [confirmDeleteAllBackups, setConfirmDeleteAllBackups] =
    useState(false);
  const [confirmDeleteAccountId, setConfirmDeleteAccountId] =
    useState<number | null>(null);
  const [deleteAccountError, setDeleteAccountError] = useState("");
  const [backupError, setBackupError] = useState("");
  const [backupNotice, setBackupNotice] = useState("");
  const [editingTarget, setEditingTarget] = useState(false);
  const [targetInput, setTargetInput] = useState("");
  const [targetError, setTargetError] = useState("");

  const backupsQuery = useQuery({
    queryKey: ["backups"],
    queryFn: () => api.listBackups({}),
  });
  const invalidateBackups = () =>
    queryClient.invalidateQueries({ queryKey: ["backups"] });
  const deleteBackup = useMutation({
    mutationFn: (filename: string) => api.deleteBackup({ filename }),
    onSuccess: (r) => {
      if (!r.ok) {
        setBackupError(r.reason);
        return;
      }
      setBackupError("");
      // Show the server's confirmation ("Deleted <name>.") — a
      // delete that silently clears feedback reads as "nothing
      // happened" when the row's disappearance is missed.
      setBackupNotice(r.reason);
      invalidateBackups();
    },
    onError: (e) => setBackupError(String(e)),
  });
  const deleteAllBackups = useMutation({
    mutationFn: () => api.deleteAllBackups({}),
    onSuccess: (r) => {
      if (!r.ok) {
        setBackupError(r.reason);
        return;
      }
      setBackupError("");
      setBackupNotice(r.reason);
      setConfirmDeleteAllBackups(false);
      invalidateBackups();
    },
    onError: (e) => setBackupError(String(e)),
  });
  const createBackup = useMutation({
    mutationFn: () => api.createBackupNow({}),
    onMutate: () => {
      setBackupError("");
      setBackupNotice("");
    },
    onSuccess: (r) => {
      if (!r.ok) {
        setBackupError(r.reason);
        return;
      }
      setBackupError("");
      setBackupNotice(r.reason);
      invalidateBackups();
    },
    onError: (e) => setBackupError(`Backup failed: ${String(e)}`),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["networth"] });

  const seed = useMutation({
    mutationFn: () => api.seedNetWorth({}),
    onSuccess: invalidate,
  });
  const addAccount = useMutation({
    mutationFn: (input: { name: string; type: NwAccountType }) =>
      api.addNwAccount({
        name: input.name,
        propertyKind: input.type === "custodial" ? "none" : input.type,
        custodial: input.type === "custodial",
      }),
    onSuccess: (r) => {
      if (!r.ok) {
        setAccountError(r.reason);
        return;
      }
      setAccountError("");
      setNewAccountName("");
      setNewAccountType("none");
      setShowAccountForm(false);
      invalidate();
    },
    onError: (e) => setAccountError(String(e)),
  });
  const renameAccount = useMutation({
    mutationFn: (input: {
      id: number;
      name: string;
      type: NwAccountType;
      // Contract v65 (F19): the account's fields as loaded when
      // the rename row opened — the save's CAS base; a refusal
      // surfaces through setRenameError below.
      base: {
        name: string;
        propertyKind: "none" | "asset" | "liability";
        custodial: boolean;
      };
    }) =>
      api.renameNwAccount({
        id: input.id,
        name: input.name,
        propertyKind: input.type === "custodial" ? "none" : input.type,
        custodial: input.type === "custodial",
        base: input.base,
      }),
    onSuccess: (r) => {
      if (!r.ok) {
        setRenameError(r.reason);
        return;
      }
      setRenameError("");
      setRenamingId(null);
      invalidate();
    },
    onError: (e) => setRenameError(String(e)),
  });
  const setIncludeProperty = useMutation({
    mutationFn: (include: boolean) => api.setNwIncludeProperty({ include }),
    onSuccess: invalidate,
  });
  const setNwTarget = useMutation({
    mutationFn: (targetCents: number | null) => api.setNwTarget({ targetCents }),
    onSuccess: () => {
      setEditingTarget(false);
      setTargetError("");
      invalidate();
    },
    onError: (e) => setTargetError(String(e)),
  });
  const setAccountsCollapsed = useMutation({
    mutationFn: (collapsed: boolean) => api.setNwAccountsCollapsed({ collapsed }),
    onSuccess: invalidate,
  });
  const setHistoryCollapsed = useMutation({
    mutationFn: (collapsed: boolean) => api.setNwHistoryCollapsed({ collapsed }),
    onSuccess: invalidate,
  });
  const setNwGrowthSince = useMutation({
    mutationFn: (date: string | null) => api.setNwGrowthSince({ date }),
    onSuccess: invalidate,
  });
  const setArchived = useMutation({
    mutationFn: (input: { id: number; archived: boolean }) =>
      api.setNwAccountArchived(input),
    onSuccess: invalidate,
  });
  const deleteAccount = useMutation({
    mutationFn: (id: number) => api.deleteNwAccount({ id }),
    onSuccess: (r) => {
      if (!r.ok) {
        setDeleteAccountError(r.reason);
        return;
      }
      setDeleteAccountError("");
      setConfirmDeleteAccountId(null);
      invalidate();
    },
    onError: (e) => setDeleteAccountError(String(e)),
  });

  const model = useMemo(() => {
    if (!data) return null;
    const snapshots = data.snapshots;
    const accounts = data.accounts;
    const seriesByAccount = new Map<number, SeriesPoint[]>();
    for (const a of accounts) seriesByAccount.set(a.id, buildSeries(snapshots, a.id));
    const latest = snapshots[snapshots.length - 1] ?? null;
    const prev = snapshots.length >= 2 ? snapshots[snapshots.length - 2] ?? null : null;
    const first = snapshots[0] ?? null;
    // YTD baseline: the last snapshot before Jan 1 of the latest
    // snapshot's year; falls back to the first snapshot.
    let ytdBaseline: NwSnapshot | null = null;
    if (latest) {
      const jan1 = `${latest.date.slice(0, 4)}-01-01`;
      for (const s of snapshots) if (s.date < jan1) ytdBaseline = s;
      if (!ytdBaseline) ytdBaseline = first;
    }
    const kindById = new Map<number, NwPropertyKind>(
      accounts.map((a) => [a.id, a.propertyKind] as [number, NwPropertyKind]),
    );
    const custodialIds = new Set<number>(
      accounts.filter((a) => a.custodial).map((a) => a.id),
    );
    return {
      snapshots,
      accounts,
      seriesByAccount,
      latest,
      prev,
      first,
      ytdBaseline,
      kindById,
      custodialIds,
      includeProperty: data.includeProperty,
      accountsCollapsed: data.accountsCollapsed,
      historyCollapsed: data.historyCollapsed,
    };
  }, [data]);

  if (nw.isPending) {
    return <p className="py-10 text-center text-[var(--dim)]">Loading net worth…</p>;
  }
  if (nw.error || !data || !model) {
    return (
      <p className="py-10 text-center text-[var(--bad)]">
        Something went wrong loading net worth. Try again.
      </p>
    );
  }

  const {
    snapshots,
    accounts,
    seriesByAccount,
    latest,
    prev,
    first,
    ytdBaseline,
    kindById,
    custodialIds,
    includeProperty,
    accountsCollapsed,
    historyCollapsed,
  } = model;
  const activeAccounts = accounts.filter((a) => !a.archived);
  const latestPropertyNet = latest
    ? propertyNetForSnapshot(latest, kindById)
    : null;
  // Property accounts with no balance recorded in ANY snapshot. For
  // these the include toggle can have no visible effect — there is
  // nothing to include — so the toggle card says so and offers the
  // fix (record a value) instead of silently doing nothing.
  const propertyAccountsWithoutValue = accounts.filter(
    (a) =>
      a.propertyKind !== "none" &&
      (seriesByAccount.get(a.id) ?? []).length === 0,
  );

  function openAddSnapshot() {
    setEditorSnapshot(null);
    setEditorOpen(true);
  }
  function openEditSnapshot(s: NwSnapshot) {
    setEditorSnapshot(s);
    setEditorOpen(true);
  }

  /* ----- empty state ----- */
  if (snapshots.length === 0 || accounts.length === 0) {
    return (
      <section className="mt-5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6">
        <h2 className="display text-2xl font-semibold">Net Worth</h2>
        <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
          Track net worth the spreadsheet way: record a snapshot whenever you
          check your accounts — one balance per account — and the totals,
          changes, and charts build themselves from those records.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className={btnPrimary}
            disabled={seed.isPending}
            onClick={() => seed.mutate()}
          >
            {seed.isPending ? "Loading…" : "Load the sample history"}
          </button>
          <button type="button" className={btnGhost} onClick={() => setShowAccountForm(true)}>
            Add an account
          </button>
          {accounts.length > 0 && (
            <button
              type="button"
              className={btnGhost}
              aria-expanded={showNwImport}
              onClick={() => setShowNwImport(!showNwImport)}
            >
              Import balances
            </button>
          )}
        </div>
        {showNwImport && accounts.length > 0 && (
          <NwImportPanel
            accounts={accounts.filter((a) => !a.archived)}
            snapshots={snapshots}
            includeProperty={data.includeProperty}
            onSaved={invalidate}
            onClose={() => setShowNwImport(false)}
          />
        )}
        {showAccountForm && (
          <form
            className="mt-4 flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (newAccountName.trim())
                addAccount.mutate({
                  name: newAccountName.trim(),
                  type: newAccountType,
                });
            }}
          >
            <div className="min-w-52 flex-1">
              <label htmlFor="nw-new-account-empty" className={labelCls}>Account name</label>
              <input
                id="nw-new-account-empty"
                type="text"
                className={inputCls}
                value={newAccountName}
                onChange={(e) => setNewAccountName(e.target.value)}
                placeholder="e.g. Fidelity"
              />
            </div>
            <div className="min-w-52 flex-1">
              <label htmlFor="nw-new-account-type-empty" className={labelCls}>Account type</label>
              <select
                id="nw-new-account-type-empty"
                className={inputCls}
                value={newAccountType}
                onChange={(e) =>
                  setNewAccountType(e.target.value as NwAccountType)
                }
              >
                <option value="none">Not property</option>
                <option value="asset">Property asset (e.g. house)</option>
                <option value="liability">Property liability (e.g. mortgage)</option>
                <option value="custodial">Custodial — not counted</option>
              </select>
            </div>
            <button type="submit" className={btnPrimary} disabled={addAccount.isPending}>
              Add account
            </button>
            {newAccountType === "custodial" && (
              <p className="w-full text-xs text-[var(--dim)]">
                {CUSTODIAL_EXPLAINER}
              </p>
            )}
          </form>
        )}
        {accountError && <p className="mt-2 text-sm text-[var(--bad)]">{accountError}</p>}
      </section>
    );
  }

  /* ----- KPIs ----- */
  const latestTotal = latest?.totalCents ?? 0;
  const sinceLastCents = prev ? latestTotal - prev.totalCents : 0;
  const sinceLastPct = prev && prev.totalCents !== 0 ? sinceLastCents / prev.totalCents : 0;
  const ytdCents = ytdBaseline ? latestTotal - ytdBaseline.totalCents : 0;
  const ytdPct =
    ytdBaseline && ytdBaseline.totalCents !== 0 ? ytdCents / ytdBaseline.totalCents : 0;
  // Combined stat strip values — same dashboard figures as the
  // former three KPI cards, no recomputation changes. The latest
  // snapshot date is shown only in the strip (the page header no
  // longer repeats it).
  const sinceLastToneCls =
    sinceLastCents > 0
      ? "text-[var(--accent)]"
      : sinceLastCents < 0
        ? "text-[var(--bad)]"
        : "";
  const ytdToneCls =
    ytdCents > 0 ? "text-[var(--accent)]" : ytdCents < 0 ? "text-[var(--bad)]" : "";

  /* ----- net worth target (follows the include-property toggle
     because every snapshot totalCents already does) ----- */
  const targetCents = data.targetCents ?? null;
  const targetProgressFrac =
    targetCents != null && targetCents > 0 ? latestTotal / targetCents : null;
  const targetRemainingCents =
    targetCents != null ? Math.max(targetCents - latestTotal, 0) : null;
  const targetEtaLabel: string = (() => {
    if (targetCents == null || !latest) return "—";
    if (targetRemainingCents === 0) return "Reached";
    if (targetRemainingCents == null) return "—";
    // Trailing 12 months from the latest snapshot date.
    const latestTs = tsOf(latest.date);
    const windowStartTs = latestTs - 365 * 86_400_000;
    const inWindow = snapshots.filter((s) => tsOf(s.date) >= windowStartTs);
    if (inWindow.length < 2) return "—";
    const firstInWindow = inWindow[0];
    if (!firstInWindow) return "—";
    const days =
      (latestTs - tsOf(firstInWindow.date)) / 86_400_000;
    if (days <= 0) return "—";
    const changeCents = latestTotal - firstInWindow.totalCents;
    if (changeCents <= 0) return "—";
    const annualizedCents = changeCents / (days / 365.25);
    if (annualizedCents <= 0) return "—";
    const yearsNeeded = targetRemainingCents / annualizedCents;
    if (!Number.isFinite(yearsNeeded) || yearsNeeded < 0) return "—";
    const etaTs = latestTs + yearsNeeded * 365.25 * 86_400_000;
    const eta = new Date(etaTs);
    const etaMonth = MONTH_SHORT[eta.getUTCMonth()] ?? "";
    return `${etaMonth} ${eta.getUTCFullYear()}`;
  })();

  /* ----- current bucket mix (latest snapshot only) -----
     One bar segment per POSITIVE bucket, largest first, fed by
     the same bucket subtotals the History grid shows for the
     latest snapshot (bucketTotalForSnapshot: property accounts
     are always outside the buckets, custodial accounts never
     count). Bar shares are of the positive segments' own sum,
     so they always add to 100%. The section HEADLINE and the
     "% of target" figure, however, use the SIGNED sum of every
     bucket (contract v63, F1): a negative bucket (a split part
     can be negative) is real money owed against the others, so
     it must reduce the headline even though it cannot draw as
     a bar segment — negative buckets render as their own lines
     under the bar instead, so the displayed parts (positive
     legend amounts plus the negative lines) foot exactly to
     the headline. With every bucket positive the two sums are
     equal and the section renders exactly as before. When
     property is included and has a balance, the mix covers
     only the bucketed part of net worth, and the section says
     so (see below). */
  const bucketEntries: { bucket: NwBucket; cents: number }[] = latest
    ? NW_BUCKETS.map((bucket) => ({
        bucket,
        cents: bucketTotalForSnapshot(latest, bucket, kindById, custodialIds) ?? 0,
      })).filter((s) => s.cents !== 0)
    : [];
  const bucketMix: { bucket: NwBucket; cents: number }[] = bucketEntries
    .filter((s) => s.cents > 0)
    .sort((a, b) => b.cents - a.cents);
  const bucketNegative: { bucket: NwBucket; cents: number }[] = bucketEntries
    .filter((s) => s.cents < 0)
    .sort((a, b) => Math.abs(b.cents) - Math.abs(a.cents));
  // The bar's own total (positive segments only — the bar
  // denominator) and the headline's signed total.
  const bucketMixTotal = bucketMix.reduce((sum, s) => sum + s.cents, 0);
  const bucketSignedTotal = bucketEntries.reduce((sum, s) => sum + s.cents, 0);
  // Property included in the totals with a nonzero net: the one
  // case where the mix's total and the headline total differ.
  const bucketMixPropertyNet =
    includeProperty && latestPropertyNet != null && latestPropertyNet !== 0
      ? latestPropertyNet
      : null;

  /* ----- main chart data (true time axis) ----- */
  type MainPoint = {
    ts: number;
    date: string;
    total: number;
    [key: string]: number | string | null;
  };
  const mainData: MainPoint[] = snapshots.map((s) => {
    const p: MainPoint = { ts: tsOf(s.date), date: s.date, total: s.totalCents / 100 };
    for (const a of accounts) {
      const b = s.balances.find((x) => x.accountId === a.id);
      const kind = a.propertyKind;
      if (a.custodial || (isPropertyKindClient(kind) && !includeProperty)) {
        // Custodial accounts are excluded from every chart, always;
        // property accounts are excluded while the toggle is off.
        p[`a${a.id}`] = null;
      } else {
        // No balance recorded in this snapshot = a gap (null) in
        // every chart mode, By account included — never a drop to
        // $0, which would read as the account being emptied.
        p[`a${a.id}`] = b
          ? effectiveBalanceCentsClient(kind, b.balanceCents) / 100
          : null;
      }
      // Share mode: this account's percentage (0–100) of the
      // snapshot total. The snapshot total already follows the
      // include-property toggle (property counts only when it is
      // on), and a property account excluded by the toggle — like
      // any unrecorded balance — contributes a 0 share, so the
      // stack follows exactly the same rule as By account.
      p[`s${a.id}`] =
        a.custodial || (isPropertyKindClient(kind) && !includeProperty)
          ? 0
          : b && s.totalCents !== 0
            ? (effectiveBalanceCentsClient(kind, b.balanceCents) /
                s.totalCents) *
              100
            : 0;
    }
    for (const bucket of NW_BUCKETS) {
      const total = bucketTotalForSnapshot(s, bucket, kindById, custodialIds);
      p[bucketKey(bucket)] = total != null ? total / 100 : 0;
    }
    const propNet = propertyNetForSnapshot(s, kindById);
    p[PROPERTY_KEY] =
      includeProperty && propNet != null ? propNet / 100 : 0;
    return p;
  });
  // Growth baseline: the snapshot the "Change since" control
  // picked (growthSinceDate, when it names a snapshot), else the
  // first snapshot. mainData spans all snapshots in the same
  // order, so the baseline's chart point is at the same index.
  const growthBaselineSnap =
    (growthSinceDate != null
      ? snapshots.find((s) => s.date === growthSinceDate)
      : undefined) ?? first;
  const growthBaselineIdx = growthBaselineSnap
    ? snapshots.findIndex((s) => s.id === growthBaselineSnap.id)
    : -1;
  // Growth transform: a pure transform of the level series plotted
  // above — each series' growth at a snapshot is its level there
  // minus its level at the baseline snapshot (the "Change since"
  // pick, or the FIRST snapshot when none is picked). A null
  // level (account gap / excluded) stays null, so an excluded
  // series never gains phantom growth; a series absent at the
  // baseline counts from $0, so its full later balance shows as
  // growth. Bucket and Property levels are numeric (0-filled),
  // so their growth is always numeric. Keys: gTotal, ga{id},
  // g<bucketKey>.
  const growthKeyOf = (levelKey: string): string =>
    levelKey === "total" ? "gTotal" : `g${levelKey}`;
  {
    const baselinePoint =
      growthBaselineIdx >= 0 ? mainData[growthBaselineIdx] : undefined;
    if (baselinePoint) {
      const levelKeys: string[] = [
        "total",
        ...accounts.map((a) => `a${a.id}`),
        ...NW_BUCKETS.map((bucket) => bucketKey(bucket)),
        PROPERTY_KEY,
      ];
      for (const key of levelKeys) {
        const baseline = baselinePoint[key];
        const gKey = growthKeyOf(key);
        for (const p of mainData) {
          const v = p[key];
          p[gKey] =
            typeof v === "number"
              ? v - (typeof baseline === "number" ? baseline : 0)
              : null;
        }
      }
    }
  }
  // Growth applies to every mode except Share (a percentage view).
  const growthActive = growthOn && chartMode !== "share";
  /* ----- headline annotation (every mode) -----
     Computed from the plotted total series — the snapshots'
     totalCents, which already follow the include-property toggle,
     so the annotation follows the toggle automatically. First and
     last totals are rounded to whole dollars (the displayed
     figures); the change is last − first in whole dollars and the
     percent is that change over the first displayed total. A
     single snapshot, or a first displayed total of $0, shows the
     signed change with no percent. While growth is active the
     "first" here is the growth baseline (the "Change since"
     pick) instead of the first snapshot; with growth off the
     annotation is the first snapshot's, as always. */
  const annotation: { text: string; tone: number } | null = (() => {
    const firstSnap = snapshots[0];
    const lastSnap = snapshots[snapshots.length - 1];
    if (!firstSnap || !lastSnap) return null;
    const baseSnap =
      growthActive && growthBaselineSnap ? growthBaselineSnap : firstSnap;
    const firstDollars = Math.round(baseSnap.totalCents / 100);
    const lastDollars = Math.round(lastSnap.totalCents / 100);
    const changeDollars = lastDollars - firstDollars;
    const since = fmtMonthYear(baseSnap.date);
    const signed = fmtWholeDollarSigned(changeDollars);
    if (snapshots.length < 2 || firstDollars === 0) {
      return { text: `${signed} since ${since}`, tone: changeDollars };
    }
    const pct = (changeDollars / firstDollars) * 100;
    const pctStr = `${pct < 0 ? "−" : "+"}${Math.abs(pct).toFixed(1)}%`;
    return {
      text: `${signed} · ${pctStr} since ${since}`,
      tone: changeDollars,
    };
  })();
  const chartAccounts = accounts.filter((a) => {
    if (a.custodial) return false;
    if (isPropertyKindClient(a.propertyKind) && !includeProperty) return false;
    const series = seriesByAccount.get(a.id) ?? [];
    if (series.length === 0) return false;
    // Drop series that are $0 in every snapshot (e.g. the archived
    // HSA): they add a flat invisible band and a dead legend entry
    // to the stacked charts (By account and Share alike).
    return series.some((p) => p.cents !== 0);
  });
  const chartBuckets: (NwBucket | "Property")[] = [
    ...NW_BUCKETS.filter((bucket) =>
      snapshots.some((s) => bucketTotalForSnapshot(s, bucket, kindById, custodialIds) != null),
    ),
    ...(includeProperty &&
    snapshots.some((s) => propertyNetForSnapshot(s, kindById) != null)
      ? (["Property"] as const)
      : []),
  ];
  const firstTs = mainData[0]?.ts ?? 0;
  const lastTs = mainData[mainData.length - 1]?.ts ?? 0;
  const dayMs = 86_400_000;
  const xDomain: [number, number] = [
    firstTs - Math.max(dayMs * 3, (lastTs - firstTs) * 0.02),
    lastTs + Math.max(dayMs * 3, (lastTs - firstTs) * 0.02),
  ];
  const highlightedAccount =
    highlightId != null ? accounts.find((a) => a.id === highlightId) ?? null : null;

  /* ----- allocation (latest snapshot, active accounts) ----- */
  const allocRows = activeAccounts
    .filter((a) => !a.custodial && (includeProperty || a.propertyKind === "none"))
    .map((a) => {
      const b = latest?.balances.find((x) => x.accountId === a.id);
      return {
        account: a,
        cents: b
          ? effectiveBalanceCentsClient(a.propertyKind, b.balanceCents)
          : null,
      };
    })
    .filter((r): r is { account: NwAccount; cents: number } => r.cents != null)
    .sort((x, y) => y.cents - x.cents);
  const allocTotal = allocRows.reduce((s, r) => s + r.cents, 0);
  const allocMax = Math.max(0, ...allocRows.map((r) => r.cents));

  /* ----- what changed ----- */
  const periodBaseline: NwSnapshot | null =
    period === "last" ? prev : period === "ytd" ? ytdBaseline : first;
  // Per-account change between the baseline snapshot and the latest
  // snapshot, from the balances those two snapshots themselves
  // recorded — an account with no balance in a snapshot counts as $0
  // there, exactly as that snapshot's total counts it and exactly as
  // the Year Summary movers count it. The rows therefore always sum
  // to the period's total change (latest total − baseline total).
  // Carrying the last known value forward instead (valueAtOrBefore)
  // broke that: a snapshot that recorded only one account showed
  // every other account as "unchanged" and a Net of that one
  // account's change, while the KPI for the same period showed the
  // full drop in the snapshot total.
  const changeRows = accounts
    .filter((a) => !a.custodial && (includeProperty || a.propertyKind === "none"))
    .map((a) => {
      if (!periodBaseline || !latest) return null;
      const startB = periodBaseline.balances.find((x) => x.accountId === a.id);
      const endB = latest.balances.find((x) => x.accountId === a.id);
      if (!startB && !endB) return null;
      const start = startB
        ? effectiveBalanceCentsClient(a.propertyKind, startB.balanceCents)
        : 0;
      const end = endB
        ? effectiveBalanceCentsClient(a.propertyKind, endB.balanceCents)
        : 0;
      return { account: a, change: end - start };
    })
    .filter((r): r is { account: NwAccount; change: number } => r != null)
    .sort((x, y) => y.change - x.change);
  const changeNet = changeRows.reduce((s, r) => s + r.change, 0);
  // Zero-change accounts are dropped from "What changed" — a $0 row
  // carries no information and wastes a row in the chart.
  const changeDisplayRows = changeRows.filter((r) => r.change !== 0);
  const changeMaxAbsCents = Math.max(
    0,
    ...changeDisplayRows.map((r) => Math.abs(r.change)),
  );
  // Symmetric "nice" axis maximum (dollars) so the ticks are always
  // regular and symmetric around zero: -M, -M/2, 0, +M/2, +M.
  const changeAxisMaxDollars = niceCeilDollars(changeMaxAbsCents / 100);
  const changeTicksDollars = [
    -changeAxisMaxDollars,
    -changeAxisMaxDollars / 2,
    0,
    changeAxisMaxDollars / 2,
    changeAxisMaxDollars,
  ];
  const periodLabel =
    period === "last"
      ? "Since last snapshot"
      : period === "ytd"
        ? "Year to date"
        : "All time";

  /* ----- accounts table helpers ----- */
  // Same comparison as "What changed" above: the baseline and latest
  // snapshots' own recorded balances, a missing balance counting as
  // $0 — so this column always agrees with the What changed rows and
  // with the snapshot totals. Null (shown as —) only when the account
  // was recorded in neither snapshot.
  function accountChange(a: NwAccount, baseline: NwSnapshot | null): number | null {
    if (!baseline || !latest) return null;
    const startB = baseline.balances.find((x) => x.accountId === a.id);
    const endB = latest.balances.find((x) => x.accountId === a.id);
    if (!startB && !endB) return null;
    const start = startB
      ? effectiveBalanceCentsClient(a.propertyKind, startB.balanceCents)
      : 0;
    const end = endB
      ? effectiveBalanceCentsClient(a.propertyKind, endB.balanceCents)
      : 0;
    return end - start;
  }

  // History table columns run newest → oldest (latest snapshot first).
  // `snapshots` itself stays chronological — charts, KPIs and the
  // explorer keep their time order — so this is a display-only copy
  // used only by the History grid below. Each column still carries
  // its own snapshot object, so balances, subtotals and the
  // tap-to-edit handlers stay bound to their own date.
  const historySnapshots = [...snapshots].reverse();

  return (
    <div>
      {/* data-integrity warnings — rendered only when a server-side
          check found a problem with the stored data; an empty list
          renders nothing at all. */}
      {data && data.integrityWarnings.length > 0 && (
        <div
          role="alert"
          className="mt-5 rounded-[var(--radius)] border border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-sm text-[var(--text)]"
        >
          {data.integrityWarnings.map((w, i) => (
            <p key={i} className={i > 0 ? "mt-1" : undefined}>{w}</p>
          ))}
        </div>
      )}
      {/* header */}
      <div className="mt-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="display text-3xl font-semibold">Net Worth</h2>
          {!latest ? (
            <p className="mt-0.5 text-sm text-[var(--dim)]">No snapshots yet</p>
          ) : latest.note ? (
            <p className="mt-0.5 text-sm text-[var(--dim)]">{latest.note}</p>
          ) : null}
        </div>
        <div className="flex max-w-full min-w-0 flex-wrap gap-2">
          <button
            type="button"
            className={btnGhost}
            onClick={() => setShowNwExplorer(true)}
          >
            Slice &amp; dice
          </button>
          <button
            type="button"
            className={btnGhost}
            aria-expanded={showNwImport}
            onClick={() => setShowNwImport(!showNwImport)}
          >
            Import balances
          </button>
          <button type="button" className={btnPrimary} onClick={openAddSnapshot}>
            Add snapshot
          </button>
          <button
            type="button"
            className={btnGhost}
            aria-expanded={showAccountForm}
            onClick={() => setShowAccountForm(!showAccountForm)}
          >
            Add account
          </button>
        </div>
      </div>
      {showAccountForm && (
        <form
          className="mt-3 flex flex-wrap items-end gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (newAccountName.trim())
              addAccount.mutate({
                name: newAccountName.trim(),
                type: newAccountType,
              });
          }}
        >
          <div className="min-w-52 flex-1">
            <label htmlFor="nw-new-account" className={labelCls}>Account name</label>
            <input
              id="nw-new-account"
              type="text"
              className={inputCls}
              value={newAccountName}
              onChange={(e) => setNewAccountName(e.target.value)}
              placeholder="e.g. TreasuryDirect"
            />
          </div>
          <div className="min-w-52 flex-1">
            <label htmlFor="nw-new-account-type" className={labelCls}>Account type</label>
            <select
              id="nw-new-account-type"
              className={inputCls}
              value={newAccountType}
              onChange={(e) =>
                setNewAccountType(e.target.value as NwAccountType)
              }
            >
              <option value="none">Not property</option>
              <option value="asset">Property asset (e.g. house)</option>
              <option value="liability">Property liability (e.g. mortgage)</option>
              <option value="custodial">Custodial — not counted</option>
            </select>
          </div>
          <button type="submit" className={btnPrimary} disabled={addAccount.isPending}>
            {addAccount.isPending ? "Adding…" : "Add account"}
          </button>
          <button
            type="button"
            className={btnGhost}
            onClick={() => setShowAccountForm(false)}
          >
            Cancel
          </button>
          {accountError && (
            <p className="w-full text-sm text-[var(--bad)]">{accountError}</p>
          )}
          {newAccountType === "custodial" && (
            <p className="w-full text-xs text-[var(--dim)]">
              {CUSTODIAL_EXPLAINER}
            </p>
          )}
          <p className="w-full text-xs text-[var(--dim)]">
            A new account starts with no recorded balances — past snapshot totals
            don&rsquo;t change. To give it a value, add or edit a snapshot.
            Property accounts only count toward totals when
            “Include house &amp; mortgage” is on, and never sit in a tax bucket.
          </p>
        </form>
      )}

      {showNwImport && (
        <NwImportPanel
          accounts={activeAccounts}
          snapshots={snapshots}
          includeProperty={includeProperty}
          onSaved={invalidate}
          onClose={() => setShowNwImport(false)}
        />
      )}

      {/* property include toggle — slim one-line row */}
      <div className="mt-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 sm:px-4">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <label
            htmlFor="nw-include-property"
            className="flex cursor-pointer items-center gap-2.5 text-base font-medium whitespace-nowrap text-[var(--text)]"
          >
            <input
              id="nw-include-property"
              type="checkbox"
              role="switch"
              aria-label="Include house & mortgage"
              className="h-5 w-5 shrink-0 accent-[var(--accent)]"
              checked={includeProperty}
              disabled={setIncludeProperty.isPending}
              onChange={(e) => setIncludeProperty.mutate(e.target.checked)}
            />
            Include house &amp; mortgage
          </label>
          <span className="text-sm whitespace-nowrap text-[var(--dim)]">
            {latestPropertyNet != null
              ? includeProperty
                ? `· property net ${fmt(latestPropertyNet)} counted`
                : `· property net ${fmt(latestPropertyNet)} not counted`
              : includeProperty
                ? "· property counted"
                : "· property not counted"}
          </span>
        </div>
        {propertyAccountsWithoutValue.length > 0 && latest && (
          <p className="mt-1.5 w-full text-sm text-[var(--warn)]">
            {propertyAccountsWithoutValue.map((a) => a.name).join(", ")}{" "}
            {propertyAccountsWithoutValue.length === 1 ? "has" : "have"} no
            recorded value in any snapshot yet, so there is nothing for this
            toggle to include.{" "}
            <button
              type="button"
              className="font-medium text-[var(--accent)] underline underline-offset-2"
              onClick={() => openEditSnapshot(latest)}
            >
              Record a value in the {fmtDateLong(latest.date)} snapshot
            </button>
          </p>
        )}
      </div>

      {/* combined stat strip — one full-width strip: prominent
          net worth with its date, plus the two deltas as compact
          lines beside it on wide screens and below it on phones */}
      <section
        aria-label="Net worth summary"
        className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-6">
          <div className="min-w-0">
            <p className="text-[10.5px] leading-tight font-medium tracking-[0.02em] text-[var(--dim)] uppercase">
              Net worth
            </p>
            <p className="tnum display mt-1.5 text-3xl font-semibold whitespace-nowrap sm:text-4xl">
              {fmt(latestTotal)}
            </p>
            <p className="tnum mt-1 text-sm whitespace-nowrap text-[var(--dim)]">
              {latest ? `as of ${fmtDateLong(latest.date)}` : ""}
            </p>
          </div>
          <div className="flex min-w-0 flex-col gap-2 sm:items-end">
            <p className="tnum flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm sm:justify-end">
              <span className="text-[10.5px] leading-tight font-medium tracking-[0.02em] text-[var(--dim)] uppercase">
                Since last snapshot
              </span>
              <span
                className={`display text-lg leading-tight font-semibold whitespace-nowrap sm:text-xl ${sinceLastToneCls}`}
              >
                {prev ? fmtSigned(sinceLastCents) : "—"}
              </span>
              <span className="whitespace-nowrap text-[var(--dim)]">
                {prev
                  ? `${fmtPct(sinceLastPct)} · since ${fmtDateLong(prev.date)}`
                  : "Only one snapshot so far"}
              </span>
            </p>
            <p className="tnum flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm sm:justify-end">
              <span className="text-[10.5px] leading-tight font-medium tracking-[0.02em] text-[var(--dim)] uppercase">
                Year to date
              </span>
              <span
                className={`display text-lg leading-tight font-semibold whitespace-nowrap sm:text-xl ${ytdToneCls}`}
              >
                {ytdBaseline ? fmtSigned(ytdCents) : "—"}
              </span>
              {ytdBaseline && (
                <span className="whitespace-nowrap text-[var(--dim)]">
                  {`${fmtPct(ytdPct)} · vs ${fmtDateLong(ytdBaseline.date)}`}
                </span>
              )}
            </p>
          </div>
        </div>
      </section>

      {/* main chart */}
      <section
        aria-label="Net worth over time"
        className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="display text-lg font-semibold">Net worth over time</h3>
            <p className="mt-0.5 text-sm text-[var(--dim)]">
              {growthActive && growthBaselineSnap
                ? growthBaselineSnap.id === first?.id
                  ? `Change since the first snapshot (${fmtDateLong(growthBaselineSnap.date)}). Each point is that snapshot's value minus the first snapshot's.`
                  : `Change since the picked snapshot (${fmtDateLong(growthBaselineSnap.date)}). Each point is that snapshot's value minus the picked snapshot's.`
                : "Snapshots spaced by real time between the dates they were recorded."}
            </p>
            {annotation && (
              <p
                className={`tnum mt-1 text-base font-medium ${
                  annotation.tone > 0
                    ? "text-[var(--accent)]"
                    : annotation.tone < 0
                      ? "text-[var(--bad)]"
                      : ""
                }`}
              >
                {annotation.text}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label="Chart mode"
            className="flex overflow-hidden rounded-[var(--radius)] border border-[var(--border)]"
          >
            <button
              type="button"
              aria-label="Total chart"
              aria-pressed={chartMode === "total"}
              onClick={() => setChartMode("total")}
              className={`px-3 py-1.5 text-sm font-medium ${chartMode === "total" ? "bg-[var(--accent)] text-white" : "text-[var(--text)] hover:text-[var(--accent)]"}`}
            >
              Total
            </button>
            <button
              type="button"
              aria-label="By account chart"
              aria-pressed={chartMode === "accounts"}
              onClick={() => setChartMode("accounts")}
              className={`px-3 py-1.5 text-sm font-medium ${chartMode === "accounts" ? "bg-[var(--accent)] text-white" : "text-[var(--text)] hover:text-[var(--accent)]"}`}
            >
              By account
            </button>
            <button
              type="button"
              aria-label="By bucket chart"
              aria-pressed={chartMode === "buckets"}
              onClick={() => setChartMode("buckets")}
              className={`px-3 py-1.5 text-sm font-medium ${chartMode === "buckets" ? "bg-[var(--accent)] text-white" : "text-[var(--text)] hover:text-[var(--accent)]"}`}
            >
              By bucket
            </button>
            <button
              type="button"
              aria-label="Share chart"
              aria-pressed={chartMode === "share"}
              onClick={() => setChartMode("share")}
              className={`px-3 py-1.5 text-sm font-medium ${chartMode === "share" ? "bg-[var(--accent)] text-white" : "text-[var(--text)] hover:text-[var(--accent)]"}`}
            >
              Share
            </button>
          </div>
          <button
            type="button"
            aria-label="Growth view"
            aria-pressed={growthOn}
            title={
              chartMode === "share"
                ? "Growth is not available for the Share view"
                : growthBaselineSnap && growthBaselineSnap.id !== first?.id
                  ? `Show change since ${fmtDateLong(growthBaselineSnap.date)}`
                  : "Show change since the first snapshot"
            }
            disabled={chartMode === "share"}
            onClick={() => setGrowthOn((g) => !g)}
            className={`rounded-[var(--radius)] border border-[var(--border)] px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${growthOn && chartMode !== "share" ? "bg-[var(--accent)] text-white" : "text-[var(--text)] hover:text-[var(--accent)]"}`}
          >
            Growth
          </button>
          <label className="flex items-center gap-1.5 text-sm text-[var(--dim)]">
            Change since
            <select
              aria-label="Change since"
              className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-50"
              value={growthBaselineSnap?.date ?? ""}
              disabled={chartMode === "share"}
              onChange={(e) => {
                setGrowthSinceDate(e.target.value);
                setNwGrowthSince.mutate(e.target.value);
                // Picking a baseline date only takes effect in the
                // Growth view, so turn Growth on with the pick —
                // otherwise the choice saves silently and nothing on
                // screen changes. (The select is disabled in Share
                // mode, so this never fires there.)
                setGrowthOn(true);
              }}
            >
              {snapshots.map((s) => (
                <option key={s.id} value={s.date}>
                  {fmtDateLong(s.date)}
                </option>
              ))}
            </select>
          </label>
          </div>
        </div>
        {chartMode === "share" && (
          <p className="mt-2 text-sm text-[var(--dim)]">
            Each account&rsquo;s share of the total at each snapshot.
            {includeProperty
              ? " Property is included, as the toggle is on."
              : " Property is counted only while “Include house & mortgage” is on."}
            <InfoNote
              text={SHARE_ROUNDING_NOTE}
              ariaLabel="About share rounding"
              align="right"
            />
          </p>
        )}
        {highlightedAccount && chartMode === "total" && (
          <p className="mt-2 text-sm">
            Highlighting{" "}
            <strong>{highlightedAccount.name}</strong>{" "}
            <button
              type="button"
              aria-label="Clear account highlight"
              className="font-medium text-[var(--accent)] underline underline-offset-2"
              onClick={() => setHighlightId(null)}
            >
              Clear ✕
            </button>
          </p>
        )}
        <ul className="sr-only">
          {snapshots.map((s, sIdx) => (
            <li key={s.id}>
              {fmtDateLong(s.date)}: {fmt(s.totalCents)}
              {growthActive && growthBaselineSnap
                ? (() => {
                    const g = mainData[sIdx]?.["gTotal"];
                    return typeof g === "number"
                      ? ` · change since ${fmtDateLong(growthBaselineSnap.date)} ${fmtSigned(Math.round(g * 100))}`
                      : "";
                  })()
                : ""}
              {chartMode === "buckets"
                ? [
                    ...NW_BUCKETS.map((bucket) => {
                      const t = bucketTotalForSnapshot(s, bucket, kindById, custodialIds);
                      return t != null ? ` · ${bucketLabel(bucket)} ${fmt(t)}` : "";
                    }),
                    ...(includeProperty
                      ? (() => {
                          const pn = propertyNetForSnapshot(s, kindById);
                          return pn != null ? [` · Property ${fmt(pn)}`] : [];
                        })()
                      : []),
                  ].join("")
                : chartMode === "share"
                  ? chartAccounts
                      .map((a) => {
                        const b = s.balances.find((x) => x.accountId === a.id);
                        if (!b || s.totalCents === 0) return "";
                        const eff = effectiveBalanceCentsClient(
                          a.propertyKind,
                          b.balanceCents,
                        );
                        return ` · ${a.name} ${((eff / s.totalCents) * 100).toFixed(1)}% (${fmt(eff)})`;
                      })
                      .join("")
                  : ""}
            </li>
          ))}
        </ul>
        <div className="mt-3 max-w-full overflow-x-auto">
          <div className="h-[320px] min-w-[620px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={mainData} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="ts"
                  type="number"
                  scale="time"
                  domain={xDomain}
                  ticks={mainData.map((p) => p.ts)}
                  tickFormatter={(ts: number) =>
                    fmtDateShort(new Date(ts).toISOString().slice(0, 10))
                  }
                  tick={{ fill: "var(--dim)", fontSize: 11 }}
                  tickLine={false}
                  axisLine={{ stroke: "var(--border)" }}
                />
                {chartMode === "share" ? (
                  <YAxis
                    domain={[0, 100]}
                    ticks={[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]}
                    width={48}
                    tick={{ fill: "var(--text)", fontSize: 12 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v: number) => `${Math.round(v)}%`}
                  />
                ) : (
                  <YAxis
                    domain={
                      growthActive
                        ? [
                            (dataMin: number) => Math.min(0, dataMin),
                            (dataMax: number) => Math.max(0, dataMax),
                          ]
                        : [0, "dataMax"]
                    }
                    tickCount={9}
                    width={76}
                    tick={{ fill: "var(--text)", fontSize: 12 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v: number) => fmtCompact(Math.round(v * 100))}
                  />
                )}
                <Tooltip
                  cursor={{
                    stroke: "var(--dim)",
                    strokeWidth: 1,
                    strokeDasharray: "4 4",
                  }}
                  content={(tp: {
                    active?: boolean;
                    payload?: { payload?: MainPoint }[];
                  }) => {
                    if (!tp.active) return null;
                    const point = tp.payload?.[0]?.payload;
                    if (!point) return null;
                    const idx = snapshots.findIndex((s) => s.date === point.date);
                    const snap = snapshots[idx];
                    if (!snap) return null;
                    const prevSnap = idx > 0 ? snapshots[idx - 1] : undefined;
                    return (
                      <div className="max-w-72 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm shadow-lg">
                        <p className="font-semibold">{fmtDateLong(snap.date)}</p>
                        <p className="tnum mt-0.5">
                          Net worth {fmt(snap.totalCents)}
                          {prevSnap
                            ? ` · ${fmtSigned(snap.totalCents - prevSnap.totalCents)} since ${fmtDateShort(prevSnap.date)}`
                            : ""}
                        </p>
                        {growthActive && growthBaselineSnap && (
                          <p className="tnum mt-0.5 font-medium">
                            Change since {fmtDateLong(growthBaselineSnap.date)}:{" "}
                            {typeof point["gTotal"] === "number"
                              ? fmtSigned(Math.round((point["gTotal"] as number) * 100))
                              : "—"}
                          </p>
                        )}
                        {growthActive &&
                          (chartMode === "accounts" || chartMode === "buckets") &&
                          growthBaselineSnap && (
                            <p className="mt-1 text-xs text-[var(--dim)]">
                              Change since {fmtDateLong(growthBaselineSnap.date)} by{" "}
                              {chartMode === "accounts" ? "account" : "bucket"}:
                            </p>
                          )}
                        {chartMode === "accounts" && (
                          <ul className="tnum mt-1 space-y-0.5 text-[var(--dim)]">
                            {chartAccounts.map((a) => {
                              const b = snap.balances.find((x) => x.accountId === a.id);
                              const color =
                                SERIES_COLORS[
                                  accounts.findIndex((x) => x.id === a.id) %
                                    SERIES_COLORS.length
                                ];
                              return (
                                <li key={a.id} className="flex justify-between gap-4">
                                  <span>
                                    <span
                                      aria-hidden="true"
                                      className="mr-1.5 inline-block h-2 w-2 rounded-full"
                                      style={{ background: color }}
                                    />
                                    {a.name}
                                  </span>
                                  <span>
                                    {growthActive
                                      ? typeof point[`ga${a.id}`] === "number"
                                        ? fmtSigned(
                                            Math.round(
                                              (point[`ga${a.id}`] as number) * 100,
                                            ),
                                          )
                                        : "—"
                                      : b
                                        ? fmt(
                                            effectiveBalanceCentsClient(
                                              a.propertyKind,
                                              b.balanceCents,
                                            ),
                                          )
                                        : "—"}
                                  </span>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                        {chartMode === "share" && (
                          <ul className="tnum mt-1 space-y-0.5 text-[var(--dim)]">
                            {chartAccounts.map((a) => {
                              const b = snap.balances.find((x) => x.accountId === a.id);
                              const color =
                                SERIES_COLORS[
                                  accounts.findIndex((x) => x.id === a.id) %
                                    SERIES_COLORS.length
                                ];
                              const eff = b
                                ? effectiveBalanceCentsClient(
                                    a.propertyKind,
                                    b.balanceCents,
                                  )
                                : null;
                              return (
                                <li key={a.id} className="flex justify-between gap-4">
                                  <span>
                                    <span
                                      aria-hidden="true"
                                      className="mr-1.5 inline-block h-2 w-2 rounded-full"
                                      style={{ background: color }}
                                    />
                                    {a.name}
                                  </span>
                                  <span>
                                    {eff != null && snap.totalCents !== 0
                                      ? `${((eff / snap.totalCents) * 100).toFixed(1)}% · ${fmt(eff)}`
                                      : "—"}
                                  </span>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                        {chartMode === "buckets" && (
                          <ul className="tnum mt-1 space-y-0.5 text-[var(--dim)]">
                            {NW_BUCKETS.map((bucket) => {
                              const t = bucketTotalForSnapshot(snap, bucket, kindById, custodialIds);
                              if (t == null) return null;
                              const g = point[`g${bucketKey(bucket)}`];
                              return (
                                <li key={bucket} className="flex justify-between gap-4">
                                  <span>
                                    <span
                                      aria-hidden="true"
                                      className="mr-1.5 inline-block h-2 w-2 rounded-full"
                                      style={{ background: BUCKET_COLORS[bucket] }}
                                    />
                                    {bucketLabel(bucket)}
                                  </span>
                                  <span>
                                    {growthActive
                                      ? typeof g === "number"
                                        ? fmtSigned(Math.round(g * 100))
                                        : "—"
                                      : fmt(t)}
                                  </span>
                                </li>
                              );
                            })}
                            {includeProperty &&
                              (() => {
                                const pn = propertyNetForSnapshot(snap, kindById);
                                if (pn == null) return null;
                                const g = point[`g${PROPERTY_KEY}`];
                                return (
                                  <li className="flex justify-between gap-4">
                                    <span>
                                      <span
                                        aria-hidden="true"
                                        className="mr-1.5 inline-block h-2 w-2 rounded-full"
                                        style={{ background: PROPERTY_COLOR }}
                                      />
                                      Property
                                    </span>
                                    <span>
                                      {growthActive
                                        ? typeof g === "number"
                                          ? fmtSigned(Math.round(g * 100))
                                          : "—"
                                        : fmt(pn)}
                                    </span>
                                  </li>
                                );
                              })()}
                          </ul>
                        )}
                        {chartMode === "total" && highlightedAccount && (
                          <p className="tnum mt-0.5 text-[var(--dim)]">
                            {highlightedAccount.name}:{" "}
                            {(() => {
                              if (growthActive) {
                                const g = point[`ga${highlightedAccount.id}`];
                                return typeof g === "number"
                                  ? fmtSigned(Math.round(g * 100))
                                  : "not recorded";
                              }
                              const b = snap.balances.find(
                                (x) => x.accountId === highlightedAccount.id,
                              );
                              // Signed like the Accounts-mode tooltip:
                              // a property liability's entered balance
                              // subtracts, so show it negative here too.
                              return b
                                ? fmt(
                                    effectiveBalanceCentsClient(
                                      highlightedAccount.propertyKind,
                                      b.balanceCents,
                                    ),
                                  )
                                : "not recorded";
                            })()}
                          </p>
                        )}
                      </div>
                    );
                  }}
                />
                {(chartMode === "accounts" ||
                  chartMode === "buckets" ||
                  chartMode === "share") && (
                  <Legend
                    formatter={(value: string) => (
                      <span style={{ color: "var(--text)" }}>{value}</span>
                    )}
                  />
                )}
                {growthActive && (
                  <ReferenceLine y={0} stroke="var(--dim)" />
                )}
                {growthActive && chartMode === "total" ? (
                  // Growth, Total mode: the headline total-growth
                  // series with the same styling as the level Total
                  // Area, plus the highlighted account's growth line.
                  [
                    <Area
                      key="gtotal"
                      type="monotone"
                      dataKey="gTotal"
                      name="Net worth"
                      stroke={TOTAL_COLOR}
                      strokeWidth={2.2}
                      fill={TOTAL_COLOR}
                      fillOpacity={0.16}
                      dot={{ r: 3, fill: TOTAL_COLOR, strokeWidth: 0 }}
                      activeDot={{ r: 4.5 }}
                      isAnimationActive={false}
                    />,
                    ...(highlightedAccount
                      ? [
                          <Line
                            key="ghighlight"
                            type="monotone"
                            dataKey={`ga${highlightedAccount.id}`}
                            name={highlightedAccount.name}
                            stroke={SERIES_COLORS[accounts.findIndex((a) => a.id === highlightedAccount.id) % SERIES_COLORS.length]}
                            strokeWidth={2}
                            dot={{ r: 2.5 }}
                            connectNulls={false}
                            isAnimationActive={false}
                          />,
                        ]
                      : []),
                  ]
                ) : growthActive && chartMode === "accounts" ? (
                  // Growth, By account: NON-STACKED lines — stacked
                  // areas cannot represent negative contributions
                  // honestly; negative growth renders below zero.
                  chartAccounts.map((a) => {
                    const idx = accounts.findIndex((x) => x.id === a.id);
                    const color = SERIES_COLORS[idx % SERIES_COLORS.length];
                    return (
                      <Line
                        key={a.id}
                        type="monotone"
                        dataKey={`ga${a.id}`}
                        name={a.name}
                        stroke={color}
                        strokeWidth={1.8}
                        dot={{ r: 2.5 }}
                        activeDot={{ r: 3.5 }}
                        connectNulls={false}
                        isAnimationActive={false}
                      />
                    );
                  })
                ) : growthActive && chartMode === "buckets" ? (
                  chartBuckets.map((bucket) => {
                    const color =
                      bucket === "Property"
                        ? PROPERTY_COLOR
                        : BUCKET_COLORS[bucket];
                    return (
                      <Line
                        key={bucket}
                        type="monotone"
                        dataKey={`g${bucketKey(bucket)}`}
                        name={bucketLabel(bucket)}
                        stroke={color}
                        strokeWidth={1.8}
                        dot={{ r: 2.5 }}
                        activeDot={{ r: 3.5 }}
                        connectNulls={false}
                        isAnimationActive={false}
                      />
                    );
                  })
                ) : chartMode === "total" ? (
                  // NOTE: Recharts does not traverse React fragments —
                  // graphical items must be direct children (an array
                  // is fine), or the chart renders no series at all.
                  [
                    <Area
                      key="total"
                      type="monotone"
                      dataKey="total"
                      name="Net worth"
                      stroke={TOTAL_COLOR}
                      strokeWidth={2.2}
                      fill={TOTAL_COLOR}
                      fillOpacity={0.16}
                      dot={{ r: 3, fill: TOTAL_COLOR, strokeWidth: 0 }}
                      activeDot={{ r: 4.5 }}
                      isAnimationActive={false}
                    />,
                    ...(highlightedAccount
                      ? [
                          <Line
                            key="highlight"
                            type="monotone"
                            dataKey={`a${highlightedAccount.id}`}
                            name={highlightedAccount.name}
                            stroke={SERIES_COLORS[accounts.findIndex((a) => a.id === highlightedAccount.id) % SERIES_COLORS.length]}
                            strokeWidth={2}
                            dot={{ r: 2.5 }}
                            connectNulls={false}
                            isAnimationActive={false}
                          />,
                        ]
                      : []),
                  ]
                ) : chartMode === "buckets" ? (
                  chartBuckets.map((bucket) => {
                    const color =
                      bucket === "Property"
                        ? PROPERTY_COLOR
                        : BUCKET_COLORS[bucket];
                    return (
                      <Area
                        key={bucket}
                        type="monotone"
                        dataKey={bucketKey(bucket)}
                        name={bucketLabel(bucket)}
                        stackId="nw"
                        stroke={color}
                        fill={color}
                        fillOpacity={0.8}
                        strokeWidth={1.2}
                        dot={{ r: 2, strokeWidth: 0 }}
                        activeDot={{ r: 3.5 }}
                        isAnimationActive={false}
                      />
                    );
                  })
                ) : chartMode === "share" ? (
                  chartAccounts.map((a) => {
                    const idx = accounts.findIndex((x) => x.id === a.id);
                    const color = SERIES_COLORS[idx % SERIES_COLORS.length];
                    return (
                      <Area
                        key={a.id}
                        type="monotone"
                        dataKey={`s${a.id}`}
                        name={a.name}
                        stackId="nwshare"
                        stroke={color}
                        fill={color}
                        fillOpacity={0.8}
                        strokeWidth={1.2}
                        dot={{ r: 2, strokeWidth: 0 }}
                        activeDot={{ r: 3.5 }}
                        isAnimationActive={false}
                      />
                    );
                  })
                ) : (
                  chartAccounts.map((a) => {
                    const idx = accounts.findIndex((x) => x.id === a.id);
                    const color = SERIES_COLORS[idx % SERIES_COLORS.length];
                    return (
                      <Area
                        key={a.id}
                        type="monotone"
                        dataKey={`a${a.id}`}
                        name={a.name}
                        stackId="nw"
                        stroke={color}
                        fill={color}
                        fillOpacity={0.8}
                        strokeWidth={1.2}
                        dot={{ r: 2, strokeWidth: 0 }}
                        activeDot={{ r: 3.5 }}
                        isAnimationActive={false}
                      />
                    );
                  })
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>

      {/* current bucket mix — one stacked bar from the latest
          snapshot's bucket subtotals */}
      <section
        aria-label="Current buckets"
        className="mt-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3.5 sm:p-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="display text-lg font-semibold">Current buckets</h3>
            <p className="mt-0.5 text-sm text-[var(--dim)]">
              {latest
                ? `From the ${fmtDateLong(latest.date)} snapshot`
                : ""}
            </p>
          </div>
          {bucketEntries.length > 0 && (
            <div className="text-right">
              <p className="tnum display text-xl font-semibold whitespace-nowrap sm:text-2xl">
                {fmt(bucketSignedTotal)}
              </p>
              {targetCents != null && targetCents > 0 && (
                <p className="tnum mt-0.5 text-sm text-[var(--dim)]">
                  {((bucketSignedTotal / targetCents) * 100).toFixed(1)}% of the{" "}
                  {fmt(targetCents)} target
                </p>
              )}
            </div>
          )}
        </div>
        {bucketEntries.length > 0 ? (
          <>
            {bucketMix.length > 0 && (
            <div
              className="mt-3 flex h-9 w-full overflow-hidden rounded-[var(--radius)]"
              role="img"
              aria-label={`Bucket mix: ${bucketMix
                .map(
                  (s) =>
                    `${bucketLabel(s.bucket)} ${fmt(s.cents)}, ${bucketMixTotal > 0 ? ((s.cents / bucketMixTotal) * 100).toFixed(1) : "0.0"} percent`,
                )
                .join("; ")}`}
            >
              {bucketMix.map((s) => (
                <div
                  key={s.bucket}
                  className="flex h-full min-w-0 items-center justify-center overflow-hidden px-1"
                  style={{
                    width: `${bucketMixTotal > 0 ? (s.cents / bucketMixTotal) * 100 : 0}%`,
                    background: BUCKET_COLORS[s.bucket],
                  }}
                >
                  {(s.cents / bucketMixTotal) * 100 >= 7 && (
                    <span className="text-xs font-semibold whitespace-nowrap text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.45)]">
                      {bucketLabel(s.bucket)}
                    </span>
                  )}
                </div>
              ))}
            </div>
            )}
            <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5">
              {bucketMix.map((s) => (
                <li
                  key={s.bucket}
                  className="tnum flex items-baseline gap-1.5 text-sm whitespace-nowrap"
                >
                  <span
                    aria-hidden="true"
                    className="inline-block h-2.5 w-2.5 shrink-0 self-center rounded-full"
                    style={{ background: BUCKET_COLORS[s.bucket] }}
                  />
                  <span className="font-medium">{bucketLabel(s.bucket)}</span>
                  <span>{fmt(s.cents)}</span>
                  <span className="text-[var(--dim)]">
                    ·{" "}
                    {bucketMixTotal > 0
                      ? ((s.cents / bucketMixTotal) * 100).toFixed(1)
                      : "0.0"}
                    %
                  </span>
                </li>
              ))}
            </ul>
            {bucketNegative.length > 0 && (
              <ul className="mt-2 space-y-1.5" aria-label="Negative buckets">
                {bucketNegative.map((s) => (
                  <li
                    key={s.bucket}
                    className="tnum flex items-baseline gap-1.5 text-sm whitespace-nowrap"
                  >
                    <span
                      aria-hidden="true"
                      className="inline-block h-2.5 w-2.5 shrink-0 self-center rounded-full"
                      style={{ background: BUCKET_COLORS[s.bucket] }}
                    />
                    <span className="font-medium">{bucketLabel(s.bucket)}</span>
                    <span>{fmt(s.cents)}</span>
                    <span className="text-[var(--dim)]">
                      — below zero, so it is not in the bar above; it is
                      counted in the total at the top
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {bucketMixPropertyNet != null && (
              <p className="mt-2 text-sm text-[var(--dim)]">
                Property net {fmt(bucketMixPropertyNet)} is counted in net
                worth, outside the buckets — so this mix covers the bucketed
                part of the total.
              </p>
            )}
          </>
        ) : (
          <p className="mt-2 text-sm text-[var(--dim)]">
            No bucket amounts recorded in the latest snapshot yet.
          </p>
        )}
      </section>

      {/* net worth target */}
      <section
        aria-label="Net worth target"
        className="mt-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3.5 sm:p-4"
      >
        {targetCents == null && !editingTarget ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-[var(--dim)]">No target set yet.</p>
            <button
              type="button"
              aria-label="Set a net worth target"
              className="text-sm font-medium text-[var(--accent)] underline underline-offset-2 hover:underline"
              onClick={() => {
                setTargetInput("");
                setTargetError("");
                setEditingTarget(true);
              }}
            >
              Set a net worth target
            </button>
          </div>
        ) : editingTarget ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const parsed = parseBalanceInput(targetInput);
              if (parsed === undefined || parsed == null || parsed <= 0) {
                setTargetError("Enter a target amount above $0, e.g. 6000000");
                return;
              }
              setNwTarget.mutate(parsed);
            }}
          >
            <div className="min-w-52 flex-1">
              <label htmlFor="nw-target-input" className={labelCls}>
                Net worth target ($)
              </label>
              <input
                id="nw-target-input"
                type="text"
                inputMode="decimal"
                className={inputCls}
                value={targetInput}
                onChange={(e) => setTargetInput(e.target.value)}
                placeholder="e.g. 6,000,000"
              />
            </div>
            <button
              type="submit"
              className={btnPrimary}
              disabled={setNwTarget.isPending}
            >
              {setNwTarget.isPending ? "Saving…" : "Save target"}
            </button>
            <button
              type="button"
              className={btnGhost}
              onClick={() => {
                setEditingTarget(false);
                setTargetError("");
              }}
            >
              Cancel
            </button>
            {targetCents != null && (
              <button
                type="button"
                aria-label="Clear net worth target"
                className="rounded-[var(--radius)] border border-[var(--bad)] px-3 py-2 text-sm font-medium text-[var(--bad)] disabled:opacity-50"
                disabled={setNwTarget.isPending}
                onClick={() => setNwTarget.mutate(null)}
              >
                Clear target
              </button>
            )}
            {targetError && (
              <p className="w-full text-sm text-[var(--bad)]">{targetError}</p>
            )}
          </form>
        ) : (
          <div>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-[10.5px] leading-tight font-medium tracking-[0.02em] text-[var(--dim)] uppercase">
                  Net worth target
                </p>
                <p className="tnum display mt-1.5 text-xl font-semibold sm:text-2xl">
                  {fmt(targetCents ?? 0)}
                </p>
                <p className="tnum mt-1 text-sm text-[var(--dim)]">
                  {targetProgressFrac != null
                    ? `${(targetProgressFrac * 100).toFixed(1)}% reached`
                    : ""}
                  {targetRemainingCents != null
                    ? ` · ${targetRemainingCents === 0 ? "Target reached" : `${fmt(targetRemainingCents)} remaining`}`
                    : ""}
                </p>
                <p className="mt-1 text-sm text-[var(--dim)]">
                  Rough ETA (pace-based estimate from up to the trailing 12 months):{" "}
                  <span className="tnum font-medium text-[var(--text)]">
                    {targetEtaLabel}
                  </span>
                </p>
              </div>
              <button
                type="button"
                aria-label="Edit net worth target"
                className={btnGhost}
                onClick={() => {
                  setTargetInput(String((targetCents ?? 0) / 100));
                  setTargetError("");
                  setEditingTarget(true);
                }}
              >
                Edit target
              </button>
            </div>
            <div
              className="mt-3 h-3 w-full overflow-hidden rounded-full bg-[var(--surface-alt)]"
              role="img"
              aria-label={`Progress toward net worth target: ${targetProgressFrac != null ? (targetProgressFrac * 100).toFixed(1) : "0"} percent`}
            >
              <div
                className="h-full rounded-full bg-[var(--accent)]"
                style={{
                  width: `${targetProgressFrac != null ? Math.min(Math.max(targetProgressFrac * 100, 0), 100) : 0}%`,
                }}
              />
            </div>
          </div>
        )}
      </section>

      {/* trend — all years (dissolved in from the former Year
          Summary view, with its anchor-basis note and the per-year
          detail the table does not carry) */}
      <TrendBlock />

      {/* allocation + what changed */}
      <div className="mt-4 grid items-stretch gap-4 lg:grid-cols-2">
        <section
          aria-label="Current allocation"
          className="flex h-full min-w-0 flex-col overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5"
        >
          <h3 className="display text-lg font-semibold">Current allocation</h3>
          <p className="mt-0.5 text-sm text-[var(--dim)]">
            {latest ? `From the ${fmtDateLong(latest.date)} snapshot` : ""}
          </p>
          <ul className="mt-3 space-y-3">
            {allocRows.map((r) => {
              const share = allocTotal !== 0 ? r.cents / allocTotal : 0;
              const idx = accounts.findIndex((a) => a.id === r.account.id);
              const color = SERIES_COLORS[idx % SERIES_COLORS.length];
              return (
                <li key={r.account.id} className="min-w-0">
                  <div className="flex min-w-0 items-baseline justify-between gap-3">
                    <p
                      className="min-w-0 flex-1 truncate text-sm font-medium"
                      title={r.account.name}
                    >
                      {r.account.name}
                    </p>
                    <p className="tnum shrink-0 text-sm whitespace-nowrap">
                      {fmt(r.cents)}{" "}
                      <span className="text-[var(--dim)]">
                        · {(share * 100).toFixed(1)}%
                      </span>
                    </p>
                  </div>
                  <div
                    className="mt-1 h-2.5 w-full overflow-hidden rounded-full bg-[var(--surface-alt)]"
                    role="img"
                    aria-label={`${r.account.name}: ${fmt(r.cents)}, ${(share * 100).toFixed(1)} percent of net worth`}
                  >
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${allocMax > 0 ? Math.max((r.cents / allocMax) * 100, r.cents > 0 ? 1.5 : 0) : 0}%`,
                        background: color,
                      }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="min-h-3 flex-1" aria-hidden="true" />
          <p className="tnum border-t border-[var(--border)] pt-2 text-sm text-[var(--dim)]">
            Total {fmt(allocTotal)} across {allocRows.length} accounts
            <InfoNote
              text={SHARE_ROUNDING_NOTE}
              ariaLabel="About share rounding"
              align="right"
              placement="above"
            />
          </p>
        </section>

        <section
          aria-label="What changed"
          className="flex h-full min-w-0 flex-col overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <h3 className="display text-lg font-semibold">What changed</h3>
              <p className="tnum mt-0.5 text-sm text-[var(--dim)]">
                {periodBaseline
                  ? `Net ${fmtSigned(changeNet)} · ${fmtDateShort(periodBaseline.date)} → ${latest ? fmtDateShort(latest.date) : ""}`
                  : ""}
              </p>
            </div>
            <div
              role="group"
              aria-label="Change period"
              className="flex shrink-0 overflow-hidden rounded-[var(--radius)] border border-[var(--border)]"
            >
              {(
                [
                  ["last", "Since last snapshot"],
                  ["ytd", "Year to date"],
                  ["all", "All time"],
                ] as [ChangePeriod, string][]
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-label={label}
                  aria-pressed={period === value}
                  onClick={() => setPeriod(value)}
                  className={`px-2.5 py-1.5 text-xs font-medium sm:text-sm ${period === value ? "bg-[var(--accent)] text-white" : "text-[var(--text)] hover:text-[var(--accent)]"}`}
                >
                  {value === "last" ? "Last" : value === "ytd" ? "YTD" : "All time"}
                </button>
              ))}
            </div>
          </div>
          <p className="mt-1 text-sm text-[var(--dim)]">{periodLabel}, by account:</p>
          {changeDisplayRows.length === 0 ? (
            <p className="mt-3 text-sm text-[var(--dim)]">
              No account changed in this period.
            </p>
          ) : (
            <div className="mt-2 flex w-full min-w-0 flex-1 flex-col">
              <ul className="space-y-3.5">
                {changeDisplayRows.map((r) => {
                  const pct =
                    changeAxisMaxDollars > 0
                      ? Math.min(
                          (Math.abs(r.change) / 100 / changeAxisMaxDollars) * 50,
                          50,
                        )
                      : 0;
                  const positive = r.change > 0;
                  return (
                    <li key={r.account.id} className="min-w-0">
                      <div className="flex min-w-0 items-baseline justify-between gap-3">
                        <p
                          className="min-w-0 flex-1 truncate text-sm font-medium"
                          title={r.account.name}
                        >
                          {r.account.name}
                        </p>
                        <p
                          className="tnum shrink-0 text-sm whitespace-nowrap"
                          style={{
                            color: positive ? POS_COLOR : NEG_COLOR,
                          }}
                        >
                          {fmtSigned(r.change)}
                        </p>
                      </div>
                      <div
                        className="relative mt-1 h-2.5 w-full overflow-hidden rounded-full bg-[var(--surface-alt)]"
                        role="img"
                        aria-label={`${r.account.name}: ${fmtSigned(r.change)}`}
                      >
                        <span
                          aria-hidden="true"
                          className="absolute top-0 bottom-0 left-1/2 w-px bg-[var(--dim)] opacity-60"
                        />
                        <div
                          className="absolute top-0 h-full rounded-full"
                          style={{
                            background: positive ? POS_COLOR : NEG_COLOR,
                            ...(positive
                              ? { left: "50%", width: `${pct}%` }
                              : { right: "50%", width: `${pct}%` }),
                          }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
              <div className="min-h-2 flex-1" aria-hidden="true" />
              <div
                className="relative h-5 w-full text-[11px] text-[var(--dim)]"
                aria-hidden="true"
              >
                {changeTicksDollars.map((tick, i) => (
                  <span
                    key={`${tick}-${i}`}
                    className="tnum absolute -translate-x-1/2 whitespace-nowrap"
                    style={{
                      left: `${(i / (changeTicksDollars.length - 1)) * 100}%`,
                      transform:
                        i === 0
                          ? "translateX(0)"
                          : i === changeTicksDollars.length - 1
                            ? "translateX(-100%)"
                            : "translateX(-50%)",
                    }}
                  >
                    {tick === 0 ? "$0" : fmtCompact(Math.round(tick * 100))}
                  </span>
                ))}
              </div>
              <ul className="sr-only">
                {changeDisplayRows.map((r) => (
                  <li key={r.account.id}>
                    {r.account.name}: {fmtSigned(r.change)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </div>

      {/* accounts table */}
      <section
        aria-label="Accounts"
        className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="display text-lg font-semibold">Accounts</h3>
            {accountsCollapsed ? (
              <p className="mt-0.5 text-sm text-[var(--dim)]">
                {`${accounts.length} accounts · latest total ${fmt(latestTotal)}${latest ? ` as of ${fmtDateLong(latest.date)}` : ""}`}
              </p>
            ) : (
              <Explainer
                id="networth.accounts"
                label="Accounts"
                className="mt-0.5"
                summary="Tap an account to select it — in the Total chart, its line is drawn over the total."
              >
                <p>
                  Tap an account to select it — in the Total chart, its line is drawn over the total. Tap the Latest amount to correct a mistyped balance; use Edit to change its name or its account type.
                </p>
              </Explainer>
            )}
          </div>
          <button
            type="button"
            aria-expanded={!accountsCollapsed}
            aria-label={accountsCollapsed ? "Expand Accounts" : "Collapse Accounts"}
            className={btnGhost}
            disabled={setAccountsCollapsed.isPending}
            onClick={() => setAccountsCollapsed.mutate(!accountsCollapsed)}
          >
            {accountsCollapsed ? "Expand" : "Collapse"}
          </button>
        </div>
        {!accountsCollapsed && (
        <div className="mt-3 overflow-x-auto">
          <table className="tnum w-full min-w-[700px] border-collapse text-sm">
            <caption className="sr-only">Accounts with latest balances and changes; Share is each account&rsquo;s latest recorded balance as a share of the latest snapshot total</caption>
            <thead>
              <tr className="border-b border-[var(--border)] text-left">
                <th scope="col" className="py-2 pr-3 font-semibold">Account</th>
                <th scope="col" className="py-2 pr-3 text-right font-semibold whitespace-nowrap">Latest</th>
                <th scope="col" className="py-2 pr-3 text-right font-semibold whitespace-nowrap" title="Each account's latest recorded balance as a share of the latest snapshot total">Share of latest total</th>
                <th scope="col" className="py-2 pr-3 text-right font-semibold whitespace-nowrap">Since last</th>
                <th scope="col" className="py-2 pr-3 text-right font-semibold whitespace-nowrap">YTD</th>
                <th scope="col" className="py-2 pr-3 font-semibold">Trend</th>
                <th scope="col" className="py-2 font-semibold">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => {
                const series = seriesByAccount.get(a.id) ?? [];
                const latestRec = series[series.length - 1] ?? null;
                const isProp = a.propertyKind !== "none";
                const propExcluded = isProp && !includeProperty;
                // Custodial accounts are recorded but never counted:
                // no share, no change columns.
                const notCounted = a.custodial;
                const effectiveLatest =
                  latestRec != null
                    ? effectiveBalanceCentsClient(a.propertyKind, latestRec.cents)
                    : null;
                const share =
                  effectiveLatest != null && latestTotal !== 0
                    ? effectiveLatest / latestTotal
                    : 0;
                const chLast = propExcluded || notCounted
                  ? null
                  : accountChange(a, prev);
                const chYtd = propExcluded || notCounted
                  ? null
                  : accountChange(a, ytdBaseline);
                const zeroFlag =
                  latestRec != null &&
                  latestRec.cents === 0 &&
                  series.some((p) => p.cents !== 0);
                const idx = accounts.findIndex((x) => x.id === a.id);
                const isHl = highlightId === a.id;
                return (
                  <tr
                    key={a.id}
                    className={`cursor-pointer border-b border-[var(--border)] ${isHl ? "bg-[var(--accent-soft)]" : ""}`}
                    onClick={() => setHighlightId(isHl ? null : a.id)}
                  >
                    <th scope="row" className="py-2.5 pr-3 text-left font-medium">
                      {a.name}
                      {a.archived && (
                        <span className="ml-2 text-xs font-normal text-[var(--dim)]">
                          Archived
                        </span>
                      )}
                      {a.propertyKind === "asset" && (
                        <span
                          className="ml-2 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap text-white"
                          style={{ background: PROPERTY_COLOR }}
                        >
                          Property asset
                        </span>
                      )}
                      {a.propertyKind === "liability" && (
                        <span
                          className="ml-2 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap text-white"
                          style={{ background: PROPERTY_COLOR }}
                        >
                          Property liability
                        </span>
                      )}
                      {a.custodial && (
                        <span
                          className="ml-2 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap text-white"
                          style={{ background: CUSTODIAL_COLOR }}
                        >
                          Custodial — not counted
                        </span>
                      )}
                      {propExcluded && (
                        <span className="ml-2 text-xs font-normal text-[var(--dim)]">
                          Excluded — house &amp; mortgage off
                        </span>
                      )}
                      {latestRec && (
                        <span className="block text-xs font-normal text-[var(--dim)]">
                          {fmtDateShort(latestRec.date)}
                        </span>
                      )}
                      {zeroFlag && (
                        <span className="mt-0.5 block text-xs font-normal text-[var(--warn)]">
                          Now $0 — check if closed/transferred
                        </span>
                      )}
                    </th>
                    <td className="py-2.5 pr-3 text-right whitespace-nowrap">
                      {latestRec ? (
                        <button
                          type="button"
                          aria-label={`Edit balance for ${a.name}`}
                          title={`Correct the ${a.name} balance recorded on ${fmtDateLong(latestRec.date)}`}
                          className="underline decoration-dotted underline-offset-4 hover:text-[var(--accent)]"
                          onClick={(e) => {
                            e.stopPropagation();
                            const snap =
                              snapshots.find((s) => s.date === latestRec.date) ??
                              null;
                            if (snap) setBalanceEdit({ account: a, snapshot: snap });
                          }}
                        >
                          {fmt(latestRec.cents)}
                        </button>
                      ) : (
                        "—"
                      )}
                      {a.propertyKind === "liability" && latestRec && (
                        <span className="block text-xs font-normal text-[var(--dim)]">
                          subtracts when included
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 text-right whitespace-nowrap">
                      {notCounted
                        ? "Not counted"
                        : propExcluded
                          ? "Excluded"
                          : latestRec
                            ? `${(share * 100).toFixed(1)}%`
                            : "—"}
                    </td>
                    <td
                      className={`py-2.5 pr-3 text-right whitespace-nowrap ${chLast != null && chLast < 0 ? "text-[var(--bad)]" : ""}`}
                    >
                      {chLast != null ? fmtSigned(chLast) : "—"}
                    </td>
                    <td
                      className={`py-2.5 pr-3 text-right whitespace-nowrap ${chYtd != null && chYtd < 0 ? "text-[var(--bad)]" : ""}`}
                    >
                      {chYtd != null ? fmtSigned(chYtd) : "—"}
                    </td>
                    <td className="py-2.5 pr-3">
                      <Sparkline
                        series={series}
                        color={SERIES_COLORS[idx % SERIES_COLORS.length] ?? TOTAL_COLOR}
                      />
                    </td>
                    <td className="py-2.5 whitespace-nowrap">
                      {renamingId === a.id ? (
                        <span
                          className="flex flex-wrap items-center gap-1.5"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="text"
                            aria-label={`New name for ${a.name}`}
                            className="w-32 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm"
                            value={renameName}
                            onChange={(e) => setRenameName(e.target.value)}
                          />
                          <select
                            aria-label={`Account type for ${a.name}`}
                            className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm"
                            value={renameType}
                            onChange={(e) =>
                              setRenameType(
                                e.target.value as NwAccountType,
                              )
                            }
                          >
                            <option value="none">Not property</option>
                            <option value="asset">Property asset (e.g. house)</option>
                            <option value="liability">Property liability (e.g. mortgage)</option>
                            <option value="custodial">Custodial — not counted</option>
                          </select>
                          <button
                            type="button"
                            className="text-sm font-medium text-[var(--accent)]"
                            disabled={renameAccount.isPending}
                            onClick={() =>
                              renameAccount.mutate({
                                id: a.id,
                                name: renameName,
                                type: renameType,
                                base: {
                                  name: a.name,
                                  propertyKind: a.propertyKind,
                                  custodial: a.custodial,
                                },
                              })
                            }
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            className="text-sm text-[var(--dim)]"
                            onClick={() => {
                              setRenamingId(null);
                              setRenameError("");
                            }}
                          >
                            Cancel
                          </button>
                        </span>
                      ) : confirmDeleteAccountId === a.id ? (
                        <span
                          className="flex max-w-xs flex-wrap items-center gap-2 whitespace-normal"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <span className="text-sm text-[var(--bad)]">
                            Delete “{a.name}” permanently? This removes the
                            account and all its recorded balances in every
                            snapshot, and cannot be undone.
                          </span>
                          <button
                            type="button"
                            aria-label={`Confirm delete ${a.name} permanently`}
                            className="rounded-[var(--radius)] bg-[var(--bad)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                            disabled={deleteAccount.isPending}
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteAccount.mutate(a.id);
                            }}
                          >
                            {deleteAccount.isPending
                              ? "Deleting…"
                              : "Yes, delete permanently"}
                          </button>
                          <button
                            type="button"
                            aria-label={`Cancel delete ${a.name}`}
                            className={btnGhost}
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmDeleteAccountId(null);
                            }}
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <span className="flex items-center gap-2">
                          <button
                            type="button"
                            aria-label={`Edit ${a.name}`}
                            className="text-sm font-medium text-[var(--dim)] underline-offset-2 hover:text-[var(--accent)] hover:underline"
                            onClick={(e) => {
                              e.stopPropagation();
                              setRenamingId(a.id);
                              setRenameName(a.name);
                              setRenameType(
                                a.custodial ? "custodial" : a.propertyKind,
                              );
                              setRenameError("");
                            }}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            aria-label={
                              a.archived ? `Restore ${a.name}` : `Archive ${a.name}`
                            }
                            className="text-sm font-medium text-[var(--dim)] underline-offset-2 hover:text-[var(--accent)] hover:underline"
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmDeleteAccountId(null);
                              setArchived.mutate({ id: a.id, archived: !a.archived });
                            }}
                          >
                            {a.archived ? "Restore" : "Archive"}
                          </button>
                          {a.archived && a.propertyKind === "none" && (
                            <button
                              type="button"
                              aria-label={`Delete ${a.name} permanently`}
                              className="text-sm font-medium text-[var(--bad)] underline-offset-2 hover:underline"
                              onClick={(e) => {
                                e.stopPropagation();
                                setDeleteAccountError("");
                                setConfirmDeleteAccountId(a.id);
                              }}
                            >
                              Delete permanently
                            </button>
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-[var(--dim)]">
            Share is each account&rsquo;s latest recorded balance (date shown under its name) as a share of the latest snapshot total{latest ? ` (${fmtDateLong(latest.date)})` : ""}.
            <InfoNote
              text={SHARE_ROUNDING_NOTE}
              ariaLabel="About share rounding"
              align="left"
              placement="above"
            />
          </p>
        </div>
        )}
        {renameError && !accountsCollapsed && (
          <p className="mt-2 text-sm text-[var(--bad)]">{renameError}</p>
        )}
        {deleteAccountError && !accountsCollapsed && (
          <p className="mt-2 text-sm text-[var(--bad)]">{deleteAccountError}</p>
        )}
      </section>

      {/* history grid */}
      <section
        aria-label="Snapshot history"
        className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="display text-lg font-semibold">History</h3>
            {historyCollapsed ? (
              <p className="mt-0.5 text-sm text-[var(--dim)]">
                {`${snapshots.length} snapshots · latest ${latest ? `${fmtDateLong(latest.date)} ` : ""}total ${fmt(latestTotal)}`}
              </p>
            ) : (
              <Explainer
                id="networth.history"
                label="History"
                className="mt-0.5"
                summary="Every snapshot, as recorded — tap a date or any balance to edit that snapshot."
              >
                <p>
                  {"Every snapshot, as recorded. The bucket subtotal rows add up each snapshot’s split amounts across accounts; a balance with no split counts as Unbucketed, whole. Property accounts sit outside the buckets: the Property net row is their signed net (assets − liabilities), and bucket subtotals + Property net = Total when house & mortgage are included. Custodial accounts sit outside everything: their balances are shown as recorded, the Custodial row sums them for reference, and they are never part of the Total. Tap a date or any balance to edit that snapshot."}
                </p>
              </Explainer>
            )}
          </div>
          <button
            type="button"
            aria-expanded={!historyCollapsed}
            aria-label={historyCollapsed ? "Expand History" : "Collapse History"}
            className={btnGhost}
            disabled={setHistoryCollapsed.isPending}
            onClick={() => setHistoryCollapsed.mutate(!historyCollapsed)}
          >
            {historyCollapsed ? "Expand" : "Collapse"}
          </button>
        </div>
        {!historyCollapsed && (
        <div className="mt-3 overflow-x-auto">
          <table className="tnum w-full border-collapse text-sm">
            <caption className="sr-only">Balances by account and snapshot date</caption>
            <thead>
              <tr className="border-b-2 border-[var(--border)]">
                <th
                  scope="col"
                  className="sticky left-0 bg-[var(--surface)] py-2 pr-3 text-left font-semibold"
                >
                  Account
                </th>
                {historySnapshots.map((s) => (
                  <th key={s.id} scope="col" className="py-2 pr-3 text-right font-semibold whitespace-nowrap">
                    <button
                      type="button"
                      aria-label={`Edit snapshot ${fmtDateLong(s.date)}`}
                      className="font-semibold underline-offset-2 hover:text-[var(--accent)] hover:underline"
                      onClick={() => openEditSnapshot(s)}
                    >
                      {fmtDateShort(s.date)}
                    </button>
                    {s.note && (
                      <span className="block max-w-28 truncate text-[11px] font-normal text-[var(--dim)]">
                        {s.note}
                      </span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id} className="border-b border-[var(--border)]">
                  <th
                    scope="row"
                    className="sticky left-0 bg-[var(--surface)] py-2 pr-3 text-left font-medium whitespace-nowrap"
                  >
                    {a.name}
                    {a.archived && (
                      <span className="ml-1.5 text-xs font-normal text-[var(--dim)]">
                        (archived)
                      </span>
                    )}
                    {a.propertyKind === "asset" && (
                      <span className="ml-1.5 text-xs font-normal text-[var(--dim)]">
                        (Property asset{includeProperty ? "" : " — excluded"})
                      </span>
                    )}
                    {a.propertyKind === "liability" && (
                      <span className="ml-1.5 text-xs font-normal text-[var(--dim)]">
                        (Property liability{includeProperty ? "" : " — excluded"})
                      </span>
                    )}
                    {a.custodial && (
                      <span className="ml-1.5 text-xs font-normal text-[var(--dim)]">
                        (Custodial — not counted)
                      </span>
                    )}
                  </th>
                  {historySnapshots.map((s) => {
                    const b = s.balances.find((x) => x.accountId === a.id);
                    return (
                      <td key={s.id} className="py-2 pr-3 text-right whitespace-nowrap">
                        <button
                          type="button"
                          aria-label={`Edit ${a.name} on ${fmtDateLong(s.date)}`}
                          className="underline-offset-2 hover:text-[var(--accent)] hover:underline"
                          onClick={() => openEditSnapshot(s)}
                        >
                          {b ? fmt(b.balanceCents) : "—"}
                        </button>
                        {b && balanceHasSplit(b) && (
                          <span className="block text-[11px] font-normal whitespace-normal text-[var(--dim)]">
                            {(b.splits ?? [])
                              .map((p) => `${bucketLabel(p.bucket)} ${fmt(p.amountCents)}`)
                              .join(" · ")}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
              <tr aria-hidden="true">
                <td colSpan={snapshots.length + 1} className="py-1" />
              </tr>
              {NW_BUCKETS.map((bucket) => (
                <tr key={bucket} className="border-b border-[var(--border)] font-medium">
                  <th
                    scope="row"
                    className="sticky left-0 bg-[var(--surface)] py-2 pr-3 text-left whitespace-nowrap"
                  >
                    <span
                      aria-hidden="true"
                      className="mr-2 inline-block h-2.5 w-2.5 rounded-full align-middle"
                      style={{ background: BUCKET_COLORS[bucket] }}
                    />
                    {bucketLabel(bucket)} subtotal
                  </th>
                  {historySnapshots.map((s) => {
                    const t = bucketTotalForSnapshot(s, bucket, kindById, custodialIds);
                    return (
                      <td key={s.id} className="py-2 pr-3 text-right whitespace-nowrap">
                        {t != null ? fmt(t) : "—"}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {snapshots.some((s) => propertyNetForSnapshot(s, kindById) != null) && (
                <tr className="border-b border-[var(--border)] font-medium">
                  <th
                    scope="row"
                    className="sticky left-0 bg-[var(--surface)] py-2 pr-3 text-left whitespace-nowrap"
                  >
                    <span
                      aria-hidden="true"
                      className="mr-2 inline-block h-2.5 w-2.5 rounded-full align-middle"
                      style={{ background: PROPERTY_COLOR }}
                    />
                    Property net
                    {!includeProperty && (
                      <span className="ml-1.5 text-xs font-normal text-[var(--dim)]">
                        (excluded)
                      </span>
                    )}
                  </th>
                  {historySnapshots.map((s) => {
                    const t = propertyNetForSnapshot(s, kindById);
                    return (
                      <td key={s.id} className="py-2 pr-3 text-right whitespace-nowrap">
                        {t != null ? fmt(t) : "—"}
                      </td>
                    );
                  })}
                </tr>
              )}
              {snapshots.some((s) => s.custodialTotalCents != null) && (
                <tr className="border-b border-[var(--border)] font-medium">
                  <th
                    scope="row"
                    className="sticky left-0 bg-[var(--surface)] py-2 pr-3 text-left whitespace-nowrap"
                  >
                    <span
                      aria-hidden="true"
                      className="mr-2 inline-block h-2.5 w-2.5 rounded-full align-middle"
                      style={{ background: CUSTODIAL_COLOR }}
                    />
                    Custodial — not counted
                  </th>
                  {historySnapshots.map((s) => (
                    <td key={s.id} className="py-2 pr-3 text-right whitespace-nowrap">
                      {s.custodialTotalCents != null ? fmt(s.custodialTotalCents) : "—"}
                    </td>
                  ))}
                </tr>
              )}
              <tr className="bg-[var(--surface-alt)] font-semibold">
                <th
                  scope="row"
                  className="sticky left-0 bg-[var(--surface-alt)] py-2 pr-3 text-left"
                >
                  Total
                </th>
                {historySnapshots.map((s) => (
                  <td key={s.id} className="py-2 pr-3 text-right whitespace-nowrap">
                    {fmt(s.totalCents)}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        )}
      </section>

      {/* backups (files outside the app) */}
      <section
        aria-label="Backups"
        className="mt-4 min-w-0 overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5"
      >
        <h3 className="display text-lg font-semibold">Backups</h3>
        <Explainer
          id="networth.backups"
          label="Backups"
          className="mt-0.5"
          summary="Encrypted backup files stored outside this app — deleting here removes the actual file."
        >
          <p>
            Encrypted backup files stored outside this app. Deleting here removes the actual file.
          </p>
        </Explainer>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-label="Create backup now"
            className="rounded-[var(--radius)] bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
            disabled={
              createBackup.isPending ||
              deleteBackup.isPending ||
              deleteAllBackups.isPending
            }
            onClick={() => createBackup.mutate()}
          >
            {createBackup.isPending ? "Creating backup…" : "Create backup now"}
          </button>
          {backupNotice && (
            <span role="status" className="text-sm text-[var(--accent)]">
              {backupNotice}
            </span>
          )}
        </div>
        {backupsQuery.isPending ? (
          <p className="mt-3 text-sm text-[var(--dim)]">Loading backups…</p>
        ) : backupsQuery.isError ? (
          <p className="mt-3 text-sm text-[var(--bad)]">
            Could not read the backups folder.{" "}
            <button
              type="button"
              className="font-medium text-[var(--accent)] underline underline-offset-2"
              onClick={() => backupsQuery.refetch()}
            >
              Try again
            </button>
          </p>
        ) : (backupsQuery.data?.backups ?? []).length === 0 ? (
          <p className="mt-3 text-sm text-[var(--dim)]">No backups stored</p>
        ) : (
          <>
            <ul className="mt-3 divide-y divide-[var(--border)]">
              {(backupsQuery.data?.backups ?? []).map((b) => {
                const dateMatch = b.name.match(/(\d{4}-\d{2}-\d{2})/);
                return (
                  <li
                    key={b.name}
                    className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-2.5"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium" title={b.name}>
                        {b.name}
                      </span>
                      <span className="tnum block text-xs text-[var(--dim)]">
                        {dateMatch ? fmtDateLong(dateMatch[1] ?? b.name) : b.name}
                        {" · "}
                        {fmtBytes(b.sizeBytes)}
                      </span>
                    </span>
                    {b.source === "legacy" ? null : (
                      <button
                        type="button"
                        aria-label={`Delete ${b.name}`}
                        className="shrink-0 rounded-[var(--radius)] border border-[var(--bad)] px-3 py-1.5 text-sm font-medium text-[var(--bad)] disabled:opacity-50"
                        disabled={deleteBackup.isPending || deleteAllBackups.isPending || createBackup.isPending}
                        onClick={() => deleteBackup.mutate(b.name)}
                      >
                        Delete
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
            {(backupsQuery.data?.backups ?? []).some(
              (b) => b.source === "own",
            ) && (
            <div className="mt-3 border-t border-[var(--border)] pt-3">
              {!confirmDeleteAllBackups ? (
                <button
                  type="button"
                  aria-label="Delete all backups"
                  className="rounded-[var(--radius)] border border-[var(--bad)] px-3 py-2 text-sm font-medium text-[var(--bad)] disabled:opacity-50"
                  disabled={deleteBackup.isPending || deleteAllBackups.isPending || createBackup.isPending}
                  onClick={() => setConfirmDeleteAllBackups(true)}
                >
                  Delete all backups
                </button>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-[var(--bad)]">
                    Delete all{" "}
                    {
                      (backupsQuery.data?.backups ?? []).filter(
                        (b) => b.source === "own",
                      ).length
                    }{" "}
                    backups? This cannot be undone.
                  </span>
                  <button
                    type="button"
                    aria-label="Confirm delete all backups"
                    className="rounded-[var(--radius)] bg-[var(--bad)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                    disabled={deleteAllBackups.isPending}
                    onClick={() => deleteAllBackups.mutate()}
                  >
                    {deleteAllBackups.isPending
                      ? "Deleting…"
                      : "Yes, delete all"}
                  </button>
                  <button
                    type="button"
                    aria-label="Cancel delete all backups"
                    className={btnGhost}
                    onClick={() => setConfirmDeleteAllBackups(false)}
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
            )}
          </>
        )}
        {backupError && (
          <p className="mt-2 text-sm text-[var(--bad)]">{backupError}</p>
        )}
      </section>

      {editorOpen && (
        <SnapshotEditor
          snapshot={editorSnapshot}
          accounts={accounts}
          snapshots={snapshots}
          onClose={() => setEditorOpen(false)}
        />
      )}
      {balanceEdit && (
        <BalanceEditor
          account={balanceEdit.account}
          snapshot={balanceEdit.snapshot}
          onClose={() => setBalanceEdit(null)}
        />
      )}
      {showNwExplorer && (
        <NwExplorerModal
          snapshots={snapshots}
          accounts={accounts}
          kindById={kindById}
          custodialIds={custodialIds}
          defaultIncludeProperty={includeProperty}
          onClose={() => setShowNwExplorer(false)}
        />
      )}
    </div>
  );
}
