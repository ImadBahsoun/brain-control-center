"use client";
import type { LifecycleView } from "@/lib/api-types";
import { timeHMS } from "@/lib/format";
import type { CurrentAction } from "@/lib/ui/hud";
import { HUD_TONE_CLASS } from "@/components/map/mission-bar";
import { lifecyclePath, lifecycleSummary } from "@/lib/ui/lifecycle-path";
import { cn } from "@/lib/utils";

/** Short forms of the map labels longer than one narrow column (below 1280 px); the full name is in the title and the screen-reader text. */
const NARROW: Record<string, string> = { RECEIVED: "RECV", CLASSIFY: "CLASS", SYNTHESIS: "SYNTH", REVALIDATE: "REVAL", COMPLETE: "COMPL" };

/** The 17 recorded lifecycle steps as a tactical path; statuses come straight from the API. */
export function LifecyclePath({ lifecycle, reducedMotion, live, action, className }: { lifecycle: LifecycleView | null; reducedMotion: boolean; live: boolean; action?: CurrentAction; className?: string }) {
  const model = lifecycle ? lifecyclePath(lifecycle) : null;
  const summary = lifecycleSummary(model ?? lifecyclePath({ steps: [], current: null, exit: null, transitions: [] }));
  return (
    <section className={cn("hud px-3 py-2", className)} aria-label="Mission lifecycle path">
      <div className="flex items-center justify-between max-md:flex-wrap">
        <h2 className="hud-title">Mission path · 17 states</h2>
        <span className="label num text-faint">{model ? `current ${model.current ?? "—"} · ${model.transitions} transition(s)` : "no mission in focus"}</span>
      </div>
      <ol className="mt-2 flex items-start gap-0 max-md:hidden" aria-label="Lifecycle steps">
        {(model?.waypoints ?? lifecycleEmpty()).map((w, i, arr) => (
          <li
            key={w.state}
            className={cn("waypoint", w.status)}
            aria-current={w.status === "current" ? "step" : undefined}
            title={`${w.label} · ${w.status}${w.enteredAt ? ` · entered ${timeHMS(w.enteredAt)}` : ""}${w.visits > 1 ? ` · ${w.visits} visits` : ""}${w.implied ? " · implied" : ""}`}
          >
            {i < arr.length - 1 && <span className="waypoint-line" aria-hidden="true" />}
            {w.status === "current" && live && <span className={cn("waypoint-ring", !reducedMotion && "loop")} aria-hidden="true" />}
            <span className="waypoint-dot block" aria-hidden="true" />
            <span className={cn("waypoint-label mt-1.5 block label", w.status === "current" ? "text-foreground" : w.status === "completed" ? "text-dim" : "text-faint", w.status === "skipped" && "line-through decoration-faint")}>
              <span className="hidden min-[1280px]:inline">{w.short}</span>
              <span className="min-[1280px]:hidden" aria-hidden="true">
                {NARROW[w.short] ?? w.short}
              </span>
            </span>
            <span className="sr-only">
              {w.label}: {w.status}
            </span>
          </li>
        ))}
        {model?.exit && (
          <li className="waypoint" aria-current="step" title={`${model.exit.label}${model.exit.ts ? ` · ${timeHMS(model.exit.ts)}` : ""}`}>
            <span className="waypoint-dot block" aria-hidden="true" style={{ borderColor: "var(--danger)", background: "var(--danger)" }} />
            <span className="waypoint-label mt-1.5 block label tone-danger">
              {model.exit.state.replace(/_/g, " ")}
            </span>
            <span className="sr-only">exit: {model.exit.label}</span>
          </li>
        )}
      </ol>
      <div className="mt-2 md:hidden">
        {model ? (
          <span className="hud-mission">{summary.currentLabel ?? "—"}</span>
        ) : (
          <span className="label text-faint">no mission in focus</span>
        )}
        {summary.exit && <span className="ml-2 label tone-danger">exit: {summary.exit.label}</span>}
        <p className="mt-1 label num text-faint">
          completed {summary.completed} of {summary.total} · skipped {summary.skipped} · pending {summary.pending}
        </p>
        <div
          role="meter"
          aria-label="Mission pipeline"
          aria-valuemin={0}
          aria-valuemax={summary.total}
          aria-valuenow={summary.completed + summary.currentCount}
          aria-valuetext={`${summary.completed} completed, ${summary.currentCount} current, ${summary.skipped} skipped, ${summary.pending} pending of ${summary.total}${summary.exit ? `, exit ${summary.exit.label}` : ""}`}
          className="pipe mt-2 w-full"
        >
          {(model?.waypoints ?? lifecycleEmpty()).map((w) => (
            <span key={w.state} className={cn("pipe-seg", w.status)} title={`${w.label} · ${w.status}`} />
          ))}
          {summary.exit && <span className="pipe-exit" title={summary.exit.label} />}
        </div>
        <p className="mt-1 label text-faint">{summary.nextOnTimeline ? `next on timeline: ${summary.nextOnTimeline.label}` : "next on timeline: —"}</p>
        {action && (
          <p className={cn("hud-action mt-1", HUD_TONE_CLASS[action.tone])}>{action.text}</p>
        )}
        <details className="mt-2">
          <summary className="btn min-h-11 inline-flex items-center">All 17 states</summary>
          <ol className="mt-2 flex flex-col gap-1" aria-label="All lifecycle states">
            {(model?.waypoints ?? lifecycleEmpty()).map((w) => (
              <li key={w.state} className="label flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-border py-1 text-faint">
                <span className="text-foreground">{w.label}</span>
                <span>{w.status}</span>
                {w.enteredAt && <span>entered {timeHMS(w.enteredAt)}</span>}
                {w.visits > 1 && <span>{w.visits} visits</span>}
                {w.implied && <span>implied</span>}
              </li>
            ))}
            {summary.exit && (
              <li className="label flex flex-wrap items-center gap-x-2 gap-y-0.5 py-1 tone-danger">
                <span>{summary.exit.label}</span>
                <span>exit</span>
                {summary.exit.ts && <span>entered {timeHMS(summary.exit.ts)}</span>}
              </li>
            )}
          </ol>
        </details>
      </div>
    </section>
  );
}

function lifecycleEmpty() {
  return lifecyclePath({ steps: [], current: null, exit: null, transitions: [] }).waypoints;
}
