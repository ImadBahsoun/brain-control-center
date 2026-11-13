import { describe, expect, it } from "vitest";
import { applyKey, clampZoom, fitView, keyAction, MAX_ZOOM, MIN_ZOOM, panBy, pinchZoom, RESET, toTransform, zoomAt } from "@/lib/ui/viewport";

describe("viewport math", () => {
  it("clamps the zoom to 0.5–2.5 and treats a non-finite value as 1", () => {
    expect(clampZoom(0.1)).toBe(MIN_ZOOM);
    expect(clampZoom(9)).toBe(MAX_ZOOM);
    expect(clampZoom(1.3)).toBe(1.3);
    expect(clampZoom(Number.NaN)).toBe(1);
  });
  it("keeps the world point under the cursor fixed when zooming", () => {
    const view = { x: 40, y: -20, k: 1.25 };
    const cursor = { x: 300, y: 500 };
    const worldBefore = { x: (cursor.x - view.x) / view.k, y: (cursor.y - view.y) / view.k };
    const next = zoomAt(view, 1.5, cursor);
    expect(next.k).toBeCloseTo(1.875, 9);
    expect(next.x + next.k * worldBefore.x).toBeCloseTo(cursor.x, 9);
    expect(next.y + next.k * worldBefore.y).toBeCloseTo(cursor.y, 9);
  });
  it("returns the same view when the zoom is already at its bound", () => {
    const view = { x: 0, y: 0, k: MAX_ZOOM };
    expect(zoomAt(view, 2, { x: 10, y: 10 })).toBe(view);
  });
  it("pans by a delta and leaves the view untouched for a zero delta", () => {
    expect(panBy({ x: 1, y: 2, k: 1 }, 5, -7)).toEqual({ x: 6, y: -5, k: 1 });
    const v = { x: 1, y: 2, k: 1 };
    expect(panBy(v, 0, 0)).toBe(v);
  });
  it("maps keys: + and − zoom, arrows pan, 0 resets, others are ignored", () => {
    expect(keyAction("+")).toEqual({ type: "zoom", factor: 1.2 });
    expect(keyAction("=")).toEqual({ type: "zoom", factor: 1.2 });
    expect(keyAction("-")?.type).toBe("zoom");
    expect(keyAction("ArrowLeft")).toEqual({ type: "pan", dx: 40, dy: 0 });
    expect(keyAction("ArrowRight")).toEqual({ type: "pan", dx: -40, dy: 0 });
    expect(keyAction("ArrowUp")).toEqual({ type: "pan", dx: 0, dy: 40 });
    expect(keyAction("ArrowDown")).toEqual({ type: "pan", dx: 0, dy: -40 });
    expect(keyAction("0")).toEqual({ type: "reset" });
    expect(keyAction("a")).toBeNull();
    expect(keyAction("Enter")).toBeNull();
  });
  it("applies a key action and renders the transform", () => {
    const center = { x: 600, y: 380 };
    expect(applyKey({ x: 9, y: 9, k: 2 }, { type: "reset" }, center)).toEqual(RESET);
    expect(applyKey(RESET, { type: "pan", dx: 40, dy: 0 }, center)).toEqual({ x: 40, y: 0, k: 1 });
    const zoomed = applyKey(RESET, { type: "zoom", factor: 1.2 }, center);
    expect(zoomed.k).toBeCloseTo(1.2, 9);
    expect(toTransform(RESET)).toBe("translate(0 0) scale(1)");
  });
});

describe("pinchZoom", () => {
  it("is a pure pan when the finger-to-finger distance does not change", () => {
    const start = { x: 10, y: -5, k: 1.2 };
    const a0 = { x: 100, y: 200 };
    const b0 = { x: 300, y: 200 };
    const dx = 15;
    const dy = -8;
    const next = pinchZoom(start, a0, b0, { x: a0.x + dx, y: a0.y + dy }, { x: b0.x + dx, y: b0.y + dy });
    expect(next.k).toBeCloseTo(start.k, 9);
    expect(next.x).toBeCloseTo(start.x + dx, 9);
    expect(next.y).toBeCloseTo(start.y + dy, 9);
  });

  it("keeps the world point under the midpoint fixed when the distance doubles", () => {
    const start = { x: 0, y: 0, k: 1 };
    const m = { x: 600, y: 440 };
    const a0 = { x: m.x - 100, y: m.y };
    const b0 = { x: m.x + 100, y: m.y };
    const a1 = { x: m.x - 200, y: m.y };
    const b1 = { x: m.x + 200, y: m.y };
    const worldBefore = { x: (m.x - start.x) / start.k, y: (m.y - start.y) / start.k };
    const next = pinchZoom(start, a0, b0, a1, b1);
    expect(next.k).toBeCloseTo(2, 9);
    expect(next.x + next.k * worldBefore.x).toBeCloseTo(m.x, 9);
    expect(next.y + next.k * worldBefore.y).toBeCloseTo(m.y, 9);
  });

  it("clamps the resulting zoom at MIN_ZOOM and MAX_ZOOM", () => {
    const start = { x: 0, y: 0, k: 1 };
    const shrink = pinchZoom(start, { x: 500, y: 440 }, { x: 700, y: 440 }, { x: 599, y: 440 }, { x: 601, y: 440 });
    expect(shrink.k).toBe(MIN_ZOOM);
    const grow = pinchZoom(start, { x: 590, y: 440 }, { x: 610, y: 440 }, { x: 0, y: 440 }, { x: 1200, y: 440 });
    expect(grow.k).toBe(MAX_ZOOM);
  });

  it("returns the start view unchanged when the fingers start on top of each other", () => {
    const start = { x: 3, y: 4, k: 1.1 };
    const a0 = { x: 50, y: 50 };
    const b0 = { x: 50.5, y: 50 };
    expect(pinchZoom(start, a0, b0, { x: 100, y: 100 }, { x: 300, y: 300 })).toBe(start);
  });
});

describe("fitView", () => {
  const VIEWBOX = { width: 1200, height: 880 };
  const BOUNDS = { x: 100, y: 120, width: 400, height: 300 };

  it("fits the bounds in a portrait client, centred on the bounds' own centre", () => {
    const client = { width: 372, height: 413 };
    const view = fitView(BOUNDS, VIEWBOX, client);
    const centerX = BOUNDS.x + BOUNDS.width / 2;
    const centerY = BOUNDS.y + BOUNDS.height / 2;
    expect(view.x + view.k * centerX).toBeCloseTo(VIEWBOX.width / 2, 6);
    expect(view.y + view.k * centerY).toBeCloseTo(VIEWBOX.height / 2, 6);
    expect(view.k).toBeGreaterThanOrEqual(MIN_ZOOM);
    expect(view.k).toBeLessThanOrEqual(MAX_ZOOM);
  });

  it("fits the bounds in a landscape client, centred on the bounds' own centre", () => {
    const client = { width: 826, height: 229 };
    const view = fitView(BOUNDS, VIEWBOX, client);
    const centerX = BOUNDS.x + BOUNDS.width / 2;
    const centerY = BOUNDS.y + BOUNDS.height / 2;
    expect(view.x + view.k * centerX).toBeCloseTo(VIEWBOX.width / 2, 6);
    expect(view.y + view.k * centerY).toBeCloseTo(VIEWBOX.height / 2, 6);
    expect(view.k).toBeGreaterThanOrEqual(MIN_ZOOM);
    expect(view.k).toBeLessThanOrEqual(MAX_ZOOM);
  });

  it("clamps k at MAX_ZOOM for a tiny bounds box", () => {
    const view = fitView({ x: 590, y: 430, width: 4, height: 4 }, VIEWBOX, { width: 1200, height: 880 });
    expect(view.k).toBe(MAX_ZOOM);
  });

  it("clamps k at MIN_ZOOM for a huge bounds box", () => {
    const view = fitView({ x: -5000, y: -5000, width: 20000, height: 20000 }, VIEWBOX, { width: 1200, height: 880 });
    expect(view.k).toBe(MIN_ZOOM);
  });

  it("returns RESET for a zero client size", () => {
    expect(fitView(BOUNDS, VIEWBOX, { width: 0, height: 0 })).toEqual(RESET);
    expect(fitView(BOUNDS, VIEWBOX, { width: 0, height: 500 })).toEqual(RESET);
  });

  it("returns RESET for a non-finite or zero bounds size", () => {
    expect(fitView({ x: 0, y: 0, width: 0, height: 0 }, VIEWBOX, { width: 372, height: 413 })).toEqual(RESET);
    expect(fitView({ x: 0, y: 0, width: Number.NaN, height: 300 }, VIEWBOX, { width: 372, height: 413 })).toEqual(RESET);
  });
});
