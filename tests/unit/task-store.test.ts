import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPolicy } from "@/server/brain/governor";
import { eventsResponse, findingsResponse, loadTask, scanTasks, taskDetail, tasksResponse } from "@/server/brain/task-store";
import { appendBytes, buildLog, freshHome, highRiskScript, mkdirs, replaceLine, REPO_REL, rootsFor, SENTINELS, sha256, standardScript, writeGovernor, writeScript, writeTask, type Json } from "../helpers/fixture-store";

const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const A = "BR-20261007-0001";
const B = "BR-20261007-0002";
const C = "BR-20261007-0003";
const D = "BR-20261006-0001";

describe("scanTasks / tasksResponse (task listing)", () => {
  it("lists tasks newest first with counts and flags, ignoring odd names and counting symlinks as unsafe", async () => {
    const home = freshHome();
    const roots = mkdirs(home);
    writeScript(home, D, highRiskScript(home, { complete: true }));
    writeScript(home, A, standardScript(home, { pendingDeveloper: true }));
    writeScript(home, B, standardScript(home, { blocked: true }));
    writeScript(home, C, standardScript(home, { cancelled: true }));
    fs.mkdirSync(path.join(roots.tasksDir, "junk"));
    fs.symlinkSync(path.join(roots.tasksDir, A), path.join(roots.tasksDir, "BR-20261007-0009"));
    const res = tasksResponse(await scanTasks(roots, NOW), NOW);
    expect(res.tasks.map((t) => t.id)).toEqual([C, B, A, D]);
    expect(res.scan).toEqual({ status: "ok", scanned: 4, scanLimitReached: false, unsafeEntries: 1 });
    expect(res.counts).toEqual({ total: 4, active: 2, blocked: 1, waitingApproval: 0, ready: 0, corrupt: 0, openFindings: 0 });
    const a = res.tasks.find((t) => t.id === A)!;
    expect(a).toMatchObject({ status: "ACTIVE", active: true, state: "IMPLEMENTING", pendingRuns: 1, classification: "STANDARD", title: "Fix the thing", eventCount: 3, summaryUnavailable: false });
    expect(a.integrity).toMatchObject({ log: "ok", cache: "fresh", chainChecked: true, logSeq: 3, cacheSeq: 3 });
    const b = res.tasks.find((t) => t.id === B)!;
    expect(b).toMatchObject({ status: "BLOCKED", blocked: true, active: true, state: "BLOCKED" });
    const c = res.tasks.find((t) => t.id === C)!;
    expect(c).toMatchObject({ status: "CANCELLED", active: false });
    expect(c.integrity.chainChecked).toBe(false); // terminal: tail read only
    const d = res.tasks.find((t) => t.id === D)!;
    expect(d).toMatchObject({ status: "COMPLETE", round: 1, findings: { total: 2, open: 0 } });
    // D's log was never parsed here (chainChecked is false, above), so this repository can only have come
    // from the state.json cache, not from any TASK_CREATED log field: the list view's cache fallback.
    // (task-store's functions are called directly here, below the /api/* home-masking layer, so the path
    // is the raw one the fixture wrote — masking itself is covered by tests/api/tasks.test.ts.)
    expect(d.repository).toBe(path.join(home, REPO_REL));
    expect(JSON.stringify(res)).not.toContain(SENTINELS.session);
  });

  it("flags READY and WAITING tasks and counts open findings of non-terminal tasks", async () => {
    const home = freshHome();
    const roots = mkdirs(home);
    writeScript(home, A, highRiskScript(home, { stopAfter: 37 })); // ends at READY_REACHED
    writeScript(home, B, highRiskScript(home, { stopAfter: 6 })); // ends at APPROVAL_REQUESTED → WAITING
    writeScript(home, C, highRiskScript(home, { stopAfter: 23 })); // after VALIDATION_COMPLETED: F-001 ACKNOWLEDGED, F-002 ACKNOWLEDGED
    const res = tasksResponse(await scanTasks(roots, NOW), NOW);
    expect(res.tasks.find((t) => t.id === A)).toMatchObject({ ready: true, state: "READY", status: "ACTIVE" });
    expect(res.tasks.find((t) => t.id === B)).toMatchObject({ waitingApproval: true, status: "WAITING" });
    const c = res.tasks.find((t) => t.id === C)!;
    expect(c.findings.open).toBe(2);
    expect(c.topOpenFindings).toEqual([{ id: "F-001", severity: "MAJOR", title: "Host guard misses Origin" }]);
    expect(res.counts.ready).toBe(1);
    expect(res.counts.waitingApproval).toBe(1);
    expect(res.counts.openFindings).toBe(2);
  });

  it("reports a missing or unsafe root", async () => {
    const home = freshHome();
    const roots = rootsFor(home);
    const missing = await scanTasks(roots, NOW);
    expect(missing.store.status).toBe("missing");
    expect(tasksResponse(missing, NOW).scan.status).toBe("missing");
    fs.mkdirSync(roots.brainStateDir, { recursive: true });
    fs.mkdirSync(path.join(home, "real-tasks"));
    fs.symlinkSync(path.join(home, "real-tasks"), roots.tasksDir);
    expect((await scanTasks(roots, NOW)).store.status).toBe("unsafe");
  });
});

describe("parentTaskId / parentStepId", () => {
  const withParent = (specs: ReturnType<typeof standardScript>, parent: unknown) =>
    specs.map((s, i) => (i === 0 ? { ...s, payload: { ...s.payload, parent_task: parent } } : s));

  it("takes parentTaskId from the TASK_CREATED payload's parent_task; parentStepId stays null", async () => {
    const home = freshHome();
    const roots = mkdirs(home);
    writeScript(home, A, withParent(standardScript(home, { pendingDeveloper: true }), D));
    const r = await loadTask(roots, A, { fullLog: false, nowMs: NOW });
    if (r.kind !== "loaded") throw new Error(r.kind);
    expect(r.task.integrity.chainChecked).toBe(true); // an active task: the log was read
    expect(r.task.summary).toMatchObject({ parentTaskId: D, parentStepId: null });
  });

  it("takes parentTaskId from the state.json cache when a terminal task's log is not read", async () => {
    const home = freshHome();
    const roots = mkdirs(home);
    // the log names no parent; only the cache does, so the value can only come from the cache
    const t = writeScript(home, A, standardScript(home, { cancelled: true }));
    expect(t.state.parent_task).toBeNull();
    fs.writeFileSync(t.statePath, JSON.stringify({ ...t.state, parent_task: D }));
    const r = await loadTask(roots, A, { fullLog: false, nowMs: NOW });
    if (r.kind !== "loaded") throw new Error(r.kind);
    expect(r.task.log).toBeNull();
    expect(r.task.integrity).toMatchObject({ chainChecked: false, cache: "fresh" });
    expect(r.task.summary).toMatchObject({ status: "CANCELLED", parentTaskId: D, parentStepId: null });
    // and the fixture fold carries a logged parent_task into state.json, as brain-state does
    const folded = writeScript(home, B, withParent(standardScript(home, { cancelled: true }), D));
    expect(folded.state.parent_task).toBe(D);
    const rb = await loadTask(roots, B, { fullLog: false, nowMs: NOW });
    if (rb.kind !== "loaded") throw new Error(rb.kind);
    expect(rb.task.integrity.chainChecked).toBe(false);
    expect(rb.task.summary.parentTaskId).toBe(D);
  });

  it("drops a malformed parent_task to null, from the log and from the cache", async () => {
    const home = freshHome();
    const roots = mkdirs(home);
    const bad: unknown[] = ["BR-2026-1", "br-20261006-0001", `${D}\n`, ` ${D}`, "BR-20261006-0001234", 42, true, { id: D }, [D], ""];
    for (const [i, v] of bad.entries()) {
      const tid = `BR-20261008-${String(i + 1).padStart(4, "0")}`;
      writeScript(home, tid, withParent(standardScript(home, { pendingDeveloper: true }), v));
      const r = await loadTask(roots, tid, { fullLog: false, nowMs: NOW });
      if (r.kind !== "loaded") throw new Error(r.kind);
      expect(r.task.summary.parentTaskId, JSON.stringify(v)).toBeNull();
    }
    const t = writeScript(home, C, standardScript(home, { cancelled: true }));
    fs.writeFileSync(t.statePath, JSON.stringify({ ...t.state, parent_task: "not-a-task" }));
    const r = await loadTask(roots, C, { fullLog: false, nowMs: NOW });
    if (r.kind !== "loaded") throw new Error(r.kind);
    expect(r.task.integrity.chainChecked).toBe(false);
    expect(r.task.summary.parentTaskId).toBeNull();
  });

  it("is null when no parent_task is recorded, active or terminal", async () => {
    const home = freshHome();
    const roots = mkdirs(home);
    writeScript(home, A, standardScript(home, { pendingDeveloper: true }));
    writeScript(home, B, standardScript(home, { cancelled: true }));
    const res = tasksResponse(await scanTasks(roots, NOW), NOW);
    for (const t of res.tasks) expect(t, t.id).toMatchObject({ parentTaskId: null, parentStepId: null });
  });
});

describe("loadTask / taskDetail (task detail)", () => {
  it("maps every detail field, uses ~ for the repository, and pulls files changed and tests run from events", async () => {
    const home = freshHome();
    const roots = mkdirs(home);
    writeGovernor(home);
    writeScript(home, A, highRiskScript(home, { complete: true }));
    const policy = await loadPolicy(roots);
    const r = await loadTask(roots, A, { fullLog: true, nowMs: NOW });
    expect(r.kind).toBe("loaded");
    if (r.kind !== "loaded") return;
    const d = taskDetail(r.task, policy, NOW);
    expect(d.repository).toBe(path.join(home, "proj/repo")); // raw here; `~` is applied by json() at the HTTP boundary
    expect(d).toMatchObject({
      id: A,
      title: "Build the dashboard",
      classification: "HIGH-RISK",
      classificationReason: "new local HTTP surface over sensitive data",
      risk: "high",
      branch: "main",
      baseHead: "1".repeat(40),
      currentHead: "4".repeat(40),
      status: "COMPLETE",
      state: "COMPLETE",
      outcome: "COMPLETE",
      completionSummary: "shipped",
      round: 1,
      maxRounds: 2,
      eventCount: 41,
      nextAction: "await APPROVE",
    });
    expect(d.plan).toEqual({ author: "planner", approved: true, approvedScope: ["the plan", "deps"], notApproved: ["eslint"], chars: SENTINELS.planText.length });
    expect(d.rounds).toEqual([{ round: 1, kind: "developer", findings: ["F-001"], findingsAddressed: { "F-001": "fixed" }, completed: true }]);
    expect(d.validation.latest).toMatchObject({ decision: "PASS", from: "b".repeat(12), to: "c".repeat(12), agents: { reviewer: "approve" }, round: 1 });
    expect(d.validation.history.map((h) => h.decision)).toEqual(["FIX_REQUIRED", "PASS"]);
    expect(d.validation.inProgress).toBeNull();
    expect(d.testsRun).toEqual([
      { agent: "developer", round: 0, cmd: "pnpm test", result: "pass 12" },
      { agent: "developer", round: 1, cmd: "pnpm test", result: "pass 13" },
    ]);
    expect(d.filesChanged).toEqual([
      { agent: "developer", round: 0, files: ["src/a.ts", "src/b.ts"] },
      { agent: "developer", round: 1, files: ["src/server/http.ts"] },
    ]);
    expect(d.agents).toHaveLength(7);
    expect(d.usage).toMatchObject({ classBudget: 36, consumed: 2 + 3 + 2 + 2 + 2 + 3 + 2, reserved: 0 });
    expect(d.lifecycle.steps.find((s) => s.state === "FIXING")?.status).toBe("completed");
    expect(d.lifecycle.steps.find((s) => s.state === "COMPLETE")?.status).toBe("completed");
    expect(d.lifecycle.steps.find((s) => s.state === "COMMITTING")?.status).toBe("skipped");
    expect(d.lifecycle.transitions.map((t) => t.state)).toEqual(["CLASSIFYING", "PLANNING", "WAITING_FOR_APPROVAL", "IMPLEMENTING", "VALIDATING", "SYNTHESIZING", "FIXING", "REVALIDATING", "SYNTHESIZING", "READY", "HUMAN_APPROVAL", "COMPLETE"]);
    expect(d.blockedInfo).toBeNull();
    const out = JSON.stringify(d);
    for (const s of [SENTINELS.packet, SENTINELS.report, SENTINELS.planText, SENTINELS.request, SENTINELS.command, SENTINELS.session]) expect(out).not.toContain(s);
    expect(out).not.toContain("complete_content");
  });

  it("shows blocked reason and needs", async () => {
    const home = freshHome();
    const roots = mkdirs(home);
    writeScript(home, A, standardScript(home, { blocked: true }));
    const r = await loadTask(roots, A, { fullLog: true, nowMs: NOW });
    if (r.kind !== "loaded") throw new Error(r.kind);
    const d = taskDetail(r.task, undefined, NOW);
    expect(d.blockedInfo).toEqual({ reason: "needs credentials", needs: ["DB access"] });
    expect(d.lifecycle.exit?.state).toBe("BLOCKED");
    expect(d.usage).toBeNull();
  });

  it("returns not_found for a well-formed unknown id and unsafe for a symlinked task dir", async () => {
    const home = freshHome();
    const roots = mkdirs(home);
    writeScript(home, A, standardScript(home));
    expect(await loadTask(roots, B, { fullLog: true, nowMs: NOW })).toEqual({ kind: "not_found" });
    fs.symlinkSync(path.join(roots.tasksDir, A), path.join(roots.tasksDir, C));
    expect(await loadTask(roots, C, { fullLog: true, nowMs: NOW })).toMatchObject({ kind: "unsafe" });
  });

  it("marks a symlinked events.jsonl and a hard-linked state.json unsafe without reading them", async () => {
    const home = freshHome();
    const roots = mkdirs(home);
    const a = writeScript(home, A, standardScript(home));
    const b = writeScript(home, B, standardScript(home));
    fs.unlinkSync(b.eventsPath);
    fs.symlinkSync(a.eventsPath, b.eventsPath);
    fs.unlinkSync(b.statePath);
    fs.linkSync(a.statePath, b.statePath);
    const r = await loadTask(roots, B, { fullLog: true, nowMs: NOW });
    if (r.kind !== "loaded") throw new Error(r.kind);
    expect(r.task.integrity.log).toBe("unsafe");
    expect(r.task.integrity.cache).toBe("unsafe");
    expect(r.task.summary.status).toBe("CORRUPT");
    expect(r.task.summary.summaryUnavailable).toBe(true);
    expect(r.task.summary.title).toBeNull();
  });
});

describe("malformed state.json and integrity labels", () => {
  async function load(home: string, id: string) {
    const r = await loadTask(rootsFor(home), id, { fullLog: false, nowMs: NOW });
    if (r.kind !== "loaded") throw new Error(r.kind);
    return r.task;
  }
  /** sha256 of each canonical line of the standard script, as brain-state would store them in last_hash */
  function buildLogHashes(home: string): string[] {
    return buildLog(A, standardScript(home)).lines.map((l) => sha256(l));
  }

  it("non-JSON, non-object and foreign-task caches are invalid; the task is still listed from the log", async () => {
    const home = freshHome();
    writeScript(home, A, standardScript(home), { state: "{not json" });
    const a = await load(home, A);
    expect(a.integrity.cache).toBe("invalid");
    expect(a.summary).toMatchObject({ status: "ACTIVE", title: "Fix the thing", classification: "STANDARD", state: "IMPLEMENTING", summaryUnavailable: true, eventCount: 4 });
    writeScript(home, B, standardScript(home), { state: "[1,2]" });
    expect((await load(home, B)).integrity.cache).toBe("invalid");
    const foreign = writeScript(home, C, standardScript(home)).state;
    const wrong: Json = { ...foreign, task_id: A };
    writeScript(home, D, standardScript(home), { state: wrong });
    expect((await load(home, D)).integrity.cache).toBe("invalid");
    const noState = writeScript(home, "BR-20261005-0001", standardScript(home), { noState: true });
    expect(fs.existsSync(noState.statePath)).toBe(false);
    const ns = await load(home, "BR-20261005-0001");
    expect(ns.integrity.cache).toBe("missing");
    expect(ns.summary.summaryUnavailable).toBe(true);
    const listed = tasksResponse(await scanTasks(rootsFor(home), NOW), NOW);
    expect(listed.tasks).toHaveLength(5);
  });

  it("labels a stale cache (log ahead) and still uses it, with the log winning for state", async () => {
    const home = freshHome();
    const t = writeScript(home, A, standardScript(home, { pendingDeveloper: true }));
    // append a new event the cache does not know about
    const extra = writeTask(freshHome(), A, [...standardScript(home, { pendingDeveloper: true }), { type: "STATE_CHANGED", payload: {}, state: "VALIDATING", next: "x" }]);
    process.env.HOME = home;
    appendBytes(t.eventsPath, Buffer.concat([extra.built.lines[3] as Buffer, Buffer.from("\n")]));
    const a = await load(home, A);
    expect(a.integrity).toMatchObject({ cache: "stale", logSeq: 4, cacheSeq: 3 });
    expect(a.summary.summaryUnavailable).toBe(false);
    expect(a.summary.state).toBe("VALIDATING");
    expect(a.summary.pendingRuns).toBe(1);
  });

  it("terminal task, cache ahead: the tail cannot prove the cache, so the whole log is read and the status comes from it", async () => {
    const home = freshHome();
    const t = writeScript(home, A, standardScript(home, { cancelled: true }));
    expect(t.state.status).toBe("CANCELLED");
    fs.writeFileSync(t.statePath, JSON.stringify({ ...t.state, last_seq: 99 }));
    const a = await load(home, A);
    expect(a.integrity).toMatchObject({ cache: "ahead", log: "ok", chainChecked: true, logSeq: 5, cacheSeq: 99 });
    expect(a.summary).toMatchObject({ status: "CANCELLED", active: false, title: "Fix the thing", state: "CANCELLED", summaryUnavailable: true });
    const listed = tasksResponse(await scanTasks(rootsFor(home), NOW), NOW);
    expect(listed.counts.active).toBe(0);
    // diverged at the last line (same seq, different hash) behaves the same way
    fs.writeFileSync(t.statePath, JSON.stringify({ ...t.state, last_hash: "0".repeat(64) }));
    const d = await load(home, A);
    expect(d.integrity).toMatchObject({ cache: "diverged", chainChecked: true });
    expect(d.summary.status).toBe("CANCELLED");
  });

  it("terminal task whose last line is longer than the 256 KiB tail window: full read, cache fresh, healthy", async () => {
    const home = freshHome();
    const spec = standardScript(home);
    spec.push({ type: "TASK_COMPLETED", payload: { outcome: "COMPLETE", summary: "s".repeat(300 * 1024) }, state: "COMPLETE", next: null });
    const t = writeScript(home, A, spec);
    expect(t.state.status).toBe("COMPLETE");
    const a = await load(home, A);
    expect(a.integrity).toMatchObject({ cache: "fresh", log: "ok", chainChecked: true, logSeq: 5, cacheSeq: 5 });
    expect(a.summary).toMatchObject({ status: "COMPLETE", active: false, title: "Fix the thing", summaryUnavailable: false });
    writeGovernor(home);
    const { health } = await import("@/server/brain/health");
    const h = await health(rootsFor(home), NOW);
    expect(h.sources.tasks.cacheAhead).toBe(0);
    expect(h.reasons).not.toContain(expect.stringContaining("ahead"));
    // a short terminal task is still proven from the tail alone
    writeScript(home, B, standardScript(home, { cancelled: true }));
    const b = await load(home, B);
    expect(b.integrity).toMatchObject({ cache: "fresh", chainChecked: false });
  });

  it("an unreadable log makes the cache 'unknown': its contents are not shown and the banner can say so", async () => {
    const home = freshHome();
    const t = writeScript(home, A, standardScript(home, { pendingDeveloper: true }));
    fs.unlinkSync(t.eventsPath);
    const a = await load(home, A);
    expect(a.integrity).toMatchObject({ log: "missing", cache: "unknown", logSeq: 0 });
    expect(a.summary).toMatchObject({ status: "INCOMPLETE", summaryUnavailable: true, title: null, pendingRuns: 0, eventCount: 0 });
    const b = writeScript(home, B, standardScript(home));
    const elsewhere = path.join(home, "else.jsonl");
    fs.renameSync(b.eventsPath, elsewhere);
    fs.symlinkSync(elsewhere, b.eventsPath);
    const bb = await load(home, B);
    expect(bb.integrity).toMatchObject({ log: "unsafe", cache: "unknown" });
    expect(bb.summary.status).toBe("CORRUPT");
    expect(bb.summary.summaryUnavailable).toBe(true);
  });

  it("a cache whose last_hash is not the hash of log line last_seq is 'diverged' even when the log is longer (brain-state's cache_ahead)", async () => {
    const home = freshHome();
    const t = writeScript(home, A, standardScript(home)); // 4 events
    const foreign: Json = { ...t.state, last_seq: 2, last_hash: "f".repeat(64) };
    fs.writeFileSync(t.statePath, JSON.stringify(foreign));
    const a = await load(home, A);
    expect(a.integrity).toMatchObject({ cache: "diverged", logSeq: 4, cacheSeq: 2 });
    expect(a.summary.summaryUnavailable).toBe(true);
    // the genuine hash of line 2 makes it merely stale
    const b = buildLogHashes(home);
    fs.writeFileSync(t.statePath, JSON.stringify({ ...t.state, last_seq: 2, last_hash: b[1] }));
    const s = await load(home, A);
    expect(s.integrity.cache).toBe("stale");
    expect(s.summary.summaryUnavailable).toBe(false);
  });

  it("round comes from the cache's current_round when the cache is used, from the log otherwise", async () => {
    const home = freshHome();
    const t = writeScript(home, A, standardScript(home));
    fs.writeFileSync(t.statePath, JSON.stringify({ ...t.state, current_round: 2 }));
    const a = await load(home, A);
    expect(a.integrity.cache).toBe("fresh");
    expect(a.summary.round).toBe(2);
    fs.writeFileSync(t.statePath, JSON.stringify({ ...t.state, current_round: 2, last_hash: "0".repeat(64) }));
    const d = await load(home, A);
    expect(d.integrity.cache).toBe("diverged");
    expect(d.summary.round).toBe(0); // the log's envelope round
  });

  it("labels a cache ahead of the log and a diverged cache, and falls back to the log", async () => {
    const home = freshHome();
    const t = writeScript(home, A, standardScript(home));
    const ahead: Json = { ...t.state, last_seq: 99 };
    fs.writeFileSync(t.statePath, JSON.stringify(ahead));
    const a = await load(home, A);
    expect(a.integrity.cache).toBe("ahead");
    expect(a.summary.summaryUnavailable).toBe(true);
    expect(a.summary.title).toBe("Fix the thing");
    const diverged: Json = { ...t.state, last_hash: "0".repeat(64) };
    fs.writeFileSync(t.statePath, JSON.stringify(diverged));
    const d = await load(home, A);
    expect(d.integrity.cache).toBe("diverged");
    expect(d.summary.summaryUnavailable).toBe(true);
  });

  it("labels torn tails, corrupt logs (status CORRUPT whatever the cache says) and incomplete logs", async () => {
    const home = freshHome();
    const t = writeScript(home, A, standardScript(home));
    appendBytes(t.eventsPath, '{"v":1,"seq":5,"half');
    const torn = await load(home, A);
    expect(torn.integrity).toMatchObject({ log: "torn_tail", tornBytes: 20, cache: "fresh" });
    expect(torn.summary.status).toBe("ACTIVE");

    const c = writeScript(home, B, standardScript(home));
    replaceLine(c.eventsPath, 2, "{broken");
    const corrupt = await load(home, B);
    expect(corrupt.integrity).toMatchObject({ log: "corrupt", corruptLine: 2, cache: "ahead" });
    expect(corrupt.summary.status).toBe("CORRUPT");
    expect(corrupt.summary.title).toBe("Fix the thing"); // the valid prefix

    const inc = writeTask(home, C, [{ type: "NOTE", payload: { text: "x" } }]);
    void inc;
    const incomplete = await load(home, C);
    expect(incomplete.integrity.log).toBe("incomplete");
    expect(incomplete.summary.status).toBe("INCOMPLETE");

    const counts = tasksResponse(await scanTasks(rootsFor(home), NOW), NOW).counts;
    expect(counts.corrupt).toBe(1);
  });

  it("builds events and findings bodies from a loaded task", async () => {
    const home = freshHome();
    const roots = mkdirs(home);
    writeGovernor(home);
    writeScript(home, A, highRiskScript(home, { complete: true }));
    const policy = await loadPolicy(roots);
    const r = await loadTask(roots, A, { fullLog: true, nowMs: NOW });
    if (r.kind !== "loaded") throw new Error(r.kind);
    const ev = eventsResponse(r.task, policy, 10);
    expect(ev.total).toBe(41);
    expect(ev.events).toHaveLength(10);
    expect(ev.hasMore).toBe(true);
    expect(ev.events[9]?.type).toBe("TASK_COMPLETED"); // newest last
    expect(ev.events.find((e) => e.type === "FINDING_UPDATED")?.text).toMatch(/^Finding F-00/);
    const all = eventsResponse(r.task, policy, 1000);
    expect(all.hasMore).toBe(false);
    expect(all.events[0]?.text).toBe("Task created (HIGH-RISK)");
    expect(all.events.find((e) => e.type === "AGENT_STARTED")?.text).toBe("Planner reserved 2 units and started (initial, round 0)");
    const f = findingsResponse(r.task);
    expect(f.findings.map((x) => x.id)).toEqual(["F-001", "F-002"]);
    expect(f.summary.total).toBe(2);
  });
});
