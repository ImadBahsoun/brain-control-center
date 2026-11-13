"use client";
import { useMissionView } from "@/hooks/use-mission-view";
import { mapWheelMode, touchGestures } from "@/lib/ui/focus-mode";
import { CommandMap } from "@/components/map/command-map";
import { MapAtmosphere } from "@/components/map/map-atmosphere";
import { MissionLayout } from "@/components/shell/mission-layout";

export default function CommandMapPage() {
  const v = useMissionView();
  return (
    <MissionLayout
      view={v}
      scene={
        <>
          <MapAtmosphere atmo={v.atmo} reducedMotion={v.reducedMotion} />
          <CommandMap model={v.shown} effects={v.effects} selection={v.selection} onSelect={v.select} reducedMotion={v.reducedMotion} wheelZoom={mapWheelMode(v)} focused={v.focus} touchGestures={touchGestures(v)} />
        </>
      }
    />
  );
}
