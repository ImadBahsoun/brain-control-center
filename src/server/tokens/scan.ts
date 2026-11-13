import "server-only";
import path from "node:path";
import { checkDir, listEntries, readAnchor, readCappedPatterned, realDir, statPatterned, streamLines, TRANSCRIPT_CAPS, TRANSCRIPT_PATTERNS } from "../brain/safe-fs";
import { asObj, asStr, parseJson } from "../brain/jsonish";
import type { BrainRoots } from "../brain/roots";
import { LineExtractor, type AttachmentRecord, type CallRecord, type InstructionReadRecord, type LengthRecord } from "./transcript";

/**
 * Enumeration, per-file memo (with resume) and coalescing over `~/.claude/projects`. Strictly read-only:
 * only listEntries / openPatterned / streamLines / statPatterned / readAnchor are used, never a write.
 * Nothing is ever persisted to disk; the memo lives only in this process's memory and only numbers, the
 * fixed labels of `transcript.ts`, and message ids (never output) are kept in it.
 */

export const SCAN_CAPS = {
  maxFiles: 20_000,
  maxAgeDays: 31,
  lineCap: 64 * 1024 * 1024,
  /** R1: an explicit cap on the memo in both dimensions, independent of the 20,000-file enumeration cap. */
  memoMaxFiles: 20_000,
  memoMaxApproxBytes: 256 * 1024 * 1024,
  /** S2: a hard per-file cap on retained records, independent of the inter-file memo caps above — bounds
   *  one unbounded file's own growth while it is still streaming, not just the memo across many files. */
  maxRecordsPerFile: 200_000,
  anchorBytes: 4096,
} as const;

/**
 * R10: a realistic, fixed per-record memory cost, used only to bound the memo (never shown to users).
 * A `CallRecord` holds a ~36-char id and ~24-char ts string plus 8 numeric/boolean fields; a V8 object of
 * that shape (object header, hidden class, inline string pointers, a Map entry wrapping it) measures
 * roughly 180-220 B in practice, not the flat 100 B this used to assume. 200 B/record is a round,
 * slightly conservative middle of that range; the other record kinds (shorter, fewer fields) are smaller,
 * so sizing every kind at 200 B errs toward counting the memo as bigger than it really is, never smaller.
 */
const APPROX_BYTES_PER_RECORD = 200;

export interface ScanDeps {
  /** Test-only overrides for the memo and per-file caps; production always uses SCAN_CAPS. */
  memoMaxFiles?: number;
  memoMaxApproxBytes?: number;
  maxRecordsPerFile?: number;
}

export type AgentTypeLabel = "planner" | "developer" | "qa" | "reviewer" | "security-reviewer" | "general-purpose" | "Explore" | "Plan" | "other-subagent";
const AGENT_TYPES: ReadonlySet<string> = new Set<AgentTypeLabel>(["planner", "developer", "qa", "reviewer", "security-reviewer", "general-purpose", "Explore", "Plan"]);

export interface ScannedFileResult {
  kind: "main" | "subagent";
  /** The session id (main) or bare agent id (subagent). Server-internal correlation key; never output. */
  key: string;
  /** Subagent only: the session-uuid directory it nests under (R1). Server-internal; never output. */
  parentSession: string | null;
  mtimeMs: number;
  calls: CallRecord[];
  attachments: AttachmentRecord[];
  instructionReads: InstructionReadRecord[];
  packets: LengthRecord[];
  handbacks: LengthRecord[];
  handbackMessagesToBrain: LengthRecord[];
  oversizeAssistantLines: number;
  /** Cumulative, this file only (R9's live-reconciliation scope coverage). */
  oversizeLines: number;
  linesUnparseable: number;
  duplicateWithinFile: number;
  recordsOverflowed: number;
  invalidTimestamps: number;
  /** R11: of invalidTimestamps, how many were calls (drives coverage.complete; see runScan). */
  invalidTimestampCalls: number;
  agentType: AgentTypeLabel | null;
}

export interface ScanCoverage {
  projectsDir: "ok" | "missing" | "unsafe";
  filesScanned: number;
  filesFromMemo: number;
  filesSkippedUnsafe: number;
  filesUnreadable: number;
  oversizeLines: number;
  oversizeAssistantLines: number;
  linesUnparseable: number;
  memoEvictions: number;
  fileCapReached: boolean;
  /** S2: records dropped once a single file's own retained-record cap was reached. */
  recordsOverflowed: number;
  /** R11: lines whose `timestamp` failed strict ISO-8601 validation (or was absent); their ts is never used. */
  invalidTimestamps: number;
  scanMs: number;
  complete: boolean;
}

export interface ScanResult {
  files: ScannedFileResult[];
  coverage: ScanCoverage;
}

interface MemoEntry {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  offset: number;
  anchorHash: string;
  extractor: LineExtractor;
  kind: "main" | "subagent";
  key: string;
  parentSession: string | null;
  agentType: AgentTypeLabel | null;
  lastUsed: number;
  seenThisScan: boolean;
  /** Cumulative across every (resumed) scan of this file; R9's live-reconciliation coverage reports it per file. */
  oversizeLines: number;
}

function approxBytesOf(e: MemoEntry): number {
  const x = e.extractor;
  return (x.callsById.size + x.attachments.length + x.instructionReads.length + x.packets.length + x.handbacks.length + x.handbackMessagesToBrain.length) * APPROX_BYTES_PER_RECORD;
}

// Module-level, in-memory only: cleared by process restart or resetTokenScanState (tests only).
const memo = new Map<string, MemoEntry>();
let inFlightScan: Promise<ScanResult> | null = null;
let scanGeneration = 0;
/** R10: kept current incrementally (never recomputed over the whole memo) so eviction stays O(1) per file, not O(N²) per scan. */
let memoApproxBytesTotal = 0;

/** Test-only: clears the memo and in-flight coalescing so each test starts from a clean process state. */
export function resetTokenScanStateForTests(): void {
  memo.clear();
  inFlightScan = null;
  scanGeneration = 0;
  memoApproxBytesTotal = 0;
}

/** Test-only: the running memo byte total (R10's regression test asserts it never goes negative). */
export function memoApproxBytesTotalForTests(): number {
  return memoApproxBytesTotal;
}

/** Test-only: how many scans have actually run (as opposed to being coalesced onto an in-flight one). */
export function tokenScanGenerationForTests(): number {
  return scanGeneration;
}

function evictIfNeeded(coverage: { memoEvictions: number }, caps: { memoMaxFiles: number; memoMaxApproxBytes: number }): void {
  while (memo.size > caps.memoMaxFiles || memoApproxBytesTotal > caps.memoMaxApproxBytes) {
    let oldestKey: string | null = null;
    let oldestUsed = Infinity;
    for (const [k, e] of memo) {
      if (e.lastUsed < oldestUsed) {
        oldestUsed = e.lastUsed;
        oldestKey = k;
      }
    }
    if (oldestKey === null) break;
    const evicted = memo.get(oldestKey)!;
    memoApproxBytesTotal = Math.max(0, memoApproxBytesTotal - approxBytesOf(evicted));
    memo.delete(oldestKey);
    coverage.memoEvictions++;
  }
}

/** Top-level project directories, newest-irrelevant (order does not matter; only file mtimes gate work). */
async function listProjectDirs(roots: BrainRoots, coverage: ScanCoverage): Promise<{ status: "ok" | "missing" | "unsafe"; dirs: string[] }> {
  const realClaude = await realDir(roots.claudeDir);
  if (realClaude === null) return { status: "missing", dirs: [] };
  const check = await checkDir(roots.projectsDir, path.join(realClaude, "projects"));
  if (check.status !== "ok") return { status: check.status, dirs: [] };
  const listing = await listEntries(roots.projectsDir);
  if (listing.status !== "ok") return { status: listing.status, dirs: [] };
  const dirs: string[] = [];
  for (const e of listing.entries) {
    if (e.isSymlink) {
      coverage.filesSkippedUnsafe++;
      continue;
    }
    if (!e.isDirectory) continue;
    if (!TRANSCRIPT_PATTERNS.projectDir.test(e.name)) continue;
    dirs.push(e.name);
  }
  return { status: "ok", dirs };
}

interface Candidate {
  dirPath: string;
  name: string;
  kind: "main" | "subagent";
  key: string;
  /** Subagent only: the session-uuid directory it was found under. */
  parentSession: string | null;
}

/**
 * R1: a project directory holds a main session FILE (`<session-uuid>.jsonl`) and, for a session that
 * launched subagents, a DIRECTORY of the same name with no suffix (TRANSCRIPT_PATTERNS.session already
 * allows both), containing `subagents/agent-<id>.jsonl` + `.meta.json`. Confirmed from a live transcript
 * path; `tool-results/`, `memory/` and anything else under either directory is never entered.
 */
async function listCandidates(roots: BrainRoots, projectDirs: string[], coverage: ScanCoverage): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const proj of projectDirs) {
    const dirPath = path.join(roots.projectsDir, proj);
    const listing = await listEntries(dirPath);
    if (listing.status !== "ok") continue;
    for (const e of listing.entries) {
      if (e.isSymlink) {
        if (TRANSCRIPT_PATTERNS.session.test(e.name)) coverage.filesSkippedUnsafe++;
        continue;
      }
      if (e.isDirectory) {
        if (e.name.endsWith(".jsonl") || !TRANSCRIPT_PATTERNS.session.test(e.name)) continue; // not a session dir
        const parentSession = e.name;
        const sessionDirPath = path.join(dirPath, parentSession);
        const sessionListing = await listEntries(sessionDirPath);
        if (sessionListing.status !== "ok") continue;
        const subEntry = sessionListing.entries.find((x) => x.name === TRANSCRIPT_PATTERNS.subagentsDirName);
        if (!subEntry || subEntry.isSymlink || !subEntry.isDirectory) continue;
        const subDirPath = path.join(sessionDirPath, TRANSCRIPT_PATTERNS.subagentsDirName);
        const subListing = await listEntries(subDirPath);
        if (subListing.status !== "ok") continue;
        for (const se of subListing.entries) {
          if (se.isDirectory) continue;
          if (se.isSymlink) {
            if (TRANSCRIPT_PATTERNS.agent.test(se.name)) coverage.filesSkippedUnsafe++;
            continue;
          }
          if (!TRANSCRIPT_PATTERNS.agent.test(se.name)) continue;
          const key = se.name.slice("agent-".length, -".jsonl".length);
          out.push({ dirPath: subDirPath, name: se.name, kind: "subagent", key, parentSession });
        }
        continue;
      }
      if (!TRANSCRIPT_PATTERNS.session.test(e.name) || !e.name.endsWith(".jsonl")) continue;
      out.push({ dirPath, name: e.name, kind: "main", key: e.name.slice(0, -".jsonl".length), parentSession: null });
    }
  }
  return out;
}

async function readAgentType(dirPath: string, agentKey: string): Promise<AgentTypeLabel | null> {
  const name = `agent-${agentKey}.meta.json`;
  const r = await readCappedPatterned(dirPath, name, TRANSCRIPT_PATTERNS.agentMeta, TRANSCRIPT_CAPS.metaJson);
  if (r.status !== "ok") return null;
  const parsed = parseJson(r.data);
  const o = asObj(parsed);
  const t = o ? asStr(o.agentType) : null;
  if (t === null) return null;
  return (AGENT_TYPES.has(t) ? t : "other-subagent") as AgentTypeLabel;
}

interface ResolvedCaps {
  memoMaxFiles: number;
  memoMaxApproxBytes: number;
  maxRecordsPerFile: number;
}

async function scanOneFile(c: Candidate, nowMs: number, coverage: ScanCoverage, caps: ResolvedCaps): Promise<ScannedFileResult | null> {
  const st = await statPatterned(c.dirPath, c.name, c.kind === "main" ? TRANSCRIPT_PATTERNS.session : TRANSCRIPT_PATTERNS.agent);
  if (st.status !== "ok") {
    coverage.filesUnreadable++;
    return null;
  }
  const ageMs = nowMs - st.mtimeMs;
  if (ageMs > SCAN_CAPS.maxAgeDays * 24 * 60 * 60 * 1000) return null;

  const memoKey = `${c.dirPath}\0${c.name}\0${st.dev}:${st.ino}`;
  let entry = memo.get(memoKey);
  const sizeOrMtimeChanged = entry !== undefined && (entry.size !== st.size || entry.mtimeMs !== st.mtimeMs);
  let resumeFrom = 0;
  if (entry && !sizeOrMtimeChanged) {
    entry.lastUsed = nowMs;
    coverage.filesFromMemo++;
    entry.seenThisScan = true;
    return toResult(c, entry);
  }
  if (entry && sizeOrMtimeChanged && st.size >= entry.offset) {
    const anchor = await readAnchor(c.dirPath, c.name, c.kind === "main" ? TRANSCRIPT_PATTERNS.session : TRANSCRIPT_PATTERNS.agent, entry.offset, SCAN_CAPS.anchorBytes);
    if (anchor.status === "ok" && anchor.hash === entry.anchorHash) resumeFrom = entry.offset;
  }
  // R10: captured BEFORE streaming mutates `entry.extractor` in place on a resume (it's the very same
  // object as `extractor` below) — computing it afterward would measure the already-grown size, making
  // every resumed file's growth invisible to the running memo-byte total.
  const oldBytes = entry ? approxBytesOf(entry) : 0;
  const extractor = entry && resumeFrom > 0 ? entry.extractor : new LineExtractor(caps.maxRecordsPerFile);
  const pattern = c.kind === "main" ? TRANSCRIPT_PATTERNS.session : TRANSCRIPT_PATTERNS.agent;
  const r = await streamLines(
    c.dirPath,
    c.name,
    pattern,
    resumeFrom,
    SCAN_CAPS.lineCap,
    (line) => extractor.process(line),
    (prefix) => extractor.onOversizeLine(prefix),
  );
  if (r.status !== "ok") {
    coverage.filesUnreadable++;
    return null;
  }
  // R21: not rolled into coverage.oversizeLines here — a warm poll must report this file's oversize
  // lines too, even though it does no streaming this scan. It is rolled up (from every in-memo file,
  // fresh or served from memo) in runScan below, from the per-file cumulative count on ScannedFileResult.
  const anchorHash = await readAnchor(c.dirPath, c.name, pattern, r.newOffset, SCAN_CAPS.anchorBytes);
  const agentType = c.kind === "subagent" ? await readAgentType(c.dirPath, c.key) : null;
  const newEntry: MemoEntry = {
    dev: st.dev,
    ino: st.ino,
    size: st.size,
    mtimeMs: st.mtimeMs,
    offset: r.newOffset,
    anchorHash: anchorHash.status === "ok" ? anchorHash.hash : "",
    extractor,
    kind: c.kind,
    key: c.key,
    parentSession: c.parentSession,
    agentType,
    lastUsed: nowMs,
    seenThisScan: true,
    // R20: the old count is only still valid when we actually resumed from it; a full rescan (ino
    // changed, shrank, or the anchor no longer matched) must not add it on top of the fresh count.
    oversizeLines: (resumeFrom > 0 ? (entry?.oversizeLines ?? 0) : 0) + r.oversizeLines,
  };
  // R10: keep the running memo byte total current by delta, instead of recomputing it over the whole memo.
  memo.set(memoKey, newEntry);
  memoApproxBytesTotal = Math.max(0, memoApproxBytesTotal + approxBytesOf(newEntry) - oldBytes);
  coverage.filesScanned++;
  evictIfNeeded(coverage, caps);
  return toResult(c, newEntry);
}

function toResult(c: Candidate, e: MemoEntry): ScannedFileResult {
  const x = e.extractor;
  return {
    kind: e.kind,
    key: e.key,
    parentSession: e.parentSession,
    mtimeMs: e.mtimeMs,
    calls: x.calls,
    attachments: x.attachments,
    instructionReads: x.instructionReads,
    packets: x.packets,
    handbacks: x.handbacks,
    handbackMessagesToBrain: x.handbackMessagesToBrain,
    oversizeAssistantLines: x.oversizeAssistantLines,
    oversizeLines: e.oversizeLines,
    linesUnparseable: x.linesUnparseable,
    duplicateWithinFile: x.duplicateWithinFile,
    recordsOverflowed: x.recordsOverflowed,
    invalidTimestampCalls: x.invalidTimestampCalls,
    invalidTimestamps: x.invalidTimestamps,
    agentType: e.agentType,
  };
}

async function runScan(roots: BrainRoots, nowMs: number, deps: ScanDeps): Promise<ScanResult> {
  const started = Date.now();
  scanGeneration++;
  const caps: ResolvedCaps = {
    memoMaxFiles: deps.memoMaxFiles ?? SCAN_CAPS.memoMaxFiles,
    memoMaxApproxBytes: deps.memoMaxApproxBytes ?? SCAN_CAPS.memoMaxApproxBytes,
    maxRecordsPerFile: deps.maxRecordsPerFile ?? SCAN_CAPS.maxRecordsPerFile,
  };
  const coverage: ScanCoverage = {
    projectsDir: "ok",
    filesScanned: 0,
    filesFromMemo: 0,
    filesSkippedUnsafe: 0,
    filesUnreadable: 0,
    oversizeLines: 0,
    oversizeAssistantLines: 0,
    linesUnparseable: 0,
    memoEvictions: 0,
    fileCapReached: false,
    recordsOverflowed: 0,
    invalidTimestamps: 0,
    scanMs: 0,
    complete: true,
  };
  for (const e of memo.values()) e.seenThisScan = false;

  const projectDirs = await listProjectDirs(roots, coverage);
  coverage.projectsDir = projectDirs.status;
  if (projectDirs.status !== "ok") {
    coverage.complete = projectDirs.status === "missing";
    coverage.scanMs = Date.now() - started;
    return { files: [], coverage };
  }

  let candidates = await listCandidates(roots, projectDirs.dirs, coverage);
  if (candidates.length > SCAN_CAPS.maxFiles) {
    candidates = candidates.slice(0, SCAN_CAPS.maxFiles);
    coverage.fileCapReached = true;
    coverage.complete = false;
  }

  const files: ScannedFileResult[] = [];
  for (const c of candidates) {
    const r = await scanOneFile(c, nowMs, coverage, caps);
    if (r) files.push(r);
  }

  // evict files no longer present under their old name (deleted, or replaced by a differently named one) and roll up their per-scan counts
  for (const [k, e] of memo) {
    if (!e.seenThisScan) {
      memoApproxBytesTotal = Math.max(0, memoApproxBytesTotal - approxBytesOf(e));
      memo.delete(k);
    }
  }
  // R21: rolled up from every in-memo file (fresh or served unchanged from memo), not only the ones
  // streamed this scan — otherwise a warm poll under-reports and coverage.complete flips back to true.
  let invalidTimestampCalls = 0;
  for (const f of files) {
    coverage.oversizeLines += f.oversizeLines;
    coverage.oversizeAssistantLines += f.oversizeAssistantLines;
    coverage.linesUnparseable += f.linesUnparseable;
    coverage.recordsOverflowed += f.recordsOverflowed;
    coverage.invalidTimestamps += f.invalidTimestamps;
    invalidTimestampCalls += f.invalidTimestampCalls;
  }
  if (coverage.oversizeLines > 0) coverage.complete = false;
  if (coverage.recordsOverflowed > 0) coverage.complete = false;
  // R11: a call with no usable ts never appears in any window, so the scan is reported incomplete.
  if (invalidTimestampCalls > 0) coverage.complete = false;
  coverage.scanMs = Date.now() - started;
  return { files, coverage };
}

/** The shared, coalescing entry point: concurrent calls while a scan is in flight share its one result. */
export async function scanTranscripts(roots: BrainRoots, nowMs: number, deps: ScanDeps = {}): Promise<ScanResult> {
  if (inFlightScan) return inFlightScan;
  const p = runScan(roots, nowMs, deps).finally(() => {
    inFlightScan = null;
  });
  inFlightScan = p;
  return p;
}
