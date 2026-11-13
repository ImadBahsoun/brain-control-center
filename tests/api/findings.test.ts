import { describe, expect, it } from "vitest";
import type { FindingsResponse } from "@/lib/api-types";
import { GET } from "@/app/api/tasks/[id]/findings/route";
import { freshHome, highRiskScript, mkdirs, SENTINELS, writeScript } from "../helpers/fixture-store";

const H = { headers: { host: "127.0.0.1:3077" } };
const ID = "BR-20261007-0001";

describe("GET /api/tasks/[id]/findings", () => {
  it("returns the sorted findings with summary, resolution and history", async () => {
    const home = freshHome();
    mkdirs(home);
    writeScript(home, ID, highRiskScript(home, { stopAfter: 23 }));
    const res = await GET(new Request(`http://127.0.0.1:3077/api/tasks/${ID}/findings`, H), { params: Promise.resolve({ id: ID }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as FindingsResponse;
    expect(body.taskId).toBe(ID);
    expect(body.summary).toEqual({ total: 2, open: 2, openBySeverity: { BLOCKER: 0, MAJOR: 1, MINOR: 1, NIT: 0 } });
    expect(body.findings.map((f) => [f.id, f.severity, f.status])).toEqual([
      ["F-001", "MAJOR", "ACKNOWLEDGED"],
      ["F-002", "MINOR", "ACKNOWLEDGED"],
    ]);
    expect(body.findings[0]?.history.map((h) => h.status)).toEqual(["OPEN", "ACKNOWLEDGED"]);
    expect(body.findings[0]?.resolution).toBeNull();
    expect(body.integrity.log).toBe("ok");
    expect(JSON.stringify(body)).not.toContain(SENTINELS.session);
  });
  it("returns 404 for an unknown task and 400 for a bad id", async () => {
    const home = freshHome();
    mkdirs(home);
    const missing = await GET(new Request(`http://127.0.0.1:3077/api/tasks/BR-20261007-0002/findings`, H), { params: Promise.resolve({ id: "BR-20261007-0002" }) });
    expect(missing.status).toBe(404);
    const bad = await GET(new Request(`http://127.0.0.1:3077/api/tasks/x/findings`, H), { params: Promise.resolve({ id: "../x" }) });
    expect(bad.status).toBe(400);
  });
});
