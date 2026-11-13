import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGlobalOffice, instanceWords, missionHref, pendingTotals, queuedNote, STATE_WORDS, TELEMETRY_NOTES, type GlobalOfficeModel } from "@/lib/ui/global-office";
import { busyWords, CARD_GAP, CARD_PAD, globalGateCard, globalRoomCard, globalWalks, lineLabel, lineLabels, roomLimit, TITLE_CHAR, WALK_GAP_MS, type GlobalInstance, type GlobalRoom, type InstanceState } from "@/lib/ui/global-office";
import type { AgentRun, AgentsResponse, GlobalUsage, GovernorGlobalLimits, QueuedLaunch } from "@/lib/api-types";
import { LABEL_CHAR, VALUE_CHAR } from "@/lib/ui/office";
import { GLOBAL_CARD_W, GLOBAL_GATE_CARD_W, GLOBAL_QUEUE_CAP, GLOBAL_SEAT_CAP, globalWalkPath, LINE_LABEL_CHARS } from "@/lib/ui/global-office-layout";
import { ROOM_TITLE } from "@/lib/ui/office-layout";
import { ROLES } from "@/lib/ui/roles";
import { freshHome, highRiskScript, mkdirs, standardScript, writeGovernor, writeScript, type EventSpec } from "../helpers/fixture-store";
import { apiAgents, apiGovernor, apiTasks } from "../helpers/ui-fixtures";

afterEach(() => vi.useRealTimers());

const NOW_ISO = "2026-10-07T08:30:00.000Z";

function clock(iso = NOW_ISO) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse(iso));
}

async function office(): Promise<GlobalOfficeModel> {
  const [agents, tasks] = await Promise.all([apiAgents(), apiTasks()]);
  return buildGlobalOffice({ agents, tasks, nowMs: Date.parse(agents.generatedAt) });
}

const room = (m: GlobalOfficeModel, id: string) => {
  const r = m.rooms.find((x) => x.id === id);
  if (!r) throw new Error(`room ${id} missing`);
  return r;
};
const who = (xs: Array<{ taskId: string; state?: string }>) => xs.map((x) => `${x.taskId}${x.state ? `:${x.state}` : ""}`);

function custom(home: string, repoRel: string, rest: EventSpec[], created: Partial<EventSpec> = {}): EventSpec[] {
  return [{ type: "TASK_CREATED", payload: { summary: "custom", class: "STANDARD", repo: path.join(home, repoRel) }, state: "CLASSIFYING", round: 0, ...created }, ...rest];
}

const DENY = "[governor] DENIED CONCURRENCY qa, reviewer: global validators 4/3; active: BR-20261007-0002/qa seq 14 (initial)";

/** Six missions: a running developer, three running validators, an IMPLEMENTING mission with only finished runs
 * (completed, lost, not-launched), a stale planner, a queued validation launch and a COMPLETE mission. */
function store() {
  clock();
  const home = freshHome();
  mkdirs(home);
  writeGovernor(home);
  writeScript(home, "BR-20261007-0001", standardScript(home, { pendingDeveloper: true }));
  writeScript(home, "BR-20261007-0002", highRiskScript(home, { stopAfter: 16 }));
  writeScript(
    home,
    "BR-20261007-0003",
    custom(home, "side/api", [
      { type: "TASK_CLASSIFIED", payload: { class: "STANDARD", security_triggers: [], qa_triggers: [] }, state: "IMPLEMENTING" },
      { type: "AGENT_STARTED", payload: { agent: "planner", kind: "initial" } },
      { type: "AGENT_COMPLETED", payload: { agent: "planner", status_or_verdict: "lost" }, correlation_id: "SEQ3" },
      { type: "AGENT_STARTED", payload: { agent: "developer", kind: "initial" } },
      { type: "AGENT_COMPLETED", payload: { agent: "developer", status_or_verdict: "done" }, correlation_id: "SEQ5" },
      { type: "AGENT_STARTED", payload: { agent: "qa", kind: "initial" } },
      { type: "AGENT_COMPLETED", payload: { agent: "qa", status_or_verdict: "not-launched" }, correlation_id: "SEQ7" },
    ]),
  );
  writeScript(
    home,
    "BR-20261007-0004",
    custom(
      home,
      "work/api",
      [
        { type: "TASK_CLASSIFIED", payload: { class: "COMPLEX", security_triggers: [], qa_triggers: [] }, state: "PLANNING", ts: "2026-10-07T01:00:01.000Z" },
        { type: "AGENT_STARTED", payload: { agent: "planner", kind: "initial" }, ts: "2026-10-07T01:00:02.000Z" },
      ],
      { ts: "2026-10-07T01:00:00.000Z" },
    ),
  );
  writeScript(
    home,
    "BR-20261007-0005",
    custom(home, "proj/repo", [
      { type: "TASK_CLASSIFIED", payload: { class: "STANDARD", security_triggers: [], qa_triggers: [] }, state: "IMPLEMENTING" },
      { type: "AGENT_STARTED", payload: { agent: "developer", kind: "initial" } },
      { type: "AGENT_COMPLETED", payload: { agent: "developer", status_or_verdict: "done" }, correlation_id: "SEQ3" },
      { type: "STATE_CHANGED", payload: {}, state: "VALIDATING" },
      { type: "NOTE", payload: { text: DENY } },
      { type: "NOTE", payload: { text: "[governor] WAIT started 2026-10-07T08:00:06Z · qa, reviewer · timeout 30m · DENIED CONCURRENCY qa, reviewer" } },
    ]),
  );
  writeScript(home, "BR-20261007-0006", highRiskScript(home, { complete: true }));
  return home;
}

describe("buildGlobalOffice over real /api/agents and /api/tasks bodies", () => {
  it("draws a figure only for a pending run or a recorded concurrency wait, grouped by role across missions", async () => {
    store();
    const m = await office();
    expect(m.loaded).toBe(true);
    expect(who(room(m, "planner").instances)).toEqual(["BR-20261007-0004:stale"]);
    expect(who(room(m, "developer").instances)).toEqual(["BR-20261007-0001:running"]);
    expect(who(room(m, "qa").instances)).toEqual(["BR-20261007-0005:queued", "BR-20261007-0002:running"]); // by since: the wait (08:00:06) before the start (08:00:13)
    expect(who(room(m, "reviewer").instances)).toEqual(["BR-20261007-0005:queued", "BR-20261007-0002:running"]); // by since: the wait (08:00:06) before the start (08:00:13)
    expect(who(room(m, "security-reviewer").instances)).toEqual(["BR-20261007-0002:running"]);
    expect(m.other).toEqual([]);
    expect(m.missions).toBe(4);
    // finished runs never stand in a room; the COMPLETE mission and the IMPLEMENTING one with no pending run are absent
    const everyone = m.rooms.flatMap((r) => r.instances.map((i) => i.taskId));
    expect(everyone).not.toContain("BR-20261007-0003");
    expect(everyone).not.toContain("BR-20261007-0006");
  });
  it("maps the statuses: running, over the stale threshold (240 min), queued with its roles and wait", async () => {
    store();
    const m = await office();
    const dev = room(m, "developer").instances[0];
    expect(dev).toMatchObject({ state: "running", missionNo: "#0001", repoLabel: "repo", repoKnown: true, missionStatus: "ACTIVE", kind: "initial", model: "fable" });
    expect(dev?.elapsedMs).toBe(Date.parse(NOW_ISO) - Date.parse(dev?.since ?? ""));
    const stale = room(m, "planner").instances[0];
    expect(stale).toMatchObject({ state: "stale", since: "2026-10-07T01:00:02.000Z", elapsedMs: 7.5 * 3_600_000 - 2000 });
    const queued = room(m, "qa").instances.find((i) => i.state === "queued");
    expect(queued).toMatchObject({ taskId: "BR-20261007-0005", role: "qa", since: "2026-10-07T08:00:06.000Z", note: "waiting for a slot · timeout 30m", kind: null, model: null });
    expect(room(m, "reviewer").instances.find((i) => i.state === "queued")?.taskId).toBe("BR-20261007-0005");
    expect(m.queuedLaunches).toBe(1);
    expect(room(m, "qa")).toMatchObject({ running: 1, stale: 0, queued: 1, header: "1 running · 1 queued" });
    expect(room(m, "planner")).toMatchObject({ running: 0, stale: 1, queued: 0, header: "0 running · 0 queued" });
    expect(STATE_WORDS.stale).toBe("over stale threshold");
  });
  it("lists completed, lost and not-launched runs of open missions only under recently finished", async () => {
    store();
    const m = await office();
    const finished = (id: string) => room(m, id).recentFinished.filter((f) => f.taskId === "BR-20261007-0003").map((f) => f.status);
    expect(finished("planner")).toEqual(["lost"]);
    expect(finished("developer")).toEqual(["completed"]);
    expect(finished("qa")).toEqual(["not-launched"]);
    for (const r of m.rooms) for (const f of r.recentFinished) expect(f.taskId, `${r.id} lists a terminal mission`).not.toBe("BR-20261007-0006");
    expect(m.rooms.flatMap((r) => r.recentFinished).length).toBeLessThanOrEqual(20);
  });
  it("labels repositories over the full mission list, telling two `api` repositories apart", async () => {
    store();
    const m = await office();
    expect(room(m, "planner").instances[0]?.repoLabel).toBe("work/api");
    expect(room(m, "developer").recentFinished.find((f) => f.taskId === "BR-20261007-0003")?.repoLabel).toBe("side/api");
  });
  it("counts capacity by the governor's rule: the totals equal /api/governor global for the same store", async () => {
    store();
    const m = await office();
    const governor = await apiGovernor();
    expect(m.totals).toEqual(governor.global);
    expect(m.totals).toMatchObject({ pendingTotal: 4, pendingDevelopers: 1, pendingValidators: 3, staleExcluded: 1 });
  });
  it("leaves the BUILD room empty for an IMPLEMENTING mission with no pending run", async () => {
    clock();
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    writeScript(home, "BR-20261007-0001", standardScript(home));
    const tasks = await apiTasks();
    expect(tasks.tasks[0]?.state).toBe("IMPLEMENTING");
    const m = await office();
    for (const r of m.rooms) expect(r.instances, r.id).toEqual([]);
    expect(m.totals.pendingTotal).toBe(0);
  });
  it("draws at most GLOBAL_SEAT_CAP seated figures per room; the rest overflow, oldest first", async () => {
    clock();
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    for (let i = 1; i <= GLOBAL_SEAT_CAP + 2; i++) writeScript(home, `BR-20261007-000${i}`, standardScript(home, { pendingDeveloper: true }));
    const m = await office();
    const dev = room(m, "developer");
    expect(dev.instances).toHaveLength(GLOBAL_SEAT_CAP + 2);
    expect(dev.seated).toHaveLength(GLOBAL_SEAT_CAP);
    expect(dev.visible).toEqual(dev.seated);
    expect(dev.overflow).toHaveLength(2);
    expect([...dev.visible, ...dev.overflow]).toEqual(dev.instances);
  });
  it("draws at most GLOBAL_QUEUE_CAP queued figures per room; the rest overflow, oldest first", async () => {
    clock();
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    const n = GLOBAL_QUEUE_CAP + 2;
    // denial times run against the ids (#0001 newest, #000n oldest), so the order is by time, not by id
    const deniedAt = (i: number) => `2026-10-07T08:${String(20 - i).padStart(2, "0")}:00.000Z`;
    for (let i = 1; i <= n; i++)
      writeScript(
        home,
        `BR-20261007-000${i}`,
        custom(home, `r${i}/api`, [
          { type: "TASK_CLASSIFIED", payload: { class: "STANDARD", security_triggers: [], qa_triggers: [] }, state: "IMPLEMENTING" },
          { type: "AGENT_STARTED", payload: { agent: "developer", kind: "initial" } },
          { type: "AGENT_COMPLETED", payload: { agent: "developer", status_or_verdict: "done" }, correlation_id: "SEQ3" },
          { type: "STATE_CHANGED", payload: {}, state: "VALIDATING" },
          { type: "NOTE", payload: { text: "[governor] DENIED CONCURRENCY qa: global validators 4/3" }, ts: deniedAt(i) },
        ]),
      );
    const m = await office();
    const qa = room(m, "qa");
    const oldestFirst = Array.from({ length: n }, (_, k) => `BR-20261007-000${n - k}:queued`);
    expect(m.queuedLaunches).toBe(n);
    expect(who(qa.instances)).toEqual(oldestFirst);
    expect(qa.instances.map((i) => i.since)).toEqual(Array.from({ length: n }, (_, k) => deniedAt(n - k)));
    expect(qa.seated).toEqual([]);
    expect(qa.waiting).toHaveLength(GLOBAL_QUEUE_CAP);
    expect(who(qa.waiting)).toEqual(oldestFirst.slice(0, GLOBAL_QUEUE_CAP));
    expect(qa.visible).toEqual(qa.waiting);
    expect(who(qa.overflow)).toEqual(oldestFirst.slice(GLOBAL_QUEUE_CAP));
    expect([...qa.visible, ...qa.overflow]).toEqual(qa.instances);
    expect(qa).toMatchObject({ running: 0, stale: 0, queued: n, header: `0 running · ${n} queued` });
    for (const r of m.rooms) if (r.id !== "qa") expect(r.instances, r.id).toEqual([]);
  });
  it("keeps a role outside the five rooms in the roster's other bucket only", async () => {
    clock();
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    writeScript(home, "BR-20261007-0001", [...standardScript(home), { type: "AGENT_STARTED", payload: { agent: "auditor", kind: "initial" } }]);
    const m = await office();
    expect(who(m.other)).toEqual(["BR-20261007-0001:running"]);
    for (const r of m.rooms) expect(r.instances, r.id).toEqual([]);
  });
  it("is empty and not loaded before the first /api/agents body", () => {
    const m = buildGlobalOffice({ agents: null, tasks: null, nowMs: 0 });
    expect(m.loaded).toBe(false);
    expect(m.waitingApproval).toBeNull();
    for (const r of m.rooms) expect(r.instances).toEqual([]);
  });
});

describe("words and links", () => {
  it("links a mission by its encoded id", () => {
    expect(missionHref("BR-20261007-0001")).toBe("/tasks/BR-20261007-0001");
    expect(missionHref("a/b?c#d")).toBe("/tasks/a%2Fb%3Fc%23d");
  });
  it("says what is not known: no liveness, no queue position, the 20-run cap — and never 'disconnected'", () => {
    const all = [...TELEMETRY_NOTES, ...Object.values(STATE_WORDS)].join(" ");
    expect(all).toMatch(/no liveness data/i);
    expect(all).toMatch(/no queue position/i);
    expect(all).toMatch(/20 newest finished runs/);
    expect(all).not.toMatch(/disconnect/i);
  });
  it("describes a queued launch without a position, and an abandoned-looking one as such", () => {
    const now = Date.parse("2026-10-07T09:00:00.000Z");
    const base = { taskId: "BR-20261007-0001", roles: ["qa"], deniedSeq: 6, deniedAt: "2026-10-07T08:00:00.000Z", overStaleThreshold: false };
    const cases: Array<[string, string]> = [
      [queuedNote({ ...base, wait: null }, now), "denied for concurrency, no wait recorded"],
      [queuedNote({ ...base, wait: { startedAt: "2026-10-07T08:00:01.000Z", timeoutMinutes: 30, endedAt: null, outcome: null } }, now), "wait started, no end recorded"],
      [queuedNote({ ...base, wait: { startedAt: "2026-10-07T08:50:00.000Z", timeoutMinutes: 30, endedAt: null, outcome: null } }, now), "waiting for a slot · timeout 30m"],
      [queuedNote({ ...base, wait: { startedAt: "2026-10-07T08:00:01.000Z", timeoutMinutes: 30, endedAt: "2026-10-07T08:02:00.000Z", outcome: "CLEAR" } }, now), "wait ended clear, no launch yet"],
      [queuedNote({ ...base, overStaleThreshold: true, wait: null }, Date.parse("2026-10-07T13:00:00.000Z")), "denied 5h 0m ago, no launch since"],
    ];
    for (const [got, want] of cases) expect(got).toBe(want);
    // no variant ever claims a place in line
    for (const [got] of cases) expect(got).not.toMatch(/position|#\d+ in line|\bnext\b|\b\d+(st|nd|rd|th)\b/i);
  });
  it("names a figure in words for its accessible name", async () => {
    store();
    const m = await office();
    expect(instanceWords(room(m, "developer").instances[0]!)).toMatch(/^Developer on BR-20261007-0001, repo repo, running 29m \d+s$/);
    expect(instanceWords(room(m, "planner").instances[0]!)).toMatch(/^Planner on BR-20261007-0004, repo work\/api, over stale threshold, reserved 7h 29m ago$/);
  });
  it("pendingTotals ignores non-pending runs", () => {
    expect(pendingTotals([])).toEqual({ pendingTotal: 0, pendingDevelopers: 0, pendingValidators: 0, pendingOpus: 0, pendingFable: 0, staleExcluded: 0 });
  });
});

describe("activity lines", () => {
  const AT = "2026-10-07T08:00:00.000Z";
  const run = (taskId: string, role: string, o: Partial<AgentRun> = {}): AgentRun => ({
    taskId,
    role,
    roleLabel: role,
    model: null,
    effort: null,
    agentId: null,
    kind: "initial",
    round: null,
    status: "pending",
    staleOverThreshold: false,
    verdict: null,
    reservedUnits: null,
    startedAt: AT,
    completedAt: null,
    durationMs: null,
    rerun: false,
    ...o,
  });
  const wait = (taskId: string, roles: string[], o: Partial<QueuedLaunch> = {}): QueuedLaunch => ({ taskId, roles, deniedSeq: 5, deniedAt: AT, wait: null, overStaleThreshold: false, ...o });
  const lines = (active: AgentRun[], queued: QueuedLaunch[] = []) => {
    const agents: AgentsResponse = { generatedAt: NOW_ISO, active, recent: [], limits: null, queued };
    return buildGlobalOffice({ agents, tasks: null, nowMs: Date.parse(NOW_ISO) }).activityLines;
  };

  it("draws a line to a room with a running instance only: the active style, its mission numbers and words", () => {
    expect(lines([run("BR-20261007-0011", "developer")])).toEqual([
      { role: "developer", tone: "running", running: 1, queued: 0, missions: ["#0011"], label: "#0011", labels: ["#0011"], words: "Build: 1 running (#0011)" },
    ]);
  });
  it("draws a line to a room with a queued instance only, in the queued style", () => {
    expect(lines([], [wait("BR-20261007-0005", ["qa"])])).toEqual([
      { role: "qa", tone: "queued", running: 0, queued: 1, missions: ["#0005"], label: "#0005", labels: ["#0005"], words: "Quality: 1 queued (#0005)" },
    ]);
  });
  it("carries the running missions, then the queued ones, when a room has both (the active style)", () => {
    const got = lines([run("BR-20261007-0002", "qa", { startedAt: "2026-10-07T08:05:00.000Z" })], [wait("BR-20261007-0005", ["qa"])]);
    expect(got).toEqual([
      { role: "qa", tone: "running", running: 1, queued: 1, missions: ["#0002", "#0005"], label: "#0002 #0005", labels: ["#0002 #0005", "#0002 +1", "#0002+1"], words: "Quality: 1 running, 1 queued (#0002, #0005)" },
    ]);
  });
  it("draws no line to a room whose only instances are over the stale threshold, and carries no stale mission", () => {
    expect(lines([run("BR-20261007-0004", "planner", { staleOverThreshold: true })])).toEqual([]);
    const got = lines([run("BR-20261007-0004", "planner", { staleOverThreshold: true }), run("BR-20261007-0009", "planner", { startedAt: "2026-10-07T08:10:00.000Z" })]);
    expect(got.map((l) => [l.role, l.running, l.missions])).toEqual([["planner", 1, ["#0009"]]]);
  });
  it("draws no line for a queued launch past the stale threshold (likely abandoned), and leaves it out of a mixed room's line", () => {
    expect(lines([], [wait("BR-20261007-0005", ["qa"], { overStaleThreshold: true })])).toEqual([]);
    const got = lines([], [wait("BR-20261007-0005", ["qa"], { overStaleThreshold: true }), wait("BR-20261007-0006", ["qa"], { deniedSeq: 7 })]);
    expect(got).toEqual([
      { role: "qa", tone: "queued", running: 0, queued: 1, missions: ["#0006"], label: "#0006", labels: ["#0006"], words: "Quality: 1 queued (#0006)" },
    ]);
    // the figure and roster entry stay: the instance is still in the room, only the line ignores it
    const agents: AgentsResponse = { generatedAt: NOW_ISO, active: [], recent: [], limits: null, queued: [wait("BR-20261007-0005", ["qa"], { overStaleThreshold: true })] };
    const room = buildGlobalOffice({ agents, tasks: null, nowMs: Date.parse(NOW_ISO) }).rooms.find((r) => r.id === "qa");
    expect(room?.instances.map((i) => [i.state, i.overStaleThreshold])).toEqual([["queued", true]]);
    expect(room?.waiting).toHaveLength(1);
    expect(room?.queued).toBe(1);
    expect(room?.header).toBe("0 running · 1 queued");
    // a running instance beside a stale queued launch: a running line that carries only the run
    expect(lines([run("BR-20261007-0002", "qa")], [wait("BR-20261007-0005", ["qa"], { overStaleThreshold: true })])).toEqual([
      { role: "qa", tone: "running", running: 1, queued: 0, missions: ["#0002"], label: "#0002", labels: ["#0002"], words: "Quality: 1 running (#0002)" },
    ]);
  });
  it("draws no line at all with no instance, before the first /api/agents body, or for a role outside the five rooms", () => {
    expect(lines([])).toEqual([]);
    expect(buildGlobalOffice({ agents: null, tasks: null, nowMs: 0 }).activityLines).toEqual([]);
    expect(lines([run("BR-20261007-0001", "auditor")])).toEqual([]);
    // finished runs never draw a line
    expect(lines([run("BR-20261007-0001", "developer", { status: "completed" })])).toEqual([]);
  });
  it("draws one line per room across missions, in room order, each mission once, up to two numbers then +k", () => {
    const got = lines(
      [
        run("BR-20261007-0011", "developer", { startedAt: "2026-10-07T08:01:00.000Z" }),
        run("BR-20261007-0004", "developer", { startedAt: "2026-10-07T08:02:00.000Z" }),
        run("BR-20261007-0007", "developer", { startedAt: "2026-10-07T08:03:00.000Z" }),
        run("BR-20261007-0002", "reviewer"),
      ],
      [wait("BR-20261007-0005", ["qa", "reviewer"]), wait("BR-20261007-0002", ["reviewer"], { deniedSeq: 9 })],
    );
    expect(got.map((l) => l.role)).toEqual(["developer", "qa", "reviewer"]);
    expect(got[0]).toMatchObject({ running: 3, queued: 0, missions: ["#0011", "#0004", "#0007"], label: "#0011 #0004 +1", labels: ["#0011 #0004 +1", "#0011 +2", "#0011+2"], words: "Build: 3 running (#0011, #0004, #0007)" });
    expect(got[1]).toMatchObject({ tone: "queued", missions: ["#0005"] });
    // the reviewer's running #0002 and its queued #0002 are one mission on the plate
    expect(got[2]).toMatchObject({ tone: "running", running: 1, queued: 2, missions: ["#0002", "#0005"], words: "Review: 1 running, 2 queued (#0002, #0005)" });
  });
  it("counts two missions that share a mission number (ids from different days) as two, by task id", () => {
    const got = lines([run("BR-20261020-0003", "developer", { startedAt: "2026-10-07T08:01:00.000Z" }), run("BR-20261021-0003", "developer", { startedAt: "2026-10-07T08:02:00.000Z" })]);
    expect(got).toEqual([
      { role: "developer", tone: "running", running: 2, queued: 0, missions: ["#0003", "#0003"], label: "#0003 #0003", labels: ["#0003 #0003", "#0003 +1", "#0003+1"], words: "Build: 2 running (#0003, #0003)" },
    ]);
    // a third mission makes it "+1", and the same task running and queued still counts once
    const more = lines([run("BR-20261020-0003", "developer"), run("BR-20261021-0003", "developer", { startedAt: "2026-10-07T08:02:00.000Z" })], [wait("BR-20261019-0003", ["developer"]), wait("BR-20261021-0003", ["developer"], { deniedSeq: 9 })]);
    expect(more[0]).toMatchObject({ running: 2, queued: 2, missions: ["#0003", "#0003", "#0003"], label: "#0003 #0003 +1" });
  });
  it("takes presence from runs and waits only, never from a mission's lifecycle (real /api/agents and /api/tasks bodies)", async () => {
    store();
    const m = await office();
    expect(m.activityLines.map((l) => [l.role, l.tone, l.missions])).toEqual([
      ["developer", "running", ["#0001"]],
      ["qa", "running", ["#0002", "#0005"]],
      ["reviewer", "running", ["#0002", "#0005"]],
      ["security-reviewer", "running", ["#0002"]],
    ]);
    // an IMPLEMENTING mission with no pending run draws no line to BUILD
    clock();
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    writeScript(home, "BR-20261007-0001", standardScript(home));
    expect((await apiTasks()).tasks[0]?.state).toBe("IMPLEMENTING");
    expect((await office()).activityLines).toEqual([]);
  });
  it("keeps every label within LINE_LABEL_CHARS: fewer numbers for many missions, a long id cut", () => {
    const many = Array.from({ length: 150 }, (_, i) => `#${String(i).padStart(4, "0")}`);
    expect(lineLabel(many)).toBe("#0000 +149");
    expect(lineLabel(["#0001", "#0002"])).toBe("#0001 #0002");
    expect(lineLabel(["#a-very-long-mission-id", "#0002"])).toBe("#a-very-lon… +1");
    for (const ms of [["#0001"], ["#0001", "#0002"], many.slice(0, 12), many, ["#a-very-long-mission-id-without-dashes", "#0002"]]) for (const l of lineLabels(ms)) expect(l.length, l).toBeLessThanOrEqual(LINE_LABEL_CHARS);
  });
});

const LIMITS: GovernorGlobalLimits = { max_total_agents: 6, max_developers: 2, max_validators: 3, max_opus_agents: 2, max_fable_agents: 4 };

function pendingRun(taskId: string, role: string, o: Partial<AgentRun> = {}): AgentRun {
  return { taskId, role, roleLabel: role, model: null, effort: null, agentId: null, kind: "initial", round: null, status: "pending", staleOverThreshold: false, verdict: null, reservedUnits: null, startedAt: "2026-10-07T08:00:00.000Z", completedAt: null, durationMs: null, rerun: false, ...o };
}

describe("room limits and seating", () => {
  it("takes m from the governor's limit of the room's lane only, and gives none without a valid one", () => {
    expect(ROLES.map((r) => roomLimit(r, LIMITS))).toEqual([6, 2, 3, 3, 3]);
    expect(ROLES.map((r) => roomLimit(r, null))).toEqual([null, null, null, null, null]);
    for (const bad of [Number.NaN, -1, 2.5]) expect(roomLimit("developer", { ...LIMITS, max_developers: bad }), String(bad)).toBeNull();
    const agents: AgentsResponse = { generatedAt: NOW_ISO, active: [], recent: [], limits: null, queued: [] };
    expect(buildGlobalOffice({ agents, tasks: null, nowMs: 0, limits: LIMITS }).rooms.map((r) => r.limit)).toEqual([6, 2, 3, 3, 3]);
    expect(buildGlobalOffice({ agents, tasks: null, nowMs: 0 }).rooms.map((r) => r.limit)).toEqual([null, null, null, null, null]);
  });
  it("seats running instances before stale ones, each oldest first", () => {
    const agents: AgentsResponse = {
      generatedAt: NOW_ISO,
      active: [
        pendingRun("BR-20261007-0001", "planner", { staleOverThreshold: true, startedAt: "2026-10-07T01:00:00.000Z" }),
        pendingRun("BR-20261007-0002", "planner", { startedAt: "2026-10-07T08:10:00.000Z" }),
        pendingRun("BR-20261007-0003", "planner", { startedAt: "2026-10-07T08:05:00.000Z" }),
      ],
      recent: [],
      limits: null,
    };
    const planner = room(buildGlobalOffice({ agents, tasks: null, nowMs: Date.parse(NOW_ISO) }), "planner");
    expect(who(planner.seated)).toEqual(["BR-20261007-0003:running", "BR-20261007-0002:running", "BR-20261007-0001:stale"]);
    // the room's instances keep their time order for the roster and the text version
    expect(who(planner.instances)).toEqual(["BR-20261007-0001:stale", "BR-20261007-0003:running", "BR-20261007-0002:running"]);
  });
  it("overflows past six seats: running ones keep the desks, the rest go to the +k marker and the roster", () => {
    const active = [pendingRun("BR-20261007-0100", "qa", { staleOverThreshold: true, startedAt: "2026-10-07T01:00:00.000Z" }), ...Array.from({ length: 6 }, (_, i) => pendingRun(`BR-20261007-01${String(i + 1).padStart(2, "0")}`, "qa", { startedAt: `2026-10-07T08:0${i}:00.000Z` }))];
    const qa = room(buildGlobalOffice({ agents: { generatedAt: NOW_ISO, active, recent: [], limits: null }, tasks: null, nowMs: Date.parse(NOW_ISO) }), "qa");
    expect(GLOBAL_SEAT_CAP).toBe(6);
    expect(qa.seated.map((i) => i.state)).toEqual(Array(6).fill("running"));
    expect(who(qa.overflow)).toEqual(["BR-20261007-0100:stale"]);
  });
});

describe("card text fits the card", () => {
  const inner = GLOBAL_CARD_W - 2 * CARD_PAD;
  const inst = (state: InstanceState, i: number): GlobalInstance => ({
    key: `${state}-${i}`,
    taskId: `BR-20261007-${String(9000 + i)}`,
    missionNo: `#${String(9000 + i)}`,
    title: null,
    repoLabel: "repo",
    repoKnown: true,
    missionStatus: null,
    role: "planner",
    roleLabel: "Planner",
    state,
    since: "2026-10-07T08:00:00.000Z",
    elapsedMs: 0,
    kind: null,
    round: null,
    model: null,
    note: null,
    overStaleThreshold: state === "stale",
    source: "test",
  });
  const roomOf = (id: (typeof ROLES)[number], running: number, queued: number, stale: number, limit: number | null = null): GlobalRoom => {
    const instances = [...Array.from({ length: stale }, (_, i) => inst("stale", i)), ...Array.from({ length: running }, (_, i) => inst("running", 100 + i)), ...Array.from({ length: queued }, (_, i) => inst("queued", 200 + i))];
    return { id, title: ROOM_TITLE[id], instances, seated: [], waiting: [], visible: [], overflow: [], running, stale, queued, header: `${running} running · ${queued} queued`, limit, recentFinished: [] };
  };
  const totals = (n: number): GlobalUsage => ({ pendingTotal: n, pendingDevelopers: n, pendingValidators: n, pendingOpus: 0, pendingFable: 0, staleExcluded: 0 });

  it("fits the title with n/m busy and both rows, at 2-digit counts and limits, with and without a policy", () => {
    for (const id of ROLES) {
      for (const running of [0, 1, 10, 99]) {
        for (const queued of [0, 1, 99]) {
          for (const stale of [0, 1, 99]) {
            for (const limit of [null, 3, 99]) {
              const what = `${id} ${running}/${queued}/${stale} limit ${limit}`;
              const card = globalRoomCard(roomOf(id, running, queued, stale, limit), totals(running));
              const titleW = card.title.length * TITLE_CHAR + CARD_GAP + card.right.length * VALUE_CHAR;
              expect(titleW, `${what}: "${card.title}" + "${card.right}" ${titleW.toFixed(1)}`).toBeLessThanOrEqual(inner);
              expect(card.right, what).toBe(limit === null ? `${running} busy` : `${running}/${limit} busy`);
              for (const row of card.rows) {
                const w = row.label.length * LABEL_CHAR + CARD_GAP + row.value.length * VALUE_CHAR;
                expect(w, `${what}: "${row.label}" / "${row.value}" ${w.toFixed(1)}`).toBeLessThanOrEqual(inner);
              }
            }
          }
        }
      }
    }
  });
  it("counts only running instances in n (stale ones are left out, as the governor leaves them out), and the stale count in its row", () => {
    const card = globalRoomCard(roomOf("planner", 1, 2, 3, 6), totals(4));
    expect(card).toEqual({
      title: "PLANNING",
      right: "1/6 busy",
      rows: [
        { label: "queued · stale", value: "2 · 3", warn: true },
        { label: "all agents", value: "4/6", warn: false },
      ],
    });
    expect(globalRoomCard(roomOf("planner", 0, 0, 0, 6), totals(0)).rows[0]).toEqual({ label: "queued · stale", value: "0 · 0", warn: false });
  });
  it("names the lane m belongs to: developers for BUILD, the validator lane shared by three rooms, all agents for PLANNING; no m without a policy", () => {
    const usage: GlobalUsage = { pendingTotal: 5, pendingDevelopers: 1, pendingValidators: 3, pendingOpus: 0, pendingFable: 0, staleExcluded: 0 };
    expect(globalRoomCard(roomOf("developer", 1, 0, 0, 2), usage).rows[1]).toEqual({ label: "developer lane", value: "1/2", warn: false });
    for (const id of ["qa", "reviewer", "security-reviewer"] as const) {
      expect(globalRoomCard(roomOf(id, 1, 0, 0, 3), usage).rows[1], id).toEqual({ label: "shared (3 rooms)", value: "3/3", warn: false });
      expect(busyWords(roomOf(id, 1, 0, 0, 3)), id).toBe("1 of 3 busy (validator limit shared by Quality, Review and Security)");
    }
    expect(globalRoomCard(roomOf("planner", 2, 0, 0, 6), usage).rows[1]).toEqual({ label: "all agents", value: "5/6", warn: false });
    const none = globalRoomCard(roomOf("qa", 2, 0, 0, null), usage);
    expect(none).toMatchObject({ right: "2 busy", rows: [{ value: "0 · 0" }, { label: "limit", value: "no policy" }] });
    expect(none.right).not.toMatch(/\//);
    expect(busyWords(roomOf("qa", 2, 0, 0, null))).toBe("2 busy (no governor limit without a valid policy)");
  });
  it("marks a queued launch past the stale threshold as stale on the card, not in the queued count", () => {
    const old = { ...inst("queued", 300), overStaleThreshold: true };
    const fresh = inst("queued", 301);
    const roomWith = (instances: GlobalInstance[]): GlobalRoom => ({ ...roomOf("qa", 0, 0, 0), instances, queued: instances.length, header: `0 running · ${instances.length} queued` });
    expect(globalRoomCard(roomWith([old]), totals(0)).rows[0]).toEqual({ label: "queued · stale", value: "0 · 1", warn: true });
    expect(globalRoomCard(roomWith([old, fresh]), totals(0)).rows[0]).toEqual({ label: "queued · stale", value: "1 · 1", warn: true });
    // 3-digit counts shorten the label rather than run past the edge
    const big = globalRoomCard(roomOf("qa", 0, 100, 100), totals(0)).rows[0];
    expect(big.label.length * LABEL_CHAR + CARD_GAP + big.value.length * VALUE_CHAR).toBeLessThanOrEqual(inner);
  });
  it("fits the Commander Gate card: title, the approvals waiting and where approvals happen", () => {
    const gateInner = GLOBAL_GATE_CARD_W - 2 * CARD_PAD;
    for (const waiting of [null, 0, 1, 12, 99_999]) {
      const card = globalGateCard(waiting);
      expect(card.title.length * TITLE_CHAR, card.title).toBeLessThanOrEqual(gateInner);
      expect(card.waitingText.length * LABEL_CHAR, card.waitingText).toBeLessThanOrEqual(gateInner);
      for (const row of card.rows) expect(row.length * LABEL_CHAR, row).toBeLessThanOrEqual(gateInner);
      expect(card.rows, "says approvals happen in Claude Code").toEqual(["approve in Claude Code"]);
    }
    expect(globalGateCard(3).waitingText).toBe("3 waiting on you");
    expect(globalGateCard(0).waitingText).toBe("no approvals waiting");
    expect(globalGateCard(null).waitingText).toBe("—");
  });
});

describe("globalWalks: mission tokens from two consecutive /api/agents bodies", () => {
  const T0 = "2026-10-07T08:00:00.000Z";
  const T1 = "2026-10-07T08:00:02.500Z";
  const body = (generatedAt: string, active: AgentRun[], recent: AgentRun[] = [], queued: QueuedLaunch[] = []): AgentsResponse => ({ generatedAt, active, recent, limits: null, queued });
  const dev = pendingRun("BR-20261007-0011", "developer", { startedAt: "2026-10-07T08:00:01.000Z" });

  it("walks nothing on the first body", () => {
    expect(globalWalks(null, body(T1, [dev]))).toEqual([]);
  });
  it("walks a new run's mission from the core to its room's door, at once, as a one-shot token", () => {
    const got = globalWalks(body(T0, []), body(T1, [dev]));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: "arrive", taskId: "BR-20261007-0011", origin: "core", to: "developer", dest: "developer", label: "#0011", text: "#0011 ← Brain core", durationMs: 2400, d: globalWalkPath("core", "developer") });
  });
  it("walks it from the room of the same mission's latest other run that reported before it started", () => {
    const planner = { ...pendingRun("BR-20261007-0011", "planner"), status: "completed" as const, completedAt: "2026-10-07T07:59:00.000Z" };
    const qa = { ...pendingRun("BR-20261007-0011", "qa"), status: "completed" as const, completedAt: "2026-10-07T07:58:00.000Z" };
    const later = { ...pendingRun("BR-20261007-0011", "reviewer"), status: "completed" as const, completedAt: "2026-10-07T08:00:05.000Z" };
    const other = { ...pendingRun("BR-20261007-0099", "security-reviewer"), status: "completed" as const, completedAt: "2026-10-07T07:59:30.000Z" };
    const ownRole = { ...pendingRun("BR-20261007-0011", "developer"), status: "completed" as const, completedAt: "2026-10-07T07:59:50.000Z" };
    const got = globalWalks(body(T0, []), body(T1, [dev], [planner, qa, later, other, ownRole]));
    expect(got[0]).toMatchObject({ origin: "planner", to: "developer", d: globalWalkPath("planner", "developer"), text: "#0011 ← Planner" });
  });
  it("walks nothing for a stale run, a run that started long before, or a role outside the rooms", () => {
    expect(globalWalks(body(T0, []), body(T1, [{ ...dev, staleOverThreshold: true }]))).toEqual([]);
    expect(globalWalks(body(T0, []), body(T1, [{ ...dev, startedAt: "2026-10-07T07:58:59.000Z" }]))).toEqual([]);
    expect(globalWalks(body(T0, []), body(T1, [{ ...dev, startedAt: "2026-10-07T07:59:00.000Z" }]))).toHaveLength(1);
    expect(globalWalks(body(T0, []), body(T1, [{ ...dev, role: "auditor" }]))).toEqual([]);
  });
  it("walks nothing across a gap of more than 45 s, or when the bodies are out of order", () => {
    const late = new Date(Date.parse(T0) + WALK_GAP_MS + 1).toISOString();
    expect(globalWalks(body(T0, []), body(late, [{ ...dev, startedAt: late }]))).toEqual([]);
    expect(globalWalks(body(T1, []), body(T0, [dev]))).toEqual([]);
    expect(globalWalks(body(T0, []), body(T0, [dev]))).toEqual([]);
  });
  it("walks a run that reported from its room's door to the core; a run that merely vanished walks nowhere", () => {
    const done = { ...dev, status: "completed" as const, completedAt: "2026-10-07T08:00:02.000Z" };
    const got = globalWalks(body(T0, [dev]), body(T1, [], [done]));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: "report", origin: "developer", to: "core", d: globalWalkPath("developer", "core"), text: "#0011 → Brain core" });
    expect(globalWalks(body(T0, [dev]), body(T1, []))).toEqual([]);
    // a pending entry in recent is not a report
    expect(globalWalks(body(T0, [dev]), body(T1, [], [dev]))).toEqual([]);
    // a run still active walks nothing
    expect(globalWalks(body(T0, [dev]), body(T1, [dev]))).toEqual([]);
  });
  it("never walks a queued launch, appearing or disappearing", () => {
    const wait: QueuedLaunch = { taskId: "BR-20261007-0005", roles: ["qa"], deniedSeq: 5, deniedAt: T0, wait: null, overStaleThreshold: false };
    expect(globalWalks(body(T0, []), body(T1, [], [], [wait]))).toEqual([]);
    expect(globalWalks(body(T0, [], [], [wait]), body(T1, []))).toEqual([]);
  });
  it("walks at most four tokens at once", () => {
    const many = Array.from({ length: 6 }, (_, i) => pendingRun(`BR-20261007-002${i}`, "qa", { startedAt: "2026-10-07T08:00:01.000Z" }));
    expect(globalWalks(body(T0, []), body(T1, many))).toHaveLength(4);
  });
});
