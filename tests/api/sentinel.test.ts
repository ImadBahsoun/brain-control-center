import { describe, expect, it } from "vitest";
import { GET as agentsGet } from "@/app/api/agents/route";
import { GET as approvalsGet } from "@/app/api/approvals/route";
import { GET as governorGet } from "@/app/api/governor/route";
import { GET as healthGet } from "@/app/api/health/route";
import { GET as detailGet } from "@/app/api/tasks/[id]/route";
import { GET as eventsGet } from "@/app/api/tasks/[id]/events/route";
import { GET as findingsGet } from "@/app/api/tasks/[id]/findings/route";
import { GET as tasksGet } from "@/app/api/tasks/route";
import { freshHome, GATE_CODE_SENTINEL, GATE_CODE_SENTINEL_2, GATE_SENTINELS, gateStateFixture, highRiskScript, mkdirs, REPO_REL, SENTINELS, SESSION_SENTINEL, standardScript, writeGate, writeGovernor, writeScript } from "../helpers/fixture-store";

const H = { headers: { host: "127.0.0.1:3077" } };

/** Every sensitive value seeded into the fixture store, plus the field names the plan says must never appear. */
const FORBIDDEN = [
  SENTINELS.packet,
  SENTINELS.report,
  SENTINELS.request,
  SENTINELS.planText,
  SENTINELS.command,
  SESSION_SENTINEL,
  GATE_CODE_SENTINEL,
  GATE_CODE_SENTINEL_2,
  GATE_SENTINELS.task,
  GATE_SENTINELS.brainLine,
  GATE_SENTINELS.display,
  GATE_SENTINELS.inputs,
  GATE_SENTINELS.envs,
  GATE_SENTINELS.approvalUuid,
  GATE_SENTINELS.auditCommand,
  "envs",
  "inputs",
  "approval_uuid",
  "gate_code",
  "complete_content",
  "hunter2",
];

describe("sentinel values never reach any endpoint", () => {
  it("seeds every sensitive field and checks all 8 endpoints, including a secret inside a finding title", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    writeGate(home, Date.now());
    const script = highRiskScript(home, { stopAfter: 39 });
    // a secret that leaks through a projected field must come back masked
    script.push({ type: "FINDING_CREATED", payload: { alias: "S1", severity: "MINOR", source: "security-reviewer", title: "hardcoded DB_PASSWORD=hunter2 in config", location: "config/db.ts:3" } });
    script.push({ type: "NOTE", payload: { text: `the user typed approve ${GATE_CODE_SENTINEL_2} earlier; token ghp_abcdefghijklmnopqrstuv` } });
    writeScript(home, "BR-20261007-0001", script);
    writeScript(home, "BR-20261007-0002", standardScript(home, { pendingDeveloper: true }));
    const id = "BR-20261007-0001";
    const ctx = { params: Promise.resolve({ id }) };
    const bodies: Record<string, string> = {
      health: await (await healthGet(new Request("http://127.0.0.1:3077/api/health", H), {})).text(),
      tasks: await (await tasksGet(new Request("http://127.0.0.1:3077/api/tasks", H), {})).text(),
      agents: await (await agentsGet(new Request("http://127.0.0.1:3077/api/agents", H), {})).text(),
      governor: await (await governorGet(new Request("http://127.0.0.1:3077/api/governor", H), {})).text(),
      detail: await (await detailGet(new Request(`http://127.0.0.1:3077/api/tasks/${id}`, H), ctx)).text(),
      events: await (await eventsGet(new Request(`http://127.0.0.1:3077/api/tasks/${id}/events?limit=1000`, H), ctx)).text(),
      findings: await (await findingsGet(new Request(`http://127.0.0.1:3077/api/tasks/${id}/findings`, H), ctx)).text(),
      approvals: await (await approvalsGet(new Request("http://127.0.0.1:3077/api/approvals", H), {})).text(),
    };
    for (const [name, text] of Object.entries(bodies)) {
      for (const s of FORBIDDEN) expect(text, `${name} contains ${s}`).not.toContain(s);
      expect(text, `${name} leaks the raw repo path`).not.toContain(`${home}/${REPO_REL}`);
    }
    // the masked forms are present where the field is projected
    expect(bodies.findings).toContain("DB_PASSWORD=***");
    expect(bodies.events).toContain("approve ******");
    expect(bodies.events).toContain("token ***");
    expect(bodies.detail).toContain("~/proj/repo");
  });

  it("masks a live-looking code in the protocol's `blocked; code X` form wherever it lands: a verdict, a NOTE, `next`, a gate verdict", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    const nowMs = Date.now();
    const gateState = gateStateFixture(Math.floor(nowMs / 1000));
    (gateState.validations as Array<Record<string, unknown>>).push({ kind: "git", from: "e".repeat(40), to: "f".repeat(40), to_given: "f".repeat(40), session: SESSION_SENTINEL, agent_id: "agent-q", agent_type: "qa", repo: GATE_SENTINELS.cwd, verdict: `blocked; code ${GATE_CODE_SENTINEL}`, ts: Math.floor(nowMs / 1000) - 5 });
    writeGate(home, nowMs, { state: gateState });
    const script = standardScript(home, { pendingDeveloper: true });
    script.push({ type: "AGENT_COMPLETED", payload: { agent: "developer", status_or_verdict: `blocked; code ${GATE_CODE_SENTINEL}`, report: SENTINELS.report, agent_id: "agent-dev-9" }, correlation_id: "SEQ3", next: `rerun after APPROVE; code ${GATE_CODE_SENTINEL_2}` });
    script.push({ type: "NOTE", payload: { text: `developer stopped: blocked; code ${GATE_CODE_SENTINEL}` } });
    writeScript(home, "BR-20261007-0001", script);
    const id = "BR-20261007-0001";
    const ctx = { params: Promise.resolve({ id }) };
    const detail = await (await detailGet(new Request(`http://127.0.0.1:3077/api/tasks/${id}`, H), ctx)).text();
    const events = await (await eventsGet(new Request(`http://127.0.0.1:3077/api/tasks/${id}/events`, H), ctx)).text();
    const agents = await (await agentsGet(new Request("http://127.0.0.1:3077/api/agents", H), {})).text();
    const healthBody = await (await healthGet(new Request("http://127.0.0.1:3077/api/health", H), {})).text();
    for (const [name, text] of Object.entries({ detail, events, agents, healthBody })) {
      expect(text, `${name} leaks the code`).not.toContain(GATE_CODE_SENTINEL);
      expect(text, `${name} leaks the second code`).not.toContain(GATE_CODE_SENTINEL_2);
    }
    expect(detail).toContain("blocked; code ******"); // AgentRun.verdict
    expect(detail).toContain("code ******"); // nextAction
    expect(events).toContain("Developer completed: blocked; code ******");
    expect(agents).toContain("blocked; code ******");
    expect(healthBody).toContain("blocked; code ******"); // gate validation verdict
  });
});
