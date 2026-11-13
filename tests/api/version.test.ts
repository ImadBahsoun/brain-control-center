import { describe, expect, it } from "vitest";
import * as versionRoute from "@/app/api/version/route";

const URL_ = "http://127.0.0.1:3077/api/version";
const H = { headers: { host: "127.0.0.1:3077" } };

describe("GET /api/version", () => {
  it("returns exactly the name and version as JSON with no-store and no CORS header", async () => {
    const res = await versionRoute.GET(new Request(URL_, H), {});
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect([...res.headers.keys()].some((k) => k.toLowerCase().startsWith("access-control"))).toBe(false);
    expect(await res.json()).toStrictEqual({ name: "brain-control-center", version: "1.0.0" });
  });
  it("returns 403 FORBIDDEN_HOST for a foreign Host", async () => {
    const res = await versionRoute.GET(new Request(URL_, { headers: { host: "evil.test:3077" } }), {});
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "FORBIDDEN_HOST", message: expect.any(String) } });
  });
  it("exports only GET plus the dynamic segment config", () => {
    expect(Object.keys(versionRoute).sort()).toEqual(["GET", "dynamic", "runtime"]);
    expect(versionRoute.dynamic).toBe("force-dynamic");
    expect(versionRoute.runtime).toBe("nodejs");
  });
});
