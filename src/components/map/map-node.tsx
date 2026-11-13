"use client";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { Atmosphere, AtmospherePhase } from "@/lib/ui/atmosphere";
import { STATE_WORD, type CoreNodeModel, type EdgeState, type GateNodeModel, type MapMode, type RoleNodeModel, type StepNodeModel } from "@/lib/ui/command-map";
import { LABEL_GAP, labelShift, NODES, type NodeId } from "@/lib/ui/layout";
import { MapGlyph } from "@/components/ui/glyphs";
import { RoleEmblem } from "@/components/map/role-emblem";

export type Opener = HTMLElement | SVGElement;

/** An interactive map element: a button that opens a panel, for the pointer and the keyboard, with a visible focus ring. */
export function MapItem({
  label,
  selected,
  onSelect,
  className,
  children,
  ring,
}: {
  label: string;
  selected: boolean;
  onSelect: (opener: Opener) => void;
  className?: string;
  children: ReactNode;
  /** The focus ring element, drawn last so it sits on top. */
  ring: ReactNode;
}) {
  const onKey = (e: KeyboardEvent<SVGGElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      onSelect(e.currentTarget);
    }
  };
  const onClick = (e: MouseEvent<SVGGElement>) => {
    e.stopPropagation();
    onSelect(e.currentTarget);
  };
  return (
    <g role="button" tabIndex={0} aria-label={label} aria-haspopup="dialog" aria-expanded={selected} className={cn("map-item", selected && "selected", className)} onClick={onClick} onKeyDown={onKey}>
      {children}
      {ring}
    </g>
  );
}

export const STATE_TONE: Record<EdgeState, string> = {
  completed: "var(--ok)",
  running: "var(--signal)",
  pending: "var(--dim)",
  "waiting-approval": "var(--warn)",
  blocked: "var(--danger)",
  failed: "var(--danger)",
  skipped: "var(--dim)",
  unknown: "var(--text-faint)",
};

/** The word under a node (defined with the model, re-exported for the map components). */
export { STATE_WORD };

/** The colour of the core and the atmosphere per phase. */
export const PHASE_TONE: Record<AtmospherePhase, string> = {
  standby: "var(--text-dim)",
  build: "var(--signal)",
  scan: "var(--scan)",
  analyze: "var(--synth)",
  waiting: "var(--warn)",
  blocked: "var(--danger)",
  ready: "var(--ok)",
  complete: "var(--ok)",
};

function toneFor(node: RoleNodeModel): string {
  if (node.state === "running" && node.stale) return "var(--warn)";
  if (node.state === "completed") {
    if (node.verdictTone === "concern") return "var(--warn)";
    if (node.verdictTone === "fail") return "var(--danger)";
  }
  return STATE_TONE[node.state];
}

interface LabelLine {
  text: string;
  className: string;
  fill?: string;
  /** A dimmer second part of the same line (the role's activity after its state word). */
  suffix?: string;
}

/** Pitch of the three-line role block and of the two-line step / gate block (world units; see LABEL_BLOCK_HEIGHT). */
const ROLE_PITCH = 20;
const SHORT_PITCH = 17;

/** The label lines on the node's label side (labels sit where no edge runs); the block reads top-down either way. */
function Labels({ id, lines, pitch }: { id: NodeId; lines: LabelLine[]; pitch: number }) {
  const n = NODES[id];
  const shift = labelShift(id);
  const below = n.labelSide === "below";
  // below: the first baseline sits a cap height under the block's top; above: the last one 4 units over its bottom
  const first = below ? n.r + LABEL_GAP + 12 : -n.r - LABEL_GAP - 4 - pitch * (lines.length - 1);
  return (
    <g transform={`translate(${shift} 0)`}>
      {lines.map((l, i) => (
        <text key={i} className={l.className} y={first + i * pitch} style={l.fill ? { fill: l.fill } : undefined}>
          {l.text}
          {l.suffix ? <tspan className="node-activity">{` · ${l.suffix}`}</tspan> : null}
        </text>
      ))}
    </g>
  );
}

/** A shield outline around a node (the Guardian's aura while the security reviewer holds a reservation). */
function shieldPath(r: number): string {
  const w = r + 9;
  const top = -(r + 9);
  return `M0 ${top} L${w} ${-r * 0.5} V${r * 0.15} C${w} ${r * 0.62} ${w * 0.52} ${r * 0.92} 0 ${r + 5} C${-w * 0.52} ${r * 0.92} ${-w} ${r * 0.62} ${-w} ${r * 0.15} V${-r * 0.5} Z`;
}

export function RoleNode({
  node,
  activity,
  action,
  mission,
  missionId,
  guardian,
  selected,
  onSelect,
  reducedMotion,
  animated,
}: {
  node: RoleNodeModel;
  /** What the role is doing (hud.ts roleActivity), drawn dim after the state word; empty when there is nothing to add. */
  activity: string;
  /** The role's action in words (hud.ts roleAction): the run's verb with "reserved, awaiting report", for the accessible name. */
  action: string;
  /** "#0002" when the role has a run on the focused mission. */
  mission: string | null;
  missionId: string | null;
  /** The security reviewer holds a reservation: the shield aura is drawn. */
  guardian: boolean;
  selected: boolean;
  onSelect: (o: Opener) => void;
  reducedMotion: boolean;
  /** Loops may run (live or replay). */
  animated: boolean;
}) {
  const L = NODES[node.id];
  const r = L.r;
  const tone = toneFor(node);
  const units = node.unitsPerRun !== null ? `${node.unitsPerRun}U` : null;
  const sub = [node.archetype.toUpperCase(), node.model?.toUpperCase(), units].filter(Boolean).join(" · ");
  const aria = `${node.stepNo} ${node.label}, ${node.archetype}: ${node.stateWord}; ${action}${mission && missionId ? `, mission ${missionId}` : ""}${node.model ? `, model ${node.model}` : ""}${units ? `, ${node.unitsPerRun} governor units per run` : ""}${node.openFindings > 0 ? `, ${node.openFindings} open finding(s)` : ""}`;
  const dormant = node.state === "pending" && !node.latestRun;
  const loop = animated && !reducedMotion;
  return (
    <MapItem
      label={aria}
      selected={selected}
      onSelect={onSelect}
      className={cn("node", `st-${node.state}`, node.state === "running" && node.stale && "stale", dormant && "dormant")}
      ring={<circle className="focus-ring" cx={L.x} cy={L.y} r={r + 7} />}
    >
      <title>{aria}</title>
      <g transform={`translate(${L.x} ${L.y})`}>
        {guardian && (
          <>
            <path className="guardian-aura" d={shieldPath(r)} />
            {loop && <path className="guardian-ring loop" d={shieldPath(r)} />}
          </>
        )}
        <circle className="node-ring-glow" r={r} />
        <circle className="node-fill" r={r} />
        <circle className="node-ring" r={r} />
        {node.state === "running" && !node.stale && loop && <circle className="ring-current loop" r={r} />}
        <circle className="hit-fill" r={r} />
        {/* step number inside the top of the circle: the top outside is where a report trace may leave */}
        <text className="node-no" y={-r + 16}>
          {node.stepNo}
        </text>
        <g transform="translate(0 -3)">
          <RoleEmblem role={node.id} size={26} />
        </g>
        {mission && (
          <text className="node-meta" y={r - 9}>
            {mission}
          </text>
        )}
        <Labels
          id={node.id}
          pitch={ROLE_PITCH}
          lines={[
            { text: node.label.toUpperCase(), className: "node-title" },
            { text: sub, className: "node-sub" },
            { text: node.stateWord, className: "node-status", fill: tone, suffix: activity || undefined },
          ]}
        />
        {node.openFindings > 0 && (
          <g transform={`translate(${r * 0.72} ${-r * 0.72})`}>
            <circle r={12} fill="oklch(0.2 0.03 80)" stroke="var(--warn)" strokeWidth={1} />
            <text className="node-badge" y={5}>
              {node.openFindings}
            </text>
          </g>
        )}
      </g>
    </MapItem>
  );
}

export function CoreNode({ node, atmo, selected, onSelect, reducedMotion, mode }: { node: CoreNodeModel; atmo: Atmosphere; selected: boolean; onSelect: (o: Opener) => void; reducedMotion: boolean; mode: MapMode }) {
  const L = NODES.core;
  const r = L.r;
  const blocked = node.status === "BLOCKED";
  // a focus whose detail failed to load reads ERROR, not LOADING (the reason is in the core's label and panel)
  const failed = mode === "loading" && node.statusText.startsWith("ERROR");
  const word = blocked ? "BLOCKED" : node.status === "COMPLETE" ? "COMPLETE" : node.status === "CANCELLED" ? "CANCELLED" : node.status === "CORRUPT" || node.status === "INCOMPLETE" ? node.status : mode === "replay" ? "REPLAY" : mode === "live" ? "LIVE" : failed ? "ERROR" : mode === "loading" ? "LOADING" : "STANDBY";
  const tone = PHASE_TONE[atmo.phase];
  const loop = atmo.animated && !reducedMotion;
  const ambient = atmo.ambient && !reducedMotion;
  const energized = atmo.energized && atmo.animated;
  const onMission = mode !== "idle" && mode !== "loading";
  return (
    <MapItem label={`Brain command core: ${node.statusText}; atmosphere ${atmo.label.toLowerCase()}`} selected={selected} onSelect={onSelect} className={cn("core", `phase-${atmo.phase}`)} ring={<circle className="focus-ring" cx={L.x} cy={L.y} r={r + 22} />}>
      <g transform={`translate(${L.x} ${L.y})`} style={{ color: tone }}>
        <circle className={cn("core-glow", onMission && "on", energized && "energized")} r={r + 4} />
        {/* the outer ring turns while loops may run, and very slowly on the idle map */}
        <circle className={cn("core-outer", onMission && "on", "spin", loop && "loop", ambient && "loop slow")} r={r + 14} />
        {ambient &&
          [0, 1, 2].map((i) => (
            <circle key={i} className="core-mote loop" r={1.8} style={{ offsetPath: `path("M 0 ${-(r + 26)} A ${r + 26} ${r + 26} 0 1 1 0 ${r + 26} A ${r + 26} ${r + 26} 0 1 1 0 ${-(r + 26)}")`, animationDelay: `${-i * 12}s` }} />
          ))}
        {blocked && <circle className={cn("core-alert", loop && "loop")} r={r + 8} />}
        <circle className="node-fill" r={r} />
        <circle className={cn("core-mid", onMission && "on")} r={r} />
        <circle className={cn("core-inner", onMission && "on", "spin", energized && loop && "loop counter")} r={r - 14} />
        {energized && loop && <circle className="core-pulse loop" r={r} />}
        <circle className="hit-fill" r={r} />
        <text className="core-title" y={-8}>
          BRAIN
        </text>
        <text className="core-sub" y={12}>
          COMMAND CORE
        </text>
        <g transform="translate(0 36)">
          <MapGlyph name="dot" x={-(word.length * 6) - 9} y={-5} size={10} className={cn(loop && "loop blink")} />
          <text className="core-state" style={{ fill: blocked || failed ? "var(--danger)" : onMission ? tone : "var(--text-dim)" }}>
            {word}
          </text>
        </g>
      </g>
    </MapItem>
  );
}

export function StepNode({ node, selected, onSelect, reducedMotion, animated }: { node: StepNodeModel; selected: boolean; onSelect: (o: Opener) => void; reducedMotion: boolean; animated: boolean }) {
  const L = NODES[node.id];
  const r = L.r;
  const tone = STATE_TONE[node.state];
  const word = node.state === "running" ? "IN PROGRESS" : node.statusText === "IDLE" || node.statusText === "LOADING" ? node.statusText : STATE_WORD[node.state];
  return (
    <MapItem label={`${node.stepNo} ${node.label}: ${node.statusText}`} selected={selected} onSelect={onSelect} className={cn("node", `st-${node.state}`)} ring={<circle className="focus-ring" cx={L.x} cy={L.y} r={r + 7} />}>
      <g transform={`translate(${L.x} ${L.y})`}>
        <circle className="node-ring-glow" r={r} />
        <circle className="node-fill" r={r} />
        <circle className="node-ring" r={r} />
        {node.state === "running" && animated && !reducedMotion && <circle className="ring-current loop" r={r} />}
        <circle className="hit-fill" r={r} />
        {node.id === "synthesis" ? (
          <g className="emblem" transform="translate(0 6)" aria-hidden="true">
            <path d="M-12 -8 L0 0 L12 -8 M-12 0 L0 0 L12 0 M-12 8 L0 0 L12 8 M0 0 V12" />
          </g>
        ) : node.state === "completed" ? (
          <MapGlyph name="check" x={0} y={6} size={20} className="tone-ok" />
        ) : (
          <g className="emblem" transform="translate(0 6)" aria-hidden="true">
            <path d="M-9 0 H9 M0 -9 V9" />
          </g>
        )}
        <text className="node-no" y={-r + 16}>
          {node.stepNo}
        </text>
        <Labels
          id={node.id}
          pitch={SHORT_PITCH}
          lines={[
            { text: node.label.toUpperCase(), className: "node-title" },
            { text: word, className: "node-status", fill: tone },
          ]}
        />
      </g>
    </MapItem>
  );
}

export function GateNode({ node, selected, onSelect, reducedMotion, animated }: { node: GateNodeModel; selected: boolean; onSelect: (o: Opener) => void; reducedMotion: boolean; animated: boolean }) {
  const L = NODES.gate;
  const r = L.r;
  const tone = STATE_TONE[node.state];
  const d = `M0 ${-r} L${r} 0 L0 ${r} L${-r} 0 Z`;
  return (
    <MapItem label={`${node.stepNo} Commander Gate: ${node.statusText}`} selected={selected} onSelect={onSelect} className={cn("node", `st-${node.state}`)} ring={<circle className="focus-ring" cx={L.x} cy={L.y} r={r + 8} />}>
      <g transform={`translate(${L.x} ${L.y})`}>
        <path className="node-ring-glow" d={d} />
        <path className="node-fill" d={d} />
        <path className="node-ring" d={d} />
        {node.state === "waiting-approval" && animated && !reducedMotion && <path className="ring-current loop" d={d} style={{ stroke: "var(--warn)" }} />}
        <path className="hit-fill" d={d} />
        <MapGlyph name="lock" x={0} y={-1} size={20} className={node.state === "waiting-approval" ? "tone-warn" : node.state === "completed" ? "tone-ok" : "tone-dim"} />
        <text className="node-no" y={-r - 12}>
          {node.stepNo}
        </text>
        <Labels
          id="gate"
          pitch={SHORT_PITCH}
          lines={[
            { text: "CMDR GATE", className: "node-title" },
            { text: node.stateWord, className: "node-status", fill: tone },
          ]}
        />
      </g>
    </MapItem>
  );
}
