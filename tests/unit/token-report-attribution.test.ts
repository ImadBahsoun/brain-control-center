import { describe, expect, it } from "vitest";
import { rootsFromHome } from "@/server/brain/roots";
import { resetTokenScanStateForTests } from "@/server/tokens/scan";
import { tokenIntelligenceResponse } from "@/server/tokens/report";
import { freshHome, writeScript } from "../helpers/fixture-store";
import { assistantLine, projectDirName, writeSessionTranscript } from "../helpers/transcript-fixtures";

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const DAY = "2026-10-14";

/**
 * Report-level coverage of R2 (attributeMainCall must run per call, not be skipped for main-session
 * files): every outcome of attribute.ts's attributeMainCall, exercised through the full
 * tokenIntelligenceResponse aggregation, not just the lower-level unit (tests/unit/token-attribution.test.ts).
 */
describe("report-level main-session attribution (R2)", () => {
  it("attributes a call inside a single mission window to that mission", async () => {
    resetTokenScanStateForTests();
    const home = freshHome();
    const roots = rootsFromHome(home);
    const proj = projectDirName("/repo/r2-window");
    const session = "aaaaaaaa-2222-2222-2222-222222222222";
    writeSessionTranscript(home, proj, session, [assistantLine("c1", "claude-sonnet-5", { input: 1 }, `${DAY}T08:15:00Z`)]);
    writeScript(home, "BR-20261014-1001", [
      { type: "TASK_CREATED", payload: { summary: "s", class: "STANDARD" }, session, ts: `${DAY}T08:00:00Z` },
      { type: "NOTE", payload: { text: "n" }, session, ts: `${DAY}T08:30:00Z` },
    ]);
    const r = await tokenIntelligenceResponse(roots, NOW, "30d");
    const mission = r.byMission.find((m) => m.taskId === "BR-20261014-1001");
    expect(mission?.calls).toBe(1);
    expect(mission?.attributedBy.window).toBe(1);
    expect(r.unattributed.map((u) => u.reason)).not.toContain("session-not-in-brain-state");
  });

  it("attributes a call inside two overlapping mission windows as overlapping-missions", async () => {
    resetTokenScanStateForTests();
    const home = freshHome();
    const roots = rootsFromHome(home);
    const proj = projectDirName("/repo/r2-overlap");
    const session = "bbbbbbbb-2222-2222-2222-222222222222";
    writeSessionTranscript(home, proj, session, [assistantLine("c1", "claude-sonnet-5", { input: 1 }, `${DAY}T08:20:00Z`)]);
    writeScript(home, "BR-20261014-1002", [
      { type: "TASK_CREATED", payload: { summary: "s1", class: "STANDARD" }, session, ts: `${DAY}T08:00:00Z` },
      { type: "NOTE", payload: { text: "n" }, session, ts: `${DAY}T08:50:00Z` },
    ]);
    writeScript(home, "BR-20261014-1003", [
      { type: "TASK_CREATED", payload: { summary: "s2", class: "STANDARD" }, session, ts: `${DAY}T08:10:00Z` },
      { type: "NOTE", payload: { text: "n" }, session, ts: `${DAY}T08:40:00Z` },
    ]);
    const r = await tokenIntelligenceResponse(roots, NOW, "30d");
    expect(r.byMission.find((m) => m.taskId === "BR-20261014-1002")).toBeUndefined();
    expect(r.byMission.find((m) => m.taskId === "BR-20261014-1003")).toBeUndefined();
    const row = r.unattributed.find((u) => u.reason === "overlapping-missions");
    expect(row?.calls).toBe(1);
  });

  it("attributes a call outside every mission window as outside-mission-window", async () => {
    resetTokenScanStateForTests();
    const home = freshHome();
    const roots = rootsFromHome(home);
    const proj = projectDirName("/repo/r2-outside");
    const session = "cccccccc-2222-2222-2222-222222222222";
    writeSessionTranscript(home, proj, session, [assistantLine("c1", "claude-sonnet-5", { input: 1 }, `${DAY}T09:00:00Z`)]);
    writeScript(home, "BR-20261014-1004", [
      { type: "TASK_CREATED", payload: { summary: "s", class: "STANDARD" }, session, ts: `${DAY}T08:00:00Z` },
      { type: "NOTE", payload: { text: "n" }, session, ts: `${DAY}T08:10:00Z` },
    ]);
    const r = await tokenIntelligenceResponse(roots, NOW, "30d");
    const row = r.unattributed.find((u) => u.reason === "outside-mission-window");
    expect(row?.calls).toBe(1);
  });

  it("labels a call from a session brain-state never recorded as session-not-in-brain-state", async () => {
    resetTokenScanStateForTests();
    const home = freshHome();
    const roots = rootsFromHome(home);
    const proj = projectDirName("/repo/r2-unknown");
    const session = "dddddddd-2222-2222-2222-222222222222";
    writeSessionTranscript(home, proj, session, [assistantLine("c1", "claude-sonnet-5", { input: 1 }, `${DAY}T08:15:00Z`)]);
    const r = await tokenIntelligenceResponse(roots, NOW, "30d");
    const row = r.unattributed.find((u) => u.reason === "session-not-in-brain-state");
    expect(row?.calls).toBe(1);
  });
});
