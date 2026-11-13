import "server-only";

/**
 * API list-price-equivalent pricing. These are the published per-token rates, re-checked on
 * PRICING_CHECKED_AT; they are never the user's actual bill or subscription charge (costBasis.kind on
 * every response makes that explicit). Unknown or unverified combinations are left unpriced rather than
 * guessed, and every unpriced call is counted, never dropped.
 */

export const PRICING_SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing";
export const PRICING_CHECKED_AT = "2026-10-20";
export const MTOK = 1_000_000;
export const WEB_SEARCH_PRICE_PER_CALL = 10 / 1000;

interface Rates {
  input: number;
  write5m: number;
  write1h: number;
  cacheRead: number;
  output: number;
}

interface ModelRates {
  standard: Rates;
  /** Only present for models whose fast-mode price has been verified from the pricing page. */
  fast?: Rates;
}

/** USD per million tokens, standard tier, global routing, no batch (see costBasis.assumptions). */
const PRICING: Record<string, ModelRates> = {
  "opus-5-5": {
    standard: { input: 4, write5m: 5, write1h: 8, cacheRead: 0.2, output: 20 },
    fast: { input: 8, write5m: 10, write1h: 16, cacheRead: 0.4, output: 40 },
  },
  "opus-5": {
    standard: { input: 5, write5m: 6.25, write1h: 10, cacheRead: 0.5, output: 25 },
    fast: { input: 10, write5m: 12.5, write1h: 20, cacheRead: 1.0, output: 50 },
  },
  "opus-4-8": {
    standard: { input: 5, write5m: 6.25, write1h: 10, cacheRead: 0.5, output: 25 },
    fast: { input: 10, write5m: 12.5, write1h: 20, cacheRead: 1.0, output: 50 },
  },
  "sonnet-5-5": { standard: { input: 2, write5m: 2.5, write1h: 4, cacheRead: 0.1, output: 10 } },
  "sonnet-5": { standard: { input: 2, write5m: 2.5, write1h: 4, cacheRead: 0.2, output: 10 } },
  "fable-5-1": { standard: { input: 10, write5m: 12.5, write1h: 20, cacheRead: 0.25, output: 50 } },
  "haiku-4-5": { standard: { input: 1, write5m: 1.25, write1h: 2, cacheRead: 0.1, output: 5 } },
};

/**
 * Strips a `[1m]` context-window marker and a trailing `-YYYYMMDD` release-date suffix, then requires
 * the result to look like a model id (`claude-...`) or the literal `<synthetic>`; anything else is
 * reported as "unknown-model" rather than guessed at.
 */
export function normalizeModel(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) return "unknown-model";
  if (raw === "<synthetic>") return "<synthetic>";
  const stripped = raw.replace(/\[1m\]/g, "").replace(/-\d{8}$/, "");
  return /^claude-[a-z0-9-]{1,40}$/.test(stripped) ? stripped : "unknown-model";
}

function ratesFor(model: string, fast: boolean): Rates | null {
  if (!model.startsWith("claude-")) return null;
  const entry = PRICING[model.slice("claude-".length)];
  if (!entry) return null;
  if (fast) return entry.fast ?? null;
  return entry.standard;
}

export function isPriceableModel(model: string): boolean {
  return model.startsWith("claude-") && model.slice("claude-".length) in PRICING;
}

export interface CallUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  /** cache_creation_input_tokens with no 5m/1h breakdown in the event. */
  cacheWriteUnsplit: number;
  webSearchRequests: number;
}

export interface CallCost {
  /** false when the model/fast combination has no verified rate; costs are then 0 and the call counts as unpriced. */
  priced: boolean;
  costUsd: number;
  /** Sensitivity figure: the same call if every cache write (including 1h) had been billed at the 5m rate. */
  costUsdAllWritesAt5m: number;
}

const ZERO_COST: CallCost = { priced: false, costUsd: 0, costUsdAllWritesAt5m: 0 };

/** Just the cache-write portion of a call's cost (used for the rebuild cost-share metric); 0 when unpriced. */
export function writeCostOf(usage: CallUsage, model: string, fast: boolean): number {
  const r = ratesFor(model, fast);
  if (!r) return 0;
  return (usage.cacheWrite5m / MTOK) * r.write5m + (usage.cacheWrite1h / MTOK) * r.write1h + (usage.cacheWriteUnsplit / MTOK) * r.write5m;
}

/** The cost of one call's usage at the given model and speed. Unpriced models/speeds cost nothing and are flagged. */
export function costOf(usage: CallUsage, model: string, fast: boolean): CallCost {
  const r = ratesFor(model, fast);
  if (!r) return ZERO_COST;
  const base = (usage.input / MTOK) * r.input + (usage.output / MTOK) * r.output + (usage.cacheRead / MTOK) * r.cacheRead + usage.webSearchRequests * WEB_SEARCH_PRICE_PER_CALL;
  const costUsd = base + (usage.cacheWrite5m / MTOK) * r.write5m + (usage.cacheWrite1h / MTOK) * r.write1h + (usage.cacheWriteUnsplit / MTOK) * r.write5m;
  const allWritesAt5m = base + ((usage.cacheWrite5m + usage.cacheWrite1h + usage.cacheWriteUnsplit) / MTOK) * r.write5m;
  return { priced: true, costUsd, costUsdAllWritesAt5m: allWritesAt5m };
}
