"use client";
import type { Atmosphere } from "@/lib/ui/atmosphere";

/**
 * The operations-room atmosphere under the map: a static tint in the phase colour, plus a radar sweep while
 * testing and a warning pulse while blocked, both only while loops may run (live or replay). Decorative:
 * the phase is also the HUD's text. Opacity and transform only, no filters; every loop is a `.loop`.
 */
export function MapAtmosphere({ atmo, reducedMotion }: { atmo: Atmosphere; reducedMotion: boolean }) {
  const loop = atmo.animated && !reducedMotion;
  return (
    <div className="atmo pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      <div className="atmo-tint absolute inset-0" />
      {atmo.phase === "scan" && loop && <div className="atmo-sweep loop" />}
      {atmo.phase === "blocked" && <div className={loop ? "atmo-alert absolute inset-0 loop" : "atmo-alert absolute inset-0"} />}
    </div>
  );
}
