"use client";
import { useMemo, useState } from "react";
import type { TokenIntelligenceResponse, TokenWindow } from "@/lib/api-types";
import { useCadence } from "@/hooks/use-cadence";
import { usePoll } from "@/hooks/use-poll";
import { coverageChipText, windowLabel } from "@/lib/ui/tokens";
import { cn } from "@/lib/utils";
import { AttachmentsPanel } from "@/components/tokens/attachments-panel";
import { ByAgentTable, ByMissionTable, ByModelTable, UnattributedTable } from "@/components/tokens/breakdown-tables";
import { ContextPanel } from "@/components/tokens/context-panel";
import { CostBanner } from "@/components/tokens/cost-banner";
import { CoveragePanel } from "@/components/tokens/coverage-panel";
import { DailyBars } from "@/components/tokens/daily-bars";
import { HandoffPanel } from "@/components/tokens/handoff-panel";
import { ReconciliationPanel } from "@/components/tokens/reconciliation-panel";
import { TotalsTiles } from "@/components/tokens/totals-tiles";

const WINDOWS: TokenWindow[] = ["7d", "30d"];

export default function TokensPage() {
  const [win, setWin] = useState<TokenWindow>("7d");
  // a cold scan of the whole store can take longer than the shared 10 s default fetch timeout
  const poll = usePoll<TokenIntelligenceResponse>(`/api/tokens?window=${win}`, 60_000, { timeoutMs: 120_000 });
  const data = poll.data;
  // R13: mission titles are joined client-side from /api/tasks, keeping the strict tokens allowlist server-side
  const { tasks } = useCadence();
  const titles = useMemo(() => new Map(tasks.data?.tasks.map((t) => [t.id, t.title] as const) ?? []), [tasks.data]);

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-3 px-4 py-3">
      <CostBanner costBasis={data?.costBasis ?? null} />
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="hud-title">Token Intelligence</h1>
        <div className="flex gap-1" role="group" aria-label="Window">
          {WINDOWS.map((w) => (
            <button key={w} type="button" className={cn("btn", win === w && "active")} aria-pressed={win === w} onClick={() => setWin(w)}>
              {windowLabel(w)}
            </button>
          ))}
        </div>
        <span className="label num text-faint">
          {data ? `${coverageChipText(data.coverage)} · generated ${data.generatedAt} · ${data.coverage.scanMs} ms` : (poll.error ?? "loading…")}
        </span>
      </div>

      {!data ? (
        <p className="hud px-3 py-2 text-dim">{poll.error ? `error: ${poll.error}` : "loading…"}</p>
      ) : (
        <>
          <TotalsTiles totals={data.totals} />
          <DailyBars daily={data.daily} />
          <ByModelTable rows={data.byModel} />
          <ByAgentTable rows={data.byAgent} />
          <ByMissionTable rows={data.byMission} titles={titles} />
          <UnattributedTable rows={data.unattributed} />
          <ContextPanel context={data.context} />
          <HandoffPanel handoff={data.handoff} instructionReads={data.instructionReads} />
          <AttachmentsPanel attachments={data.attachments} />
          <ReconciliationPanel reconciliation={data.reconciliation} />
          <CoveragePanel coverage={data.coverage} window={data.window} />
        </>
      )}
    </div>
  );
}
