import { json, withApi } from "@/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** A fixed constant: this route reads nothing (no store, no package.json, no env). */
const SMOKE_RESPONSE = { ok: true, source: "brain-smoke-test" };

export const GET = withApi(async () => json(SMOKE_RESPONSE));
