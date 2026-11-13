// World geometry of the command map: a fixed 1200×880 world, node coordinates, the side each node's
// label block sits on, directed edges and their paths, and the threat lane beside each anchor. Pure,
// deterministic, unit-tested: tests/unit/ui-layout.test.ts checks that no edge runs through a label
// block or a threat lane, that lanes and label blocks never overlap, and that nodes do not overlap.
//
// Topology (Brain amendment): the core dispatches every agent, so every fan-out is routed through it.
//   E1 core→planner "mission brief"      E2 planner→developer "plan" (carries the plan-gate lock)
//   E3 developer→core "implementation report"
//   E4/E5/E6 core→qa/reviewer/security-reviewer "dispatch"
//   E7/E8/E9 qa/reviewer/security-reviewer→synthesis "report": orthogonal traces with rounded corners,
//     each in its own gutter to the right of the column, arriving at Synthesis as a three-line bus
//   E10 synthesis→ready   E11 ready→gate   E12 synthesis→developer "fix loop" (drawn only with a fix round)
import type { Role } from "./roles";

export const WORLD = { width: 1200, height: 880 } as const;

export type NodeId = Role | "core" | "synthesis" | "ready" | "gate";
export type EdgeId = "E1" | "E2" | "E3" | "E4" | "E5" | "E6" | "E7" | "E8" | "E9" | "E10" | "E11" | "E12";

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type LabelSide = "above" | "below";

export interface NodeLayout extends Point {
  id: NodeId;
  r: number;
  /** Which side the title / archetype / status block is drawn on; the opposite side is free for edges. */
  labelSide: LabelSide;
  /** Conservative width of the label block, world units (the widest status text is a 24-char verdict). */
  labelWidth: number;
}

export const NODES: Record<NodeId, NodeLayout> = {
  core: { id: "core", x: 600, y: 340, r: 72, labelSide: "below", labelWidth: 0 },
  planner: { id: "planner", x: 240, y: 150, r: 44, labelSide: "above", labelWidth: 180 },
  developer: { id: "developer", x: 240, y: 530, r: 44, labelSide: "below", labelWidth: 180 },
  qa: { id: "qa", x: 910, y: 150, r: 44, labelSide: "below", labelWidth: 180 },
  reviewer: { id: "reviewer", x: 950, y: 350, r: 44, labelSide: "below", labelWidth: 180 },
  "security-reviewer": { id: "security-reviewer", x: 910, y: 530, r: 44, labelSide: "below", labelWidth: 180 },
  synthesis: { id: "synthesis", x: 600, y: 672, r: 40, labelSide: "above", labelWidth: 120 },
  ready: { id: "ready", x: 600, y: 790, r: 34, labelSide: "below", labelWidth: 120 },
  gate: { id: "gate", x: 860, y: 790, r: 34, labelSide: "below", labelWidth: 120 },
};

export const NODE_IDS = Object.keys(NODES) as NodeId[];

/**
 * Label block height in world units: three lines at 16 (title; archetype · model · units; state word ·
 * activity) on a 20 pitch. 58 is the most the reviewer's block can take above the E9 report gutter.
 */
export const LABEL_BLOCK_HEIGHT = 58;
/** Two-line block of the step and gate nodes (title + status at 16 world units on a 17 pitch). */
export const SHORT_BLOCK_HEIGHT = 36;
/** Gap between a node's circle and its label block. */
export const LABEL_GAP = 6;
/** The label block's horizontal centre may be shifted off the node (QA's block is shifted right, clear of E4). */
const LABEL_SHIFT: Partial<Record<NodeId, number>> = { qa: 20 };

/** The label block of a node: the box its title, archetype and status text occupy. */
export function labelBox(id: NodeId): Box {
  const n = NODES[id];
  const w = n.labelWidth;
  const h = id === "core" ? 0 : id === "synthesis" || id === "ready" || id === "gate" ? SHORT_BLOCK_HEIGHT : LABEL_BLOCK_HEIGHT;
  const x = n.x + (LABEL_SHIFT[id] ?? 0) - w / 2;
  const y = n.labelSide === "below" ? n.y + n.r + LABEL_GAP : n.y - n.r - LABEL_GAP - h;
  return { x, y, w, h };
}

export function labelShift(id: NodeId): number {
  return LABEL_SHIFT[id] ?? 0;
}

export interface EdgeDef {
  id: EdgeId;
  from: NodeId;
  to: NodeId;
  label: string;
  /** Interior waypoints of an orthogonal route (world coordinates); corners are rounded. A straight edge has none. */
  route?: readonly Point[];
}

export const EDGES: readonly EdgeDef[] = [
  { id: "E1", from: "core", to: "planner", label: "mission brief" },
  { id: "E2", from: "planner", to: "developer", label: "plan" },
  { id: "E3", from: "developer", to: "core", label: "implementation report" },
  { id: "E4", from: "core", to: "qa", label: "dispatch" },
  { id: "E5", from: "core", to: "reviewer", label: "dispatch" },
  { id: "E6", from: "core", to: "security-reviewer", label: "dispatch" },
  // the three reports leave the top of their node into a horizontal gutter, run down their own vertical gutter
  // to the right of the column, and join the bus into Synthesis
  { id: "E7", from: "qa", to: "synthesis", label: "report", route: [{ x: 910, y: 48 }, { x: 1180, y: 48 }, { x: 1180, y: 692 }] },
  { id: "E8", from: "reviewer", to: "synthesis", label: "report", route: [{ x: 950, y: 274 }, { x: 1150, y: 274 }, { x: 1150, y: 672 }] },
  { id: "E9", from: "security-reviewer", to: "synthesis", label: "report", route: [{ x: 910, y: 463 }, { x: 1120, y: 463 }, { x: 1120, y: 652 }] },
  { id: "E10", from: "synthesis", to: "ready", label: "ready" },
  { id: "E11", from: "ready", to: "gate", label: "commander gate" },
  // the fix loop leaves Synthesis to the left and comes back under the Developer's labels
  { id: "E12", from: "synthesis", to: "developer", label: "fix loop", route: [{ x: 360, y: 672 }, { x: 360, y: 530 }] },
];

export const EDGE_BY_ID: Record<EdgeId, EdgeDef> = Object.fromEntries(EDGES.map((e) => [e.id, e])) as Record<EdgeId, EdgeDef>;

export interface EdgeGeometry {
  id: EdgeId;
  from: NodeId;
  to: NodeId;
  /** Start and end on the node boundaries. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** SVG path data for the whole edge. */
  path: string;
  /** Polyline length of the drawn path. */
  length: number;
  /** Direction at the start, degrees. */
  angle: number;
  /** Evenly spaced points along the path by arc length, start to end (SAMPLES + 1 points). */
  samples: Point[];
  /** The point half way along the path, for glyphs and labels. */
  mid: Point;
  /** The last point outside the target node, for the direction chevron. */
  tip: Point;
  tipAngle: number;
}

export const SAMPLES = 48;
const CORNER = 24;

function dist(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function angleDeg(a: Point, b: Point): number {
  return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
}

/** The point on a node's circle in the direction of `toward`. */
function boundary(node: NodeLayout, toward: Point): Point {
  const len = dist(node, toward);
  return { x: node.x + ((toward.x - node.x) / len) * node.r, y: node.y + ((toward.y - node.y) / len) * node.r };
}

function quadratic(p0: Point, c: Point, p1: Point, t: number): Point {
  const u = 1 - t;
  return { x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x, y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y };
}

/** Resamples a dense polyline into `n + 1` points evenly spaced by arc length. */
function resample(points: readonly Point[], n: number): Point[] {
  const cum: number[] = [0];
  for (let i = 1; i < points.length; i++) cum.push((cum[i - 1] as number) + dist(points[i - 1] as Point, points[i] as Point));
  const total = cum[cum.length - 1] as number;
  const out: Point[] = [];
  let j = 0;
  for (let i = 0; i <= n; i++) {
    const target = (total * i) / n;
    while (j < cum.length - 2 && (cum[j + 1] as number) < target) j++;
    const a = points[j] as Point;
    const b = points[j + 1] as Point;
    const segLen = (cum[j + 1] as number) - (cum[j] as number);
    const t = segLen === 0 ? 0 : (target - (cum[j] as number)) / segLen;
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return out;
}

/** An orthogonal route through `pts` (boundary → waypoints → boundary) with rounded corners. */
function routedPath(pts: readonly Point[]): { d: string; dense: Point[] } {
  const first = pts[0] as Point;
  let d = `M ${first.x} ${first.y}`;
  const dense: Point[] = [first];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1] as Point;
    const c = pts[i] as Point;
    const b = pts[i + 1] as Point;
    const rho = Math.min(CORNER, dist(a, c) / 2, dist(c, b) / 2);
    const p1 = { x: c.x + ((a.x - c.x) / dist(a, c)) * rho, y: c.y + ((a.y - c.y) / dist(a, c)) * rho };
    const p2 = { x: c.x + ((b.x - c.x) / dist(c, b)) * rho, y: c.y + ((b.y - c.y) / dist(c, b)) * rho };
    d += ` L ${p1.x} ${p1.y} Q ${c.x} ${c.y} ${p2.x} ${p2.y}`;
    dense.push(p1);
    for (let k = 1; k <= 8; k++) dense.push(quadratic(p1, c, p2, k / 8));
  }
  const last = pts[pts.length - 1] as Point;
  d += ` L ${last.x} ${last.y}`;
  dense.push(last);
  return { d, dense };
}

export function edgeGeometry(def: EdgeDef): EdgeGeometry {
  const from = NODES[def.from];
  const to = NODES[def.to];
  let samples: Point[];
  let path: string;
  if (def.route && def.route.length > 0) {
    const start = boundary(from, def.route[0] as Point);
    const end = boundary(to, def.route[def.route.length - 1] as Point);
    const routed = routedPath([start, ...def.route, end]);
    path = routed.d;
    samples = resample(routed.dense, SAMPLES);
  } else {
    const start = boundary(from, to);
    const end = boundary(to, from);
    samples = Array.from({ length: SAMPLES + 1 }, (_, i) => ({ x: start.x + (end.x - start.x) * (i / SAMPLES), y: start.y + (end.y - start.y) * (i / SAMPLES) }));
    path = `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
  }
  let length = 0;
  for (let i = 1; i < samples.length; i++) length += dist(samples[i - 1] as Point, samples[i] as Point);
  const first = samples[0] as Point;
  const last = samples[samples.length - 1] as Point;
  const second = samples[1] as Point;
  let tipIndex = samples.length - 1;
  while (tipIndex > 0 && dist(samples[tipIndex] as Point, to) < to.r - 1e-6) tipIndex--;
  const tip = samples[tipIndex] as Point;
  const before = samples[Math.max(0, tipIndex - 1)] as Point;
  return {
    id: def.id,
    from: def.from,
    to: def.to,
    x1: first.x,
    y1: first.y,
    x2: last.x,
    y2: last.y,
    path,
    length,
    angle: angleDeg(first, second),
    samples,
    mid: samples[SAMPLES / 2] as Point,
    tip,
    tipAngle: angleDeg(before, tip),
  };
}

export const EDGE_GEOMETRY: Record<EdgeId, EdgeGeometry> = Object.fromEntries(EDGES.map((e) => [e.id, edgeGeometry(e)])) as Record<EdgeId, EdgeGeometry>;

// ---- threat lanes -----------------------------------------------------------------------------------

/** Markers per anchor: three slots; when more than three findings anchor there, the third slot is a "+n" chip. */
export const LANE_SLOTS = 3;
export const MARKER_R = 11;
/** Vertical pitch of the slots: a marker plus its two-line label. */
export const LANE_PITCH = 36;
/** Width of a two-line marker label ("F-001" over "BLOCKER") at 14 world px mono, plus its gap to the marker. */
export const LANE_LABEL_W = 68;

export interface ThreatLane {
  /** Marker centres, top to bottom. */
  slots: Point[];
  /** Which side of the marker the label sits on. */
  labelSide: "left" | "right";
}

/**
 * A fixed lane beside each anchor, in space no edge or label block uses: the left column's lanes are to
 * the left of the node, the right column's to the right (between the node and the report gutters), the
 * core's above it. The lane is vertically centred on the node.
 */
export function threatLane(anchor: Role | "core"): ThreatLane {
  const n = NODES[anchor];
  const dx = n.r + 22;
  const left = anchor === "planner" || anchor === "developer";
  const x = anchor === "core" ? n.x : left ? n.x - dx : n.x + dx;
  // the lane is centred away from the node's label side (planner: labels above; the others: labels below)
  // and, on the right column, below the report gutter that leaves the node's top
  const yCentre = anchor === "core" ? n.y - n.r - 36 - LANE_PITCH : anchor === "planner" ? n.y + 14 : anchor === "developer" ? n.y - 14 : n.y - 8;
  const slots = Array.from({ length: LANE_SLOTS }, (_, i) => ({ x, y: yCentre + (i - (LANE_SLOTS - 1) / 2) * LANE_PITCH }));
  return { slots, labelSide: left ? "left" : "right" };
}

/** The box a lane occupies (markers plus labels), for the layout tests. */
export function laneBox(anchor: Role | "core"): Box {
  const lane = threatLane(anchor);
  const first = lane.slots[0] as Point;
  const last = lane.slots[lane.slots.length - 1] as Point;
  const x = lane.labelSide === "left" ? first.x - MARKER_R - LANE_LABEL_W : first.x - MARKER_R;
  return { x, y: first.y - LANE_PITCH / 2, w: MARKER_R * 2 + LANE_LABEL_W, h: last.y - first.y + LANE_PITCH };
}

export function pointInBox(p: Point, b: Box, margin = 0): boolean {
  return p.x >= b.x - margin && p.x <= b.x + b.w + margin && p.y >= b.y - margin && p.y <= b.y + b.h + margin;
}

export function boxesIntersect(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
