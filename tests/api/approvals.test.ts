import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalsResponse } from "@/lib/api-types";
import * as approvalsRoute from "@/app/api/approvals/route";
import {
  APPROVAL_SENTINELS,
  freshHome,
  GATE_CODE_SENTINEL,
  GATE_CODE_SENTINEL_2,
  GATE_SENTINELS,
  gateApprovalEvent,
  gateRequestRecord,
  mkdirs,
  replaceLine,
  REPO_REL,
  rootsFor,
  SESSION_SENTINEL,
  standardScript,
  writeGate,
  writeScript,
} from "../helpers/fixture-store";

const H = { headers: { host: "127.0.0.1:3077" } };
const URL_ = "http://127.0.0.1:3077/api/approvals";
const HEAD = "c".repeat(40);
const T1 = "BR-20261103-0001";
const T2 = "BR-20261103-0002";
const THIRD_CODE = ["WXY", "347"].join("");

async function approvals(): Promise<{ status: number; text: string; body: ApprovalsResponse }> {
  const res = await approvalsRoute.GET(new Request(URL_, H), {});
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as ApprovalsResponse };
}

/**
 * Three live requests keyed by code sentinels: a pending one in the mission's repo (recorded by the Brain),
 * a consumed one with no repo binding, and a stale-revoked one. Every unread field holds a sentinel.
 */
function seedStore(home: string, nowMs: number) {
  const sec = nowMs / 1000;
  const repo = path.join(home, REPO_REL);
  writeGate(home, nowMs, {
    state: {
      v: 1,
      requests: {
        [GATE_CODE_SENTINEL]: gateRequestRecord(sec, { repos: [{ top: repo, head: HEAD }], created: sec - 120, expires: sec + 1680 }),
        [GATE_CODE_SENTINEL_2]: gateRequestRecord(sec, { actions: ["gate-config"], repos: [], created: sec - 3000, expires: sec - 1200, consumed_at: sec - 2900 }),
        [THIRD_CODE]: gateRequestRecord(sec, { actions: ["push"], repos: [{ top: repo, head: "d".repeat(40) }], created: sec - 1000, expires: sec + 800, revoked_at: sec - 900 }),
      },
      validations: [],
    },
  });
  // the event records its actions: that is what proves the earlier, unbound gate-config request different
  const script = standardScript(home);
  script.push(gateApprovalEvent(new Date(nowMs - 100_000).toISOString(), { repo, head: HEAD.slice(0, 7), actions: ["commit"] }));
  writeScript(home, T1, script);
  return { repo };
}

const FORBIDDEN = [
  GATE_CODE_SENTINEL,
  GATE_CODE_SENTINEL_2,
  THIRD_CODE,
  SESSION_SENTINEL,
  GATE_SENTINELS.task,
  GATE_SENTINELS.brainLine,
  GATE_SENTINELS.display,
  GATE_SENTINELS.inputs,
  GATE_SENTINELS.envs,
  GATE_SENTINELS.approvalUuid,
  GATE_SENTINELS.cwd,
  APPROVAL_SENTINELS.agentId,
  APPROVAL_SENTINELS.approvalPromptId,
  APPROVAL_SENTINELS.inputSha,
  APPROVAL_SENTINELS.eventCommand,
  "session",
  "display",
  "cwd",
  "inputs",
  "envs",
  "approval_uuid",
  "approval_prompt_id",
  "brain_line",
  "agent_id",
  "input_sha256",
  "gate_code",
  "command",
  "created",
  HEAD,
];

describe("GET /api/approvals", () => {
  it("lists every request newest first with its status, home-masked repository, expiry and a provable mission link", async () => {
    const home = freshHome();
    const now = Date.now();
    seedStore(home, now);
    const { status, body } = await approvals();
    expect(status).toBe(200);
    expect(body.gate).toEqual({ status: "ok" });
    expect(body.linking).toBe("ok");
    expect(body.counts).toEqual({ pending: 1, consumed: 1, expired: 0, revoked: 1 });
    expect(body.items).toEqual([
      { actions: ["commit"], repositories: [`~/${REPO_REL}`], expires: new Date(now + 1_680_000).toISOString(), status: "pending", mission: { taskId: T1 } },
      { actions: ["push"], repositories: [`~/${REPO_REL}`], expires: new Date(now + 800_000).toISOString(), status: "revoked", mission: null },
      { actions: ["gate-config"], repositories: [], expires: new Date(now - 1_200_000).toISOString(), status: "consumed", mission: null },
    ]);
  });

  it("emits no code, process id, request content or event command, and no raw home path", async () => {
    const home = freshHome();
    seedStore(home, Date.now());
    const { text } = await approvals();
    for (const s of FORBIDDEN) expect(text, s).not.toContain(s);
    expect(text).not.toContain(home);
  });

  it("carries only the allowlisted keys and values", async () => {
    const home = freshHome();
    seedStore(home, Date.now());
    const { body } = await approvals();
    expect(Object.keys(body).sort()).toEqual(["counts", "gate", "generatedAt", "items", "linking"]);
    expect(Object.keys(body.gate)).toEqual(["status"]);
    expect(Object.keys(body.counts).sort()).toEqual(["consumed", "expired", "pending", "revoked"]);
    const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    for (const it of body.items) {
      expect(Object.keys(it).sort()).toEqual(["actions", "expires", "mission", "repositories", "status"]);
      if (it.mission) expect(Object.keys(it.mission)).toEqual(["taskId"]);
      if (it.mission) expect(it.mission.taskId).toMatch(/^BR-\d{8}-\d{4,6}$/);
      expect(["pending", "consumed", "expired", "revoked"]).toContain(it.status);
      if (it.expires !== null) expect(it.expires).toMatch(ISO);
      for (const a of it.actions) expect(a).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
      for (const r of it.repositories) expect(r).toBe(`~/${REPO_REL}`);
    }
    expect(body.generatedAt).toMatch(ISO);
  });

  it("(a) leaves overlapping same-repo, same-HEAD variants Unlinked end to end", async () => {
    const home = freshHome();
    const now = Date.now();
    const sec = now / 1000;
    const repo = path.join(home, REPO_REL);
    const variant = (created: number) => gateRequestRecord(sec, { repos: [{ top: repo, head: HEAD }], created, expires: created + 1800 });
    writeGate(home, now, { state: { v: 1, requests: { [GATE_CODE_SENTINEL]: variant(sec - 120), [GATE_CODE_SENTINEL_2]: variant(sec - 110) } } });
    const script = standardScript(home);
    script.push(gateApprovalEvent(new Date(now - 100_000).toISOString(), { repo, head: HEAD.slice(0, 7) }));
    writeScript(home, T1, script);
    const { body } = await approvals();
    expect(body.linking).toBe("ok");
    expect(body.items.map((i) => i.mission)).toEqual([null, null]);
  });

  it("(b) leaves a request Unlinked when two missions record matching events in its window", async () => {
    const home = freshHome();
    const now = Date.now();
    const { repo } = seedStore(home, now);
    const other = standardScript(home);
    other.push(gateApprovalEvent(new Date(now - 90_000).toISOString(), { repo, head: HEAD.slice(0, 7) }));
    writeScript(home, T2, other);
    const { body } = await approvals();
    expect(body.linking).toBe("ok");
    expect(body.items.every((i) => i.mission === null)).toBe(true);
  });

  it("(h) reports linking unavailable, and every row Unlinked, when a recently active task's log is corrupt", async () => {
    const home = freshHome();
    seedStore(home, Date.now());
    const bad = writeScript(home, T2, [...standardScript(home), gateApprovalEvent(new Date().toISOString())]);
    replaceLine(bad.eventsPath, 2, "{bad");
    const { status, body } = await approvals();
    expect(status).toBe(200);
    expect(body.linking).toBe("unavailable");
    expect(body.items).toHaveLength(3);
    expect(body.items.every((i) => i.mission === null)).toBe(true);
  });

  it("(h) reports linking unavailable when the task scan is capped", async () => {
    const home = freshHome();
    seedStore(home, Date.now());
    // 201 more readable, long-idle tasks: only the cap can make the scan unreliable here
    for (let i = 0; i < 201; i++) writeScript(home, `BR-20261001-${String(1000 + i)}`, [{ type: "TASK_CREATED", payload: { summary: "old", class: "SMALL" } }]);
    const { body } = await approvals();
    expect(body.linking).toBe("unavailable");
    expect(body.items.every((i) => i.mission === null)).toBe(true);
  });

  it("without the event's actions, an earlier unbound request that existed at the event's time blocks the link", async () => {
    const home = freshHome();
    const now = Date.now();
    const { repo } = seedStore(home, now);
    writeScript(home, T1, [...standardScript(home), gateApprovalEvent(new Date(now - 100_000).toISOString(), { repo, head: HEAD.slice(0, 7) })]);
    const { body } = await approvals();
    expect(body.linking).toBe("ok");
    expect(body.items.every((i) => i.mission === null)).toBe(true);
  });

  it("reports linking unavailable, without scanning, when a request has no numeric created", async () => {
    const home = freshHome();
    const now = Date.now();
    const sec = now / 1000;
    const { repo } = seedStore(home, now);
    const state = JSON.parse(fs.readFileSync(path.join(rootsFor(home).gateDir, "state.json"), "utf8")) as { requests: Record<string, unknown> };
    state.requests[THIRD_CODE] = gateRequestRecord(sec, { repos: [{ top: repo, head: "e".repeat(40) }], created: "earlier" });
    writeGate(home, now, { state });
    const { body } = await approvals();
    expect(body.linking).toBe("unavailable");
    expect(body.items).toHaveLength(3);
    expect(body.items.every((i) => i.mission === null)).toBe(true);
  });

  it("reports linking unavailable when the task listing holds an unsafe entry (a symlinked task dir)", async () => {
    const home = freshHome();
    const roots = rootsFor(home);
    seedStore(home, Date.now());
    fs.mkdirSync(path.join(home, "elsewhere"));
    fs.symlinkSync(path.join(home, "elsewhere"), path.join(roots.tasksDir, T2));
    const { body } = await approvals();
    expect(body.linking).toBe("unavailable");
    expect(body.items.every((i) => i.mission === null)).toBe(true);
  });

  it("reports linking unavailable when a gate event's timestamp cannot be parsed", async () => {
    const home = freshHome();
    seedStore(home, Date.now());
    writeScript(home, T2, [...standardScript(home), gateApprovalEvent("not a time")]);
    const { body } = await approvals();
    expect(body.linking).toBe("unavailable");
    expect(body.items.every((i) => i.mission === null)).toBe(true);
  });

  it("reports linking unavailable when a recently active task cannot be reloaded with its full log", async () => {
    const home = freshHome();
    const now = Date.now();
    seedStore(home, now);
    // a COMPLETE task with a matching cache is scanned from its log tail only, so it must be reloaded in full;
    // the reload is made to fail as a task dir replaced between the scan and the reload would
    writeScript(home, T2, [
      { type: "TASK_CREATED", payload: { summary: "s", class: "SMALL" }, ts: new Date(now - 50_000).toISOString() },
      { type: "TASK_COMPLETED", payload: { outcome: "COMPLETE", summary: "done" }, state: "COMPLETE", ts: new Date(now - 40_000).toISOString() },
    ]);
    expect((await approvals()).body.linking).toBe("ok"); // control: the same store links when the reload works
    vi.resetModules();
    vi.doMock("@/server/brain/task-store", async (importOriginal) => {
      const real = await importOriginal<typeof import("@/server/brain/task-store")>();
      return { ...real, loadTask: async (...args: Parameters<typeof real.loadTask>) => (args[2].fullLog ? { kind: "unsafe" as const, reason: "replaced" } : real.loadTask(...args)) };
    });
    try {
      const { approvalsResponse } = await import("@/server/brain/approvals");
      const body = await approvalsResponse(rootsFor(home), now);
      expect(body.linking).toBe("unavailable");
      expect(body.items).toHaveLength(3);
      expect(body.items.every((i) => i.mission === null)).toBe(true);
    } finally {
      vi.doUnmock("@/server/brain/task-store");
      vi.resetModules();
    }
  });

  it("answers 200 with no items when the gate state is missing or invalid", async () => {
    const home = freshHome();
    mkdirs(home);
    let r = await approvals();
    expect(r.status).toBe(200);
    expect(r.body.gate.status).toBe("missing");
    expect(r.body.items).toEqual([]);
    writeGate(home, Date.now(), { state: "garbage" });
    r = await approvals();
    expect(r.body.gate.status).toBe("invalid");
    expect(r.body.items).toEqual([]);
  });

  it("tolerates the older bare-path `repos` shape", async () => {
    const home = freshHome();
    writeGate(home, Date.now());
    const { status, body } = await approvals();
    expect(status).toBe(200);
    expect(body.items).toHaveLength(3);
    expect(body.counts).toEqual({ pending: 1, consumed: 1, expired: 1, revoked: 0 });
    expect(body.items.every((i) => i.mission === null)).toBe(true);
  });

  it("exports only GET plus the segment config, and refuses a foreign host", async () => {
    expect(Object.keys(approvalsRoute).sort()).toEqual(["GET", "dynamic", "runtime"]);
    freshHome();
    const res = await approvalsRoute.GET(new Request(URL_, { headers: { host: "evil.test:3077" } }), {});
    expect(res.status).toBe(403);
  });
});
