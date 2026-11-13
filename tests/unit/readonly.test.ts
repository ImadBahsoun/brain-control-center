import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GET as agentsGet } from "@/app/api/agents/route";
import { GET as approvalsGet } from "@/app/api/approvals/route";
import { GET as governorGet } from "@/app/api/governor/route";
import { GET as healthGet } from "@/app/api/health/route";
import { GET as detailGet } from "@/app/api/tasks/[id]/route";
import { GET as eventsGet } from "@/app/api/tasks/[id]/events/route";
import { GET as findingsGet } from "@/app/api/tasks/[id]/findings/route";
import { GET as tasksGet } from "@/app/api/tasks/route";
import { GET as tokensGet } from "@/app/api/tokens/route";
import { approvalsResponse } from "@/server/brain/approvals";
import { gateSummary } from "@/server/brain/gate";
import { loadPolicy } from "@/server/brain/governor";
import { health } from "@/server/brain/health";
import { agentsResponse, governorResponse } from "@/server/brain/overview";
import { loadTask, scanTasks } from "@/server/brain/task-store";
import { tokenIntelligenceResponse } from "@/server/tokens/report";
import { resetTokenScanStateForTests, scanTranscripts } from "@/server/tokens/scan";
import { appendBytes, fingerprint, freshHome, highRiskScript, mkdirs, replaceLine, rootsFor, standardScript, writeGate, writeGovernor, writeScript } from "../helpers/fixture-store";
import { assistantLine, projectDirName, writeSessionTranscript, writeSubagentTranscript } from "../helpers/transcript-fixtures";

const NOW = Date.now();
const H = { headers: { host: "127.0.0.1:3077" } };

describe("the dashboard never writes to the store", () => {
  it("leaves every fixture file byte-identical with the same mtime and creates no files", async () => {
    resetTokenScanStateForTests();
    const home = freshHome();
    const roots = mkdirs(home);
    writeGovernor(home);
    writeGate(home, NOW);
    writeScript(home, "BR-20261007-0001", highRiskScript(home, { complete: true }));
    const stale = writeScript(home, "BR-20261007-0002", standardScript(home, { pendingDeveloper: true }));
    appendBytes(stale.eventsPath, '{"v":1,"seq":4,"torn');
    const corrupt = writeScript(home, "BR-20261007-0003", standardScript(home));
    replaceLine(corrupt.eventsPath, 2, "{bad");
    writeScript(home, "BR-20261007-0004", standardScript(home), { state: "not json" });
    const proj = projectDirName("/repo/readonly");
    writeSessionTranscript(home, proj, "11111111-2222-3333-4444-555555555555", [assistantLine("m1", "claude-sonnet-5", { input: 10, output: 5 }, new Date(NOW).toISOString())]);
    writeSubagentTranscript(home, proj, "readonly-dev", [assistantLine("m2", "claude-sonnet-5", { input: 1, output: 1 }, new Date(NOW).toISOString())], "developer");
    const claude = roots.claudeDir;

    // the fingerprint covers every file and directory: content hash, size, inode, link count and the
    // integer-nanosecond mtime from bigint stats (no float comparison), so any write, chmod, replace,
    // creation or removal below ~/.claude would change it
    const before = fingerprint(claude);
    expect(Object.values(before).filter((f) => f.kind === "file").length).toBeGreaterThan(8);
    expect(Object.values(before).filter((f) => f.kind === "dir").length).toBeGreaterThan(5);

    // every reader
    await scanTasks(roots, NOW);
    for (const id of ["BR-20261007-0001", "BR-20261007-0002", "BR-20261007-0003", "BR-20261007-0004"]) {
      await loadTask(roots, id, { fullLog: true, nowMs: NOW });
      await loadTask(roots, id, { fullLog: false, nowMs: NOW });
    }
    await loadPolicy(roots);
    await gateSummary(roots, NOW);
    await health(roots, NOW);
    await agentsResponse(roots, NOW);
    await governorResponse(roots, NOW);
    await approvalsResponse(roots, NOW);
    await scanTranscripts(roots, NOW);
    await tokenIntelligenceResponse(roots, NOW, "7d");
    await tokenIntelligenceResponse(roots, NOW, "30d");
    // every route
    const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
    for (const id of ["BR-20261007-0001", "BR-20261007-0002", "BR-20261007-0003", "BR-20261007-0004", "BR-20261007-0009"]) {
      await detailGet(new Request(`http://127.0.0.1:3077/api/tasks/${id}`, H), ctx(id));
      await eventsGet(new Request(`http://127.0.0.1:3077/api/tasks/${id}/events?limit=5`, H), ctx(id));
      await findingsGet(new Request(`http://127.0.0.1:3077/api/tasks/${id}/findings`, H), ctx(id));
    }
    await tasksGet(new Request("http://127.0.0.1:3077/api/tasks", H), {});
    await agentsGet(new Request("http://127.0.0.1:3077/api/agents", H), {});
    await governorGet(new Request("http://127.0.0.1:3077/api/governor", H), {});
    await healthGet(new Request("http://127.0.0.1:3077/api/health", H), {});
    await approvalsGet(new Request("http://127.0.0.1:3077/api/approvals", H), {});
    await tokensGet(new Request("http://127.0.0.1:3077/api/tokens?window=7d", H), {});
    await tokensGet(new Request("http://127.0.0.1:3077/api/tokens?window=30d", H), {});

    const after = fingerprint(claude);
    expect(after).toEqual(before);
    expect(Object.keys(after)).toEqual(Object.keys(before)); // no entry created or removed (state.json.tmp, locks, …)
    expect(Object.keys(after).some((k) => k.endsWith("state.json.tmp"))).toBe(false);
  });

  it("imports no write-capable fs APIs in src/", () => {
    const root = path.resolve(process.cwd(), "src");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(root);
    const forbidden = /writeFile|appendFile|mkdir|rmSync|\brm\(|unlink|rename|chmod|chown|truncate|O_WRONLY|O_RDWR|O_CREAT|child_process|execSync|spawn|fs\.cp|createWriteStream|dangerouslySetInnerHTML|next\/font\/google|Access-Control/;
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      expect(forbidden.test(text), f).toBe(false);
    }
    expect(files.length).toBeGreaterThan(30);
  });
});
