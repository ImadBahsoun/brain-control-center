// Display rows for the Approval Center (/approvals) from the /api/approvals body. Pure.
import type { ApprovalItem, ApprovalStatus } from "@/lib/api-types";
import { isUnknownRepoLabel, REPO_UNKNOWN_LABEL, repoLabel, repoLabels } from "@/lib/ui/repo";

/** The page's standing note: this view is not an approval channel. */
export const APPROVAL_CHANNEL_NOTE =
  "Read-only. Approving or rejecting a request happens only in the Claude Code session that raised it: reply there with the APPROVE line it shows. Nothing on this page can approve, reject or run anything.";

/** Shown in the mission column when the request cannot be provably tied to one mission. */
export const UNLINKED_LABEL = "Unlinked";

export const LINKING_UNAVAILABLE_NOTE = "Mission links are unavailable: the task store could not be fully read, so every request shows as Unlinked.";

export const STATUS_ORDER: readonly ApprovalStatus[] = ["pending", "consumed", "revoked", "expired"];

export function approvalStatusChip(status: ApprovalStatus): string {
  switch (status) {
    case "pending":
      return "chip-warn";
    case "consumed":
      return "chip-ok";
    case "revoked":
      return "chip-danger";
    default:
      return "chip-dim";
  }
}

export interface ApprovalRow {
  /** The item's position in the response (newest first); never derived from a code or anything else. */
  key: number;
  actions: string;
  repository: string;
  repoUnknown: boolean;
  expires: string | null;
  status: ApprovalStatus;
  statusChip: string;
  missionId: string | null;
  missionLabel: string;
}

export function approvalRows(items: readonly ApprovalItem[]): ApprovalRow[] {
  const labels = repoLabels(items.flatMap((it) => it.repositories));
  return items.map((it, key) => {
    const repos = it.repositories.map((p) => repoLabel(p, labels)).filter((l) => !isUnknownRepoLabel(l));
    return {
      key,
      actions: it.actions.length > 0 ? it.actions.join(", ") : "—",
      repository: repos.length > 0 ? repos.join(", ") : REPO_UNKNOWN_LABEL,
      repoUnknown: repos.length === 0,
      expires: it.expires,
      status: it.status,
      statusChip: approvalStatusChip(it.status),
      missionId: it.mission?.taskId ?? null,
      missionLabel: it.mission?.taskId ?? UNLINKED_LABEL,
    };
  });
}
