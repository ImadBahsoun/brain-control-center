"use client";
import type { TokenIntelligenceResponse } from "@/lib/api-types";
import { costBasisBannerText } from "@/lib/ui/tokens";

/** Always visible, regardless of data state (acceptance criterion): the dashboard never shows token cost without this caveat. */
export function CostBanner({ costBasis }: { costBasis: TokenIntelligenceResponse["costBasis"] | null }) {
  return (
    // .hud's `border` shorthand is unlayered CSS and would beat the `border-l-4 border-l-warn` utilities
    // on this same element, so the left border is set with an inline style instead (R9).
    <div className="hud px-3 py-2" style={{ borderLeftWidth: 4, borderLeftColor: "var(--warn)" }}>
      <p className="label-md tone-warn">{costBasisBannerText()}</p>
      {costBasis && (
        <p className="label text-dim">
          Source: {costBasis.pricingSource} · checked {costBasis.pricingCheckedAt} · assumes {costBasis.assumptions.join(", ")}
        </p>
      )}
    </div>
  );
}
