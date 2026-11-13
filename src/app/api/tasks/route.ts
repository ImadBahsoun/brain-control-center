import { loadPolicy } from "@/server/brain/governor";
import { brainRoots } from "@/server/brain/roots";
import { scanTasks, tasksResponse } from "@/server/brain/task-store";
import { json, withApi } from "@/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withApi(async () => {
  const now = Date.now();
  const roots = brainRoots();
  const policy = await loadPolicy(roots);
  return json(tasksResponse(await scanTasks(roots, now), now, policy));
});
