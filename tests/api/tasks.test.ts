import { afterEach, describe, expect, it, vi } from "vitest";
import type { TasksResponse } from "@/lib/api-types";
import { GET } from "@/app/api/tasks/route";
import { freshHome, highRiskScript, mkdirs, SENTINELS, standardScript, writeGovernor, writeScript } from "../helpers/fixture-store";

const H = { headers: { host: "127.0.0.1:3077" } };

afterEach(() => vi.useRealTimers());

describe("GET /api/tasks", () => {
  it("lists tasks with counts, the newest first, and never leaks the request or sessions", async () => {
    const home = freshHome();
    mkdirs(home);
    writeScript(home, "BR-20261007-0001", highRiskScript(home, { complete: true }));
    writeScript(home, "BR-20261007-0002", standardScript(home, { pendingDeveloper: true }));
    const res = await GET(new Request("http://127.0.0.1:3077/api/tasks", H), {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as TasksResponse;
    expect(body.tasks.map((t) => t.id)).toEqual(["BR-20261007-0002", "BR-20261007-0001"]);
    expect(body.counts).toMatchObject({ total: 2, active: 1 });
    expect(body.scan).toEqual({ status: "ok", scanned: 2, scanLimitReached: false, unsafeEntries: 0 });
    expect(body.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // the summary's repository is home-masked, same as TaskDetail.repository: "~/proj/repo", never the raw home-prefixed path
    for (const t of body.tasks) expect(t.repository).toBe("~/proj/repo");
    const text = JSON.stringify(body);
    for (const s of [SENTINELS.request, SENTINELS.session, SENTINELS.packet, SENTINELS.report, SENTINELS.planText, home]) expect(text).not.toContain(s);
  });
  it("gives every task an ETA estimate computed on read", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-07T09:00:00.000Z")); // the scripts start at 08:00:00
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    writeScript(home, "BR-20261007-0001", highRiskScript(home, { complete: true }));
    writeScript(home, "BR-20261007-0002", standardScript(home, { pendingDeveloper: true }));
    writeScript(home, "BR-20261007-0003", standardScript(home, { blocked: true }));
    const body = (await (await GET(new Request("http://127.0.0.1:3077/api/tasks", H), {})).json()) as TasksResponse;
    const eta = (id: string) => body.tasks.find((t) => t.id === id)?.eta;
    for (const t of body.tasks) expect(t.eta?.note, t.id).toBe("estimate, not a guarantee");
    expect(eta("BR-20261007-0001")).toMatchObject({ kind: "complete", label: "ETA complete", low: null, high: null, elapsedMinutes: 0 });
    expect(eta("BR-20261007-0001")?.reason).toBe("COMPLETE · 0m total");
    // the pending developer is long past its band: a quarter of it is kept, plus reviewer and synthesis
    expect(eta("BR-20261007-0002")).toMatchObject({ kind: "estimate", low: 5, high: 18, basis: "fallback", label: "ETA ~5–18 min" });
    expect(eta("BR-20261007-0002")?.stages.map((s) => [s.name, s.status])).toEqual([["developer", "running"], ["validation", "queued"], ["synthesis", "queued"]]);
    expect(eta("BR-20261007-0003")).toMatchObject({ kind: "paused", label: "ETA paused — task blocked" });
  });
  it("reads the triggers from state.json, and gives no number when state.json is not usable", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-07T09:00:00.000Z"));
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    const withQa = standardScript(home, { pendingDeveloper: true }).map((s) =>
      s.type === "TASK_CLASSIFIED" ? { ...s, payload: { ...s.payload, qa_triggers: ["behavior"] } } : s,
    );
    writeScript(home, "BR-20261007-0001", withQa);
    writeScript(home, "BR-20261007-0002", standardScript(home, { pendingDeveloper: true }), { state: "not json" });
    writeScript(home, "BR-20261007-0003", standardScript(home, { pendingDeveloper: true }), { noState: true });
    const body = (await (await GET(new Request("http://127.0.0.1:3077/api/tasks", H), {})).json()) as TasksResponse;
    const row = (id: string) => body.tasks.find((t) => t.id === id);
    // developer [0, ceil(15/4)] + validation {qa 3–10, reviewer 3–8} + synthesis 2–6
    expect(row("BR-20261007-0001")?.summaryUnavailable).toBe(false);
    expect(row("BR-20261007-0001")?.eta).toMatchObject({ kind: "estimate", low: 5, high: 20 });
    expect(row("BR-20261007-0001")?.eta?.stages[1]?.roles).toEqual(["qa", "reviewer"]);
    for (const id of ["BR-20261007-0002", "BR-20261007-0003"]) {
      expect(row(id)?.summaryUnavailable, id).toBe(true);
      expect(row(id)?.eta, id).toMatchObject({ kind: "calculating", low: null, high: null, label: "ETA calculating…", reason: "state.json not usable; runs unknown" });
    }
  });
  it("returns parentTaskId and parentStepId for every task", async () => {
    const home = freshHome();
    mkdirs(home);
    writeScript(home, "BR-20261007-0001", highRiskScript(home, { complete: true }));
    const child = standardScript(home, { pendingDeveloper: true }).map((s, i) => (i === 0 ? { ...s, payload: { ...s.payload, parent_task: "BR-20261007-0001" } } : s));
    writeScript(home, "BR-20261007-0002", child);
    const body = (await (await GET(new Request("http://127.0.0.1:3077/api/tasks", H), {})).json()) as TasksResponse;
    expect(body.tasks.map((t) => [t.id, t.parentTaskId, t.parentStepId])).toEqual([
      ["BR-20261007-0002", "BR-20261007-0001", null],
      ["BR-20261007-0001", null, null],
    ]);
  });
  it("answers with an empty list and a missing root when the store does not exist", async () => {
    freshHome();
    const res = await GET(new Request("http://127.0.0.1:3077/api/tasks", H), {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as TasksResponse;
    expect(body.tasks).toEqual([]);
    expect(body.scan.status).toBe("missing");
  });
});
