"use client";
import Link from "next/link";
import { use, useEffect, useMemo, useRef, useState } from "react";
import type { EventsResponse, FindingsResponse, TaskDetail, TasksResponse } from "@/lib/api-types";
import { dateTime, relativeAge } from "@/lib/format";
import { stateLabel } from "@/lib/lifecycle";
import { usePoll } from "@/hooks/use-poll";
import { useLiveEffects } from "@/hooks/use-live-effects";
import { usePanelSelection } from "@/hooks/use-panel-selection";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { useReplay } from "@/hooks/use-replay";
import { atmosphere } from "@/lib/ui/atmosphere";
import { buildCommandMap } from "@/lib/ui/command-map";
import { currentAction } from "@/lib/ui/hud";
import { isRole } from "@/lib/ui/roles";
import { CommandMap } from "@/components/map/command-map";
import { LifecyclePath } from "@/components/map/lifecycle-path";
import { LiveAnnouncer } from "@/components/map/live-announcer";
import { MapAtmosphere } from "@/components/map/map-atmosphere";
import { MissionBar } from "@/components/map/mission-bar";
import { ReplayBar } from "@/components/map/replay-bar";
import { MapPanels } from "@/components/panels/map-panels";
import { Field, Fields } from "@/components/panels/side-panel";
import { AgentRunsTable } from "@/components/task/agent-runs-table";
import { EventLog } from "@/components/task/event-log";
import { FilesChanged } from "@/components/task/files-changed";
import { FindingsTable } from "@/components/task/findings-table";
import { IntegrityBanner } from "@/components/task/integrity";
import { ValidationPanel } from "@/components/task/validation-panel";

const FAST_MS = 2500;

export default function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const enc = encodeURIComponent(id);

  // Poll every endpoint at 2.5 s while the task is not terminal; once it is, the interval drops to 0,
  // which fetches one last time and then stops (detail included).
  const [interval, setIntervalMs] = useState(FAST_MS);
  const probe = usePoll<TaskDetail>(`/api/tasks/${enc}`, interval);
  const status = probe.data?.status;
  const terminal = status === "COMPLETE" || status === "CANCELLED";
  useEffect(() => {
    setIntervalMs(terminal ? 0 : FAST_MS);
  }, [terminal]);

  const events = usePoll<EventsResponse>(`/api/tasks/${enc}/events?limit=1000`, interval);
  const findings = usePoll<FindingsResponse>(`/api/tasks/${enc}/findings`, interval);
  // the ETA rides on the task list (computed on read; the detail body is unchanged)
  const list = usePoll<TasksResponse>("/api/tasks", interval);
  const task = probe.data;

  const model = useMemo(
    () => buildCommandMap({ detail: task, findings: findings.data, events: events.data, agents: null, governor: null, health: null, tasks: null, focusId: id, loadError: probe.error }),
    [task, findings.data, events.data, id, probe.error],
  );
  const liveEffects = useLiveEffects(model);
  const reducedMotion = useReducedMotion();
  const { selection, select, close } = usePanelSelection();
  const pollingText = terminal ? "polling stopped" : `poll ${FAST_MS / 1000}s`;

  // Mission Replay over the events this page already holds (limit 1000): no extra request, nothing written
  const replay = useReplay({ detail: model.mode === "debrief" ? (task ?? null) : null, findings: findings.data, events: events.data, reducedMotion });
  const replayOpener = useRef<HTMLElement | null>(null);
  const leaveReplay = () => {
    replay.exit();
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
  const replayMessage = replaying && replay.frame && !replay.state.playing ? `Replay step ${replay.state.index + 1} of ${replay.state.length}: ${replay.frame.step.item.text}` : null;

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-2 px-4 py-3">
      <div className="flex items-center justify-between label text-faint">
        <Link href="/" className="text-signal">
          ← command map
        </Link>
        <span className="num">
          {terminal ? "terminal mission · polling stopped" : `polling every ${FAST_MS / 1000}s`}
          {probe.stale && !terminal ? " · stale" : ""}
          {probe.error ? ` · error: ${probe.error}` : ""}
        </span>
      </div>
      {!task ? (
        <p className="text-dim">{probe.error ? `Could not load mission: ${probe.error}` : "loading…"}</p>
      ) : (
        <>
          <MissionBar
            model={shown}
            tasks={[]}
            labelTasks={list.data?.tasks ?? []}
            chosenId={null}
            onChoose={() => undefined}
            pollingText={pollingText}
            stale={probe.stale && !terminal}
            error={probe.error ?? (findings.error ? `findings: ${findings.error}` : null) ?? (replay.error ? `replay: ${replay.error}` : null)}
            generatedAt={null}
            showLink={false}
            onReview={(el) => select({ kind: "gate" }, el)}
            onReplay={toggleReplay}
            replayAvailable={replay.available && model.mode === "debrief" && events.data !== null}
            replayActive={replay.open}
            eta={replaying ? null : (list.data?.tasks.find((t) => t.id === id)?.eta ?? null)}
          />
          <section className="hud px-3 py-2" aria-label="Mission brief">
            <p className="mb-2 text-[14px] text-foreground">{task.title ?? <span className="text-faint">(no summary)</span>}</p>
            <div className="grid gap-x-6 gap-y-1 md:grid-cols-2 xl:grid-cols-3">
              <Fields>
                <Field label="repository" value={task.repository} mono />
                <Field label="branch" value={task.branch} mono />
                <Field label="base HEAD" value={task.baseHead} mono />
                <Field label="current HEAD" value={task.currentHead} mono />
              </Fields>
              <Fields>
                <Field label="risk" value={task.risk} />
                <Field label="classification reason" value={task.classificationReason} />
                <Field label="created" value={task.createdAt ? dateTime(task.createdAt) : null} />
                <Field label="last event" value={task.lastEventAt ? `${dateTime(task.lastEventAt)} (${relativeAge(task.lastEventAt)})` : null} />
                <Field label="events / pending runs" value={`${task.eventCount} / ${task.pendingRuns}`} />
              </Fields>
              <Fields>
                <Field label="next action" value={task.nextAction} />
                <Field label="outcome" value={task.outcome} />
                <Field label="completion summary" value={task.completionSummary} />
                <Field label="plan" value={task.plan ? `${task.plan.approved ? "approved" : "not approved"} · by ${task.plan.author ?? "?"} · ${task.plan.chars ?? "?"} chars` : null} />
                {task.plan && task.plan.approvedScope.length > 0 && <Field label="approved scope" value={task.plan.approvedScope.join("; ")} />}
                {task.plan && task.plan.notApproved.length > 0 && <Field label="not approved" value={task.plan.notApproved.join("; ")} />}
                {task.blockedInfo && <Field label="blocked reason" value={task.blockedInfo.reason} />}
                {task.blockedInfo && <Field label="blocked needs" value={task.blockedInfo.needs.join("; ")} />}
                {task.usage && <Field label="governor usage" value={`${task.usage.consumed} used + ${task.usage.reserved} reserved = ${task.usage.committed}${task.usage.classBudget ? ` / ${task.usage.classBudget} (${task.usage.percentOfClassBudget}%)` : ""} · ${task.usage.note}`} />}
                {task.summaryUnavailable && <Field label="summary" value="state.json not usable: agents, findings, rounds and validation are unavailable" />}
              </Fields>
            </div>
          </section>
          <IntegrityBanner task={task} />
          <LifecyclePath lifecycle={shown.detail?.lifecycle ?? task.lifecycle} reducedMotion={reducedMotion} live={shown.mode === "live" || shown.mode === "replay"} action={currentAction(shown)} />
          {replaying && <ReplayBar replay={replay} onExit={leaveReplay} />}
          <div className="map-bg relative h-[660px] max-md:h-[min(660px,70svh)] overflow-hidden border border-border" data-atmo={atmo.phase}>
            <MapAtmosphere atmo={atmo} reducedMotion={reducedMotion} />
            <CommandMap model={shown} effects={effects} selection={selection} onSelect={select} reducedMotion={reducedMotion} wheelZoom="modifier" />
            <p className="pointer-events-none absolute left-3 top-3 label text-faint">{replaying ? `replay · recorded history · step ${replay.state.index + 1} of ${replay.state.length}` : model.mode === "live" ? "live · this mission" : "debrief · recorded history"}</p>
          </div>
          <AgentRunsTable runs={task.agents} unavailable={task.summaryUnavailable} onSelectRole={(role, el) => (isRole(role) ? select({ kind: "node", id: role }, el) : undefined)} />
          <FindingsTable findings={findings.data} error={findings.error} onOpen={(f, el) => select({ kind: "threat", id: f.id }, el)} selectedId={selection?.kind === "threat" ? selection.id : null} />
          <ValidationPanel task={task} />
          <FilesChanged groups={task.filesChanged} />
          <EventLog events={events.data} error={events.error} />
          <p className="label text-faint">state {task.state ? stateLabel(task.state) : "—"} · status {task.status}</p>
        </>
      )}
      <MapPanels selection={selection} data={replaying ? { model: shown, events: replay.frame?.events ?? null, governor: null, health: null, agents: null, tasks: null, replay: true } : { model, events: events.data, governor: null, health: null, agents: null, tasks: null }} onClose={close} onSelect={select} />
      {/* replayed effects are announced only while paused (at 4× a polite region would queue them), marked as a replay */}
      <LiveAnnouncer effects={replaying ? (replay.state.playing ? [] : replay.effects) : liveEffects} prefix={replaying ? "Replay: " : ""} message={replayMessage} />
    </div>
  );
}
