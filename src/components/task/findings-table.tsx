"use client";
import type { Finding, FindingsResponse } from "@/lib/api-types";
import { dateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { StatusBadge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Opener } from "@/components/map/map-node";

export function FindingsTable({ findings, error, onOpen, selectedId }: { findings: FindingsResponse | null; error: string | null; onOpen?: (finding: Finding, opener: Opener) => void; selectedId?: string | null }) {
  const list = findings?.findings ?? [];
  const s = findings?.summary;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Findings · threats</CardTitle>
        <span className="label num text-faint">{s ? `${s.open} open / ${s.total} total · B ${s.openBySeverity.BLOCKER} · M ${s.openBySeverity.MAJOR} · m ${s.openBySeverity.MINOR} · n ${s.openBySeverity.NIT}` : (error ?? "")}</span>
      </CardHeader>
      <CardContent className="p-0">
        {!findings ? (
          <Empty>{error ? `error: ${error}` : "loading…"}</Empty>
        ) : list.length === 0 ? (
          <Empty>no findings</Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Id</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Affected area</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Rounds</TableHead>
                <TableHead>Resolution</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((f) => (
                <TableRow key={f.id} className={cn(onOpen && "cursor-pointer", selectedId === f.id && "bg-accent/60")} onClick={onOpen ? (e) => onOpen(f, e.currentTarget) : undefined}>
                  <TableCell className="font-mono whitespace-nowrap">
                    {onOpen ? (
                      <button
                        type="button"
                        className="text-signal hover:underline"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpen(f, e.currentTarget);
                        }}
                        aria-haspopup="dialog"
                        aria-expanded={selectedId === f.id}
                      >
                        {f.id}
                      </button>
                    ) : (
                      f.id
                    )}
                    {f.aliases.length > 0 && <span className="block text-[11px] text-faint">{f.aliases.join(", ")}</span>}
                  </TableCell>
                  <TableCell>
                    <StatusBadge value={f.severity} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge value={f.status} />
                  </TableCell>
                  <TableCell className="max-w-[460px]">
                    <div>{f.title}</div>
                    {f.description && <div className="text-[11px] text-dim">{f.description}</div>}
                    {f.recommendation && (
                      <div className="text-[11px] text-dim">
                        <span className="uppercase">rec:</span> {f.recommendation}
                      </div>
                    )}
                    <details className="mt-0.5" onClick={(e) => e.stopPropagation()}>
                      <summary className="cursor-pointer text-[11px] text-faint">History ({f.history.length})</summary>
                      <ol className="mt-0.5 space-y-0.5 text-[11px]">
                        {f.history.map((h, i) => (
                          <li key={i}>
                            <span className="text-faint">{dateTime(h.ts)}</span> {h.status}
                            {h.reason ? <span className="text-dim"> — {h.reason}</span> : null}
                          </li>
                        ))}
                      </ol>
                    </details>
                  </TableCell>
                  <TableCell className="max-w-[260px] font-mono text-[11px] break-all">{f.location ?? "—"}</TableCell>
                  <TableCell className="whitespace-nowrap">{f.sources.join(", ") || "—"}</TableCell>
                  <TableCell className="whitespace-nowrap num text-[11px]">
                    in {f.introducedRound ?? "—"} · fixed {f.fixedRound ?? "—"} · val {f.validatedRound ?? "—"}
                  </TableCell>
                  <TableCell className="text-[11px]">
                    {f.resolution ? (
                      <>
                        <StatusBadge value={f.resolution.status} />
                        {f.resolution.reason && <div className="text-dim">{f.resolution.reason}</div>}
                      </>
                    ) : (
                      <span className="text-faint">unresolved</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
