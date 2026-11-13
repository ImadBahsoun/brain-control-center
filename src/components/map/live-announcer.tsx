"use client";
import { describeEffect } from "@/lib/ui/live-diff";
import type { ActiveEffect } from "@/hooks/use-live-effects";

/**
 * The same one-shot effects as text for assistive tech, under reduced motion too; plus an optional status
 * message (the replay step). `prefix` marks replayed effects ("Replay: ") so they are not taken as live.
 */
export function LiveAnnouncer({ effects, message, prefix = "" }: { effects: ActiveEffect[]; message?: string | null; prefix?: string }) {
  return (
    <div aria-live="polite" aria-atomic="false" className="sr-only">
      {message && <p>{message}</p>}
      {effects.map((e) => (
        <p key={e.key}>
          {prefix}
          {describeEffect(e.effect)}
        </p>
      ))}
    </div>
  );
}
