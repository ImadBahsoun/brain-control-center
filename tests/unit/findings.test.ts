import { describe, expect, it } from "vitest";
import { aliasMap, projectFindings, summarizeFindings, topOpenFindings } from "@/server/brain/findings";
import { buildLog, deriveState, highRiskScript } from "../helpers/fixture-store";

const TID = "BR-20261007-0001";

function findingsFromScript() {
  const specs = highRiskScript("/tmp/home", { complete: true });
  // SEQ refs are irrelevant for findings; derive directly
  const built = buildLog(TID, specs);
  return deriveState(TID, built);
}

describe("findings projection", () => {
  it("projects allowlisted fields, sorted by severity then id, with history and resolution", () => {
    const st = findingsFromScript();
    const list = projectFindings(st.findings);
    expect(list.map((f) => f.id)).toEqual(["F-001", "F-002"]);
    expect(list[0]?.severity).toBe("MAJOR");
    expect(list[0]?.status).toBe("CLOSED");
    expect(list[0]?.aliases).toEqual(["R1"]);
    expect(list[0]?.sources).toEqual(["reviewer"]);
    expect(list[0]?.location).toBe("src/server/http.ts:12");
    expect(list[0]?.recommendation).toBe("check Origin");
    expect(list[0]?.introducedRound).toBe(0);
    expect(list[0]?.fixedRound).toBe(1);
    expect(list[0]?.validatedRound).toBe(1);
    expect(list[0]?.history.map((h) => h.status)).toEqual(["OPEN", "ACKNOWLEDGED", "FIXED", "REVALIDATED", "CLOSED"]);
    expect(list[0]?.resolution?.status).toBe("CLOSED");
    expect(list[1]?.id).toBe("F-002");
    expect(list[1]?.status).toBe("DEFERRED");
    expect(list[1]?.resolution).toEqual({ status: "DEFERRED", reason: "follow-up", ts: expect.any(String) });
    // nothing beyond the allowlist
    expect(Object.keys(list[0] ?? {}).sort()).toEqual(
      ["aliases", "createdAt", "description", "fixedRound", "history", "id", "introducedRound", "location", "recommendation", "resolution", "severity", "sources", "status", "title", "updatedAt", "validatedRound"].sort(),
    );
  });

  it("sorts BLOCKER before MAJOR before MINOR before NIT and then by id", () => {
    const raw = {
      "F-003": { id: "F-003", severity: "NIT", status: "OPEN", title: "c", aliases: [], sources: [], history: [] },
      "F-001": { id: "F-001", severity: "MINOR", status: "OPEN", title: "a", aliases: [], sources: [], history: [] },
      "F-002": { id: "F-002", severity: "BLOCKER", status: "OPEN", title: "b", aliases: ["S1"], sources: [], history: [] },
      "F-004": { id: "F-004", severity: "BLOCKER", status: "REJECTED", title: "d", aliases: [], sources: [], history: [{ status: "OPEN" }, { status: "REJECTED", reason: "dup" }] },
    };
    const list = projectFindings(raw);
    expect(list.map((f) => f.id)).toEqual(["F-002", "F-004", "F-001", "F-003"]);
    expect(list[1]?.resolution?.reason).toBe("dup");
    expect(list[0]?.resolution).toBeNull();
  });

  it("maps aliases and ids to F-ids", () => {
    const st = findingsFromScript();
    const m = aliasMap(projectFindings(st.findings));
    expect(m.get("R1")).toBe("F-001");
    expect(m.get("Q1")).toBe("F-002");
    expect(m.get("F-002")).toBe("F-002");
  });

  it("takes the summary from findings_summary and falls back to counting", () => {
    const st = findingsFromScript();
    const list = projectFindings(st.findings);
    const s = summarizeFindings(st.findings_summary, list);
    expect(s.total).toBe(2);
    expect(s.open).toBe(0);
    const fallback = summarizeFindings(undefined, projectFindings({ "F-001": { severity: "MAJOR", status: "OPEN", title: "t" }, "F-002": { severity: "MAJOR", status: "CLOSED", title: "u" } }));
    expect(fallback).toEqual({ total: 2, open: 1, openBySeverity: { BLOCKER: 0, MAJOR: 1, MINOR: 0, NIT: 0 } });
  });

  it("lists at most five open BLOCKER/MAJOR findings", () => {
    const raw: Record<string, unknown> = {};
    for (let i = 1; i <= 8; i++) raw[`F-00${i}`] = { id: `F-00${i}`, severity: i % 2 ? "BLOCKER" : "MINOR", status: "OPEN", title: `t${i}` };
    const top = topOpenFindings(projectFindings(raw));
    expect(top).toHaveLength(4);
    expect(top.every((f) => f.severity === "BLOCKER")).toBe(true);
    expect(Object.keys(top[0] ?? {})).toEqual(["id", "severity", "title"]);
  });

  it("shows no resolution once a finding was reopened, and takes it from the latest history entry otherwise", () => {
    const raw = {
      "F-001": {
        id: "F-001",
        severity: "MAJOR",
        status: "ACKNOWLEDGED",
        title: "reopened",
        history: [{ status: "OPEN" }, { status: "ACKNOWLEDGED" }, { status: "FIXED", reason: "first try", ts: "2026-10-07T08:00:00Z" }, { status: "ACKNOWLEDGED", reason: "revalidation failed" }],
      },
      "F-002": {
        id: "F-002",
        severity: "MINOR",
        status: "FIXED",
        title: "fixed twice",
        history: [{ status: "OPEN" }, { status: "FIXED", reason: "first" }, { status: "ACKNOWLEDGED", reason: "regressed" }, { status: "FIXED", reason: "second", ts: "2026-10-07T09:00:00Z" }],
      },
      "F-003": { id: "F-003", severity: "NIT", status: "DEFERRED", title: "no history", history: "nope" },
    };
    const list = projectFindings(raw);
    expect(list.find((f) => f.id === "F-001")?.resolution).toBeNull();
    expect(list.find((f) => f.id === "F-002")?.resolution).toEqual({ status: "FIXED", reason: "second", ts: "2026-10-07T09:00:00Z" });
    expect(list.find((f) => f.id === "F-003")?.resolution).toEqual({ status: "DEFERRED", reason: null, ts: null });
  });

  it("shows unrecognised severities and statuses as recorded, sorts them last and never counts them as a known open severity", () => {
    const raw = {
      "F-001": { id: "F-001", severity: "CRITICAL", status: "WONTFIX", title: "odd" },
      "F-002": { id: "F-002", severity: null, status: "OPEN", title: "no severity" },
      "F-003": { id: "F-003", severity: "NIT", status: "OPEN", title: "nit" },
      "F-004": { id: "F-004", severity: "MAJOR", status: "ESCALATED", title: "odd status" },
    };
    const list = projectFindings(raw);
    expect(list.map((f) => [f.id, f.severity, f.status])).toEqual([
      ["F-004", "MAJOR", "ESCALATED"],
      ["F-003", "NIT", "OPEN"],
      ["F-001", "CRITICAL", "WONTFIX"],
      ["F-002", "unknown", "OPEN"],
    ]);
    expect(list.every((f) => f.resolution === null)).toBe(true);
    const count = summarizeFindings(undefined, list);
    // F-002 is open by status but has no known severity bucket; F-001 and F-004 are not in an open status
    expect(count).toEqual({ total: 4, open: 2, openBySeverity: { BLOCKER: 0, MAJOR: 0, MINOR: 0, NIT: 1 } });
    expect(topOpenFindings(list)).toEqual([]);
    const text = JSON.stringify(list);
    expect(text).not.toContain('"severity":"MINOR"');
    expect(text).toContain("CRITICAL");
  });

  it("returns nothing for a non-object", () => {
    expect(projectFindings(null)).toEqual([]);
    expect(projectFindings([1, 2])).toEqual([]);
  });
});
