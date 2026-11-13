import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRun } from "@/lib/api-types";
import { agentUnits, concurrencyQueue, globalUsage, governorNotes, loadPolicy, parsePolicy, taskUsage } from "@/server/brain/governor";
import { parseLog } from "@/server/brain/events";
import { buildLog, freshHome, mkdirs, rootsFor, SESSION_SENTINEL, VALID_POLICY, writeGovernor, type EventSpec, type Json } from "../helpers/fixture-store";

function parse(p: unknown) {
  return parsePolicy(Buffer.from(typeof p === "string" ? p : JSON.stringify(p)));
}

function clone(): Json {
  return JSON.parse(JSON.stringify(VALID_POLICY)) as Json;
}

describe("parsePolicy (strict, like brain-governor)", () => {
  it("accepts the valid policy", () => {
    const r = parse(VALID_POLICY);
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.policy.agents.developer).toEqual({ policyUnits: 3, model: "fable" });
      expect(r.policy.taskBudgets["HIGH-RISK"]).toBe(36);
      expect(r.policy.global.max_total_agents).toBe(3);
      expect(r.policy.staleAfterMinutes).toBe(240);
      expect(r.policy.note).toBe("test policy");
    }
  });
  it("rejects unknown keys, booleans as ints, a missing agent, bad ranges and bad JSON", () => {
    const unknown = clone();
    unknown.extra = 1;
    expect(parse(unknown)).toMatchObject({ status: "invalid", reason: "unknown key extra in policy" });
    const bool = clone();
    bool.soft_limit_percent = true;
    expect(parse(bool)).toMatchObject({ status: "invalid", reason: expect.stringContaining("soft_limit_percent") });
    const missing = clone();
    delete (missing.agents as Json).qa;
    expect(parse(missing)).toMatchObject({ status: "invalid", reason: "missing key qa in agents" });
    const range = clone();
    range.stale_after_minutes = 5;
    expect(parse(range)).toMatchObject({ status: "invalid" });
    const model = clone();
    (model.agents as Record<string, Json>).qa!.model = "";
    expect(parse(model)).toMatchObject({ status: "invalid" });
    const v = clone();
    v.v = 2;
    expect(parse(v)).toMatchObject({ status: "invalid", reason: "v must be 1" });
    expect(parse("{nope")).toMatchObject({ status: "invalid", reason: "not valid JSON" });
    expect(parse([1])).toMatchObject({ status: "invalid" });
  });
  it("rejects a policy over 64 KiB", () => {
    expect(parsePolicy(Buffer.alloc(64 * 1024 + 1, 0x20)).status).toBe("too_large");
  });
});

describe("loadPolicy", () => {
  it("reads a valid file, and reports missing, symlinked and oversize ones", async () => {
    const home = freshHome();
    const roots = rootsFor(home);
    expect(await loadPolicy(roots)).toMatchObject({ status: "missing" });
    mkdirs(home);
    expect(await loadPolicy(roots)).toMatchObject({ status: "missing", reason: "missing policy file" });
    writeGovernor(home);
    expect((await loadPolicy(roots)).status).toBe("ok");
    fs.unlinkSync(path.join(roots.governorDir, "governor.json"));
    fs.writeFileSync(path.join(home, "elsewhere.json"), JSON.stringify(VALID_POLICY));
    fs.symlinkSync(path.join(home, "elsewhere.json"), path.join(roots.governorDir, "governor.json"));
    expect(await loadPolicy(roots)).toMatchObject({ status: "unsafe" });
    fs.unlinkSync(path.join(roots.governorDir, "governor.json"));
    writeGovernor(home, " ".repeat(70 * 1024));
    expect(await loadPolicy(roots)).toMatchObject({ status: "too_large" });
  });
  it("refuses a symlinked policy directory", async () => {
    const home = freshHome();
    const roots = rootsFor(home);
    fs.mkdirSync(roots.claudeDir, { recursive: true });
    fs.mkdirSync(path.join(home, "real-brain"));
    fs.writeFileSync(path.join(home, "real-brain", "governor.json"), JSON.stringify(VALID_POLICY));
    fs.symlinkSync(path.join(home, "real-brain"), roots.governorDir);
    expect(await loadPolicy(roots)).toMatchObject({ status: "unsafe" });
  });
});

const pol = (() => {
  const r = parse(VALID_POLICY);
  if (r.status !== "ok") throw new Error("fixture policy invalid");
  return r.policy;
})();

function run(role: string, status: AgentRun["status"], startedAt = "2026-10-07T08:00:00.000Z"): AgentRun {
  return { taskId: "BR-20261007-0001", role, roleLabel: role, model: pol.agents[role]?.model ?? null, effort: null, agentId: null, kind: "initial", round: 0, status, staleOverThreshold: false, verdict: null, reservedUnits: null, startedAt, completedAt: null, durationMs: null, rerun: false };
}

describe("budget math", () => {
  it("consumed, reserved and committed; not-launched counts 0; unknown agents count max units", () => {
    expect(agentUnits(pol, "mystery")).toBe(3);
    const u = taskUsage([run("planner", "completed"), run("developer", "not-launched"), run("developer", "completed"), run("qa", "pending"), run("mystery", "pending")], "HIGH-RISK", pol);
    expect(u.consumed).toBe(5);
    expect(u.reserved).toBe(5);
    expect(u.committed).toBe(10);
    expect(u.classBudget).toBe(36);
    expect(u.percentOfClassBudget).toBe(28);
    expect(u.softLimitCrossed).toBe(false);
    expect(u.note).toBe("class budget; session extensions not visible");
    const over = taskUsage(Array.from({ length: 10 }, () => run("developer", "completed")), "SMALL", pol);
    expect(over.softLimitCrossed).toBe(true);
    expect(taskUsage([run("qa", "completed")], "TRIVIAL", pol).classBudget).toBeNull();
    expect(taskUsage([run("qa", "completed")], "SMALL", null)).toMatchObject({ consumed: 0, classBudget: null, softLimitCrossed: null });
  });

  it("global counts cover pending runs and exclude ones past the stale threshold", () => {
    const now = Date.parse("2026-10-07T12:00:00.000Z");
    const g = globalUsage(
      [run("developer", "pending", "2026-10-07T11:00:00.000Z"), run("qa", "pending", "2026-10-07T11:30:00.000Z"), run("reviewer", "pending", "2026-10-07T07:00:00.000Z"), run("planner", "completed", "2026-10-07T11:00:00.000Z")],
      pol,
      now,
    );
    expect(g).toEqual({ pendingTotal: 2, pendingDevelopers: 1, pendingValidators: 1, pendingOpus: 0, pendingFable: 2, staleExcluded: 1 });
  });
});

describe("governorNotes", () => {
  it("parses DENIED and SOFT_LIMIT notes", () => {
    const b = buildLog("BR-20261007-0001", [
      { type: "TASK_CREATED", payload: { summary: "s", class: "SMALL" } },
      { type: "NOTE", payload: { text: "[governor] DENIED HARD_LIMIT developer: committed 12" } },
      { type: "NOTE", payload: { text: "[governor] SOFT_LIMIT accepted: ok" } },
      { type: "NOTE", payload: { text: "plain" } },
    ]);
    const parsed = parseLog(b.text, "BR-20261007-0001");
    const n = governorNotes("BR-20261007-0001", parsed.events);
    expect(n.denials).toEqual([{ taskId: "BR-20261007-0001", seq: 2, ts: expect.any(String), code: "HARD_LIMIT", role: "developer" }]);
    expect(n.softLimits).toEqual([{ taskId: "BR-20261007-0001", seq: 3, ts: expect.any(String) }]);
  });
});

describe("concurrencyQueue", () => {
  const T = "BR-20261007-0001";
  const STALE_MS = 240 * 60_000;
  const AT = (s: number) => new Date(Date.UTC(2026, 9, 7, 8, 0, s)).toISOString();
  const NOW = Date.parse("2026-10-07T08:10:00.000Z");
  const DENY = `[governor] DENIED CONCURRENCY qa, reviewer, security-reviewer: global validators 6/3; active: BR-20261007-0002/qa seq 3 (initial, started 2026-10-07T07:59:00Z, session ${SESSION_SENTINEL}); wait for a run to finish`;
  const waitStarted = (iso: string, timeout = "30m") => `[governor] WAIT started ${iso} · qa, reviewer, security-reviewer · timeout ${timeout} · ${DENY.slice("[governor] ".length)}`;
  const waitEnded = (start: string, end: string, outcome: string) => `[governor] WAIT ended ${start} → ${end} · ${outcome} · 121s · polls 9`;
  const note = (text: unknown): EventSpec => ({ type: "NOTE", payload: { text } });
  // seq 1–5: created, classified, the developer's run, then validation (a state change)
  const head: EventSpec[] = [
    { type: "TASK_CREATED", payload: { summary: "s", class: "STANDARD" }, state: "CLASSIFYING" },
    { type: "TASK_CLASSIFIED", payload: { class: "STANDARD" }, state: "IMPLEMENTING" },
    { type: "AGENT_STARTED", payload: { agent: "developer", kind: "initial" } },
    { type: "AGENT_COMPLETED", payload: { agent: "developer", status_or_verdict: "done" } },
    { type: "STATE_CHANGED", payload: {}, state: "VALIDATING" },
  ];
  const queue = (tail: EventSpec[], now = NOW) => concurrencyQueue(T, parseLog(buildLog(T, [...head, ...tail]).text, T).events, now, STALE_MS);

  it("is null without a denial, and null once an agent starts, completes or the state changes after it", () => {
    expect(queue([])).toBeNull();
    expect(queue([note(DENY), { type: "AGENT_STARTED", payload: { agent: "qa", kind: "initial" } }])).toBeNull();
    expect(queue([note(DENY), { type: "AGENT_COMPLETED", payload: { agent: "developer", status_or_verdict: "done" } }])).toBeNull();
    expect(queue([note(DENY), { type: "STATE_CHANGED", payload: {}, state: "BLOCKED" }])).toBeNull();
  });
  it("projects an open wait after the denial, with every denied role and no note text", () => {
    const q = queue([note(DENY), note(waitStarted("2026-10-07T08:00:06Z"))]);
    expect(q).toEqual({
      taskId: T,
      roles: ["qa", "reviewer", "security-reviewer"],
      deniedSeq: 6,
      deniedAt: AT(5),
      wait: { startedAt: "2026-10-07T08:00:06.000Z", timeoutMinutes: 30, endedAt: null, outcome: null },
      overStaleThreshold: false,
    });
    const text = JSON.stringify(q);
    for (const s of [SESSION_SENTINEL, "global validators", "active:", "BR-20261007-0002", "wait for"]) expect(text).not.toContain(s);
  });
  it("keeps a launch queued after its wait ended CLEAR until an agent starts, with the outcome", () => {
    const start = "2026-10-07T08:00:06Z";
    const q = queue([note(DENY), note(waitStarted(start)), note(waitEnded(start, "2026-10-07T08:02:07Z", "CLEAR"))]);
    expect(q?.wait).toEqual({ startedAt: "2026-10-07T08:00:06.000Z", timeoutMinutes: 30, endedAt: "2026-10-07T08:02:07.000Z", outcome: "CLEAR" });
    expect(queue([note(DENY), note(waitStarted(start)), note(waitEnded(start, "2026-10-07T08:02:07Z", "DENIED CONCURRENCY"))])?.wait?.outcome).toBe("DENIED");
    // brain-governor writes EXIT_<n> for an unclassified failure: the outcome is still DENIED, the code is dropped
    const exit3 = queue([note(DENY), note(waitStarted(start)), note(waitEnded(start, "2026-10-07T08:02:07Z", "DENIED EXIT_3"))]);
    expect(exit3?.wait?.outcome).toBe("DENIED");
    expect(JSON.stringify(exit3)).not.toContain("EXIT_3");
    expect(queue([note(DENY), note(waitStarted(start)), note(waitEnded(start, "2026-10-07T08:02:07Z", "TIMEOUT"))])?.wait?.outcome).toBe("TIMEOUT");
    expect(queue([note(DENY), note(waitStarted(start)), note(waitEnded(start, "2026-10-07T08:02:07Z", "SOMETHING ELSE"))])?.wait?.outcome).toBeNull();
    expect(queue([note(DENY), note(waitStarted(start)), note(waitEnded(start, "2026-10-07T08:02:07Z", "CLEAR")), { type: "AGENT_STARTED", payload: { agent: "qa" } }])).toBeNull();
  });
  it("pairs a wait end with its start by the start time, uses the latest wait after the denial, and ignores a wait before it", () => {
    const a = "2026-10-07T08:00:06Z";
    const b = "2026-10-07T08:00:08Z";
    const q = queue([note(DENY), note(waitStarted(a)), note(waitEnded(a, "2026-10-07T08:00:07Z", "TIMEOUT")), note(waitStarted(b))]);
    expect(q?.wait).toEqual({ startedAt: "2026-10-07T08:00:08.000Z", timeoutMinutes: 30, endedAt: null, outcome: null });
    expect(queue([note(waitStarted(a)), note(DENY)])?.wait).toBeNull();
    // an end naming another start is not this wait's end
    expect(queue([note(DENY), note(waitStarted(a)), note(waitEnded(b, "2026-10-07T08:00:09Z", "CLEAR"))])?.wait?.endedAt).toBeNull();
  });
  it("parses a multi-role list, keeps only the five agents, and drops a denial naming none of them", () => {
    expect(queue([note("[governor] DENIED CONCURRENCY developer: global developers 2/1")])?.roles).toEqual(["developer"]);
    expect(queue([note("[governor] DENIED CONCURRENCY qa, mystery, reviewer, qa: global total 4/3")])?.roles).toEqual(["qa", "reviewer"]);
    expect(queue([note("[governor] DENIED CONCURRENCY mystery, constructor: global total 4/3")])).toBeNull();
    // a later denial replaces the earlier one
    expect(queue([note(DENY), note("[governor] DENIED CONCURRENCY reviewer: global validators 4/3")])).toMatchObject({ roles: ["reviewer"], deniedSeq: 7 });
    // other denial codes are not concurrency
    expect(queue([note("[governor] DENIED HARD_LIMIT developer: committed 40")])).toBeNull();
  });
  it("marks a denial or wait older than the stale threshold", () => {
    const later = Date.parse("2026-10-07T12:30:00.000Z");
    expect(queue([note(DENY)], later)?.overStaleThreshold).toBe(true);
    expect(queue([note(DENY), note(waitStarted("2026-10-07T12:00:00Z"))], later)?.overStaleThreshold).toBe(false);
    expect(queue([note(DENY)])?.overStaleThreshold).toBe(false);
  });
  it("does not match crafted, truncated or unicode notes, and finishes quickly on long hostile text", () => {
    const hostile = [
      `[governor] DENIED CONCURRENCY ${"a, ".repeat(200_000)}:`,
      `[governor] DENIED CONCURRENCY ${"a".repeat(200_000)}:`,
      `[governor] DENIED CONCURRENCY ${"qa, ".repeat(11)}qa: total`,
      "[governor] DENIED CONCURRENCY qá, reviewer: total",
      "[governor] DENIED CONCURRENCY qa,reviewer: total",
      "[governor] DENIED CONCURRENCY qa, revi",
      " [governor] DENIED CONCURRENCY qa: total",
      "[governor] denied concurrency qa: total",
      `[governor] WAIT started ${"9".repeat(200_000)}`,
      `[governor] WAIT started 2026-10-07T08:00:06Z${" · ".repeat(100_000)}`,
      "[governor] WAIT started 2026-13-45T99:99:99Z · qa · timeout 30m",
      "[governor] WAIT ended 2026-10-07T08:00:06Z → 2026-10-0",
    ];
    const t0 = performance.now();
    for (const h of hostile) expect(queue([note(h)]), h.slice(0, 60)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(1000);
    // a malformed wait after a real denial projects no wait
    const q = queue([note(DENY), note("[governor] WAIT started 2026-13-45T99:99:99Z · qa · timeout 30m"), note(`[governor] WAIT started 2026-10-07T08:00:06Z · qa · timeout ${"9".repeat(9)}m`)]);
    expect(q?.wait).toEqual({ startedAt: "2026-10-07T08:00:06.000Z", timeoutMinutes: null, endedAt: null, outcome: null });
  });
  it("skips malformed events: non-objects, missing or bad seq and type, non-string text, a bad timestamp", () => {
    const events: unknown[] = [
      null,
      "NOTE",
      42,
      [],
      { type: "NOTE", payload: { text: DENY } },
      { seq: "9", type: "NOTE", payload: { text: DENY } },
      { seq: 1.5, type: "NOTE", payload: { text: DENY } },
      { seq: -3, type: "NOTE", payload: { text: DENY } },
      { seq: 10, payload: { text: DENY } },
      { seq: 11, type: "NOTE" },
      { seq: 12, type: "NOTE", payload: null },
      { seq: 13, type: "NOTE", payload: { text: 7 } },
      { seq: 14, type: "NOTE", payload: { text: { toString: () => DENY } } },
      { seq: 15, type: "NOTE", payload: { text: [DENY] } },
    ];
    expect(concurrencyQueue(T, events, NOW, STALE_MS)).toBeNull();
    const q = concurrencyQueue(T, [...events, { seq: 16, type: "NOTE", ts: "not a time", payload: { text: DENY } }], NOW, STALE_MS);
    expect(q).toMatchObject({ deniedSeq: 16, deniedAt: null, wait: null, overStaleThreshold: false });
  });
  it("orders events by seq, whatever order they arrive in", () => {
    const start = { seq: 7, type: "AGENT_STARTED", ts: AT(7), state: "VALIDATING", payload: { agent: "qa" } };
    const deny = { seq: 6, type: "NOTE", ts: AT(6), state: "VALIDATING", payload: { text: DENY } };
    expect(concurrencyQueue(T, [start, deny], NOW, STALE_MS)).toBeNull();
    const earlier = { ...start, seq: 5 };
    expect(concurrencyQueue(T, [deny, earlier], NOW, STALE_MS)).toMatchObject({ deniedSeq: 6 });
  });
});
