"use client";
import type { ApprovalsResponse } from "@/lib/api-types";
import { SLOW_MS } from "@/hooks/use-cadence";
import { usePoll } from "@/hooks/use-poll";
import { ApprovalCenter } from "@/components/approvals/approval-center";

export default function ApprovalsPage() {
  // polled only while this page is open, at the slow cadence: each poll reads recently active task logs
  const poll = usePoll<ApprovalsResponse>("/api/approvals", SLOW_MS);
  return (
    <div className="mx-auto max-w-[1600px] px-4 py-3">
      <ApprovalCenter data={poll.data} error={poll.error} />
    </div>
  );
}
