"use client";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import type { EventsResponse, FindingsResponse, TaskDetail } from "@/lib/api-types";
import type { CommandMapModel } from "@/lib/ui/command-map";
import { asReplayModel, buildReplay, REPLAY_CLOSED, replayAvailability, replayFrame, replayReducer, replayStepEffects, STEP_MS, type ReplayAction, type ReplayFrame, type ReplayState } from "@/lib/ui/replay";
import { usePoll } from "@/hooks/use-poll";
import type { ActiveEffect } from "@/hooks/use-live-effects";

export interface ReplayControl {
  /** The focused mission can be replayed (terminal, readable log, usable state.json). */
  available: boolean;
  open: boolean;
  /** Opening was asked for and the events are being fetched. */
  loading: boolean;
  error: string | null;
  start: () => void;
  exit: () => void;
  dispatch: (action: ReplayAction) => void;
  state: ReplayState;
  frame: ReplayFrame | null;
  model: CommandMapModel | null;
  effects: ActiveEffect[];
  caveats: string[];
}

/**
 * Mission Replay for one terminal mission. Its events come from `events` when the page already holds the
 * full window (the mission detail page), else from one GET of `eventsUrl` made the first time the replay is
 * opened for that URL (re-opening reuses it). Playing advances one step per tick (one state update per
 * step; no per-frame state); nothing is written anywhere. Under reduced motion the replay opens paused and
 * frames change without animation.
 */
export function useReplay({ detail, findings, events, eventsUrl, reducedMotion }: { detail: TaskDetail | null; findings: FindingsResponse | null; events?: EventsResponse | null; eventsUrl?: string | null; reducedMotion: boolean }): ReplayControl {
  const [state, dispatch] = useReducer(replayReducer, REPLAY_CLOSED);
  const [requested, setRequested] = useState(false);
  // the URL stays polled (one-shot, so no further request) once opened, until the focused mission changes:
  // re-opening within the same visit reuses it, and coming back to the mission later fetches only on open
  const [fetchUrl, setFetchUrl] = useState<string | null>(null);
  useEffect(() => {
    setFetchUrl(null);
  }, [eventsUrl]);
  const fetched = usePoll<EventsResponse>(!events && eventsUrl && fetchUrl === eventsUrl ? eventsUrl : null, 0);
  const evs = events ?? fetched.data;
  const offered = replayAvailability(detail, findings, null);

  const built = useMemo(() => (requested && detail && findings && evs ? buildReplay(detail, findings, evs) : null), [requested, detail, findings, evs]);
  const timeline = built?.ok ? built.timeline : null;

  useEffect(() => {
    if (requested && timeline && !state.open) dispatch({ type: "open", length: timeline.steps.length, autoplay: !reducedMotion });
  }, [requested, timeline, state.open, reducedMotion]);

  useEffect(() => {
    if (!state.open || !state.playing) return;
    const id = setInterval(() => dispatch({ type: "tick" }), STEP_MS[state.speed]);
    return () => clearInterval(id);
  }, [state.open, state.playing, state.speed]);

  const frame = useMemo(() => (state.open && timeline ? replayFrame(timeline, state.index) : null), [state.open, timeline, state.index]);
  const model = useMemo(() => (frame ? asReplayModel(frame) : null), [frame]);
  const effects = useMemo<ActiveEffect[]>(() => (state.open && timeline ? replayStepEffects(timeline, state.index, state.lastMove).map((e) => ({ ...e, at: 0 })) : []), [state.open, timeline, state.index, state.lastMove]);

  const start = useCallback(() => {
    setRequested(true);
    if (eventsUrl) setFetchUrl(eventsUrl);
  }, [eventsUrl]);
  const exit = useCallback(() => {
    setRequested(false);
    dispatch({ type: "exit" });
  }, []);

  return {
    available: offered.ok,
    open: state.open,
    loading: requested && !state.open && built === null && !fetched.error,
    error: built && !built.ok ? built.reason : requested && !state.open ? fetched.error : null,
    start,
    exit,
    dispatch,
    state,
    frame,
    model,
    effects,
    caveats: timeline?.caveats ?? [],
  };
}
