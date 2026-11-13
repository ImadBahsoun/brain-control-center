"use client";
import { cn } from "@/lib/utils";
import type { StepNodeModel } from "@/lib/ui/command-map";
import type { OfficeCore as OfficeCoreModel } from "@/lib/ui/office";
import { CLOUD_R, CORE, coreParticles, iso, SLAB_H, SYNTHESIS_AT, TW } from "@/lib/ui/office-layout";
import { PHASE_TONE, STATE_TONE } from "@/components/map/map-node";
import { PropBox } from "@/components/office/office-prism";

/** Screen radii of a floor circle of r tiles: the 2:1 projection turns it into an ellipse. */
const rx = (r: number) => (r * TW * Math.SQRT2) / 2;
const ry = (r: number) => rx(r) / 2;

const MOTES = coreParticles(24);
const AMBIENT_MOTES = coreParticles(12);

/**
 * The Brain core: a round plinth with a particle cloud above it, in the atmosphere phase colour. The rules are
 * the map core's: a slow ambient turn only on the idle floor, an orbit while the mission is live or replayed,
 * an inner counter-turn and a pulse while a fresh reservation exists, and nothing moving in a debrief, while
 * loading or under reduced motion. Particles turn as one group (one animated element per orbit).
 */
export function OfficeCore({ core, synthesis, reducedMotion }: { core: OfficeCoreModel; synthesis: StepNodeModel; reducedMotion: boolean }) {
  const c = iso(CORE.u, CORE.v);
  const top = iso(CORE.u, CORE.v, 0.35);
  const cloud = iso(CORE.u, CORE.v, 1.35);
  const tone = PHASE_TONE[core.phase];
  const moving = !reducedMotion && core.particles !== "still";
  const onMission = core.particles === "orbit" || core.particles === "energized" || (core.particles === "still" && core.phase !== "standby");
  const energized = core.particles === "energized";
  const motes = core.particles === "ambient" || (core.particles === "still" && !onMission) ? AMBIENT_MOTES : MOTES;
  const R = CORE.r;
  const synthTone = synthesis.state === "running" ? "var(--synth)" : STATE_TONE[synthesis.state];
  const synthTop = iso(SYNTHESIS_AT.u, SYNTHESIS_AT.v, SLAB_H + 0.55);
  return (
    <g className="office-core" style={{ color: tone }} aria-hidden="true">
      {/* floor light pool */}
      <ellipse cx={c.x} cy={c.y} rx={rx(R * 2.2)} ry={ry(R * 2.2)} fill="currentColor" opacity={onMission ? 0.06 : 0.035} />
      <ellipse cx={c.x} cy={c.y} rx={rx(R * 1.55)} ry={ry(R * 1.55)} fill="currentColor" opacity={onMission ? 0.08 : 0.045} />
      {/* plinth: the side band, then the top disc and its rings */}
      <path className="office-metal-left" d={`M ${c.x - rx(R)} ${c.y} A ${rx(R)} ${ry(R)} 0 0 0 ${c.x + rx(R)} ${c.y} L ${top.x + rx(R)} ${top.y} A ${rx(R)} ${ry(R)} 0 0 1 ${top.x - rx(R)} ${top.y} Z`} />
      <ellipse className="office-metal-top" cx={top.x} cy={top.y} rx={rx(R)} ry={ry(R)} />
      <ellipse cx={top.x} cy={top.y} rx={rx(R)} ry={ry(R)} fill="none" stroke="currentColor" strokeWidth={1.2} opacity={onMission ? 0.75 : 0.4} />
      <ellipse cx={top.x} cy={top.y} rx={rx(R * 0.7)} ry={ry(R * 0.7)} fill="none" stroke="currentColor" strokeWidth={1} strokeDasharray="2 6" opacity={0.6} />
      {core.alert && <ellipse className={cn("core-alert", !reducedMotion && core.particles !== "still" && "loop")} cx={top.x} cy={top.y} rx={rx(R * 1.25)} ry={ry(R * 1.25)} />}
      {/* the orbit: a flattened ring of motes turning as one group */}
      <g transform={`translate(${cloud.x} ${cloud.y}) scale(1 0.5)`}>
        <g className={cn("spin", moving && "loop", core.particles === "ambient" && "slow")}>
          <circle r={CLOUD_R * 1.55 + 6} fill="none" stroke="currentColor" strokeWidth={1} strokeDasharray="3 9" opacity={onMission ? 0.5 : 0.25} />
          {motes.map((m, i) => (
            <circle key={i} cx={m.x * 1.55} cy={m.y * 1.55} r={1.2 + (i % 3) * 0.6} fill="currentColor" opacity={onMission ? 0.55 + (i % 4) * 0.1 : 0.35} />
          ))}
        </g>
      </g>
      {/* the inner cloud: layered discs, no filter */}
      <circle cx={cloud.x} cy={cloud.y - 6} r={26} fill="currentColor" opacity={onMission ? 0.1 : 0.05} />
      <circle cx={cloud.x} cy={cloud.y - 6} r={18} fill="currentColor" opacity={onMission ? 0.14 : 0.07} />
      <circle cx={cloud.x} cy={cloud.y - 6} r={12} fill="currentColor" opacity={onMission ? 0.25 : 0.12} />
      <g transform={`translate(${cloud.x} ${cloud.y - 6})`}>
        <g className={cn("spin", energized && moving && "loop counter")}>
          <circle r={CLOUD_R * 0.65} fill="none" />
          {MOTES.slice(0, 10).map((m, i) => (
            <circle key={i} cx={m.x * 0.6} cy={m.y * 0.6} r={1.3} fill="currentColor" opacity={energized ? 0.9 : 0.45} />
          ))}
        </g>
      </g>
      <circle cx={cloud.x} cy={cloud.y - 6} r={6} fill="var(--text)" opacity={onMission ? 0.85 : 0.45} />
      {energized && moving && <ellipse className="core-pulse loop" cx={top.x} cy={top.y} rx={rx(R)} ry={ry(R)} />}
      {/* the synthesis console at the front rim */}
      <PropBox prop={{ ...SYNTHESIS_AT, du: 0.75, dv: 0.5, h: 0.55 }} z0={SLAB_H - 0.25} material="metal" />
      <ellipse cx={synthTop.x} cy={synthTop.y} rx={4} ry={2} style={{ fill: synthTone }} />
    </g>
  );
}
