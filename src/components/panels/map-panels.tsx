"use client";
import type { AgentsResponse, EventsResponse, GovernorResponse, HealthResponse, TasksResponse } from "@/lib/api-types";
import type { CommandMapModel } from "@/lib/ui/command-map";
import type { Selection } from "@/lib/ui/selection";
import { isRole } from "@/lib/ui/roles";
import type { Opener } from "@/components/map/map-node";
import { CharacterPanel } from "@/components/panels/character-panel";
import { CorePanel } from "@/components/panels/core-panel";
import { EdgePanel, StepPanel } from "@/components/panels/edge-panel";
import { FindingPanel } from "@/components/panels/finding-panel";
import { GatePanel } from "@/components/panels/gate-panel";
import { SidePanel } from "@/components/panels/side-panel";

export interface PanelData {
  model: CommandMapModel;
  events: EventsResponse | null;
  governor: GovernorResponse | null;
  health: HealthResponse | null;
  agents: AgentsResponse | null;
  tasks: TasksResponse | null;
  /** The model is a replay frame: governor, agents and health sections say they are not part of the recorded history. */
  replay?: boolean;
}

/** Renders the right-side panel for the current selection, or nothing. */
export function MapPanels({ selection, data, onClose, onSelect }: { selection: Selection | null; data: PanelData; onClose: () => void; onSelect: (sel: Selection, opener: Opener | null) => void }) {
  if (!selection) return null;
  const { model } = data;
  const openFinding = (id: string, opener: Opener) => onSelect({ kind: "threat", id }, opener);

  if (selection.kind === "gate") {
    const active = model.gate.gate.active;
    const need = data.replay ? "approval awaited (recorded)" : "action required";
    const kicker = active === "plan" ? `08 · plan gate · ${need}` : active === "human" ? `08 · human approval · ${need}` : "08 · human approval";
    return (
      <SidePanel title="Commander Gate" kicker={kicker} tone={active ? "tone-warn" : undefined} onClose={onClose}>
        <GatePanel node={model.gate} replay={data.replay ?? false} />
      </SidePanel>
    );
  }
  if (selection.kind === "threat") {
    const f = model.findings.find((x) => x.id === selection.id);
    if (!f) {
      return (
        <SidePanel title={selection.id} kicker="finding" onClose={onClose}>
          <p className="text-faint">This finding is not in the focused mission&apos;s findings.</p>
        </SidePanel>
      );
    }
    return (
      <SidePanel title={f.id} kicker={`${f.severity} · finding`} tone={f.severity === "BLOCKER" ? "tone-danger" : f.severity === "MAJOR" ? "tone-warn" : undefined} onClose={onClose}>
        <FindingPanel finding={f} missionId={model.missionId} />
      </SidePanel>
    );
  }
  if (selection.kind === "edge") {
    const edge = model.edges.find((e) => e.id === selection.id);
    if (!edge) return null;
    return (
      <SidePanel title={`${edge.label}`} kicker={`connection ${edge.id}`} onClose={onClose}>
        <EdgePanel edge={edge} model={model} />
      </SidePanel>
    );
  }
  const id = selection.id;
  if (id === "core") {
    return (
      <SidePanel title="Brain · Command core" kicker={model.core.statusText} onClose={onClose}>
        <CorePanel model={model} health={data.health} governor={data.governor} tasks={data.tasks} onOpenFinding={openFinding} replay={data.replay ?? false} />
      </SidePanel>
    );
  }
  if (id === "synthesis" || id === "ready") {
    const node = id === "synthesis" ? model.synthesis : model.ready;
    return (
      <SidePanel title={node.label} kicker={`${node.stepNo} · lifecycle step`} onClose={onClose}>
        <StepPanel node={node} model={model} />
      </SidePanel>
    );
  }
  if (isRole(id)) {
    const node = model.roles.find((r) => r.id === id);
    if (!node) return null;
    return (
      <SidePanel title={node.label} kicker={`${node.stepNo} · ${node.archetype}${node.model ? ` · ${node.model}` : ""}`} onClose={onClose}>
        <CharacterPanel node={node} model={model} events={data.events} governor={data.governor} agents={data.agents} onOpenFinding={openFinding} replay={data.replay ?? false} />
      </SidePanel>
    );
  }
  return null;
}
