import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { health } from "@/server/brain/health";
import { freshHome, mkdirs, replaceLine, rootsFor, standardScript, writeGate, writeGovernor, writeScript } from "../helpers/fixture-store";

const NOW = Date.parse("2026-10-07T12:00:00.000Z");

describe("health", () => {
  it("is ok with a clean store, valid policy and readable gate", async () => {
    const home = freshHome();
    const roots = mkdirs(home);
    writeGovernor(home);
    writeGate(home, NOW);
    writeScript(home, "BR-20261007-0001", standardScript(home));
    const h = await health(roots, NOW);
    expect(h.status).toBe("ok");
    expect(h.readOnly).toBe(true);
    expect(h.reasons).toEqual([]);
    expect(h.sources.tasks).toMatchObject({ status: "ok", taskCount: 1, corrupt: 0, unsafeEntries: 0, logUnreadable: 0 });
    expect(h.sources.governor.status).toBe("ok");
    expect(h.sources.gate.status).toBe("ok");
    expect(h.lastEventAt).toBe("2026-10-07T08:00:03.000Z");
    expect(h.lastEventAgeSec).toBe(4 * 3600 - 3);
    expect(h.pendingRunsOverStaleThreshold).toBe(0);
  });

  it("is degraded for a corrupt log, an invalid policy, an unreadable gate or stale pending runs are counted", async () => {
    const home = freshHome();
    const roots = mkdirs(home);
    writeGovernor(home, "{bad");
    const t = writeScript(home, "BR-20261007-0001", standardScript(home, { pendingDeveloper: true }));
    const c = writeScript(home, "BR-20261007-0002", standardScript(home));
    replaceLine(c.eventsPath, 2, "nope");
    fs.symlinkSync(t.dir, path.join(roots.tasksDir, "BR-20261007-0003"));
    const later = Date.parse("2026-10-07T13:00:00.000Z");
    const h = await health(roots, later);
    expect(h.status).toBe("degraded");
    expect(h.reasons).toEqual(expect.arrayContaining(["1 corrupt log(s)", "1 unsafe entr(y/ies) under tasks", "governor policy invalid", "brain-gate state missing"]));
    expect(h.sources.tasks.corrupt).toBe(1);
    expect(h.pendingRunsOverStaleThreshold).toBe(1); // started 08:00, now 13:00 → over 240 min (default without policy)
    const soon = await health(roots, Date.parse("2026-10-07T09:00:00.000Z"));
    expect(soon.pendingRunsOverStaleThreshold).toBe(0);
  });

  it("counts unreadable logs (missing, symlinked, over the cap) and degrades for them", async () => {
    const home = freshHome();
    const roots = mkdirs(home);
    writeGovernor(home);
    writeGate(home, NOW);
    const a = writeScript(home, "BR-20261007-0001", standardScript(home));
    fs.unlinkSync(a.eventsPath);
    const b = writeScript(home, "BR-20261007-0002", standardScript(home));
    const elsewhere = path.join(home, "elsewhere.jsonl");
    fs.renameSync(b.eventsPath, elsewhere);
    fs.symlinkSync(elsewhere, b.eventsPath);
    const h = await health(roots, NOW);
    expect(h.status).toBe("degraded");
    expect(h.sources.tasks.logUnreadable).toBe(2);
    expect(h.reasons).toContain("2 unreadable log(s)");
  });

  it("is unavailable when the tasks root is missing or unsafe", async () => {
    const home = freshHome();
    const roots = rootsFor(home);
    const missing = await health(roots, NOW);
    expect(missing.status).toBe("unavailable");
    expect(missing.reasons).toEqual(["tasks root missing"]);
    fs.mkdirSync(roots.brainStateDir, { recursive: true });
    fs.mkdirSync(path.join(home, "real"));
    fs.symlinkSync(path.join(home, "real"), roots.tasksDir);
    const unsafe = await health(roots, NOW);
    expect(unsafe.status).toBe("unavailable");
    expect(unsafe.reasons).toEqual(["tasks root unsafe"]);
  });
});
