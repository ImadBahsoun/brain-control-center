// Synthetic Claude Code transcript fixtures for the token-intelligence tests. Nothing here is real data;
// every id, path and number is made up for the test. Shapes follow the field allowlist the scanner reads
// (src/server/tokens/transcript.ts): type, timestamp, isMeta, message.{id,model,usage,content}.
//
// Layout (R1, confirmed from a live subagent transcript path): a project directory holds a main session
// file `<session-uuid>.jsonl` and, for each session that launched subagents, a DIRECTORY of the same
// `<session-uuid>` (no suffix — matches TRANSCRIPT_PATTERNS.session, which already allows that) holding
// `subagents/agent-<id>.jsonl` and `agent-<id>.meta.json`.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { rootsFromHome } from "@/server/brain/roots";

export interface UsageSpec {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  cacheWriteUnsplit?: number;
  webSearchRequests?: number;
  fast?: boolean;
}

export function assistantLine(id: string, model: string, usage: UsageSpec, ts: string, toolUse: Array<Record<string, unknown>> = []): string {
  const cacheCreation =
    usage.cacheWrite5m !== undefined || usage.cacheWrite1h !== undefined
      ? { ephemeral_5m_input_tokens: usage.cacheWrite5m ?? 0, ephemeral_1h_input_tokens: usage.cacheWrite1h ?? 0 }
      : undefined;
  const msgUsage: Record<string, unknown> = {
    input_tokens: usage.input ?? 0,
    output_tokens: usage.output ?? 0,
    cache_read_input_tokens: usage.cacheRead ?? 0,
    cache_creation_input_tokens: cacheCreation ? (usage.cacheWrite5m ?? 0) + (usage.cacheWrite1h ?? 0) : (usage.cacheWriteUnsplit ?? 0),
    speed: usage.fast ? "fast" : "standard",
  };
  if (cacheCreation) msgUsage.cache_creation = cacheCreation;
  if (usage.webSearchRequests) msgUsage.server_tool_use = { web_search_requests: usage.webSearchRequests };
  return JSON.stringify({
    type: "assistant",
    timestamp: ts,
    isMeta: false,
    message: { id, model, usage: msgUsage, content: toolUse },
  });
}

export function toolUseBlock(id: string, name: string, input: Record<string, unknown>): Record<string, unknown> {
  return { type: "tool_use", id, name, input };
}

export function toolResultLine(toolUseId: string, content: string, ts: string): string {
  return JSON.stringify({
    type: "user",
    timestamp: ts,
    isMeta: false,
    message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content }] },
  });
}

export function metaHandbackLine(ts: string, text = "SubagentHandback received"): string {
  return JSON.stringify({ type: "user", timestamp: ts, isMeta: true, message: { content: text } });
}

export function attachmentLine(type: string, ts: string): string {
  return JSON.stringify({ type: "attachment", timestamp: ts, attachment: { type } });
}

export function projectDirName(repoPath: string): string {
  return repoPath.replace(/[/._]/g, "-");
}

function ensureProjectsRoot(home: string): string {
  const roots = rootsFromHome(home);
  fs.mkdirSync(roots.projectsDir, { recursive: true, mode: 0o700 });
  return roots.projectsDir;
}

export function writeSessionTranscript(home: string, project: string, sessionId: string, lines: string[], mtime?: Date): string {
  const root = ensureProjectsRoot(home);
  const dir = path.join(root, project);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.join("\n") + (lines.length ? "\n" : ""), { mode: 0o600 });
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return file;
}

/** A deterministic, UUID-shaped session id derived from a seed, for tests that don't care which session a subagent nests under. */
export function sessionIdFromSeed(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface SubagentOpts {
  /** The session-uuid directory this subagent nests under. Defaults to one derived from `agentId`, since
   *  most tests don't care which session "owns" a subagent; pass it explicitly to pin a subagent under a
   *  specific main session (e.g. for baseline-scope tests). */
  parentSession?: string;
  mtime?: Date;
}

export function writeSubagentTranscript(home: string, project: string, agentId: string, lines: string[], agentType: string | null, opts: SubagentOpts = {}): string {
  const root = ensureProjectsRoot(home);
  const parentSession = opts.parentSession ?? sessionIdFromSeed(`subagent:${project}:${agentId}`);
  const dir = path.join(root, project, parentSession, "subagents");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `agent-${agentId}.jsonl`);
  fs.writeFileSync(file, lines.join("\n") + (lines.length ? "\n" : ""), { mode: 0o600 });
  if (opts.mtime) fs.utimesSync(file, opts.mtime, opts.mtime);
  if (agentType !== null) {
    fs.writeFileSync(path.join(dir, `agent-${agentId}.meta.json`), JSON.stringify({ agentType }), { mode: 0o600 });
  }
  return file;
}

export function appendToTranscript(file: string, lines: string[], mtime?: Date): void {
  fs.appendFileSync(file, lines.join("\n") + "\n");
  if (mtime) fs.utimesSync(file, mtime, mtime);
}
