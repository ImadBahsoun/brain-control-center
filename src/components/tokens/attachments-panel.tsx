"use client";
import type { TokenIntelligenceResponse } from "@/lib/api-types";
import { formatTokens } from "@/lib/ui/tokens";
import { Empty, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export function AttachmentsPanel({ attachments }: { attachments: TokenIntelligenceResponse["attachments"] }) {
  const sorted = [...attachments].sort((a, b) => b.bytes - a.bytes);
  return (
    <section className="hud">
      <div className="border-b border-border px-3 py-1.5">
        <h2 className="hud-title">Attachments</h2>
      </div>
      {sorted.length === 0 ? (
        <Empty>no attachments in this window</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Type</TableHead>
              <TableHead>Count</TableHead>
              <TableHead>Bytes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((a) => (
              <TableRow key={a.type}>
                <TableCell>{a.type}</TableCell>
                <TableCell className="num">{formatTokens(a.count)}</TableCell>
                <TableCell className="num">{formatTokens(a.bytes)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
