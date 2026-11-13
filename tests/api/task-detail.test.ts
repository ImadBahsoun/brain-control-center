import { describe, expect, it } from "vitest";
import type { ApiError, TaskDetail } from "@/lib/api-types";
import { GET } from "@/app/api/tasks/[id]/route";
import { freshHome, highRiskScript, mkdirs, SENTINELS, standardScript, writeGovernor, writeScript } from "../helpers/fixture-store";

const H = { headers: { host: "127.0.0.1:3077" } };
const call = (id: string) => GET(new Request(`http://127.0.0.1:3077/api/tasks/${encodeURIComponent(id)}`, H), { params: Promise.resolve({ id }) });

describe("GET /api/tasks/[id]", () => {
  it("returns the full detail with ~ for the repository and the 17-step lifecycle", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    writeScript(home, "BR-20261007-0001", highRiskScript(home, { stopAfter: 24 })); // FIX_ROUND_STARTED → FIXING
    const res = await call("BR-20261007-0001");
    expect(res.status).toBe(200);
    const d = (await res.json()) as TaskDetail;
    expect(d.repository).toBe("~/proj/repo");
    expect(d.state).toBe("FIXING");
    expect(d.status).toBe("ACTIVE");
    expect(d.round).toBe(1);
    expect(d.lifecycle.steps).toHaveLength(17);
    expect(d.lifecycle.steps.find((s) => s.state === "FIXING")?.status).toBe("current");
    expect(d.lifecycle.steps.find((s) => s.state === "TESTING")?.status).toBe("completed");
    expect(d.lifecycle.steps.find((s) => s.state === "READY")?.status).toBe("pending");
    expect(d.agents.filter((a) => a.status === "pending")).toHaveLength(0);
    expect(d.usage?.consumed).toBe(2 + 3 + 2 + 2 + 2);
    expect(d.usage?.classBudget).toBe(36);
    expect(d.plan?.approved).toBe(true);
    expect(d.rounds).toEqual([{ round: 1, kind: "developer", findings: ["F-001"], findingsAddressed: {}, completed: false }]);
    expect(d.validation.latest?.decision).toBe("FIX_REQUIRED");
    expect(d.filesChanged).toEqual([{ agent: "developer", round: 0, files: ["src/a.ts", "src/b.ts"] }]);
    expect(d.testsRun).toEqual([{ agent: "developer", round: 0, cmd: "pnpm test", result: "pass 12" }]);
    expect(d.agents.every((a) => a.effort === null)).toBe(true);
    expect(d.agents.find((a) => a.role === "developer")?.model).toBe("fable");
    const text = JSON.stringify(d);
    for (const s of [SENTINELS.request, SENTINELS.session, SENTINELS.packet, SENTINELS.report, SENTINELS.planText, SENTINELS.command]) expect(text).not.toContain(s);
    expect(text).not.toContain("gate_code");
  });

  it("returns 404 TASK_NOT_FOUND for a well-formed unknown id", async () => {
    const home = freshHome();
    mkdirs(home);
    writeScript(home, "BR-20261007-0001", standardScript(home));
    const res = await call("BR-20261007-0002");
    expect(res.status).toBe(404);
    expect(((await res.json()) as ApiError).error.code).toBe("TASK_NOT_FOUND");
  });

  it("returns 404 when the store itself is missing", async () => {
    freshHome();
    const res = await call("BR-20261007-0002");
    expect(res.status).toBe(404);
  });
});
