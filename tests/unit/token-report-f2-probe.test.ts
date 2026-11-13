import { describe, expect, it } from "vitest";
import { rootsFromHome } from "@/server/brain/roots";
import { resetTokenScanStateForTests } from "@/server/tokens/scan";
import { tokenIntelligenceResponse } from "@/server/tokens/report";
import { freshHome } from "../helpers/fixture-store";
import { assistantLine, projectDirName, writeSessionTranscript, writeSubagentTranscript } from "../helpers/transcript-fixtures";

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const DAY = "2026-10-14";

// Regression test for F2 on BR-20261020-0002: report.ts:341 builds the baseline reconciliation scope as
// `file.kind === "subagent" || file.key === baselineSessionId`, which includes EVERY subagent file on
// disk (any session, any project), not only the baseline session's own `subagents/` files, violating A2.
describe("QA regression F2: baseline scope must be the main session file + its OWN subagents only (A2)", () => {
  it("excludes a subagent file that belongs to a different, unrelated session on the same day", async () => {
    resetTokenScanStateForTests();
    const home = freshHome();
    const roots = rootsFromHome(home);

    // Baseline session: 1 call on the baseline day.
    const baselineSessionId = "11111111-2222-3333-4444-555555555555";
    writeSessionTranscript(home, projectDirName("/repo/baseline-proj"), baselineSessionId, [
      assistantLine("baseline-main-1", "claude-sonnet-5", { input: 100, output: 10 }, `${DAY}T08:00:00Z`),
    ]);

    // An UNRELATED session's own subagent file, in a completely different project, same day. This
    // subagent was never launched by the baseline session, so A2 says it must NOT be counted in the
    // baseline scope.
    writeSubagentTranscript(
      home,
      projectDirName("/repo/unrelated-proj"),
      "unrelated-agent-1",
      [assistantLine("unrelated-sub-1", "claude-sonnet-5", { input: 999999, output: 999999 }, `${DAY}T08:05:00Z`)],
      "developer",
    );

    const r = await tokenIntelligenceResponse(roots, NOW, "30d", { baselineSessionId, baselineDay: DAY });

    expect(r.reconciliation.baseline.actual?.calls).toBe(1); // only the baseline session's own call
    expect(r.reconciliation.baseline.actual?.input).toBe(100);
  });
});
