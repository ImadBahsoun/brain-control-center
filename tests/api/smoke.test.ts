import { describe, expect, it } from "vitest";
import * as smokeRoute from "@/app/api/smoke/route";

const URL_ = "http://127.0.0.1:3077/api/smoke";
const H = { headers: { host: "127.0.0.1:3077" } };

describe("GET /api/smoke", () => {
  it("returns exactly ok and source as JSON with no-store and no CORS header", async () => {
    const res = await smokeRoute.GET(new Request(URL_, H), {});
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect([...res.headers.keys()].some((k) => k.toLowerCase().startsWith("access-control"))).toBe(false);
    expect(await res.json()).toStrictEqual({ ok: true, source: "brain-smoke-test" });
  });
  it("returns 403 FORBIDDEN_HOST for a foreign Host", async () => {
    const res = await smokeRoute.GET(new Request(URL_, { headers: { host: "evil.test:3077" } }), {});
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "FORBIDDEN_HOST", message: expect.any(String) } });
  });
  it("exports only GET plus the dynamic segment config", () => {
    expect(Object.keys(smokeRoute).sort()).toEqual(["GET", "dynamic", "runtime"]);
    expect(smokeRoute.dynamic).toBe("force-dynamic");
    expect(smokeRoute.runtime).toBe("nodejs");
  });
});
