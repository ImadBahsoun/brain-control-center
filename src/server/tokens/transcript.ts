import "server-only";
import { normalizeModel } from "./pricing";

/**
 * The per-line allowlist extractor. Everything not on the allowlist is dropped the moment a line is
 * parsed: no transcript free text, session id, cwd, git branch or project name is ever kept, even in
 * memory. Only numbers, the fixed labels below, and (for in-memory dedup only) message ids survive.
 */

export interface CallRecord {
  /** message.id: kept only for in-process dedup, never put in a response. */
  id: string;
  ts: string;
  model: string;
  fast: boolean;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheWriteUnsplit: number;
  webSearchRequests: number;
}

export type AttachmentType =
  | "deferred_tools_delta"
  | "skill_listing"
  | "mcp_instructions_delta"
  | "queued_command"
  | "prompt_snapshot"
  | "total_tokens_reminder"
  | "task_notification"
  | "other";

const ATTACHMENT_TYPES: ReadonlySet<string> = new Set<AttachmentType>([
  "deferred_tools_delta",
  "skill_listing",
  "mcp_instructions_delta",
  "queued_command",
  "prompt_snapshot",
  "total_tokens_reminder",
  "task_notification",
]);

export interface AttachmentRecord {
  type: AttachmentType;
  bytes: number;
  ts: string;
}

export const INSTRUCTION_DOCS = [
  "orchestration/SKILL.md",
  "orchestration/state.md",
  "orchestration/governor.md",
  "orchestration/enforcement.md",
  "orchestration/other.md",
  "skill:orchestration",
] as const;
export type InstructionDoc = (typeof INSTRUCTION_DOCS)[number];

export interface InstructionReadRecord {
  doc: InstructionDoc;
  resultChars: number;
  ts: string;
}

export interface LengthRecord {
  chars: number;
  ts: string;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function matchInstructionDoc(input: unknown): InstructionDoc | null {
  const hay = JSON.stringify(input ?? {});
  if (!/orchestration/.test(hay)) return null;
  if (/SKILL\.md/.test(hay)) return "orchestration/SKILL.md";
  if (/state\.md/.test(hay)) return "orchestration/state.md";
  if (/governor\.md/.test(hay)) return "orchestration/governor.md";
  if (/enforcement\.md/.test(hay)) return "orchestration/enforcement.md";
  return "orchestration/other.md";
}

function resultLength(toolResultContent: unknown): number {
  if (typeof toolResultContent === "string") return toolResultContent.length;
  if (Array.isArray(toolResultContent)) {
    let n = 0;
    for (const block of toolResultContent) {
      if (isObj(block) && typeof block.text === "string") n += block.text.length;
    }
    return n;
  }
  return 0;
}

const HANDBACK_MARKER_RE = /SubagentHandback|\[Agent report|hand[- ]?back/i;

/**
 * Dedupe policy (A1, binding): within one file, the LAST occurrence of a given message.id wins. A single
 * named constant so later verification (plan step 9, not this change) can confirm it against the real
 * store and so the fixture tests pin exactly this behaviour.
 */
export const DEDUPE_POLICY = "last-occurrence-wins" as const;

/** R11: the raw `timestamp` field is never trusted as-is (it would otherwise reach `oldestCallAt`
 *  unvalidated); only a strict ISO-8601 UTC instant is accepted, fractional seconds optional. */
const STRICT_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

function validTs(raw: unknown): string | null {
  return typeof raw === "string" && STRICT_ISO_RE.test(raw) ? raw : null;
}

/** S2: the default cap on records retained by one extractor, overridable only for tests (see scan.ts). */
export const DEFAULT_MAX_RECORDS_PER_FILE = 200_000;

/**
 * Stateful, resumable per-file extraction: a tool_use (Read/Bash/Skill against an instruction doc) is
 * held as "pending" by its tool_use id until the matching tool_result line supplies a length, at which
 * point it becomes one InstructionReadRecord; a call is kept in a map by message.id, so re-processing the
 * same line (or appending a duplicate) replaces it rather than double-counting, per DEDUPE_POLICY.
 * Nothing about any id is ever exposed outside this object. One instance is reused across a resumed scan
 * (the memo keeps it), so pending reads survive a scan that stops mid-file and resumes later.
 *
 * S2: total retained records (calls + attachments + instruction reads + packets + hand-backs + hand-back
 * messages) are capped at `maxRecords`; once reached, further NEW records are dropped and counted in
 * `recordsOverflowed` (updating an existing call by message.id is not new growth, so it is never blocked
 * by the cap). This bounds one file's own memory while it is still streaming, independent of the
 * inter-file memo caps in scan.ts.
 */
export class LineExtractor {
  callsById = new Map<string, CallRecord>();
  attachments: AttachmentRecord[] = [];
  instructionReads: InstructionReadRecord[] = [];
  packets: LengthRecord[] = [];
  handbacks: LengthRecord[] = [];
  handbackMessagesToBrain: LengthRecord[] = [];
  oversizeAssistantLines = 0;
  linesUnparseable = 0;
  /** A message.id seen more than once within this file (DEDUPE_POLICY applies; the later one is kept). */
  duplicateWithinFile = 0;
  /** R11: a RETAINED record (not just a parsed line) whose `timestamp` failed strict validation or was
   *  absent; its ts is "" and it is never used for windowing. Only records actually kept count here. */
  invalidTimestamps = 0;
  /** R11: of the above, how many were calls — a call with no usable ts never appears in any window, so
   *  the scan is reported incomplete (scan.ts), distinct from a merely cosmetic invalid attachment ts. */
  invalidTimestampCalls = 0;
  /** S2: new records dropped once `maxRecords` was reached. */
  recordsOverflowed = 0;
  private pendingReads = new Map<string, InstructionDoc>();

  constructor(private readonly maxRecords: number = DEFAULT_MAX_RECORDS_PER_FILE) {}

  get calls(): CallRecord[] {
    return Array.from(this.callsById.values());
  }

  private totalRecords(): number {
    // S2/S4: pendingReads counts too — an unanswered Read/Bash/Skill tool_use id is retained state,
    // not a free lookup key, and must share the same cap as every other record kind.
    return (
      this.callsById.size + this.attachments.length + this.instructionReads.length + this.packets.length + this.handbacks.length + this.handbackMessagesToBrain.length + this.pendingReads.size
    );
  }

  /** True when a brand-new record (not an update to an existing call id) may still be added. */
  private canGrow(): boolean {
    if (this.totalRecords() < this.maxRecords) return true;
    this.recordsOverflowed++;
    return false;
  }

  /** Called by streamLines for a line discarded for being over the size cap. */
  onOversizeLine(prefix: Buffer): void {
    if (prefix.includes('"type":"assistant"')) this.oversizeAssistantLines++;
  }

  process(raw: Buffer): void {
    const text = raw.toString("utf8");
    // a cheap prefilter: only lines that could plausibly matter are worth a JSON.parse
    if (!/"type":"(assistant|attachment|user)"|"isMeta":true/.test(text)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.linesUnparseable++;
      return;
    }
    const o = isObj(parsed) ? parsed : null;
    if (!o) return;
    const type = typeof o.type === "string" ? o.type : null;
    const ts = validTs(o.timestamp);
    // R11(b): counted only when a record is actually retained below, never for every parsed line.

    if (type === "assistant") {
      this.processAssistant(o, ts);
    } else if (type === "attachment") {
      this.processAttachment(o, text.length, ts);
    } else if (type === "user") {
      this.processUser(o, ts);
    }
  }

  /** R11: increments invalidTimestamps (and invalidTimestampCalls, for a call) only for a record that is actually retained. */
  private noteRetained(ts: string | null, isCall: boolean): string {
    if (ts === null) {
      this.invalidTimestamps++;
      if (isCall) this.invalidTimestampCalls++;
      return "";
    }
    return ts;
  }

  private processAssistant(o: Record<string, unknown>, ts: string | null): void {
    const message = isObj(o.message) ? o.message : null;
    if (message) {
      const id = typeof message.id === "string" ? message.id : "";
      const model = normalizeModel(message.model);
      const usage = isObj(message.usage) ? message.usage : {};
      const cacheCreation = isObj(usage.cache_creation) ? usage.cache_creation : null;
      const write5m = cacheCreation ? num(cacheCreation.ephemeral_5m_input_tokens) : 0;
      const write1h = cacheCreation ? num(cacheCreation.ephemeral_1h_input_tokens) : 0;
      const totalWrite = num(usage.cache_creation_input_tokens);
      const writeUnsplit = cacheCreation ? 0 : totalWrite;
      const serverTools = isObj(usage.server_tool_use) ? usage.server_tool_use : null;
      if (id) {
        const isNew = !this.callsById.has(id);
        if (!isNew) this.duplicateWithinFile++;
        // a brand-new call id is subject to the per-file cap; replacing an existing one never is
        if (isNew ? this.canGrow() : true) {
          this.callsById.set(id, {
            id,
            ts: this.noteRetained(ts, true),
            model,
            fast: usage.speed === "fast",
            input: num(usage.input_tokens),
            output: num(usage.output_tokens),
            cacheRead: num(usage.cache_read_input_tokens),
            cacheWrite5m: write5m,
            cacheWrite1h: write1h,
            cacheWriteUnsplit: writeUnsplit,
            webSearchRequests: serverTools ? num(serverTools.web_search_requests) : 0,
          });
        }
      }
    }
    const content = Array.isArray(message?.content) ? message!.content : [];
    for (const block of content) {
      if (!isObj(block) || block.type !== "tool_use") continue;
      const name = typeof block.name === "string" ? block.name : "";
      const toolUseId = typeof block.id === "string" ? block.id : "";
      const input = block.input;
      if (name === "Read" || name === "Bash" || name === "Skill") {
        const doc = matchInstructionDoc(input);
        // S2/S4: a brand-new pending id is subject to the same per-file cap as every other record
        if (doc && toolUseId && !this.pendingReads.has(toolUseId) && this.canGrow()) this.pendingReads.set(toolUseId, doc);
      } else if (name === "Agent" || name === "Task") {
        const prompt = isObj(input) ? input.prompt : undefined;
        if (typeof prompt === "string" && this.canGrow()) this.packets.push({ chars: prompt.length, ts: this.noteRetained(ts, false) });
      } else if (name === "SubagentHandback") {
        const msg = isObj(input) ? input.message : undefined;
        if (typeof msg === "string" && this.canGrow()) this.handbacks.push({ chars: msg.length, ts: this.noteRetained(ts, false) });
      }
    }
  }

  private processAttachment(o: Record<string, unknown>, rawLineLength: number, ts: string | null): void {
    if (!this.canGrow()) return;
    const attachment = isObj(o.attachment) ? o.attachment : o;
    const rawType = typeof attachment.type === "string" ? attachment.type : "other";
    const type = (ATTACHMENT_TYPES.has(rawType) ? rawType : "other") as AttachmentType;
    this.attachments.push({ type, bytes: rawLineLength, ts: this.noteRetained(ts, false) });
  }

  private processUser(o: Record<string, unknown>, ts: string | null): void {
    const message = isObj(o.message) ? o.message : null;
    const content = Array.isArray(message?.content) ? message!.content : [];
    for (const block of content) {
      if (!isObj(block)) continue;
      if (block.type === "tool_result") {
        const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
        const doc = toolUseId ? this.pendingReads.get(toolUseId) : undefined;
        if (doc) {
          // S2/S4: delete the pending entry unconditionally — even when the cap refuses the resulting
          // instructionReads record, the pending id must not linger and keep counting against the cap.
          this.pendingReads.delete(toolUseId);
          if (this.canGrow()) this.instructionReads.push({ doc, resultChars: resultLength(block.content), ts: this.noteRetained(ts, false) });
        }
      }
    }
    if (o.isMeta === true) {
      const raw = typeof message?.content === "string" ? message.content : JSON.stringify(message?.content ?? "");
      if (HANDBACK_MARKER_RE.test(raw) && this.canGrow()) this.handbackMessagesToBrain.push({ chars: raw.length, ts: this.noteRetained(ts, false) });
    }
  }
}
