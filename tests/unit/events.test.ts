import { describe, expect, it } from "vitest";
import { activityFromEvents, EVENT_TYPES, parseLog, parseTail, sha256Hex, toActivity, type BrainEvent } from "@/server/brain/events";
import { buildLog, canonical, highRiskScript, SENTINELS, type EventSpec } from "../helpers/fixture-store";

const TID = "BR-20261007-0001";
const base: EventSpec[] = [
  { type: "TASK_CREATED", payload: { summary: "s", class: "STANDARD" }, state: "CLASSIFYING", round: 0 },
  { type: "TASK_CLASSIFIED", payload: { class: "STANDARD", reason: "r" }, state: "IMPLEMENTING" },
  { type: "NOTE", payload: { text: "hello" } },
];

describe("parseLog", () => {
  it("knows the 24 event types", () => {
    expect(EVENT_TYPES).toHaveLength(24);
  });

  it("accepts a valid chain and reports seq and hash of the last line", () => {
    const b = buildLog(TID, base);
    const r = parseLog(b.text, TID);
    expect(r.integrity).toBe("ok");
    expect(r.events.map((e) => e.type)).toEqual(["TASK_CREATED", "TASK_CLASSIFIED", "NOTE"]);
    expect(r.lastSeq).toBe(3);
    expect(r.lastHash).toBe(sha256Hex(b.lines[2] as Buffer));
    expect(r.hashes).toEqual(b.lines.map((l) => sha256Hex(l)));
    expect(r.tornBytes).toBe(0);
    // the session is dropped at parse time
    expect(JSON.stringify(r.events)).not.toContain(SENTINELS.session);
  });

  it("ignores a torn tail and reports its size", () => {
    const b = buildLog(TID, base);
    const torn = Buffer.concat([b.text, Buffer.from('{"v":1,"seq":4,"ty')]);
    const r = parseLog(torn, TID);
    expect(r.integrity).toBe("torn_tail");
    expect(r.events).toHaveLength(3);
    expect(r.tornBytes).toBe(18);
  });

  it("accepts a complete last line that only lacks its newline", () => {
    const b = buildLog(TID, base);
    const noNl = b.text.subarray(0, b.text.length - 1);
    const r = parseLog(noNl, TID);
    expect(r.integrity).toBe("ok");
    expect(r.events).toHaveLength(3);
    expect(r.lastHash).toBe(sha256Hex(b.lines[2] as Buffer));
  });

  it("flags bad JSON mid-file as corrupt and keeps the valid prefix", () => {
    const b = buildLog(TID, base);
    const lines = b.lines.map((l) => Buffer.from(l));
    lines[1] = Buffer.from("{not json");
    const text = Buffer.concat(lines.flatMap((l) => [l, Buffer.from("\n")]));
    const r = parseLog(text, TID);
    expect(r.integrity).toBe("corrupt");
    expect(r.corruptLine).toBe(2);
    expect(r.corruptReason).toBe("not valid JSON");
    expect(r.events).toHaveLength(1);
    expect(r.lastSeq).toBe(1);
  });

  it("flags a seq gap, a broken prev chain, a foreign task_id and an unknown type", () => {
    const b = buildLog(TID, base);
    const mutate = (i: number, fn: (o: Record<string, unknown>) => void) => {
      const lines = b.lines.map((l) => Buffer.from(l));
      const o = JSON.parse((lines[i] as Buffer).toString()) as Record<string, unknown>;
      fn(o);
      lines[i] = Buffer.from(canonical(o));
      return parseLog(Buffer.concat(lines.flatMap((l) => [l, Buffer.from("\n")])), TID);
    };
    const gap = mutate(1, (o) => (o.seq = 3));
    expect(gap.integrity).toBe("corrupt");
    expect(gap.corruptReason).toMatch(/seq 3, expected 2/);
    const prev = mutate(1, (o) => (o.prev = "0".repeat(64)));
    expect(prev.corruptReason).toMatch(/hash chain broken/);
    const tid = mutate(0, (o) => (o.task_id = "BR-20261007-0002"));
    expect(tid.corruptReason).toBe("task_id mismatch");
    expect(tid.events).toHaveLength(0);
    const unknown = mutate(2, (o) => (o.type = "SOMETHING_NEW"));
    expect(unknown.corruptReason).toMatch(/unknown event type/);
    expect(unknown.events).toHaveLength(2);
    const envelope = mutate(2, (o) => (o.v = 2));
    expect(envelope.corruptReason).toBe("not an event envelope");
  });

  it("flags a log without a TASK_CREATED first event as incomplete, and an empty log", () => {
    const b = buildLog(TID, [{ type: "NOTE", payload: { text: "x" } }]);
    expect(parseLog(b.text, TID).integrity).toBe("incomplete");
    expect(parseLog(Buffer.alloc(0), TID).integrity).toBe("incomplete");
  });

  it("rejects invalid UTF-8 as not valid JSON", () => {
    const b = buildLog(TID, base);
    const lines = b.lines.map((l) => Buffer.from(l));
    lines[2] = Buffer.from([0xff, 0xfe, 0x7b]);
    const r = parseLog(Buffer.concat(lines.flatMap((l) => [l, Buffer.from("\n")])), TID);
    expect(r.integrity).toBe("corrupt");
    expect(r.corruptLine).toBe(3);
  });
});

describe("parseTail", () => {
  it("finds the last complete line's seq and hash from a partial tail, skipping the half line", () => {
    const b = buildLog(TID, base);
    const offset = 10;
    const r = parseTail(b.text.subarray(offset), offset, TID);
    expect(r.lastSeq).toBe(3);
    expect(r.lastHash).toBe(sha256Hex(b.lines[2] as Buffer));
    expect(r.tornBytes).toBe(0);
  });
  it("counts a torn tail and accepts a complete newline-less last line", () => {
    const b = buildLog(TID, base);
    const torn = parseTail(Buffer.concat([b.text, Buffer.from("{garbage")]), 0, TID);
    expect(torn.lastSeq).toBe(3);
    expect(torn.tornBytes).toBe(8);
    const noNl = parseTail(b.text.subarray(0, b.text.length - 1), 0, TID);
    expect(noNl.lastSeq).toBe(3);
    expect(noNl.tornBytes).toBe(0);
  });
});

describe("toActivity", () => {
  const ctx = { aliasToFindingId: new Map([["R1", "F-001"]]), unitsByRole: new Map([["developer", 3], ["qa", 2]]) };
  const ev = (type: BrainEvent["type"], payload: Record<string, unknown>, extra: Partial<BrainEvent> = {}): BrainEvent => ({
    seq: 1,
    eventId: "E-0",
    type,
    ts: "2026-10-07T08:00:00.000Z",
    actor: "brain",
    correlationId: null,
    state: "IMPLEMENTING",
    round: 1,
    next: null,
    payload,
    ...extra,
  });

  it("renders every type's text as specified", () => {
    const cases: Array<[BrainEvent, string, string?]> = [
      [ev("TASK_CREATED", { class: "HIGH-RISK" }), "Task created (HIGH-RISK)"],
      [ev("TASK_CLASSIFIED", { class: "COMPLEX" }), "Classified COMPLEX"],
      [ev("TASK_RESUMED", {}), "Task resumed by another session"],
      [ev("LOG_REPAIRED", { bytes: 17 }), "Log repaired: torn tail quarantined (17 B)", "warn"],
      [ev("AGENT_STARTED", { agent: "developer", kind: "fix" }), "Developer reserved 3 units and started (fix, round 1)"],
      [ev("AGENT_STARTED", { agent: "developer", kind: "fix", rerun_reason: "retry" }), "Developer reserved 3 units and started (fix, round 1) · rerun"],
      [ev("AGENT_STARTED", { agent: "reviewer" }), "Reviewer started (initial, round 1)"],
      [ev("AGENT_COMPLETED", { agent: "qa", status_or_verdict: "pass" }), "QA completed: pass", "success"],
      [ev("AGENT_COMPLETED", { agent: "developer", status_or_verdict: "not-launched" }), "Developer not launched (units refunded)"],
      [ev("AGENT_COMPLETED", { agent: "security-reviewer", status_or_verdict: "lost" }), "Security Reviewer lost (units consumed)", "warn"],
      [ev("PLAN_CREATED", { author: "planner", text: SENTINELS.planText }), "Plan created by planner"],
      [ev("PLAN_APPROVED", {}), "Plan approved", "success"],
      [ev("APPROVAL_REQUESTED", { kind: "gate", what: "push", command: SENTINELS.command, gate_code: "ABCDEF" }), "Approval requested (gate)"],
      [ev("APPROVAL_GRANTED", {}), "Approval granted", "success"],
      [ev("APPROVAL_REJECTED", {}), "Approval rejected", "warn"],
      [ev("SNAPSHOT_TAKEN", { label: "T1", tree: "abcdef0123456789" }), "Snapshot T1 abcdef0123"],
      [ev("VALIDATION_STARTED", { agents: ["qa", "reviewer"] }), "Validation started: qa, reviewer"],
      [ev("VALIDATION_COMPLETED", { decision: "PASS", agents: { qa: "pass", reviewer: "approve" } }), "Validation PASS: qa=pass, reviewer=approve", "success"],
      [ev("VALIDATION_COMPLETED", { decision: "FIX_REQUIRED", agents: { qa: "fail" } }), "Validation FIX_REQUIRED: qa=fail", "warn"],
      [ev("FINDING_CREATED", { alias: "R1", severity: "MAJOR", source: "reviewer", title: "Guard" }), "Finding F-001 created (MAJOR, reviewer): Guard", "warn"],
      [ev("FINDING_CREATED", { alias: "Q7", severity: "NIT", source: "qa", title: "Typo" }), "Finding Q7 created (NIT, qa): Typo"],
      [ev("FINDING_UPDATED", { alias: "R1", status: "FIXED", reason: "done" }), "Finding F-001 → FIXED", "success"],
      [ev("FIX_ROUND_STARTED", { round: 1, findings: ["F-001", "F-002"] }), "Fix round 1 started (2 findings)"],
      [ev("FIX_ROUND_COMPLETED", { round: 1 }), "Fix round 1 completed"],
      [ev("READY_REACHED", {}), "READY reached", "success"],
      [ev("BLOCKED", { reason: "no creds" }), "Blocked", "error"],
      [ev("TASK_COMPLETED", { outcome: "COMPLETE" }), "Task COMPLETE", "success"],
      [ev("STATE_CHANGED", {}, { state: "READY" }), "State → READY"],
      [ev("HANDOFF_CREATED", { to: "user" }), "Handoff to user"],
      [ev("NOTE", { text: "[governor] DENIED CONCURRENCY qa: total 3/3" }), "Governor denied QA: CONCURRENCY", "error"],
      [ev("NOTE", { text: "[governor] SOFT_LIMIT accepted: fine" }), "Governor soft limit accepted", "warn"],
      [ev("NOTE", { text: "plain note" }), "Note"],
    ];
    for (const [e, text, tone] of cases) {
      const a = toActivity(e, null, ctx);
      expect(a.text, e.type).toBe(text);
      if (tone) expect(a.tone, e.type).toBe(tone);
    }
  });

  it("redacts a detail before clipping it: an AWS-style secret straddling the 200-char `what` cut is fully masked", () => {
    const aws = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"; // 40 chars, starts at index 182 → cut at 200 would split it
    const what = "w".repeat(181) + " " + aws + " and more text after the secret";
    const a = toActivity(ev("APPROVAL_REQUESTED", { kind: "gate", what }), null, ctx);
    expect(a.detail).toBeDefined();
    expect(a.detail).not.toContain("wJalr");
    expect(a.detail).not.toContain(aws.slice(0, 18));
    expect(a.detail?.startsWith("w".repeat(181) + " ***")).toBe(true);
    expect(a.detail?.length).toBeLessThanOrEqual(200);
    const url = toActivity(ev("NOTE", { text: "a".repeat(475) + "https://admin:S3cretPass@internal.example/x" }), null, ctx);
    expect(url.detail).not.toContain("S3cret");
    const blocked = toActivity(ev("BLOCKED", { reason: "b".repeat(490) + " token ghp_abcdefghijklmnopqrstuvwxyz" }), null, ctx);
    expect(blocked.detail).not.toContain("ghp_");
    const upd = toActivity(ev("FINDING_UPDATED", { alias: "R1", status: "FIXED", reason: "r".repeat(490) + " DB_PASSWORD=hunter2" }), null, ctx);
    expect(upd.detail).not.toContain("hunter2");
  });

  it("carries detail for approvals, finding updates, blocks and notes, clipped, and never command/gate_code", () => {
    const a = toActivity(ev("APPROVAL_REQUESTED", { kind: "gate", what: "w".repeat(300), command: SENTINELS.command, gate_code: "ABCDEF" }), null, ctx);
    expect(a.detail).toHaveLength(200);
    expect(JSON.stringify(a)).not.toContain("COMMAND_SENTINEL");
    expect(JSON.stringify(a)).not.toContain("ABCDEF");
    expect(toActivity(ev("FINDING_UPDATED", { alias: "R1", status: "DEFERRED", reason: "later" }), null, ctx).detail).toBe("later");
    expect(toActivity(ev("BLOCKED", { reason: "x" }), null, ctx).detail).toBe("x");
    expect(toActivity(ev("NOTE", { text: "n".repeat(600) }), null, ctx).detail).toHaveLength(500);
  });

  it("marks state changes relative to the previous event", () => {
    const items = activityFromEvents(
      [ev("TASK_CREATED", { class: "SMALL" }, { state: "CLASSIFYING", seq: 1 }), ev("NOTE", { text: "a" }, { state: "CLASSIFYING", seq: 2 }), ev("STATE_CHANGED", {}, { state: "IMPLEMENTING", seq: 3 })],
      ctx,
    );
    expect(items[0]?.stateChange).toEqual({ from: null, to: "CLASSIFYING" });
    expect(items[1]?.stateChange).toBeUndefined();
    expect(items[2]?.stateChange).toEqual({ from: "CLASSIFYING", to: "IMPLEMENTING" });
  });

  it("never emits packets, reports, plan text or the request", () => {
    const b = buildLog(TID, highRiskScript("/tmp/home", { complete: true }));
    const parsed = parseLog(b.text, TID);
    expect(parsed.integrity).toBe("ok");
    const out = JSON.stringify(activityFromEvents(parsed.events, ctx));
    for (const s of [SENTINELS.packet, SENTINELS.report, SENTINELS.planText, SENTINELS.request, SENTINELS.command, SENTINELS.session]) {
      expect(out).not.toContain(s);
    }
  });

  describe("APPROVAL_REQUESTED expires projection (brain-state's parse_ts semantics: naive = UTC)", () => {
    it("honours a trailing Z as already UTC", () => {
      const a = toActivity(ev("APPROVAL_REQUESTED", { kind: "plan", what: "approve", expires: "2026-10-12T17:20:00Z" }), null, ctx);
      expect(a.expires).toBe("2026-10-12T17:20:00.000Z");
    });
    it("honours an explicit offset instead of treating it as UTC", () => {
      // 17:20 at +03:00 is 14:20 UTC
      const a = toActivity(ev("APPROVAL_REQUESTED", { kind: "plan", what: "approve", expires: "2026-10-12T17:20:00+03:00" }), null, ctx);
      expect(a.expires).toBe("2026-10-12T14:20:00.000Z");
    });
    it("treats a naive timestamp (no Z, no offset) as UTC, not the server's local zone", () => {
      const a = toActivity(ev("APPROVAL_REQUESTED", { kind: "plan", what: "approve", expires: "2026-10-12T17:20:00" }), null, ctx);
      expect(a.expires).toBe("2026-10-12T17:20:00.000Z");
    });
    it("omits the field entirely when expires does not parse, never guessing a value", () => {
      const a = toActivity(ev("APPROVAL_REQUESTED", { kind: "plan", what: "approve", expires: "whenever" }), null, ctx);
      expect(a.expires).toBeUndefined();
      expect(JSON.stringify(a)).not.toContain("whenever");
    });
    it("is undefined when the payload carries no expires at all", () => {
      const a = toActivity(ev("APPROVAL_REQUESTED", { kind: "gate", what: "push" }), null, ctx);
      expect(a.expires).toBeUndefined();
    });
  });
});
