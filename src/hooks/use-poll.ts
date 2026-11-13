"use client";
import { useEffect, useMemo, useState } from "react";

/**
 * Polling over the local /api. One request per URL in flight at a time, each with a 10 s timeout and
 * aborted on unmount; paused while the tab is hidden and refetched as soon as it becomes visible; on
 * error the last data is kept and the next attempt backs off to 10 s. `intervalMs <= 0` fetches once
 * and stops after its first success (an error is retried with the same backoff until one succeeds).
 * `stale` is recomputed on a timer, so it shows even when nothing else re-renders.
 */

export interface PollState<T> {
  data: T | null;
  error: string | null;
  updatedAt: number | null;
  /** The last success is more than 3× the interval ago. */
  stale: boolean;
}

const ERROR_BACKOFF_MS = 10_000;
const FETCH_TIMEOUT_MS = 10_000;

interface Slot<T> {
  data: T | null;
  error: string | null;
  updatedAt: number | null;
}

async function errorCode(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { code?: string } };
    return body.error?.code ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export interface PollOptions {
  /** Per-fetch abort timeout; defaults to FETCH_TIMEOUT_MS (10 s). Additive: existing callers are unaffected. */
  timeoutMs?: number;
}

export function usePollMany<T>(urls: readonly string[], intervalMs: number, opts?: PollOptions): Record<string, PollState<T>> {
  const key = urls.join("\n");
  const timeoutMs = opts?.timeoutMs ?? FETCH_TIMEOUT_MS;
  const [slots, setSlots] = useState<Record<string, Slot<T>>>({});
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const list = key ? key.split("\n") : [];
    if (list.length === 0) return;
    let cancelled = false;
    let inFlight = false;
    let succeeded = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();

    const schedule = (ms: number) => {
      if (cancelled) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void tickOnce(), ms);
    };

    const tickOnce = async () => {
      if (cancelled || inFlight) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return; // resumes on visibilitychange
      inFlight = true;
      let anyError = false;
      const next: Record<string, Slot<T>> = {};
      await Promise.all(
        list.map(async (u) => {
          try {
            // the per-fetch timeout bounds a hung request; the controller aborts everything on unmount
            const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
            const res = await fetch(u, { cache: "no-store", signal });
            if (!res.ok) throw new Error(await errorCode(res));
            const body = (await res.json()) as T;
            next[u] = { data: body, error: null, updatedAt: Date.now() };
          } catch (e) {
            if (controller.signal.aborted) return;
            anyError = true;
            const message = e instanceof Error ? (e.name === "TimeoutError" ? "timeout" : e.message) : "error";
            next[u] = { data: null, error: message, updatedAt: null };
          }
        }),
      );
      inFlight = false;
      if (cancelled) return;
      setSlots((prev) => {
        const out = { ...prev };
        for (const [u, s] of Object.entries(next)) {
          const old = prev[u];
          out[u] = s.error === null ? s : { data: old?.data ?? null, error: s.error, updatedAt: old?.updatedAt ?? null };
        }
        return out;
      });
      setTick((n) => n + 1);
      if (!anyError) succeeded = true;
      if (intervalMs > 0) schedule(anyError ? Math.max(intervalMs, ERROR_BACKOFF_MS) : intervalMs);
      else if (anyError && !succeeded) schedule(ERROR_BACKOFF_MS); // a one-shot poll retries until its first success
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        if (timer) clearTimeout(timer);
        void tickOnce();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    // keeps `stale` current between polls (and when polls stop answering)
    const ticker = intervalMs > 0 ? setInterval(() => setTick((n) => n + 1), Math.max(1000, intervalMs)) : null;
    void tickOnce();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
      if (ticker) clearInterval(ticker);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [key, intervalMs, timeoutMs]);

  return useMemo(() => {
    void tick; // the ticker re-evaluates staleness
    const now = Date.now();
    const out: Record<string, PollState<T>> = {};
    for (const u of key ? key.split("\n") : []) {
      const s = slots[u] ?? { data: null, error: null, updatedAt: null };
      const stale = intervalMs > 0 && s.updatedAt !== null && now - s.updatedAt > 3 * intervalMs;
      out[u] = { ...s, stale };
    }
    return out;
  }, [key, slots, intervalMs, tick]);
}

export function usePoll<T>(url: string | null, intervalMs: number, opts?: PollOptions): PollState<T> {
  const urls = useMemo(() => (url ? [url] : []), [url]);
  const results = usePollMany<T>(urls, intervalMs, opts);
  return (url && results[url]) || { data: null, error: null, updatedAt: null, stale: false };
}
