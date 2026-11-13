"use client";
import type { ReactNode } from "react";
import type { StepStatus } from "@/lib/api-types";
import type { EdgeState } from "@/lib/ui/command-map";
import type { GateRoomModel, RoleRoomModel } from "@/lib/ui/office";
import { FOOTPRINTS, FRONT_H, GATE_ROOM, iso, points, ROLE_ROOMS, SLAB_H, sortRoomItems, WALL_H, facePoly, type Footprint, type UV } from "@/lib/ui/office-layout";
import { MapGlyph } from "@/components/ui/glyphs";
import { STATE_TONE } from "@/components/map/map-node";
import { OfficeFigure } from "@/components/office/office-figure";
import { FIGURE_TONE, PropBox } from "@/components/office/office-prism";

const range = (a: number, b: number, step = 1): number[] => {
  const out: number[] = [];
  for (let x = a + step; x < b - 1e-9; x += step) out.push(x);
  return out;
};

/** Ground shadow, slab, floor tiles and the two glass back walls (u0 and v0 faces) with light top edges. */
export function RoomShell({ fp, tint }: { fp: Footprint; tint: string | null }) {
  const S = SLAB_H;
  const H = WALL_H;
  const grow = { u0: fp.u0 - 0.25, u1: fp.u1 + 0.35, v0: fp.v0 - 0.25, v1: fp.v1 + 0.35 };
  const wallU = [iso(fp.u0, fp.v0, S), iso(fp.u0, fp.v1, S), iso(fp.u0, fp.v1, H), iso(fp.u0, fp.v0, H)];
  const wallV = [iso(fp.u0, fp.v0, S), iso(fp.u1, fp.v0, S), iso(fp.u1, fp.v0, H), iso(fp.u0, fp.v0, H)];
  const line = (a: UV & { z: number }, b: UV & { z: number }) => {
    const p = iso(a.u, a.v, a.z);
    const q = iso(b.u, b.v, b.z);
    return `M ${p.x} ${p.y} L ${q.x} ${q.y}`;
  };
  return (
    <g>
      <polygon className="office-shadow" points={points(facePoly(grow, 0))} />
      <polygon className="office-slab-right" points={points([iso(fp.u1, fp.v0, 0), iso(fp.u1, fp.v1, 0), iso(fp.u1, fp.v1, S), iso(fp.u1, fp.v0, S)])} />
      <polygon className="office-slab-left" points={points([iso(fp.u0, fp.v1, 0), iso(fp.u1, fp.v1, 0), iso(fp.u1, fp.v1, S), iso(fp.u0, fp.v1, S)])} />
      <polygon className="office-slab-top" points={points(facePoly(fp, S))} />
      <path
        className="office-tile"
        d={[...range(fp.u0, fp.u1).map((u) => line({ u, v: fp.v0, z: S }, { u, v: fp.v1, z: S })), ...range(fp.v0, fp.v1).map((v) => line({ u: fp.u0, v, z: S }, { u: fp.u1, v, z: S }))].join(" ")}
      />
      {tint && <polygon className="office-room-tint" points={points(facePoly(fp, S))} style={{ fill: tint }} />}
      <polygon className="office-wall" points={points(wallU)} />
      <polygon className="office-wall" points={points(wallV)} />
      <path
        className="office-wall-mullion"
        d={[...range(fp.v0, fp.v1).map((v) => line({ u: fp.u0, v, z: S }, { u: fp.u0, v, z: H })), ...range(fp.u0, fp.u1).map((u) => line({ u, v: fp.v0, z: S }, { u, v: fp.v0, z: H }))].join(" ")}
      />
      <path className="office-top-edge" d={`${line({ u: fp.u0, v: fp.v1, z: H }, { u: fp.u0, v: fp.v0, z: H })} L ${iso(fp.u1, fp.v0, H).x} ${iso(fp.u1, fp.v0, H).y}`} />
      <path className="office-top-edge" d={line({ u: fp.u0, v: fp.v0, z: S }, { u: fp.u0, v: fp.v0, z: H })} style={{ strokeWidth: 1.2, opacity: 0.6 }} />
    </g>
  );
}

/** The low front glass on the u1 and v1 faces, drawn over everything inside the room. */
export function FrontGlass({ fp }: { fp: Footprint }) {
  const S = SLAB_H;
  const F = FRONT_H;
  const right = [iso(fp.u1, fp.v0, S), iso(fp.u1, fp.v1, S), iso(fp.u1, fp.v1, F), iso(fp.u1, fp.v0, F)];
  const left = [iso(fp.u0, fp.v1, S), iso(fp.u1, fp.v1, S), iso(fp.u1, fp.v1, F), iso(fp.u0, fp.v1, F)];
  const a = iso(fp.u0, fp.v1, F);
  const b = iso(fp.u1, fp.v1, F);
  const c = iso(fp.u1, fp.v0, F);
  const corner = iso(fp.u1, fp.v1, S);
  return (
    <g>
      <polygon className="office-glass" points={points(right)} />
      <polygon className="office-glass" points={points(left)} />
      <path className="office-top-edge" d={`M ${a.x} ${a.y} L ${b.x} ${b.y} L ${c.x} ${c.y}`} />
      <path className="office-top-edge" d={`M ${corner.x} ${corner.y} L ${b.x} ${b.y}`} style={{ strokeWidth: 1, opacity: 0.5 }} />
    </g>
  );
}

function Plant({ at }: { at: UV }) {
  const p = iso(at.u, at.v, SLAB_H);
  return (
    <g transform={`translate(${p.x} ${p.y})`}>
      <path className="office-wood-left" d="M-5 0 L5 0 L6 -8 L-6 -8 Z" />
      <ellipse className="office-leaf-dark" cx={-3} cy={-14} rx={5} ry={7} />
      <ellipse className="office-leaf" cx={3} cy={-16} rx={5} ry={8} />
      <ellipse className="office-leaf" cx={-1} cy={-21} rx={3.5} ry={6} />
    </g>
  );
}

/** A tall cabinet against the back wall, with two static indicator dots (decor, no data). */
function Cabinet({ room }: { room: (typeof ROLE_ROOMS)[keyof typeof ROLE_ROOMS] }) {
  const c = room.cabinet;
  const dot = iso(c.u - c.du / 2 + 0.2, c.v + c.dv / 2, SLAB_H + c.h - 0.3);
  return (
    <g>
      <PropBox prop={c} z0={SLAB_H} material="metal" />
      <circle className="office-led" cx={dot.x} cy={dot.y} r={1.4} fill="var(--text-faint)" />
      <circle className="office-led" cx={dot.x + 6} cy={dot.y - 3} r={1.4} fill="var(--text-faint)" />
    </g>
  );
}

type Item = UV & { z?: number; key: string; node: ReactNode };

export function OfficeRoleRoom({ room, loop }: { room: RoleRoomModel; loop: boolean }) {
  const fp = FOOTPRINTS[room.id];
  const L = ROLE_ROOMS[room.id];
  const seated = room.figure.posture === "seated";
  const tone = FIGURE_TONE[room.figure.tone];
  const glow = seated && room.figure.tone === "active";
  const deskTop = SLAB_H + L.desk.h;
  const monitor = { u: L.desk.u + 0.35, v: L.desk.v - 0.15, du: 0.55, dv: 0.1, h: 0.42 };
  const chair = { u: L.seat.u, v: L.seat.v - 0.3, du: 0.55, dv: 0.5, h: 0.45 };
  const items: Item[] = [
    { key: "chair", ...chair, node: <PropBox prop={chair} z0={SLAB_H} material="metal" /> },
    { key: "desk", ...L.desk, node: <PropBox prop={L.desk} z0={SLAB_H} material="wood" /> },
    { key: "monitor", ...monitor, z: deskTop, node: <PropBox prop={monitor} z0={deskTop} material="metal" /> },
    { key: "plant", ...L.plant, node: <Plant at={L.plant} /> },
    { key: "cabinet", ...L.cabinet, node: <Cabinet room={L} /> },
    {
      key: "figure",
      ...(seated ? L.seat : L.stand),
      node: <OfficeFigure at={iso((seated ? L.seat : L.stand).u, (seated ? L.seat : L.stand).v, SLAB_H)} role={room.id} posture={room.figure.posture} tone={tone} extra={room.figure.extra} glow={glow} loop={loop} />,
    },
  ];
  return (
    <g className="office-room" aria-hidden="true">
      <RoomShell fp={fp} tint={seated ? tone : null} />
      {sortRoomItems(items).map((it) => (
        <g key={it.key}>{it.node}</g>
      ))}
      <FrontGlass fp={fp} />
    </g>
  );
}

function stepTone(status: StepStatus | null): string {
  if (status === "completed") return "var(--ok)";
  if (status === "current") return "var(--signal)";
  return "var(--dim)";
}

/** A console with a status light on its top face. */
function Console({ prop, light, children }: { prop: (typeof GATE_ROOM)["commander"]; light: string; children?: ReactNode }) {
  const top = iso(prop.u, prop.v, SLAB_H + prop.h);
  return (
    <g>
      <PropBox prop={prop} z0={SLAB_H} material="metal" />
      <ellipse cx={top.x} cy={top.y} rx={4} ry={2} style={{ fill: light }} />
      {children}
    </g>
  );
}

export function OfficeGateRoom({ gate, readyState, loop }: { gate: GateRoomModel; readyState: EdgeState; loop: boolean }) {
  const fp = FOOTPRINTS.gate;
  const G = GATE_ROOM;
  const waiting = gate.state === "waiting-approval";
  const lockTone = waiting ? "tone-warn" : gate.state === "completed" ? "tone-ok" : "tone-dim";
  const c = G.commander;
  const lockAt = iso(c.u, c.v, SLAB_H + c.h + 0.9);
  const items: Item[] = [
    ...G.release.map((p, i) => {
      const status = gate.release[i]?.status ?? null;
      return { key: `release-${i}`, ...p, node: <Console prop={p} light={stepTone(status)} /> };
    }),
    { key: "ready", ...G.ready, node: <Console prop={G.ready} light={STATE_TONE[readyState]} /> },
    {
      key: "commander",
      ...c,
      node: (
        <Console prop={c} light={waiting ? "var(--warn)" : gate.state === "completed" ? "var(--ok)" : "var(--dim)"}>
          {/* the empty commander console: a lock, never a person or a control */}
          <g transform={`translate(${lockAt.x} ${lockAt.y})`}>
            <circle r={12} className="office-badge" style={{ stroke: waiting ? "var(--warn)" : "var(--edge-strong)" }} />
            <MapGlyph name="lock" x={0} y={0} size={14} className={waiting && loop ? `${lockTone} loop blink` : lockTone} />
          </g>
        </Console>
      ),
    },
    { key: "plant", ...G.plant, node: <Plant at={G.plant} /> },
  ];
  return (
    <g className="office-room" aria-hidden="true">
      <RoomShell fp={fp} tint={waiting ? "var(--warn)" : null} />
      {sortRoomItems(items).map((it) => (
        <g key={it.key}>{it.node}</g>
      ))}
      <FrontGlass fp={fp} />
    </g>
  );
}

