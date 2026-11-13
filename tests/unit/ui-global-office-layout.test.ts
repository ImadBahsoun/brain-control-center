import { describe, expect, it } from "vitest";
import type { Point } from "@/lib/ui/layout";
import { boxPoly, CORE, CORE_FOOTPRINT, coreHull, depthOrder, footprintOf, FOOTPRINTS, GRID, iso, isBehind, OFFICE_ROOM_IDS, OFFICE_WORLD, polygonsIntersect, RIM_R, WALK_R, type DepthItem, type Footprint, type UV } from "@/lib/ui/office-layout";
import {
  doorFace,
  figureBox,
  figurePoint,
  GLOBAL_CARD_IDS,
  GLOBAL_CORE_LINES,
  GLOBAL_DESKS,
  GLOBAL_DOORS,
  GLOBAL_FLOOR_PATHS,
  GLOBAL_FOOTPRINTS,
  GLOBAL_QUEUE_CAP,
  GLOBAL_SEAT_CAP,
  globalCardBox,
  globalRoomHull,
  globalSeats,
  globalWalkPath,
  globalWalkRoute,
  LINE_LABEL_CHARS,
  LINE_LABEL_W,
  LINE_PLATE_FALLBACK,
  linePlates,
  OVERFLOW_W,
  overflowBox,
  plateAt,
  plateWidth,
  queueSpots,
  queueTagSide,
  seatHitBox,
  TAG_H,
  TAG_W,
  tagBox,
  type GlobalWalkEnd,
} from "@/lib/ui/global-office-layout";
import { lineLabels } from "@/lib/ui/global-office";
import { ROLES, type Role } from "@/lib/ui/roles";

type P = Point;
type Poly = readonly P[];
const near = (a: P, b: P, eps = 1e-6) => Math.hypot(a.x - b.x, a.y - b.y) < eps;
const isoOf = (p: UV) => iso(p.u, p.v);
const centre = (f: Footprint): UV => ({ u: (f.u0 + f.u1) / 2, v: (f.v0 + f.v1) / 2 });

function inside(p: UV, f: Footprint, margin = 0): boolean {
  return p.u >= f.u0 + margin && p.u <= f.u1 - margin && p.v >= f.v0 + margin && p.v <= f.v1 - margin;
}

/** Footprints are at least `gap` tiles apart along u or v. */
function apart(a: Footprint, b: Footprint, gap: number): boolean {
  return a.u1 + gap <= b.u0 || b.u1 + gap <= a.u0 || a.v1 + gap <= b.v0 || b.v1 + gap <= a.v0;
}

/** Every corner of `inner` lies inside the convex polygon `hull` (screen coordinates, either winding). */
function insideConvex(inner: Poly, hull: Poly): boolean {
  return inner.every((p) => {
    let sign = 0;
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i] as P;
      const b = hull[(i + 1) % hull.length] as P;
      const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
      if (cross === 0) continue;
      if (sign === 0) sign = Math.sign(cross);
      else if (Math.sign(cross) !== sign) return false;
    }
    return true;
  });
}

/** The largest margin at which polygonsIntersect still calls two shapes apart (world units), for failure messages. */
function clearance(a: Poly, b: Poly): number {
  let lo = -200;
  let hi = 200;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (polygonsIntersect(a, b, mid)) hi = mid;
    else lo = mid;
  }
  return lo;
}

const inWorld = (poly: Poly) => poly.every((p) => p.x >= 0 && p.y >= 0 && p.x <= OFFICE_WORLD.width && p.y <= OFFICE_WORLD.height);
const cards = GLOBAL_CARD_IDS.map((c) => [c, boxPoly(globalCardBox(c))] as const);

/** Every problem of `poly` against the cards, the rooms (its own too when asked), the core and the world's edge. */
function sceneProblems(poly: Poly, own: string, what: string, ownRoomToo: boolean): string[] {
  const out: string[] = [];
  for (const [c, card] of cards) if (polygonsIntersect(poly, card, 2)) out.push(`${what} / card ${c}: clearance ${clearance(poly, card).toFixed(2)}`);
  for (const room of OFFICE_ROOM_IDS) if ((ownRoomToo || room !== own) && polygonsIntersect(poly, globalRoomHull(room), 2)) out.push(`${what} / room ${room}: clearance ${clearance(poly, globalRoomHull(room)).toFixed(2)}`);
  if (polygonsIntersect(poly, coreHull(), 2)) out.push(`${what} / core: clearance ${clearance(poly, coreHull()).toFixed(2)}`);
  if (!inWorld(poly)) out.push(`${what} outside the world`);
  return out;
}

const seatFigures = (r: Role, n: number) => globalSeats(r, n).map((s) => boxPoly(figureBox(figurePoint(s, "seated"), "seated")));
const queueBoxes = (r: Role, n: number) =>
  queueSpots(r, n).flatMap((s, i) => {
    const p = figurePoint(s, "standing");
    return [[`q${i} figure`, boxPoly(figureBox(p, "standing"))] as const, [`q${i} tag`, boxPoly(tagBox(p, "standing", queueTagSide(r)))] as const];
  });

describe("global footprints", () => {
  it("lie inside the floor diamond, clear of the back window walls by half a tile; the gate keeps its Mission footprint", () => {
    for (const id of OFFICE_ROOM_IDS) {
      const f = GLOBAL_FOOTPRINTS[id];
      expect(f.u0, id).toBeGreaterThanOrEqual(0.5);
      expect(f.v0, id).toBeGreaterThanOrEqual(0.5);
      expect(f.u1, id).toBeLessThanOrEqual(GRID - 0.5);
      expect(f.v1, id).toBeLessThanOrEqual(GRID - 0.5);
    }
    expect(GLOBAL_FOOTPRINTS.gate).toEqual(FOOTPRINTS.gate);
    // larger open-plan role rooms: 5 × 4.5 tiles
    for (const r of ROLES) {
      const f = GLOBAL_FOOTPRINTS[r];
      expect([f.u1 - f.u0, f.v1 - f.v0].sort(), r).toEqual([4.5, 5]);
    }
  });
  it("keep at least half a tile between rooms, and stay outside the core and the walk ring round it", () => {
    for (const a of OFFICE_ROOM_IDS) {
      expect(apart(GLOBAL_FOOTPRINTS[a], CORE_FOOTPRINT, 1), `${a} / core`).toBe(true);
      const f = GLOBAL_FOOTPRINTS[a];
      // the footprint's nearest point to the core's centre is outside the walk ring, with half a tile to spare
      const nu = Math.max(f.u0, Math.min(CORE.u, f.u1));
      const nv = Math.max(f.v0, Math.min(CORE.v, f.v1));
      expect(Math.hypot(nu - CORE.u, nv - CORE.v), `${a} / walk ring`).toBeGreaterThan(WALK_R + 0.5);
      for (const b of OFFICE_ROOM_IDS) if (a < b) expect(apart(GLOBAL_FOOTPRINTS[a], GLOBAL_FOOTPRINTS[b], 0.5), `${a} / ${b}`).toBe(true);
    }
  });
  it("draw rooms and the core without overlapping outlines, in a deterministic depth order", () => {
    const items: DepthItem[] = [...OFFICE_ROOM_IDS.map((id) => ({ id, fp: GLOBAL_FOOTPRINTS[id], hull: globalRoomHull(id) })), { id: "core", fp: CORE_FOOTPRINT, hull: coreHull() }];
    for (const a of items) for (const b of items) if (a.id < b.id) expect(polygonsIntersect(a.hull, b.hull, 4), `${a.id} / ${b.id}: clearance ${clearance(a.hull, b.hull).toFixed(2)}`).toBe(false);
    const order = depthOrder(items).map((i) => i.id);
    for (const a of items) for (const b of items) if (a !== b && isBehind(a, b)) expect(order.indexOf(a.id)).toBeLessThan(order.indexOf(b.id));
    expect(depthOrder([...items].reverse()).map((i) => i.id)).toEqual(order);
  });
  it("go round the core clockwise in pipeline order", () => {
    const c = iso(CORE.u, CORE.v);
    const angle = (id: (typeof OFFICE_ROOM_IDS)[number]) => {
      const p = isoOf(centre(GLOBAL_FOOTPRINTS[id]));
      return (Math.atan2(p.x - c.x, -(p.y - c.y)) + 2 * Math.PI) % (2 * Math.PI);
    };
    const angles = OFFICE_ROOM_IDS.map(angle);
    const rel = angles.map((a) => (a - (angles[0] as number) + 2 * Math.PI) % (2 * Math.PI));
    for (let i = 1; i < rel.length; i++) expect(rel[i] as number, OFFICE_ROOM_IDS[i]).toBeGreaterThan(rel[i - 1] as number);
  });
  it("put each door on its room's face toward the core", () => {
    for (const id of OFFICE_ROOM_IDS) {
      const f = GLOBAL_FOOTPRINTS[id];
      const d = GLOBAL_DOORS[id];
      expect(d.u === f.u0 || d.u === f.u1 || d.v === f.v0 || d.v === f.v1, id).toBe(true);
      expect(inside(d, f), id).toBe(true);
      const c = centre(f);
      expect(Math.hypot(d.u - CORE.u, d.v - CORE.v), id).toBeLessThan(Math.hypot(c.u - CORE.u, c.v - CORE.v));
    }
    // back walls for QUALITY, REVIEW and SECURITY (their queues stand behind them), front glass for PLANNING and BUILD
    expect(ROLES.map((r) => doorFace(r))).toEqual(["u1", "v1", "u0", "u0", "v0"]);
  });
});

describe("global desks", () => {
  it("gives every role room six desks in two rows of three, each with a monitor and a chair, inside the room", () => {
    for (const r of ROLES) {
      const f = GLOBAL_FOOTPRINTS[r];
      const desks = GLOBAL_DESKS[r];
      expect(desks, r).toHaveLength(GLOBAL_SEAT_CAP);
      expect(GLOBAL_SEAT_CAP).toBe(6);
      for (const [i, d] of desks.entries()) {
        for (const p of [d.desk, d.monitor, d.chair]) {
          const b = footprintOf(p);
          expect(inside({ u: b.u0, v: b.v0 }, f, 0.1) && inside({ u: b.u1, v: b.v1 }, f, 0.1), `${r} desk ${i}`).toBe(true);
        }
        expect(inside(d.seat, f, 0.3), `${r} seat ${i}`).toBe(true);
        // the chair behind the seat, the seat behind the desk, the monitor on the desk and drawn after it
        expect(d.chair.u + d.chair.v, `${r} chair ${i}`).toBeLessThan(d.seat.u + d.seat.v);
        expect(d.seat.u + d.seat.v, `${r} seat ${i}`).toBeLessThan(d.desk.u + d.desk.v);
        const desk = footprintOf(d.desk);
        expect(inside(d.monitor, desk), `${r} monitor ${i} on its desk`).toBe(true);
        expect(d.monitor.u + d.monitor.v, `${r} monitor ${i}`).toBeGreaterThan(d.desk.u + d.desk.v);
      }
      // two rows of three: two distinct distances from the back, three desks each
      const rowsAlongU = f.u1 - f.u0 >= f.v1 - f.v0;
      const across = new Set(desks.map((d) => (rowsAlongU ? d.desk.v : d.desk.u)));
      expect(across.size, r).toBe(2);
      // front row first
      const first = rowsAlongU ? (desks[0] as (typeof desks)[number]).desk.v : (desks[0] as (typeof desks)[number]).desk.u;
      expect(first, r).toBe(Math.max(...across));
    }
  });
  it("keeps the desks, chairs and monitors of a room apart from each other", () => {
    const overlap = (a: Footprint, b: Footprint) => a.u0 < b.u1 && b.u0 < a.u1 && a.v0 < b.v1 && b.v0 < a.v1;
    for (const r of ROLES) {
      const props = GLOBAL_DESKS[r].flatMap((d, i) => [[`desk ${i}`, footprintOf(d.desk)], [`chair ${i}`, footprintOf(d.chair)]] as const);
      for (let i = 0; i < props.length; i++) for (let j = i + 1; j < props.length; j++) expect(overlap((props[i] as (typeof props)[number])[1], (props[j] as (typeof props)[number])[1]), `${r} ${props[i]?.[0]} / ${props[j]?.[0]}`).toBe(false);
    }
  });
});

describe("global figures, queue spots and the +k marker", () => {
  it("gives n seats up to the cap, front row first", () => {
    for (const r of ROLES) {
      expect(globalSeats(r, 0)).toEqual([]);
      expect(globalSeats(r, GLOBAL_SEAT_CAP + 4)).toHaveLength(GLOBAL_SEAT_CAP);
      expect(globalSeats(r, 3)).toEqual(GLOBAL_DESKS[r].slice(0, 3).map((d) => d.seat));
    }
  });
  it("keeps every seated figure inside its room and apart from the others, at every count, clear of cards, other rooms and the core", () => {
    const problems: string[] = [];
    for (const r of ROLES) {
      for (let n = 1; n <= GLOBAL_SEAT_CAP; n++) {
        const boxes = seatFigures(r, n);
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (polygonsIntersect(boxes[i] as Poly, boxes[j] as Poly, 2)) problems.push(`${r} ${n} seats: s${i} / s${j}: clearance ${clearance(boxes[i] as Poly, boxes[j] as Poly).toFixed(2)}`);
        for (const [i, b] of boxes.entries()) {
          if (!insideConvex(b, globalRoomHull(r))) problems.push(`${r} ${n} seats: s${i} outside its room`);
          problems.push(...sceneProblems(b, r, `${r} ${n} seats: s${i}`, false));
        }
      }
    }
    expect(problems).toEqual([]);
  });
  it("gives each seated figure a pointer target at least as large as its figure box, apart from its neighbours'", () => {
    for (const r of ROLES) {
      const pts = globalSeats(r, GLOBAL_SEAT_CAP).map((s) => figurePoint(s, "seated"));
      const hits = pts.map((p) => seatHitBox(p));
      for (const [i, p] of pts.entries()) {
        const f = figureBox(p, "seated");
        const h = hits[i] as (typeof hits)[number];
        expect(h.x <= f.x && h.y <= f.y && h.x + h.w >= f.x + f.w && h.y + h.h >= f.y + f.h, `${r} s${i}`).toBe(true);
      }
      for (let i = 0; i < hits.length; i++) for (let j = i + 1; j < hits.length; j++) expect(polygonsIntersect(boxPoly(hits[i] as never), boxPoly(hits[j] as never)), `${r} hit s${i} / s${j}`).toBe(false);
    }
  });
  it("keeps a seated figure's hover tag inside the world and fits a mission tag and the widest marker", () => {
    for (const r of ROLES) for (const s of globalSeats(r, GLOBAL_SEAT_CAP)) expect(inWorld(boxPoly(tagBox(figurePoint(s, "seated"), "seated"))), r).toBe(true);
    expect("#0000".length * 9.4 + 10).toBeLessThanOrEqual(TAG_W);
    expect("+999".length * 9.4 + 10).toBeLessThanOrEqual(OVERFLOW_W);
  });
  it("lines queued figures up outside the door, apart from each other, the full seats and the marker, clear of cards, other rooms and the core", () => {
    const problems: string[] = [];
    for (const r of ROLES) {
      expect(queueSpots(r, 0)).toEqual([]);
      expect(queueSpots(r, GLOBAL_QUEUE_CAP + 3)).toHaveLength(GLOBAL_QUEUE_CAP);
      const spots = queueSpots(r, GLOBAL_QUEUE_CAP);
      for (const s of spots) expect(inside(s, GLOBAL_FOOTPRINTS[r]), `${r} queue spot outside the room`).toBe(false);
      const gap = (s: UV) => Math.hypot(s.u - GLOBAL_DOORS[r].u, s.v - GLOBAL_DOORS[r].v);
      for (let i = 1; i < spots.length; i++) expect(gap(spots[i] as UV)).toBeGreaterThan(gap(spots[i - 1] as UV));
      for (let n = 1; n <= GLOBAL_QUEUE_CAP; n++) {
        const q = queueBoxes(r, n);
        const others = [...q, ...seatFigures(r, GLOBAL_SEAT_CAP).map((b, i) => [`s${i}`, b] as const), ["marker", boxPoly(overflowBox(r))] as const];
        for (let i = 0; i < others.length; i++)
          for (let j = i + 1; j < others.length; j++) {
            const [a, pa] = others[i] as (typeof others)[number];
            const [b, pb] = others[j] as (typeof others)[number];
            if (!a.startsWith("q") && !b.startsWith("q")) continue;
            if (polygonsIntersect(pa, pb, 2)) problems.push(`${r} queue ${n}: ${a} / ${b}: clearance ${clearance(pa, pb).toFixed(2)}`);
          }
        for (const [l, b] of q) problems.push(...sceneProblems(b, r, `${r} queue ${n}: ${l}`, false));
      }
    }
    expect(problems).toEqual([]);
  });
  it("keeps BUILD's and SECURITY's queue at least 6 world units from their own seated figures at every count", () => {
    const MARGIN = 6;
    const problems: string[] = [];
    for (const r of ["developer", "security-reviewer"] as const) {
      for (const [ql, q] of queueBoxes(r, GLOBAL_QUEUE_CAP)) {
        for (let n = 1; n <= GLOBAL_SEAT_CAP; n++) {
          for (const [i, s] of seatFigures(r, n).entries()) if (polygonsIntersect(q, s, MARGIN)) problems.push(`${r} ${ql} / ${n} seats s${i}: clearance ${clearance(q, s).toFixed(2)}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
  it("keeps every room's queue at least 6 world units from its own +k marker and from the core", () => {
    const MARGIN = 6;
    const problems: string[] = [];
    for (const r of ROLES) {
      const marker = boxPoly(overflowBox(r));
      for (const [ql, q] of queueBoxes(r, GLOBAL_QUEUE_CAP)) {
        if (polygonsIntersect(q, marker, MARGIN)) problems.push(`${r} ${ql} / marker: clearance ${clearance(q, marker).toFixed(2)}`);
        if (polygonsIntersect(q, coreHull(), MARGIN)) problems.push(`${r} ${ql} / core: clearance ${clearance(q, coreHull()).toFixed(2)}`);
      }
    }
    expect(problems).toEqual([]);
  });
  it("keeps PLANNING's and BUILD's queue tags (front-glass doors, tags below the feet) off their own room: no tag over its glass or desks", () => {
    expect(ROLES.map((r) => queueTagSide(r))).toEqual(["below", "below", "above", "above", "above"]);
    const problems: string[] = [];
    for (const r of ["planner", "developer"] as const) {
      // only the tags: a queued figure stands in front of the glass, so its body may overlap the room's outline
      for (const [ql, q] of queueBoxes(r, GLOBAL_QUEUE_CAP)) if (ql.endsWith("tag") && polygonsIntersect(q, globalRoomHull(r), 2)) problems.push(`${r} ${ql} / own room: clearance ${clearance(q, globalRoomHull(r)).toFixed(2)}`);
    }
    expect(problems).toEqual([]);
  });
  it("stands every queue spot nearer its own door and its own core line than any other room's (the gate's included)", () => {
    const dist = (a: UV, b: UV) => Math.hypot(a.u - b.u, a.v - b.v);
    /** Floor distance from p to the segment core rim → the room's door (the gate's floor path for the gate). */
    const toLine = (p: UV, id: (typeof OFFICE_ROOM_IDS)[number]) => {
      const d = GLOBAL_DOORS[id];
      const len = dist(d, CORE);
      const a = { u: CORE.u + (RIM_R * (d.u - CORE.u)) / len, v: CORE.v + (RIM_R * (d.v - CORE.v)) / len };
      const l2 = (d.u - a.u) ** 2 + (d.v - a.v) ** 2;
      const t = Math.max(0, Math.min(1, ((p.u - a.u) * (d.u - a.u) + (p.v - a.v) * (d.v - a.v)) / l2));
      return dist(p, { u: a.u + t * (d.u - a.u), v: a.v + t * (d.v - a.v) });
    };
    const problems: string[] = [];
    for (const r of ROLES) {
      for (const [i, s] of queueSpots(r, GLOBAL_QUEUE_CAP).entries()) {
        const ownDoor = dist(s, GLOBAL_DOORS[r]);
        const ownLine = toLine(s, r);
        for (const other of OFFICE_ROOM_IDS) {
          if (other === r) continue;
          const door = dist(s, GLOBAL_DOORS[other]);
          const line = toLine(s, other);
          if (door <= ownDoor) problems.push(`${r} q${i}: door ${other} ${door.toFixed(2)} ≤ own ${ownDoor.toFixed(2)}`);
          if (line <= ownLine) problems.push(`${r} q${i}: line ${other} ${line.toFixed(2)} ≤ own ${ownLine.toFixed(2)}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
  it("keeps every queued figure off the walk ring band round the core: no walker path crosses a queued figure", () => {
    // on the floor: a standing figure (half a tile) clear of the band WALK_R ± 0.3 tiles that walkers follow
    const BAND = 0.3;
    const FIGURE = 0.5;
    const problems: string[] = [];
    for (const r of ROLES) {
      for (const [i, s] of queueSpots(r, GLOBAL_QUEUE_CAP).entries()) {
        const d = Math.hypot(s.u - CORE.u, s.v - CORE.v);
        if (d < WALK_R + BAND + FIGURE) problems.push(`${r} q${i}: ${d.toFixed(2)} tiles from the core, band edge + figure ${(WALK_R + BAND + FIGURE).toFixed(2)}`);
      }
    }
    // on screen: no queued figure's box touches the ring walkers' feet follow, nor its inner or outer edge
    const ring = (rr: number) => Array.from({ length: 73 }, (_, k) => iso(CORE.u + rr * Math.cos((k * Math.PI) / 36), CORE.v + rr * Math.sin((k * Math.PI) / 36)));
    for (const rr of [WALK_R - BAND, WALK_R, WALK_R + BAND]) {
      const pts = ring(rr);
      for (const r of ROLES)
        for (const [ql, q] of queueBoxes(r, GLOBAL_QUEUE_CAP)) {
          if (!ql.endsWith("figure")) continue;
          for (let k = 1; k < pts.length; k++) if (polygonsIntersect(q, [pts[k - 1] as P, pts[k] as P], 2)) problems.push(`${r} ${ql} / ring ${rr.toFixed(1)} at ${k * 5}°`);
        }
    }
    expect(problems).toEqual([]);
  });
  it("keeps every queue a legible gap from the core", () => {
    // 9 world px: REVIEW's and SECURITY's tags (unchanged) measure 9.90; PLANNING's and BUILD's below-the-feet tags at
    // most ~12 within 1.5 tiles of the door while clear of their own seats (40 is not reachable there)
    const GAP = 9;
    const problems: string[] = [];
    for (const r of ROLES) for (const [ql, q] of queueBoxes(r, GLOBAL_QUEUE_CAP)) if (polygonsIntersect(q, coreHull(), GAP)) problems.push(`${r} ${ql} / core: clearance ${clearance(q, coreHull()).toFixed(2)}`);
    expect(problems).toEqual([]);
  });
  it("keeps every room's full queue apart from every other room's queue, seats and marker, all at once", () => {
    const all = ROLES.flatMap((r) => [
      ...queueBoxes(r, GLOBAL_QUEUE_CAP).map(([l, b]) => [`${r} queue ${l}`, b] as const),
      ...seatFigures(r, GLOBAL_SEAT_CAP).map((b, i) => [`${r} seat s${i}`, b] as const),
      [`${r} marker`, boxPoly(overflowBox(r))] as const,
    ]);
    const problems: string[] = [];
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++) {
        const [a, pa] = all[i] as (typeof all)[number];
        const [b, pb] = all[j] as (typeof all)[number];
        if (!a.includes("queue") && !b.includes("queue")) continue;
        if (polygonsIntersect(pa, pb, 2)) problems.push(`${a} / ${b}: clearance ${clearance(pa, pb).toFixed(2)}`);
      }
    expect(problems).toEqual([]);
  });
  it("puts the +k marker inside its room, clear of the full seats, cards, other rooms and the core", () => {
    const problems: string[] = [];
    for (const r of ROLES) {
      const marker = boxPoly(overflowBox(r));
      if (!insideConvex(marker, globalRoomHull(r))) problems.push(`${r} marker outside its room`);
      for (const [i, s] of seatFigures(r, GLOBAL_SEAT_CAP).entries()) if (polygonsIntersect(marker, s, 2)) problems.push(`${r} marker / s${i}: clearance ${clearance(marker, s).toFixed(2)}`);
      problems.push(...sceneProblems(marker, r, `${r} marker`, false));
    }
    expect(problems).toEqual([]);
  });
});

describe("global cards", () => {
  it("keeps every card inside the world, apart from the others, every room and the core", () => {
    const problems: string[] = [];
    for (const [id, poly] of cards) {
      if (!inWorld(poly)) problems.push(`${id} outside the world`);
      for (const [other, op] of cards) if (other < id && polygonsIntersect(poly, op, 4)) problems.push(`${id} / ${other}: clearance ${clearance(poly, op).toFixed(2)}`);
      for (const room of OFFICE_ROOM_IDS) if (polygonsIntersect(poly, globalRoomHull(room), 4)) problems.push(`${id} / room ${room}: clearance ${clearance(poly, globalRoomHull(room)).toFixed(2)}`);
      if (polygonsIntersect(poly, coreHull(), 4)) problems.push(`${id} / core`);
    }
    expect(problems).toEqual([]);
  });
  it("puts each room's card beside its room, on the side away from the core", () => {
    const c = iso(CORE.u, CORE.v);
    const far = (p: P) => Math.hypot(p.x - c.x, (p.y - c.y) * 2);
    for (const id of OFFICE_ROOM_IDS) {
      const b = globalCardBox(id);
      expect(polygonsIntersect(boxPoly(b), globalRoomHull(id), 22), `${id} next to its room: clearance ${clearance(boxPoly(b), globalRoomHull(id)).toFixed(2)}`).toBe(true);
      expect(far({ x: b.x + b.w / 2, y: b.y + b.h / 2 }), id).toBeGreaterThan(far(isoOf(centre(GLOBAL_FOOTPRINTS[id]))));
    }
  });
});

describe("global floor paths, activity lines and walks", () => {
  const rimToward = (d: UV) => {
    const a = Math.atan2(d.v - CORE.v, d.u - CORE.u);
    return iso(CORE.u + RIM_R * Math.cos(a), CORE.v + RIM_R * Math.sin(a));
  };
  const ends = (path: string): [P, P] => {
    const nums = [...path.matchAll(/-?[\d.]+/g)].map((m) => Number(m[0]));
    return [
      { x: nums[0] as number, y: nums[1] as number },
      { x: nums[nums.length - 2] as number, y: nums[nums.length - 1] as number },
    ];
  };
  it("runs a straight activity line from the core's rim to each role room's door, crossing no other room", () => {
    for (const r of ROLES) {
      const l = GLOBAL_CORE_LINES[r];
      const a = l.samples[0] as P;
      const z = l.samples[l.samples.length - 1] as P;
      expect(l.samples, r).toHaveLength(49);
      expect(near(a, rimToward(GLOBAL_DOORS[r]), 0.02), `${r} starts on the rim`).toBe(true);
      expect(near(z, isoOf(GLOBAL_DOORS[r]), 0.02), `${r} ends at its door`).toBe(true);
      expect(l.length, r).toBeCloseTo(Math.hypot(z.x - a.x, z.y - a.y), 6);
      for (const room of OFFICE_ROOM_IDS) if (room !== r) expect(polygonsIntersect([a, z], globalRoomHull(room)), `${r} line / room ${room}`).toBe(false);
    }
  });
  it("draws a faint floor path from the core's rim to every door, the gate's too, crossing no other room", () => {
    expect(Object.keys(GLOBAL_FLOOR_PATHS).sort()).toEqual([...OFFICE_ROOM_IDS].sort());
    for (const id of OFFICE_ROOM_IDS) {
      const [a, z] = ends(GLOBAL_FLOOR_PATHS[id]);
      expect(near(a, rimToward(GLOBAL_DOORS[id]), 0.02), `${id} starts on the rim`).toBe(true);
      expect(near(z, isoOf(GLOBAL_DOORS[id]), 0.02), `${id} ends at its door`).toBe(true);
      for (const room of OFFICE_ROOM_IDS) if (room !== id) expect(polygonsIntersect([a, z], globalRoomHull(room)), `${id} path / room ${room}`).toBe(false);
    }
    // the role rooms' paths lie under their activity lines
    for (const r of ROLES) expect(GLOBAL_FLOOR_PATHS[r]).toBe(GLOBAL_CORE_LINES[r].path);
  });
  const routes: Array<[GlobalWalkEnd, GlobalWalkEnd]> = [];
  for (const o of [...ROLES, "core"] as const) for (const d of [...ROLES, "core"] as const) if (o !== d) routes.push([o, d]);
  it("walks from door to door round the core outside its plinth, crossing no room but its own ends", () => {
    for (const [o, d] of routes) {
      const route = globalWalkRoute(o, d);
      const pts = route.map(isoOf);
      expect(globalWalkPath(o, d).startsWith("M "), `${o}→${d}`).toBe(true);
      if (o !== "core") expect(near(pts[0] as P, isoOf(GLOBAL_DOORS[o])), `${o}→${d} start`).toBe(true);
      if (d !== "core") expect(near(pts[pts.length - 1] as P, isoOf(GLOBAL_DOORS[d])), `${o}→${d} end`).toBe(true);
      for (const p of route) expect(Math.hypot(p.u - CORE.u, p.v - CORE.v), `${o}→${d}`).toBeGreaterThan(CORE.r * Math.SQRT2);
      // every segment clear of every room, except the first (leaving the origin's door) and the last (reaching the destination's)
      for (let i = 1; i < pts.length; i++) {
        const seg = [pts[i - 1] as P, pts[i] as P];
        for (const room of OFFICE_ROOM_IDS) {
          const ownEnd = (i === 1 && room === o) || (i === pts.length - 1 && room === d);
          if (!ownEnd) expect(polygonsIntersect(seg, globalRoomHull(room)), `${o}→${d} segment ${i} / room ${room}`).toBe(false);
        }
      }
    }
  });
  it("keeps the walking token (figure and tag) outside every card for at least 85% of each walk", () => {
    for (const [o, d] of routes) {
      const pts = globalWalkRoute(o, d).map(isoOf);
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push((cum[i - 1] as number) + Math.hypot((pts[i] as P).x - (pts[i - 1] as P).x, (pts[i] as P).y - (pts[i - 1] as P).y));
      const total = cum[cum.length - 1] as number;
      let hidden = 0;
      for (let k = 0; k <= 50; k++) {
        const t = (total * k) / 50;
        let j = 0;
        while (j < cum.length - 2 && (cum[j + 1] as number) < t) j++;
        const a = pts[j] as P;
        const b = pts[j + 1] as P;
        const seg = (cum[j + 1] as number) - (cum[j] as number);
        const f = seg <= 0 ? 0 : (t - (cum[j] as number)) / seg;
        const p = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
        const token = boxPoly({ x: p.x - 31, y: p.y - 56, w: 62, h: 60 });
        if (cards.some(([, card]) => polygonsIntersect(token, card))) hidden++;
      }
      expect(hidden / 51, `${o}→${d}: hidden at ${hidden} of 51 samples`).toBeLessThanOrEqual(0.15);
    }
  });
});

describe("global activity line plates", () => {
  type Drawn = { seated: number; waiting: number; marker: boolean };
  const NONE: Drawn = { seated: 0, waiting: 0, marker: false };
  const everywhere = (d: Drawn) => Object.fromEntries(ROLES.map((r) => [r, d])) as Record<Role, Drawn>;
  const segDist = (p: P, a: P, b: P) => {
    const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2));
    return Math.hypot(p.x - (a.x + t * (b.x - a.x)), p.y - (a.y + t * (b.y - a.y)));
  };
  const lineEnds = (r: Role) => {
    const s = GLOBAL_CORE_LINES[r].samples;
    return [s[0] as P, s[s.length - 1] as P] as const;
  };
  /** Every figure, queued tag and marker box drawn for these counts, by name (seated tags show on hover only). */
  const drawnBoxes = (drawn: Partial<Record<Role, Drawn>>) =>
    ROLES.flatMap((r) => {
      const d = drawn[r] ?? NONE;
      return [
        ...seatFigures(r, d.seated).map((b, i) => [`${r} seat ${i} figure`, b] as const),
        ...queueBoxes(r, d.waiting).map(([l, b]) => [`${r} ${l}`, b] as const),
        ...(d.marker ? [[`${r} marker`, boxPoly(overflowBox(r))] as const] : []),
      ];
    });
  const fixedScene: Array<readonly [string, Poly]> = [...OFFICE_ROOM_IDS.map((id) => [`room ${id}`, globalRoomHull(id)] as const), ...cards.map(([c, b]) => [`card ${c}`, b] as const), ["core", coreHull()] as const];
  /** The model's label variants for a line whose full label has `chars` characters (5: one mission, 11: two, 15: two and +99). */
  const labelsOf = (chars: number): string[] => lineLabels(Array.from({ length: chars <= 5 ? 1 : chars <= 11 ? 2 : 101 }, (_, i) => `#${String(i + 1).padStart(4, "0")}`));
  const expectClear = (lineSet: Array<{ role: Role; chars: number }>, drawn: Partial<Record<Role, Drawn>>, what: string) => {
    const plates = linePlates(
      lineSet.map(({ role, chars }) => ({ role, labels: labelsOf(chars) })),
      drawn,
    );
    const scene = [...fixedScene, ...drawnBoxes(drawn)];
    const problems: string[] = [];
    for (const { role, chars } of lineSet) {
      const placed = plates[role];
      if (!placed) {
        problems.push(`${role} has no plate`);
        continue;
      }
      if (!labelsOf(chars).includes(placed.label)) problems.push(`${role} shows "${placed.label}", not one of its labels`);
      if (Math.abs(placed.box.w - plateWidth(placed.label.length)) > 1e-6 || placed.box.h !== TAG_H) problems.push(`${role} plate is ${placed.box.w}×${placed.box.h}`);
      const plate = boxPoly(placed.box);
      if (!inWorld(plate)) problems.push(`${role} plate outside the world`);
      const others = lineSet.flatMap((o) => {
        const other = plates[o.role];
        return o.role !== role && other ? [[`${o.role} plate`, boxPoly(other.box)] as const] : [];
      });
      for (const [name, poly] of [...scene, ...others]) if (polygonsIntersect(plate, poly, 2)) problems.push(`${role} plate / ${name}: clearance ${clearance(plate, poly).toFixed(2)}`);
    }
    expect(problems, what).toEqual([]);
  };

  it("sizes a plate for its label at the tag text size (15 px, 9.4 per character), up to the widest label", () => {
    expect("#0000 #0000 +99".length).toBe(LINE_LABEL_CHARS);
    expect(LINE_LABEL_W).toBe(LINE_LABEL_CHARS * 9.4 + 10);
    expect(plateWidth(5)).toBeCloseTo(57, 6);
    expect(plateWidth(5)).toBeLessThanOrEqual(TAG_W);
    expect(plateWidth(40)).toBe(LINE_LABEL_W);
    const p = linePlates([{ role: "planner", labels: ["#0001"] }], {});
    expect(p.planner).toMatchObject({ label: "#0001", box: { w: plateWidth(5), h: TAG_H } });
  });
  it("keeps every plate clear with all five rooms active at once, the widest labels, and every seat, queue spot and marker drawn", () => {
    expectClear(
      ROLES.map((role) => ({ role, chars: LINE_LABEL_CHARS })),
      everywhere({ seated: GLOBAL_SEAT_CAP, waiting: GLOBAL_QUEUE_CAP, marker: true }),
      "worst case",
    );
  });
  it("keeps every fallback place clear at the widest label: all five lines, every seat, queue spot and marker drawn, and each other", () => {
    const scene = [...fixedScene, ...drawnBoxes(everywhere({ seated: GLOBAL_SEAT_CAP, waiting: GLOBAL_QUEUE_CAP, marker: true }))];
    const widest = "#".repeat(LINE_LABEL_CHARS);
    const plates = ROLES.map((r) => [r, boxPoly(plateAt(LINE_PLATE_FALLBACK[r], widest))] as const);
    const problems: string[] = [];
    for (const [r, plate] of plates) {
      if (!inWorld(plate)) problems.push(`${r} fallback outside the world`);
      for (const [name, poly] of scene) if (polygonsIntersect(plate, poly, 2)) problems.push(`${r} fallback / ${name}: clearance ${clearance(plate, poly).toFixed(2)}`);
      for (const [o, other] of plates) if (o !== r && polygonsIntersect(plate, other, 2)) problems.push(`${r} fallback / ${o} fallback: clearance ${clearance(plate, other).toFixed(2)}`);
    }
    expect(problems).toEqual([]);
  });
  it("keeps every plate clear for any set of active rooms, label widths and drawn counts", () => {
    const patterns: Drawn[] = [NONE, { seated: 1, waiting: 0, marker: false }, { seated: 0, waiting: 1, marker: false }, { seated: 3, waiting: 2, marker: false }, { seated: GLOBAL_SEAT_CAP, waiting: GLOBAL_QUEUE_CAP, marker: true }];
    for (let mask = 1; mask < 1 << ROLES.length; mask++) {
      const active = ROLES.filter((_, i) => mask & (1 << i));
      for (const [k, chars] of [5, 15].entries()) {
        for (const [j, pattern] of patterns.entries()) {
          expectClear(
            active.map((role) => ({ role, chars })),
            everywhere(pattern),
            `rooms ${active.join(",")} · ${chars} chars · pattern ${j}`,
          );
          const mixed = Object.fromEntries(ROLES.map((r, i) => [r, patterns[(i + j + k) % patterns.length] as Drawn]));
          expectClear(
            active.map((role, i) => ({ role, chars: [5, 11, 15][(i + k) % 3] as number })),
            mixed,
            `rooms ${active.join(",")} · mixed ${j}/${k}`,
          );
        }
      }
    }
  });
  it("puts each plate on its own line in the usual cases", () => {
    const run1: Drawn = { seated: 1, waiting: 0, marker: false };
    const run2: Drawn = { seated: 2, waiting: 0, marker: false };
    const q1: Drawn = { seated: 0, waiting: 1, marker: false };
    const run1q1: Drawn = { seated: 1, waiting: 1, marker: false };
    const VALIDATOR_ROOMS = ["qa", "reviewer", "security-reviewer"] as const;
    const cases: Array<[string, Array<[Role, number]>, Partial<Record<Role, Drawn>>]> = [
      ["one mission running in every room", ROLES.map((r) => [r, 5]), everywhere(run1)],
      ["two missions running in every room", ROLES.map((r) => [r, 11]), everywhere(run2)],
      ["a build running, a validation launch queued", [["developer", 5], ...VALIDATOR_ROOMS.map((r) => [r, 5] as [Role, number])], { developer: run1, qa: q1, reviewer: q1, "security-reviewer": q1 }],
      ["one mission validating, another queued for validation", VALIDATOR_ROOMS.map((r) => [r, 11]), { qa: run1q1, reviewer: run1q1, "security-reviewer": run1q1 }],
    ];
    for (const [what, active, drawn] of cases) {
      const plates = linePlates(
        active.map(([role, chars]) => ({ role, labels: labelsOf(chars) })),
        drawn,
      );
      const got = active.map(([r]) => {
        const p = plates[r];
        const [a, z] = lineEnds(r);
        return [r, p ? segDist({ x: p.box.x + p.box.w / 2, y: p.box.y + p.box.h / 2 }, a, z) : Infinity, p ? polygonsIntersect(boxPoly(p.box), [a, z]) : false, p?.label ?? "none"] as const;
      });
      const msg = got.map(([r, dd, , label]) => `${r} "${label}" ${dd.toFixed(1)}`).join("; ");
      for (const [r, , through] of got) expect(through, `${what}: ${r} plate off its line; label, centre to line: ${msg}`).toBe(true);
    }
  });
});
