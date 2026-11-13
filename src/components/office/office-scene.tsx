"use client";
import { useId, useMemo } from "react";
import type { AgentsResponse } from "@/lib/api-types";
import { cn } from "@/lib/utils";
import type { CommandMapModel } from "@/lib/ui/command-map";
import type { NodeId } from "@/lib/ui/layout";
import { buildOfficeScene, officeWalks } from "@/lib/ui/office";
import { coreHull, CORE_FOOTPRINT, depthOrder, EDGES_INSIDE_ROOMS, FOOTPRINTS, GATE_ROOM, iso, OFFICE_EDGE_GEOMETRY, OFFICE_ROOM_IDS, OFFICE_WORLD, points, roomHull, SYNTHESIS_AT, type DepthItem } from "@/lib/ui/office-layout";
import { isRole } from "@/lib/ui/roles";
import type { Selection } from "@/lib/ui/selection";
import { sameSelection } from "@/lib/ui/selection";
import { toTransform } from "@/lib/ui/viewport";
import type { ActiveEffect } from "@/hooks/use-live-effects";
import { usePanZoom, type WheelZoom } from "@/hooks/use-pan-zoom";
import { effectTargets, type SelectHandler } from "@/components/map/command-map";
import { MapControls } from "@/components/map/map-controls";
import { MapEdge } from "@/components/map/map-edge";
import type { Opener } from "@/components/map/map-node";
import { OfficeBackdrop } from "@/components/office/office-backdrop";
import { OfficeCore } from "@/components/office/office-core";
import { OfficeHits } from "@/components/office/office-hits";
import { CoreCaption, GateAlertCard, GateCard, RoomCard } from "@/components/office/office-label";
import { OfficeGateRoom, OfficeRoleRoom } from "@/components/office/office-room";
import { OfficeText } from "@/components/office/office-text";
import { OfficeWalker } from "@/components/office/office-walker";

export interface OfficeSceneProps {
  model: CommandMapModel;
  effects: ActiveEffect[];
  selection: Selection | null;
  onSelect: SelectHandler;
  reducedMotion: boolean;
  wheelZoom: WheelZoom;
  /** /api/agents for the typical run duration; null in a replay (not part of the recorded history). */
  agents: AgentsResponse | null;
  /** Milliseconds per replay step at the current speed; null when live. */
  stepMs: number | null;
  /** Full-screen Focus Mode below the 1024px desktop breakpoint: the scene fills its pane and the
   * controls dock outside the drawing instead of floating over it. No effect at 1024px and up. */
  focused?: boolean;
  /** Whether the map owns touch gestures outright (pinch, two-finger pan): `touchGestures` from
   * focus-mode.ts, computed next to `focused`/`wheelZoom`. Never true at the 1024px desktop breakpoint
   * and up, so a trackpad's page-pinch and a mouse keep their ordinary desktop behaviour there (R12). */
  touchGestures?: boolean;
  className?: string;
}

const CENTER = { x: OFFICE_WORLD.width / 2, y: OFFICE_WORLD.height / 2 };

const DEPTH = depthOrder<DepthItem>([...OFFICE_ROOM_IDS.map((id) => ({ id, fp: FOOTPRINTS[id], hull: roomHull(id) })), { id: "core", fp: CORE_FOOTPRINT, hull: coreHull() }]);

/** Where a one-shot effect on a map node flashes in the office: the outline of its room, the core, or a console. */
function fxOutline(id: NodeId): string {
  if (isRole(id) || id === "gate") return points(roomHull(id));
  if (id === "core") return points(coreHull());
  const at = id === "synthesis" ? SYNTHESIS_AT : GATE_ROOM.ready;
  const c = iso(at.u, at.v, 0.4);
  return points([
    { x: c.x, y: c.y - 16 },
    { x: c.x + 26, y: c.y },
    { x: c.x, y: c.y + 16 },
    { x: c.x - 26, y: c.y },
  ]);
}

/**
 * The OFFICE view: the focused mission drawn as an isometric office. Rooms, figures, the core and the tokens
 * come from the same command map model as the map (src/lib/ui/office.ts); the connections are the map's edges
 * on the office floor. Layers back to front: floor and windows, connections, rooms and core in depth order,
 * walking tokens, cards, buttons, one-shot flashes. Same keys as the map: + − arrows 0, Enter and Space open a panel.
 */
export function OfficeScene({ model, effects, selection, onSelect, reducedMotion, wheelZoom, agents, stepMs, focused, touchGestures = false, className }: OfficeSceneProps) {
  const { svgRef, contentRef, view, panning, bgHandlers, svgHandlers, onKeyDown, zoomIn, zoomOut, reset, fit } = usePanZoom({ center: CENTER, wheelZoom, world: OFFICE_WORLD, touchGestures });
  const helpId = useId();
  const replay = model.mode === "replay";
  const scene = useMemo(() => buildOfficeScene(model, { agents, replay }), [model, agents, replay]);
  const walkers = useMemo(() => officeWalks(effects, model, { replay, stepMs, missionId: model.missionId }), [effects, model, replay, stepMs]);
  const animated = model.mode === "live" || model.mode === "replay";
  const loop = animated && !reducedMotion;
  const pick = (sel: Selection) => (opener: Opener) => onSelect(sel, opener);
  const isSel = (sel: Selection) => sameSelection(selection, sel);
  // live effects of another mission (kept for their lifetime after a switch) flash nothing here, as they walk nothing
  const shownEffects = effects.filter((fx) => model.mode === "replay" || fx.missionId === model.missionId);
  const edge = (e: (typeof scene.connections)[number]) => (
    <MapEdge key={e.id} edge={e} geometry={OFFICE_EDGE_GEOMETRY[e.id]} selected={isSel({ kind: "edge", id: e.id })} onSelect={pick({ kind: "edge", id: e.id })} reducedMotion={reducedMotion} animated={animated} />
  );

  return (
    <div
      className={cn("relative h-full w-full max-md:flex max-md:flex-col", focused && "max-lg:flex max-lg:flex-col max-lg:landscape:flex-row", className)}
      role="group"
      tabIndex={0}
      aria-roledescription="office"
      aria-label={`Office, ${model.mode === "idle" ? "no active mission" : model.mode === "loading" ? `loading mission ${model.missionId ?? ""}` : model.mode === "replay" ? `replay of mission ${model.missionId ?? ""}` : `mission ${model.missionId ?? ""}`}`}
      aria-describedby={helpId}
      onKeyDown={onKeyDown}
    >
      <p id={helpId} className="sr-only">
        Zoom with plus and minus{wheelZoom === "modifier" ? " or control plus the mouse wheel" : " or the mouse wheel"}
        {wheelZoom === "plain" ? ", or pinch with two fingers" : ""}, pan with the arrow keys or by dragging, press 0 to reset the view. Tab moves through the connections, then the rooms, the core, the synthesis and READY consoles; Enter opens the selected item. A text version of the scene follows.
      </p>
      <OfficeText scene={scene} walkers={walkers} resources={model.resources} />
      <svg
        ref={svgRef}
        className={cn("map-svg office-svg max-md:min-h-0 max-md:flex-1", focused && "max-lg:min-h-0 max-lg:flex-1", wheelZoom === "modifier" && "touch-pan", panning && "panning")}
        viewBox={`0 0 ${OFFICE_WORLD.width} ${OFFICE_WORLD.height}`}
        preserveAspectRatio="xMidYMid meet"
        {...svgHandlers}
      >
        <rect x={-OFFICE_WORLD.width * 4} y={-OFFICE_WORLD.height * 4} width={OFFICE_WORLD.width * 9} height={OFFICE_WORLD.height * 9} fill="transparent" style={{ cursor: panning ? "grabbing" : "grab" }} {...bgHandlers} aria-hidden="true" />
        <g ref={contentRef} transform={toTransform(view)}>
          {/* L0: floor and window walls */}
          <OfficeBackdrop />
          {/* L1: the connections on the floor (buttons, first in the tab order like the map's edges) */}
          <g className="edges">{scene.connections.filter((e) => !EDGES_INSIDE_ROOMS.includes(e.id)).map(edge)}</g>
          {/* L2: rooms and the core, back to front */}
          <g className="rooms">
            {DEPTH.map((item) => {
              if (item.id === "core") return <OfficeCore key="core" core={scene.core} synthesis={scene.synthesis} reducedMotion={reducedMotion} />;
              if (item.id === "gate") return <OfficeGateRoom key="gate" gate={scene.gate} readyState={scene.gate.ready.state} loop={loop} />;
              const room = scene.rooms.find((r) => r.id === item.id);
              return room ? <OfficeRoleRoom key={room.id} room={room} loop={loop} /> : null;
            })}
          </g>
          {/* L2b: connections inside a room (READY → commander console), drawn above that room's floor */}
          <g className="edges inside">{scene.connections.filter((e) => EDGES_INSIDE_ROOMS.includes(e.id)).map(edge)}</g>
          {/* L3: mission tokens walking a real handoff */}
          <g className="walkers">
            {walkers.map((w) => (
              <OfficeWalker key={w.key} walker={w} reducedMotion={reducedMotion} />
            ))}
          </g>
          {/* L4: cards, never hidden behind anything */}
          <g className="cards">
            {scene.rooms.map((r) => (
              <RoomCard key={r.id} room={r} />
            ))}
            <GateCard gate={scene.gate} />
            {scene.gateAlert && <GateAlertCard alert={scene.gateAlert} />}
            <CoreCaption core={scene.core} />
          </g>
          {/* L5: the buttons, in pipeline order */}
          <OfficeHits scene={scene} selection={selection} onSelect={onSelect} />
          {/* L6: one-shot flashes, keyed so a remount restarts the animation */}
          <g className="effects" aria-hidden="true">
            {shownEffects.flatMap((fx) =>
              effectTargets(fx.effect, model).map((t, i) => <polygon key={`${fx.key}:${i}`} className="fx fx-flash" points={fxOutline(t.id)} style={{ stroke: t.tone, fill: "none" }} />),
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
