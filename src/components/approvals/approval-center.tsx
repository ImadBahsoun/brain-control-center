"use client";
import Link from "next/link";
import type { ApprovalsResponse } from "@/lib/api-types";
import { dateTime } from "@/lib/format";
import { APPROVAL_CHANNEL_NOTE, approvalRows, LINKING_UNAVAILABLE_NOTE, STATUS_ORDER, type ApprovalRow } from "@/lib/ui/approvals";
import { cn } from "@/lib/utils";
import { Field, Fields } from "@/components/panels/side-panel";
import { Empty, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

function Mission({ row }: { row: ApprovalRow }) {
  return row.missionId ? (
    <Link href={`/tasks/${row.missionId}`} className="font-mono">
      {row.missionLabel}
    </Link>
  ) : (
    <span className="text-faint">{row.missionLabel}</span>
  );
}

function Status({ row }: { row: ApprovalRow }) {
  return <span className={cn("chip", row.statusChip)}>{row.status}</span>;
}

/** The brain-gate requests as a read-only table: no control on this page acts on a request. */
export function ApprovalCenter({ data, error }: { data: ApprovalsResponse | null; error: string | null }) {
  const rows = data ? approvalRows(data.items) : [];
  return (
    <section className="hud">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
        <h1 className="hud-title">Approvals</h1>
        {data && (
          <span className="label num text-faint">
            {STATUS_ORDER.map((s) => `${data.counts[s]} ${s}`).join(" · ")} · gate {data.gate.status}
          </span>
        )}
      </div>
      <p className="border-b border-border px-3 py-2 text-dim">{APPROVAL_CHANNEL_NOTE}</p>
      {data?.linking === "unavailable" && data.items.length > 0 && <p className="border-b border-border px-3 py-2 tone-warn">{LINKING_UNAVAILABLE_NOTE}</p>}
      {!data ? (
        <Empty>{error ? `error: ${error}` : "loading…"}</Empty>
      ) : rows.length === 0 ? (
        <Empty>{data.gate.status === "ok" ? "no brain-gate requests" : `brain-gate state ${data.gate.status}`}</Empty>
      ) : (
        <>
          <div className="max-md:hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Action</TableHead>
                  <TableHead>Repository</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Mission</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.key}>
                    <TableCell className="font-mono">{r.actions}</TableCell>
                    <TableCell className={cn(r.repoUnknown && "text-faint")}>{r.repository}</TableCell>
                    <TableCell className="num whitespace-nowrap">{dateTime(r.expires)}</TableCell>
                    <TableCell>
                      <Status row={r} />
                    </TableCell>
                    <TableCell>
                      <Mission row={r} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <ul className="md:hidden">
            {rows.map((r) => (
              <li key={r.key} className="border-b border-border px-3 py-2 last:border-0">
                <div className="mb-1 flex items-start justify-between gap-2 text-[12px] text-foreground">
                  <span className="min-w-0 font-mono">{r.actions}</span>
                  <Status row={r} />
                </div>
                <Fields>
                  <Field label="Repository" value={r.repository} />
                  <Field label="Expires" value={dateTime(r.expires)} />
                  <Field label="Mission">
                    <Mission row={r} />
                  </Field>
                </Fields>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
