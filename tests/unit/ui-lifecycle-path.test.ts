import { describe, expect, it } from "vitest";
import type { TaskDetail } from "@/lib/api-types";
import { buildLifecycle, stateLabel, TIMELINE } from "@/lib/lifecycle";
import { lifecyclePath, lifecycleSummary, SHORT_LABELS } from "@/lib/ui/lifecycle-path";
import { freshHome, highRiskScript, mkdirs, standardScript, writeGovernor, writeScript } from "../helpers/fixture-store";
import { apiDetail } from "../helpers/ui-fixtures";

describe("lifecyclePath", () => {
  it("has exactly the 17 timeline states in order, passing statuses through from the API", async () => {
    const home = freshHome();
    mkdirs(home);
    writeScript(home, "BR-20261007-0001", highRiskScript(home, { stopAfter: 24 })); // FIXING
    const d = await apiDetail("BR-20261007-0001");
    const p = lifecyclePath(d.lifecycle);
    expect(p.waypoints.map((w) => w.state)).toEqual([...TIMELINE]);
    expect(p.waypoints.map((w) => w.status)).toEqual(d.lifecycle.steps.map((s) => s.status));
    expect(p.waypoints.map((w) => w.label)).toEqual(d.lifecycle.steps.map((s) => s.label));
    expect(p.currentIndex).toBe(TIMELINE.indexOf("FIXING"));
    expect(p.waypoints[0]?.implied).toBe(true);
    expect(p.waypoints.find((w) => w.state === "TESTING")?.enteredAt).toBeTruthy();
    expect(p.exit).toBeNull();
    expect(p.current).toBe("FIXING");
    expect(p.transitions).toBe(d.lifecycle.transitions.length);
    for (const w of p.waypoints) expect(SHORT_LABELS[w.state].length).toBeGreaterThan(0);
  });
  it("carries the exit branch for a BLOCKED mission and has no current step", async () => {
    const home = freshHome();
    mkdirs(home);
    writeScript(home, "BR-20261007-0002", standardScript(home, { blocked: true }));
    const d = await apiDetail("BR-20261007-0002");
    const p = lifecyclePath(d.lifecycle);
    expect(p.exit?.state).toBe("BLOCKED");
    expect(p.currentIndex).toBeNull();
    expect(p.waypoints.find((w) => w.state === "PLANNING")?.status).toBe("skipped");
    expect(p.waypoints.find((w) => w.state === "IMPLEMENTING")?.status).toBe("completed");
  });
});

const ID = "BR-20261007-0001";

async function highRisk(opts: Parameters<typeof highRiskScript>[1] = {}): Promise<TaskDetail> {
  const home = freshHome();
  mkdirs(home);
  writeGovernor(home);
  writeScript(home, ID, highRiskScript(home, opts));
  return apiDetail(ID);
}

async function standard(opts: Parameters<typeof standardScript>[1] = {}): Promise<TaskDetail> {
  const home = freshHome();
  mkdirs(home);
  writeGovernor(home);
  writeScript(home, ID, standardScript(home, opts));
  return apiDetail(ID);
}

function tr(states: string[]) {
  return states.map((state, i) => ({ state, seq: i + 1, ts: new Date(Date.UTC(2026, 9, 7, 8, 0, i)).toISOString() }));
}

describe("lifecycleSummary", () => {
  it("FIXING: counts equal the counts of lifecycle.steps[].status", async () => {
    const d = await highRisk({ stopAfter: 24 });
    expect(d.lifecycle.current).toBe("FIXING");
    const model = lifecyclePath(d.lifecycle);
    const summary = lifecycleSummary(model);
    const byStatus = (s: string) => d.lifecycle.steps.filter((step) => step.status === s).length;
    expect(summary.completed).toBe(byStatus("completed"));
    expect(summary.skipped).toBe(byStatus("skipped"));
    expect(summary.pending).toBe(byStatus("pending"));
    expect(summary.currentCount).toBe(byStatus("current"));
    expect(summary.total).toBe(17);
    expect(summary.currentLabel).toBe(stateLabel("FIXING"));
  });

  it("BLOCKED: PLANNING is skipped (not completed), nextOnTimeline is null, the exit is set", async () => {
    const d = await standard({ blocked: true });
    const model = lifecyclePath(d.lifecycle);
    const summary = lifecycleSummary(model);
    const planning = model.waypoints.find((w) => w.state === "PLANNING");
    expect(planning?.status).toBe("skipped");
    expect(summary.completed).not.toBe(summary.total);
    expect(summary.currentCount).toBe(0);
    expect(summary.nextOnTimeline).toBeNull();
    expect(summary.exit?.state).toBe("BLOCKED");
  });

  it("VALIDATING: two current steps, nextOnTimeline after REVIEWING is SYNTHESIZING", async () => {
    const d = await highRisk({ stopAfter: 13 });
    expect(d.lifecycle.current).toBe("VALIDATING");
    const model = lifecyclePath(d.lifecycle);
    const summary = lifecycleSummary(model);
    expect(summary.currentCount).toBe(2);
    expect(summary.current.map((w) => w.state)).toEqual(["TESTING", "REVIEWING"]);
    expect(summary.nextOnTimeline?.state).toBe("SYNTHESIZING");
  });

  it("FIXING: nextOnTimeline is the very next timeline step, REVALIDATING", async () => {
    const d = await highRisk({ stopAfter: 24 });
    const model = lifecyclePath(d.lifecycle);
    const summary = lifecycleSummary(model);
    expect(summary.nextOnTimeline?.state).toBe("REVALIDATING");
  });

  it("a revisit (round-2 FIXING after REVALIDATING already completed) still points next at REVALIDATING, not a later pending step", () => {
    // RECEIVED..REVALIDATING all visited once, then back to FIXING for a second round: REVALIDATING is
    // "completed" from round 1, not "pending", but it is still the very next step on the timeline.
    const v = buildLifecycle({
      currentState: "FIXING",
      status: "ACTIVE",
      hasTaskCreated: true,
      transitions: tr(["CLASSIFYING", "IMPLEMENTING", "VALIDATING", "SYNTHESIZING", "FIXING", "REVALIDATING", "SYNTHESIZING", "FIXING"]),
    });
    const model = lifecyclePath(v);
    const revalidating = model.waypoints.find((w) => w.state === "REVALIDATING");
    expect(revalidating?.status).toBe("completed");
    const summary = lifecycleSummary(model);
    expect(summary.nextOnTimeline?.state).toBe("REVALIDATING");
  });

  it("Complete: no current step, COMPLETE is counted completed", async () => {
    const d = await highRisk({ complete: true });
    const model = lifecyclePath(d.lifecycle);
    const summary = lifecycleSummary(model);
    expect(summary.currentCount).toBe(0);
    expect(summary.current).toHaveLength(0);
    const complete = model.waypoints.find((w) => w.state === "COMPLETE");
    expect(complete?.status).toBe("completed");
    expect(summary.completed + summary.skipped).toBe(summary.total);
    expect(summary.nextOnTimeline).toBeNull();
  });

  it("handles a null lifecycle (no mission)", () => {
    const model = lifecyclePath({ steps: [], current: null, exit: null, transitions: [] });
    const summary = lifecycleSummary(model);
    expect(summary.total).toBe(17);
    expect(summary.completed).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.pending).toBe(17);
    expect(summary.currentCount).toBe(0);
    expect(summary.current).toHaveLength(0);
    expect(summary.currentLabel).toBeNull();
    expect(summary.nextOnTimeline).toBeNull();
    expect(summary.exit).toBeNull();
  });
});
