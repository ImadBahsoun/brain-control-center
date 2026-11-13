// Tone of a recorded agent verdict. The verdict text itself is always shown; the tone only colours it.
import type { AgentRunStatus } from "@/lib/api-types";

export type VerdictTone = "fail" | "concern" | "pass" | "neutral";

const FAIL = /\bfail/i;
const PASS_WORD = /pass/i;
const CONCERN = /changes required|blocked|concerns|minor fixes|partial|incomplete|not fully/i;
const PASS = /pass|ready|done|approve/i;

/**
 * Checked in this order: fail (a "fail" word without "pass", or a lost run), concern (including
 * partial or incomplete results such as "partially done"), pass, neutral. An unrecognised verdict is
 * neutral, so it is shown as recorded without a colour claim.
 */
export function verdictTone(verdict: string | null | undefined, status?: AgentRunStatus): VerdictTone {
  if (status === "lost") return "fail";
  const v = verdict ?? "";
  if (FAIL.test(v) && !PASS_WORD.test(v)) return "fail";
  if (CONCERN.test(v)) return "concern";
  if (PASS.test(v)) return "pass";
  return "neutral";
}
