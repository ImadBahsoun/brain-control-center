import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyEvent, linkRequests, projectGateEvents, projectGateRequests, type GateEventView, type GateRequestView } from "@/server/brain/approvals";
import type { BrainEvent, EventType } from "@/server/brain/events";
import { APPROVAL_SENTINELS, GATE_CODE_SENTINEL, GATE_CODE_SENTINEL_2, GATE_SENTINELS, gateRequestRecord, SESSION_SENTINEL } from "../helpers/fixture-store";

const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const SEC = NOW / 1000;
const TOP = "/work/repo";
const HEAD = "a".repeat(40);
const HEAD2 = "b".repeat(40);
const T1 = "BR-20261103-0001";
const T2 = "BR-20261103-0002";

function req(over: Partial<GateRequestView> = {}): GateRequestView {
  return {
    status: "pending",
    actions: ["commit"],
    matchActions: ["commit"],
    repos: [{ top: TOP, head: HEAD }],
    created: SEC - 600,
    expires: SEC + 1200,
    windowEnd: SEC + 1200,
    ...over,
  };
}

function ev(over: Partial<GateEventView> = {}): GateEventView {
  return { taskId: T1, ts: SEC - 580, repo: TOP, head: HEAD.slice(0, 7), actions: null, ...over };
}

function brainEvent(type: EventType, ts: string, payload: Record<string, unknown>, seq = 1): BrainEvent {
  return { seq, eventId: `E-${seq}`, type, ts, actor: "brain", correlationId: null, state: null, round: 0, next: null, payload };
}

describe("linkRequests: a link only when provable", () => {
  it("links a request to the one mission whose event fully matches it", () => {
    expect(linkRequests([req()], [ev()], NOW)).toEqual([T1]);
  });
  it("accepts a full head and ignores a single trailing slash on either path", () => {
    expect(linkRequests([req()], [ev({ head: HEAD, repo: "/work/repo/" })], NOW)).toEqual([T1]);
    expect(linkRequests([req({ repos: [{ top: "/work/repo/", head: HEAD }] })], [ev()], NOW)).toEqual([T1]);
  });
  it("never compares a repo path with a `.`, `..` or empty segment (no textual resolution across symlinks)", () => {
    for (const repo of ["/work/sub/../repo", "/work/./repo", "/work//repo", "/work/repo/..", "/work/repo//"]) {
      expect(linkRequests([req()], [ev({ repo })], NOW), repo).toEqual([null]);
    }
    expect(linkRequests([req({ repos: [{ top: "/work/sub/../repo", head: HEAD }] })], [ev()], NOW)).toEqual([null]);
  });
  it("(a) leaves both Unlinked when one process re-issues variants in the same repo at the same HEAD with overlapping windows", () => {
    const r1 = req();
    const r2 = req({ created: SEC - 590, expires: SEC + 1210, windowEnd: SEC + 1210 });
    expect(linkRequests([r1, r2], [ev()], NOW)).toEqual([null, null]);
  });
  it("(b) leaves a request Unlinked when two missions record matching gate events in its window", () => {
    expect(linkRequests([req()], [ev(), ev({ taskId: T2, ts: SEC - 570 })], NOW)).toEqual([null]);
  });
  it("(c) leaves a request Unlinked when the event has no head, a short head, an unborn head, or no repo", () => {
    for (const e of [ev({ head: null }), ev({ head: "aaaaaa" }), ev({ head: "unborn" }), ev({ repo: null }), ev({ repo: "work/repo" })]) {
      expect(linkRequests([req()], [e], NOW), JSON.stringify(e)).toEqual([null]);
    }
  });
  it("(d) leaves a request with no repo binding, or more than one, Unlinked", () => {
    expect(linkRequests([req({ repos: [] })], [ev()], NOW)).toEqual([null]);
    expect(linkRequests([req({ repos: [{ top: TOP, head: HEAD }, { top: "/work/other", head: HEAD2 }] })], [ev()], NOW)).toEqual([null]);
  });
  it("(e) never hands another request's event to an unrecorded request: a head mismatch excludes it and lets the recorded one link", () => {
    const recorded = req();
    const unrecorded = req({ repos: [{ top: TOP, head: HEAD2 }], created: SEC - 595 });
    expect(linkRequests([recorded, unrecorded], [ev()], NOW)).toEqual([T1, null]);
  });
  it("an actions mismatch excludes a request too, letting the other link", () => {
    const commit = req();
    const push = req({ actions: ["push"], matchActions: ["push"], created: SEC - 595 });
    expect(linkRequests([commit, push], [ev({ actions: ["commit"] })], NOW)).toEqual([T1, null]);
    expect(linkRequests([commit, push], [ev()], NOW)).toEqual([null, null]); // without actions both are candidates
  });
  it("an event whose actions differ from its only candidate's is excluded, so nothing links", () => {
    expect(linkRequests([req()], [ev({ actions: ["push"] })], NOW)).toEqual([null]);
    expect(linkRequests([req({ matchActions: ["push", "commit"] })], [ev({ actions: ["commit", "push"] })], NOW)).toEqual([T1]);
  });
  it("(f) ignores an event recorded after the request was consumed or revoked (outside its window)", () => {
    const consumed = req({ status: "consumed", windowEnd: SEC - 590 });
    expect(linkRequests([consumed], [ev({ ts: SEC - 580 })], NOW)).toEqual([null]);
    expect(linkRequests([req()], [ev({ ts: SEC - 700 })], NOW)).toEqual([null]); // before created
  });
  it("(f) never hands an event recorded after its own request was consumed to another request that existed then", () => {
    const p = req({ created: SEC - 600, expires: SEC + 1200, windowEnd: SEC + 1200 }); // unrecorded, still pending
    const a = req({ status: "consumed", created: SEC - 540, expires: SEC + 1260, windowEnd: SEC - 420 }); // T1's request
    expect(linkRequests([p, a], [ev({ ts: SEC - 360 })], NOW)).toEqual([null, null]);
  });
  it("skips only requests created after the event in the cross-check", () => {
    const later = req({ created: SEC - 500, expires: SEC + 1300, windowEnd: SEC + 1300 });
    expect(linkRequests([req(), later], [ev({ ts: SEC - 580 })], NOW)).toEqual([T1, null]);
  });
  it("treats a request with no repo binding as undecidable, not provably different, against a head-bearing event", () => {
    const unbound = req({ repos: [], created: SEC - 600 });
    const bound = req({ created: SEC - 590 });
    expect(linkRequests([unbound, bound], [ev({ ts: SEC - 580 })], NOW)).toEqual([null, null]);
    expect(classifyEvent(ev(), unbound)).toBe("UNKNOWN");
    expect(classifyEvent(ev({ actions: ["push"] }), unbound)).toBe("EXCLUDED"); // a recorded-actions mismatch still excludes
  });
  it("(g) leaves symlinked path forms Unlinked (no realpath on Brain-written strings)", () => {
    const r = req({ repos: [{ top: "/private/tmp/scratch", head: HEAD }] });
    expect(linkRequests([r], [ev({ repo: "/tmp/scratch" })], NOW)).toEqual([null]);
  });
  it("an UNKNOWN event in the window blocks an otherwise unique match", () => {
    expect(linkRequests([req()], [ev(), ev({ taskId: T2, ts: SEC - 570, head: null })], NOW)).toEqual([null]);
  });
  it("ignores an event 23 h old or more, and links one just younger", () => {
    const created = SEC - 23 * 3600 - 30;
    const old = req({ status: "consumed", created, expires: created + 1800, windowEnd: created + 100 });
    expect(linkRequests([old], [ev({ ts: created + 20 })], NOW)).toEqual([null]);
    const youngCreated = SEC - 23 * 3600 + 60;
    const young = req({ status: "consumed", created: youngCreated, expires: youngCreated + 1800, windowEnd: youngCreated + 100 });
    expect(linkRequests([young], [ev({ ts: youngCreated + 20 })], NOW)).toEqual([T1]);
  });
  it("never links a request without a numeric created or expires, and lets its open window block others", () => {
    expect(linkRequests([req({ created: null })], [ev()], NOW)).toEqual([null]);
    expect(linkRequests([req({ expires: null, windowEnd: null })], [ev()], NOW)).toEqual([null]);
    const open = req({ created: null, expires: null, windowEnd: null });
    expect(linkRequests([req(), open], [ev()], NOW)).toEqual([null, null]);
  });
  it("classifies against the request's own bindings", () => {
    expect(classifyEvent(ev(), req())).toBe("MATCH");
    expect(classifyEvent(ev({ head: HEAD2.slice(0, 7) }), req())).toBe("EXCLUDED");
    expect(classifyEvent(ev({ head: null }), req())).toBe("UNKNOWN");
    expect(classifyEvent(ev({ repo: "/work/other" }), req())).toBe("UNKNOWN");
  });
});

describe("projectGateRequests", () => {
  const VIEW_KEYS = ["actions", "created", "expires", "matchActions", "repos", "status", "windowEnd"];

  it("reads only the named value fields: no code, process id or request content reaches a view", () => {
    const state = {
      v: 1,
      requests: {
        [GATE_CODE_SENTINEL]: gateRequestRecord(SEC),
        [GATE_CODE_SENTINEL_2]: gateRequestRecord(SEC, { consumed_at: SEC - 5 }),
      },
    };
    const r = projectGateRequests(Buffer.from(JSON.stringify(state)), NOW);
    if (r.status !== "ok") throw new Error("invalid");
    expect(r.requests).toHaveLength(2);
    for (const v of r.requests) {
      expect(Object.keys(v).sort()).toEqual(VIEW_KEYS);
      for (const b of v.repos) expect(Object.keys(b).sort()).toEqual(["head", "top"]);
    }
    const out = JSON.stringify(r.requests);
    for (const s of [GATE_CODE_SENTINEL, GATE_CODE_SENTINEL_2, SESSION_SENTINEL, GATE_SENTINELS.task, GATE_SENTINELS.brainLine, GATE_SENTINELS.display, GATE_SENTINELS.inputs, GATE_SENTINELS.envs, GATE_SENTINELS.approvalUuid, GATE_SENTINELS.cwd, APPROVAL_SENTINELS.agentId, APPROVAL_SENTINELS.approvalPromptId, APPROVAL_SENTINELS.inputSha]) {
      expect(out, s).not.toContain(s);
    }
  });
  it("derives status and the window end (earliest of expires, consumed_at, revoked_at)", () => {
    const state = {
      requests: {
        a: gateRequestRecord(SEC),
        b: gateRequestRecord(SEC, { consumed_at: SEC - 5 }),
        c: gateRequestRecord(SEC, { revoked_at: SEC - 20 }),
        d: gateRequestRecord(SEC, { expires: SEC - 30, revoked_at: SEC - 10 }),
      },
    };
    const r = projectGateRequests(Buffer.from(JSON.stringify(state)), NOW);
    if (r.status !== "ok") throw new Error("invalid");
    expect(r.requests.map((v) => v.status)).toEqual(["pending", "consumed", "revoked", "expired"]);
    expect(r.requests.map((v) => v.windowEnd)).toEqual([SEC + 1740, SEC - 5, SEC - 20, SEC - 30]);
  });
  it("tolerates odd shapes: a bare path binding, non-object values, unsafe action names, a non-object root", () => {
    expect(projectGateRequests(Buffer.from("[1]"), NOW).status).toBe("invalid");
    const state = { requests: { a: 1, b: null, c: { repos: ["/old/shape", 5, { top: 3 }], actions: ["commit", "Bad Name", 7, "commit"], expires: "soon" } } };
    const r = projectGateRequests(Buffer.from(JSON.stringify(state)), NOW);
    if (r.status !== "ok") throw new Error("invalid");
    expect(r.requests).toEqual([
      { status: "expired", actions: ["commit"], matchActions: ["commit", "Bad Name", "commit"], repos: [{ top: "/old/shape", head: null }, { top: null, head: null }], created: null, expires: null, windowEnd: null },
    ]);
  });
});

describe("projectGateEvents", () => {
  it("takes only gate APPROVAL_REQUESTED events, and only task id, ts, repo, head and actions from them", () => {
    const events = [
      brainEvent("APPROVAL_REQUESTED", "2026-11-03T11:50:00.000Z", { kind: "gate", what: "x", gate_code: GATE_CODE_SENTINEL, command: APPROVAL_SENTINELS.eventCommand, repo: TOP, head: "abcdef1", actions: ["commit"] }, 1),
      brainEvent("APPROVAL_REQUESTED", "2026-11-03T11:51:00.000Z", { kind: "plan", repo: TOP }, 2),
      brainEvent("NOTE", "2026-11-03T11:52:00.000Z", { kind: "gate", text: GATE_CODE_SENTINEL }, 3),
      brainEvent("APPROVAL_REQUESTED", "2026-11-03T11:53:00.000Z", { kind: "gate", gate_code: GATE_CODE_SENTINEL_2 }, 4),
    ];
    const r = projectGateEvents([{ id: T1, events }]);
    expect(r.badTs).toBe(false);
    expect(r.events).toEqual([
      { taskId: T1, ts: Date.parse("2026-11-03T11:50:00.000Z") / 1000, repo: TOP, head: "abcdef1", actions: ["commit"] },
      { taskId: T1, ts: Date.parse("2026-11-03T11:53:00.000Z") / 1000, repo: null, head: null, actions: null },
    ]);
    const out = JSON.stringify(r);
    for (const s of [GATE_CODE_SENTINEL, GATE_CODE_SENTINEL_2, APPROVAL_SENTINELS.eventCommand, "gate_code", "command"]) expect(out, s).not.toContain(s);
  });
  it("flags a gate event whose timestamp cannot be placed", () => {
    expect(projectGateEvents([{ id: T1, events: [brainEvent("APPROVAL_REQUESTED", "not a time", { kind: "gate" })] }]).badTs).toBe(true);
  });
});

describe("approvals.ts static bans", () => {
  it("never names a process id field, the gate code field, or enumerates request keys (comments stripped)", () => {
    const text = fs.readFileSync(path.resolve(process.cwd(), "src/server/brain/approvals.ts"), "utf8");
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code.length).toBeGreaterThan(1000);
    expect(/session/i.test(code)).toBe(false);
    expect(code.includes("gate_code")).toBe(false);
    expect(code.includes("Object.keys(")).toBe(false);
    expect(code.includes("Object.entries(")).toBe(false);
  });
});
