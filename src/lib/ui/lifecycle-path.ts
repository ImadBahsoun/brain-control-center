// The 17 recorded lifecycle steps as the mission path. Statuses are passed through from
// TaskDetail.lifecycle (completed/current/pending/skipped); nothing is inferred here. Pure.
import type { LifecycleView, StepStatus } from "@/lib/api-types";
import { stateLabel, TIMELINE, type TimelineState } from "@/lib/lifecycle";

export interface Waypoint {
  index: number;
  state: TimelineState;
  /** Short map label; the full recorded label is `label`. */
  short: string;
  label: string;
  status: StepStatus;
  implied: boolean;
  enteredAt: string | null;
  visits: number;
}

export interface LifecyclePathModel {
  waypoints: Waypoint[];
  currentIndex: number | null;
  exit: LifecycleView["exit"];
  current: string | null;
  transitions: number;
}

export interface LifecyclePathSummary {
  completed: number;
  skipped: number;
  pending: number;
  currentCount: number;
  total: number;
  /** The waypoints with status "current" (2 for VALIDATING: TESTING and REVIEWING). */
  current: Waypoint[];
  currentLabel: string | null;
  /** The waypoint immediately after the furthest current step (whatever its own status); null with no current step or an exit. */
  nextOnTimeline: Waypoint | null;
  exit: LifecycleView["exit"];
}

export const SHORT_LABELS: Record<TimelineState, string> = {
  RECEIVED: "RECEIVED",
  CLASSIFYING: "CLASSIFY",
  PLANNING: "PLAN",
  WAITING_FOR_APPROVAL: "PLAN GATE",
  IMPLEMENTING: "BUILD",
  TESTING: "TEST",
  REVIEWING: "REVIEW",
  SYNTHESIZING: "SYNTHESIS",
  FIXING: "FIX",
  REVALIDATING: "REVALIDATE",
  READY: "READY",
  HUMAN_APPROVAL: "CMDR GATE",
  COMMITTING: "COMMIT",
  PUSHING: "PUSH",
  PR: "PR",
  DEPLOYING: "DEPLOY",
  COMPLETE: "COMPLETE",
};

export function lifecyclePath(lifecycle: LifecycleView): LifecyclePathModel {
  const byState = new Map(lifecycle.steps.map((s) => [s.state, s]));
  let currentIndex: number | null = null;
  const waypoints: Waypoint[] = TIMELINE.map((state, index) => {
    const step = byState.get(state);
    const status: StepStatus = step?.status ?? "pending";
    if (status === "current" && currentIndex === null) currentIndex = index;
    return {
      index,
      state,
      short: SHORT_LABELS[state],
      label: step?.label ?? state,
      status,
      implied: step?.implied ?? false,
      enteredAt: step?.enteredAt ?? null,
      visits: step?.visits ?? 0,
    };
  });
  return { waypoints, currentIndex, exit: lifecycle.exit, current: lifecycle.current, transitions: lifecycle.transitions.length };
}

/** Counts and the mobile Mission Path's facts, taken only from `model.waypoints[].status` (and the exit). */
export function lifecycleSummary(model: LifecyclePathModel): LifecyclePathSummary {
  let completed = 0;
  let skipped = 0;
  let pending = 0;
  const current: Waypoint[] = [];
  model.waypoints.forEach((w) => {
    if (w.status === "completed") completed++;
    else if (w.status === "skipped") skipped++;
    else if (w.status === "pending") pending++;
    else if (w.status === "current") current.push(w);
  });
  const highestCurrentIndex = current.length > 0 ? Math.max(...current.map((w) => w.index)) : null;
  // the very next step on the timeline, whatever its own status: a revisited round's next step may
  // already be "completed" from an earlier pass (e.g. round-2 FIXING after REVALIDATING passed once)
  const nextOnTimeline = highestCurrentIndex === null || model.exit ? null : (model.waypoints[highestCurrentIndex + 1] ?? null);
  return {
    completed,
    skipped,
    pending,
    currentCount: current.length,
    total: model.waypoints.length,
    current,
    currentLabel: model.current ? stateLabel(model.current) : null,
    nextOnTimeline,
    exit: model.exit,
  };
}
