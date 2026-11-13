import { afterEach, describe, expect, it, vi } from "vitest";
import { resourceMeters } from "@/lib/ui/resources";
import { freshHome, highRiskScript, mkdirs, writeGovernor, writeScript } from "../helpers/fixture-store";
import { apiDetail, apiGovernor } from "../helpers/ui-fixtures";

afterEach(() => vi.useRealTimers());

describe("resourceMeters", () => {
  it("turns the real policy numbers and TaskUsage into meters with the soft-limit tick", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-07T09:00:00.000Z")); // the fixture's runs started 08:00Z: not stale
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    writeScript(home, "BR-20261007-0001", highRiskScript(home, { stopAfter: 16 })); // qa (fable), reviewer, security (opus) pending
    const governor = await apiGovernor();
    const detail = await apiDetail("BR-20261007-0001");
    const r = resourceMeters(governor, detail.usage);
    expect(r.policyStatus).toBe("ok");
    expect(r.staleAfterMinutes).toBe(240);
    const byId = Object.fromEntries(r.meters.map((m) => [m.id, m]));
    expect(byId.budget).toMatchObject({ value: 5, reserved: 6, max: 36, tickPercent: 80, tone: "signal" });
    expect(byId.budget?.text).toBe("5 used + 6 reserved = 11 / 36 (31%)");
    expect(byId.agents).toMatchObject({ value: 3, max: 3, tone: "warn", text: "3 / 3" });
    expect(byId.developers).toMatchObject({ value: 0, max: 1, tone: "dim" });
    expect(byId.validators).toMatchObject({ value: 3, max: 3 });
    expect(byId.opus).toMatchObject({ value: 2, max: 2 });
    expect(byId.fable).toMatchObject({ value: 1, max: 2, tone: "signal" });
    for (const m of r.meters) expect(m.source.length).toBeGreaterThan(0);
    expect(r.meters.map((m) => m.id)).toEqual(["budget", "agents", "developers", "validators", "opus", "fable"]);
  });
  it("shows no meters when the policy is missing or invalid, and none while loading", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home, { v: 1 });
    writeScript(home, "BR-20261007-0001", highRiskScript(home, { stopAfter: 16 }));
    const invalid = resourceMeters(await apiGovernor(), null);
    expect(invalid.policyStatus).toBe("invalid");
    expect(invalid.policyReason).toMatch(/missing key/);
    expect(invalid.meters).toEqual([]);
    expect(resourceMeters(null, null)).toMatchObject({ policyStatus: "loading", meters: [] });
  });
  it("omits the mission budget meter without a focused usage (idle map) and keeps global pips at 0", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    writeScript(home, "BR-20261007-0001", highRiskScript(home, { complete: true }));
    const r = resourceMeters(await apiGovernor(), null);
    expect(r.meters.find((m) => m.id === "budget")).toBeUndefined();
    expect(r.meters).toHaveLength(5);
    for (const m of r.meters) expect(m.value).toBe(0);
  });
});
