// The command map model: every node, edge, threat and meter the map draws, derived from the unchanged
// read-only API bodies. Each item carries a `source` naming the API field it came from, and the state
// rules below are the only place the map decides what a line or node means. Pure, unit-tested.
import type { AgentRun, AgentRunStatus, AgentsResponse, EventsResponse, Finding, FindingsResponse, GovernorResponse, HealthResponse, StepStatus, TaskDetail, TaskSummary, TasksResponse } from "@/lib/api-types";
import { isTerminalStatus, mapState, stateLabel, TIMELINE, type TimelineState } from "@/lib/lifecycle";
import { commanderGate, requestExpiry, type CommanderGate, type GateExpiry } from "./gate";
import { EDGES, LANE_SLOTS, type EdgeDef, type EdgeId, type NodeId } from "./layout";
import { resourceMeters, type ResourceModel } from "./resources";
import { isRole, ROLE_ARCHETYPES, ROLE_LABELS, ROLE_STEP_NUMBER, ROLE_STEPS, ROLES, type Role } from "./roles";
import { OPEN_STATUSES, sortThreats, threatAnchor, threatClass, THREAT_CLASS_LABEL, type ThreatClass } from "./threats";
import { verdictTone, type VerdictTone } from "./verdict";

export type EdgeState = "completed" | "running" | "pending" | "waiting-approval" | "blocked" | "failed" | "skipped" | "unknown";
/**
 * live: an active mission; debrief: a terminal one; idle: no mission in focus; loading: a focus whose detail
 * has not arrived; replay: a frame rebuilt from a terminal mission's recorded events (src/lib/ui/replay.ts).
 */
export type MapMode = "live" | "debrief" | "idle" | "loading" | "replay";

/** AgentRun.effort is always null: nothing the dashboard reads records it. */
export const EFFORT_LABEL = "not recorded";

/** The word under a role or step node. A pending reservation reads ACTIVE: the Brain records no liveness. */
export const STATE_WORD: Record<EdgeState, string> = {
  completed: "COMPLETED",
  running: "ACTIVE",
  pending: "PENDING",
  "waiting-approval": "AWAITING APPROVAL",
  blocked: "BLOCKED",
  failed: "FAILED",
  skipped: "SKIPPED",
  unknown: "UNKNOWN",
};

export const EDGE_STATE_LABEL: Record<EdgeState, string> = {
  completed: "COMPLETED",
  running: "RUNNING",
  pending: "PENDING",
  "waiting-approval": "WAITING APPROVAL",
  blocked: "BLOCKED",
  failed: "FAILED",
  skipped: "SKIPPED",
  unknown: "UNKNOWN",
};

/** Display name of a map node, shared by edges, panels and announcements. */
export function nodeName(id: NodeId | string): string {
  if (isRole(id)) return ROLE_LABELS[id];
  switch (id) {
    case "core":
      return "Brain core";
    case "synthesis":
      return "Synthesis";
    case "ready":
      return "READY";
    case "gate":
      return "Commander Gate";
    default:
      return id;
  }
}

export interface RoleNodeModel {
  kind: "role";
  id: Role;
  label: string;
  archetype: string;
  stepNo: string;
  state: EdgeState;
  /** A pending run older than the governor's stale threshold: still reserved, drawn without flow. */
  stale: boolean;
  statusText: string;
  /** The word drawn under the node: IDLE on the idle map, LOADING while loading, else the state word (a completed run shows its verdict). */
  stateWord: string;
  verdict: string | null;
  verdictTone: VerdictTone;
  model: string | null;
  /** Units one run of this role costs: the policy's value, else the recorded reservedUnits of the latest launched run; null when neither exists. */
  unitsPerRun: number | null;
  policyUnits: number | null;
  /** Sums over this mission's runs; null when no run carries a recorded unit value (no policy). */
  reservedUnits: number | null;
  consumedUnits: number | null;
  round: number | null;
  maxRounds: number;
  runKind: string | null;
  rerun: boolean;
  latestRun: AgentRun | null;
  runs: AgentRun[];
  openFindings: number;
  /** Idle map only: the role's latest completed run anywhere (from /api/agents recent). */
  recent: AgentRun | null;
  /** Live map only: this role's pending runs on other missions (from /api/agents active). */
  elsewhere: AgentRun[];
  stepStatuses: Array<{ state: TimelineState; status: StepStatus }>;
  source: string;
}

export interface CoreNodeModel {
  kind: "core";
  id: "core";
  live: boolean;
  statusText: string;
  status: TaskSummary["status"] | null;
  blockedReason: string | null;
  blockedNeeds: string[];
  unknownRoles: string[];
  source: string;
}

export interface StepNodeModel {
  kind: "step";
  id: "synthesis" | "ready";
  label: string;
  stepNo: string;
  state: EdgeState;
  statusText: string;
  stepStatus: StepStatus | null;
  source: string;
}

export interface GateNodeModel {
  kind: "gate";
  id: "gate";
  label: string;
  stepNo: string;
  state: EdgeState;
  /** The word drawn under the node. */
  stateWord: string;
  statusText: string;
  gate: CommanderGate;
  source: string;
}

export type NodeModel = RoleNodeModel | CoreNodeModel | StepNodeModel | GateNodeModel;

export interface EdgeModel extends EdgeDef {
  state: EdgeState;
  stale: boolean;
  /** True on the idle and loading maps: no mission data, the edge is drawn dormant. */
  dormant: boolean;
  stateText: string;
  detail: string;
  /** E2 only: whether a plan gate exists or existed on this mission, so the lock glyph is drawn. */
  lock: boolean;
  /** E7–E9 only: the report was delivered and the mission is in SYNTHESIZING now (drawn purple; the state stays completed). */
  synthesizing: boolean;
  source: string;
}

export interface ThreatModel {
  id: string;
  finding: Finding;
  anchor: Role | "core";
  threatClass: ThreatClass;
  classLabel: string;
  severity: string;
  label: string;
  source: string;
}

export interface ThreatLaneModel {
  anchor: Role | "core";
  /** Markers drawn in the lane's slots (at most LANE_SLOTS, or LANE_SLOTS − 1 when a "+n" chip is needed). */
  shown: ThreatModel[];
  /** Findings of this anchor that are not drawn; shown as a "+n" chip in the last slot. */
  overflow: number;
}

/** The ACTION REQUIRED strip; exists only while a gate waits on the commander. It carries no action. */
export interface GateCallout {
  kind: "plan" | "human";
  title: string;
  requestText: string | null;
  requestDetail: string | null;
  requestOutsideWindow: boolean;
  /** When the open request was recorded (for an age hint); null without a loaded request line. */
  requestedAt: string | null;
  /** What the request's own data proves about expiry; see requestExpiry. */
  expiry: GateExpiry;
  source: string;
}

export interface CommandMapModel {
  mode: MapMode;
  missionId: string | null;
  detail: TaskDetail | null;
  /** True once the focused mission's findings response has arrived (threats and snapshots wait for it). */
  findingsLoaded: boolean;
  core: CoreNodeModel;
  roles: RoleNodeModel[];
  synthesis: StepNodeModel;
  ready: StepNodeModel;
  gate: GateNodeModel;
  gateCallout: GateCallout | null;
  edges: EdgeModel[];
  /** Every finding of the focused mission. */
  findings: Finding[];
  /** Every finding as a threat, sorted (open first, then severity, then newest). */
  threats: ThreatModel[];
  /** The markers actually drawn, per anchor lane. */
  lanes: ThreatLaneModel[];
  /** Findings not drawn as markers (the "+n" chips add up to this). */
  threatOverflow: number;
  resources: ResourceModel;
  banner: string | null;
  integrityChip: string | null;
}

export interface CommandMapInput {
  detail: TaskDetail | null;
  findings: FindingsResponse | null;
  events: EventsResponse | null;
  agents: AgentsResponse | null;
  governor: GovernorResponse | null;
  health: HealthResponse | null;
  tasks: TasksResponse | null;
  /** The mission the viewer is focused on, when its detail has not arrived yet (loading or erroring). */
  focusId?: string | null;
  loadError?: string | null;
  /** /api/tasks's own poll error, when it has never answered. */
  tasksError?: string | null;
}

const INDEX = new Map<string, number>(TIMELINE.map((s, i) => [s, i]));
const SYNTHESIZING_INDEX = INDEX.get("SYNTHESIZING") ?? 7;

function stepOf(detail: TaskDetail, state: TimelineState): StepStatus | null {
  return detail.lifecycle.steps.find((s) => s.state === state)?.status ?? null;
}

/** The highest timeline index reached (completed or current); -1 when nothing was. */
export function reachedIndex(detail: TaskDetail): number {
  let max = -1;
  for (const s of detail.lifecycle.steps) {
    if (s.status === "completed" || s.status === "current") max = Math.max(max, INDEX.get(s.state) ?? -1);
  }
  return max;
}

function byStartedAt(a: AgentRun, b: AgentRun): number {
  return (a.startedAt ?? "").localeCompare(b.startedAt ?? "");
}

function integrityUnusable(detail: TaskDetail): boolean {
  return detail.summaryUnavailable || detail.status === "CORRUPT" || detail.status === "INCOMPLETE";
}

/** Why run states cannot be read: the real cause, not a fixed phrase. */
export function unknownReason(detail: TaskDetail): string {
  if (detail.summaryUnavailable) return `state.json not usable (cache ${detail.integrity.cache})`;
  const i = detail.integrity;
  if (i.log === "corrupt") return `log corrupt at line ${i.corruptLine ?? "?"}${i.corruptReason ? ` (${i.corruptReason})` : ""}`;
  if (i.log === "incomplete") return "log incomplete (no complete TASK_CREATED first event)";
  if (i.log !== "ok" && i.log !== "torn_tail") return `log ${i.log}`;
  return `status ${detail.status}`;
}

interface RoleState {
  state: EdgeState;
  stale: boolean;
  text: string;
  latest: AgentRun | null;
  runs: AgentRun[];
  verdict: string | null;
  tone: VerdictTone;
}

/** Plan step 3: the state of a role on the focused mission. */
export function roleState(detail: TaskDetail, role: Role): RoleState {
  const runs = detail.agents.filter((r) => r.role === role).sort(byStartedAt);
  const latest = runs[runs.length - 1] ?? null;
  const base = { latest, runs, verdict: null, tone: "neutral" as VerdictTone, stale: false };
  if (integrityUnusable(detail)) {
    return { ...base, state: "unknown", text: `UNKNOWN · ${unknownReason(detail)}` };
  }
  const pending = runs.filter((r) => r.status === "pending");
  if (pending.length > 0) {
    const stale = pending.every((r) => r.staleOverThreshold);
    return {
      ...base,
      latest: pending[pending.length - 1] ?? latest,
      state: "running",
      stale,
      text: stale ? "RESERVED · no report, over stale threshold" : "ACTIVE · reserved, awaiting report",
    };
  }
  // a not-launched run after a real one does not erase that run's result
  const effective = [...runs].reverse().find((r) => r.status !== "not-launched") ?? latest;
  if (effective && (effective.status === "lost" || verdictTone(effective.verdict, effective.status) === "fail")) {
    const text = effective.status === "lost" ? "FAILED · lost (units consumed)" : `FAILED · ${effective.verdict ?? ""}`;
    return { ...base, latest: effective, state: "failed", text, verdict: effective.verdict, tone: "fail" };
  }
  if (effective && effective.status === "completed") {
    return { ...base, latest: effective, state: "completed", text: `COMPLETED · ${effective.verdict ?? ""}`, verdict: effective.verdict, tone: verdictTone(effective.verdict) };
  }
  if (runs.length > 0 && runs.every((r) => r.status === "not-launched")) {
    return { ...base, state: "skipped", text: "NOT LAUNCHED · units refunded" };
  }
  if (runs.length === 0) {
    const steps = ROLE_STEPS[role].map((s) => stepOf(detail, s));
    if (isTerminalStatus(detail.status) || steps.every((s) => s === "skipped") || reachedIndex(detail) >= SYNTHESIZING_INDEX) {
      return { ...base, state: "skipped", text: "SKIPPED · no run recorded" };
    }
  }
  return { ...base, state: "pending", text: "PENDING · awaiting dispatch" };
}

function fromStep(status: StepStatus | null, runningWhenCurrent = true): EdgeState {
  if (status === "completed") return "completed";
  if (status === "skipped") return "skipped";
  if (status === "current") return runningWhenCurrent ? "running" : "completed";
  return "pending";
}

/** Which edges a BLOCKED mission's last reached step maps onto (Brain amendment). */
const BLOCKED_EDGES: Partial<Record<TimelineState, EdgeId[]>> = {
  PLANNING: ["E1"],
  WAITING_FOR_APPROVAL: ["E2"],
  IMPLEMENTING: ["E3"],
  TESTING: ["E4"],
  REVIEWING: ["E5", "E6"],
  SYNTHESIZING: ["E7", "E8", "E9"],
  FIXING: ["E12"],
  REVALIDATING: ["E4", "E5", "E6"],
  READY: ["E10"],
  HUMAN_APPROVAL: ["E11"],
};

/** The dispatch and report edges of the three validators (E4–E9). */
const VALIDATOR_EDGES: ReadonlySet<EdgeId> = new Set<EdgeId>(["E4", "E5", "E6", "E7", "E8", "E9"]);

/** The dispatch (or brief / report) edge of each role, and the role behind each report edge. */
export const ROLE_EDGE: Record<Role, EdgeId> = { planner: "E1", developer: "E3", qa: "E4", reviewer: "E5", "security-reviewer": "E6" };
export const REPORT_EDGE: Partial<Record<EdgeId, Role>> = { E7: "qa", E8: "reviewer", E9: "security-reviewer" };

/** The role whose runs sit behind an edge, if any. */
export function edgeRole(id: EdgeId): Role | null {
  const direct = (Object.keys(ROLE_EDGE) as Role[]).find((r) => ROLE_EDGE[r] === id);
  return direct ?? REPORT_EDGE[id] ?? null;
}

function edgeModel(def: EdgeDef, state: EdgeState, detail: string, source: string, opts: { stale?: boolean; dormant?: boolean; lock?: boolean; synthesizing?: boolean } = {}): EdgeModel {
  return { ...def, state, stale: opts.stale ?? false, dormant: opts.dormant ?? false, lock: opts.lock ?? false, synthesizing: opts.synthesizing ?? false, stateText: EDGE_STATE_LABEL[state], detail, source };
}

/** The last recorded transition that sits on the timeline, and the steps it lights (VALIDATING lights two). */
export function lastReachedSteps(detail: TaskDetail): { state: string; steps: TimelineState[] } | null {
  for (let i = detail.lifecycle.transitions.length - 1; i >= 0; i--) {
    const t = detail.lifecycle.transitions[i];
    if (!t) continue;
    const steps = mapState(t.state);
    if (steps.length > 0) return { state: t.state, steps };
  }
  return null;
}

function buildEdges(detail: TaskDetail, roles: Record<Role, RoleState>, gate: CommanderGate): EdgeModel[] {
  const current = detail.lifecycle.current;
  const id = detail.id;
  const src = (field: string) => `/api/tasks/${id} ${field}`;
  const reached = reachedIndex(detail);
  const unusable = integrityUnusable(detail);
  const out: EdgeModel[] = [];

  for (const def of EDGES) {
    if (def.id === "E12" && !(detail.rounds.length > 0 || current === "FIXING")) continue;
    let model: EdgeModel;
    const role = (Object.keys(ROLE_EDGE) as Role[]).find((r) => ROLE_EDGE[r] === def.id);
    if (role) {
      const rs = roles[role];
      model = edgeModel(def, rs.state, rs.text, src(`agents[role=${role}]`), { stale: rs.stale });
    } else if (def.id === "E2") {
      const waiting = stepOf(detail, "WAITING_FOR_APPROVAL");
      const planning = stepOf(detail, "PLANNING");
      const developerHasRun = roles.developer.runs.length > 0;
      // the lock is drawn once the plan gate is or was reached, or from the start on a HIGH-RISK mission (which always has one)
      const lock = waiting === "current" || waiting === "completed" || detail.classification === "HIGH-RISK";
      let state: EdgeState;
      let text: string;
      if (current === "WAITING_FOR_APPROVAL") {
        state = "waiting-approval";
        text = "plan gate · commander approval required";
      } else if (waiting === "completed" || (roles.planner.state === "completed" && developerHasRun)) {
        state = "completed";
        text = detail.plan?.approved ? "plan approved · handed to the developer" : "plan handed to the developer";
      } else if (planning === "skipped") {
        state = "skipped";
        text = "no planning step on this mission";
      } else if (roles.planner.state === "completed") {
        state = "pending";
        text = "plan ready · developer not yet dispatched";
      } else {
        state = "pending";
        text = "plan not yet produced";
      }
      model = edgeModel(def, state, text, src("lifecycle.steps[WAITING_FOR_APPROVAL], plan"), { lock });
    } else if (REPORT_EDGE[def.id]) {
      const rrole = REPORT_EDGE[def.id] as Role;
      const rs = roles[rrole];
      let state: EdgeState;
      let text: string;
      if (unusable) {
        state = "unknown";
        text = rs.text;
      } else if (rs.state === "running") {
        state = "running";
        text = "report pending · run reserved";
      } else if (rs.state === "failed") {
        state = "failed";
        text = rs.text;
      } else if (rs.state === "skipped") {
        state = "skipped";
        text = rs.text;
      } else if (rs.state === "completed" && reached >= SYNTHESIZING_INDEX) {
        state = "completed";
        text = `report synthesized · ${rs.verdict ?? ""}`;
      } else {
        state = "pending";
        text = rs.state === "completed" ? "report delivered · synthesis not reached yet" : "no report yet";
      }
      model = edgeModel(def, state, text, src(`agents[role=${rrole}], lifecycle.steps[SYNTHESIZING]`), { stale: rs.stale, synthesizing: state === "completed" && current === "SYNTHESIZING" });
    } else if (def.id === "E10") {
      const ready = stepOf(detail, "READY");
      const state: EdgeState = ready === "completed" || ready === "current" || detail.ready ? "completed" : ready === "skipped" ? "skipped" : "pending";
      model = edgeModel(def, state, state === "completed" ? "READY reached" : "READY not reached", src("lifecycle.steps[READY], ready"));
    } else if (def.id === "E11") {
      const human = stepOf(detail, "HUMAN_APPROVAL");
      const state: EdgeState = current === "HUMAN_APPROVAL" ? "waiting-approval" : fromStep(human, false);
      model = edgeModel(def, state, `commander gate · ${gate.human.label}`, src("lifecycle.steps[HUMAN_APPROVAL]"));
    } else {
      // E12 fix loop
      const everyRoundClosed = detail.rounds.length > 0 && detail.rounds.every((r) => r.completed);
      const state: EdgeState = current === "FIXING" || current === "REVALIDATING" ? "running" : everyRoundClosed ? "completed" : "pending";
      const text = current === "FIXING" ? "fix round in progress" : current === "REVALIDATING" ? "fix delivered · revalidating" : everyRoundClosed ? `${detail.rounds.length} fix round(s) closed` : "fix round open";
      model = edgeModel(def, state, text, src("rounds, lifecycle.current"));
    }
    out.push(model);
  }

  // overrides
  if (detail.status === "BLOCKED") {
    const last = lastReachedSteps(detail);
    const ids = new Set<EdgeId>(last ? last.steps.flatMap((s) => BLOCKED_EDGES[s] ?? []) : []);
    const inProgress = detail.validation.inProgress?.agents ?? [];
    for (const e of out) {
      // a validator edge is red only when that validator was part of the blocked step: it has a run or was dispatched
      const validator = VALIDATOR_EDGES.has(e.id) ? edgeRole(e.id) : null;
      if (validator && roles[validator].runs.length === 0 && !inProgress.includes(validator)) continue;
      if (ids.has(e.id)) {
        e.state = "blocked";
        e.stateText = EDGE_STATE_LABEL.blocked;
        e.detail = `blocked at ${last ? stateLabel(last.state) : "?"}${detail.blockedInfo?.reason ? ` · ${detail.blockedInfo.reason}` : ""}`;
      }
    }
  }
  if (detail.status === "CANCELLED") {
    for (const e of out) {
      if (e.state === "pending") {
        e.state = "skipped";
        e.stateText = EDGE_STATE_LABEL.skipped;
        e.detail = "mission cancelled";
      }
    }
  }
  return out;
}

/** The word under a role node with a mission in focus. */
function roleWord(rs: RoleState): string {
  if (rs.state === "running" && rs.stale) return "RESERVED · STALE";
  if (rs.state === "completed" && rs.verdict) return rs.verdict.toUpperCase();
  return STATE_WORD[rs.state];
}

function roleNode(role: Role, rs: RoleState | null, detail: TaskDetail | null, governor: GovernorResponse | null, agents: AgentsResponse | null, findings: readonly Finding[], idleText: string, idleWord: string): RoleNodeModel {
  const policy = governor?.policy?.agents[role] ?? null;
  const runs = rs?.runs ?? [];
  let reserved: number | null = null;
  let consumed: number | null = null;
  for (const r of runs) {
    if (r.reservedUnits === null) continue;
    if (r.status === "pending") reserved = (reserved ?? 0) + r.reservedUnits;
    else consumed = (consumed ?? 0) + r.reservedUnits;
  }
  if (reserved !== null && consumed === null) consumed = 0;
  if (consumed !== null && reserved === null) reserved = 0;
  const latest = rs?.latest ?? null;
  const recent = detail ? null : (agents?.recent.find((r) => r.role === role) ?? null);
  const elsewhere = detail ? (agents?.active.filter((r) => r.role === role && r.taskId !== detail.id) ?? []) : [];
  const state: EdgeState = rs?.state ?? "pending";
  // the latest launched run's own recorded reservation stands in for the policy when the policy is not polled (mission
  // detail page); a not-launched run records 0 (a refund), which is not the cost of a run
  const launched = (r: AgentRun | null | undefined) => (r && r.status !== "not-launched" && r.reservedUnits !== null ? r.reservedUnits : null);
  const recordedUnits = launched([...runs].reverse().find((r) => launched(r) !== null)) ?? launched(recent);
  return {
    kind: "role",
    id: role,
    label: ROLE_LABELS[role],
    archetype: ROLE_ARCHETYPES[role],
    stepNo: ROLE_STEP_NUMBER[role],
    state,
    stale: rs?.stale ?? false,
    statusText: rs ? rs.text : idleText,
    stateWord: rs ? roleWord(rs) : idleWord,
    verdict: rs?.verdict ?? null,
    verdictTone: rs?.tone ?? "neutral",
    model: policy?.model ?? latest?.model ?? recent?.model ?? null,
    unitsPerRun: policy?.policyUnits ?? recordedUnits,
    policyUnits: policy?.policyUnits ?? null,
    reservedUnits: reserved,
    consumedUnits: consumed,
    round: latest?.round ?? null,
    maxRounds: detail?.maxRounds ?? 0,
    runKind: latest?.kind ?? null,
    rerun: latest?.rerun ?? false,
    latestRun: latest,
    runs,
    openFindings: findings.filter((f) => f.sources.includes(role) && OPEN_STATUSES.has(f.status)).length,
    recent,
    elsewhere,
    stepStatuses: ROLE_STEPS[role].map((s) => ({ state: s, status: detail ? (stepOf(detail, s) ?? "pending") : "pending" })),
    source: detail ? `/api/tasks/${detail.id} agents[role=${role}]` : `/api/agents recent[role=${role}]`,
  };
}

function stepNode(id: "synthesis" | "ready", detail: TaskDetail | null, idleText: string): StepNodeModel {
  const label = id === "synthesis" ? "Synthesis" : "Ready";
  const stepNo = id === "synthesis" ? "06" : "07";
  const stepState: TimelineState = id === "synthesis" ? "SYNTHESIZING" : "READY";
  if (!detail) return { kind: "step", id, label, stepNo, state: "pending", statusText: idleText, stepStatus: null, source: "no mission in focus" };
  const status = stepOf(detail, stepState);
  let state: EdgeState = fromStep(status);
  if (id === "ready" && (detail.ready || status === "current")) state = "completed";
  if (detail.status === "CANCELLED" && state === "pending") state = "skipped";
  const text =
    id === "ready" && detail.ready ? "READY · mission validated" : status === "current" ? `CURRENT · ${stateLabel(stepState)}` : status === "completed" ? `COMPLETED · ${stateLabel(stepState)}` : status === "skipped" ? "SKIPPED" : "PENDING";
  return { kind: "step", id, label, stepNo, state, statusText: text, stepStatus: status, source: `/api/tasks/${detail.id} lifecycle.steps[${stepState}]${id === "ready" ? ", ready" : ""}` };
}

/** The Gate node follows gate.active: a waiting plan gate or human gate both read ACTION REQUIRED here. */
function gateNode(detail: TaskDetail | null, gate: CommanderGate, idleText: string): GateNodeModel {
  const base = { kind: "gate" as const, id: "gate" as const, label: "Commander Gate", stepNo: "08", gate, source: gate.human.source };
  if (!detail) return { ...base, state: "pending", stateWord: idleText, statusText: idleText };
  if (gate.active === "plan") return { ...base, state: "waiting-approval", stateWord: "ACTION REQUIRED", statusText: "ACTION REQUIRED · plan gate (planner → developer)", source: gate.plan.source };
  if (gate.active === "human") return { ...base, state: "waiting-approval", stateWord: "ACTION REQUIRED", statusText: "ACTION REQUIRED · human approval" };
  const h = gate.human;
  const state: EdgeState = h.state === "passed" ? "completed" : h.state === "not-required" ? "skipped" : h.state === "sealed" ? "pending" : "unknown";
  return { ...base, state, stateWord: h.label, statusText: `${h.label} · human approval` };
}

function gateCallout(gate: CommanderGate, now: string | null): GateCallout | null {
  if (!gate.active) return null;
  return {
    kind: gate.active,
    title: gate.active === "plan" ? "plan gate · planner → developer" : "human gate · after READY",
    requestText: gate.request?.text ?? null,
    requestDetail: gate.request?.detail ?? null,
    requestOutsideWindow: gate.requestOutsideWindow,
    requestedAt: gate.request?.ts ?? null,
    expiry: requestExpiry(gate.request, now),
    source: gate.request?.source ?? (gate.active === "plan" ? gate.plan.source : gate.human.source),
  };
}

/** Markers per anchor lane: up to LANE_SLOTS, with the last slot given to a "+n" chip when more anchor there. */
export function threatLanes(threats: readonly ThreatModel[]): ThreatLaneModel[] {
  const anchors: Array<Role | "core"> = [...ROLES, "core"];
  const out: ThreatLaneModel[] = [];
  for (const anchor of anchors) {
    const list = threats.filter((t) => t.anchor === anchor);
    if (list.length === 0) continue;
    const shown = list.length > LANE_SLOTS ? list.slice(0, LANE_SLOTS - 1) : list;
    out.push({ anchor, shown, overflow: list.length - shown.length });
  }
  return out;
}

export function buildCommandMap(input: CommandMapInput): CommandMapModel {
  const { detail, findings, events, agents, governor, health } = input;
  const list = findings?.findings ?? [];
  const gate = commanderGate(detail, events, health);
  const resources = resourceMeters(governor, detail?.usage ?? null);
  const unknownRoles = [...new Set((detail?.agents ?? []).map((r) => r.role).filter((r) => !isRole(r)))];

  if (!detail) {
    const unreachable = !input.focusId && input.tasks === null && !!input.tasksError;
    const loading = !!input.focusId || unreachable;
    const idleText = loading ? "LOADING" : "IDLE";
    const roleIdleText = input.focusId ? `LOADING · mission ${input.focusId}` : unreachable ? "LOADING · /api/tasks" : "IDLE · no reservation";
    const roles = ROLES.map((r) => roleNode(r, null, null, governor, agents, [], roleIdleText, idleText));
    const coreText = unreachable
      ? `ERROR · ${input.tasksError} · mission list unavailable`
      : input.focusId
        ? input.loadError
          ? `ERROR · ${input.loadError}`
          : `LOADING · mission ${input.focusId}`
        : "STANDBY · no active mission";
    const edgeSource = unreachable ? "/api/tasks" : input.focusId ? `/api/tasks/${input.focusId}` : "/api/tasks (no active mission)";
    return {
      mode: loading ? "loading" : "idle",
      missionId: input.focusId ?? null,
      detail: null,
      findingsLoaded: false,
      core: { kind: "core", id: "core", live: false, statusText: coreText, status: null, blockedReason: null, blockedNeeds: [], unknownRoles: [], source: unreachable ? "/api/tasks" : loading ? `/api/tasks/${input.focusId}` : "/api/tasks counts.active" },
      roles,
      synthesis: stepNode("synthesis", null, idleText),
      ready: stepNode("ready", null, idleText),
      gate: gateNode(null, gate, idleText),
      gateCallout: null,
      edges: EDGES.filter((e) => e.id !== "E12").map((e) => edgeModel(e, "pending", loading ? "loading · mission data not yet received" : "dormant · no mission in focus", edgeSource, { dormant: true })),
      findings: [],
      threats: [],
      lanes: [],
      threatOverflow: 0,
      resources,
      banner: null,
      integrityChip: null,
    };
  }

  const states = Object.fromEntries(ROLES.map((r) => [r, roleState(detail, r)])) as Record<Role, RoleState>;
  const roles = ROLES.map((r) => roleNode(r, states[r], detail, governor, agents, list, "", ""));
  const mode: MapMode = isTerminalStatus(detail.status) || detail.status === "CORRUPT" || detail.status === "INCOMPLETE" ? "debrief" : "live";
  const threats: ThreatModel[] = sortThreats(list).map((f) => {
    const cls = threatClass(f);
    return {
      id: f.id,
      finding: f,
      anchor: threatAnchor(f.sources),
      threatClass: cls,
      classLabel: THREAT_CLASS_LABEL[cls],
      severity: f.severity,
      label: `${f.severity} · ${f.status} · ${f.id}`,
      source: `/api/tasks/${detail.id}/findings findings[${f.id}]`,
    };
  });
  const lanes = threatLanes(threats);

  const integrityProblem = detail.integrity.log !== "ok" || (detail.integrity.cache !== "fresh" && detail.integrity.cache !== "stale");
  const coreText =
    detail.status === "BLOCKED"
      ? `BLOCKED${detail.blockedInfo?.reason ? ` · ${detail.blockedInfo.reason}` : ""}`
      : detail.status === "COMPLETE"
        ? "MISSION COMPLETE"
        : detail.status === "CANCELLED"
          ? "MISSION CANCELLED"
          : detail.status === "CORRUPT" || detail.status === "INCOMPLETE"
            ? `${detail.status} · ${unknownReason(detail)}`
            : `LIVE · ${detail.lifecycle.current ? stateLabel(detail.lifecycle.current) : "—"}`;

  return {
    mode,
    missionId: detail.id,
    detail,
    findingsLoaded: findings !== null,
    core: {
      kind: "core",
      id: "core",
      live: mode === "live",
      statusText: coreText,
      status: detail.status,
      blockedReason: detail.blockedInfo?.reason ?? null,
      blockedNeeds: detail.blockedInfo?.needs ?? [],
      unknownRoles,
      source: `/api/tasks/${detail.id} status, lifecycle.current, blockedInfo`,
    },
    roles,
    synthesis: stepNode("synthesis", detail, ""),
    ready: stepNode("ready", detail, ""),
    gate: gateNode(detail, gate, ""),
    gateCallout: gateCallout(gate, input.tasks?.generatedAt ?? null),
    edges: buildEdges(detail, states, gate),
    findings: list,
    threats,
    lanes,
    threatOverflow: lanes.reduce((n, l) => n + l.overflow, 0),
    resources,
    banner: detail.status === "CANCELLED" ? "MISSION CANCELLED" : detail.status === "BLOCKED" ? "MISSION BLOCKED" : null,
    integrityChip: integrityProblem ? `log ${detail.integrity.log} · cache ${detail.integrity.cache}` : null,
  };
}

export type { AgentRunStatus };
