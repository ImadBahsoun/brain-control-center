import { afterEach, describe, expect, it, vi } from "vitest";
import { atmosphere } from "@/lib/ui/atmosphere";
import { buildCommandMap, type CommandMapModel } from "@/lib/ui/command-map";
import { freshHome, highRiskScript, mkdirs, standardScript, writeGovernor, writeScript } from "../helpers/fixture-store";
import { mapInput } from "../helpers/ui-fixtures";

const ID = "BR-20261007-0001";

afterEach(() => vi.useRealTimers());

async function highRisk(opts: { stopAfter?: number; complete?: boolean; now?: string } = {}): Promise<CommandMapModel> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse(opts.now ?? "2026-10-07T08:30:00.000Z"));
  const home = freshHome();
  mkdirs(home);
  writeGovernor(home);
  writeScript(home, ID, highRiskScript(home, opts.complete ? { complete: true } : { stopAfter: opts.stopAfter }));
  return buildCommandMap(await mapInput(ID));
}

describe("atmosphere (one phase per real mission state)", () => {
  it("follows the lifecycle of the HIGH-RISK script", async () => {
    const phases: Array<[number, string]> = [
      [3, "build"], // PLANNING, planner reserved
      [6, "waiting"], // plan gate
      [10, "build"], // IMPLEMENTING
      [16, "scan"], // VALIDATING with QA pending
      [22, "analyze"], // SYNTHESIZING
      [25, "build"], // FIXING
      [31, "analyze"], // REVALIDATING, only the reviewer pending
      [37, "ready"],
      [40, "waiting"], // human gate
    ];
    for (const [n, phase] of phases) {
      const m = await highRisk({ stopAfter: n });
      expect(m.mode).toBe("live");
      expect(atmosphere(m).phase, `stopAfter ${n}`).toBe(phase);
    }
  });
  it("is energized only by a non-stale reservation, and guardian only while the security reviewer holds one", async () => {
    const m16 = atmosphere(await highRisk({ stopAfter: 16 }));
    expect(m16).toMatchObject({ energized: true, guardian: true, ambient: false, animated: true });
    expect(atmosphere(await highRisk({ stopAfter: 22 }))).toMatchObject({ energized: false, guardian: false });
    expect(atmosphere(await highRisk({ stopAfter: 3, now: "2026-10-07T14:00:00.000Z" }))).toMatchObject({ phase: "build", energized: false });
  });
  it("is a static green completion in debrief, and static standby for a cancelled mission", async () => {
    expect(atmosphere(await highRisk({ complete: true }))).toMatchObject({ phase: "complete", animated: false, ambient: false, energized: false, label: "COMPLETE" });
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    writeScript(home, ID, standardScript(home, { cancelled: true }));
    expect(atmosphere(buildCommandMap(await mapInput(ID)))).toMatchObject({ phase: "standby", animated: false });
  });
  it("is red when blocked", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    writeScript(home, ID, standardScript(home, { blocked: true }));
    expect(atmosphere(buildCommandMap(await mapInput(ID)))).toMatchObject({ phase: "blocked", animated: true, label: "BLOCKED" });
  });
  it("has ambient motion only on the idle map; loading is static standby; replay animates", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    const input = await mapInput(null);
    expect(atmosphere(buildCommandMap(input))).toMatchObject({ phase: "standby", ambient: true, animated: false, guardian: false, energized: false });
    expect(atmosphere(buildCommandMap({ ...input, focusId: ID }))).toMatchObject({ phase: "standby", ambient: false, animated: false });
    const m = await highRisk({ stopAfter: 16 });
    expect(atmosphere({ ...m, mode: "replay" })).toMatchObject({ phase: "scan", animated: true, ambient: false });
  });
});
