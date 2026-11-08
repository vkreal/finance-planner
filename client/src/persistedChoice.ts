import { useState } from "react";

/* A small multi-value display choice remembered in this
   browser's localStorage (e.g. which top-level view or tab was
   last showing). Unlike the server-side fold store
   (foldState.ts), which holds one boolean per key, a choice
   holds one of a fixed set of string values, so each toggle
   owns its own key and the value is validated against the
   allowed set when read back: a missing, corrupt, or unknown
   stored value falls back to the toggle's current default —
   never a blank or a crash. Display only: a choice never
   feeds a priced or saved figure. When localStorage is
   unavailable (private mode, storage disabled), the choice
   simply behaves session-only, exactly as it did before. */
export function usePersistedChoice<T extends string>(
  key: string,
  defaultValue: T,
  validValues: readonly T[],
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw == null) return defaultValue;
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === "string" &&
        (validValues as readonly string[]).includes(parsed)
        ? (parsed as T)
        : defaultValue;
    } catch {
      return defaultValue;
    }
  });
  const set = (next: T) => {
    setValue(next);
    try {
      window.localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* Storage unavailable: the choice stays session-only. */
    }
  };
  return [value, set];
}
