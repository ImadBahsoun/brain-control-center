import "server-only";
import path from "node:path";
import type { LogIntegrity } from "@/lib/api-types";
import { parseLog } from "../brain/events";
import { asObj, asStr } from "../brain/jsonish";
import type { BrainRoots } from "../brain/roots";
import { CAPS, FILE_NAMES, readCapped } from "../brain/safe-fs";

/**
 * Session and agent_id extraction for mission attribution. `parseLog` (events.ts) drops the `session`
 * field on purpose and is never changed here; this module re-reads the same bytes with its own minimal,
 * server-internal pass, kept separate so the dashboard's other views are unaffected.
 */

export interface MissionEventMini {
  ts: string;
  type: string;
  session: string;
  agent: string | null;
  agentId: string | null;
}

export interface MissionLog {
  taskId: string;
  integrity: LogIntegrity;
  /** From the chain-validated valid prefix only: trustworthy enough to build windows and agent links from. */
  events: MissionEventMini[];
  /** Every session mentioned anywhere in the raw file (including past any corruption), untrusted beyond
   *  "this session touched this mission at some point" — never used to build a window. */
  allSessionsSeen: ReadonlySet<string>;
  /** false when the log could not supply even one valid event (missing, unsafe, too large, or corrupt at line 1). */
  usable: boolean;
}

function splitRawLines(buf: Buffer): string[] {
  const text = buf.toString("utf8");
  return text.length === 0 ? [] : text.split("\n").filter((l) => l.length > 0);
}

function tolerantSession(raw: string): string | null {
  try {
    const o = asObj(JSON.parse(raw));
    const s = o ? asStr(o.session) : null;
    return s && /^[0-9a-f-]{8,64}$/.test(s) ? s : null;
  } catch {
    return null;
  }
}

function extractMini(lines: string[], taskId: string): MissionEventMini[] {
  const out: MissionEventMini[] = [];
  for (const raw of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      break;
    }
    const o = asObj(parsed);
    if (!o || o.task_id !== taskId) break;
    const payload = asObj(o.payload) ?? {};
    out.push({
      ts: asStr(o.ts) ?? "",
      type: asStr(o.type) ?? "",
      session: asStr(o.session) ?? "",
      agent: asStr(payload.agent),
      agentId: asStr(payload.agent_id),
    });
  }
  return out;
}

function unreadableToIntegrity(status: "missing" | "unsafe" | "too_large" | "error"): LogIntegrity {
  return status === "error" ? "unsafe" : status;
}

export async function loadMissionLog(roots: BrainRoots, taskId: string): Promise<MissionLog> {
  const dir = path.join(roots.tasksDir, taskId);
  const r = await readCapped(dir, FILE_NAMES.events, CAPS.eventsFull);
  if (r.status !== "ok") {
    return { taskId, integrity: unreadableToIntegrity(r.status), events: [], allSessionsSeen: new Set(), usable: false };
  }
  const parsed = parseLog(r.data, taskId);
  const lines = splitRawLines(r.data);
  const events = extractMini(lines.slice(0, parsed.events.length), taskId);
  const allSessionsSeen = new Set<string>();
  for (const raw of lines) {
    const s = tolerantSession(raw);
    if (s) allSessionsSeen.add(s);
  }
  return { taskId, integrity: parsed.integrity, events, allSessionsSeen, usable: events.length > 0 };
}
