import { describe, expect, it } from "vitest";
import { buildMissionTree, defaultExpanded, isExpanded, visibleRows, type MissionRow, type TreeTask } from "@/lib/ui/mission-tree";

const id = (n: number) => `BR-20261109-${String(n).padStart(4, "0")}`;
const mk = (n: number, parent: number | null = null, active = false): TreeTask => ({ id: id(n), parentTaskId: parent === null ? null : id(parent), active });
const ids = (rows: readonly MissionRow<TreeTask>[]) => rows.map((r) => r.task.id);
const NONE: ReadonlyMap<string, boolean> = new Map();

/** Every input row appears exactly once, and every row's parent appears before it. */
function expectSound(list: readonly TreeTask[], rows: readonly MissionRow<TreeTask>[]) {
  expect(rows).toHaveLength(list.length);
  expect(new Set(rows.map((r) => r.task)).size).toBe(list.length);
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.parentId !== null) expect(seen.has(r.parentId)).toBe(true);
    seen.add(r.task.id);
  }
}

describe("buildMissionTree adversarial", () => {
  it("handles an empty list", () => {
    expect(buildMissionTree([], [])).toEqual([]);
    expect(visibleRows([], NONE)).toEqual([]);
  });

  it("parent listed after the child (oldest-first input) still nests", () => {
    const list = [mk(1, 2), mk(2)];
    const rows = buildMissionTree(list, list);
    expect(ids(rows)).toEqual([id(2), id(1)]);
    expect(rows[1]).toMatchObject({ depth: 1, parentId: id(2) });
    expectSound(list, rows);
  });

  it("duplicate ids: every input object is emitted once and nothing loops", () => {
    const list = [mk(2, 1), mk(2, 1), mk(1), mk(1)];
    const rows = buildMissionTree(list, list);
    expectSound(list, rows);
  });

  it("duplicate id whose parent is itself the duplicate does not hang", () => {
    const list = [mk(1, 2), mk(2, 1), mk(2, 1)];
    expectSound(list, buildMissionTree(list, list));
  });

  it("cycles of length 2, 3 and 50 with tails terminate and emit each row once", () => {
    const two = [mk(1, 2), mk(2, 1), mk(3, 1)];
    const three = [mk(1, 3), mk(2, 1), mk(3, 2), mk(4, 3)];
    const long: TreeTask[] = Array.from({ length: 50 }, (_, i) => mk(i + 1, ((i + 1) % 50) + 1));
    long.push(mk(100, 7), mk(101, 100));
    for (const list of [two, three, long]) {
      const rows = buildMissionTree(list, list);
      expectSound(list, rows);
      expect(rows.filter((r) => r.parentId === null && r.cycle)).toHaveLength(1);
    }
  });

  it("self-link combined with a cycle: self-linked row is its own root, cycle elsewhere still broken", () => {
    const list = [mk(1, 1), mk(2, 3), mk(3, 2), mk(4, 1)];
    const rows = buildMissionTree(list, list);
    expectSound(list, rows);
    const r1 = rows.find((r) => r.task.id === id(1));
    expect(r1).toMatchObject({ selfLink: true, parentId: null, cycle: false, childCount: 1 });
    expect(rows.filter((r) => r.cycle)).toHaveLength(2);
  });

  it("hidden middle member: grandchild becomes a top-level row with a hidden-by-filter reference", () => {
    const all = [mk(3, 2, true), mk(2, 1), mk(1)];
    const shown = [all[0]!, all[2]!];
    const rows = buildMissionTree(shown, all);
    expect(rows[0]!.task.id).toBe(id(3));
    expect(rows[0]).toMatchObject({ parentId: null, parentRef: { id: id(2), reason: "hidden-by-filter" } });
    expect(rows[1]).toMatchObject({ parentRef: null, childCount: 0 });
  });

  it("valid parent id absent from all is not-in-scan", () => {
    const list = [mk(5, 4)];
    expect(buildMissionTree(list, list)[0]!.parentRef).toEqual({ id: id(4), reason: "not-in-scan" });
  });

  it("one chain of 3000 and a fan-out of 3000 are sound and fast", () => {
    const chain = Array.from({ length: 3000 }, (_, i) => mk(3000 - i, 3000 - i - 1 || null));
    const t0 = Date.now();
    const rows = buildMissionTree(chain, chain);
    expectSound(chain, rows);
    expect(rows[2999]!.depth).toBe(2999);
    expect(rows[2999]!.indent).toBe(2);
    const fan = [...Array.from({ length: 3000 }, (_, i) => mk(i + 2, 1)), mk(1)];
    const r2 = buildMissionTree(fan, fan);
    expectSound(fan, r2);
    expect(r2.find((r) => r.task.id === id(1))!.childCount).toBe(3000);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("an active leaf under several complete ancestors is visible with no toggles", () => {
    const list = [mk(4, 3, true), mk(3, 2), mk(2, 1), mk(1)];
    const rows = buildMissionTree(list, list);
    expect(ids(visibleRows(rows, NONE))).toContain(id(4));
    expect(rows.every((r) => r.childCount === 0 || defaultExpanded(r))).toBe(true);
  });

  it("collapsing a middle row hides only its subtree; a toggle for a vanished id is harmless", () => {
    const list = [mk(4, 3, true), mk(3, 2), mk(2, 1), mk(1)];
    const rows = buildMissionTree(list, list);
    const toggles = new Map<string, boolean>([[id(3), false], [id(999), true]]);
    expect(ids(visibleRows(rows, toggles))).toEqual([id(1), id(2), id(3)]);
    expect(isExpanded(rows[0]!, toggles)).toBe(true);
  });

  it("toggles survive a rebuild with a changed list", () => {
    const toggles = new Map<string, boolean>([[id(1), false]]);
    const a = [mk(2, 1), mk(1)];
    const b = [mk(3, 1, true), mk(2, 1), mk(1)];
    expect(ids(visibleRows(buildMissionTree(a, a), toggles))).toEqual([id(1)]);
    expect(ids(visibleRows(buildMissionTree(b, b), toggles))).toEqual([id(1)]);
  });

  it("header-count independence: tree rows equal the filtered list", () => {
    const all = [mk(4, 3, true), mk(3, 2), mk(2, 1), mk(1)];
    const shown = all.filter((t) => t.active || t.id === id(1));
    expect(buildMissionTree(shown, all)).toHaveLength(shown.length);
  });

  it("randomised parent graphs always terminate with every row once", () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let round = 0; round < 200; round++) {
      const n = 1 + Math.floor(rnd() * 30);
      const list: TreeTask[] = Array.from({ length: n }, (_, i) => {
        const r = rnd();
        const p = r < 0.25 ? null : Math.floor(rnd() * (n + 3)) + 1;
        return mk(Math.floor(rnd() * (i < 3 ? n + 1 : n)) + 1, p, rnd() < 0.3);
      });
      const shown = list.filter(() => rnd() < 0.8);
      expectSound(shown, buildMissionTree(shown, list));
    }
  });
});
