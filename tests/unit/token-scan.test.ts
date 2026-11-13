import fs from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { rootsFromHome } from "@/server/brain/roots";
import { memoApproxBytesTotalForTests, resetTokenScanStateForTests, scanTranscripts, tokenScanGenerationForTests } from "@/server/tokens/scan";
import { DEDUPE_POLICY } from "@/server/tokens/transcript";
import { freshHome } from "../helpers/fixture-store";
import { appendToTranscript, assistantLine, attachmentLine, projectDirName, writeSessionTranscript, writeSubagentTranscript } from "../helpers/transcript-fixtures";

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function setup() {
  resetTokenScanStateForTests();
  const home = freshHome();
  return { home, roots: rootsFromHome(home) };
}

beforeEach(() => resetTokenScanStateForTests());

describe("DEDUPE_POLICY", () => {
  it("is pinned to last-occurrence-wins", () => {
    expect(DEDUPE_POLICY).toBe("last-occurrence-wins");
  });
});

describe("scanTranscripts", () => {
  it("finds the main session file and its subagents, and skips files older than 31 days", () => {
    const { home, roots } = setup();
    const proj = projectDirName("/repo/a");
    writeSessionTranscript(home, proj, "11111111-1111-1111-1111-111111111111", [assistantLine("m1", "claude-sonnet-5", { input: 10, output: 5 }, "2026-10-19T00:00:00Z")]);
    writeSubagentTranscript(
      home,
      proj,
      "abc123",
      [assistantLine("m2", "claude-sonnet-5", { input: 20, output: 7 }, "2026-10-19T00:00:00Z")],
      "developer",
    );
    const oldFile = writeSessionTranscript(home, proj, "22222222-1111-1111-1111-111111111111", [assistantLine("m3", "claude-sonnet-5", { input: 99, output: 99 }, "2026-01-01T00:00:00Z")]);
    fs.utimesSync(oldFile, new Date(NOW - 60 * DAY), new Date(NOW - 60 * DAY));

    return scanTranscripts(roots, NOW).then((r) => {
      expect(r.coverage.projectsDir).toBe("ok");
      const keys = r.files.map((f) => `${f.kind}:${f.key}`);
      expect(keys).toContain("main:11111111-1111-1111-1111-111111111111");
      expect(keys).toContain("subagent:abc123");
      expect(keys).not.toContain("main:22222222-1111-1111-1111-111111111111");
      const sub = r.files.find((f) => f.kind === "subagent");
      expect(sub?.agentType).toBe("developer");
    });
  });

  it("dedupes repeated message ids within one file, last occurrence wins", async () => {
    const { home, roots } = setup();
    const proj = projectDirName("/repo/b");
    writeSessionTranscript(home, proj, "33333333-1111-1111-1111-111111111111", [
      assistantLine("dup", "claude-sonnet-5", { input: 100, output: 1 }, "2026-10-19T00:00:00Z"),
      assistantLine("dup", "claude-sonnet-5", { input: 5, output: 1 }, "2026-10-19T00:00:05Z"),
    ]);
    const r = await scanTranscripts(roots, NOW);
    const main = r.files.find((f) => f.kind === "main");
    expect(main?.calls).toHaveLength(1);
    expect(main?.calls[0]?.input).toBe(5); // the later line's numbers, not the first
  });

  it("puts a cache_creation_input_tokens total with no 5m/1h breakdown into cacheWriteUnsplit", async () => {
    const { home, roots } = setup();
    const proj = projectDirName("/repo/c");
    const sessionId = "44444444-1111-1111-1111-111111111111";
    writeSessionTranscript(home, proj, sessionId, [assistantLine("u1", "claude-sonnet-5", { cacheWriteUnsplit: 777 }, "2026-10-19T00:00:00Z")]);
    const r = await scanTranscripts(roots, NOW);
    const call = r.files.find((f) => f.kind === "main")?.calls[0];
    expect(call?.cacheWriteUnsplit).toBe(777);
    expect(call?.cacheWrite5m).toBe(0);
    expect(call?.cacheWrite1h).toBe(0);
  });

  it("resuming a grown file yields the same calls as scanning it fully from scratch", async () => {
    const { home, roots } = setup();
    const proj = projectDirName("/repo/d");
    const sessionId = "55555555-1111-1111-1111-111111111111";
    const file = writeSessionTranscript(home, proj, sessionId, [assistantLine("r1", "claude-sonnet-5", { input: 1 }, "2026-10-19T00:00:00Z")]);
    const first = await scanTranscripts(roots, NOW);
    expect(first.files.find((f) => f.kind === "main")?.calls).toHaveLength(1);
    expect(first.coverage.filesScanned).toBe(1);

    appendToTranscript(file, [assistantLine("r2", "claude-sonnet-5", { input: 2 }, "2026-10-19T00:01:00Z")]);
    const second = await scanTranscripts(roots, NOW);
    const ids = second.files.find((f) => f.kind === "main")?.calls.map((c) => c.id).sort();
    expect(ids).toEqual(["r1", "r2"]);

    // the same two calls, one shot: a fresh scan state scanning the final file content once
    resetTokenScanStateForTests();
    const fresh = await scanTranscripts(roots, NOW);
    const freshIds = fresh.files.find((f) => f.kind === "main")?.calls.map((c) => c.id).sort();
    expect(freshIds).toEqual(ids);
  });

  it("rescans fully when the file's inode changes under the same name (replaced, not appended)", async () => {
    const { home, roots } = setup();
    const proj = projectDirName("/repo/e");
    const sessionId = "66666666-1111-1111-1111-111111111111";
    const file = writeSessionTranscript(home, proj, sessionId, [assistantLine("old", "claude-sonnet-5", { input: 1 }, "2026-10-19T00:00:00Z")]);
    await scanTranscripts(roots, NOW);
    fs.unlinkSync(file);
    writeSessionTranscript(home, proj, sessionId, [assistantLine("new", "claude-sonnet-5", { input: 9 }, "2026-10-19T00:00:00Z")]);
    const r = await scanTranscripts(roots, NOW);
    const ids = r.files.find((f) => f.kind === "main")?.calls.map((c) => c.id);
    expect(ids).toEqual(["new"]);
  });

  it("rescans fully when a file shrinks", async () => {
    const { home, roots } = setup();
    const proj = projectDirName("/repo/f");
    const sessionId = "77777777-1111-1111-1111-111111111111";
    const file = writeSessionTranscript(home, proj, sessionId, [
      assistantLine("a", "claude-sonnet-5", { input: 1 }, "2026-10-19T00:00:00Z"),
      assistantLine("b", "claude-sonnet-5", { input: 1 }, "2026-10-19T00:00:01Z"),
    ]);
    await scanTranscripts(roots, NOW);
    fs.writeFileSync(file, assistantLine("c", "claude-sonnet-5", { input: 1 }, "2026-10-19T00:00:02Z") + "\n");
    const r = await scanTranscripts(roots, NOW);
    const ids = r.files.find((f) => f.kind === "main")?.calls.map((c) => c.id);
    expect(ids).toEqual(["c"]);
  });

  it("evicts a file's memo entry once it is deleted", async () => {
    const { home, roots } = setup();
    const proj = projectDirName("/repo/g");
    const sessionId = "88888888-1111-1111-1111-111111111111";
    const file = writeSessionTranscript(home, proj, sessionId, [assistantLine("x", "claude-sonnet-5", { input: 1 }, "2026-10-19T00:00:00Z")]);
    const first = await scanTranscripts(roots, NOW);
    expect(first.files).toHaveLength(1);
    fs.unlinkSync(file);
    const second = await scanTranscripts(roots, NOW);
    expect(second.files).toHaveLength(0);
  });

  it("collects attachment records by type", async () => {
    const { home, roots } = setup();
    const proj = projectDirName("/repo/h");
    writeSessionTranscript(home, proj, "99999999-1111-1111-1111-111111111111", [attachmentLine("skill_listing", "2026-10-19T00:00:00Z"), attachmentLine("something_else", "2026-10-19T00:00:01Z")]);
    const r = await scanTranscripts(roots, NOW);
    const main = r.files.find((f) => f.kind === "main");
    expect(main?.attachments.map((a) => a.type).sort()).toEqual(["other", "skill_listing"]);
  });

  it("coalesces concurrent calls onto one actual scan", async () => {
    const { home, roots } = setup();
    const proj = projectDirName("/repo/i");
    writeSessionTranscript(home, proj, "aaaaaaaa-1111-1111-1111-111111111111", [assistantLine("z", "claude-sonnet-5", { input: 1 }, "2026-10-19T00:00:00Z")]);
    const before = tokenScanGenerationForTests();
    const [a, b] = await Promise.all([scanTranscripts(roots, NOW), scanTranscripts(roots, NOW)]);
    expect(tokenScanGenerationForTests()).toBe(before + 1);
    expect(a).toBe(b); // the very same resolved result object
  });

  it("reports a missing projects directory without error", async () => {
    const { roots } = setup();
    const r = await scanTranscripts(roots, NOW);
    expect(r.coverage.projectsDir).toBe("missing");
    expect(r.files).toEqual([]);
  });

  it("R5/R1: evicts the least-recently-used file once the injectable memo file-count cap is reached", async () => {
    const { home, roots } = setup();
    const proj = projectDirName("/repo/memo-files");
    for (const n of ["11111111-aaaa-aaaa-aaaa-000000000001", "22222222-aaaa-aaaa-aaaa-000000000002", "33333333-aaaa-aaaa-aaaa-000000000003"]) {
      writeSessionTranscript(home, proj, n, [assistantLine(`m-${n}`, "claude-sonnet-5", { input: 1 }, "2026-10-19T00:00:00Z")]);
    }
    const r = await scanTranscripts(roots, NOW, { memoMaxFiles: 2 });
    expect(r.files).toHaveLength(3); // this scan's own results are unaffected...
    expect(r.coverage.memoEvictions).toBeGreaterThan(0); // ...but the memo itself was kept within its cap

    // a second scan must still produce correct, complete results even though the memo could not hold everything
    const r2 = await scanTranscripts(roots, NOW, { memoMaxFiles: 2 });
    expect(r2.files).toHaveLength(3);
  });

  it("R5/R1: evicts once the injectable memo byte-budget cap is reached", async () => {
    const { home, roots } = setup();
    const proj = projectDirName("/repo/memo-bytes");
    writeSessionTranscript(home, proj, "44444444-aaaa-aaaa-aaaa-000000000004", [assistantLine("m1", "claude-sonnet-5", { input: 1 }, "2026-10-19T00:00:00Z")]);
    writeSessionTranscript(home, proj, "55555555-aaaa-aaaa-aaaa-000000000005", [assistantLine("m2", "claude-sonnet-5", { input: 1 }, "2026-10-19T00:00:01Z")]);
    // a byte budget smaller than even one file's single record forces eviction on every new file
    const r = await scanTranscripts(roots, NOW, { memoMaxApproxBytes: 1 });
    expect(r.coverage.memoEvictions).toBeGreaterThan(0);
  });

  it("S2: caps a single file's own retained records and counts the overflow, marking the scan incomplete", async () => {
    const { home, roots } = setup();
    const proj = projectDirName("/repo/overflow");
    const lines = Array.from({ length: 20 }, (_, i) => assistantLine(`of-${i}`, "claude-sonnet-5", { input: 1 }, `2026-10-19T00:00:${String(i).padStart(2, "0")}Z`));
    writeSessionTranscript(home, proj, "66666666-aaaa-aaaa-aaaa-000000000006", lines);
    const r = await scanTranscripts(roots, NOW, { maxRecordsPerFile: 5 });
    const main = r.files.find((f) => f.kind === "main");
    expect(main?.calls.length).toBe(5); // never more than the per-file cap
    expect(main?.recordsOverflowed).toBe(15);
    expect(r.coverage.recordsOverflowed).toBe(15);
    expect(r.coverage.complete).toBe(false);
  });

  it("R10 (reviewer probe P-R10): growth of a RESUMED file counts toward the memo byte budget, the same as a cold file of the same final size", async () => {
    const { home, roots } = setup();
    const proj = projectDirName("/repo/r10-resume");
    const sessionId = "77777777-bbbb-bbbb-bbbb-000000000007";
    const file = writeSessionTranscript(home, proj, sessionId, [assistantLine("r10-0", "claude-sonnet-5", { input: 1 }, "2026-10-19T00:00:00Z")]);
    const budget = 1000; // smaller than 11 records' worth, larger than 1 record's worth

    // cold: 1 record alone must not evict against this budget
    const cold = await scanTranscripts(roots, NOW, { memoMaxApproxBytes: budget });
    expect(cold.coverage.memoEvictions).toBe(0);

    // grow the SAME file (a resumed scan) to 11 records total
    const more = Array.from({ length: 10 }, (_, i) => assistantLine(`r10-${i + 1}`, "claude-sonnet-5", { input: 1 }, `2026-10-19T00:00:${String(i + 1).padStart(2, "0")}Z`));
    appendToTranscript(file, more);
    const warmResumed = await scanTranscripts(roots, NOW, { memoMaxApproxBytes: budget });
    expect(warmResumed.coverage.memoEvictions).toBeGreaterThan(0); // the resumed growth must be counted

    // cold control: a second, unrelated project scanned fresh with the same 11-record size, same budget
    resetTokenScanStateForTests();
    const { home: home2, roots: roots2 } = setup();
    const proj2 = projectDirName("/repo/r10-cold-control");
    const elevenLines = Array.from({ length: 11 }, (_, i) => assistantLine(`cold-${i}`, "claude-sonnet-5", { input: 1 }, `2026-10-19T00:00:${String(i).padStart(2, "0")}Z`));
    writeSessionTranscript(home2, proj2, "88888888-bbbb-bbbb-bbbb-000000000008", elevenLines);
    const coldControl = await scanTranscripts(roots2, NOW, { memoMaxApproxBytes: budget });
    expect(coldControl.coverage.memoEvictions).toBeGreaterThan(0); // the same outcome as the resumed case
  });

  it("R10: the running memo byte total never goes negative across growth, eviction and deletion", async () => {
    const { home, roots } = setup();
    const proj = projectDirName("/repo/r10-nonneg");
    for (let i = 0; i < 5; i++) {
      writeSessionTranscript(home, proj, `9999999${i}-cccc-cccc-cccc-00000000000${i}`, [assistantLine(`nn-${i}`, "claude-sonnet-5", { input: 1 }, "2026-10-19T00:00:00Z")]);
    }
    await scanTranscripts(roots, NOW, { memoMaxFiles: 2, memoMaxApproxBytes: 50 });
    expect(memoApproxBytesTotalForTests()).toBeGreaterThanOrEqual(0);

    // delete every file and rescan: the memo must evict everything without the running total going negative
    fs.rmSync(`${roots.projectsDir}/${proj}`, { recursive: true, force: true });
    await scanTranscripts(roots, NOW, { memoMaxFiles: 2, memoMaxApproxBytes: 50 });
    expect(memoApproxBytesTotalForTests()).toBeGreaterThanOrEqual(0);
  });

  it("R20/R21: a full rescan never carries over the previous oversizeLines count, and a warm poll still reports it (completeness stays consistent)", async () => {
    const { home, roots } = setup();
    const proj = projectDirName("/repo/r20-r21");
    const sessionId = "11112222-dddd-dddd-dddd-000000000001";
    // one real oversize line (over the fixed 64 MiB cap), terminated, followed by a normal line
    const oversizeLine = "z".repeat(64 * 1024 * 1024 + 10);
    const path1 = writeSessionTranscript(home, proj, sessionId, [oversizeLine, assistantLine("r20-a", "claude-sonnet-5", { input: 1 }, "2026-10-19T00:00:00Z")]);

    const first = await scanTranscripts(roots, NOW);
    expect(first.files[0]?.oversizeLines).toBe(1);
    expect(first.coverage.oversizeLines).toBe(1);
    expect(first.coverage.complete).toBe(false);

    // R21: a second, fully warm poll (nothing on disk changed) must still report it — not drop back to
    // complete:true just because nothing was re-streamed this time.
    const warm = await scanTranscripts(roots, NOW);
    expect(warm.coverage.filesFromMemo).toBeGreaterThan(0);
    expect(warm.coverage.oversizeLines).toBe(1);
    expect(warm.coverage.complete).toBe(false);

    // R20: shrink the file IN PLACE (same inode on this filesystem, forces a full rescan since the new
    // size is below the old resume offset) to one with no oversize line at all.
    fs.writeFileSync(path1, assistantLine("r20-b", "claude-sonnet-5", { input: 1 }, "2026-10-19T00:00:01Z") + "\n");
    const afterShrink = await scanTranscripts(roots, NOW);
    expect(afterShrink.files[0]?.oversizeLines).toBe(0); // never inherited from the stale entry
    expect(afterShrink.coverage.oversizeLines).toBe(0);
    expect(afterShrink.coverage.complete).toBe(true);
  }, 20_000);

  it("R11(b): an invalid timestamp on a line that retains nothing is never counted", async () => {
    const { home, roots } = setup();
    const proj = projectDirName("/repo/r11-b");
    const sessionId = "33334444-ffff-ffff-ffff-000000000003";
    // a user line with an unmatched tool_result (no pending read to resolve): nothing is retained from it
    const line = JSON.stringify({
      type: "user",
      timestamp: "NOT_A_VALID_TIMESTAMP",
      isMeta: false,
      message: { content: [{ type: "tool_result", tool_use_id: "unmatched-id", content: "x" }] },
    });
    writeSessionTranscript(home, proj, sessionId, [line]);
    const r = await scanTranscripts(roots, NOW);
    expect(r.coverage.invalidTimestamps).toBe(0); // the bad ts belonged to no retained record
    expect(r.coverage.complete).toBe(true);
  });

  it("R11(a): a call stored with an invalid timestamp is counted and marks the scan incomplete", async () => {
    const { home, roots } = setup();
    const proj = projectDirName("/repo/r11-a");
    const sessionId = "44445555-ffff-ffff-ffff-000000000004";
    writeSessionTranscript(home, proj, sessionId, [assistantLine("r11-bad-ts", "claude-sonnet-5", { input: 1 }, "NOT_A_VALID_TIMESTAMP")]);
    const r = await scanTranscripts(roots, NOW);
    expect(r.coverage.invalidTimestamps).toBe(1);
    expect(r.coverage.complete).toBe(false);
    expect(r.files[0]?.calls[0]?.ts).toBe(""); // never the raw, unvalidated value
  });
});
