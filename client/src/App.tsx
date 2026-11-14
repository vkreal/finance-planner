import {
Fragment,
useEffect,
useId,
useMemo,
useRef,
useState,
type FormEvent,
type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  PERMANENT_ACTION_STATUSES,
  SafeAreaTopScrim,
  SpaceActionError,
  actionRetryDelay,
  shouldRetryAction,
} from "@hatch/space-sdk/client";
import {
Bar,
BarChart,
CartesianGrid,
Cell,
LabelList,
Rectangle,
ReferenceLine,
ResponsiveContainer,
Tooltip,
XAxis,
YAxis,
} from "recharts";
import { api, type ApiRequest, type ApiResponse } from "./api";
import { monthlyRaw, monthlyToAnnual } from "./rothShared";
import {
csvFormulaSafeText,
csvImportFileError,
parseCsvChecked,
} from "./csvUtil";
import {
EMPTY_IMPORT_SETTINGS,
buildCashOutProposals,
combineDebitCreditAmount,
compareCashOutProposal,
detectImportHeader,
findImportProfile,
flagExactFitIdDuplicates,
flagImportDuplicates,
guessImportMapping,
importHeaderFingerprint,
normalizeImportDate,
parseImportAmount,
parseImportSettings,
serializeImportSettings,
upsertImportProfile,
withImportOfxAccount,
withLastImportSettings,
type CashOutMonthProposal,
type ImportColumnMapping,
type ImportFileSettings,
type ImportSettingsBlob,
} from "./importParseCore";
import {
looksLikeOfx,
ofxAccountDisplay,
ofxAccountKey,
parseOfx,
} from "./ofxCore";
import { Explainer, ExplainerInfoTip } from "./Explainer";
import {
  useFoldStateMap,
  usePersistedFold,
  useSetFold,
} from "./foldState";
import { usePersistedChoice } from "./persistedChoice";
import { NetWorthView } from "./NetWorth";
import { RetirementCalc } from "./RetirementCalc";
import { RothConversion, type RothSectionId } from "./RothConversion";
import { Playground, SpendPeriodPills } from "./Playground";
import { YearInSpendingBlock } from "./YearBlocks";
import { FoldChevron } from "./FoldChevron";

type Dash = ApiResponse<typeof api, "getDashboard">;
type Txn = Dash["monthTransactions"][number];
type Yearly = Dash["yearly"][number];
type Bill = Dash["monthlyBills"][number];
type OneOff = Dash["oneOffs"][number];
type CashOutItem = Dash["cashOutItems"][number];
type TxnInput = ApiRequest<typeof api, "importTransactions">["rows"][number];
/* The Tax Plan record's writer (saveRothInputs) — the Spending
   view's spending-target field writes through to the record
   through it, the same writer the Tax Plan, Retirement, and
   Playground views use (one source, multiple edit locations). */
type RothSavePayload = Parameters<typeof api.saveRothInputs>[0];

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const CATEGORIES = [
  "Housing", "Groceries", "Dining", "Transport", "Utilities", "Insurance",
  "Health", "Home", "Subscriptions", "Other",
];

// Preset categories for bills (monthly and smoothed). Custom names can
// be typed in the forms and are offered again once used. ("Keep the
// lights on" also exists as a separate checkbox on each bill — the
// preset here is just an ordinary category label some bills may carry.)
const BILL_CATEGORY_PRESETS = [
  "Uncategorized",
  "Keep the lights on",
  "Housing",
  "Utilities",
  "Insurance",
  "Taxes",
  "Food & household",
  "Transportation",
  "Health & fitness",
  "Subscriptions",
  "Other",
  "Tolls",
  "Donations",
  "Health Insurance",
  "Phone",
  "Mortgage",
  "Gym",
  "Medigap",
  "Internet",
  "Garbage",
  "Waste",
  "Dogs",
  "Allowance",
];

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

/* The Monthly bills header's lights-on split: the sum of the
   in-effect amounts of the bills flagged Keep the lights on.
   Each bill's amountCents here is the amount in effect for the
   viewed month (0 when not yet in effect), so this plus the
   remainder (total − this) always foots to the header total. */
function lightsOnMonthlyCents(
  bills: { amountCents: number; keepLightsOn: boolean }[],
): number {
  return bills.reduce((s, b) => s + (b.keepLightsOn ? b.amountCents : 0), 0);
}

/* Wording for a True cost minus Target difference (cents):
   positive is over the target, negative is under it, zero is
   exactly on it. Shared by the spending charts' tooltips and
   their vs-target summary lines so the two always agree. */
function vsTargetWord(diffCents: number): string {
  if (diffCents > 0) return "over target";
  if (diffCents < 0) return "under target";
  return "on target";
}

/* Short range label for a span of YYYY-MM month keys, e.g.
   "Aug–Nov 2026" within one year, "Nov 2025–Feb 2026" across
   years. Used by the spending charts' vs-target summary lines
   to name exactly the recorded months they total. */
function monthRangeLabel(firstMonth: string, lastMonth: string): string {
  const startShort =
    MONTH_SHORT[Number(firstMonth.slice(5, 7)) - 1] ?? firstMonth;
  const endShort =
    MONTH_SHORT[Number(lastMonth.slice(5, 7)) - 1] ?? lastMonth;
  if (firstMonth === lastMonth) return `${startShort} ${firstMonth.slice(0, 4)}`;
  if (firstMonth.slice(0, 4) === lastMonth.slice(0, 4)) {
    return `${startShort}–${endShort} ${lastMonth.slice(0, 4)}`;
  }
  return `${startShort} ${firstMonth.slice(0, 4)}–${endShort} ${lastMonth.slice(0, 4)}`;
}

function parseDollars(s: string): number | null {
  const cleaned = s.replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/* Display form for a cents amount inside a text input: grouped
   thousands, cents shown only when the amount has them, no $
   (the field carries a $ adornment). parseDollars strips the
   grouping commas, so this string round-trips exactly — the
   same convention as rothShared's fmtMoneyInput. */
function fmtInputMoney(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    maximumFractionDigits: 2,
  });
}

type Frequency = "yearly" | "bimonthly" | "quarterly" | "semiannual";

function paymentsPerYearFor(f: string): number {
  if (f === "bimonthly") return 6;
  if (f === "quarterly") return 4;
  if (f === "semiannual") return 2;
  return 1;
}

/* Cumulative rounding for a smoothed bill's monthly set-aside —
   the client mirror of the server's one implementation
   (spendingCore's monthlyAccrualForAnnual): the set-aside for
   calendar month n is round(annual × n/12) − round(annual ×
   (n−1)/12), so twelve monthly set-asides sum to the annual
   amount exactly. Used only for form previews; every displayed
   figure comes from the server. */
function cumulativeMonthlyCents(annualCents: number, month: string): number {
  const n = Number(month.slice(5, 7));
  if (!Number.isInteger(n) || n < 1 || n > 12) return Math.round(annualCents / 12);
  return Math.round((annualCents * n) / 12) - Math.round((annualCents * (n - 1)) / 12);
}

function freqPhrase(f: string): string {
  if (f === "bimonthly") return "every other month";
  if (f === "quarterly") return "every 3 months";
  if (f === "semiannual") return "every 6 months";
  return "yearly";
}

function monthLabel(month: string): string {
  const y = month.slice(0, 4);
  const m = Number(month.slice(5, 7));
  return `${MONTH_NAMES[m - 1] ?? ""} ${y}`;
}

/* Days in the month named by a YYYY-MM key, leap-year aware —
   the client mirror of the server's day rule (spendingCore's
   daysInMonthOf), used as the cash-out item form's date
   validation backstop. */
function daysInMonthOf(month: string): number {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return new Date(y, m, 0).getDate();
}

/* English ordinal for a day of the month: 1st, 2nd, 3rd, 4th, …,
   11th, 12th, 13th, …, 21st, 22nd, 23rd, …, 31st. */
function ordinalDay(day: number): string {
  const mod100 = day % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function currentMonth(): string {
  return todayStr().slice(0, 7);
}

/* ---------------- CSV parsing ----------------
   The parser lives in ./csvUtil (parseCsvChecked): the same
   grammar this importer has always used, with the import
   budget (size / row / field limits, unclosed-quote refusal)
   enforced around it — finding S4. The import panel's own
   decisions (date and amount reading, debit/credit pairing,
   column mapping, remembered profiles, duplicate flagging)
   live in ./importParseCore, shared with the server-side
   accuracy fixtures so the suite pins the code the panel runs. */

/* ---------------- small pieces ---------------- */

/* One Quick view cell: label + value (children) plus an info badge
   inset inside the cell's top-right corner. Cells are borderless —
   they sit inside one card per group (see renderMonthTiles) and
   are divided from their neighbours by hairlines carried in the
   className each caller passes. The badge toggles a plain-words
   tooltip on tap/click; hovering or focusing the badge itself
   shows it too (hovering the rest of the cell does not) — the
   tooltip carries the cell's definition, which does not
   print on the cell's face. The tooltip panel hangs directly
   below the badge, aligned to it (panelCls picks the horizontal
   alignment relative to the badge: centred under it, or its
   right edge flush with the badge's), so it opens beside the
   badge that triggered it rather than at the card's edge below
   the whole cell. Tapping outside closes a toggled tooltip.
   Escape dismisses the tooltip whenever it is showing — pinned
   or hover-shown — and it stays dismissed until a fresh hover,
   focus, or tap entry on the badge (or panel) reopens it; the
   badge's aria-expanded always matches actual visibility. The
   label reserves right padding so
   it never runs under the badge. Cells are compact: height fits
   the label + value. When the cell has a details target, the
   whole cell is the tap/click target: an invisible button
   stretched over the cell (named "Details for <label>", exactly
   like the old "Details ↓" row it replaces) handles the click
   and the keyboard, while the ⓘ badge sits above it and never
   triggers the details action. */
function QuickTile({
  label,
  tip,
  tipId,
  panelCls,
  className = "",
  open,
  onToggle,
  onClose,
  onDetails,
  children,
}: {
  label: string;
  tip: string;
  tipId: string;
  panelCls: string;
  className?: string;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onDetails?: () => void;
  children: ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  // Set by Escape: hides the tooltip and keeps it hidden while focus
  // (or the pointer) merely stays on the badge. Cleared only by a
  // fresh deliberate activation or a fresh hover/focus entry — badge
  // mouse-enter, badge focus, badge click/tap, or tooltip-panel
  // mouse-enter — so moving the pointer away and back, tabbing away
  // and back, or tapping the badge reopens it, but sitting on the
  // badge after Escape does not.
  const [dismissed, setDismissed] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const show = (open || hovered) && !dismissed;

  useEffect(() => {
    if (!show) return;
    const onDoc = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      onClose();
      setHovered(false);
      setDismissed(true);
    };
    document.addEventListener("pointerdown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [show, onClose]);

  return (
    <div
      ref={ref}
      className={`group relative flex flex-col p-3.5 sm:p-4 ${className}`}
    >
      {onDetails && (
        <button
          type="button"
          aria-label={`Details for ${label}`}
          onClick={onDetails}
          className="absolute inset-0 z-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
        />
      )}
      <div className="pointer-events-none relative z-10 flex flex-col">
        <p className="pr-6 text-[10.5px] leading-tight font-medium tracking-[0.02em] text-[var(--dim)] uppercase">
          {label}
        </p>
        {children}
      </div>
      <div className="absolute top-2 right-2 z-20">
        <button
          type="button"
          aria-label={`How ${label} is calculated`}
          aria-expanded={show}
          aria-controls={tipId}
          onClick={(e) => {
            e.stopPropagation();
            setDismissed(false);
            onToggle();
          }}
          onMouseEnter={() => {
            setDismissed(false);
            setHovered(true);
          }}
          onMouseLeave={() => setHovered(false)}
          onFocus={() => {
            setDismissed(false);
            setHovered(true);
          }}
          onBlur={() => setHovered(false)}
          className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--dim)] hover:text-[var(--accent)] focus-visible:text-[var(--accent)]"
        >
          <svg
            width="12"
            height="12"
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
          <div
            id={tipId}
            role="tooltip"
            onMouseEnter={() => {
              setDismissed(false);
              setHovered(true);
            }}
            onMouseLeave={() => setHovered(false)}
            className={`absolute top-full z-30 mt-1.5 w-64 max-w-[calc(100vw-2.5rem)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3 text-[13px] leading-snug font-normal whitespace-normal normal-case shadow-lg ${panelCls}`}
          >
            {tip}
          </div>
        )}
      </div>
    </div>
  );
}

/* Small ⓘ info button + tooltip carrying one short definition
   verbatim, following the app's bucket-definition tooltip pattern
   (NetWorth's BucketHelp): hovering or focusing the button shows
   the bubble, tapping or clicking pins it open, tapping outside
   or pressing Escape closes a pinned bubble. Used beside the
   "Actual average" label in the True cost section. */
function InfoTip({
  text,
  ariaLabel,
}: {
  text: string;
  ariaLabel: string;
}) {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const rawId = useId();
  const tipId = `info-tip-${rawId.replace(/[^a-zA-Z0-9]/g, "")}`;
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
          className="absolute top-full left-0 z-40 mt-1.5 block w-52 max-w-[calc(100vw-3rem)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-2.5 text-xs leading-relaxed font-normal whitespace-normal text-[var(--text)] shadow-lg"
        >
          {text}
        </span>
      )}
    </span>
  );
}

/* Small muted return link placed at the top of each Quick view
   destination section: smooth-scrolls back to the Quick view strip. */
function QuickViewReturnLink({ onReturn }: { onReturn: () => void }) {
  return (
    <button
      type="button"
      aria-label="Back to Quick view"
      onClick={onReturn}
      className="text-xs font-medium text-[var(--dim)] underline-offset-2 hover:text-[var(--accent)] hover:underline focus-visible:text-[var(--accent)] focus-visible:underline"
    >
      ↑ Quick view
    </button>
  );
}

/* Chip chevron expand/collapse affordance for the bills
   rosters' and the Transactions list's section headers. The
   visible control is the shared FoldChevron chip (crisp SVG
   chevron that rotates with state); the accessible name stays
   "Show bills" / "Hide bills" (or the caller's show/hide labels,
   e.g. "Show transactions" / "Hide transactions"), and the caller
   keeps aria-expanded / aria-controls wired to the same persisted
   fold state as before. The button box stays a comfortable 36px
   tap target around the 28px chip. */
function BillsFoldChevron({
  open,
  controlsId,
  onToggle,
  showLabel = "Show bills",
  hideLabel = "Hide bills",
}: {
  open: boolean;
  controlsId: string;
  onToggle: () => void;
  showLabel?: string;
  hideLabel?: string;
}) {
  return (
    <button
      type="button"
      aria-label={open ? hideLabel : showLabel}
      aria-expanded={open}
      aria-controls={controlsId}
      onClick={onToggle}
      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] text-[var(--dim)] hover:text-[var(--accent)] focus-visible:text-[var(--accent)]"
    >
      <FoldChevron open={open} />
    </button>
  );
}

const inputCls =
  "w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)]";
const labelCls = "block text-sm font-medium text-[var(--text)] mb-1";
const btnPrimary =
  "rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2 text-base font-medium text-white disabled:opacity-50";
const btnGhost =
  "rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-medium text-[var(--text)]";
/* Compact Add button for the Spending sections' standard header
   rows: a small OUTLINE style — accent border and accent text on a
   transparent ground, so no filled teal block appears in any section
   header. Still a clear ≥36px touch target (min-h-9). One style for
   every section header's Add control; filled teal (btnPrimary) is
   reserved for submit/primary buttons inside dialogs and forms. */
const btnAdd =
  "inline-flex min-h-9 items-center justify-center rounded-[var(--radius)] border border-[var(--accent)] bg-transparent px-3 py-1.5 text-sm font-semibold text-[var(--accent)] disabled:opacity-50";

/* In-place amount editor for one Monthly bill row: shown when the
   row is tapped open. It carries the same fields and the same save
   as the Edit form's amount half — a monthly amount plus the month
   it takes effect from — and saves through the same
   setMonthlyBillAmount action (via the caller's onSave, which adds
   the restore epoch and the CAS base for the version at that
   month), so an amount saved here lands exactly as one saved from
   the form: from that month on, earlier months unchanged. The
   component mounts fresh each time its row opens, so its fields
   always start from the bill's latest amount and this month. */
function BillAmountEditor({
  bill,
  onSave,
}: {
  bill: Bill;
  onSave: (input: {
    billId: number;
    amountCents: number;
    effectiveFrom: string;
    base: { amountCents: number | null };
  }) => Promise<{ ok: boolean; reason?: string }>;
}) {
  const [dollars, setDollars] = useState(String(bill.latestAmountCents / 100));
  const [from, setFrom] = useState(currentMonth());
  const [error, setError] = useState("");
  const [savedFrom, setSavedFrom] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    const cents = parseDollars(dollars);
    if (cents == null || cents < 0) {
      setError("Enter the monthly amount.");
      setSavedFrom(null);
      return;
    }
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(from)) {
      setError("Pick the month the amount takes effect from.");
      setSavedFrom(null);
      return;
    }
    setSaving(true);
    setError("");
    const r = await onSave({
      billId: bill.id,
      amountCents: cents,
      effectiveFrom: from,
      base: {
        amountCents:
          bill.history.find((h) => h.effectiveFrom === from)?.amountCents ??
          null,
      },
    });
    setSaving(false);
    if (!r.ok) {
      setError(r.reason ?? "That bill amount could not be saved.");
      setSavedFrom(null);
      return;
    }
    setSavedFrom(from);
  }

  return (
    <form onSubmit={save} className="mt-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm">
          <span className="mb-1 block text-[var(--dim)]">Amount ($/mo)</span>
          <input
            type="text"
            inputMode="decimal"
            aria-label={`Monthly amount for ${bill.name}`}
            className="w-28 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm text-[var(--text)]"
            value={dollars}
            onChange={(e) => {
              setDollars(e.target.value);
              setSavedFrom(null);
            }}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-[var(--dim)]">Takes effect from</span>
          <input
            type="month"
            aria-label={`Month the amount for ${bill.name} takes effect from`}
            className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm text-[var(--text)]"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setSavedFrom(null);
            }}
          />
        </label>
        <button
          type="submit"
          className={btnGhost}
          disabled={saving}
          aria-label={`Save amount for ${bill.name}`}
        >
          Save amount
        </button>
      </div>
      <p className="mt-1 text-xs text-[var(--dim)]">
        Applies from that month on — earlier months keep the amount
        that was in effect then.
      </p>
      {error && <p className="mt-1 text-sm text-[var(--bad)]">{error}</p>}
      {savedFrom && (
        <p className="mt-1 text-sm text-[var(--accent)]">
          Saved — applies from {monthLabel(savedFrom)}.
        </p>
      )}
    </form>
  );
}

// Category field for the bill forms: a select that ALWAYS lists every
// preset (plus any custom categories already in use), with a
// "Type your own…" choice that swaps in a free-text input. This replaces
// a text input + <datalist>: browsers filter datalist suggestions by the
// text already in the field, so a field prefilled with "Uncategorized"
// only ever suggested "Uncategorized" — the other categories were
// effectively unpickable. A native <select> never filters its options.
const CUSTOM_CATEGORY = "__custom__";

function CategoryField({
  id,
  value,
  options,
  onChange,
  // Build v139: the cash-out Name field reuses this picker with
  // its own wording — the custom-choice label, the custom-input
  // placeholder and aria-label, and the empty-value placeholder
  // option. Defaults keep the bill-category wording unchanged.
  // Build v143: the one-off Description field reuses it the same
  // way, with its own parallel wording.
  customLabel = "Type your own…",
  customPlaceholder = "Type a custom category",
  customAriaLabel = "Custom category",
  placeholderOption,
}: {
  id: string;
  value: string;
  options: string[];
  onChange: (next: string) => void;
  customLabel?: string;
  customPlaceholder?: string;
  customAriaLabel?: string;
  placeholderOption?: string;
}) {
  const isKnown = options.includes(value);
  // An empty value starts in select mode (not custom mode): a fresh
  // form shows the dropdown with the placeholder option, and the
  // text input appears only after picking the custom choice.
  const [custom, setCustom] = useState(value !== "" && !isKnown);
  const selectValue = custom ? CUSTOM_CATEGORY : value;
  return (
    <>
      <select
        id={id}
        className={inputCls}
        value={selectValue}
        required
        onChange={(e) => {
          const v = e.target.value;
          if (v === CUSTOM_CATEGORY) {
            setCustom(true);
            if (isKnown) onChange("");
          } else {
            setCustom(false);
            onChange(v);
          }
        }}
      >
        {placeholderOption != null && value === "" && !custom && (
          <option value="" disabled>{placeholderOption}</option>
        )}
        {options.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
        <option value={CUSTOM_CATEGORY}>{customLabel}</option>
      </select>
      {custom && (
        <input
          id={`${id}-custom`}
          type="text"
          className={`${inputCls} mt-2`}
          value={value}
          required
          onChange={(e) => onChange(e.target.value)}
          placeholder={customPlaceholder}
          aria-label={customAriaLabel}
        />
      )}
    </>
  );
}

/* Inline payment form that lives inside a yearly / periodic bill card.
   Bound to that one bill: the smoothed-bill link is fixed, Kind is
   fixed to Spending, and the other fields are pre-filled from the
   bill but remain editable. Saving goes through the same
   addTransaction action the generic form uses. */
function InlinePaymentForm({
  bill,
  viewedMonth,
  onClose,
  onSaved,
}: {
  bill: Yearly;
  viewedMonth: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const expectedCents = bill.inEffectForMonth
    ? bill.expectedCents
    : bill.latestExpectedCents;
  const [date, setDate] = useState(() => {
    const today = todayStr();
    return today.slice(0, 7) === viewedMonth ? today : `${viewedMonth}-01`;
  });
  const [desc, setDesc] = useState(bill.name);
  const [dollars, setDollars] = useState(
    expectedCents ? String(expectedCents / 100) : "",
  );
  const [source, setSource] = useState<"checking" | "card">(
    bill.paidByType === "card" ? "card" : "checking",
  );
  const [account, setAccount] = useState(bill.paidByName);
  const [category, setCategory] = useState(bill.category || "Other");
  const [error, setError] = useState("");

  const addTxn = useMutation({
    mutationFn: (input: TxnInput) => api.addTransaction(input),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (e) => setError(String(e)),
  });

  const categoryOptions = useMemo(() => {
    const s = new Set<string>(CATEGORIES);
    if (bill.category) s.add(bill.category);
    if (category) s.add(category);
    return [...s];
  }, [bill.category, category]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const cents = parseDollars(dollars);
    if (cents == null || cents === 0) {
      setError("Enter an amount, e.g. 42.50");
      return;
    }
    if (!desc.trim()) {
      setError("Give it a short description.");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setError("Pick the date it left the bank account.");
      return;
    }
    addTxn.mutate({
      date,
      description: desc.trim(),
      amountCents: Math.abs(cents),
      sourceType: source,
      accountName: account.trim() || "Checking",
      kind: "spending",
      category: category.trim() || "Other",
      yearlyExpenseId: bill.id,
      fitId: null,
    });
  }

  const idBase = `rp-${bill.id}`;

  return (
    <form
      onSubmit={submit}
      aria-label={`Record payment for ${bill.name}`}
      className="mt-3 space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-alt)] p-3 sm:p-4"
    >
      <div>
        <h4 className="display text-base font-semibold">
          Record payment — {bill.name}
        </h4>
        <p className="mt-0.5 text-sm leading-relaxed text-[var(--dim)]">
          Linked to this bill — it will count toward “Paid this year”, the
          Quick view paid-out total, and True cost for the month the money
          left your bank account (the date below). The link can’t be cleared
          here.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor={`${idBase}-date`} className={labelCls}>
            Date it left the bank account
          </label>
          <input
            id={`${idBase}-date`}
            type="date"
            required
            className={inputCls}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          {source === "card" ? (
            <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">
              Charged to a card first? Enter the date the card payment left
              your bank account — the payment counts in that month.
            </p>
          ) : (
            <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">
              The day it left checking — the payment counts in that month.
            </p>
          )}
        </div>
        <div>
          <label htmlFor={`${idBase}-amount`} className={labelCls}>
            Amount ($)
          </label>
          <input
            id={`${idBase}-amount`}
            type="text"
            inputMode="decimal"
            required
            placeholder="0.00"
            className={inputCls}
            value={dollars}
            onChange={(e) => setDollars(e.target.value)}
          />
          {expectedCents ? (
            <p className="mt-1 text-xs text-[var(--dim)]">
              Expected {fmt(expectedCents)} — edit if the actual differed.
            </p>
          ) : null}
        </div>
      </div>
      <div>
        <label htmlFor={`${idBase}-desc`} className={labelCls}>
          Description
        </label>
        <input
          id={`${idBase}-desc`}
          type="text"
          required
          className={inputCls}
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor={`${idBase}-source`} className={labelCls}>
            Paid from
          </label>
          <select
            id={`${idBase}-source`}
            className={inputCls}
            value={source}
            onChange={(e) => setSource(e.target.value as "checking" | "card")}
          >
            <option value="checking">Checking</option>
            <option value="card">Credit card</option>
          </select>
        </div>
        <div>
          <label htmlFor={`${idBase}-account`} className={labelCls}>
            Account name
          </label>
          <input
            id={`${idBase}-account`}
            type="text"
            className={inputCls}
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            list="account-names"
          />
        </div>
      </div>
      <div>
        <label htmlFor={`${idBase}-category`} className={labelCls}>
          Category
        </label>
        <select
          id={`${idBase}-category`}
          className={inputCls}
          value={categoryOptions.includes(category) ? category : ""}
          onChange={(e) => setCategory(e.target.value)}
        >
          {!categoryOptions.includes(category) && (
            <option value="">{category}</option>
          )}
          {categoryOptions.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-[var(--dim)]">
          Pre-filled from the bill. Kind is Spending — fixed for a bill
          payment.
        </p>
      </div>
      {error && <p className="text-sm text-[var(--bad)]">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          className={btnPrimary}
          disabled={addTxn.isPending}
        >
          {addTxn.isPending ? "Saving…" : "Save payment"}
        </button>
        <button type="button" className={btnGhost} onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/* ---------------- slice & dice explorer ---------------- */

type ExplorerData = ApiResponse<typeof api, "getExplorer">;
type ExplorerMonthLinesData = ApiResponse<typeof api, "getExplorerMonthLines">;
type ExplorerGroupBy = "category" | "bill" | "paidFrom" | "keepLightsOn" | "month";

/* One line in the drill-down panel: part of what a tapped
   number is made of. Indented lines sit under the line above
   them (the cash-out lines under Cash out, the set-asides
   under Set-asides). */
type DrillLine = { label: string; detail?: string | null; amountCents: number; indent?: boolean };

/* What the drill-down panel below the grid is showing:
   - "lines": composed client-side from the row's members (a
     bill group's bills for one month, or a row's range total)
     — also a single expanded member's own lines (itself for
     one month, or one line per month for its range total);
   - "other": the Other spending row's cell for one month —
     composed from getExplorerMonthLines when it loads;
   - "month": one measure cell of the Month grouping for one
     month — likewise composed from getExplorerMonthLines;
   - "memberPart": one composition part of the Other spending
     row for one month (an expanded member cell) — likewise
     composed from getExplorerMonthLines.
   Every panel's lines foot exactly to its total. For the
   "lines" kind that total is the tapped number, from the same
   grid read as the lines. For "other" / "month" /
   "memberPart" the lines come from the second read, so the
   panel's total is checked against that read's own
   authoritative figure for the measure (see
   authoritativeDrillTotalCents): when an edit landed between
   the two reads the tapped total is stale, and the panel
   totals to the current figure, says so, and refreshes the
   grid instead of pairing fresh lines with the stale total
   (round-9 SHOULD-4). */
type DrillState =
  | { kind: "lines"; title: string; lines: DrillLine[]; totalCents: number }
  | { kind: "other"; title: string; month: string; totalCents: number }
  | {
      kind: "month";
      title: string;
      month: string;
      measure: "cashOut" | "trueCost" | "totalMonthly" | "yearlyPaidOut" | "everythingElse" | "oneOffs";
      totalCents: number;
    }
  | {
      kind: "memberPart";
      title: string;
      month: string;
      /* Which of the residual row's three composition parts.
         Identified by the member's index in the row's members
         array — the server's construction order in getExplorer
         (actions.ts) is fixed: 0 "Cash out", 1 "Monthly bills",
         2 "Yearly bills paid out" — never by the member's name. */
      partIndex: 0 | 1 | 2;
      totalCents: number;
    };

const GROUP_BY_OPTIONS: { value: ExplorerGroupBy; label: string; column: string }[] = [
  { value: "category", label: "Category", column: "Category" },
  { value: "bill", label: "Bill", column: "Bill" },
  { value: "paidFrom", label: "Paid from", column: "Paid from" },
  { value: "keepLightsOn", label: "Keep the lights on", column: "Keep the lights on" },
  { value: "month", label: "Month", column: "Month" },
];

function shortMonthLabel(m: string): string {
  const mo = Number(m.slice(5, 7));
  return `${MONTH_SHORT[mo - 1] ?? ""} ${m.slice(0, 4)}`;
}

function csvEscape(v: string): string {
  // Formula neutralization first (csvUtil, finding S2): a
  // user-typed label that starts with = + - @ must reach the
  // spreadsheet as literal text, never as a formula.
  const safe = csvFormulaSafeText(v);
  if (/[",\n]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}

function csvMoney(cents: number): string {
  return (cents / 100).toFixed(2);
}

/* The settlement-basis lines behind one month's yearly
   paid-out / smoothed-bills-paid figure, composed from the
   month-lines read: each line's amount is the portion the
   core's FIFO walk attributes to one bill, so the lines foot
   to the figure exactly. A card payment's full amount (and the
   charge's amount, when the payment settles only part of it)
   is named in the detail as context — never as the line
   amount. Shared by the explorer's yearly-paid-out drill and
   the dashboard's Smoothed bills paid breakdown panel, so both
   surfaces show the same lines for the same month. */
function yearlyPaidOutDrillLines(ml: ExplorerMonthLinesData): DrillLine[] {
  if (ml.yearlyPaidOutLines.length === 0) {
    return [
      {
        label: "Yearly & periodic bills paid out",
        detail: "counted in the settlement month, net of refunds — nothing settled this month",
        amountCents: ml.yearlyPaidOutCents,
      },
    ];
  }
  return ml.yearlyPaidOutLines.map((l) => {
    let detail = l.detail ?? "";
    if (l.kind === "card_payment") {
      const parts: string[] = [];
      if (l.fullAmountCents !== l.amountCents) {
        parts.push(`${fmt(l.amountCents)} of the ${fmt(l.fullAmountCents)} payment counts here`);
      }
      if (l.chargeCents != null && l.chargeCents !== l.amountCents) {
        parts.push(`part of the ${fmt(l.chargeCents)} charge`);
      }
      if (parts.length > 0) detail = detail ? `${detail} · ${parts.join(" · ")}` : parts.join(" · ");
    }
    return { label: l.label, detail: detail || null, amountCents: l.amountCents };
  });
}

/* The authoritative total for a month-based drill, read off
   the month-lines response itself — the figure the composed
   lines foot to, for the tapped measure. The grid cell the
   user tapped was priced by an earlier, independent read, so
   after an intervening edit (for example in another tab) the
   tapped total and this figure can disagree; this one is
   current. The residual ("other") drill composes Cash out −
   monthly bills − yearly paid out, which is the response's
   everything-else figure. */
function authoritativeDrillTotalCents(
  d: Exclude<DrillState, { kind: "lines" }>,
  ml: ExplorerMonthLinesData,
): number {
  if (d.kind === "other") return ml.everythingElseCents;
  if (d.kind === "memberPart") {
    // The part's own figure in the month-lines read: Cash out
    // at cashOutCents; the other two parts are the negative of
    // their bill totals, matching how getExplorer built them.
    return d.partIndex === 0
      ? ml.cashOutCents
      : d.partIndex === 1
        ? -ml.monthlyTotalCents
        : -ml.yearlyPaidOutCents;
  }
  switch (d.measure) {
    case "cashOut":
      return ml.cashOutCents;
    case "trueCost":
      return ml.trueCostCents;
    case "totalMonthly":
      return ml.monthlyTotalCents;
    case "yearlyPaidOut":
      return ml.yearlyPaidOutCents;
    case "everythingElse":
      return ml.everythingElseCents;
    case "oneOffs":
      return ml.oneOffsCents;
  }
}

/* The drill-down panel's line list: the lines behind one
   tapped number, footing to its total. */
function DrillLines({ lines, totalCents }: { lines: DrillLine[]; totalCents: number }) {
  return (
    <div className="tnum mt-2 text-sm">
      {lines.map((l, i) => (
        <div key={i} className={`flex items-baseline justify-between gap-3 py-1${l.indent ? " pl-5" : ""}`}>
          <span className={l.indent ? "text-[var(--dim)]" : undefined}>
            {l.label}
            {l.detail && <span className="block text-xs font-normal text-[var(--dim)]">{l.detail}</span>}
          </span>
          <span className="whitespace-nowrap">{fmt(l.amountCents)}</span>
        </div>
      ))}
      <div className="mt-1 flex items-baseline justify-between gap-3 border-t border-[var(--border)] pt-2 font-semibold">
        <span>Total</span>
        <span className="whitespace-nowrap">{fmt(totalCents)}</span>
      </div>
    </div>
  );
}

function ExplorerModal({
  viewedMonth,
  earliestMonth,
  initialGroupBy = "category",
  onClose,
}: {
  viewedMonth: string;
  earliestMonth: string | null;
  initialGroupBy?: ExplorerGroupBy;
  onClose: () => void;
}) {
  const [fromMonth, setFromMonth] = useState(earliestMonth ?? viewedMonth);
  const [toMonth, setToMonth] = useState(viewedMonth);
  const [groupBy, setGroupBy] = useState<ExplorerGroupBy>(initialGroupBy);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rangeInvalid = fromMonth > toMonth;
  const rangeMonths =
    !rangeInvalid && /^\d{4}-\d{2}$/.test(fromMonth) && /^\d{4}-\d{2}$/.test(toMonth)
      ? (Number(toMonth.slice(0, 4)) - Number(fromMonth.slice(0, 4))) * 12 +
        (Number(toMonth.slice(5, 7)) - Number(fromMonth.slice(5, 7))) +
        1
      : 0;
  const rangeCapped = rangeMonths > 36;

  const explorer = useQuery({
    queryKey: ["explorer", fromMonth, toMonth, groupBy],
    queryFn: () => api.getExplorer({ fromMonth, toMonth, groupBy }),
    enabled: !rangeInvalid && rangeMonths > 0,
  });
  const ex: ExplorerData | undefined = explorer.data;

  /* ---- Drill-down: row expansion + per-cell lines ----
     Expansion is keyed by row (label + index, the row's own
     key); the drill panel shows one tapped cell at a time.
     Both reset whenever the range or grouping changes, since
     the rows they point at are rebuilt by the new query. */
  const [expandedRows, setExpandedRows] = useState<ReadonlySet<string>>(new Set());
  const [drill, setDrill] = useState<DrillState | null>(null);
  useEffect(() => {
    setExpandedRows(new Set());
    setDrill(null);
  }, [groupBy, fromMonth, toMonth]);

  const drillMonth = drill && drill.kind !== "lines" ? drill.month : null;
  const monthLines = useQuery({
    queryKey: ["explorerMonthLines", drillMonth],
    queryFn: () => api.getExplorerMonthLines({ month: drillMonth ?? "" }),
    enabled: drillMonth != null,
  });

  const drillRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (drill) drillRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [drill]);

  /* Stale-total guard (round-9 SHOULD-4): for the month-based
     drill kinds the tapped total came from the grid read while
     the lines come from the month-lines read above — two
     independent reads. When they disagree (an edit landed
     between them, e.g. in another tab), the panel must not
     pair the fresh lines with the stale tapped total: it
     totals to the read's own authoritative figure, says the
     figure changed, and the grid is refreshed so its cells
     agree. The refetch fires once per distinct mismatch
     (keyed by the tapped and current totals), never in a
     loop — after the refresh the panel keeps showing the
     notice for the tap that found the change. */
  const drillMl =
    drill && drill.kind !== "lines" && monthLines.data && monthLines.data.month === drill.month
      ? monthLines.data
      : null;
  const drillCurrentTotalCents =
    drill && drill.kind !== "lines" && drillMl
      ? authoritativeDrillTotalCents(drill, drillMl)
      : null;
  const drillStale =
    drill != null &&
    drill.kind !== "lines" &&
    drillCurrentTotalCents != null &&
    drillCurrentTotalCents !== drill.totalCents;
  const drillPanelTotalCents =
    drillStale && drillCurrentTotalCents != null
      ? drillCurrentTotalCents
      : (drill?.totalCents ?? 0);
  const staleRefetchKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!drillStale || !drill || drillCurrentTotalCents == null) return;
    const key = `${drill.kind}:${drill.month}:${drill.kind === "month" ? drill.measure : drill.kind === "memberPart" ? `part${drill.partIndex}` : ""}:${drill.totalCents}:${drillCurrentTotalCents}`;
    if (staleRefetchKeyRef.current === key) return;
    staleRefetchKeyRef.current = key;
    void explorer.refetch();
  }, [drillStale, drill, drillCurrentTotalCents, explorer]);

  function toggleRow(key: string) {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /* Lines for a bill-group cell, from the row's members: one
     line per bill in the group (zero lines dropped — they add
     nothing to the sum — unless every line is zero). */
  function memberLines(
    members: ExplorerData["rows"][number]["members"],
    pick: (mm: ExplorerData["rows"][number]["members"][number]) => number,
  ): DrillLine[] {
    const all = members.map((mm) => ({ label: mm.name, detail: mm.note, amountCents: pick(mm) }));
    const nonzero = all.filter((l) => l.amountCents !== 0);
    return nonzero.length > 0 ? nonzero : all;
  }

  function openGroupCell(
    r: ExplorerData["rows"][number],
    monthIdx: number | null,
    valueCents: number,
  ) {
    const monthKey = monthIdx != null ? (ex?.months[monthIdx] ?? "") : "";
    const when = monthIdx != null ? shortMonthLabel(monthKey) : "Total for the range";
    if (r.kind === "residual" && monthIdx != null) {
      setDrill({ kind: "other", title: `Other spending — ${when}`, month: monthKey, totalCents: valueCents });
      return;
    }
    setDrill({
      kind: "lines",
      title: `${r.label} — ${when}`,
      lines: memberLines(r.members, (mm) => (monthIdx != null ? (mm.valuesCents[monthIdx] ?? 0) : mm.totalCents)),
      totalCents: valueCents,
    });
  }

  /* One expanded member's own cell (round-9 NICE-8): a bill
     group's member drills to its own lines — itself for one
     month, one line per month for its range total. The
     residual row's members are its three composition parts:
     a range total still composes client-side (one line per
     month), but a single month needs the month-lines read, so
     it opens the "memberPart" drill. The part is identified
     by the member's index in the row — the server's
     construction order in getExplorer (actions.ts) is fixed:
     index 0 "Cash out", 1 "Monthly bills", 2 "Yearly bills
     paid out" — never by matching the member's name text. */
  function openMemberCell(
    r: ExplorerData["rows"][number],
    mm: ExplorerData["rows"][number]["members"][number],
    memberIdx: number,
    monthIdx: number | null,
    valueCents: number,
  ) {
    const monthKey = monthIdx != null ? (ex?.months[monthIdx] ?? "") : "";
    /* One line per month of the range for a member's range
       total — the memberLines convention: zero months dropped
       unless every month is zero. */
    const perMonthLines = (): DrillLine[] => {
      const all = (ex?.months ?? []).map((m, i) => ({
        label: shortMonthLabel(m),
        amountCents: mm.valuesCents[i] ?? 0,
      }));
      const nonzero = all.filter((l) => l.amountCents !== 0);
      return nonzero.length > 0 ? nonzero : all;
    };
    if (r.kind === "residual") {
      if (monthIdx != null) {
        setDrill({
          kind: "memberPart",
          title: `Other spending — ${mm.name} — ${shortMonthLabel(monthKey)}`,
          month: monthKey,
          partIndex: memberIdx as 0 | 1 | 2,
          totalCents: valueCents,
        });
        return;
      }
      setDrill({
        kind: "lines",
        title: `Other spending — ${mm.name} — Total for the range`,
        lines: perMonthLines(),
        totalCents: valueCents,
      });
      return;
    }
    if (monthIdx != null) {
      setDrill({
        kind: "lines",
        title: `${mm.name} — ${shortMonthLabel(monthKey)}`,
        lines: [{ label: mm.name, detail: mm.note, amountCents: valueCents }],
        totalCents: valueCents,
      });
      return;
    }
    setDrill({
      kind: "lines",
      title: `${mm.name} — Total for the range`,
      lines: perMonthLines(),
      totalCents: valueCents,
    });
  }

  function openMonthCell(
    monthKey: string,
    measure: Extract<DrillState, { kind: "month" }>["measure"],
    measureLabel: string,
    valueCents: number,
  ) {
    setDrill({
      kind: "month",
      title: `${measureLabel} — ${monthLabel(monthKey)}`,
      month: monthKey,
      measure,
      totalCents: valueCents,
    });
  }

  /* Compose the panel's lines for the month-based drill kinds
     from the loaded month lines. Every composition foots to
     the read's own figure for the measure by construction
     (see the server action) — the tapped figure whenever the
     two reads agree, the current figure when they do not:
     Other spending / Everything else = Cash out − monthly
     bills − yearly paid out; True cost = Cash out − yearly
     paid out + set-asides. */
  function monthDrillLines(d: Exclude<DrillState, { kind: "lines" }>, ml: ExplorerMonthLinesData): DrillLine[] {
    const basisDetail =
      ml.cashOutBasis === "items"
        ? "the month's cash-out lines"
        : ml.cashOutBasis === "entered"
          ? "entered as one month total"
          : "from checking transactions";
    const cashOutBlock: DrillLine[] = [
      { label: "Cash out", detail: basisDetail, amountCents: ml.cashOutCents },
      ...ml.cashOutLines.map((l) => ({ label: l.label, detail: l.detail, amountCents: l.amountCents, indent: true })),
    ];
    if (d.kind === "other") {
      return [
        ...cashOutBlock,
        { label: "Monthly bills", detail: "counted in the bill rows", amountCents: -ml.monthlyTotalCents },
        { label: "Yearly bills paid out", detail: "net settlements this month", amountCents: -ml.yearlyPaidOutCents },
      ];
    }
    if (d.kind === "memberPart") {
      // One composition part of the Other spending row for one
      // month, identified by the member's index (the server's
      // construction order in getExplorer: 0 Cash out,
      // 1 Monthly bills, 2 Yearly bills paid out). Each part's
      // lines foot to the part's own figure: Cash out to
      // cashOutCents, the bill parts negated to
      // −monthlyTotalCents / −yearlyPaidOutCents.
      if (d.partIndex === 0) return cashOutBlock;
      if (d.partIndex === 1) {
        return ml.monthlyBillLines.map((l) => ({
          label: l.label,
          detail: "Monthly bill",
          amountCents: -l.amountCents,
        }));
      }
      return yearlyPaidOutDrillLines(ml).map((l) => ({ ...l, amountCents: -l.amountCents }));
    }
    switch (d.measure) {
      case "cashOut":
        return cashOutBlock;
      case "trueCost":
        return [
          { label: "Cash out", detail: basisDetail, amountCents: ml.cashOutCents },
          { label: "Yearly bills paid out", detail: "net settlements this month", amountCents: -ml.yearlyPaidOutCents },
          { label: "Set-asides", detail: "yearly & periodic bills, smoothed", amountCents: ml.accrualCents },
          ...ml.accrualLines
            .filter((l) => l.amountCents !== 0)
            .map((l) => ({ label: l.label, detail: "monthly set-aside", amountCents: l.amountCents, indent: true })),
        ];
      case "totalMonthly":
        return ml.monthlyBillLines.map((l) => ({ label: l.label, detail: "Monthly bill", amountCents: l.amountCents }));
      case "yearlyPaidOut":
        return yearlyPaidOutDrillLines(ml);
      case "everythingElse":
        return [
          { label: "Cash out", detail: basisDetail, amountCents: ml.cashOutCents },
          { label: "Total monthly bills", amountCents: -ml.monthlyTotalCents },
          { label: "Yearly bills paid out", detail: "net settlements this month", amountCents: -ml.yearlyPaidOutCents },
        ];
      case "oneOffs":
        return ml.oneOffLines.map((l) => ({ label: l.label, detail: l.detail, amountCents: l.amountCents }));
    }
  }

  function downloadCsv() {
    if (!ex) return;
    const lines: string[] = [];
    if (groupBy === "month") {
      lines.push(
        ["Month", "Cash out", "True cost", "Total monthly", "Yearly paid out", "Everything else", "One-offs"]
          .map(csvEscape)
          .join(","),
      );
      for (const r of ex.monthRows) {
        lines.push(
          [
            monthLabel(r.month),
            csvMoney(r.cashOutCents),
            csvMoney(r.trueCostCents),
            csvMoney(r.totalMonthlyCents),
            csvMoney(r.yearlyPaidOutCents),
            csvMoney(r.everythingElseCents),
            csvMoney(r.oneOffsCents),
          ]
            .map(csvEscape)
            .join(","),
        );
      }
      const t = ex.monthTotals;
      lines.push(
        ["Total", csvMoney(t.cashOutCents), csvMoney(t.trueCostCents), csvMoney(t.totalMonthlyCents), csvMoney(t.yearlyPaidOutCents), csvMoney(t.everythingElseCents), csvMoney(t.oneOffsCents)]
          .map(csvEscape)
          .join(","),
      );
    } else {
      const colLabel = GROUP_BY_OPTIONS.find((o) => o.value === groupBy)?.column ?? "Group";
      lines.push([colLabel, ...ex.months.map((m) => shortMonthLabel(m)), "Total"].map(csvEscape).join(","));
      for (const r of ex.rows) {
        lines.push([r.label, ...r.valuesCents.map(csvMoney), csvMoney(r.totalCents)].map(csvEscape).join(","));
      }
      lines.push(["Grand total", ...ex.columnTotalsCents.map(csvMoney), csvMoney(ex.grandTotalCents)].map(csvEscape).join(","));
    }
    const blob = new Blob([lines.join("\n") + "\n"], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `spending-explorer-${ex.fromMonth}-to-${ex.toMonth}-by-${groupBy}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  const colLabel = GROUP_BY_OPTIONS.find((o) => o.value === groupBy)?.column ?? "Group";

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Slice & dice"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-t-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-xl sm:rounded-[var(--radius)]">
        <div className="flex items-start justify-between gap-3 border-b border-[var(--border)] p-4 sm:p-5">
          <div>
            <h2 className="display text-xl font-semibold">Slice &amp; dice</h2>
            <Explainer
              id="spending.sliceDice"
              label="Slice & dice"
              className="mt-0.5"
              summary="Explore bills by month over any date range — the first 36 months of the range are shown and exported; read-only: nothing here changes your data."
            >
              <p>
                Explore the data — bills by month over any date range. Monthly bills count at the amount in effect that month; yearly &amp; periodic bills count at their monthly set-aside. Category and Keep-the-lights-on groupings use each bill&rsquo;s current label for every month, past and present. The final Other spending row is the day-to-day money that isn&rsquo;t bills, on the True cost basis, so each month totals to its True cost. (In the Month grouping, Everything else is the same day-to-day money on the cash-out basis.) Tap a row&rsquo;s + to open it into what makes it up; tap any number to see the lines behind that month&rsquo;s figure. Read-only: nothing here changes your data.
              </p>
            </Explainer>
          </div>
          <button
            type="button"
            aria-label="Close Slice & dice"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--border)] text-lg text-[var(--text)]"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="border-b border-[var(--border)] p-4 sm:p-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div>
              <label htmlFor="ex-from" className={labelCls}>From month</label>
              <input id="ex-from" type="month" className={inputCls} value={fromMonth} onChange={(e) => { if (e.target.value) setFromMonth(e.target.value); }} />
            </div>
            <div>
              <label htmlFor="ex-to" className={labelCls}>To month</label>
              <input id="ex-to" type="month" className={inputCls} value={toMonth} onChange={(e) => { if (e.target.value) setToMonth(e.target.value); }} />
            </div>
            <div>
              <label htmlFor="ex-groupby" className={labelCls}>Group by</label>
              <select id="ex-groupby" className={inputCls} value={groupBy} onChange={(e) => setGroupBy(e.target.value as ExplorerGroupBy)}>
                {GROUP_BY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div className="flex items-end">
              <button type="button" className={`${btnPrimary} w-full`} disabled={!ex || explorer.isPending} onClick={downloadCsv}>
                Download CSV
              </button>
            </div>
          </div>
          <p className="mt-2 text-xs text-[var(--dim)]">The first 36 months of the range are shown and exported.</p>
          {rangeInvalid && (
            <p className="mt-2 text-sm text-[var(--bad)]">From month must be on or before To month.</p>
          )}
          {rangeCapped && !rangeInvalid && (
            <p className="mt-2 text-sm text-[var(--dim)]">Range is {rangeMonths} months — showing the first 36 months only.</p>
          )}
        </div>

        <div className="overflow-auto p-4 sm:p-5">
          {explorer.isPending && <p className="py-6 text-center text-[var(--dim)]">Loading…</p>}
          {explorer.error && <p className="py-6 text-center text-[var(--bad)]">Something went wrong loading the explorer. Try again.</p>}
          {ex && groupBy !== "month" && (
            ex.rows.length === 0 ? (
              <p className="rounded-[var(--radius)] border border-dashed border-[var(--border)] p-4 text-sm text-[var(--dim)]">No bills in this range.</p>
            ) : (
              <>
                <p className="mb-2 text-xs text-[var(--dim)]">Tap + to open a row into what makes it up; tap a number for that month&rsquo;s lines.</p>
                <div className="overflow-x-auto">
                  <table className="tnum w-full min-w-[540px] border-collapse text-sm">
                    <caption className="sr-only">Bills grouped by {colLabel}, by month</caption>
                    <thead>
                      <tr className="border-b border-[var(--border)] text-left">
                        <th scope="col" className="py-2 pr-3 font-semibold">{colLabel}</th>
                        {ex.months.map((m) => (
                          <th key={m} scope="col" className="py-2 pr-3 text-right font-semibold whitespace-nowrap">{shortMonthLabel(m)}</th>
                        ))}
                        <th scope="col" className="py-2 text-right font-semibold">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ex.rows.map((r, rowIdx) => {
                        const rowKey = `${r.label}-${rowIdx}`;
                        const isOther = r.kind === "residual";
                        const isOpen = expandedRows.has(rowKey);
                        const canExpand = r.members.length > 1;
                        return (
                          <Fragment key={rowKey}>
                            <tr className={`border-b border-[var(--border)]${isOther ? " bg-[var(--surface-alt)]" : ""}`}>
                              <th scope="row" className="py-2 pr-3 text-left font-medium">
                                <span className="flex items-start gap-1">
                                  {canExpand ? (
                                    <button
                                      type="button"
                                      aria-expanded={isOpen}
                                      aria-label={`${isOpen ? "Collapse" : "Expand"} ${r.label} row`}
                                      onClick={() => toggleRow(rowKey)}
                                      className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[var(--border)] text-[var(--dim)]"
                                    >
                                      <svg
                                        width="10"
                                        height="10"
                                        viewBox="0 0 16 16"
                                        fill="none"
                                        aria-hidden="true"
                                        className={`transition-transform duration-200 motion-reduce:transition-none${isOpen ? " rotate-90" : ""}`}
                                      >
                                        <path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                      </svg>
                                    </button>
                                  ) : (
                                    <span aria-hidden="true" className="w-5 shrink-0" />
                                  )}
                                  <span>
                                    {r.label}
                                    {isOther && (
                                      <span className="block text-xs font-normal text-[var(--dim)]">
                                        day-to-day · not bills · True cost basis
                                      </span>
                                    )}
                                  </span>
                                </span>
                              </th>
                              {r.valuesCents.map((v, i) => (
                                <td key={i} className="py-2 pr-3 text-right whitespace-nowrap">
                                  <button
                                    type="button"
                                    aria-label={`Lines behind ${r.label}, ${shortMonthLabel(ex.months[i] ?? "")}: ${fmt(v)}`}
                                    className="underline decoration-dotted underline-offset-4 hover:text-[var(--accent)]"
                                    onClick={() => openGroupCell(r, i, v)}
                                  >
                                    {fmt(v)}
                                  </button>
                                </td>
                              ))}
                              <td className="py-2 text-right font-semibold whitespace-nowrap">
                                <button
                                  type="button"
                                  aria-label={`Lines behind ${r.label} total: ${fmt(r.totalCents)}`}
                                  className="underline decoration-dotted underline-offset-4 hover:text-[var(--accent)]"
                                  onClick={() => openGroupCell(r, null, r.totalCents)}
                                >
                                  {fmt(r.totalCents)}
                                </button>
                              </td>
                            </tr>
                            {isOpen &&
                              r.members.map((mm, mi) => (
                                <tr key={`${rowKey}-member-${mi}`} className={`border-b border-[var(--border)]${isOther ? " bg-[var(--surface-alt)]" : ""}`}>
                                  <th scope="row" className="py-1.5 pr-3 pl-9 text-left font-normal text-[var(--dim)]">
                                    {mm.name}
                                    <span className="block text-xs">{mm.note}</span>
                                  </th>
                                  {mm.valuesCents.map((v, i) => (
                                    <td key={i} className="py-1.5 pr-3 text-right whitespace-nowrap text-[var(--dim)]">
                                      <button
                                        type="button"
                                        aria-label={`Lines behind ${mm.name}, ${shortMonthLabel(ex.months[i] ?? "")}: ${fmt(v)}`}
                                        className="underline decoration-dotted underline-offset-4 hover:text-[var(--accent)]"
                                        onClick={() => openMemberCell(r, mm, mi, i, v)}
                                      >
                                        {fmt(v)}
                                      </button>
                                    </td>
                                  ))}
                                  <td className="py-1.5 text-right whitespace-nowrap text-[var(--dim)]">
                                    <button
                                      type="button"
                                      aria-label={`Lines behind ${mm.name} total: ${fmt(mm.totalCents)}`}
                                      className="underline decoration-dotted underline-offset-4 hover:text-[var(--accent)]"
                                      onClick={() => openMemberCell(r, mm, mi, null, mm.totalCents)}
                                    >
                                      {fmt(mm.totalCents)}
                                    </button>
                                  </td>
                                </tr>
                              ))}
                          </Fragment>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="font-semibold">
                        <th scope="row" className="py-2 pr-3 text-left">Grand total</th>
                        {ex.columnTotalsCents.map((v, i) => (
                          <td key={i} className="py-2 pr-3 text-right whitespace-nowrap">{fmt(v)}</td>
                        ))}
                        <td className="py-2 text-right whitespace-nowrap">{fmt(ex.grandTotalCents)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </>
            )
          )}
          {ex && groupBy === "month" && (
            <div className="overflow-x-auto">
              <table className="tnum w-full min-w-[640px] border-collapse text-sm">
                <caption className="sr-only">Spending by month</caption>
                <thead>
                  <tr className="border-b border-[var(--border)] text-left">
                    <th scope="col" className="py-2 pr-3 font-semibold">Month</th>
                    <th scope="col" className="py-2 pr-3 text-right font-semibold whitespace-nowrap">Cash out</th>
                    <th scope="col" className="py-2 pr-3 text-right font-semibold whitespace-nowrap">True cost</th>
                    <th scope="col" className="py-2 pr-3 text-right font-semibold whitespace-nowrap">Total monthly</th>
                    <th scope="col" className="py-2 pr-3 text-right font-semibold whitespace-nowrap">Yearly paid out</th>
                    <th scope="col" className="py-2 pr-3 text-right font-semibold whitespace-nowrap">Everything else</th>
                    <th scope="col" className="py-2 text-right font-semibold whitespace-nowrap">One-offs</th>
                  </tr>
                </thead>
                <tbody>
                  {ex.monthRows.map((r) => (
                    <tr key={r.month} className="border-b border-[var(--border)]">
                      <th scope="row" className="py-2 pr-3 text-left font-medium whitespace-nowrap">{monthLabel(r.month)}</th>
                      {(
                        [
                          ["cashOut", "Cash out", r.cashOutCents],
                          ["trueCost", "True cost", r.trueCostCents],
                          ["totalMonthly", "Total monthly", r.totalMonthlyCents],
                          ["yearlyPaidOut", "Yearly paid out", r.yearlyPaidOutCents],
                          ["everythingElse", "Everything else", r.everythingElseCents],
                          ["oneOffs", "One-offs", r.oneOffsCents],
                        ] as const
                      ).map(([measure, measureLabel, v], ci) => (
                        <td key={measure} className={`py-2 text-right whitespace-nowrap${ci < 5 ? " pr-3" : ""}`}>
                          <button
                            type="button"
                            aria-label={`Lines behind ${measureLabel}, ${monthLabel(r.month)}: ${fmt(v)}`}
                            className="underline decoration-dotted underline-offset-4 hover:text-[var(--accent)]"
                            onClick={() => openMonthCell(r.month, measure, measureLabel, v)}
                          >
                            {fmt(v)}
                          </button>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="font-semibold">
                    <th scope="row" className="py-2 pr-3 text-left">Total</th>
                    <td className="py-2 pr-3 text-right whitespace-nowrap">{fmt(ex.monthTotals.cashOutCents)}</td>
                    <td className="py-2 pr-3 text-right whitespace-nowrap">{fmt(ex.monthTotals.trueCostCents)}</td>
                    <td className="py-2 pr-3 text-right whitespace-nowrap">{fmt(ex.monthTotals.totalMonthlyCents)}</td>
                    <td className="py-2 pr-3 text-right whitespace-nowrap">{fmt(ex.monthTotals.yearlyPaidOutCents)}</td>
                    <td className="py-2 pr-3 text-right whitespace-nowrap">{fmt(ex.monthTotals.everythingElseCents)}</td>
                    <td className="py-2 text-right whitespace-nowrap">{fmt(ex.monthTotals.oneOffsCents)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          {drill && (
            <div
              ref={drillRef}
              className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-alt)] p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <h3 className="font-semibold">{drill.title}</h3>
                <button
                  type="button"
                  aria-label="Close drill-down"
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--border)] text-[var(--text)]"
                  onClick={() => setDrill(null)}
                >
                  ✕
                </button>
              </div>
              {drillStale && drillCurrentTotalCents != null && (
                <p className="mt-2 text-sm text-[var(--warn-deep)]" role="status">
                  This figure changed after the grid above loaded — the grid
                  showed {fmt(drill.totalCents)}; the current figure is{" "}
                  {fmt(drillCurrentTotalCents)}. The lines below are the
                  current ones, and the grid above is refreshing so it
                  matches.
                </p>
              )}
              {drill.kind === "lines" ? (
                <DrillLines lines={drill.lines} totalCents={drill.totalCents} />
              ) : monthLines.error ? (
                <p className="mt-2 text-sm text-[var(--bad)]">Something went wrong loading the lines. Try again.</p>
              ) : !monthLines.data || monthLines.data.month !== drill.month ? (
                <p className="mt-2 text-sm text-[var(--dim)]">Loading…</p>
              ) : drill.kind === "month" && drill.measure === "oneOffs" && monthLines.data.oneOffLines.length === 0 ? (
                <>
                  <p className="mt-2 text-sm text-[var(--dim)]">No one-offs recorded for this month.</p>
                  <DrillLines lines={[]} totalCents={drillPanelTotalCents} />
                </>
              ) : (
                <DrillLines lines={monthDrillLines(drill, monthLines.data)} totalCents={drillPanelTotalCents} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------- spending (month) view chart ---------------- */

type SpendingMonthRow = Dash["history"][number];
type SpendingAheadRow = Dash["enteredAheadMonths"][number];

type SpendingChartDatum = {
  name: string;
  monthStr: string;
  estimate: boolean;
  trueCost: number;
  cashOut: number;
  trueCostCents: number;
  cashOutCents: number;
  // The True cost bar's stacked parts: lights-on at the bottom,
  // the rest above. The two always sum to trueCost / trueCostCents.
  trueCostLightsOn: number;
  trueCostRest: number;
  trueCostLightsOnCents: number;
  trueCostRestCents: number;
  // The Cash out bar's stacked parts (see splitCashOut): lights-on
  // at the bottom, regular cash out in the middle, the month's
  // one-offs on top. The three always sum to cashOut / cashOutCents;
  // oneOff is 0 in months with no one-offs recorded.
  cashOutLightsOn: number;
  cashOutRegular: number;
  cashOutOneOff: number;
  cashOutLightsOnCents: number;
  cashOutRegularCents: number;
  cashOutOneOffCents: number;
  oneOffTotalCents: number;
  keepLightsOnCents: number;
};

/* Split a month's Cash out into its stacked-bar parts: regular
   cash out below and the month's one-offs on top. One-offs are
   explanation only — their total is already inside the month's
   Cash out — so the two parts always sum back to the Cash out
   total, and the bar's total label stays the total. The split is
   real only for a positive one-off total that fits inside the
   month's Cash out; anything else (no one-offs recorded, a
   negative/refund one-off total, or no cash out at all) leaves
   the whole bar regular, so months without one-offs render
   exactly as before. */
function splitCashOut(
  cashOutCents: number,
  oneOffTotalCents: number,
): { regularCents: number; oneOffCents: number } {
  const oneOffCents =
    cashOutCents > 0 && oneOffTotalCents > 0
      ? Math.min(oneOffTotalCents, cashOutCents)
      : 0;
  return { regularCents: cashOutCents - oneOffCents, oneOffCents };
}

/* Shape for the lower (regular) segment of a split Cash out bar:
   square top corners when a one-off segment sits on top of it, so
   the stack's sides stay straight at the join; the bar's usual
   rounded top when the regular part is the whole bar. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cashOutBaseShape(shapeProps: any) {
  const datum = shapeProps?.payload as { cashOutOneOff?: number } | undefined;
  const hasOneOffOnTop = (datum?.cashOutOneOff ?? 0) > 0;
  return (
    <Rectangle {...shapeProps} radius={hasOneOffOnTop ? [0, 0, 0, 0] : [3, 3, 0, 0]} />
  );
}

/* Shape for the bottom (lights-on) segment of a split True cost bar:
   square top corners when the rest sits on top of it; the bar's usual
   rounded top when the lights-on part is the whole bar. The segment's
   fill is diagonal stripes in the bar's own hue family (the
   lightsOnStripesTeal pattern: the bar's deep teal with darker-teal
   stripe lines), so the boundary with the rest above it reads from
   the stripes alone. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function trueCostLightsOnShape(shapeProps: any) {
  const datum = shapeProps?.payload as { trueCostRest?: number } | undefined;
  const hasRestOnTop = (datum?.trueCostRest ?? 0) > 0;
  return (
    <Rectangle {...shapeProps} radius={hasRestOnTop ? [0, 0, 0, 0] : [3, 3, 0, 0]} />
  );
}

/* Shape for the bottom (lights-on) segment of a split Cash out bar:
   square top corners when anything sits on top of it; the bar's usual
   rounded top when the lights-on part is the whole bar. The segment's
   fill is diagonal stripes in the bar's own hue family (the
   lightsOnStripesOrange pattern: the bar's deep orange with
   darker-orange stripe lines), so the boundary with what sits above
   it reads from the stripes alone. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cashOutLightsOnShape(shapeProps: any) {
  const datum = shapeProps?.payload as { cashOutRegular?: number; cashOutOneOff?: number } | undefined;
  const hasAbove = (datum?.cashOutRegular ?? 0) > 0 || (datum?.cashOutOneOff ?? 0) > 0;
  return (
    <Rectangle {...shapeProps} radius={hasAbove ? [0, 0, 0, 0] : [3, 3, 0, 0]} />
  );
}

/* Grouped bar chart for the Month-mode Quick view: one pair of bars
   per recorded month — the month's True cost (smoothed) beside its
   Cash out, in chronological order. Fed from getDashboard's own
   trailing window: the caller passes the server-published
   trailingMonths — the exact months the averages line averages
   (the same per-month eff() figures the tiles show), so the bars
   and the line are the same numbers and can never disagree (the
   line's figures are the means of exactly these months' bars),
   and a pair appears automatically when a new month is recorded.
   (Before build v123 the caller sliced the last
   trailingMonthsCovered entries off the 12-entry history, which
   ends at the viewed month while the window ends at the current
   month — so with the viewed month after the current month the
   chart plotted the viewed month's tail, not the window.)
   Past the viewed month, the series continues with any
   later month that already has entered figures (getDashboard's
   enteredAheadMonths — cash-out items, an entered month total, or
   recorded payments, each priced by the same eff() computation);
   a month later than the current calendar month is an ESTIMATE:
   its bars render muted and outlined, its axis label gains
   "(est.)", and it turns into a normal pair on its own once its
   month arrives — including when such a month arrives inside the
   history itself (its row carries the server's estimate flag).
   Every bar carries its dollar value above it; the
   two series sit on staggered label shelves coloured to match
   their bars so neighbouring labels never collide, and the legend
   names the series. No recorded months renders a plain empty
   state. In a month with one-offs recorded, the Cash out bar is
   split into two stacked parts — regular cash out below, the
   one-offs on top in their own red/rose hue — so a
   spike caused by a one-off explains itself at a glance; the
   label above the bar stays the month's total Cash out, and
   months without one-offs keep the single solid bar. */
function SpendingTrueCostChart({
  months,
  aheadMonths,
  averageLine,
  targetMonthlyCents,
  averageMonthlyCents,
}: {
  months: SpendingMonthRow[];
  aheadMonths: SpendingAheadRow[];
  // The spending target per month, in cents: the Tax Plan
  // record's annual spending ÷ 12 (the caller's live figure —
  // the local target field's value while it parses, else the
  // record's). Drawn as a dashed horizontal line across the
  // chart so each month's bars read above or below it at a
  // glance; the chart legend names it with its value (no
  // inline label). Null when no target resolves — no line
  // is drawn.
  targetMonthlyCents: number | null;
  // The True cost average per month, in cents: the dashboard's
  // own avgSmoothedCents — the mean of exactly the recorded
  // `months` above, the same figure the averages line prints.
  // Drawn as a thin dotted horizontal line whose colour is
  // derived live from the average against the target: red
  // (var(--bad)) when the average is above the target, green
  // (var(--accent)) when it is on or below the target — so the
  // average month reads against the target at a glance. With
  // no target to compare against it falls back to the muted
  // neutral dim colour. Distinct from the target's dashed
  // line either way. Neither line carries an inline label —
  // the chart legend below the bars names both lines with
  // their values. Null whenever the averages line is hidden
  // (fewer than 2 months covered) — no line is drawn. The
  // Cash out average stays in the averages line's text only;
  // it gets no line.
  averageMonthlyCents: number | null;
  // The Quick view averages line ("Average month · … — True cost
  // … · Cash out …"), composed by the caller from the dashboard's
  // own averages over exactly the recorded `months` above; null
  // when fewer than 2 months are covered. Rendered inside this
  // card's title ⓘ tooltip, alongside the section's other
  // explanatory lines (moved into the tooltip by request,
  // 2026-11-03; before that it sat under the title — and before
  // 2026-10-25 it was a standalone highlighted banner between
  // the tiles and this card: right numbers, wrong place).
  averageLine: string | null;
}) {
  const thisMonth = currentMonth();
  const chartData: SpendingChartDatum[] = [
    ...months.map((m) => {
      const split = splitCashOut(m.cashOutCents, m.oneOffTotalCents);
      return {
        name: m.estimate
          ? `${shortMonthLabel(m.month)} (est.)`
          : shortMonthLabel(m.month),
        monthStr: m.month,
        estimate: m.estimate,
        trueCost: m.smoothedCents / 100,
        cashOut: m.cashOutCents / 100,
        trueCostCents: m.smoothedCents,
        cashOutCents: m.cashOutCents,
        trueCostLightsOn: trueCostLightsOnCents / 100,
        trueCostRest: trueCostRestCents / 100,
        trueCostLightsOnCents,
        trueCostRestCents,
        cashOutLightsOn: cashOutLightsOnCents / 100,
        cashOutRegular: cashOutRegularCents / 100,
        cashOutOneOff: split.oneOffCents / 100,
        cashOutLightsOnCents,
        cashOutRegularCents,
        cashOutOneOffCents: split.oneOffCents,
        oneOffTotalCents: m.oneOffTotalCents,
        keepLightsOnCents,
      };
    }),
    ...aheadMonths.map((m) => {
      const estimate = m.month > thisMonth;
      const split = splitCashOut(m.cashOutCents, m.oneOffTotalCents);
      const keepLightsOnCents = m.keepLightsOnCents ?? 0;
      const trueCostCents = m.smoothedCents;
      const trueCostLightsOnCents = Math.max(0, Math.min(keepLightsOnCents, trueCostCents));
      const trueCostRestCents = trueCostCents - trueCostLightsOnCents;
      const oneOffCents = split.oneOffCents;
      const cashOutLightsOnCents = Math.max(0, Math.min(keepLightsOnCents, m.cashOutCents - oneOffCents));
      const cashOutRegularCents = m.cashOutCents - cashOutLightsOnCents - oneOffCents;
      return {
        name: estimate
          ? `${shortMonthLabel(m.month)} (est.)`
          : shortMonthLabel(m.month),
        monthStr: m.month,
        estimate,
        trueCost: m.smoothedCents / 100,
        cashOut: m.cashOutCents / 100,
        trueCostCents: m.smoothedCents,
        cashOutCents: m.cashOutCents,
        trueCostLightsOn: trueCostLightsOnCents / 100,
        trueCostRest: trueCostRestCents / 100,
        trueCostLightsOnCents,
        trueCostRestCents,
        cashOutLightsOn: cashOutLightsOnCents / 100,
        cashOutRegular: cashOutRegularCents / 100,
        cashOutOneOff: split.oneOffCents / 100,
        cashOutLightsOnCents,
        cashOutRegularCents,
        cashOutOneOffCents: split.oneOffCents,
        oneOffTotalCents: m.oneOffTotalCents,
        keepLightsOnCents,
      };
    }),
  ];
  const hasEstimate = chartData.some((d) => d.estimate);
  /* Whether any plotted month's Cash out bar is actually split —
     drives the extra legend entry and the tooltip note, so both
     appear only when a split is on screen. */
  const hasOneOffSplit = chartData.some((d) => d.cashOutOneOffCents > 0);
  const hasLightsOnSplit = chartData.some((d) => d.trueCostLightsOnCents > 0 || d.cashOutLightsOnCents > 0);
  /* Vs-target summary over the recorded months only: the
     `months` above — the same trailing months the chart plots
     and the header average uses. Entered-ahead (est.) pairs in
     chartData are never counted: an estimate may be revised, so
     the total and the per-month average are sums of
     (True cost − Target) over the recorded months alone,
     computed here from the data — never a stored or hardcoded
     figure — so they move when the months or the data change. */
  const recordedMonths = months.filter((m) => !m.estimate);
  const targetTotalDiffCents =
    targetMonthlyCents != null
      ? recordedMonths.reduce(
          (sum, m) => sum + (m.smoothedCents - (targetMonthlyCents ?? 0)),
          0,
        )
      : null;
  const targetAvgDiffCents =
    targetTotalDiffCents != null && recordedMonths.length > 0
      ? Math.round(targetTotalDiffCents / recordedMonths.length)
      : null;
  const targetRangeLabel = (() => {
    const first = recordedMonths[0];
    const last = recordedMonths[recordedMonths.length - 1];
    if (first == null || last == null) return "";
    return monthRangeLabel(first.month, last.month);
  })();

  /* The Average line's colour, derived live from the current
     values on every render: red when the average sits above
     the target, green when it is on or below it. The chart
     line and its legend swatch share this one value so they
     can never disagree. When there is no target to compare
     against, the line keeps its old muted neutral colour. */
  const averageLineStroke =
    averageMonthlyCents != null && targetMonthlyCents != null
      ? averageMonthlyCents > targetMonthlyCents
        ? "var(--bad)"
        : "var(--accent)"
      : "var(--dim)";

  return (
    <section
      aria-label="True cost vs Cash out by month"
      className="mt-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5"
    >
      <div className="flex items-center gap-2">
        <h3 className="display text-lg font-semibold">True cost vs Cash out</h3>
        {/* All of this section's explanatory text lives in this
            ⓘ tooltip (moved from the wall of text that used to
            sit under the title, 2026-11-03): the title, legend,
            and chart stay on the face, and every figure in the
            tooltip is derived live from the same props the chart
            itself draws — the caller's averageLine, the target,
            and the True cost average — so it can never disagree
            with the chart or go stale as the record changes.
            align="center": the button sits mid-row after the
            title, so neither edge alignment fits on a phone —
            the bubble centres on the button instead of clipping
            off either edge of the screen. */}
        <ExplainerInfoTip
          id="spending.trueCostVsCashOut"
          label="True cost vs Cash out"
          align="center"
        >
          <p>
            One pair of bars per recorded month; an (est.) pair is entered
            ahead and may be revised.
          </p>
          {averageLine != null && <p className="tnum">{averageLine}</p>}
          {targetMonthlyCents != null && (
            <p className="tnum">
              Spending target {fmt(targetMonthlyCents)}/mo — the dashed line;
              a month above it spent over the target.
            </p>
          )}
          {averageMonthlyCents != null && (
            <p className="tnum">
              True cost average {fmt(averageMonthlyCents)}/mo — the dotted
              line, over the same months as the Average month line above.
            </p>
          )}
          {hasOneOffSplit && (
            <p>
              In a month with one-offs recorded, the Cash out bar is split:
              regular cash out below, the one-offs on top in the red/rose
              hue. The label above the bar is still the month&rsquo;s
              total Cash out.
            </p>
          )}
          {hasLightsOnSplit && (
            <p>
              Each bar is split: the lights-on part — the month&rsquo;s keep-the-lights-on cost, the floor the Monthly bills header shows — sits at the bottom, shown as diagonal stripes, the rest above it. The label above the bar is still the month&rsquo;s total.
            </p>
          )}
        </ExplainerInfoTip>
      </div>
      {chartData.length === 0 ? (
        <p className="mt-3 rounded-[var(--radius)] border border-dashed border-[var(--border)] p-4 text-sm text-[var(--dim)]">
          No months recorded yet — once a month is recorded, its True cost
          and Cash out appear here as a pair of bars.
        </p>
      ) : (
        <>
          {/* Screen-reader / text fallback carrying the exact figures. */}
          <ul className="sr-only">
            {targetMonthlyCents != null && (
              <li>{`Spending target: ${fmt(targetMonthlyCents)} per month`}</li>
            )}
            {averageMonthlyCents != null && (
              <li>{`True cost average: ${fmt(averageMonthlyCents)} per month`}</li>
            )}
            {chartData.map((d) => {
              const diffCents =
                targetMonthlyCents != null
                  ? d.trueCostCents - targetMonthlyCents
                  : null;
              return (
                <li key={d.monthStr}>
                  {`${d.name}: True cost ${fmt(d.trueCostCents)}${d.trueCostLightsOnCents > 0 ? ` · Lights on ${fmt(d.trueCostLightsOnCents)} of the True cost` : ""} · Cash out ${fmt(d.cashOutCents)}${d.cashOutLightsOnCents > 0 ? ` · Lights on ${fmt(d.cashOutLightsOnCents)} of the Cash out` : ""}${d.cashOutOneOffCents > 0 ? ` · One-offs ${fmt(d.cashOutOneOffCents)} of the Cash out` : ""}${diffCents != null ? ` · Target ${fmt(targetMonthlyCents ?? 0)} · Difference ${fmtSigned(diffCents)} ${vsTargetWord(diffCents)}` : ""}${d.estimate ? " (estimate — entered ahead, may be revised)" : ""}`}
                </li>
              );
            })}
            {targetTotalDiffCents != null && targetAvgDiffCents != null && (
              <li>{`Vs target · ${targetRangeLabel} · ${recordedMonths.length} recorded month${recordedMonths.length === 1 ? "" : "s"}: total ${fmtSigned(targetTotalDiffCents)} ${vsTargetWord(targetTotalDiffCents)} · average ${fmtSigned(targetAvgDiffCents)}/mo ${vsTargetWord(targetAvgDiffCents)}`}</li>
            )}
          </ul>
          {/* Legend: names every element of the chart with its
              value — the two bar series and both horizontal
              lines. The lines carry no inline labels (they sat
              on top of the bars and collided when the average
              and the target were close), so this legend is the
              one place the line values are printed on the chart.
              The line swatches are drawn exactly as the lines
              themselves: target dashed in the text colour,
              average dotted and thin in the same live-derived
              colour as the average line (red above the target,
              green on or below it). */}
          <div
            aria-label="Chart legend"
            className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm text-[var(--text)]"
          >
            <span className="inline-flex items-center gap-2">
              <span
                aria-hidden="true"
                className="inline-block h-[10px] w-[14px] rounded-[2px]"
                style={{ background: "var(--accent)" }}
              />
              True cost
            </span>
            <span className="inline-flex items-center gap-2">
              <span
                aria-hidden="true"
                className="inline-block h-[10px] w-[14px] rounded-[2px]"
                style={{ background: "var(--warn)" }}
              />
              Cash out
            </span>
            {hasLightsOnSplit && (
              <span className="inline-flex items-center gap-2">
                <svg
                  aria-hidden="true"
                  width="14"
                  height="10"
                  viewBox="0 0 14 10"
                  className="shrink-0"
                >
                  <defs>
                    <clipPath id="lightsOnLegendSwatchClip">
                      <rect width="14" height="10" rx="2" />
                    </clipPath>
                    <pattern
                      id="lightsOnLegendStripesTeal"
                      width="4"
                      height="4"
                      patternUnits="userSpaceOnUse"
                      patternTransform="rotate(45)"
                    >
                      <rect width="4" height="4" fill="var(--accent-deep)" />
                      <line x1="0" y1="0" x2="0" y2="4" stroke="var(--lights-on-stripes-teal)" strokeWidth="1.5" />
                    </pattern>
                    <pattern
                      id="lightsOnLegendStripesOrange"
                      width="4"
                      height="4"
                      patternUnits="userSpaceOnUse"
                      patternTransform="rotate(45)"
                    >
                      <rect width="4" height="4" fill="var(--warn-deep)" />
                      <line x1="0" y1="0" x2="0" y2="4" stroke="var(--lights-on-stripes-orange)" strokeWidth="1.5" />
                    </pattern>
                  </defs>
                  <g clipPath="url(#lightsOnLegendSwatchClip)">
                    <rect width="7" height="10" fill="url(#lightsOnLegendStripesTeal)" />
                    <rect x="7" width="7" height="10" fill="url(#lightsOnLegendStripesOrange)" />
                  </g>
                </svg>
                Lights on
                <ExplainerInfoTip
                  id="spending.lightsOnLegend"
                  label="Lights on"
                  align="center"
                >
                  <p>
                    The bottom part of each bar is the month&rsquo;s keep-the-lights-on cost, shown as diagonal stripes.
                  </p>
                </ExplainerInfoTip>
              </span>
            )}
            {hasOneOffSplit && (
              <span className="inline-flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="inline-block h-[10px] w-[14px] rounded-[2px]"
                  style={{ background: "var(--one-offs)" }}
                />
                One-offs
              </span>
            )}
            {targetMonthlyCents != null && (
              <span className="tnum inline-flex items-center gap-2">
                <svg
                  aria-hidden="true"
                  width="28"
                  height="6"
                  viewBox="0 0 28 6"
                  className="shrink-0"
                >
                  <line
                    x1="0"
                    y1="3"
                    x2="28"
                    y2="3"
                    stroke="var(--text)"
                    strokeWidth="1.5"
                    strokeDasharray="6 4"
                    strokeOpacity="0.75"
                  />
                </svg>
                {`Target ${fmt(targetMonthlyCents)}/mo`}
              </span>
            )}
            {averageMonthlyCents != null && (
              <span className="tnum inline-flex items-center gap-2">
                <svg
                  aria-hidden="true"
                  width="28"
                  height="6"
                  viewBox="0 0 28 6"
                  className="shrink-0"
                >
                  <line
                    x1="0"
                    y1="3"
                    x2="28"
                    y2="3"
                    stroke={averageLineStroke}
                    strokeWidth="1"
                    strokeDasharray="2 3"
                    strokeLinecap="round"
                  />
                </svg>
                {`Average ${fmt(averageMonthlyCents)}/mo`}
              </span>
            )}
          </div>
          <div className="mt-3 max-w-full overflow-x-auto">
            <div
              className="h-[300px]"
              style={{
                minWidth: `${chartData.length * (hasEstimate ? 128 : 108)}px`,
              }}
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={chartData}
                  margin={{ top: 36, right: 8, bottom: 4, left: 4 }}
                  barCategoryGap="22%"
                  barGap={3}
                >
                  <defs>
                    <pattern
                      id="lightsOnStripesTeal"
                      width="7"
                      height="7"
                      patternUnits="userSpaceOnUse"
                      patternTransform="rotate(45)"
                    >
                      <rect width="7" height="7" fill="var(--accent-deep)" />
                      <line x1="0" y1="0" x2="0" y2="7" stroke="var(--lights-on-stripes-teal)" strokeWidth="2.5" />
                    </pattern>
                    <pattern
                      id="lightsOnStripesOrange"
                      width="7"
                      height="7"
                      patternUnits="userSpaceOnUse"
                      patternTransform="rotate(45)"
                    >
                      <rect width="7" height="7" fill="var(--warn-deep)" />
                      <line x1="0" y1="0" x2="0" y2="7" stroke="var(--lights-on-stripes-orange)" strokeWidth="2.5" />
                    </pattern>
                  </defs>
                  <CartesianGrid
                    stroke="var(--border)"
                    strokeDasharray="3 3"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="name"
                    tickLine={false}
                    axisLine={{ stroke: "var(--border)" }}
                    interval={0}
                    tick={{ fill: "var(--text)", fontSize: 12 }}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    width={64}
                    tick={{ fill: "var(--dim)", fontSize: 12 }}
                    domain={[
                      0,
                      (dataMax: number) =>
                        Math.max(
                          dataMax,
                          (targetMonthlyCents ?? 0) / 100,
                          (averageMonthlyCents ?? 0) / 100,
                        ),
                    ]}
                    tickFormatter={(value: number) =>
                      value >= 1000
                        ? `$${Number((value / 1000).toFixed(1)).toLocaleString("en-US")}k`
                        : `$${value.toLocaleString("en-US")}`
                    }
                  />
                  <Tooltip
                    cursor={{ fill: "var(--surface-alt)", opacity: 0.5 }}
                    content={(tooltipProps: {
                      active?: boolean;
                      label?: string;
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      payload?: any[];
                    }) => {
                      if (!tooltipProps.active) return null;
                      const datum = (tooltipProps.payload?.[0]?.payload ??
                        chartData.find(
                          (d) => d.name === tooltipProps.label,
                        )) as SpendingChartDatum | undefined;
                      if (!datum) return null;
                      return (
                        <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm shadow-lg">
                          <p className="font-semibold">{datum.name}</p>
                          <p className="tnum mt-0.5 text-[var(--text)]">
                            True cost {fmt(datum.trueCostCents)} · Cash out{" "}
                            {fmt(datum.cashOutCents)}
                          </p>
                          {datum.cashOutOneOffCents > 0 && (
                            <p className="tnum mt-0.5 text-[var(--dim)]">
                              Regular {fmt(datum.cashOutRegularCents)} ·
                              One-offs {fmt(datum.cashOutOneOffCents)}
                            </p>
                          )}
                          {targetMonthlyCents != null && (
                            <p className="tnum mt-0.5 text-[var(--dim)]">
                              Target {fmt(targetMonthlyCents)}/mo
                            </p>
                          )}
                          {targetMonthlyCents != null &&
                            (() => {
                              const diffCents =
                                datum.trueCostCents - targetMonthlyCents;
                              return (
                                <p className="tnum mt-0.5 font-medium text-[var(--text)]">
                                  Difference {fmtSigned(diffCents)}{" "}
                                  {vsTargetWord(diffCents)}
                                </p>
                              );
                            })()}
                          {averageMonthlyCents != null && (
                            <p className="tnum mt-0.5 text-[var(--dim)]">
                              Average {fmt(averageMonthlyCents)}/mo
                            </p>
                          )}
                        </div>
                      );
                    }}
                  />
                  <Bar
                    cursor="pointer"
                    dataKey="trueCostLightsOn"
                    name="True cost"
                    stackId="trueCost"
                    fill="url(#lightsOnStripesTeal)"
                    shape={trueCostLightsOnShape}
                  >
                    {chartData.map((d) => (
                      <Cell
                        key={d.monthStr}
                        fill="url(#lightsOnStripesTeal)"
                        fillOpacity={d.estimate ? 0.3 : 1}
                        stroke={d.estimate ? "var(--accent-deep)" : "none"}
                        strokeWidth={d.estimate ? 1.5 : 0}
                        strokeDasharray={d.estimate ? "4 2" : undefined}
                      />
                    ))}
                  </Bar>
                  <Bar
                    cursor="pointer"
                    dataKey="trueCostRest"
                    name="True cost"
                    fill="var(--accent)"
                    stackId="trueCost"
                    radius={[3, 3, 0, 0]}
                  >
                    {chartData.map((d) => (
                      <Cell
                        key={d.monthStr}
                        fill="var(--accent)"
                        fillOpacity={d.estimate ? 0.3 : 1}
                        stroke={d.estimate ? "var(--accent)" : "none"}
                        strokeWidth={d.estimate ? 1.5 : 0}
                        strokeDasharray={d.estimate ? "4 2" : undefined}
                      />
                    ))}
                    {/* True cost labels are end-anchored to the bar's
                        right edge (extending left over the pair's open
                        space) instead of centred: the Cash out bar
                        paints after this one, so a centred label on a
                        short True cost bar beside a taller Cash out
                        bar would run underneath it and lose its tail.
                        Value labels are ALWAYS one solid, full-contrast
                        rendering — the estimate treatment (muted fill,
                        dashed outline) is for the bars only and must
                        never reach a label, so the text below pins
                        fillOpacity / opacity to 1 and stroke off. The
                        anchor sits a few px inside the bar's right
                        edge so the label's last digit always clears
                        the neighbouring Cash out bar's outline —
                        on an (est.) pair that outline is dashed and
                        the old +2 anchor let it touch the digit. */}
                    <LabelList
                      dataKey="trueCost"
                      position="top"
                      offset={16}
                      content={(labelProps) => {
                        const vb = labelProps.viewBox;
                        if (!vb || !("x" in vb)) return null;
                        const v =
                          typeof labelProps.value === "number"
                            ? labelProps.value
                            : Number(labelProps.value ?? 0);
                        return (
                          <text
                            x={(vb.x ?? 0) + (vb.width ?? 0) - 4}
                            y={(vb.y ?? 0) - (labelProps.offset ?? 16)}
                            textAnchor="end"
                            fill="var(--accent)"
                            fillOpacity={1}
                            opacity={1}
                            stroke="none"
                            strokeWidth={0}
                            strokeDasharray="none"
                            fontSize={11}
                            fontWeight={600}
                          >
                            {fmt(Math.round(v * 100))}
                          </text>
                        );
                      }}
                    />
                  </Bar>
                  {/* Cash out is drawn as three stacked segments
                      sharing one stack: lights-on at the bottom in
                      diagonal stripes in the bar's own hue family,
                      regular cash out in the middle and the month's
                      one-offs on top in their own red/rose hue. The
                      segments' Cells carry the same estimate
                      treatment the single bar's Cells did. */}
                  <Bar
                    cursor="pointer"
                    dataKey="cashOutLightsOn"
                    name="Cash out"
                    stackId="cashOut"
                    fill="url(#lightsOnStripesOrange)"
                    shape={cashOutLightsOnShape}
                  >
                    {chartData.map((d) => (
                      <Cell
                        key={d.monthStr}
                        fill="url(#lightsOnStripesOrange)"
                        fillOpacity={d.estimate ? 0.3 : 1}
                        stroke={d.estimate ? "var(--lights-on-orange)" : "none"}
                        strokeWidth={d.estimate ? 1.5 : 0}
                        strokeDasharray={d.estimate ? "4 2" : undefined}
                      />
                    ))}
                  </Bar>
                  <Bar
                    dataKey="cashOutRegular"
                    name="Cash out"
                    stackId="cashOut"
                    fill="var(--warn)"
                    shape={cashOutBaseShape}
                  >
                    {chartData.map((d) => (
                      <Cell
                        key={d.monthStr}
                        fill="var(--warn)"
                        fillOpacity={d.estimate ? 0.3 : 1}
                        stroke={d.estimate ? "var(--warn)" : "none"}
                        strokeWidth={d.estimate ? 1.5 : 0}
                        strokeDasharray={d.estimate ? "4 2" : undefined}
                      />
                    ))}
                  </Bar>
                  <Bar
                    cursor="pointer"
                    dataKey="cashOutOneOff"
                    name="One-offs"
                    stackId="cashOut"
                    fill="var(--one-offs)"
                    radius={[3, 3, 0, 0]}
                  >
                    {chartData.map((d) => (
                      <Cell
                        key={d.monthStr}
                        fill="var(--one-offs)"
                        fillOpacity={d.estimate ? 0.3 : 1}
                        stroke={d.estimate ? "var(--one-offs)" : "none"}
                        strokeWidth={d.estimate ? 1.5 : 0}
                        strokeDasharray={d.estimate ? "4 2" : undefined}
                      />
                    ))}
                    {/* The bar's total label, unchanged: it sits on
                        the stack's top segment but reads the month's
                        total Cash out (dataKey "cashOut"), so a split
                        bar is labelled with its total exactly as an
                        unsplit one is. Recharts' default LabelList
                        rendering spreads each bar entry's own SVG
                        props onto its label (LabelList → Label via
                        filterProps(entry)), so an estimate bar's
                        Cell — fillOpacity 0.3, a coloured stroke,
                        strokeWidth 1.5 and strokeDasharray "4 2" —
                        would otherwise be inherited by the label
                        text itself, giving it a dashed, doubled,
                        unreadable outline. These explicit props are
                        spread AFTER the entry in LabelList, so they
                        override that inheritance for every label:
                        one solid, full-contrast rendering, identical
                        for recorded and (est.) months. The bars keep
                        their estimate treatment via the Cells above;
                        only the labels are pinned clean. */}
                    <LabelList
                      dataKey="cashOut"
                      position="top"
                      offset={3}
                      fillOpacity={1}
                      opacity={1}
                      stroke="none"
                      strokeWidth={0}
                      strokeDasharray="none"
                      formatter={(value: number) =>
                        fmt(Math.round(value * 100))
                      }
                      style={{
                        fill: "var(--warn)",
                        fillOpacity: 1,
                        opacity: 1,
                        stroke: "none",
                        strokeWidth: 0,
                        strokeDasharray: "none",
                        fontSize: 11,
                        fontWeight: 600,
                      }}
                    />
                  </Bar>
                  {/* The target line: dashed, no inline label —
                      the legend above the chart names it with
                      its value. */}
                  {targetMonthlyCents != null && (
                    <ReferenceLine
                      y={targetMonthlyCents / 100}
                      stroke="var(--text)"
                      strokeDasharray="6 4"
                      strokeWidth={1.5}
                      strokeOpacity={0.75}
                    />
                  )}
                  {/* The True cost average line: dotted and
                      thin, coloured live against the target —
                      red when the average is above the target,
                      green when it is on or below (the muted
                      neutral dim colour only when no target
                      exists to compare against) — so it reads
                      as its own element and never as the
                      target's dashed line. No inline label: the
                      legend above the chart names it with its
                      value, in the same colour. */}
                  {averageMonthlyCents != null && (
                    <ReferenceLine
                      y={averageMonthlyCents / 100}
                      stroke={averageLineStroke}
                      strokeDasharray="2 3"
                      strokeWidth={1}
                      strokeLinecap="round"
                    />
                  )}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
          {/* Vs-target summary line, under the chart: the total
              and the per-month average of (True cost − Target)
              over the recorded months only — the same months
              the summary values above were computed from, so
              entered-ahead (est.) pairs never enter either
              figure. */}
          {targetTotalDiffCents != null && targetAvgDiffCents != null && (
            <p className="tnum mt-3 text-sm text-[var(--dim)]">
              {`Vs target · ${targetRangeLabel} · ${recordedMonths.length} recorded month${recordedMonths.length === 1 ? "" : "s"} — total ${fmtSigned(targetTotalDiffCents)} ${vsTargetWord(targetTotalDiffCents)} · average ${fmtSigned(targetAvgDiffCents)}/mo ${vsTargetWord(targetAvgDiffCents)}${hasEstimate ? " · (est.) months not counted" : ""}`}
            </p>
          )}
        </>
      )}
    </section>
  );
}

/* ---------------- year view chart ---------------- */

type YearMonthRow = ApiResponse<typeof api, "getYearView">["months"][number];

type YearChartDatum = {
  name: string;
  monthStr: string;
  hasData: boolean;
  estimate: boolean;
  trueCost: number | null;
  cashOut: number | null;
  trueCostCents: number;
  cashOutCents: number;
  // The Cash out bar's stacked parts (see splitCashOut): regular
  // cash out below, the month's one-offs on top; oneOff is 0 in
  // months with no one-offs recorded.
  cashOutRegular: number;
  cashOutOneOff: number;
  cashOutRegularCents: number;
  cashOutOneOffCents: number;
};

/* Grouped bar chart for Year mode only: True cost vs Cash out,
   fed directly from the getYearView monthly figures — the
   exact same values the month panels below show, so the chart can
   never disagree with them. Only months with data are included,
   matching the panels; a month with data and a real $0 keeps its
   $0 in the tooltip with no bar height. As in the Month-mode
   chart, a month with one-offs recorded has its Cash out bar
   split — regular cash out below, one-offs on top in the red/rose
   hue — and months without one-offs keep the single solid bar. */
function YearTrueCostChart({
  year,
  months,
  onSelectMonth,
  targetMonthlyCents,
}: {
  year: number;
  months: YearMonthRow[];
  onSelectMonth: (month: string) => void;
  // The spending target per month, in cents — the same live
  // figure the Month-mode chart draws (see SpendingTrueCostChart).
  targetMonthlyCents: number | null;
}) {
  const chartData: YearChartDatum[] = months
    .filter((m) => m.hasData)
    .map((m) => {
      const split = splitCashOut(m.cashOutCents, m.oneOffsTotalCents);
      return {
        name: m.estimate
          ? `${MONTH_SHORT[m.monthNum - 1] ?? m.month} (est.)`
          : (MONTH_SHORT[m.monthNum - 1] ?? m.month),
        monthStr: m.month,
        hasData: true,
        estimate: m.estimate,
        trueCost: m.trueCostCents / 100,
        cashOut: m.cashOutCents / 100,
        trueCostCents: m.trueCostCents,
        cashOutCents: m.cashOutCents,
        cashOutRegular: split.regularCents / 100,
        cashOutOneOff: split.oneOffCents / 100,
        cashOutRegularCents: split.regularCents,
        cashOutOneOffCents: split.oneOffCents,
      };
    });
  const hasEstimate = chartData.some((d) => d.estimate);
  /* Whether any plotted month's Cash out bar is actually split —
     drives the extra legend entry, so it appears only when a
     split is on screen. */
  const hasOneOffSplit = chartData.some((d) => d.cashOutOneOffCents > 0);
  /* Vs-target summary over this year's recorded months only:
     (est.) pairs are never counted — an estimate may be
     revised — so the total and the per-month average are sums
     of (True cost − Target) over the recorded months alone,
     computed here from the chart's own data. */
  const recordedYearData = chartData.filter((d) => !d.estimate);
  const yearTargetTotalDiffCents =
    targetMonthlyCents != null
      ? recordedYearData.reduce(
          (sum, d) => sum + (d.trueCostCents - (targetMonthlyCents ?? 0)),
          0,
        )
      : null;
  const yearTargetAvgDiffCents =
    yearTargetTotalDiffCents != null && recordedYearData.length > 0
      ? Math.round(yearTargetTotalDiffCents / recordedYearData.length)
      : null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleChartClick = (state: any) => {
    const datum = state?.activePayload?.[0]?.payload as
      | YearChartDatum
      | undefined;
    if (datum?.hasData) onSelectMonth(datum.monthStr);
  };

  return (
    <section
      aria-label={`True cost vs Cash out chart for ${year}`}
      className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5"
    >
      <h3 className="display text-lg font-semibold">
        True cost vs Cash out — {year}
      </h3>
      <p className="mt-0.5 text-sm text-[var(--dim)]">
        Each month&rsquo;s True cost and Cash out, from the same figures as
        the panels below. Tap a month to open it.
        {hasEstimate &&
          " An (est.) month is entered ahead and may be revised."}
      </p>
      {targetMonthlyCents != null && (
        <p className="tnum mt-1.5 text-sm text-[var(--dim)]">
          Spending target {fmt(targetMonthlyCents)}/mo — the dashed line;
          a month above it spent over the target.
        </p>
      )}
      {/* Screen-reader / text fallback carrying the exact figures. */}
      <ul className="sr-only">
        {targetMonthlyCents != null && (
          <li>{`Spending target: ${fmt(targetMonthlyCents)} per month`}</li>
        )}
        {chartData.map((d) => {
          const diffCents =
            targetMonthlyCents != null
              ? d.trueCostCents - targetMonthlyCents
              : null;
          return (
            <li key={d.monthStr}>
              {`${d.name} ${year}: True cost ${fmt(d.trueCostCents)} · Cash out ${fmt(d.cashOutCents)}${d.cashOutOneOffCents > 0 ? ` · One-offs ${fmt(d.cashOutOneOffCents)} of the Cash out` : ""}${diffCents != null ? ` · Target ${fmt(targetMonthlyCents ?? 0)} · Difference ${fmtSigned(diffCents)} ${vsTargetWord(diffCents)}` : ""}${d.estimate ? " (estimate — entered ahead, may be revised)" : ""}`}
            </li>
          );
        })}
        {yearTargetTotalDiffCents != null &&
          yearTargetAvgDiffCents != null && (
            <li>{`Vs target · ${year} · ${recordedYearData.length} recorded month${recordedYearData.length === 1 ? "" : "s"}: total ${fmtSigned(yearTargetTotalDiffCents)} ${vsTargetWord(yearTargetTotalDiffCents)} · average ${fmtSigned(yearTargetAvgDiffCents)}/mo ${vsTargetWord(yearTargetAvgDiffCents)}`}</li>
          )}
      </ul>
      {/* Legend: names every element of the chart with its
          value — the two bar series and the dashed target
          line (which carries no inline label; the legend
          names it, matching the Month-mode chart). */}
      <div
        aria-label="Chart legend"
        className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm text-[var(--text)]"
      >
        <span className="inline-flex items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-block h-[10px] w-[14px] rounded-[2px]"
            style={{ background: "var(--accent)" }}
          />
          True cost
        </span>
        <span className="inline-flex items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-block h-[10px] w-[14px] rounded-[2px]"
            style={{ background: "var(--warn)" }}
          />
          Cash out
        </span>
        {hasOneOffSplit && (
          <span className="inline-flex items-center gap-2">
            <span
              aria-hidden="true"
              className="inline-block h-[10px] w-[14px] rounded-[2px]"
              style={{ background: "var(--one-offs)" }}
            />
            One-offs
          </span>
        )}
        {targetMonthlyCents != null && (
          <span className="tnum inline-flex items-center gap-2">
            <svg
              aria-hidden="true"
              width="28"
              height="6"
              viewBox="0 0 28 6"
              className="shrink-0"
            >
              <line
                x1="0"
                y1="3"
                x2="28"
                y2="3"
                stroke="var(--text)"
                strokeWidth="1.5"
                strokeDasharray="6 4"
                strokeOpacity="0.75"
              />
            </svg>
            {`Target ${fmt(targetMonthlyCents)}/mo`}
          </span>
        )}
      </div>
      <div className="mt-3 max-w-full overflow-x-auto">
        <div className="h-[300px] min-w-[620px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={chartData}
              margin={{ top: 8, right: 8, bottom: 4, left: 4 }}
              barCategoryGap="22%"
              barGap={3}
              onClick={handleChartClick}
            >
              <CartesianGrid
                stroke="var(--border)"
                strokeDasharray="3 3"
                vertical={false}
              />
              <XAxis
                dataKey="name"
                tickLine={false}
                axisLine={{ stroke: "var(--border)" }}
                interval={0}
                tick={(tickProps: {
                  x?: number;
                  y?: number;
                  payload?: { value?: string };
                  index?: number;
                }) => {
                  return (
                    <g
                      transform={`translate(${tickProps.x ?? 0},${tickProps.y ?? 0})`}
                    >
                      <text
                        x={0}
                        y={0}
                        dy={12}
                        textAnchor="middle"
                        fontSize={12}
                        fill="var(--text)"
                      >
                        {tickProps.payload?.value ?? ""}
                      </text>
                    </g>
                  );
                }}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={64}
                tick={{ fill: "var(--dim)", fontSize: 12 }}
                domain={[
                  0,
                  (dataMax: number) =>
                    Math.max(dataMax, (targetMonthlyCents ?? 0) / 100),
                ]}
                tickFormatter={(value: number) =>
                  value >= 1000
                    ? `$${Number((value / 1000).toFixed(1)).toLocaleString("en-US")}k`
                    : `$${value.toLocaleString("en-US")}`
                }
              />
              <Tooltip
                cursor={{ fill: "var(--surface-alt)", opacity: 0.5 }}
                content={(tooltipProps: {
                  active?: boolean;
                  label?: string;
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  payload?: any[];
                }) => {
                  if (!tooltipProps.active) return null;
                  const datum = (tooltipProps.payload?.[0]?.payload ??
                    chartData.find(
                      (d) => d.name === tooltipProps.label,
                    )) as YearChartDatum | undefined;
                  if (!datum) return null;
                  return (
                    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm shadow-lg">
                      <p className="font-semibold">
                        {datum.name} {year}
                      </p>
                      <p className="tnum mt-0.5 text-[var(--text)]">
                        True cost {fmt(datum.trueCostCents)} · Cash out{" "}
                        {fmt(datum.cashOutCents)}
                      </p>
                      {datum.cashOutOneOffCents > 0 && (
                        <p className="tnum mt-0.5 text-[var(--dim)]">
                          Regular {fmt(datum.cashOutRegularCents)} · One-offs{" "}
                          {fmt(datum.cashOutOneOffCents)}
                        </p>
                      )}
                      {targetMonthlyCents != null && (
                        <p className="tnum mt-0.5 text-[var(--dim)]">
                          Target {fmt(targetMonthlyCents)}/mo
                        </p>
                      )}
                      {targetMonthlyCents != null &&
                        (() => {
                          const diffCents =
                            datum.trueCostCents - targetMonthlyCents;
                          return (
                            <p className="tnum mt-0.5 font-medium text-[var(--text)]">
                              Difference {fmtSigned(diffCents)}{" "}
                              {vsTargetWord(diffCents)}
                            </p>
                          );
                        })()}
                    </div>
                  );
                }}
              />
              <Bar
                dataKey="trueCost"
                name="True cost"
                fill="var(--accent)"
                radius={[3, 3, 0, 0]}
                cursor="pointer"
              >
                {chartData.map((d) => (
                  <Cell
                    key={d.monthStr}
                    fill="var(--accent)"
                    fillOpacity={d.estimate ? 0.3 : 1}
                    stroke={d.estimate ? "var(--accent)" : "none"}
                    strokeWidth={d.estimate ? 1.5 : 0}
                    strokeDasharray={d.estimate ? "4 2" : undefined}
                  />
                ))}
              </Bar>
              {/* Cash out as two stacked segments, as in the
                  Month-mode chart: regular cash out below, the
                  month's one-offs on top in the red/rose hue; a
                  month with no one-offs is just the regular
                  segment, exactly as the old single bar rendered. */}
              <Bar
                dataKey="cashOutRegular"
                name="Cash out"
                stackId="cashOut"
                fill="url(#cashOutBarGradientYear)"
                cursor="pointer"
                shape={cashOutBaseShape}
              >
                {chartData.map((d) => (
                  <Cell
                    key={d.monthStr}
                    fill="url(#cashOutBarGradientYear)"
                    fillOpacity={d.estimate ? 0.3 : 1}
                    stroke={d.estimate ? "var(--warn)" : "none"}
                    strokeWidth={d.estimate ? 1.5 : 0}
                    strokeDasharray={d.estimate ? "4 2" : undefined}
                  />
                ))}
              </Bar>
              <Bar
                dataKey="cashOutOneOff"
                name="One-offs"
                stackId="cashOut"
                fill="var(--one-offs)"
                radius={[3, 3, 0, 0]}
                cursor="pointer"
              >
                {chartData.map((d) => (
                  <Cell
                    key={d.monthStr}
                    fill="var(--one-offs)"
                    fillOpacity={d.estimate ? 0.3 : 1}
                    stroke={d.estimate ? "var(--one-offs)" : "none"}
                    strokeWidth={d.estimate ? 1.5 : 0}
                    strokeDasharray={d.estimate ? "4 2" : undefined}
                  />
                ))}
              </Bar>
              {/* The target line: dashed, no inline label —
                  the legend above the chart names it with
                  its value. */}
              {targetMonthlyCents != null && (
                <ReferenceLine
                  y={targetMonthlyCents / 100}
                  stroke="var(--text)"
                  strokeDasharray="6 4"
                  strokeWidth={1.5}
                  strokeOpacity={0.75}
                />
              )}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      {/* Vs-target summary line, under the chart: the total and
          the per-month average of (True cost − Target) over
          this year's recorded months only — (est.) pairs never
          enter either figure. */}
      {yearTargetTotalDiffCents != null && yearTargetAvgDiffCents != null && (
        <p className="tnum mt-3 text-sm text-[var(--dim)]">
          {`Vs target · ${year} · ${recordedYearData.length} recorded month${recordedYearData.length === 1 ? "" : "s"} — total ${fmtSigned(yearTargetTotalDiffCents)} ${vsTargetWord(yearTargetTotalDiffCents)} · average ${fmtSigned(yearTargetAvgDiffCents)}/mo ${vsTargetWord(yearTargetAvgDiffCents)}${hasEstimate ? " · (est.) months not counted" : ""}`}
        </p>
      )}
    </section>
  );
}

/* ---------------- app ---------------- */

/* Retry policy for the Spending view's read-only loads (the month
   dashboard and the year view). The shared query client's default
   only retries failures the server explicitly marks retry-safe —
   caution that exists because an action invoked through useQuery
   can write. These two actions never write, so a transient failure
   (a 500, a dropped connection, a session credential the SDK could
   not refresh) is safe to retry a few times; permanent client
   errors (400/401/403/404/…) are not. Without this, one such hiccup
   landed on the "Something went wrong loading this month" screen
   for good — the server and the data were fine on re-check, but the
   screen offered no working way to try again short of reloading
   the whole app. */
function retryReadOnlyLoad(failureCount: number, error: Error): boolean {
  if (shouldRetryAction(failureCount, error)) return true;
  if (
    error instanceof SpaceActionError &&
    PERMANENT_ACTION_STATUSES.has(error.status)
  ) {
    return false;
  }
  return failureCount < 3;
}

/* Build v177 (re-audit NICE-TO-HAVE N-3): the bound on a
   save fire path's hold polls — a fire path waiting for an
   in-flight save to settle re-checks every 300 ms at most
   this many times (100 × 300 ms = 30 s) before it gives up
   explicitly instead of polling forever. The same bound and
   give-up are applied in every writer that carries the hold
   (Playground.tsx, RetirementCalc.tsx, RothConversion.tsx). */
const SAVE_HOLD_MAX_POLLS = 100;

export function App() {
  const queryClient = useQueryClient();
  const [month, setMonth] = useState(currentMonth());
  const [openTip, setOpenTip] = useState<string | null>(null);
  /* Quick view mode: "month" is the single-month strip; "year" stacks
     the months with data of the flipped-to year, each month panel
     carrying that month's own Quick view. The mode is a remembered
     display preference in the generic server-side fold store (the
     "spending.quickModeYear" flag): a stored entry means the user
     last left it on the year stack; no entry is the single-month
     default, and the last pick comes back after a reload. */
  const [quickModeYear, setQuickModeYear] =
    usePersistedFold("spending.quickModeYear");
  const quickMode: "month" | "year" = quickModeYear ? "year" : "month";
  const setQuickMode = (mode: "month" | "year") =>
    setQuickModeYear(mode === "year");
  /* Top-level view switch: "spending" is the whole existing dashboard;
     "networth" is its own self-contained view — while it is active
     none of the spending sections render. The last view shown is
     remembered in this browser (usePersistedChoice, key
     "fp.topView"); a first visit, or a missing or unknown stored
     value, opens on "spending". */
  const [topView, setTopView] = usePersistedChoice<
    "spending" | "networth" | "retirement" | "roth" | "playground"
  >("fp.topView", "spending", [
    "spending",
    "networth",
    "retirement",
    "roth",
    "playground",
  ]);
  /* Cross-view jump target for the Tax Plan (PLAN TOTAL
     VISIBILITY build): set by the Playground's Plan total tap —
     RothConversion's existing jumpTarget mechanism
     (build v133) jumps to the named field once the plan has
     loaded, opening its section on the All settings face. The
     nonce makes each tap fire exactly once. The Retirement
     view's Calculated-with taps (Spending / Ages / Expected
     return) set the same target, landing in the household or
     advanced section as their field requires. */
  const [rothJumpTarget, setRothJumpTarget] = useState<{
    fieldId: string;
    section: RothSectionId;
    nonce: number;
  } | null>(null);
  const [viewYear, setViewYear] = useState<number>(() =>
    Number(currentMonth().slice(0, 4)),
  );
  const dash = useQuery({
    queryKey: ["dashboard", month],
    queryFn: () => api.getDashboard({ month }),
    retry: retryReadOnlyLoad,
    retryDelay: actionRetryDelay,
  });
  const yearView = useQuery({
    queryKey: ["yearview", viewYear],
    queryFn: () => api.getYearView({ year: viewYear }),
    enabled: quickMode === "year",
    retry: retryReadOnlyLoad,
    retryDelay: actionRetryDelay,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    queryClient.invalidateQueries({ queryKey: ["yearview"] });
    queryClient.invalidateQueries({ queryKey: ["smoothedPaidBreakdown"] });
  };

  /* ---- Spending target (one source, multiple edit locations) ----
     The target is the Tax Plan record's annual spending
     (annualSpendingCents) — the same figure the Tax Plan,
     Retirement, and Playground views read and edit. This view
     shows it as a monthly line on the spending charts
     (annual ÷ 12), compares it against the viewed month's true
     monthly cost in the hero, and edits it in place through a
     plain typed field beside that hero, with the same per
     year / per month toggle the Tax Plan and Playground
     spending fields carry (the state stays the annual string;
     per-month entry converts at exactly monthly × 12 through
     rothShared's shared helpers). The field writes
     through to the record via saveRothInputs with CAS, exactly
     like the Playground spending field (build v145, with the
     v152 fresh-rebuild queue, the v151 failed-save retry, and
     the v158 conflict reset): the queue holds ONLY the local
     spending delta, the whole-record payload is rebuilt at fire
     time from the freshest fetched record with only
     annualSpendingCents replaced, and the mutation reads its
     CAS base from that same refetch — so an edit here updates
     the Tax Plan, Retirement, and Playground too, and another
     view's save can never be silently reverted by this one.
     Display resolution mirrors the Playground's: the record's
     figure, falling back to the Retirement calculator's
     default when the record has none; the chart line and the
     hero comparison read the local field while it parses to a
     positive figure, so they move live as the target is typed,
     and fall back to the record's figure while the field is
     blank or unparseable. When there is no saved Tax Plan
     record yet, there is nothing to write through to and the
     edit stays in this view only. No pricing is touched: the
     target never enters the true-cost computation. */
  const rothQ = useQuery({
    queryKey: ["rothplanner"],
    queryFn: () => api.getRothPlanner({}),
  });
  const retCalcQ = useQuery({
    queryKey: ["retirementcalc"],
    queryFn: () => api.getRetirementCalc({}),
  });
  const [spendingTarget, setSpendingTarget] = useState("");
  const [spendingTargetMsg, setSpendingTargetMsg] = useState<string | null>(null);
  const spendingTargetFocusedRef = useRef(false);
  // Per year / per month entry unit for the target field: the
  // same toggle the Tax Plan's "Yearly spending" field
  // (build v141) and the Playground's spending field carry.
  // "year" shows and edits the annual dollars directly;
  // "month" shows annual ÷ 12 and turns a typed monthly amount
  // into annual at exactly monthly × 12 (monthlyToAnnual in
  // rothShared — the shared conversion, so the rounding is
  // identical everywhere). The state stays the annual string
  // in both units — the queue, the chart line, and the hero
  // all keep reading it unchanged — and switching units never
  // rewrites it. The unit itself is a remembered display
  // preference in the generic server-side fold store (the
  // "spending.targetPerMonth" flag, the same store and pattern
  // the Playground's Year / Month pills use): a stored entry
  // means the user last left it on per month; no entry is the
  // per-year default, so the field opens per year for a user
  // who has never toggled it, and the last pick comes back
  // after a reload, in a new session, and on another device.
  // Display only — it changes no stored figure.
  const [spendingTargetPerMonth, setSpendingTargetPerMonth] =
    usePersistedFold("spending.targetPerMonth");
  const spendingTargetUnit: "year" | "month" = spendingTargetPerMonth
    ? "month"
    : "year";
  const setSpendingTargetUnit = (unit: "year" | "month") =>
    setSpendingTargetPerMonth(unit === "month");
  // Per-month draft: while the field is focused in per-month
  // mode, the input shows the monthly figure as the user types
  // it — the state is annual dollars, so the typed monthly
  // string lives here until blur, and each keystroke also
  // writes the annual equivalent (monthly × 12) into
  // spendingTarget. Null whenever the field is not focused in
  // per-month mode.
  const [spendingTargetMonthlyDraft, setSpendingTargetMonthlyDraft] = useState<string | null>(null);
  // The monthly figure for display when the field is not
  // focused in per-month mode: the annual figure divided by
  // twelve, rounded to the cent and grouped like the money
  // fields ($180,000/yr shows as 15,000.00). Blank and
  // unparseable text pass through exactly as typed.
  const spendingTargetMonthlyDisplay = (): string => {
    const cents = parseDollars(spendingTarget);
    if (cents == null) return spendingTarget;
    return fmtInputMoney(Math.round(cents / 12));
  };
  const spendingTargetSourceCents =
    rothQ.data?.saved?.annualSpendingCents ??
    retCalcQ.data?.defaultSpendingAnnualCents ??
    null;
  useEffect(() => {
    if (spendingTargetSourceCents == null) return;
    if (spendingTargetFocusedRef.current) return;
    const next = fmtInputMoney(spendingTargetSourceCents);
    setSpendingTarget((prev) => (prev === next ? prev : next));
  }, [spendingTargetSourceCents]);
  // The target the chart line and hero comparison use: the
  // local field when it parses to a positive figure, else the
  // record's resolved figure (hidden when neither resolves or
  // the resolved figure is $0 — no target to compare against).
  const spendingTargetResolvedCents =
    spendingTargetSourceCents != null && spendingTargetSourceCents > 0
      ? spendingTargetSourceCents
      : null;
  const spendingTargetLocalCents = parseDollars(spendingTarget);
  const spendingTargetAnnualCents =
    spendingTargetLocalCents != null && spendingTargetLocalCents > 0
      ? spendingTargetLocalCents
      : spendingTargetResolvedCents;
  const spendingTargetMonthlyCents =
    spendingTargetAnnualCents != null
      ? Math.round(spendingTargetAnnualCents / 12)
      : null;
  const spendingTargetRevisionRef = useRef(0);
  useEffect(() => {
    if (rothQ.data) spendingTargetRevisionRef.current = rothQ.data.revision;
  }, [rothQ.data]);
  const spendingTargetTimer = useRef<number | null>(null);
  const pendingSpendingTargetSave = useRef<{ annualSpendingCents: number } | null>(null);
  const spendingTargetSaveInFlightRef = useRef(false);
  // Build v177 (re-audit NICE-TO-HAVE N-3): consecutive
  // hold polls by the fire path below while it waits for
  // the in-flight save to settle, bounded by
  // SAVE_HOLD_MAX_POLLS — see the hold branch there.
  const spendingTargetHoldPollsRef = useRef(0);
  const spendingTargetSave = useMutation({
    mutationFn: (input: RothSavePayload) =>
      api.saveRothInputs({
        ...input,
        baseRevision: spendingTargetRevisionRef.current,
      }),
    onError: () => {
      // A failed write-through says so instead of vanishing
      // silently (build v151): the edit stays queued and
      // its per-call onError re-arms a retry.
      setSpendingTargetMsg(
        "Could not save — your entries stay on this screen.",
      );
    },
    onSuccess: (res) => {
      if (res.ok) {
        setSpendingTargetMsg(null);
        spendingTargetRevisionRef.current = res.revision;
        queryClient.invalidateQueries({ queryKey: ["rothplanner"] });
        return;
      }
      // Conflict: a newer Tax Plan save landed first. Seed the
      // cache with the record the refusal carries and RESET
      // the field from it explicitly (build v158) — re-show
      // the stored target — and say plainly what happened.
      spendingTargetRevisionRef.current = res.revision;
      if (spendingTargetTimer.current != null) {
        window.clearTimeout(spendingTargetTimer.current);
        spendingTargetTimer.current = null;
      }
      pendingSpendingTargetSave.current = null;
      queryClient.setQueryData(["rothplanner"], res.record);
      const storedCents = res.record.saved?.annualSpendingCents ?? null;
      if (storedCents != null) {
        setSpendingTarget(fmtInputMoney(storedCents));
      }
      queryClient.invalidateQueries({ queryKey: ["rothplanner"] });
      // Re-audit NICE-TO-HAVE N-2, twin instance (found while
      // resolving N-2): this message was guarded by a
      // pending-save flag with the same lifecycle as the
      // Playground flag the N-2 build removed — initialised
      // false, set to true only in queueSpendingTargetSave
      // immediately before the only queued-delta assignment
      // (the fire path sends nothing else), and never cleared
      // — so the guard was always true by the time any
      // conflict was handled and could never discriminate.
      // The message is set unconditionally, exactly as it
      // effectively behaved.
      setSpendingTargetMsg(
        "This plan was changed in the Tax Plan (or another tab), so the spending target edit just made here was not kept. The latest saved version is shown now.",
      );
    },
  });
  const spendingTargetSaveMutateRef = useRef(spendingTargetSave.mutate);
  spendingTargetSaveMutateRef.current = spendingTargetSave.mutate;
  // Build the whole-record save payload for a target spending
  // value from the CURRENT fetched record (build v152):
  // every field comes from the freshest record this view
  // holds; only annualSpendingCents is the caller's. Returns
  // null when there is no saved record to write through to,
  // or when the fresh record already holds the target value.
  const buildSpendingTargetPayload = (
    targetCents: number,
  ): RothSavePayload | null => {
    const rp = rothQ.data;
    if (!rp || !rp.saved) return null;
    if (targetCents === rp.saved.annualSpendingCents) return null;
    const {
      rolledOver: _rolledOver,
      clearedYear: _clearedYear,
      ...execution
    } = rp.execution;
    return {
      ...rp.saved,
      ...execution,
      ...rp.mcCheck,
      ...rp.gift,
      ...rp.taxReturn,
      annualSpendingCents: targetCents,
    };
  };
  const buildSpendingTargetPayloadRef = useRef(buildSpendingTargetPayload);
  buildSpendingTargetPayloadRef.current = buildSpendingTargetPayload;
  const firePendingSpendingTargetSave = () => {
    const pending = pendingSpendingTargetSave.current;
    if (!pending) return;
    if (spendingTargetFocusedRef.current) {
      // Settled-value gate: the field is still being edited, so
      // the queued edit may still change. Hold it — the blur
      // flush sends it once focus leaves the field.
      return;
    }
    if (spendingTargetSaveInFlightRef.current) {
      // Build v177 (re-audit NICE-TO-HAVE N-3): this hold
      // is BOUNDED. Before v177 it re-armed the 300 ms
      // re-check without limit: a save whose call never
      // settles (a hung request — the mutation's promise
      // neither resolves nor rejects, so onSettled never
      // runs and the in-flight flag never clears) held the
      // queued edit behind it forever, polling for the life
      // of the view. After SAVE_HOLD_MAX_POLLS consecutive
      // polls (100 × 300 ms = 30 s, far beyond any save this
      // app makes) the hold gives up explicitly: polling
      // stops, the edit STAYS queued (a later edit or the
      // blur flush fires it, and if the wedged save ever
      // does settle its own per-call handlers run exactly
      // as before), and the failure is surfaced with the
      // same line a failed save uses. Nothing is sent
      // concurrently — the deferral behind a settling save
      // is untouched.
      spendingTargetHoldPollsRef.current += 1;
      if (spendingTargetHoldPollsRef.current > SAVE_HOLD_MAX_POLLS) {
        spendingTargetHoldPollsRef.current = 0;
        if (spendingTargetTimer.current != null) {
          window.clearTimeout(spendingTargetTimer.current);
          spendingTargetTimer.current = null;
        }
        setSpendingTargetMsg(
          "Could not save — your entries stay on this screen.",
        );
        return;
      }
      if (spendingTargetTimer.current != null) {
        window.clearTimeout(spendingTargetTimer.current);
      }
      spendingTargetTimer.current = window.setTimeout(
        firePendingSpendingTargetSave,
        300,
      );
      return;
    }
    const payload = buildSpendingTargetPayloadRef.current(
      pending.annualSpendingCents,
    );
    if (!payload) {
      // Nothing to send: no saved record to write through to,
      // or the fresh record already holds this target.
      pendingSpendingTargetSave.current = null;
      spendingTargetHoldPollsRef.current = 0;
      return;
    }
    // The edit stays queued until the save SUCCEEDS (contract
    // v151): success drops it, error re-arms a retry of it.
    spendingTargetHoldPollsRef.current = 0;
    spendingTargetSaveInFlightRef.current = true;
    spendingTargetSaveMutateRef.current(payload, {
      onSuccess: () => {
        if (pendingSpendingTargetSave.current === pending) {
          pendingSpendingTargetSave.current = null;
        }
      },
      onError: () => {
        if (pendingSpendingTargetSave.current === pending) {
          if (spendingTargetTimer.current != null) {
            window.clearTimeout(spendingTargetTimer.current);
          }
          spendingTargetTimer.current = window.setTimeout(
            firePendingSpendingTargetSave,
            3000,
          );
        }
      },
      onSettled: () => {
        spendingTargetSaveInFlightRef.current = false;
      },
    });
  };
  const firePendingSpendingTargetSaveRef = useRef(firePendingSpendingTargetSave);
  firePendingSpendingTargetSaveRef.current = firePendingSpendingTargetSave;
  const queueSpendingTargetSave = () => {
    // Queue ONLY the local spending delta (build v152) —
    // never a whole-record payload.
    const rp = rothQ.data;
    if (!rp || !rp.saved) return;
    const cents = parseDollars(spendingTarget);
    // A blank or unparseable field queues nothing and leaves
    // any earlier queued edit in place (a half-typed value can
    // never blank or replace a queued save).
    if (cents == null) return;
    if (cents === rp.saved.annualSpendingCents) {
      // The field is back at the stored value — the edit was
      // reverted, so nothing is owed: drop any queued delta
      // instead of leaving a superseded value queued to fire
      // on blur (the Retirement queue's rule, build v153).
      pendingSpendingTargetSave.current = null;
      return;
    }
    pendingSpendingTargetSave.current = { annualSpendingCents: cents };
    firePendingSpendingTargetSaveRef.current();
  };
  const queueSpendingTargetSaveRef = useRef(queueSpendingTargetSave);
  queueSpendingTargetSaveRef.current = queueSpendingTargetSave;
  useEffect(() => {
    queueSpendingTargetSaveRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spendingTarget]);

  /* transaction form state */
  const [showTxnForm, setShowTxnForm] = useState(false);
  const [editingTxnId, setEditingTxnId] = useState<number | null>(null);
  // Build v65 (F13): the transaction as loaded when the editor
  // opened — sent back as the update's CAS base.
  const [editingTxnBase, setEditingTxnBase] = useState<
    ApiRequest<typeof api, "updateTransaction">["base"] | null
  >(null);
  // Build v121 (F3): the restore epoch as loaded when the
  // editor opened (getDashboard's restoreEpoch) — frozen at open
  // like the CAS base, so a restore since the load refuses the
  // save even when the stored row still equals the base.
  const [editingTxnEpoch, setEditingTxnEpoch] = useState<number | null>(null);
  const [tDate, setTDate] = useState(todayStr());
  const [tDesc, setTDesc] = useState("");
  const [tDollars, setTDollars] = useState("");
  const [tRefund, setTRefund] = useState(false);
  const [tSource, setTSource] = useState<"checking" | "card">("checking");
  const [tAccount, setTAccount] = useState("Checking");
  const [tKind, setTKind] = useState<"spending" | "card_payment" | "transfer">("spending");
  const [tCategory, setTCategory] = useState("Other");
  const [tYearlyId, setTYearlyId] = useState<string>("");
  const [formError, setFormError] = useState("");

  /* yearly form state */
  const [showYearlyForm, setShowYearlyForm] = useState(false);
  const [editingYearlyId, setEditingYearlyId] = useState<number | null>(null);
  // Build v65 (F17): the expense exactly as loaded when the
  // editor opened — the save's CAS base (parent fields plus the
  // version stored for the save's effective month).
  const [editingYearly, setEditingYearly] = useState<Yearly | null>(null);
  // Build v121 (F3): the restore epoch as loaded when the
  // editor opened — frozen at open like the CAS base.
  const [editingYearlyEpoch, setEditingYearlyEpoch] = useState<number | null>(null);
  const [yName, setYName] = useState("");
  const [yFrequency, setYFrequency] = useState<"yearly" | "bimonthly" | "quarterly" | "semiannual">("yearly");
  const [yDollars, setYDollars] = useState("");
  const [yDueMonth, setYDueMonth] = useState<string>(() =>
    String(new Date().getMonth() + 1),
  );
  const [yPaidType, setYPaidType] = useState<"checking" | "card">("checking");
  const [yPaidName, setYPaidName] = useState("Checking");
  const [yCategory, setYCategory] = useState("Uncategorized");
  const [yKeepLightsOn, setYKeepLightsOn] = useState(false);
  const [yEffectiveFrom, setYEffectiveFrom] = useState(currentMonth());
  const [yearlyError, setYearlyError] = useState("");

  /* monthly summary (one cash-out number) state */
  const [showSummaryForm, setShowSummaryForm] = useState(false);
  const [sMonth, setSMonth] = useState(currentMonth());
  // Build v65 (F15): the month + stored total as loaded when
  // the summary form opened — the save's CAS base. If the user
  // changes the month in the form, the base is recomputed from
  // the loaded dashboard for that month instead.
  const [summaryBase, setSummaryBase] = useState<{
    month: string;
    cashOutCents: number | null;
  } | null>(null);
  // Build v121 (F3): the restore epoch as loaded when the
  // summary form opened — frozen at open like the CAS base.
  const [summaryEpoch, setSummaryEpoch] = useState<number | null>(null);
  const [sDollars, setSDollars] = useState("");
  const [summaryError, setSummaryError] = useState("");

  /* cash-out items state: per-month line items that roll up to the
     month's cash out. Each month's expanded/collapsed state ("Hide
     items / Show items") persists server-side in the generic fold
     store (id "spending.cashout.<month>"), so a month left expanded
     comes back expanded after a reload or in a new session; a
     month never toggled has no entry and stays collapsed, exactly
     as before. The session override map keeps a toggle (and the
     auto-expansion when an item is added or edited) instant; the
     stored value lands a moment later and agrees with it. */
  const foldMap = useFoldStateMap();
  const setFold = useSetFold();
  const [cashOutFoldOverrides, setCashOutFoldOverrides] = useState<
    Record<string, boolean>
  >({});
  const cashOutMonthExpanded = (m: string): boolean =>
    cashOutFoldOverrides[m] ??
    foldMap.data?.open[`spending.cashout.${m}`] ??
    false;
  const setCashOutMonthExpanded = (m: string, next: boolean) => {
    setCashOutFoldOverrides((prev) => ({ ...prev, [m]: next }));
    setFold.mutate({ id: `spending.cashout.${m}`, open: next });
  };
  const [showItemForm, setShowItemForm] = useState(false);
  const [editingItemId, setEditingItemId] = useState<number | null>(null);
  // Build v65 (F14): the cash-out item as loaded when the
  // editor opened — sent back as the update's CAS base.
  const [editingItemBase, setEditingItemBase] = useState<
    ApiRequest<typeof api, "updateCashOutItem">["base"] | null
  >(null);
  // Build v121 (F3): the restore epoch as loaded when the
  // editor opened — frozen at open like the CAS base.
  const [editingItemEpoch, setEditingItemEpoch] = useState<number | null>(null);
  const [iDate, setIDate] = useState(() => `${currentMonth()}-01`);
  const [iDesc, setIDesc] = useState("");
  const [iDollars, setIDollars] = useState("");
  const [iNote, setINote] = useState("");
  const [itemError, setItemError] = useState("");

  /* monthly bills state */
  const [showBillForm, setShowBillForm] = useState(false);
  const [editingBillId, setEditingBillId] = useState<number | null>(null);
  // Build v65 (F18/F16): the bill exactly as loaded when the
  // editor opened — the CAS bases for the metadata save (all five
  // fields) and the chained amount save (the version stored for
  // the chosen effective month).
  const [editingBill, setEditingBill] = useState<Bill | null>(null);
  // Build v121 (F3): the restore epoch as loaded when the
  // editor opened — frozen at open like the CAS bases.
  const [editingBillEpoch, setEditingBillEpoch] = useState<number | null>(null);
  const [bName, setBName] = useState("");
  const [bDollars, setBDollars] = useState("");
  const [bEffectiveFrom, setBEffectiveFrom] = useState(currentMonth());
  const [bPaidBy, setBPaidBy] = useState("Credit Card");
  const [bNotes, setBNotes] = useState("");
  const [bCategory, setBCategory] = useState("Uncategorized");
  const [bKeepLightsOn, setBKeepLightsOn] = useState(false);
  const [billError, setBillError] = useState("");

  /* one-off notes state */
  const [showOneOffForm, setShowOneOffForm] = useState(false);
  const [editingOneOffId, setEditingOneOffId] = useState<number | null>(null);
  // Build v121 (F3): the restore epoch as loaded when the
  // editor opened — frozen at open, so a restore since the load
  // refuses the save.
  const [editingOneOffEpoch, setEditingOneOffEpoch] = useState<number | null>(null);
  const [oMonth, setOMonth] = useState(currentMonth());
  const [oDesc, setODesc] = useState("");
  const [oDollars, setODollars] = useState("");
  const [oNote, setONote] = useState("");
  const [oneOffError, setOneOffError] = useState("");

  /* The statement import panel's open/closed state persists in
     the generic fold store, like the cash-out months above. */
  const [showImport, setShowImport] = usePersistedFold("spending.import");
  /* The True cost "Heads up" notice's details fold: one line by
     default, the full explanation one tap away. Its open/closed
     state persists in the generic fold store like the app's
     other folds, default collapsed. */
  const [headsUpOpen, setHeadsUpOpen] = usePersistedFold(
    "spending.trueCostHeadsUp",
  );
  /* The Monthly bills roster's open/closed state: the roster is
     reference data the user doesn't need on screen all the time, so
     it sits behind this persisted fold — DEFAULT COLLAPSED when no
     saved state exists (usePersistedFold's default), and whatever
     state it is left in persists across sessions like the app's
     other section folds. The section header (title, total, info
     tip, fold toggle) stays visible either way; the Add button
     lives at the top of the panel body, hidden when folded. */
  const [monthlyBillsOpen, setMonthlyBillsOpen] = usePersistedFold(
    "spending.monthlyBills",
  );
  /* The Yearly & periodic roster's open/closed state: same treatment
     as Monthly bills — the roster is reference data, so it sits behind
     this persisted fold, DEFAULT COLLAPSED when no saved state exists,
     persisting across sessions. The section header (title, compact
     yearly total + set-aside, info tip, fold toggle) stays visible
     either way; the Add button lives at the top of the panel body,
     hidden when folded. */
  const [yearlyBillsOpen, setYearlyBillsOpen] = usePersistedFold(
    "spending.yearlyBills",
  );
  /* The Transactions list's open/closed state: unlike the two
     bills rosters the list is the section's main content and has
     always been on screen, so it stays DEFAULT OPEN — and the
     fold store only records a fold's non-default state, so this
     stores the inverse flag (same pattern as the Retirement
     inputs fold): an entry under "spending.transactionsFolded"
     means the user left the list folded shut; no entry means
     open, its default. The section header (title, info tip, fold
     toggle) stays visible either way; the Import and Add buttons
     live at the top of the panel body, hidden when folded.
     Display only — no figure reads this flag. */
  const [transactionsFolded, setTransactionsFolded] = usePersistedFold(
    "spending.transactionsFolded",
  );
  const transactionsOpen = !transactionsFolded;
  /* Smoothed-bill payments filter for the Transactions list:
     set by tapping "− Smoothed bills paid this month" in the
     Smoothed spend breakdown — the list then shows only this
     month's transactions marked as a smoothed bill, with a
     notice and a way back to the full list. Session-local view
     state, cleared when the month changes. Display only — no
     figure reads it. NOTE (round-9 SHOULD-2): the breakdown tap
     no longer uses this filter — the figure it explains is on
     the settlement basis, which this charge-month filter cannot
     show; the tap opens the settlement breakdown panel below
     instead. This state remains for the Transactions list's own
     filtered rendering and is deliberately left as it is. */
  const [smoothedOnly, setSmoothedOnly] = useState(false);
  /* Settlement-basis breakdown for "Smoothed bills paid this
     month": opened by that line's tap in the Smoothed spend
     breakdown. The figure counts net settlements in the
     settlement month — a bill charged to a card counts when
     the card payment settles it, not in the charge month, and
     a refund counts in its own month — the part matching a
     previously settled charge reverses that settlement, and
     any part beyond what was ever settled is shown on its
     own unmatched line — so the breakdown is the month's
     settlement lines from the same spending core (through
     getExplorerMonthLines, the explorer drill-down's read),
     footing exactly to the figure. Session-local view state,
     cleared when the month changes. Display only — no figure
     reads it. */
  const [smoothedBreakdownOpen, setSmoothedBreakdownOpen] = useState(false);
  const smoothedBreakdown = useQuery({
    queryKey: ["smoothedPaidBreakdown", month],
    queryFn: () => api.getExplorerMonthLines({ month }),
    enabled: smoothedBreakdownOpen,
    retry: retryReadOnlyLoad,
    retryDelay: actionRetryDelay,
  });
  const smoothedBreakdownRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (smoothedBreakdownOpen) {
      smoothedBreakdownRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [smoothedBreakdownOpen]);
  const [showExplorer, setShowExplorer] = useState(false);
  const [explorerGroupBy, setExplorerGroupBy] =
    useState<ExplorerGroupBy>("category");
  const [highlightedSection, setHighlightedSection] = useState<string | null>(
    null,
  );
  const highlightTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (highlightTimer.current != null) {
        window.clearTimeout(highlightTimer.current);
      }
    };
  }, []);
  const [actionMsg, setActionMsg] = useState("");
  const [confirmMonthlyVersionId, setConfirmMonthlyVersionId] = useState<number | null>(null);
  /* Per-row tap-to-open overrides for the Monthly bills roster:
     tapping a bill row opens it in place into its edit controls
     (amount, category, Keep the lights on) or closes it again.
     The roster's Expand all / Collapse all flag stays the default
     for every row; these two hold only the row the user tapped
     against that default — expandedBillId in collapse-all mode,
     collapsedBillId in expand-all mode. Session-local view state
     like the other per-row UI state here; the Expand/Collapse all
     button resets both. Display only — no figure reads them. */
  const [expandedBillId, setExpandedBillId] = useState<number | null>(null);
  const [collapsedBillId, setCollapsedBillId] = useState<number | null>(null);
  const [confirmYearlyVersionId, setConfirmYearlyVersionId] = useState<number | null>(null);
  // Month (YYYY-MM) whose cash-out ✕ is showing its delete
  // confirmation; null = no confirmation open. Tapping ✕ only
  // opens this — the delete itself runs from the confirmation's
  // Delete button, so one stray tap can't remove a month.
  const [confirmDeleteSummaryMonth, setConfirmDeleteSummaryMonth] = useState<string | null>(null);
  // Same one-tap protection for every other row delete in this
  // view: each ✕ only opens its row's confirmation — the delete
  // itself runs from the confirmation's Delete button, so one
  // stray tap can't remove a bill, expense, transaction, item,
  // or one-off. Null = no confirmation open.
  const [confirmDeleteBillId, setConfirmDeleteBillId] = useState<number | null>(null);
  const [confirmDeleteYearlyId, setConfirmDeleteYearlyId] = useState<number | null>(null);
  const [confirmDeleteTxnId, setConfirmDeleteTxnId] = useState<number | null>(null);
  const [confirmDeleteCashOutItemId, setConfirmDeleteCashOutItemId] = useState<number | null>(null);
  const [confirmDeleteOneOffId, setConfirmDeleteOneOffId] = useState<number | null>(null);
  const [versionDeleteError, setVersionDeleteError] = useState("");
  const [recordingYearlyId, setRecordingYearlyId] = useState<number | null>(null);

  useEffect(() => {
    setRecordingYearlyId(null);
    setSmoothedOnly(false);
    setSmoothedBreakdownOpen(false);
  }, [month]);

  const data = dash.data;

  // The Transactions list as shown: the full month, or — while
  // the smoothedOnly filter is on — only the month's transactions
  // marked as a smoothed bill. (The Smoothed spend breakdown's
  // smoothed-bills-paid tap no longer drives this filter: the
  // figure is settlement-basis, so the tap opens the settlement
  // breakdown panel instead — see goToSmoothedBillsPaid.)
  const visibleMonthTransactions = smoothedOnly
    ? (data?.monthTransactions ?? []).filter((t) => t.yearlyExpenseId != null)
    : (data?.monthTransactions ?? []);

  // Collapse-all flags: optimistic — each section flips immediately
  // from local state and the choice persists in the background
  // (build v132). Before the first read lands each shows
  // collapsed, the stored default. On a refused write (a restore
  // since the load) the override is dropped so the section shows
  // the stored value again. A rapid second click reads the
  // already-flipped local value, so it sends the opposite choice
  // instead of repeating the first.
  const [monthlyBillsCollapsedAllOverride, setMonthlyBillsCollapsedAllOverride] =
    useState<boolean | null>(null);
  const [yearlyBillsCollapsedAllOverride, setYearlyBillsCollapsedAllOverride] =
    useState<boolean | null>(null);
  const [byCategoryCollapsedAllOverride, setByCategoryCollapsedAllOverride] =
    useState<boolean | null>(null);
  const [yearInSpendingCollapsedAllOverride, setYearInSpendingCollapsedAllOverride] =
    useState<boolean | null>(null);
  const monthlyBillsCollapsedAll =
    monthlyBillsCollapsedAllOverride ?? data?.monthlyBillsCollapsedAll ?? true;
  const yearlyBillsCollapsedAll =
    yearlyBillsCollapsedAllOverride ?? data?.yearlyBillsCollapsedAll ?? true;
  const byCategoryCollapsedAll =
    byCategoryCollapsedAllOverride ?? data?.byCategoryCollapsedAll ?? true;
  const yearInSpendingCollapsedAll =
    yearInSpendingCollapsedAllOverride ?? data?.yearInSpendingCollapsedAll ?? true;

  /* Quick view navigation: smooth-scroll to a section, flash a
     highlight ring on it for ~1.5s, and (for the collapsible targets)
     expand the section through its persisted toggle action when it is
     currently collapsed — the expansion persists like a manual toggle
     and no other section's state is touched. */
  function highlightCls(id: string): string {
    return highlightedSection === id
      ? " outline outline-2 outline-[var(--accent)] outline-offset-4"
      : "";
  }

  function scrollToSection(id: string) {
    if (id === "section-monthly-bills") {
      /* The roster fold opens (persisted) as part of the scroll, so
         the tile tap never lands on a collapsed section. */
      if (!monthlyBillsOpen) setMonthlyBillsOpen(true);
      if (monthlyBillsCollapsedAll) {
        handleMonthlyBillsCollapsedAllChange(false);
      }
    }
    if (id === "section-yearly-expenses") {
      /* The roster fold opens (persisted) as part of the scroll, so
         the tile tap never lands on a collapsed section. */
      if (!yearlyBillsOpen) setYearlyBillsOpen(true);
      if (yearlyBillsCollapsedAll) {
        handleYearlyBillsCollapsedAllChange(false);
      }
    }
    if (id === "section-transactions") {
      /* The list fold opens (persisted) as part of the scroll, so
         a breakdown tap never lands on a collapsed list. */
      if (transactionsFolded) setTransactionsFolded(false);
    }
    document
      .getElementById(id)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
    setHighlightedSection(id);
    if (highlightTimer.current != null) {
      window.clearTimeout(highlightTimer.current);
    }
    highlightTimer.current = window.setTimeout(
      () => setHighlightedSection(null),
      1600,
    );
  }

  /* Smoothed spend breakdown provenance taps (taps only — nothing
     is edited in place): each input line's amount goes to where
     that figure comes from, as the user mapped them. The cash-out
     line goes to Monthly cash out for a summary month (an entered
     total lives there) and for an items month (the figure is the
     sum of the month's cash-out items, which live there too);
     only the plain variant — where the figure derives from the
     month's transactions — goes to this month's Transactions list
     (unfiltered). The smoothed-bills-paid line opens the
     settlement-basis breakdown panel under the breakdown (below):
     the figure counts net settlements in the settlement month
     (a refund counts in its own month — the part matching a
     previously settled charge reverses that settlement, the
     rest is shown as unmatched), so a charge-month filter of the
     Transactions list cannot show it —
     a card charge sits in its charge month carrying the bill
     link, while the checking card payment that settles it (the
     transaction the figure actually counts) carries none. The
     set-aside line uses
     scrollToSection("section-yearly-expenses") directly. */
  function goToCashOutSource() {
    if (data?.isSummaryMonth || data?.isItemsMonth) {
      scrollToSection("section-cash-out");
    } else {
      setSmoothedOnly(false);
      scrollToSection("section-transactions");
    }
  }

  function goToSmoothedBillsPaid() {
    setSmoothedBreakdownOpen((open) => !open);
  }

  function scrollToQuickView() {
    document
      .getElementById("quick-view")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function openExplorer(groupBy: ExplorerGroupBy) {
    setExplorerGroupBy(groupBy);
    setShowExplorer(true);
  }

  const yearlyNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const y of data?.yearly ?? []) m.set(y.id, y.name);
    return m;
  }, [data]);

  // Category picker options: presets plus any custom categories already
  // in use, so a custom name can be reused on other bills.
  const billCategoryOptions = useMemo(() => {
    const s = new Set<string>(BILL_CATEGORY_PRESETS);
    for (const c of data?.billCategories ?? []) s.add(c);
    return [...s];
  }, [data]);

  // Cash-out item Name options (build v139): the distinct names
  // already on cash-out items, most recent first, so last month's
  // names sit at the top. Exact strings only — similar-looking names
  // are separate entries, never merged. Derived from cashOutMonths
  // (every month with items); cashOutItems alone holds only the
  // selected month. cashOutMonths is oldest-first and each month's
  // items are day-ascending, so both are walked backwards.
  const cashOutNameOptions = useMemo(() => {
    const seen = new Set<string>();
    const names: string[] = [];
    const months = data?.cashOutMonths ?? [];
    for (let m = months.length - 1; m >= 0; m--) {
      const month = months[m];
      if (!month) continue;
      const items = month.items;
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (!it) continue;
        const d = it.description;
        if (!seen.has(d)) {
          seen.add(d);
          names.push(d);
        }
      }
    }
    return names;
  }, [data?.cashOutMonths]);

  const addTxn = useMutation({
    mutationFn: (input: TxnInput) => api.addTransaction(input),
    onSuccess: () => {
      invalidate();
      resetTxnForm();
    },
    onError: (e) => setFormError(String(e)),
  });
  const updateTxn = useMutation({
    mutationFn: (input: TxnInput & { id: number } & {
      base?: ApiRequest<typeof api, "updateTransaction">["base"];
      baseEpoch?: number;
    }) => api.updateTransaction(input),
    onSuccess: (r) => {
      if (!r.ok) {
        // CAS refusal (build v65, F13): the stored row moved
        // since this form loaded — keep the form open and show
        // why instead of resetting over the newer value.
        setFormError(r.reason ?? "That transaction could not be updated.");
        return;
      }
      invalidate();
      resetTxnForm();
    },
    onError: (e) => setFormError(String(e)),
  });
  const deleteTxn = useMutation({
    // Build v121 (F3): an immediate delete carries the epoch
    // of the data on screen (the row the user is looking at).
    mutationFn: (id: number) => api.deleteTransaction({ id, baseEpoch: data?.restoreEpoch ?? 0 }),
    onSuccess: (r) => {
      if (!r.ok) setActionMsg(r.reason ?? "That transaction could not be deleted.");
      invalidate();
    },
  });
  const addYearly = useMutation({
    mutationFn: (input: ApiRequest<typeof api, "addYearlyExpense">) =>
      api.addYearlyExpense(input),
    onSuccess: () => {
      invalidate();
      resetYearlyForm();
      /* Reveal the new entry: if the roster fold was collapsed, open
         it (persisted) so the bill just added is visible. */
      setYearlyBillsOpen(true);
    },
    onError: (e) => setYearlyError(String(e)),
  });
  const updateYearly = useMutation({
    mutationFn: (input: ApiRequest<typeof api, "updateYearlyExpense">) =>
      api.updateYearlyExpense(input),
    onSuccess: (r) => {
      if (!r.ok) {
        // CAS refusal (build v65, F17): keep the form open and
        // show why instead of resetting over the newer value.
        setYearlyError(r.reason ?? "That expense could not be updated.");
        return;
      }
      invalidate();
      resetYearlyForm();
    },
    onError: (e) => setYearlyError(String(e)),
  });
  const deleteYearly = useMutation({
    // Build v121 (F3): an immediate delete carries the epoch
    // of the data on screen.
    mutationFn: (id: number) => api.deleteYearlyExpense({ id, baseEpoch: data?.restoreEpoch ?? 0 }),
    onSuccess: (r) => {
      if (!r.ok) setActionMsg(r.reason ?? "That expense could not be deleted.");
      invalidate();
    },
  });
  const deleteYearlyVersion = useMutation({
    // Build v121 (F3): carries the epoch of the data on screen.
    mutationFn: (versionId: number) => api.deleteYearlyExpenseVersion({ versionId, baseEpoch: data?.restoreEpoch ?? 0 }),
    onSuccess: (r) => {
      setConfirmYearlyVersionId(null);
      if (!r.ok) {
        setVersionDeleteError(r.reason);
      } else {
        setVersionDeleteError("");
        setActionMsg(r.reason);
      }
      invalidate();
    },
    onError: (e) => setVersionDeleteError(String(e)),
  });
  const deleteMonthlyVersion = useMutation({
    // Build v121 (F3): carries the epoch of the data on screen.
    mutationFn: (versionId: number) => api.deleteMonthlyBillVersion({ versionId, baseEpoch: data?.restoreEpoch ?? 0 }),
    onSuccess: (r) => {
      setConfirmMonthlyVersionId(null);
      if (!r.ok) {
        setVersionDeleteError(r.reason);
      } else {
        setVersionDeleteError("");
        setActionMsg(r.reason);
      }
      invalidate();
    },
    onError: (e) => setVersionDeleteError(String(e)),
  });
  const upsertSummary = useMutation({
    mutationFn: (input: ApiRequest<typeof api, "upsertMonthlySummary">) =>
      api.upsertMonthlySummary(input),
    onSuccess: (r) => {
      if (!r.ok) {
        // CAS refusal (build v65, F15): keep the form open and
        // show why instead of closing over the newer value.
        setSummaryError(r.reason ?? "That month's total could not be saved.");
        return;
      }
      invalidate();
      setShowSummaryForm(false);
      setSummaryEpoch(null);
      setSDollars("");
      setSummaryError("");
    },
    onError: (e) => setSummaryError(String(e)),
  });
  const deleteSummary = useMutation({
    // Build v121 (F3): an immediate delete carries the epoch
    // of the data on screen.
    mutationFn: (m: string) => api.deleteMonthlySummary({ month: m, baseEpoch: data?.restoreEpoch ?? 0 }),
    onSuccess: (r) => {
      if (!r.ok) setActionMsg(r.reason ?? "That month's total could not be removed.");
      invalidate();
    },
  });
  const addCashOutItem = useMutation({
    mutationFn: (input: ApiRequest<typeof api, "addCashOutItem">) =>
      api.addCashOutItem(input),
    onSuccess: (_r, input) => {
      invalidate();
      resetItemForm();
      setCashOutMonthExpanded(input.month, true);
    },
    onError: (e) => setItemError(String(e)),
  });
  const updateCashOutItem = useMutation({
    mutationFn: (input: ApiRequest<typeof api, "updateCashOutItem">) =>
      api.updateCashOutItem(input),
    onSuccess: (r, input) => {
      if (!r.ok) {
        // CAS refusal (build v65, F14): keep the form open and
        // show why instead of resetting over the newer value.
        setItemError(r.reason ?? "That item could not be updated.");
        return;
      }
      invalidate();
      resetItemForm();
      setCashOutMonthExpanded(input.month, true);
    },
    onError: (e) => setItemError(String(e)),
  });
  const deleteCashOutItem = useMutation({
    // Build v121 (F3): an immediate delete carries the epoch
    // of the data on screen.
    mutationFn: (id: number) => api.deleteCashOutItem({ id, baseEpoch: data?.restoreEpoch ?? 0 }),
    onSuccess: (r) => {
      if (!r.ok) setActionMsg(r.reason ?? "That item could not be deleted.");
      invalidate();
    },
  });
  const addBill = useMutation({
    mutationFn: (input: ApiRequest<typeof api, "addMonthlyBill">) =>
      api.addMonthlyBill(input),
    onSuccess: () => {
      invalidate();
      resetBillForm();
      /* Reveal the new entry: if the roster fold was collapsed, open
         it (persisted) so the bill just added is visible. */
      setMonthlyBillsOpen(true);
    },
    onError: (e) => setBillError(String(e)),
  });
  const updateBill = useMutation({
    mutationFn: (input: ApiRequest<typeof api, "updateMonthlyBill">) =>
      api.updateMonthlyBill(input),
    onSuccess: (r) => {
      if (!r.ok) {
        // CAS refusal (build v65, F18): keep the form open and
        // show why — the chained amount save must NOT run either.
        setBillError(r.reason ?? "That bill could not be updated.");
        return;
      }
      invalidate();
      resetBillForm();
    },
    onError: (e) => setBillError(String(e)),
  });
  const deleteBill = useMutation({
    // Build v121 (F3): an immediate delete carries the epoch
    // of the data on screen.
    mutationFn: (id: number) => api.deleteMonthlyBill({ id, baseEpoch: data?.restoreEpoch ?? 0 }),
    onSuccess: (r) => {
      if (!r.ok) setActionMsg(r.reason ?? "That bill could not be deleted.");
      invalidate();
    },
  });
  const setBillAmount = useMutation({
    mutationFn: (input: ApiRequest<typeof api, "setMonthlyBillAmount">) =>
      api.setMonthlyBillAmount(input),
    onSuccess: (r) => {
      if (!r.ok) {
        // CAS refusal (build v65, F16): show why instead of
        // resetting the form over the newer stored amount.
        setBillError(r.reason ?? "That bill amount could not be saved.");
        return;
      }
      invalidate();
      resetBillForm();
    },
    onError: (e) => setBillError(String(e)),
  });
  const setBillAmountFromRow = useMutation({
    // The roster row's in-place amount editor: the same
    // setMonthlyBillAmount action the Edit form uses, but its own
    // mutation, so a row save (or a CAS refusal) never touches the
    // bill form's state — the row editor reports the outcome
    // itself, via saveBillAmountFromRow below.
    mutationFn: (input: ApiRequest<typeof api, "setMonthlyBillAmount">) =>
      api.setMonthlyBillAmount(input),
    onSuccess: (r) => {
      if (r.ok) invalidate();
    },
  });
  const addOneOff = useMutation({
    mutationFn: (input: ApiRequest<typeof api, "addMonthlyOneOff">) =>
      api.addMonthlyOneOff(input),
    onSuccess: () => {
      invalidate();
      resetOneOffForm();
    },
    onError: (e) => setOneOffError(String(e)),
  });
  const updateOneOff = useMutation({
    mutationFn: (input: ApiRequest<typeof api, "updateMonthlyOneOff">) =>
      api.updateMonthlyOneOff(input),
    onSuccess: (r) => {
      if (!r.ok) {
        // Result-honesty (build v67, F04): a refused edit keeps
        // the editor open with the edit intact and shows why —
        // the same guard its four sibling editors carry.
        setOneOffError(r.reason ?? "That one-off could not be updated.");
        return;
      }
      invalidate();
      resetOneOffForm();
    },
    onError: (e) => setOneOffError(String(e)),
  });
  const deleteOneOff = useMutation({
    // Build v121 (F3): an immediate delete carries the epoch
    // of the data on screen.
    mutationFn: (id: number) => api.deleteMonthlyOneOff({ id, baseEpoch: data?.restoreEpoch ?? 0 }),
    onSuccess: (r) => {
      if (!r.ok) setActionMsg(r.reason ?? "That one-off could not be deleted.");
      invalidate();
    },
  });
  const setDueMonth = useMutation({
    // Build v121 (F3): an immediate setter carries the epoch
    // of the data on screen.
    mutationFn: (input: ApiRequest<typeof api, "setYearlyDueMonth">) =>
      api.setYearlyDueMonth({ ...input, baseEpoch: data?.restoreEpoch ?? 0 }),
    onSuccess: (r) => {
      if (!r.ok) setActionMsg(r.reason ?? "That due month could not be saved.");
      invalidate();
    },
  });
  const setMonthlyCategory = useMutation({
    // Build v121 (F3): an immediate setter carries the epoch
    // of the data on screen.
    mutationFn: (input: ApiRequest<typeof api, "setMonthlyBillCategory">) =>
      api.setMonthlyBillCategory({ ...input, baseEpoch: data?.restoreEpoch ?? 0 }),
    onSuccess: (r) => {
      if (!r.ok) setActionMsg(r.reason ?? "That category could not be saved.");
      invalidate();
    },
  });
  const setYearlyCategory = useMutation({
    // Build v121 (F3): an immediate setter carries the epoch
    // of the data on screen.
    mutationFn: (input: ApiRequest<typeof api, "setYearlyCategory">) =>
      api.setYearlyCategory({ ...input, baseEpoch: data?.restoreEpoch ?? 0 }),
    onSuccess: (r) => {
      if (!r.ok) setActionMsg(r.reason ?? "That category could not be saved.");
      invalidate();
    },
  });
  const setMonthlyKeepLightsOn = useMutation({
    // Build v121 (F3): an immediate setter carries the epoch
    // of the data on screen.
    mutationFn: (input: ApiRequest<typeof api, "setMonthlyBillKeepLightsOn">) =>
      api.setMonthlyBillKeepLightsOn({ ...input, baseEpoch: data?.restoreEpoch ?? 0 }),
    onSuccess: (r) => {
      if (!r.ok) setActionMsg(r.reason ?? "That flag could not be saved.");
      invalidate();
    },
  });
  const setMonthlyBillsCollapsedAll = useMutation({
    // Build v130 (round-19 finding 10): carries the epoch of the
    // data on screen.
    mutationFn: (input: ApiRequest<typeof api, "setMonthlyBillsCollapsedAll">) =>
      api.setMonthlyBillsCollapsedAll({ ...input, baseEpoch: data?.restoreEpoch ?? 0 }),
    onSuccess: (r) => {
      if (!r.ok) {
        setActionMsg(r.reason ?? "That setting could not be saved.");
        setMonthlyBillsCollapsedAllOverride(null);
      }
      invalidate();
    },
  });
  const setYearlyBillsCollapsedAll = useMutation({
    // Build v130 (round-19 finding 10): carries the epoch of the
    // data on screen.
    mutationFn: (input: ApiRequest<typeof api, "setYearlyBillsCollapsedAll">) =>
      api.setYearlyBillsCollapsedAll({ ...input, baseEpoch: data?.restoreEpoch ?? 0 }),
    onSuccess: (r) => {
      if (!r.ok) {
        setActionMsg(r.reason ?? "That setting could not be saved.");
        setYearlyBillsCollapsedAllOverride(null);
      }
      invalidate();
    },
  });
  const setByCategoryCollapsedAll = useMutation({
    // Build v130 (round-19 finding 10): carries the epoch of the
    // data on screen.
    mutationFn: (input: ApiRequest<typeof api, "setByCategoryCollapsedAll">) =>
      api.setByCategoryCollapsedAll({ ...input, baseEpoch: data?.restoreEpoch ?? 0 }),
    onSuccess: (r) => {
      if (!r.ok) {
        setActionMsg(r.reason ?? "That setting could not be saved.");
        setByCategoryCollapsedAllOverride(null);
      }
      invalidate();
    },
  });
  const setYearInSpendingCollapsedAll = useMutation({
    // Build v130 (round-19 finding 10): carries the epoch of the
    // data on screen.
    mutationFn: (input: ApiRequest<typeof api, "setYearInSpendingCollapsedAll">) =>
      api.setYearInSpendingCollapsedAll({ ...input, baseEpoch: data?.restoreEpoch ?? 0 }),
    onSuccess: (r) => {
      if (!r.ok) {
        setActionMsg(r.reason ?? "That setting could not be saved.");
        setYearInSpendingCollapsedAllOverride(null);
      }
      invalidate();
    },
  });

  // Optimistic flips (build v132): each section re-renders from
  // local state at once; the mutation persists the choice in the
  // background and its refetch then agrees with what is already
  // shown.
  const handleMonthlyBillsCollapsedAllChange = (collapsed: boolean) => {
    setMonthlyBillsCollapsedAllOverride(collapsed);
    setMonthlyBillsCollapsedAll.mutate({ collapsed });
    // The new all-rows default supersedes any per-row tap override.
    setExpandedBillId(null);
    setCollapsedBillId(null);
  };

  /* Whether one Monthly bill row shows its in-place edit
     controls: the Expand all / Collapse all flag is the default,
     and the two per-row overrides record the row tapped against
     that default. */
  function billRowOpen(b: Bill): boolean {
    return monthlyBillsCollapsedAll
      ? expandedBillId === b.id
      : collapsedBillId !== b.id;
  }

  /* Tap a Monthly bill row: open it in place into its edit
     controls (amount, category, Keep the lights on), or close it
     again. In expand-all mode every row is open, so tapping
     closes just that one. */
  function toggleBillRow(b: Bill) {
    if (monthlyBillsCollapsedAll) {
      setExpandedBillId(expandedBillId === b.id ? null : b.id);
    } else {
      setCollapsedBillId(collapsedBillId === b.id ? null : b.id);
    }
  }

  /* The row editor's amount save: the shared setMonthlyBillAmount
     action carrying the restore epoch of the data on screen. The
     result — including a CAS refusal's reason — goes back to the
     editor, which shows it in place. */
  async function saveBillAmountFromRow(input: {
    billId: number;
    amountCents: number;
    effectiveFrom: string;
    base: { amountCents: number | null };
  }): Promise<{ ok: boolean; reason?: string }> {
    try {
      const r = await setBillAmountFromRow.mutateAsync({
        ...input,
        baseEpoch: data?.restoreEpoch ?? 0,
      });
      return r.ok ? { ok: true } : { ok: false, reason: r.reason ?? undefined };
    } catch (e) {
      return { ok: false, reason: String(e) };
    }
  }
  const handleYearlyBillsCollapsedAllChange = (collapsed: boolean) => {
    setYearlyBillsCollapsedAllOverride(collapsed);
    setYearlyBillsCollapsedAll.mutate({ collapsed });
  };
  const handleByCategoryCollapsedAllChange = (collapsed: boolean) => {
    setByCategoryCollapsedAllOverride(collapsed);
    setByCategoryCollapsedAll.mutate({ collapsed });
  };
  const handleYearInSpendingCollapsedAllChange = (collapsed: boolean) => {
    setYearInSpendingCollapsedAllOverride(collapsed);
    setYearInSpendingCollapsedAll.mutate({ collapsed });
  };
  const setYearlyKeepLightsOn = useMutation({
    // Build v121 (F3): an immediate setter carries the epoch
    // of the data on screen.
    mutationFn: (input: ApiRequest<typeof api, "setYearlyKeepLightsOn">) =>
      api.setYearlyKeepLightsOn({ ...input, baseEpoch: data?.restoreEpoch ?? 0 }),
    onSuccess: (r) => {
      if (!r.ok) setActionMsg(r.reason ?? "That flag could not be saved.");
      invalidate();
    },
  });
  const seed = useMutation({
    mutationFn: () => api.seedExamples({}),
    onSuccess: (r) => {
      invalidate();
      setActionMsg(r.reason);
    },
  });
  function resetTxnForm() {
    setShowTxnForm(false);
    setEditingTxnId(null);
    setEditingTxnBase(null);
    setEditingTxnEpoch(null);
    setTDesc("");
    setTDollars("");
    setTRefund(false);
    setTKind("spending");
    setTCategory("Other");
    setTYearlyId("");
    setFormError("");
  }

  function openNewTxn(prefill?: Partial<{ desc: string; yearlyId: number; source: "checking" | "card"; account: string; category: string }>) {
    resetTxnForm();
    setShowTxnForm(true);
    const today = todayStr();
    setTDate(today.slice(0, 7) === month ? today : `${month}-01`);
    if (prefill?.desc) setTDesc(prefill.desc);
    if (prefill?.yearlyId) setTYearlyId(String(prefill.yearlyId));
    if (prefill?.source) setTSource(prefill.source);
    if (prefill?.account) setTAccount(prefill.account);
    if (prefill?.category) setTCategory(prefill.category);
  }

  function openEditTxn(t: Txn) {
    setEditingTxnId(t.id);
    // Build v65 (F13): the row as loaded — the CAS base the
    // save carries back so a stale form can't overwrite a newer
    // stored value.
    setEditingTxnBase({
      date: t.date,
      description: t.description,
      amountCents: t.amountCents,
      sourceType: t.sourceType === "card" ? "card" : "checking",
      accountName: t.accountName,
      kind:
        t.kind === "card_payment" || t.kind === "transfer"
          ? t.kind
          : "spending",
      category: t.category,
      yearlyExpenseId: t.yearlyExpenseId ?? null,
    });
    // Build v121 (F3): freeze the restore epoch with the base
    // — a restore since this load refuses the save even when the
    // stored row still equals the base.
    setEditingTxnEpoch(data?.restoreEpoch ?? 0);
    setShowTxnForm(true);
    setTDate(t.date);
    setTDesc(t.description);
    setTDollars(String(Math.abs(t.amountCents) / 100));
    setTRefund(t.amountCents < 0);
    setTSource(t.sourceType === "card" ? "card" : "checking");
    setTAccount(t.accountName);
    setTKind(
      t.kind === "card_payment" || t.kind === "transfer" ? t.kind : "spending",
    );
    setTCategory(t.category);
    setTYearlyId(t.yearlyExpenseId ? String(t.yearlyExpenseId) : "");
    setFormError("");
  }

  function submitTxn(e: FormEvent) {
    e.preventDefault();
    const cents = parseDollars(tDollars);
    if (cents == null || cents === 0) {
      setFormError("Enter an amount, e.g. 42.50");
      return;
    }
    if (!tDesc.trim()) {
      setFormError("Give it a short description.");
      return;
    }
    const amountCents = tKind === "spending" && tRefund ? -Math.abs(cents) : Math.abs(cents);
    const input: TxnInput = {
      date: tDate,
      description: tDesc.trim(),
      amountCents,
      sourceType: tKind === "spending" ? tSource : "checking",
      accountName:
        tKind === "spending" ? tAccount.trim() || "Checking" : "Checking",
      kind: tKind,
      category: tCategory,
      yearlyExpenseId:
        tKind === "spending" && tYearlyId ? Number(tYearlyId) : null,
      fitId: null,
    };
    if (editingTxnId)
      updateTxn.mutate({
        ...input,
        id: editingTxnId,
        baseEpoch: editingTxnEpoch ?? 0,
        ...(editingTxnBase ? { base: editingTxnBase } : {}),
      });
    else addTxn.mutate(input);
  }

  function resetYearlyForm() {
    setShowYearlyForm(false);
    setEditingYearlyId(null);
    setEditingYearly(null);
    setEditingYearlyEpoch(null);
    setYName("");
    // New-bill entry defaults: frequency starts on Yearly, the due
    // month starts on the current month, and Paid from starts on the
    // value used last time (the server-persisted sticky default from
    // the dashboard, "Checking" on first-ever use). Amount and name
    // always start blank, and the Keep the lights on box always
    // starts unchecked. Editing an existing bill never comes through
    // here — it loads the bill's own values (see openEditYearly).
    setYFrequency("yearly");
    setYDollars("");
    setYDueMonth(String(new Date().getMonth() + 1));
    setYPaidType(
      data?.lastYearlyPaidByType === "card" ? "card" : "checking",
    );
    setYPaidName(data?.lastYearlyPaidByName ?? "Checking");
    setYCategory("Uncategorized");
    setYKeepLightsOn(false);
    setYEffectiveFrom(currentMonth());
    setYearlyError("");
  }

  function openEditYearly(y: Yearly) {
    setEditingYearlyId(y.id);
    setEditingYearly(y);
    // Build v121 (F3): freeze the restore epoch with the
    // loaded expense — a restore since this load refuses the save.
    setEditingYearlyEpoch(data?.restoreEpoch ?? 0);
    setShowYearlyForm(true);
    setYName(y.name);
    setYFrequency(
      y.latestFrequency === "bimonthly" || y.latestFrequency === "quarterly" || y.latestFrequency === "semiannual"
        ? y.latestFrequency
        : "yearly",
    );
    setYDollars(String(y.latestExpectedCents / 100));
    setYDueMonth(y.dueMonth ? String(y.dueMonth) : "");
    setYPaidType(y.paidByType === "card" ? "card" : "checking");
    setYPaidName(y.paidByName);
    setYCategory(y.category);
    setYKeepLightsOn(y.keepLightsOn);
    // Amount / frequency changes take effect from this month forward by
    // default, so earlier months keep the version that was in effect then.
    setYEffectiveFrom(currentMonth());
    setYearlyError("");
  }

  function submitYearly(e: FormEvent) {
    e.preventDefault();
    const cents = parseDollars(yDollars);
    if (!yName.trim()) {
      setYearlyError("Give the bill a name.");
      return;
    }
    if (cents == null || cents < 0) {
      setYearlyError(
        yFrequency !== "yearly"
          ? "Enter the expected amount per bill."
          : "Enter the expected yearly amount.",
      );
      return;
    }
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(yEffectiveFrom)) {
      setYearlyError("Pick the month the amount takes effect from.");
      return;
    }
    const input = {
      name: yName.trim(),
      frequency: yFrequency,
      expectedCents: cents,
      dueMonth: yDueMonth ? Number(yDueMonth) : null,
      paidByType: yPaidType,
      paidByName: yPaidName.trim() || "Checking",
      category: yCategory.trim() || "Uncategorized",
      keepLightsOn: yKeepLightsOn,
      effectiveFrom: yEffectiveFrom,
    };
    if (editingYearlyId) {
      // Build v65 (F17): carry the loaded expense as the CAS
      // base — parent fields plus the version stored for the
      // chosen effective month (null when that month has none).
      const freqOf = (
        f: string,
      ): "yearly" | "bimonthly" | "quarterly" | "semiannual" =>
        f === "bimonthly" || f === "quarterly" || f === "semiannual"
          ? f
          : "yearly";
      const base = editingYearly
        ? {
            name: editingYearly.name,
            dueMonth: editingYearly.dueMonth ?? null,
            paidByType: (editingYearly.paidByType === "card"
              ? "card"
              : "checking") as "checking" | "card",
            paidByName: editingYearly.paidByName,
            category: editingYearly.category,
            keepLightsOn: editingYearly.keepLightsOn,
            version: (() => {
              const v = editingYearly.history.find(
                (h) => h.effectiveFrom === yEffectiveFrom,
              );
              return v
                ? { expectedCents: v.expectedCents, frequency: freqOf(v.frequency) }
                : null;
            })(),
          }
        : undefined;
      updateYearly.mutate({
        ...input,
        id: editingYearlyId,
        baseEpoch: editingYearlyEpoch ?? 0,
        ...(base ? { base } : {}),
      });
    } else addYearly.mutate(input);
  }

  function openSummaryForm(forMonth: string, existingCents?: number) {
    setSMonth(forMonth);
    setSDollars(existingCents != null ? String(existingCents / 100) : "");
    setSummaryBase({ month: forMonth, cashOutCents: existingCents ?? null });
    // Build v121 (F3): freeze the restore epoch with the base
    // — a restore since this load refuses the save even when the
    // stored total still equals the base.
    setSummaryEpoch(data?.restoreEpoch ?? 0);
    setSummaryError("");
    setShowSummaryForm(true);
  }

  function submitSummary(e: FormEvent) {
    e.preventDefault();
    const cents = parseDollars(sDollars);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(sMonth)) {
      setSummaryError("Pick a month.");
      return;
    }
    if (cents == null || cents < 0) {
      setSummaryError("Enter the month's total cash out, e.g. 3850.00");
      return;
    }
    // Build v65 (F15): the base is the stored total for the
    // month being saved as loaded — the value captured when the
    // form opened for that month, or, if the month was changed
    // in the form, the loaded dashboard's stored total for the
    // new month (null when none is stored).
    const baseCents =
      summaryBase && summaryBase.month === sMonth
        ? summaryBase.cashOutCents
        : (data?.summaries.find((s) => s.month === sMonth)?.cashOutCents ??
          null);
    upsertSummary.mutate({
      month: sMonth,
      cashOutCents: cents,
      base: { cashOutCents: baseCents },
      baseEpoch: summaryEpoch ?? 0,
    });
  }

  function resetItemForm() {
    setShowItemForm(false);
    setEditingItemId(null);
    setEditingItemBase(null);
    setEditingItemEpoch(null);
    setIDate(`${currentMonth()}-01`);
    setIDesc("");
    setIDollars("");
    setINote("");
    setItemError("");
  }

  function openNewItem(forMonth: string) {
    resetItemForm();
    setIDate(`${forMonth}-01`);
    setShowItemForm(true);
    setCashOutMonthExpanded(forMonth, true);
  }

  function openEditItem(it: CashOutItem) {
    setEditingItemId(it.id);
    setEditingItemBase({
      month: it.month,
      description: it.description,
      amountCents: it.amountCents,
      note: it.note ?? null,
      day: it.day,
    });
    // Build v121 (F3): freeze the restore epoch with the base.
    setEditingItemEpoch(data?.restoreEpoch ?? 0);
    setShowItemForm(true);
    setIDate(`${it.month}-${String(it.day).padStart(2, "0")}`);
    setIDesc(it.description);
    setIDollars(String(it.amountCents / 100));
    setINote(it.note ?? "");
    setItemError("");
    setCashOutMonthExpanded(it.month, true);
  }

  function submitItem(e: FormEvent) {
    e.preventDefault();
    const cents = parseDollars(iDollars);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iDate)) {
      setItemError("Pick the date the cash went out.");
      return;
    }
    const itemMonth = iDate.slice(0, 7);
    const dayNum = Number(iDate.slice(8, 10));
    const maxDay = daysInMonthOf(itemMonth);
    if (
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(itemMonth) ||
      !Number.isInteger(dayNum) ||
      dayNum < 1 ||
      dayNum > maxDay
    ) {
      setItemError("Pick a valid date the cash went out.");
      return;
    }
    if (!iDesc.trim()) {
      setItemError("Give the item a short description, e.g. Groceries.");
      return;
    }
    if (cents == null || cents < 0) {
      setItemError("Enter the item's amount, e.g. 250.50");
      return;
    }
    const input = {
      month: itemMonth,
      day: dayNum,
      description: iDesc.trim(),
      amountCents: cents,
      note: iNote.trim() ? iNote.trim() : null,
    };
    if (editingItemId)
      updateCashOutItem.mutate({
        ...input,
        id: editingItemId,
        baseEpoch: editingItemEpoch ?? 0,
        ...(editingItemBase ? { base: editingItemBase } : {}),
      });
    else addCashOutItem.mutate(input);
  }

  function toggleCashOutMonth(m: string) {
    setCashOutMonthExpanded(m, !cashOutMonthExpanded(m));
  }

  function resetBillForm() {
    setShowBillForm(false);
    setEditingBillId(null);
    setEditingBill(null);
    setEditingBillEpoch(null);
    setBName("");
    setBDollars("");
    setBEffectiveFrom(currentMonth());
    // New-bill entry default: Paid from starts on the value used
    // last time (the server-persisted sticky default from the
    // dashboard, "Credit Card" on first-ever use). Amount and name
    // always start blank, and the Keep the lights on box always
    // starts unchecked. Editing an existing bill never comes through
    // here — it loads the bill's own value (see openEditBill).
    setBPaidBy(data?.lastMonthlyPaidFrom ?? "Credit Card");
    setBNotes("");
    setBCategory("Uncategorized");
    setBKeepLightsOn(false);
    setBillError("");
  }

  function openEditBill(b: Bill) {
    setEditingBillId(b.id);
    setEditingBill(b);
    // Build v121 (F3): freeze the restore epoch with the
    // loaded bill — both chained saves carry it.
    setEditingBillEpoch(data?.restoreEpoch ?? 0);
    setShowBillForm(true);
    setBName(b.name);
    setBDollars(String(b.latestAmountCents / 100));
    // Amount changes take effect from this month forward by default, so
    // earlier months keep the amount that was in effect then.
    setBEffectiveFrom(currentMonth());
    setBPaidBy(b.paidBy);
    setBNotes(b.notes ?? "");
    setBCategory(b.category);
    setBKeepLightsOn(b.keepLightsOn);
    setBillError("");
  }

  function submitBill(e: FormEvent) {
    e.preventDefault();
    const cents = parseDollars(bDollars);
    if (!bName.trim()) {
      setBillError("Give the bill a name.");
      return;
    }
    if (cents == null || cents < 0) {
      setBillError("Enter the monthly amount.");
      return;
    }
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(bEffectiveFrom)) {
      setBillError("Pick the month the amount takes effect from.");
      return;
    }
    const notes = bNotes.trim() ? bNotes.trim() : null;
    const paidBy = bPaidBy.trim() || "Checking";
    if (editingBillId) {
      // Build v65 (F18/F16): both saves carry their loaded
      // bases, and the amount save chains ONLY when the metadata
      // save actually landed (a CAS refusal stops the chain).
      const billBase = editingBill
        ? {
            name: editingBill.name,
            paidBy: editingBill.paidBy,
            notes: editingBill.notes ?? null,
            category: editingBill.category,
            keepLightsOn: editingBill.keepLightsOn,
          }
        : undefined;
      const amountBase = editingBill
        ? {
            amountCents:
              editingBill.history.find(
                (h) => h.effectiveFrom === bEffectiveFrom,
              )?.amountCents ?? null,
          }
        : undefined;
      updateBill.mutate(
        { id: editingBillId, name: bName.trim(), paidBy, notes, category: bCategory.trim() || "Uncategorized", keepLightsOn: bKeepLightsOn, baseEpoch: editingBillEpoch ?? 0, ...(billBase ? { base: billBase } : {}) },
        {
          onSuccess: (r) => {
            if (!r.ok) return;
            setBillAmount.mutate({
              billId: editingBillId,
              amountCents: cents,
              effectiveFrom: bEffectiveFrom,
              baseEpoch: editingBillEpoch ?? 0,
              ...(amountBase ? { base: amountBase } : {}),
            });
          },
        },
      );
    } else {
      addBill.mutate({
        name: bName.trim(),
        amountCents: cents,
        effectiveFrom: bEffectiveFrom,
        paidBy,
        notes,
        category: bCategory.trim() || "Uncategorized",
        keepLightsOn: bKeepLightsOn,
      });
    }
  }

  function resetOneOffForm() {
    setShowOneOffForm(false);
    setEditingOneOffId(null);
    setEditingOneOffEpoch(null);
    setODesc("");
    setODollars("");
    setONote("");
    setOneOffError("");
  }

  function openNewOneOff() {
    resetOneOffForm();
    setOMonth(month);
    setShowOneOffForm(true);
  }

  function openEditOneOff(o: OneOff) {
    setEditingOneOffId(o.id);
    // Build v121 (F3): freeze the restore epoch at open.
    setEditingOneOffEpoch(data?.restoreEpoch ?? 0);
    setShowOneOffForm(true);
    setOMonth(o.month);
    setODesc(o.description);
    setODollars(String(o.amountCents / 100));
    setONote(o.note ?? "");
    setOneOffError("");
  }

  function submitOneOff(e: FormEvent) {
    e.preventDefault();
    const cents = parseDollars(oDollars);
    if (!oDesc.trim()) {
      setOneOffError("Give the one-off a short description, e.g. Car repair.");
      return;
    }
    if (cents == null || cents < 0) {
      setOneOffError("Enter the amount that was part of this month's spending.");
      return;
    }
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(oMonth)) {
      setOneOffError("Pick the month it belongs to.");
      return;
    }
    const input = {
      month: oMonth,
      description: oDesc.trim(),
      amountCents: cents,
      note: oNote.trim() ? oNote.trim() : null,
    };
    if (editingOneOffId) updateOneOff.mutate({ ...input, id: editingOneOffId, baseEpoch: editingOneOffEpoch ?? 0 });
    else addOneOff.mutate(input);
  }

  const divergenceBig =
    data != null &&
    data.trailingMonthsCovered >= 3 &&
    Math.abs(data.divergencePct) >= 0.05 &&
    Math.abs(data.divergenceCents) >= 2500;
  // The smoothed-vs-actual check is only a real warning once a full year
  // is covered: before that, yearly bills already paid sit in the actual
  // average while bills not yet due do not, so a gap is expected.
  const showDivergence = divergenceBig && data.trailingMonthsCovered >= 12;
  const showProvisional = divergenceBig && data.trailingMonthsCovered < 12;

  /* ---- Quick view averages line (Month mode) ----
     One quiet line inside the "True cost vs Cash out" chart
     card, under its subheading, reading the dashboard's OWN
     averages: True cost is avgSmoothedCents and Cash out is
     avgCashOutCents, both averaged by getDashboard over the
     trailing window trailingMonthsCovered names (up to 12
     months ending at the current calendar month, from the first
     month with data). The window label is read off the
     server-published trailingMonths — the exact months averaged
     — so it names the window itself, never a span reconstructed
     from the viewed month (before build v123 it was rebuilt
     ending at the viewed month and named the wrong months
     whenever the viewed month was after the current month,
     the same stale assumption as the old chart slice). Hidden
     when fewer than 2 months are covered — an average of one
     month is just the month. (It rendered as a standalone
     highlighted banner between the tiles and the chart card
     until 2026-10-25, when it was judged the right numbers in
     the wrong place and it moved into the card, un-highlighted,
     with its wording and figures unchanged.) */
  const showAvgStrip = data != null && data.trailingMonthsCovered >= 2;
  const avgWindowLabel = (() => {
    if (data == null || data.trailingMonthsCovered < 1) return "";
    const first = data.trailingMonths[0];
    const last = data.trailingMonths[data.trailingMonths.length - 1];
    if (first == null || last == null) return "";
    const covered = data.trailingMonthsCovered;
    const start = first.month;
    const end = last.month;
    const startShort = MONTH_SHORT[Number(start.slice(5, 7)) - 1] ?? "";
    const endShort = MONTH_SHORT[Number(end.slice(5, 7)) - 1] ?? "";
    if (covered >= 12) {
      return `Last 12 months · ${startShort} ${start.slice(0, 4)}–${endShort} ${end.slice(0, 4)}`;
    }
    if (start.slice(0, 4) === end.slice(0, 4)) {
      return `${startShort}–${endShort} ${end.slice(0, 4)} · ${covered} months`;
    }
    return `${startShort} ${start.slice(0, 4)}–${endShort} ${end.slice(0, 4)} · ${covered} months`;
  })();

  /* ---- Year view (Quick view) derived display helpers ---- */
  const inYearMode = quickMode === "year";
  const yv = yearView.data;
  const tileValueCls =
    "display tnum mt-1.5 text-xl leading-none font-semibold whitespace-nowrap text-[var(--text)]";
  /* One month's six Quick view tiles — the exact tiles Month mode
     shows, reused for every month panel in Year mode. `idPrefix`
     keeps tooltip ids/keys unique per panel; `withNav` adds the
     Month-mode extras (YTD sub-lines and whole-tile details
     targets), which the year panels omit to stay clean. */
  function renderMonthTiles(opts: {
    idPrefix: string;
    periodCaption: string;
    trueCostCents: number;
    cashOutCents: number;
    totalMonthlyCents: number;
    everythingElseCents: number;
    keepLightsOnCents: number;
    yearlyPaidOutCents: number;
    oneOffsTotalCents: number;
    oneOffsCount: number;
    withNav: boolean;
    ytd?: Dash["ytd"];
  }) {
    const key = (name: string) => `${opts.idPrefix}-${name}`;
    /* In Month mode (withNav) every tile's figure taps through to
       its section, so the figure carries the app's dotted-underline
       tap cue — the same style the other provenance taps use — so
       it reads as tappable. Year-mode panels have no tap target and
       keep the plain figure. */
    const navValueCls = opts.withNav
      ? `${tileValueCls} underline decoration-dotted underline-offset-4 group-hover:text-[var(--accent)]`
      : tileValueCls;
    return (
      <>
        {/* Single merged panel (2026-11-09): all four tiles in
            one card, with no inner sub-headings — the earlier
            two-panel split (a period panel captioned by the
            caller and a separate "Standing rates" panel holding
            the lone "Keep the lights on" tile) wasted space.
            Inside the card the stats are borderless cells
            divided by hairlines, stretching to fill the card's
            full width — four in one row on desktop and a 2x2
            grid on phone width, so no cell is stranded, no tile
            spans the full width, and no slot is left dead. The
            cells themselves are unchanged — same figures, YTD
            lines, tips, and order.
            (The "Yearly & periodic expenses" and "Total monthly"
            tiles were removed 2026-11-09: both figures still show
            in their sections below — the smoothed spend breakdown
            and the Monthly bills header.) */}
        <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
          <div className="grid grid-cols-2 sm:grid-cols-4">
            <QuickTile
              className="border-r border-b border-[var(--border)] sm:border-b-0"
              label="True cost"
              tipId={`qtip-${key("true-cost")}`}
              tip="Real monthly cost — yearly & periodic bills spread evenly. What the month really cost. The month's base (the entered total, the itemized total, or the spending recorded that month), minus any yearly/periodic lump sums that base includes, plus the monthly set-aside for yearly & periodic bills — so big yearly bills are spread evenly instead of spiking one month."
              panelCls="left-1/2 -translate-x-1/2"
              open={openTip === key("true-cost")}
              onToggle={() =>
                setOpenTip(openTip === key("true-cost") ? null : key("true-cost"))
              }
              onClose={() => setOpenTip(null)}
              onDetails={opts.withNav ? () => scrollToSection("section-true-cost") : undefined}
            >
              <p className={navValueCls}>{fmt(opts.trueCostCents)}</p>
              {opts.withNav && opts.ytd && opts.ytd.trueCostCents !== opts.trueCostCents && (
                <p className="tnum mt-1.5 text-xs whitespace-nowrap text-[var(--dim)]">
                  YTD {fmt(opts.ytd.trueCostCents)}
                </p>
              )}
            </QuickTile>
            <QuickTile
              className="border-b border-[var(--border)] sm:border-r sm:border-b-0"
              label="Cash out"
              tipId={`qtip-${key("cash-out")}`}
              tip="Money that actually went out this month — all the money that actually left this month. If the month is itemized, that's the items added up; otherwise if you entered a monthly total, that's the number; otherwise it's the month's checking transactions added up. Paying off a credit card isn't counted twice. A charge paid by credit card lands here in the month the card payment leaves the bank, which can be the month after the charge."
              panelCls="right-0"
              open={openTip === key("cash-out")}
              onToggle={() =>
                setOpenTip(openTip === key("cash-out") ? null : key("cash-out"))
              }
              onClose={() => setOpenTip(null)}
              onDetails={opts.withNav ? () => scrollToSection("section-cash-out") : undefined}
            >
              <p className={navValueCls}>{fmt(opts.cashOutCents)}</p>
              {opts.withNav && opts.ytd && opts.ytd.cashOutCents !== opts.cashOutCents && (
                <p className="tnum mt-1.5 text-xs whitespace-nowrap text-[var(--dim)]">
                  YTD {fmt(opts.ytd.cashOutCents)}
                </p>
              )}
            </QuickTile>
            <QuickTile
              className="border-r border-[var(--border)]"
              label="Everything else"
              tipId={`qtip-${key("everything-else")}`}
              tip="Cash out − monthly bills − yearly & periodic bills paid this month. Cash out minus Total monthly (the monthly bills) minus the yearly & periodic bills paid this month. What's left is everything that isn't a bill — day-to-day spending like groceries, eating out, and shopping, plus anything else that left the account, such as transfers or card payments. It can be negative: negative for now means this month's recorded cash out is still below its bills and yearly payments — it can be negative mid-month, when the recorded cash out so far is still below the month's bills and yearly payments."
              panelCls="left-1/2 -translate-x-1/2 sm:left-auto sm:right-0 sm:translate-x-0"
              open={openTip === key("everything-else")}
              onToggle={() =>
                setOpenTip(
                  openTip === key("everything-else") ? null : key("everything-else"),
                )
              }
              onClose={() => setOpenTip(null)}
              onDetails={opts.withNav ? () => openExplorer("month") : undefined}
            >
              <p className={navValueCls}>{fmt(opts.everythingElseCents)}</p>
              {opts.withNav && opts.ytd && opts.ytd.everythingElseCents !== opts.everythingElseCents && (
                <p className="tnum mt-1.5 text-xs whitespace-nowrap text-[var(--dim)]">
                  YTD {fmt(opts.ytd.everythingElseCents)}
                </p>
              )}
              {opts.oneOffsTotalCents > 0 && (
                <p className="tnum mt-1.5 text-xs whitespace-nowrap text-[var(--dim)]">
                  {opts.oneOffsCount === 1
                    ? `incl. ${fmt(opts.oneOffsTotalCents)} one-off`
                    : `incl. ${fmt(opts.oneOffsTotalCents)} one-offs (${opts.oneOffsCount})`}
                </p>
              )}
            </QuickTile>
            <QuickTile
              label="Keep the lights on"
              tipId={`qtip-${key("lights-on")}`}
              tip="Bare-minimum bills to keep things running. The bills you checked as essential: checked monthly bills plus the set-asides of checked yearly/periodic bills. The must-pay floor for the month."
              panelCls="right-0"
              open={openTip === key("lights-on")}
              onToggle={() =>
                setOpenTip(openTip === key("lights-on") ? null : key("lights-on"))
              }
              onClose={() => setOpenTip(null)}
              onDetails={opts.withNav ? () => scrollToSection("section-keep-lights-on") : undefined}
            >
              <p className={navValueCls}>{fmt(opts.keepLightsOnCents)}</p>
              {opts.withNav && opts.ytd && opts.ytd.keepLightsOnCents !== opts.keepLightsOnCents && (
                <p className="tnum mt-1.5 text-xs whitespace-nowrap text-[var(--dim)]">
                  YTD {fmt(opts.ytd.keepLightsOnCents)}
                </p>
              )}
            </QuickTile>
          </div>
        </div>
      </>
    );
  }

  /* GitHub repo link for the top bar: the official octocat mark as a
     quiet icon button matching the view switcher's border, surface,
     and height, so it reads as part of the bar rather than an ad.
     Icon-only (the accessible name and tooltip carry the words),
     opening the repo in a new tab. The URL is the project's repo,
     the same one the README badges link to. */
  const githubLink = (
    <a
      href="https://github.com/vkreal/finance-planner"
      target="_blank"
      rel="noreferrer"
      aria-label="Finance Planner on GitHub (opens in a new tab)"
      title="View the source on GitHub"
      className="inline-flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] focus-visible:border-[var(--accent)] focus-visible:text-[var(--accent)]"
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 16 16"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
      </svg>
    </a>
  );

  const topSwitch = (
    <div
      role="group"
      aria-label="View"
      className="flex flex-wrap justify-center overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]"
    >
      <button
        type="button"
        aria-label="Spending view"
        aria-pressed={topView === "spending"}
        onClick={() => setTopView("spending")}
        className={`px-4 py-2 text-sm font-medium ${topView === "spending" ? "bg-[var(--accent)] text-white" : "text-[var(--text)] hover:text-[var(--accent)]"}`}
      >
        Spending
      </button>
      <button
        type="button"
        aria-label="Net Worth view"
        aria-pressed={topView === "networth"}
        onClick={() => setTopView("networth")}
        className={`px-4 py-2 text-sm font-medium ${topView === "networth" ? "bg-[var(--accent)] text-white" : "text-[var(--text)] hover:text-[var(--accent)]"}`}
      >
        Net Worth
      </button>
      <button
        type="button"
        aria-label="Retirement view"
        aria-pressed={topView === "retirement"}
        onClick={() => setTopView("retirement")}
        className={`px-4 py-2 text-sm font-medium ${topView === "retirement" ? "bg-[var(--accent)] text-white" : "text-[var(--text)] hover:text-[var(--accent)]"}`}
      >
        Retirement
      </button>
      <button
        type="button"
        aria-label="Tax Plan view"
        aria-pressed={topView === "roth"}
        onClick={() => setTopView("roth")}
        className={`px-4 py-2 text-sm font-medium ${topView === "roth" ? "bg-[var(--accent)] text-white" : "text-[var(--text)] hover:text-[var(--accent)]"}`}
      >
        Tax Plan
      </button>
      <button
        type="button"
        aria-label="Playground view"
        aria-pressed={topView === "playground"}
        onClick={() => setTopView("playground")}
        className={`px-4 py-2 text-sm font-medium ${topView === "playground" ? "bg-[var(--accent)] text-white" : "text-[var(--text)] hover:text-[var(--accent)]"}`}
      >
        Playground
      </button>
    </div>
  );

  /* The top bar shared by every view: the view switcher centered,
     with the GitHub icon button at the right end of the same row.
     The spacer on the left mirrors the icon's footprint so the
     switcher stays optically centered on wide screens; on narrow
     screens the row wraps and the icon sits beside the switcher. */
  const topBar = (
    <div className="flex flex-wrap items-center justify-center gap-2 pt-4">
      <span aria-hidden="true" className="hidden w-[38px] shrink-0 sm:block" />
      {topSwitch}
      {githubLink}
    </div>
  );

  if (topView === "networth") {
    return (
      <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
        <SafeAreaTopScrim backgroundColor="var(--bg)" />
        <main className="mx-auto w-full max-w-5xl px-4 pb-16">
          {topBar}
          <NetWorthView />
        </main>
      </div>
    );
  }

  if (topView === "retirement") {
    return (
      <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
        <SafeAreaTopScrim backgroundColor="var(--bg)" />
        <main className="mx-auto w-full max-w-5xl px-4 pb-16">
          {topBar}
          <RetirementCalc
            onJumpToTaxPlan={(target) => {
              setRothJumpTarget(target);
              setTopView("roth");
            }}
          />
        </main>
      </div>
    );
  }

  if (topView === "roth") {
    return (
      <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
        <SafeAreaTopScrim backgroundColor="var(--bg)" />
        <main className="mx-auto w-full max-w-5xl px-4 pb-16">
          {topBar}
          <RothConversion jumpTarget={rothJumpTarget} />
        </main>
      </div>
    );
  }

  if (topView === "playground") {
    return (
      <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
        <SafeAreaTopScrim backgroundColor="var(--bg)" />
        <main className="mx-auto w-full max-w-5xl px-4 pb-16">
          {topBar}
          <Playground
            onJumpToYourMoney={() => {
              setRothJumpTarget({
                fieldId: "roth-Exclude-from-plan",
                section: "money",
                nonce: Date.now(),
              });
              setTopView("roth");
            }}
          />
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto w-full max-w-3xl px-4 pb-16">
        {topBar}
        {/* month nav — in Year mode the month picker is replaced by
            the year flipper; the viewed month itself is untouched, so
            the rest of the dashboard keeps showing it. */}
        <h2 className="display mt-5 text-3xl font-semibold">Spending</h2>
        {quickMode === "year" ? (
          <div className="flex items-center justify-between gap-2 pt-4">
            <button
              type="button"
              aria-label="Previous year"
              className={btnGhost}
              onClick={() => setViewYear(viewYear - 1)}
            >
              ←
            </button>
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className="text-base text-[var(--dim)]">‹</span>
              <select
                aria-label="Select year"
                className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-base text-[var(--text)]"
                value={viewYear}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) setViewYear(v);
                }}
              >
                {[...new Set([viewYear, ...Array.from({ length: 21 }, (_, i) => Number(currentMonth().slice(0, 4)) - 10 + i)])]
                  .sort((a, b) => a - b)
                  .map((y) => (
                    <option key={y} value={y}>{y}</option>
                  ))}
              </select>
              <span aria-hidden="true" className="text-base text-[var(--dim)]">›</span>
              {viewYear !== Number(currentMonth().slice(0, 4)) && (
                <button
                  type="button"
                  className={btnGhost}
                  onClick={() => setViewYear(Number(currentMonth().slice(0, 4)))}
                >
                  This year
                </button>
              )}
            </div>
            <button
              type="button"
              aria-label="Next year"
              className={btnGhost}
              onClick={() => setViewYear(viewYear + 1)}
            >
              →
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2 pt-4">
            <div className="flex items-center gap-2">
              <input
                type="month"
                aria-label="Select month"
                className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-base text-[var(--text)]"
                value={month}
                onChange={(e) => {
                  if (e.target.value) setMonth(e.target.value);
                }}
              />
              {month !== currentMonth() && (
                <button
                  type="button"
                  className={btnGhost}
                  onClick={() => setMonth(currentMonth())}
                >
                  This month
                </button>
              )}
            </div>
          </div>
        )}

        {dash.isPending && <p className="py-10 text-center text-[var(--dim)]">Loading…</p>}
        {dash.error && (
          <div className="py-10 text-center">
            <p className="text-[var(--bad)]">
              Something went wrong loading this month.
            </p>
            <p className="mx-auto mt-2 max-w-md text-sm break-words text-[var(--dim)]">
              {dash.error instanceof Error
                ? dash.error.message
                : String(dash.error)}
            </p>
            <button
              type="button"
              className={`${btnGhost} mt-4`}
              disabled={dash.isFetching}
              onClick={() => void dash.refetch()}
            >
              Try again
            </button>
          </div>
        )}

        {data && (
          <>
            {showExplorer && (
              <ExplorerModal
                viewedMonth={month}
                earliestMonth={data.earliest ?? data.summaries[0]?.month ?? null}
                initialGroupBy={explorerGroupBy}
                onClose={() => setShowExplorer(false)}
              />
            )}

            {/* data-integrity warnings — rendered only when a
                server-side check found a problem with the stored
                data; an empty list renders nothing at all. */}
            {data.integrityWarnings.length > 0 && (
              <div
                role="alert"
                className="mt-5 rounded-[var(--radius)] border border-[var(--bad)] bg-[var(--bad-soft)] px-3 py-2 text-sm text-[var(--text)]"
              >
                {data.integrityWarnings.map((w, i) => (
                  <p key={i} className={i > 0 ? "mt-1" : undefined}>{w}</p>
                ))}
              </div>
            )}

            {/* quick view — summary strip of equal tiles, first section */}
            <section id="quick-view" aria-label="Quick view" className="mt-5 scroll-mt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-medium tracking-wide text-[var(--dim)] uppercase">
                  Quick view — {inYearMode ? viewYear : monthLabel(month)}
                </p>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    aria-label="Slice & dice"
                    onClick={() => openExplorer("category")}
                    className="text-xs font-medium whitespace-nowrap text-[var(--dim)] underline-offset-2 hover:text-[var(--accent)] hover:underline focus-visible:text-[var(--accent)] focus-visible:underline"
                  >
                    Slice &amp; dice <span aria-hidden="true">→</span>
                  </button>
                <SpendPeriodPills
                  perMonth={!inYearMode}
                  onChange={(perMonth) => {
                    if (perMonth) {
                      setQuickMode("month");
                    } else if (!inYearMode) {
                      setViewYear(Number(month.slice(0, 4)));
                      setQuickMode("year");
                    }
                  }}
                />
                </div>
              </div>
              {inYearMode && yearView.isPending && (
                <p className="mt-1.5 text-sm text-[var(--dim)]">Loading year…</p>
              )}
              {inYearMode && yearView.error && (
                <p className="mt-1.5 text-sm text-[var(--bad)]">
                  Something went wrong loading this year.{" "}
                  <button
                    type="button"
                    className="font-medium text-[var(--accent)] underline underline-offset-2"
                    onClick={() => void yearView.refetch()}
                  >
                    Try again
                  </button>
                </p>
              )}
              {inYearMode && yv && yv.hasAnyData && (
                <p className="tnum mt-1.5 text-sm text-[var(--dim)]">
                  {yv.isCurrentYear
                    ? `${yv.year} so far — Cash out ${fmt(yv.totals.cashOutCents)} · True cost ${fmt(yv.totals.trueCostCents)}`
                    : `${yv.year} — Cash out ${fmt(yv.totals.cashOutCents)} · True cost ${fmt(yv.totals.trueCostCents)}`}
                </p>
              )}
              {!inYearMode && (
                <>
                  <div className="mt-2.5">
                    {renderMonthTiles({
                      idPrefix: "month",
                      periodCaption: "This month",
                      trueCostCents: data.smoothedCents,
                      cashOutCents: data.cashOutCents,
                      totalMonthlyCents: data.monthlyBillsTotalCents,
                      everythingElseCents:
                        data.cashOutCents -
                        data.monthlyBillsTotalCents -
                        data.yearlyPaidOutCents,
                      keepLightsOnCents: data.keepLightsOnTotalCents,
                      yearlyPaidOutCents: data.yearlyPaidOutCents,
                      oneOffsTotalCents: data.oneOffsTotalCents,
                      oneOffsCount: data.oneOffs.length,
                      withNav: true,
                      ytd: data.ytd,
                    })}
                  </div>
                  {/* True cost vs Cash out bars: the server-published
                      trailingMonths — the trailing window's own months,
                      the exact months the averages line averages — so
                      the chart and the line show the same figures (the
                      12-entry history ends at the viewed month while
                      the window ends at the current month, so slicing
                      the window off the history plotted the viewed
                      month's tail whenever the viewed month was after
                      the current month — build v123, round-18 F1).
                      An empty window (0 covered months) renders the
                      chart's empty state. The chart — and only the
                      chart — then continues past the viewed month with
                      enteredAheadMonths: later months that already
                      have entered figures, each with its own dashboard
                      figures; the line, tiles and everything else stay
                      on the viewed month. The averages line itself
                      renders inside the chart card, under its
                      subheading (see averageLine on
                      SpendingTrueCostChart). */}
                  <SpendingTrueCostChart
                    months={data.trailingMonths}
                    aheadMonths={data.enteredAheadMonths}
                    targetMonthlyCents={spendingTargetMonthlyCents}
                    averageMonthlyCents={
                      showAvgStrip ? data.avgSmoothedCents : null
                    }
                    averageLine={
                      showAvgStrip
                        ? `Average month · ${avgWindowLabel} — True cost ${fmt(data.avgSmoothedCents)} · Cash out ${fmt(data.avgCashOutCents)}`
                        : null
                    }
                  />
                </>
              )}
              {inYearMode && yv && !yv.hasAnyData && (
                <p className="mt-3 rounded-[var(--radius)] border border-dashed border-[var(--border)] p-4 text-sm text-[var(--dim)]">
                  No data recorded for {viewYear}
                </p>
              )}
              {inYearMode && yv && yv.hasAnyData && (
                <YearTrueCostChart
                  year={viewYear}
                  months={yv.months}
                  targetMonthlyCents={spendingTargetMonthlyCents}
                  onSelectMonth={(m) => {
                    setMonth(m);
                    setQuickMode("month");
                  }}
                />
              )}
              {inYearMode && yv && yv.hasAnyData && (
                <div>
                  {yv.months
                    .filter((m) => m.hasData)
                    .map((m) => (
                      <section
                        key={m.month}
                        aria-label={`Quick view for ${monthLabel(m.month)}`}
                        className={`mt-5 rounded-[var(--radius)] p-3 sm:p-4 ${
                          m.month === currentMonth()
                            ? "border border-[var(--accent)] bg-[var(--accent-soft)]"
                            : "border border-[var(--border)]"
                        }`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <h3 className="display text-lg font-semibold">
                            {monthLabel(m.month)}
                            {m.month === currentMonth() && (
                              <span className="ml-2 align-middle text-xs font-medium text-[var(--accent)]">
                                This month
                              </span>
                            )}
                            {m.estimate && (
                              <span className="ml-2 align-middle text-xs font-medium text-[var(--dim)]">
                                (est.)
                              </span>
                            )}
                          </h3>
                          <button
                            type="button"
                            aria-label={`View ${monthLabel(m.month)}`}
                            onClick={() => {
                              setMonth(m.month);
                              setQuickMode("month");
                            }}
                            className="text-sm font-medium text-[var(--accent)] underline-offset-2 hover:underline focus-visible:underline"
                          >
                            View month →
                          </button>
                        </div>
                        <div className="mt-2.5">
                          {renderMonthTiles({
                            idPrefix: m.month,
                            periodCaption: "This month",
                            trueCostCents: m.trueCostCents,
                            cashOutCents: m.cashOutCents,
                            totalMonthlyCents: m.totalMonthlyCents,
                            everythingElseCents: m.everythingElseCents,
                            keepLightsOnCents: m.keepLightsOnCents,
                            yearlyPaidOutCents: m.yearlyPaidOutCents,
                            oneOffsTotalCents: m.oneOffsTotalCents,
                            oneOffsCount: m.oneOffsCount,
                            withNav: false,
                          })}
                        </div>
                        <p className="tnum mt-3 text-sm leading-relaxed text-[var(--dim)]">
                          Cash out {fmt(m.cashOutCents)} = Total monthly{" "}
                          {fmt(m.totalMonthlyCents)} + Yearly &amp; periodic
                          expenses {fmt(m.yearlyPaidOutCents)} + Everything else{" "}
                          {fmt(m.everythingElseCents)}
                        </p>
                      </section>
                    ))}
                </div>
              )}
            </section>

            {!inYearMode && (
              <>
            {/* hero: smoothed spend + formula */}
            <section id="section-true-cost" aria-label="True cost" className={`mt-4 scroll-mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6${highlightCls("section-true-cost")}`}>
              <div className="flex items-start justify-between gap-3">
                <p className="flex items-center gap-1.5 text-sm font-medium text-[var(--dim)]">
                  <span>
                    {monthLabel(month)} — your true monthly cost
                  </span>
                  {/* The section's one explainer door: the ⓘ sits in
                      this header row beside the label it explains.
                      (It used to render as a block under the number,
                      orphaned on its own line once the definition
                      sentence that accompanied it moved into the True
                      cost tile's ⓘ.) Its tooltip text carries both
                      this explainer's original paragraph and the full
                      text of the former footer "How this math works"
                      explainer, folded in here so the method is
                      explained in exactly one place (build v67:
                      the former "More" link is the ⓘ now).
                      align="start": the button sits near the left
                      edge, so the bubble opens to the right instead
                      of clipping off the screen's left edge on a
                      phone. */}
                  <ExplainerInfoTip
                    id="spending.trueCost"
                    label="True cost"
                    align="start"
                  >
                <p>
                  Smoothed spend: yearly and periodic bills spread evenly,
                  so a month with a big bill doesn't look worse than it is.
                </p>
                <p>
                  Record each amount in the month the money{" "}
                  <strong>leaves the bank account</strong>. A bill paid
                  straight from checking is recorded in the month it leaves
                  checking. A credit-card charge is recorded with the date
                  the card payment leaves the bank — not the date of the
                  charge — so a charge made one month can be recorded the
                  next, when it's paid. That card payment counts as cash
                  out, and the charge is never counted as spending a second
                  time, so nothing is double-counted.
                </p>
                <p>
                  Transfers to savings or between your own accounts are cash
                  out, not spending. Refunds are entered as negative
                  spending, so a returned purchase nets out.
                </p>
                <p>
                  A smoothed bill is subtracted in the month its payment
                  leaves the bank account, and the set-aside — the sum of the monthly
                  amounts of the bills in effect that month, each
                  bill's annualised amount divided by 12 and rounded
                  per bill — is added back every month.
                  That's what smooths it.
                </p>
                <p>
                  Periodic bills work the same way: enter the amount per
                  bill and it's spread over its period. Water at $200
                  every other month counts as $100 a month; a garbage bill
                  at $300 every 3 months (quarterly, 4×/yr) also counts as
                  $100 a month — per bill ÷ 3 — and a $600 bill
                  every 6 months also counts as $100 a month. In the month
                  you pay one, the full payment is subtracted as a lump
                  and the monthly set-aside is added, so that month nets
                  to the monthly share; in the other months there's no
                  payment, just the set-aside.
                </p>
                <p>
                  Prefer one number a month? Enter the month's total cash
                  out instead of individual transactions. For a month with
                  an entered total, smoothed spend = entered cash out −
                  smoothed bills settled that month (net of refunds) +
                  the set-aside. The entered total replaces that month's
                  transactions — the two are never added together.
                </p>
                <p>
                  Monthly bills (mortgage, utilities…) are already inside
                  the cash out. They're listed only to show what the cash
                  out is made of — they are never added to spending or
                  cash out a second time.
                </p>
                <p>
                  Every bill has one category — Insurance, Taxes, Housing,
                  or your own name — and, separately, a “Keep the lights
                  on” check for the essential, must-pay ones. The two are
                  independent: a bill can be Insurance and checked, or
                  Insurance and unchecked. The By category breakdown adds
                  up, per category, the monthly bills (at the amount in
                  effect that month) plus the smoothed bills' monthly
                  set-aside. The Keep the lights on total adds up only the
                  checked bills the same way — that's your essential
                  must-pay floor for the month. Both are labels and
                  subtotals only — neither ever changes any amount.
                  Categories and the Keep-the-lights-on check apply to
                  every month, past and present — changing one regroups
                  past months and past floor totals. Amounts never change.
                </p>
                <p>
                  Large one-offs work the same way: the amount was already
                  part of that month's spending, so a one-off note only
                  explains it. “Smoothed spend excluding one-offs” subtracts
                  them once to show the underlying regular spend — the
                  one-offs themselves are never added anywhere.
                </p>
                  </ExplainerInfoTip>
                </p>
                <QuickViewReturnLink onReturn={scrollToQuickView} />
              </div>
              <p className="display tnum mt-1 text-5xl font-semibold">
                {fmt(data.smoothedCents)}
              </p>
              {spendingTargetMonthlyCents != null && (
                <p className="tnum mt-2 text-base">
                  True monthly cost {fmt(data.smoothedCents)} · Target{" "}
                  {fmt(spendingTargetMonthlyCents)} ·{" "}
                  {(() => {
                    const gapCents =
                      data.smoothedCents - spendingTargetMonthlyCents;
                    return (
                      <span
                        className="font-semibold"
                        style={{
                          color:
                            gapCents > 0 ? "var(--bad)" : "var(--accent)",
                        }}
                      >
                        {gapCents > 0
                          ? `Over by ${fmt(gapCents)}/mo`
                          : gapCents < 0
                            ? `Under by ${fmt(-gapCents)}/mo`
                            : "On target"}
                      </span>
                    );
                  })()}
                </p>
              )}
              {/* Spending target field: the Tax Plan record's
                  annual spending, edited in place here (plain
                  typed field — no steppers/sliders), with the
                  same per year / per month toggle the Tax Plan
                  and Playground spending fields carry. It writes
                  through to the record via saveRothInputs with
                  CAS, so editing it here updates the Tax Plan,
                  Retirement, and Playground too. */}
              <div className="mt-4 max-w-xs">
                <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5">
                    <label
                      className="block text-sm font-medium text-[var(--text)]"
                      htmlFor="spending-target-per-year"
                    >
                      {spendingTargetUnit === "month"
                        ? "Spending target per month"
                        : "Spending target per year"}
                    </label>
                    <InfoTip
                      ariaLabel="About the spending target"
                      text="The Tax Plan’s annual spending — editing here changes the saved plan, like editing it in the Tax Plan, Retirement, or Playground."
                    />
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative shrink-0">
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-base text-[var(--dim)]"
                    >
                      $
                    </span>
                  <input
                    id="spending-target-per-year"
                    aria-label={
                      spendingTargetUnit === "month"
                        ? "Spending target per month"
                        : "Spending target per year"
                    }
                    className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 pl-7 text-base text-[var(--text)]"
                    inputMode="decimal"
                    value={
                      spendingTargetUnit === "month"
                        ? (spendingTargetMonthlyDraft ?? spendingTargetMonthlyDisplay())
                        : spendingTarget
                    }
                    onFocus={() => {
                      spendingTargetFocusedRef.current = true;
                      if (spendingTargetUnit === "month") {
                        setSpendingTargetMonthlyDraft(monthlyRaw(spendingTarget));
                      }
                    }}
                    onBlur={() => {
                      spendingTargetFocusedRef.current = false;
                      if (spendingTargetUnit === "month") {
                        setSpendingTargetMonthlyDraft(null);
                      }
                      // The annual state is canonicalized on
                      // blur, exactly as the Tax Plan's spending
                      // field does: the same numeric value,
                      // grouped.
                      const d = parseDollars(spendingTarget);
                      if (d != null) setSpendingTarget(fmtInputMoney(d));
                      // Blur flush: the value is settled now, so
                      // send any held Tax Plan write-through.
                      firePendingSpendingTargetSaveRef.current();
                    }}
                    onChange={(e) => {
                      if (spendingTargetUnit === "month") {
                        setSpendingTargetMonthlyDraft(e.target.value);
                        setSpendingTarget(monthlyToAnnual(e.target.value));
                      } else {
                        setSpendingTarget(e.target.value);
                      }
                    }}
                  />
                {spendingTargetUnit === "month" && (
                  <p className="mt-1 text-xs text-[var(--dim)]">
                    = {fmt(parseDollars(spendingTarget) ?? 0)}/yr
                  </p>
                )}
                    </div>
                    <div
                      role="group"
                      aria-label="Spending display period"
                      className="flex shrink-0 overflow-hidden rounded-[var(--radius)] border border-[var(--border)]"
                    >
                      <button
                        type="button"
                        aria-label="Show spending per year"
                        aria-pressed={spendingTargetUnit === "year"}
                        onClick={() => setSpendingTargetUnit("year")}
                        className={`px-2 py-1 text-xs font-medium ${spendingTargetUnit === "year" ? "bg-[var(--accent)] text-white" : "text-[var(--text)] hover:text-[var(--accent)]"}`}
                      >
                        Per year
                      </button>
                      <button
                        type="button"
                        aria-label="Show spending per month"
                        aria-pressed={spendingTargetUnit === "month"}
                        onClick={() => setSpendingTargetUnit("month")}
                        className={`px-2 py-1 text-xs font-medium ${spendingTargetUnit === "month" ? "bg-[var(--accent)] text-white" : "text-[var(--text)] hover:text-[var(--accent)]"}`}
                      >
                        Per month
                      </button>
                    </div>
                  </div>
                {spendingTargetMsg != null && (
                  <p className="mt-1 text-xs text-[var(--bad)]" role="note">
                    {spendingTargetMsg}
                  </p>
                )}
              </div>
              {data.isSummaryMonth || data.isItemsMonth ? (
                <dl className="tnum mt-4 space-y-1 border-t border-[var(--border)] pt-3 text-base">
                  <div className="flex justify-between gap-3">
                    <dt>
                      {data.isItemsMonth
                        ? `Cash out from this month's items (${data.cashOutItemsCount} item${data.cashOutItemsCount === 1 ? "" : "s"})`
                        : "Cash out you entered for this month"}
                    </dt>
                    <dd className="font-medium">
                      <button
                        type="button"
                        aria-label={`Go to Monthly cash out for ${monthLabel(month)}`}
                        className="underline decoration-dotted underline-offset-4 hover:text-[var(--accent)]"
                        onClick={goToCashOutSource}
                      >
                        {fmt(data.isItemsMonth ? data.cashOutItemsTotalCents : (data.enteredCashOutCents ?? 0))}
                      </button>
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3 text-[var(--dim)]">
                    <dt>− Smoothed bills paid this month</dt>
                    <dd>
                      <button
                        type="button"
                        aria-label={`Show the settlement breakdown for smoothed bills paid in ${monthLabel(month)}`}
                        aria-expanded={smoothedBreakdownOpen}
                        aria-controls="smoothed-bills-paid-breakdown"
                        className="underline decoration-dotted underline-offset-4 hover:text-[var(--accent)]"
                        onClick={goToSmoothedBillsPaid}
                      >
                        {fmt(data.yearlyLumpsCents)}
                      </button>
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3 text-[var(--dim)]">
                    <dt>
                      + Smoothed-bill set-aside (sum of this month&rsquo;s
                      in-effect bills&rsquo; monthly amounts —{" "}
                      {fmt(data.totalAnnualCents)} a year in effect this month)
                    </dt>
                    <dd>
                      <button
                        type="button"
                        aria-label="Go to Yearly & periodic expenses"
                        className="underline decoration-dotted underline-offset-4 hover:text-[var(--accent)]"
                        onClick={() => scrollToSection("section-yearly-expenses")}
                      >
                        {fmt(data.accrualCents)}
                      </button>
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3 border-t border-[var(--border)] pt-2 font-semibold">
                    <dt>= Smoothed spend</dt>
                    <dd>{fmt(data.smoothedCents)}</dd>
                  </div>
                </dl>
              ) : (
                <dl className="tnum mt-4 space-y-1 border-t border-[var(--border)] pt-3 text-base">
                  <div className="flex justify-between gap-3">
                    <dt>Cash out this month</dt>
                    <dd className="font-medium">
                      <button
                        type="button"
                        aria-label={`Go to Transactions for ${monthLabel(month)}`}
                        className="underline decoration-dotted underline-offset-4 hover:text-[var(--accent)]"
                        onClick={goToCashOutSource}
                      >
                        {fmt(data.cashOutCents)}
                      </button>
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3 text-[var(--dim)]">
                    <dt>− Smoothed bills paid this month</dt>
                    <dd>
                      <button
                        type="button"
                        aria-label={`Show the settlement breakdown for smoothed bills paid in ${monthLabel(month)}`}
                        aria-expanded={smoothedBreakdownOpen}
                        aria-controls="smoothed-bills-paid-breakdown"
                        className="underline decoration-dotted underline-offset-4 hover:text-[var(--accent)]"
                        onClick={goToSmoothedBillsPaid}
                      >
                        {fmt(data.yearlyLumpsCents)}
                      </button>
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3 text-[var(--dim)]">
                    <dt>
                      + Smoothed-bill set-aside (sum of this month&rsquo;s
                      in-effect bills&rsquo; monthly amounts —{" "}
                      {fmt(data.totalAnnualCents)} a year in effect this month)
                    </dt>
                    <dd>
                      <button
                        type="button"
                        aria-label="Go to Yearly & periodic expenses"
                        className="underline decoration-dotted underline-offset-4 hover:text-[var(--accent)]"
                        onClick={() => scrollToSection("section-yearly-expenses")}
                      >
                        {fmt(data.accrualCents)}
                      </button>
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3 border-t border-[var(--border)] pt-2 font-semibold">
                    <dt>= Smoothed spend</dt>
                    <dd>{fmt(data.smoothedCents)}</dd>
                  </div>
                </dl>
              )}
              {smoothedBreakdownOpen && (
                <div
                  ref={smoothedBreakdownRef}
                  id="smoothed-bills-paid-breakdown"
                  className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-alt)] p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="font-semibold">
                      Smoothed bills paid — {monthLabel(month)}
                    </h3>
                    <button
                      type="button"
                      aria-label="Close smoothed bills paid breakdown"
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--border)] text-[var(--text)]"
                      onClick={() => setSmoothedBreakdownOpen(false)}
                    >
                      ✕
                    </button>
                  </div>
                  <p className="mt-1 text-sm text-[var(--dim)]">
                    Counted in the month each bill settles, net of
                    refunds: a bill paid straight from checking counts
                    in its own month, and a bill charged to a card
                    counts when the card payment settles it — not in
                    the month the charge was recorded. A refund counts
                    here too: the part matching a previously settled
                    charge reverses that settlement, and any part
                    beyond what was ever settled is shown on its own
                    line as unmatched, so the figure is the
                    month&rsquo;s net settlements. Each line is the portion of a payment
                    counted here; a payment&rsquo;s full amount is named
                    in its line when only part of it counts.
                  </p>
                  {smoothedBreakdown.error ? (
                    <p className="mt-2 text-sm text-[var(--bad)]">
                      Something went wrong loading the breakdown. Try again.
                    </p>
                  ) : !smoothedBreakdown.data || smoothedBreakdown.data.month !== month ? (
                    <p className="mt-2 text-sm text-[var(--dim)]">Loading…</p>
                  ) : smoothedBreakdown.data.yearlyPaidOutLines.length === 0 ? (
                    <>
                      <p className="mt-2 text-sm text-[var(--dim)]">
                        No smoothed bill settled in {monthLabel(month)} —
                        nothing settled for one this month.
                      </p>
                      <DrillLines
                        lines={[]}
                        totalCents={smoothedBreakdown.data.yearlyPaidOutCents}
                      />
                    </>
                  ) : (
                    <DrillLines
                      lines={yearlyPaidOutDrillLines(smoothedBreakdown.data)}
                      totalCents={smoothedBreakdown.data.yearlyPaidOutCents}
                    />
                  )}
                </div>
              )}
              <div className="tnum mt-4 flex flex-wrap items-start justify-between gap-2 border-t border-[var(--border)] pt-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-sm font-medium text-[var(--dim)]">
                    <span>
                      Actual average ({data.trailingMonthsCovered} mo)
                    </span>
                    {data.trailingMonthsCovered > 0 && (
                      <InfoTip
                        ariaLabel="About the actual average"
                        text={`Total spending recorded over the last ${data.trailingMonthsCovered} month${data.trailingMonthsCovered === 1 ? "" : "s"}, divided by ${data.trailingMonthsCovered}. A check on the smoothed number.`}
                      />
                    )}
                  </p>
                  {data.trailingMonthsCovered === 0 && (
                    <p className="mt-0.5 max-w-md text-sm leading-relaxed text-[var(--dim)]">
                      Appears once you have transactions.
                    </p>
                  )}
                </div>
                <p className="display text-2xl font-semibold whitespace-nowrap">
                  {fmt(data.trailingAvgCents)}
                </p>
              </div>
              {(data.isSummaryMonth || data.isItemsMonth) &&
                data.transactionCountThisMonth > 0 && (
                <div className="mt-3 rounded-[var(--radius)] border border-[var(--warn)] bg-[var(--warn-soft)] px-3 py-2 text-sm leading-relaxed">
                  <p className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span>
                      <strong>Heads up</strong> — this month uses your{" "}
                      {data.isItemsMonth ? "cash-out items" : "entered total"};
                      transactions aren't double-counted.
                    </span>
                    <button
                      type="button"
                      aria-expanded={headsUpOpen}
                      aria-controls="true-cost-heads-up-details"
                      aria-label={
                        headsUpOpen
                          ? "Hide details about this month's cash-out basis"
                          : "Show details about this month's cash-out basis"
                      }
                      onClick={() => setHeadsUpOpen(!headsUpOpen)}
                      className="shrink-0 font-medium whitespace-nowrap underline underline-offset-2"
                    >
                      {headsUpOpen ? "Less" : "Details"}
                    </button>
                  </p>
                  {headsUpOpen && (
                    <p id="true-cost-heads-up-details" className="mt-2">
                      <strong>
                        Heads up — this month uses your{" "}
                        {data.isItemsMonth ? "cash-out items" : "entered total"}.
                      </strong>{" "}
                      {data.isItemsMonth ? (
                        <>
                          The items for {monthLabel(month)} add up to{" "}
                          {fmt(data.cashOutItemsTotalCents)}
                        </>
                      ) : (
                        <>
                          You entered a cash-out total of{" "}
                          {fmt(data.enteredCashOutCents ?? 0)} for {monthLabel(month)}
                        </>
                      )}
                      , and this month also has {data.transactionCountThisMonth}{" "}
                      transaction{data.transactionCountThisMonth === 1 ? "" : "s"}{" "}
                      (spending {fmt(data.transactionIncurredCents)}, checking
                      cash out {fmt(data.transactionCashOutCents)}). To avoid
                      double-counting, that total is the month's number
                      and the transactions are <strong>not</strong> added on top
                      of it. The one exception: smoothed bills (yearly or
                      periodic) settled this month, net of refunds, (
                      {fmt(data.yearlyLumpsCents)}) are still subtracted
                      in the formula above, so they aren't counted twice.
                      {data.isItemsMonth
                        ? " Delete the items below if you'd rather use the month's entered total or its transactions."
                        : " Delete the entered total below if you'd rather use the transactions."}
                    </p>
                  )}
                </div>
              )}
            </section>

            {/* monthly cash out — one number per month */}
            <section id="section-cash-out" aria-label="Monthly cash out" className={`mt-6 scroll-mt-4 rounded-[var(--radius)]${highlightCls("section-cash-out")}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="display text-xl font-semibold">Monthly cash out</h2>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className={btnGhost}
                    onClick={() => openNewItem(month)}
                  >
                    + Itemize a month
                  </button>
                  <button
                    type="button"
                    className={btnAdd}
                    onClick={() =>
                      openSummaryForm(
                        month,
                        data.summaries.find((s) => s.month === month)?.cashOutCents,
                      )
                    }
                  >
                    {data.isSummaryMonth ? "Edit this month's total" : "+ Enter a month's total"}
                  </button>
                </div>
              </div>
              <Explainer
                id="spending.cashOut"
                label="Monthly cash out"
                hideToggle
                className="mt-1"
                summary="One number per month — everything that left checking; if a month has both a total and items, the items win."
              >
                <p>
                  The simple way: one number per month — everything that left
                  checking. For a month with an entered total, that total is
                  the month's cash out and spending base; any transactions
                  recorded for that month are not added on top of it. Or
                  itemize a month instead: add line items and their sum
                  becomes that month's cash out. If a month has both, the
                  items win and the entered total stays below as a reference
                  so you can reconcile the difference; deleting all the items
                  returns the month to its entered total.
                </p>
              </Explainer>

              {showSummaryForm && (
                <form onSubmit={submitSummary} className="mt-3 space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
                  <h3 className="display text-lg font-semibold">
                    {data.summaries.some((s) => s.month === sMonth)
                      ? "Edit month's cash out"
                      : "Enter month's cash out"}
                  </h3>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="s-month" className={labelCls}>Month</label>
                      <input id="s-month" type="month" required className={inputCls} value={sMonth} onChange={(e) => setSMonth(e.target.value)} />
                    </div>
                    <div>
                      <label htmlFor="s-amount" className={labelCls}>Total cash out ($)</label>
                      <input id="s-amount" type="text" inputMode="decimal" required placeholder="0.00" className={inputCls} value={sDollars} onChange={(e) => setSDollars(e.target.value)} />
                    </div>
                  </div>
                  <p className="text-sm text-[var(--dim)]">
                    Everything that left checking in {monthLabel(sMonth || month)} —
                    bills, card payments, all of it, as one total.
                  </p>
                  {summaryError && <p className="text-sm text-[var(--bad)]">{summaryError}</p>}
                  <div className="flex gap-2">
                    <button type="submit" className={btnPrimary} disabled={upsertSummary.isPending}>
                      Save cash out
                    </button>
                    <button type="button" className={btnGhost} onClick={() => { setShowSummaryForm(false); setSummaryEpoch(null); }}>
                      Cancel
                    </button>
                  </div>
                </form>
              )}

              {showItemForm && (
                <form onSubmit={submitItem} className="mt-3 space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
                  <h3 className="display text-lg font-semibold">
                    {editingItemId ? "Edit cash out item" : "Add cash out item"}
                  </h3>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="ci-date" className={labelCls}>Date cash went out</label>
                      <input id="ci-date" type="date" required className={inputCls} value={iDate} onChange={(e) => setIDate(e.target.value)} />
                    </div>
                    <div>
                      <label htmlFor="ci-amount" className={labelCls}>Amount ($)</label>
                      <input id="ci-amount" type="text" inputMode="decimal" required placeholder="0.00" className={inputCls} value={iDollars} onChange={(e) => setIDollars(e.target.value)} />
                    </div>
                  </div>
                  <div>
                    <label htmlFor="ci-desc" className={labelCls}>Name</label>
                    <CategoryField
                      id="ci-desc"
                      value={iDesc}
                      options={cashOutNameOptions}
                      onChange={setIDesc}
                      customLabel="Add a new name…"
                      customPlaceholder="Type a new name"
                      customAriaLabel="New name"
                      placeholderOption="Choose a name…"
                    />
                  </div>
                  <div>
                    <label htmlFor="ci-note" className={labelCls}>Note (optional)</label>
                    <input id="ci-note" type="text" className={inputCls} value={iNote} onChange={(e) => setINote(e.target.value)} placeholder="Any detail worth remembering" />
                  </div>
                  <p className="text-sm text-[var(--dim)]">
                    Items roll up: the sum of {monthLabel(iDate.slice(0, 7) || month)}'s
                    items becomes that month's cash out everywhere — Quick
                    view, true cost, and the explorer.
                  </p>
                  {itemError && <p className="text-sm text-[var(--bad)]">{itemError}</p>}
                  <div className="flex gap-2">
                    <button type="submit" className={btnPrimary} disabled={addCashOutItem.isPending || updateCashOutItem.isPending}>
                      {editingItemId ? "Save changes" : "Add item"}
                    </button>
                    <button type="button" className={btnGhost} onClick={resetItemForm}>
                      Cancel
                    </button>
                  </div>
                </form>
              )}

              {data.cashOutMonths.length === 0 && !showSummaryForm && !showItemForm && (
                <p className="mt-3 rounded-[var(--radius)] border border-dashed border-[var(--border)] p-4 text-sm text-[var(--dim)]">
                  No monthly totals entered yet. If you'd rather not track
                  individual transactions, enter one cash-out number per
                  month here — or itemize a month with line items that add
                  up to it.
                </p>
              )}
              {data.cashOutMonths.length > 0 && (
                <ul className="mt-3 divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
                  {[...data.cashOutMonths].reverse().map((cm) => {
                    const expanded = cashOutMonthExpanded(cm.month);
                    const hasBoth =
                      cm.enteredCashOutCents != null && cm.itemsCount > 0;
                    return (
                      <li key={cm.month} className="p-3">
                        <div className="flex items-center justify-between gap-3">
                          <button
                            type="button"
                            className="text-left text-base font-medium underline-offset-2 hover:underline"
                            aria-label={`View ${monthLabel(cm.month)}`}
                            onClick={() => setMonth(cm.month)}
                          >
                            {monthLabel(cm.month)}
                            {cm.month === month && (
                              <span className="ml-2 text-xs font-normal text-[var(--accent)]">Viewing</span>
                            )}
                          </button>
                          <div className="flex shrink-0 items-center gap-1">
                            <span className="tnum text-base font-medium">{fmt(cm.resolvedCashOutCents)}</span>
                            <button
                              type="button"
                              aria-expanded={expanded}
                              aria-label={`${expanded ? "Hide" : "Show"} items for ${monthLabel(cm.month)}`}
                              className="px-1 py-1 text-sm text-[var(--accent)]"
                              onClick={() => toggleCashOutMonth(cm.month)}
                            >
                              {expanded ? "Hide items" : cm.itemsCount > 0 ? "Show items" : "Itemize"}
                            </button>
                            {cm.enteredCashOutCents != null && (
                              <>
                                <button type="button" aria-label={`Edit cash out for ${monthLabel(cm.month)}`} className="px-1 py-1 text-sm text-[var(--accent)]" onClick={() => openSummaryForm(cm.month, cm.enteredCashOutCents ?? undefined)}>
                                  Edit
                                </button>
                                {confirmDeleteSummaryMonth !== cm.month && (
                                  <button type="button" aria-label={`Delete cash out for ${monthLabel(cm.month)}`} className="px-1 py-1 text-sm text-[var(--bad)]" onClick={() => setConfirmDeleteSummaryMonth(cm.month)}>
                                    ✕
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        </div>
                        {confirmDeleteSummaryMonth === cm.month && (
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <span className="text-sm text-[var(--bad)]">
                              Delete {monthLabel(cm.month)}?
                            </span>
                            <button
                              type="button"
                              aria-label={`Confirm delete cash out for ${monthLabel(cm.month)}`}
                              className="rounded border border-[var(--bad)] px-2 py-1 text-sm font-medium text-[var(--bad)]"
                              disabled={deleteSummary.isPending}
                              onClick={() => {
                                deleteSummary.mutate(cm.month);
                                setConfirmDeleteSummaryMonth(null);
                              }}
                            >
                              Delete
                            </button>
                            <button
                              type="button"
                              aria-label={`Cancel delete cash out for ${monthLabel(cm.month)}`}
                              className="rounded border border-[var(--border)] px-2 py-1 text-sm"
                              onClick={() => setConfirmDeleteSummaryMonth(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        )}
                        {cm.itemsCount > 0 && (
                          <p className="mt-0.5 text-xs text-[var(--dim)]">
                            from {cm.itemsCount} item{cm.itemsCount === 1 ? "" : "s"}
                          </p>
                        )}
                        {hasBoth && (
                          <p className="tnum mt-0.5 text-xs text-[var(--dim)]">
                            Entered total {fmt(cm.enteredCashOutCents ?? 0)} · Items{" "}
                            {fmt(cm.itemsTotalCents)} · Difference{" "}
                            {fmtSigned(cm.itemsTotalCents - (cm.enteredCashOutCents ?? 0))}
                          </p>
                        )}
                        {expanded && (
                          <div className="mt-3 border-t-2 border-[var(--dim)] pt-3">
                            {cm.items.length === 0 ? (
                              <p className="text-sm text-[var(--dim)]">
                                No items yet for {monthLabel(cm.month)} — add
                                the first one and it starts rolling up right away.
                              </p>
                            ) : (
                              <ul className="divide-y divide-[var(--border)]">
                                {/* Latest paid first: items arrive day-ascending, so render a copy sorted by paid day descending (newest entry first within the same day). */}
                                {[...cm.items]
                                  .sort((a, b) => b.day - a.day || b.id - a.id)
                                  .map((it) => (
                                  <li key={it.id} className="py-2">
                                    <div className="flex items-start justify-between gap-3">
                                      <div className="min-w-0">
                                        <p className="text-base">
                                          {it.description}{" "}
                                          <span className="text-sm text-[var(--dim)] opacity-40">
                                            · paid on the {ordinalDay(it.day)}
                                          </span>
                                        </p>
                                        {it.note && (
                                          <p className="text-xs text-[var(--dim)]">{it.note}</p>
                                        )}
                                      </div>
                                      <div className="flex shrink-0 items-center gap-1">
                                        <span className="tnum text-base font-medium">{fmt(it.amountCents)}</span>
                                        <button type="button" aria-label={`Edit ${it.description}`} className="px-1 py-1 text-sm text-[var(--accent)]" onClick={() => openEditItem(it)}>
                                          Edit
                                        </button>
                                        {confirmDeleteCashOutItemId !== it.id && (
                                          <button type="button" aria-label={`Delete ${it.description}`} className="px-1 py-1 text-sm text-[var(--bad)]" onClick={() => setConfirmDeleteCashOutItemId(it.id)}>
                                            ✕
                                          </button>
                                        )}
                                      </div>
                                    </div>
                                    {confirmDeleteCashOutItemId === it.id && (
                                      <div className="mt-1 flex flex-wrap items-center gap-2">
                                        <span className="text-sm text-[var(--bad)]">
                                          Delete {it.description}?
                                        </span>
                                        <button
                                          type="button"
                                          aria-label={`Confirm delete ${it.description}`}
                                          className="rounded border border-[var(--bad)] px-2 py-1 text-sm font-medium text-[var(--bad)]"
                                          disabled={deleteCashOutItem.isPending}
                                          onClick={() => {
                                            deleteCashOutItem.mutate(it.id);
                                            setConfirmDeleteCashOutItemId(null);
                                          }}
                                        >
                                          Delete
                                        </button>
                                        <button
                                          type="button"
                                          aria-label={`Cancel delete ${it.description}`}
                                          className="rounded border border-[var(--border)] px-2 py-1 text-sm"
                                          onClick={() => setConfirmDeleteCashOutItemId(null)}
                                        >
                                          Cancel
                                        </button>
                                      </div>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            )}
                            <button
                              type="button"
                              className="mt-2 text-sm font-medium text-[var(--accent)]"
                              aria-label={`Add item for ${monthLabel(cm.month)}`}
                              onClick={() => openNewItem(cm.month)}
                            >
                              + Add item
                            </button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {actionMsg && (
              <p className="mt-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--accent-soft)] px-3 py-2 text-sm">
                {actionMsg}
              </p>
            )}

            {!data.hasAnyData && (
              <section className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
                <h2 className="display text-xl font-semibold">Start here</h2>
                <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
                  Add your yearly &amp; periodic bills first (insurance,
                  property tax, memberships, a water bill every other
                  month, a garbage bill every 3 months…), then either enter one cash-out total per month
                  or add transactions as they happen — or import a CSV from
                  your bank or card. You can also load the sample household
                  to see the math work — a full year of monthly bills,
                  smoothed bills, and cash-out totals you can explore,
                  edit, or delete.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={btnPrimary}
                    disabled={seed.isPending}
                    onClick={() => seed.mutate()}
                  >
                    Load example data
                  </button>
                  <button
                    type="button"
                    className={btnGhost}
                    onClick={() => openSummaryForm(month)}
                  >
                    Enter a month's cash out
                  </button>
                  <button
                    type="button"
                    className={btnGhost}
                    onClick={() => {
                      resetYearlyForm();
                      setShowYearlyForm(true);
                    }}
                  >
                    Add a smoothed bill
                  </button>
                  <button
                    type="button"
                    className={btnGhost}
                    onClick={() => openNewTxn()}
                  >
                    Add a transaction
                  </button>
                </div>
              </section>
            )}

            {/* The smoothed-bill reserve card is hidden by request
                (display only): the reserve is still calculated
                server-side and still powers the Coming up forecast
                and its projected reserve figures below. Actual cash
                out lives in the Quick view strip; Actual average sits
                with the smoothed figure above as its cross-check. */}

            {/* by category — bills grouped by their category label */}
            <section aria-label="Bills by category" className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="display text-lg font-semibold">
                    By category — {monthLabel(month)}
                  </h2>
                  <p className="tnum mt-0.5 text-sm text-[var(--dim)]">
                    Monthly bills {fmt(data.monthlyBillsTotalCents)}/mo + yearly set-aside {fmt(data.accrualCents)}/mo
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <p className="display tnum text-3xl font-semibold">
                    {fmt(data.categoryBreakdownTotalCents)}
                    <span className="text-base font-normal text-[var(--dim)]"> /mo</span>
                  </p>
                  {data.categoryBreakdown.length > 0 && (
                    <button
                      type="button"
                      className={btnGhost}
                      aria-expanded={!byCategoryCollapsedAll}
                      aria-controls="by-category-list"
                      onClick={() =>
                        handleByCategoryCollapsedAllChange(!byCategoryCollapsedAll)
                      }
                    >
                      {byCategoryCollapsedAll ? "Expand all" : "Collapse all"}
                    </button>
                  )}
                </div>
              </div>
              {!byCategoryCollapsedAll && (
              <Explainer
                id="spending.byCategory"
                label="By category"
                className="mt-1"
                summary="Your bills grouped by category — labels only: changing a category never changes any amount, but it regroups every month, past and present."
              >
                <p>
                  Your bills grouped by the category on each bill. Each row is that
                  category's monthly bills (at the amount in effect this month) plus
                  its smoothed bills' monthly set-aside — so the rows add up to your
                  monthly bills total plus the set-aside. Categories say what a bill
                  is <em>for</em>; the separate{" "}
                  <strong className="text-[var(--text)]">Keep the lights on</strong>{" "}
                  check on each bill says whether it must always be paid — the two
                  work independently. Categories and the Keep-the-lights-on
                  check apply to every month, past and present — changing one
                  regroups past months (here and in Slice &amp; dice) and past
                  floor totals. Amounts never change.
                </p>
              </Explainer>
              )}
              {!byCategoryCollapsedAll && (data.categoryBreakdown.length === 0 ? (
                <p className="mt-3 rounded-[var(--radius)] border border-dashed border-[var(--border)] p-3 text-sm text-[var(--dim)]">
                  No bills yet. Add monthly or smoothed bills and they'll be
                  grouped here by category.
                </p>
              ) : (
                <ul id="by-category-list" className="mt-3 divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)]">
                  {data.categoryBreakdown.map((c) => (
                    <li key={c.category} className="p-3">
                      <div className="flex items-baseline justify-between gap-3">
                        <p className="text-base font-semibold">
                          {c.category}
                          <span className="ml-2 text-xs font-normal text-[var(--dim)]">
                            {c.billCount} bill{c.billCount === 1 ? "" : "s"}
                          </span>
                        </p>
                        <p className="tnum text-base font-semibold">{fmt(c.totalCents)}/mo</p>
                      </div>
                      <dl className="tnum mt-1 space-y-0.5 text-sm text-[var(--dim)]">
                        <div className="flex justify-between gap-3">
                          <dt>Monthly bills</dt>
                          <dd>{fmt(c.monthlyCents)}/mo</dd>
                        </div>
                        <div className="flex justify-between gap-3">
                          <dt>+ Smoothed bills (set-aside)</dt>
                          <dd>{fmt(c.smoothedCents)}/mo</dd>
                        </div>
                      </dl>
                    </li>
                  ))}
                </ul>
              ))}
              {!byCategoryCollapsedAll && data.categoryBreakdown.length > 0 && (
                <dl className="tnum mt-3 space-y-1 border-t border-[var(--border)] pt-3 text-base">
                  <div className="flex justify-between gap-3 text-[var(--dim)]">
                    <dt>Monthly bills total</dt>
                    <dd>{fmt(data.monthlyBillsTotalCents)}/mo</dd>
                  </div>
                  <div className="flex justify-between gap-3 text-[var(--dim)]">
                    <dt>+ Smoothed-bill set-aside</dt>
                    <dd>{fmt(data.accrualCents)}/mo</dd>
                  </div>
                  <div className="flex justify-between gap-3 border-t border-[var(--border)] pt-2 font-semibold">
                    <dt>= All categories</dt>
                    <dd>{fmt(data.categoryBreakdownTotalCents)}/mo</dd>
                  </div>
                </dl>
              )}
            </section>

            {/* keep the lights on — essential must-pay floor (checked bills only) */}
            <section id="section-keep-lights-on" aria-label="Keep the lights on total" className={`mt-4 scroll-mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5${highlightCls("section-keep-lights-on")}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="display text-lg font-semibold">
                  Keep the lights on — {monthLabel(month)}
                </h2>
                <p className="display tnum text-3xl font-semibold">
                  {fmt(data.keepLightsOnTotalCents)}
                  <span className="text-base font-normal text-[var(--dim)]"> /mo</span>
                </p>
              </div>
              <Explainer
                id="spending.keepLightsOn"
                label="Keep the lights on"
                className="mt-1"
                summary="Your essential must-pay floor — checked bills only; a label only, it never changes any amount, but the check applies to every month, past and present."
              >
                <p>
                  Your essential must-pay floor for the month: only the bills
                  with the <strong className="text-[var(--text)]">Keep the lights on</strong>{" "}
                  check on their card, whatever their category. Monthly bills
                  count at the amount in effect this month; smoothed bills
                  count at this month's set-aside. It's a label only — checking
                  or unchecking a bill never changes smoothed spend, cash out,
                  or any other amount. Categories and the Keep-the-lights-on
                  check apply to every month, past and present — changing one
                  regroups past months and past floor totals. Amounts never change.
                </p>
              </Explainer>
              <dl className="tnum mt-3 space-y-1 border-t border-[var(--border)] pt-3 text-base">
                <div className="flex justify-between gap-3 text-[var(--dim)]">
                  <dt>Checked monthly bills</dt>
                  <dd>
                    <button
                      type="button"
                      aria-label="Go to Monthly bills"
                      className="underline decoration-dotted underline-offset-4 hover:text-[var(--accent)]"
                      onClick={() => scrollToSection("section-monthly-bills")}
                    >
                      {fmt(data.keepLightsOnMonthlyCents)}/mo
                    </button>
                  </dd>
                </div>
                <div className="flex justify-between gap-3 text-[var(--dim)]">
                  <dt>+ Checked smoothed bills (set-aside)</dt>
                  <dd>
                    <button
                      type="button"
                      aria-label="Go to Yearly & periodic expenses"
                      className="underline decoration-dotted underline-offset-4 hover:text-[var(--accent)]"
                      onClick={() => scrollToSection("section-yearly-expenses")}
                    >
                      {fmt(data.keepLightsOnSmoothedCents)}/mo
                    </button>
                  </dd>
                </div>
                <div className="flex justify-between gap-3 border-t border-[var(--border)] pt-2 font-semibold">
                  <dt>= Keep the lights on floor</dt>
                  <dd>{fmt(data.keepLightsOnTotalCents)}/mo</dd>
                </div>
              </dl>
              {data.keepLightsOnTotalCents === 0 && (
                <p className="mt-3 rounded-[var(--radius)] border border-dashed border-[var(--border)] p-3 text-sm text-[var(--dim)]">
                  Nothing checked yet. Tick “Keep the lights on” on the bills
                  that must always be paid — mortgage, utilities, insurance —
                  and they'll add up here.
                </p>
              )}
            </section>

            {showProvisional && (
              <section className="mt-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3 text-sm leading-relaxed text-[var(--dim)]">
                <strong className="text-[var(--text)]">Early days:</strong>{" "}
                with only {data.trailingMonthsCovered} months tracked, the
                smoothed and actual averages are expected to differ —
                smoothed bills already paid are in the actual average, but
                bills that haven't come due yet aren't. This check becomes meaningful
                once a full 12 months are covered.
              </section>
            )}

            {showDivergence && (
              <section className="mt-3 rounded-[var(--radius)] border border-[var(--warn)] bg-[var(--warn-soft)] p-3 text-sm leading-relaxed">
                <strong>Worth a look:</strong> your average smoothed spend (
                {fmt(data.avgSmoothedCents)}) and your actual average (
                {fmt(data.trailingAvgCents)}) differ by{" "}
                {fmt(Math.abs(data.divergenceCents))} (
                {Math.abs(Math.round(data.divergencePct * 100))}%). When these
                drift apart it usually means something was missed or
                double-counted — or your smoothed-bills list no longer
                matches what the bills actually cost now.
              </section>
            )}

            {/* large one-offs — explanation only, already included */}
            <section aria-label="Large one-offs" className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="display text-lg font-semibold">
                  Large one-offs — {monthLabel(month)}
                </h2>
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" className={btnAdd} onClick={openNewOneOff}>
                    + Add one-off
                  </button>
                </div>
              </div>
              <Explainer
                id="spending.largeOneOffs"
                label="Large one-offs"
                hideToggle
                className="mt-1"
                summary="Big one-time costs that explain a spike — already included in spending, never added a second time."
              >
                <p>
                  Big one-time costs that explain why a month spiked — a car repair, an
                  appliance, a trip.{" "}
                  <strong className="text-[var(--text)]">
                    These amounts are already included in this month's spending above.
                  </strong>{" "}
                  They are notes only and are never added to spending, cash out, or the
                  smoothed total a second time.
                </p>
              </Explainer>

              {showOneOffForm && (
                <form onSubmit={submitOneOff} className="mt-3 space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-alt)] p-4">
                  <h3 className="display text-lg font-semibold">
                    {editingOneOffId ? "Edit one-off" : "Add one-off"}
                  </h3>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="o-month" className={labelCls}>Month</label>
                      <input id="o-month" type="month" required className={inputCls} value={oMonth} onChange={(e) => setOMonth(e.target.value)} />
                    </div>
                    <div>
                      <label htmlFor="o-amount" className={labelCls}>Amount ($) — already included above</label>
                      <input id="o-amount" type="text" inputMode="decimal" required placeholder="0.00" className={inputCls} value={oDollars} onChange={(e) => setODollars(e.target.value)} />
                    </div>
                  </div>
                  <div>
                    <label htmlFor="o-desc" className={labelCls}>Description</label>
                    <CategoryField
                      id="o-desc"
                      value={oDesc}
                      options={data.oneOffDescriptions}
                      onChange={setODesc}
                      customLabel="Add a new description…"
                      customPlaceholder="Type a new description"
                      customAriaLabel="New description"
                      placeholderOption="Choose a description…"
                    />
                  </div>
                  <div>
                    <label htmlFor="o-note" className={labelCls}>Note (optional)</label>
                    <textarea id="o-note" rows={2} className={inputCls} value={oNote} onChange={(e) => setONote(e.target.value)} placeholder="Any detail worth remembering about this cost" />
                  </div>
                  {oneOffError && <p className="text-sm text-[var(--bad)]">{oneOffError}</p>}
                  <div className="flex gap-2">
                    <button type="submit" className={btnPrimary} disabled={addOneOff.isPending || updateOneOff.isPending}>
                      {editingOneOffId ? "Save changes" : "Add one-off"}
                    </button>
                    <button type="button" className={btnGhost} onClick={resetOneOffForm}>
                      Cancel
                    </button>
                  </div>
                </form>
              )}

              {data.oneOffs.length === 0 && !showOneOffForm && (
                <p className="mt-3 rounded-[var(--radius)] border border-dashed border-[var(--border)] p-3 text-sm text-[var(--dim)]">
                  No one-offs noted for {monthLabel(month)}. If this month had a big
                  one-time cost, note it here so the spike is explained later.
                </p>
              )}
              {data.oneOffs.length > 0 && (
                <>
                  <ul className="mt-3 divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)]">
                    {data.oneOffs.map((o) => (
                      <li key={o.id} className="p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-base font-medium">{o.description}</p>
                            {o.note && <p className="text-sm text-[var(--dim)]">{o.note}</p>}
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <span className="tnum text-base font-medium">{fmt(o.amountCents)}</span>
                            <button type="button" aria-label={`Edit ${o.description}`} className="px-1 py-1 text-sm text-[var(--accent)]" onClick={() => openEditOneOff(o)}>
                              Edit
                            </button>
                            {confirmDeleteOneOffId !== o.id && (
                              <button type="button" aria-label={`Delete ${o.description}`} className="px-1 py-1 text-sm text-[var(--bad)]" onClick={() => setConfirmDeleteOneOffId(o.id)}>
                                ✕
                              </button>
                            )}
                          </div>
                        </div>
                        {confirmDeleteOneOffId === o.id && (
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            <span className="text-sm text-[var(--bad)]">
                              Delete {o.description}?
                            </span>
                            <button
                              type="button"
                              aria-label={`Confirm delete ${o.description}`}
                              className="rounded border border-[var(--bad)] px-2 py-1 text-sm font-medium text-[var(--bad)]"
                              disabled={deleteOneOff.isPending}
                              onClick={() => {
                                deleteOneOff.mutate(o.id);
                                setConfirmDeleteOneOffId(null);
                              }}
                            >
                              Delete
                            </button>
                            <button
                              type="button"
                              aria-label={`Cancel delete ${o.description}`}
                              className="rounded border border-[var(--border)] px-2 py-1 text-sm"
                              onClick={() => setConfirmDeleteOneOffId(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                  <dl className="tnum mt-3 space-y-1 border-t border-[var(--border)] pt-3 text-base">
                    <div className="flex justify-between gap-3">
                      <dt>One-offs total — already included above</dt>
                      <dd className="font-medium">{fmt(data.oneOffsTotalCents)}</dd>
                    </div>
                    <div className="flex justify-between gap-3 text-[var(--dim)]">
                      <dt>Smoothed spend for {monthLabel(month)}</dt>
                      <dd>{fmt(data.smoothedCents)}</dd>
                    </div>
                    <div className="flex justify-between gap-3 border-t border-[var(--border)] pt-2 font-semibold">
                      <dt>= Smoothed spend excluding one-offs (regular spend)</dt>
                      <dd>{fmt(data.smoothedExcludingOneOffsCents)}</dd>
                    </div>
                  </dl>
                </>
              )}
            </section>

            {/* forecast: coming up, next 3 months */}
            <section aria-label="Coming up forecast" className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
              <h2 className="display text-lg font-semibold">Coming up — this month and the next 2</h2>
              <Explainer
                id="spending.comingUp"
                label="Coming up"
                className="mt-1"
                summary="Which smoothed bills are due this month and in each of the next 2 months, what they'll cost, and where the reserve stands."
              >
                <p>
                  Projected from {monthLabel(month)}: which smoothed bills are due in each
                  month, what they'll cost, and where the reserve is projected to stand.
                  Projected figures use expected amounts — recorded actuals are used where
                  they already exist.
                </p>
              </Explainer>
              <div className="mt-3 space-y-3">
                {data.forecast.map((f) => (
                  <div key={f.month} className="rounded-[var(--radius)] border border-[var(--border)] p-3">
                    <div className="flex items-baseline justify-between gap-3">
                      <h3 className="text-base font-semibold">{monthLabel(f.month)}</h3>
                      <span className="tnum text-sm text-[var(--dim)]">
                        Total due: <span className="font-medium text-[var(--text)]">{fmt(f.totalDueCents)}</span>
                      </span>
                    </div>
                    {f.dueBills.length === 0 ? (
                      <p className="mt-1 text-sm text-[var(--dim)]">No smoothed bills due this month.</p>
                    ) : (
                      <ul className="mt-1 space-y-1 text-sm">
                        {f.dueBills.map((b) => (
                          <li key={b.id} className="flex justify-between gap-3">
                            <span>
                              {b.name}
                              {b.frequency !== "yearly" ? (
                                <span className="text-[var(--dim)]"> · {freqPhrase(b.frequency)}</span>
                              ) : null}
                            </span>
                            <span className="tnum font-medium">
                              {fmt(b.amountCents)}
                              {b.amountCents !== b.expectedCents && (
                                <span className="font-normal text-[var(--dim)]">
                                  {" "}· expected {fmt(b.expectedCents)}
                                </span>
                              )}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
{/* Shortfall banner hidden per user request — calculation kept server-side, display removed. */}
                  </div>
                ))}
              </div>
              {data.noDueMonthBills.length > 0 && (
                <div className="mt-3 rounded-[var(--radius)] border border-dashed border-[var(--border)] p-3">
                  <h3 className="text-sm font-semibold">No due month set — not in forecast</h3>
                  <p className="mt-1 text-sm text-[var(--dim)]">
                    These bills can't be forecast until you set a due month. Set one on the
                    bill below (or in its Edit form) and it will appear in the months above.
                  </p>
                  <ul className="mt-2 space-y-1 text-sm">
                    {data.noDueMonthBills.map((b) => (
                      <li key={b.id} className="flex flex-wrap items-center justify-between gap-2">
                        <span>
                          {b.name}
                          <span className="text-[var(--dim)]">
                            {" "}· {b.frequency !== "yearly" ? `${fmt(b.expectedCents)}/bill · ${freqPhrase(b.frequency)} · ${fmt(b.annualCents)}/yr` : `${fmt(b.annualCents)}/yr`}
                          </span>
                        </span>
                        <label className="flex items-center gap-1 text-sm">
                          <span className="text-[var(--dim)]">Due month</span>
                          <select
                            aria-label={`Set due month for ${b.name}`}
                            className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm text-[var(--text)]"
                            value=""
                            onChange={(e) => {
                              const v = e.target.value;
                              if (v) setDueMonth.mutate({ id: b.id, dueMonth: Number(v) });
                            }}
                          >
                            <option value="">Set due month…</option>
                            {MONTH_NAMES.map((n, i) => (
                              <option key={n} value={i + 1}>{n}</option>
                            ))}
                          </select>
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="mt-2 text-xs text-[var(--dim)]">
                Calculated reserve right now: {fmt(data.reserveCents)}
                {data.reserveStartMonth
                  ? ` — set-asides less smoothed-bill payments, accumulated since ${monthLabel(data.reserveStartMonth)}.`
                  : "."}
              </p>
            </section>

            {/* monthly bills — breakdown of cash out, never added again */}
            <section id="section-monthly-bills" aria-label="Monthly bills" className={`mt-8 scroll-mt-4 rounded-[var(--radius)]${highlightCls("section-monthly-bills")}`}>
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                {/* The ⓘ sits right after the bold title, ahead of the
                    summary figure; the fold toggle stays alone at the
                    far right. No summary sentence on the face: the
                    "already included in cash out, never added a second
                    time" point lives in the info tooltip, whose full
                    text is the former "More" text, verbatim. The tip
                    now sits near the left edge, so its bubble opens
                    left-aligned (align="start") instead of clipping
                    off the screen's left edge. */}
                <h2 className="display flex min-w-0 flex-wrap items-center gap-x-2 text-xl font-semibold">
                  Monthly bills
                  <ExplainerInfoTip id="spending.monthlyBills" label="Monthly bills" align="start">
                    <p>
                      Your regular monthly bills — mortgage, utilities, and so on.{" "}
                      <strong className="text-[var(--text)]">
                        These are already included in the month's cash out.
                      </strong>{" "}
                      This list only breaks down what the cash out is made of; it
                      is never added to spending or cash out a second time.
                      A bill paid by credit card lands in cash out in the month
                      the card payment leaves the bank, which can be the month
                      after the charge.
                      Amounts below are the ones in effect for {monthLabel(month)};
                      when a bill's price changes, the new amount applies from
                      that month on and earlier months keep their old amount.
                    </p>
                  </ExplainerInfoTip>
                  <span className="tnum text-base font-normal text-[var(--dim)]">
                    {fmt(data.monthlyBillsTotalCents)}/mo
                  </span>
                  {data.monthlyBills.length > 0 && (
                    <span className="tnum text-base font-normal text-[var(--dim)]">
                      · Lights on {fmt(lightsOnMonthlyCents(data.monthlyBills))}
                      /mo · Regular{" "}
                      {fmt(
                        data.monthlyBillsTotalCents -
                          lightsOnMonthlyCents(data.monthlyBills),
                      )}
                      /mo
                    </span>
                  )}
                </h2>
                <div className="ml-auto flex shrink-0 flex-nowrap items-center gap-2">
                  <BillsFoldChevron
                    open={monthlyBillsOpen}
                    controlsId="monthly-bills-roster"
                    onToggle={() => setMonthlyBillsOpen(!monthlyBillsOpen)}
                  />
                </div>
              </div>

              {monthlyBillsOpen && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className={btnAdd}
                    onClick={() => {
                      resetBillForm();
                      setShowBillForm(true);
                    }}
                  >
                    + Add monthly bill
                  </button>
                </div>
              )}

              {showBillForm && (
                <form onSubmit={submitBill} className="mt-3 space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
                  <h3 className="display text-lg font-semibold">
                    {editingBillId ? "Edit monthly bill" : "Add monthly bill"}
                  </h3>
                  <div>
                    <label htmlFor="b-name" className={labelCls}>Name</label>
                    <input id="b-name" type="text" required className={inputCls} value={bName} onChange={(e) => setBName(e.target.value)} placeholder="e.g. Mortgage" />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="b-amount" className={labelCls}>Monthly amount ($)</label>
                      <input id="b-amount" type="text" inputMode="decimal" required placeholder="0.00" className={inputCls} value={bDollars} onChange={(e) => setBDollars(e.target.value)} />
                    </div>
                    <div>
                      <label htmlFor="b-from" className={labelCls}>Amount takes effect from</label>
                      <input id="b-from" type="month" required className={inputCls} value={bEffectiveFrom} onChange={(e) => setBEffectiveFrom(e.target.value)} />
                    </div>
                  </div>
                  <p className="text-sm text-[var(--dim)]">
                    Amounts apply from that month onward — earlier months
                    keep the amount that was in effect then, so past
                    breakdowns don't change. It defaults to this month;
                    choose an earlier month only to deliberately correct
                    that month onward.
                  </p>
                  <div>
                    <label htmlFor="b-paidby" className={labelCls}>Paid from</label>
                    <input id="b-paidby" type="text" className={inputCls} value={bPaidBy} onChange={(e) => setBPaidBy(e.target.value)} list="account-names" />
                  </div>
                  <div>
                    <label htmlFor="b-notes" className={labelCls}>Notes (optional)</label>
                    <input id="b-notes" type="text" className={inputCls} value={bNotes} onChange={(e) => setBNotes(e.target.value)} placeholder="e.g. due on the 1st" />
                  </div>
                  <div>
                    <label htmlFor="b-category" className={labelCls}>Category</label>
                    <CategoryField id="b-category" value={bCategory} options={billCategoryOptions} onChange={setBCategory} />
                    <p className="mt-1 text-sm text-[var(--dim)]">
                      One label per bill — what the bill is for. Custom names
                      you type are offered again for other bills. Categories
                      apply to every month, past and present — changing one
                      regroups past months. Amounts never change.
                    </p>
                  </div>
                  <label className="flex items-start gap-2 text-sm text-[var(--text)]">
                    <input id="b-keep-lights-on" type="checkbox" className="mt-0.5" checked={bKeepLightsOn} onChange={(e) => setBKeepLightsOn(e.target.checked)} />
                    <span>
                      <strong>Keep the lights on</strong> — this is an essential,
                      must-pay bill. Separate from the category: a bill can be
                      Insurance <em>and</em> keep-the-lights-on. Checked bills
                      add up to your essential floor. A label only — it
                      never changes any amount. The check applies to every
                      month, past and present — changing it changes past
                      floor totals too.
                    </span>
                  </label>
                  {billError && <p className="text-sm text-[var(--bad)]">{billError}</p>}
                  <div className="flex gap-2">
                    <button type="submit" className={btnPrimary} disabled={addBill.isPending || updateBill.isPending || setBillAmount.isPending}>
                      {editingBillId ? "Save changes" : "Add bill"}
                    </button>
                    <button type="button" className={btnGhost} onClick={resetBillForm}>
                      Cancel
                    </button>
                  </div>
                </form>
              )}

              {data.monthlyBills.length === 0 && !showBillForm && (
                <p className="mt-3 rounded-[var(--radius)] border border-dashed border-[var(--border)] p-4 text-sm text-[var(--dim)]">
                  No monthly bills yet. Add the regulars — mortgage, phone,
                  utilities — to see what makes up each month's cash out.
                  Remember: they're already in the cash out, so this is
                  explanation only.
                </p>
              )}
              {monthlyBillsOpen && data.monthlyBills.length > 0 && (
                <div id="monthly-bills-roster">
                  {/* "Expand all" lives inside the fold with the roster:
                      it expands the individual bill rows, so it only
                      means anything while the roster is open. */}
                  <div className="mt-3 flex justify-end">
                    <button
                      type="button"
                      className={btnGhost}
                      aria-expanded={!monthlyBillsCollapsedAll}
                      aria-controls="monthly-bills-list"
                      onClick={() =>
                        handleMonthlyBillsCollapsedAllChange(!monthlyBillsCollapsedAll)
                      }
                    >
                      {monthlyBillsCollapsedAll ? "Expand all" : "Collapse all"}
                    </button>
                  </div>
                  <ul id="monthly-bills-list" className="mt-2 divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
                    {data.monthlyBills.map((b) => {
                      const rowOpen = billRowOpen(b);
                      return (
                      <li key={b.id} className="px-3 py-2">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                          {/* Tapping the row opens it in place into
                              its edit controls (amount, category,
                              Keep the lights on) — or closes it
                              again. The tap target is the name +
                              amount button; Edit and Delete stay
                              their own buttons beside it, shown
                              while the row is open. A bill flagged
                              Keep the lights on carries its "Lights
                              on" tag beside its name, open or
                              closed, so the essential bills scan at
                              a glance. */}
                          <button
                            type="button"
                            className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-left"
                            aria-expanded={rowOpen}
                            aria-controls={`monthly-bill-detail-${b.id}`}
                            aria-label={`${rowOpen ? "Close" : "Open"} ${b.name} in-place editor`}
                            onClick={() => toggleBillRow(b)}
                          >
                            <span className="min-w-0">
                              <span className="flex min-w-0 items-center gap-2">
                                <span className="truncate text-base font-medium">{b.name}</span>
                                {b.keepLightsOn && (
                                  <span className="shrink-0 rounded-full bg-[var(--warn-soft)] px-1.5 py-0.5 text-[10.5px] leading-none font-semibold text-[var(--warn-deep)]">
                                    Lights on
                                  </span>
                                )}
                              </span>
                              {rowOpen && (
                                <span className="mt-0.5 block text-xs text-[var(--dim)]">
                                  paid from {b.paidBy}
                                  {b.notes ? ` · ${b.notes}` : ""}
                                </span>
                              )}
                            </span>
                            <span className="flex shrink-0 items-center gap-1.5">
                              <span className="tnum text-base font-medium">
                                {b.effectiveFrom
                                  ? `${fmt(b.amountCents)}/mo`
                                  : "Not yet in effect"}
                              </span>
                              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true" className={`shrink-0 text-[var(--dim)] transition-transform duration-200 motion-reduce:transition-none ${rowOpen ? "rotate-180" : ""}`}>
                                <path d="M3.5 6 8 10.5 12.5 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            </span>
                          </button>
                          {rowOpen && (
                            <span className="flex shrink-0 items-center gap-1">
                              <button type="button" aria-label={`Edit ${b.name}`} className="px-1 py-1 text-sm text-[var(--accent)]" onClick={() => openEditBill(b)}>
                                Edit
                              </button>
                              {confirmDeleteBillId !== b.id && (
                                <button type="button" aria-label={`Delete ${b.name}`} className="px-1 py-1 text-sm text-[var(--bad)]" onClick={() => setConfirmDeleteBillId(b.id)}>
                                  ✕
                                </button>
                              )}
                            </span>
                          )}
                        </div>
                        {confirmDeleteBillId === b.id && (
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <span className="text-sm text-[var(--bad)]">
                              Delete {b.name}? This removes the bill and its amount history.
                            </span>
                            <button
                              type="button"
                              aria-label={`Confirm delete ${b.name}`}
                              className="rounded border border-[var(--bad)] px-2 py-1 text-sm font-medium text-[var(--bad)]"
                              disabled={deleteBill.isPending}
                              onClick={() => {
                                deleteBill.mutate(b.id);
                                setConfirmDeleteBillId(null);
                              }}
                            >
                              Delete
                            </button>
                            <button
                              type="button"
                              aria-label={`Cancel delete ${b.name}`}
                              className="rounded border border-[var(--border)] px-2 py-1 text-sm"
                              onClick={() => setConfirmDeleteBillId(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        )}
                        {rowOpen && (
                          <div id={`monthly-bill-detail-${b.id}`}>
                        <BillAmountEditor bill={b} onSave={saveBillAmountFromRow} />
                        <label className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                          <span className="text-[var(--dim)]">Category</span>
                          <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-xs font-medium text-[var(--accent)]">
                            {b.category}
                          </span>
                          <select
                            aria-label={`Change category for ${b.name}`}
                            className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm text-[var(--text)]"
                            value={billCategoryOptions.includes(b.category) ? b.category : ""}
                            onChange={(e) => {
                              const v = e.target.value;
                              if (v) setMonthlyCategory.mutate({ id: b.id, category: v });
                            }}
                          >
                            {!billCategoryOptions.includes(b.category) && (
                              <option value="">{b.category}</option>
                            )}
                            {billCategoryOptions.map((c) => (
                              <option key={c} value={c}>{c}</option>
                            ))}
                          </select>
                          <span className="text-xs text-[var(--dim)]">Type a custom category in Edit. Category and the check below apply to every month, past and present — changing one regroups past months and past floor totals. Amounts never change.</span>
                        </label>
                        <label className="mt-2 flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            aria-label={`Keep the lights on for ${b.name}`}
                            checked={b.keepLightsOn}
                            onChange={(e) =>
                              setMonthlyKeepLightsOn.mutate({ id: b.id, keepLightsOn: e.target.checked })
                            }
                          />
                          <span>
                            <strong>Keep the lights on</strong>
                            <span className="text-[var(--dim)]"> — essential, must-pay</span>
                          </span>
                        </label>
                        {b.effectiveFrom == null && b.history.length > 0 && (
                          <p className="mt-1 text-xs text-[var(--dim)]">
                            Starts {monthLabel(b.history[b.history.length - 1]?.effectiveFrom ?? month)} at{" "}
                            {fmt(b.history[b.history.length - 1]?.amountCents ?? 0)}/mo — not counted in {monthLabel(month)}.
                          </p>
                        )}
                        {b.history.length > 0 && (
                          <div className="mt-2">
                            <p className="text-xs font-medium text-[var(--dim)]">Amount history</p>
                            <ul className="tnum mt-0.5 space-y-1 text-xs text-[var(--dim)]">
                              {b.history.map((h) => (
                                <li key={h.id} className="flex flex-wrap items-center gap-2">
                                  <span>
                                    {fmt(h.amountCents)}/mo from {monthLabel(h.effectiveFrom)}
                                    {h.effectiveFrom === b.effectiveFrom && (
                                      <span className="text-[var(--accent)]"> · in effect for {monthLabel(month)}</span>
                                    )}
                                  </span>
                                  {b.history.length <= 1 ? (
                                    <span className="text-[var(--dim)]">(only entry — delete the bill to remove it)</span>
                                  ) : confirmMonthlyVersionId === h.id ? (
                                    <span className="flex items-center gap-1">
                                      <span>Remove this entry?</span>
                                      <button
                                        type="button"
                                        aria-label={`Confirm remove history entry ${fmt(h.amountCents)} per month from ${monthLabel(h.effectiveFrom)} for ${b.name}`}
                                        className="rounded border border-[var(--bad)] px-1.5 py-0.5 font-medium text-[var(--bad)]"
                                        disabled={deleteMonthlyVersion.isPending}
                                        onClick={() => deleteMonthlyVersion.mutate(h.id)}
                                      >
                                        Remove
                                      </button>
                                      <button
                                        type="button"
                                        aria-label={`Cancel remove history entry for ${b.name}`}
                                        className="rounded border border-[var(--border)] px-1.5 py-0.5"
                                        onClick={() => setConfirmMonthlyVersionId(null)}
                                      >
                                        Cancel
                                      </button>
                                    </span>
                                  ) : (
                                    <button
                                      type="button"
                                      aria-label={`Remove history entry ${fmt(h.amountCents)} per month from ${monthLabel(h.effectiveFrom)} for ${b.name}`}
                                      className="px-1 py-0.5 font-medium text-[var(--bad)]"
                                      onClick={() => {
                                        setVersionDeleteError("");
                                        setConfirmMonthlyVersionId(h.id);
                                      }}
                                    >
                                      ✕ Remove
                                    </button>
                                  )}
                                </li>
                              ))}
                            </ul>
                            {versionDeleteError && confirmMonthlyVersionId === null && (
                              <p className="mt-1 text-xs text-[var(--bad)]">{versionDeleteError}</p>
                            )}
                          </div>
                        )}
                          </div>
                        )}
                      </li>
                      );
                    })}
                  </ul>
                  <dl className="tnum mt-3 space-y-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 text-base">
                    <div className="flex justify-between gap-3 font-semibold">
                      <dt>Monthly bills total — {monthLabel(month)}</dt>
                      <dd>{fmt(data.monthlyBillsTotalCents)}/mo</dd>
                    </div>
                    <p className="text-sm font-normal text-[var(--dim)]">
                      Already included in cash out — not added again.
                    </p>
                    <div className="flex justify-between gap-3 border-t border-[var(--border)] pt-2">
                      <dt>
                        {monthLabel(month)} cash out
                        {data.isItemsMonth
                          ? " (from items)"
                          : data.isSummaryMonth
                            ? " (entered total)"
                            : ""}
                      </dt>
                      <dd>{fmt(data.cashOutCents)}</dd>
                    </div>
                    <div className="flex justify-between gap-3 text-[var(--dim)]">
                      <dt>− Monthly bills (already included)</dt>
                      <dd>{fmt(data.monthlyBillsTotalCents)}</dd>
                    </div>
                    <div className="flex justify-between gap-3 border-t border-[var(--border)] pt-2 font-semibold">
                      <dt>= Left after monthly bills</dt>
                      <dd>{fmt(data.remainingOutflowCents)}</dd>
                    </div>
                    <p className="text-sm font-normal text-[var(--dim)]">
                      Cash out minus the monthly bills above — only those
                      two. The yearly &amp; periodic bills paid this month
                      are <em>not</em> subtracted here. Everything else in
                      Quick view subtracts those as well (cash out −
                      monthly bills − yearly &amp; periodic bills paid),
                      which is why the two figures differ.
                    </p>
                  </dl>
                </div>
              )}
            </section>

            {/* transactions */}
            <section id="section-transactions" aria-label="Transactions" className={`mt-6 scroll-mt-4 rounded-[var(--radius)]${highlightCls("section-transactions")}`}>
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                {/* Same header pattern as Monthly bills: bold title,
                    then the ⓘ, then the quick summary — here the
                    month's cash out, the same figure the Monthly
                    bills footer reconciles against — and the fold
                    toggle alone at the far right. The tip sits near
                    the left edge now, so its bubble opens
                    left-aligned (align="start"). */}
                <h2 className="display flex min-w-0 flex-wrap items-center gap-x-2 text-xl font-semibold">
                  Transactions — {monthLabel(month)}
                  <ExplainerInfoTip id="spending.transactions" label="Transactions" align="start">
                    <p>
                      Transactions are records of money that actually left an account — typed in by hand or imported from a file.
                    </p>
                    <p>
                      Their main job is yearly and periodic bills. True cost spreads those bills evenly across the year, so each month carries a smooth monthly share instead of one big lump. When a bill is actually paid, the transaction is the record of that payout, and True cost uses it to swap the real payment out and keep the smooth share in — no lump, and no double count. Example: Property Tax is $4,422.12 paid in October; its smooth share is $737.02 a month.
                    </p>
                    <p>
                      If a month has a cash-out items list, the items are that month's Cash out total and transactions are not added on top. If a month has no items and no typed-in total, Cash out is counted from its transactions instead.
                    </p>
                  </ExplainerInfoTip>
                  <span className="tnum text-base font-normal text-[var(--dim)]">
                    {fmt(data.cashOutCents)}
                  </span>
                </h2>
                <div className="ml-auto flex shrink-0 flex-nowrap items-center gap-2">
                  <BillsFoldChevron
                    open={transactionsOpen}
                    controlsId="transactions-body"
                    onToggle={() => setTransactionsFolded(transactionsOpen)}
                    showLabel="Show transactions"
                    hideLabel="Hide transactions"
                  />
                </div>
              </div>

              {transactionsOpen && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button type="button" className={btnGhost} onClick={() => setShowImport(!showImport)} aria-expanded={showImport}>
                    Import
                  </button>
                  <button type="button" className={btnAdd} onClick={() => openNewTxn()}>
                    + Add
                  </button>
                </div>
              )}

              {showImport && (
                <ImportPanel
                  month={month}
                  onDone={(n) => {
                    invalidate();
                    setActionMsg(`Imported ${n} transaction${n === 1 ? "" : "s"}.`);
                  }}
                  onCashOutSaved={(m) => {
                    invalidate();
                    setActionMsg(`Cash out for ${monthLabel(m)} saved from the checking export.`);
                  }}
                />
              )}

              {showTxnForm && (
                <form onSubmit={submitTxn} className="mt-3 space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
                  <h3 className="display text-lg font-semibold">
                    {editingTxnId ? "Edit transaction" : "Add transaction"}
                  </h3>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="t-date" className={labelCls}>Date recorded</label>
                      <input id="t-date" type="date" required className={inputCls} value={tDate} onChange={(e) => setTDate(e.target.value)} />
                    </div>
                    <div>
                      <label htmlFor="t-amount" className={labelCls}>Amount ($)</label>
                      <input id="t-amount" type="text" inputMode="decimal" required placeholder="0.00" className={inputCls} value={tDollars} onChange={(e) => setTDollars(e.target.value)} />
                    </div>
                  </div>
                  <div>
                    <label htmlFor="t-desc" className={labelCls}>Description</label>
                    <input id="t-desc" type="text" required className={inputCls} value={tDesc} onChange={(e) => setTDesc(e.target.value)} />
                  </div>
                  <div>
                    <label htmlFor="t-kind" className={labelCls}>What kind is it?</label>
                    <select id="t-kind" className={inputCls} value={tKind} onChange={(e) => setTKind(e.target.value as typeof tKind)}>
                      <option value="spending">Spending (bill from checking, or a card charge)</option>
                      <option value="card_payment">Checking paying a credit card bill (cash out only)</option>
                      <option value="transfer">Transfer / savings (cash out only, not spending)</option>
                    </select>
                  </div>
                  {tKind === "spending" && (
                    <>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label htmlFor="t-source" className={labelCls}>Paid from</label>
                          <select id="t-source" className={inputCls} value={tSource} onChange={(e) => setTSource(e.target.value as "checking" | "card")}>
                            <option value="checking">Checking</option>
                            <option value="card">Credit card</option>
                          </select>
                        </div>
                        <div>
                          <label htmlFor="t-account" className={labelCls}>Account name</label>
                          <input id="t-account" type="text" className={inputCls} value={tAccount} onChange={(e) => setTAccount(e.target.value)} list="account-names" />
                          <datalist id="account-names">
                            {data.accountNames.map((a) => (
                              <option key={a} value={a} />
                            ))}
                          </datalist>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label htmlFor="t-category" className={labelCls}>Category</label>
                          <select id="t-category" className={inputCls} value={tCategory} onChange={(e) => setTCategory(e.target.value)}>
                            {CATEGORIES.map((c) => (
                              <option key={c} value={c}>{c}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label htmlFor="t-yearly" className={labelCls}>Smoothed bill (if it is one)</label>
                          <select id="t-yearly" className={inputCls} value={tYearlyId} onChange={(e) => setTYearlyId(e.target.value)}>
                            <option value="">Not a smoothed bill</option>
                            {data.yearly.map((y) => (
                              <option key={y.id} value={y.id}>{y.name}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <label className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={tRefund} onChange={(e) => setTRefund(e.target.checked)} />
                        This is a refund / credit (money back — subtracts from spending)
                      </label>
                    </>
                  )}
                  {formError && <p className="text-sm text-[var(--bad)]">{formError}</p>}
                  <div className="flex gap-2">
                    <button type="submit" className={btnPrimary} disabled={addTxn.isPending || updateTxn.isPending}>
                      {editingTxnId ? "Save changes" : "Add transaction"}
                    </button>
                    <button type="button" className={btnGhost} onClick={resetTxnForm}>
                      Cancel
                    </button>
                  </div>
                </form>
              )}

              {transactionsOpen && (
                <div id="transactions-body">
              {smoothedOnly && (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--accent-soft)] px-3 py-2 text-sm">
                  <p>
                    Showing transactions marked as a smoothed bill in{" "}
                    {monthLabel(month)} — recorded in this month, in the
                    month the charge or payment was recorded —{" "}
                    {visibleMonthTransactions.length} of{" "}
                    {data.monthTransactions.length} transaction
                    {data.monthTransactions.length === 1 ? "" : "s"}. The
                    Smoothed bills paid figure itself counts net
                    settlements in the settlement month; its breakdown
                    sits under the
                    Smoothed spend breakdown above.
                  </p>
                  <button
                    type="button"
                    aria-label="Show all transactions"
                    className="shrink-0 font-medium whitespace-nowrap underline underline-offset-2"
                    onClick={() => setSmoothedOnly(false)}
                  >
                    Show all
                  </button>
                </div>
              )}
              {smoothedOnly && visibleMonthTransactions.length === 0 && (
                <p className="mt-3 rounded-[var(--radius)] border border-dashed border-[var(--border)] p-4 text-sm text-[var(--dim)]">
                  No transactions for {monthLabel(month)} are marked as a
                  smoothed-bill payment.
                </p>
              )}
              {data.monthTransactions.length === 0 && !showTxnForm && !smoothedOnly && (
                <p className="mt-3 rounded-[var(--radius)] border border-dashed border-[var(--border)] p-4 text-sm text-[var(--dim)]">
                  {data.isItemsMonth
                    ? `No individual transactions for ${monthLabel(month)} — this month is covered by its cash-out items above, so none are needed.`
                    : data.isSummaryMonth
                      ? `No individual transactions for ${monthLabel(month)} — this month is covered by the cash-out total you entered above, so none are needed.`
                      : `Nothing recorded for ${monthLabel(month)} yet. Add a transaction, import a CSV from your bank or card, or enter one cash-out total for the month above.`}
                </p>
              )}
              <ul className="mt-3 divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] empty:hidden">
                {visibleMonthTransactions.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2">
                    <span className="min-w-0 text-base font-medium">{t.description}</span>
                    <span className="text-xs whitespace-nowrap text-[var(--dim)]">
                      {t.date.slice(5)} · {t.accountName} · {t.category}
                      {t.kind === "card_payment" && " · Card payment — cash out only"}
                      {t.kind === "transfer" && " · Transfer — not spending"}
                      {t.yearlyExpenseId != null &&
                        ` · Smoothed bill: ${yearlyNameById.get(t.yearlyExpenseId) ?? ""}`}
                      {t.amountCents < 0 && t.kind === "spending" && " · Refund / credit"}
                    </span>
                    <span className="ml-auto flex shrink-0 items-center gap-1">
                      <span className={`tnum text-base font-medium ${t.kind !== "spending" ? "text-[var(--dim)]" : ""}`}>
                        {fmt(t.amountCents)}
                      </span>
                      <button type="button" aria-label={`Edit ${t.description}`} className="px-1 py-1 text-sm text-[var(--accent)]" onClick={() => openEditTxn(t)}>
                        Edit
                      </button>
                      {confirmDeleteTxnId !== t.id && (
                        <button type="button" aria-label={`Delete ${t.description}`} className="px-1 py-1 text-sm text-[var(--bad)]" onClick={() => setConfirmDeleteTxnId(t.id)}>
                          ✕
                        </button>
                      )}
                    </span>
                    {confirmDeleteTxnId === t.id && (
                      <span className="flex w-full flex-wrap items-center gap-2">
                        <span className="text-sm text-[var(--bad)]">
                          Delete {t.description}?
                        </span>
                        <button
                          type="button"
                          aria-label={`Confirm delete ${t.description}`}
                          className="rounded border border-[var(--bad)] px-2 py-1 text-sm font-medium text-[var(--bad)]"
                          disabled={deleteTxn.isPending}
                          onClick={() => {
                            deleteTxn.mutate(t.id);
                            setConfirmDeleteTxnId(null);
                          }}
                        >
                          Delete
                        </button>
                        <button
                          type="button"
                          aria-label={`Cancel delete ${t.description}`}
                          className="rounded border border-[var(--border)] px-2 py-1 text-sm"
                          onClick={() => setConfirmDeleteTxnId(null)}
                        >
                          Cancel
                        </button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
                </div>
              )}
            </section>

            {/* yearly & periodic (smoothed) bills */}
            <section id="section-yearly-expenses" aria-label="Yearly & periodic expenses" className={`mt-8 scroll-mt-4 rounded-[var(--radius)]${highlightCls("section-yearly-expenses")}`}>
              {/* Header follows the settled single-row pattern (same as
                  Monthly bills above): title, then the ⓘ, then the
                  summary on the left; the fold toggle alone at the far
                  right. The row never wraps — the long summary wraps
                  within the left side instead, so the toggle stays on
                  the title row at every width. */}
              <div className="flex flex-nowrap items-center justify-between gap-x-3">
                <h2 className="display flex min-w-0 flex-1 flex-wrap items-center gap-x-2 text-xl font-semibold">
                  Yearly &amp; periodic expenses
                  {/* No summary sentence on the face: the key figures
                      live in the header summary beside the tip, and the
                      spread-evenly method plus the future-bill $0 rule
                      live in the info tooltip, whose full text is the
                      former "More" text, verbatim. The tip sits near
                      the left edge now, so its bubble opens
                      left-aligned (align="start"). */}
                  <ExplainerInfoTip id="spending.yearlyPeriodic" label="Yearly & periodic expenses" align="start">
                    <p>
                      Bills that don't land monthly, spread evenly so they don't
                      ambush one month. The bills in effect for{" "}
                      {monthLabel(month)} total {fmt(data.totalAnnualCents)} a
                      year → set aside {fmt(data.accrualCents)} a month for{" "}
                      {monthLabel(month)} — the sum of each in-effect bill's
                      monthly amount, each rounded per bill so the year's
                      twelve set-asides sum to the bill's annual amount
                      exactly, and it matches the
                      set-asides on the bill cards below exactly. When a bill is paid, record
                      it here so the actual can be checked against what you
                      expected. Amounts below are the ones in effect for{" "}
                      {monthLabel(month)}; when a bill's price or frequency
                      changes, the new version applies from that month on and
                      earlier months keep their old set-aside. A bill whose
                      start month is in the future counts $0 in earlier months.
                      Payments already recorded never change.
                    </p>
                  </ExplainerInfoTip>
                  {/* inline-block: a line-break opportunity before the
                      summary (and wrapping inside it), so at narrow
                      widths the summary wraps within the left side
                      instead of running underneath the toggle. On one
                      line it renders exactly as the inline span did. */}
                  <span className="tnum inline-block text-base font-normal text-[var(--dim)]">
                    {fmt(data.totalAnnualCents)}/yr · set aside {fmt(data.accrualCents)}/mo
                  </span>
                </h2>
                <div className="ml-auto flex shrink-0 flex-nowrap items-center gap-2">
                  <BillsFoldChevron
                    open={yearlyBillsOpen}
                    controlsId="yearly-bills-roster"
                    onToggle={() => setYearlyBillsOpen(!yearlyBillsOpen)}
                  />
                </div>
              </div>

              {yearlyBillsOpen && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className={btnAdd}
                    onClick={() => {
                      resetYearlyForm();
                      setShowYearlyForm(true);
                    }}
                  >
                    + Add smoothed bill
                  </button>
                </div>
              )}

              {showYearlyForm && (
                <form onSubmit={submitYearly} className="mt-3 space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
                  <h3 className="display text-lg font-semibold">
                    {editingYearlyId ? "Edit smoothed bill" : "Add smoothed bill"}
                  </h3>
                  <div>
                    <label htmlFor="y-name" className={labelCls}>Name</label>
                    <input id="y-name" type="text" required className={inputCls} value={yName} onChange={(e) => setYName(e.target.value)} placeholder="e.g. Home insurance, or Water" />
                  </div>
                  <div>
                    <label htmlFor="y-frequency" className={labelCls}>How often is it billed?</label>
                    <select id="y-frequency" className={inputCls} value={yFrequency} onChange={(e) => setYFrequency(e.target.value as Frequency)}>
                      <option value="yearly">Yearly — once a year</option>
                      <option value="semiannual">Every 6 months — twice a year</option>
                      <option value="quarterly">Every 3 months — four times a year</option>
                      <option value="bimonthly">Every other month — every 2 months</option>
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="y-amount" className={labelCls}>
                        {yFrequency !== "yearly" ? "Expected per bill ($)" : "Expected per year ($)"}
                      </label>
                      <input id="y-amount" type="text" inputMode="decimal" required placeholder="0.00" className={inputCls} value={yDollars} onChange={(e) => setYDollars(e.target.value)} />
                    </div>
                    <div>
                      <label htmlFor="y-due" className={labelCls}>
                        {yFrequency !== "yearly" ? "First / next due month" : "Due month"}
                      </label>
                      <select id="y-due" className={inputCls} value={yDueMonth} onChange={(e) => setYDueMonth(e.target.value)}>
                        <option value="">Not sure</option>
                        {MONTH_NAMES.map((n, i) => (
                          <option key={n} value={i + 1}>{n}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {yFrequency !== "yearly" && (
                    <p className="text-sm leading-relaxed text-[var(--dim)]">
                      {(() => {
                        const cents = parseDollars(yDollars);
                        const anchor = yDueMonth ? Number(yDueMonth) : null;
                        const ppy = paymentsPerYearFor(yFrequency);
                        const step = 12 / ppy;
                        const dues =
                          anchor != null
                            ? MONTH_NAMES.filter((_, i) => (i + 1 - anchor) % step === 0)
                            : [];
                        return (
                          <>
                            {cents != null && cents >= 0 ? (
                              <>
                                That's {fmt(cents * ppy)} a year (per bill × {ppy}) —{" "}
                                {fmt(cumulativeMonthlyCents(cents * ppy, yEffectiveFrom || currentMonth()))} a month set aside.{" "}
                              </>
                            ) : (
                              <>Enter the amount of one typical bill. </>
                            )}
                            {anchor != null
                              ? `Due ${freqPhrase(yFrequency)} from ${MONTH_NAMES[anchor - 1] ?? ""}: ${dues.join(", ")}. Record each payment as it happens — each one is subtracted in its month, and the set-aside keeps every month at its monthly share.`
                              : `Pick a due month and the app works out the due months ${freqPhrase(yFrequency)} from there.`}
                          </>
                        );
                      })()}
                    </p>
                  )}
                  <div>
                    <label htmlFor="y-from" className={labelCls}>
                      {editingYearlyId ? "Amount & frequency take effect from" : "Starts from"}
                    </label>
                    <input id="y-from" type="month" required className={inputCls} value={yEffectiveFrom} onChange={(e) => setYEffectiveFrom(e.target.value)} />
                    <p className="mt-1 text-sm text-[var(--dim)]">
                      {editingYearlyId
                        ? "The new amount applies from that month onward — earlier months keep the amount and frequency that were in effect then, so past smoothed totals and the reserve don't change. It defaults to this month; choose an earlier month only to deliberately correct that month onward."
                        : "The first month this bill's set-aside applies from."}
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="y-paidtype" className={labelCls}>Usually paid by</label>
                      <select id="y-paidtype" className={inputCls} value={yPaidType} onChange={(e) => setYPaidType(e.target.value as "checking" | "card")}>
                        <option value="checking">Checking</option>
                        <option value="card">Credit card</option>
                      </select>
                    </div>
                    <div>
                      <label htmlFor="y-paidname" className={labelCls}>Account name</label>
                      <input id="y-paidname" type="text" className={inputCls} value={yPaidName} onChange={(e) => setYPaidName(e.target.value)} list="account-names" />
                    </div>
                  </div>
                  <div>
                    <label htmlFor="y-category" className={labelCls}>Category</label>
                    <CategoryField id="y-category" value={yCategory} options={billCategoryOptions} onChange={setYCategory} />
                    <p className="mt-1 text-sm text-[var(--dim)]">
                      One label per bill — what the bill is for. Its set-aside
                      shows under that category in the By category breakdown
                      above. Categories apply to every month, past and
                      present — changing one regroups past months. Amounts
                      never change.
                    </p>
                  </div>
                  <label className="flex items-start gap-2 text-sm text-[var(--text)]">
                    <input id="y-keep-lights-on" type="checkbox" className="mt-0.5" checked={yKeepLightsOn} onChange={(e) => setYKeepLightsOn(e.target.checked)} />
                    <span>
                      <strong>Keep the lights on</strong> — this is an essential,
                      must-pay bill. Separate from the category: a bill can be
                      Taxes <em>and</em> keep-the-lights-on. Checked bills' monthly
                      set-asides add up to your essential floor. A label
                      only — it never changes any amount. The check applies
                      to every month, past and present — changing it changes
                      past floor totals too.
                    </span>
                  </label>
                  {yearlyError && <p className="text-sm text-[var(--bad)]">{yearlyError}</p>}
                  <div className="flex gap-2">
                    <button type="submit" className={btnPrimary} disabled={addYearly.isPending || updateYearly.isPending}>
                      {editingYearlyId ? "Save changes" : "Add smoothed bill"}
                    </button>
                    <button type="button" className={btnGhost} onClick={resetYearlyForm}>
                      Cancel
                    </button>
                  </div>
                </form>
              )}

              {data.yearly.length === 0 && !showYearlyForm && (
                <p className="mt-3 rounded-[var(--radius)] border border-dashed border-[var(--border)] p-4 text-sm text-[var(--dim)]">
                  No smoothed bills yet. Add the big once-a-year ones — home
                  and car insurance, property tax, memberships — twice-a-year
                  ones, every-3-months ones like garbage, and
                  every-other-month ones like water, so they get
                  spread evenly instead of ambushing one month.
                </p>
              )}
              {yearlyBillsOpen && (
                <div id="yearly-bills-roster">
                  {/* The fold's top row: "Adjust reserve starting point"
                      on the left (it acts on this roster's reserve) and
                      "Expand all" on the right — it expands the
                      individual bill cards, so it only means anything
                      while the roster is open. When the reserve form is
                      open it takes the full row (basis-full) and
                      Expand all wraps beneath it. */}
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <ReserveSettings data={data} onSaved={invalidate} />
                    {data.yearly.length > 0 && (
                      <button
                        type="button"
                        className={`${btnGhost} ml-auto`}
                        aria-expanded={!yearlyBillsCollapsedAll}
                        aria-controls="yearly-bills-list"
                        onClick={() =>
                          handleYearlyBillsCollapsedAllChange(!yearlyBillsCollapsedAll)
                        }
                      >
                        {yearlyBillsCollapsedAll ? "Expand all" : "Collapse all"}
                      </button>
                    )}
                  </div>
                  {data.yearly.length > 0 && (
                  <ul id="yearly-bills-list" className="mt-3 divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
                    {data.yearly.map((y) => (
                  <li key={y.id} className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="text-base font-semibold">{y.name}</span>
                        {y.inEffectForMonth === false ? (
                          <span className="tnum text-sm text-[var(--dim)]">
                            {(() => {
                              // Pre-start preview (build v63, F3):
                              // every figure comes from the version
                              // in force at the START month — the
                              // earliest version (history is newest
                              // first, so it is the last entry): its
                              // amount, its frequency, its start. The
                              // previous pairing (the LATEST version's
                              // amount with the EARLIEST version's
                              // start, and a monthly figure mixing
                              // the two) could show an amount the bill
                              // never has at its start beside that
                              // start date. When a later version
                              // changes the amount or frequency, the
                              // change is named as a note instead.
                              const startVersion = y.history[y.history.length - 1];
                              const startExpected = startVersion?.expectedCents ?? y.latestExpectedCents;
                              const startFrequency = startVersion?.frequency ?? y.latestFrequency;
                              const startAnnual = startVersion?.annualCents ?? startExpected * paymentsPerYearFor(startFrequency);
                              const startMonthly = startVersion?.monthlyAccrualCents ?? cumulativeMonthlyCents(startAnnual, startVersion?.effectiveFrom ?? currentMonth());
                              // The first later version (chronologically)
                              // whose amount or frequency differs from
                              // the start version's.
                              const laterChange = y.history
                                .filter(
                                  (h) =>
                                    h !== startVersion &&
                                    (h.expectedCents !== startExpected || h.frequency !== startFrequency),
                                )
                                .sort((a, b) =>
                                  a.effectiveFrom === b.effectiveFrom
                                    ? a.id - b.id
                                    : a.effectiveFrom < b.effectiveFrom
                                      ? -1
                                      : 1,
                                )[0];
                              return (
                                <>
                                  {startFrequency !== "yearly"
                                    ? `${fmt(startExpected)}/bill · ${freqPhrase(startFrequency)} · ${fmt(startAnnual)}/yr · ${fmt(startMonthly)}/mo set aside`
                                    : `${fmt(startExpected)}/yr · ${fmt(startMonthly)}/mo set aside`}
                                  {startVersion ? ` · starts ${monthLabel(startVersion.effectiveFrom)}` : ""}
                                  {laterChange
                                    ? ` · changes to ${
                                        laterChange.frequency !== "yearly"
                                          ? `${fmt(laterChange.expectedCents)}/bill · ${freqPhrase(laterChange.frequency)} · ${fmt(laterChange.annualCents)}/yr`
                                          : `${fmt(laterChange.expectedCents)}/yr`
                                      } from ${monthLabel(laterChange.effectiveFrom)}`
                                    : ""}
                                  {" · paid by "}
                                  {y.paidByName}
                                  {" — not yet in effect for "}
                                  {monthLabel(month)}
                                  {", counts $0 this month"}
                                </>
                              );
                            })()}
                          </span>
                        ) : y.frequency !== "yearly" ? (
                          <span className="tnum text-sm text-[var(--dim)]">
                            {fmt(y.expectedCents)}/bill · {freqPhrase(y.frequency)} ·{" "}
                            {fmt(y.annualCents)}/yr · {fmt(y.monthlyAccrualCents)}/mo set aside
                            {y.dueMonths.length > 0
                              ? ` · due ${y.dueMonths.map((m) => MONTH_SHORT[m - 1] ?? "").join(", ")}`
                              : ""}
                            {" · paid by "}
                            {y.paidByName}
                          </span>
                        ) : (
                          <span className="tnum text-sm text-[var(--dim)]">
                            {fmt(y.expectedCents)}/yr · {fmt(y.monthlyAccrualCents)}/mo
                            {y.dueMonth ? ` · due ${MONTH_NAMES[y.dueMonth - 1] ?? ""}` : ""}
                            {" · paid by "}
                            {y.paidByName}
                          </span>
                        )}
                      </div>
                      {!yearlyBillsCollapsedAll && (
                        <div className="ml-auto flex shrink-0 gap-1">
                          <button type="button" aria-label={`Edit ${y.name}`} className="px-1 py-1 text-sm text-[var(--accent)]" onClick={() => openEditYearly(y)}>
                            Edit
                          </button>
                          {confirmDeleteYearlyId !== y.id && (
                            <button type="button" aria-label={`Delete ${y.name}`} className="px-1 py-1 text-sm text-[var(--bad)]" onClick={() => setConfirmDeleteYearlyId(y.id)}>
                              ✕
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                    {!yearlyBillsCollapsedAll && (
                      <>
                    {confirmDeleteYearlyId === y.id && (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className="text-sm text-[var(--bad)]">
                          Delete {y.name}? This removes the expense and its amount history.
                        </span>
                        <button
                          type="button"
                          aria-label={`Confirm delete ${y.name}`}
                          className="rounded border border-[var(--bad)] px-2 py-1 text-sm font-medium text-[var(--bad)]"
                          disabled={deleteYearly.isPending}
                          onClick={() => {
                            deleteYearly.mutate(y.id);
                            setConfirmDeleteYearlyId(null);
                          }}
                        >
                          Delete
                        </button>
                        <button
                          type="button"
                          aria-label={`Cancel delete ${y.name}`}
                          className="rounded border border-[var(--border)] px-2 py-1 text-sm"
                          onClick={() => setConfirmDeleteYearlyId(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                    <label className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                      <span className="text-[var(--dim)]">Category</span>
                      <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-xs font-medium text-[var(--accent)]">
                        {y.category}
                      </span>
                      <select
                        aria-label={`Change category for ${y.name}`}
                        className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm text-[var(--text)]"
                        value={billCategoryOptions.includes(y.category) ? y.category : ""}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v) setYearlyCategory.mutate({ id: y.id, category: v });
                        }}
                      >
                        {!billCategoryOptions.includes(y.category) && (
                          <option value="">{y.category}</option>
                        )}
                        {billCategoryOptions.map((c) => (
                          <option key={c} value={c}>{c}</option>
                        ))}
                      </select>
                      <span className="text-xs text-[var(--dim)]">Type a custom category in Edit. Category and the check below apply to every month, past and present — changing one regroups past months and past floor totals. Amounts never change.</span>
                    </label>
                    <label className="mt-2 flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        aria-label={`Keep the lights on for ${y.name}`}
                        checked={y.keepLightsOn}
                        onChange={(e) =>
                          setYearlyKeepLightsOn.mutate({ id: y.id, keepLightsOn: e.target.checked })
                        }
                      />
                      <span>
                        <strong>Keep the lights on</strong>
                        <span className="text-[var(--dim)]"> — essential, must-pay</span>
                      </span>
                    </label>
                    {y.status === "differs" && (
                      <p className="mt-2 rounded-[var(--radius)] bg-[var(--warn-soft)] px-3 py-2 text-sm">
                        Actual this year: {fmt(y.actualThisYearCents)}
                        {y.frequency !== "yearly" && y.actualCountThisYear > 0
                          ? ` across ${y.actualCountThisYear} payment${y.actualCountThisYear === 1 ? "" : "s"}`
                          : ""}{" "}
                        — that differs from the expected{" "}
                        {fmt(y.expectedToDateCents)}
                        {y.frequency !== "yearly"
                          ? y.duePaymentsToDate >= y.paymentsPerYear
                            ? ` a year (${fmt(y.expectedCents)} per bill × ${y.paymentsPerYear})`
                            : ` due so far this year (${fmt(y.expectedCents)} per bill × ${y.duePaymentsToDate} due)`
                          : " a year"}
                        . If the new price is here to stay, edit the
                        expected amount so the set-aside stays honest. If
                        only part of a due bill has been paid so far, that
                        also explains the gap — it settles once the rest
                        is recorded, and the expected amount doesn't need
                        changing.
                      </p>
                    )}
                    {y.status === "ok" && y.actualThisYearCents !== 0 && (
                      <p className="mt-2 text-sm text-[var(--dim)]">
                        Paid this year: {fmt(y.actualThisYearCents)}
                        {y.frequency !== "yearly" && y.actualCountThisYear > 1
                          ? ` across ${y.actualCountThisYear} payments`
                          : ""}
                        {y.lastActualDate ? ` (last on ${y.lastActualDate})` : ""} — in line with expected.
                      </p>
                    )}
                    {y.status === "overdue" && (
                      <p className="mt-2 text-sm text-[var(--warn)]">
                        {y.frequency !== "yearly"
                          ? y.actualThisYearCents === 0
                            ? "A due month has passed — no payment recorded yet this year."
                            : "A due month has passed — no payment recorded for that due month yet."
                          : `Due in ${MONTH_NAMES[(y.dueMonth ?? 1) - 1] ?? ""} — no payment recorded yet this year.`}
                      </p>
                    )}
                    {y.status === "not-started" && (
                      <p className="mt-2 text-sm text-[var(--dim)]">
                        Not counted in {monthLabel(month)} — this bill starts{" "}
                        {y.history.length > 0
                          ? monthLabel(y.history[y.history.length - 1]?.effectiveFrom ?? month)
                          : monthLabel(month)}
                        . Earlier months are unchanged by adding it.
                      </p>
                    )}
                    {y.status === "upcoming" && (
                      <p className="mt-2 text-sm text-[var(--dim)]">
                        {y.frequency !== "yearly"
                          ? `Next due ${MONTH_NAMES[(y.dueMonths.find((m) => m >= Number(month.slice(5, 7))) ?? y.dueMonths[0] ?? 1) - 1] ?? ""} — nothing recorded yet this year.`
                          : `Due ${MONTH_NAMES[(y.dueMonth ?? 1) - 1] ?? ""} — nothing recorded yet this year.`}
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                      <label className="flex items-center gap-1">
                        <span className="text-[var(--dim)]">
                          {y.frequency !== "yearly" ? "First / next due month" : "Due month"}
                        </span>
                        <select
                          aria-label={`Due month for ${y.name}`}
                          className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm text-[var(--text)]"
                          value={y.dueMonth ? String(y.dueMonth) : ""}
                          onChange={(e) => {
                            const v = e.target.value;
                            setDueMonth.mutate({ id: y.id, dueMonth: v ? Number(v) : null });
                          }}
                        >
                          <option value="">Not set</option>
                          {MONTH_NAMES.map((n, i) => (
                            <option key={n} value={i + 1}>{n}</option>
                          ))}
                        </select>
                      </label>
                      {!y.dueMonth && (
                        <span className="text-xs text-[var(--dim)]">Not in the forecast until a due month is set.</span>
                      )}
                    </div>
                    {y.history.length > 0 && (
                      <div className="mt-2">
                        <p className="text-xs font-medium text-[var(--dim)]">Amount history</p>
                        <ul className="tnum mt-0.5 space-y-1 text-xs text-[var(--dim)]">
                          {y.history.map((h) => (
                            <li key={h.id} className="flex flex-wrap items-center gap-2">
                              <span>
                                {h.frequency !== "yearly"
                                  ? `${fmt(h.expectedCents)}/bill · ${freqPhrase(h.frequency)} · ${fmt(h.annualCents)}/yr · ${fmt(h.monthlyAccrualCents)}/mo`
                                  : `${fmt(h.expectedCents)}/yr · ${fmt(h.monthlyAccrualCents)}/mo`}{" "}
                                from {monthLabel(h.effectiveFrom)}
                                {h.effectiveFrom === y.effectiveFrom && (
                                  <span className="text-[var(--accent)]"> · in effect for {monthLabel(month)}</span>
                                )}
                              </span>
                              {y.history.length <= 1 ? (
                                <span className="text-[var(--dim)]">(only entry — delete the bill to remove it)</span>
                              ) : confirmYearlyVersionId === h.id ? (
                                <span className="flex items-center gap-1">
                                  <span>Remove this entry?</span>
                                  <button
                                    type="button"
                                    aria-label={`Confirm remove history entry from ${monthLabel(h.effectiveFrom)} for ${y.name}`}
                                    className="rounded border border-[var(--bad)] px-1.5 py-0.5 font-medium text-[var(--bad)]"
                                    disabled={deleteYearlyVersion.isPending}
                                    onClick={() => deleteYearlyVersion.mutate(h.id)}
                                  >
                                    Remove
                                  </button>
                                  <button
                                    type="button"
                                    aria-label={`Cancel remove history entry for ${y.name}`}
                                    className="rounded border border-[var(--border)] px-1.5 py-0.5"
                                    onClick={() => setConfirmYearlyVersionId(null)}
                                  >
                                    Cancel
                                  </button>
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  aria-label={`Remove history entry from ${monthLabel(h.effectiveFrom)} for ${y.name}`}
                                  className="px-1 py-0.5 font-medium text-[var(--bad)]"
                                  onClick={() => {
                                    setVersionDeleteError("");
                                    setConfirmYearlyVersionId(h.id);
                                  }}
                                >
                                  ✕ Remove
                                </button>
                              )}
                            </li>
                          ))}
                        </ul>
                        {versionDeleteError && confirmYearlyVersionId === null && (
                          <p className="mt-1 text-xs text-[var(--bad)]">{versionDeleteError}</p>
                        )}
                      </div>
                    )}
                    <button
                      type="button"
                      className="mt-2 text-sm font-medium text-[var(--accent)] underline"
                      aria-label={`Record a payment for ${y.name}`}
                      aria-expanded={recordingYearlyId === y.id}
                      onClick={() =>
                        setRecordingYearlyId(
                          recordingYearlyId === y.id ? null : y.id,
                        )
                      }
                    >
                      Record a payment
                    </button>
                    {recordingYearlyId === y.id && (
                      <InlinePaymentForm
                        bill={y}
                        viewedMonth={month}
                        onClose={() => setRecordingYearlyId(null)}
                        onSaved={invalidate}
                      />
                    )}
                      </>
                    )}
                  </li>
                    ))}
                  </ul>
                  )}
                </div>
              )}
            </section>

            {/* year in spending — the dissolved Year Summary view's
                spending block, below the monthly sections; it joins
                the sections' persisted collapsed-state system (its
                header carries the same circled +/− fold toggle as
                Monthly bills) and defaults to collapsed on first
                load. */}
            <YearInSpendingBlock
              collapsed={yearInSpendingCollapsedAll}
              onToggleCollapsed={() =>
                handleYearInSpendingCollapsedAllChange(!yearInSpendingCollapsedAll)
              }
            />

            {/* data management */}
            <section aria-label="Manage data" className="mt-10 border-t border-[var(--border)] pt-4">
              <h2 className="display text-lg font-semibold">Your data</h2>
              <Explainer
                id="spending.yourData"
                label="Your data"
                className="mt-1"
                summary="Everything here is entered by you — nothing is connected to a bank."
              >
                <p>
                  Everything here is entered by you — monthly cash-out totals,
                  monthly bills, yearly &amp; periodic bills, manual entries,
                  and CSV imports. Nothing is connected to a bank.
                </p>
              </Explainer>
              {!data.hasAnyData && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" className={btnGhost} disabled={seed.isPending} onClick={() => seed.mutate()}>
                    Load example data
                  </button>
                </div>
              )}
            </section>
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}

/* ---------------- reserve settings ---------------- */

function ReserveSettings({
  data,
  onSaved,
}: {
  data: Dash;
  onSaved: () => void;
}) {
  /* The settings fold's open/closed state persists in the
     generic fold store, so it comes back as the user left it. */
  const [open, setOpen] = usePersistedFold("spending.reserve");
  const [opening, setOpening] = useState("");
  const [start, setStart] = useState("");
  const [msg, setMsg] = useState("");
  // Build v65 (F26): the settings pair as loaded when the fold
  // opened — the save's CAS base.
  const [base, setBase] = useState<{
    openingReserveCents: number;
    reserveStartMonth: string | null;
  } | null>(null);
  // Build v121 (F3): the restore epoch as loaded when the fold
  // opened — frozen with the base.
  const [baseEpoch, setBaseEpoch] = useState<number | null>(null);
  const save = useMutation({
    mutationFn: () =>
      api.updateSettings({
        openingReserveCents: parseDollars(opening) ?? 0,
        reserveStartMonth: start ? start : null,
        baseEpoch: baseEpoch ?? 0,
        ...(base ? { base } : {}),
      }),
    onSuccess: (r) => {
      if (!r.ok) {
        // CAS refusal (build v65, F26): show why instead of
        // "Saved." over a newer stored value.
        setMsg(r.reason ?? "Those settings could not be saved.");
        return;
      }
      onSaved();
      setMsg("Saved.");
    },
    onError: (e) => setMsg(String(e)),
  });

  if (!open) {
    return (
      <button
        type="button"
        className="inline-flex min-h-9 items-center text-sm font-medium text-[var(--accent)] underline"
        onClick={() => {
          setOpening(String(data.openingReserveCents / 100));
          setStart(data.reserveStartMonth ?? "");
          setBase({
            openingReserveCents: data.openingReserveCents,
            reserveStartMonth: data.reserveStartMonth ?? null,
          });
          // Build v121 (F3): freeze the restore epoch with the base.
          setBaseEpoch(data.restoreEpoch ?? 0);
          setMsg("");
          setOpen(true);
        }}
      >
        Adjust reserve starting point
      </button>
    );
  }
  return (
    <form
      className="w-full basis-full space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <h3 className="display text-lg font-semibold">Reserve starting point</h3>
      <p className="text-sm text-[var(--dim)]">
        The reserve builds from the month below (by default, the first
        month in the tracker). If you already had money set aside for
        yearly &amp; periodic bills when you started, enter it here so
        the reserve isn't unfairly negative.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="rs-opening" className={labelCls}>Opening reserve ($)</label>
          <input id="rs-opening" type="text" inputMode="decimal" className={inputCls} value={opening} onChange={(e) => setOpening(e.target.value)} />
        </div>
        <div>
          <label htmlFor="rs-start" className={labelCls}>Reserve starts (month)</label>
          <input id="rs-start" type="month" className={inputCls} value={start} onChange={(e) => setStart(e.target.value)} />
        </div>
      </div>
      {msg && <p className="text-sm text-[var(--dim)]">{msg}</p>}
      <div className="flex gap-2">
        <button type="submit" className={btnPrimary} disabled={save.isPending}>
          Save
        </button>
        <button type="button" className={btnGhost} onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
    </form>
  );
}

/* ---------------- Statement import (CSV + OFX/QFX) ---------------- */

function ImportPanel({
  month,
  onDone,
  onCashOutSaved,
}: {
  month: string;
  onDone: (n: number) => void;
  onCashOutSaved?: (month: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [csvText, setCsvText] = useState("");
  const [template, setTemplate] = useState<"checking" | "card">("checking");
  const [outSign, setOutSign] = useState<"positive" | "negative">("positive");
  const [account, setAccount] = useState("Checking");
  const [cardKeyword, setCardKeyword] = useState("card payment, visa, mastercard, amex");
  const [transferKeyword, setTransferKeyword] = useState("transfer, savings");
  const [mapping, setMapping] = useState<ImportColumnMapping>(() => guessImportMapping(null));
  const [preview, setPreview] = useState<TxnInput[] | null>(null);
  const [previewMeta, setPreviewMeta] = useState<{ skipped: number; bothFilled: number } | null>(null);
  const [dupFlags, setDupFlags] = useState<boolean[] | null>(null);
  /* IM-5: the EXACT duplicate flags (bank transaction id already
     recorded), kept separate from the fuzzy flags above so the
     preview can label the two kinds distinctly. */
  const [exactFlags, setExactFlags] = useState<boolean[] | null>(null);
  const [dupNote, setDupNote] = useState("");
  /* IM-5: the loaded OFX file's account identity line (masked)
     and remembered-mapping note. */
  const [ofxNotice, setOfxNotice] = useState("");
  const [includeDups, setIncludeDups] = useState(false);
  const [checkingDups, setCheckingDups] = useState(false);
  const [error, setError] = useState("");
  const [profileNotice, setProfileNotice] = useState("");
  const [settingsBlob, setSettingsBlob] = useState<ImportSettingsBlob>(EMPTY_IMPORT_SETTINGS);
  /* IM-4 cash-out proposal state: what is already recorded per
     month (entered total + items, from the same getImportData
     read as the duplicate check), which month is mid-save, the
     months saved from this preview, and a save error line. */
  type RecordedCashOutMonth = ApiResponse<typeof api, "getImportData">["cashOut"][number];
  const [recordedCashOut, setRecordedCashOut] = useState<RecordedCashOutMonth[] | null>(null);
  // Build v121 (F3): the restore epoch as loaded by the same
  // getImportData read as the recorded cash out — the confirmed
  // proposal save carries it back as baseEpoch, so a panel that
  // loaded before a restore is refused.
  const [recordedCashOutEpoch, setRecordedCashOutEpoch] = useState<number | null>(null);
  const [savingMonth, setSavingMonth] = useState<string | null>(null);
  const [savedMonths, setSavedMonths] = useState<Record<string, boolean>>({});
  const [proposalError, setProposalError] = useState("");

  /* Remembered setup (IM-2): the last-used settings and the
     header-keyed mapping profiles live in ONE settings value on
     the server (the app's existing settings storage, carried in
     backup/restore like the other saved blobs). Loaded once when
     the panel opens; the last-used values become the defaults,
     and a profile whose header matches the loaded file applies
     its mapping and settings automatically (see the effect
     below). Saving happens on Preview: the current answers are
     the ones that just proved out against a real file. */
  const settingsQuery = useQuery({
    queryKey: ["importSettings"],
    queryFn: () => api.getImportData({ months: [] }),
  });
  const settingsLoaded = settingsQuery.isSuccess;
  const lastDefaultsAppliedRef = useRef(false);
  useEffect(() => {
    if (!settingsQuery.data) return;
    const blob = settingsQuery.data.settingsJson
      ? parseImportSettings(settingsQuery.data.settingsJson)
      : EMPTY_IMPORT_SETTINGS;
    setSettingsBlob(blob);
    if (!lastDefaultsAppliedRef.current) {
      lastDefaultsAppliedRef.current = true;
      if (blob.lastSettings) applyFileSettings(blob.lastSettings);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsQuery.data]);

  const saveSetup = useMutation({
    // Build v130 (round-19 finding 8): carries the epoch the
    // panel observed when it loaded its setup (the settings read's
    // restoreEpoch), so a restore since the panel loaded refuses
    // the save instead of overwriting the restored setup.
    mutationFn: (json: string) => api.saveImportSettings({ settingsJson: json, baseEpoch: settingsQuery.data?.restoreEpoch ?? 0 }),
    // A failed save never blocks an import — the panel just
    // keeps working with the values on screen.
    onSuccess: (r) => {
      if (!r.ok) setProfileNotice(r.reason ?? "Your import setup couldn't be saved this time — the import itself is unaffected.");
    },
    onError: () => setProfileNotice("Your import setup couldn't be saved this time — the import itself is unaffected."),
  });

  function applyFileSettings(s: ImportFileSettings) {
    setTemplate(s.template);
    setOutSign(s.outSign);
    setAccount(s.accountName);
    setCardKeyword(s.cardKeywords);
    setTransferKeyword(s.transferKeywords);
  }

  function currentFileSettings(): ImportFileSettings {
    return {
      template,
      accountName: account.trim() || "Checking",
      outSign,
      cardKeywords: cardKeyword,
      transferKeywords: transferKeyword,
    };
  }

  /* The loaded file, parsed once per text change. An OFX/QFX
     file (IM-5) is recognised by its content and parsed by the
     OFX core instead — no header, no column mapping: the format
     names its own fields. Its statement account (the first with
     transactions, else the first in the file) is the one whose
     transactions this panel imports. Anything else goes through
     the CSV parser as before: header detection, the header
     cells (for the mapping selects and the profile
     fingerprint), and the body rows. */
  const parsedFile = useMemo(() => {
    if (csvText.trim() === "") return null;
    if (looksLikeOfx(csvText)) {
      const res = parseOfx(csvText);
      if (!res.ok) {
        return { error: res.error, header: null as string[] | null, headerLower: null as string[] | null, body: [] as string[][], columnCount: 0, ofx: null };
      }
      const account =
        res.accounts.find((a) => a.transactions.length > 0) ??
        res.accounts[0] ??
        null;
      return {
        error:
          account == null
            ? "That OFX file has no account statement in it — nothing to import."
            : "",
        header: null as string[] | null,
        headerLower: null as string[] | null,
        body: [] as string[][],
        columnCount: 0,
        ofx: {
          accounts: res.accounts,
          account,
          skippedTxns: res.skippedTxns,
        },
      };
    }
    const parsed = parseCsvChecked(csvText);
    if ("error" in parsed) {
      return { error: parsed.error, header: null as string[] | null, headerLower: null as string[] | null, body: [] as string[][], columnCount: 0, ofx: null };
    }
    const raw = parsed.rows;
    const first = raw[0] ?? [];
    const hasHeader = raw.length > 0 && detectImportHeader(first);
    return {
      error: "",
      header: hasHeader ? first.map((c) => c.trim()) : null,
      headerLower: hasHeader ? first.map((c) => c.trim().toLowerCase()) : null,
      body: hasHeader ? raw.slice(1) : raw,
      columnCount: raw.reduce((n, r) => Math.max(n, r.length), 0),
      ofx: null,
    };
  }, [csvText]);

  /* When a file with a header arrives: if a saved profile
     matches its header fingerprint, apply the profile's mapping
     and settings and say so; otherwise start from the automatic
     guess. Re-applies when the remembered setup finishes
     loading, so a profile saved earlier wins even if the file
     was chosen first. Any change of file clears the preview. */
  const appliedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const header = parsedFile?.header ?? null;
    const ofxAccount = parsedFile?.ofx?.account ?? null;
    const key = ofxAccount
      ? `ofx|${ofxAccountKey(ofxAccount)}|${settingsLoaded ? "loaded" : "pending"}`
      : `${header ? importHeaderFingerprint(header) : "no-header"}|${settingsLoaded ? "loaded" : "pending"}`;
    if (appliedKeyRef.current === key) return;
    appliedKeyRef.current = key;
    setPreview(null);
    setPreviewMeta(null);
    setDupFlags(null);
    setExactFlags(null);
    setDupNote("");
    setRecordedCashOut(null);
    setSavedMonths({});
    setProposalError("");
    if (ofxAccount) {
      /* IM-5: an OFX file names its account. A remembered
         mapping for that account refills the account name and
         template; otherwise the template follows the file's own
         account kind (a card statement is a card export). The
         identity is shown masked — the full account id never
         reaches the screen. */
      setProfileNotice("");
      const remembered =
        settingsBlob.ofxAccounts[ofxAccountKey(ofxAccount)] ?? null;
      const multi =
        parsedFile != null && parsedFile.ofx != null && parsedFile.ofx.accounts.length > 1
          ? ` The file holds ${parsedFile.ofx.accounts.length} accounts; the transactions shown are from this one.`
          : "";
      if (remembered) {
        setAccount(remembered.accountName);
        setTemplate(remembered.template);
        setOfxNotice(
          `This file is for ${ofxAccountDisplay(ofxAccount)} — the account name and type you used for it last time are filled in.${multi}`,
        );
      } else {
        setTemplate(ofxAccount.kind === "card" ? "card" : "checking");
        setOfxNotice(`This file is for ${ofxAccountDisplay(ofxAccount)}.${multi}`);
      }
      return;
    }
    setOfxNotice("");
    if (!header) {
      setMapping(guessImportMapping(null));
      setProfileNotice("");
      return;
    }
    const profile = findImportProfile(settingsBlob, header);
    if (profile) {
      setMapping(profile.mapping);
      applyFileSettings(profile.settings);
      setProfileNotice(
        "Saved setup applied — this file's columns match a layout you've imported before, so its column mapping and settings were filled in from that profile. Change anything below and the profile updates when you preview.",
      );
    } else {
      setMapping(guessImportMapping(parsedFile?.headerLower ?? null));
      setProfileNotice("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsedFile, settingsLoaded, settingsBlob]);

  function clearPreview() {
    setPreview(null);
    setPreviewMeta(null);
    setDupFlags(null);
    setExactFlags(null);
    setDupNote("");
    setRecordedCashOut(null);
    setSavedMonths({});
    setProposalError("");
  }

  // The server accepts at most 1,000 rows per import call, so a big
  // bank export is sent in sequential batches of 500. Previously the
  // whole preview went in one call: any file over 1,000 rows previewed
  // fine and then failed wholesale at the server, importing nothing.
  // If a batch fails midway, the rows already imported stay imported
  // (each batch is its own committed call) and the preview is replaced
  // with just the rows that did not land, so retrying imports only
  // those — never a duplicate of the rows already in.
  //
  // Batch idempotency keys (build v64, F02): each 500-row batch
  // is offered under ONE key, generated when the batch is first
  // offered and REUSED when the same batch (the same row objects,
  // re-offered whole from the remaining preview) is retried after a
  // failure. That closes the response-loss hole: a batch that
  // committed on the server but whose success response never
  // arrived is re-offered under its original key, and the server
  // returns its original count inserting zero additional rows. A
  // fresh preview builds fresh row objects, so a genuinely new
  // import of identical rows gets fresh keys and inserts normally.
  const pendingBatchKeyRef = useRef<{ rows: TxnInput[]; key: string } | null>(
    null,
  );
  function batchKeyFor(batch: TxnInput[]): string {
    const pending = pendingBatchKeyRef.current;
    if (
      pending &&
      pending.rows.length === batch.length &&
      pending.rows.every((r, j) => r === batch[j])
    ) {
      return pending.key;
    }
    const key =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `import-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pendingBatchKeyRef.current = { rows: batch, key };
    return key;
  }
  const importer = useMutation({
    mutationFn: async (
      rows: TxnInput[],
    ): Promise<{
      imported: number;
      remaining: TxnInput[];
      error: string;
    }> => {
      const BATCH = 500;
      let imported = 0;
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const batchKey = batchKeyFor(batch);
        try {
          // Build v130 (round-19 finding 7): carries the epoch
          // the preview observed when it read the recorded data, so
          // a restore between preview and confirm refuses the batch
          // instead of landing rows the preview had cleared.
          const r = await api.importTransactions({ rows: batch, batchKey, baseEpoch: recordedCashOutEpoch ?? 0 });
          imported += r.imported;
          // This batch is acknowledged; the next batch offered
          // (in this run or a retry) generates a fresh key.
          if (pendingBatchKeyRef.current?.key === batchKey) {
            pendingBatchKeyRef.current = null;
          }
        } catch (e) {
          return {
            imported,
            remaining: rows.slice(i),
            error: e instanceof Error ? e.message : String(e),
          };
        }
      }
      return { imported, remaining: [], error: "" };
    },
    onSuccess: (r) => {
      if (r.remaining.length === 0) {
        onDone(r.imported);
        setPreview(null);
        setPreviewMeta(null);
        setDupFlags(null);
        setExactFlags(null);
        setRecordedCashOut(null);
        setSavedMonths({});
        setProposalError("");
        setCsvText("");
        return;
      }
      if (r.imported > 0) onDone(r.imported);
      setPreview(r.remaining);
      setDupFlags(null);
      setExactFlags(null);
      setDupNote("");
      setError(
        `Imported ${r.imported} row${r.imported === 1 ? "" : "s"}, then a batch failed${r.error ? ` (${r.error})` : ""}. The remaining ${r.remaining.length} row${r.remaining.length === 1 ? " is" : "s are"} still in the preview — press Import again to retry just those.`,
      );
    },
    onError: (e) => setError(String(e)),
  });

  function buildRows(): { rows: TxnInput[]; skipped: number; bothFilled: number } | null {
    setError("");
    if (!parsedFile) {
      setError("Paste CSV text or choose a file first.");
      return null;
    }
    if (parsedFile.error) {
      setError(parsedFile.error);
      return null;
    }
    if (parsedFile.ofx) {
      /* IM-5: OFX rows enter the same preview pipeline as CSV
         rows — the same classification (an explicit kind never
         exists in OFX, so the checking template's keyword rules
         apply exactly as for a CSV), the same account-name cap,
         the same skip counting. Two format differences only:
         the sign is the format's own (TRNAMT is negative for
         money out, so it is flipped into the panel's
         money-out-positive terms and the sign setting does not
         apply), and each row keeps its bank transaction id for
         the exact-duplicate check. */
      const acct = parsedFile.ofx.account;
      if (!acct) {
        setError("That OFX file has no account statement in it — nothing to import.");
        return null;
      }
      const acctName = account.trim() || "Checking";
      if (acctName.length > 60) {
        setError("That account name is over 60 characters — shorten it and preview again.");
        return null;
      }
      const cardKeys = cardKeyword.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      const transferKeys = transferKeyword.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      const out: TxnInput[] = [];
      for (const t of acct.transactions) {
        let kind: TxnInput["kind"] = "spending";
        if (template === "checking") {
          const d = t.description.toLowerCase();
          if (cardKeys.some((k) => d.includes(k))) kind = "card_payment";
          else if (transferKeys.some((k) => d.includes(k))) kind = "transfer";
        }
        out.push({
          date: t.date,
          description: t.description,
          amountCents: -t.amountCents,
          sourceType: kind === "spending" ? template : "checking",
          accountName: kind === "spending" ? acctName : "Checking",
          kind,
          category: "Other",
          yearlyExpenseId: null,
          fitId: t.fitId,
        });
      }
      if (out.length === 0) {
        setError(
          `No usable rows found (${parsedFile.ofx.skippedTxns} skipped). The statement's transactions may all be unreadable — check the file and try again.`,
        );
        return null;
      }
      return { rows: out, skipped: parsedFile.ofx.skippedTxns, bothFilled: 0 };
    }
    const body = parsedFile.body;
    if (body.length === 0) {
      setError("That file has no data rows to import.");
      return null;
    }
    // Money comes from one amount column, or from a debit/credit
    // pair (IM-2): a mapped amount column wins; with none mapped,
    // a mapped debit or credit column switches the row reading
    // to the pair rule in importParseCore.
    const pairMode = mapping.amount < 0 && (mapping.debit >= 0 || mapping.credit >= 0);
    if (mapping.amount < 0 && !pairMode) {
      setError("Choose which column holds the amount — or map a debit and/or credit column instead.");
      return null;
    }
    if (mapping.date < 0 || mapping.description < 0) {
      setError("Choose which columns hold the date and the description.");
      return null;
    }

    const cardKeys = cardKeyword.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const transferKeys = transferKeyword.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

    // The account name lands on every spending row; the server caps
    // it at 60 characters (and rejects an empty one), so a bad value
    // here would make EVERY row unimportable — fail the preview with
    // a fixable message instead of building rows that can only wedge
    // a batch at import time.
    const acctName = account.trim() || "Checking";
    if (acctName.length > 60) {
      setError("That account name is over 60 characters — shorten it and preview again.");
      return null;
    }

    const out: TxnInput[] = [];
    let skipped = 0;
    let bothFilled = 0;
    for (const r of body) {
      const date = normalizeImportDate(r[mapping.date] ?? "");
      const desc = (r[mapping.description] ?? "").trim();
      let amount: number | null;
      if (pairMode) {
        const combined = combineDebitCreditAmount(
          mapping.debit >= 0 ? (r[mapping.debit] ?? "") : "",
          mapping.credit >= 0 ? (r[mapping.credit] ?? "") : "",
        );
        amount = combined?.cents ?? null;
        if (combined?.bothFilled) bothFilled++;
      } else {
        amount = parseImportAmount(r[mapping.amount] ?? "");
      }
      // A description over the server's 200-character limit can never
      // import: left in, it would reject its whole 500-row batch and
      // every retry of it. Count it as skipped here, like an
      // unreadable date, so the rest of the file still imports.
      if (!date || !desc || desc.length > 200 || amount == null) {
        skipped++;
        continue;
      }
      let kind: TxnInput["kind"] = "spending";
      const explicit = mapping.kind >= 0 ? (r[mapping.kind] ?? "").trim().toLowerCase() : "";
      if (explicit === "card_payment" || explicit === "transfer" || explicit === "spending") {
        kind = explicit;
      } else if (template === "checking") {
        const d = desc.toLowerCase();
        if (cardKeys.some((k) => d.includes(k))) kind = "card_payment";
        else if (transferKeys.some((k) => d.includes(k))) kind = "transfer";
      }
      const signed = outSign === "positive" ? amount : -amount;
      out.push({
        date,
        description: desc,
        amountCents: signed,
        sourceType: kind === "spending" ? template : "checking",
        accountName: kind === "spending" ? acctName : "Checking",
        kind,
        // Category is a grouping label only; the server caps it at
        // 40 characters, so trim a longer one to the cap rather than
        // lose the whole transaction over its label.
        fitId: null,
        category:
          mapping.category >= 0 && (r[mapping.category] ?? "").trim()
            ? (r[mapping.category] ?? "").trim().slice(0, 40)
            : "Other",
        yearlyExpenseId: null,
      });
    }
    if (out.length === 0) {
      setError(
        `No usable rows found (${skipped} skipped). Check the column mapping below — each row needs a readable date, a description, and an amount.`,
      );
      return null;
    }
    return { rows: out, skipped, bothFilled };
  }

  /* Preview: build the rows, remember the setup that produced
     them (last-used settings, plus the profile for this header),
     then check the rows against what's already recorded
     (IM-1). Duplicate matching runs here, where the recorded
     transactions can be read in plaintext — stored data is
     encrypted, so no server-side content match is possible. */
  async function runPreview() {
    const built = buildRows();
    if (!built) {
      clearPreview();
      return;
    }
    setPreview(built.rows);
    setPreviewMeta({ skipped: built.skipped, bothFilled: built.bothFilled });
    setIncludeDups(false);
    setDupFlags(null);
    setExactFlags(null);
    setDupNote("");
    setRecordedCashOut(null);
    setSavedMonths({});
    setProposalError("");
    if (built.skipped > 0) {
      setError(`${built.skipped} row(s) skipped — unreadable date or amount, a missing description, or a description over 200 characters.`);
    }
    const settings = currentFileSettings();
    let nextBlob = parsedFile?.header
      ? upsertImportProfile(settingsBlob, parsedFile.header, mapping, settings)
      : withLastImportSettings(settingsBlob, settings);
    /* IM-5: remember this OFX account's mapping — the account
       name and template just previewed — so the next file from
       the same account opens already set up for it. */
    const ofxAcct = parsedFile?.ofx?.account ?? null;
    if (ofxAcct) {
      nextBlob = withImportOfxAccount(nextBlob, ofxAccountKey(ofxAcct), {
        accountName: settings.accountName,
        template: settings.template,
      });
    }
    setSettingsBlob(nextBlob);
    saveSetup.mutate(serializeImportSettings(nextBlob));

    setCheckingDups(true);
    try {
      const months = [...new Set(built.rows.map((r) => r.date.slice(0, 7)))].slice(0, 60);
      const data = await api.getImportData({ months });
      setDupFlags(flagImportDuplicates(built.rows, data.existing));
      /* IM-5: the exact check — a row whose bank transaction id
         was already recorded FOR THE SAME ACCOUNT is an exact
         duplicate, whatever its date/amount/description look
         like; a row with a NEW id is never exact (the fuzzy flag
         above may still mark it as looking already recorded).
         The recorded entries pass through whole (id + account),
         because a bank transaction id is unique only within its
         own account — the same id in another account is a
         different transaction (round-7 fix 6.1). */
      setExactFlags(flagExactFitIdDuplicates(built.rows, data.existing));
      // IM-4: the same read carries each month's recorded cash
      // out, which the proposal below compares against.
      setRecordedCashOut(data.cashOut);
      setRecordedCashOutEpoch(data.restoreEpoch);
    } catch {
      setDupFlags(null);
      setExactFlags(null);
      setRecordedCashOut(null);
      setRecordedCashOutEpoch(null);
      setDupNote("The duplicate check couldn't run, so review the rows below before importing — rows already recorded won't be flagged this time.");
    }
    setCheckingDups(false);
  }

  /* A row is left out when EITHER check flags it: exact (same
     bank transaction id — IM-5) or fuzzy (same date, amount,
     description, kind, and account — IM-1). The two counts are
     kept separate for the preview copy: exact rows are certain,
     fuzzy-only rows are look-alikes. */
  const isDupAt = (i: number): boolean =>
    (dupFlags?.[i] ?? false) || (exactFlags?.[i] ?? false);
  const exactCount =
    preview && exactFlags ? preview.filter((_, i) => exactFlags[i]).length : 0;
  const dupCount = preview ? preview.filter((_, i) => isDupAt(i)).length : 0;
  const fuzzyOnlyCount = dupCount - exactCount;
  const newRows = preview ? preview.filter((_, i) => !isDupAt(i)) : [];
  const exactRows = preview && exactFlags ? preview.filter((_, i) => exactFlags[i]) : [];
  const fuzzyOnlyRows = preview
    ? preview.filter((_, i) => isDupAt(i) && !(exactFlags?.[i] ?? false))
    : [];
  const includedRows = preview
    ? preview.filter((_, i) => includeDups || !isDupAt(i))
    : [];

  /* IM-4 — cash-out proposals. A checking export is the record
     of what left the checking account, so alongside the
     transaction import the panel proposes each month's cash out
     from the export itself (buildCashOutProposals in
     importParseCore: every money-out row counts, transfers
     excluded, duplicate-flagged rows included and marked — the
     proposal shows the export's arithmetic as-is). Nothing here
     saves on its own: each month is confirmed separately, and
     saving writes ONLY through the existing cash-out paths —
     the month's recorded items are replaced with the proposed
     items (the existing delete/add item writes) and the
     proposed total is set as the month's entered total (the
     existing month-total write), which the app's items-win
     precedence keeps as the reference figure beside the items.
     Card-template files get no proposal: a card export is
     charges, not money out of checking. */
  const proposals: CashOutMonthProposal[] =
    template === "checking" && preview
      ? buildCashOutProposals(
          preview,
          dupFlags || exactFlags
            ? preview.map((_, i) => isDupAt(i))
            : null,
        )
      : [];
  const recordedByMonth = new Map(
    (recordedCashOut ?? []).map((c) => [c.month, c] as const),
  );

  async function saveCashOutProposal(p: CashOutMonthProposal) {
    const rec = recordedByMonth.get(p.month);
    setSavingMonth(p.month);
    setProposalError("");
    try {
      // Replace the month's recorded items with the proposed set
      // first, then set the entered total — if a write fails
      // partway, the month keeps whatever landed and the error
      // below says to check it before saving again.
      if (rec) {
        for (const it of rec.items) {
          // Build v121 (F3): the delete carries the epoch
          // this comparison loaded at — a restore since then
          // refuses it before anything is removed.
          const del = await api.deleteCashOutItem({ id: it.id, baseEpoch: recordedCashOutEpoch ?? 0 });
          if (!del.ok) {
            throw new Error(del.reason ?? "That item could not be deleted.");
          }
        }
      }
      for (const it of p.items) {
        await api.addCashOutItem({
          month: p.month,
          // The proposal row carries the export's own date, so
          // the item keeps the day the cash actually went out.
          day: Number(it.date.slice(8, 10)) || 1,
          description: it.description,
          amountCents: it.amountCents,
          note: null,
        });
      }
      // Build v65 (F15): the base is the month's recorded
      // entered total as this comparison loaded it — a refused
      // (conflicted) save throws into the proposal error path
      // below instead of silently overwriting a newer total.
      // Build v121 (F3): the save also carries the epoch this
      // comparison loaded at, so a restore since then refuses it
      // even when the stored total still equals the base.
      const summaryRes = await api.upsertMonthlySummary({
        month: p.month,
        cashOutCents: p.totalCents,
        base: { cashOutCents: rec?.enteredCashOutCents ?? null },
        baseEpoch: recordedCashOutEpoch ?? 0,
      });
      if (!summaryRes.ok) {
        throw new Error(
          summaryRes.reason ?? "That month's total could not be saved.",
        );
      }
      setSavedMonths((prev) => ({ ...prev, [p.month]: true }));
      onCashOutSaved?.(p.month);
      // Refresh the recorded state so the comparison now reads
      // against what was just saved.
      try {
        const data = await api.getImportData({
          months: proposals.map((x) => x.month),
        });
        setRecordedCashOut(data.cashOut);
        setRecordedCashOutEpoch(data.restoreEpoch);
      } catch {
        // The save landed; only the comparison refresh failed.
      }
    } catch (e) {
      setProposalError(
        `Saving ${monthLabel(p.month)} stopped partway (${e instanceof Error ? e.message : String(e)}). Check that month's cash out in the Cash out section below before saving it again.`,
      );
    }
    setSavingMonth(null);
  }

  const mappingRoles: { role: keyof ImportColumnMapping; label: string; optional: boolean }[] = [
    { role: "date", label: "Date", optional: false },
    { role: "description", label: "Description", optional: false },
    { role: "amount", label: "Amount", optional: true },
    { role: "debit", label: "Debit (money out)", optional: true },
    { role: "credit", label: "Credit (money in)", optional: true },
    { role: "category", label: "Category", optional: true },
    { role: "kind", label: "Kind / type", optional: true },
  ];

  return (
    <div className="mt-3 space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
      <h3 className="display text-lg font-semibold">Import transactions</h3>
      <p className="text-sm leading-relaxed text-[var(--dim)]">
        Export a CSV — or an OFX/QFX file, the Quicken format many
        institutions offer next to CSV — from your bank or card, then
        paste it here or pick the file. An OFX/QFX file needs no
        column mapping: it names its own account, dates, and
        amounts, and each transaction carries the bank&rsquo;s own
        id, so a re-imported file is recognised exactly (see the
        preview). For a CSV, the usual columns are <code>date, description, amount</code>{" "}
        (a header row is fine; category and kind columns are used if
        present). Files with separate <strong>debit</strong> and{" "}
        <strong>credit</strong> columns work too — each row's amount comes
        from whichever of the two is filled, and a row with both is
        combined as debit minus credit. Two-digit-year dates (like
        10/3/26) are read as 20YY. For a <strong>checking</strong> export,
        rows whose description matches a card-payment keyword below are
        imported as card payments — cash out only, never double-counted
        as spending. For a <strong>card</strong> export, every row is
        recorded on its own date. Card-export rows keep the export's
        dates — the charge dates — so an imported charge sits in its
        charge month, not the month the card payment leaves the bank; the
        bank-out rule applies to amounts you record by their payment
        date — and True cost counts every amount in the month its money
        leaves checking, so an imported charge moves True cost in its
        payment month, not its charge month. Currently viewing {monthLabel(month)} — imported rows land
        in their own months. Your settings and column mapping are
        remembered for next time, and the preview flags rows that look
        already recorded — and, for an OFX file, rows whose bank
        transaction id was already recorded — so re-importing a file
        doesn't double it.
        For a checking export, the preview also proposes each month's
        cash out from the file itself — the money that left the
        account, transfers excluded — which you can review against
        what's recorded and save month by month.
        Import limits: a file up to 5 MB and 25,000 rows.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="imp-template" className={labelCls}>This file is from</label>
          <select id="imp-template" className={inputCls} value={template} onChange={(e) => { setTemplate(e.target.value as "checking" | "card"); clearPreview(); }}>
            <option value="checking">Checking account</option>
            <option value="card">Credit card</option>
          </select>
        </div>
        <div>
          <label htmlFor="imp-account" className={labelCls}>Account name</label>
          <input id="imp-account" type="text" className={inputCls} value={account} onChange={(e) => { setAccount(e.target.value); clearPreview(); }} />
        </div>
        <div>
          <label htmlFor="imp-sign" className={labelCls}>In this file, money out is</label>
          <select id="imp-sign" className={inputCls} value={outSign} onChange={(e) => { setOutSign(e.target.value as "positive" | "negative"); clearPreview(); }}>
            <option value="positive">Positive (charges show as 84.20)</option>
            <option value="negative">Negative (charges show as −84.20)</option>
          </select>
        </div>
      </div>
      {template === "checking" && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="imp-cardkw" className={labelCls}>Card-payment keywords</label>
            <input id="imp-cardkw" type="text" className={inputCls} value={cardKeyword} onChange={(e) => { setCardKeyword(e.target.value); clearPreview(); }} />
          </div>
          <div>
            <label htmlFor="imp-transferkw" className={labelCls}>Transfer keywords</label>
            <input id="imp-transferkw" type="text" className={inputCls} value={transferKeyword} onChange={(e) => { setTransferKeyword(e.target.value); clearPreview(); }} />
          </div>
        </div>
      )}
      <div>
        <label htmlFor="imp-file" className={labelCls}>Statement file (CSV or OFX/QFX)</label>
        <input
          id="imp-file"
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
                setPreview(null);
                e.target.value = "";
                return;
              }
              void f.text().then((t) => {
                setCsvText(t);
                setPreview(null);
              });
            }
          }}
        />
      </div>
      <div>
        <label htmlFor="imp-text" className={labelCls}>…or paste CSV or OFX text</label>
        <textarea
          id="imp-text"
          rows={6}
          className={`${inputCls} font-mono text-sm`}
          value={csvText}
          onChange={(e) => {
            setCsvText(e.target.value);
            setPreview(null);
          }}
          placeholder={"date,description,amount\n2026-10-03,Grocery store,84.20"}
        />
      </div>
      {parsedFile?.ofx && !parsedFile.error && (
        <p className="text-sm text-[var(--dim)]">
          {ofxNotice} OFX files carry their own sign convention (money
          out is negative), so the &ldquo;money out is&rdquo; setting
          doesn&rsquo;t apply to this file, and there are no columns
          to map. Each transaction keeps its bank id, so the preview
          can tell exact duplicates from look-alikes.
        </p>
      )}
      {parsedFile && parsedFile.columnCount > 0 && !parsedFile.error && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Which column is which?</legend>
          {profileNotice && <p className="text-sm text-[var(--dim)]">{profileNotice}</p>}
          <div className="grid grid-cols-2 gap-3">
            {mappingRoles.map(({ role, label, optional }) => (
              <div key={role}>
                <label htmlFor={`imp-col-${role}`} className={labelCls}>{label} column</label>
                <select
                  id={`imp-col-${role}`}
                  className={inputCls}
                  value={mapping[role]}
                  onChange={(e) => {
                    setMapping({ ...mapping, [role]: Number(e.target.value) });
                    clearPreview();
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
          <p className="text-xs text-[var(--dim)]">
            Map either an amount column, or a debit and/or credit pair.
            With a pair, the sign setting above applies to the combined
            amount (debit minus credit).
          </p>
        </fieldset>
      )}
      {error && <p className="text-sm text-[var(--warn)]">{error}</p>}
      {preview && (
        <div className="rounded-[var(--radius)] bg-[var(--surface-alt)] p-3 text-sm">
          <p>
            Ready to import <strong>{newRows.length}</strong> new row
            {newRows.length === 1 ? "" : "s"}, net{" "}
            {fmt(newRows.reduce((s, r) => s + r.amountCents, 0))}.{" "}
            {preview.length > 1000 &&
              "Large file — it will be imported in batches of 500 rows. "}
            {newRows.filter((r) => r.kind === "card_payment").length} card
            payments, {newRows.filter((r) => r.kind === "transfer").length}{" "}
            transfers, {newRows.filter((r) => r.kind === "spending").length}{" "}
            spending.
          </p>
          {previewMeta && previewMeta.bothFilled > 0 && (
            <p className="mt-1">
              {previewMeta.bothFilled} row{previewMeta.bothFilled === 1 ? " had" : "s had"} both
              a debit and a credit — combined as debit minus credit.
            </p>
          )}
          {checkingDups && <p className="mt-1 text-[var(--dim)]">Checking for rows already recorded…</p>}
          {dupNote && <p className="mt-1 text-[var(--warn)]">{dupNote}</p>}
          {(dupFlags || exactFlags) && dupCount > 0 && (
            <>
              {exactCount > 0 && (
                <>
                  <p className="mt-1">
                    <strong>{exactCount}</strong> row{exactCount === 1 ? "" : "s"}{" "}
                    {exactCount === 1 ? "is an" : "are"} exact duplicate
                    {exactCount === 1 ? "" : "s"} — the bank transaction id
                    matches a transaction already recorded — and{" "}
                    {exactCount === 1 ? "is" : "are"} left out below.
                  </p>
                  <ul className="mt-2 space-y-0.5 text-xs text-[var(--dim)]">
                    {exactRows.slice(0, 5).map((r, i) => (
                      <li key={i}>
                        {r.date} · {r.description} · {fmt(r.amountCents)} · {r.kind} · exact duplicate
                      </li>
                    ))}
                    {exactRows.length > 5 && <li>…and {exactRows.length - 5} more</li>}
                  </ul>
                </>
              )}
              {fuzzyOnlyCount > 0 && (
                <>
                  <p className="mt-1">
                    <strong>{fuzzyOnlyCount}</strong> row{fuzzyOnlyCount === 1 ? "" : "s"} look
                    already recorded (same date, amount, description, and kind)
                    and {fuzzyOnlyCount === 1 ? "is" : "are"} left out below.
                  </p>
                  <ul className="mt-2 space-y-0.5 text-xs text-[var(--dim)]">
                    {fuzzyOnlyRows.slice(0, 5).map((r, i) => (
                      <li key={i}>
                        {r.date} · {r.description} · {fmt(r.amountCents)} · {r.kind}
                      </li>
                    ))}
                    {fuzzyOnlyRows.length > 5 && <li>…and {fuzzyOnlyRows.length - 5} more</li>}
                  </ul>
                </>
              )}
              <label className="mt-2 flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={includeDups}
                  onChange={(e) => setIncludeDups(e.target.checked)}
                />
                <span>
                  Import the {dupCount} excluded row
                  {dupCount === 1 ? "" : "s"} too — they're genuinely
                  separate transactions that happen to match.
                </span>
              </label>
            </>
          )}
          <p className="mt-2 text-xs font-medium text-[var(--dim)]">New rows</p>
          <ul className="mt-1 space-y-0.5 text-xs text-[var(--dim)]">
            {newRows.slice(0, 5).map((r, i) => (
              <li key={i}>
                {r.date} · {r.description} · {fmt(r.amountCents)} · {r.kind}
              </li>
            ))}
            {newRows.length > 5 && <li>…and {newRows.length - 5} more</li>}
          </ul>
        </div>
      )}
      {preview && template === "checking" && proposals.length > 0 && (
        <div className="rounded-[var(--radius)] border border-[var(--border)] p-3">
          <h4 className="text-sm font-semibold">Cash out proposed from this export</h4>
          <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
            This is a checking export, so it also shows what left the
            account each month. The proposed cash out counts every
            money-out row below — spending and card payments alike,
            since paying the card is money leaving checking — and
            leaves out transfers between your own accounts and any
            money that came in. Nothing is saved until you save a
            month, and months you don't save are left exactly as
            they are.
          </p>
          {proposalError && <p className="mt-2 text-sm text-[var(--warn)]">{proposalError}</p>}
          <div className="mt-3 space-y-4">
            {proposals.map((p) => {
              const rec = recordedByMonth.get(p.month);
              const cmp = rec
                ? compareCashOutProposal(p, {
                    enteredTotalCents: rec.enteredCashOutCents,
                    itemsTotalCents: rec.items.reduce((s, it) => s + it.amountCents, 0),
                    itemsCount: rec.items.length,
                  })
                : null;
              const dupItems = p.items.filter((it) => it.isDuplicate).length;
              const wasSaved = savedMonths[p.month] ?? false;
              return (
                <div key={p.month} className="rounded-[var(--radius)] bg-[var(--surface-alt)] p-3 text-sm">
                  <p>
                    <strong>{monthLabel(p.month)}</strong> — proposed cash out{" "}
                    <strong>{fmt(p.totalCents)}</strong> from {p.items.length} money-out row
                    {p.items.length === 1 ? "" : "s"}.
                  </p>
                  <ul className="mt-2 space-y-0.5 text-xs text-[var(--dim)]">
                    {p.items.slice(0, 10).map((it, i) => (
                      <li key={i}>
                        {it.date} · {it.description} · {fmt(it.amountCents)} · {it.kind}
                        {it.isDuplicate && (
                          <span className="text-[var(--warn)]"> · looks already recorded</span>
                        )}
                      </li>
                    ))}
                    {p.items.length > 10 && <li>…and {p.items.length - 10} more</li>}
                  </ul>
                  {dupItems > 0 && (
                    <p className="mt-1 text-xs text-[var(--dim)]">
                      {dupItems} of these rows look already recorded as transactions.
                      They're still counted — the proposal is the export's own total,
                      shown as-is.
                    </p>
                  )}
                  {recordedCashOut === null ? (
                    <p className="mt-2 text-[var(--dim)]">
                      What's already recorded for this month couldn't be loaded, so no
                      comparison is shown and saving is off — preview again to retry.
                    </p>
                  ) : cmp && cmp.recordedResolvedCents == null ? (
                    <p className="mt-2">Nothing is recorded for {monthLabel(p.month)} yet.</p>
                  ) : cmp && rec ? (
                    <p className="mt-2">
                      Recorded now: <strong>{fmt(cmp.recordedResolvedCents ?? 0)}</strong>
                      {rec.enteredCashOutCents != null &&
                        ` (entered total ${fmt(rec.enteredCashOutCents)}`}
                      {rec.enteredCashOutCents != null && rec.items.length > 0 && " · "}
                      {rec.items.length > 0 &&
                        `${rec.enteredCashOutCents != null ? "" : "("}${rec.items.length} item${rec.items.length === 1 ? "" : "s"} totalling ${fmt(rec.items.reduce((s, it) => s + it.amountCents, 0))}`}
                      {(rec.enteredCashOutCents != null || rec.items.length > 0) && ")"}
                      {cmp.differenceCents != null && cmp.differenceCents !== 0 && (
                        <>
                          {" "}— the proposal is{" "}
                          <strong>
                            {fmt(Math.abs(cmp.differenceCents))}{" "}
                            {cmp.differenceCents > 0 ? "more" : "less"}
                          </strong>{" "}
                          than recorded.
                        </>
                      )}
                      {cmp.differenceCents === 0 && " — the proposal matches what's recorded."}
                    </p>
                  ) : null}
                  <p className="mt-2 text-[var(--dim)]">
                    Saving records these {p.items.length} rows as {monthLabel(p.month)}'s
                    cash-out items and sets the month's entered total to {fmt(p.totalCents)}{" "}
                    as the reference figure — when a month has both, the items are the cash
                    out that counts and the entered total stays alongside for comparison.
                    {rec && rec.items.length > 0 &&
                      ` The ${rec.items.length} item${rec.items.length === 1 ? "" : "s"} currently recorded for this month will be replaced.`}
                    {rec && rec.enteredCashOutCents != null && rec.enteredCashOutCents !== p.totalCents &&
                      ` The entered total, currently ${fmt(rec.enteredCashOutCents)}, will be updated.`}
                  </p>
                  {wasSaved && (
                    <p className="mt-2 font-medium">
                      Saved — {monthLabel(p.month)}'s cash out is now these items, with{" "}
                      {fmt(p.totalCents)} kept as the entered total.
                    </p>
                  )}
                  <button
                    type="button"
                    className={btnPrimary}
                    disabled={savingMonth !== null || recordedCashOut === null}
                    onClick={() => void saveCashOutProposal(p)}
                  >
                    {savingMonth === p.month
                      ? "Saving…"
                      : wasSaved
                        ? `Save ${monthLabel(p.month)} cash out again`
                        : `Save ${monthLabel(p.month)} cash out`}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          className={btnGhost}
          onClick={() => void runPreview()}
        >
          Preview import
        </button>
        {preview && (
          <button
            type="button"
            className={btnPrimary}
            disabled={importer.isPending || checkingDups || includedRows.length === 0}
            onClick={() => importer.mutate(includedRows)}
          >
            Import {includedRows.length} rows
          </button>
        )}
      </div>
    </div>
  );
}
