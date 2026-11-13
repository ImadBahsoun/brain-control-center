// What the viewer selected on the map (or in a list), which the side panel renders. Pure types.
import type { EdgeId, NodeId } from "./layout";

export type Selection =
  | { kind: "node"; id: NodeId }
  | { kind: "edge"; id: EdgeId }
  | { kind: "threat"; id: string }
  | { kind: "gate" };

export function sameSelection(a: Selection | null, b: Selection | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "gate" || b.kind === "gate") return true;
  return a.id === (b as { id: string }).id;
}
