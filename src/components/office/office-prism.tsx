"use client";
import type { FigureTone } from "@/lib/ui/office";
import { facePoly, footprintOf, iso, points, type Footprint, type Prop } from "@/lib/ui/office-layout";

/** The colour of a figure's or card's state (status owns colour; roles are told apart by their emblem). */
export const FIGURE_TONE: Record<FigureTone, string> = {
  active: "var(--signal)",
  stale: "var(--warn)",
  idle: "var(--dim)",
  unknown: "var(--text-faint)",
  pass: "var(--ok)",
  concern: "var(--warn)",
  fail: "var(--danger)",
  neutral: "var(--text-dim)",
};

/** The text colour of a state word on a card: like FIGURE_TONE, but an idle word stays readable. */
export const TEXT_TONE: Record<FigureTone, string> = { ...FIGURE_TONE, idle: "var(--text-dim)" };

export type Material = "wood" | "metal";

/** A box standing at height z0 with height h: its top and the two faces toward the viewer. */
export function Prism({ fp, z0, h, material }: { fp: Footprint; z0: number; h: number; material: Material }) {
  const z1 = z0 + h;
  const right = [iso(fp.u1, fp.v0, z0), iso(fp.u1, fp.v1, z0), iso(fp.u1, fp.v1, z1), iso(fp.u1, fp.v0, z1)];
  const left = [iso(fp.u0, fp.v1, z0), iso(fp.u1, fp.v1, z0), iso(fp.u1, fp.v1, z1), iso(fp.u0, fp.v1, z1)];
  return (
    <g>
      <polygon className={`office-${material}-right`} points={points(right)} />
      <polygon className={`office-${material}-left`} points={points(left)} />
      <polygon className={`office-${material}-top`} points={points(facePoly(fp, z1))} />
    </g>
  );
}

export function PropBox({ prop, z0, material }: { prop: Prop; z0: number; material: Material }) {
  return <Prism fp={footprintOf(prop)} z0={z0} h={prop.h} material={material} />;
}
