"use client";
import type { Box } from "@/lib/ui/layout";
import { cardLines, fitWords, VALUE_CHAR, type CardLine, type GateAlert, type GateRoomModel, type OfficeCore, type RoleRoomModel } from "@/lib/ui/office";
import { labelBox } from "@/lib/ui/office-layout";
import { MapGlyph } from "@/components/ui/glyphs";
import { PHASE_TONE, STATE_TONE } from "@/components/map/map-node";
import { ElapsedSince } from "@/components/office/elapsed-since";
import { FIGURE_TONE, TEXT_TONE } from "@/components/office/office-prism";

const PAD = 10;
const FIRST = 22;
const PITCH = 17.5;
/** Lines under a card's header: three metrics plus one spare line for a long value. */
const ROLE_LINES = 4;

function Lines({ box, lines, first }: { box: Box; lines: CardLine[]; first: number }) {
  return (
    <>
      {lines.map((l, i) => {
        const y = box.y + FIRST + PITCH * (first + i);
        const fill = l.tone ? TEXT_TONE[l.tone] : undefined;
        return (
          <g key={i}>
            {l.label && (
              <text className="office-row" x={box.x + PAD} y={y}>
                {l.label}
              </text>
            )}
            {l.value && (
              <text className="office-num" x={box.x + box.w - PAD} y={y} style={{ textAnchor: "end", ...(fill ? { fill } : {}) }}>
                {l.value}
              </text>
            )}
          </g>
        );
      })}
    </>
  );
}

function CardFrame({ box, dot, title, right, rightFill }: { box: Box; dot: string; title: string; right?: string; rightFill?: string }) {
  return (
    <>
      <rect className="office-card-bg" x={box.x} y={box.y} width={box.w} height={box.h} rx={3} />
      <circle cx={box.x + PAD + 3} cy={box.y + FIRST - 5} r={3.5} style={{ fill: dot }} />
      <text className="office-title" x={box.x + PAD + 13} y={box.y + FIRST}>
        {title}
      </text>
      {right && (
        <text className="office-num" x={box.x + box.w - PAD} y={box.y + FIRST} style={{ textAnchor: "end", fill: rightFill ?? "var(--text-dim)" }}>
          {right}
        </text>
      )}
      <line className="office-card-rule" x1={box.x + PAD} x2={box.x + box.w - PAD} y1={box.y + FIRST + 6} y2={box.y + FIRST + 6} />
    </>
  );
}

export function RoomCard({ room }: { room: RoleRoomModel }) {
  const box = labelBox(room.id);
  const busy = room.busy > 0;
  return (
    <g className="office-card" aria-hidden="true">
      <CardFrame box={box} dot={FIGURE_TONE[room.figure.tone]} title={room.title} right={room.header} rightFill={busy ? FIGURE_TONE[room.figure.tone] : undefined} />
      <Lines box={box} lines={cardLines(room.metrics, box.w - 2 * PAD, ROLE_LINES)} first={1} />
    </g>
  );
}

export function GateCard({ gate }: { gate: GateRoomModel }) {
  const box = labelBox("gate");
  const tone = STATE_TONE[gate.state];
  const wordY = box.y + FIRST + PITCH;
  return (
    <g className="office-card" aria-hidden="true">
      <CardFrame box={box} dot={tone} title={gate.title} />
      <text className="office-num" x={box.x + PAD} y={wordY} style={{ fill: gate.state === "pending" ? "var(--text-dim)" : tone, fontWeight: 600 }}>
        {fitWords(gate.word, Math.floor((box.w - 2 * PAD) / VALUE_CHAR))}
      </text>
      <Lines box={box} lines={cardLines(gate.metrics, box.w - 2 * PAD, ROLE_LINES)} first={2} />
    </g>
  );
}

/** The gate alert under the gate card: live it counts from the recorded request; in a replay it says recorded. */
export function GateAlertCard({ alert }: { alert: GateAlert }) {
  const box = labelBox("gate-alert");
  const which = alert.kind === "plan" ? "plan gate" : "human gate";
  return (
    <g className="office-card" aria-hidden="true">
      <rect className="office-alert-bg" x={box.x} y={box.y} width={box.w} height={box.h} rx={3} />
      <MapGlyph name="warning" x={box.x + PAD + 6} y={box.y + 15} size={14} className="tone-warn" />
      <text className="office-alert" x={box.x + PAD + 18} y={box.y + 20}>
        {alert.recorded ? "AWAITED APPROVAL" : "WAITING ON YOU"}
      </text>
      <text className="office-row" x={box.x + PAD} y={box.y + 38} style={{ fill: "var(--text-dim)" }}>
        {alert.recorded ? `recorded · ${which}` : alert.since ? <ElapsedSince since={alert.since} /> : alert.outsideWindow ? `${which} · not in window` : which}
        {!alert.recorded && alert.since ? ` · ${which}` : ""}
      </text>
    </g>
  );
}

export function CoreCaption({ core }: { core: OfficeCore }) {
  const box = labelBox("core");
  const tone = core.alert ? "var(--danger)" : core.particles === "ambient" || core.word === "LOADING" ? "var(--text-dim)" : PHASE_TONE[core.phase];
  const cx = box.x + box.w / 2;
  return (
    <g className="office-card" aria-hidden="true">
      <rect className="office-card-bg" x={box.x} y={box.y} width={box.w} height={box.h} rx={3} />
      <text className="office-title" x={cx} y={box.y + 19} style={{ textAnchor: "middle" }}>
        THE BRAIN
      </text>
      <text className="office-num" x={cx} y={box.y + 37} style={{ textAnchor: "middle", fill: tone, fontWeight: 600 }}>
        {core.word}
      </text>
    </g>
  );
}
