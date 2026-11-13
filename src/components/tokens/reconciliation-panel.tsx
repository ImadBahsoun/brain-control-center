"use client";
import type { TokenIntelligenceResponse, TokenReconciliationCounts } from "@/lib/api-types";
import { formatTokens, formatUsd, liveStatusText } from "@/lib/ui/tokens";

const STATUS_CHIP: Record<string, string> = { match: "chip-ok", mismatch: "chip-warn", unavailable: "chip-dim" };
const FIELDS: Array<keyof TokenReconciliationCounts> = ["calls", "input", "output", "cacheRead", "cacheWrite"];
const NO_REFERENCE = "No reference configured";

export function ReconciliationPanel({ reconciliation }: { reconciliation: TokenIntelligenceResponse["reconciliation"] }) {
  const { fixture, baseline: live, reference30d } = reconciliation;
  const fixtureExpected = fixture.expected;
  const liveExpected = live.expected;
  return (
    <section className="hud">
      <div className="border-b border-border px-3 py-1.5">
        <h2 className="hud-title">Reconciliation</h2>
      </div>
      <div className="px-3 py-2">
        <p className="label-md">{fixture.label}</p>
        {fixtureExpected ? (
          <table className="mt-1 w-full text-[12px]">
            <tbody>
              {FIELDS.map((k) => (
                <tr key={k}>
                  <td className="pr-3 text-dim">{k}</td>
                  <td className="num">{formatTokens(fixtureExpected[k])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="label text-dim">{NO_REFERENCE}</p>
        )}
      </div>
      <div className="border-t border-border px-3 py-2">
        <p className="label-md">
          <span className={`chip ${STATUS_CHIP[live.status] ?? "chip-dim"}`}>{live.status}</span> <span className="text-dim">live check</span>
        </p>
        {liveExpected ? (
          <>
            <p className="label text-dim">{liveStatusText(live)}</p>
            <table className="mt-2 w-full text-[12px]">
              <thead>
                <tr className="text-left text-dim">
                  <th className="pr-3 font-medium">field</th>
                  <th className="pr-3 font-medium">expected</th>
                  <th className="pr-3 font-medium">actual</th>
                  <th className="font-medium">diff</th>
                </tr>
              </thead>
              <tbody>
                {FIELDS.map((k) => (
                  <tr key={k}>
                    <td className="pr-3">{k}</td>
                    <td className="num pr-3">{formatTokens(liveExpected[k])}</td>
                    <td className="num pr-3">{live.actual ? formatTokens(live.actual[k]) : "—"}</td>
                    <td className="num">{live.diff ? formatTokens(live.diff[k] ?? 0) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <p className="label text-dim">{NO_REFERENCE}</p>
        )}
        <p className="label text-faint">
          scope: {formatTokens(live.coverage.filesInScope)} files (main {live.coverage.mainFound ? "found" : "not found"}, {formatTokens(live.coverage.subagentFilesFound)} subagents) ·{" "}
          {formatTokens(live.coverage.unparseableLines)} unparseable · {formatTokens(live.coverage.oversizeLines)} oversize · {formatTokens(live.coverage.recordsOverflowed)} overflowed
        </p>
      </div>
      <div className="border-t border-border px-3 py-2">
        <p className="label text-dim">
          30-day reference (
          {reference30d.codeburnAttributedUsd !== null && reference30d.codeburnRecomputedUsd !== null
            ? `CodeBurn attributed ${formatUsd(reference30d.codeburnAttributedUsd)} · recomputed ${formatUsd(reference30d.codeburnRecomputedUsd)}`
            : NO_REFERENCE}{" "}
          · this dashboard {formatUsd(reference30d.brainRecomputeUsd)})
        </p>
        <p className="label text-faint">{reference30d.note}</p>
      </div>
    </section>
  );
}
