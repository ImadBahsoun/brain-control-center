// The map's atmosphere: one visual phase per real mission state (lifecycle state, gate, blocked status and
// pending runs), so the colour of the operations room always follows recorded data. Pure.
import type { CommandMapModel } from "./command-map";

export type AtmospherePhase = "standby" | "build" | "scan" | "analyze" | "waiting" | "blocked" | "ready" | "complete";

export interface Atmosphere {
  phase: AtmospherePhase;
  /** The phase as a word, for the HUD (the text equivalent of the tint). */
  label: string;
  /** The security reviewer holds a pending run: the shield aura is drawn around it. */
  guardian: boolean;
  /** At least one pending run that is not over the stale threshold. */
  energized: boolean;
  /** The idle map's slow ambient motion (standby only, never on a mission). */
  ambient: boolean;
  /** Loops may run (live and replay); a debrief and a loading map are drawn static. */
  animated: boolean;
  source: string;
}

export const PHASE_LABEL: Record<AtmospherePhase, string> = {
  standby: "STANDBY",
  build: "BUILD",
  scan: "SCAN",
  analyze: "ANALYSIS",
  waiting: "AWAITING COMMANDER",
  blocked: "BLOCKED",
  ready: "READY",
  complete: "COMPLETE",
};

const BUILD_STATES = new Set(["RECEIVED", "CLASSIFYING", "PLANNING", "IMPLEMENTING", "FIXING", "COMMITTING", "PUSHING", "PR", "DEPLOYING"]);

function phaseOf(model: CommandMapModel): AtmospherePhase {
  const d = model.detail;
  if (!d) return "standby";
  if (d.status === "COMPLETE") return "complete";
  if (d.status === "CANCELLED" || d.status === "CORRUPT" || d.status === "INCOMPLETE") return "standby";
  if (d.status === "BLOCKED") return "blocked";
  if (model.gate.gate.active) return "waiting";
  const current = d.lifecycle.current ?? "";
  const qaPending = model.roles.some((r) => r.id === "qa" && r.state === "running");
  if (current === "READY") return "ready";
  if (current === "TESTING") return "scan";
  if (current === "VALIDATING" || current === "REVALIDATING") return qaPending ? "scan" : "analyze";
  if (current === "REVIEWING" || current === "SYNTHESIZING") return "analyze";
  if (BUILD_STATES.has(current)) return "build";
  return "standby";
}

export function atmosphere(model: CommandMapModel): Atmosphere {
  const phase = phaseOf(model);
  const onMission = model.detail !== null;
  const pending = onMission ? model.roles.filter((r) => r.state === "running") : [];
  return {
    phase,
    label: PHASE_LABEL[phase],
    guardian: pending.some((r) => r.id === "security-reviewer"),
    energized: pending.some((r) => !r.stale),
    ambient: model.mode === "idle",
    animated: model.mode === "live" || model.mode === "replay",
    source: model.detail ? `/api/tasks/${model.detail.id} status, lifecycle.current, agents` : "/api/tasks (no mission in focus)",
  };
}
