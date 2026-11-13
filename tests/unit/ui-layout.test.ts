import { describe, expect, it } from "vitest";
import { ROLES } from "@/lib/ui/roles";
import { boxesIntersect, EDGE_BY_ID, EDGE_GEOMETRY, EDGES, edgeGeometry, labelBox, LANE_SLOTS, laneBox, MARKER_R, NODE_IDS, NODES, pointInBox, threatLane, WORLD, type Box } from "@/lib/ui/layout";

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const ANCHORS = [...ROLES, "core"] as const;
const nodeBox = (id: (typeof NODE_IDS)[number]): Box => ({ x: NODES[id].x - NODES[id].r, y: NODES[id].y - NODES[id].r, w: NODES[id].r * 2, h: NODES[id].r * 2 });

describe("command map layout", () => {
  it("keeps every node, label block and lane inside the world", () => {
    for (const n of Object.values(NODES)) {
      expect(n.x - n.r, n.id).toBeGreaterThanOrEqual(0);
      expect(n.y - n.r, n.id).toBeGreaterThanOrEqual(0);
      expect(n.x + n.r, n.id).toBeLessThanOrEqual(WORLD.width);
      expect(n.y + n.r, n.id).toBeLessThanOrEqual(WORLD.height);
      const b = labelBox(n.id);
      expect(b.x, n.id).toBeGreaterThanOrEqual(0);
      expect(b.y, n.id).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w, n.id).toBeLessThanOrEqual(WORLD.width);
      expect(b.y + b.h, n.id).toBeLessThanOrEqual(WORLD.height);
    }
    for (const a of ANCHORS) {
      const b = laneBox(a);
      expect(b.x, a).toBeGreaterThanOrEqual(0);
      expect(b.y, a).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w, a).toBeLessThanOrEqual(WORLD.width);
      expect(b.y + b.h, a).toBeLessThanOrEqual(WORLD.height);
    }
    for (const g of Object.values(EDGE_GEOMETRY)) {
      for (const p of g.samples) {
        expect(p.x, g.id).toBeGreaterThanOrEqual(8);
        expect(p.x, g.id).toBeLessThanOrEqual(WORLD.width - 8);
        expect(p.y, g.id).toBeGreaterThanOrEqual(8);
        expect(p.y, g.id).toBeLessThanOrEqual(WORLD.height - 8);
      }
    }
  });
  it("has no overlapping nodes and the amended arrangement", () => {
    for (const a of NODE_IDS) {
      for (const b of NODE_IDS) {
        if (a >= b) continue;
        expect(dist(NODES[a], NODES[b]), `${a}-${b}`).toBeGreaterThan(NODES[a].r + NODES[b].r);
      }
    }
    expect(NODES.core.x).toBe(WORLD.width / 2);
    expect(NODES.planner.x).toBe(NODES.developer.x); // left column
    expect(NODES.qa.x).toBe(NODES["security-reviewer"].x); // right column
    expect(NODES.synthesis.y).toBeGreaterThan(NODES.core.y);
    expect(NODES.ready.y).toBeGreaterThan(NODES.synthesis.y);
    expect(NODES.gate.y).toBe(NODES.ready.y);
  });
  it("defines at most 13 directed edges with unique ids that reference existing nodes", () => {
    expect(EDGES.length).toBeLessThanOrEqual(13);
    expect(new Set(EDGES.map((e) => e.id)).size).toBe(EDGES.length);
    for (const e of EDGES) {
      expect(NODE_IDS, e.id).toContain(e.from);
      expect(NODE_IDS, e.id).toContain(e.to);
      expect(e.from).not.toBe(e.to);
    }
    expect(EDGE_BY_ID.E2).toMatchObject({ from: "planner", to: "developer" });
    expect(EDGE_BY_ID.E12).toMatchObject({ from: "synthesis", to: "developer" });
    expect(EDGES.filter((e) => e.to === "synthesis").map((e) => e.from)).toEqual(["qa", "reviewer", "security-reviewer"]);
  });
  it("gives straight edges a length and angle matching hypot/atan2 of the trimmed endpoints", () => {
    for (const def of EDGES.filter((e) => !e.route)) {
      const g = EDGE_GEOMETRY[def.id];
      const from = NODES[def.from];
      const to = NODES[def.to];
      expect(g.length, def.id).toBeCloseTo(dist(from, to) - from.r - to.r, 6);
      expect(g.angle, def.id).toBeCloseTo((Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI, 6);
      expect(dist({ x: g.x1, y: g.y1 }, from), def.id).toBeCloseTo(from.r, 6);
      expect(dist({ x: g.x2, y: g.y2 }, to), def.id).toBeCloseTo(to.r, 6);
      expect(g.path.startsWith("M ")).toBe(true);
    }
  });
  it("gives routed edges a path from the SVG grammar, evenly spaced samples, and ends on the node boundaries", () => {
    for (const def of EDGES.filter((e) => e.route)) {
      const g = EDGE_GEOMETRY[def.id];
      expect(g.length, def.id).toBeGreaterThan(dist(NODES[def.from], NODES[def.to]));
      expect(g.path, def.id).toMatch(/^M [\d.]+ [\d.]+( L [\d.]+ [\d.]+ Q [\d.]+ [\d.]+ [\d.]+ [\d.]+)+ L [\d.]+ [\d.]+$/);
      expect(g.samples).toHaveLength(49);
      expect(dist({ x: g.x1, y: g.y1 }, NODES[def.from]), def.id).toBeCloseTo(NODES[def.from].r, 6);
      expect(dist({ x: g.x2, y: g.y2 }, NODES[def.to]), def.id).toBeCloseTo(NODES[def.to].r, 6);
      // evenly spaced by arc length (a chord across a rounded corner is a little shorter than its arc)
      const steps = g.samples.slice(1).map((p, i) => dist(g.samples[i]!, p));
      const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
      for (const s of steps) expect(Math.abs(s - mean), def.id).toBeLessThan(mean * 0.1);
      expect(dist(g.tip, NODES[def.to]), def.id).toBeGreaterThanOrEqual(NODES[def.to].r - 1e-6);
    }
    // the three reports arrive at Synthesis from the right as a bus, in their own gutters
    for (const id of ["E7", "E8", "E9"] as const) {
      const g = EDGE_GEOMETRY[id];
      expect(g.x2).toBeGreaterThan(NODES.synthesis.x);
      const heading = ((g.tipAngle % 360) + 360) % 360; // pointing left = 180°
      expect(Math.abs(heading - 180), id).toBeLessThan(5);
    }
  });
  it("lets no edge pass through the core circle", () => {
    const core = NODES.core;
    for (const g of Object.values(EDGE_GEOMETRY)) {
      const touchesCore = g.from === "core" || g.to === "core";
      for (const p of g.samples) {
        if (touchesCore) expect(dist(p, core), g.id).toBeGreaterThanOrEqual(core.r - 1e-6);
        else expect(dist(p, core), g.id).toBeGreaterThan(core.r + 8);
      }
    }
  });
  it("lets no edge run through another node's circle or any node's label block", () => {
    for (const g of Object.values(EDGE_GEOMETRY)) {
      for (const n of NODE_IDS) {
        if (n === g.from || n === g.to) continue;
        for (const p of g.samples) expect(dist(p, NODES[n]), `${g.id} through ${n}`).toBeGreaterThan(NODES[n].r + 6);
      }
      for (const n of NODE_IDS) {
        const b = labelBox(n);
        if (b.h === 0) continue;
        for (const p of g.samples) expect(pointInBox(p, b, 4), `${g.id} over the ${n} labels at ${Math.round(p.x)},${Math.round(p.y)}`).toBe(false);
      }
    }
  });
  it("keeps every threat lane clear of edges, node circles and label blocks, and lanes apart from each other", () => {
    for (const a of ANCHORS) {
      const lane = threatLane(a);
      const box = laneBox(a);
      expect(lane.slots).toHaveLength(LANE_SLOTS);
      for (const g of Object.values(EDGE_GEOMETRY)) {
        for (const p of g.samples) expect(pointInBox(p, box, 4), `${g.id} crosses the ${a} lane`).toBe(false);
      }
      for (const n of NODE_IDS) {
        expect(boxesIntersect(box, nodeBox(n)), `${a} lane over the ${n} node`).toBe(false);
        const lb = labelBox(n);
        if (lb.h > 0) expect(boxesIntersect(box, lb), `${a} lane over the ${n} labels`).toBe(false);
      }
      // markers never overlap each other
      for (let i = 0; i < lane.slots.length; i++) for (let j = i + 1; j < lane.slots.length; j++) expect(dist(lane.slots[i]!, lane.slots[j]!)).toBeGreaterThan(MARKER_R * 2 + 8);
      // the lane sits beside its anchor
      const first = lane.slots[0]!;
      expect(dist(first, NODES[a])).toBeLessThan(NODES[a].r + 130);
    }
    for (const a of ANCHORS) for (const b of ANCHORS) if (a < b) expect(boxesIntersect(laneBox(a), laneBox(b)), `${a} vs ${b}`).toBe(false);
    for (const a of NODE_IDS) for (const b of NODE_IDS) if (a < b && labelBox(a).h > 0 && labelBox(b).h > 0) expect(boxesIntersect(labelBox(a), labelBox(b)), `${a} vs ${b} labels`).toBe(false);
  });
  it("is deterministic", () => {
    expect(edgeGeometry(EDGE_BY_ID.E7)).toEqual(edgeGeometry(EDGE_BY_ID.E7));
    expect(threatLane("qa")).toEqual(threatLane("qa"));
  });
});
