import "server-only";
import type { AgentRun, AgentsResponse, GovernorDenial, GovernorResponse, GovernorSoftLimit, QueuedLaunch } from "@/lib/api-types";
import { concurrencyQueue, globalUsage, governorNotes, loadPolicy, taskUsage } from "./governor";
import type { BrainRoots } from "./roots";
import { agentRunsOf, scanTasks, TERMINAL_STATUSES, type LoadedTask } from "./task-store";

/** The cross-task bodies of /api/agents and /api/governor, composed from one store scan. */

function nonTerminal(tasks: readonly LoadedTask[]): LoadedTask[] {
  return tasks.filter((t) => !TERMINAL_STATUSES.has(t.summary.status));
}

function byCompletedDesc(a: AgentRun, b: AgentRun): number {
  return (b.completedAt ?? "").localeCompare(a.completedAt ?? "");
}

export async function agentsResponse(roots: BrainRoots, nowMs: number): Promise<AgentsResponse> {
  const policy = await loadPolicy(roots);
  const scan = await scanTasks(roots, nowMs);
  const open = nonTerminal(scan.tasks);
  const pool = new Map<string, LoadedTask>();
  for (const t of [...open, ...scan.tasks.slice(0, 5)]) pool.set(t.id, t);

  const active: AgentRun[] = [];
  for (const t of open) active.push(...agentRunsOf(t, policy, nowMs).filter((r) => r.status === "pending"));
  active.sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));

  const recent: AgentRun[] = [];
  for (const t of pool.values()) recent.push(...agentRunsOf(t, policy, nowMs).filter((r) => r.status !== "pending"));
  recent.sort(byCompletedDesc);

  // concurrency-denied launches still waiting, from the governor NOTEs of each open task's (fully parsed) log
  const staleMs = (policy.status === "ok" ? policy.policy.staleAfterMinutes : 240) * 60_000;
  const queued: QueuedLaunch[] = [];
  for (const t of open) {
    const q = t.log ? concurrencyQueue(t.id, t.log.events, nowMs, staleMs) : null;
    if (q) queued.push(q);
  }
  queued.sort((a, b) => a.deniedSeq - b.deniedSeq || a.taskId.localeCompare(b.taskId));

  return {
    generatedAt: new Date(nowMs).toISOString(),
    active,
    recent: recent.slice(0, 20),
    limits: policy.status === "ok" ? policy.policy.global : null,
    queued,
  };
}

export async function governorResponse(roots: BrainRoots, nowMs: number): Promise<GovernorResponse> {
  const policy = await loadPolicy(roots);
  const pol = policy.status === "ok" ? policy.policy : null;
  const scan = await scanTasks(roots, nowMs);
  const open = nonTerminal(scan.tasks);

  const pending: AgentRun[] = [];
  const tasks: GovernorResponse["tasks"] = [];
  const denials: GovernorDenial[] = [];
  const softLimitAccepted: GovernorSoftLimit[] = [];
  for (const t of open) {
    const runs = agentRunsOf(t, policy, nowMs);
    pending.push(...runs.filter((r) => r.status === "pending"));
    if (t.summary.active) {
      tasks.push({ taskId: t.id, classification: t.summary.classification, ...taskUsage(runs, t.summary.classification, pol) });
    }
    if (t.log) {
      const notes = governorNotes(t.id, t.log.events);
      denials.push(...notes.denials);
      softLimitAccepted.push(...notes.softLimits);
    }
  }
  denials.sort((a, b) => b.ts.localeCompare(a.ts));
  softLimitAccepted.sort((a, b) => b.ts.localeCompare(a.ts));

  return {
    generatedAt: new Date(nowMs).toISOString(),
    policy: pol,
    policyStatus: policy.status,
    policyReason: policy.status === "ok" ? null : policy.reason,
    global: globalUsage(pending, pol, nowMs),
    tasks,
    denials: denials.slice(0, 20),
    softLimitAccepted: softLimitAccepted.slice(0, 20),
  };
}
