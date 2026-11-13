import "server-only";
import type { MissionLog } from "./missions";

/**
 * The attribution algorithm (no grace period, nothing guessed): a subagent file links to its mission by
 * agent_id; a main-session call lands in the mission whose session window (first→last event of that
 * session in that mission) contains its timestamp. Anything that does not fit one of these exactly is
 * labelled with the reason it could not be attributed, never silently dropped or folded into a guess.
 */

export const ATTRIBUTION_REASONS = [
  "agent-link",
  "mission-window",
  "overlapping-missions",
  "outside-mission-window",
  "session-not-in-brain-state",
  "subagent-not-in-brain-state",
  "ambiguous-agent-id",
  "mission-log-unusable",
] as const;
export type AttributionReason = (typeof ATTRIBUTION_REASONS)[number];

export interface SessionWindow {
  taskId: string;
  start: string;
  end: string;
}

export interface MissionIndex {
  agentIdToTasks: ReadonlyMap<string, ReadonlySet<string>>;
  sessionWindows: ReadonlyMap<string, readonly SessionWindow[]>;
  allKnownSessions: ReadonlySet<string>;
}

export function buildMissionIndex(logs: readonly MissionLog[]): MissionIndex {
  const agentIdToTasks = new Map<string, Set<string>>();
  const windowAcc = new Map<string, Map<string, { start: string; end: string }>>();
  const allKnownSessions = new Set<string>();
  for (const log of logs) {
    for (const s of log.allSessionsSeen) allKnownSessions.add(s);
    for (const ev of log.events) {
      if ((ev.type === "AGENT_STARTED" || ev.type === "AGENT_COMPLETED") && ev.agentId) {
        const set = agentIdToTasks.get(ev.agentId) ?? new Set<string>();
        set.add(log.taskId);
        agentIdToTasks.set(ev.agentId, set);
      }
      if (ev.session) {
        const bySession = windowAcc.get(ev.session) ?? new Map<string, { start: string; end: string }>();
        const w = bySession.get(log.taskId);
        if (!w) bySession.set(log.taskId, { start: ev.ts, end: ev.ts });
        else {
          if (ev.ts < w.start) w.start = ev.ts;
          if (ev.ts > w.end) w.end = ev.ts;
        }
        windowAcc.set(ev.session, bySession);
      }
    }
  }
  const sessionWindows = new Map<string, SessionWindow[]>();
  for (const [session, bySession] of windowAcc) {
    sessionWindows.set(
      session,
      Array.from(bySession, ([taskId, w]) => ({ taskId, ...w })),
    );
  }
  return { agentIdToTasks, sessionWindows, allKnownSessions };
}

export interface Attribution {
  reason: AttributionReason;
  taskId: string | null;
}

export function attributeSubagent(agentId: string, idx: MissionIndex): Attribution {
  const tasks = idx.agentIdToTasks.get(agentId);
  if (!tasks || tasks.size === 0) return { reason: "subagent-not-in-brain-state", taskId: null };
  if (tasks.size > 1) return { reason: "ambiguous-agent-id", taskId: null };
  return { reason: "agent-link", taskId: [...tasks][0] ?? null };
}

export function attributeMainCall(session: string, ts: string, idx: MissionIndex): Attribution {
  const windows = idx.sessionWindows.get(session);
  if (!windows || windows.length === 0) {
    return { reason: idx.allKnownSessions.has(session) ? "mission-log-unusable" : "session-not-in-brain-state", taskId: null };
  }
  const matches = windows.filter((w) => ts >= w.start && ts <= w.end);
  if (matches.length === 0) return { reason: "outside-mission-window", taskId: null };
  if (matches.length > 1) return { reason: "overlapping-missions", taskId: null };
  return { reason: "mission-window", taskId: matches[0]?.taskId ?? null };
}
