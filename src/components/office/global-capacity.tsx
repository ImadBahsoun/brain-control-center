"use client";
import type { GovernorResponse } from "@/lib/api-types";
import { resourceMeters, type Meter } from "@/lib/ui/resources";
import { cn } from "@/lib/utils";

/**
 * One lane in its own cell: the label on top, the pips and the value under it. Cells take their content's width
 * and wrap as a whole, so a label and a value never run into each other at any width.
 */
function CapacityMeter({ m }: { m: Meter }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="label whitespace-nowrap text-dim">{m.label}</span>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="flex gap-[3px]" role="meter" aria-label={m.label} aria-valuemin={0} aria-valuemax={m.max} aria-valuenow={m.value} aria-valuetext={`${m.value} of ${m.max}`} title={m.source}>
          {Array.from({ length: m.max }, (_, i) => (
            <span key={i} className={cn("pip", i < m.value && "on", i < m.value && m.tone === "warn" && "warn")} />
          ))}
        </span>
        <span className="label num whitespace-nowrap text-foreground">{m.text}</span>
      </span>
    </div>
  );
}

/**
 * The governor's global lanes for the Global Office: active / limit for the total, developers, validators, opus
 * and fable (pending runs, stale ones left out), the stale runs left out and the per-mission limit. Every number
 * is /api/governor's; nothing is reinterpreted.
 */
export function GlobalCapacity({ governor, queuedLaunches, className }: { governor: GovernorResponse | null; queuedLaunches: number; className?: string }) {
  const res = resourceMeters(governor, null);
  const meters = res.meters.filter((m) => m.id !== "budget");
  return (
    <section className={cn("hud flex flex-col gap-1.5 px-3 py-2", className)} aria-label="Governor capacity, all missions">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h2 className="hud-title whitespace-nowrap">Capacity · all missions</h2>
        <span className="label text-faint">per governor · /api/governor</span>
      </div>
      {res.policyStatus === "loading" ? (
        <p className="label text-faint">loading…</p>
      ) : res.policyStatus !== "ok" ? (
        <p className="text-[12px] text-dim">
          No limits without a valid policy.
          {res.policyReason ? <span className="block text-faint">{res.policyReason}</span> : null}
        </p>
      ) : (
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {meters.map((m) => (
            <CapacityMeter key={m.id} m={m} />
          ))}
        </div>
      )}
      <p className="label num text-faint">
        stale excluded {res.staleExcluded}
        {governor?.policy ? ` · max per mission ${governor.policy.maxParallelPerTask}` : ""} · queued launches {queuedLaunches} (no queue position recorded)
      </p>
    </section>
  );
}
