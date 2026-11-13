import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listEntries, openPatterned, readAnchor, readCappedPatterned, streamLines, TRANSCRIPT_CAPS, TRANSCRIPT_PATTERNS } from "@/server/brain/safe-fs";
import { freshHome, mkdirs } from "../helpers/fixture-store";

function projDir(home: string, name = "-Users-dev-example-repo"): string {
  const roots = mkdirs(home);
  const dir = path.join(roots.projectsDir, name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

describe("listEntries", () => {
  it("lists names and flags directories and symlinks without following them", async () => {
    const home = freshHome();
    const dir = projDir(home);
    fs.writeFileSync(path.join(dir, "11111111-2222-3333-4444-555555555555.jsonl"), "{}\n");
    fs.mkdirSync(path.join(dir, "subagents"));
    fs.symlinkSync("/etc", path.join(dir, "evil-link"));
    const r = await listEntries(dir);
    expect(r.status).toBe("ok");
    const byName = new Map(r.entries.map((e) => [e.name, e]));
    expect(byName.get("subagents")?.isDirectory).toBe(true);
    expect(byName.get("evil-link")?.isSymlink).toBe(true);
  });
  it("reports a missing directory", async () => {
    const home = freshHome();
    const r = await listEntries(path.join(home, ".claude", "projects", "nope"));
    expect(r.status).toBe("missing");
  });
});

describe("openPatterned / readCappedPatterned", () => {
  it("accepts a well-formed session file and rejects bad names", async () => {
    const home = freshHome();
    const dir = projDir(home);
    const name = "11111111-2222-3333-4444-555555555555.jsonl";
    fs.writeFileSync(path.join(dir, name), '{"a":1}\n');
    expect((await readCappedPatterned(dir, name, TRANSCRIPT_PATTERNS.session, 1024)).status).toBe("ok");
    for (const bad of ["../evil.jsonl", "not-a-session.jsonl", "11111111-2222-3333-4444-555555555555.jsonl/../x"]) {
      expect((await openPatterned(dir, bad, TRANSCRIPT_PATTERNS.session)).status).toBe("unsafe");
    }
  });
  it("refuses a symlinked transcript file", async () => {
    const home = freshHome();
    const dir = projDir(home);
    const real = path.join(home, "real.jsonl");
    fs.writeFileSync(real, "{}\n");
    const name = "22222222-2222-3333-4444-555555555555.jsonl";
    fs.symlinkSync(real, path.join(dir, name));
    expect((await openPatterned(dir, name, TRANSCRIPT_PATTERNS.session)).status).toBe("unsafe");
  });
  it("refuses a hard-linked transcript file", async () => {
    const home = freshHome();
    const dir = projDir(home);
    const real = path.join(home, "real2.jsonl");
    fs.writeFileSync(real, "{}\n");
    const name = "33333333-2222-3333-4444-555555555555.jsonl";
    fs.linkSync(real, path.join(dir, name));
    expect((await openPatterned(dir, name, TRANSCRIPT_PATTERNS.session)).status).toBe("unsafe");
  });
  it("reports a FIFO as unsafe without blocking", async () => {
    const home = freshHome();
    const dir = projDir(home);
    const name = "44444444-2222-3333-4444-555555555555.jsonl";
    execFileSync("mkfifo", [path.join(dir, name)]);
    const r = await Promise.race([openPatterned(dir, name, TRANSCRIPT_PATTERNS.session), new Promise<"hung">((res) => setTimeout(() => res("hung"), 3000))]);
    expect(r).not.toBe("hung");
    expect((r as { status: string }).status).toBe("unsafe");
  });
  it("caps meta.json reads at 64 KiB", async () => {
    const home = freshHome();
    const dir = path.join(projDir(home), "subagents");
    fs.mkdirSync(dir, { recursive: true });
    const name = "agent-abc123.meta.json";
    fs.writeFileSync(path.join(dir, name), "x".repeat(TRANSCRIPT_CAPS.metaJson + 1));
    expect((await readCappedPatterned(dir, name, TRANSCRIPT_PATTERNS.agentMeta, TRANSCRIPT_CAPS.metaJson)).status).toBe("too_large");
  });
});

describe("streamLines", () => {
  it("delivers complete lines and leaves a trailing partial line for the next call", async () => {
    const home = freshHome();
    const dir = projDir(home);
    const name = "55555555-2222-3333-4444-555555555555.jsonl";
    fs.writeFileSync(path.join(dir, name), '{"n":1}\n{"n":2}\n{"n":3');
    const lines: string[] = [];
    const r = await streamLines(dir, name, TRANSCRIPT_PATTERNS.session, 0, 1024, (l) => lines.push(l.toString("utf8")));
    expect(r.status).toBe("ok");
    expect(lines).toEqual(['{"n":1}', '{"n":2}']);
    expect(r.newOffset).toBe('{"n":1}\n{"n":2}\n'.length);
    // resuming at newOffset after the file grows picks up exactly the rest
    fs.appendFileSync(path.join(dir, name), '}\n{"n":4}\n');
    const lines2: string[] = [];
    const r2 = await streamLines(dir, name, TRANSCRIPT_PATTERNS.session, r.newOffset, 1024, (l) => lines2.push(l.toString("utf8")));
    expect(lines2).toEqual(['{"n":3}', '{"n":4}']);
    expect(r2.newOffset).toBe(r2.size);
  });

  it("a resumed scan (two calls) yields the same lines as one full scan", async () => {
    const home = freshHome();
    const dir = projDir(home);
    const name = "66666666-2222-3333-4444-555555555555.jsonl";
    const body = Array.from({ length: 50 }, (_, i) => `{"n":${i}}`).join("\n") + "\n";
    fs.writeFileSync(path.join(dir, name), body);

    const full: string[] = [];
    await streamLines(dir, name, TRANSCRIPT_PATTERNS.session, 0, 1024, (l) => full.push(l.toString("utf8")));

    const half: string[] = [];
    const r1 = await streamLines(dir, name, TRANSCRIPT_PATTERNS.session, 0, 1024, (l) => half.push(l.toString("utf8")));
    const rest: string[] = [];
    await streamLines(dir, name, TRANSCRIPT_PATTERNS.session, r1.newOffset, 1024, (l) => rest.push(l.toString("utf8")));
    expect([...half, ...rest]).toEqual(full);
  });

  it("discards an oversize line without buffering past the cap and counts it once", async () => {
    const home = freshHome();
    const dir = projDir(home);
    const name = "77777777-2222-3333-4444-555555555555.jsonl";
    const big = "x".repeat(200);
    fs.writeFileSync(path.join(dir, name), `{"ok":1}\n${big}\n{"ok":2}\n`);
    const lines: string[] = [];
    const r = await streamLines(dir, name, TRANSCRIPT_PATTERNS.session, 0, 50, (l) => lines.push(l.toString("utf8")));
    expect(lines).toEqual(['{"ok":1}', '{"ok":2}']);
    expect(r.oversizeLines).toBe(1);
  });

  it("an oversize line still open at EOF is counted and the offset resumes at its start", async () => {
    const home = freshHome();
    const dir = projDir(home);
    const name = "88888888-2222-3333-4444-555555555555.jsonl";
    fs.writeFileSync(path.join(dir, name), `{"ok":1}\n${"y".repeat(200)}`);
    const lines: string[] = [];
    const r = await streamLines(dir, name, TRANSCRIPT_PATTERNS.session, 0, 50, (l) => lines.push(l.toString("utf8")));
    expect(lines).toEqual(['{"ok":1}']);
    expect(r.oversizeLines).toBe(0); // not yet terminated by \n
    expect(r.newOffset).toBe('{"ok":1}\n'.length);
  });

  it("R6: an oversize line spanning several 1 MiB chunks is discarded without its leftover ever growing, and the next line's offset stays exact", async () => {
    const home = freshHome();
    const dir = projDir(home);
    const name = "aaaabbbb-2222-3333-4444-555555555555.jsonl";
    const lineCap = 1000;
    const hugeLine = "z".repeat(3 * 1024 * 1024); // spans several internal 1 MiB read chunks
    const before = '{"ok":1}\n';
    const after = '{"ok":2}\n';
    const content = before + hugeLine + "\n" + after;
    fs.writeFileSync(path.join(dir, name), content);

    const lines: Array<{ text: string; offset: number }> = [];
    let maxOversizePrefix = 0;
    const r = await streamLines(
      dir,
      name,
      TRANSCRIPT_PATTERNS.session,
      0,
      lineCap,
      (l, offset) => lines.push({ text: l.toString("utf8"), offset }),
      (prefix) => {
        maxOversizePrefix = Math.max(maxOversizePrefix, prefix.length);
      },
    );
    expect(lines.map((l) => l.text)).toEqual(['{"ok":1}', '{"ok":2}']);
    expect(r.oversizeLines).toBe(1);
    expect(maxOversizePrefix).toBeLessThanOrEqual(lineCap); // never handed more than the cap, regardless of how many chunks it spanned
    expect(r.newOffset).toBe(content.length); // the file ended with a complete line; offset is exact
    // R6: the dropped oversize line's bytes (plus its terminator) must be fully accounted for, so the
    // following line's reported offset is exact, not short by whatever was discarded mid-stream.
    expect(lines[1]?.offset).toBe(before.length + hugeLine.length + 1);
  });

  it("R6: EOF while still discarding a multi-chunk oversize line resumes from that line's true start", async () => {
    const home = freshHome();
    const dir = projDir(home);
    const name = "ccccdddd-2222-3333-4444-555555555555.jsonl";
    const lineCap = 1000;
    const before = '{"ok":1}\n';
    const hugeLine = "z".repeat(3 * 1024 * 1024); // spans several chunks, never terminated: EOF mid-line
    fs.writeFileSync(path.join(dir, name), before + hugeLine);

    const lines: string[] = [];
    const r = await streamLines(dir, name, TRANSCRIPT_PATTERNS.session, 0, lineCap, (l) => lines.push(l.toString("utf8")));
    expect(lines).toEqual(['{"ok":1}']);
    expect(r.oversizeLines).toBe(0); // never terminated by \n, so not yet counted
    expect(r.newOffset).toBe(before.length); // resumes at the oversize line's own start, not mid-line
  });
});

describe("readAnchor", () => {
  it("hashes the bytes immediately before an offset, so a grown file can be confirmed before resuming", async () => {
    const home = freshHome();
    const dir = projDir(home);
    const name = "99999999-2222-3333-4444-555555555555.jsonl";
    fs.writeFileSync(path.join(dir, name), '{"n":1}\n{"n":2}\n');
    const offset = '{"n":1}\n{"n":2}\n'.length;
    const a1 = await readAnchor(dir, name, TRANSCRIPT_PATTERNS.session, offset, 16);
    const a2 = await readAnchor(dir, name, TRANSCRIPT_PATTERNS.session, offset, 16);
    expect(a1.status).toBe("ok");
    expect(a1).toEqual(a2);
    fs.appendFileSync(path.join(dir, name), '{"n":3}\n');
    fs.unlinkSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, name), "completely different content that changes the anchor bytes\n");
    const a3 = await readAnchor(dir, name, TRANSCRIPT_PATTERNS.session, offset, 16);
    expect(a3.status).toBe("ok");
    expect((a3 as { hash: string }).hash).not.toBe((a1 as { hash: string }).hash);
  });
});
