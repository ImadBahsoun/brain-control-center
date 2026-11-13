"use client";
import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { nodeName, type EdgeModel } from "@/lib/ui/command-map";
import { EDGE_GEOMETRY, type EdgeGeometry } from "@/lib/ui/layout";
import { MapGlyph } from "@/components/ui/glyphs";
import { MapItem, STATE_TONE, type Opener } from "@/components/map/map-node";

const PARTICLES = 3;

/** Seconds for one particle to cross an edge: proportional to its length (240 world units per second), clamped. */
export function particlePeriod(length: number): number {
  return Math.min(4.5, Math.max(1.2, length / 240));
}

export function MapEdge({ edge, selected, onSelect, reducedMotion, animated, geometry }: { edge: EdgeModel; selected: boolean; onSelect: (o: Opener) => void; reducedMotion: boolean; animated: boolean; /** Another view's path for the edge (the office floor); the map's by default. */ geometry?: EdgeGeometry }) {
  const g = geometry ?? EDGE_GEOMETRY[edge.id];
  const running = edge.state === "running" && !edge.stale;
  // flow only on a live mission or a replay; a debrief draws the recorded state statically
  const loop = animated && !reducedMotion;
  const flowing = running && loop;
  const synthFlow = edge.synthesizing && loop;
  const tone = edge.state === "running" && edge.stale ? "var(--warn)" : edge.synthesizing ? "var(--synth)" : STATE_TONE[edge.state];
  const label = `${edge.label}: ${nodeName(edge.from)} to ${nodeName(edge.to)}, ${edge.stateText.toLowerCase()}${edge.synthesizing ? " (report in synthesis)" : ""}${edge.detail ? `, ${edge.detail}` : ""}`;
  const period = particlePeriod(g.length);
  const particle = (i: number, n: number, p: number): CSSProperties => ({ offsetPath: `path("${g.path}")`, animationDuration: `${p}s`, animationDelay: `${(-i * p) / n}s` });
  return (
    <MapItem
      label={label}
      selected={selected}
      onSelect={onSelect}
      className={cn("edge", `st-${edge.state}`, edge.stale && "stale", edge.dormant && "dormant", edge.synthesizing && "synth")}
      ring={<path className="focus-ring" d={g.path} style={{ strokeWidth: 8, strokeDasharray: "4 4" }} />}
    >
      <path className="edge-glow" d={g.path} />
      <path className="edge-base" d={g.path} />
      {edge.state === "waiting-approval" && <path className={cn("edge-pulse", loop && "loop")} d={g.path} />}
      {/* a failed run pulses red while the mission is live or replayed; a debrief keeps the static cross */}
      {edge.state === "failed" && loop && <path className="edge-pulse fail loop" d={g.path} />}
      {running && !flowing && <path className="edge-static-flow" d={g.path} />}
      {flowing &&
        Array.from({ length: PARTICLES }, (_, i) => (
          <g key={i}>
            <circle className="particle-halo loop" r={6} style={particle(i, PARTICLES, period)} />
            <circle className="particle loop" r={2.4} style={particle(i, PARTICLES, period)} />
          </g>
        ))}
      {/* a delivered report being synthesized: a slow purple flow toward Synthesis */}
      {synthFlow &&
        Array.from({ length: 2 }, (_, i) => (
          <g key={`s${i}`}>
            <circle className="particle-halo synth loop" r={5} style={particle(i, 2, period * 2)} />
            <circle className="particle synth loop" r={2} style={particle(i, 2, period * 2)} />
          </g>
        ))}
      {/* direction chevron just outside the target node */}
      <g transform={`translate(${g.tip.x} ${g.tip.y}) rotate(${g.tipAngle})`} style={{ color: tone }} aria-hidden="true">
        <path d="M-7 -4 L0 0 L-7 4" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" opacity={edge.dormant ? 0.5 : 1} />
      </g>
      {edge.state === "blocked" && <MapGlyph name="warning" x={g.mid.x} y={g.mid.y} size={16} className="tone-danger" />}
      {edge.state === "failed" && <MapGlyph name="cross" x={g.mid.x} y={g.mid.y} size={14} className="tone-danger" />}
      {edge.state === "unknown" && <MapGlyph name="question" x={g.mid.x} y={g.mid.y} size={14} className="tone-faint" />}
      {edge.id === "E2" && edge.lock && (
        <g transform={`translate(${g.mid.x} ${g.mid.y})`} aria-hidden="true">
          <circle r={11} className="node-fill" />
          <circle r={11} fill="none" stroke={tone} strokeWidth={1} />
          <MapGlyph name="lock" x={0} y={0} size={12} className={edge.state === "waiting-approval" ? cn("tone-warn", loop && "loop blink") : ""} />
        </g>
      )}
      {edge.id === "E12" && (
        <text x={g.mid.x + 10} y={g.mid.y + 4} className="node-meta" style={{ fill: tone, textAnchor: "start" }}>
          FIX LOOP
        </text>
      )}
      {edge.state === "skipped" && (
        <text x={g.mid.x} y={g.mid.y - 7} className="node-meta">
          SKIPPED
        </text>
      )}
      <path className="hit" d={g.path} />
    </MapItem>
  );
}

/** The small marker in the legend and panels: the same strokes as the map. */
export function EdgeSwatch({ state, synthesizing = false }: { state: EdgeModel["state"]; synthesizing?: boolean }) {
  const dash = state === "pending" ? "2 6" : state === "skipped" ? "1 8" : state === "unknown" ? "4 4" : state === "failed" ? "18 10" : state === "running" ? "6 4" : undefined;
  return (
    <svg width={44} height={8} viewBox="0 0 44 8" aria-hidden="true" focusable="false">
      <line x1={2} y1={4} x2={42} y2={4} stroke={synthesizing ? "var(--synth)" : STATE_TONE[state]} strokeWidth={state === "blocked" || state === "waiting-approval" ? 2 : 1.5} strokeDasharray={dash} strokeLinecap="round" />
    </svg>
  );
}
