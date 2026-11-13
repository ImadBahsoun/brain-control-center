import { describe, expect, it } from "vitest";
import type { TokenBucket, TokenDailyRow, TokenReconciliationLive } from "@/lib/api-types";
import {
  agentLabel,
  coverageChipText,
  dailyBarRows,
  formatCompactTokens,
  formatTokens,
  formatUsd,
  liveStatusText,
  reasonLabel,
  sortByCalls,
  sortByCost,
  totalCacheWrite,
  windowLabel,
} from "@/lib/ui/tokens";

const EMPTY_LIVE_COVERAGE = { filesInScope: 0, mainFound: false, subagentFilesFound: 0, unparseableLines: 0, oversizeLines: 0, recordsOverflowed: 0 };
const EMPTY_COUNTS = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function bucket(over: Partial<TokenBucket> = {}): TokenBucket {
  return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnsplit: 0, webSearchRequests: 0, costUsd: 0, costUsdAllWritesAt5m: 0, unpricedCalls: 0, syntheticCalls: 0, ...over };
}

describe("formatting", () => {
  it("formats USD with cents, and with more precision below a dollar", () => {
    expect(formatUsd(1234.5)).toBe("$1,234.50");
    expect(formatUsd(0.1234)).toBe("$0.1234");
    expect(formatUsd(NaN)).toBe("—");
  });
  it("formats token counts with thousands separators", () => {
    expect(formatTokens(123456789)).toBe("123,456,789");
    expect(formatTokens(0)).toBe("0");
  });
  it("formats compact token counts", () => {
    expect(formatCompactTokens(123456789)).toMatch(/123\.5?M|M/);
  });
});

describe("labels", () => {
  it("labels every agent type", () => {
    for (const a of ["planner", "developer", "qa", "reviewer", "security-reviewer", "general-purpose", "Explore", "Plan", "brain", "main-no-mission", "other-subagent"] as const) {
      expect(agentLabel(a).length).toBeGreaterThan(0);
    }
  });
  it("labels every attribution reason", () => {
    for (const r of [
      "agent-link",
      "mission-window",
      "overlapping-missions",
      "outside-mission-window",
      "session-not-in-brain-state",
      "subagent-not-in-brain-state",
      "ambiguous-agent-id",
      "mission-log-unusable",
    ] as const) {
      expect(reasonLabel(r).length).toBeGreaterThan(0);
    }
  });
  it("labels the window", () => {
    expect(windowLabel("7d")).toContain("7");
    expect(windowLabel("30d")).toContain("30");
  });
});

describe("liveStatusText never implies exact agreement unless status is match", () => {
  const base: TokenReconciliationLive = { status: "match", expected: EMPTY_COUNTS, actual: null, diff: null, coverage: EMPTY_LIVE_COVERAGE };
  it("match", () => {
    expect(liveStatusText({ ...base, status: "match" })).toMatch(/exactly/);
  });
  it("mismatch never says matches or exactly", () => {
    const t = liveStatusText({ ...base, status: "mismatch" });
    expect(t).not.toMatch(/matches exactly/i);
    expect(t.toLowerCase()).toContain("differ");
  });
  it("unavailable never claims agreement", () => {
    const t = liveStatusText({ ...base, status: "unavailable" });
    expect(t).not.toMatch(/matches/i);
  });
});

describe("coverageChipText", () => {
  const COVERAGE_BASE = {
    filesScanned: 0,
    filesFromMemo: 0,
    filesSkippedUnsafe: 0,
    filesUnreadable: 0,
    linesUnparseable: 0,
    oversizeLines: 0,
    oversizeAssistantLines: 0,
    duplicateRecords: 0,
    crossFileDuplicates: 0,
    missionsScanLimitReached: false,
    missionLogsUnusable: 0,
    memoEvictions: 0,
    fileCapReached: false,
    recordsOverflowed: 0,
    invalidTimestamps: 0,
    scanMs: 1,
  };
  it("reports the projects dir problem first", () => {
    expect(coverageChipText({ ...COVERAGE_BASE, projectsDir: "missing", complete: true })).toBe("projects missing");
  });
  it("reports complete vs partial when the dir is ok", () => {
    const base = { ...COVERAGE_BASE, projectsDir: "ok" as const };
    expect(coverageChipText({ ...base, complete: true })).toBe("complete");
    expect(coverageChipText({ ...base, complete: false })).toBe("partial");
  });
  it("names specific reasons in the partial chip (R13)", () => {
    const base = { ...COVERAGE_BASE, projectsDir: "ok" as const, complete: false };
    expect(coverageChipText({ ...base, fileCapReached: true })).toContain("file cap reached");
    expect(coverageChipText({ ...base, oversizeLines: 3 })).toContain("3 oversize lines");
    expect(coverageChipText({ ...base, recordsOverflowed: 2 })).toContain("2 records overflowed");
  });
});

describe("sorting and derived totals", () => {
  it("sorts by calls and by cost, descending", () => {
    const rows = [bucket({ calls: 1, costUsd: 5 }), bucket({ calls: 9, costUsd: 1 })];
    expect(sortByCalls(rows)[0]?.calls).toBe(9);
    expect(sortByCost(rows)[0]?.costUsd).toBe(5);
  });
  it("sums the three cache-write categories", () => {
    expect(totalCacheWrite(bucket({ cacheWrite5m: 1, cacheWrite1h: 2, cacheWriteUnsplit: 3 }))).toBe(6);
  });
});

function daily(date: string, costUsd: number): TokenDailyRow {
  return { ...bucket({ costUsd }), date };
}

describe("dailyBarRows", () => {
  it("sorts oldest first regardless of input order", () => {
    const rows = dailyBarRows([daily("2026-10-10", 1), daily("2026-10-07", 2), daily("2026-10-09", 3)]);
    expect(rows.map((r) => r.date)).toEqual(["2026-10-07", "2026-10-09", "2026-10-10"]);
  });
  it("gives the most expensive day a 100% bar and scales the rest off it", () => {
    const rows = dailyBarRows([daily("2026-10-01", 2), daily("2026-10-02", 8)]);
    expect(rows.find((r) => r.date === "2026-10-02")?.pct).toBe(100);
    expect(rows.find((r) => r.date === "2026-10-01")?.pct).toBe(25);
  });
  it("floors every bar at 2% so a near-zero day still draws a sliver", () => {
    const rows = dailyBarRows([daily("2026-10-01", 0), daily("2026-10-02", 100)]);
    expect(rows.find((r) => r.date === "2026-10-01")?.pct).toBe(2);
  });
  it("treats an all-zero window as max 1, not a division by zero", () => {
    const rows = dailyBarRows([daily("2026-10-01", 0), daily("2026-10-02", 0)]);
    for (const r of rows) expect(r.pct).toBe(2);
  });
  it("returns an empty array for an empty window", () => {
    expect(dailyBarRows([])).toEqual([]);
  });
});
