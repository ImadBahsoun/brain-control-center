"use client";
import type { OfficeMode } from "@/lib/ui/office-mode";

/**
 * Global Office / Mission Office: two pressed-state buttons, at least 44 px high. Rendered by MissionLayout as a
 * stable sibling of the scene, so a button keeps keyboard focus when the scene under it switches.
 */
export function OfficeModeToggle({ mode, onChange }: { mode: OfficeMode; onChange: (mode: OfficeMode) => void }) {
  return (
    <div role="group" aria-label="Office view" className="flex items-center gap-1">
      <button type="button" className="btn min-h-11" aria-pressed={mode === "global"} onClick={() => onChange("global")}>
        Global office
      </button>
      <button type="button" className="btn min-h-11" aria-pressed={mode === "mission"} onClick={() => onChange("mission")}>
        Mission office
      </button>
    </div>
  );
}
