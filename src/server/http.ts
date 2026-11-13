import "server-only";
import type { ApiError, ApiErrorCode } from "@/lib/api-types";
import { sanitizeDeep } from "./sanitize";

/** The port is defined here and in package.json's scripts; the README says to change both. */
export const PORT = 3077;
export const ALLOWED_HOSTS: ReadonlySet<string> = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

/** The env var naming the single tailnet hostname (over Tailscale Serve) this dashboard also answers to. */
export const TAILNET_HOST_ENV = "BCC_TAILNET_HOST";

const TAILNET_HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ts\.net$/;

/** The configured tailnet host, normalized, or null when unset or not exactly <machine>.<tailnet>.ts.net. */
export function tailnetHost(raw: string | undefined = process.env[TAILNET_HOST_ENV]): string | null {
  if (raw === undefined) return null;
  const t = raw.trim().toLowerCase();
  return TAILNET_HOST_RE.test(t) ? t : null;
}

export function isAllowedHost(host: string | null): boolean {
  if (host === null) return false;
  const h = host.trim().toLowerCase();
  const t = tailnetHost();
  return ALLOWED_HOSTS.has(h) || (t !== null && h === t);
}

/** No Origin is fine (same-origin navigations and fetches); a present one must be http://<allowed host> (or https://<tailnet host>). */
export function isAllowedOrigin(origin: string | null): boolean {
  if (origin === null) return true;
  const o = origin.trim().toLowerCase();
  for (const h of ALLOWED_HOSTS) if (o === `http://${h}`) return true;
  const t = tailnetHost();
  if (t && o === `https://${t}`) return true;
  return false;
}

const MESSAGES: Record<ApiErrorCode, string> = {
  FORBIDDEN_HOST: "This dashboard only answers requests addressed to 127.0.0.1:3077, localhost:3077 or its configured tailnet host.",
  FORBIDDEN_ORIGIN: "Cross-site requests are refused.",
  BAD_TASK_ID: "Task ids look like BR-YYYYMMDD-NNNN.",
  BAD_LIMIT: "limit must be an integer from 1 to 1000.",
  TASK_NOT_FOUND: "No task with that id.",
  BAD_WINDOW: "window must be 7d or 30d.",
  INTERNAL: "The request could not be served.",
};

const BASE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

export function json(body: unknown, status = 200): Response {
  return Response.json(sanitizeDeep(body), { status, headers: BASE_HEADERS });
}

export function apiError(code: ApiErrorCode, status: number): Response {
  const body: ApiError = { error: { code, message: MESSAGES[code] } };
  return json(body, status);
}

/** 403 for a non-local Host, a foreign Origin or a cross-site fetch; null when the request may proceed. */
export function guardRequest(req: Request): Response | null {
  if (!isAllowedHost(req.headers.get("host"))) return apiError("FORBIDDEN_HOST", 403);
  if (!isAllowedOrigin(req.headers.get("origin"))) return apiError("FORBIDDEN_ORIGIN", 403);
  if (req.headers.get("sec-fetch-site")?.trim().toLowerCase() === "cross-site") return apiError("FORBIDDEN_ORIGIN", 403);
  return null;
}

type Handler<Ctx> = (req: Request, ctx: Ctx) => Promise<Response>;

/** Guards the request, runs the handler, and turns any thrown error into a path-free 500. */
export function withApi<Ctx>(fn: Handler<Ctx>): Handler<Ctx> {
  return async (req, ctx) => {
    const refused = guardRequest(req);
    if (refused) return refused;
    try {
      return await fn(req, ctx);
    } catch (err) {
      const name = err instanceof Error ? err.name : typeof err;
      console.error(`[api] INTERNAL ${name}`);
      return apiError("INTERNAL", 500);
    }
  };
}

/** The `limit` query parameter as an integer in [1, max], or null when absent, or undefined when invalid. */
export function parseLimit(url: string, dflt: number, max: number): number | null | undefined {
  const raw = new URL(url).searchParams.get("limit");
  if (raw === null) return dflt;
  if (!/^[0-9]{1,5}$/.test(raw)) return undefined;
  const n = Number(raw);
  if (n < 1 || n > max) return undefined;
  return n;
}
