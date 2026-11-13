"use client";
import { useMemo, useState } from "react";
import type { ActivityItem, EventsResponse, TaskSummary } from "@/lib/api-types";
import { isTerminalStatus } from "@/lib/lifecycle";
import { usePollMany } from "@/hooks/use-poll";
import { roleLabel } from "@/lib/ui/roles";
import { cn } from "@/lib/utils";
import { ActivityLine } from "@/components/events/activity-line";

const LIMITS = [50, 200, 1000] as const;
const TONES = ["info", "success", "warn", "error"] as const;

/** Up to 3 active missions (newest event first), otherwise the newest mission. */
export function defaultEventTasks(tasks: readonly TaskSummary[]): string[] {
  const active = tasks.filter((t) => t.active);
  if (active.length > 0) {
    return [...active]
      .sort((a, b) => (b.lastEventAt ?? "").localeCompare(a.lastEventAt ?? ""))
      .slice(0, 3)
      .map((t) => t.id);
  }
  const first = tasks[0];
  return first ? [first.id] : [];
}

export function EventFeed({ tasks, interval }: { tasks: TaskSummary[] | null; interval: number }) {
  const [picked, setPicked] = useState<string>("");
  const [limit, setLimit] = useState<(typeof LIMITS)[number]>(50);
  const [type, setType] = useState<string>("");
  const [tone, setTone] = useState<string>("");
  const [role, setRole] = useState<string>("");

  const ids = useMemo(() => {
    if (!tasks) return [];
    if (picked && tasks.some((t) => t.id === picked)) return [picked];
    return defaultEventTasks(tasks);
  }, [tasks, picked]);
  const allTerminal = ids.length > 0 && ids.every((id) => isTerminalStatus(tasks?.find((t) => t.id === id)?.status ?? "ACTIVE"));
  const urls = useMemo(() => ids.map((id) => `/api/tasks/${encodeURIComponent(id)}/events?limit=${limit}`), [ids, limit]);
  const results = usePollMany<EventsResponse>(urls, allTerminal ? 0 : interval);

  const merged = useMemo(() => {
    const items: Array<{ item: ActivityItem; taskId: string }> = [];
    for (const u of urls) {
      const r = results[u]?.data;
      if (!r) continue;
      for (const item of r.events) items.push({ item, taskId: r.taskId });
    }
    items.sort((a, b) => a.item.ts.localeCompare(b.item.ts) || a.item.seq - b.item.seq);
    return items;
  }, [urls, results]);
  const types = useMemo(() => [...new Set(merged.map((m) => m.item.type))].sort(), [merged]);
  const roles = useMemo(() => [...new Set(merged.map((m) => m.item.role).filter((r): r is string => !!r))].sort(), [merged]);
  const shown = merged.filter((m) => (!type || m.item.type === type) && (!tone || m.item.tone === tone) && (!role || m.item.role === role));
  const anyError = urls.map((u) => results[u]?.error).find((e) => e);
  const hasMore = urls.some((u) => results[u]?.data?.hasMore);

  return (
    <section className="hud flex min-h-0 flex-col" aria-label="Brain event stream">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="hud-title">Event stream</h2>
        <span className="label num text-faint">
          {ids.length} mission(s) · {shown.length} line(s){hasMore ? " · oldest left out" : ""} · {allTerminal ? "terminal · one fetch" : `poll ${interval / 1000}s`}
          {anyError ? ` · error: ${anyError}` : ""}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="label text-dim">
            mission{" "}
            <select className="btn" value={picked} onChange={(e) => setPicked(e.target.value)} aria-label="Mission to show">
              <option value="">default (active missions)</option>
              {(tasks ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.id} · {t.status}
                </option>
              ))}
            </select>
          </label>
          <span className="flex items-center gap-1" role="group" aria-label="Event limit">
            {LIMITS.map((n) => (
              <button key={n} type="button" className={cn("btn", limit === n && "active")} aria-pressed={limit === n} onClick={() => setLimit(n)}>
                {n}
              </button>
            ))}
          </span>
          <select className="btn" value={type} onChange={(e) => setType(e.target.value)} aria-label="Filter by event type">
            <option value="">all types</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <select className="btn" value={tone} onChange={(e) => setTone(e.target.value)} aria-label="Filter by tone">
            <option value="">all tones</option>
            {TONES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <select className="btn" value={role} onChange={(e) => setRole(e.target.value)} aria-label="Filter by role">
            <option value="">all roles</option>
            {roles.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {!tasks ? (
          <p className="text-faint">loading…</p>
        ) : ids.length === 0 ? (
          <p className="text-faint">No missions in the store.</p>
        ) : merged.length === 0 ? (
          <p className="text-faint">{anyError ? `error: ${anyError}` : "loading…"}</p>
        ) : shown.length === 0 ? (
          <p className="text-faint">No events match the filters.</p>
        ) : (
          <ol>
            {shown.map(({ item, taskId }) => (
              <ActivityLine key={`${taskId}-${item.seq}`} item={item} taskId={ids.length > 1 ? taskId : undefined} />
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
