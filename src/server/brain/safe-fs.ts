import "server-only";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

/**
 * Read-only, capped, no-follow file access for the Brain store. Nothing in this module can create,
 * change or remove anything: only lstat, realpath, readdir and O_RDONLY opens are imported.
 * Every function returns a status union and never leaks a path to its caller.
 */

export const TASK_ID_RE = /^BR-[0-9]{8}-[0-9]{4,6}$/;

export function isTaskId(s: unknown): s is string {
  return typeof s === "string" && s.length <= 20 && TASK_ID_RE.test(s);
}

/** The only file names this module will ever open; never derived from input. */
export const FILE_NAMES = {
  events: "events.jsonl",
  state: "state.json",
  governor: "governor.json",
  audit: "audit.jsonl",
} as const;
export type SafeFileName = (typeof FILE_NAMES)[keyof typeof FILE_NAMES];
const ALLOWED_NAMES = new Set<string>(Object.values(FILE_NAMES));

export const CAPS = {
  eventsFull: 32 * 1024 * 1024,
  eventsTail: 256 * 1024,
  taskState: 8 * 1024 * 1024,
  governor: 64 * 1024,
  gateState: 4 * 1024 * 1024,
  auditTail: 512 * 1024,
} as const;

export type DirCheck = { status: "ok" } | { status: "missing" } | { status: "unsafe"; reason: string };

export type ReadResult =
  | { status: "ok"; data: Buffer; size: number }
  | { status: "missing" }
  | { status: "unsafe"; reason: string }
  | { status: "too_large"; size: number }
  | { status: "error" };

export type TailResult =
  | { status: "ok"; data: Buffer; size: number; offset: number; partial: boolean }
  | { status: "missing" }
  | { status: "unsafe"; reason: string }
  | { status: "error" };

function errCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined;
}

function uid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

/** A real directory we own, whose canonical path is exactly the expected one (no symlink anywhere). */
export async function checkDir(p: string, expectedRealPath: string): Promise<DirCheck> {
  let st;
  try {
    st = await lstat(p);
  } catch (e) {
    if (errCode(e) === "ENOENT" || errCode(e) === "ENOTDIR") return { status: "missing" };
    return { status: "unsafe", reason: "lstat failed" };
  }
  if (st.isSymbolicLink()) return { status: "unsafe", reason: "symlink" };
  if (!st.isDirectory()) return { status: "unsafe", reason: "not a directory" };
  const me = uid();
  if (me !== null && st.uid !== me) return { status: "unsafe", reason: "not owned by this user" };
  try {
    const real = await realpath(p);
    if (real !== expectedRealPath) return { status: "unsafe", reason: "path resolves elsewhere" };
  } catch {
    return { status: "unsafe", reason: "realpath failed" };
  }
  return { status: "ok" };
}

/** realpath of a directory, or null when missing/unresolvable. Used to build expected paths. */
export async function realDir(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

type Opened =
  | { status: "ok"; fh: Awaited<ReturnType<typeof open>>; size: number }
  | { status: "missing" }
  | { status: "unsafe"; reason: string }
  | { status: "error" };

async function openSafe(dir: string, name: SafeFileName): Promise<Opened> {
  if (!ALLOWED_NAMES.has(name)) return { status: "unsafe", reason: "file name not allowed" };
  let fh;
  try {
    // O_NONBLOCK: a FIFO in place of a file must not park the call until a writer appears; fstat then rejects it
    fh = await open(path.join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = errCode(e);
    if (code === "ENOENT" || code === "ENOTDIR") return { status: "missing" };
    if (code === "ELOOP" || code === "EMLINK") return { status: "unsafe", reason: "symlink" };
    return { status: "error" };
  }
  try {
    const st = await fh.stat();
    const me = uid();
    if (!st.isFile()) {
      await fh.close();
      return { status: "unsafe", reason: "not a regular file" };
    }
    if (me !== null && st.uid !== me) {
      await fh.close();
      return { status: "unsafe", reason: "not owned by this user" };
    }
    if (st.nlink !== 1) {
      await fh.close();
      return { status: "unsafe", reason: "hard-linked" };
    }
    return { status: "ok", fh, size: st.size };
  } catch {
    await fh.close().catch(() => undefined);
    return { status: "error" };
  }
}

async function readRange(fh: Awaited<ReturnType<typeof open>>, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await fh.read(buf, filled, length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled === length ? buf : buf.subarray(0, filled);
}

/** The whole file, when it is at most `cap` bytes. Reads only from the opened handle (no TOCTOU). */
export async function readCapped(dir: string, name: SafeFileName, cap: number): Promise<ReadResult> {
  const o = await openSafe(dir, name);
  if (o.status !== "ok") return o;
  try {
    if (o.size > cap) return { status: "too_large", size: o.size };
    const data = await readRange(o.fh, 0, o.size);
    return { status: "ok", data, size: o.size };
  } catch {
    return { status: "error" };
  } finally {
    await o.fh.close().catch(() => undefined);
  }
}

/** The last `maxBytes` of the file. `offset` is where the returned bytes start in the file. */
export async function readTail(dir: string, name: SafeFileName, maxBytes: number): Promise<TailResult> {
  const o = await openSafe(dir, name);
  if (o.status !== "ok") return o;
  try {
    const n = Math.min(o.size, maxBytes);
    const offset = o.size - n;
    const data = await readRange(o.fh, offset, n);
    return { status: "ok", data, size: o.size, offset, partial: offset > 0 };
  } catch {
    return { status: "error" };
  } finally {
    await o.fh.close().catch(() => undefined);
  }
}

// ---- transcript primitives --------------------------------------------------------------------------
// Same no-follow, owner-only, regular-file, single-link checks as openSafe above, but the file name is
// checked against a fixed pattern instead of a fixed allowlist (transcript file names vary: one per
// session or subagent). Still read-only: only O_RDONLY opens, lstat/readdir/realpath are ever used.

export const TRANSCRIPT_PATTERNS = {
  projectDir: /^[A-Za-z0-9._-]{1,255}$/,
  session: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.jsonl)?$/,
  subagentsDirName: "subagents",
  agent: /^agent-[A-Za-z0-9_-]{1,64}\.jsonl$/,
  agentMeta: /^agent-[A-Za-z0-9_-]{1,64}\.meta\.json$/,
} as const;

export const TRANSCRIPT_CAPS = {
  metaJson: 64 * 1024,
} as const;

async function openChecked(dir: string, name: string, nameOk: boolean): Promise<Opened> {
  if (!nameOk || name.includes("/") || name.includes("\0")) return { status: "unsafe", reason: "file name not allowed" };
  let fh;
  try {
    fh = await open(path.join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = errCode(e);
    if (code === "ENOENT" || code === "ENOTDIR") return { status: "missing" };
    if (code === "ELOOP" || code === "EMLINK") return { status: "unsafe", reason: "symlink" };
    return { status: "error" };
  }
  try {
    const st = await fh.stat();
    const me = uid();
    if (!st.isFile()) {
      await fh.close();
      return { status: "unsafe", reason: "not a regular file" };
    }
    if (me !== null && st.uid !== me) {
      await fh.close();
      return { status: "unsafe", reason: "not owned by this user" };
    }
    if (st.nlink !== 1) {
      await fh.close();
      return { status: "unsafe", reason: "hard-linked" };
    }
    return { status: "ok", fh, size: st.size };
  } catch {
    await fh.close().catch(() => undefined);
    return { status: "error" };
  }
}

export interface ListedEntry {
  name: string;
  isDirectory: boolean;
  isSymlink: boolean;
}

export interface ListEntriesResult {
  status: "ok" | "missing" | "unsafe";
  entries: ListedEntry[];
}

/** A raw directory listing (never followed, never opened): the caller matches names and skips symlinks. */
export async function listEntries(dir: string): Promise<ListEntriesResult> {
  let raw;
  try {
    raw = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    const code = errCode(e);
    if (code === "ENOENT" || code === "ENOTDIR") return { status: "missing", entries: [] };
    return { status: "unsafe", entries: [] };
  }
  return { status: "ok", entries: raw.map((d) => ({ name: d.name, isDirectory: d.isDirectory(), isSymlink: d.isSymbolicLink() })) };
}

/** openSafe's checks, against a pattern instead of the fixed allowlist. */
export async function openPatterned(dir: string, name: string, pattern: RegExp): Promise<Opened> {
  return openChecked(dir, name, pattern.test(name));
}

export async function readCappedPatterned(dir: string, name: string, pattern: RegExp, cap: number): Promise<ReadResult> {
  const o = await openPatterned(dir, name, pattern);
  if (o.status !== "ok") return o;
  try {
    if (o.size > cap) return { status: "too_large", size: o.size };
    const data = await readRange(o.fh, 0, o.size);
    return { status: "ok", data, size: o.size };
  } catch {
    return { status: "error" };
  } finally {
    await o.fh.close().catch(() => undefined);
  }
}

export interface StreamLinesResult {
  status: "ok" | "missing" | "unsafe" | "error";
  reason?: string;
  size: number;
  /** Byte offset right after the last complete line handed to `onLine` (the resume point). */
  newOffset: number;
  /** Lines (complete or still-open at EOF) longer than `lineCap`, discarded without being buffered past the cap. */
  oversizeLines: number;
}

/**
 * Reads `name` in `dir` from `fromOffset`, in 1 MiB chunks, calling `onLine` with each complete line
 * (without its trailing `\n`) and its starting byte offset. A final incomplete line (no trailing `\n`
 * yet) is left for the next call. A line longer than `lineCap` is never buffered past the cap: once its
 * end is found (or EOF, if it never ends) it is dropped and counted in `oversizeLines`; `onOversize`, when
 * given, is called once with the up-to-`lineCap` prefix bytes seen before the drop, so the caller can
 * classify it (for example as a dropped assistant line) without ever holding the full line.
 */
export async function streamLines(
  dir: string,
  name: string,
  pattern: RegExp,
  fromOffset: number,
  lineCap: number,
  onLine: (line: Buffer, startOffset: number) => void,
  onOversize?: (prefix: Buffer) => void,
): Promise<StreamLinesResult> {
  const o = await openPatterned(dir, name, pattern);
  if (o.status !== "ok") {
    return { status: o.status, reason: "reason" in o ? o.reason : undefined, size: 0, newOffset: fromOffset, oversizeLines: 0 };
  }
  try {
    const size = o.size;
    if (fromOffset < 0 || fromOffset > size) return { status: "ok", size, newOffset: 0, oversizeLines: 0 };
    const CHUNK = 1024 * 1024;
    let pos = fromOffset;
    let leftover = Buffer.alloc(0);
    let lineStart = fromOffset;
    let oversizeLines = 0;
    // R6: while discarding, no bytes are ever retained across a chunk boundary — only `lineStart` moves,
    // by exactly the bytes skipped — so a line many chunks past the cap never grows `leftover`.
    let discarding = false;
    // R6: the offset the still-open oversize line began at, returned as newOffset if EOF hits before it
    // ends (so a later resume rescans it from its true start, not from wherever lineStart has drifted to).
    let discardStart = 0;
    while (pos < size) {
      const toRead = Math.min(CHUNK, size - pos);
      const buf = Buffer.allocUnsafe(toRead);
      const { bytesRead } = await o.fh.read(buf, 0, toRead, pos);
      if (bytesRead === 0) break;
      pos += bytesRead;
      let chunk = buf.subarray(0, bytesRead);

      if (discarding) {
        const nl = chunk.indexOf(0x0a);
        if (nl < 0) {
          lineStart += chunk.length; // still inside the oversize line: skip the whole chunk, keep nothing
          continue;
        }
        oversizeLines++;
        discarding = false;
        lineStart += nl + 1;
        chunk = chunk.subarray(nl + 1); // the remainder of this chunk is ordinary data, processed below
      }

      const combined = leftover.length > 0 ? Buffer.concat([leftover, chunk]) : chunk;
      let start = 0;
      for (;;) {
        const nl = combined.indexOf(0x0a, start);
        if (nl < 0) break;
        const line = combined.subarray(start, nl);
        if (line.length > lineCap) {
          oversizeLines++;
          onOversize?.(line.subarray(0, lineCap));
        } else onLine(line, lineStart);
        lineStart += nl - start + 1;
        start = nl + 1;
      }
      leftover = combined.subarray(start);
      if (leftover.length > lineCap) {
        discarding = true;
        discardStart = lineStart;
        onOversize?.(leftover.subarray(0, lineCap));
        lineStart += leftover.length; // R6: count the dropped bytes so a later line's offset stays exact
        leftover = Buffer.alloc(0);
      }
    }
    const newOffset = discarding ? discardStart : pos - leftover.length;
    return { status: "ok", size, newOffset, oversizeLines };
  } catch {
    return { status: "error", size: 0, newOffset: fromOffset, oversizeLines: 0 };
  } finally {
    await o.fh.close().catch(() => undefined);
  }
}

export type StatPatternedResult = { status: "ok"; dev: number; ino: number; size: number; mtimeMs: number } | { status: "missing" | "unsafe" | "error" };

/** The memo key fields (dev, ino, size, mtimeMs) for a patterned file, from the same safety-checked open as every read. */
export async function statPatterned(dir: string, name: string, pattern: RegExp): Promise<StatPatternedResult> {
  const o = await openPatterned(dir, name, pattern);
  if (o.status !== "ok") return { status: o.status };
  try {
    const st = await o.fh.stat();
    return { status: "ok", dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return { status: "error" };
  } finally {
    await o.fh.close().catch(() => undefined);
  }
}

/** sha256 of up to the last `n` bytes before `offset`, used to confirm a grown file is the same file before resuming. */
export async function readAnchor(dir: string, name: string, pattern: RegExp, offset: number, n: number): Promise<{ status: "ok"; hash: string } | { status: "missing" | "unsafe" | "error" }> {
  const o = await openPatterned(dir, name, pattern);
  if (o.status !== "ok") return { status: o.status };
  try {
    const start = Math.max(0, offset - n);
    const len = offset - start;
    if (len <= 0) return { status: "ok", hash: createHash("sha256").digest("hex") };
    const data = await readRange(o.fh, start, len);
    return { status: "ok", hash: createHash("sha256").update(data).digest("hex") };
  } catch {
    return { status: "error" };
  } finally {
    await o.fh.close().catch(() => undefined);
  }
}

export interface TaskDirListing {
  status: "ok" | "missing" | "unsafe";
  ids: string[];
  unsafeEntries: number;
  scanLimitReached: boolean;
}

/** Task ids under the tasks root: real directories with well-formed names, newest first, capped. */
export async function listTaskDirs(tasksDir: string, limit = 200): Promise<TaskDirListing> {
  let entries;
  try {
    entries = await readdir(tasksDir, { withFileTypes: true });
  } catch (e) {
    const code = errCode(e);
    if (code === "ENOENT" || code === "ENOTDIR") return { status: "missing", ids: [], unsafeEntries: 0, scanLimitReached: false };
    return { status: "unsafe", ids: [], unsafeEntries: 0, scanLimitReached: false };
  }
  const ids: string[] = [];
  let unsafeEntries = 0;
  for (const d of entries) {
    const looksLikeId = isTaskId(d.name);
    if (d.isSymbolicLink()) {
      unsafeEntries++;
    } else if (looksLikeId && d.isDirectory()) {
      ids.push(d.name);
    } else if (looksLikeId) {
      unsafeEntries++; // a task-named entry that is not a directory
    }
    // other names (lock files, editor droppings) are ignored
  }
  ids.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const scanLimitReached = ids.length > limit;
  return { status: "ok", ids: ids.slice(0, limit), unsafeEntries, scanLimitReached };
}
