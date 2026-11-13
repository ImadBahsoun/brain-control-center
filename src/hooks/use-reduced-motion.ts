"use client";
import { useMediaQuery } from "@/hooks/use-media-query";

/** True when the viewer asked for reduced motion; the CSS stops every loop and this stops the particles. */
export function useReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}
