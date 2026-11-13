// QA break attempts against temp fixture stores: odd bytes, odd shapes, odd names, caps, and secrets
// pushed through every projected field. Nothing here touches the real ~/.claude (HOME is redirected).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ApiError, EventsResponse, FindingsResponse, GovernorResponse, HealthResponse, TaskDetail, TasksResponse } from "@/lib/api-types";
import { GET as agentsGet } from "@/app/api/agents/route";
import { GET as governorGet } from "@/app/api/governor/route";
import { GET as healthGet } from "@/app/api/health/route";
import { GET as detailGet } from "@/app/api/tasks/[id]/route";
import { GET as eventsGet } from "@/app/api/tasks/[id]/events/route";
import { GET as findingsGet } from "@/app/api/tasks/[id]/findings/route";
import { GET as tasksGet } from "@/app/api/tasks/route";
import { appendBytes, buildLog, freshHome, highRiskScript, mkdirs, sha256, standardScript, VALID_POLICY, writeGate, writeGovernor, writeScript, writeTask, type EventSpec, type Json } from "../helpers/fixture-store";

const H = { headers: { host: "127.0.0.1:3077" } };
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const T1 = "BR-20261007-0001";

async function detail(id: string): Promise<{ status: number; body: TaskDetail & ApiError }> {
  const res = await detailGet(new Request(`http://127.0.0.1:3077/api/tasks/${id}`, H), ctx(id));
  return { status: res.status, body: (await res.json()) as TaskDetail & ApiError };
}
async function events(id: string, q = ""): Promise<{ status: number; body: EventsResponse & ApiError }> {
  const res = await eventsGet(new Request(`http://127.0.0.1:3077/api/tasks/${id}/events${q}`, H), ctx(id));
  return { status: res.status, body: (await res.json()) as EventsResponse & ApiError };
}
async function findings(id: string): Promise<{ status: number; body: FindingsResponse }> {
  const res = await findingsGet(new Request(`http://127.0.0.1:3077/api/tasks/${id}/findings`, H), ctx(id));
  return { status: res.status, body: (await res.json()) as FindingsResponse };
}
async function tasks(): Promise<{ status: number; body: TasksResponse }> {
  const res = await tasksGet(new Request("http://127.0.0.1:3077/api/tasks", H), {});
  return { status: res.status, body: (await res.json()) as TasksResponse };
}
async function health(): Promise<{ status: number; body: HealthResponse }> {
  const res = await healthGet(new Request("http://127.0.0.1:3077/api/health", H), {});
  return { status: res.status, body: (await res.json()) as HealthResponse };
}
async function governor(): Promise<{ status: number; body: GovernorResponse }> {
  const res = await governorGet(new Request("http://127.0.0.1:3077/api/governor", H), {});
  return { status: res.status, body: (await res.json()) as GovernorResponse };
}
async function agents(): Promise<{ status: number; text: string }> {
  const res = await agentsGet(new Request("http://127.0.0.1:3077/api/agents", H), {});
  return { status: res.status, text: await res.text() };
}

/** A hand-built second line chained onto line 1 (the parser does not check canonical form). */
function rawLine2(taskId: string, line1: Buffer, fields: string): Buffer {
  const prev = sha256(line1);
  return Buffer.from(`{"v":1,"seq":2,"event_id":"E-0000000000000002","task_id":"${taskId}","ts":"2026-10-07T08:00:01.000Z","type":"NOTE","actor":"brain","session":"s","correlation_id":null,"key":null,"state":null,"round":0,"next":null,${fields},"prev":"${prev}"}`);
}

describe("QA: odd bytes and shapes in events.jsonl", () => {
  it("a log holding only a torn first line is labelled, status INCOMPLETE, never 500", async () => {
    const home = freshHome();
    const w = writeScript(home, T1, standardScript(home), { noState: true });
    fs.writeFileSync(w.eventsPath, '{"v":1,"seq":1,"type":"TASK_CRE');
    const d = await detail(T1);
    expect(d.status).toBe(200);
    expect(d.body.status).toBe("INCOMPLETE");
    expect(["incomplete", "torn_tail"]).toContain(d.body.integrity.log);
    expect(d.body.integrity.cache).toBe("missing");
    const t = await tasks();
    expect(t.body.tasks[0]?.status).toBe("INCOMPLETE");
    expect((await health()).body.status).toBe("degraded");
  });

  it("empty events.jsonl with a valid cache: cache ahead, status INCOMPLETE, no 500", async () => {
    const home = freshHome();
    const w = writeScript(home, T1, standardScript(home));
    fs.writeFileSync(w.eventsPath, "");
    const d = await detail(T1);
    expect(d.status).toBe(200);
    expect(d.body.status).toBe("INCOMPLETE");
    expect(d.body.integrity).toMatchObject({ log: "incomplete", cache: "ahead", logSeq: 0 });
    expect(d.body.summaryUnavailable).toBe(true);
    expect((await events(T1)).body.events).toEqual([]);
  });

  it("empty state.json is an invalid cache; the log still drives the summary", async () => {
    const home = freshHome();
    writeScript(home, T1, standardScript(home), { state: "" });
    const d = await detail(T1);
    expect(d.status).toBe(200);
    expect(d.body.integrity.cache).toBe("invalid");
    expect(d.body.title).toBe("Fix the thing");
    expect(d.body.agents).toEqual([]);
  });

  it("non-UTF-8 bytes mid-file are corrupt (prefix kept); in state.json the cache is invalid", async () => {
    const home = freshHome();
    const w = writeScript(home, T1, standardScript(home));
    const b = buildLog(T1, standardScript(home));
    const bad = Buffer.concat([b.lines[0] as Buffer, Buffer.from("\n"), Buffer.from([0xff, 0xfe, 0x7b]), Buffer.from("\n"), b.lines[2] as Buffer, Buffer.from("\n")]);
    fs.writeFileSync(w.eventsPath, bad);
    const d = await detail(T1);
    expect(d.status).toBe(200);
    expect(d.body.status).toBe("CORRUPT");
    expect(d.body.integrity).toMatchObject({ log: "corrupt", corruptLine: 2 });
    expect(d.body.integrity.corruptReason).toContain("not valid JSON");
    fs.writeFileSync(w.statePath, Buffer.from([0x7b, 0xff, 0x7d]));
    expect((await detail(T1)).body.integrity.cache).toBe("invalid");
  });

  it("a raw NUL byte in a line is corrupt; a JSON-escaped NUL in a note comes back visibly escaped", async () => {
    const home = freshHome();
    const w = writeScript(home, T1, [{ type: "TASK_CREATED", payload: { summary: "s", class: "STANDARD" }, state: "CLASSIFYING" }], { noState: true });
    const b = buildLog(T1, [{ type: "TASK_CREATED", payload: { summary: "s", class: "STANDARD" }, state: "CLASSIFYING" }]);
    const l1 = b.lines[0] as Buffer;
    const okNul = rawLine2(T1, l1, '"payload":{"text":"a\\u0000b\\u202ec\\u0007d"}');
    fs.writeFileSync(w.eventsPath, Buffer.concat([l1, Buffer.from("\n"), okNul, Buffer.from("\n")]));
    const e = await events(T1);
    expect(e.status).toBe(200);
    expect(e.body.integrity.log).toBe("ok");
    expect(e.body.events[1]?.detail).toBe("a\\u0000b\\u202ec\\u0007d");
    const rawNul = rawLine2(T1, l1, '"payload":{"text":"a\u0000b"}');
    fs.writeFileSync(w.eventsPath, Buffer.concat([l1, Buffer.from("\n"), rawNul, Buffer.from("\n")]));
    const d = await detail(T1);
    expect(d.status).toBe(200);
    expect(d.body.integrity).toMatchObject({ log: "corrupt", corruptLine: 2 });
  });

  it("deeply nested JSON (200k levels) in a log line and in state.json never 500s", async () => {
    const home = freshHome();
    const spec: EventSpec[] = [{ type: "TASK_CREATED", payload: { summary: "s", class: "STANDARD" }, state: "CLASSIFYING" }];
    const w = writeScript(home, T1, spec);
    const b = buildLog(T1, spec);
    const l1 = b.lines[0] as Buffer;
    const nested = "[".repeat(200_000) + "]".repeat(200_000);
    const deep = rawLine2(T1, l1, `"payload":{"text":${nested},"x":1}`);
    fs.writeFileSync(w.eventsPath, Buffer.concat([l1, Buffer.from("\n"), deep, Buffer.from("\n")]));
    const e = await events(T1);
    expect(e.status).toBe(200);
    expect(["ok", "corrupt"]).toContain(e.body.integrity.log);
    fs.writeFileSync(w.statePath, nested);
    const d = await detail(T1);
    expect(d.status).toBe(200);
    expect(d.body.integrity.cache).toBe("invalid");
    fs.writeFileSync(w.statePath, `{"task_id":"${T1}","last_seq":1,"last_hash":"x","findings":{"F-001":{"title":${nested}}}}`);
    const d2 = await detail(T1);
    expect(d2.status).toBe(200);
  });

  it("numbers as strings: seq '2' is corrupt at line 2, last_seq '3' is an invalid cache, round '1' is null", async () => {
    const home = freshHome();
    const spec: EventSpec[] = [{ type: "TASK_CREATED", payload: { summary: "s", class: "STANDARD" }, state: "CLASSIFYING" }];
    const w = writeScript(home, T1, spec);
    const b = buildLog(T1, spec);
    const l1 = b.lines[0] as Buffer;
    const prev = sha256(l1);
    const strSeq = Buffer.from(`{"v":1,"seq":"2","event_id":"E-0000000000000002","task_id":"${T1}","ts":"t","type":"NOTE","actor":"brain","session":"s","correlation_id":null,"key":null,"state":null,"round":0,"next":null,"payload":{"text":"x"},"prev":"${prev}"}`);
    fs.writeFileSync(w.eventsPath, Buffer.concat([l1, Buffer.from("\n"), strSeq, Buffer.from("\n")]));
    const d = await detail(T1);
    expect(d.body.integrity).toMatchObject({ log: "corrupt", corruptLine: 2 });
    expect(d.body.integrity.corruptReason).toContain("seq");
    fs.writeFileSync(w.eventsPath, Buffer.concat([l1, Buffer.from("\n")]));
    const st = JSON.parse(fs.readFileSync(w.statePath, "utf8")) as Json;
    st.last_seq = "1";
    fs.writeFileSync(w.statePath, JSON.stringify(st));
    expect((await detail(T1)).body.integrity.cache).toBe("invalid");
    st.last_seq = 1;
    st.last_hash = prev;
    st.current_round = "1";
    st.agents = { developer: [{ started_at: "2026-10-07T08:00:00Z", round: "1", completed_at: null }] };
    fs.writeFileSync(w.statePath, JSON.stringify(st));
    const d3 = await detail(T1);
    expect(d3.body.integrity.cache).toBe("fresh");
    expect(d3.body.agents[0]?.round).toBeNull();
  });

  it("events with no payload, a non-object payload, or wrong-typed envelope fields are tolerated", async () => {
    const home = freshHome();
    const spec: EventSpec[] = [{ type: "TASK_CREATED", payload: { summary: "s", class: "STANDARD" }, state: "CLASSIFYING" }];
    const w = writeScript(home, T1, spec, { noState: true });
    const b = buildLog(T1, spec);
    const l1 = b.lines[0] as Buffer;
    const prev = sha256(l1);
    const noPayload = Buffer.from(`{"v":1,"seq":2,"event_id":7,"task_id":"${T1}","ts":123,"type":"NOTE","actor":null,"session":"s","correlation_id":null,"key":null,"state":55,"round":1.5,"next":[],"prev":"${prev}"}`);
    const prev2 = sha256(noPayload);
    const arrPayload = Buffer.from(`{"v":1,"seq":3,"event_id":"E-3","task_id":"${T1}","ts":"2026-10-07T08:00:02Z","type":"AGENT_STARTED","actor":"brain","session":"s","correlation_id":null,"key":null,"state":"IMPLEMENTING","round":0,"next":null,"payload":[1,2],"prev":"${prev2}"}`);
    fs.writeFileSync(w.eventsPath, Buffer.concat([l1, Buffer.from("\n"), noPayload, Buffer.from("\n"), arrPayload, Buffer.from("\n")]));
    const e = await events(T1);
    expect(e.status).toBe(200);
    expect(e.body.integrity.log).toBe("ok");
    expect(e.body.events).toHaveLength(3);
    expect(e.body.events[1]).toMatchObject({ type: "NOTE", text: "Note", state: null, round: null, ts: "" });
    expect(e.body.events[2]?.text).toContain("started");
    const d = await detail(T1);
    expect(d.status).toBe(200);
    expect(d.body.state).toBe("IMPLEMENTING");
  });

  it("a 3 MB single line parses, and the activity detail and title are clipped", async () => {
    const home = freshHome();
    const huge = "x".repeat(3 * 1024 * 1024);
    const spec: EventSpec[] = [
      { type: "TASK_CREATED", payload: { summary: huge, class: "STANDARD" }, state: "CLASSIFYING" },
      { type: "NOTE", payload: { text: huge } },
    ];
    writeScript(home, T1, spec);
    const t0 = Date.now();
    const d = await detail(T1);
    const e = await events(T1);
    const ms = Date.now() - t0;
    expect(d.status).toBe(200);
    expect(d.body.title?.length).toBeLessThanOrEqual(2000);
    expect(e.body.events[1]?.detail?.length).toBeLessThanOrEqual(500);
    expect(ms).toBeLessThan(5000);
  });

  it("limit: 1200 events with limit=1000 gives hasMore; odd limit spellings are rejected", async () => {
    const home = freshHome();
    const spec: EventSpec[] = [{ type: "TASK_CREATED", payload: { summary: "s", class: "STANDARD" }, state: "CLASSIFYING" }];
    for (let i = 0; i < 1199; i++) spec.push({ type: "NOTE", payload: { text: `n${i}` } });
    writeScript(home, T1, spec);
    const ok = await events(T1, "?limit=1000");
    expect(ok.body).toMatchObject({ total: 1200, hasMore: true });
    expect(ok.body.events).toHaveLength(1000);
    expect(ok.body.events[0]?.seq).toBe(201);
    expect((await events(T1, "?limit=1000&limit=0")).status).toBe(200);
    for (const bad of ["?limit=", "?limit=+1", "?limit=%EF%BC%91", "?limit=1%00", "?limit=99999999999999999999", "?limit=1001", "?limit=0x10"]) {
      const r = await events(T1, bad);
      expect(r.status, bad).toBe(400);
      expect(r.body.error.code, bad).toBe("BAD_LIMIT");
    }
    expect((await events(T1, "?LIMIT=5&foo=bar&__proto__=x")).body.events).toHaveLength(200);
  });
});

describe("QA: odd shapes in state.json, governor.json and the gate files", () => {
  it("unknown agent roles, odd finding statuses and severities, and odd run fields do not 500", async () => {
    const home = freshHome();
    writeGovernor(home);
    const w = writeScript(home, T1, standardScript(home, { pendingDeveloper: true }));
    const st = JSON.parse(fs.readFileSync(w.statePath, "utf8")) as Json;
    (st.agents as Json)["ops-bot"] = [
      // started a minute ago, so the run stays under the 240-minute stale threshold whenever the test runs
      { agent_id: "x", kind: "initial", round: 0, started_at: new Date(Date.now() - 60_000).toISOString(), completed_at: null },
      { agent_id: "y", kind: 5, round: null, started_at: "garbage", completed_at: "", verdict: 42 },
      "not-an-object",
      null,
    ];
    (st.agents as Json)["developer"] = "not-a-list";
    st.findings = {
      "F-001": { id: "F-001", severity: "CRITICAL", status: "WONTFIX", title: "odd", history: "nope", aliases: "R1" },
      "F-002": { id: 7, severity: null, status: "FIXED", title: null, history: [{ status: "FIXED", reason: 3 }, "x"] },
      "F-003": "string",
    };
    st.findings_summary = { total: "3", open: 2 };
    st.rounds = [{ round: "1" }, 5];
    st.validation = { latest: { agents: ["a"], decision: 1 }, history: "x", in_progress: { agents: "qa" } };
    fs.writeFileSync(w.statePath, JSON.stringify(st));
    const d = await detail(T1);
    expect(d.status).toBe(200);
    const roles = d.body.agents.map((a) => a.role);
    expect(roles).toContain("ops-bot");
    const bot = d.body.agents.find((a) => a.role === "ops-bot" && a.agentId === "x");
    expect(bot).toMatchObject({ roleLabel: "ops-bot", status: "pending", reservedUnits: 3, model: null });
    const f = await findings(T1);
    expect(f.status).toBe(200);
    const f1 = f.body.findings.find((x) => x.id === "F-001");
    // unknown severity/status are shown as recorded (fix round 1, F-019): never relabelled to a known value
    expect(f1?.severity).toBe("CRITICAL");
    expect(f1?.status).toBe("WONTFIX");
    expect(f.body.summary.total).toBe(2); // the string "3" is ignored, so the fallback count runs
    const a = await agents();
    expect(a.status).toBe(200);
    expect(a.text).toContain("ops-bot");
    const g = await governor();
    expect(g.status).toBe(200);
    expect(g.body.global.pendingTotal).toBe(1);
    expect(g.body.tasks[0]?.reserved).toBe(3);
  });

  it("governor.json invalid in many ways is labelled invalid and health degraded; a secret in an unknown key is masked", async () => {
    const home = freshHome();
    writeScript(home, T1, standardScript(home));
    const variants: Array<[string, Json | string]> = [
      ["null", "null"],
      ["array", "[]"],
      ["empty", ""],
      ["v string", { ...VALID_POLICY, v: "1" }],
      ["v bool", { ...VALID_POLICY, v: true }],
      ["agents array", { ...VALID_POLICY, agents: [] }],
      ["extra agent", { ...VALID_POLICY, agents: { ...(VALID_POLICY.agents as Json), extra: { policy_units: 1, model: "opus" } } }],
      ["empty model", { ...VALID_POLICY, agents: { ...(VALID_POLICY.agents as Json), qa: { policy_units: 1, model: "" } } }],
      ["units string", { ...VALID_POLICY, agents: { ...(VALID_POLICY.agents as Json), qa: { policy_units: "2", model: "opus" } } }],
      ["units float", { ...VALID_POLICY, agents: { ...(VALID_POLICY.agents as Json), qa: { policy_units: 1.5, model: "opus" } } }],
      ["note number", { ...VALID_POLICY, _note: 5 }],
      ["global missing", (() => { const p = { ...VALID_POLICY } as Json; delete p.global; return p; })()],
      ["global over range", { ...VALID_POLICY, global: { ...(VALID_POLICY.global as Json), max_total_agents: 21 } }],
      ["stale too small", { ...VALID_POLICY, stale_after_minutes: 5 }],
      ["budget missing class", { ...VALID_POLICY, task_budget_policy_units: { SMALL: 1 } }],
      ["non-utf8", Buffer.from([0x7b, 0xff, 0x7d]).toString("latin1")],
      ["secret key", { ...VALID_POLICY, "password=hunter2": 1 }],
    ];
    for (const [name, pol] of variants) {
      writeGovernor(home, pol);
      const g = await governor();
      expect(g.status, name).toBe(200);
      expect(g.body.policyStatus, name).toBe("invalid");
      expect(g.body.policy, name).toBeNull();
      const h = await health();
      expect(h.body.status, name).toBe("degraded");
      expect(h.body.sources.governor.status, name).toBe("invalid");
      expect(h.body.reasons.join(" "), name).toContain("governor policy invalid");
      if (name === "secret key") {
        expect(g.body.policyReason).not.toContain("hunter2");
        expect(g.body.policyReason).toContain("***");
      }
    }
    // a valid policy with a secret in _note comes back masked
    writeGovernor(home, { ...VALID_POLICY, _note: "rotate token ghp_abcdefghijklmnopqrstuvwxyz0123 monthly" });
    const g = await governor();
    expect(g.body.policy?.note).toBe("rotate token *** monthly");
  });

  it("gate state.json: requests as an array / string, weird actions, prototype-named actions, odd validations", async () => {
    const home = freshHome();
    writeScript(home, T1, standardScript(home));
    const now = Date.now();
    const sec = Math.floor(now / 1000);
    for (const reqs of [[1, 2], "str", null, 5]) {
      writeGate(home, now, { state: { v: 1, requests: reqs, validations: {}, ready: [] } });
      const h = await health();
      expect(h.status).toBe(200);
      expect(h.body.sources.gate.status).toBe("ok");
      expect(h.body.sources.gate.requests).toEqual({ pending: 0, expired: 0, consumed: 0, revoked: 0, pendingByAction: {} });
      expect(h.body.sources.gate.latestValidations).toEqual([]);
    }
    const manyActions = Array.from({ length: 50 }, (_, i) => `act${i}`);
    writeGate(home, now, {
      state: {
        v: 1,
        requests: {
          AAAAAA: { expires: sec + 1000, actions: ["constructor", "toString", "hasOwnProperty", "__proto__", "commit", "Push", "x".repeat(40), 5, null] },
          BBBBBB: { expires: sec + 1000, actions: "commit" },
          CCCCCC: { expires: sec + 1000, actions: { commit: 1 } },
          DDDDDD: { expires: "soon", actions: ["push"] },
          EEEEEE: { expires: sec + 1000, consumed_at: "yes", actions: ["push"] },
          FFFFFF: { expires: sec + 1000, actions: manyActions },
          GGGGGG: null,
          HHHHHH: [],
        },
        validations: [{ kind: 5, verdict: null, ts: "2026-10-07T08:00:00Z", repo: 3, to: 9 }, { ts: 1e300 }, "x", { kind: "git", verdict: "approve", ts: sec, repo: path.join(home, "r"), to: "a".repeat(40) }],
        ready: "x",
      },
    });
    const h = await health();
    expect(h.status).toBe(200);
    const r = h.body.sources.gate.requests;
    // brain-gate tests `consumed_at` for Python truthiness, so EEEEEE's `"yes"` is consumed (not pending)
    expect(r.consumed).toBe(1);
    expect(r.expired).toBe(1);
    expect(r.pending).toBe(4);
    expect(r.revoked).toBe(0);
    for (const [k, v] of Object.entries(r.pendingByAction)) {
      expect(typeof v, `pendingByAction.${k} should be a number`).toBe("number");
      expect(Number.isInteger(v), `pendingByAction.${k}`).toBe(true);
    }
    expect(r.pendingByAction.commit).toBe(1);
    expect(r.pendingByAction.push).toBeUndefined(); // its only pending holder (EEEEEE) is consumed
    expect(Object.keys(r.pendingByAction).length).toBeLessThanOrEqual(20);
    expect(h.body.sources.gate.latestValidations.length).toBeLessThanOrEqual(5);
    expect(JSON.stringify(h.body)).toContain("~/r");
    expect(JSON.stringify(h.body)).not.toContain("AAAAAA");
  });

  it("gate state.json garbage / oversize and audit.jsonl garbage are labelled and never 500", async () => {
    const home = freshHome();
    writeScript(home, T1, standardScript(home));
    const now = Date.now();
    writeGate(home, now, { state: "[]", audit: "garbage\n\n{\"ts\":5}\n{\"event\":\"FAIL_CLOSED\"}\n\u0000ÿ{\"ts\":\"2026\",\"event\":[1]}\n" });
    let h = await health();
    expect(h.status).toBe(200);
    expect(h.body.sources.gate.status).toBe("invalid");
    expect(h.body.sources.gate.audit.status).toBe("ok");
    expect(h.body.sources.gate.audit.countsByEvent).toEqual({});
    expect(h.body.status).toBe("degraded");
    writeGate(home, now, { state: "{".repeat(100), audit: Buffer.alloc(600 * 1024, 0x41).toString("latin1") });
    h = await health();
    expect(h.body.sources.gate.status).toBe("invalid");
    expect(h.body.sources.gate.audit.partial).toBe(true);
    writeGate(home, now, { state: "x".repeat(4 * 1024 * 1024 + 1) });
    h = await health();
    expect(h.body.sources.gate.status).toBe("too_large");
    // audit lines with a string `event` outside the allowlist are bucketed, and `code`/`command` never surface
    writeGate(home, now, { audit: JSON.stringify({ ts: new Date(now).toISOString(), event: "ghp_evilcommandAAAA", command: "SECRETCMD", code: "KMNPQR" }) + "\n" });
    h = await health();
    expect(h.body.sources.gate.audit.countsByEvent).toEqual({ OTHER: 1 });
    expect(JSON.stringify(h.body)).not.toContain("SECRETCMD");
    expect(JSON.stringify(h.body)).not.toContain("KMNPQR");
  });

  it("state.json that is a directory or a FIFO is reported unsafe, not read, no 500", async () => {
    const home = freshHome();
    const w = writeScript(home, T1, standardScript(home));
    fs.unlinkSync(w.statePath);
    fs.mkdirSync(w.statePath);
    let d = await detail(T1);
    expect(d.status).toBe(200);
    expect(d.body.integrity.cache).toBe("unsafe");
    expect(d.body.integrity.log).toBe("ok");
    fs.rmdirSync(w.statePath);
    execFileSync("mkfifo", [w.statePath]);
    // hold a non-blocking writer so the app's O_RDONLY open returns (a FIFO with no writer would block)
    const fd = fs.openSync(w.statePath, "r+");
    try {
      d = await detail(T1);
      expect(d.status).toBe(200);
      expect(d.body.integrity.cache).toBe("unsafe");
    } finally {
      fs.closeSync(fd);
    }
  });
});

describe("QA: the tasks directory", () => {
  it("files, odd names, symlinks and nested dirs: only real well-formed dirs are listed; unsafe ones are counted", async () => {
    const home = freshHome();
    const roots = mkdirs(home);
    writeScript(home, T1, standardScript(home));
    fs.writeFileSync(path.join(roots.tasksDir, "BR-20261007-0002"), "a file named like a task");
    fs.writeFileSync(path.join(roots.tasksDir, ".DS_Store"), "");
    fs.writeFileSync(path.join(roots.tasksDir, "lock"), "");
    fs.mkdirSync(path.join(roots.tasksDir, "br-20261007-0003"));
    fs.mkdirSync(path.join(roots.tasksDir, "BR-20261007-0004 "));
    fs.mkdirSync(path.join(roots.tasksDir, "BR-20261007-0005\n"));
    fs.mkdirSync(path.join(roots.tasksDir, "BR-20261007-000"));
    fs.mkdirSync(path.join(roots.tasksDir, "BR-20261007-٠٠٠٦"));
    fs.mkdirSync(path.join(roots.tasksDir, "BR-20261007-0007")); // empty task dir: no files at all
    fs.symlinkSync(roots.gateDir, path.join(roots.tasksDir, "BR-20261007-0008"));
    fs.symlinkSync(roots.gateDir, path.join(roots.tasksDir, "oddlink"));
    fs.mkdirSync(path.join(roots.tasksDir, "BR-20261007-0009", "BR-20261007-0010"), { recursive: true });
    const t = await tasks();
    expect(t.status).toBe(200);
    const ids = t.body.tasks.map((x) => x.id);
    expect(ids).toEqual(["BR-20261007-0009", "BR-20261007-0007", T1]);
    expect(t.body.scan.unsafeEntries).toBe(3); // the task-named file and the two symlinks
    const empty = t.body.tasks.find((x) => x.id === "BR-20261007-0007");
    expect(empty).toMatchObject({ status: "INCOMPLETE", integrity: { log: "missing", cache: "missing" } });
    const d = await detail("BR-20261007-0007");
    expect(d.status).toBe(200);
    expect(d.body.status).toBe("INCOMPLETE");
    const e = await events("BR-20261007-0007");
    expect(e.status).toBe(200);
    expect(e.body.events).toEqual([]);
    expect((await findings("BR-20261007-0007")).status).toBe(200);
    const h = await health();
    expect(h.body.status).toBe("degraded");
    expect(h.body.sources.tasks.unsafeEntries).toBe(3);
    expect((await detail("BR-20261007-0010")).status).toBe(404); // nested dir is not a task
  });

  it("more than 200 task dirs: 200 newest are listed, the cap is flagged, nothing 500s", async () => {
    const home = freshHome();
    for (let i = 1; i <= 205; i++) {
      writeTask(home, `BR-20261007-${String(i).padStart(4, "0")}`, [
        { type: "TASK_CREATED", payload: { summary: `t${i}`, class: "STANDARD" }, state: "CLASSIFYING", round: 0 },
        { type: "TASK_CLASSIFIED", payload: { class: "STANDARD", reason: "r" }, state: "IMPLEMENTING" },
      ]);
    }
    const t0 = Date.now();
    const t = await tasks();
    const ms = Date.now() - t0;
    expect(t.status).toBe(200);
    expect(t.body.tasks).toHaveLength(200);
    expect(t.body.tasks[0]?.id).toBe("BR-20261007-0205");
    expect(t.body.tasks[199]?.id).toBe("BR-20261007-0006");
    expect(t.body.scan.scanLimitReached).toBe(true);
    expect(t.body.counts.total).toBe(200);
    expect(t.body.counts.active).toBe(200);
    expect((await detail("BR-20261007-0001")).status).toBe(200); // below the cap but still addressable
    expect((await health()).status).toBe(200);
    expect((await agents()).status).toBe(200);
    expect((await governor()).status).toBe(200);
    // informational: full /api/tasks scan time for 205 active tasks
    console.log(`QA timing: /api/tasks with 205 active tasks took ${ms} ms`);
  });
});

describe("QA: secrets and control characters through every projected field", () => {
  const GHP = "ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789";
  const AKIA = "AKIAIOSFODNN7EXAMPLE";
  const AWS40 = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7\nabc\n-----END RSA PRIVATE KEY-----";
  const BIDI = "‮right-to-left⁦iso⁩\u0085nel ls\u0007bel";
  const CODE = ["KMN", "PQR"].join("");

  it("masks secrets in title, reason, approval what, notes, blocked reason, completion, files, tests, findings, validation, plan scope", async () => {
    const home = freshHome();
    writeGovernor(home, { ...VALID_POLICY, _note: `Authorization: Bearer ${GHP}` });
    const now = Date.now();
    writeGate(home, now, {
      state: {
        v: 1,
        requests: {},
        validations: [{ kind: "git", verdict: `approve ${CODE} password: hunter2`, ts: Math.floor(now / 1000), repo: `/srv/${AKIA}/repo`, to: "b".repeat(40) }],
      },
    });
    const repo = path.join(home, "proj", `repo-${BIDI}`);
    const spec: EventSpec[] = [
      { type: "TASK_CREATED", payload: { summary: `Rotate ${GHP} and DB_PASSWORD=hunter2 ${BIDI}`, class: "HIGH-RISK", request: "REQ_SENTINEL", repo, branch: `feat/${JWT}`, base_head: "1".repeat(40) }, state: "CLASSIFYING", round: 0 },
      { type: "TASK_CLASSIFIED", payload: { class: "HIGH-RISK", reason: `touches https://admin:pw123@db.internal/x and ${AWS40}`, risk: `aws ${AKIA}` }, state: "PLANNING" },
      { type: "PLAN_CREATED", payload: { text: "PLANTEXT_SENTINEL", author: `planner token=${GHP}` } },
      { type: "APPROVAL_REQUESTED", payload: { kind: "plan", what: `run: mysql -u root -p hunter2 --token ${GHP}`, command: "CMD_SENTINEL", gate_code: CODE }, state: "WAITING_FOR_APPROVAL" },
      { type: "APPROVAL_GRANTED", payload: { request: "SEQ4", note: `approve ${CODE}` } },
      { type: "PLAN_APPROVED", payload: { plan_seq: 3, approved: [`deploy with secret: "s3cr3t"`, PEM], not_approved: [`api_key=${GHP}`], approval: "SEQ5" }, state: "IMPLEMENTING" },
      { type: "SNAPSHOT_TAKEN", payload: { label: `T0 ${GHP}`, repo, kind: "git", tree: "a".repeat(40), head: "2".repeat(40) } },
      { type: "AGENT_STARTED", payload: { agent: "developer", kind: "initial", packet: "PACKET_SENTINEL", repo }, state: "IMPLEMENTING" },
      {
        type: "AGENT_COMPLETED",
        payload: {
          agent: "developer",
          status_or_verdict: `done; set TOKEN=${GHP}`,
          report: "REPORT_SENTINEL",
          agent_id: "agent-dev-1",
          files_changed: [`${home}/proj/repo/.env.password=hunter2`, `src/${BIDI}.ts`, `src/${AKIA}.ts`],
          tests_run: [{ cmd: `curl -u admin:pw123 https://x/ -H 'X-API-Key: ${GHP}'`, result: `pass; Cookie: session=${JWT}` }],
        },
        correlation_id: "SEQ8",
      },
      { type: "VALIDATION_STARTED", payload: { from: "a".repeat(40), to: "b".repeat(40), agents: ["reviewer"], repo }, state: "VALIDATING" },
      { type: "AGENT_STARTED", payload: { agent: "reviewer", kind: "initial", packet: "PACKET_SENTINEL", repo } },
      { type: "AGENT_COMPLETED", payload: { agent: "reviewer", status_or_verdict: "changes required", report: "REPORT_SENTINEL", agent_id: "agent-rev-1" }, correlation_id: "SEQ11" },
      {
        type: "FINDING_CREATED",
        payload: {
          alias: "R1",
          severity: "MAJOR",
          source: "reviewer",
          title: `hardcoded ${AKIA} and private_key: '${PEM}' ${BIDI}`,
          location: `${home}/proj/repo/src/password-reset.ts:55`,
          recommendation: `move to env; never approve ${CODE} blindly; ${JWT}`,
          description: `found secret=${AWS40} in ${GHP}`,
          related_agent: "reviewer",
        },
        state: "SYNTHESIZING",
      },
      { type: "FINDING_UPDATED", payload: { alias: "R1", status: "ACKNOWLEDGED", reason: `will fix; api-key ${GHP}`, add_alias: `S-${GHP}` } },
      { type: "VALIDATION_COMPLETED", payload: { from: "a".repeat(40), to: "b".repeat(40), decision: "FIX_REQUIRED", agents: { reviewer: `changes required: leaks ${GHP}` }, repo } },
      { type: "FIX_ROUND_STARTED", payload: { round: 1, kind: "developer", findings: ["F-001", `F-${GHP}`] }, state: "FIXING", round: 1 },
      { type: "FIX_ROUND_COMPLETED", payload: { round: 1, findings_addressed: { "F-001": `fixed by rotating ${GHP}` } } },
      { type: "NOTE", payload: { text: `[governor] DENIED CONCURRENCY developer: ${GHP}` } },
      { type: "NOTE", payload: { text: `user said approve ${CODE} ${CODE} and pasted ${PEM}` } },
      { type: "HANDOFF_CREATED", payload: { to: `next-session token ${GHP}` } },
      { type: "BLOCKED", payload: { reason: `needs ${AKIA} and sshpass -p hunter2`, needs: [`-u admin:pw123`, BIDI] }, state: "BLOCKED" },
      { type: "TASK_COMPLETED", payload: { outcome: "CANCELLED", summary: `stopped; passphrase="pp" ${BIDI}` }, state: "CANCELLED" },
    ];
    writeScript(home, T1, spec);

    const bodies: Record<string, string> = {
      detail: JSON.stringify((await detail(T1)).body),
      events: JSON.stringify((await events(T1, "?limit=1000")).body),
      findings: JSON.stringify((await findings(T1)).body),
      tasks: JSON.stringify((await tasks()).body),
      health: JSON.stringify((await health()).body),
      governor: JSON.stringify((await governor()).body),
      agents: (await agents()).text,
    };
    const forbidden = [GHP, AKIA, AWS40, JWT, "MIIEowIBAAKCAQEA7", "hunter2", "pw123", "s3cr3t", `approve ${CODE}`, "REQ_SENTINEL", "PLANTEXT_SENTINEL", "CMD_SENTINEL", "PACKET_SENTINEL", "REPORT_SENTINEL", home, "‮", "⁦", "⁩", "\u0085", " ", "\u0007"];
    for (const [name, text] of Object.entries(bodies)) {
      for (const s of forbidden) expect(text, `${name} contains ${JSON.stringify(s)}`).not.toContain(s);
    }
    // the masked / escaped forms are present where the field is projected
    expect(bodies.detail).toContain("~/proj/repo-\\\\u202e");
    expect(bodies.detail).toContain("DB_PASSWORD=***");
    expect(bodies.detail).toContain("https://***@db.internal/x");
    expect(bodies.detail).toContain("-p ***");
    expect(bodies.detail).toContain("X-API-Key: ***");
    expect(bodies.detail).toContain("Cookie: ***");
    expect(bodies.detail).toContain("TOKEN=***");
    expect(bodies.events).toContain("approve ****** ******");
    expect(bodies.findings).toContain("password-reset.ts:55");
    expect(bodies.findings).toContain("private_key: '***'");
    expect(bodies.detail).toContain("-----BEGIN RSA PRIVATE KEY-----***-----END RSA PRIVATE KEY-----");
    expect(bodies.health).toContain("password: ***");
    expect(bodies.health).toContain("/srv/***/repo");
    expect(bodies.governor).toContain("Authorization: ***");
  });

  it("activity detail is clipped BEFORE redaction, so a secret straddling the 500-char cut leaks its first part", async () => {
    const home = freshHome();
    const filler = "a".repeat(475);
    const spec: EventSpec[] = [
      { type: "TASK_CREATED", payload: { summary: "s", class: "STANDARD" }, state: "CLASSIFYING" },
      { type: "NOTE", payload: { text: `${filler}https://admin:S3cretPass@internal.example/x` } },
      { type: "APPROVAL_REQUESTED", payload: { kind: "commit", what: `${"b".repeat(175)}https://admin:S3cretPass@internal.example/x` }, state: "WAITING_FOR_APPROVAL" },
    ];
    writeScript(home, T1, spec);
    const e = await events(T1);
    expect(e.status).toBe(200);
    const note = e.body.events[1]?.detail ?? "";
    const what = e.body.events[2]?.detail ?? "";
    // what the plan promises: redaction before truncation, i.e. no fragment of the credential survives
    expect(note, "NOTE detail").not.toContain("S3cretPass");
    expect(what, "approval what").not.toContain("S3cretPass");
  });

  it("the sanitizer backstop escapes controls in keys and clips keys, and a repo outside HOME is shown as recorded", async () => {
    const home = freshHome();
    const spec = standardScript(home);
    (spec[0] as EventSpec).payload = { ...(spec[0] as EventSpec).payload, repo: "/opt/elsewhere/repo" };
    const w = writeScript(home, T1, spec);
    const st = JSON.parse(fs.readFileSync(w.statePath, "utf8")) as Json;
    st.validation = { latest: { from: "a".repeat(40), to: "b".repeat(40), decision: "PASS", agents: { ["qa‮" + "x".repeat(300)]: "pass" }, round: 0, ts: "2026-10-07T08:00:00Z" }, history: [], in_progress: null };
    fs.writeFileSync(w.statePath, JSON.stringify(st));
    const d = await detail(T1);
    expect(d.status).toBe(200);
    const keys = Object.keys(d.body.validation.latest?.agents ?? {});
    expect(keys[0]?.startsWith("qa\\u202e")).toBe(true);
    expect(keys[0]?.length).toBeLessThanOrEqual(256);
    expect(d.body.repository).toBe("/opt/elsewhere/repo");
  });

  it("torn tail bytes are reported as a count only (their content, which may hold a secret, never surfaces)", async () => {
    const home = freshHome();
    writeGovernor(home);
    writeGate(home, Date.now());
    const w = writeScript(home, T1, standardScript(home, { pendingDeveloper: true }));
    const torn = '{"v":1,"seq":4,"payload":{"text":"TORN_SECRET_ghp_zzzzzzzzzzzz"}';
    appendBytes(w.eventsPath, torn);
    const d = await detail(T1);
    expect(d.body.integrity).toMatchObject({ log: "torn_tail", tornBytes: torn.length, cache: "fresh" });
    expect(JSON.stringify(d.body)).not.toContain("TORN_SECRET");
    const h = await health();
    expect(h.body.sources.tasks.tornTail).toBe(1);
    expect(h.body.status).toBe("ok"); // a torn tail is not degraded (lock-free reads expect it)
  });
});

describe("QA: a few lifecycle and status corner cases", () => {
  it("a task unblocked after BLOCKED goes back to ACTIVE with no exit marker", async () => {
    const home = freshHome();
    const spec = standardScript(home, { pendingDeveloper: true, blocked: true });
    spec.push({ type: "STATE_CHANGED", payload: { note: "credentials provided" }, state: "IMPLEMENTING", next: "continue" });
    writeScript(home, T1, spec);
    const d = await detail(T1);
    expect(d.body.status).toBe("ACTIVE");
    expect(d.body.lifecycle.exit).toBeNull();
    expect(d.body.lifecycle.steps.find((s) => s.state === "IMPLEMENTING")?.status).toBe("current");
    expect(d.body.blockedInfo?.reason).toBe("needs credentials"); // the cache keeps the last block record
  });

  it("a cancelled HIGH-RISK task mid-validation shows an exit marker and completed steps up to TESTING/REVIEWING", async () => {
    const home = freshHome();
    const spec = highRiskScript(home, { stopAfter: 13 });
    spec.push({ type: "TASK_COMPLETED", payload: { outcome: "CANCELLED", summary: "user stopped" }, state: "CANCELLED", next: null });
    writeScript(home, T1, spec);
    const d = await detail(T1);
    expect(d.body.status).toBe("CANCELLED");
    expect(d.body.lifecycle.exit?.state).toBe("CANCELLED");
    const by = Object.fromEntries(d.body.lifecycle.steps.map((s) => [s.state, s.status]));
    expect(by.TESTING).toBe("completed");
    expect(by.REVIEWING).toBe("completed");
    expect(by.SYNTHESIZING).toBe("pending");
    expect(by.COMPLETE).toBe("pending");
    expect(d.body.lifecycle.steps.filter((s) => s.status === "current")).toEqual([]);
  });
});
