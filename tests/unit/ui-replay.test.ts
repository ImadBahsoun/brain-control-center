import { afterEach, describe, expect, it, vi } from "vitest";
import type { FindingsResponse } from "@/lib/api-types";
import { buildCommandMap, type CommandMapModel } from "@/lib/ui/command-map";
import { currentAction } from "@/lib/ui/hud";
import { asReplayModel, AWAITED_WORD, buildReplay, REPLAY_CLOSED, replayAvailability, replayFrame, replayReducer, replayStepEffects, statusAt, UNRECORDED_STATUS, type ReplayState, type ReplayTimeline } from "@/lib/ui/replay";
import { freshHome, highRiskScript, mkdirs, standardScript, writeGovernor, writeScript, type EventSpec } from "../helpers/fixture-store";
import { apiDetail, apiEvents, apiFindings, mapInput } from "../helpers/ui-fixtures";

const ID = "BR-20261007-0001";

afterEach(() => vi.useRealTimers());

function clock() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-10-07T08:30:00.000Z"));
}

async function completeTimeline(limit = 1000): Promise<{ timeline: ReplayTimeline; final: CommandMapModel }> {
  const home = freshHome();
  mkdirs(home);
  writeGovernor(home);
  writeScript(home, ID, highRiskScript(home, { complete: true }));
  const [detail, findings, events] = await Promise.all([apiDetail(ID), apiFindings(ID), apiEvents(ID, limit)]);
  const built = buildReplay(detail, findings, events);
  if (!built.ok) throw new Error(built.reason);
  return { timeline: built.timeline, final: buildCommandMap(await mapInput(ID)) };
}

/** What the oracle compares: role states and words, edge states, lifecycle steps, threats. */
function shape(m: CommandMapModel) {
  return {
    status: m.detail?.status,
    current: m.detail?.lifecycle.current,
    roles: m.roles.map((r) => [r.id, r.state, r.statusText]),
    edges: m.edges.map((e) => [e.id, e.state]),
    steps: m.detail?.lifecycle.steps.map((s) => [s.state, s.status]),
    threats: m.threats.map((t) => [t.id, t.finding.status]),
  };
}

describe("replay oracle: frame n − 1 of the complete log equals the store after n events", () => {
  it.each([3, 6, 10, 16, 22, 25, 31, 37])("stopAfter %i", async (n) => {
    clock();
    const { timeline } = await completeTimeline();
    expect(timeline.steps[n - 1]?.seq).toBe(n);
    const replayed = asReplayModel(replayFrame(timeline, n - 1));
    expect(replayed.mode).toBe("replay");
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    writeScript(home, ID, highRiskScript(home, { stopAfter: n }));
    const recorded = buildCommandMap(await mapInput(ID));
    expect(shape(replayed)).toEqual(shape(recorded));
  });

  it("the last frame is the debrief map of the completed mission", async () => {
    clock();
    const { timeline, final } = await completeTimeline();
    const last = asReplayModel(replayFrame(timeline, timeline.steps.length - 1));
    expect(shape(last)).toEqual(shape(final));
    expect(last.core.statusText).toBe("REPLAY · MISSION COMPLETE"); // a replay never presents its core as the present
    expect(last.detail?.completionSummary).toBe("shipped");
  });
});

describe("replay frames leak nothing from later steps", () => {
  it("has no usage, validation record or next action in any frame, and no run or finding from the future", async () => {
    clock();
    const { timeline } = await completeTimeline();
    expect(timeline.steps).toHaveLength(41);
    for (let i = 0; i < timeline.steps.length; i++) {
      const f = replayFrame(timeline, i);
      const t = Date.parse(f.step.ts);
      expect(f.detail.usage, `frame ${i}`).toBeNull();
      expect(f.detail.nextAction).toBeNull();
      expect(f.detail.validation).toEqual({ latest: null, history: [], inProgress: null });
      for (const r of f.detail.agents) {
        expect(Date.parse(r.startedAt ?? ""), `frame ${i} ${r.role}`).toBeLessThanOrEqual(t);
        if (r.completedAt) expect(Date.parse(r.completedAt)).toBeLessThanOrEqual(t);
        expect(r.staleOverThreshold).toBe(false);
      }
      for (const x of f.findings.findings) expect(Date.parse(x.createdAt ?? "")).toBeLessThanOrEqual(t);
      expect(f.events.events.map((e) => e.seq)).toEqual(timeline.steps.slice(0, i + 1).map((s) => s.seq));
      if (i < 40) expect(f.detail.outcome).toBeNull();
    }
    // tests and files appear with their report, not before
    expect(replayFrame(timeline, 9).detail.testsRun).toEqual([]); // seq 10: developer reserved
    expect(replayFrame(timeline, 10).detail.testsRun.map((x) => x.result)).toEqual(["pass 12"]); // seq 11: reported
    expect(replayFrame(timeline, 4).detail.plan).toMatchObject({ approved: false, approvedScope: [] }); // seq 5: plan created
    expect(replayFrame(timeline, 7).detail.plan).toMatchObject({ approved: true }); // seq 8: approved
    expect(replayFrame(timeline, 3).detail.plan).toBeNull();
  });
  it("mirrors the server's state → status rule", () => {
    expect(statusAt("COMPLETE")).toBe("COMPLETE");
    expect(statusAt("ROUND_CAP_REACHED")).toBe("BLOCKED");
    expect(statusAt("HUMAN_APPROVAL")).toBe("WAITING");
    expect(statusAt("FIXING")).toBe("ACTIVE");
    expect(statusAt(null)).toBe("ACTIVE");
  });
});

describe("replayAvailability", () => {
  it("offers completed and cancelled missions; a cancelled mission replays to its banner", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    writeScript(home, ID, standardScript(home, { cancelled: true }));
    const [detail, findings, events] = await Promise.all([apiDetail(ID), apiFindings(ID), apiEvents(ID, 1000)]);
    expect(replayAvailability(detail, null, null)).toEqual({ ok: true, partial: false, caveats: [] });
    const built = buildReplay(detail, findings, events);
    if (!built.ok) throw new Error(built.reason);
    const last = asReplayModel(replayFrame(built.timeline, built.timeline.steps.length - 1));
    expect(last.banner).toBe("MISSION CANCELLED");
    expect(asReplayModel(replayFrame(built.timeline, 2)).roles.find((r) => r.id === "developer")?.state).toBe("running");
  });
  it("is partial when older events were not loaded, and places earlier runs by their timestamps", async () => {
    clock();
    const { timeline } = await completeTimeline(10);
    expect(timeline.partial).toBe(true);
    expect(timeline.caveats[0]).toBe("replay starts at #32; older events not loaded");
    expect(timeline.caveats.some((c) => c.includes("placed by timestamp"))).toBe(true);
    const first = replayFrame(timeline, 0);
    expect(first.step.seq).toBe(32);
    expect(first.detail.agents.find((r) => r.role === "planner")?.status).toBe("completed");
    expect(first.detail.rounds).toEqual([{ round: 1, kind: "developer", findings: ["F-001"], findingsAddressed: { "F-001": "fixed" }, completed: true }]);
  });
  it("is refused for an active mission, an unusable state.json and another mission's data", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    writeScript(home, ID, highRiskScript(home, { stopAfter: 16 }));
    expect(replayAvailability(await apiDetail(ID), null, null)).toMatchObject({ ok: false, reason: "replay is offered for completed or cancelled missions only" });
    writeScript(home, ID, highRiskScript(home, { complete: true }), { state: "not json" });
    expect(replayAvailability(await apiDetail(ID), null, null)).toMatchObject({ ok: false, reason: "state.json not usable (cache invalid)" });
    writeScript(home, ID, highRiskScript(home, { complete: true }));
    const detail = await apiDetail(ID);
    const events = await apiEvents(ID);
    expect(replayAvailability(detail, null, { ...events, taskId: "BR-20261007-0009" })).toMatchObject({ ok: false });
    expect(replayAvailability(detail, null, { ...events, events: [] })).toMatchObject({ ok: false, reason: "no events loaded" });
    expect(replayAvailability(null, null, null)).toMatchObject({ ok: false });
  });
});

describe("replayReducer", () => {
  const open = (length: number, autoplay = false): ReplayState => replayReducer(REPLAY_CLOSED, { type: "open", length, autoplay });
  it("opens at the first step, autoplays when asked, and stops at the end", () => {
    expect(open(3)).toMatchObject({ open: true, index: 0, playing: false, length: 3 });
    let s = open(3, true);
    expect(s.playing).toBe(true);
    s = replayReducer(s, { type: "tick" });
    expect(s).toMatchObject({ index: 1, playing: true, lastMove: 1 });
    s = replayReducer(s, { type: "tick" });
    expect(s).toMatchObject({ index: 2, playing: false, lastMove: 1 });
    expect(replayReducer(s, { type: "tick" })).toMatchObject({ index: 2, playing: false });
    expect(replayReducer(s, { type: "play" })).toMatchObject({ index: 0, playing: true, lastMove: 0 }); // play at the end restarts
    expect(open(0)).toMatchObject({ open: false });
  });
  it("steps, seeks, changes speed and exits", () => {
    let s = replayReducer(open(5, true), { type: "step", delta: 1 });
    expect(s).toMatchObject({ index: 1, playing: false, lastMove: 1 });
    s = replayReducer(s, { type: "step", delta: -1 });
    expect(s).toMatchObject({ index: 0, lastMove: 0 });
    expect(replayReducer(s, { type: "step", delta: -1 })).toMatchObject({ index: 0, lastMove: 0 });
    s = replayReducer(s, { type: "seek", index: 4 });
    expect(s).toMatchObject({ index: 4, lastMove: 0 });
    expect(replayReducer(s, { type: "seek", index: 99 }).index).toBe(4);
    expect(replayReducer(replayReducer(s, { type: "seek", index: 3 }), { type: "seek", index: 4 }).lastMove).toBe(1);
    s = replayReducer(s, { type: "speed", speed: 4 });
    expect(s.speed).toBe(4);
    expect(replayReducer(s, { type: "exit" })).toEqual({ ...REPLAY_CLOSED, speed: 4 });
    expect(replayReducer(REPLAY_CLOSED, { type: "tick" })).toBe(REPLAY_CLOSED);
  });
});

describe("replayStepEffects", () => {
  it("plays the live diff of a single step forward only", async () => {
    clock();
    const { timeline } = await completeTimeline();
    expect(replayStepEffects(timeline, 2, 1)).toEqual([{ key: "r2:0", effect: { kind: "agent-start", target: "planner" } }]); // seq 3
    expect(replayStepEffects(timeline, 2, 0)).toEqual([]);
    expect(replayStepEffects(timeline, 0, 1)).toEqual([]);
    expect(replayStepEffects(timeline, 40, 1).map((e) => e.effect.kind)).toContain("mission-complete");
  });
});

async function timelineOf(specs: (home: string) => EventSpec[], limit = 1000, editFindings?: (f: FindingsResponse) => FindingsResponse): Promise<ReplayTimeline> {
  const home = freshHome();
  mkdirs(home);
  writeGovernor(home);
  writeScript(home, ID, specs(home));
  const [detail, findings, events] = await Promise.all([apiDetail(ID), apiFindings(ID), apiEvents(ID, limit)]);
  const built = buildReplay(detail, editFindings ? editFindings(findings) : findings, events);
  if (!built.ok) throw new Error(built.reason);
  return built.timeline;
}

describe("a replay never presents a recorded step as the present", () => {
  // LIVE is matched case-sensitively: a recorded summary may say "live" about the past
  const present = (t: string) => /\bLIVE\b/.test(t) || /action required|approval required/i.test(t);
  it.each([
    ["the complete HIGH-RISK script (plan gate and human gate)", (home: string) => highRiskScript(home, { complete: true })],
    ["a cancelled STANDARD script", (home: string) => standardScript(home, { cancelled: true })],
  ])("%s: no LIVE, no ACTION REQUIRED, no callout, in any frame", async (_name, specs) => {
    clock();
    const timeline = await timelineOf(specs);
    let waited = 0;
    for (let i = 0; i < timeline.steps.length; i++) {
      const m = asReplayModel(replayFrame(timeline, i));
      expect(m.mode).toBe("replay");
      expect(m.core.live, `frame ${i}`).toBe(false);
      expect(m.core.statusText.startsWith("REPLAY · "), m.core.statusText).toBe(true);
      expect(m.gateCallout, `frame ${i}`).toBeNull();
      const texts = [
        m.core.statusText,
        m.gate.stateWord,
        m.gate.statusText,
        m.gate.gate.plan.label,
        m.gate.gate.human.label,
        m.synthesis.statusText,
        m.ready.statusText,
        m.banner ?? "",
        ...m.edges.flatMap((e) => [e.stateText, e.detail]),
        ...m.roles.flatMap((r) => [r.statusText, r.stateWord]),
        currentAction(m).text,
      ];
      for (const t of texts) expect(present(t), `frame ${i}: ${t}`).toBe(false);
      if (m.gate.stateWord === AWAITED_WORD) waited++;
    }
    if (_name.startsWith("the complete")) expect(waited).toBeGreaterThan(0); // the plan gate and the human gate were replayed
  });
  it("tells the current action in the past tense", async () => {
    clock();
    const timeline = await timelineOf((home) => highRiskScript(home, { complete: true }));
    expect(currentAction(asReplayModel(replayFrame(timeline, 5))).text).toBe("Commander approval was awaited · plan gate"); // seq 6
    expect(currentAction(asReplayModel(replayFrame(timeline, 2))).text).toBe("Planner planning · was reserved, no report yet"); // seq 3
    expect(currentAction(asReplayModel(replayFrame(timeline, 40))).text).toBe("Mission completed · shipped");
  });
});

/**
 * Same-millisecond batches, as brain-state writes them: a report and the findings it raised share one
 * instant. Fixture timestamps are otherwise 1 s apart.
 */
function sameMsScript(home: string): EventSpec[] {
  const T = "2026-10-07T08:00:06.000Z";
  const specs = standardScript(home); // seq 1–4: created, classified, developer started and reported
  specs.push(
    { type: "VALIDATION_STARTED", payload: { agents: ["qa"] }, state: "VALIDATING" }, // 5
    { type: "AGENT_STARTED", payload: { agent: "qa", kind: "initial" } }, // 6
    { type: "AGENT_COMPLETED", payload: { agent: "qa", status_or_verdict: "pass with concerns" }, correlation_id: "SEQ6", ts: T }, // 7
    { type: "FINDING_CREATED", payload: { alias: "A1", severity: "MAJOR", source: "qa", title: "one" }, state: "SYNTHESIZING", ts: T }, // 8
    { type: "FINDING_CREATED", payload: { alias: "A2", severity: "MINOR", source: "qa", title: "two" }, ts: T }, // 9
    { type: "FINDING_UPDATED", payload: { alias: "A1", status: "ACKNOWLEDGED" }, ts: T }, // 10
    { type: "FINDING_CREATED", payload: { alias: "A3", severity: "NIT", source: "qa", title: "three" }, ts: T }, // 11
    { type: "FINDING_UPDATED", payload: { alias: "A2", status: "DEFERRED", reason: "later" }, ts: T }, // 12
    { type: "TASK_COMPLETED", payload: { outcome: "COMPLETE", summary: "done" }, state: "COMPLETE" }, // 13
  );
  return specs;
}

/** When each finding and each status of the same-ms script was really recorded (seq). */
const TRUTH = { created: { "F-001": 8, "F-002": 9, "F-003": 11 } as Record<string, number>, changed: { "F-001": [{ status: "ACKNOWLEDGED", seq: 10 }], "F-002": [{ status: "DEFERRED", seq: 12 }] } as Record<string, Array<{ status: string; seq: number }>> };

describe("finding placement (never before its own log line)", () => {
  it("creates findings at their own FINDING_CREATED line inside a same-millisecond batch", async () => {
    const timeline = await timelineOf(sameMsScript);
    expect(timeline.caveats).toEqual([]);
    for (let i = 0; i < timeline.steps.length; i++) {
      const f = replayFrame(timeline, i);
      const s = f.step.seq;
      expect(f.findings.findings.map((x) => x.id).sort(), `seq ${s}`).toEqual(Object.keys(TRUTH.created).filter((id) => (TRUTH.created[id] as number) <= s).sort());
    }
  });
  it("shows a status change no earlier than its line (at the last finding update of that millisecond)", async () => {
    const timeline = await timelineOf(sameMsScript);
    const statusAtSeq = (seq: number, id: string) => replayFrame(timeline, seq - 1).findings.findings.find((x) => x.id === id)?.status;
    for (const [id, changes] of Object.entries(TRUTH.changed)) {
      for (const c of changes) for (let seq = TRUTH.created[id] as number; seq < c.seq; seq++) expect(statusAtSeq(seq, id), `${id} at seq ${seq}`).not.toBe(c.status);
    }
    expect(statusAtSeq(8, "F-001")).toBe("OPEN");
    expect(statusAtSeq(10, "F-001")).toBe("OPEN"); // its update shares 08:00:06.000 with the update at seq 12: shown there, late, not early
    expect(statusAtSeq(12, "F-001")).toBe("ACKNOWLEDGED");
    expect(statusAtSeq(11, "F-002")).toBe("OPEN");
    expect(statusAtSeq(12, "F-002")).toBe("DEFERRED");
  });
  it("aligns creations from the end of a partial window: older findings were created before it", async () => {
    const timeline = await timelineOf(sameMsScript, 4); // seq 10–13
    expect(timeline.partial).toBe(true);
    const first = replayFrame(timeline, 0); // seq 10
    expect(first.findings.findings.map((x) => x.id).sort()).toEqual(["F-001", "F-002"]);
    expect(replayFrame(timeline, 1).findings.findings.map((x) => x.id).sort()).toEqual(["F-001", "F-002", "F-003"]); // seq 11
  });
  it("falls back to timestamps (never early) with a caveat when creation lines and ids do not pair", async () => {
    const timeline = await timelineOf(sameMsScript, 1000, (f) => ({ ...f, findings: f.findings.filter((x) => x.id !== "F-002") }));
    expect(timeline.caveats).toContain("finding creations placed by timestamp: the creation lines do not pair with the finding ids");
    for (let i = 0; i < timeline.steps.length; i++) {
      const f = replayFrame(timeline, i);
      for (const x of f.findings.findings) expect(f.step.seq, `${x.id} at seq ${f.step.seq}`).toBeGreaterThanOrEqual(TRUTH.created[x.id] as number);
    }
  });
  it("shows a finding without status history as UNRECORDED until the last step, with a caveat", async () => {
    const timeline = await timelineOf(sameMsScript, 1000, (f) => ({ ...f, findings: f.findings.map((x) => ({ ...x, history: [] })) }));
    expect(timeline.caveats).toContain("3 finding(s) have no status history: their status is shown only at the last step");
    expect(replayFrame(timeline, 11).findings.findings.find((x) => x.id === "F-002")?.status).toBe(UNRECORDED_STATUS); // seq 12
    expect(replayFrame(timeline, 12).findings.findings.find((x) => x.id === "F-002")?.status).toBe("DEFERRED"); // the last step
  });
});

describe("reports of an agent that completed twice in one round", () => {
  it("are shown with the last completion of that round, never earlier", async () => {
    const timeline = await timelineOf((home) => {
      const specs = standardScript(home);
      specs.push(
        { type: "VALIDATION_STARTED", payload: { agents: ["qa"] }, state: "VALIDATING" }, // 5
        { type: "AGENT_STARTED", payload: { agent: "qa", kind: "initial" } }, // 6
        { type: "AGENT_COMPLETED", payload: { agent: "qa", status_or_verdict: "pass", tests_run: [{ cmd: "first", result: "pass 1" }] }, correlation_id: "SEQ6" }, // 7
        { type: "AGENT_STARTED", payload: { agent: "qa", kind: "initial", rerun_reason: "again" } }, // 8
        { type: "AGENT_COMPLETED", payload: { agent: "qa", status_or_verdict: "pass" }, correlation_id: "SEQ8" }, // 9
        { type: "TASK_COMPLETED", payload: { outcome: "COMPLETE", summary: "done" }, state: "COMPLETE" }, // 10
      );
      return specs;
    });
    expect(replayFrame(timeline, 7).detail.testsRun).toEqual([]); // seq 8
    expect(replayFrame(timeline, 8).detail.testsRun.map((t) => t.cmd)).toEqual(["first"]); // seq 9
  });
});
