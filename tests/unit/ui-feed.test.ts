import { describe, expect, it } from "vitest";
import { feedKind, feedLines, FEED_LIMIT } from "@/lib/ui/feed";
import { freshHome, highRiskScript, mkdirs, standardScript, writeGovernor, writeScript } from "../helpers/fixture-store";
import { apiDetail, apiEvents } from "../helpers/ui-fixtures";

const ID = "BR-20261007-0001";

async function complete() {
  const home = freshHome();
  mkdirs(home);
  writeGovernor(home);
  writeScript(home, ID, highRiskScript(home, { complete: true }));
  return { detail: await apiDetail(ID), events: await apiEvents(ID) };
}

describe("feedLines", () => {
  it("shows the newest lines in recorded order and never adds one", async () => {
    const { detail, events } = await complete();
    expect(events.events).toHaveLength(41);
    const feed = feedLines(events, detail);
    expect(feed.lines).toHaveLength(FEED_LIMIT);
    expect(feed.lines.map((l) => l.seq)).toEqual(events.events.slice(-FEED_LIMIT).map((e) => e.seq));
    for (const l of feed.lines) expect(events.events).toContain(l.item); // the API item itself, not a copy or a new line
    expect(new Set(feed.lines.map((l) => l.key)).size).toBe(feed.lines.length);
    expect(feed.lines[feed.lines.length - 1]).toMatchObject({ seq: 41, text: "Task COMPLETE", kind: "step", tone: "success" });
    expect(feed.available).toBe(41);
    expect(feedLines(null, null).lines).toEqual([]);
  });
  it("attaches tests and files to the completion line of the same agent and round", async () => {
    const { detail, events } = await complete();
    const feed = feedLines(events, detail, { limit: 100 });
    const at = (seq: number) => feed.lines.find((l) => l.seq === seq);
    expect(at(11)).toMatchObject({ role: "developer", kind: "agent", text: "Developer completed: done" });
    expect(at(11)?.reported.map((r) => r.text)).toEqual(["pnpm test → pass 12", "2 file(s): src/a.ts, src/b.ts"]);
    expect(at(26)?.reported.map((r) => r.text)).toEqual(["pnpm test → pass 13", "1 file(s): src/server/http.ts"]);
    expect(feed.lines.filter((l) => l.reported.length > 0).map((l) => l.seq)).toEqual([11, 26]);
    expect(feed.reportedOutsideWindow).toBe(0);
  });
  it("counts reports whose completion line is not shown instead of placing them elsewhere", async () => {
    const { detail, events } = await complete();
    const feed = feedLines(events, detail); // the last 12 lines: seq 30 … 41
    expect(feed.lines.some((l) => l.reported.length > 0)).toBe(false);
    expect(feed.reportedOutsideWindow).toBe(4); // 2 test groups + 2 file groups
  });
  it("cuts at uptoSeq for a replay step", async () => {
    const { detail, events } = await complete();
    const feed = feedLines(events, detail, { uptoSeq: 11 });
    expect(feed.lines.map((l) => l.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(feed.lines[10]?.reported).toHaveLength(2);
    expect(feed.available).toBe(11);
  });
  it("attaches nothing when the detail belongs to another mission", async () => {
    const { detail, events } = await complete();
    const feed = feedLines(events, { ...detail, id: "BR-20261007-0009" }, { limit: 100 });
    expect(feed.lines.every((l) => l.reported.length === 0)).toBe(true);
    expect(feed.reportedOutsideWindow).toBe(0);
  });
  it("ties no report to a line when the agent completed more than once in that round (a rerun)", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    const specs = standardScript(home);
    specs.push(
      { type: "VALIDATION_STARTED", payload: { agents: ["qa"] }, state: "VALIDATING" }, // 5
      { type: "AGENT_STARTED", payload: { agent: "qa", kind: "initial" } }, // 6
      { type: "AGENT_COMPLETED", payload: { agent: "qa", status_or_verdict: "pass", tests_run: [{ cmd: "first", result: "pass 1" }] }, correlation_id: "SEQ6" }, // 7
      { type: "AGENT_STARTED", payload: { agent: "qa", kind: "initial", rerun_reason: "again" } }, // 8
      { type: "AGENT_COMPLETED", payload: { agent: "qa", status_or_verdict: "pass" }, correlation_id: "SEQ8" }, // 9
    );
    writeScript(home, ID, specs);
    const feed = feedLines(await apiEvents(ID), await apiDetail(ID), { limit: 100 });
    expect(feed.lines.filter((l) => l.role === "qa").every((l) => l.reported.length === 0)).toBe(true);
    expect(feed.reportedAmbiguous).toBe(1);
    expect(feed.reportedOutsideWindow).toBe(0);
    expect(feed.lines.find((l) => l.seq === 4)?.reported.map((r) => r.text)).toEqual(["1 file(s): x.ts"]); // the developer's single completion still attaches
    // the other completion may be older than the loaded window: ambiguity comes from the runs, not the lines
    const window = feedLines(await apiEvents(ID, 2), await apiDetail(ID), { limit: 100 }); // seq 8–9 only
    expect(window.lines.map((l) => l.seq)).toEqual([8, 9]);
    expect(window.lines.every((l) => l.reported.length === 0)).toBe(true);
    expect(window.reportedAmbiguous).toBe(1);
  });
  it("maps event types to glyph kinds", () => {
    expect(feedKind("AGENT_STARTED")).toBe("agent");
    expect(feedKind("FINDING_UPDATED")).toBe("finding");
    expect(feedKind("APPROVAL_REQUESTED")).toBe("gate");
    expect(feedKind("PLAN_APPROVED")).toBe("gate");
    expect(feedKind("VALIDATION_COMPLETED")).toBe("validation");
    expect(feedKind("FIX_ROUND_STARTED")).toBe("fix");
    expect(feedKind("SNAPSHOT_TAKEN")).toBe("snapshot");
    expect(feedKind("NOTE")).toBe("note");
    expect(feedKind("READY_REACHED")).toBe("step");
  });
});
