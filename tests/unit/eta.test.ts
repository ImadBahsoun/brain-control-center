// The mission ETA (src/lib/eta.ts). The spec is the "ETA" section of ~/.claude/skills/orchestration/governor.md;
// ~/.claude/brain/governor-tests/test_eta.py mirrors these cases with the same numbers.
import { describe, expect, it } from "vitest";
import { estimateEta, formatElapsed, historyFromRuns, type EtaEvent, type EtaInput, type EtaRun, type HistoryRun } from "@/lib/eta";

const T0 = Date.UTC(2026, 9, 8, 8, 0, 0);
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

function input(over: Partial<EtaInput> = {}): EtaInput {
  return {
    status: "ACTIVE",
    state: "CLASSIFYING",
    classification: "STANDARD",
    round: 0,
    roundEpoch: 0,
    createdAt: at(0),
    lastEventAt: at(0),
    qaTriggers: false,
    securityTriggers: false,
    runsKnown: true,
    runs: [],
    events: [{ seq: 1, type: "TASK_CREATED", state: "CLASSIFYING", payload: {} }],
    concurrencyDeniedSeq: 0,
    history: {},
    nowMs: T0,
    ...over,
  };
}

/** A run from `start` to `end` minutes (null: pending). */
function run(role: string, start: number, end: number | null, over: Partial<EtaRun> = {}): EtaRun {
  return { role, round: 0, epoch: 0, status: end === null ? "pending" : "completed", startedAt: at(start), completedAt: end === null ? null : at(end), ...over };
}

function ev(seq: number, type: string, state: string | null, payload: Record<string, unknown> = {}): EtaEvent {
  return { seq, type, state, payload };
}

const span = (i: EtaInput) => {
  const e = estimateEta(i);
  return [e.kind, e.low, e.high];
};

describe("estimateEta (an estimate computed on read)", () => {
  it("fresh STANDARD", () => {
    const e = estimateEta(input());
    expect([e.kind, e.low, e.high, e.basis, e.label, e.note]).toEqual(["estimate", 10, 29, "fallback", "ETA ~10–29 min", "estimate, not a guarantee"]);
    expect(e.stages.map((s) => s.name)).toEqual(["developer", "validation", "synthesis"]);
    expect(e.stages[1]?.roles).toEqual(["reviewer"]);
  });

  it("fresh COMPLEX", () => {
    const e = estimateEta(input({ classification: "COMPLEX" }));
    expect([e.kind, e.low, e.high]).toEqual(["estimate", 12, 36]);
    expect(e.stages.map((s) => s.name)).toEqual(["planner", "developer", "validation", "synthesis"]);
    expect(e.stages[2]?.roles).toEqual(["qa", "reviewer"]);
  });

  it("HIGH-RISK includes security", () => {
    const e = estimateEta(input({ classification: "HIGH-RISK" }));
    expect([e.kind, e.low, e.high]).toEqual(["estimate", 12, 36]);
    expect(e.stages[2]?.roles).toContain("security-reviewer");
    const waiting = estimateEta(input({ classification: "HIGH-RISK", state: "WAITING_FOR_APPROVAL" }));
    expect([waiting.kind, waiting.low, waiting.high, waiting.label]).toEqual(["paused", null, null, "ETA paused — waiting for approval"]);
  });

  it("parallel validators use the longest branch", () => {
    const runs = [run("planner", 0, 2), run("developer", 2, 10), run("qa", 10, null), run("reviewer", 10, null), run("security-reviewer", 10, null)];
    const e = estimateEta(input({ classification: "HIGH-RISK", state: "VALIDATING", runs, nowMs: T0 + 10 * 60_000 }));
    expect([e.kind, e.low, e.high]).toEqual(["estimate", 5, 16]); // a sum would be 11–32
    expect(e.stages.map((s) => [s.name, s.status])).toEqual([["validation", "running"], ["synthesis", "queued"]]);
  });

  it("decreases after the developer completes", () => {
    expect(span(input())).toEqual(["estimate", 10, 29]);
    const min = (n: number) => T0 + n * 60_000;
    expect(span(input({ state: "IMPLEMENTING", runs: [run("developer", 0, null)], nowMs: min(6) }))).toEqual(["estimate", 5, 23]);
    expect(span(input({ state: "IMPLEMENTING", runs: [run("developer", 0, 7)], nowMs: min(7) }))).toEqual(["estimate", 5, 14]);
    expect(span(input({ state: "VALIDATING", runs: [run("developer", 0, 7)], nowMs: min(7) }))).toEqual(["estimate", 5, 14]);
    // an overrun keeps a quarter of the band: reviewer [0, ceil(8/4)] + synthesis [2, 6]
    expect(span(input({ state: "VALIDATING", runs: [run("developer", 0, 7), run("reviewer", 67, null)], nowMs: min(127) }))).toEqual(["estimate", 2, 8]);
  });

  it("re-estimates a fix round from the developer stage", () => {
    const runs = [run("developer", 0, 7), run("reviewer", 7, 12)];
    expect(span(input({ state: "SYNTHESIZING", runs }))).toEqual(["estimate", 2, 6]);
    expect(span(input({ state: "FIXING", round: 1, runs }))).toEqual(["estimate", 10, 29]);
  });

  it("a scope change in round 0 re-queues the developer and validation (new round epoch)", () => {
    // F-001: PLAN_APPROVED scope_change resets the round to 0 in epoch 1; the epoch-0 runs are not done
    const runs = [run("planner", 0, 2), run("developer", 2, 10), run("qa", 10, 15), run("reviewer", 10, 14)];
    const e = estimateEta(input({ classification: "COMPLEX", state: "IMPLEMENTING", round: 0, roundEpoch: 1, runs, nowMs: T0 + 20 * 60_000 }));
    expect([e.kind, e.low, e.high, e.label]).toEqual(["estimate", 10, 31, "ETA ~10–31 min"]);
    expect(e.stages.map((s) => [s.name, s.status])).toEqual([["developer", "queued"], ["validation", "queued"], ["synthesis", "queued"]]);
    // in the same epoch those runs are done
    expect(span(input({ classification: "COMPLEX", state: "IMPLEMENTING", runs, nowMs: T0 + 20 * 60_000 }))).toEqual(["estimate", 2, 6]);
  });

  it("STANDARD with qa_triggers validates with qa", () => {
    const e = estimateEta(input({ qaTriggers: true }));
    expect([e.low, e.high, e.stages[1]?.roles]).toEqual([10, 31, ["qa", "reviewer"]]);
  });

  it("SMALL with security_triggers adds the security reviewer", () => {
    const e = estimateEta(input({ classification: "SMALL", securityTriggers: true }));
    expect([e.low, e.high, e.stages[0]?.roles]).toEqual([5, 14, ["reviewer", "security-reviewer"]]);
  });

  it("gives no number when the runs are unknown (dashboard-only rule)", () => {
    const e = estimateEta(input({ runsKnown: false, state: "IMPLEMENTING", runs: [] }));
    expect([e.kind, e.low, e.high, e.label, e.reason]).toEqual(["calculating", null, null, "ETA calculating…", "state.json not usable; runs unknown"]);
    // a terminal task still reports its total
    expect(estimateEta(input({ runsKnown: false, status: "COMPLETE", state: "COMPLETE", lastEventAt: at(31) })).reason).toBe("COMPLETE · 31m total");
  });

  it("treats states and agent names that look like Object.prototype keys as plain data", () => {
    // F-004: own-key lookups only
    for (const state of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(() => estimateEta(input({ state })), state).not.toThrow();
      expect(estimateEta(input({ state })).label, state).toBe("ETA calculating…");
    }
    const odd: HistoryRun[] = ["constructor", "toString", "__proto__"].map((role) => ({ role, status: "completed", completedAt: at(1), durationMs: 60_000 }));
    let h: ReturnType<typeof historyFromRuns> = {};
    expect(() => (h = historyFromRuns([odd]))).not.toThrow();
    expect(Object.keys(h).sort()).toEqual(["__proto__", "constructor", "toString"]);
    expect(Object.hasOwn(h, "constructor") ? h.constructor : null).toEqual([1]);
    expect(span(input({ history: h }))).toEqual(["estimate", 10, 29]);
  });

  it("paused during approval", () => {
    const requested = [ev(1, "TASK_CREATED", "CLASSIFYING"), ev(2, "APPROVAL_REQUESTED", "CLASSIFYING")];
    expect(estimateEta(input({ events: requested })).label).toBe("ETA paused — waiting for approval");
    expect(span(input({ events: [...requested, ev(3, "APPROVAL_GRANTED", "CLASSIFYING")] }))).toEqual(["estimate", 10, 29]);
    expect(span(input({ events: [...requested, ev(3, "AGENT_STARTED", "IMPLEMENTING")], state: "IMPLEMENTING" }))).toEqual(["estimate", 10, 29]);
    expect(estimateEta(input({ state: "HUMAN_APPROVAL" })).kind).toBe("paused");
    const ready = estimateEta(input({ state: "READY" })); // the work is done: not paused
    expect([ready.kind, ready.label, ready.low]).toEqual(["complete", "ETA complete", null]);
  });

  it("blocked after a CONCURRENCY denial, cleared by a later start", () => {
    const base = [ev(1, "TASK_CREATED", "CLASSIFYING"), ev(2, "NOTE", "CLASSIFYING", { text: "[governor] DENIED CONCURRENCY reviewer: global total 7/6" })];
    const e = estimateEta(input({ classification: "SMALL", events: base, concurrencyDeniedSeq: 2 }));
    expect([e.kind, e.low, e.label]).toEqual(["blocked", null, "ETA blocked — waiting for available agent"]);
    expect(estimateEta(input({ classification: "SMALL", events: [...base, ev(3, "NOTE", "CLASSIFYING", { text: "still waiting" })], concurrencyDeniedSeq: 2 })).kind).toBe("blocked");
    const started = [...base, ev(3, "AGENT_STARTED", "CLASSIFYING")];
    expect(span(input({ classification: "SMALL", events: started, concurrencyDeniedSeq: 2, runs: [run("reviewer", 0, null)] }))).toEqual(["estimate", 5, 14]);
    expect(estimateEta(input({ classification: "SMALL", events: [...base, ev(3, "STATE_CHANGED", "VALIDATING")], concurrencyDeniedSeq: 2 })).kind).toBe("estimate");
  });

  it("unknown at round cap", () => {
    const e = estimateEta(input({ state: "ROUND_CAP_REACHED", status: "BLOCKED" }));
    expect([e.kind, e.low, e.high, e.label]).toEqual(["unknown", null, null, "ETA unknown — round cap reached"]);
    // BLOCKED right after ROUND_CAP_REACHED, or with a round-cap reason (any case), is unknown too
    const afterCap = [ev(1, "TASK_CREATED", "CLASSIFYING"), ev(2, "STATE_CHANGED", "ROUND_CAP_REACHED"), ev(3, "BLOCKED", "BLOCKED", { reason: "the user decides" })];
    expect(estimateEta(input({ state: "BLOCKED", status: "BLOCKED", events: afterCap })).label).toBe("ETA unknown — round cap reached");
    for (const reason of ["ROUND_CAP after round 2", "Round Cap reached at round 2"]) {
      const events = [ev(1, "TASK_CREATED", "CLASSIFYING"), ev(2, "BLOCKED", "CLASSIFYING", { reason })];
      expect(estimateEta(input({ state: "BLOCKED", status: "BLOCKED", events })).label, reason).toBe("ETA unknown — round cap reached");
    }
    const other = estimateEta(input({ state: "BLOCKED", status: "BLOCKED", events: [ev(1, "TASK_CREATED", "CLASSIFYING"), ev(2, "BLOCKED", "CLASSIFYING", { reason: "needs credentials" })] }));
    expect([other.kind, other.low, other.label]).toEqual(["paused", null, "ETA paused — task blocked"]);
  });

  it("history improves the estimate", () => {
    const dev40 = (): HistoryRun[] => [{ role: "developer", status: "completed", completedAt: at(40), durationMs: 40 * 60_000 }];
    const e = estimateEta(input({ history: historyFromRuns([dev40(), dev40(), dev40()]) }));
    expect([e.low, e.high, e.basis]).toEqual([45, 55, "history"]);
    expect(e.stages[0]).toEqual({ name: "developer", roles: ["developer"], low: 40, high: 41, status: "queued" });
  });

  it("fallback below 3 samples", () => {
    const dev40: HistoryRun[] = [{ role: "developer", status: "completed", completedAt: at(40), durationMs: 40 * 60_000 }];
    const e = estimateEta(input({ history: historyFromRuns([dev40, dev40]) }));
    expect([e.low, e.high, e.basis]).toEqual([10, 29, "fallback"]);
  });

  it("complete reports total", () => {
    const e = estimateEta(input({ status: "COMPLETE", state: "COMPLETE", lastEventAt: at(31), nowMs: T0 + 41 * 60_000 }));
    expect([e.kind, e.label, e.reason, e.elapsedMinutes, e.low]).toEqual(["complete", "ETA complete", "COMPLETE · 31m total", 31, null]);
    const c = estimateEta(input({ status: "CANCELLED", state: "CANCELLED", lastEventAt: at(75) }));
    expect([c.kind, c.label]).toEqual(["cancelled", "CANCELLED · 1h 15m total"]);
  });

  it("is unknown for an unreadable log and calculating without a class or a mapped state", () => {
    for (const over of [{ status: "CORRUPT" as const }, { status: "INCOMPLETE" as const }, { createdAt: null }]) {
      expect(estimateEta(input(over)).label).toBe("ETA unknown — log unreadable");
    }
    expect(estimateEta(input({ createdAt: null })).elapsedMinutes).toBeNull();
    expect(estimateEta(input({ classification: null })).label).toBe("ETA calculating…");
    expect(estimateEta(input({ state: null })).kind).toBe("calculating");
  });
});

describe("historyFromRuns", () => {
  it("keeps completed, launched runs with a positive duration, at most 30 per role from the first 20 tasks", () => {
    const r = (status: HistoryRun["status"], durationMs: number | null, role = "qa"): HistoryRun => ({ role, status, completedAt: status === "pending" ? null : at(1), durationMs });
    const h = historyFromRuns([[r("completed", 60_000), r("not-launched", 60_000), r("lost", 60_000), r("pending", null), r("completed", 0), r("completed", 120_000, "reviewer")]]);
    expect(h).toEqual({ qa: [1], reviewer: [2] });
    const many = Array.from({ length: 25 }, () => [r("completed", 60_000), r("completed", 60_000)]);
    expect(historyFromRuns(many).qa).toHaveLength(30);
    expect(historyFromRuns(Array.from({ length: 25 }, (_, i) => (i < 20 ? [] : [r("completed", 60_000)])))).toEqual({});
  });
});

describe("formatElapsed", () => {
  it("shows minutes under an hour and hours with padded minutes above", () => {
    expect([formatElapsed(null), formatElapsed(0), formatElapsed(59), formatElapsed(60), formatElapsed(125)]).toEqual(["—", "0m", "59m", "1h 00m", "2h 05m"]);
  });
});
