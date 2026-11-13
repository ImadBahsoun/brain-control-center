// Zoom and pan math for the command map. A View maps world coordinates to viewBox coordinates:
// screen = view.{x,y} + view.k × world. Pure.

export interface View {
  x: number;
  y: number;
  k: number;
}

export const RESET: View = { x: 0, y: 0, k: 1 };
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 2.5;
export const KEY_PAN = 40;
export const KEY_ZOOM = 1.2;

export function clampZoom(k: number): number {
  if (!Number.isFinite(k)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
}

/** Zooms by `factor` keeping the world point under `point` (viewBox coordinates) fixed on screen. */
export function zoomAt(view: View, factor: number, point: { x: number; y: number }): View {
  const k = clampZoom(view.k * factor);
  if (k === view.k) return view;
  const wx = (point.x - view.x) / view.k;
  const wy = (point.y - view.y) / view.k;
  return { x: point.x - k * wx, y: point.y - k * wy, k };
}

export function panBy(view: View, dx: number, dy: number): View {
  if (dx === 0 && dy === 0) return view;
  return { x: view.x + dx, y: view.y + dy, k: view.k };
}

export function toTransform(view: View): string {
  return `translate(${view.x} ${view.y}) scale(${view.k})`;
}

export type KeyAction = { type: "zoom"; factor: number } | { type: "pan"; dx: number; dy: number } | { type: "reset" };

/** +/= and − zoom, the arrows pan, 0 resets; anything else is not a map key. */
export function keyAction(key: string): KeyAction | null {
  switch (key) {
    case "+":
    case "=":
      return { type: "zoom", factor: KEY_ZOOM };
    case "-":
    case "_":
      return { type: "zoom", factor: 1 / KEY_ZOOM };
    case "ArrowLeft":
      return { type: "pan", dx: KEY_PAN, dy: 0 };
    case "ArrowRight":
      return { type: "pan", dx: -KEY_PAN, dy: 0 };
    case "ArrowUp":
      return { type: "pan", dx: 0, dy: KEY_PAN };
    case "ArrowDown":
      return { type: "pan", dx: 0, dy: -KEY_PAN };
    case "0":
      return { type: "reset" };
    default:
      return null;
  }
}

export function applyKey(view: View, action: KeyAction, center: { x: number; y: number }): View {
  if (action.type === "reset") return RESET;
  if (action.type === "zoom") return zoomAt(view, action.factor, center);
  return panBy(view, action.dx, action.dy);
}

export interface Size {
  width: number;
  height: number;
}

export interface Bounds extends Size {
  x: number;
  y: number;
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number } {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Two-finger pinch + pan in one step, all points in viewBox coordinates: the world point under the
 * midpoint of (a0, b0) ends up under the midpoint of (a1, b1), and the zoom factor is the ratio of the
 * two finger-to-finger distances, clamped as any other zoom. A near-zero start distance (fingers landed
 * together) is too unstable to divide by, so the view is returned unchanged.
 */
export function pinchZoom(start: View, a0: { x: number; y: number }, b0: { x: number; y: number }, a1: { x: number; y: number }, b1: { x: number; y: number }): View {
  const d0 = distance(a0, b0);
  if (d0 < 1) return start;
  const k = clampZoom(start.k * (distance(a1, b1) / d0));
  const m0 = midpoint(a0, b0);
  const m1 = midpoint(a1, b1);
  const wx = (m0.x - start.x) / start.k;
  const wy = (m0.y - start.y) / start.k;
  return { x: m1.x - k * wx, y: m1.y - k * wy, k };
}

/**
 * The view that fits `bounds` (world coordinates, e.g. the scene's getBBox()) inside `client` (the SVG
 * element's client rect), centred, accounting for the SVG's own `preserveAspectRatio="xMidYMid meet"`
 * scaling from `viewBox` to `client`: at view = RESET the visible viewBox-unit region is
 * (client.width/s) × (client.height/s), where s is the meet scale factor, centred on the viewBox centre.
 * Degenerate inputs (a zero or non-finite client, viewBox or bounds size) return RESET.
 */
export function fitView(bounds: Bounds, viewBox: Size, client: Size, pad = 24): View {
  const finitePositive = (n: number) => Number.isFinite(n) && n > 0;
  if (!finitePositive(client.width) || !finitePositive(client.height)) return RESET;
  if (!finitePositive(viewBox.width) || !finitePositive(viewBox.height)) return RESET;
  if (!finitePositive(bounds.width) || !finitePositive(bounds.height)) return RESET;
  const s = Math.min(client.width / viewBox.width, client.height / viewBox.height);
  if (!finitePositive(s)) return RESET;
  const visibleWidth = client.width / s;
  const visibleHeight = client.height / s;
  const k = clampZoom(Math.min(visibleWidth / (bounds.width + 2 * pad), visibleHeight / (bounds.height + 2 * pad)));
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  return { x: viewBox.width / 2 - k * centerX, y: viewBox.height / 2 - k * centerY, k };
}
