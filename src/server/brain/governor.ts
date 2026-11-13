import "server-only";
import path from "node:path";
import type {
  AgentRun,
  GlobalUsage,
  GovernorDenial,
  GovernorGlobalLimits,
  GovernorPolicy,
  GovernorSoftLimit,
  PolicyStatus,
  QueuedLaunch,
  QueueWaitOutcome,
  TaskUsage,
} from "@/lib/api-types";
import { latestLaunchActivitySeq } from "@/lib/eta";
import type { BrainEvent } from "./events";
import { asObj, asStr, parseJson, type JsonObj } from "./jsonish";
import type { BrainRoots } from "./roots";
import { CAPS, checkDir, FILE_NAMES, readCapped, realDir } from "./safe-fs";

/** governor.json, parsed as strictly as brain-governor parses it, plus the budget and global math. */

export const AGENTS = ["planner", "developer", "qa", "reviewer", "security-reviewer"] as const;
export const VALIDATORS: ReadonlySet<string> = new Set(["qa", "reviewer", "security-reviewer"]);
const BUDGET_CLASSES = ["SMALL", "STANDARD", "COMPLEX", "HIGH-RISK"] as const;
const GLOBAL_LIMITS = ["max_total_agents", "max_developers", "max_validators", "max_opus_agents", "max_fable_agents"] as const;
const POLICY_KEYS = ["v", "_note", "agents", "task_budget_policy_units", "soft_limit_percent", "max_parallel_agents_per_task", "global", "stale_after_minutes"];

export type PolicyResult = { status: "ok"; policy: GovernorPolicy } | { status: Exclude<PolicyStatus, "ok">; reason: string };

class Invalid extends Error {}

function keys(d: unknown, allowed: readonly string[], required: readonly string[], what: string): JsonObj {
  const o = asObj(d);
  if (!o) throw new Invalid(`${what} must be an object`);
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new Invalid(`unknown key ${k} in ${what}`);
  for (const k of required) if (!(k in o)) throw new Invalid(`missing key ${k} in ${what}`);
  return o;
}

function int(v: unknown, lo: number, hi: number, what: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) {
    throw new Invalid(`${what} must be an integer from ${lo} to ${hi}`);
  }
  return v;
}

export function parsePolicy(buf: Buffer): PolicyResult {
  if (buf.length > CAPS.governor) return { status: "too_large", reason: "larger than 64 KiB" };
  const parsed = parseJson(buf);
  if (parsed === undefined) return { status: "invalid", reason: "not valid JSON" };
  try {
    const pol = keys(parsed, POLICY_KEYS, POLICY_KEYS.filter((k) => k !== "_note"), "policy");
    if (pol.v !== 1) throw new Invalid("v must be 1");
    if ("_note" in pol && typeof pol._note !== "string") throw new Invalid("_note must be a string");
    const agentsRaw = keys(pol.agents, AGENTS, AGENTS, "agents");
    const agents: GovernorPolicy["agents"] = {};
    for (const name of AGENTS) {
      const a = keys(agentsRaw[name], ["policy_units", "model"], ["policy_units", "model"], `agents.${name}`);
      const model = a.model;
      if (typeof model !== "string" || model === "") throw new Invalid(`agents.${name}.model must be a non-empty string`);
      agents[name] = { policyUnits: int(a.policy_units, 1, 100, `agents.${name}.policy_units`), model };
    }
    const budgetsRaw = keys(pol.task_budget_policy_units, BUDGET_CLASSES, BUDGET_CLASSES, "task_budget_policy_units");
    const taskBudgets: Record<string, number> = {};
    for (const cls of BUDGET_CLASSES) taskBudgets[cls] = int(budgetsRaw[cls], 1, 10000, `task_budget_policy_units.${cls}`);
    const softLimitPercent = int(pol.soft_limit_percent, 1, 100, "soft_limit_percent");
    const maxParallelPerTask = int(pol.max_parallel_agents_per_task, 1, 20, "max_parallel_agents_per_task");
    const globalRaw = keys(pol.global, GLOBAL_LIMITS, GLOBAL_LIMITS, "global");
    const global = {} as GovernorGlobalLimits;
    for (const k of GLOBAL_LIMITS) global[k] = int(globalRaw[k], 1, 20, `global.${k}`);
    const staleAfterMinutes = int(pol.stale_after_minutes, 10, 10080, "stale_after_minutes");
    return {
      status: "ok",
      policy: {
        version: 1,
        note: asStr(pol._note),
        agents,
        taskBudgets,
        softLimitPercent,
        maxParallelPerTask,
        global,
        staleAfterMinutes,
      },
    };
  } catch (e) {
    if (e instanceof Invalid) return { status: "invalid", reason: e.message };
    return { status: "invalid", reason: "unreadable policy" };
  }
}

export async function loadPolicy(roots: BrainRoots): Promise<PolicyResult> {
  const realClaude = await realDir(roots.claudeDir);
  if (realClaude === null) return { status: "missing", reason: "no policy directory" };
  const dir = await checkDir(roots.governorDir, path.join(realClaude, "brain"));
  if (dir.status === "missing") return { status: "missing", reason: "no policy directory" };
  if (dir.status === "unsafe") return { status: "unsafe", reason: `policy directory ${dir.reason}` };
  const r = await readCapped(roots.governorDir, FILE_NAMES.governor, CAPS.governor);
  if (r.status === "missing") return { status: "missing", reason: "missing policy file" };
  if (r.status === "unsafe") return { status: "unsafe", reason: `policy file ${r.reason}` };
  if (r.status === "too_large") return { status: "too_large", reason: "larger than 64 KiB" };
  if (r.status === "error") return { status: "invalid", reason: "policy file unreadable" };
  return parsePolicy(r.data);
}

/** An agent missing from the policy counts at the maximum unit value (brain-governor's rule). */
export function agentUnits(policy: GovernorPolicy, role: string): number {
  const a = policy.agents[role];
  if (a) return a.policyUnits;
  return Math.max(...Object.values(policy.agents).map((x) => x.policyUnits));
}

export function agentModel(policy: GovernorPolicy | null, role: string): string | null {
  return policy?.agents[role]?.model ?? null;
}

export function unitsByRole(policy: GovernorPolicy | null): Map<string, number> | null {
  if (!policy) return null;
  return new Map(Object.entries(policy.agents).map(([k, v]) => [k, v.policyUnits]));
}

export const USAGE_NOTE = "class budget; session extensions not visible";

/** consumed = Σ units of completed runs (0 for not-launched); reserved = Σ units of pending runs. */
export function taskUsage(runs: readonly AgentRun[], classification: string | null, policy: GovernorPolicy | null): TaskUsage {
  let consumed = 0;
  let reserved = 0;
  if (policy) {
    for (const r of runs) {
      const u = r.status === "not-launched" ? 0 : agentUnits(policy, r.role);
      if (r.status === "pending") reserved += u;
      else consumed += u;
    }
  }
  const committed = consumed + reserved;
  const classBudget = policy && classification ? (policy.taskBudgets[classification] ?? null) : null;
  const percent = classBudget ? Math.round((committed * 100) / classBudget) : null;
  return {
    classBudget,
    consumed,
    reserved,
    committed,
    percentOfClassBudget: percent,
    softLimitCrossed: policy && classBudget ? committed * 100 > policy.softLimitPercent * classBudget : null,
    note: USAGE_NOTE,
  };
}

/** Pending runs across non-terminal tasks, with runs older than stale_after_minutes left out. */
export function globalUsage(pending: readonly AgentRun[], policy: GovernorPolicy | null, now: number): GlobalUsage {
  const out: GlobalUsage = { pendingTotal: 0, pendingDevelopers: 0, pendingValidators: 0, pendingOpus: 0, pendingFable: 0, staleExcluded: 0 };
  const staleMs = (policy?.staleAfterMinutes ?? 240) * 60_000;
  for (const r of pending) {
    if (r.status !== "pending") continue;
    const started = r.startedAt ? Date.parse(r.startedAt) : NaN;
    if (!Number.isNaN(started) && now - started > staleMs) {
      out.staleExcluded++;
      continue;
    }
    out.pendingTotal++;
    if (r.role === "developer") out.pendingDevelopers++;
    if (VALIDATORS.has(r.role)) out.pendingValidators++;
    if (r.model === "opus") out.pendingOpus++;
    if (r.model === "fable") out.pendingFable++;
  }
  return out;
}

const DENIED_RE = /^\[governor\] DENIED ([A-Z_]{1,40}) ([a-z][a-z0-9-]{0,39})\b/;
const SOFT_RE = /^\[governor\] SOFT_LIMIT accepted/;

// ---- concurrency queue ----------------------------------------------------------------------------
// The governor's NOTE formats (brain-governor):
//   [governor] DENIED CONCURRENCY qa, reviewer, security-reviewer: global total 7/6; active: …
//   [governor] WAIT started <ISO> · <roles> · timeout <N>m · …
//   [governor] WAIT ended <start ISO> → <end ISO> · CLEAR|TIMEOUT|DENIED <CODE>|ERROR|INTERRUPTED · <s>s · polls <k>
// Only the head of a note is looked at; every pattern is anchored and bounded, and only ids, known roles,
// times, numbers and the outcome word are projected (never note text).

const NOTE_HEAD = 600;
const CONC_DENIED_RE = /^\[governor\] DENIED CONCURRENCY ((?:[a-z][a-z0-9-]{0,39})(?:, [a-z][a-z0-9-]{0,39}){0,9}):/;
const ISO_TIME = String.raw`(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z)`;
const WAIT_STARTED_RE = new RegExp(String.raw`^\[governor\] WAIT started ${ISO_TIME}$`);
const WAIT_ENDED_RE = new RegExp(String.raw`^\[governor\] WAIT ended ${ISO_TIME} → ${ISO_TIME}$`);
const TIMEOUT_RE = /^timeout (\d{1,5})m$/;
const OUTCOME_RE = /^(CLEAR|TIMEOUT|DENIED|ERROR|INTERRUPTED)(?: [A-Z0-9_]{1,40})?$/;
const KNOWN_AGENTS: ReadonlySet<string> = new Set(AGENTS);

/** A valid ISO time as its canonical form, else null. */
function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

interface QueueEvent {
  seq: number;
  type: string;
  ts: string | null;
  state: string | null;
  payload: Record<string, unknown>;
}

/** Usable events only (an object with a positive integer seq and a string type), in seq order. */
function queueEvents(events: readonly unknown[]): QueueEvent[] {
  const out: QueueEvent[] = [];
  for (const raw of events) {
    const e = asObj(raw);
    if (!e || typeof e.seq !== "number" || !Number.isSafeInteger(e.seq) || e.seq < 1 || typeof e.type !== "string") continue;
    out.push({ seq: e.seq, type: e.type, ts: asStr(e.ts), state: asStr(e.state), payload: asObj(e.payload) ?? {} });
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/**
 * The task's unanswered concurrency denial, or null: the latest `[governor] DENIED CONCURRENCY` NOTE naming at
 * least one known agent, when it is newer than every AGENT_STARTED, AGENT_COMPLETED and state-changing event.
 * The latest WAIT started after it is paired with the WAIT ended that names the same start time. Robust to
 * malformed input: unusable events, non-string or long note text and unknown roles are skipped.
 */
export function concurrencyQueue(taskId: string, events: readonly unknown[], nowMs: number, staleMs: number): QueuedLaunch | null {
  const evs = queueEvents(events);
  let denial: { seq: number; at: string | null; roles: string[] } | null = null;
  const starts: Array<{ seq: number; startedAt: string; timeoutMinutes: number | null }> = [];
  const ends: Array<{ seq: number; startedAt: string; endedAt: string; outcome: QueueWaitOutcome | null }> = [];
  for (const ev of evs) {
    if (ev.type !== "NOTE" || typeof ev.payload.text !== "string") continue;
    const head = ev.payload.text.slice(0, NOTE_HEAD);
    const denied = CONC_DENIED_RE.exec(head);
    if (denied) {
      const roles = [...new Set((denied[1] ?? "").split(", ").filter((r) => KNOWN_AGENTS.has(r)))];
      if (roles.length > 0) denial = { seq: ev.seq, at: isoOrNull(ev.ts), roles };
      continue;
    }
    const parts = head.split(" · ");
    const started = WAIT_STARTED_RE.exec(parts[0] ?? "");
    if (started) {
      const startedAt = isoOrNull(started[1]);
      const timeout = TIMEOUT_RE.exec(parts[2] ?? "");
      if (startedAt) starts.push({ seq: ev.seq, startedAt, timeoutMinutes: timeout ? Number(timeout[1]) : null });
      continue;
    }
    const ended = WAIT_ENDED_RE.exec(parts[0] ?? "");
    if (ended) {
      const startedAt = isoOrNull(ended[1]);
      const endedAt = isoOrNull(ended[2]);
      const outcome = OUTCOME_RE.exec(parts[1] ?? "");
      if (startedAt && endedAt) ends.push({ seq: ev.seq, startedAt, endedAt, outcome: outcome ? (outcome[1] as QueueWaitOutcome) : null });
    }
  }
  if (!denial || denial.seq <= latestLaunchActivitySeq(evs)) return null;
  const d = denial;
  const start = starts.filter((s) => s.seq > d.seq).pop() ?? null;
  const end = start ? (ends.find((e) => e.seq > start.seq && e.startedAt === start.startedAt) ?? null) : null;
  const sinceTimes = [d.at, start?.startedAt ?? null].filter((t): t is string => t !== null).map((t) => Date.parse(t));
  const since = sinceTimes.length > 0 ? Math.max(...sinceTimes) : null;
  return {
    taskId,
    roles: d.roles,
    deniedSeq: d.seq,
    deniedAt: d.at,
    wait: start ? { startedAt: start.startedAt, timeoutMinutes: start.timeoutMinutes, endedAt: end?.endedAt ?? null, outcome: end?.outcome ?? null } : null,
    overStaleThreshold: since !== null && nowMs - since > staleMs,
  };
}

export function governorNotes(taskId: string, events: readonly BrainEvent[]): { denials: GovernorDenial[]; softLimits: GovernorSoftLimit[] } {
  const denials: GovernorDenial[] = [];
  const softLimits: GovernorSoftLimit[] = [];
  for (const ev of events) {
    if (ev.type !== "NOTE") continue;
    const text = asStr(ev.payload.text) ?? "";
    const m = DENIED_RE.exec(text);
    if (m) denials.push({ taskId, seq: ev.seq, ts: ev.ts, code: m[1] ?? "", role: m[2] ?? "" });
    else if (SOFT_RE.test(text)) softLimits.push({ taskId, seq: ev.seq, ts: ev.ts });
  }
  return { denials, softLimits };
}
