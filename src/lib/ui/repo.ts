// A consistent display label for the repository a mission works on, from the home-masked path the API
// already serves (TaskSummary.repository / TaskDetail.repository): never a path re-derived here, and
// never the mission title. Pure.

/** Shown when a mission has no recorded repository (missing or blank); callers dim this label. */
export const REPO_UNKNOWN_LABEL = "repo unknown";

/** The label for the Brain's own store directory, the masked form the API serves for it. */
const BRAIN_DIR = "~/.claude";
const BRAIN_LABEL = "Brain";

/** Drops a single trailing slash (not the root "/" or "~" alone), so "a/b/" and "a/b" share a label. */
function normalize(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function segments(path: string): string[] {
  return normalize(path).split("/").filter((s) => s.length > 0);
}

/** The last `levels` segments of `path`, joined back with "/"; `levels` beyond the path's own length
 * just yields the whole (normalized) path, so every distinct path has a level at which its label is
 * unique: its own full path. */
function labelAtLevel(path: string, levels: number): string {
  const s = segments(path);
  return s.slice(Math.max(0, s.length - levels)).join("/");
}

/**
 * The display label for every distinct repository path among `paths` (missing/blank entries ignored).
 * Pass the FULL list of missions currently shown together — the mission strip, Recent Missions, the
 * mission HUD and the Missions tab must all label the same set of repositories the same way, so a
 * narrowed view (e.g. "top 5 recent") must still compute this over every mission, not just the ones it
 * renders, or two different repositories can collide into the same short label in one view while
 * another view (seeing the full list) disambiguates them.
 *
 * The Brain's own store dir always labels "Brain". Every other distinct path starts labelled by its
 * last segment (basename); when two or more DIFFERENT paths would share a label, each of them grows by
 * one more path segment (its parent, then its grandparent, …) until every path's label is unique again
 * — e.g. "~/work/apps/api" and "~/side/services/api" both start as "api", so both grow to "apps/api"
 * and "services/api"; a third that still collided would grow once more, and so on up to each path's own
 * full (masked) form, which is always unique since the paths themselves are distinct strings.
 */
export function repoLabels(paths: ReadonlyArray<string | null | undefined>): Map<string, string> {
  const distinct = new Set<string>();
  for (const p of paths) if (p && p.trim().length > 0) distinct.add(normalize(p));

  const others = [...distinct].filter((p) => p !== BRAIN_DIR);
  const levels = new Map<string, number>(others.map((p) => [p, 1]));

  // Grow the level of every path in a colliding group until its label is unique, or it has run out of
  // segments to grow into (at which point its label is its own full path, which cannot collide with
  // another distinct path's label at ANY level without that other path also being fully grown — the
  // loop below grows both sides of a collision together, so this always terminates.
  for (let guard = 0; guard < 64; guard++) {
    const byLabel = new Map<string, string[]>();
    for (const p of others) {
      const label = labelAtLevel(p, levels.get(p) ?? 1);
      const list = byLabel.get(label);
      if (list) list.push(p);
      else byLabel.set(label, [p]);
    }
    let changed = false;
    for (const group of byLabel.values()) {
      if (group.length <= 1) continue;
      for (const p of group) {
        const maxLevel = segments(p).length;
        const current = levels.get(p) ?? 1;
        if (current < maxLevel) {
          levels.set(p, current + 1);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  const out = new Map<string, string>();
  for (const p of others) out.set(p, labelAtLevel(p, levels.get(p) ?? 1) || REPO_UNKNOWN_LABEL);
  if (distinct.has(BRAIN_DIR)) out.set(BRAIN_DIR, BRAIN_LABEL);
  return out;
}

/**
 * The first `n` missions, with repository labels computed over the WHOLE list, so a short view (Recent
 * Missions) labels a repo exactly as the strip, the mission HUD and the Missions tab do.
 */
export function labelledHead<T extends { repository: string | null }>(tasks: readonly T[], n: number): { head: T[]; labels: Map<string, string> } {
  return { head: tasks.slice(0, n), labels: repoLabels(tasks.map((t) => t.repository)) };
}

/**
 * The display label for one (masked) repository path. Pass `labels` (from `repoLabels` over the FULL
 * list of missions shown together) whenever more than one mission is shown together, so collisions are
 * disambiguated consistently with every other view of the same missions. A path not found in `labels`
 * (it was built over a different, narrower list — e.g. a single-mission view with no list at hand)
 * falls back to that path's own standalone label, never to "repo unknown": only a missing or blank path
 * is ever unknown.
 */
export function repoLabel(path: string | null | undefined, labels?: ReadonlyMap<string, string>): string {
  if (!path || path.trim().length === 0) return REPO_UNKNOWN_LABEL;
  const norm = normalize(path);
  const found = labels?.get(norm);
  if (found) return found;
  if (norm === BRAIN_DIR) return BRAIN_LABEL;
  return basenameOnly(norm) || REPO_UNKNOWN_LABEL;
}

function basenameOnly(path: string): string {
  const s = segments(path);
  return s[s.length - 1] ?? "";
}

/** True for the "repo unknown" fallback, so callers can dim it without comparing strings themselves. */
export function isUnknownRepoLabel(label: string): boolean {
  return label === REPO_UNKNOWN_LABEL;
}

/**
 * The Missions tab's repository filter keys on the (normalized, masked) repository PATH, never on its
 * display label: two different repositories' labels can still look alike before `repoLabels` has fully
 * disambiguated them for a given render, and a label is text a user could type as a repository's actual
 * name, so it must never double as a filter key. `REPO_FILTER_ALL` and `REPO_UNKNOWN_KEY` are reserved
 * sentinels that cannot equal any real (masked) path — a mask always starts with "~" or "/".
 */
export const REPO_FILTER_ALL = "\u0000ALL\u0000";
export const REPO_UNKNOWN_KEY = "\u0000UNKNOWN\u0000";
const REPO_FILTER_ALL_LABEL = "All";

export interface RepoFilterOption {
  /** The filter's value: a normalized repository path, or `REPO_FILTER_ALL` / `REPO_UNKNOWN_KEY`. */
  key: string;
  /** The button text. */
  label: string;
}

/**
 * The repository filter's options for the FULL current list of missions (see `repoLabels`): "All"
 * first, then one option per distinct repository path (keyed by path, labelled via `labels`) sorted by
 * label, with "repo unknown" last when any mission has no repository.
 */
export function repoFilterOptions(paths: ReadonlyArray<string | null | undefined>, labels: ReadonlyMap<string, string>): RepoFilterOption[] {
  const known = new Map<string, string>();
  let hasUnknown = false;
  for (const p of paths) {
    if (!p || p.trim().length === 0) {
      hasUnknown = true;
      continue;
    }
    const norm = normalize(p);
    if (!known.has(norm)) known.set(norm, repoLabel(norm, labels));
  }
  const sorted = [...known.entries()].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label));
  const out: RepoFilterOption[] = [{ key: REPO_FILTER_ALL, label: REPO_FILTER_ALL_LABEL }, ...sorted];
  if (hasUnknown) out.push({ key: REPO_UNKNOWN_KEY, label: REPO_UNKNOWN_LABEL });
  return out;
}

/** Whether a mission's (unmasked-by-this-helper) repository path satisfies a filter key from `repoFilterOptions`. */
export function matchesRepoFilter(repository: string | null | undefined, filterKey: string): boolean {
  if (filterKey === REPO_FILTER_ALL) return true;
  const blank = !repository || repository.trim().length === 0;
  if (filterKey === REPO_UNKNOWN_KEY) return blank;
  return !blank && normalize(repository) === filterKey;
}

/** The filter key to actually use: `selected` when it is still among `options`, else `REPO_FILTER_ALL` —
 * so a repository filter reset automatically when its repository is no longer present in the list (e.g.
 * the mission that was its only instance went out of scope), without any effect or extra state. */
export function resolveRepoFilter(selected: string, options: ReadonlyArray<RepoFilterOption>): string {
  return options.some((o) => o.key === selected) ? selected : REPO_FILTER_ALL;
}
