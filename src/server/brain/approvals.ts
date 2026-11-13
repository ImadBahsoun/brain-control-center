import "server-only";
import type { ApprovalItem, ApprovalsResponse, ApprovalStatus } from "@/lib/api-types";
import type { BrainEvent } from "./events";
import { ACTION_RE, gateRequestStatus, MAX_ACTIONS, readGateStateFile } from "./gate";
import { asArr, asNum, asObj, asStr, asStrs, epochMs, parseJson, toIso } from "./jsonish";
import type { BrainRoots } from "./roots";
import { loadTask, scanTasks } from "./task-store";

/**
 * The Approval Center: one row per brain-gate request, and a mission link only when it is provable
 * without approval codes or the ids of the Claude Code process that raised a request.
 *
 * What is read, and nothing else:
 * - from each gate request (the `requests` object's VALUES only; its keys are live approval codes and are
 *   never read): `actions`, `created`, `expires`, `consumed_at`, `revoked_at`, `repos[].top`, `repos[].head`;
 * - from each brain-state APPROVAL_REQUESTED event of kind "gate": the task id, `ts`, and `payload.repo`,
 *   `payload.head`, `payload.actions`.
 * The request heads, `created` and the resolution times are used here only and never emitted.
 */

const MAX_REPOS = 5;
/** The shortest event head treated as evidence (brain-gate's deny text prints 7 characters). */
const MIN_HEAD = 7;
/** An event older than this can no longer be checked against every request it could belong to (see linkRequests). */
const LINK_MAX_AGE_SEC = 23 * 3600;

export interface GateBinding {
  top: string | null;
  head: string | null;
}

/** A gate request as the matcher sees it. Times are epoch seconds; null when not recorded as a number. */
export interface GateRequestView {
  status: ApprovalStatus;
  /** Display actions: the safe alphabet only, at most MAX_ACTIONS. */
  actions: string[];
  /** Every string action, for set comparison only. */
  matchActions: string[];
  repos: GateBinding[];
  created: number | null;
  expires: number | null;
  /** The earliest of `expires`, `consumed_at` and `revoked_at` that is a number; null when none is. */
  windowEnd: number | null;
}

/** A Brain-recorded gate approval event as the matcher sees it. `ts` is epoch seconds. */
export interface GateEventView {
  taskId: string;
  ts: number;
  repo: string | null;
  head: string | null;
  /** null when the event records no actions. */
  actions: string[] | null;
}

export function projectGateRequests(buf: Buffer, nowMs: number): { status: "ok"; requests: GateRequestView[] } | { status: "invalid" } {
  const root = asObj(parseJson(buf));
  if (!root) return { status: "invalid" };
  const out: GateRequestView[] = [];
  for (const value of Object.values(asObj(root.requests) ?? {})) {
    const r = asObj(value);
    if (!r) continue;
    const matchActions = asArr(r.actions).filter((a): a is string => typeof a === "string");
    const actions: string[] = [];
    for (const a of matchActions) if (ACTION_RE.test(a) && !actions.includes(a) && actions.length < MAX_ACTIONS) actions.push(a);
    const repos: GateBinding[] = [];
    for (const b of asArr(r.repos)) {
      // the real shape is {top, head}; a bare path string is tolerated as a binding with no head
      if (typeof b === "string") repos.push({ top: b, head: null });
      else {
        const o = asObj(b);
        if (o) repos.push({ top: asStr(o.top), head: asStr(o.head) });
      }
    }
    const expires = asNum(r.expires);
    const ends = [expires, asNum(r.consumed_at), asNum(r.revoked_at)].filter((n): n is number => n !== null);
    out.push({
      status: gateRequestStatus(r, nowMs),
      actions,
      matchActions,
      repos,
      created: asNum(r.created),
      expires,
      windowEnd: ends.length > 0 ? Math.min(...ends) : null,
    });
  }
  return { status: "ok", requests: out };
}

/**
 * The gate events of the given tasks' logs. `badTs` is true when a gate event's timestamp could not be
 * parsed: that event cannot be placed in any window, so the caller must not link anything.
 */
export function projectGateEvents(tasks: ReadonlyArray<{ id: string; events: readonly BrainEvent[] }>): { events: GateEventView[]; badTs: boolean } {
  const events: GateEventView[] = [];
  let badTs = false;
  for (const t of tasks) {
    for (const ev of t.events) {
      if (ev.type !== "APPROVAL_REQUESTED" || asStr(ev.payload.kind) !== "gate") continue;
      const ms = epochMs(ev.ts);
      if (ms === null) {
        badTs = true;
        continue;
      }
      const actions = asStrs(ev.payload.actions);
      events.push({
        taskId: t.id,
        ts: ms / 1000,
        repo: asStr(ev.payload.repo),
        head: asStr(ev.payload.head),
        actions: actions.length > 0 ? actions : null,
      });
    }
  }
  return { events, badTs };
}

type EventClass = "EXCLUDED" | "MATCH" | "UNKNOWN";

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

/**
 * An absolute path without a single trailing slash, or null when it is not comparable as text: relative,
 * or holding a `.`, `..` or empty segment (resolving those textually would be wrong across a symlink, and
 * nothing here resolves paths on disk).
 */
function normRepo(p: string | null): string | null {
  if (p === null || !p.startsWith("/")) return null;
  const body = p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
  if (body === "/") return body;
  return body.slice(1).split("/").some((s) => s === "" || s === "." || s === "..") ? null : body;
}

function usableHead(h: string | null): h is string {
  return h !== null && h.length >= MIN_HEAD;
}

export function classifyEvent(ev: GateEventView, req: GateRequestView): EventClass {
  if (ev.actions !== null && !sameSet(ev.actions, req.matchActions)) return "EXCLUDED";
  const head = ev.head;
  // a head can only prove a difference against a request that has bindings to compare it with
  if (usableHead(head) && req.repos.length > 0 && !req.repos.some((b) => b.head !== null && b.head.startsWith(head))) return "EXCLUDED";
  if (req.repos.length !== 1 || !usableHead(head)) return "UNKNOWN";
  const binding = req.repos[0] as GateBinding;
  if (binding.head === null || !binding.head.startsWith(head)) return "UNKNOWN";
  const evRepo = normRepo(ev.repo);
  if (evRepo === null || evRepo !== normRepo(binding.top)) return "UNKNOWN";
  return "MATCH";
}

/** A request's window: from `created` to `windowEnd`, unbounded on any side that is not recorded. */
function inWindow(ts: number, req: GateRequestView): boolean {
  return (req.created === null || ts >= req.created) && (req.windowEnd === null || ts <= req.windowEnd);
}

/**
 * The task each request is provably linked to, by index, or null ("Unlinked"). A request links to task T
 * only when exactly one event in its window is a MATCH, no event in its window is UNKNOWN, every other
 * request that already existed at that event's time is provably different (EXCLUDED), and the event is
 * under 23 h old (its true request, created at most 30 min before it, is then not yet pruned from
 * state.json, which happens no earlier than 24 h after creation). The cross-check covers requests already
 * consumed, revoked or expired by then, because the Brain may record an event after its own request was
 * resolved. A request without a numeric `created` or `expires` is never linked.
 */
export function linkRequests(reqs: readonly GateRequestView[], events: readonly GateEventView[], nowMs: number): Array<string | null> {
  const nowSec = nowMs / 1000;
  return reqs.map((req, i) => {
    if (req.created === null || req.expires === null) return null;
    const candidates = events.filter((ev) => inWindow(ev.ts, req));
    const classes = candidates.map((ev) => classifyEvent(ev, req));
    if (classes.includes("UNKNOWN")) return null;
    const matches = candidates.filter((_, k) => classes[k] === "MATCH");
    if (matches.length !== 1) return null;
    const ev = matches[0] as GateEventView;
    if (nowSec - ev.ts >= LINK_MAX_AGE_SEC) return null;
    for (let j = 0; j < reqs.length; j++) {
      const other = reqs[j] as GateRequestView;
      if (j === i || (other.created !== null && ev.ts < other.created)) continue;
      if (classifyEvent(ev, other) !== "EXCLUDED") return null;
    }
    return ev.taskId;
  });
}

function emptyCounts(): Record<ApprovalStatus, number> {
  return { pending: 0, consumed: 0, expired: 0, revoked: 0 };
}

const LOG_UNUSABLE = new Set<string>(["corrupt", "missing", "unsafe", "too_large"]);

/**
 * The brain-state gate events that could fall in any live request's window, or null when the task scan
 * is not reliable enough to prove a link (tasks root not ok, scan capped, an unsafe task, or a task active
 * since the earliest request whose log cannot be fully read).
 */
async function gateEventsSince(roots: BrainRoots, earliestSec: number, nowMs: number): Promise<GateEventView[] | null> {
  const scan = await scanTasks(roots, nowMs);
  if (scan.store.status !== "ok" || scan.listing.scanLimitReached || scan.unsafeTasks > 0 || scan.listing.unsafeEntries > 0) return null;
  const logs: Array<{ id: string; events: readonly BrainEvent[] }> = [];
  for (const task of scan.tasks) {
    // an unusable log's last activity is unknown (only a valid prefix, or nothing, was read): it may hold
    // events inside a live window, so no link can be proven
    if (LOG_UNUSABLE.has(task.integrity.log)) return null;
    const last = epochMs(task.summary.lastEventAt);
    if (last !== null && last / 1000 < earliestSec) continue;
    let loaded = task;
    if (loaded.log === null) {
      const r = await loadTask(roots, task.id, { fullLog: true, nowMs, store: scan.store });
      if (r.kind !== "loaded") return null;
      loaded = r.task;
    }
    if (loaded.log === null || LOG_UNUSABLE.has(loaded.integrity.log)) return null;
    logs.push({ id: loaded.id, events: loaded.log.events });
  }
  const { events, badTs } = projectGateEvents(logs);
  return badTs ? null : events;
}

export async function approvalsResponse(roots: BrainRoots, nowMs: number): Promise<ApprovalsResponse> {
  const counts = emptyCounts();
  const base: ApprovalsResponse = { generatedAt: new Date(nowMs).toISOString(), gate: { status: "missing" }, linking: "unavailable", counts, items: [] };
  const st = await readGateStateFile(roots);
  if (st.status !== "ok") return { ...base, gate: { status: st.status } };
  const projected = projectGateRequests(st.data, nowMs);
  if (projected.status !== "ok") return { ...base, gate: { status: "invalid" } };
  const reqs = projected.requests;

  let links: Array<string | null> = reqs.map(() => null);
  let linking: ApprovalsResponse["linking"] = "ok";
  if (reqs.some((r) => r.created === null || r.expires === null)) {
    // a request with an unrecorded time could hold any event, which would also mean reading every log: no scan
    linking = "unavailable";
  } else if (reqs.length > 0) {
    const earliest = reqs.reduce((m, r) => Math.min(m, r.created ?? Infinity), Infinity);
    const events = await gateEventsSince(roots, earliest, nowMs);
    if (events === null) linking = "unavailable";
    else links = linkRequests(reqs, events, nowMs);
  }

  const order = reqs.map((_, i) => i).sort((a, b) => ((reqs[b] as GateRequestView).created ?? -Infinity) - ((reqs[a] as GateRequestView).created ?? -Infinity) || a - b);
  const items: ApprovalItem[] = order.map((i) => {
    const r = reqs[i] as GateRequestView;
    counts[r.status]++;
    const repositories: string[] = [];
    for (const b of r.repos) if (b.top !== null && b.top.trim() !== "" && !repositories.includes(b.top) && repositories.length < MAX_REPOS) repositories.push(b.top);
    const taskId = links[i] ?? null;
    return { actions: r.actions, repositories, expires: r.expires !== null ? toIso(r.expires) : null, status: r.status, mission: taskId !== null ? { taskId } : null };
  });
  return { ...base, gate: { status: "ok" }, linking, counts, items };
}
