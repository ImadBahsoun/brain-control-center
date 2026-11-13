// Response shapes of the read-only /api/* endpoints. Shared by the server projections and the client.
// Every field here is an explicit projection: nothing in these types carries packets, reports, plan
// text, the verbatim request, session ids, gate codes or gate request contents.

export type Severity = "BLOCKER" | "MAJOR" | "MINOR" | "NIT";
export type FindingStatus =
  | "OPEN"
  | "ACKNOWLEDGED"
  | "FIXED"
  | "REVALIDATED"
  | "CLOSED"
  | "DEFERRED"
  | "REJECTED";
export type TaskStatus =
  | "ACTIVE"
  | "WAITING"
  | "BLOCKED"
  | "COMPLETE"
  | "CANCELLED"
  | "CORRUPT"
  | "INCOMPLETE";

export type LogIntegrity =
  | "ok"
  | "torn_tail"
  | "corrupt"
  | "incomplete"
  | "missing"
  | "unsafe"
  | "too_large";
export type CacheFreshness =
  | "fresh"
  | "stale"
  | "ahead"
  | "diverged"
  | "missing"
  | "invalid"
  | "unsafe"
  | "too_large"
  /** a cache exists but the log could not be read, so it could not be checked; it is not used */
  | "unknown";

export interface TaskIntegrity {
  log: LogIntegrity;
  /** false when only the log tail was read (terminal tasks): the hash chain was not walked. */
  chainChecked: boolean;
  cache: CacheFreshness;
  logSeq: number;
  cacheSeq: number | null;
  corruptLine?: number;
  corruptReason?: string;
  tornBytes?: number;
}

export interface FindingsCount {
  total: number;
  open: number;
  openBySeverity: Record<Severity, number>;
}

export interface TopFinding {
  id: string;
  severity: Severity;
  title: string;
}

export interface TaskSummary {
  id: string;
  title: string | null;
  classification: string | null;
  state: string | null;
  round: number;
  maxRounds: number;
  status: TaskStatus;
  active: boolean;
  blocked: boolean;
  ready: boolean;
  waitingApproval: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  lastEventAt: string | null;
  eventCount: number;
  findings: FindingsCount;
  topOpenFindings: TopFinding[];
  pendingRuns: number;
  /** true when the state.json cache could not be used and only log-derived fields are filled. */
  summaryUnavailable: boolean;
  integrity: TaskIntegrity;
  /** The repository this mission works on, same source and masking as TaskDetail.repository. */
  repository: string | null;
  /**
   * The mission this one was started from: brain-state's explicit `parent_task` (TASK_CREATED payload, else
   * state.json), kept only when it is a well-formed task id. The parent may be absent from the scan.
   */
  parentTaskId: string | null;
  /** The parent's step this mission was started for. Always null: no structured step is recorded yet. */
  parentStepId: string | null;
}

export interface TasksCounts {
  total: number;
  active: number;
  blocked: number;
  waitingApproval: number;
  ready: number;
  corrupt: number;
  openFindings: number;
}

export type EtaKind = "estimate" | "calculating" | "paused" | "blocked" | "unknown" | "complete" | "cancelled";

export interface EtaStage {
  /** planner, developer, validation (its roles run in parallel) or synthesis (the Brain's own step). */
  name: string;
  roles: string[];
  low: number;
  high: number;
  status: "done" | "running" | "queued";
}

/** A deterministic estimate computed on read from the log, the runs and the clock; never stored. */
export interface TaskEta {
  kind: EtaKind;
  /** Minutes remaining; null unless kind is "estimate". */
  low: number | null;
  high: number | null;
  /** Whole minutes since TASK_CREATED (to the last event once terminal); null without a creation time. */
  elapsedMinutes: number | null;
  label: string;
  reason: string;
  basis: "history" | "fallback" | null;
  stages: EtaStage[];
  note: "estimate, not a guarantee";
}

export interface TasksResponse {
  generatedAt: string;
  tasks: Array<TaskSummary & { eta: TaskEta | null }>;
  counts: TasksCounts;
  scan: {
    status: "ok" | "missing" | "unsafe";
    scanned: number;
    scanLimitReached: boolean;
    unsafeEntries: number;
  };
}

export type ActivityTone = "info" | "success" | "warn" | "error";

export interface ActivityItem {
  seq: number;
  ts: string;
  type: string;
  state: string | null;
  round: number | null;
  role?: string;
  tone: ActivityTone;
  text: string;
  detail?: string;
  /** APPROVAL_REQUESTED only: the request's own `expires` (ISO), when the payload carries one. */
  expires?: string;
  stateChange?: { from: string | null; to: string };
}

export interface EventsResponse {
  taskId: string;
  total: number;
  /** true when `events` holds fewer than `total` (the oldest were left out). */
  hasMore: boolean;
  integrity: TaskIntegrity;
  events: ActivityItem[];
}

export interface FindingHistoryItem {
  status: string;
  reason: string | null;
  ts: string | null;
}

export interface Finding {
  id: string;
  aliases: string[];
  /** One of Severity when recorded as such; an unrecognised value is shown as recorded, never relabelled. */
  severity: Severity | string;
  /** One of FindingStatus when recorded as such; an unrecognised value is shown as recorded. */
  status: FindingStatus | string;
  sources: string[];
  title: string;
  location: string | null;
  recommendation: string | null;
  description: string | null;
  introducedRound: number | null;
  fixedRound: number | null;
  validatedRound: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  resolution: { status: string; reason: string | null; ts: string | null } | null;
  history: FindingHistoryItem[];
}

export interface FindingsResponse {
  taskId: string;
  summary: FindingsCount;
  findings: Finding[];
  integrity: TaskIntegrity;
}

export type AgentRunStatus = "pending" | "completed" | "not-launched" | "lost";

export interface AgentRun {
  taskId: string;
  role: string;
  roleLabel: string;
  /** The governor policy's model class (opus/fable), or null when the policy is unavailable. */
  model: string | null;
  /** Effort is not recorded anywhere the dashboard reads; always null. */
  effort: null;
  agentId: string | null;
  kind: string;
  round: number | null;
  /** brain-state's round epoch of the run (a scope change starts a new one); null when not recorded. */
  epoch?: number | null;
  status: AgentRunStatus;
  staleOverThreshold: boolean;
  verdict: string | null;
  reservedUnits: number | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  rerun: boolean;
}

/** How a recorded governor wait ended (`[governor] WAIT ended … · <outcome>`); a DENIED outcome's code is dropped. */
export type QueueWaitOutcome = "CLEAR" | "TIMEOUT" | "DENIED" | "ERROR" | "INTERRUPTED";

/**
 * A launch the governor denied for concurrency, with no agent start, completion or state change recorded
 * since (from the task's `[governor] DENIED CONCURRENCY` and `[governor] WAIT` NOTEs). An allowlisted
 * projection: no note text. The governor keeps no queue order, so there is no position.
 */
export interface QueuedLaunch {
  taskId: string;
  /** The denied roles, limited to the five Brain agents. */
  roles: string[];
  deniedSeq: number;
  /** The denial NOTE's timestamp; null when it is not a valid ISO time. */
  deniedAt: string | null;
  /** The latest wait recorded after the denial, paired with its end by its start time; null when none. */
  wait: { startedAt: string; timeoutMinutes: number | null; endedAt: string | null; outcome: QueueWaitOutcome | null } | null;
  /** The denial (or the wait start, when later) is older than the policy's stale_after_minutes. */
  overStaleThreshold: boolean;
}

export interface AgentsResponse {
  generatedAt: string;
  active: AgentRun[];
  recent: AgentRun[];
  limits: GovernorGlobalLimits | null;
  /** Concurrency-denied launches of non-terminal tasks (additive; absent from older servers). */
  queued?: QueuedLaunch[];
}

export interface GovernorGlobalLimits {
  max_total_agents: number;
  max_developers: number;
  max_validators: number;
  max_opus_agents: number;
  max_fable_agents: number;
}

export interface GovernorPolicy {
  version: number;
  note: string | null;
  agents: Record<string, { policyUnits: number; model: string }>;
  taskBudgets: Record<string, number>;
  softLimitPercent: number;
  maxParallelPerTask: number;
  global: GovernorGlobalLimits;
  staleAfterMinutes: number;
}

export type PolicyStatus = "ok" | "missing" | "invalid" | "unsafe" | "too_large";

export interface TaskUsage {
  classBudget: number | null;
  consumed: number;
  reserved: number;
  committed: number;
  percentOfClassBudget: number | null;
  softLimitCrossed: boolean | null;
  note: string;
}

export interface GlobalUsage {
  pendingTotal: number;
  pendingDevelopers: number;
  pendingValidators: number;
  pendingOpus: number;
  pendingFable: number;
  staleExcluded: number;
}

export interface GovernorDenial {
  taskId: string;
  seq: number;
  ts: string;
  code: string;
  role: string;
}

export interface GovernorSoftLimit {
  taskId: string;
  seq: number;
  ts: string;
}

export interface GovernorResponse {
  generatedAt: string;
  policy: GovernorPolicy | null;
  policyStatus: PolicyStatus;
  policyReason: string | null;
  global: GlobalUsage;
  tasks: Array<{ taskId: string; classification: string | null } & TaskUsage>;
  denials: GovernorDenial[];
  softLimitAccepted: GovernorSoftLimit[];
}

export type GateStatus = "ok" | "missing" | "invalid" | "unsafe" | "too_large";

export interface GateSummary {
  status: GateStatus;
  requests: {
    pending: number;
    expired: number;
    consumed: number;
    /** Revoked as stale (repo, inputs or actions changed); never counted as pending. Additive. */
    revoked: number;
    pendingByAction: Record<string, number>;
  };
  latestValidations: Array<{
    kind: string;
    verdict: string;
    ts: string | null;
    repo: string | null;
    to: string | null;
  }>;
  audit: {
    status: "ok" | "missing" | "unsafe" | "error";
    window: "24h";
    countsByEvent: Record<string, number>;
    lastFailClosedAt: string | null;
    /** true when the audit log was longer than the tail window that was read. */
    partial: boolean;
  };
}

/** A brain-gate request's status, mirroring brain-gate (see gateRequestStatus in src/server/brain/gate.ts). */
export type ApprovalStatus = "pending" | "consumed" | "expired" | "revoked";

/**
 * One brain-gate request, projected from allowlisted fields only: no approval code, session, display,
 * cwd, inputs, envs, command or any other request content. `mission` is set only when the link to a
 * mission is provable without codes or sessions; otherwise null ("Unlinked").
 */
export interface ApprovalItem {
  actions: string[];
  /** The repositories the request is bound to (home-masked); empty when it has no repo binding. */
  repositories: string[];
  /** ISO time the request expires, or null when not recorded as a number. */
  expires: string | null;
  status: ApprovalStatus;
  mission: { taskId: string } | null;
}

export interface ApprovalsResponse {
  generatedAt: string;
  gate: { status: GateStatus };
  /** "unavailable" when the task scan is not reliable enough to link any request (every item is then Unlinked). */
  linking: "ok" | "unavailable";
  counts: Record<ApprovalStatus, number>;
  /** Newest request first. */
  items: ApprovalItem[];
}

export type HealthStatus = "ok" | "degraded" | "unavailable";

export interface HealthResponse {
  status: HealthStatus;
  readOnly: true;
  generatedAt: string;
  sources: {
    tasks: {
      status: "ok" | "missing" | "unsafe";
      taskCount: number;
      unsafeEntries: number;
      scanLimitReached: boolean;
      corrupt: number;
      incomplete: number;
      tornTail: number;
      /** logs that were missing, unsafe or over the read cap */
      logUnreadable: number;
      cacheStale: number;
      cacheAhead: number;
      cacheDiverged: number;
    };
    governor: { status: PolicyStatus };
    gate: GateSummary;
  };
  lastEventAt: string | null;
  lastEventAgeSec: number | null;
  pendingRunsOverStaleThreshold: number;
  reasons: string[];
}

export type StepStatus = "completed" | "current" | "pending" | "skipped";

export interface LifecycleStep {
  state: string;
  label: string;
  status: StepStatus;
  implied: boolean;
  enteredAt: string | null;
  visits: number;
}

export interface LifecycleTransition {
  state: string;
  seq: number;
  ts: string;
}

export interface LifecycleView {
  steps: LifecycleStep[];
  current: string | null;
  exit: { state: string; label: string; seq: number | null; ts: string | null } | null;
  transitions: LifecycleTransition[];
}

export interface TaskDetail extends TaskSummary {
  repository: string | null;
  branch: string | null;
  baseHead: string | null;
  currentHead: string | null;
  classificationReason: string | null;
  risk: string | null;
  nextAction: string | null;
  outcome: string | null;
  completionSummary: string | null;
  blockedInfo: { reason: string | null; needs: string[] } | null;
  plan: {
    author: string | null;
    approved: boolean;
    approvedScope: string[];
    notApproved: string[];
    chars: number | null;
  } | null;
  lifecycle: LifecycleView;
  rounds: Array<{
    round: number;
    kind: string;
    findings: string[];
    findingsAddressed: Record<string, string>;
    completed: boolean;
  }>;
  validation: {
    latest: {
      from: string | null;
      to: string | null;
      decision: string;
      agents: Record<string, string>;
      round: number | null;
      ts: string | null;
    } | null;
    history: Array<{ decision: string; from: string | null; to: string | null; seq: number }>;
    inProgress: { from: string | null; to: string | null; agents: string[]; ts: string | null } | null;
  };
  testsRun: Array<{ agent: string; round: number | null; cmd: string; result: string }>;
  filesChanged: Array<{ agent: string; round: number | null; files: string[] }>;
  agents: AgentRun[];
  usage: TaskUsage | null;
}

export type ApiErrorCode =
  | "FORBIDDEN_HOST"
  | "FORBIDDEN_ORIGIN"
  | "BAD_TASK_ID"
  | "BAD_LIMIT"
  | "TASK_NOT_FOUND"
  | "BAD_WINDOW"
  | "INTERNAL";

export interface ApiError {
  error: { code: ApiErrorCode; message: string };
}

// ---- Token Intelligence (/api/tokens) --------------------------------------------------------------
// Every dollar figure is an API-list-price estimate (costBasis.kind), never the user's bill. Every
// number here comes from a fixed-label, allowlisted projection of local Claude Code transcripts: no
// transcript free text, session id, project path, cwd or git branch is ever included.

export type TokenWindow = "7d" | "30d";

export interface TokenBucket {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheWriteUnsplit: number;
  webSearchRequests: number;
  /** API-list-price-equivalent cost of the priced calls in this bucket only. */
  costUsd: number;
  /** Sensitivity figure: the same calls if every cache write had been billed at the 5-minute rate. */
  costUsdAllWritesAt5m: number;
  /** Calls whose model/speed has no verified price (excluded from costUsd, never guessed). */
  unpricedCalls: number;
  /** Calls on the `<synthetic>` pseudo-model (never priced). */
  syntheticCalls: number;
}

export type AttributionReason =
  | "agent-link"
  | "mission-window"
  | "overlapping-missions"
  | "outside-mission-window"
  | "session-not-in-brain-state"
  | "subagent-not-in-brain-state"
  | "ambiguous-agent-id"
  | "mission-log-unusable";

export type AgentTypeLabel = "planner" | "developer" | "qa" | "reviewer" | "security-reviewer" | "general-purpose" | "Explore" | "Plan" | "brain" | "main-no-mission" | "other-subagent";

export type InstructionDoc = "orchestration/SKILL.md" | "orchestration/state.md" | "orchestration/governor.md" | "orchestration/enforcement.md" | "orchestration/other.md" | "skill:orchestration";

export interface TokenModelRow extends TokenBucket {
  model: string;
  priced: boolean;
  fast: boolean;
}

export interface TokenAgentRow extends TokenBucket {
  agent: AgentTypeLabel;
  runs: number;
}

export interface TokenMissionRow extends TokenBucket {
  taskId: string;
  attributedBy: { agentLink: number; window: number };
  rows: Array<{ agent: AgentTypeLabel; model: string } & TokenBucket>;
}

export interface TokenUnattributedRow extends TokenBucket {
  reason: AttributionReason;
}

export interface TokenDailyRow extends TokenBucket {
  /** server-local YYYY-MM-DD */
  date: string;
}

export type TokenReconciliationCounts = { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number };

/** R9: a pinned historical fixture (CodeBurn 0.9.27, 2026-10-19), proven only by the fixture tests — never a live measurement. */
export interface TokenReconciliationFixture {
  label: string;
  /** null when no reference is configured */
  expected: TokenReconciliationCounts | null;
}

export interface TokenReconciliationLiveCoverage {
  filesInScope: number;
  mainFound: boolean;
  subagentFilesFound: number;
  unparseableLines: number;
  oversizeLines: number;
  recordsOverflowed: number;
}

/**
 * R9: the LIVE check (never conflated with `fixture` above) — `status` is the only place that may claim
 * agreement. Field name kept as `baseline` (not `live`, R9's suggested name) because a locked QA
 * regression test (tests/unit/token-report-f2-probe.test.ts) asserts `reconciliation.baseline.actual`
 * and must pass unmodified; this object is the complete, corrected live-reconciliation shape R9 asks for.
 */
export interface TokenReconciliationLive {
  status: "match" | "mismatch" | "unavailable";
  /** null when no reference is configured (status is then "unavailable") */
  expected: TokenReconciliationCounts | null;
  actual: TokenReconciliationCounts | null;
  diff: Record<string, number> | null;
  coverage: TokenReconciliationLiveCoverage;
}

export interface TokenReconciliation {
  fixture: TokenReconciliationFixture;
  baseline: TokenReconciliationLive;
  /** A separate, purely historical comparison, always over the last 30 days regardless of the selected window. */
  /** The CodeBurn values are null when no reference is configured. */
  reference30d: { codeburnAttributedUsd: number | null; codeburnRecomputedUsd: number | null; brainRecomputeUsd: number; note: string };
}

export interface TokenCoverage {
  projectsDir: "ok" | "missing" | "unsafe";
  filesScanned: number;
  filesFromMemo: number;
  filesSkippedUnsafe: number;
  filesUnreadable: number;
  linesUnparseable: number;
  oversizeLines: number;
  oversizeAssistantLines: number;
  duplicateRecords: number;
  crossFileDuplicates: number;
  missionsScanLimitReached: boolean;
  missionLogsUnusable: number;
  memoEvictions: number;
  /** R13: the 20,000-file enumeration cap was reached; older files are not included. */
  fileCapReached: boolean;
  /** S2: records dropped once a single file's own retained-record cap was reached. */
  recordsOverflowed: number;
  /** R11: lines whose `timestamp` failed strict validation (or was absent); their ts was never used. */
  invalidTimestamps: number;
  scanMs: number;
  complete: boolean;
}

export interface TokenIntelligenceResponse {
  generatedAt: string;
  window: { kind: TokenWindow; startIso: string; endIso: string; oldestCallAt: string | null; partial: boolean; retentionNote: string };
  costBasis: { kind: "api-list-price-equivalent"; note: string; pricingSource: string; pricingCheckedAt: string; assumptions: string[] };
  totals: TokenBucket;
  byModel: TokenModelRow[];
  byAgent: TokenAgentRow[];
  byMission: TokenMissionRow[];
  unattributed: TokenUnattributedRow[];
  context: {
    byAgent: Array<{ agent: AgentTypeLabel; runs: number; startMedian: number; startMax: number; peakMedian: number; peakMax: number }>;
    rebuilds: { count: number; tokens: number; costUsd: number; shareOfCacheWriteCost: number | null; byCause: { afterTtlGap: number; other: number } };
  };
  handoff: {
    subagentRuns: number;
    launchContextTokens: number;
    launchCostUsd: number;
    packets: { count: number; chars: number };
    handbacks: { count: number; chars: number };
    /** A measured, best-effort proxy (an isMeta hand-back marker) — distinct from reportReemission below. */
    handbackMessagesToBrain: { count: number; chars: number };
    /** A4: whether an agent's report text is re-recorded into events.jsonl is not measured in v1; fixed strings, never implies 0. */
    reportReemission: { measured: false; note: "not measured in v1" };
  };
  instructionReads: { total: number; byDoc: Array<{ doc: InstructionDoc; count: number; resultChars: number; approxTokens: number }> };
  attachments: Array<{ type: string; count: number; bytes: number }>;
  daily: TokenDailyRow[];
  reconciliation: TokenReconciliation;
  coverage: TokenCoverage;
}
