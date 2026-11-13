import { describe, expect, it } from "vitest";
import type { ApprovalItem } from "@/lib/api-types";
import { APPROVAL_CHANNEL_NOTE, approvalRows, approvalStatusChip, UNLINKED_LABEL } from "@/lib/ui/approvals";
import { REPO_UNKNOWN_LABEL } from "@/lib/ui/repo";

function item(over: Partial<ApprovalItem> = {}): ApprovalItem {
  return { actions: ["commit"], repositories: ["~/work/apps/api"], expires: "2026-11-03T12:30:00.000Z", status: "pending", mission: null, ...over };
}

describe("approvalRows", () => {
  it("keys rows by list index and shows Unlinked without a mission", () => {
    const rows = approvalRows([item(), item({ mission: { taskId: "BR-20261103-0004" } })]);
    expect(rows.map((r) => r.key)).toEqual([0, 1]);
    expect(rows[0]).toMatchObject({ missionId: null, missionLabel: UNLINKED_LABEL });
    expect(rows[1]).toMatchObject({ missionId: "BR-20261103-0004", missionLabel: "BR-20261103-0004" });
  });
  it("labels repositories over every row (collisions grow), and shows repo unknown without a binding", () => {
    const rows = approvalRows([item(), item({ repositories: ["~/side/services/api"] }), item({ repositories: [] }), item({ repositories: ["  "] })]);
    expect(rows.map((r) => r.repository)).toEqual(["apps/api", "services/api", REPO_UNKNOWN_LABEL, REPO_UNKNOWN_LABEL]);
    expect(rows.map((r) => r.repoUnknown)).toEqual([false, false, true, true]);
  });
  it("joins actions and repositories, with a dash for no actions", () => {
    const [r] = approvalRows([item({ actions: ["push", "commit"], repositories: ["~/a/one", "~/b/two"] })]);
    expect(r?.actions).toBe("push, commit");
    expect(r?.repository).toBe("one, two");
    expect(approvalRows([item({ actions: [] })])[0]?.actions).toBe("—");
  });
  it("gives every status its own chip", () => {
    expect(approvalStatusChip("pending")).toBe("chip-warn");
    expect(approvalStatusChip("consumed")).toBe("chip-ok");
    expect(approvalStatusChip("revoked")).toBe("chip-danger");
    expect(approvalStatusChip("expired")).toBe("chip-dim");
  });
  it("says approval happens only in the Claude Code session that raised the request", () => {
    expect(APPROVAL_CHANNEL_NOTE).toMatch(/only in the Claude Code session that raised it/);
    expect(APPROVAL_CHANNEL_NOTE).toMatch(/Read-only/);
  });
});
