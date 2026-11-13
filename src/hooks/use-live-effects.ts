"use client";
import { useEffect, useRef, useState } from "react";
import type { CommandMapModel } from "@/lib/ui/command-map";
import { diffSnapshots, snapshotOf, type LiveEffect, type Snapshot } from "@/lib/ui/live-diff";

export interface ActiveEffect {
  key: string;
  effect: LiveEffect;
  at: number;
  /** The mission whose snapshots produced the effect (live effects only), so a view can drop one after a switch. */
  missionId?: string;
}

export const EFFECT_MS = 1500;

/**
 * One-shot effects for the map: the previous snapshot is kept in a ref, each new model is diffed
 * against it, and every effect lives for `lifetimeMs` (1.5 s by default; its key remounts the overlay,
 * which restarts the CSS animation). A first load, a mission switch, a staged arrival of detail and
 * findings, or an unchanged poll produces nothing. Every pending timer is cleared on unmount.
 */
export function useLiveEffects(model: CommandMapModel, lifetimeMs: number = EFFECT_MS): ActiveEffect[] {
  const prev = useRef<Snapshot | null>(null);
  const counter = useRef(0);
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const [active, setActive] = useState<ActiveEffect[]>([]);

  useEffect(() => {
    const next = snapshotOf(model);
    const effects = diffSnapshots(prev.current, next);
    prev.current = next;
    if (effects.length === 0 || !next) return;
    const now = Date.now();
    const added = effects.map((effect) => ({ key: `${effect.kind}:${effect.target}:${++counter.current}`, effect, at: now, missionId: next.missionId }));
    setActive((list) => [...list, ...added]);
    const pending = timers.current;
    const timer = setTimeout(() => {
      pending.delete(timer);
      setActive((list) => list.filter((e) => !added.some((a) => a.key === e.key)));
    }, lifetimeMs);
    pending.add(timer);
  }, [model, lifetimeMs]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending) clearTimeout(t);
      pending.clear();
    };
  }, []);

  return active;
}
