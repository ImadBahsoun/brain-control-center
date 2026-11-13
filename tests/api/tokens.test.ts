import { beforeEach, describe, expect, it } from "vitest";
import type { ApiError, TokenIntelligenceResponse } from "@/lib/api-types";
import { GET } from "@/app/api/tokens/route";
import { resetTokenScanStateForTests } from "@/server/tokens/scan";
import { freshHome, mkdirs } from "../helpers/fixture-store";
import { assistantLine, projectDirName, writeSessionTranscript } from "../helpers/transcript-fixtures";

const H = { headers: { host: "127.0.0.1:3077" } };

beforeEach(() => resetTokenScanStateForTests());

describe("GET /api/tokens", () => {
  it("returns the full shape for a populated store", async () => {
    const home = freshHome();
    mkdirs(home);
    writeSessionTranscript(home, projectDirName("/repo/x"), "11111111-aaaa-aaaa-aaaa-111111111111", [assistantLine("m1", "claude-sonnet-5", { input: 10, output: 5 }, new Date().toISOString())]);
    const res = await GET(new Request("http://127.0.0.1:3077/api/tokens?window=7d", H), {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as TokenIntelligenceResponse;
    expect(body.costBasis.kind).toBe("api-list-price-equivalent");
    expect(body.window.kind).toBe("7d");
    expect(body.totals.calls).toBeGreaterThanOrEqual(1);
    for (const key of ["byModel", "byAgent", "byMission", "unattributed", "daily", "attachments"] as const) expect(Array.isArray(body[key])).toBe(true);
    expect(body.reconciliation.baseline.status).toBe("unavailable");
    expect(body.coverage.projectsDir).toBe("ok");
  });

  it("defaults to the 7d window and rejects anything other than 7d/30d with 400 BAD_WINDOW", async () => {
    const home = freshHome();
    mkdirs(home);
    const def = (await (await GET(new Request("http://127.0.0.1:3077/api/tokens", H), {})).json()) as TokenIntelligenceResponse;
    expect(def.window.kind).toBe("7d");
    for (const bad of ["1d", "90d", "", "7D", "7d "]) {
      const res = await GET(new Request(`http://127.0.0.1:3077/api/tokens?window=${encodeURIComponent(bad)}`, H), {});
      expect(res.status, bad).toBe(400);
      expect(((await res.json()) as ApiError).error.code).toBe("BAD_WINDOW");
    }
  });

  it("accepts 30d", async () => {
    const home = freshHome();
    mkdirs(home);
    const res = await GET(new Request("http://127.0.0.1:3077/api/tokens?window=30d", H), {});
    expect(res.status).toBe(200);
    expect(((await res.json()) as TokenIntelligenceResponse).window.kind).toBe("30d");
  });

  it("refuses a non-local Host or a cross-site Origin with 403", async () => {
    const badHost = await GET(new Request("http://127.0.0.1:3077/api/tokens", { headers: { host: "evil.test:3077" } }), {});
    expect(badHost.status).toBe(403);
    const badOrigin = await GET(new Request("http://127.0.0.1:3077/api/tokens", { headers: { host: "127.0.0.1:3077", origin: "http://evil.test" } }), {});
    expect(badOrigin.status).toBe(403);
  });

  it("reports coverage.projectsDir missing for an empty store and still returns 200", async () => {
    const home = freshHome();
    mkdirs(home);
    const res = await GET(new Request("http://127.0.0.1:3077/api/tokens", H), {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as TokenIntelligenceResponse;
    expect(body.coverage.projectsDir).toBe("missing");
    expect(body.totals.calls).toBe(0);
  });
});
