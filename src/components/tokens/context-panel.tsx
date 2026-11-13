"use client";
import type { TokenIntelligenceResponse } from "@/lib/api-types";
import { agentLabel, formatTokens, formatUsd } from "@/lib/ui/tokens";
import { Empty, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export function ContextPanel({ context }: { context: TokenIntelligenceResponse["context"] }) {
  return (
    <section className="hud">
      <div className="border-b border-border px-3 py-1.5">
        <h2 className="hud-title">Context and rebuilds</h2>
      </div>
      <div className="px-3 py-2">
        <p className="label text-dim">
          {formatTokens(context.rebuilds.count)} rebuilds · {formatTokens(context.rebuilds.tokens)} tokens · {formatUsd(context.rebuilds.costUsd)} ·{" "}
          {context.rebuilds.shareOfCacheWriteCost === null ? "no cache-write cost to compare against" : `${Math.round(context.rebuilds.shareOfCacheWriteCost * 100)}% of cache-write cost`}
        </p>
        <p className="label text-faint">
          after a TTL gap: {formatTokens(context.rebuilds.byCause.afterTtlGap)} · other: {formatTokens(context.rebuilds.byCause.other)}
        </p>
      </div>
      {context.byAgent.length === 0 ? (
        <Empty>no runs in this window</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Agent</TableHead>
              <TableHead>Runs</TableHead>
              <TableHead>Start (median)</TableHead>
              <TableHead>Start (max)</TableHead>
              <TableHead>Peak (median)</TableHead>
              <TableHead>Peak (max)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {context.byAgent.map((a) => (
              <TableRow key={a.agent}>
                <TableCell>{agentLabel(a.agent)}</TableCell>
                <TableCell className="num">{formatTokens(a.runs)}</TableCell>
                <TableCell className="num">{formatTokens(Math.round(a.startMedian))}</TableCell>
                <TableCell className="num">{formatTokens(a.startMax)}</TableCell>
                <TableCell className="num">{formatTokens(Math.round(a.peakMedian))}</TableCell>
                <TableCell className="num">{formatTokens(a.peakMax)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
