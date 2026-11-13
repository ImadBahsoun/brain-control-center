// Parent/child grouping for the Missions tab: the pure part (the React side is
// components/missions/mission-list.tsx). Missions are linked ONLY by TaskSummary.parentTaskId, brain-state's
// explicit `parent_task`: never by title, branch, repository or time. Grouping runs over the list the
// filters already produced; the full list only tells a parent "hidden by filter" from one "not in scan".
// O(n), and it terminates on any input: self-links are ignored and every cycle is broken once.
// Order: each group sits at its first-listed (newest) member's place; children follow their parent in list order.

/** Rows deeper than this keep their true depth but are drawn at this indentation. */
export const MAX_INDENT = 2;

export interface TreeTask {
  id: string;
  parentTaskId: string | null;
  active: boolean;
}

/** Why a top-level row's recorded parent is not shown above it. */
export type ParentRef = { id: string; reason: "hidden-by-filter" | "not-in-scan" };

export interface MissionRow<T extends TreeTask> {
  task: T;
  /** True depth in the shown hierarchy: 0 for a top-level row. */
  depth: number;
  /** Visual indentation: the depth capped at MAX_INDENT. */
  indent: number;
  /** The id of the row this one is shown under; null at the top level. */
  parentId: string | null;
  /** Direct children shown under this row. */
  childCount: number;
  /** Every row shown under this one, at any depth. */
  descendantCount: number;
  /** Active missions among the descendants, at any depth. */
  activeDescendants: number;
  /** Set on a top-level row whose recorded parent is not in the filtered list. */
  parentRef: ParentRef | null;
  /** The mission names itself as its parent; the link is ignored. */
  selfLink: boolean;
  /** The mission is part of a parent cycle (broken at its member listed first). */
  cycle: boolean;
}

/**
 * The filtered missions as tree rows, in display order: each top-level group is placed at the list position
 * of its first-listed member, and each row's children follow it directly, in the list's order. `all` is
 * the unfiltered list.
 */
export function buildMissionTree<T extends TreeTask>(shown: readonly T[], all: readonly TreeTask[]): MissionRow<T>[] {
  const n = shown.length;
  const index = new Map<string, number>();
  shown.forEach((t, i) => {
    if (!index.has(t.id)) index.set(t.id, i);
  });

  // 1. each row's parent row, by parentTaskId only
  const parent: number[] = new Array<number>(n).fill(-1);
  const selfLink: boolean[] = new Array<boolean>(n).fill(false);
  shown.forEach((t, i) => {
    const p = t.parentTaskId;
    if (p === null) return;
    if (p === t.id) selfLink[i] = true;
    else parent[i] = index.get(p) ?? -1;
  });

  // 2. cycles: every row has at most one parent, so walk up from each unvisited row; meeting a row on the
  //    current walk closes a cycle. Its member listed first becomes a root, which breaks it.
  const cycle: boolean[] = new Array<boolean>(n).fill(false);
  const mark = new Uint8Array(n); // 0 unvisited, 1 on the current walk, 2 done
  const walk: number[] = [];
  for (let s = 0; s < n; s++) {
    if (mark[s] !== 0) continue;
    walk.length = 0;
    let v = s;
    while (v !== -1 && mark[v] === 0) {
      mark[v] = 1;
      walk.push(v);
      v = parent[v] ?? -1;
    }
    if (v !== -1 && mark[v] === 1) {
      let root = v;
      for (let k = walk.indexOf(v); k < walk.length; k++) {
        const m = walk[k] ?? v;
        cycle[m] = true;
        if (m < root) root = m;
      }
      parent[root] = -1;
    }
    for (const u of walk) mark[u] = 2;
  }

  // 3. children in list order, and a pre-order walk from given roots (iterative: no recursion depth limit)
  const children: number[][] = Array.from({ length: n }, () => []);
  const roots: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = parent[i] ?? -1;
    if (p !== -1) children[p]?.push(i);
    else roots.push(i);
  }
  const depth: number[] = new Array<number>(n).fill(0);
  const preorder = (from: readonly number[]): number[] => {
    const out: number[] = [];
    const stack: number[] = [];
    for (let k = from.length - 1; k >= 0; k--) stack.push(from[k] ?? 0);
    for (let v = stack.pop(); v !== undefined; v = stack.pop()) {
      out.push(v);
      const cs = children[v] ?? [];
      for (let k = cs.length - 1; k >= 0; k--) {
        const c = cs[k] ?? v;
        depth[c] = (depth[v] ?? 0) + 1;
        stack.push(c);
      }
    }
    return out;
  };

  // 4. descendant counts and each group's first-listed member, children before parents
  const desc: number[] = new Array<number>(n).fill(0);
  const act: number[] = new Array<number>(n).fill(0);
  const first: number[] = Array.from({ length: n }, (_, i) => i);
  const byRoot = preorder(roots);
  for (let k = byRoot.length - 1; k >= 0; k--) {
    const v = byRoot[k] ?? 0;
    const p = parent[v] ?? -1;
    if (p === -1) continue;
    desc[p] = (desc[p] ?? 0) + 1 + (desc[v] ?? 0);
    act[p] = (act[p] ?? 0) + (shown[v]?.active ? 1 : 0) + (act[v] ?? 0);
    first[p] = Math.min(first[p] ?? p, first[v] ?? v);
  }

  // 5. each group sits where its first-listed member is (groups are disjoint, so `first` is unique per root)
  const rootAt: number[] = new Array<number>(n).fill(-1);
  for (const r of roots) rootAt[first[r] ?? r] = r;
  const order = preorder(rootAt.filter((r) => r !== -1));

  const known = new Set(all.map((t) => t.id));
  const rows: MissionRow<T>[] = [];
  for (const v of order) {
    const task = shown[v];
    if (task === undefined) continue;
    const p = parent[v] ?? -1;
    const d = depth[v] ?? 0;
    const declared = task.parentTaskId;
    const parentRef: ParentRef | null =
      p === -1 && declared !== null && declared !== task.id && !index.has(declared) ? { id: declared, reason: known.has(declared) ? "hidden-by-filter" : "not-in-scan" } : null;
    rows.push({
      task,
      depth: d,
      indent: Math.min(d, MAX_INDENT),
      parentId: p === -1 ? null : (shown[p]?.id ?? null),
      childCount: children[v]?.length ?? 0,
      descendantCount: desc[v] ?? 0,
      activeDescendants: act[v] ?? 0,
      parentRef,
      selfLink: selfLink[v] ?? false,
      cycle: cycle[v] ?? false,
    });
  }
  return rows;
}

/** A group starts expanded when any mission under it, at any depth, is active; so the path to every active mission is open. */
export function defaultExpanded(row: MissionRow<TreeTask>): boolean {
  return row.childCount > 0 && row.activeDescendants > 0;
}

/** The viewer's own toggle (by mission id) when there is one, else the default. */
export function isExpanded(row: MissionRow<TreeTask>, toggles: ReadonlyMap<string, boolean>): boolean {
  return row.childCount > 0 && (toggles.get(row.task.id) ?? defaultExpanded(row));
}

/** The rows to draw: a row is shown when every row above it in its group is expanded. */
export function visibleRows<T extends TreeTask>(rows: readonly MissionRow<T>[], toggles: ReadonlyMap<string, boolean>): MissionRow<T>[] {
  const open = new Set<string>();
  const out: MissionRow<T>[] = [];
  for (const r of rows) {
    if (r.parentId !== null && !open.has(r.parentId)) continue;
    out.push(r);
    if (isExpanded(r, toggles)) open.add(r.task.id);
  }
  return out;
}

/** "3 sub-missions (1 active)". */
export function subMissionHint(row: MissionRow<TreeTask>): string {
  return `${row.descendantCount} sub-mission${row.descendantCount === 1 ? "" : "s"} (${row.activeDescendants} active)`;
}

/** "parent BR-… hidden by filter" / "parent BR-… not in scan". */
export function parentRefText(ref: ParentRef): string {
  return `parent ${ref.id} ${ref.reason === "hidden-by-filter" ? "hidden by filter" : "not in scan"}`;
}
