import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

/* Shared client side of the generic fold store (getUiFoldState /
   setUiFoldState — see server/src/uiFoldCore.ts): the open/closed
   state of the collapsible Spending and Net Worth pieces no more
   specific store owns. All readers share one react-query cache
   entry (["uifoldstate"]), like the Explainer's shared entry, so
   toggling one fold never refetches another's data. A fold the
   user has never toggled has no stored entry and reads as its
   default (closed for every fold in this store); once toggled,
   the stored choice is what comes back after a reload, in a new
   session, and on another device. */
export function useFoldStateMap() {
  return useQuery({
    queryKey: ["uifoldstate"],
    queryFn: () => api.getUiFoldState({}),
  });
}

export function useSetFold() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; open: boolean }) =>
      api.setUiFoldState(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["uifoldstate"] });
    },
  });
}

/* One persisted fold: [open, setOpen]. The local override keeps
   the toggle instant (the stored value lands a moment later and
   then agrees with it); before the first read lands, the fold
   shows its default, exactly as a first-ever open does. */
export function usePersistedFold(
  id: string,
  defaultOpen = false,
): [boolean, (next: boolean) => void] {
  const map = useFoldStateMap();
  const setFold = useSetFold();
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? map.data?.open[id] ?? defaultOpen;
  const setOpen = (next: boolean) => {
    setOverride(next);
    setFold.mutate({ id, open: next });
  };
  return [open, setOpen];
}
