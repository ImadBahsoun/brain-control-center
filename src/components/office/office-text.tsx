"use client";
import { dateTime } from "@/lib/format";
import type { ResourceModel } from "@/lib/ui/resources";
import type { OfficeScene, Walker } from "@/lib/ui/office";
import { nodeName } from "@/lib/ui/command-map";
import { ROOM_TITLE } from "@/lib/ui/office-layout";

/** The governor's global lane behind a room, where one exists (shared by every mission). */
function lane(resources: ResourceModel, id: string): string {
  const meterId = id === "developer" ? "developers" : id === "qa" || id === "reviewer" || id === "security-reviewer" ? "validators" : null;
  const m = meterId ? resources.meters.find((x) => x.id === meterId) : undefined;
  if (!m) return "";
  return `; governor ${m.label.toLowerCase()} lane ${m.text}${meterId === "validators" ? ", shared by QA, Reviewer and Security across all missions" : ", all missions"}`;
}

/**
 * The office scene as text, for screen readers: one line per room (state, seat, numbers, other missions and
 * the governor lane), the core, the gate alert, the tokens walking now and every connection's state.
 */
export function OfficeText({ scene, walkers, resources }: { scene: OfficeScene; walkers: Walker[]; resources: ResourceModel }) {
  const where = scene.mode === "idle" ? "standby, no mission in focus" : scene.mode === "loading" ? `loading mission ${scene.missionId ?? ""}` : scene.mode === "replay" ? `replay of mission ${scene.missionId ?? ""}, recorded history` : `mission ${scene.missionId ?? ""}${scene.mode === "debrief" ? ", debrief" : ""}`;
  const alert = scene.gateAlert;
  return (
    <section className="sr-only" aria-label="Office scene as text">
      <h2>Office: {where}</h2>
      <ul>
        {scene.rooms.map((r) => (
          <li key={r.id}>
            {r.aria}
            {lane(resources, r.id)}
          </li>
        ))}
        <li>{scene.gate.aria}</li>
        <li>
          Brain core: {scene.core.statusText}; atmosphere {scene.atmo.label.toLowerCase()}
        </li>
        <li>
          Synthesis console: {scene.synthesis.statusText}. READY console: {scene.gate.ready.statusText}
        </li>
        {alert && (
          <li>
            {alert.recorded
              ? `Recorded: approval awaited at the ${alert.kind} gate (${alert.text})`
              : `Waiting on you at the ${alert.kind} gate (${alert.text})${alert.since ? `, requested ${dateTime(alert.since)}` : alert.outsideWindow ? ", the request is outside the loaded event window" : ""}. Approval happens in the Claude Code session, not here`}
          </li>
        )}
        {walkers.map((w) => (
          <li key={w.key}>
            Mission token {w.text} walking to {w.dest === "gate" ? "the gate room" : `${ROOM_TITLE[w.dest].toLowerCase()} (${nodeName(w.dest)})`}
          </li>
        ))}
        {scene.connections.map((e) => (
          <li key={e.id}>
            Connection {e.id} {e.label}, {nodeName(e.from)} to {nodeName(e.to)}: {e.stateText.toLowerCase()}
            {e.detail ? `, ${e.detail}` : ""}
          </li>
        ))}
      </ul>
    </section>
  );
}
