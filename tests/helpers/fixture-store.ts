// Temp fixture stores for the tests. Writes canonical log lines (recursively sorted keys, compact, no
// floats) with a sha256 `prev` chain exactly as brain-state does, and a matching state.json cache
// derived by a port of brain-state's fold. Also builds governor.json and brain-gate files, and can
// add torn tails, corrupt lines, symlinks and hard links. No real data is ever copied here.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rootsFromHome, type BrainRoots } from "@/server/brain/roots";

export type Json = Record<string, unknown>;

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Json = {};
    for (const k of Object.keys(v as Json).sort()) out[k] = sortKeys((v as Json)[k]);
    return out;
  }
  return v;
}

export function canonical(obj: unknown): string {
  return JSON.stringify(sortKeys(obj));
}

/** A fresh HOME for this test; os.homedir() follows it. */
export function freshHome(): string {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bcc-fx-")));
  process.env.HOME = home;
  return home;
}

export function rootsFor(home: string): BrainRoots {
  return rootsFromHome(home);
}

export function mkdirs(home: string): BrainRoots {
  const roots = rootsFromHome(home);
  fs.mkdirSync(roots.tasksDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(roots.governorDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(roots.gateDir, { recursive: true, mode: 0o700 });
  return roots;
}

// ---- events -----------------------------------------------------------------------------------------

export interface EventSpec {
  type: string;
  payload?: Json;
  state?: string | null;
  round?: number;
  next?: string | null;
  ts?: string;
  actor?: string;
  session?: string;
  correlation_id?: string | null;
  key?: string | null;
}

export interface Envelope extends Json {
  v: 1;
  seq: number;
  event_id: string;
  task_id: string;
  ts: string;
  type: string;
  actor: string;
  session: string;
  correlation_id: string | null;
  key: string | null;
  state: string | null;
  round: number;
  next: string | null;
  payload: Json;
  prev: string;
}

export const SESSION_SENTINEL = "11111111-2222-3333-4444-555555555555";

export interface BuiltLog {
  events: Envelope[];
  lines: Buffer[];
  text: Buffer;
}

/** Events → canonical, chained lines. Timestamps advance by 1 s from a fixed base unless given. */
export function buildLog(taskId: string, specs: EventSpec[], baseTs = Date.UTC(2026, 9, 7, 8, 0, 0)): BuiltLog {
  const events: Envelope[] = [];
  const lines: Buffer[] = [];
  let prev = "";
  let state: string | null = null;
  let round = 0;
  let next: string | null = null;
  specs.forEach((s, i) => {
    const seq = i + 1;
    if (s.state !== undefined) state = s.state;
    if (s.round !== undefined) round = s.round;
    if (s.next !== undefined) next = s.next;
    const ev: Envelope = {
      v: 1,
      seq,
      event_id: "E-" + sha256(`${taskId}\0${s.type}\0${seq}`).slice(0, 16),
      task_id: taskId,
      ts: s.ts ?? new Date(baseTs + i * 1000).toISOString(),
      type: s.type,
      actor: s.actor ?? (["TASK_CREATED", "TASK_RESUMED", "LOG_REPAIRED"].includes(s.type) ? "system" : "brain"),
      session: s.session ?? SESSION_SENTINEL,
      correlation_id: s.correlation_id ?? null,
      key: s.key ?? null,
      state,
      round,
      next,
      payload: s.payload ?? {},
      prev,
    };
    const raw = Buffer.from(canonical(ev), "utf8");
    events.push(ev);
    lines.push(raw);
    prev = sha256(raw);
  });
  return { events, lines, text: Buffer.concat(lines.flatMap((l) => [l, Buffer.from("\n")])) };
}

// ---- state.json: a port of brain-state's fold, reduced to the fields the dashboard reads --------------

export function deriveState(taskId: string, built: BuiltLog): Json {
  const st: Json = {
    task_id: taskId,
    created_at: null,
    updated_at: null,
    classification: null,
    classification_reason: null,
    risk_level: null,
    user_request_summary: null,
    request: null,
    parent_task: null,
    current_lifecycle_state: null,
    current_round: 0,
    max_rounds: 2,
    round_epoch: 0,
    repository: null,
    branch: null,
    base_head: null,
    current_head: null,
    snapshots: [],
    working_tree_snapshot: null,
    plan: null,
    plan_seqs: [],
    agents: {},
    findings: {},
    findings_summary: {},
    validation: { latest: null, t_validated: null, in_progress: null, passed_trees: [], history: [], started_seq: 0, last_pass_seq: 0 },
    approvals: [],
    rounds: [],
    handoff_notes: [],
    repairs: [],
    ready: null,
    blocked: null,
    next_action: null,
    status: "ACTIVE",
    outcome: null,
    completion_summary: null,
    owner_session: null,
    sessions: [],
    state_session: null,
    ready_session: null,
    next_session: null,
    post_ready_session: null,
    last_seq: 0,
    last_hash: "",
    last_event_at: null,
    event_count: 0,
    last_content_seq: 0,
    incomplete: true,
    corrupt: null,
  };
  const agents = st.agents as Record<string, Json[]>;
  const findings = st.findings as Record<string, Json>;
  const validation = st.validation as Json;
  const approvals = st.approvals as Json[];
  const rounds = st.rounds as Json[];
  const sessions = st.sessions as string[];
  const findRun = (eid: string | null): Json | undefined => {
    for (const runs of Object.values(agents)) for (const r of runs) if (r.start_event_id === eid) return r;
    return undefined;
  };
  const findFinding = (ref: string): Json | undefined => {
    if (ref in findings) return findings[ref];
    return Object.values(findings).find((f) => (f.aliases as string[]).includes(ref));
  };

  built.events.forEach((ev, i) => {
    const p = ev.payload;
    const seq = ev.seq;
    const ts = ev.ts;
    st.last_seq = seq;
    st.last_hash = sha256(built.lines[i] as Buffer);
    st.last_event_at = ts;
    st.event_count = seq;
    st.updated_at = ts;
    if (seq === 1) st.incomplete = ev.type !== "TASK_CREATED";
    if (!sessions.includes(ev.session)) sessions.push(ev.session);
    switch (ev.type) {
      case "TASK_CREATED":
        st.created_at = ts;
        st.user_request_summary = p.summary;
        st.classification = p.class;
        st.risk_level = p.risk ?? null;
        st.request = p.request ?? null;
        st.parent_task = p.parent_task ?? null;
        st.repository = p.repo ?? null;
        st.branch = p.branch ?? null;
        st.base_head = st.current_head = p.base_head ?? null;
        st.owner_session = ev.session;
        break;
      case "TASK_CLASSIFIED":
        st.classification = p.class;
        st.classification_reason = p.reason;
        if (p.risk) st.risk_level = p.risk;
        st.security_triggers = p.security_triggers ?? [];
        st.qa_triggers = p.qa_triggers ?? [];
        break;
      case "PLAN_CREATED":
        st.plan = { seq, author: p.author ?? null, chars: (p.text as string).length, sha256: sha256(p.text as string), approved: false, approval_seq: null, approved_scope: null, not_approved: null, reopened: false };
        break;
      case "PLAN_APPROVED":
        st.plan = { ...((st.plan as Json) ?? {}), approved: true, approval_seq: seq, approved_scope: p.approved, not_approved: p.not_approved ?? null, approval_event: p.approval ?? null, reopened: false };
        break;
      case "AGENT_STARTED": {
        const list = (agents[p.agent as string] ??= []);
        list.push({
          start_seq: seq,
          start_event_id: ev.event_id,
          complete_seq: null,
          kind: p.kind ?? "initial",
          round: ev.round,
          epoch: st.round_epoch,
          agent_id: p.agent_id ?? null,
          session: ev.session,
          verdict: null,
          from: p.from ?? null,
          to: p.to ?? null,
          repo: p.repo ?? null,
          rerun_reason: p.rerun_reason ?? null,
          started_at: ts,
          completed_at: null,
          validation_state: null,
        });
        break;
      }
      case "AGENT_COMPLETED": {
        const run = findRun(ev.correlation_id);
        if (run) {
          Object.assign(run, { complete_seq: seq, complete_event_id: ev.event_id, complete_content: sha256(canonical(p)), verdict: p.status_or_verdict, completed_at: ts, validation_state: p.validation_state ?? null });
          if (p.agent_id && !run.agent_id) run.agent_id = p.agent_id;
        }
        break;
      }
      case "SNAPSHOT_TAKEN":
        (st.snapshots as Json[]).push({ seq, label: p.label, tree: p.tree, kind: p.kind, repo: p.repo, head: p.head ?? null, branch: p.branch ?? null, ts });
        if (p.head) st.current_head = p.head;
        break;
      case "VALIDATION_STARTED":
        validation.in_progress = { seq, from: p.from, to: p.to, agents: p.agents, repo: p.repo, ts };
        break;
      case "VALIDATION_COMPLETED":
        validation.latest = { seq, from: p.from, to: p.to, decision: p.decision, agents: p.agents, repo: p.repo ?? null, branch: null, head: null, round: ev.round, epoch: st.round_epoch, ts };
        (validation.history as Json[]).push({ seq, from: p.from, to: p.to, decision: p.decision, epoch: st.round_epoch });
        validation.in_progress = null;
        if (p.decision === "PASS") validation.t_validated = p.to;
        break;
      case "FINDING_CREATED": {
        const fid = `F-${String(Object.keys(findings).length + 1).padStart(3, "0")}`;
        const status = (p.status as string | undefined) ?? "OPEN";
        findings[fid] = {
          id: fid,
          aliases: [p.alias],
          sources: [p.source],
          task_id: taskId,
          severity: p.severity,
          status,
          title: p.title,
          description: p.description ?? null,
          location: p.location ?? null,
          recommendation: p.recommendation ?? null,
          created_at: ts,
          updated_at: ts,
          introduced_round: ev.round,
          fixed_round: null,
          validated_round: null,
          related_agent: p.related_agent ?? null,
          related_event_ids: [ev.event_id],
          history: [{ seq, status, ts, reason: null }],
        };
        break;
      }
      case "FINDING_UPDATED": {
        const f = findFinding((p.id as string | undefined) ?? (p.alias as string));
        if (!f) break;
        if (p.status !== f.status) {
          (f.history as Json[]).push({ seq, status: p.status, ts, reason: p.reason ?? null });
          f.status = p.status;
          if (p.status === "FIXED") f.fixed_round = ev.round;
          else if (p.status === "REVALIDATED") f.validated_round = ev.round;
        }
        if (p.add_alias && !(f.aliases as string[]).includes(p.add_alias as string)) (f.aliases as string[]).push(p.add_alias as string);
        f.updated_at = ts;
        break;
      }
      case "APPROVAL_REQUESTED":
        approvals.push({ seq, event_id: ev.event_id, kind: p.kind, what: p.what, gate_code: p.gate_code ?? null, status: "REQUESTED", requested_at: ts, expires: p.expires ?? null, session: ev.session, repo: p.repo ?? null, head: null, command: p.command ?? null, actions: p.actions ?? [], resolved_seq: null, note: null });
        break;
      case "APPROVAL_GRANTED":
      case "APPROVAL_REJECTED":
        for (const a of approvals) if (a.event_id === p.request) Object.assign(a, { status: ev.type === "APPROVAL_GRANTED" ? "GRANTED" : "REJECTED", resolved_seq: seq, resolved_at: ts, resolved_session: ev.session, note: p.note ?? null });
        break;
      case "FIX_ROUND_STARTED":
        st.current_round = p.round;
        rounds.push({ round: p.round, epoch: st.round_epoch, kind: p.kind ?? "developer", findings: p.findings, started_seq: seq, completed_seq: null, findings_addressed: null });
        break;
      case "FIX_ROUND_COMPLETED":
        for (const r of rounds) if (r.round === p.round) Object.assign(r, { completed_seq: seq, findings_addressed: p.findings_addressed ?? {} });
        break;
      case "READY_REACHED":
        st.ready = { seq, t_validated: p.t_validated, t_ready: p.t_ready, production_changed: p.production_changed, ts };
        st.ready_session = ev.session;
        break;
      case "BLOCKED":
        st.blocked = { seq, reason: p.reason, needs: p.needs, ts };
        break;
      case "TASK_COMPLETED":
        st.outcome = p.outcome;
        st.completion_summary = p.summary;
        break;
      default:
        break;
    }
    if (ev.state) st.current_lifecycle_state = ev.state;
    if (ev.next) st.next_action = ev.next;
    if (ev.type === "BLOCKED" && st.blocked && st.current_lifecycle_state !== "BLOCKED" && st.current_lifecycle_state !== "ROUND_CAP_REACHED") st.current_lifecycle_state = "BLOCKED";
    if (ev.type === "TASK_COMPLETED") st.current_lifecycle_state = st.outcome;
  });

  // finalize
  const counts: Record<string, number> = { OPEN: 0, ACKNOWLEDGED: 0, FIXED: 0, REVALIDATED: 0, CLOSED: 0, DEFERRED: 0, REJECTED: 0 };
  const openBySev: Record<string, number> = { BLOCKER: 0, MAJOR: 0, MINOR: 0, NIT: 0 };
  for (const f of Object.values(findings)) {
    counts[f.status as string] = (counts[f.status as string] ?? 0) + 1;
    if (["OPEN", "ACKNOWLEDGED", "FIXED", "REVALIDATED"].includes(f.status as string)) openBySev[f.severity as string] = (openBySev[f.severity as string] ?? 0) + 1;
  }
  st.findings_summary = { total: Object.keys(findings).length, open: Object.values(openBySev).reduce((a, b) => a + b, 0), by_status: counts, open_by_severity: openBySev };
  const lc = st.current_lifecycle_state;
  if (st.incomplete) st.status = "INCOMPLETE";
  else if (st.outcome) st.status = st.outcome;
  else if (lc === "BLOCKED" || lc === "ROUND_CAP_REACHED") st.status = "BLOCKED";
  else if (lc === "WAITING_FOR_APPROVAL" || lc === "HUMAN_APPROVAL") st.status = "WAITING";
  else st.status = "ACTIVE";
  return st;
}

// ---- writing --------------------------------------------------------------------------------------

export interface WrittenTask {
  dir: string;
  eventsPath: string;
  statePath: string;
  built: BuiltLog;
  state: Json;
}

export function writeTask(home: string, taskId: string, specs: EventSpec[], opts: { state?: Json | string | null; noState?: boolean } = {}): WrittenTask {
  const roots = mkdirs(home);
  const dir = path.join(roots.tasksDir, taskId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const built = buildLog(taskId, specs);
  const eventsPath = path.join(dir, "events.jsonl");
  fs.writeFileSync(eventsPath, built.text, { mode: 0o600 });
  const state = typeof opts.state === "object" && opts.state !== null ? opts.state : deriveState(taskId, built);
  const statePath = path.join(dir, "state.json");
  if (!opts.noState) {
    const body = typeof opts.state === "string" ? opts.state : JSON.stringify(state, null, 1) + "\n";
    fs.writeFileSync(statePath, body, { mode: 0o600 });
  }
  fs.writeFileSync(path.join(dir, "lock"), "", { mode: 0o600 });
  return { dir, eventsPath, statePath, built, state };
}

export function appendBytes(file: string, bytes: Buffer | string): void {
  fs.appendFileSync(file, bytes);
}

/** Replaces line `lineNo` (1-based) of a log with `replacement` (without newline). */
export function replaceLine(file: string, lineNo: number, replacement: string): void {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines[lineNo - 1] = replacement;
  fs.writeFileSync(file, lines.join("\n"));
}

export const VALID_POLICY: Json = {
  v: 1,
  _note: "test policy",
  agents: {
    planner: { policy_units: 2, model: "opus" },
    developer: { policy_units: 3, model: "fable" },
    qa: { policy_units: 2, model: "fable" },
    reviewer: { policy_units: 2, model: "opus" },
    "security-reviewer": { policy_units: 2, model: "opus" },
  },
  task_budget_policy_units: { SMALL: 12, STANDARD: 28, COMPLEX: 32, "HIGH-RISK": 36 },
  soft_limit_percent: 80,
  max_parallel_agents_per_task: 3,
  global: { max_total_agents: 3, max_developers: 1, max_validators: 3, max_opus_agents: 2, max_fable_agents: 2 },
  stale_after_minutes: 240,
};

export function writeGovernor(home: string, policy: Json | string = VALID_POLICY): string {
  const roots = mkdirs(home);
  const p = path.join(roots.governorDir, "governor.json");
  fs.writeFileSync(p, typeof policy === "string" ? policy : JSON.stringify(policy, null, 1), { mode: 0o600 });
  return p;
}

/** The gate code sentinels are assembled at runtime so no code-like token sits in the test sources. */
export const GATE_CODE_SENTINEL = ["KMN", "PQR"].join("");
export const GATE_CODE_SENTINEL_2 = ["CDE", "FGH"].join("");
export const GATE_SENTINELS = {
  task: "GATETASK_SENTINEL_prompt_text",
  brainLine: "BRAINLINE_SENTINEL",
  display: "DISPLAY_SENTINEL",
  inputs: "INPUTS_SENTINEL",
  envs: "ENVS_SENTINEL",
  approvalUuid: "APPROVALUUID-SENTINEL-0000",
  cwd: "/CWD_SENTINEL/repo",
  auditCommand: "AUDITCMD_SENTINEL git push --force",
};

export function gateStateFixture(nowSec: number): Json {
  const request = (over: Json): Json => ({
    session: SESSION_SENTINEL,
    agent_id: null,
    agent_type: null,
    task: GATE_SENTINELS.task,
    brain_line: GATE_SENTINELS.brainLine,
    tool: "Bash",
    actions: ["commit"],
    display: GATE_SENTINELS.display,
    input_sha256: "ab".repeat(32),
    cwd: GATE_SENTINELS.cwd,
    repos: [GATE_SENTINELS.cwd],
    envs: { [GATE_SENTINELS.envs]: "1" },
    inputs: [GATE_SENTINELS.inputs],
    created: nowSec - 60,
    expires: nowSec + 1700,
    approved_at: null,
    approval_uuid: null,
    consumed_at: null,
    ...over,
  });
  return {
    v: 1,
    requests: {
      [GATE_CODE_SENTINEL]: request({}),
      [GATE_CODE_SENTINEL_2]: request({ actions: ["push", "commit"], expires: nowSec - 10 }),
      ["WXY" + "347"]: request({ consumed_at: nowSec - 30, approval_uuid: GATE_SENTINELS.approvalUuid, approved_at: nowSec - 40 }),
    },
    validations: [
      { kind: "git", from: "a".repeat(40), to: "b".repeat(40), to_given: "b".repeat(40), session: SESSION_SENTINEL, agent_id: "agent-xyz", agent_type: "reviewer", repo: GATE_SENTINELS.cwd, verdict: "approve", ts: nowSec - 100 },
      { kind: "git", from: "c".repeat(40), to: "d".repeat(40), to_given: "d".repeat(40), session: SESSION_SENTINEL, agent_id: "agent-abc", agent_type: "qa", repo: GATE_SENTINELS.cwd, verdict: "changes required", ts: nowSec - 50 },
    ],
    ready: { [SESSION_SENTINEL]: { count: 1 } },
  };
}

/** Sentinels for the request and event fields the Approval Center must never read or emit. */
export const APPROVAL_SENTINELS = {
  approvalPromptId: "PROMPTID_SENTINEL",
  agentId: "AGENTID_SENTINEL",
  inputSha: "INPUTSHA_SENTINEL",
  eventCommand: "EVENTCMD_SENTINEL git commit -m x",
};

/**
 * One gate request in brain-gate's real shape (`repos` as `{top, head}` bindings), with every field the
 * dashboard must not read set to a sentinel. Times are epoch seconds.
 */
export function gateRequestRecord(nowSec: number, over: Json = {}): Json {
  return {
    session: SESSION_SENTINEL,
    agent_id: APPROVAL_SENTINELS.agentId,
    agent_type: "developer",
    task: GATE_SENTINELS.task,
    brain_line: GATE_SENTINELS.brainLine,
    tool: "Bash",
    actions: ["commit"],
    display: GATE_SENTINELS.display,
    input_sha256: APPROVAL_SENTINELS.inputSha,
    cwd: GATE_SENTINELS.cwd,
    repos: [{ top: "/work/repo", head: "a".repeat(40) }],
    envs: { [GATE_SENTINELS.envs]: "1" },
    inputs: [GATE_SENTINELS.inputs],
    created: nowSec - 60,
    expires: nowSec + 1740,
    approved_at: null,
    approval_uuid: GATE_SENTINELS.approvalUuid,
    approval_prompt_id: APPROVAL_SENTINELS.approvalPromptId,
    consumed_at: null,
    ...over,
  };
}

/** A Brain-recorded gate APPROVAL_REQUESTED event, carrying a code and a command the dashboard must never read. */
export function gateApprovalEvent(ts: string, fields: { repo?: string; head?: string; actions?: string[]; expires?: string } = {}): EventSpec {
  return { type: "APPROVAL_REQUESTED", ts, payload: { kind: "gate", what: "a gated git action", gate_code: GATE_CODE_SENTINEL, command: APPROVAL_SENTINELS.eventCommand, ...fields } };
}

export function auditFixture(nowMs: number): string {
  const line = (event: string, ageMs: number, extra: Json = {}): string =>
    JSON.stringify({ ts: new Date(nowMs - ageMs).toISOString(), event, session: SESSION_SENTINEL, tool: "Bash", code: GATE_CODE_SENTINEL, command: GATE_SENTINELS.auditCommand, cwd: GATE_SENTINELS.cwd, ...extra });
  return [line("DENY_GATED", 60_000), line("FAIL_CLOSED", 120_000), line("FAIL_CLOSED", 30_000), line("VALIDATION_RECORDED", 10_000), line("DENY_GATED", 48 * 3600_000), line("WEIRD_EVENT", 5_000)].join("\n") + "\n";
}

export function writeGate(home: string, nowMs: number, over: { state?: Json | string; audit?: string } = {}): { statePath: string; auditPath: string } {
  const roots = mkdirs(home);
  const statePath = path.join(roots.gateDir, "state.json");
  const auditPath = path.join(roots.gateDir, "audit.jsonl");
  const state = over.state ?? gateStateFixture(Math.floor(nowMs / 1000));
  fs.writeFileSync(statePath, typeof state === "string" ? state : JSON.stringify(state), { mode: 0o600 });
  fs.writeFileSync(auditPath, over.audit ?? auditFixture(nowMs), { mode: 0o600 });
  return { statePath, auditPath };
}

// ---- fingerprints ---------------------------------------------------------------------------------

export interface Fingerprint {
  /** every file and directory under the root: content hash (files), size, inode, link count and integer-ns mtime */
  [rel: string]: { kind: "file" | "dir" | "symlink" | "other"; sha256: string | null; size: string; ino: string; nlink: string; mtimeNs: string };
}

/** Deterministic: bigint stats (no float mtimes), directories included, so a created or removed entry shows up. */
export function fingerprint(dir: string): Fingerprint {
  const out: Fingerprint = {};
  const record = (p: string, kind: Fingerprint[string]["kind"], sha: string | null) => {
    const st = fs.lstatSync(p, { bigint: true });
    out[path.relative(dir, p) || "."] = { kind, sha256: sha, size: st.size.toString(), ino: st.ino.toString(), nlink: st.nlink.toString(), mtimeNs: st.mtimeNs.toString() };
  };
  const walk = (d: string) => {
    record(d, "dir", null);
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isSymbolicLink()) record(p, "symlink", null);
      else if (ent.isDirectory()) walk(p);
      else if (ent.isFile()) record(p, "file", sha256(fs.readFileSync(p)));
      else record(p, "other", null);
    }
  };
  walk(dir);
  return out;
}

// ---- scenarios ------------------------------------------------------------------------------------

export const SENTINELS = {
  packet: "PACKET_SENTINEL_9f3a verbatim packet text",
  report: "REPORT_SENTINEL_7b2c verbatim report text",
  request: "REQUEST_SENTINEL_5d1e the user's verbatim request",
  planText: "PLANTEXT_SENTINEL_3c4f the plan body",
  command: "COMMAND_SENTINEL git push origin main",
  session: SESSION_SENTINEL,
};

export const REPO_REL = "proj/repo";

/**
 * A HIGH-RISK task through planning, approval, implementation, validation with findings, one fix round,
 * revalidation, READY, HUMAN_APPROVAL and (optionally) COMPLETE. `stopAfter` cuts the script early.
 */
export function highRiskScript(home: string, opts: { complete?: boolean; stopAfter?: number } = {}): EventSpec[] {
  const repo = path.join(home, REPO_REL);
  const specs: EventSpec[] = [
    { type: "TASK_CREATED", payload: { summary: "Build the dashboard", class: "HIGH-RISK", request: SENTINELS.request, repo, branch: "main", base_head: "1".repeat(40), risk: "new HTTP surface" }, state: "CLASSIFYING", round: 0, next: "classify" },
    { type: "TASK_CLASSIFIED", payload: { class: "HIGH-RISK", reason: "new local HTTP surface over sensitive data", risk: "high", security_triggers: ["file paths from input"], qa_triggers: ["behavior"] }, state: "PLANNING", next: "launch planner" },
    { type: "AGENT_STARTED", payload: { agent: "planner", kind: "initial", packet: SENTINELS.packet, repo }, state: "PLANNING" },
    { type: "AGENT_COMPLETED", payload: { agent: "planner", status_or_verdict: "PLAN_READY", report: SENTINELS.report, agent_id: "agent-planner-1" }, correlation_id: "SEQ3" },
    { type: "PLAN_CREATED", payload: { text: SENTINELS.planText, author: "planner" } },
    { type: "APPROVAL_REQUESTED", payload: { kind: "plan", what: "approve the plan", command: SENTINELS.command, gate_code: GATE_CODE_SENTINEL_2 }, state: "WAITING_FOR_APPROVAL", next: "wait" },
    { type: "APPROVAL_GRANTED", payload: { request: "SEQ6", note: "approved by user" } },
    { type: "PLAN_APPROVED", payload: { plan_seq: 5, approved: ["the plan", "deps"], not_approved: ["eslint"], approval: "SEQ7" }, state: "IMPLEMENTING", next: "launch developer" },
    { type: "SNAPSHOT_TAKEN", payload: { label: "T0", repo, kind: "git", tree: "a".repeat(40), head: "2".repeat(40), branch: "main" } },
    { type: "AGENT_STARTED", payload: { agent: "developer", kind: "initial", packet: SENTINELS.packet, repo }, state: "IMPLEMENTING" },
    { type: "AGENT_COMPLETED", payload: { agent: "developer", status_or_verdict: "done", report: SENTINELS.report, agent_id: "agent-dev-1", files_changed: ["src/a.ts", "src/b.ts"], tests_run: [{ cmd: "pnpm test", result: "pass 12" }] }, correlation_id: "SEQ10" },
    { type: "SNAPSHOT_TAKEN", payload: { label: "T1", repo, kind: "git", tree: "b".repeat(40), head: "3".repeat(40) } },
    { type: "VALIDATION_STARTED", payload: { from: "a".repeat(40), to: "b".repeat(40), agents: ["qa", "reviewer", "security-reviewer"], repo }, state: "VALIDATING", next: "wait for validators" },
    { type: "AGENT_STARTED", payload: { agent: "qa", kind: "initial", packet: SENTINELS.packet, from: "a".repeat(40), to: "b".repeat(40), repo } },
    { type: "AGENT_STARTED", payload: { agent: "reviewer", kind: "initial", packet: SENTINELS.packet, from: "a".repeat(40), to: "b".repeat(40), repo } },
    { type: "AGENT_STARTED", payload: { agent: "security-reviewer", kind: "initial", packet: SENTINELS.packet, from: "a".repeat(40), to: "b".repeat(40), repo } },
    { type: "AGENT_COMPLETED", payload: { agent: "qa", status_or_verdict: "pass with concerns", report: SENTINELS.report, agent_id: "agent-qa-1", findings: ["Q1"] }, correlation_id: "SEQ14" },
    { type: "AGENT_COMPLETED", payload: { agent: "reviewer", status_or_verdict: "changes required", report: SENTINELS.report, agent_id: "agent-rev-1", findings: ["R1"] }, correlation_id: "SEQ15" },
    { type: "AGENT_COMPLETED", payload: { agent: "security-reviewer", status_or_verdict: "approve", report: SENTINELS.report, agent_id: "agent-sec-1" }, correlation_id: "SEQ16" },
    { type: "FINDING_CREATED", payload: { alias: "R1", severity: "MAJOR", source: "reviewer", title: "Host guard misses Origin", location: "src/server/http.ts:12", recommendation: "check Origin", related_agent: "reviewer" }, state: "SYNTHESIZING", next: "synthesize" },
    { type: "FINDING_CREATED", payload: { alias: "Q1", severity: "MINOR", source: "qa", title: "Empty state text missing", location: "src/app/page.tsx", status: "ACKNOWLEDGED" } },
    { type: "FINDING_UPDATED", payload: { alias: "R1", status: "ACKNOWLEDGED" } },
    { type: "VALIDATION_COMPLETED", payload: { from: "a".repeat(40), to: "b".repeat(40), decision: "FIX_REQUIRED", agents: { qa: "pass with concerns", reviewer: "changes required", "security-reviewer": "approve" }, repo } },
    { type: "FIX_ROUND_STARTED", payload: { round: 1, kind: "developer", findings: ["F-001"] }, state: "FIXING", round: 1, next: "fix R1" },
    { type: "AGENT_STARTED", payload: { agent: "developer", kind: "fix", agent_id: "agent-dev-1", packet: SENTINELS.packet, repo } },
    { type: "AGENT_COMPLETED", payload: { agent: "developer", status_or_verdict: "done", report: SENTINELS.report, agent_id: "agent-dev-1", files_changed: ["src/server/http.ts"], tests_run: [{ cmd: "pnpm test", result: "pass 13" }] }, correlation_id: "SEQ25" },
    { type: "FINDING_UPDATED", payload: { alias: "R1", status: "FIXED", reason: "Origin now checked" } },
    { type: "FIX_ROUND_COMPLETED", payload: { round: 1, findings_addressed: { "F-001": "fixed" } } },
    { type: "SNAPSHOT_TAKEN", payload: { label: "T2", repo, kind: "git", tree: "c".repeat(40), head: "4".repeat(40) } },
    { type: "VALIDATION_STARTED", payload: { from: "b".repeat(40), to: "c".repeat(40), agents: ["reviewer"], repo }, state: "REVALIDATING", next: "wait for reviewer" },
    { type: "AGENT_STARTED", payload: { agent: "reviewer", kind: "revalidation", packet: SENTINELS.packet, from: "b".repeat(40), to: "c".repeat(40), repo } },
    { type: "AGENT_COMPLETED", payload: { agent: "reviewer", status_or_verdict: "approve", report: SENTINELS.report, agent_id: "agent-rev-2" }, correlation_id: "SEQ31" },
    { type: "FINDING_UPDATED", payload: { alias: "R1", status: "REVALIDATED" }, state: "SYNTHESIZING" },
    { type: "FINDING_UPDATED", payload: { id: "F-001", status: "CLOSED" } },
    { type: "FINDING_UPDATED", payload: { alias: "Q1", status: "DEFERRED", reason: "follow-up" } },
    { type: "VALIDATION_COMPLETED", payload: { from: "b".repeat(40), to: "c".repeat(40), decision: "PASS", agents: { reviewer: "approve" }, repo } },
    { type: "READY_REACHED", payload: { t_validated: "c".repeat(40), t_ready: "c".repeat(40), production_changed: false }, state: "READY", next: "final report" },
    { type: "NOTE", payload: { text: "[governor] DENIED CONCURRENCY qa: global total 3/3" } },
    { type: "NOTE", payload: { text: "[governor] SOFT_LIMIT accepted: worth it" } },
    { type: "STATE_CHANGED", payload: { note: "user wants a commit" }, state: "HUMAN_APPROVAL", next: "await APPROVE" },
  ];
  if (opts.complete) {
    specs.push({ type: "TASK_COMPLETED", payload: { outcome: "COMPLETE", summary: "shipped" }, state: "COMPLETE", next: null });
  }
  return opts.stopAfter !== undefined ? specs.slice(0, opts.stopAfter) : specs;
}

/** Writes a task from a script, resolving `SEQ<n>` placeholders (correlation_id, request, approval) to that seq's event id. */
export function writeScript(home: string, taskId: string, specs: EventSpec[], opts: Parameters<typeof writeTask>[3] = {}): WrittenTask {
  const idOf = (i: number, type: string) => "E-" + sha256(`${taskId}\0${type}\0${i}`).slice(0, 16);
  const resolved = specs.map((s) => {
    const fix = (v: unknown): unknown => {
      if (typeof v === "string" && /^SEQ\d+$/.test(v)) {
        const n = Number(v.slice(3));
        const target = specs[n - 1];
        return target ? idOf(n, target.type) : v;
      }
      return v;
    };
    const payload: Json = {};
    for (const [k, v] of Object.entries(s.payload ?? {})) payload[k] = fix(v);
    return { ...s, payload, correlation_id: fix(s.correlation_id ?? null) as string | null };
  });
  return writeTask(home, taskId, resolved, opts);
}

export function standardScript(home: string, opts: { pendingDeveloper?: boolean; blocked?: boolean; cancelled?: boolean } = {}): EventSpec[] {
  const repo = path.join(home, REPO_REL);
  const specs: EventSpec[] = [
    { type: "TASK_CREATED", payload: { summary: "Fix the thing", class: "STANDARD", request: SENTINELS.request, repo }, state: "CLASSIFYING", round: 0, next: "classify" },
    { type: "TASK_CLASSIFIED", payload: { class: "STANDARD", reason: "one module", security_triggers: [], qa_triggers: [] }, state: "IMPLEMENTING", next: "launch developer" },
    { type: "AGENT_STARTED", payload: { agent: "developer", kind: "initial", packet: SENTINELS.packet, repo } },
  ];
  if (!opts.pendingDeveloper) {
    specs.push({ type: "AGENT_COMPLETED", payload: { agent: "developer", status_or_verdict: "done", report: SENTINELS.report, agent_id: "agent-dev-9", files_changed: ["x.ts"] }, correlation_id: "SEQ3" });
  }
  if (opts.blocked) specs.push({ type: "BLOCKED", payload: { reason: "needs credentials", needs: ["DB access"] }, state: "BLOCKED", next: "ask the user" });
  if (opts.cancelled) specs.push({ type: "TASK_COMPLETED", payload: { outcome: "CANCELLED", summary: "user stopped" }, state: "CANCELLED", next: null });
  return specs;
}
