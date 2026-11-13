import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { brainRoots, rootsFromHome } from "@/server/brain/roots";

describe("brainRoots", () => {
  it("derives every path from the (test-overridden) HOME and nothing else", () => {
    const home = os.homedir();
    expect(home).toBe(process.env.HOME);
    expect(home.startsWith(os.tmpdir()) || home.includes("bcc-")).toBe(true);
    const r = brainRoots();
    expect(r).toEqual(rootsFromHome(home));
    expect(r.claudeDir).toBe(path.join(home, ".claude"));
    expect(r.brainStateDir).toBe(path.join(home, ".claude", "state", "brain"));
    expect(r.tasksDir).toBe(path.join(home, ".claude", "state", "brain", "tasks"));
    expect(r.governorDir).toBe(path.join(home, ".claude", "brain"));
    expect(r.governorFile).toBe("governor.json");
    expect(r.gateDir).toBe(path.join(home, ".claude", "state", "brain-gate"));
    expect(r.gateStateFile).toBe("state.json");
    expect(r.gateAuditFile).toBe("audit.jsonl");
    expect(r.projectsDir).toBe(path.join(home, ".claude", "projects"));
    for (const p of [r.claudeDir, r.tasksDir, r.governorDir, r.gateDir, r.projectsDir]) expect(p.startsWith(home)).toBe(true);
  });
});
