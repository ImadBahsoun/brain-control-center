import type { FindingsResponse } from "@/lib/api-types";
import { emptyCount } from "@/server/brain/findings";
import { brainRoots } from "@/server/brain/roots";
import { isTaskId } from "@/server/brain/safe-fs";
import { findingsResponse, loadTask, unsafeDetail } from "@/server/brain/task-store";
import { apiError, json, withApi } from "@/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withApi(async (_req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  if (!isTaskId(id)) return apiError("BAD_TASK_ID", 400);
  const r = await loadTask(brainRoots(), id, { fullLog: false, nowMs: Date.now() });
  if (r.kind === "not_found") return apiError("TASK_NOT_FOUND", 404);
  if (r.kind === "unsafe") {
    const body: FindingsResponse = { taskId: id, summary: emptyCount(), findings: [], integrity: unsafeDetail(id).integrity };
    return json(body);
  }
  return json(findingsResponse(r.task));
});
