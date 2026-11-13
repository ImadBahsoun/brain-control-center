import { loadPolicy } from "@/server/brain/governor";
import { brainRoots } from "@/server/brain/roots";
import { isTaskId } from "@/server/brain/safe-fs";
import { loadTask, taskDetail, unsafeDetail } from "@/server/brain/task-store";
import { apiError, json, withApi } from "@/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withApi(async (_req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  if (!isTaskId(id)) return apiError("BAD_TASK_ID", 400);
  const roots = brainRoots();
  const now = Date.now();
  const policy = await loadPolicy(roots);
  const r = await loadTask(roots, id, { fullLog: true, nowMs: now });
  if (r.kind === "not_found") return apiError("TASK_NOT_FOUND", 404);
  if (r.kind === "unsafe") return json(unsafeDetail(id));
  return json(taskDetail(r.task, policy, now));
});
