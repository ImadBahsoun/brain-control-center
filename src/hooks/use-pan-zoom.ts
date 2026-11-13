"use client";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { applyKey, fitView, keyAction, panBy, pinchZoom, RESET, zoomAt, type Size, type View } from "@/lib/ui/viewport";

/** plain: a wheel zooms (the full-height map view). modifier: only Ctrl/⌘ + wheel zooms and the page scrolls normally. */
export type WheelZoom = "plain" | "modifier";

const DRAG_THRESHOLD = 4;

/**
 * Zoom and pan of an SVG scene: the wheel (attached by hand so it can preventDefault), dragging the
 * background, two-finger pinch (only while `touchGestures` is true — Focus Mode below the 1024px desktop
 * breakpoint, where the map owns touch gestures outright), Fit, the + − arrow 0 keys and the zoom
 * buttons. `center` is the viewBox point the keys and buttons zoom around; pass a module constant so it
 * stays stable. `world` is the scene's fixed viewBox size (WORLD / OFFICE_WORLD), used both as the Fit
 * viewBox and to read the content group's bounds. `touchGestures` is deliberately separate from
 * `wheelZoom`: the wide desktop layout (≥ 1100px) also uses `wheelZoom === "plain"` for a bare wheel to
 * zoom, but must never arm the touch-only paths (R12) — a mouse or a trackpad's page-pinch keep behaving
 * exactly as on a desktop that never shipped touch support.
 */
export function usePanZoom({ center, wheelZoom, world, touchGestures }: { center: { x: number; y: number }; wheelZoom: WheelZoom; world: Size; touchGestures: boolean }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const contentRef = useRef<SVGGElement>(null);
  const [view, setView] = useState<View>(RESET);
  const [panning, setPanning] = useState(false);
  const drag = useRef<{ id: number; startX: number; startY: number; origin: View; moved: boolean } | null>(null);
  // every pointer currently down on the svg (bubbled from the background rect or a node), by id, in
  // client coordinates; `pinch` is set once a second pointer arrives and holds the gesture's fixed
  // starting view and finger positions (in viewBox coordinates) for the rest of the gesture
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ ids: [number, number]; startView: View; a0: { x: number; y: number }; b0: { x: number; y: number } } | null>(null);

  /** Client coordinates → viewBox coordinates (before the pan/zoom group). */
  const toViewBox = useCallback(
    (clientX: number, clientY: number) => {
      const svg = svgRef.current;
      const ctm = svg?.getScreenCTM();
      if (!svg || !ctm) return center;
      const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
      return { x: p.x, y: p.y };
    },
    [center],
  );

  // React's onWheel is passive, so the wheel listener is attached by hand to be able to preventDefault.
  // In modifier mode a plain wheel is left to the page, so a long page still scrolls past the map.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      if (wheelZoom === "modifier" && !e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0015);
      const point = toViewBox(e.clientX, e.clientY);
      setView((v) => zoomAt(v, factor, point));
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [toViewBox, wheelZoom]);

  // Safari's non-standard pinch-to-zoom-the-page gesture fires `gesturestart` before any pointer event;
  // suppressing it is the only way to keep a two-finger pinch on the map from also zooming the whole
  // page. Kept on its own effect, keyed only by `touchGestures` (never `wheelZoom`): the wide desktop
  // layout also has wheelZoom "plain", but must keep the trackpad's ordinary page-pinch working (R12).
  // The cleanup also clears any pointer/pinch bookkeeping: leaving touch-gesture ownership (e.g. exiting
  // Focus Mode with a finger still down) must never leave a stale pointer behind for the next owner of
  // this element (R11).
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onGestureStart = (e: Event) => {
      if (touchGestures) e.preventDefault();
    };
    svg.addEventListener("gesturestart", onGestureStart as EventListener);
    return () => {
      svg.removeEventListener("gesturestart", onGestureStart as EventListener);
      pointers.current.clear();
      pinch.current = null;
    };
  }, [touchGestures]);

  const onPointerDown = (e: ReactPointerEvent<SVGRectElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, startX: e.clientX, startY: e.clientY, origin: view, moved: false };
  };
  const onPointerMove = (e: ReactPointerEvent<SVGRectElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    d.moved = true;
    setPanning(true);
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    const k = ctm ? ctm.a : 1;
    setView(panBy(d.origin, dx / k, dy / k));
  };
  const endDrag = (e: ReactPointerEvent<SVGRectElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    setPanning(false);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // the map keys (+ − arrows 0) work wherever focus sits inside the map; nodes handle Enter and Space themselves
    const action = keyAction(e.key);
    if (!action) return;
    e.preventDefault();
    setView((v) => applyKey(v, action, center));
  };

  // Two-finger pinch, spread on the <svg> itself so pointers started on a node (not just the background
  // rect) still count: only tracked while `touchGestures` is true, and only touch pointers (R12) — a
  // mouse or pen pointer here would otherwise leave a stale entry if it is released outside the svg.
  const onSvgPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!touchGestures || e.pointerType !== "touch") return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && !pinch.current) {
      const entries = [...pointers.current.entries()];
      const entry1 = entries[0];
      const entry2 = entries[1];
      if (entry1 && entry2) {
        const [id1, p1] = entry1;
        const [id2, p2] = entry2;
        // a second finger landing always starts a pinch, never a hand-off from an in-progress one-finger pan
        drag.current = null;
        setPanning(false);
        pinch.current = { ids: [id1, id2], startView: view, a0: toViewBox(p1.x, p1.y), b0: toViewBox(p2.x, p2.y) };
      }
    }
  };
  const onSvgPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    // membership in `pointers` already proves this id was accepted by `onSvgPointerDown` under
    // `touchGestures`; once that flips off the mode-change effect above clears the map, so a move that
    // arrives after leaving touch-gesture ownership finds nothing tracked and is a no-op (R11, R12)
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const p = pinch.current;
    if (!p) return;
    const p1 = pointers.current.get(p.ids[0]);
    const p2 = pointers.current.get(p.ids[1]);
    if (!p1 || !p2) return;
    setView(pinchZoom(p.startView, p.a0, p.b0, toViewBox(p1.x, p1.y), toViewBox(p2.x, p2.y)));
  };
  // ALWAYS deletes the id and resets a now-incomplete pinch, in every mode: a pointer that was accepted
  // while touchGestures was true must not go stale if the mode changes (e.g. Focus Mode exits) before
  // this same finger lifts (R11). Gating this on the current mode was the R11 bug.
  const endSvgPointer = (e: ReactPointerEvent<SVGSVGElement>) => {
    pointers.current.delete(e.pointerId);
    // fewer than two fingers ends the gesture outright; it never hands off to a one-finger pan
    if (pointers.current.size < 2) pinch.current = null;
  };

  return {
    svgRef,
    contentRef,
    view,
    panning,
    bgHandlers: { onPointerDown, onPointerMove, onPointerUp: endDrag, onPointerCancel: endDrag },
    svgHandlers: { onPointerDown: onSvgPointerDown, onPointerMove: onSvgPointerMove, onPointerUp: endSvgPointer, onPointerCancel: endSvgPointer },
    onKeyDown,
    zoomIn: () => setView((v) => zoomAt(v, 1.2, center)),
    zoomOut: () => setView((v) => zoomAt(v, 1 / 1.2, center)),
    reset: () => setView(RESET),
    fit: () => {
      const svg = svgRef.current;
      const content = contentRef.current;
      if (!svg || !content) return;
      setView(fitView(content.getBBox(), world, svg.getBoundingClientRect()));
    },
  };
}
