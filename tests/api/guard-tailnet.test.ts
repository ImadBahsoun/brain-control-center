import { afterEach, describe, expect, it, vi } from "vitest";
import * as agentsRoute from "@/app/api/agents/route";
import * as approvalsRoute from "@/app/api/approvals/route";
import * as governorRoute from "@/app/api/governor/route";
import * as healthRoute from "@/app/api/health/route";
import * as smokeRoute from "@/app/api/smoke/route";
import * as detailRoute from "@/app/api/tasks/[id]/route";
import * as eventsRoute from "@/app/api/tasks/[id]/events/route";
import * as findingsRoute from "@/app/api/tasks/[id]/findings/route";
import * as tasksRoute from "@/app/api/tasks/route";
import * as tokensRoute from "@/app/api/tokens/route";
import * as versionRoute from "@/app/api/version/route";
import { guardRequest, isAllowedHost, isAllowedOrigin, tailnetHost, TAILNET_HOST_ENV } from "@/server/http";
import { freshHome, mkdirs } from "../helpers/fixture-store";

const TAILNET = "demo-box.tail0000.ts.net";
const URL_ = "http://127.0.0.1:3077/api/tasks";

afterEach(() => vi.unstubAllEnvs());

describe("tailnetHost()", () => {
  it("accepts a well-formed tailnet host, normalized to lowercase", () => {
    expect(tailnetHost(TAILNET)).toBe(TAILNET);
    expect(tailnetHost("  Demo-Box.Tail0000.TS.NET ")).toBe(TAILNET);
  });

  it("rejects anything not exactly <machine>.<tailnet>.ts.net", () => {
    const bad = [
      "",
      "   ",
      "https://demo-box.tail0000.ts.net",
      "demo-box.tail0000.ts.net:443",
      "demo-box.tail0000.ts.net.",
      "*.tail0000.ts.net",
      "tail0000.ts.net",
      "a.demo-box.tail0000.ts.net",
      "evil.test",
      "user@demo-box.tail0000.ts.net",
      "demo-box.tail0000.ts.net,evil.test",
      "-bad.tail0000.ts.net",
      "demo-box.tail0000.ts.net/x",
    ];
    for (const raw of bad) expect(tailnetHost(raw), String(raw)).toBeNull();
  });

  it("returns null when the env var is unset, whatever the developer's shell exports", () => {
    vi.stubEnv(TAILNET_HOST_ENV, undefined);
    expect(tailnetHost()).toBeNull();
  });
});

describe("tailnet host/origin allow with BCC_TAILNET_HOST set", () => {
  it("allows the tailnet host (any case) plus the two local hosts", () => {
    vi.stubEnv(TAILNET_HOST_ENV, TAILNET);
    expect(isAllowedHost(TAILNET)).toBe(true);
    expect(isAllowedHost("Demo-Box.Tail0000.TS.NET")).toBe(true);
    expect(isAllowedHost("127.0.0.1:3077")).toBe(true);
    expect(isAllowedHost("localhost:3077")).toBe(true);
  });

  it("rejects other tailnet-shaped hosts, port/suffix/prefix tricks, trailing dot and userinfo", () => {
    vi.stubEnv(TAILNET_HOST_ENV, TAILNET);
    const bad = [
      "other.tail0000.ts.net",
      "demo-box.othertail.ts.net",
      "demo-box.tail0000.ts.net.evil.test",
      "evil-demo-box.tail0000.ts.net",
      "xdemo-box.tail0000.ts.net",
      "demo-box.tail0000.ts.net.",
      "demo-box.tail0000.ts.net:443",
      "demo-box.tail0000.ts.net:3077",
      "user@demo-box.tail0000.ts.net",
      "ts.net",
      "",
      null,
    ];
    for (const h of bad) expect(isAllowedHost(h), String(h)).toBe(false);
  });

  it("the tailnet Host gets 403 FORBIDDEN_HOST when the env is unset, blank or malformed; local hosts still pass", () => {
    for (const raw of [undefined, "", "https://demo-box.tail0000.ts.net", "*.ts.net"]) {
      vi.stubEnv(TAILNET_HOST_ENV, raw);
      const res = guardRequest(new Request(URL_, { headers: { host: TAILNET } }));
      expect(res?.status, String(raw)).toBe(403);
      expect(guardRequest(new Request(URL_, { headers: { host: "127.0.0.1:3077" } })), String(raw)).toBeNull();
      expect(guardRequest(new Request(URL_, { headers: { host: "localhost:3077" } })), String(raw)).toBeNull();
    }
  });

  it("allows no Origin, the tailnet https Origin, and the existing local http Origin", () => {
    vi.stubEnv(TAILNET_HOST_ENV, TAILNET);
    expect(isAllowedOrigin(null)).toBe(true);
    expect(isAllowedOrigin(`https://${TAILNET}`)).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:3077")).toBe(true);
  });

  it("rejects an http tailnet origin, a ported one, a foreign origin and a suffix trick", () => {
    vi.stubEnv(TAILNET_HOST_ENV, TAILNET);
    const bad = [`http://${TAILNET}`, `https://${TAILNET}:443`, `https://${TAILNET}.evil.test`, "https://other.tail0000.ts.net", "https://evil.test", null];
    for (const o of bad) if (o !== null) expect(isAllowedOrigin(o), o).toBe(false);
    // null Origin is always allowed (same-origin), so it is not in the rejected set; assert directly:
    expect(isAllowedOrigin(null)).toBe(true);
  });

  it("the tailnet https Origin is rejected when the env is unset", () => {
    vi.stubEnv(TAILNET_HOST_ENV, undefined);
    expect(isAllowedOrigin(`https://${TAILNET}`)).toBe(false);
  });

  it("a full Tailscale-shaped request passes guardRequest", () => {
    vi.stubEnv(TAILNET_HOST_ENV, TAILNET);
    const res = guardRequest(
      new Request(URL_, {
        headers: {
          host: TAILNET,
          "x-forwarded-host": TAILNET,
          "x-forwarded-proto": "https",
          "x-forwarded-for": "100.64.0.1",
          "tailscale-user-login": "x@y",
          "sec-fetch-site": "same-origin",
          origin: `https://${TAILNET}`,
        },
      }),
    );
    expect(res).toBeNull();
  });

  it("rejects spoofed X-Forwarded-Host and a cross-site Sec-Fetch-Site on the tailnet host", async () => {
    vi.stubEnv(TAILNET_HOST_ENV, TAILNET);
    const spoof1 = guardRequest(new Request(URL_, { headers: { host: "evil.test", "x-forwarded-host": TAILNET } }));
    expect(spoof1?.status).toBe(403);
    expect((await spoof1!.json()).error.code).toBe("FORBIDDEN_HOST");

    const spoof2 = guardRequest(new Request(URL_, { headers: { host: "127.0.0.1", "x-forwarded-host": TAILNET, "x-forwarded-proto": "https" } }));
    expect(spoof2?.status).toBe(403);
    expect((await spoof2!.json()).error.code).toBe("FORBIDDEN_HOST");

    const crossSite = guardRequest(new Request(URL_, { headers: { host: TAILNET, "sec-fetch-site": "cross-site" } }));
    expect(crossSite?.status).toBe(403);
    expect((await crossSite!.json()).error.code).toBe("FORBIDDEN_ORIGIN");
  });
});

describe("tailnet access across every route module", () => {
  const id = "BR-20261007-0001";
  const ctx = { params: Promise.resolve({ id }) };
  const calls: Array<[string, (req: Request, ctx: never) => Promise<Response>]> = [
    ["/api/agents", agentsRoute.GET as never],
    ["/api/approvals", approvalsRoute.GET as never],
    ["/api/governor", governorRoute.GET as never],
    ["/api/health", healthRoute.GET as never],
    ["/api/smoke", smokeRoute.GET as never],
    ["/api/tasks", tasksRoute.GET as never],
    [`/api/tasks/${id}`, detailRoute.GET as never],
    [`/api/tasks/${id}/events`, eventsRoute.GET as never],
    [`/api/tasks/${id}/findings`, findingsRoute.GET as never],
    ["/api/tokens", tokensRoute.GET as never],
    ["/api/version", versionRoute.GET as never],
  ];

  it("every route returns non-403 JSON for the configured tailnet Host, and 403 when the env is unset", async () => {
    const home = freshHome();
    mkdirs(home);
    vi.stubEnv(TAILNET_HOST_ENV, TAILNET);
    for (const [p, fn] of calls) {
      const good = await fn(new Request(`http://${TAILNET}${p}`, { headers: { host: TAILNET } }), ctx as never);
      expect([200, 404], p).toContain(good.status);
      expect(good.headers.get("content-type"), p).toContain("application/json");
      expect(good.headers.get("cache-control"), p).toBe("no-store");
    }
    vi.stubEnv(TAILNET_HOST_ENV, undefined);
    for (const [p, fn] of calls) {
      const bad = await fn(new Request(`http://${TAILNET}${p}`, { headers: { host: TAILNET } }), ctx as never);
      expect(bad.status, p).toBe(403);
    }
  });
});
