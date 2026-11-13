"use client";
import { useEffect, useState } from "react";
import { durationMs } from "@/lib/format";

/**
 * Time since a recorded timestamp, as one text node that updates once a second. Mounted only while a live
 * gate alert has a known request time, so the rest of the scene never re-renders for the clock.
 */
export function ElapsedSince({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const t = Date.parse(since);
  return <tspan>{Number.isFinite(t) ? durationMs(Math.max(0, now - t)) : "—"}</tspan>;
}
