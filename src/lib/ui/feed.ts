// The compact mission feed: the newest activity lines of the focused mission in recorded order, each with a
// kind (which picks its glyph) and, on an agent's completion line, the tests and files that agent reported
// for that round ("reported at completion"). Lines are the API's ActivityItems as recorded; the feed never
// adds a line, and a report whose completion line is not loaded is counted, not placed. Pure.
import type { ActivityItem, ActivityTone, EventsResponse, TaskDetail } from "@/lib/api-types";
import { isRole, type Role } from "./roles";

export type FeedKind = "agent" | "step" | "finding" | "gate" | "snapshot" | "validation" | "fix" | "note";

export interface FeedReport {
  kind: "tests" | "files";
  text: string;
  source: string;
}

export interface FeedLine {
  key: string;
  seq: number;
  ts: string;
  role: Role | null;
  kind: FeedKind;
  tone: ActivityTone;
  text: string;
  detail?: string;
  item: ActivityItem;
  /** Tests and files the agent reported with this completion. */
  reported: FeedReport[];
}

export interface Feed {
  lines: FeedLine[];
  /** Lines available up to the cut (before the last-N window). */
  available: number;
  /** testsRun / filesChanged groups whose completion line is not among the shown lines. */
  reportedOutsideWindow: number;
  /** Groups not placed because the agent completed more than once in that round (a rerun, or lost and relaunched). */
  reportedAmbiguous: number;
  /** The API left older events out. */
  hasMore: boolean;
}

export const FEED_LIMIT = 12;

const KIND: Record<string, FeedKind> = {
  AGENT_STARTED: "agent",
  AGENT_COMPLETED: "agent",
  FINDING_CREATED: "finding",
  FINDING_UPDATED: "finding",
  APPROVAL_REQUESTED: "gate",
  APPROVAL_GRANTED: "gate",
  APPROVAL_REJECTED: "gate",
  PLAN_APPROVED: "gate",
  SNAPSHOT_TAKEN: "snapshot",
  VALIDATION_STARTED: "validation",
  VALIDATION_COMPLETED: "validation",
  FIX_ROUND_STARTED: "fix",
  FIX_ROUND_COMPLETED: "fix",
  NOTE: "note",
  HANDOFF_CREATED: "note",
  LOG_REPAIRED: "note",
  TASK_RESUMED: "note",
};

export function feedKind(type: string): FeedKind {
  return KIND[type] ?? "step";
}

/**
 * The seqs of the AGENT_COMPLETED lines of `agent` in `round`. A testsRun / filesChanged group is tied to one of
 * them only when there is exactly one; with several (a rerun, or a lost run relaunched) the group carries no
 * reference to the line it came from.
 */
export function completionSeqsFor(items: readonly ActivityItem[], agent: string, round: number | null): number[] {
  return items.filter((it) => it.type === "AGENT_COMPLETED" && it.role === agent && it.round === round).map((it) => it.seq);
}

function filesText(files: readonly string[]): string {
  const shown = files.slice(0, 3).join(", ");
  return `${files.length} file(s): ${shown}${files.length > 3 ? ` +${files.length - 3} more` : ""}`;
}

/**
 * The last `limit` lines up to `uptoSeq` (replay), chronological. Reports attach to their completion line only
 * when that line is shown.
 */
export function feedLines(events: EventsResponse | null, detail: TaskDetail | null, opts: { limit?: number; uptoSeq?: number } = {}): Feed {
  const limit = opts.limit ?? FEED_LIMIT;
  const all = events?.events ?? [];
  const visible = opts.uptoSeq === undefined ? all : all.filter((e) => e.seq <= (opts.uptoSeq as number));
  const window = visible.slice(Math.max(0, visible.length - limit));
  const lines: FeedLine[] = window.map((item) => {
    const line: FeedLine = { key: `${events?.taskId ?? ""}:${item.seq}`, seq: item.seq, ts: item.ts, role: item.role && isRole(item.role) ? item.role : null, kind: feedKind(item.type), tone: item.tone, text: item.text, item, reported: [] };
    if (item.detail) line.detail = item.detail;
    return line;
  });
  const bySeq = new Map(lines.map((l) => [l.seq, l]));
  let outside = 0;
  let ambiguous = 0;
  const id = detail?.id ?? events?.taskId ?? ":id";
  // ambiguity comes from the full run record (detail.agents), so a completion older than the loaded window
  // still counts; the loaded lines are used only to find the line to attach to
  const endedRuns = (agent: string, round: number | null) => detail?.agents.filter((r) => r.role === agent && r.round === round && r.completedAt !== null).length ?? 0;
  const place = (agent: string, round: number | null, report: FeedReport) => {
    const seqs = completionSeqsFor(visible, agent, round);
    if (seqs.length > 1 || endedRuns(agent, round) > 1) {
      ambiguous++;
      return;
    }
    const line = seqs[0] === undefined ? undefined : bySeq.get(seqs[0]);
    if (line) line.reported.push(report);
    else outside++;
  };
  if (detail && events && detail.id === events.taskId) {
    for (const t of detail.testsRun) place(t.agent, t.round, { kind: "tests", text: `${t.cmd} → ${t.result}`, source: `/api/tasks/${id} testsRun` });
    for (const g of detail.filesChanged) place(g.agent, g.round, { kind: "files", text: filesText(g.files), source: `/api/tasks/${id} filesChanged` });
  }
  return { lines, available: visible.length, reportedOutsideWindow: outside, reportedAmbiguous: ambiguous, hasMore: events?.hasMore ?? false };
}
