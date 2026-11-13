"use client";
import type { TokenIntelligenceResponse } from "@/lib/api-types";
import { formatTokens } from "@/lib/ui/tokens";

export function CoveragePanel({ coverage, window: w }: { coverage: TokenIntelligenceResponse["coverage"]; window: TokenIntelligenceResponse["window"] }) {
  return (
    <section className="hud">
      <div className="border-b border-border px-3 py-1.5">
        <h2 className="hud-title">Coverage</h2>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 px-3 py-2 min-[700px]:grid-cols-4">
        <p className="label text-dim">
          projects dir
          <br />
          <span className="text-foreground">{coverage.projectsDir}</span>
        </p>
        <p className="label text-dim">
          complete
          <br />
          <span className="text-foreground">{coverage.complete ? "yes" : "no"}</span>
        </p>
        <p className="label text-dim">
          files scanned
          <br />
          <span className="num text-foreground">{formatTokens(coverage.filesScanned)}</span>
        </p>
        <p className="label text-dim">
          files from memo
          <br />
          <span className="num text-foreground">{formatTokens(coverage.filesFromMemo)}</span>
        </p>
        <p className="label text-dim">
          files skipped (unsafe)
          <br />
          <span className="num text-foreground">{formatTokens(coverage.filesSkippedUnsafe)}</span>
        </p>
        <p className="label text-dim">
          files unreadable
          <br />
          <span className="num text-foreground">{formatTokens(coverage.filesUnreadable)}</span>
        </p>
        <p className="label text-dim">
          oversize lines
          <br />
          <span className="num text-foreground">
            {formatTokens(coverage.oversizeLines)} ({formatTokens(coverage.oversizeAssistantLines)} assistant)
          </span>
        </p>
        <p className="label text-dim">
          unparseable lines
          <br />
          <span className="num text-foreground">{formatTokens(coverage.linesUnparseable)}</span>
        </p>
        <p className="label text-dim">
          duplicate records
          <br />
          <span className="num text-foreground">
            {formatTokens(coverage.duplicateRecords)} ({formatTokens(coverage.crossFileDuplicates)} cross-file)
          </span>
        </p>
        <p className="label text-dim">
          mission logs unusable
          <br />
          <span className="num text-foreground">{formatTokens(coverage.missionLogsUnusable)}</span>
        </p>
        <p className="label text-dim">
          memo evictions
          <br />
          <span className="num text-foreground">{formatTokens(coverage.memoEvictions)}</span>
        </p>
        <p className="label text-dim">
          records overflowed
          <br />
          <span className="num text-foreground">{formatTokens(coverage.recordsOverflowed)}</span>
        </p>
        <p className="label text-dim">
          invalid timestamps
          <br />
          <span className="num text-foreground">{formatTokens(coverage.invalidTimestamps)}</span>
        </p>
        <p className="label text-dim">
          file cap reached
          <br />
          <span className="text-foreground">{coverage.fileCapReached ? "yes" : "no"}</span>
        </p>
        <p className="label text-dim">
          scan time
          <br />
          <span className="num text-foreground">{formatTokens(coverage.scanMs)} ms</span>
        </p>
      </div>
      {coverage.fileCapReached && <p className="px-3 py-1 tone-warn">File scan cap reached: older files are not included.</p>}
      {coverage.missionsScanLimitReached && <p className="px-3 py-1 tone-warn">Mission scan cap reached: older missions are not included.</p>}
      {w.partial && <p className="px-3 py-1 tone-warn">Partial window: {w.retentionNote}.</p>}
    </section>
  );
}
