import type { ReactNode } from "react";
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
  /** Section name used in the control's accessible label. */
  label: string;
  /** The one-line summary that stays visible. */
  summary: ReactNode;
  /** Wrapper classes (margins) carried over from the original block. */
  className?: string;
  /** Render at the smaller field-note size (text-xs) instead of text-sm. */
  small?: boolean;
  /** The full original text, rendered verbatim when expanded. */
  children: ReactNode;
}) {
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
  const regionId = `explainer-${id.replace(/[^a-zA-Z0-9]+/g, "-")}`;
  const sizeCls = small ? "text-xs" : "text-sm";
  return (
    <div className={className}>
      <p className={`${sizeCls} leading-relaxed text-[var(--dim)]`}>
        {summary}{" "}
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
      </p>
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
