"use client";
import type { TaskDetail } from "@/lib/api-types";
import { dateTime } from "@/lib/format";
import { StatusBadge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export function ValidationPanel({ task }: { task: TaskDetail }) {
  const v = task.validation;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Validation · synthesis</CardTitle>
        <span className="label num text-faint">
          {v.history.length} completed · {task.rounds.length} fix round(s)
        </span>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2">
        <div>
          <h3 className="label text-dim">Latest</h3>
          {v.latest ? (
            <dl className="field-grid mt-1">
              <dt>decision</dt>
              <dd>
                <StatusBadge value={v.latest.decision} />
              </dd>
              <dt>trees</dt>
              <dd className="font-mono text-[11px]">
                {v.latest.from ?? "—"} → {v.latest.to ?? "—"}
              </dd>
              <dt>round</dt>
              <dd>{v.latest.round ?? "—"}</dd>
              <dt>at</dt>
              <dd>{dateTime(v.latest.ts)}</dd>
              <dt>agents</dt>
              <dd>
                {Object.entries(v.latest.agents)
                  .map(([k, verdict]) => `${k}: ${verdict}`)
                  .join(" · ") || "—"}
              </dd>
            </dl>
          ) : (
            <p className="text-faint">none completed</p>
          )}
          {v.inProgress && (
            <p className="mt-2 tone-warn">
              in progress: {v.inProgress.agents.join(", ")} on <span className="font-mono">{v.inProgress.to ?? "—"}</span> since {dateTime(v.inProgress.ts)}
            </p>
          )}
          <h3 className="mt-3 label text-dim">History</h3>
          {v.history.length === 0 ? (
            <p className="text-faint">—</p>
          ) : (
            <ol className="mt-1 space-y-0.5">
              {v.history.map((h) => (
                <li key={h.seq} className="flex gap-2">
                  <span className="font-mono text-[11px] text-faint">#{h.seq}</span>
                  <StatusBadge value={h.decision} />
                  <span className="font-mono text-[11px] text-faint">
                    {h.from ?? "—"} → {h.to ?? "—"}
                  </span>
                </li>
              ))}
            </ol>
          )}
          <h3 className="mt-3 label text-dim">Fix rounds</h3>
          {task.rounds.length === 0 ? (
            <p className="text-faint">—</p>
          ) : (
            <ul className="mt-1 space-y-0.5">
              {task.rounds.map((r) => (
                <li key={r.round}>
                  round {r.round} ({r.kind}) · {r.findings.join(", ") || "no findings listed"} · {r.completed ? "completed" : "open"}
                  {Object.keys(r.findingsAddressed).length > 0 && (
                    <span className="text-dim">
                      {" "}
                      · {Object.entries(r.findingsAddressed)
                        .map(([k, s]) => `${k} ${s}`)
                        .join(", ")}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="label text-dim">Tests run (from agent reports)</h3>
          {task.testsRun.length === 0 ? (
            <p className="text-faint">none recorded</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead>Round</TableHead>
                  <TableHead>Command</TableHead>
                  <TableHead>Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {task.testsRun.map((t, i) => (
                  <TableRow key={i}>
                    <TableCell>{t.agent}</TableCell>
                    <TableCell>{t.round ?? "—"}</TableCell>
                    <TableCell className="font-mono text-[11px] break-all">{t.cmd}</TableCell>
                    <TableCell className="text-[11px]">{t.result}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
