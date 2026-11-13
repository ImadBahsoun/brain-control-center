import { describe, expect, it } from "vitest";
import { buildCommandMap, type CommandMapModel } from "@/lib/ui/command-map";
import { describeEffect, diffSnapshots, snapshotOf, type Snapshot } from "@/lib/ui/live-diff";
import { freshHome, highRiskScript, mkdirs, standardScript, writeGovernor, writeScript } from "../helpers/fixture-store";
import { mapInput } from "../helpers/ui-fixtures";

// highRiskScript seq numbers used below: 9 snapshot, 10/11 developer start/complete, 13 validation start,
// 16 third validator start, 19/20 last validator complete / first finding (SYNTHESIZING), 25/26 fix
// developer start/complete, 27 F-001 FIXED, 32/33 reviewer revalidation complete / F-001 REVALIDATED
// (SYNTHESIZING), 34 F-001 CLOSED, 35 F-002 DEFERRED, 36/37 PASS / READY, 39/40 HUMAN_APPROVAL.

const ID = "BR-20261007-0001";

async function at(stopAfter: number | "complete", id = ID): Promise<CommandMapModel> {
  const home = freshHome();
  mkdirs(home);
  writeGovernor(home);
  writeScript(home, id, highRiskScript(home, stopAfter === "complete" ? { complete: true } : { stopAfter }));
  return buildCommandMap(await mapInput(id));
}

function snap(m: CommandMapModel): Snapshot {
  const s = snapshotOf(m);
  if (!s) throw new Error("no snapshot");
  return s;
}

describe("snapshotOf", () => {
  it("is null until the detail and the findings have both arrived, so a staged first load diffs nothing", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    writeScript(home, ID, highRiskScript(home, { stopAfter: 22 })); // two findings exist
    const input = await mapInput(ID);
    const detailOnly = buildCommandMap({ ...input, findings: null }); // the detail poll answered first
    expect(detailOnly.findingsLoaded).toBe(false);
    expect(detailOnly.threats).toEqual([]);
    expect(snapshotOf(detailOnly)).toBeNull();
    const both = buildCommandMap(input); // the findings poll answered next
    expect(both.findingsLoaded).toBe(true);
    expect(diffSnapshots(snapshotOf(detailOnly), snapshotOf(both))).toEqual([]);
    expect(snapshotOf(both)?.openFindingIds).toEqual(["F-001", "F-002"]);
    const findingsOnly = buildCommandMap({ ...input, detail: null, focusId: ID });
    expect(findingsOnly.mode).toBe("loading");
    expect(snapshotOf(findingsOnly)).toBeNull();
  });
});

describe("diffSnapshots", () => {
  it("yields nothing on first load, for an identical refetch, across a mission switch and back, or for reordered arrays", async () => {
    const a = await at(16);
    const s = snap(a);
    expect(diffSnapshots(null, s)).toEqual([]);
    expect(diffSnapshots(s, null)).toEqual([]);
    expect(diffSnapshots(s, snap(await at(16)))).toEqual([]);
    // A → X → A: the other mission diffs nothing, and coming back diffs nothing either
    const x = snap(await at(22, "BR-20261007-0002"));
    expect(diffSnapshots(s, x)).toEqual([]);
    expect(diffSnapshots(x, snap(await at(22)))).toEqual([]);
    const reordered = await at(16);
    reordered.detail!.agents.reverse();
    reordered.findings.reverse();
    expect(snap(reordered)).toEqual(s);
    expect(diffSnapshots(s, snap(reordered))).toEqual([]);
  });
  it("agent-start when a reservation appears, agent-complete with the verdict and status when it reports", async () => {
    expect(diffSnapshots(snap(await at(9)), snap(await at(10)))).toEqual([{ kind: "agent-start", target: "developer" }]);
    expect(diffSnapshots(snap(await at(10)), snap(await at(11)))).toEqual([{ kind: "agent-complete", target: "developer", verdict: "done", status: "completed" }]);
    const three = diffSnapshots(snap(await at(13)), snap(await at(16)));
    expect(three.map((e) => e.target).sort()).toEqual(["qa", "reviewer", "security-reviewer"]);
    expect(three.every((e) => e.kind === "agent-start")).toBe(true);
  });
  it("a lost or not-launched completion carries its status so the map does not pulse green", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    writeScript(home, ID, standardScript(home, { pendingDeveloper: true }));
    const before = snap(buildCommandMap(await mapInput(ID)));
    const other = freshHome();
    mkdirs(other);
    writeGovernor(other);
    const specs = standardScript(other, { pendingDeveloper: true });
    specs.push({ type: "AGENT_COMPLETED", payload: { agent: "developer", status_or_verdict: "lost" }, correlation_id: "SEQ3" });
    writeScript(other, ID, specs);
    const after = snap(buildCommandMap(await mapInput(ID)));
    const effects = diffSnapshots(before, after);
    expect(effects).toEqual([{ kind: "agent-complete", target: "developer", verdict: "lost", status: "lost" }]);
    expect(describeEffect(effects[0]!)).toBe("developer run lost (units consumed)");
    expect(describeEffect({ kind: "agent-complete", target: "qa", verdict: "not-launched", status: "not-launched" })).toBe("qa not launched (units refunded)");
  });
  it("finding-new carries the severity; finding-resolved fires when a finding leaves the open set", async () => {
    const created = diffSnapshots(snap(await at(19)), snap(await at(20)));
    expect(created).toEqual([
      { kind: "finding-new", target: "F-001", severity: "MAJOR" },
      { kind: "step", target: "SYNTHESIZING", from: "VALIDATING" },
    ]);
    expect(diffSnapshots(snap(await at(25)), snap(await at(26)))).toEqual([{ kind: "agent-complete", target: "developer", verdict: "done", status: "completed" }]);
    expect(diffSnapshots(snap(await at(26)), snap(await at(27)))).toEqual([]); // FIXED keeps the finding open
    expect(diffSnapshots(snap(await at(32)), snap(await at(33)))).toEqual([{ kind: "step", target: "SYNTHESIZING", from: "REVALIDATING" }]); // REVALIDATED keeps it open too
    expect(diffSnapshots(snap(await at(33)), snap(await at(34)))).toEqual([{ kind: "finding-resolved", target: "F-001" }]);
    expect(diffSnapshots(snap(await at(34)), snap(await at(35)))).toEqual([{ kind: "finding-resolved", target: "F-002" }]);
  });
  it("step, ready, gate-raised and mission-complete each fire on exactly their change", async () => {
    expect(diffSnapshots(snap(await at(36)), snap(await at(37)))).toEqual([
      { kind: "step", target: "READY", from: "SYNTHESIZING" },
      { kind: "ready", target: "ready" },
    ]);
    expect(diffSnapshots(snap(await at(39)), snap(await at(40)))).toEqual([
      { kind: "step", target: "HUMAN_APPROVAL", from: "READY" },
      { kind: "gate-raised", target: "gate" },
    ]);
    expect(diffSnapshots(snap(await at(40)), snap(await at("complete")))).toEqual([
      { kind: "step", target: "COMPLETE", from: "HUMAN_APPROVAL" },
      { kind: "mission-complete", target: "ready" },
    ]);
    expect(diffSnapshots(snap(await at(5)), snap(await at(6)))).toEqual([
      { kind: "step", target: "WAITING_FOR_APPROVAL", from: "PLANNING" },
      { kind: "gate-raised", target: "gate" },
    ]);
  });
  it("blocked fires once when the mission becomes blocked", async () => {
    const home = freshHome();
    mkdirs(home);
    writeScript(home, ID, standardScript(home));
    const before = snap(buildCommandMap(await mapInput(ID)));
    const other = freshHome();
    mkdirs(other);
    writeScript(other, ID, standardScript(other, { blocked: true }));
    const after = snap(buildCommandMap(await mapInput(ID)));
    expect(diffSnapshots(before, after)).toEqual([
      { kind: "step", target: "BLOCKED", from: "IMPLEMENTING" },
      { kind: "blocked", target: "core" },
    ]);
    expect(diffSnapshots(after, after)).toEqual([]);
  });
  it("snapshotOf is null on the idle map and describeEffect names every kind", async () => {
    const home = freshHome();
    mkdirs(home);
    writeScript(home, ID, highRiskScript(home, { complete: true }));
    expect(snapshotOf(buildCommandMap(await mapInput(null)))).toBeNull();
    expect(describeEffect({ kind: "agent-start", target: "qa" })).toBe("qa reserved and started");
    expect(describeEffect({ kind: "agent-complete", target: "qa", verdict: "pass", status: "completed" })).toBe("qa reported: pass");
    expect(describeEffect({ kind: "finding-new", target: "F-9", severity: "NIT" })).toBe("new NIT finding F-9");
    expect(describeEffect({ kind: "finding-resolved", target: "F-9" })).toBe("finding F-9 resolved");
    expect(describeEffect({ kind: "step", target: "READY", from: null })).toBe("lifecycle moved to READY");
    expect(describeEffect({ kind: "gate-raised", target: "gate" })).toBe("commander approval required");
    expect(describeEffect({ kind: "blocked", target: "core" })).toBe("mission blocked");
    expect(describeEffect({ kind: "ready", target: "ready" })).toBe("mission READY");
    expect(describeEffect({ kind: "mission-complete", target: "ready" })).toBe("mission complete");
  });
});
