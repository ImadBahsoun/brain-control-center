import "server-only";
import type { Finding, FindingsCount, Severity, TopFinding } from "@/lib/api-types";
import { asArr, asInt, asObj, asStr, asStrArr } from "./jsonish";

export const SEVERITIES: readonly Severity[] = ["BLOCKER", "MAJOR", "MINOR", "NIT"];
const SEVERITY_RANK: Record<string, number> = { BLOCKER: 0, MAJOR: 1, MINOR: 2, NIT: 3 };
export const OPEN_STATUSES = new Set<string>(["OPEN", "ACKNOWLEDGED", "FIXED", "REVALIDATED"]);
const RESOLVING = new Set<string>(["FIXED", "REVALIDATED", "CLOSED", "REJECTED", "DEFERRED"]);

export function isSeverity(v: string): v is Severity {
  return v in SEVERITY_RANK;
}

/** Severity and status are shown as recorded; an unrecorded value becomes "unknown", never a known label. */
function label(v: unknown): string {
  return asStr(v) ?? "unknown";
}

/** The cache's `findings` object → explicit, allowlisted Finding records, sorted by severity then id. */
export function projectFindings(raw: unknown): Finding[] {
  const o = asObj(raw);
  if (!o) return [];
  const out: Finding[] = [];
  for (const [key, v] of Object.entries(o)) {
    const f = asObj(v);
    if (!f) continue;
    const history = asArr(f.history)
      .map(asObj)
      .filter((h): h is NonNullable<typeof h> => h !== null)
      .map((h) => ({ status: asStr(h.status) ?? "", reason: asStr(h.reason), ts: asStr(h.ts) }));
    const status = label(f.status);
    // a resolution only while the finding currently is in a resolving status; a reopened finding has none
    const last = history[history.length - 1];
    const resolution = RESOLVING.has(status)
      ? { status, reason: last?.status === status ? last.reason : null, ts: last?.status === status ? last.ts : null }
      : null;
    out.push({
      id: asStr(f.id) ?? key,
      aliases: asStrArr(f.aliases),
      severity: label(f.severity),
      status,
      sources: asStrArr(f.sources),
      title: asStr(f.title) ?? "",
      location: asStr(f.location),
      recommendation: asStr(f.recommendation),
      description: asStr(f.description),
      introducedRound: asInt(f.introduced_round),
      fixedRound: asInt(f.fixed_round),
      validatedRound: asInt(f.validated_round),
      createdAt: asStr(f.created_at),
      updatedAt: asStr(f.updated_at),
      resolution,
      history,
    });
  }
  const rank = (s: string) => SEVERITY_RANK[s] ?? SEVERITIES.length; // unrecognised severities sort last
  out.sort((a, b) => rank(a.severity) - rank(b.severity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

export function emptyCount(): FindingsCount {
  return { total: 0, open: 0, openBySeverity: { BLOCKER: 0, MAJOR: 0, MINOR: 0, NIT: 0 } };
}

/**
 * The cache's `findings_summary`, falling back to a count over the projected findings. In the fallback an
 * open finding with an unrecognised severity counts as open but in no severity bucket (brain-state has no
 * bucket for it either).
 */
export function summarizeFindings(summaryRaw: unknown, findings: readonly Finding[]): FindingsCount {
  const s = asObj(summaryRaw);
  const bySev = s ? asObj(s.open_by_severity) : null;
  if (s && bySev && asInt(s.total) !== null && asInt(s.open) !== null) {
    const openBySeverity = { ...emptyCount().openBySeverity };
    for (const sev of SEVERITIES) openBySeverity[sev] = asInt(bySev[sev]) ?? 0;
    return { total: asInt(s.total) ?? 0, open: asInt(s.open) ?? 0, openBySeverity };
  }
  const out = emptyCount();
  out.total = findings.length;
  for (const f of findings) {
    if (OPEN_STATUSES.has(f.status)) {
      out.open++;
      if (isSeverity(f.severity)) out.openBySeverity[f.severity]++;
    }
  }
  return out;
}

export function aliasMap(findings: readonly Finding[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of findings) {
    m.set(f.id, f.id);
    for (const a of f.aliases) m.set(a, f.id);
  }
  return m;
}

export function topOpenFindings(findings: readonly Finding[], n = 5): TopFinding[] {
  const top: TopFinding[] = [];
  for (const f of findings) {
    if (top.length >= n) break;
    if (!OPEN_STATUSES.has(f.status)) continue;
    if (f.severity === "BLOCKER" || f.severity === "MAJOR") top.push({ id: f.id, severity: f.severity, title: f.title });
  }
  return top;
}
