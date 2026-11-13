import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ApiError, TaskDetail, TasksResponse } from "@/lib/api-types";
import { GET as detailGet } from "@/app/api/tasks/[id]/route";
import { GET as eventsGet } from "@/app/api/tasks/[id]/events/route";
import { GET as findingsGet } from "@/app/api/tasks/[id]/findings/route";
import { GET as tasksGet } from "@/app/api/tasks/route";
import { freshHome, mkdirs, standardScript, writeScript } from "../helpers/fixture-store";

const H = { headers: { host: "127.0.0.1:3077" } };
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("path traversal rejection", () => {
  const BAD_IDS = ["..", "../x", "..%2F..%2Fbrain-gate", "../../brain-gate", "%2e%2e%2f", "/etc/passwd", "%2Fetc%2Fpasswd", "BR-20261007-0001/../x", "BR-20261007-0001\u0000", "BR-20261007-٠١٢٣", "BR-20261007-0001.json", "BR-20261007-00012345678", "br-20261007-0001", " BR-20261007-0001"];

  it("rejects every malformed id with 400 BAD_TASK_ID on all three task routes", async () => {
    const home = freshHome();
    mkdirs(home);
    writeScript(home, "BR-20261007-0001", standardScript(home));
    for (const id of BAD_IDS) {
      for (const [name, fn] of [["detail", detailGet], ["events", eventsGet], ["findings", findingsGet]] as const) {
        const res = await fn(new Request(`http://127.0.0.1:3077/api/tasks/${encodeURIComponent(id)}`, H), ctx(id));
        expect(res.status, `${name} ${JSON.stringify(id)}`).toBe(400);
        expect(((await res.json()) as ApiError).error.code).toBe("BAD_TASK_ID");
      }
    }
  });

  it("never lists or opens a symlinked task dir; a direct request reports unsafe without data", async () => {
    const home = freshHome();
    const roots = mkdirs(home);
    writeScript(home, "BR-20261007-0001", standardScript(home));
    // a symlink inside the tasks dir pointing at the gate directory
    fs.mkdirSync(roots.gateDir, { recursive: true });
    fs.writeFileSync(path.join(roots.gateDir, "state.json"), JSON.stringify({ v: 1, requests: { ABCDEF: { task: "GATE_SENTINEL" } } }));
    fs.symlinkSync(roots.gateDir, path.join(roots.tasksDir, "BR-20261007-0002"));
    const list = (await (await tasksGet(new Request("http://127.0.0.1:3077/api/tasks", H), {})).json()) as TasksResponse;
    expect(list.tasks.map((t) => t.id)).toEqual(["BR-20261007-0001"]);
    expect(list.scan.unsafeEntries).toBe(1);
    const res = await detailGet(new Request("http://127.0.0.1:3077/api/tasks/BR-20261007-0002", H), ctx("BR-20261007-0002"));
    expect(res.status).toBe(200);
    const d = (await res.json()) as TaskDetail;
    expect(d.integrity.log).toBe("unsafe");
    expect(d.integrity.cache).toBe("unsafe");
    expect(d.title).toBeNull();
    expect(d.agents).toEqual([]);
    expect(JSON.stringify(d)).not.toContain("GATE_SENTINEL");
    const ev = await eventsGet(new Request("http://127.0.0.1:3077/api/tasks/BR-20261007-0002/events", H), ctx("BR-20261007-0002"));
    expect(((await ev.json()) as { integrity: { log: string }; events: unknown[] })).toMatchObject({ integrity: { log: "unsafe" }, events: [] });
  });

  it("reports a symlinked events.jsonl and a hard-linked state.json as unsafe", async () => {
    const home = freshHome();
    mkdirs(home);
    const a = writeScript(home, "BR-20261007-0001", standardScript(home));
    const b = writeScript(home, "BR-20261007-0002", standardScript(home));
    fs.unlinkSync(b.eventsPath);
    fs.symlinkSync(a.eventsPath, b.eventsPath);
    fs.unlinkSync(b.statePath);
    fs.linkSync(a.statePath, b.statePath);
    const d = (await (await detailGet(new Request("http://127.0.0.1:3077/api/tasks/BR-20261007-0002", H), ctx("BR-20261007-0002"))).json()) as TaskDetail;
    expect(d.integrity).toMatchObject({ log: "unsafe", cache: "unsafe" });
    expect(d.status).toBe("CORRUPT");
  });

  it("returns 404 when the tasks root is a symlink (the store is unusable) and lists nothing", async () => {
    const home = freshHome();
    const roots = mkdirs(home);
    writeScript(home, "BR-20261007-0001", standardScript(home));
    const real = path.join(home, "real-tasks");
    fs.renameSync(roots.tasksDir, real);
    fs.symlinkSync(real, roots.tasksDir);
    const list = (await (await tasksGet(new Request("http://127.0.0.1:3077/api/tasks", H), {})).json()) as TasksResponse;
    expect(list.tasks).toEqual([]);
    expect(list.scan.status).toBe("unsafe");
    const res = await detailGet(new Request("http://127.0.0.1:3077/api/tasks/BR-20261007-0001", H), ctx("BR-20261007-0001"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as TaskDetail).integrity.log).toBe("unsafe");
  });
});
