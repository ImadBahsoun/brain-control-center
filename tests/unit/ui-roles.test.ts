import { describe, expect, it } from "vitest";
import { TIMELINE } from "@/lib/lifecycle";
import { roleLabel as serverRoleLabel } from "@/server/brain/events";
import { OPEN_STATUSES as SERVER_OPEN } from "@/server/brain/findings";
import { AGENTS as SERVER_AGENTS, VALIDATORS as SERVER_VALIDATORS } from "@/server/brain/governor";
import { ROLE_ARCHETYPES, ROLE_LABELS, ROLE_STEP_NUMBER, ROLE_STEPS, ROLES, isRole, roleLabel, VALIDATORS } from "@/lib/ui/roles";
import { OPEN_STATUSES } from "@/lib/ui/threats";

describe("client role mirrors match the server modules", () => {
  it("lists the same roles as the governor policy, in the same order", () => {
    expect([...ROLES]).toEqual([...SERVER_AGENTS]);
  });
  it("labels every role exactly as the server's roleLabel does", () => {
    for (const r of ROLES) {
      expect(ROLE_LABELS[r]).toBe(serverRoleLabel(r));
      expect(roleLabel(r)).toBe(serverRoleLabel(r));
    }
    expect(roleLabel("intern")).toBe("intern");
    expect(isRole("intern")).toBe(false);
    expect(isRole("security-reviewer")).toBe(true);
  });
  it("has the same validator set and the same open-finding set as the server", () => {
    expect([...VALIDATORS].sort()).toEqual([...SERVER_VALIDATORS].sort());
    expect([...OPEN_STATUSES].sort()).toEqual([...SERVER_OPEN].sort());
  });
  it("maps every role onto real timeline states only, with a distinct archetype and step number", () => {
    for (const r of ROLES) {
      for (const s of ROLE_STEPS[r]) expect(TIMELINE).toContain(s);
      expect(ROLE_STEPS[r].length).toBeGreaterThan(0);
    }
    expect(new Set(Object.values(ROLE_ARCHETYPES)).size).toBe(ROLES.length);
    expect(new Set(Object.values(ROLE_STEP_NUMBER)).size).toBe(ROLES.length);
    expect(ROLE_STEPS["security-reviewer"]).toEqual(["REVIEWING", "REVALIDATING"]); // no SECURITY state exists
  });
});
