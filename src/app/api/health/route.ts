import { health } from "@/server/brain/health";
import { brainRoots } from "@/server/brain/roots";
import { json, withApi } from "@/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withApi(async () => json(await health(brainRoots(), Date.now())));
