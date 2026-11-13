import { describe, expect, it } from "vitest";
import { rootsFromHome } from "@/server/brain/roots";
import { resetTokenScanStateForTests } from "@/server/tokens/scan";
import { tokenIntelligenceResponse } from "@/server/tokens/report";
import { freshHome, writeScript } from "../helpers/fixture-store";
import { assistantLine, projectDirName, writeSessionTranscript } from "../helpers/transcript-fixtures";

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const DAY = "2026-10-14";

// Regression test for a QA finding on BR-20261020-0002: report.ts imports attributeMainCall from
// attribute.ts but never calls it, so a main-session call that falls inside a known mission window is
// never attributed to that mission — it always lands in `unattributed` with reason
// "session-not-in-brain-state", even though attribute.ts's own unit tests prove the algorithm works.
describe("QA regression: main-session calls inside a known mission window (report.ts integration)", () => {
  it("attributes a main-session call to its mission window instead of session-not-in-brain-state", async () => {
    resetTokenScanStateForTests();
    const home = freshHome();
    const roots = rootsFromHome(home);
    const proj = projectDirName("/repo/probe-mainwindow");
    const sessionId = "aaaaaaaa-1111-1111-1111-111111111111";

    writeSessionTranscript(home, proj, sessionId, [assistantLine("main-1", "claude-sonnet-5", { input: 10, output: 5 }, `${DAY}T08:15:00Z`)]);

    writeScript(home, "BR-20261014-0100", [
      { type: "TASK_CREATED", payload: { summary: "s", class: "STANDARD" }, session: sessionId, ts: `${DAY}T08:00:00Z` },
      { type: "NOTE", payload: { text: "n" }, session: sessionId, ts: `${DAY}T08:30:00Z` },
    ]);

    const r = await tokenIntelligenceResponse(roots, NOW, "30d");

    // Expectation per the plan's attribution algorithm (step 3, main-session calls): a call inside
    // exactly one mission's session window should be attributed to that mission ("mission-window"),
    // and appear in byMission, not in `unattributed`.
    const mission = r.byMission.find((m) => m.taskId === "BR-20261014-0100");
    expect(mission?.calls).toBe(1);
    const unattributedReasons = r.unattributed.map((u) => u.reason);
    expect(unattributedReasons).not.toContain("session-not-in-brain-state");
  });
});
