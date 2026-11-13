"use client";
import { useEffect, useRef, type KeyboardEvent } from "react";
import { dateTime } from "@/lib/format";
import { REPLAY_GAPS, REPLAY_SPEEDS, type ReplaySpeed } from "@/lib/ui/replay";
import type { ReplayControl } from "@/hooks/use-replay";

/**
 * The Mission Replay controls: first / back / play-pause / forward / last, speed, a scrubber and Exit, all
 * keyboard buttons. It says REPLAY and shows each step's recorded seq and timestamp; it changes nothing in
 * the store. Focus moves to Play when it opens; Esc inside the bar leaves the replay.
 */
export function ReplayBar({ replay, onExit }: { replay: ReplayControl; onExit: () => void }) {
  const play = useRef<HTMLButtonElement>(null);
  const { state, frame, dispatch } = replay;
  const total = state.length;
  useEffect(() => {
    play.current?.focus();
  }, []);
  if (!frame) return null;
  const step = frame.step;
  const where = `step ${state.index + 1} of ${total} · #${step.seq} · recorded ${dateTime(step.ts)}`;
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onExit();
    }
  };
  return (
    <div className="hud replay-bar flex flex-col gap-1.5 px-3 py-2" role="group" aria-label="Mission replay" onKeyDown={onKey}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="chip chip-synth">REPLAY</span>
        <span className="label num text-dim">{where}</span>
        <span className="line-clamp-2 min-w-0 basis-full text-[12px] text-foreground" title={step.item.text}>
          {step.item.text}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" className="btn" onClick={() => dispatch({ type: "seek", index: 0 })} aria-label="First step">
          First
        </button>
        <button type="button" className="btn" onClick={() => dispatch({ type: "step", delta: -1 })} aria-label="Step back">
          −1
        </button>
        <button ref={play} type="button" className="btn active min-w-[64px]" aria-pressed={state.playing} onClick={() => dispatch({ type: state.playing ? "pause" : "play" })}>
          {state.playing ? "Pause" : "Play"}
        </button>
        <button type="button" className="btn" onClick={() => dispatch({ type: "step", delta: 1 })} aria-label="Step forward">
          +1
        </button>
        <button type="button" className="btn" onClick={() => dispatch({ type: "seek", index: total - 1 })} aria-label="Last step">
          Last
        </button>
        <label className="label flex items-center gap-1 text-dim">
          speed
          <select className="btn" value={state.speed} onChange={(e) => dispatch({ type: "speed", speed: Number(e.target.value) as ReplaySpeed })} aria-label="Replay speed">
            {REPLAY_SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </label>
        <input
          type="range"
          className="replay-scrub min-w-[140px] flex-1"
          min={0}
          max={Math.max(0, total - 1)}
          step={1}
          value={state.index}
          onChange={(e) => dispatch({ type: "seek", index: Number(e.target.value) })}
          aria-label="Replay position"
          aria-valuetext={`${where}: ${step.item.text}`}
        />
        <button type="button" className="btn" onClick={onExit}>
          Exit replay
        </button>
      </div>
      <details className="replay-gaps">
        <summary className="cursor-pointer label text-faint">Not in replay · {REPLAY_GAPS.length + replay.caveats.length}</summary>
        <ul className="mt-1 list-inside list-disc text-[11px] text-dim">
          {replay.caveats.map((c) => (
            <li key={c} className="tone-warn">
              {c}
            </li>
          ))}
          {REPLAY_GAPS.map((g) => (
            <li key={g}>{g}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}
