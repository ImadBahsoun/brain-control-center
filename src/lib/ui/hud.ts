// The mission HUD: the header (mission number, title, class, round, governor share), the lifecycle pipeline
// bar and the current action, plus the per-role action and activity lines. Everything is read from the
// command map model, which is built from the unchanged API bodies: the bar counts lifecycle steps reached
// (not time or effort), and an action names a reservation, never a claim that an agent process is alive. Pure.
import type { AgentRun, StepStatus, TaskDetail, TaskEta, TaskStatus } from "@/lib/api-types";
import { formatElapsed } from "@/lib/eta";
import { stateLabel, TIMELINE, type TimelineState } from "@/lib/lifecycle";
import { atmosphere } from "./atmosphere";
import { lastReachedSteps, type CommandMapModel, type RoleNodeModel } from "./command-map";
import { SHORT_LABELS } from "./lifecycle-path";
import type { Role } from "./roles";

export type HudTone = "signal" | "ok" | "warn" | "danger" | "dim";

export interface PipelineSegment {
  state: TimelineState;
  short: string;
  label: string;
  status: StepStatus;
}

export interface Pipeline {
  segments: PipelineSegment[];
  /** Segments up to and including the furthest completed or current one. */
  reached: number;
  total: number;
  label: string;
  /** The meter's aria-valuetext. */
  valueText: string;
  title: string;
  /** "BLOCKED at Implementing" when the mission left the timeline. */
  exit: string | null;
}

export interface HudGovernor {
  /** "11%", or "—" when there is no class budget, no policy, or the value is not part of a replay. */
  short: string;
  detail: string;
  source: string;
}

export interface MissionHud {
  missionNo: string | null;
  missionId: string | null;
  title: string | null;
  classification: string | null;
  round: { round: number; maxRounds: number } | null;
  governor: HudGovernor | null;
  pipeline: Pipeline;
  /** The atmosphere phase as text. */
  phase: string;
}

export interface CurrentAction {
  /** The first role the action names (its emblem leads the line), or null for a Brain or mission action. */
  role: Role | null;
  roles: Role[];
  text: string;
  tone: HudTone;
  source: string;
}

const READY_INDEX = TIMELINE.indexOf("READY");
export const PIPELINE_NOTE = "lifecycle steps reached; not time or effort";

/** "#0002" from "BR-20261008-0002". */
export function missionNo(id: string | null | undefined): string | null {
  if (!id) return null;
  const tail = id.split("-").pop();
  return tail ? `#${tail}` : null;
}

/** RECEIVED … READY, plus post-READY steps once reached (COMPLETE included when the mission completed). */
export function pipeline(detail: TaskDetail | null): Pipeline {
  const byState = new Map((detail?.lifecycle.steps ?? []).map((s) => [s.state, s]));
  const segments: PipelineSegment[] = [];
  TIMELINE.forEach((state, i) => {
    const status: StepStatus = byState.get(state)?.status ?? "pending";
    if (i <= READY_INDEX || status === "completed" || status === "current") segments.push({ state, short: SHORT_LABELS[state], label: stateLabel(state), status });
  });
  let reached = 0;
  segments.forEach((s, i) => {
    if (s.status === "completed" || s.status === "current") reached = i + 1;
  });
  const total = segments.length;
  const toReady = segments[segments.length - 1]?.state === "READY";
  const current = detail?.lifecycle.current ?? null;
  const where = current ? stateLabel(current) : detail ? "—" : "no mission";
  let exit: string | null = null;
  if (detail?.lifecycle.exit) {
    const last = lastReachedSteps(detail);
    exit = `${detail.lifecycle.exit.label.toUpperCase()}${last ? ` at ${stateLabel(last.state)}` : ""}`;
  }
  return {
    segments,
    reached,
    total,
    // "steps reached", not "step n": a mission can go back to an earlier step (a plan gate sends it back to planning)
    label: `PIPELINE · ${where} · ${reached} of ${total} steps reached${toReady ? " (to READY)" : ""}`,
    valueText: `${reached} of ${total} lifecycle steps reached${current ? ` (${where})` : ""}${exit ? `, ${exit}` : ""}; ${PIPELINE_NOTE}`,
    title: `Lifecycle pipeline: ${PIPELINE_NOTE}. Source: lifecycle.steps`,
    exit,
  };
}

function hudGovernor(model: CommandMapModel): HudGovernor | null {
  const d = model.detail;
  if (!d) return null;
  if (model.mode === "replay") return { short: "—", detail: "governor usage is not recorded per step", source: "not part of the recorded history" };
  const u = d.usage;
  if (!u) return { short: "—", detail: "no governor policy", source: `/api/tasks/${d.id} usage` };
  const share = u.percentOfClassBudget !== null ? `${u.percentOfClassBudget}%` : "—";
  const budget = u.classBudget ? `${u.committed} / ${u.classBudget} units` : `${u.committed} units · no class budget`;
  return { short: share, detail: `${budget}${u.softLimitCrossed ? " · soft limit crossed" : ""} · ${u.note}`, source: `/api/tasks/${d.id} usage` };
}

export function missionHud(model: CommandMapModel): MissionHud {
  const d = model.detail;
  return {
    missionNo: missionNo(model.missionId),
    missionId: model.missionId,
    title: d?.title ?? null,
    classification: d?.classification ?? null,
    round: d ? { round: d.round, maxRounds: d.maxRounds } : null,
    governor: hudGovernor(model),
    pipeline: pipeline(d),
    phase: model.mode === "loading" && model.core.statusText.startsWith("ERROR") ? "ERROR" : atmosphere(model).label,
  };
}

/**
 * A mission's ETA as one line: a COMPLETE or CANCELLED mission reads its recorded total ("COMPLETE · 31m total"),
 * any other the ETA label. The mission list shows it as is; the HUD puts "Elapsed …" before a label.
 */
export function etaText(eta: TaskEta, status: TaskStatus | null): string {
  return isTerminalEta(eta, status) ? eta.reason : eta.label;
}

/** The status and the ETA agree that the mission ended (they come from different polls in the HUD). */
function isTerminalEta(eta: TaskEta, status: TaskStatus | null): boolean {
  return (status === "COMPLETE" && eta.kind === "complete") || (status === "CANCELLED" && eta.kind === "cancelled");
}

/**
 * The HUD's secondary "Elapsed 12m · ETA ~5–14 min" (dim; the ETA is an estimate, never a promise), or the recorded
 * total of a COMPLETE or CANCELLED mission. null in a replay (a recorded step has no ETA) and when /api/tasks has
 * none for the mission.
 */
export function etaHud(eta: TaskEta | null, mode: CommandMapModel["mode"], status: TaskStatus | null): { text: string; tone: HudTone; title: string } | null {
  if (!eta || mode === "replay") return null;
  return {
    text: isTerminalEta(eta, status) ? eta.reason : `Elapsed ${formatElapsed(eta.elapsedMinutes)} · ${eta.label}`,
    tone: "dim",
    title: `${eta.reason} · ${eta.note}${eta.basis ? ` · basis ${eta.basis}` : ""} · source /api/tasks eta`,
  };
}

/** The verb of a pending run, from its role and kind (a fix run names its round). */
export function runVerb(role: Role, run: AgentRun | null): string {
  const kind = run?.kind ?? "initial";
  const again = kind === "revalidation";
  switch (role) {
    case "planner":
      return "planning";
    case "developer":
      return kind === "fix" ? `fixing (round ${run?.round ?? 0})` : "implementing";
    case "qa":
      return again ? "re-testing" : "testing";
    case "reviewer":
      return again ? "re-reviewing" : "reviewing";
    case "security-reviewer":
      return again ? "security re-review" : "security review";
  }
}

function pendingPhrase(node: RoleNodeModel): string {
  return node.stale ? "reserved, no report (over stale threshold)" : "reserved, awaiting report";
}

/**
 * What the mission is doing now, in priority order: no mission; loading; a terminal or unreadable mission;
 * the Commander Gate; BLOCKED; pending runs (one clause per role); then the Brain's own steps, the
 * recorded next action, or the state. In a replay the same facts are told in the past tense: nothing in a
 * replayed step is a request for action or a claim about the present.
 */
export function currentAction(model: CommandMapModel): CurrentAction {
  const none = { role: null, roles: [] as Role[] };
  const d = model.detail;
  const past = model.mode === "replay";
  if (model.mode === "idle") return { ...none, text: "Standby · no active mission", tone: "dim", source: "/api/tasks counts.active" };
  if (!d) {
    const error = model.core.statusText.startsWith("ERROR");
    return { ...none, text: error ? model.core.statusText : `Loading mission ${model.missionId ?? ""}`.trim(), tone: error ? "danger" : "dim", source: model.core.source };
  }
  const src = (field: string) => `/api/tasks/${d.id} ${field}`;
  const summary = d.completionSummary ? ` · ${d.completionSummary}` : "";
  if (d.status === "COMPLETE") return { ...none, text: `${past ? "Mission completed" : "Mission complete"}${summary}`, tone: "ok", source: src("status, completionSummary") };
  if (d.status === "CANCELLED") return { ...none, text: `${past ? "Mission was cancelled" : "Mission cancelled"}${summary}`, tone: "dim", source: src("status, completionSummary") };
  if (d.status === "CORRUPT" || d.status === "INCOMPLETE") return { ...none, text: model.core.statusText, tone: "danger", source: src("status, integrity") };
  const gate = model.gate.gate.active;
  const gateName = gate === "plan" ? "plan gate" : "human gate";
  if (gate) return { ...none, text: past ? `Commander approval was awaited · ${gateName}` : `Commander approval required · ${gateName}`, tone: "warn", source: src("lifecycle.current") };
  if (d.status === "BLOCKED") {
    const last = lastReachedSteps(d);
    return { ...none, text: `${past ? "Was blocked" : "Blocked"} at ${last ? stateLabel(last.state) : "?"}${d.blockedInfo?.reason ? ` · ${d.blockedInfo.reason}` : ""}`, tone: "danger", source: src("status, blockedInfo, lifecycle.transitions") };
  }
  const pending = model.roles.filter((r) => r.state === "running");
  if (pending.length > 0) {
    const roles = pending.map((r) => r.id);
    const text = pending.map((r) => `${r.label} ${runVerb(r.id, r.latestRun)} · ${past ? "was reserved, no report yet" : pendingPhrase(r)}`).join(" · ");
    return { role: roles[0] ?? null, roles, text, tone: pending.every((r) => r.stale) ? "warn" : "signal", source: src("agents (pending runs)") };
  }
  const current = d.lifecycle.current;
  if (current === "CLASSIFYING") return { ...none, text: past ? "Brain was classifying" : "Brain classifying", tone: "signal", source: src("lifecycle.current") };
  if (current === "SYNTHESIZING") return { ...none, text: past ? "Brain was synthesizing reports" : "Brain synthesizing reports", tone: "signal", source: src("lifecycle.current") };
  if (current === "READY") return { ...none, text: past ? "READY was reached · validated" : "READY · validated", tone: "ok", source: src("lifecycle.current, ready") };
  if (d.nextAction) return { ...none, text: `next: ${d.nextAction}`, tone: "dim", source: src("nextAction") };
  return { ...none, text: current ? stateLabel(current) : "—", tone: "dim", source: src("lifecycle.current") };
}

/** The panel's "Current action" for one role; `replay` tells a replayed step in the past tense. */
export function roleAction(node: RoleNodeModel, detail: TaskDetail | null, opts: { replay?: boolean } = {}): { text: string; tone: HudTone; source: string } {
  const run = node.latestRun;
  if (!detail) {
    if (node.stateWord === "LOADING") return { text: "Loading the mission", tone: "dim", source: node.source };
    return node.recent
      ? { text: `Idle · last run on ${node.recent.taskId}: ${node.recent.verdict ?? node.recent.status}`, tone: "dim", source: node.source }
      : { text: "Idle · no reservation", tone: "dim", source: node.source };
  }
  const verb = runVerb(node.id, run);
  const idle = opts.replay ? "No run in progress at this step" : "No run in progress";
  switch (node.state) {
    case "running":
      return { text: `${verb[0]?.toUpperCase() ?? ""}${verb.slice(1)} · ${opts.replay ? "was reserved, no report yet at this step" : pendingPhrase(node)}`, tone: node.stale ? "warn" : "signal", source: node.source };
    case "completed":
      return { text: `${idle} · last report: ${node.verdict ?? "—"}`, tone: "dim", source: node.source };
    case "failed":
      return { text: run?.status === "lost" ? `${idle} · last run lost (units consumed)` : `${idle} · last report: ${node.verdict ?? "—"}`, tone: "danger", source: node.source };
    case "skipped":
      return { text: run?.status === "not-launched" ? "Not launched · units refunded" : "Not part of this mission's path", tone: "dim", source: node.source };
    case "unknown":
      return { text: node.statusText, tone: "dim", source: node.source };
    default:
      return { text: opts.replay ? "Not dispatched at this step" : "Awaiting dispatch", tone: "dim", source: node.source };
  }
}

/**
 * The node's activity (B-1), drawn dim after its state word ("ACTIVE · reserved", "ACTIVE · reserved · r1",
 * "PASS WITH CONCERNS · r0", "IDLE · last #0005"): what the role holds or last did on the focused mission, from
 * the same runs as roleAction. A pending run reads "reserved" (a reservation, not a sign of a live agent; the
 * verb is in the HUD, the panel and the node's accessible name); empty when the state word says it all.
 */
export function roleActivity(node: RoleNodeModel): string {
  const run = node.latestRun;
  const round = run?.round ?? 0;
  if (node.stateWord === "LOADING") return "";
  if (node.stateWord === "IDLE") return node.recent ? `last ${missionNo(node.recent.taskId) ?? ""}`.trim() : "";
  switch (node.state) {
    case "running":
      // a stale reservation already reads RESERVED · STALE
      if (node.stale) return round > 0 ? `r${round}` : "";
      return round > 0 ? `reserved · r${round}` : "reserved";
    case "completed":
      return `r${round}`;
    case "failed":
      return run?.status === "lost" ? `lost · r${round}` : `r${round}`;
    case "skipped":
      return run?.status === "not-launched" ? "not launched" : "not on path";
    case "unknown":
      return "";
    default:
      return "not dispatched";
  }
}

/** The focused mission's number on a role node, only when the role has a run on that mission. */
export function roleMission(node: RoleNodeModel, model: CommandMapModel): string | null {
  return model.detail && node.runs.length > 0 ? missionNo(model.detail.id) : null;
}

