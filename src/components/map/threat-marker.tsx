"use client";
import { cn } from "@/lib/utils";
import { nodeName, type ThreatModel } from "@/lib/ui/command-map";
import { MARKER_R, type Point } from "@/lib/ui/layout";
import { MapGlyph } from "@/components/ui/glyphs";
import { MapItem, type Opener } from "@/components/map/map-node";

const R = MARKER_R;
const LABEL_GAP = 8;

/** A finding as a marker in its anchor's lane: a warning triangle while active, a ring otherwise, with a two-line id / severity label. */
export function ThreatMarker({ threat, at, labelSide, selected, onSelect }: { threat: ThreatModel; at: Point; labelSide: "left" | "right"; selected: boolean; onSelect: (o: Opener) => void }) {
  const f = threat.finding;
  const label = `${f.severity} finding ${f.id}, ${f.status} (${threat.classLabel.toLowerCase()}), from ${f.sources.join(", ") || "unknown source"}: ${f.title}`;
  const triangle = `M0 ${-R - 1} L${R + 1} ${R - 2} L${-R - 1} ${R - 2} Z`;
  const isActive = threat.threatClass === "active";
  const tx = labelSide === "right" ? R + LABEL_GAP : -R - LABEL_GAP;
  const anchor = labelSide === "right" ? "start" : "end";
  return (
    <MapItem label={label} selected={selected} onSelect={onSelect} className={cn("threat", `threat-${threat.threatClass}`, `sev-${f.severity}`)} ring={<circle className="focus-ring" cx={at.x} cy={at.y} r={R + 6} />}>
      <g transform={`translate(${at.x} ${at.y})`}>
        {isActive ? (
          <>
            <path className="threat-glow" d={triangle} />
            <path className="threat-shape" d={triangle} />
            <MapGlyph name="warning" x={0} y={1} size={12} className="threat-glyph" />
          </>
        ) : (
          <>
            <circle className="threat-glow" r={R} />
            <circle className="threat-shape" r={R} strokeDasharray={threat.threatClass === "dismissed" || threat.threatClass === "unknown" ? "2 3" : undefined} />
            <MapGlyph name={threat.threatClass === "resolved" ? "check" : threat.threatClass === "neutralizing" ? "pulse" : threat.threatClass === "dismissed" ? "cross" : "question"} x={0} y={0} size={11} className="threat-glyph" />
          </>
        )}
        <circle className="hit-fill" r={R + 4} />
        <text className="threat-id" x={tx} y={-3} style={{ textAnchor: anchor }}>
          {f.id}
        </text>
        <text className="threat-sev" x={tx} y={15} style={{ textAnchor: anchor }}>
          {f.severity}
        </text>
      </g>
    </MapItem>
  );
}

/** The "+n" chip in a full lane: the findings of that anchor that are not drawn; it opens the anchor's panel. */
export function ThreatOverflowChip({ anchor, count, at, labelSide, onSelect }: { anchor: string; count: number; at: Point; labelSide: "left" | "right"; onSelect: (o: Opener) => void }) {
  const tx = labelSide === "right" ? R + LABEL_GAP : -R - LABEL_GAP;
  return (
    <MapItem label={`${count} more finding(s) anchored to ${nodeName(anchor)}; opens its panel`} selected={false} onSelect={onSelect} className="threat threat-more" ring={<circle className="focus-ring" cx={at.x} cy={at.y} r={R + 6} />}>
      <g transform={`translate(${at.x} ${at.y})`}>
        <circle className="threat-shape" r={R} />
        <path className="threat-glyph threat-plus" d="M-5 0 H5 M0 -5 V5" />
        <circle className="hit-fill" r={R + 4} />
        <text className="threat-sev" x={tx} y={5} style={{ textAnchor: labelSide === "right" ? "start" : "end" }}>
          +{count} MORE
        </text>
      </g>
    </MapItem>
  );
}
