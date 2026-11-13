"use client";
import { cn } from "@/lib/utils";

export function MapControls({
  onZoomIn,
  onZoomOut,
  onReset,
  onFit,
  zoom,
  className,
}: {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  /** Fits the scene's current bounds to the view; only reachable below the 1024px desktop breakpoint (Focus Mode), where the desktop toolbar is unchanged. */
  onFit?: () => void;
  zoom: number;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-1 touch-manipulation", className)} role="toolbar" aria-label="Map view controls">
      <button type="button" className="btn max-md:min-w-11 max-lg:pointer-coarse:min-w-11" onClick={onZoomOut} aria-label="Zoom out">
        −
      </button>
      <span className="label num px-1 text-faint" aria-live="off">
        {Math.round(zoom * 100)}%
      </span>
      <button type="button" className="btn max-md:min-w-11 max-lg:pointer-coarse:min-w-11" onClick={onZoomIn} aria-label="Zoom in">
        +
      </button>
      <button type="button" className="btn max-md:min-w-11 max-lg:pointer-coarse:min-w-11" onClick={onReset} aria-label="Reset the map view">
        Reset
      </button>
      {onFit && (
        <button type="button" className="btn lg:hidden max-md:min-w-11 max-lg:pointer-coarse:min-w-11" onClick={onFit} aria-label="Fit the map to the screen">
          Fit
        </button>
      )}
    </div>
  );
}
