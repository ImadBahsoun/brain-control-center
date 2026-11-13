// The Office page's view mode, Global Office (every open mission) or Mission Office (the focused mission): the
// pure parts — parsing and persisting the viewer's choice, the same way fold-state.ts keeps fold choices. The
// React side is hooks/use-office-mode.ts. A first-time viewer, or a stored value that is not exactly one of the
// two modes, gets the Global Office. Storage access goes through fold-state.ts's browserStorage().
export type OfficeMode = "global" | "mission";

export const OFFICE_MODE_KEY = "bcc.office.mode";
export const DEFAULT_OFFICE_MODE: OfficeMode = "global";

type Readable = Pick<Storage, "getItem">;
type Writable = Pick<Storage, "setItem">;

/** A stored value as a mode; anything that is not exactly "global" or "mission" is the default. */
export function parseOfficeMode(raw: unknown): OfficeMode {
  return raw === "mission" ? "mission" : raw === "global" ? "global" : DEFAULT_OFFICE_MODE;
}

export function readOfficeMode(storage: Readable | null): OfficeMode {
  if (!storage) return DEFAULT_OFFICE_MODE;
  try {
    return parseOfficeMode(storage.getItem(OFFICE_MODE_KEY));
  } catch {
    return DEFAULT_OFFICE_MODE;
  }
}

/** Persists a mode; false when nothing could be stored (no storage, or it threw), so the caller keeps it in memory. */
export function writeOfficeMode(storage: Writable | null, mode: OfficeMode): boolean {
  if (!storage) return false;
  try {
    storage.setItem(OFFICE_MODE_KEY, mode);
    return true;
  } catch {
    return false;
  }
}
