// Mission Replay: a terminal mission's recorded lifecycle stepped through on the command map, one step per
// recorded activity line. Every frame is rebuilt from structured fields of the unchanged API bodies (event
// seq / ts / type / role / round, lifecycle transitions, AgentRun start and end, Finding history), never
// from activity text, and the frame's TaskDetail is assembled field by field: nothing of the final state
// leaks into an earlier step. What the store does not record per step (governor usage, validation records,
// the next action, stale flags) is left empty and listed in REPLAY_GAPS. Nothing is written. Pure.
import type { ActivityItem, AgentRun, EventsResponse, Finding, FindingsCount, FindingsResponse, TaskDetail, TaskStatus, TopFinding } from "@/lib/api-types";
import { buildLifecycle, isTerminalStatus } from "@/lib/lifecycle";
import { buildCommandMap, type CommandMapModel } from "./command-map";
import { completionSeqsFor } from "./feed";
import { diffSnapshots, snapshotOf, type LiveEffect } from "./live-diff";
import { OPEN_STATUSES } from "./threats";

/** What a replay cannot show, because the store does not record it per step. Shown beside the replay controls. */
export const REPLAY_GAPS: readonly string[] = [
  "governor usage, class budget and global slots at the time (the HUD and meters say not recorded per step)",
  "units per run: the current policy's value (units are not recorded per run)",
  "classification, classification reason and risk: the final values at every step",
  "the recorded next action at each step",
  "validation records (validation lines appear in the feed only)",
  "what a blocked mission needed (the reason is shown)",
  "the plan scope before approval, and HEAD at the time",
  "finding text edits: titles and descriptions are the final wording",
  "finding status changes recorded in the same millisecond as other finding updates appear with the last of them: never early, but in a large batch many steps late (finding creations are exact)",
  "tests and files of an agent that completed more than once in a round appear with its last report in that round",
  "wall-clock pacing: each step carries its recorded timestamp",
  "stale flags of reservations",
  "other missions, health and brain-gate at that time",
];

export type ReplayAvailability = { ok: true; partial: boolean; caveats: string[] } | { ok: false; reason: string };

/**
 * Whether a replay can be offered. Without `events` only the mission itself is checked (for the button);
 * with them, the loaded window too: `hasMore` makes the replay partial, starting at the first loaded event.
 */
export function replayAvailability(detail: TaskDetail | null, findings: FindingsResponse | null, events: EventsResponse | null): ReplayAvailability {
  if (!detail) return { ok: false, reason: "mission not loaded" };
  if (!isTerminalStatus(detail.status)) return { ok: false, reason: "replay is offered for completed or cancelled missions only" };
  if (detail.integrity.log !== "ok" && detail.integrity.log !== "torn_tail") return { ok: false, reason: `log ${detail.integrity.log}` };
  if (detail.summaryUnavailable) return { ok: false, reason: `state.json not usable (cache ${detail.integrity.cache})` };
  if (findings && findings.taskId !== detail.id) return { ok: false, reason: "findings of another mission" };
  if (!events) return { ok: true, partial: false, caveats: [] };
  if (events.taskId !== detail.id) return { ok: false, reason: "events of another mission" };
  const first = events.events[0];
  if (!first) return { ok: false, reason: "no events loaded" };
  if (events.hasMore) return { ok: true, partial: true, caveats: [`replay starts at #${first.seq}; older events not loaded`] };
  return { ok: true, partial: false, caveats: [] };
}

export interface ReplayStep {
  index: number;
  seq: number;
  ts: string;
  item: ActivityItem;
}

/** A recorded point in the log: the seq it happened at (0 = before the loaded window), or null to fall back on a timestamp. */
type At = number | null;

interface IndexedRun {
  run: AgentRun;
  start: At;
  end: At;
}

interface IndexedRound {
  round: TaskDetail["rounds"][number];
  start: At;
  end: At;
}

export interface ReplayTimeline {
  missionId: string;
  steps: ReplayStep[];
  partial: boolean;
  caveats: string[];
  final: { detail: TaskDetail; findings: FindingsResponse; events: EventsResponse };
  runs: IndexedRun[];
  rounds: IndexedRound[];
  planCreated: At;
  planApproved: At;
  completed: At;
  blocked: Array<{ seq: number; reason: string | null }>;
  tests: Array<{ entry: TaskDetail["testsRun"][number]; at: number }>;
  files: Array<{ entry: TaskDetail["filesChanged"][number]; at: number }>;
  /** Per finding id: the step seq it is created at, and the seq each later history entry is shown from. */
  findingSteps: Map<string, { created: number; changes: number[] }>;
}

const BEFORE_WINDOW = 0;

function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  if (a === b) return true;
  const x = Date.parse(a);
  return !Number.isNaN(x) && x === Date.parse(b);
}

function notAfter(ts: string | null, t: string): boolean {
  if (ts === null) return false;
  const x = Date.parse(ts);
  const y = Date.parse(t);
  return !Number.isNaN(x) && !Number.isNaN(y) && x <= y;
}

/**
 * The step a timestamped change is shown from, never before its own log line: the last step of type `prefer`
 * with the same instant (a same-millisecond batch shows the change at its end), else the last step with that
 * instant, else (no loaded line has it) before the window when it is older than the first step, else the first
 * later step. An unknown timestamp is shown only at the last step.
 */
function placeByTs(steps: readonly ReplayStep[], ts: string | null, prefer: string): number {
  const last = steps[steps.length - 1]?.seq ?? BEFORE_WINDOW;
  const x = ts === null ? Number.NaN : Date.parse(ts);
  if (Number.isNaN(x)) return last;
  const same = steps.filter((st) => Date.parse(st.ts) === x);
  if (same.length > 0) return ([...same].reverse().find((st) => st.item.type === prefer) ?? same[same.length - 1])?.seq ?? last;
  const first = steps[0];
  if (first && x < Date.parse(first.ts)) return BEFORE_WINDOW;
  return steps.find((st) => Date.parse(st.ts) > x)?.seq ?? last;
}

const F_ID = /^F-(\d+)$/;

/** The k-th of `count` recorded items aligned from the end (older ones fell out of a partial window). */
function alignFromEnd<T>(items: readonly T[], count: number, k: number): T | undefined {
  return items[k - (count - items.length)];
}

export function buildReplay(detail: TaskDetail, findings: FindingsResponse, events: EventsResponse): { ok: true; timeline: ReplayTimeline } | { ok: false; reason: string } {
  const avail = replayAvailability(detail, findings, events);
  if (!avail.ok) return avail;
  const items = events.events;
  const caveats = [...avail.caveats];
  const steps: ReplayStep[] = items.map((item, index) => ({ index, seq: item.seq, ts: item.ts, item }));

  // agent runs ↔ AGENT_STARTED / AGENT_COMPLETED lines, by role and the recorded instant
  const used = new Set<number>();
  let byTime = 0;
  const runs: IndexedRun[] = detail.agents.map((run) => {
    const startItem = items.find((it) => it.type === "AGENT_STARTED" && it.role === run.role && !used.has(it.seq) && sameInstant(it.ts, run.startedAt));
    if (startItem) used.add(startItem.seq);
    const endItem = run.completedAt === null ? undefined : items.find((it) => it.type === "AGENT_COMPLETED" && it.role === run.role && !used.has(it.seq) && (!startItem || it.seq > startItem.seq) && sameInstant(it.ts, run.completedAt));
    if (endItem) used.add(endItem.seq);
    if (!startItem || (run.completedAt !== null && !endItem)) byTime++;
    return { run, start: startItem ? startItem.seq : null, end: run.completedAt === null ? Number.POSITIVE_INFINITY : endItem ? endItem.seq : null };
  });
  if (byTime > 0) caveats.push(`${byTime} agent run(s) placed by timestamp: their start or report line is not in the loaded events`);

  // fix rounds ↔ FIX_ROUND_STARTED / FIX_ROUND_COMPLETED lines, in order (aligned from the end of a partial window)
  const roundStarts = items.filter((it) => it.type === "FIX_ROUND_STARTED");
  const roundEnds = items.filter((it) => it.type === "FIX_ROUND_COMPLETED");
  const completedRounds = detail.rounds.filter((r) => r.completed);
  const rounds: IndexedRound[] = detail.rounds.map((round, k) => {
    const s = alignFromEnd(roundStarts, detail.rounds.length, k);
    const doneIndex = completedRounds.indexOf(round);
    const e = doneIndex >= 0 ? alignFromEnd(roundEnds, completedRounds.length, doneIndex) : undefined;
    return { round, start: s ? s.seq : BEFORE_WINDOW, end: !round.completed ? Number.POSITIVE_INFINITY : e ? e.seq : BEFORE_WINDOW };
  });
  if (!avail.partial && (roundStarts.length !== detail.rounds.length || roundEnds.length !== completedRounds.length)) caveats.push("fix rounds and their log lines do not pair up; unpaired rounds are shown from the start");

  const lastOf = (type: string): At => {
    for (let i = items.length - 1; i >= 0; i--) if (items[i]?.type === type) return items[i]?.seq ?? null;
    return null;
  };
  const planCreated = detail.plan ? (lastOf("PLAN_CREATED") ?? BEFORE_WINDOW) : null;
  const planApproved = detail.plan?.approved ? (lastOf("PLAN_APPROVED") ?? BEFORE_WINDOW) : null;
  const completed = lastOf("TASK_COMPLETED");
  const blocked = items.filter((it) => it.type === "BLOCKED").map((it) => ({ seq: it.seq, reason: it.detail ?? null }));
  // a group is shown with the last completion of its agent in its round (with several, the line it came from is unknown)
  const reportedAt = (agent: string, round: number | null) => completionSeqsFor(items, agent, round).pop() ?? BEFORE_WINDOW;
  const tests = detail.testsRun.map((entry) => ({ entry, at: reportedAt(entry.agent, entry.round) }));
  const files = detail.filesChanged.map((entry) => ({ entry, at: reportedAt(entry.agent, entry.round) }));

  // findings: brain-state numbers F-ids in creation order, so the k-th FINDING_CREATED line creates the k-th
  // finding by id (aligned from the end of a partial window); status changes are placed by placeByTs
  const createdLines = items.filter((it) => it.type === "FINDING_CREATED");
  const byNumber = findings.findings.map((f) => ({ f, n: Number(F_ID.exec(f.id)?.[1] ?? Number.NaN) }));
  const structural = byNumber.every((x) => !Number.isNaN(x.n)) && (avail.partial ? createdLines.length <= byNumber.length : createdLines.length === byNumber.length);
  const ordered = [...byNumber].sort((a, b) => a.n - b.n).map((x) => x.f);
  const findingSteps = new Map<string, { created: number; changes: number[] }>();
  ordered.forEach((f, k) => {
    const line = structural ? alignFromEnd(createdLines, ordered.length, k) : undefined;
    const created = structural ? (line ? line.seq : BEFORE_WINDOW) : placeByTs(steps, f.createdAt, "FINDING_CREATED");
    findingSteps.set(f.id, { created, changes: f.history.slice(1).map((h) => Math.max(created, placeByTs(steps, h.ts, "FINDING_UPDATED"))) });
  });
  if (!structural && ordered.length > 0) caveats.push("finding creations placed by timestamp: the creation lines do not pair with the finding ids");
  const noHistory = findings.findings.filter((f) => f.history.length === 0).length;
  if (noHistory > 0) caveats.push(`${noHistory} finding(s) have no status history: their status is shown only at the last step`);

  return {
    ok: true,
    timeline: { missionId: detail.id, steps, partial: avail.partial, caveats, final: { detail, findings, events }, runs, rounds, planCreated, planApproved, completed, blocked, tests, files, findingSteps },
  };
}

/** The mission status at a state, mirroring the server's rule (task-store deriveFromLog). */
export function statusAt(state: string | null): TaskStatus {
  if (state === "COMPLETE" || state === "CANCELLED") return state;
  if (state === "BLOCKED" || state === "ROUND_CAP_REACHED") return "BLOCKED";
  if (state === "WAITING_FOR_APPROVAL" || state === "HUMAN_APPROVAL") return "WAITING";
  return "ACTIVE";
}

/** Status shown for a finding with no history before the last step (its final status is not known earlier). */
export const UNRECORDED_STATUS = "UNRECORDED";

function findingAt(f: Finding, placed: { created: number; changes: number[] } | undefined, s: number, isLast: boolean): Finding | null {
  if (!placed || placed.created > s) return null;
  // history[0] is the creation entry; each later entry counts from the step it is placed at
  const past = f.history.filter((_, i) => i === 0 || (placed.changes[i - 1] ?? Number.POSITIVE_INFINITY) <= s);
  const last = past[past.length - 1] ?? null;
  const status = last?.status ?? (isLast ? f.status : UNRECORDED_STATUS);
  const resolving = new Set(["FIXED", "REVALIDATED", "CLOSED", "REJECTED", "DEFERRED"]);
  return {
    id: f.id,
    aliases: f.aliases,
    severity: f.severity,
    status,
    sources: f.sources,
    title: f.title,
    location: f.location,
    recommendation: f.recommendation,
    description: f.description,
    introducedRound: f.introducedRound,
    fixedRound: past.some((h) => h.status === "FIXED") ? f.fixedRound : null,
    validatedRound: past.some((h) => h.status === "REVALIDATED") ? f.validatedRound : null,
    createdAt: f.createdAt,
    updatedAt: last?.ts ?? f.createdAt,
    resolution: resolving.has(status) ? { status, reason: last?.reason ?? null, ts: last?.ts ?? null } : null,
    history: past,
  };
}

function countOf(findings: readonly Finding[]): FindingsCount {
  const out: FindingsCount = { total: findings.length, open: 0, openBySeverity: { BLOCKER: 0, MAJOR: 0, MINOR: 0, NIT: 0 } };
  for (const f of findings) {
    if (!OPEN_STATUSES.has(f.status)) continue;
    out.open++;
    if (f.severity === "BLOCKER" || f.severity === "MAJOR" || f.severity === "MINOR" || f.severity === "NIT") out.openBySeverity[f.severity]++;
  }
  return out;
}

function topOpen(findings: readonly Finding[]): TopFinding[] {
  const top: TopFinding[] = [];
  for (const f of findings) {
    if (top.length >= 5) break;
    if (OPEN_STATUSES.has(f.status) && (f.severity === "BLOCKER" || f.severity === "MAJOR")) top.push({ id: f.id, severity: f.severity, title: f.title });
  }
  return top;
}

export interface ReplayFrame {
  step: ReplayStep;
  detail: TaskDetail;
  findings: FindingsResponse;
  events: EventsResponse;
}

/** The mission as it was recorded at step `i` (clamped). */
export function replayFrame(timeline: ReplayTimeline, i: number): ReplayFrame {
  const index = Math.max(0, Math.min(timeline.steps.length - 1, i));
  const step = timeline.steps[index] as ReplayStep;
  const s = step.seq;
  const t = step.ts;
  const fin = timeline.final.detail;
  const happened = (at: At, ts: string | null) => (at === null ? notAfter(ts, t) : at <= s);

  const transitions = fin.lifecycle.transitions.filter((tr) => tr.seq <= s);
  const state = transitions[transitions.length - 1]?.state ?? null;
  const status = statusAt(state);
  const terminal = isTerminalStatus(status);
  const lifecycle = buildLifecycle({ currentState: state, status, hasTaskCreated: fin.lifecycle.steps.find((x) => x.state === "RECEIVED")?.implied ?? false, transitions });

  const agents: AgentRun[] = timeline.runs
    .filter((r) => happened(r.start, r.run.startedAt))
    .map(({ run, end }) => {
      const ended = run.completedAt !== null && happened(end, run.completedAt);
      return {
        taskId: run.taskId,
        role: run.role,
        roleLabel: run.roleLabel,
        model: run.model,
        effort: null,
        agentId: ended ? run.agentId : null,
        kind: run.kind,
        round: run.round,
        status: ended ? run.status : "pending",
        staleOverThreshold: false,
        verdict: ended ? run.verdict : null,
        // a refunded run recorded 0; what it reserved while pending is not recorded
        reservedUnits: ended || run.status !== "not-launched" ? run.reservedUnits : null,
        startedAt: run.startedAt,
        completedAt: ended ? run.completedAt : null,
        durationMs: ended ? run.durationMs : null,
        rerun: run.rerun,
      };
    });

  const rounds = timeline.rounds
    .filter((r) => r.start !== null && r.start <= s)
    .map(({ round, end }) => {
      const done = end !== null && end <= s;
      return { round: round.round, kind: round.kind, findings: round.findings, findingsAddressed: done ? round.findingsAddressed : {}, completed: done };
    });

  const isLast = index === timeline.steps.length - 1;
  const findingList = timeline.final.findings.findings.map((f) => findingAt(f, timeline.findingSteps.get(f.id), s, isLast)).filter((f): f is Finding => f !== null);
  const count = countOf(findingList);
  const lastBlocked = status === "BLOCKED" ? [...timeline.blocked].reverse().find((b) => b.seq <= s) : undefined;
  const planShown = timeline.planCreated !== null && timeline.planCreated <= s && fin.plan !== null;
  const approved = planShown && timeline.planApproved !== null && timeline.planApproved <= s;
  const done = timeline.completed !== null && timeline.completed <= s;

  const detail: TaskDetail = {
    id: fin.id,
    title: fin.title,
    classification: fin.classification,
    state,
    round: rounds.length > 0 ? (rounds[rounds.length - 1]?.round ?? 0) : 0,
    maxRounds: fin.maxRounds,
    status,
    active: status === "ACTIVE" || status === "WAITING" || status === "BLOCKED",
    blocked: status === "BLOCKED",
    ready: state === "READY" && !terminal,
    waitingApproval: status === "WAITING",
    createdAt: fin.createdAt,
    updatedAt: t,
    lastEventAt: t,
    eventCount: s,
    findings: count,
    topOpenFindings: topOpen(findingList),
    pendingRuns: agents.filter((r) => r.status === "pending").length,
    summaryUnavailable: false,
    integrity: { log: fin.integrity.log, chainChecked: fin.integrity.chainChecked, cache: fin.integrity.cache, logSeq: s, cacheSeq: fin.integrity.cacheSeq },
    repository: fin.repository,
    parentTaskId: fin.parentTaskId,
    parentStepId: fin.parentStepId,
    branch: fin.branch,
    baseHead: fin.baseHead,
    currentHead: null,
    classificationReason: fin.classificationReason,
    risk: fin.risk,
    nextAction: null,
    outcome: done ? fin.outcome : null,
    completionSummary: done ? fin.completionSummary : null,
    blockedInfo: lastBlocked ? { reason: lastBlocked.reason, needs: [] } : null,
    plan: planShown && fin.plan ? { author: fin.plan.author, approved, approvedScope: approved ? fin.plan.approvedScope : [], notApproved: approved ? fin.plan.notApproved : [], chars: fin.plan.chars } : null,
    lifecycle,
    rounds,
    validation: { latest: null, history: [], inProgress: null },
    testsRun: timeline.tests.filter((x) => x.at <= s).map((x) => x.entry),
    filesChanged: timeline.files.filter((x) => x.at <= s).map((x) => x.entry),
    agents,
    usage: null,
  };
  const ev = timeline.final.events;
  const prefix = ev.events.slice(0, index + 1);
  return {
    step,
    detail,
    findings: { taskId: fin.id, summary: count, findings: findingList, integrity: timeline.final.findings.integrity },
    events: { taskId: ev.taskId, total: prefix.length, hasMore: ev.hasMore, integrity: ev.integrity, events: prefix },
  };
}

/** The gate word of a replayed step that waited on the commander: recorded, not a request for action now. */
export const AWAITED_WORD = "AWAITED APPROVAL";

function recorded(text: string): string {
  return text.replace(/ACTION REQUIRED/g, AWAITED_WORD).replace(/commander approval required/gi, "commander approval awaited");
}

/**
 * The command map of a replay frame: built by the same rules as the live map, then marked as a replay so that
 * nothing claims the present: the core is not live and reads REPLAY, a waiting gate reads AWAITED APPROVAL, and
 * there is no ACTION REQUIRED callout (the gate panel shows the recorded request).
 */
export function asReplayModel(frame: ReplayFrame): CommandMapModel {
  const model = buildCommandMap({ detail: frame.detail, findings: frame.findings, events: frame.events, agents: null, governor: null, health: null, tasks: null, focusId: frame.detail.id });
  const gate = model.gate.gate;
  const relabel = <F extends { state: string; label: string }>(f: F): F => (f.state === "action-required" ? { ...f, label: AWAITED_WORD } : f);
  return {
    ...model,
    mode: "replay",
    core: { ...model.core, live: false, statusText: `REPLAY · ${model.core.statusText.replace(/^LIVE · /, "")}` },
    gate: { ...model.gate, stateWord: recorded(model.gate.stateWord), statusText: recorded(model.gate.statusText), gate: { ...gate, plan: relabel(gate.plan), human: relabel(gate.human) } },
    gateCallout: null,
    edges: model.edges.map((e) => ({ ...e, detail: recorded(e.detail) })),
  };
}

// ---- controls -------------------------------------------------------------------------------------

export type ReplaySpeed = 1 | 2 | 4;
export const REPLAY_SPEEDS: readonly ReplaySpeed[] = [1, 2, 4];
/** Milliseconds per step at each speed. */
export const STEP_MS: Record<ReplaySpeed, number> = { 1: 1200, 2: 600, 4: 300 };

export interface ReplayState {
  open: boolean;
  index: number;
  length: number;
  playing: boolean;
  speed: ReplaySpeed;
  /** +1 when the last move was a single step forward (one-shot effects play), else 0. */
  lastMove: 1 | 0;
}

export type ReplayAction =
  | { type: "open"; length: number; autoplay: boolean }
  | { type: "play" }
  | { type: "pause" }
  | { type: "step"; delta: 1 | -1 }
  | { type: "seek"; index: number }
  | { type: "speed"; speed: ReplaySpeed }
  | { type: "tick" }
  | { type: "exit" };

export const REPLAY_CLOSED: ReplayState = { open: false, index: 0, length: 0, playing: false, speed: 1, lastMove: 0 };

export function replayReducer(state: ReplayState, action: ReplayAction): ReplayState {
  const last = Math.max(0, state.length - 1);
  const clamp = (i: number) => Math.max(0, Math.min(last, Math.round(i)));
  switch (action.type) {
    case "open":
      return { ...state, open: action.length > 0, index: 0, length: action.length, playing: action.autoplay && action.length > 1, lastMove: 0 };
    case "exit":
      return { ...REPLAY_CLOSED, speed: state.speed };
    case "play":
      if (!state.open) return state;
      return state.index >= last ? { ...state, index: 0, playing: last > 0, lastMove: 0 } : { ...state, playing: true };
    case "pause":
      return { ...state, playing: false };
    case "tick": {
      if (!state.open || !state.playing) return state;
      if (state.index >= last) return { ...state, playing: false, lastMove: 0 };
      const index = state.index + 1;
      return { ...state, index, playing: index < last, lastMove: 1 };
    }
    case "step": {
      const index = clamp(state.index + action.delta);
      return { ...state, index, playing: false, lastMove: action.delta === 1 && index === state.index + 1 ? 1 : 0 };
    }
    case "seek": {
      const index = clamp(action.index);
      return { ...state, index, lastMove: index === state.index + 1 ? 1 : 0 };
    }
    case "speed":
      return { ...state, speed: action.speed };
  }
}

/** The one-shot effects of step `i`: the live diff between the frames of steps i − 1 and i, only after a single step forward. */
export function replayStepEffects(timeline: ReplayTimeline, i: number, lastMove: 1 | 0): Array<{ key: string; effect: LiveEffect }> {
  if (lastMove !== 1 || i <= 0 || i >= timeline.steps.length) return [];
  const prev = snapshotOf(asReplayModel(replayFrame(timeline, i - 1)));
  const cur = snapshotOf(asReplayModel(replayFrame(timeline, i)));
  return diffSnapshots(prev, cur).map((effect, n) => ({ key: `r${i}:${n}`, effect }));
}
