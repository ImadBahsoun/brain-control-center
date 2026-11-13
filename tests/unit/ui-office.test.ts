import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRun, AgentsResponse, TaskDetail } from "@/lib/api-types";
import { atmosphere } from "@/lib/ui/atmosphere";
import { buildCommandMap, type CommandMapModel } from "@/lib/ui/command-map";
import { buildOfficeScene, cardLines, fitWords, LABEL_CHAR, median, REPLAY_TYPICAL, SEATS_SOURCE, TYPICAL_SCOPE, typicalDurations, VALUE_CHAR, type OfficeMetric, type OfficeScene } from "@/lib/ui/office";
import { asReplayModel, buildReplay, replayFrame, type ReplayTimeline } from "@/lib/ui/replay";
import { appendBytes, freshHome, highRiskScript, mkdirs, standardScript, writeGovernor, writeScript, type EventSpec } from "../helpers/fixture-store";
import { apiAgents, apiDetail, apiEvents, apiFindings, mapInput } from "../helpers/ui-fixtures";

const ID = "BR-20261007-0001";

afterEach(() => vi.useRealTimers());

function clock(iso = "2026-10-07T08:30:00.000Z") {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse(iso));
}

async function highRisk(stopAfter?: number, complete = false): Promise<{ model: CommandMapModel; agents: AgentsResponse }> {
  const home = freshHome();
  mkdirs(home);
  writeGovernor(home);
  writeScript(home, ID, highRiskScript(home, complete ? { complete } : { stopAfter }));
  const input = await mapInput(ID);
  return { model: buildCommandMap(input), agents: input.agents as AgentsResponse };
}

function scene(m: { model: CommandMapModel; agents: AgentsResponse }): OfficeScene {
  return buildOfficeScene(m.model, { agents: m.agents, replay: false });
}

function room(s: OfficeScene, id: string) {
  const r = s.rooms.find((x) => x.id === id);
  if (!r) throw new Error(`room ${id} missing`);
  return r;
}

function metric(s: OfficeScene, id: string, label: string): string {
  const r = id === "gate" ? s.gate : room(s, id);
  const m = r.metrics.find((x) => x.label === label);
  if (!m) throw new Error(`${id} ${label} missing`);
  return m.value;
}

function seated(s: OfficeScene): string[] {
  return s.rooms.filter((r) => r.figure.posture === "seated").map((r) => r.id);
}

/** Every item of the scene names where it came from. */
function assertSources(s: OfficeScene) {
  for (const r of s.rooms) {
    expect(r.source.length, r.id).toBeGreaterThan(0);
    expect(r.seatsSource, r.id).toBe(SEATS_SOURCE);
    expect(r.headerSource.length, r.id).toBeGreaterThan(0);
    expect(r.figure.source.length, r.id).toBeGreaterThan(0);
    expect(r.aria.length, r.id).toBeGreaterThan(0);
    expect(r.metrics, r.id).toHaveLength(3);
    for (const m of r.metrics) expect(m.source.length, `${r.id} ${m.label}`).toBeGreaterThan(0);
  }
  expect(s.gate.source.length).toBeGreaterThan(0);
  for (const m of s.gate.metrics) expect(m.source.length, `gate ${m.label}`).toBeGreaterThan(0);
  for (const c of s.gate.release) expect(c.source.length, c.state).toBeGreaterThan(0);
  expect(s.core.source.length).toBeGreaterThan(0);
  if (s.gateAlert) expect(s.gateAlert.source.length).toBeGreaterThan(0);
  for (const e of s.connections) expect(e.source.length, e.id).toBeGreaterThan(0);
}

/** No fake activity: a figure sits exactly while its role holds a pending run; motion follows the atmosphere rules. */
function assertHonest(s: OfficeScene, m: CommandMapModel) {
  expect(seated(s)).toEqual(m.roles.filter((r) => r.state === "running").map((r) => r.id));
  // an UNKNOWN role (integrity unusable) claims no reservation, like the map
  for (const r of s.rooms) expect(r.busy, r.id).toBe(m.detail && r.node.state !== "unknown" ? r.node.runs.filter((x) => x.status === "pending").length : 0);
  expect(s.core.particles === "ambient").toBe(m.mode === "idle");
  if (m.mode === "debrief" || m.mode === "loading") expect(s.core.particles).toBe("still");
  expect(atmosphere(m).animated).toBe(m.mode === "live" || m.mode === "replay");
  if (m.mode !== "live") expect(s.gateAlert === null || s.gateAlert.recorded).toBe(true);
}

describe("buildOfficeScene", () => {
  it("idle: every figure stands, nothing is busy, the core drifts ambiently and no gate waits", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    const input = await mapInput(null);
    const m = buildCommandMap(input);
    const s = buildOfficeScene(m, { agents: input.agents, replay: false });
    expect(s.mode).toBe("idle");
    expect(seated(s)).toEqual([]);
    for (const r of s.rooms) {
      expect(r).toMatchObject({ busy: 0, header: "0/1 busy", seats: 1 });
      expect(r.figure).toMatchObject({ posture: "standing", tone: "idle", word: "IDLE" });
    }
    expect(metric(s, "planner", "RUNS")).toBe("—");
    expect(metric(s, "developer", "FIX ROUNDS")).toBe("—");
    expect(metric(s, "qa", "OPEN FINDINGS")).toBe("—");
    expect(metric(s, "gate", "PLAN GATE")).toBe("—");
    expect(metric(s, "gate", "RELEASE")).toBe("—");
    expect(s.core).toMatchObject({ particles: "ambient", word: "STANDBY", alert: false });
    expect(s.gateAlert).toBeNull();
    expect(s.missionNo).toBeNull();
    assertSources(s);
    assertHonest(s, m);
  });

  it("loading: static, every count unknown", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    writeScript(home, ID, highRiskScript(home, { stopAfter: 3 }));
    const input = await mapInput(ID);
    const m = buildCommandMap({ ...input, detail: null, findings: null, events: null, focusId: ID });
    const s = buildOfficeScene(m, { agents: input.agents, replay: false });
    expect(s.mode).toBe("loading");
    expect(s.core).toMatchObject({ particles: "still", word: "LOADING" });
    for (const r of s.rooms) expect(r.header).toBe("—/1 busy");
    assertHonest(s, m);
  });

  it("a never-answered /api/tasks with no focused mission shows the core as ERROR", async () => {
    const input = await mapInput(null);
    const m = buildCommandMap({ ...input, tasks: null, tasksError: "FORBIDDEN_HOST" });
    const s = buildOfficeScene(m, { agents: input.agents, replay: false });
    expect(s.core.word).toBe("ERROR");
  });

  it("stopAfter 3: the planner sits at its desk (reserved, awaiting report) and the core is energized", async () => {
    clock();
    const h = await highRisk(3);
    const s = scene(h);
    expect(s.mode).toBe("live");
    expect(s.missionNo).toBe("#0001");
    expect(seated(s)).toEqual(["planner"]);
    expect(room(s, "planner")).toMatchObject({ busy: 1, header: "1/1 busy" });
    expect(room(s, "planner").figure).toMatchObject({ posture: "seated", tone: "active", statusText: "ACTIVE · reserved, awaiting report", word: "ACTIVE", extra: 0 });
    expect(room(s, "developer").figure).toMatchObject({ posture: "standing", word: "PENDING" });
    expect(metric(s, "planner", "RUNS")).toBe("0");
    expect(metric(s, "planner", "LAST")).toBe("—");
    expect(metric(s, "planner", "TYPICAL")).toBe("—");
    expect(s.core).toMatchObject({ particles: "energized", word: "LIVE", phase: "build" });
    expect(s.gateAlert).toBeNull();
    assertSources(s);
    assertHonest(s, h.model);
  });

  it("stopAfter 3 past the stale threshold: still seated, amber, and the core is no longer energized", async () => {
    clock("2026-10-07T14:00:00.000Z");
    const h = await highRisk(3);
    const s = scene(h);
    expect(room(s, "planner").figure).toMatchObject({ posture: "seated", tone: "stale", statusText: "RESERVED · no report, over stale threshold", word: "RESERVED · STALE" });
    expect(s.core.particles).toBe("orbit");
    assertHonest(s, h.model);
  });

  it("stopAfter 6: the gate alert counts from the recorded APPROVAL_REQUESTED", async () => {
    const h = await highRisk(6);
    const s = scene(h);
    const request = h.model.gate.gate.request;
    expect(request?.seq).toBe(6);
    expect(s.gateAlert).toEqual({
      kind: "plan",
      title: "WAITING ON YOU",
      text: "plan gate · planner → developer",
      since: request?.ts,
      outsideWindow: false,
      recorded: false,
      source: "/api/tasks/:id/events #6 APPROVAL_REQUESTED",
    });
    expect(s.gate.word).toBe("ACTION REQUIRED");
    expect(metric(s, "gate", "PLAN GATE")).toBe("ACTION REQUIRED");
    // the planner's run took one recorded second (seq 3 → 4)
    expect(metric(s, "planner", "LAST")).toBe("PLAN_READY");
    expect(metric(s, "planner", "RUNS")).toBe("1");
    expect(metric(s, "planner", "TYPICAL")).toBe("1s n=1");
    expect(seated(s)).toEqual([]);
    assertSources(s);
  });

  it("stopAfter 6 with the request outside the loaded window: no timer, marked outside the window", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    writeScript(home, ID, [...highRiskScript(home, { stopAfter: 6 }), { type: "NOTE", payload: { text: "still waiting" } }]);
    const input = await mapInput(ID);
    const events = await apiEvents(ID, 1); // only the NOTE: the request line is older than the window
    expect(events.hasMore).toBe(true);
    const s = buildOfficeScene(buildCommandMap({ ...input, events }), { agents: input.agents, replay: false });
    expect(s.gateAlert).toMatchObject({ kind: "plan", since: null, outsideWindow: true, recorded: false });
  });

  it("stopAfter 16: the three validators sit at their desks", async () => {
    clock();
    const h = await highRisk(16);
    const s = scene(h);
    expect(seated(s)).toEqual(["qa", "reviewer", "security-reviewer"]);
    expect(metric(s, "developer", "RUNS")).toBe("1");
    expect(metric(s, "developer", "FIX ROUNDS")).toBe("0/2");
    expect(metric(s, "qa", "OPEN FINDINGS")).toBe("0");
    expect(s.core.particles).toBe("energized");
    assertHonest(s, h.model);
  });

  it("complete (debrief): everyone stands with the final verdicts, the core is still, release consoles follow the lifecycle", async () => {
    const h = await highRisk(undefined, true);
    const s = scene(h);
    expect(s.mode).toBe("debrief");
    expect(seated(s)).toEqual([]);
    expect(room(s, "reviewer").figure).toMatchObject({ posture: "standing", word: "APPROVE", tone: "pass" });
    expect(metric(s, "reviewer", "LAST")).toBe("approve");
    expect(metric(s, "qa", "LAST")).toBe("pass with concerns");
    expect(metric(s, "developer", "FIX ROUNDS")).toBe("1/2");
    expect(metric(s, "developer", "RUNS")).toBe("2");
    expect(s.core).toMatchObject({ particles: "still", word: "COMPLETE", phase: "complete" });
    const steps = h.model.detail?.lifecycle.steps ?? [];
    expect(s.gate.release.map((c) => [c.label, c.status])).toEqual(["COMMITTING", "PUSHING", "PR", "DEPLOYING"].map((st, i) => [["COMMIT", "PUSH", "PR", "DEPLOY"][i], steps.find((x) => x.state === st)?.status ?? null]));
    expect(s.gateAlert).toBeNull();
    assertSources(s);
    assertHonest(s, h.model);
  });

  it("a STANDARD mission with a pending developer: only BUILD is busy", async () => {
    clock("2026-10-07T08:00:30.000Z");
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    writeScript(home, ID, standardScript(home, { pendingDeveloper: true }));
    const input = await mapInput(ID);
    const m = buildCommandMap(input);
    const s = buildOfficeScene(m, { agents: input.agents, replay: false });
    expect(seated(s)).toEqual(["developer"]);
    expect(room(s, "planner").figure.posture).toBe("standing");
    assertHonest(s, m);
  });
});

describe("buildOfficeScene: honest counts and readable cards", () => {
  async function scriptScene(specs: (home: string) => EventSpec[], corrupt = false): Promise<{ s: OfficeScene; m: CommandMapModel }> {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    const w = writeScript(home, ID, specs(home));
    if (corrupt) appendBytes(w.eventsPath, "{not json}\n");
    const input = await mapInput(ID);
    const m = buildCommandMap(input);
    return { s: buildOfficeScene(m, { agents: input.agents, replay: false }), m };
  }

  it("an unusable integrity state claims no reservation: UNKNOWN, standing, —/1 busy", async () => {
    clock("2026-10-07T08:00:30.000Z");
    const { s, m } = await scriptScene((home) => standardScript(home, { pendingDeveloper: true }), true);
    expect(m.detail?.status).toBe("CORRUPT");
    expect(m.detail?.agents.some((r) => r.role === "developer" && r.status === "pending")).toBe(true);
    expect(room(s, "developer")).toMatchObject({ busy: 0, header: "—/1 busy" });
    expect(room(s, "developer").figure).toMatchObject({ posture: "standing", tone: "unknown" });
    assertHonest(s, m);
  });

  it("RELEASE counts completed release steps of those not skipped, and reads skipped when all were skipped", async () => {
    const done = await scriptScene((home) => highRiskScript(home, { complete: true }));
    const steps = done.m.detail?.lifecycle.steps.filter((x) => ["COMMITTING", "PUSHING", "PR", "DEPLOYING"].includes(x.state)) ?? [];
    expect(steps.every((x) => x.status === "skipped")).toBe(true);
    expect(metric(done.s, "gate", "RELEASE")).toBe("skipped");
    const released = await scriptScene((home) => [
      ...highRiskScript(home),
      { type: "STATE_CHANGED", payload: { note: "commit" }, state: "COMMITTING" },
      { type: "STATE_CHANGED", payload: { note: "push" }, state: "PUSHING" },
      { type: "TASK_COMPLETED", payload: { outcome: "COMPLETE", summary: "shipped" }, state: "COMPLETE", next: null },
    ]);
    const statuses = Object.fromEntries((released.m.detail?.lifecycle.steps ?? []).map((x) => [x.state, x.status]));
    expect([statuses.COMMITTING, statuses.PUSHING]).toEqual(["completed", "completed"]);
    expect([statuses.PR, statuses.DEPLOYING]).toEqual(["skipped", "skipped"]);
    expect(metric(released.s, "gate", "RELEASE")).toBe("2 of 2");
    const pushing = await scriptScene((home) => [...highRiskScript(home), { type: "STATE_CHANGED", payload: { note: "commit" }, state: "COMMITTING" }, { type: "STATE_CHANGED", payload: { note: "push" }, state: "PUSHING" }]);
    const live = Object.fromEntries((pushing.m.detail?.lifecycle.steps ?? []).map((x) => [x.state, x.status]));
    const counted = ["COMMITTING", "PUSHING", "PR", "DEPLOYING"].filter((x) => live[x] !== "skipped");
    expect(metric(pushing.s, "gate", "RELEASE")).toBe(`1 of ${counted.length}`);
    expect(live.COMMITTING).toBe("completed");
  });

  it("names TYPICAL's scope (recent runs of all missions and projects) in the room's accessible name", async () => {
    const h = await highRisk(6);
    const s = scene(h);
    expect(TYPICAL_SCOPE).toMatch(/all missions and projects/);
    expect(room(s, "planner").aria).toContain("typical 1s (recent runs of all missions and projects, n=1)");
    expect(room(s, "qa").aria).toContain("typical — (no completed run in the recent runs of all missions and projects)");
  });
});

describe("card lines", () => {
  const m = (label: string, value: string): OfficeMetric => ({ label, value, tone: null, source: "test" });
  const W = 212;
  it("keeps a label and a whole value on one line when they fit", () => {
    expect(cardLines([m("LAST", "pass with concerns"), m("LAST", "PLAN_READY #0005")], W, 4).map((l) => [l.label, l.value])).toEqual([
      ["LAST", "pass with concerns"],
      ["LAST", "PLAN_READY #0005"],
    ]);
    expect("LAST".length * LABEL_CHAR + VALUE_CHAR + "pass with concerns".length * VALUE_CHAR).toBeLessThanOrEqual(W);
  });
  it("gives a long value its own line, cut only at a word boundary", () => {
    const lines = cardLines([m("RUNS", "1"), m("LAST", "plan ready, one open question"), m("TYPICAL", "13m 29s n=3")], W, 4);
    expect(lines.map((l) => [l.label, l.value])).toEqual([
      ["RUNS", "1"],
      ["LAST", ""],
      ["", "plan ready, one open…"],
      ["TYPICAL", "13m 29s n=3"],
    ]);
  });
  it("fits every gate word whole on the gate card; folds back at a word boundary when more values wrap than lines exist", () => {
    const gate = cardLines([m("PLAN GATE", "AWAITED APPROVAL"), m("HUMAN GATE", "ACTION REQUIRED"), m("RELEASE", "skipped")], 252, 4);
    expect(gate.map((l) => [l.label, l.value])).toEqual([
      ["PLAN GATE", "AWAITED APPROVAL"],
      ["HUMAN GATE", "ACTION REQUIRED"],
      ["RELEASE", "skipped"],
    ]);
    const folded = cardLines([m("LAST", "one two three four five six seven"), m("NEXT", "alpha beta gamma delta epsilon zeta"), m("RUNS", "1")], W, 4);
    expect(folded.length).toBeLessThanOrEqual(4);
    for (const l of folded) expect(l.value.endsWith("…") ? /\s/.test(l.value) || l.value === "…" : true).toBe(true);
    expect(fitWords("approve with minor fixes and follow-ups", 20)).toBe("approve with minor…");
    expect(fitWords("PLAN_READY #0005", 12)).toBe("PLAN_READY…");
    expect(fitWords("PLAN_READY #0005", 16)).toBe("PLAN_READY #0005");
    expect(fitWords("BR-20261010-0002", 8)).toBe("BR-20261010-0002");
  });
});

describe("buildOfficeScene in a replay", () => {
  async function timeline(): Promise<{ timeline: ReplayTimeline; detail: TaskDetail }> {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    writeScript(home, ID, highRiskScript(home, { complete: true }));
    const [detail, findings, events] = await Promise.all([apiDetail(ID), apiFindings(ID), apiEvents(ID, 1000)]);
    const built = buildReplay(detail, findings, events);
    if (!built.ok) throw new Error(built.reason);
    return { timeline: built.timeline, detail };
  }

  it("marks the waiting gate as recorded with no timer, shows no typical duration and no ambient motion", async () => {
    clock();
    const { timeline: t } = await timeline();
    const agents = await apiAgents();
    const frames = t.steps.map((_, i) => asReplayModel(replayFrame(t, i)));
    const waiting = frames.findIndex((f) => f.gate.gate.active === "plan");
    expect(waiting).toBeGreaterThan(0);
    const s = buildOfficeScene(frames[waiting] as CommandMapModel, { agents: null, replay: true });
    expect(s.mode).toBe("replay");
    expect(s.gateAlert).toMatchObject({ kind: "plan", title: "AWAITED APPROVAL · recorded", since: null, recorded: true });
    for (const r of s.rooms) {
      const typical = r.metrics.find((m) => m.label === "TYPICAL");
      expect(typical).toMatchObject({ value: "—", source: REPLAY_TYPICAL });
    }
    // even with agents passed, a replay frame shows no typical duration
    expect(metric(buildOfficeScene(frames[waiting] as CommandMapModel, { agents, replay: true }), "planner", "TYPICAL")).toBe("—");
    for (const f of frames) {
      const fs = buildOfficeScene(f, { agents: null, replay: true });
      expect(fs.core.particles).not.toBe("ambient");
      assertHonest(fs, f);
      assertSources(fs);
    }
  });
});

describe("typicalDurations", () => {
  let n = 0;
  const run = (role: string, durationMs: number | null, over: Partial<AgentRun> = {}): AgentRun => ({
    taskId: "BR-20261007-0001",
    role,
    roleLabel: role,
    model: null,
    effort: null,
    agentId: `a${++n}`,
    kind: "initial",
    round: 0,
    status: "completed",
    staleOverThreshold: false,
    verdict: "done",
    reservedUnits: 1,
    startedAt: `2026-10-07T08:00:${String(n % 60).padStart(2, "0")}.000Z`,
    completedAt: "2026-10-07T09:00:00.000Z",
    durationMs,
    rerun: false,
    ...over,
  });
  const agents = (recent: AgentRun[]): AgentsResponse => ({ generatedAt: "2026-10-07T09:00:00.000Z", active: [], recent, limits: null });

  it("takes the middle value of an odd count and the mean of the two middle values of an even count", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
    const t = typicalDurations(agents([run("qa", 3000), run("qa", 1000), run("qa", 2000), run("reviewer", 1000), run("reviewer", 4000)]), null);
    expect(t.qa).toMatchObject({ medianMs: 2000, samples: 3 });
    expect(t.reviewer).toMatchObject({ medianMs: 2500, samples: 2 });
    expect(t.planner).toMatchObject({ medianMs: null, samples: 0 });
    expect(t.qa.source).toBe(TYPICAL_SCOPE);
  });
  it("counts only completed runs with a positive duration", () => {
    const t = typicalDurations(
      agents([run("developer", 5000), run("developer", 9000, { status: "pending" }), run("developer", 9000, { status: "lost" }), run("developer", 9000, { status: "not-launched" }), run("developer", null), run("developer", 0), run("developer", Number.NaN), run("unknown-role", 7000)]),
      null,
    );
    expect(t.developer).toMatchObject({ medianMs: 5000, samples: 1 });
  });
  it("merges the recent runs with the mission's runs without counting a run twice", () => {
    const shared = run("planner", 2000);
    const own = run("planner", 6000);
    const detail = { agents: [shared, own] } as unknown as TaskDetail;
    const t = typicalDurations(agents([shared, run("planner", 1000)]), detail);
    expect(t.planner).toMatchObject({ medianMs: 2000, samples: 3 });
  });
});
