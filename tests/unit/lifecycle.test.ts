import { describe, expect, it } from "vitest";
import type { LifecycleTransition } from "@/lib/api-types";
import { buildLifecycle, mapState, TIMELINE } from "@/lib/lifecycle";

function tr(states: string[]): LifecycleTransition[] {
  return states.map((state, i) => ({ state, seq: i + 1, ts: new Date(Date.UTC(2026, 9, 7, 8, 0, i)).toISOString() }));
}

function statusOf(view: ReturnType<typeof buildLifecycle>, state: string) {
  return view.steps.find((s) => s.state === state)?.status;
}

describe("lifecycle timeline", () => {
  it("has 17 steps and maps VALIDATING to TESTING plus REVIEWING", () => {
    expect(TIMELINE).toHaveLength(17);
    expect(mapState("VALIDATING")).toEqual(["TESTING", "REVIEWING"]);
    expect(mapState("BLOCKED")).toEqual([]);
    expect(mapState(null)).toEqual([]);
  });

  it("HIGH-RISK path: RECEIVED implied, visited steps completed, current lit, rest pending", () => {
    const v = buildLifecycle({ currentState: "IMPLEMENTING", status: "ACTIVE", hasTaskCreated: true, transitions: tr(["CLASSIFYING", "PLANNING", "WAITING_FOR_APPROVAL", "IMPLEMENTING"]) });
    expect(statusOf(v, "RECEIVED")).toBe("completed");
    expect(v.steps[0]?.implied).toBe(true);
    expect(statusOf(v, "CLASSIFYING")).toBe("completed");
    expect(statusOf(v, "PLANNING")).toBe("completed");
    expect(statusOf(v, "WAITING_FOR_APPROVAL")).toBe("completed");
    expect(statusOf(v, "IMPLEMENTING")).toBe("current");
    expect(statusOf(v, "TESTING")).toBe("pending");
    expect(statusOf(v, "COMPLETE")).toBe("pending");
    expect(v.exit).toBeNull();
  });

  it("STANDARD path skips PLANNING and WAITING_FOR_APPROVAL", () => {
    const v = buildLifecycle({ currentState: "IMPLEMENTING", status: "ACTIVE", hasTaskCreated: true, transitions: tr(["CLASSIFYING", "IMPLEMENTING"]) });
    expect(statusOf(v, "PLANNING")).toBe("skipped");
    expect(statusOf(v, "WAITING_FOR_APPROVAL")).toBe("skipped");
    expect(statusOf(v, "IMPLEMENTING")).toBe("current");
  });

  it("VALIDATING lights TESTING and REVIEWING together", () => {
    const v = buildLifecycle({ currentState: "VALIDATING", status: "ACTIVE", hasTaskCreated: true, transitions: tr(["CLASSIFYING", "IMPLEMENTING", "VALIDATING"]) });
    expect(statusOf(v, "TESTING")).toBe("current");
    expect(statusOf(v, "REVIEWING")).toBe("current");
    expect(v.steps.filter((s) => s.status === "current")).toHaveLength(2);
  });

  it("fix loop: SYNTHESIZING current again keeps FIXING and REVALIDATING completed, counts visits", () => {
    const v = buildLifecycle({ currentState: "SYNTHESIZING", status: "ACTIVE", hasTaskCreated: true, transitions: tr(["CLASSIFYING", "IMPLEMENTING", "VALIDATING", "SYNTHESIZING", "FIXING", "REVALIDATING", "SYNTHESIZING"]) });
    expect(statusOf(v, "SYNTHESIZING")).toBe("current");
    expect(statusOf(v, "FIXING")).toBe("completed");
    expect(statusOf(v, "REVALIDATING")).toBe("completed");
    expect(statusOf(v, "READY")).toBe("pending");
    expect(v.steps.find((s) => s.state === "SYNTHESIZING")?.visits).toBe(2);
  });

  it("BLOCKED mid-flow shows an exit marker after the last on-timeline state and no current step", () => {
    const v = buildLifecycle({ currentState: "BLOCKED", status: "BLOCKED", hasTaskCreated: true, transitions: tr(["CLASSIFYING", "IMPLEMENTING", "BLOCKED"]) });
    expect(v.exit?.state).toBe("BLOCKED");
    expect(v.exit?.seq).toBe(3);
    expect(v.steps.some((s) => s.status === "current")).toBe(false);
    expect(statusOf(v, "IMPLEMENTING")).toBe("completed");
    expect(statusOf(v, "PLANNING")).toBe("skipped");
    expect(statusOf(v, "TESTING")).toBe("pending");
  });

  it("CANCELLED is an exit marker; ROUND_CAP_REACHED too", () => {
    const v = buildLifecycle({ currentState: "CANCELLED", status: "CANCELLED", hasTaskCreated: true, transitions: tr(["CLASSIFYING", "CANCELLED"]) });
    expect(v.exit?.label).toBe("Cancelled");
    const r = buildLifecycle({ currentState: "ROUND_CAP_REACHED", status: "BLOCKED", hasTaskCreated: true, transitions: tr(["CLASSIFYING", "IMPLEMENTING", "VALIDATING", "SYNTHESIZING", "ROUND_CAP_REACHED"]) });
    expect(r.exit?.state).toBe("ROUND_CAP_REACHED");
  });

  it("COMPLETE makes every step completed or skipped, with no current step", () => {
    const v = buildLifecycle({ currentState: "COMPLETE", status: "COMPLETE", hasTaskCreated: true, transitions: tr(["CLASSIFYING", "IMPLEMENTING", "VALIDATING", "SYNTHESIZING", "READY", "COMPLETE"]) });
    expect(v.steps.every((s) => s.status === "completed" || s.status === "skipped")).toBe(true);
    expect(statusOf(v, "COMPLETE")).toBe("completed");
    expect(statusOf(v, "FIXING")).toBe("skipped");
    expect(statusOf(v, "HUMAN_APPROVAL")).toBe("skipped");
  });

  it("CORRUPT and INCOMPLETE statuses are shown as the exit marker", () => {
    const v = buildLifecycle({ currentState: "IMPLEMENTING", status: "CORRUPT", hasTaskCreated: true, transitions: tr(["CLASSIFYING", "IMPLEMENTING"]) });
    expect(v.exit?.state).toBe("CORRUPT");
    const i = buildLifecycle({ currentState: null, status: "INCOMPLETE", hasTaskCreated: false, transitions: [] });
    expect(i.exit?.state).toBe("INCOMPLETE");
    expect(statusOf(i, "RECEIVED")).toBe("pending");
  });
});
