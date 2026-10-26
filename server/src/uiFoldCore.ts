/* ---------------- Generic fold / expand UI state ----------------
   Display-only open/closed state for the collapsible pieces of
   the Spending and Net Worth views that are not owned by a more
   specific store: the per-month cash-out item lists ("Hide items /
   Show items"), the statement-import panels, the reserve settings
   fold, and the Net Worth Trend anchor note's "More" expander.
   Persisted server-side in settings under ONE JSON blob
   ("ui_fold_state_v1": a map of fold id -> true), following the
   explainer-state pattern (explainer_expanded_v1), so a fold the
   user leaves open or closed comes back exactly that way after a
   reload, in a new session, and on another device. The packaged
   build runs the same actions against its browser-side store, so
   it behaves identically there.

   Semantics: an id present with value true is OPEN (expanded);
   an absent id is the fold's default. Every fold stored here
   defaults to closed, so a closed fold needs no entry — setting
   a fold closed deletes its entry, exactly like the explainer
   map. A section the user has never toggled has no entry and
   keeps its default. Parsing is lenient: a missing, unparseable,
   or non-object blob reads as an empty map, and only entries
   whose value is exactly true survive. No amount, version, or
   total is ever touched by this state. */
import {
  isDangerousDictKey,
  safeDict,
} from "./safeDictCore";

export const UI_FOLD_STATE_KEY = "ui_fold_state_v1";

export function parseUiFoldState(
  raw: string | undefined,
): Record<string, boolean> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    // Security round-2, finding 1 sweep: this map is also built
    // from restored JSON keys, so it is a null-prototype
    // dictionary with dangerous keys dropped (safeDictCore),
    // like the import-settings dictionaries.
    const out: Record<string, boolean> = safeDict();
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (isDangerousDictKey(k)) continue;
      if (v === true) out[k] = true;
    }
    return out;
  } catch {
    return {};
  }
}

/* One fold write against the stored raw blob: parse, set or
   clear the one id, and serialize. This is the exact code path
   the setUiFoldState handler runs between reading and writing
   the settings row, and the exact path the accuracy fixtures
   pin. Setting a fold open stores `true`; setting it closed
   removes the entry (the default), so the blob only ever
   carries the folds the user has left open. */
export function applyUiFoldSet(
  storedRaw: string | undefined,
  id: string,
  open: boolean,
): string {
  const map = parseUiFoldState(storedRaw);
  // Dangerous dictionary keys are never stored (safeDictCore),
  // matching the parser: writing one is a no-op.
  if (isDangerousDictKey(id)) return JSON.stringify(map);
  if (open) map[id] = true;
  else delete map[id];
  return JSON.stringify(map);
}
