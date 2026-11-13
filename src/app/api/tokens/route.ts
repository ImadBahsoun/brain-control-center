import type { TokenWindow } from "@/lib/api-types";
import { brainRoots } from "@/server/brain/roots";
import { apiError, json, withApi } from "@/server/http";
import { tokenIntelligenceResponse } from "@/server/tokens/report";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function parseWindow(url: string): TokenWindow | undefined {
  const raw = new URL(url).searchParams.get("window") ?? "7d";
  return raw === "7d" || raw === "30d" ? raw : undefined;
}

export const GET = withApi(async (req) => {
  const window = parseWindow(req.url);
  if (window === undefined) return apiError("BAD_WINDOW", 400);
  return json(await tokenIntelligenceResponse(brainRoots(), Date.now(), window));
});
