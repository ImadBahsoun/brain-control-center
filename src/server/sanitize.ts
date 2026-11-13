import "server-only";
import os from "node:os";

/**
 * Output sanitation. `redact` is a port of brain-state's redactor (same patterns, same order, same
 * bounded quantifiers; Python's (?i) becomes the `i` flag, and `\w`/`\b` are ASCII in JS).
 * `sanitizeString` runs redaction first, then home → "~", then escapes control and bidi characters,
 * and clips to `max` last, so a cut-off secret can never slip past the patterns.
 */

const VALUE = String.raw`(?:\\?"(?:[^"\\]|\\.){0,1024}\\?"|'[^'\n]{0,1024}'|\S{1,256})`;
const SECRET_WORDS = String.raw`(?:password|passwd|passphrase|pwd|token|secret|credential|api[_-]?key|private[_-]?key|access[_-]?key|authorization)`;

const RED: Array<[RegExp, string]> = [
  [/:\/\/[^\s@/]{1,256}@/g, "://***@"],
  [/(\bsend\s{1,16}(?:--\s{1,16})?)(['"])(?:(?!\2).){0,1024}\2/g, "$1$2***$2"],
  [/(Authorization:\s{0,16})\S{1,256}\s{1,16}\S{1,256}/gi, "$1***"],
  [/\b(Bearer)[ \t]{1,16}[A-Za-z0-9._~+/=\-]{8,2048}/gi, "$1 ***"],
  [/(X-API-Key:\s{0,16})\S{1,256}/gi, "$1***"],
  [/(Cookie:\s{0,16})[^\n]{1,4096}/gi, "$1***"],
  [/(--(?:password|token|api-key|secret))(?:=|\s{1,16})\S{1,256}/g, "$1=***"],
  [/(?<!\S)(-u)\s{1,16}[^\s:]{1,256}:\S{1,256}/g, "$1 ***"],
  [/\b(Basic)[ \t]{1,16}[A-Za-z0-9+/=]{8,2048}/gi, "$1 ***"],
  [/\b(?:ghp_|gho_|ghs_|ghu_|ghr_|github_pat_|glpat-|sk-|sk_live_|rk_live_|npm_|xox[abpe]-|AKIA|AIza)[A-Za-z0-9_\-]{1,256}/g, "***"],
  [/\beyJ[A-Za-z0-9_\-]{4,2048}\.[A-Za-z0-9_\-]{4,2048}\.[A-Za-z0-9_\-]{4,2048}/g, "***"],
];

// a 40-character AWS-style secret: base64 alphabet with upper and lower case and a digit, never starting
// with a slash, and with enough distinct characters to look random
const RED_AWS =
  /(?<![A-Za-z0-9+/=])(?=[A-Za-z0-9+/]{0,39}[A-Z])(?=[A-Za-z0-9+/]{0,39}[a-z])(?=[A-Za-z0-9+/]{0,39}[0-9])[A-Za-z0-9+][A-Za-z0-9+/]{39}(?![A-Za-z0-9+/=])/g;

const RED_PEM = /-----BEGIN ([A-Z ]{1,64}?)-----[\s\S]{0,16384}?-----END \1-----/g;
const RED_PEM_OPEN = /-----BEGIN ([A-Z ]{1,64}?)-----/g;

const RED_KV: RegExp[] = [
  new RegExp(String.raw`\b(\w{0,64}(?:PASS|PASSWD|PWD|TOKEN|SECRET|KEY)\w{0,64}=)` + VALUE, "gi"),
  new RegExp(
    String.raw`(?<![\w.\-])((?:\\?["'])?[\w.\-]{0,64}` + SECRET_WORDS + String.raw`[\w.\-]{0,64}(?:\\?["'])?[ \t]{0,16}[:=][ \t]{0,16})` + VALUE,
    "gi",
  ),
];

const RED_P = /(?<!\S)-p\s{0,16}\S{1,256}/g;
const RED_P_TRIGGER = /\b(mysql|mariadb|sshpass)\b/;
const RED_APPROVE = /\b(approve)((?:[ \t]{1,16}[A-Za-z0-9]{6}\b){1,32})/gi;
// dashboard-only addition: the protocol's "blocked; code <CODE>" report form
const RED_CODE = /\b(code[\s:=#]{1,4})([A-Za-z0-9]{6})\b/gi;
const CODE_TOKEN = /[A-Za-z0-9]{6}/g;
const GATE_CODE_RE = /^[ACDEFGHJKMNPQRTUVWXY3479]{6}$/;
const LINE_REF = /^\d{1,16}(:\d{1,16})?$/;

function maskKv(m: RegExpMatchArray): string {
  const whole = m[0];
  const prefix = m[1] ?? "";
  const value = whole.slice(prefix.length);
  if (LINE_REF.test(value)) return whole; // `password-reset.ts:55` is a location, not a secret
  const opening = /^\\?["']/.exec(value);
  const quote = opening && value.endsWith(opening[0].slice(-1)) ? opening[0] : "";
  return prefix + quote + "***" + quote;
}

function maskCodes(prefix: string, codes: string): string {
  return prefix + codes.replace(CODE_TOKEN, (t) => (GATE_CODE_RE.test(t.toUpperCase()) ? "******" : t));
}

function maskAws(s: string): string {
  return new Set(s).size >= 12 ? "***" : s;
}

export function redact(text: string): string {
  for (const [rx, rep] of RED) text = text.replace(rx, rep);
  text = text.replace(RED_AWS, maskAws);
  if (text.includes("-----END")) {
    text = text.replace(RED_PEM, "-----BEGIN $1-----***-----END $1-----");
  } else {
    let last: RegExpExecArray | null = null;
    RED_PEM_OPEN.lastIndex = 0;
    for (let m = RED_PEM_OPEN.exec(text); m !== null; m = RED_PEM_OPEN.exec(text)) last = m;
    if (last !== null && text.length - last.index <= 16384) {
      const kind = last[1] ?? "";
      text = text.slice(0, last.index) + `-----BEGIN ${kind}-----***-----END ${kind}-----`;
    }
  }
  for (const rx of RED_KV) text = text.replace(rx, (...args) => maskKv(args as unknown as RegExpMatchArray));
  if (RED_P_TRIGGER.test(text)) text = text.replace(RED_P, "-p ***");
  text = text.replace(RED_APPROVE, (_m, p1: string, p2: string) => maskCodes(p1, p2));
  return text.replace(RED_CODE, (_m, p1: string, p2: string) => (GATE_CODE_RE.test(p2.toUpperCase()) ? p1 + "******" : p1 + p2));
}

/**
 * Redaction runs on at most `max` + 32 KiB characters: every pattern window (16 KiB for PEM, less for
 * the rest) that starts inside the output still matches, and a crafted megabyte string stays cheap.
 */
const REDACT_WINDOW = 32 * 1024;

function preCut(s: string, max: number): string {
  return s.length > max + REDACT_WINDOW ? s.slice(0, max + REDACT_WINDOW) : s;
}

// C0 and C1 controls except \n and \t, the line/paragraph separators, and the bidi controls
const CTRL_RE = new RegExp("[\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]", "g");

export function escapeControls(s: string): string {
  return s.replace(CTRL_RE, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The home directory, as a prefix not followed by a path character, → "~". */
function homePattern(): RegExp | null {
  const home = os.homedir();
  return home && home !== "/" ? new RegExp(escapeRe(home) + String.raw`(?![A-Za-z0-9_\-.])`, "g") : null;
}

export const DEFAULT_MAX = 2000;

/**
 * The one way Brain text is shortened for output: redact first, then home → "~", escape controls, and only
 * then cut to `max` with an ellipsis. A secret straddling the cut is therefore masked before it is cut.
 */
export function sanitizeString(s: string, max: number = DEFAULT_MAX): string {
  let out = redact(preCut(s, max));
  const hp = homePattern();
  if (hp && out.includes(os.homedir())) out = out.replace(hp, "~");
  out = escapeControls(out);
  if (out.length > max) out = out.slice(0, Math.max(0, max - 1)) + "…";
  return out;
}

/** For hash-like fields (tree ids): redact first, then a plain prefix of `n` characters, no ellipsis. */
export function sanitizedPrefix(s: string, n: number): string {
  const out = redact(preCut(s, n));
  return out.length > n ? out.slice(0, n) : out;
}

const MAX_DEPTH = 8;

/** Applies sanitizeString to every string of a JSON value, keys included. Over-deep values become null. */
export function sanitizeDeep(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return sanitizeString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return null;
  if (Array.isArray(value)) return value.map((v) => sanitizeDeep(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[sanitizeString(k, 256)] = sanitizeDeep(v, depth + 1);
  }
  return out;
}
