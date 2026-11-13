import { describe, expect, it } from "vitest";
import type { ApiError, EventsResponse } from "@/lib/api-types";
import { GET } from "@/app/api/tasks/[id]/events/route";
import { freshHome, highRiskScript, mkdirs, SENTINELS, writeGovernor, writeScript } from "../helpers/fixture-store";

const H = { headers: { host: "127.0.0.1:3077" } };
const ID = "BR-20261007-0001";
const call = (q = "", id = ID) => GET(new Request(`http://127.0.0.1:3077/api/tasks/${id}/events${q}`, H), { params: Promise.resolve({ id }) });

describe("GET /api/tasks/[id]/events", () => {
  it("returns activity lines newest last, honours limit and reports hasMore", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    writeScript(home, ID, highRiskScript(home, { complete: true }));
    const all = (await (await call()).json()) as EventsResponse;
    expect(all.total).toBe(41);
    expect(all.events).toHaveLength(41);
    expect(all.hasMore).toBe(false);
    expect(all.events[0]).toMatchObject({ seq: 1, type: "TASK_CREATED", text: "Task created (HIGH-RISK)", stateChange: { from: null, to: "CLASSIFYING" } });
    expect(all.events.at(-1)).toMatchObject({ seq: 41, type: "TASK_COMPLETED", text: "Task COMPLETE", tone: "success" });
    expect(all.integrity.log).toBe("ok");
    const governor = all.events.filter((e) => e.text.startsWith("Governor"));
    expect(governor.map((e) => e.text)).toEqual(["Governor denied QA: CONCURRENCY", "Governor soft limit accepted"]);
    const some = (await (await call("?limit=3")).json()) as EventsResponse;
    expect(some.events.map((e) => e.seq)).toEqual([39, 40, 41]);
    expect(some.hasMore).toBe(true);
    const text = JSON.stringify(all);
    for (const s of [SENTINELS.request, SENTINELS.session, SENTINELS.packet, SENTINELS.report, SENTINELS.planText, SENTINELS.command]) expect(text).not.toContain(s);
  });
  it("rejects a bad limit and an unknown task", async () => {
    const home = freshHome();
    mkdirs(home);
    writeScript(home, ID, highRiskScript(home, { stopAfter: 3 }));
    for (const q of ["?limit=0", "?limit=1001", "?limit=abc", "?limit=-5"]) {
      const res = await call(q);
      expect(res.status, q).toBe(400);
      expect(((await res.json()) as ApiError).error.code).toBe("BAD_LIMIT");
    }
    expect((await call("", "BR-20261007-0002")).status).toBe(404);
  });
});
