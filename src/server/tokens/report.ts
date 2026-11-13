import "server-only";
import type {
  AgentTypeLabel,
  AttributionReason,
  InstructionDoc,
  TokenAgentRow,
  TokenBucket,
  TokenCoverage,
  TokenDailyRow,
  TokenIntelligenceResponse,
  TokenMissionRow,
  TokenModelRow,
  TokenReconciliationCounts,
  TokenUnattributedRow,
  TokenWindow,
} from "@/lib/api-types";
import type { BrainRoots } from "../brain/roots";
import { listTaskDirs } from "../brain/safe-fs";
import { attributeMainCall, attributeSubagent, buildMissionIndex, type MissionIndex } from "./attribute";
import { loadMissionLog } from "./missions";
import { costOf, PRICING_CHECKED_AT, PRICING_SOURCE, writeCostOf } from "./pricing";
import { scanTranscripts, type ScannedFileResult } from "./scan";
import type { CallRecord } from "./transcript";

/**
 * Aggregation: window filter, groupings, daily buckets, reconciliation and coverage. This is the only
 * module that turns the scanner's per-file numbers into the response shape; nothing here reads a
 * transcript directly.
 */

const TASK_SCAN_LIMIT = 200;

/**
 * No reconciliation reference is configured: the response reports `expected: null`, status
 * "unavailable" and null CodeBurn reference values. Tests inject fictional references through `deps`.
 */
/** A2: server-local day the baseline scope is measured on. None configured, so no call matches. */
const BASELINE_DAY = "";
/** B1: a placeholder baseline session id. Server-only: never put in a response (the leak test asserts this). */
const BASELINE_SESSION_ID = "00000000-0000-4000-8000-000000000000";

function defaultDayKey(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "unknown";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function emptyBucket(): TokenBucket {
  return {
    calls: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheWriteUnsplit: 0,
    webSearchRequests: 0,
    costUsd: 0,
    costUsdAllWritesAt5m: 0,
    unpricedCalls: 0,
    syntheticCalls: 0,
  };
}

function addCall(bucket: TokenBucket, call: CallRecord): void {
  bucket.calls++;
  bucket.input += call.input;
  bucket.output += call.output;
  bucket.cacheRead += call.cacheRead;
  bucket.cacheWrite5m += call.cacheWrite5m;
  bucket.cacheWrite1h += call.cacheWrite1h;
  bucket.cacheWriteUnsplit += call.cacheWriteUnsplit;
  bucket.webSearchRequests += call.webSearchRequests;
  if (call.model === "<synthetic>") {
    bucket.syntheticCalls++;
    return;
  }
  const cost = costOf(call, call.model, call.fast);
  if (cost.priced) {
    bucket.costUsd += cost.costUsd;
    bucket.costUsdAllWritesAt5m += cost.costUsdAllWritesAt5m;
  } else {
    bucket.unpricedCalls++;
  }
}

/** DEDUPE_POLICY (A1) cross-file: ascending mtime order, first file to claim an id wins; later ones collide. */
function crossFileDedupe(files: readonly ScannedFileResult[]): { files: Array<{ file: ScannedFileResult; calls: CallRecord[] }>; crossFileDuplicates: number } {
  const ordered = [...files].sort((a, b) => a.mtimeMs - b.mtimeMs);
  const seen = new Set<string>();
  let crossFileDuplicates = 0;
  const out = ordered.map((file) => {
    const calls: CallRecord[] = [];
    for (const c of file.calls) {
      if (seen.has(c.id)) {
        crossFileDuplicates++;
        continue;
      }
      seen.add(c.id);
      calls.push(c);
    }
    return { file, calls };
  });
  return { files: out, crossFileDuplicates };
}

function inWindow(ts: string, startIso: string, endIso: string): boolean {
  return ts >= startIso && ts <= endIso;
}

const KNOWN_ROLES: ReadonlySet<string> = new Set(["planner", "developer", "qa", "reviewer", "security-reviewer", "general-purpose", "Explore", "Plan"]);

function asAgentLabel(role: string | undefined): AgentTypeLabel {
  return role !== undefined && KNOWN_ROLES.has(role) ? (role as AgentTypeLabel) : "other-subagent";
}

/** The agent label for a file: fixed per file (meta agentType / brain-state role, or session-known/not). */
function agentLabelOf(file: ScannedFileResult, idx: MissionIndex, agentIdToRole: ReadonlyMap<string, string>): AgentTypeLabel {
  if (file.kind === "subagent") return file.agentType ?? asAgentLabel(agentIdToRole.get(file.key));
  return idx.allKnownSessions.has(file.key) ? "brain" : "main-no-mission";
}

type Attribution = { reason: AttributionReason; taskId: string | null };

/**
 * R2: attribution per call, not per file. A subagent's mission link never varies by call (agent_id is
 * fixed for the file); a main-session call's mission DOES vary by its own timestamp against the known
 * session windows, so `attributeMainCall` must run for every call, not be skipped in favour of a
 * file-level default.
 */
function attributionOf(file: ScannedFileResult, call: CallRecord, idx: MissionIndex, subagentAttribution: Attribution | null): Attribution {
  if (file.kind === "subagent") return subagentAttribution!;
  return attributeMainCall(file.key, call.ts, idx);
}

function median(ns: readonly number[]): number {
  if (ns.length === 0) return 0;
  const sorted = [...ns].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
}

interface Rebuild {
  tokens: number;
  cause: "afterTtlGap" | "other";
  costUsd: number;
}

interface FileContext {
  startContext: number;
  peakContext: number;
  rebuilds: Rebuild[];
  firstCall: CallRecord | null;
}

/** Context per call = input + cache_read + cache_creation, over a file's deduped non-synthetic calls in ts order. */
function computeFileContext(calls: readonly CallRecord[]): FileContext {
  const real = calls.filter((c) => c.model !== "<synthetic>").sort((a, b) => a.ts.localeCompare(b.ts));
  if (real.length === 0) return { startContext: 0, peakContext: 0, rebuilds: [], firstCall: null };
  const contexts = real.map((c) => c.input + c.cacheRead + c.cacheWrite5m + c.cacheWrite1h + c.cacheWriteUnsplit);
  const rebuilds: Rebuild[] = [];
  for (let i = 0; i < real.length; i++) {
    const c = real[i]!;
    const creation = c.cacheWrite5m + c.cacheWrite1h + c.cacheWriteUnsplit;
    if (creation > 20_000 && c.cacheRead < creation) {
      let cause: Rebuild["cause"] = "other";
      if (i > 0) {
        const prev = real[i - 1]!;
        const gapMs = new Date(c.ts).getTime() - new Date(prev.ts).getTime();
        const thresholdMs = c.cacheWrite5m > 0 ? 5 * 60 * 1000 : c.cacheWrite1h > 0 ? 60 * 60 * 1000 : null;
        if (thresholdMs !== null && Number.isFinite(gapMs) && gapMs > thresholdMs) cause = "afterTtlGap";
      }
      const cost = costOf(c, c.model, c.fast);
      rebuilds.push({ tokens: creation, cause, costUsd: cost.priced ? cost.costUsd : 0 });
    }
  }
  return { startContext: contexts[0] ?? 0, peakContext: Math.max(...contexts), rebuilds, firstCall: real[0] ?? null };
}

export interface TokenReportDeps {
  dayKeyOf?: (ts: string) => string;
  baselineSessionId?: string;
  baselineDay?: string;
  /** The reference counts the live scope is compared against; none configured unless injected (tests). */
  baselineExpected?: TokenReconciliationCounts;
  taskScanLimit?: number;
}

export async function tokenIntelligenceResponse(roots: BrainRoots, nowMs: number, window: TokenWindow, deps: TokenReportDeps = {}): Promise<TokenIntelligenceResponse> {
  const dayKeyOf = deps.dayKeyOf ?? defaultDayKey;
  const baselineSessionId = deps.baselineSessionId ?? BASELINE_SESSION_ID;
  const baselineDay = deps.baselineDay ?? BASELINE_DAY;
  const baselineExpected = deps.baselineExpected ?? null;
  const taskScanLimit = deps.taskScanLimit ?? TASK_SCAN_LIMIT;

  const scan = await scanTranscripts(roots, nowMs);
  const listing = await listTaskDirs(roots.tasksDir, taskScanLimit);
  const missionLogs = await Promise.all(listing.ids.map((id) => loadMissionLog(roots, id)));
  const missionLogsUnusable = missionLogs.filter((l) => !l.usable).length;
  const idx = buildMissionIndex(missionLogs);
  const agentIdToRole = new Map<string, string>();
  for (const log of missionLogs) for (const ev of log.events) if (ev.agentId && ev.agent && !agentIdToRole.has(ev.agentId)) agentIdToRole.set(ev.agentId, ev.agent);

  const days = window === "7d" ? 7 : 30;
  const startIso = new Date(nowMs - days * 24 * 60 * 60 * 1000).toISOString();
  const endIso = new Date(nowMs).toISOString();

  const { files: dedupedFiles, crossFileDuplicates } = crossFileDedupe(scan.files);

  const totals = emptyBucket();
  const byModel = new Map<string, TokenModelRow>();
  const byAgent = new Map<AgentTypeLabel, TokenAgentRow>();
  const byMission = new Map<string, TokenMissionRow>();
  const unattributed = new Map<AttributionReason, TokenUnattributedRow>();
  const daily = new Map<string, TokenDailyRow>();
  const attachmentsByType = new Map<string, { count: number; bytes: number }>();
  const instructionByDoc = new Map<InstructionDoc, { count: number; resultChars: number }>();

  let oldestCallAt: string | null = null;
  let totalCacheWriteCostUsd = 0;
  const contextByAgent = new Map<AgentTypeLabel, { starts: number[]; peaks: number[]; runs: number }>();
  const rebuildTotals = { count: 0, tokens: 0, costUsd: 0, afterTtlGap: 0, other: 0 };
  let subagentRuns = 0;
  let launchContextTokens = 0;
  let launchCostUsd = 0;
  let packetsCount = 0,
    packetsChars = 0,
    handbacksCount = 0,
    handbacksChars = 0,
    handbackToBrainCount = 0,
    handbackToBrainChars = 0,
    instructionReadsTotal = 0;

  for (const { file, calls } of dedupedFiles) {
    for (const c of calls) {
      if (c.ts && (oldestCallAt === null || c.ts < oldestCallAt)) oldestCallAt = c.ts; // R11: an invalidated ts is "" and never becomes the oldest
    }
    const inWindowCalls = calls.filter((c) => inWindow(c.ts, startIso, endIso));
    const agent = agentLabelOf(file, idx, agentIdToRole);
    // R2: a subagent's mission link is fixed per file; a main-session call's is not (attributionOf calls attributeMainCall per call).
    const subagentAttribution = file.kind === "subagent" ? attributeSubagent(file.key, idx) : null;

    for (const c of inWindowCalls) {
      const attribution = attributionOf(file, c, idx, subagentAttribution);
      addCall(totals, c);
      totalCacheWriteCostUsd += writeCostOf(c, c.model, c.fast);

      const modelKey = `${c.model}\0${c.fast}`;
      const modelRow = byModel.get(modelKey) ?? { ...emptyBucket(), model: c.model, priced: false, fast: c.fast };
      addCall(modelRow, c);
      const costed = costOf(c, c.model, c.fast);
      if (costed.priced) modelRow.priced = true;
      byModel.set(modelKey, modelRow);

      const agentRow = byAgent.get(agent) ?? { ...emptyBucket(), agent, runs: 0 };
      addCall(agentRow, c);
      byAgent.set(agent, agentRow);

      const dayKey = dayKeyOf(c.ts);
      const dayRow = daily.get(dayKey) ?? { ...emptyBucket(), date: dayKey };
      addCall(dayRow, c);
      daily.set(dayKey, dayRow);

      const taskId = attribution.taskId;
      if (taskId) {
        const mission = byMission.get(taskId) ?? { ...emptyBucket(), taskId, attributedBy: { agentLink: 0, window: 0 }, rows: [] };
        addCall(mission, c);
        if (attribution.reason === "agent-link") mission.attributedBy.agentLink++;
        else if (attribution.reason === "mission-window") mission.attributedBy.window++;
        let row = mission.rows.find((r) => r.agent === agent && r.model === c.model);
        if (!row) {
          row = { ...emptyBucket(), agent, model: c.model };
          mission.rows.push(row);
        }
        addCall(row, c);
        byMission.set(taskId, mission);
      } else {
        const row = unattributed.get(attribution.reason) ?? { ...emptyBucket(), reason: attribution.reason };
        addCall(row, c);
        unattributed.set(attribution.reason, row);
      }
    }

    // context / rebuilds / handoff: computed over the file's in-window calls
    const ctx = computeFileContext(inWindowCalls);
    if (inWindowCalls.length > 0) {
      // R4: one run per file with at least one in-window call, consistent with contextByAgent below.
      const agentRow = byAgent.get(agent);
      if (agentRow) agentRow.runs++;
      const acc = contextByAgent.get(agent) ?? { starts: [], peaks: [], runs: 0 };
      acc.starts.push(ctx.startContext);
      acc.peaks.push(ctx.peakContext);
      acc.runs++;
      contextByAgent.set(agent, acc);
    }
    for (const r of ctx.rebuilds) {
      rebuildTotals.count++;
      rebuildTotals.tokens += r.tokens;
      rebuildTotals.costUsd += r.costUsd;
      if (r.cause === "afterTtlGap") rebuildTotals.afterTtlGap++;
      else rebuildTotals.other++;
    }
    if (file.kind === "subagent" && ctx.firstCall) {
      subagentRuns++;
      launchContextTokens += ctx.startContext;
      const c = costOf(ctx.firstCall, ctx.firstCall.model, ctx.firstCall.fast);
      if (c.priced) launchCostUsd += c.costUsd;
    }

    for (const p of file.packets) {
      if (!inWindow(p.ts, startIso, endIso)) continue;
      packetsCount++;
      packetsChars += p.chars;
    }
    for (const h of file.handbacks) {
      if (!inWindow(h.ts, startIso, endIso)) continue;
      handbacksCount++;
      handbacksChars += h.chars;
    }
    for (const h of file.handbackMessagesToBrain) {
      if (!inWindow(h.ts, startIso, endIso)) continue;
      handbackToBrainCount++;
      handbackToBrainChars += h.chars;
    }
    for (const ir of file.instructionReads) {
      if (!inWindow(ir.ts, startIso, endIso)) continue;
      instructionReadsTotal++;
      const acc = instructionByDoc.get(ir.doc) ?? { count: 0, resultChars: 0 };
      acc.count++;
      acc.resultChars += ir.resultChars;
      instructionByDoc.set(ir.doc, acc);
    }
    for (const a of file.attachments) {
      if (!inWindow(a.ts, startIso, endIso)) continue;
      const acc = attachmentsByType.get(a.type) ?? { count: 0, bytes: 0 };
      acc.count++;
      acc.bytes += a.bytes;
      attachmentsByType.set(a.type, acc);
    }
  }

  // ---- live reconciliation (A2, Q2/R3/S1, R9): the main file's OWN subagents only, on the baseline day ----
  const mainFile = dedupedFiles.find(({ file }) => file.kind === "main" && baselineSessionId !== "" && file.key === baselineSessionId);
  let liveStatus: "match" | "mismatch" | "unavailable" = "unavailable";
  let liveActual: TokenReconciliationCounts | null = null;
  let liveDiff: Record<string, number> | null = null;
  const liveCoverage = { filesInScope: 0, mainFound: mainFile !== undefined, subagentFilesFound: 0, unparseableLines: 0, oversizeLines: 0, recordsOverflowed: 0 };
  if (mainFile) {
    // Q2/R3/S1 (binding): the scope is the main file itself plus ONLY the subagent files whose
    // parentSession is this exact session — never every subagent on disk (that was the A2 violation).
    const scope = dedupedFiles.filter(({ file }) => (file.kind === "main" && file.key === baselineSessionId) || (file.kind === "subagent" && file.parentSession === baselineSessionId));
    liveCoverage.filesInScope = scope.length;
    liveCoverage.subagentFilesFound = scope.filter(({ file }) => file.kind === "subagent").length;
    for (const { file } of scope) {
      liveCoverage.unparseableLines += file.linesUnparseable;
      liveCoverage.oversizeLines += file.oversizeLines;
      liveCoverage.recordsOverflowed += file.recordsOverflowed;
    }
    const b = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const { calls } of scope) {
      for (const c of calls) {
        if (dayKeyOf(c.ts) !== baselineDay) continue;
        b.calls++;
        b.input += c.input;
        b.output += c.output;
        b.cacheRead += c.cacheRead;
        b.cacheWrite += c.cacheWrite5m + c.cacheWrite1h + c.cacheWriteUnsplit;
      }
    }
    liveActual = b;
    if (baselineExpected) {
      const diff: Record<string, number> = {};
      let allMatch = true;
      for (const k of Object.keys(baselineExpected) as Array<keyof TokenReconciliationCounts>) {
        const d = b[k] - baselineExpected[k];
        if (d !== 0) allMatch = false;
        diff[k] = d;
      }
      liveStatus = allMatch ? "match" : "mismatch";
      liveDiff = diff;
    }
  }

  // the 30-day reference recompute is always over the last 30 days, independent of the requested window
  const ref30StartIso = new Date(nowMs - 30 * 24 * 60 * 60 * 1000).toISOString();
  let brainRecompute30dUsd = 0;
  for (const { calls } of dedupedFiles) {
    for (const c of calls) {
      if (!inWindow(c.ts, ref30StartIso, endIso) || c.model === "<synthetic>") continue;
      const cost = costOf(c, c.model, c.fast);
      if (cost.priced) brainRecompute30dUsd += cost.costUsd;
    }
  }

  const partial = scan.coverage.complete === false || (oldestCallAt !== null && oldestCallAt > startIso);

  const coverage: TokenCoverage = {
    projectsDir: scan.coverage.projectsDir,
    filesScanned: scan.coverage.filesScanned,
    filesFromMemo: scan.coverage.filesFromMemo,
    filesSkippedUnsafe: scan.coverage.filesSkippedUnsafe,
    filesUnreadable: scan.coverage.filesUnreadable,
    linesUnparseable: scan.coverage.linesUnparseable,
    oversizeLines: scan.coverage.oversizeLines,
    oversizeAssistantLines: scan.coverage.oversizeAssistantLines,
    duplicateRecords: scan.files.reduce((n, f) => n + f.duplicateWithinFile, 0) + crossFileDuplicates,
    crossFileDuplicates,
    missionsScanLimitReached: listing.scanLimitReached,
    missionLogsUnusable,
    memoEvictions: scan.coverage.memoEvictions,
    fileCapReached: scan.coverage.fileCapReached,
    recordsOverflowed: scan.coverage.recordsOverflowed,
    invalidTimestamps: scan.coverage.invalidTimestamps,
    scanMs: scan.coverage.scanMs,
    complete: scan.coverage.complete,
  };

  return {
    generatedAt: new Date(nowMs).toISOString(),
    window: { kind: window, startIso, endIso, oldestCallAt, partial, retentionNote: "transcripts older than 31 days are not scanned" },
    costBasis: {
      kind: "api-list-price-equivalent",
      note: "estimate at API list prices, not your bill or subscription charge",
      pricingSource: PRICING_SOURCE,
      pricingCheckedAt: PRICING_CHECKED_AT,
      // R18: inference_geo IS present in transcripts, but v1 never reads it — this is a choice, not a blind spot.
      assumptions: ["inference_geo is recorded in transcripts but not applied in v1; all calls priced at global routing (US-only routing would be 1.1x)", "standard tier", "no batch API", "fast mode priced from the pricing page"],
    },
    totals,
    byModel: Array.from(byModel.values()),
    byAgent: Array.from(byAgent.values()),
    byMission: Array.from(byMission.values()),
    unattributed: Array.from(unattributed.values()),
    context: {
      byAgent: Array.from(contextByAgent, ([agent, a]) => ({
        agent,
        runs: a.runs,
        startMedian: median(a.starts),
        startMax: a.starts.length ? Math.max(...a.starts) : 0,
        peakMedian: median(a.peaks),
        peakMax: a.peaks.length ? Math.max(...a.peaks) : 0,
      })),
      rebuilds: {
        count: rebuildTotals.count,
        tokens: rebuildTotals.tokens,
        costUsd: rebuildTotals.costUsd,
        shareOfCacheWriteCost: totalCacheWriteCostUsd > 0 ? rebuildTotals.costUsd / totalCacheWriteCostUsd : null,
        byCause: { afterTtlGap: rebuildTotals.afterTtlGap, other: rebuildTotals.other },
      },
    },
    handoff: {
      subagentRuns,
      launchContextTokens,
      launchCostUsd,
      packets: { count: packetsCount, chars: packetsChars },
      handbacks: { count: handbacksCount, chars: handbacksChars },
      handbackMessagesToBrain: { count: handbackToBrainCount, chars: handbackToBrainChars },
      reportReemission: { measured: false, note: "not measured in v1" },
    },
    instructionReads: {
      total: instructionReadsTotal,
      byDoc: Array.from(instructionByDoc, ([doc, a]) => ({ doc, count: a.count, resultChars: a.resultChars, approxTokens: Math.round(a.resultChars / 4) })),
    },
    attachments: Array.from(attachmentsByType, ([type, a]) => ({ type, count: a.count, bytes: a.bytes })),
    daily: Array.from(daily.values()),
    reconciliation: {
      fixture: { label: "verified historical fixture: proven by tests, not a live check", expected: baselineExpected },
      // the key stays `baseline` (not `live`): a locked QA regression test asserts reconciliation.baseline.actual
      baseline: { status: liveStatus, expected: baselineExpected, actual: liveActual, diff: liveDiff, coverage: liveCoverage },
      reference30d: {
        codeburnAttributedUsd: null,
        codeburnRecomputedUsd: null,
        brainRecomputeUsd: brainRecompute30dUsd,
        note: "historical reference only, not a live check, and always over the last 30 days regardless of the window selected above; see reconciliation.baseline for the live comparison",
      },
    },
    coverage,
  };
}
