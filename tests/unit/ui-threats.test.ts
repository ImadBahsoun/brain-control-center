import { describe, expect, it } from "vitest";
import type { EventSpec } from "../helpers/fixture-store";
import { selectFindingsScope, selectMapThreats, selectRailThreats, sortThreats, threatAnchor, threatClass } from "@/lib/ui/threats";
import { freshHome, highRiskScript, mkdirs, standardScript, writeScript } from "../helpers/fixture-store";
import { apiFindings, apiTasks } from "../helpers/ui-fixtures";

const ID = "BR-20261007-0001";

/** A STANDARD mission whose developer reported, then eight findings of mixed severity and status. */
function manyFindings(home: string): EventSpec[] {
  const specs = standardScript(home);
  const sev = ["NIT", "MINOR", "BLOCKER", "MAJOR", "MINOR", "MAJOR", "NIT", "MINOR"];
  const sources = ["qa", "reviewer", "security-reviewer", "brain", "qa", "reviewer", "unknown-tool", "security-reviewer"];
  sev.forEach((severity, i) => {
    specs.push({ type: "FINDING_CREATED", payload: { alias: `X${i + 1}`, severity, source: sources[i], title: `Finding ${i + 1}` }, state: "SYNTHESIZING" });
  });
  specs.push({ type: "FINDING_UPDATED", payload: { alias: "X1", status: "CLOSED" } });
  specs.push({ type: "FINDING_UPDATED", payload: { alias: "X2", status: "FIXED" } });
  specs.push({ type: "FINDING_UPDATED", payload: { alias: "X7", status: "DEFERRED", reason: "later" } });
  specs.push({ type: "FINDING_UPDATED", payload: { alias: "X8", status: "WEIRD" } });
  return specs;
}

describe("threat classification and selection", () => {
  it("classifies every finding status and anchors on the first recognised role source", () => {
    expect(threatClass({ status: "OPEN" })).toBe("active");
    expect(threatClass({ status: "ACKNOWLEDGED" })).toBe("active");
    expect(threatClass({ status: "FIXED" })).toBe("neutralizing");
    expect(threatClass({ status: "REVALIDATED" })).toBe("neutralizing");
    expect(threatClass({ status: "CLOSED" })).toBe("resolved");
    expect(threatClass({ status: "DEFERRED" })).toBe("dismissed");
    expect(threatClass({ status: "REJECTED" })).toBe("dismissed");
    expect(threatClass({ status: "WEIRD" })).toBe("unknown");
    expect(threatAnchor(["reviewer"])).toBe("reviewer");
    expect(threatAnchor(["brain"])).toBe("core");
    expect(threatAnchor(["unknown-tool", "qa"])).toBe("qa");
    expect(threatAnchor([])).toBe("core");
  });
  it("sorts open before resolved, then by severity, caps the map at 6 and reports the overflow", async () => {
    const home = freshHome();
    mkdirs(home);
    writeScript(home, ID, manyFindings(home));
    const { findings } = await apiFindings(ID);
    expect(findings).toHaveLength(8);
    const sorted = sortThreats(findings);
    // active: X3 BLOCKER, then the two MAJORs newest first (X6, X4), X5 MINOR; neutralizing: X2 (FIXED); unknown: X8; resolved: X1; dismissed: X7
    expect(sorted.map((f) => f.aliases[0])).toEqual(["X3", "X6", "X4", "X5", "X2", "X8", "X1", "X7"]);
    const map = selectMapThreats(findings);
    expect(map.shown.map((f) => f.aliases[0])).toEqual(["X3", "X6", "X4", "X5", "X2", "X8"]);
    expect(map.overflow).toBe(2);
    expect(selectMapThreats(findings, 2).overflow).toBe(6);
    expect(selectMapThreats([])).toEqual({ shown: [], overflow: 0 });
    expect(sortThreats(findings)).toEqual(sortThreats([...findings].reverse())); // deterministic
  });
  it("the rail lists open findings first, then at most 5 recently resolved, capped at 10", async () => {
    const home = freshHome();
    mkdirs(home);
    writeScript(home, ID, manyFindings(home));
    const { findings } = await apiFindings(ID);
    const rail = selectRailThreats(findings);
    expect(rail.slice(0, 5).map((f) => f.aliases[0])).toEqual(["X3", "X6", "X4", "X5", "X2"]);
    expect(rail.length).toBe(8);
    expect(selectRailThreats(findings, 6)).toHaveLength(6);
  });
  it("the complete HIGH-RISK fixture has only settled findings and no active threat", async () => {
    const home = freshHome();
    mkdirs(home);
    writeScript(home, ID, highRiskScript(home, { complete: true }));
    const { findings } = await apiFindings(ID);
    expect(findings.map((f) => [f.id, threatClass(f)])).toEqual([
      ["F-001", "resolved"],
      ["F-002", "dismissed"],
    ]);
  });
});

describe("selectFindingsScope", () => {
  it("polls every non-terminal task live and fetches the newest terminal ones once, capped at 8 in total", async () => {
    const home = freshHome();
    mkdirs(home);
    for (let i = 1; i <= 10; i++) {
      const id = `BR-20261007-${String(i).padStart(4, "0")}`;
      const script = i % 4 === 0 ? standardScript(home, { pendingDeveloper: true }) : highRiskScript(home, { complete: true });
      writeScript(home, id, script);
    }
    const { tasks } = await apiTasks();
    expect(tasks.map((t) => t.id)[0]).toBe("BR-20261007-0010"); // newest first
    const scope = selectFindingsScope(tasks);
    expect(scope.live).toEqual(["BR-20261007-0008", "BR-20261007-0004"]);
    expect(scope.settled).toEqual(["BR-20261007-0010", "BR-20261007-0009", "BR-20261007-0007", "BR-20261007-0006", "BR-20261007-0005", "BR-20261007-0003"]);
    expect(scope.live.length + scope.settled.length).toBe(8);
    const small = selectFindingsScope(tasks, 3);
    expect(small.live).toHaveLength(2);
    expect(small.settled).toHaveLength(1);
    expect(selectFindingsScope([])).toEqual({ live: [], settled: [] });
  });
});
