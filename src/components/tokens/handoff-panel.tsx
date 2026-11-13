"use client";
import type { TokenIntelligenceResponse } from "@/lib/api-types";
import { formatTokens, formatUsd } from "@/lib/ui/tokens";

export function HandoffPanel({ handoff, instructionReads }: { handoff: TokenIntelligenceResponse["handoff"]; instructionReads: TokenIntelligenceResponse["instructionReads"] }) {
  return (
    <section className="hud">
      <div className="border-b border-border px-3 py-1.5">
        <h2 className="hud-title">Handoff and instruction reads</h2>
      </div>
      <div className="grid grid-cols-2 gap-2 px-3 py-2 min-[700px]:grid-cols-3">
        <p className="label text-dim">
          Subagent launches
          <br />
          <span className="num text-foreground">{formatTokens(handoff.subagentRuns)}</span>
        </p>
        <p className="label text-dim">
          Launch context
          <br />
          <span className="num text-foreground">{formatTokens(handoff.launchContextTokens)}</span>
        </p>
        <p className="label text-dim">
          Launch cost
          <br />
          <span className="num text-foreground">{formatUsd(handoff.launchCostUsd)}</span>
        </p>
        <p className="label text-dim">
          Packets sent
          <br />
          <span className="num text-foreground">
            {formatTokens(handoff.packets.count)} · {formatTokens(handoff.packets.chars)} chars
          </span>
        </p>
        <p className="label text-dim">
          Hand-backs
          <br />
          <span className="num text-foreground">
            {formatTokens(handoff.handbacks.count)} · {formatTokens(handoff.handbacks.chars)} chars
          </span>
        </p>
        <p className="label text-dim">
          Hand-back messages to Brain (measured proxy)
          <br />
          <span className="num text-foreground">
            {formatTokens(handoff.handbackMessagesToBrain.count)} · {formatTokens(handoff.handbackMessagesToBrain.chars)} chars
          </span>
        </p>
        <p className="label text-dim">
          Report re-emission into brain-state
          <br />
          <span className="text-foreground">{handoff.reportReemission.note}</span>
        </p>
      </div>
      <div className="border-t border-border px-3 py-2">
        <p className="label text-dim">Instruction reads: {formatTokens(instructionReads.total)} total (chars ÷ 4, an estimate)</p>
        <ul className="mt-1 flex flex-col gap-0.5">
          {instructionReads.byDoc.map((d) => (
            <li key={d.doc} className="label flex justify-between gap-2">
              <span>{d.doc}</span>
              <span className="num">
                {formatTokens(d.count)} reads · ~{formatTokens(d.approxTokens)} tok
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
