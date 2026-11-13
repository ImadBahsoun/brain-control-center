// The Commander Gate: the two human approval points of a mission (the plan gate on the planner →
// developer edge, the human gate after READY) read from the lifecycle, the plan projection, the
// APPROVAL_* activity lines and brain-gate's aggregates. It has no action: approval happens in the
// Claude Code session, never here. Pure.
import type { ActivityItem, EventsResponse, GateStatus, HealthResponse, StepStatus, TaskDetail } from "@/lib/api-types";
import { isTerminalStatus } from "@/lib/lifecycle";

export type GateState = "action-required" | "passed" | "not-required" | "sealed" | "unknown";

export const GATE_STATE_LABEL: Record<GateState, string> = {
  "action-required": "ACTION REQUIRED",
  passed: "PASSED",
  "not-required": "NOT REQUIRED",
  sealed: "SEALED",
  unknown: "UNKNOWN",
};

export interface GateFacet {
  kind: "plan" | "human";
  state: GateState;
  label: string;
  stepStatus: StepStatus | null;
  source: string;
}

export interface GateRequest {
  seq: number;
  ts: string;
  /** The request kind as recorded in the activity line, e.g. "plan", "release", "risk". */
  kind: string | null;
  text: string;
  detail: string | null;
  /** The request's own `expires` (ISO), when its payload carried one; null otherwise. */
  expires: string | null;
  source: string;
}

const KIND_RE = /\(([^()]*)\)\s*$/;

export interface CommanderGate {
  /** Which gate is waiting on the commander right now, if any. */
  active: "plan" | "human" | null;
  plan: GateFacet;
  human: GateFacet;
  /** The latest APPROVAL_REQUESTED with no later APPROVAL_GRANTED / APPROVAL_REJECTED in the loaded window. */
  request: GateRequest | null;
  /** True when a gate is active but the request line is outside the loaded event window. */
  requestOutsideWindow: boolean;
  /** The last APPROVAL_GRANTED / APPROVAL_REJECTED / PLAN_APPROVED line, for the history. */
  lastDecision: ActivityItem | null;
  planScope: TaskDetail["plan"];
  brainGate: { status: GateStatus; pending: number; pendingByAction: Record<string, number>; source: string } | null;
}

function facetState(stepStatus: StepStatus | null, waiting: boolean): GateState {
  if (waiting) return "action-required";
  if (stepStatus === "completed") return "passed";
  if (stepStatus === "skipped") return "not-required";
  if (stepStatus === "pending") return "sealed";
  return "unknown";
}

function facet(kind: "plan" | "human", detail: TaskDetail | null, waiting: boolean): GateFacet {
  const stepState = kind === "plan" ? "WAITING_FOR_APPROVAL" : "HUMAN_APPROVAL";
  const step = detail?.lifecycle.steps.find((s) => s.state === stepState) ?? null;
  let state = facetState(step?.status ?? null, waiting);
  if (kind === "plan" && state === "sealed" && detail?.plan?.approved) state = "passed";
  // a mission that ended before the gate will never require it
  if (state === "sealed" && detail && isTerminalStatus(detail.status)) state = "not-required";
  return { kind, state, label: GATE_STATE_LABEL[state], stepStatus: step?.status ?? null, source: `/api/tasks/:id lifecycle.steps[${stepState}]` };
}

export function commanderGate(detail: TaskDetail | null, events: EventsResponse | null, health: HealthResponse | null): CommanderGate {
  const current = detail?.lifecycle.current ?? null;
  const planWaiting = current === "WAITING_FOR_APPROVAL";
  const humanWaiting = current === "HUMAN_APPROVAL";
  const active = planWaiting ? "plan" : humanWaiting ? "human" : null;

  let request: GateRequest | null = null;
  let lastDecision: ActivityItem | null = null;
  if (events) {
    for (const item of events.events) {
      if (item.type === "APPROVAL_REQUESTED") {
        const kind = KIND_RE.exec(item.text)?.[1] ?? null;
        request = { seq: item.seq, ts: item.ts, kind, text: item.text, detail: item.detail ?? null, expires: item.expires ?? null, source: `/api/tasks/:id/events #${item.seq} APPROVAL_REQUESTED` };
      } else if (item.type === "APPROVAL_GRANTED" || item.type === "APPROVAL_REJECTED") {
        request = null;
        lastDecision = item;
      } else if (item.type === "PLAN_APPROVED") {
        // a plan approval settles an open plan-kind request even without an APPROVAL_GRANTED line
        if (request?.kind === "plan") request = null;
        lastDecision = item;
      }
    }
  }
  const requestOutsideWindow = active !== null && request === null && (events?.hasMore ?? false);

  const gate = health?.sources.gate ?? null;
  return {
    active,
    plan: facet("plan", detail, planWaiting),
    human: facet("human", detail, humanWaiting),
    request,
    requestOutsideWindow,
    lastDecision,
    planScope: detail?.plan ?? null,
    brainGate: gate
      ? { status: gate.status, pending: gate.requests.pending, pendingByAction: gate.requests.pendingByAction, source: "/api/health sources.gate.requests (brain-gate pending requests, all tasks)" }
      : null,
  };
}

/**
 * What the Commander Gate callout can honestly say about a request's age, against `now` (the /api/tasks
 * generatedAt). The per-task log can carry its own `expires` (ISO) on the request, which settles the
 * question outright: expired past it, nothing to say otherwise. When it does not — including a "gate"
 * kind request, whose brain-gate code has its own expiry that is never linked back to a task — a gate
 * request still gets a neutral age-based hint; any other kind says nothing, since nothing here proves
 * either way. Never claims "expired" without a timestamp.
 */
export type GateExpiry = { kind: "expired" } | { kind: "maybe-expired" } | null;

export function requestExpiry(request: GateRequest | null, now: string | null): GateExpiry {
  if (!request) return null;
  if (request.expires) {
    const exp = Date.parse(request.expires);
    const n = now ? Date.parse(now) : NaN;
    if (!Number.isNaN(exp) && !Number.isNaN(n)) return exp < n ? { kind: "expired" } : null;
  }
  return request.kind === "gate" ? { kind: "maybe-expired" } : null;
}
