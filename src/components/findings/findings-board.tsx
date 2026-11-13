"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import type { Finding, FindingsResponse, TaskSummary } from "@/lib/api-types";
import { relativeAge } from "@/lib/format";
import { isTerminalStatus } from "@/lib/lifecycle";
import { usePanelSelection } from "@/hooks/use-panel-selection";
import { usePollMany } from "@/hooks/use-poll";
import { roleLabel } from "@/lib/ui/roles";
import { OPEN_STATUSES, selectFindingsScope, sortThreats, threatClass, THREAT_CLASS_LABEL } from "@/lib/ui/threats";
import { cn } from "@/lib/utils";
import { Glyph } from "@/components/ui/glyphs";
import { severityChip } from "@/components/map/threat-rail";
import { FindingPanel } from "@/components/panels/finding-panel";
import { SidePanel } from "@/components/panels/side-panel";

const SEVERITIES = ["BLOCKER", "MAJOR", "MINOR", "NIT"] as const;
type OpenFilter = "open" | "resolved" | "all";

interface Row {
  taskId: string;
  finding: Finding;
}

export function FindingsBoard({ tasks, interval }: { tasks: TaskSummary[] | null; interval: number }) {
  const [picked, setPicked] = useState<string>("");
  const [severity, setSeverity] = useState<string>("");
  const [openFilter, setOpenFilter] = useState<OpenFilter>("open");
  const [source, setSource] = useState<string>("");
  const { selection: selected, select, close } = usePanelSelection<Row>();

  const scope = useMemo(() => {
    if (!tasks) return { live: [] as string[], settled: [] as string[] };
    if (picked && tasks.some((t) => t.id === picked)) {
      const t = tasks.find((x) => x.id === picked)!;
      return isTerminalStatus(t.status) ? { live: [], settled: [picked] } : { live: [picked], settled: [] };
    }
    return selectFindingsScope(tasks);
  }, [tasks, picked]);
  const liveUrls = useMemo(() => scope.live.map((id) => `/api/tasks/${encodeURIComponent(id)}/findings`), [scope.live]);
  const settledUrls = useMemo(() => scope.settled.map((id) => `/api/tasks/${encodeURIComponent(id)}/findings`), [scope.settled]);
  const live = usePollMany<FindingsResponse>(liveUrls, interval);
  const settled = usePollMany<FindingsResponse>(settledUrls, 0);

  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const r of [...Object.values(live), ...Object.values(settled)]) {
      if (!r.data) continue;
      for (const f of sortThreats(r.data.findings)) out.push({ taskId: r.data.taskId, finding: f });
    }
    return out;
  }, [live, settled]);
  const sources = useMemo(() => [...new Set(rows.flatMap((r) => r.finding.sources))].sort(), [rows]);
  const shown = rows.filter((r) => {
    const f = r.finding;
    if (severity && f.severity !== severity) return false;
    if (openFilter === "open" && !OPEN_STATUSES.has(f.status)) return false;
    if (openFilter === "resolved" && OPEN_STATUSES.has(f.status)) return false;
    if (source && !f.sources.includes(source)) return false;
    return true;
  });
  const errors = [...Object.values(live), ...Object.values(settled)].map((r) => r.error).filter((e): e is string => !!e);
  const loadedCount = [...Object.values(live), ...Object.values(settled)].filter((r) => r.data).length;

  return (
    <>
      <section className="hud" aria-label="Findings across missions">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <h2 className="hud-title">Findings · threats</h2>
          <span className="label num text-faint">
            {scope.live.length} live + {scope.settled.length} settled mission(s) · {loadedCount} loaded · {shown.length} shown
            {errors.length > 0 ? ` · ${errors.length} error(s)` : ""}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2 max-md:ml-0 max-md:w-full">
            <select className="btn max-md:w-full" value={picked} onChange={(e) => setPicked(e.target.value)} aria-label="Mission scope">
              <option value="">scope: non-terminal + newest (max 8)</option>
              {(tasks ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.id} · {t.status}
                </option>
              ))}
            </select>
            <select className="btn" value={severity} onChange={(e) => setSeverity(e.target.value)} aria-label="Filter by severity">
              <option value="">all severities</option>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <span className="flex gap-1" role="group" aria-label="Open or resolved">
              {(["open", "resolved", "all"] as const).map((o) => (
                <button key={o} type="button" className={cn("btn", openFilter === o && "active")} aria-pressed={openFilter === o} onClick={() => setOpenFilter(o)}>
                  {o}
                </button>
              ))}
            </span>
            <select className="btn" value={source} onChange={(e) => setSource(e.target.value)} aria-label="Filter by source">
              <option value="">all sources</option>
              {sources.map((s) => (
                <option key={s} value={s}>
                  {roleLabel(s)}
                </option>
              ))}
            </select>
          </div>
        </div>
        {!tasks ? (
          <p className="px-3 py-3 text-faint">loading…</p>
        ) : rows.length === 0 && loadedCount < scope.live.length + scope.settled.length ? (
          <p className="px-3 py-3 text-faint">loading findings…</p>
        ) : shown.length === 0 ? (
          <p className="px-3 py-3 text-faint">No findings match.</p>
        ) : (
          <ol className="divide-y divide-border">
            {shown.map((r) => {
              const f = r.finding;
              const cls = threatClass(f);
              const tone = cls === "active" ? (f.severity === "BLOCKER" ? "tone-danger" : "tone-warn") : cls === "resolved" ? "tone-ok" : cls === "neutralizing" ? "tone-signal" : "tone-faint";
              const isSel = selected?.taskId === r.taskId && selected.finding.id === f.id;
              return (
                <li key={`${r.taskId}-${f.id}`}>
                  <button type="button" className={cn("row-button grid grid-cols-[16px_minmax(90px,auto)_auto_auto_minmax(0,1fr)_auto_auto] items-center gap-3 px-3 py-1.5 max-md:flex max-md:flex-wrap max-md:gap-x-2 max-md:gap-y-1", isSel && "bg-accent/60")} onClick={(e) => select(r, e.currentTarget)} aria-haspopup="dialog" aria-expanded={isSel}>
                    <Glyph name={cls === "active" ? "warning" : cls === "resolved" ? "check" : cls === "neutralizing" ? "pulse" : cls === "dismissed" ? "cross" : "question"} size={12} className={tone} />
                    <span className="font-mono text-[11px] text-dim">
                      {r.taskId.slice(-4)}/{f.id}
                    </span>
                    <span className={cn("chip", severityChip(f.severity))}>{f.severity}</span>
                    <span className={cn("label", tone)}>{f.status}</span>
                    <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-foreground max-md:basis-full max-md:whitespace-normal max-md:line-clamp-2" title={f.title}>
                      {f.title}
                    </span>
                    <span className="label text-faint">{f.sources.map(roleLabel).join(", ") || "—"}</span>
                    <span className="label num text-faint">
                      {THREAT_CLASS_LABEL[cls].toLowerCase()} · {relativeAge(f.updatedAt)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
        {errors.length > 0 && <p className="px-3 py-2 tone-warn">errors: {errors.join(", ")}</p>}
      </section>
      {selected && (
        <SidePanel title={selected.finding.id} kicker={`${selected.finding.severity} · finding`} tone={selected.finding.severity === "BLOCKER" ? "tone-danger" : selected.finding.severity === "MAJOR" ? "tone-warn" : undefined} onClose={close}>
          <p className="mb-2 label text-faint">
            mission{" "}
            <Link href={`/tasks/${encodeURIComponent(selected.taskId)}`} className="font-mono normal-case tracking-normal text-signal">
              {selected.taskId}
            </Link>
          </p>
          <FindingPanel finding={selected.finding} missionId={selected.taskId} />
        </SidePanel>
      )}
    </>
  );
}
