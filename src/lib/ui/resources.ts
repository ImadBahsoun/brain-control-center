// The governor as the map's resource readout. Every number comes from /api/governor (policy, global
// usage) or the focused mission's TaskUsage; without a policy there are no meters. Pure.
import type { GovernorResponse, PolicyStatus, TaskUsage } from "@/lib/api-types";

export type MeterTone = "signal" | "ok" | "warn" | "danger" | "dim";

export interface Meter {
  id: string;
  label: string;
  /** Primary value (consumed units, or pending runs). */
  value: number;
  /** A second segment stacked on the first (reserved units); 0 when not applicable. */
  reserved: number;
  max: number;
  /** A soft-limit tick as a percentage of `max`, when the policy defines one. */
  tickPercent: number | null;
  text: string;
  tone: MeterTone;
  source: string;
}

export interface ResourceModel {
  policyStatus: PolicyStatus | "loading";
  policyReason: string | null;
  /** Empty unless the policy is ok. */
  meters: Meter[];
  staleExcluded: number;
  denials: number;
  softLimitAcceptances: number;
  staleAfterMinutes: number | null;
  source: string;
}

function pips(id: string, label: string, value: number, max: number, source: string): Meter {
  const tone: MeterTone = value <= 0 ? "dim" : value >= max ? "warn" : "signal";
  return { id, label, value, reserved: 0, max, tickPercent: null, text: `${value} / ${max}`, tone, source };
}

export function resourceMeters(governor: GovernorResponse | null, focusedUsage: TaskUsage | null): ResourceModel {
  if (!governor) {
    return { policyStatus: "loading", policyReason: null, meters: [], staleExcluded: 0, denials: 0, softLimitAcceptances: 0, staleAfterMinutes: null, source: "/api/governor" };
  }
  const policy = governor.policy;
  if (!policy || governor.policyStatus !== "ok") {
    return {
      policyStatus: governor.policyStatus,
      policyReason: governor.policyReason,
      meters: [],
      staleExcluded: governor.global.staleExcluded,
      denials: governor.denials.length,
      softLimitAcceptances: governor.softLimitAccepted.length,
      staleAfterMinutes: null,
      source: "/api/governor policyStatus",
    };
  }
  const meters: Meter[] = [];
  if (focusedUsage) {
    const max = focusedUsage.classBudget ?? 0;
    const pct = focusedUsage.percentOfClassBudget;
    const tone: MeterTone = focusedUsage.softLimitCrossed ? "warn" : focusedUsage.committed > 0 ? "signal" : "dim";
    meters.push({
      id: "budget",
      label: "MISSION BUDGET",
      value: focusedUsage.consumed,
      reserved: focusedUsage.reserved,
      max,
      tickPercent: max > 0 ? policy.softLimitPercent : null,
      text: max > 0 ? `${focusedUsage.consumed} used + ${focusedUsage.reserved} reserved = ${focusedUsage.committed} / ${max}${pct !== null ? ` (${pct}%)` : ""}` : `${focusedUsage.committed} committed · no class budget`,
      tone,
      source: "/api/tasks/:id usage (class budget; session extensions not visible)",
    });
  }
  const g = governor.global;
  const lim = policy.global;
  meters.push(pips("agents", "ACTIVE AGENTS", g.pendingTotal, lim.max_total_agents, "/api/governor global.pendingTotal / policy.global.max_total_agents"));
  meters.push(pips("developers", "DEVELOPER", g.pendingDevelopers, lim.max_developers, "/api/governor global.pendingDevelopers / policy.global.max_developers"));
  meters.push(pips("validators", "VALIDATORS", g.pendingValidators, lim.max_validators, "/api/governor global.pendingValidators / policy.global.max_validators"));
  meters.push(pips("opus", "OPUS", g.pendingOpus, lim.max_opus_agents, "/api/governor global.pendingOpus / policy.global.max_opus_agents"));
  meters.push(pips("fable", "FABLE", g.pendingFable, lim.max_fable_agents, "/api/governor global.pendingFable / policy.global.max_fable_agents"));
  return {
    policyStatus: "ok",
    policyReason: null,
    meters,
    staleExcluded: g.staleExcluded,
    denials: governor.denials.length,
    softLimitAcceptances: governor.softLimitAccepted.length,
    staleAfterMinutes: policy.staleAfterMinutes,
    source: "/api/governor",
  };
}
