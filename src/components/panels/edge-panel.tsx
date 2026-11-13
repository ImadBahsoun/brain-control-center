"use client";
import { edgeRole, nodeName, unknownReason, type CommandMapModel, type EdgeModel, type StepNodeModel } from "@/lib/ui/command-map";
import { timeHMS } from "@/lib/format";
import { stateLabel } from "@/lib/lifecycle";
import { cn } from "@/lib/utils";
import { EdgeSwatch } from "@/components/map/map-edge";
import { EmptyNote, Field, Fields, Section, SourceLine } from "@/components/panels/side-panel";
import { runStatusText } from "@/components/task/agent-runs-table";

const EDGE_TO_STEPS: Record<string, string[]> = { E2: ["PLANNING", "WAITING_FOR_APPROVAL"], E7: ["SYNTHESIZING"], E8: ["SYNTHESIZING"], E9: ["SYNTHESIZING"], E10: ["READY"], E11: ["HUMAN_APPROVAL"], E12: ["FIXING", "REVALIDATING"] };

const STATE_MEANING: Record<EdgeModel["state"], string> = {
  completed: "the hand-off was recorded",
  running: "a run is reserved and no report has arrived yet (the Brain records no liveness)",
  pending: "nothing has happened on this connection yet",
  "waiting-approval": "the commander must approve before the flow continues",
  blocked: "the mission is blocked at this step",
  failed: "the run was lost or reported a failing verdict",
  skipped: "this connection is not part of the mission's path",
  unknown: "the run state cannot be read",
};

/** What an edge state means on this particular edge; the fix loop is a lifecycle loop, not a reservation. */
/** What the edge state means; in a replay, as of the recorded step rather than now. */
function meaning(edge: EdgeModel, model: CommandMapModel): string {
  const text = meaningNow(edge, model);
  return model.mode === "replay" ? `at this recorded step: ${text}` : text;
}

function meaningNow(edge: EdgeModel, model: CommandMapModel): string {
  const d = model.detail;
  if (edge.id === "E12") {
    const current = d?.lifecycle.current;
    if (edge.state === "running" && current === "FIXING") return "a fix round is open: the developer is fixing the findings of this round";
    if (edge.state === "running" && current === "REVALIDATING") return "the fix was delivered; the validators are re-checking it";
    if (edge.state === "completed") return "every fix round of this mission has been closed";
    if (edge.state === "blocked") return "the mission is blocked inside a fix round";
    return "a fix round exists but is not closed yet";
  }
  if (edge.state === "unknown" && d) return `${STATE_MEANING.unknown}: ${unknownReason(d)}`;
  if (edge.synthesizing) return model.mode === "replay" ? "the report was delivered and was in synthesis: the Brain was combining the validators' reports" : "the report was delivered and is in synthesis: the Brain is combining the validators' reports now";
  return STATE_MEANING[edge.state];
}

export function EdgePanel({ edge, model }: { edge: EdgeModel; model: CommandMapModel }) {
  const d = model.detail;
  const role = edgeRole(edge.id);
  const runs = role && d ? d.agents.filter((r) => r.role === role) : [];
  const steps = EDGE_TO_STEPS[edge.id] ?? [];
  return (
    <>
      <div className="mb-3 flex items-center gap-2">
        <EdgeSwatch state={edge.state} synthesizing={edge.synthesizing} />
        <span className={cn("label-md", `tone-${edge.state === "completed" ? "ok" : edge.state === "running" ? "signal" : edge.state === "waiting-approval" ? "warn" : edge.state === "blocked" || edge.state === "failed" ? "danger" : "dim"}`)}>{edge.stateText}</span>
        {edge.synthesizing && <span className="chip chip-synth">in synthesis</span>}
        {edge.stale && <span className="chip chip-warn">stale reservation</span>}
        {edge.dormant && <span className="chip chip-dim">dormant</span>}
      </div>
      <Section title="Connection">
        <Fields>
          <Field label="from" value={nodeName(edge.from)} />
          <Field label="to" value={nodeName(edge.to)} />
          <Field label="carries" value={edge.label} />
          <Field label="state" value={`${edge.stateText} · ${meaning(edge, model)}`} />
          <Field label="detail" value={edge.detail} />
        </Fields>
        <SourceLine source={edge.source} />
      </Section>
      {role && (
        <Section title={`${nodeName(role)} runs behind it`} right={<span className="label text-faint">{runs.length}</span>}>
          {runs.length === 0 ? (
            <EmptyNote>{d ? (d.summaryUnavailable ? `unavailable: ${unknownReason(d)}` : "no runs recorded") : "no mission in focus"}</EmptyNote>
          ) : (
            <ol className="flex flex-col gap-1">
              {runs.map((r, i) => (
                <li key={i} className="font-mono text-[11px]">
                  <span className="text-foreground">{runStatusText(r)}</span> <span className="text-faint">· {r.kind}, round {r.round ?? 0} · {timeHMS(r.startedAt)}</span>
                </li>
              ))}
            </ol>
          )}
        </Section>
      )}
      {steps.length > 0 && d && (
        <Section title="Lifecycle steps behind it">
          <ul className="flex flex-wrap gap-1">
            {steps.map((s) => {
              const step = d.lifecycle.steps.find((x) => x.state === s);
              return (
                <li key={s} className={cn("chip", step?.status === "current" ? "chip-signal" : step?.status === "completed" ? "chip-ok" : "chip-dim")}>
                  {stateLabel(s)} · {step?.status ?? "—"}
                  {step?.enteredAt ? ` · ${timeHMS(step.enteredAt)}` : ""}
                </li>
              );
            })}
          </ul>
          {edge.id === "E12" && d.rounds.length > 0 && (
            <ul className="mt-2 flex flex-col gap-0.5">
              {d.rounds.map((r) => (
                <li key={r.round} className="text-dim">
                  round {r.round} ({r.kind}) · {r.findings.join(", ") || "no findings listed"} · {r.completed ? "closed" : "open"}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
    </>
  );
}

export function StepPanel({ node, model }: { node: StepNodeModel; model: CommandMapModel }) {
  const d = model.detail;
  const state = node.id === "synthesis" ? "SYNTHESIZING" : "READY";
  const step = d?.lifecycle.steps.find((s) => s.state === state) ?? null;
  return (
    <>
      <Section title={node.label}>
        <Fields>
          <Field label="status" value={node.statusText} />
          <Field label="lifecycle step" value={step ? `${step.label} · ${step.status}${step.visits > 1 ? ` · ${step.visits} visits` : ""}` : null} />
          <Field label="entered" value={step?.enteredAt ? timeHMS(step.enteredAt) : null} />
          {node.id === "ready" && d && <Field label="ready flag" value={d.ready ? "READY and not terminal" : d.status === "COMPLETE" ? "mission complete" : "not reached"} />}
          {node.id === "synthesis" && d && <Field label="validation" value={d.validation.latest ? `${d.validation.latest.decision} · ${Object.entries(d.validation.latest.agents).map(([k, v]) => `${k}: ${v}`).join(", ")}` : "none completed"} />}
          {node.id === "synthesis" && d && d.rounds.length > 0 && <Field label="fix rounds" value={d.rounds.map((r) => `round ${r.round} ${r.completed ? "closed" : "open"}`).join(" · ")} />}
        </Fields>
        <SourceLine source={node.source} />
      </Section>
      {!d && <EmptyNote>No mission in focus.</EmptyNote>}
    </>
  );
}
