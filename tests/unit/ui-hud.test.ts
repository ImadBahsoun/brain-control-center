import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCommandMap, type CommandMapModel } from "@/lib/ui/command-map";
import { estimateEta, type EtaInput } from "@/lib/eta";
import { currentAction, etaHud, etaText, missionHud, missionNo, PIPELINE_NOTE, pipeline, roleAction, roleActivity, roleMission } from "@/lib/ui/hud";
import { freshHome, highRiskScript, mkdirs, standardScript, writeGovernor, writeScript } from "../helpers/fixture-store";
import { apiTasks, mapInput } from "../helpers/ui-fixtures";

const ID = "BR-20261007-0001";

afterEach(() => vi.useRealTimers());

/** The HIGH-RISK script cut after `stopAfter` events (or complete), with the clock inside the stale threshold. */
async function highRisk(opts: { stopAfter?: number; complete?: boolean; now?: string } = {}): Promise<CommandMapModel> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse(opts.now ?? "2026-10-07T08:30:00.000Z"));
  const home = freshHome();
  mkdirs(home);
  writeGovernor(home);
  writeScript(home, ID, highRiskScript(home, opts.complete ? { complete: true } : { stopAfter: opts.stopAfter }));
  return buildCommandMap(await mapInput(ID));
}

async function standard(opts: Parameters<typeof standardScript>[1] = {}): Promise<CommandMapModel> {
  const home = freshHome();
  mkdirs(home);
  writeGovernor(home);
  writeScript(home, ID, standardScript(home, opts));
  return buildCommandMap(await mapInput(ID));
}

const node = (m: CommandMapModel, id: string) => {
  const r = m.roles.find((x) => x.id === id);
  if (!r) throw new Error(id);
  return r;
};

describe("missionHud", () => {
  it("numbers the mission from its id and reads round and the governor share from the detail", async () => {
    expect(missionNo("BR-20261008-0002")).toBe("#0002");
    expect(missionNo(null)).toBeNull();
    const m = await highRisk({ stopAfter: 16 });
    const hud = missionHud(m);
    expect(hud).toMatchObject({ missionNo: "#0001", missionId: ID, title: "Build the dashboard", classification: "HIGH-RISK", round: { round: 0, maxRounds: 2 } });
    // 2 (planner) + 3 (developer) consumed, 2 + 2 + 2 reserved = 11 of the HIGH-RISK budget 36
    expect(m.detail?.usage).toMatchObject({ committed: 11, classBudget: 36, percentOfClassBudget: 31 });
    expect(hud.governor).toMatchObject({ short: "31%" });
    expect(hud.governor?.detail).toContain("11 / 36 units");
    expect(hud.phase).toBe("SCAN");
  });
  it("says the governor share is not recorded per step in a replay, and is absent without a mission", async () => {
    const m = await highRisk({ stopAfter: 16 });
    expect(missionHud({ ...m, mode: "replay" }).governor).toMatchObject({ short: "—", detail: "governor usage is not recorded per step" });
    const idle = buildCommandMap(await mapInput(null));
    expect(missionHud(idle)).toMatchObject({ missionNo: null, governor: null, round: null, phase: "STANDBY" });
  });
  it("reads ERROR when /api/tasks has never answered and there is no focused mission", async () => {
    const input = await mapInput(null);
    const m = buildCommandMap({ ...input, tasks: null, tasksError: "FORBIDDEN_HOST" });
    expect(missionHud(m).phase).toBe("ERROR");
  });
});

describe("pipeline (lifecycle steps reached, not time or effort)", () => {
  it("counts RECEIVED … READY on a live HIGH-RISK mission", async () => {
    const p = pipeline((await highRisk({ stopAfter: 3 })).detail);
    expect(p.total).toBe(11);
    expect(p.segments.map((s) => s.status).slice(0, 4)).toEqual(["completed", "completed", "current", "pending"]);
    expect(p.reached).toBe(3);
    expect(p.label).toBe("PIPELINE · Planning · 3 of 11 steps reached (to READY)");
    expect(p.valueText).toContain(PIPELINE_NOTE);
    expect(p.exit).toBeNull();
  });
  it("keeps skipped steps of a STANDARD mission as skipped segments", async () => {
    const p = pipeline((await standard({ pendingDeveloper: true })).detail);
    expect(p.segments.filter((s) => s.status === "skipped").map((s) => s.state)).toEqual(["PLANNING", "WAITING_FOR_APPROVAL"]);
    expect(p.reached).toBe(5); // IMPLEMENTING is the 5th segment
  });
  it("adds the post-READY steps a completed mission reached, ending at COMPLETE", async () => {
    const p = pipeline((await highRisk({ complete: true })).detail);
    expect(p.segments.slice(10).map((s) => s.state)).toEqual(["READY", "HUMAN_APPROVAL", "COMPLETE"]);
    expect(p.reached).toBe(p.total);
    expect(p.label).toBe(`PIPELINE · Complete · ${p.total} of ${p.total} steps reached`);
  });
  it("caps a BLOCKED mission with its exit and the step it left from", async () => {
    const p = pipeline((await standard({ blocked: true })).detail);
    expect(p.exit).toBe("BLOCKED at Implementing");
    expect(p.valueText).toContain("BLOCKED at Implementing");
  });
  it("is all pending without a mission", () => {
    const p = pipeline(null);
    expect(p.reached).toBe(0);
    expect(p.segments.every((s) => s.status === "pending")).toBe(true);
    expect(p.label).toBe("PIPELINE · no mission · 0 of 11 steps reached (to READY)");
  });
});

describe("currentAction (priority order, reservations never read as liveness)", () => {
  it("names a pending run as reserved, awaiting report", async () => {
    const a = currentAction(await highRisk({ stopAfter: 3 }));
    expect(a).toMatchObject({ role: "planner", roles: ["planner"], text: "Planner planning · reserved, awaiting report", tone: "signal" });
  });
  it("joins several pending runs, one clause per role", async () => {
    const a = currentAction(await highRisk({ stopAfter: 16 }));
    expect(a.roles).toEqual(["qa", "reviewer", "security-reviewer"]);
    expect(a.text).toBe("QA testing · reserved, awaiting report · Reviewer reviewing · reserved, awaiting report · Security Reviewer security review · reserved, awaiting report");
  });
  it("names a fix run's round and a revalidation as a re-review", async () => {
    expect(currentAction(await highRisk({ stopAfter: 25 })).text).toBe("Developer fixing (round 1) · reserved, awaiting report");
    expect(currentAction(await highRisk({ stopAfter: 31 })).text).toBe("Reviewer re-reviewing · reserved, awaiting report");
  });
  it("marks a reservation over the stale threshold as having no report", async () => {
    const a = currentAction(await highRisk({ stopAfter: 3, now: "2026-10-07T14:00:00.000Z" }));
    expect(a).toMatchObject({ text: "Planner planning · reserved, no report (over stale threshold)", tone: "warn" });
  });
  it("puts the Commander Gate first, then the Brain's own steps, READY and completion", async () => {
    expect(currentAction(await highRisk({ stopAfter: 6 }))).toMatchObject({ text: "Commander approval required · plan gate", tone: "warn", role: null });
    expect(currentAction(await highRisk({ stopAfter: 40 })).text).toBe("Commander approval required · human gate");
    expect(currentAction(await highRisk({ stopAfter: 22 })).text).toBe("Brain synthesizing reports");
    expect(currentAction(await highRisk({ stopAfter: 37 }))).toMatchObject({ text: "READY · validated", tone: "ok" });
    expect(currentAction(await highRisk({ complete: true }))).toMatchObject({ text: "Mission complete · shipped", tone: "ok" });
  });
  it("reads BLOCKED with its step and reason, a cancellation, standby and loading", async () => {
    expect(currentAction(await standard({ blocked: true }))).toMatchObject({ text: "Blocked at Implementing · needs credentials", tone: "danger" });
    expect(currentAction(await standard({ cancelled: true })).text).toBe("Mission cancelled · user stopped");
    const input = await mapInput(null);
    expect(currentAction(buildCommandMap(input))).toMatchObject({ text: "Standby · no active mission", tone: "dim" });
    expect(currentAction(buildCommandMap({ ...input, focusId: ID })).text).toBe(`Loading mission ${ID}`);
    expect(currentAction(buildCommandMap({ ...input, focusId: ID, loadError: "timeout" }))).toMatchObject({ text: "ERROR · timeout", tone: "danger" });
    expect(currentAction(buildCommandMap({ ...input, tasks: null, tasksError: "FORBIDDEN_HOST" }))).toMatchObject({ tone: "danger" });
  });
  it("falls back to the recorded next action when nothing is pending", async () => {
    // developer reported, no validation yet: IMPLEMENTING with no pending run
    const m = await standard();
    expect(currentAction(m).text).toBe("next: launch developer");
  });
});

describe("role activity, action and mission (node line B-1)", () => {
  it("derives the node's activity line from the same runs as the panel's action", async () => {
    const m3 = await highRisk({ stopAfter: 3 });
    // a pending run reads "reserved" on the node; the verb is in the action next to "reserved, awaiting report"
    expect(roleActivity(node(m3, "planner"))).toBe("reserved");
    expect(roleAction(node(m3, "planner"), m3.detail).text).toBe("Planning · reserved, awaiting report");
    expect(roleActivity(node(m3, "developer"))).toBe("not dispatched");
    expect(roleMission(node(m3, "planner"), m3)).toBe("#0001");
    expect(roleMission(node(m3, "developer"), m3)).toBeNull(); // no run of the developer on this mission
    const m25 = await highRisk({ stopAfter: 25 });
    expect(roleActivity(node(m25, "developer"))).toBe("reserved · r1");
    expect(roleAction(node(m25, "developer"), m25.detail).text).toBe("Fixing (round 1) · reserved, awaiting report");
    expect(roleActivity(node(m25, "qa"))).toBe("r0"); // drawn after the verdict: "PASS WITH CONCERNS · r0"
    expect(node(m25, "qa").stateWord).toBe("PASS WITH CONCERNS");
    expect(roleAction(node(m25, "qa"), m25.detail).text).toBe("No run in progress · last report: pass with concerns");
    const m31 = await highRisk({ stopAfter: 31 });
    expect(roleActivity(node(m31, "reviewer"))).toBe("reserved · r1");
    expect(roleAction(node(m31, "reviewer"), m31.detail).text).toBe("Re-reviewing · reserved, awaiting report");
    expect(roleAction(node(m31, "reviewer"), m31.detail, { replay: true }).text).toBe("Re-reviewing · was reserved, no report yet at this step");
  });
  it("reads idle (with the last mission from /api/agents), not on path, and every activity stays short", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    writeScript(home, ID, highRiskScript(home, { complete: true }));
    const idle = buildCommandMap(await mapInput(null));
    expect(roleActivity(node(idle, "developer"))).toBe("last #0001"); // drawn after IDLE
    expect(node(idle, "developer").stateWord).toBe("IDLE");
    expect(roleAction(node(idle, "developer"), null).text).toBe(`Idle · last run on ${ID}: done`);
    const s = await standard({ pendingDeveloper: true });
    expect(roleActivity(node(s, "planner"))).toBe("not on path");
    for (const m of [idle, s, await highRisk({ stopAfter: 16 }), await highRisk({ stopAfter: 31 })]) for (const r of m.roles) expect(roleActivity(r).length, `${r.id}: ${roleActivity(r)}`).toBeLessThanOrEqual(18);
  });
  it("reads a not-launched run as not launched", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    const specs = standardScript(home, { cancelled: true });
    specs.splice(4, 0, { type: "AGENT_STARTED", payload: { agent: "reviewer", kind: "initial" } }, { type: "AGENT_COMPLETED", payload: { agent: "reviewer", status_or_verdict: "not-launched" }, correlation_id: "SEQ5" });
    writeScript(home, ID, specs);
    const m = buildCommandMap(await mapInput(ID));
    expect(roleActivity(node(m, "reviewer"))).toBe("not launched");
    expect(roleAction(node(m, "reviewer"), m.detail).text).toBe("Not launched · units refunded");
  });
});

describe("etaHud (the HUD's dim elapsed and ETA line)", () => {
  it("shows the elapsed time and the ETA label dim, with the estimate note, and nothing in a replay", async () => {
    const m = await highRisk({ stopAfter: 16 }); // three validators reserved at 08:00:13–15, the clock at 08:30
    const eta = (await apiTasks()).tasks.find((t) => t.id === ID)?.eta ?? null;
    const line = etaHud(eta, m.mode, m.detail?.status ?? null);
    // each validator is past its band (a quarter kept: qa 3, reviewers 2) and runs in parallel, plus synthesis 2–6
    expect(line).toMatchObject({ text: "Elapsed 30m · ETA ~2–9 min", tone: "dim" });
    expect(line?.title).toContain("estimate, not a guarantee");
    expect(etaHud(eta, "replay", "ACTIVE")).toBeNull();
    expect(etaHud(null, m.mode, "ACTIVE")).toBeNull();
  });
  it("shows a COMPLETE or CANCELLED mission's recorded total instead of Elapsed, and READY as ETA complete", () => {
    const base: EtaInput = {
      status: "COMPLETE", state: "COMPLETE", classification: "STANDARD", round: 0, roundEpoch: 0,
      createdAt: "2026-10-07T08:00:00.000Z", lastEventAt: "2026-10-07T08:31:00.000Z", qaTriggers: false, securityTriggers: false,
      runsKnown: true, runs: [], events: [], concurrencyDeniedSeq: 0, history: {}, nowMs: Date.parse("2026-10-07T09:00:00.000Z"),
    };
    const complete = estimateEta(base);
    expect(etaHud(complete, "debrief", "COMPLETE")).toMatchObject({ text: "COMPLETE · 31m total", tone: "dim" });
    expect(etaText(complete, "COMPLETE")).toBe("COMPLETE · 31m total");
    const cancelled = estimateEta({ ...base, status: "CANCELLED", state: "CANCELLED", lastEventAt: "2026-10-07T08:05:00.000Z" });
    expect(etaHud(cancelled, "debrief", "CANCELLED")).toMatchObject({ text: "CANCELLED · 5m total", tone: "dim" });
    expect(etaText(cancelled, "CANCELLED")).toBe("CANCELLED · 5m total");
    const ready = estimateEta({ ...base, status: "ACTIVE", state: "READY", nowMs: Date.parse("2026-10-07T08:12:00.000Z") });
    expect(etaHud(ready, "live", "ACTIVE")).toMatchObject({ text: "Elapsed 12m · ETA complete", tone: "dim" });
    expect(etaText(ready, "ACTIVE")).toBe("ETA complete");
  });
});
