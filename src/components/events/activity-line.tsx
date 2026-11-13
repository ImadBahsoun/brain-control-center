"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import type { ActivityItem } from "@/lib/api-types";
import { timeHMS } from "@/lib/format";
import type { FeedReport } from "@/lib/ui/feed";
import { cn } from "@/lib/utils";
import { Glyph } from "@/components/ui/glyphs";

const TONE_CLASS: Record<ActivityItem["tone"], string> = {
  info: "text-foreground",
  success: "tone-ok",
  warn: "tone-warn",
  error: "tone-danger",
};

/**
 * One recorded activity line. The compact form (the map's mission feed) leads with a glyph or role emblem and
 * lists, indented, what the agent reported with a completion line; the full form is the event log's.
 */
export function ActivityLine({
  item,
  taskId,
  compact = false,
  lead,
  reported,
  current = false,
}: {
  item: ActivityItem;
  taskId?: string;
  compact?: boolean;
  /** A glyph or role emblem before the text (compact form). */
  lead?: ReactNode;
  /** Tests and files reported with this completion line. */
  reported?: readonly FeedReport[];
  /** The replay's current step. */
  current?: boolean;
}) {
  if (compact) {
    return (
      <li className={cn("feed-line", current && "current")} aria-current={current ? "step" : undefined} title={`#${item.seq} · ${item.text}${item.detail ? ` — ${item.detail}` : ""}`}>
        <span className="label num shrink-0 text-faint">{timeHMS(item.ts)}</span>
        <span className="feed-lead shrink-0" aria-hidden="true">
          {lead}
        </span>
        <span className={cn("min-w-0 text-[12px] leading-snug", TONE_CLASS[item.tone])}>
          <span className="line-clamp-2">{item.text}</span>
          {item.detail && <span className="line-clamp-1 text-[11px] text-dim">{item.detail}</span>}
          {reported && reported.length > 0 && (
            <span className="mt-0.5 block">
              {reported.map((r, i) => (
                <span key={i} className="feed-report" title={`reported at completion · ${r.source}`}>
                  <Glyph name={r.kind === "tests" ? "check" : "chevron"} size={10} className={cn("mt-[3px] shrink-0", r.kind === "tests" ? "tone-ok" : "text-dim")} />
                  <span className="min-w-0 break-all">{r.text}</span>
                </span>
              ))}
            </span>
          )}
        </span>
      </li>
    );
  }
  return (
    <li className="flex gap-2 border-b border-border/60 py-0.5 last:border-0">
      <span className="label num shrink-0 pt-0.5 text-faint">{timeHMS(item.ts)}</span>
      {taskId && (
        <Link href={`/tasks/${encodeURIComponent(taskId)}`} className="shrink-0 font-mono text-[11px] text-signal">
          {taskId.slice(-4)}
        </Link>
      )}
      <span className="label num shrink-0 pt-0.5 text-faint">#{item.seq}</span>
      <span className={cn("min-w-0 text-[12px]", TONE_CLASS[item.tone])}>
        {item.text}
        {item.stateChange && (
          <span className="text-faint">
            {" "}
            · {item.stateChange.from ?? "∅"} → {item.stateChange.to}
          </span>
        )}
        {item.detail && <span className="block text-[11px] text-dim">{item.detail}</span>}
      </span>
    </li>
  );
}
