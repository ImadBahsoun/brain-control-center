"use client";
import { useFoldFocus } from "@/hooks/use-fold-state";
import type { Finding } from "@/lib/api-types";
import { relativeAge } from "@/lib/format";
import { OPEN_STATUSES, selectRailThreats, threatClass, THREAT_CLASS_LABEL } from "@/lib/ui/threats";
import { cn } from "@/lib/utils";
import { Glyph, type GlyphName } from "@/components/ui/glyphs";
import type { Opener } from "@/components/map/map-node";

export function severityChip(severity: string): string {
  switch (severity) {
    case "BLOCKER":
      return "chip-danger";
    case "MAJOR":
      return "chip-warn";
    case "MINOR":
      return "chip-signal";
    default:
      return "chip-dim";
  }
}

export function ThreatRow({ finding, selected, onOpen }: { finding: Finding; selected: boolean; onOpen: (id: string, opener: Opener) => void }) {
  const cls = threatClass(finding);
  const glyph: GlyphName = cls === "active" ? "warning" : cls === "resolved" ? "check" : cls === "neutralizing" ? "pulse" : cls === "dismissed" ? "cross" : "question";
  const tone = cls === "active" ? (finding.severity === "BLOCKER" ? "tone-danger" : "tone-warn") : cls === "resolved" ? "tone-ok" : cls === "neutralizing" ? "tone-signal" : "tone-faint";
  return (
    <li>
      <button type="button" className={cn("row-button flex items-start gap-2 px-2 py-1.5", selected && "bg-accent/60")} onClick={(e) => onOpen(finding.id, e.currentTarget)} aria-haspopup="dialog" aria-expanded={selected}>
        <Glyph name={glyph} size={12} className={cn("mt-0.5 shrink-0", tone)} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className={cn("chip", severityChip(finding.severity))}>{finding.severity}</span>
            <span className="font-mono text-[11px] text-foreground">{finding.id}</span>
            <span className={cn("label", tone)}>{finding.status}</span>
            <span className="ml-auto label text-faint">{relativeAge(finding.updatedAt)}</span>
          </span>
          <span className="mt-0.5 block overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-dim" title={finding.title}>
            {finding.title}
          </span>
          <span className="label text-faint">
            {THREAT_CLASS_LABEL[cls].toLowerCase()} · {finding.sources.join(", ") || "no source"}
          </span>
        </span>
      </button>
    </li>
  );
}

export interface ThreatRailProps {
  findings: Finding[];
  /** False while the mission's findings request has not answered yet. */
  loaded: boolean;
  error: string | null;
  overflow: number;
  selectedId: string | null;
  onOpen: (id: string, opener: Opener) => void;
  missionId: string | null;
  /** The narrow strip shown when a mission has no findings, so the map gets the width. */
  compact?: boolean;
  /**
   * 1100 px and wider (CSS-driven, per width band: 1100 ≤ width < 1440 and width ≥ 1440; Tailwind 4 compiles max-[1440px] to width < 1440px): the list is folded into the 44 px
   * strip so the scene pane takes the width; the strip's button opens it and a Hide button folds it again.
   * Below 1100 px the list is always shown and there are no fold controls.
   */
  foldedBand?: boolean;
  foldedWide?: boolean;
  /** Called with the fold state being asked for (true = fold); no fold controls without it. */
  onFold?: (folded: boolean) => void;
  className?: string;
}

export function ThreatRail({ findings, loaded, error, overflow, selectedId, onOpen, missionId, compact = false, foldedBand = false, foldedWide = false, onFold, className }: ThreatRailProps) {
  const rail = selectRailThreats(findings);
  const open = findings.filter((f) => OPEN_STATUSES.has(f.status)).length;
  // after a toggle the pressed button disappears: focus moves to its counterpart
  const { showButton, hideButton, request } = useFoldFocus(`${foldedBand}-${foldedWide}`);
  const fold = (folded: boolean) => {
    request(folded);
    onFold?.(folded);
  };
  const folding = !!onFold;
  const stripped = folding && (foldedBand || foldedWide);
  // the strip shows, and the full list hides, only at the widths where the rail is folded (below 1100 px neither)
  const stripShown = cn(foldedBand && "min-[1100px]:max-[1440px]:flex", foldedWide && "min-[1440px]:flex");
  const listHidden = folding && cn(foldedBand && "min-[1100px]:max-[1440px]:hidden", foldedWide && "min-[1440px]:hidden");
  if (compact) {
    return (
      <section className={cn("hud flex flex-col items-center gap-3 px-1 py-3", className)} aria-label="Threats: findings of the focused mission">
        <h2 className="hud-title rail-vertical">Threats</h2>
        <span className="label num text-faint">0</span>
        <Glyph name="check" size={12} className="tone-ok" title="no findings recorded on this mission" />
      </section>
    );
  }
  return (
    <>
      {stripped && (
        <section className={cn("hud hidden flex-col", stripShown, className)} aria-label="Threats: findings of the focused mission, folded">
          <button
            ref={showButton}
            type="button"
            className="row-button flex flex-1 flex-col items-center gap-3 px-1 py-3"
            onClick={() => fold(false)}
            aria-expanded={false}
            aria-label={`Show the findings list${missionId && loaded ? `: ${open} open of ${findings.length}` : ""}`}
          >
            <span className="hud-title rail-vertical">Threats</span>
            <span className="label num text-dim">{missionId && loaded ? open : "—"}</span>
            <Glyph name="chevron" size={12} className="rotate-180 text-dim" />
          </button>
        </section>
      )}
      <section className={cn("hud flex min-h-0 flex-col", listHidden, className)} aria-label="Threats: findings of the focused mission">
      <div className="flex items-center justify-between px-3 py-2 min-[1100px]:gap-2">
        <h2 className="hud-title">Threats · Findings</h2>
        <span className="label num text-dim">{missionId && loaded ? `${open} open / ${findings.length}` : "—"}</span>
        {folding && (
          <button ref={hideButton} type="button" className="btn hidden py-0.5 min-[1100px]:inline-flex" onClick={() => fold(true)} aria-expanded aria-label="Hide the findings list">
            Hide
          </button>
        )}
      </div>
      {!missionId ? (
        <p className="px-3 pb-3 text-[12px] text-faint">No mission in focus.</p>
      ) : error && !loaded ? (
        <p className="px-3 pb-3 text-[12px] tone-warn">findings error: {error}</p>
      ) : !loaded ? (
        <p className="px-3 pb-3 text-[12px] text-faint">loading findings…</p>
      ) : findings.length === 0 ? (
        <p className="px-3 pb-3 text-[12px] text-faint">No findings recorded on this mission.</p>
      ) : (
        <ol className="scroll-thin min-h-0 flex-1 overflow-y-auto border-t border-border">
          {rail.map((f) => (
            <ThreatRow key={f.id} finding={f} selected={selectedId === f.id} onOpen={onOpen} />
          ))}
        </ol>
      )}
      {missionId && loaded && error && <p className="border-t border-border px-3 py-1.5 label tone-warn">last findings poll failed: {error}</p>}
      {missionId && loaded && (findings.length > rail.length || overflow > 0) && (
        <p className="border-t border-border px-3 py-1.5 label text-faint">
          {findings.length > rail.length ? `${findings.length - rail.length} more in the mission detail` : ""}
          {overflow > 0 ? ` · ${overflow} not drawn on the map` : ""}
        </p>
      )}
      </section>
    </>
  );
}
