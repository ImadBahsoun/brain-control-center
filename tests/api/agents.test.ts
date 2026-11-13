import { describe, expect, it } from "vitest";
import type { AgentsResponse } from "@/lib/api-types";
import { GET } from "@/app/api/agents/route";
import { freshHome, highRiskScript, mkdirs, SENTINELS, standardScript, writeGovernor, writeScript, type EventSpec } from "../helpers/fixture-store";

const H = { headers: { host: "127.0.0.1:3077" } };

describe("GET /api/agents", () => {
  it("lists pending runs of non-terminal tasks, recent completed runs, and the global limits", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    writeScript(home, "BR-20261007-0001", highRiskScript(home, { complete: true }));
    writeScript(home, "BR-20261007-0002", standardScript(home, { pendingDeveloper: true }));
    writeScript(home, "BR-20261007-0003", highRiskScript(home, { stopAfter: 16 })); // three validators pending
    const res = await GET(new Request("http://127.0.0.1:3077/api/agents", H), {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as AgentsResponse;
    expect(body.active.map((r) => [r.taskId, r.role, r.status])).toEqual([
      ["BR-20261007-0002", "developer", "pending"],
      ["BR-20261007-0003", "qa", "pending"],
      ["BR-20261007-0003", "reviewer", "pending"],
      ["BR-20261007-0003", "security-reviewer", "pending"],
    ]);
    expect(body.active[0]).toMatchObject({ roleLabel: "Developer", model: "fable", effort: null, reservedUnits: 3, kind: "initial" });
    expect(body.limits).toEqual({ max_total_agents: 3, max_developers: 1, max_validators: 3, max_opus_agents: 2, max_fable_agents: 2 });
    expect(body.recent.length).toBeGreaterThan(0);
    expect(body.recent.length).toBeLessThanOrEqual(20);
    expect(body.recent.every((r) => r.status !== "pending")).toBe(true);
    // newest completion first
    const times = body.recent.map((r) => r.completedAt ?? "");
    expect([...times].sort().reverse()).toEqual(times);
    const text = JSON.stringify(body);
    for (const s of [SENTINELS.session, SENTINELS.packet, SENTINELS.report, "proj/repo"]) expect(text).not.toContain(s);
  });
  it("works without a policy (model and units null)", async () => {
    const home = freshHome();
    mkdirs(home);
    writeScript(home, "BR-20261007-0002", standardScript(home, { pendingDeveloper: true }));
    const body = (await (await GET(new Request("http://127.0.0.1:3077/api/agents", H), {})).json()) as AgentsResponse;
    expect(body.limits).toBeNull();
    expect(body.active[0]).toMatchObject({ model: null, reservedUnits: null });
  });
  it("lists concurrency-denied launches of open tasks as `queued`: allowlisted fields only, none once an agent started", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    const deny = `[governor] DENIED CONCURRENCY qa, reviewer: global validators 4/3; active: BR-20261007-0001/qa seq 14 (initial, started 2026-10-07T08:00:13Z, session ${SENTINELS.session}); wait for a run to finish`;
    const validating = (extra: EventSpec[]): EventSpec[] => [
      ...standardScript(home),
      { type: "STATE_CHANGED", payload: {}, state: "VALIDATING" },
      { type: "NOTE", payload: { text: deny } },
      ...extra,
    ];
    // waiting: denied, then a wait with no end
    writeScript(home, "BR-20261007-0002", validating([{ type: "NOTE", payload: { text: `[governor] WAIT started 2026-10-07T08:00:06Z · qa, reviewer · timeout 30m · ${deny.slice(11)}` } }]));
    // answered: the validators started after the denial
    writeScript(home, "BR-20261007-0003", validating([{ type: "AGENT_STARTED", payload: { agent: "qa", kind: "initial", packet: SENTINELS.packet } }]));
    // terminal: a denial in a cancelled task is not a queued launch
    writeScript(home, "BR-20261007-0004", [...validating([]), { type: "TASK_COMPLETED", payload: { outcome: "CANCELLED", summary: "stop" }, state: "CANCELLED", next: null }]);
    const body = (await (await GET(new Request("http://127.0.0.1:3077/api/agents", H), {})).json()) as AgentsResponse;
    expect(body.queued).toEqual([
      {
        taskId: "BR-20261007-0002",
        roles: ["qa", "reviewer"],
        deniedSeq: 6,
        deniedAt: "2026-10-07T08:00:05.000Z",
        wait: { startedAt: "2026-10-07T08:00:06.000Z", timeoutMinutes: 30, endedAt: null, outcome: null },
        overStaleThreshold: true,
      },
    ]);
    for (const q of body.queued ?? []) {
      expect(Object.keys(q).sort()).toEqual(["deniedAt", "deniedSeq", "overStaleThreshold", "roles", "taskId", "wait"]);
      expect(Object.keys(q.wait ?? {}).sort()).toEqual(["endedAt", "outcome", "startedAt", "timeoutMinutes"]);
    }
    const text = JSON.stringify(body);
    for (const s of [SENTINELS.session, SENTINELS.packet, "global validators", "active:", home]) expect(text).not.toContain(s);
  });
});
