import { agentsResponse } from "@/server/brain/overview";
import { brainRoots } from "@/server/brain/roots";
import { json, withApi } from "@/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withApi(async () => json(await agentsResponse(brainRoots(), Date.now())));
