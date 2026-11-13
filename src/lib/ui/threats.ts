// Findings as threat markers: classification, map selection and the task scope of the Findings view. Pure.
import type { Finding, TaskSummary } from "@/lib/api-types";
import { isTerminalStatus } from "@/lib/lifecycle";
import { isRole, type Role } from "./roles";

/** Mirror of the server's open set (src/server/brain/findings.ts); checked by tests/unit/ui-roles.test.ts. */
export const OPEN_STATUSES: ReadonlySet<string> = new Set<string>(["OPEN", "ACKNOWLEDGED", "FIXED", "REVALIDATED"]);

export type ThreatClass = "active" | "neutralizing" | "resolved" | "dismissed" | "unknown";

const SEVERITY_RANK: Record<string, number> = { BLOCKER: 0, MAJOR: 1, MINOR: 2, NIT: 3 };
const CLASS_RANK: Record<ThreatClass, number> = { active: 0, neutralizing: 1, unknown: 2, resolved: 3, dismissed: 4 };

export function threatClass(f: Pick<Finding, "status">): ThreatClass {
  switch (f.status) {
    case "OPEN":
    case "ACKNOWLEDGED":
      return "active";
    case "FIXED":
    case "REVALIDATED":
      return "neutralizing";
    case "CLOSED":
      return "resolved";
    case "DEFERRED":
    case "REJECTED":
      return "dismissed";
    default:
      return "unknown";
  }
}

export const THREAT_CLASS_LABEL: Record<ThreatClass, string> = {
  active: "ACTIVE",
  neutralizing: "NEUTRALIZING",
  resolved: "RESOLVED",
  dismissed: "DISMISSED",
  unknown: "STATUS AS RECORDED",
};

export function severityRank(severity: string): number {
  return SEVERITY_RANK[severity] ?? 4;
}

/** Open before resolved, then BLOCKER > MAJOR > MINOR > NIT, then newest updatedAt, then id. Deterministic. */
export function sortThreats(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      CLASS_RANK[threatClass(a)] - CLASS_RANK[threatClass(b)] ||
      severityRank(a.severity) - severityRank(b.severity) ||
      (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") ||
      a.id.localeCompare(b.id),
  );
}

/** The markers drawn on the map: the top `cap` of the sorted list, plus how many were left out. */
export function selectMapThreats(findings: readonly Finding[], cap = 6): { shown: Finding[]; overflow: number } {
  const sorted = sortThreats(findings);
  return { shown: sorted.slice(0, cap), overflow: Math.max(0, sorted.length - cap) };
}

/** The threat rail: every open finding first, then the 5 most recently resolved, capped at 10. */
export function selectRailThreats(findings: readonly Finding[], cap = 10): Finding[] {
  const sorted = sortThreats(findings);
  const open = sorted.filter((f) => OPEN_STATUSES.has(f.status));
  const settled = sorted
    .filter((f) => !OPEN_STATUSES.has(f.status))
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.id.localeCompare(b.id))
    .slice(0, 5);
  return [...open, ...settled].slice(0, cap);
}

/** The map node a finding sits next to: its first recognised role source; `brain` and unknown sources → the core. */
export function threatAnchor(sources: readonly string[]): Role | "core" {
  for (const s of sources) if (isRole(s)) return s;
  return "core";
}

/**
 * The Findings view's task scope: every non-terminal task (polled live) plus the newest terminal tasks
 * (fetched once), capped at `cap` in total. Tasks arrive newest first from /api/tasks.
 */
export function selectFindingsScope(tasks: readonly TaskSummary[], cap = 8): { live: string[]; settled: string[] } {
  const live: string[] = [];
  const settled: string[] = [];
  for (const t of tasks) {
    if (isTerminalStatus(t.status)) settled.push(t.id);
    else live.push(t.id);
  }
  const liveOut = live.slice(0, cap);
  return { live: liveOut, settled: settled.slice(0, Math.max(0, cap - liveOut.length)) };
}
