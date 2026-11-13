"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Selection } from "@/lib/ui/selection";

export type Opener = HTMLElement | SVGElement;

/**
 * The side panel's selection, shared by the views. `select` remembers the element that opened the
 * first panel and keeps it while panels replace each other (a finding opened from a character panel
 * still returns focus to the node that started it); `close` clears the selection, returns focus to
 * that opener, and Escape anywhere closes an open panel.
 */
export function usePanelSelection<S = Selection>() {
  const [selection, setSelection] = useState<S | null>(null);
  const opener = useRef<Opener | null>(null);
  const open = useRef(false);

  const select = useCallback((sel: S, el: Opener | null) => {
    if (!open.current && el) opener.current = el;
    open.current = true;
    setSelection(sel);
  }, []);

  const close = useCallback(() => {
    setSelection(null);
    open.current = false;
    const el = opener.current;
    opener.current = null;
    if (el) requestAnimationFrame(() => el.focus());
  }, []);

  useEffect(() => {
    if (!selection) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, close]);

  return { selection, select, close };
}
