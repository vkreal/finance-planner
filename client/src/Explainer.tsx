import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/* One-line summary + ⓘ pattern for long section intros.
   The visible text is ONE tight summary line (the `summary`
   prop); the section's FULL ORIGINAL TEXT (the children) lives
   in the ⓘ tooltip beside it, verbatim — the original wording
   is never rewritten or deleted, it just lives behind the info
   affordance. (Contract v67 retired the former "More"/"Less"
   in-place fold app-wide: every Explainer now renders this
   shape, and the persisted expanded/collapsed state the fold
   used is no longer read here.) */

/* The ⓘ info affordance for a section's explainer text: an 18px
   circled-i button; hovering or focusing it shows the bubble,
   tapping or clicking pins it open, tapping outside or pressing
   Escape closes a pinned bubble. The bubble carries the
   section's FULL explainer text (the children) verbatim. The
   bubble opens right-aligned under the button so it stays
   inside the page at the header's right edge. */
export function ExplainerInfoTip({
  id,
  label,
  children,
}: {
  /** Stable per-section id, matching the explainer it serves. */
  id: string;
  /** Section name used in the control's accessible label. */
  label: string;
  /** The section's full explainer text, rendered verbatim in the bubble. */
  children: ReactNode;
}) {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const rawId = useId();
  const tipId = `explainer-${id.replace(/[^a-zA-Z0-9]+/g, "-")}-${rawId.replace(/[^a-zA-Z0-9]/g, "")}`;
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
      className="relative inline-flex shrink-0 items-center"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        aria-label={`More about ${label}`}
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
          className="absolute top-full right-0 z-40 mt-1.5 block w-80 max-w-[calc(100vw-2.5rem)] space-y-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3 text-sm leading-relaxed font-normal whitespace-normal text-[var(--dim)] shadow-lg"
        >
          {children}
        </span>
      )}
    </span>
  );
}

export function Explainer({
  id,
  label,
  summary,
  className = "",
  small = false,
  children,
}: {
  /** Stable per-section id, e.g. "spending.keepLightsOn". */
  id: string;
  /** Section name used in the info control's accessible label. */
  label: string;
  /** The one-line summary that stays visible. Omit it (or pass an
      empty string) when the section's face carries no summary
      sentence — the ⓘ then stands alone and the full text still
      lives in its tooltip. */
  summary?: ReactNode;
  /** Wrapper classes (margins) carried over from the original block. */
  className?: string;
  /** Render at the smaller field-note size (text-xs) instead of text-sm. */
  small?: boolean;
  /** Accepted for call-site compatibility with the retired
      header-toggle pattern; the ⓘ now always renders with the
      summary, so no separate toggle exists and this is ignored. */
  hideToggle?: boolean;
  /** The full original text, carried verbatim in the ⓘ tooltip. */
  children: ReactNode;
}) {
  const sizeCls = small ? "text-xs" : "text-sm";
  const hasSummary =
    summary !== undefined && summary !== null && summary !== "";
  return (
    <div className={className}>
      <p className={`${sizeCls} leading-relaxed text-[var(--dim)]`}>
        {hasSummary ? <>{summary} </> : null}
        <ExplainerInfoTip id={id} label={label}>
          {children}
        </ExplainerInfoTip>
      </p>
    </div>
  );
}
