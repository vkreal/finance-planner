import { useEffect, useId, useRef, useState } from "react";
import { api, type ApiResponse } from "./api";

/* Helpers shared by the Roth Conversion view and the Playground
   view (promoted out of the Roth view's tabs): money formatting
   and parsing, the field/class vocabulary, the ⓘ note, and the
   money / number / percent field renderers. ONE implementation,
   imported by both views — the same code both views ran when
   the Playground was a Roth tab. */

export type RothData = ApiResponse<typeof api, "getRothPlanner">;
export type RetData = ApiResponse<typeof api, "getRetirementCalc">;

export function fmtDollars(dollars: number): string {
  const neg = dollars < 0;
  const abs = Math.abs(Math.round(dollars));
  const s = `$${abs.toLocaleString("en-US")}`;
  return neg ? `−${s}` : s;
}
export function fmtCents(cents: number): string {
  return fmtDollars(cents / 100);
}
export function fmtCompactDollars(d: number): string {
  if (Math.abs(d) >= 1_000_000) return `$${(d / 1_000_000).toFixed(2)}M`;
  if (Math.abs(d) >= 1_000) return `$${Math.round(d / 1_000)}k`;
  return `$${Math.round(d)}`;
}
export function parseMoney(s: string): number | null {
  const cleaned = s.replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}
export function parseDollars(s: string): number | null {
  const c = parseMoney(s);
  return c == null ? null : c / 100;
}
export function parseNum(s: string): number | null {
  const cleaned = s.replace(/[%\s]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
// Display form for a dollar amount inside an input: grouped
// thousands, cents shown only when the amount has them. The $
// itself is a separate adornment on the field, and parseMoney
// strips grouping commas, so this string round-trips exactly.
export function fmtMoneyInput(dollars: number): string {
  return dollars.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
export function parseIntField(s: string): number | null {
  const n = parseNum(s);
  return n == null ? null : Math.round(n);
}

export const inputCls =
  "w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)]";
export const labelCls = "block text-sm font-medium text-[var(--text)] mb-1";
export const hintCls = "mt-1 text-xs text-[var(--dim)]";
export const sectionCls =
  "mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-4";
export const pillCls =
  "tnum inline-flex max-w-full items-start gap-1.5 rounded-[var(--radius)] bg-[var(--bad-soft)] px-2.5 py-1.5 text-xs font-medium text-[var(--bad)] sm:text-sm";
export const ceilChipCls =
  "inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2 text-sm font-medium text-[var(--text)] hover:text-[var(--accent)]";
export const ceilChipActiveCls =
  "inline-flex items-center rounded-full border border-[var(--accent)] bg-[var(--accent)] px-3.5 py-2 text-sm font-medium text-white";

export type FilingStatus = "mfj" | "single" | "hoh";

export const FILING_LABELS: Record<FilingStatus, string> = {
  mfj: "Married filing jointly",
  single: "Single",
  hoh: "Head of household",
};

// Seed defaults (used on a fresh open, before anything is saved)
// live in ONE place — server/src/rothSeed.ts, which also builds
// the seeded record itself (seedRothInputs) — shared with the
// server's resetRothPlanner action so a fresh open and a reset
// can never diverge. Re-exported here for existing importers.
export {
  SEED_BIRTH_YEAR_PRIMARY,
  SEED_BIRTH_YEAR_SPOUSE,
  SEED_HEIR_RATE,
  SEED_INFLATION,
  SEED_PRESERVE_PRETAX_CENTS,
  SEED_PROTECT_MIN_CENTS,
  SEED_SS_PRIMARY_CENTS,
  SEED_SS_START_AGE,
} from "@space/server/rothSeed";

/* Small ⓘ info button + tooltip carrying one short plain-terms
   note, copied from the Net Worth view's InfoNote (itself modeled
   on BucketHelp there): hovering or focusing the button shows the
   bubble, tapping or clicking pins it open, tapping outside or
   pressing Escape closes a pinned bubble. It sits beside a field's
   label — never inside the label and never over the field — so
   revealing it can never focus or change an input. `align` keeps
   the bubble inside the page horizontally: fields in the right
   half of a grid open theirs to the left. `viewportClamp` is for
   buttons inside a horizontally scrolling region (the strategy
   comparison table): the bubble then renders fixed to the
   viewport, starting from the `align` side of the button and
   clamped inside the viewport's edges, so the whole note stays
   readable at phone width wherever the table is scrolled to;
   the bubble's look and the tap/hover/Escape behavior are
   unchanged, and it follows the button on scroll and resize.
   `liftPx` (contract v82, used by one caller) adds extra clear
   space between an above-placed bubble and its button, so the
   bubble can clear a neighbouring row above the button — the
   default 0 keeps every existing caller's geometry exactly. */
export function InfoNote({
  text,
  ariaLabel,
  align = "left",
  placement = "below",
  viewportClamp = false,
  liftPx = 0,
}: {
  text: string;
  ariaLabel: string;
  align?: "left" | "right";
  placement?: "below" | "above";
  viewportClamp?: boolean;
  /** Extra px of gap above the button for an above-placed bubble. */
  liftPx?: number;
}) {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [bubblePos, setBubblePos] = useState<{
    left: number;
    top?: number;
    bottom?: number;
  } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const rawId = useId();
  const tipId = `roth-info-tip-${rawId.replace(/[^a-zA-Z0-9]/g, "")}`;
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

  useEffect(() => {
    if (!show || !viewportClamp) return;
    const update = () => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const width = Math.min(224, Math.max(0, vw - 48));
      let left = align === "right" ? r.right - width : r.left;
      left = Math.min(Math.max(left, 8), Math.max(8, vw - width - 8));
      if (placement === "above") {
        setBubblePos({
          left,
          bottom: window.innerHeight - r.top + 6 + liftPx,
        });
      } else {
        setBubblePos({ left, top: r.bottom + 6 });
      }
    };
    update();
    window.addEventListener("resize", update);
    document.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      document.removeEventListener("scroll", update, true);
    };
  }, [show, viewportClamp, align, placement, liftPx]);

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
      {show && viewportClamp && bubblePos && (
        <span
          id={tipId}
          role="tooltip"
          style={{
            position: "fixed",
            left: bubblePos.left,
            top: bubblePos.top,
            bottom: bubblePos.bottom,
          }}
          className="z-40 block w-56 max-w-[calc(100vw-3rem)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-2.5 text-xs leading-relaxed font-normal whitespace-normal text-[var(--text)] shadow-lg"
        >
          {text}
        </span>
      )}
      {show && !viewportClamp && (
        <span
          id={tipId}
          role="tooltip"
          style={
            placement === "above" && liftPx > 0
              ? { marginBottom: 6 + liftPx }
              : undefined
          }
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

  // Dollar field: the unit lives on the field as a $ prefix, and
  // the value is entered and shown in dollars (grouped). On blur
  // the typed text is rewritten to the canonical grouped form, so
  // what is saved and reloaded displays exactly what was entered.
/* Visible marker shown beside a field's label when the field's
   current value differs from the saved record. Shared by the
   three field renderers below and by hand-rendered controls in
   the Roth Conversion view, so a changed field reads the same
   way everywhere. Presentation only — it never touches the
   field's value or behaviour. */
export function ChangedMark() {
  return (
    <span className="ml-2 inline-flex shrink-0 items-center gap-1 align-middle text-xs font-medium text-[var(--accent)]">
      <span aria-hidden="true">●</span>
      Changed
    </span>
  );
}

export const moneyField = (
  label: string,
  value: string,
  set: (v: string) => void,
  opts?: {
    hint?: string;
    ariaLabel?: string;
    // When true, the label carries the "Changed" marker — the
    // field's current value differs from the saved record.
    changed?: boolean;
    // Identity override: when set, this string — never the displayed
    // label — generates the input's id, its label's htmlFor, its
    // aria-label, and the info note's name. For scratch copies of a
    // field whose visible label matches a saved-plan field elsewhere
    // on the page, so the two never share an id or accessible name.
    idLabel?: string;
    onEdit?: () => void;
    disabled?: boolean;
    info?: string;
    infoAlign?: "left" | "right";
  },
) => {
  const idText = opts?.idLabel ?? label;
  const fieldId = `roth-${idText.replace(/[^a-z0-9]+/gi, "-")}`;
  return (
  <div>
    {opts?.info ? (
      <div className="mb-1 flex items-center">
        <label
          className="block text-sm font-medium text-[var(--text)]"
          htmlFor={fieldId}
        >
          {label}
        </label>
        <InfoNote
          text={opts.info}
          ariaLabel={`About ${idText}`}
          align={opts.infoAlign ?? "left"}
        />
        {opts?.changed && <ChangedMark />}
      </div>
    ) : (
      <label className={labelCls} htmlFor={fieldId}>
        {label}
        {opts?.changed && <ChangedMark />}
      </label>
    )}
    <div className="relative">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-base text-[var(--dim)]"
      >
        $
      </span>
      <input
        id={fieldId}
        aria-label={opts?.ariaLabel ?? idText}
        className={`${inputCls} pl-7 disabled:opacity-60`}
        inputMode="decimal"
        value={value}
        disabled={opts?.disabled ?? false}
        placeholder={opts?.disabled ? "No benefit" : undefined}
        onChange={(e) => {
          set(e.target.value);
          opts?.onEdit?.();
        }}
        onBlur={() => {
          const d = parseDollars(value);
          if (d != null) set(fmtMoneyInput(d));
        }}
      />
    </div>
    {opts?.hint && <p className={hintCls}>{opts.hint}</p>}
  </div>
  );
};
export const numField = (
  label: string,
  value: string,
  set: (v: string) => void,
  opts?: {
    hint?: string;
    // Identity override: see moneyField — generates the input's id,
    // htmlFor, aria-label, and info-note name in place of the
    // displayed label when set.
    idLabel?: string;
    disabled?: boolean;
    info?: string;
    infoAlign?: "left" | "right";
    // When true, the label carries the "Changed" marker — the
    // field's current value differs from the saved record.
    changed?: boolean;
  },
) => {
  const idText = opts?.idLabel ?? label;
  const fieldId = `roth-${idText.replace(/[^a-z0-9]+/gi, "-")}`;
  return (
  <div>
    {opts?.info ? (
      <div className="mb-1 flex items-center">
        <label
          className="block text-sm font-medium text-[var(--text)]"
          htmlFor={fieldId}
        >
          {label}
        </label>
        <InfoNote
          text={opts.info}
          ariaLabel={`About ${idText}`}
          align={opts.infoAlign ?? "left"}
        />
        {opts?.changed && <ChangedMark />}
      </div>
    ) : (
      <label className={labelCls} htmlFor={fieldId}>
        {label}
        {opts?.changed && <ChangedMark />}
      </label>
    )}
    <input
      id={fieldId}
      aria-label={idText}
      className={`${inputCls} disabled:opacity-60`}
      inputMode="decimal"
      value={value}
      disabled={opts?.disabled ?? false}
      onChange={(e) => set(e.target.value)}
    />
    {opts?.hint && <p className={hintCls}>{opts.hint}</p>}
  </div>
  );
};
// Percent field: the unit lives on the field as a % suffix, and
// the value is entered and shown as a plain percent number —
// 22 means 22%, never a decimal. On blur the typed text is
// rewritten to the canonical number, so a typed "%" or trailing
// zeros do not linger into the saved/displayed value.
export const pctField = (
  label: string,
  value: string,
  set: (v: string) => void,
  opts?: {
    hint?: string;
    // Identity override: see moneyField — generates the input's id,
    // htmlFor, aria-label, and info-note name in place of the
    // displayed label when set.
    idLabel?: string;
    info?: string;
    infoAlign?: "left" | "right";
    // When true, the label carries the "Changed" marker — the
    // field's current value differs from the saved record.
    changed?: boolean;
  },
) => {
  const idText = opts?.idLabel ?? label;
  const fieldId = `roth-${idText.replace(/[^a-z0-9]+/gi, "-")}`;
  return (
  <div>
    {opts?.info ? (
      <div className="mb-1 flex items-center">
        <label
          className="block text-sm font-medium text-[var(--text)]"
          htmlFor={fieldId}
        >
          {label}
        </label>
        <InfoNote
          text={opts.info}
          ariaLabel={`About ${idText}`}
          align={opts.infoAlign ?? "left"}
        />
        {opts?.changed && <ChangedMark />}
      </div>
    ) : (
      <label className={labelCls} htmlFor={fieldId}>
        {label}
        {opts?.changed && <ChangedMark />}
      </label>
    )}
    <div className="relative">
      <input
        id={fieldId}
        aria-label={idText}
        className={`${inputCls} pr-8`}
        inputMode="decimal"
        value={value}
        onChange={(e) => set(e.target.value)}
        onBlur={() => {
          const n = parseNum(value);
          if (n != null) set(String(n));
        }}
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-base text-[var(--dim)]"
      >
        %
      </span>
    </div>
    {opts?.hint && <p className={hintCls}>{opts.hint}</p>}
  </div>
  );
};
