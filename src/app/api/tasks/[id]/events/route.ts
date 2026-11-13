import type { EventsResponse } from "@/lib/api-types";
import { loadPolicy } from "@/server/brain/governor";
import { brainRoots } from "@/server/brain/roots";
import { isTaskId } from "@/server/brain/safe-fs";
import { eventsResponse, loadTask, unsafeDetail } from "@/server/brain/task-store";
import { apiError, json, parseLimit, withApi } from "@/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withApi(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  if (!isTaskId(id)) return apiError("BAD_TASK_ID", 400);
  const limit = parseLimit(req.url, 200, 1000);
  if (limit === undefined || limit === null) return apiError("BAD_LIMIT", 400);
  const roots = brainRoots();
  const policy = await loadPolicy(roots);
  const r = await loadTask(roots, id, { fullLog: true, nowMs: Date.now() });
  if (r.kind === "not_found") return apiError("TASK_NOT_FOUND", 404);
  if (r.kind === "unsafe") {
    const body: EventsResponse = { taskId: id, total: 0, hasMore: false, integrity: unsafeDetail(id).integrity, events: [] };
    return json(body);
  }
  return json(eventsResponse(r.task, policy, limit));
});
