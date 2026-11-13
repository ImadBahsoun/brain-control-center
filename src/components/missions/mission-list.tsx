"use client";
import Link from "next/link";
import { useState } from "react";
import type { GovernorResponse, Severity, TaskSummary, TasksResponse } from "@/lib/api-types";
import { relativeAge } from "@/lib/format";
import { stateLabel, TIMELINE } from "@/lib/lifecycle";
import { etaText } from "@/lib/ui/hud";
import { buildMissionStrip, summaryPosition } from "@/lib/ui/mission";
import { buildMissionTree, isExpanded, MAX_INDENT, parentRefText, subMissionHint, visibleRows } from "@/lib/ui/mission-tree";
import { isUnknownRepoLabel, matchesRepoFilter, REPO_FILTER_ALL, repoFilterOptions, repoLabel, repoLabels, resolveRepoFilter } from "@/lib/ui/repo";
import { cn } from "@/lib/utils";
import { statusChip } from "@/components/map/mission-bar";
import { IntegrityBadges } from "@/components/task/integrity";
import { Empty, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const FILTERS = ["All", "Active", "Waiting", "Blocked", "Complete", "Cancelled"] as const;
type Filter = (typeof FILTERS)[number];
const SEVS: Severity[] = ["BLOCKER", "MAJOR", "MINOR", "NIT"];

function matches(t: TaskSummary, f: Filter): boolean {
  switch (f) {
    case "All":
      return true;
    case "Active":
      return t.status === "ACTIVE";
    case "Waiting":
      return t.status === "WAITING";
    case "Blocked":
      return t.status === "BLOCKED";
    case "Complete":
      return t.status === "COMPLETE";
    case "Cancelled":
      return t.status === "CANCELLED";
  }
}

/** A 17-tick rail that marks only the current recorded position; it infers nothing about earlier steps. */
function PositionRail({ state }: { state: string | null }) {
  const pos = summaryPosition(state);
  return (
    <span className="flex gap-[2px]" aria-label={pos === null ? "no timeline position" : `position ${pos + 1} of 17: ${TIMELINE[pos]}`} title={pos === null ? "off the timeline" : TIMELINE[pos]}>
      {TIMELINE.map((s, i) => (
        <span key={s} className={cn("inline-block h-2.5 w-[3px]", i === pos ? "bg-signal" : "bg-muted")} />
      ))}
    </span>
  );
}

export function MissionList({ tasks, governor, error, interval }: { tasks: TasksResponse | null; governor: GovernorResponse | null; error: string | null; interval: number }) {
  const [filter, setFilter] = useState<Filter>("All");
  const [repoFilterChoice, setRepoFilterChoice] = useState<string>(REPO_FILTER_ALL);
  const allTasks = tasks?.tasks ?? [];
  const repoByPath = repoLabels(allTasks.map((t) => t.repository));
  const repoOf = (t: TaskSummary) => repoLabel(t.repository, repoByPath);
  const repoOptions = repoFilterOptions(allTasks.map((t) => t.repository), repoByPath);
  // resets to "All" on its own once the chosen repository is no longer present (e.g. its only mission left the list)
  const repoFilter = resolveRepoFilter(repoFilterChoice, repoOptions);
  const list = allTasks.filter((t) => matches(t, filter) && matchesRepoFilter(t.repository, repoFilter));
  // filters first, then parent/child grouping over what they kept; the viewer's toggles outlive polls
  const [toggles, setToggles] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const rows = visibleRows(buildMissionTree(list, allTasks), toggles);
  const toggle = (id: string, open: boolean) => setToggles((prev) => new Map(prev).set(id, !open));
  const usage = new Map((governor?.tasks ?? []).map((u) => [u.taskId, u]));
  const strip = tasks ? buildMissionStrip(tasks.tasks, tasks.generatedAt) : null;
  return (
    <section className="hud" aria-label="Missions">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="hud-title">Missions · tasks</h2>
        <span className="label num text-faint" title="live = recent Brain activity or a recorded reservation; not proof an agent is running">
          {tasks && strip ? `${list.length} of ${tasks.counts.total} · ${strip.liveCount} live · ${strip.openCount} open · ${tasks.counts.openFindings} open findings` : (error ?? "loading…")} · poll {interval / 1000}s
        </span>
        <div className="ml-auto flex flex-wrap gap-1" role="group" aria-label="Filter missions">
          {FILTERS.map((f) => (
            <button key={f} type="button" className={cn("btn", filter === f && "active")} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f}
            </button>
          ))}
        </div>
        {repoOptions.length > 1 && (
          <div className="flex w-full flex-wrap gap-1" role="group" aria-label="Filter missions by repository">
            {repoOptions.map((o) => (
              <button key={o.key} type="button" className={cn("btn", repoFilter === o.key && "active", isUnknownRepoLabel(o.label) && "text-dim")} aria-pressed={repoFilter === o.key} onClick={() => setRepoFilterChoice(o.key)}>
                {o.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {!tasks ? (
        <Empty>{error ? `error: ${error}` : "loading…"}</Empty>
      ) : list.length === 0 ? (
        <Empty>no missions match</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Mission</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Repository</TableHead>
              <TableHead>Class</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Position</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Round</TableHead>
              <TableHead>Open findings</TableHead>
              <TableHead>Pending runs</TableHead>
              <TableHead>Governor</TableHead>
              <TableHead>ETA</TableHead>
              <TableHead>Last event</TableHead>
              <TableHead>Integrity</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const t = row.task;
              const u = usage.get(t.id);
              // active rows: the ETA label; COMPLETE / CANCELLED rows: the recorded total
              const shownEta = t.eta && (t.active || t.status === "COMPLETE" || t.status === "CANCELLED") ? t.eta : null;
              const open = isExpanded(row, toggles);
              const deep = row.depth > MAX_INDENT && row.parentId !== null;
              const step = row.depth > 0 ? t.parentStepId : null;
              const hasNotes = row.childCount > 0 || deep || step !== null || row.parentRef !== null || row.selfLink || row.cycle;
              return (
                <TableRow key={t.id}>
                  <TableCell className="font-mono whitespace-nowrap">
                    <span className="flex items-center gap-1" style={{ paddingLeft: `${row.indent * 16}px` }}>
                      {row.childCount > 0 ? (
                        <button type="button" className="btn px-1" aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} sub-missions of ${t.id}`} onClick={() => toggle(t.id, open)}>
                          {open ? "▾" : "▸"}
                        </button>
                      ) : row.depth > 0 ? (
                        <span className="text-faint" title="child mission">
                          ↳
                        </span>
                      ) : null}
                      <Link href={`/tasks/${encodeURIComponent(t.id)}`} className="text-signal">
                        {t.id}
                      </Link>
                    </span>
                    {hasNotes && (
                      <span className="flex flex-col text-faint" style={{ paddingLeft: `${row.indent * 16}px` }}>
                        {row.childCount > 0 && <span>{subMissionHint(row)}</span>}
                        {deep && (
                          <span>
                            depth {row.depth} · child of {row.parentId}
                          </span>
                        )}
                        {step !== null && <span>step {step}</span>}
                        {row.parentRef && <span>{parentRefText(row.parentRef)}</span>}
                        {row.selfLink && <span className="tone-warn">names itself as parent (ignored)</span>}
                        {row.cycle && <span className="tone-warn">parent cycle{row.parentId === null ? " (shown as top level)" : ""}</span>}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="max-w-[420px] overflow-hidden text-ellipsis whitespace-nowrap" title={t.title ?? ""}>
                    {t.title ?? <span className="text-faint">(no summary)</span>}
                  </TableCell>
                  <TableCell className="max-w-[200px] overflow-hidden text-ellipsis whitespace-nowrap" title={t.repository ?? undefined}>
                    <span className={cn(isUnknownRepoLabel(repoOf(t)) && "text-faint")}>{repoOf(t)}</span>
                  </TableCell>
                  <TableCell>{t.classification ?? "—"}</TableCell>
                  <TableCell className="whitespace-nowrap">{t.state ? stateLabel(t.state) : "—"}</TableCell>
                  <TableCell>
                    <PositionRail state={t.state} />
                  </TableCell>
                  <TableCell>
                    <span className="flex gap-1">
                      <span className={cn("chip", statusChip(t.status))}>{t.status}</span>
                      {t.ready && <span className="chip chip-ok">READY</span>}
                      {t.waitingApproval && <span className="chip chip-warn">approval</span>}
                    </span>
                  </TableCell>
                  <TableCell className="num">
                    {t.round}/{t.maxRounds}
                  </TableCell>
                  <TableCell className="num whitespace-nowrap">
                    {t.findings.open}
                    {t.findings.open > 0 && <span className="text-faint"> · {SEVS.filter((s) => t.findings.openBySeverity[s] > 0).map((s) => `${s.slice(0, 3)} ${t.findings.openBySeverity[s]}`).join(" ")}</span>}
                  </TableCell>
                  <TableCell className="num">{t.pendingRuns}</TableCell>
                  <TableCell className="num whitespace-nowrap">{u ? (u.classBudget ? `${u.percentOfClassBudget}% · ${u.committed}/${u.classBudget}` : `${u.committed} · no budget`) : "—"}</TableCell>
                  <TableCell className="num whitespace-nowrap text-dim" title={shownEta ? `${shownEta.reason} · ${shownEta.note}` : undefined}>
                    {shownEta ? etaText(shownEta, t.status) : "—"}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-dim">{relativeAge(t.lastEventAt)}</TableCell>
                  <TableCell>
                    <IntegrityBadges integrity={t.integrity} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      {tasks?.scan.scanLimitReached && <p className="px-3 py-2 tone-warn">Scan cap reached: older missions are not shown.</p>}
    </section>
  );
}
