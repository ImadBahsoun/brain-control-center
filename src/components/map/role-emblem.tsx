// One geometric emblem per role, drawn with thin strokes on a 32×32 box centred on (0, 0): a main mark and a
// lower-opacity detail mark. The emblem and the archetype title carry the role's identity; colour is left
// to the status.
import type { Role } from "@/lib/ui/roles";

const EMBLEMS: Record<Role, { main: string; detail: string }> = {
  // Strategist: a compass rose, four points and a centre, inside a tactical ring with bearing ticks
  planner: {
    main: "M0 -11 L2.8 -2.8 L11 0 L2.8 2.8 L0 11 L-2.8 2.8 L-11 0 L-2.8 -2.8 Z M0 -5 V5 M-5 0 H5",
    detail: "M0 -14 A14 14 0 1 1 0 14 A14 14 0 1 1 0 -14 M0 -17 V-15 M17 0 H15 M0 17 V15 M-17 0 H-15",
  },
  // Builder: an anvil on its base, with a code mark </> struck above it
  developer: {
    main: "M-14 -3 H11 L14 0 H5 L3 4 L6 9 H-6 L-3 4 L-5 0 H-10 Q-14 0 -14 -3 Z M-9 12 H9",
    detail: "M-6 -14 L-10 -10 L-6 -6 M6 -14 L10 -10 L6 -6 M2 -15 L-2 -5",
  },
  // Scout: a radar sweep (quarter arc, sweep line, axes) with contact blips and a range ring
  qa: {
    main: "M-12 10 A15 15 0 0 1 10 -11 M-12 10 L5 -7 M-12 10 H12 M-12 10 V-12",
    detail: "M-4 10 A8 8 0 0 0 -12 2 M6 5 m-1.6 0 a1.6 1.6 0 1 0 3.2 0 a1.6 1.6 0 1 0 -3.2 0 M1 -4 m-1.2 0 a1.2 1.2 0 1 0 2.4 0 a1.2 1.2 0 1 0 -2.4 0 M10 1 m-1 0 a1 1 0 1 0 2 0 a1 1 0 1 0 -2 0",
  },
  // Judge: a lens with a pupil and a horizontal beam, over a verdict tick
  reviewer: {
    main: "M-14 -3 Q0 -15 14 -3 Q0 9 -14 -3 Z M0 -3 m-4 0 a4 4 0 1 0 8 0 a4 4 0 1 0 -8 0 M-14 -3 H-18 M14 -3 H18",
    detail: "M-5 10 L-1 14 L6 7",
  },
  // Guardian: a shield with a centre bar, and an inner keyline
  "security-reviewer": {
    main: "M0 -14 L12 -9 V1 C12 8 6 12.5 0 15 C-6 12.5 -12 8 -12 1 V-9 Z M0 -6 V5 M-5 -1 H5",
    detail: "M0 -10.5 L8.5 -6.8 V0.8 C8.5 6 4.5 9.4 0 11.4 C-4.5 9.4 -8.5 6 -8.5 0.8 V-6.8 Z",
  },
};

export function RoleEmblem({ role, size = 32, className }: { role: Role; size?: number; className?: string }) {
  const k = size / 32;
  return (
    <g transform={`scale(${k})`} className={className ?? "emblem"} aria-hidden="true">
      <path className="emblem-detail" d={EMBLEMS[role].detail} />
      <path d={EMBLEMS[role].main} />
    </g>
  );
}

/** The emblem as a standalone inline SVG for HTML panels, the HUD and the feed. */
export function RoleEmblemIcon({ role, size = 28, className }: { role: Role; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="-19 -19 38 38" className={className} aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth={size >= 40 ? 1.2 : 1.5} strokeLinejoin="round" strokeLinecap="round">
        <path d={EMBLEMS[role].detail} opacity={0.5} />
        <path d={EMBLEMS[role].main} />
      </g>
    </svg>
  );
}
