// Fold state of the mission view's two side columns (the left column and the threat rail): the pure parts —
// parsing and persisting the viewer's choice and the rail's width variables. The React side is
// hooks/use-fold-state.ts. A choice is `true` (open), `false` (folded) or `null` (never chosen: the
// column's default applies — left open; rail open ≥ 1440 px, folded 1100–1439 px).

export type FoldChoice = boolean | null;

export const LEFT_FOLD_KEY = "bcc.fold.left";
export const RAIL_FOLD_KEY = "bcc.fold.rail";
/** The Global Office's roster column (defaults open). */
export const GLOBAL_ROSTER_FOLD_KEY = "bcc.fold.roster";

type Readable = Pick<Storage, "getItem">;
type Writable = Pick<Storage, "setItem">;

/** The browser's localStorage, or null where it is missing or throws on access (blocked site data, some private windows). */
export function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** A stored value as a choice; anything that is not exactly "open" or "folded" counts as never chosen. */
export function parseFold(raw: unknown): FoldChoice {
  return raw === "open" ? true : raw === "folded" ? false : null;
}

export function readFold(storage: Readable | null, key: string): FoldChoice {
  if (!storage) return null;
  try {
    return parseFold(storage.getItem(key));
  } catch {
    return null;
  }
}

/** Persists a choice; false when nothing could be stored (no storage, or it threw), so the caller can keep it in memory. */
export function writeFold(storage: Writable | null, key: string, open: boolean): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, open ? "open" : "folded");
    return true;
  } catch {
    return false;
  }
}

/** Whether the rail is folded at each desktop width band, for a choice: a choice applies to both, never chosen keeps each band's default. */
export function railFolded(choice: FoldChoice): { wide: boolean; band: boolean } {
  return { wide: choice === false, band: choice !== true };
}

/** The rail's two width variables (≥ 1440 px and 1100–1439 px): the 44 px strip when it has no findings or is folded, else 272 px. */
export function railWidths({ compact, choice }: { compact: boolean; choice: FoldChoice }): { wide: string; band: string } {
  const folded = railFolded(choice);
  return { wide: compact || folded.wide ? "44px" : "272px", band: compact || folded.band ? "44px" : "272px" };
}
