import { describe, expect, it } from "vitest";
import { costOf, isPriceableModel, MTOK, normalizeModel, PRICING_CHECKED_AT, PRICING_SOURCE, WEB_SEARCH_PRICE_PER_CALL } from "@/server/tokens/pricing";

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnsplit: 0, webSearchRequests: 0 };

describe("normalizeModel", () => {
  it("strips a [1m] marker and a trailing release-date suffix", () => {
    expect(normalizeModel("claude-sonnet-5-5-20261015")).toBe("claude-sonnet-5-5");
    expect(normalizeModel("claude-sonnet-5-5[1m]-20261015")).toBe("claude-sonnet-5-5");
    expect(normalizeModel("claude-opus-5-5[1m]")).toBe("claude-opus-5-5");
  });
  it("passes through <synthetic> and labels anything else unknown-model", () => {
    expect(normalizeModel("<synthetic>")).toBe("<synthetic>");
    expect(normalizeModel("gpt-4")).toBe("unknown-model");
    expect(normalizeModel("")).toBe("unknown-model");
    expect(normalizeModel(null)).toBe("unknown-model");
    expect(normalizeModel(42)).toBe("unknown-model");
  });
});

describe("costOf", () => {
  const models = [
    ["claude-opus-5-5", { input: 4, write5m: 5, write1h: 8, cacheRead: 0.2, output: 20 }],
    ["claude-opus-5", { input: 5, write5m: 6.25, write1h: 10, cacheRead: 0.5, output: 25 }],
    ["claude-opus-4-8", { input: 5, write5m: 6.25, write1h: 10, cacheRead: 0.5, output: 25 }],
    ["claude-sonnet-5-5", { input: 2, write5m: 2.5, write1h: 4, cacheRead: 0.1, output: 10 }],
    ["claude-sonnet-5", { input: 2, write5m: 2.5, write1h: 4, cacheRead: 0.2, output: 10 }],
    ["claude-fable-5-1", { input: 10, write5m: 12.5, write1h: 20, cacheRead: 0.25, output: 50 }],
    ["claude-haiku-4-5", { input: 1, write5m: 1.25, write1h: 2, cacheRead: 0.1, output: 5 }],
  ] as const;

  it("prices each known model's standard rate per MTok", () => {
    for (const [model, rates] of models) {
      expect(isPriceableModel(model), model).toBe(true);
      const r = costOf({ ...ZERO, input: MTOK }, model, false);
      expect(r.priced, model).toBe(true);
      expect(r.costUsd).toBeCloseTo(rates.input, 10);
      expect(costOf({ ...ZERO, output: MTOK }, model, false).costUsd).toBeCloseTo(rates.output, 10);
      expect(costOf({ ...ZERO, cacheRead: MTOK }, model, false).costUsd).toBeCloseTo(rates.cacheRead, 10);
      expect(costOf({ ...ZERO, cacheWrite5m: MTOK }, model, false).costUsd).toBeCloseTo(rates.write5m, 10);
      expect(costOf({ ...ZERO, cacheWrite1h: MTOK }, model, false).costUsd).toBeCloseTo(rates.write1h, 10);
    }
  });

  it("leaves an unknown model unpriced, at zero cost, never guessed", () => {
    const r = costOf({ ...ZERO, input: MTOK }, "unknown-model", false);
    expect(r).toEqual({ priced: false, costUsd: 0, costUsdAllWritesAt5m: 0 });
    expect(isPriceableModel("unknown-model")).toBe(false);
    expect(isPriceableModel("<synthetic>")).toBe(false);
  });

  it("prices verified fast-mode rates for opus models and leaves unverified fast combinations unpriced", () => {
    expect(costOf({ ...ZERO, input: MTOK }, "claude-opus-5-5", true).costUsd).toBeCloseTo(8, 10);
    expect(costOf({ ...ZERO, output: MTOK }, "claude-opus-5-5", true).costUsd).toBeCloseTo(40, 10);
    expect(costOf({ ...ZERO, input: MTOK }, "claude-opus-5", true).costUsd).toBeCloseTo(10, 10);
    expect(costOf({ ...ZERO, output: MTOK }, "claude-opus-4-8", true).costUsd).toBeCloseTo(50, 10);
    // sonnet has no verified fast price: a fast call on it is unpriced, not guessed from the standard rate
    const r = costOf({ ...ZERO, input: MTOK }, "claude-sonnet-5", true);
    expect(r.priced).toBe(false);
  });

  it("prices web search at $10 per 1,000 requests", () => {
    const r = costOf({ ...ZERO, webSearchRequests: 1000 }, "claude-sonnet-5", false);
    expect(r.costUsd).toBeCloseTo(10, 10);
    expect(WEB_SEARCH_PRICE_PER_CALL).toBeCloseTo(0.01, 10);
  });

  it("computes the exact 1h-vs-5m sensitivity delta for an unsplit or 1h-heavy call", () => {
    const r = costOf({ ...ZERO, cacheWrite1h: MTOK }, "claude-sonnet-5", false);
    expect(r.costUsd).toBeCloseTo(4, 10); // billed at the real 1h rate
    expect(r.costUsdAllWritesAt5m).toBeCloseTo(2.5, 10); // the same tokens, recomputed at the 5m rate
    expect(r.costUsd).not.toBeCloseTo(r.costUsdAllWritesAt5m, 5);

    const unsplit = costOf({ ...ZERO, cacheWriteUnsplit: MTOK }, "claude-sonnet-5", false);
    expect(unsplit.costUsd).toBeCloseTo(2.5, 10); // unsplit writes are priced at the 5m rate
    expect(unsplit.costUsdAllWritesAt5m).toBeCloseTo(2.5, 10);
  });

  it("documents the pricing source and the date it was checked", () => {
    expect(PRICING_SOURCE).toMatch(/^https:\/\//);
    expect(PRICING_CHECKED_AT).toBe("2026-10-20");
  });
});
