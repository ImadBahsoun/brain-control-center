"use client";
import Link from "next/link";
import type { TaskSummary } from "@/lib/api-types";
import { relativeAge } from "@/lib/format";
import { stateLabel } from "@/lib/lifecycle";
import { labelledHead, repoLabel } from "@/lib/ui/repo";
import { cn } from "@/lib/utils";
import { statusChip } from "@/components/map/mission-bar";
import { Glyph } from "@/components/ui/glyphs";

export function RecentMissions({ tasks, focusId, onChoose, className }: { tasks: TaskSummary[] | null; focusId: string | null; onChoose: (id: string | null) => void; className?: string }) {
  // labelled over the FULL list (not just the 5 shown here), so a repo's label here always matches the
  // strip, the mission HUD and the Missions tab, which all see the same full list.
  const { head: recent, labels: repoByPath } = labelledHead(tasks ?? [], 5);
  return (
    <section className={cn("hud px-3 py-2.5", className)} aria-label="Recent missions">
      <div className="flex items-center justify-between">
        <h2 className="hud-title">Recent missions</h2>
        <Link href="/missions" className="label text-signal">
          all missions
        </Link>
      </div>
      {!tasks ? (
        <p className="mt-2 label text-faint">loading…</p>
      ) : recent.length === 0 ? (
        <p className="mt-2 text-[12px] text-faint">No missions in the store.</p>
      ) : (
        <ol className="mt-1.5 flex flex-col">
          {recent.map((t) => (
            <li key={t.id}>
              <button type="button" className={cn("row-button flex flex-col gap-0.5 px-1.5 py-1.5", focusId === t.id && "bg-accent/60")} onClick={() => onChoose(focusId === t.id ? null : t.id)} aria-pressed={focusId === t.id} title={t.title ?? ""}>
                <span className="grid w-full grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-x-2">
                  <span className="font-mono text-[11px] text-foreground">{t.id.slice(-4)}</span>
                  <span className={cn("chip", statusChip(t.status))}>{t.status}</span>
                  <span className="label text-faint" style={{ whiteSpace: "normal" }}>
                    {t.state ? stateLabel(t.state) : "—"}
                  </span>
                </span>
                <span className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-2">
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[11.5px] text-dim">{t.title ?? "(no summary)"}</span>
                  <span className="label num whitespace-nowrap text-faint">{relativeAge(t.lastEventAt)}</span>
                </span>
                <span className="flex items-center gap-1 text-faint" title={t.repository ?? undefined}>
                  <Glyph name="folder" size={10} />
                  <span className="label overflow-hidden text-ellipsis whitespace-nowrap">{repoLabel(t.repository, repoByPath)}</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
      {focusId && <p className="mt-1 label text-faint">debrief · click again or use Auto focus to release</p>}
    </section>
  );
}
