// Which mission the command map focuses on. Pure.
import type { TaskDetail, TaskSummary } from "@/lib/api-types";
import { isTerminalStatus, mapState, TIMELINE } from "@/lib/lifecycle";

/** The auto focus the map held on the previous poll, so it stays put while its mission remains active. */
export interface AutoFocus {
  id: string;
  /** Whether the mission is still held; a just-completed one is held until its terminal detail has been shown. */
  active: boolean;
  /**
   * Set while a previously active focus is held after it turned terminal. `seen`: its terminal detail has
   * arrived; `stamp`: the /api/tasks generatedAt when it was seen (or when the hold began); `last`: the latest
   * distinct generatedAt; `polls`: distinct polls since the hold began.
   */
  hold?: { seen: boolean; stamp: string | null; last: string | null; polls: number };
}

/** A held terminal focus is released after this many distinct /api/tasks polls, even when its detail never arrives. */
export const HOLD_MAX_POLLS = 3;
/**
 * A poll releases a seen hold only when its generatedAt is at least this long after the one the terminal detail
 * was seen at. When the last active mission ends, the cadence switches 2.5 s → 15 s and /api/tasks is refetched
 * at once; that refetch arrives within milliseconds and must not cut the READY / mission-complete effect (1.5 s).
 * Shorter than the 2.5 s poll, so with another active mission the hold lasts one poll.
 */
export const HOLD_MIN_MS = 2000;

export interface AutoFocusInput {
  focusId: string | null;
  chosenId: string | null;
  /** The focused mission's summary in the current /api/tasks body. */
  summary: TaskSummary | null;
  /** The focused mission's detail when it was fetched for this focus (null otherwise). */
  detail: TaskDetail | null;
  /** /api/tasks generatedAt (ISO): one value per poll. */
  tasksStamp: string | null;
}

/** Whether poll stamp `b` is at least HOLD_MIN_MS after `a` (stamps that cannot be read count as apart). */
function apart(a: string | null, b: string | null): boolean {
  const x = a === null ? Number.NaN : Date.parse(a);
  const y = b === null ? Number.NaN : Date.parse(b);
  return Number.isNaN(x) || Number.isNaN(y) || y - x >= HOLD_MIN_MS;
}

/**
 * The auto focus to remember for the next render. A focus that turned terminal while it was auto-focused is
 * held (active) until its terminal detail has been seen and a later /api/tasks poll at least HOLD_MIN_MS
 * after that has arrived, so READY and mission-complete play on that mission; it is always released after
 * HOLD_MAX_POLLS distinct polls. Calling it again with the same inputs returns an equal value (it runs on
 * every render).
 */
export function nextAutoFocus(prev: AutoFocus | null, input: AutoFocusInput): AutoFocus | null {
  const { focusId, chosenId, summary, detail, tasksStamp } = input;
  if (!focusId || chosenId || !summary) return null;
  if (summary.active) return { id: focusId, active: true };
  if (!prev || prev.id !== focusId || !prev.active) return { id: focusId, active: false };
  const seenNow = detail !== null && detail.id === focusId && !detail.active;
  const hold = prev.hold;
  if (!hold) return { id: focusId, active: true, hold: { seen: seenNow, stamp: tasksStamp, last: tasksStamp, polls: 0 } };
  const newPoll = tasksStamp !== hold.last;
  const polls = hold.polls + (newPoll ? 1 : 0);
  if (polls >= HOLD_MAX_POLLS || (hold.seen && newPoll && apart(hold.stamp, tasksStamp))) return { id: focusId, active: false };
  if (seenNow && !hold.seen) return { id: focusId, active: true, hold: { seen: true, stamp: tasksStamp, last: tasksStamp, polls } };
  return { id: focusId, active: true, hold: { seen: hold.seen, stamp: hold.stamp, last: tasksStamp, polls } };
}

/**
 * Data counts for the current focus only when it is a different object from the one the poll slot held when the
 * focus changed (`baseline`): a slot keeps its last body per URL, so switching back to a mission must not show
 * its old body before a fresh one arrives. Clock-free.
 */
export function freshFor<T>(data: T | null, baseline: T | null, matches: (d: T) => boolean): T | null {
  return data !== null && data !== baseline && matches(data) ? data : null;
}

/** The fallback used when `now` is unknown, and when `now` is known but nothing is live: the previous auto
 * focus while its mission is still listed and (still active, or held by nextAutoFocus's terminal hold),
 * else the active (ACTIVE, WAITING or BLOCKED) task with the newest lastEventAt; otherwise null. */
function activeFallback(tasks: readonly TaskSummary[], previous: AutoFocus | null): string | null {
  if (previous) {
    const kept = tasks.find((t) => t.id === previous.id);
    if (kept && (kept.active || previous.active)) return kept.id;
  }
  let best: TaskSummary | null = null;
  for (const t of tasks) {
    if (!t.active) continue;
    if (best === null || (t.lastEventAt ?? "") > (best.lastEventAt ?? "")) best = t;
  }
  return best?.id ?? null;
}

/**
 * The chosen id when it is in the list. Otherwise the auto focus. Without `now` (or when no `now` was
 * ever passed), this is exactly `activeFallback`: the behaviour this function has always had.
 *
 * With `now`, Auto Focus prefers a genuinely live mission (`classifyMission` below): a previous focus is
 * kept while it is still live itself, or while it is held through a terminal transition for the READY /
 * mission-complete effect, or when nothing is live at all (the fallback above, unchanged). Otherwise the
 * newest running mission wins, then the newest awaiting-approval one; with no live mission, the
 * fallback's newest non-terminal (`t.active`) pick applies, as before.
 *
 * The "held through a terminal transition" case covers two renders of the same hold, because this
 * function runs during render, before the effect that calls `nextAutoFocus` for this same poll:
 * - the poll AFTER the one nextAutoFocus started the hold on: `previous.hold !== undefined`.
 * - the poll the mission actually turns terminal on: `previous` is still the plain `{id, active:true}`
 *   nextAutoFocus wrote while the mission was active (it hasn't run yet for this poll), but `kept` (the
 *   mission's current summary) is now non-active. Treating this as held too means the focus does not
 *   jump away before nextAutoFocus gets to start the hold; nextAutoFocus then takes over the hold and
 *   releases it per HOLD_MIN_MS / HOLD_MAX_POLLS exactly as it always has.
 *
 * A mission that merely turns READY while live-but-not-running (no other mission live) is not covered by
 * either case — it is only kept because nothing else is live, so it is released as soon as something is;
 * giving READY itself a one-poll hold while something else is live is a product decision, deferred.
 */
export function selectFocus(tasks: readonly TaskSummary[] | null | undefined, chosenId: string | null, previous: AutoFocus | null = null, now: string | null = null): string | null {
  if (!tasks || tasks.length === 0) return null;
  if (chosenId && tasks.some((t) => t.id === chosenId)) return chosenId;
  if (now === null) return activeFallback(tasks, previous);

  const isLive = (t: TaskSummary) => {
    const c = classifyMission(t, now);
    return c === "running" || c === "awaiting";
  };
  if (!tasks.some(isLive)) return activeFallback(tasks, previous);

  if (previous) {
    const kept = tasks.find((t) => t.id === previous.id);
    // Held through a terminal transition: either nextAutoFocus already started the hold (`previous.hold`),
    // or this is the very poll the mission turned terminal on, so nextAutoFocus has not run for it yet —
    // `previous` is still its plain active record, but `kept` now reports non-active.
    const held = previous.active && (previous.hold !== undefined || (kept !== undefined && !kept.active));
    if (kept && (isLive(kept) || held)) return kept.id;
  }

  let bestRunning: TaskSummary | null = null;
  let bestAwaiting: TaskSummary | null = null;
  for (const t of tasks) {
    const c = classifyMission(t, now);
    if (c === "running") {
      if (bestRunning === null || (t.lastEventAt ?? "") > (bestRunning.lastEventAt ?? "")) bestRunning = t;
    } else if (c === "awaiting") {
      if (bestAwaiting === null || (t.lastEventAt ?? "") > (bestAwaiting.lastEventAt ?? "")) bestAwaiting = t;
    }
  }
  return bestRunning?.id ?? bestAwaiting?.id ?? null;
}

export function isDebrief(summary: TaskSummary): boolean {
  return isTerminalStatus(summary.status) || summary.status === "CORRUPT" || summary.status === "INCOMPLETE";
}

/** The timeline index of a recorded state (the first lit step), without inferring earlier steps. */
export function summaryPosition(state: string | null | undefined): number | null {
  const lit = mapState(state);
  if (lit.length === 0) return null;
  const first = lit[0];
  return first === undefined ? null : TIMELINE.indexOf(first);
}

// ---- mission strip: which missions the command map shows as "live" ------------------------------------

/** A mission is "running" while its lastEventAt is this recent, whatever its pendingRuns. */
export const RUNNING_WINDOW_MIN = 60;
/** With a pending reservation (pendingRuns > 0), a mission still counts "running" up to this much older. */
export const RESERVATION_WINDOW_MIN = 240;

export type MissionLiveness = "running" | "awaiting" | "open" | "closed";

/** Minutes from `from` to `now`, or null when either is missing or unparseable (never the browser clock). */
function minutesSince(from: string | null, now: string | null): number | null {
  if (!from || !now) return null;
  const f = Date.parse(from);
  const n = Date.parse(now);
  if (Number.isNaN(f) || Number.isNaN(n)) return null;
  return (n - f) / 60_000;
}

/**
 * Classifies a mission against `now` (the /api/tasks generatedAt — never the browser clock):
 * - closed: terminal (COMPLETE, CANCELLED).
 * - awaiting: status WAITING, at any age. It leaves this class only when its status changes (approval
 *   resolved, cancelled, superseded), never by age.
 * - running: status ACTIVE, not `ready`, and either lastEventAt is within RUNNING_WINDOW_MIN of `now`,
 *   or pendingRuns > 0 and lastEventAt is within RESERVATION_WINDOW_MIN of `now`. Both windows are
 *   inclusive (exactly at the boundary still counts). A missing or unparseable lastEventAt or `now`
 *   never counts as recent, so it never classifies as running.
 * - open: everything else non-terminal (READY, BLOCKED, a stale or abandoned reservation, CORRUPT /
 *   INCOMPLETE, since isTerminalStatus does not treat them as terminal).
 *
 * This is an indicator, not proof an agent process is alive: recent Brain activity or a recorded
 * reservation, nothing more.
 */
export function classifyMission(t: TaskSummary, now: string | null): MissionLiveness {
  if (isTerminalStatus(t.status)) return "closed";
  if (t.status === "WAITING") return "awaiting";
  if (t.status === "ACTIVE" && !t.ready) {
    const age = minutesSince(t.lastEventAt, now);
    if (age !== null && (age <= RUNNING_WINDOW_MIN || (t.pendingRuns > 0 && age <= RESERVATION_WINDOW_MIN))) return "running";
  }
  return "open";
}

/** The mission strip shows at most this many live chips before folding the rest into "+N more". */
export const MISSION_STRIP_LIMIT = 5;

/** An awaiting-approval mission with `lastEventAt` within this many minutes of `now` counts as "recent" for
 * the mission strip and shows by default; older ones move into the collapsed "Older pending" section. */
export const RECENT_PENDING_WINDOW_MIN = 24 * 60;

export interface MissionStrip {
  /** Live missions (recent awaiting approval first, then running; newest lastEventAt first within each), capped. */
  live: TaskSummary[];
  /** Live missions beyond the cap, folded into "+N more". */
  moreCount: number;
  /** Total live missions (running + awaiting, of any age), whether or not shown in `live`. */
  liveCount: number;
  /** Total open missions (non-terminal, not live). */
  openCount: number;
  /** Awaiting-approval missions older than RECENT_PENDING_WINDOW_MIN (or with an unprovable age), newest first, uncapped. */
  olderPending: TaskSummary[];
  /** olderPending.length. */
  olderPendingCount: number;
}

function byNewestEvent(a: TaskSummary, b: TaskSummary): number {
  return (b.lastEventAt ?? "").localeCompare(a.lastEventAt ?? "");
}

/** Buckets `tasks` by classifyMission and orders the live ones for the mission strip; closed missions are ignored.
 * Awaiting-approval missions split into recent (within RECENT_PENDING_WINDOW_MIN of `now`, inclusive) and older
 * (further than the window, or with a lastEventAt/now that cannot be parsed, so recency cannot be proven). */
export function buildMissionStrip(tasks: readonly TaskSummary[], now: string | null): MissionStrip {
  const awaitingRecent: TaskSummary[] = [];
  const awaitingOlder: TaskSummary[] = [];
  const running: TaskSummary[] = [];
  let openCount = 0;
  let awaitingCount = 0;
  for (const t of tasks) {
    const c = classifyMission(t, now);
    if (c === "awaiting") {
      awaitingCount++;
      const age = minutesSince(t.lastEventAt, now);
      if (age !== null && age <= RECENT_PENDING_WINDOW_MIN) awaitingRecent.push(t);
      else awaitingOlder.push(t);
    } else if (c === "running") running.push(t);
    else if (c === "open") openCount++;
  }
  awaitingRecent.sort(byNewestEvent);
  awaitingOlder.sort(byNewestEvent);
  running.sort(byNewestEvent);
  const ordered = [...awaitingRecent, ...running];
  return {
    live: ordered.slice(0, MISSION_STRIP_LIMIT),
    moreCount: Math.max(0, ordered.length - MISSION_STRIP_LIMIT),
    liveCount: awaitingCount + running.length,
    openCount,
    olderPending: awaitingOlder,
    olderPendingCount: awaitingOlder.length,
  };
}

/**
 * The selected mission's summary when it is not among `strip.live` — wherever it actually is (older pending,
 * open, or closed) — so the mission bar can always render it as a pinned chip. Returns null when `selectedId`
 * is null, already in `strip.live`, or not found in `tasks` at all.
 */
export function pinnedMission(strip: MissionStrip, tasks: readonly TaskSummary[], selectedId: string | null): TaskSummary | null {
  if (!selectedId || strip.live.some((t) => t.id === selectedId)) return null;
  return tasks.find((t) => t.id === selectedId) ?? null;
}

export interface OlderPendingView {
  /** The standalone pinned chip to render next to the live strip, or null while the "Older pending" section is
   * open and `pinned` is itself one of the older-pending missions (it is then shown inline in `expandedList`
   * instead, so it is never duplicated). */
  pinnedChip: TaskSummary | null;
  /** All older-pending missions, in `strip.olderPending`'s order, unfiltered — the expanded section always
   * lists every one of them, including the selected one (rendered active by the caller). */
  expandedList: TaskSummary[];
}

/**
 * How the "Older pending" section and the standalone pinned chip divide up `pinned` (from `pinnedMission`)
 * between them, so the selected mission is never shown twice and the expanded list is never missing one:
 * - collapsed (`open` false): the pinned chip always shows `pinned` (unchanged); `expandedList` is still the
 *   full list, for when the caller opens it.
 * - expanded (`open` true) and `pinned` is older pending: no standalone pinned chip (it is already in
 *   `expandedList`, which the caller renders with it marked active).
 * - expanded and `pinned` is open/closed (not in `strip.olderPending`) or null: the standalone pinned chip is
 *   unchanged.
 */
export function olderPendingView(strip: MissionStrip, pinned: TaskSummary | null, open: boolean): OlderPendingView {
  const pinnedIsOlderPending = pinned !== null && strip.olderPending.some((t) => t.id === pinned.id);
  return {
    pinnedChip: open && pinnedIsOlderPending ? null : pinned,
    expandedList: strip.olderPending,
  };
}
