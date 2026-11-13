"use client";
import Link from "next/link";
import type { AgentsResponse, EventsResponse, GovernorResponse, TaskDetail } from "@/lib/api-types";
import { dateTime, durationMs, timeHMS } from "@/lib/format";
import { stateLabel } from "@/lib/lifecycle";
import { EFFORT_LABEL, type CommandMapModel, type RoleNodeModel } from "@/lib/ui/command-map";
import { roleAction } from "@/lib/ui/hud";
import { VALIDATORS } from "@/lib/ui/roles";
import { cn } from "@/lib/utils";
import { ActivityLine } from "@/components/events/activity-line";
import { HUD_TONE_CLASS } from "@/components/map/mission-bar";
import { RoleEmblemIcon } from "@/components/map/role-emblem";
import { STATE_TONE } from "@/components/map/map-node";
import { ThreatRow } from "@/components/map/threat-rail";
import type { Opener } from "@/components/map/map-node";
import { Glyph } from "@/components/ui/glyphs";
import { EmptyNote, Field, Fields, Section, SourceLine } from "@/components/panels/side-panel";
import { runStatusText } from "@/components/task/agent-runs-table";

const TONE_CLASS = { pass: "tone-ok", concern: "tone-warn", fail: "tone-danger", neutral: "text-foreground" } as const;

export function CharacterPanel({
  node,
  model,
  events,
  governor,
  agents,
  onOpenFinding,
  replay = false,
}: {
  node: RoleNodeModel;
  model: CommandMapModel;
  events: EventsResponse | null;
  governor: GovernorResponse | null;
  agents: AgentsResponse | null;
  onOpenFinding: (id: string, opener: Opener) => void;
  /** A replay frame: governor and agents data are not part of the recorded history. */
  replay?: boolean;
}) {
  const d: TaskDetail | null = model.detail;
  const role = node.id;
  const policy = governor?.policy ?? null;
  // relevant findings: the ones this role raised, plus (for the developer) the ones its fix rounds addressed
  const addressed = new Set(role === "developer" ? (d?.rounds ?? []).flatMap((r) => Object.keys(r.findingsAddressed)) : []);
  const roleFindings = model.findings.filter((f) => f.sources.includes(role) || addressed.has(f.id));
  const action = roleAction(node, d, { replay });
  const result = [...node.runs].reverse().find((r) => r.status !== "pending") ?? null;
  // reports carry agent + round only: with several completed runs of this role in that round they cannot be tied to one run
  const ended = result ? node.runs.filter((r) => r.completedAt !== null && r.round === result.round) : [];
  const sameRound = ended.length;
  const ambiguous = sameRound > 1;
  // the note is shown only when that round has reports of this role to place; a lost or refunded run is "ended", not "completed"
  const roundReports = result && d ? d.testsRun.filter((t) => t.agent === role && t.round === result.round).length + d.filesChanged.filter((g) => g.agent === role && g.round === result.round).length : 0;
  const lostCount = ended.filter((r) => r.status === "lost").length;
  const refundedCount = ended.filter((r) => r.status === "not-launched").length;
  const endedDetail = [lostCount ? `${lostCount} lost` : "", refundedCount ? `${refundedCount} not launched` : ""].filter(Boolean).join(", ");
  const resultTests = result && d && !ambiguous ? d.testsRun.filter((t) => t.agent === role && t.round === result.round) : [];
  const resultFiles = result && d && !ambiguous ? d.filesChanged.filter((g) => g.agent === role && g.round === result.round) : [];
  const notLoaded = (what: string) => (replay ? `${what}: not part of the recorded history` : `${what} not loaded`);
  const files = d?.filesChanged.filter((g) => g.agent === role) ?? [];
  const tests = d?.testsRun.filter((t) => t.agent === role) ?? [];
  const roleEvents = (events?.events ?? []).filter((e) => e.role === role).slice(-20);
  const validationVerdict = d?.validation.latest?.agents[role] ?? null;
  const inProgress = d?.validation.inProgress?.agents.includes(role) ?? false;
  const isValidator = VALIDATORS.has(role);
  const slotUsed = governor ? (role === "developer" ? governor.global.pendingDevelopers : isValidator ? governor.global.pendingValidators : null) : null;
  const slotMax = policy ? (role === "developer" ? policy.global.max_developers : isValidator ? policy.global.max_validators : null) : null;
  const modelClass = node.model;
  const modelUsed = governor && modelClass ? (modelClass === "opus" ? governor.global.pendingOpus : modelClass === "fable" ? governor.global.pendingFable : null) : null;
  const modelMax = policy && modelClass ? (modelClass === "opus" ? policy.global.max_opus_agents : modelClass === "fable" ? policy.global.max_fable_agents : null) : null;
  const statusTone = node.state === "completed" ? TONE_CLASS[node.verdictTone] : undefined;
  const ringColor = node.state === "running" && node.stale ? "var(--warn)" : STATE_TONE[node.state];

  return (
    <>
      <div className="hero mb-4 flex items-center gap-4">
        <span className={cn("hero-emblem flex shrink-0 items-center justify-center", node.state === "running" && !node.stale && "running")} style={{ borderColor: ringColor, color: node.state === "running" ? ringColor : "var(--text)" }}>
          <RoleEmblemIcon role={role} size={56} />
        </span>
        <div className="min-w-0">
          <p className="label text-faint">
            {node.stepNo} · {node.archetype} archetype
          </p>
          <p className="font-mono text-[18px] font-semibold tracking-wide text-foreground">{node.label}</p>
          <p className="label num text-dim">
            {node.model ? `model ${node.model}` : "model —"} · {node.unitsPerRun !== null ? `${node.unitsPerRun} units per run` : "— units per run"}
          </p>
          <p className={cn("label-md", statusTone)} style={statusTone ? undefined : { color: ringColor }}>
            {node.statusText}
          </p>
          <SourceLine source={node.source} />
        </div>
      </div>

      <Section title="Current action">
        <p className={cn("text-[13px]", HUD_TONE_CLASS[action.tone])}>{action.text}</p>
        {node.state === "running" && <p className="mt-0.5 label text-faint">a reservation with no report yet; the Brain records no liveness</p>}
      </Section>

      <Section title="Latest result" right={result ? <span className="label text-faint">{result.kind} · round {result.round ?? 0}</span> : undefined}>
        {!result ? (
          <EmptyNote>{d ? "no completed run of this role on this mission" : "no mission in focus"}</EmptyNote>
        ) : (
          <>
            <Fields>
              <Field label="result">
                <span className={cn(result.status === "lost" ? "tone-danger" : result.status === "not-launched" ? "tone-dim" : TONE_CLASS[node.verdictTone])}>{runStatusText(result)}</span>
              </Field>
              <Field label="completed" value={result.completedAt ? `${dateTime(result.completedAt)} (${durationMs(result.durationMs)})` : null} />
            </Fields>
            {ambiguous && roundReports > 0 && (
              <p className="mt-1.5 label text-faint">
                {sameRound} runs ended in round {result.round ?? 0}
                {endedDetail ? ` (${endedDetail})` : ""}: their reported tests and files are listed below, not tied to one run
              </p>
            )}
            {(resultTests.length > 0 || resultFiles.length > 0) && (
              <div className="mt-1.5">
                <p className="label text-faint">reported at completion</p>
                <ul className="mt-0.5 flex flex-col gap-0.5 font-mono text-[11px]">
                  {resultTests.map((t, i) => (
                    <li key={`t${i}`} className="flex gap-1.5">
                      <Glyph name="check" size={11} className="mt-0.5 shrink-0 tone-ok" />
                      <span>
                        <span className="text-foreground">{t.cmd}</span> <span className="text-dim">→ {t.result}</span>
                      </span>
                    </li>
                  ))}
                  {resultFiles.map((g, i) => (
                    <li key={`f${i}`} className="flex gap-1.5">
                      <Glyph name="chevron" size={11} className="mt-0.5 shrink-0 text-dim" />
                      <span className="text-dim">{g.files.length} file(s) changed</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </Section>

      <Section title="Identity">
        <Fields>
          <Field label="role" value={node.label} />
          <Field label="archetype" value={`${node.archetype} (UI vocabulary)`} />
          <Field label="model">
            {modelClass ? (
              <>
                {modelClass} <span className="text-faint">policy model class</span>
              </>
            ) : (
              <span className="text-faint">— (no policy)</span>
            )}
          </Field>
          <Field label="effort">
            <span className="text-faint">{EFFORT_LABEL}</span>
          </Field>
          <Field label="status" value={node.statusText} />
        </Fields>
      </Section>

      <Section title="Mission">
        {d ? (
          <Fields>
            <Field label="mission">
              <Link href={`/tasks/${encodeURIComponent(d.id)}`} className="font-mono text-signal">
                {d.id}
              </Link>
              {d.title ? <span className="block text-dim">{d.title}</span> : null}
            </Field>
            <Field label="state" value={d.state ? stateLabel(d.state) : null} />
            <Field label="round">
              {node.latestRun ? (
                <>
                  {node.round ?? 0} / {d.maxRounds} <span className="text-faint">· {node.runKind}{node.rerun ? " · rerun" : ""}</span>
                </>
              ) : (
                <span className="text-faint">no run on this mission</span>
              )}
            </Field>
            <Field label="units">
              {node.unitsPerRun !== null ? `${node.unitsPerRun} per run${node.policyUnits === null ? " (recorded on the run)" : ""}` : "— per run"}
              <span className="block text-faint">
                {node.consumedUnits ?? "—"} consumed · {node.reservedUnits ?? "—"} reserved on this mission
              </span>
              {d.usage && (
                <span className="block text-faint">
                  mission {d.usage.committed}
                  {d.usage.classBudget ? ` / ${d.usage.classBudget} (${d.usage.percentOfClassBudget}%)` : ""} · {d.usage.note}
                </span>
              )}
              {replay && <span className="block text-faint">mission governor usage: not recorded per step</span>}
            </Field>
            <Field label="lifecycle">
              <span className="flex flex-wrap gap-1">
                {node.stepStatuses.map((s) => (
                  <span key={s.state} className={cn("chip", s.status === "current" ? "chip-signal" : s.status === "completed" ? "chip-ok" : "chip-dim")}>
                    {stateLabel(s.state)} · {s.status}
                  </span>
                ))}
              </span>
            </Field>
            {(validationVerdict || inProgress) && (
              <Field label="validation">
                {validationVerdict ? `latest verdict: ${validationVerdict}` : ""}
                {inProgress ? <span className="block tone-warn">in progress on {d.validation.inProgress?.to ?? "—"}</span> : null}
              </Field>
            )}
          </Fields>
        ) : (
          <>
            <EmptyNote>No mission in focus. The map is dormant.</EmptyNote>
            {node.recent ? (
              <Fields>
                <Field label="last run">
                  <Link href={`/tasks/${encodeURIComponent(node.recent.taskId)}`} className="font-mono text-signal">
                    {node.recent.taskId}
                  </Link>
                  <span className="block text-dim">
                    {runStatusText(node.recent)} · {node.recent.kind}, round {node.recent.round ?? 0}
                  </span>
                  <span className="block text-faint">completed {dateTime(node.recent.completedAt)}</span>
                </Field>
              </Fields>
            ) : (
              <EmptyNote>No recent run of this role in /api/agents.</EmptyNote>
            )}
          </>
        )}
      </Section>

      <Section title="Run history" right={<span className="label text-faint">{node.runs.length} run(s)</span>}>
        {node.runs.length === 0 ? (
          <EmptyNote>{d?.summaryUnavailable ? "unavailable: state.json is not usable" : "no runs recorded on this mission"}</EmptyNote>
        ) : (
          <ol className="flex flex-col gap-1.5">
            {[...node.runs].reverse().map((r, i) => (
              <li key={`${r.startedAt}-${i}`} className="border border-border px-2 py-1.5">
                <div className="flex flex-wrap items-center gap-x-2">
                  <span className={cn("label-md", r.status === "pending" ? "tone-signal" : r.status === "lost" ? "tone-danger" : r.status === "not-launched" ? "tone-dim" : "text-foreground")}>{runStatusText(r)}</span>
                  <span className="ml-auto label text-faint">
                    {r.kind} · round {r.round ?? 0}
                    {r.rerun ? " · rerun" : ""}
                  </span>
                </div>
                <div className="label num text-faint">
                  {timeHMS(r.startedAt)} → {r.completedAt ? `${timeHMS(r.completedAt)} (${durationMs(r.durationMs)})` : "—"} · {r.reservedUnits ?? "—"} units · {r.agentId ?? "no agent id"}
                </div>
              </li>
            ))}
          </ol>
        )}
      </Section>

      {d && (
        <>
          <Section title="Files changed" right={<span className="label text-faint">{files.reduce((n, g) => n + g.files.length, 0)} file(s)</span>}>
            {files.length === 0 ? (
              <EmptyNote>none reported by this role</EmptyNote>
            ) : (
              files.map((g, i) => (
                <details key={i} open={i === files.length - 1} className="mb-1">
                  <summary className="cursor-pointer label text-dim">
                    round {g.round ?? "—"} · {g.files.length} file(s)
                  </summary>
                  <ul className="mt-1 font-mono text-[11px] text-dim">
                    {g.files.map((f) => (
                      <li key={f} className="break-all">
                        {f}
                      </li>
                    ))}
                  </ul>
                </details>
              ))
            )}
          </Section>
          <Section title="Tests run" right={<span className="label text-faint">{tests.length}</span>}>
            {tests.length === 0 ? (
              <EmptyNote>none reported by this role</EmptyNote>
            ) : (
              <ul className="flex flex-col gap-1">
                {tests.map((t, i) => (
                  <li key={i} className="font-mono text-[11px]">
                    <span className="text-foreground">{t.cmd}</span> <span className="text-dim">→ {t.result}</span>
                    <span className="text-faint"> · round {t.round ?? "—"}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title={role === "developer" ? "Relevant findings · raised or addressed" : "Relevant findings · raised by this role"} right={<span className="label text-faint">{roleFindings.length}</span>}>
            {roleFindings.length === 0 ? (
              <EmptyNote>none</EmptyNote>
            ) : (
              <ol className="-mx-2">
                {roleFindings.map((f) => (
                  <ThreatRow key={f.id} finding={f} selected={false} onOpen={onOpenFinding} />
                ))}
              </ol>
            )}
          </Section>
          <Section title="Events" right={<span className="label text-faint">last {roleEvents.length}</span>}>
            {roleEvents.length === 0 ? (
              <EmptyNote>{events ? "no events carry this role" : "events not loaded"}</EmptyNote>
            ) : (
              <ol>
                {roleEvents.map((item) => (
                  <ActivityLine key={item.seq} item={item} />
                ))}
              </ol>
            )}
          </Section>
        </>
      )}

      <Section title="Elsewhere">
        {node.elsewhere.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {node.elsewhere.map((r, i) => (
              <li key={`${r.taskId}-${i}`}>
                <Link href={`/tasks/${encodeURIComponent(r.taskId)}`} className="font-mono text-signal">
                  {r.taskId}
                </Link>{" "}
                <span className="text-dim">{runStatusText(r)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyNote>{agents ? "no pending run of this role on another mission" : notLoaded("agents")}</EmptyNote>
        )}
        <Fields>
          {slotMax !== null && <Field label={role === "developer" ? "developer slots" : "validator slots"} value={`${slotUsed ?? 0} / ${slotMax} pending (global)`} />}
          {modelMax !== null && <Field label={`${modelClass} slots`} value={`${modelUsed ?? 0} / ${modelMax} pending (global)`} />}
        </Fields>
        <SourceLine source="/api/agents active · /api/governor global, policy.global" />
      </Section>
    </>
  );
}
