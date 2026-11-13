"use client";
import type { Finding } from "@/lib/api-types";
import { dateTime } from "@/lib/format";
import { threatAnchor, threatClass, THREAT_CLASS_LABEL } from "@/lib/ui/threats";
import { roleLabel } from "@/lib/ui/roles";
import { cn } from "@/lib/utils";
import { severityChip } from "@/components/map/threat-rail";
import { Field, Fields, Section, SourceLine } from "@/components/panels/side-panel";

export function FindingPanel({ finding, missionId }: { finding: Finding; missionId: string | null }) {
  const cls = threatClass(finding);
  const anchor = threatAnchor(finding.sources);
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <span className={cn("chip", severityChip(finding.severity))}>{finding.severity}</span>
        <span className="chip chip-dim">{finding.status}</span>
        <span className={cn("chip", cls === "active" ? "chip-warn" : cls === "resolved" ? "chip-ok" : cls === "neutralizing" ? "chip-signal" : "chip-dim")}>{THREAT_CLASS_LABEL[cls]}</span>
      </div>
      <p className="mb-3 text-[13px] text-foreground">{finding.title}</p>
      <Section title="Finding">
        <Fields>
          <Field label="id" value={finding.id} mono />
          {finding.aliases.length > 0 && <Field label="aliases" value={finding.aliases.join(", ")} mono />}
          <Field label="sources" value={finding.sources.map(roleLabel).join(", ") || null} />
          <Field label="anchored to" value={anchor === "core" ? "Brain core" : roleLabel(anchor)} />
          <Field label="location" value={finding.location} mono />
          <Field label="description" value={finding.description} />
          <Field label="recommendation" value={finding.recommendation} />
          <Field label="rounds" value={`introduced ${finding.introducedRound ?? "—"} · fixed ${finding.fixedRound ?? "—"} · validated ${finding.validatedRound ?? "—"}`} />
          <Field label="created" value={finding.createdAt ? dateTime(finding.createdAt) : null} />
          <Field label="updated" value={finding.updatedAt ? dateTime(finding.updatedAt) : null} />
          <Field label="resolution">
            {finding.resolution ? (
              <>
                {finding.resolution.status}
                {finding.resolution.reason ? <span className="block text-dim">{finding.resolution.reason}</span> : null}
                {finding.resolution.ts ? <span className="block text-faint">{dateTime(finding.resolution.ts)}</span> : null}
              </>
            ) : (
              <span className="text-faint">unresolved</span>
            )}
          </Field>
        </Fields>
        <SourceLine source={`/api/tasks/${missionId ?? ":id"}/findings findings[${finding.id}]`} />
      </Section>
      <Section title="History" right={<span className="label text-faint">{finding.history.length}</span>}>
        {finding.history.length === 0 ? (
          <p className="text-faint">no history recorded</p>
        ) : (
          <ol className="flex flex-col gap-1">
            {finding.history.map((h, i) => (
              <li key={i} className="flex gap-2">
                <span className="label num shrink-0 text-faint">{dateTime(h.ts)}</span>
                <span className="font-mono text-[11px] text-foreground">{h.status}</span>
                {h.reason ? <span className="text-dim">— {h.reason}</span> : null}
              </li>
            ))}
          </ol>
        )}
      </Section>
    </>
  );
}
