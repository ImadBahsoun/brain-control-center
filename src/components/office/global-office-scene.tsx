"use client";
import { useRouter } from "next/navigation";
import type { CSSProperties, KeyboardEvent, MouseEvent, ReactNode } from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { AgentsResponse, GlobalUsage, GovernorResponse, TasksResponse } from "@/lib/api-types";
import type { StepNodeModel } from "@/lib/ui/command-map";
import { GLOBAL_ROSTER_FOLD_KEY } from "@/lib/ui/fold-state";
import { buildGlobalOffice, busyWords, CARD_PAD, globalGateCard, globalRoomCard, globalWalks, instanceWords, missionHref, STATE_WORDS, type ActivityLine, type GlobalInstance, type GlobalRoom, type GlobalWalk } from "@/lib/ui/global-office";
import {
  doorFace,
  figureBox,
  figurePoint,
  GLOBAL_CORE_LINES,
  GLOBAL_DESKS,
  GLOBAL_FLOOR_PATHS,
  GLOBAL_FOOTPRINTS,
  globalCardBox,
  globalRoomHull,
  globalSeats,
  linePlates,
  overflowBox,
  queueSpots,
  queueTagSide,
  seatHitBox,
  tagBox,
  type GlobalDesk,
  type GlobalPosture,
} from "@/lib/ui/global-office-layout";
import type { Box, Point } from "@/lib/ui/layout";
import { MAX_WALKERS, RELEASE_STEPS, type GateRoomModel, type OfficeCore as OfficeCoreModel } from "@/lib/ui/office";
import { boxPoly, coreHull, CORE_FOOTPRINT, depthOrder, OFFICE_ROOM_IDS, OFFICE_WORLD, points, ROOM_TITLE, SLAB_H, sortRoomItems, type DepthItem, type UV } from "@/lib/ui/office-layout";
import { toTransform } from "@/lib/ui/viewport";
import { cn } from "@/lib/utils";
import { useFoldFocus, useFoldState } from "@/hooks/use-fold-state";
import { usePanZoom, type WheelZoom } from "@/hooks/use-pan-zoom";
import { MapControls } from "@/components/map/map-controls";
import { particlePeriod } from "@/components/map/map-edge";
import { OfficeBackdrop } from "@/components/office/office-backdrop";
import { OfficeCore } from "@/components/office/office-core";
import { GlobalCapacity } from "@/components/office/global-capacity";
import { GlobalRoster } from "@/components/office/global-roster";
import { PropBox } from "@/components/office/office-prism";
import { FrontGlass, OfficeGateRoom, RoomShell } from "@/components/office/office-room";
import { OfficeWalker } from "@/components/office/office-walker";

export interface GlobalOfficeSceneProps {
  /** The polls useMissionView already makes; this view adds none. */
  agents: AgentsResponse | null;
  tasks: TasksResponse | null;
  governor: GovernorResponse | null;
  reducedMotion: boolean;
  wheelZoom: WheelZoom;
  focused?: boolean;
  touchGestures?: boolean;
}

const CENTER = { x: OFFICE_WORLD.width / 2, y: OFFICE_WORLD.height / 2 };
const DEPTH = depthOrder<DepthItem>([...OFFICE_ROOM_IDS.map((id) => ({ id, fp: GLOBAL_FOOTPRINTS[id], hull: globalRoomHull(id) })), { id: "core", fp: CORE_FOOTPRINT, hull: coreHull() }]);

const TONE: Record<GlobalInstance["state"], string> = { running: "var(--signal)", stale: "var(--warn)", queued: "var(--text-dim)" };
const PAD = CARD_PAD;
const FIRST = 22;
const PITCH = 17.5;
const PARTICLES = 3;
/** A walker is taken off the floor this long after its walk ends. */
const WALK_LINGER_MS = 200;

/**
 * The faint dotted floor paths from the core's rim to every door, the gate's too: decor only, the same under every
 * state and still under any motion setting. The activity lines are drawn over them.
 */
function GlobalFloorPaths() {
  return (
    <g className="floor-paths" aria-hidden="true">
      {OFFICE_ROOM_IDS.map((id) => (
        <path key={id} className="office-floor-path" d={GLOBAL_FLOOR_PATHS[id]} />
      ))}
    </g>
  );
}

/**
 * A role room's activity line on the floor: the Mission Office's core↔room connection strokes (the active style
 * while an instance runs, the dimmer dashed pending style while only queued), with the flow particles only when
 * motion is allowed and the static dashes otherwise. Decorative: no focus stop; the text version names it.
 */
function GlobalActivityLine({ line, loop }: { line: ActivityLine; loop: boolean }) {
  const g = GLOBAL_CORE_LINES[line.role];
  const running = line.tone === "running";
  const period = particlePeriod(g.length);
  const particle = (i: number): CSSProperties => ({ offsetPath: `path("${g.path}")`, animationDuration: `${period}s`, animationDelay: `${(-i * period) / PARTICLES}s` });
  return (
    <g className={cn("edge", running ? "st-running" : "st-pending")}>
      <path className="edge-glow" d={g.path} />
      <path className="edge-base" d={g.path} />
      {running && !loop && <path className="edge-static-flow" d={g.path} />}
      {running &&
        loop &&
        Array.from({ length: PARTICLES }, (_, i) => (
          <g key={i}>
            <circle className="particle-halo loop" r={6} style={particle(i)} />
            <circle className="particle loop" r={2.4} style={particle(i)} />
          </g>
        ))}
    </g>
  );
}

/** A figure without the role badge (the room names the role): its mission tag shows above its head instead. */
function GlobalFigure({ p, posture, tone, glow, loop }: { p: Point; posture: GlobalPosture; tone: string; glow: boolean; loop: boolean }) {
  const seated = posture === "seated";
  const hip = seated ? -9 : -14;
  const shoulder = hip - 16;
  const head = shoulder - 6.5;
  return (
    <g transform={`translate(${p.x} ${p.y})`}>
      <ellipse className="office-shadow" cx={0} cy={0} rx={9} ry={4.5} />
      {glow && <ellipse className={cn("office-glow", loop && "loop")} cx={4} cy={hip - 6} rx={13} ry={9} style={{ fill: tone }} />}
      {!seated && <path className="office-figure-leg" d={`M-5 0 h3.6 v${hip} h-3.6 Z M1.4 0 h3.6 v${hip} h-3.6 Z`} />}
      <path className="office-figure-body" d={`M-6 ${hip} L6 ${hip} L7.5 ${shoulder + 3} Q7.5 ${shoulder} 4.5 ${shoulder} L-4.5 ${shoulder} Q-7.5 ${shoulder} -7.5 ${shoulder + 3} Z`} />
      <path d={`M-3 ${shoulder + 1.5} L0 ${shoulder + 4.5} L3 ${shoulder + 1.5}`} fill="none" stroke={tone} strokeWidth={1.4} strokeLinecap="round" />
      <circle className="office-figure-head" cx={0} cy={head} r={5.5} />
    </g>
  );
}

function Plate({ box, text, tone }: { box: Box; text: string; tone: string }) {
  return (
    <g>
      <rect className="office-tag-bg" x={box.x} y={box.y} width={box.w} height={box.h} rx={3} style={{ stroke: tone }} />
      <text className="office-tag" x={box.x + box.w / 2} y={box.y + 16}>
        {text}
      </text>
    </g>
  );
}

interface Placed {
  inst: GlobalInstance;
  at: UV;
  p: Point;
  posture: GlobalPosture;
}

/** Where each drawn instance of a room is: at a desk in the room, or queued at its door. Only instances are placed. */
function placed(room: GlobalRoom): Placed[] {
  const seats = globalSeats(room.id, room.seated.length);
  const spots = queueSpots(room.id, room.waiting.length);
  return [
    ...room.seated.flatMap((inst, i) => {
      const at = seats[i];
      return at ? [{ inst, at, p: figurePoint(at, "seated"), posture: "seated" as const }] : [];
    }),
    ...room.waiting.flatMap((inst, i) => {
      const at = spots[i];
      return at ? [{ inst, at, p: figurePoint(at, "standing"), posture: "standing" as const }] : [];
    }),
  ];
}

type Item = UV & { z?: number; key: string; node: ReactNode };

/** One desk, its dark monitor and its chair: decor only, the same whether anyone sits there or not. */
function deskItems(d: GlobalDesk, i: number): Item[] {
  const top = SLAB_H + d.desk.h;
  return [
    { key: `chair:${i}`, ...d.chair, node: <PropBox prop={d.chair} z0={SLAB_H} material="metal" /> },
    { key: `desk:${i}`, ...d.desk, node: <PropBox prop={d.desk} z0={SLAB_H} material="wood" /> },
    { key: `monitor:${i}`, ...d.monitor, z: top, node: <PropBox prop={d.monitor} z0={top} material="metal" /> },
  ];
}

/** A role room: six desks, a figure at a desk only for a running or stale instance; queued figures line up at its door. */
function GlobalRoleRoom({ room, loop }: { room: GlobalRoom; loop: boolean }) {
  const fp = GLOBAL_FOOTPRINTS[room.id];
  const all = placed(room);
  const figures: Item[] = all
    .filter((x) => x.posture === "seated")
    .map((x) => ({ key: `fig:${x.inst.key}`, ...x.at, node: <GlobalFigure p={x.p} posture="seated" tone={TONE[x.inst.state]} glow={x.inst.state === "running"} loop={loop} /> }));
  const items = [...GLOBAL_DESKS[room.id].flatMap(deskItems), ...figures];
  const queue = all
    .filter((x) => x.posture === "standing")
    .map((x) => <GlobalFigure key={x.inst.key} p={x.p} posture="standing" tone={TONE.queued} glow={false} loop={false} />);
  // a door on a back wall: the queue stands behind the room, so it is drawn first
  const behind = doorFace(room.id) === "u0" || doorFace(room.id) === "v0";
  const tint = room.running > 0 ? "var(--signal)" : room.stale > 0 ? "var(--warn)" : null;
  return (
    <g className="office-room" aria-hidden="true">
      {behind && <g>{queue}</g>}
      <RoomShell fp={fp} tint={tint} />
      {sortRoomItems(items).map((it) => (
        <g key={it.key}>{it.node}</g>
      ))}
      <FrontGlass fp={fp} />
      {!behind && <g>{queue}</g>}
    </g>
  );
}

function CardFrame({ box, title, right, rightTone = "var(--text-dim)" }: { box: Box; title: string; right?: string | null; rightTone?: string }) {
  return (
    <>
      <rect className="office-card-bg" x={box.x} y={box.y} width={box.w} height={box.h} rx={3} />
      <text className="office-title" x={box.x + PAD} y={box.y + FIRST}>
        {title}
      </text>
      {right && (
        <text className="office-num" x={box.x + box.w - PAD} y={box.y + FIRST} style={{ textAnchor: "end", fill: rightTone }}>
          {right}
        </text>
      )}
      <line className="office-card-rule" x1={box.x + PAD} x2={box.x + box.w - PAD} y1={box.y + FIRST + 6} y2={box.y + FIRST + 6} />
    </>
  );
}

/** A room card: the title with "n/m busy" (n from room.running), then queued · stale and the limit's lane. */
function GlobalRoomCard({ room, totals }: { room: GlobalRoom; totals: GlobalUsage }) {
  const box = globalCardBox(room.id);
  const lineY = (n: number) => box.y + FIRST + PITCH * n;
  const card = globalRoomCard(room, totals);
  return (
    <g className="office-card" aria-hidden="true">
      <CardFrame box={box} title={card.title} right={card.right} rightTone={room.running > 0 ? "var(--signal)" : "var(--text-dim)"} />
      {card.rows.map((row, k) => (
        <g key={k}>
          <text className="office-row" x={box.x + PAD} y={lineY(1 + k)}>
            {row.label}
          </text>
          <text className="office-num" x={box.x + box.w - PAD} y={lineY(1 + k)} style={{ textAnchor: "end", fill: row.warn ? "var(--warn)" : "var(--text)" }}>
            {row.value}
          </text>
        </g>
      ))}
    </g>
  );
}

function GateDecorCard({ waiting }: { waiting: number | null }) {
  const box = globalCardBox("gate");
  const lineY = (n: number) => box.y + FIRST + PITCH * n;
  const card = globalGateCard(waiting);
  return (
    <g className="office-card" aria-hidden="true">
      <CardFrame box={box} title={card.title} />
      <text className="office-num" x={box.x + PAD} y={lineY(1)} style={{ fill: waiting ? "var(--warn)" : "var(--text-dim)", fontWeight: 600 }}>
        {card.waitingText}
      </text>
      {card.rows.map((row, k) => (
        <text key={row} className="office-row" x={box.x + PAD} y={lineY(2 + k)}>
          {row}
        </text>
      ))}
    </g>
  );
}

/** The core's caption: THE BRAIN and the pending runs across all missions (the governor's rule). */
function GlobalCoreCaption({ running, loaded }: { running: number; loaded: boolean }) {
  const box = globalCardBox("core");
  return (
    <g className="office-card" aria-hidden="true">
      <CardFrame box={box} title="THE BRAIN" />
      <text className="office-num" x={box.x + PAD} y={box.y + FIRST + PITCH} style={{ fill: running > 0 ? "var(--signal)" : "var(--text-dim)" }}>
        {loaded ? `${running} running` : "—"}
      </text>
    </g>
  );
}

/** An interactive figure or marker: a link (or a button) for the pointer and the keyboard, with a focus ring. */
function SceneAction({
  kind,
  label,
  expanded,
  controls,
  onActivate,
  boxes,
  onFocus,
  onBlur,
  onPointerEnter,
  onPointerLeave,
}: {
  kind: "link" | "button";
  label: string;
  expanded?: boolean;
  controls?: string;
  onActivate: () => void;
  boxes: Box[];
  onFocus?: () => void;
  onBlur?: () => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}) {
  const onKey = (e: KeyboardEvent<SVGGElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      onActivate();
    }
  };
  const onClick = (e: MouseEvent<SVGGElement>) => {
    e.stopPropagation();
    onActivate();
  };
  return (
    <g
      role={kind}
      tabIndex={0}
      aria-label={label}
      aria-expanded={kind === "button" ? expanded : undefined}
      aria-controls={controls}
      className="map-item"
      onClick={onClick}
      onKeyDown={onKey}
      onFocus={onFocus}
      onBlur={onBlur}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      {boxes.map((b, i) => (
        <rect key={i} className="hit-fill" x={b.x} y={b.y} width={b.w} height={b.h} />
      ))}
      <path className="focus-ring" d={boxes.map((b) => `M ${points(boxPoly(b))} Z`).join(" ")} />
    </g>
  );
}

const SYNTHESIS_DECOR: StepNodeModel = { kind: "step", id: "synthesis", label: "Synthesis", stepNo: "06", state: "pending", statusText: "decor", stepStatus: null, source: "decor" };

/**
 * The GLOBAL OFFICE: every open mission's recorded agents in one isometric office of open-plan rooms. A desk holds
 * a figure only for a pending run (a glow while within the stale threshold, amber and still past it); queued
 * figures stand by the door with their mission tag (below the feet at PLANNING's and BUILD's glass doors, above
 * the head elsewhere); a seated figure shows its tag on hover or focus. Each opens the
 * mission's page (Enter, Space or a click); a "+k" marker opens that role's roster group. A walking token marks a
 * run start or report seen between two polls, never under reduced motion. Beside it: the governor's capacity and
 * the HTML roster of every instance. Draws only from the /api/agents, /api/tasks and /api/governor polls the page
 * already makes.
 */
export function GlobalOfficeScene({ agents, tasks, governor, reducedMotion, wheelZoom, focused = false, touchGestures = false }: GlobalOfficeSceneProps) {
  const router = useRouter();
  const { svgRef, contentRef, view, panning, bgHandlers, svgHandlers, onKeyDown, zoomIn, zoomOut, reset, fit } = usePanZoom({ center: CENTER, wheelZoom, world: OFFICE_WORLD, touchGestures });
  const helpId = useId();
  const groupBase = useId();
  const groupDomId = (id: string) => `${groupBase}-group-${id}`;
  const serverMs = agents ? Date.parse(agents.generatedAt) : Number.NaN;
  // the server's clock minus this device's, taken when a poll lands: elapsed times count on the server's clock
  const [skewMs, setSkewMs] = useState(0);
  useEffect(() => {
    if (Number.isFinite(serverMs)) setSkewMs(serverMs - Date.now());
  }, [serverMs]);
  const limits = governor?.policy?.global ?? agents?.limits ?? null;
  const model = useMemo(() => buildGlobalOffice({ agents, tasks, nowMs: Number.isFinite(serverMs) ? serverMs : 0, limits }), [agents, tasks, serverMs, limits]);
  // each line's plate, placed clear of what the rooms draw right now; placed again only when that or a label changes
  const plateLines = model.activityLines.map((l) => ({ role: l.role, labels: l.labels }));
  const plateDrawn = Object.fromEntries(model.rooms.map((r) => [r.id, { seated: r.seated.length, waiting: r.waiting.length, marker: r.overflow.length > 0 }]));
  const plateKey = JSON.stringify([plateLines, plateDrawn]);
  // keyed on the inputs' content (a poll builds new objects with the same content)
  const plates = useMemo(() => linePlates(plateLines, plateDrawn), [plateKey]);
  const loop = !reducedMotion;
  const running = model.totals.pendingTotal;

  // mission tokens from the difference between this /api/agents body and the one before it; each leaves after its walk
  const previous = useRef<AgentsResponse | null>(null);
  const timers = useRef<number[]>([]);
  const [walks, setWalks] = useState<GlobalWalk[]>([]);
  useEffect(() => {
    const prev = previous.current;
    if (prev === agents) return;
    previous.current = agents;
    const fresh = globalWalks(prev, agents);
    if (fresh.length === 0) return;
    setWalks((w) => [...w, ...fresh].slice(-MAX_WALKERS));
    for (const f of fresh) timers.current.push(window.setTimeout(() => setWalks((w) => w.filter((x) => x.key !== f.key)), f.durationMs + WALK_LINGER_MS));
  }, [agents]);
  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((t) => window.clearTimeout(t));
  }, []);

  // the one seated figure whose mission tag shows (hovered or focused), by instance key
  const [tagged, setTagged] = useState<string | null>(null);
  const untag = (key: string) => setTagged((t) => (t === key ? null : t));

  const [rosterChoice, setRosterOpen] = useFoldState(GLOBAL_ROSTER_FOLD_KEY);
  const rosterOpen = rosterChoice !== false;
  const rosterFocus = useFoldFocus(String(rosterOpen));
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggleGroup = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const openGroup = (id: string) => {
    if (!rosterOpen) setRosterOpen(true);
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    requestAnimationFrame(() => document.getElementById(groupDomId(id))?.focus());
  };
  const foldRoster = (folded: boolean) => {
    rosterFocus.request(folded);
    setRosterOpen(!folded);
  };

  const core: OfficeCoreModel = { phase: running > 0 ? "build" : "standby", particles: running > 0 ? "orbit" : "ambient", alert: false, word: "ALL MISSIONS", statusText: `${running} running across all missions`, source: "/api/agents active" };
  const waiting = model.waitingApproval ?? 0;
  const gate: GateRoomModel = {
    kind: "gate",
    id: "gate",
    title: ROOM_TITLE.gate,
    word: waiting > 0 ? "WAITING" : "—",
    state: waiting > 0 ? "waiting-approval" : "pending",
    statusText: waiting > 0 ? `${waiting} missions waiting on you` : "no approvals waiting",
    release: RELEASE_STEPS.map((s) => ({ state: s.state, label: s.label, status: null, source: "decor" })),
    ready: { ...SYNTHESIS_DECOR, id: "ready", label: "READY", stepNo: "07" },
    metrics: [],
    aria: "",
    source: "/api/tasks counts.waitingApproval",
  };
  const drawn = model.rooms.flatMap((r) => placed(r).map((x) => ({ room: r, ...x })));
  const taggedFigure = drawn.find((d) => d.posture === "seated" && d.inst.key === tagged);

  return (
    <div className="flex h-full w-full flex-col lg:flex-row">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          className="relative min-h-0 flex-1"
          role="group"
          tabIndex={0}
          aria-roledescription="office"
          aria-label={`Global office, all missions: ${model.loaded ? `${running} running, ${model.totals.staleExcluded} over the stale threshold, ${model.queuedLaunches} queued launches` : "loading"}`}
          aria-describedby={helpId}
          onKeyDown={onKeyDown}
        >
          <p id={helpId} className="sr-only">
            Zoom with plus and minus{wheelZoom === "modifier" ? " or control plus the mouse wheel" : " or the mouse wheel"}
            {wheelZoom === "plain" ? ", or pinch with two fingers" : ""}, pan with the arrow keys or by dragging, press 0 to reset the view. Tab moves through the agents, each opening its mission&apos;s page with Enter, and the more markers, each opening its role in the roster. A text version of the scene follows.
          </p>
          <section className="sr-only" aria-label="Global office as text">
            <ul>
              {model.rooms.map((r) => (
                <li key={r.id}>
                  {r.title}: {busyWords(r)}; {r.header}
                  {r.stale > 0 ? `, ${r.stale} over the stale threshold` : ""}.{" "}
                  {r.instances.map((i) => instanceWords(i)).join("; ")}
                </li>
              ))}
              {model.activityLines.map((l) => (
                <li key={`line:${l.role}`}>Line from the core to {l.words}.</li>
              ))}
              <li>Commander gate: {gate.statusText}. Approvals happen in the Claude Code session, not here.</li>
            </ul>
          </section>
          <svg
            ref={svgRef}
            className={cn("map-svg office-svg", wheelZoom === "modifier" && "touch-pan", panning && "panning")}
            viewBox={`0 0 ${OFFICE_WORLD.width} ${OFFICE_WORLD.height}`}
            preserveAspectRatio="xMidYMid meet"
            {...svgHandlers}
          >
            <rect x={-OFFICE_WORLD.width * 4} y={-OFFICE_WORLD.height * 4} width={OFFICE_WORLD.width * 9} height={OFFICE_WORLD.height * 9} fill="transparent" style={{ cursor: panning ? "grabbing" : "grab" }} {...bgHandlers} aria-hidden="true" />
            <g ref={contentRef} transform={toTransform(view)}>
              <OfficeBackdrop />
              <GlobalFloorPaths />
              {/* the activity lines on the floor, behind the rooms and the core (the Mission Office's edge layer) */}
              <g className="edges" aria-hidden="true">
                {model.activityLines.map((l) => (
                  <GlobalActivityLine key={l.role} line={l} loop={loop} />
                ))}
              </g>
              <g className="rooms">
                {DEPTH.map((item) => {
                  if (item.id === "core") return <OfficeCore key="core" core={core} synthesis={SYNTHESIS_DECOR} reducedMotion={reducedMotion} />;
                  if (item.id === "gate") return <OfficeGateRoom key="gate" gate={gate} readyState="pending" loop={loop} />;
                  const room = model.rooms.find((r) => r.id === item.id);
                  return room ? <GlobalRoleRoom key={room.id} room={room} loop={loop} /> : null;
                })}
              </g>
              {/* mission tokens of a run start or report seen between two polls: never under reduced motion */}
              <g className="walkers">
                {!reducedMotion &&
                  walks.map((w) => (
                    <OfficeWalker key={w.key} walker={w} reducedMotion={false} />
                  ))}
              </g>
              <g className="cards">
                {model.rooms.map((r) => (
                  <GlobalRoomCard key={r.id} room={r} totals={model.totals} />
                ))}
                <GateDecorCard waiting={model.waitingApproval} />
                <GlobalCoreCaption running={running} loaded={model.loaded} />
              </g>
              <g className="tags" aria-hidden="true">
                {model.activityLines.map((l) => {
                  const plate = plates[l.role];
                  return plate ? <Plate key={`line:${l.role}`} box={plate.box} text={plate.label} tone={l.tone === "running" ? "var(--signal)" : "var(--text-dim)"} /> : null;
                })}
                {drawn
                  .filter((d) => d.posture === "standing")
                  .map((d) => (
                    <Plate key={d.inst.key} box={tagBox(d.p, d.posture, queueTagSide(d.room.id))} text={d.inst.missionNo} tone={TONE[d.inst.state]} />
                  ))}
                {model.rooms
                  .filter((r) => r.overflow.length > 0)
                  .map((r) => (
                    <Plate key={r.id} box={overflowBox(r.id)} text={`+${r.overflow.length}`} tone="var(--edge-strong)" />
                  ))}
              </g>
              <g className="office-hits">
                {drawn.map((d) => (
                  <SceneAction
                    key={d.inst.key}
                    kind="link"
                    label={`${instanceWords(d.inst)}, open mission details`}
                    onActivate={() => router.push(missionHref(d.inst.taskId))}
                    boxes={d.posture === "seated" ? [seatHitBox(d.p)] : [figureBox(d.p, d.posture), tagBox(d.p, d.posture, queueTagSide(d.room.id))]}
                    {...(d.posture === "seated" ? { onFocus: () => setTagged(d.inst.key), onBlur: () => untag(d.inst.key), onPointerEnter: () => setTagged(d.inst.key), onPointerLeave: () => untag(d.inst.key) } : {})}
                  />
                ))}
                {model.rooms
                  .filter((r) => r.overflow.length > 0)
                  .map((r) => (
                    <SceneAction
                      key={r.id}
                      kind="button"
                      label={`${r.overflow.length} more ${r.title.toLowerCase()} agents (${r.overflow.map((i) => `${i.missionNo} ${STATE_WORDS[i.state]}`).join(", ")}), show them in the roster`}
                      expanded={rosterOpen && !collapsed.has(r.id)}
                      controls={rosterOpen ? `${groupDomId(r.id)}-list` : undefined}
                      onActivate={() => openGroup(r.id)}
                      boxes={[overflowBox(r.id)]}
                    />
                  ))}
              </g>
              {/* the hovered or focused seated figure's mission tag, one at a time, above everything, never a target */}
              <g className="tags" aria-hidden="true" pointerEvents="none">
                {taggedFigure && <Plate box={tagBox(taggedFigure.p, "seated")} text={taggedFigure.inst.missionNo} tone={TONE[taggedFigure.inst.state]} />}
              </g>
            </g>
          </svg>
          {wheelZoom === "modifier" && (
            <p className="map-hint pointer-events-none absolute bottom-3 left-3 max-md:hidden label text-faint">
              <span className="pointer-coarse:hidden">ctrl + scroll to zoom · drag to pan</span>
              <span className="hidden pointer-coarse:inline">drag sideways to pan · Focus mode to pinch-zoom</span>
            </p>
          )}
          <MapControls className="absolute bottom-3 right-3" zoom={view.k} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={reset} onFit={fit} />
        </div>
        <GlobalCapacity governor={governor} queuedLaunches={model.queuedLaunches} className="shrink-0 border-t border-border" />
      </div>
      {rosterOpen ? (
        <aside
          className={cn("scroll-thin flex min-h-0 shrink-0 flex-col gap-2 overflow-y-auto border-border p-2 max-lg:max-h-[45%] max-lg:border-t lg:w-72 lg:border-l", !focused && "lg:pt-14")}
          aria-label="Agents roster, all missions"
        >
          <div className="flex items-center justify-between gap-2">
            <h2 className="hud-title">Agents · all missions</h2>
            <button ref={rosterFocus.hideButton} type="button" className="btn min-h-11" onClick={() => foldRoster(true)} aria-expanded aria-label="Hide the agents roster">
              Hide
            </button>
          </div>
          <GlobalRoster model={model} skewMs={skewMs} collapsed={collapsed} onToggleGroup={toggleGroup} groupDomId={groupDomId} />
        </aside>
      ) : (
        <div className={cn("flex shrink-0 items-center border-border p-1 max-lg:border-t lg:w-14 lg:flex-col lg:border-l", !focused && "lg:pt-14")}>
          <button ref={rosterFocus.showButton} type="button" className="btn min-h-11" onClick={() => foldRoster(false)} aria-expanded={false} aria-label="Show the agents roster">
            Roster
          </button>
        </div>
      )}
    </div>
  );
}
