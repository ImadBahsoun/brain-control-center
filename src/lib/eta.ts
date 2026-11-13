// The mission ETA: a deterministic estimate computed on read from the log, the agent runs and the clock;
// nothing is stored. It mirrors brain-governor's `status` ETA (~/.claude/skills/orchestration/governor.md,
// "ETA") with the same constants, rules and test numbers. Pure; used server-side by /api/tasks.
import type { AgentRun, EtaStage, TaskEta, TaskStatus } from "./api-types";

export const ETA_NOTE = "estimate, not a guarantee" as const;

/** Minutes [low, high] per role, used below ETA_HISTORY_MIN samples (synthesis always). */
export const ETA_FALLBACK: Readonly<Record<string, readonly [number, number]>> = {
  planner: [2, 5],
  developer: [5, 15],
  qa: [3, 10],
  reviewer: [3, 8],
  "security-reviewer": [3, 8],
  synthesis: [2, 6],
};
export const ETA_HISTORY_TASKS = 20;
export const ETA_HISTORY_RUNS = 30;
export const ETA_HISTORY_MIN = 3;

/** A recorded state → the first remaining stage, the first of these names that the class has (else the first stage). */
const ETA_START: Readonly<Record<string, readonly string[]>> = {
  RECEIVED: [],
  CLASSIFYING: [],
  PLANNING: ["planner", "developer"],
  IMPLEMENTING: ["developer", "validation", "synthesis"],
  FIXING: ["developer", "validation", "synthesis"],
  TESTING: ["validation", "synthesis"],
  REVIEWING: ["validation", "synthesis"],
  VALIDATING: ["validation", "synthesis"],
  REVALIDATING: ["validation", "synthesis"],
  SYNTHESIZING: ["synthesis"],
  COMMITTING: ["synthesis"],
  PUSHING: ["synthesis"],
  PR: ["synthesis"],
  DEPLOYING: ["synthesis"],
};

export type EtaRun = Pick<AgentRun, "role" | "round" | "epoch" | "status" | "startedAt" | "completedAt">;
export type HistoryRun = Pick<AgentRun, "role" | "status" | "completedAt" | "durationMs">;
export interface EtaEvent {
  seq: number;
  type: string;
  state: string | null;
  payload: Record<string, unknown>;
}
/** Run minutes per role (newest first). */
export type EtaHistory = Record<string, number[]>;

export interface EtaInput {
  status: TaskStatus;
  state: string | null;
  classification: string | null;
  round: number;
  /** brain-state's round_epoch (a scope change starts a new one, with the round back at 0). */
  roundEpoch: number;
  createdAt: string | null;
  lastEventAt: string | null;
  qaTriggers: boolean;
  securityTriggers: boolean;
  /** false when the runs and triggers could not be read (the dashboard's state.json was not usable): no number is given. */
  runsKnown: boolean;
  /** The task's runs in start order. */
  runs: readonly EtaRun[];
  events: readonly EtaEvent[];
  /** The seq of the latest `[governor] DENIED CONCURRENCY` NOTE, 0 when there is none. */
  concurrencyDeniedSeq: number;
  history: EtaHistory;
  nowMs: number;
}

type Stage = { name: string; roles: string[] };

function ms(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

export function formatElapsed(minutes: number | null): string {
  if (minutes === null) return "—";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatEtaLabel(low: number, high: number): string {
  return low === high ? `ETA ~${low} min` : `ETA ~${low}–${high} min`;
}

/** The stages of a class; validation runs its roles in parallel. null for no class or an unknown one. */
function etaPipeline(cls: string | null, qa: boolean, sec: boolean): Stage[] | null {
  let v: string[];
  if (cls === "TRIVIAL") return [{ name: "synthesis", roles: ["synthesis"] }];
  if (cls === "SMALL") v = ["reviewer", ...(sec ? ["security-reviewer"] : [])];
  else if (cls === "STANDARD") v = [...(qa ? ["qa"] : []), "reviewer", ...(sec ? ["security-reviewer"] : [])];
  else if (cls === "COMPLEX") v = ["qa", "reviewer", ...(sec ? ["security-reviewer"] : [])];
  else if (cls === "HIGH-RISK") v = ["qa", "reviewer", "security-reviewer"];
  else return null;
  const head: Stage[] = cls === "COMPLEX" || cls === "HIGH-RISK" ? [{ name: "planner", roles: ["planner"] }] : [];
  if (cls !== "SMALL") head.push({ name: "developer", roles: ["developer"] });
  return [...head, { name: "validation", roles: v }, { name: "synthesis", roles: ["synthesis"] }];
}

/**
 * Run minutes per role from COMPLETE tasks given newest first (the first 20 are used): completed, launched
 * runs with a positive duration, newest report first, at most 30 per role.
 */
export function historyFromRuns(tasks: ReadonlyArray<readonly HistoryRun[]>): EtaHistory {
  // keyed by recorded agent names, so a prototype-less object: an agent named "constructor" is just a name
  const out: EtaHistory = Object.create(null) as EtaHistory;
  for (const runs of tasks.slice(0, ETA_HISTORY_TASKS)) {
    const roles = [...new Set(runs.map((r) => r.role))];
    for (const role of roles) {
      const done = runs
        .filter((r) => r.role === role && r.status === "completed" && r.completedAt !== null)
        .sort((a, b) => ((a.completedAt ?? "") < (b.completedAt ?? "") ? 1 : (a.completedAt ?? "") > (b.completedAt ?? "") ? -1 : 0));
      for (const r of done) {
        const xs = own(out, role) ?? (out[role] = []);
        if (r.durationMs !== null && r.durationMs > 0 && xs.length < ETA_HISTORY_RUNS) xs.push(r.durationMs / 60_000);
      }
    }
  }
  return out;
}

/** A record's own value for a key taken from data (never an inherited Object.prototype member). */
function own<T>(rec: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(rec, key) ? rec[key] : undefined;
}

/** [low, high, basis] in minutes: nearest-rank p25..p75 of at least 3 samples, else the fallback. */
function band(role: string, history: EtaHistory): [number, number, "history" | "fallback"] {
  const xs = role === "synthesis" ? [] : [...(own(history, role) ?? [])].sort((a, b) => a - b);
  const p25 = xs[Math.ceil(0.25 * xs.length) - 1];
  const p75 = xs[Math.ceil(0.75 * xs.length) - 1];
  if (xs.length >= ETA_HISTORY_MIN && p25 !== undefined && p75 !== undefined) {
    return [p25, Math.max(Math.ceil(p75), Math.floor(p25) + 1), "history"];
  }
  const [lo, hi] = own(ETA_FALLBACK, role) ?? [0, 0];
  return [lo, hi, "fallback"];
}

interface Marks {
  started: number;
  completed: number;
  changed: number;
  requested: number;
  resolved: number;
  blockedReason: string;
  beforeBlocked: string | null;
}

/** The seqs the precedence rules compare, the latest BLOCKED reason and the state before BLOCKED. */
function marks(events: readonly EtaEvent[]): Marks {
  const m: Marks = { started: 0, completed: 0, changed: 0, requested: 0, resolved: 0, blockedReason: "", beforeBlocked: null };
  let cur: string | null = null;
  for (const ev of events) {
    let next: string | null = ev.state || cur;
    if (ev.type === "BLOCKED" && next !== "BLOCKED" && next !== "ROUND_CAP_REACHED") next = "BLOCKED";
    if (ev.type === "TASK_COMPLETED" && typeof ev.payload.outcome === "string" && ev.payload.outcome) next = ev.payload.outcome;
    if (next !== cur) {
      m.changed = ev.seq; // a state-changing event
      if (next === "BLOCKED") m.beforeBlocked = cur;
      cur = next;
    }
    if (ev.type === "AGENT_STARTED") m.started = ev.seq;
    else if (ev.type === "AGENT_COMPLETED") m.completed = ev.seq;
    else if (ev.type === "APPROVAL_REQUESTED") m.requested = ev.seq;
    else if (ev.type === "APPROVAL_GRANTED" || ev.type === "APPROVAL_REJECTED") m.resolved = ev.seq;
    else if (ev.type === "BLOCKED") m.blockedReason = typeof ev.payload.reason === "string" ? ev.payload.reason : "";
  }
  return m;
}

/**
 * The seq of the latest AGENT_STARTED, AGENT_COMPLETED or state-changing event: a governor denial newer than
 * this is still unanswered (the same comparison as the ETA's "blocked" rule below).
 */
export function latestLaunchActivitySeq(events: readonly EtaEvent[]): number {
  const m = marks(events);
  return Math.max(m.started, m.completed, m.changed);
}

/**
 * A validator: a launched report of this round and round epoch, started at or after the latest developer report.
 * A planner or developer: its latest run is a launched report of this round and epoch (a scope change resets the
 * round to 0 in a new epoch, so older runs no longer count).
 */
function isDone(validator: boolean, runs: readonly EtaRun[], round: number, epoch: number, devDone: number | null): boolean {
  const ok = (r: EtaRun) => r.status === "completed" && r.round === round && (r.epoch ?? 0) === epoch;
  if (validator) return runs.some((r) => ok(r) && (devDone === null || (ms(r.startedAt) ?? 0) >= devDone));
  const last = runs[runs.length - 1];
  return last !== undefined && ok(last);
}

/** The ETA of one task; the first matching rule wins (governor.md "ETA"). */
export function estimateEta(input: EtaInput): TaskEta {
  const { status, state, classification, round, runs, history, nowMs } = input;
  const created = ms(input.createdAt);
  const end = status === "COMPLETE" || status === "CANCELLED" ? ms(input.lastEventAt) : nowMs;
  const elapsed = created !== null && end !== null ? Math.floor(Math.max(0, end - created) / 60_000) : null;
  const m = marks(input.events);
  const res = (kind: TaskEta["kind"], label: string, reason: string, est?: { low: number; high: number; basis: "history" | "fallback"; stages: EtaStage[] }): TaskEta => ({
    kind,
    low: est?.low ?? null,
    high: est?.high ?? null,
    elapsedMinutes: elapsed,
    label,
    reason,
    basis: est?.basis ?? null,
    stages: est?.stages ?? [],
    note: ETA_NOTE,
  });

  const reason = m.blockedReason.toLowerCase();
  if (status === "COMPLETE") return res("complete", "ETA complete", `COMPLETE · ${formatElapsed(elapsed)} total`);
  if (status === "CANCELLED") return res("cancelled", `CANCELLED · ${formatElapsed(elapsed)} total`, `CANCELLED · ${formatElapsed(elapsed)} total`);
  if (status === "CORRUPT" || status === "INCOMPLETE" || created === null) return res("unknown", "ETA unknown — log unreadable", "the log is corrupt, incomplete or unreadable");
  // dashboard-only: without state.json the runs and triggers are unknown, so no rule below is trusted and no number is given
  if (!input.runsKnown) return res("calculating", "ETA calculating…", "state.json not usable; runs unknown");
  if (state === "ROUND_CAP_REACHED" || (state === "BLOCKED" && (reason.includes("round_cap") || reason.includes("round cap") || m.beforeBlocked === "ROUND_CAP_REACHED"))) {
    return res("unknown", "ETA unknown — round cap reached", "the fix-round cap was reached; the user decides how to continue");
  }
  if (state === "BLOCKED") return res("paused", "ETA paused — task blocked", "the task is blocked until a user decision");
  if (state === "READY") return res("complete", "ETA complete", "READY · the agent work is done");
  if (state === "WAITING_FOR_APPROVAL" || state === "HUMAN_APPROVAL" || m.requested > Math.max(m.resolved, m.started)) {
    return res("paused", "ETA paused — waiting for approval", "approval waits are not predicted");
  }
  if (input.concurrencyDeniedSeq > Math.max(m.started, m.completed, m.changed)) {
    return res("blocked", "ETA blocked — waiting for available agent", "the latest launch was denied by the governor's concurrency limits");
  }
  const stages = etaPipeline(classification, input.qaTriggers, input.securityTriggers);
  const startNames = state !== null ? own(ETA_START, state) : undefined;
  if (stages === null || startNames === undefined) {
    return res("calculating", "ETA calculating…", stages === null ? "no class recorded yet" : `no stage is mapped for state ${state ?? "—"}`);
  }
  const names = stages.map((s) => s.name);
  const startAt = startNames.find((n) => names.includes(n));
  const start = startAt !== undefined ? names.indexOf(startAt) : 0;
  const devTimes = runs.filter((r) => r.role === "developer" && r.status === "completed").map((r) => ms(r.completedAt) ?? 0);
  const devDone = devTimes.length > 0 ? Math.max(...devTimes) : null;

  let low = 0;
  let high = 0;
  let basis: "history" | "fallback" = "fallback";
  const out: EtaStage[] = [];
  for (const stage of stages.slice(start)) {
    const parts: Array<[number, number, EtaStage["status"]]> = [];
    for (const role of stage.roles) {
      const mine = runs.filter((r) => r.role === role);
      const last = mine[mine.length - 1];
      const pending = last !== undefined && last.status === "pending";
      if (!pending && isDone(stage.name === "validation", mine, round, input.roundEpoch, devDone)) {
        parts.push([0, 0, "done"]);
        continue;
      }
      const [lo, hi, src] = band(role, history);
      if (src === "history") basis = "history";
      if (pending) {
        // the elapsed minutes come off the band; an overrun keeps a quarter of its upper bound
        const s = ms(last.startedAt);
        const e = s !== null ? Math.max(0, (nowMs - s) / 60_000) : 0;
        parts.push([Math.max(0, lo - e), Math.max(hi - e, Math.ceil(hi / 4)), "running"]);
      } else parts.push([lo, hi, "queued"]);
    }
    const left = parts.filter((p) => p[2] !== "done");
    const slo = left.length > 0 ? Math.max(...left.map((p) => p[0])) : 0;
    const shi = left.length > 0 ? Math.max(...left.map((p) => p[1])) : 0;
    const st: EtaStage["status"] = left.length === 0 ? "done" : left.some((p) => p[2] === "running") ? "running" : "queued";
    out.push({ name: stage.name, roles: stage.roles, low: Math.floor(slo), high: Math.ceil(shi), status: st });
    low += slo;
    high += shi;
  }
  const lo = Math.floor(low);
  const hi = Math.ceil(high);
  return res("estimate", formatEtaLabel(lo, hi), "assumes the current pass succeeds; approval waits and fix rounds are not predicted", { low: lo, high: hi, basis, stages: out });
}
