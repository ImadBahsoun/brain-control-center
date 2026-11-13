"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentsResponse, EventsResponse, FindingsResponse, GovernorResponse, HealthResponse, TaskDetail } from "@/lib/api-types";
import { usePoll } from "@/hooks/use-poll";
import { useCadence } from "@/hooks/use-cadence";
import { useLiveEffects } from "@/hooks/use-live-effects";
import { useMediaQuery } from "@/hooks/use-media-query";
import { usePanelSelection } from "@/hooks/use-panel-selection";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { useFoldState } from "@/hooks/use-fold-state";
import { useReplay } from "@/hooks/use-replay";
import { atmosphere } from "@/lib/ui/atmosphere";
import { buildCommandMap } from "@/lib/ui/command-map";
import { LEFT_FOLD_KEY, RAIL_FOLD_KEY } from "@/lib/ui/fold-state";
import { freshFor, isDebrief, nextAutoFocus, selectFocus, type AutoFocus } from "@/lib/ui/mission";
import type { PanelData } from "@/components/panels/map-panels";

/**
 * The focused-mission view state shared by the Command Map (/) and the Office (/office): the polls, the
 * focus rules, the command map model, live effects, Mission Replay and the side panel's data. Both views
 * draw the same model, so they make exactly the same requests.
 */
export function useMissionView({ effectLifetimeMs }: { effectLifetimeMs?: number } = {}) {
  const { interval, tasks } = useCadence();
  const health = usePoll<HealthResponse>("/api/health", interval);
  const agents = usePoll<AgentsResponse>("/api/agents", interval);
  const governor = usePoll<GovernorResponse>("/api/governor", interval);

  // the focused mission: the user's choice (debrief or a specific live mission), else a sticky auto focus
  const [chosenId, setChosenId] = useState<string | null>(null);
  // the viewer's remembered fold choices for the threat rail and the left column (desktop widths only; see fold-state.ts)
  const [railChoice, setRailOpen] = useFoldState(RAIL_FOLD_KEY);
  const [leftChoice, setLeftOpen] = useFoldState(LEFT_FOLD_KEY);
  // Focus Mode: the full-screen graph view, shared with the Focus Mode header and the scene's wheel-zoom
  // mode (mapWheelMode in focus-mode.ts needs both `focus` and `desktop` next to each other here).
  const [focus, setFocus] = useState(false);
  const desktop = useMediaQuery("(min-width: 1024px)");
  const list = tasks.data?.tasks ?? null;
  const auto = useRef<AutoFocus | null>(null);
  const focusId = selectFocus(list, chosenId, auto.current, tasks.data?.generatedAt ?? null);
  const focusSummary = list?.find((t) => t.id === focusId) ?? null;
  const debrief = focusSummary ? isDebrief(focusSummary) : false;
  const focusInterval = debrief ? 0 : interval; // a terminal mission is fetched once
  const enc = focusId ? encodeURIComponent(focusId) : null;
  const detail = usePoll<TaskDetail>(enc ? `/api/tasks/${enc}` : null, focusInterval);
  const findings = usePoll<FindingsResponse>(enc ? `/api/tasks/${enc}/findings` : null, focusInterval);
  const events = usePoll<EventsResponse>(enc ? `/api/tasks/${enc}/events?limit=200` : null, focusInterval);

  // data counts only when it is another body than the one the poll slot held when the focus changed: the poll
  // keeps old URL slots, so switching back to a mission must not replay its stale body before the fresh one
  const baseline = useRef<{ id: string | null; detail: TaskDetail | null; findings: FindingsResponse | null; events: EventsResponse | null }>({ id: null, detail: null, findings: null, events: null });
  if (baseline.current.id !== focusId) baseline.current = { id: focusId, detail: detail.data, findings: findings.data, events: events.data };
  const detailData = freshFor(detail.data, baseline.current.detail, (d) => d.id === focusId);
  const findingsData = freshFor(findings.data, baseline.current.findings, (f) => f.taskId === focusId);
  const eventsData = freshFor(events.data, baseline.current.events, (e) => e.taskId === focusId);

  // the auto focus is remembered per render; a just-completed focus is held until its terminal detail was shown
  useEffect(() => {
    auto.current = nextAutoFocus(auto.current, { focusId, chosenId, summary: focusSummary, detail: detailData, tasksStamp: tasks.data?.generatedAt ?? null });
  });

  const model = useMemo(
    () =>
      buildCommandMap({
        detail: focusId ? detailData : null,
        findings: focusId ? findingsData : null,
        events: focusId ? eventsData : null,
        agents: agents.data,
        governor: governor.data,
        health: health.data,
        tasks: tasks.data,
        focusId,
        loadError: detail.error,
        tasksError: tasks.error,
      }),
    [focusId, detailData, findingsData, eventsData, agents.data, governor.data, health.data, tasks.data, detail.error, tasks.error],
  );
  const liveEffects = useLiveEffects(model, effectLifetimeMs);
  const reducedMotion = useReducedMotion();
  const wide = useMediaQuery("(min-width: 1100px)");
  const { selection, select, close } = usePanelSelection();

  // Mission Replay of a debriefed mission: one events GET (limit 1000) when it is opened, nothing written
  const replay = useReplay({ detail: model.mode === "debrief" ? model.detail : null, findings: findingsData, eventsUrl: enc ? `/api/tasks/${enc}/events?limit=1000` : null, reducedMotion });
  const replayOpener = useRef<HTMLElement | null>(null);
  const { exit: exitReplay } = replay;
  useEffect(() => {
    exitReplay();
  }, [focusId, exitReplay]);
  const leaveReplay = () => {
    exitReplay();
    const el = replayOpener.current;
    replayOpener.current = null;
    if (el) requestAnimationFrame(() => el.focus());
  };
  const toggleReplay = (opener: HTMLElement) => {
    if (replay.open) return leaveReplay();
    replayOpener.current = opener;
    replay.start();
  };

  const replaying = replay.open && replay.model !== null;
  const shown = replaying && replay.model ? replay.model : model;
  const effects = replaying ? replay.effects : liveEffects;
  const atmo = atmosphere(shown);
  const animated = shown.mode === "live" || shown.mode === "replay";
  const feedEvents = replaying ? (replay.frame?.events ?? null) : eventsData;

  const selectedThreat = selection?.kind === "threat" ? selection.id : null;
  const compactRail = shown.findingsLoaded && shown.findings.length === 0;
  const overlay = replaying
    ? `replay · recorded history · step ${replay.state.index + 1} of ${replay.state.length}`
    : model.mode === "loading"
      ? !focusId
        ? `error · ${tasks.error} · mission list unavailable`
        : `${detail.error ? `error · ${detail.error}` : "loading"} · mission ${focusId}`
      : model.mode === "idle"
        ? "standby · no active mission · connections dormant"
        : null;
  const replayMessage = replaying && replay.frame && !replay.state.playing ? `Replay step ${replay.state.index + 1} of ${replay.state.length}: ${replay.frame.step.item.text}` : null;

  const panelData: PanelData = replaying
    ? { model: shown, events: replay.frame?.events ?? null, governor: null, health: null, agents: null, tasks: null, replay: true }
    : { model, events: eventsData, governor: governor.data, health: health.data, agents: agents.data, tasks: tasks.data };

  return {
    interval,
    tasks,
    health,
    agents,
    governor,
    list,
    chosenId,
    setChosenId,
    focusId,
    focusSummary,
    detail,
    findings,
    events,
    detailData,
    findingsData,
    eventsData,
    model,
    liveEffects,
    reducedMotion,
    wide,
    selection,
    select,
    close,
    replay,
    toggleReplay,
    leaveReplay,
    replaying,
    shown,
    effects,
    atmo,
    animated,
    feedEvents,
    selectedThreat,
    overlay,
    replayMessage,
    panelData,
    railChoice,
    setRailOpen,
    leftChoice,
    setLeftOpen,
    compactRail,
    focus,
    setFocus,
    desktop,
  };
}

export type MissionView = ReturnType<typeof useMissionView>;
