import { describe, expect, it } from "vitest";
import { attributeMainCall, attributeSubagent, buildMissionIndex } from "@/server/tokens/attribute";
import { loadMissionLog } from "@/server/tokens/missions";
import { freshHome, replaceLine, rootsFor, writeScript } from "../helpers/fixture-store";

const SESSION_A = "aaaaaaaa-0000-0000-0000-000000000001";
const SESSION_B = "bbbbbbbb-0000-0000-0000-000000000002";

describe("attribution", () => {
  it("links a subagent file to its mission by agent_id", async () => {
    const home = freshHome();
    writeScript(home, "BR-20261014-0001", [
      { type: "TASK_CREATED", payload: { summary: "s", class: "STANDARD" }, session: SESSION_A, ts: "2026-10-14T08:00:00Z" },
      { type: "AGENT_STARTED", payload: { agent: "developer", agent_id: "agent-dev-1" }, session: SESSION_A, ts: "2026-10-14T08:01:00Z" },
    ]);
    const log = await loadMissionLog(rootsFor(home), "BR-20261014-0001");
    const idx = buildMissionIndex([log]);
    expect(attributeSubagent("agent-dev-1", idx)).toEqual({ reason: "agent-link", taskId: "BR-20261014-0001" });
    expect(attributeSubagent("agent-unknown", idx)).toEqual({ reason: "subagent-not-in-brain-state", taskId: null });
  });

  it("attributes a main-session call inside a single mission window", async () => {
    const home = freshHome();
    writeScript(home, "BR-20261014-0002", [
      { type: "TASK_CREATED", payload: { summary: "s", class: "STANDARD" }, session: SESSION_A, ts: "2026-10-14T08:00:00Z" },
      { type: "NOTE", payload: { text: "n" }, session: SESSION_A, ts: "2026-10-14T08:30:00Z" },
    ]);
    const log = await loadMissionLog(rootsFor(home), "BR-20261014-0002");
    const idx = buildMissionIndex([log]);
    expect(attributeMainCall(SESSION_A, "2026-10-14T08:15:00Z", idx)).toEqual({ reason: "mission-window", taskId: "BR-20261014-0002" });
    expect(attributeMainCall(SESSION_A, "2026-10-14T09:00:00Z", idx)).toEqual({ reason: "outside-mission-window", taskId: null });
    expect(attributeMainCall("unknown-session", "2026-10-14T08:15:00Z", idx)).toEqual({ reason: "session-not-in-brain-state", taskId: null });
  });

  it("flags an overlap when the same session's windows in two missions both contain the timestamp", async () => {
    const home = freshHome();
    writeScript(home, "BR-20261014-0003", [
      { type: "TASK_CREATED", payload: { summary: "s1", class: "STANDARD" }, session: SESSION_A, ts: "2026-10-14T08:00:00Z" },
      { type: "NOTE", payload: { text: "n" }, session: SESSION_A, ts: "2026-10-14T08:50:00Z" },
    ]);
    writeScript(home, "BR-20261014-0004", [
      { type: "TASK_CREATED", payload: { summary: "s2", class: "STANDARD" }, session: SESSION_A, ts: "2026-10-14T08:10:00Z" },
      { type: "NOTE", payload: { text: "n" }, session: SESSION_A, ts: "2026-10-14T08:40:00Z" },
    ]);
    const roots = rootsFor(home);
    const log1 = await loadMissionLog(roots, "BR-20261014-0003");
    const log2 = await loadMissionLog(roots, "BR-20261014-0004");
    const idx = buildMissionIndex([log1, log2]);
    expect(attributeMainCall(SESSION_A, "2026-10-14T08:20:00Z", idx)).toEqual({ reason: "overlapping-missions", taskId: null });
  });

  it("treats TASK_RESUMED by another session as a separate window for that session, not a merge", async () => {
    const home = freshHome();
    writeScript(home, "BR-20261014-0005", [
      { type: "TASK_CREATED", payload: { summary: "s", class: "STANDARD" }, session: SESSION_A, ts: "2026-10-14T08:00:00Z" },
      { type: "NOTE", payload: { text: "n" }, session: SESSION_A, ts: "2026-10-14T08:10:00Z" },
      { type: "TASK_RESUMED", payload: {}, session: SESSION_B, ts: "2026-10-14T09:00:00Z" },
      { type: "NOTE", payload: { text: "n" }, session: SESSION_B, ts: "2026-10-14T09:10:00Z" },
    ]);
    const log = await loadMissionLog(rootsFor(home), "BR-20261014-0005");
    const idx = buildMissionIndex([log]);
    expect(attributeMainCall(SESSION_A, "2026-10-14T08:05:00Z", idx)).toEqual({ reason: "mission-window", taskId: "BR-20261014-0005" });
    expect(attributeMainCall(SESSION_B, "2026-10-14T09:05:00Z", idx)).toEqual({ reason: "mission-window", taskId: "BR-20261014-0005" });
    // session A has no window covering 09:05 (its own window ended at 08:10)
    expect(attributeMainCall(SESSION_A, "2026-10-14T09:05:00Z", idx)).toEqual({ reason: "outside-mission-window", taskId: null });
  });

  it("flags an ambiguous agent_id reused across two missions", async () => {
    const home = freshHome();
    writeScript(home, "BR-20261014-0006", [
      { type: "TASK_CREATED", payload: { summary: "s1", class: "STANDARD" }, session: SESSION_A, ts: "2026-10-14T08:00:00Z" },
      { type: "AGENT_STARTED", payload: { agent: "developer", agent_id: "agent-shared" }, session: SESSION_A, ts: "2026-10-14T08:01:00Z" },
    ]);
    writeScript(home, "BR-20261014-0007", [
      { type: "TASK_CREATED", payload: { summary: "s2", class: "STANDARD" }, session: SESSION_B, ts: "2026-10-14T08:00:00Z" },
      { type: "AGENT_STARTED", payload: { agent: "developer", agent_id: "agent-shared" }, session: SESSION_B, ts: "2026-10-14T08:01:00Z" },
    ]);
    const roots = rootsFor(home);
    const log1 = await loadMissionLog(roots, "BR-20261014-0006");
    const log2 = await loadMissionLog(roots, "BR-20261014-0007");
    const idx = buildMissionIndex([log1, log2]);
    expect(attributeSubagent("agent-shared", idx)).toEqual({ reason: "ambiguous-agent-id", taskId: null });
  });

  it("stops at a corrupt line and still uses the valid prefix before it", async () => {
    const home = freshHome();
    const written = writeScript(home, "BR-20261014-0008", [
      { type: "TASK_CREATED", payload: { summary: "s", class: "STANDARD" }, session: SESSION_A, ts: "2026-10-14T08:00:00Z" },
      { type: "AGENT_STARTED", payload: { agent: "developer", agent_id: "agent-dev-1" }, session: SESSION_A, ts: "2026-10-14T08:01:00Z" },
      { type: "NOTE", payload: { text: "n" }, session: SESSION_A, ts: "2026-10-14T08:02:00Z" },
    ]);
    replaceLine(written.eventsPath, 3, "{bad json");
    const log = await loadMissionLog(rootsFor(home), "BR-20261014-0008");
    expect(log.integrity).toBe("corrupt");
    expect(log.usable).toBe(true);
    expect(log.events).toHaveLength(2);
    const idx = buildMissionIndex([log]);
    expect(attributeSubagent("agent-dev-1", idx)).toEqual({ reason: "agent-link", taskId: "BR-20261014-0008" });
  });

  it("reports a missing log as unusable with no events", async () => {
    const log = await loadMissionLog(rootsFor("/nonexistent"), "BR-20261014-0009");
    expect(log.usable).toBe(false);
    expect(log.events).toEqual([]);
  });
});
