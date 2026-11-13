"use client";
import type { GateFacet } from "@/lib/ui/gate";
import type { GateNodeModel } from "@/lib/ui/command-map";
import { dateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Glyph } from "@/components/ui/glyphs";
import { ActivityLine } from "@/components/events/activity-line";
import { EmptyNote, Field, Fields, Section, SourceLine } from "@/components/panels/side-panel";

function facetChip(f: GateFacet): string {
  switch (f.state) {
    case "action-required":
      return "chip-warn";
    case "passed":
      return "chip-ok";
    case "not-required":
    case "sealed":
      return "chip-dim";
    default:
      return "chip-dim";
  }
}

/** `replay`: a replayed step; what it waited on is recorded history, not a request now. */
export function GatePanel({ node, replay = false }: { node: GateNodeModel; replay?: boolean }) {
  const g = node.gate;
  const headline = replay ? (g.active ? "approval was awaited at this recorded step" : "nothing pending at this recorded step") : g.active ? "action required" : "nothing pending on this mission";
  return (
    <>
      <div className={cn("mb-4 border px-3 py-2", g.active ? "border-warn/60" : "border-border")}>
        <p className={cn("label-md flex items-center gap-2", g.active ? "tone-warn" : "text-dim")}>
          <Glyph name="lock" size={12} /> Commander approval · {headline}
        </p>
        <p className="mt-1 text-[12px] text-dim">
          Approval happens in the Claude Code session, through the user&apos;s own message to brain-gate. This dashboard is read-only: it shows the request and never carries a code or a control.
        </p>
      </div>

      <Section title="Gates">
        <Fields>
          <Field label="plan gate">
            <span className={cn("chip", facetChip(g.plan))}>{g.plan.label}</span>
            <span className="block text-faint">planner → developer · lifecycle WAITING_FOR_APPROVAL {g.plan.stepStatus ?? "—"}</span>
          </Field>
          <Field label="human gate">
            <span className={cn("chip", facetChip(g.human))}>{g.human.label}</span>
            <span className="block text-faint">after READY · lifecycle HUMAN_APPROVAL {g.human.stepStatus ?? "—"}</span>
          </Field>
        </Fields>
        <SourceLine source={g.human.source} />
      </Section>

      <Section title={replay ? "Request open at this step" : "Open request"}>
        {g.request ? (
          <Fields>
            <Field label="request" value={g.request.text} />
            <Field label="what" value={g.request.detail ?? "(no detail recorded)"} />
            <Field label="at" value={`${dateTime(g.request.ts)} · #${g.request.seq}`} />
          </Fields>
        ) : g.requestOutsideWindow ? (
          <EmptyNote>request not in the loaded event window</EmptyNote>
        ) : (
          <EmptyNote>{g.active ? "no open request line in the loaded events" : "none"}</EmptyNote>
        )}
        {g.request && <SourceLine source={g.request.source} />}
        {g.lastDecision && (
          <>
            <h4 className="mt-3 label text-dim">Last decision</h4>
            <ol>
              <ActivityLine item={g.lastDecision} />
            </ol>
          </>
        )}
      </Section>

      <Section title="Plan scope">
        {g.planScope ? (
          <Fields>
            <Field label="plan" value={`${g.planScope.approved ? "approved" : "not approved"} · by ${g.planScope.author ?? "?"} · ${g.planScope.chars ?? "?"} chars`} />
            <Field label="approved scope" value={g.planScope.approvedScope.join("; ") || null} />
            <Field label="not approved" value={g.planScope.notApproved.join("; ") || null} />
          </Fields>
        ) : (
          <EmptyNote>no plan recorded on this mission</EmptyNote>
        )}
        <SourceLine source="/api/tasks/:id plan" />
      </Section>

      <Section title="brain-gate">
        {g.brainGate ? (
          <Fields>
            <Field label="state file" value={g.brainGate.status} />
            <Field label="pending requests" value={`${g.brainGate.pending} (all tasks)`} />
            {Object.keys(g.brainGate.pendingByAction).length > 0 && (
              <Field
                label="by action"
                value={Object.entries(g.brainGate.pendingByAction)
                  .map(([k, v]) => `${k} ${v}`)
                  .join(", ")}
              />
            )}
          </Fields>
        ) : (
          <EmptyNote>{replay ? "not part of the recorded history" : "health not loaded on this page"}</EmptyNote>
        )}
        {g.brainGate && <SourceLine source={g.brainGate.source} />}
      </Section>
    </>
  );
}
