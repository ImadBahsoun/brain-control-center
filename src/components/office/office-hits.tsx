"use client";
import type { OfficeScene } from "@/lib/ui/office";
import type { Point } from "@/lib/ui/layout";
import { boxHull, coreHull, footprintOf, GATE_ROOM, OFFICE_EDGE_GEOMETRY, points, roomHull, SYNTHESIS_AT, type Prop } from "@/lib/ui/office-layout";
import type { Selection } from "@/lib/ui/selection";
import { sameSelection } from "@/lib/ui/selection";
import { MapItem, type Opener } from "@/components/map/map-node";

function Hull({ pts, hole }: { pts: string; hole?: string }) {
  if (!hole) return <polygon className="hit-fill" points={pts} />;
  return <path className="hit-fill" fillRule="evenodd" d={`M ${pts} Z M ${hole} Z`} />;
}

/** A band around a straight connection, cut out of the room it runs in so the pointer reaches the connection. */
function band(a: Point, b: Point, half: number): string {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const nx = (-(b.y - a.y) / len) * half;
  const ny = ((b.x - a.x) / len) * half;
  return points([
    { x: a.x + nx, y: a.y + ny },
    { x: b.x + nx, y: b.y + ny },
    { x: b.x - nx, y: b.y - ny },
    { x: a.x - nx, y: a.y - ny },
  ]);
}

/** The outline of a console, a little larger than its box so it is easy to hit. */
function consoleHull(p: Prop): string {
  const f = footprintOf(p);
  return points(boxHull({ u0: f.u0 - 0.25, u1: f.u1 + 0.25, v0: f.v0 - 0.25, v1: f.v1 + 0.25 }, p.h + 0.5));
}

/**
 * The office's buttons, drawn over the scene in pipeline order: the five role rooms, the gate room, the core,
 * the synthesis console and the READY console. Each opens the same panel as the command map (Enter, Space or
 * a click), with a visible focus ring and the state in words as its accessible name. The gate room's area leaves a
 * band free along E11 (READY → commander console, drawn above the room) so that connection stays clickable.
 */
export function OfficeHits({ scene, selection, onSelect }: { scene: OfficeScene; selection: Selection | null; onSelect: (sel: Selection, opener: Opener) => void }) {
  const pick = (sel: Selection) => (opener: Opener) => onSelect(sel, opener);
  const isSel = (sel: Selection) => sameSelection(selection, sel);
  const synth: Prop = { ...SYNTHESIS_AT, du: 0.75, dv: 0.5, h: 0.55 };
  const hit = (key: string, sel: Selection, label: string, pts: string, hole?: string) => ({ key, sel, label, pts, hole });
  const e11 = OFFICE_EDGE_GEOMETRY.E11;
  const items = [
    ...scene.rooms.map((r) => hit(r.id, { kind: "node", id: r.id }, r.aria, points(roomHull(r.id)))),
    hit("gate", { kind: "gate" }, scene.gate.aria, points(roomHull("gate")), band({ x: e11.x1, y: e11.y1 }, { x: e11.x2, y: e11.y2 }, 9)),
    hit("core", { kind: "node", id: "core" }, `Brain core: ${scene.core.statusText}; atmosphere ${scene.atmo.label.toLowerCase()}`, points(coreHull())),
    hit("synthesis", { kind: "node", id: "synthesis" }, `${scene.synthesis.stepNo} Synthesis console: ${scene.synthesis.statusText}`, consoleHull(synth)),
    hit("ready", { kind: "node", id: "ready" }, `${scene.gate.ready.stepNo} READY console: ${scene.gate.ready.statusText}`, consoleHull(GATE_ROOM.ready)),
  ];
  return (
    <g className="office-hits">
      {items.map((it) => (
        <MapItem key={it.key} label={it.label} selected={isSel(it.sel)} onSelect={pick(it.sel)} ring={<polygon className="focus-ring" points={it.pts} />}>
          <Hull pts={it.pts} hole={it.hole} />
        </MapItem>
      ))}
    </g>
  );
}
