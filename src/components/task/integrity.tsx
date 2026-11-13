"use client";
import type { TaskDetail, TaskSummary } from "@/lib/api-types";
import { cn } from "@/lib/utils";
import { StatusBadge } from "@/components/ui/badge";

export function IntegrityBadges({ integrity }: { integrity: TaskSummary["integrity"] }) {
  const logOk = integrity.log === "ok";
  const cacheOk = integrity.cache === "fresh";
  if (logOk && cacheOk) return <span className="label text-faint">{integrity.chainChecked ? "chain ok" : "tail ok"}</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {!logOk && <StatusBadge value={`log ${integrity.log}`} />}
      {!cacheOk && <StatusBadge value={`cache ${integrity.cache}`} />}
    </span>
  );
}

export function integrityProblems(integrity: TaskDetail["integrity"]): string[] {
  const problems: string[] = [];
  if (integrity.log === "corrupt") problems.push(`events.jsonl is corrupt at line ${integrity.corruptLine ?? "?"} (${integrity.corruptReason ?? "chain check failed"}); showing the valid prefix`);
  if (integrity.log === "incomplete") problems.push("events.jsonl has no complete TASK_CREATED first event (creation interrupted)");
  if (integrity.log === "torn_tail") problems.push(`events.jsonl ends with a torn line (${integrity.tornBytes ?? 0} B); it is ignored, as brain-state does`);
  if (integrity.log === "missing") problems.push("events.jsonl is missing");
  if (integrity.log === "unsafe") problems.push("the task directory or its files failed the safety checks (symlink, hard link or foreign owner); nothing was read");
  if (integrity.log === "too_large") problems.push("events.jsonl is larger than the 32 MiB read cap");
  if (integrity.cache === "stale") problems.push(`state.json is behind the log (cache seq ${integrity.cacheSeq ?? "?"}, log seq ${integrity.logSeq}); the log wins for state, the cache for agents, findings and round`);
  if (integrity.cache === "ahead") problems.push(`state.json is ahead of the log (cache seq ${integrity.cacheSeq ?? "?"}, log seq ${integrity.logSeq}); it is not used`);
  if (integrity.cache === "diverged") problems.push(`state.json was derived from a different history (its last hash does not match log line ${integrity.cacheSeq ?? "?"}); it is not used`);
  if (integrity.cache === "unknown") problems.push("state.json exists but could not be checked against the log (the log was not readable); its contents are not shown");
  if (integrity.cache === "invalid") problems.push("state.json is not a brain-state cache of this task; summary built from the log only");
  if (integrity.cache === "missing") problems.push("state.json is missing; summary built from the log only");
  if (integrity.cache === "unsafe") problems.push("state.json failed the safety checks and was not read");
  if (integrity.cache === "too_large") problems.push("state.json is larger than the 8 MiB read cap");
  return problems;
}

export function IntegrityBanner({ task }: { task: TaskDetail }) {
  const { integrity } = task;
  const problems = integrityProblems(integrity);
  const severe = integrity.log === "corrupt" || integrity.log === "unsafe" || integrity.log === "too_large" || integrity.cache === "ahead" || integrity.cache === "diverged";
  const tone = problems.length === 0 ? "border-success/40 tone-ok" : severe ? "border-error/50 tone-danger" : "border-warn/50 tone-warn";
  return (
    <div className={cn("hud px-3 py-1.5 text-[12px]", tone)}>
      <span className="label-md">Integrity · </span>
      {problems.length === 0 ? (
        <span>
          {integrity.chainChecked ? "hash chain check passed" : "tail read only (chain not walked)"} · state.json fresh at seq {integrity.logSeq}. This is a chain check, not a full <code>brain-state verify</code> (canonical form is not checked).
        </span>
      ) : (
        <ul className="list-inside list-disc">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
