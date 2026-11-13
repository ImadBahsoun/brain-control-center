import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TokenIntelligenceResponse } from "@/lib/api-types";
import { GET } from "@/app/api/tokens/route";
import { PRICING_CHECKED_AT, PRICING_SOURCE } from "@/server/tokens/pricing";
import { resetTokenScanStateForTests } from "@/server/tokens/scan";
import { freshHome, mkdirs, writeScript } from "../helpers/fixture-store";
import { assistantLine, projectDirName, writeSessionTranscript } from "../helpers/transcript-fixtures";

/** B1: the server's baseline session id (a placeholder) — must never appear in a response, even when it drives the live reconciliation scope. */
const BASELINE_SESSION_ID = "00000000-0000-4000-8000-000000000000";

const H = { headers: { host: "127.0.0.1:3077" } };

const CANARY_MESSAGE_TEXT = "CANARY_MESSAGE_TEXT_7f1a";
const CANARY_BEARER = "Bearer eyJhbGciOiJIUzI1NiJ9.CANARY.sig";
const CANARY_DB_PASSWORD = "DB_PASSWORD=CANARY_PW_4417";
const CANARY_PATIENT_MRN = "PATIENT_CANARY_MRN_7731";
const CANARY_TOOL_RESULT = "CANARY_TOOL_RESULT_CONTENT_9c2d";
const CANARY_IMAGE_BASE64 = "CANARY_IMAGE_BASE64_QUJDREVGRw==";
const CANARY_META_DESCRIPTION = "CANARY_META_DESCRIPTION_a1b2";
const CANARY_ATTACHMENT_BODY = "CANARY_ATTACHMENT_BODY_c3d4";
const CANARY_HANDBACK_TEXT = "CANARY_HANDBACK_TEXT_e5f6";
const CANARY_CWD = "/CANARY_CWD_SENTINEL/repo";
const CANARY_GIT_BRANCH = "canary-git-branch-xyz";
/**
 * R11(c): an invalid `timestamp` value that still LOOKS like a real ISO instant up to its trailing
 * garbage, so it would win the old, unvalidated `c.ts < oldestCallAt` lexical comparison against real
 * dates (a value like "CANARY_TIMESTAMP_NOT_ISO_1234" starts with 'C', which never sorts before a real
 * "2026-..." date, so the old test could never actually fail against the pre-R11 code).
 */
const CANARY_TIMESTAMP = "2026-10-01T00:00:00Z_CANARY";
const CANARIES = [
  CANARY_MESSAGE_TEXT,
  CANARY_BEARER,
  CANARY_DB_PASSWORD,
  CANARY_PATIENT_MRN,
  CANARY_TOOL_RESULT,
  CANARY_IMAGE_BASE64,
  CANARY_META_DESCRIPTION,
  CANARY_ATTACHMENT_BODY,
  CANARY_HANDBACK_TEXT,
  CANARY_CWD,
  CANARY_GIT_BRANCH,
  CANARY_TIMESTAMP,
];
const CANARY_SESSION = "deadbeef-dead-beef-dead-beefdeadbeef";
const CANARY_PROJECT_DIR = "CANARY-PROJECT-DIR-9f3a";

function canaryLine(ts: string, id = "canary-call-1"): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: ts,
    isMeta: false,
    sessionId: CANARY_SESSION,
    cwd: CANARY_CWD,
    gitBranch: CANARY_GIT_BRANCH,
    message: {
      id,
      model: "claude-sonnet-5",
      text: CANARY_MESSAGE_TEXT,
      usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 1 },
      content: [
        { type: "text", text: CANARY_MESSAGE_TEXT },
        { type: "tool_use", id: "tu-1", name: "Bash", input: { command: `echo ${CANARY_BEARER} ${CANARY_DB_PASSWORD} ${CANARY_PATIENT_MRN}` } },
        { type: "image", source: { data: CANARY_IMAGE_BASE64 } },
      ],
    },
    meta: { description: CANARY_META_DESCRIPTION },
  });
}

function canaryUserLine(ts: string): string {
  return JSON.stringify({
    type: "user",
    timestamp: ts,
    isMeta: true,
    sessionId: CANARY_SESSION,
    message: {
      content: [{ type: "tool_result", tool_use_id: "tu-1", content: CANARY_TOOL_RESULT }],
    },
    handback_text: `SubagentHandback ${CANARY_HANDBACK_TEXT}`,
  });
}

function canaryAttachmentLine(ts: string): string {
  return JSON.stringify({ type: "attachment", timestamp: ts, attachment: { type: "queued_command", body: CANARY_ATTACHMENT_BODY } });
}

function writeCanaryStore(home: string): void {
  const roots = mkdirs(home);
  const projDir = path.join(roots.projectsDir, CANARY_PROJECT_DIR);
  fs.mkdirSync(projDir, { recursive: true, mode: 0o700 });
  const ts = new Date().toISOString();
  // R11(c): a distinct message id, so this invalid-ts call is retained in its own right, never silently
  // merged into (or replaced by) the real canary call above via last-occurrence-wins dedup.
  const lines = [canaryLine(ts), canaryUserLine(ts), canaryAttachmentLine(ts), canaryLine(CANARY_TIMESTAMP, "canary-call-invalid-ts")];
  fs.writeFileSync(path.join(projDir, `${CANARY_SESSION}.jsonl`), lines.join("\n") + "\n", { mode: 0o600 });

  // a decoy file under tool-results/ and memory/ with a plausible-looking name: never opened or named
  const toolResults = path.join(projDir, "tool-results");
  fs.mkdirSync(toolResults, { recursive: true });
  fs.writeFileSync(path.join(toolResults, "result-1.json"), JSON.stringify({ text: CANARY_TOOL_RESULT }));
  const memory = path.join(projDir, "memory");
  fs.mkdirSync(memory, { recursive: true });
  fs.writeFileSync(path.join(memory, "MEMORY.md"), CANARY_MESSAGE_TEXT);

  // a subagent file carrying the same canaries, plus a meta.json with an unlisted agentType field
  // (R1 layout: subagents nest under a session-uuid directory alongside the main session file)
  const subDir = path.join(projDir, CANARY_SESSION, "subagents");
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, "agent-canary1.jsonl"), [canaryLine(ts), canaryUserLine(ts)].join("\n") + "\n", { mode: 0o600 });
  fs.writeFileSync(path.join(subDir, "agent-canary1.meta.json"), JSON.stringify({ agentType: "developer", description: CANARY_META_DESCRIPTION }), { mode: 0o600 });
}

beforeEach(() => resetTokenScanStateForTests());

describe("GET /api/tokens leaks no transcript content", () => {
  it("never echoes a canary seeded into any content-bearing field", async () => {
    const home = freshHome();
    writeCanaryStore(home);
    const res = await GET(new Request("http://127.0.0.1:3077/api/tokens?window=30d", H), {});
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const c of CANARIES) expect(text, c).not.toContain(c);
    expect(text).not.toContain(CANARY_SESSION);
    expect(text).not.toContain(CANARY_PROJECT_DIR);
  });

  it("never lets an invalid timestamp become oldestCallAt or any other ts-derived field (R11)", async () => {
    const home = freshHome();
    writeCanaryStore(home);
    const res = await GET(new Request("http://127.0.0.1:3077/api/tokens?window=30d", H), {});
    const body = (await res.json()) as TokenIntelligenceResponse;
    expect(body.window.oldestCallAt).not.toBe(CANARY_TIMESTAMP);
    expect(body.coverage.invalidTimestamps).toBeGreaterThan(0);
  });

  it("B1: never echoes the baseline session id, even when it drives the live reconciliation scope", async () => {
    const home = freshHome();
    mkdirs(home);
    writeSessionTranscript(home, projectDirName("/repo/b1"), BASELINE_SESSION_ID, [assistantLine("b1-1", "claude-sonnet-5", { input: 5 }, new Date().toISOString())]);
    const res = await GET(new Request("http://127.0.0.1:3077/api/tokens?window=30d", H), {});
    const text = await res.text();
    const body = JSON.parse(text) as TokenIntelligenceResponse;
    expect(text).not.toContain(BASELINE_SESSION_ID);
    // this session IS the baseline scope (the id matched its file and it was measured), proving the id's absence isn't just because nothing used it
    expect(body.reconciliation.baseline.coverage.mainFound).toBe(true);
    expect(body.reconciliation.baseline.coverage.filesInScope).toBe(1);
    expect(body.reconciliation.baseline.actual).not.toBeNull();
    // no reference is configured, so there is nothing to compare against
    expect(body.reconciliation.baseline.status).toBe("unavailable");
    expect(body.reconciliation.baseline.expected).toBeNull();
  });

  it("runs the scan and the route with no console output", async () => {
    const home = freshHome();
    writeCanaryStore(home);
    const spy = { log: vi.spyOn(console, "log"), warn: vi.spyOn(console, "warn"), error: vi.spyOn(console, "error") };
    await GET(new Request("http://127.0.0.1:3077/api/tokens?window=30d", H), {});
    expect(spy.log).not.toHaveBeenCalled();
    expect(spy.warn).not.toHaveBeenCalled();
    expect(spy.error).not.toHaveBeenCalled();
    spy.log.mockRestore();
    spy.warn.mockRestore();
    spy.error.mockRestore();
  });
});

describe("response allowlist walker", () => {
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const TASK_ID = /^BR-\d{8}-\d{4,6}$/;
  const MODEL = /^claude-[a-z0-9-]{1,40}$|^unknown-model$|^<synthetic>$/;
  const ENUM_VALUES = new Set([
    "7d",
    "30d",
    "api-list-price-equivalent",
    "ok",
    "missing",
    "unsafe",
    "match",
    "mismatch",
    "unavailable",
    "afterTtlGap",
    "other",
    "agent-link",
    "mission-window",
    "overlapping-missions",
    "outside-mission-window",
    "session-not-in-brain-state",
    "subagent-not-in-brain-state",
    "ambiguous-agent-id",
    "mission-log-unusable",
    "planner",
    "developer",
    "qa",
    "reviewer",
    "security-reviewer",
    "general-purpose",
    "Explore",
    "Plan",
    "brain",
    "main-no-mission",
    "other-subagent",
    "deferred_tools_delta",
    "skill_listing",
    "mcp_instructions_delta",
    "queued_command",
    "prompt_snapshot",
    "total_tokens_reminder",
    "task_notification",
    "orchestration/SKILL.md",
    "orchestration/state.md",
    "orchestration/governor.md",
    "orchestration/enforcement.md",
    "orchestration/other.md",
    "skill:orchestration",
    "not measured in v1",
    "inference_geo is recorded in transcripts but not applied in v1; all calls priced at global routing (US-only routing would be 1.1x)",
    "standard tier",
    "no batch API",
    "fast mode priced from the pricing page",
    "estimate at API list prices, not your bill or subscription charge",
    "transcripts older than 31 days are not scanned",
    "verified historical fixture: proven by tests, not a live check",
    "historical reference only, not a live check, and always over the last 30 days regardless of the window selected above; see reconciliation.baseline for the live comparison",
    PRICING_SOURCE,
    PRICING_CHECKED_AT,
  ]);

  function walk(v: unknown, path_: string, bad: string[]): void {
    if (typeof v === "string") {
      if (v === "") return;
      if (ISO.test(v) || DAY.test(v) || TASK_ID.test(v) || MODEL.test(v) || ENUM_VALUES.has(v)) return;
      bad.push(`${path_} = ${JSON.stringify(v)}`);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path_}[${i}]`, bad));
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, `${path_}.${k}`, bad);
    }
  }

  it("matches every string in the response against the fixed allowlist", async () => {
    const home = freshHome();
    mkdirs(home);
    writeCanaryStore(home);
    // a real brain-state task too, so a task id and a day bucket both appear
    writeScript(home, "BR-20261014-0099", [{ type: "TASK_CREATED", payload: { summary: "s", class: "STANDARD" }, ts: new Date().toISOString() }]);
    const res = await GET(new Request("http://127.0.0.1:3077/api/tokens?window=30d", H), {});
    const body = (await res.json()) as TokenIntelligenceResponse;
    const bad: string[] = [];
    walk(body, "$", bad);
    expect(bad).toEqual([]);
  });
});
