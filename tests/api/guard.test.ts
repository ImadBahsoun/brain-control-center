import { describe, expect, it } from "vitest";
import * as agentsRoute from "@/app/api/agents/route";
import * as approvalsRoute from "@/app/api/approvals/route";
import * as governorRoute from "@/app/api/governor/route";
import * as healthRoute from "@/app/api/health/route";
import * as detailRoute from "@/app/api/tasks/[id]/route";
import * as eventsRoute from "@/app/api/tasks/[id]/events/route";
import * as findingsRoute from "@/app/api/tasks/[id]/findings/route";
import * as tasksRoute from "@/app/api/tasks/route";
import { ALLOWED_HOSTS, guardRequest, isAllowedHost, isAllowedOrigin, json, parseLimit, PORT, withApi } from "@/server/http";
import { freshHome, mkdirs } from "../helpers/fixture-store";

const URL_ = "http://127.0.0.1:3077/api/tasks";

describe("request guard", () => {
  it("allows only the two local hosts on the fixed port", () => {
    expect(PORT).toBe(3077);
    expect([...ALLOWED_HOSTS].sort()).toEqual(["127.0.0.1:3077", "localhost:3077"]);
    expect(isAllowedHost("127.0.0.1:3077")).toBe(true);
    expect(isAllowedHost("LOCALHOST:3077")).toBe(true);
    for (const bad of [null, "", "127.0.0.1", "127.0.0.1:3000", "evil.test:3077", "127.0.0.1.evil.test:3077", "[::1]:3077", "0.0.0.0:3077"]) {
      expect(isAllowedHost(bad), String(bad)).toBe(false);
    }
  });
  it("accepts an absent Origin or a local http Origin and refuses anything else", () => {
    expect(isAllowedOrigin(null)).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:3077")).toBe(true);
    expect(isAllowedOrigin("http://localhost:3077")).toBe(true);
    for (const bad of ["null", "http://evil.test", "https://127.0.0.1:3077", "http://127.0.0.1:3000", "http://127.0.0.1:3077.evil.test"]) {
      expect(isAllowedOrigin(bad), bad).toBe(false);
    }
  });
  it("returns 403 for a non-local Host, a cross-site Origin or Sec-Fetch-Site: cross-site, and ignores X-Forwarded-*", async () => {
    const ok = guardRequest(new Request(URL_, { headers: { host: "127.0.0.1:3077", "x-forwarded-host": "evil.test" } }));
    expect(ok).toBeNull();
    const host = guardRequest(new Request(URL_, { headers: { host: "evil.test:3077" } }));
    expect(host?.status).toBe(403);
    expect(await host?.json()).toEqual({ error: { code: "FORBIDDEN_HOST", message: expect.any(String) } });
    const noHost = guardRequest(new Request(URL_));
    expect(noHost?.status).toBe(403);
    const origin = guardRequest(new Request(URL_, { headers: { host: "127.0.0.1:3077", origin: "http://evil.test" } }));
    expect(origin?.status).toBe(403);
    expect((await origin?.json()).error.code).toBe("FORBIDDEN_ORIGIN");
    const sfs = guardRequest(new Request(URL_, { headers: { host: "127.0.0.1:3077", "sec-fetch-site": "cross-site" } }));
    expect(sfs?.status).toBe(403);
    const sameOrigin = guardRequest(new Request(URL_, { headers: { host: "127.0.0.1:3077", "sec-fetch-site": "same-origin", origin: "http://127.0.0.1:3077" } }));
    expect(sameOrigin).toBeNull();
  });
  it("json() sets Cache-Control: no-store and nosniff, no CORS header, and sanitizes the body", async () => {
    const res = json({ a: "ghp_abcdefghijklmnop", home: process.env.HOME + "/x" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect([...res.headers.keys()].some((k) => k.toLowerCase().startsWith("access-control"))).toBe(false);
    expect(await res.json()).toEqual({ a: "***", home: "~/x" });
  });
  it("withApi turns a thrown error into a path-free 500", async () => {
    const h = withApi(async () => {
      throw new Error("boom /Users/someone/.claude/secret");
    });
    const res = await h(new Request(URL_, { headers: { host: "127.0.0.1:3077" } }), {});
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain("INTERNAL");
    expect(body).not.toContain("boom");
    expect(body).not.toContain(".claude");
  });
  it("parseLimit accepts 1..max integers only", () => {
    expect(parseLimit("http://x/?limit=5", 200, 1000)).toBe(5);
    expect(parseLimit("http://x/", 200, 1000)).toBe(200);
    for (const bad of ["0", "1001", "-1", "abc", "1.5", "1e2", " 5", "5 "]) expect(parseLimit(`http://x/?limit=${encodeURIComponent(bad)}`, 200, 1000), bad).toBeUndefined();
  });
  it("every route module exports only GET (other methods get Next's 405) plus the segment config", () => {
    for (const mod of [agentsRoute, approvalsRoute, governorRoute, healthRoute, detailRoute, eventsRoute, findingsRoute, tasksRoute]) {
      const keys = Object.keys(mod).sort();
      expect(keys).toEqual(["GET", "dynamic", "runtime"]);
      expect((mod as { dynamic: string }).dynamic).toBe("force-dynamic");
      expect((mod as { runtime: string }).runtime).toBe("nodejs");
    }
  });
  it("every endpoint answers GET with JSON and no-store, and 403 for a foreign host", async () => {
    const home = freshHome();
    mkdirs(home);
    const id = "BR-20261007-0001";
    const ctx = { params: Promise.resolve({ id }) };
    const calls: Array<[string, (req: Request, ctx: never) => Promise<Response>]> = [
      ["/api/health", healthRoute.GET as never],
      ["/api/tasks", tasksRoute.GET as never],
      ["/api/agents", agentsRoute.GET as never],
      ["/api/approvals", approvalsRoute.GET as never],
      ["/api/governor", governorRoute.GET as never],
      [`/api/tasks/${id}`, detailRoute.GET as never],
      [`/api/tasks/${id}/events`, eventsRoute.GET as never],
      [`/api/tasks/${id}/findings`, findingsRoute.GET as never],
    ];
    for (const [p, fn] of calls) {
      const good = await fn(new Request(`http://127.0.0.1:3077${p}`, { headers: { host: "127.0.0.1:3077" } }), ctx as never);
      expect(good.headers.get("content-type"), p).toContain("application/json");
      expect(good.headers.get("cache-control"), p).toBe("no-store");
      expect([200, 404], p).toContain(good.status);
      const bad = await fn(new Request(`http://127.0.0.1:3077${p}`, { headers: { host: "evil.test:3077" } }), ctx as never);
      expect(bad.status, p).toBe(403);
    }
  });
});
