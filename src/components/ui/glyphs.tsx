// Hand-written status glyphs on a 16×16 grid, used inline in HTML (Glyph) and inside the map SVG
// (GLYPHS paths). No emoji or Unicode symbols: macOS would render several of those as colour emoji.
import type { SVGProps } from "react";

export type GlyphName = "warning" | "check" | "lock" | "cross" | "dot" | "question" | "chevron" | "pulse" | "folder";

/** Path data centred on (8, 8); stroke-based, 1.5 wide, no fill unless the path closes a dot. */
export const GLYPHS: Record<GlyphName, string> = {
  warning: "M8 2.5 L14.5 13.5 L1.5 13.5 Z M8 6.5 V9.8 M8 11.6 V11.9",
  check: "M3 8.5 L6.6 12 L13 4.5",
  lock: "M4.5 7.5 H11.5 V13.5 H4.5 Z M6 7.5 V5.2 A2 2 0 0 1 10 5.2 V7.5",
  cross: "M4 4 L12 12 M12 4 L4 12",
  dot: "M8 8 m-2.5 0 a2.5 2.5 0 1 0 5 0 a2.5 2.5 0 1 0 -5 0",
  question: "M5.5 6 A2.5 2.5 0 1 1 8.6 8.4 C8 8.7 8 9.2 8 10 M8 12.2 V12.5",
  chevron: "M5 3 L11 8 L5 13",
  pulse: "M1.5 8 H5 L6.8 4 L9.3 12 L11 8 H14.5",
  folder: "M2 5.5 H6.5 L8 7 H14 V12.5 H2 Z",
};

export interface GlyphProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: GlyphName;
  size?: number;
  /** A visible label makes the glyph a graphic with meaning; without one it is decorative. */
  title?: string;
}

export function Glyph({ name, size = 12, title, className, ...rest }: GlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
      {...rest}
    >
      <path d={GLYPHS[name]} fill={name === "dot" ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The same glyph as a group inside the map SVG, centred at (x, y) and scaled to `size` world units. */
export function MapGlyph({ name, x, y, size = 14, className }: { name: GlyphName; x: number; y: number; size?: number; className?: string }) {
  const k = size / 16;
  return (
    <g transform={`translate(${x - size / 2} ${y - size / 2}) scale(${k})`} className={className} aria-hidden="true">
      <path d={GLYPHS[name]} fill={name === "dot" ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.5 / k} strokeLinecap="round" strokeLinejoin="round" />
    </g>
  );
}
