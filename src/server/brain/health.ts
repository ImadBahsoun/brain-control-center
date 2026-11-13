import "server-only";
import type { HealthResponse, HealthStatus } from "@/lib/api-types";
import { gateSummary } from "./gate";
import { loadPolicy } from "./governor";
import type { BrainRoots } from "./roots";
import { agentRunsOf, scanTasks, TERMINAL_STATUSES } from "./task-store";

export async function health(roots: BrainRoots, nowMs: number): Promise<HealthResponse> {
  const policy = await loadPolicy(roots);
  const [scan, gate] = await Promise.all([scanTasks(roots, nowMs), gateSummary(roots, nowMs)]);
  const reasons: string[] = [];

  const summaries = scan.tasks.map((t) => t.summary);
  const tasks = {
    status: scan.listing.status,
    taskCount: summaries.length,
    unsafeEntries: scan.listing.unsafeEntries + scan.unsafeTasks,
    scanLimitReached: scan.listing.scanLimitReached,
    corrupt: summaries.filter((s) => s.integrity.log === "corrupt").length,
    incomplete: summaries.filter((s) => s.integrity.log === "incomplete").length,
    tornTail: summaries.filter((s) => s.integrity.log === "torn_tail").length,
    logUnreadable: summaries.filter((s) => s.integrity.log === "missing" || s.integrity.log === "unsafe" || s.integrity.log === "too_large").length,
    cacheStale: summaries.filter((s) => s.integrity.cache === "stale").length,
    cacheAhead: summaries.filter((s) => s.integrity.cache === "ahead").length,
    cacheDiverged: summaries.filter((s) => s.integrity.cache === "diverged").length,
  };
  const unsafeFiles = summaries.filter((s) => s.integrity.cache === "unsafe").length;

  let status: HealthStatus = "ok";
  if (scan.store.status !== "ok") {
    status = "unavailable";
    reasons.push(scan.store.status === "missing" ? "tasks root missing" : "tasks root unsafe");
  } else {
    if (tasks.corrupt > 0) reasons.push(`${tasks.corrupt} corrupt log(s)`);
    if (tasks.incomplete > 0) reasons.push(`${tasks.incomplete} incomplete log(s)`);
    if (tasks.logUnreadable > 0) reasons.push(`${tasks.logUnreadable} unreadable log(s)`);
    if (tasks.unsafeEntries > 0) reasons.push(`${tasks.unsafeEntries} unsafe entr(y/ies) under tasks`);
    if (unsafeFiles > 0) reasons.push(`${unsafeFiles} task(s) with an unsafe state.json`);
    if (tasks.cacheAhead > 0) reasons.push(`${tasks.cacheAhead} cache(s) ahead of the log`);
    if (tasks.cacheDiverged > 0) reasons.push(`${tasks.cacheDiverged} cache(s) from a different history`);
    if (policy.status !== "ok") reasons.push(`governor policy ${policy.status}`);
    if (gate.status !== "ok") reasons.push(`brain-gate state ${gate.status}`);
    if (reasons.length > 0) status = "degraded";
  }

  let lastEventAt: string | null = null;
  for (const s of summaries) {
    if (s.lastEventAt && (lastEventAt === null || s.lastEventAt > lastEventAt)) lastEventAt = s.lastEventAt;
  }
  const lastMs = lastEventAt ? Date.parse(lastEventAt) : NaN;

  let pendingRunsOverStaleThreshold = 0;
  for (const t of scan.tasks) {
    if (TERMINAL_STATUSES.has(t.summary.status)) continue;
    pendingRunsOverStaleThreshold += agentRunsOf(t, policy, nowMs).filter((r) => r.status === "pending" && r.staleOverThreshold).length;
  }

  return {
    status,
    readOnly: true,
    generatedAt: new Date(nowMs).toISOString(),
    sources: { tasks, governor: { status: policy.status }, gate },
    lastEventAt,
    lastEventAgeSec: Number.isNaN(lastMs) ? null : Math.max(0, Math.round((nowMs - lastMs) / 1000)),
    pendingRunsOverStaleThreshold,
    reasons,
  };
}
