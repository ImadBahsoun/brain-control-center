"use client";
import type { Meter, ResourceModel } from "@/lib/ui/resources";
import { cn } from "@/lib/utils";

function BudgetMeter({ m }: { m: Meter }) {
  const max = m.max > 0 ? m.max : Math.max(1, m.value + m.reserved);
  const used = Math.min(100, (m.value * 100) / max);
  const reserved = Math.min(100 - used, (m.reserved * 100) / max);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="label text-dim">{m.label}</span>
        <span className="label num text-foreground">{m.max > 0 ? `${m.value + m.reserved} / ${m.max}` : `${m.value + m.reserved}`}</span>
      </div>
      <div role="meter" aria-label={`${m.label} policy units`} aria-valuemin={0} aria-valuemax={max} aria-valuenow={m.value + m.reserved} aria-valuetext={m.text} className="meter-track mt-1" title={m.text}>
        <div className={cn("meter-fill", m.tone === "warn" && "bg-warn")} style={{ width: `${used}%`, background: m.tone === "warn" ? "var(--warn)" : undefined }} />
        <div className="meter-fill reserved" style={{ left: `${used}%`, width: `${reserved}%`, background: m.tone === "warn" ? "var(--warn)" : undefined }} />
        {m.tickPercent !== null && <div className="meter-tick" style={{ left: `${m.tickPercent}%` }} title={`soft limit ${m.tickPercent}%`} />}
      </div>
      <div className="mt-0.5 label num text-faint">
        {m.value} used · {m.reserved} reserved
      </div>
    </div>
  );
}

export function Pips({ m }: { m: Meter }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="label text-dim">{m.label}</span>
      <span className="flex items-center gap-2">
        <span className="flex gap-[3px]" role="meter" aria-label={m.label} aria-valuemin={0} aria-valuemax={m.max} aria-valuenow={m.value} aria-valuetext={`${m.value} of ${m.max}`} title={m.source}>
          {Array.from({ length: m.max }, (_, i) => (
            <span key={i} className={cn("pip", i < m.value && "on", i < m.value && m.tone === "warn" && "warn")} />
          ))}
        </span>
        <span className="label num w-[6ch] whitespace-nowrap text-right text-foreground">{m.text}</span>
      </span>
    </div>
  );
}

/** `replay`: the governor's state at a replayed step is not recorded, so no meter is drawn. */
export function ResourceHud({ resources, replay = false, className }: { resources: ResourceModel; replay?: boolean; className?: string }) {
  const budget = resources.meters.find((m) => m.id === "budget");
  const pips = resources.meters.filter((m) => m.id !== "budget");
  return (
    <section className={cn("hud flex flex-col gap-3 px-3 py-2.5", className)} aria-label="Governor resources">
      <div className="flex items-center justify-between gap-2">
        <h2 className="hud-title whitespace-nowrap">Governor</h2>
        <span className={cn("chip", resources.policyStatus === "ok" ? "chip-ok" : resources.policyStatus === "loading" ? "chip-dim" : "chip-warn")}>{resources.policyStatus === "ok" ? "policy ok" : `policy ${resources.policyStatus}`}</span>
      </div>
      {replay ? (
        <p className="text-[12px] text-dim">
          Replay · governor usage, budget and global slots are not recorded per step.
          <span className="block label text-faint">the meters return when the replay ends</span>
        </p>
      ) : resources.policyStatus === "loading" ? (
        <p className="label text-faint">loading…</p>
      ) : resources.policyStatus !== "ok" ? (
        <p className="text-[12px] text-dim">
          No meters without a valid policy.
          {resources.policyReason ? <span className="block text-faint">{resources.policyReason}</span> : null}
        </p>
      ) : (
        <>
          <div className="grid gap-3 min-[640px]:max-[1024px]:grid-cols-2">
            {budget ? <BudgetMeter m={budget} /> : <p className="label text-faint">Mission budget · no mission in focus</p>}
            <div className="flex flex-col gap-1.5 border-t border-border pt-2 min-[640px]:max-[1024px]:border-t-0 min-[640px]:max-[1024px]:pt-0">
              {pips.map((m) => (
                <Pips key={m.id} m={m} />
              ))}
            </div>
          </div>
          <div className="label num text-faint">
            stale excluded {resources.staleExcluded} · denials {resources.denials} · soft-limit {resources.softLimitAcceptances}
            {resources.staleAfterMinutes !== null ? ` · stale after ${resources.staleAfterMinutes} min` : ""}
          </div>
        </>
      )}
      <p className="label text-faint">policy units · not tokens or cost</p>
    </section>
  );
}
