"use client";
import Link from "next/link";
import type { GovernorResponse, HealthResponse, TasksResponse } from "@/lib/api-types";
import { dateTime, relativeAge, timeHMS } from "@/lib/format";
import { stateLabel } from "@/lib/lifecycle";
import type { CommandMapModel } from "@/lib/ui/command-map";
import { buildMissionStrip } from "@/lib/ui/mission";
import { cn } from "@/lib/utils";
import type { Opener } from "@/components/map/map-node";
import { ThreatRow } from "@/components/map/threat-rail";
import { EmptyNote, Field, Fields, Section, SourceLine } from "@/components/panels/side-panel";

function chipFor(status: string): string {
  if (status === "ok" || status === "fresh") return "chip-ok";
  if (status === "degraded" || status === "stale" || status === "missing" || status === "torn_tail") return "chip-warn";
  if (status === "loading") return "chip-dim";
  return "chip-danger";
}

export function CorePanel({
  model,
  health,
  governor,
  tasks,
  onOpenFinding,
  replay = false,
}: {
  model: CommandMapModel;
  health: HealthResponse | null;
  governor: GovernorResponse | null;
  tasks: TasksResponse | null;
  onOpenFinding: (id: string, opener: Opener) => void;
  /** A replay frame: health, brain-gate and the governor are not part of the recorded history. */
  replay?: boolean;
}) {
  const d = model.detail;
  const t = health?.sources.tasks;
  const gate = health?.sources.gate;
  const policy = governor?.policy ?? null;
  const anchored = model.threats.filter((x) => x.anchor === "core");
  const missing = (what: string) => (replay ? "not part of the recorded history" : `${what} not loaded on this page`);
  return (
    <>
      <Section title="Command core">
        <Fields>
          <Field label="state" value={model.core.statusText} />
          <Field label="mode" value={model.mode} />
          {d && (
            <>
              <Field label="mission">
                <Link href={`/tasks/${encodeURIComponent(d.id)}`} className="font-mono text-signal">
                  {d.id}
                </Link>
              </Field>
              <Field label="lifecycle" value={d.lifecycle.current ? stateLabel(d.lifecycle.current) : null} />
              <Field label="next action" value={d.nextAction} />
              {model.core.blockedReason && <Field label="blocked reason" value={model.core.blockedReason} />}
              {model.core.blockedNeeds.length > 0 && <Field label="blocked needs" value={model.core.blockedNeeds.join("; ")} />}
              {model.core.unknownRoles.length > 0 && <Field label="unknown roles in runs" value={model.core.unknownRoles.join(", ")} />}
              <Field label="integrity">
                <span className="flex flex-wrap gap-1">
                  <span className={cn("chip", chipFor(d.integrity.log))}>log {d.integrity.log}</span>
                  <span className={cn("chip", chipFor(d.integrity.cache))}>cache {d.integrity.cache}</span>
                  <span className="chip chip-dim">{d.integrity.chainChecked ? "chain walked" : "tail read"}</span>
                </span>
              </Field>
            </>
          )}
          {!d &&
            tasks &&
            (() => {
              const strip = buildMissionStrip(tasks.tasks, tasks.generatedAt);
              return (
                <Field
                  label="missions in store"
                  value={`${tasks.counts.total} · ${strip.liveCount} live · ${strip.openCount} open · ${tasks.counts.openFindings} open findings (non-terminal)`}
                />
              );
            })()}
        </Fields>
        <SourceLine source={model.core.source} />
      </Section>

      {d && (
        <Section title="Findings anchored to the core" right={<span className="label text-faint">{anchored.length}</span>}>
          {anchored.length === 0 ? (
            <EmptyNote>{model.findingsLoaded ? "none: every finding names a recognised role" : "findings not loaded"}</EmptyNote>
          ) : (
            <ol className="-mx-2">
              {anchored.map((x) => (
                <ThreatRow key={x.id} finding={x.finding} selected={false} onOpen={onOpenFinding} />
              ))}
            </ol>
          )}
          <SourceLine source={`/api/tasks/${d.id}/findings (sources brain or unrecognised)`} />
        </Section>
      )}

      <Section title="Health" right={replay ? <span className="chip chip-dim">not recorded</span> : <span className={cn("chip", chipFor(health?.status ?? "loading"))}>{health?.status ?? "loading"}</span>}>
        {t ? (
          <Fields>
            <Field label="task store" value={`${t.status} · ${t.taskCount} task(s)${t.scanLimitReached ? " · scan cap reached" : ""}`} />
            <Field label="unsafe entries" value={t.unsafeEntries} />
            <Field label="corrupt / incomplete / torn" value={`${t.corrupt} / ${t.incomplete} / ${t.tornTail}`} />
            <Field label="cache stale / ahead / diverged" value={`${t.cacheStale} / ${t.cacheAhead} / ${t.cacheDiverged}`} />
            <Field label="last event" value={health?.lastEventAt ? `${timeHMS(health.lastEventAt)} (${relativeAge(health.lastEventAt)})` : null} />
            <Field label="stale reservations" value={health?.pendingRunsOverStaleThreshold ?? 0} />
            <Field label="governor policy">
              <span className={cn("chip", chipFor(health?.sources.governor.status ?? "loading"))}>{health?.sources.governor.status}</span>
            </Field>
          </Fields>
        ) : (
          <EmptyNote>{health ? "no task store data" : missing("health")}</EmptyNote>
        )}
        {health && health.reasons.length > 0 && (
          <ul className="mt-2 list-inside list-disc tone-warn">
            {health.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
        <SourceLine source="/api/health" />
      </Section>

      <Section title="brain-gate" right={gate ? <span className={cn("chip", chipFor(gate.status))}>{gate.status}</span> : undefined}>
        {gate ? (
          <Fields>
            <Field label="requests" value={`${gate.requests.pending} pending · ${gate.requests.expired} expired · ${gate.requests.consumed} consumed · ${gate.requests.revoked} revoked`} />
            {Object.keys(gate.requests.pendingByAction).length > 0 && (
              <Field
                label="pending by action"
                value={Object.entries(gate.requests.pendingByAction)
                  .map(([k, v]) => `${k} ${v}`)
                  .join(", ")}
              />
            )}
            <Field label="audit (24h)">
              {gate.audit.status !== "ok"
                ? gate.audit.status
                : Object.entries(gate.audit.countsByEvent)
                    .sort((a, b) => b[1] - a[1])
                    .map(([k, v]) => `${k} ${v}`)
                    .join(", ") || "no events"}
              {gate.audit.partial ? <span className="text-faint"> (tail window only)</span> : null}
            </Field>
            <Field label="last FAIL_CLOSED" value={gate.audit.lastFailClosedAt ? dateTime(gate.audit.lastFailClosedAt) : null} />
            <Field label="latest validations">
              {gate.latestValidations.length === 0 ? (
                <span className="text-faint">none recorded</span>
              ) : (
                <ul>
                  {gate.latestValidations.map((v, i) => (
                    <li key={i} className="font-mono text-[11px]">
                      {timeHMS(v.ts)} {v.to ?? "—"} <span className="text-dim">{v.verdict}</span> <span className="text-faint">{v.repo ?? ""}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Field>
          </Fields>
        ) : (
          <EmptyNote>{missing("brain-gate")}</EmptyNote>
        )}
        <SourceLine source="/api/health sources.gate (aggregates only; no codes, requests or commands are read)" />
      </Section>

      <Section title="Governor policy">
        {policy ? (
          <Fields>
            <Field
              label="units per run"
              value={Object.entries(policy.agents)
                .map(([k, v]) => `${k} ${v.policyUnits} (${v.model})`)
                .join(" · ")}
            />
            <Field
              label="class budgets"
              value={Object.entries(policy.taskBudgets)
                .map(([k, v]) => `${k} ${v}`)
                .join(" · ")}
            />
            <Field label="soft limit" value={`${policy.softLimitPercent}% · stale after ${policy.staleAfterMinutes} min · ${policy.maxParallelPerTask} parallel per mission`} />
            <Field label="global slots" value={`${policy.global.max_total_agents} total · ${policy.global.max_developers} developer · ${policy.global.max_validators} validators · ${policy.global.max_opus_agents} opus · ${policy.global.max_fable_agents} fable`} />
            {policy.note && <Field label="note" value={policy.note} />}
          </Fields>
        ) : (
          <EmptyNote>{governor ? `policy ${governor.policyStatus}${governor.policyReason ? `: ${governor.policyReason}` : ""}` : missing("governor")}</EmptyNote>
        )}
        {governor && (
          <>
            <h4 className="mt-3 label text-dim">Denials (non-terminal missions)</h4>
            {governor.denials.length === 0 ? (
              <EmptyNote>none</EmptyNote>
            ) : (
              <ul className="mt-1 flex flex-col gap-0.5 font-mono text-[11px]">
                {governor.denials.map((x) => (
                  <li key={`${x.taskId}-${x.seq}`}>
                    <span className="text-faint">{timeHMS(x.ts)}</span> {x.taskId} <span className="tone-danger">{x.code}</span> <span className="text-dim">{x.role}</span>
                  </li>
                ))}
              </ul>
            )}
            {governor.softLimitAccepted.length > 0 && <p className="mt-1 tone-warn">{governor.softLimitAccepted.length} soft-limit acceptance(s) recorded</p>}
          </>
        )}
        <SourceLine source="/api/governor policy, denials, softLimitAccepted" />
      </Section>
    </>
  );
}
