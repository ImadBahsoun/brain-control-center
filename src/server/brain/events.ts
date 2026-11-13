import "server-only";
import { createHash } from "node:crypto";
import type { ActivityItem, ActivityTone, LogIntegrity } from "@/lib/api-types";
import { sanitizedPrefix, sanitizeString } from "../sanitize";
import { asInt, asObj, asStr, asStrArr, asStrRecord, type JsonObj } from "./jsonish";

/**
 * events.jsonl parsing (a mirror of brain-state's read_log/_parse_line without the canonical-form
 * check, so the result is a "chain check", not a full verify) and the event → activity-line mapping.
 * The `session` field of an event is dropped at parse time and never kept.
 */

export const EVENT_TYPES = [
  "TASK_CREATED",
  "TASK_RESUMED",
  "LOG_REPAIRED",
  "TASK_CLASSIFIED",
  "PLAN_CREATED",
  "PLAN_APPROVED",
  "AGENT_STARTED",
  "AGENT_COMPLETED",
  "HANDOFF_CREATED",
  "SNAPSHOT_TAKEN",
  "VALIDATION_STARTED",
  "VALIDATION_COMPLETED",
  "FINDING_CREATED",
  "FINDING_UPDATED",
  "APPROVAL_REQUESTED",
  "APPROVAL_GRANTED",
  "APPROVAL_REJECTED",
  "FIX_ROUND_STARTED",
  "FIX_ROUND_COMPLETED",
  "READY_REACHED",
  "BLOCKED",
  "TASK_COMPLETED",
  "STATE_CHANGED",
  "NOTE",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
const KNOWN_TYPES = new Set<string>(EVENT_TYPES);

export interface BrainEvent {
  seq: number;
  eventId: string;
  type: EventType;
  ts: string;
  actor: string | null;
  correlationId: string | null;
  state: string | null;
  round: number | null;
  next: string | null;
  payload: JsonObj;
}

export interface ParsedLog {
  events: BrainEvent[];
  integrity: LogIntegrity;
  corruptLine?: number;
  corruptReason?: string;
  tornBytes: number;
  lastSeq: number;
  lastHash: string;
  /** sha256 of each accepted raw line, by seq - 1 (what brain-state stores as last_hash). */
  hashes: string[];
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

function splitLines(buf: Buffer): { lines: Buffer[]; torn: Buffer | null } {
  const lines: Buffer[] = [];
  let start = 0;
  for (;;) {
    const nl = buf.indexOf(0x0a, start);
    if (nl < 0) break;
    lines.push(buf.subarray(start, nl));
    start = nl + 1;
  }
  const torn = start < buf.length ? buf.subarray(start) : null;
  return { lines, torn };
}

type LineResult = { ev: BrainEvent } | { reason: string };

function parseLine(raw: Buffer, i: number, prev: string, taskId: string): LineResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8.decode(raw));
  } catch {
    return { reason: "not valid JSON" };
  }
  const o = asObj(parsed);
  if (!o || o.v !== 1) return { reason: "not an event envelope" };
  if (o.seq !== i) return { reason: `seq ${String(o.seq)}, expected ${i}` };
  if (o.prev !== prev) return { reason: `hash chain broken (prev does not match line ${i - 1})` };
  if (o.task_id !== taskId) return { reason: "task_id mismatch" };
  const type = asStr(o.type);
  if (type === null || !KNOWN_TYPES.has(type)) return { reason: `unknown event type ${String(o.type)}` };
  return {
    ev: {
      seq: i,
      eventId: asStr(o.event_id) ?? "",
      type: type as EventType,
      ts: asStr(o.ts) ?? "",
      actor: asStr(o.actor),
      correlationId: asStr(o.correlation_id),
      state: asStr(o.state),
      round: asInt(o.round),
      next: asStr(o.next),
      payload: asObj(o.payload) ?? {},
    },
  };
}

/** The whole log: the valid prefix, its integrity label, and the seq/hash of the last accepted line. */
export function parseLog(buf: Buffer, taskId: string): ParsedLog {
  const { lines, torn } = splitLines(buf);
  const events: BrainEvent[] = [];
  const hashes: string[] = [];
  let prev = "";
  let corrupt: { line: number; reason: string } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] as Buffer;
    const r = parseLine(raw, i + 1, prev, taskId);
    if ("reason" in r) {
      corrupt = { line: i + 1, reason: r.reason };
      break;
    }
    events.push(r.ev);
    prev = sha256Hex(raw);
    hashes.push(prev);
  }
  let tornBytes = 0;
  if (torn && !corrupt) {
    // a complete next event that only lacks its final newline has landed: keep it
    const r = parseLine(torn, events.length + 1, prev, taskId);
    if ("ev" in r) {
      events.push(r.ev);
      prev = sha256Hex(torn);
      hashes.push(prev);
    } else {
      tornBytes = torn.length;
    }
  } else if (torn) {
    tornBytes = torn.length;
  }
  let integrity: LogIntegrity;
  if (corrupt) integrity = "corrupt";
  else if (events.length === 0 || events[0]?.type !== "TASK_CREATED") integrity = "incomplete";
  else if (tornBytes > 0) integrity = "torn_tail";
  else integrity = "ok";
  return {
    events,
    integrity,
    ...(corrupt ? { corruptLine: corrupt.line, corruptReason: corrupt.reason } : {}),
    tornBytes,
    lastSeq: events.length,
    lastHash: prev,
    hashes,
  };
}

export interface TailInfo {
  lastSeq: number | null;
  lastHash: string | null;
  tornBytes: number;
}

/**
 * The last complete line's seq and hash from a tail read starting at `offset`. The chain is not walked
 * (only the final torn chunk is checked against the line before it).
 */
export function parseTail(buf: Buffer, offset: number, taskId: string): TailInfo {
  let data = buf;
  if (offset > 0) {
    const nl = data.indexOf(0x0a);
    if (nl < 0) return { lastSeq: null, lastHash: null, tornBytes: data.length };
    data = data.subarray(nl + 1);
  }
  const { lines, torn } = splitLines(data);
  let last: { seq: number; hash: string } | null = null;
  for (const raw of lines) {
    const seq = lineSeq(raw, taskId);
    if (seq !== null) last = { seq, hash: sha256Hex(raw) };
  }
  let tornBytes = 0;
  if (torn) {
    const r = parseLine(torn, (last?.seq ?? 0) + 1, last?.hash ?? "", taskId);
    if ("ev" in r && last !== null) last = { seq: r.ev.seq, hash: sha256Hex(torn) };
    else tornBytes = torn.length;
  }
  return { lastSeq: last?.seq ?? null, lastHash: last?.hash ?? null, tornBytes };
}

function lineSeq(raw: Buffer, taskId: string): number | null {
  try {
    const o = asObj(JSON.parse(utf8.decode(raw)));
    if (!o || o.v !== 1 || o.task_id !== taskId) return null;
    return asInt(o.seq);
  } catch {
    return null;
  }
}

// ---- activity lines -------------------------------------------------------------------------------

const ROLE_LABELS: Record<string, string> = {
  planner: "Planner",
  developer: "Developer",
  qa: "QA",
  reviewer: "Reviewer",
  "security-reviewer": "Security Reviewer",
};

/**
 * Parses a brain-state timestamp payload field with brain-state's own semantics (~/.claude/brain/brain-state
 * parse_ts): a trailing `Z` or an explicit `+HH:MM`/`-HH:MM` offset is honoured as given; a naive timestamp
 * (neither) is UTC, never local time — `Date.parse` alone would read it as the server's local zone, which
 * would misjudge expiry by the local UTC offset. Unparseable input returns null and is dropped entirely,
 * never surfaced as a guess. Returns a normalized ISO string (always `Z`-suffixed) so the client can compare
 * it against another ISO timestamp without redoing this.
 */
function parseBrainStateTs(raw: string): string | null {
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/.test(raw);
  const ms = Date.parse(hasOffset ? raw : `${raw}Z`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

export interface ActivityContext {
  aliasToFindingId: ReadonlyMap<string, string>;
  unitsByRole: ReadonlyMap<string, number> | null;
}

const DENIED_RE = /^\[governor\] DENIED ([A-Z_]{1,40}) ([a-z][a-z0-9-]{0,39})\b/;
const SOFT_RE = /^\[governor\] SOFT_LIMIT accepted/;

function str(p: JsonObj, k: string): string {
  return asStr(p[k]) ?? "";
}

/** A detail line: Brain text is only ever shortened through sanitizeString (redact first, then cut). */
function detailOf(s: string, max: number): string | undefined {
  return sanitizeString(s, max) || undefined;
}

export function toActivity(ev: BrainEvent, prevState: string | null, ctx: ActivityContext): ActivityItem {
  const p = ev.payload;
  let tone: ActivityTone = "info";
  let text: string;
  let detail: string | undefined;
  let role: string | undefined;
  let expires: string | undefined;

  switch (ev.type) {
    case "TASK_CREATED":
      text = `Task created (${str(p, "class") || "unclassified"})`;
      break;
    case "TASK_CLASSIFIED":
      text = `Classified ${str(p, "class")}`;
      break;
    case "TASK_RESUMED":
      text = "Task resumed by another session";
      break;
    case "LOG_REPAIRED":
      tone = "warn";
      text = `Log repaired: torn tail quarantined (${asInt(p.bytes) ?? 0} B)`;
      break;
    case "AGENT_STARTED": {
      role = str(p, "agent");
      const label = roleLabel(role);
      const units = ctx.unitsByRole?.get(role);
      const kind = str(p, "kind") || "initial";
      const r = ev.round ?? 0;
      text =
        units !== undefined
          ? `${label} reserved ${units} units and started (${kind}, round ${r})`
          : `${label} started (${kind}, round ${r})`;
      if (str(p, "rerun_reason")) text += " · rerun";
      break;
    }
    case "AGENT_COMPLETED": {
      role = str(p, "agent");
      const label = roleLabel(role);
      const verdict = str(p, "status_or_verdict");
      if (verdict === "not-launched") text = `${label} not launched (units refunded)`;
      else if (verdict === "lost") {
        tone = "warn";
        text = `${label} lost (units consumed)`;
      } else {
        text = `${label} completed: ${verdict}`;
        if (/changes required|fail|blocked/i.test(verdict)) tone = "warn";
        else if (/pass|ready|done|approved/i.test(verdict)) tone = "success";
      }
      break;
    }
    case "PLAN_CREATED":
      text = `Plan created by ${str(p, "author") || "unknown"}`;
      break;
    case "PLAN_APPROVED":
      tone = "success";
      text = "Plan approved";
      break;
    case "APPROVAL_REQUESTED": {
      text = `Approval requested (${str(p, "kind")})`;
      detail = detailOf(str(p, "what"), 200);
      const rawExpires = asStr(p.expires);
      expires = rawExpires !== null ? (parseBrainStateTs(rawExpires) ?? undefined) : undefined;
      break;
    }
    case "APPROVAL_GRANTED":
      tone = "success";
      text = "Approval granted";
      break;
    case "APPROVAL_REJECTED":
      tone = "warn";
      text = "Approval rejected";
      break;
    case "SNAPSHOT_TAKEN":
      text = `Snapshot ${str(p, "label")} ${sanitizedPrefix(str(p, "tree"), 10)}`;
      break;
    case "VALIDATION_STARTED":
      text = `Validation started: ${asStrArr(p.agents).join(", ")}`;
      break;
    case "VALIDATION_COMPLETED": {
      const decision = str(p, "decision");
      const agents = Object.entries(asStrRecord(p.agents))
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      tone = decision === "PASS" ? "success" : "warn";
      text = `Validation ${decision}: ${agents}`;
      break;
    }
    case "FINDING_CREATED": {
      const alias = str(p, "alias");
      const id = ctx.aliasToFindingId.get(alias) ?? alias;
      tone = str(p, "severity") === "BLOCKER" || str(p, "severity") === "MAJOR" ? "warn" : "info";
      text = `Finding ${id} created (${str(p, "severity")}, ${str(p, "source")}): ${str(p, "title")}`;
      break;
    }
    case "FINDING_UPDATED": {
      const ref = str(p, "id") || str(p, "alias");
      const id = ctx.aliasToFindingId.get(ref) ?? ref;
      const status = str(p, "status");
      tone = status === "FIXED" || status === "REVALIDATED" || status === "CLOSED" ? "success" : "info";
      text = `Finding ${id} → ${status}`;
      detail = detailOf(str(p, "reason"), 500);
      break;
    }
    case "FIX_ROUND_STARTED":
      text = `Fix round ${asInt(p.round) ?? ev.round ?? 0} started (${asStrArr(p.findings).length} findings)`;
      break;
    case "FIX_ROUND_COMPLETED":
      text = `Fix round ${asInt(p.round) ?? ev.round ?? 0} completed`;
      break;
    case "READY_REACHED":
      tone = "success";
      text = "READY reached";
      break;
    case "BLOCKED":
      tone = "error";
      text = "Blocked";
      detail = detailOf(str(p, "reason"), 500);
      break;
    case "TASK_COMPLETED":
      tone = str(p, "outcome") === "COMPLETE" ? "success" : "warn";
      text = `Task ${str(p, "outcome")}`;
      break;
    case "STATE_CHANGED":
      text = `State → ${ev.state ?? "?"}`;
      break;
    case "HANDOFF_CREATED":
      text = `Handoff to ${str(p, "to")}`;
      break;
    case "NOTE": {
      const note = str(p, "text");
      const denied = DENIED_RE.exec(note);
      if (denied) {
        tone = "error";
        role = denied[2];
        text = `Governor denied ${roleLabel(denied[2] ?? "")}: ${denied[1]}`;
      } else if (SOFT_RE.test(note)) {
        tone = "warn";
        text = "Governor soft limit accepted";
      } else {
        text = "Note";
        detail = detailOf(note, 500);
      }
      break;
    }
  }

  const item: ActivityItem = { seq: ev.seq, ts: ev.ts, type: ev.type, state: ev.state, round: ev.round, tone, text };
  if (role) item.role = role;
  if (detail) item.detail = detail;
  if (expires) item.expires = expires;
  if (ev.state && ev.state !== prevState) item.stateChange = { from: prevState, to: ev.state };
  return item;
}

export function activityFromEvents(events: readonly BrainEvent[], ctx: ActivityContext): ActivityItem[] {
  const out: ActivityItem[] = [];
  let prevState: string | null = null;
  for (const ev of events) {
    out.push(toActivity(ev, prevState, ctx));
    if (ev.state) prevState = ev.state;
  }
  return out;
}
