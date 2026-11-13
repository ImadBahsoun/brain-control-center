// The 17-step timeline and how recorded lifecycle states map onto it. Pure; used server-side and the
// result is shipped in TaskDetail.lifecycle.
import type { LifecycleStep, LifecycleTransition, LifecycleView, StepStatus, TaskStatus } from "./api-types";

export const TIMELINE = [
  "RECEIVED",
  "CLASSIFYING",
  "PLANNING",
  "WAITING_FOR_APPROVAL",
  "IMPLEMENTING",
  "TESTING",
  "REVIEWING",
  "SYNTHESIZING",
  "FIXING",
  "REVALIDATING",
  "READY",
  "HUMAN_APPROVAL",
  "COMMITTING",
  "PUSHING",
  "PR",
  "DEPLOYING",
  "COMPLETE",
] as const;

export type TimelineState = (typeof TIMELINE)[number];

/** States that are recorded but sit outside the timeline; they show as an exit marker. */
export const OFF_TIMELINE = ["BLOCKED", "ROUND_CAP_REACHED", "CANCELLED"] as const;

export const STATE_LABELS: Record<string, string> = {
  RECEIVED: "Received",
  CLASSIFYING: "Classifying",
  PLANNING: "Planning",
  WAITING_FOR_APPROVAL: "Waiting for approval",
  IMPLEMENTING: "Implementing",
  TESTING: "Testing",
  REVIEWING: "Reviewing",
  VALIDATING: "Validating",
  SYNTHESIZING: "Synthesizing",
  FIXING: "Fixing",
  REVALIDATING: "Revalidating",
  READY: "Ready",
  HUMAN_APPROVAL: "Human approval",
  COMMITTING: "Committing",
  PUSHING: "Pushing",
  PR: "Pull request",
  DEPLOYING: "Deploying",
  COMPLETE: "Complete",
  BLOCKED: "Blocked",
  ROUND_CAP_REACHED: "Round cap reached",
  CANCELLED: "Cancelled",
  CORRUPT: "Corrupt log",
  INCOMPLETE: "Incomplete log",
};

export function stateLabel(state: string): string {
  return STATE_LABELS[state] ?? state;
}

const INDEX = new Map<string, number>(TIMELINE.map((s, i) => [s, i]));

/** A recorded state → the timeline steps it lights. VALIDATING is TESTING plus REVIEWING. */
export function mapState(recorded: string | null | undefined): TimelineState[] {
  if (!recorded) return [];
  if (recorded === "VALIDATING") return ["TESTING", "REVIEWING"];
  return INDEX.has(recorded) ? [recorded as TimelineState] : [];
}

export function isTerminalStatus(status: TaskStatus): boolean {
  return status === "COMPLETE" || status === "CANCELLED";
}

export interface LifecycleInput {
  currentState: string | null;
  status: TaskStatus;
  hasTaskCreated: boolean;
  transitions: LifecycleTransition[];
}

export function buildLifecycle(input: LifecycleInput): LifecycleView {
  const { currentState, status, hasTaskCreated, transitions } = input;

  const visited = new Set<TimelineState>();
  const enteredAt = new Map<TimelineState, string>();
  const visits = new Map<TimelineState, number>();
  if (hasTaskCreated) visited.add("RECEIVED");
  for (const t of transitions) {
    for (const s of mapState(t.state)) {
      visited.add(s);
      enteredAt.set(s, t.ts);
      visits.set(s, (visits.get(s) ?? 0) + 1);
    }
  }

  const terminal = isTerminalStatus(status);
  const offTimeline =
    status === "CORRUPT" || status === "INCOMPLETE"
      ? status
      : currentState && (OFF_TIMELINE as readonly string[]).includes(currentState)
        ? currentState
        : null;

  // Steps lit as current. A terminal COMPLETE has no current step: everything is completed or skipped.
  const currentSteps = new Set<TimelineState>(terminal || offTimeline ? [] : mapState(currentState));
  if (status === "COMPLETE") visited.add("COMPLETE");

  // The anchor: steps below it that were never visited were skipped (e.g. PLANNING on STANDARD).
  let anchor = -1;
  if (currentSteps.size > 0) {
    anchor = Math.min(...[...currentSteps].map((s) => INDEX.get(s) ?? -1));
  } else if (status === "COMPLETE") {
    anchor = INDEX.get("COMPLETE") ?? -1;
  } else {
    for (let i = transitions.length - 1; i >= 0 && anchor < 0; i--) {
      const mapped = mapState(transitions[i]?.state);
      if (mapped.length > 0) anchor = Math.max(...mapped.map((s) => INDEX.get(s) ?? -1));
    }
  }

  const steps: LifecycleStep[] = TIMELINE.map((state, idx) => {
    let stepStatus: StepStatus;
    if (currentSteps.has(state)) stepStatus = "current";
    else if (visited.has(state)) stepStatus = "completed";
    else if (idx < anchor) stepStatus = "skipped";
    else stepStatus = "pending";
    return {
      state,
      label: stateLabel(state),
      status: stepStatus,
      implied: state === "RECEIVED" && visited.has("RECEIVED"),
      enteredAt: enteredAt.get(state) ?? null,
      visits: visits.get(state) ?? 0,
    };
  });

  let exit: LifecycleView["exit"] = null;
  if (offTimeline) {
    const last = [...transitions].reverse().find((t) => t.state === offTimeline);
    exit = { state: offTimeline, label: stateLabel(offTimeline), seq: last?.seq ?? null, ts: last?.ts ?? null };
  }

  return { steps, current: currentState, exit, transitions };
}
