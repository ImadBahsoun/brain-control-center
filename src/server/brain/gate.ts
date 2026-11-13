import "server-only";
import path from "node:path";
import type { ApprovalStatus, GateStatus, GateSummary } from "@/lib/api-types";
import { sanitizedPrefix, sanitizeString } from "../sanitize";
import { asArr, asNum, asObj, asStr, parseJson, toIso, type JsonObj } from "./jsonish";
import type { BrainRoots } from "./roots";
import { CAPS, checkDir, FILE_NAMES, readCapped, readTail, realDir } from "./safe-fs";

/**
 * brain-gate state and audit as safe aggregates only. The `requests` object is keyed by live approval
 * codes: only its values are iterated, and from each value only `expires`, `consumed_at`, `revoked_at`
 * and the action names are looked at. Sessions, agent ids, codes, commands, cwd, inputs, envs, display, task,
 * brain_line and approval_uuid are never read into any output. `ready` is ignored.
 */

export const ACTION_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export const MAX_ACTIONS = 20;

const AUDIT_EVENTS = new Set<string>([
  "DENY_GATED",
  "APPROVED",
  "GRANT_CONSUMED",
  "GRANT_STALE",
  "APPROVAL_REFUSED",
  "EXPIRED",
  "DISPOSABLE_EXEMPT",
  "SCRATCH_EXEMPT",
  "TAMPER_DENIED",
  "CODE_INJECTION_DENIED",
  "AGENT_CONTROL_DENIED",
  "FAIL_CLOSED",
  "VALIDATION_RECORDED",
  "VALIDATION_IGNORED",
  "READY_PASS",
  "READY_BLOCK",
  "READY_VIOLATION",
  "READY_UNCHECKED",
  "READY_ERROR",
  "CONFIG_CHANGE_BLOCKED",
]);

export type GateStateView = Pick<GateSummary, "requests" | "latestValidations">;

function emptyRequests(): GateSummary["requests"] {
  return { pending: 0, expired: 0, consumed: 0, revoked: 0, pendingByAction: {} };
}

/** Python truthiness of a JSON value, as brain-gate's `r.get(...)` tests see it. */
function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

/**
 * One gate request's status, mirroring brain-gate exactly (`pending_codes` and the retry path): consumed
 * first; then `revoked_at` set at or before `expires` is a stale grant (revoked), and after it is an expiry
 * found on retry (expired); otherwise pending while `expires >= now` (a missing or non-numeric `expires`
 * counts as 0). A non-numeric `revoked_at` that is still truthy cannot be compared and counts as revoked.
 */
export function gateRequestStatus(r: JsonObj, nowMs: number): ApprovalStatus {
  if (truthy(r.consumed_at)) return "consumed";
  const expires = asNum(r.expires) ?? 0;
  if (truthy(r.revoked_at)) {
    const revokedAt = asNum(r.revoked_at);
    return revokedAt !== null && revokedAt > expires ? "expired" : "revoked";
  }
  return expires * 1000 >= nowMs ? "pending" : "expired";
}

export function parseGateState(buf: Buffer, nowMs: number): { status: "ok"; view: GateStateView } | { status: "invalid" } {
  const root = asObj(parseJson(buf));
  if (!root) return { status: "invalid" };
  const requests = emptyRequests();
  // a Map, not an object: action names such as "constructor" must never hit an inherited property
  const byAction = new Map<string, number>();
  const reqs = asObj(root.requests);
  if (reqs) {
    for (const value of Object.values(reqs)) {
      const r = asObj(value);
      if (!r) continue;
      const status = gateRequestStatus(r, nowMs);
      requests[status]++;
      if (status === "pending") {
        for (const a of asArr(r.actions)) {
          if (typeof a !== "string" || !ACTION_RE.test(a)) continue;
          if (!byAction.has(a) && byAction.size >= MAX_ACTIONS) continue;
          byAction.set(a, (byAction.get(a) ?? 0) + 1);
        }
      }
    }
  }
  requests.pendingByAction = Object.fromEntries(byAction);
  const validations = asArr(root.validations)
    .map(asObj)
    .filter((v): v is NonNullable<typeof v> => v !== null)
    .map((v) => ({
      kind: sanitizeString(asStr(v.kind) ?? "", 16),
      verdict: sanitizeString(asStr(v.verdict) ?? "", 40),
      ts: toIso(v.ts),
      tsNum: asNum(v.ts) ?? 0,
      repo: asStr(v.repo),
      to: asStr(v.to) !== null ? sanitizedPrefix(asStr(v.to) ?? "", 12) : null,
    }))
    .sort((a, b) => b.tsNum - a.tsNum)
    .slice(0, 5)
    .map(({ kind, verdict, ts, repo, to }) => ({ kind, verdict, ts, repo, to }));
  return { status: "ok", view: { requests, latestValidations: validations } };
}

const WINDOW_MS = 24 * 60 * 60 * 1000;

export function parseAudit(buf: Buffer, partial: boolean, nowMs: number): GateSummary["audit"] {
  const countsByEvent: Record<string, number> = {};
  let lastFailClosedAt: string | null = null;
  let lastFail = -Infinity;
  const text = buf.toString("utf8");
  const lines = text.split("\n");
  // with a partial tail the first chunk may be half a line; JSON.parse rejects it and it is skipped
  for (const line of lines) {
    if (!line) continue;
    let o;
    try {
      o = asObj(JSON.parse(line));
    } catch {
      continue;
    }
    if (!o) continue;
    const ts = Date.parse(asStr(o.ts) ?? "");
    if (Number.isNaN(ts) || nowMs - ts > WINDOW_MS) continue;
    const ev = asStr(o.event) ?? "";
    const key = AUDIT_EVENTS.has(ev) ? ev : "OTHER";
    countsByEvent[key] = (countsByEvent[key] ?? 0) + 1;
    if (ev === "FAIL_CLOSED" && ts > lastFail) {
      lastFail = ts;
      lastFailClosedAt = new Date(ts).toISOString();
    }
  }
  return { status: "ok", window: "24h", countsByEvent, lastFailClosedAt, partial };
}

export type GateStateRead = { status: "ok"; data: Buffer } | { status: Exclude<GateStatus, "ok">; dirOk: boolean };

/**
 * The gate's state.json through the capped, no-follow reader. `dirOk` is false when the gate directory
 * itself is missing or unsafe (the audit log is then not read either). A read error counts as invalid.
 */
export async function readGateStateFile(roots: BrainRoots): Promise<GateStateRead> {
  const realClaude = await realDir(roots.claudeDir);
  if (realClaude === null) return { status: "missing", dirOk: false };
  const dir = await checkDir(roots.gateDir, path.join(realClaude, "state", "brain-gate"));
  if (dir.status !== "ok") return { status: dir.status, dirOk: false };
  const st = await readCapped(roots.gateDir, FILE_NAMES.state, CAPS.gateState);
  if (st.status === "ok") return { status: "ok", data: st.data };
  return { status: st.status === "error" ? "invalid" : st.status, dirOk: true };
}

export async function gateSummary(roots: BrainRoots, nowMs: number): Promise<GateSummary> {
  const base: GateSummary = {
    status: "missing",
    requests: emptyRequests(),
    latestValidations: [],
    audit: { status: "missing", window: "24h", countsByEvent: {}, lastFailClosedAt: null, partial: false },
  };
  const st = await readGateStateFile(roots);
  if (st.status !== "ok" && !st.dirOk) {
    return st.status === "unsafe" ? { ...base, status: "unsafe", audit: { ...base.audit, status: "unsafe" } } : base;
  }
  if (st.status === "ok") {
    const parsed = parseGateState(st.data, nowMs);
    if (parsed.status === "ok") {
      base.status = "ok";
      base.requests = parsed.view.requests;
      base.latestValidations = parsed.view.latestValidations;
    } else base.status = "invalid";
  } else base.status = st.status;

  const audit = await readTail(roots.gateDir, FILE_NAMES.audit, CAPS.auditTail);
  if (audit.status === "ok") base.audit = parseAudit(audit.data, audit.partial, nowMs);
  else if (audit.status === "unsafe") base.audit.status = "unsafe";
  else if (audit.status === "error") base.audit.status = "error";
  return base;
}
