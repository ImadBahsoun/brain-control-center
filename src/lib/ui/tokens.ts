// View model for the /tokens page: formatting, sorting and fixed wording. Pure — every number comes
// from a TokenIntelligenceResponse the caller already has. Never claims exact agreement with the pinned
// baseline unless its own status says "match" (R2).
import type { AgentTypeLabel, AttributionReason, TokenBucket, TokenDailyRow, TokenIntelligenceResponse, TokenReconciliationLive } from "@/lib/api-types";

export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 });
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US");
}

export function formatCompactTokens(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

const AGENT_LABELS: Record<AgentTypeLabel, string> = {
  planner: "Planner",
  developer: "Developer",
  qa: "QA",
  reviewer: "Reviewer",
  "security-reviewer": "Security Reviewer",
  "general-purpose": "General purpose",
  Explore: "Explore",
  Plan: "Plan",
  brain: "Brain (main thread)",
  "main-no-mission": "Main session (no mission)",
  "other-subagent": "Other subagent",
};

export function agentLabel(a: AgentTypeLabel): string {
  return AGENT_LABELS[a] ?? a;
}

const REASON_LABELS: Record<AttributionReason, string> = {
  "agent-link": "Agent linked to a mission",
  "mission-window": "Inside a mission's session window",
  "overlapping-missions": "Inside more than one mission's window",
  "outside-mission-window": "Outside every mission window for the session",
  "session-not-in-brain-state": "Session not recorded in Brain state",
  "subagent-not-in-brain-state": "Subagent not recorded in Brain state",
  "ambiguous-agent-id": "Agent id reused across missions",
  "mission-log-unusable": "The mission's own log could not be read",
};

export function reasonLabel(reason: AttributionReason): string {
  return REASON_LABELS[reason] ?? reason;
}

/** The permanent cost-basis banner text; always shown, regardless of data state. */
export function costBasisBannerText(): string {
  return "Estimate at API list prices, not your bill or subscription charge.";
}

/** Wording for the live-reconciliation card (R9): never implies exact agreement unless status is "match". */
export function liveStatusText(baseline: TokenReconciliationLive): string {
  switch (baseline.status) {
    case "match":
      return "Matches the pinned CodeBurn numbers exactly.";
    case "mismatch":
      return "Differs from the pinned CodeBurn numbers — see the per-field diff below.";
    case "unavailable":
      return "Not checked against a live baseline (the matching session is not available in this scan).";
  }
}

export function windowLabel(kind: "7d" | "30d"): string {
  return kind === "7d" ? "Last 7 days" : "Last 30 days";
}

/** R13: the coverage chip names the specific reasons a scan is partial, not just the word "partial". */
export function coverageChipText(coverage: TokenIntelligenceResponse["coverage"]): string {
  if (coverage.projectsDir !== "ok") return `projects ${coverage.projectsDir}`;
  if (coverage.complete) return "complete";
  const reasons: string[] = [];
  if (coverage.fileCapReached) reasons.push("file cap reached");
  if (coverage.oversizeLines > 0) reasons.push(`${coverage.oversizeLines} oversize lines`);
  if (coverage.recordsOverflowed > 0) reasons.push(`${coverage.recordsOverflowed} records overflowed`);
  if (coverage.filesUnreadable > 0) reasons.push(`${coverage.filesUnreadable} files unreadable`);
  return reasons.length > 0 ? `partial: ${reasons.join(", ")}` : "partial";
}

export function sortByCalls<T extends TokenBucket>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.calls - a.calls);
}

export function sortByCost<T extends TokenBucket>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.costUsd - a.costUsd);
}

export function totalCacheWrite(b: TokenBucket): number {
  return b.cacheWrite5m + b.cacheWrite1h + b.cacheWriteUnsplit;
}

export interface DailyBarRow extends TokenDailyRow {
  /** The bar's width as a percent of the window's most expensive day; at least 2 so a near-zero day still draws a sliver. */
  pct: number;
}

/** The daily cost chart's rows, sorted oldest first, each with its bar width already computed. */
export function dailyBarRows(daily: readonly TokenDailyRow[]): DailyBarRow[] {
  const rows = [...daily].sort((a, b) => a.date.localeCompare(b.date));
  const max = Math.max(1, ...rows.map((d) => d.costUsd));
  return rows.map((d) => ({ ...d, pct: Math.max(2, (d.costUsd / max) * 100) }));
}
