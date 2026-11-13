import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CAPS, checkDir, isTaskId, listTaskDirs, readCapped, readTail, TASK_ID_RE } from "@/server/brain/safe-fs";
import { freshHome, mkdirs, writeTask } from "../helpers/fixture-store";

describe("isTaskId", () => {
  it("accepts well-formed ids and rejects traversal, absolute paths, NUL, unicode digits and overlong ids", () => {
    expect(isTaskId("BR-20261007-0001")).toBe(true);
    expect(isTaskId("BR-20261007-000123")).toBe(true);
    for (const bad of ["..", "../x", "..%2F", "%2e%2e%2f", "/etc/passwd", "BR-20261007-0001/../x", "BR-20261007-0001\u0000", "BR-20261007-٠١٢٣", "BR-20261007-0001.json", "BR-20261007-00012345", "br-20261007-0001", "BR-20261007-0001\n", "", 42, null, undefined]) {
      expect(isTaskId(bad), String(bad)).toBe(false);
    }
    expect(TASK_ID_RE.test("BR-20261007-0001\n")).toBe(false);
  });
});

describe("checkDir", () => {
  it("accepts a real owned directory at its expected real path", async () => {
    const home = freshHome();
    const roots = mkdirs(home);
    const real = fs.realpathSync(roots.tasksDir);
    expect(await checkDir(roots.tasksDir, real)).toEqual({ status: "ok" });
  });
  it("reports missing and refuses symlinks, files and relocated paths", async () => {
    const home = freshHome();
    const roots = mkdirs(home);
    expect(await checkDir(path.join(home, "nope"), path.join(home, "nope"))).toEqual({ status: "missing" });
    const link = path.join(home, "link");
    fs.symlinkSync(roots.tasksDir, link);
    expect((await checkDir(link, link)).status).toBe("unsafe");
    const file = path.join(home, "file");
    fs.writeFileSync(file, "x");
    expect((await checkDir(file, file)).status).toBe("unsafe");
    expect((await checkDir(roots.tasksDir, path.join(home, "elsewhere"))).status).toBe("unsafe");
  });
});

describe("readCapped / readTail", () => {
  it("reads a regular owned file within the cap", async () => {
    const home = freshHome();
    const t = writeTask(home, "BR-20261007-0001", [{ type: "TASK_CREATED", payload: { summary: "s", class: "SMALL" } }]);
    const r = await readCapped(t.dir, "events.jsonl", CAPS.eventsFull);
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.data.equals(t.built.text)).toBe(true);
  });
  it("reports missing, too_large, symlinked and hard-linked files without reading them", async () => {
    const home = freshHome();
    const t = writeTask(home, "BR-20261007-0001", [{ type: "TASK_CREATED", payload: { summary: "s", class: "SMALL" } }]);
    expect((await readCapped(path.join(home, "none"), "events.jsonl", 10)).status).toBe("missing");
    expect((await readCapped(t.dir, "events.jsonl", 10)).status).toBe("too_large");
    const dir2 = path.join(path.dirname(t.dir), "BR-20261007-0002");
    fs.mkdirSync(dir2);
    fs.symlinkSync(t.eventsPath, path.join(dir2, "events.jsonl"));
    expect(await readCapped(dir2, "events.jsonl", CAPS.eventsFull)).toEqual({ status: "unsafe", reason: "symlink" });
    fs.linkSync(t.statePath, path.join(dir2, "state.json"));
    expect(await readCapped(dir2, "state.json", CAPS.taskState)).toEqual({ status: "unsafe", reason: "hard-linked" });
    expect(await readTail(dir2, "state.json", 100)).toEqual({ status: "unsafe", reason: "hard-linked" });
  });
  it("reports a FIFO with no writer as unsafe without blocking (O_NONBLOCK, then the regular-file check)", async () => {
    const home = freshHome();
    const t = writeTask(home, "BR-20261007-0001", [{ type: "TASK_CREATED", payload: { summary: "s", class: "SMALL" } }]);
    fs.unlinkSync(t.statePath);
    execFileSync("mkfifo", [t.statePath]);
    // nobody ever opens the FIFO for writing: a blocking open would hang until the test timeout
    const r = await Promise.race([readCapped(t.dir, "state.json", CAPS.taskState), new Promise<"hung">((res) => setTimeout(() => res("hung"), 3000))]);
    expect(r).toEqual({ status: "unsafe", reason: "not a regular file" });
    const tail = await Promise.race([readTail(t.dir, "state.json", 100), new Promise<"hung">((res) => setTimeout(() => res("hung"), 3000))]);
    expect(tail).toEqual({ status: "unsafe", reason: "not a regular file" });
  });
  it("refuses file names outside the fixed allowlist", async () => {
    const home = freshHome();
    const t = writeTask(home, "BR-20261007-0001", [{ type: "TASK_CREATED", payload: { summary: "s", class: "SMALL" } }]);
    const r = await readCapped(t.dir, "lock" as never, 100);
    expect(r.status).toBe("unsafe");
  });
  it("reads only the tail and reports where it starts", async () => {
    const home = freshHome();
    const t = writeTask(home, "BR-20261007-0001", [
      { type: "TASK_CREATED", payload: { summary: "s", class: "SMALL" } },
      { type: "NOTE", payload: { text: "n" } },
    ]);
    const r = await readTail(t.dir, "events.jsonl", 50);
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.data.length).toBe(50);
      expect(r.offset).toBe(t.built.text.length - 50);
      expect(r.partial).toBe(true);
      expect(r.data.equals(t.built.text.subarray(r.offset))).toBe(true);
    }
    const whole = await readTail(t.dir, "events.jsonl", 1 << 20);
    if (whole.status === "ok") expect(whole.partial).toBe(false);
  });
});

describe("listTaskDirs", () => {
  it("lists real task directories newest first, ignores odd names, counts symlinks and caps the scan", async () => {
    const home = freshHome();
    const roots = mkdirs(home);
    for (const id of ["BR-20261007-0001", "BR-20261007-0003", "BR-20261006-0009"]) fs.mkdirSync(path.join(roots.tasksDir, id));
    fs.mkdirSync(path.join(roots.tasksDir, "not-a-task"));
    fs.writeFileSync(path.join(roots.tasksDir, "governor.lock"), "");
    fs.writeFileSync(path.join(roots.tasksDir, "BR-20261007-0004"), ""); // a task-named file
    fs.symlinkSync(path.join(roots.tasksDir, "BR-20261007-0001"), path.join(roots.tasksDir, "BR-20261007-0002"));
    const l = await listTaskDirs(roots.tasksDir);
    expect(l.status).toBe("ok");
    expect(l.ids).toEqual(["BR-20261007-0003", "BR-20261007-0001", "BR-20261006-0009"]);
    expect(l.unsafeEntries).toBe(2);
    expect(l.scanLimitReached).toBe(false);
    const capped = await listTaskDirs(roots.tasksDir, 2);
    expect(capped.ids).toEqual(["BR-20261007-0003", "BR-20261007-0001"]);
    expect(capped.scanLimitReached).toBe(true);
  });
  it("reports a missing root", async () => {
    const home = freshHome();
    expect((await listTaskDirs(path.join(home, "none"))).status).toBe("missing");
  });
});
