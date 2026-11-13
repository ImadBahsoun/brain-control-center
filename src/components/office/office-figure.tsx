"use client";
import { cn } from "@/lib/utils";
import type { Point } from "@/lib/ui/layout";
import type { Role } from "@/lib/ui/roles";
import { RoleEmblem } from "@/components/map/role-emblem";

/**
 * A role's character: a geometric silhouette (head and a tapered torso; legs when standing) with the role
 * emblem as a badge above the head, ringed in the state colour. Seated, the desk in front hides the legs.
 * A seated, non-stale figure on a live or replayed mission gets only a soft monitor glow (a `.loop` pulse):
 * a reservation is not proof of work, so nothing types or moves. Decorative: the room's button carries the words.
 */
export function OfficeFigure({ at, role, posture, tone, extra, glow, loop }: { at: Point; role: Role; posture: "seated" | "standing"; tone: string; extra: number; glow: boolean; loop: boolean }) {
  const seated = posture === "seated";
  // torso bottom, shoulders and head centre, in world units above the floor point
  const hip = seated ? -9 : -14;
  const shoulder = hip - 16;
  const head = shoulder - 6.5;
  const badge = head - 20;
  return (
    <g transform={`translate(${at.x} ${at.y})`} aria-hidden="true">
      <ellipse className="office-shadow" cx={0} cy={0} rx={9} ry={4.5} />
      {glow && <ellipse className={cn("office-glow", loop && "loop")} cx={4} cy={hip - 6} rx={13} ry={9} style={{ fill: tone }} />}
      {!seated && <path className="office-figure-leg" d={`M-5 0 h3.6 v${hip} h-3.6 Z M1.4 0 h3.6 v${hip} h-3.6 Z`} />}
      <path className="office-figure-body" d={`M-6 ${hip} L6 ${hip} L7.5 ${shoulder + 3} Q7.5 ${shoulder} 4.5 ${shoulder} L-4.5 ${shoulder} Q-7.5 ${shoulder} -7.5 ${shoulder + 3} Z`} />
      {/* a thin collar line in the state colour */}
      <path d={`M-3 ${shoulder + 1.5} L0 ${shoulder + 4.5} L3 ${shoulder + 1.5}`} fill="none" stroke={tone} strokeWidth={1.4} strokeLinecap="round" />
      <circle className="office-figure-head" cx={0} cy={head} r={5.5} />
      <line x1={0} y1={head - 6} x2={0} y2={badge + 12} stroke={tone} strokeWidth={1} opacity={0.6} />
      <g transform={`translate(0 ${badge})`} style={{ color: tone }}>
        <circle className="office-badge" r={12} style={{ stroke: tone }} />
        <RoleEmblem role={role} size={17} className="office-emblem" />
      </g>
      {extra > 0 && (
        <text className="office-num" x={16} y={badge + 5} style={{ fill: tone }}>
          ×{extra + 1}
        </text>
      )}
    </g>
  );
}
