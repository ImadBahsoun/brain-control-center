"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { durationMs, relativeAge } from "@/lib/format";
import { missionHref, STATE_WORDS, TELEMETRY_NOTES, type FinishedRun, type GlobalInstance, type GlobalOfficeModel, type InstanceState } from "@/lib/ui/global-office";
import { cn } from "@/lib/utils";

const STATE_CHIP: Record<InstanceState, string> = { running: "chip-signal", stale: "chip-warn", queued: "chip-dim" };

/**
 * Time since a recorded timestamp, ticking once a second, on the server's clock: `skewMs` is the server's
 * `generatedAt` minus the client's time when that poll arrived, so a device with a wrong clock still counts right.
 */
export function LiveElapsed({ since, skewMs, svg = false }: { since: string | null; skewMs: number; svg?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const t = since ? Date.parse(since) : Number.NaN;
  const text = Number.isFinite(t) ? durationMs(Math.max(0, now + skewMs - t)) : "—";
  return svg ? <tspan>{text}</tspan> : <span className="num">{text}</span>;
}

function InstanceRow({ i, skewMs }: { i: GlobalInstance; skewMs: number }) {
  return (
    <li>
      <Link href={missionHref(i.taskId)} className="row-button flex min-h-11 flex-col justify-center gap-0.5 px-2 py-1.5" title={i.title ?? undefined}>
        <span className="flex w-full items-center gap-2">
          <span className="font-mono text-[12px] text-foreground">{i.missionNo}</span>
          <span className={cn("chip", STATE_CHIP[i.state])}>{STATE_WORDS[i.state]}</span>
          <span className="label ml-auto whitespace-nowrap text-dim">
            <LiveElapsed since={i.since} skewMs={skewMs} />
          </span>
        </span>
        <span className="flex w-full min-w-0 items-baseline gap-1.5">
          <span className={cn("label overflow-hidden text-ellipsis whitespace-nowrap", i.repoKnown ? "text-dim" : "text-faint")}>{i.repoLabel}</span>
          <span className="label whitespace-nowrap text-faint">{i.taskId}</span>
        </span>
        {i.note && <span className="label text-faint">{i.note}</span>}
        {i.state !== "queued" && i.kind && (
          <span className="label text-faint">
            {i.kind}
            {i.round !== null ? ` · round ${i.round}` : ""}
            {i.model ? ` · ${i.model}` : ""}
          </span>
        )}
      </Link>
    </li>
  );
}

function FinishedRows({ runs }: { runs: FinishedRun[] }) {
  if (runs.length === 0) return null;
  return (
    <details className="mt-1">
      <summary className="row-button flex min-h-11 cursor-pointer items-center px-2 label text-faint">recently finished ({runs.length})</summary>
      <ul className="flex flex-col">
        {runs.map((r) => (
          <li key={r.key}>
            <Link href={missionHref(r.taskId)} className="row-button flex min-h-11 flex-col justify-center gap-0.5 px-2 py-1">
              <span className="flex w-full items-center gap-2">
                <span className="font-mono text-[12px] text-dim">{r.missionNo}</span>
                <span className="label text-faint">{r.status === "completed" ? (r.verdict ?? "completed") : r.status}</span>
                <span className="label num ml-auto whitespace-nowrap text-faint">{durationMs(r.durationMs)}</span>
              </span>
              <span className="label text-faint">
                {r.repoLabel} · {relativeAge(r.completedAt)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </details>
  );
}

export interface RosterGroup {
  id: string;
  title: string;
  instances: GlobalInstance[];
  finished: FinishedRun[];
}

/** The roster's groups: one per role room, then any other recorded role. */
export function rosterGroups(model: GlobalOfficeModel): RosterGroup[] {
  const groups: RosterGroup[] = model.rooms.map((r) => ({ id: r.id, title: `${r.title} · ${r.header}`, instances: r.instances, finished: r.recentFinished }));
  if (model.other.length > 0 || model.otherFinished.length > 0) groups.push({ id: "other", title: `OTHER ROLES · ${model.other.length}`, instances: model.other, finished: model.otherFinished });
  return groups;
}

/**
 * Every Global Office instance as HTML, grouped by role room (each group collapses): rows link to the mission's
 * page, show its status, repo and live elapsed time, and queued rows say what was recorded (never a position).
 * Finished runs of open missions sit under "recently finished". Any count works here; the scene draws at most a
 * few figures per room.
 */
export function GlobalRoster({
  model,
  skewMs,
  collapsed,
  onToggleGroup,
  groupDomId,
}: {
  model: GlobalOfficeModel;
  skewMs: number;
  collapsed: ReadonlySet<string>;
  onToggleGroup: (id: string) => void;
  groupDomId: (id: string) => string;
}) {
  return (
    <div className="flex flex-col gap-2">
      {!model.loaded ? (
        <p className="label text-faint">loading…</p>
      ) : (
        rosterGroups(model).map((g) => {
          const open = !collapsed.has(g.id);
          return (
            <section key={g.id} aria-label={g.title}>
              <button
                id={groupDomId(g.id)}
                type="button"
                className="row-button flex min-h-11 items-center justify-between gap-2 px-2 hud-title"
                aria-expanded={open}
                aria-controls={`${groupDomId(g.id)}-list`}
                onClick={() => onToggleGroup(g.id)}
              >
                <span>{g.title}</span>
                <span className="label text-faint">{open ? "hide" : "show"}</span>
              </button>
              <div id={`${groupDomId(g.id)}-list`} hidden={!open}>
                {g.instances.length === 0 ? (
                  <p className="px-2 label text-faint">no agents</p>
                ) : (
                  <ul className="flex flex-col">
                    {g.instances.map((i) => (
                      <InstanceRow key={i.key} i={i} skewMs={skewMs} />
                    ))}
                  </ul>
                )}
                <FinishedRows runs={g.finished} />
              </div>
            </section>
          );
        })
      )}
      <ul className="flex flex-col gap-1 border-t border-border pt-2">
        {TELEMETRY_NOTES.map((n) => (
          <li key={n} className="text-[11px] text-faint">
            {n}
          </li>
        ))}
      </ul>
    </div>
  );
}
