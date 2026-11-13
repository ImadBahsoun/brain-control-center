// The office scene: the command map model drawn as rooms, figures, a core and walking mission tokens.
// Every state, number and walk comes from the same CommandMapModel the map draws (the unchanged
// read-only API bodies), plus /api/agents for the typical run duration. Each item carries a `source`
// naming where it came from. A figure sits at its desk only while its role holds a real reservation; a
// token walks only for a real handoff effect. Pure, unit-tested.
import type { AgentRun, AgentsResponse, StepStatus, TaskDetail } from "@/lib/api-types";
import { durationMs } from "@/lib/format";
import { atmosphere, type Atmosphere, type AtmospherePhase } from "./atmosphere";
import type { CommandMapModel, EdgeModel, EdgeState, MapMode, RoleNodeModel, StepNodeModel } from "./command-map";
import { missionNo } from "./hud";
import type { LiveEffect } from "./live-diff";
import { ROLE_SEATS, ROOM_TITLE, walkPath, type WalkDest, type WalkOrigin } from "./office-layout";
import { isRole, ROLE_LABELS, ROLES, type Role } from "./roles";
import { verdictTone, type VerdictTone } from "./verdict";

export type FigureTone = "active" | "stale" | "idle" | "unknown" | VerdictTone;

export interface OfficeFigure {
  /** Seated at the desk exactly while the role holds a pending run on the focused mission. */
  posture: "seated" | "standing";
  tone: FigureTone;
  word: string;
  statusText: string;
  /** Pending runs beyond the one seat (drawn as a ×n badge); 0 normally. */
  extra: number;
  source: string;
}

export interface OfficeMetric {
  label: string;
  value: string;
  tone: FigureTone | null;
  source: string;
  /** The metric in words for the accessible name and the text version, when the card's short form needs its scope. */
  words?: string;
}

export interface RoleRoomModel {
  kind: "role";
  id: Role;
  title: string;
  seats: number;
  seatsSource: string;
  busy: number;
  /** "0/1 busy", or "2 reserved" when a role holds more than one pending run. */
  header: string;
  headerSource: string;
  figure: OfficeFigure;
  metrics: OfficeMetric[];
  openFindings: number;
  node: RoleNodeModel;
  aria: string;
  source: string;
}

export const RELEASE_STEPS = [
  { state: "COMMITTING", label: "COMMIT" },
  { state: "PUSHING", label: "PUSH" },
  { state: "PR", label: "PR" },
  { state: "DEPLOYING", label: "DEPLOY" },
] as const;

export interface ReleaseConsole {
  state: (typeof RELEASE_STEPS)[number]["state"];
  label: (typeof RELEASE_STEPS)[number]["label"];
  status: StepStatus | null;
  source: string;
}

export interface GateRoomModel {
  kind: "gate";
  id: "gate";
  title: string;
  word: string;
  state: EdgeState;
  statusText: string;
  release: ReleaseConsole[];
  ready: StepNodeModel;
  metrics: OfficeMetric[];
  aria: string;
  source: string;
}

export type CoreParticles = "ambient" | "orbit" | "energized" | "still";

export interface OfficeCore {
  phase: AtmospherePhase;
  particles: CoreParticles;
  alert: boolean;
  word: string;
  statusText: string;
  source: string;
}

export interface GateAlert {
  kind: "plan" | "human";
  title: string;
  text: string;
  /** The APPROVAL_REQUESTED timestamp the live timer counts from; null in a replay or when outside the window. */
  since: string | null;
  outsideWindow: boolean;
  recorded: boolean;
  source: string;
}

export interface OfficeScene {
  mode: MapMode;
  missionId: string | null;
  missionNo: string | null;
  rooms: RoleRoomModel[];
  gate: GateRoomModel;
  core: OfficeCore;
  synthesis: StepNodeModel;
  gateAlert: GateAlert | null;
  connections: EdgeModel[];
  atmo: Atmosphere;
}

export const SEATS_SOURCE = "one seat per role per mission: the Brain runs one run per role at a time; the governor has no per-role-per-mission limit (global limits in the panel)";
export const TYPICAL_SCOPE = "median duration of completed runs in /api/agents recent (the 20 newest finished runs of all missions and projects in the store: open missions and the 5 newest missions) and this mission's /api/tasks/:id agents";
export const REPLAY_TYPICAL = "not part of the recorded history";

// ---- typical durations ------------------------------------------------------------------------------

export interface Typical {
  medianMs: number | null;
  samples: number;
  source: string;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Per role: the median duration of completed runs with a positive duration, deduplicated across both sources. */
export function typicalDurations(agents: AgentsResponse | null, detail: TaskDetail | null): Record<Role, Typical> {
  const seen = new Set<string>();
  const byRole = new Map<Role, number[]>(ROLES.map((r) => [r, []]));
  for (const run of [...(agents?.recent ?? []), ...(detail?.agents ?? [])]) {
    const key = `${run.taskId}|${run.role}|${run.startedAt ?? ""}|${run.agentId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isRole(run.role) || run.status !== "completed" || run.durationMs === null || !Number.isFinite(run.durationMs) || run.durationMs <= 0) continue;
    byRole.get(run.role)?.push(run.durationMs);
  }
  return Object.fromEntries(ROLES.map((r) => [r, { medianMs: median(byRole.get(r) ?? []), samples: (byRole.get(r) ?? []).length, source: TYPICAL_SCOPE }])) as Record<Role, Typical>;
}

// ---- rooms ----------------------------------------------------------------------------------------

function figureTone(node: RoleNodeModel): FigureTone {
  if (node.state === "running") return node.stale ? "stale" : "active";
  if (node.state === "completed") return node.verdictTone;
  if (node.state === "failed" || node.state === "blocked") return "fail";
  if (node.state === "unknown") return "unknown";
  return "idle";
}

/** The latest non-pending result of a role on the mission: roleState's verdict, else the latest reported run. */
function lastResult(node: RoleNodeModel): { text: string; tone: VerdictTone } | null {
  if (node.verdict) return { text: node.verdict, tone: node.verdictTone };
  const run = [...node.runs].reverse().find((r) => r.status !== "pending" && r.status !== "not-launched");
  if (!run) return null;
  const text = run.verdict ?? (run.status === "lost" ? "lost" : run.status);
  return { text, tone: verdictTone(run.verdict, run.status) };
}

const DASH = "—";

function metric(label: string, value: string, source: string, tone: FigureTone | null = null): OfficeMetric {
  return { label, value, tone, source };
}

function roleRoom(node: RoleNodeModel, model: CommandMapModel, typical: Typical | null, replay: boolean): RoleRoomModel {
  const detail = model.detail;
  const id = node.id;
  const src = detail ? `/api/tasks/${detail.id} agents[role=${id}]` : `/api/agents recent[role=${id}]`;
  // an unusable integrity state reads UNKNOWN on the map, so the card claims no reservation either
  const unknown = node.state === "unknown";
  const busy = detail && !unknown ? node.runs.filter((r) => r.status === "pending").length : 0;
  const header = model.mode === "loading" || unknown ? `${DASH}/${ROLE_SEATS} busy` : busy > ROLE_SEATS ? `${busy} reserved` : `${busy}/${ROLE_SEATS} busy`;
  const seated = node.state === "running";

  let last: OfficeMetric;
  if (detail) {
    const r = lastResult(node);
    last = metric("LAST", r ? r.text : DASH, `${src} (roleState: latest reported run)`, r ? r.tone : null);
  } else if (node.recent) {
    const no = missionNo(node.recent.taskId);
    const text = node.recent.verdict ?? node.recent.status;
    last = metric("LAST", `${text}${no ? ` ${no}` : ""}`, `/api/agents recent[role=${id}]`, verdictTone(node.recent.verdict, node.recent.status));
  } else {
    last = metric("LAST", DASH, `/api/agents recent[role=${id}] (none)`);
  }
  const runs = metric("RUNS", detail ? String(node.runs.filter((r) => r.status === "completed").length) : DASH, detail ? `${src} status=completed` : "no mission in focus");
  const typ = replay
    ? { ...metric("TYPICAL", DASH, REPLAY_TYPICAL), words: `typical not shown (${REPLAY_TYPICAL})` }
    : typical && typical.medianMs !== null
      ? { ...metric("TYPICAL", `${durationMs(typical.medianMs)} n=${typical.samples}`, typical.source), words: `typical ${durationMs(typical.medianMs)} (recent runs of all missions and projects, n=${typical.samples})` }
      : { ...metric("TYPICAL", DASH, TYPICAL_SCOPE), words: "typical — (no completed run in the recent runs of all missions and projects)" };

  let metrics: OfficeMetric[];
  if (id === "planner") metrics = [runs, last, typ];
  else if (id === "developer") {
    const rounds = detail ? `${detail.rounds.length}/${detail.maxRounds}` : DASH;
    metrics = [runs, metric("FIX ROUNDS", rounds, detail ? `/api/tasks/${detail.id} rounds, maxRounds` : "no mission in focus"), typ];
  } else {
    const open = detail && model.findingsLoaded ? String(node.openFindings) : DASH;
    metrics = [last, metric("OPEN FINDINGS", open, detail ? `/api/tasks/${detail.id}/findings sources∋${id}, open statuses` : "no mission in focus", detail && node.openFindings > 0 ? "concern" : null), typ];
  }

  const elsewhere = node.elsewhere.length > 0 ? `; +${node.elsewhere.length} on other missions` : "";
  const posture = seated ? (node.stale ? "seated, reservation over the stale threshold" : "seated at the desk") : "standing";
  const aria = `${ROOM_TITLE[id]} room, ${ROLE_LABELS[id]}: ${node.stateWord}; ${node.statusText}; ${posture}; ${header}; ${metrics.map((m) => m.words ?? `${m.label.toLowerCase()} ${m.value}`).join(", ")}${elsewhere}`;

  return {
    kind: "role",
    id,
    title: ROOM_TITLE[id],
    seats: ROLE_SEATS,
    seatsSource: SEATS_SOURCE,
    busy,
    header,
    headerSource: detail ? `${src} status=pending` : "no mission in focus",
    figure: { posture: seated ? "seated" : "standing", tone: figureTone(node), word: node.stateWord, statusText: node.statusText, extra: Math.max(0, busy - ROLE_SEATS), source: node.source },
    metrics,
    openFindings: node.openFindings,
    node,
    aria,
    source: node.source,
  };
}

function gateRoom(model: CommandMapModel): GateRoomModel {
  const detail = model.detail;
  const g = model.gate;
  const release: ReleaseConsole[] = RELEASE_STEPS.map((s) => ({
    state: s.state,
    label: s.label,
    status: detail?.lifecycle.steps.find((x) => x.state === s.state)?.status ?? null,
    source: detail ? `/api/tasks/${detail.id} lifecycle.steps[${s.state}]` : "no mission in focus",
  }));
  const counted = release.filter((r) => r.status !== null && r.status !== "skipped");
  const done = counted.filter((r) => r.status === "completed").length;
  // every release step skipped is data ("skipped"); "—" only when there is nothing to read
  const allSkipped = release.length > 0 && release.every((r) => r.status === "skipped");
  const releaseText = !detail ? DASH : counted.length > 0 ? `${done} of ${counted.length}` : allSkipped ? "skipped" : DASH;
  const metrics = [
    metric("PLAN GATE", detail ? g.gate.plan.label : DASH, g.gate.plan.source),
    metric("HUMAN GATE", detail ? g.gate.human.label : DASH, g.gate.human.source),
    metric("RELEASE", releaseText, detail ? `/api/tasks/${detail.id} lifecycle.steps[COMMITTING|PUSHING|PR|DEPLOYING] completed of not skipped` : "no mission in focus"),
  ];
  const aria = `Commander Gate and release room: ${g.statusText || g.stateWord}; ${metrics.map((m) => m.words ?? `${m.label.toLowerCase()} ${m.value}`).join(", ")}; no approval control here, approval happens in the Claude Code session`;
  return { kind: "gate", id: "gate", title: ROOM_TITLE.gate, word: g.stateWord, state: g.state, statusText: g.statusText, release, ready: model.ready, metrics, aria, source: g.source };
}

/** The core's word: the same rules as the map's core node. */
export function coreWord(model: CommandMapModel): string {
  const s = model.core.status;
  if (s === "BLOCKED" || s === "COMPLETE" || s === "CANCELLED" || s === "CORRUPT" || s === "INCOMPLETE") return s;
  if (model.mode === "replay") return "REPLAY";
  if (model.mode === "live") return "LIVE";
  if (model.mode === "loading") return model.core.statusText.startsWith("ERROR") ? "ERROR" : "LOADING";
  return "STANDBY";
}

function coreModel(model: CommandMapModel, atmo: Atmosphere): OfficeCore {
  const particles: CoreParticles = atmo.ambient ? "ambient" : atmo.animated ? (atmo.energized ? "energized" : "orbit") : "still";
  return { phase: atmo.phase, particles, alert: model.core.status === "BLOCKED", word: coreWord(model), statusText: model.core.statusText, source: `${model.core.source}; ${atmo.source}` };
}

function gateAlert(model: CommandMapModel): GateAlert | null {
  const gate = model.gate.gate;
  if (model.mode === "replay") {
    if (!gate.active) return null;
    return {
      kind: gate.active,
      title: "AWAITED APPROVAL · recorded",
      text: gate.active === "plan" ? "plan gate · planner → developer" : "human gate · after READY",
      since: null,
      outsideWindow: false,
      recorded: true,
      source: gate.request?.source ?? (gate.active === "plan" ? gate.plan.source : gate.human.source),
    };
  }
  const c = model.gateCallout;
  if (!c || model.mode !== "live") return null;
  return { kind: c.kind, title: "WAITING ON YOU", text: c.title, since: gate.request?.ts ?? null, outsideWindow: c.requestOutsideWindow, recorded: false, source: c.source };
}

export function buildOfficeScene(model: CommandMapModel, opts: { agents: AgentsResponse | null; replay: boolean }): OfficeScene {
  const replay = opts.replay || model.mode === "replay";
  const typical = replay ? null : typicalDurations(opts.agents, model.detail);
  const atmo = atmosphere(model);
  return {
    mode: model.mode,
    missionId: model.missionId,
    missionNo: missionNo(model.missionId),
    rooms: model.roles.map((node) => roleRoom(node, model, typical ? typical[node.id] : null, replay)),
    gate: gateRoom(model),
    core: coreModel(model, atmo),
    synthesis: model.synthesis,
    gateAlert: gateAlert(model),
    connections: model.edges,
    atmo,
  };
}

// ---- walks ----------------------------------------------------------------------------------------

export const MAX_WALKERS = 4;
export const LIVE_WALK_MS = 2400;

/** A live walk lasts 2.4 s; a replayed one ends before the next step (0.85 of the step time). */
export function walkMs(replay: boolean, stepMs: number | null): number {
  return replay && stepMs ? Math.round(stepMs * 0.85) : LIVE_WALK_MS;
}

export interface Walker {
  key: string;
  origin: WalkOrigin;
  dest: WalkDest;
  /** The offset-path the token follows (world units). */
  d: string;
  /** The mission number on the token's tag. */
  label: string;
  /** "#0002 ← Planner": the static chip under reduced motion and the text equivalent. */
  text: string;
  durationMs: number;
  source: string;
}

interface EffectLike {
  key: string;
  effect: LiveEffect;
  missionId?: string;
}

const ts = (s: string | null): number => (s ? Date.parse(s) : Number.NaN);

/** The role whose run finished last at or before `limit` (any time when null), excluding `except`; else the core. */
function handoffOrigin(detail: TaskDetail, except: Role | null, limit: number | null): WalkOrigin {
  let best: AgentRun | null = null;
  for (const r of detail.agents) {
    if (r.status === "pending" || !r.completedAt || r.role === except || !isRole(r.role)) continue;
    const t = ts(r.completedAt);
    if (!Number.isFinite(t) || (limit !== null && t > limit)) continue;
    if (!best || t > ts(best.completedAt)) best = r;
  }
  return best && isRole(best.role) ? best.role : "core";
}

function originLabel(o: WalkOrigin): string {
  return o === "core" ? "Brain core" : o === "synthesis" ? "Synthesis" : ROLE_LABELS[o];
}

/**
 * The mission tokens walking right now: one per `agent-start` (from the role that handed over to the new run; a
 * developer fix round comes from synthesis along the fix loop) and per `gate-raised` (to the gate room).
 * Nothing else walks; live effects of another mission are dropped.
 */
export function officeWalks(effects: readonly EffectLike[], model: CommandMapModel, opts: { replay: boolean; stepMs: number | null; missionId: string | null }): Walker[] {
  const detail = model.detail;
  if (!detail || !opts.missionId || detail.id !== opts.missionId) return [];
  const label = missionNo(detail.id) ?? detail.id;
  const duration = walkMs(opts.replay, opts.stepMs);
  const out: Walker[] = [];
  for (const fx of effects) {
    if (!opts.replay && fx.missionId !== opts.missionId) continue;
    const e = fx.effect;
    let origin: WalkOrigin;
    let dest: WalkDest;
    if (e.kind === "agent-start") {
      dest = e.target;
      const run = detail.agents
        .filter((r) => r.role === e.target && r.status === "pending")
        .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""))
        .pop();
      const started = run ? ts(run.startedAt) : Number.NaN;
      // a fix round is the Brain's synthesis sending the developer back along the fix loop (E12)
      const fix = e.target === "developer" && (run?.kind === "fix" || detail.lifecycle.current === "FIXING");
      origin = fix ? "synthesis" : handoffOrigin(detail, e.target, Number.isFinite(started) ? started : null);
    } else if (e.kind === "gate-raised") {
      dest = "gate";
      origin = handoffOrigin(detail, null, null);
    } else continue;
    out.push({
      key: fx.key,
      origin,
      dest,
      d: walkPath(origin, dest),
      label,
      text: `${label} ← ${originLabel(origin)}`,
      durationMs: duration,
      source: `${opts.replay ? "replay step" : "live diff"} ${e.kind} (${e.target}); origin from /api/tasks/${detail.id} agents completedAt`,
    });
    if (out.length >= MAX_WALKERS) break;
  }
  return out;
}

// ---- card rows ----------------------------------------------------------------------------------

/** Advance of the 15 px card text: row labels (0.04em tracking) and values, world units per character. */
export const LABEL_CHAR = 9.6;
export const VALUE_CHAR = 9.1;

export interface CardLine {
  label: string;
  value: string;
  tone: FigureTone | null;
}

/**
 * Shortens text to at most `max` characters, cutting only at a word boundary and ending with an ellipsis, so an
 * id or a mission number is never split. A single word longer than `max` is returned whole.
 */
export function fitWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const words = text.split(" ");
  let out = "";
  for (const w of words) {
    const next = out ? `${out} ${w}` : w;
    if (next.length + 1 > max) break;
    out = next;
  }
  return out ? `${out.replace(/[\s,;:·]+$/, "")}…` : text;
}

/**
 * The lines of a card: each metric on one line (label left, value right) when both fit in `width`; otherwise the
 * value gets its own line under the label. With more than `maxLines`, the last wrapped values fold back onto
 * their label line, shortened at a word boundary.
 */
export function cardLines(metrics: readonly OfficeMetric[], width: number, maxLines: number): CardLine[] {
  const fits = (label: string, value: string) => (label ? label.length * LABEL_CHAR + VALUE_CHAR : 0) + value.length * VALUE_CHAR <= width;
  const groups = metrics.map((m) => (fits(m.label, m.value) ? [{ label: m.label, value: m.value, tone: m.tone }] : [{ label: m.label, value: "", tone: m.tone }, { label: "", value: fitWords(m.value, Math.floor(width / VALUE_CHAR)), tone: m.tone }]));
  for (let g = groups.length - 1; g >= 0 && groups.reduce((n, x) => n + x.length, 0) > maxLines; g--) {
    const group = groups[g];
    const m = metrics[g];
    if (!group || !m || group.length === 1) continue;
    const room = Math.floor((width - m.label.length * LABEL_CHAR - VALUE_CHAR) / VALUE_CHAR);
    groups[g] = [{ label: m.label, value: fitWords(m.value, room), tone: m.tone }];
  }
  return groups.flat();
}
