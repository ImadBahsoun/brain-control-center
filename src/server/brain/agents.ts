import "server-only";
import type { AgentRun, AgentRunStatus, GovernorPolicy } from "@/lib/api-types";
import { roleLabel } from "./events";
import { agentModel, agentUnits } from "./governor";
import { asArr, asInt, asObj, asStr, epochMs } from "./jsonish";

/**
 * state.json `agents` → AgentRun projections. Session, repo, from/to and complete_content are dropped.
 * A run with no completed_at is "pending": a reservation with no report yet. The Brain has no liveness
 * data, so the UI labels it "pending (reserved, no report yet)".
 */
export function projectAgentRuns(taskId: string, agentsRaw: unknown, policy: GovernorPolicy | null, nowMs: number): AgentRun[] {
  const byRole = asObj(agentsRaw);
  if (!byRole) return [];
  const staleMs = (policy?.staleAfterMinutes ?? 240) * 60_000;
  const out: AgentRun[] = [];
  for (const [role, runsRaw] of Object.entries(byRole)) {
    for (const r of asArr(runsRaw).map(asObj)) {
      if (!r) continue;
      const startedAt = asStr(r.started_at);
      const completedAt = asStr(r.completed_at);
      const verdict = asStr(r.verdict);
      let status: AgentRunStatus;
      if (completedAt === null) status = "pending";
      else if (verdict === "not-launched") status = "not-launched";
      else if (verdict === "lost") status = "lost";
      else status = "completed";
      const s = epochMs(startedAt);
      const c = epochMs(completedAt);
      const units = policy ? (status === "not-launched" ? 0 : agentUnits(policy, role)) : null;
      out.push({
        taskId,
        role,
        roleLabel: roleLabel(role),
        model: agentModel(policy, role),
        effort: null,
        agentId: asStr(r.agent_id),
        kind: asStr(r.kind) ?? "initial",
        round: asInt(r.round),
        epoch: asInt(r.epoch),
        status,
        staleOverThreshold: status === "pending" && s !== null && nowMs - s > staleMs,
        verdict,
        reservedUnits: units,
        startedAt,
        completedAt,
        durationMs: s !== null && c !== null ? Math.max(0, c - s) : null,
        rerun: asStr(r.rerun_reason) !== null && asStr(r.rerun_reason) !== "",
      });
    }
  }
  out.sort((a, b) => (epochMs(a.startedAt) ?? 0) - (epochMs(b.startedAt) ?? 0));
  return out;
}
