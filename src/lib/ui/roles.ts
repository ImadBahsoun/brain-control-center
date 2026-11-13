// Client-side role constants for the command map. Labels and the validator set mirror the server
// modules (src/server/brain/events.ts, governor.ts); equality is enforced by tests/unit/ui-roles.test.ts.
// The archetype titles are UI constants only: they describe the role's job on the map, not Brain data.
import type { TimelineState } from "@/lib/lifecycle";

export const ROLES = ["planner", "developer", "qa", "reviewer", "security-reviewer"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  planner: "Planner",
  developer: "Developer",
  qa: "QA",
  reviewer: "Reviewer",
  "security-reviewer": "Security Reviewer",
};

/** Archetype (UI vocabulary for the role's job on the map). */
export const ROLE_ARCHETYPES: Record<Role, string> = {
  planner: "Strategist",
  developer: "Builder",
  qa: "Scout",
  reviewer: "Judge",
  "security-reviewer": "Guardian",
};

/** Pipeline position shown on the node (01 … 05); Synthesis, READY and the Gate follow as 06 … 08. */
export const ROLE_STEP_NUMBER: Record<Role, string> = {
  planner: "01",
  developer: "02",
  qa: "03",
  reviewer: "04",
  "security-reviewer": "05",
};

/** The lifecycle steps a role works in. The security reviewer has no state of its own: it shares REVIEWING. */
export const ROLE_STEPS: Record<Role, readonly TimelineState[]> = {
  planner: ["PLANNING"],
  developer: ["IMPLEMENTING", "FIXING"],
  qa: ["TESTING", "REVALIDATING"],
  reviewer: ["REVIEWING", "REVALIDATING"],
  "security-reviewer": ["REVIEWING", "REVALIDATING"],
};

export const VALIDATORS: ReadonlySet<string> = new Set<string>(["qa", "reviewer", "security-reviewer"]);

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function roleLabel(role: string): string {
  return isRole(role) ? ROLE_LABELS[role] : role;
}
