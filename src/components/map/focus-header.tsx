"use client";
import type { Ref } from "react";
import type { TaskSummary } from "@/lib/api-types";
import { timeHMS } from "@/lib/format";
import type { CommandMapModel } from "@/lib/ui/command-map";
import { focusIndicatorAnnouncement, replayPlayLabel, showFocusIndicator } from "@/lib/ui/focus-mode";
import { REPO_UNKNOWN_LABEL, repoLabel, repoLabels } from "@/lib/ui/repo";
import { cn } from "@/lib/utils";
import type { ReplayControl } from "@/hooks/use-replay";
import { statusChip } from "@/components/map/mission-bar";

/**
 * The compact header Focus Mode shows in place of the Mission Bar and the rest of the chrome: the
 * focused mission's id, repository and status (the same labelling and chip classes as the Mission Bar),
 * a stale/error indicator, compact Mission Replay controls while a replay is active, the "Show Mission
 * Path" toggle and the Exit control. `model` is the view's `shown` model, so a replay shows the replayed
 * mission's values, same as the rest of the map.
 */
export function FocusHeader({
  model,
  tasks,
  stale,
  error,
  generatedAt,
  replaying,
  replay,
  onExitReplay,
  showPath,
  onToggleShowPath,
  showPathToggle = true,
  onExit,
  exitButtonRef,
}: {
  model: CommandMapModel;
  tasks: TaskSummary[];
  /** Same `stale`/`error`/`generatedAt` MissionLayout already gives the Mission Bar. */
  stale: boolean;
  error: string | null;
  generatedAt: string | null;
  /** `replay.open && replay.model !== null` — a replay is actually on screen, not merely requested. */
  replaying: boolean;
  replay: ReplayControl;
  /** Leaves the replay AND, since its own focus-restore target (the Mission Bar's Replay button) is
   * `display:none` in Focus Mode, moves focus to a control that is actually visible here. */
  onExitReplay: () => void;
  showPath: boolean;
  onToggleShowPath: () => void;
  /** Offer the path toggle (default). The Global Office passes false: its lifecycle path is always hidden. */
  showPathToggle?: boolean;
  onExit: () => void;
  exitButtonRef: Ref<HTMLButtonElement>;
}) {
  const d = model.detail;
  const repoByPath = repoLabels(tasks.map((t) => t.repository));
  return (
    <header className="hud flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2" aria-label="Focus mode header">
      {d ? (
        <>
          <span className="font-mono text-[12px] tracking-wide text-dim">{d.id}</span>
          <span className="label-md text-dim" title={d.repository ?? REPO_UNKNOWN_LABEL}>
            Repository: <span className="text-foreground">{repoLabel(d.repository, repoByPath)}</span>
          </span>
          <span className={cn("chip", statusChip(d.status))}>{d.status}</span>
        </>
      ) : model.mode === "loading" ? (
        <span className="label text-faint">{model.core.statusText.startsWith("ERROR") ? model.core.statusText : "loading mission data…"}</span>
      ) : (
        <span className="label-md text-foreground">No active mission</span>
      )}
      {/* always mounted (so assistive tech reliably picks up a later change, not just a later insertion);
          its text never includes the poll timestamp, so a fresh poll doesn't re-announce a standing error */}
      <span role="status" className="sr-only">
        {focusIndicatorAnnouncement(stale, error)}
      </span>
      {showFocusIndicator(stale, error) && (
        <span className="flex min-w-0 items-center gap-2">
          {stale && <span className="chip chip-warn">STALE</span>}
          {error && (
            <span className="max-w-[32ch] overflow-hidden text-ellipsis whitespace-nowrap text-[12px] tone-danger" title={error}>
              {error}
            </span>
          )}
          {generatedAt && <span className="label num text-faint">{timeHMS(generatedAt)}</span>}
        </span>
      )}
      {replaying && (
        <span className="flex flex-wrap items-center gap-2">
          <span className="chip chip-synth">REPLAY</span>
          <span className="label num text-faint">
            step {replay.state.index + 1} of {replay.state.length}
          </span>
          <button type="button" className="btn" aria-pressed={replay.state.playing} onClick={() => replay.dispatch({ type: replay.state.playing ? "pause" : "play" })}>
            {replayPlayLabel(replay.state)}
          </button>
          <button type="button" className="btn" onClick={onExitReplay}>
            Exit replay
          </button>
        </span>
      )}
      {showPathToggle && (
        <button type="button" className="btn ml-auto" aria-pressed={showPath} onClick={onToggleShowPath}>
          Show Mission Path
        </button>
      )}
      <button type="button" ref={exitButtonRef} className={cn("btn", !showPathToggle && "ml-auto")} onClick={onExit}>
        Exit focus mode
      </button>
    </header>
  );
}
