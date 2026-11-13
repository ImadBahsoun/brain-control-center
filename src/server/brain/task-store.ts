import "server-only";
import path from "node:path";
import type {
  AgentRun,
  CacheFreshness,
  EventsResponse,
  FindingsResponse,
  LifecycleTransition,
  LogIntegrity,
  TaskDetail,
  TaskEta,
  TaskIntegrity,
  TaskStatus,
  TaskSummary,
  TasksResponse,
} from "@/lib/api-types";
import { estimateEta, ETA_HISTORY_TASKS, historyFromRuns, type EtaHistory } from "@/lib/eta";
import { buildLifecycle } from "@/lib/lifecycle";
import { sanitizedPrefix } from "../sanitize";
import { projectAgentRuns } from "./agents";
import { activityFromEvents, parseLog, parseTail, type BrainEvent, type ParsedLog } from "./events";
import { aliasMap, emptyCount, projectFindings, summarizeFindings, topOpenFindings } from "./findings";
import { governorNotes, taskUsage, unitsByRole, type PolicyResult } from "./governor";
import { asArr, asBool, asInt, asObj, asStr, asStrRecord, asStrs, parseJson, type JsonObj } from "./jsonish";
import type { BrainRoots } from "./roots";
import { CAPS, checkDir, FILE_NAMES, isTaskId, listTaskDirs, readCapped, readTail, realDir } from "./safe-fs";

/**
 * Lock-free, read-only loading of tasks: state.json (the cache) first, then events.jsonl (the truth).
 * The log only grows, so a reader can never see a false "cache ahead"; a transient "stale" clears on
 * the next poll. Nothing here takes a lock, writes, or follows a symlink.
 */

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["COMPLETE", "CANCELLED"]);
const STATUSES = new Set<string>(["ACTIVE", "WAITING", "BLOCKED", "COMPLETE", "CANCELLED", "CORRUPT", "INCOMPLETE"]);

export interface StoreCheck {
  status: "ok" | "missing" | "unsafe";
  realTasksDir: string | null;
}

export async function checkStore(roots: BrainRoots): Promise<StoreCheck> {
  const realClaude = await realDir(roots.claudeDir);
  if (realClaude === null) return { status: "missing", realTasksDir: null };
  const brain = await checkDir(roots.brainStateDir, path.join(realClaude, "state", "brain"));
  if (brain.status !== "ok") return { status: brain.status, realTasksDir: null };
  const realTasksDir = path.join(realClaude, "state", "brain", "tasks");
  const tasks = await checkDir(roots.tasksDir, realTasksDir);
  if (tasks.status !== "ok") return { status: tasks.status, realTasksDir: null };
  return { status: "ok", realTasksDir };
}

export interface LoadedTask {
  id: string;
  /** The validated state.json record, when it exists and is a cache of this task (whatever its freshness). */
  cache: JsonObj | null;
  /** true when the cache is fresh or stale and was used for the summary. */
  cacheUsed: boolean;
  /** The full log parse, when the whole log was read. */
  log: ParsedLog | null;
  integrity: TaskIntegrity;
  derived: Derived | null;
  summary: TaskSummary;
}

export type TaskLoad = { kind: "not_found" } | { kind: "unsafe"; reason: string } | { kind: "loaded"; task: LoadedTask };

export interface LoadOptions {
  fullLog: boolean;
  nowMs: number;
  store?: StoreCheck;
}

/** Fields a full log read yields on its own (brain-state's fold, reduced to what the summary needs). */
export interface Derived {
  title: string | null;
  classification: string | null;
  classificationReason: string | null;
  risk: string | null;
  repository: string | null;
  parentTaskId: string | null;
  branch: string | null;
  baseHead: string | null;
  state: string | null;
  round: number;
  next: string | null;
  outcome: string | null;
  completionSummary: string | null;
  blocked: { reason: string | null; needs: string[] } | null;
  plan: TaskDetail["plan"];
  createdAt: string | null;
  lastEventAt: string | null;
  eventCount: number;
  hasTaskCreated: boolean;
  transitions: LifecycleTransition[];
  status: TaskStatus;
}

export function deriveFromLog(events: readonly BrainEvent[]): Derived {
  const d: Derived = {
    title: null,
    classification: null,
    classificationReason: null,
    risk: null,
    repository: null,
    parentTaskId: null,
    branch: null,
    baseHead: null,
    state: null,
    round: 0,
    next: null,
    outcome: null,
    completionSummary: null,
    blocked: null,
    plan: null,
    createdAt: null,
    lastEventAt: null,
    eventCount: events.length,
    hasTaskCreated: events[0]?.type === "TASK_CREATED",
    transitions: [],
    status: "ACTIVE",
  };
  for (const ev of events) {
    const p = ev.payload;
    if (ev.seq === 1) d.createdAt = ev.ts;
    d.lastEventAt = ev.ts;
    switch (ev.type) {
      case "TASK_CREATED":
        d.title = asStr(p.summary);
        d.classification = asStr(p.class);
        d.risk = asStr(p.risk);
        d.repository = asStr(p.repo);
        d.parentTaskId = taskIdOrNull(p.parent_task);
        d.branch = asStr(p.branch);
        d.baseHead = asStr(p.base_head);
        break;
      case "TASK_CLASSIFIED":
        d.classification = asStr(p.class);
        d.classificationReason = asStr(p.reason);
        if (asStr(p.risk)) d.risk = asStr(p.risk);
        break;
      case "PLAN_CREATED":
        d.plan = { author: asStr(p.author), approved: false, approvedScope: [], notApproved: [], chars: asStr(p.text)?.length ?? null };
        break;
      case "PLAN_APPROVED":
        d.plan = {
          author: d.plan?.author ?? null,
          approved: true,
          approvedScope: asStrs(p.approved),
          notApproved: asStrs(p.not_approved),
          chars: d.plan?.chars ?? null,
        };
        break;
      case "BLOCKED":
        d.blocked = { reason: asStr(p.reason), needs: asStrs(p.needs) };
        break;
      case "TASK_COMPLETED":
        d.outcome = asStr(p.outcome);
        d.completionSummary = asStr(p.summary);
        break;
      default:
        break;
    }
    if (ev.state) d.state = ev.state;
    if (ev.round !== null) d.round = ev.round;
    if (ev.next) d.next = ev.next;
    if (ev.type === "BLOCKED" && d.state !== "BLOCKED" && d.state !== "ROUND_CAP_REACHED") d.state = "BLOCKED";
    if (ev.type === "TASK_COMPLETED" && d.outcome) d.state = d.outcome;
    const last = d.transitions[d.transitions.length - 1];
    if (d.state && d.state !== (last?.state ?? null)) d.transitions.push({ state: d.state, seq: ev.seq, ts: ev.ts });
  }
  if (d.outcome === "COMPLETE" || d.outcome === "CANCELLED") d.status = d.outcome;
  else if (d.state === "BLOCKED" || d.state === "ROUND_CAP_REACHED") d.status = "BLOCKED";
  else if (d.state === "WAITING_FOR_APPROVAL" || d.state === "HUMAN_APPROVAL") d.status = "WAITING";
  else d.status = "ACTIVE";
  return d;
}

/** brain-state's read_cache rule: an object with this task_id, an integer last_seq and a string last_hash. */
function validateCache(parsed: unknown, id: string): JsonObj | null {
  const o = asObj(parsed);
  if (!o || o.task_id !== id) return null;
  if (asInt(o.last_seq) === null || typeof o.last_hash !== "string") return null;
  return o;
}

function cacheStatus(cache: JsonObj): TaskStatus {
  const s = asStr(cache.status);
  return s !== null && STATUSES.has(s) ? (s as TaskStatus) : "ACTIVE";
}

function pendingRunsOf(cache: JsonObj | null): number {
  if (!cache) return 0;
  let n = 0;
  for (const runs of Object.values(asObj(cache.agents) ?? {})) {
    for (const r of asArr(runs).map(asObj)) if (r && asStr(r.completed_at) === null) n++;
  }
  return n;
}

export async function loadTask(roots: BrainRoots, id: string, opts: LoadOptions): Promise<TaskLoad> {
  const store = opts.store ?? (await checkStore(roots));
  if (store.status === "missing") return { kind: "not_found" };
  if (store.status === "unsafe" || store.realTasksDir === null) return { kind: "unsafe", reason: "tasks root" };
  // turbopackIgnore: the id is validated and the roots are fixed; this is a runtime read, not an asset to trace
  const dir = path.join(/*turbopackIgnore: true*/ roots.tasksDir, id);
  const check = await checkDir(dir, path.join(/*turbopackIgnore: true*/ store.realTasksDir, id));
  if (check.status === "missing") return { kind: "not_found" };
  if (check.status === "unsafe") return { kind: "unsafe", reason: check.reason };

  // 1. the cache
  let cache: JsonObj | null = null;
  let cacheState: CacheFreshness;
  const cacheRead = await readCapped(dir, FILE_NAMES.state, CAPS.taskState);
  if (cacheRead.status === "ok") {
    cache = validateCache(parseJson(cacheRead.data), id);
    cacheState = cache ? "fresh" : "invalid";
  } else if (cacheRead.status === "error") cacheState = "invalid";
  else cacheState = cacheRead.status;
  const cacheSeq = cache ? (asInt(cache.last_seq) ?? 0) : 0;
  const cacheHash = cache ? (asStr(cache.last_hash) ?? "") : "";

  // 2. the log. A terminal task with a cache is first checked from the log's tail: when the tail's last
  //    complete line is exactly the cache's (same seq, same hash) the cache is proven fresh and the whole
  //    log is not read. Anything else (an older or newer cache, a hash that does not match, a last line
  //    longer than the tail window) falls back to a full read, so the status always comes from the log.
  const terminalCached = cache !== null && TERMINAL_STATUSES.has(cacheStatus(cache));
  let full = opts.fullLog || cache === null || !terminalCached;
  let log: ParsedLog | null = null;
  const integrity: TaskIntegrity = { log: "ok", chainChecked: false, cache: cacheState, logSeq: 0, cacheSeq: cache ? cacheSeq : null };
  if (!full) {
    const r = await readTail(dir, FILE_NAMES.events, CAPS.eventsTail);
    if (r.status === "ok") {
      const tail = parseTail(r.data, r.offset, id);
      if (tail.lastSeq !== null && tail.lastSeq === cacheSeq && tail.lastHash === cacheHash) {
        integrity.logSeq = tail.lastSeq;
        integrity.log = tail.tornBytes > 0 ? "torn_tail" : "ok";
        if (tail.tornBytes > 0) integrity.tornBytes = tail.tornBytes;
        integrity.cache = "fresh";
      } else full = true;
    } else integrity.log = unreadable(r.status);
  }
  if (full) {
    integrity.chainChecked = true;
    const r = await readCapped(dir, FILE_NAMES.events, CAPS.eventsFull);
    if (r.status === "ok") {
      log = parseLog(r.data, id);
      integrity.log = log.integrity;
      integrity.logSeq = log.lastSeq;
      if (log.corruptLine !== undefined) integrity.corruptLine = log.corruptLine;
      if (log.corruptReason !== undefined) integrity.corruptReason = log.corruptReason;
      if (log.tornBytes > 0) integrity.tornBytes = log.tornBytes;
      if (cache !== null) integrity.cache = freshness(cacheSeq, cacheHash, log);
    } else integrity.log = unreadable(r.status);
  }
  // 3. a cache that could not be checked against the log is not used
  if (cache !== null && (integrity.log === "missing" || integrity.log === "unsafe" || integrity.log === "too_large")) integrity.cache = "unknown";
  const cacheUsed = cache !== null && (integrity.cache === "fresh" || integrity.cache === "stale");

  // 4. the summary
  const derived = log ? deriveFromLog(log.events) : null;
  const summary = buildSummary(id, cache, cacheUsed, derived, integrity);
  return { kind: "loaded", task: { id, cache, cacheUsed, log, integrity, derived, summary } };
}

function unreadable(status: "missing" | "unsafe" | "too_large" | "error"): LogIntegrity {
  return status === "error" ? "unsafe" : status;
}

/**
 * brain-state's cache_ahead, over a fully parsed log: a cache claiming more events than the log is
 * "ahead"; one whose last_hash is not the hash of log line last_seq was "derived from a different
 * history" (diverged); otherwise it is fresh (same seq) or stale (the log has grown since).
 */
function freshness(cacheSeq: number, cacheHash: string, log: ParsedLog): CacheFreshness {
  if (cacheSeq > log.lastSeq) return "ahead";
  if (cacheSeq === 0) return log.lastSeq === 0 ? "fresh" : "stale";
  if (log.hashes[cacheSeq - 1] !== cacheHash) return "diverged";
  return cacheSeq === log.lastSeq ? "fresh" : "stale";
}

function buildSummary(id: string, cache: JsonObj | null, cacheUsed: boolean, derived: Derived | null, integrity: TaskIntegrity): TaskSummary {
  const c = cacheUsed ? cache : null;
  const findings = c ? projectFindings(c.findings) : [];
  const count = c ? summarizeFindings(c.findings_summary, findings) : emptyCount();

  let status: TaskStatus = derived?.status ?? (c ? cacheStatus(c) : "ACTIVE");
  const state = derived?.state ?? (c ? asStr(c.current_lifecycle_state) : null);
  if (integrity.log === "corrupt") status = "CORRUPT";
  else if (integrity.log === "incomplete" || integrity.log === "missing") status = "INCOMPLETE";
  else if (integrity.log === "unsafe" || integrity.log === "too_large") status = "CORRUPT";

  const terminal = TERMINAL_STATUSES.has(status);
  return {
    id,
    title: derived?.title ?? (c ? asStr(c.user_request_summary) : null),
    classification: derived?.classification ?? (c ? asStr(c.classification) : null),
    state,
    // brain-state's current_round (reset by a scope-change approval) when the cache is used; the log otherwise
    round: c ? (asInt(c.current_round) ?? 0) : (derived?.round ?? 0),
    maxRounds: c ? (asInt(c.max_rounds) ?? 2) : 2,
    status,
    active: status === "ACTIVE" || status === "WAITING" || status === "BLOCKED",
    blocked: status === "BLOCKED",
    ready: state === "READY" && !terminal,
    waitingApproval: status === "WAITING",
    createdAt: derived?.createdAt ?? (c ? asStr(c.created_at) : null),
    updatedAt: derived?.lastEventAt ?? (c ? asStr(c.updated_at) : null),
    lastEventAt: derived?.lastEventAt ?? (c ? asStr(c.last_event_at) : null),
    eventCount: derived?.eventCount ?? (c ? (asInt(c.event_count) ?? 0) : 0),
    findings: count,
    topOpenFindings: topOpenFindings(findings),
    pendingRuns: pendingRunsOf(c),
    summaryUnavailable: !cacheUsed,
    integrity,
    repository: derived?.repository ?? strOrNull(c, "repository"),
    parentTaskId: derived?.parentTaskId ?? (c ? taskIdOrNull(c.parent_task) : null),
    // no structured step metadata exists yet; never read a step from free text
    parentStepId: null,
  };
}

export interface Scan {
  store: StoreCheck;
  listing: Awaited<ReturnType<typeof listTaskDirs>>;
  tasks: LoadedTask[];
  unsafeTasks: number;
}

/** Every task under the root (newest first, capped), loaded without forcing full log reads. */
export async function scanTasks(roots: BrainRoots, nowMs: number): Promise<Scan> {
  const store = await checkStore(roots);
  if (store.status !== "ok") {
    return { store, listing: { status: store.status, ids: [], unsafeEntries: 0, scanLimitReached: false }, tasks: [], unsafeTasks: 0 };
  }
  const listing = await listTaskDirs(roots.tasksDir);
  const tasks: LoadedTask[] = [];
  let unsafeTasks = 0;
  for (const id of listing.ids) {
    const r = await loadTask(roots, id, { fullLog: false, nowMs, store });
    if (r.kind === "loaded") tasks.push(r.task);
    else if (r.kind === "unsafe") unsafeTasks++;
  }
  return { store, listing, tasks, unsafeTasks };
}

/**
 * The ETA of one listed task (src/lib/eta.ts): its runs, round epoch and triggers from state.json and, when the
 * whole log was read, its events. Without a usable state.json the runs are unknown, so no number is given.
 */
function taskEta(task: LoadedTask, policy: PolicyResult | undefined, history: EtaHistory, nowMs: number): TaskEta {
  const c = task.cacheUsed ? task.cache : null;
  const events = task.log?.events ?? [];
  const denied = governorNotes(task.id, events).denials.filter((d) => d.code === "CONCURRENCY");
  return estimateEta({
    status: task.summary.status,
    state: task.summary.state,
    classification: task.summary.classification,
    round: task.summary.round,
    roundEpoch: c ? (asInt(c.round_epoch) ?? 0) : 0,
    createdAt: task.summary.createdAt,
    lastEventAt: task.summary.lastEventAt,
    qaTriggers: c ? asStrs(c.qa_triggers).length > 0 : false,
    securityTriggers: c ? asStrs(c.security_triggers).length > 0 : false,
    runsKnown: c !== null,
    runs: agentRunsOf(task, policy, nowMs),
    events,
    concurrencyDeniedSeq: denied.reduce((n, d) => Math.max(n, d.seq), 0),
    history,
    nowMs,
  });
}

/** `policy` feeds agentRunsOf for the ETA (its stale threshold, else 240 minutes); every task carries `eta`. */
export function tasksResponse(scan: Scan, nowMs: number, policy?: PolicyResult): TasksResponse {
  // history: the newest 20 COMPLETE tasks of the scan (it is newest first), built once per response
  const history = historyFromRuns(
    scan.tasks
      .filter((t) => t.summary.status === "COMPLETE")
      .slice(0, ETA_HISTORY_TASKS)
      .map((t) => agentRunsOf(t, policy, nowMs)),
  );
  const tasks = scan.tasks.map((t) => ({ ...t.summary, eta: taskEta(t, policy, history, nowMs) }));
  const counts = {
    total: tasks.length,
    active: tasks.filter((t) => t.active).length,
    blocked: tasks.filter((t) => t.blocked).length,
    waitingApproval: tasks.filter((t) => t.waitingApproval).length,
    ready: tasks.filter((t) => t.ready).length,
    corrupt: tasks.filter((t) => t.status === "CORRUPT").length,
    openFindings: tasks.filter((t) => !TERMINAL_STATUSES.has(t.status)).reduce((n, t) => n + t.findings.open, 0),
  };
  return {
    generatedAt: new Date(nowMs).toISOString(),
    tasks,
    counts,
    scan: {
      status: scan.listing.status,
      scanned: tasks.length,
      scanLimitReached: scan.listing.scanLimitReached,
      unsafeEntries: scan.listing.unsafeEntries + scan.unsafeTasks,
    },
  };
}

export function agentRunsOf(task: LoadedTask, policy: PolicyResult | undefined, nowMs: number): AgentRun[] {
  const pol = policy?.status === "ok" ? policy.policy : null;
  return task.cacheUsed && task.cache ? projectAgentRuns(task.id, task.cache.agents, pol, nowMs) : [];
}

/** A detail body for a task directory that failed the safety checks: integrity only, no data. */
export function unsafeDetail(id: string): TaskDetail {
  const integrity: TaskIntegrity = { log: "unsafe", chainChecked: false, cache: "unsafe", logSeq: 0, cacheSeq: null };
  const summary = buildSummary(id, null, false, null, integrity);
  return {
    ...summary,
    repository: null,
    branch: null,
    baseHead: null,
    currentHead: null,
    classificationReason: null,
    risk: null,
    nextAction: null,
    outcome: null,
    completionSummary: null,
    blockedInfo: null,
    plan: null,
    lifecycle: buildLifecycle({ currentState: null, status: "CORRUPT", hasTaskCreated: false, transitions: [] }),
    rounds: [],
    validation: { latest: null, history: [], inProgress: null },
    testsRun: [],
    filesChanged: [],
    agents: [],
    usage: null,
  };
}

function strOrNull(o: JsonObj | null, k: string): string | null {
  return o ? asStr(o[k]) : null;
}

/** A recorded `parent_task`, kept only when it is a well-formed task id (brain-state checks nothing more). */
function taskIdOrNull(v: unknown): string | null {
  return isTaskId(v) ? v : null;
}

/** A tree id shortened to 12 characters (redacted first, like every other cut of Brain text). */
function tree(v: unknown): string | null {
  const s = asStr(v);
  return s === null ? null : sanitizedPrefix(s, 12);
}

export function taskDetail(task: LoadedTask, policy: PolicyResult | undefined, nowMs: number): TaskDetail {
  const { summary, derived } = task;
  const c = task.cacheUsed ? task.cache : null;
  const pol = policy?.status === "ok" ? policy.policy : null;
  const agents = agentRunsOf(task, policy, nowMs);
  const events = task.log?.events ?? [];

  const blockedRaw = c ? asObj(c.blocked) : null;
  const planRaw = c ? asObj(c.plan) : null;
  const plan: TaskDetail["plan"] = planRaw
    ? {
        author: asStr(planRaw.author),
        approved: asBool(planRaw.approved) ?? false,
        approvedScope: asStrs(planRaw.approved_scope),
        notApproved: asStrs(planRaw.not_approved),
        chars: asInt(planRaw.chars),
      }
    : (derived?.plan ?? null);

  const rounds = c
    ? asArr(c.rounds)
        .map(asObj)
        .filter((r): r is JsonObj => r !== null)
        .map((r) => ({
          round: asInt(r.round) ?? 0,
          kind: asStr(r.kind) ?? "developer",
          findings: asStrs(r.findings),
          findingsAddressed: asStrRecord(r.findings_addressed),
          completed: asInt(r.completed_seq) !== null,
        }))
    : [];

  const vRaw = c ? asObj(c.validation) : null;
  const latestRaw = vRaw ? asObj(vRaw.latest) : null;
  const inProgRaw = vRaw ? asObj(vRaw.in_progress) : null;
  const validation: TaskDetail["validation"] = {
    latest: latestRaw
      ? {
          from: tree(latestRaw.from),
          to: tree(latestRaw.to),
          decision: asStr(latestRaw.decision) ?? "",
          agents: asStrRecord(latestRaw.agents),
          round: asInt(latestRaw.round),
          ts: asStr(latestRaw.ts),
        }
      : null,
    history: vRaw
      ? asArr(vRaw.history)
          .map(asObj)
          .filter((h): h is JsonObj => h !== null)
          .map((h) => ({
            decision: asStr(h.decision) ?? "",
            from: tree(h.from),
            to: tree(h.to),
            seq: asInt(h.seq) ?? 0,
          }))
      : [],
    inProgress: inProgRaw
      ? {
          from: tree(inProgRaw.from),
          to: tree(inProgRaw.to),
          agents: asStrs(inProgRaw.agents),
          ts: asStr(inProgRaw.ts),
        }
      : null,
  };

  const testsRun: TaskDetail["testsRun"] = [];
  const filesChanged: TaskDetail["filesChanged"] = [];
  for (const ev of events) {
    if (ev.type !== "AGENT_COMPLETED") continue;
    const agent = asStr(ev.payload.agent) ?? "";
    for (const t of asArr(ev.payload.tests_run).map(asObj)) {
      if (t) testsRun.push({ agent, round: ev.round, cmd: asStr(t.cmd) ?? "", result: asStr(t.result) ?? "" });
    }
    const files = asStrs(ev.payload.files_changed);
    if (files.length > 0) filesChanged.push({ agent, round: ev.round, files: files.slice(0, 500) });
  }

  const transitions = derived?.transitions ?? [];
  const lifecycle = buildLifecycle({
    currentState: summary.state,
    status: summary.status,
    hasTaskCreated: derived?.hasTaskCreated ?? (c !== null && asBool(c.incomplete) === false),
    transitions,
  });

  return {
    ...summary,
    repository: derived?.repository ?? strOrNull(c, "repository"),
    branch: strOrNull(c, "branch") ?? derived?.branch ?? null,
    baseHead: derived?.baseHead ?? strOrNull(c, "base_head"),
    currentHead: strOrNull(c, "current_head") ?? derived?.baseHead ?? null,
    classificationReason: derived?.classificationReason ?? strOrNull(c, "classification_reason"),
    risk: derived?.risk ?? strOrNull(c, "risk_level"),
    nextAction: derived?.next ?? strOrNull(c, "next_action"),
    outcome: derived?.outcome ?? strOrNull(c, "outcome"),
    completionSummary: derived?.completionSummary ?? strOrNull(c, "completion_summary"),
    blockedInfo: blockedRaw ? { reason: asStr(blockedRaw.reason), needs: asStrs(blockedRaw.needs) } : (derived?.blocked ?? null),
    plan,
    lifecycle,
    rounds,
    validation,
    testsRun,
    filesChanged,
    agents,
    usage: pol ? taskUsage(agents, summary.classification, pol) : null,
  };
}

export function eventsResponse(task: LoadedTask, policy: PolicyResult | undefined, limit: number): EventsResponse {
  const events = task.log?.events ?? [];
  const findings = task.cacheUsed && task.cache ? projectFindings(task.cache.findings) : [];
  const pol = policy?.status === "ok" ? policy.policy : null;
  const all = activityFromEvents(events, { aliasToFindingId: aliasMap(findings), unitsByRole: unitsByRole(pol) });
  const slice = all.length > limit ? all.slice(all.length - limit) : all;
  return { taskId: task.id, total: all.length, hasMore: slice.length < all.length, integrity: task.integrity, events: slice };
}

export function findingsResponse(task: LoadedTask): FindingsResponse {
  const findings = task.cacheUsed && task.cache ? projectFindings(task.cache.findings) : [];
  const summary = task.cacheUsed && task.cache ? summarizeFindings(task.cache.findings_summary, findings) : emptyCount();
  return { taskId: task.id, summary, findings, integrity: task.integrity };
}
