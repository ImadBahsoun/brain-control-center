import { describe, expect, it } from "vitest";
import type { TaskSummary } from "@/lib/api-types";
import { TIMELINE } from "@/lib/lifecycle";
import { requestExpiry, type GateRequest } from "@/lib/ui/gate";
import {
  buildMissionStrip,
  classifyMission,
  freshFor,
  HOLD_MAX_POLLS,
  isDebrief,
  MISSION_STRIP_LIMIT,
  nextAutoFocus,
  olderPendingView,
  pinnedMission,
  RECENT_PENDING_WINDOW_MIN,
  RESERVATION_WINDOW_MIN,
  RUNNING_WINDOW_MIN,
  selectFocus,
  summaryPosition,
  type AutoFocus,
} from "@/lib/ui/mission";
import { freshHome, highRiskScript, mkdirs, standardScript, writeGovernor, writeScript } from "../helpers/fixture-store";
import { apiDetail, apiTasks } from "../helpers/ui-fixtures";

const NOW = "2026-10-12T14:20:00.000Z";

function minutesAgo(min: number): string {
  return new Date(Date.parse(NOW) - min * 60_000).toISOString();
}

/** A minimal, valid TaskSummary; only the fields a test cares about need overriding. */
function mkTask(overrides: Partial<TaskSummary> & Pick<TaskSummary, "id">): TaskSummary {
  return {
    title: null,
    classification: null,
    state: null,
    round: 0,
    maxRounds: 2,
    status: "ACTIVE",
    active: true,
    blocked: false,
    ready: false,
    waitingApproval: false,
    createdAt: null,
    updatedAt: null,
    lastEventAt: minutesAgo(5),
    eventCount: 1,
    findings: { total: 0, open: 0, openBySeverity: { BLOCKER: 0, MAJOR: 0, MINOR: 0, NIT: 0 } },
    topOpenFindings: [],
    pendingRuns: 0,
    summaryUnavailable: false,
    integrity: { log: "ok", chainChecked: false, cache: "fresh", logSeq: 1, cacheSeq: 1 },
    repository: null,
    parentTaskId: null,
    parentStepId: null,
    ...overrides,
  };
}

describe("selectFocus", () => {
  it("picks the active task with the newest event, honours a chosen id, and is null when idle", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    writeScript(home, "BR-20261007-0001", highRiskScript(home, { complete: true }));
    writeScript(home, "BR-20261007-0002", standardScript(home, { pendingDeveloper: true })); // 3 events
    writeScript(home, "BR-20261007-0003", highRiskScript(home, { stopAfter: 16 })); // 16 events: later lastEventAt
    const { tasks } = await apiTasks();
    expect(selectFocus(tasks, null)).toBe("BR-20261007-0003");
    expect(selectFocus(tasks, "BR-20261007-0002")).toBe("BR-20261007-0002");
    expect(selectFocus(tasks, "BR-20261007-0001")).toBe("BR-20261007-0001"); // a terminal mission may be chosen (debrief)
    expect(selectFocus(tasks, "BR-20261007-0099")).toBe("BR-20261007-0003"); // unknown choice falls back
    expect(selectFocus(null, null)).toBeNull();
    expect(selectFocus([], "BR-20261007-0001")).toBeNull();
  });
  it("is sticky: the previous auto focus stays while its mission is active, whatever the event order", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    writeScript(home, "BR-20261007-0002", standardScript(home, { pendingDeveloper: true }));
    writeScript(home, "BR-20261007-0003", highRiskScript(home, { stopAfter: 16 }));
    const { tasks } = await apiTasks();
    expect(selectFocus(tasks, null, { id: "BR-20261007-0002", active: true })).toBe("BR-20261007-0002");
    expect(selectFocus(tasks, null, { id: "BR-20261007-0003", active: true })).toBe("BR-20261007-0003");
    expect(selectFocus(tasks, "BR-20261007-0003", { id: "BR-20261007-0002", active: true })).toBe("BR-20261007-0003"); // a choice wins
    expect(selectFocus(tasks, null, { id: "BR-20261007-0099", active: true })).toBe("BR-20261007-0003"); // gone from the list
  });
  it("holds a just-completed mission for one more poll, then releases it", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    writeScript(home, "BR-20261007-0001", highRiskScript(home, { complete: true }));
    writeScript(home, "BR-20261007-0002", standardScript(home, { pendingDeveloper: true }));
    const { tasks } = await apiTasks();
    // it was active on the previous poll and is terminal now: kept once so READY / mission-complete can play
    expect(selectFocus(tasks, null, { id: "BR-20261007-0001", active: true })).toBe("BR-20261007-0001");
    // the page then records it as inactive; the next poll releases it to the active mission
    expect(selectFocus(tasks, null, { id: "BR-20261007-0001", active: false })).toBe("BR-20261007-0002");
    const onlyTerminal = tasks.filter((t) => !t.active);
    expect(selectFocus(onlyTerminal, null, { id: "BR-20261007-0001", active: false })).toBeNull();
  });
  it("is null when every task is terminal", async () => {
    const home = freshHome();
    mkdirs(home);
    writeScript(home, "BR-20261007-0001", highRiskScript(home, { complete: true }));
    writeScript(home, "BR-20261007-0002", standardScript(home, { cancelled: true }));
    const { tasks } = await apiTasks();
    expect(selectFocus(tasks, null)).toBeNull();
    expect(tasks.every(isDebrief)).toBe(true);
  });
});

describe("summaryPosition", () => {
  it("maps a recorded state to its timeline index without inferring earlier steps", () => {
    expect(summaryPosition("IMPLEMENTING")).toBe(TIMELINE.indexOf("IMPLEMENTING"));
    expect(summaryPosition("VALIDATING")).toBe(TIMELINE.indexOf("TESTING"));
    expect(summaryPosition("BLOCKED")).toBeNull();
    expect(summaryPosition(null)).toBeNull();
  });
});

describe("nextAutoFocus (the hold lasts until the terminal detail was shown, not one render)", () => {
  async function store() {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    writeScript(home, "BR-20261007-0001", highRiskScript(home, { stopAfter: 37 })); // READY, active
    const before = await apiTasks();
    const activeDetail = await apiDetail("BR-20261007-0001");
    writeScript(home, "BR-20261007-0001", highRiskScript(home, { complete: true }));
    writeScript(home, "BR-20261007-0002", standardScript(home, { pendingDeveloper: true }));
    const after = await apiTasks();
    const terminalDetail = await apiDetail("BR-20261007-0001");
    const summary = (t: typeof after, id: string) => t.tasks.find((x) => x.id === id) ?? null;
    return { before, after, activeDetail, terminalDetail, summary };
  }

  it("keeps an active auto focus active and forgets it when the user chooses or nothing is focused", async () => {
    const { before, summary } = await store();
    const s = summary(before, "BR-20261007-0001");
    expect(nextAutoFocus(null, { focusId: "BR-20261007-0001", chosenId: null, summary: s, detail: null, tasksStamp: "t1" })).toEqual({ id: "BR-20261007-0001", active: true });
    expect(nextAutoFocus(null, { focusId: "BR-20261007-0001", chosenId: "BR-20261007-0001", summary: s, detail: null, tasksStamp: "t1" })).toBeNull();
    expect(nextAutoFocus(null, { focusId: null, chosenId: null, summary: null, detail: null, tasksStamp: "t1" })).toBeNull();
  });

  // /api/tasks generatedAt values: one per poll
  const at = (ms: number) => new Date(Date.UTC(2026, 9, 7, 9, 0, 0) + ms).toISOString();

  it("holds a just-completed focus across renders until its terminal detail is seen, then releases on the next poll", async () => {
    const { after, activeDetail, terminalDetail, summary } = await store();
    const s = summary(after, "BR-20261007-0001");
    const id = "BR-20261007-0001";
    let auto: AutoFocus | null = { id, active: true };
    // poll at 0 ms: the summary is terminal, the detail on screen is still the active one
    auto = nextAutoFocus(auto, { focusId: id, chosenId: null, summary: s, detail: activeDetail, tasksStamp: at(0) });
    expect(auto?.active).toBe(true);
    // several renders of the same poll: still held (the old code released after one render)
    for (let i = 0; i < 5; i++) auto = nextAutoFocus(auto, { focusId: id, chosenId: null, summary: s, detail: activeDetail, tasksStamp: at(0) });
    expect(auto?.active).toBe(true);
    expect(selectFocus(after.tasks, null, auto)).toBe(id);
    // the terminal detail arrives within the same poll: still held, so the complete effect can play
    auto = nextAutoFocus(auto, { focusId: id, chosenId: null, summary: s, detail: terminalDetail, tasksStamp: at(0) });
    expect(auto).toMatchObject({ active: true, hold: { seen: true } });
    auto = nextAutoFocus(auto, { focusId: id, chosenId: null, summary: s, detail: terminalDetail, tasksStamp: at(0) });
    expect(auto?.active).toBe(true);
    // the next 2.5 s poll (another mission is still active) releases it to that mission
    auto = nextAutoFocus(auto, { focusId: id, chosenId: null, summary: s, detail: terminalDetail, tasksStamp: at(2500) });
    expect(auto).toEqual({ id, active: false });
    expect(selectFocus(after.tasks, null, auto)).toBe("BR-20261007-0002");
  });

  it("is not released by the immediate /api/tasks refetch when the cadence switches to 15 s, only by the next poll", async () => {
    const { after, activeDetail, terminalDetail, summary } = await store();
    const s = summary(after, "BR-20261007-0001");
    const id = "BR-20261007-0001";
    let auto: AutoFocus | null = nextAutoFocus({ id, active: true }, { focusId: id, chosenId: null, summary: s, detail: activeDetail, tasksStamp: at(0) });
    auto = nextAutoFocus(auto, { focusId: id, chosenId: null, summary: s, detail: terminalDetail, tasksStamp: at(0) });
    // the last active mission ended: useCadence switches 2.5 s → 15 s and usePoll refetches /api/tasks at once
    auto = nextAutoFocus(auto, { focusId: id, chosenId: null, summary: s, detail: terminalDetail, tasksStamp: at(55) });
    expect(auto?.active).toBe(true);
    for (let i = 0; i < 5; i++) auto = nextAutoFocus(auto, { focusId: id, chosenId: null, summary: s, detail: terminalDetail, tasksStamp: at(55) });
    expect(auto?.active).toBe(true);
    expect(selectFocus(after.tasks.filter((t) => !t.active || t.id === id), null, auto)).toBe(id);
    // the next poll, 15 s later, releases it
    auto = nextAutoFocus(auto, { focusId: id, chosenId: null, summary: s, detail: terminalDetail, tasksStamp: at(15_055) });
    expect(auto).toEqual({ id, active: false });
  });

  it("measures the release from the poll the terminal detail was seen at", async () => {
    const { after, activeDetail, terminalDetail, summary } = await store();
    const s = summary(after, "BR-20261007-0001");
    const id = "BR-20261007-0001";
    let auto: AutoFocus | null = nextAutoFocus({ id, active: true }, { focusId: id, chosenId: null, summary: s, detail: activeDetail, tasksStamp: at(0) });
    auto = nextAutoFocus(auto, { focusId: id, chosenId: null, summary: s, detail: activeDetail, tasksStamp: at(40) }); // refetch, detail not yet in
    auto = nextAutoFocus(auto, { focusId: id, chosenId: null, summary: s, detail: terminalDetail, tasksStamp: at(40) }); // seen at 40 ms
    auto = nextAutoFocus(auto, { focusId: id, chosenId: null, summary: s, detail: terminalDetail, tasksStamp: at(1500) });
    expect(auto?.active).toBe(true); // under HOLD_MIN_MS after the poll it was seen at
    auto = nextAutoFocus(auto, { focusId: id, chosenId: null, summary: s, detail: terminalDetail, tasksStamp: at(2540) });
    expect(auto).toEqual({ id, active: false });
  });

  it("releases after HOLD_MAX_POLLS distinct polls when the terminal detail never arrives", async () => {
    const { after, activeDetail, summary } = await store();
    const s = summary(after, "BR-20261007-0001");
    const id = "BR-20261007-0001";
    let auto: AutoFocus | null = nextAutoFocus({ id, active: true }, { focusId: id, chosenId: null, summary: s, detail: null, tasksStamp: at(0) });
    for (let i = 1; i < HOLD_MAX_POLLS; i++) {
      auto = nextAutoFocus(auto, { focusId: id, chosenId: null, summary: s, detail: activeDetail, tasksStamp: at(i * 15_000) });
      expect(auto?.active, `poll ${i}`).toBe(true);
    }
    auto = nextAutoFocus(auto, { focusId: id, chosenId: null, summary: s, detail: activeDetail, tasksStamp: at(HOLD_MAX_POLLS * 15_000) });
    expect(auto).toEqual({ id, active: false });
  });

  it("does not hold a terminal focus that was not active before", async () => {
    const { after, terminalDetail, summary } = await store();
    const s = summary(after, "BR-20261007-0001");
    expect(nextAutoFocus({ id: "BR-20261007-0001", active: false }, { focusId: "BR-20261007-0001", chosenId: null, summary: s, detail: terminalDetail, tasksStamp: "t9" })).toEqual({ id: "BR-20261007-0001", active: false });
    expect(nextAutoFocus({ id: "BR-20261007-0002", active: true }, { focusId: "BR-20261007-0001", chosenId: null, summary: s, detail: terminalDetail, tasksStamp: "t9" })).toEqual({ id: "BR-20261007-0001", active: false });
  });
});

describe("freshFor", () => {
  it("counts data only when it is another object than the one held at the focus change, and only when it matches", () => {
    const old = { taskId: "A", n: 1 };
    const next = { taskId: "A", n: 1 };
    const matchesA = (d: { taskId: string }) => d.taskId === "A";
    expect(freshFor(old, old, matchesA)).toBeNull(); // the slot's old body for this URL
    expect(freshFor(next, old, matchesA)).toBe(next); // a refetch, even with an equal body
    expect(freshFor(next, null, matchesA)).toBe(next);
    expect(freshFor({ taskId: "B", n: 1 }, null, matchesA)).toBeNull();
    expect(freshFor<{ taskId: string }>(null, null, matchesA)).toBeNull();
  });
});

describe("classifyMission", () => {
  it("is running: ACTIVE, not ready, recent lastEventAt, no reservation needed", () => {
    const t = mkTask({ id: "A", status: "ACTIVE", ready: false, pendingRuns: 0, lastEventAt: minutesAgo(5) });
    expect(classifyMission(t, NOW)).toBe("running");
  });
  it("is running exactly at the RUNNING_WINDOW_MIN boundary (inclusive)", () => {
    const t = mkTask({ id: "A", status: "ACTIVE", ready: false, pendingRuns: 0, lastEventAt: minutesAgo(RUNNING_WINDOW_MIN) });
    expect(classifyMission(t, NOW)).toBe("running");
  });
  it("is open just past the RUNNING_WINDOW_MIN boundary with no pending reservation", () => {
    const t = mkTask({ id: "A", status: "ACTIVE", ready: false, pendingRuns: 0, lastEventAt: minutesAgo(RUNNING_WINDOW_MIN + 1) });
    expect(classifyMission(t, NOW)).toBe("open");
  });
  it("is running past the running window when a reservation is pending, up to and including RESERVATION_WINDOW_MIN", () => {
    const t = mkTask({ id: "A", status: "ACTIVE", ready: false, pendingRuns: 1, lastEventAt: minutesAgo(RESERVATION_WINDOW_MIN) });
    expect(classifyMission(t, NOW)).toBe("running");
  });
  it("is open past RESERVATION_WINDOW_MIN even with a pending reservation (a stale/abandoned reservation)", () => {
    const t = mkTask({ id: "A", status: "ACTIVE", ready: false, pendingRuns: 1, lastEventAt: minutesAgo(3 * 24 * 60) });
    expect(classifyMission(t, NOW)).toBe("open");
  });
  it("READY (ACTIVE, ready, recent) is open: a reservation/activity window never applies once ready", () => {
    const t = mkTask({ id: "A", status: "ACTIVE", ready: true, pendingRuns: 1, lastEventAt: minutesAgo(1) });
    expect(classifyMission(t, NOW)).toBe("open");
  });
  it("BLOCKED is open", () => {
    const t = mkTask({ id: "A", status: "BLOCKED", lastEventAt: minutesAgo(1) });
    expect(classifyMission(t, NOW)).toBe("open");
  });
  it("WAITING is awaiting approval at any age, never hidden by age", () => {
    const t = mkTask({ id: "A", status: "WAITING", waitingApproval: true, lastEventAt: minutesAgo(3 * 24 * 60) });
    expect(classifyMission(t, NOW)).toBe("awaiting");
  });
  it("COMPLETE / CANCELLED are closed", () => {
    expect(classifyMission(mkTask({ id: "A", status: "COMPLETE", active: false, lastEventAt: minutesAgo(1) }), NOW)).toBe("closed");
    expect(classifyMission(mkTask({ id: "B", status: "CANCELLED", active: false, lastEventAt: minutesAgo(1) }), NOW)).toBe("closed");
  });
  it("CORRUPT / INCOMPLETE are open: non-terminal per isTerminalStatus, and neither ACTIVE nor WAITING", () => {
    expect(classifyMission(mkTask({ id: "A", status: "CORRUPT", active: false, lastEventAt: minutesAgo(1) }), NOW)).toBe("open");
    expect(classifyMission(mkTask({ id: "B", status: "INCOMPLETE", active: false, lastEventAt: minutesAgo(1) }), NOW)).toBe("open");
  });
  it("a missing lastEventAt never counts as recent: ACTIVE falls back to open", () => {
    const t = mkTask({ id: "A", status: "ACTIVE", ready: false, pendingRuns: 1, lastEventAt: null });
    expect(classifyMission(t, NOW)).toBe("open");
  });
  it("a missing now never counts as recent either", () => {
    const t = mkTask({ id: "A", status: "ACTIVE", ready: false, lastEventAt: minutesAgo(1) });
    expect(classifyMission(t, null)).toBe("open");
  });
});

describe("buildMissionStrip", () => {
  it("orders live missions awaiting-first then running, newest lastEventAt first within each, and counts open separately", () => {
    const waitingOld = mkTask({ id: "W-OLD", status: "WAITING", waitingApproval: true, lastEventAt: minutesAgo(3 * 60) }); // older than waitingNew, but within RECENT_PENDING_WINDOW_MIN: still live
    const waitingNew = mkTask({ id: "W-NEW", status: "WAITING", waitingApproval: true, lastEventAt: minutesAgo(10) });
    const runningOld = mkTask({ id: "R-OLD", status: "ACTIVE", lastEventAt: minutesAgo(50) });
    const runningNew = mkTask({ id: "R-NEW", status: "ACTIVE", lastEventAt: minutesAgo(1) });
    const ready = mkTask({ id: "READY", status: "ACTIVE", ready: true, lastEventAt: minutesAgo(1) });
    const blocked = mkTask({ id: "BLOCKED", status: "BLOCKED", lastEventAt: minutesAgo(1) });
    const closed = mkTask({ id: "DONE", status: "COMPLETE", active: false, lastEventAt: minutesAgo(1) });
    const strip = buildMissionStrip([runningOld, waitingOld, ready, runningNew, waitingNew, blocked, closed], NOW);
    expect(strip.live.map((t) => t.id)).toEqual(["W-NEW", "W-OLD", "R-NEW", "R-OLD"]);
    expect(strip.liveCount).toBe(4);
    expect(strip.openCount).toBe(2); // READY and BLOCKED; the closed mission is ignored entirely
    expect(strip.moreCount).toBe(0);
  });
  it("caps the live chips at MISSION_STRIP_LIMIT and counts the rest as moreCount", () => {
    const tasks = Array.from({ length: MISSION_STRIP_LIMIT + 3 }, (_, i) => mkTask({ id: `R${i}`, status: "ACTIVE", lastEventAt: minutesAgo(i) }));
    const strip = buildMissionStrip(tasks, NOW);
    expect(strip.live).toHaveLength(MISSION_STRIP_LIMIT);
    expect(strip.liveCount).toBe(tasks.length);
    expect(strip.moreCount).toBe(3);
  });

  describe("older pending (RECENT_PENDING_WINDOW_MIN boundary)", () => {
    it("a WAITING mission 23h old is recent: in live, not in olderPending", () => {
      const t = mkTask({ id: "W23", status: "WAITING", waitingApproval: true, lastEventAt: minutesAgo(23 * 60) });
      const strip = buildMissionStrip([t], NOW);
      expect(strip.live.map((x) => x.id)).toEqual(["W23"]);
      expect(strip.olderPending).toHaveLength(0);
      expect(strip.olderPendingCount).toBe(0);
    });
    it("a WAITING mission exactly RECENT_PENDING_WINDOW_MIN (24h) old counts as recent (inclusive)", () => {
      const t = mkTask({ id: "W24", status: "WAITING", waitingApproval: true, lastEventAt: minutesAgo(RECENT_PENDING_WINDOW_MIN) });
      const strip = buildMissionStrip([t], NOW);
      expect(strip.live.map((x) => x.id)).toEqual(["W24"]);
      expect(strip.olderPendingCount).toBe(0);
    });
    it("a WAITING mission 25h old is older pending, not in live", () => {
      const t = mkTask({ id: "W25", status: "WAITING", waitingApproval: true, lastEventAt: minutesAgo(25 * 60) });
      const strip = buildMissionStrip([t], NOW);
      expect(strip.live).toHaveLength(0);
      expect(strip.olderPending.map((x) => x.id)).toEqual(["W25"]);
      expect(strip.olderPendingCount).toBe(1);
    });
    it("a WAITING mission with missing or unparseable lastEventAt is older pending (recency cannot be proven)", () => {
      const missing = mkTask({ id: "W-MISSING", status: "WAITING", waitingApproval: true, lastEventAt: null });
      const bad = mkTask({ id: "W-BAD", status: "WAITING", waitingApproval: true, lastEventAt: "not-a-date" });
      const strip = buildMissionStrip([missing, bad], NOW);
      expect(strip.live).toHaveLength(0);
      expect(strip.olderPending.map((x) => x.id).sort()).toEqual(["W-BAD", "W-MISSING"]);
    });
    it("running missions are unaffected by the window, and READY/BLOCKED (open) never appear in olderPending", () => {
      const running = mkTask({ id: "RUN", status: "ACTIVE", lastEventAt: minutesAgo(5) });
      const ready = mkTask({ id: "READY", status: "ACTIVE", ready: true, lastEventAt: minutesAgo(3 * 24 * 60) });
      const blocked = mkTask({ id: "BLOCKED", status: "BLOCKED", lastEventAt: minutesAgo(3 * 24 * 60) });
      const waitingOld = mkTask({ id: "W-OLD", status: "WAITING", waitingApproval: true, lastEventAt: minutesAgo(25 * 60) });
      const strip = buildMissionStrip([running, ready, blocked, waitingOld], NOW);
      expect(strip.live.map((x) => x.id)).toEqual(["RUN"]);
      expect(strip.olderPending.map((x) => x.id)).toEqual(["W-OLD"]);
      expect(strip.openCount).toBe(2);
    });
    it("olderPending is newest first and uncapped", () => {
      const a = mkTask({ id: "A", status: "WAITING", waitingApproval: true, lastEventAt: minutesAgo(25 * 60) });
      const b = mkTask({ id: "B", status: "WAITING", waitingApproval: true, lastEventAt: minutesAgo(3 * 24 * 60) });
      const c = mkTask({ id: "C", status: "WAITING", waitingApproval: true, lastEventAt: minutesAgo(10 * 24 * 60) });
      const strip = buildMissionStrip([c, a, b], NOW);
      expect(strip.olderPending.map((x) => x.id)).toEqual(["A", "B", "C"]);
    });
    it("liveCount and openCount equal their previous values: liveCount counts all running + awaiting of any age", () => {
      const waitingRecent = mkTask({ id: "W-NEW", status: "WAITING", waitingApproval: true, lastEventAt: minutesAgo(10) });
      const waitingOld = mkTask({ id: "W-OLD", status: "WAITING", waitingApproval: true, lastEventAt: minutesAgo(3 * 24 * 60) });
      const running = mkTask({ id: "RUN", status: "ACTIVE", lastEventAt: minutesAgo(1) });
      const ready = mkTask({ id: "READY", status: "ACTIVE", ready: true, lastEventAt: minutesAgo(1) });
      const strip = buildMissionStrip([waitingRecent, waitingOld, running, ready], NOW);
      expect(strip.liveCount).toBe(3); // 2 awaiting (any age) + 1 running
      expect(strip.openCount).toBe(1);
    });
  });
});

describe("pinnedMission", () => {
  const live = mkTask({ id: "LIVE", status: "WAITING", waitingApproval: true, lastEventAt: minutesAgo(10) });
  const olderPending = mkTask({ id: "OLDER", status: "WAITING", waitingApproval: true, lastEventAt: minutesAgo(25 * 60) });
  const open = mkTask({ id: "OPEN", status: "BLOCKED", lastEventAt: minutesAgo(1) });
  const closed = mkTask({ id: "CLOSED", status: "COMPLETE", active: false, lastEventAt: minutesAgo(1) });
  const tasks = [live, olderPending, open, closed];
  const strip = buildMissionStrip(tasks, NOW);

  it("is null when selectedId is null", () => {
    expect(pinnedMission(strip, tasks, null)).toBeNull();
  });
  it("is null when the selected mission is already in strip.live", () => {
    expect(pinnedMission(strip, tasks, "LIVE")).toBeNull();
  });
  it("returns the mission when it is older pending", () => {
    expect(pinnedMission(strip, tasks, "OLDER")).toEqual(olderPending);
  });
  it("returns the mission when it is open", () => {
    expect(pinnedMission(strip, tasks, "OPEN")).toEqual(open);
  });
  it("returns the mission when it is closed", () => {
    expect(pinnedMission(strip, tasks, "CLOSED")).toEqual(closed);
  });
  it("is null when selectedId is not found in tasks at all", () => {
    expect(pinnedMission(strip, tasks, "UNKNOWN")).toBeNull();
  });
});

describe("olderPendingView", () => {
  const olderA = mkTask({ id: "OLDER-A", status: "WAITING", waitingApproval: true, lastEventAt: minutesAgo(25 * 60) });
  const olderB = mkTask({ id: "OLDER-B", status: "WAITING", waitingApproval: true, lastEventAt: minutesAgo(3 * 24 * 60) });
  const open = mkTask({ id: "OPEN", status: "BLOCKED", lastEventAt: minutesAgo(1) });
  const closed = mkTask({ id: "CLOSED", status: "COMPLETE", active: false, lastEventAt: minutesAgo(1) });
  const tasks = [olderA, olderB, open, closed];
  const strip = buildMissionStrip(tasks, NOW);

  it("collapsed: the pinned chip always shows the selected mission, and expandedList is the full list regardless", () => {
    expect(olderPendingView(strip, olderA, false)).toEqual({ pinnedChip: olderA, expandedList: [olderA, olderB] });
    expect(olderPendingView(strip, open, false)).toEqual({ pinnedChip: open, expandedList: [olderA, olderB] });
    expect(olderPendingView(strip, null, false)).toEqual({ pinnedChip: null, expandedList: [olderA, olderB] });
  });
  it("expanded and the selected mission is older pending: no standalone pinned chip, but it stays in expandedList", () => {
    const view = olderPendingView(strip, olderA, true);
    expect(view.pinnedChip).toBeNull();
    expect(view.expandedList).toEqual([olderA, olderB]); // never filtered out: the caller marks it active instead
  });
  it("expanded and the selected mission is open or closed (not older pending): the pinned chip is unchanged", () => {
    expect(olderPendingView(strip, open, true)).toEqual({ pinnedChip: open, expandedList: [olderA, olderB] });
    expect(olderPendingView(strip, closed, true)).toEqual({ pinnedChip: closed, expandedList: [olderA, olderB] });
  });
  it("expanded with no selection: no pinned chip, full expandedList", () => {
    expect(olderPendingView(strip, null, true)).toEqual({ pinnedChip: null, expandedList: [olderA, olderB] });
  });
});

describe("selectFocus with now: Auto Focus prefers genuinely live missions", () => {
  it("prefers a running mission over a newer open (READY) mission", () => {
    const running = mkTask({ id: "RUN", status: "ACTIVE", lastEventAt: minutesAgo(10) });
    const openNewer = mkTask({ id: "OPEN", status: "ACTIVE", ready: true, lastEventAt: minutesAgo(1) });
    expect(selectFocus([running, openNewer], null, null, NOW)).toBe("RUN");
  });
  it("prefers a running mission over an awaiting-approval one", () => {
    const running = mkTask({ id: "RUN", status: "ACTIVE", lastEventAt: minutesAgo(10) });
    const waiting = mkTask({ id: "WAIT", status: "WAITING", waitingApproval: true, lastEventAt: minutesAgo(1) });
    expect(selectFocus([running, waiting], null, null, NOW)).toBe("RUN");
  });
  it("falls back to the newest awaiting-approval mission when nothing is running", () => {
    const waitingOld = mkTask({ id: "W-OLD", status: "WAITING", waitingApproval: true, lastEventAt: minutesAgo(50) });
    const waitingNew = mkTask({ id: "W-NEW", status: "WAITING", waitingApproval: true, lastEventAt: minutesAgo(1) });
    expect(selectFocus([waitingOld, waitingNew], null, null, NOW)).toBe("W-NEW");
  });
  it("releases a sticky non-live previous focus once a live mission exists", () => {
    const openPrev = mkTask({ id: "PREV", status: "ACTIVE", ready: true, lastEventAt: minutesAgo(5) }); // READY: open, not live
    const running = mkTask({ id: "RUN", status: "ACTIVE", lastEventAt: minutesAgo(1) });
    expect(selectFocus([openPrev, running], null, { id: "PREV", active: true }, NOW)).toBe("RUN");
  });
  it("keeps a non-live previous focus when nothing is live", () => {
    const openPrev = mkTask({ id: "PREV", status: "ACTIVE", ready: true, lastEventAt: minutesAgo(5) }); // READY: open, not live
    const otherOpen = mkTask({ id: "OTHER", status: "BLOCKED", lastEventAt: minutesAgo(1) });
    expect(selectFocus([openPrev, otherOpen], null, { id: "PREV", active: true }, NOW)).toBe("PREV");
  });
  it("keeps the previous auto focus while it is still live itself", () => {
    const running1 = mkTask({ id: "RUN1", status: "ACTIVE", lastEventAt: minutesAgo(30) });
    const running2 = mkTask({ id: "RUN2", status: "ACTIVE", lastEventAt: minutesAgo(1) }); // newer, but not the sticky one
    expect(selectFocus([running1, running2], null, { id: "RUN1", active: true }, NOW)).toBe("RUN1");
  });
  it("keeps the terminal hold (nextAutoFocus's hold) even though a different mission is genuinely live", () => {
    const terminal = mkTask({ id: "PREV", status: "COMPLETE", active: false, lastEventAt: minutesAgo(1) });
    const running = mkTask({ id: "RUN", status: "ACTIVE", lastEventAt: minutesAgo(1) });
    const held: AutoFocus = { id: "PREV", active: true, hold: { seen: true, stamp: NOW, last: NOW, polls: 1 } };
    expect(selectFocus([terminal, running], null, held, NOW)).toBe("PREV");
  });
  it("honours a chosenId, including a chosen mission that is not live", () => {
    const running = mkTask({ id: "RUN", status: "ACTIVE", lastEventAt: minutesAgo(1) });
    const openChosen = mkTask({ id: "CHOSEN", status: "BLOCKED", lastEventAt: minutesAgo(5) });
    expect(selectFocus([running, openChosen], "CHOSEN", null, NOW)).toBe("CHOSEN");
  });
  it("without now, behaves exactly as the pre-existing algorithm (today's fallback)", () => {
    const running = mkTask({ id: "RUN", status: "ACTIVE", lastEventAt: minutesAgo(30) });
    const openNewer = mkTask({ id: "OPEN", status: "ACTIVE", ready: true, lastEventAt: minutesAgo(1) });
    // the legacy algorithm has no liveness concept: it just picks the newest t.active mission
    expect(selectFocus([running, openNewer], null, null)).toBe("OPEN");
  });
});

describe("requestExpiry: what the Commander Gate callout can honestly say about an approval's age", () => {
  function mkRequest(overrides: Partial<GateRequest>): GateRequest {
    return { seq: 1, ts: minutesAgo(10), kind: "plan", text: "Approval requested (plan)", detail: null, expires: null, source: "test", ...overrides };
  }
  it("is null without a request", () => {
    expect(requestExpiry(null, NOW)).toBeNull();
  });
  it("reports expired when the request's own expires (ISO) is before now", () => {
    const r = mkRequest({ expires: minutesAgo(1) });
    expect(requestExpiry(r, NOW)).toEqual({ kind: "expired" });
  });
  it("says nothing when the request's own expires is still in the future", () => {
    const r = mkRequest({ expires: new Date(Date.parse(NOW) + 60_000).toISOString() });
    expect(requestExpiry(r, NOW)).toBeNull();
  });
  it("never claims expired without a timestamp: a gate-kind request with no expires gets only a neutral age hint", () => {
    const r = mkRequest({ kind: "gate", expires: null });
    expect(requestExpiry(r, NOW)).toEqual({ kind: "maybe-expired" });
  });
  it("a non-gate request with no expires gets no hint at all (nothing proves it either way)", () => {
    const r = mkRequest({ kind: "release", expires: null });
    expect(requestExpiry(r, NOW)).toBeNull();
  });
});
