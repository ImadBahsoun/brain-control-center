"use client";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { browserStorage, readFold, writeFold, type FoldChoice } from "@/lib/ui/fold-state";

// A choice that could not be stored still holds for the page session; every hook instance shares these.
const memory = new Map<string, boolean>();
const listeners = new Set<() => void>();
const subscribe = (onChange: () => void) => {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
};

/**
 * One side column's remembered fold choice (see fold-state.ts). The server snapshot and so the first client
 * render are `null` (the column's default); the stored choice is applied right after hydration, so a viewer
 * who chose differently sees the default for one frame, which the CSS-driven default layout already accepts.
 */
export function useFoldState(key: string): [FoldChoice, (open: boolean) => void] {
  const choice = useSyncExternalStore(
    subscribe,
    () => memory.get(key) ?? readFold(browserStorage(), key),
    () => null,
  );
  const setOpen = useCallback(
    (open: boolean) => {
      memory.set(key, open);
      writeFold(browserStorage(), key, open);
      listeners.forEach((l) => l());
    },
    [key],
  );
  return [choice, setOpen];
}

/**
 * Focus hand-off for a fold: the pressed button disappears, so focus moves to its counterpart once the new
 * state has rendered. `stateKey` must change whenever the fold state does; `request` is called with the
 * fold state being asked for, just before it is applied.
 */
export function useFoldFocus(stateKey: string) {
  const showButton = useRef<HTMLButtonElement>(null);
  const hideButton = useRef<HTMLButtonElement>(null);
  const pending = useRef<"show" | "hide" | null>(null);
  useEffect(() => {
    const next = pending.current;
    if (!next) return;
    pending.current = null;
    (next === "hide" ? showButton : hideButton).current?.focus();
  }, [stateKey]);
  const request = (folded: boolean) => {
    pending.current = folded ? "hide" : "show";
  };
  return { showButton, hideButton, request };
}
