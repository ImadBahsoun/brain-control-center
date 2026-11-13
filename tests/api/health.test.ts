import { describe, expect, it } from "vitest";
import type { HealthResponse } from "@/lib/api-types";
import { GET } from "@/app/api/health/route";
import { freshHome, GATE_CODE_SENTINEL, GATE_SENTINELS, mkdirs, SESSION_SENTINEL, standardScript, writeGate, writeGovernor, writeScript } from "../helpers/fixture-store";

const H = { headers: { host: "127.0.0.1:3077" } };

describe("GET /api/health", () => {
  it("returns ok with gate aggregates and no gate secrets", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    writeGate(home, Date.now());
    writeScript(home, "BR-20261007-0001", standardScript(home));
    const res = await GET(new Request("http://127.0.0.1:3077/api/health", H), {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthResponse;
    expect(body.status).toBe("ok");
    expect(body.readOnly).toBe(true);
    expect(body.sources.gate.requests).toEqual({ pending: 1, expired: 1, consumed: 1, revoked: 0, pendingByAction: { commit: 1 } });
    expect(body.sources.gate.latestValidations[0]?.repo).toBe(GATE_SENTINELS.cwd); // not under HOME, so unchanged
    expect(body.sources.gate.audit.countsByEvent.FAIL_CLOSED).toBe(2);
    const text = JSON.stringify(body);
    for (const s of [GATE_CODE_SENTINEL, SESSION_SENTINEL, GATE_SENTINELS.task, GATE_SENTINELS.brainLine, GATE_SENTINELS.display, GATE_SENTINELS.inputs, GATE_SENTINELS.envs, GATE_SENTINELS.approvalUuid, GATE_SENTINELS.auditCommand, "envs", "inputs", "approval_uuid"]) {
      expect(text, s).not.toContain(s);
    }
  });
  it("returns unavailable (still 200) when the store is missing", async () => {
    freshHome();
    const body = (await (await GET(new Request("http://127.0.0.1:3077/api/health", H), {})).json()) as HealthResponse;
    expect(body.status).toBe("unavailable");
    expect(body.sources.tasks.status).toBe("missing");
  });
});
