import { describe, expect, it } from "vitest";
import { EDGES, type EdgeId } from "@/lib/ui/layout";
import { ROLES } from "@/lib/ui/roles";
import {
  boxHull,
  boxPoly,
  CARD_IDS,
  CHIP_W,
  chipBox,
  CLOUD_R,
  CORE,
  CORE_FOOTPRINT,
  coreHull,
  coreParticles,
  depthOrder,
  DOORS,
  EDGE_ROUTES,
  FOOTPRINTS,
  EDGES_INSIDE_ROOMS,
  footprintOf,
  GATE_ROOM,
  glyphBox,
  GRID,
  iso,
  isBehind,
  labelBox,
  OFFICE_EDGE_GEOMETRY,
  OFFICE_ROOM_IDS,
  OFFICE_WORLD,
  OX,
  OY,
  polygonsIntersect,
  RIM_R,
  ROLE_ROOMS,
  roomHull,
  SLAB_H,
  sortRoomItems,
  SYNTHESIS_AT,
  TZ,
  walkPath,
  walkPoints,
  walkRoute,
  type CardId,
  type DepthItem,
  type Footprint,
  type UV,
  type WalkDest,
  type WalkOrigin,
} from "@/lib/ui/office-layout";

const near = (a: { x: number; y: number }, b: { x: number; y: number }, eps = 1e-6) => Math.hypot(a.x - b.x, a.y - b.y) < eps;
const isoOf = (p: UV) => iso(p.u, p.v);

/** Footprints are at least `gap` tiles apart along u or v. */
function apart(a: Footprint, b: Footprint, gap: number): boolean {
  return a.u1 + gap <= b.u0 || b.u1 + gap <= a.u0 || a.v1 + gap <= b.v0 || b.v1 + gap <= a.v0;
}

function inside(p: UV, f: Footprint, margin = 0): boolean {
  return p.u >= f.u0 + margin && p.u <= f.u1 - margin && p.v >= f.v0 + margin && p.v <= f.v1 - margin;
}

const depthItems = (): DepthItem[] => [...OFFICE_ROOM_IDS.map((id) => ({ id, fp: FOOTPRINTS[id], hull: roomHull(id) })), { id: "core", fp: CORE_FOOTPRINT, hull: coreHull() }];

describe("iso projection", () => {
  it("maps the origin to (OX, OY) and one tile along u, v and z to the 2:1 steps", () => {
    expect(iso(0, 0, 0)).toEqual({ x: OX, y: OY });
    const o = iso(0, 0);
    const du = iso(1, 0);
    const dv = iso(0, 1);
    expect({ x: du.x - o.x, y: du.y - o.y }).toEqual({ x: 24, y: 12 });
    expect({ x: dv.x - o.x, y: dv.y - o.y }).toEqual({ x: -24, y: 12 });
    expect(iso(0, 0, 1).y).toBe(OY - TZ);
  });
  it("puts the floor diamond inside the world", () => {
    for (const [u, v] of [
      [0, 0],
      [GRID, 0],
      [0, GRID],
      [GRID, GRID],
    ] as const) {
      const p = iso(u, v);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(OFFICE_WORLD.width);
      expect(p.y).toBeLessThanOrEqual(OFFICE_WORLD.height);
    }
  });
});

describe("footprints", () => {
  it("lie inside the grid, clear of the back window walls", () => {
    for (const id of OFFICE_ROOM_IDS) {
      const f = FOOTPRINTS[id];
      expect(f.u0, id).toBeGreaterThanOrEqual(1);
      expect(f.v0, id).toBeGreaterThanOrEqual(1);
      expect(f.u1, id).toBeLessThanOrEqual(GRID - 1);
      expect(f.v1, id).toBeLessThanOrEqual(GRID - 1);
    }
  });
  it("keep a corridor of at least one tile between rooms and around the core", () => {
    for (const a of OFFICE_ROOM_IDS) {
      expect(apart(FOOTPRINTS[a], CORE_FOOTPRINT, 1), `${a} / core`).toBe(true);
      for (const b of OFFICE_ROOM_IDS) if (a < b) expect(apart(FOOTPRINTS[a], FOOTPRINTS[b], 1), `${a} / ${b}`).toBe(true);
    }
  });
  it("draw rooms and the core without overlapping outlines", () => {
    const items = depthItems();
    for (const a of items) for (const b of items) if (a.id < b.id) expect(polygonsIntersect(a.hull, b.hull, 4), `${a.id} / ${b.id}`).toBe(false);
  });
  it("go round the core clockwise in pipeline order", () => {
    const c = iso(CORE.u, CORE.v);
    const angle = (id: (typeof OFFICE_ROOM_IDS)[number]) => {
      const f = FOOTPRINTS[id];
      const p = iso((f.u0 + f.u1) / 2, (f.v0 + f.v1) / 2);
      // screen angle, clockwise from straight up
      return (Math.atan2(p.x - c.x, -(p.y - c.y)) + 2 * Math.PI) % (2 * Math.PI);
    };
    const angles = OFFICE_ROOM_IDS.map(angle);
    // starting from the planner (upper left), each next room is further clockwise
    const rel = angles.map((a) => (a - (angles[0] as number) + 2 * Math.PI) % (2 * Math.PI));
    for (let i = 1; i < rel.length; i++) expect(rel[i] as number, OFFICE_ROOM_IDS[i]).toBeGreaterThan(rel[i - 1] as number);
  });
  it("put each door on its room's face toward the core", () => {
    for (const id of OFFICE_ROOM_IDS) {
      const f = FOOTPRINTS[id];
      const d = DOORS[id];
      const onFace = d.u === f.u0 || d.u === f.u1 || d.v === f.v0 || d.v === f.v1;
      expect(onFace, id).toBe(true);
      expect(inside(d, f), id).toBe(true);
      const c = { u: (f.u0 + f.u1) / 2, v: (f.v0 + f.v1) / 2 };
      // the door is closer to the core than the room's centre
      expect(Math.hypot(d.u - CORE.u, d.v - CORE.v), id).toBeLessThan(Math.hypot(c.u - CORE.u, c.v - CORE.v));
    }
  });
  it("keep the furniture inside its room; a seated figure sits behind its desk", () => {
    for (const r of ROLES) {
      const f = FOOTPRINTS[r];
      const room = ROLE_ROOMS[r];
      for (const p of [room.seat, room.stand, room.plant, room.desk, room.cabinet]) expect(inside(p, f, 0.2), r).toBe(true);
      const desk = footprintOf(room.desk);
      expect(inside({ u: desk.u0, v: desk.v0 }, f), r).toBe(true);
      expect(inside({ u: desk.u1, v: desk.v1 }, f), r).toBe(true);
      expect(room.seat.u + room.seat.v, r).toBeLessThan(room.desk.u + room.desk.v);
    }
    const g = FOOTPRINTS.gate;
    for (const p of [GATE_ROOM.commander, GATE_ROOM.ready, ...GATE_ROOM.release]) {
      const b = footprintOf(p);
      expect(inside({ u: b.u0, v: b.v0 }, g)).toBe(true);
      expect(inside({ u: b.u1, v: b.v1 }, g)).toBe(true);
    }
    expect(GATE_ROOM.release).toHaveLength(4);
  });
});

describe("depthOrder", () => {
  it("puts every item behind another before it, deterministically, whatever the input order", () => {
    const items = depthItems();
    const order = depthOrder(items).map((i) => i.id);
    expect(order).toHaveLength(items.length);
    expect(new Set(order).size).toBe(items.length);
    for (const a of items) for (const b of items) if (a !== b && isBehind(a, b)) expect(order.indexOf(a.id), `${a.id} before ${b.id}`).toBeLessThan(order.indexOf(b.id));
    expect(depthOrder([...items].reverse()).map((i) => i.id)).toEqual(order);
    expect(depthOrder([...items.slice(3), ...items.slice(0, 3)]).map((i) => i.id)).toEqual(order);
  });
  it("orders overlapping boxes by the far-side rule and breaks ties by (u0 + v0, id)", () => {
    const box = (id: string, fp: Footprint): DepthItem => ({ id, fp, hull: [iso(fp.u0, fp.v1, 3), iso(fp.u0, fp.v0, 3), iso(fp.u1, fp.v0, 3), iso(fp.u1, fp.v0), iso(fp.u1, fp.v1), iso(fp.u0, fp.v1)] });
    const back = box("b", { u0: 2, u1: 4, v0: 2, v1: 4 });
    const front = box("a", { u0: 4, u1: 6, v0: 3, v1: 5 }); // overlaps on screen, wholly at larger u
    expect(isBehind(back, front)).toBe(true);
    expect(depthOrder([front, back]).map((i) => i.id)).toEqual(["b", "a"]);
    const far = box("z", { u0: 0, u1: 1, v0: 20, v1: 21 });
    const other = box("y", { u0: 20, u1: 21, v0: 0, v1: 1 });
    expect(depthOrder([far, other]).map((i) => i.id)).toEqual(["y", "z"]); // no overlap: same u0 + v0, by id
  });
  it("sorts the items of a room by u + v, then z", () => {
    const sorted = sortRoomItems([
      { id: "desk", u: 3, v: 3 },
      { id: "figure", u: 2.5, v: 2.2 },
      { id: "lamp", u: 2, v: 3, z: 1 },
      { id: "rug", u: 2, v: 3, z: 0 },
    ]);
    expect(sorted.map((s) => s.id)).toEqual(["figure", "rug", "lamp", "desk"]);
  });
});

describe("labelBox", () => {
  const ids: CardId[] = [...OFFICE_ROOM_IDS, "core", "gate-alert"];
  it("keeps every card inside the world", () => {
    for (const id of ids) {
      const b = labelBox(id);
      expect(b.x, id).toBeGreaterThanOrEqual(0);
      expect(b.y, id).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w, id).toBeLessThanOrEqual(OFFICE_WORLD.width);
      expect(b.y + b.h, id).toBeLessThanOrEqual(OFFICE_WORLD.height);
    }
  });
  it("overlaps no other card, no room and the core", () => {
    for (const id of ids) {
      const poly = boxPoly(labelBox(id));
      for (const other of ids) if (other < id) expect(polygonsIntersect(poly, boxPoly(labelBox(other)), 4), `${id} / ${other}`).toBe(false);
      for (const room of OFFICE_ROOM_IDS) expect(polygonsIntersect(poly, roomHull(room), 4), `${id} / room ${room}`).toBe(false);
      expect(polygonsIntersect(poly, coreHull(), 4), `${id} / core`).toBe(false);
    }
  });
  it("puts each room's card beside its room, on the side away from the core", () => {
    const c = iso(CORE.u, CORE.v);
    // distance on the floor (screen y doubled undoes the 2:1 projection)
    const far = (p: { x: number; y: number }) => Math.hypot(p.x - c.x, (p.y - c.y) * 2);
    for (const id of OFFICE_ROOM_IDS) {
      const f = FOOTPRINTS[id];
      const b = labelBox(id);
      expect(polygonsIntersect(boxPoly(b), roomHull(id), 22), `${id} next to its room`).toBe(true);
      expect(far({ x: b.x + b.w / 2, y: b.y + b.h / 2 }), id).toBeGreaterThan(far(iso((f.u0 + f.u1) / 2, (f.v0 + f.v1) / 2)));
    }
  });
});

describe("OFFICE_EDGE_GEOMETRY", () => {
  const door = (id: keyof typeof DOORS) => isoOf(DOORS[id]);
  const rimToward = (id: keyof typeof DOORS) => {
    const d = DOORS[id];
    const a = Math.atan2(d.v - CORE.v, d.u - CORE.u);
    return iso(CORE.u + RIM_R * Math.cos(a), CORE.v + RIM_R * Math.sin(a));
  };
  const synth = isoOf(SYNTHESIS_AT);
  it("has all twelve connections with a positive length, 49 samples and the map's endpoints", () => {
    expect(Object.keys(OFFICE_EDGE_GEOMETRY).sort()).toEqual(EDGES.map((e) => e.id).sort());
    for (const e of EDGES) {
      const g = OFFICE_EDGE_GEOMETRY[e.id];
      expect(g.length, e.id).toBeGreaterThan(0);
      expect(g.samples, e.id).toHaveLength(49);
      expect(g.from, e.id).toBe(e.from);
      expect(g.to, e.id).toBe(e.to);
      expect(g.path.startsWith("M "), e.id).toBe(true);
    }
  });
  it("ends each connection at the right door, rim or console", () => {
    const ends: Record<EdgeId, [{ x: number; y: number }, { x: number; y: number }] | [null, { x: number; y: number }]> = {
      E1: [rimToward("planner"), door("planner")],
      E2: [door("planner"), door("developer")],
      E3: [door("developer"), rimToward("developer")],
      E4: [rimToward("qa"), door("qa")],
      E5: [rimToward("reviewer"), door("reviewer")],
      E6: [rimToward("security-reviewer"), door("security-reviewer")],
      E7: [null, synth],
      E8: [null, synth],
      E9: [null, synth],
      E10: [synth, door("gate")],
      E11: [null, isoOf({ u: GATE_ROOM.commander.u - GATE_ROOM.commander.du / 2, v: GATE_ROOM.commander.v })],
      E12: [synth, { x: Number.NaN, y: Number.NaN }],
    };
    for (const [id, [start, end]] of Object.entries(ends) as Array<[EdgeId, [{ x: number; y: number } | null, { x: number; y: number }]]>) {
      const g = OFFICE_EDGE_GEOMETRY[id];
      if (start) expect(near({ x: g.x1, y: g.y1 }, start, 0.02), `${id} start`).toBe(true);
      if (!Number.isNaN(end.x)) expect(near({ x: g.x2, y: g.y2 }, end, 0.02), `${id} end`).toBe(true);
    }
    // the report lanes start beside their validator's door, and the fix loop ends beside the BUILD door
    for (const [id, role] of [
      ["E7", "qa"],
      ["E8", "reviewer"],
      ["E9", "security-reviewer"],
      ["E12", "developer"],
    ] as const) {
      const g = OFFICE_EDGE_GEOMETRY[id];
      const end = id === "E12" ? { x: g.x2, y: g.y2 } : { x: g.x1, y: g.y1 };
      const gap = Math.hypot(end.x - door(role).x, end.y - door(role).y);
      expect(gap, id).toBeGreaterThan(5);
      expect(gap, id).toBeLessThan(20);
    }
  });
  it("keeps the tip before the end and the midpoint on the path", () => {
    for (const e of EDGES) {
      const g = OFFICE_EDGE_GEOMETRY[e.id];
      expect(Math.hypot(g.tip.x - g.x2, g.tip.y - g.y2), e.id).toBeGreaterThanOrEqual(5);
      expect(g.samples).toContainEqual(g.mid);
    }
  });
  it("keeps every connection visible: its glyph anchor clear of every card, and at least 85% of it outside cards", () => {
    const cards = CARD_IDS.map((c) => boxPoly(labelBox(c)));
    for (const e of EDGES) {
      const g = OFFICE_EDGE_GEOMETRY[e.id];
      const glyph = boxPoly(glyphBox(e.id, g.mid));
      for (const [i, card] of cards.entries()) expect(polygonsIntersect(glyph, card), `${e.id} glyph / ${CARD_IDS[i]}`).toBe(false);
      if (!EDGES_INSIDE_ROOMS.includes(e.id)) for (const r of OFFICE_ROOM_IDS) expect(polygonsIntersect(glyph, roomHull(r)), `${e.id} glyph / room ${r}`).toBe(false);
      const under = g.samples.filter((p) => cards.some((card) => polygonsIntersect(boxPoly({ x: p.x - 1, y: p.y - 1, w: 2, h: 2 }), card))).length;
      expect(under / g.samples.length, `${e.id}: ${under} of ${g.samples.length} samples under a card`).toBeLessThanOrEqual(0.15);
    }
  });
  it("draws a connection that runs inside a room after that room (above its floor)", () => {
    for (const e of EDGES) {
      const route = EDGE_ROUTES[e.id];
      // the route's points and segment midpoints, strictly inside a footprint (a door on the boundary does not count)
      const pts = route.flatMap((p, i) => (i === 0 ? [p] : [{ u: (p.u + (route[i - 1] as UV).u) / 2, v: (p.v + (route[i - 1] as UV).v) / 2 }, p]));
      const insideSome = OFFICE_ROOM_IDS.some((r) => pts.some((p) => inside(p, FOOTPRINTS[r], 0.05)));
      expect(insideSome, e.id).toBe(EDGES_INSIDE_ROOMS.includes(e.id));
    }
    expect(EDGES_INSIDE_ROOMS).toEqual(["E11"]);
  });
  it("routes the fix loop round the core, never through the plinth", () => {
    for (const p of EDGE_ROUTES.E12) expect(Math.hypot(p.u - CORE.u, p.v - CORE.v)).toBeGreaterThan(CORE.r * Math.SQRT2);
  });
});

describe("walk corridors", () => {
  const routes: Array<[WalkOrigin, WalkDest]> = [];
  for (const o of [...ROLES, "core"] as const) for (const d of [...ROLES, "gate"] as const) if (o !== d) routes.push([o, d]);
  routes.push(["synthesis", "developer"]);
  it("exist for every origin and destination, from the origin door to the destination door", () => {
    for (const [o, d] of routes) {
      const pts = walkPoints(o, d);
      expect(pts.length, `${o}→${d}`).toBeGreaterThanOrEqual(2);
      expect(walkPath(o, d).startsWith("M "), `${o}→${d}`).toBe(true);
      expect(near(pts[pts.length - 1] as { x: number; y: number }, isoOf(DOORS[d])), `${o}→${d} end`).toBe(true);
      if (o !== "core" && o !== "synthesis") expect(near(pts[0] as { x: number; y: number }, isoOf(DOORS[o])), `${o}→${d} start`).toBe(true);
    }
    expect(near(walkPoints("synthesis", "developer")[0] as { x: number; y: number }, isoOf(SYNTHESIS_AT)), "synthesis start").toBe(true);
  });
  it("go round the core outside its plinth; planner → developer takes E2 and a fix round takes the E12 fix loop", () => {
    for (const [o, d] of routes) for (const p of walkRoute(o, d).slice(o === "synthesis" ? 1 : 0)) expect(Math.hypot(p.u - CORE.u, p.v - CORE.v), `${o}→${d}`).toBeGreaterThan(CORE.r * Math.SQRT2);
    expect(walkRoute("planner", "developer")).toEqual(EDGE_ROUTES.E2);
    expect(walkRoute("synthesis", "developer").slice(0, -1)).toEqual(EDGE_ROUTES.E12.slice(0, -1));
  });
  it("keep the token (figure and tag) visible, outside every card and the core's sign, for at least 85% of each walk", () => {
    const cards = CARD_IDS.map((c) => boxPoly(labelBox(c)));
    for (const [o, d] of routes) {
      const pts = walkPoints(o, d);
      const lastStart = pts[pts.length - 2] as { x: number; y: number };
      const end = pts[pts.length - 1] as { x: number; y: number };
      const lastLen = Math.hypot(end.x - lastStart.x, end.y - lastStart.y);
      // sample the path at 0–100% of its length
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push((cum[i - 1] as number) + Math.hypot((pts[i] as { x: number }).x - (pts[i - 1] as { x: number }).x, (pts[i] as { y: number }).y - (pts[i - 1] as { y: number }).y));
      const total = cum[cum.length - 1] as number;
      let counted = 0;
      let hidden = 0;
      for (let k = 0; k <= 50; k++) {
        const t = (total * k) / 50;
        // the last segment, at the destination door, is exempt (a multi-segment walk only)
        if (pts.length > 2 && t >= total - lastLen) continue;
        let j = 0;
        while (j < cum.length - 2 && (cum[j + 1] as number) < t) j++;
        const a = pts[j] as { x: number; y: number };
        const b = pts[j + 1] as { x: number; y: number };
        const seg = (cum[j + 1] as number) - (cum[j] as number);
        const f = seg <= 0 ? 0 : (t - (cum[j] as number)) / seg;
        const p = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
        counted++;
        const token = boxPoly({ x: p.x - 31, y: p.y - 56, w: 62, h: 60 });
        if (cards.some((card) => polygonsIntersect(token, card))) hidden++;
      }
      expect(hidden / counted, `${o}→${d}: hidden at ${hidden} of ${counted} samples`).toBeLessThanOrEqual(0.15);
    }
  });
});

describe("chipBox", () => {
  it("fits the longest two-line label, inside the world, clear of every card, the core's sign, the other rooms and every desk", () => {
    // "#0000 ← Security Reviewer" is drawn as "#0000" over "← Security Reviewer" (15 px, 9.4 per character, 14 of padding)
    expect("← Security Reviewer".length * 9.4 + 14).toBeLessThanOrEqual(CHIP_W);
    const desks = ROLES.map((r) => boxHull(footprintOf(ROLE_ROOMS[r].desk), SLAB_H + ROLE_ROOMS[r].desk.h));
    for (const id of OFFICE_ROOM_IDS) {
      const b = chipBox(id);
      const poly = boxPoly(b);
      expect(b.y, id).toBeGreaterThanOrEqual(0);
      expect(b.x, id).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w, id).toBeLessThanOrEqual(OFFICE_WORLD.width);
      for (const c of CARD_IDS) expect(polygonsIntersect(poly, boxPoly(labelBox(c)), 2), `chip ${id} / ${c}`).toBe(false);
      for (const r of OFFICE_ROOM_IDS) if (r !== id) expect(polygonsIntersect(poly, roomHull(r), 2), `chip ${id} / room ${r}`).toBe(false);
      for (const [i, desk] of desks.entries()) expect(polygonsIntersect(poly, desk), `chip ${id} / desk ${ROLES[i]}`).toBe(false);
    }
  });
});

describe("coreParticles", () => {
  it("is deterministic, capped at 24 and inside the disc", () => {
    expect(coreParticles(12)).toEqual(coreParticles(12));
    expect(coreParticles(40)).toHaveLength(24);
    expect(coreParticles(0)).toEqual([]);
    for (const p of coreParticles(24)) expect(Math.hypot(p.x, p.y)).toBeLessThanOrEqual(CLOUD_R);
  });
});
