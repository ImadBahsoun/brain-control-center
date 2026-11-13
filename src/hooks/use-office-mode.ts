"use client";
import { useCallback, useSyncExternalStore } from "react";
import { browserStorage } from "@/lib/ui/fold-state";
import { DEFAULT_OFFICE_MODE, readOfficeMode, writeOfficeMode, type OfficeMode } from "@/lib/ui/office-mode";

// A choice that could not be stored still holds for the page session (mirrors use-fold-state.ts).
let memory: OfficeMode | null = null;
const listeners = new Set<() => void>();
const subscribe = (onChange: () => void) => {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
};

/**
 * The Office page's remembered view mode (see office-mode.ts). The server snapshot, and so the first client
 * render, is the default (Global Office); a stored Mission choice is applied right after hydration, so there is
 * no hydration mismatch, only one frame of the default for a viewer who chose otherwise.
 */
export function useOfficeMode(): [OfficeMode, (mode: OfficeMode) => void] {
  const mode = useSyncExternalStore(
    subscribe,
    () => memory ?? readOfficeMode(browserStorage()),
    () => DEFAULT_OFFICE_MODE,
  );
  const setMode = useCallback((next: OfficeMode) => {
    memory = next;
    writeOfficeMode(browserStorage(), next);
    listeners.forEach((l) => l());
  }, []);
  return [mode, setMode];
}
