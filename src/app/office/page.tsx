"use client";
import { useEffect } from "react";
import { mapWheelMode, touchGestures } from "@/lib/ui/focus-mode";
import { STEP_MS } from "@/lib/ui/replay";
import { useMissionView } from "@/hooks/use-mission-view";
import { useOfficeMode } from "@/hooks/use-office-mode";
import { MapAtmosphere } from "@/components/map/map-atmosphere";
import { GlobalOfficeScene } from "@/components/office/global-office-scene";
import { OfficeModeToggle } from "@/components/office/office-mode-toggle";
import { OfficeScene } from "@/components/office/office-scene";
import { MissionLayout } from "@/components/shell/mission-layout";

/** Effects live a little longer here than on the map, so a 2.4 s walk finishes before its token is removed. */
const OFFICE_EFFECT_MS = 2600;

export default function OfficePage() {
  const v = useMissionView({ effectLifetimeMs: OFFICE_EFFECT_MS });
  // Global Office (every open mission) or Mission Office (the focused mission); remembered per browser (office-mode.ts)
  const [mode, setMode] = useOfficeMode();
  const global = mode === "global";
  // a replay belongs to Mission Office: entering Global Office (chosen or remembered) ends it, without moving
  // keyboard focus off the toggle (leaveReplay would return it to the Replay button). It also cancels one that
  // was requested but is still loading its events, so it never opens, shows its loading line or its error in
  // Global Office; exit() is idempotent.
  const exitReplay = v.replay.exit;
  useEffect(() => {
    if (global) exitReplay();
  }, [global, exitReplay]);
  return (
    <MissionLayout
      view={v}
      variant={mode}
      sceneTools={<OfficeModeToggle mode={mode} onChange={setMode} />}
      scene={
        global ? (
          <GlobalOfficeScene agents={v.agents.data} tasks={v.tasks.data} governor={v.governor.data} reducedMotion={v.reducedMotion} wheelZoom={mapWheelMode(v)} focused={v.focus} touchGestures={touchGestures(v)} />
        ) : (
          <>
            <MapAtmosphere atmo={v.atmo} reducedMotion={v.reducedMotion} />
            <OfficeScene
              model={v.shown}
              effects={v.effects}
              selection={v.selection}
              onSelect={v.select}
              reducedMotion={v.reducedMotion}
              wheelZoom={mapWheelMode(v)}
              focused={v.focus}
              touchGestures={touchGestures(v)}
              agents={v.replaying ? null : v.agents.data}
              stepMs={v.replaying ? STEP_MS[v.replay.state.speed] : null}
            />
          </>
        )
      }
    />
  );
}
