"use client";
import type { TokenBucket } from "@/lib/api-types";
import { formatTokens, formatUsd } from "@/lib/ui/tokens";

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="hud px-3 py-2">
      <p className="label text-dim">{label}</p>
      <p className="num text-[16px]">{value}</p>
    </div>
  );
}

/** R13: the five token categories plus unsplit writes and web-search requests are shown separately, not folded into one "cache write" tile. */
export function TotalsTiles({ totals }: { totals: TokenBucket }) {
  return (
    <div className="grid grid-cols-2 gap-2 min-[700px]:grid-cols-4">
      <Tile label="Cost (list-price estimate)" value={formatUsd(totals.costUsd)} />
      <Tile label="Calls" value={formatTokens(totals.calls)} />
      <Tile label="Input tokens" value={formatTokens(totals.input)} />
      <Tile label="Output tokens" value={formatTokens(totals.output)} />
      <Tile label="Cache read tokens" value={formatTokens(totals.cacheRead)} />
      <Tile label="Cache write, 5m" value={formatTokens(totals.cacheWrite5m)} />
      <Tile label="Cache write, 1h" value={formatTokens(totals.cacheWrite1h)} />
      <Tile label="Cache write, unsplit" value={formatTokens(totals.cacheWriteUnsplit)} />
      <Tile label="Web search requests" value={formatTokens(totals.webSearchRequests)} />
      <Tile label="Unpriced calls" value={formatTokens(totals.unpricedCalls)} />
      <Tile label="Synthetic calls" value={formatTokens(totals.syntheticCalls)} />
    </div>
  );
}
