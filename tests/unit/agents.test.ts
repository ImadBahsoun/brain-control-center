import { describe, expect, it } from "vitest";
import { projectAgentRuns } from "@/server/brain/agents";
import { parsePolicy } from "@/server/brain/governor";
import { buildLog, deriveState, highRiskScript, SENTINELS, VALID_POLICY, writeScript, freshHome } from "../helpers/fixture-store";

const TID = "BR-20261007-0001";
const policyResult = parsePolicy(Buffer.from(JSON.stringify(VALID_POLICY)));
const policy = policyResult.status === "ok" ? policyResult.policy : null;

describe("projectAgentRuns", () => {
  it("projects runs with role labels, policy model class, null effort and units, and drops session/repo/from/to", () => {
    const home = freshHome();
    const t = writeScript(home, TID, highRiskScript(home, { complete: true }));
    const runs = projectAgentRuns(TID, t.state.agents, policy, Date.now());
    expect(runs.length).toBe(7);
    const planner = runs[0];
    expect(planner?.role).toBe("planner");
    expect(planner?.roleLabel).toBe("Planner");
    expect(planner?.model).toBe("opus");
    expect(planner?.effort).toBeNull();
    expect(planner?.reservedUnits).toBe(2);
    expect(planner?.status).toBe("completed");
    expect(planner?.verdict).toBe("PLAN_READY");
    expect(planner?.agentId).toBe("agent-planner-1");
    expect(planner?.durationMs).toBe(1000);
    expect(runs.find((r) => r.role === "security-reviewer")?.roleLabel).toBe("Security Reviewer");
    const fix = runs.find((r) => r.kind === "fix");
    expect(fix?.round).toBe(1);
    const out = JSON.stringify(runs);
    expect(out).not.toContain(SENTINELS.session);
    expect(out).not.toContain("proj/repo");
    expect(out).not.toContain(SENTINELS.packet);
    expect(out).not.toContain(SENTINELS.report);
    expect(Object.keys(planner ?? {}).sort()).toEqual(
      ["agentId", "completedAt", "durationMs", "effort", "epoch", "kind", "model", "rerun", "reservedUnits", "role", "roleLabel", "round", "staleOverThreshold", "startedAt", "status", "taskId", "verdict"].sort(),
    );
    expect(planner?.epoch).toBe(0);
  });

  it("labels pending, not-launched and lost runs, and flags pending runs over the stale threshold", () => {
    const built = buildLog(TID, [
      { type: "TASK_CREATED", payload: { summary: "s", class: "STANDARD" }, state: "IMPLEMENTING", ts: "2026-10-07T00:00:00.000Z" },
      { type: "AGENT_STARTED", payload: { agent: "developer" }, ts: "2026-10-07T00:00:01.000Z" },
      { type: "AGENT_COMPLETED", payload: { agent: "developer", status_or_verdict: "not-launched", report: "r" }, ts: "2026-10-07T00:00:02.000Z" },
      { type: "AGENT_STARTED", payload: { agent: "developer", rerun_reason: "launch failed, retry" }, ts: "2026-10-07T00:00:03.000Z" },
      { type: "AGENT_COMPLETED", payload: { agent: "developer", status_or_verdict: "lost", report: "r" }, ts: "2026-10-07T00:00:04.000Z" },
      { type: "AGENT_STARTED", payload: { agent: "unknown-agent", kind: "replacement" }, ts: "2026-10-07T00:00:05.000Z" },
    ]);
    // attach completions by correlation id by hand
    built.events[2]!.correlation_id = built.events[1]!.event_id;
    built.events[4]!.correlation_id = built.events[3]!.event_id;
    const st = deriveState(TID, built);
    const now = Date.parse("2026-10-07T05:00:00.000Z");
    const runs = projectAgentRuns(TID, st.agents, policy, now);
    expect(runs.map((r) => r.status)).toEqual(["not-launched", "lost", "pending"]);
    expect(runs[0]?.reservedUnits).toBe(0);
    expect(runs[1]?.reservedUnits).toBe(3);
    expect(runs[1]?.rerun).toBe(true);
    expect(runs[2]?.reservedUnits).toBe(3); // unknown agent counts at the maximum unit value
    expect(runs[2]?.model).toBeNull();
    expect(runs[2]?.staleOverThreshold).toBe(true); // ~5 h > 240 min
    const fresh = projectAgentRuns(TID, st.agents, policy, Date.parse("2026-10-07T01:00:00.000Z"));
    expect(fresh[2]?.staleOverThreshold).toBe(false);
    const noPolicy = projectAgentRuns(TID, st.agents, null, now);
    expect(noPolicy[1]?.reservedUnits).toBeNull();
    expect(noPolicy[1]?.model).toBeNull();
  });

  it("returns nothing for a malformed agents field", () => {
    expect(projectAgentRuns(TID, null, policy, Date.now())).toEqual([]);
    expect(projectAgentRuns(TID, { developer: "nope" }, policy, Date.now())).toEqual([]);
  });
});
