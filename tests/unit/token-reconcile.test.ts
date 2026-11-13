import { describe, expect, it } from "vitest";
import { rootsFromHome } from "@/server/brain/roots";
import { resetTokenScanStateForTests } from "@/server/tokens/scan";
import { tokenIntelligenceResponse } from "@/server/tokens/report";
import { freshHome, writeScript } from "../helpers/fixture-store";
import { assistantLine, projectDirName, writeSessionTranscript, writeSubagentTranscript } from "../helpers/transcript-fixtures";

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const DAY = "2026-10-15";

/** Fictional, obviously synthetic reference counts (no real usage figure is kept in this repo). */
const SYNTHETIC = { calls: 300, input: 1_000, output: 200_000, cacheRead: 50_000_000, cacheWrite: 1_000_000 } as const;
/** The synthetic developer subagent's share: 200 of the 300 calls and 30,000,000 of the cache read. */
const DEV_CALLS = 200;
const DEV_CACHE_READ = 30_000_000;
const OTHER_CALLS = SYNTHETIC.calls - DEV_CALLS;

function distribute(total: number, n: number): number[] {
  const base = Math.floor(total / n);
  const rem = total - base * n;
  const out = new Array(n).fill(base);
  out[n - 1] += rem;
  return out;
}

function tsAt(i: number): string {
  const h = String(8 + Math.floor(i / 3600)).padStart(2, "0");
  const m = String(Math.floor((i % 3600) / 60)).padStart(2, "0");
  const s = String(i % 60).padStart(2, "0");
  return `${DAY}T${h}:${m}:${s}Z`;
}

describe("the fixture reconciliation reproduces a synthetic reference exactly", () => {
  it("300 calls, input 1,000, output 200,000, cache read 50,000,000, cache write 1,000,000; developer/claude-sonnet-5 = 200 calls / 30,000,000 cache read", async () => {
    resetTokenScanStateForTests();
    const home = freshHome();
    const roots = rootsFromHome(home);
    const proj = projectDirName("/repo/reconcile");

    // developer subagent: 200 calls, carries all of the output and the larger cache-read share
    const devOutput = distribute(SYNTHETIC.output, DEV_CALLS);
    const devCacheRead = distribute(DEV_CACHE_READ, DEV_CALLS);
    const devLines = Array.from({ length: DEV_CALLS }, (_, i) => assistantLine(`dev-${i}`, "claude-sonnet-5", { output: devOutput[i], cacheRead: devCacheRead[i] }, tsAt(i)));
    writeSubagentTranscript(home, proj, "dev-baseline", devLines, "developer");

    // an unattributed session: 100 calls, carries all of the input, the rest of the cache read and all of the cache write
    const otherInput = distribute(SYNTHETIC.input, OTHER_CALLS);
    const otherCacheRead = distribute(SYNTHETIC.cacheRead - DEV_CACHE_READ, OTHER_CALLS);
    const otherCacheWrite = distribute(SYNTHETIC.cacheWrite, OTHER_CALLS);
    const otherLines = Array.from({ length: OTHER_CALLS }, (_, i) =>
      assistantLine(`other-${i}`, "claude-sonnet-5", { input: otherInput[i], cacheRead: otherCacheRead[i], cacheWriteUnsplit: otherCacheWrite[i] }, tsAt(700 + i)),
    );
    writeSessionTranscript(home, proj, "99999999-9999-9999-9999-999999999999", otherLines);

    // the brain-state task the developer subagent links to
    writeScript(home, "BR-20261014-0001", [
      { type: "TASK_CREATED", payload: { summary: "s", class: "STANDARD" }, ts: `${DAY}T07:00:00Z` },
      { type: "AGENT_STARTED", payload: { agent: "developer", agent_id: "dev-baseline" }, ts: `${DAY}T07:01:00Z` },
    ]);

    const r = await tokenIntelligenceResponse(roots, NOW, "30d");
    expect(r.totals.calls).toBe(300);
    expect(r.totals.input).toBe(1000);
    expect(r.totals.output).toBe(200000);
    expect(r.totals.cacheRead).toBe(50000000);
    expect(r.totals.cacheWrite5m + r.totals.cacheWrite1h + r.totals.cacheWriteUnsplit).toBe(1000000);

    const mission = r.byMission.find((m) => m.taskId === "BR-20261014-0001");
    expect(mission).toBeDefined();
    const row = mission?.rows.find((x) => x.agent === "developer" && x.model === "claude-sonnet-5");
    expect(row?.calls).toBe(200);
    expect(row?.cacheRead).toBe(30000000);

    // the single claude-sonnet-5 row in byModel covers every call
    expect(r.byModel).toHaveLength(1);
    expect(r.byModel[0]?.calls).toBe(300);
    expect(r.byModel[0]?.priced).toBe(true);

    // no nulls where a number is expected, and the response stays shallow
    const json = JSON.parse(JSON.stringify(r)) as typeof r;
    expect(json.totals.calls).not.toBeNull();
    expect(json.byMission[0]?.rows[0]?.calls).not.toBeNull();
    expect(typeof json.coverage.scanMs).toBe("number");
  });

  it("dedupes a repeated message id across lines in the same file (A1: last occurrence wins)", async () => {
    resetTokenScanStateForTests();
    const home = freshHome();
    const roots = rootsFromHome(home);
    const proj = projectDirName("/repo/dup");
    writeSessionTranscript(home, proj, "11111111-9999-9999-9999-999999999999", [
      assistantLine("dup-1", "claude-sonnet-5", { input: 10 }, `${DAY}T08:00:00Z`),
      assistantLine("dup-1", "claude-sonnet-5", { input: 50 }, `${DAY}T08:00:01Z`),
      assistantLine("dup-2", "claude-sonnet-5", { input: 1 }, `${DAY}T08:00:02Z`),
    ]);
    const r = await tokenIntelligenceResponse(roots, NOW, "30d");
    expect(r.totals.calls).toBe(2);
    expect(r.totals.input).toBe(51); // 50 (the later dup-1) + 1
    expect(r.coverage.duplicateRecords).toBeGreaterThanOrEqual(1);
  });

  it("prices a subagent split's 1h-write-heavy calls differently from an all-5m sensitivity recompute", async () => {
    resetTokenScanStateForTests();
    const home = freshHome();
    const roots = rootsFromHome(home);
    const proj = projectDirName("/repo/sensitivity");
    writeSubagentTranscript(home, proj, "sens-1", [assistantLine("sens", "claude-sonnet-5", { cacheWrite1h: 1_000_000 }, `${DAY}T08:00:00Z`)], "qa");
    const r = await tokenIntelligenceResponse(roots, NOW, "30d");
    expect(r.totals.costUsd).toBeCloseTo(4, 6); // 1h rate: $4 / MTok
    expect(r.totals.costUsdAllWritesAt5m).toBeCloseTo(2.5, 6); // the same tokens at the 5m rate
    expect(r.totals.costUsd).not.toBeCloseTo(r.totals.costUsdAllWritesAt5m, 2);
  });

  it("R5: dedupes a repeated message id ACROSS files by ascending mtime (the original file wins)", async () => {
    resetTokenScanStateForTests();
    const home = freshHome();
    const roots = rootsFromHome(home);
    const proj = projectDirName("/repo/cross-file-dup");
    // the OLDER file (by mtime) is the "original" and must win per A1/R5
    writeSessionTranscript(home, proj, "11111111-8888-8888-8888-888888888888", [assistantLine("shared-id", "claude-sonnet-5", { input: 7 }, `${DAY}T08:00:00Z`)], new Date(NOW - 2 * 24 * 60 * 60 * 1000));
    writeSessionTranscript(home, proj, "22222222-8888-8888-8888-888888888888", [assistantLine("shared-id", "claude-sonnet-5", { input: 999 }, `${DAY}T08:00:00Z`)], new Date(NOW - 1 * 24 * 60 * 60 * 1000));
    const r = await tokenIntelligenceResponse(roots, NOW, "30d");
    expect(r.totals.calls).toBe(1);
    expect(r.totals.input).toBe(7); // the older file's own value, not the newer file's
    expect(r.coverage.crossFileDuplicates).toBe(1);
  });

  it("R4: byAgent.runs counts one run per file with at least one in-window call", async () => {
    resetTokenScanStateForTests();
    const home = freshHome();
    const roots = rootsFromHome(home);
    const proj = projectDirName("/repo/r4-runs");
    writeSubagentTranscript(home, proj, "runs-a", [assistantLine("ra1", "claude-sonnet-5", { input: 1 }, `${DAY}T08:00:00Z`)], "qa");
    writeSubagentTranscript(home, proj, "runs-b", [assistantLine("rb1", "claude-sonnet-5", { input: 1 }, `${DAY}T08:01:00Z`)], "qa");
    const r = await tokenIntelligenceResponse(roots, NOW, "30d");
    const row = r.byAgent.find((a) => a.agent === "qa");
    expect(row?.runs).toBe(2);
  });

  it("computes context start/peak per file and flags rebuild causes (afterTtlGap vs other)", async () => {
    resetTokenScanStateForTests();
    const home = freshHome();
    const roots = rootsFromHome(home);
    const proj = projectDirName("/repo/context");
    // call 1: starting context 30,000. call 2 (6 min later, a 5m write > cacheRead and > 20,000): a
    // rebuild after a TTL gap. call 3 (right after, a 1h write with no gap): a rebuild for "other".
    writeSubagentTranscript(
      home,
      proj,
      "ctx-1",
      [
        assistantLine("ctx-1-a", "claude-sonnet-5", { input: 30_000 }, `${DAY}T08:00:00Z`),
        assistantLine("ctx-1-b", "claude-sonnet-5", { cacheRead: 1000, cacheWrite5m: 25_000 }, `${DAY}T08:06:00Z`),
        assistantLine("ctx-1-c", "claude-sonnet-5", { cacheRead: 1000, cacheWrite1h: 40_000 }, `${DAY}T08:06:05Z`),
      ],
      "developer",
    );
    const r = await tokenIntelligenceResponse(roots, NOW, "30d");
    const agentCtx = r.context.byAgent.find((a) => a.agent === "developer");
    expect(agentCtx?.startMax).toBe(30_000); // the first call's context
    expect(agentCtx?.peakMax).toBe(41_000); // the third call: 1000 + 40,000
    expect(r.context.rebuilds.count).toBe(2);
    expect(r.context.rebuilds.byCause.afterTtlGap).toBe(1); // the 5m-write call, 6 minutes after the first
    expect(r.context.rebuilds.byCause.other).toBe(1); // the 1h-write call, 5 s after the previous one
  });

  it("Q2/R3/S1: baseline scope is the main session + its own subagents only, on the baseline day, with match/mismatch/unavailable", async () => {
    resetTokenScanStateForTests();
    const home = freshHome();
    const roots = rootsFromHome(home);
    const baselineSessionId = "99999999-7777-7777-7777-777777777777";
    const proj = projectDirName("/repo/baseline-scope");

    // nothing written yet: unavailable (no main file for this session id)
    const unavailable = await tokenIntelligenceResponse(roots, NOW, "30d", { baselineSessionId, baselineDay: DAY, baselineExpected: SYNTHETIC });
    expect(unavailable.reconciliation.baseline.status).toBe("unavailable");
    expect(unavailable.reconciliation.baseline.actual).toBeNull();

    // the main file + its OWN subagent (same session): 2 calls total
    writeSessionTranscript(home, proj, baselineSessionId, [assistantLine("base-main-1", "claude-sonnet-5", { input: 10 }, `${DAY}T08:00:00Z`)]);
    writeSubagentTranscript(home, proj, "base-dev", [assistantLine("base-dev-1", "claude-sonnet-5", { input: 20 }, `${DAY}T08:01:00Z`)], "developer", { parentSession: baselineSessionId });
    // a decoy: a DIFFERENT session's own subagent, same project, same day — must be excluded (A2/Q2)
    writeSubagentTranscript(home, proj, "decoy-dev", [assistantLine("decoy-1", "claude-sonnet-5", { input: 999_999 }, `${DAY}T08:02:00Z`)], "developer");

    resetTokenScanStateForTests();
    const mismatch = await tokenIntelligenceResponse(roots, NOW, "30d", { baselineSessionId, baselineDay: DAY, baselineExpected: SYNTHETIC });
    expect(mismatch.reconciliation.baseline.status).toBe("mismatch"); // 2 calls/30 input, not the synthetic 300/1,000
    expect(mismatch.reconciliation.baseline.actual?.calls).toBe(2);
    expect(mismatch.reconciliation.baseline.actual?.input).toBe(30);
    expect(mismatch.reconciliation.baseline.diff?.calls).toBe(2 - 300);
    expect(mismatch.reconciliation.baseline.coverage.subagentFilesFound).toBe(1); // only the baseline session's own subagent
    expect(mismatch.reconciliation.baseline.coverage.mainFound).toBe(true);

  });

  it("Q2: a scope that exactly reproduces the reference numbers reports status 'match'", async () => {
    resetTokenScanStateForTests();
    const home = freshHome();
    const roots = rootsFromHome(home);
    const baselineSessionId = "88888888-6666-6666-6666-666666666666";
    const proj = projectDirName("/repo/baseline-match");

    const devOutput = distribute(SYNTHETIC.output, DEV_CALLS);
    const devCacheRead = distribute(DEV_CACHE_READ, DEV_CALLS);
    const devLines = Array.from({ length: DEV_CALLS }, (_, i) => assistantLine(`m-dev-${i}`, "claude-sonnet-5", { output: devOutput[i], cacheRead: devCacheRead[i] }, tsAt(i)));
    writeSubagentTranscript(home, proj, "match-dev", devLines, "developer", { parentSession: baselineSessionId });

    const mainInput = distribute(SYNTHETIC.input, OTHER_CALLS);
    const mainCacheRead = distribute(SYNTHETIC.cacheRead - DEV_CACHE_READ, OTHER_CALLS);
    const mainCacheWrite = distribute(SYNTHETIC.cacheWrite, OTHER_CALLS);
    const mainLines = Array.from({ length: OTHER_CALLS }, (_, i) =>
      assistantLine(`m-main-${i}`, "claude-sonnet-5", { input: mainInput[i], cacheRead: mainCacheRead[i], cacheWriteUnsplit: mainCacheWrite[i] }, tsAt(700 + i)),
    );
    writeSessionTranscript(home, proj, baselineSessionId, mainLines);

    const r = await tokenIntelligenceResponse(roots, NOW, "30d", { baselineSessionId, baselineDay: DAY, baselineExpected: SYNTHETIC });
    expect(r.reconciliation.baseline.status).toBe("match");
    expect(r.reconciliation.baseline.diff).toEqual({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("with no reference configured: expected and CodeBurn values are null and status is 'unavailable', while the scope is still measured", async () => {
    resetTokenScanStateForTests();
    const home = freshHome();
    const roots = rootsFromHome(home);
    const baselineSessionId = "77777777-5555-5555-5555-555555555555";
    writeSessionTranscript(home, projectDirName("/repo/no-reference"), baselineSessionId, [assistantLine("noref-1", "claude-sonnet-5", { input: 10 }, `${DAY}T08:00:00Z`)]);

    const r = await tokenIntelligenceResponse(roots, NOW, "30d", { baselineSessionId, baselineDay: DAY });
    expect(r.reconciliation.fixture.expected).toBeNull();
    expect(r.reconciliation.baseline.expected).toBeNull();
    expect(r.reconciliation.baseline.status).toBe("unavailable");
    expect(r.reconciliation.baseline.diff).toBeNull();
    expect(r.reconciliation.baseline.actual?.calls).toBe(1);
    expect(r.reconciliation.baseline.actual?.input).toBe(10);
    expect(r.reconciliation.reference30d.codeburnAttributedUsd).toBeNull();
    expect(r.reconciliation.reference30d.codeburnRecomputedUsd).toBeNull();
    expect(r.reconciliation.reference30d.brainRecomputeUsd).toBeGreaterThan(0);
  });
});
