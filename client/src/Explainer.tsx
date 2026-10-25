import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

/* One-line summary + "More" pattern for long section intros.
   The visible text is ONE tight summary line (the `summary` prop);
   a small "More" control expands the section's FULL ORIGINAL TEXT
   (the children) in place, verbatim — the original wording is never
   rewritten or deleted, it just lives behind the expander. "Less"
   collapses it again. Expanded/collapsed state persists per section
   in the app's settings (server-side, via getExplainerState /
   setExplainerExpanded), like the existing section collapse states;
   the default is collapsed (summary line only). All instances share
   one react-query cache entry, so toggling one section never
   refetches another's data. */
function explainerRegionId(id: string): string {
  return `explainer-${id.replace(/[^a-zA-Z0-9]+/g, "-")}`;
}

/* Shared expanded/collapsed state for one explainer id, backed by
   the same persisted settings store the in-place Explainer uses.
   Lets a section header's control cluster carry the "More" toggle
   (ExplainerToggle) while the Explainer itself renders only the
   expanded text below the header — one state, two render spots. */
export function useExplainerToggle(id: string) {
  const queryClient = useQueryClient();
  const state = useQuery({
    queryKey: ["explainerState"],
    queryFn: () => api.getExplainerState({}),
  });
  const expanded = state.data?.expanded[id] === true;
  const setExpanded = useMutation({
    mutationFn: (next: boolean) =>
      api.setExplainerExpanded({ id, expanded: next }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["explainerState"] });
    },
  });
  return { expanded, setExpanded };
}

/* The "More"/"Less" toggle as a compact link for a section header's
   control cluster — same persisted state, accessible name, and
   expanded region as the paired in-place Explainer (rendered with
   hideToggle below the header). */
export function ExplainerToggle({
  id,
  label,
}: {
  /** Stable per-section id, matching the paired Explainer. */
  id: string;
  /** Section name used in the control's accessible label. */
  label: string;
}) {
  const { expanded, setExpanded } = useExplainerToggle(id);
  return (
    <button
      type="button"
      aria-label={expanded ? `Less about ${label}` : `More about ${label}`}
      aria-expanded={expanded}
      aria-controls={explainerRegionId(id)}
      disabled={setExpanded.isPending}
      onClick={() => setExpanded.mutate(!expanded)}
      className="inline-flex min-h-9 items-center px-1 text-sm font-medium whitespace-nowrap text-[var(--accent)] underline underline-offset-2"
    >
      {expanded ? "Less" : "More"}
    </button>
  );
}

/* The former "More" link as the app's compact ⓘ info affordance,
   for section headers whose explainer text now lives in a tooltip
   instead of expanding in place (2026-10-25: the underlined
   "More" word in every Spending header looked a mess). It follows
   the app's existing info controls exactly (InfoTip in App.tsx,
   BucketHelp in NetWorth.tsx): an 18px circled-i button; hovering
   or focusing it shows the bubble, tapping or clicking pins it
   open, tapping outside or pressing Escape closes a pinned bubble.
   The bubble carries the section's FULL explainer text (the
   children) verbatim — the same content the "More" link used to
   expand below the header, word for word; only where it appears
   changed. The bubble opens right-aligned under the button so it
   stays inside the page at the header's right edge. */
export function ExplainerInfoTip({
  id,
  label,
  children,
}: {
  /** Stable per-section id, matching the explainer it replaces. */
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
  const tipId = `${explainerRegionId(id)}-${rawId.replace(/[^a-zA-Z0-9]/g, "")}`;
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
  hideToggle = false,
  children,
}: {
  /** Stable per-section id, e.g. "spending.keepLightsOn". */
  id: string;
  /** Section name used in the control's accessible label. */
  label: string;
  /** The one-line summary that stays visible. Omit it when the
      section's face carries no summary sentence — the "More" control
      then stands alone and the full text still lives behind it. */
  summary?: ReactNode;
  /** Wrapper classes (margins) carried over from the original block. */
  className?: string;
  /** Render at the smaller field-note size (text-xs) instead of text-sm. */
  small?: boolean;
  /** Render no toggle of its own — the section header's control
      cluster carries an ExplainerToggle for this id instead. The
      summary (if any) and the expanded text still render here. */
  hideToggle?: boolean;
  /** The full original text, rendered verbatim when expanded. */
  children: ReactNode;
}) {
  const { expanded, setExpanded } = useExplainerToggle(id);
  const regionId = explainerRegionId(id);
  const sizeCls = small ? "text-xs" : "text-sm";
  return (
    <div className={className}>
      {(summary || !hideToggle) && (
        <p className={`${sizeCls} leading-relaxed text-[var(--dim)]`}>
          {summary ? <>{summary} </> : null}
          {!hideToggle && (
            <button
              type="button"
              aria-label={
                expanded ? `Less about ${label}` : `More about ${label}`
              }
              aria-expanded={expanded}
              aria-controls={regionId}
              disabled={setExpanded.isPending}
              onClick={() => setExpanded.mutate(!expanded)}
              className="font-medium whitespace-nowrap text-[var(--accent)] underline underline-offset-2"
            >
              {expanded ? "Less" : "More"}
            </button>
          )}
        </p>
      )}
      {expanded && (
        <div
          id={regionId}
          className={`mt-1 space-y-2 ${sizeCls} leading-relaxed text-[var(--dim)]`}
        >
          {children}
        </div>
      )}
    </div>
  );
}
