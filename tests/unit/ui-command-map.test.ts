import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventSpec } from "../helpers/fixture-store";
import { buildCommandMap, EFFORT_LABEL, roleState, type CommandMapModel, type EdgeState } from "@/lib/ui/command-map";
import type { EdgeId } from "@/lib/ui/layout";
import { appendBytes, freshHome, highRiskScript, mkdirs, standardScript, writeGovernor, writeScript } from "../helpers/fixture-store";
import { mapInput } from "../helpers/ui-fixtures";

const ID = "BR-20261007-0001";

afterEach(() => vi.useRealTimers());

async function highRisk(stopAfter?: number, complete = false): Promise<CommandMapModel> {
  const home = freshHome();
  mkdirs(home);
  writeGovernor(home);
  writeScript(home, ID, highRiskScript(home, complete ? { complete } : { stopAfter }));
  return buildCommandMap(await mapInput(ID));
}

function edges(m: CommandMapModel): Record<string, EdgeState> {
  return Object.fromEntries(m.edges.map((e) => [e.id, e.state]));
}
function edge(m: CommandMapModel, id: EdgeId) {
  const e = m.edges.find((x) => x.id === id);
  if (!e) throw new Error(`edge ${id} not drawn`);
  return e;
}
function role(m: CommandMapModel, id: string) {
  const r = m.roles.find((x) => x.id === id);
  if (!r) throw new Error(`role ${id} missing`);
  return r;
}
function assertSources(m: CommandMapModel) {
  for (const n of [m.core, m.synthesis, m.ready, m.gate, ...m.roles]) expect(n.source.length, n.id).toBeGreaterThan(0);
  for (const e of m.edges) expect(e.source.length, e.id).toBeGreaterThan(0);
  for (const t of m.threats) expect(t.source.length, t.id).toBeGreaterThan(0);
  for (const r of m.resources.meters) expect(r.source.length, r.id).toBeGreaterThan(0);
}

describe("buildCommandMap over the HIGH-RISK script", () => {
  it("stopAfter 3: the planner is reserved, the mission brief flows, everything else waits", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-07T08:30:00.000Z"));
    const m = await highRisk(3);
    expect(m.mode).toBe("live");
    expect(m.missionId).toBe(ID);
    expect(role(m, "planner")).toMatchObject({ state: "running", stale: false, statusText: "ACTIVE · reserved, awaiting report", model: "opus", policyUnits: 2, reservedUnits: 2, consumedUnits: 0, round: 0, maxRounds: 2, runKind: "initial" });
    expect(edges(m)).toEqual({ E1: "running", E2: "pending", E3: "pending", E4: "pending", E5: "pending", E6: "pending", E7: "pending", E8: "pending", E9: "pending", E10: "pending", E11: "pending" });
    expect(m.edges.find((e) => e.id === "E12")).toBeUndefined();
    expect(m.core).toMatchObject({ live: true, statusText: "LIVE · Planning", unknownRoles: [] });
    expect(m.synthesis.state).toBe("pending");
    expect(m.gate.state).toBe("pending");
    expect(m.threats).toEqual([]);
    expect(m.banner).toBeNull();
    assertSources(m);
  });
  it("stopAfter 3 with the clock far ahead: the reservation is over the stale threshold, static amber", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-07T14:00:00.000Z")); // 6 h after the 08:00Z start, threshold 240 min
    const m = await highRisk(3);
    expect(role(m, "planner")).toMatchObject({ state: "running", stale: true, statusText: "RESERVED · no report, over stale threshold" });
    expect(edge(m, "E1")).toMatchObject({ state: "running", stale: true });
  });
  it("stopAfter 6: the plan gate pulses on planner → developer and the planner completed PLAN_READY", async () => {
    const m = await highRisk(6);
    expect(role(m, "planner")).toMatchObject({ state: "completed", verdict: "PLAN_READY", verdictTone: "pass", statusText: "COMPLETED · PLAN_READY" });
    expect(edges(m)).toMatchObject({ E1: "completed", E2: "waiting-approval", E3: "pending" });
    expect(edge(m, "E2").detail).toContain("commander approval required");
    expect(edge(m, "E2").lock).toBe(true);
    expect(m.gate.gate.active).toBe("plan");
    expect(m.gate.gate.request?.detail).toBe("approve the plan");
    // the Gate node follows gate.active: a waiting plan gate reads ACTION REQUIRED there too
    expect(m.gate).toMatchObject({ state: "waiting-approval", stateWord: "ACTION REQUIRED", statusText: "ACTION REQUIRED · plan gate (planner → developer)" });
    expect(m.gateCallout).toMatchObject({ kind: "plan", requestText: "Approval requested (plan)", requestDetail: "approve the plan", requestOutsideWindow: false });
    expect(m.detail?.status).toBe("WAITING");
  });
  it("stopAfter 10: the developer is reserved, the plan edge is completed and approved", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-07T08:30:00.000Z"));
    const m = await highRisk(10);
    expect(edges(m)).toMatchObject({ E1: "completed", E2: "completed", E3: "running", E4: "pending", E7: "pending" });
    expect(edge(m, "E2").detail).toContain("plan approved");
    expect(m.gateCallout).toBeNull(); // the callout exists only while a gate is active
    expect(role(m, "developer")).toMatchObject({ state: "running", model: "fable", policyUnits: 3, reservedUnits: 3, consumedUnits: 0 });
    expect(m.core.statusText).toBe("LIVE · Implementing");
  });
  it("stopAfter 16: the three validators are dispatched and their reports are in flight", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-07T08:30:00.000Z"));
    const m = await highRisk(16);
    expect(edges(m)).toMatchObject({ E3: "completed", E4: "running", E5: "running", E6: "running", E7: "running", E8: "running", E9: "running", E10: "pending", E11: "pending" });
    expect(role(m, "developer")).toMatchObject({ state: "completed", verdict: "done", verdictTone: "pass", consumedUnits: 3 });
    for (const r of ["qa", "reviewer", "security-reviewer"]) expect(role(m, r).state, r).toBe("running");
    expect(m.resources.meters.find((x) => x.id === "agents")).toMatchObject({ value: 3, max: 3 });
    expect(m.synthesis.state).toBe("pending");
  });
  it("stopAfter 22: synthesizing with two findings; verdict tones are shown, reports are completed", async () => {
    const m = await highRisk(22);
    expect(m.detail?.lifecycle.current).toBe("SYNTHESIZING");
    expect(role(m, "qa")).toMatchObject({ state: "completed", verdict: "pass with concerns", verdictTone: "concern" });
    expect(role(m, "reviewer")).toMatchObject({ state: "completed", verdict: "changes required", verdictTone: "concern", openFindings: 1 });
    expect(role(m, "security-reviewer")).toMatchObject({ state: "completed", verdict: "approve", verdictTone: "pass", openFindings: 0 });
    expect(edges(m)).toMatchObject({ E4: "completed", E5: "completed", E6: "completed", E7: "completed", E8: "completed", E9: "completed", E10: "pending" });
    expect(edge(m, "E8").detail).toBe("report synthesized · changes required");
    expect(m.synthesis).toMatchObject({ state: "running", statusText: "CURRENT · Synthesizing" });
    expect(m.threats.map((t) => [t.id, t.severity, t.anchor, t.threatClass])).toEqual([
      ["F-001", "MAJOR", "reviewer", "active"],
      ["F-002", "MINOR", "qa", "active"],
    ]);
    expect(m.lanes.map((l) => [l.anchor, l.shown.map((t) => t.id), l.overflow])).toEqual([
      ["qa", ["F-002"], 0],
      ["reviewer", ["F-001"], 0],
    ]);
    expect(m.threatOverflow).toBe(0);
    expect(m.findings).toHaveLength(2);
    expect(m.findingsLoaded).toBe(true);
    expect(m.edges.find((e) => e.id === "E12")).toBeUndefined();
    assertSources(m);
  });
  it("stopAfter 25: the fix loop is drawn and running while the developer fixes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-07T08:30:00.000Z"));
    const m = await highRisk(25);
    expect(m.detail?.lifecycle.current).toBe("FIXING");
    expect(edges(m)).toMatchObject({ E3: "running", E12: "running", E7: "completed" });
    expect(edge(m, "E12").detail).toBe("fix round in progress");
    expect(role(m, "developer")).toMatchObject({ state: "running", round: 1, runKind: "fix", consumedUnits: 3, reservedUnits: 3 });
    expect(m.synthesis.state).toBe("completed");
  });
  it("stopAfter 31: revalidating keeps the fix loop running and the reviewer re-dispatched", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-07T08:30:00.000Z"));
    const m = await highRisk(31);
    expect(m.detail?.lifecycle.current).toBe("REVALIDATING");
    expect(edges(m)).toMatchObject({ E12: "running", E5: "running", E8: "running", E4: "completed", E7: "completed" });
    expect(edge(m, "E12").detail).toBe("fix delivered · revalidating");
    expect(role(m, "reviewer")).toMatchObject({ state: "running", runKind: "revalidation", round: 1 });
  });
  it("stopAfter 37: READY reached; the READY node completes and the gate stays sealed", async () => {
    const m = await highRisk(37);
    expect(m.detail?.ready).toBe(true);
    expect(edges(m)).toMatchObject({ E10: "completed", E11: "pending", E12: "completed" });
    expect(edge(m, "E12").detail).toBe("1 fix round(s) closed");
    expect(m.ready).toMatchObject({ state: "completed", statusText: "READY · mission validated" });
    expect(m.gate).toMatchObject({ state: "pending", statusText: "SEALED · human approval" });
    expect(m.edges.filter((e) => e.state === "running")).toEqual([]);
    expect(role(m, "reviewer")).toMatchObject({ state: "completed", verdict: "approve", verdictTone: "pass" });
    expect(m.threats.map((t) => [t.id, t.threatClass])).toEqual([
      ["F-001", "resolved"],
      ["F-002", "dismissed"],
    ]);
  });
  it("stopAfter 40: the Commander Gate requires action on READY → gate", async () => {
    const m = await highRisk(40);
    expect(edges(m)).toMatchObject({ E10: "completed", E11: "waiting-approval" });
    expect(m.gate).toMatchObject({ state: "waiting-approval", stateWord: "ACTION REQUIRED", statusText: "ACTION REQUIRED · human approval" });
    expect(m.gate.gate.active).toBe("human");
    expect(m.gateCallout).toMatchObject({ kind: "human", requestText: null, requestOutsideWindow: false }); // the only request line was granted at seq 7
    expect(m.detail?.status).toBe("WAITING");
    expect(m.mode).toBe("live");
  });
  it("complete: debrief mode, every edge completed or skipped, nothing running", async () => {
    const m = await highRisk(undefined, true);
    expect(m.mode).toBe("debrief");
    expect(m.core).toMatchObject({ live: false, statusText: "MISSION COMPLETE" });
    for (const e of m.edges) expect(["completed", "skipped"], e.id).toContain(e.state);
    expect(edges(m)).toMatchObject({ E11: "completed", E12: "completed" });
    expect(m.gate).toMatchObject({ state: "completed", stateWord: "PASSED" });
    expect(m.gateCallout).toBeNull();
    expect(m.ready.state).toBe("completed");
    expect(m.synthesis.state).toBe("completed");
    expect(m.integrityChip).toBeNull();
  });
});

describe("buildCommandMap over the STANDARD scripts and broken stores", () => {
  it("pendingDeveloper: the planner is skipped (no planning step) and the developer runs", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-07T08:30:00.000Z"));
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    writeScript(home, ID, standardScript(home, { pendingDeveloper: true }));
    const m = buildCommandMap(await mapInput(ID));
    expect(role(m, "planner")).toMatchObject({ state: "skipped", statusText: "SKIPPED · no run recorded" });
    expect(edges(m)).toMatchObject({ E1: "skipped", E2: "skipped", E3: "running", E4: "pending" });
    expect(edge(m, "E2").detail).toBe("no planning step on this mission");
    expect(edge(m, "E2").lock).toBe(false); // no plan gate ever existed: no lock glyph
    expect(m.gate.gate.plan.state).toBe("not-required");
  });
  it("a COMPLEX mission whose planner reported before the developer was reserved reads 'plan ready'", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    writeScript(home, ID, [
      { type: "TASK_CREATED", payload: { summary: "x", class: "COMPLEX", repo: home }, state: "CLASSIFYING", round: 0 },
      { type: "TASK_CLASSIFIED", payload: { class: "COMPLEX", reason: "r" }, state: "PLANNING" },
      { type: "AGENT_STARTED", payload: { agent: "planner", kind: "initial" } },
      { type: "AGENT_COMPLETED", payload: { agent: "planner", status_or_verdict: "PLAN_READY" }, correlation_id: "SEQ3" },
      { type: "PLAN_CREATED", payload: { text: "p", author: "planner" } },
      { type: "STATE_CHANGED", payload: {}, state: "IMPLEMENTING" },
    ]);
    const m = buildCommandMap(await mapInput(ID));
    expect(role(m, "planner").state).toBe("completed");
    expect(edge(m, "E2")).toMatchObject({ state: "pending", detail: "plan ready · developer not yet dispatched", lock: false });
    expect(edge(m, "E3").state).toBe("pending");
  });
  it("blocked: the edge of the last reached step turns red and the core shows the reason", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    writeScript(home, ID, standardScript(home, { blocked: true }));
    const m = buildCommandMap(await mapInput(ID));
    expect(m.mode).toBe("live");
    expect(edges(m)).toMatchObject({ E3: "blocked", E4: "pending", E1: "skipped" });
    expect(edge(m, "E3").detail).toBe("blocked at Implementing · needs credentials");
    expect(m.core).toMatchObject({ statusText: "BLOCKED · needs credentials", blockedReason: "needs credentials", blockedNeeds: ["DB access"] });
    expect(m.banner).toBe("MISSION BLOCKED");
  });
  it("blocked from VALIDATING marks the dispatch edges of the dispatched validators only (TESTING and REVIEWING are both lit)", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    const specs = standardScript(home);
    specs.push({ type: "VALIDATION_STARTED", payload: { agents: ["qa", "reviewer"] }, state: "VALIDATING" });
    specs.push({ type: "BLOCKED", payload: { reason: "r", needs: [] }, state: "BLOCKED" });
    writeScript(home, ID, specs);
    const m = buildCommandMap(await mapInput(ID));
    // the security reviewer has no run and was not dispatched (validation.inProgress.agents = qa, reviewer)
    expect(edges(m)).toMatchObject({ E3: "completed", E4: "blocked", E5: "blocked", E6: "pending", E7: "pending" });
    expect(edge(m, "E4").detail).toBe("blocked at Validating · r");
  });
  it("a round cap after the second synthesis blocks the report edges, not the dispatch edges", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    const specs = highRiskScript(home, { stopAfter: 33 }); // REVALIDATED, state SYNTHESIZING
    specs.push({ type: "STATE_CHANGED", payload: { note: "cap" }, state: "ROUND_CAP_REACHED" });
    writeScript(home, ID, specs);
    const m = buildCommandMap(await mapInput(ID));
    expect(m.detail?.status).toBe("BLOCKED");
    expect(edges(m)).toMatchObject({ E4: "completed", E5: "completed", E6: "completed", E7: "blocked", E8: "blocked", E9: "blocked", E12: "completed" });
    expect(edge(m, "E7").detail).toBe("blocked at Synthesizing");
  });
  it("blocked inside a second fix round marks the fix loop", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    const specs = highRiskScript(home, { stopAfter: 33 });
    specs.push({ type: "FIX_ROUND_STARTED", payload: { round: 2, kind: "developer", findings: ["F-001"] }, state: "FIXING", round: 2 });
    specs.push({ type: "BLOCKED", payload: { reason: "needs input", needs: [] }, state: "BLOCKED" });
    writeScript(home, ID, specs);
    const m = buildCommandMap(await mapInput(ID));
    expect(edges(m)).toMatchObject({ E12: "blocked", E4: "completed", E5: "completed", E6: "completed", E7: "completed" });
    expect(edge(m, "E12").detail).toBe("blocked at Fixing · needs input");
  });
  it("cancelled: pending edges become skipped under a MISSION CANCELLED banner, in debrief mode", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    writeScript(home, ID, standardScript(home, { cancelled: true }));
    const m = buildCommandMap(await mapInput(ID));
    expect(m.mode).toBe("debrief");
    expect(m.banner).toBe("MISSION CANCELLED");
    expect(m.edges.some((e) => e.state === "pending")).toBe(false);
    expect(edges(m)).toMatchObject({ E3: "completed", E4: "skipped", E10: "skipped", E11: "skipped" });
    expect(role(m, "qa")).toMatchObject({ state: "skipped" });
    expect(m.ready.state).toBe("skipped");
    expect(m.gate).toMatchObject({ state: "skipped", statusText: "NOT REQUIRED · human approval" });
  });
  it("an unusable state.json makes role-derived edges unknown and raises the integrity chip", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    writeScript(home, ID, standardScript(home), { state: "not json" });
    const m = buildCommandMap(await mapInput(ID));
    expect(m.detail?.summaryUnavailable).toBe(true);
    for (const id of ["E1", "E3", "E4", "E5", "E6", "E7", "E8", "E9"] as const) expect(edge(m, id).state, id).toBe("unknown");
    expect(role(m, "developer").statusText).toBe("UNKNOWN · state.json not usable (cache invalid)");
    expect(m.integrityChip).toBe("log ok · cache invalid");
  });
  it("a corrupt log with a usable cache names the log as the reason, not the cache", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    const w = writeScript(home, ID, standardScript(home));
    appendBytes(w.eventsPath, "{not json}\n");
    const m = buildCommandMap(await mapInput(ID));
    expect(m.detail).toMatchObject({ status: "CORRUPT", summaryUnavailable: false });
    expect(m.detail?.integrity).toMatchObject({ log: "corrupt", corruptLine: 5 });
    expect(role(m, "developer").statusText).toMatch(/^UNKNOWN · log corrupt at line 5 \(/);
    expect(m.core.statusText).toMatch(/^CORRUPT · log corrupt at line 5/);
    expect(m.mode).toBe("debrief");
  });
  it("loading: a focus whose detail has not arrived is a loading map, never an idle one", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    writeScript(home, ID, highRiskScript(home, { stopAfter: 16 }));
    const input = await mapInput(null);
    const m = buildCommandMap({ ...input, focusId: ID });
    expect(m.mode).toBe("loading");
    expect(m.missionId).toBe(ID);
    expect(m.core.statusText).toBe(`LOADING · mission ${ID}`);
    expect(m.gate.stateWord).toBe("LOADING");
    expect(m.edges.every((e) => e.dormant && e.state === "pending")).toBe(true);
    expect(buildCommandMap({ ...input, focusId: ID, loadError: "timeout" }).core.statusText).toBe("ERROR · timeout");
    expect(buildCommandMap(input).mode).toBe("idle");
  });
  it("a never-answered /api/tasks with no focused mission is an error, not an idle standby", async () => {
    const input = await mapInput(null);
    const m = buildCommandMap({ ...input, tasks: null, tasksError: "FORBIDDEN_HOST" });
    expect(m.mode).toBe("loading");
    expect(m.missionId).toBeNull();
    expect(m.core.statusText).toBe("ERROR · FORBIDDEN_HOST · mission list unavailable");
    const texts = [m.core.statusText, m.core.source, ...m.edges.map((e) => `${e.stateText} ${e.source}`), ...m.roles.map((r) => r.statusText)];
    for (const t of texts) {
      expect(t).not.toContain("null");
      expect(t).not.toContain("STANDBY");
    }
  });
  it("a tasks poll error alongside already-loaded tasks data stays idle, not an error", async () => {
    const input = await mapInput(null);
    const m = buildCommandMap({ ...input, tasksError: "timeout" });
    expect(m.mode).toBe("idle");
  });
  it("tasks === null with no tasksError stays idle", async () => {
    const input = await mapInput(null);
    const m = buildCommandMap({ ...input, tasks: null });
    expect(m.mode).toBe("idle");
  });
  it("threat lanes hold at most three markers per anchor; a fuller anchor shows two plus a '+n' chip", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    const specs = standardScript(home);
    const sev = ["MAJOR", "MINOR", "NIT", "MAJOR", "MINOR", "BLOCKER", "MINOR", "NIT"];
    const sources = ["reviewer", "reviewer", "reviewer", "reviewer", "reviewer", "qa", "qa", "qa"];
    sev.forEach((severity, i) => specs.push({ type: "FINDING_CREATED", payload: { alias: `X${i + 1}`, severity, source: sources[i], title: `Finding ${i + 1}` }, state: "SYNTHESIZING" }));
    writeScript(home, ID, specs);
    const m = buildCommandMap(await mapInput(ID));
    expect(m.threats).toHaveLength(8);
    const byAnchor = Object.fromEntries(m.lanes.map((l) => [l.anchor, l]));
    expect(byAnchor.reviewer?.shown.map((t) => t.severity)).toEqual(["MAJOR", "MAJOR"]); // 5 anchored: 2 drawn + "+3"
    expect(byAnchor.reviewer?.overflow).toBe(3);
    expect(byAnchor.qa?.shown).toHaveLength(3); // exactly 3: all drawn
    expect(byAnchor.qa?.overflow).toBe(0);
    expect(m.threatOverflow).toBe(3);
    expect(role(m, "reviewer").openFindings).toBe(5);
  });
  it("a not-launched run shows the role as skipped with the refund note", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    const specs = standardScript(home, { cancelled: true });
    specs.splice(4, 0, { type: "AGENT_STARTED", payload: { agent: "reviewer", kind: "initial" } }, { type: "AGENT_COMPLETED", payload: { agent: "reviewer", status_or_verdict: "not-launched" }, correlation_id: "SEQ5" });
    writeScript(home, ID, specs);
    const m = buildCommandMap(await mapInput(ID));
    expect(role(m, "reviewer")).toMatchObject({ state: "skipped", statusText: "NOT LAUNCHED · units refunded", consumedUnits: 0 });
    expect(edges(m)).toMatchObject({ E5: "skipped", E8: "skipped" });
  });
  it("a lost run and a failed verdict both render as failed with their recorded text", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    const specs: EventSpec[] = standardScript(home, { pendingDeveloper: true });
    specs.push({ type: "AGENT_COMPLETED", payload: { agent: "developer", status_or_verdict: "lost" }, correlation_id: "SEQ3" });
    specs.push({ type: "VALIDATION_STARTED", payload: { agents: ["qa"] }, state: "VALIDATING" });
    specs.push({ type: "AGENT_STARTED", payload: { agent: "qa", kind: "initial" } });
    specs.push({ type: "AGENT_COMPLETED", payload: { agent: "qa", status_or_verdict: "failed" }, correlation_id: "SEQ6" });
    writeScript(home, ID, specs);
    const m = buildCommandMap(await mapInput(ID));
    expect(role(m, "developer")).toMatchObject({ state: "failed", statusText: "FAILED · lost (units consumed)" });
    expect(role(m, "qa")).toMatchObject({ state: "failed", verdict: "failed", verdictTone: "fail", statusText: "FAILED · failed" });
    expect(edges(m)).toMatchObject({ E3: "failed", E4: "failed", E7: "failed" });
  });
});

describe("no fake data", () => {
  it("effort is never recorded; without a policy the model is unknown and there are no meters", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-07T08:30:00.000Z"));
    expect(EFFORT_LABEL).toBe("not recorded");
    const home = freshHome();
    mkdirs(home);
    writeScript(home, ID, highRiskScript(home, { stopAfter: 16 })); // no governor.json
    const m = buildCommandMap(await mapInput(ID));
    expect(m.detail?.agents.every((a) => a.effort === null)).toBe(true);
    expect(m.resources.policyStatus).toBe("missing");
    expect(m.resources.meters).toEqual([]);
    for (const r of m.roles) {
      expect(r.model).toBeNull();
      expect(r.policyUnits).toBeNull();
      expect(r.unitsPerRun).toBeNull();
      // no run carries a unit value, so no zero is invented
      expect(r.reservedUnits).toBeNull();
      expect(r.consumedUnits).toBeNull();
    }
    expect(role(m, "qa").state).toBe("running"); // the state does not depend on the policy
  });
  it("an unknown role in the runs is ignored on the map and listed on the core", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-07T08:30:00.000Z"));
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    const specs = standardScript(home, { pendingDeveloper: true });
    specs.push({ type: "AGENT_STARTED", payload: { agent: "intern", kind: "initial" } });
    writeScript(home, ID, specs);
    const m = buildCommandMap(await mapInput(ID));
    expect(m.roles.map((r) => r.id)).toEqual(["planner", "developer", "qa", "reviewer", "security-reviewer"]);
    expect(m.core.unknownRoles).toEqual(["intern"]);
    expect(m.detail?.agents.some((a) => a.role === "intern")).toBe(true);
  });
  it("idle: no mission, no running edge, every pip at zero, roles idle with their latest run from /api/agents", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    writeScript(home, "BR-20261007-0001", highRiskScript(home, { complete: true }));
    writeScript(home, "BR-20261007-0002", standardScript(home, { cancelled: true }));
    const input = await mapInput(null);
    expect(input.tasks?.counts.active).toBe(0);
    const m = buildCommandMap(input);
    expect(m.mode).toBe("idle");
    expect(m.missionId).toBeNull();
    expect(m.gate.stateWord).toBe("IDLE"); // never UNKNOWN on the idle map
    expect(m.edges.every((e) => e.state === "pending" && e.dormant && !e.lock)).toBe(true);
    expect(m.edges.find((e) => e.id === "E12")).toBeUndefined();
    for (const r of m.roles) {
      expect(r.state).toBe("pending");
      expect(r.statusText).toBe("IDLE · no reservation");
      expect(r.runs).toEqual([]);
      expect(r.model).toBeTruthy(); // the policy model class is real data
    }
    // /api/agents recent is newest completion first: both fixtures share a time base, so the HIGH-RISK fix run wins
    expect(role(m, "developer").recent).toMatchObject({ taskId: "BR-20261007-0001", verdict: "done", kind: "fix" });
    expect(role(m, "planner").recent).toMatchObject({ taskId: "BR-20261007-0001", verdict: "PLAN_READY" });
    expect(role(m, "qa").recent).toMatchObject({ taskId: "BR-20261007-0001", verdict: "pass with concerns" });
    for (const meter of m.resources.meters) expect(meter.value, meter.id).toBe(0);
    expect(m.resources.meters.find((x) => x.id === "budget")).toBeUndefined();
    expect(m.threats).toEqual([]);
    expect(m.core.statusText).toBe("STANDBY · no active mission");
    assertSources(m);
  });
  it("zero findings means zero threats; the model never adds a finding", async () => {
    const m = await highRisk(16);
    expect(m.findings).toEqual([]);
    expect(m.threats).toEqual([]);
    for (const r of m.roles) expect(r.openFindings).toBe(0);
  });
  it("roleState picks the latest run by startedAt, so a rerun supersedes an earlier failure", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    const specs: EventSpec[] = standardScript(home);
    specs.push({ type: "VALIDATION_STARTED", payload: { agents: ["qa"] }, state: "VALIDATING" });
    specs.push({ type: "AGENT_STARTED", payload: { agent: "qa", kind: "initial" } });
    specs.push({ type: "AGENT_COMPLETED", payload: { agent: "qa", status_or_verdict: "failed" }, correlation_id: "SEQ6" });
    specs.push({ type: "AGENT_STARTED", payload: { agent: "qa", kind: "initial", rerun_reason: "retry" } });
    specs.push({ type: "AGENT_COMPLETED", payload: { agent: "qa", status_or_verdict: "pass with concerns" }, correlation_id: "SEQ8" });
    writeScript(home, ID, specs);
    const input = await mapInput(ID);
    const rs = roleState(input.detail!, "qa");
    expect(rs).toMatchObject({ state: "completed", verdict: "pass with concerns", tone: "concern" });
    expect(rs.runs).toHaveLength(2);
    expect(rs.latest?.rerun).toBe(true);
  });
});

describe("follow-up rules (RTS evolution)", () => {
  it("role nodes carry a state word: IDLE on the idle map, LOADING while loading, the state word with a mission", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-07T08:30:00.000Z"));
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    writeScript(home, ID, highRiskScript(home, { stopAfter: 16 }));
    const idle = await mapInput(null);
    expect(buildCommandMap(idle).roles.map((r) => r.stateWord)).toEqual(["IDLE", "IDLE", "IDLE", "IDLE", "IDLE"]);
    expect(buildCommandMap({ ...idle, focusId: ID }).roles.every((r) => r.stateWord === "LOADING")).toBe(true);
    const m = buildCommandMap(await mapInput(ID));
    expect(Object.fromEntries(m.roles.map((r) => [r.id, r.stateWord]))).toEqual({ planner: "PLAN_READY", developer: "DONE", qa: "ACTIVE", reviewer: "ACTIVE", "security-reviewer": "ACTIVE" });
  });
  it("a stale reservation reads RESERVED · STALE", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-07T14:00:00.000Z"));
    const m = await highRisk(3);
    expect(role(m, "planner").stateWord).toBe("RESERVED · STALE");
  });
  it("units per run never come from a not-launched run (its 0 is a refund); with no launched run they are null", async () => {
    const home = freshHome();
    mkdirs(home);
    const specs = standardScript(home, { cancelled: true });
    specs.splice(4, 0, { type: "AGENT_STARTED", payload: { agent: "reviewer", kind: "initial" } }, { type: "AGENT_COMPLETED", payload: { agent: "reviewer", status_or_verdict: "not-launched" }, correlation_id: "SEQ5" });
    writeScript(home, ID, specs);
    writeGovernor(home);
    const input = await mapInput(ID);
    // the mission detail page polls no governor: units come from the runs' own recorded reservations
    const m = buildCommandMap({ ...input, governor: null });
    const reviewer = role(m, "reviewer");
    expect(reviewer.latestRun?.status).toBe("not-launched");
    expect(reviewer.latestRun?.reservedUnits).toBe(0);
    expect(reviewer.unitsPerRun).toBeNull();
    expect(role(m, "developer").unitsPerRun).toBe(3); // a launched run's recorded reservation
  });
  it("the plan lock is drawn once the plan gate is or was reached, or on a HIGH-RISK mission, never early on a COMPLEX one", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    writeScript(home, ID, [
      { type: "TASK_CREATED", payload: { summary: "x", class: "COMPLEX", repo: home }, state: "CLASSIFYING", round: 0 },
      { type: "TASK_CLASSIFIED", payload: { class: "COMPLEX", reason: "r" }, state: "PLANNING" },
      { type: "AGENT_STARTED", payload: { agent: "planner", kind: "initial" } },
    ]);
    expect(edge(buildCommandMap(await mapInput(ID)), "E2").lock).toBe(false);
    expect(edge(await highRisk(3), "E2").lock).toBe(true); // HIGH-RISK always has a plan gate
    expect(edge(await highRisk(6), "E2").lock).toBe(true); // the gate is current
    expect(edge(await highRisk(10), "E2").lock).toBe(true); // the gate was passed
  });
  it("a report edge is flagged synthesizing (purple) only while the mission is in SYNTHESIZING; its state stays completed", async () => {
    const m = await highRisk(22);
    expect(m.edges.filter((e) => e.synthesizing).map((e) => e.id)).toEqual(["E7", "E8", "E9"]);
    expect(edges(m)).toMatchObject({ E7: "completed", E8: "completed", E9: "completed" });
    const later = await highRisk(25); // FIXING
    expect(later.edges.some((e) => e.synthesizing)).toBe(false);
    expect((await highRisk(16)).edges.some((e) => e.synthesizing)).toBe(false); // reports still in flight
  });
});
