"use client";
import { useState } from "react";
import Link from "next/link";
import type { TaskEta, TaskSummary } from "@/lib/api-types";
import { stateLabel } from "@/lib/lifecycle";
import { relativeAge, timeHMS } from "@/lib/format";
import type { CommandMapModel } from "@/lib/ui/command-map";
import { currentAction, etaHud, missionHud, type HudTone, type Pipeline } from "@/lib/ui/hud";
import { buildMissionStrip, classifyMission, olderPendingView, pinnedMission } from "@/lib/ui/mission";
import { REPO_UNKNOWN_LABEL, repoLabel, repoLabels } from "@/lib/ui/repo";
import { cn } from "@/lib/utils";
import { Glyph } from "@/components/ui/glyphs";
import type { Opener } from "@/components/map/map-node";
import { RoleEmblemIcon } from "@/components/map/role-emblem";

export function statusChip(status: TaskSummary["status"]): string {
  switch (status) {
    case "ACTIVE":
      return "chip-signal";
    case "WAITING":
      return "chip-warn";
    case "BLOCKED":
    case "CORRUPT":
      return "chip-danger";
    case "COMPLETE":
      return "chip-ok";
    default:
      return "chip-dim";
  }
}

export const HUD_TONE_CLASS: Record<HudTone, string> = { signal: "tone-signal", ok: "tone-ok", warn: "tone-warn", danger: "tone-danger", dim: "text-dim" };

/** The lifecycle pipeline as a segmented bar: one segment per step, filled up to the furthest step reached. */
export function PipelineMeter({ pipeline, className }: { pipeline: Pipeline; className?: string }) {
  return (
    // the label sits under the bar and wraps inside its column, so it never runs into the action text beside it
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <div
        role="meter"
        aria-label="Mission pipeline"
        aria-valuemin={0}
        aria-valuemax={pipeline.total}
        aria-valuenow={pipeline.reached}
        aria-valuetext={pipeline.valueText}
        title={pipeline.title}
        className="pipe w-full"
      >
        {pipeline.segments.map((s) => (
          <span key={s.state} className={cn("pipe-seg", s.status)} title={`${s.label} · ${s.status}`} />
        ))}
        {pipeline.exit && <span className="pipe-exit" title={pipeline.exit} />}
      </div>
      <span className="label num min-w-0 text-dim" style={{ overflowWrap: "anywhere" }}>
        {pipeline.label}
        {pipeline.exit ? <span className="tone-danger"> · {pipeline.exit}</span> : null}
      </span>
    </div>
  );
}

export function MissionBar({
  model,
  tasks,
  chosenId,
  onChoose,
  pollingText,
  stale,
  error,
  generatedAt,
  showLink = true,
  onReview,
  onReplay,
  replayAvailable = false,
  replayActive = false,
  eta = null,
  labelTasks,
}: {
  model: CommandMapModel;
  /** Every mission from /api/tasks, for the mission strip (live chips, live/open counters) and the chosen lookup. */
  tasks: TaskSummary[];
  chosenId: string | null;
  onChoose: (id: string | null) => void;
  /** "poll 2.5s" or "polling stopped": the page knows its cadence. */
  pollingText: string;
  stale: boolean;
  error: string | null;
  generatedAt: string | null;
  showLink?: boolean;
  /** Opens the read-only gate panel from the ACTION REQUIRED strip. */
  onReview: (opener: Opener) => void;
  /** Starts or leaves the read-only Mission Replay; the button shows only when a replay is available. */
  onReplay?: (opener: HTMLElement) => void;
  replayAvailable?: boolean;
  replayActive?: boolean;
  /** The focused mission's ETA from /api/tasks (an estimate); hidden in a replay. */
  eta?: TaskEta | null;
  /** The missions repository labels are computed over (default `tasks`); the detail page passes the polled
   * list here, without showing the strip, so its "Repository:" label matches the map's. */
  labelTasks?: TaskSummary[];
}) {
  const [olderPendingOpen, setOlderPendingOpen] = useState(false);
  const d = model.detail;
  const mode = model.mode;
  const failed = mode === "loading" && model.core.statusText.startsWith("ERROR");
  const modeChip = failed ? "chip-danger" : mode === "live" ? "chip-signal" : mode === "replay" ? "chip-synth" : "chip-dim";
  const modeWord = failed ? "ERROR" : mode === "live" ? "LIVE" : mode === "replay" ? "REPLAY" : mode === "debrief" ? "DEBRIEF" : mode === "loading" ? "LOADING" : "STANDBY";
  const hud = missionHud(model);
  const action = currentAction(model);
  const etaLine = etaHud(eta, mode, d?.status ?? null);
  const agentsMeter = model.resources.meters.find((m) => m.id === "agents") ?? null;
  const callout = model.gateCallout;
  const strip = buildMissionStrip(tasks, generatedAt);
  const repoByPath = repoLabels((labelTasks ?? tasks).map((t) => t.repository));
  const selectedId = chosenId ?? model.missionId;
  // the selected mission (chosen or auto-focused) still gets a chip when it falls outside the live strip
  // (older pending, open or closed), so the focus stays visible wherever it actually is.
  const pinned = pinnedMission(strip, tasks, selectedId);
  const opView = olderPendingView(strip, pinned, olderPendingOpen);
  /** `wrap`: the expanded "Older pending" row lets chips shrink and wrap (it isn't inside the horizontally
   * scrolling mobile strip), so a long chip never forces page-level horizontal overflow at narrow widths. */
  const missionChip = (t: TaskSummary, active: boolean, wrap = false) => {
    const awaiting = classifyMission(t, generatedAt) === "awaiting";
    const chipTitle = [t.title, t.repository ?? REPO_UNKNOWN_LABEL].filter(Boolean).join(" · ");
    return (
      <button key={t.id} type="button" className={cn("btn", wrap ? "min-w-0 max-w-full" : "shrink-0", active && "active")} onClick={() => onChoose(t.id)} aria-pressed={active} title={chipTitle}>
        #{t.id.slice(-4)} ·{" "}
        <span className="inline-block max-w-[14ch] overflow-hidden align-bottom text-ellipsis whitespace-nowrap">{repoLabel(t.repository, repoByPath)}</span> ·{" "}
        {awaiting ? `approval · ${relativeAge(t.lastEventAt)}` : `${t.state ? stateLabel(t.state) : t.status} · ${relativeAge(t.lastEventAt)}`}
      </button>
    );
  };
  return (
    <header className="hud flex flex-col gap-1.5 px-3 py-2" aria-label="Mission HUD">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span className={cn("chip", modeChip)}>
          <Glyph name="dot" size={8} className={cn(mode === "live" && "loop blink")} />
          {modeWord}
        </span>
        {d ? (
          <>
            <span className="hud-mission">
              <span className="label-md text-dim">Mission</span> <span className="num">{hud.missionNo}</span>
            </span>
            {showLink ? (
              <Link href={`/tasks/${encodeURIComponent(d.id)}`} className="font-mono text-[12px] tracking-wide text-signal">
                {d.id}
              </Link>
            ) : (
              <span className="font-mono text-[12px] tracking-wide text-dim">{d.id}</span>
            )}
            <span className="min-w-0 max-w-[44ch] overflow-hidden text-ellipsis whitespace-nowrap text-[14px] text-foreground max-md:max-w-none max-md:basis-full" title={d.title ?? ""}>
              {d.title ?? <span className="text-faint">(no summary)</span>}
            </span>
            <span className="label-md text-dim" title={d.repository ?? REPO_UNKNOWN_LABEL}>
              Repository: <span className="text-foreground">{repoLabel(d.repository, repoByPath)}</span>
            </span>
            <span className="chip chip-dim">{d.classification ?? "unclassified"}</span>
            <span className="label-md num text-foreground">
              <span className="text-dim">Round</span> {d.round}/{d.maxRounds}
            </span>
            {hud.governor && (
              <span className="label-md num text-foreground" title={`${hud.governor.detail} · source ${hud.governor.source}`}>
                {hud.governor.short} <span className="text-dim">Governor</span>
                {d.usage?.softLimitCrossed && mode !== "replay" ? <span className="tone-warn"> · soft limit</span> : null}
              </span>
            )}
            {etaLine && (
              <span className={cn("label num max-md:basis-full", HUD_TONE_CLASS[etaLine.tone])} title={etaLine.title}>
                {etaLine.text}
                {agentsMeter ? <span title={`source · ${agentsMeter.source}`}> · Agents {agentsMeter.value}/{agentsMeter.max}</span> : null}
              </span>
            )}
            <span className={cn("chip", statusChip(d.status))}>{d.status}</span>
            {d.ready && <span className="chip chip-ok">READY</span>}
            {model.integrityChip && <span className="chip chip-warn">{model.integrityChip}</span>}
            {onReplay && (replayAvailable || replayActive) && (
              <button type="button" className={cn("btn py-0.5", replayActive && "active")} aria-pressed={replayActive} onClick={(e) => onReplay(e.currentTarget)} title="Step through the recorded lifecycle of this mission on the map (read-only)">
                {replayActive ? "Exit replay" : "Replay mission"}
              </button>
            )}
          </>
        ) : mode === "loading" ? (
          <>
            {model.missionId && (
              <>
                <span className="hud-mission">
                  <span className="label-md text-dim">Mission</span> <span className="num">{hud.missionNo}</span>
                </span>
                <span className="font-mono text-[12px] tracking-wide text-dim">{model.missionId}</span>
              </>
            )}
            <span className="label text-faint">{model.core.statusText.startsWith("ERROR") ? model.core.statusText : "loading mission data…"}</span>
          </>
        ) : (
          <>
            <span className="label-md text-foreground">No active mission</span>
            <span className="label text-faint">the map is dormant · pick a recent mission to debrief</span>
          </>
        )}
        <span className="ml-auto label num text-faint">
          {pollingText}
          {stale ? " · stale" : ""}
          {error ? ` · ${error}` : ""}
          {generatedAt ? ` · ${timeHMS(generatedAt)}` : ""}
        </span>
      </div>
      <div className="grid min-w-0 items-center gap-x-4 gap-y-1 min-[900px]:grid-cols-[minmax(260px,1fr)_minmax(0,1.3fr)]">
        <PipelineMeter pipeline={hud.pipeline} />
        <p className={cn("hud-action flex min-w-0 items-center gap-2 max-md:items-start", HUD_TONE_CLASS[action.tone])} title={`source · ${action.source}`}>
          {action.role ? <RoleEmblemIcon role={action.role} size={18} className="shrink-0" /> : <Glyph name={action.tone === "danger" || action.tone === "warn" ? "warning" : action.tone === "ok" ? "check" : "chevron"} size={12} className="shrink-0" />}
          <span className="label text-faint">{hud.phase}</span>
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap max-md:whitespace-normal">{action.text}</span>
        </p>
      </div>
      {(strip.liveCount > 0 || strip.openCount > 0 || opView.pinnedChip !== null) && (
        <div className="flex flex-wrap items-center gap-1.5 max-md:flex-nowrap max-md:overflow-x-auto scroll-thin" role="group" aria-label="Active missions">
          <span className="label shrink-0 whitespace-nowrap text-faint" title="live = recent Brain activity or a recorded reservation; not proof an agent is running">
            {strip.liveCount} live ·{" "}
            <Link href="/missions" className="text-signal">
              {strip.openCount} open
            </Link>
          </span>
          {strip.live.map((t) => missionChip(t, selectedId === t.id))}
          {strip.moreCount > 0 && (
            <Link href="/missions" className="btn shrink-0">
              +{strip.moreCount} more
            </Link>
          )}
          {opView.pinnedChip && missionChip(opView.pinnedChip, true)}
          {chosenId && (
            <button type="button" className="btn shrink-0" onClick={() => onChoose(null)}>
              Auto focus
            </button>
          )}
        </div>
      )}
      {strip.olderPendingCount > 0 && (
        <div className="flex flex-wrap items-start gap-1.5">
          <button
            type="button"
            className="btn shrink-0"
            aria-expanded={olderPendingOpen}
            aria-controls="older-pending-section"
            onClick={() => setOlderPendingOpen((open) => !open)}
          >
            Older pending ({strip.olderPendingCount})
          </button>
          {olderPendingOpen && (
            <div id="older-pending-section" className="flex min-w-0 basis-full flex-wrap gap-1.5" role="group" aria-label="Older pending missions">
              {opView.expandedList.map((t) => missionChip(t, selectedId === t.id, true))}
            </div>
          )}
        </div>
      )}
      {callout && (
        <div className="callout flex flex-wrap items-center gap-x-3 gap-y-1" role="status" aria-live="polite">
          <Glyph name="lock" size={12} className="tone-warn" />
          <span className="label-md tone-warn">Commander approval · action required</span>
          <span className="label text-dim">{callout.title}</span>
          <span className="min-w-0 flex-1 text-[12px] text-foreground max-md:flex-[1_1_100%]">
            {callout.requestText ? (
              <>
                {callout.requestText}
                {callout.requestDetail ? <span className="text-dim"> — {callout.requestDetail}</span> : null}
              </>
            ) : callout.requestOutsideWindow ? (
              <span className="text-faint">request not in the loaded event window</span>
            ) : (
              <span className="text-faint">no open request line in the loaded events</span>
            )}
            {callout.expiry?.kind === "expired" && <span className="tone-danger"> · approval code expired · a fresh code may be required</span>}
            {callout.expiry?.kind === "maybe-expired" && (
              <span className="text-faint"> · requested {relativeAge(callout.requestedAt)} · a fresh code may be required if it expired</span>
            )}
          </span>
          <button type="button" className="btn active max-md:w-full max-md:basis-full" onClick={(e) => onReview(e.currentTarget)} aria-haspopup="dialog">
            Review
          </button>
        </div>
      )}
      {model.banner && <div className={cn("label-md", model.banner.includes("BLOCKED") ? "tone-danger" : "text-dim")}>{model.banner}</div>}
    </header>
  );
}
