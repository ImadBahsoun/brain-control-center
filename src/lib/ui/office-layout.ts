// World geometry of the office view: a 2:1 dimetric projection of a 24 × 24 tile floor into a fixed
// 1200 × 720 world, six glass rooms in a clockwise pipeline ring around the Brain core, the doors and
// floor connections between them, walk corridors for mission tokens, depth order and card boxes. Pure,
// deterministic, unit-tested (tests/unit/ui-office-layout.test.ts).
//
// Axes: u runs toward the screen's lower right, v toward the lower left, z up. The back walls of every
// room sit on its u0 and v0 faces (the far sides); the low front glass on u1 and v1.
//
// Ring (clockwise from the upper left): PLANNING, BUILD, QUALITY, REVIEW, SECURITY, COMMANDER GATE.
//   E1 core→PLANNING door   E2 PLANNING→BUILD (direct corridor, carries the plan-gate lock)
//   E3 BUILD→core           E4/E5/E6 core→QUALITY/REVIEW/SECURITY doors
//   E7/E8/E9 validator door (a lane 0.35 tile beside E4–E6)→the synthesis console at the core rim
//   E10 synthesis→GATE door  E11 READY console→commander console (inside the gate room)
//   E12 synthesis→BUILD, around the core rim, a lane beside E3
import { EDGE_BY_ID, SAMPLES, type Box, type EdgeGeometry, type EdgeId, type Point } from "./layout";
import { ROLES, type Role } from "./roles";

export const OFFICE_WORLD = { width: 1200, height: 720 } as const;
export const GRID = 24;
/** Tile width and height on screen (2:1), and the screen lift of one z unit. */
export const TW = 48;
export const TH = 24;
export const TZ = 24;
export const OX = 600;
export const OY = 110;

export function iso(u: number, v: number, z = 0): Point {
  return { x: OX + ((u - v) * TW) / 2, y: OY + ((u + v) * TH) / 2 - z * TZ };
}

export interface UV {
  u: number;
  v: number;
}

export interface Footprint {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

/** Floor slab thickness, back wall height and front glass height (z units, from the ground). */
export const SLAB_H = 0.25;
export const WALL_H = 2.2;
export const FRONT_H = 0.9;
/** Height of the back window walls along the floor's far edges. */
export const WINDOW_H = 3.4;

/** One desk per role room: the Brain runs one run per role at a time and the governor has no per-role-per-mission limit. */
export const ROLE_SEATS = 1;

export type OfficeRoomId = Role | "gate";
export const OFFICE_ROOM_IDS: readonly OfficeRoomId[] = ["planner", "developer", "qa", "reviewer", "security-reviewer", "gate"];

export const ROOM_TITLE: Record<OfficeRoomId, string> = {
  planner: "PLANNING",
  developer: "BUILD",
  qa: "QUALITY",
  reviewer: "REVIEW",
  "security-reviewer": "SECURITY",
  gate: "COMMANDER GATE",
};

export const FOOTPRINTS: Record<OfficeRoomId, Footprint> = {
  planner: { u0: 1, u1: 5, v0: 7.5, v1: 11.5 },
  developer: { u0: 7.5, u1: 11.5, v0: 1, v1: 5 },
  qa: { u0: 18.5, u1: 22.5, v0: 2.5, v1: 6.5 },
  reviewer: { u0: 18.5, u1: 22.5, v0: 12.5, v1: 16.5 },
  "security-reviewer": { u0: 12.5, u1: 16.5, v0: 18.5, v1: 22.5 },
  gate: { u0: 2.5, u1: 7.5, v0: 18.5, v1: 22.5 },
};

/** The Brain core: a round plinth at the floor's centre; its hull covers the particle cloud above it. */
export const CORE = { u: 12, v: 12, r: 1.25, h: 1.8 } as const;
export const CORE_FOOTPRINT: Footprint = { u0: CORE.u - CORE.r, u1: CORE.u + CORE.r, v0: CORE.v - CORE.r, v1: CORE.v + CORE.r };
/** Radius at which connections leave the core, the synthesis console stands, and walkers circle it (tiles). */
export const RIM_R = 1.6;
export const SYNTH_R = 1.9;
export const WALK_R = 2.4;
/** The synthesis console at the core's front rim. */
export const SYNTHESIS_AT: UV = { u: CORE.u + SYNTH_R / Math.SQRT2, v: CORE.v + SYNTH_R / Math.SQRT2 };

const center = (f: Footprint): UV => ({ u: (f.u0 + f.u1) / 2, v: (f.v0 + f.v1) / 2 });

/** The door of a room: the midpoint of the face that looks most directly at the core. */
export function doorOf(f: Footprint): UV {
  const c = center(f);
  const du = CORE.u - c.u;
  const dv = CORE.v - c.v;
  if (Math.abs(du) >= Math.abs(dv)) return { u: du > 0 ? f.u1 : f.u0, v: c.v };
  return { u: c.u, v: dv > 0 ? f.v1 : f.v0 };
}

export const DOORS: Record<OfficeRoomId, UV> = Object.fromEntries(OFFICE_ROOM_IDS.map((id) => [id, doorOf(FOOTPRINTS[id])])) as Record<OfficeRoomId, UV>;

// ---- furniture ------------------------------------------------------------------------------------

/** A box on the floor of a room: centre, extent along u and v, height (z units above the slab). */
export interface Prop extends UV {
  du: number;
  dv: number;
  h: number;
}

export interface RoleRoomLayout {
  desk: Prop;
  /** Where the figure sits (behind the desk: smaller u + v, so the desk hides the legs). */
  seat: UV;
  /** Where the figure stands while the role holds no reservation. */
  stand: UV;
  plant: UV;
  cabinet: Prop;
}

export interface GateRoomLayout {
  commander: Prop;
  ready: Prop;
  /** COMMITTING, PUSHING, PR, DEPLOYING, along the back-left wall. */
  release: Prop[];
  plant: UV;
}

function roleRoom(f: Footprint): RoleRoomLayout {
  const at = (ru: number, rv: number): UV => ({ u: f.u0 + ru, v: f.v0 + rv });
  return {
    desk: { ...at(2.3, 2.35), du: 1.5, dv: 0.8, h: 0.7 },
    seat: at(2.3, 1.55),
    stand: at(1.15, 2.9),
    plant: at(0.45, 3.55),
    cabinet: { ...at(3.45, 0.45), du: 0.8, dv: 0.5, h: 1.3 },
  };
}

export const ROLE_ROOMS: Record<Role, RoleRoomLayout> = {
  planner: roleRoom(FOOTPRINTS.planner),
  developer: roleRoom(FOOTPRINTS.developer),
  qa: roleRoom(FOOTPRINTS.qa),
  reviewer: roleRoom(FOOTPRINTS.reviewer),
  "security-reviewer": roleRoom(FOOTPRINTS["security-reviewer"]),
};

export const GATE_ROOM: GateRoomLayout = (() => {
  const f = FOOTPRINTS.gate;
  const at = (ru: number, rv: number): UV => ({ u: f.u0 + ru, v: f.v0 + rv });
  return {
    commander: { ...at(3.6, 2.7), du: 1.4, dv: 0.9, h: 0.75 },
    ready: { ...at(2.3, 1.3), du: 0.8, dv: 0.6, h: 0.65 },
    release: [0.75, 1.5, 2.25, 3.0].map((rv) => ({ ...at(0.45, rv), du: 0.5, dv: 0.55, h: 0.6 })),
    plant: at(4.55, 3.55),
  };
})();

// ---- hulls, depth and boxes -----------------------------------------------------------------------

/** The screen outline of a box on the floor with height h: a convex hexagon. */
export function boxHull(f: Footprint, h: number, base = 0): Point[] {
  return [iso(f.u0, f.v1, h), iso(f.u0, f.v0, h), iso(f.u1, f.v0, h), iso(f.u1, f.v0, base), iso(f.u1, f.v1, base), iso(f.u0, f.v1, base)];
}

export function roomHull(id: OfficeRoomId): Point[] {
  return boxHull(FOOTPRINTS[id], WALL_H);
}

export function coreHull(): Point[] {
  return boxHull(CORE_FOOTPRINT, CORE.h);
}

/** The top face of a footprint at height z (back, right, front, left corners). */
export function facePoly(f: Footprint, z: number): Point[] {
  return [iso(f.u0, f.v0, z), iso(f.u1, f.v0, z), iso(f.u1, f.v1, z), iso(f.u0, f.v1, z)];
}

export function footprintOf(p: Prop): Footprint {
  return { u0: p.u - p.du / 2, u1: p.u + p.du / 2, v0: p.v - p.dv / 2, v1: p.v + p.dv / 2 };
}

export function points(ps: readonly Point[]): string {
  return ps.map((p) => `${round(p.x)},${round(p.y)}`).join(" ");
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Separating-axis test of two convex polygons; `margin` world units of clearance count as overlap. */
export function polygonsIntersect(a: readonly Point[], b: readonly Point[], margin = 0): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i] as Point;
      const q = poly[(i + 1) % poly.length] as Point;
      const ax = { x: -(q.y - p.y), y: q.x - p.x };
      const n = Math.hypot(ax.x, ax.y);
      if (n === 0) continue;
      const span = (ps: readonly Point[]) => {
        let min = Infinity;
        let max = -Infinity;
        for (const s of ps) {
          const d = (s.x * ax.x + s.y * ax.y) / n;
          min = Math.min(min, d);
          max = Math.max(max, d);
        }
        return { min, max };
      };
      const sa = span(a);
      const sb = span(b);
      if (sa.max + margin <= sb.min || sb.max + margin <= sa.min) return false;
    }
  }
  return true;
}

export function boxPoly(b: Box): Point[] {
  return [
    { x: b.x, y: b.y },
    { x: b.x + b.w, y: b.y },
    { x: b.x + b.w, y: b.y + b.h },
    { x: b.x, y: b.y + b.h },
  ];
}

export interface DepthItem {
  id: string;
  fp: Footprint;
  hull: readonly Point[];
}

/** True when `a` is drawn before `b`: it lies wholly on the far side of b along u or v and their outlines overlap. */
export function isBehind(a: DepthItem, b: DepthItem): boolean {
  return (a.fp.u1 <= b.fp.u0 || a.fp.v1 <= b.fp.v0) && polygonsIntersect(a.hull, b.hull);
}

/** Back-to-front order: a topological (Kahn) sort over "is behind", ties broken by (u0 + v0, id). */
export function depthOrder<T extends DepthItem>(items: readonly T[]): T[] {
  const key = (t: T) => t.fp.u0 + t.fp.v0;
  const cmp = (a: T, b: T) => key(a) - key(b) || a.id.localeCompare(b.id);
  const indeg = new Map<T, number>(items.map((t) => [t, 0]));
  const after = new Map<T, T[]>(items.map((t) => [t, []]));
  for (const a of items) {
    for (const b of items) {
      if (a !== b && isBehind(a, b)) {
        after.get(a)?.push(b);
        indeg.set(b, (indeg.get(b) ?? 0) + 1);
      }
    }
  }
  const out: T[] = [];
  const ready = items.filter((t) => indeg.get(t) === 0).sort(cmp);
  while (ready.length > 0) {
    const t = ready.shift() as T;
    out.push(t);
    for (const b of after.get(t) ?? []) {
      const n = (indeg.get(b) ?? 0) - 1;
      indeg.set(b, n);
      if (n === 0) {
        ready.push(b);
        ready.sort(cmp);
      }
    }
  }
  // a cycle cannot happen with disjoint footprints; anything left is appended in tie order
  return out.length === items.length ? out : [...out, ...items.filter((t) => !out.includes(t)).sort(cmp)];
}

/** Items inside a room, back to front: by u + v, then z. */
export function sortRoomItems<T extends UV & { z?: number }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.u + a.v - (b.u + b.v) || (a.z ?? 0) - (b.z ?? 0));
}

// ---- cards ------------------------------------------------------------------------------------------

/** Room cards are wide enough for a label and a whole verdict on one line, with one spare line for a long value. */
export const CARD_W = 232;
export const CARD_H = 98;
export const GATE_CARD_W = 272;
export const GATE_CARD_H = 115;
export const ALERT_H = 46;

export type CardId = OfficeRoomId | "core" | "gate-alert";

/**
 * Card positions (top-left corners), each on the outer side of its room, away from the core: the connections,
 * the ring the walkers take round the core and the plan corridor stay uncovered. The core's caption is a sign
 * at the top centre, above the plan corridor. Tuned constants, checked by tests/unit/ui-office-layout.test.ts.
 */
const CARD_AT: Record<OfficeRoomId, Point> = {
  planner: { x: 108, y: 148 },
  developer: { x: 860, y: 148 },
  qa: { x: 940, y: 464 },
  reviewer: { x: 706, y: 588 },
  "security-reviewer": { x: 306, y: 588 },
  gate: { x: 24, y: 482 },
};

export function labelBox(id: CardId): Box {
  if (id === "core") return { x: OX - 56, y: 144, w: 112, h: 44 };
  if (id === "gate-alert") {
    const g = labelBox("gate");
    return { x: g.x, y: g.y + g.h + 4, w: g.w, h: ALERT_H };
  }
  const at = CARD_AT[id];
  return id === "gate" ? { ...at, w: GATE_CARD_W, h: GATE_CARD_H } : { ...at, w: CARD_W, h: CARD_H };
}

export const CARD_IDS: readonly CardId[] = [...OFFICE_ROOM_IDS, "core", "gate-alert"];

/** The reduced-motion handoff chip of a room: two lines above its back walls, clear of its desk and of every card. */
export const CHIP_W = 194;
export const CHIP_H = 40;
export function chipBox(id: OfficeRoomId): Box {
  const h = roomHull(id);
  const top = Math.min(...h.map((p) => p.y));
  const cx = h.reduce((n, p) => n + p.x, 0) / h.length;
  return { x: cx - CHIP_W / 2, y: top - CHIP_H - 6, w: CHIP_W, h: CHIP_H };
}

// ---- connections --------------------------------------------------------------------------------

function angleOf(p: UV): number {
  return Math.atan2(p.v - CORE.v, p.u - CORE.u);
}

function onCircle(angle: number, r: number): UV {
  return { u: CORE.u + r * Math.cos(angle), v: CORE.v + r * Math.sin(angle) };
}

/** Points on the circle of radius r around the core from angle a0 to a1, the short way, at most 15° apart. */
function arc(a0: number, a1: number, r: number): UV[] {
  let d = a1 - a0;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(d) / (Math.PI / 12)));
  return Array.from({ length: n + 1 }, (_, i) => onCircle(a0 + (d * i) / n, r));
}

/** A door point moved `by` tiles sideways along its face (perpendicular to the way to the core). */
function lane(p: UV, by: number): UV {
  const a = angleOf(p) + Math.PI / 2;
  return { u: p.u + by * Math.cos(a), v: p.v + by * Math.sin(a) };
}

const LANE = 0.35;

/** The floor polyline of each connection, in tiles. */
export const EDGE_ROUTES: Record<EdgeId, UV[]> = (() => {
  const d = DOORS;
  const rim = (p: UV, r = RIM_R) => onCircle(angleOf(p), r);
  const commander = GATE_ROOM.commander;
  const ready = GATE_ROOM.ready;
  return {
    E1: [rim(d.planner), d.planner],
    E2: [d.planner, d.developer],
    E3: [d.developer, rim(d.developer)],
    E4: [rim(d.qa), d.qa],
    E5: [rim(d.reviewer), d.reviewer],
    E6: [rim(d["security-reviewer"]), d["security-reviewer"]],
    E7: [lane(d.qa, -LANE), SYNTHESIS_AT],
    E8: [lane(d.reviewer, LANE), SYNTHESIS_AT],
    E9: [lane(d["security-reviewer"], -LANE), SYNTHESIS_AT],
    E10: [SYNTHESIS_AT, d.gate],
    E11: [{ u: ready.u + ready.du / 2, v: ready.v }, { u: commander.u - commander.du / 2, v: commander.v }],
    E12: [SYNTHESIS_AT, ...arc(angleOf(SYNTHESIS_AT), angleOf(d.developer), SYNTH_R + 0.1), lane(d.developer, -LANE)],
  };
})();

function dist(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function angleDeg(a: Point, b: Point): number {
  return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
}

/** Resamples a polyline into `n + 1` points evenly spaced by arc length. */
function resample(pts: readonly Point[], n: number): Point[] {
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) cum.push((cum[i - 1] as number) + dist(pts[i - 1] as Point, pts[i] as Point));
  const total = cum[cum.length - 1] as number;
  const out: Point[] = [];
  let j = 0;
  for (let i = 0; i <= n; i++) {
    const target = (total * i) / n;
    while (j < cum.length - 2 && (cum[j + 1] as number) < target) j++;
    const a = pts[j] as Point;
    const b = (pts[j + 1] ?? a) as Point;
    const seg = (cum[j + 1] ?? 0) - (cum[j] as number);
    const t = seg <= 0 ? 0 : (target - (cum[j] as number)) / seg;
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return out;
}

export function pathOf(pts: readonly Point[]): string {
  return pts.map((p, i) => `${i === 0 ? "M" : "L"} ${round(p.x)} ${round(p.y)}`).join(" ");
}

/** The chevron sits this far (world units) before the end of a connection. */
const TIP_BACK = 10;

/** Connections whose route runs inside a room: drawn above that room's floor (after the rooms), not under it. */
export const EDGES_INSIDE_ROOMS: readonly EdgeId[] = ["E11"];

/** The box a connection's mid glyph takes (BLOCKED, FAILED, ? marks, the lock); E12's FIX LOOP label runs to the right. */
export function glyphBox(id: EdgeId, p: Point): Box {
  return { x: p.x - 12, y: p.y - 12, w: id === "E12" ? 104 : 24, h: 24 };
}

/** True when a glyph box is clear of every card, every room it is not drawn above, and the core. */
function glyphClear(id: EdgeId, b: Box): boolean {
  const poly = boxPoly(b);
  if (CARD_IDS.some((c) => polygonsIntersect(poly, boxPoly(labelBox(c)), 2))) return false;
  if (!EDGES_INSIDE_ROOMS.includes(id) && OFFICE_ROOM_IDS.some((r) => polygonsIntersect(poly, roomHull(r)))) return false;
  return !polygonsIntersect(poly, coreHull());
}

/** The sample nearest the half-way point whose glyph box is clear (the half-way point itself when nothing is clear). */
function glyphAnchor(id: EdgeId, samples: readonly Point[]): Point {
  const half = SAMPLES / 2;
  const order = samples.map((_, i) => i).filter((i) => i >= 6 && i <= SAMPLES - 6).sort((a, b) => Math.abs(a - half) - Math.abs(b - half) || a - b);
  const i = order.find((k) => glyphClear(id, glyphBox(id, samples[k] as Point)));
  return samples[i ?? half] as Point;
}

function officeEdgeGeometry(id: EdgeId): EdgeGeometry {
  const def = EDGE_BY_ID[id];
  const pts = EDGE_ROUTES[id].map((p) => iso(p.u, p.v));
  const samples = resample(pts, SAMPLES);
  let length = 0;
  for (let i = 1; i < samples.length; i++) length += dist(samples[i - 1] as Point, samples[i] as Point);
  const first = samples[0] as Point;
  const last = samples[samples.length - 1] as Point;
  let tipIndex = samples.length - 1;
  while (tipIndex > 1 && dist(samples[tipIndex] as Point, last) < TIP_BACK) tipIndex--;
  const tip = samples[tipIndex] as Point;
  const before = samples[tipIndex - 1] as Point;
  const mid = glyphAnchor(id, samples);
  return {
    id,
    from: def.from,
    to: def.to,
    x1: first.x,
    y1: first.y,
    x2: last.x,
    y2: last.y,
    path: pathOf(pts),
    length,
    angle: angleDeg(first, samples[1] as Point),
    samples,
    mid,
    tip,
    tipAngle: angleDeg(before, tip),
  };
}

export const OFFICE_EDGE_GEOMETRY: Record<EdgeId, EdgeGeometry> = Object.fromEntries(
  (Object.keys(EDGE_ROUTES) as EdgeId[]).map((id) => [id, officeEdgeGeometry(id)]),
) as Record<EdgeId, EdgeGeometry>;

// ---- walk corridors -----------------------------------------------------------------------------

export type WalkOrigin = Role | "core" | "synthesis";
export type WalkDest = Role | "gate";

/**
 * The floor points of a walk: origin door → round the core → destination door. Planner → developer takes the
 * E2 corridor; synthesis → developer (a fix round) takes the E12 fix loop to the BUILD door.
 */
export function walkRoute(origin: WalkOrigin, dest: WalkDest): UV[] {
  const to = DOORS[dest];
  if (origin === "planner" && dest === "developer") return EDGE_ROUTES.E2;
  if (origin === "synthesis" && dest === "developer") return [...EDGE_ROUTES.E12.slice(0, -1), to];
  if (origin === "synthesis") return [SYNTHESIS_AT, onCircle(angleOf(to), WALK_R), to];
  if (origin === "core") return [onCircle(angleOf(to), WALK_R), to];
  const from = DOORS[origin];
  return [from, ...arc(angleOf(from), angleOf(to), WALK_R), to];
}

export function walkPoints(origin: WalkOrigin, dest: WalkDest): Point[] {
  return walkRoute(origin, dest).map((p) => iso(p.u, p.v));
}

/** The SVG path a walker follows (an offset-path, in world units). */
export function walkPath(origin: WalkOrigin, dest: WalkDest): string {
  return pathOf(walkPoints(origin, dest));
}

// ---- core particles -------------------------------------------------------------------------------

/** Radius of the particle disc around the core's centre, world units. */
export const CLOUD_R = 34;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/** Up to 24 deterministic golden-angle points inside the core's particle disc, as offsets from its centre. */
export function coreParticles(n: number): Point[] {
  const count = Math.max(0, Math.min(24, Math.floor(n)));
  return Array.from({ length: count }, (_, i) => {
    const r = CLOUD_R * Math.sqrt((i + 0.5) / count);
    const a = i * GOLDEN;
    return { x: r * Math.cos(a), y: r * Math.sin(a) };
  });
}
