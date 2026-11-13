"use client";
import Link from "next/link";
import type { AgentRun } from "@/lib/api-types";
import { durationMs, timeHMS } from "@/lib/format";
import { EFFORT_LABEL } from "@/lib/ui/command-map";
import { isRole } from "@/lib/ui/roles";
import { cn } from "@/lib/utils";
import { StatusBadge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Opener } from "@/components/map/map-node";

export function runStatusText(r: AgentRun): string {
  if (r.status === "pending") return r.staleOverThreshold ? "pending (reserved, no report yet; over stale threshold)" : "pending (reserved, no report yet)";
  if (r.status === "not-launched") return "not launched (units refunded)";
  if (r.status === "lost") return "lost (units consumed)";
  return `completed: ${r.verdict ?? ""}`;
}

export function AgentRunsRows({ runs, showTask, onSelectRole }: { runs: AgentRun[]; showTask: boolean; onSelectRole?: (role: string, opener: Opener) => void }) {
  return (
    <>
      {runs.map((r, i) => (
        <TableRow key={`${r.taskId}-${r.role}-${r.startedAt ?? i}-${i}`}>
          <TableCell className="whitespace-nowrap">
            {onSelectRole && isRole(r.role) ? (
              <button type="button" className="text-signal hover:underline" onClick={(e) => onSelectRole(r.role, e.currentTarget)} aria-haspopup="dialog">
                {r.roleLabel}
              </button>
            ) : (
              r.roleLabel
            )}
            {r.rerun && <span className="text-faint"> · rerun</span>}
          </TableCell>
          <TableCell>
            {r.model ?? "—"} <span className="text-faint">(policy model class)</span>
          </TableCell>
          <TableCell className="text-faint">{EFFORT_LABEL}</TableCell>
          {showTask && (
            <TableCell className="font-mono whitespace-nowrap">
              <Link href={`/tasks/${encodeURIComponent(r.taskId)}`} className="text-signal">
                {r.taskId}
              </Link>
            </TableCell>
          )}
          <TableCell>
            {r.kind}, round {r.round ?? 0}
          </TableCell>
          <TableCell>
            <StatusBadge value={r.status} /> <span>{runStatusText(r)}</span>
          </TableCell>
          <TableCell className="num">{r.reservedUnits ?? "—"}</TableCell>
          <TableCell className="whitespace-nowrap">{timeHMS(r.startedAt)}</TableCell>
          <TableCell className="whitespace-nowrap">{r.completedAt ? `${timeHMS(r.completedAt)} (${durationMs(r.durationMs)})` : "—"}</TableCell>
          <TableCell className="font-mono text-[11px] text-faint">{r.agentId ?? "—"}</TableCell>
        </TableRow>
      ))}
    </>
  );
}

export function AgentRunsHead({ showTask }: { showTask: boolean }) {
  return (
    <TableHeader>
      <TableRow>
        <TableHead>Role</TableHead>
        <TableHead>Model</TableHead>
        <TableHead>Effort</TableHead>
        {showTask && <TableHead>Mission</TableHead>}
        <TableHead>Kind</TableHead>
        <TableHead>Status</TableHead>
        <TableHead>Units</TableHead>
        <TableHead>Started</TableHead>
        <TableHead>Completed</TableHead>
        <TableHead>Agent id</TableHead>
      </TableRow>
    </TableHeader>
  );
}

export function AgentRunsTable({ runs, unavailable, onSelectRole, className }: { runs: AgentRun[]; unavailable: boolean; onSelectRole?: (role: string, opener: Opener) => void; className?: string }) {
  return (
    <Card className={cn(className)}>
      <CardHeader>
        <CardTitle>Agent runs</CardTitle>
        <span className="label num text-faint">
          {runs.filter((r) => r.status === "pending").length} pending · {runs.length} total
        </span>
      </CardHeader>
      <CardContent className="p-0">
        {unavailable ? (
          <Empty>unavailable: state.json is not usable for this mission</Empty>
        ) : runs.length === 0 ? (
          <Empty>no agent runs recorded</Empty>
        ) : (
          <Table>
            <AgentRunsHead showTask={false} />
            <TableBody>
              <AgentRunsRows runs={runs} showTask={false} onSelectRole={onSelectRole} />
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
