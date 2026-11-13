import { afterEach, describe, expect, it, vi } from "vitest";
import type { GovernorResponse } from "@/lib/api-types";
import { GET } from "@/app/api/governor/route";
import { freshHome, highRiskScript, mkdirs, standardScript, writeGovernor, writeScript } from "../helpers/fixture-store";

const H = { headers: { host: "127.0.0.1:3077" } };

afterEach(() => vi.useRealTimers());

describe("GET /api/governor", () => {
  it("returns the policy, global usage, per-task usage for active tasks, and denials", async () => {
    // the fixture's runs start at 08:00 UTC; pin the clock so staleness (240 min) is deterministic
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-07T13:00:00.000Z"));
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    writeScript(home, "BR-20261007-0001", highRiskScript(home, { complete: true })); // terminal: excluded
    writeScript(home, "BR-20261007-0002", standardScript(home, { pendingDeveloper: true }));
    writeScript(home, "BR-20261007-0003", highRiskScript(home, { stopAfter: 39 })); // READY, with governor notes
    const body = (await (await GET(new Request("http://127.0.0.1:3077/api/governor", H), {})).json()) as GovernorResponse;
    expect(body.policyStatus).toBe("ok");
    expect(body.policy).toMatchObject({ version: 1, softLimitPercent: 80, maxParallelPerTask: 3, staleAfterMinutes: 240, agents: { developer: { policyUnits: 3, model: "fable" } }, taskBudgets: { "HIGH-RISK": 36 } });
    expect(body.global).toMatchObject({ pendingDevelopers: 0, pendingValidators: 0, pendingOpus: 0, pendingFable: 0, pendingTotal: 0 });
    expect(body.global.staleExcluded).toBe(1); // the pending developer started 5 h ago: STALE, not counted
    vi.setSystemTime(Date.parse("2026-10-07T09:00:00.000Z"));
    const live = (await (await GET(new Request("http://127.0.0.1:3077/api/governor", H), {})).json()) as GovernorResponse;
    expect(live.global).toMatchObject({ pendingTotal: 1, pendingDevelopers: 1, pendingFable: 1, staleExcluded: 0 });
    expect(body.tasks.map((t) => t.taskId)).toEqual(["BR-20261007-0003", "BR-20261007-0002"]);
    const hr = body.tasks.find((t) => t.taskId === "BR-20261007-0003")!;
    expect(hr).toMatchObject({ classification: "HIGH-RISK", classBudget: 36, consumed: 16, reserved: 0, committed: 16, percentOfClassBudget: 44, softLimitCrossed: false, note: "class budget; session extensions not visible" });
    const std = body.tasks.find((t) => t.taskId === "BR-20261007-0002")!;
    expect(std).toMatchObject({ classBudget: 28, consumed: 0, reserved: 3, committed: 3 });
    expect(body.denials).toEqual([{ taskId: "BR-20261007-0003", seq: 38, ts: expect.any(String), code: "CONCURRENCY", role: "qa" }]);
    expect(body.softLimitAccepted).toEqual([{ taskId: "BR-20261007-0003", seq: 39, ts: expect.any(String) }]);
  });
  it("reports an invalid or missing policy without failing", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home, { v: 1 });
    const invalid = (await (await GET(new Request("http://127.0.0.1:3077/api/governor", H), {})).json()) as GovernorResponse;
    expect(invalid.policyStatus).toBe("invalid");
    expect(invalid.policy).toBeNull();
    expect(invalid.policyReason).toMatch(/missing key/);
    const none = freshHome();
    mkdirs(none);
    const missing = (await (await GET(new Request("http://127.0.0.1:3077/api/governor", H), {})).json()) as GovernorResponse;
    expect(missing.policyStatus).toBe("missing");
  });
});
