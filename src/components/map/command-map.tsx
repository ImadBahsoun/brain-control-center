"use client";
import { useId } from "react";
import { cn } from "@/lib/utils";
import { atmosphere } from "@/lib/ui/atmosphere";
import type { CommandMapModel } from "@/lib/ui/command-map";
import { roleAction, roleActivity, roleMission } from "@/lib/ui/hud";
import { verdictTone } from "@/lib/ui/verdict";
import { NODES, threatLane, WORLD, type NodeId } from "@/lib/ui/layout";
import type { Selection } from "@/lib/ui/selection";
import { sameSelection } from "@/lib/ui/selection";
import { toTransform } from "@/lib/ui/viewport";
import type { ActiveEffect } from "@/hooks/use-live-effects";
import { usePanZoom, type WheelZoom } from "@/hooks/use-pan-zoom";
import { MapControls } from "@/components/map/map-controls";
import { MapEdge } from "@/components/map/map-edge";
import { CoreNode, GateNode, RoleNode, StepNode, type Opener } from "@/components/map/map-node";
import { ThreatMarker, ThreatOverflowChip } from "@/components/map/threat-marker";

export type SelectHandler = (selection: Selection, opener: Opener | null) => void;

export type { WheelZoom };

export interface CommandMapProps {
  model: CommandMapModel;
  effects: ActiveEffect[];
  selection: Selection | null;
  onSelect: SelectHandler;
  reducedMotion: boolean;
  wheelZoom: WheelZoom;
  /** Full-screen Focus Mode below the 1024px desktop breakpoint: the scene fills its pane and the
   * controls dock outside the drawing instead of floating over it. No effect at 1024px and up. */
  focused?: boolean;
  /** Whether the map owns touch gestures outright (pinch, two-finger pan): `touchGestures` from
   * focus-mode.ts, computed next to `focused`/`wheelZoom`. Never true at the 1024px desktop breakpoint
   * and up, so a trackpad's page-pinch and a mouse keep their ordinary desktop behaviour there (R12). */
  touchGestures?: boolean;
  className?: string;
}

const CENTER = { x: WORLD.width / 2, y: WORLD.height / 2 };

/** The node a one-shot effect is drawn on, and the colour it means. */
export function effectTargets(e: ActiveEffect["effect"], model: CommandMapModel): Array<{ id: NodeId; tone: string; big?: boolean }> {
  switch (e.kind) {
    case "agent-start":
      return [{ id: e.target, tone: "var(--signal)" }];
    case "agent-complete": {
      // a lost run is a failure, a refund is neutral, a report takes its verdict's tone
      const tone = e.status === "lost" ? "var(--danger)" : e.status === "not-launched" ? "var(--dim)" : verdictTone(e.verdict) === "fail" ? "var(--danger)" : verdictTone(e.verdict) === "concern" ? "var(--warn)" : "var(--ok)";
      return [{ id: e.target, tone }];
    }
    case "finding-new": {
      const t = model.threats.find((x) => x.id === e.target);
      return [{ id: t?.anchor ?? "core", tone: "var(--warn)" }];
    }
    case "finding-resolved": {
      const t = model.threats.find((x) => x.id === e.target);
      return [{ id: t?.anchor ?? "core", tone: "var(--ok)" }];
    }
    case "step": {
      const map: Record<string, NodeId[]> = {
        PLANNING: ["planner"],
        IMPLEMENTING: ["developer"],
        FIXING: ["developer"],
        TESTING: ["qa"],
        REVIEWING: ["reviewer", "security-reviewer"],
        VALIDATING: ["qa", "reviewer", "security-reviewer"],
        REVALIDATING: ["qa", "reviewer", "security-reviewer"],
        SYNTHESIZING: ["synthesis"],
        READY: ["ready"],
        HUMAN_APPROVAL: ["gate"],
      };
      return (map[e.target] ?? ["core"]).map((id) => ({ id, tone: "var(--signal)" }));
    }
    case "gate-raised":
      return [{ id: "gate", tone: "var(--warn)", big: true }];
    case "blocked":
      return [{ id: "core", tone: "var(--danger)", big: true }];
    case "ready":
      return [{ id: "ready", tone: "var(--ok)", big: true }];
    case "mission-complete":
      return [
        { id: "ready", tone: "var(--ok)", big: true },
        { id: "core", tone: "var(--ok)", big: true },
      ];
  }
}

export function CommandMap({ model, effects, selection, onSelect, reducedMotion, wheelZoom, focused, touchGestures = false, className }: CommandMapProps) {
  const { svgRef, contentRef, view, panning, bgHandlers, svgHandlers, onKeyDown, zoomIn, zoomOut, reset, fit } = usePanZoom({ center: CENTER, wheelZoom, world: WORLD, touchGestures });
  const helpId = useId();

  const pick = (sel: Selection) => (opener: Opener) => onSelect(sel, opener);
  const isSel = (sel: Selection) => sameSelection(selection, sel);
  // loops run on a live mission and in a replay; debrief, idle and loading maps are static (idle keeps its ambient core)
  const animated = model.mode === "live" || model.mode === "replay";
  const atmo = atmosphere(model);

  return (
    <div
      className={cn("relative h-full w-full max-md:flex max-md:flex-col", focused && "max-lg:flex max-lg:flex-col max-lg:landscape:flex-row", className)}
      role="group"
      tabIndex={0}
      aria-roledescription="command map"
      aria-label={`Command map, ${model.mode === "idle" ? "no active mission" : model.mode === "loading" ? `loading mission ${model.missionId ?? ""}` : model.mode === "replay" ? `replay of mission ${model.missionId ?? ""}` : `mission ${model.missionId ?? ""}`}`}
      aria-describedby={helpId}
      onKeyDown={onKeyDown}
    >
      <p id={helpId} className="sr-only">
        Zoom with plus and minus{wheelZoom === "modifier" ? " or control plus the mouse wheel" : " or the mouse wheel"}
        {wheelZoom === "plain" ? ", or pinch with two fingers" : ""}, pan with the arrow keys or by dragging, press 0 to reset the view. Tab moves through the connections, nodes, threats and the gate; Enter opens the selected item.
      </p>
      <svg
        ref={svgRef}
        className={cn("map-svg max-md:min-h-0 max-md:flex-1", focused && "max-lg:min-h-0 max-lg:flex-1", wheelZoom === "modifier" && "touch-pan", panning && "panning")}
        viewBox={`0 0 ${WORLD.width} ${WORLD.height}`}
        preserveAspectRatio="xMidYMid meet"
        aria-hidden={false}
        {...svgHandlers}
      >
        <rect
          x={-WORLD.width * 4}
          y={-WORLD.height * 4}
          width={WORLD.width * 9}
          height={WORLD.height * 9}
          fill="transparent"
          style={{ cursor: panning ? "grabbing" : "grab" }}
          {...bgHandlers}
          aria-hidden="true"
        />
        <g ref={contentRef} transform={toTransform(view)}>
          {/* L1a: edges under the nodes */}
          <g className="edges">
            {model.edges.map((edge) => (
              <MapEdge key={edge.id} edge={edge} selected={isSel({ kind: "edge", id: edge.id })} onSelect={pick({ kind: "edge", id: edge.id })} reducedMotion={reducedMotion} animated={animated} />
            ))}
          </g>
          {/* L1b: nodes */}
          <g className="nodes">
            <CoreNode node={model.core} atmo={atmo} selected={isSel({ kind: "node", id: "core" })} onSelect={pick({ kind: "node", id: "core" })} reducedMotion={reducedMotion} mode={model.mode} />
            {model.roles.map((r) => (
              <RoleNode
                key={r.id}
                node={r}
                activity={roleActivity(r)}
                action={roleAction(r, model.detail, { replay: model.mode === "replay" }).text}
                mission={roleMission(r, model)}
                missionId={model.missionId}
                guardian={r.id === "security-reviewer" && atmo.guardian}
                selected={isSel({ kind: "node", id: r.id })}
                onSelect={pick({ kind: "node", id: r.id })}
                reducedMotion={reducedMotion}
                animated={animated}
              />
            ))}
            <StepNode node={model.synthesis} selected={isSel({ kind: "node", id: "synthesis" })} onSelect={pick({ kind: "node", id: "synthesis" })} reducedMotion={reducedMotion} animated={animated} />
            <StepNode node={model.ready} selected={isSel({ kind: "node", id: "ready" })} onSelect={pick({ kind: "node", id: "ready" })} reducedMotion={reducedMotion} animated={animated} />
            <GateNode node={model.gate} selected={isSel({ kind: "gate" })} onSelect={pick({ kind: "gate" })} reducedMotion={reducedMotion} animated={animated} />
          </g>
          {/* L1c: threat markers in their anchor lanes */}
          <g className="threats">
            {model.lanes.map((lane) => {
              const geometry = threatLane(lane.anchor);
              return (
                <g key={lane.anchor}>
                  {lane.shown.map((threat, i) => (
                    <ThreatMarker key={threat.id} threat={threat} at={geometry.slots[i] ?? NODES[lane.anchor]} labelSide={geometry.labelSide} selected={isSel({ kind: "threat", id: threat.id })} onSelect={pick({ kind: "threat", id: threat.id })} />
                  ))}
                  {lane.overflow > 0 && (
                    <ThreatOverflowChip anchor={lane.anchor} count={lane.overflow} at={geometry.slots[lane.shown.length] ?? NODES[lane.anchor]} labelSide={geometry.labelSide} onSelect={pick({ kind: "node", id: lane.anchor })} />
                  )}
                </g>
              );
            })}
          </g>
          {/* L1d: one-shot effects, keyed so a remount restarts the animation */}
          <g className="effects" aria-hidden="true">
            {effects.flatMap((fx) =>
              effectTargets(fx.effect, model).map((t, i) => {
                const n = NODES[t.id];
                return (
                  <g key={`${fx.key}:${i}`} className={cn("fx", `fx-${fx.effect.kind}`)}>
                    <circle className="fx fx-burst" cx={n.x} cy={n.y} r={n.r + (t.big ? 10 : 4)} style={{ stroke: t.tone }} />
                    <circle className="fx fx-flash" cx={n.x} cy={n.y} r={n.r + 1} style={{ stroke: t.tone }} />
                  </g>
                );
              }),
            )}
          </g>
        </g>
      </svg>
      {wheelZoom === "modifier" && (
        <p className="map-hint pointer-events-none absolute bottom-3 left-3 max-md:static max-md:mx-2 max-md:self-start label text-faint">
          <span className="pointer-coarse:hidden">ctrl + scroll to zoom · drag to pan</span>
          <span className="hidden pointer-coarse:inline">drag sideways to pan · Focus mode to pinch-zoom</span>
        </p>
      )}
      <MapControls
        className={cn("absolute bottom-3 right-3 max-md:static max-md:self-end max-md:p-2", focused && "max-lg:static max-lg:self-end max-lg:p-2 max-lg:landscape:self-center max-lg:landscape:flex-col")}
        zoom={view.k}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onReset={reset}
        onFit={fit}
      />
    </div>
  );
}
