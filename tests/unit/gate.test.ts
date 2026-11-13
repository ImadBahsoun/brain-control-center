import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gateRequestStatus, gateSummary, parseAudit, parseGateState } from "@/server/brain/gate";
import { auditFixture, freshHome, GATE_CODE_SENTINEL, GATE_CODE_SENTINEL_2, GATE_SENTINELS, gateStateFixture, mkdirs, rootsFor, SESSION_SENTINEL, writeGate } from "../helpers/fixture-store";

const NOW = Date.parse("2026-10-07T12:00:00.000Z");

describe("parseGateState", () => {
  it("counts pending, expired and consumed requests and pending actions, and leaks no keys or fields", () => {
    const r = parseGateState(Buffer.from(JSON.stringify(gateStateFixture(NOW / 1000))), NOW);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.view.requests).toEqual({ pending: 1, expired: 1, consumed: 1, revoked: 0, pendingByAction: { commit: 1 } });
    expect(r.view.latestValidations).toHaveLength(2);
    expect(r.view.latestValidations[0]).toEqual({ kind: "git", verdict: "changes required", ts: new Date(NOW - 50_000).toISOString(), repo: GATE_SENTINELS.cwd, to: "d".repeat(12) });
    const out = JSON.stringify(r.view);
    for (const s of [GATE_CODE_SENTINEL, GATE_CODE_SENTINEL_2, SESSION_SENTINEL, GATE_SENTINELS.task, GATE_SENTINELS.brainLine, GATE_SENTINELS.display, GATE_SENTINELS.inputs, GATE_SENTINELS.envs, GATE_SENTINELS.approvalUuid, "agent-xyz", "envs", "inputs", "approval_uuid", "brain_line"]) {
      expect(out, s).not.toContain(s);
    }
  });
  it("rejects a non-object and tolerates odd shapes", () => {
    expect(parseGateState(Buffer.from("[1]"), NOW).status).toBe("invalid");
    expect(parseGateState(Buffer.from("nope"), NOW).status).toBe("invalid");
    const r = parseGateState(Buffer.from(JSON.stringify({ v: 1, requests: { X: 1, Y: { actions: "commit", expires: "soon" } }, validations: "no" })), NOW);
    expect(r).toEqual({ status: "ok", view: { requests: { pending: 0, expired: 1, consumed: 0, revoked: 0, pendingByAction: {} }, latestValidations: [] } });
  });
  it("counts prototype-named actions as plain integers and never reads an inherited property", () => {
    const sec = NOW / 1000 + 100;
    // "constructor" is the one inherited name that also passes the lowercase action alphabet; the mixed-case
    // ones (toString, hasOwnProperty, valueOf) and "__proto__" are rejected by ACTION_RE before counting
    const state = {
      requests: {
        k1: { expires: sec, actions: ["constructor", "toString", "hasOwnProperty", "valueOf", "commit", "__proto__"] },
        k2: { expires: sec, actions: ["constructor", "commit"] },
      },
    };
    const r = parseGateState(Buffer.from(JSON.stringify(state)), NOW);
    if (r.status !== "ok") throw new Error("invalid");
    const by = r.view.requests.pendingByAction;
    expect(by).toEqual({ constructor: 2, commit: 2 });
    expect(by.constructor).toBe(2); // an own integer, not Object's constructor function
    for (const v of Object.values(by)) expect(Number.isInteger(v)).toBe(true);
    expect(Object.hasOwn(by, "__proto__")).toBe(false);
    expect(JSON.parse(JSON.stringify(by))).toEqual(by);
  });
  it("ignores action names outside the safe alphabet and caps distinct actions", () => {
    const reqs: Record<string, unknown> = {};
    for (let i = 0; i < 30; i++) reqs[`k${i}`] = { expires: NOW / 1000 + 100, actions: [`act-${i}`, "Bad Name", GATE_SENTINELS.task] };
    const r = parseGateState(Buffer.from(JSON.stringify({ requests: reqs })), NOW);
    if (r.status !== "ok") throw new Error("invalid");
    expect(Object.keys(r.view.requests.pendingByAction)).toHaveLength(20);
    expect(JSON.stringify(r.view)).not.toContain("Bad Name");
  });
});

describe("gateRequestStatus (mirrors brain-gate's pending_codes and retry path)", () => {
  const sec = NOW / 1000;
  it("is pending at expires == now (brain-gate's >=) and expired one second earlier", () => {
    expect(gateRequestStatus({ expires: sec }, NOW)).toBe("pending");
    expect(gateRequestStatus({ expires: sec - 1 }, NOW)).toBe("expired");
  });
  it("puts consumed first, over revoked and expired", () => {
    expect(gateRequestStatus({ expires: sec + 100, consumed_at: sec - 5, revoked_at: sec - 1 }, NOW)).toBe("consumed");
    expect(gateRequestStatus({ expires: sec - 100, consumed_at: sec - 200 }, NOW)).toBe("consumed");
  });
  it("calls a stale-grant revocation (revoked_at <= expires) revoked, even with expires still in the future", () => {
    expect(gateRequestStatus({ expires: sec + 1000, revoked_at: sec - 10 }, NOW)).toBe("revoked");
    expect(gateRequestStatus({ expires: sec - 10, revoked_at: sec - 10 }, NOW)).toBe("revoked");
  });
  it("calls an expiry found on retry (revoked_at > expires) expired", () => {
    expect(gateRequestStatus({ expires: sec - 100, revoked_at: sec - 50 }, NOW)).toBe("expired");
  });
  it("follows Python truthiness: 0, null, false and \"\" are unset; any other value is set", () => {
    for (const unset of [0, null, false, "", [], {}]) {
      expect(gateRequestStatus({ expires: sec + 100, consumed_at: unset }, NOW), JSON.stringify(unset)).toBe("pending");
      expect(gateRequestStatus({ expires: sec + 100, revoked_at: unset }, NOW), JSON.stringify(unset)).toBe("pending");
    }
    expect(gateRequestStatus({ expires: sec + 100, consumed_at: "yes" }, NOW)).toBe("consumed");
    expect(gateRequestStatus({ expires: sec + 100, revoked_at: true }, NOW)).toBe("revoked");
  });
  it("treats a missing or non-numeric expires as 0 (expired)", () => {
    expect(gateRequestStatus({}, NOW)).toBe("expired");
    expect(gateRequestStatus({ expires: "soon" }, NOW)).toBe("expired");
    expect(gateRequestStatus({ expires: String(sec + 100) }, NOW)).toBe("expired");
  });
  it("never counts a revoked request as pending (the miscount regression) and adds a revoked count", () => {
    const state = {
      requests: {
        a: { expires: sec + 1000, revoked_at: sec - 10, actions: ["commit"] },
        b: { expires: sec - 100, revoked_at: sec - 50, actions: ["push"] },
        c: { expires: sec + 1000, actions: ["push"] },
      },
    };
    const r = parseGateState(Buffer.from(JSON.stringify(state)), NOW);
    if (r.status !== "ok") throw new Error("invalid");
    expect(r.view.requests).toEqual({ pending: 1, expired: 1, consumed: 0, revoked: 1, pendingByAction: { push: 1 } });
  });
  it("gives pending 0 for a future expires with revoked_at set", () => {
    const r = parseGateState(Buffer.from(JSON.stringify({ requests: { k: { expires: sec + 1700, revoked_at: sec - 1 } } })), NOW);
    if (r.status !== "ok") throw new Error("invalid");
    expect(r.view.requests.pending).toBe(0);
    expect(r.view.requests.revoked).toBe(1);
  });
});

describe("parseAudit", () => {
  it("counts events in the last 24h, buckets unknown names, and finds the last FAIL_CLOSED", () => {
    const a = parseAudit(Buffer.from(auditFixture(NOW)), false, NOW);
    expect(a.countsByEvent).toEqual({ DENY_GATED: 1, FAIL_CLOSED: 2, VALIDATION_RECORDED: 1, OTHER: 1 });
    expect(a.lastFailClosedAt).toBe(new Date(NOW - 30_000).toISOString());
    expect(a.partial).toBe(false);
    expect(a.window).toBe("24h");
    const out = JSON.stringify(a);
    expect(out).not.toContain(GATE_CODE_SENTINEL);
    expect(out).not.toContain("AUDITCMD_SENTINEL");
    expect(out).not.toContain(SESSION_SENTINEL);
  });
  it("skips a half line at the start of a partial tail", () => {
    const text = auditFixture(NOW);
    const a = parseAudit(Buffer.from(text.slice(7)), true, NOW);
    expect(a.partial).toBe(true);
    expect(Object.values(a.countsByEvent).reduce((x, y) => x + y, 0)).toBe(4);
  });
});

describe("gateSummary", () => {
  it("reads both files, and reports missing or unsafe gate dirs and files", async () => {
    const home = freshHome();
    const roots = rootsFor(home);
    expect((await gateSummary(roots, NOW)).status).toBe("missing");
    mkdirs(home);
    expect((await gateSummary(roots, NOW)).status).toBe("missing");
    writeGate(home, NOW);
    const g = await gateSummary(roots, NOW);
    expect(g.status).toBe("ok");
    expect(g.requests.pending).toBe(1);
    expect(g.audit.status).toBe("ok");
    expect(g.audit.countsByEvent.FAIL_CLOSED).toBe(2);
    fs.unlinkSync(path.join(roots.gateDir, "state.json"));
    fs.writeFileSync(path.join(home, "x.json"), "{}");
    fs.symlinkSync(path.join(home, "x.json"), path.join(roots.gateDir, "state.json"));
    expect((await gateSummary(roots, NOW)).status).toBe("unsafe");
    fs.unlinkSync(path.join(roots.gateDir, "state.json"));
    fs.writeFileSync(path.join(roots.gateDir, "state.json"), "garbage");
    expect((await gateSummary(roots, NOW)).status).toBe("invalid");
  });
  it("reports an unsafe gate directory", async () => {
    const home = freshHome();
    const roots = rootsFor(home);
    fs.mkdirSync(path.join(roots.claudeDir, "state"), { recursive: true });
    fs.mkdirSync(path.join(home, "real-gate"));
    fs.symlinkSync(path.join(home, "real-gate"), roots.gateDir);
    const g = await gateSummary(roots, NOW);
    expect(g.status).toBe("unsafe");
    expect(g.audit.status).toBe("unsafe");
  });
});
