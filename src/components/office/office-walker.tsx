"use client";
import type { Walker } from "@/lib/ui/office";
import { chipBox } from "@/lib/ui/office-layout";

const CHAR = 9.4;

/** The mission tag a token carries: "#0002" on a small plate. */
function Tag({ text, y }: { text: string; y: number }) {
  const w = text.length * CHAR + 14;
  return (
    <g transform={`translate(0 ${y})`}>
      <rect className="office-tag-bg" x={-w / 2} y={-15} width={w} height={21} rx={3} />
      <text className="office-tag" x={0} y={1}>
        {text}
      </text>
    </g>
  );
}

/**
 * A mission token walking its corridor once (an `.fx` element on an offset-path; its key restarts it). Under
 * reduced motion nothing moves: a static two-line "#0002 / ← Planner" chip sits above the destination room (clear
 * of its desk, every card and the core's sign) while the effect lasts, and the live announcer says the same in words.
 */
export function OfficeWalker({ walker, reducedMotion }: { walker: Walker; reducedMotion: boolean }) {
  if (reducedMotion) {
    const b = chipBox(walker.dest);
    const from = walker.text.slice(walker.label.length).trim();
    return (
      <g aria-hidden="true">
        <rect className="office-tag-bg" x={b.x} y={b.y} width={b.w} height={b.h} rx={3} />
        <text className="office-tag" x={b.x + b.w / 2} y={b.y + 16}>
          {walker.label}
        </text>
        <text className="office-tag" x={b.x + b.w / 2} y={b.y + 34} style={{ fontWeight: 400 }}>
          {from}
        </text>
      </g>
    );
  }
  return (
    <g className="fx walker" style={{ offsetPath: `path("${walker.d}")`, animationDuration: `${walker.durationMs}ms` }} aria-hidden="true">
      <ellipse className="office-shadow" cx={0} cy={0} rx={7} ry={3.5} />
      <path className="office-figure-leg" d="M-4 0 h3 v-11 h-3 Z M1 0 h3 v-11 h-3 Z" />
      <path className="office-figure-body" d="M-5 -11 L5 -11 L6 -22 Q6 -24 4 -24 L-4 -24 Q-6 -24 -6 -22 Z" style={{ stroke: "var(--signal)" }} />
      <circle className="office-figure-head" cx={0} cy={-29} r={4.5} />
      <rect x={4} y={-19} width={6} height={8} rx={1} fill="var(--signal)" opacity={0.85} />
      <Tag text={walker.label} y={-40} />
    </g>
  );
}
