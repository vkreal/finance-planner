import {
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
Legend,
ResponsiveContainer,
Tooltip,
XAxis,
YAxis,
} from "recharts";
import { api, type ApiRequest, type ApiResponse } from "./api";
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
import { Explainer, ExplainerInfoTip, ExplainerToggle } from "./Explainer";
import {
  useFoldStateMap,
  usePersistedFold,
  useSetFold,
} from "./foldState";
import { NetWorthView } from "./NetWorth";
import { RetirementCalc } from "./RetirementCalc";
import { RothConversion } from "./RothConversion";
import { Playground } from "./Playground";
import { YearInSpendingBlock } from "./YearBlocks";
import { FoldChevron } from "./FoldChevron";

type Dash = ApiResponse<typeof api, "getDashboard">;
type Txn = Dash["monthTransactions"][number];
type Yearly = Dash["yearly"][number];
type Bill = Dash["monthlyBills"][number];
type OneOff = Dash["oneOffs"][number];
type CashOutItem = Dash["cashOutItems"][number];
type TxnInput = ApiRequest<typeof api, "importTransactions">["rows"][number];

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

function parseDollars(s: string): number | null {
  const cleaned = s.replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
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

function shiftMonth(month: string, delta: number): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + delta;
  const d = new Date(y, m, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
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
   tooltip on tap/click; hovering or focusing the cell shows it
   too — the tooltip carries the cell's definition, which does not
   print on the cell's face. Tapping outside or pressing Escape
   closes a toggled tooltip. The label reserves right padding so
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
  const ref = useRef<HTMLDivElement>(null);
  const show = open || hovered;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <div
      ref={ref}
      className={`relative flex flex-col p-3.5 sm:p-4 ${className}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
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
      <button
        type="button"
        aria-label={`How ${label} is calculated`}
        aria-expanded={open}
        aria-controls={tipId}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        className="absolute top-2 right-2 z-20 inline-flex h-5 w-5 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--dim)] hover:text-[var(--accent)] focus-visible:text-[var(--accent)]"
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
          className={`absolute top-full z-30 mt-2 w-64 max-w-[calc(100vw-2.5rem)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3 text-[13px] leading-snug font-normal whitespace-normal normal-case shadow-lg ${panelCls}`}
        >
          {tip}
        </div>
      )}
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

/* Chip chevron expand/collapse affordance for the two bills
   rosters' section headers. The visible control is the shared
   FoldChevron chip (crisp SVG chevron that rotates with state);
   the accessible name stays "Show bills" / "Hide bills", and the caller
   keeps aria-expanded / aria-controls wired to the same persisted
   fold state as before. The button box stays a comfortable 36px
   tap target around the 28px chip. */
function BillsFoldChevron({
  open,
  controlsId,
  onToggle,
}: {
  open: boolean;
  controlsId: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={open ? "Hide bills" : "Show bills"}
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
}: {
  id: string;
  value: string;
  options: string[];
  onChange: (next: string) => void;
}) {
  const isKnown = options.includes(value);
  const [custom, setCustom] = useState(!isKnown);
  const selectValue = custom ? CUSTOM_CATEGORY : value;
  return (
    <>
      <select
        id={id}
        className={inputCls}
        value={selectValue}
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
        {options.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
        <option value={CUSTOM_CATEGORY}>Type your own…</option>
      </select>
      {custom && (
        <input
          id={`${id}-custom`}
          type="text"
          className={`${inputCls} mt-2`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Type a custom category"
          aria-label="Custom category"
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
type ExplorerGroupBy = "category" | "bill" | "paidFrom" | "keepLightsOn" | "month";

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
                Explore the data — bills by month over any date range. Monthly bills count at the amount in effect that month; yearly &amp; periodic bills count at their monthly set-aside. Category and Keep-the-lights-on groupings use each bill&rsquo;s current label for every month, past and present. The final Other spending row is the day-to-day money that isn&rsquo;t bills, on the True cost basis, so each month totals to its True cost. (In the Month grouping, Everything else is the same day-to-day money on the cash-out basis.) Read-only: nothing here changes your data.
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
                      const isEverythingElse = r.label === "Other spending";
                      return (
                        <tr
                          key={`${r.label}-${rowIdx}`}
                          className={`border-b border-[var(--border)]${isEverythingElse ? " bg-[var(--surface-alt)]" : ""}`}
                        >
                          <th scope="row" className="py-2 pr-3 text-left font-medium">
                            {r.label}
                            {isEverythingElse && (
                              <span className="block text-xs font-normal text-[var(--dim)]">
                                day-to-day · not bills · True cost basis
                              </span>
                            )}
                          </th>
                          {r.valuesCents.map((v, i) => (
                            <td key={i} className="py-2 pr-3 text-right whitespace-nowrap">{fmt(v)}</td>
                          ))}
                          <td className="py-2 text-right font-semibold whitespace-nowrap">{fmt(r.totalCents)}</td>
                        </tr>
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
                      <td className="py-2 pr-3 text-right whitespace-nowrap">{fmt(r.cashOutCents)}</td>
                      <td className="py-2 pr-3 text-right whitespace-nowrap">{fmt(r.trueCostCents)}</td>
                      <td className="py-2 pr-3 text-right whitespace-nowrap">{fmt(r.totalMonthlyCents)}</td>
                      <td className="py-2 pr-3 text-right whitespace-nowrap">{fmt(r.yearlyPaidOutCents)}</td>
                      <td className="py-2 pr-3 text-right whitespace-nowrap">{fmt(r.everythingElseCents)}</td>
                      <td className="py-2 text-right whitespace-nowrap">{fmt(r.oneOffsCents)}</td>
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
};

/* Grouped bar chart for the Month-mode Quick view: one pair of bars
   per recorded month — the month's True cost (smoothed) beside its
   Cash out, in chronological order. Fed from getDashboard's own
   history: the caller passes exactly the trailing window the
   averages line averages (the last trailingMonthsCovered history
   entries — the same per-month eff() figures the tiles show), so
   the bars and the line are the same numbers and can never
   disagree (the line's figures are the means of exactly these
   months' bars), and a pair appears automatically when a new
   month is recorded. Past the viewed month, the series continues with any
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
   state. */
function SpendingTrueCostChart({
  months,
  aheadMonths,
  averageLine,
}: {
  months: SpendingMonthRow[];
  aheadMonths: SpendingAheadRow[];
  // The Quick view averages line ("Average month · … — True cost
  // … · Cash out …"), composed by the caller from the dashboard's
  // own averages over exactly the recorded `months` above; null
  // when fewer than 2 months are covered. Rendered as a quiet
  // summary line inside this card, under the subheading — it
  // used to be a standalone highlighted banner between the tiles
  // and this card (moved here by request, 2026-10-25: right
  // numbers, wrong place).
  averageLine: string | null;
}) {
  const thisMonth = currentMonth();
  const chartData: SpendingChartDatum[] = [
    ...months.map((m) => ({
      name: m.estimate
        ? `${shortMonthLabel(m.month)} (est.)`
        : shortMonthLabel(m.month),
      monthStr: m.month,
      estimate: m.estimate,
      trueCost: m.smoothedCents / 100,
      cashOut: m.cashOutCents / 100,
      trueCostCents: m.smoothedCents,
      cashOutCents: m.cashOutCents,
    })),
    ...aheadMonths.map((m) => {
      const estimate = m.month > thisMonth;
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
      };
    }),
  ];
  const hasEstimate = chartData.some((d) => d.estimate);

  return (
    <section
      aria-label="True cost vs Cash out by month"
      className="mt-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5"
    >
      <h3 className="display text-lg font-semibold">True cost vs Cash out</h3>
      <p className="mt-0.5 text-sm text-[var(--dim)]">
        One pair of bars per recorded month; an (est.) pair is entered
        ahead and may be revised.
      </p>
      {averageLine != null && (
        <p className="tnum mt-1.5 text-sm text-[var(--dim)]">{averageLine}</p>
      )}
      {chartData.length === 0 ? (
        <p className="mt-3 rounded-[var(--radius)] border border-dashed border-[var(--border)] p-4 text-sm text-[var(--dim)]">
          No months recorded yet — once a month is recorded, its True cost
          and Cash out appear here as a pair of bars.
        </p>
      ) : (
        <>
          {/* Screen-reader / text fallback carrying the exact figures. */}
          <ul className="sr-only">
            {chartData.map((d) => (
              <li key={d.monthStr}>
                {`${d.name}: True cost ${fmt(d.trueCostCents)} · Cash out ${fmt(d.cashOutCents)}${d.estimate ? " (estimate — entered ahead, may be revised)" : ""}`}
              </li>
            ))}
          </ul>
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
                        </div>
                      );
                    }}
                  />
                  <Legend
                    formatter={(value: string) => (
                      <span style={{ color: "var(--text)" }}>{value}</span>
                    )}
                  />
                  <Bar
                    dataKey="trueCost"
                    name="True cost"
                    fill="var(--accent)"
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
                  <Bar
                    dataKey="cashOut"
                    name="Cash out"
                    fill="var(--warn)"
                    radius={[3, 3, 0, 0]}
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
                    {/* Recharts' default LabelList rendering spreads
                        each bar entry's own SVG props onto its label
                        (LabelList → Label via filterProps(entry)), so
                        an estimate bar's Cell — fillOpacity 0.3, a
                        coloured stroke, strokeWidth 1.5 and
                        strokeDasharray "4 2" — would otherwise be
                        inherited by the label text itself, giving it a
                        dashed, doubled, unreadable outline. These
                        explicit props are spread AFTER the entry in
                        LabelList, so they override that inheritance
                        for every label: one solid, full-contrast
                        rendering, identical for recorded and (est.)
                        months. The bars keep their estimate treatment
                        via the Cells above; only the labels are pinned
                        clean. */}
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
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
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
  trueCost: number | null;
  cashOut: number | null;
  trueCostCents: number;
  cashOutCents: number;
};

/* Grouped bar chart for Year mode only: True cost vs Cash out,
   fed directly from the getYearView monthly figures — the
   exact same values the month panels below show, so the chart can
   never disagree with them. Only months with data are included,
   matching the panels; a month with data and a real $0 keeps its
   $0 in the tooltip with no bar height. */
function YearTrueCostChart({
  year,
  months,
  onSelectMonth,
}: {
  year: number;
  months: YearMonthRow[];
  onSelectMonth: (month: string) => void;
}) {
  const chartData: YearChartDatum[] = months
    .filter((m) => m.hasData)
    .map((m) => ({
      name: MONTH_SHORT[m.monthNum - 1] ?? m.month,
      monthStr: m.month,
      hasData: true,
      trueCost: m.trueCostCents / 100,
      cashOut: m.cashOutCents / 100,
      trueCostCents: m.trueCostCents,
      cashOutCents: m.cashOutCents,
    }));

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
      </p>
      {/* Screen-reader / text fallback carrying the exact figures. */}
      <ul className="sr-only">
        {chartData.map((d) => (
          <li key={d.monthStr}>
            {`${d.name} ${year}: True cost ${fmt(d.trueCostCents)} · Cash out ${fmt(d.cashOutCents)}`}
          </li>
        ))}
      </ul>
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
                    </div>
                  );
                }}
              />
              <Legend
                formatter={(value: string) => (
                  <span style={{ color: "var(--text)" }}>{value}</span>
                )}
              />
              <Bar
                dataKey="trueCost"
                name="True cost"
                fill="var(--accent)"
                radius={[3, 3, 0, 0]}
                cursor="pointer"
              />
              <Bar
                dataKey="cashOut"
                name="Cash out"
                fill="var(--warn)"
                radius={[3, 3, 0, 0]}
                cursor="pointer"
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
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

export function App() {
  const queryClient = useQueryClient();
  const [month, setMonth] = useState(currentMonth());
  const [openTip, setOpenTip] = useState<string | null>(null);
  /* Quick view mode: "month" is the single-month strip; "year" stacks
     the months with data of the flipped-to year, each month panel
     carrying that month's own Quick view. In-session only. */
  const [quickMode, setQuickMode] = useState<"month" | "year">("month");
  /* Top-level view switch: "spending" is the whole existing dashboard;
     "networth" is its own self-contained view — while it is active
     none of the spending sections render. In-session only. */
  const [topView, setTopView] = useState<"spending" | "networth" | "retirement" | "roth" | "playground">("spending");
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
  };

  /* transaction form state */
  const [showTxnForm, setShowTxnForm] = useState(false);
  const [editingTxnId, setEditingTxnId] = useState<number | null>(null);
  // Contract v65 (F13): the transaction as loaded when the editor
  // opened — sent back as the update's CAS base.
  const [editingTxnBase, setEditingTxnBase] = useState<
    ApiRequest<typeof api, "updateTransaction">["base"] | null
  >(null);
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
  // Contract v65 (F17): the expense exactly as loaded when the
  // editor opened — the save's CAS base (parent fields plus the
  // version stored for the save's effective month).
  const [editingYearly, setEditingYearly] = useState<Yearly | null>(null);
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
  // Contract v65 (F15): the month + stored total as loaded when
  // the summary form opened — the save's CAS base. If the user
  // changes the month in the form, the base is recomputed from
  // the loaded dashboard for that month instead.
  const [summaryBase, setSummaryBase] = useState<{
    month: string;
    cashOutCents: number | null;
  } | null>(null);
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
  // Contract v65 (F14): the cash-out item as loaded when the
  // editor opened — sent back as the update's CAS base.
  const [editingItemBase, setEditingItemBase] = useState<
    ApiRequest<typeof api, "updateCashOutItem">["base"] | null
  >(null);
  const [iDate, setIDate] = useState(() => `${currentMonth()}-01`);
  const [iDesc, setIDesc] = useState("");
  const [iDollars, setIDollars] = useState("");
  const [iNote, setINote] = useState("");
  const [itemError, setItemError] = useState("");

  /* monthly bills state */
  const [showBillForm, setShowBillForm] = useState(false);
  const [editingBillId, setEditingBillId] = useState<number | null>(null);
  // Contract v65 (F18/F16): the bill exactly as loaded when the
  // editor opened — the CAS bases for the metadata save (all five
  // fields) and the chained amount save (the version stored for
  // the chosen effective month).
  const [editingBill, setEditingBill] = useState<Bill | null>(null);
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
     other section folds. The section header (title, total, More
     explainer, Add button) stays visible either way. */
  const [monthlyBillsOpen, setMonthlyBillsOpen] = usePersistedFold(
    "spending.monthlyBills",
  );
  /* The Yearly & periodic roster's open/closed state: same treatment
     as Monthly bills — the roster is reference data, so it sits behind
     this persisted fold, DEFAULT COLLAPSED when no saved state exists,
     persisting across sessions. The section header (title, compact
     yearly total + set-aside, More explainer, Add button) stays
     visible either way. */
  const [yearlyBillsOpen, setYearlyBillsOpen] = usePersistedFold(
    "spending.yearlyBills",
  );
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
  const [confirmYearlyVersionId, setConfirmYearlyVersionId] = useState<number | null>(null);
  const [versionDeleteError, setVersionDeleteError] = useState("");
  const [recordingYearlyId, setRecordingYearlyId] = useState<number | null>(null);

  useEffect(() => {
    setRecordingYearlyId(null);
  }, [month]);

  const data = dash.data;

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
      if (data?.monthlyBillsCollapsedAll) {
        setMonthlyBillsCollapsedAll.mutate({ collapsed: false });
      }
    }
    if (id === "section-yearly-expenses") {
      /* The roster fold opens (persisted) as part of the scroll, so
         the tile tap never lands on a collapsed section. */
      if (!yearlyBillsOpen) setYearlyBillsOpen(true);
      if (data?.yearlyBillsCollapsedAll) {
        setYearlyBillsCollapsedAll.mutate({ collapsed: false });
      }
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
    }) => api.updateTransaction(input),
    onSuccess: (r) => {
      if (!r.ok) {
        // CAS refusal (contract v65, F13): the stored row moved
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
    mutationFn: (id: number) => api.deleteTransaction({ id }),
    onSuccess: invalidate,
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
        // CAS refusal (contract v65, F17): keep the form open and
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
    mutationFn: (id: number) => api.deleteYearlyExpense({ id }),
    onSuccess: invalidate,
  });
  const deleteYearlyVersion = useMutation({
    mutationFn: (versionId: number) => api.deleteYearlyExpenseVersion({ versionId }),
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
    mutationFn: (versionId: number) => api.deleteMonthlyBillVersion({ versionId }),
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
        // CAS refusal (contract v65, F15): keep the form open and
        // show why instead of closing over the newer value.
        setSummaryError(r.reason ?? "That month's total could not be saved.");
        return;
      }
      invalidate();
      setShowSummaryForm(false);
      setSDollars("");
      setSummaryError("");
    },
    onError: (e) => setSummaryError(String(e)),
  });
  const deleteSummary = useMutation({
    mutationFn: (m: string) => api.deleteMonthlySummary({ month: m }),
    onSuccess: invalidate,
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
        // CAS refusal (contract v65, F14): keep the form open and
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
    mutationFn: (id: number) => api.deleteCashOutItem({ id }),
    onSuccess: invalidate,
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
        // CAS refusal (contract v65, F18): keep the form open and
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
    mutationFn: (id: number) => api.deleteMonthlyBill({ id }),
    onSuccess: invalidate,
  });
  const setBillAmount = useMutation({
    mutationFn: (input: ApiRequest<typeof api, "setMonthlyBillAmount">) =>
      api.setMonthlyBillAmount(input),
    onSuccess: (r) => {
      if (!r.ok) {
        // CAS refusal (contract v65, F16): show why instead of
        // resetting the form over the newer stored amount.
        setBillError(r.reason ?? "That bill amount could not be saved.");
        return;
      }
      invalidate();
      resetBillForm();
    },
    onError: (e) => setBillError(String(e)),
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
    onSuccess: () => {
      invalidate();
      resetOneOffForm();
    },
    onError: (e) => setOneOffError(String(e)),
  });
  const deleteOneOff = useMutation({
    mutationFn: (id: number) => api.deleteMonthlyOneOff({ id }),
    onSuccess: invalidate,
  });
  const setDueMonth = useMutation({
    mutationFn: (input: ApiRequest<typeof api, "setYearlyDueMonth">) =>
      api.setYearlyDueMonth(input),
    onSuccess: invalidate,
  });
  const setMonthlyCategory = useMutation({
    mutationFn: (input: ApiRequest<typeof api, "setMonthlyBillCategory">) =>
      api.setMonthlyBillCategory(input),
    onSuccess: invalidate,
  });
  const setYearlyCategory = useMutation({
    mutationFn: (input: ApiRequest<typeof api, "setYearlyCategory">) =>
      api.setYearlyCategory(input),
    onSuccess: invalidate,
  });
  const setMonthlyKeepLightsOn = useMutation({
    mutationFn: (input: ApiRequest<typeof api, "setMonthlyBillKeepLightsOn">) =>
      api.setMonthlyBillKeepLightsOn(input),
    onSuccess: invalidate,
  });
  const setMonthlyBillsCollapsedAll = useMutation({
    mutationFn: (input: ApiRequest<typeof api, "setMonthlyBillsCollapsedAll">) =>
      api.setMonthlyBillsCollapsedAll(input),
    onSuccess: invalidate,
  });
  const setYearlyBillsCollapsedAll = useMutation({
    mutationFn: (input: ApiRequest<typeof api, "setYearlyBillsCollapsedAll">) =>
      api.setYearlyBillsCollapsedAll(input),
    onSuccess: invalidate,
  });
  const setByCategoryCollapsedAll = useMutation({
    mutationFn: (input: ApiRequest<typeof api, "setByCategoryCollapsedAll">) =>
      api.setByCategoryCollapsedAll(input),
    onSuccess: invalidate,
  });
  const setYearInSpendingCollapsedAll = useMutation({
    mutationFn: (input: ApiRequest<typeof api, "setYearInSpendingCollapsedAll">) =>
      api.setYearInSpendingCollapsedAll(input),
    onSuccess: invalidate,
  });
  const setYearlyKeepLightsOn = useMutation({
    mutationFn: (input: ApiRequest<typeof api, "setYearlyKeepLightsOn">) =>
      api.setYearlyKeepLightsOn(input),
    onSuccess: invalidate,
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
    // Contract v65 (F13): the row as loaded — the CAS base the
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
        ...(editingTxnBase ? { base: editingTxnBase } : {}),
      });
    else addTxn.mutate(input);
  }

  function resetYearlyForm() {
    setShowYearlyForm(false);
    setEditingYearlyId(null);
    setEditingYearly(null);
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
      // Contract v65 (F17): carry the loaded expense as the CAS
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
        ...(base ? { base } : {}),
      });
    } else addYearly.mutate(input);
  }

  function openSummaryForm(forMonth: string, existingCents?: number) {
    setSMonth(forMonth);
    setSDollars(existingCents != null ? String(existingCents / 100) : "");
    setSummaryBase({ month: forMonth, cashOutCents: existingCents ?? null });
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
    // Contract v65 (F15): the base is the stored total for the
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
    });
  }

  function resetItemForm() {
    setShowItemForm(false);
    setEditingItemId(null);
    setEditingItemBase(null);
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
      // Contract v65 (F18/F16): both saves carry their loaded
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
        { id: editingBillId, name: bName.trim(), paidBy, notes, category: bCategory.trim() || "Uncategorized", keepLightsOn: bKeepLightsOn, ...(billBase ? { base: billBase } : {}) },
        {
          onSuccess: (r) => {
            if (!r.ok) return;
            setBillAmount.mutate({
              billId: editingBillId,
              amountCents: cents,
              effectiveFrom: bEffectiveFrom,
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
    if (editingOneOffId) updateOneOff.mutate({ ...input, id: editingOneOffId });
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
     months ending at the viewed month, from the first month
     with data). The window label is reconstructed from that
     same count, so it names exactly the months averaged. Hidden
     when fewer than 2 months are covered — an average of one
     month is just the month. (It rendered as a standalone
     highlighted banner between the tiles and the chart card
     until 2026-10-25, when it was judged the right numbers in
     the wrong place and it moved into the card, un-highlighted,
     with its wording and figures unchanged.) */
  const showAvgStrip = data != null && data.trailingMonthsCovered >= 2;
  const avgWindowLabel = (() => {
    if (data == null || data.trailingMonthsCovered < 1) return "";
    const covered = data.trailingMonthsCovered;
    const start = shiftMonth(month, -(covered - 1));
    const startShort = MONTH_SHORT[Number(start.slice(5, 7)) - 1] ?? "";
    const endShort = MONTH_SHORT[Number(month.slice(5, 7)) - 1] ?? "";
    if (covered >= 12) {
      return `Last 12 months · ${startShort} ${start.slice(0, 4)}–${endShort} ${month.slice(0, 4)}`;
    }
    if (start.slice(0, 4) === month.slice(0, 4)) {
      return `${startShort}–${endShort} ${month.slice(0, 4)} · ${covered} months`;
    }
    return `${startShort} ${start.slice(0, 4)}–${endShort} ${month.slice(0, 4)} · ${covered} months`;
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
    const captionCls =
      "text-xs font-medium tracking-wide text-[var(--dim)] uppercase";
    return (
      <>
        {/* Grouped by kind, one card per group (2026-10-25,
            option C, replacing the option-A captioned tile grids):
            the first four stats describe the viewed period, inside
            one card captioned by the caller — "This month" in
            Month mode, "This year" in Year mode, since the view
            header already names the specific month/year; the
            last two are standing roster rates that do not change
            with the period, inside their own "Standing rates"
            card. Inside
            each card the stats are borderless cells divided by
            hairlines, stretching to fill the card's full width —
            the period cells sit in one row on desktop and wrap
            2×2 on phone width, so no cell is stranded and no slot
            is left dead. The cells themselves are unchanged — same
            figures, YTD lines, tips, and order within each group. */}
        <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
          <p className={`${captionCls} px-3.5 pt-3.5 sm:px-4 sm:pt-4`}>{opts.periodCaption}</p>
          <div className="grid grid-cols-2 sm:grid-cols-4">
            <QuickTile
              className="border-r border-b border-[var(--border)] sm:border-b-0"
              label="True cost"
              tipId={`qtip-${key("true-cost")}`}
              tip="Real monthly cost — yearly & periodic bills spread evenly. What the month really cost. The month's base (the entered total, the itemized total, or the spending recorded that month), minus any yearly/periodic lump sums that base includes, plus the monthly set-aside for yearly & periodic bills — so big yearly bills are spread evenly instead of spiking one month."
              panelCls="left-0"
              open={openTip === key("true-cost")}
              onToggle={() =>
                setOpenTip(openTip === key("true-cost") ? null : key("true-cost"))
              }
              onClose={() => setOpenTip(null)}
              onDetails={opts.withNav ? () => scrollToSection("section-true-cost") : undefined}
            >
              <p className={tileValueCls}>{fmt(opts.trueCostCents)}</p>
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
              panelCls="right-0 sm:right-auto sm:left-0"
              open={openTip === key("cash-out")}
              onToggle={() =>
                setOpenTip(openTip === key("cash-out") ? null : key("cash-out"))
              }
              onClose={() => setOpenTip(null)}
              onDetails={opts.withNav ? () => scrollToSection("section-cash-out") : undefined}
            >
              <p className={tileValueCls}>{fmt(opts.cashOutCents)}</p>
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
              panelCls="left-0 sm:left-auto sm:right-0"
              open={openTip === key("everything-else")}
              onToggle={() =>
                setOpenTip(
                  openTip === key("everything-else") ? null : key("everything-else"),
                )
              }
              onClose={() => setOpenTip(null)}
              onDetails={opts.withNav ? () => openExplorer("month") : undefined}
            >
              <p className={tileValueCls}>{fmt(opts.everythingElseCents)}</p>
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
              label="Yearly & periodic expenses"
              tipId={`qtip-${key("yearly-paid-out")}`}
              tip="Yearly & periodic bills actually paid this month. Yearly & periodic bills you entered as paid — the lump sums that went out, in the month the money left your bank account. A bill isn't always paid in its due month, and if it was charged to a credit card, it counts in the month the card payment left your account — enter that date when you record it."
              panelCls="right-0"
              open={openTip === key("yearly-paid-out")}
              onToggle={() =>
                setOpenTip(
                  openTip === key("yearly-paid-out") ? null : key("yearly-paid-out"),
                )
              }
              onClose={() => setOpenTip(null)}
              onDetails={opts.withNav ? () => scrollToSection("section-yearly-expenses") : undefined}
            >
              <p className={tileValueCls}>{fmt(opts.yearlyPaidOutCents)}</p>
              {opts.withNav && opts.ytd && opts.ytd.yearlyPaidOutCents !== opts.yearlyPaidOutCents && (
                <p className="tnum mt-1.5 text-xs whitespace-nowrap text-[var(--dim)]">
                  YTD {fmt(opts.ytd.yearlyPaidOutCents)}
                </p>
              )}
            </QuickTile>
          </div>
        </div>
        <div className="mt-3.5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
          <p className={`${captionCls} px-3.5 pt-3.5 sm:px-4 sm:pt-4`}>Standing rates</p>
          <div className="grid grid-cols-2">
            <QuickTile
              className="border-r border-[var(--border)]"
              label="Total monthly"
              tipId={`qtip-${key("total-monthly")}`}
              tip="Your recurring monthly bills — all your monthly bills for this month added together (the Monthly bills list)."
              panelCls="left-0"
              open={openTip === key("total-monthly")}
              onToggle={() =>
                setOpenTip(openTip === key("total-monthly") ? null : key("total-monthly"))
              }
              onClose={() => setOpenTip(null)}
              onDetails={opts.withNav ? () => scrollToSection("section-monthly-bills") : undefined}
            >
              <p className={tileValueCls}>
                {fmt(opts.totalMonthlyCents)}
                {opts.withNav && (
                  <span className="text-[11px] font-normal text-[var(--dim)]"> /mo</span>
                )}
              </p>
              {opts.withNav && opts.ytd && opts.ytd.totalMonthlyCents !== opts.totalMonthlyCents && (
                <p className="tnum mt-1.5 text-xs whitespace-nowrap text-[var(--dim)]">
                  YTD {fmt(opts.ytd.totalMonthlyCents)}
                </p>
              )}
            </QuickTile>
            <QuickTile
              label="Keep the lights on"
              tipId={`qtip-${key("lights-on")}`}
              tip="Bare-minimum bills to keep things running. The bills you checked as essential: checked monthly bills plus the set-asides of checked yearly/periodic bills. The must-pay floor for the month."
              panelCls="right-0 sm:right-auto sm:left-0"
              open={openTip === key("lights-on")}
              onToggle={() =>
                setOpenTip(openTip === key("lights-on") ? null : key("lights-on"))
              }
              onClose={() => setOpenTip(null)}
              onDetails={opts.withNav ? () => scrollToSection("section-keep-lights-on") : undefined}
            >
              <p className={tileValueCls}>{fmt(opts.keepLightsOnCents)}</p>
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
          <RetirementCalc />
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
          <RothConversion />
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
          <Playground />
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
            <button
              type="button"
              aria-label="Previous month"
              className={btnGhost}
              onClick={() => setMonth(shiftMonth(month, -1))}
            >
              ←
            </button>
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
            <button
              type="button"
              aria-label="Next month"
              className={btnGhost}
              onClick={() => setMonth(shiftMonth(month, 1))}
            >
              →
            </button>
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
            {/* slice & dice entry — slim one-line row */}
            <section aria-label="Explore the data" className="mt-5">
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-left text-sm text-[var(--dim)] hover:border-[var(--accent)] hover:text-[var(--text)] sm:px-4"
                onClick={() => openExplorer("category")}
              >
                <span className="min-w-0 truncate whitespace-nowrap">
                  <span className="font-medium text-[var(--text)]">Slice &amp; dice</span>
                  {" — explore data, download CSV"}
                </span>
                <span aria-hidden="true" className="shrink-0 text-[var(--accent)]">→</span>
              </button>
            </section>

            {showExplorer && (
              <ExplorerModal
                viewedMonth={month}
                earliestMonth={data.reserveStartMonth ?? data.summaries[0]?.month ?? null}
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
                <div
                  role="group"
                  aria-label="Quick view mode"
                  className="flex overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]"
                >
                  <button
                    type="button"
                    aria-label="Month view"
                    aria-pressed={!inYearMode}
                    onClick={() => setQuickMode("month")}
                    className={`px-3 py-1.5 text-sm font-medium ${!inYearMode ? "bg-[var(--accent)] text-white" : "text-[var(--text)] hover:text-[var(--accent)]"}`}
                  >
                    Month
                  </button>
                  <button
                    type="button"
                    aria-label="Year view"
                    aria-pressed={inYearMode}
                    onClick={() => {
                      if (!inYearMode) {
                        setViewYear(Number(month.slice(0, 4)));
                        setQuickMode("year");
                      }
                    }}
                    className={`px-3 py-1.5 text-sm font-medium ${inYearMode ? "bg-[var(--accent)] text-white" : "text-[var(--text)] hover:text-[var(--accent)]"}`}
                  >
                    Year
                  </button>
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
                  {/* True cost vs Cash out bars: the last
                      trailingMonthsCovered history entries are exactly
                      the months the averages line averages (the
                      history's final entry is the viewed month), so
                      the chart and the line show the same figures.
                      slice from the end keeps that true for any
                      covered count, including 0 (no recorded months —
                      the chart renders its empty state). The chart —
                      and only the chart — then continues past the
                      viewed month with enteredAheadMonths: later
                      months that already have entered figures, each
                      with its own dashboard figures; the line, tiles
                      and everything else stay on the viewed month.
                      The averages line itself renders inside the
                      chart card, under its subheading (see
                      averageLine on SpendingTrueCostChart). */}
                  <SpendingTrueCostChart
                    months={data.history.slice(
                      data.history.length - data.trailingMonthsCovered,
                    )}
                    aheadMonths={data.enteredAheadMonths}
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
                            periodCaption: "This year",
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
                <p className="text-sm font-medium text-[var(--dim)]">
                  {monthLabel(month)} — your true monthly cost
                </p>
                <QuickViewReturnLink onReturn={scrollToQuickView} />
              </div>
              <p className="display tnum mt-1 text-5xl font-semibold">
                {fmt(data.smoothedCents)}
              </p>
              {/* The section's one explainer door: the definition
                  sentence that used to print here now lives in the
                  True cost tile's ⓘ, so only the "More" link remains
                  under the number. Its expanded text carries both
                  this explainer's original paragraph and the full
                  text of the former footer "How this math works"
                  explainer, folded in here so the method is explained
                  in exactly one place. */}
              <Explainer
                id="spending.trueCost"
                label="True cost"
                className="mt-1"
                summary=""
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
                  smoothed bills that left checking that month + the
                  set-aside. The entered total replaces that month's
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
              </Explainer>
              {data.isSummaryMonth || data.isItemsMonth ? (
                <dl className="tnum mt-4 space-y-1 border-t border-[var(--border)] pt-3 text-base">
                  <div className="flex justify-between gap-3">
                    <dt>
                      {data.isItemsMonth
                        ? `Cash out from this month's items (${data.cashOutItemsCount} item${data.cashOutItemsCount === 1 ? "" : "s"})`
                        : "Cash out you entered for this month"}
                    </dt>
                    <dd className="font-medium">
                      {fmt(data.isItemsMonth ? data.cashOutItemsTotalCents : (data.enteredCashOutCents ?? 0))}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3 text-[var(--dim)]">
                    <dt>− Smoothed bills that left checking this month</dt>
                    <dd>{fmt(data.yearlyLumpsCheckingCents)}</dd>
                  </div>
                  <div className="flex justify-between gap-3 text-[var(--dim)]">
                    <dt>
                      + Smoothed-bill set-aside (sum of this month&rsquo;s
                      in-effect bills&rsquo; monthly amounts —{" "}
                      {fmt(data.totalAnnualCents)} a year in effect this month)
                    </dt>
                    <dd>{fmt(data.accrualCents)}</dd>
                  </div>
                  <div className="flex justify-between gap-3 border-t border-[var(--border)] pt-2 font-semibold">
                    <dt>= Smoothed spend</dt>
                    <dd>{fmt(data.smoothedCents)}</dd>
                  </div>
                </dl>
              ) : (
                <dl className="tnum mt-4 space-y-1 border-t border-[var(--border)] pt-3 text-base">
                  <div className="flex justify-between gap-3">
                    <dt>Spending recorded this month</dt>
                    <dd className="font-medium">{fmt(data.incurredCents)}</dd>
                  </div>
                  <div className="flex justify-between gap-3 text-[var(--dim)]">
                    <dt>− Smoothed bills paid this month</dt>
                    <dd>{fmt(data.yearlyLumpsCents)}</dd>
                  </div>
                  <div className="flex justify-between gap-3 text-[var(--dim)]">
                    <dt>
                      + Smoothed-bill set-aside (sum of this month&rsquo;s
                      in-effect bills&rsquo; monthly amounts —{" "}
                      {fmt(data.totalAnnualCents)} a year in effect this month)
                    </dt>
                    <dd>{fmt(data.accrualCents)}</dd>
                  </div>
                  <div className="flex justify-between gap-3 border-t border-[var(--border)] pt-2 font-semibold">
                    <dt>= Smoothed spend</dt>
                    <dd>{fmt(data.smoothedCents)}</dd>
                  </div>
                </dl>
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
                      periodic) recorded as paid from checking (
                      {fmt(data.yearlyLumpsCheckingCents)}) are still subtracted
                      in the formula above, so they aren't counted twice.
                      {data.isItemsMonth
                        ? " Delete the items below if you'd rather use the month's entered total or its transactions."
                        : " Delete the entered total below if you'd rather use the transactions."}
                    </p>
                  )}
                </div>
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
                <h2 className="display text-lg font-semibold">
                  By category — {monthLabel(month)}
                </h2>
                <div className="flex flex-wrap items-center gap-3">
                  <p className="display tnum text-3xl font-semibold">
                    {fmt(data.categoryBreakdownTotalCents)}
                    <span className="text-base font-normal text-[var(--dim)]"> /mo</span>
                  </p>
                  {data.categoryBreakdown.length > 0 && (
                    <button
                      type="button"
                      className={btnGhost}
                      aria-expanded={!data.byCategoryCollapsedAll}
                      aria-controls="by-category-list"
                      onClick={() =>
                        setByCategoryCollapsedAll.mutate({
                          collapsed: !data.byCategoryCollapsedAll,
                        })
                      }
                    >
                      {data.byCategoryCollapsedAll ? "Expand all" : "Collapse all"}
                    </button>
                  )}
                </div>
              </div>
              {!data.byCategoryCollapsedAll && (
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
              {!data.byCategoryCollapsedAll && (data.categoryBreakdown.length === 0 ? (
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
              {!data.byCategoryCollapsedAll && data.categoryBreakdown.length > 0 && (
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
                  <dd>{fmt(data.keepLightsOnMonthlyCents)}/mo</dd>
                </div>
                <div className="flex justify-between gap-3 text-[var(--dim)]">
                  <dt>+ Checked smoothed bills (set-aside)</dt>
                  <dd>{fmt(data.keepLightsOnSmoothedCents)}/mo</dd>
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
                  <ExplainerToggle id="spending.largeOneOffs" label="Large one-offs" />
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
                    <input id="o-desc" type="text" required className={inputCls} value={oDesc} onChange={(e) => setODesc(e.target.value)} placeholder="e.g. Car repair" />
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
                      <li key={o.id} className="flex items-start justify-between gap-3 p-3">
                        <div className="min-w-0">
                          <p className="text-base font-medium">{o.description}</p>
                          {o.note && <p className="text-sm text-[var(--dim)]">{o.note}</p>}
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <span className="tnum text-base font-medium">{fmt(o.amountCents)}</span>
                          <button type="button" aria-label={`Edit ${o.description}`} className="px-1 py-1 text-sm text-[var(--accent)]" onClick={() => openEditOneOff(o)}>
                            Edit
                          </button>
                          <button type="button" aria-label={`Delete ${o.description}`} className="px-1 py-1 text-sm text-[var(--bad)]" onClick={() => deleteOneOff.mutate(o.id)}>
                            ✕
                          </button>
                        </div>
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
                  <ExplainerToggle id="spending.cashOut" label="Monthly cash out" />
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
                    <button type="button" className={btnGhost} onClick={() => setShowSummaryForm(false)}>
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
                    <label htmlFor="ci-desc" className={labelCls}>Description</label>
                    <input id="ci-desc" type="text" required className={inputCls} value={iDesc} onChange={(e) => setIDesc(e.target.value)} placeholder="e.g. Groceries" />
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
                              <span className="ml-2 text-xs font-normal text-[var(--accent)]">viewing</span>
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
                                <button type="button" aria-label={`Delete cash out for ${monthLabel(cm.month)}`} className="px-1 py-1 text-sm text-[var(--bad)]" onClick={() => deleteSummary.mutate(cm.month)}>
                                  ✕
                                </button>
                              </>
                            )}
                          </div>
                        </div>
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
                          <div className="mt-2 border-t border-[var(--border)] pt-2">
                            {cm.items.length === 0 ? (
                              <p className="text-sm text-[var(--dim)]">
                                No items yet for {monthLabel(cm.month)} — add
                                the first one and it starts rolling up right away.
                              </p>
                            ) : (
                              <ul className="divide-y divide-[var(--border)]">
                                {cm.items.map((it) => (
                                  <li key={it.id} className="flex items-start justify-between gap-3 py-2">
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
                                      <button type="button" aria-label={`Delete ${it.description}`} className="px-1 py-1 text-sm text-[var(--bad)]" onClick={() => deleteCashOutItem.mutate(it.id)}>
                                        ✕
                                      </button>
                                    </div>
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

            {/* monthly bills — breakdown of cash out, never added again */}
            <section id="section-monthly-bills" aria-label="Monthly bills" className={`mt-8 scroll-mt-4 rounded-[var(--radius)]${highlightCls("section-monthly-bills")}`}>
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                <h2 className="display min-w-0 text-xl font-semibold">
                  Monthly bills
                  <span className="tnum ml-2 text-base font-normal text-[var(--dim)]">
                    {fmt(data.monthlyBillsTotalCents)}/mo
                  </span>
                </h2>
                <div className="ml-auto flex flex-nowrap items-center gap-2">
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
                  {/* No summary sentence on the face: the "already included
                      in cash out, never added a second time" point lives in
                      the info tooltip in this header row's control cluster,
                      whose full text is the former "More" text, verbatim. */}
                  <ExplainerInfoTip id="spending.monthlyBills" label="Monthly bills">
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
                  <BillsFoldChevron
                    open={monthlyBillsOpen}
                    controlsId="monthly-bills-roster"
                    onToggle={() => setMonthlyBillsOpen(!monthlyBillsOpen)}
                  />
                </div>
              </div>

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
                      aria-expanded={!data.monthlyBillsCollapsedAll}
                      aria-controls="monthly-bills-list"
                      onClick={() =>
                        setMonthlyBillsCollapsedAll.mutate({
                          collapsed: !data.monthlyBillsCollapsedAll,
                        })
                      }
                    >
                      {data.monthlyBillsCollapsedAll ? "Expand all" : "Collapse all"}
                    </button>
                  </div>
                  <ul id="monthly-bills-list" className="mt-2 divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
                    {data.monthlyBills.map((b) => (
                      <li key={b.id} className="px-3 py-2">
                        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
                          <div className="min-w-0">
                            <p className="truncate text-base font-medium">{b.name}</p>
                            {!data.monthlyBillsCollapsedAll && (
                              <p className="text-xs text-[var(--dim)]">
                                paid from {b.paidBy}
                                {b.notes ? ` · ${b.notes}` : ""}
                              </p>
                            )}
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <span className="tnum text-base font-medium">
                              {b.effectiveFrom
                                ? `${fmt(b.amountCents)}/mo`
                                : "not yet in effect"}
                            </span>
                            {!data.monthlyBillsCollapsedAll && (
                              <>
                                <button type="button" aria-label={`Edit ${b.name}`} className="px-1 py-1 text-sm text-[var(--accent)]" onClick={() => openEditBill(b)}>
                                  Edit
                                </button>
                                <button type="button" aria-label={`Delete ${b.name}`} className="px-1 py-1 text-sm text-[var(--bad)]" onClick={() => deleteBill.mutate(b.id)}>
                                  ✕
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                        {!data.monthlyBillsCollapsedAll && (
                          <div>
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
                    ))}
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
            <section aria-label="Transactions" className="mt-6">
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                <h2 className="display min-w-0 text-xl font-semibold">
                  Transactions — {monthLabel(month)}
                </h2>
                <div className="ml-auto flex flex-nowrap items-center gap-2">
                  <button type="button" className={btnGhost} onClick={() => setShowImport(!showImport)} aria-expanded={showImport}>
                    Import
                  </button>
                  <button type="button" className={btnAdd} onClick={() => openNewTxn()}>
                    + Add
                  </button>
                  <ExplainerInfoTip id="spending.transactions" label="Transactions">
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
                </div>
              </div>

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

              {data.monthTransactions.length === 0 && !showTxnForm && (
                <p className="mt-3 rounded-[var(--radius)] border border-dashed border-[var(--border)] p-4 text-sm text-[var(--dim)]">
                  {data.isItemsMonth
                    ? `No individual transactions for ${monthLabel(month)} — this month is covered by its cash-out items above, so none are needed.`
                    : data.isSummaryMonth
                      ? `No individual transactions for ${monthLabel(month)} — this month is covered by the cash-out total you entered above, so none are needed.`
                      : `Nothing recorded for ${monthLabel(month)} yet. Add a transaction, import a CSV from your bank or card, or enter one cash-out total for the month above.`}
                </p>
              )}
              <ul className="mt-3 divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] empty:hidden">
                {data.monthTransactions.map((t) => (
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
                      <button type="button" aria-label={`Delete ${t.description}`} className="px-1 py-1 text-sm text-[var(--bad)]" onClick={() => deleteTxn.mutate(t.id)}>
                        ✕
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            {/* yearly & periodic (smoothed) bills */}
            <section id="section-yearly-expenses" aria-label="Yearly & periodic expenses" className={`mt-8 scroll-mt-4 rounded-[var(--radius)]${highlightCls("section-yearly-expenses")}`}>
              {/* Header follows the settled single-row pattern (same as
                  Monthly bills above): title + summary on the left,
                  control cluster on the right, fold toggle last. The
                  row never wraps — the long summary wraps within the
                  left side instead, so the cluster stays on the title
                  row at every width. */}
              <div className="flex flex-nowrap items-center justify-between gap-x-3">
                <h2 className="display min-w-0 flex-1 text-xl font-semibold">
                  Yearly &amp; periodic expenses
                  {/* inline-block: a line-break opportunity before the
                      summary (and wrapping inside it), so at narrow
                      widths the summary wraps within the left side
                      instead of running underneath the cluster. On one
                      line it renders exactly as the inline span did. */}
                  <span className="tnum ml-2 inline-block text-base font-normal text-[var(--dim)]">
                    {fmt(data.totalAnnualCents)}/yr · set aside {fmt(data.accrualCents)}/mo
                  </span>
                </h2>
                <div className="ml-auto flex shrink-0 flex-nowrap items-center gap-2">
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
                  {/* No summary sentence on the face: the key figures now
                      live in the header above, and the spread-evenly method
                      plus the future-bill $0 rule live in the info tooltip
                      in the header row's control cluster, whose full text
                      is the former "More" text, verbatim. */}
                  <ExplainerInfoTip id="spending.yearlyPeriodic" label="Yearly & periodic expenses">
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
                  <BillsFoldChevron
                    open={yearlyBillsOpen}
                    controlsId="yearly-bills-roster"
                    onToggle={() => setYearlyBillsOpen(!yearlyBillsOpen)}
                  />
                </div>
              </div>

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
                        aria-expanded={!data.yearlyBillsCollapsedAll}
                        aria-controls="yearly-bills-list"
                        onClick={() =>
                          setYearlyBillsCollapsedAll.mutate({
                            collapsed: !data.yearlyBillsCollapsedAll,
                          })
                        }
                      >
                        {data.yearlyBillsCollapsedAll ? "Expand all" : "Collapse all"}
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
                              // Pre-start preview (contract v63, F3):
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
                      {!data.yearlyBillsCollapsedAll && (
                        <div className="ml-auto flex shrink-0 gap-1">
                          <button type="button" aria-label={`Edit ${y.name}`} className="px-1 py-1 text-sm text-[var(--accent)]" onClick={() => openEditYearly(y)}>
                            Edit
                          </button>
                          <button type="button" aria-label={`Delete ${y.name}`} className="px-1 py-1 text-sm text-[var(--bad)]" onClick={() => deleteYearly.mutate(y.id)}>
                            ✕
                          </button>
                        </div>
                      )}
                    </div>
                    {!data.yearlyBillsCollapsedAll && (
                      <>
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
                the sections' persisted Collapse all / Expand all
                system and defaults to collapsed on first load. */}
            <YearInSpendingBlock
              collapsed={data.yearInSpendingCollapsedAll}
              onToggleCollapsed={() =>
                setYearInSpendingCollapsedAll.mutate({
                  collapsed: !data.yearInSpendingCollapsedAll,
                })
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
  // Contract v65 (F26): the settings pair as loaded when the fold
  // opened — the save's CAS base.
  const [base, setBase] = useState<{
    openingReserveCents: number;
    reserveStartMonth: string | null;
  } | null>(null);
  const save = useMutation({
    mutationFn: () =>
      api.updateSettings({
        openingReserveCents: parseDollars(opening) ?? 0,
        reserveStartMonth: start ? start : null,
        ...(base ? { base } : {}),
      }),
    onSuccess: (r) => {
      if (!r.ok) {
        // CAS refusal (contract v65, F26): show why instead of
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
    mutationFn: (json: string) => api.saveImportSettings({ settingsJson: json }),
    // A failed save never blocks an import — the panel just
    // keeps working with the values on screen.
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
  // Batch idempotency keys (contract v64, F02): each 500-row batch
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
          const r = await api.importTransactions({ rows: batch, batchKey });
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
    } catch {
      setDupFlags(null);
      setExactFlags(null);
      setRecordedCashOut(null);
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
          await api.deleteCashOutItem({ id: it.id });
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
      // Contract v65 (F15): the base is the month's recorded
      // entered total as this comparison loaded it — a refused
      // (conflicted) save throws into the proposal error path
      // below instead of silently overwriting a newer total.
      const summaryRes = await api.upsertMonthlySummary({
        month: p.month,
        cashOutCents: p.totalCents,
        base: { cashOutCents: rec?.enteredCashOutCents ?? null },
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
