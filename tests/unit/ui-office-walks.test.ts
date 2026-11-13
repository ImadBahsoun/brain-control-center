import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCommandMap, type CommandMapModel } from "@/lib/ui/command-map";
import { diffSnapshots, snapshotOf, type LiveEffect } from "@/lib/ui/live-diff";
import { LIVE_WALK_MS, MAX_WALKERS, officeWalks, walkMs } from "@/lib/ui/office";
import { OFFICE_EDGE_GEOMETRY, walkPath, walkRoute } from "@/lib/ui/office-layout";
import { asReplayModel, buildReplay, replayFrame, replayStepEffects, STEP_MS } from "@/lib/ui/replay";
import { freshHome, highRiskScript, mkdirs, writeGovernor, writeScript } from "../helpers/fixture-store";
import { apiDetail, apiEvents, apiFindings, mapInput } from "../helpers/ui-fixtures";

const ID = "BR-20261007-0001";
const OTHER = "BR-20261007-0002";

afterEach(() => vi.useRealTimers());

async function at(stopAfter: number, id = ID): Promise<CommandMapModel> {
  const home = freshHome();
  mkdirs(home);
  writeGovernor(home);
  writeScript(home, id, highRiskScript(home, { stopAfter }));
  return buildCommandMap(await mapInput(id));
}

/** The live effects between two consecutive polls, tagged with their mission as useLiveEffects does. */
function live(prev: CommandMapModel | null, next: CommandMapModel) {
  const n = snapshotOf(next);
  return diffSnapshots(prev ? snapshotOf(prev) : null, n).map((effect, i) => ({ key: `k${i}`, effect, at: 0, missionId: n?.missionId }));
}

const opts = (missionId: string | null = ID) => ({ replay: false, stepMs: null, missionId });

describe("officeWalks over live diffs", () => {
  it("6 → 10: the plan goes from PLANNING to BUILD along the E2 corridor", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-07T08:30:00.000Z"));
    const next = await at(10);
    const walkers = officeWalks(live(await at(6), next), next, opts());
    expect(walkers.map((w) => [w.origin, w.dest])).toEqual([["planner", "developer"]]);
    expect(walkers[0]).toMatchObject({ label: "#0001", text: "#0001 ← Planner", durationMs: LIVE_WALK_MS });
    expect(walkers[0]?.d).toBe(OFFICE_EDGE_GEOMETRY.E2.path);
    expect(walkers[0]?.source.length).toBeGreaterThan(0);
  });
  it("10 → 16: three tokens leave BUILD for the validators, round the core", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-07T08:30:00.000Z"));
    const next = await at(16);
    const walkers = officeWalks(live(await at(10), next), next, opts());
    expect(walkers.map((w) => [w.origin, w.dest])).toEqual([
      ["developer", "qa"],
      ["developer", "reviewer"],
      ["developer", "security-reviewer"],
    ]);
    for (const w of walkers) {
      expect(w.d).toBe(walkPath("developer", w.dest));
      expect(walkRoute("developer", w.dest).length).toBeGreaterThan(2); // door, the ring round the core, door
    }
  });
  it("3 → 6: the plan gate raised sends a token from PLANNING to the gate room", async () => {
    const next = await at(6);
    const walkers = officeWalks(live(await at(3), next), next, opts());
    expect(walkers.map((w) => [w.origin, w.dest])).toEqual([["planner", "gate"]]);
  });
  it("24 → 25: a fix round sends the developer from synthesis along the fix loop (E12), not from the last validator", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-07T08:30:00.000Z"));
    const next = await at(25);
    const fix = next.detail?.agents.filter((r) => r.role === "developer" && r.status === "pending") ?? [];
    expect(fix.map((r) => r.kind)).toEqual(["fix"]);
    const walkers = officeWalks(live(await at(24), next), next, opts());
    expect(walkers.map((w) => [w.origin, w.dest])).toEqual([["synthesis", "developer"]]);
    expect(walkers[0]).toMatchObject({ text: "#0001 ← Synthesis", d: walkPath("synthesis", "developer") });
  });
  it("walks for nothing else: completions, steps and findings never move a token", async () => {
    const next = await at(22);
    const effects = live(await at(16), next);
    expect(effects.map((e) => e.effect.kind)).toEqual(expect.arrayContaining(["agent-complete", "finding-new"]));
    expect(effects.some((e) => e.effect.kind === "agent-start" || e.effect.kind === "gate-raised")).toBe(false);
    expect(officeWalks(effects, next, opts())).toEqual([]);
  });
  it("never walks on a first load, an identical refetch or a mission switch", async () => {
    const a = await at(10);
    expect(officeWalks(live(null, a), a, opts())).toEqual([]);
    expect(officeWalks(live(a, await at(10)), a, opts())).toEqual([]);
    const other = await at(16, OTHER);
    expect(officeWalks(live(a, other), other, opts(OTHER))).toEqual([]);
  });
  it("drops a token whose effect belongs to another mission than the one shown", async () => {
    const next = await at(10);
    const effects = live(await at(6), next);
    expect(effects.length).toBeGreaterThan(0);
    expect(officeWalks(effects.map((e) => ({ ...e, missionId: OTHER })), next, opts())).toEqual([]);
    expect(officeWalks(effects.map((e) => ({ key: e.key, effect: e.effect })), next, opts())).toEqual([]);
    expect(officeWalks(effects, next, opts(OTHER))).toEqual([]);
  });
  it("draws at most four tokens", async () => {
    const m = await at(16);
    const starts: LiveEffect[] = [
      { kind: "agent-start", target: "planner" },
      { kind: "agent-start", target: "developer" },
      { kind: "agent-start", target: "qa" },
      { kind: "agent-start", target: "reviewer" },
      { kind: "agent-start", target: "security-reviewer" },
      { kind: "gate-raised", target: "gate" },
    ];
    expect(officeWalks(starts.map((effect, i) => ({ key: `s${i}`, effect, missionId: ID })), m, opts())).toHaveLength(MAX_WALKERS);
  });
});

describe("officeWalks in a replay", () => {
  it("walks only after a single step forward, and ends before the next step", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-07T08:30:00.000Z"));
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    writeScript(home, ID, highRiskScript(home, { complete: true }));
    const [detail, findings, events] = await Promise.all([apiDetail(ID), apiFindings(ID), apiEvents(ID, 1000)]);
    const built = buildReplay(detail, findings, events);
    if (!built.ok) throw new Error(built.reason);
    const t = built.timeline;
    const i = t.steps.findIndex((_, k) => replayStepEffects(t, k, 1).some((e) => e.effect.kind === "agent-start" && e.effect.target === "developer"));
    expect(i).toBeGreaterThan(0);
    const frame = asReplayModel(replayFrame(t, i));
    const replayOpts = (speed: 1 | 2 | 4) => ({ replay: true, stepMs: STEP_MS[speed], missionId: ID });
    expect(officeWalks(replayStepEffects(t, i, 0), frame, replayOpts(1))).toEqual([]);
    const walkers = officeWalks(replayStepEffects(t, i, 1), frame, replayOpts(1));
    expect(walkers.map((w) => [w.origin, w.dest])).toEqual([["planner", "developer"]]);
    expect(walkers[0]?.durationMs).toBe(Math.round(STEP_MS[1] * 0.85));
    expect(officeWalks(replayStepEffects(t, i, 1), frame, replayOpts(4))[0]?.durationMs).toBe(Math.round(STEP_MS[4] * 0.85));
    for (const s of [1, 2, 4] as const) expect(walkMs(true, STEP_MS[s])).toBeLessThan(STEP_MS[s]);
    // the second developer start is the fix round: it walks from synthesis along the fix loop
    const starts = t.steps.map((_, k) => k).filter((k) => replayStepEffects(t, k, 1).some((e) => e.effect.kind === "agent-start" && e.effect.target === "developer"));
    expect(starts).toHaveLength(2);
    const second = starts[1] as number;
    const fixWalk = officeWalks(replayStepEffects(t, second, 1), asReplayModel(replayFrame(t, second)), replayOpts(1));
    expect(fixWalk.map((w) => [w.origin, w.dest])).toEqual([["synthesis", "developer"]]);
    expect(walkMs(false, null)).toBe(LIVE_WALK_MS);
  });
});
