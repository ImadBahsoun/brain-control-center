"use client";
import type { TokenDailyRow } from "@/lib/api-types";
import { dailyBarRows, formatCompactTokens, formatUsd } from "@/lib/ui/tokens";

/** Static divs, no animation; every bar's value is also shown as text. */
export function DailyBars({ daily }: { daily: TokenDailyRow[] }) {
  const rows = dailyBarRows(daily);
  return (
    <div className="hud" aria-label="Daily cost">
      <div className="border-b border-border px-3 py-1.5">
        <h2 className="hud-title">Daily cost</h2>
      </div>
      {rows.length === 0 ? (
        <p className="px-3 py-2 text-dim">no data in this window</p>
      ) : (
        <>
          <div className="flex items-end gap-1 overflow-x-auto px-3 py-2 max-md:hidden">
            {rows.map((d) => (
              <div key={d.date} className="flex min-w-[36px] flex-col items-center gap-1">
                <div className="h-16 w-full bg-muted" style={{ display: "flex", alignItems: "flex-end" }}>
                  <div className="w-full bg-signal" style={{ height: `${d.pct}%` }} />
                </div>
                <span className="label text-dim">{d.date.slice(5)}</span>
                <span className="label num">{formatUsd(d.costUsd)}</span>
                <span className="label text-faint">{formatCompactTokens(d.calls)} calls</span>
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-2 px-3 py-2 md:hidden">
            {rows.map((d) => (
              <div key={d.date} className="grid grid-cols-[4.5ch_minmax(0,1fr)_auto_auto] items-center gap-2">
                <span className="label whitespace-nowrap text-dim">{d.date.slice(5)}</span>
                <div className="h-3 w-full bg-muted">
                  <div className="h-full bg-signal" style={{ width: `${d.pct}%` }} />
                </div>
                <span className="label num whitespace-nowrap">{formatUsd(d.costUsd)}</span>
                <span className="label num whitespace-nowrap text-faint">{formatCompactTokens(d.calls)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
