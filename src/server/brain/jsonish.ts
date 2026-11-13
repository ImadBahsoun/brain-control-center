import "server-only";

/** Tolerant accessors for parsed JSON of unknown shape (state.json, governor.json, gate files). */
export type JsonObj = Record<string, unknown>;

export function asObj(v: unknown): JsonObj | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as JsonObj) : null;
}

export function asStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function asInt(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

export function asNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function asBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

export function asArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function asStrArr(v: unknown): string[] {
  return asArr(v).filter((x): x is string => typeof x === "string");
}

/** A string, or a list of strings, as a list (brain-state's "strs" kind). */
export function asStrs(v: unknown): string[] {
  if (typeof v === "string") return [v];
  return asStrArr(v);
}

export function asStrRecord(v: unknown): Record<string, string> {
  const o = asObj(v);
  const out: Record<string, string> = {};
  if (!o) return out;
  for (const [k, x] of Object.entries(o)) if (typeof x === "string") out[k] = x;
  return out;
}

export function parseJson(buf: Buffer): unknown | undefined {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buf)) as unknown;
  } catch {
    return undefined;
  }
}

/** Epoch seconds (the gate's floats) or an ISO string → ISO string, or null. */
export function toIso(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    const d = new Date(v * 1000);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  return null;
}

export function epochMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}
