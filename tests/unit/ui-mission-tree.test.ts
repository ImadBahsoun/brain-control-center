import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildMissionTree, defaultExpanded, isExpanded, MAX_INDENT, parentRefText, subMissionHint, visibleRows, type MissionRow, type TreeTask } from "@/lib/ui/mission-tree";

const id = (n: number) => `BR-20261109-${String(n).padStart(4, "0")}`;

interface T extends TreeTask {
  repository: string | null;
}

/** A mission: inactive (complete) unless told otherwise, no parent unless given. */
function mk(n: number, parent: number | string | null = null, over: Partial<T> = {}): T {
  return { id: id(n), parentTaskId: typeof parent === "number" ? id(parent) : parent, active: false, repository: "~/code/app", ...over };
}

const ids = (rows: readonly MissionRow<T>[]) => rows.map((r) => r.task.id);
const NO_TOGGLES: ReadonlyMap<string, boolean> = new Map();

describe("buildMissionTree", () => {
  it("leaves legacy missions (no parent, no children) as one plain row each, in the list's order", () => {
    const list = [mk(3), mk(2), mk(1)];
    const rows = buildMissionTree(list, list);
    expect(ids(rows)).toEqual([id(3), id(2), id(1)]);
    for (const r of rows) {
      expect(r).toMatchObject({ depth: 0, indent: 0, parentId: null, childCount: 0, descendantCount: 0, activeDescendants: 0, parentRef: null, selfLink: false, cycle: false });
    }
    expect(ids(visibleRows(rows, NO_TOGGLES))).toEqual(ids(rows));
  });

  it("puts children directly under their parent, in the list's order, and places the group at its newest member", () => {
    // newest first: two children of #0001 listed before and after an unrelated mission
    const list = [mk(5, 1), mk(4), mk(3, 1), mk(1)];
    const rows = buildMissionTree(list, list);
    expect(ids(rows)).toEqual([id(1), id(5), id(3), id(4)]);
    expect(rows.map((r) => [r.depth, r.parentId])).toEqual([
      [0, null],
      [1, id(1)],
      [1, id(1)],
      [0, null],
    ]);
    expect(rows[0]).toMatchObject({ childCount: 2, descendantCount: 2 });
  });

  it("keeps a group with a new active descendant at the top, however old its root is", () => {
    const list = [mk(9, 2, { active: true }), mk(8), mk(2, 1), mk(1)];
    const rows = buildMissionTree(list, list);
    expect(ids(rows)).toEqual([id(1), id(2), id(9), id(8)]);
    expect(ids(visibleRows(rows, NO_TOGGLES))).toEqual([id(1), id(2), id(9), id(8)]);
    // a list with no links keeps its exact order
    const legacy = [mk(7), mk(3), mk(5), mk(1)];
    expect(ids(buildMissionTree(legacy, legacy))).toEqual(legacy.map((t) => t.id));
  });

  it("keeps the full depth of a 5-level chain while capping the indentation at two levels", () => {
    const list = [mk(5, 4), mk(4, 3), mk(3, 2), mk(2, 1), mk(1)];
    const rows = buildMissionTree(list, list);
    expect(ids(rows)).toEqual([id(1), id(2), id(3), id(4), id(5)]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 3, 4]);
    expect(rows.map((r) => r.indent)).toEqual([0, 1, 2, 2, 2]);
    expect(MAX_INDENT).toBe(2);
    expect(rows.map((r) => r.parentId)).toEqual([null, id(1), id(2), id(3), id(4)]);
    expect(rows.map((r) => r.descendantCount)).toEqual([4, 3, 2, 1, 0]);
    expect(rows.map((r) => r.childCount)).toEqual([1, 1, 1, 1, 0]);
  });

  it("links across repositories by parentTaskId alone, and never links by repository", () => {
    const list = [mk(3, 1, { repository: "~/code/other" }), mk(2, null, { repository: "~/code/app" }), mk(1, null, { repository: "~/code/app" })];
    const rows = buildMissionTree(list, list);
    expect(ids(rows)).toEqual([id(1), id(3), id(2)]);
    expect(rows.find((r) => r.task.id === id(3))).toMatchObject({ depth: 1, parentId: id(1) });
    expect(rows.find((r) => r.task.id === id(2))).toMatchObject({ depth: 0, childCount: 0 }); // same repo as #0001, still unrelated
  });

  it("shows a mission whose parent is missing (or beyond the scan cap) at the top level with a 'not in scan' reference", () => {
    const list = [mk(2, 99), mk(1)];
    const rows = buildMissionTree(list, list);
    expect(ids(rows)).toEqual([id(2), id(1)]);
    expect(rows[0]).toMatchObject({ depth: 0, parentId: null, parentRef: { id: id(99), reason: "not-in-scan" } });
    expect(parentRefText({ id: id(99), reason: "not-in-scan" })).toBe(`parent ${id(99)} not in scan`);
  });

  it("shows a mission whose parent is hidden by the filters at the top level with a 'hidden by filter' reference", () => {
    const all = [mk(3, 1, { active: true }), mk(2, 1, { active: true }), mk(1)];
    const shown = all.filter((t) => t.active); // e.g. the "Active" filter
    const rows = buildMissionTree(shown, all);
    expect(ids(rows)).toEqual([id(3), id(2)]);
    for (const r of rows) expect(r).toMatchObject({ depth: 0, parentRef: { id: id(1), reason: "hidden-by-filter" } });
    expect(parentRefText({ id: id(1), reason: "hidden-by-filter" })).toBe(`parent ${id(1)} hidden by filter`);
  });

  it("treats a self-link as no parent and flags it", () => {
    const list = [mk(2, 2), mk(1)];
    const rows = buildMissionTree(list, list);
    expect(ids(rows)).toEqual([id(2), id(1)]);
    expect(rows[0]).toMatchObject({ depth: 0, parentId: null, childCount: 0, parentRef: null, selfLink: true, cycle: false });
  });

  it("breaks a 2-cycle at the member listed first and flags both", () => {
    const list = [mk(2, 1), mk(1, 2)];
    const rows = buildMissionTree(list, list);
    expect(ids(rows)).toEqual([id(2), id(1)]);
    expect(rows[0]).toMatchObject({ depth: 0, parentId: null, parentRef: null, cycle: true, childCount: 1 });
    expect(rows[1]).toMatchObject({ depth: 1, parentId: id(2), cycle: true });
  });

  it("breaks a 3-cycle with a tail deterministically, flags only the cycle members, and terminates", () => {
    // cycle #0001 → #0003 → #0002 → #0001 (child → parent); #0009 hangs off #0001
    const list = [mk(9, 1), mk(1, 3), mk(2, 1), mk(3, 2)];
    const rows = buildMissionTree(list, list);
    expect(ids(rows)).toEqual([id(1), id(9), id(2), id(3)]);
    expect(rows.map((r) => [r.task.id, r.depth, r.cycle])).toEqual([
      [id(1), 0, true],
      [id(9), 1, false],
      [id(2), 1, true],
      [id(3), 2, true],
    ]);
    expect(rows[0]?.descendantCount).toBe(3);
    // the same input in the same order always gives the same rows
    expect(ids(buildMissionTree(list, list))).toEqual(ids(rows));
  });

  it("returns every filtered mission exactly once, whatever the links (so the header counts stay task counts)", () => {
    const list = [mk(8, 7), mk(7, 8), mk(6, 6), mk(5, 99), mk(4, 1), mk(3, 4), mk(2, 3), mk(1, 2), mk(0)];
    const rows = buildMissionTree(list, list);
    expect([...ids(rows)].sort()).toEqual(list.map((t) => t.id).sort());
  });

  it("handles a very long chain without recursion limits", () => {
    const n = 5000;
    const list = Array.from({ length: n }, (_, i) => mk(n - i, n - i - 1 > 0 ? n - i - 1 : null));
    const rows = buildMissionTree(list, list);
    expect(rows).toHaveLength(n);
    expect(rows[0]).toMatchObject({ depth: 0, descendantCount: n - 1 });
    expect(rows[n - 1]).toMatchObject({ depth: n - 1, indent: MAX_INDENT });
  });
});

describe("default expansion and toggles", () => {
  // #0001 (complete) → #0002 (complete) → #0003 (active); #0005 (complete) → #0006 (complete); #0004 legacy
  const all = [mk(6, 5), mk(5), mk(4), mk(3, 2, { active: true }), mk(2, 1), mk(1)];
  const rows = buildMissionTree(all, all);

  it("expands the whole path to an active mission inside completed ancestors, and collapses groups with none", () => {
    expect(ids(rows)).toEqual([id(5), id(6), id(4), id(1), id(2), id(3)]);
    const byId = (n: number) => rows.find((r) => r.task.id === id(n)) as MissionRow<T>;
    expect(defaultExpanded(byId(1))).toBe(true);
    expect(defaultExpanded(byId(2))).toBe(true);
    expect(defaultExpanded(byId(5))).toBe(false);
    expect(defaultExpanded(byId(4))).toBe(false); // no children
    expect(ids(visibleRows(rows, NO_TOGGLES))).toEqual([id(5), id(4), id(1), id(2), id(3)]);
    expect(subMissionHint(byId(1))).toBe("2 sub-missions (1 active)");
    expect(subMissionHint(byId(5))).toBe("1 sub-mission (0 active)");
  });

  it("applies the viewer's toggles by mission id over the default, and keeps them across a rebuild (a poll)", () => {
    const toggles = new Map([
      [id(1), false],
      [id(5), true],
    ]);
    expect(ids(visibleRows(rows, toggles))).toEqual([id(5), id(6), id(4), id(1)]);
    const polled = buildMissionTree(
      all.map((t) => ({ ...t })),
      all,
    );
    expect(ids(visibleRows(polled, toggles))).toEqual([id(5), id(6), id(4), id(1)]);
    const first = polled[0] as MissionRow<T>;
    expect(isExpanded(first, toggles)).toBe(true);
    // a toggle on a mission without children never expands anything
    expect(isExpanded(polled.find((r) => r.task.id === id(4)) as MissionRow<T>, new Map([[id(4), true]]))).toBe(false);
  });

  it("hides deeper rows when a middle row is collapsed, even if the row above is expanded", () => {
    expect(ids(visibleRows(rows, new Map([[id(2), false]])))).toEqual([id(5), id(4), id(1), id(2)]);
  });
});

describe("MissionList wiring (static)", () => {
  const src = fs.readFileSync(path.resolve(process.cwd(), "src/components/missions/mission-list.tsx"), "utf8");

  it("keeps the mission id link exactly as before and groups after filtering", () => {
    expect(src).toContain('<Link href={`/tasks/${encodeURIComponent(t.id)}`} className="text-signal">');
    expect(src).toMatch(/const list = allTasks\.filter\([^\n]*\);\n[\s\S]*buildMissionTree\(list, allTasks\)/);
    expect(src).toContain("`${list.length} of ${tasks.counts.total}");
  });

  it("gives the toggle aria-expanded and a label naming the mission, and never says 'delegated'", () => {
    expect(src).toMatch(/aria-expanded=\{open\}/);
    expect(src).toContain("sub-missions of ${t.id}");
    expect(/delegat/i.test(src)).toBe(false);
  });
});
