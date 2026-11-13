import { json, withApi } from "@/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** A fixed constant: this route reads nothing (no store, no package.json, no env). */
const VERSION_RESPONSE = { name: "brain-control-center", version: "1.0.0" };

export const GET = withApi(async () => json(VERSION_RESPONSE));
