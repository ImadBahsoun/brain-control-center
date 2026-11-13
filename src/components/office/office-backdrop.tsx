"use client";
import { GRID, iso, points, TZ, WINDOW_H } from "@/lib/ui/office-layout";

/** Width of one repeat of the city outside the windows (wall units along the wall). */
const TILE_W = 192;
const WALL_LEN = GRID * 24;
const WALL_TOP = -WINDOW_H * TZ;

/** A small deterministic generator, so the skyline is the same on every render and every visit. */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

interface Building {
  x: number;
  w: number;
  h: number;
  far: boolean;
  lit: Array<{ x: number; y: number }>;
}

const SKYLINE: Building[] = (() => {
  const rnd = seeded(7);
  const out: Building[] = [];
  for (const far of [true, false]) {
    let x = far ? -6 : 0;
    while (x < TILE_W) {
      const w = 14 + Math.floor(rnd() * (far ? 22 : 26));
      const h = (far ? 34 : 18) + Math.floor(rnd() * (far ? 30 : 34));
      const lit: Array<{ x: number; y: number }> = [];
      if (!far) {
        for (let wy = -h + 5; wy < -4; wy += 6) for (let wx = x + 3; wx < x + w - 3; wx += 5) if (rnd() < 0.16) lit.push({ x: wx, y: wy });
      }
      out.push({ x, w, h, far, lit });
      x += w + (far ? 2 : 4 + Math.floor(rnd() * 6));
    }
  }
  return out;
})();

const CITY_ID = "office-city";
const SKY_H = -WALL_TOP;

/** The skyline as one repeating pattern tile (drawn once, filled into both walls). */
function CityPattern() {
  return (
    <pattern id={CITY_ID} patternUnits="userSpaceOnUse" x={0} y={WALL_TOP} width={TILE_W} height={SKY_H}>
      <rect className="office-window-sky" x={0} y={0} width={TILE_W} height={SKY_H} />
      {SKYLINE.map((b, k) => (
        <rect key={k} className={b.far ? "office-building-far" : "office-building"} x={b.x} y={SKY_H - b.h} width={b.w} height={b.h} />
      ))}
      {SKYLINE.flatMap((b, k) => b.lit.map((l, j) => <rect key={`${k}-${j}`} className="office-lit" x={l.x} y={SKY_H + l.y} width={2} height={3} />))}
    </pattern>
  );
}

/** One window wall in its own flat coordinates (x along the wall, y up is negative), skewed onto the floor edge by the caller. */
function WindowWall() {
  return (
    <g>
      <rect x={0} y={WALL_TOP} width={WALL_LEN} height={SKY_H} fill={`url(#${CITY_ID})`} />
      <rect className="office-window-glass" x={0} y={WALL_TOP} width={WALL_LEN} height={SKY_H} />
      {/* mullions every two tiles, a transom, the sill and the light top edge */}
      <path className="office-mullion" d={Array.from({ length: GRID / 2 + 1 }, (_, i) => `M ${i * 48} 0 V ${WALL_TOP}`).join(" ")} />
      <path className="office-mullion" d={`M 0 ${WALL_TOP / 2} H ${WALL_LEN}`} style={{ opacity: 0.35 }} />
      <path className="office-window" d={`M 0 0 H ${WALL_LEN}`} />
      <path className="office-top-edge" d={`M 0 ${WALL_TOP} H ${WALL_LEN}`} />
    </g>
  );
}

/**
 * L0 of the office: the floor diamond with its tile grid and the two back window walls with a static city
 * behind them. Decor only; nothing here moves or carries data.
 */
export function OfficeBackdrop() {
  const o = iso(0, 0);
  const lines: string[] = [];
  for (let i = 1; i < GRID; i++) {
    const a = iso(i, 0);
    const b = iso(i, GRID);
    const c = iso(0, i);
    const d = iso(GRID, i);
    lines.push(`M ${a.x} ${a.y} L ${b.x} ${b.y}`, `M ${c.x} ${c.y} L ${d.x} ${d.y}`);
  }
  const diamond = [iso(0, 0), iso(GRID, 0), iso(GRID, GRID), iso(0, GRID)];
  return (
    <g className="office-backdrop" aria-hidden="true">
      <defs>
        <CityPattern />
      </defs>
      <polygon className="office-floor" points={points(diamond)} />
      <path className="office-floor-grid" d={lines.join(" ")} />
      <polygon className="office-floor-edge" points={points(diamond)} />
      {/* right back wall along v = 0 (x grows with u, y rises by half), left back wall along u = 0, mirrored */}
      <g transform={`matrix(1 0.5 0 1 ${o.x} ${o.y})`}>
        <WindowWall />
      </g>
      <g transform={`matrix(-1 0.5 0 1 ${o.x} ${o.y})`}>
        <WindowWall />
      </g>
    </g>
  );
}
