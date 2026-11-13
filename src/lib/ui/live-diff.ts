// One-shot map effects come only from a change between two consecutive snapshots of the same
// mission. A first load, a mission switch, an identical refetch or a reordered array yields nothing,
// and no snapshot exists until both the detail and the findings of the focused mission have arrived.
import type { AgentRunStatus, TaskStatus } from "@/lib/api-types";
import type { CommandMapModel } from "./command-map";
import { ROLES, type Role } from "./roles";
import { OPEN_STATUSES } from "./threats";

export interface RoleSnapshot {
  pending: number;
  /** Runs that are no longer pending (completed, lost or not launched). */
  completed: number;
  lastVerdict: string | null;
  lastStatus: AgentRunStatus | null;
}

export interface Snapshot {
  missionId: string;
  status: TaskStatus;
  current: string | null;
  ready: boolean;
  waitingApproval: boolean;
  blocked: boolean;
  roles: Record<Role, RoleSnapshot>;
  openFindingIds: string[];
  resolvedFindingIds: string[];
  findingSeverity: Record<string, string>;
}

export type LiveEffect =
  | { kind: "agent-start"; target: Role }
  | { kind: "agent-complete"; target: Role; verdict: string | null; status: AgentRunStatus | null }
  | { kind: "finding-new"; target: string; severity: string }
  | { kind: "finding-resolved"; target: string }
  | { kind: "step"; target: string; from: string | null }
  | { kind: "gate-raised"; target: "gate" }
  | { kind: "blocked"; target: "core" }
  | { kind: "ready"; target: "ready" }
  | { kind: "mission-complete"; target: "ready" };

/** Null until the mission's detail and findings have both arrived, so a staged first load diffs nothing. */
export function snapshotOf(model: CommandMapModel): Snapshot | null {
  const d = model.detail;
  if (!d || !model.findingsLoaded) return null;
  const roles = {} as Record<Role, RoleSnapshot>;
  for (const role of ROLES) {
    const runs = d.agents.filter((r) => r.role === role).sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
    const done = runs.filter((r) => r.status !== "pending");
    const last = done[done.length - 1] ?? null;
    roles[role] = { pending: runs.length - done.length, completed: done.length, lastVerdict: last?.verdict ?? null, lastStatus: last?.status ?? null };
  }
  const open: string[] = [];
  const resolved: string[] = [];
  const findingSeverity: Record<string, string> = {};
  for (const f of model.findings) {
    findingSeverity[f.id] = f.severity;
    (OPEN_STATUSES.has(f.status) ? open : resolved).push(f.id);
  }
  open.sort();
  resolved.sort();
  return {
    missionId: d.id,
    status: d.status,
    current: d.lifecycle.current,
    ready: d.ready,
    waitingApproval: d.waitingApproval,
    blocked: d.blocked,
    roles,
    openFindingIds: open,
    resolvedFindingIds: resolved,
    findingSeverity,
  };
}

export function diffSnapshots(prev: Snapshot | null, next: Snapshot | null): LiveEffect[] {
  if (!prev || !next || prev.missionId !== next.missionId) return [];
  const out: LiveEffect[] = [];
  for (const role of ROLES) {
    const p = prev.roles[role];
    const n = next.roles[role];
    if (n.pending > p.pending) out.push({ kind: "agent-start", target: role });
    if (n.completed > p.completed) out.push({ kind: "agent-complete", target: role, verdict: n.lastVerdict, status: n.lastStatus });
  }
  const prevOpen = new Set(prev.openFindingIds);
  const prevResolved = new Set(prev.resolvedFindingIds);
  for (const id of next.openFindingIds) if (!prevOpen.has(id)) out.push({ kind: "finding-new", target: id, severity: next.findingSeverity[id] ?? "" });
  for (const id of next.resolvedFindingIds) if (!prevResolved.has(id)) out.push({ kind: "finding-resolved", target: id });
  if (next.current !== prev.current && next.current !== null) out.push({ kind: "step", target: next.current, from: prev.current });
  if (!prev.waitingApproval && next.waitingApproval) out.push({ kind: "gate-raised", target: "gate" });
  if (!prev.blocked && next.blocked) out.push({ kind: "blocked", target: "core" });
  if (!prev.ready && next.ready) out.push({ kind: "ready", target: "ready" });
  if (prev.status !== "COMPLETE" && next.status === "COMPLETE") out.push({ kind: "mission-complete", target: "ready" });
  return out;
}

export function describeEffect(e: LiveEffect): string {
  switch (e.kind) {
    case "agent-start":
      return `${e.target} reserved and started`;
    case "agent-complete":
      if (e.status === "lost") return `${e.target} run lost (units consumed)`;
      if (e.status === "not-launched") return `${e.target} not launched (units refunded)`;
      return `${e.target} reported${e.verdict ? `: ${e.verdict}` : ""}`;
    case "finding-new":
      return `new ${e.severity} finding ${e.target}`;
    case "finding-resolved":
      return `finding ${e.target} resolved`;
    case "step":
      return `lifecycle moved to ${e.target}`;
    case "gate-raised":
      return "commander approval required";
    case "blocked":
      return "mission blocked";
    case "ready":
      return "mission READY";
    case "mission-complete":
      return "mission complete";
  }
}
