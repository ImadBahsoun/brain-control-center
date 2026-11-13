"use client";
import { useEffect, useRef } from "react";
import type { EventsResponse, TaskDetail } from "@/lib/api-types";
import { feedLines, FEED_LIMIT, type FeedKind } from "@/lib/ui/feed";
import { cn } from "@/lib/utils";
import { Glyph, type GlyphName } from "@/components/ui/glyphs";
import { ActivityLine } from "@/components/events/activity-line";
import { RoleEmblemIcon } from "@/components/map/role-emblem";

const KIND_GLYPH: Record<FeedKind, GlyphName> = {
  agent: "dot",
  step: "chevron",
  finding: "warning",
  gate: "lock",
  snapshot: "dot",
  validation: "check",
  fix: "pulse",
  note: "question",
};

/**
 * The compact live feed of the focused mission: its newest recorded activity lines (no announcements: the
 * live announcer covers changes). In a replay it shows the lines up to the current step, which is marked.
 */
export function MissionFeed({ events, detail, missionId, error, replay = false, className }: { events: EventsResponse | null; detail: TaskDetail | null; missionId: string | null; error?: string | null; replay?: boolean; className?: string }) {
  const feed = feedLines(events && events.taskId === missionId ? events : null, detail);
  const lastSeq = feed.lines[feed.lines.length - 1]?.seq ?? null;
  // the newest line is at the bottom: keep it in view when a new one arrives (not on every poll)
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastSeq, missionId]);
  return (
    <section className={cn("hud flex min-h-0 flex-col", className)} aria-label="Mission feed">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <h2 className="hud-title">{replay ? "Replay feed" : "Mission feed"} · last {FEED_LIMIT}</h2>
        <span className="label num text-faint">{missionId ? (events ? `${feed.available} line(s)${feed.hasMore ? " · older left out" : ""}` : "—") : ""}</span>
      </div>
      {!missionId ? (
        <p className="px-3 pb-3 text-[12px] text-faint">No mission in focus.</p>
      ) : !events ? (
        <p className="px-3 pb-3 text-[12px] text-faint">{error ? `events error: ${error}` : "loading events…"}</p>
      ) : feed.lines.length === 0 ? (
        <p className="px-3 pb-3 text-[12px] text-faint">No events recorded.</p>
      ) : (
        <ol ref={list} className="scroll-thin min-h-0 flex-1 overflow-y-auto border-t border-border px-2 py-1">
          {feed.lines.map((l) => (
            <ActivityLine
              key={l.key}
              item={l.item}
              compact
              current={replay && l.seq === lastSeq}
              reported={l.reported}
              lead={l.role ? <RoleEmblemIcon role={l.role} size={14} /> : <Glyph name={KIND_GLYPH[l.kind]} size={11} />}
            />
          ))}
        </ol>
      )}
      {missionId && events && feed.reportedOutsideWindow > 0 && (
        <p className="border-t border-border px-3 py-1.5 label text-faint">{feed.reportedOutsideWindow} report(s) of tests or files belong to earlier lines · see the mission detail</p>
      )}
      {missionId && events && feed.reportedAmbiguous > 0 && (
        <p className="border-t border-border px-3 py-1.5 label text-faint">{feed.reportedAmbiguous} report(s) not tied to a line: the agent completed more than once in that round</p>
      )}
    </section>
  );
}
