// World geometry of the Global Office (every open mission): the Mission Office's 24-tile floor, core and gate
// room, with five larger open-plan role rooms, six desks each, compact cards, faint floor paths from the core to
// every door, the activity lines, their plates and the corridors mission tokens walk. Pure, deterministic,
// unit-tested (tests/unit/ui-global-office-layout.test.ts).
//
// The six desks of a room are seats, not capacity: the governor's limits are on the room's card (n/m busy), and a
// desk only ever holds a figure for a recorded agent instance (src/lib/ui/global-office.ts). Each room's desks
// stand in two rows of three along its longer side, figures facing the front glass; queued figures stand in a
// line on the corridor by the door (see QUEUE_LINE), and a "+k" marker on the room's corner counts the rest (the
// roster lists them).
import { SAMPLES, type Box, type Point } from "./layout";
import {
  boxHull,
  boxPoly,
  CORE,
  coreHull,
  doorOf,
  FOOTPRINTS,
  GATE_CARD_W,
  iso,
  OFFICE_ROOM_IDS,
  OFFICE_WORLD,
  pathOf,
  polygonsIntersect,
  RIM_R,
  SLAB_H,
  WALK_R,
  WALL_H,
  type Footprint,
  type OfficeRoomId,
  type Prop,
  type UV,
} from "./office-layout";
import { ROLES, type Role } from "./roles";

/** The role rooms (5 × 4.5 tiles) clockwise from the upper left; the gate keeps its Mission Office footprint. */
export const GLOBAL_FOOTPRINTS: Record<OfficeRoomId, Footprint> = {
  planner: { u0: 0.8, u1: 5.8, v0: 7, v1: 11.5 },
  developer: { u0: 7, u1: 11.5, v0: 0.8, v1: 5.8 },
  qa: { u0: 17.8, u1: 22.8, v0: 2, v1: 6.5 },
  reviewer: { u0: 19, u1: 23.5, v0: 12, v1: 17 },
  "security-reviewer": { u0: 12, u1: 17, v0: 19, v1: 23.5 },
  gate: FOOTPRINTS.gate,
};

export const GLOBAL_DOORS: Record<OfficeRoomId, UV> = Object.fromEntries(OFFICE_ROOM_IDS.map((id) => [id, doorOf(GLOBAL_FOOTPRINTS[id])])) as Record<OfficeRoomId, UV>;

export function globalRoomHull(id: OfficeRoomId): Point[] {
  return boxHull(GLOBAL_FOOTPRINTS[id], WALL_H);
}

/** The face a room's door is on: u0 and v0 are its back walls, u1 and v1 its front glass. */
export function doorFace(id: OfficeRoomId): "u0" | "u1" | "v0" | "v1" {
  const f = GLOBAL_FOOTPRINTS[id];
  const d = GLOBAL_DOORS[id];
  if (d.u === f.u0) return "u0";
  if (d.u === f.u1) return "u1";
  return d.v === f.v0 ? "v0" : "v1";
}

// ---- desks ----------------------------------------------------------------------------------------

/** One desk: the desk, its monitor (dark, decor), its chair and where a figure sits (behind the desk). */
export interface GlobalDesk {
  desk: Prop;
  monitor: Prop;
  chair: Prop;
  seat: UV;
}

/** Desks per role room: seats for drawing, not capacity; instances beyond them are in the "+k" marker and the roster. */
export const GLOBAL_SEAT_CAP = 6;
/** Queued figures drawn per role room's door; the rest are in the "+k" marker and the roster. */
export const GLOBAL_QUEUE_CAP = 2;
/** Desk centres along a room's longer side (tiles from its back end): a 1.4-tile seat pitch. */
const DESK_COLS = [1.5, 2.9, 4.3] as const;
/** Seat rows across the room (tiles from its back wall), front row first: 2.3 tiles apart. */
const SEAT_ROWS = [3.1, 0.8] as const;
/** The desk stands this far in front of its seat (the figure faces the front glass). */
const DESK_AHEAD = 0.75;

/** True when a room's rows run along u (it is longer along u); otherwise they run along v. */
function rowsAlongU(f: Footprint): boolean {
  return f.u1 - f.u0 >= f.v1 - f.v0;
}

function desksOf(f: Footprint): GlobalDesk[] {
  const alongU = rowsAlongU(f);
  // a: along the rows, b: across them (toward the front glass)
  const at = (a: number, b: number): UV => (alongU ? { u: f.u0 + a, v: f.v0 + b } : { u: f.u0 + b, v: f.v0 + a });
  const prop = (a: number, b: number, da: number, db: number, h: number): Prop => ({ ...at(a, b), du: alongU ? da : db, dv: alongU ? db : da, h });
  return SEAT_ROWS.flatMap((sb) =>
    DESK_COLS.map((a) => {
      const db = sb + DESK_AHEAD;
      return {
        desk: prop(a, db, 1.1, 0.7, 0.7),
        // on the desk's back edge, a little along the row, so it is drawn after the desk (larger u + v)
        monitor: prop(a + 0.3, db - 0.15, 0.55, 0.1, 0.42),
        chair: prop(a, sb - 0.3, 0.55, 0.5, 0.45),
        seat: at(a, sb),
      };
    }),
  );
}

/** Six desks per role room, front row first (the first instances sit nearest the viewer). */
export const GLOBAL_DESKS: Record<Role, GlobalDesk[]> = Object.fromEntries(ROLES.map((r) => [r, desksOf(GLOBAL_FOOTPRINTS[r])])) as Record<Role, GlobalDesk[]>;

// ---- figures, tags, queue and marker ---------------------------------------------------------------

/** A mission tag plate: "#0007" at 15 px (9.4 world units per character) plus padding. */
export const TAG_W = 57;
export const TAG_H = 21;
/** The "+k" overflow marker plate (up to "+999"). */
export const OVERFLOW_W = 48;

export type GlobalPosture = "seated" | "standing";

/**
 * Each role room's queue line on the corridor: the first spot's offset from the door and the step to the next spot
 * (tiles). Every spot is outside the room, nearer its own door and its own activity line than any other room's, off
 * the walk ring, and clear of the core, the other rooms, every card and the other queues when every room queues at
 * once. PLANNING and BUILD (front-glass doors): the first spot stands just outside the glass about 1.3 tiles from
 * the door, beside the activity line on the side away from the other front-glass room and clear of the room's own
 * seated figures, the second about 2.2 tiles further along the glass; their tags hang below the feet (queueTagSide).
 * QUALITY, REVIEW and SECURITY (back-wall doors):
 * the line stands on the corridor behind the wall, tags above the heads. Tuned constants, checked by
 * tests/unit/ui-global-office-layout.test.ts.
 */
const QUEUE_LINE: Record<Role, { first: UV; step: UV }> = {
  planner: { first: { u: 0.85, v: 1 }, step: { u: 0.15, v: 2.15 } },
  developer: { first: { u: 1, v: 0.85 }, step: { u: 2.15, v: 0.35 } },
  qa: { first: { u: -1, v: -1.2 }, step: { u: -1.7, v: 0.9 } },
  reviewer: { first: { u: -2, v: -1.6 }, step: { u: 0, v: -2 } },
  "security-reviewer": { first: { u: -1.6, v: -2 }, step: { u: -2, v: 0 } },
};

/** Floor points of the first `n` seats (at most GLOBAL_SEAT_CAP), front row first. */
export function globalSeats(role: Role, n: number): UV[] {
  const k = Math.max(0, Math.min(GLOBAL_SEAT_CAP, Math.floor(n)));
  return GLOBAL_DESKS[role].slice(0, k).map((d) => d.seat);
}

/** Floor points of `n` queue spots (at most GLOBAL_QUEUE_CAP) on the corridor by the door (QUEUE_LINE), in a line away from it. */
export function queueSpots(role: Role, n: number): UV[] {
  const d = GLOBAL_DOORS[role];
  const { first, step } = QUEUE_LINE[role];
  const k = Math.max(0, Math.min(GLOBAL_QUEUE_CAP, Math.floor(n)));
  return Array.from({ length: k }, (_, i) => ({ u: d.u + first.u + step.u * i, v: d.v + first.v + step.v * i }));
}

/** Where a figure stands on screen: seated figures on the room's slab, queued ones on the corridor floor. */
export function figurePoint(at: UV, posture: GlobalPosture): Point {
  return iso(at.u, at.v, posture === "seated" ? SLAB_H : 0);
}

/** A figure's screen box (body, head, shadow and the monitor glow), without its tag. */
export function figureBox(p: Point, posture: GlobalPosture): Box {
  const top = posture === "seated" ? 37 : 42;
  return { x: p.x - 10, y: p.y - top, w: 27, h: top + 5 };
}

/** A seated figure's pointer target: its figure box padded toward the seat pitch (never smaller), apart from its neighbours'. */
export function seatHitBox(p: Point): Box {
  return { x: p.x - 16, y: p.y - 39, w: 33, h: 44 };
}

/**
 * A figure's mission tag: just above its head (a seated figure's only while it is hovered or focused), or, for a
 * figure queued at a front-glass door, just below its feet so it never covers the room behind it.
 */
export function tagBox(p: Point, posture: GlobalPosture, side: "above" | "below" = "above"): Box {
  if (side === "below") return { x: p.x - TAG_W / 2, y: p.y + 7, w: TAG_W, h: TAG_H };
  const bottom = posture === "seated" ? 39 : 44;
  return { x: p.x - TAG_W / 2, y: p.y - bottom - TAG_H, w: TAG_W, h: TAG_H };
}

/** Where a queued figure's tag hangs: below the feet at a front-glass door (PLANNING, BUILD), above the head otherwise. */
export function queueTagSide(role: Role): "above" | "below" {
  const face = doorFace(role);
  return face === "u1" || face === "v1" ? "below" : "above";
}

/** The "+k" marker of a role room: on the room's corner at the start of its rows, beside the front row's first figure. */
export function overflowBox(role: Role): Box {
  const f = GLOBAL_FOOTPRINTS[role];
  if (rowsAlongU(f)) {
    const c = iso(f.u0, f.v1);
    return { x: c.x + 2, y: c.y - 34, w: OVERFLOW_W, h: TAG_H };
  }
  const c = iso(f.u1, f.v0);
  return { x: c.x - 2 - OVERFLOW_W, y: c.y - 34, w: OVERFLOW_W, h: TAG_H };
}

// ---- cards ------------------------------------------------------------------------------------------

/** Compact room cards: the title and "n/m busy", then two metric rows. */
export const GLOBAL_CARD_W = 232;
export const GLOBAL_CARD_H = 70;
export const GLOBAL_GATE_CARD_W = GATE_CARD_W;
export const GLOBAL_CORE_CARD_W = 132;
export const GLOBAL_CORE_CARD_H = 50;

export type GlobalCardId = OfficeRoomId | "core";
export const GLOBAL_CARD_IDS: readonly GlobalCardId[] = [...OFFICE_ROOM_IDS, "core"];

/** Card positions (top-left corners), each on the outer side of its room; the core's caption at the top centre. */
const CARD_AT: Record<GlobalCardId, Point> = {
  planner: { x: 100, y: 148 },
  developer: { x: 868, y: 148 },
  qa: { x: 940, y: 470 },
  reviewer: { x: 700, y: 604 },
  "security-reviewer": { x: 306, y: 604 },
  gate: { x: 24, y: 482 },
  core: { x: 534, y: 124 },
};

export function globalCardBox(id: GlobalCardId): Box {
  const at = CARD_AT[id];
  if (id === "core") return { ...at, w: GLOBAL_CORE_CARD_W, h: GLOBAL_CORE_CARD_H };
  return { ...at, w: id === "gate" ? GLOBAL_GATE_CARD_W : GLOBAL_CARD_W, h: GLOBAL_CARD_H };
}

// ---- floor paths and activity lines -------------------------------------------------------------------

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

export interface CoreLine {
  role: Role;
  /** SAMPLES + 1 evenly spaced screen points from the core's rim to the room's door. */
  samples: Point[];
  path: string;
  length: number;
}

function straightLine(to: UV): { samples: Point[]; path: string; length: number } {
  const from = onCircle(angleOf(to), RIM_R);
  const a = iso(from.u, from.v);
  const z = iso(to.u, to.v);
  const samples = Array.from({ length: SAMPLES + 1 }, (_, i) => ({ x: a.x + ((z.x - a.x) * i) / SAMPLES, y: a.y + ((z.y - a.y) * i) / SAMPLES }));
  return { samples, path: pathOf([a, z]), length: Math.hypot(z.x - a.x, z.y - a.y) };
}

/** Each role room's activity line: straight from the core's rim to its door. */
export const GLOBAL_CORE_LINES: Record<Role, CoreLine> = Object.fromEntries(ROLES.map((r) => [r, { role: r, ...straightLine(GLOBAL_DOORS[r]) }])) as Record<Role, CoreLine>;

/** The faint floor paths (decor): the same core rim → door lines for every room, the gate's too. */
export const GLOBAL_FLOOR_PATHS: Record<OfficeRoomId, string> = Object.fromEntries(OFFICE_ROOM_IDS.map((id) => [id, straightLine(GLOBAL_DOORS[id]).path])) as Record<OfficeRoomId, string>;

// ---- walks ----------------------------------------------------------------------------------------

export type GlobalWalkEnd = Role | "core";

/**
 * The floor points of a mission token's walk: a room's door → round the core at WALK_R → another room's door; from
 * the core it starts on the walk ring, to the core it ends there.
 */
export function globalWalkRoute(origin: GlobalWalkEnd, dest: GlobalWalkEnd): UV[] {
  if (origin === "core" && dest === "core") return [];
  if (origin === "core") {
    const to = GLOBAL_DOORS[dest as Role];
    return [onCircle(angleOf(to), WALK_R), to];
  }
  const from = GLOBAL_DOORS[origin];
  if (dest === "core") return [from, onCircle(angleOf(from), WALK_R)];
  const to = GLOBAL_DOORS[dest];
  return [from, ...arc(angleOf(from), angleOf(to), WALK_R), to];
}

/** The SVG path a walker follows (an offset-path, in world units). */
export function globalWalkPath(origin: GlobalWalkEnd, dest: GlobalWalkEnd): string {
  return pathOf(globalWalkRoute(origin, dest).map((p) => iso(p.u, p.v)));
}

// ---- activity line plates ---------------------------------------------------------------------------
//
// A plate walks its line's samples middle-out; at each sample it tries its label variants longest first, each with
// small offsets across the line that still cross the plate, and takes the first place clear of every room, card,
// the core, the drawn figure, tag, marker and queue boxes and the earlier plates. A plate that finds none takes
// its fixed fallback place with its shortest label when that is clear; else every plate takes its own (checked
// clear in the worst case by the layout test).

/** The widest line plate: "#0000 #0000 +99" at the tag text size (15 px, 9.4 world units per character) plus padding. */
export const LINE_LABEL_CHARS = 15;
export const LINE_LABEL_W = LINE_LABEL_CHARS * 9.4 + 10;
/** World units of clearance a placed plate keeps (the layout test checks 2). */
const LINE_LABEL_CLEAR = 3;
/** Offsets across the line tried at each sample (world units along its normal); the line must still cross the plate. */
const ACROSS = [0, -5, 5, -10, 10, -15, 15, -20, 20, -25, 25, -30, 30];

/** Each plate's fallback centre: tuned constants, checked clear at the widest label in the worst case by the layout test. */
export const LINE_PLATE_FALLBACK: Record<Role, Point> = {
  planner: { x: 225, y: 250 },
  developer: { x: 975, y: 250 },
  qa: { x: 1040, y: 570 },
  reviewer: { x: 600, y: 570 },
  "security-reviewer": { x: 160, y: 580 },
};

/** What a role room draws: its seated figures, the queued figures at its door, and whether its "+k" marker shows. */
export interface GlobalDrawn {
  seated: number;
  waiting: number;
  marker: boolean;
}

/** The figure, queued tag and marker boxes a role room draws for these counts (seated tags show on hover only). */
export function globalDrawnBoxes(role: Role, d: GlobalDrawn): Box[] {
  const seats = globalSeats(role, d.seated).map((s) => figurePoint(s, "seated"));
  const queue = queueSpots(role, d.waiting).map((s) => figurePoint(s, "standing"));
  return [...seats.map((p) => figureBox(p, "seated")), ...queue.flatMap((p) => [figureBox(p, "standing"), tagBox(p, "standing", queueTagSide(role))]), ...(d.marker ? [overflowBox(role)] : [])];
}

/** A plate's width for a label of `chars` characters, never wider than the widest plate. */
export function plateWidth(chars: number): number {
  return Math.min(LINE_LABEL_W, Math.max(1, chars) * 9.4 + 10);
}

/** The plate of a label centred at `c`. */
export function plateAt(c: Point, label: string): Box {
  const w = plateWidth(label.length);
  return { x: c.x - w / 2, y: c.y - TAG_H / 2, w, h: TAG_H };
}

/** A drawn line's plate request: its role and its label variants, longest first. */
export interface LinePlate {
  role: Role;
  labels: readonly string[];
}

/** A placed plate and the label variant it shows. */
export interface PlacedPlate {
  box: Box;
  label: string;
}

function fallbackPlate(l: LinePlate): PlacedPlate {
  const label = l.labels[l.labels.length - 1] ?? "";
  return { box: plateAt(LINE_PLATE_FALLBACK[l.role], label), label };
}

/** The fixed obstacles of the Global Office: every room, every card and the core. */
export function globalSceneObstacles(): Point[][] {
  return [...OFFICE_ROOM_IDS.map(globalRoomHull), ...GLOBAL_CARD_IDS.map((c) => boxPoly(globalCardBox(c))), coreHull()];
}

/** The plates of the drawn lines, in ROLES order (see the section comment). */
export function linePlates(lines: readonly LinePlate[], drawn: Partial<Record<Role, GlobalDrawn>>): Partial<Record<Role, PlacedPlate>> {
  const figures = ROLES.flatMap((r) => {
    const d = drawn[r];
    return d ? globalDrawnBoxes(r, d).map(boxPoly) : [];
  });
  const obstacles = [...globalSceneObstacles(), ...figures];
  // in the world and clear of every obstacle; a cheap side test first, as most obstacles are far from a plate
  const m = LINE_LABEL_CLEAR;
  const apart = (b: Box, o: Point[]) => o.every((p) => p.x < b.x - m) || o.every((p) => p.x > b.x + b.w + m) || o.every((p) => p.y < b.y - m) || o.every((p) => p.y > b.y + b.h + m);
  const clear = (b: Box) => b.x >= 0 && b.y >= 0 && b.x + b.w <= OFFICE_WORLD.width && b.y + b.h <= OFFICE_WORLD.height && obstacles.every((o) => apart(b, o) || !polygonsIntersect(boxPoly(b), o, m));
  const half = SAMPLES / 2;
  const order = Array.from({ length: SAMPLES + 1 }, (_, i) => i).sort((a, b) => Math.abs(a - half) - Math.abs(b - half) || a - b);
  const out: Partial<Record<Role, PlacedPlate>> = {};
  for (const r of ROLES) {
    const labels = lines.find((l) => l.role === r)?.labels;
    if (!labels) continue;
    const s = GLOBAL_CORE_LINES[r].samples;
    const a = s[0] as Point;
    const z = s[s.length - 1] as Point;
    const len = Math.hypot(z.x - a.x, z.y - a.y);
    const n = { x: -(z.y - a.y) / len, y: (z.x - a.x) / len };
    const place = (): PlacedPlate | null => {
      for (const i of order) {
        for (const label of labels) {
          for (const k of ACROSS) {
            const p = s[i] as Point;
            const box = plateAt({ x: p.x + k * n.x, y: p.y + k * n.y }, label);
            if (polygonsIntersect(boxPoly(box), [a, z]) && clear(box)) return { box, label };
          }
        }
      }
      return null;
    };
    // this plate at its fallback place when that is clear too; else every plate at its own (clear in the worst case)
    const placed = place() ?? fallbackPlate({ role: r, labels });
    if (!clear(placed.box)) return Object.fromEntries(lines.map((l) => [l.role, fallbackPlate(l)]));
    out[r] = placed;
    obstacles.push(boxPoly(placed.box));
  }
  return out;
}
