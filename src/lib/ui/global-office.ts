// The Global Office: every recorded agent instance of every non-terminal Brain task, by role room. A figure
// exists only for a pending run in /api/agents `active` (a reservation with no report yet) or a recorded
// governor concurrency wait in /api/agents `queued`; a task's lifecycle state never puts anyone in a room.
// Finished runs only appear in the "recently finished" lists. Pure, unit-tested (tests/unit/ui-global-office.test.ts).
import type { AgentRun, AgentsResponse, GlobalUsage, GovernorGlobalLimits, QueuedLaunch, TaskStatus, TasksResponse } from "@/lib/api-types";
import { durationMs } from "@/lib/format";
import { missionNo } from "./hud";
import { LABEL_CHAR, LIVE_WALK_MS, MAX_WALKERS, VALUE_CHAR, type Walker } from "./office";
import { GLOBAL_CARD_W, GLOBAL_GATE_CARD_W, GLOBAL_QUEUE_CAP, GLOBAL_SEAT_CAP, globalWalkPath, LINE_LABEL_CHARS, type GlobalWalkEnd } from "./global-office-layout";
import { ROOM_TITLE } from "./office-layout";
import { isUnknownRepoLabel, repoLabel, repoLabels } from "./repo";
import { isRole, ROLE_LABELS, roleLabel, ROLES, VALIDATORS, type Role } from "./roles";

/** running: a pending run within the stale threshold; stale: one past it; queued: a concurrency-denied launch. */
export type InstanceState = "running" | "stale" | "queued";

export const STATE_WORDS: Record<InstanceState, string> = {
  running: "running",
  stale: "over stale threshold",
  queued: "queued",
};

export const TELEMETRY_NOTES: readonly string[] = [
  "No liveness data: running means a reservation with no report yet, not proof the agent is working.",
  "No queue position: the governor records denials and waits, not an order.",
  "Recently finished is capped at the 20 newest finished runs (/api/agents recent).",
  "A walking token marks a run start or report seen between two polls (up to 2.5 s late while a mission is active): it carries the mission, not an agent's movement.",
];

export const INSTANCE_SOURCE: Record<InstanceState, string> = {
  running: "/api/agents active (pending, within stale_after_minutes)",
  stale: "/api/agents active (pending, staleOverThreshold)",
  queued: "/api/agents queued ([governor] DENIED CONCURRENCY and WAIT notes)",
};

/** The page of a mission; every link and navigation to a mission goes through here. */
export function missionHref(taskId: string): string {
  return `/tasks/${encodeURIComponent(taskId)}`;
}

export interface GlobalInstance {
  key: string;
  taskId: string;
  missionNo: string;
  title: string | null;
  repoLabel: string;
  repoKnown: boolean;
  /** The mission's status from /api/tasks; null when the task list does not have it (yet). */
  missionStatus: TaskStatus | null;
  role: string;
  roleLabel: string;
  state: InstanceState;
  /** When the run started, or when the launch was denied (its wait's start when that is later). */
  since: string | null;
  elapsedMs: number | null;
  kind: string | null;
  round: number | null;
  model: string | null;
  /** A queued launch in words ("wait started, no end recorded", …); null otherwise. */
  note: string | null;
  /** Past stale_after_minutes: a stale run, or a queued launch denied that long ago with no launch since. */
  overStaleThreshold: boolean;
  source: string;
}

export interface FinishedRun {
  key: string;
  taskId: string;
  missionNo: string;
  repoLabel: string;
  role: string;
  roleLabel: string;
  status: Exclude<AgentRun["status"], "pending">;
  verdict: string | null;
  completedAt: string | null;
  durationMs: number | null;
}

export interface GlobalRoom {
  id: Role;
  title: string;
  /** Every instance, by `since` then mission id. */
  instances: GlobalInstance[];
  /** The seated figures drawn: running, then stale, each by `since` (at most GLOBAL_SEAT_CAP). */
  seated: GlobalInstance[];
  /** The queued figures drawn at the door (at most GLOBAL_QUEUE_CAP). */
  waiting: GlobalInstance[];
  /** `seated` then `waiting`. */
  visible: GlobalInstance[];
  /** Instances not drawn: the "+k" marker and the roster. */
  overflow: GlobalInstance[];
  running: number;
  stale: number;
  queued: number;
  /** "2 running · 1 queued". */
  header: string;
  /** The governor limit for the room's lane (roomLimit); null without a valid policy. */
  limit: number | null;
  recentFinished: FinishedRun[];
}

/** A line from the core to a role room that has at least one running or queued instance right now. */
export interface ActivityLine {
  role: Role;
  /** "running": at least one running instance (the active style); "queued": queued ones only (dimmer, dashed). */
  tone: "running" | "queued";
  running: number;
  queued: number;
  /** Mission numbers of the running, then the queued instances, each once (stale instances carry none). */
  missions: string[];
  /** The plate on the line: up to two mission numbers, then "+k". */
  label: string;
  /** `label`, then shorter variants ("#0011 +1", "#0011+1") for a plate that does not fit on its line in full. */
  labels: string[];
  /** "Build: 1 running (#0011)", for the text version of the scene. */
  words: string;
}

export interface GlobalOfficeModel {
  loaded: boolean;
  rooms: GlobalRoom[];
  /** One per role room with a running or queued instance, in room order; from the instances only. */
  activityLines: ActivityLine[];
  /** Instances of roles outside the five rooms: roster only. */
  other: GlobalInstance[];
  otherFinished: FinishedRun[];
  /** Pending runs by the governor's rule (globalUsage): stale runs are left out and counted. */
  totals: GlobalUsage;
  queuedLaunches: number;
  /** /api/tasks counts.waitingApproval (the gate room's decor); null before the task list loads. */
  waitingApproval: number | null;
  missions: number;
}

const TERMINAL: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["COMPLETE", "CANCELLED"]);

function ms(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

function bySince(a: GlobalInstance, b: GlobalInstance): number {
  const x = ms(a.since);
  const y = ms(b.since);
  if (x !== y) {
    if (x === null) return 1;
    if (y === null) return -1;
    return x - y;
  }
  return a.taskId.localeCompare(b.taskId) || a.key.localeCompare(b.key);
}

/** A queued launch in words: never a position, and an abandoned-looking one says so. */
export function queuedNote(q: QueuedLaunch, nowMs: number): string {
  const w = q.wait;
  if (q.overStaleThreshold) {
    const since = ms(w?.startedAt ?? null) ?? ms(q.deniedAt);
    return `${w ? "waited" : "denied"} ${since !== null ? `${durationMs(Math.max(0, nowMs - since))} ago` : "long ago"}, no launch since`;
  }
  if (!w) return "denied for concurrency, no wait recorded";
  if (w.endedAt) return `wait ended ${(w.outcome ?? "with no outcome").toLowerCase()}, no launch yet`;
  const started = ms(w.startedAt);
  if (w.timeoutMinutes !== null && started !== null && nowMs - started > w.timeoutMinutes * 60_000) return "wait started, no end recorded";
  return w.timeoutMinutes !== null ? `waiting for a slot · timeout ${w.timeoutMinutes}m` : "waiting for a slot";
}

/** Same rule as the governor's global usage: pending runs, stale ones left out and counted. */
export function pendingTotals(active: readonly AgentRun[]): GlobalUsage {
  const out: GlobalUsage = { pendingTotal: 0, pendingDevelopers: 0, pendingValidators: 0, pendingOpus: 0, pendingFable: 0, staleExcluded: 0 };
  for (const r of active) {
    if (r.status !== "pending") continue;
    if (r.staleOverThreshold) {
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

/**
 * The governor limit a role room's "n/m busy" counts against: max_developers for BUILD, the validator lane shared by
 * QUALITY, REVIEW and SECURITY, max_total_agents for PLANNING. Null without a valid limit: never a guessed m.
 */
export function roomLimit(role: Role, limits: GovernorGlobalLimits | null): number | null {
  if (!limits) return null;
  const m = role === "developer" ? limits.max_developers : VALIDATORS.has(role) ? limits.max_validators : limits.max_total_agents;
  return Number.isInteger(m) && m >= 0 ? m : null;
}

export function buildGlobalOffice({ agents, tasks, nowMs, limits = null }: { agents: AgentsResponse | null; tasks: TasksResponse | null; nowMs: number; limits?: GovernorGlobalLimits | null }): GlobalOfficeModel {
  const list = tasks?.tasks ?? [];
  const byId = new Map(list.map((t) => [t.id, t]));
  const labels = repoLabels(list.map((t) => t.repository));
  const mission = (taskId: string) => {
    const t = byId.get(taskId);
    const label = repoLabel(t?.repository ?? null, labels);
    return { missionNo: missionNo(taskId) ?? taskId, title: t?.title ?? null, repoLabel: label, repoKnown: !isUnknownRepoLabel(label), missionStatus: t?.status ?? null };
  };

  const instances: GlobalInstance[] = [];
  for (const r of agents?.active ?? []) {
    if (r.status !== "pending") continue;
    const state: InstanceState = r.staleOverThreshold ? "stale" : "running";
    const since = ms(r.startedAt);
    instances.push({
      key: `${r.taskId}|${r.role}|${r.startedAt ?? ""}|${r.kind}|${r.round ?? ""}`,
      taskId: r.taskId,
      ...mission(r.taskId),
      role: r.role,
      roleLabel: roleLabel(r.role),
      state,
      since: r.startedAt,
      elapsedMs: since !== null ? Math.max(0, nowMs - since) : null,
      kind: r.kind,
      round: r.round,
      model: r.model,
      note: null,
      overStaleThreshold: r.staleOverThreshold,
      source: INSTANCE_SOURCE[state],
    });
  }
  for (const q of agents?.queued ?? []) {
    const sinceIso = q.wait && (ms(q.wait.startedAt) ?? 0) >= (ms(q.deniedAt) ?? 0) ? q.wait.startedAt : q.deniedAt;
    const since = ms(sinceIso);
    for (const role of q.roles) {
      instances.push({
        key: `${q.taskId}|${role}|queued|${q.deniedSeq}`,
        taskId: q.taskId,
        ...mission(q.taskId),
        role,
        roleLabel: roleLabel(role),
        state: "queued",
        since: sinceIso,
        elapsedMs: since !== null ? Math.max(0, nowMs - since) : null,
        kind: null,
        round: null,
        model: null,
        note: queuedNote(q, nowMs),
        overStaleThreshold: q.overStaleThreshold,
        source: INSTANCE_SOURCE.queued,
      });
    }
  }
  instances.sort(bySince);

  // finished runs of missions still open (a finished run never stands in a room)
  const finished: FinishedRun[] = [];
  for (const r of agents?.recent ?? []) {
    if (r.status === "pending") continue;
    const t = byId.get(r.taskId);
    if (!t || TERMINAL.has(t.status)) continue;
    const m = mission(r.taskId);
    finished.push({ key: `${r.taskId}|${r.role}|${r.startedAt ?? ""}|${r.completedAt ?? ""}`, taskId: r.taskId, missionNo: m.missionNo, repoLabel: m.repoLabel, role: r.role, roleLabel: roleLabel(r.role), status: r.status, verdict: r.verdict, completedAt: r.completedAt, durationMs: r.durationMs });
  }

  const rooms: GlobalRoom[] = ROLES.map((id) => {
    const mine = instances.filter((i) => i.role === id);
    // running first, so a stale reservation never takes the place of a running one at a desk
    const seatedAll = [...mine.filter((i) => i.state === "running"), ...mine.filter((i) => i.state === "stale")];
    const queuedAll = mine.filter((i) => i.state === "queued");
    const seated = seatedAll.slice(0, GLOBAL_SEAT_CAP);
    const waiting = queuedAll.slice(0, GLOBAL_QUEUE_CAP);
    const shown = new Set([...seated, ...waiting]);
    const running = mine.filter((i) => i.state === "running").length;
    return {
      id,
      title: ROOM_TITLE[id],
      instances: mine,
      seated,
      waiting,
      visible: [...seated, ...waiting],
      overflow: mine.filter((i) => !shown.has(i)),
      running,
      stale: seatedAll.length - running,
      queued: queuedAll.length,
      header: `${running} running · ${queuedAll.length} queued`,
      limit: roomLimit(id, limits),
      recentFinished: finished.filter((f) => f.role === id),
    };
  });

  return {
    loaded: agents !== null,
    rooms,
    activityLines: rooms.flatMap((r) => activityLine(r) ?? []),
    other: instances.filter((i) => !isRole(i.role)),
    otherFinished: finished.filter((f) => !isRole(f.role)),
    totals: pendingTotals(agents?.active ?? []),
    queuedLaunches: agents?.queued?.length ?? 0,
    waitingApproval: tasks ? tasks.counts.waitingApproval : null,
    missions: new Set(instances.map((i) => i.taskId)).size,
  };
}

/** An instance in words, for a figure's accessible name and the text version. */
export function instanceWords(i: GlobalInstance): string {
  const repo = i.repoKnown ? `repo ${i.repoLabel}` : "repo unknown";
  const time = i.elapsedMs !== null ? ` ${durationMs(i.elapsedMs)}` : "";
  const what = i.state === "queued" ? `queued${time}${i.note ? ` (${i.note})` : ""}` : i.state === "stale" ? `over stale threshold, reserved${time} ago` : `running${time}`;
  return `${i.roleLabel} on ${i.taskId}, ${repo}, ${what}`;
}

// ---- activity lines -------------------------------------------------------------------------------

/** Text cut to `max` characters with an ellipsis (ids and repo labels have no word boundary to cut at). */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

/** A line's plate: up to `most` (two) mission numbers and "+k" for the rest (after `gap`), within LINE_LABEL_CHARS. */
export function lineLabel(missions: readonly string[], most = 2, gap = " "): string {
  for (let shown = Math.min(most, missions.length); shown >= 1; shown--) {
    const rest = missions.length - shown;
    const text = `${missions.slice(0, shown).join(" ")}${rest > 0 ? `${gap}+${rest}` : ""}`;
    if (text.length <= LINE_LABEL_CHARS) return text;
  }
  const rest = missions.length - 1;
  const more = rest > 0 ? `${gap}+${rest}` : "";
  return `${clip(missions[0] ?? "", LINE_LABEL_CHARS - more.length)}${more}`;
}

/** A line's label variants, longest first: up to two numbers and "+k", then one number and "+k", then without the space. */
export function lineLabels(missions: readonly string[]): string[] {
  return [...new Set([lineLabel(missions), lineLabel(missions, 1), lineLabel(missions, 1, "")])];
}

/**
 * A room's line from the core: only while it has a running instance or a queued launch within the stale
 * threshold. Stale runs and queued launches denied past it (likely abandoned) draw none and carry no mission.
 */
export function activityLine(room: GlobalRoom): ActivityLine | null {
  const queued = room.instances.filter((i) => i.state === "queued" && !i.overStaleThreshold);
  if (room.running + queued.length === 0) return null;
  const carried = [...room.instances.filter((i) => i.state === "running"), ...queued];
  // one entry per mission (task id), first seen first: mission numbers repeat across days, so two may read the same
  const firstOfTask = new Map<string, string>();
  for (const i of carried) if (!firstOfTask.has(i.taskId)) firstOfTask.set(i.taskId, i.missionNo);
  const missions = [...firstOfTask.values()];
  const counts = [room.running > 0 ? `${room.running} running` : null, queued.length > 0 ? `${queued.length} queued` : null].filter((x) => x !== null).join(", ");
  const name = `${room.title.charAt(0)}${room.title.slice(1).toLowerCase()}`;
  const labels = lineLabels(missions);
  return {
    role: room.id,
    tone: room.running > 0 ? "running" : "queued",
    running: room.running,
    queued: queued.length,
    missions,
    label: labels[0] ?? "",
    labels,
    words: `${name}: ${counts} (${missions.join(", ")})`,
  };
}

// ---- card text --------------------------------------------------------------------------------------
//
// Every card line is measured like cardLines (src/lib/ui/office.ts): 15 px rows at LABEL_CHAR and numbers at
// VALUE_CHAR world units per character, the 16 px title (0.06em tracking) at TITLE_CHAR, so nothing runs past
// the card's edge (tests/unit/ui-global-office.test.ts).

export const CARD_PAD = 10;
export const TITLE_CHAR = 11;
/** The gap kept between a line's left text and its right-aligned value. */
export const CARD_GAP = 8;

/** The first option that fits `width` at `char` per character, else the last one cut to fit. */
function firstFit(options: readonly string[], char: number, width: number): string {
  return options.find((t) => t.length * char <= width) ?? clip(options[options.length - 1] ?? "", Math.floor(width / char));
}

/** A card row: a label at the left, a right-aligned value; `warn` when the value is a stale count above zero. */
export interface GlobalCardRow {
  label: string;
  value: string;
  warn: boolean;
}

export interface GlobalRoomCardText {
  title: string;
  /** "n/m busy" (n running in the room, m the governor limit of its lane), or "n busy" without a valid policy. */
  right: string;
  /** Queued · stale, then the lane the limit belongs to. */
  rows: [GlobalCardRow, GlobalCardRow];
}

/** A row whose label is the first option that fits beside its value. */
function fitRow(labels: readonly string[], value: string, width: number, warn = false): GlobalCardRow {
  return { label: firstFit(labels, LABEL_CHAR, width - CARD_GAP - value.length * VALUE_CHAR), value, warn };
}

/** The lane a room's limit belongs to, for its card row and its words. */
export function laneWords(role: Role): { card: string[]; words: string } {
  if (role === "developer") return { card: ["developer lane", "developers"], words: "governor limit on developers" };
  if (VALIDATORS.has(role)) return { card: ["shared (3 rooms)", "shared"], words: "validator limit shared by Quality, Review and Security" };
  return { card: ["all agents", "all"], words: "governor limit on all agents" };
}

/**
 * A role room card's lines, each fitting the card's inner width: the title with "n/m busy", the queued and stale
 * counts, and the lane the limit counts (its usage across all missions, by the governor's rule).
 */
export function globalRoomCard(room: GlobalRoom, totals: GlobalUsage): GlobalRoomCardText {
  const width = GLOBAL_CARD_W - 2 * CARD_PAD;
  // n: running instances only; stale reservations are left out, as the governor leaves them out of its usage
  const n = room.running;
  const m = room.limit;
  // a queued launch denied past the stale threshold reads as stale on the card, like a stale run (it draws no line)
  const staleQueued = room.instances.filter((i) => i.state === "queued" && i.overStaleThreshold).length;
  const q = room.queued - staleQueued;
  const stale = room.stale + staleQueued;
  const busy = m === null ? [`${n} busy`, `${n}`] : [`${n}/${m} busy`, `${n}/${m}`];
  const right = firstFit(busy, VALUE_CHAR, width - room.title.length * TITLE_CHAR - CARD_GAP);
  const used = room.id === "developer" ? totals.pendingDevelopers : VALIDATORS.has(room.id) ? totals.pendingValidators : totals.pendingTotal;
  const lane = laneWords(room.id);
  return {
    title: room.title,
    right,
    rows: [fitRow(["queued · stale", "queued·stale", "q · stale"], `${q} · ${stale}`, width, stale > 0), m === null ? fitRow(["limit"], "no policy", width) : fitRow(lane.card, `${used}/${m}`, width)],
  };
}

/** A room's busy count in words, for the text version: "1 of 3 busy (validator limit shared by …)". */
export function busyWords(room: GlobalRoom): string {
  return room.limit === null ? `${room.running} busy (no governor limit without a valid policy)` : `${room.running} of ${room.limit} busy (${laneWords(room.id).words})`;
}

export interface GlobalGateCardText {
  title: string;
  /** The approvals waiting on the user, in words. */
  waitingText: string;
  rows: string[];
}

/** The Commander Gate card (decor in the Global Office): the approvals waiting, and where approvals happen. */
export function globalGateCard(waiting: number | null): GlobalGateCardText {
  const width = GLOBAL_GATE_CARD_W - 2 * CARD_PAD;
  const text = waiting === null ? "—" : waiting > 0 ? `${waiting} waiting on you` : "no approvals waiting";
  return { title: ROOM_TITLE.gate, waitingText: firstFit([text, waiting ? `${waiting} waiting` : text], LABEL_CHAR, width), rows: ["approve in Claude Code"] };
}

// ---- walks ----------------------------------------------------------------------------------------
//
// A walking token is a mission token: "this mission's run started" (core or the room that last reported → the
// room's door) or "this run reported" (door → the core), seen in the difference between two consecutive /api/agents
// bodies. Nothing else walks: no queued launch, no vanished run, no guess from a mission's state.

/** No walks across a gap longer than this between two bodies (a missed poll or a sleeping tab). */
export const WALK_GAP_MS = 45_000;
/** A new run walks only when it started at most this long before the previous body. */
export const WALK_START_MS = 60_000;

export interface GlobalWalk extends Walker {
  kind: "arrive" | "report";
  taskId: string;
  /** Where the token walks: a room's door, or the core for a report. */
  to: GlobalWalkEnd;
}

function runKey(r: AgentRun): string {
  return `${r.taskId}|${r.role}|${r.startedAt ?? ""}|${r.kind}|${r.round ?? ""}`;
}

/** The mission tokens two consecutive /api/agents bodies imply (at most MAX_WALKERS). */
export function globalWalks(prev: AgentsResponse | null, next: AgentsResponse | null): GlobalWalk[] {
  if (!prev || !next) return [];
  const before = ms(prev.generatedAt);
  const now = ms(next.generatedAt);
  if (before === null || now === null || now <= before || now - before > WALK_GAP_MS) return [];
  const pendingKeys = (runs: readonly AgentRun[]) => new Set(runs.filter((r) => r.status === "pending").map(runKey));
  const was = pendingKeys(prev.active);
  const is = pendingKeys(next.active);
  const out: GlobalWalk[] = [];
  const walk = (kind: GlobalWalk["kind"], r: AgentRun & { role: Role }, from: GlobalWalkEnd, to: GlobalWalkEnd): GlobalWalk => {
    const label = missionNo(r.taskId) ?? r.taskId;
    const fromWords = from === "core" ? "Brain core" : ROLE_LABELS[from];
    return {
      key: `${kind}|${runKey(r)}|${next.generatedAt}`,
      kind,
      taskId: r.taskId,
      origin: from,
      // OfficeWalker reads `dest` only for its reduced-motion chip, which the Global Office never draws
      dest: r.role,
      to,
      d: globalWalkPath(from, to),
      label,
      text: kind === "arrive" ? `${label} ← ${fromWords}` : `${label} → Brain core`,
      durationMs: LIVE_WALK_MS,
      source: `/api/agents poll diff (${prev.generatedAt} → ${next.generatedAt}): run ${kind === "arrive" ? "appeared in active" : "left active, reported in recent"}`,
    };
  };
  for (const r of next.active) {
    if (r.status !== "pending" || r.staleOverThreshold || !isRole(r.role) || was.has(runKey(r))) continue;
    const started = ms(r.startedAt);
    if (started === null || started < before - WALK_START_MS) continue;
    // from the room of the same mission's latest other run that reported before this one started, else the core
    let from: GlobalWalkEnd = "core";
    let fromAt = -Infinity;
    for (const x of next.recent) {
      const done = ms(x.completedAt);
      if (x.taskId !== r.taskId || x.status === "pending" || x.role === r.role || !isRole(x.role) || done === null || done > started || done <= fromAt) continue;
      from = x.role;
      fromAt = done;
    }
    out.push(walk("arrive", { ...r, role: r.role }, from, r.role));
  }
  for (const r of prev.active) {
    if (r.status !== "pending" || !isRole(r.role) || is.has(runKey(r))) continue;
    // only a run that reported walks back: one that merely vanished from the body walks nowhere
    if (!next.recent.some((x) => x.status !== "pending" && runKey(x) === runKey(r))) continue;
    out.push(walk("report", { ...r, role: r.role }, r.role, "core"));
  }
  return out.slice(0, MAX_WALKERS);
}
